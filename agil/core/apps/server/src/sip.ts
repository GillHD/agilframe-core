/**
 * Optional SIP/PSTN gateway (LiveKit SIP) — control plane only.
 *
 * Media never flows through this server: the LiveKit SIP service bridges PSTN
 * audio into the SFU room. This module talks to the LiveKit Twirp API with a
 * short-lived HS256 JWT (`CreateSIPParticipant`, `ListParticipants`,
 * `RemoveParticipant`, `ListRooms`).
 *
 * Security baseline:
 * - gateway credentials live only in `AGIL_SIP_*` env, never in tenant config,
 *   responses or logs; JWT grants are least-privilege per operation;
 * - phone numbers are never stored in the room registry. Audit/error text only
 *   carries a masked number, and `hide_phone_number` keeps the number out of
 *   participant identity/attributes;
 * - SIP participants are guests (role guest, same tenant/room permissions);
 * - E2EE is incompatible (the SIP gateway cannot decrypt room media) → 409;
 * - the feature is off by default (`AGIL_SIP_ENABLED=0`, `scale.sip.enabled=false`).
 */
import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { E164_RE, isE164, type TenantConfig } from '@agil/protocol';
import type { Env } from './env.js';
import {
  HttpError,
  safeAudit,
  type RequestContext,
  type Router,
} from './http.js';
import type { Logger } from './logger.js';
import { roomConfig, type Room } from './rooms.js';
import { sfuRoomName } from './sfu.js';
import {
  assertRateLimit,
  bearerToken,
  requireApiKeyTenant,
  requireTenantMatch,
  verifyAuthToken,
} from './auth.js';

export const SIP_SERVICE = 'livekit.SIP';
export const SIP_ROOM_SERVICE = 'livekit.RoomService';

export type SipParticipantStatus = 'dialing' | 'joined' | 'active' | 'disconnected' | 'unknown';

/** Safe representation of a SIP participant (never contains a phone number). */
export interface SipParticipant {
  id: string;
  identity: string;
  name: string;
  role: 'guest';
  roomId: string;
  source: 'sip';
  status: SipParticipantStatus;
  joinedAt?: number;
  /**
   * `true` when the LiveKit identity was a phone number (an inbound call
   * created outside the app), so `identity` is a mask and `id` is the opaque
   * LiveKit participant id used for stop.
   */
  masked?: boolean;
}

export interface SipStatusResponse {
  configured: boolean;
  enabled: boolean;
  trunkConfigured: boolean;
  nodeAvailable?: boolean;
  numbers: string[];
  active: number;
}

export interface SipTestResult {
  ok: boolean;
  mode: 'mock' | 'live';
  configured: boolean;
  trunkConfigured: boolean;
  detail: string;
  latencyMs: number;
}

export interface SipDialInInput {
  roomName: string;
  tenantId: string;
  roomId: string;
  number: string;
  name?: string;
  identity?: string;
  /**
   * DTMF digits sent once the call is answered (`CreateSIPParticipant.dtmf`).
   * Digits may encode a PIN/extension, so they are never logged, audited or
   * returned.
   */
  dtmf?: string;
}

export class SipError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SipError';
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Phone-number privacy helpers                                        */
/* ------------------------------------------------------------------ */

/** `+79991234567` → `+7••••••••67`: keeps only the country code + last 2. */
export function maskPhoneNumber(raw: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return '…';
  const countryCode = digits.slice(0, 1);
  const last = digits.slice(-2);
  return `+${countryCode}${'•'.repeat(Math.max(3, digits.length - 3))}${last}`;
}

/** Removes anything that looks like a phone number from free-form text. */
export function scrubPhoneNumbers(raw: string): string {
  return String(raw)
    .replace(/\+?\d[\d\s().-]{5,}\d/g, '[number]')
    .slice(0, 300);
}

/**
 * Masks phone numbers embedded in a display name. LiveKit synthesizes names
 * such as `Phone +15559998888` for inbound callers, so a whole-string match
 * (as {@link looksLikePhone} does) is not enough.
 */
export function maskPhoneNumbersInText(raw: string): string {
  return String(raw).replace(/\+?\d[\d\s().-]{5,}\d/g, (match) =>
    isPhoneLikeIdentity(match) ? maskPhoneNumber(match) : match,
  );
}

/**
 * Redacts sensitive fragments from an upstream gateway message before it is
 * returned to a client or written to audit/logs: URLs, bearer/opaque tokens,
 * email addresses and phone numbers. Twirp `msg` is attacker/gateway-controlled
 * text, so it must never be forwarded verbatim.
 */
export function scrubSensitiveText(raw: string): string {
  let text = String(raw ?? '');
  text = text.replace(/\b(?:https?|wss?|ftp):\/\/[^\s"'<>]+/gi, '[url]');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [token]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]');
  text = text.replace(/\b(api[_-]?key|secret|token|password|authorization)\b\s*[:=]\s*[^\s,;)"']+/gi, '$1=[redacted]');
  text = text.replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[email]');
  text = text.replace(/\b[A-Fa-f0-9]{32,}\b/g, '[token]');
  return scrubPhoneNumbers(text);
}

/**
 * True when an opaque identity is really a phone number (digits-only, E.164 or
 * prefixed like `sip_79991234567`). Such values must never be accepted as a
 * stop id or written to audit/logs in raw form.
 */
export function isPhoneLikeIdentity(raw: string): boolean {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return false;
  if (E164_RE.test(value)) return true;
  if (/^\+?[\d\s().-]+$/.test(value)) return value.replace(/\D/g, '').length >= 7;
  // A gateway may prefix an inbound phone identity (`sip_7999...`): inspect the
  // final delimiter-separated segment as well.
  const suffix = /(?:^|[_-])(\+?\d[\d\s().-]{5,}\d)$/.exec(value)?.[1] ?? '';
  return suffix.replace(/\D/g, '').length >= 7;
}

function looksLikePhone(value: string): boolean {
  return isPhoneLikeIdentity(value);
}

function safeIdentity(raw: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  return looksLikePhone(value) ? maskPhoneNumber(value) : value;
}

/* ------------------------------------------------------------------ */
/* Gateway settings                                                    */
/* ------------------------------------------------------------------ */

export interface SipSettings {
  /** Effective Twirp base URL (env wins over tenant config). */
  url: string;
  apiKey: string;
  apiSecret: string;
  trunkId: string;
  configured: boolean;
  /** `AGIL_SIP_ENABLED=1` and credentials/URL present. */
  enabled: boolean;
}

/** Resolves gateway settings without ever returning them to a client. */
export function resolveSipSettings(env: Env, config: TenantConfig): SipSettings {
  const url = (env.sipUrl || config.scale.sip.httpUrl || '').trim().replace(/\/+$/, '');
  const apiKey = env.sipApiKey.trim();
  const apiSecret = env.sipApiSecret;
  const trunkId = config.scale.sip.trunkId.trim();
  const configured = Boolean(url && apiKey && apiSecret);
  return { url, apiKey, apiSecret, trunkId, configured, enabled: env.sipEnabled && configured };
}

/** Feature/tenant gate for starting a call (not for stopping an existing one). */
export function sipFeatureGate(config: TenantConfig): string | null {
  if (!config.features.sipDialIn) return 'features.sipDialIn is disabled';
  if (!config.scale.sip.enabled) return 'scale.sip.enabled is disabled';
  return null;
}

/** True when E2EE is on and the gateway therefore cannot bridge the room. */
export function sipE2eeConflict(config: TenantConfig): boolean {
  return config.security.e2ee === true;
}

/* ------------------------------------------------------------------ */
/* Twirp client                                                        */
/* ------------------------------------------------------------------ */

const TWIRP_TIMEOUT_MS = 10_000;
const TOKEN_TTL_SEC = 120;
const MAX_STATUS_ROOMS = 50;

type SipGrantKind = 'create' | 'room' | 'list-rooms';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function stateName(value: unknown): SipParticipantStatus {
  if (value === 0 || value === 'JOINING') return 'dialing';
  if (value === 1 || value === 'JOINED') return 'joined';
  if (value === 2 || value === 'ACTIVE') return 'active';
  if (value === 3 || value === 'DISCONNECTED') return 'disconnected';
  return 'unknown';
}

function isSipParticipant(raw: Record<string, unknown>): boolean {
  const kind = raw.kind;
  if (kind === 3 || kind === 'SIP' || kind === 'sip') return true;
  const attributes = raw.attributes;
  if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
    // LiveKit adds `sip.callID` / `sip.callStatus` attributes to SIP participants.
    return Object.keys(attributes as Record<string, unknown>).some((key) => key.toLowerCase().startsWith('sip.'));
  }
  return false;
}

function joinedAtMs(value: unknown): number | undefined {
  // LiveKit/Twirp JSON may encode int64 as a number or as a decimal string
  // (protojson); accept both. Some gateways also send `joined_at_ms`.
  const numeric =
    typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric <= 0) return undefined;
  if (numeric > 1e15) return Math.round(numeric / 1e6); // nanoseconds
  if (numeric > 1e12) return Math.round(numeric); // milliseconds
  return Math.round(numeric * 1000); // seconds
}

export class SipClient {
  private lastErrorValue: string | null = null;
  /**
   * Opaque identities this process created, per LiveKit room. Used only as a
   * fallback for `active`/concurrency when a ListParticipants call fails; phone
   * numbers are never kept here (identities are `sip_<hex>`).
   */
  private readonly localActive = new Map<string, Set<string>>();
  /**
   * Per-room serialization for the maxConcurrent check + create call. This
   * removes the in-process TOCTOU window; it is not a distributed lock, so a
   * multi-node deployment still needs LiveKit-side limits (documented).
   */
  private readonly roomLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
    private readonly managedNodeAvailable: (tenantId: string) => boolean | undefined = () => undefined,
  ) {}

  private withRoomLock<T>(roomName: string, task: () => Promise<T>): Promise<T> {
    const previous = this.roomLocks.get(roomName) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    this.roomLocks.set(roomName, run);
    void run
      .finally(() => {
        if (this.roomLocks.get(roomName) === run) this.roomLocks.delete(roomName);
      })
      .catch(() => {
        /* the caller observes the actual failure */
      });
    return run;
  }

  private track(roomName: string, identity: string): void {
    const current = this.localActive.get(roomName) ?? new Set<string>();
    current.add(identity);
    this.localActive.set(roomName, current);
  }

  private forget(roomName: string, identity: string): void {
    const current = this.localActive.get(roomName);
    if (!current) return;
    current.delete(identity);
    if (current.size === 0) this.localActive.delete(roomName);
  }

  private localCount(roomName: string): number {
    return this.localActive.get(roomName)?.size ?? 0;
  }

  get lastError(): string | null {
    return this.lastErrorValue;
  }

  settings(config: TenantConfig): SipSettings {
    return resolveSipSettings(this.env, config);
  }

  configured(config: TenantConfig): boolean {
    return this.settings(config).configured;
  }

  enabled(config: TenantConfig): boolean {
    return this.settings(config).enabled;
  }

  trunkId(config: TenantConfig): string {
    return this.settings(config).trunkId;
  }

  private assertManagedNodeAvailable(tenantId: string): void {
    if (this.managedNodeAvailable(tenantId) === false) {
      throw new SipError(503, 'sip_node_unavailable', 'Узел SIP недоступен. Проверьте модуль в разделе «Инфраструктура».');
    }
  }

  /**
   * Readiness for gateway calls. The tenant feature/scale gate is separate
   * (403): a disabled gateway answers 501 even if the tenant enabled the UI.
   */
  assertReady(config: TenantConfig): SipSettings {
    const settings = this.settings(config);
    if (!this.env.sipEnabled) {
      throw new SipError(501, 'sip_disabled', 'SIP/PSTN отключён (AGIL_SIP_ENABLED=0)');
    }
    if (!settings.configured) {
      throw new SipError(
        501,
        'sip_not_configured',
        'SIP не настроен: задайте AGIL_SIP_URL и AGIL_SIP_API_KEY/AGIL_SIP_API_SECRET (или SFU-ключи)',
      );
    }
    if (!settings.trunkId) {
      throw new SipError(501, 'sip_trunk_not_configured', 'SIP-транк не задан: scale.sip.trunkId');
    }
    return settings;
  }

  /**
   * Readiness for cleanup (list/stop). Unlike {@link assertReady} this does not
   * require `AGIL_SIP_ENABLED=1` or a trunk: an operator can still hang up
   * active SIP participants with only the gateway URL/keys.
   */
  assertCleanupReady(config: TenantConfig): SipSettings {
    const settings = this.settings(config);
    if (!settings.configured) {
      throw new SipError(
        501,
        'sip_not_configured',
        'SIP не настроен: задайте AGIL_SIP_URL и AGIL_SIP_API_KEY/AGIL_SIP_API_SECRET (или SFU-ключи)',
      );
    }
    return settings;
  }

  /** HS256 JWT with least-privilege LiveKit grants for one operation. */
  token(settings: SipSettings, kind: SipGrantKind, roomName?: string): string {
    const now = Math.floor(Date.now() / 1000);
    const video: Record<string, unknown> =
      kind === 'list-rooms'
        ? { roomList: true }
        : kind === 'create'
          ? { room: roomName ?? '', roomJoin: true }
          : { room: roomName ?? '', roomAdmin: true };
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({
        iss: settings.apiKey,
        sub: 'agil-sip-controller',
        nbf: now - 5,
        exp: now + TOKEN_TTL_SEC,
        video,
        ...(kind === 'create' ? { sip: { call: true } } : {}),
      }),
    );
    const signature = createHmac('sha256', settings.apiSecret).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${signature}`;
  }

  private async twirp(
    settings: SipSettings,
    service: string,
    method: string,
    body: Record<string, unknown>,
    grant: SipGrantKind,
    roomName?: string,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TWIRP_TIMEOUT_MS);
    try {
      const response = await fetch(`${settings.url}/twirp/${service}/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token(settings, grant, roomName)}`,
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
        /* Twirp may answer text; handled below */
      }
      if (!response.ok) {
        const detail = typeof parsed.msg === 'string' ? scrubSensitiveText(parsed.msg) : `HTTP ${response.status}`;
        const message = `SIP ${method} failed: ${detail}`;
        this.lastErrorValue = message;
        // Never log the URL, JWT or request body: the body carries the phone number.
        this.logger.warn('SIP gateway request failed', { service, method, status: response.status });
        throw new SipError(502, 'sip_failed', message);
      }
      this.lastErrorValue = null;
      return parsed;
    } catch (error) {
      if (error instanceof SipError) throw error;
      const message =
        (error as Error).name === 'AbortError' ? 'SIP gateway request timed out' : 'SIP gateway request failed';
      this.lastErrorValue = message;
      this.logger.warn('SIP gateway request failed', {
        service,
        method,
        error: (error as Error).name,
      });
      throw new SipError(502, 'sip_failed', message);
    } finally {
      clearTimeout(timer);
    }
  }

  private rawParticipant(entry: unknown): Record<string, unknown> | null {
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
  }

  private sanitizeParticipant(raw: Record<string, unknown>, roomId: string, fallbackIdentity: string): SipParticipant {
    const identityRaw = typeof raw.identity === 'string' && raw.identity.trim() ? raw.identity.trim() : fallbackIdentity;
    const phoneLike = looksLikePhone(identityRaw);
    const identity = (phoneLike ? maskPhoneNumber(identityRaw) : identityRaw) || fallbackIdentity;
    // Opaque handle for stop/list: the LiveKit identity for normal
    // participants, but the LiveKit participant id (`PA_...`) when the identity
    // itself is a phone number, so a client never has to send the number back.
    const sid = typeof raw.sid === 'string' ? raw.sid.trim() : '';
    const id = phoneLike ? sid || identity : identity;
    const rawName = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'SIP guest';
    // A name may embed the caller number ("Phone +1555…") — mask it, do not
    // only test the whole string.
    const name = maskPhoneNumbersInText(rawName).slice(0, 120);
    const joinedAt = joinedAtMs(raw.joined_at_ms ?? raw.joined_at);
    return {
      id,
      identity,
      name,
      role: 'guest',
      roomId,
      source: 'sip',
      status: stateName(raw.state),
      ...(joinedAt !== undefined ? { joinedAt } : {}),
      ...(phoneLike ? { masked: true } : {}),
    };
  }

  /**
   * Drops locally tracked identities that LiveKit no longer reports, so a callee
   * that hung up on its own stops counting towards `maxConcurrent` on the
   * fallback path. Only opaque identities are ever considered, so a phone-like
   * inbound identity is never stored in this process.
   */
  private reconcileLocalActive(roomName: string, live: Array<Record<string, unknown>>): void {
    const current = this.localActive.get(roomName);
    if (!current || current.size === 0) return;
    const liveIdentities = new Set<string>();
    for (const entry of live) {
      const identity = typeof entry.identity === 'string' ? entry.identity.trim() : '';
      if (identity && !looksLikePhone(identity)) liveIdentities.add(identity);
    }
    for (const identity of [...current]) {
      if (!liveIdentities.has(identity)) current.delete(identity);
    }
    if (current.size === 0) this.localActive.delete(roomName);
  }

  private async fetchParticipants(settings: SipSettings, roomName: string): Promise<Array<Record<string, unknown>>> {
    const response = await this.twirp(
      settings,
      SIP_ROOM_SERVICE,
      'ListParticipants',
      { room: roomName },
      'room',
      roomName,
    );
    const items = Array.isArray(response.participants) ? response.participants : [];
    const sipParticipants = items
      .map((entry) => this.rawParticipant(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null && isSipParticipant(entry));
    this.reconcileLocalActive(roomName, sipParticipants);
    return sipParticipants;
  }

  /**
   * Identity of the participant as LiveKit sees it. Real `SIPParticipantInfo`
   * has a separate `participant_identity` (the LiveKit identity) and
   * `participant_id` (e.g. `PA_...`); list/stop work on the identity, so it must
   * win over the participant id. The generated request identity is the final
   * fallback because LiveKit may omit both fields on an older/fake gateway.
   */
  private identityFromCreateResponse(response: Record<string, unknown>, fallback: string): string {
    const direct = typeof response.participant_identity === 'string' ? response.participant_identity.trim() : '';
    if (direct) return safeIdentity(direct) || fallback;
    const nested = this.rawParticipant(response.participant);
    const nestedIdentity = nested && typeof nested.identity === 'string' ? nested.identity.trim() : '';
    if (nestedIdentity) return safeIdentity(nestedIdentity) || fallback;
    const participantId = typeof response.participant_id === 'string' ? response.participant_id.trim() : '';
    if (participantId) return safeIdentity(participantId) || fallback;
    return fallback;
  }

  /** Creates an outbound SIP call into the LiveKit room (`CreateSIPParticipant`). */
  async createParticipant(
    config: TenantConfig,
    input: SipDialInInput,
    options: { maxConcurrent?: number } = {},
  ): Promise<SipParticipant> {
    const settings = this.assertReady(config);
    const identity = input.identity?.trim() || `sip_${randomUUID().replace(/-/g, '')}`;
    const displayName = (input.name?.trim() || 'SIP guest').slice(0, 120);
    const maxDurationSec = Math.max(60, Math.min(86400, config.scale.sip.maxCallDurationSec || 3600));
    const body: Record<string, unknown> = {
      sip_trunk_id: settings.trunkId,
      sip_call_to: input.number,
      room_name: input.roomName,
      participant_identity: identity,
      participant_name: displayName,
      participant_metadata: JSON.stringify({
        source: 'sip',
        role: 'guest',
        tenantId: input.tenantId,
        roomId: input.roomId,
      }),
      // Ask LiveKit to omit the From number from identity/attributes.
      hide_phone_number: true,
      // Bound PSTN cost: LiveKit answers/hangs up on its own after these limits.
      ringing_timeout: '60s',
      max_call_duration: `${maxDurationSec}s`,
    };
    const callerId = config.scale.sip.callerId.trim();
    if (callerId) body.sip_number = callerId;
    // Post-answer DTMF digits (IVR extension / lab DTMF check). Never logged.
    if (input.dtmf) body.dtmf = input.dtmf;
    const maxConcurrent = Math.max(0, options.maxConcurrent ?? config.scale.sip.maxConcurrent);
    return this.withRoomLock(input.roomName, async () => {
      this.assertManagedNodeAvailable(input.tenantId);
      if (maxConcurrent > 0) {
        // Serialized per room in this process: the create + track below closes the
        // local TOCTOU window. Distributed/multi-node limits belong to LiveKit.
        let active: number | null = null;
        try {
          active = (await this.fetchParticipants(settings, input.roomName)).length;
        } catch {
          active = null; // gateway listing failed: use the local fallback
        }
        const count = active ?? this.localCount(input.roomName);
        if (count >= maxConcurrent) {
          throw new HttpError(409, 'sip_limit_reached', `SIP concurrency limit reached (${maxConcurrent})`);
        }
      }
      this.assertManagedNodeAvailable(input.tenantId);
      const response = await this.twirp(settings, SIP_SERVICE, 'CreateSIPParticipant', body, 'create', input.roomName);
      const returnedIdentity = this.identityFromCreateResponse(response, identity);
      this.track(input.roomName, returnedIdentity);
      const participant = this.rawParticipant(response.participant);
      if (participant) {
        // Keep LiveKit's state/name/joined_at but always the resolved identity.
        return this.sanitizeParticipant({ ...participant, identity: returnedIdentity }, input.roomId, returnedIdentity);
      }
      return {
        id: returnedIdentity,
        identity: returnedIdentity,
        name: maskPhoneNumbersInText(displayName),
        role: 'guest' as const,
        roomId: input.roomId,
        source: 'sip' as const,
        status: 'dialing' as const,
      };
    });
  }

  /** Lists active SIP participants of a room; phone-like identities are masked. */
  async listParticipants(config: TenantConfig, room: Room): Promise<SipParticipant[]> {
    const settings = this.assertCleanupReady(config);
    const raw = await this.fetchParticipants(settings, sfuRoomName(room.tenantId, room.id));
    return raw.map((entry) => this.sanitizeParticipant(entry, room.id, 'sip_participant'));
  }

  /**
   * Hang-up via RoomService.RemoveParticipant (no phone number needed).
   *
   * `participantId` is the opaque `id` returned by list: the LiveKit identity
   * for a normal SIP participant, or the LiveKit participant id (`PA_...`) when
   * the identity is a phone number. Both are resolved here so a phone number
   * never has to travel in a URL, audit entry or log.
   */
  async removeParticipant(config: TenantConfig, room: Room, participantId: string): Promise<void> {
    const settings = this.assertCleanupReady(config);
    const roomName = sfuRoomName(room.tenantId, room.id);
    const raw = await this.fetchParticipants(settings, roomName);
    const target = raw.find((entry) => {
      const identity = typeof entry.identity === 'string' ? entry.identity.trim() : '';
      const sid = typeof entry.sid === 'string' ? entry.sid.trim() : '';
      return sid === participantId || identity === participantId;
    });
    const resolvedIdentity = target && typeof target.identity === 'string' ? target.identity.trim() : '';
    if (!resolvedIdentity) throw new HttpError(404, 'not_found', 'SIP participant not found');
    await this.twirp(
      settings,
      SIP_ROOM_SERVICE,
      'RemoveParticipant',
      { room: roomName, identity: resolvedIdentity },
      'room',
      roomName,
    );
    this.forget(roomName, resolvedIdentity);
  }

  /** Live gateway probe: a harmless RoomService.ListRooms Twirp call. */
  async probe(config: TenantConfig): Promise<number> {
    const settings = this.assertReady(config);
    const started = Date.now();
    await this.twirp(settings, SIP_ROOM_SERVICE, 'ListRooms', {}, 'list-rooms');
    return Date.now() - started;
  }

  /** Admin status; `active` is best-effort across the tenant's live rooms. */
  async status(config: TenantConfig, rooms: Room[]): Promise<SipStatusResponse> {
    const settings = this.settings(config);
    let active = 0;
    // Count even when the integration/trunk is disabled: during an incident the
    // operator still needs to see and stop existing SIP participants.
    if (settings.configured) {
      const candidates = rooms.slice(0, MAX_STATUS_ROOMS);
      const counts = await Promise.all(
        candidates.map(async (room) => {
          const roomName = sfuRoomName(room.tenantId, room.id);
          try {
            return (await this.listParticipants(config, room)).length;
          } catch {
            // Gateway listing failed: fall back to identities created by this process.
            return this.localCount(roomName);
          }
        }),
      );
      active = counts.reduce((sum, count) => sum + count, 0);
    }
    const nodeAvailable = this.managedNodeAvailable(config.tenantId);
    return {
      configured: settings.configured,
      enabled: settings.enabled,
      trunkConfigured: Boolean(settings.trunkId),
      ...(nodeAvailable !== undefined ? { nodeAvailable } : {}),
      numbers: [...config.scale.sip.dialInNumbers],
      active,
    };
  }

  /**
   * Admin gateway test. `mock` validates the configuration without any network
   * call; `live` performs a real Twirp request (ListRooms) and reports latency.
   */
  async test(config: TenantConfig, input: { mode?: 'mock' | 'live'; number?: string }): Promise<SipTestResult> {
    const settings = this.settings(config);
    // Default to the side-effect-free check; `live` must be explicit.
    const mode = input.mode ?? 'mock';
    const started = Date.now();
    const issues: string[] = [];
    if (!this.env.sipEnabled) issues.push('AGIL_SIP_ENABLED is off');
    if (!settings.configured) issues.push('gateway URL/credentials are not configured');
    if (!settings.trunkId) issues.push('scale.sip.trunkId is empty');
    if (this.managedNodeAvailable(config.tenantId) === false) issues.push('bound SIP node is unavailable');
    const numbers = input.number ? [input.number] : config.scale.sip.dialInNumbers;
    for (const number of numbers) {
      if (!isE164(number)) issues.push(`invalid E.164 number ${maskPhoneNumber(number)}`);
    }
    if (mode === 'mock') {
      return {
        ok: issues.length === 0 && settings.enabled && Boolean(settings.trunkId),
        mode,
        configured: settings.configured,
        trunkConfigured: Boolean(settings.trunkId),
        detail: issues.length > 0 ? issues.join('; ') : 'configuration looks valid (no network call)',
        latencyMs: Date.now() - started,
      };
    }
    const latencyMs = await this.probe(config);
    return {
      ok: true,
      mode,
      configured: true,
      trunkConfigured: Boolean(settings.trunkId),
      detail: 'LiveKit Twirp reachable (RoomService.ListRooms)',
      latencyMs: Math.max(latencyMs, Date.now() - started),
    };
  }
}

/* ------------------------------------------------------------------ */
/* HTTP routes                                                         */
/* ------------------------------------------------------------------ */

/** Digits, `*`, `#` and `w` (0.5 s pause) — the subset LiveKit's `dtmf` accepts. */
const SIP_DTMF_RE = /^(?:\d|\*|#|[wW]){1,32}$/;

const sipDialInSchema = z.object({
  number: z.string().min(1).max(32),
  name: z.string().min(1).max(120).optional(),
  // Bounded post-answer DTMF: enough for an IVR extension, not a tone generator.
  dtmf: z
    .string()
    .regex(SIP_DTMF_RE, 'dtmf may contain digits, *, # and w only (max 32 characters)')
    .optional(),
});

const sipTestSchema = z.object({
  mode: z.enum(['mock', 'live']).optional(),
  number: z.string().min(1).max(32).optional(),
});

const PARTICIPANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function audit(ctx: RequestContext, entry: Parameters<typeof safeAudit>[2]): void {
  safeAudit(ctx.logger, ctx.services.audit, entry);
}

function sipHttpError(error: unknown): never {
  if (error instanceof SipError) throw new HttpError(error.status, error.code, error.message);
  throw error;
}

function requireRoom(ctx: RequestContext): Room {
  const roomId = ctx.params.roomId as string;
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  return room;
}

/** Host/moderator join token or tenant admin key (same model as lobby/egress). */
function requireRoomModerator(ctx: RequestContext, room: Room): void {
  const raw = bearerToken(ctx.headers);
  if (raw) {
    const claims = verifyAuthToken(ctx.env, raw);
    if (!claims) throw new HttpError(401, 'unauthorized', 'Invalid access token');
    if (claims.tenantId !== room.tenantId || claims.roomId !== room.id) {
      throw new HttpError(403, 'forbidden', 'Token does not belong to this room');
    }
    if (claims.role !== 'host' && claims.role !== 'moderator') {
      throw new HttpError(403, 'forbidden', 'Only the host or a moderator can manage SIP dial-in');
    }
    return;
  }
  const keyTenant = requireApiKeyTenant(ctx);
  requireTenantMatch(keyTenant, room.tenantId);
}

function roomSipConfig(ctx: RequestContext, room: Room): TenantConfig {
  return roomConfig(room, ctx.tenants.getConfig(room.tenantId));
}

function assertDialInGates(ctx: RequestContext, room: Room, config: TenantConfig): void {
  ctx.services.sip.assertReady(config);
  if (sipE2eeConflict(config)) {
    throw new HttpError(409, 'e2ee_incompatible', 'SIP недоступен при включённом E2EE: шлюз не расшифрует медиа');
  }
  const gate = sipFeatureGate(config);
  if (gate) throw new HttpError(403, 'feature_disabled', `SIP dial-in недоступен: ${gate}`);
}

async function sipDialInHandler(ctx: RequestContext): Promise<void> {
  const room = requireRoom(ctx);
  requireRoomModerator(ctx, room);
  const config = roomSipConfig(ctx, room);
  try {
    assertDialInGates(ctx, room, config);
  } catch (error) {
    sipHttpError(error);
  }
  const body = await ctx.jsonSchema(sipDialInSchema);
  const number = body.number.trim();
  if (!isE164(number)) {
    throw new HttpError(400, 'validation_failed', 'number must be an E.164 phone number (+<country><number>)');
  }
  assertRateLimit(
    ctx.services.limiters.sip.check(`sip:${room.tenantId}:${room.id}:${ctx.ipHash}`),
    ctx,
    'Too many SIP dial-in attempts',
  );

  const roomName = sfuRoomName(room.tenantId, room.id);
  try {
    const participant = await ctx.services.sip.createParticipant(
      config,
      {
        roomName,
        tenantId: room.tenantId,
        roomId: room.id,
        number,
        ...(body.name ? { name: body.name } : {}),
        // Not audited/logged: digits can be an IVR PIN or extension.
        ...(body.dtmf ? { dtmf: body.dtmf } : {}),
      },
      { maxConcurrent: config.scale.sip.maxConcurrent },
    );
    audit(ctx, {
      type: 'sip.dialin.started',
      severity: 'info',
      tenantId: room.tenantId,
      roomId: room.id,
      participantId: participant.identity,
      ip: ctx.ip,
      message: 'SIP dial-in started',
      details: {
        kind: 'sip.dialin.started',
        identity: participant.identity,
        role: 'guest',
        numberMasked: maskPhoneNumber(number),
      },
    });
    ctx.send(200, participant);
  } catch (error) {
    audit(ctx, {
      type: 'sip.dialin.failed',
      severity: 'warn',
      tenantId: room.tenantId,
      roomId: room.id,
      ip: ctx.ip,
      message: 'SIP dial-in failed',
      details: {
        kind: 'sip.dialin.failed',
        action: 'start',
        numberMasked: maskPhoneNumber(number),
        error: scrubSensitiveText((error as Error).message),
      },
    });
    sipHttpError(error);
  }
}

async function sipStopHandler(ctx: RequestContext): Promise<void> {
  const room = requireRoom(ctx);
  requireRoomModerator(ctx, room);
  const config = roomSipConfig(ctx, room);
  const participantId = String(ctx.params.participantId ?? '').trim();
  if (!PARTICIPANT_ID_RE.test(participantId)) {
    throw new HttpError(400, 'validation_failed', 'Invalid SIP participant id');
  }
  // Consume the stop limiter before auditing a rejection, otherwise every
  // phone-like attempt writes an audit entry and an authenticated host can grow
  // the audit/SIEM stream without bound. The 11th+ request is a 429 before audit.
  assertRateLimit(
    ctx.services.limiters.sipStop.check(`sip-stop:${room.tenantId}:${room.id}:${ctx.ipHash}`),
    ctx,
    'Too many SIP stop attempts',
  );
  // Phone-like ids are never accepted into the audit/log path. Auditing even a
  // rejected attempt keeps the trail complete, but only the masked value is
  // written (the HTTP error path logs no 400 URLs).
  if (isPhoneLikeIdentity(participantId)) {
    const masked = maskPhoneNumber(participantId);
    audit(ctx, {
      type: 'sip.dialin.failed',
      severity: 'warn',
      tenantId: room.tenantId,
      roomId: room.id,
      participantId: masked,
      ip: ctx.ip,
      message: 'SIP participant stop rejected: phone-like identity',
      details: {
        kind: 'sip.dialin.failed',
        action: 'stop',
        identity: masked,
        error: 'Invalid SIP participant id: phone-like identities are not accepted',
      },
    });
    throw new HttpError(400, 'validation_failed', 'Invalid SIP participant id: phone-like identities are not accepted');
  }
  const safeId = safeIdentity(participantId);
  try {
    // `removeParticipant` uses cleanup readiness (URL/keys only): an operator can
    // still hang up while the integration or trunk is disabled.
    await ctx.services.sip.removeParticipant(config, room, participantId);
    audit(ctx, {
      type: 'sip.dialin.stopped',
      severity: 'info',
      tenantId: room.tenantId,
      roomId: room.id,
      participantId: safeId,
      ip: ctx.ip,
      message: 'SIP participant stopped',
      details: { kind: 'sip.dialin.stopped', action: 'stop', identity: safeId },
    });
    ctx.send(200, { stopped: true, participantId: safeId });
  } catch (error) {
    audit(ctx, {
      type: 'sip.dialin.failed',
      severity: 'warn',
      tenantId: room.tenantId,
      roomId: room.id,
      ip: ctx.ip,
      message: 'SIP participant stop failed',
      details: {
        kind: 'sip.dialin.failed',
        action: 'stop',
        identity: safeId,
        error: scrubSensitiveText((error as Error).message),
      },
    });
    sipHttpError(error);
  }
}

async function sipListHandler(ctx: RequestContext): Promise<void> {
  const room = requireRoom(ctx);
  requireRoomModerator(ctx, room);
  const config = roomSipConfig(ctx, room);
  assertRateLimit(
    ctx.services.limiters.sipList.check(`sip-list:${room.tenantId}:${room.id}:${ctx.ipHash}`),
    ctx,
    'Too many SIP list requests',
  );
  try {
    // Cleanup readiness: list works with the integration/trunk disabled.
    const participants = await ctx.services.sip.listParticipants(config, room);
    ctx.send(200, { roomId: room.id, participants });
  } catch (error) {
    sipHttpError(error);
  }
}

async function sipStatusHandler(ctx: RequestContext): Promise<void> {
  const tenantId = requireApiKeyTenant(ctx);
  assertRateLimit(ctx.services.limiters.admin.check(`admin:${tenantId}`), ctx, 'Too many admin requests');
  const config = ctx.tenants.getConfig(tenantId);
  const rooms = ctx.rooms.list(tenantId);
  ctx.send(200, await ctx.services.sip.status(config, rooms));
}

async function sipTestHandler(ctx: RequestContext): Promise<void> {
  const tenantId = requireApiKeyTenant(ctx);
  assertRateLimit(ctx.services.limiters.admin.check(`admin:${tenantId}`), ctx, 'Too many admin requests');
  const body = await ctx.jsonSchema(sipTestSchema);
  if (body.number && !isE164(body.number.trim())) {
    throw new HttpError(400, 'validation_failed', 'number must be an E.164 phone number');
  }
  const config = ctx.tenants.getConfig(tenantId);
  let result: SipTestResult;
  try {
    result = await ctx.services.sip.test(config, {
      ...(body.mode ? { mode: body.mode } : {}),
      ...(body.number ? { number: body.number.trim() } : {}),
    });
  } catch (error) {
    sipHttpError(error);
  }
  audit(ctx, {
    type: 'admin.action',
    severity: result.ok ? 'info' : 'warn',
    tenantId,
    ip: ctx.ip,
    message: `SIP gateway test ${result.ok ? 'ok' : 'failed'} (${result.mode})`,
    details: {
      kind: 'sip.test',
      mode: result.mode,
      ok: result.ok,
      configured: result.configured,
      trunkConfigured: result.trunkConfigured,
      latencyMs: result.latencyMs,
    },
  });
  ctx.send(200, result);
}

/** Registers SIP status/test (admin) and room dial-in/stop/list routes. */
export function registerSipRoutes(router: Router): void {
  router.get('/v1/admin/sip/status', sipStatusHandler);
  router.post('/v1/admin/sip/test', sipTestHandler);
  router.get('/v1/rooms/:roomId/sip', sipListHandler);
  router.post('/v1/rooms/:roomId/sip/dial-in', sipDialInHandler);
  router.post('/v1/rooms/:roomId/sip/:participantId/stop', sipStopHandler);
}
