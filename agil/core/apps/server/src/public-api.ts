/**
 * Public (participant-facing) REST API — contract §4 and §14.
 *
 * Auth model:
 *   - health/ice/public tenant config: no credentials;
 *   - room creation/config/read/delete: `x-api-key`, or anonymous when
 *     `AGIL_ALLOW_ANONYMOUS=1` (demo);
 *   - join: always anonymous+rate-limited, issues the join token;
 *   - files/recordings/STT: `authorization: Bearer <join token>`;
 *   - downloads: signed `?sig=&exp=` URL produced by the security stores.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import {
  createPollSchema,
  featureKeySchema,
  findCustomRole,
  votePollSchema,
  createBreakoutSchema,
  type BreakoutAssignedMessage,
  type BreakoutListResponse,
  type BreakoutPlan,
  type BreakoutRoomInfo,
  type PollListResponse,
  type PollVoteResponse,
  type RoomPoll,
  roomContextSchema,
  roomInfoSchema,
  roleSchema,
  browserRecordingEnabled,
  type ChatPostResponse,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type DomainAskResponse,
  type HostInfoResponse,
  type Participant,
  type FeatureKey,
  type FileRecord,
  type HealthResponse,
  type JoinRoomRequest,
  type JoinRoomResponse,
  type LobbyDecisionResponse,
  type LobbyJoinResponse,
  type LobbyRequestInfo,
  type LobbyRequestsResponse,
  type LobbyStatusResponse,
  type ServerMessage,
  livenessVerifyRequestSchema,
  type LivenessChallengeResponse,
  type LivenessVerifyResponse,
  type RecordingRecord,
  type Role,
  type RoomInfo,
  type TenantConfig,
  type TokenResponse,
  type TranscriptResponse,
} from '@agil/protocol';
import { buildAssistantReply, buildAssistantRequest, callInCallAssistant, assistantAuditEntry } from './assistant.js';
import { egressIdempotencyKey } from './egress-start-ledger.js';
import { readInCallSecurityPolicy } from './in-call-security-policy.js';
import { checkPublicAbuse, PUBLIC_ABUSE_MESSAGE } from './public-abuse.js';
import { resolveDirectTransport } from './direct-transport.js';
import { resolvePublicStunServers, roomMediaMode } from './scale.js';
import { buildSfuMedia, applySfuCapacityProfile, capRoomParticipantsForSfu, capacityLimitMessage, roomCapacityInfo, sfuRoomName } from './sfu.js';
import {
  EgressError,
  egressStartRestriction,
  redactRtmpUrl,
  sanitizeEgressErrorText,
  validateRtmpUrl,
  type EgressKind,
} from './egress.js';
import { EgressPlaybackError, artifactKeyFromEgressInfo, type EgressArtifactKind } from './egress-playback.js';
import { OidcError, verifyOidcIdentity, type OidcIdentity } from './oidc.js';
import {
  OidcStateError,
  clearOidcBindingCookieHeader,
  completeOidcLogin,
  exchangeOidcCode,
  oidcBindingCookieHeader,
  oidcBindingCookieName,
  oidcDefaultReturnTo,
  readCookieValue,
  ssoErrorRedirectUrl,
  ssoRedirectUrl,
  startOidcAuthorization,
  startOidcLogout,
  takePendingOidcAuthorization,
  takePendingOidcLogout,
} from './oidc-flow.js';
import { revokeAdminSession } from './admin-session.js';
import { mediaProcessingStatus } from './media-processing.js';
import {
  assertCountryAllowed,
  hashIp,
  hashPassword,
  isMimeAllowed,
  normalizeIp,
  normalizeMime,
  verifyPassword,
  SecurityError,
} from '@agil/security';
import {
  accessOf,
  adminSession,
  apiKeyTenant,
  assertRateLimit,
  bearerToken,
  buildRoomLinks,
  canUseFeature,
  claimsPermissions,
  claimsRoleId,
  header,
  issueToken,
  requireApiKeyTenant,
  requireJoinToken,
  requireTenantMatch,
  signatureParams,
  verifyAuthToken,
  type TokenClaims,
} from './auth.js';
import type { Env } from './env.js';
import {
  HttpError,
  intQuery,
  requestOrigin,
  safeAudit,
  zodErrorMessage,
  type RequestContext,
  type Router,
} from './http.js';
import { allowedParticipantIdsSchema, roomConfig, RoomLobbyError, RoomPollError, type LobbyRequest, type Room } from './rooms.js';
import { SttTranslationError, TRANSLATION_NOTICE } from './stt-translation.js';
import { parseDomain } from './domains.js';
import { isIpAllowed, parseAllowlist } from './net-policy.js';
import {
  BILLING_WARNING_HEADER,
  evaluateJoinQuota,
  evaluateRoomCreateQuota,
  planParticipantCap,
  tenantUsageCounts,
} from './billing.js';
import { registerScimRoutes } from './scim.js';
import { resolveRequestGeo, aiAgentConfigured } from './services.js';
import { ConfigValidationError } from './tenants.js';
import { assertConfigOverrideEndpoints } from './url-policy.js';

export const SERVER_NAME = 'agil-calls-server';
export const SERVER_VERSION = '0.1.0';
export const MB = 1024 * 1024;

const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const createRoomSchema = z.object({
  tenantId: z.string().min(1).max(64).optional(),
  roomId: z.string().min(1).max(64).optional(),
  name: z.string().max(120).optional(),
  password: z.string().min(1).max(200).optional(),
  maxParticipants: z.number().int().min(2).max(50000).optional(),
  ttlSec: z.number().int().min(0).max(86400).optional(),
  configOverrides: z.unknown().optional(),
  mode: z.enum(['direct', 'group']).optional(),
  /** Explicit media plane for direct 1:1 rooms (docs/p2p.md). */
  transport: z.enum(['p2p', 'sfu']).optional(),
  context: roomContextSchema.optional(),
  allowedParticipantIds: allowedParticipantIdsSchema.optional(),
});

const tokenRequestSchema = z.object({
  tenantId: z.string().min(1).max(64),
  roomId: z.string().min(1).max(64),
  participant: z.object({
    name: z.string().min(1).max(120),
    role: roleSchema.optional(),
    participantId: z.string().min(1).max(64).optional(),
    /** Company-defined custom role id (features replace role defaults). */
    roleId: z.string().min(1).max(40).optional(),
  }),
  ttlSec: z.number().int().min(60).max(86400).optional(),
  /** Exact feature list pinned into the token (issuer decides). */
  permissions: z.array(featureKeySchema).max(500).optional(),
});

const joinRequestSchema = z.object({
  name: z.string().max(120).optional(),
  password: z.string().max(200).optional(),
  participantId: z.string().min(1).max(64).optional(),
  locale: z.enum(['ru', 'en']).optional(),
  token: z.string().max(8192).optional(),
  identityToken: z.string().max(16384).optional(),
});

const egressStartSchema = z.object({
  kind: z.enum(['recording', 'rtmp', 'hls']),
  rtmpUrl: z.string().max(2000).optional(),
  layout: z.enum(['grid', 'speaker']).optional(),
  audioOnly: z.boolean().optional(),
});

/* ---- transcript consent / on-demand translation (docs/stt-translation-local.md) ---- */

const transcriptConsentSchema = z.object({
  /** `false` withdraws consent and erases this participant's stored segments. */
  granted: z.boolean(),
});

const transcriptTranslateSchema = z.object({
  text: z.string().min(1).max(4000),
  targetLang: z.enum(['ru', 'en']).optional(),
  sourceLang: z.enum(['ru', 'en']).optional(),
});

const egressPlaybackSchema = z.object({
  /** 15 min / 1 h / 24 h are the dashboard presets; any 60..86400 is accepted. */
  ttlSec: z.number().int().min(60).max(86400).optional(),
});

const oidcVerifySchema = z.object({
  tenantId: z.string().min(1).max(64),
  identityToken: z.string().min(1).max(16384),
});

const recordingMetaSchema = z.object({
  roomId: z.string().min(1).max(64),
  durationSec: z.number().min(0).max(86_400).optional(),
  mimeType: z.string().max(128).optional(),
});

const chatPostSchema = z.object({
  text: z.string().min(1).max(4000),
  kind: z.enum(['text', 'system']).optional(),
  from: z
    .object({
      id: z.string().max(64).optional(),
      name: z.string().max(120).optional(),
      role: roleSchema.optional(),
    })
    .optional(),
  id: z.string().min(1).max(64).optional(),
});

const assistantStateSchema = z.object({
  participants: z.number().int().min(0).max(200).optional(),
  recording: z.boolean().optional(),
  mic: z.enum(['on', 'off']).optional(),
  camera: z.enum(['on', 'off']).optional(),
  screenSharing: z.boolean().optional(),
  chatOpen: z.boolean().optional(),
  layoutMode: z.string().max(40).optional(),
  qualityTier: z.string().max(40).optional(),
});

const inCallAssistantRequestSchema = z.object({
  text: z.string().min(1).max(2000),
  locale: z.enum(['ru', 'en']).optional(),
  state: assistantStateSchema.optional(),
});

function assertTenantId(tenantId: string): string {
  if (!TENANT_ID_RE.test(tenantId)) throw new HttpError(400, 'validation_failed', 'Invalid tenant id');
  return tenantId;
}

/**
 * Feature gating for participant APIs: the tenant flag AND the participant's
 * effective permissions must both allow the feature (UI and API stay consistent).
 * Throws 403 `feature_disabled` otherwise — no owner/role exceptions.
 */
function requireFeatureForParticipant(
  ctx: RequestContext,
  claims: TokenClaims,
  config: TenantConfig,
  feature: FeatureKey,
): void {
  const permissions = accessOf({
    config,
    role: claims.role,
    userId: claims.sub,
    tokenPermissions: claimsPermissions(claims),
    roleId: claimsRoleId(claims),
  }).allowed;
  if (config.features[feature] === true && permissions.includes(feature)) return;
  throw new HttpError(
    403,
    'feature_disabled',
    `Feature '${feature}' is disabled for this tenant or participant`,
  );
}

function audit(ctx: RequestContext, entry: Parameters<typeof safeAudit>[2]): void {
  safeAudit(ctx.logger, ctx.services.audit, entry);
}

function auditDenied(
  ctx: RequestContext,
  room: { id: string; tenantId: string },
  code: string,
  details: Record<string, unknown> = {},
): void {
  audit(ctx, {
    type: 'join.denied',
    severity: code === 'geo_blocked' || code === 'lockout' ? 'warn' : 'info',
    tenantId: room.tenantId,
    roomId: room.id,
    ip: ctx.ip,
    country: ctx.headerCountry,
    message: `Join denied: ${code}`,
    details: { code, ...details },
  });
}

/** `POST /v1/rooms/:roomId/join` is the only place that mints participant tokens. */
function lobbyRequestInfo(request: LobbyRequest): LobbyRequestInfo {
  return {
    id: request.id,
    name: request.name,
    ...(request.country ? { country: request.country } : {}),
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    status: 'pending',
  };
}

function buildJoinResponse(
  ctx: RequestContext,
  room: Room,
  config: TenantConfig,
  input: {
    participantId: string;
    name: string;
    role: Role;
    roleId?: string;
    tokenPermissions?: FeatureKey[];
    passwordAccepted: boolean;
    source: 'join' | 'lobby-admit';
    identityIssuer?: string;
  },
): JoinRoomResponse {
  const permissions = accessOf({
    config,
    role: input.role,
    userId: input.participantId,
    tokenPermissions: input.tokenPermissions,
    ...(input.roleId ? { roleId: input.roleId } : {}),
  }).allowed;
  const issued = issueToken(ctx.env, {
    participantId: input.participantId,
    name: input.name,
    role: input.role,
    tenantId: room.tenantId,
    roomId: room.id,
    ...(input.tokenPermissions ? { permissions: input.tokenPermissions } : {}),
    ...(input.roleId ? { roleId: input.roleId } : {}),
  });
  audit(ctx, {
    type: 'join.allowed',
    severity: 'info',
    tenantId: room.tenantId,
    roomId: room.id,
    participantId: input.participantId,
    ip: ctx.ip,
    country: ctx.headerCountry,
    message: `Join allowed for ${input.name}`,
    details: {
      role: input.role,
      passwordAccepted: input.passwordAccepted,
      source: input.source,
      permissions: permissions.length,
      ...(input.identityIssuer ? { identityIssuer: input.identityIssuer } : {}),
    },
  });
  const media = buildSfuMedia(ctx.env, config, {
    tenantId: room.tenantId,
    roomId: room.id,
    participantId: input.participantId,
    name: input.name,
    role: input.role,
    ttlSec: ctx.env.tokenTtlSec,
    durationDeadlineAt: room.durationDeadlineAt,
    mediaMode: room.mediaMode,
    sfuNodeId: room.sfuNodeId,
  });
  return {
    token: issued.token,
    expiresAt: issued.expiresAt,
    room: room.info(),
    participant: { id: input.participantId, name: input.name, role: input.role },
    config,
    passwordAccepted: input.passwordAccepted,
    permissions,
    ...(media ? { media } : {}),
  };
}

/**
 * Effective capacity is `min(room.maxParticipants, scale.maxParticipants,
 * profile participants, scale.sfu.maxParticipants)` for SFU/broadcast rooms
 * (mesh keeps `min(room, scale)`), so a token is never issued for a seat the
 * media plane cannot serve. Only seated participants count: restored offline
 * ghosts (Core restart) do not block new joins until they resume, while members
 * inside an active resume-grace lease still do.
 */
function roomCapacityFor(ctx: RequestContext, room: Room, config: TenantConfig) {
  return roomCapacityInfo(ctx.env, config, room.mediaMode, room.maxParticipants);
}

function roomAtCapacity(ctx: RequestContext, room: Room, config: TenantConfig): boolean {
  return room.seatedParticipantCount() >= roomCapacityFor(ctx, room, config).effectiveMaxParticipants;
}

/** Rejects a join at the effective cap with a `room_full` reason (409). */
function throwRoomFull(ctx: RequestContext, room: Room, config: TenantConfig): never {
  const capacity = roomCapacityFor(ctx, room, config);
  const details = {
    reason: capacity.limit,
    ...capacity,
    participants: room.participantCount,
    seatedParticipants: room.seatedParticipantCount(),
  };
  auditDenied(ctx, room, 'room_full', details);
  throw new HttpError(409, 'room_full', capacityLimitMessage(capacity), details);
}

function requireRoomModerator(ctx: RequestContext, room: Room): TokenClaims | null {
  const raw = bearerToken(ctx.headers);
  if (raw) {
    const claims = verifyAuthToken(ctx.env, raw);
    if (!claims) throw new HttpError(401, 'unauthorized', 'Invalid access token');
    if (claims.tenantId !== room.tenantId || claims.roomId !== room.id) {
      throw new HttpError(403, 'forbidden', 'Token does not belong to this room');
    }
    if (claims.role !== 'host' && claims.role !== 'moderator') {
      throw new HttpError(403, 'forbidden', 'Only the host or a moderator can manage the room');
    }
    return claims;
  }
  const keyTenant = requireApiKeyTenant(ctx);
  requireTenantMatch(keyTenant, room.tenantId);
  return null;
}

/** Redacts RTMP/RTMPS URLs that the egress service may return in its info objects. */
function redactEgressInfo(value: unknown): unknown {
  if (typeof value === 'string') {
    return /^rtmps?:\/\//i.test(value) ? redactRtmpUrl(value) : value;
  }
  if (Array.isArray(value)) return value.map(redactEgressInfo);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) result[key] = redactEgressInfo(entry);
    return result;
  }
  return value;
}

function egressHttpError(error: unknown): never {
  if (error instanceof EgressError) throw new HttpError(error.status, error.code, error.message);
  throw error;
}

async function egressStartHandler(ctx: RequestContext): Promise<void> {
  const roomId = ctx.params.roomId as string;
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  const claims = requireRoomModerator(ctx, room);
  try {
    ctx.services.egress.assertReady();
  } catch (error) {
    egressHttpError(error);
  }
  const body = await ctx.jsonSchema(egressStartSchema);
  const config = roomConfig(room, ctx.tenants.getConfig(room.tenantId));
  const restriction = egressStartRestriction(config, body.kind);
  if (restriction) throw new HttpError(restriction.status, restriction.code, restriction.message);
  if (claims) requireFeatureForParticipant(ctx, claims, config, body.kind === 'recording' ? 'recording' : 'liveStreaming');
  if (body.kind === 'rtmp') {
    const issue = validateRtmpUrl(body.rtmpUrl ?? '');
    if (issue) throw new HttpError(400, 'validation_failed', issue);
  }
  const key = egressIdempotencyKey(ctx.headers['idempotency-key']);
  const input = {
    roomName: sfuRoomName(room.tenantId, room.id),
    kind: body.kind,
    ...(body.layout ? { layout: body.layout } : {}),
    ...(body.audioOnly !== undefined ? { audioOnly: body.audioOnly } : {}),
    ...(body.rtmpUrl ? { rtmpUrl: body.rtmpUrl } : {}),
    tenantId: room.tenantId,
    roomId: room.id,
  };
  const launch = async () => {
    try {
      const result = await ctx.services.egress.start(input);
      audit(ctx, {
        type: 'admin.action',
        severity: 'info',
        tenantId: room.tenantId,
        roomId: room.id,
        ip: ctx.ip,
        message: `Egress started: ${body.kind}`,
        details: {
          kind: 'egress.started',
          egressKind: body.kind,
          egressId: result.egressId,
          ...(body.rtmpUrl ? { rtmpHost: redactRtmpUrl(body.rtmpUrl) } : {}),
        },
      });
      return result;
    } catch (error) {
      audit(ctx, {
        type: 'admin.action',
        severity: 'warn',
        tenantId: room.tenantId,
        roomId: room.id,
        ip: ctx.ip,
        message: `Egress failed: ${body.kind}`,
        details: {
          kind: 'egress.failed',
          egressKind: body.kind,
          error: sanitizeEgressErrorText((error as Error).message),
        },
      });
      throw error;
    }
  };
  try {
    ctx.send(200, key ? await ctx.egressStarts.start(key, input, launch) : await launch());
  } catch (error) {
    egressHttpError(error);
  }
}

async function egressStopHandler(ctx: RequestContext): Promise<void> {
  const roomId = ctx.params.roomId as string;
  const egressId = String(ctx.params.egressId ?? '');
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  requireRoomModerator(ctx, room);
  try {
    ctx.services.egress.assertReady();
    const roomName = sfuRoomName(room.tenantId, room.id);
    const job = await ctx.services.egress.info(roomName, egressId, room.tenantId);
    if (job?.room_name !== roomName) throw new HttpError(404, 'not_found', 'Egress job not found in this room');
    const info = await ctx.services.egress.stop(egressId, room.tenantId);
    audit(ctx, {
      type: 'admin.action',
      severity: 'info',
      tenantId: room.tenantId,
      roomId: room.id,
      ip: ctx.ip,
      message: `Egress stopped: ${egressId}`,
      details: { kind: 'egress.stopped', egressId },
    });
    ctx.send(200, { egressId, status: 'stopped', info: redactEgressInfo(info) });
  } catch (error) {
    audit(ctx, {
      type: 'admin.action',
      severity: 'warn',
      tenantId: room.tenantId,
      roomId: room.id,
      ip: ctx.ip,
      message: `Egress stop failed: ${egressId}`,
      details: { kind: 'egress.failed', egressId, error: sanitizeEgressErrorText((error as Error).message) },
    });
    egressHttpError(error);
  }
}

async function egressListHandler(ctx: RequestContext): Promise<void> {
  const roomId = ctx.params.roomId as string;
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  requireRoomModerator(ctx, room);
  try {
    ctx.services.egress.assertReady();
    const egress = await ctx.services.egress.list(sfuRoomName(room.tenantId, room.id), room.tenantId);
    const config = roomConfig(room, ctx.tenants.getConfig(room.tenantId));
    ctx.send(200, {
      roomId: room.id, egress: redactEgressInfo(egress),
      startRestrictions: {
        recording: egressStartRestriction(config, 'recording')?.code ?? null,
        rtmp: egressStartRestriction(config, 'rtmp')?.code ?? null,
        hls: egressStartRestriction(config, 'hls')?.code ?? null,
      },
    });
  } catch (error) {
    egressHttpError(error);
  }
}

/* ------------------------------------------------------------------ */
/* Signed egress playback (HLS playlist / MP4)                          */
/* ------------------------------------------------------------------ */

function egressKindFromInfo(info: Record<string, unknown>): EgressKind {
  const request = info.request && typeof info.request === 'object' ? (info.request as Record<string, unknown>) : {};
  if (Array.isArray(request.stream_outputs) && request.stream_outputs.length > 0) return 'rtmp';
  if (Array.isArray(request.segment_outputs) && request.segment_outputs.length > 0) return 'hls';
  if (Array.isArray(request.file_outputs) && request.file_outputs.length > 0) return 'recording';
  if (Array.isArray(info.stream_results) && info.stream_results.length > 0) return 'rtmp';
  if (Array.isArray(info.segment_results) && info.segment_results.length > 0) return 'hls';
  return 'recording';
}

function playbackHttpError(error: unknown): never {
  if (error instanceof EgressPlaybackError) throw new HttpError(error.status, error.code, error.message);
  if (error instanceof EgressError) throw new HttpError(error.status, error.code, error.message);
  throw error;
}

function assertPlaybackReady(ctx: RequestContext): void {
  if (!ctx.env.egressPlaybackEnabled) {
    throw new HttpError(501, 'egress_playback_disabled', 'Signed playback is disabled (AGIL_EGRESS_PLAYBACK_ENABLED=0)');
  }
  if (!ctx.services.egressPlayback.configured) {
    throw new HttpError(
      501,
      'egress_playback_not_configured',
      'Signed playback is not configured: set AGIL_EGRESS_S3_* (read access) or AGIL_EGRESS_PLAYBACK_DIR',
    );
  }
}

/**
 * `POST /v1/rooms/:roomId/egress/:egressId/playback`
 *
 * Host/moderator (or tenant admin) mints a short-lived HMAC link for a live
 * room. After closure, only a tenant admin may reissue an archived MP4 link.
 * Possession of the unexpired playback token is the download capability.
 */
async function egressPlaybackLinkHandler(ctx: RequestContext): Promise<void> {
  const roomId = ctx.params.roomId as string;
  const egressId = String(ctx.params.egressId ?? '');
  const room = ctx.rooms.get(roomId);
  if (room) {
    requireRoomModerator(ctx, room);
  } else {
    if (!ctx.env.adminApiEnabled) throw new HttpError(404, 'not_found', 'Recording not found');
    if (!isIpAllowed(ctx.ip, ctx.env.adminAllowIps)) {
      throw new HttpError(403, 'forbidden', 'Admin API is not available from this network');
    }
  }
  const tenantId = room?.tenantId ?? requireApiKeyTenant(ctx);
  if (!room) assertRateLimit(ctx.services.limiters.admin.check(`admin:${tenantId}`), ctx, 'Too many admin requests');
  const archived = ctx.services.egressArchive.get(tenantId, roomId, egressId);
  if (!room && !archived) throw new HttpError(404, 'not_found', 'Recording not found');
  assertPlaybackReady(ctx);
  const body = await ctx.jsonSchema(egressPlaybackSchema);
  ctx.res.setHeader('cache-control', 'no-store');
  try {
    if (archived) {
      if (!ctx.services.egressArchive.inConfiguredStore(archived)
        || await ctx.services.egressPlayback.objectSize(archived.key) !== archived.size) {
        throw new HttpError(404, 'not_found', 'Recording file is no longer available');
      }
      const link = ctx.services.egressArchive.link(archived, requestOrigin(ctx, tenantId), body.ttlSec);
      audit(ctx, {
        type: 'admin.action', severity: 'info', tenantId, roomId, ip: ctx.ip,
        message: 'Signed archived playback link created',
        details: { kind: 'egress.playback_link', egressKind: 'recording', egressId, expiresAt: link.expiresAt },
      });
      ctx.send(200, {
        egressId, kind: 'recording', ...link,
        ttlSec: Math.max(0, Math.round((link.expiresAt - Date.now()) / 1000)),
      });
      return;
    }
    if (!room) throw new HttpError(404, 'not_found', 'Room not found');
    ctx.services.egress.assertReady();
    const roomName = sfuRoomName(room.tenantId, room.id);
    const info = await ctx.services.egress.info(roomName, egressId, room.tenantId);
    if (!info || info.room_name !== roomName) throw new HttpError(404, 'not_found', 'Egress session not found');
    const kind = egressKindFromInfo(info as Record<string, unknown>);
    if (kind === 'rtmp') throw new HttpError(400, 'validation_failed', 'RTMP sessions have no stored playback artifact');
    const artifactKind: EgressArtifactKind = kind === 'hls' ? 'hls' : 'recording';
    const key = artifactKeyFromEgressInfo(info, artifactKind, ctx.env.egressS3Bucket);
    if (!key || !(await ctx.services.egressPlayback.exists(key))) {
      throw new HttpError(409, 'egress_not_ready', 'Egress artifact is not available yet');
    }
    const link = ctx.services.egressPlayback.createLink({
      tenantId: room.tenantId,
      roomId: room.id,
      egressId,
      key,
      scope: kind === 'hls' ? 'playlist' : 'file',
      ...(body.ttlSec !== undefined ? { ttlSec: body.ttlSec } : {}),
      origin: requestOrigin(ctx, room.tenantId),
    });
    audit(ctx, {
      type: 'admin.action',
      severity: 'info',
      tenantId: room.tenantId,
      roomId: room.id,
      ip: ctx.ip,
      message: `Signed egress playback link created (${kind})`,
      details: { kind: 'egress.playback_link', egressKind: kind, egressId, expiresAt: link.expiresAt },
    });
    ctx.send(200, {
      egressId,
      kind,
      url: link.url,
      expiresAt: link.expiresAt,
      ttlSec: Math.max(0, Math.round((link.expiresAt - Date.now()) / 1000)),
    });
  } catch (error) {
    playbackHttpError(error);
  }
}

/**
 * `GET /v1/rooms/:roomId/egress/:egressId/playlist?token=…`
 *
 * Public capability URL. The token binds tenant/room/egress/key/expiry, so a
 * copy of the master playlist stops working when the token expires. Segments
 * are rewritten to their own signed same-origin URLs.
 */
async function egressPlaylistHandler(ctx: RequestContext): Promise<void> {
  assertPlaybackReady(ctx);
  const roomId = ctx.params.roomId as string;
  const egressId = String(ctx.params.egressId ?? '');
  // The live room is optional: a valid link must keep working after a Core
  // restart or room deletion, because the signed token itself binds the
  // tenant/room/egress/key. When the room is known its tenant is still checked.
  const room = ctx.rooms.get(roomId);
  try {
    const claims = ctx.services.egressPlayback.verify({
      token: ctx.query.get('token') ?? undefined,
      ...(room ? { tenantId: room.tenantId } : {}),
      roomId,
      egressId,
      scope: 'playlist',
    });
    if (ctx.method === 'HEAD') {
      // Header-only: one S3 metadata HEAD / local stat, no playlist GET and no
      // rewrite. `content-length` is the stored object size, which can differ
      // from the rewritten GET length (documented in the operator contract).
      const head = await ctx.services.egressPlayback.playlistHead(claims);
      ctx.res.writeHead(head.status, {
        ...head.headers,
        'cache-control': 'private, no-store',
        'referrer-policy': 'no-referrer',
      });
      ctx.res.end();
      return;
    }
    const text = await ctx.services.egressPlayback.playlistText(claims);
    ctx.sendRaw(200, Buffer.from(text, 'utf8'), {
      'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
      // The playlist contains signed segment URLs; never let a proxy cache it.
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
    });
  } catch (error) {
    playbackHttpError(error);
  }
}

/** Shared streamer for `segment` and `file` (single-Range aware). */
async function egressPlaybackStreamHandler(ctx: RequestContext, scope: 'segment' | 'file'): Promise<void> {
  assertPlaybackReady(ctx);
  const roomId = ctx.params.roomId as string;
  const egressId = String(ctx.params.egressId ?? '');
  // See egressPlaylistHandler: the token is the capability; the room is an
  // optional tenant cross-check, not a requirement.
  const room = ctx.rooms.get(roomId);
  try {
    const claims = ctx.services.egressPlayback.verify({
      token: ctx.query.get('token') ?? undefined,
      ...(room ? { tenantId: room.tenantId } : {}),
      roomId,
      egressId,
      scope,
    });
    if (scope === 'file' && !claims.b) {
      const archived = ctx.services.egressArchive.get(claims.t, roomId, egressId);
      if (archived && (!archived.storageId || !ctx.services.egressArchive.inConfiguredStore(archived) || archived.key !== claims.k)) {
        throw new HttpError(404, 'not_found', 'Playback link not found');
      }
    }
    const commonHeaders: Record<string, string> = {
      'cache-control': scope === 'segment' ? 'private, max-age=3600' : 'private, no-store',
      'x-content-type-options': 'nosniff',
    };
    if (scope === 'file') {
      const name = claims.k.split('/').pop() || 'recording.mp4';
      commonHeaders['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
    }
    if (ctx.method === 'HEAD') {
      // Header-only: HEAD routed here like GET so players/CDNs/monitoring get
      // the same status (200/206/416) and headers, but the storage backend is
      // only asked for metadata (S3 HEAD / local stat) — no object GET, no body
      // read. `content-length`/`content-range` describe the object.
      const head = await ctx.services.egressPlayback.objectHead(claims, header(ctx.headers, 'range'));
      ctx.res.writeHead(head.status, { ...head.headers, ...commonHeaders });
      ctx.res.end();
      return;
    }
    const object = await ctx.services.egressPlayback.objectStream(claims, header(ctx.headers, 'range'));
    const headers: Record<string, string> = { ...object.headers, ...commonHeaders };
    ctx.res.writeHead(object.status, headers);
    await pipeline(object.body, ctx.res);
  } catch (error) {
    if (ctx.res.headersSent) {
      ctx.res.destroy();
      return;
    }
    playbackHttpError(error);
  }
}

async function egressSegmentHandler(ctx: RequestContext): Promise<void> {
  return egressPlaybackStreamHandler(ctx, 'segment');
}

async function egressFileHandler(ctx: RequestContext): Promise<void> {
  return egressPlaybackStreamHandler(ctx, 'file');
}

/** `POST /v1/auth/oidc/verify` — verify an OIDC identity JWT without issuing tokens. */
async function oidcVerifyHandler(ctx: RequestContext): Promise<void> {
  const body = await ctx.jsonSchema(oidcVerifySchema);
  assertRateLimit(ctx.services.limiters.join.check(`oidc:${ctx.ipHash}:${body.tenantId}`), ctx, 'Too many identity checks');
  const config = ctx.tenants.getConfig(body.tenantId);
  try {
    const identity = await verifyOidcIdentity(ctx.env, config, body.identityToken);
    ctx.send(200, {
      userId: identity.userId,
      name: identity.name,
      role: identity.role,
      permissions: identity.permissions ?? [],
      verified: identity.verified,
      issuer: identity.issuer,
    });
  } catch (error) {
    if (error instanceof OidcError) throw new HttpError(error.status, error.code, error.message);
    throw error;
  }
}

/** Error codes allowed in the post-login `#sso_error=` fragment (stable contract). */
const SSO_ERROR_CODES = new Set([
  'state_invalid',
  'state_expired',
  'idp_error',
  'access_denied',
  'invalid_identity_token',
  'identity_not_verified',
  'identity_not_allowed',
  'tenant_mismatch',
  'identity_not_configured',
  'validation_failed',
]);

/** Maps an internal OIDC error to the HTTP envelope; rethrows anything else. */
function oidcToHttp(error: unknown): never {
  if (error instanceof OidcError) throw new HttpError(error.status, error.code, error.message);
  throw error;
}

/** 302 without a body; the Location fragment never reaches server logs. */
function sendSsoRedirect(ctx: RequestContext, location: string): void {
  ctx.res.statusCode = 302;
  ctx.res.setHeader('location', location);
  ctx.res.setHeader('cache-control', 'no-store, max-age=0');
  ctx.res.setHeader('pragma', 'no-cache');
  ctx.res.setHeader('referrer-policy', 'no-referrer');
  ctx.res.setHeader('content-length', '0');
  ctx.res.end();
}

/**
 * A start request is "same-origin browser" when it carries no Origin header
 * (same-origin fetch/old browser) or its Origin equals the canonical
 * `AGIL_PUBLIC_ORIGIN` (scheme + host + port, not just host). Cross-origin
 * dashboards get no cookie binding: a browser will not store a Set-Cookie from
 * their cross-origin start response without credentialed CORS.
 */
function isSameOriginStart(ctx: RequestContext): boolean {
  const origin = (header(ctx.headers, 'origin') ?? '').trim();
  if (!origin) return true;
  let parsed: URL;
  let canonical: string;
  try {
    parsed = new URL(origin);
    canonical = new URL(ctx.env.publicOrigin).origin;
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.origin === canonical;
}

/**
 * `GET /v1/auth/oidc/start?tenantId=&returnTo=` — creates state+nonce+PKCE and
 * returns the IdP authorization URL. Public endpoint: the browser redirects
 * itself, so no API key is needed (and the tenant is not secret). Same-origin
 * browser starts also receive an HttpOnly binding cookie, checked at callback.
 * Endpoints may come from the tenant's explicit config or OIDC discovery.
 */
async function oidcStartHandler(ctx: RequestContext): Promise<void> {
  assertRateLimit(ctx.services.limiters.oidc.check(`oidc:start:${ctx.ipHash}`), ctx, 'Too many SSO attempts');
  const tenantId = (ctx.query.get('tenantId') ?? '').trim() || ctx.env.defaultTenantId;
  if (!TENANT_ID_RE.test(tenantId)) throw new HttpError(400, 'validation_failed', 'Invalid tenantId');
  try {
    const config = ctx.tenants.getConfig(tenantId);
    const started = await startOidcAuthorization(ctx.env, config, tenantId, ctx.query.get('returnTo') ?? undefined, {
      bindBrowser: ctx.env.oidcCookieBinding && isSameOriginStart(ctx),
      requestHost: ctx.url.host,
    });
    if (started.browserBinding) {
      // form_post callbacks are cross-site POSTs: the binding cookie must be
      // SameSite=None there (Secure is added in production mode).
      ctx.res.setHeader(
        'set-cookie',
        oidcBindingCookieHeader(ctx.env, started.browserBinding, ctx.env.oidcStateTtlSec, started.bindingSameSite ?? 'Lax'),
      );
    }
    ctx.send(
      200,
      { authorizationUrl: started.authorizationUrl, expiresAt: started.expiresAt },
      { 'cache-control': 'no-store, max-age=0', pragma: 'no-cache', 'referrer-policy': 'no-referrer' },
    );
  } catch (error) {
    oidcToHttp(error);
  }
}

/**
 * Reads authorization response parameters from the query (default `query`
 * mode) or from an `application/x-www-form-urlencoded` body
 * (`response_mode=form_post`). The body is size-bounded and never logged.
 */
async function readOidcCallbackParams(ctx: RequestContext): Promise<URLSearchParams> {
  if (ctx.method !== 'POST') return ctx.query;
  const contentType = String(ctx.headers['content-type'] ?? '')
    .split(';')[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') {
    throw new OidcError(400, 'validation_failed', 'form_post callback ожидает application/x-www-form-urlencoded');
  }
  try {
    const raw = await ctx.raw(64 * 1024, 'payload_too_large');
    return new URLSearchParams(raw.toString('utf8'));
  } catch (error) {
    if (error instanceof OidcError) throw error;
    throw new OidcError(413, 'validation_failed', 'Слишком большой form_post ответ');
  }
}

/**
 * `GET|POST /v1/auth/oidc/callback` — consumes the pending state (and its
 * browser-binding cookie), exchanges the code, verifies the id_token and
 * redirects to `returnTo#sso_token=…`. GET handles `response_mode=query`, POST
 * handles `response_mode=form_post`. Every failure becomes a
 * `#sso_error=<code>` redirect (never a JSON body: the browser is in the middle
 * of a navigation). The binding cookie is always cleared.
 */
async function oidcCallbackHandler(ctx: RequestContext): Promise<void> {
  assertRateLimit(ctx.services.limiters.oidc.check(`oidc:callback:${ctx.ipHash}`), ctx, 'Too many SSO attempts');
  const binding = readCookieValue(header(ctx.headers, 'cookie'), oidcBindingCookieName());
  // Clear on success and on every error path (single-use state).
  ctx.res.setHeader('set-cookie', clearOidcBindingCookieHeader(ctx.env));
  let entry: ReturnType<typeof takePendingOidcAuthorization> | null = null;
  try {
    const params = await readOidcCallbackParams(ctx);
    const state = params.get('state') ?? '';
    const providerError = (params.get('error') ?? '').trim();
    entry = takePendingOidcAuthorization(state, binding);
    if (providerError) {
      throw new OidcError(
        400,
        providerError === 'access_denied' ? 'access_denied' : 'idp_error',
        'IdP отклонил вход',
      );
    }
    const config = ctx.tenants.getConfig(entry.tenantId);
    const exchanged = await exchangeOidcCode(ctx.env, config, entry, params.get('code') ?? undefined);
    const completed = await completeOidcLogin(ctx.env, config, entry, exchanged.idToken);
    // Audit the login without tokens or user PII.
    safeAudit(ctx.logger, ctx.services.audit, {
      type: 'admin.action',
      severity: 'info',
      tenantId: completed.tenantId,
      ip: ctx.ip,
      message: 'Dashboard SSO login',
      details: { via: 'oidc' },
    });
    sendSsoRedirect(ctx, ssoRedirectUrl(completed.returnTo, completed.session.token));
  } catch (error) {
    const rawCode = error instanceof OidcError ? error.code : 'idp_error';
    const code = SSO_ERROR_CODES.has(rawCode) ? rawCode : 'idp_error';
    // Prefer the tenant's own dashboard even when the state was already expired.
    const knownReturnTo = error instanceof OidcStateError ? error.returnTo : undefined;
    const target = entry?.returnTo ?? knownReturnTo ?? oidcDefaultReturnTo(ctx.env);
    sendSsoRedirect(ctx, ssoErrorRedirectUrl(target, code));
  }
}

/**
 * `POST /v1/auth/oidc/logout` — revokes the current dashboard session's `jti`
 * (server-side deny-list) and returns 204. Bearer-only: no cookie is used for
 * authentication, so a cross-site form cannot perform it (no CSRF token needed).
 * An unknown/expired token also returns 204 (idempotent, no token oracle).
 */
async function oidcLogoutHandler(ctx: RequestContext): Promise<void> {
  assertRateLimit(ctx.services.limiters.oidc.check(`oidc:logout:${ctx.ipHash}`), ctx, 'Too many SSO attempts');
  const session = adminSession(ctx.env, ctx.headers);
  if (session) {
    revokeAdminSession(session);
    safeAudit(ctx.logger, ctx.services.audit, {
      type: 'admin.action',
      severity: 'info',
      tenantId: session.tenantId,
      ip: ctx.ip,
      message: 'Dashboard SSO logout',
      details: { via: 'oidc' },
    });
  }
  ctx.res.statusCode = 204;
  ctx.res.setHeader('cache-control', 'no-store');
  ctx.res.end();
}

/**
 * `GET /v1/auth/oidc/logout?tenantId=&returnTo=` — RP-initiated logout: builds
 * the IdP `end_session_endpoint` URL (`client_id`, `post_logout_redirect_uri`,
 * single-use `state`) so the dashboard can also end the corporate IdP session.
 * Returns 501 `identity_not_configured` when RP logout is not configured; the
 * dashboard then falls back to local revocation only.
 */
async function oidcLogoutStartHandler(ctx: RequestContext): Promise<void> {
  assertRateLimit(ctx.services.limiters.oidc.check(`oidc:logout:${ctx.ipHash}`), ctx, 'Too many SSO attempts');
  const tenantId = (ctx.query.get('tenantId') ?? '').trim() || ctx.env.defaultTenantId;
  if (!TENANT_ID_RE.test(tenantId)) throw new HttpError(400, 'validation_failed', 'Invalid tenantId');
  try {
    const config = ctx.tenants.getConfig(tenantId);
    const started = await startOidcLogout(ctx.env, config, tenantId, ctx.query.get('returnTo') ?? undefined);
    ctx.send(
      200,
      { logoutUrl: started.logoutUrl, expiresAt: started.expiresAt },
      { 'cache-control': 'no-store, max-age=0', pragma: 'no-cache', 'referrer-policy': 'no-referrer' },
    );
  } catch (error) {
    oidcToHttp(error);
  }
}

/**
 * `GET /v1/auth/oidc/logout/callback?state=` — the default
 * `post_logout_redirect_uri`. Validates and consumes the logout state, then
 * redirects to the dashboard target (no token, no IdP data in the URL). An
 * unknown/expired state lands on the default dashboard (logout is still local).
 */
function oidcLogoutCallbackHandler(ctx: RequestContext): void {
  assertRateLimit(ctx.services.limiters.oidc.check(`oidc:logout:${ctx.ipHash}`), ctx, 'Too many SSO attempts');
  let target = oidcDefaultReturnTo(ctx.env);
  try {
    const entry = takePendingOidcLogout(ctx.query.get('state') ?? '');
    target = entry.returnTo;
  } catch (error) {
    // Expired/unknown state is not an error for the user: they are logged out
    // locally in either case. Use the known dashboard target when available.
    if (error instanceof OidcStateError && error.returnTo) target = error.returnTo;
  }
  sendSsoRedirect(ctx, target);
}

async function joinRoom(ctx: RequestContext): Promise<void> {
  // Joining creates participant/presence state; only the leader Core owns rooms.
  ctx.cluster.assertLeader('room join');
  const roomId = ctx.params.roomId as string;
  const body = await ctx.jsonSchema(joinRequestSchema) as JoinRoomRequest & { token?: string; identityToken?: string };
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');

  const tenantConfig = ctx.tenants.getConfig(room.tenantId);
  const config = roomConfig(room, tenantConfig);

  assertRateLimit(ctx.services.limiters.join.check(`join:${ctx.ipHash}:${roomId}`), ctx, 'Too many join attempts');

  let identity: OidcIdentity | undefined;
  if (body.identityToken) {
    try {
      identity = await verifyOidcIdentity(ctx.env, config, body.identityToken);
    } catch (error) {
      if (error instanceof OidcError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  }
  if (!identity && config.security.requireVerifiedIdentity) {
    auditDenied(ctx, room, 'identity_required');
    throw new HttpError(401, 'identity_required', 'Требуется подтверждённая корпоративная идентичность (identityToken)');
  }
  if (identity && config.security.requireVerifiedIdentity && !identity.verified) {
    auditDenied(ctx, room, 'invalid_identity_token', { issuer: identity.issuer });
    throw new HttpError(401, 'invalid_identity_token', 'Корпоративная идентичность не подтверждена (verifiedClaim)');
  }

  const lockout = room.lockoutStatus(ctx.ipHash);
  if (lockout.locked) {
    ctx.res.setHeader('retry-after', String(Math.max(1, Math.ceil(lockout.retryAfterMs / 1000))));
    auditDenied(ctx, room, 'lockout', { retryAfterMs: lockout.retryAfterMs });
    throw new HttpError(429, 'rate_limited', 'Too many failed join attempts; try again later');
  }
  if (room.locked) {
    auditDenied(ctx, room, 'room_locked');
    throw new HttpError(423, 'room_locked', 'Room is locked');
  }

  // Token presented by an invite / previously joined session.
  const presentedToken = body.token ?? bearerToken(ctx.headers);
  const existingClaims = verifyAuthToken(ctx.env, presentedToken);
  // Room-scoped tokens: claims from another room/tenant are never trusted
  // (the caller joins as an anonymous guest instead of inheriting that role).
  const authorized = Boolean(
    existingClaims && existingClaims.roomId === room.id && existingClaims.tenantId === room.tenantId,
  );
  const trustedClaims = authorized ? existingClaims : null;
  if (!room.allowsParticipant(trustedClaims?.sub) || (room.allowedParticipantIds && identity && identity.userId !== trustedClaims?.sub)) {
    auditDenied(ctx, room, 'participant_not_allowed');
    throw new HttpError(403, 'forbidden', 'A room token for an allowed participant is required');
  }
  if (!trustedClaims && !(identity?.verified && !room.configOverrides?.integrations?.identity)) {
    assertRateLimit(checkPublicAbuse(ctx.services, ctx.logger, {
      mode: tenantConfig.security.publicAbuseMode ?? ctx.env.publicAbuseDefaultMode,
      action: 'room.join',
      tenantId: room.tenantId,
      ipHash: ctx.ipHash,
    }), ctx, PUBLIC_ABUSE_MESSAGE);
  }

  // Geo policy (never throws; unknown country is blocked only by an allow-list).
  if (config.security.geo.enabled) {
    const geo = await resolveRequestGeo(ctx.env, ctx.ip, ctx.headerCountry);
    const country = geo.country ?? ctx.headerCountry;
    try {
      if (config.security.geo.blockVpn && geo.vpn) {
        throw new Error('vpn_blocked');
      }
      assertCountryAllowed(country, config.security.geo);
    } catch {
      audit(ctx, {
        type: 'geo.blocked',
        severity: 'warn',
        tenantId: room.tenantId,
        roomId: room.id,
        ip: ctx.ip,
        country,
        message: `Join blocked by geo policy (${country ?? 'unknown country'}${geo.vpn ? ', VPN' : ''})`,
        details: { country, vpn: geo.vpn, source: geo.source },
      });
      auditDenied(ctx, room, 'geo_blocked', { country });
      throw new HttpError(403, 'geo_blocked', 'Join is not allowed from this country');
    }
  }

  // Room password (skipped for a valid invite token: it already authorises access).
  let passwordAccepted = false;
  if (room.passwordHash && !authorized) {
    if (!body.password) {
      auditDenied(ctx, room, 'password_required');
      throw new HttpError(400, 'password_required', 'Room password is required');
    }
    if (!verifyPassword(body.password, room.passwordHash)) {
      const failure = room.registerFailure(ctx.ipHash, {
        maxAttempts: config.security.maxFailedJoinAttempts,
        lockoutSec: config.security.lockoutSec,
      });
      audit(ctx, {
        type: 'password.failed',
        severity: 'warn',
        tenantId: room.tenantId,
        roomId: room.id,
        ip: ctx.ip,
        message: `Wrong room password (attempt ${failure.attempts})`,
        details: { attempts: failure.attempts },
      });
      if (failure.locked) {
        audit(ctx, {
          type: 'lockout',
          severity: 'warn',
          tenantId: room.tenantId,
          roomId: room.id,
          ip: ctx.ip,
          message: `Join lockout after ${failure.attempts} failed attempts`,
          details: { attempts: failure.attempts, lockedUntil: failure.lockedUntil },
        });
        ctx.res.setHeader('retry-after', String(Math.max(1, config.security.lockoutSec)));
        auditDenied(ctx, room, 'lockout', { attempts: failure.attempts });
        throw new HttpError(429, 'rate_limited', 'Too many failed join attempts; room is temporarily locked');
      }
      auditDenied(ctx, room, 'password_invalid', { attempts: failure.attempts });
      throw new HttpError(401, 'password_invalid', 'Wrong room password');
    }
    room.resetFailures(ctx.ipHash);
    passwordAccepted = true;
  }

  const role = (room.voiceChannel ? trustedClaims?.role : identity?.role ?? trustedClaims?.role) ?? 'guest';
  const name = ((room.voiceChannel ? trustedClaims?.name : identity?.name ?? body.name ?? trustedClaims?.name) ?? 'Гость').trim().slice(0, 120) || 'Гость';

  if (ctx.rooms.get(room.id) !== room) throw new HttpError(404, 'not_found', 'Room not found');
  if (config.security.moderatorJoinFirst && !config.security.waitingRoom) {
    const hasModerator = room.participants().some((participant) => participant.role !== 'guest');
    if (!hasModerator && role === 'guest') {
      auditDenied(ctx, room, 'waiting_room');
      throw new HttpError(403, 'forbidden', 'Waiting for the host to join', { reason: 'host_not_joined' });
    }
  }

  if (roomAtCapacity(ctx, room, config)) throwRoomFull(ctx, room, config);

  const participantId = identity?.userId ?? trustedClaims?.sub ?? body.participantId ?? randomUUID();
  const tokenPermissions = room.voiceChannel ? claimsPermissions(trustedClaims) : identity?.permissions ?? claimsPermissions(trustedClaims);
  const roleId = identity ? undefined : claimsRoleId(trustedClaims);

  // A reconnecting participant already in the room never trips the quota.
  const billing = ctx.tenants.getConfig(room.tenantId).billing;
  const usage = ctx.services.billing.getUsage(room.tenantId);
  const liveMinutes = ctx.services.billing.liveMinutes(room.tenantId);
  const counts = tenantUsageCounts(ctx.rooms, room.tenantId);
  const joinQuota = evaluateJoinQuota({
    billing,
    usage,
    liveMinutes,
    activeParticipants: counts.activeParticipants,
  });
  const reconnecting = room.member(participantId) !== undefined;
  if (!joinQuota.allowed && !reconnecting) {
    audit(ctx, {
      type: 'join.denied',
      severity: 'warn',
      tenantId: room.tenantId,
      roomId: room.id,
      ip: ctx.ip,
      message: 'Join denied: billing_quota_exceeded',
      details: {
        code: 'billing_quota_exceeded',
        metric: joinQuota.blocked?.metric,
        used: joinQuota.blocked?.used,
        limit: joinQuota.blocked?.limit,
      },
    });
    throw new HttpError(429, 'quota_exceeded', joinQuota.blocked?.message ?? 'Billing quota exceeded', {
      metric: joinQuota.blocked?.metric,
      used: joinQuota.blocked?.used,
      limit: joinQuota.blocked?.limit,
      policy: joinQuota.blocked?.policy,
    });
  }

  if (config.security.waitingRoom && role === 'guest' && !authorized) {
    let request: LobbyRequest;
    try {
      request = room.addLobbyRequest(
        {
          participantId,
          name,
          ...(ctx.headerCountry ? { country: ctx.headerCountry } : {}),
          ipHash: ctx.ipHash,
          passwordAccepted,
          role,
          ...(roleId ? { roleId } : {}),
          ...(tokenPermissions ? { tokenPermissions } : {}),
        },
        ctx.env.lobbyTtlSec,
        ctx.env.lobbyMax,
      );
    } catch (error) {
      if (error instanceof RoomLobbyError) {
        throw new HttpError(409, error.code, error.message);
      }
      throw error;
    }
    try {
      await persistLobbyState(ctx, room);
    } catch (error) {
      room.removeLobbyRequest(request.id);
      throw error;
    }
    audit(ctx, {
      type: 'lobby.pending',
      severity: 'info',
      tenantId: room.tenantId,
      roomId: room.id,
      ip: ctx.ip,
      message: `Waiting-room request from ${name}`,
      details: { requestId: request.id, country: request.country ?? null },
    });
    room.broadcast(
      { type: 'lobby.pending', request: lobbyRequestInfo(request) } as unknown as ServerMessage,
      { roles: ['host', 'moderator'] },
    );
    const pending: LobbyJoinResponse = {
      pending: true,
      requestId: request.id,
      cancelToken: request.cancelToken,
      roomId: room.id,
      status: 'pending',
      expiresAt: request.expiresAt,
      pollAfterMs: 2000,
      waitingMessage: config.room.waitingMessage,
    };
    ctx.send(202, pending);
    return;
  }

  const response = buildJoinResponse(ctx, room, config, {
    participantId,
    name,
    role,
    ...(roleId ? { roleId } : {}),
    ...(tokenPermissions ? { tokenPermissions } : {}),
    ...(identity ? { identityIssuer: identity.issuer } : {}),
    passwordAccepted,
    source: 'join',
  });
  if (joinQuota.warnings.length > 0) {
    response.billingWarning = joinQuota.warnings[0];
    ctx.res.setHeader(BILLING_WARNING_HEADER, joinQuota.warnings.map((warning) => warning.metric).join(','));
  }
  ctx.send(200, response);
}

/* ------------------------------------------------------------------ */
/* Waiting-room lobby (host/moderator admit or reject)                 */
/* ------------------------------------------------------------------ */

function lobbyListHandler(ctx: RequestContext): void {
  const roomId = ctx.params.roomId as string;
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  requireRoomModerator(ctx, room);
  const requests = room.lobbyList();
  for (const expiredId of room.takeExpiredLobbyIds()) {
    audit(ctx, {
      type: 'lobby.expired',
      severity: 'info',
      tenantId: room.tenantId,
      roomId: room.id,
      ip: ctx.ip,
      message: 'Waiting-room request expired',
      details: { requestId: expiredId },
    });
  }
  const response: LobbyRequestsResponse = {
    roomId: room.id,
    requests: requests.map(lobbyRequestInfo),
  };
  ctx.send(200, response);
}

async function persistLobbyState(ctx: RequestContext, room: Room): Promise<void> {
  try {
    await ctx.continuity.saveRoom(room);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'room_snapshot_unavailable', 'Waiting room state could not be saved');
  }
  ctx.cluster.assertLeader('waiting room update');
  if (ctx.rooms.get(room.id) !== room) throw new HttpError(404, 'not_found', 'Room not found');
}

async function lobbyStatusHandler(ctx: RequestContext): Promise<void> {
  const roomId = ctx.params.roomId as string;
  const requestId = String(ctx.params.requestId ?? '');
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  const pending = room.lobbyRequest(requestId);
  if (pending) {
    const response: LobbyStatusResponse = {
      requestId: pending.id,
      status: 'pending',
      expiresAt: pending.expiresAt,
    };
    ctx.send(200, response);
    return;
  }
  const decision = room.lobbyDecision(requestId);
  if (!decision) throw new HttpError(404, 'not_found', 'Lobby request not found');
  if (decision.status === 'admitted') {
    // The token is a capability for this polling guest; returned exactly once.
    ctx.cluster.assertLeader('waiting room admission delivery');
    const { joinUrl, embedUrl } = decision;
    const token = room.takeLobbyToken(requestId);
    if (token) await persistLobbyState(ctx, room);
    const response: LobbyStatusResponse = {
      requestId,
      status: 'admitted',
      ...(token ? { token } : {}),
      ...(decision.expiresAt ? { expiresAt: decision.expiresAt } : {}),
      ...(token && joinUrl ? { joinUrl } : {}),
      ...(token && embedUrl ? { embedUrl } : {}),
    };
    ctx.send(200, response);
    return;
  }
  const response: LobbyStatusResponse = {
    requestId,
    status: decision.status,
    ...(decision.reason ? { reason: decision.reason } : {}),
  };
  ctx.send(200, response);
}

async function lobbyCancelHandler(ctx: RequestContext): Promise<void> {
  ctx.cluster.assertLeader('waiting room cancellation');
  const { roomId, requestId } = ctx.params as { roomId: string; requestId: string };
  const body = await ctx.json<{ cancelToken?: unknown } | null>();
  const cancelToken = body?.cancelToken;
  const room = ctx.rooms.get(roomId);
  const request = room?.lobbyRequest(requestId);
  if (!room || !request || typeof cancelToken !== 'string' || cancelToken.length !== request.cancelToken.length) {
    throw new HttpError(404, 'not_found', 'Lobby request not found');
  }
  const supplied = Buffer.from(cancelToken);
  const expected = Buffer.from(request.cancelToken);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new HttpError(404, 'not_found', 'Lobby request not found');
  }
  ctx.cluster.assertLeader('waiting room cancellation');
  room.removeLobbyRequest(requestId);
  await persistLobbyState(ctx, room);
  room.broadcast(
    { type: 'lobby.queue', requests: room.lobbyList().map(lobbyRequestInfo) } as unknown as ServerMessage,
    { roles: ['host', 'moderator'] },
  );
  ctx.send(200, { requestId, status: 'cancelled' });
}

async function lobbyAdmitHandler(ctx: RequestContext): Promise<void> {
  ctx.cluster.assertLeader('waiting room admission');
  const roomId = ctx.params.roomId as string;
  const requestId = String(ctx.params.requestId ?? '');
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  requireRoomModerator(ctx, room);
  const request = room.lobbyRequest(requestId);
  if (!request) throw new HttpError(404, 'not_found', 'Lobby request not found');
  const config = roomConfig(room, ctx.tenants.getConfig(room.tenantId));
  if (roomAtCapacity(ctx, room, config)) throwRoomFull(ctx, room, config);
  room.removeLobbyRequest(requestId);
  const response = buildJoinResponse(ctx, room, config, {
    participantId: request.participantId,
    name: request.name,
    role: request.role,
    ...(request.roleId ? { roleId: request.roleId } : {}),
    ...(request.tokenPermissions ? { tokenPermissions: request.tokenPermissions } : {}),
    passwordAccepted: request.passwordAccepted,
    source: 'lobby-admit',
  });
  const links = buildRoomLinks(ctx.env, { roomId: room.id, tenantId: room.tenantId, token: response.token }, requestOrigin(ctx, room.tenantId));
  room.recordLobbyDecision(requestId, {
    status: 'admitted',
    token: response.token,
    expiresAt: response.expiresAt,
    joinUrl: links.joinUrl,
    embedUrl: links.embedUrl,
  });
  await persistLobbyState(ctx, room);
  room.broadcast(
    { type: 'lobby.admitted', requestId, participant: response.participant } as ServerMessage,
    { roles: ['host', 'moderator'] },
  );
  audit(ctx, {
    type: 'lobby.admitted',
    severity: 'info',
    tenantId: room.tenantId,
    roomId: room.id,
    ip: ctx.ip,
    message: `Lobby request admitted: ${request.name}`,
    details: { requestId },
  });
  ctx.send(200, response);
}

function lobbyRejectHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    ctx.cluster.assertLeader('waiting room rejection');
    const roomId = ctx.params.roomId as string;
    const requestId = String(ctx.params.requestId ?? '');
    const room = ctx.rooms.get(roomId);
    if (!room) throw new HttpError(404, 'not_found', 'Room not found');
    requireRoomModerator(ctx, room);
    const request = room.lobbyRequest(requestId);
    if (!request) throw new HttpError(404, 'not_found', 'Lobby request not found');
    let reason = 'rejected';
    if (ctx.method === 'POST') {
      let body: { reason?: unknown } = {};
      try {
        body = await ctx.json<{ reason?: unknown }>();
      } catch {
        body = {};
      }
      if (typeof body.reason === 'string' && body.reason.trim()) reason = body.reason.trim().slice(0, 200);
    } else {
      reason = 'kicked';
    }
    ctx.cluster.assertLeader('waiting room rejection');
    if (!room.removeLobbyRequest(requestId)) throw new HttpError(404, 'not_found', 'Lobby request not found');
    room.recordLobbyDecision(requestId, { status: 'rejected', reason });
    await persistLobbyState(ctx, room);
    room.broadcast(
      { type: 'lobby.rejected', requestId, reason } as ServerMessage,
      { roles: ['host', 'moderator'] },
    );
    audit(ctx, {
      type: 'lobby.rejected',
      severity: 'warn',
      tenantId: room.tenantId,
      roomId: room.id,
      ip: ctx.ip,
      message: `Lobby request ${reason}: ${request.name}`,
      details: { requestId, reason },
    });
    const response: LobbyDecisionResponse = { requestId, status: 'rejected' };
    ctx.send(200, response);
  })();
}

/* ------------------------------------------------------------------ */
/* Breakout rooms                                                      */
/* ------------------------------------------------------------------ */

const breakoutTimers = new Map<string, NodeJS.Timeout>();

function clearBreakoutTimer(planId: string): void {
  const timer = breakoutTimers.get(planId);
  if (timer) {
    clearTimeout(timer);
    breakoutTimers.delete(planId);
  }
}

function closeBreakoutPlan(ctx: RequestContext, room: Room, plan: BreakoutPlan, reason: string): BreakoutPlan {
  if (plan.status === 'closed') return plan;
  plan.status = 'closed';
  plan.closedAt = Date.now();
  for (const info of plan.rooms) {
    info.status = 'closed';
    ctx.rooms.close(info.roomId, 'breakout_closed');
  }
  clearBreakoutTimer(plan.id);
  room.broadcast({ type: 'breakout.closed', plan } as ServerMessage);
  audit(ctx, {
    type: 'breakout.closed',
    severity: 'info',
    tenantId: room.tenantId,
    roomId: room.id,
    ip: ctx.ip,
    message: `Breakout rooms closed (${reason})`,
    details: { planId: plan.id, rooms: plan.rooms.length, reason },
  });
  return plan;
}

/** Lazily closes an expired plan (duration timer as a backstop). */
function expireBreakout(ctx: RequestContext, room: Room): void {
  const plan = room.breakoutPlan;
  if (plan && plan.status === 'active' && plan.endsAt && plan.endsAt <= Date.now()) {
    closeBreakoutPlan(ctx, room, plan, 'duration_expired');
  }
}

function scheduleBreakoutClose(ctx: RequestContext, room: Room, plan: BreakoutPlan): void {
  clearBreakoutTimer(plan.id);
  if (!plan.endsAt) return;
  const delay = Math.max(0, plan.endsAt - Date.now());
  const timer = setTimeout(() => {
    breakoutTimers.delete(plan.id);
    if (room.closed || !room.breakoutPlan || room.breakoutPlan.id !== plan.id) return;
    if (room.breakoutPlan.status !== 'active') return;
    try {
      closeBreakoutPlan(ctx, room, room.breakoutPlan, 'duration_expired');
    } catch {
      /* audit/broadcast must never crash the timer */
    }
  }, delay);
  timer.unref?.();
  breakoutTimers.set(plan.id, timer);
}

function distributeParticipants(participants: Participant[], roomGroups: Participant[][]): void {
  for (let index = 0; index < participants.length; index += 1) {
    roomGroups[index % roomGroups.length]!.push(participants[index]!);
  }
}

function breakoutStartHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const roomId = ctx.params.roomId as string;
    const room = ctx.rooms.get(roomId);
    if (!room) throw new HttpError(404, 'not_found', 'Room not found');
    requireRoomModerator(ctx, room);
    expireBreakout(ctx, room);
    if (room.breakoutPlan?.status === 'active') throw new HttpError(409, 'breakout_active', 'Breakout rooms are already active');

    const participants = room.participants();
    if (participants.length < 2) throw new HttpError(409, 'not_enough_participants', 'At least two participants are required');
    const body = await ctx.jsonSchema(createBreakoutSchema);
    const mode = body.mode ?? 'random';
    const requestedRooms = body.rooms;
    if (requestedRooms && (requestedRooms.length < 2 || requestedRooms.length > 20)) {
      throw new HttpError(400, 'validation_failed', 'Breakout rooms must be 2..20');
    }
    const roomCount = requestedRooms?.length ?? body.count ?? 2;
    if (roomCount < 2 || roomCount > 20) throw new HttpError(400, 'validation_failed', 'Breakout count must be 2..20');

    const byId = new Map(participants.map((participant) => [participant.id, participant]));
    const groups: Participant[][] = Array.from({ length: requestedRooms?.length ?? roomCount }, () => []);
    if (mode === 'manual') {
      if (!requestedRooms) throw new HttpError(400, 'validation_failed', 'Manual mode requires rooms[]');
      const assignedIds = new Set<string>();
      requestedRooms.forEach((group, index) => {
        for (const id of group.participantIds ?? []) {
          const participant = byId.get(id);
          if (!participant) throw new HttpError(400, 'validation_failed', `Unknown participant: ${id}`);
          if (assignedIds.has(id)) throw new HttpError(400, 'validation_failed', `Duplicate participant: ${id}`);
          assignedIds.add(id);
          groups[index]!.push(participant);
        }
      });
      const remaining = participants.filter((participant) => !assignedIds.has(participant.id));
      distributeParticipants(remaining, groups);
    } else {
      distributeParticipants(participants, groups);
    }
    // A huge input could leave empty groups — keep them (host can rename), but ensure
    // every group has at least one participant when possible.
    for (const group of groups) {
      if (group.length === 0) {
        const candidate = participants.find((participant) => !groups.some((other) => other.some((member) => member.id === participant.id)));
        if (candidate) group.push(candidate);
      }
    }

    const planId = randomUUID();
    const assignmentMessages: Array<{ participant: Participant; info: BreakoutRoomInfo; assignment: BreakoutAssignedMessage }> = [];
    const rooms: BreakoutRoomInfo[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index]!;
      const name = requestedRooms?.[index]?.name?.slice(0, 80) || `Подкомната ${index + 1}`;
      const child = ctx.rooms.create({
        tenantId: room.tenantId,
        name,
        maxParticipants: Math.max(2, group.length + 5),
        ...(room.ttlSec > 0 ? { ttlSec: room.ttlSec } : {}),
        mode: 'group',
        mediaMode: room.mediaMode,
        breakoutParentId: room.id,
        ...(room.allowedParticipantIds ? { allowedParticipantIds: group.map((participant) => participant.id) } : {}),
        context: { title: name, messenger: 'breakout' },
      });
      const info: BreakoutRoomInfo = {
        id: randomUUID(),
        roomId: child.id,
        name,
        index,
        participantIds: group.map((participant) => participant.id),
        status: 'open',
      };
      rooms.push(info);
      for (const participant of group) {
        const connection = room.member(participant.id)?.connection;
        const issued = issueToken(ctx.env, {
          participantId: participant.id,
          name: participant.name,
          role: participant.role,
          tenantId: room.tenantId,
          roomId: child.id,
          ...(connection?.roleId ? { roleId: connection.roleId } : {}),
        });
        const links = buildRoomLinks(ctx.env, { roomId: child.id, tenantId: room.tenantId, token: issued.token }, requestOrigin(ctx, room.tenantId));
        assignmentMessages.push({
          participant,
          info,
          assignment: {
            planId,
            breakoutRoomId: info.id,
            roomId: child.id,
            name,
            token: issued.token,
            joinUrl: links.joinUrl,
          },
        });
      }
    }

    const plan: BreakoutPlan = {
      id: planId,
      mainRoomId: room.id,
      status: 'active',
      mode,
      rooms,
      assignments: Object.fromEntries(
        assignmentMessages.map((entry) => [entry.participant.id, entry.info.id]),
      ),
      allowReturn: body.allowReturn ?? true,
      createdAt: Date.now(),
      ...(body.durationMin ? { endsAt: Date.now() + body.durationMin * 60_000 } : {}),
    };
    room.breakoutPlan = plan;
    room.broadcast({ type: 'breakout.started', plan } as ServerMessage);
    for (const entry of assignmentMessages) {
      const member = room.member(entry.participant.id);
      try {
        member?.connection.send({ type: 'breakout.assigned', assignment: entry.assignment } as ServerMessage);
      } catch {
        /* participant disconnected between snapshot and send */
      }
    }
    audit(ctx, {
      type: 'breakout.started',
      severity: 'info',
      tenantId: room.tenantId,
      roomId: room.id,
      ip: ctx.ip,
      message: `Breakout rooms started (${rooms.length} rooms)`,
      details: { planId, mode, rooms: rooms.length, participants: assignmentMessages.length, ...(plan.endsAt ? { endsAt: plan.endsAt } : {}) },
    });
    scheduleBreakoutClose(ctx, room, plan);
    ctx.send(200, plan);
  })();
}

function breakoutListHandler(ctx: RequestContext): void {
  const roomId = ctx.params.roomId as string;
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  requireRoomModerator(ctx, room);
  expireBreakout(ctx, room);
  const response: BreakoutListResponse = { roomId: room.id, ...(room.breakoutPlan ? { plan: room.breakoutPlan } : {}) };
  ctx.send(200, response);
}

function breakoutCloseHandler(ctx: RequestContext): void {
  const roomId = ctx.params.roomId as string;
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  requireRoomModerator(ctx, room);
  expireBreakout(ctx, room);
  if (!room.breakoutPlan) throw new HttpError(404, 'not_found', 'No breakout plan for this room');
  const plan = closeBreakoutPlan(ctx, room, room.breakoutPlan, 'host_closed');
  ctx.send(200, plan);
}

function breakoutReturnHandler(ctx: RequestContext): void {
  const roomId = ctx.params.roomId as string;
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  const claims = verifyAuthToken(ctx.env, bearerToken(ctx.headers));
  if (!claims) throw new HttpError(401, 'unauthorized', 'Participant join token is required');
  if (claims.tenantId !== room.tenantId || claims.roomId !== room.id) {
    throw new HttpError(403, 'forbidden', 'Token does not belong to this room');
  }
  expireBreakout(ctx, room);
  const plan = room.breakoutPlan;
  if (!plan) throw new HttpError(404, 'not_found', 'No breakout plan for this room');
  if (plan.status === 'active' && !plan.allowReturn) {
    throw new HttpError(403, 'forbidden', 'Returning from breakout rooms is disabled by the host');
  }
  audit(ctx, {
    type: 'admin.action',
    severity: 'info',
    tenantId: room.tenantId,
    roomId: room.id,
    participantId: claims.sub,
    ip: ctx.ip,
    message: 'Participant returned from breakout room',
    details: { kind: 'breakout.returned', planId: plan.id },
  });
  ctx.send(200, { returnToRoomId: room.id });
}

/* ------------------------------------------------------------------ */
/* Polls / Q&A                                                         */
/* ------------------------------------------------------------------ */

function pollHttpError(error: unknown): never {
  if (error instanceof RoomPollError) {
    const status = error.code === 'poll_not_found' ? 404 : error.code === 'poll_closed' ? 409 : 409;
    throw new HttpError(status, error.code, error.message);
  }
  throw error;
}

/** Room-scoped viewer for poll lists: a participant join token or the tenant admin key. */
function pollViewer(ctx: RequestContext, room: Room): { participantId?: string; role?: Role } {
  const raw = bearerToken(ctx.headers);
  if (raw) {
    const claims = verifyAuthToken(ctx.env, raw);
    if (!claims) throw new HttpError(401, 'unauthorized', 'Invalid access token');
    if (claims.tenantId !== room.tenantId || claims.roomId !== room.id) {
      throw new HttpError(403, 'forbidden', 'Token does not belong to this room');
    }
    return { participantId: claims.sub, role: claims.role };
  }
  const keyTenant = requireApiKeyTenant(ctx);
  requireTenantMatch(keyTenant, room.tenantId);
  return {};
}

function broadcastPoll(ctx: RequestContext, room: Room, poll: RoomPoll, reason: 'created' | 'voted' | 'closed'): void {
  room.broadcast({ type: 'poll.updated', roomId: room.id, poll, reason } as ServerMessage);
  void ctx;
}

function pollsListHandler(ctx: RequestContext): void {
  const roomId = ctx.params.roomId as string;
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  const viewer = pollViewer(ctx, room);
  const response: PollListResponse = {
    roomId: room.id,
    polls: room.pollRecords().map((poll) => room.pollView(poll, viewer.participantId)),
  };
  ctx.send(200, response);
}

function pollCreateHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const roomId = ctx.params.roomId as string;
    const room = ctx.rooms.get(roomId);
    if (!room) throw new HttpError(404, 'not_found', 'Room not found');
    requireRoomModerator(ctx, room);
    const body = await ctx.jsonSchema(createPollSchema);
    let created;
    try {
      const claims = bearerToken(ctx.headers) ? verifyAuthToken(ctx.env, bearerToken(ctx.headers)) : null;
      created = room.createPoll({
        question: body.question,
        options: body.options,
        multiple: body.multiple ?? false,
        anonymous: body.anonymous ?? true,
        kind: body.kind ?? 'poll',
        createdBy: {
          id: claims?.sub ?? 'admin',
          name: claims?.name ?? 'Администратор',
          role: claims?.role ?? 'host',
        },
      });
    } catch (error) {
      pollHttpError(error);
    }
    const poll = room.pollView(created);
    audit(ctx, {
      type: 'poll.created',
      severity: 'info',
      tenantId: room.tenantId,
      roomId: room.id,
      ip: ctx.ip,
      message: `Poll created: ${poll.question.slice(0, 120)}`,
      details: { pollId: poll.id, kind: poll.kind, options: poll.options.length, multiple: poll.multiple },
    });
    broadcastPoll(ctx, room, poll, 'created');
    ctx.send(200, poll);
  })();
}

function pollVoteHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const roomId = ctx.params.roomId as string;
    const pollId = String(ctx.params.pollId ?? '');
    const room = ctx.rooms.get(roomId);
    if (!room) throw new HttpError(404, 'not_found', 'Room not found');
    const raw = bearerToken(ctx.headers);
    const claims = verifyAuthToken(ctx.env, raw);
    if (!claims) throw new HttpError(401, 'unauthorized', 'Participant join token is required to vote');
    if (claims.tenantId !== room.tenantId || claims.roomId !== room.id) {
      throw new HttpError(403, 'forbidden', 'Token does not belong to this room');
    }
    const body = await ctx.jsonSchema(votePollSchema);
    if (!room.pollRecord(pollId)) throw new HttpError(404, 'poll_not_found', 'Poll not found');
    let outcome;
    try {
      outcome = room.votePoll(pollId, claims.sub, body.optionIds);
    } catch (error) {
      pollHttpError(error);
    }
    const record = room.pollRecord(pollId)!;
    const poll = room.pollView(record, claims.sub);
    if (outcome.accepted) {
      audit(ctx, {
        type: 'poll.voted',
        severity: 'info',
        tenantId: room.tenantId,
        roomId: room.id,
        participantId: claims.sub,
        ip: ctx.ip,
        message: `Vote recorded for poll ${pollId}`,
        details: { pollId, options: body.optionIds.length },
      });
      broadcastPoll(ctx, room, room.pollView(record), 'voted');
    }
    const response: PollVoteResponse = { poll, accepted: outcome.accepted, ...(outcome.reason ? { reason: outcome.reason } : {}) };
    ctx.send(200, response);
  })();
}

function pollCloseHandler(ctx: RequestContext): void {
  const roomId = ctx.params.roomId as string;
  const pollId = String(ctx.params.pollId ?? '');
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  requireRoomModerator(ctx, room);
  let record;
  try {
    record = room.closePoll(pollId);
  } catch (error) {
    pollHttpError(error);
  }
  const poll = room.pollView(record);
  audit(ctx, {
    type: 'poll.closed',
    severity: 'info',
    tenantId: room.tenantId,
    roomId: room.id,
    ip: ctx.ip,
    message: `Poll closed: ${poll.question.slice(0, 120)}`,
    details: { pollId, totalVotes: poll.totalVotes },
  });
  broadcastPoll(ctx, room, poll, 'closed');
  ctx.send(200, poll);
}

/* ------------------------------------------------------------------ */
/* Calendar export (.ics)                                              */
/* ------------------------------------------------------------------ */

function escapeIcs(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function icsDate(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function calendarHandler(ctx: RequestContext): void {
  const roomId = ctx.params.roomId as string;
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  const startRaw = ctx.query.get('start');
  const start = startRaw ? Date.parse(startRaw) : Date.now();
  if (!Number.isFinite(start)) throw new HttpError(400, 'validation_failed', 'Invalid start date (use ISO 8601)');
  const durationMin = Math.min(1440, Math.max(15, intQuery(ctx.query, 'durationMin', 60, 15, 1440)));
  const end = start + durationMin * 60_000;
  const links = buildRoomLinks(ctx.env, { roomId: room.id, tenantId: room.tenantId }, requestOrigin(ctx, room.tenantId));
  let host = 'agil-calls';
  try {
    host = new URL(ctx.env.publicOrigin).host || host;
  } catch {
  }
  const uid = `${room.id}@${host}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AgilFrame//Video meetings//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${escapeIcs(room.name)}`,
    `DESCRIPTION:${escapeIcs(`Видеозвонок AgilFrame. Ссылка для входа: ${links.joinUrl}`)}`,
    `LOCATION:${escapeIcs(links.joinUrl)}`,
    `URL:${links.joinUrl}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ];
  const headers: Record<string, string> = {
    'content-type': 'text/calendar; charset=utf-8',
    'cache-control': 'no-store',
  };
  const download = (ctx.query.get('download') ?? '').toLowerCase();
  if (download === '1' || download === 'true' || download === 'yes') {
    headers['content-disposition'] = `attachment; filename="${room.id}.ics"`;
  }
  ctx.sendRaw(200, Buffer.from(lines.join('\r\n'), 'utf8'), headers);
}

/**
 * `GET /v1/host` — public host -> tenant resolution used by `/embed.html` and
 * the landing so the same build serves tenant branding on any verified domain.
 * Unknown/invalid hosts resolve to the default tenant (never a 4xx): a stale
 * DNS record must not break the app shell.
 */
function hostHandler(ctx: RequestContext): void {
  const record = ctx.hostTenantId ? ctx.domains.getForTenant(ctx.hostTenantId) : null;
  const tenantId = record?.tenantId ?? ctx.env.defaultTenantId;
  const branding = ctx.tenants.getConfig(tenantId).branding;
  const response: HostInfoResponse = {
    host: ctx.host,
    tenantId,
    defaultTenantId: ctx.env.defaultTenantId,
    resolved: record ? 'domain' : 'default',
    customDomain: record?.domain ?? '',
    verified: Boolean(record && record.status === 'verified'),
    branding: {
      productName: branding.productName,
      organizationName: branding.organizationName,
      logoUrl: branding.logoUrl,
      faviconUrl: branding.faviconUrl,
      supportUrl: branding.supportUrl,
      footerText: branding.footerText,
    },
  };
  ctx.send(200, response);
}

/**
 * `GET /v1/domain/ask?domain=` — approval hook for on-demand TLS
 * (Caddy `on_demand_tls { ask ... }`, HAProxy ACL/backend). 200 = the domain is
 * verified for some tenant; 404 = unknown/unverified (certificate refused).
 *
 * Proxy-only certificate gate (docs/pilot/domain-tls.md §4B). Protections:
 * 1. host allowlist `AGIL_DOMAIN_ASK_HOSTS` (default loopback/localhost);
 * 2. mandatory secret `AGIL_DOMAIN_ASK_SECRET` (empty = 403, hook disabled);
 * 3. failed secrets limited per client (`ctx.ipHash`), not on the proxy bucket;
 * 4. TCP-peer IP allowlist `AGIL_DOMAIN_ASK_ALLOW_IPS` (all-invalid = fail closed);
 * 5. per-peer rate limit for authenticated approvals only.
 * The body omits `tenantId` on purpose: a certificate check only needs 200/404.
 */
function domainAskHandler(ctx: RequestContext): void {
  if (!domainAskHostAllowed(ctx.env.domainAskHosts, ctx.host)) {
    throw new HttpError(403, 'forbidden', 'Domain approval is not available on this host');
  }
  const secret = ctx.env.domainAskSecret;
  if (!secret) {
    // Fail closed: without a secret the public site block can forward external
    // requests to this path, and they would be indistinguishable from the proxy.
    throw new HttpError(403, 'forbidden', 'Domain approval is not configured');
  }
  const headerSecret = ctx.headers['x-agil-domain-ask-secret'];
  const provided =
    (typeof headerSecret === 'string' ? headerSecret : Array.isArray(headerSecret) ? (headerSecret[0] ?? '') : '') ||
    (ctx.query.get('key') ?? '');
  if (!secureCompare(provided, secret)) {
    // Bound guesses per client; never on the shared proxy bucket (DoS guard).
    assertRateLimit(
      ctx.services.limiters.domainAsk.check(`domain-ask-auth-fail:${ctx.ipHash}`),
      ctx,
      'Too many domain approval attempts',
    );
    throw new HttpError(403, 'forbidden', 'Domain approval secret is missing or invalid');
  }
  // The ACL identifies the proxy socket, not the end client.
  const peerIp = normalizeIp(ctx.req.socket?.remoteAddress ?? '');
  const allowlist = ctx.env.domainAskAllowIps;
  // `isIpAllowed` treats an empty rule set as allow-all. For this gate that is
  // never acceptable: an empty or all-invalid allowlist would make it public.
  if (allowlist.length === 0 || parseAllowlist(allowlist).length === 0) {
    throw new HttpError(403, 'forbidden', 'Domain approval is not configured with a valid proxy allowlist');
  }
  if (!isIpAllowed(peerIp, allowlist)) {
    throw new HttpError(403, 'forbidden', 'Domain approval is available only to the reverse proxy');
  }
  assertRateLimit(
    ctx.services.limiters.domainAsk.check(`domain-ask:${hashIp(peerIp, ctx.env.ipSalt)}`),
    ctx,
    'Too many domain approval requests',
  );
  const raw = ctx.query.get('domain') ?? '';
  const parsed = parseDomain(raw);
  if (!parsed.ok || !parsed.domain) throw new HttpError(400, 'validation_failed', 'Invalid domain');
  const record = ctx.domains.resolveHost(parsed.domain);
  if (!record) throw new HttpError(404, 'not_found', 'Domain is not verified for this server');
  const response: DomainAskResponse = { allowed: true, domain: record.domain };
  ctx.send(200, response);
}

/** Lowercase host without brackets/port, matching `RequestContext.host`. */
function normalizeAskHost(raw: string): string {
  let value = raw.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed?.[1]) return bracketed[1];
  // `localhost:8787` / `127.0.0.1:8787`; bare IPv6 (`::1`) has no match here.
  const hostPort = /^([^:]+):\d{1,5}$/.exec(value);
  if (hostPort?.[1]) value = hostPort[1];
  return value;
}

function domainAskHostAllowed(allowedHosts: readonly string[], host: string): boolean {
  const normalized = normalizeAskHost(host);
  if (!normalized) return false;
  return allowedHosts.some((entry) => {
    const value = entry.trim();
    return value === '*' || normalizeAskHost(value) === normalized;
  });
}

/** Constant-time string comparison (sha256-normalised, never throws). */
function secureCompare(left: string, right: string): boolean {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length === 0 || right.length === 0) return false;
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function healthHandler(ctx: RequestContext): void {
  const config = ctx.tenants.getConfig(ctx.env.defaultTenantId);
  const scale = config.scale;
  const security = {
    geoEnabled: ctx.env.geoProvider !== 'none' && config.security.geo.enabled,
    integrityEnabled: config.security.mediaIntegrity.enabled,
    sttConfigured: ctx.providers.sttConfigured(ctx.env.defaultTenantId),
    sttProvider: ctx.env.sttProvider,
    translationProvider: ctx.env.translateProvider,
    privacyMode: ctx.env.privacyMode,
    aiAgentConfigured: aiAgentConfigured(config),
    recordingsDir: ctx.services.dirs.recordings,
    docsEnabled: ctx.env.docsEnabled,
    adminApiEnabled: ctx.env.adminApiEnabled,
    mcpHttpEnabled: ctx.env.mcpHttpEnabled,
    // Scale-out flags (declared capability; orchestration is not implemented).
    mediaMode: roomMediaMode(scale, undefined),
    scaleConfigured: Boolean(scale.signaling.redisUrl.trim() || scale.sfu.url.trim() || scale.turn.length > 0),
  } as HealthResponse['security'];
  const response: HealthResponse = {
    ok: true,
    name: SERVER_NAME,
    version: SERVER_VERSION,
    uptimeSec: Math.max(0, Math.round((Date.now() - ctx.startedAt) / 1000)),
    rooms: ctx.rooms.size,
    tenants: ctx.tenants.listTenants().length,
    security,
  };
  ctx.send(200, response);
}

function iceHandler(ctx: RequestContext): void {
  ctx.send(200, { iceServers: resolvePublicStunServers(ctx.env) });
}

function getConfigHandler(ctx: RequestContext): void {
  const tenantId = assertTenantId(ctx.params.tenantId as string);
  if (ctx.tenants.isRetired(tenantId)) throw new HttpError(404, 'not_found', 'Tenant not found');
  const entry = ctx.tenants.getEntry(tenantId);
  // The stored config keeps the tenant value; the response carries the
  // deployment-effective capacity profile (`AGIL_SFU_PROFILE` wins) so the
  // widget can size its gallery budget without a second request.
  ctx.send(200, { config: applySfuCapacityProfile(ctx.env, entry.config), etag: entry.etag });
}

function requireConfigAdmin(ctx: RequestContext): string {
  const keyTenant = requireApiKeyTenant(ctx);
  const tenantId = assertTenantId(ctx.params.tenantId as string);
  requireTenantMatch(keyTenant, tenantId);
  return tenantId;
}

async function putConfigHandler(ctx: RequestContext): Promise<void> {
  const tenantId = requireConfigAdmin(ctx);
  // Tenant config is a per-Core file, not replicated: a standby must not
  // diverge from the leader (docs/ha-leader.md).
  ctx.cluster.assertLeader('tenant configuration updates');
  const body = await ctx.json();
  const entry = ctx.tenants.putConfig(tenantId, body);
  audit(ctx, {
    type: 'config.updated',
    severity: 'info',
    tenantId,
    message: `Config replaced (etag ${entry.etag.slice(0, 12)})`,
    details: { method: 'PUT', etag: entry.etag, ip: undefined },
  });
  ctx.send(200, { config: entry.config, etag: entry.etag });
}

async function patchConfigHandler(ctx: RequestContext): Promise<void> {
  const tenantId = requireConfigAdmin(ctx);
  ctx.cluster.assertLeader('tenant configuration updates');
  const body = await ctx.json<Record<string, unknown>>();
  const editorDraft = body && typeof body === 'object' && Object.hasOwn(body, 'editorDraft');
  if (editorDraft) {
    if (Object.keys(body).some((key) => key !== 'editorDraft' && key !== 'baseEtag')) {
      throw new HttpError(400, 'validation_failed', 'An editor draft cannot be combined with a partial config update');
    }
    if (Object.hasOwn(body, 'baseEtag')) {
      const baseEtag = body.baseEtag;
      if (typeof baseEtag !== 'string' || !/^[a-f0-9]{64}$/.test(baseEtag)) {
        throw new HttpError(400, 'validation_failed', 'Invalid baseEtag');
      }
      // Keep this comparison and the synchronous commit on the same leader turn.
      if (ctx.tenants.getEtag(tenantId) !== baseEtag) {
        throw new HttpError(409, 'config_conflict', 'The organization configuration has changed');
      }
    }
  }
  const patch = editorDraft ? body.editorDraft : body;
  const entry = ctx.tenants.patchConfig(tenantId, patch, { editorDraft: Boolean(editorDraft) });
  const mediaPolicy = typeof patch === 'object' && patch !== null && 'mediaProcessing' in patch
    ? patch.mediaProcessing : undefined;
  const mediaStatus = mediaPolicy !== undefined ? mediaProcessingStatus(entry.config, ctx.env) : undefined;
  audit(ctx, {
    type: 'config.updated',
    severity: 'info',
    tenantId,
    message: `Config patched (etag ${entry.etag.slice(0, 12)})`,
    details: {
      method: 'PATCH',
      etag: entry.etag,
      ...(mediaStatus
        ? {
            kind: 'media.processing.updated',
            mode: mediaStatus.policy.mode,
            serverProcessingActive: mediaStatus.serverProcessingActive,
            misconfigured: mediaStatus.misconfigured,
          }
        : {}),
    },
  });
  ctx.send(200, {
    config: entry.config,
    etag: entry.etag,
    ...(editorDraft ? { editorDraftPublished: true } : {}),
    ...(mediaStatus
      ? {
          mediaProcessing: mediaStatus,
          ...(mediaStatus.misconfigured
            ? { warning: 'server-assisted без включённых компонентов: серверная обработка не активируется' }
            : {}),
        }
      : {}),
  });
}

async function createRoomHandler(ctx: RequestContext): Promise<void> {
  // Rooms live in this process's memory and are not replicated: only the
  // leader Core may create them; a standby answers 409 not_leader.
  ctx.cluster.assertLeader('room creation');
  const body = await ctx.jsonSchema(createRoomSchema);
  const providedKey = header(ctx.headers, 'x-api-key');
  let tenantId: string;
  let authenticated = false;
  if (providedKey) {
    const keyTenant = apiKeyTenant(ctx.env, ctx.headers);
    if (!keyTenant) throw new HttpError(401, 'unauthorized', 'Missing or invalid x-api-key');
    tenantId = keyTenant;
    authenticated = true;
  } else {
    if (!ctx.env.allowAnonymous) {
      throw new HttpError(401, 'unauthorized', 'Room creation requires an API key (x-api-key)');
    }
    // A verified custom domain is the anonymous default tenant for this host;
    // an explicit body.tenantId still wins (documented `?tenant=` fallback).
    tenantId = body.tenantId ?? ctx.hostTenantId ?? ctx.env.defaultTenantId;
  }
  assertTenantId(tenantId);
  if (ctx.tenants.isRetired(tenantId)) throw new HttpError(404, 'not_found', 'Tenant not found');
  if (body.allowedParticipantIds && !authenticated) {
    throw new HttpError(401, 'unauthorized', 'Restricted rooms require an API key');
  }
  const baseConfig = ctx.tenants.getConfig(tenantId);
  if (!authenticated) {
    assertRateLimit(checkPublicAbuse(ctx.services, ctx.logger, {
      mode: baseConfig.security.publicAbuseMode ?? ctx.env.publicAbuseDefaultMode,
      action: 'room.create',
      tenantId,
      ipHash: ctx.ipHash,
    }), ctx, PUBLIC_ABUSE_MESSAGE);
  }
  const overrides = body.configOverrides;
  let configOverrides: CreateRoomRequest['configOverrides'] | undefined;
  if (overrides !== undefined) {
    // Validate deep-partial overrides before they are stored on the room.
    const { tenantConfigPatchSchema } = await import('@agil/protocol');
    const parsed = tenantConfigPatchSchema.safeParse(overrides);
    if (!parsed.success) {
      throw new HttpError(400, 'validation_failed', zodErrorMessage(parsed.error), parsed.error.issues);
    }
    // Room overrides do not pass through TenantStore, so enforce the SIP
    // SSRF/TLS policy here — before the room (and its effective config) exists.
    // This also covers anonymous room creation (`AGIL_ALLOW_ANONYMOUS=1`).
    assertConfigOverrideEndpoints(parsed.data, ctx.env);
    configOverrides = parsed.data as CreateRoomRequest['configOverrides'];
  }
  let passwordHash: string | undefined;
  if (body.password) passwordHash = hashPassword(body.password);
  const mode = body.mode ?? 'group';
  // Explicit P2P is valid only for a 1:1 room; resolve it before capacity,
  // billing or egress work so an unsupported combination fails fast (409).
  const transport = resolveDirectTransport({
    transport: body.transport,
    mode,
    maxParticipants: body.maxParticipants,
    config: baseConfig,
    configOverrides,
  });
  const scale = baseConfig.scale;
  const mediaMode = transport.mediaMode ?? roomMediaMode(scale, mode);
  const roomDefault = configOverrides?.limits?.maxParticipants ?? baseConfig.limits.maxParticipants;
  let maxParticipants = transport.maxParticipants ?? body.maxParticipants ?? (mode === 'direct' ? 2 : roomDefault);
  maxParticipants = Math.min(maxParticipants, 50000);
  if (mode === 'direct') maxParticipants = Math.min(maxParticipants, 2);
  const requestedMaxParticipants = maxParticipants;
  // Billing plan caps the per-room participant limit while enforcement is on.
  maxParticipants = planParticipantCap(baseConfig.billing, maxParticipants);
  // The media plane is the second hard cap: a room must not promise more seats
  // than the effective capacity profile / configured SFU can carry.
  maxParticipants = capRoomParticipantsForSfu(ctx.env, baseConfig, mediaMode, maxParticipants);
  const capacity = roomCapacityInfo(ctx.env, baseConfig, mediaMode, maxParticipants);

  // Billing quota (opt-in; default free/off): block or warn before creating.
  const billingCounts = tenantUsageCounts(ctx.rooms, tenantId);
  const createQuota = evaluateRoomCreateQuota({
    billing: baseConfig.billing,
    usage: ctx.services.billing.getUsage(tenantId),
    liveMinutes: ctx.services.billing.liveMinutes(tenantId),
    activeRooms: billingCounts.activeRooms,
  });
  if (!createQuota.allowed) {
    audit(ctx, {
      type: 'admin.action',
      severity: 'warn',
      tenantId,
      ip: ctx.ip,
      message: `Room creation blocked by billing quota (${createQuota.blocked?.metric})`,
      details: {
        kind: 'billing.quota.blocked',
        metric: createQuota.blocked?.metric,
        used: createQuota.blocked?.used,
        limit: createQuota.blocked?.limit,
        policy: createQuota.blocked?.policy,
      },
    });
    throw new HttpError(402, 'quota_exceeded', createQuota.blocked?.message ?? 'Billing quota exceeded', {
      metric: createQuota.blocked?.metric,
      used: createQuota.blocked?.used,
      limit: createQuota.blocked?.limit,
      policy: createQuota.blocked?.policy,
    });
  }

  if (ctx.tenants.isRetired(tenantId)) throw new HttpError(404, 'not_found', 'Tenant not found');
  let room;
  try {
    room = ctx.rooms.create({
      id: body.roomId,
      tenantId,
      name: (body.name ?? baseConfig.room.name).slice(0, 120) || 'Комната',
      maxParticipants,
      ttlSec: body.ttlSec ?? ctx.env.roomTtlSec,
      passwordHash,
      configOverrides,
      mode,
      mediaMode,
      allowedParticipantIds: body.allowedParticipantIds,
      ...(body.context ? { context: body.context } : {}),
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'invalid_room_id') throw new HttpError(400, 'validation_failed', 'Invalid room id');
    if (code === 'room_exists') throw new HttpError(409, 'validation_failed', 'Room already exists');
    throw error;
  }

  audit(ctx, {
    type: 'room.created',
    severity: 'info',
    tenantId,
    roomId: room.id,
    ip: ctx.ip,
    message: `Room created (${room.name})`,
    details: {
      authenticated,
      passwordProtected: Boolean(passwordHash),
      maxParticipants: room.maxParticipants,
      requestedMaxParticipants,
      capacityLimit: capacity.limit,
      capacityProfile: capacity.profile,
      ...(body.transport ? { transport: body.transport, mediaMode: room.mediaMode } : {}),
    },
  });

  // The demo flow returns a ready token when the room is not password protected;
  // password rooms get tokens through /join (password) or an admin invite.
  let token: string | undefined;
  let expiresAt: number | undefined;
  if (!passwordHash && !room.allowedParticipantIds) {
    const issued = issueToken(ctx.env, {
      participantId: randomUUID(),
      name: 'Организатор',
      role: 'host',
      tenantId,
      roomId: room.id,
    });
    token = issued.token;
    expiresAt = issued.expiresAt;
  }
  const links = buildRoomLinks(ctx.env, { roomId: room.id, tenantId, token }, requestOrigin(ctx, tenantId));
  const response: CreateRoomResponse = {
    room: room.info(),
    joinUrl: links.joinUrl,
    embedUrl: links.embedUrl,
    passwordProtected: Boolean(passwordHash),
    ...(token ? { token, expiresAt } : {}),
  };
  if (createQuota.warnings.length > 0) {
    response.billingWarning = createQuota.warnings[0];
    ctx.res.setHeader(BILLING_WARNING_HEADER, createQuota.warnings.map((warning) => warning.metric).join(','));
  }
  ctx.services.webhooks.emit('room.created', { tenantId, roomId: room.id }, {
    name: room.name,
    passwordProtected: Boolean(passwordHash),
    maxParticipants: room.maxParticipants,
    mode: room.mode,
    ...(body.transport ? { transport: body.transport, mediaMode: room.mediaMode } : {}),
    ...(room.context ? { context: room.context } : {}),
  });
  ctx.send(200, response);
}

async function createTokenHandler(ctx: RequestContext): Promise<void> {
  const keyTenant = requireApiKeyTenant(ctx);
  // Access tokens are issued by the leader only (enrollment/token mutations are
  // leader-only in HA; a standby returns 409 not_leader).
  ctx.cluster.assertLeader('access token issuance');
  const body = await ctx.jsonSchema(tokenRequestSchema);
  requireTenantMatch(keyTenant, body.tenantId);
  assertTenantId(body.tenantId);
  const room = ctx.rooms.get(body.roomId);
  if (!room || room.tenantId !== body.tenantId) throw new HttpError(404, 'not_found', 'Room not found');
  assertRateLimit(ctx.services.limiters.admin.check(`tokens:${keyTenant}`), ctx, 'Too many token requests');
  if (room.voiceChannel) throw new HttpError(403, 'forbidden', 'Use the voice-channel grant endpoint for this room');
  const config = ctx.tenants.getConfig(body.tenantId);
  const requestedRoleId = body.participant.roleId;
  const customRole = requestedRoleId ? findCustomRole(config, requestedRoleId) : undefined;
  if (requestedRoleId && !customRole) {
    throw new HttpError(400, 'validation_failed', `Unknown custom role: ${requestedRoleId}`);
  }
  const role: Role = customRole ? customRole.baseRole : (body.participant.role ?? 'guest');
  const roleId = customRole?.id;
  const participantId = body.participant.participantId ?? randomUUID();
  if (!room.allowsParticipant(body.participant.participantId)) {
    throw new HttpError(403, 'forbidden', 'This participant is not allowed in the room');
  }
  const tokenPermissions = body.permissions && body.permissions.length > 0 ? body.permissions : undefined;
  const permissions: FeatureKey[] = accessOf({
    config,
    role,
    userId: participantId,
    tokenPermissions,
    ...(roleId ? { roleId } : {}),
  }).allowed;
  const issued = issueToken(ctx.env, {
    participantId,
    name: body.participant.name,
    role,
    tenantId: body.tenantId,
    roomId: room.id,
    ttlSec: body.ttlSec,
    ...(tokenPermissions ? { permissions: tokenPermissions } : {}),
    ...(roleId ? { roleId } : {}),
  });
  audit(ctx, {
    type: 'admin.action',
    severity: 'info',
    tenantId: body.tenantId,
    roomId: room.id,
    message: `Access token issued for ${body.participant.name}`,
    details: { role, pinnedPermissions: tokenPermissions?.length ?? 0, effectivePermissions: permissions.length },
  });
  const response: TokenResponse = {
    token: issued.token,
    expiresAt: issued.expiresAt,
    tenantId: body.tenantId,
    roomId: room.id,
    permissions,
    ...(roleId && customRole ? { roleId: customRole.id, roleName: customRole.name } : {}),
  };
  ctx.send(200, response);
}

function getRoomHandler(ctx: RequestContext): void {
  const keyTenant = requireApiKeyTenant(ctx);
  const roomId = ctx.params.roomId as string;
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  requireTenantMatch(keyTenant, room.tenantId);
  ctx.send(200, {
    room: room.info() satisfies RoomInfo,
    participants: room.participants(),
    createdAt: room.createdAt,
  });
}

function deleteRoomHandler(ctx: RequestContext): void {
  ctx.cluster.assertLeader('room deletion');
  const keyTenant = requireApiKeyTenant(ctx);
  const roomId = ctx.params.roomId as string;
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  requireTenantMatch(keyTenant, room.tenantId);
  ctx.rooms.close(roomId, 'admin_closed');
  ctx.services.sttTranslation.clearTranslationCache();
  audit(ctx, {
    type: 'room.closed',
    severity: 'info',
    tenantId: room.tenantId,
    roomId,
    ip: ctx.ip,
    message: 'Room closed',
  });
  ctx.services.webhooks.emit('room.closed', { tenantId: room.tenantId, roomId }, { reason: 'admin_closed' });
  ctx.send(200, { closed: true });
}

async function messagesHandler(ctx: RequestContext): Promise<void> {
  const keyTenant = requireApiKeyTenant(ctx);
  ctx.res.setHeader('cache-control', 'private, no-store');
  const roomId = ctx.params.roomId as string;
  const room = ctx.rooms.get(roomId);
  const limit = intQuery(ctx.query, 'limit', 100, 1, 200);
  if (room) {
    requireTenantMatch(keyTenant, room.tenantId);
    ctx.send(200, { messages: await ctx.providers.chatHistory(room.tenantId, room.id, limit) });
    return;
  }
  const messages = await ctx.providers.archivedChatHistory(keyTenant, roomId, limit);
  if (!messages.length) throw new HttpError(404, 'not_found', 'Room chat history not found');
  ctx.send(200, { messages });
}

/* ------------------------------------------------------------------ */
/* Files / recordings / STT                                            */
/* ------------------------------------------------------------------ */

function uploadLimitBytes(env: Env, configMb: number): { bytes: number; mb: number } {
  const mb = Math.min(Math.max(1, Math.trunc(configMb || env.maxUploadMb)), env.maxUploadMb);
  return { bytes: mb * MB, mb };
}

function decodeFileName(raw: string): string {
  // Clients percent-encode header values (headers are ASCII-only in browsers).
  try {
    return decodeURIComponent(raw).slice(0, 500);
  } catch {
    return raw.slice(0, 500);
  }
}

async function uploadFileHandler(ctx: RequestContext): Promise<void> {
  // Files are stored on this Core's local volume and are not replicated; a
  // standby must not accept a blob it would lose on failover.
  ctx.cluster.assertLeader('file uploads');
  const claims = requireJoinToken(ctx.env, ctx.headers);
  assertRateLimit(ctx.services.limiters.files.check(`files:${claims.tenantId}`), ctx, 'Too many file uploads');
  const tenantConfig = ctx.tenants.getConfig(claims.tenantId);
  const room = ctx.rooms.get(claims.roomId);
  if (room) requireTenantMatch(claims.tenantId, room.tenantId);
  const config = room ? roomConfig(room, tenantConfig) : tenantConfig;
  if (!config.session.fileShare.enabled) {
    throw new HttpError(403, 'forbidden', 'File sharing is disabled for this room');
  }
  requireFeatureForParticipant(ctx, claims, tenantConfig, 'fileShare');
  if (config !== tenantConfig) requireFeatureForParticipant(ctx, claims, config, 'fileShare');
  const mime = normalizeMime(header(ctx.headers, 'content-type') ?? 'application/octet-stream');
  const allowedMimeTypes = config.session.fileShare.allowedMimeTypes;
  if (!mime || !isMimeAllowed(mime, allowedMimeTypes)) {
    throw new HttpError(415, 'unsupported_mime', 'This file type is not allowed');
  }
  const { bytes, mb } = uploadLimitBytes(ctx.env, config.session.fileShare.maxFileSizeMb);
  const body = await ctx.raw(bytes);
  const name = decodeFileName(header(ctx.headers, 'x-file-name') ?? 'file');
  const record: FileRecord = await ctx.providers.filesPut({
    data: body,
    name,
    mime,
    tenantId: claims.tenantId,
    roomId: claims.roomId,
    uploadedBy: claims.sub,
    maxSizeMb: mb,
    allowedMimeTypes,
  });
  // Malware scan hook (docs/liveness-av.md): async by default (answer first,
  // quarantine later); `mode:'sync'` blocks the upload. The tenant flag and the
  // deployment daemon (`AGIL_CLAMAV_*`/`AGIL_YARA_RULES`) must both be present.
  const scanPolicy = config.security.avScan;
  if (!scanPolicy.enabled) {
    // AV disabled (default): the file is stored and shared immediately.
    emitFileSharedWebhook(ctx, claims, record);
  } else {
    const outcome = await ctx.services.uploadScan.scan(
      {
        fileId: record.id,
        tenantId: claims.tenantId,
        roomId: claims.roomId,
        fileName: record.name,
        mime: record.mime,
        size: record.size,
        data: body,
        uploadedBy: claims.sub,
        remove: () => ctx.providers.filesRemove({ tenantId: claims.tenantId, id: record.id }),
      },
      scanPolicy,
    );
    if (scanPolicy.mode === 'sync') {
      if (outcome.status === 'infected') {
        throw new SecurityError('file_infected', 'File failed the antivirus scan and was quarantined');
      }
      // fail-closed means "no unscanned bytes are served": a quarantined
      // scan error must reject the upload too, instead of returning a record
      // whose download is already gone.
      if (outcome.quarantined) {
        throw new HttpError(
          503,
          'scan_unavailable',
          'File could not be scanned and was quarantined (security.avScan.onScanError=fail-closed)',
        );
      }
    }
    // `file.shared` and the critical quarantine events are emitted by the scan
    // service callbacks, exactly once, only when `outcome.blocked` is false;
    // emitting here too would double-deliver and, for `async`, pre-empt the verdict.
  }
  ctx.send(200, record);
}

/** Single `file.shared` webhook path for uploads that are not scanned at all. */
function emitFileSharedWebhook(ctx: RequestContext, claims: TokenClaims, record: FileRecord): void {
  ctx.services.webhooks.emit('file.shared', { tenantId: claims.tenantId, roomId: claims.roomId }, {
    fileId: record.id,
    name: record.name,
    mime: record.mime,
    size: record.size,
    uploadedBy: record.uploadedBy,
  });
}

const STORAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function requireStorageId(raw: string): string {
  if (!STORAGE_ID_RE.test(raw)) throw new HttpError(404, 'not_found', 'File not found');
  return raw;
}

async function downloadFileHandler(ctx: RequestContext): Promise<void> {
  const id = requireStorageId(ctx.params.id as string);
  const { sig, exp } = signatureParams(ctx.url);
  const tenantParam = ctx.query.get('tenant') ?? undefined;
  const found = await ctx.providers.filesGet({
    ...(tenantParam && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tenantParam) ? { tenantId: tenantParam } : {}),
    id,
    ...(sig ? { sig } : {}),
    ...(exp !== null ? { exp } : {}),
  });
  if (!found) throw new HttpError(403, 'forbidden', 'Invalid or expired link');
  // Defence in depth for the quarantine double-failure path: even if the live
  // copy could not be deleted, a blocked file id is never served.
  if (ctx.services.quarantine.isBlocked(found.record.tenantId, found.record.id)) {
    throw new HttpError(403, 'forbidden', 'File is not available');
  }
  // Signed URL is a capability, but the tenant feature flag still gates delivery
  // (UI and API must agree on whether file sharing is available).
  const ownerConfig = ctx.tenants.getConfig(found.record.tenantId);
  if (ownerConfig.features.fileShare !== true) {
    throw new HttpError(403, 'feature_disabled', "Feature 'fileShare' is disabled for this tenant");
  }
  ctx.sendRaw(200, found.data, {
    'content-type': found.record.mime,
    'cache-control': 'no-store',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(found.record.name)}`,
  });
}

async function uploadRecordingHandler(ctx: RequestContext): Promise<void> {
  // Recordings are written to this Core's local volume (or its provider) and
  // are not replicated; a standby must not accept them.
  ctx.cluster.assertLeader('recording uploads');
  const claims = requireJoinToken(ctx.env, ctx.headers);
  const rawMeta = header(ctx.headers, 'x-recording-meta');
  let meta: z.infer<typeof recordingMetaSchema>;
  if (!rawMeta) throw new HttpError(400, 'validation_failed', 'x-recording-meta header is required');
  let parsedMeta: unknown;
  try {
    parsedMeta = JSON.parse(rawMeta);
  } catch {
    throw new HttpError(400, 'validation_failed', 'x-recording-meta must be valid JSON');
  }
  const parsed = recordingMetaSchema.safeParse(parsedMeta);
  if (!parsed.success) throw new HttpError(400, 'validation_failed', zodErrorMessage(parsed.error));
  meta = parsed.data;
  if (meta.roomId !== claims.roomId) throw new HttpError(403, 'forbidden', 'Token does not belong to this room');
  const tenantConfig = ctx.tenants.getConfig(claims.tenantId);
  const room = ctx.rooms.get(meta.roomId);
  if (room) requireTenantMatch(claims.tenantId, room.tenantId);
  const config = room ? roomConfig(room, tenantConfig) : tenantConfig;
  if (!browserRecordingEnabled(config) || !config.session.recording.storeOnServer) {
    throw new HttpError(403, 'forbidden', 'Recording storage is disabled for this tenant');
  }
  requireFeatureForParticipant(ctx, claims, config, 'recording');
  assertRateLimit(ctx.services.limiters.files.check(`recordings:${claims.tenantId}`), ctx, 'Too many uploads');
  const body = await ctx.raw(ctx.env.maxRecordingMb * MB);
  const record: RecordingRecord = await ctx.providers.recordingSave({
    data: body,
    mime: meta.mimeType ?? header(ctx.headers, 'content-type') ?? 'video/webm',
    tenantId: claims.tenantId,
    roomId: claims.roomId,
    createdBy: claims.sub,
    durationSec: meta.durationSec ?? 0,
    maxSizeMb: ctx.env.maxRecordingMb,
  });
  audit(ctx, {
    type: 'recording.saved',
    severity: 'info',
    tenantId: claims.tenantId,
    roomId: claims.roomId,
    participantId: claims.sub,
    ip: ctx.ip,
    message: `Recording saved (${record.size} bytes, ${record.durationSec}s)`,
    details: { recordingId: record.id, size: record.size, durationSec: record.durationSec },
  });
  // Billing metering: recordings count + recorded minutes (no media content).
  try {
    ctx.services.billing.recordRecording(claims.tenantId, record.durationSec);
  } catch {
    /* metering must never fail the upload */
  }
  ctx.services.webhooks.emit('recording.ready', { tenantId: claims.tenantId, roomId: claims.roomId }, {
    recordingId: record.id,
    size: record.size,
    durationSec: record.durationSec,
    mime: record.mime,
    createdBy: record.createdBy,
  });
  ctx.providers.notify({
    type: 'recording.ready',
    tenantId: claims.tenantId,
    roomId: claims.roomId,
    message: `Recording saved (${record.durationSec}s)`,
    data: { recordingId: record.id, size: record.size },
  });
  ctx.send(200, record);
}

async function downloadRecordingHandler(ctx: RequestContext): Promise<void> {
  const id = requireStorageId(ctx.params.id as string);
  const { sig, exp } = signatureParams(ctx.url);
  const tenantParam = ctx.query.get('tenant') ?? undefined;
  const found = await ctx.providers.recordingGet({
    ...(tenantParam && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tenantParam) ? { tenantId: tenantParam } : {}),
    id,
    ...(sig ? { sig } : {}),
    ...(exp !== null ? { exp } : {}),
  });
  if (!found) throw new HttpError(403, 'forbidden', 'Invalid or expired link');
  const ownerConfig = ctx.tenants.getConfig(found.record.tenantId);
  if (ownerConfig.features.recording !== true) {
    throw new HttpError(403, 'feature_disabled', "Feature 'recording' is disabled for this tenant");
  }
  const extensions: Partial<Record<string, string>> = {
    'video/webm': 'webm', 'audio/webm': 'webm', 'video/mp4': 'mp4', 'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3', 'video/ogg': 'ogv', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
  };
  const extension = extensions[found.record.mime] ?? 'bin';
  ctx.sendRaw(200, found.data, {
    'content-type': found.record.mime,
    'cache-control': 'no-store',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`recording-${found.record.id}.${extension}`)}`,
  });
}

/** Room bound to a join token (404 when missing or owned by another tenant). */
function transcriptRoom(ctx: RequestContext, claims: TokenClaims): Room {
  const room = ctx.rooms.get(claims.roomId);
  if (!room || room.tenantId !== claims.tenantId) throw new HttpError(404, 'not_found', 'Room not found');
  return room;
}

/** 403 `consent_required` when tenant policy asks for explicit consent. */
function assertTranscriptConsent(ctx: RequestContext, claims: TokenClaims, room: Room): void {
  if (!ctx.services.sttTranslation.consentRequired(claims.tenantId)) return;
  if (!room.hasTranscriptConsent(claims.sub)) {
    throw new HttpError(
      403,
      'consent_required',
      'Transcription consent is required. POST /v1/rooms/:roomId/transcript/consent with {"granted":true}.',
    );
  }
}

function mapSttTranslationError(error: unknown): never {
  if (error instanceof SttTranslationError) throw new HttpError(error.status, error.code, error.message);
  throw error;
}

/** `x-chunk-offset: <seconds>` — absolute timestamps for third-party chunkers. */
export function parseChunkOffset(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new HttpError(400, 'invalid_chunk_offset', 'x-chunk-offset must be a non-negative number of seconds');
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) {
    throw new HttpError(400, 'invalid_chunk_offset', 'x-chunk-offset must be a non-negative number of seconds');
  }
  return Math.min(value, 86_400);
}

async function sttHandler(ctx: RequestContext): Promise<void> {
  const claims = requireJoinToken(ctx.env, ctx.headers);
  const provider = ctx.env.sttProvider;
  if (provider === 'browser' || provider === 'none') {
    throw new HttpError(
      501,
      'stt_not_configured',
      provider === 'browser'
        ? 'Server-side STT is disabled (STT_PROVIDER=browser): captions run in the browser Web Speech API.'
        : 'Server-side STT is disabled (STT_PROVIDER=none).',
    );
  }
  const local = provider === 'local';
  // Privacy mode is a hard contract: no external STT is allowed, even when a
  // remote provider is configured.
  if (ctx.env.privacyMode === 'local' && !local) {
    throw new HttpError(
      501,
      'stt_not_configured',
      'PRIVACY_MODE=local allows only STT_PROVIDER=local; remote/server STT is disabled.',
    );
  }
  if (!local && !ctx.providers.sttConfigured(claims.tenantId)) {
    throw new HttpError(
      501,
      'stt_not_configured',
      'Server-side STT is not configured (AGIL_STT_URL or providers.stt). Use the browser Web Speech API or configure the server STT.',
    );
  }
  // Server STT backs the captions feature: enforce the tenant flag and the
  // participant's effective permissions. Kept after the configuration check so
  // an unconfigured deployment answers the 501 hint instead of a misleading 403.
  requireFeatureForParticipant(ctx, claims, ctx.tenants.getConfig(claims.tenantId), 'captions');
  const room = ctx.rooms.get(claims.roomId);
  if (room && room.tenantId !== claims.tenantId) throw new HttpError(404, 'not_found', 'Room not found');
  const consentRequired = ctx.services.sttTranslation.consentRequired(claims.tenantId);
  // Consent must fail closed: a token for a closed/evicted room cannot prove a
  // stored consent record, so transcription is refused while consent is required.
  if (consentRequired && !room) {
    throw new HttpError(
      403,
      'consent_required',
      'Transcription consent cannot be verified because the room is no longer active. Rejoin an active room or ask the admin to disable consent for this tenant.',
    );
  }
  if (room) assertTranscriptConsent(ctx, claims, room);
  const consent = room?.transcriptConsent(claims.sub);
  const assertCurrentConsent = (): void => {
    if (!consentRequired && !ctx.services.sttTranslation.consentRequired(claims.tenantId)) return;
    const activeRoom = ctx.rooms.get(claims.roomId);
    // A re-grant creates a different consent even within the same millisecond.
    if (!consent || activeRoom !== room || activeRoom?.transcriptConsent(claims.sub) !== consent) {
      throw new HttpError(403, 'consent_required', 'Transcription consent changed while processing this audio.');
    }
  };
  assertRateLimit(ctx.services.limiters.stt.check(`stt:${claims.tenantId}`), ctx, 'Too many STT requests');
  const mime = (header(ctx.headers, 'content-type') ?? 'audio/webm').split(';')[0]?.trim().toLowerCase() ?? 'audio/webm';
  if (!['audio/webm', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mpeg', 'audio/mp4'].includes(mime)) {
    throw new HttpError(415, 'unsupported_mime', `Unsupported audio MIME type: ${mime}`);
  }
  const languageHeader = header(ctx.headers, 'x-language');
  const language = languageHeader === 'ru' || languageHeader === 'en' ? languageHeader : undefined;
  const translateHeader = header(ctx.headers, 'x-translate-to');
  const translateTo =
    translateHeader === 'none' || translateHeader === 'ru' || translateHeader === 'en' ? translateHeader : undefined;
  // Read the raw header: `header()` treats an empty value as absent, but an
  // explicitly sent empty `x-chunk-offset:` must be rejected as invalid.
  const rawChunkOffset = ctx.headers['x-chunk-offset'];
  const offsetSec = parseChunkOffset(Array.isArray(rawChunkOffset) ? rawChunkOffset[0] : rawChunkOffset);
  const body = await ctx.raw(25 * MB);
  assertCurrentConsent();

  if (local) {
    try {
      const result = await ctx.services.sttTranslation.transcribe({
        tenantId: claims.tenantId,
        audio: body,
        mime,
        ...(language ? { language } : {}),
        ...(translateTo ? { translateTo } : {}),
        ...(offsetSec !== undefined ? { offsetSec } : {}),
      });
      assertCurrentConsent();
      ctx.send(200, result);
    } catch (error) {
      if (error instanceof HttpError && error.code === 'consent_required') throw error;
      ctx.logger.warn('local stt request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      mapSttTranslationError(error);
    }
    return;
  }

  const sttNodeId = ctx.tenants.getConfig(claims.tenantId).session.transcription.nodeId;
  if (sttNodeId && !ctx.cluster.getNode(claims.tenantId, sttNodeId)?.availableModules?.includes('stt')) {
    throw new HttpError(503, 'stt_node_unavailable', 'Узел распознавания речи недоступен. Проверьте модуль STT в разделе «Инфраструктура».');
  }
  try {
    const result = await ctx.providers.sttTranscribe({
      tenantId: claims.tenantId,
      audio: body,
      mime,
      ...(language ? { language } : {}),
    });
    assertCurrentConsent();
    // Remote providers return chunk-relative timestamps too; shift them when
    // the caller supplied an explicit chunk offset.
    if (offsetSec !== undefined && offsetSec > 0 && result.segments) {
      for (const segment of result.segments) {
        segment.start = Math.max(0, segment.start + offsetSec);
        segment.end = Math.max(0, segment.end + offsetSec);
      }
    }
    // Translation is a server-side post-processing step, independent of where
    // the transcript came from (local engine, remote vendor or tenant slot).
    const target = ctx.services.sttTranslation.translationTarget(claims.tenantId, translateTo);
    if (target !== 'none' && result.text.trim()) {
      const segments =
        result.segments && result.segments.length > 0
          ? result.segments
          : [{ start: 0, end: result.durationSec ?? 0, text: result.text.trim() }];
      let translatedCount = 0;
      let engine: string | undefined;
      for (const segment of segments) {
        assertCurrentConsent();
        try {
          const translation = await ctx.services.sttTranslation.translateCaption({
            tenantId: claims.tenantId,
            text: segment.text,
            ...(segment.lang === 'ru' || segment.lang === 'en' ? { sourceLang: segment.lang } : {}),
            targetLang: target,
          });
          if (translation) {
            segment.translation = translation;
            translatedCount += 1;
            engine = translation.engine;
          }
        } catch (translationError) {
          ctx.logger.warn('stt translation failed', {
            error: translationError instanceof Error ? translationError.message : String(translationError),
          });
          break;
        }
      }
      if (!result.segments || result.segments.length === 0) result.segments = segments;
      if (translatedCount > 0) {
        result.translation = {
          targetLang: target,
          provider: ctx.env.translateProvider === 'llm' ? 'llm' : 'local',
          ...(engine ? { engine } : {}),
        };
        result.notice = TRANSLATION_NOTICE;
      }
    }
    assertCurrentConsent();
    ctx.send(200, result);
  } catch (error) {
    if (error instanceof HttpError && error.code === 'consent_required') throw error;
    const code = (error as { code?: string; name?: string }).code;
    if (code === 'stt_not_configured') throw error;
    if (code && String(code).startsWith('provider_')) throw error;
    ctx.logger.warn('stt provider failed', { error: error instanceof Error ? error.message : String(error) });
    throw new HttpError(502, 'internal_error', 'STT provider request failed');
  }
}

/**
 * `GET /v1/rooms/:roomId/transcript` — participant-facing transcript with
 * timestamps and attached machine translations (tenant-scoped, consent-aware).
 */
async function roomTranscriptHandler(ctx: RequestContext): Promise<void> {
  const claims = requireJoinToken(ctx.env, ctx.headers);
  const room = transcriptRoom(ctx, claims);
  const config = ctx.tenants.getConfig(claims.tenantId);
  requireFeatureForParticipant(ctx, claims, config, 'captions');
  const service = ctx.services.sttTranslation;
  const retentionSec = service.retentionSec(claims.tenantId);
  room.pruneTranscript(retentionSec);
  const consentRequired = service.consentRequired(claims.tenantId);
  const consented = room.hasTranscriptConsent(claims.sub);
  if (consentRequired && !consented) assertTranscriptConsent(ctx, claims, room);
  const target = service.translationTarget(claims.tenantId);
  const limit = intQuery(ctx.query, 'limit', 1000, 1, 5000);
  const response: TranscriptResponse = {
    roomId: room.id,
    segments: room.segments.slice(-limit),
    updatedAt: room.analysisUpdatedAt,
    translation: {
      enabled: target !== 'none' && ctx.env.translateProvider !== 'none',
      target,
      provider: ctx.env.translateProvider,
      ...(ctx.env.translateProvider !== 'none' ? { engine: service.translationEngineLabel() } : {}),
    },
    retention: { retentionSec, consentRequired, consented },
  };
  ctx.send(200, response);
}

/** Returns the current participant's consent state without reading the transcript. */
async function transcriptConsentStatusHandler(ctx: RequestContext): Promise<void> {
  const claims = requireJoinToken(ctx.env, ctx.headers);
  if (ctx.params.roomId !== claims.roomId) throw new HttpError(404, 'not_found', 'Room not found');
  const room = transcriptRoom(ctx, claims);
  const config = ctx.tenants.getConfig(claims.tenantId);
  requireFeatureForParticipant(ctx, claims, config, 'captions');
  ctx.send(200, {
    consentRequired: ctx.services.sttTranslation.consentRequired(claims.tenantId),
    consented: room.hasTranscriptConsent(claims.sub),
  });
}

/**
 * `POST /v1/rooms/:roomId/transcript/consent` — participant grants or withdraws
 * consent. Withdrawal also erases that participant's stored segments.
 */
async function transcriptConsentHandler(ctx: RequestContext): Promise<void> {
  const claims = requireJoinToken(ctx.env, ctx.headers);
  const room = transcriptRoom(ctx, claims);
  const body = await ctx.jsonSchema(transcriptConsentSchema);
  let removedSegments = 0;
  let grantedAt: number | null = null;
  if (body.granted) {
    grantedAt = room.grantTranscriptConsent(claims.sub, claims.sub).grantedAt;
  } else {
    room.revokeTranscriptConsent(claims.sub);
    removedSegments = room.removeTranscriptSegments(claims.sub);
    // Cached machine translations must not outlive the withdrawn transcript.
    ctx.services.sttTranslation.clearTranslationCache();
  }
  safeAudit(ctx.logger, ctx.services.audit, {
    type: 'transcript.consent',
    severity: 'info',
    tenantId: claims.tenantId,
    roomId: room.id,
    participantId: claims.sub,
    ipHash: ctx.ipHash,
    message: body.granted ? 'Transcript consent granted' : 'Transcript consent withdrawn',
    details: { granted: body.granted, removedSegments },
  });
  ctx.send(200, {
    roomId: room.id,
    participantId: claims.sub,
    consent: { granted: body.granted, grantedAt },
    removedSegments,
  });
}

/**
 * `POST /v1/rooms/:roomId/transcript/translate` — translate one line with the
 * tenant's configured engine (useful for browser-STT captions and re-translation).
 */
async function transcriptTranslateHandler(ctx: RequestContext): Promise<void> {
  const claims = requireJoinToken(ctx.env, ctx.headers);
  const room = transcriptRoom(ctx, claims);
  const config = ctx.tenants.getConfig(claims.tenantId);
  requireFeatureForParticipant(ctx, claims, config, 'captions');
  assertTranscriptConsent(ctx, claims, room);
  assertRateLimit(ctx.services.limiters.stt.check(`translate:${claims.tenantId}`), ctx, 'Too many translation requests');
  const body = await ctx.jsonSchema(transcriptTranslateSchema);
  try {
    const result = await ctx.services.sttTranslation.translateText({
      tenantId: claims.tenantId,
      text: body.text,
      ...(body.targetLang ? { targetLang: body.targetLang } : {}),
      ...(body.sourceLang ? { sourceLang: body.sourceLang } : {}),
    });
    ctx.send(200, result);
  } catch (error) {
    mapSttTranslationError(error);
  }
}

/** `GET /v1/tenants/:tenantId/backgrounds` — public virtual-background library. */
async function backgroundsHandler(ctx: RequestContext): Promise<void> {
  const tenantId = assertTenantId(ctx.params.tenantId as string);
  const response = await ctx.providers.backgrounds(tenantId);
  ctx.send(200, response);
}

/**
 * `POST /v1/rooms/:roomId/chat` — company backend/host page injects a chat
 * message without a WebSocket (contract §22.1). Idempotent on `id`.
 */
/**
 * `POST /v1/rooms/:roomId/assistant` — in-call AI assistant acting on behalf of
 * the token owner (docs/in-call-agent.md). The server filters every proposed
 * action through the participant's effective permissions.
 */
async function inCallAssistantHandler(ctx: RequestContext): Promise<void> {
  const claims = requireJoinToken(ctx.env, ctx.headers);
  const roomId = ctx.params.roomId as string;
  if (claims.roomId !== roomId) throw new HttpError(403, 'forbidden', 'Token does not belong to this room');
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  if (room.tenantId !== claims.tenantId) throw new HttpError(403, 'forbidden', 'Token does not belong to this room');
  if (!room.allowsParticipant(claims.sub)) throw new HttpError(403, 'forbidden', 'Assistant is unavailable for this participant');
  const config = roomConfig(room, ctx.tenants.getConfig(room.tenantId));
  const agent = config.session.inCallAgent;
  if (!agent.enabled) throw new HttpError(403, 'forbidden', 'In-call assistant is disabled for this tenant');
  assertRateLimit(
    ctx.services.limiters.assistant.check(`assistant:${claims.tenantId}:${claims.sub}`),
    ctx,
    'Too many assistant requests',
  );
  const body = await ctx.jsonSchema(inCallAssistantRequestSchema);
  if (agent.mode === 'local') {
    throw new HttpError(501, 'assistant_local_only', 'in-call assistant runs locally in the widget');
  }
  let policy: Awaited<ReturnType<typeof readInCallSecurityPolicy>>;
  try {
    policy = await readInCallSecurityPolicy(ctx.env, room.tenantId, agent.endpoint.trim());
  } catch {
    audit(ctx, assistantAuditEntry({ tenantId: room.tenantId, roomId: room.id, participantId: claims.sub,
      provider: 'policy-verification', ok: false, actions: 0, denied: 0 }));
    throw new HttpError(503, 'assistant_policy_unverified', 'The assistant security policy could not be verified');
  }
  const permissions = accessOf({
    config,
    role: claims.role,
    userId: claims.sub,
    tokenPermissions: claimsPermissions(claims),
    roleId: claimsRoleId(claims),
  }).allowed;
  const request = buildAssistantRequest({
    config,
    tenantId: room.tenantId,
    roomId: room.id,
    participant: {
      id: claims.sub,
      name: room.member(claims.sub)?.participant.name ?? claims.name,
      role: claims.role,
    },
    permissions,
    policy,
    text: body.text,
    ...(body.locale ? { locale: body.locale } : {}),
    ...(body.state ? { state: body.state } : {}),
  });
  const outcome = await callInCallAssistant(ctx.env, config, request);
  if (!outcome.ok) {
    audit(ctx, assistantAuditEntry({
      tenantId: room.tenantId,
      roomId: room.id,
      participantId: claims.sub,
      provider: 'external',
      policy,
      ok: false,
      actions: 0,
      denied: 0,
    }));
    if (policy) throw new HttpError(503, 'assistant_policy_unverified', 'The external assistant could not answer under the verified policy');
    if (agent.mode === 'hybrid') {
      throw new HttpError(501, 'assistant_local_only', 'in-call assistant is unavailable; the widget will run the local assistant');
    }
    throw new HttpError(502, 'provider_failed', 'The external assistant could not answer');
  }
  const { reply, denied } = buildAssistantReply({
    response: outcome.response,
    config,
    role: claims.role,
    permissions,
    tools: request.tools,
    policy,
  });
  audit(ctx, assistantAuditEntry({
    tenantId: room.tenantId,
    roomId: room.id,
    participantId: claims.sub,
    provider: outcome.provider,
    policy,
    ok: true,
    actions: reply.actions.length,
    denied,
  }));
  ctx.send(200, reply);
}

async function postChatHandler(ctx: RequestContext): Promise<void> {
  const claims = requireJoinToken(ctx.env, ctx.headers);
  const roomId = ctx.params.roomId as string;
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  if (room.tenantId !== claims.tenantId || room.id !== claims.roomId) {
    throw new HttpError(403, 'forbidden', 'Token does not belong to this room');
  }
  if (room.locked) throw new HttpError(423, 'room_locked', 'Room is locked');
  const body = await ctx.jsonSchema(chatPostSchema);
  const config = roomConfig(room, ctx.tenants.getConfig(room.tenantId));
  const access = {
    config,
    role: claims.role,
    userId: claims.sub,
    tokenPermissions: claimsPermissions(claims),
    roleId: claimsRoleId(claims),
  };
  if (!config.features.chat || !canUseFeature(access, 'chat') || (claims.role === 'guest' && !config.security.guestCanChat)) {
    throw new HttpError(403, 'forbidden', 'Chat is not allowed for this participant');
  }
  const chatConfig = config.session.chat;
  if (body.kind === 'system') {
    if (!chatConfig.allowSystemMessages) {
      throw new HttpError(403, 'forbidden', 'System chat messages are disabled for this tenant');
    }
    if (claims.role !== 'host' && claims.role !== 'moderator') {
      throw new HttpError(403, 'forbidden', 'Only hosts and moderators may post system messages');
    }
    // System notices carry no personal identity unless the caller provided one.
    body.from = body.from ?? { id: 'system', name: 'Система', role: 'moderator' };
  } else if (!chatConfig.allowHostInjection) {
    throw new HttpError(403, 'forbidden', 'Host chat injection is disabled for this tenant');
  }
  const result = await ctx.providers.chatPost(room.tenantId, room.id, {
    text: body.text,
    from: { id: claims.sub, name: claims.name, role: claims.role },
    kind: body.kind ?? 'text',
    ...(body.id ? { id: body.id } : {}),
    ...(body.from ? { displayFrom: body.from } : {}),
  });
  const response: ChatPostResponse = { message: result };
  ctx.send(200, response);
}

/* ------------------------------------------------------------------ */
/* Liveness: server-issued challenge (advisory, never certified)       */
/* ------------------------------------------------------------------ */

const LIVENESS_SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Shared credential/tenant gate for the liveness endpoints. The join token is
 * the participant capability; the room id must match the token and the tenant
 * must both enable the feature and have an engine configured (otherwise 501).
 */
function requireLivenessRoom(ctx: RequestContext): { claims: TokenClaims; room: Room; config: TenantConfig } {
  const claims = requireJoinToken(ctx.env, ctx.headers);
  const roomId = ctx.params.roomId as string;
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  requireTenantMatch(claims.tenantId, room.tenantId);
  if (claims.roomId !== room.id) throw new HttpError(403, 'forbidden', 'Token does not belong to this room');
  const config = ctx.tenants.getConfig(claims.tenantId);
  if (!config.security.liveness.enabled) {
    throw new HttpError(403, 'liveness_disabled', 'Liveness checks are disabled for this tenant');
  }
  if (!ctx.services.liveness.isEnabled()) {
    throw new HttpError(
      501,
      'liveness_not_configured',
      'Liveness is not configured (AGIL_LIVENESS_ENGINE / AGIL_LIVENESS_URL)',
    );
  }
  return { claims, room, config };
}

/** `POST /v1/rooms/:roomId/liveness/challenge` — issues a tenant-scoped task. */
async function livenessChallengeHandler(ctx: RequestContext): Promise<void> {
  const { claims, room } = requireLivenessRoom(ctx);
  assertRateLimit(
    ctx.services.limiters.liveness.check(`liveness:${claims.tenantId}:${claims.sub}`),
    ctx,
    'Too many liveness requests',
  );
  const challenge = await ctx.services.liveness.issue({
    tenantId: claims.tenantId,
    roomId: room.id,
    participantId: claims.sub,
  });
  audit(ctx, {
    type: 'liveness.challenge',
    severity: 'info',
    tenantId: claims.tenantId,
    roomId: room.id,
    participantId: claims.sub,
    ip: ctx.ip,
    message: `Liveness challenge issued (${challenge.task})`,
    details: {
      task: challenge.task,
      engine: challenge.engine,
      expiresAt: challenge.expiresAt,
      ttlSec: Math.round((challenge.expiresAt - challenge.issuedAt) / 1000),
    },
  });
  const response: LivenessChallengeResponse = {
    sessionId: challenge.sessionId,
    task: challenge.task,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    ttlSec: Math.max(0, Math.round((challenge.expiresAt - challenge.issuedAt) / 1000)),
    engine: challenge.engine,
    advisory: true,
  };
  ctx.send(200, response);
}

/** `POST /v1/rooms/:roomId/liveness/:sessionId/verify` — adjudicates the signals. */
async function livenessVerifyHandler(ctx: RequestContext): Promise<void> {
  const { claims, room, config } = requireLivenessRoom(ctx);
  const sessionId = ctx.params.sessionId as string;
  if (!LIVENESS_SESSION_ID_RE.test(sessionId)) {
    throw new HttpError(400, 'validation_failed', 'Invalid liveness session id');
  }
  const body = await ctx.jsonSchema(livenessVerifyRequestSchema);
  assertRateLimit(
    ctx.services.limiters.liveness.check(`liveness:${claims.tenantId}:${claims.sub}`),
    ctx,
    'Too many liveness requests',
  );
  const verdict = await ctx.services.liveness.verify(
    {
      tenantId: claims.tenantId,
      roomId: room.id,
      participantId: claims.sub,
      sessionId,
      signals: body.signals,
    },
    { onEngineError: config.security.liveness.onEngineError },
  );
  // The verdict is advisory: a pass marks the participant `verified`, a failure
  // is NOT treated as a deepfake (integrity stays `unknown`).
  if (verdict.status === 'verified') room.updateIntegrity(claims.sub, 'verified');
  else if (verdict.status === 'failed') room.updateIntegrity(claims.sub, 'unknown');

  const auditType =
    verdict.status === 'verified'
      ? 'liveness.verified'
      : verdict.status === 'failed'
        ? 'liveness.failed'
        : 'liveness.unavailable';
  audit(ctx, {
    type: auditType,
    severity: verdict.status === 'failed' ? 'warn' : 'info',
    tenantId: claims.tenantId,
    roomId: room.id,
    participantId: claims.sub,
    ip: ctx.ip,
    message: `Liveness ${verdict.status} (${verdict.engine}, attempts ${verdict.attempts}/${verdict.maxAttempts})`,
    details: {
      status: verdict.status,
      score: verdict.score,
      flags: verdict.flags,
      engine: verdict.engine,
      ...(verdict.detail ? { detail: verdict.detail } : {}),
    },
  });
  if (verdict.status === 'failed') {
    ctx.services.webhooks.emit(
      'security.event',
      { tenantId: claims.tenantId, roomId: room.id },
      {
        kind: 'liveness.failed',
        participantId: claims.sub,
        score: verdict.score,
        flags: verdict.flags,
        engine: verdict.engine,
      },
    );
  }
  const response: LivenessVerifyResponse = {
    sessionId: verdict.sessionId,
    passed: verdict.passed,
    status: verdict.status,
    score: verdict.score,
    flags: verdict.flags,
    engine: verdict.engine,
    attempts: verdict.attempts,
    maxAttempts: verdict.maxAttempts,
    advisory: true,
  };
  ctx.send(200, response);
}

export function registerPublicRoutes(router: Router): void {
  registerScimRoutes(router);
  router.get('/v1/health', healthHandler);
  router.get('/v1/host', hostHandler);
  router.get('/v1/domain/ask', domainAskHandler);
  router.post('/v1/auth/oidc/verify', oidcVerifyHandler);
  router.get('/v1/auth/oidc/start', oidcStartHandler);
  // `query` response mode uses GET; `form_post` posts the authorization response
  // as application/x-www-form-urlencoded to the same redirect URI.
  router.get('/v1/auth/oidc/callback', oidcCallbackHandler);
  router.post('/v1/auth/oidc/callback', oidcCallbackHandler);
  router.post('/v1/auth/oidc/logout', oidcLogoutHandler);
  router.get('/v1/auth/oidc/logout', oidcLogoutStartHandler);
  router.get('/v1/auth/oidc/logout/callback', oidcLogoutCallbackHandler);
  router.get('/v1/ice', iceHandler);
  router.get('/v1/tenants/:tenantId/config', getConfigHandler);
  router.put('/v1/tenants/:tenantId/config', putConfigHandler);
  router.patch('/v1/tenants/:tenantId/config', patchConfigHandler);
  router.post('/v1/rooms', createRoomHandler);
  router.post('/v1/tokens', createTokenHandler);
  router.get('/v1/rooms/:roomId', getRoomHandler);
  router.delete('/v1/rooms/:roomId', deleteRoomHandler);
  router.get('/v1/rooms/:roomId/messages', messagesHandler);
  router.post('/v1/rooms/:roomId/egress/start', egressStartHandler);
  router.post('/v1/rooms/:roomId/egress/:egressId/stop', egressStopHandler);
  router.post('/v1/rooms/:roomId/egress/:egressId/playback', egressPlaybackLinkHandler);
  router.get('/v1/rooms/:roomId/egress/:egressId/playlist', egressPlaylistHandler);
  router.get('/v1/rooms/:roomId/egress/:egressId/segment', egressSegmentHandler);
  router.get('/v1/rooms/:roomId/egress/:egressId/file', egressFileHandler);
  // HEAD mirrors GET on the three public playback routes: players, download
  // managers, CDNs and monitoring probe HEAD before/while fetching. The handler
  // writes the same status/headers and skips the body.
  router.head('/v1/rooms/:roomId/egress/:egressId/playlist', egressPlaylistHandler);
  router.head('/v1/rooms/:roomId/egress/:egressId/segment', egressSegmentHandler);
  router.head('/v1/rooms/:roomId/egress/:egressId/file', egressFileHandler);
  router.get('/v1/rooms/:roomId/egress', egressListHandler);
  router.post('/v1/rooms/:roomId/join', joinRoom);
  router.get('/v1/rooms/:roomId/calendar.ics', calendarHandler);
  router.get('/v1/rooms/:roomId/polls', pollsListHandler);
  router.post('/v1/rooms/:roomId/polls', pollCreateHandler);
  router.post('/v1/rooms/:roomId/polls/:pollId/vote', pollVoteHandler);
  router.post('/v1/rooms/:roomId/polls/:pollId/close', pollCloseHandler);
  router.get('/v1/rooms/:roomId/breakouts', breakoutListHandler);
  router.post('/v1/rooms/:roomId/breakouts/start', breakoutStartHandler);
  router.post('/v1/rooms/:roomId/breakouts/close', breakoutCloseHandler);
  router.post('/v1/rooms/:roomId/breakouts/return', breakoutReturnHandler);
  router.get('/v1/rooms/:roomId/lobby', lobbyListHandler);
  router.get('/v1/rooms/:roomId/lobby/:requestId', lobbyStatusHandler);
  router.post('/v1/rooms/:roomId/lobby/:requestId/cancel', lobbyCancelHandler);
  router.post('/v1/rooms/:roomId/lobby/:requestId/admit', lobbyAdmitHandler);
  router.post('/v1/rooms/:roomId/lobby/:requestId/reject', lobbyRejectHandler);
  router.delete('/v1/rooms/:roomId/lobby/:requestId', lobbyRejectHandler);
  router.post('/v1/rooms/:roomId/chat', postChatHandler);
  router.post('/v1/rooms/:roomId/assistant', inCallAssistantHandler);
  router.post('/v1/rooms/:roomId/liveness/challenge', livenessChallengeHandler);
  router.post('/v1/rooms/:roomId/liveness/:sessionId/verify', livenessVerifyHandler);
  router.post('/v1/files', uploadFileHandler);
  router.get('/v1/files/:id', downloadFileHandler);
  router.post('/v1/recordings', uploadRecordingHandler);
  router.get('/v1/recordings/:id', downloadRecordingHandler);
  router.post('/v1/stt/transcribe', sttHandler);
  router.get('/v1/rooms/:roomId/transcript', roomTranscriptHandler);
  router.get('/v1/rooms/:roomId/transcript/consent', transcriptConsentStatusHandler);
  router.post('/v1/rooms/:roomId/transcript/consent', transcriptConsentHandler);
  router.post('/v1/rooms/:roomId/transcript/translate', transcriptTranslateHandler);
  router.get('/v1/tenants/:tenantId/backgrounds', backgroundsHandler);
  // Keep the zod schema referenced so `roomInfoSchema` stays part of the public import surface.
  void roomInfoSchema;
  void ConfigValidationError;
}
