/**
 * Admin REST API (contract §14, §18, §19): tenant-scoped operations behind
 * `x-api-key`. Every path resolves the tenant from the key and verifies the room
 * belongs to it (403 otherwise, 404 for unknown ids — no cross-tenant leaks).
 *
 * Also hosts the corporate integration control plane: access policy, AI agent,
 * knowledge agent (proxy), and outbound webhook management.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  accessPolicyExpectedSchema,
  accessPolicyPatchSchema,
  aiAgentConfigSchema,
  auditEventTypes,
  describeTenantSecretEnv,
  featureKeys,
  featureKeySchema,
  isAllowedTenantSecretEnv,
  roomContextSchema,
  roleSchema,
  defaultConfig,
  enrollmentTokenCreateRequestSchema,
  nodeDisableRequestSchema,
  nodeDrainRequestSchema,
  nodeModuleActionRequestSchema,
  nodeModulesPaths,
  nodeRotateKeyRequestSchema,
  nodeUpdateRequestSchema,
  resolveTenantConfig,
  applyBrandColor,
  applyBillingPlanPatch,
  BILLING_PLANS,
  billingPlanPatchSchema,
  edgeEnrollmentCreateRequestSchema,
  flowCreateSchema,
  flowPatchSchema,
  flowTestRequestSchema,
  routingRuleCreateSchema,
  routingRulePatchSchema,
  routingTestRequestSchema,
  scaleConfigSchema,
  displayTheme,
  themePresets,
  themePresetNames,
  themeSchema,
  type ThemePresetName,
  type ThemeTokens,
  tenantConfigSchema,
  tenantConfigPatchSchema,
  webhookEndpointSchema,
  type AccessPolicy,
  type BillingPlanResponse,
  type BillingUsageResponse,
  type DashboardAssistantRequest,
  type DocContentResponse,
  type DocHistoryResponse,
  type DocsListResponse,
  type DomainConfigResponse,
  type DashboardAssistantResponse,
  type GuardAssessRequest,
  type GuardAssessResponse,
  type AccessPolicyResponse,
  type AdminOverview,
  type AdminRoomSummary,
  type AiAgentSettingsResponse,
  type AnalysisResponse,
  type AuditEntry,
  type AuditEventType,
  type AuditListResponse,
  type ChatPostResponse,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type FeatureKey,
  type FileRecord,
  type InviteLink,
  type KnowledgeAgentSettingsResponse,
  type KnowledgeAskResponse,
  type ProviderSlotName,
  type ProvidersResponse,
  type RecordingRecord,
  type RoleDefinition,
  type RolesResponse,
  type RoomDetail,
  type SecurityOverview,
  type TenantConfig,
  type TenantConfigPatch,
  type TenantSummary,
  type TenantsResponse,
  type TenantCreatedResponse,
  type TenantKeyResponse,
  type TranscriptResponse,
  type WebhookTestResponse,
  type WebhooksResponse,
  NODE_HEARTBEAT_INTERVAL_SEC,
} from '@agil/protocol';
import { assessChange } from '@agil/ai';
import { hashPassword } from '@agil/security';
import {
  accessOf,
  adminCredential,
  assertRateLimit,
  buildRoomLinks,
  issueToken,
  knowledgeAccessOf,
  requireApiKeyTenant,
  requirePlatformKey,
  assertTenantAdminAccess,
  isPlatformKey,
  requireTenantMatch,
} from './auth.js';
import {
  HttpError,
  intQuery,
  requestOrigin,
  safeAudit,
  zodErrorMessage,
  type RequestContext,
  type Router,
} from './http.js';
import { DomainConflictError, parseDomain, type DomainVerification } from './domains.js';
import { EgressPlaybackError } from './egress-playback.js';
import { allowedParticipantIdsSchema, roomConfig, type Room } from './rooms.js';
import { resolveDirectTransport } from './direct-transport.js';
import { runRoomAnalysis } from './analysis.js';
import { conversationReviewPolicySchema } from '@agil/protocol';
import { clusterStatus, mergeScale, roomMediaMode, scaleStatus, testTurnServer, validateScale } from './scale.js';
import { capRoomParticipantsForSfu, roomCapacityInfo } from './sfu.js';
import { aiAgentConfigured, knowledgeAgentConfigured, knowledgeConfigurationIssue } from './services.js';
import { assertConfigOverrideEndpoints, assertExternalUrl, isSecureMode } from './url-policy.js';
import { answerDashboardAssistant, assistantPromptInfo } from './dashboard.js';
import { mediaProcessingStatus } from './media-processing.js';
import { resolveTenantSecret } from './secret-env.js';
import { DocsError, MAX_DOC_BYTES, sanitizeDocName } from './docs-cms.js';
import { NODE_MODULE_CATALOG_ACTIONS, nodeModuleCatalog } from './node-modules.js';
import { apiKeyStore } from './api-keys.js';
import {
  BILLING_MONTH_RE,
  BILLING_WARNING_HEADER,
  currentQuotaWarnings,
  evaluateRoomCreateQuota,
  planParticipantCap,
  tenantUsageCounts,
} from './billing.js';

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

const inviteSchema = z.object({
  ttlSec: z.number().int().min(60).max(86400).optional(),
  role: roleSchema.optional(),
});

const lockSchema = z.object({ locked: z.boolean() });
const kickSchema = z.object({ participantId: z.string().min(1).max(64) });
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
const aiAgentPutSchema = z.object({ config: z.record(z.string(), z.unknown()) });
const knowledgeAgentPutSchema = z.object({ config: z.record(z.string(), z.unknown()) });
const inCallAgentPutSchema = z.object({ config: z.record(z.string(), z.unknown()) });
const accessPolicyPutSchema = z.object({
  /** Deep-partial access policy patch (omitted fields stay unchanged). */
  policy: accessPolicyPatchSchema.optional(),
  expectedPolicy: accessPolicyExpectedSchema.optional(),
  /** Revoke listed users, or use policy.userOverrides: {} to clear all overrides. */
  clearUserOverrides: z.array(z.string().min(1).max(128)).max(500).optional(),
});
const webhooksPutSchema = z.object({ webhooks: z.array(webhookEndpointSchema).max(20) });
const webhooksTestSchema = z.object({ endpointId: z.string().min(1).max(64) });
const providerSlotNameSchema = z.enum(['chat', 'files', 'stt', 'notifications', 'recording', 'backgrounds']);
const providersPutSchema = z.object({ providers: z.partialRecord(providerSlotNameSchema, z.record(z.string(), z.unknown())) });
const providersTestSchema = z.object({
  slot: providerSlotNameSchema,
  payload: z.record(z.string(), z.unknown()).optional(),
});
const scalePutSchema = z.object({ scale: z.record(z.string(), z.unknown()) });
const egressCleanupSchema = z.object({
  /** Default false: dry-run lists stuck jobs without stopping anything. */
  apply: z.boolean().optional(),
  /** Default AGIL_EGRESS_STUCK_AFTER_SEC (4 h); clamped 60..172800. */
  thresholdSec: z.number().int().min(60).max(172800).optional(),
});
const turnTestSchema = z.object({ id: z.string().min(1).max(64) });

const roleIdSchema = z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9_-]*$/);
const customRoleFieldsSchema = z.object({
  id: roleIdSchema.optional(),
  name: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  baseRole: roleSchema,
  features: z.array(featureKeySchema),
  canModerate: z.boolean().optional(),
  color: z.string().max(9).optional(),
});
const roleCreateSchema = customRoleFieldsSchema.extend({ id: roleIdSchema });
const roleUpdateSchema = customRoleFieldsSchema;
const roomPasswordSchema = z.object({
  /** Empty/omitted = generate a strong password and return it once. */
  password: z.string().max(200).optional(),
});

const knowledgeAskSchema = z.object({
  question: z.string().min(1).max(2000),
  userId: z.string().max(128).optional(),
  role: roleSchema.optional(),
  roomId: z.string().max(64).optional(),
  locale: z.enum(['ru', 'en']).optional(),
});

function audit(ctx: RequestContext, entry: Parameters<typeof safeAudit>[2]): void {
  safeAudit(ctx.logger, ctx.services.audit, entry);
}

/** Resolves the tenant from the API key and enforces the admin rate limit. */
function adminTenant(ctx: RequestContext): string {
  const tenantId = requireApiKeyTenant(ctx);
  assertRateLimit(ctx.services.limiters.admin.check(`admin:${tenantId}`), ctx, 'Too many admin requests');
  return tenantId;
}

/** Loads a room and enforces tenant ownership (403 on a foreign tenant). */
function requireRoom(ctx: RequestContext, tenantId: string): Room {
  const roomId = ctx.params.roomId as string;
  const room = ctx.rooms.get(roomId);
  if (!room) throw new HttpError(404, 'not_found', 'Room not found');
  requireTenantMatch(tenantId, room.tenantId);
  return room;
}

function roomLinks(ctx: RequestContext, room: Room): { joinUrl: string; embedUrl: string } {
  return buildRoomLinks(ctx.env, { roomId: room.id, tenantId: room.tenantId }, requestOrigin(ctx, room.tenantId));
}

function recordingsFor(ctx: RequestContext, roomId: string, tenantId: string): RecordingRecord[] {
  return ctx.services.recordings.list({ tenantId, roomId, limit: 1000 });
}

function settingsForAiAgent(ctx: RequestContext, config: TenantConfig): AiAgentSettingsResponse {
  const aiAgent = config.session.aiAgent;
  const key = resolveTenantSecret(ctx.env, aiAgent.apiKeyEnv, 'integration').value;
  return {
    config: aiAgent,
    endpointConfigured: aiAgent.endpoint.trim().length > 0,
    apiKeyConfigured: Boolean(key),
  };
}

function settingsForKnowledgeAgent(ctx: RequestContext, config: TenantConfig): KnowledgeAgentSettingsResponse {
  const agent = config.session.knowledgeAgent;
  const key = resolveTenantSecret(ctx.env, agent.apiKeyEnv, 'integration').value;
  return {
    config: agent,
    endpointConfigured: agent.endpoint.trim().length > 0,
    apiKeyConfigured: Boolean(key),
  };
}

function accessPolicyResponse(ctx: RequestContext, tenantId: string): AccessPolicyResponse {
  const config = ctx.tenants.getConfig(tenantId);
  const effective = {
    host: accessOf({ config, role: 'host' }).allowed,
    moderator: accessOf({ config, role: 'moderator' }).allowed,
    guest: accessOf({ config, role: 'guest' }).allowed,
  };
  return {
    policy: config.security.accessPolicy,
    featureKeys: [...featureKeys] as FeatureKey[],
    effective,
  };
}

function webhooksResponse(ctx: RequestContext, tenantId: string): WebhooksResponse {
  return {
    webhooks: ctx.tenants.getConfig(tenantId).integrations.webhooks,
    recentDeliveries: ctx.services.webhooks.list(50, tenantId),
  };
}

function summaryFor(ctx: RequestContext, room: Room): AdminRoomSummary {
  const links = roomLinks(ctx, room);
  return {
    room: room.info(),
    participants: room.participantCount,
    maxParticipants: room.maxParticipants,
    passwordProtected: room.passwordProtected,
    createdAt: room.createdAt,
    lastActivityAt: room.lastActivityAt,
    recordings: recordingsFor(ctx, room.id, room.tenantId).length,
    joinUrl: links.joinUrl,
    embedUrl: links.embedUrl,
  };
}

/* ------------------------------------------------------------------ */
/* Overview / rooms                                                    */
/* ------------------------------------------------------------------ */

function overviewHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const now = Date.now();
  const since = now - 24 * 60 * 60 * 1000;
  const tenantRooms = ctx.rooms.list(tenantId);
  const counts = ctx.services.audit.countByType(since, tenantId);
  const securityTypes = ['join.denied', 'password.failed', 'geo.blocked', 'lockout', 'integrity.flagged'];
  const countries: Record<string, number> = {};
  for (const room of tenantRooms) {
    for (const participant of room.participants()) {
      const country = participant.country ?? participant.location?.country;
      if (country) countries[country] = (countries[country] ?? 0) + 1;
    }
  }
  const response: AdminOverview = {
    tenantId,
    serverTime: now,
    uptimeSec: Math.max(0, Math.round((now - ctx.startedAt) / 1000)),
    activeRooms: tenantRooms.length,
    activeParticipants: tenantRooms.reduce((sum, room) => sum + room.participantCount, 0),
    totalRoomsCreated: ctx.rooms.roomsCreatedFor(tenantId),
    waitingParticipants: tenantRooms.reduce((sum, room) => sum + room.lobbyCount(), 0),
    recordings: ctx.services.recordings.count(tenantId),
    sharedFiles: ctx.services.files.count(tenantId),
    securityEvents24h: securityTypes.reduce((sum, type) => sum + (counts[type] ?? 0), 0),
    countries,
  };
  ctx.send(200, response);
}

function listRoomsHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  ctx.send(200, { rooms: ctx.rooms.listSorted(tenantId).filter((room) => !room.breakoutParentId).map((room) => summaryFor(ctx, room)) });
}

async function createRoomHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const body = await ctx.jsonSchema(createRoomSchema) as CreateRoomRequest;
  if (body.tenantId && body.tenantId !== tenantId) {
    throw new HttpError(403, 'forbidden', 'API key does not belong to this tenant');
  }
  const config = ctx.tenants.getConfig(tenantId);
  let configOverrides: CreateRoomRequest['configOverrides'] | undefined;
  if (body.configOverrides !== undefined) {
    const { tenantConfigPatchSchema } = await import('@agil/protocol');
    const parsed = tenantConfigPatchSchema.safeParse(body.configOverrides);
    if (!parsed.success) {
      throw new HttpError(400, 'validation_failed', zodErrorMessage(parsed.error), parsed.error.issues);
    }
    // Room overrides bypass TenantStore; apply the SIP SSRF/TLS policy before
    // the room and its effective config are created.
    assertConfigOverrideEndpoints(parsed.data, ctx.env);
    configOverrides = parsed.data as CreateRoomRequest['configOverrides'];
  }
  const passwordHash = body.password ? hashPassword(body.password) : undefined;
  const mode = body.mode ?? 'group';
  // P2P is direct-only: validate before billing/capacity so unsupported rooms
  // never consume quota (409 for server egress/streaming/webinar).
  const transport = resolveDirectTransport({
    transport: body.transport,
    mode,
    maxParticipants: body.maxParticipants,
    config,
    configOverrides,
  });
  const scale = config.scale;
  const mediaMode = transport.mediaMode ?? roomMediaMode(scale, mode);
  const roomDefault = configOverrides?.limits?.maxParticipants ?? config.limits.maxParticipants;
  let maxParticipants = transport.maxParticipants ?? body.maxParticipants ?? (mode === 'direct' ? 2 : roomDefault);
  maxParticipants = Math.min(maxParticipants, 50000);
  if (mode === 'direct') maxParticipants = Math.min(maxParticipants, 2);
  const requestedMaxParticipants = maxParticipants;
  maxParticipants = planParticipantCap(config.billing, maxParticipants);
  // Never promise more seats than the SFU media plane can carry.
  maxParticipants = capRoomParticipantsForSfu(ctx.env, config, mediaMode, maxParticipants);
  const capacity = roomCapacityInfo(ctx.env, config, mediaMode, maxParticipants);

  // Billing quota (opt-in; default free/off): block or warn before creating.
  const billingCounts = tenantUsageCounts(ctx.rooms, tenantId);
  const createQuota = evaluateRoomCreateQuota({
    billing: config.billing,
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
  let room: Room;
  try {
    room = ctx.rooms.create({
      id: body.roomId,
      tenantId,
      name: (body.name ?? config.room.name).slice(0, 120) || 'Комната',
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
    message: `Admin created room ${room.name}`,
    details: {
      passwordProtected: Boolean(passwordHash),
      maxParticipants: room.maxParticipants,
      requestedMaxParticipants,
      capacityLimit: capacity.limit,
      capacityProfile: capacity.profile,
      ttlSec: room.ttlSec,
      ...(body.transport ? { transport: body.transport, mediaMode: room.mediaMode } : {}),
    },
  });
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
  const links = buildRoomLinks(ctx.env, { roomId: room.id, tenantId, ...(token ? { token } : {}) }, requestOrigin(ctx, tenantId));
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

function roomDetailHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const room = requireRoom(ctx, tenantId);
  const links = roomLinks(ctx, room);
  const capacity = roomCapacityInfo(ctx.env, roomConfig(room, ctx.tenants.getConfig(room.tenantId)), room.mediaMode, room.maxParticipants);
  const response: RoomDetail = {
    room: room.info(),
    participants: room.participants(),
    messages: room.history(200),
    passwordProtected: room.passwordProtected,
    createdAt: room.createdAt,
    lastActivityAt: room.lastActivityAt,
    joinUrl: links.joinUrl,
    embedUrl: links.embedUrl,
    effectiveMaxParticipants: capacity.effectiveMaxParticipants,
    capacity,
  };
  ctx.send(200, response);
}

function deleteRoomHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const room = requireRoom(ctx, tenantId);
  ctx.rooms.close(room.id, 'admin_closed');
  audit(ctx, {
    type: 'room.closed',
    severity: 'info',
    tenantId,
    roomId: room.id,
    ip: ctx.ip,
    message: 'Admin closed the room',
  });
  ctx.services.webhooks.emit('room.closed', { tenantId, roomId: room.id }, { reason: 'admin_closed' });
  ctx.send(200, { closed: true });
}

const GENERATED_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Cryptographically strong room password (returned once, stored only as scrypt). */
function generateRoomPassword(length = 14): string {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += GENERATED_PASSWORD_ALPHABET[randomInt(GENERATED_PASSWORD_ALPHABET.length)];
  }
  return value;
}

function setRoomPasswordHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const room = requireRoom(ctx, tenantId);
    const body = await ctx.jsonSchema(roomPasswordSchema);
    const provided = (body.password ?? '').trim();
    const generated = provided.length === 0;
    const password = generated ? generateRoomPassword() : provided;
    room.passwordHash = hashPassword(password);
    audit(ctx, {
      type: 'admin.action',
      severity: 'info',
      tenantId,
      roomId: room.id,
      ip: ctx.ip,
      message: generated ? 'Room password generated' : 'Room password changed',
      details: { kind: 'room.password.changed', action: generated ? 'generated' : 'set', generated },
    });
    ctx.send(200, {
      updated: true,
      passwordProtected: true,
      generated,
      // Shown to the admin exactly once; never stored in plaintext or audit.
      ...(generated ? { password } : {}),
    });
  })();
}

function removeRoomPasswordHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const room = requireRoom(ctx, tenantId);
  const hadPassword = room.passwordProtected;
  room.passwordHash = undefined;
  audit(ctx, {
    type: 'admin.action',
    severity: 'info',
    tenantId,
    roomId: room.id,
    ip: ctx.ip,
    message: 'Room password removed',
    details: { kind: 'room.password.changed', action: 'removed', generated: false },
  });
  ctx.send(200, { updated: true, passwordProtected: false, removed: hadPassword });
}

/* ------------------------------------------------------------------ */
/* Room moderation / transcript / analysis                             */
/* ------------------------------------------------------------------ */

function lockRoomHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const room = requireRoom(ctx, tenantId);
    const body = await ctx.jsonSchema(lockSchema);
    room.locked = body.locked;
    room.broadcast({ type: 'room', room: room.info(), participants: room.participants() });
    audit(ctx, {
      type: 'room.locked',
      severity: body.locked ? 'warn' : 'info',
      tenantId,
      roomId: room.id,
      ip: ctx.ip,
      message: body.locked ? 'Room locked' : 'Room unlocked',
    });
    ctx.send(200, { locked: room.locked });
  })();
}

function kickHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const room = requireRoom(ctx, tenantId);
    const body = await ctx.jsonSchema(kickSchema);
    const member = room.member(body.participantId);
    if (!member) throw new HttpError(404, 'not_found', 'Participant is not in this room');
    try {
      member.connection.send({ type: 'bye', reason: 'kicked' });
    } catch {
      /* socket may already be gone */
    }
    member.connection.close(1008, 'kicked');
    room.removeMember(body.participantId);
    room.broadcast({ type: 'peer-left', participantId: body.participantId, reason: 'kicked' });
    audit(ctx, {
      type: 'admin.action',
      severity: 'warn',
      tenantId,
      roomId: room.id,
      participantId: body.participantId,
      ip: ctx.ip,
      message: 'Participant kicked',
      details: { kind: 'kick' },
    });
    ctx.services.webhooks.emit('participant.left', { tenantId, roomId: room.id }, {
      participantId: body.participantId,
      reason: 'kicked',
    });
    ctx.send(200, { kicked: true });
  })();
}

/** `POST /v1/admin/rooms/:roomId/chat` — bot/CRM injection from the company backend. */
function adminPostChatHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const room = requireRoom(ctx, tenantId);
    const body = await ctx.jsonSchema(chatPostSchema);
    const config = roomConfig(room, ctx.tenants.getConfig(tenantId));
    const chat = config.session.chat;
    if (body.kind === 'system') {
      if (!chat.allowSystemMessages) {
        throw new HttpError(403, 'forbidden', 'System chat messages are disabled for this tenant');
      }
    } else if (!chat.allowHostInjection) {
      throw new HttpError(403, 'forbidden', 'Host chat injection is disabled for this tenant');
    }
    const result = await ctx.providers.chatPost(room.tenantId, room.id, {
      text: body.text,
      from: {
        id: body.from?.id ?? 'system',
        name: body.from?.name ?? 'Система',
        role: body.from?.role ?? 'moderator',
      },
      kind: body.kind ?? 'text',
      ...(body.from ? { displayFrom: body.from } : {}),
      ...(body.id ? { id: body.id } : {}),
    });
    audit(ctx, {
      type: 'admin.action',
      severity: 'info',
      tenantId,
      roomId: room.id,
      ip: ctx.ip,
      message: `Chat injected from admin API (${body.kind ?? 'text'})`,
      details: { kind: 'chat.inject', messageId: result.id },
    });
    const response: ChatPostResponse = { message: result };
    ctx.send(200, response);
  })();
}

function transcriptHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const room = requireRoom(ctx, tenantId);
  const service = ctx.services.sttTranslation;
  const retentionSec = service.retentionSec(tenantId);
  room.pruneTranscript(retentionSec);
  const target = service.translationTarget(tenantId);
  const response: TranscriptResponse = {
    roomId: room.id,
    segments: room.segments,
    updatedAt: room.analysisUpdatedAt,
    translation: {
      enabled: target !== 'none' && ctx.env.translateProvider !== 'none',
      target,
      provider: ctx.env.translateProvider,
      ...(ctx.env.translateProvider !== 'none' ? { engine: service.translationEngineLabel() } : {}),
    },
    retention: {
      retentionSec,
      consentRequired: service.consentRequired(tenantId),
    },
  };
  ctx.send(200, response);
}

/** `DELETE /v1/admin/rooms/:roomId/transcript` — erase the stored transcript. */
function transcriptPurgeHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const room = requireRoom(ctx, tenantId);
  const removedSegments = room.clearTranscript();
  ctx.services.sttTranslation.clearTranslationCache();
  audit(ctx, {
    type: 'transcript.purged',
    severity: 'warn',
    tenantId,
    roomId: room.id,
    ip: ctx.ip,
    message: `Transcript purged (${removedSegments} segments)`,
    details: { kind: 'transcript.purged', removedSegments },
  });
  ctx.send(200, { roomId: room.id, removedSegments, clearedAt: Date.now() });
}

/** `GET /v1/admin/stt` — local STT/translation status with actionable reasons. */
async function sttStatusHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const status = await ctx.services.sttTranslation.status();
  const nodeId = status.stt.provider === 'remote' ? ctx.tenants.getConfig(tenantId).session.transcription.nodeId : '';
  if (!nodeId) {
    ctx.send(200, status);
    return;
  }
  const nodeAvailable = ctx.cluster.getNode(tenantId, nodeId)?.availableModules?.includes('stt') === true;
  ctx.send(200, { ...status, stt: { ...status.stt, nodeAvailable } });
}

/** Export helpers: JSON by default, `?format=md` (and optional `download=1`) for файлов-экспорта. */
function wantsMarkdown(ctx: RequestContext): boolean {
  const format = (ctx.query.get('format') ?? '').toLowerCase();
  return format === 'md' || format === 'markdown';
}

function wantsDownload(ctx: RequestContext): boolean {
  const value = (ctx.query.get('download') ?? '').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function sendMarkdownExport(ctx: RequestContext, filename: string, markdown: string): void {
  const headers: Record<string, string> = { 'content-type': 'text/markdown; charset=utf-8' };
  if (wantsDownload(ctx)) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
  ctx.sendRaw(200, Buffer.from(markdown, 'utf8'), headers);
}

function notesMarkdown(room: Room): string {
  const notes = room.notes;
  const lines = [`# Заметки встречи: ${room.name}`, '', `Комната: \`${room.id}\``, ''];
  if (!notes) {
    lines.push('_Заметки ещё не сформированы — запустите анализ комнаты._');
    return lines.join('\n');
  }
  lines.push('## Краткое содержание', '', notes.summary || '_нет_', '');
  if (notes.decisions.length > 0) {
    lines.push('## Решения', '', ...notes.decisions.map((decision) => `- ${decision}`), '');
  }
  if (notes.actionItems.length > 0) {
    lines.push('## Задачи', '');
    for (const item of notes.actionItems) {
      const owner = item.owner ? ` — ${item.owner}` : '';
      const due = item.due ? ` (до ${item.due})` : '';
      lines.push(`- ${item.text}${owner}${due}`);
    }
    lines.push('');
  }
  if (notes.risks.length > 0) lines.push('## Риски', '', ...notes.risks.map((risk) => `- ${risk}`), '');
  if (notes.topics.length > 0) lines.push('## Темы', '', ...notes.topics.map((topic) => `- ${topic}`), '');
  lines.push(`_Источник: ${notes.source}, сегментов: ${notes.segmentsAnalyzed}, ${new Date(notes.createdAt).toISOString()}_`);
  return lines.join('\n');
}

function analysisMarkdown(room: Room): string {
  const lines = [`# Анализ звонка: ${room.name}`, '', `Комната: \`${room.id}\``, ''];
  if (room.report) {
    lines.push(
      '## Отчёт',
      '',
      `- Создан: ${new Date(room.report.createdAt).toISOString()}`,
      `- Проанализировано сегментов: ${room.report.segmentsAnalyzed}`,
      `- Провайдер: ${room.report.provider ?? 'local'}`,
      `- Находок: ${room.findings.length}`,
    );
    if (room.report.summary) lines.push('', room.report.summary);
    lines.push('');
  } else {
    lines.push('_Отчёт ещё не сформирован._', '');
  }
  if (room.findings.length > 0) {
    lines.push('## Находки', '');
    for (const finding of room.findings) {
      lines.push(`- **${finding.severity}** ${finding.ruleName}: ${finding.excerpt}`);
      if (finding.recommendation) lines.push(`  - Рекомендация: ${finding.recommendation}`);
    }
    lines.push('');
  }
  if (room.notes) lines.push(notesMarkdown(room).replace(/^# .*\n\n/, '## '));
  return lines.join('\n');
}

function notesHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const room = requireRoom(ctx, tenantId);
  const config = roomConfig(room, ctx.tenants.getConfig(tenantId));
  if (config.security.e2ee) throw new HttpError(409, 'analysis_unavailable', 'Analysis is disabled in E2EE rooms');
  room.pruneAnalysis(config.session.aiAgent.retentionMin);
  if (wantsMarkdown(ctx)) {
    sendMarkdownExport(ctx, `notes-${room.id}.md`, notesMarkdown(room));
    return;
  }
  ctx.send(200, { roomId: room.id, notes: room.notes, updatedAt: room.analysisUpdatedAt });
}

function analysisHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const room = requireRoom(ctx, tenantId);
  const config = roomConfig(room, ctx.tenants.getConfig(tenantId));
  if (config.security.e2ee) throw new HttpError(409, 'analysis_unavailable', 'Analysis is disabled in E2EE rooms');
  room.pruneAnalysis(config.session.aiAgent.retentionMin);
  if (wantsMarkdown(ctx)) {
    sendMarkdownExport(ctx, `analysis-${room.id}.md`, analysisMarkdown(room));
    return;
  }
  const response: AnalysisResponse = {
    roomId: room.id,
    report: room.report,
    findings: room.findings,
    notes: room.notes,
  };
  ctx.send(200, response);
}

function analysisRunHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const room = requireRoom(ctx, tenantId);
    const getConfig = () => roomConfig(room, ctx.tenants.getConfig(tenantId));
    if (getConfig().security.e2ee) throw new HttpError(409, 'analysis_unavailable', 'Analysis is disabled in E2EE rooms');
    await runRoomAnalysis({
      room,
      getConfig,
      pipeline: ctx.analysis,
      trigger: 'admin',
      logger: ctx.logger,
      audit: (entry) => audit(ctx, entry),
      webhooks: ctx.services.webhooks,
      notify: (event) => ctx.providers.notify(event),
    });
    if (getConfig().security.e2ee) throw new HttpError(409, 'analysis_unavailable', 'Analysis is disabled in E2EE rooms');
    const response: AnalysisResponse = {
      roomId: room.id,
      report: room.report,
      findings: room.findings,
      notes: room.notes,
    };
    ctx.send(200, response);
  })();
}

function conversationReviewGet(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const roomId = ctx.params.roomId as string;
  const room = ctx.rooms.get(roomId);
  ctx.res.setHeader('cache-control', 'private, no-store');
  if (!room) {
    const archived = ctx.services.conversationReview.archived(tenantId, roomId);
    if (!archived) throw new HttpError(404, 'not_found', 'Conversation review not found');
    ctx.send(200, archived);
    return;
  }
  requireTenantMatch(tenantId, room.tenantId);
  ctx.send(200, ctx.services.conversationReview.report(room));
}

async function conversationReviewPut(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const room = requireRoom(ctx, tenantId);
  const policy = await ctx.jsonSchema(conversationReviewPolicySchema);
  if (room.closed) throw new HttpError(404, 'not_found', 'Room not found');
  const config = roomConfig(room, ctx.tenants.getConfig(tenantId));
  if (policy.enabled && (config.security.e2ee || !config.features.captions)) {
    throw new HttpError(409, 'conversation_review_unavailable', 'Conversation review requires captions and is disabled in E2EE rooms');
  }
  ctx.services.conversationReview.configure(room, policy);
  audit(ctx, {
    type: 'admin.action', severity: 'info', tenantId, roomId: room.id,
    message: 'Conversation review policy updated',
    details: { kind: 'conversation-review.policy', enabled: policy.enabled, rules: policy.enabled ? policy.rules.length : 0 },
  });
  ctx.res.setHeader('cache-control', 'private, no-store');
  ctx.send(200, ctx.services.conversationReview.report(room));
}

/* ------------------------------------------------------------------ */
/* Audit / security / recordings / files                               */
/* ------------------------------------------------------------------ */

function auditHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const limit = intQuery(ctx.query, 'limit', 100, 1, 1000);
  const offset = intQuery(ctx.query, 'offset', 0, 0, 1_000_000);
  const anchorId = ctx.query.get('anchorId') ?? undefined;
  if (anchorId !== undefined && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(anchorId)) {
    throw new HttpError(400, 'validation_failed', 'Invalid audit anchorId');
  }
  const rawType = ctx.query.get('type') ?? undefined;
  if (rawType && !auditEventTypes.includes(rawType as AuditEventType)) {
    throw new HttpError(400, 'validation_failed', `Unknown audit event type: ${rawType}`);
  }
  const rawSeverity = ctx.query.get('severity') ?? undefined;
  const severities = ['info', 'warn', 'critical'] as const;
  if (rawSeverity && !severities.includes(rawSeverity as (typeof severities)[number])) {
    throw new HttpError(400, 'validation_failed', `Unknown audit severity: ${rawSeverity}`);
  }
  const roomId = ctx.query.get('roomId') ?? undefined;
  const query = ctx.query.get('q')?.trim();
  if (query && query.length > 200) throw new HttpError(400, 'validation_failed', 'Audit search accepts up to 200 characters');
  const page = ctx.services.audit.page({
    tenantId,
    limit,
    offset,
    ...(anchorId !== undefined ? { anchorId } : {}),
    ...(rawType ? { type: rawType as AuditEventType } : {}),
    ...(rawSeverity ? { severity: rawSeverity as (typeof severities)[number] } : {}),
    ...(roomId ? { roomId } : {}),
    ...(query ? { query } : {}),
  });
  const response: AuditListResponse = {
    ...page,
    offset,
    limit,
  };
  ctx.send(200, response);
}

function securityHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const entries = ctx.services.audit
    .list({ since, limit: 200 })
    .filter((entry) => entry.tenantId === tenantId);
  const countries: Record<string, number> = {};
  for (const entry of entries) if (entry.country) countries[entry.country] = (countries[entry.country] ?? 0) + 1;
  let suspicious = 0;
  for (const room of ctx.rooms.list(tenantId)) {
    for (const participant of room.participants()) {
      if (participant.integrity === 'suspicious') suspicious += 1;
    }
  }
  const response: SecurityOverview = {
    tenantId,
    events: entries.slice(0, 50),
    failedJoins24h: entries.filter((entry) => entry.type === 'join.denied' || entry.type === 'password.failed').length,
    blockedJoins24h: entries.filter((entry) => entry.type === 'geo.blocked' || entry.type === 'lockout').length,
    suspiciousParticipants: suspicious,
    countries,
  };
  ctx.send(200, response);
}

async function recordingsHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const roomId = ctx.query.get('roomId') || undefined;
  const recordings = await ctx.providers.recordingList({ tenantId, ...(roomId ? { roomId } : {}), limit: 500 });
  if (ctx.env.egressPlaybackEnabled) {
    recordings.push(...ctx.services.egressArchive.records(tenantId, requestOrigin(ctx, tenantId), roomId));
    recordings.sort((first, second) => second.createdAt - first.createdAt);
  }
  ctx.res.setHeader('cache-control', 'no-store');
  ctx.send(200, { recordings: recordings.slice(0, 500) });
}

async function deleteRecordingHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const id = ctx.params.id as string;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(404, 'not_found', 'Recording not found');
  let removed: boolean;
  if (id.startsWith('egress-')) {
    ctx.cluster.assertLeader('egress archive deletion');
    try {
      removed = await ctx.services.egressArchive.remove(tenantId, id);
    } catch (error) {
      if (error instanceof EgressPlaybackError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  } else {
    removed = await ctx.providers.recordingRemove({ tenantId, id });
  }
  if (!removed) throw new HttpError(404, 'not_found', 'Recording not found');
  audit(ctx, {
    type: 'admin.action',
    severity: 'warn',
    tenantId,
    message: `Recording deleted: ${id}`,
    details: { kind: 'recording.deleted', recordingId: id },
  });
  ctx.send(200, { deleted: true });
}

async function quarantineListHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const limit = intQuery(ctx.query, 'limit', 100, 1, 1000);
  const files = ctx.services.quarantine.list({ tenantId, limit });
  ctx.send(200, {
    tenantId,
    count: files.length,
    // Metadata only: quarantined payloads are never served over HTTP.
    files: files.map((record) => ({ ...record, downloadable: false })),
  });
}

async function quarantinePurgeHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const id = ctx.params.id as string;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new HttpError(404, 'not_found', 'Quarantine record not found');
  // Tenant-scoped lookup: a foreign tenant's id answers 404, never 403 (no leak).
  if (!ctx.services.quarantine.get(tenantId, id)) throw new HttpError(404, 'not_found', 'Quarantine record not found');
  const removed = ctx.services.quarantine.remove(tenantId, id);
  if (!removed) throw new HttpError(404, 'not_found', 'Quarantine record not found');
  audit(ctx, {
    type: 'admin.action',
    severity: 'warn',
    tenantId,
    message: `Quarantined upload purged: ${id}`,
    details: { kind: 'quarantine.purged', quarantineId: id },
  });
  ctx.send(200, { deleted: true });
}

async function filesHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const config = ctx.tenants.getConfig(tenantId);
  if (config.features.fileShare !== true) {
    throw new HttpError(403, 'feature_disabled', "Feature 'fileShare' is disabled for this tenant");
  }
  const roomId = ctx.query.get('roomId') ?? undefined;
  const files: FileRecord[] = await ctx.providers.filesList({ tenantId, ...(roomId ? { roomId } : {}), limit: 500 });
  ctx.send(200, { files });
}

/* ------------------------------------------------------------------ */
/* AI agent / knowledge agent / access policy / webhooks               */
/* ------------------------------------------------------------------ */

function aiAgentGetHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  ctx.send(200, settingsForAiAgent(ctx, ctx.tenants.getConfig(tenantId)));
}

function aiAgentPutHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const body = await ctx.jsonSchema(aiAgentPutSchema);
    const config = ctx.tenants.getConfig(tenantId);
    const merged = { ...config.session.aiAgent, ...body.config };
    const parsed = aiAgentConfigSchema.safeParse(merged);
    if (!parsed.success) {
      throw new HttpError(400, 'validation_failed', zodErrorMessage(parsed.error), parsed.error.issues);
    }
    if (parsed.data.endpoint.trim()) {
      assertExternalUrl(parsed.data.endpoint, { secure: isSecureMode(ctx.env) }, 'session.aiAgent.endpoint');
    }
    if (parsed.data.apiKeyEnv && !isAllowedTenantSecretEnv(parsed.data.apiKeyEnv, 'integration')) {
      throw new HttpError(
        400,
        'validation_failed',
        `session.aiAgent.apiKeyEnv must be empty or ${describeTenantSecretEnv('integration')}`,
      );
    }
    const entry = ctx.tenants.patchConfig(tenantId, { session: { aiAgent: parsed.data } });
    const aiAgent = entry.config.session.aiAgent;
    audit(ctx, {
      type: 'config.updated',
      severity: 'info',
      tenantId,
      message: 'AI agent settings updated',
      details: { kind: 'ai-agent', endpoint: aiAgent.endpoint, mode: aiAgent.mode, enabled: aiAgent.enabled, rules: aiAgent.policyRules.length },
    });
    ctx.send(200, settingsForAiAgent(ctx, entry.config));
  })();
}

function knowledgeAgentGetHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  ctx.send(200, settingsForKnowledgeAgent(ctx, ctx.tenants.getConfig(tenantId)));
}

function knowledgeAgentPutHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const body = await ctx.jsonSchema(knowledgeAgentPutSchema);
    const config = ctx.tenants.getConfig(tenantId);
    const merged = { ...config.session.knowledgeAgent, ...body.config };
    const endpoint = typeof merged.endpoint === 'string' ? merged.endpoint : '';
    if (endpoint.trim()) {
      assertExternalUrl(endpoint, { secure: isSecureMode(ctx.env) }, 'session.knowledgeAgent.endpoint');
    }
    if (typeof merged.apiKeyEnv === 'string' && merged.apiKeyEnv && !isAllowedTenantSecretEnv(merged.apiKeyEnv, 'integration')) {
      throw new HttpError(
        400,
        'validation_failed',
        `session.knowledgeAgent.apiKeyEnv must be empty or ${describeTenantSecretEnv('integration')}`,
      );
    }
    let entry;
    try {
      entry = ctx.tenants.patchConfig(tenantId, { session: { knowledgeAgent: merged } });
    } catch (error) {
      if ((error as { name?: string }).name === 'ConfigValidationError') {
        throw new HttpError(400, 'validation_failed', 'Invalid knowledge agent configuration', (error as { issues?: unknown }).issues);
      }
      throw error;
    }
    audit(ctx, {
      type: 'config.updated',
      severity: 'info',
      tenantId,
      message: 'Knowledge agent settings updated',
      details: { kind: 'knowledge-agent', endpoint, enabled: entry.config.session.knowledgeAgent.enabled },
    });
    ctx.send(200, settingsForKnowledgeAgent(ctx, entry.config));
  })();
}

function inCallAgentSettings(ctx: RequestContext, config: TenantConfig): {
  config: TenantConfig['session']['inCallAgent'];
  endpointConfigured: boolean;
  apiKeyConfigured: boolean;
} {
  const agent = config.session.inCallAgent;
  const key = resolveTenantSecret(ctx.env, agent.apiKeyEnv, 'integration').value;
  return {
    config: agent,
    endpointConfigured: agent.endpoint.trim().length > 0,
    apiKeyConfigured: Boolean(key),
  };
}

function inCallAgentGetHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  ctx.send(200, inCallAgentSettings(ctx, ctx.tenants.getConfig(tenantId)));
}

function inCallAgentPutHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const body = await ctx.jsonSchema(inCallAgentPutSchema);
    const config = ctx.tenants.getConfig(tenantId);
    const merged = { ...config.session.inCallAgent, ...body.config };
    const endpoint = typeof merged.endpoint === 'string' ? merged.endpoint : '';
    if (endpoint.trim()) {
      assertExternalUrl(endpoint, { secure: isSecureMode(ctx.env) }, 'session.inCallAgent.endpoint');
    }
    if (typeof merged.apiKeyEnv === 'string' && merged.apiKeyEnv && !isAllowedTenantSecretEnv(merged.apiKeyEnv, 'integration')) {
      throw new HttpError(
        400,
        'validation_failed',
        `session.inCallAgent.apiKeyEnv must be empty or ${describeTenantSecretEnv('integration')}`,
      );
    }
    let entry;
    try {
      entry = ctx.tenants.patchConfig(tenantId, { session: { inCallAgent: merged } });
    } catch (error) {
      if ((error as { name?: string }).name === 'ConfigValidationError') {
        throw new HttpError(400, 'validation_failed', 'Invalid in-call agent configuration', (error as { issues?: unknown }).issues);
      }
      throw error;
    }
    audit(ctx, {
      type: 'config.updated',
      severity: 'info',
      tenantId,
      message: 'In-call assistant settings updated',
      details: {
        kind: 'in-call-agent',
        enabled: entry.config.session.inCallAgent.enabled,
        mode: entry.config.session.inCallAgent.mode,
        endpoint,
        tools: entry.config.session.inCallAgent.allowedTools.length,
      },
    });
    ctx.send(200, inCallAgentSettings(ctx, entry.config));
  })();
}

function knowledgeAskHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const body = await ctx.jsonSchema(knowledgeAskSchema);
    const config = ctx.tenants.getConfig(tenantId);
    const role = body.role ?? 'host';
    // Not configured is a server capability problem, not an authorization
    // failure: return 501 with an actionable message.
    const configurationIssue = knowledgeConfigurationIssue(config, ctx.env);
    if (configurationIssue) {
      audit(ctx, {
        type: 'knowledge.denied',
        severity: 'warn',
        tenantId,
        ...(body.roomId ? { roomId: body.roomId } : {}),
        ip: ctx.ip,
        message: 'Admin knowledge query failed: not configured',
        details: { reason: 'not_configured', role },
      });
      throw new HttpError(501, 'knowledge_not_configured', configurationIssue);
    }
    const access = knowledgeAccessOf({ config, role, userId: body.userId });
    if (!access.allowed) {
      if (access.reason === 'not_configured') {
        throw new HttpError(
          501,
          'knowledge_not_configured',
          knowledgeConfigurationIssue(config, ctx.env) ??
            'Ассистент знаний не настроен: укажите endpoint в /v1/admin/knowledge-agent.',
        );
      }
      audit(ctx, {
        type: 'knowledge.denied',
        severity: 'warn',
        tenantId,
        ...(body.roomId ? { roomId: body.roomId } : {}),
        ip: ctx.ip,
        message: `Admin knowledge query denied: ${access.reason ?? 'forbidden'}`,
        details: { reason: access.reason ?? 'forbidden', role },
      });
      throw new HttpError(403, 'forbidden', access.denyMessage ?? 'Knowledge assistant is not available');
    }
    assertRateLimit(ctx.services.limiters.knowledge.check(`knowledge:${tenantId}:${body.userId ?? 'admin'}`), ctx, 'Too many knowledge queries');
    const outcome = await ctx.services.knowledge.ask({
      config,
      tenantId,
      question: body.question,
      role,
      ...(body.userId ? { userId: body.userId } : {}),
      ...(body.roomId ? { roomId: body.roomId } : {}),
      ...(body.locale ? { locale: body.locale } : {}),
    });
    if (!outcome.ok) {
      throw new HttpError(502, 'internal_error', `Knowledge agent request failed: ${outcome.error}`);
    }
    const response = outcome.response;
    const maxChars = config.session.knowledgeAgent.maxAnswerChars;
    const citations = config.session.knowledgeAgent.citations ? response.citations : [];
    const payload: KnowledgeAskResponse = {
      answer: response.answer.slice(0, maxChars),
      citations,
      ...(response.confidence !== undefined ? { confidence: response.confidence } : {}),
      provider: outcome.provider,
      ...(response.model ? { model: response.model } : {}),
      ...(response.refused !== undefined ? { refused: response.refused } : {}),
    };
    audit(ctx, {
      type: 'knowledge.query',
      severity: 'info',
      tenantId,
      ip: ctx.ip,
      message: 'Admin knowledge query answered',
      details: { provider: outcome.provider, citations: citations.length, refused: Boolean(response.refused) },
    });
    ctx.services.webhooks.emit('knowledge.answer', { tenantId, ...(body.roomId ? { roomId: body.roomId } : {}) }, {
      question: body.question.slice(0, 500),
      answer: payload.answer.slice(0, 500),
      citations: citations.length,
      refused: Boolean(response.refused),
    });
    ctx.send(200, payload);
  })();
}

function accessPolicyGetHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  ctx.send(200, accessPolicyResponse(ctx, tenantId));
}

function expectedFeaturesMatch(current: readonly string[] | undefined, expected: readonly string[] | null | undefined): boolean {
  if (expected === undefined) return true;
  if (expected === null) return current === undefined;
  return current?.length === expected.length && expected.every((feature, index) => feature === current[index]);
}

function accessPolicyPutHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const body = await ctx.jsonSchema(accessPolicyPutSchema);
    const config = ctx.tenants.getConfig(tenantId);
    const current = config.security.accessPolicy;
    const expected = body.expectedPolicy;
    if (expected && (
      (expected.mode !== undefined && expected.mode !== current.mode) ||
      !expectedFeaturesMatch(current.deniedFeatures, expected.deniedFeatures) ||
      roleSchema.options.some((role) => !expectedFeaturesMatch(current.roleDefaults[role], expected.roleDefaults?.[role])) ||
      Object.entries(expected.userOverrides ?? {}).some(([userId, features]) => !expectedFeaturesMatch(
        Object.hasOwn(current.userOverrides, userId) ? current.userOverrides[userId] : undefined,
        features,
      ))
    )) {
      throw new HttpError(409, 'access_policy_conflict', 'The access policy changed. Review the current policy before saving.');
    }
    const incoming = body.policy ?? {};
    const next: AccessPolicy = {
      ...current,
      ...incoming,
      roleDefaults: { ...current.roleDefaults, ...incoming.roleDefaults },
    };

    // Per-user overrides must be revocable. An explicit `userOverrides: {}`
    // (or `clearUserOverrides`) replaces/removes entries instead of deep-merging
    // them back — otherwise a fired employee keeps their personal permissions.
    let revoked = 0;
    if (Object.prototype.hasOwnProperty.call(incoming, 'userOverrides')) {
      const overrides = incoming.userOverrides ?? {};
      if (Object.keys(overrides).length === 0) {
        revoked = Object.keys(current.userOverrides).length;
        next.userOverrides = {};
      } else {
        next.userOverrides = { ...current.userOverrides, ...overrides };
      }
    }
    if (body.clearUserOverrides && body.clearUserOverrides.length > 0) {
      const copy = { ...next.userOverrides };
      for (const userId of body.clearUserOverrides) {
        if (Object.prototype.hasOwnProperty.call(copy, userId)) {
          delete copy[userId];
          revoked += 1;
        }
      }
      next.userOverrides = copy;
    }

    const full: TenantConfig = { ...config, security: { ...config.security, accessPolicy: next } };
    let entry;
    try {
      // putConfig replaces the whole (validated) config, so removals are real.
      entry = ctx.tenants.putConfig(tenantId, full);
    } catch (error) {
      if ((error as { name?: string }).name === 'ConfigValidationError') {
        throw new HttpError(400, 'validation_failed', 'Invalid access policy', (error as { issues?: unknown }).issues);
      }
      throw error;
    }
    audit(ctx, {
      type: 'access.updated',
      severity: 'info',
      tenantId,
      ip: ctx.ip,
      message: 'Access policy updated',
      details: {
        mode: entry.config.security.accessPolicy.mode,
        denied: entry.config.security.accessPolicy.deniedFeatures.length,
        overrides: Object.keys(entry.config.security.accessPolicy.userOverrides).length,
        ...(revoked > 0 ? { revokedOverrides: revoked } : {}),
      },
    });
    ctx.send(200, accessPolicyResponse(ctx, tenantId));
  })();
}

function webhooksGetHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  ctx.send(200, webhooksResponse(ctx, tenantId));
}

function webhooksPutHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const body = await ctx.jsonSchema(webhooksPutSchema);
    const secure = isSecureMode(ctx.env);
    body.webhooks.forEach((webhook, index) => {
      assertExternalUrl(webhook.url, { secure }, `webhooks[${index}].url`);
      if (!isAllowedTenantSecretEnv(webhook.secretEnv, 'webhook')) {
        throw new HttpError(
          400,
          'validation_failed',
          `webhooks[${index}].secretEnv must be ${describeTenantSecretEnv('webhook')}`,
        );
      }
    });
    ctx.tenants.patchConfig(tenantId, { integrations: { webhooks: body.webhooks } });
    audit(ctx, {
      type: 'admin.action',
      severity: 'warn',
      tenantId,
      message: `Webhook endpoints replaced (${body.webhooks.length})`,
      details: { kind: 'webhooks.updated', count: body.webhooks.length, events: body.webhooks.flatMap((webhook) => webhook.events) },
    });
    ctx.send(200, webhooksResponse(ctx, tenantId));
  })();
}

function webhooksTestHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const body = await ctx.jsonSchema(webhooksTestSchema);
    const endpoint = ctx.tenants
      .getConfig(tenantId)
      .integrations.webhooks.find((candidate) => candidate.id === body.endpointId);
    if (!endpoint) throw new HttpError(404, 'not_found', 'Webhook endpoint not found');
    const result = await ctx.services.webhooks.test(tenantId, endpoint);
    const response: WebhookTestResponse = result;
    audit(ctx, {
      type: 'admin.action',
      severity: result.status === 'delivered' ? 'info' : 'warn',
      tenantId,
      message: `Webhook test ${result.status} for ${endpoint.id}`,
      details: { kind: 'webhooks.test', endpointId: endpoint.id, status: result.status, statusCode: result.statusCode, error: result.error },
    });
    ctx.send(200, response);
  })();
}

/* ------------------------------------------------------------------ */
/* Capability providers (§23)                                          */
/* ------------------------------------------------------------------ */

function providersGetHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const response: ProvidersResponse = ctx.providers.status(tenantId);
  ctx.send(200, response);
}

function providersPutHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const body = await ctx.jsonSchema(providersPutSchema);
    const current = ctx.tenants.getConfig(tenantId).providers;
    const secure = isSecureMode(ctx.env);
    const merged: Record<string, unknown> = { ...current };
    for (const [slotName, provided] of Object.entries(body.providers)) {
      const currentSlot = current[slotName as ProviderSlotName];
      const next: Record<string, unknown> = { ...currentSlot, ...provided };
      const mode = next.mode;
      if (mode !== 'builtin' && mode !== 'external' && mode !== 'disabled') {
        throw new HttpError(400, 'validation_failed', `providers.${slotName}.mode must be builtin|external|disabled`);
      }
      if (mode === 'external') {
        const endpoint = typeof next.endpoint === 'string' ? next.endpoint.trim() : '';
        if (!endpoint) {
          throw new HttpError(400, 'validation_failed', `providers.${slotName}.endpoint is required for external mode`);
        }
        assertExternalUrl(endpoint, { secure }, `providers.${slotName}.endpoint`);
        const apiKeyEnv = typeof next.apiKeyEnv === 'string' ? next.apiKeyEnv : '';
        if (!isAllowedTenantSecretEnv(apiKeyEnv, 'integration')) {
          throw new HttpError(
            400,
            'validation_failed',
            `providers.${slotName}.apiKeyEnv must be empty or ${describeTenantSecretEnv('integration')}`,
          );
        }
      }
      merged[slotName] = next;
    }
    const entry = ctx.tenants.patchConfig(tenantId, { providers: merged });
    audit(ctx, {
      type: 'admin.action',
      severity: 'warn',
      tenantId,
      ip: ctx.ip,
      message: `Capability providers updated (${Object.keys(body.providers).join(', ')})`,
      details: {
        kind: 'providers.updated',
        slots: Object.keys(body.providers),
        modes: Object.fromEntries(
          Object.entries(entry.config.providers).map(([slot, value]) => [slot, value.mode]),
        ),
      },
    });
    const response: ProvidersResponse = ctx.providers.status(tenantId);
    ctx.send(200, response);
  })();
}

function providersTestHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const body = await ctx.jsonSchema(providersTestSchema);
    const result = await ctx.providers.test(tenantId, body.slot, body.payload);
    audit(ctx, {
      type: 'admin.action',
      severity: result.ok ? 'info' : 'warn',
      tenantId,
      ip: ctx.ip,
      message: `Provider test ${body.slot}: ${result.ok ? 'ok' : 'failed'} (${result.latencyMs}ms)`,
      details: { kind: 'providers.test', slot: body.slot, ok: result.ok, provider: result.providerName, latencyMs: result.latencyMs },
    });
    ctx.send(200, result);
  })();
}

/* ------------------------------------------------------------------ */
/* Scale-out status (single-node MVP: config + flags, no orchestration) */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Roles: built-in host/moderator/guest + company-defined custom roles */
/* ------------------------------------------------------------------ */

const BUILTIN_ROLES: Array<{ id: 'host' | 'moderator' | 'guest'; name: string; description: string; canModerate: boolean }> = [
  { id: 'host', name: 'Ведущий', description: 'Организатор звонка: полный доступ, запись, модерация, настройки комнаты.', canModerate: true },
  { id: 'moderator', name: 'Модератор', description: 'Помогает вести звонок: модерация, запись, чат; без изменения конфигурации тенанта.', canModerate: true },
  { id: 'guest', name: 'Гость', description: 'Обычный участник: чат, реакции, демонстрация экрана; запись и админ-действия недоступны.', canModerate: false },
];

const RESERVED_ROLE_IDS = new Set(['host', 'moderator', 'guest']);
const MAX_CUSTOM_ROLES = 30;

function roleAssignments(ctx: RequestContext, tenantId: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const room of ctx.rooms.list(tenantId)) {
    for (const roleId of room.participantRoleIds()) {
      counts.set(roleId, (counts.get(roleId) ?? 0) + 1);
    }
  }
  return counts;
}

function builtinRoleDefinitions(config: TenantConfig): RoleDefinition[] {
  return BUILTIN_ROLES.map((info) => ({
    id: info.id,
    name: info.name,
    description: info.description,
    baseRole: info.id,
    features: config.security.accessPolicy.roleDefaults[info.id],
    canModerate: info.canModerate,
    color: '',
    builtin: true,
  }));
}

function customRoleDefinition(
  role: TenantConfig['security']['accessPolicy']['customRoles'][number],
  assigned: number,
): RoleDefinition {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    baseRole: role.baseRole,
    features: role.features,
    canModerate: role.canModerate,
    color: role.color,
    builtin: false,
    assigned,
  };
}

function rolesResponse(ctx: RequestContext, tenantId: string): RolesResponse {
  const config = ctx.tenants.getConfig(tenantId);
  const counts = roleAssignments(ctx, tenantId);
  return {
    roles: [
      ...builtinRoleDefinitions(config),
      ...config.security.accessPolicy.customRoles.map((role) =>
        customRoleDefinition(role, counts.get(role.id) ?? 0),
      ),
    ],
  };
}

function rolesGetHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  ctx.send(200, rolesResponse(ctx, tenantId));
}

function roleCreateHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const body = await ctx.jsonSchema(roleCreateSchema);
    if (RESERVED_ROLE_IDS.has(body.id)) {
      throw new HttpError(400, 'validation_failed', `Role id '${body.id}' is reserved for a built-in role`);
    }
    const config = ctx.tenants.getConfig(tenantId);
    const customRoles = config.security.accessPolicy.customRoles;
    if (customRoles.some((role) => role.id === body.id)) {
      throw new HttpError(409, 'validation_failed', `Role '${body.id}' already exists`);
    }
    if (customRoles.length >= MAX_CUSTOM_ROLES) {
      throw new HttpError(409, 'validation_failed', `Role limit reached (${MAX_CUSTOM_ROLES})`);
    }
    const role = {
      id: body.id,
      name: body.name,
      description: body.description ?? '',
      baseRole: body.baseRole,
      features: [...new Set(body.features)],
      canModerate: body.canModerate ?? body.baseRole !== 'guest',
      color: body.color ?? '',
    };
    const entry = ctx.tenants.patchConfig(tenantId, {
      security: { accessPolicy: { customRoles: [...customRoles, role] } },
    });
    audit(ctx, {
      type: 'admin.action',
      severity: 'info',
      tenantId,
      ip: ctx.ip,
      message: `Custom role created: ${role.name} (${role.id})`,
      details: { kind: 'role.created', roleId: role.id, baseRole: role.baseRole, features: role.features.length },
    });
    void entry;
    ctx.send(200, customRoleDefinition(role, 0));
  })();
}

function roleUpdateHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const roleId = String(ctx.params.id ?? '');
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(roleId)) {
      throw new HttpError(400, 'validation_failed', 'Invalid role id');
    }
    if (RESERVED_ROLE_IDS.has(roleId)) {
      throw new HttpError(403, 'forbidden', 'Built-in roles are managed via the access policy and cannot be edited');
    }
    const body = await ctx.jsonSchema(roleUpdateSchema);
    const config = ctx.tenants.getConfig(tenantId);
    const customRoles = config.security.accessPolicy.customRoles;
    const existing = customRoles.find((role) => role.id === roleId);
    if (!existing) throw new HttpError(404, 'not_found', 'Role not found');
    const updated = {
      id: roleId,
      name: body.name,
      description: body.description ?? existing.description,
      baseRole: body.baseRole,
      features: [...new Set(body.features)],
      canModerate: body.canModerate ?? existing.canModerate,
      color: body.color ?? existing.color,
    };
    ctx.tenants.patchConfig(tenantId, {
      security: {
        accessPolicy: {
          customRoles: customRoles.map((role) => (role.id === roleId ? updated : role)),
        },
      },
    });
    audit(ctx, {
      type: 'admin.action',
      severity: 'info',
      tenantId,
      ip: ctx.ip,
      message: `Custom role updated: ${updated.name} (${roleId})`,
      details: { kind: 'role.updated', roleId, baseRole: updated.baseRole, features: updated.features.length },
    });
    ctx.send(200, customRoleDefinition(updated, roleAssignments(ctx, tenantId).get(roleId) ?? 0));
  })();
}

function roleDeleteHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const roleId = String(ctx.params.id ?? '');
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(roleId)) {
      throw new HttpError(400, 'validation_failed', 'Invalid role id');
    }
    if (RESERVED_ROLE_IDS.has(roleId)) {
      throw new HttpError(403, 'forbidden', 'Built-in roles cannot be deleted');
    }
    const config = ctx.tenants.getConfig(tenantId);
    const customRoles = config.security.accessPolicy.customRoles;
    const existing = customRoles.find((role) => role.id === roleId);
    if (!existing) throw new HttpError(404, 'not_found', 'Role not found');
    const affectedParticipants = roleAssignments(ctx, tenantId).get(roleId) ?? 0;
    ctx.tenants.patchConfig(tenantId, {
      security: {
        accessPolicy: { customRoles: customRoles.filter((role) => role.id !== roleId) },
      },
    });
    audit(ctx, {
      type: 'admin.action',
      severity: 'warn',
      tenantId,
      ip: ctx.ip,
      message: `Custom role deleted: ${existing.name} (${roleId})`,
      details: { kind: 'role.deleted', roleId, affectedParticipants },
    });
    ctx.send(200, { deleted: true, affectedParticipants });
  })();
}

/* ------------------------------------------------------------------ */
/* Dashboard mascot assistant + critical-change guard                   */
/* ------------------------------------------------------------------ */

const dashboardRoleSchema = z.enum([
  'assistant',
  'config-guardian',
  'security-reviewer',
  'onboarding',
  'api-helper',
  'scaling-advisor',
  'roles-admin',
]);

const dashboardAssistantSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(12),
  role: dashboardRoleSchema.optional(),
  context: z
    .object({
      screen: z.string().max(120).optional(),
      tenantId: z.string().max(64).optional(),
      roomId: z.string().max(64).optional(),
      currentConfig: z.unknown().optional(),
      memory: z.string().max(4000).optional(),
      chatId: z.string().max(128).optional(),
    })
    .optional(),
});

const guardAssessSchema = z.object({
  kind: z.enum(['config', 'roles', 'access', 'scale', 'providers', 'webhook', 'room', 'integrations']),
  locale: z.enum(['ru', 'en']).optional(),
  current: z.unknown().optional(),
  next: z.unknown(),
  editorDraft: z.boolean().optional(),
  intent: z.string().max(500).optional(),
});

function guardCurrentValue(
  ctx: RequestContext,
  tenantId: string,
  kind: GuardAssessRequest['kind'],
): unknown {
  const config = ctx.tenants.getConfig(tenantId);
  switch (kind) {
    case 'roles':
      return { roles: rolesResponse(ctx, tenantId).roles };
    case 'access':
      return config.security.accessPolicy;
    case 'integrations':
      return config.integrations;
    case 'providers':
      return config.providers;
    case 'scale':
      return config.scale;
    case 'webhook':
      return { webhooks: config.integrations.webhooks };
    case 'room':
      return {
        rooms: ctx.rooms.list(tenantId).map((room) => ({
          id: room.id,
          name: room.name,
          mode: room.mode,
          locked: room.locked,
          participants: room.participants().length,
          maxParticipants: room.maxParticipants,
        })),
      };
    case 'config':
    default:
      return config;
  }
}

function validateGuardNext(kind: GuardAssessRequest['kind'], next: unknown, editorDraft = false): void {
  const parsed =
    kind === 'config'
      ? (editorDraft ? tenantConfigSchema : tenantConfigPatchSchema).safeParse(next)
      : kind === 'roles'
        ? z.object({ roles: z.array(z.unknown()) }).safeParse(next)
        : z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).safeParse(next);
  if (!parsed.success) {
    throw new HttpError(
      400,
      'validation_failed',
      zodErrorMessage(parsed.error as Parameters<typeof zodErrorMessage>[0]),
      (parsed.error as { issues?: unknown }).issues,
    );
  }
}

function assistantPromptsHandler(ctx: RequestContext): void {
  adminTenant(ctx);
  ctx.send(200, { prompts: assistantPromptInfo() });
}

function dashboardAssistantHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    assertRateLimit(ctx.services.limiters.assistant.check(`dashboard:${tenantId}`), ctx, 'Too many assistant requests');
    const body = (await ctx.jsonSchema(dashboardAssistantSchema)) as DashboardAssistantRequest;
    const started = Date.now();
    const response: DashboardAssistantResponse = await answerDashboardAssistant(ctx.env, body);
    audit(ctx, {
      type: 'admin.action',
      severity: 'info',
      tenantId,
      ip: ctx.ip,
      message: 'Dashboard assistant answered',
      details: {
        kind: 'admin.assistant.used',
        role: response.role,
        fallback: response.fallback,
        model: response.model,
        messageLength: body.messages.reduce((sum, message) => sum + message.content.length, 0),
        ...(body.context?.chatId ? { chatId: body.context.chatId } : {}),
        latencyMs: Date.now() - started,
      },
    });
    ctx.send(200, response);
  })();
}

function guardAssessHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const body = (await ctx.jsonSchema(guardAssessSchema)) as GuardAssessRequest;
    validateGuardNext(body.kind, body.next, body.editorDraft);
    const current = body.current !== undefined ? body.current : guardCurrentValue(ctx, tenantId, body.kind);
    const rooms = ctx.rooms.list(tenantId);
    const response: GuardAssessResponse = assessChange({ ...body, current }, current, {
      rooms: rooms.length,
      participants: rooms.reduce((sum, room) => sum + room.participants().length, 0),
    });
    audit(ctx, {
      type: 'admin.action',
      severity: response.risk === 'high' || response.risk === 'critical' ? 'warn' : 'info',
      tenantId,
      ip: ctx.ip,
      message: `Guard assessed ${body.kind} change (${response.risk})`,
      details: {
        kind: 'admin.guard.assessed',
        changeKind: body.kind,
        risk: response.risk,
        findings: response.findings.length,
        requiresConfirmation: response.requiresConfirmation,
      },
    });
    ctx.send(200, response);
  })();
}

/* ------------------------------------------------------------------ */
/* Docs CMS: bundled + editable copies, versions, default document     */
/* ------------------------------------------------------------------ */

const docRevision = z.string().regex(/^[0-9a-f]{64}$/);
const docWriteSchema = z.object({
  content: z.string(),
  title: z.string().max(200).optional(),
  expectedRevision: docRevision.nullable().optional(),
});
const docRevisionSchema = z.object({ expectedRevision: docRevision.optional() });

const docUploadJsonSchema = docWriteSchema.extend({
  name: z.string().min(1).max(160),
});

const docDefaultSchema = z.object({ name: z.string().min(1).max(160) });

function docsHttpError(error: unknown): never {
  if (error instanceof DocsError) throw new HttpError(error.status, error.code, error.message);
  throw error;
}

function docsAdmin(ctx: RequestContext): { actor: string; editable: boolean } {
  if (isPlatformKey(ctx.env, ctx.headers)) {
    assertRateLimit(ctx.services.limiters.admin.check('admin:platform'), ctx, 'Too many admin requests');
    return { actor: ctx.env.defaultTenantId, editable: true };
  }
  const actor = adminTenant(ctx);
  return { actor, editable: !ctx.env.platformKey && actor === ctx.env.defaultTenantId };
}

function requireDocsEditor(ctx: RequestContext): string {
  const access = docsAdmin(ctx);
  if (!access.editable) throw new HttpError(403, 'forbidden', 'Platform document editor is required');
  return access.actor;
}

function docsListHandler(ctx: RequestContext): void {
  const { editable } = docsAdmin(ctx);
  const list = ctx.services.docs.list();
  const docs = editable ? list.docs : list.docs.map((doc) => ({ ...doc, versions: 0 }));
  ctx.send(200, { ...list, docs, editable, revisionRestore: true, conditionalCreate: true } satisfies DocsListResponse);
}

function docReadHandler(ctx: RequestContext): void {
  docsAdmin(ctx);
  try {
    ctx.send(200, ctx.services.docs.read(String(ctx.params.name ?? '')) satisfies DocContentResponse);
  } catch (error) {
    docsHttpError(error);
  }
}

function docWriteHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = requireDocsEditor(ctx);
    const name = String(ctx.params.name ?? '');
    const body = await ctx.jsonSchema(docWriteSchema);
    if (Buffer.byteLength(body.content, 'utf8') > MAX_DOC_BYTES) {
      throw new HttpError(413, 'payload_too_large', `Document exceeds ${MAX_DOC_BYTES} bytes`);
    }
    try {
      ctx.cluster.assertLeader('document publication');
      const doc = ctx.services.docs.write(name, body.content, body.title, undefined, body.expectedRevision);
      audit(ctx, {
        type: 'admin.action',
        severity: 'info',
        tenantId,
        ip: ctx.ip,
        message: `Document updated: ${doc.name}`,
        details: { kind: 'docs.updated', name: doc.name, sizeBytes: Buffer.byteLength(doc.content, 'utf8') },
      });
      ctx.send(200, doc);
    } catch (error) {
      docsHttpError(error);
    }
  })();
}

function docUploadHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = requireDocsEditor(ctx);
    const contentType = String(ctx.headers['content-type'] ?? '');
    let name = '';
    let content = '';
    let title: string | undefined;
    let expectedRevision: string | null | undefined;
    if (contentType.includes('application/json')) {
      const body = await ctx.jsonSchema(docUploadJsonSchema);
      name = sanitizeDocName(body.name);
      content = body.content;
      title = body.title;
      expectedRevision = body.expectedRevision;
    } else {
      const raw = await ctx.raw(MAX_DOC_BYTES + 1, 'payload_too_large');
      if (raw.length > MAX_DOC_BYTES) throw new HttpError(413, 'payload_too_large', `Document exceeds ${MAX_DOC_BYTES} bytes`);
      const headerName = ctx.headers['x-file-name'];
      if (typeof headerName !== 'string' || !headerName.trim()) {
        throw new HttpError(400, 'validation_failed', 'x-file-name header is required');
      }
      name = sanitizeDocName(headerName);
      content = raw.toString('utf8');
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_DOC_BYTES) {
      throw new HttpError(413, 'payload_too_large', `Document exceeds ${MAX_DOC_BYTES} bytes`);
    }
    try {
      ctx.cluster.assertLeader('document upload');
      const doc = ctx.services.docs.upload(name, content, title, expectedRevision);
      audit(ctx, {
        type: 'admin.action',
        severity: 'info',
        tenantId,
        ip: ctx.ip,
        message: `Document uploaded: ${doc.name}`,
        details: { kind: 'docs.uploaded', name: doc.name, sizeBytes: Buffer.byteLength(doc.content, 'utf8') },
      });
      ctx.send(200, doc);
    } catch (error) {
      docsHttpError(error);
    }
  })();
}

async function docDeleteHandler(ctx: RequestContext): Promise<void> {
  const tenantId = requireDocsEditor(ctx);
  const name = String(ctx.params.name ?? '');
  const body = await ctx.jsonSchema(docRevisionSchema);
  try {
    ctx.cluster.assertLeader('document reset');
    const result = ctx.services.docs.reset(name, body.expectedRevision);
    audit(ctx, {
      type: 'admin.action',
      severity: 'info',
      tenantId,
      ip: ctx.ip,
      message: `Document reset: ${result.name}`,
      details: { kind: 'docs.reset', name: result.name, bundled: result.bundled },
    });
    ctx.send(200, result);
  } catch (error) {
    docsHttpError(error);
  }
}

function docVersionsHandler(ctx: RequestContext): void {
  requireDocsEditor(ctx);
  try {
    ctx.send(200, ctx.services.docs.history(String(ctx.params.name ?? '')) satisfies DocHistoryResponse);
  } catch (error) {
    docsHttpError(error);
  }
}

function docVersionHandler(ctx: RequestContext): void {
  requireDocsEditor(ctx);
  try {
    ctx.send(200, ctx.services.docs.versionContent(String(ctx.params.name ?? ''), String(ctx.params.versionId ?? '')));
  } catch (error) {
    docsHttpError(error);
  }
}

function docRestoreHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = requireDocsEditor(ctx);
    const name = String(ctx.params.name ?? '');
    const versionId = String(ctx.params.versionId ?? '');
    const body = await ctx.jsonSchema(docRevisionSchema);
    try {
      ctx.cluster.assertLeader('document restoration');
      const doc = ctx.services.docs.restore(name, versionId, body.expectedRevision);
      audit(ctx, {
        type: 'admin.action',
        severity: 'info',
        tenantId,
        ip: ctx.ip,
        message: `Document restored: ${doc.name} from version ${versionId}`,
        details: { kind: 'docs.restored', name: doc.name, versionId },
      });
      ctx.send(200, doc);
    } catch (error) {
      docsHttpError(error);
    }
  })();
}

function docDefaultHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = requireDocsEditor(ctx);
    const body = await ctx.jsonSchema(docDefaultSchema);
    try {
      ctx.cluster.assertLeader('default document change');
      const result = ctx.services.docs.setDefault(body.name);
      audit(ctx, {
        type: 'admin.action',
        severity: 'info',
        tenantId,
        ip: ctx.ip,
        message: `Default document changed: ${result.defaultName}`,
        details: { kind: 'docs.default.changed', name: result.defaultName },
      });
      ctx.send(200, { updated: true, defaultName: result.defaultName });
    } catch (error) {
      docsHttpError(error);
    }
  })();
}

/* ------------------------------------------------------------------ */
/* SaaS: platform owner manages tenants (AGIL_PLATFORM_KEY)            */
/* ------------------------------------------------------------------ */

const tenantIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, 'tenantId: latin letters, digits, dot, underscore, dash');

const tenantCreateSchema = z.object({
  tenantId: tenantIdSchema,
  name: z.string().min(1).max(64),
  organizationName: z.string().max(128).optional(),
  branding: z
    .object({
      productName: z.string().min(1).max(64).optional(),
      logoUrl: z.string().max(500).optional(),
      faviconUrl: z.string().max(500).optional(),
      supportUrl: z.string().max(500).optional(),
      footerText: z.string().max(300).optional(),
    })
    .optional(),
  theme: z
    .object({
      preset: z.string().max(32).optional(),
      scheme: z.enum(['light', 'dark', 'auto']).optional(),
      colors: z.record(z.string(), z.string().max(80)).optional(),
    })
    .optional(),
  templateTenantId: z.string().max(64).optional(),
  preset: z.enum(['default', 'corporate', 'minimal']).optional(),
  features: z.partialRecord(featureKeySchema, z.boolean()).optional(),
});

const tenantPatchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  organizationName: z.string().max(128).optional(),
  branding: z
    .object({
      productName: z.string().min(1).max(64).optional(),
      organizationName: z.string().max(128).optional(),
      logoUrl: z.string().max(500).optional(),
      faviconUrl: z.string().max(500).optional(),
      supportUrl: z.string().max(500).optional(),
      footerText: z.string().max(300).optional(),
    })
    .optional(),
  theme: z
    .object({
      scheme: z.enum(['light', 'dark', 'auto']).optional(),
      colors: z.record(z.string(), z.string().max(80)).optional(),
    })
    .optional(),
});

const PRESET_PATCHES: Record<'default' | 'corporate' | 'minimal', TenantConfigPatch> = {
  default: {},
  corporate: {
    security: { waitingRoom: true, maxFailedJoinAttempts: 5, lockoutSec: 600 },
    features: { fileShare: false, recording: false },
    session: { recording: { enabled: false, storeOnServer: false } },
  },
  minimal: {
    features: {
      fileShare: false,
      recording: false,
      captions: false,
      knowledgeAgent: false,
      screenShare: false,
      liveStreaming: false,
      webinarMode: false,
      breakoutRooms: false,
      translation: false,
    },
  },
};

const BRAND_COLOR_KEYS = ['primary', 'primaryHover', 'primaryActive', 'onPrimary', 'accent', 'onAccent'] as const;

/**
 * Builds a COMPLETE palette for a scheme/preset before merging custom colors.
 *
 * Semantic tokens always come from the preset for the requested scheme, custom
 * colors are merged on top, and brand colors are preserved on scheme changes.
 * `auto` themes keep the light semantic base (the widget derives dark via
 * displayTheme), but the derived dark palette is still validated.
 */
function buildTenantTheme(input: {
  scheme?: 'light' | 'dark' | 'auto';
  preset?: string;
  colors?: Record<string, string>;
  current?: ThemeTokens;
}): ThemeTokens {
  const scheme = input.scheme ?? input.current?.scheme ?? 'auto';
  const requestedPreset =
    input.preset && (themePresetNames as readonly string[]).includes(input.preset)
      ? (input.preset as ThemePresetName)
      : undefined;
  const presetScheme = requestedPreset
    ? requestedPreset === 'dark' || requestedPreset === 'night'
      ? 'dark'
      : 'light'
    : undefined;
  const baseScheme: 'light' | 'dark' = scheme === 'auto' ? (presetScheme ?? 'light') : scheme;
  const basePreset =
    requestedPreset && presetScheme === baseScheme ? themePresets[requestedPreset] : themePresets[baseScheme];
  const inheritedBrand: Record<string, string> = {};
  if (input.current) {
    for (const key of BRAND_COLOR_KEYS) {
      const value = input.current.colors[key];
      if (value) inheritedBrand[key] = value;
    }
  }
  const presetBrand: Record<string, string> = requestedPreset
    ? Object.fromEntries(BRAND_COLOR_KEYS.filter((key) => themePresets[requestedPreset].colors[key]).map((key) => [key, themePresets[requestedPreset].colors[key]]))
    : {};
  const colors = {
    ...themePresets[baseScheme].colors,
    ...presetBrand,
    ...inheritedBrand,
    ...(input.colors ?? {}),
  };
  let theme = themeSchema.parse({
    ...structuredClone(basePreset),
    scheme,
    colors,
    ...(input.current
      ? { background: input.current.background, shape: input.current.shape, spacing: input.current.spacing }
      : {}),
  });
  // A custom brand primary must regenerate hover/active/onPrimary/focus tokens
  // (otherwise a purple primary keeps the default blue hover).
  if (input.colors?.primary) theme = applyBrandColor(theme, input.colors.primary);
  if (scheme === 'auto') displayTheme(theme, true); // ensures the derived dark palette is complete
  return theme;
}

function tenantIdsFor(ctx: RequestContext): string[] {
  const store = apiKeyStore(ctx.env);
  return [
    ...new Set([
      ...ctx.tenants.listTenants(),
      ctx.env.defaultTenantId,
      ...Object.values(ctx.env.apiKeys),
      ...store.tenantIds(),
    ]),
  ].filter((tenantId) => !ctx.tenants.isRetired(tenantId)).sort();
}

function tenantSummary(ctx: RequestContext, tenantId: string): TenantSummary {
  const config = ctx.tenants.getConfig(tenantId);
  const rooms = ctx.rooms.list(tenantId);
  const store = apiKeyStore(ctx.env);
  return {
    tenantId,
    name: config.branding.productName || tenantId,
    organizationName: config.branding.organizationName ?? '',
    productName: config.branding.productName,
    logoUrl: config.branding.logoUrl,
    scheme: config.theme.scheme,
    rooms: rooms.length,
    participants: rooms.reduce((sum, room) => sum + room.participants().length, 0),
    recordings: ctx.services.recordings.list({ tenantId, limit: 1000 }).length,
    apiKeyConfigured: store.has(tenantId),
    ...(store.createdAt(tenantId) !== undefined ? { createdAt: store.createdAt(tenantId) } : {}),
  };
}

function platformTenantId(ctx: RequestContext): string {
  const tenantId = String(ctx.params.tenantId ?? '');
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(tenantId)) throw new HttpError(400, 'validation_failed', 'Invalid tenant id');
  return tenantId;
}

function tenantsListHandler(ctx: RequestContext): void {
  requirePlatformKey(ctx);
  const response: TenantsResponse = {
    tenants: tenantIdsFor(ctx).map((tenantId) => tenantSummary(ctx, tenantId)),
    platform: true,
  };
  ctx.send(200, response);
}

function tenantReadHandler(ctx: RequestContext): void {
  const tenantId = platformTenantId(ctx);
  assertTenantAdminAccess(ctx, tenantId);
  if (ctx.tenants.isRetired(tenantId)) throw new HttpError(404, 'not_found', 'Tenant not found');
  ctx.send(200, tenantSummary(ctx, tenantId));
}

function tenantCreateHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    requirePlatformKey(ctx);
    ctx.cluster.assertLeader('tenant creation');
    const body = await ctx.jsonSchema(tenantCreateSchema);
    if (ctx.tenants.isRetired(body.tenantId)) {
      throw new HttpError(409, 'tenant_id_retired', 'This identifier belongs to a retired organization');
    }
    const existing = new Set(tenantIdsFor(ctx));
    if (existing.has(body.tenantId)) throw new HttpError(409, 'validation_failed', `Tenant '${body.tenantId}' already exists`);
    if (body.templateTenantId && !existing.has(body.templateTenantId)) {
      throw new HttpError(400, 'validation_failed', `Unknown template tenant: ${body.templateTenantId}`);
    }

    const preset = body.preset ?? 'default';
    const base = body.templateTenantId
      ? structuredClone(ctx.tenants.getConfig(body.templateTenantId))
      : defaultConfig({ tenantId: body.tenantId });
    const fullTheme = body.theme
      ? buildTenantTheme({ ...(body.theme.scheme ? { scheme: body.theme.scheme } : {}), ...(body.theme.preset ? { preset: body.theme.preset } : {}), ...(body.theme.colors ? { colors: body.theme.colors } : {}) })
      : undefined;
    const branding: Record<string, unknown> = {
      productName: body.branding?.productName ?? body.name,
      organizationName: body.organizationName ?? body.branding?.productName ?? '',
      ...(body.branding?.logoUrl ? { logoUrl: body.branding.logoUrl } : {}),
      ...(body.branding?.faviconUrl ? { faviconUrl: body.branding.faviconUrl } : {}),
      ...(body.branding?.supportUrl ? { supportUrl: body.branding.supportUrl } : {}),
      ...(body.branding?.footerText ? { footerText: body.branding.footerText } : {}),
    };
    const presetPatch = PRESET_PATCHES[preset];
    const patch = {
      tenantId: body.tenantId,
      branding,
      ...(fullTheme ? { theme: fullTheme } : {}),
      ...presetPatch,
      ...(body.features ? { features: { ...presetPatch.features, ...body.features } } : {}),
    };
    let config;
    try {
      config = resolveTenantConfig(patch as Parameters<typeof resolveTenantConfig>[0], base, { tenantId: body.tenantId });
      ctx.tenants.putConfig(body.tenantId, config);
    } catch (error) {
      if ((error as { name?: string }).name === 'ConfigValidationError') {
        throw new HttpError(400, 'validation_failed', 'Invalid tenant configuration', (error as { issues?: unknown }).issues);
      }
      throw error;
    }
    const issued = apiKeyStore(ctx.env).issue(body.tenantId);
    audit(ctx, {
      type: 'admin.action',
      severity: 'info',
      tenantId: body.tenantId,
      ip: ctx.ip,
      message: `Tenant created: ${body.name}`,
      details: { kind: 'tenant.created', name: body.name, preset, templateTenantId: body.templateTenantId ?? null },
    });
    const response: TenantCreatedResponse = {
      tenant: tenantSummary(ctx, body.tenantId),
      apiKey: issued.apiKey,
      embedUrl: `${ctx.env.publicOrigin.replace(/\/$/, '')}/embed.html?tenant=${encodeURIComponent(body.tenantId)}`,
    };
    ctx.send(200, response);
  })();
}

function tenantPatchHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = platformTenantId(ctx);
    assertTenantAdminAccess(ctx, tenantId);
    ctx.cluster.assertLeader('tenant configuration updates');
    const body = await ctx.jsonSchema(tenantPatchSchema);
    if (ctx.tenants.isRetired(tenantId)) throw new HttpError(404, 'not_found', 'Tenant not found');
    const patch: Record<string, unknown> = {};
    if (body.name || body.branding || body.organizationName !== undefined) {
      patch.branding = {
        ...(body.name || body.branding?.productName ? { productName: body.branding?.productName ?? body.name } : {}),
        ...(body.organizationName !== undefined ? { organizationName: body.organizationName } : {}),
        ...body.branding,
      };
    }
    if (body.theme) {
      const currentTheme = ctx.tenants.getConfig(tenantId).theme;
      patch.theme = buildTenantTheme({
        ...(body.theme.scheme ? { scheme: body.theme.scheme } : {}),
        ...(body.theme.colors ? { colors: body.theme.colors } : {}),
        current: currentTheme,
      });
    }
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'validation_failed', 'Nothing to update');
    try {
      ctx.tenants.patchConfig(tenantId, patch);
    } catch (error) {
      if ((error as { name?: string }).name === 'ConfigValidationError') {
        throw new HttpError(400, 'validation_failed', 'Invalid tenant configuration', (error as { issues?: unknown }).issues);
      }
      throw error;
    }
    audit(ctx, {
      type: 'admin.action',
      severity: 'info',
      tenantId,
      ip: ctx.ip,
      message: 'Tenant settings updated',
      details: { kind: 'tenant.updated', fields: Object.keys(patch) },
    });
    ctx.send(200, tenantSummary(ctx, tenantId));
  })();
}

function tenantKeyRotateHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    requirePlatformKey(ctx);
    ctx.cluster.assertLeader('tenant key rotation');
    const tenantId = platformTenantId(ctx);
    if (!tenantIdsFor(ctx).includes(tenantId)) throw new HttpError(404, 'not_found', 'Tenant not found');
    const issued = apiKeyStore(ctx.env).issue(tenantId);
    audit(ctx, {
      type: 'admin.action',
      severity: 'warn',
      tenantId,
      ip: ctx.ip,
      message: 'Tenant API key rotated',
      details: { kind: 'tenant.key.rotated' },
    });
    const response: TenantKeyResponse = { tenantId, apiKey: issued.apiKey };
    ctx.send(200, response);
  })();
}

function tenantDeleteHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    requirePlatformKey(ctx);
    ctx.cluster.assertLeader('tenant deletion');
    const tenantId = platformTenantId(ctx);
    if (tenantId === ctx.env.defaultTenantId || tenantId === 'demo') {
      throw new HttpError(400, 'validation_failed', 'The demo tenant cannot be deleted');
    }
    if (Object.values(ctx.env.apiKeys).includes(tenantId)) {
      throw new HttpError(400, 'validation_failed', 'Tenants configured via AGIL_API_KEYS cannot be deleted');
    }
    if (!tenantIdsFor(ctx).includes(tenantId)) throw new HttpError(404, 'not_found', 'Tenant not found');
    const removedConfig = ctx.tenants.remove(tenantId);
    for (const room of ctx.rooms.list(tenantId)) ctx.rooms.close(room.id, 'tenant_deleted');
    apiKeyStore(ctx.env).removeTenant(tenantId);
    audit(ctx, {
      type: 'admin.action',
      severity: 'warn',
      tenantId,
      ip: ctx.ip,
      message: `Tenant deleted: ${tenantId}`,
      details: { kind: 'tenant.deleted', configRemoved: removedConfig },
    });
    ctx.send(200, { deleted: true, tenantId });
  })();
}

/* ------------------------------------------------------------------ */
/* Custom domain (white-label, Caddy/TLS handled externally)           */
/* ------------------------------------------------------------------ */

const domainRequestSchema = z.object({ domain: z.string().max(253) });

/** Normalises and validates a custom domain (no scheme/path/port/IP/wildcards). */
function normalizeCustomDomain(raw: string): string {
  const parsed = parseDomain(raw);
  if (!parsed.ok) throw new HttpError(400, 'validation_failed', parsed.reason);
  return parsed.domain;
}

function publicHost(ctx: RequestContext): string {
  // The registry normalises AGIL_DOMAIN_TARGET once (port/scheme/trailing dot,
  // invalid -> documented default); reuse that value so the advertised CNAME,
  // the verification expected-target and the docs hint can never disagree.
  return ctx.domains.publicHost;
}

function domainResponse(ctx: RequestContext, tenantId: string): DomainConfigResponse {
  const config = ctx.tenants.getConfig(tenantId);
  const parsed = parseDomain(config.branding.customDomain ?? '');
  const domain = parsed.ok ? parsed.domain : '';
  let record = domain ? ctx.domains.getForTenant(tenantId) : null;
  if (domain && (!record || record.domain !== domain)) {
    try {
      record = ctx.domains.ensureForTenant(tenantId, domain);
    } catch {
      // A stale/foreign value written directly through the config API must not
      // turn the admin GET/PUT response into a 500. A conflicting value cannot
      // take the domain over, so keep reporting the registry record that still
      // routes traffic instead of pretending this tenant has no domain.
      record = ctx.domains.getForTenant(tenantId);
    }
  }
  const host = publicHost(ctx);
  const status = record ? record.status : 'none';
  return {
    domain: record?.domain ?? '',
    status,
    verified: status === 'verified',
    ...(record
      ? {
          verification: ctx.domains.instructions(record),
        }
      : {}),
    dnsInstructions: {
      type: 'CNAME',
      name: record?.domain ?? '',
      value: host,
      ttl: 300,
    },
    docsHint:
      '1) Добавьте TXT-запись verification.txt («agil-verify=<token>») — она обязательна для первой ' +
      'верификации (доказывает владение доменом). 2) Добавьте CNAME на ' +
      host +
      ' для маршрутизации. 3) Дождитесь распространения DNS (TTL 300). ' +
      '4) Вызовите POST /v1/admin/domain/verify. ' +
      '5) Включите домен в reverse-proxy; TLS/ACME выпускает прокси. ' +
      'CNAME без TXT принимается только при повторной проверке уже verified-домена. ' +
      'Подробно: docs/custom-domains.md.',
  };
}

function domainGetHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  ctx.send(200, domainResponse(ctx, tenantId));
}

function domainPutHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const body = await ctx.jsonSchema(domainRequestSchema);
    const domain = normalizeCustomDomain(body.domain);
    if (domain) {
      try {
        ctx.domains.assertAvailable(tenantId, domain);
      } catch (error) {
        if (error instanceof DomainConflictError) {
          throw new HttpError(409, 'domain_conflict', 'Domain is already assigned to another tenant');
        }
        throw error;
      }
    }
    try {
      ctx.tenants.patchConfig(tenantId, { branding: { customDomain: domain } });
    } catch (error) {
      if ((error as { name?: string }).name === 'ConfigValidationError') {
        throw new HttpError(400, 'validation_failed', 'Invalid custom domain', (error as { issues?: unknown }).issues);
      }
      throw error;
    }
    // The tenant store emits synchronously and the global listener already
    // syncs the registry; ensure() keeps this path correct if it was not wired.
    if (domain) ctx.domains.ensureForTenant(tenantId, domain);
    else ctx.domains.remove(tenantId);
    const record = ctx.domains.getForTenant(tenantId);
    audit(ctx, {
      type: 'domain.updated',
      severity: 'info',
      tenantId,
      ip: ctx.ip,
      message: domain ? `Custom domain set: ${domain} (pending DNS verification)` : 'Custom domain removed',
      details: { domain, status: record?.status ?? 'none', verified: record?.status === 'verified' },
    });
    ctx.send(200, domainResponse(ctx, tenantId));
  })();
}

/**
 * `POST /v1/admin/domain/verify` — runs the DNS challenge (TXT token or CNAME
 * to AGIL_DOMAIN_TARGET). A failed check keeps the domain pending and returns
 * the last error; no token/secret beyond the public TXT value is exposed.
 */
function domainVerifyHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    let record = ctx.domains.getForTenant(tenantId);
    if (!record) {
      const configured = ctx.tenants.getConfig(tenantId).branding.customDomain;
      if (configured) {
        // Validate before ensureForTenant(): the generic config API only caps the
        // length, so a hand-written value like `https://meet.example.com` may sit
        // in branding.customDomain. That must be a 400, never a 500.
        const parsed = parseDomain(configured);
        if (!parsed.ok) throw new HttpError(400, 'validation_failed', parsed.reason);
        if (!parsed.domain) throw new HttpError(400, 'validation_failed', 'Set a custom domain before verifying it');
        try {
          record = ctx.domains.ensureForTenant(tenantId, parsed.domain);
        } catch (error) {
          // A conflicting `branding.customDomain` written through the generic
          // config API is a conflict, not "no domain configured".
          if (error instanceof DomainConflictError) {
            throw new HttpError(409, 'domain_conflict', 'Domain is already assigned to another tenant');
          }
          throw error;
        }
      }
    }
    if (!record) throw new HttpError(400, 'validation_failed', 'Set a custom domain before verifying it');
    let result: DomainVerification;
    try {
      result = await ctx.domains.verify(tenantId);
    } catch (error) {
      if ((error as Error).message === 'no_domain') {
        throw new HttpError(400, 'validation_failed', 'Set a custom domain before verifying it');
      }
      throw error;
    }
    audit(ctx, {
      type: result.verified ? 'domain.verified' : 'domain.verify_failed',
      severity: result.verified ? 'info' : 'warn',
      tenantId,
      ip: ctx.ip,
      message: result.verified ? `Custom domain verified: ${record.domain}` : `Custom domain verification failed: ${record.domain}`,
      details: {
        domain: record.domain,
        method: result.verified ? result.record.method : null,
        txtName: result.txtName,
        txtFound: result.txtValues.length > 0,
        cnameTarget: result.cnameTarget,
        expectedCname: result.expectedCname,
      },
    });
    ctx.send(200, domainResponse(ctx, tenantId));
  })();
}

function domainDeleteHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  ctx.domains.remove(tenantId);
  ctx.tenants.patchConfig(tenantId, { branding: { customDomain: '' } });
  audit(ctx, {
    type: 'domain.updated',
    severity: 'info',
    tenantId,
    ip: ctx.ip,
    message: 'Custom domain removed',
    details: { domain: '', status: 'none', verified: false },
  });
  ctx.send(200, domainResponse(ctx, tenantId));
}

function mediaProcessingGetHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  ctx.send(200, mediaProcessingStatus(ctx.tenants.getConfig(tenantId), ctx.env));
}

/**
 * `GET /v1/admin/egress/status` — controller status for the caller's tenant.
 *
 * Requires the tenant admin credential and passes the tenant through so
 * `lastError`/`activeCount` are scoped: the egress client is shared by every
 * tenant, and a global `lastError` would disclose one tenant's failure text —
 * including an RTMP stream key — to another.
 */
function egressStatusHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    ctx.send(200, await ctx.services.egress.status(tenantId));
  })();
}

/**
 * `GET /v1/admin/egress/workers` — controller status + optional worker health.
 *
 * Worker *registration* happens over the LiveKit Redis/psrpc bus, not HTTP;
 * this endpoint probes the worker's health port for reachability and reports
 * the app's own dispatch configuration. Never returns URLs/secrets; `lastError`
 * and `activeCount` are tenant-scoped like `/v1/admin/egress/status`.
 */
function egressWorkersHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const base = await ctx.services.egress.status(tenantId);
    let worker: {
      urlConfigured: boolean;
      reachable: boolean | null;
      status: string | null;
      cpuLoad: number | null;
      detail?: string;
    } = { urlConfigured: Boolean(ctx.env.egressHealthUrl), reachable: null, status: null, cpuLoad: null };
    if (ctx.env.egressHealthUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(ctx.env.egressHealthUrl, {
          method: 'GET',
          signal: controller.signal,
          redirect: 'error',
          headers: { accept: 'application/json' },
        });
        const text = await response.text();
        let parsed: Record<string, unknown> = {};
        try {
          const value: unknown = JSON.parse(text);
          if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
        } catch {
          /* egress health may be plain text; reachability is still useful */
        }
        const status = typeof parsed.status === 'string' ? parsed.status : response.ok ? 'ok' : null;
        const rawLoad = parsed.CpuLoad ?? parsed.cpu_load ?? parsed.cpuLoad;
        const cpuLoad = typeof rawLoad === 'number' && Number.isFinite(rawLoad) ? rawLoad : null;
        worker = {
          urlConfigured: true,
          reachable: response.ok,
          status,
          cpuLoad,
          ...(response.ok ? {} : { detail: `HTTP ${response.status}` }),
        };
      } catch (error) {
        worker = {
          urlConfigured: true,
          reachable: false,
          status: null,
          cpuLoad: null,
          detail: (error as Error).name === 'AbortError' ? 'health check timed out' : 'worker is unreachable',
        };
      } finally {
        clearTimeout(timer);
      }
    }
    const playback = ctx.services.egressPlayback;
    ctx.send(200, {
      ...base,
      worker,
      playback: {
        enabled: ctx.env.egressPlaybackEnabled,
        backend: !playback.configured ? 'none' : playback.localOnly ? 'local' : 's3',
      },
      checkedAt: Date.now(),
    });
  })();
}

/**
 * `POST /v1/admin/egress/cleanup` — retry/stuck-session cleanup.
 *
 * Lists active jobs older than the threshold, scoped to this tenant's room-name
 * prefix, and (only with `apply: true`) stops them. Default is a dry run so an
 * operator can inspect the blast radius first. S3 upload retries are handled by
 * egress itself (`storage.s3.max_retries`); this endpoint only handles jobs
 * that never finish.
 */
function egressCleanupHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const body = await ctx.jsonSchema(egressCleanupSchema);
    const apply = body.apply === true;
    const thresholdSec = body.thresholdSec ?? ctx.env.egressStuckAfterSec;
    const result = await ctx.services.egress.cleanupStuck({
      roomNamePrefix: `${tenantId}__`,
      thresholdSec,
      apply,
      tenantId,
    });
    if (apply) {
      audit(ctx, {
        type: 'admin.action',
        severity: result.errors.length > 0 ? 'warn' : 'info',
        tenantId,
        ip: ctx.ip,
        message: `Egress stuck-session cleanup: ${result.stopped.length} stopped`,
        details: {
          kind: 'egress.cleanup',
          thresholdSec,
          scanned: result.scanned,
          stuck: result.stuck.length,
          stopped: result.stopped.length,
          errors: result.errors.length,
        },
      });
    }
    ctx.send(200, result);
  })();
}

function siemStatusHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  ctx.send(200, ctx.services.siem.status(tenantId));
}

function siemTestHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const result = await ctx.services.siem.test(tenantId);
    if (!result) {
      throw new HttpError(501, 'siem_not_configured', 'SIEM не настроен: включите integrations.siem и укажите url');
    }
    audit(ctx, {
      type: 'admin.action',
      severity: result.ok ? 'info' : 'warn',
      tenantId,
      ip: ctx.ip,
      message: `SIEM test ${result.ok ? 'ok' : 'failed'}`,
      details: { kind: 'siem.test', ok: result.ok, latencyMs: result.latencyMs, ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}) },
    });
    ctx.send(200, result);
  })();
}

function scaleGetHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  ctx.send(200, scaleStatus(ctx.env, ctx.tenants.getConfig(tenantId),
    (nodeId) => ctx.cluster.turnNodeState(tenantId, nodeId), (nodeId) => ctx.cluster.getNode(tenantId, nodeId)));
}

function scalePutHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const body = await ctx.jsonSchema(scalePutSchema);
    const current = ctx.tenants.getConfig(tenantId);
    const parsed = scaleConfigSchema.safeParse(mergeScale(current.scale, body.scale));
    if (!parsed.success) {
      throw new HttpError(400, 'validation_failed', 'Invalid scale configuration', parsed.error.issues);
    }
    validateScale(ctx.env, parsed.data);
    let entry;
    try {
      entry = ctx.tenants.patchConfig(tenantId, { scale: parsed.data });
    } catch (error) {
      if ((error as { name?: string }).name === 'ConfigValidationError') {
        throw new HttpError(400, 'validation_failed', 'Invalid scale configuration', (error as { issues?: unknown }).issues);
      }
      throw error;
    }
    audit(ctx, {
      type: 'admin.action',
      severity: 'warn',
      tenantId,
      ip: ctx.ip,
      message: `Scale configuration updated (mediaMode=${entry.config.scale.mediaMode})`,
      details: {
        kind: 'scale.updated',
        mediaMode: entry.config.scale.mediaMode,
        maxParticipants: entry.config.scale.maxParticipants,
        turnServers: entry.config.scale.turn.length,
        nodes: entry.config.scale.signaling.nodes.length,
        sfuUrl: entry.config.scale.sfu.url,
        webinar: entry.config.scale.webinar.enabled,
        streaming: entry.config.scale.streaming.enabled,
      },
    });
    ctx.send(200, scaleStatus(ctx.env, entry.config,
      (nodeId) => ctx.cluster.turnNodeState(tenantId, nodeId), (nodeId) => ctx.cluster.getNode(tenantId, nodeId)));
  })();
}

function clusterStatusHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    // Refreshes the lease view from Redis (standby) / renews it (leader) so the
    // panel shows the real leader, TTL and failover state.
    const registry = await ctx.cluster.statusSnapshot(tenantId);
    ctx.send(200, clusterStatus(ctx.env, ctx.tenants.getConfig(tenantId), registry));
  })();
}

/* ------------------------------------------------------------------ */
/* Cluster enrollment tokens + node registry (docs/api/cluster.md)     */
/* ------------------------------------------------------------------ */

/** Admin credential label stored on a token (`createdBy`); never a secret. */
function credentialLabel(ctx: RequestContext, tenantId: string): string {
  const credential = adminCredential(ctx.env, ctx.headers);
  if (credential?.via === 'admin-session') {
    return `admin-session:${credential.session.sub || tenantId}`.slice(0, 160);
  }
  return `api-key:${tenantId}`.slice(0, 160);
}

function clusterTokenCreateHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const body = await ctx.jsonSchema(enrollmentTokenCreateRequestSchema);
    const created = ctx.cluster.createToken({
      ...body,
      tenantId,
      createdBy: credentialLabel(ctx, tenantId),
    });
    audit(ctx, {
      type: 'admin.action',
      severity: 'warn',
      tenantId,
      ip: ctx.ip,
      message: `Enrollment token issued (${created.enrollment.kind}/${created.enrollment.role})`,
      details: {
        kind: 'cluster.token.created',
        tokenId: created.enrollment.id,
        tokenKind: created.enrollment.kind,
        role: created.enrollment.role,
        features: created.enrollment.features,
        uses: created.enrollment.uses,
        expiresAt: created.enrollment.expiresAt,
      },
    });
    // The plaintext token is returned here and only here.
    ctx.send(201, created);
  })();
}

function clusterTokensHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  ctx.send(200, { tokens: ctx.cluster.listTokens(tenantId) });
}

function clusterTokenRevokeHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const tokenId = ctx.params.tokenId as string;
    const enrollment = ctx.cluster.revokeToken(tenantId, tokenId);
    if (!enrollment) throw new HttpError(404, 'not_found', 'Enrollment token not found');
    audit(ctx, {
      type: 'admin.action',
      severity: 'warn',
      tenantId,
      ip: ctx.ip,
      message: `Enrollment token revoked (${enrollment.kind}/${enrollment.role})`,
      details: { kind: 'cluster.token.revoked', tokenId: enrollment.id, tokenKind: enrollment.kind, role: enrollment.role },
    });
    ctx.send(200, { revoked: true, id: enrollment.id, enrollment });
  })();
}

function nodesListHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const role = (ctx.query.get('role') ?? '').trim();
  const status = (ctx.query.get('status') ?? '').trim();
  let nodes = ctx.cluster.listNodes(tenantId);
  if (role) nodes = nodes.filter((node) => node.role === role);
  if (status) nodes = nodes.filter((node) => node.status === status);
  const total = nodes.length;
  const rawLimit = Number(ctx.query.get('limit') ?? '');
  const rawOffset = Number(ctx.query.get('offset') ?? '');
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, Math.trunc(rawLimit)) : null;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : 0;
  if (offset > 0) nodes = nodes.slice(offset);
  if (limit !== null) nodes = nodes.slice(0, limit);
  // `limit`/`offset` are optional: without them the response is the full list
  // (dashboard and CLI compatibility), with them the panel can page >500 rows.
  ctx.send(200, limit !== null || offset > 0 ? { nodes, total, limit, offset } : { nodes });
}

function nodeUpdateHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const nodeId = ctx.params.nodeId as string;
    const body = await ctx.jsonSchema(nodeUpdateRequestSchema);
    const previous = body.features === undefined && body.moduleEnabled === undefined ? null : ctx.cluster.getNode(tenantId, nodeId);
    const node = ctx.cluster.updateNode(tenantId, nodeId, body);
    audit(ctx, {
      type: 'admin.action',
      severity: 'warn',
      tenantId,
      ip: ctx.ip,
      message: `Node updated: ${node.id}`,
      details: {
        kind: 'cluster.node.updated', nodeId: node.id, fields: Object.keys(body).sort(),
        ...(body.features !== undefined && previous ? { featuresBefore: previous.features, featuresAfter: node.features } : {}),
        ...(body.moduleEnabled !== undefined ? { disabledModulesBefore: previous?.disabledModules ?? [], disabledModulesAfter: node.disabledModules ?? [] } : {}),
      },
    });
    ctx.send(200, { node });
  })();
}

function nodeDisableHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const nodeId = ctx.params.nodeId as string;
    const body = await ctx.jsonSchema(nodeDisableRequestSchema);
    const disabled = body.disabled ?? true;
    const node = ctx.cluster.setDisabled(tenantId, nodeId, disabled);
    audit(ctx, {
      type: 'admin.action',
      severity: 'warn',
      tenantId,
      ip: ctx.ip,
      message: `Node ${disabled ? 'disabled' : 'enabled'}: ${node.id}`,
      details: { kind: 'cluster.node.disabled', nodeId: node.id, disabled },
    });
    ctx.send(200, { node });
  })();
}

function nodeDrainHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const nodeId = ctx.params.nodeId as string;
    const body = await ctx.jsonSchema(nodeDrainRequestSchema);
    const drain = body.drain ?? true;
    const node = ctx.cluster.setDrain(tenantId, nodeId, drain);
    audit(ctx, {
      type: 'admin.action',
      severity: 'warn',
      tenantId,
      ip: ctx.ip,
      message: `Node ${drain ? 'draining' : 'returned to service'}: ${node.id}`,
      details: { kind: 'cluster.node.drain', nodeId: node.id, drain },
    });
    ctx.send(200, { node });
  })();
}

function nodeDeleteHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const nodeId = ctx.params.nodeId as string;
  if (!ctx.cluster.deleteNode(tenantId, nodeId)) throw new HttpError(404, 'not_found', 'Node not found');
  audit(ctx, {
    type: 'admin.action',
    severity: 'warn',
    tenantId,
    ip: ctx.ip,
    message: `Node removed from the registry: ${nodeId}`,
    details: { kind: 'cluster.node.deleted', nodeId },
  });
  ctx.send(200, { deleted: true, id: nodeId });
}

function nodeRotateKeyHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const nodeId = ctx.params.nodeId as string;
    const body = await ctx.jsonSchema(nodeRotateKeyRequestSchema);
    const rotated = ctx.cluster.rotateNodeKey(tenantId, nodeId, body.keyTtlSec);
    audit(ctx, {
      type: 'admin.action',
      severity: 'warn',
      tenantId,
      ip: ctx.ip,
      message: `Node key rotated: ${nodeId}`,
      details: {
        kind: 'cluster.node.key-rotated',
        nodeId,
        keyExpiresAt: rotated.keyExpiresAt,
      },
    });
    // The plaintext node key is returned here and only here.
    ctx.send(200, {
      ...rotated,
      heartbeatIntervalSec: NODE_HEARTBEAT_INTERVAL_SEC,
    });
  })();
}

/* ------------------------------------------------------------------ */
/* Per-node modules (Docker add-on packages)                           */
/* ------------------------------------------------------------------ */

/**
 * The allowlist the dashboard renders. Tenant admin credential only (the
 * platform key is rejected like every other tenant-scoped admin endpoint). The
 * response contains image references and env **names/hints**, never values.
 */
function nodeModuleCatalogHandler(ctx: RequestContext): void {
  adminTenant(ctx);
  ctx.send(200, { catalog: nodeModuleCatalog(), actions: [...NODE_MODULE_CATALOG_ACTIONS] });
}

/** Expanded node card: last reported inventory + not-yet-delivered commands. */
function nodeModulesHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const nodeId = ctx.params.nodeId as string;
  ctx.res.setHeader('Cache-Control', 'no-store');
  ctx.send(200, ctx.cluster.listNodeModules(tenantId, nodeId));
}

/**
 * Queues one allowlisted action (`start|stop|restart|install|remove`) for one
 * module of one node. The node agent executes it on its next heartbeat. The
 * Install images come from the Core preset catalog or the fresh node template.
 * A custom install caller confirms the expected digest from the node.
 */
function nodeModuleActionHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const nodeId = ctx.params.nodeId as string;
    const moduleId = ctx.params.moduleId as string;
    const body = await ctx.jsonSchema(nodeModuleActionRequestSchema);
    const command = ctx.cluster.queueModuleCommand({ tenantId, nodeId, moduleId, ...body });
    audit(ctx, {
      type: 'admin.action',
      severity: 'warn',
      tenantId,
      ip: ctx.ip,
      message: `Node module ${command.action} queued: ${nodeId}/${command.moduleId}`,
      details: {
        kind: 'cluster.node.module.command',
        nodeId,
        moduleId: command.moduleId,
        action: command.action,
        commandId: command.id,
        // Preset or node-reported image, present only for install.
        image: command.image,
        targetContainerId: command.targetContainerId,
        expiresAt: command.expiresAt,
      },
    });
    ctx.send(201, { command });
  })();
}

function turnTestHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const body = await ctx.jsonSchema(turnTestSchema);
    const result = await testTurnServer(ctx.env, ctx.tenants.getConfig(tenantId), body.id);
    audit(ctx, {
      type: 'admin.action',
      severity: result.ok ? 'info' : 'warn',
      tenantId,
      ip: ctx.ip,
      message: `TURN configuration test ${result.ok ? 'ok' : 'failed'}: ${body.id}`,
      details: { kind: 'scale.turn.test', turnId: body.id, ok: result.ok, latencyMs: result.latencyMs },
    });
    ctx.send(200, result);
  })();
}

/* ------------------------------------------------------------------ */
/* Room-level helpers (locations, messages)                            */
/* ------------------------------------------------------------------ */

function roomLocationsHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const room = requireRoom(ctx, tenantId);
  const locations = room.participants().map((participant) => {
    const fix = room.gpsLocation(participant.id);
    return {
      participantId: participant.id,
      name: participant.name,
      location: participant.location ?? { source: 'none' as const },
      ...(fix ? { gps: { lat: fix.lat, lon: fix.lon, ...(fix.accuracyM !== undefined ? { accuracyM: fix.accuracyM } : {}), ts: fix.ts } } : {}),
    };
  });
  ctx.send(200, { roomId: room.id, locations });
}

/* ------------------------------------------------------------------ */
/* Billing / quota metering (P2 baseline; no payments, no card data)   */
/* ------------------------------------------------------------------ */

function billingUsagePayload(ctx: RequestContext, tenantId: string, month?: string): BillingUsageResponse {
  const billing = ctx.tenants.getConfig(tenantId).billing;
  const snapshot = ctx.services.billing.snapshot(tenantId, month);
  const counts = tenantUsageCounts(ctx.rooms, tenantId);
  const currentMonth = ctx.services.billing.currentMonth();
  // Live room/participant counts come from the room registry (includes rooms
  // that were created but not joined yet); minute sessions come from metering.
  const live =
    snapshot.usage.month === currentMonth
      ? {
          ...snapshot.live,
          activeRooms: counts.activeRooms,
          activeParticipants: counts.activeParticipants,
        }
      : snapshot.live;
  const totalMinutes = live.totalMinutes;
  return {
    tenantId,
    month: snapshot.usage.month,
    billing,
    usage: snapshot.usage,
    live,
    quota: {
      includedMinutes: billing.includedMinutes,
      maxParticipants: billing.maxParticipants,
      maxRooms: billing.maxRooms,
      overagePolicy: billing.overagePolicy,
      minutesRemaining: Math.max(0, Math.round((billing.includedMinutes - totalMinutes) * 1000) / 1000),
      overageMinutes: Math.max(0, Math.round((totalMinutes - billing.includedMinutes) * 1000) / 1000),
    },
    months: ctx.services.billing.listMonths(tenantId),
    warnings:
      snapshot.usage.month === currentMonth
        ? currentQuotaWarnings({
            billing,
            usage: snapshot.usage,
            liveMinutes: live.liveMinutes,
            activeRooms: counts.activeRooms,
            activeParticipants: counts.activeParticipants,
          })
        : [],
  };
}

function billingPlanPayload(ctx: RequestContext, tenantId: string): BillingPlanResponse {
  const billing = ctx.tenants.getConfig(tenantId).billing;
  const snapshot = ctx.services.billing.snapshot(tenantId);
  const counts = tenantUsageCounts(ctx.rooms, tenantId);
  return {
    tenantId,
    billing,
    plans: BILLING_PLANS,
    usage: {
      month: snapshot.usage.month,
      minutes: snapshot.usage.minutes,
      totalMinutes: snapshot.live.totalMinutes,
      roomsCreated: snapshot.usage.roomsCreated,
      participantJoins: snapshot.usage.participantJoins,
      peakParticipants: snapshot.usage.peakParticipants,
      recordings: snapshot.usage.recordings,
      activeRooms: counts.activeRooms,
      activeParticipants: counts.activeParticipants,
    },
  };
}

function billingUsageHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const rawMonth = ctx.query.get('month');
  const month = rawMonth === null || rawMonth === '' ? undefined : rawMonth;
  if (month !== undefined && !BILLING_MONTH_RE.test(month)) {
    throw new HttpError(400, 'validation_failed', 'month must be YYYY-MM (UTC)');
  }
  ctx.send(200, billingUsagePayload(ctx, tenantId, month));
}

function billingPlanGetHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  ctx.send(200, billingPlanPayload(ctx, tenantId));
}

function billingPlanPatchHandler(ctx: RequestContext): Promise<void> {
  return (async () => {
    const tenantId = adminTenant(ctx);
    const body = await ctx.jsonSchema(billingPlanPatchSchema);
    if (Object.keys(body).length === 0) {
      throw new HttpError(400, 'validation_failed', 'Billing plan patch must contain at least one field');
    }
    const current = ctx.tenants.getConfig(tenantId).billing;
    const next = applyBillingPlanPatch(current, body);
    try {
      ctx.tenants.patchConfig(tenantId, { billing: next });
    } catch (error) {
      if ((error as { name?: string }).name === 'ConfigValidationError') {
        throw new HttpError(
          400,
          'validation_failed',
          'Invalid billing plan',
          (error as { issues?: unknown }).issues,
        );
      }
      throw error;
    }
    audit(ctx, {
      type: 'admin.action',
      severity: 'warn',
      tenantId,
      ip: ctx.ip,
      message: `Billing plan updated: ${current.plan} -> ${next.plan} (${next.enabled ? 'enforcement on' : 'off'})`,
      details: {
        kind: 'billing.updated',
        plan: next.plan,
        previousPlan: current.plan,
        enabled: next.enabled,
        includedMinutes: next.includedMinutes,
        maxParticipants: next.maxParticipants,
        maxRooms: next.maxRooms,
        overagePolicy: next.overagePolicy,
      },
    });
    ctx.send(200, billingPlanPayload(ctx, tenantId));
  })();
}

/* ------------------------------------------------------------------ */
/* Routing baseline (docs/routing.md)                                  */
/* ------------------------------------------------------------------ */

function routesListHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  ctx.send(200, { routes: ctx.routing.listRoutes(tenantId) });
}

function routeGetHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const route = ctx.routing.getRoute(tenantId, ctx.params.routeId as string);
  if (!route) throw new HttpError(404, 'not_found', 'Route not found');
  ctx.send(200, { route });
}

async function routeCreateHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const body = await ctx.jsonSchema(routingRuleCreateSchema);
  ctx.send(200, { route: ctx.routing.createRoute(tenantId, body, { ip: ctx.ip }) });
}

async function routePatchHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const body = await ctx.jsonSchema(routingRulePatchSchema);
  const route = ctx.routing.patchRoute(tenantId, ctx.params.routeId as string, body, { ip: ctx.ip });
  ctx.send(200, { route });
}

function routeDeleteHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const routeId = ctx.params.routeId as string;
  ctx.routing.deleteRoute(tenantId, routeId, { ip: ctx.ip });
  ctx.send(200, { deleted: true, id: routeId });
}

async function routeTestHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const body = await ctx.jsonSchema(routingTestRequestSchema);
  const result = await ctx.routing.testRoute(tenantId, ctx.params.routeId as string, body, { ip: ctx.ip });
  ctx.send(200, result);
}

function edgeTokensListHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  ctx.send(200, { tokens: ctx.routing.listEdgeTokens(tenantId) });
}

async function edgeTokenCreateHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const body = await ctx.jsonSchema(edgeEnrollmentCreateRequestSchema);
  ctx.send(200, ctx.routing.issueEdgeToken(tenantId, body, { ip: ctx.ip, createdBy: 'admin-api' }));
}

function edgeTokenRevokeHandler(ctx: RequestContext): void {
  const tenantId = adminTenant(ctx);
  const token = ctx.routing.revokeEdgeToken(tenantId, ctx.params.tokenId as string, { ip: ctx.ip });
  if (!token) throw new HttpError(404, 'not_found', 'Edge enrollment token not found');
  ctx.send(200, { revoked: true, token });
}

/* ------------------------------------------------------------------ */
/* Generic media flows (docs/flows.md)                                 */
/* ------------------------------------------------------------------ */

async function flowsListHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  ctx.send(200, { flows: await ctx.flows.listFlows(tenantId) });
}

async function flowGetHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const flow = await ctx.flows.getFlow(tenantId, ctx.params.flowId as string);
  if (!flow) throw new HttpError(404, 'not_found', 'Flow not found');
  ctx.send(200, { flow });
}

async function flowCreateHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const body = await ctx.jsonSchema(flowCreateSchema);
  ctx.send(200, { flow: await ctx.flows.createFlow(tenantId, body, { ip: ctx.ip }) });
}

async function flowPatchHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const body = await ctx.jsonSchema(flowPatchSchema);
  const flow = await ctx.flows.patchFlow(tenantId, ctx.params.flowId as string, body, { ip: ctx.ip });
  ctx.send(200, { flow });
}

async function flowDeleteHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const flowId = ctx.params.flowId as string;
  await ctx.flows.deleteFlow(tenantId, flowId, { ip: ctx.ip });
  ctx.send(200, { deleted: true, id: flowId });
}

async function flowTestHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const body = await ctx.jsonSchema(flowTestRequestSchema);
  const result = await ctx.flows.testFlow(tenantId, ctx.params.flowId as string, body, { ip: ctx.ip });
  ctx.send(200, result);
}

async function flowStatusHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  ctx.send(200, { status: await ctx.flows.getStatus(tenantId, ctx.params.flowId as string) });
}

async function flowRtmpIngressCreateHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  const credentials = await ctx.flows.createRtmpIngress(tenantId, ctx.params.flowId as string);
  ctx.res.setHeader('Cache-Control', 'no-store');
  ctx.send(201, credentials);
}

async function flowRtmpIngressStatusHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  ctx.res.setHeader('Cache-Control', 'no-store');
  ctx.send(200, await ctx.flows.getRtmpIngress(tenantId, ctx.params.flowId as string));
}

async function flowRtmpIngressDeleteHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  await ctx.flows.stopRtmpIngress(tenantId, ctx.params.flowId as string);
  ctx.send(200, { revoked: true });
}

async function flowPullIngressCreateHandler(ctx: RequestContext, transport: 'srt' | 'hls'): Promise<void> {
  const tenantId = adminTenant(ctx);
  ctx.res.setHeader('Cache-Control', 'no-store');
  ctx.send(201, await ctx.flows.createPullIngress(tenantId, ctx.params.flowId as string, transport));
}

async function flowPullIngressStatusHandler(ctx: RequestContext, transport: 'srt' | 'hls'): Promise<void> {
  const tenantId = adminTenant(ctx);
  ctx.res.setHeader('Cache-Control', 'no-store');
  ctx.send(200, await ctx.flows.getPullIngress(tenantId, ctx.params.flowId as string, transport));
}

async function flowPullIngressDeleteHandler(ctx: RequestContext, transport: 'srt' | 'hls'): Promise<void> {
  const tenantId = adminTenant(ctx);
  await ctx.flows.stopPullIngress(tenantId, ctx.params.flowId as string, transport);
  ctx.send(200, { revoked: true });
}

async function flowTickHandler(ctx: RequestContext): Promise<void> {
  const tenantId = adminTenant(ctx);
  ctx.send(200, await ctx.flows.tickTenant(tenantId));
}

/** Registers every admin route. */
export function registerAdminRoutes(router: Router): void {  router.get('/v1/admin/overview', overviewHandler);
  router.get('/v1/admin/rooms', listRoomsHandler);
  router.post('/v1/admin/rooms', createRoomHandler);
  router.get('/v1/admin/rooms/:roomId', roomDetailHandler);
  router.delete('/v1/admin/rooms/:roomId', deleteRoomHandler);
  router.post('/v1/admin/rooms/:roomId/password', setRoomPasswordHandler);
  router.get('/v1/admin/tenants', tenantsListHandler);
  router.post('/v1/admin/tenants', tenantCreateHandler);
  router.get('/v1/admin/tenants/:tenantId', tenantReadHandler);
  router.patch('/v1/admin/tenants/:tenantId', tenantPatchHandler);
  router.delete('/v1/admin/tenants/:tenantId', tenantDeleteHandler);
  router.post('/v1/admin/tenants/:tenantId/keys', tenantKeyRotateHandler);
  router.get('/v1/admin/domain', domainGetHandler);
  router.put('/v1/admin/domain', domainPutHandler);
  router.post('/v1/admin/domain', domainVerifyHandler);
  router.post('/v1/admin/domain/verify', domainVerifyHandler);
  router.delete('/v1/admin/domain', domainDeleteHandler);
  router.get('/v1/admin/docs', docsListHandler);
  router.post('/v1/admin/docs/upload', docUploadHandler);
  router.put('/v1/admin/docs/default', docDefaultHandler);
  router.get('/v1/admin/docs/:name/versions', docVersionsHandler);
  router.get('/v1/admin/docs/:name/versions/:versionId', docVersionHandler);
  router.post('/v1/admin/docs/:name/versions/:versionId/restore', docRestoreHandler);
  router.get('/v1/admin/docs/:name', docReadHandler);
  router.put('/v1/admin/docs/:name', docWriteHandler);
  router.delete('/v1/admin/docs/:name', docDeleteHandler);
  router.delete('/v1/admin/rooms/:roomId/password', removeRoomPasswordHandler);
  router.post('/v1/admin/rooms/:roomId/invites', async (ctx) => {
    const tenantId = adminTenant(ctx);
    const room = requireRoom(ctx, tenantId);
    const body = await ctx.jsonSchema(inviteSchema);
    if (room.allowedParticipantIds) {
      throw new HttpError(403, 'forbidden', 'Restricted rooms require participant-specific access tokens');
    }
    const role = body.role ?? 'guest';
    const issued = issueToken(ctx.env, {
      participantId: randomUUID(),
      name: role === 'guest' ? 'Гость' : 'Участник',
      role,
      tenantId,
      roomId: room.id,
      ttlSec: body.ttlSec,
    });
    audit(ctx, {
      type: 'admin.action',
      severity: 'info',
      tenantId,
      roomId: room.id,
      ip: ctx.ip,
      message: `Invite created (${role}, ${body.ttlSec ?? ctx.env.tokenTtlSec}s)`,
      details: { kind: 'invite', role, passwordProtected: room.passwordProtected },
    });
    const links = buildRoomLinks(ctx.env, { roomId: room.id, tenantId, token: issued.token }, requestOrigin(ctx, tenantId));
    const response: InviteLink = {
      roomId: room.id,
      joinUrl: links.joinUrl,
      embedUrl: links.embedUrl,
      token: issued.token,
      expiresAt: issued.expiresAt,
      passwordProtected: room.passwordProtected,
    };
    ctx.send(200, response);
  });
  router.post('/v1/admin/rooms/:roomId/lock', lockRoomHandler);
  router.post('/v1/admin/rooms/:roomId/kick', kickHandler);
  router.post('/v1/admin/rooms/:roomId/chat', adminPostChatHandler);
  router.get('/v1/admin/rooms/:roomId/transcript', transcriptHandler);
  router.delete('/v1/admin/rooms/:roomId/transcript', transcriptPurgeHandler);
  router.get('/v1/admin/stt', sttStatusHandler);
  router.get('/v1/admin/rooms/:roomId/notes', notesHandler);
  router.get('/v1/admin/rooms/:roomId/analysis', analysisHandler);
  router.post('/v1/admin/rooms/:roomId/analysis/run', analysisRunHandler);
  router.get('/v1/admin/rooms/:roomId/conversation-review', conversationReviewGet);
  router.put('/v1/admin/rooms/:roomId/conversation-review', conversationReviewPut);
  router.get('/v1/admin/rooms/:roomId/locations', roomLocationsHandler);
  router.get('/v1/admin/audit', auditHandler);
  router.get('/v1/admin/security', securityHandler);
  router.get('/v1/admin/recordings', recordingsHandler);
  router.delete('/v1/admin/recordings/:id', deleteRecordingHandler);
  router.get('/v1/admin/quarantine', quarantineListHandler);
  router.delete('/v1/admin/quarantine/:id', quarantinePurgeHandler);
  router.get('/v1/admin/files', filesHandler);
  router.get('/v1/admin/ai-agent', aiAgentGetHandler);
  router.put('/v1/admin/ai-agent', aiAgentPutHandler);
  router.get('/v1/admin/knowledge-agent', knowledgeAgentGetHandler);
  router.put('/v1/admin/knowledge-agent', knowledgeAgentPutHandler);
  router.get('/v1/admin/in-call-agent', inCallAgentGetHandler);
  router.put('/v1/admin/in-call-agent', inCallAgentPutHandler);
  router.post('/v1/admin/knowledge/ask', knowledgeAskHandler);
  router.get('/v1/admin/access-policy', accessPolicyGetHandler);
  router.put('/v1/admin/access-policy', accessPolicyPutHandler);
  router.get('/v1/admin/webhooks', webhooksGetHandler);
  router.put('/v1/admin/webhooks', webhooksPutHandler);
  router.post('/v1/admin/webhooks/test', webhooksTestHandler);
  router.get('/v1/admin/providers', providersGetHandler);
  router.put('/v1/admin/providers', providersPutHandler);
  router.post('/v1/admin/providers/test', providersTestHandler);
  router.get('/v1/admin/scale', scaleGetHandler);
  router.get('/v1/admin/egress/status', egressStatusHandler);
  router.get('/v1/admin/egress/workers', egressWorkersHandler);
  router.post('/v1/admin/egress/cleanup', egressCleanupHandler);
  router.get('/v1/admin/siem/status', siemStatusHandler);
  router.post('/v1/admin/siem/test', siemTestHandler);
  router.get('/v1/admin/media/processing', mediaProcessingGetHandler);
  router.put('/v1/admin/scale', scalePutHandler);
  router.get('/v1/admin/cluster/status', clusterStatusHandler);
  router.get('/v1/admin/cluster/tokens', clusterTokensHandler);
  router.post('/v1/admin/cluster/tokens', clusterTokenCreateHandler);
  router.delete('/v1/admin/cluster/tokens/:tokenId', clusterTokenRevokeHandler);
  router.get('/v1/admin/nodes', nodesListHandler);
  router.patch('/v1/admin/nodes/:nodeId', nodeUpdateHandler);
  router.delete('/v1/admin/nodes/:nodeId', nodeDeleteHandler);
  router.post('/v1/admin/nodes/:nodeId/disable', nodeDisableHandler);
  router.post('/v1/admin/nodes/:nodeId/drain', nodeDrainHandler);
  router.post('/v1/admin/nodes/:nodeId/rotate-key', nodeRotateKeyHandler);
  // Per-node modules (allowlisted Docker add-on packages). Fixed paths first:
  // `node-modules/catalog` must not be matched by a `:nodeId` pattern.
  router.get(nodeModulesPaths.catalog, nodeModuleCatalogHandler);
  router.get('/v1/admin/nodes/:nodeId/modules', nodeModulesHandler);
  router.post('/v1/admin/nodes/:nodeId/modules/:moduleId/actions', nodeModuleActionHandler);
  router.get('/v1/admin/billing/usage', billingUsageHandler);
  router.get('/v1/admin/billing/plan', billingPlanGetHandler);
  router.patch('/v1/admin/billing/plan', billingPlanPatchHandler);
  // Routing: `edge-tokens` must precede `:routeId` (same segment count).
  router.get('/v1/admin/routes', routesListHandler);
  router.post('/v1/admin/routes', routeCreateHandler);
  router.get('/v1/admin/routes/edge-tokens', edgeTokensListHandler);
  router.post('/v1/admin/routes/edge-tokens', edgeTokenCreateHandler);
  router.delete('/v1/admin/routes/edge-tokens/:tokenId', edgeTokenRevokeHandler);
  router.get('/v1/admin/routes/:routeId', routeGetHandler);
  router.patch('/v1/admin/routes/:routeId', routePatchHandler);
  router.delete('/v1/admin/routes/:routeId', routeDeleteHandler);
  router.post('/v1/admin/routes/:routeId/test', routeTestHandler);
  // Generic media flows: static segments (`tick`, `edge-tokens`) precede the
  // `:flowId` routes because they have the same segment count.
  router.get('/v1/admin/flows', flowsListHandler);
  router.post('/v1/admin/flows', flowCreateHandler);
  router.post('/v1/admin/flows/tick', flowTickHandler);
  router.get('/v1/admin/flows/edge-tokens', edgeTokensListHandler);
  router.post('/v1/admin/flows/edge-tokens', edgeTokenCreateHandler);
  router.delete('/v1/admin/flows/edge-tokens/:tokenId', edgeTokenRevokeHandler);
  router.get('/v1/admin/flows/:flowId', flowGetHandler);
  router.patch('/v1/admin/flows/:flowId', flowPatchHandler);
  router.delete('/v1/admin/flows/:flowId', flowDeleteHandler);
  router.post('/v1/admin/flows/:flowId/test', flowTestHandler);
  router.get('/v1/admin/flows/:flowId/status', flowStatusHandler);
  router.post('/v1/admin/flows/:flowId/rtmp-ingress', flowRtmpIngressCreateHandler);
  router.get('/v1/admin/flows/:flowId/rtmp-ingress', flowRtmpIngressStatusHandler);
  router.delete('/v1/admin/flows/:flowId/rtmp-ingress', flowRtmpIngressDeleteHandler);
  for (const transport of ['srt', 'hls'] as const) {
    const path = `/v1/admin/flows/:flowId/${transport}-ingress`;
    router.post(path, (ctx) => flowPullIngressCreateHandler(ctx, transport));
    router.get(path, (ctx) => flowPullIngressStatusHandler(ctx, transport));
    router.delete(path, (ctx) => flowPullIngressDeleteHandler(ctx, transport));
  }
  router.post('/v1/admin/scale/turn/test', turnTestHandler);
  router.get('/v1/admin/roles', rolesGetHandler);
  router.post('/v1/admin/roles', roleCreateHandler);
  router.put('/v1/admin/roles/:id', roleUpdateHandler);
  router.delete('/v1/admin/roles/:id', roleDeleteHandler);
  router.get('/v1/admin/assistant/prompts', assistantPromptsHandler);
  router.post('/v1/admin/assistant', dashboardAssistantHandler);
  router.post('/v1/admin/guard/assess', guardAssessHandler);
}
