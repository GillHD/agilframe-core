/**
 * WebSocket signaling server (contract §5, §18): presence, SDP/ICE relay for
 * the mesh topology, chat over signaling, captions → transcript pipeline,
 * compliance analysis, integrity signals and the corporate knowledge assistant.
 *
 * The server is a deterministic SDP/ICE relay — the mesh initiator is the peer
 * with the lexicographically smaller participant id. Every incoming frame is
 * parsed with zod (`parseClientMessage`) inside a try/catch, the per-socket rate
 * limit is 40 messages/second (3 violations → close 1008) and a protocol-level
 * heartbeat pings every 30 s (missing pong → terminate). Chat is independent of
 * media, so it survives media degradation.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  browserRecordingEnabled,
  encodeMessage,
  parseClientMessage,
  whiteboardStrokeProblem,
  WHITEBOARD_DEFAULT_COLOR,
  WHITEBOARD_DEFAULT_WIDTH,
  VIDEO_UPGRADE_TTL_MS,
  type ChatAttachment,
  type ChatMessage,
  type ClientMessage,
  type FeatureKey,
  type Participant,
  type ParticipantLocation,
  type Role,
  type ServerErrorCode,
  type ServerMessage,
  type TenantConfig,
  type TranscriptSegment,
  type WhiteboardAuthor,
} from '@agil/protocol';
import {
  countryFromHeaders,
  resolveClientIp,
  hashIp,
  type HeaderMap,
  type MediaIntegrityResult,
} from '@agil/security';
import {
  accessOf,
  canUseFeature,
  claimsPermissions,
  claimsRoleId,
  knowledgeAccessOf,
  verifyAuthToken,
  type TokenClaims,
} from './auth.js';
import type { Env } from './env.js';
import { safeAudit } from './http.js';
import { ChatStorageUnavailable } from './chat-history.js';
import { checkPublicAbuse, PUBLIC_ABUSE_MESSAGE } from './public-abuse.js';
import type { Logger } from './logger.js';
import { roomConfig, type Room, type RoomConnection, type RoomRegistry } from './rooms.js';
import { evaluateJoinQuota, tenantUsageCounts } from './billing.js';
import type { AnalysisPipeline } from './analysis.js';
import { runRoomAnalysis } from './analysis.js';
import { resolveParticipantIce } from './scale.js';
import { buildSfuMedia, applySfuCapacityProfile, capacityLimitMessage, removeSfuParticipant, roomCapacityInfo } from './sfu.js';
import type { ProviderRegistry, NotificationEvent } from './providers.js';
import type { Services } from './services.js';
import { evaluateIntegrity, knowledgeConfigurationIssue, resolveRequestGeo } from './services.js';
import type { TenantStore } from './tenants.js';
import type { RoomContinuity } from './continuity.js';
import type { DomainRegistry } from './domains.js';
import type { ClusterStore } from './cluster.js';

export const WS_PATH = '/ws';
/** Stable signaling subprotocol; the join token travels as a second subprotocol. */
export const WS_SUBPROTOCOL = 'agil-calls.v1';
export const WS_TOKEN_PROTOCOL_PREFIX = 'agil-token.';
/**
 * Resume capability subprotocol (`agil-resume.<token>`), offered only on a
 * reconnect. Like the join token it never appears in the WebSocket URL.
 */
export const WS_RESUME_PROTOCOL_PREFIX = 'agil-resume.';
/** Opt-in query flag that lets the server hold presence during a short blip. */
export const WS_RESUME_QUERY = 'resume';

const MAX_MESSAGES_PER_SECOND = 40;
const MAX_RATE_VIOLATIONS = 3;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_ASSISTANT_QUERIES_PER_MIN = 10;
const ASSISTANT_WINDOW_MS = 60_000;

interface SocketState {
  ws: WebSocket;
  room: Room;
  participant: Participant;
  tokenPermissions?: FeatureKey[];
  /** Company-defined custom role id from the token (resolved on every access check). */
  roleId?: string;
  ip: string;
  ipHash: string;
  country?: string;
  locale?: 'ru' | 'en';
  isAlive: boolean;
  windowStart: number;
  windowCount: number;
  violations: number;
  assistantTimestamps: number[];
  /** Set when the server (or another connection) owns the close cleanup. */
  detached: boolean;
  analysisRunning: boolean;
  /** Socket opted into the resume grace lease (`?resume=1` or a resume token). */
  resumeCapable: boolean;
  /** Deliberate `bye`: never hold presence for this socket. */
  resumeDisabled: boolean;
  iceRefreshAt?: number;
}

export interface SignalingOptions {
  httpServer: HttpServer;
  env: Env;
  services: Services;
  tenants: TenantStore;
  rooms: RoomRegistry;
  cluster: ClusterStore;
  /** Verified custom domains; their origins are allowed for browser WS. */
  domains: DomainRegistry;
  analysis: AnalysisPipeline;
  providers: ProviderRegistry;
  logger: Logger;
  /** Live-call continuity (snapshots + resume lease); absent = continuity disabled. */
  continuity?: RoomContinuity;
}

export interface SignalingServer {
  wss: WebSocketServer;
  /** Number of currently connected sockets. */
  clientCount(): number;
  close(): Promise<void>;
}

function defaultState(): Participant['state'] {
  return { mic: 'on', cam: 'on', screen: false, handRaised: false, network: 'good' };
}

function parseRole(raw: string | null): Role {
  return raw === 'host' || raw === 'moderator' || raw === 'guest' ? raw : 'guest';
}

function parseLocale(raw: string | null): 'ru' | 'en' | undefined {
  return raw === 'ru' || raw === 'en' ? raw : undefined;
}

/**
 * Extracts the join token from `Sec-WebSocket-Protocol`.
 *
 * The token must never be a query parameter: browsers print the WebSocket URL
 * in their console when an upgrade fails. `?token=` is still accepted for older
 * clients/tools; new clients offer the token as an encoded subprotocol and the
 * server selects only the stable API protocol in the response.
 */
function tokenFromSubprotocols(header: string | string[] | undefined): string | undefined {
  return protocolValue(header, WS_TOKEN_PROTOCOL_PREFIX);
}

/** Reads the resume capability from the same handshake header (never the URL). */
function resumeTokenFromSubprotocols(header: string | string[] | undefined): string | undefined {
  return protocolValue(header, WS_RESUME_PROTOCOL_PREFIX);
}

function protocolValue(header: string | string[] | undefined, prefix: string): string | undefined {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return undefined;
  for (const item of raw.split(',')) {
    const protocol = item.trim();
    if (!protocol.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(protocol.slice(prefix.length));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isOpen(ws: WebSocket): boolean {
  return ws.readyState === WebSocket.OPEN;
}

/** `https://Portal.Example.com/` -> `https://portal.example.com`; null when invalid. */
function normalizeOrigin(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export type WsOriginDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Browser WebSocket origin policy.
 *
 * - A browser always sends `Origin`; it must match `AGIL_PUBLIC_ORIGIN`, the
 *   tenant's `integrations.allowedOrigins`, its verified custom domain, or an
 *   explicit `AGIL_WS_ALLOWED_ORIGINS` entry. An explicit `*` in either list
 *   allows any origin for that tenant.
 * - `Origin: null` (opaque origin: sandboxed iframe, `file://`, some redirects)
 *   is always rejected — a null origin cannot be trusted for a credentialed
 *   socket.
 * - A non-browser client (SDK, CLI, load test) sends no `Origin`: allowed only
 *   with a valid join token, because an anonymous WS join is a browser flow and
 *   must prove its page origin.
 * - `AGIL_WS_ORIGIN_ENFORCE=0` disables the check (checked by callers).
 */
export function evaluateWsOrigin(options: {
  env: Env;
  config: TenantConfig;
  customDomain?: string;
  origin: string | undefined;
  tokenPresent: boolean;
}): WsOriginDecision {
  const { env, config, customDomain, tokenPresent } = options;
  const raw = typeof options.origin === 'string' ? options.origin.trim() : '';
  if (!raw) {
    return tokenPresent
      ? { allowed: true }
      : { allowed: false, reason: 'Origin header is required for anonymous WebSocket joins' };
  }
  if (raw.toLowerCase() === 'null') {
    return { allowed: false, reason: 'WebSocket Origin "null" is not allowed' };
  }
  const normalized = normalizeOrigin(raw);
  if (!normalized) return { allowed: false, reason: 'Invalid WebSocket Origin' };

  const allowed = new Set<string>();
  let wildcard = false;
  for (const candidate of [env.publicOrigin, ...env.wsAllowedOrigins]) {
    const value = candidate.trim();
    if (value === '*') {
      wildcard = true;
      continue;
    }
    const origin = normalizeOrigin(value);
    if (origin) allowed.add(origin);
  }
  for (const candidate of config.integrations.allowedOrigins) {
    const value = candidate.trim();
    if (value === '*') {
      wildcard = true;
      continue;
    }
    const origin = normalizeOrigin(value);
    if (origin) allowed.add(origin);
  }
  // The page on the tenant's verified custom domain opens the socket on that
  // same origin, which may be in neither the platform origin nor the allowlist.
  if (customDomain) {
    allowed.add(`https://${customDomain}`);
    allowed.add(`http://${customDomain}`);
  }
  if (wildcard || allowed.has(normalized)) return { allowed: true };
  return { allowed: false, reason: 'WebSocket Origin is not allowed' };
}

export function createSignalingServer(options: SignalingOptions): SignalingServer {
  const { env, services, tenants, rooms, domains, analysis, providers, logger, continuity, cluster } = options;
  const isTurnNodeAvailable = (tenantId: string, nodeId: string) => cluster.turnNodeState(tenantId, nodeId) === 'ready';
  const readTurnNode = (tenantId: string, nodeId: string) => cluster.getNode(tenantId, nodeId);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    // Echo only the stable API protocol, never the token-bearing one: the
    // browser would accept either, but the token has no reason to round-trip.
    handleProtocols: (protocols) => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : [...protocols][0] ?? false),
  });
  const sockets = new Map<WebSocket, SocketState>();
  const videoUpgrades = new WeakMap<Room, { from: string; to: string; requestId: string; expiresAt: number }>();
  const tenantSubscriptions = new Map<string, { unsubscribe: () => void; count: number }>();
  /** Grace leases for dropped sockets: `<roomId>:<participantId>` → timer. */
  const resumeTimers = new Map<string, NodeJS.Timeout>();
  const pendingSfuDepartures = new Map<string, Promise<void>>();
  let heartbeat: NodeJS.Timeout | null = null;

  const resumeKey = (roomId: string, participantId: string): string => `${roomId}:${participantId}`;

  const clearResumeTimer = (roomId: string, participantId: string): void => {
    const key = resumeKey(roomId, participantId);
    const timer = resumeTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    resumeTimers.delete(key);
  };

  const sendFrame = (ws: WebSocket, message: ServerMessage): void => {
    if (!isOpen(ws)) return;
    try {
      ws.send(encodeMessage(message));
    } catch {
      /* the close handler will clean the socket up */
    }
  };

  const sendError = (ws: WebSocket, code: ServerErrorCode, message: string, fatal = false): void => {
    sendFrame(ws, { type: 'error', code, message, ...(fatal ? { fatal: true } : {}) });
  };

  const audit = (state: SocketState, entry: Parameters<typeof safeAudit>[2]): void => {
    safeAudit(logger, services.audit, entry);
  };

  /* ------------------------- tenant config broadcast ------------------------- */

  const retainTenantSubscription = (tenantId: string): void => {
    const existing = tenantSubscriptions.get(tenantId);
    if (existing) {
      existing.count += 1;
      return;
    }
    const unsubscribe = tenants.subscribe(tenantId, (tenantConfig) => {
      const updates: Array<{ state: SocketState; config: TenantConfig }> = [];
      for (const state of sockets.values()) {
        if (state.room.tenantId !== tenantId) continue;
        const config = roomConfig(state.room, tenantConfig);
        // Recompute permissions so UI gating follows the new policy immediately.
        try {
          state.participant.permissions = accessOf({
            config,
            role: state.participant.role,
            userId: state.participant.id,
            tokenPermissions: state.tokenPermissions,
            ...(state.roleId ? { roleId: state.roleId } : {}),
          }).allowed;
          state.room.updateParticipant(state.participant.id, { permissions: state.participant.permissions });
          if (state.participant.state.handRaised && !state.participant.permissions.includes('handRaise')) {
            const lowered = state.room.updateState(state.participant.id, { handRaised: false });
            if (lowered) state.participant.state = lowered;
          }
        } catch {
          /* keep the previous permission list */
        }
        updates.push({ state, config });
      }
      for (const { state, config } of updates) {
        sendFrame(state.ws, { type: 'config', config });
        sendFrame(state.ws, {
          type: 'room',
          room: state.room.info(),
          participants: state.room.participants(),
        });
      }
    });
    tenantSubscriptions.set(tenantId, { unsubscribe, count: 1 });
  };

  const releaseTenantSubscription = (tenantId: string): void => {
    const existing = tenantSubscriptions.get(tenantId);
    if (!existing) return;
    existing.count -= 1;
    if (existing.count > 0) return;
    existing.unsubscribe();
    tenantSubscriptions.delete(tenantId);
  };

  /* ------------------------------ auth/join ------------------------------ */

  interface JoinIdentity {
    roomId: string;
    tenantId: string;
    role: Role;
    name: string;
    participantId: string;
    claims: TokenClaims | null;
    anonymous: boolean;
  }

  const authenticate = (
    url: URL,
    requestedProtocols?: string | string[],
  ): { ok: true; identity: JoinIdentity } | { ok: false; code: import('@agil/protocol').ServerErrorCode; message: string } => {
    const rawToken = url.searchParams.get('token') ?? tokenFromSubprotocols(requestedProtocols);
    const claims = verifyAuthToken(env, rawToken);
    if (claims) {
      return {
        ok: true,
        identity: {
          roomId: claims.roomId,
          tenantId: claims.tenantId,
          role: claims.role,
          name: claims.name,
          participantId: claims.sub,
          claims,
          anonymous: false,
        },
      };
    }
    if (rawToken && !claims) {
      return { ok: false, code: 'unauthorized', message: 'Invalid or expired access token' };
    }
    if (!env.allowAnonymous) {
      return { ok: false, code: 'unauthorized', message: 'A valid access token is required' };
    }
    const roomId = url.searchParams.get('room');
    if (!roomId) return { ok: false, code: 'bad_request', message: 'Missing room parameter' };
    const tenantId = url.searchParams.get('tenant') ?? env.defaultTenantId;
    const name = (url.searchParams.get('name') ?? 'Гость').trim().slice(0, 120) || 'Гость';
    return {
      ok: true,
      identity: {
        roomId,
        tenantId,
        role: parseRole(url.searchParams.get('role')),
        name,
        participantId: (url.searchParams.get('participant') ?? '').trim() || randomUUID(),
        claims: null,
        anonymous: true,
      },
    };
  };

  /* --------------------------- message handlers --------------------------- */

  const relayUnknownPeer = (state: SocketState, to: string): void => {
    sendError(state.ws, 'unknown_peer', `Participant ${to} is not in this room`);
  };

  const broadcastToRoom = (state: SocketState, message: ServerMessage, exceptSelf = true): void => {
    state.room.broadcast(message, exceptSelf ? { except: state.participant.id } : {});
  };

  const chatConfig = (state: SocketState): TenantConfig =>
    roomConfig(state.room, tenants.getConfig(state.room.tenantId));

  const canReadChat = (state: SocketState, config = chatConfig(state)): boolean =>
    config.features.chat && canUse(state, config, 'chat');

  const canReceiveWelcomeHistory = (state: SocketState): boolean => {
    const config = chatConfig(state);
    return config.features.chatHistoryOnJoin && canReadChat(state, config) && canUse(state, config, 'chatHistoryOnJoin');
  };

  const handleChat = async (state: SocketState, message: Extract<ClientMessage, { type: 'chat' }>): Promise<void> => {
    const reject = (error: 'unauthorized' | 'delivery_failed', detail: string): void => {
      if (message.acknowledge) {
        sendFrame(state.ws, { type: 'chat-result', id: message.id, error });
      } else {
        sendError(state.ws, error === 'unauthorized' ? error : 'internal_error', detail);
      }
    };
    const config = chatConfig(state);
    if (!canReadChat(state, config) || (state.participant.role === 'guest' && !config.security.guestCanChat)) {
      reject('unauthorized', 'Chat is not allowed for this participant');
      return;
    }
    const attachment: ChatAttachment | undefined = message.attachment
      ? {
          name: message.attachment.name,
          size: message.attachment.size,
          mime: message.attachment.mime,
          url: message.attachment.url,
        }
      : undefined;
    try {
      // Provider routing: builtin stores+broadcasts via the room; external calls the
      // company messenger and mirrors the message into the live room.
      const sent = await providers.chatPost(state.room.tenantId, state.room.id, {
        text: message.text,
        from: { id: state.participant.id, name: state.participant.name, role: state.participant.role },
        kind: 'text',
        id: message.id,
        ...(attachment ? { attachment } : {}),
      });
      if (message.acknowledge) sendFrame(state.ws, { type: 'chat-result', id: message.id, message: sent });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'provider_disabled') {
        reject('unauthorized', 'Chat is disabled for this tenant');
      } else {
        logger.warn('chat provider failed', { roomId: state.room.id, error: String(error) });
        reject('delivery_failed', 'Chat delivery failed');
      }
    }
  };

  const handleCaption = (state: SocketState, message: Extract<ClientMessage, { type: 'caption' }>): void => {
    const config = roomConfig(state.room, tenants.getConfig(state.room.tenantId));
    if (state.detached) return;
    if (services.sttTranslation.consentRequired(state.room.tenantId) && !state.room.hasTranscriptConsent(state.participant.id)) {
      sendError(state.ws, 'consent_required', 'Transcription consent is required before captions are stored');
      return;
    }
    const now = Date.now();
    const offsetSec = Math.max(0, (now - state.room.createdAt) / 1000);
    const saveTranscript = config.session.transcription.saveTranscript;
    const segment: TranscriptSegment = {
      id: randomUUID(),
      participantId: state.participant.id,
      participantName: state.participant.name,
      text: message.text.slice(0, 4000),
      start: offsetSec,
      end: offsetSec,
      isFinal: message.isFinal,
      ...(message.lang ? { lang: message.lang } : state.locale ? { lang: state.locale } : {}),
      ts: now,
    };
    if (message.isFinal && config.features.captions && !config.security.e2ee) {
      const connection = state.room.member(state.participant.id)?.connection;
      if (connection) services.conversationReview.inspect(state.room, connection, segment.text);
    }
    if (saveTranscript) {
      // Retention is enforced lazily on writes and reads.
      state.room.pruneTranscript(services.sttTranslation.retentionSec(state.room.tenantId), now);
      state.room.addSegment(segment);
      state.room.setCaption({
        participantId: state.participant.id,
        participantName: state.participant.name,
        text: message.text,
        isFinal: message.isFinal,
        ...(message.lang ? { lang: message.lang } : {}),
        ts: now,
      });
    }
    broadcastToRoom(state, {
      type: 'caption',
      participantId: state.participant.id,
      text: message.text,
      isFinal: message.isFinal,
      ts: now,
      ...(saveTranscript ? { segmentId: segment.id } : {}),
    });
    // Machine translation runs after the original caption is delivered, so a
    // slow/broken MT engine never delays captions. The follow-up frame carries
    // the same text/ts plus the translation and is merged by the widget.
    if (message.isFinal && config.session.transcription.translateTo !== 'none' && services.sttTranslation.translationProvider !== 'none') {
      void services.sttTranslation
        .translateCaption({
          tenantId: state.room.tenantId,
          text: segment.text,
          ...(segment.lang ? { sourceLang: segment.lang } : {}),
          targetLang: config.session.transcription.translateTo,
        })
        .then((translation) => {
          if (!translation) return;
          segment.translation = translation;
          broadcastToRoom(
            state,
            {
              type: 'caption',
              participantId: state.participant.id,
              text: segment.text,
              isFinal: true,
              ts: now,
              ...(saveTranscript ? { segmentId: segment.id } : {}),
              translation: translation.text,
              translationLang: translation.lang,
              translationProvider: translation.provider,
              translated: true,
            },
            false,
          );
        })
        .catch((error: unknown) => {
          logger.warn('caption translation failed', {
            roomId: state.room.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    if (!saveTranscript) return;
    // Batch trigger: new final segments since the last analysis run.
    const aiAgent = config.session.aiAgent;
    if (aiAgent.enabled && message.isFinal) {
      const pending = state.room
        .finalSegments()
        .filter((candidate) => candidate.ts > state.room.analysisUpdatedAt).length;
      if (pending >= aiAgent.batchSize) scheduleAnalysis(state.room, 'batch');
    }
    services.webhooks.emit(
      'transcript.ready',
      { tenantId: state.room.tenantId, roomId: state.room.id },
      { segments: state.room.segments.length, lastSegmentId: segment.id },
    );
  };

  const handleIntegrity = (state: SocketState, message: Extract<ClientMessage, { type: 'integrity' }>): void => {
    const config = tenants.getConfig(state.room.tenantId);
    let status = message.status;
    let score = message.score ?? 0;
    let flags = message.flags ?? [];
    try {
      // Local heuristics are re-evaluated server-side; the external detector is
      // optional and only reflected when the tenant configured one.
      const evaluated = evaluateClientIntegrity(config, message);
      if (evaluated.status !== 'unknown') status = evaluated.status;
      if (evaluated.flags.length > 0) flags = evaluated.flags;
      score = Math.max(score, evaluated.score);
    } catch {
      /* keep the client-reported verdict */
    }
    const participant = state.room.updateIntegrity(state.participant.id, status);
    if (participant) state.participant = participant;
    const payload: ServerMessage = {
      type: 'integrity',
      participantId: state.participant.id,
      status,
      score,
      flags,
      ts: Date.now(),
    };
    state.room.broadcast(payload, {});
    if (status === 'suspicious') {
      audit(state, {
        type: 'integrity.flagged',
        severity: 'warn',
        tenantId: state.room.tenantId,
        roomId: state.room.id,
        participantId: state.participant.id,
        ip: state.ip,
        country: state.country,
        message: `Participant flagged by media-integrity heuristics (score ${score})`,
        details: { score, flags },
      });
      services.webhooks.emit(
        'security.event',
        { tenantId: state.room.tenantId, roomId: state.room.id },
        { kind: 'integrity.flagged', participantId: state.participant.id, score, flags },
      );
      if (config.security.mediaIntegrity.autoMuteOnHighRisk) {
        const updated = state.room.updateState(state.participant.id, { mic: 'off' });
        if (updated) {
          state.participant.state = updated;
          state.room.broadcast({
            type: 'state',
            participantId: state.participant.id,
            state: { mic: 'off' },
          });
        }
      }
    }
  };

  const evaluateClientIntegrity = (
    config: TenantConfig,
    message: Extract<ClientMessage, { type: 'integrity' }>,
  ): MediaIntegrityResult => {
    const flags = message.flags ?? [];
    return evaluateIntegrity(config, {
      ...(typeof message.score === 'number' ? { frameTimingRegularity: message.score } : {}),
      ...(flags.includes('liveness_failed') ? { livenessPassed: false } : {}),
      ...(flags.includes('no_face') ? { faceDetected: false } : {}),
      externalConfigured: Boolean(config.security.mediaIntegrity.externalProvider),
    });
  };

  const runAnalysis = async (room: Room, trigger: 'batch' | 'request' | 'admin'): Promise<void> => {
    await runRoomAnalysis({
      room,
      getConfig: () => roomConfig(room, tenants.getConfig(room.tenantId)),
      pipeline: analysis,
      trigger,
      logger,
      audit: (entry) => safeAudit(logger, services.audit, entry),
      webhooks: services.webhooks,
      notify: (event: NotificationEvent) => providers.notify(event),
    });
  };

  const scheduleAnalysis = (room: Room, trigger: 'batch' | 'request' | 'admin'): void => {
    const existing = roomStates.get(room.id);
    if (existing?.analysisRunning) return;
    if (existing) existing.analysisRunning = true;
    else roomStates.set(room.id, { analysisRunning: true });
    void runAnalysis(room, trigger)
      .catch((error: unknown) => {
        logger.warn('analysis pipeline failed', { roomId: room.id, error: String(error) });
      })
      .finally(() => {
        roomStates.delete(room.id);
      });
  };

  // Analysis concurrency is tracked per room, not per socket.
  const roomStates = new Map<string, { analysisRunning: boolean }>();

  const handleAssistantQuery = async (
    state: SocketState,
    message: Extract<ClientMessage, { type: 'assistant-query' }>,
  ): Promise<void> => {
    const config = roomConfig(state.room, tenants.getConfig(state.room.tenantId));
    const access = knowledgeAccessOf({
      config,
      role: state.participant.role,
      userId: state.participant.id,
      tokenPermissions: state.tokenPermissions,
      ...(state.roleId ? { roleId: state.roleId } : {}),
    });
    const deny = (error: string, answer: string): void => {
      sendFrame(state.ws, {
        type: 'assistant-answer',
        id: message.id,
        answer,
        citations: [],
        error,
        ts: Date.now(),
      });
      audit(state, {
        type: 'knowledge.denied',
        severity: 'warn',
        tenantId: state.room.tenantId,
        roomId: state.room.id,
        participantId: state.participant.id,
        ip: state.ip,
        message: `Knowledge query denied: ${error}`,
        details: { reason: access.reason ?? error },
      });
    };
    const configurationIssue = knowledgeConfigurationIssue(config, env);
    if (configurationIssue) {
      deny('knowledge_not_configured', 'Ассистент знаний не настроен. Обратитесь к администратору компании.');
      return;
    }
    if (!access.allowed) {
      deny('forbidden', access.denyMessage ?? 'Knowledge assistant is not available to you.');
      return;
    }
    const now = Date.now();
    state.assistantTimestamps = state.assistantTimestamps.filter((ts) => now - ts < ASSISTANT_WINDOW_MS);
    if (state.assistantTimestamps.length >= MAX_ASSISTANT_QUERIES_PER_MIN) {
      deny('rate_limited', 'Too many questions. Please wait a minute.');
      return;
    }
    state.assistantTimestamps.push(now);

    const outcome = await services.knowledge.ask({
      config,
      tenantId: state.room.tenantId,
      question: message.question,
      role: state.participant.role,
      userId: state.participant.id,
      participantId: state.participant.id,
      participantName: state.participant.name,
      roomId: state.room.id,
      roomName: state.room.name,
      ...(state.locale ? { locale: state.locale } : {}),
    });
    if (!outcome.ok) {
      sendFrame(state.ws, {
        type: 'assistant-answer',
        id: message.id,
        answer: 'Knowledge assistant is temporarily unavailable.',
        citations: [],
        error: outcome.retryable ? 'unavailable' : 'internal_error',
        ts: Date.now(),
      });
      audit(state, {
        type: 'knowledge.denied',
        severity: 'warn',
        tenantId: state.room.tenantId,
        roomId: state.room.id,
        participantId: state.participant.id,
        message: `Knowledge query failed: ${outcome.error}`,
        details: { error: outcome.error },
      });
      return;
    }
    const response = outcome.response;
    const maxChars = config.session.knowledgeAgent.maxAnswerChars;
    const answer = response.answer.slice(0, maxChars);
    const citations = config.session.knowledgeAgent.citations ? response.citations : [];
    sendFrame(state.ws, {
      type: 'assistant-answer',
      id: message.id,
      answer,
      citations,
      ...(response.confidence !== undefined ? { confidence: response.confidence } : {}),
      ...(response.refused ? { error: 'refused' } : {}),
      ts: Date.now(),
    });
    audit(state, {
      type: 'knowledge.query',
      severity: 'info',
      tenantId: state.room.tenantId,
      roomId: state.room.id,
      participantId: state.participant.id,
      ip: state.ip,
      message: 'Knowledge query answered',
      details: { provider: outcome.provider, citations: citations.length, refused: Boolean(response.refused) },
    });
    services.webhooks.emit(
      'knowledge.answer',
      { tenantId: state.room.tenantId, roomId: state.room.id },
      {
        question: message.question.slice(0, 500),
        answer: answer.slice(0, 500),
        citations: citations.length,
        refused: Boolean(response.refused),
      },
    );
  };

  const handleLocation = (state: SocketState, message: Extract<ClientMessage, { type: 'location' }>): void => {
    const config = tenants.getConfig(state.room.tenantId);
    if (!config.security.geo.gpsEnabled) {
      sendError(state.ws, 'unauthorized', 'Device geolocation is disabled for this tenant');
      return;
    }
    // The zod schema already enforces `consent: true`; double-check for clarity.
    if (config.security.geo.requireConsent && message.consent !== true) {
      sendError(state.ws, 'unauthorized', 'Location consent is required');
      return;
    }
    const ts = Date.now();
    // Coordinates stay server-side (admin API) — only a coarse location is broadcast.
    state.room.setGpsLocation(state.participant.id, {
      lat: message.lat,
      lon: message.lon,
      ...(message.accuracyM !== undefined ? { accuracyM: message.accuracyM } : {}),
      ts,
    });
    const previous = state.participant.location;
    const location: ParticipantLocation = {
      source: 'gps',
      ...(message.accuracyM !== undefined ? { accuracyM: message.accuracyM } : {}),
      ...(previous?.country ? { country: previous.country } : {}),
      ...(previous?.city ? { city: previous.city } : {}),
      ...(previous?.vpnSuspected ? { vpnSuspected: true } : {}),
    };
    state.participant.location = location;
    state.room.broadcast({ type: 'location', participantId: state.participant.id, location, ts });
    audit(state, {
      type: 'session.bound',
      severity: 'info',
      tenantId: state.room.tenantId,
      roomId: state.room.id,
      participantId: state.participant.id,
      ip: state.ip,
      message: 'Participant shared a consent-based GPS location',
      details: { kind: 'location.updated', accuracyM: message.accuracyM ?? null },
    });
  };

  /* --------------------- whiteboard / annotations (P2) --------------------- */

  const canUse = (state: SocketState, config: TenantConfig, feature: FeatureKey): boolean =>
    canUseFeature(
      {
        config,
        role: state.participant.role,
        userId: state.participant.id,
        tokenPermissions: state.tokenPermissions,
        ...(state.roleId ? { roleId: state.roleId } : {}),
      },
      feature,
    );

  const isManager = (state: SocketState): boolean =>
    state.participant.role === 'host' || state.participant.role === 'moderator';

  const authorOf = (state: SocketState): WhiteboardAuthor => ({
    id: state.participant.id,
    name: state.participant.name,
    role: state.participant.role,
  });

  const whiteboardSnapshotMessage = (
    state: SocketState,
    reason: import('@agil/protocol').WhiteboardSyncReason,
  ): ServerMessage => ({
    type: 'whiteboard.sync',
    roomId: state.room.id,
    snapshot: state.room.whiteboard.snapshot(),
    reason,
    ts: Date.now(),
  });

  const handleWhiteboardOpen = (state: SocketState): void => {
    const config = roomConfig(state.room, tenants.getConfig(state.room.tenantId));
    if (!config.features.whiteboard || !canUse(state, config, 'whiteboard')) {
      sendError(state.ws, 'unauthorized', 'Whiteboard is disabled for this participant');
      return;
    }
    if (state.room.whiteboard.locked && !isManager(state)) {
      sendError(state.ws, 'unauthorized', 'The whiteboard was closed by the host');
      return;
    }
    const snapshot = state.room.whiteboard.openBoard();
    const by = authorOf(state);
    if (snapshot.changed) {
      state.room.broadcast({ type: 'whiteboard.open', roomId: state.room.id, by, ts: Date.now() });
      state.room.broadcast({ type: 'whiteboard.sync', roomId: state.room.id, snapshot: snapshot.snapshot, reason: 'open', ts: Date.now() });
      audit(state, {
        type: 'whiteboard.opened',
        severity: 'info',
        tenantId: state.room.tenantId,
        roomId: state.room.id,
        participantId: state.participant.id,
        ip: state.ip,
        message: 'Whiteboard opened',
        details: { role: state.participant.role },
      });
    } else {
      sendFrame(state.ws, whiteboardSnapshotMessage(state, 'open'));
    }
  };

  const handleWhiteboardClose = (
    state: SocketState,
    message: Extract<ClientMessage, { type: 'whiteboard.close' }>,
  ): void => {
    const config = roomConfig(state.room, tenants.getConfig(state.room.tenantId));
    if (!config.features.whiteboard || !canUse(state, config, 'whiteboard')) {
      sendError(state.ws, 'unauthorized', 'Whiteboard is disabled for this participant');
      return;
    }
    if (!isManager(state)) {
      sendError(state.ws, 'unauthorized', 'Only a host or moderator can close the whiteboard');
      return;
    }
    const reason = (message.reason ?? '').trim().slice(0, 120) || 'closed_by_host';
    const { snapshot } = state.room.whiteboard.closeBoard();
    state.room.broadcast({
      type: 'whiteboard.close',
      roomId: state.room.id,
      by: authorOf(state),
      reason,
      ts: Date.now(),
    });
    state.room.broadcast({ type: 'whiteboard.sync', roomId: state.room.id, snapshot, reason: 'close', ts: Date.now() });
    audit(state, {
      type: 'whiteboard.closed',
      severity: 'warn',
      tenantId: state.room.tenantId,
      roomId: state.room.id,
      participantId: state.participant.id,
      ip: state.ip,
      message: 'Whiteboard closed by a moderator',
      details: { reason, strokes: snapshot.strokes.length },
    });
  };

  const handleWhiteboardStroke = (
    state: SocketState,
    message: Extract<ClientMessage, { type: 'whiteboard.stroke' }>,
  ): void => {
    const config = roomConfig(state.room, tenants.getConfig(state.room.tenantId));
    if (!config.features.whiteboard || !canUse(state, config, 'whiteboard')) {
      sendError(state.ws, 'unauthorized', 'Whiteboard is disabled for this participant');
      return;
    }
    const problem = whiteboardStrokeProblem(message);
    if (problem) {
      sendError(state.ws, 'bad_request', `Invalid whiteboard stroke: ${problem}`);
      return;
    }
    if (message.tool === 'clear' || message.tool === 'undo') {
      // Bulk destructive actions are manager-only; undo only removes the
      // caller's own last stroke, so every participant may use it.
      if (message.tool === 'clear') {
        if (!isManager(state)) {
          sendError(state.ws, 'unauthorized', 'Only a host or moderator can clear the whiteboard');
          return;
        }
        const cleared = state.room.whiteboard.clear();
        if (cleared.changed) {
          audit(state, {
            type: 'whiteboard.cleared',
            severity: 'warn',
            tenantId: state.room.tenantId,
            roomId: state.room.id,
            participantId: state.participant.id,
            ip: state.ip,
            message: 'Whiteboard cleared by a moderator',
            details: { removed: cleared.removed },
          });
        }
        state.room.broadcast({
          type: 'whiteboard.sync',
          roomId: state.room.id,
          snapshot: cleared.snapshot,
          reason: 'clear',
          ts: Date.now(),
        });
        return;
      }
      const undone = state.room.whiteboard.undo(state.participant.id);
      state.room.broadcast({
        type: 'whiteboard.sync',
        roomId: state.room.id,
        snapshot: undone.snapshot,
        reason: 'undo',
        ts: Date.now(),
      });
      return;
    }
    if (state.room.whiteboard.locked && !isManager(state)) {
      sendError(state.ws, 'unauthorized', 'The whiteboard was closed by the host');
      return;
    }
    const wasOpen = state.room.whiteboard.open;
    if (!wasOpen) state.room.whiteboard.openBoard();
    const result = state.room.whiteboard.addStroke(
      {
        ...(message.id ? { id: message.id } : {}),
        tool: message.tool,
        color: message.color ?? WHITEBOARD_DEFAULT_COLOR,
        width: message.width ?? WHITEBOARD_DEFAULT_WIDTH,
        points: message.points ?? [],
      },
      authorOf(state),
    );
    if (!result.ok || !result.stroke) {
      sendError(state.ws, 'bad_request', `Whiteboard stroke rejected: ${result.reason ?? 'invalid'}`);
      return;
    }
    if (result.duplicate) {
      // Retry after a reconnect/queue replay: ack with the stored stroke only.
      sendFrame(state.ws, whiteboardSnapshotMessage(state, 'request'));
      return;
    }
    if (!wasOpen) {
      // Drawing on an idle board opens it; tell every client explicitly so the
      // local `open` flag matches the server (not just the stroke stream).
      state.room.broadcast({ type: 'whiteboard.open', roomId: state.room.id, by: authorOf(state), ts: Date.now() });
    }
    state.room.broadcast({
      type: 'whiteboard.stroke',
      roomId: state.room.id,
      stroke: result.stroke,
      revision: state.room.whiteboard.snapshot().revision,
      ts: Date.now(),
      ...(result.trimmed ? { trimmed: true } : {}),
    });
    if (result.trimmed) {
      // Older strokes were evicted: every client needs the trimmed snapshot.
      state.room.broadcast(whiteboardSnapshotMessage(state, 'trim'));
    }
  };

  const syncAnnotationPresenter = (room: Room): void => {
    const config = roomConfig(room, tenants.getConfig(room.tenantId));
    const result = room.syncScreenPresenter();
    if (!result.changed) return;
    if (config.features.annotations) {
      room.broadcast({
        type: 'annotation.clear',
        roomId: room.id,
        presenterId: result.presenterId,
        reason: result.presenterId ? 'presenter_changed' : 'share_ended',
        ts: Date.now(),
      });
      room.broadcast({
        type: 'annotation.sync',
        roomId: room.id,
        snapshot: room.annotations.snapshot(),
        ts: Date.now(),
      });
    }
  };

  const handleAnnotationStroke = (
    state: SocketState,
    message: Extract<ClientMessage, { type: 'annotation.stroke' }>,
  ): void => {
    const config = roomConfig(state.room, tenants.getConfig(state.room.tenantId));
    if (!config.features.annotations || !canUse(state, config, 'annotations')) {
      sendError(state.ws, 'unauthorized', 'Annotations are disabled for this participant');
      return;
    }
    if (!state.room.annotations.presenterId) {
      sendError(state.ws, 'bad_request', 'No active screen share to annotate');
      return;
    }
    const result = state.room.annotations.addStroke(
      {
        ...(message.id ? { id: message.id } : {}),
        tool: message.tool,
        color: message.color ?? WHITEBOARD_DEFAULT_COLOR,
        width: message.width ?? WHITEBOARD_DEFAULT_WIDTH,
        points: message.points,
      },
      authorOf(state),
    );
    if (!result.ok || !result.stroke) {
      sendError(state.ws, 'bad_request', `Annotation stroke rejected: ${result.reason ?? 'invalid'}`);
      return;
    }
    if (result.duplicate) {
      sendFrame(state.ws, {
        type: 'annotation.sync',
        roomId: state.room.id,
        snapshot: state.room.annotations.snapshot(),
        ts: Date.now(),
      });
      return;
    }
    state.room.broadcast({
      type: 'annotation.stroke',
      roomId: state.room.id,
      stroke: result.stroke,
      revision: state.room.annotations.snapshot().revision,
      ts: Date.now(),
      ...(result.trimmed ? { trimmed: true } : {}),
    });
    if (result.trimmed) {
      state.room.broadcast({
        type: 'annotation.sync',
        roomId: state.room.id,
        snapshot: state.room.annotations.snapshot(),
        ts: Date.now(),
      });
    }
  };

  const handleAnnotationClear = (state: SocketState): void => {
    const config = roomConfig(state.room, tenants.getConfig(state.room.tenantId));
    if (!config.features.annotations || !canUse(state, config, 'annotations')) {
      sendError(state.ws, 'unauthorized', 'Annotations are disabled for this participant');
      return;
    }
    const presenterId = state.room.annotations.presenterId;
    if (!isManager(state) && presenterId !== state.participant.id) {
      sendError(state.ws, 'unauthorized', 'Only the presenter or a moderator can clear annotations');
      return;
    }
    const result = state.room.annotations.clear();
    state.room.broadcast({
      type: 'annotation.clear',
      roomId: state.room.id,
      by: authorOf(state),
      presenterId,
      reason: 'moderator',
      ts: Date.now(),
    });
    if (result.changed) {
      audit(state, {
        type: 'annotation.cleared',
        severity: 'info',
        tenantId: state.room.tenantId,
        roomId: state.room.id,
        participantId: state.participant.id,
        ip: state.ip,
        message: 'Screen-share annotations cleared',
        details: { removed: result.removed, presenterId },
      });
    }
  };

  const handleMessage = async (state: SocketState, raw: string): Promise<void> => {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      sendError(state.ws, 'bad_request', `Invalid message: ${parsed.error}`);
      return;
    }
    const message = parsed.message;
    switch (message.type) {
      case 'hello': {
        if (message.name) {
          state.participant.name = message.name;
          state.participant = state.room.updateParticipant(state.participant.id, { name: message.name }) ?? state.participant;
        }
        if (message.locale) state.locale = message.locale;
        state.room.broadcast({ type: 'room', room: state.room.info(), participants: state.room.participants() });
        return;
      }
      case 'sdp': {
        const target = state.room.member(message.to);
        if (!target) return relayUnknownPeer(state, message.to);
        target.connection.send({ type: 'sdp', from: state.participant.id, description: message.description });
        return;
      }
      case 'ice': {
        const target = state.room.member(message.to);
        if (!target) return relayUnknownPeer(state, message.to);
        target.connection.send({ type: 'ice', from: state.participant.id, candidate: message.candidate });
        return;
      }
      case 'video-upgrade': {
        const { room, participant } = state;
        if (room.mode !== 'direct' || room.mediaMode !== 'mesh' || message.to === participant.id) return;
        const target = room.member(message.to);
        if (!target) return relayUnknownPeer(state, message.to);
        const current = videoUpgrades.get(room);
        const now = Date.now();
        if (message.action === 'request') {
          if (current && current.expiresAt > now && room.member(current.from) && room.member(current.to)) return;
          videoUpgrades.set(room, { from: participant.id, to: message.to, requestId: message.requestId, expiresAt: now + VIDEO_UPGRADE_TTL_MS });
        } else {
          if (!current || current.expiresAt <= now || current.requestId !== message.requestId ||
              current.from !== message.to || current.to !== participant.id) return;
          videoUpgrades.delete(room);
        }
        target.connection.send({ type: 'video-upgrade', from: participant.id, requestId: message.requestId, action: message.action });
        if (message.action === 'accept') {
          room.member(participant.id)?.connection.send({ type: 'video-upgrade', from: message.to, requestId: message.requestId, action: 'accept' });
        }
        return;
      }
      case 'chat':
        return handleChat(state, message);
      case 'state': {
        const patch = { ...message.state };
        const changesRecording = patch.recording !== undefined || patch.recordingStartedAt !== undefined;
        if (patch.screen || patch.handRaised || changesRecording) {
          const config = roomConfig(state.room, tenants.getConfig(state.room.tenantId));
          const stopping = patch.recording === false && state.participant.state.recording === true;
          if (changesRecording && !stopping && (!browserRecordingEnabled(config) || !canUse(state, config, 'recording'))) {
            delete patch.recording;
            delete patch.recordingStartedAt;
            sendError(state.ws, 'unauthorized', 'Recording is disabled for this participant');
          }
          if (patch.screen && (!config.session.screenShare.enabled || !canUse(state, config, 'screenShare'))) delete patch.screen;
          if (patch.handRaised && !canUse(state, config, 'handRaise')) delete patch.handRaised;
        }
        if (Object.keys(patch).length === 0) return;
        const updated = state.room.updateState(state.participant.id, patch);
        if (updated) state.participant.state = updated;
        broadcastToRoom(state, { type: 'state', participantId: state.participant.id, state: patch });
        // Starting/stopping a screen share resets the annotation layer.
        if (patch.screen !== undefined) syncAnnotationPresenter(state.room);
        return;
      }
      case 'reaction': {
        const config = roomConfig(state.room, tenants.getConfig(state.room.tenantId));
        if (!canUse(state, config, 'reactions')) {
          sendError(state.ws, 'unauthorized', 'Reactions are disabled');
          return;
        }
        const ts = message.ts ?? Date.now();
        state.room.broadcast({ type: 'reaction', participantId: state.participant.id, emoji: message.emoji, ts }, {});
        return;
      }
      case 'caption':
        return handleCaption(state, message);
      case 'conversation-review.consent': {
        if (state.detached) return;
        const connection = state.room.member(state.participant.id)?.connection;
        if (connection) services.conversationReview.consent(state.room, connection, message.revision, message.allowed);
        return;
      }
      case 'integrity':
        return handleIntegrity(state, message);
      case 'location':
        return handleLocation(state, message);
      case 'whiteboard.open':
        return handleWhiteboardOpen(state);
      case 'whiteboard.close':
        return handleWhiteboardClose(state, message);
      case 'whiteboard.stroke':
        return handleWhiteboardStroke(state, message);
      case 'whiteboard.sync': {
        const config = roomConfig(state.room, tenants.getConfig(state.room.tenantId));
        if (!config.features.whiteboard || !canUse(state, config, 'whiteboard')) {
          sendError(state.ws, 'unauthorized', 'Whiteboard is disabled for this participant');
          return;
        }
        sendFrame(state.ws, whiteboardSnapshotMessage(state, 'request'));
        return;
      }
      case 'annotation.stroke':
        return handleAnnotationStroke(state, message);
      case 'annotation.clear':
        return handleAnnotationClear(state);
      case 'ping': {
        const now = Date.now();
        const pong: Extract<ServerMessage, { type: 'pong' }> = { type: 'pong', ts: message.ts };
        if (message.refreshSfu) {
          const { room, participant } = state;
          pong.sfuMedia = !state.detached && !room.closed && room.member(participant.id)
            ? buildSfuMedia(env, chatConfig(state), {
              tenantId: room.tenantId, roomId: room.id, participantId: participant.id,
              name: participant.name, role: participant.role, ttlSec: env.tokenTtlSec,
              durationDeadlineAt: room.durationDeadlineAt, mediaMode: room.mediaMode, sfuNodeId: room.sfuNodeId,
            }) : null;
        }
        if (message.refreshIce && state.iceRefreshAt !== undefined && now >= state.iceRefreshAt) {
          const ice = resolveParticipantIce(env, chatConfig(state).scale, {
            tenantId: state.room.tenantId, roomId: state.room.id, participantId: state.participant.id,
          }, now, isTurnNodeAvailable, readTurnNode);
          state.iceRefreshAt = ice.refreshAt;
          pong.iceServers = ice.iceServers;
        }
        sendFrame(state.ws, pong);
        return;
      }
      case 'history': {
        if (!canReadChat(state)) {
          sendError(state.ws, 'unauthorized', 'Chat is not allowed for this participant');
          return;
        }
        let messages: ChatMessage[];
        try {
          messages = await providers.chatHistory(state.room.tenantId, state.room.id, message.limit ?? 100);
        } catch (error) {
          if (!(error instanceof ChatStorageUnavailable)) throw error;
          sendError(state.ws, 'chat_storage_unavailable', error.message);
          return;
        }
        if (!canReadChat(state)) {
          sendError(state.ws, 'unauthorized', 'Chat is not allowed for this participant');
          return;
        }
        sendFrame(state.ws, { type: 'chat-history', messages });
        return;
      }
      case 'analysis-request': {
        const config = roomConfig(state.room, tenants.getConfig(state.room.tenantId));
        if (!isManager(state) || !canUse(state, config, 'aiCompliance') || config.security.e2ee) {
          sendError(state.ws, 'unauthorized', 'Analysis is unavailable for this participant');
          return;
        }
        scheduleAnalysis(state.room, 'request');
        return;
      }
      case 'assistant-query':
        return handleAssistantQuery(state, message);
      case 'bye': {
        state.resumeDisabled = true;
        clearResumeTimer(state.room.id, state.participant.id);
        sendFrame(state.ws, { type: 'bye', reason: 'client_bye' });
        state.ws.close(1000, 'client_bye');
        return;
      }
      default:
        return;
    }
  };

  /* -------------------------- connection lifecycle -------------------------- */

  /** Fires the departure side effects exactly once, after the member is gone. */
  const announceDeparture = (
    room: Room,
    participant: Participant,
    reason: string,
    ip?: string,
    ipHash?: string,
  ): void => {
    // If the presenter left, annotations belong to nobody: wipe them.
    syncAnnotationPresenter(room);
    room.broadcast({ type: 'peer-left', participantId: participant.id, reason });
    if (room.mediaMode !== 'mesh' && (reason === 'reconnect_timeout' || reason === 'resume_expired' || reason === 'disconnected')) {
      const context = { tenantId: room.tenantId, roomId: room.id, participantId: participant.id };
      const key = resumeKey(room.id, participant.id);
      const cleanup = removeSfuParticipant(env, room.tenantId, room.id, participant.id).then((removed) => {
        if (!removed) logger.warn('LiveKit control endpoint is not configured for participant removal', context);
      }).catch(() => logger.warn('LiveKit participant could not be removed after signaling departure', context))
        .finally(() => pendingSfuDepartures.delete(key));
      pendingSfuDepartures.set(key, cleanup);
    }
    safeAudit(logger, services.audit, {
      type: 'call.ended',
      severity: 'info',
      tenantId: room.tenantId,
      roomId: room.id,
      participantId: participant.id,
      ...(ip ? { ip } : {}),
      ...(ipHash ? { ipHash } : {}),
      message: `Participant left (${reason})`,
      details: { reason, durationSec: Math.round((Date.now() - participant.joinedAt) / 1000) },
    });
    services.webhooks.emit(
      'participant.left',
      { tenantId: room.tenantId, roomId: room.id },
      { participantId: participant.id, name: participant.name, reason },
    );
    providers.notify({
      type: 'participant.left',
      tenantId: room.tenantId,
      roomId: room.id,
      message: `${participant.name} left the call`,
      data: { participantId: participant.id, reason },
    });
    if (room.participantCount === 0) {
      services.webhooks.emit('room.closed', { tenantId: room.tenantId, roomId: room.id }, {
        reason: 'empty',
      });
      providers.notify({
        type: 'room.closed',
        tenantId: room.tenantId,
        roomId: room.id,
        message: 'The call ended (room is empty)',
        data: { reason: 'empty' },
      });
    }
  };

  /** Removes a member and announces the departure (no grace lease). */
  const finalizeDeparture = (state: SocketState, reason: string): void => {
    clearResumeTimer(state.room.id, state.participant.id);
    const member = state.room.removeMember(state.participant.id);
    if (!member) return;
    announceDeparture(state.room, member.participant, reason, state.ip, state.ipHash);
  };

  const removeState = (state: SocketState, reason: string): void => {
    if (!sockets.has(state.ws)) return;
    sockets.delete(state.ws);
    releaseTenantSubscription(state.room.tenantId);
    finalizeDeparture(state, reason);
  };

  /**
   * Holds the participant in the room for the resume grace window instead of
   * announcing `peer-left`: peers see `presence: reconnecting`, the member
   * keeps its slot and permissions, and a reconnect with the resume token
   * swaps the socket back without a duplicate join (docs/call-continuity.md).
   */
  const holdForResume = (state: SocketState): void => {
    const room = state.room;
    const participantId = state.participant.id;
    sockets.delete(state.ws);
    releaseTenantSubscription(room.tenantId);
    if (!continuity || !continuity.canHoldResume(room, participantId)) {
      finalizeDeparture(state, 'disconnected');
      return;
    }
    const holdMs = Math.max(1, continuity.resumeGraceSec) * 1000;
    // The seat is reserved for exactly the grace window: a blip must not let a
    // newcomer take the slot, and restored snapshot ghosts never reserve one
    // (docs/call-continuity.md).
    if (!room.markReconnecting(participantId, { seatReservedUntil: Date.now() + holdMs })) {
      finalizeDeparture(state, 'disconnected');
      return;
    }
    room.broadcast({ type: 'presence', participantId, presence: 'reconnecting', ts: Date.now() });
    clearResumeTimer(room.id, participantId);
    const timer = setTimeout(() => {
      resumeTimers.delete(resumeKey(room.id, participantId));
      const member = room.member(participantId);
      // A resume already swapped the connection (or the room closed).
      if (!member || !member.connection.offline) return;
      finalizeDeparture(state, 'reconnect_timeout');
    }, holdMs);
    timer.unref?.();
    resumeTimers.set(resumeKey(room.id, participantId), timer);
  };

  /**
   * Evicts restored/offline participants whose resume token expired without a
   * reconnect. Grace-held members are owned by their timer and skipped.
   */
  const sweepStaleOfflineMembers = (): void => {
    if (!continuity?.enabled) return;
    const now = Date.now();
    for (const room of rooms.list()) {
      for (const participant of room.participants()) {
        if (participant.presence !== 'reconnecting') continue;
        const member = room.member(participant.id);
        if (!member?.connection.offline) continue;
        if (resumeTimers.has(resumeKey(room.id, participant.id))) continue;
        const expiresAt = member.connection.resumeExpiresAt ?? 0;
        if (expiresAt > now) continue;
        room.removeMember(participant.id);
        announceDeparture(room, participant, 'resume_expired');
        logger.info('offline participant evicted after its resume window', {
          roomId: room.id,
          participantId: participant.id,
        });
      }
    }
  };

  const registerConnection = async (ws: WebSocket, req: IncomingMessage, url: URL): Promise<void> => {
    const headers = req.headers as HeaderMap;
    const ip = resolveClientIp({
      headers,
      remoteAddress: req.socket.remoteAddress,
      trustProxy: env.trustProxy,
    });
    const ipHash = hashIp(ip, env.ipSalt);
    const headerCountry = env.trustProxy ? countryFromHeaders(headers) : undefined;

    const fail = (code: import('@agil/protocol').ServerErrorCode, message: string): void => {
      sendError(ws, code, message, true);
      try {
        ws.close(1008, message.slice(0, 120));
      } catch {
      }
    };

    const auth = authenticate(url, req.headers['sec-websocket-protocol']);
    if (!auth.ok) {
      fail(auth.code, auth.message);
      return;
    }
    const identity = auth.identity;
    const room = rooms.get(identity.roomId);
    if (!room) {
      fail('unauthorized', 'Room not found');
      return;
    }
    if (room.tenantId !== identity.tenantId) {
      fail('unauthorized', 'Token does not belong to this room');
      return;
    }
    if (!room.allowsParticipant(identity.claims?.sub)) {
      fail('unauthorized', 'A room token for an allowed participant is required');
      return;
    }
    // Browser-origin allowlist (cross-site WebSocket hijacking defense): checked
    // before any room state is touched, with the tenant resolved from the token.
    if (env.wsOriginEnforce) {
      const customDomain = domains.getForTenant(room.tenantId);
      const originDecision = evaluateWsOrigin({
        env,
        config: tenants.getConfig(room.tenantId),
        ...(customDomain && customDomain.status === 'verified' ? { customDomain: customDomain.domain } : {}),
        origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
        tokenPresent: identity.claims !== null,
      });
      if (!originDecision.allowed) {
        fail('unauthorized', originDecision.reason);
        return;
      }
    }
    if (identity.anonymous) {
      const mode = tenants.getConfig(room.tenantId).security.publicAbuseMode ?? env.publicAbuseDefaultMode;
      if (!checkPublicAbuse(services, logger, { mode, action: 'room.join', tenantId: room.tenantId, ipHash }).allowed) {
        fail('rate_limited', PUBLIC_ABUSE_MESSAGE);
        return;
      }
    }
    // Reissuing the same participant identity must not race the old SFU kick.
    const pendingDeparture = pendingSfuDepartures.get(resumeKey(room.id, identity.participantId));
    if (pendingDeparture) {
      await pendingDeparture;
      if (!isOpen(ws)) return;
    }
    const config = roomConfig(room, tenants.getConfig(room.tenantId));
    if (room.locked) {
      fail('room_locked', 'Room is locked');
      return;
    }
    // A resume offers the short-lived capability from the previous `welcome`
    // in the handshake subprotocols. It only works for the same tenant + room +
    // participant and only when the stored hash still matches.
    const resumeRaw = resumeTokenFromSubprotocols(req.headers['sec-websocket-protocol']);
    const resumeRequested = Boolean(resumeRaw) || url.searchParams.get(WS_RESUME_QUERY) === '1';
    const existingMember = room.member(identity.participantId);
    const resumeGranted = Boolean(
      existingMember && continuity?.verifyResume(room, identity.participantId, resumeRaw),
    );
    const replacing = existingMember;
    // Same capacity boundary as the REST join: room limit, tenant scale limit,
    // capacity-profile participants and SFU maxParticipants. Only seated
    // participants count — restored ghosts do not own a seat until they resume
    // (docs/call-continuity.md).
    const capacity = roomCapacityInfo(env, config, room.mediaMode, room.maxParticipants);
    if (room.seatedParticipantCount() >= capacity.effectiveMaxParticipants && !replacing) {
      fail('room_full', capacityLimitMessage(capacity));
      return;
    }
    // Billing quota (opt-in, default free/off). A reconnect replacing an
    // existing participant never counts against the participant quota.
    if (!replacing) {
      const billing = tenants.getConfig(room.tenantId).billing;
      const billingCounts = tenantUsageCounts(rooms, room.tenantId);
      const decision = evaluateJoinQuota({
        billing,
        usage: services.billing.getUsage(room.tenantId),
        liveMinutes: services.billing.liveMinutes(room.tenantId),
        activeParticipants: billingCounts.activeParticipants,
      });
      if (!decision.allowed) {
        safeAudit(logger, services.audit, {
          type: 'join.denied',
          severity: 'warn',
          tenantId: room.tenantId,
          roomId: room.id,
          ip,
          message: 'WebSocket join blocked by billing quota',
          details: {
            code: 'billing_quota_exceeded',
            metric: decision.blocked?.metric,
            used: decision.blocked?.used,
            limit: decision.blocked?.limit,
          },
        });
        fail('quota_exceeded', decision.blocked?.message ?? 'Billing quota exceeded');
        return;
      }
    }
    if (!identity.claims && room.passwordHash) {
      fail('unauthorized', 'Room password is required (join via POST /v1/rooms/:id/join)');
      return;
    }
    const geo = await resolveRequestGeo(env, ip, headerCountry);
    const resolvedCountry = geo.country ?? headerCountry;
    if (config.security.geo.enabled) {
      try {
        if (config.security.geo.blockVpn && geo.vpn) throw new Error('vpn_blocked');
        assertGeo(resolvedCountry, config);
      } catch {
        safeAudit(logger, services.audit, {
          type: 'geo.blocked',
          severity: 'warn',
          tenantId: room.tenantId,
          roomId: room.id,
          ip,
          country: resolvedCountry,
          message: `WebSocket join blocked by geo policy (${resolvedCountry ?? 'unknown'})`,
          details: { country: resolvedCountry, vpn: geo.vpn, source: geo.source },
        });
        services.webhooks.emit('security.event', { tenantId: room.tenantId, roomId: room.id }, {
          kind: 'geo.blocked',
          country: resolvedCountry ?? null,
          vpn: geo.vpn,
        });
        fail('unauthorized', 'geo_blocked');
        return;
      }
    }
    const location: ParticipantLocation = {
      source: resolvedCountry ? 'ip' : 'none',
      ...(resolvedCountry ? { country: resolvedCountry } : {}),
      ...(geo.city ? { city: geo.city } : {}),
      ...(geo.vpn ? { vpnSuspected: true } : {}),
    };

    const participantRoleId = claimsRoleId(identity.claims);
    const access = accessOf({
      config,
      role: identity.role,
      userId: identity.participantId,
      tokenPermissions: claimsPermissions(identity.claims),
      ...(participantRoleId ? { roleId: participantRoleId } : {}),
    });
    const permissions = access.allowed;
    const participant: Participant = {
      id: identity.participantId,
      name: identity.name,
      role: identity.role,
      joinedAt: Date.now(),
      state: defaultState(),
      verified: false,
      integrity: 'unknown',
      permissions,
      ...(access.roleName ? { roleName: access.roleName } : {}),
      location,
      ...(resolvedCountry ? { country: resolvedCountry } : {}),
    };
    // Resume keeps the participant continuous: original join time, last known
    // media state and verification/integrity verdict from before the drop.
    if (resumeGranted && existingMember) {
      participant.joinedAt = existingMember.participant.joinedAt;
      participant.state = { ...existingMember.participant.state };
      participant.verified = existingMember.participant.verified;
      participant.integrity = existingMember.participant.integrity;
    }
    if (!permissions.includes('handRaise')) participant.state.handRaised = false;
    if (rooms.get(room.id) !== room) {
      fail('unauthorized', 'Room not found');
      return;
    }
    participant.presence = 'online';
    const state: SocketState = {
      ws,
      room,
      participant,
      tokenPermissions: claimsPermissions(identity.claims),
      ...(participantRoleId ? { roleId: participantRoleId } : {}),
      ip,
      ipHash,
      ...(headerCountry ? { country: headerCountry } : {}),
      isAlive: true,
      windowStart: Date.now(),
      windowCount: 0,
      violations: 0,
      assistantTimestamps: [],
      detached: false,
      analysisRunning: false,
      resumeCapable: resumeRequested,
      resumeDisabled: false,
    };
    const connection: RoomConnection = {
      send: (message) => {
        if (message.type === 'chat' && !canReadChat(state)) return;
        sendFrame(ws, message);
      },
      close: (code, reason) => {
        state.detached = true;
        try {
          ws.close(code, reason);
        } catch {
        }
      },
      ipHash,
      ...(resumeRequested ? { resumeCapable: true } : {}),
      // Carry the resume history onto the new socket so the rotated token can
      // still fall back to the previous hash if `welcome` is lost in flight.
      ...(resumeGranted && existingMember?.connection.resumeTokenHash
        ? {
            resumeTokenHash: existingMember.connection.resumeTokenHash,
            ...(existingMember.connection.resumeExpiresAt
              ? { resumeExpiresAt: existingMember.connection.resumeExpiresAt }
              : {}),
            ...(existingMember.connection.resumeTokenHashPrev
              ? {
                  resumeTokenHashPrev: existingMember.connection.resumeTokenHashPrev,
                  ...(existingMember.connection.resumeExpiresAtPrev
                    ? { resumeExpiresAtPrev: existingMember.connection.resumeExpiresAtPrev }
                    : {}),
                }
              : {}),
          }
        : {}),
      ...(participantRoleId ? { roleId: participantRoleId } : {}),
      ...(headerCountry ? { country: headerCountry } : {}),
      joinedAt: participant.joinedAt,
    };

    sockets.set(ws, state);
    retainTenantSubscription(room.tenantId);
    // A resume owns the grace lease: cancel it before the member swap so a
    // timer that already fired cannot remove the freshly resumed socket.
    clearResumeTimer(room.id, participant.id);
    let replaced: RoomConnection | null = null;
    let resumed = false;
    if (resumeGranted) {
      const swap = room.resumeMember(participant, connection);
      resumed = swap.resumed;
      replaced = swap.previous;
    }
    if (!resumed) {
      const added = room.addMember(participant, connection);
      replaced = added.replaced;
    }
    if (replaced && !resumed) {
      // A duplicate socket for the same participant replaced a live one. The
      // old socket is detached; peers get a leave/join pair and one tile.
      room.broadcast({
        type: 'peer-left',
        participantId: participant.id,
        reason: 'replaced',
      });
    }

    let historyUnavailable = false;
    const welcomeHistory = canReceiveWelcomeHistory(state)
      ? await providers.chatHistory(room.tenantId, room.id, 200).catch((error: unknown) => {
        if (!(error instanceof ChatStorageUnavailable)) throw error;
        historyUnavailable = true;
        return [];
      })
      : [];
    if (room.closed) return;
    const sfuMedia = buildSfuMedia(env, config, {
      tenantId: room.tenantId,
      roomId: room.id,
      participantId: participant.id,
      name: participant.name,
      role: participant.role,
      ttlSec: env.tokenTtlSec,
      durationDeadlineAt: room.durationDeadlineAt,
      mediaMode: room.mediaMode,
      sfuNodeId: room.sfuNodeId,
    });
    // Only sockets that opted into continuity receive a resume capability; the
    // plain join path (older clients, tests) keeps the close behaviour. A
    // disabled module (`AGIL_CONTINUITY=0`) advertises nothing: no grace lease
    // and `verifyResume` always rejects the token.
    const resume =
      continuity?.enabled && resumeRequested ? continuity.issueResume(room, participant.id, connection) : undefined;
    const ice = resolveParticipantIce(env, config.scale, {
      tenantId: room.tenantId, roomId: room.id, participantId: participant.id,
    }, Date.now(), isTurnNodeAvailable, readTurnNode);
    state.iceRefreshAt = ice.refreshAt;
    const welcome: ServerMessage = {
      type: 'welcome',
      chatAcknowledgements: true,
      self: participant,
      room: room.info(),
      participants: room.participants().filter((candidate) => candidate.id !== participant.id),
      // The client sizes its gallery budget from this profile; the env
      // (`AGIL_SFU_PROFILE`) wins over the stored tenant value.
      config: applySfuCapacityProfile(env, config),
      iceServers: ice.iceServers,
      serverTime: Date.now(),
      history: welcomeHistory.length && canReceiveWelcomeHistory(state) ? welcomeHistory : [],
      // Replay the live collaboration surfaces on join (bounded snapshots).
      ...(config.features.whiteboard ? { whiteboard: room.whiteboard.snapshot() } : {}),
      ...(config.features.annotations ? { annotations: room.annotations.snapshot() } : {}),
      ...(sfuMedia ? { media: sfuMedia } : {}),
      ...(resumed ? { resumed: true } : {}),
      ...(resume ? { resume } : {}),
    };
    sendFrame(ws, welcome);
    const review = services.conversationReview.status(room, connection);
    if (review) sendFrame(ws, review);
    if (historyUnavailable) sendError(ws, 'chat_storage_unavailable', 'Chat history storage is unavailable');
    // Hosts/moderators get the current waiting-room queue immediately.
    if (participant.role === 'host' || participant.role === 'moderator') {
      sendFrame(ws, {
        type: 'lobby.queue',
        requests: room.lobbyList().map((request) => ({
          id: request.id,
          name: request.name,
          ...(request.country ? { country: request.country } : {}),
          createdAt: request.createdAt,
          expiresAt: request.expiresAt,
          status: 'pending' as const,
        })),
      });
    }
    if (resumed) {
      // One continuous participant: peers just flip the presence pill back.
      room.broadcast({ type: 'presence', participantId: participant.id, presence: 'online', ts: Date.now() });
    } else {
      room.broadcast({ type: 'peer-joined', participant }, { except: participant.id });
    }

    if (resumed) {
      safeAudit(logger, services.audit, {
        type: 'session.resumed',
        severity: 'info',
        tenantId: room.tenantId,
        roomId: room.id,
        participantId: participant.id,
        ip,
        country: headerCountry,
        message: `WebSocket session resumed for ${participant.name}`,
        details: { via: 'ws', role: participant.role, participantCount: room.participantCount },
      });
      services.webhooks.emit(
        'participant.joined',
        { tenantId: room.tenantId, roomId: room.id },
        { participantId: participant.id, name: participant.name, role: participant.role, resumed: true },
      );
    } else {
      safeAudit(logger, services.audit, {
        type: 'join.allowed',
        severity: 'info',
        tenantId: room.tenantId,
        roomId: room.id,
        participantId: participant.id,
        ip,
        country: headerCountry,
        message: `WebSocket join allowed for ${participant.name}`,
        details: { via: 'ws', anonymous: identity.anonymous, role: participant.role },
      });
      services.webhooks.emit(
        'participant.joined',
        { tenantId: room.tenantId, roomId: room.id },
        { participantId: participant.id, name: participant.name, role: participant.role },
      );
      providers.notify({
        type: 'participant.joined',
        tenantId: room.tenantId,
        roomId: room.id,
        message: `${participant.name} joined the call`,
        data: { participantId: participant.id, role: participant.role },
      });
    }

    ws.on('message', (data: RawData) => {
      const current = sockets.get(ws);
      if (!current) return;
      const now = Date.now();
      if (now - current.windowStart >= 1000) {
        current.windowStart = now;
        current.windowCount = 0;
      }
      current.windowCount += 1;
      if (current.windowCount > MAX_MESSAGES_PER_SECOND) {
        current.violations += 1;
        sendError(ws, 'rate_limited', 'Too many messages; slow down');
        if (current.violations >= MAX_RATE_VIOLATIONS) {
          sendError(ws, 'rate_limited', 'Too many messages; closing connection', true);
          ws.close(1008, 'rate_limited');
        }
        return;
      }
      const raw = data.toString();
      void handleMessage(current, raw).catch((error: unknown) => {
        logger.warn('ws message handler failed', {
          roomId: current.room.id,
          participantId: current.participant.id,
          error: String(error),
        });
        sendError(ws, 'internal_error', 'Internal error while handling the message');
      });
    });
    ws.on('pong', () => {
      const current = sockets.get(ws);
      if (current) current.isAlive = true;
    });
    ws.on('error', (error) => {
      logger.warn('ws socket error', { roomId: state.room.id, error: error.message });
    });
    ws.on('close', () => {
      const current = sockets.get(ws);
      if (!current) return;
      if (current.detached) {
        sockets.delete(ws);
        releaseTenantSubscription(current.room.tenantId);
        return;
      }
      if (!current.resumeDisabled && current.resumeCapable && continuity?.canHoldResume(current.room, current.participant.id)) {
        holdForResume(current);
        return;
      }
      removeState(current, 'disconnected');
    });
  };

  const assertGeo = (country: string | undefined, config: TenantConfig): void => {
    const policy = config.security.geo;
    if (country) {
      const blocked = policy.blockedCountries.includes(country);
      const allowed = policy.allowedCountries.length > 0;
      if (blocked || (allowed && !policy.allowedCountries.includes(country))) throw new Error('geo_blocked');
      return;
    }
    if (policy.allowedCountries.length > 0) throw new Error('geo_blocked');
  };

  /* ------------------------------ upgrade path ------------------------------ */

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.pathname !== WS_PATH && url.pathname !== `${WS_PATH}/`) {
      socket.write('HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nNot found');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void registerConnection(ws, req, url).catch((error: unknown) => {
        logger.error('ws connection registration failed', { error: String(error) });
        try {
          ws.close(1011, 'internal_error');
        } catch {
        }
      });
    });
  };

  options.httpServer.on('upgrade', onUpgrade);

  heartbeat = setInterval(() => {
    for (const [ws, state] of sockets) {
      if (!state.isAlive) {
        // The close event runs the regular cleanup (peer-left, subscription release).
        try {
          ws.terminate();
        } catch {
        }
        continue;
      }
      state.isAlive = false;
      try {
        ws.ping();
      } catch {
      }
    }
    // Restored/offline members whose resume token expired are evicted here so a
    // `reconnecting` row cannot linger forever (grace-held members own a timer).
    try {
      sweepStaleOfflineMembers();
    } catch (error) {
      logger.warn('offline participant sweep failed', { error: String(error) });
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  return {
    wss,
    clientCount(): number {
      return sockets.size;
    },
    async close(): Promise<void> {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      options.httpServer.off('upgrade', onUpgrade);
      for (const timer of resumeTimers.values()) clearTimeout(timer);
      resumeTimers.clear();
      for (const ws of [...sockets.keys()]) {
        try {
          ws.close(1001, 'server_shutdown');
        } catch {
        }
      }
      for (const subscription of tenantSubscriptions.values()) subscription.unsubscribe();
      tenantSubscriptions.clear();
      sockets.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}
