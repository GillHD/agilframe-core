/**
 * Replaceable capability providers (contract §23, docs/extensibility.md).
 *
 * Every capability works out of the box (`builtin`), but a tenant may route it
 * to their own system (`external`) without forking: chat transport, file
 * storage, server STT, notifications, recording storage and virtual-background
 * libraries.
 *
 * External providers receive one signed JSON envelope:
 *   POST <endpoint>
 *   { capability, action, requestId, tenantId, roomId?, payload }
 * with `x-agil-signature: hex HMAC-SHA256(rawBody, secret-from-env)` plus
 * `x-agil-capability`, `x-agil-request-id`, `x-agil-tenant`.
 * They answer `{ ok: true, data }`; `data` is normalised by the adapter.
 *
 * Failure policy per slot: `fallback:'builtin'` (transparent degradation with an
 * audit line) or `fallback:'fail'` (HTTP 502 `provider_failed`). External
 * payloads are untrusted and never logged with PII.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type {
  BackgroundItem,
  BackgroundsResponse,
  ChatAttachment,
  ChatMessage,
  FileRecord,
  ProviderSlot,
  ProviderSlotName,
  ProviderStatus,
  ProviderTestResponse,
  ProvidersResponse,
  RecordingRecord,
  Role,
  SttResponse,
} from '@agil/protocol';
import type { TenantConfig } from '@agil/protocol';
import type { Env } from './env.js';
import type { Logger } from './logger.js';
import { postChatMessage, type ChatActor } from './chat.js';
import type { Room } from './rooms.js';
import { resolveTenantSecret } from './secret-env.js';
import type { Services } from './services.js';

/* ------------------------------------------------------------------ */
/* Public adapter contracts                                            */
/* ------------------------------------------------------------------ */

export interface ChatPostInput {
  tenantId: string;
  roomId: string;
  message: string;
  from: ChatActor;
  kind: 'text' | 'system';
  id?: string;
  attachment?: ChatAttachment;
  /** Display identity override (imports from a company messenger/bot). */
  displayFrom?: { id?: string; name?: string; role?: Role };
}

export interface ChatHistoryInput {
  tenantId: string;
  roomId: string;
  limit: number;
}

export interface ChatProvider {
  readonly name: string;
  post(input: ChatPostInput): Promise<ChatMessage>;
  history(input: ChatHistoryInput): Promise<ChatMessage[]>;
}

export interface FilePutInput {
  tenantId: string;
  roomId: string;
  name: string;
  mime: string;
  data: Buffer;
  uploadedBy: string;
  maxSizeMb: number;
  allowedMimeTypes: string[];
}

export interface FileGetResult {
  record: FileRecord;
  data: Buffer;
}

export interface FileListOptions {
  tenantId: string;
  roomId?: string;
  limit?: number;
}

export interface FileProvider {
  readonly name: string;
  put(input: FilePutInput): Promise<FileRecord>;
  get(input: { tenantId: string; id: string; sig: string | undefined; exp: number | undefined }): Promise<FileGetResult | null>;
  list(options: FileListOptions): Promise<FileRecord[]>;
  remove(input: { tenantId: string; id: string }): Promise<boolean>;
}

export interface SttProvider {
  readonly name: string;
  isConfigured(tenantId: string): boolean;
  transcribe(input: { tenantId: string; audio: Buffer; mime: string; language?: string }): Promise<SttResponse>;
}

export interface NotificationEvent {
  type: 'participant.joined' | 'participant.left' | 'recording.ready' | 'analysis.ready' | 'room.created' | 'room.closed';
  tenantId: string;
  roomId?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface NotificationProvider {
  readonly name: string;
  send(event: NotificationEvent): Promise<void>;
}

export interface RecordingProvider {
  readonly name: string;
  save(input: {
    tenantId: string;
    roomId: string;
    mime: string;
    data: Buffer;
    durationSec: number;
    createdBy: string;
    transcript?: string;
    maxSizeMb: number;
  }): Promise<RecordingRecord>;
  get(input: { tenantId: string; id: string; sig: string | undefined; exp: number | undefined }): Promise<{ record: RecordingRecord; data: Buffer } | null>;
  list(input: { tenantId: string; roomId?: string; limit?: number }): Promise<RecordingRecord[]>;
  remove(input: { tenantId: string; id: string }): Promise<boolean>;
}

export interface BackgroundProvider {
  readonly name: string;
  list(input: { tenantId: string }): Promise<BackgroundItem[]>;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export type ProviderErrorCode = 'provider_failed' | 'provider_unsupported' | 'provider_disabled' | 'provider_not_configured';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Signed external HTTP client                                         */
/* ------------------------------------------------------------------ */

export interface ExternalCallInput {
  slot: ProviderSlot;
  capability: ProviderSlotName;
  action: string;
  tenantId: string;
  roomId?: string;
  payload: Record<string, unknown>;
  /**
   * Startup snapshot of server-owned secret envs (`env.tenantSecretEnv`). The
   * tenant-selected `slot.apiKeyEnv` is resolved from here only — never
   * `process.env[name]` (a tenant admin could otherwise exfiltrate
   * `AGIL_TOKEN_SECRET` through the provider's `Authorization`-equivalent HMAC).
   */
  secrets: Record<string, string>;
  /** Override the slot timeout (ms). */
  timeoutMs?: number;
}

export type ExternalCallResult =
  | { ok: true; data: unknown; latencyMs: number; providerName: string }
  | { ok: false; error: string; latencyMs: number; providerName: string };

export function signProviderBody(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/** Calls one external provider; never throws, never logs secrets/PII. */
export async function callExternalProvider(input: ExternalCallInput): Promise<ExternalCallResult> {
  const endpoint = input.slot.endpoint.trim();
  const providerName = input.slot.providerName.trim() || 'external';
  if (!endpoint) return { ok: false, error: 'provider endpoint is not configured', latencyMs: 0, providerName };
  const secretRef = resolveTenantSecret({ tenantSecretEnv: input.secrets }, input.slot.apiKeyEnv, 'integration');
  if (!secretRef.allowed) {
    return {
      ok: false,
      error: `secret env ${secretRef.ref} is not allowed for a provider (expected AGIL_INTEGRATION_*)`,
      latencyMs: 0,
      providerName,
    };
  }
  const secret = secretRef.value;
  if (!secret) {
    return {
      ok: false,
      error: `secret env ${input.slot.apiKeyEnv || '<empty>'} is not set`,
      latencyMs: 0,
      providerName,
    };
  }
  const requestId = randomUUID();
  const body = JSON.stringify({
    capability: input.capability,
    action: input.action,
    requestId,
    tenantId: input.tenantId,
    ...(input.roomId ? { roomId: input.roomId } : {}),
    payload: input.payload,
  });
  const timeoutMs = Math.max(200, Math.min(30_000, input.timeoutMs ?? input.slot.timeoutMs ?? 5000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agil-signature': signProviderBody(secret, body),
        'x-agil-capability': input.capability,
        'x-agil-request-id': requestId,
        'x-agil-tenant': input.tenantId,
        accept: 'application/json',
      },
      body,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, latencyMs, providerName };
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { ok: false, error: 'invalid JSON response', latencyMs, providerName };
    }
    if (!isRecord(parsed) || parsed.ok !== true || !('data' in parsed)) {
      return { ok: false, error: 'response shape is not {ok:true,data}', latencyMs, providerName };
    }
    return { ok: true, data: parsed.data, latencyMs, providerName };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message = error instanceof Error && error.name === 'AbortError' ? 'timeout' : (error as Error).message;
    return { ok: false, error: message, latencyMs, providerName };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Response normalisers (untrusted input)                              */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) || fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeRole(value: unknown, fallback: Role): Role {
  return value === 'host' || value === 'moderator' || value === 'guest' ? value : fallback;
}

function normalizeChatMessage(
  data: unknown,
  fallback: { id: string; roomId: string; from: ChatActor; kind: 'text' | 'system'; text: string },
): ChatMessage | null {
  const raw = isRecord(data) && isRecord(data.message) ? data.message : isRecord(data) ? data : null;
  if (!raw) return null;
  const sourceFrom = isRecord(raw.from) ? raw.from : {};
  const message: ChatMessage = {
    id: text(raw.id, 64, fallback.id),
    roomId: fallback.roomId,
    from: {
      id: text(sourceFrom.id, 64, fallback.from.id),
      name: text(sourceFrom.name, 120, fallback.from.name),
      role: normalizeRole(sourceFrom.role, fallback.from.role),
    },
    text: text(raw.text, 4000, fallback.text),
    ts: number(raw.ts, Date.now()),
    kind: raw.kind === 'system' ? 'system' : fallback.kind,
  };
  if (!message.text) return null;
  return message;
}

function normalizeFileRecord(data: unknown, fallback: { tenantId: string; roomId: string }): FileRecord | null {
  const raw = isRecord(data) && isRecord(data.file) ? data.file : isRecord(data) ? data : null;
  if (!raw) return null;
  const id = text(raw.id, 64);
  const url = text(raw.url, 2048);
  if (!id || !url) return null;
  const record: FileRecord = {
    id,
    tenantId: text(raw.tenantId, 64, fallback.tenantId) || fallback.tenantId,
    roomId: text(raw.roomId, 64, fallback.roomId) || fallback.roomId,
    name: text(raw.name, 200, 'file'),
    size: number(raw.size, 0),
    mime: text(raw.mime, 128, 'application/octet-stream'),
    url,
    createdAt: number(raw.createdAt, Date.now()),
    expiresAt: number(raw.expiresAt, Date.now() + 86_400_000),
    uploadedBy: text(raw.uploadedBy, 64),
  };
  return record;
}

function normalizeFileList(data: unknown): FileRecord[] | null {
  const raw = isRecord(data) ? data.files : undefined;
  if (!Array.isArray(raw)) return null;
  const files: FileRecord[] = [];
  for (const item of raw) {
    const normalized = normalizeFileRecord(item, { tenantId: '', roomId: '' });
    if (normalized) files.push(normalized);
  }
  return files;
}

function normalizeStt(data: unknown): SttResponse | null {
  const raw = isRecord(data) && isRecord(data.transcription) ? data.transcription : isRecord(data) ? data : null;
  if (!raw) return null;
  const transcript = text(raw.text, 20_000);
  if (!transcript) return null;
  const response: SttResponse = { text: transcript, provider: 'server' };
  const language = text(raw.language, 16);
  if (language) response.language = language;
  if (typeof raw.durationSec === 'number' && Number.isFinite(raw.durationSec)) response.durationSec = raw.durationSec;
  if (Array.isArray(raw.segments)) {
    const segments = raw.segments
      .filter(isRecord)
      .map((segment) => ({ start: number(segment.start), end: number(segment.end), text: text(segment.text, 4000) }))
      .filter((segment) => segment.text.length > 0);
    if (segments.length > 0) response.segments = segments;
  }
  return response;
}

function normalizeRecordings(data: unknown): RecordingRecord[] | null {
  const raw = isRecord(data) ? data.recordings : undefined;
  if (!Array.isArray(raw)) return null;
  const recordings: RecordingRecord[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = text(item.id, 64);
    const url = text(item.url, 2048);
    if (!id || !url) continue;
    recordings.push({
      id,
      tenantId: text(item.tenantId, 64),
      roomId: text(item.roomId, 64),
      mime: text(item.mime, 128, 'video/webm'),
      size: number(item.size, 0),
      durationSec: number(item.durationSec, 0),
      url,
      createdAt: number(item.createdAt, Date.now()),
      createdBy: text(item.createdBy, 64),
    });
  }
  return recordings;
}

function normalizeBackgrounds(data: unknown): BackgroundItem[] | null {
  const raw = isRecord(data) ? data.backgrounds : undefined;
  if (!Array.isArray(raw)) return null;
  const backgrounds: BackgroundItem[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = text(item.id, 64);
    const name = text(item.name, 120, id);
    const url = text(item.url, 2048, '');
    if (!id) continue;
    backgrounds.push({ id, name, url });
  }
  return backgrounds;
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export interface ProviderRegistryOptions {
  env: Env;
  logger: Logger;
  services: Services;
  getConfig: (tenantId: string) => TenantConfig;
  getRoom: (tenantId: string, roomId: string) => Room | undefined;
  /** Tenants known to this server (used to resolve provider-owned download URLs). */
  listTenants?: () => string[];
  audit?: (entry: {
    type: 'admin.action' | 'webhook.failed' | 'chat.sent' | 'recording.saved' | 'file.shared';
    severity: 'info' | 'warn' | 'critical';
    tenantId?: string;
    roomId?: string;
    participantId?: string;
    message: string;
    details?: Record<string, unknown>;
  }) => void;
}

export const PROVIDER_SLOTS: ProviderSlotName[] = ['chat', 'files', 'stt', 'notifications', 'recording', 'backgrounds'];

export class ProviderRegistry {
  private readonly env: Env;
  private readonly logger: Logger;
  private readonly services: Services;
  private readonly getConfig: (tenantId: string) => TenantConfig;
  private readonly getRoom: (tenantId: string, roomId: string) => Room | undefined;
  private readonly listTenants: () => string[];
  private readonly audit?: ProviderRegistryOptions['audit'];

  constructor(options: ProviderRegistryOptions) {
    this.env = options.env;
    this.logger = options.logger;
    this.services = options.services;
    this.getConfig = options.getConfig;
    this.getRoom = options.getRoom;
    this.listTenants = options.listTenants ?? (() => [this.env.defaultTenantId]);
    this.audit = options.audit;
  }

  /* ------------------------------- helpers ------------------------------- */

  private slot(tenantId: string, slot: ProviderSlotName): ProviderSlot {
    return this.getConfig(tenantId).providers[slot];
  }

  private auditLine(
    type: 'admin.action' | 'webhook.failed' | 'chat.sent' | 'recording.saved' | 'file.shared',
    severity: 'info' | 'warn' | 'critical',
    tenantId: string,
    message: string,
    details: Record<string, unknown>,
    roomId?: string,
  ): void {
    try {
      this.audit?.({
        type,
        severity,
        tenantId,
        ...(roomId ? { roomId } : {}),
        message,
        details,
      });
    } catch {
      /* auditing must never break a provider call */
    }
  }

  private noteFallback(tenantId: string, slotName: ProviderSlotName, slot: ProviderSlot, error: string, roomId?: string): void {
    void slot;
    this.logger.warn('provider fallback to builtin', { tenantId, slot: slotName, error });
    this.auditLine('admin.action', 'warn', tenantId, `Provider ${slotName} failed; using builtin`, {
      kind: 'provider.fallback',
      slot: slotName,
      error: error.slice(0, 300),
    }, roomId);
  }

  private failOrFallback<T>(
    tenantId: string,
    slotName: ProviderSlotName,
    slot: ProviderSlot,
    error: string,
    builtin: () => Promise<T> | T,
    roomId?: string,
  ): Promise<T> {
    if (slot.fallback === 'fail') {
      this.auditLine('admin.action', 'critical', tenantId, `Provider ${slotName} failed (fallback=fail)`, {
        kind: 'provider.failed',
        slot: slotName,
        error: error.slice(0, 300),
      }, roomId);
      throw new ProviderError('provider_failed', `Provider ${slotName} failed: ${error}`);
    }
    this.noteFallback(tenantId, slotName, slot, error, roomId);
    return Promise.resolve(builtin());
  }

  /* -------------------------------- status -------------------------------- */

  status(tenantId: string): ProvidersResponse {
    const config = this.getConfig(tenantId);
    const providers: ProviderStatus[] = PROVIDER_SLOTS.map((slotName) => {
      const slot = config.providers[slotName];
      const external = slot.mode === 'external';
      const configured = slot.mode === 'builtin' ? true : external ? slot.endpoint.trim().length > 0 : false;
      let available = false;
      let note: string | undefined;
      if (slot.mode === 'builtin') {
        available = true;
        if (slotName === 'stt' && !this.services.stt.isConfigured()) {
          note = 'server STT is not configured (browser Web Speech fallback)';
        }
        if (slotName === 'notifications') note = 'builtin notifications are UI-only';
      } else if (slot.mode === 'disabled') {
        note = 'сapability disabled for this tenant';
      } else {
        const secretRef = resolveTenantSecret(this.env, slot.apiKeyEnv, 'integration');
        available = configured && Boolean(secretRef.value);
        if (!configured) note = 'endpoint is not configured';
        else if (!secretRef.allowed) note = `secret env ${secretRef.ref} is not allowed (expected AGIL_INTEGRATION_*)`;
        else if (!secretRef.value) note = `secret env ${slot.apiKeyEnv || '<empty>'} is not set`;
        if (slotName === 'recording') {
          available = false;
          note = 'external recording is not supported in MVP (provider_unsupported)';
        }
      }
      return {
        slot: slotName,
        mode: slot.mode,
        providerName: slot.providerName.trim() || (slot.mode === 'builtin' ? 'builtin' : 'external'),
        configured,
        available,
        fallback: slot.fallback,
        ...(note ? { note } : {}),
      };
    });
    return { providers };
  }

  /* --------------------------------- chat --------------------------------- */

  async chatPost(tenantId: string, roomId: string, input: {
    text: string;
    from: ChatActor;
    kind?: 'text' | 'system';
    id?: string;
    attachment?: ChatAttachment;
    displayFrom?: { id?: string; name?: string; role?: Role };
  }): Promise<ChatMessage> {
    const room = this.getRoom(tenantId, roomId);
    if (!room) throw new ProviderError('provider_failed', 'Room not found');
    const config = this.getConfig(tenantId);
    const slot = config.providers.chat;
    const kind = input.kind === 'system' ? 'system' : 'text';
    if (slot.mode === 'disabled') throw new ProviderError('provider_disabled', 'Chat is disabled for this tenant');
    if (slot.mode !== 'external' || config.session.chat.historyStorage !== 'session') {
      return this.chatBuiltin(config, room, input, kind);
    }
    const displayFrom = {
      id: input.displayFrom?.id ?? input.from.id,
      name: input.displayFrom?.name ?? input.from.name,
      role: input.displayFrom?.role ?? input.from.role,
    };

    // Idempotency is enforced before any provider call.
    if (input.id) {
      const existing = room.messages.find((message) => message.id === input.id);
      if (existing) return existing;
    }
    const payload = {
      text: input.text.slice(0, 4000),
      kind,
      from: displayFrom,
      ...(input.id ? { id: input.id } : {}),
      ...(input.attachment ? { attachment: input.attachment } : {}),
    };

    if (slot.mode === 'external') {
      const result = await callExternalProvider({
        slot,
        secrets: this.env.tenantSecretEnv,
        capability: 'chat',
        action: 'post',
        tenantId,
        roomId,
        payload,
      });
      if (result.ok) {
        const normalized = normalizeChatMessage(result.data, {
          id: input.id ?? randomUUID(),
          roomId,
          from: displayFrom,
          kind,
          text: input.text,
        });
        if (normalized) {
          const message: ChatMessage = {
            ...normalized,
            roomId,
            kind: normalized.kind === 'system' ? 'system' : kind,
            ...(input.attachment ? { attachment: input.attachment } : {}),
          };
          // Mirror into the live room so WS participants see it and welcome history stays coherent.
          if (this.getConfig(tenantId).session.chat.historyStorage === 'off') return message;
          room.addMessage(message);
          room.broadcast({ type: 'chat', message });
          this.auditLine('chat.sent', 'info', tenantId, `Chat message via external provider (${kind})`, {
            kind: 'chat.external',
            provider: result.providerName,
            messageId: message.id,
          }, roomId);
          this.services.webhooks.emit('chat.message', { tenantId, roomId }, {
            messageId: message.id,
            from: message.from,
            text: message.text.slice(0, 500),
            kind: message.kind,
            ts: message.ts,
          });
          return message;
        }
        if (slot.fallback === 'fail') throw new ProviderError('provider_failed', 'Provider chat returned invalid data');
        this.noteFallback(tenantId, 'chat', slot, 'invalid provider response', roomId);
      } else {
        if (slot.fallback === 'fail') {
          throw new ProviderError('provider_failed', `Provider chat failed: ${result.error}`);
        }
        this.noteFallback(tenantId, 'chat', slot, result.error, roomId);
      }
    }
    return this.chatBuiltin(this.getConfig(tenantId), room, input, kind);
  }

  private async chatBuiltin(
    config: TenantConfig,
    room: Room,
    input: {
      text: string;
      from: ChatActor;
      id?: string;
      attachment?: ChatAttachment;
      displayFrom?: { id?: string; name?: string; role?: Role };
    },
    kind: 'text' | 'system',
  ): Promise<ChatMessage> {
    const result = await postChatMessage({
      room,
      services: this.services,
      config,
      actor: input.from,
      text: input.text,
      kind,
      ...(input.id ? { id: input.id } : {}),
      ...(input.attachment ? { attachment: input.attachment } : {}),
      ...(input.displayFrom ? { from: input.displayFrom } : {}),
      logger: this.logger,
    });
    return result.message;
  }

  async chatHistory(tenantId: string, roomId: string, limit: number): Promise<ChatMessage[]> {
    const room = this.getRoom(tenantId, roomId);
    if (!room) return [];
    const config = this.getConfig(tenantId);
    const slot = config.providers.chat;
    const mode = config.session.chat.historyStorage;
    if (mode === 'off') room.messages.length = 0;
    if (mode === 'off' || slot.mode === 'disabled') return [];
    if (mode === 'local' || mode === 'postgres') {
      return this.archivedChatHistory(tenantId, roomId, limit, room.chatHistoryInstanceId);
    }
    if (slot.mode !== 'external') return room.history(limit);
    const result = await callExternalProvider({
      slot,
      secrets: this.env.tenantSecretEnv,
      capability: 'chat',
      action: 'history',
      tenantId,
      roomId,
      payload: { limit },
    });
    if (this.getConfig(tenantId).session.chat.historyStorage !== mode) return [];
    if (result.ok) {
      const raw = isRecord(result.data) && Array.isArray(result.data.messages) ? result.data.messages : Array.isArray(result.data) ? result.data : null;
      if (raw) {
        const messages = raw
          .map((item: unknown) => normalizeChatMessage(item, {
            id: randomUUID(),
            roomId,
            from: { id: 'external', name: 'External', role: 'guest' },
            kind: 'text',
            text: '',
          }))
          .filter((message): message is ChatMessage => message !== null)
          .slice(-Math.max(1, limit));
        return messages;
      }
      this.noteFallback(tenantId, 'chat', slot, 'invalid history response', roomId);
      return room.history(limit);
    }
    if (slot.fallback === 'fail') throw new ProviderError('provider_failed', `Provider chat failed: ${result.error}`);
    this.noteFallback(tenantId, 'chat', slot, result.error, roomId);
    return room.history(limit);
  }

  async archivedChatHistory(tenantId: string, roomId: string, limit: number, roomInstanceId?: string): Promise<ChatMessage[]> {
    const config = this.getConfig(tenantId);
    const mode = config.session.chat.historyStorage;
    if (config.providers.chat.mode === 'disabled' || (mode !== 'local' && mode !== 'postgres')) return [];
    const messages = await this.services.chatHistory.recent(mode, {
      tenantId, roomId, ...(roomInstanceId === undefined ? {} : { roomInstanceId }),
    }, limit);
    const current = this.getConfig(tenantId);
    return current.session.chat.historyStorage === mode && current.providers.chat.mode !== 'disabled' ? messages : [];
  }

  /* -------------------------------- files -------------------------------- */

  async filesPut(input: FilePutInput): Promise<FileRecord> {
    const slot = this.slot(input.tenantId, 'files');
    if (slot.mode === 'disabled') throw new ProviderError('provider_disabled', 'File sharing is disabled for this tenant');
    if (slot.mode !== 'external') return this.filesPutBuiltin(input);
    const result = await callExternalProvider({
      slot,
      secrets: this.env.tenantSecretEnv,
      capability: 'files',
      action: 'put',
      tenantId: input.tenantId,
      roomId: input.roomId,
      payload: {
        name: input.name,
        mime: input.mime,
        size: input.data.length,
        dataBase64: input.data.toString('base64'),
        uploadedBy: input.uploadedBy,
        maxSizeMb: input.maxSizeMb,
        allowedMimeTypes: input.allowedMimeTypes,
      },
    });
    if (result.ok) {
      const record = normalizeFileRecord(result.data, { tenantId: input.tenantId, roomId: input.roomId });
      if (record) {
        this.auditLine('file.shared', 'info', input.tenantId, `File uploaded via external provider: ${record.name}`, {
          kind: 'file.external',
          provider: result.providerName,
          fileId: record.id,
          size: record.size,
        }, input.roomId);
        return record;
      }
      return this.failOrFallback(input.tenantId, 'files', slot, 'invalid provider response', () => this.filesPutBuiltin(input), input.roomId);
    }
    if (slot.fallback === 'fail') throw new ProviderError('provider_failed', `Provider files failed: ${result.error}`);
    this.noteFallback(input.tenantId, 'files', slot, result.error, input.roomId);
    return this.filesPutBuiltin(input);
  }

  private filesPutBuiltin(input: FilePutInput): FileRecord {
    const record = this.services.files.save({
      data: input.data,
      name: input.name,
      mime: input.mime,
      tenantId: input.tenantId,
      roomId: input.roomId,
      uploadedBy: input.uploadedBy,
      maxSizeMb: input.maxSizeMb,
      allowedMimeTypes: input.allowedMimeTypes,
    });
    this.auditLine('file.shared', 'info', input.tenantId, `File uploaded: ${record.name}`, {
      kind: 'file.builtin',
      fileId: record.id,
      size: record.size,
      mime: record.mime,
    }, input.roomId);
    return record;
  }

  /**
   * Resolves a signed download. Signed URLs carry no tenant, so an explicit
   * `tenantId` (or `?tenant=` query) routes precisely; otherwise the registry
   * tries the builtin store first and then external file providers of known
   * tenants (the provider owns its own URL format).
   */
  async filesGet(input: { tenantId?: string; id: string; sig?: string; exp?: number }): Promise<FileGetResult | null> {
    const candidates = this.downloadCandidates(input.tenantId);
    for (const tenantId of candidates) {
      const slot = this.slot(tenantId, 'files');
      if (slot.mode === 'disabled') continue;
      if (slot.mode !== 'external') {
        const found = this.services.files.get(input.id, input.sig, input.exp);
        if (found) return found;
      }
    }
    for (const tenantId of candidates) {
      const slot = this.slot(tenantId, 'files');
      if (slot.mode !== 'external') continue;
      const result = await callExternalProvider({
        slot,
        secrets: this.env.tenantSecretEnv,
        capability: 'files',
        action: 'get',
        tenantId,
        payload: { id: input.id, sig: input.sig ?? null, exp: input.exp ?? null },
      });
      if (result.ok) {
        const raw = isRecord(result.data) ? (isRecord(result.data.file) ? result.data.file : result.data) : null;
        const record = normalizeFileRecord(raw, { tenantId, roomId: '' });
        const base64 = isRecord(result.data) && typeof result.data.dataBase64 === 'string' ? result.data.dataBase64 : '';
        if (record && base64) {
          try {
            return { record, data: Buffer.from(base64, 'base64') };
          } catch {
            /* invalid base64 -> try the next tenant/fallback */
          }
        }
      }
      if (input.tenantId) {
        if (slot.fallback === 'fail') throw new ProviderError('provider_failed', `Provider files failed: ${result.ok ? 'invalid download response' : result.error}`);
        this.noteFallback(tenantId, 'files', slot, result.ok ? 'invalid download response' : result.error);
        return this.services.files.get(input.id, input.sig, input.exp);
      }
    }
    return this.services.files.get(input.id, input.sig, input.exp);
  }

  private downloadCandidates(explicit?: string): string[] {
    if (explicit) return [explicit];
    try {
      return [...new Set(this.listTenants())];
    } catch {
      return [this.env.defaultTenantId];
    }
  }

  async filesList(options: FileListOptions): Promise<FileRecord[]> {
    const slot = this.slot(options.tenantId, 'files');
    if (slot.mode === 'disabled') throw new ProviderError('provider_disabled', 'File sharing is disabled for this tenant');
    if (slot.mode !== 'external') {
      return this.services.files.list({ tenantId: options.tenantId, ...(options.roomId ? { roomId: options.roomId } : {}), limit: options.limit ?? 100 });
    }
    const result = await callExternalProvider({
      slot,
      secrets: this.env.tenantSecretEnv,
      capability: 'files',
      action: 'list',
      tenantId: options.tenantId,
      roomId: options.roomId,
      payload: { roomId: options.roomId ?? null, limit: options.limit ?? 100 },
    });
    if (result.ok) {
      const files = normalizeFileList(result.data);
      if (files) return files;
      if (slot.fallback === 'fail') throw new ProviderError('provider_failed', 'Provider files returned invalid list');
      this.noteFallback(options.tenantId, 'files', slot, 'invalid list response', options.roomId);
      return this.services.files.list({ tenantId: options.tenantId, ...(options.roomId ? { roomId: options.roomId } : {}), limit: options.limit ?? 100 });
    }
    if (slot.fallback === 'fail') throw new ProviderError('provider_failed', `Provider files failed: ${result.error}`);
    this.noteFallback(options.tenantId, 'files', slot, result.error, options.roomId);
    return this.services.files.list({ tenantId: options.tenantId, ...(options.roomId ? { roomId: options.roomId } : {}), limit: options.limit ?? 100 });
  }

  async filesRemove(input: { tenantId: string; id: string }): Promise<boolean> {
    const slot = this.slot(input.tenantId, 'files');
    if (slot.mode !== 'external') return this.services.files.remove(input.id);
    const result = await callExternalProvider({
      slot,
      secrets: this.env.tenantSecretEnv,
      capability: 'files',
      action: 'remove',
      tenantId: input.tenantId,
      payload: { id: input.id },
    });
    if (result.ok && isRecord(result.data)) return bool(result.data.removed, false);
    if (slot.fallback === 'fail') throw new ProviderError('provider_failed', `Provider files failed: ${result.ok ? 'invalid response' : result.error}`);
    this.noteFallback(input.tenantId, 'files', slot, result.ok ? 'invalid remove response' : result.error);
    return this.services.files.remove(input.id);
  }

  /* --------------------------------- stt --------------------------------- */

  sttConfigured(tenantId: string): boolean {
    // Explicit STT_PROVIDER wins over tenant slots: a local deployment must not
    // silently fall back to a vendor endpoint, and `none`/`browser` mean "no
    // server STT at all". Otherwise the slot / AGIL_STT_URL path applies.
    if (this.env.sttProvider === 'local') return this.services.sttTranslation.isLocalSttConfigured();
    if (this.env.sttProvider === 'browser' || this.env.sttProvider === 'none') return false;
    const slot = this.slot(tenantId, 'stt');
    if (slot.mode === 'disabled') return false;
    if (slot.mode === 'external') return slot.endpoint.trim().length > 0;
    return this.services.stt.isConfigured();
  }

  async sttTranscribe(input: { tenantId: string; audio: Buffer; mime: string; language?: string }): Promise<SttResponse> {
    const slot = this.slot(input.tenantId, 'stt');
    if (slot.mode === 'disabled') throw new ProviderError('provider_disabled', 'Server-side STT is disabled for this tenant');
    if (slot.mode === 'external') {
      const result = await callExternalProvider({
        slot,
        secrets: this.env.tenantSecretEnv,
        capability: 'stt',
        action: 'transcribe',
        tenantId: input.tenantId,
        payload: { mime: input.mime, language: input.language ?? null, audioBase64: input.audio.toString('base64') },
      });
      if (result.ok) {
        const normalized = normalizeStt(result.data);
        if (normalized) return normalized;
        if (slot.fallback === 'fail') throw new ProviderError('provider_failed', 'Provider stt returned invalid data');
        this.noteFallback(input.tenantId, 'stt', slot, 'invalid transcription response');
      } else {
        if (slot.fallback === 'fail') throw new ProviderError('provider_failed', `Provider stt failed: ${result.error}`);
        this.noteFallback(input.tenantId, 'stt', slot, result.error);
      }
    }
    return this.services.stt.transcribe(input.audio, {
      mime: input.mime,
      ...(input.language ? { language: input.language } : {}),
    });
  }

  /* ----------------------------- notifications ----------------------------- */

  /** Best-effort outbound notification: never throws, never blocks the call. */
  notify(event: NotificationEvent): void {
    let slot: ProviderSlot;
    try {
      slot = this.slot(event.tenantId, 'notifications');
    } catch {
      return;
    }
    if (slot.mode !== 'external') return; // builtin: UI-only events
    void callExternalProvider({
      slot,
      secrets: this.env.tenantSecretEnv,
      capability: 'notifications',
      action: 'send',
      tenantId: event.tenantId,
      roomId: event.roomId,
      payload: {
        type: event.type,
        message: event.message,
        ...(event.data ? { data: event.data } : {}),
      },
    }).then((result) => {
      if (!result.ok) {
        this.logger.warn('notification provider failed', { tenantId: event.tenantId, slot: 'notifications', error: result.error });
        this.auditLine('webhook.failed', 'warn', event.tenantId, `Notification provider failed: ${event.type}`, {
          kind: 'provider.notification_failed',
          provider: result.providerName,
          error: result.error.slice(0, 300),
        }, event.roomId);
      }
    }).catch(() => {
      /* best-effort */
    });
  }

  /* ------------------------------- recording ------------------------------- */

  private recordingSupported(tenantId: string): ProviderSlot {
    const slot = this.slot(tenantId, 'recording');
    if (slot.mode === 'external') {
      throw new ProviderError('provider_unsupported', 'External recording storage is not supported in MVP; use builtin recording or an S3-compatible files provider');
    }
    return slot;
  }

  async recordingSave(input: {
    tenantId: string;
    roomId: string;
    mime: string;
    data: Buffer;
    durationSec: number;
    createdBy: string;
    transcript?: string;
    maxSizeMb: number;
  }): Promise<RecordingRecord> {
    this.recordingSupported(input.tenantId);
    return this.services.recordings.save({
      data: input.data,
      mime: input.mime,
      tenantId: input.tenantId,
      roomId: input.roomId,
      createdBy: input.createdBy,
      durationSec: input.durationSec,
      maxSizeMb: input.maxSizeMb,
      ...(input.transcript ? { transcript: input.transcript } : {}),
    });
  }

  async recordingGet(input: { tenantId?: string; id: string; sig?: string; exp?: number }): Promise<{ record: RecordingRecord; data: Buffer } | null> {
    // Recording storage is builtin-only: external => provider_unsupported.
    if (input.tenantId) this.recordingSupported(input.tenantId);
    return this.services.recordings.get(input.id, input.sig, input.exp);
  }

  async recordingList(input: { tenantId: string; roomId?: string; limit?: number }): Promise<RecordingRecord[]> {
    this.recordingSupported(input.tenantId);
    return this.services.recordings.list({ tenantId: input.tenantId, ...(input.roomId ? { roomId: input.roomId } : {}), limit: input.limit ?? 100 });
  }

  async recordingRemove(input: { tenantId: string; id: string }): Promise<boolean> {
    this.recordingSupported(input.tenantId);
    return this.services.recordings.remove(input.id, input.tenantId);
  }

  /* ------------------------------ backgrounds ------------------------------ */

  async backgrounds(tenantId: string): Promise<BackgroundsResponse> {
    const config = this.getConfig(tenantId);
    const slot = config.providers.backgrounds;
    const builtin = (): BackgroundsResponse => ({
      backgrounds: config.session.virtualBackgrounds.map((background) => ({
        id: background.id,
        name: background.name,
        url: background.url,
      })),
      provider: 'builtin',
    });
    if (slot.mode === 'disabled') {
      throw new ProviderError('provider_disabled', 'Background library is disabled for this tenant');
    }
    if (slot.mode !== 'external') return builtin();
    const result = await callExternalProvider({
      slot,
      secrets: this.env.tenantSecretEnv,
      capability: 'backgrounds',
      action: 'list',
      tenantId,
      payload: {},
    });
    if (result.ok) {
      const backgrounds = normalizeBackgrounds(result.data);
      if (backgrounds) return { backgrounds, provider: result.providerName };
      if (slot.fallback === 'fail') throw new ProviderError('provider_failed', 'Provider backgrounds returned invalid data');
      this.noteFallback(tenantId, 'backgrounds', slot, 'invalid list response');
      return builtin();
    }
    if (slot.fallback === 'fail') throw new ProviderError('provider_failed', `Provider backgrounds failed: ${result.error}`);
    this.noteFallback(tenantId, 'backgrounds', slot, result.error);
    return builtin();
  }

  /* --------------------------------- test --------------------------------- */

  async test(tenantId: string, slotName: ProviderSlotName, payload?: Record<string, unknown>): Promise<ProviderTestResponse> {
    const slot = this.slot(tenantId, slotName);
    if (slot.mode !== 'external') {
      const started = Date.now();
      let ok = true;
      let detail = 'builtin provider is active';
      try {
        if (slotName === 'stt') {
          ok = this.services.stt.isConfigured();
          detail = ok ? 'builtin server STT is configured' : 'AGIL_STT_URL is not configured (browser Web Speech fallback)';
        } else if (slotName === 'files') {
          this.services.files.list({ tenantId, limit: 1 });
          detail = 'local file store is available';
        } else if (slotName === 'backgrounds') {
          detail = `${this.getConfig(tenantId).session.virtualBackgrounds.length} builtin backgrounds`;
        } else if (slotName === 'notifications') {
          detail = 'builtin notifications are UI-only (no outbound transport)';
        } else if (slotName === 'recording') {
          this.services.recordings.list({ tenantId, limit: 1 });
          detail = 'local recording store is available';
        }
      } catch (error) {
        ok = false;
        detail = (error as Error).message;
      }
      return {
        slot: slotName,
        ok,
        providerName: slot.providerName.trim() || 'builtin',
        latencyMs: Date.now() - started,
        detail,
      };
    }
    if (slotName === 'recording') {
      throw new ProviderError('provider_unsupported', 'External recording storage is not supported in MVP');
    }
    const result = await callExternalProvider({
      slot,
      secrets: this.env.tenantSecretEnv,
      capability: slotName,
      action: 'test',
      tenantId,
      ...(payload ? {} : {}),
      payload: payload ?? {},
    });
    return {
      slot: slotName,
      ok: result.ok,
      providerName: result.providerName,
      latencyMs: result.latencyMs,
      detail: result.ok ? 'external provider responded with {ok:true,data}' : result.error,
    };
  }
}
