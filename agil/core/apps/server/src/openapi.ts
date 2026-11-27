/**
 * OpenAPI 3.1 specification + a self-contained API explorer (contract §20).
 *
 * - `createOpenApiSpec()` builds the spec from the shared DTOs; it is exported so
 *   MCP/dashboard/scripts can consume it without running the server;
 * - `GET /openapi.json` serves it; `GET /docs` serves a dependency-free HTML
 *   explorer that works offline (no CDN, no Swagger bundle);
 * - `tsx src/tools/export-openapi.ts` (`npm run openapi`) writes docs/openapi.json.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { nodeModuleActions, nodeModuleKinds, turnNodeStates } from '@agil/protocol';
import type { RequestContext, Router } from './http.js';
import { SERVER_NAME, SERVER_VERSION } from './public-api.js';

type Json = Record<string, unknown>;

const ERROR_RESPONSES: Json = {
  '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
  '401': { description: 'Missing/invalid credentials', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
  '403': { description: 'Forbidden (wrong tenant, policy, feature)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
  '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
  '409': { description: 'Conflict (room full/exists)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
  '402': { description: 'Plan quota exceeded (billing enforcement)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
  '413': { description: 'Payload too large', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
  '423': { description: 'Room is locked', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
  '429': { description: 'Rate limited / lockout', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
  '501': { description: 'Not configured (e.g. server STT)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
};

function json(schemaRef: string, description: string): Json {
  return { description, content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaRef}` } } } };
}

/** Registry writes fail closed with `503 registry_unavailable`. */
const REGISTRY_UNAVAILABLE_RESPONSE: Json = {
  description: 'Cluster registry write failed (`registry_unavailable`); retry the request',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } },
};

function op(config: Json): Json {
  return { ...config, responses: { ...(config.responses as Json), ...ERROR_RESPONSES } };
}

/** SIP-specific responses; `op()` merges these after the generic error set. */
const SIP_ERROR_RESPONSES: Json = {
  '409': {
    description: 'E2EE incompatible (`e2ee_incompatible`) or concurrency limit (`sip_limit_reached`)',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } },
  },
  '501': {
    description: 'Gateway disabled/not configured/trunk missing (`sip_disabled`, `sip_not_configured`, `sip_trunk_not_configured`)',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } },
  },
  '502': {
    description: 'SIP gateway failure (`sip_failed`); upstream detail is redacted (no URLs/tokens/phone numbers)',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } },
  },
};

function sipOp(config: Json): Json {
  const merged = op(config);
  return { ...merged, responses: { ...(merged.responses as Json), ...SIP_ERROR_RESPONSES } };
}

function body(schemaOrRef: string | Json, required = true): Json {
  const schema = typeof schemaOrRef === 'string' ? { $ref: `#/components/schemas/${schemaOrRef}` } : schemaOrRef;
  return { required, content: { 'application/json': { schema } } };
}

/** SCIM response content (application/scim+json). */
function scimJson(schemaRef: string, description: string): Json {
  return {
    description,
    content: { 'application/scim+json': { schema: { $ref: `#/components/schemas/${schemaRef}` } } },
  };
}

/** SCIM request body with an example. */
function scimBody(schemaRef: string, example: Json, required = true): Json {
  return {
    required,
    content: {
      'application/scim+json': {
        schema: { $ref: `#/components/schemas/${schemaRef}` },
        example,
      },
    },
  };
}

/** JSON request body with a concrete example (rendered by Swagger/Redoc/Postman). */
function bodyExample(schemaRef: string, example: Json, required = true): Json {
  return {
    required,
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${schemaRef}` },
        example,
      },
    },
  };
}

function pathParam(name: string, description: string): Json {
  return { name, in: 'path', required: true, description, schema: { type: 'string' } };
}

function queryParam(name: string, description: string, type = 'string'): Json {
  return { name, in: 'query', required: false, description, schema: { type } };
}

function headerParam(name: string, description: string, required = false): Json {
  return { name, in: 'header', required, description, schema: { type: 'string' } };
}

const API_KEY_SECURITY: Json[] = [{ apiKey: [] }];
const BEARER_SECURITY: Json[] = [{ bearer: [] }];

function components(includeAdmin: boolean): Json {
  const object = (props: Json, required: string[] = []): Json => ({
    type: 'object',
    ...(required.length > 0 ? { required } : {}),
    properties: props,
  });
  const string = (description?: string, extra: Json = {}): Json => ({ type: 'string', ...(description ? { description } : {}), ...extra });
  const number = (description?: string): Json => ({ type: 'number', ...(description ? { description } : {}) });
  const boolean = (description?: string): Json => ({ type: 'boolean', ...(description ? { description } : {}) });
  const arrayOf = (ref: string): Json => ({ type: 'array', items: { $ref: `#/components/schemas/${ref}` } });
  const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
  const ADMIN_ONLY_SCHEMAS = [
    'AdminOverview', 'AdminRoomSummary', 'RoomDetail', 'AuditEntry', 'AuditListResponse',
    'SecurityOverview', 'AccessPolicy', 'AccessPolicyResponse', 'AiAgentSettingsResponse',
    'KnowledgeAgentSettingsResponse', 'KnowledgeAskRequest', 'KnowledgeAskResponse',
    'WebhookEndpointConfig', 'WebhookDeliveryRecord', 'WebhooksResponse', 'WebhookTestResponse',
    'ProviderSlot', 'ProvidersConfig', 'ProviderStatus', 'ProvidersResponse',
    'ProviderTestRequest', 'ProviderTestResponse', 'InviteLink', 'InCallAssistantSettings',
    'ScaleConfig', 'ScaleClusterNode', 'ScaleTurnServer', 'ScaleTurnStatus', 'ScaleStatusResponse', 'ClusterStatusResponse', 'TurnTestResponse',
    'ParticipantCapacity',
    'RoleDefinition', 'RolesResponse', 'RoleWriteRequest',
    'AssistantPromptInfo', 'AssistantPromptsResponse', 'DashboardAssistantRequest', 'DashboardAssistantResponse', 'RoomPasswordRequest', 'RoomPasswordResponse',
    'GuardFinding', 'GuardAssessRequest', 'GuardAssessResponse',
    'DocEntry', 'DocsListResponse', 'DocContentResponse', 'DocWriteRequest', 'DocRevisionRequest',
    'DocVersion', 'DocHistoryResponse', 'DocDefaultRequest',
    'TenantSummary', 'TenantsResponse', 'TenantCreateRequest', 'TenantCreatedResponse', 'TenantKeyResponse',
    'DomainConfigRequest', 'DomainConfigResponse', 'DomainVerificationInfo',
    'MediaProcessingPolicy', 'MediaProcessingSummary', 'MediaProcessingStatus',
    'BillingConfig', 'BillingPlanLimits', 'BillingUsageCounters',
    'BillingLiveUsage', 'BillingUsageResponse', 'BillingPlanResponse', 'BillingPlanPatch',
    'SipStatus', 'SipTestRequest', 'SipTestResult',
    'VoiceChannelMember', 'VoiceChannelCreate', 'VoiceChannelPatch', 'VoiceChannel',
    'VoiceChannelResponse', 'VoiceChannelList', 'VoiceChannelGrantRequest', 'VoiceChannelGrant',
  ];

  const allSchemas: Json = {
    securitySchemes: includeAdmin
      ? {
          apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'Tenant admin key (AGIL_APY_KEYS)' },
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Join token from /v1/rooms/:id/join or an invite; or an SSO admin session from GET /v1/auth/oidc/callback (tenant admin endpoints only)' },
        }
      : {
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Join token from /v1/rooms/:id/join or an invite; or an SSO admin session from GET /v1/auth/oidc/callback (tenant admin endpoints only)' },
        },
    schemas: {
      ApiErrorBody: object({ error: object({ code: string('Stable machine-readable code'), message: string(), details: {} }, ['code', 'message']) }, ['error']),
      ReadinessResponse: object({ ready: { type: 'boolean' } }, ['ready']),
      HealthResponse: object({
        ok: boolean(),
        name: string(),
        version: string(),
        uptimeSec: number(),
        rooms: number(),
        tenants: number(),
        security: object({
          geoEnabled: boolean(),
          integrityEnabled: boolean(),
          sttConfigured: boolean(),
          aiAgentConfigured: boolean(),
          recordingsDir: string(),
        }),
      }),
      TenantConfig: { type: 'object', description: 'Complete tenant configuration (see @agil/protocol tenantConfigSchema)', additionalProperties: true },
      TenantConfigPatch: { type: 'object', description: 'Deep-partial tenant configuration', additionalProperties: true },
      ConfigEnvelope: object({
        config: ref('TenantConfig'), etag: string('sha256 of the config'),
        editorDraftPublished: { type: 'boolean', const: true },
      }, ['config', 'etag']),
      EditorDraftPatch: object({
        editorDraft: ref('TenantConfig'), baseEtag: string('Version returned when the editor loaded the tenant config'),
      }, ['editorDraft']),
      IceServer: object({ urls: { oneOf: [string(), { type: 'array', items: { type: 'string' } }] }, username: string(), credential: string() }, ['urls']),
      RoomContext: object({ messenger: string('telegram|slack|teams|matrix|corp-messenger'), conversationId: string(), directPeerId: string(), title: string() }),
      RoomInfo: object({ id: string(), tenantId: string(), name: string(), createdAt: number(), locked: boolean(), mode: { type: 'string', enum: ['direct', 'group'] }, context: ref('RoomContext') }, ['id', 'tenantId', 'name', 'createdAt', 'locked']),
      ParticipantState: object({ mic: { type: 'string', enum: ['on', 'off'] }, cam: { type: 'string', enum: ['on', 'off'] }, screen: boolean(), handRaised: boolean(), network: { type: 'string', enum: ['good', 'fair', 'poor'] } }),
      ParticipantLocation: object({ country: string(), city: string(), source: { type: 'string', enum: ['ip', 'gps', 'none'] }, vpnSuspected: boolean(), accuracyM: number() }, ['source']),
      Participant: object({
        id: string(), name: string(), role: { type: 'string', enum: ['host', 'moderator', 'guest'] },
        joinedAt: number(), state: ref('ParticipantState'), country: string(), verified: boolean(),
        integrity: { type: 'string', enum: ['unknown', 'verified', 'suspicious'] },
        permissions: { type: 'array', items: { type: 'string' } },
        roleName: string('Display name of a custom role'),
        location: ref('ParticipantLocation'),
      }, ['id', 'name', 'role', 'joinedAt', 'state', 'verified', 'integrity']),
      ChatMessage: object({
        id: string(), roomId: string(),
        from: object({ id: string(), name: string(), role: { type: 'string', enum: ['host', 'moderator', 'guest'] } }),
        text: string(), ts: number(), kind: { type: 'string', enum: ['text', 'system', 'file'] },
        attachment: object({ name: string(), size: number(), mime: string(), url: string() }),
      }, ['id', 'roomId', 'from', 'text', 'ts', 'kind']),
      CreateRoomRequest: object({ tenantId: string(), roomId: string(), name: string(), password: string(), maxParticipants: { type: 'integer', minimum: 2, maximum: 50000, description: 'Requested capacity. Core applies plan and media limits. Direct rooms have at most two seats.' }, ttlSec: { type: 'integer', minimum: 0, maximum: 86400 }, configOverrides: ref('TenantConfigPatch'), mode: { type: 'string', enum: ['direct', 'group'], description: 'direct = 1:1 messenger call (max 2 participants); group = default' }, transport: { type: 'string', enum: ['p2p', 'sfu'], description: 'Direct (mode:"direct") only. p2p = browser-to-browser mesh, exactly 2 seats, no server media (docs/p2p.md); sfu/omitted = current effective media plane. 400 for group mode or >2 seats; 409 p2p_unsupported when server egress/streaming/webinar is enabled.' }, context: ref('RoomContext'), allowedParticipantIds: { type: 'array', minItems: 1, maxItems: 50000, items: { type: 'string', minLength: 1, maxLength: 64 }, description: 'List of company user IDs. Requires an API key at creation and a signed participant token to join.' } }),
      CreateRoomResponse: object({ room: ref('RoomInfo'), joinUrl: string(), embedUrl: string(), token: string(), expiresAt: number(), passwordProtected: boolean(), billingWarning: ref('BillingQuotaWarning') }, ['room', 'joinUrl', 'embedUrl', 'passwordProtected']),
      BillingConfig: object({
        enabled: boolean('Enforce quotas (metering is always recorded)'),
        plan: { type: 'string', enum: ['free', 'team', 'business', 'enterprise'] },
        includedMinutes: { type: 'integer', minimum: 0, description: 'Room minutes included per UTC calendar month' },
        maxParticipants: { type: 'integer', minimum: 2, description: 'Max concurrent participants per tenant' },
        maxRooms: { type: 'integer', minimum: 1, description: 'Max concurrent rooms per tenant' },
        overagePolicy: { type: 'string', enum: ['allow', 'warn', 'block'] },
      }, ['enabled', 'plan', 'includedMinutes', 'maxParticipants', 'maxRooms', 'overagePolicy']),
      BillingPlanLimits: object({
        includedMinutes: { type: 'integer', minimum: 0 },
        maxParticipants: { type: 'integer', minimum: 2 },
        maxRooms: { type: 'integer', minimum: 1 },
      }, ['includedMinutes', 'maxParticipants', 'maxRooms']),
      BillingUsageCounters: object({
        tenantId: string(), month: string('UTC month YYYY-MM'),
        minutes: number('Settled room minutes'), roomsCreated: { type: 'integer' },
        participantJoins: { type: 'integer' }, peakParticipants: { type: 'integer' },
        recordings: { type: 'integer' }, recordingMinutes: number(),
        createdAt: number(), updatedAt: number(),
      }, ['tenantId', 'month', 'minutes', 'roomsCreated', 'participantJoins', 'peakParticipants', 'recordings', 'recordingMinutes', 'createdAt', 'updatedAt']),
      BillingQuotaWarning: object({
        code: { type: 'string', enum: ['quota_warning'] },
        metric: { type: 'string', enum: ['minutes', 'rooms', 'participants'] },
        used: number(), limit: number(),
        policy: { type: 'string', enum: ['allow', 'warn', 'block'] },
        message: string(),
      }, ['code', 'metric', 'used', 'limit', 'policy', 'message']),
      BillingLiveUsage: object({
        activeRooms: { type: 'integer' }, activeParticipants: { type: 'integer' },
        liveMinutes: number('Not yet settled minutes'), totalMinutes: number(),
      }, ['activeRooms', 'activeParticipants', 'liveMinutes', 'totalMinutes']),
      BillingUsageResponse: object({
        tenantId: string(), month: string(), billing: ref('BillingConfig'),
        usage: ref('BillingUsageCounters'), live: ref('BillingLiveUsage'),
        quota: object({
          includedMinutes: { type: 'integer' }, maxParticipants: { type: 'integer' }, maxRooms: { type: 'integer' },
          overagePolicy: { type: 'string', enum: ['allow', 'warn', 'block'] },
          minutesRemaining: number(), overageMinutes: number(),
        }, ['includedMinutes', 'maxParticipants', 'maxRooms', 'overagePolicy', 'minutesRemaining', 'overageMinutes']),
        months: { type: 'array', items: { type: 'string' } },
        warnings: arrayOf('BillingQuotaWarning'),
      }, ['tenantId', 'month', 'billing', 'usage', 'live', 'quota', 'months', 'warnings']),
      BillingPlanResponse: object({
        tenantId: string(), billing: ref('BillingConfig'),
        plans: { type: 'object', additionalProperties: ref('BillingPlanLimits') },
        usage: object({
          month: string(), minutes: number(), totalMinutes: number(),
          roomsCreated: { type: 'integer' }, participantJoins: { type: 'integer' },
          peakParticipants: { type: 'integer' }, recordings: { type: 'integer' },
          activeRooms: { type: 'integer' }, activeParticipants: { type: 'integer' },
        }, ['month', 'minutes', 'totalMinutes', 'roomsCreated', 'participantJoins', 'peakParticipants', 'recordings', 'activeRooms', 'activeParticipants']),
      }, ['tenantId', 'billing', 'plans', 'usage']),
      BillingPlanPatch: object({
        enabled: boolean(),
        plan: { type: 'string', enum: ['free', 'team', 'business', 'enterprise'] },
        includedMinutes: { type: 'integer', minimum: 0, maximum: 10000000 },
        maxParticipants: { type: 'integer', minimum: 2, maximum: 50000 },
        maxRooms: { type: 'integer', minimum: 1, maximum: 10000 },
        overagePolicy: { type: 'string', enum: ['allow', 'warn', 'block'] },
      }),
      JoinRoomRequest: object({ name: string(), password: string(), participantId: string(), locale: { type: 'string', enum: ['ru', 'en'] }, token: string(), identityToken: string('OIDC identity JWT (SSO)') }),
      OidcVerifyRequest: object({ tenantId: string(), identityToken: string('OIDC identity JWT') }, ['tenantId', 'identityToken']),
      EgressStartRequest: object({
        kind: { type: 'string', enum: ['recording', 'rtmp', 'hls'] },
        rtmpUrl: string('RTMP/RTMPS ingest URL (required for kind=rtmp; redacted in logs/audit)'),
        layout: { type: 'string', enum: ['grid', 'speaker'] },
        audioOnly: boolean(),
      }, ['kind']),
      EgressStartResult: object({ egressId: string(), kind: string(), status: string(), roomName: string() }, ['egressId', 'kind', 'status', 'roomName']),
      EgressInfo: { type: 'object', additionalProperties: true },
      EgressStatus: object({
        configured: boolean(), enabled: boolean(), urlConfigured: boolean(),
        startNodeAvailable: boolean('Whether the tenant has no managed Egress binding or its bound module is ready for new jobs'),
        activeCount: { type: 'integer' }, lastError: { type: 'string', nullable: true },
      }, ['configured', 'enabled', 'urlConfigured', 'startNodeAvailable', 'activeCount', 'lastError']),
      EgressPlaybackLink: object({
        egressId: string(),
        kind: { type: 'string', enum: ['recording', 'hls'] },
        url: string('Absolute same-origin capability URL (HMAC + exp); no S3 credentials'),
        expiresAt: { type: 'integer', description: 'Epoch ms' },
        ttlSec: { type: 'integer' },
      }, ['egressId', 'kind', 'url', 'expiresAt', 'ttlSec']),
      EgressPlaybackLinkRequest: object({
        ttlSec: {
          type: 'integer',
          minimum: 60,
          maximum: 86400,
          description: 'Link lifetime in seconds (default AGIL_EGRESS_PLAYBACK_TTL_SEC; hard cap 24 h)',
        },
      }),
      EgressCleanupRequest: object({
        apply: boolean('true stops the listed jobs; false (default) is a dry run'),
        thresholdSec: {
          type: 'integer',
          minimum: 60,
          maximum: 172800,
          description: 'Jobs active longer than this are considered stuck (default AGIL_EGRESS_STUCK_AFTER_SEC)',
        },
      }),
      EgressStuckJob: object({
        egressId: string(),
        roomName: string('SFU room name (`<tenant>__<roomId>`)'),
        status: string(),
        startedAt: { type: ['integer', 'null'], description: 'Epoch ms; null when egress did not report it' },
        ageSec: { type: ['integer', 'null'] },
      }, ['egressId', 'roomName', 'status', 'startedAt', 'ageSec']),
      EgressCleanupResult: object({
        applied: boolean('false for a dry run'),
        thresholdSec: { type: 'integer' },
        scanned: { type: 'integer' },
        stuck: { type: 'array', items: ref('EgressStuckJob') },
        stopped: { type: 'array', items: { type: 'string' } },
        errors: { type: 'array', items: object({ egressId: string(), message: string() }, ['egressId', 'message']) },
      }, ['applied', 'thresholdSec', 'scanned', 'stuck', 'stopped', 'errors']),
      EgressWorkerStatus: object({
        configured: boolean(),
        enabled: boolean(),
        startNodeAvailable: boolean('Whether the tenant has no managed Egress binding or its bound module is ready for new jobs'),
        urlConfigured: boolean(),
        activeCount: { type: 'integer' },
        lastError: { type: ['string', 'null'] },
        worker: object({
          urlConfigured: boolean('AGIL_EGRESS_HEALTH_URL is set'),
          reachable: { type: ['boolean', 'null'], description: 'null when no health URL is configured' },
          status: { type: ['string', 'null'] },
          cpuLoad: { type: ['number', 'null'] },
          detail: string('Failure reason; never contains the URL or credentials'),
        }, ['urlConfigured', 'reachable', 'status', 'cpuLoad']),
        playback: object({
          enabled: boolean('Signed playback is enabled in Core'),
          backend: { type: 'string', enum: ['none', 'local', 's3'], description: 'Playback storage configured in Core; does not probe the backend' },
        }, ['enabled', 'backend']),
        checkedAt: { type: 'integer', description: 'Epoch ms' },
      }, ['configured', 'startNodeAvailable', 'worker', 'checkedAt']),
      SipParticipant: object({
        id: string('Opaque participant handle: LiveKit identity, or the LiveKit participant id (PA_…) when the identity is a phone number'),
        identity: string('LiveKit identity (masked when the caller number would otherwise leak)'),
        name: string('Display name; any embedded phone number is masked'),
        role: { type: 'string', enum: ['guest'] },
        roomId: string(),
        source: { type: 'string', enum: ['sip'] },
        status: { type: 'string', enum: ['dialing', 'joined', 'active', 'disconnected', 'unknown'] },
        joinedAt: { type: 'integer', description: 'Epoch ms when known' },
        masked: boolean('True when the LiveKit identity is a phone number and has been masked'),
      }, ['id', 'identity', 'name', 'role', 'roomId', 'source', 'status']),
      SipDialInRequest: object({
        number: string('E.164 number to call (+<country><number>)'),
        name: string('Display name inside the room (optional)'),
        dtmf: string('Post-answer DTMF digits (0-9, *, #, w=0.5 s pause; max 32). Never logged or audited'),
      }, ['number']),
      SipListResponse: object({ roomId: string(), participants: arrayOf('SipParticipant') }, ['roomId', 'participants']),
      SipStopResponse: object({ stopped: boolean(), participantId: string('Opaque participant handle; phone-like ids are rejected') }, ['stopped', 'participantId']),
      SipStatus: object({
        configured: boolean('AGIL_SIP_URL + LiveKit API key/secret are set'),
        enabled: boolean('AGIL_SIP_ENABLED=1 and the gateway is configured'),
        trunkConfigured: boolean('scale.sip.trunkId is set'),
        nodeAvailable: boolean('Whether the bound SIP module is available. Absent when no node is bound.'),
        numbers: { type: 'array', items: { type: 'string' }, description: 'Published E.164 dial-in numbers (tenant config)' },
        active: { type: 'integer', description: 'Active SIP participants in this tenant rooms (best effort)' },
      }, ['configured', 'enabled', 'trunkConfigured', 'numbers', 'active']),
      SipTestRequest: object({
        mode: { type: 'string', enum: ['mock', 'live'], description: 'mock = config check, live = real Twirp request' },
        number: string('Optional E.164 number to validate'),
      }),
      SipTestResult: object({
        ok: boolean(), mode: { type: 'string', enum: ['mock', 'live'] },
        configured: boolean(), trunkConfigured: boolean(), detail: string(),
        latencyMs: number(),
      }, ['ok', 'mode', 'configured', 'trunkConfigured', 'detail', 'latencyMs']),
      SiemStatus: object({
        configured: boolean(), enabled: boolean(), format: { type: 'string', enum: ['json', 'cef'] },
        queue: { type: 'integer' },
        lastError: { type: 'string', nullable: true },
        lastDelivery: { type: 'object', nullable: true, additionalProperties: true },
      }, ['configured', 'enabled', 'format', 'queue', 'lastError', 'lastDelivery']),
      SiemTestResult: object({
        ok: boolean(), statusCode: { type: 'integer' }, latencyMs: { type: 'number' }, detail: string(),
      }, ['ok', 'latencyMs', 'detail']),
      ScimUser: object({
        schemas: { type: 'array', items: { type: 'string' } }, id: string(), externalId: string(), userName: string(),
        name: { type: 'object', additionalProperties: true }, displayName: string(),
        emails: { type: 'array', items: object({ value: string(), type: string(), primary: boolean() }, ['value']) },
        active: boolean(), roles: { type: 'array', items: { type: 'object', additionalProperties: true } },
        groups: { type: 'array', items: { type: 'object', additionalProperties: true } },
        meta: { type: 'object', additionalProperties: true },
      }, ['id', 'userName', 'active', 'meta']),
      ScimGroup: object({
        schemas: { type: 'array', items: { type: 'string' } }, id: string(), externalId: string(), displayName: string(),
        members: { type: 'array', items: { type: 'object', additionalProperties: true } },
        meta: { type: 'object', additionalProperties: true },
      }, ['id', 'displayName', 'members', 'meta']),
      ScimListResponse: object({
        schemas: { type: 'array', items: { type: 'string' } }, totalResults: { type: 'integer' },
        startIndex: { type: 'integer' }, itemsPerPage: { type: 'integer' },
        Resources: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }, ['schemas', 'totalResults', 'startIndex', 'itemsPerPage', 'Resources']),
      ScimError: object({
        schemas: { type: 'array', items: { type: 'string' } }, detail: string(), status: string(), scimType: string(),
      }, ['schemas', 'detail', 'status']),
      ScimPatchRequest: object({
        schemas: { type: 'array', items: { type: 'string' } },
        Operations: { type: 'array', items: object({ op: string(), path: string(), value: {} }, ['op']) },
      }, ['Operations']),
      OidcVerifiedIdentity: object({
        userId: string(), name: string(),
        role: { type: 'string', enum: ['host', 'moderator', 'guest'] },
        permissions: { type: 'array', items: { type: 'string' } },
        verified: boolean(), issuer: string(),
      }, ['userId', 'name', 'role', 'permissions', 'verified', 'issuer']),
      OidcStartResponse: object({
        authorizationUrl: string('IdP authorization URL (state, nonce and PKCE challenge included)'),
        expiresAt: number('Unix ms when the pending state/PKCE entry expires (10 min)'),
      }, ['authorizationUrl', 'expiresAt']),
      OidcLogoutResponse: object({
        logoutUrl: string('IdP RP-initiated logout URL (client_id, post_logout_redirect_uri and state included)'),
        expiresAt: number('Unix ms when the pending logout state expires (10 min)'),
      }, ['logoutUrl', 'expiresAt']),
      JoinRoomResponse: object({ token: string(), expiresAt: number(), room: ref('RoomInfo'), participant: object({ id: string(), name: string(), role: string() }), config: ref('TenantConfig'), passwordAccepted: boolean(), permissions: { type: 'array', items: { type: 'string' } }, media: ref('SfuMediaSession') }, ['token', 'expiresAt', 'room', 'participant', 'config', 'passwordAccepted']),
      TokenRequest: object({ tenantId: string(), roomId: string(), participant: object({ name: string(), role: { type: 'string', enum: ['host', 'moderator', 'guest'] }, participantId: string(), roleId: string('Custom role id (security.accessPolicy.customRoles)') }), ttlSec: { type: 'integer' }, permissions: { type: 'array', items: { type: 'string' } } }, ['tenantId', 'roomId', 'participant']),
      TokenResponse: object({ token: string(), expiresAt: number(), tenantId: string(), roomId: string(), permissions: { type: 'array', items: { type: 'string' } }, roleId: string(), roleName: string() }, ['token', 'expiresAt', 'tenantId', 'roomId', 'permissions']),
      RoleDefinition: object({
        id: string(), name: string(), description: string(),
        baseRole: { type: 'string', enum: ['host', 'moderator', 'guest'] },
        features: { type: 'array', items: { type: 'string' } },
        canModerate: boolean(), color: string(), builtin: boolean(),
        assigned: { type: 'integer', description: 'Active participants currently using this role' },
      }, ['id', 'name', 'description', 'baseRole', 'features', 'canModerate', 'color', 'builtin']),
      RolesResponse: object({ roles: arrayOf('RoleDefinition') }, ['roles']),
      VoiceChannelMember: object({
        participantId: string('Stable participant ID assigned by the company', { minLength: 1, maxLength: 64 }),
        role: string('Role for this channel', { enum: ['host', 'moderator', 'guest'] }),
        name: string('Optional display name', { minLength: 1, maxLength: 120 }),
      }, ['participantId', 'role']),
      VoiceChannelCreate: object({
        id: string('Stable company channel identifier', { pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' }),
        name: string(undefined, { minLength: 1, maxLength: 120 }),
        members: arrayOf('VoiceChannelMember'),
      }, ['id', 'name', 'members']),
      VoiceChannelPatch: object({ name: string(undefined, { minLength: 1, maxLength: 120 }), members: arrayOf('VoiceChannelMember') }),
      VoiceChannel: { allOf: [ref('VoiceChannelCreate'), object({
        revision: string('Roster generation'), createdAt: number('Unix milliseconds'), updatedAt: number('Unix milliseconds'),
      }, ['revision', 'createdAt', 'updatedAt'])] },
      VoiceChannelResponse: object({ channel: ref('VoiceChannel') }, ['channel']),
      VoiceChannelList: object({ channels: arrayOf('VoiceChannel') }, ['channels']),
      VoiceChannelGrantRequest: object({ participantId: string(), name: string('Fallback display name supplied by the company') }, ['participantId']),
      VoiceChannelGrant: object({
        channelId: string(), roomId: string(), token: string('Short-lived room access token'), expiresAt: number('Unix milliseconds'), joinUrl: string(),
      }, ['channelId', 'roomId', 'token', 'expiresAt', 'joinUrl']),
      RoleWriteRequest: object({
        id: string('lowercase latin, digits, _ and -'), name: string(), description: string(),
        baseRole: { type: 'string', enum: ['host', 'moderator', 'guest'] },
        features: { type: 'array', items: { type: 'string' } },
        canModerate: boolean(), color: string(),
      }, ['id', 'name', 'baseRole', 'features']),
      AssistantPromptInfo: object({
        role: { type: 'string', enum: ['assistant', 'config-guardian', 'security-reviewer', 'onboarding', 'api-helper', 'scaling-advisor', 'roles-admin'] },
        title: string(), description: string(),
        starters: { type: 'array', items: { type: 'string' } },
      }, ['role', 'title', 'description', 'starters']),
      AssistantPromptsResponse: object({ prompts: arrayOf('AssistantPromptInfo') }, ['prompts']),
      RoomPasswordRequest: object({ password: string('Опустите/пусто — сгенерировать и вернуть один раз') }, []),
      DocEntry: object({
        name: string(), title: string(), sizeBytes: { type: 'integer' }, updatedAt: { type: 'number' },
        bundled: boolean(), custom: boolean(), isDefault: boolean(), versions: { type: 'integer' },
      }, ['name', 'title', 'sizeBytes', 'updatedAt', 'bundled', 'custom', 'isDefault', 'versions']),
      DocsListResponse: object({ docs: arrayOf('DocEntry'), defaultName: string(), editable: boolean(), revisionRestore: boolean('Restore accepts expectedRevision'), conditionalCreate: boolean('Writing a new document supports expectedRevision: null') }, ['docs', 'defaultName', 'editable']),
      DocContentResponse: object({
        name: string(), title: string(), content: string(), updatedAt: { type: 'number' },
        bundled: boolean(), custom: boolean(), isDefault: boolean(), revision: string('Effective publication revision'),
      }, ['name', 'title', 'content', 'updatedAt', 'bundled', 'custom', 'isDefault']),
      DocWriteRequest: object({ content: string(), title: string(), expectedRevision: { type: ['string', 'null'], description: 'Revision from the last document read, or null to require an unused name' } }, ['content']),
      DocRevisionRequest: object({ expectedRevision: string('Revision from the last document read') }),
      DocVersion: object({
        id: string(), name: string(), createdAt: { type: 'number' }, sizeBytes: { type: 'integer' },
        author: string(), note: string(), isCurrent: boolean(),
      }, ['id', 'name', 'createdAt', 'sizeBytes', 'author', 'isCurrent']),
      DocHistoryResponse: object({ name: string(), versions: arrayOf('DocVersion') }, ['name', 'versions']),
      DocDefaultRequest: object({ name: string() }, ['name']),
      TenantSummary: object({
        tenantId: string(), name: string(), organizationName: string(), productName: string(), logoUrl: string(),
        scheme: { type: 'string', enum: ['light', 'dark', 'auto', 'auto-light', 'auto-dark'] },
        rooms: { type: 'integer' }, participants: { type: 'integer' }, recordings: { type: 'integer' },
        apiKeyConfigured: boolean(), createdAt: { type: 'number' },
      }, ['tenantId', 'name', 'organizationName', 'productName', 'logoUrl', 'scheme', 'rooms', 'participants', 'recordings', 'apiKeyConfigured']),
      TenantsResponse: object({ tenants: arrayOf('TenantSummary'), platform: boolean() }, ['tenants', 'platform']),
      TenantCreateRequest: object({
        tenantId: string('latin letters, digits, dot, underscore, dash (1..64)'), name: string(), organizationName: string(),
        branding: { type: 'object', additionalProperties: true }, theme: { type: 'object', additionalProperties: true },
        templateTenantId: string(), preset: { type: 'string', enum: ['default', 'corporate', 'minimal'] },
        features: { type: 'object', additionalProperties: { type: 'boolean' }, description: 'Feature overrides applied after the preset' },
      }, ['tenantId', 'name']),
      TenantCreatedResponse: object({ tenant: ref('TenantSummary'), apiKey: string('Plaintext key — returned once'), embedUrl: string() }, ['tenant', 'apiKey', 'embedUrl']),
      TenantKeyResponse: object({ tenantId: string(), apiKey: string('Plaintext key — returned once') }, ['tenantId', 'apiKey']),
      BreakoutRoomInfo: object({
        id: string(), roomId: string(), name: string(), index: { type: 'integer' },
        participantIds: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['open', 'closed'] },
      }, ['id', 'roomId', 'name', 'index', 'participantIds', 'status']),
      BreakoutPlan: object({
        id: string(), mainRoomId: string(), status: { type: 'string', enum: ['active', 'closed'] },
        mode: { type: 'string', enum: ['random', 'manual'] }, rooms: arrayOf('BreakoutRoomInfo'),
        assignments: { type: 'object', additionalProperties: { type: 'string' } }, allowReturn: boolean(),
        createdAt: { type: 'number' }, endsAt: { type: 'number' }, closedAt: { type: 'number' },
      }, ['id', 'mainRoomId', 'status', 'mode', 'rooms', 'assignments', 'allowReturn', 'createdAt']),
      BreakoutListResponse: object({ roomId: string(), plan: ref('BreakoutPlan') }, ['roomId']),
      BreakoutAssignedMessage: object({
        planId: string(), breakoutRoomId: string(), roomId: string(), name: string(), token: string(), joinUrl: string(),
      }, ['planId', 'breakoutRoomId', 'roomId', 'name', 'token', 'joinUrl']),
      PollOptionResult: object({ id: string(), text: string(), votes: { type: 'integer' }, share: { type: 'number' }, selected: boolean() }, ['id', 'text', 'votes', 'share']),
      RoomPoll: object({
        id: string(), roomId: string(), tenantId: string(), question: string(), options: arrayOf('PollOptionResult'),
        multiple: boolean(), anonymous: boolean(), kind: { type: 'string', enum: ['poll', 'qna'] },
        status: { type: 'string', enum: ['open', 'closed'] }, createdBy: { type: 'object', additionalProperties: true },
        createdAt: { type: 'number' }, closedAt: { type: 'number' }, totalVotes: { type: 'integer' }, voted: boolean(),
      }, ['id', 'roomId', 'tenantId', 'question', 'options', 'multiple', 'anonymous', 'kind', 'status', 'createdAt', 'totalVotes']),
      PollListResponse: object({ roomId: string(), polls: arrayOf('RoomPoll') }, ['roomId', 'polls']),
      PollVoteResponse: object({ poll: ref('RoomPoll'), accepted: boolean(), reason: string() }, ['poll', 'accepted']),
      CreateBreakoutRequest: object({
        mode: { type: 'string', enum: ['random', 'manual'] },
        rooms: { type: 'array', items: { type: 'object', additionalProperties: true }, minItems: 2, maxItems: 20 },
        count: { type: 'integer' }, durationMin: { type: 'integer' }, allowReturn: boolean(),
      }, []),
      CreatePollRequest: object({
        question: string(), options: { type: 'array', items: object({ text: string() }, ['text']), minItems: 2, maxItems: 10 },
        multiple: boolean(), anonymous: boolean(), kind: { type: 'string', enum: ['poll', 'qna'] },
      }, ['question', 'options']),
      VotePollRequest: object({ optionIds: { type: 'array', items: { type: 'string' } } }, ['optionIds']),
      SfuMediaSession: object({
        mode: { type: 'string', enum: ['sfu'] }, url: string(), token: string('HS256 LiveKit-compatible JWT'),
        fallbackUrl: string('Shared WebSocket ingress for the same LiveKit deployment'),
        room: string(), canPublish: boolean(), expiresAt: { type: 'number' },
        e2ee: object({
          key: string('Room key (base64url, 32 bytes); never inside the JWT/audit'),
          algorithm: { type: 'string', enum: ['AES-GCM'] },
          keyIndex: { type: 'integer' },
        }, ['key', 'algorithm', 'keyIndex']),
      }, ['mode', 'url', 'token', 'room', 'canPublish', 'expiresAt']),
      LobbyRequestInfo: object({
        id: string(), name: string(), country: string(), createdAt: { type: 'number' }, expiresAt: { type: 'number' },
        status: { type: 'string', enum: ['pending'] },
      }, ['id', 'name', 'createdAt', 'expiresAt', 'status']),
      LobbyJoinResponse: object({
        pending: boolean(), requestId: string(), roomId: string(), cancelToken: string('Private token used to withdraw this pending request'),
        status: { type: 'string', enum: ['pending'] }, expiresAt: { type: 'number' }, pollAfterMs: { type: 'integer' },
        waitingMessage: { type: 'string', maxLength: 500, description: 'Effective waiting-room text configured for this room.' },
      }, ['pending', 'requestId', 'roomId', 'status', 'expiresAt', 'pollAfterMs']),
      LobbyRequestsResponse: object({ roomId: string(), requests: arrayOf('LobbyRequestInfo') }, ['roomId', 'requests']),
      LobbyCancelRequest: object({ cancelToken: string() }, ['cancelToken']),
      LobbyCancelResponse: object({ requestId: string(), status: { type: 'string', enum: ['cancelled'] } }, ['requestId', 'status']),
      LobbyStatusResponse: object({
        requestId: string(), status: { type: 'string', enum: ['pending', 'admitted', 'rejected', 'expired'] },
        token: string('Join token, returned once after admit'), expiresAt: { type: 'number' }, joinUrl: string(), embedUrl: string(), reason: string(),
      }, ['requestId', 'status']),
      LobbyDecisionResponse: object({ requestId: string(), status: { type: 'string', enum: ['admitted', 'rejected'] } }, ['requestId', 'status']),
      DomainConfigRequest: object({ domain: string('Bare host name, empty to reset') }, ['domain']),
      DomainVerificationInfo: object({
        token: string('Public DNS TXT challenge secret'),
        method: { type: 'string', enum: ['txt', 'cname'] },
        txt: object({ name: string(), value: string(), ttl: { type: 'integer' } }, ['name', 'value', 'ttl']),
        cname: object({ name: string(), value: string(), ttl: { type: 'integer' } }, ['name', 'value', 'ttl']),
        verifiedAt: number(), lastCheckedAt: number(), lastError: string(),
      }, ['token', 'method', 'txt', 'cname']),
      DomainConfigResponse: object({
        domain: string(),
        status: { type: 'string', enum: ['none', 'pending', 'verified'] },
        verified: boolean(),
        verification: ref('DomainVerificationInfo'),
        dnsInstructions: object({ type: { type: 'string', enum: ['CNAME'] }, name: string(), value: string(), ttl: { type: 'integer' } }, ['type', 'name', 'value', 'ttl']),
        docsHint: string(),
      }, ['domain', 'status', 'verified', 'dnsInstructions', 'docsHint']),
      HostInfoResponse: object({
        host: string(), tenantId: string(), defaultTenantId: string(),
        resolved: { type: 'string', enum: ['domain', 'default'] },
        customDomain: string(), verified: boolean(),
        branding: object({
          productName: string(), organizationName: string(), logoUrl: string(), faviconUrl: string(),
          supportUrl: string(), footerText: string(),
        }, ['productName']),
      }, ['host', 'tenantId', 'defaultTenantId', 'resolved', 'customDomain', 'verified', 'branding']),
      DomainAskResponse: object({ allowed: boolean(), domain: string() }, ['allowed', 'domain']),
      RoomPasswordResponse: object({
        updated: boolean(), passwordProtected: boolean(), generated: boolean(),
        password: string('Generated password — shown once'), removed: boolean(),
      }, ['updated', 'passwordProtected']),
      DashboardAssistantRequest: object({
        messages: { type: 'array', items: object({ role: { type: 'string', enum: ['user', 'assistant', 'system'] }, content: string() }) },
        role: { type: 'string', enum: ['assistant', 'config-guardian', 'security-reviewer', 'onboarding', 'api-helper', 'scaling-advisor', 'roles-admin'] },
        context: object({ screen: string(), tenantId: string(), roomId: string(), currentConfig: { type: 'object', additionalProperties: true }, memory: string('Excerpts from previous admin chats (≤2000 chars used)'), chatId: string('Chat session id for audit') }),
      }, ['messages']),
      DashboardAssistantResponse: object({
        reply: string(), role: string(), model: string(), fallback: boolean(),
        risk: { type: 'object', additionalProperties: true },
        suggestions: { type: 'array', items: { type: 'string' } },
      }, ['reply', 'role', 'model', 'fallback', 'suggestions']),
      GuardFinding: object({
        id: string(), severity: { type: 'string', enum: ['info', 'warn', 'critical'] },
        title: string(), description: string(), impact: string(),
        affected: { type: 'array', items: { type: 'string' } }, requiresConfirmation: boolean(),
      }, ['id', 'severity', 'title', 'description', 'impact', 'affected', 'requiresConfirmation']),
      GuardAssessRequest: object({
        kind: { type: 'string', enum: ['config', 'roles', 'access', 'scale', 'providers', 'webhook', 'room', 'integrations'] },
        locale: { type: 'string', enum: ['ru', 'en'], default: 'ru' },
        current: { type: 'object', additionalProperties: true }, next: { type: 'object', additionalProperties: true },
        intent: string(), editorDraft: boolean(),
      }, ['kind', 'next']),
      GuardAssessResponse: object({
        risk: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        requiresConfirmation: boolean(), summary: string(), message: string(),
        findings: arrayOf('GuardFinding'), recommendations: { type: 'array', items: { type: 'string' } },
      }, ['risk', 'requiresConfirmation', 'summary', 'message', 'findings', 'recommendations']),
      FileRecord: object({ id: string(), tenantId: string(), roomId: string(), name: string(), size: number(), mime: string(), url: string(), createdAt: number(), expiresAt: number(), uploadedBy: string() }, ['id', 'tenantId', 'roomId', 'name', 'size', 'mime', 'url', 'createdAt', 'expiresAt', 'uploadedBy']),
      RecordingRecord: object({ id: string(), tenantId: string(), roomId: string(), mime: string(), size: number(), durationSec: number(), url: string(), createdAt: number(), createdBy: string(), transcript: string(), source: { enum: ['egress'] }, canDelete: { type: 'boolean' } }, ['id', 'tenantId', 'roomId', 'mime', 'size', 'durationSec', 'url', 'createdAt', 'createdBy']),
      SttResponse: object({
        text: string(),
        provider: { type: 'string', enum: ['browser', 'server', 'local', 'stub'], description: 'local = on-box whisper.cpp/faster-whisper' },
        language: string(),
        durationSec: number(),
        /** Local engine label, e.g. whisper-cpp:ggml-small.bin. */
        engine: string(),
        model: string(),
        local: { type: 'boolean', description: 'Audio never left the deployment' },
        segments: {
          type: 'array',
          items: object({
            start: number(),
            end: number(),
            text: string(),
            lang: { type: 'string', enum: ['ru', 'en'] },
            translation: {
              type: 'object',
              properties: {
                text: string(),
                lang: { type: 'string', enum: ['ru', 'en'] },
                provider: { type: 'string', enum: ['local', 'llm', 'stub'] },
                engine: string(),
              },
              required: ['text', 'lang', 'provider'],
            },
          }),
        },
        translation: object({
          targetLang: { type: 'string', enum: ['ru', 'en'] },
          provider: { type: 'string', enum: ['local', 'llm', 'stub'] },
          engine: string(),
        }),
        notice: string('Machine-translation quality caveat'),
      }, ['text', 'provider']),
      LivenessVerifyResponse: object({
        sessionId: string(),
        passed: boolean(),
        status: { type: 'string', enum: ['verified', 'failed', 'unavailable', 'expired', 'invalid'] },
        score: number(),
        flags: { type: 'array', items: { type: 'string' } },
        engine: string(),
        attempts: number(),
        maxAttempts: number(),
        advisory: boolean(),
      }, ['sessionId', 'passed', 'status', 'score', 'flags', 'engine', 'attempts', 'maxAttempts', 'advisory']),
      QuarantineRecord: object({
        id: string(),
        tenantId: string(),
        roomId: string(),
        sourceId: string(),
        fileName: string(),
        mime: string(),
        size: number(),
        sha256: string(),
        reason: { type: 'string', enum: ['infected', 'scan_error', 'manual'] },
        engine: string(),
        signature: string(),
        detail: string(),
        quarantinedAt: number(),
        uploadedBy: string(),
      }, ['id', 'tenantId', 'reason', 'engine', 'size', 'sha256', 'quarantinedAt']),
      InviteLink: object({ roomId: string(), joinUrl: string(), embedUrl: string(), token: string(), expiresAt: number(), passwordProtected: boolean() }, ['roomId', 'joinUrl', 'embedUrl', 'token', 'expiresAt', 'passwordProtected']),
      AdminOverview: object({
        tenantId: string(), serverTime: number(), uptimeSec: number(), activeRooms: number(), activeParticipants: number(),
        totalRoomsCreated: number('Rooms created by this tenant since Core started'), waitingParticipants: number('Pending lobby entries in this tenant'), recordings: number(), sharedFiles: number(), securityEvents24h: number(),
        countries: { type: 'object', additionalProperties: { type: 'number' } },
      }),
      AdminRoomSummary: object({ room: ref('RoomInfo'), participants: number(), maxParticipants: number(), passwordProtected: boolean(), createdAt: number(), lastActivityAt: number(), recordings: number(), joinUrl: string(), embedUrl: string() }, ['room', 'participants', 'maxParticipants', 'passwordProtected', 'createdAt', 'lastActivityAt', 'recordings', 'joinUrl', 'embedUrl']),
      RoomDetail: object({ room: ref('RoomInfo'), participants: arrayOf('Participant'), messages: arrayOf('ChatMessage'), passwordProtected: boolean(), createdAt: number(), lastActivityAt: number(), joinUrl: string(), embedUrl: string(), effectiveMaxParticipants: number('Effective join cap for this room'), capacity: ref('ParticipantCapacity') }, ['room', 'participants', 'messages', 'passwordProtected', 'createdAt', 'lastActivityAt', 'joinUrl', 'embedUrl', 'effectiveMaxParticipants', 'capacity']),
      TranscriptResponse: object({
        roomId: string(),
        segments: { type: 'array', items: { type: 'object', additionalProperties: true } },
        updatedAt: number(),
        /** Translation policy in effect for this tenant (never secrets). */
        translation: object({
          enabled: boolean(),
          target: { type: 'string', enum: ['ru', 'en', 'none'] },
          provider: { type: 'string', enum: ['local', 'llm', 'none'] },
          engine: string(),
        }),
        /** Retention/consent policy applied to the returned segments. */
        retention: object({
          retentionSec: number(),
          consentRequired: boolean(),
          consented: boolean(),
        }),
      }, ['roomId', 'segments', 'updatedAt']),
      TranscriptConsentRequest: object({
        granted: boolean('false withdraws consent and erases this participant\'s stored segments'),
      }, ['granted']),
      TranscriptTranslateRequest: object({
        text: string('1..4000 characters'),
        targetLang: { type: 'string', enum: ['ru', 'en'] },
        sourceLang: { type: 'string', enum: ['ru', 'en'] },
      }, ['text']),
      TranscriptTranslateResponse: object({
        translation: object({
          text: string(),
          lang: { type: 'string', enum: ['ru', 'en'] },
          provider: { type: 'string', enum: ['local', 'llm', 'stub'] },
          engine: string(),
        }, ['text', 'lang', 'provider']),
        notice: string(),
      }, ['translation', 'notice']),
      SttStatusResponse: object({
        privacyMode: { type: 'string', enum: ['standard', 'local'] },
        stt: object({
          provider: { type: 'string', enum: ['local', 'browser', 'none', 'remote'] },
          configured: boolean(),
          local: boolean(),
          engine: string(),
          available: boolean(),
          nodeAvailable: boolean('Availability of the bound remote STT module, when configured'),
          model: string('Basename only; never an absolute path'),
          code: string('Stable reason code, e.g. model_missing / ffmpeg_missing'),
          ffmpeg: { type: 'boolean', description: 'false = only audio/wav is accepted (webm/opus returns 501 ffmpeg_missing)' },
          localFilesOnly: { type: 'boolean', description: 'Weights are loaded from disk only (AGIL_STT_ALLOW_DOWNLOAD is off)' },
          reason: string('Actionable reason when unavailable; contains no host paths'),
        }, ['provider', 'configured', 'local']),
        translation: object({
          provider: { type: 'string', enum: ['local', 'llm', 'none'] },
          configured: boolean(),
          available: boolean(),
          engine: string(),
          model: string('Basename only; never an absolute path'),
          code: string('Stable reason code, e.g. translation_model_retired / model_missing'),
          localFilesOnly: boolean(),
          nonCommercial: { type: 'boolean', description: 'Retired NLLB-200 configuration (CC-BY-NC-4.0)' },
          reason: string(),
        }, ['provider', 'configured']),
        consent: object({ required: boolean(), retentionSec: number() }, ['required', 'retentionSec']),
        caveats: { type: 'array', items: { type: 'string' } },
      }, ['privacyMode', 'stt', 'translation', 'consent', 'caveats']),
      ChatPostRequest: object({
        text: string('1..4000 characters'),
        kind: { type: 'string', enum: ['text', 'system'] },
        from: object({ id: string(), name: string(), role: { type: 'string', enum: ['host', 'moderator', 'guest'] } }),
        id: string('Idempotency key'),
      }, ['text']),
      ChatPostResponse: object({ message: ref('ChatMessage') }, ['message']),
      ComplianceFinding: { type: 'object', additionalProperties: true, description: 'ComplianceFinding from @agil/protocol' },
      MeetingNotes: { type: 'object', additionalProperties: true, description: 'MeetingNotes (summary, verbatim excerpts, action items)' },
      AnalysisResponse: object({ roomId: string(), report: { type: ['object', 'null'], additionalProperties: true }, findings: arrayOf('ComplianceFinding'), notes: { oneOf: [ref('MeetingNotes'), { type: 'null' }] } }, ['roomId', 'report', 'findings', 'notes']),
      AuditEntry: object({ id: string(), ts: number(), type: string(), severity: { type: 'string', enum: ['info', 'warn', 'critical'] }, tenantId: string(), roomId: string(), participantId: string(), ipHash: string(), country: string(), message: string(), details: { type: 'object', additionalProperties: true } }, ['id', 'ts', 'type', 'severity', 'message']),
      AuditListResponse: object({ entries: arrayOf('AuditEntry'), total: number(), offset: number(), limit: number(), anchorId: string('Boundary for paging or exporting the same retained snapshot') }, ['entries', 'total', 'offset', 'limit']),
      SecurityOverview: object({ tenantId: string(), events: arrayOf('AuditEntry'), failedJoins24h: number(), blockedJoins24h: number(), suspiciousParticipants: number(), countries: { type: 'object', additionalProperties: { type: 'number' } } }),
      AccessPolicy: { type: 'object', additionalProperties: true, description: 'AccessPolicy: mode, roleDefaults, deniedFeatures, userOverrides' },
      AccessPolicyUpdateRequest: object({
        policy: { ...ref('AccessPolicy'), description: 'Partial policy. roleDefaults can include just the affected roles.' },
        clearUserOverrides: { type: 'array', maxItems: 500, items: { type: 'string', minLength: 1, maxLength: 128 } },
        expectedPolicy: {
          type: 'object', additionalProperties: true,
          description: 'Optional previous values for affected fields. A null userOverrides entry means the user had no override. A mismatch returns 409 access_policy_conflict.',
        },
      }),
      AccessPolicyResponse: object({ policy: ref('AccessPolicy'), featureKeys: { type: 'array', items: { type: 'string' } }, effective: object({ host: { type: 'array', items: { type: 'string' } }, moderator: { type: 'array', items: { type: 'string' } }, guest: { type: 'array', items: { type: 'string' } } }) }, ['policy', 'featureKeys', 'effective']),
      AiAgentSettingsResponse: object({ config: { type: 'object', additionalProperties: true }, endpointConfigured: boolean(), apiKeyConfigured: boolean() }, ['config', 'endpointConfigured', 'apiKeyConfigured']),
      KnowledgeAgentSettingsResponse: object({ config: { type: 'object', additionalProperties: true }, endpointConfigured: boolean(), apiKeyConfigured: boolean() }, ['config', 'endpointConfigured', 'apiKeyConfigured']),
      KnowledgeAskRequest: object({ question: string(), userId: string(), role: { type: 'string', enum: ['host', 'moderator', 'guest'] }, roomId: string(), locale: { type: 'string', enum: ['ru', 'en'] } }, ['question']),
      KnowledgeCitation: object({ title: string(), url: string(), snippet: string() }, ['title', 'url']),
      KnowledgeAskResponse: object({ answer: string(), citations: arrayOf('KnowledgeCitation'), confidence: number(), provider: string(), model: string(), refused: boolean() }, ['answer', 'citations']),
      WebhookEndpointConfig: object({ id: string(), url: string(), events: { type: 'array', items: { type: 'string' } }, secretEnv: string('Env variable name holding the HMAC secret; only AGIL_WEBHOOK_* is accepted'), enabled: boolean(), retries: { type: 'integer' }, timeoutMs: { type: 'integer' }, description: string() }, ['id', 'url', 'events', 'secretEnv', 'enabled', 'retries', 'timeoutMs']),
      WebhookDeliveryRecord: object({ id: string(), endpointId: string(), type: string(), status: { type: 'string', enum: ['delivered', 'failed', 'retrying'] }, attempts: number(), ts: number(), lastError: string(), statusCode: number() }),
      WebhooksResponse: object({ webhooks: arrayOf('WebhookEndpointConfig'), recentDeliveries: arrayOf('WebhookDeliveryRecord') }, ['webhooks', 'recentDeliveries']),
      WebhookTestResponse: object({ endpointId: string(), status: { type: 'string', enum: ['delivered', 'failed'] }, statusCode: number(), error: string() }, ['endpointId', 'status']),
      ProviderSlot: object({
        mode: { type: 'string', enum: ['builtin', 'external', 'disabled'] },
        providerName: string('Display name, e.g. corp-messenger'),
        endpoint: string('Signed JSON envelope endpoint for external providers'),
        apiKeyEnv: string('Env variable name holding the HMAC secret; only AGIL_INTEGRATION_* is accepted'),
        timeoutMs: { type: 'integer', minimum: 200, maximum: 30000 },
        fallback: { type: 'string', enum: ['builtin', 'fail'] },
        options: { type: 'object', additionalProperties: true },
      }, ['mode', 'providerName', 'endpoint', 'apiKeyEnv', 'timeoutMs', 'fallback']),
      ProvidersConfig: object({
        chat: ref('ProviderSlot'), files: ref('ProviderSlot'), stt: ref('ProviderSlot'),
        notifications: ref('ProviderSlot'), recording: ref('ProviderSlot'), backgrounds: ref('ProviderSlot'),
      }),
      ProviderStatus: object({
        slot: { type: 'string', enum: ['chat', 'files', 'stt', 'notifications', 'recording', 'backgrounds'] },
        mode: { type: 'string', enum: ['builtin', 'external', 'disabled'] },
        providerName: string(),
        configured: boolean(),
        available: boolean(),
        fallback: { type: 'string', enum: ['builtin', 'fail'] },
        note: string(),
      }),
      ProvidersResponse: object({ providers: arrayOf('ProviderStatus') }, ['providers']),
      ProviderTestRequest: object({
        slot: { type: 'string', enum: ['chat', 'files', 'stt', 'notifications', 'recording', 'backgrounds'] },
        payload: { type: 'object', additionalProperties: true },
      }, ['slot']),
      ProviderTestResponse: object({
        slot: string(), ok: boolean(), providerName: string(), latencyMs: number(), detail: string(),
      }, ['slot', 'ok', 'providerName', 'latencyMs']),
      BackgroundItem: object({ id: string(), name: string(), url: string() }, ['id', 'name', 'url']),
      BackgroundsResponse: object({ backgrounds: arrayOf('BackgroundItem'), provider: string() }, ['backgrounds', 'provider']),
      AssistantAction: object({
        tool: { type: 'string', enum: ['start_recording', 'stop_recording', 'toggle_mic', 'toggle_camera', 'toggle_screen_share', 'raise_hand', 'send_chat', 'open_chat', 'open_files', 'open_participants', 'open_notes', 'open_settings', 'set_blur', 'minimize', 'restore', 'request_fullscreen', 'open_new_tab', 'copy_invite_link'] },
        args: { type: 'object', additionalProperties: true },
      }, ['tool']),
      AssistantSpotlight: object({ target: string(), text: string(), step: { type: 'integer' } }, ['target', 'text']),
      AssistantReply: object({
        id: string(), text: string(), actions: arrayOf('AssistantAction'),
        spotlight: arrayOf('AssistantSpotlight'),
        securityPolicy: object({ version: string(), environment: { type: 'string', enum: ['production', 'test'] } }, ['version', 'environment']),
        source: { type: 'string', enum: ['local', 'external'] }, ts: number(),
      }, ['id', 'text', 'actions', 'spotlight', 'source', 'ts']),
      InCallAssistantState: object({
        participants: { type: 'integer' }, recording: boolean(),
        mic: { type: 'string', enum: ['on', 'off'] }, camera: { type: 'string', enum: ['on', 'off'] },
        screenSharing: boolean(), chatOpen: boolean(), layoutMode: string(), qualityTier: string(),
      }),
      InCallAssistantRequest: object({
        text: string('1..2000 characters'),
        locale: { type: 'string', enum: ['ru', 'en'] },
        state: ref('InCallAssistantState'),
      }, ['text']),
      InCallAssistantSettings: object({
        config: { type: 'object', additionalProperties: true }, endpointConfigured: boolean(), apiKeyConfigured: boolean(),
      }, ['config', 'endpointConfigured', 'apiKeyConfigured']),
      ScaleConfig: { type: 'object', additionalProperties: true,
        description: 'TenantConfig.scale: mediaMode, signaling, sfu, turn pool, webinar, streaming, cdn',
        properties: { turn: arrayOf('ScaleTurnServer') } },
      ScaleTurnServer: object({
        id: string('Relay ID; Core uses the exact tenant and relay ID to find a coturn signing key'),
        nodeId: string('Enrolled node ID; if set, only advertise this TURN relay while the node module is available'),
        urls: { type: 'array', items: { type: 'string' } },
        credentialMode: { type: 'string', enum: ['static', 'rest'], default: 'static' },
        username: string('Static TURN username'),
        credentialEnv: string('Environment variable name for the static TURN password'),
        region: string(),
        weight: number(),
      }, ['id', 'urls', 'username', 'credentialEnv', 'region', 'weight']),
      ScaleClusterNode: object({ id: string(), url: string(), region: string(), weight: number(), healthy: { type: ['boolean', 'null'] }, note: string() }, ['id', 'url', 'region', 'weight']),
      ScaleTurnStatus: object({ id: string(), nodeId: string(), automatic: boolean('Derived from a verified node report'), nodeAvailable: boolean('Eligibility based on the enrolled node and TURN module reports'), nodeState: { type: 'string', enum: turnNodeStates, description: 'Readiness or reason Core excludes the bound node from ICE' }, urls: { type: 'array', items: { type: 'string' } }, region: string(), weight: number(), usernameConfigured: boolean(), credentialConfigured: boolean(), credentialMode: { type: 'string', enum: ['static', 'rest'] } }, ['id', 'urls', 'region', 'weight', 'usernameConfigured', 'credentialConfigured']),
      ParticipantCapacity: object({
        effectiveMaxParticipants: number('Effective join cap: min(room, scale, profile participants, sfu.maxParticipants)'),
        limit: { type: 'string', enum: ['room', 'scale', 'profile', 'sfu'], description: 'Binding limit; ties prefer profile → sfu → scale → room' },
        profile: { type: 'string', enum: ['low', 'standard', 'high'] },
        profileParticipants: number('Participants the effective capacity profile supports'),
        roomMaxParticipants: number(),
        scaleMaxParticipants: number(),
        sfuMaxParticipants: number(),
      }, ['effectiveMaxParticipants', 'limit', 'profile', 'profileParticipants', 'roomMaxParticipants', 'scaleMaxParticipants', 'sfuMaxParticipants']),
      MediaProcessingPolicy: object({
        mode: { type: 'string', enum: ['client-only', 'server-assisted'] },
        video: boolean(), audio: boolean(), egress: boolean(), transcoding: boolean(),
        provider: { type: 'string', enum: ['none', 'livekit-egress', 'external'] },
      }, ['mode', 'video', 'audio', 'egress', 'transcoding', 'provider']),
      MediaProcessingSummary: object({
        mode: string(), serverProcessingActive: boolean(), sfuForwardingOnly: boolean(),
        egressConfigured: boolean(), misconfigured: boolean(),
        e2eeConfigured: boolean(), e2eeActive: boolean(),
      }, ['mode', 'serverProcessingActive', 'sfuForwardingOnly', 'egressConfigured', 'misconfigured']),
      MediaProcessingStatus: object({
        policy: ref('MediaProcessingPolicy'), serverProcessingActive: boolean(), sfuForwardingOnly: boolean(),
        egressConfigured: boolean(), misconfigured: boolean(),
        e2eeConfigured: boolean(), e2eeActive: boolean(), e2eeConflict: boolean(), note: string(),
      }, ['policy', 'serverProcessingActive', 'sfuForwardingOnly', 'egressConfigured', 'misconfigured', 'e2eeConfigured', 'e2eeActive', 'e2eeConflict', 'note']),
      ScaleStatusResponse: object({
        config: ref('ScaleConfig'),
        mediaMode: { type: 'string', enum: ['mesh', 'sfu', 'broadcast'] },
        cluster: object({ nodeId: string(), nodes: arrayOf('ScaleClusterNode'), strategy: string(), redisConfigured: boolean(), stickySessions: boolean() }),
        turn: arrayOf('ScaleTurnStatus'),
        sfuConfigured: boolean(),
        sfuProfile: { type: 'string', enum: ['low', 'standard', 'high'], description: 'Effective gallery capacity profile (AGIL_SFU_PROFILE wins over scale.sfu.capacityProfile; default standard)' },
        sfuCapacity: object({
          profile: { type: 'string', enum: ['low', 'standard', 'high'] },
          vcpu: string('Planning vCPU range (documentation only)'),
          memoryGb: number('Planning RAM in GB (documentation only)'),
          participants: number('Participants one node of this size should carry'),
          remoteVideosPerClient: number('Remote videos a client subscribes per page above 8 participants'),
          note: string('Sizing caveat; not a benchmark'),
        }, ['profile', 'vcpu', 'memoryGb', 'participants', 'remoteVideosPerClient', 'note']),
        effectiveMaxParticipants: number('Effective room cap for a default group room: min(scale.maxParticipants, profile participants, sfu.maxParticipants)'),
        capacity: ref('ParticipantCapacity'),
        mediaProcessing: ref('MediaProcessingSummary'),
        webinarEnabled: boolean(),
        streamingProvider: string(),
        limitations: { type: 'array', items: { type: 'string' } },
      }, ['config', 'mediaMode', 'cluster', 'turn', 'sfuConfigured', 'effectiveMaxParticipants', 'capacity', 'mediaProcessing', 'webinarEnabled', 'streamingProvider', 'limitations']),
      ClusterStatusResponse: object({
        nodeId: string(), nodes: arrayOf('ScaleClusterNode'), strategy: string(),
        redisConfigured: boolean(), stickySessions: boolean(), multiNodeActive: boolean(),
        cluster: ref('ClusterIdentity'),
        leader: ref('ClusterLeaderStatus'),
        lease: ref('LeaderLeaseStatus'),
        ha: ref('ClusterHaStatus'),
        failover: ref('ClusterFailoverStatus'),
        standbys: arrayOf('StandbyCoreSummary'),
        enrolledNodes: arrayOf('NodeSummary'),
        counts: ref('ClusterNodeCounts'),
        limitations: { type: 'array', items: { type: 'string' } },
      }, ['nodeId', 'nodes', 'strategy', 'redisConfigured', 'stickySessions', 'multiNodeActive']),
      ClusterLeaderStatus: object({
        id: { type: ['string', 'null'], description: 'Current leader Core id; null when no lease is held' },
        since: { type: ['number', 'null'], description: 'Epoch ms when the leader acquired the lease' },
        heartbeatAt: { type: ['number', 'null'], description: 'Epoch ms of the last lease renewal/heartbeat' },
        self: boolean('True when this Core is the leader'),
      }, ['id', 'since', 'heartbeatAt', 'self']),
      LeaderLeaseStatus: object({
        mode: { type: 'string', enum: ['standalone', 'redis'] },
        held: boolean('This Core holds a locally valid, fenced lease'),
        ttlMs: number('Configured lease TTL (0 in standalone mode)'),
        ttlRemainingMs: { type: ['number', 'null'], description: 'Remaining TTL of the shared lease key' },
        validUntil: { type: ['number', 'null'], description: 'Local fencing deadline (epoch ms)' },
        heartbeatAt: { type: ['number', 'null'] },
        redisConnected: boolean(),
        renewalFailures: number('Consecutive failed renewals'),
        reason: string('Human-readable lease state'),
      }, ['mode', 'held', 'ttlMs', 'ttlRemainingMs', 'validUntil', 'heartbeatAt', 'redisConnected', 'renewalFailures', 'reason']),
      ClusterHaStatus: object({
        mode: { type: 'string', enum: ['standalone', 'redis'] },
        nodeId: string('Stable id of this Core process'),
        registryLockHeld: boolean('Node-registry write lock is held by this Core'),
        registryLockTtlRemainingMs: { type: ['number', 'null'] },
        roomStateReplicated: { type: 'boolean', const: false },
        tenantConfigReplicated: { type: 'boolean', const: false },
        nodeRegistryReplicated: { type: 'boolean', const: false },
        stateStore: { type: 'string', enum: ['local-file'] },
      }, ['mode', 'nodeId', 'registryLockHeld', 'registryLockTtlRemainingMs', 'roomStateReplicated', 'tenantConfigReplicated', 'nodeRegistryReplicated', 'stateStore']),
      ClusterFailoverStatus: object({
        detected: boolean(),
        previousLeaderId: { type: ['string', 'null'] },
        changedAt: { type: ['number', 'null'] },
        message: string('Operator-facing failover notice'),
      }, ['detected', 'previousLeaderId', 'changedAt', 'message']),
      TurnTestResponse: object({ id: string(), ok: boolean(), latencyMs: number(), detail: string() }, ['id', 'ok', 'latencyMs', 'detail']),
      ClusterIdentity: object({
        id: string('Cluster id'),
        role: { type: 'string', enum: ['leader', 'standby'] },
        version: string(),
      }, ['id', 'role', 'version']),
      NodeCapacity: object({
        maxRooms: number(), maxParticipants: number(), bandwidthMbps: number(),
      }, ['maxRooms', 'maxParticipants', 'bandwidthMbps']),
      NodeCapacityInput: object({ maxRooms: number(), maxParticipants: number(), bandwidthMbps: number() }),
      NodeMetricsInput: object({
        cpuPercent: { type: 'number', minimum: 0, maximum: 100, description: 'CPU utilisation % (fractions allowed)' },
        memoryPercent: { type: 'number', minimum: 0, maximum: 100, description: 'Memory utilisation % (fractions allowed)' },
        load1: { type: 'number', minimum: 0, maximum: 1000000, description: '1-minute load average' },
        activeRooms: { type: 'integer', minimum: 0, maximum: 1000000 },
        participants: { type: 'integer', minimum: 0, maximum: 10000000 },
        bandwidthMbps: { type: 'number', minimum: 0, maximum: 1000000, description: 'Aggregate media bandwidth (Mbps)' },
        uptimeSec: { type: 'number', minimum: 0, maximum: 315360000, description: 'Node uptime in seconds (fractions allowed)' },
        version: { type: 'string', minLength: 1, maxLength: 32, description: 'Node agent build/version' },
        reportedAt: { type: 'integer', minimum: 0, description: 'Client capture time (epoch ms); Core receipt time when omitted' },
      }),
      NodeMetrics: object({
        cpuPercent: { type: 'number', minimum: 0, maximum: 100, description: 'CPU utilisation %' },
        memoryPercent: { type: 'number', minimum: 0, maximum: 100, description: 'Memory utilisation %' },
        load1: { type: 'number', minimum: 0, maximum: 1000000, description: '1-minute load average' },
        activeRooms: { type: 'integer', minimum: 0, maximum: 1000000 },
        participants: { type: 'integer', minimum: 0, maximum: 10000000 },
        bandwidthMbps: { type: 'number', minimum: 0, maximum: 1000000 },
        uptimeSec: { type: 'number', minimum: 0, maximum: 315360000, description: 'Node uptime in seconds (fractions allowed)' },
        version: { type: 'string', maxLength: 32 },
        reportedAt: { type: 'integer', minimum: 0, description: 'Client-reported capture time (epoch ms), or Core receipt time' },
      }, ['reportedAt']),
      NodeModule: object({
        id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$', description: 'Catalog or operator-managed inventory id' },
        kind: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$', description: 'Catalog or operator-defined classification' },
        name: string('Display name'),
        version: string('Installed module/agent version; empty = not reported'),
        image: string('Docker image reported by the node; reserved catalog ids require their catalog repository'),
        status: { type: 'string', enum: ['running', 'stopped', 'error', 'installing', 'unknown'] },
        health: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy', 'unknown'] },
        autoStart: boolean('Docker restart policy, when configurable by this agent'),
        lifecycleContainerId: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Exact Docker ID for an eligible operator-managed Compose service or custom container' },
        sfuDrainState: { type: 'string', enum: ['available', 'requested', 'restart_requested'], description: 'Graceful stop eligibility or an active stop/restart for a running external SFU' },
        templateRemovable: { type: 'boolean', enum: [true], description: 'The node confirms this isolated container was installed from a local template and can be removed' },
        ports: { type: 'array', maxItems: 8, items: { type: 'integer', minimum: 1, maximum: 65535 }, description: 'Published container ports (informational)' },
        updatedAt: number('Epoch ms of the last state update (Core receipt time when omitted)'),
        lastError: string('Last agent-reported error (bounded, never a secret)'),
      }, ['id', 'kind', 'name', 'version', 'image', 'status', 'health', 'ports', 'updatedAt']),
      NodeCustomModuleTemplate: object({
        id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$', description: 'Unique custom template id; catalog ids are reserved' },
        image: string('Locally approved image with an explicit registry and sha256 manifest digest'),
        cached: boolean('Docker confirms this exact repository digest is present on the node'),
        installable: { type: 'boolean', enum: [true], description: 'Local operator approval and image compatibility for isolated installation' },
        blockedReason: { type: 'string', enum: ['image_not_cached', 'image_incompatible', 'inspection_failed', 'environment_unavailable', 'storage_unavailable', 'network_unavailable'], description: 'Reason an opted-in local template cannot be installed' },
        storage: { type: 'string', enum: ['read_only'], description: 'Approved read-only local volume profile mounted at /agil-data' },
        profileChanged: { type: 'boolean', enum: [true], description: 'An applied local profile differs from the approved profile on the same cached image; no local values are reported' },
        privatePorts: { type: 'array', minItems: 1, maxItems: 8, items: object({ port: { type: 'integer', minimum: 1, maximum: 65535 },
          protocol: { type: 'string', enum: ['tcp', 'udp'] } }, ['port', 'protocol']), description: 'Declared ports on a node-local isolated network, without host publication' },
        resources: { ...object({
          cpuMillicores: { type: 'integer', minimum: 100, maximum: 8000 },
          memoryMiB: { type: 'integer', minimum: 64, maximum: 8192 },
          pidsLimit: { type: 'integer', minimum: 16, maximum: 512 },
        }, ['cpuMillicores', 'memoryMiB', 'pidsLimit']), additionalProperties: false },
      }, ['id', 'image', 'cached']),
      NodeModuleLogWindow: object({
        status: { type: 'string', enum: ['ready', 'unavailable'] },
        events: { type: 'array', maxItems: 16, items: object({
          time: number('Docker log timestamp in epoch milliseconds'),
          level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
          stream: { type: 'string', enum: ['stdout', 'stderr'] },
        }, ['time', 'level', 'stream']) },
      }, ['status', 'events']),
      NodeModuleReport: object({
        id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$', description: 'Catalog or operator-managed inventory id' },
        kind: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$', description: 'Optional classification for operator-managed containers' },
        image: string('Docker image reference; reserved catalog ids require their catalog repository'),
        status: { type: 'string', enum: ['running', 'stopped', 'error', 'installing', 'unknown'] },
        name: string(),
        version: string(),
        health: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy', 'unknown'] },
        autoStart: boolean('Docker restart policy, when configurable by this agent'),
        lifecycleContainerId: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Exact Docker ID for an eligible operator-managed Compose service or custom container' },
        sfuDrainState: { type: 'string', enum: ['available', 'requested'], description: 'Graceful stop eligibility or signal reservation for a running external SFU' },
        templateRemovable: { type: 'boolean', enum: [true], description: 'The node confirms this isolated container was installed from a local template and can be removed' },
        logs: ref('NodeModuleLogWindow'),
        ports: { type: 'array', maxItems: 8, items: { type: 'integer', minimum: 1, maximum: 65535 } },
        updatedAt: { type: 'integer', minimum: 0, description: 'Agent capture time (epoch ms); Core receipt time when omitted' },
        lastError: string(),
      }, ['id', 'image', 'status']),
      NodeModuleCommand: object({
        id: string('Server-generated command id (`nmc_…`)'),
        moduleId: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' },
        action: { type: 'string', enum: nodeModuleActions },
        image: string('Preset image or node-approved immutable digest, present only for install'),
        targetContainerId: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Exact Docker target for operator-managed Compose service, custom lifecycle or template replacement' },
        createdAt: number('Epoch ms when the command was queued'),
        expiresAt: number('Epoch ms after which the command is not delivered/acked'),
      }, ['id', 'moduleId', 'action', 'createdAt', 'expiresAt']),
      NodeModuleResult: object({
        commandId: string('Id of the delivered command'),
        ok: boolean(),
        status: { type: 'string', enum: ['running', 'stopped', 'error', 'installing', 'unknown'] },
        error: string('Agent error text (bounded); absent when ok=true'),
      }, ['commandId', 'ok', 'status']),
      NodeModuleActionRequest: object({
        action: { type: 'string', enum: nodeModuleActions },
        targetContainerId: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Exact Docker ID for scoped Compose or custom actions and replacement of a running isolated template container' },
        expectedImage: string('Required for a custom template install; must match the last fresh approved digest exactly'),
      }, ['action']),
      NodeModuleActionResponse: object({ command: ref('NodeModuleCommand') }, ['command']),
      NodeModuleEnvHint: object({
        name: string('Environment variable name (values are never sent to the Core)'),
        required: boolean(),
        secret: boolean('Value is a node-local secret and must not leave the node'),
        description: string(),
      }, ['name']),
      NodeModuleCatalogEntry: object({
        id: { type: 'string', enum: ['egress', 'stt', 'recorder', 'turn', 'sip'] },
        kind: { type: 'string', enum: ['egress', 'stt', 'recorder', 'turn', 'sip'] },
        name: string(),
        description: string(),
        image: string('Canonical image the Core installs'),
        repository: string('Allowlisted Docker repository (tag/digest bumps allowed)'),
        ports: { type: 'array', maxItems: 8, items: { type: 'integer', minimum: 1, maximum: 65535 } },
        env: { type: 'array', maxItems: 16, items: ref('NodeModuleEnvHint') },
        actions: { type: 'array', items: { type: 'string', enum: nodeModuleActions } },
      }, ['id', 'kind', 'name', 'description', 'image', 'repository', 'ports', 'env', 'actions']),
      NodeModuleCatalogResponse: object({
        catalog: arrayOf('NodeModuleCatalogEntry'),
        actions: { type: 'array', items: { type: 'string', enum: nodeModuleActions } },
      }, ['catalog', 'actions']),
      NodeModuleAvailability: {
        type: 'string', enum: ['available', 'unavailable', 'disabled'],
        description: 'Latest online heartbeat: Docker inventory available, unavailable, or disabled by the agent.',
      },
      NodeModulesResponse: object({
        nodeId: string(),
        modules: arrayOf('NodeModule'),
        moduleAvailability: ref('NodeModuleAvailability'),
        moduleTemplates: { type: 'array', maxItems: 16, items: ref('NodeCustomModuleTemplate') },
        logWindows: { type: 'array', maxItems: 4, items: { allOf: [
          ref('NodeModuleLogWindow'), object({ moduleId: string('Module identifier') }, ['moduleId']),
        ] } },
        inventoryStale: boolean('The last inventory exists but is expired or was invalidated'),
        pendingCommands: arrayOf('NodeModuleCommand'),
        inFlightCommands: arrayOf('NodeModuleCommand'),
        failures: { type: 'array', items: object({
          moduleId: string(),
          action: { type: 'string', enum: nodeModuleActions },
          reason: { type: 'string', enum: ['delivery_expired', 'result_expired', 'target_changed'] },
          error: string(),
        }, ['moduleId', 'action']) },
      }, ['nodeId', 'modules', 'pendingCommands']),
      NodeTurnEndpoint: object({
        ip: { type: 'string', format: 'ipv4' },
        port: { type: 'integer', minimum: 1, maximum: 65_535 },
        tlsPort: { type: 'integer', minimum: 1, maximum: 65_535 },
        tlsHostname: { type: 'string', format: 'hostname', maxLength: 253, description: 'Optional certificate DNS name. Requires tlsPort.' },
        credentialMode: { type: 'string', enum: ['static', 'rest'] },
      }, ['ip', 'port']),
      NodeSummary: object({
        id: string(),
        role: { type: 'string', enum: ['sfu', 'turn', 'stun', 'all'] },
        features: { type: 'array', items: { type: 'string' } },
        capacity: ref('NodeCapacity'),
        status: { type: 'string', enum: ['online', 'offline', 'draining', 'disabled'] },
        tenantId: string(),
        name: string(),
        endpoint: string('Advertised base URL (informational; not probed yet)'),
        healthPath: string(),
        region: string(),
        version: string(),
        metrics: ref('NodeMetrics'),
        sfuReady: boolean('Fresh readiness of the bundled SFU; false when the feature is disabled, otherwise omitted before its first report'),
        turnReady: boolean('Fresh readiness of bundled coturn; omitted before its first report'),
        turnEndpoint: ref('NodeTurnEndpoint'),
        automaticTurnVerified: boolean('Core verified the automatic TURN signing key for the ready endpoint'),
        modules: { ...arrayOf('NodeModule'), description: 'Last reported module inventory; absent until first report, [] = none installed' },
        inventoryStale: boolean('The last inventory exists but is expired or was invalidated'),
        availableModules: {
          type: 'array', items: { type: 'string', enum: nodeModuleKinds },
          description: 'Allowed, running modules with usable health from a fresh inventory on an online node.',
        },
        disabledModules: { type: 'array', items: { type: 'string', enum: nodeModuleKinds } },
        moduleAvailability: ref('NodeModuleAvailability'),
        enabled: boolean(),
        drain: boolean(),
        createdAt: number(),
        registeredAt: number(),
        lastSeenAt: { type: ['number', 'null'] },
        keyExpiresAt: { type: ['number', 'null'], description: 'Node key expiry (epoch ms); null = no expiry' },
        keyRotatedAt: { type: ['number', 'null'], description: 'Last admin key rotation (epoch ms)' },
      }, ['id', 'role', 'features', 'capacity', 'status', 'tenantId', 'name', 'endpoint', 'healthPath', 'region', 'version', 'enabled', 'drain', 'createdAt', 'registeredAt', 'lastSeenAt', 'keyExpiresAt', 'keyRotatedAt']),
      StandbyCoreSummary: object({
        id: string(), tenantId: string(), clusterId: string(), version: string(), region: string(),
        registeredAt: number(), lastSeenAt: { type: ['number', 'null'] },
      }, ['id', 'tenantId', 'clusterId', 'version', 'region', 'registeredAt', 'lastSeenAt']),
      EnrollmentTokenSummary: object({
        id: string(),
        kind: { type: 'string', enum: ['core', 'node'] },
        role: { type: 'string', enum: ['leader', 'standby', 'sfu', 'turn', 'stun', 'all'] },
        features: { type: 'array', items: { type: 'string' } },
        expiresAt: number('Epoch ms'),
        uses: number(), remainingUses: number(), createdBy: string(), createdAt: number(),
        revokedAt: { type: ['number', 'null'] },
        label: string(),
        status: { type: 'string', enum: ['active', 'used', 'expired', 'revoked'] },
      }, ['id', 'kind', 'role', 'features', 'expiresAt', 'uses', 'remainingUses', 'createdBy', 'createdAt', 'revokedAt', 'label', 'status']),
      EnrollmentTokenCreateRequest: object({
        kind: { type: 'string', enum: ['core', 'node'] },
        role: { type: 'string', enum: ['leader', 'standby', 'sfu', 'turn', 'stun', 'all'] },
        features: { type: 'array', items: { type: 'string' } },
        ttlSec: number('1..2592000 (default 3600)'),
        uses: number('1..100 (default 1)'),
        label: string(),
      }, ['kind']),
      EnrollmentTokenCreatedResponse: object({
        token: string('Plaintext token — returned once; never persisted'),
        enrollment: ref('EnrollmentTokenSummary'),
      }, ['token', 'enrollment']),
      EnrollmentTokenListResponse: object({ tokens: arrayOf('EnrollmentTokenSummary') }, ['tokens']),
      ClusterJoinRequest: object({
        token: string('One-time `core` enrollment token (agil_enr_…)'),
        nodeId: string('Standby Core id (generated when omitted)'),
        clusterId: string('Expected cluster id (advisory)'),
        version: string(),
        region: string(),
      }, ['token']),
      NodeRegisterRequest: object({
        token: string('One-time `node` enrollment token (agil_enr_…)'),
        nodeId: string('Stable node id (generated when omitted)'),
        role: { type: 'string', enum: ['sfu', 'turn', 'stun', 'all'] },
        name: string(),
        features: { type: 'array', items: { type: 'string' } },
        capacity: ref('NodeCapacityInput'),
        endpoint: string('http(s)/ws(s) URL; credentials and metadata hosts are rejected'),
        healthPath: string(),
        region: string(),
        version: string(),
        keyTtlSec: number('1..7776000; omitted = AGIL_NODE_KEY_TTL_SEC default (0 = no expiry)'),
      }, ['token', 'role']),
      NodeHeartbeatRequest: object({
        capacity: ref('NodeCapacityInput'),
        sfuReady: boolean('Local readiness of the bundled SFU on this node'),
        turnReady: boolean('Local readiness of bundled coturn, independent of Docker module inventory'),
        turnEndpoint: ref('NodeTurnEndpoint'),
        turnEndpointProof: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Proof of possession for automatic TURN publication, never returned in responses' },
        metrics: ref('NodeMetricsInput'),
        status: { type: 'string', enum: ['online', 'offline'] },
        modules: { ...arrayOf('NodeModuleReport'), description: 'Full module inventory snapshot; omitted = keep previous, [] = none installed' },
        moduleAvailability: ref('NodeModuleAvailability'),
        moduleTemplates: { type: 'array', maxItems: 16, items: ref('NodeCustomModuleTemplate') },
        moduleResults: { ...arrayOf('NodeModuleResult'), description: 'Acknowledgements for commands delivered on an earlier heartbeat' },
      }),
      EnrollmentTokenRevokeResponse: object({
        revoked: boolean(), id: string(), enrollment: ref('EnrollmentTokenSummary'),
      }, ['revoked', 'id', 'enrollment']),
      NodeRegistrationResponse: object({
        node: ref('NodeSummary'),
        nodeKey: string('Plaintext per-node key — returned once'),
        keyExpiresAt: { type: ['number', 'null'] },
        heartbeatIntervalSec: number(),
        cluster: ref('ClusterIdentity'),
      }, ['node', 'nodeKey', 'keyExpiresAt', 'heartbeatIntervalSec', 'cluster']),
      NodeHeartbeatResponse: object({
        node: ref('NodeSummary'), drain: boolean(), heartbeatIntervalSec: number(), serverTime: number(),
        moduleCommands: { ...arrayOf('NodeModuleCommand'), description: 'Commands to execute now; each is delivered exactly once' },
      }, ['node', 'drain', 'heartbeatIntervalSec', 'serverTime', 'moduleCommands']),
      NodeRotateKeyRequest: object({
        keyTtlSec: number('1..7776000; omitted = AGIL_NODE_KEY_TTL_SEC default'),
      }),
      NodeUpdateRequest: object({
        name: string(),
        role: { type: 'string', enum: ['sfu', 'turn', 'stun', 'all'] },
        features: { type: 'array', items: { type: 'string' } },
        moduleEnabled: { type: 'object', propertyNames: { enum: nodeModuleKinds }, additionalProperties: { type: 'boolean' } },
        capacity: ref('NodeCapacityInput'),
        endpoint: string('http(s)/ws(s) URL; credentials and metadata hosts are rejected'),
        healthPath: string(),
        region: string(),
      }),
      NodeDisableRequest: object({ disabled: boolean('Default true') }),
      NodeDrainRequest: object({ drain: boolean('Default true') }),
      NodeKeyRotationResponse: object({
        node: ref('NodeSummary'),
        nodeKey: string('New plaintext per-node key — returned once'),
        keyExpiresAt: { type: ['number', 'null'] },
        heartbeatIntervalSec: number(),
      }, ['node', 'nodeKey', 'keyExpiresAt', 'heartbeatIntervalSec']),
      NodeListResponse: object({
        nodes: arrayOf('NodeSummary'),
        total: number('Present when limit/offset is used'),
        limit: number(),
        offset: number(),
      }, ['nodes']),
      NodeResponse: object({ node: ref('NodeSummary') }, ['node']),
      NodeDeleteResponse: object({ deleted: boolean(), id: string() }, ['deleted', 'id']),
      ClusterNodeCounts: object({
        nodes: number(), online: number(), offline: number(), draining: number(), disabled: number(), standbys: number(),
      }, ['nodes', 'online', 'offline', 'draining', 'disabled', 'standbys']),
      ClusterRegistryStatus: object({
        cluster: ref('ClusterIdentity'),
        leader: ref('ClusterLeaderStatus'),
        lease: ref('LeaderLeaseStatus'),
        ha: ref('ClusterHaStatus'),
        failover: ref('ClusterFailoverStatus'),
        standbys: arrayOf('StandbyCoreSummary'),
        enrolledNodes: arrayOf('NodeSummary'),
        counts: ref('ClusterNodeCounts'),
        limitations: { type: 'array', items: { type: 'string' } },
      }, ['cluster', 'leader', 'lease', 'ha', 'failover', 'standbys', 'enrolledNodes', 'counts', 'limitations']),
      ClusterJoinResponse: object({
        cluster: ref('ClusterIdentity'),
        leader: object({ nodeId: string(), version: string(), publicOrigin: string() }, ['nodeId', 'version', 'publicOrigin']),
        standby: ref('StandbyCoreSummary'),
        token: object({ id: string(), remainingUses: number() }, ['id', 'remainingUses']),
      }, ['cluster', 'leader', 'standby', 'token']),
    },
  };
  if (!includeAdmin) {
    const schemas = allSchemas.schemas as Record<string, unknown>;
    for (const name of ADMIN_ONLY_SCHEMAS) delete schemas[name];
  }
  return allSchemas;
}

function pullIngressPaths(format: 'SRT' | 'HLS'): Json {
  return {
    post: op({
      tags: ['Admin'], summary: `Start a tenant-assigned ${format} pull into the flow room`,
      description: 'The flow selects an operator-registered private sourceId. Core returns status without the source address.',
      security: API_KEY_SECURITY, parameters: [pathParam('flowId', 'Flow id')],
      responses: {
        '201': { description: '`{roomId, sourceId, status}`' },
        '404': { description: 'Managed flow, SFU room or registered source not found' },
        '409': { description: 'Disabled flow, existing receiver, or Core is not leader' },
        '503': { description: 'Shared storage or LiveKit Ingress unavailable' },
      },
    }),
    get: op({
      tags: ['Admin'], summary: `Read managed ${format} pull status without source coordinates`,
      security: API_KEY_SECURITY, parameters: [pathParam('flowId', 'Flow id')],
      responses: {
        '200': { description: '`{roomId, sourceId, status}`' },
        '404': { description: 'Managed flow not found' },
        '409': { description: 'Core is not leader' },
      },
    }),
    delete: op({
      tags: ['Admin'], summary: `Stop the managed ${format} session while keeping its flow`,
      security: API_KEY_SECURITY, parameters: [pathParam('flowId', 'Flow id')],
      responses: {
        '200': { description: '`{revoked:true}`' },
        '404': { description: 'Managed flow not found' },
        '409': { description: 'Core is not leader or revocation is pending' },
        '503': { description: 'Shared storage or LiveKit Ingress unavailable' },
      },
    }),
  };
}

function paths(includeAdmin: boolean): Json {
  const roomsId = pathParam('roomId', 'Room id');
  const voiceChannelId = pathParam('channelId', 'Voice channel id');
  const tenantId = pathParam('tenantId', 'Tenant id');
  const all: Json = {
    '/scim/v2/Users': {
      get: op({
        tags: ['SCIM'],
        summary: 'List SCIM users (startIndex/count/filter userName|displayName|emails.value)',
        description: 'Auth: `Authorization: Bearer $AGIL_SCIM_TOKEN`, tenant: `x-tenant-id`. Returns SCIM ListResponse.',
        parameters: [queryParam('startIndex', '1-based start (default 1)', 'integer'), queryParam('count', 'Page size 0..1000 (default 100)', 'integer'), queryParam('filter', 'attr eq "value"'), headerParam('x-tenant-id', 'Tenant id')],
        responses: { '200': scimJson('ScimListResponse', 'SCIM ListResponse'), '401': scimJson('ScimError', 'Invalid token'), '501': scimJson('ScimError', 'SCIM disabled') },
      }),
      post: op({
        tags: ['SCIM'],
        summary: 'Create a SCIM user (duplicate userName → 409; active=false = soft deactivation)',
        requestBody: scimBody('ScimUser', { userName: 'alice@example.com', name: { givenName: 'Alice', familyName: 'Smith' }, emails: [{ value: 'alice@example.com', primary: true }], active: true }),
        responses: { '201': scimJson('ScimUser', 'Created user (Location header)'), '409': scimJson('ScimError', 'Duplicate userName') },
      }),
    },
    '/scim/v2/Users/{id}': {
      get: op({ tags: ['SCIM'], summary: 'Read a SCIM user', parameters: [pathParam('id', 'User id')], responses: { '200': scimJson('ScimUser', 'User'), '404': scimJson('ScimError', 'Not found') } }),
      put: op({ tags: ['SCIM'], summary: 'Replace a SCIM user', parameters: [pathParam('id', 'User id')], requestBody: scimBody('ScimUser', { userName: 'alice@example.com', name: { givenName: 'Alicia' }, active: true }), responses: { '200': scimJson('ScimUser', 'Updated') } }),
      patch: op({ tags: ['SCIM'], summary: 'SCIM PATCH user (add/replace/remove: active, userName, name.*, emails, roles, externalId)', parameters: [pathParam('id', 'User id')], requestBody: scimBody('ScimPatchRequest', { Operations: [{ op: 'replace', path: 'active', value: false }] }), responses: { '200': scimJson('ScimUser', 'Updated') } }),
      delete: op({ tags: ['SCIM'], summary: 'Delete a SCIM user (204)', parameters: [pathParam('id', 'User id')], responses: { '204': { description: 'Deleted' }, '404': scimJson('ScimError', 'Not found') } }),
    },
    '/scim/v2/Groups': {
      get: op({ tags: ['SCIM'], summary: 'List SCIM groups (filter displayName)', parameters: [queryParam('startIndex', '1-based start', 'integer'), queryParam('count', 'Page size', 'integer'), queryParam('filter', 'displayName eq "value"')], responses: { '200': scimJson('ScimListResponse', 'SCIM ListResponse') } }),
      post: op({ tags: ['SCIM'], summary: 'Create a SCIM group', requestBody: scimBody('ScimGroup', { displayName: 'Engineering', members: [{ value: 'user-id', display: 'Alice' }] }), responses: { '201': scimJson('ScimGroup', 'Created group') } }),
    },
    '/scim/v2/Groups/{id}': {
      get: op({ tags: ['SCIM'], summary: 'Read a SCIM group', parameters: [pathParam('id', 'Group id')], responses: { '200': scimJson('ScimGroup', 'Group'), '404': scimJson('ScimError', 'Not found') } }),
      put: op({ tags: ['SCIM'], summary: 'Replace a SCIM group', parameters: [pathParam('id', 'Group id')], requestBody: scimBody('ScimGroup', { displayName: 'Platform', members: [] }), responses: { '200': scimJson('ScimGroup', 'Updated') } }),
      patch: op({ tags: ['SCIM'], summary: 'SCIM PATCH group (displayName, members)', parameters: [pathParam('id', 'Group id')], requestBody: scimBody('ScimPatchRequest', { Operations: [{ op: 'replace', path: 'displayName', value: 'Platform' }] }), responses: { '200': scimJson('ScimGroup', 'Updated') } }),
      delete: op({ tags: ['SCIM'], summary: 'Delete a SCIM group (204)', parameters: [pathParam('id', 'Group id')], responses: { '204': { description: 'Deleted' } } }),
    },
    '/scim/v2/ServiceProviderConfig': {
      get: op({ tags: ['SCIM'], summary: 'SCIM ServiceProviderConfig (patch/filter supported, bulk/sort/etag not)', responses: { '200': { description: 'SCIM configuration', content: { 'application/scim+json': { schema: { type: 'object', additionalProperties: true } } } } } }),
    },
    '/scim/v2/Schemas': {
      get: op({ tags: ['SCIM'], summary: 'SCIM schemas (User, Group)', responses: { '200': scimJson('ScimListResponse', 'Schemas') } }),
    },
    '/scim/v2/ResourceTypes': {
      get: op({ tags: ['SCIM'], summary: 'SCIM resource types (User, Group)', responses: { '200': scimJson('ScimListResponse', 'Resource types') } }),
    },
    '/v1/auth/oidc/verify': {
      post: op({
        tags: ['Join'],
        summary: 'Verify a corporate OIDC identity JWT (SSO; no tokens issued)',
        description: 'Verifies RS256/ES256 signature against the tenant `integrations.identity.jwksUrl`, checks issuer/audience/exp/nbf and maps claims. Used by SSO joins; the token itself is never logged or audited.',
        requestBody: bodyExample('OidcVerifyRequest', { tenantId: 'demo', identityToken: 'eyJhbGciOiJSUzI1NiIs…' }),
        responses: { '200': json('OidcVerifiedIdentity', 'Verified identity claims') },
      }),
    },
    '/v1/auth/oidc/start': {
      get: op({
        tags: ['Join'],
        summary: 'Start dashboard SSO: state+nonce+PKCE → IdP authorization URL',
        description:
          'Requires `integrations.identity.mode:"oidc"` with issuer/clientId and either explicit endpoints or ' +
          '`discovery:true` (issuer `/.well-known/openid-configuration`, or an explicit `discoveryUrl`); explicit ' +
          'endpoint fields always win over discovered values and serve as fallback when discovery fails. ' +
          'Creates a single-use state (TTL 10 min, in memory), a nonce and an S256 PKCE challenge and returns the ' +
          'authorization URL. For same-origin browser starts it also sets an HttpOnly state-binding cookie ' +
          '(AGIL_OIDC_COOKIE_BINDING, default on) that the callback must present (login-CSRF defense); with ' +
          '`responseMode:"form_post"` the cookie is SameSite=None (Secure in production) for the cross-site POST. ' +
          'No token or secret is returned or logged.',
        parameters: [
          queryParam('tenantId', 'Tenant id (defaults to AGIL_DEFAULT_TENANT)'),
          queryParam('returnTo', 'Same-origin relative path or an absolute URL from AGIL_PUBLIC_ORIGIN / integrations.allowedOrigins (default /dashboard/); backslashes/control characters are rejected'),
        ],
        responses: {
          '200': json('OidcStartResponse', 'Authorization URL + expiry'),
          '400': json('ApiErrorBody', 'Invalid returnTo / tenantId / unsafe OIDC config'),
          '501': json('ApiErrorBody', 'OIDC/SSO is not configured for the tenant (or discovery is required but unavailable)'),
        },
      }),
    },
    '/v1/auth/oidc/callback': {
      get: op({
        tags: ['Join'],
        summary: 'OIDC redirect URI (response_mode=query): code exchange + id_token verification → admin session',
        description:
          'Consumes the single-use state (and the browser-binding cookie when set), exchanges `code` at the token ' +
          'endpoint (`client_secret_post` by default, or `client_secret_basic`; the secret comes from the allowlisted, ' +
          'tenant-bound server env var named by `clientSecretEnv`: AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME> or an ' +
          'AGIL_OIDC_TENANT_SECRETS entry), verifies the id_token against the tenant JWKS (signature, iss, aud/azp, ' +
          'exp/nbf/iat, nonce, optional tenant claim, email allowlist and dashboard admin groups) and redirects (302) ' +
          'to `returnTo#sso_token=<admin session JWT>`. Failures redirect to `returnTo#sso_error=<code>` ' +
          '(`state_invalid`, `state_expired`, `idp_error`, `access_denied`, `invalid_identity_token`, ' +
          '`identity_not_verified`, `identity_not_allowed`, `tenant_mismatch`, `identity_not_configured`, ' +
          '`validation_failed`). Tokens, codes and secrets are never logged.',
        parameters: [
          queryParam('code', 'Authorization code from the IdP'),
          queryParam('state', 'Single-use state returned by /v1/auth/oidc/start'),
          queryParam('error', 'IdP error code (e.g. access_denied)'),
        ],
        responses: {
          '302': { description: 'Redirect with the admin session in the URL fragment, or `#sso_error=<code>`' },
        },
      }),
      post: op({
        tags: ['Join'],
        summary: 'OIDC redirect URI (response_mode=form_post): same flow, parameters in the form body',
        description:
          'OAuth 2.0 Form Post Response Mode: the IdP POSTs `code`/`state`/`error` as ' +
          '`application/x-www-form-urlencoded` (64 KiB bound) to this redirect URI. The state, nonce, PKCE, ' +
          'id_token and binding-cookie checks are identical to the GET callback; every outcome is a redirect, ' +
          'never a JSON body. Requires `integrations.identity.responseMode:"form_post"` and a SameSite=None ' +
          'binding cookie (HTTPS production deployments). A wrong Content-Type or an oversized body answers ' +
          '302 `#sso_error=validation_failed` before the state is consumed.',
        responses: {
          '302': { description: 'Redirect with the admin session in the URL fragment, or `#sso_error=<code>`' },
        },
      }),
    },
    '/v1/auth/oidc/logout': {
      get: op({
        tags: ['Join'],
        summary: 'RP-initiated logout: IdP end_session URL (client_id + post_logout_redirect_uri + state)',
        description:
          'Opt-in corporate logout. When `integrations.identity.endSessionEndpoint` is configured (explicitly or via ' +
          'discovery) returns a 200 with the IdP `end_session_endpoint` URL carrying `client_id`, the registered ' +
          '`post_logout_redirect_uri` (default `<AGIL_PUBLIC_ORIGIN>/v1/auth/oidc/logout/callback`) and a single-use ' +
          '`state` (10 min, in memory). The dashboard navigates there after revoking the local AGIL session. ' +
          '`id_token_hint` is not sent (this server never retains the IdP id_token). ' +
          '501 `identity_not_configured` means RP logout is unavailable; clients keep the local-only logout.',
        parameters: [
          queryParam('tenantId', 'Tenant id (defaults to AGIL_DEFAULT_TENANT)'),
          queryParam('returnTo', 'Dashboard target after the IdP redirects back (validated like the login returnTo)'),
        ],
        responses: {
          '200': json('OidcLogoutResponse', 'IdP RP-initiated logout URL + state expiry'),
          '400': json('ApiErrorBody', 'Invalid tenantId/returnTo or unsafe OIDC logout config'),
          '501': json('ApiErrorBody', 'RP-initiated logout is not configured (no end_session_endpoint)'),
        },
      }),
      post: op({
        tags: ['Join'],
        summary: 'Revoke the current dashboard SSO session (local logout)',
        description:
          'Revokes the signed admin session `jti` in the in-process deny-list until its `exp` and returns 204. ' +
          'Bearer-only (no cookie auth, so no CSRF token is required); an unknown/expired token also returns 204 ' +
          '(idempotent, no token oracle). Revocation is per-process: multi-node deployments need sticky sessions ' +
          'or a shared store. This endpoint does not terminate the IdP session; use GET /v1/auth/oidc/logout for ' +
          'RP-initiated logout when configured.',
        security: BEARER_SECURITY,
        responses: {
          '204': { description: 'Session revoked (or was already invalid)' },
        },
      }),
    },
    '/v1/auth/oidc/logout/callback': {
      get: op({
        tags: ['Join'],
        summary: 'Default post_logout_redirect_uri: validates the logout state and returns to the dashboard',
        description:
          'Consumes the single-use logout `state` issued by GET /v1/auth/oidc/logout and redirects (302) to the ' +
          'dashboard target stored with it (no token or IdP data in the URL). An unknown/expired state redirects ' +
          'to the default dashboard: the local logout has already happened, so this is not an error for the user.',
        parameters: [queryParam('state', 'Single-use logout state returned by the IdP')],
        responses: {
          '302': { description: 'Redirect to the dashboard target' },
        },
      }),
    },
    '/v1/health': { get: op({ tags: ['Public'], summary: 'Liveness + security flags', responses: { '200': json('HealthResponse', 'Server health') } }) },
    '/v1/ready': { get: op({ tags: ['Public'], summary: 'Readiness for API and signaling traffic', responses: {
      '200': json('ReadinessResponse', 'Active Core after room restoration'),
      '503': json('ReadinessResponse', 'Standby, restoring, or shutting down'),
    } }) },
    '/v1/host': { get: op({ tags: ['Public'], summary: 'Resolve the request Host to a tenant + branding (custom domains; fallback to default tenant)', responses: { '200': json('HostInfoResponse', 'Host resolution') } }) },
    '/v1/domain/ask': {
      get: op({
        tags: ['Public'],
        summary: 'Proxy-only on-demand TLS approval hook (Caddy/HAProxy): 200 only for a verified custom domain',
        description:
          'Proxy-only and secret-gated: `AGIL_DOMAIN_ASK_SECRET` is mandatory (empty = 403), the `Host` must be ' +
          'in `AGIL_DOMAIN_ASK_HOSTS` (default loopback/localhost; this distinguishes Caddy’s internal ask from ' +
          'an external request forwarded by Caddy on the same TCP peer), failed secrets use a per-client limiter, ' +
          'and only authenticated approvals are checked against the TCP-peer allowlist ' +
          '`AGIL_DOMAIN_ASK_ALLOW_IPS` and its per-peer rate limit. Deployments must additionally block ' +
          '/v1/domain/ask in the public site block. The response intentionally omits `tenantId`.',
        parameters: [
          queryParam('domain', 'Bare host name to approve'),
          queryParam('key', 'Shared secret (required: AGIL_DOMAIN_ASK_SECRET; empty secret disables the hook)'),
        ],
        responses: {
          '200': json('DomainAskResponse', 'Domain verified and allowed'),
          '400': json('ApiErrorBody', 'Invalid domain'),
          '403': json('ApiErrorBody', 'Caller is not the reverse proxy / secret is invalid'),
          '404': json('ApiErrorBody', 'Unknown/unverified domain'),
          '429': json('ApiErrorBody', 'Too many approval requests'),
        },
      }),
    },
    '/v1/ice': { get: op({ tags: ['Public'], summary: 'Public STUN discovery for RTCPeerConnection', description: 'Returns STUN URLs without credentials. TURN is supplied in the room signaling welcome.', responses: { '200': { description: 'Public STUN config', content: { 'application/json': { schema: { type: 'object', properties: { iceServers: { type: 'array', items: { $ref: '#/components/schemas/IceServer' } } } } } } } } }) },
    '/v1/tenants/{tenantId}/config': {
      get: op({ tags: ['Public'], summary: 'Public tenant config (theme, features)', parameters: [tenantId], responses: { '200': json('ConfigEnvelope', 'Config + etag') } }),
      put: op({ tags: ['Config'], summary: 'Replace tenant config', security: API_KEY_SECURITY, parameters: [tenantId], requestBody: body('TenantConfig'), responses: { '200': json('ConfigEnvelope', 'Updated config') } }),
      patch: op({
        tags: ['Config'], summary: 'Apply a partial update or publish an editor draft', security: API_KEY_SECURITY,
        description: 'An editorDraft replaces the userOverrides and mascotExpressions maps atomically with the rest of the update. Supply baseEtag from the configuration read to refuse publication if another change has been saved. The draft cannot change the custom domain.',
        parameters: [tenantId], requestBody: body({
          anyOf: [
            { $ref: '#/components/schemas/EditorDraftPatch' },
            { $ref: '#/components/schemas/TenantConfigPatch' },
          ],
        }),
        responses: { '200': json('ConfigEnvelope', 'Updated config'), '409': { description: 'Configuration changed since baseEtag' } },
      }),
    },
    '/v1/tenants/{tenantId}/backgrounds': {
      get: op({
        tags: ['Public'],
        summary: 'Virtual background library (builtin config or external provider)',
        parameters: [tenantId],
        responses: { '200': json('BackgroundsResponse', 'Available backgrounds') },
      }),
    },
    '/v1/rooms': {
      post: op({ tags: ['Rooms'], summary: 'Create a room (anonymous allowed when AGIL_ALLOW_ANONYMOUS=1)', security: [{}, ...API_KEY_SECURITY], requestBody: bodyExample('CreateRoomRequest', { tenantId: 'demo', name: 'Планёрка', mode: 'group' }, false), responses: { '200': json('CreateRoomResponse', 'Created room') } }),
    },
    '/v1/tokens': {
      post: op({ tags: ['Rooms'], summary: 'Issue a join token with pinned permissions (admin)', security: API_KEY_SECURITY, requestBody: bodyExample('TokenRequest', { tenantId: 'demo', roomId: 'room-1', participant: { name: 'Анна', role: 'guest' }, permissions: ['chat', 'fileShare', 'screenShare'] }), responses: { '200': json('TokenResponse', 'Issued token') } }),
    },
    '/v1/rooms/{roomId}': {
      get: op({ tags: ['Rooms'], summary: 'Room info + participants', security: API_KEY_SECURITY, parameters: [roomsId], responses: { '200': { description: 'Room snapshot', content: { 'application/json': { schema: { type: 'object', properties: { room: { $ref: '#/components/schemas/RoomInfo' }, participants: { type: 'array', items: { $ref: '#/components/schemas/Participant' } }, createdAt: { type: 'number' } } } } } } } }),
      delete: op({ tags: ['Rooms'], summary: 'Close a room', security: API_KEY_SECURITY, parameters: [roomsId], responses: { '200': { description: 'Closed', content: { 'application/json': { schema: { type: 'object', properties: { closed: { type: 'boolean' } } } } } } } }),
    },
    '/v1/rooms/{roomId}/messages': {
      get: op({
        tags: ['Rooms'], summary: 'Chat history', security: API_KEY_SECURITY,
        description: 'Durable history is readable by the tenant after room closure while it remains in the selected store and has not expired.',
        parameters: [roomsId, queryParam('limit', 'Max messages (1..200)', 'integer')],
        responses: {
          '200': { description: 'Messages', content: { 'application/json': { schema: { type: 'object', properties: { messages: { type: 'array', items: { $ref: '#/components/schemas/ChatMessage' } } } } } } },
          '404': json('ApiErrorBody', 'Room or retained history is not available'),
          '503': json('ApiErrorBody', 'Configured chat storage is unavailable'),
        },
      }),
    },
    '/v1/rooms/{roomId}/calendar.ics': {
      get: op({
        tags: ['Join'],
        summary: 'Download a room as an .ics calendar event (UTC VEVENT)',
        parameters: [roomsId, queryParam('start', 'Event start (ISO 8601, default now)', 'string'), queryParam('durationMin', 'Duration 15..1440 (default 60)', 'integer'), queryParam('download', '1 = attachment', 'string')],
        responses: { '200': { description: 'text/calendar', content: { 'text/calendar': { schema: { type: 'string' } } } } },
      }),
    },
    '/v1/rooms/{roomId}/lobby': {
      get: op({ tags: ['Join'], summary: 'Waiting-room queue (host/moderator or tenant admin key)', security: [{}, ...BEARER_SECURITY, ...API_KEY_SECURITY], parameters: [roomsId], responses: { '200': json('LobbyRequestsResponse', 'Pending join requests') } }),
    },
    '/v1/rooms/{roomId}/lobby/{requestId}': {
      get: op({ tags: ['Join'], summary: 'Poll a waiting-room request (admitted token returned once)', parameters: [roomsId, pathParam('requestId', 'Lobby request id')], responses: { '200': json('LobbyStatusResponse', 'Request status') } }),
      delete: op({ tags: ['Join'], summary: 'Kick/remove a waiting guest from the queue', security: [{}, ...BEARER_SECURITY, ...API_KEY_SECURITY], parameters: [roomsId, pathParam('requestId', 'Lobby request id')], responses: { '200': json('LobbyDecisionResponse', 'Removed from the queue') } }),
    },
    '/v1/rooms/{roomId}/lobby/{requestId}/admit': {
      post: op({ tags: ['Join'], summary: 'Admit a waiting guest (host/moderator or tenant admin key)', security: [{}, ...BEARER_SECURITY, ...API_KEY_SECURITY], parameters: [roomsId, pathParam('requestId', 'Lobby request id')], responses: { '200': json('JoinRoomResponse', 'Admitted guest with a join token') } }),
    },
    '/v1/rooms/{roomId}/lobby/{requestId}/cancel': {
      post: op({ tags: ['Join'], summary: 'Withdraw a pending request with its private cancellation token', parameters: [roomsId, pathParam('requestId', 'Lobby request id')], requestBody: body('LobbyCancelRequest'), responses: { '200': json('LobbyCancelResponse', 'Request cancelled'), '404': json('ApiErrorBody', 'Pending request not found') } }),
    },
    '/v1/rooms/{roomId}/lobby/{requestId}/reject': {
      post: op({ tags: ['Join'], summary: 'Reject a waiting guest (body {reason?})', security: [{}, ...BEARER_SECURITY, ...API_KEY_SECURITY], parameters: [roomsId, pathParam('requestId', 'Lobby request id')], responses: { '200': json('LobbyDecisionResponse', 'Rejected') } }),
    },
    '/v1/rooms/{roomId}/breakouts': {
      get: op({ tags: ['Join'], summary: 'Current breakout plan (host/moderator or tenant admin key)', security: [{}, ...BEARER_SECURITY, ...API_KEY_SECURITY], parameters: [roomsId], responses: { '200': json('BreakoutListResponse', 'Active/last plan') } }),
    },
    '/v1/rooms/{roomId}/breakouts/start': {
      post: op({
        tags: ['Join'],
        summary: 'Start breakout rooms: create child rooms, assign participants, issue child-room tokens',
        security: [{}, ...BEARER_SECURITY, ...API_KEY_SECURITY],
        parameters: [roomsId],
        requestBody: bodyExample('CreateBreakoutRequest', { mode: 'random', count: 2, durationMin: 15, allowReturn: true }),
        responses: { '200': json('BreakoutPlan', 'Created plan (WS: breakout.started + per-participant breakout.assigned)') },
      }),
    },
    '/v1/rooms/{roomId}/breakouts/close': {
      post: op({ tags: ['Join'], summary: 'Close breakout rooms (child rooms removed, plan closed)', security: [{}, ...BEARER_SECURITY, ...API_KEY_SECURITY], parameters: [roomsId], responses: { '200': json('BreakoutPlan', 'Closed plan') } }),
    },
    '/v1/rooms/{roomId}/breakouts/return': {
      post: op({ tags: ['Join'], summary: 'Return to the main room (participant token; 403 when allowReturn=false)', security: BEARER_SECURITY, parameters: [roomsId], responses: { '200': { description: 'Return target', content: { 'application/json': { schema: { type: 'object', properties: { returnToRoomId: { type: 'string' } } } } } } } }),
    },
    '/v1/rooms/{roomId}/polls': {
      get: op({ tags: ['Join'], summary: 'Room polls/Q&A with results and personal selected/voted flags', security: [{}, ...BEARER_SECURITY, ...API_KEY_SECURITY], parameters: [roomsId], responses: { '200': json('PollListResponse', 'Polls') } }),
      post: op({
        tags: ['Join'],
        summary: 'Create a poll or Q&A (host/moderator only)',
        security: [{}, ...BEARER_SECURITY, ...API_KEY_SECURITY],
        parameters: [roomsId],
        requestBody: bodyExample('CreatePollRequest', { question: 'Куда идём на обед?', options: [{ text: 'Пицца' }, { text: 'Суши' }], multiple: false, kind: 'poll' }),
        responses: { '200': json('RoomPoll', 'Created poll (broadcast via poll.updated)') },
      }),
    },
    '/v1/rooms/{roomId}/polls/{pollId}/vote': {
      post: op({ tags: ['Join'], summary: 'Vote in a poll (one vote per participant; multiple optionIds when multiple=true)', security: BEARER_SECURITY, parameters: [roomsId, pathParam('pollId', 'Poll id')], requestBody: bodyExample('VotePollRequest', { optionIds: ['option-id'] }), responses: { '200': json('PollVoteResponse', 'Vote result (accepted or already_voted)') } }),
    },
    '/v1/rooms/{roomId}/polls/{pollId}/close': {
      post: op({ tags: ['Join'], summary: 'Close a poll (host/moderator only)', security: [{}, ...BEARER_SECURITY, ...API_KEY_SECURITY], parameters: [roomsId, pathParam('pollId', 'Poll id')], responses: { '200': json('RoomPoll', 'Closed poll') } }),
    },
    '/v1/rooms/{roomId}/egress/start': {
      post: op({
        tags: ['Rooms'], summary: 'Start egress recording/RTMP/HLS (host/moderator or admin key; 409 when E2EE)',
        description: 'Reuse the same Idempotency-Key and settings when retrying the same start. A completed response is replayed. An uncertain previous dispatch returns `egress_start_outcome_unknown` and does not start another job.',
        parameters: [pathParam('roomId', 'Room id'), {
          ...headerParam('Idempotency-Key', 'Optional unique key for a start intent, scoped to the tenant and room', false),
          schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._~-]+$' },
        }],
        requestBody: bodyExample('EgressStartRequest', { kind: 'recording', layout: 'grid' }),
        responses: {
          '200': json('EgressStartResult', 'Started egress or replay of the original start'),
          '400': json('ApiErrorBody', 'Invalid start settings or Idempotency-Key'),
          '409': json('ApiErrorBody', 'E2EE incompatible, idempotency conflict or uncertain prior start'),
          '503': json('ApiErrorBody', 'Bound Egress node or durable start state unavailable'),
        },
      }),
    },
    '/v1/rooms/{roomId}/egress/{egressId}/stop': {
      post: op({ tags: ['Rooms'], summary: 'Stop an egress session', parameters: [pathParam('roomId', 'Room id'), pathParam('egressId', 'Egress id')], responses: { '200': { description: 'Stopped egress', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } } }),
    },
    '/v1/rooms/{roomId}/egress': {
      get: op({
        tags: ['Rooms'],
        summary: 'List redacted egress sessions and effective room start restrictions',
        parameters: [pathParam('roomId', 'Room id')],
        responses: { '200': { description: 'Room egress', content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            roomId: { type: 'string' },
            egress: { type: 'array', items: { $ref: '#/components/schemas/EgressInfo' } },
            startRestrictions: {
              description: 'Room policy only. Null means the room policy allows starting this kind. Access and worker readiness are checked separately.',
              type: 'object',
              required: ['recording', 'rtmp', 'hls'],
              additionalProperties: false,
              properties: Object.fromEntries(['recording', 'rtmp', 'hls'].map((kind) =>
                [kind, { enum: ['feature_disabled', 'e2ee_incompatible', null] }])),
            },
          },
        } } } } },
      }),
    },
    '/v1/rooms/{roomId}/egress/{egressId}/playback': {
      post: op({
        tags: ['Rooms'],
        summary: 'Mint a signed HLS/MP4 playback link (host/moderator or admin key)',
        description:
          'Tenant administrators can reissue links to archived MP4 after the room closes. ' +
          'HMAC-SHA256 token bound to tenant + room + egressId + S3 object key + expiry. `409 egress_not_ready` before egress uploads the playlist/file, ' +
          '`501 egress_playback_not_configured` without `AGIL_EGRESS_S3_*` read credentials or `AGIL_EGRESS_PLAYBACK_DIR`.',
        security: [...BEARER_SECURITY, ...API_KEY_SECURITY],
        parameters: [pathParam('roomId', 'Room id'), pathParam('egressId', 'Egress id')],
        requestBody: bodyExample('EgressPlaybackLinkRequest', { ttlSec: 900 }),
        responses: { '200': json('EgressPlaybackLink', 'Signed playback link'), '409': json('ApiErrorBody', 'Artifact not ready') },
      }),
    },
    '/v1/rooms/{roomId}/egress/{egressId}/playlist': {
      get: op({
        tags: ['Rooms'],
        summary: 'Fetch a signed HLS playlist (public capability URL; segments rewritten to signed URLs)',
        parameters: [pathParam('roomId', 'Room id'), pathParam('egressId', 'Egress id'), queryParam('token', 'HMAC playback token')],
        responses: {
          '200': { description: 'HLS playlist', content: { 'application/vnd.apple.mpegurl': { schema: { type: 'string' } } } },
          '403': json('ApiErrorBody', 'Expired/invalid token'),
        },
      }),
      // HEAD mirrors GET (same status/headers, no body). It is metadata-only: an
      // S3 HEAD/local stat, never an object GET or a playlist rewrite.
      head: op({
        tags: ['Rooms'],
        summary: 'HEAD a signed HLS playlist (metadata-only; same status/headers as GET, no body)',
        parameters: [pathParam('roomId', 'Room id'), pathParam('egressId', 'Egress id'), queryParam('token', 'HMAC playback token')],
        responses: { '200': { description: 'Playlist headers (Content-Type; Content-Length is the stored object size), no body' }, '403': json('ApiErrorBody', 'Expired/invalid token') },
      }),
    },
    '/v1/rooms/{roomId}/egress/{egressId}/segment': {
      get: op({
        tags: ['Rooms'],
        summary: 'Fetch a signed HLS segment (single Range; 416 with Content-Range when unsatisfiable)',
        parameters: [pathParam('roomId', 'Room id'), pathParam('egressId', 'Egress id'), queryParam('token', 'HMAC playback token')],
        responses: {
          '200': { description: 'Segment bytes' },
          '206': { description: 'Partial segment (single Range)' },
          '403': json('ApiErrorBody', 'Expired/invalid token'),
          '416': { description: 'Range not satisfiable; `Content-Range: bytes */<size>`' },
        },
      }),
      head: op({
        tags: ['Rooms'],
        summary: 'HEAD a signed HLS segment (metadata-only; same status/headers as GET, no body)',
        parameters: [pathParam('roomId', 'Room id'), pathParam('egressId', 'Egress id'), queryParam('token', 'HMAC playback token')],
        responses: {
          '200': { description: 'Segment headers (Content-Type/Content-Length)' },
          '206': { description: 'Partial segment headers (single Range)' },
          '403': json('ApiErrorBody', 'Expired/invalid token'),
          '416': { description: 'Range not satisfiable; `Content-Range: bytes */<size>`' },
        },
      }),
    },
    '/v1/rooms/{roomId}/egress/{egressId}/file': {
      get: op({
        tags: ['Rooms'],
        summary: 'Download a signed MP4 recording (single Range; 416 with Content-Range when unsatisfiable)',
        parameters: [pathParam('roomId', 'Room id'), pathParam('egressId', 'Egress id'), queryParam('token', 'HMAC playback token')],
        responses: {
          '200': { description: 'MP4 bytes' },
          '206': { description: 'Partial MP4 (single Range)' },
          '403': json('ApiErrorBody', 'Expired/invalid token'),
          '416': { description: 'Range not satisfiable; `Content-Range: bytes */<size>`' },
        },
      }),
      head: op({
        tags: ['Rooms'],
        summary: 'HEAD a signed MP4 recording (metadata-only; same status/headers as GET, no body)',
        parameters: [pathParam('roomId', 'Room id'), pathParam('egressId', 'Egress id'), queryParam('token', 'HMAC playback token')],
        responses: {
          '200': { description: 'Recording headers (Content-Type/Content-Length/Content-Disposition)' },
          '206': { description: 'Partial recording headers (single Range)' },
          '403': json('ApiErrorBody', 'Expired/invalid token'),
          '416': { description: 'Range not satisfiable; `Content-Range: bytes */<size>`' },
        },
      }),
    },
    '/v1/admin/egress/status': {
      get: op({
        tags: ['Admin'],
        summary: 'Egress controller status (tenant-scoped lastError/activeCount; no URL/secrets)',
        description:
          'Scoped to the admin key tenant: `lastError` is the sanitized last failure of this tenant (RTMP URLs are redacted to the host), ' +
          '`activeCount` counts only `<tenant>__` rooms. Another tenant\'s failure text is never returned.',
        responses: { '200': json('EgressStatus', 'Egress status') },
      }),
    },
    '/v1/admin/egress/workers': {
      get: op({
        tags: ['Admin'],
        summary: 'Controller status + optional worker health probe (registration is Redis/psrpc)',
        description:
          'Same tenant-scoped fields as `/v1/admin/egress/status` plus a best-effort worker health probe and playback storage type. URLs, paths and credentials are never returned.',
        responses: { '200': json('EgressWorkerStatus', 'Controller + optional worker health') },
      }),
    },
    '/v1/admin/egress/cleanup': {
      post: op({
        tags: ['Admin'],
        summary: 'List (default) or stop active egress jobs older than a threshold',
        description: 'Scoped to the admin key tenant by SFU room-name prefix (`<tenant>__`). `apply=false` is a dry run.',
        requestBody: bodyExample('EgressCleanupRequest', { apply: false, thresholdSec: 14400 }),
        responses: { '200': json('EgressCleanupResult', 'Cleanup result') },
      }),
    },
    '/v1/rooms/{roomId}/sip/dial-in': {
      post: sipOp({
        tags: ['Rooms'],
        summary: 'Start an outbound SIP/PSTN call into the room (host/moderator or admin key; not anonymous)',
        description:
          'Requires `features.sipDialIn` and `scale.sip.enabled`; `501` when the gateway is disabled/unconfigured, ' +
          '`409 e2ee_incompatible` when E2EE is active, `429` rate limit, `409 sip_limit_reached` at `scale.sip.maxConcurrent`, ' +
          '`502 sip_failed` on a gateway failure, `503 sip_node_unavailable` when the bound module is unavailable. ' +
          'The number is E.164 only and is never returned or audited unmasked.',
        security: [...BEARER_SECURITY, ...API_KEY_SECURITY],
        parameters: [roomsId],
        requestBody: bodyExample('SipDialInRequest', { number: '+74951234567', name: 'Анна' }),
        responses: { '200': json('SipParticipant', 'SIP participant created (dialing)'), '503': json('ApiErrorBody', 'Bound SIP node unavailable') },
      }),
    },
    '/v1/rooms/{roomId}/sip/{participantId}/stop': {
      post: sipOp({
        tags: ['Rooms'],
        summary: 'Hang up an active SIP participant (RoomService.RemoveParticipant; works while SIP is disabled)',
        description:
          'Cleanup readiness only needs the gateway URL/keys (no trunk, no `AGIL_SIP_ENABLED`). ' +
          'Pass the opaque `id` from `GET /v1/rooms/{roomId}/sip`: a LiveKit identity or, for an inbound phone caller, ' +
          'the LiveKit participant id (`PA_…`) resolved server-side. Digits-only/phone-like ids are rejected with ' +
          '`400 validation_failed` so they never reach audit/logs.',
        security: [...BEARER_SECURITY, ...API_KEY_SECURITY],
        parameters: [roomsId, pathParam('participantId', 'Opaque SIP participant handle from the list response')],
        responses: { '200': json('SipStopResponse', 'Stopped') },
      }),
    },
    '/v1/rooms/{roomId}/sip': {
      get: sipOp({
        tags: ['Rooms'],
        summary: 'List active SIP participants of a room (phone numbers masked; works while SIP is disabled)',
        security: [...BEARER_SECURITY, ...API_KEY_SECURITY],
        parameters: [roomsId],
        responses: { '200': json('SipListResponse', 'Active SIP participants') },
      }),
    },
    '/v1/admin/sip/status': {
      get: op({
        tags: ['Admin'],
        summary: 'SIP/PSTN gateway status (no URL/secrets; numbers are tenant-owned DIDs from config)',
        security: API_KEY_SECURITY,
        responses: { '200': json('SipStatus', 'SIP status') },
      }),
    },
    '/v1/admin/sip/test': {
      post: op({
        tags: ['Admin'],
        summary: 'Test the SIP gateway configuration (mock) or Twirp reachability (live)',
        description:
          '`mode:"mock"` (default) validates URL/keys/trunk/E.164 without a network call; `mode:"live"` performs a real ' +
          'RoomService.ListRooms Twirp request. Live mode answers `501` when the gateway is disabled/unconfigured, ' +
          '`502 sip_failed` when the gateway is unreachable.',
        security: API_KEY_SECURITY,
        requestBody: bodyExample('SipTestRequest', { mode: 'mock', number: '+74951234567' }, false),
        responses: {
          '200': json('SipTestResult', 'Test result'),
          '502': SIP_ERROR_RESPONSES['502'],
        },
      }),
    },
    '/v1/rooms/{roomId}/join': {
      post: op({ tags: ['Join'], summary: 'Join a room: password, lock, capacity, geo policy, rate limit; returns a join token', parameters: [roomsId], requestBody: bodyExample('JoinRoomRequest', { name: 'Анна', password: 'secret', locale: 'ru' }, false), responses: { '200': json('JoinRoomResponse', 'Join accepted'), '202': json('LobbyJoinResponse', 'Waiting for admission') } }),
    },
    '/v1/rooms/{roomId}/chat': {
      post: op({
        tags: ['Join'],
        summary: 'Inject a chat message with a join token (external chat bridge; idempotent on id)',
        description: 'Requires the effective `chat` permission. Text messages need `session.chat.allowHostInjection`; system notices need `session.chat.allowSystemMessages` and a host/moderator role.',
        security: BEARER_SECURITY,
        parameters: [roomsId],
        requestBody: bodyExample('ChatPostRequest', { text: 'Привет из корпоративного чата', id: 'msg-1' }),
        responses: { '200': json('ChatPostResponse', 'Stored and broadcast message') },
      }),
    },
    '/v1/rooms/{roomId}/assistant': {
      post: op({
        tags: ['Join'],
        summary: 'In-call AI assistant acting with the participant\'s permissions',
        description: 'Requires `session.inCallAgent.enabled`. `mode:"local"` answers 501 assistant_local_only (the widget runs the offline assistant). `hybrid` falls back to 501 on endpoint failure; `external` is fail-closed (502 provider_failed). Actions are filtered through the effective permissions and `maxActionsPerReply`.',
        security: BEARER_SECURITY,
        parameters: [roomsId],
        requestBody: body('InCallAssistantRequest'),
        responses: { '200': json('AssistantReply', 'Assistant reply with permission-filtered actions') },
      }),
    },
    '/v1/files': {
      post: op({
        tags: ['Files'],
        summary: 'Upload a chat attachment (raw body, ≤ session.fileShare.maxFileSizeMb)',
        description:
          'Malware scanning is opt-in per tenant (`security.avScan.enabled`) and needs a deployment engine ' +
          '(`AGIL_CLAMAV_*` / `AGIL_YARA_RULES`). `mode:\'sync\'` can reject the upload; `async` answers first ' +
          'and quarantines the stored copy afterwards (see docs/liveness-av.md).',
        security: BEARER_SECURITY,
        parameters: [headerParam('x-file-name', 'Original file name')],
        requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        responses: {
          '200': json('FileRecord', 'Stored file with signed URL'),
          '422': { description: '`file_infected` — scan verdict infected (sync mode, quarantined)' },
          '503': { description: '`scan_unavailable` — scanner error/timeout under fail-closed (sync mode, quarantined)' },
        },
      }),
    },
    '/v1/files/{id}': {
      get: op({ tags: ['Files'], summary: 'Download a file via signed URL', parameters: [pathParam('id', 'File id'), queryParam('sig', 'HMAC signature'), queryParam('exp', 'Expiry (epoch ms)', 'integer')], responses: { '200': { description: 'Raw bytes', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } } }),
    },
    '/v1/rooms/{roomId}/liveness/challenge': {
      post: op({
        tags: ['Join'],
        summary: 'Issue a server-side liveness challenge (advisory; 501 when not configured)',
        description:
          'Requires `security.liveness.enabled` and an engine (`AGIL_LIVENESS_ENGINE=challenge` by default, or a self-hosted `AGIL_LIVENESS_URL`). ' +
          'Returns a random task (`blink` | `head-left` | `head-right`) bound to the token tenant+room+participant with a TTL. ' +
          'The verdict is advisory and NOT a certified deepfake detection; see docs/liveness-av.md.',
        security: BEARER_SECURITY,
        parameters: [roomsId],
        responses: {
          '200': {
            description: 'Challenge',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['sessionId', 'task', 'issuedAt', 'expiresAt', 'ttlSec', 'engine', 'advisory'],
                  properties: {
                    sessionId: { type: 'string' },
                    task: { type: 'string', enum: ['blink', 'head-left', 'head-right'] },
                    issuedAt: { type: 'integer' },
                    expiresAt: { type: 'integer' },
                    ttlSec: { type: 'integer' },
                    engine: { type: 'string' },
                    advisory: { type: 'boolean', enum: [true] },
                  },
                },
              },
            },
          },
          '403': { description: '`liveness_disabled` (tenant flag off)' },
          '501': { description: '`liveness_not_configured` (no engine configured)' },
        },
      }),
    },
    '/v1/rooms/{roomId}/liveness/{sessionId}/verify': {
      post: op({
        tags: ['Join'],
        summary: 'Verify a liveness attempt with browser-reported signals (advisory)',
        description:
          'The browser reports only signals (`faceDetected`, `blinkDetected`, `headTurnDetected`, `modelAvailable`, `confidence`) — video never leaves the device. ' +
          'Sessions are tenant-scoped, single-use after a pass, TTL-bounded and attempt-bounded. Engine errors follow `security.liveness.onEngineError` (`fail-open` default).',
        security: BEARER_SECURITY,
        parameters: [roomsId, pathParam('sessionId', 'Challenge id from /liveness/challenge')],
        requestBody: body({ type: 'object', required: ['signals'], properties: { signals: { type: 'object', additionalProperties: true } } } as unknown as string),
        responses: { '200': json('LivenessVerifyResponse', 'Advisory verdict') },
      }),
    },
    '/v1/recordings': {
      post: op({ tags: ['Recordings'], summary: 'Upload a recording (raw webm/mp4 + x-recording-meta)', security: BEARER_SECURITY, parameters: [headerParam('x-recording-meta', 'JSON {roomId,durationSec,mimeType}', true)], requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, responses: { '200': json('RecordingRecord', 'Stored recording') } }),
    },
    '/v1/recordings/{id}': {
      get: op({ tags: ['Recordings'], summary: 'Download a recording via signed URL', parameters: [pathParam('id', 'Recording id'), queryParam('sig', 'HMAC signature'), queryParam('exp', 'Expiry (epoch ms)', 'integer')], responses: { '200': { description: 'Raw bytes', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } } }),
    },
    '/v1/stt/transcribe': {
      post: op({
        tags: ['STT'],
        summary: 'Server-side speech-to-text: local whisper.cpp/faster-whisper or remote provider (501 when not configured)',
        description:
          'Chunked captions (~8 s webm/opus from the widget). `STT_PROVIDER=local` runs on-box and attaches machine translations when the tenant sets `session.transcription.translateTo` **and** `features.translation=true`; `x-translate-to` cannot bypass the feature flag. A translation failure never discards the transcript; it is reported in `notice`.',
        security: BEARER_SECURITY,
        parameters: [
          headerParam('x-language', 'ru|en (header; omitted = auto)'),
          headerParam('x-translate-to', 'ru|en|none (header; overrides translateTo while features.translation=true)'),
          headerParam(
            'x-chunk-offset',
            'Non-negative seconds since call start; added to every segment timestamp (invalid = 400 invalid_chunk_offset)',
          ),
        ],
        requestBody: {
          required: true,
          content: {
            'audio/webm': { schema: { type: 'string', format: 'binary' } },
            'audio/wav': { schema: { type: 'string', format: 'binary' } },
            'audio/ogg': { schema: { type: 'string', format: 'binary' } },
            'audio/mpeg': { schema: { type: 'string', format: 'binary' } },
            'audio/mp4': { schema: { type: 'string', format: 'binary' } },
          },
        },
        responses: {
          '200': json('SttResponse', 'Transcript segments with optional machine translation'),
          '400': { description: 'invalid_chunk_offset', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
          '403': { description: 'consent_required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
          '501': { description: 'stt_not_configured', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
          '503': { description: 'stt_node_unavailable', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
        },
      }),
    },
    '/v1/rooms/{roomId}/transcript': {
      get: op({
        tags: ['STT'],
        summary: 'Participant transcript: timestamps, machine translations, retention/consent policy',
        security: BEARER_SECURITY,
        parameters: [roomsId, queryParam('limit', 'Last N segments (1..5000, default 1000)', 'integer')],
        responses: {
          '200': json('TranscriptResponse', 'Transcript'),
          '403': { description: 'consent_required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
        },
      }),
    },
    '/v1/rooms/{roomId}/transcript/consent': {
      get: op({
        tags: ['STT'], summary: 'Get transcription consent status before capture', security: BEARER_SECURITY,
        parameters: [roomsId],
        responses: { '200': { description: 'Current participant consent status', content: { 'application/json': { schema: {
          type: 'object', required: ['consentRequired', 'consented'], properties: { consentRequired: { type: 'boolean' }, consented: { type: 'boolean' } },
        } } } } },
      }),
      post: op({
        tags: ['STT'],
        summary: 'Grant or withdraw transcription consent (withdrawal erases this participant\'s segments)',
        security: BEARER_SECURITY,
        parameters: [roomsId],
        requestBody: bodyExample('TranscriptConsentRequest', { granted: true }),
        responses: { '200': { description: 'Consent state and removed segments', content: { 'application/json': { schema: { type: 'object', properties: { roomId: { type: 'string' }, participantId: { type: 'string' }, consent: { type: 'object', properties: { granted: { type: 'boolean' }, grantedAt: { type: ['number', 'null'] } } }, removedSegments: { type: 'integer' } } } } } } },
      }),
    },
    '/v1/rooms/{roomId}/transcript/translate': {
      post: op({
        tags: ['STT'],
        summary: 'Translate one line with the tenant\'s local/LLM engine (browser-STT captions, re-translation)',
        security: BEARER_SECURITY,
        parameters: [roomsId],
        requestBody: bodyExample('TranscriptTranslateRequest', { text: 'привет мир', sourceLang: 'ru', targetLang: 'en' }),
        responses: {
          '200': json('TranscriptTranslateResponse', 'Machine translation + quality notice'),
          '403': { description: 'consent_required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
          '501': { description: 'translation_not_configured', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
          '503': { description: 'translation_unavailable', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } } },
        },
      }),
    },
    '/v1/admin/overview': { get: op({ tags: ['Admin'], summary: 'KPI overview', security: API_KEY_SECURITY, responses: { '200': json('AdminOverview', 'Overview') } }) },
    '/v1/admin/rooms': {
      get: op({ tags: ['Admin'], summary: 'List rooms', security: API_KEY_SECURITY, responses: { '200': { description: 'Rooms', content: { 'application/json': { schema: { type: 'object', properties: { rooms: { type: 'array', items: { $ref: '#/components/schemas/AdminRoomSummary' } } } } } } } } }),
      post: op({ tags: ['Admin'], summary: 'Create a room; password is stored as a scrypt hash only', security: API_KEY_SECURITY, requestBody: bodyExample('CreateRoomRequest', { tenantId: 'demo', name: 'Планёрка', password: 'secret', maxParticipants: 12, mode: 'group' }), responses: { '200': json('CreateRoomResponse', 'Created room') } }),
    },
    '/v1/admin/rooms/{roomId}': {
      get: op({ tags: ['Admin'], summary: 'Room detail: participants, chat, links', security: API_KEY_SECURITY, parameters: [roomsId], responses: { '200': json('RoomDetail', 'Room detail') } }),
      delete: op({ tags: ['Admin'], summary: 'Close room', security: API_KEY_SECURITY, parameters: [roomsId], responses: { '200': { description: 'Closed', content: { 'application/json': { schema: { type: 'object', properties: { closed: { type: 'boolean' } } } } } } } }),
    },
    '/v1/admin/voice-channels': {
      get: op({ tags: ['Admin'], summary: 'List tenant voice channels and assigned roles', security: API_KEY_SECURITY, responses: { '200': json('VoiceChannelList', 'Voice channels') } }),
      post: op({ tags: ['Admin'], summary: 'Create a persistent private voice channel', security: API_KEY_SECURITY, requestBody: body('VoiceChannelCreate'), responses: { '201': json('VoiceChannelResponse', 'Voice channel created') } }),
    },
    '/v1/admin/voice-channels/{channelId}': {
      get: op({ tags: ['Admin'], summary: 'Read a voice channel', security: API_KEY_SECURITY, parameters: [voiceChannelId], responses: { '200': json('VoiceChannelResponse', 'Voice channel') } }),
      patch: op({ tags: ['Admin'], summary: 'Change a voice channel name or replace the roster', description: 'Replacing membership, assigned roles or member names closes the current room and invalidates its Core grants.', security: API_KEY_SECURITY, parameters: [voiceChannelId], requestBody: body('VoiceChannelPatch'), responses: { '200': json('VoiceChannelResponse', 'Voice channel updated') } }),
      delete: op({ tags: ['Admin'], summary: 'Delete a voice channel and close its room', security: API_KEY_SECURITY, parameters: [voiceChannelId], responses: { '200': { description: '`{deleted:true}`' } } }),
    },
    '/v1/admin/voice-channels/{channelId}/join': {
      post: op({ tags: ['Admin'], summary: 'Issue a room grant for the assigned channel member', description: 'The company authenticates its participant before requesting a grant. Core applies the stored role and creates a private group room on demand.', security: API_KEY_SECURITY, parameters: [voiceChannelId], requestBody: body('VoiceChannelGrantRequest'), responses: { '200': json('VoiceChannelGrant', 'Channel join grant') } }),
    },
    '/v1/admin/rooms/{roomId}/invites': { post: op({ tags: ['Admin'], summary: 'Create an invite link+token', security: API_KEY_SECURITY, parameters: [roomsId], requestBody: body({ type: 'object', properties: { ttlSec: { type: 'integer' }, role: { type: 'string', enum: ['host', 'moderator', 'guest'] } } } as unknown as string, false), responses: { '200': json('InviteLink', 'Invite') } }) },
    '/v1/admin/rooms/{roomId}/lock': { post: op({ tags: ['Admin'], summary: 'Lock/unlock a room', security: API_KEY_SECURITY, parameters: [roomsId], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['locked'], properties: { locked: { type: 'boolean' } } } } } }, responses: { '200': { description: 'Lock state', content: { 'application/json': { schema: { type: 'object', properties: { locked: { type: 'boolean' } } } } } } } }) },
    '/v1/admin/rooms/{roomId}/kick': { post: op({ tags: ['Admin'], summary: 'Disconnect a participant', security: API_KEY_SECURITY, parameters: [roomsId], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['participantId'], properties: { participantId: { type: 'string' } } } } } }, responses: { '200': { description: 'Kicked', content: { 'application/json': { schema: { type: 'object', properties: { kicked: { type: 'boolean' } } } } } } } }) },
    '/v1/admin/rooms/{roomId}/chat': {
      post: op({
        tags: ['Admin'],
        summary: 'Post a chat message as the company bot/CRM (no token needed)',
        description: 'System notices require `session.chat.allowSystemMessages`; text messages require `session.chat.allowHostInjection`. Default author is {name:"Система", role:"moderator"}.',
        security: API_KEY_SECURITY,
        parameters: [roomsId],
        requestBody: bodyExample('ChatPostRequest', { text: 'Привет из корпоративного чата', id: 'msg-1' }),
        responses: { '200': json('ChatPostResponse', 'Stored and broadcast message') },
      }),
    },
    '/v1/admin/rooms/{roomId}/transcript': {
      get: op({ tags: ['Admin'], summary: 'Transcript segments', security: API_KEY_SECURITY, parameters: [roomsId], responses: { '200': json('TranscriptResponse', 'Transcript') } }),
      delete: op({
        tags: ['Admin'], summary: 'Purge the stored transcript of an active room', security: API_KEY_SECURITY,
        parameters: [roomsId],
        responses: {
          '200': {
            description: 'Transcript purged',
            content: { 'application/json': { schema: {
              type: 'object', required: ['roomId', 'removedSegments', 'clearedAt'],
              properties: {
                roomId: { type: 'string' },
                removedSegments: { type: 'integer', minimum: 0 },
                clearedAt: { type: 'integer', description: 'Unix timestamp in milliseconds' },
              },
            } } },
          },
          '401': json('ApiErrorBody', 'Missing or invalid credentials'),
          '403': json('ApiErrorBody', 'Room belongs to another organization'),
          '404': json('ApiErrorBody', 'Room not found'),
        },
      }),
    },
    '/v1/admin/stt': {
      get: op({
        tags: ['Admin'],
        summary: 'Local STT/translation status with actionable reasons (no secrets, no model paths)',
        security: API_KEY_SECURITY,
        responses: { '200': json('SttStatusResponse', 'STT/translation status') },
      }),
    },
    '/v1/admin/rooms/{roomId}/password': {
      post: op({
        tags: ['Admin'],
        summary: 'Set or generate a room password (scrypt; generated password shown once)',
        description: '`{password}` sets it; empty/omitted body generates a strong password and returns it **once** (`generated:true`). Only the scrypt hash is stored; GET/list never return the password. Use for «Сменить/Установить пароль» in the dashboard.',
        security: API_KEY_SECURITY,
        parameters: [roomsId],
        requestBody: bodyExample('RoomPasswordRequest', {}, false),
        responses: { '200': json('RoomPasswordResponse', 'Password updated (generated password only on generation)') },
      }),
      delete: op({
        tags: ['Admin'],
        summary: 'Remove the room password (make the room public)',
        security: API_KEY_SECURITY,
        parameters: [roomsId],
        responses: { '200': json('RoomPasswordResponse', 'Password removed') },
      }),
    },
    '/v1/admin/rooms/{roomId}/analysis': { get: op({ tags: ['Admin'], summary: 'Compliance report, findings and notes', description: 'JSON для экспорта; `?format=md` отдаёт Markdown, `&download=1` — как файл (content-disposition).', security: API_KEY_SECURITY, parameters: [roomsId, queryParam('format', 'json|md', 'string'), queryParam('download', '1 = attachment', 'string')], responses: { '200': json('AnalysisResponse', 'Analysis') } }) },
    '/v1/admin/rooms/{roomId}/notes': { get: op({ tags: ['Admin'], summary: 'Meeting notes (summary, decisions, action items) for export', description: 'JSON `{roomId, notes, updatedAt}`; `?format=md` — Markdown для скачивания/печати.', security: API_KEY_SECURITY, parameters: [roomsId, queryParam('format', 'json|md', 'string'), queryParam('download', '1 = attachment', 'string')], responses: { '200': { description: 'Notes JSON or markdown', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } }, 'text/markdown': { schema: { type: 'string' } } } } } }) },
    '/v1/admin/rooms/{roomId}/analysis/run': { post: op({ tags: ['Admin'], summary: 'Force a pipeline run (local rules + AI agent)', security: API_KEY_SECURITY, parameters: [roomsId], responses: { '200': json('AnalysisResponse', 'Analysis') } }) },
    '/v1/admin/rooms/{roomId}/conversation-review': {
      get: op({ tags: ['Admin'], summary: 'Read the room conversation review and its metadata-only signals',
        security: API_KEY_SECURITY, parameters: [roomsId], responses: {
          '200': { description: 'Policy and signals (ruleId, category, severity, at)' }, '404': json('ApiErrorBody', 'No retained review'),
        } }),
      put: op({ tags: ['Admin'], summary: 'Set or disable a room conversation review policy',
        description: 'Explicit consent from all participants is required for each policy revision. A policy change clears existing signals.',
        security: API_KEY_SECURITY, parameters: [roomsId], requestBody: body({
          type: 'object', properties: { enabled: { type: 'boolean' }, retentionMin: { type: 'integer', minimum: 1, maximum: 120 },
            rules: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' },
              category: { enum: ['ethics', 'disclosure'] }, severity: { enum: ['warn', 'critical'] }, phrase: { type: 'string' } },
              required: ['id', 'category', 'severity', 'phrase'] } } }, required: ['enabled'],
          examples: [{ enabled: true, retentionMin: 30, rules: [{ id: 'sample', category: 'disclosure', severity: 'warn', phrase: 'sample project' }] }],
        }),
        responses: { '200': { description: 'Updated policy and signals' }, '409': json('ApiErrorBody', 'E2EE or captions disabled') },
      }),
    },
    '/v1/admin/rooms/{roomId}/locations': { get: op({ tags: ['Admin'], summary: 'Participant locations (GPS coordinates are admin-only)', security: API_KEY_SECURITY, parameters: [roomsId], responses: { '200': { description: 'Locations', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } } }) },
    '/v1/admin/audit': { get: op({ tags: ['Admin'], summary: 'Paginated audit log (IP hashes only)', security: API_KEY_SECURITY, parameters: [queryParam('limit', 'Max entries (1..1000)', 'integer'), queryParam('offset', 'Pagination offset', 'integer'), queryParam('anchorId', 'Optional audit snapshot boundary returned by the first page'), queryParam('type', 'Event type'), queryParam('severity', 'info|warn|critical'), queryParam('roomId', 'Room filter'), queryParam('q', 'Search retained events by message, event code, or ID (up to 200 characters)')], responses: { '200': json('AuditListResponse', 'Entries, total, offset, limit and optional anchorId') } }) },
    '/v1/admin/security': { get: op({ tags: ['Admin'], summary: 'Security overview (failed joins, geo blocks, suspicious participants)', security: API_KEY_SECURITY, responses: { '200': json('SecurityOverview', 'Security overview') } }) },
    '/v1/admin/recordings': {
      get: op({ tags: ['Admin'], summary: 'List uploaded browser recordings and archived Egress MP4 files', security: API_KEY_SECURITY, parameters: [queryParam('roomId', 'Room filter')], responses: { '200': { description: 'Recordings', content: { 'application/json': { schema: { type: 'object', properties: { recordings: { type: 'array', items: { $ref: '#/components/schemas/RecordingRecord' } } } } } } } } }),
    },
    '/v1/admin/recordings/{id}': {
      delete: op({
        tags: ['Admin'], summary: 'Delete an organization recording',
        description: 'Archived Egress MP4 deletion requires AGIL_EGRESS_ARCHIVE_DELETE_ENABLED and storage permission. Core retains the archive metadata when storage cannot confirm deletion.',
        security: API_KEY_SECURITY, parameters: [pathParam('id', 'Recording id')],
        responses: {
          '200': { description: 'Deleted', content: { 'application/json': { schema: { type: 'object', properties: { deleted: { type: 'boolean' } } } } } },
          '404': json('ApiErrorBody', 'Recording unavailable for this organization'),
          '409': json('ApiErrorBody', 'Deletion disabled, object changed, or storage backend changed'),
          '502': json('ApiErrorBody', 'Could not delete the storage object'),
        },
      }),
    },
    '/v1/admin/quarantine': {
      get: op({
        tags: ['Admin'],
        summary: 'List quarantined uploads (metadata only; payloads are never served)',
        security: API_KEY_SECURITY,
        parameters: [queryParam('limit', 'Max records (1..1000)', 'integer')],
        responses: {
          '200': {
            description: 'Quarantine records for the key tenant',
            content: { 'application/json': { schema: { type: 'object', properties: { files: { type: 'array', items: { $ref: '#/components/schemas/QuarantineRecord' } } } } } },
          },
        },
      }),
    },
    '/v1/admin/quarantine/{id}': {
      delete: op({
        tags: ['Admin'],
        summary: 'Purge a quarantined upload (tenant-scoped)',
        security: API_KEY_SECURITY,
        parameters: [pathParam('id', 'Quarantine record id')],
        responses: { '200': { description: 'Deleted', content: { 'application/json': { schema: { type: 'object', properties: { deleted: { type: 'boolean' } } } } } }, '404': { description: 'Unknown record for this tenant' } },
      }),
    },
    '/v1/admin/files': { get: op({ tags: ['Admin'], summary: 'List shared files', security: API_KEY_SECURITY, parameters: [queryParam('roomId', 'Room filter')], responses: { '200': { description: 'Files', content: { 'application/json': { schema: { type: 'object', properties: { files: { type: 'array', items: { $ref: '#/components/schemas/FileRecord' } } } } } } } } }) },
    '/v1/admin/ai-agent': {
      get: op({ tags: ['Admin'], summary: 'AI agent settings (secret only as env var name)', security: API_KEY_SECURITY, responses: { '200': json('AiAgentSettingsResponse', 'AI agent settings') } }),
      put: op({ tags: ['Admin'], summary: 'Merge AI agent settings into session.aiAgent', security: API_KEY_SECURITY, requestBody: body({ type: 'object', required: ['config'], properties: { config: { type: 'object', additionalProperties: true } } } as unknown as string), responses: { '200': json('AiAgentSettingsResponse', 'Updated settings') } }),
    },
    '/v1/admin/knowledge-agent': {
      get: op({ tags: ['Admin'], summary: 'Knowledge agent settings', security: API_KEY_SECURITY, responses: { '200': json('KnowledgeAgentSettingsResponse', 'Knowledge agent settings') } }),
      put: op({ tags: ['Admin'], summary: 'Merge knowledge agent settings into session.knowledgeAgent', security: API_KEY_SECURITY, requestBody: body({ type: 'object', required: ['config'], properties: { config: { type: 'object', additionalProperties: true } } } as unknown as string), responses: { '200': json('KnowledgeAgentSettingsResponse', 'Updated settings') } }),
    },
    '/v1/admin/knowledge/ask': { post: op({ tags: ['Admin'], summary: 'Proxy a question to the corporate knowledge agent', security: API_KEY_SECURITY, requestBody: body('KnowledgeAskRequest'), responses: { '200': json('KnowledgeAskResponse', 'Answer with citations') } }) },
    '/v1/admin/in-call-agent': {
      get: op({ tags: ['Admin'], summary: 'In-call assistant settings', security: API_KEY_SECURITY, responses: { '200': json('InCallAssistantSettings', 'In-call agent settings') } }),
      put: op({
        tags: ['Admin'],
        summary: 'Merge in-call assistant settings into session.inCallAgent',
        security: API_KEY_SECURITY,
        requestBody: body({ type: 'object', required: ['config'], properties: { config: { type: 'object', additionalProperties: true } } } as unknown as string),
        responses: { '200': json('InCallAssistantSettings', 'Updated settings') },
      }),
    },
    '/v1/admin/access-policy': {
      get: op({ tags: ['Admin'], summary: 'Access policy + effective features per role', security: API_KEY_SECURITY, responses: { '200': json('AccessPolicyResponse', 'Policy') } }),
      put: op({
        tags: ['Admin'],
        summary: 'Merge changed access policy fields and roles (audit access.updated)',
        security: API_KEY_SECURITY,
        requestBody: body('AccessPolicyUpdateRequest'),
        responses: { '200': json('AccessPolicyResponse', 'Policy') },
      }),
    },
    '/v1/admin/webhooks': {
      get: op({ tags: ['Admin'], summary: 'Webhook endpoints + recent deliveries', security: API_KEY_SECURITY, responses: { '200': json('WebhooksResponse', 'Webhooks') } }),
      put: op({ tags: ['Admin'], summary: 'Replace webhook endpoints (URL policy enforced)', security: API_KEY_SECURITY, requestBody: body({ type: 'object', required: ['webhooks'], properties: { webhooks: { type: 'array', items: { $ref: '#/components/schemas/WebhookEndpointConfig' } } } } as unknown as string), responses: { '200': json('WebhooksResponse', 'Webhooks') } }),
    },
    '/v1/admin/webhooks/test': { post: op({ tags: ['Admin'], summary: 'Send a test security.event delivery', security: API_KEY_SECURITY, requestBody: body({ type: 'object', required: ['endpointId'], properties: { endpointId: { type: 'string' } } } as unknown as string), responses: { '200': json('WebhookTestResponse', 'Delivery outcome') } }) },
    '/v1/admin/providers': {
      get: op({ tags: ['Admin'], summary: 'Capability provider status per slot', security: API_KEY_SECURITY, responses: { '200': json('ProvidersResponse', 'Provider slots') } }),
      put: op({
        tags: ['Admin'],
        summary: 'Merge provider slots into config.providers (external endpoints pass SSRF policy)',
        security: API_KEY_SECURITY,
        requestBody: body({ type: 'object', required: ['providers'], properties: { providers: { type: 'object', additionalProperties: { $ref: '#/components/schemas/ProviderSlot' } } } } as unknown as string),
        responses: { '200': json('ProvidersResponse', 'Updated provider slots') },
      }),
    },
    '/v1/admin/providers/test': {
      post: op({
        tags: ['Admin'],
        summary: 'Test a provider slot (builtin probe or signed external test envelope)',
        security: API_KEY_SECURITY,
        requestBody: body('ProviderTestRequest'),
        responses: { '200': json('ProviderTestResponse', 'Test outcome with latency') },
      }),
    },
    '/v1/admin/roles': {
      get: op({ tags: ['Admin'], summary: 'Roles: built-in host/moderator/guest + custom roles', security: API_KEY_SECURITY, responses: { '200': json('RolesResponse', 'Roles with effective feature lists') } }),
      post: op({
        tags: ['Admin'],
        summary: 'Create a custom role',
        description: 'Built-in ids (host/moderator/guest) are reserved; up to 30 custom roles. Effective features are computed on every join/token.',
        security: API_KEY_SECURITY,
        requestBody: bodyExample('RoleWriteRequest', { id: 'streamer', name: 'Стример', description: 'Ведущий трансляции', baseRole: 'moderator', features: ['chat', 'screenShare', 'liveStreaming'], canModerate: true, color: '#7c3aed' }),
        responses: { '200': json('RoleDefinition', 'Created role') },
      }),
    },
    '/v1/admin/roles/{id}': {
      put: op({
        tags: ['Admin'],
        summary: 'Update a custom role (built-ins are read-only here)',
        security: API_KEY_SECURITY,
        parameters: [pathParam('id', 'Role id')],
        requestBody: bodyExample('RoleWriteRequest', { id: 'streamer', name: 'Стример v2', baseRole: 'moderator', features: ['chat', 'screenShare'] }),
        responses: { '200': json('RoleDefinition', 'Updated role') },
      }),
      delete: op({
        tags: ['Admin'],
        summary: 'Delete a custom role (participants fall back to its baseRole)',
        security: API_KEY_SECURITY,
        parameters: [pathParam('id', 'Role id')],
        responses: { '200': { description: 'Deleted + affected active participants', content: { 'application/json': { schema: { type: 'object', properties: { deleted: { type: 'boolean' }, affectedParticipants: { type: 'integer' } } } } } } },
      }),
    },
    '/v1/admin/assistant/prompts': {
      get: op({ tags: ['Admin'], summary: 'Prompt catalogue for the dashboard mascot assistant roles', security: API_KEY_SECURITY, responses: { '200': json('AssistantPromptsResponse', 'Prompt roles') } }),
    },
    '/v1/admin/assistant': {
      post: op({
        tags: ['Admin'],
        summary: 'Dashboard mascot assistant (DeepSeek, local fallback)',
        description: 'Admin-only copilot for the dashboard. DeepSeek answers when `AGIL_DEEPSEEK_API_KEY` is configured; on any error a deterministic local answer is returned with `fallback:true`. History is trimmed to 12 messages / 8000 chars; the key is never returned or logged.',
        security: API_KEY_SECURITY,
        requestBody: bodyExample('DashboardAssistantRequest', {
          messages: [{ role: 'user', content: 'Что будет, если выключить запись?' }],
          role: 'config-guardian',
          context: { screen: 'settings', tenantId: 'demo' },
        }),
        responses: { '200': json('DashboardAssistantResponse', 'Assistant answer (model or local fallback)') },
      }),
    },
    '/v1/admin/guard/assess': {
      post: op({
        tags: ['Admin'],
        summary: 'Assess the risk of a critical change before applying it',
        description: 'Guardrail for destructive admin actions: compares the proposed `next` value with the live tenant config (rooms/roles/access/scale/providers/webhooks) and returns risk, findings and a plain-language confirmation message for the mascot.',
        security: API_KEY_SECURITY,
        requestBody: bodyExample('GuardAssessRequest', {
          kind: 'config',
          next: { features: { recording: false } },
          intent: 'выключить запись',
        }),
        responses: { '200': json('GuardAssessResponse', 'Risk assessment with findings') },
      }),
    },
    '/v1/admin/docs': {
      get: op({ tags: ['Admin'], summary: 'Documentation CMS: bundled + edited/uploaded docs, versions, default', security: API_KEY_SECURITY, responses: { '200': json('DocsListResponse', 'Documents + defaultName') } }),
    },
    '/v1/admin/docs/upload': {
      post: op({
        tags: ['Admin'],
        summary: 'Upload a document (raw body + x-file-name, or JSON {name,content})',
        description: '`.md`/`.txt`, ≤200KB; the file name is sanitised (basename, lowercase, no paths). Создаёт custom-копию и версию в истории.',
        security: API_KEY_SECURITY,
        requestBody: {
          required: true,
          content: {
            'text/markdown': { schema: { type: 'string', format: 'binary' } },
            'application/json': { schema: {
              type: 'object',
              required: ['name', 'content'],
              properties: {
                name: { type: 'string' },
                content: { type: 'string' },
                title: { type: 'string' },
                expectedRevision: { type: ['string', 'null'], description: 'Revision from the last document read, or null to require an unused name' },
              },
            } },
          },
        },
        responses: { '200': json('DocContentResponse', 'Uploaded document meta'), '409': json('ApiErrorBody', 'The publication changed or this Core is on standby') },
      }),
    },
    '/v1/admin/docs/default': {
      put: op({
        tags: ['Admin'],
        summary: 'Choose the primary document for the panel/docs menu',
        security: API_KEY_SECURITY,
        requestBody: bodyExample('DocDefaultRequest', { name: 'api-guide.md' }),
        responses: { '200': { description: 'New default', content: { 'application/json': { schema: { type: 'object', properties: { updated: { type: 'boolean' }, defaultName: { type: 'string' } } } } } } },
      }),
    },
    '/v1/admin/docs/{name}': {
      get: op({ tags: ['Admin'], summary: 'Read a document (custom copy wins over bundled)', security: API_KEY_SECURITY, parameters: [pathParam('name', 'Document name (e.g. api-guide.md)')], responses: { '200': json('DocContentResponse', 'Document content') } }),
      put: op({
        tags: ['Admin'],
        summary: 'Save an edited document (custom copy + version history, ≤200KB)',
        security: API_KEY_SECURITY,
        parameters: [pathParam('name', 'Document name')],
        requestBody: bodyExample('DocWriteRequest', { content: '# AgilFrame API\n\nОбновлённое описание.', title: 'AgilFrame API' }),
        responses: { '200': json('DocContentResponse', 'Updated document meta'), '409': json('ApiErrorBody', 'The published document has changed') },
      }),
      delete: op({
        tags: ['Admin'],
        summary: 'Reset custom copy to bundled (or delete an uploaded-only doc)',
        security: API_KEY_SECURITY,
        parameters: [pathParam('name', 'Document name')],
        requestBody: bodyExample('DocRevisionRequest', { expectedRevision: '0'.repeat(64) }, false),
        responses: {
          '200': { description: 'Reset result', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
          '409': json('ApiErrorBody', 'The publication changed or this Core is on standby'),
        },
      }),
    },
    '/v1/admin/docs/{name}/versions': {
      get: op({ tags: ['Admin'], summary: 'Document version history (newest first)', security: API_KEY_SECURITY, parameters: [pathParam('name', 'Document name')], responses: { '200': json('DocHistoryResponse', 'Versions') } }),
    },
    '/v1/admin/docs/{name}/versions/{versionId}': {
      get: op({ tags: ['Admin'], summary: 'Read one historical version (content + meta)', security: API_KEY_SECURITY, parameters: [pathParam('name', 'Document name'), pathParam('versionId', 'Version id')], responses: { '200': { description: 'Version + content', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } } }),
    },
    '/v1/admin/docs/{name}/versions/{versionId}/restore': {
      post: op({
        tags: ['Admin'],
        summary: 'Restore a historical version as current (current is archived first)',
        security: API_KEY_SECURITY,
        parameters: [pathParam('name', 'Document name'), pathParam('versionId', 'Version id')],
        requestBody: bodyExample('DocRevisionRequest', { expectedRevision: '0'.repeat(64) }, false),
        responses: { '200': json('DocContentResponse', 'Restored document'), '409': json('ApiErrorBody', 'The publication changed or this Core is on standby') },
      }),
    },
    '/v1/admin/domain': {
      get: op({ tags: ['Admin'], summary: 'Custom white-label domain + DNS instructions', security: API_KEY_SECURITY, responses: { '200': json('DomainConfigResponse', 'Domain config') } }),
      put: op({
        tags: ['Admin'],
        summary: 'Set the custom domain (pending until DNS verification)',
        security: API_KEY_SECURITY,
        requestBody: bodyExample('DomainConfigRequest', { domain: 'meet.acme.com' }),
        responses: { '200': json('DomainConfigResponse', 'Saved as pending; publish the TXT/CNAME then call /verify'), '409': json('ApiErrorBody', 'Domain already assigned to another tenant') },
      }),
      post: op({ tags: ['Admin'], summary: 'Verify the custom domain via DNS TXT token or CNAME (alias of /verify)', security: API_KEY_SECURITY, responses: { '200': json('DomainConfigResponse', 'Verification result (status pending|verified)') } }),
      delete: op({ tags: ['Admin'], summary: 'Reset the custom domain', security: API_KEY_SECURITY, responses: { '200': json('DomainConfigResponse', 'Domain removed') } }),
    },
    '/v1/admin/domain/verify': {
      post: op({
        tags: ['Admin'],
        summary: 'Run the DNS challenge for the configured custom domain',
        description: 'Looks up TXT `_agil-calls.<domain>` for `agil-verify=<token>` and CNAME `<domain>` -> AGIL_DOMAIN_TARGET. Returns 200 with `status:"pending"` and `verification.lastError` when DNS is not ready; a failed re-check revokes the host mapping.',
        security: API_KEY_SECURITY,
        responses: { '200': json('DomainConfigResponse', 'Verification result'), '400': json('ApiErrorBody', 'No domain configured') },
      }),
    },
    '/v1/admin/tenants': {
      get: op({ tags: ['Admin'], summary: 'Platform: list SaaS organisations (counts, branding, key presence)', security: API_KEY_SECURITY, responses: { '200': json('TenantsResponse', 'Tenants + platform flag') } }),
      post: op({
        tags: ['Admin'],
        summary: 'Platform: onboard a new organisation (config preset, branding, API key once)',
        description: 'Requires `AGIL_PLATFORM_KEY` and the Core leader. An archived tenant ID is reserved (409 `tenant_id_retired`). Feature overrides apply after the preset; templateTenantId copies an existing config. Returns the plaintext API key **once**; only its hash is stored in the data dir.',
        security: API_KEY_SECURITY,
        requestBody: bodyExample('TenantCreateRequest', {
          tenantId: 'acme',
          name: 'ACME Calls',
          organizationName: 'ACME LLC',
          branding: { productName: 'ACME Meet', logoUrl: 'https://acme.example/logo.png' },
          theme: { scheme: 'dark' },
          preset: 'corporate',
        }),
        responses: {
          '200': json('TenantCreatedResponse', 'Created tenant + plaintext API key (once)'),
          '409': { description: 'Identifier already in use, tenant_id_retired, or not_leader' },
        },
      }),
    },
    '/v1/admin/tenants/{tenantId}': {
      get: op({ tags: ['Admin'], summary: 'Tenant summary (platform or the tenant itself)', security: API_KEY_SECURITY, parameters: [pathParam('tenantId', 'Tenant id')], responses: { '200': json('TenantSummary', 'Tenant summary') } }),
      patch: op({
        tags: ['Admin'],
        summary: 'Update branding/name/theme (platform or the tenant itself)',
        security: API_KEY_SECURITY,
        parameters: [pathParam('tenantId', 'Tenant id')],
        requestBody: bodyExample('TenantCreateRequest', { tenantId: 'acme', name: 'ACME Meet', branding: { productName: 'ACME Meet v2' } }, false),
        responses: { '200': json('TenantSummary', 'Updated summary') },
      }),
      delete: op({ tags: ['Admin'], summary: 'Platform: delete a tenant (config archived, keys revoked, rooms closed; demo protected)', security: API_KEY_SECURITY, parameters: [pathParam('tenantId', 'Tenant id')], responses: { '200': { description: 'Deleted', content: { 'application/json': { schema: { type: 'object', properties: { deleted: { type: 'boolean' }, tenantId: { type: 'string' } } } } } } } }),
    },
    '/v1/admin/tenants/{tenantId}/keys': {
      post: op({ tags: ['Admin'], summary: 'Platform: rotate the tenant API key (old dynamic key is revoked)', security: API_KEY_SECURITY, parameters: [pathParam('tenantId', 'Tenant id')], responses: { '200': json('TenantKeyResponse', 'New plaintext key (once)') } }),
    },
    '/v1/admin/siem/status': {
      get: op({ tags: ['Admin'], summary: 'SIEM export status (queue/lastError/lastDelivery, no URL secrets)', responses: { '200': json('SiemStatus', 'SIEM status') } }),
    },
    '/v1/admin/siem/test': {
      post: op({ tags: ['Admin'], summary: 'Send a test SIEM event (501 when SIEM is off)', responses: { '200': json('SiemTestResult', 'Delivery result'), '501': json('ApiErrorBody', 'SIEM disabled') } }),
    },
    '/v1/admin/media/processing': {
      get: op({
        tags: ['Admin'],
        summary: 'Optional server-side media processing policy (client-first by default)',
        security: API_KEY_SECURITY,
        responses: { '200': json('MediaProcessingStatus', 'Policy + active/forwarding/egress flags') },
      }),
    },
    '/v1/admin/scale': {
      get: op({ tags: ['Admin'], summary: 'Scale-out status: media mode, cluster registry, TURN pool, SFU/webinar/streaming flags, MVP limitations', security: API_KEY_SECURITY, responses: { '200': json('ScaleStatusResponse', 'Scale status') } }),
      put: op({
        tags: ['Admin'],
        summary: 'Merge scale configuration (media mode, TURN pool, signaling nodes, SFU, webinar, streaming, CDN)',
        description: 'URLs are validated (SSRF policy; TLS required in production mode), secrets are env-variable names only. This updates configuration/status only: cluster/SFU/streaming orchestration is not implemented in the single-node MVP.',
        security: API_KEY_SECURITY,
        requestBody: bodyExample('ScaleConfig', { mediaMode: 'sfu', maxParticipants: 500, signaling: { nodeId: 'node-1', stickySessions: true }, turn: [{ id: 'turn-msk', urls: ['turn:turn-msk.example:3478?transport=udp'], username: 'agil', credentialEnv: 'AGIL_TURN_MSK_SECRET', region: 'ru-msk', weight: 100 }] }),
        responses: { '200': json('ScaleStatusResponse', 'Updated scale status') },
      }),
    },
    '/v1/admin/cluster/status': {
      get: op({ tags: ['Admin'], summary: 'Cluster status: leader + lease TTL + failover notice, standbys, enrolled nodes, counts, limitations', security: API_KEY_SECURITY, responses: { '200': json('ClusterStatusResponse', 'Cluster status') } }),
    },
    '/v1/admin/cluster/tokens': {
      get: op({ tags: ['Admin'], summary: 'List enrollment tokens (never plaintext or hashes)', security: API_KEY_SECURITY, responses: { '200': json('EnrollmentTokenListResponse', 'Tenant tokens, newest first') } }),
      post: op({
        tags: ['Admin'],
        summary: 'Issue a one-time enrollment token; the plaintext is returned once',
        description: 'Core tokens default to role `standby`; node tokens default to `all`. TTL 1 s … 30 days, uses 1…100. Leader-only (standby Core: 409 `not_leader`). A failed registry write returns 503 `registry_unavailable` and persists nothing.',
        security: API_KEY_SECURITY,
        requestBody: bodyExample('EnrollmentTokenCreateRequest', { kind: 'node', role: 'sfu', features: ['sfu', 'egress'], ttlSec: 3600, uses: 1, label: 'edge-sfu' }),
        responses: { '201': json('EnrollmentTokenCreatedResponse', 'Token created; plaintext shown once'), '503': REGISTRY_UNAVAILABLE_RESPONSE },
      }),
    },
    '/v1/admin/cluster/tokens/{tokenId}': {
      delete: op({
        tags: ['Admin'],
        summary: 'Revoke an enrollment token (idempotent; 404 for unknown ids)',
        description: 'Leader-only (standby Core: 409 `not_leader`).',
        security: API_KEY_SECURITY,
        parameters: [pathParam('tokenId', 'Enrollment token id (`enr_…`)')],
        responses: { '200': json('EnrollmentTokenRevokeResponse', 'Revoked token summary'), '503': REGISTRY_UNAVAILABLE_RESPONSE },
      }),
    },
    '/v1/admin/nodes': {
      get: op({
        tags: ['Admin'],
        summary: 'List registered nodes (?role=&status=&limit=&offset=)',
        security: API_KEY_SECURITY,
        parameters: [
          queryParam('role', 'sfu | turn | stun | all'),
          queryParam('status', 'online | offline | draining | disabled'),
          queryParam('limit', 'Page size 1..500 (default: all)', 'integer'),
          queryParam('offset', 'Zero-based offset (default 0)', 'integer'),
        ],
        responses: { '200': json('NodeListResponse', 'Tenant nodes') },
      }),
    },
    '/v1/admin/nodes/{nodeId}': {
      patch: op({
        tags: ['Admin'],
        summary: 'Update node metadata (role/features/capacity/name/endpoint/healthPath/region)',
        description: '`endpoint` must be an http(s)/ws(s) URL without credentials and must not point at a cloud metadata service. Leader-only (standby Core: 409 `not_leader`).',
        security: API_KEY_SECURITY,
        parameters: [pathParam('nodeId', 'Node id')],
        requestBody: bodyExample('NodeUpdateRequest', { role: 'sfu', features: ['sfu', 'egress'], capacity: { maxRooms: 9 }, region: 'ru-msk' }),
        responses: { '200': json('NodeResponse', 'Updated node'), '503': REGISTRY_UNAVAILABLE_RESPONSE },
      }),
      delete: op({
        tags: ['Admin'],
        summary: 'Delete a node record (invalidates its key; the id can be enrolled again)',
        description: 'Leader-only (standby Core: 409 `not_leader`).',
        security: API_KEY_SECURITY,
        parameters: [pathParam('nodeId', 'Node id')],
        responses: { '200': json('NodeDeleteResponse', 'Deleted'), '503': REGISTRY_UNAVAILABLE_RESPONSE },
      }),
    },
    '/v1/admin/nodes/{nodeId}/disable': {
      post: op({
        tags: ['Admin'],
        summary: 'Disable/enable a node (disabled blocks heartbeat with 403)',
        description: 'Leader-only (standby Core: 409 `not_leader`).',
        security: API_KEY_SECURITY,
        parameters: [pathParam('nodeId', 'Node id')],
        requestBody: bodyExample('NodeDisableRequest', { disabled: true }, false),
        responses: { '200': json('NodeResponse', 'Updated node'), '503': REGISTRY_UNAVAILABLE_RESPONSE },
      }),
    },
    '/v1/admin/nodes/{nodeId}/drain': {
      post: op({
        tags: ['Admin'],
        summary: 'Set/clear the drain marker (heartbeat keeps working)',
        description: 'Leader-only (standby Core: 409 `not_leader`). Clearing maintenance is blocked with `sfu_drain_in_progress` while an external SFU stop or restart is unconfirmed.',
        security: API_KEY_SECURITY,
        parameters: [pathParam('nodeId', 'Node id')],
        requestBody: bodyExample('NodeDrainRequest', { drain: true }, false),
        responses: { '200': json('NodeResponse', 'Updated node'), '503': REGISTRY_UNAVAILABLE_RESPONSE },
      }),
    },
    '/v1/admin/nodes/{nodeId}/rotate-key': {
      post: op({
        tags: ['Admin'],
        summary: 'Rotate the per-node key (old key stops working immediately; new key returned once)',
        description: 'Optional `keyTtlSec` (1 s … 90 days) sets the new expiry; omitted uses `AGIL_NODE_KEY_TTL_SEC` (0 = no expiry). Leader-only (standby Core: 409 `not_leader`).',
        security: API_KEY_SECURITY,
        parameters: [pathParam('nodeId', 'Node id')],
        requestBody: bodyExample('NodeRotateKeyRequest', { keyTtlSec: 7_776_000 }, false),
        responses: { '200': json('NodeKeyRotationResponse', 'New per-node key (shown once)'), '503': REGISTRY_UNAVAILABLE_RESPONSE },
      }),
    },
    '/v1/admin/node-modules/catalog': {
      get: op({
        tags: ['Admin'],
        summary: 'Allowlisted node add-on modules (id/image/ports/env hints)',
        description:
          'The Core allowlist: `egress`, `stt`, `recorder`, `turn`, `sip`, `ingress`, and `sfu`. Each entry carries the canonical image, '
          + 'the allowlisted Docker repository, default ports, supported actions and env variable **hints** '
          + '(names/required/secret flags — never values or secrets). The dashboard must render this catalog and may '
          + 'only queue actions by module id; it can never submit an image. Recorder exposes lifecycle actions for existing containers only.',
        security: API_KEY_SECURITY,
        responses: { '200': json('NodeModuleCatalogResponse', 'Module catalog (no secret values)') },
      }),
    },
    '/v1/admin/nodes/{nodeId}/modules': {
      get: op({
        tags: ['Admin'],
        summary: "One node's reported modules + queued commands",
        description:
          'Last module inventory reported by the node (absent → `[]`, never fabricated) plus commands that are '
          + 'queued but not yet delivered. Includes in-flight commands awaiting a result. '
          + '`GET /v1/admin/nodes` also carries the same `modules` array on each node.',
        security: API_KEY_SECURITY,
        parameters: [pathParam('nodeId', 'Node id')],
        responses: { '200': json('NodeModulesResponse', 'Node module inventory + pending commands') },
      }),
    },
    '/v1/admin/nodes/{nodeId}/modules/{moduleId}/actions': {
      post: op({
        tags: ['Admin'],
        summary: 'Queue an approved action for a node module',
        description:
          'Catalog actions accept `{action}`. The image for `install` comes from the Core catalog. '
          + 'Locally approved custom containers accept start, stop and restart with the current `targetContainerId` from the inventory. '
          + 'Operator-managed LiveKit Ingress requires the same exact Docker target and supports start, stop and restart. '
          + 'Official LiveKit Egress and SIP containers are read-only (`module_compose_read_only`). Earlier installed AGIL worker containers retain lifecycle controls. '
          + 'An opted-in external LiveKit SFU accepts start, graceful stop and restart during maintenance with a fresh inventory and exact Docker target. '
          + 'Start requires a stopped container. Stop and restart require `sfuDrainState: available` and may return a running result while LiveKit waits for participants. '
          + 'For restart, the Core delivers a separate start after the same target reports stopped. Keep maintenance until the node reports fresh readiness. '
          + 'An isolated container installed from a local template can also be removed when the node reports `templateRemovable`. '
          + 'Custom installation requires the matching `expectedImage` from a fresh cached and installable node template. '
          + 'An exact `targetContainerId` on a custom install requests replacement of a running isolated template container. '
          + 'The node checks local approval and runs the exact cached image in a fixed isolated profile. '
          + 'Stale or changed targets are rejected with `module_target_changed`. The command is '
          + 'delivered exactly once on the node\'s next heartbeat (TTL 5 min, max 16 per node). Unknown modules are '
          + '404, unknown/unsupported actions 400, an active command for the module 409 '
          + '`module_command_pending`, a full queue 409 `module_queue_full`, unavailable module management 409 '
          + '`node_modules_unavailable` and a disabled node 409 `node_disabled`. Auto-start actions require an installed module with a manageable restart '
          + 'policy (`module_autostart_unavailable` otherwise). Leader-only (standby Core: 409 '
          + '`not_leader`); every queued command is audited as `cluster.node.module.command`.',
        security: API_KEY_SECURITY,
        parameters: [pathParam('nodeId', 'Node id'), pathParam('moduleId', 'Catalog or operator-managed inventory id')],
        requestBody: bodyExample('NodeModuleActionRequest', { action: 'restart' }),
        responses: {
          '201': json('NodeModuleActionResponse', 'Command queued for the next heartbeat'),
          '409': {
            description: '`module_command_pending` / `module_queue_full` / `node_disabled` / `node_modules_unavailable` / `module_autostart_unavailable` / `module_target_changed` / `module_compose_read_only` / `not_leader`',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } },
          },
          '503': REGISTRY_UNAVAILABLE_RESPONSE,
        },
      }),
    },
    '/v1/admin/scale/turn/test': {
      post: op({
        tags: ['Admin'],
        summary: 'Validate one TURN server configuration (no real allocation in the MVP)',
        security: API_KEY_SECURITY,
        requestBody: body({ type: 'object', required: ['id'], properties: { id: { type: 'string' } } } as unknown as string),
        responses: { '200': json('TurnTestResponse', 'Configuration check result') },
      }),
    },
    '/v1/admin/billing/usage': {
      get: op({
        tags: ['Admin'],
        summary: 'Metered usage for the tenant (current UTC month by default)',
        description:
          'Monthly counters persisted under `<AGIL_DATA_DIR>/billing/<tenantId>/<YYYY-MM>.json`. ' +
          '`live` includes not-yet-settled minutes of rooms that are currently occupied. ' +
          'No card data, invoices or payment provider calls exist.',
        security: API_KEY_SECURITY,
        parameters: [queryParam('month', 'UTC month YYYY-MM (default: current)', 'string')],
        responses: { '200': json('BillingUsageResponse', 'Usage + plan quota + live counters') },
      }),
    },
    '/v1/admin/billing/plan': {
      get: op({
        tags: ['Admin'],
        summary: 'Billing plan, plan catalog and current usage summary',
        security: API_KEY_SECURITY,
        responses: { '200': json('BillingPlanResponse', 'Current plan + available plans + usage') },
      }),
      patch: op({
        tags: ['Admin'],
        summary: 'Update billing plan/quotas (audited)',
        description:
          'Switching `plan` applies the catalog entitlements first; explicit fields in the body override them. ' +
          '`enabled=false` keeps metering but disables all quota enforcement. Unknown keys are rejected (no card data is accepted).',
        security: API_KEY_SECURITY,
        requestBody: bodyExample('BillingPlanPatch', { plan: 'team', enabled: true, overagePolicy: 'warn' }),
        responses: { '200': json('BillingPlanResponse', 'Updated plan') },
      }),
    },
    '/v1/cluster/join': {
      post: op({
        tags: ['Cluster'],
        summary: 'Standby Core joins with a one-time core enrollment token',
        description:
          'Token-only machine endpoint (no admin key). Token kind must be `core`; the tenant comes from the token, never from headers. ' +
          'The standby is listed in `GET /v1/admin/cluster/status`. With `AGIL_REDIS_URL` set, leadership is a Redis lease: ' +
          'a standby acquires it after the leader dies (no room-state replication — see docs/ha-leader.md). ' +
          'Optional IP fence: `AGIL_ENROLL_ALLOW_IPS`. A non-leader Core rejects this with 409 `not_leader`.',
        requestBody: bodyExample('ClusterJoinRequest', { token: 'agil_enr_…', nodeId: 'standby-1', version: '0.1.0', region: 'ru-msk' }),
        responses: { '200': json('ClusterJoinResponse', 'Standby registered'), '503': REGISTRY_UNAVAILABLE_RESPONSE },
      }),
    },
    '/v1/nodes/register': {
      post: op({
        tags: ['Cluster'],
        summary: 'Node enrolls with a one-time node token and receives its per-node key once',
        description:
          'Token-only machine endpoint. Role/features are scoped by the token (features must be a subset). ' +
          '`nodeKey` is returned exactly once and stored hashed. Optional `keyTtlSec` sets its lifetime (default `AGIL_NODE_KEY_TTL_SEC`, 0 = no expiry); rotate via `POST /v1/admin/nodes/{nodeId}/rotate-key`. ' +
          'Optional IP fence: `AGIL_ENROLL_ALLOW_IPS`. Standby Core: 409 `not_leader`.',
        requestBody: bodyExample('NodeRegisterRequest', {
          token: 'agil_enr_…', nodeId: 'edge-1', role: 'sfu', name: 'Edge SFU',
          features: ['sfu', 'egress'], capacity: { maxRooms: 5, maxParticipants: 300 },
          endpoint: 'https://sfu-1.example:7880', healthPath: '/health', region: 'ru-msk',
        }),
        responses: { '201': json('NodeRegistrationResponse', 'Node registered; nodeKey shown once'), '503': REGISTRY_UNAVAILABLE_RESPONSE },
      }),
    },
    '/v1/nodes/{nodeId}/heartbeat': {
      post: op({
        tags: ['Cluster'],
        summary: 'Node liveness/capacity heartbeat (x-node-token)',
        description:
          'Authenticated by the per-node key (header `x-node-token` or `Authorization: Bearer`), bound to this node id. ' +
          'Two rate limiters protect the endpoint: an outer bucket charged **before** credential validation (per client IP, ' +
          '`AGIL_HEARTBEAT_IP_RATE_LIMIT_PER_MIN`, default 600/min — a 61-node fleet behind one NAT needs ~122/min) and a ' +
          'per-node bucket charged only after the credential authenticates (`AGIL_HEARTBEAT_RATE_LIMIT_PER_MIN`, default 10/min; keyed by tenant id + node id, so the same node id in two tenants gets independent buckets). ' +
          'Invalid or missing keys therefore cannot mint per-node buckets. Expired keys return 401 (rotate them). ' +
          'Optional `metrics` carries live node statistics (CPU/memory %, load1, active rooms/participants, bandwidth, uptime, agent version, `reportedAt`). ' +
          'Every metric field is optional and values are range-validated; a report is merged into the previous snapshot, and the server never invents or zero-fills a metric. ' +
          '`node.metrics` is absent until the node sends its first report. Old agents that send only `capacity`/`status` stay compatible. ' +
          'Optional `modules` is the full module inventory snapshot: omitted keeps the previous one, `[]` honestly means "none installed". ' +
          'Reserved catalog ids require their allowlisted image repository. Other valid ids appear in inventory, with optional locally approved lifecycle control. ' +
          'Optional `moduleResults` acknowledges commands received on an earlier heartbeat (`{commandId, ok, status, error?}`); unknown/expired command ids are ignored. ' +
          'The response always carries `moduleCommands`: commands to execute now, each delivered exactly once (TTL 5 min; a graceful `status: "offline"` beat receives none).',
        security: [],
        parameters: [
          pathParam('nodeId', 'Node id returned at registration'),
          { name: 'x-node-token', in: 'header', required: true, description: 'Per-node key (`nk_…`) returned once at registration', schema: { type: 'string' } },
        ],
        requestBody: bodyExample('NodeHeartbeatRequest', {
          capacity: { maxParticipants: 300 },
          status: 'online',
          metrics: {
            cpuPercent: 12.5, memoryPercent: 43, load1: 0.42, activeRooms: 3, participants: 17,
            bandwidthMbps: 12.5, uptimeSec: 86400, version: '0.1.0', reportedAt: 1732230000000,
          },
          modules: [
            { id: 'egress', image: 'agil/node-egress:0.1.0', status: 'running', health: 'healthy', version: '0.1.0', ports: [] },
          ],
          moduleResults: [
            { commandId: 'nmc_0123456789abcdef', ok: true, status: 'running' },
          ],
        }, false),
        responses: { '200': json('NodeHeartbeatResponse', 'Heartbeat accepted'), '503': REGISTRY_UNAVAILABLE_RESPONSE },
      }),
    },
    '/v1/admin/routes': {
      get: op({
        tags: ['Admin'],
        summary: 'List tenant routing rules (secret-free views; docs/routing.md)',
        description:
          'Every rule is tenant-scoped. RTMP destinations are rendered as `urlHost` + `hasSecret`; the URL/stream key is never returned.',
        security: API_KEY_SECURITY,
        responses: { '200': { description: 'Routing rules' } },
      }),
      post: op({
        tags: ['Admin'],
        summary: 'Create a routing rule (edge/room/participant source → room + RTMP/HLS/recording)',
        description:
          'At most one room destination; at most 8 destinations. `priority` 0..1000, lower wins. The RTMP URL is SSRF-checked and never echoed back.',
        security: API_KEY_SECURITY,
        requestBody: body({ type: 'object', additionalProperties: true }),
        responses: { '200': { description: 'Created route (secret-free)' } },
      }),
    },
    '/v1/admin/routes/{routeId}': {
      get: op({
        tags: ['Admin'],
        summary: 'Read one routing rule (includes the sanitized `lastRun`)',
        security: API_KEY_SECURITY,
        parameters: [pathParam('routeId', 'Route id')],
        responses: { '200': { description: 'Route' }, '404': { description: 'Route not found (also for a foreign tenant)' } },
      }),
      patch: op({
        tags: ['Admin'],
        summary: 'Deep-partial update of a routing rule',
        description:
          'Scalars merge; `source` merges by field; `destinations` replaces the list and each entry merges by array position; `recording:null` removes it.',
        security: API_KEY_SECURITY,
        parameters: [pathParam('routeId', 'Route id')],
        requestBody: body({ type: 'object', additionalProperties: true }),
        responses: { '200': { description: 'Updated route' }, '400': { description: 'Validation failed' } },
      }),
      delete: op({
        tags: ['Admin'],
        summary: 'Delete a routing rule (running egress jobs are not stopped automatically)',
        security: API_KEY_SECURITY,
        parameters: [pathParam('routeId', 'Route id')],
        responses: { '200': { description: '`{deleted:true,id}`' } },
      }),
    },
    '/v1/admin/routes/{routeId}/test': {
      post: op({
        tags: ['Admin'],
        summary: 'Evaluate a route (dry run with `apply:false`, otherwise starts egress)',
        description:
          'Reports `matched`/`disabled`/`shadowedBy`, the resolved room, effective destinations and `egress.status` (`started|pending|partial|unavailable|failed|skipped`). `egress_unavailable` never fails the request.',
        security: API_KEY_SECURITY,
        parameters: [pathParam('routeId', 'Route id')],
        requestBody: body({ type: 'object', additionalProperties: true }, false),
        responses: { '200': { description: 'Evaluation result (secret-free)' } },
      }),
    },
    '/v1/admin/routes/edge-tokens': {
      get: op({
        tags: ['Admin'],
        summary: 'List Edge enrollment tokens (hashes/plaintext are never returned)',
        security: API_KEY_SECURITY,
        responses: { '200': { description: 'Enrollment tokens' } },
      }),
      post: op({
        tags: ['Admin'],
        summary: 'Issue an Edge enrollment token (plaintext returned exactly once)',
        description: 'Optional `edgeId`/`tag` binding, `uses` (1..100) and `ttlSec` (60 s … 30 days).',
        security: API_KEY_SECURITY,
        requestBody: body({ type: 'object', additionalProperties: true }, false),
        responses: { '200': { description: '`{token, enrollment}`' } },
      }),
    },
    '/v1/admin/routes/edge-tokens/{tokenId}': {
      delete: op({
        tags: ['Admin'],
        summary: 'Revoke an Edge enrollment token',
        security: API_KEY_SECURITY,
        parameters: [pathParam('tokenId', 'Enrollment token id')],
        responses: { '200': { description: '`{revoked:true, token}`' }, '404': { description: 'Token not found' } },
      }),
    },
    '/v1/edge/join': {
      post: op({
        tags: ['Edge'],
        summary: 'Redeem an Edge enrollment token → room + join token + secret-free destinations',
        description:
          'Machine surface: the enrollment token (`agil_edge_…`) is the only credential and scopes the tenant. ' +
          'The Edge publishes media once into `roomId`; the server starts RTMP/HLS/recording egress from that room. ' +
          'An unavailable egress worker is reported as `egress_unavailable` and never blocks the join. ' +
          'Rate-limited per IP; optional `AGIL_ENROLL_ALLOW_IPS` applies.',
        security: [],
        requestBody: body({ type: 'object', required: ['token'], properties: { token: { type: 'string' }, edgeId: { type: 'string' }, tag: { type: 'string' }, name: { type: 'string' } } }),
        responses: {
          '200': { description: 'Join info (no RTMP URL/stream key)' },
          '401': { description: 'Invalid/expired/used/revoked enrollment token' },
          '404': { description: 'No enabled routing rule matches this Edge (`no_route`)' },
        },
      }),
    },
    '/v1/admin/flows': {
      get: op({
        tags: ['Admin'],
        summary: 'List tenant media flows (secret-free views with an execution plan; docs/flows.md)',
        description:
          'A flow maps one or more sources (room/edge/participant/rtmp|srt|hls ingest/file/sip) through processors (layout, audio mix, optional transcode) to sinks (room, rtmp, hls, srt, recording, cdn, webhook). ' +
          'Each view includes a capability `plan`: adapters this build cannot execute are `pending` and are never started.',
        security: API_KEY_SECURITY,
        responses: { '200': { description: 'Flows' } },
      }),
      post: op({
        tags: ['Admin'],
        summary: 'Create a media flow (branching, fan-in, processors, triggers, fallback)',
        description:
          'Priority 0..1000 (lower wins). `triggers` are `manual`, `room_start`, `edge_online`, `schedule`. ' +
          'Sinks are fanned out from one mix; several sources must resolve to the same room (cross-room mixing is a pending adapter). ' +
          'RTMP/SRT URLs are SSRF-checked and never echoed back; `secretRef` must name an `AGIL_ROUTE_SECRET_*` variable.',
        security: API_KEY_SECURITY,
        requestBody: body({ type: 'object', additionalProperties: true }),
        responses: {
          '200': { description: 'Created flow (secret-free, with the computed plan)' },
          '400': { description: 'Validation failed (shape, SSRF/secret policy, fallback chain)' },
        },
      }),
    },
    '/v1/admin/flows/{flowId}': {
      get: op({
        tags: ['Admin'],
        summary: 'Read one media flow (includes the sanitized `lastRun`)',
        security: API_KEY_SECURITY,
        parameters: [pathParam('flowId', 'Flow id')],
        responses: { '200': { description: 'Flow' }, '404': { description: 'Flow not found (also for a foreign tenant)' } },
      }),
      patch: op({
        tags: ['Admin'],
        summary: 'Deep-partial update of a media flow',
        description:
          'Scalars merge and arrays replace the whole list. A managed RTMP source is revoked before disabling, changing its target room, or replacing the source.',
        security: API_KEY_SECURITY,
        parameters: [pathParam('flowId', 'Flow id')],
        requestBody: body({ type: 'object', additionalProperties: true }),
        responses: { '200': { description: 'Updated flow' }, '400': { description: 'Validation failed' }, '409': { description: 'Core is not leader or RTMP revocation is pending' } },
      }),
      delete: op({
        tags: ['Admin'],
        summary: 'Delete a media flow (running egress jobs are not stopped automatically)',
        description: 'Managed RTMP receiver revocation must be confirmed before deleting the flow.',
        security: API_KEY_SECURITY,
        parameters: [pathParam('flowId', 'Flow id')],
        responses: { '200': { description: '`{deleted:true,id}`' }, '409': { description: 'Core is not leader or RTMP revocation is pending' } },
      }),
    },
    '/v1/admin/flows/{flowId}/rtmp-ingress': {
      post: op({
        tags: ['Admin'], summary: 'Provision a managed RTMP push receiver',
        description: 'Use a flow with one rtmp_ingest source in push mode and one room sink in the same SFU room. Only the active Core issues credentials.',
        security: API_KEY_SECURITY, parameters: [pathParam('flowId', 'Flow id')],
        responses: {
          '201': {
            description: 'Publisher credentials returned once',
            content: { 'application/json': { schema: {
              type: 'object', required: ['url', 'streamKey'],
              properties: { url: { type: 'string' }, streamKey: { type: 'string', format: 'password' } },
            } } },
          },
          '404': { description: 'Managed flow or tenant-owned room not found' },
          '409': { description: 'Disabled flow, existing receiver, or Core is not leader' },
          '503': { description: 'Shared storage or LiveKit Ingress unavailable' },
        },
      }),
      get: op({
        tags: ['Admin'], summary: 'Read the managed RTMP receiver status without credentials',
        security: API_KEY_SECURITY, parameters: [pathParam('flowId', 'Flow id')],
        responses: {
          '200': {
            description: 'Receiver status',
            content: { 'application/json': { schema: {
              type: 'object', required: ['roomId', 'status'], properties: {
                roomId: { type: 'string' },
                status: { type: 'string', enum: ['absent', 'provisioning', 'revoking', 'missing', 'waiting', 'buffering', 'publishing', 'failed', 'finished', 'unknown'] },
              },
            } } },
          },
          '404': { description: 'Managed flow not found' },
          '409': { description: 'Core is not leader' },
          '503': { description: 'Shared storage or LiveKit Ingress unavailable' },
        },
      }),
      delete: op({
        tags: ['Admin'], summary: 'Revoke a managed RTMP publisher key while keeping its flow definition',
        security: API_KEY_SECURITY, parameters: [pathParam('flowId', 'Flow id')],
        responses: {
          '200': { description: '`{revoked:true}`' },
          '404': { description: 'Managed flow not found' },
          '409': { description: 'Core is not leader or revocation is pending' },
          '503': { description: 'Shared storage or LiveKit Ingress unavailable' },
        },
      }),
    },
    '/v1/admin/flows/{flowId}/srt-ingress': pullIngressPaths('SRT'),
    '/v1/admin/flows/{flowId}/hls-ingress': pullIngressPaths('HLS'),
    '/v1/admin/flows/{flowId}/test': {
      post: op({
        tags: ['Admin'],
        summary: 'Evaluate a flow (dry run with `apply:false`, otherwise starts egress/delivers webhooks)',
        description:
          'Reports `matched`/`disabled`/`shadowedBy`, the mix room, per-sink status (including `pendingReason` for pending adapters), the `summary` (`started|pending|partial|unavailable|failed|skipped`), fallback selection and sanitized errors. ' +
          '`trigger` simulates a non-manual trigger and must be declared by the flow.',
        security: API_KEY_SECURITY,
        parameters: [pathParam('flowId', 'Flow id')],
        requestBody: body(
          {
            type: 'object',
            properties: {
              apply: { type: 'boolean' },
              trigger: { type: 'string', enum: ['manual', 'room_start', 'edge_online', 'schedule'] },
              roomId: { type: 'string' },
              edgeId: { type: 'string' },
              tag: { type: 'string' },
              participantId: { type: 'string' },
            },
          },
          false,
        ),
        responses: { '200': { description: 'Evaluation result (secret-free)' } },
      }),
    },
    '/v1/admin/flows/{flowId}/status': {
      get: op({
        tags: ['Admin'],
        summary: 'Flow status: adapter plan, trigger readiness, next schedule occurrence, fallback chain, last run',
        security: API_KEY_SECURITY,
        parameters: [pathParam('flowId', 'Flow id')],
        responses: { '200': { description: '`{status}`' }, '404': { description: 'Flow not found' } },
      }),
    },
    '/v1/admin/flows/tick': {
      post: op({
        tags: ['Admin'],
        summary: 'Run due schedule triggers for this tenant now (also runs in-process every 30 s)',
        description:
          'A due flow is evaluated only when its target room exists and has participants; otherwise the occurrence is reported as `skipped` and marked fired.',
        security: API_KEY_SECURITY,
        responses: { '200': { description: '`{tenantId,now,due[],evaluated[],skipped[]}`' } },
      }),
    },
    '/v1/admin/flows/edge-tokens': {
      get: op({
        tags: ['Admin'],
        summary: 'List Edge enrollment tokens (flow surface alias; hashes/plaintext are never returned)',
        security: API_KEY_SECURITY,
        responses: { '200': { description: 'Enrollment tokens' } },
      }),
      post: op({
        tags: ['Admin'],
        summary: 'Issue an Edge enrollment token for a flow-only tenant (plaintext returned exactly once)',
        security: API_KEY_SECURITY,
        requestBody: body({ type: 'object', additionalProperties: true }, false),
        responses: { '200': { description: '`{token, enrollment}`' } },
      }),
    },
    '/v1/admin/flows/edge-tokens/{tokenId}': {
      delete: op({
        tags: ['Admin'],
        summary: 'Revoke an Edge enrollment token (flow surface alias)',
        security: API_KEY_SECURITY,
        parameters: [pathParam('tokenId', 'Enrollment token id')],
        responses: { '200': { description: '`{revoked:true, token}`' }, '404': { description: 'Token not found' } },
      }),
    },
    '/openapi.json': { get: op({ tags: ['Docs'], summary: 'This OpenAPI 3.1 document', responses: { '200': { description: 'OpenAPI spec', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } } }) },
    '/openapi.admin.json': { get: op({ tags: ['Docs'], summary: 'Full OpenAPI 3.1 document (admin endpoints; internal access only)', responses: { '200': { description: 'OpenAPI spec', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } } }) },
    '/docs': { get: op({ tags: ['Docs'], summary: 'Offline API explorer (self-contained HTML)', responses: { '200': { description: 'HTML', content: { 'text/html': { schema: { type: 'string' } } } } } }) },
  };
  if (includeAdmin) return all;
  const filtered: Json = {};
  for (const [path, methods] of Object.entries(all)) {
    if (path === '/openapi.admin.json' || path.startsWith('/v1/admin/')) continue;
    filtered[path] = methods;
  }
  return filtered;
}

/** Builds the OpenAPI 3.1 document; `scope:'public'` hides admin paths and the apiKey scheme. */
export function createOpenApiSpec(options: { publicOrigin?: string; version?: string; scope?: 'public' | 'full' } = {}): Json {
  const includeAdmin = (options.scope ?? 'full') === 'full';
  const spec: Json = {
    openapi: '3.1.0',
    info: {
      title: 'AgilFrame API',
      version: options.version ?? SERVER_VERSION,
      description: [
        'AgilFrame — встраиваемая платформа видеозвонков: комнаты и WebRTC-сигналинг,',
        'чат и файлы, запись и субтитры, темы, права и аудит, AI-ассистенты, вебхуки.',
        '',
        '**С чего начать:** человекочитаемое руководство — `/docs/api-guide.md`,',
        'подробный справочник — `/docs/api.md`, контракт — `/docs/contract.md`.',
        'Интерактивный офлайн-эксплорер — `/docs` (без CDN).',
        '',
        '**Авторизация:** `x-api-key` — админский ключ тенанта, только с сервера',
        '(никогда не отдавайте его в браузер); `authorization: Bearer <join token>` —',
        'короткоживущий токен участника для звонка, чата, файлов, STT и ассистента.',
        '`GET /openapi.json` — только публичная спека, `/openapi.admin.json` — полная',
        '(доступ управляется `AGIL_DOCS_*` / `AGIL_ADMIN_*`).',
        '',
        '**Ошибки:** всегда `{error:{code,message}}`; коды — `unauthorized`, `forbidden`,',
        '`validation_failed`, `password_required`, `password_invalid`, `geo_blocked`,',
        '`room_locked`, `room_full`, `rate_limited`, `not_found`, `feature_disabled`,',
        '`provider_failed`, `stt_not_configured`, `internal_error`.',
        '',
        'WebSocket-сигналинг — `/ws?token=<join token>` (см. docs/api.md §10).',
      ].join('\n'),
      'x-websocket': {
        path: '/ws',
        auth: 'token query param or anonymous room/tenant/name when AGIL_ALLOW_ANONYMOUS=1',
        messages: ['hello', 'sdp', 'ice', 'chat', 'state', 'reaction', 'caption', 'integrity', 'location', 'ping', 'history', 'bye', 'analysis-request', 'assistant-query'],
      },
    },
    servers: [{ url: options.publicOrigin ?? 'http://localhost:8787', description: 'AgilFrame server' }],
    tags: [
      { name: 'Public', description: 'Доступно без авторизации: здоровье, ICE, публичный конфиг, фоны' },
      { name: 'Config', description: 'Конфигурация тенанта (темы, фичи, безопасность, провайдеры)' },
      { name: 'Rooms', description: 'Создание комнат и токенов (комнаты — in-memory)' },
      { name: 'Join', description: 'Вход в звонок, чат и AI-ассистент от имени участника' },
      { name: 'Files', description: 'Файлы: подписанные ссылки, лимиты, feature-gating' },
      { name: 'Recordings', description: 'Записи звонков (серверное хранилище)' },
      { name: 'STT', description: 'Серверный speech-to-text (501, если не настроен)' },
      { name: 'Admin', description: 'Админ API тенанта: x-api-key, только с сервера' },
      { name: 'Cluster', description: 'Enrollment токенов и реестр узлов/резервных Core (docs/api/cluster.md)' },
      { name: 'Docs', description: 'OpenAPI и офлайн-эксплорер' },
      { name: 'SCIM', description: 'SCIM 2.0 directory: Users/Groups (Bearer AGIL_SCIM_TOKEN + x-tenant-id)' },
    ],
    security: [],
    paths: paths(includeAdmin),
    components: components(includeAdmin),
  };
  return localizeSpec(spec);
}

/* ------------------------------------------------------------------ */
/* Russian summaries / descriptions for humans (docs § api-guide)      */
/* ------------------------------------------------------------------ */

const RU_SUMMARIES: Record<string, string> = {
  'Access policy + effective features per role': 'Политика доступа: права ролей и эффективные фичи',
  'AI agent settings (secret only as env var name)': 'Настройки AI-агента (секрет — только имя env)',
  'Capability provider status per slot': 'Статус слотов заменяемых провайдеров',
  'Chat history': 'История чата комнаты',
  'Close a room': 'Закрыть комнату',
  'Close room': 'Закрыть комнату (admin)',
  'Compliance report, findings and notes': 'Комплаенс-отчёт, находки и заметки',
  'Create a custom role': 'Создать кастомную роль',
  'Create a room (anonymous allowed when AGIL_ALLOW_ANONYMOUS=1)': 'Создать комнату (анонимно при AGIL_ALLOW_ANONYMOUS=1)',
  'Create a room; password is stored as a scrypt hash only': 'Создать комнату; пароль хранится только scrypt-хэшем',
  'Create an invite link+token': 'Создать инвайт-ссылку и токен',
  'Deep-partial config update (theme, features, security, providers, integrations)': 'Частичное обновление конфига (тема, фичи, безопасность, провайдеры)',
  'Delete a custom role (participants fall back to its baseRole)': 'Удалить кастомную роль (участники откатываются на baseRole)',
  'Delete a recording': 'Удалить запись',
  'Disconnect a participant': 'Отключить участника (kick)',
  'Download a file via signed URL': 'Скачать файл по подписанной ссылке',
  'Download a recording via signed URL': 'Скачать запись по подписанной ссылке',
  'Force a pipeline run (local rules + AI agent)': 'Принудительный прогон анализа (правила + AI)',
  'Mint a signed HLS/MP4 playback link (host/moderator or admin key)': 'Выпустить подписанную ссылку на HLS/MP4 (host/moderator или админ-ключ)',
  'Fetch a signed HLS playlist (public capability URL; segments rewritten to signed URLs)': 'Получить подписанный HLS-плейлист (публичная capability-ссылка; сегменты переписаны на подписанные URL)',
  'Fetch a signed HLS segment (supports one Range)': 'Получить подписанный HLS-сегмент (поддерживает один Range)',
  'Download a signed MP4 recording (supports one Range)': 'Скачать подписанную MP4-запись (поддерживает один Range)',
  'Controller status + optional worker health probe (registration is Redis/psrpc)': 'Статус контроллера + опциональная проверка health воркера (регистрация — Redis/psrpc)',
  'List (default) or stop active egress jobs older than a threshold': 'Показать (по умолчанию) или остановить активные egress-задачи старше порога',
  'Full OpenAPI 3.1 document (admin endpoints; internal access only)': 'Полная OpenAPI 3.1 спека (admin; только внутренний доступ)',
  'ICE servers for RTCPeerConnection': 'ICE-серверы для RTCPeerConnection (STUN + TURN-пул)',
  'Start dashboard SSO: state+nonce+PKCE → IdP authorization URL': 'Начать вход в панель через SSO: state+nonce+PKCE → authorization URL IdP',
  'OIDC redirect URI: code exchange + id_token verification → admin session': 'Redirect URI OIDC: обмен кода + проверка id_token → admin-сессия',
  "In-call AI assistant acting with the participant's permissions": 'AI-ассистент в звонке с правами участника',
  'In-call assistant settings': 'Настройки in-call ассистента',
  'Inject a chat message with a join token (external chat bridge; idempotent on id)': 'Отправить сообщение в чат звонка (внешний чат; идемпотентно по id)',
  'Issue a join token with pinned permissions (admin)': 'Выдать join-токен с фиксированными правами (admin)',
  'Join a room: password, lock, capacity, geo policy, rate limit; returns a join token': 'Войти в комнату: пароль, lock, лимит, гео, rate-limit; возвращает join-токен',
  'Knowledge agent settings': 'Настройки knowledge-агента',
  'KPI overview': 'Обзор KPI тенанта',
  'List recordings': 'Список записей',
  'List quarantined uploads (metadata only; payloads are never served)': 'Список карантина (только метаданные, payload не отдаётся)',
  'Purge a quarantined upload (tenant-scoped)': 'Удалить файл из карантина (в рамках тенанта)',
  'Issue a server-side liveness challenge (advisory; 501 when not configured)': 'Выдать серверный liveness-челлендж (advisory; 501 без движка)',
  'Verify a liveness attempt with browser-reported signals (advisory)': 'Проверить liveness-попытку по сигналам браузера (advisory)',
  'List rooms': 'Список комнат',
  'List shared files': 'Список файлов',
  'Liveness + security flags': 'Проверка живости и флаги безопасности',
  'Lock/unlock a room': 'Заблокировать/разблокировать комнату',
  'Merge AI agent settings into session.aiAgent': 'Обновить настройки AI-агента (merge в session.aiAgent)',
  'Merge in-call assistant settings into session.inCallAgent': 'Обновить настройки in-call ассистента',
  'Merge knowledge agent settings into session.knowledgeAgent': 'Обновить настройки knowledge-агента',
  'Merge provider slots into config.providers (external endpoints pass SSRF policy)': 'Обновить слоты провайдеров (URL проходят SSRF-политику)',
  'Merge scale configuration (media mode, TURN pool, signaling nodes, SFU, webinar, streaming, CDN)': 'Обновить конфигурацию масштабирования (media mode, TURN, узлы, SFU, вебинары)',
  'Merge the access policy (audit access.updated)': 'Обновить политику доступа (аудит access.updated)',
  'Offline API explorer (self-contained HTML)': 'Офлайн API-эксплорер (self-contained HTML)',
  'Paginated audit log (IP hashes only)': 'Аудит-лог с пагинацией (IP только в виде хэша)',
  'Participant locations (GPS coordinates are admin-only)': 'Локации участников (GPS-координаты — только admin)',
  'Post a chat message as the company bot/CRM (no token needed)': 'Сообщение в чат от бота/CRM компании (без токена)',
  'Proxy a question to the corporate knowledge agent': 'Проксировать вопрос корпоративному knowledge-агенту',
  'Public tenant config (theme, features)': 'Публичный конфиг тенанта (тема, фичи)',
  'Replace tenant config': 'Заменить конфиг тенанта',
  'Replace webhook endpoints (URL policy enforced)': 'Заменить вебхук-эндпоинты (SSRF-политика)',
  'Roles: built-in host/moderator/guest + custom roles': 'Роли: встроенные host/moderator/guest + кастомные',
  'Room detail: participants, chat, links': 'Детали комнаты: участники, чат, ссылки',
  'Room info + participants': 'Информация о комнате и участники',
  'Scale-out status: media mode, cluster registry, TURN pool, SFU/webinar/streaming flags, MVP limitations': 'Статус масштабирования: media mode, кластер, TURN-пул, SFU/вебинары, ограничения MVP',
  'Security overview (failed joins, geo blocks, suspicious participants)': 'Обзор безопасности (неудачные join, гео-блоки, подозрительные участники)',
  'Send a test security.event delivery': 'Тестовая доставка security.event вебхука',
  'Server-side speech-to-text: local whisper.cpp/faster-whisper or remote provider (501 when not configured)': 'Серверный speech-to-text: локальный whisper.cpp/faster-whisper или внешний провайдер (501, если не настроен)',
  'Participant transcript: timestamps, machine translations, retention/consent policy': 'Транскрипт участника: таймстемпы, машинный перевод, retention/consent',
  "Grant or withdraw transcription consent (withdrawal erases this participant's segments)": 'Дать или отозвать согласие на расшифровку (отзыв удаляет сегменты участника)',
  "Translate one line with the tenant's local/LLM engine (browser-STT captions, re-translation)": 'Перевести одну строку локальным/LLM-движком тенанта (браузерный STT, повторный перевод)',
  'Local STT/translation status with actionable reasons (no secrets, no model paths)': 'Статус локального STT/перевода с причинами (без секретов и путей к моделям)',
  'Signaling cluster status (MVP: single node, multiNodeActive=false)': 'Статус кластера сигналинга (MVP: single-node)',
  'Test a provider slot (builtin probe or signed external test envelope)': 'Проверить слот провайдера (builtin или подписанный тест)',
  'This OpenAPI 3.1 document': 'Эта OpenAPI 3.1 спека (только публичные пути)',
  'Verify a corporate OIDC identity JWT (SSO; no tokens issued)': 'Проверить корпоративную OIDC-идентичность (SSO; без выдачи токенов)',
  'Transcript segments': 'Сегменты транскрипта',
  'Update a custom role (built-ins are read-only here)': 'Обновить кастомную роль (встроенные — read-only)',
  'Upload a chat attachment (raw body, ≤ session.fileShare.maxFileSizeMb)': 'Загрузить файл в чат (raw body, лимит из конфига)',
  'Upload a recording (raw webm/mp4 + x-recording-meta)': 'Загрузить запись (raw webm/mp4 + x-recording-meta)',
  'Validate one TURN server configuration (no real allocation in the MVP)': 'Проверить конфигурацию TURN (без реального allocate)',
  'Virtual background library (builtin config or external provider)': 'Библиотека виртуальных фонов (builtin или внешний провайдер)',
  'Webhook endpoints + recent deliveries': 'Вебхук-эндпоинты и последние доставки',
};

const RU_OPERATION_DESCRIPTIONS: Record<string, string> = {
  'POST /v1/auth/oidc/verify': 'Проверяет подпись OIDC-JWT (RS256/ES256) по JWKS тенанта, issuer/audience/exp/nbf и маппинг claims — без выдачи join-токена. Токен не логируется и не пишется в аудит.',
  'POST /v1/rooms': 'Вызывается сервером компании. Создаёт комнату и (для открытых комнат) сразу возвращает join-токен, joinUrl и embedUrl. Пароль комнаты хранится только хэшем.',
  'POST /v1/tokens': 'Вызывается сервером компании. Выдаёт короткоживущий токен участника с `permissions` (или правами роли, включая кастомную `roleId`). Токен передаётся браузеру; админский ключ — никогда.',
  'POST /v1/rooms/{roomId}/join': 'Вызывается браузером/сервером компании. Проверяет пароль, lock, гео-политику, лимит участников и rate-limit; возвращает токен и эффективные права для UI.',
  'POST /v1/rooms/{roomId}/chat': 'Вызывается сервером компании (внешний чат/бот) с join-токеном. Сообщение бродкастится в звонок, пишется в историю, уходит вебхуком chat.message; повтор с тем же `id` не дублирует.',
  'POST /v1/rooms/{roomId}/assistant': 'Вызывается браузером с join-токеном. Ассистент отвечает от имени пользователя: сервер фильтрует предложенные действия по эффективным правам; `mode:local` — 501, движок в виджете.',
  'POST /v1/admin/roles': 'Вызывается дашбордом/админом компании. Создаёт кастомную роль с набором фич; до 30 ролей, встроенные id зарезервированы.',
  'PUT /v1/admin/scale': 'Вызывается админом/DevOps. Обновляет конфигурацию масштабирования (TURN-пул влияет на welcome.iceServers, maxParticipants — на комнаты); кластер/SFU/стриминг только декларируются.',
  'POST /v1/files': 'Вызывается браузером с join-токеном. Требует features.fileShare и права fileShare; возвращает запись с подписанной ссылкой.',
  'GET /v1/admin/audit': 'Отдаёт аудит текущей организации и хэши IP. Фильтры type/severity/roomId и поиск q применяются перед пагинацией limit/offset.',
};

function localizeSpec(spec: Json): Json {
  const localized = JSON.parse(JSON.stringify(spec)) as Json;
  const specPaths = (localized.paths ?? {}) as Record<string, Record<string, Json>>;
  for (const [path, methods] of Object.entries(specPaths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!operation || typeof operation !== 'object') continue;
      const summary = typeof operation.summary === 'string' ? operation.summary : '';
      const translated = RU_SUMMARIES[summary];
      if (translated) operation.summary = translated;
      const description = RU_OPERATION_DESCRIPTIONS[`${method.toUpperCase()} ${path}`];
      if (description) {
        operation.description = operation.description
          ? `${description}\n\n${String(operation.description)}`
          : description;
      }
    }
  }
  return localized;
}


const EXPLORER_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AgilFrame — документация API</title>
<style>
  :root { color-scheme: light dark; --bg:#0f1115; --panel:#171a21; --text:#e8eaf0; --muted:#aab3c2; --accent:#9cc0ff; --accent-strong:#1d4ed8; --ok:#4ade80; --err:#ff7b81; --border:#3f4655; --placeholder:#a3abba; --get:#5ee39a; --post:#8ab4ff; --put:#e0b45c; --patch:#d8a0ff; --delete:#ff7b81; }
  @media (prefers-color-scheme: light) { :root { --bg:#f5f6f8; --panel:#fff; --text:#111827; --muted:#4b5563; --accent:#1d4ed8; --accent-strong:#1d4ed8; --ok:#15803d; --err:#b91c1c; --border:#b9c1cd; --placeholder:#4b5563; --get:#0a7a43; --post:#1d4ed8; --put:#8a5a00; --patch:#6b21a8; --delete:#b91c1c; } }
  * { box-sizing: border-box; }
  html, body { max-width:100%; overflow-x:hidden; }
  body { margin:0; font:14px/1.45 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--text); }
  header { display:flex; gap:12px; align-items:center; justify-content:space-between; padding:12px 20px; border-bottom:1px solid var(--border); background:var(--panel); flex-wrap:wrap; max-width:100%; }
  h1 { font-size:16px; margin:0; overflow-wrap:anywhere; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; width:100%; }
  .row > input, .row > select, .row > label, .row > button, .row > a { flex:1 1 170px; min-width:0; max-width:100%; }
  .row > .check { flex:0 1 auto; }
  .connection-settings { flex:1 1 100%; }
  .connection-settings summary { cursor:pointer; color:var(--accent); padding:4px 0; }
  .connection-settings .row { margin-top:8px; }
  .connection-settings p { margin:8px 0 0; color:var(--muted); }
  #download { display:inline-flex; min-height:40px; align-items:center; justify-content:center; padding:6px 9px; border:1px solid var(--border); border-radius:8px; color:var(--text); text-decoration:none; }
  #download[aria-disabled='true'] { opacity:.55; pointer-events:none; }
  #spec-status:empty, #connection-status:empty { display:none; }
  .check { display:inline-flex; align-items:center; gap:8px; min-height:44px; padding:8px 12px; border:1px solid var(--border); border-radius:10px; cursor:pointer; background:var(--panel); max-width:100%; position:relative; }
  .check input { position:absolute; width:1px; height:1px; opacity:0; margin:0; pointer-events:none; }
  .check .box { width:20px; height:20px; border:2px solid var(--muted); border-radius:5px; display:inline-flex; align-items:center; justify-content:center; flex:0 0 20px; background:var(--panel); }
  .check input:checked + .box { background:var(--accent-strong); border-color:var(--accent-strong); }
  .check input:checked + .box::after { content:''; width:5px; height:10px; border:solid #fff; border-width:0 2px 2px 0; transform:rotate(45deg); margin-top:-2px; }
  .check input:focus-visible + .box { outline:2px solid var(--accent); outline-offset:2px; }
  .check-text { font-size:13px; line-height:1.3; white-space:normal; overflow-wrap:anywhere; }
  @media (max-width: 600px) { .row > .check { flex:1 1 100%; } }
  input, select, textarea, button { font:inherit; color:inherit; background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:6px 9px; max-width:100%; }
  input, select, button { min-height:40px; }
  input::placeholder, textarea::placeholder { color:var(--placeholder); opacity:1; }
  textarea { width:100%; min-height:90px; font-family:ui-monospace,Consolas,monospace; font-size:12px; }
  button { cursor:pointer; }
  button.primary { background:var(--accent-strong); border-color:var(--accent-strong); color:#fff; }
  main { display:grid; grid-template-columns: 320px minmax(0,1fr); gap:16px; padding:16px 20px; max-width:100%; }
  nav { position:sticky; top:16px; align-self:start; max-height:calc(100vh - 32px); overflow:auto; padding-right:8px; min-width:0; }
  nav h3 { margin:14px 0 6px; font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
  nav a { display:block; padding:4px 8px; border-radius:6px; color:var(--text); text-decoration:none; font-size:13px; overflow-wrap:anywhere; }
  nav a:hover { background:var(--panel); }
  .quick { display:flex; flex-wrap:wrap; gap:4px; margin:0 0 10px; }
  .quick a { background:var(--panel); border:1px solid var(--border); border-radius:999px; padding:2px 9px; font-size:12px; color:var(--text); }
  .method { display:inline-block; min-width:52px; font-weight:700; font-size:12px; margin-right:6px; }
  .get { color:var(--get) } .post { color:var(--post) } .put { color:var(--put) } .patch { color:var(--patch) } .delete { color:var(--delete) }
  section.op { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:16px; margin-bottom:14px; max-width:100%; min-width:0; }
  section.op:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  section.op h2 { font-size:15px; margin:0 0 4px; overflow-wrap:anywhere; }
  .desc { color:var(--muted); margin:4px 0 12px; overflow-wrap:anywhere; }
  .field { display:grid; grid-template-columns:minmax(0,190px) minmax(0,1fr); gap:8px; align-items:start; margin-bottom:8px; min-width:0; }
  .field label { color:var(--muted); font-size:13px; padding-top:10px; overflow-wrap:anywhere; }
  pre { margin:8px 0 0; background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:10px; overflow:auto; max-height:340px; max-width:100%; font-size:12px; }
  .pill { font-size:12px; border:1px solid var(--border); border-radius:999px; padding:3px 9px; color:var(--muted); overflow-wrap:anywhere; }
  .pill:empty { display:none; }
  .err { color:var(--err); } .ok { color:var(--ok); }
  @media (max-width: 900px) { main { grid-template-columns:minmax(0,1fr); } nav { position:static; max-height:min(35vh,280px); } }
  @media (max-width: 600px) {
    header { padding:10px 12px; }
    main { padding:12px; }
    .guide { padding:12px; }
    .field { grid-template-columns:1fr; }
    .field label { padding-top:0; }
    .row > input, .row > select, .row > label, .row > button, .row > a { flex:1 1 100%; }
    .guide ul { columns:1; }
    .guide table.codes { display:block; overflow-x:auto; }
  }
  .guide { background:var(--panel); border-bottom:1px solid var(--border); max-width:100%; }
  .guide-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:18px; }
  .guide h2 { font-size:12px; margin:0 0 8px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
  .guide ul, .guide ol { margin:0 0 12px; padding-left:18px; font-size:13px; overflow-wrap:anywhere; }
  .guide li { margin-bottom:6px; }
  .guide code { background:var(--bg); border:1px solid var(--border); border-radius:4px; padding:0 4px; font-size:12px; overflow-wrap:anywhere; }
  .guide table.codes { width:100%; table-layout:fixed; border-collapse:collapse; font-size:13px; margin-bottom:12px; }
  .guide table.codes td { border-top:1px solid var(--border); padding:3px 5px; vertical-align:top; overflow-wrap:anywhere; }
  .guide a { color:var(--accent); }
  details.guide { display:block; padding:10px 20px; }
  details.guide summary { cursor:pointer; font-weight:600; color:var(--text); padding:6px 0; }
  details.guide .guide-col { margin-top:8px; }
  details.guide ul { margin:4px 0 0; padding-left:18px; font-size:13px; columns:2; }
  details.guide .guide-grid ul { columns:1; }
  .curlout { margin-top:6px; }
  @media (max-width: 1100px) { .guide-grid { grid-template-columns:1fr; } details.guide ul { columns:1; } }
</style>
</head>
<body>
<header>
  <h1>Документация API AgilFrame <span class="pill" id="ver"></span></h1>
  <div class="row">
    <input id="search" size="18" aria-label="Поиск по API" placeholder="Поиск по API…" />
    <select id="tagFilter" aria-label="Раздел API"><option value="">Все разделы</option></select>
    <label class="check" for="adminSpec" title="admin-спека: показывать /v1/admin/* методы (нужен x-api-key)">
      <input type="checkbox" id="adminSpec" />
      <span class="box" aria-hidden="true"></span>
      <span class="check-text">Показывать админские методы</span>
    </label>
    <a id="download" href="/openapi.json" download="openapi.json">Скачать OpenAPI</a>
  </div>
  <details class="connection-settings">
    <summary>Подключение к API</summary>
    <div class="row">
      <input id="server" type="url" aria-label="Адрес сервера" placeholder="Адрес сервера" />
      <input id="apiKey" type="password" autocomplete="off" aria-label="Админский ключ API" placeholder="Админский ключ API" />
      <input id="bearer" type="password" autocomplete="off" aria-label="Токен участника" placeholder="Токен участника" />
      <button id="save" class="primary">Сохранить адрес</button>
    </div>
    <p>Ключ и токен действуют до закрытия или обновления страницы. Используйте тестовые учётные данные.</p>
    <span id="connection-status" role="status"></span>
  </details>
  <span id="spec-status" role="status"></span>
</header>
<details class="guide" id="guide">
  <summary>С чего начать</summary>
  <div class="guide-grid">
  <div class="guide-col">
    <h2>Первые пять шагов</h2>
    <ol>
      <li><b>Админский ключ.</b> <code>x-api-key</code> — только на сервере компании, никогда в браузере (dev: <code>dev-key</code>).</li>
      <li><b>Создать комнату.</b> <code>POST /v1/rooms</code> → <code>room.id</code>, <code>joinUrl</code>, <code>embedUrl</code>; пароль опционален.</li>
      <li><b>Выдать токен.</b> <code>POST /v1/tokens</code> с <code>participant</code> и <code>permissions</code> (или <code>roleId</code>) → короткоживущий <code>token</code>.</li>
      <li><b>Встроить звонок.</b> SDK <code>/sdk/agilframe.js</code> (<code>AgilFrame.mount</code>) или iframe <code>/embed.html?room=…&amp;token=…</code>.</li>
      <li><b>Настроить политику.</b> <code>/v1/admin/access-policy</code>, <code>/v1/admin/roles</code>, <code>/v1/admin/providers</code>, <code>/v1/admin/scale</code>, вебхуки; следить через <code>/v1/admin/audit</code>.</li>
    </ol>
  </div>
  <div class="guide-col">
    <h2>Авторизация</h2>
    <ul>
      <li><code>x-api-key</code> — админский ключ тенанта для <code>/v1/admin/*</code> и <code>POST /v1/tokens</code>. Только сервер компании.</li>
      <li><code>authorization: Bearer &lt;join token&gt;</code> — участник: WS, чат, файлы, записи, STT, ассистент. Токен выдаёт ваш сервер.</li>
      <li><code>?sig=&amp;exp=</code> — подписанные ссылки на файлы/записи (TTL).</li>
      <li>Права = роль → исключения → права токена → запреты → включённые фичи (<code>docs/contract.md §18</code>).</li>
    </ul>
    <h2>Коды ошибок</h2>
    <table class="codes">
      <tr><td>400</td><td>validation_failed / password_required</td></tr>
      <tr><td>401</td><td>unauthorized / password_invalid</td></tr>
      <tr><td>403</td><td>forbidden / geo_blocked / feature_disabled</td></tr>
      <tr><td>404</td><td>not_found</td></tr>
      <tr><td>409</td><td>room_full</td></tr>
      <tr><td>413</td><td>file_too_large</td></tr>
      <tr><td>423</td><td>room_locked</td></tr>
      <tr><td>429</td><td>rate_limited</td></tr>
      <tr><td>501/502</td><td>stt_not_configured / provider_failed / assistant_local_only</td></tr>
    </table>
  </div>
  <div class="guide-col">
    <h2>Ссылки</h2>
    <ul>
      <li><a href="/wiki/#sdk" target="_blank" rel="noopener noreferrer">Руководство по встраиванию в Wiki</a></li>
      <li><a href="/docs/api.md" target="_blank" rel="noopener noreferrer">Полный справочник REST + WebSocket</a></li>
      <li><a href="/docs/saas.md" target="_blank" rel="noopener noreferrer">SaaS: организации и изоляция</a></li>
      <li><a href="/docs/scaling.md" target="_blank" rel="noopener noreferrer">Масштабирование, SFU и TURN</a></li>
      <li><a href="/docs/ha-leader.md" target="_blank" rel="noopener noreferrer">HA Core: лидер, standby, failover</a></li>
      <li><a href="/docs/design-system.md" target="_blank" rel="noopener noreferrer">Дизайн-система и доступность</a></li>
      <li><a href="/openapi.json" target="_blank" rel="noopener noreferrer">openapi.json (публичная спека)</a> · <a href="/openapi.admin.json" target="_blank" rel="noopener noreferrer">openapi.admin.json</a></li>
      <li><a href="/docs/mcp.md" target="_blank" rel="noopener noreferrer">Подключение MCP</a></li>
    </ul>
  </div>
  </div>
</details>
<main>
  <nav id="nav" aria-label="Методы API" tabindex="0"></nav>
  <div id="ops"></div>
</main>
<script>
(() => {
  const $ = (s) => document.querySelector(s);
  $('#server').value = location.origin;
  try {
    localStorage.removeItem('agil.docs.apiKey');
    localStorage.removeItem('agil.docs.bearer');
    $('#server').value = localStorage.getItem('agil.docs.server') || location.origin;
  } catch { /* the explorer also works with storage disabled */ }
  const serverBase = () => {
    const value = $('#server').value.trim() || location.origin;
    let url;
    try { url = new URL(value); } catch { throw new Error('Введите полный адрес сервера HTTP или HTTPS.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Введите адрес HTTP или HTTPS без учётных данных, параметров и якоря.');
    }
    let pathname = url.pathname;
    while (pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    return url.origin + pathname;
  };
  $('#save').onclick = () => {
    const status = $('#connection-status');
    try { $('#server').value = serverBase(); }
    catch (error) { status.textContent = error.message; return; }
    try {
      localStorage.setItem('agil.docs.server', $('#server').value);
      status.textContent = 'Адрес сохранён.';
    } catch { status.textContent = 'Браузер не сохранил адрес. Он доступен в этой вкладке.'; }
  };
  const uiState = { search: '', tag: '', admin: false };
  $('#search').oninput = (event) => { uiState.search = event.target.value.trim().toLowerCase(); render(); };
  $('#tagFilter').onchange = (event) => { uiState.tag = event.target.value; render(); };
  $('#adminSpec').onchange = (event) => loadSpec(event.target.checked);
  let spec = null;
  const operationForms = new Map();
  let loadRevision = 0;
  const TAG_RU = {
    Public: 'Публичные', Config: 'Конфигурация', Rooms: 'Комнаты', Join: 'Участие и звонок',
    Files: 'Файлы', Recordings: 'Записи', STT: 'Субтитры', Admin: 'Администрирование', Docs: 'Документация',
  };
  const ruTag = (tag) => TAG_RU[tag] ?? tag;
  const PARAM_RU = {
    roomId: 'ID комнаты, например 4f0c…', tenantId: 'ID тенанта (demo)', requestId: 'ID заявки',
    pollId: 'ID опроса', limit: 'Максимум записей', offset: 'Смещение', id: 'Идентификатор',
    format: 'Формат: json или md', download: '1 — скачать файлом', start: 'Начало, ISO 8601',
    durationMin: 'Длительность, минут', type: 'Тип', severity: 'info | warn | critical',
    roomIdFilter: 'Фильтр по комнате',
  };
  const INPUT_RU = { 'x-file-name': 'Имя файла', 'x-recording-meta': 'Метаданные записи', 'x-language': 'Язык' };
  const paramHint = (p) => INPUT_RU[p.name] ?? PARAM_RU[p.name] ?? (typeof p.description === 'string' && !/^[A-Za-z]/.test(p.description) ? p.description : 'значение');
  const refs = (schema, depth) => {
    if (!schema || depth > 6) return '';
    if (schema.$ref) { const name = schema.$ref.split('/').pop(); const target = spec.components.schemas[name]; return target ? refs(target, depth + 1) : ''; }
    if (schema.oneOf) return schema.oneOf.map((s) => refs(s, depth + 1)).filter(Boolean).join(' | ');
    if (schema.anyOf) return schema.anyOf.map((s) => refs(s, depth + 1)).filter(Boolean).join(' | ');
    if (schema.type === 'array') return '[' + refs(schema.items, depth + 1) + ']';
    if (schema.type === 'object' || schema.properties) {
      const props = Object.entries(schema.properties || {}).map(([k, v]) => k + (schema.required && schema.required.includes(k) ? '' : '?') + ': ' + (refs(v, depth + 1) || v.type || 'any'));
      return '{ ' + props.join(', ') + ' }';
    }
    return schema.type + (schema.enum ? ' (' + schema.enum.join(' | ') + ')' : '');
  };
  const exampleFor = (schema) => {
    if (!schema) return undefined;
    if (schema.$ref) return exampleFor(spec.components.schemas[schema.$ref.split('/').pop()]);
    if (schema.type === 'object' || schema.properties) {
      const out = {};
      for (const [k, v] of Object.entries(schema.properties || {})) { const e = exampleFor(v); if (e !== undefined) out[k] = e; }
      return out;
    }
    if (schema.type === 'integer' || schema.type === 'number') return 0;
    if (schema.type === 'boolean') return false;
    if (schema.type === 'array') return [];
    return '';
  };
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'class') node.className = v; else if (k === 'onclick') node.onclick = v; else node.setAttribute(k, v); }
    for (const child of children) node.append(child);
    return node;
  };
  const render = () => {
    if (!spec) return;
    $('#ver').textContent = spec.info.version;
    const nav = $('#nav'); nav.innerHTML = '';
    const ops = $('#ops'); ops.innerHTML = '';
    const groups = {};
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const tags = operation.tags || ['Other'];
        for (const tag of tags) (groups[tag] ||= []).push({ path, method, operation });
      }
    }
    let visible = 0;
    const quickLinks = [];
    const rendered = new Set();
    for (const [tag, items] of Object.entries(groups)) {
      if (uiState.tag && tag !== uiState.tag) continue;
      const matched = items.filter((item) => {
        if (!uiState.search) return true;
        const haystack = (item.method + ' ' + item.path + ' ' + (item.operation.summary || '') + ' ' + (item.operation.description || '')).toLowerCase();
        return haystack.includes(uiState.search);
      });
      if (matched.length === 0) continue;
      const tagId = 'tag-' + tag.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      quickLinks.push(el('a', { href: '#' + tagId }, [ruTag(tag)]));
      nav.append(el('h3', { id: tagId }, [ruTag(tag)]));
      for (const item of matched) {
        const id = 'op-' + item.method + '-' + item.path.replace(/[^a-z0-9]+/gi, '-');
        nav.append(el('a', { href: '#' + id }, [item.method.toUpperCase() + ' ' + item.path]));
        if (rendered.has(id)) continue;
        rendered.add(id);
        visible += 1;
        const existing = operationForms.get(id);
        if (existing) {
          ops.append(existing);
          continue;
        }
        const section = el('section', { class: 'op', id, tabindex: '-1' });
        section.append(el('h2', {}, [el('span', { class: 'method ' + item.method }, [item.method.toUpperCase()]), item.path]));
        section.append(el('div', { class: 'desc' }, [(item.operation.summary || '') + ' ' + (item.operation.description || '')]));
        const inputs = {};
        const form = el('div');
        const parameters = item.operation.parameters || [];
        if (parameters.length > 0) form.append(el('div', { class: 'desc', style: 'margin:0 0 8px;font-weight:600' }, ['Параметры']));
        for (const p of parameters) {
          const labelSuffix = p.in === 'path' ? ' (путь)' : p.in === 'query' ? ' (query)' : p.in === 'header' ? ' (заголовок)' : '';
          const fieldId = id + '-param-' + p.in + '-' + p.name;
          const input = el('input', {
            id: fieldId,
            'data-param': p.name,
            placeholder: paramHint(p),
            ...(p.required ? { required: 'required' } : {}),
          });
          inputs[p.in + ':' + p.name] = input;
          form.append(el('div', { class: 'field' }, [el('label', { for: fieldId }, [p.name + labelSuffix]), input]));
        }
        let bodyField = null;
        const rb = item.operation.requestBody;
        const content = rb?.content || {};
        const fileTypes = Object.keys(content).filter((type) => content[type].schema?.format === 'binary');
        const jsonType = content['application/json'] ? 'application/json' : Object.keys(content).find((type) => type.endsWith('+json'));
        const bodyType = jsonType ?? fileTypes[0];
        const isFile = fileTypes.includes(bodyType);
        if (rb) {
          const fieldId = id + '-body';
          const schema = content[bodyType]?.schema;
          bodyField = isFile ? el('input', { id: fieldId, type: 'file' }) : el('textarea', { id: fieldId });
          if (isFile && !fileTypes.includes('application/octet-stream')) bodyField.accept = fileTypes.join(',');
          if (rb.required) bodyField.required = true;
          const example = content[bodyType]?.example ?? exampleFor(schema);
          if (jsonType && example !== undefined) bodyField.value = JSON.stringify(example, null, 2);
          const label = isFile ? 'Файл' : 'Тело JSON';
          form.append(el('div', { class: 'field' }, [el('label', { for: fieldId }, [label]), bodyField]));
          if (jsonType) form.append(el('div', { class: 'desc' }, [refs(schema, 0)]));
        }
        const send = el('button', { class: 'primary' }, ['Отправить']);
        const curlButton = el('button', {}, ['Копировать curl']);
        const result = el('pre', {}, ['Нажмите «Отправить», чтобы выполнить запрос.']);
        const status = el('span', { class: 'pill', role: 'status' }, ['']);
        const buildRequest = () => {
          const server = serverBase();
          const headers = {};
          const apiKey = $('#apiKey').value.trim(); const bearer = $('#bearer').value.trim();
          if (apiKey) headers['x-api-key'] = apiKey;
          if (bearer) headers.authorization = 'Bearer ' + bearer;
          const query = new URLSearchParams();
          let execPath = item.path;
          const missing = [];
          for (const p of parameters) {
            const input = inputs[p.in + ':' + p.name];
            const value = input ? input.value.trim() : '';
            if (!value) {
              if (p.required) missing.push(p.name);
              continue;
            }
            if (p.in === 'header') headers[p.name] = p.name === 'x-file-name' ? encodeURIComponent(value) : value;
            else if (p.in === 'path') execPath = execPath.replace('{' + p.name + '}', encodeURIComponent(value));
            else query.set(p.name, value);
          }
          if (missing.length > 0) throw new Error('Заполните обязательные параметры: ' + missing.join(', '));
          const url = server + execPath + (query.toString() ? '?' + query.toString() : '');
          const body = isFile ? bodyField.files[0] : bodyField?.value.trim() || undefined;
          if (rb?.required && body === undefined) throw new Error(isFile ? 'Выберите файл.' : 'Заполните тело запроса.');
          if (body !== undefined) {
            if (jsonType) {
              try { JSON.parse(body); } catch { throw new Error('Проверьте синтаксис JSON в теле запроса.'); }
            }
            headers['content-type'] = isFile && (fileTypes.includes(body.type) || fileTypes.includes('application/octet-stream')) ? body.type || bodyType : bodyType;
            if (isFile && inputs['header:x-file-name'] && !headers['x-file-name']) {
              headers['x-file-name'] = encodeURIComponent(body.name);
            }
          }
          return { url, headers, body };
        };
        const buildCurl = () => {
          const { url, headers, body } = buildRequest();
          const quote = (value) => "'" + value.replace(/'/g, String.fromCharCode(39, 34, 39, 34, 39)) + "'";
          const parts = ['curl -X ' + item.method.toUpperCase() + ' ' + quote(url)];
          for (const [name, value] of Object.entries(headers)) {
            const shown = name === 'x-api-key' ? '<ADMIN_KEY>' : name === 'authorization' ? 'Bearer <JOIN_TOKEN>' : value;
            parts.push('  -H ' + quote(name + ': ' + shown));
          }
          if (body) parts.push('  --data-binary ' + quote(typeof body === 'string' ? body : '@' + body.name));
          return parts.join(' \\\\\\n');
        };
        curlButton.onclick = () => {
          let command;
          try { command = buildCurl(); } catch (error) { result.textContent = String(error.message || error); return; }
          const done = () => { curlButton.textContent = 'Скопировано'; setTimeout(() => { curlButton.textContent = 'Копировать curl'; }, 1200); };
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(command).then(done).catch(() => { result.textContent = command; });
          else result.textContent = command;
        };
        send.onclick = async () => {
          let request;
          try { request = buildRequest(); } catch (error) { status.textContent = 'проверьте поля'; status.className = 'pill err'; result.textContent = String(error.message || error); return; }
          const { url, headers, body } = request;
          const init = { method: item.method.toUpperCase(), headers };
          if (body) init.body = body;
          send.disabled = true;
          status.textContent = 'Отправляем…';
          status.className = 'pill';
          try {
            const response = await fetch(url, init);
            const text = await response.text();
            status.textContent = response.status + ' ' + response.statusText;
            status.className = 'pill ' + (response.ok ? 'ok' : 'err');
            try { result.textContent = JSON.stringify(JSON.parse(text), null, 2); } catch { result.textContent = text; }
          } catch (error) { status.textContent = 'ошибка сети'; status.className = 'pill err'; result.textContent = String(error); }
          finally { send.disabled = false; }
        };
        form.append(el('div', { class: 'row' }, [send, curlButton, status]));
        section.append(form, result);
        operationForms.set(id, section);
        ops.append(section);
      }
    }
    if (quickLinks.length > 0) nav.prepend(el('div', { class: 'quick' }, quickLinks));
    if (visible === 0) {
      ops.append(el('p', { class: 'desc' }, ['Ничего не найдено — измените поиск или фильтр по тегу.']));
    }
  };
  const loadSpec = async (admin) => {
    const revision = ++loadRevision;
    const url = admin ? '/openapi.admin.json' : '/openapi.json';
    const status = $('#spec-status');
    const download = $('#download');
    status.textContent = 'Загружаем описание API…';
    download.setAttribute('aria-disabled', 'true');
    download.removeAttribute('href');
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const next = await response.json();
      if (revision !== loadRevision) return;
      const tags = new Set();
      for (const methods of Object.values(next.paths)) {
        for (const operation of Object.values(methods)) {
          for (const tag of operation.tags || ['Other']) tags.add(tag);
        }
      }
      const filter = $('#tagFilter');
      filter.replaceChildren(el('option', { value: '' }, ['Все разделы']));
      for (const tag of tags) filter.append(el('option', { value: tag }, [ruTag(tag)]));
      if (!tags.has(uiState.tag)) uiState.tag = '';
      filter.value = uiState.tag;
      const firstSpec = !spec;
      spec = next;
      operationForms.clear();
      uiState.admin = admin;
      render();
      status.textContent = '';
      // Initial fragment navigation can finish before the asynchronous OpenAPI render.
      if (firstSpec && document.activeElement === document.body && location.hash.startsWith('#op-')) {
        const target = document.getElementById(location.hash.slice(1));
        target?.focus({ preventScroll: true });
        target?.scrollIntoView();
      }
    } catch (error) {
      if (revision !== loadRevision) return;
      $('#adminSpec').checked = uiState.admin;
      status.textContent = 'Не удалось загрузить ' + (admin ? 'административное' : 'публичное') + ' описание API (' + error.message + ').';
    } finally {
      if (revision === loadRevision && spec) {
        const filename = uiState.admin ? 'openapi.admin.json' : 'openapi.json';
        download.href = '/' + filename;
        download.download = filename;
        download.removeAttribute('aria-disabled');
      }
    }
  };
  void loadSpec(false);
})();
</script>
</body>
</html>`;

/** `GET /openapi.json` */
/** `GET /openapi.json` — public API only (no admin endpoints / apiKey scheme). */
export function openapiHandler(ctx: RequestContext): void {
  ctx.send(200, createOpenApiSpec({ publicOrigin: ctx.env.publicOrigin, version: SERVER_VERSION, scope: 'public' }));
}

/** `GET /openapi.admin.json` — full spec (admin endpoints); gated by docs exposure. */
export function openapiAdminHandler(ctx: RequestContext): void {
  ctx.send(200, createOpenApiSpec({ publicOrigin: ctx.env.publicOrigin, version: SERVER_VERSION, scope: 'full' }));
}

/** `GET /docs` — self-contained offline explorer. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Public-facing documentation allowlist (internal QA/backlog/estimates excluded). */
const PUBLIC_DOC_NAMES = new Set([
  'api-guide.md', 'api.md', 'ai-agent.md', 'in-call-agent.md', 'llm-integrations.md',
  'saas.md', 'scaling.md', 'ha-leader.md', 'roles.md', 'localization.md', 'design-system.md',
  'architecture.md', 'dashboard.md', 'dashboard-docs.md', 'dashboard-assistant.md',
  'editor.md', 'features.md', 'frontend.md', 'layout.md', 'mcp.md', 'sdk.md',
  'messenger.md', 'media-encoding.md', 'media-processing.md', 'performance.md',
  'security.md', 'extensibility.md', 'integration-boundaries.md', 'deployment.md', 'electron.md',
]);

/** Public docs menu: user-facing .md documents only, collapsed to keep endpoints close. */
function docsMenuHtml(ctx: RequestContext): string {
  try {
    const { docs, defaultName } = ctx.services.docs.list();
    const publicDocs = docs.filter((doc) => PUBLIC_DOC_NAMES.has(doc.name));
    const items = publicDocs
      .map((doc) => {
        const current = doc.name === defaultName ? ' <span class="pill">основной</span>' : '';
        const title = doc.title.replace(/`/g, '');
        return `<li><a href="/docs/${encodeURIComponent(doc.name)}">${escapeHtml(title)}</a>${current} <small>${escapeHtml(doc.name)}${doc.custom ? ' · изменён' : ''}</small></li>`;
      })
      .join('');
    const primary = publicDocs.find((doc) => doc.name === defaultName) ?? publicDocs[0];
    const primaryTitle = (primary?.title ?? defaultName).replace(/`/g, '');
    return `<details class="guide" id="docs-menu">
      <summary>Публичные документы (${publicDocs.length}) · основной: ${escapeHtml(primaryTitle)}</summary>
      <div class="guide-col">
        <ul>${items || '<li>Документы не найдены</li>'}</ul>
        <p><small>Редактирование и версии — в панели: <code>GET/PUT /v1/admin/docs</code>.</small></p>
      </div>
    </details>`;
  } catch {
    return '';
  }
}

export function docsHandler(ctx: RequestContext): void {
  const html = EXPLORER_HTML.replace('<main>', `${docsMenuHtml(ctx)}\n<main>`);
  ctx.res.statusCode = 200;
  ctx.res.setHeader('content-type', 'text/html; charset=utf-8');
  ctx.res.setHeader('cache-control', 'no-cache');
  ctx.res.setHeader('content-security-policy', "default-src 'self'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline'; connect-src *");
  ctx.res.end(html);
}

/** `GET /docs/<file>` — editable docs (custom overrides bundled) + bundled json. */
export function docsFileHandler(ctx: RequestContext): void {
  const requested = String(ctx.params.file ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(requested) || requested.includes('..')) {
    ctx.sendError(404, 'not_found', 'Document not found');
    return;
  }
  // Docs CMS: an admin-edited/uploaded copy overrides the bundled file.
  const effective = ctx.services.docs.effectiveContent(requested);
  if (effective) {
    const extension = path.extname(requested).toLowerCase();
    ctx.sendRaw(200, Buffer.from(effective.content, 'utf8'), {
      'content-type': extension === '.md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'",
      'x-agil-doc-source': effective.custom ? 'published' : 'bundled',
    });
    return;
  }
  const filePath = path.join(ctx.env.docsDir, requested);
  const resolved = path.resolve(filePath);
  const root = path.resolve(ctx.env.docsDir);
  if (!resolved.startsWith(root + path.sep)) {
    ctx.sendError(404, 'not_found', 'Document not found');
    return;
  }
  let data: Buffer;
  try {
    data = readFileSync(resolved);
  } catch {
    ctx.sendError(404, 'not_found', `Document ${requested} not found`);
    return;
  }
  const extension = path.extname(requested).toLowerCase();
  const contentType =
    extension === '.json'
      ? 'application/json; charset=utf-8'
      : extension === '.md'
        ? 'text/markdown; charset=utf-8'
        : extension === '.html'
          ? 'text/html; charset=utf-8'
          : 'text/plain; charset=utf-8';
  ctx.sendRaw(200, data, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'",
  });
}

/** Registers `/openapi.json`, `/docs` and `/docs/<file>` (kept outside `/v1` by contract). */
export function registerDocsRoutes(router: Router): void {
  router.get('/openapi.json', openapiHandler);
  router.get('/openapi.admin.json', openapiAdminHandler);
  router.get('/docs', docsHandler);
  router.get('/docs/:file', docsFileHandler);
  void SERVER_NAME;
}
