/**
 * LiveKit Egress controller (Twirp JSON) for recording/RTMP/HLS.
 *
 * The egress worker is a separate service. This module only talks to its Twirp
 * API with a short-lived HS256 JWT (`video.roomRecord` plus the room grant).
 * Egress credentials never reach clients; RTMP URLs are redacted to the host in
 * logs/audit/errors (stream keys often live in the path).
 *
 * Upstream text is untrusted: a Twirp `msg` may echo the RTMP URL (stream key
 * included), an S3 error may echo a signed URL. Every such string goes through
 * `sanitizeEgressErrorText()` before it is stored in `lastError`, audited,
 * returned to a client or logged. `lastError` is **tenant-scoped**: the client
 * is a singleton shared by all tenants.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { TenantConfig } from '@agil/protocol';
import type { Env } from './env.js';
import { sanitizeEgressErrorText } from './error-text.js';
import type { Logger } from './logger.js';

// Re-exported here for existing callers/tests; the implementation lives in
// `error-text.ts` so playback/S3 errors share one sanitiser.
export { redactRtmpUrl, sanitizeEgressErrorText } from './error-text.js';

export type EgressKind = 'recording' | 'rtmp' | 'hls';
export type EgressLayout = 'grid' | 'speaker';
export type EgressStartRestriction = { status: 403 | 409; code: 'feature_disabled' | 'e2ee_incompatible'; message: string };

export interface EgressStartInput {
  roomName: string;
  kind: EgressKind;
  layout?: EgressLayout;
  audioOnly?: boolean;
  rtmpUrl?: string;
  /**
   * All RTMP targets of one composite job. Several destinations that share a
   * layout are encoded once and fanned out as multiple `stream_outputs` URLs.
   * `rtmpUrl` stays supported for single-destination callers.
   */
  rtmpUrls?: string[];
  tenantId: string;
  roomId: string;
}

export interface EgressInfo {
  egressId?: string;
  status?: string;
  [key: string]: unknown;
}

export interface EgressStartResult {
  egressId: string;
  kind: EgressKind;
  status: string;
  roomName: string;
}

export interface EgressStatus {
  configured: boolean;
  enabled: boolean;
  urlConfigured: boolean;
  startNodeAvailable: boolean;
  activeCount: number;
  lastError: string | null;
}

export interface EgressStuckJob {
  egressId: string;
  roomName: string;
  status: string;
  startedAt: number | null;
  ageSec: number | null;
}

export interface EgressCleanupResult {
  applied: boolean;
  thresholdSec: number;
  scanned: number;
  stuck: EgressStuckJob[];
  stopped: string[];
  errors: Array<{ egressId: string; message: string }>;
}

function base64url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input)).toString('base64url');
}

/**
 * Key of the per-tenant `lastError` bucket. An empty string is the
 * controller-wide bucket used when the caller has no tenant context.
 */
function tenantKey(tenantId: string | undefined): string {
  return typeof tenantId === 'string' ? tenantId.trim() : '';
}

/** `<tenant>__<roomId>` (SFU room name) -> `<tenant>`; '' when not a room name. */
function tenantFromRoomName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const index = value.indexOf('__');
  return index > 0 ? value.slice(0, index) : '';
}

/** True when an SFU room name belongs to `tenantId` (`<tenant>__<room>`). */
function roomBelongsToTenant(roomName: unknown, tenantId: string): boolean {
  return typeof roomName === 'string' && roomName.startsWith(`${tenantId}__`);
}

export function validateRtmpUrl(raw: string): string | null {
  if (!raw || !raw.trim()) return 'rtmpUrl is required for kind=rtmp';
  if (raw.length > 2000) return 'rtmpUrl is too long';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'rtmpUrl is malformed';
  }
  if (url.protocol !== 'rtmp:' && url.protocol !== 'rtmps:') return 'rtmpUrl must use rtmp:// or rtmps://';
  if (!url.hostname) return 'rtmpUrl must include a host';
  return null;
}

export class EgressError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'EgressError';
    this.status = status;
    this.code = code;
  }
}

export function isEgressUnavailableCode(code: string | undefined): boolean {
  return code === 'egress_disabled' || code === 'egress_not_configured' || code === 'egress_node_unavailable';
}

export class EgressClient {
  /**
   * Last sanitized failure per tenant ('' = controller-wide). Must stay
   * tenant-scoped: a global value would expose one tenant's error text,
   * including an RTMP stream key, to every other tenant. Bounded so a
   * long-lived process cannot grow it without limit.
   */
  private readonly lastErrors = new Map<string, string>();
  private static readonly MAX_TRACKED_TENANTS = 512;

  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
    private readonly canStartOnManagedNode: (tenantId: string) => boolean = () => true,
    private readonly onRecordingStarted?: (input: EgressStartInput, result: EgressStartResult, key: string) => void,
  ) {}

  private get key(): string {
    return this.env.egressApiKey || this.env.sfuApiKey;
  }

  private get secret(): string {
    return this.env.egressApiSecret || this.env.sfuApiSecret;
  }

  get configured(): boolean {
    return Boolean(this.env.egressUrl && this.key && this.secret);
  }

  get enabled(): boolean {
    return this.env.egressEnabled && this.configured;
  }

  /** Last sanitized failure for one tenant (never another tenant's text). */
  lastErrorFor(tenantId?: string): string | null {
    return this.lastErrors.get(tenantKey(tenantId)) ?? null;
  }

  private setLastError(tenantId: string | undefined, message: string | null): void {
    const tenant = tenantKey(tenantId);
    this.lastErrors.delete(tenant);
    if (message === null) return;
    this.lastErrors.set(tenant, message);
    if (this.lastErrors.size > EgressClient.MAX_TRACKED_TENANTS) {
      const oldest = this.lastErrors.keys().next();
      if (!oldest.done) this.lastErrors.delete(oldest.value);
    }
  }

  assertReady(): void {
    if (!this.env.egressEnabled) throw new EgressError(501, 'egress_disabled', 'Egress отключён (AGIL_EGRESS_ENABLED=0)');
    if (!this.configured) {
      throw new EgressError(501, 'egress_not_configured', 'Egress не настроен: задайте AGIL_EGRESS_URL и ключи');
    }
  }

  /** Short-lived JWT for the egress service (roomRecord grant). */
  private token(roomName: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({
        iss: this.key,
        sub: 'agil-egress-controller',
        nbf: now - 5,
        exp: now + 300,
        video: { room: roomName, roomRecord: true },
      }),
    );
    const signature = createHmac('sha256', this.secret).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${signature}`;
  }

  /**
   * Calls one Twirp method.
   *
   * `tenantId` scopes `lastError`. Upstream error text is sanitized before it
   * is stored, logged or thrown: a LiveKit/Twirp `msg` may echo the RTMP URL
   * with its stream key, and the app must never assume it does not.
   */
  private async twirp(
    method: string,
    body: Record<string, unknown>,
    tenantId?: string,
  ): Promise<Record<string, unknown>> {
    this.assertReady();
    const tenant = tenantKey(tenantId ?? tenantFromRoomName(body.room_name));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${this.env.egressUrl}/twirp/livekit.Egress/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token(String(body.room_name ?? ''))}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
      const text = await response.text();
      let parsed: Record<string, unknown> = {};
      try {
        const value: unknown = JSON.parse(text);
        if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
      } catch {
        /* Twirp may return text; handled below */
      }
      if (!response.ok) {
        // Only the sanitized form leaves this method; the raw upstream text is
        // intentionally not kept anywhere (it may contain a stream key).
        const detail = sanitizeEgressErrorText(
          typeof parsed.msg === 'string' ? parsed.msg : `HTTP ${response.status}`,
        );
        const message = `Egress ${method} failed: ${detail}`;
        this.setLastError(tenant, message);
        this.logger.warn('egress Twirp error', { method, status: response.status, detail, tenant: tenant || undefined });
        throw new EgressError(502, 'egress_failed', message);
      }
      return parsed;
    } catch (error) {
      if (error instanceof EgressError) throw error;
      const message =
        (error as Error).name === 'AbortError'
          ? 'Egress request timed out'
          : `Egress request failed: ${sanitizeEgressErrorText((error as Error).message)}`;
      this.setLastError(tenant, message);
      this.logger.warn('egress request failed', { method, detail: message, tenant: tenant || undefined });
      throw new EgressError(502, 'egress_failed', message);
    } finally {
      clearTimeout(timer);
    }
  }

  async start(input: EgressStartInput): Promise<EgressStartResult> {
    this.assertReady();
    const layout = input.layout ?? 'grid';
    const request: Record<string, unknown> = {
      room_name: input.roomName,
      layout,
      audio_only: Boolean(input.audioOnly),
    };
    let recordingKey: string | undefined;
    if (input.kind === 'recording') {
      recordingKey = `${input.tenantId}/${input.roomId}/${Date.now()}-${randomUUID().slice(0, 8)}.mp4`;
      request.file_outputs = [
        {
          file_type: 'MP4',
          filepath: recordingKey,
        },
      ];
    } else if (input.kind === 'rtmp') {
      // LiveKit `StreamProtocol` enum, proto-JSON name form. A lowercase
      // `rtmp` is rejected by the Twirp/protojson decoder (unknown enum).
      const urls = input.rtmpUrls && input.rtmpUrls.length > 0 ? [...input.rtmpUrls] : input.rtmpUrl ? [input.rtmpUrl] : [];
      if (urls.length === 0) throw new EgressError(400, 'validation_failed', 'rtmpUrl is required for kind=rtmp');
      request.stream_outputs = [{ protocol: 'RTMP', urls }];
    } else {
      // LiveKit `SegmentedFileOutput`: `protocol` is the enum
      // `HLS_PROTOCOL` (or DEFAULT_SEGMENTED_FILE_PROTOCOL); there is no
      // `kind` field. `segment_duration` is seconds.
      request.segment_outputs = [
        {
          protocol: 'HLS_PROTOCOL',
          filename_prefix: `${input.tenantId}/${input.roomId}/${Date.now()}`,
          playlist_name: 'index.m3u8',
          live_playlist_name: 'live.m3u8',
          segment_duration: 2,
        },
      ];
    }
    if (!this.canStartOnManagedNode(input.tenantId)) {
      throw new EgressError(503, 'egress_node_unavailable', 'Узел Egress недоступен. Проверьте модуль в разделе «Инфраструктура».');
    }
    try {
      const response = await this.twirp('StartRoomCompositeEgress', request, input.tenantId);
      const egressId = typeof response.egress_id === 'string' ? response.egress_id : '';
      const status = typeof response.status === 'string' ? response.status : 'EGRESS_STARTING';
      if (!egressId) throw new EgressError(502, 'egress_failed', 'Egress response has no egress_id');
      this.setLastError(input.tenantId, null);
      const result = { egressId, kind: input.kind, status, roomName: input.roomName };
      if (recordingKey) {
        try {
          this.onRecordingStarted?.(input, result, recordingKey);
        } catch {
          // The remote job is already accepted. Returning an error here would
          // encourage clients to start a second recording.
          this.logger.error('could not persist egress recording job', { tenantId: input.tenantId, roomId: input.roomId, egressId });
        }
      }
      return result;
    } catch (error) {
      if (error instanceof EgressError) throw error;
      throw new EgressError(502, 'egress_failed', 'Egress start failed');
    }
  }

  async list(roomName: string, tenantId?: string): Promise<EgressInfo[]> {
    this.assertReady();
    try {
      const response = await this.twirp('ListEgress', { room_name: roomName }, tenantId);
      const items = Array.isArray(response.items) ? response.items : [];
      return items.filter((item): item is EgressInfo => Boolean(item) && typeof item === 'object') as EgressInfo[];
    } catch (error) {
      if (error instanceof EgressError) throw error;
      throw new EgressError(502, 'egress_failed', 'Egress list failed');
    }
  }

  /** Finds one egress job by id in a room (LiveKit has no GetEgress JSON route). */
  async info(roomName: string, egressId: string, tenantId?: string): Promise<EgressInfo | null> {
    const items = await this.list(roomName, tenantId);
    return items.find((item) => String(item.egress_id ?? '') === egressId) ?? null;
  }

  /** Active jobs across all rooms. Used by the stuck-session cleanup endpoint. */
  async listActive(tenantId?: string): Promise<EgressInfo[]> {
    this.assertReady();
    try {
      const response = await this.twirp('ListEgress', { active: true }, tenantId);
      const items = Array.isArray(response.items) ? response.items : [];
      return items.filter((item): item is EgressInfo => Boolean(item) && typeof item === 'object') as EgressInfo[];
    } catch (error) {
      if (error instanceof EgressError) throw error;
      throw new EgressError(502, 'egress_failed', 'Egress list failed');
    }
  }

  /**
   * Finds jobs older than `thresholdSec` and optionally stops them.
   *
   * The app is not the only dispatcher: Jobs from other tenants share the SFU,
   * so callers must scope by room-name prefix (`<tenant>__`). `apply=false` is
   * the default in the HTTP handler; only an explicit operator action stops.
   */
  async cleanupStuck(input: {
    roomNamePrefix?: string;
    thresholdSec: number;
    apply: boolean;
    /** Scopes `lastError`; the room-prefix filter is still the authorization. */
    tenantId?: string;
  }): Promise<EgressCleanupResult> {
    this.assertReady();
    const items = await this.listActive(input.tenantId);
    const now = Date.now();
    const stuck: EgressStuckJob[] = [];
    const stopped: string[] = [];
    const errors: Array<{ egressId: string; message: string }> = [];
    for (const item of items) {
      const roomName = String(item.room_name ?? '');
      if (input.roomNamePrefix && !roomName.startsWith(input.roomNamePrefix)) continue;
      const raw = item.started_at;
      const numeric = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
      const startedAt = Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric / 1e6) : null;
      const ageSec = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : null;
      // A job with no start timestamp cannot be proven stale; stopping it could
      // kill a just-started session. Only auto-stop jobs whose age we know.
      if (ageSec === null) continue;
      if (ageSec < input.thresholdSec) continue;
      const egressId = String(item.egress_id ?? '');
      if (!egressId) continue;
      stuck.push({ egressId, roomName, status: String(item.status ?? 'unknown'), startedAt, ageSec });
      if (!input.apply) continue;
      try {
        await this.stop(egressId, input.tenantId);
        stopped.push(egressId);
      } catch (error) {
        errors.push({ egressId, message: sanitizeEgressErrorText((error as Error).message) });
      }
    }
    return { applied: input.apply, thresholdSec: input.thresholdSec, scanned: items.length, stuck, stopped, errors };
  }

  async stop(egressId: string, tenantId?: string): Promise<EgressInfo> {
    this.assertReady();
    try {
      const response = await this.twirp('StopEgress', { egress_id: egressId }, tenantId);
      return response;
    } catch (error) {
      if (error instanceof EgressError) throw error;
      throw new EgressError(502, 'egress_failed', 'Egress stop failed');
    }
  }

  /**
   * Controller status. `lastError` and `activeCount` are tenant-scoped: the
   * client is shared by every tenant, so a tenant admin must never see another
   * tenant's failure text or job count.
   */
  async status(tenantId?: string): Promise<EgressStatus> {
    const tenant = tenantKey(tenantId);
    let activeCount = 0;
    let lastError = this.lastErrorFor(tenant);
    if (this.enabled) {
      try {
        const response = await this.twirp('ListEgress', { active: true }, tenant);
        const items = Array.isArray(response.items) ? response.items : [];
        activeCount = tenant
          ? items.filter((item) => roomBelongsToTenant((item as EgressInfo | null)?.room_name, tenant)).length
          : items.length;
      } catch (error) {
        lastError = (error as Error).message;
      }
    }
    return {
      configured: this.configured,
      enabled: this.enabled,
      urlConfigured: Boolean(this.env.egressUrl),
      startNodeAvailable: !tenant || this.canStartOnManagedNode(tenant),
      activeCount,
      lastError,
    };
  }
}

export function egressFeatureGate(config: TenantConfig, kind: EgressKind): string | null {
  if (kind === 'recording') {
    if (!config.features.recording) return 'features.recording is disabled';
    if (!(config.mediaProcessing.egress || config.scale.streaming.enabled)) {
      return 'recording requires mediaProcessing.egress or scale.streaming';
    }
    return null;
  }
  if (!config.features.liveStreaming) return 'features.liveStreaming is disabled';
  if (!config.scale.streaming.enabled) return 'scale.streaming is disabled';
  return null;
}

export function egressStartRestriction(config: TenantConfig, kind: EgressKind): EgressStartRestriction | null {
  if (config.security.e2ee && (config.scale.mediaMode === 'sfu' || config.scale.mediaMode === 'broadcast')) {
    return { status: 409, code: 'e2ee_incompatible', message: 'Egress недоступен при включённом E2EE: SFU не расшифрует медиа' };
  }
  const gate = egressFeatureGate(config, kind);
  return gate ? { status: 403, code: 'feature_disabled', message: `Egress недоступен: ${gate}` } : null;
}
