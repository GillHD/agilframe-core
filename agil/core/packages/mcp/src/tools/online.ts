/**
 * Online MCP tools — they call the AgilFrame HTTP API.
 *
 * Contract for every tool here: when the server is unavailable the result is
 * `isError: true` with a message that names AGIL_SERVER_URL and suggests a fix.
 * Offline tools keep working, so a model can still prepare configs and snippets.
 */
import { z } from 'zod';
import {
  accessPolicySchema,
  aiAgentConfigSchema,
  deepMerge,
  effectiveMediaMode,
  providersSchema,
  resolveAccess,
  roomContextSchema,
  scaleConfigSchema,
  sessionSchema,
  tenantConfigSchema,
  type AccessPolicy,
  type CustomRole,
  type FeatureKey,
  type ProviderSlot,
  type ProviderSlotName,
  type ProvidersConfig,
  type ProviderStatus,
  type Role,
  type RoleDefinition,
  type ScaleConfig,
  type TenantConfig,
  type TokenResponse,
  type WebhookDeliveryRecord,
  type WebhookEndpointConfig,
} from '@agil/protocol';
import { ApiError, ServerUnavailableError } from '../http-client.js';
import { API_ENDPOINTS, API_TAGS, type ApiEndpointDoc } from '../api-catalog.js';
import { PROVIDER_SLOTS } from '../providers-doc.js';
import { scaleWarnings } from '../scaling-doc.js';
import { BUILTIN_ROLE_IDS, normalizeRole, RESERVED_ROLE_IDS, roleWarnings } from '../roles-doc.js';
import { diffConfigs, summarizeChanges } from '../diff.js';
import {
  accessPolicyPartialSchema,
  customRoleSchema,
  featureKeySchema,
  configInputSchema,
  inCallAgentPartialSchema,
  knowledgeAgentPartialSchema,
  parsePatchInput,
  providerSlotNameSchema,
  providersPatchSchema,
  roleCreateSchema,
  rolePatchSchema,
  roleSchema,
  scalePatchSchema,
  sessionChatPartialSchema,
  webhooksInputSchema,
} from '../schemas.js';
import { isPlainObject, jsonOutcome, ToolError, defineTool, type AnyToolSpec, type ToolContext } from '../tool-kit.js';

interface ConfigResponse {
  config: TenantConfig;
  etag?: string;
}

interface AccessPolicyResponse {
  policy: AccessPolicy;
  featureKeys: FeatureKey[];
  effective: Record<Role, FeatureKey[]>;
}

interface KnowledgeAgentSettingsResponse {
  config: TenantConfig['session']['knowledgeAgent'];
  endpointConfigured: boolean;
  apiKeyConfigured: boolean;
}

interface WebhooksResponse {
  webhooks: WebhookEndpointConfig[];
  recentDeliveries: WebhookDeliveryRecord[];
}

interface RolesPayload {
  roles: RoleDefinition[];
  source: 'admin' | 'config';
}

function builtinRoleDefinitions(policy: AccessPolicy): RoleDefinition[] {
  const descriptions: Record<string, string> = {
    host: 'Организатор звонка',
    moderator: 'Модератор',
    guest: 'Гость',
  };
  return BUILTIN_ROLE_IDS.map((id) => ({
    id,
    name: descriptions[id] ?? id,
    description: 'Built-in role; edit its defaults via agil_set_access_policy (roleDefaults).',
    baseRole: id,
    features: policy.roleDefaults[id],
    canModerate: id !== 'guest',
    color: '',
    builtin: true,
    assigned: 0,
  }));
}

/**
 * Reads roles from the admin API and falls back to the tenant config when the
 * endpoint is unavailable.
 */
async function loadRoles(ctx: ToolContext): Promise<RolesPayload> {
  try {
    const payload = await ctx.client.get<Record<string, unknown>>('/v1/admin/roles');
    const roles = Array.isArray(payload.roles) ? (payload.roles as RoleDefinition[]) : [];
    return { roles, source: 'admin' };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405 || error.status === 501)) {
      const config = await ctx.client.get<ConfigResponse>(tenantPath(ctx.client, '/config'), { auth: false });
      const policy = config.config.security.accessPolicy;
      return {
        roles: [...builtinRoleDefinitions(policy), ...policy.customRoles.map((role) => ({ ...role, builtin: false, assigned: 0 }))],
        source: 'config',
      };
    }
    throw error;
  }
}

function asWireRole(role: CustomRole): CustomRole {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    baseRole: role.baseRole,
    features: role.features,
    canModerate: role.canModerate,
    color: role.color,
  };
}

/** Fallback write: replace `security.accessPolicy.customRoles` through PATCH config. */
async function patchCustomRoles(ctx: ToolContext, customRoles: CustomRole[]): Promise<ConfigResponse> {
  return await ctx.client.patch<ConfigResponse>(tenantPath(ctx.client, '/config'), {
    security: { accessPolicy: { customRoles } },
  });
}

interface ProvidersResponse {
  providers: ProviderStatus[];
}

interface ProviderTestResponse {
  slot: ProviderSlotName;
  ok: boolean;
  providerName: string;
  latencyMs: number;
  detail?: string;
}

/** Feature flags that expose a capability in the UI (for disabled-slot warnings). */
const PROVIDER_FEATURE_GATES: Record<ProviderSlotName, FeatureKey[]> = {
  chat: ['chat'],
  files: ['fileShare'],
  stt: ['captions'],
  notifications: [],
  recording: ['recording'],
  backgrounds: ['backgroundBlur', 'backgroundReplace'],
};

/** Semantic warnings for a providers config (used by dry runs and real saves). */
export function providerWarnings(providers: ProvidersConfig, config: TenantConfig): string[] {
  const warnings: string[] = [];
  const features = config.features as unknown as Record<string, boolean>;
  for (const slot of PROVIDER_SLOTS) {
    const slotConfig = providers[slot];
    const gated = PROVIDER_FEATURE_GATES[slot].filter((feature) => features[feature]);
    if (slotConfig.mode === 'external') {
      if (!slotConfig.endpoint) {
        warnings.push(`providers.${slot}.mode="external" but endpoint is empty: the provider cannot be called.`);
      } else if (!/^https:\/\//i.test(slotConfig.endpoint)) {
        warnings.push(`providers.${slot}.endpoint should be HTTPS: external providers receive meeting data.`);
      }
      if (!slotConfig.apiKeyEnv) {
        warnings.push(`providers.${slot}.apiKeyEnv is empty: requests will be unsigned (no HMAC secret).`);
      }
      if (slotConfig.fallback === 'fail') {
        warnings.push(
          `providers.${slot}.fallback="fail": a provider outage returns 502 to users instead of using the builtin path.`,
        );
      }
    }
    if (slotConfig.mode === 'disabled' && gated.length > 0) {
      warnings.push(
        `providers.${slot} is disabled but features.${gated.join('/')} is enabled: the UI exposes a capability that cannot work.`,
      );
    }
    if (slotConfig.mode === 'builtin' && (slotConfig.endpoint || slotConfig.providerName)) {
      warnings.push(
        `providers.${slot} has external settings (endpoint/providerName) but mode="builtin": they are ignored until mode="external".`,
      );
    }
  }
  if (providers.chat.mode === 'external' && config.session.chat.ui === 'builtin') {
    warnings.push(
      'providers.chat is external while session.chat.ui="builtin": our chat panel stays, but storage/delivery goes through the company. ' +
        'Call agil_set_chat_mode({sessionChat:{ui:"external"}}) to hide the builtin panel.',
    );
  }
  return warnings;
}

interface HealthResponse {
  ok: boolean;
  name: string;
  version: string;
  uptimeSec: number;
  rooms: number;
  tenants: number;
  security?: Record<string, unknown>;
}

interface OpenApiSpec {
  openapi?: string;
  info?: unknown;
  servers?: unknown;
  tags?: unknown;
  paths?: Record<string, Record<string, unknown>>;
  components?: unknown;
  [key: string]: unknown;
}

function tenantPath(client: { tenantId: string }, suffix: string): string {
  return `/v1/tenants/${encodeURIComponent(client.tenantId)}${suffix}`;
}

function requireRoomId(roomId: string): string {
  const trimmed = roomId.trim();
  if (!trimmed) throw new ToolError('`roomId` must not be empty.');
  return encodeURIComponent(trimmed);
}

function parseRoomList(payload: unknown): { rooms: unknown[]; count: number } {
  if (!isPlainObject(payload)) return { rooms: [], count: 0 };
  const rooms = Array.isArray(payload.rooms) ? payload.rooms : [];
  return { rooms, count: rooms.length };
}

function computeEffective(config: TenantConfig, policy: AccessPolicy): Record<Role, FeatureKey[]> {
  const merged = tenantConfigSchema.parse(deepMerge(config, { security: { accessPolicy: policy } }));
  return {
    host: resolveAccess({ config: merged, role: 'host' }).allowed,
    moderator: resolveAccess({ config: merged, role: 'moderator' }).allowed,
    guest: resolveAccess({ config: merged, role: 'guest' }).allowed,
  };
}

function methodSummary(operation: unknown): { summary: string; tags: string[] } {
  if (!isPlainObject(operation)) return { summary: '', tags: [] };
  const summary = typeof operation.summary === 'string' ? operation.summary : '';
  const tags = Array.isArray(operation.tags)
    ? operation.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  return { summary, tags };
}

/** Derives a compact endpoint list from an OpenAPI document. */
export function endpointsFromOpenApi(spec: OpenApiSpec): ApiEndpointDoc[] {
  const endpoints: ApiEndpointDoc[] = [];
  const paths = spec.paths ?? {};
  for (const [path, operations] of Object.entries(paths)) {
    if (!isPlainObject(operations)) continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const operation = operations[method];
      if (operation === undefined) continue;
      const { summary, tags } = methodSummary(operation);
      endpoints.push({ method: method.toUpperCase(), path, summary, tags, auth: tags.includes('admin') ? 'api-key' : 'none' });
    }
  }
  return endpoints;
}

export function onlineToolSpecs(): AnyToolSpec[] {
  return [
    defineTool({
      name: 'agil_get_config',
      title: 'Get tenant config',
      description:
        'Fetch the live TenantConfig of the current tenant from the AGIL server (GET /v1/tenants/:tenantId/config). ' +
        'Returns {config, etag, tenantId}. Requires a running server; if AGIL_SERVER_URL is unreachable this returns isError:true with a hint.',
      inputSchema: z.object({}),
      handler: async (_args, ctx) => {
        const payload = await ctx.client.get<ConfigResponse>(tenantPath(ctx.client, '/config'), { auth: false });
        return jsonOutcome({ tenantId: ctx.client.tenantId, etag: payload.etag, config: payload.config });
      },
    }),

    defineTool({
      name: 'agil_update_config',
      title: 'Update tenant config',
      description:
        'Apply a deep-partial TenantConfig patch to the tenant (PATCH /v1/tenants/:tenantId/config). ' +
        'With dryRun=true nothing is saved: the patch is merged and validated locally and the exact diff is returned. ' +
        'Returns {applied, config, etag, changes[], changeSummary}. The server broadcasts the new config to live rooms. ' +
        'Always call agil_validate_config first. Requires a running server.',
      inputSchema: z.object({
        patch: configInputSchema,
        dryRun: z.boolean().default(false).describe('Merge and diff locally without saving'),
      }),
      handler: async (args, ctx) => {
        const parsed = parsePatchInput(args.patch);
        if (!parsed.ok) {
          throw new ToolError(
            `Invalid config patch:\n${parsed.errors.join('\n')}`,
            'Call agil_get_config_schema and agil_validate_config first.',
          );
        }
        const path = tenantPath(ctx.client, '/config');
        const before = await ctx.client.get<ConfigResponse>(path, { auth: false });
        if (args.dryRun) {
          let merged: TenantConfig;
          try {
            merged = tenantConfigSchema.parse(deepMerge(before.config, parsed.patch));
          } catch (error) {
            throw new ToolError(
              `The patch would produce an invalid config: ${error instanceof Error ? error.message : String(error)}`,
              'Fix the patch values, then retry.',
            );
          }
          const changes = diffConfigs(before.config, merged);
          return jsonOutcome({
            dryRun: true,
            applied: false,
            tenantId: ctx.client.tenantId,
            changes,
            changeSummary: summarizeChanges(changes),
            config: merged,
          });
        }
        const after = await ctx.client.patch<ConfigResponse>(path, parsed.patch);
        const changes = diffConfigs(before.config, after.config);
        return jsonOutcome({
          dryRun: false,
          applied: true,
          tenantId: ctx.client.tenantId,
          etag: after.etag,
          changes,
          changeSummary: summarizeChanges(changes),
          config: after.config,
        });
      },
    }),

    defineTool({
      name: 'agil_create_room',
      title: 'Create room',
      description:
        'Create a test/production room for the current tenant (POST /v1/admin/rooms). ' +
        'mode="direct" = 1:1 call started from a messenger chat (maxParticipants 2); mode="group" = group conversation. ' +
        'context carries the messenger integration: {messenger, conversationId, directPeerId, title}. ' +
        'Returns room (with mode/context), joinUrl, embedUrl, token and passwordProtected. ' +
        'The optional password is sent once and stored by the server only as a scrypt hash. See docs/messenger.md. Requires a running server.',
      inputSchema: z.object({
        name: z.string().max(120).optional(),
        password: z.string().min(1).max(200).optional().describe('Room password (stored only as a hash)'),
        maxParticipants: z.number().int().min(2).max(200).optional(),
        ttlSec: z.number().int().min(0).max(86400).optional().describe('Auto-close empty room after N seconds (0 = keep)'),
        roomId: z.string().min(1).max(64).optional().describe('Explicit room id (default: random UUID)'),
        mode: z
          .enum(['direct', 'group'])
          .optional()
          .describe('direct = 1:1 messenger call (maxParticipants 2); group = group conversation'),
        context: roomContextSchema
          .optional()
          .describe('Messenger context: {messenger?, conversationId?, directPeerId?, title?}'),
        allowedParticipantIds: z.array(z.string().min(1).max(64)).min(1).max(50000).optional()
          .describe('Company participant IDs allowed to join with individual room tokens.'),
      }),
      handler: async (args, ctx) => {
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.password !== undefined) body.password = args.password;
        if (args.maxParticipants !== undefined) body.maxParticipants = args.maxParticipants;
        if (args.ttlSec !== undefined) body.ttlSec = args.ttlSec;
        if (args.roomId !== undefined) body.roomId = args.roomId;
        if (args.mode !== undefined) body.mode = args.mode;
        if (args.context !== undefined) body.context = args.context;
        if (args.allowedParticipantIds !== undefined) body.allowedParticipantIds = args.allowedParticipantIds;
        const notes: string[] = [];
        if (args.mode === 'direct') {
          if (args.maxParticipants === undefined) {
            body.maxParticipants = 2;
            notes.push('direct room: maxParticipants defaulted to 2.');
          } else if (args.maxParticipants !== 2) {
            notes.push('direct is a 1:1 call: maxParticipants should be 2.');
          }
        }
        const created = await ctx.client.post<Record<string, unknown>>('/v1/admin/rooms', body);
        return jsonOutcome({
          tenantId: ctx.client.tenantId,
          ...created,
          ...(args.mode ? { mode: args.mode } : {}),
          ...(args.context ? { context: args.context } : {}),
          ...(notes.length > 0 ? { notes } : {}),
          passwordNote: args.password
            ? 'The password is stored only as a scrypt hash and is never returned by the API.'
            : undefined,
        });
      },
    }),

    defineTool({
      name: 'agil_create_invite',
      title: 'Create invite link',
      description:
        'Create a short-lived invite link for an existing room (POST /v1/admin/rooms/:roomId/invites). ' +
        'Returns {joinUrl, embedUrl, token, expiresAt, passwordProtected}. Requires a running server.',
      inputSchema: z.object({
        roomId: z.string().min(1).max(64),
        ttlSec: z.number().int().min(60).max(604800).optional().describe('Invite lifetime in seconds'),
        role: roleSchema.optional(),
      }),
      handler: async (args, ctx) => {
        const body: Record<string, unknown> = {};
        if (args.ttlSec !== undefined) body.ttlSec = args.ttlSec;
        if (args.role !== undefined) body.role = args.role;
        const invite = await ctx.client.post<Record<string, unknown>>(
          `/v1/admin/rooms/${requireRoomId(args.roomId)}/invites`,
          body,
        );
        return jsonOutcome({ tenantId: ctx.client.tenantId, ...invite });
      },
    }),

    defineTool({
      name: 'agil_create_token',
      title: 'Create join token',
      description:
        'Mint a short-lived join token for a participant (POST /v1/tokens). ' +
        'Optionally use a custom `roleId` (company-defined role) and/or pin feature `permissions` — the issued token then decides exactly what the participant may use ' +
        '(see resolveAccess / agil_explain_access). Returns {token, expiresAt, tenantId, roomId, permissions, roleId?, roleName?}. Requires a running server.',
      inputSchema: z.object({
        roomId: z.string().min(1).max(64),
        name: z.string().max(120).optional().describe('Participant display name (default "Гость")'),
        role: roleSchema.optional(),
        roleId: z
          .string()
          .min(1)
          .max(40)
          .optional()
          .describe('Custom role id (security.accessPolicy.customRoles); effective features come from that role'),
        ttlSec: z.number().int().min(60).max(86400).optional(),
        permissions: z
          .array(featureKeySchema)
          .max(200)
          .optional()
          .describe('Pinned feature permissions; replaces the role defaults for this token'),
      }),
      handler: async (args, ctx) => {
        const body: Record<string, unknown> = {
          tenantId: ctx.client.tenantId,
          roomId: args.roomId,
          participant: {
            name: args.name ?? 'Гость',
            ...(args.role ? { role: args.role } : {}),
            ...(args.roleId ? { roleId: args.roleId } : {}),
          },
        };
        if (args.ttlSec !== undefined) body.ttlSec = args.ttlSec;
        if (args.permissions !== undefined) body.permissions = args.permissions;
        const token = await ctx.client.post<TokenResponse>('/v1/tokens', body);
        return jsonOutcome({
          ...token,
          ...(args.roleId
            ? {
                roleId: token.roleId ?? args.roleId,
                note: `Token issued for custom role "${token.roleName ?? args.roleId}"; the widget applies its effective permissions.`,
              }
            : {}),
        });
      },
    }),

    defineTool({
      name: 'agil_list_rooms',
      title: 'List rooms',
      description:
        'List the tenant rooms with participant counts, password protection, timestamps and join/embed links (GET /v1/admin/rooms). ' +
        'Requires a running server.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(50).describe('Client-side limit of returned rooms'),
      }),
      handler: async (args, ctx) => {
        const payload = await ctx.client.get<unknown>('/v1/admin/rooms');
        const { rooms, count } = parseRoomList(payload);
        return jsonOutcome({ tenantId: ctx.client.tenantId, total: count, rooms: rooms.slice(0, args.limit) });
      },
    }),

    defineTool({
      name: 'agil_get_room',
      title: 'Get room detail',
      description:
        'Get one room with participants, recent chat, links and password protection (GET /v1/admin/rooms/:roomId). ' +
        'Also surfaces room `mode` (direct | group) and `context` (messenger/conversationId/directPeerId/title) from RoomInfo. ' +
        'Requires a running server. See docs/messenger.md.',
      inputSchema: z.object({ roomId: z.string().min(1).max(64) }),
      handler: async (args, ctx) => {
        const payload = await ctx.client.get<unknown>(`/v1/admin/rooms/${requireRoomId(args.roomId)}`);
        if (isPlainObject(payload) && isPlainObject(payload.room)) {
          const room = payload.room;
          return jsonOutcome({
            ...payload,
            mode: room.mode ?? null,
            context: room.context ?? null,
            note: 'mode/context come from RoomInfo (set at creation via agil_create_room).',
          });
        }
        return jsonOutcome(payload);
      },
    }),

    defineTool({
      name: 'agil_get_transcript',
      title: 'Get room transcript',
      description:
        'Fetch the transcript segments of a room (GET /v1/admin/rooms/:roomId/transcript). ' +
        'Feed the segments to agil_summarize_meeting or agil_analyze_compliance (both work offline). Requires a running server.',
      inputSchema: z.object({ roomId: z.string().min(1).max(64) }),
      handler: async (args, ctx) =>
        jsonOutcome(
          await ctx.client.get<unknown>(`/v1/admin/rooms/${requireRoomId(args.roomId)}/transcript`),
        ),
    }),

    defineTool({
      name: 'agil_get_analysis',
      title: 'Get room analysis',
      description:
        'Fetch the latest compliance analysis of a room: report, findings and meeting notes ' +
        '(GET /v1/admin/rooms/:roomId/analysis). Requires a running server.',
      inputSchema: z.object({ roomId: z.string().min(1).max(64) }),
      handler: async (args, ctx) =>
        jsonOutcome(
          await ctx.client.get<unknown>(`/v1/admin/rooms/${requireRoomId(args.roomId)}/analysis`),
        ),
    }),

    defineTool({
      name: 'agil_run_analysis',
      title: 'Run room analysis',
      description:
        'Force a compliance/AI analysis run for a room (POST /v1/admin/rooms/:roomId/analysis/run) and return the fresh result. ' +
        'Requires a running server; for offline analysis use agil_analyze_compliance + agil_summarize_meeting.',
      inputSchema: z.object({ roomId: z.string().min(1).max(64) }),
      handler: async (args, ctx) =>
        jsonOutcome(
          await ctx.client.post<unknown>(`/v1/admin/rooms/${requireRoomId(args.roomId)}/analysis/run`, {}),
        ),
    }),

    defineTool({
      name: 'agil_post_room_chat',
      title: 'Post chat message',
      description:
        'Post a message into a room from the company system (bot/CRM/external chat bridge) — POST /v1/admin/rooms/:roomId/chat, works without a WebSocket. ' +
        'kind="system" renders a centred notice and requires session.chat.allowSystemMessages; `from` sets the display identity; `id` is an idempotency key. ' +
        'The message is broadcast to participants, stored in history and delivered to the chat.message webhook. Requires a running server.',
      inputSchema: z.object({
        roomId: z.string().min(1).max(64),
        text: z.string().min(1).max(4000).describe('Message text (plain text, 1–4000 chars)'),
        kind: z.enum(['text', 'system']).default('text').describe('system = centred bot/notice message'),
        from: z
          .object({
            id: z.string().max(64).optional(),
            name: z.string().max(120).optional(),
            role: roleSchema.optional(),
          })
          .optional()
          .describe('Display identity of the company-side author'),
        id: z.string().max(64).optional().describe('Idempotency key; repeated posts with the same id are ignored'),
      }),
      handler: async (args, ctx) => {
        const body: Record<string, unknown> = { text: args.text, kind: args.kind };
        if (args.from) body.from = args.from;
        if (args.id) body.id = args.id;
        const posted = await ctx.client.post<Record<string, unknown>>(
          `/v1/admin/rooms/${requireRoomId(args.roomId)}/chat`,
          body,
        );
        return jsonOutcome({
          tenantId: ctx.client.tenantId,
          roomId: args.roomId,
          kind: args.kind,
          ...posted,
          note:
            args.kind === 'system'
              ? 'System messages require session.chat.allowSystemMessages=true (see agil_set_chat_mode).'
              : 'The message is broadcast to participants and stored in the room chat history.',
        });
      },
    }),

    defineTool({
      name: 'agil_set_chat_mode',
      title: 'Set chat mode',
      description:
        'Configure who owns the chat (contract §22) by merging into session.chat and applying a PATCH to the tenant config. ' +
        'ui="builtin" — our chat panel; ui="external" — the company chat UI (the widget hides its chat, emits agil:chat/onEvent("chat") and accepts sendChat()/postMessage); ' +
        'ui="hidden" — chat fully disabled. externalProviderName/allowHostInjection/allowSystemMessages describe the integration. ' +
        'Returns the saved chat config, diff and etag. Requires a running server.',
      inputSchema: z.object({
        sessionChat: sessionChatPartialSchema,
      }),
      handler: async (args, ctx) => {
        const path = tenantPath(ctx.client, '/config');
        const before = await ctx.client.get<ConfigResponse>(path, { auth: false });
        const mergedChat = { ...before.config.session.chat, ...args.sessionChat };
        let validatedChat: TenantConfig['session']['chat'];
        try {
          validatedChat = sessionSchema.shape.chat.parse(mergedChat);
          tenantConfigSchema.parse(deepMerge(before.config, { session: { chat: validatedChat } }));
        } catch (error) {
          throw new ToolError(
            `Invalid session.chat: ${error instanceof Error ? error.message : String(error)}`,
            'Fields: ui (builtin|external|hidden), externalProviderName, allowHostInjection, allowSystemMessages.',
          );
        }
        const after = await ctx.client.patch<ConfigResponse>(path, { session: { chat: validatedChat } });
        const changes = diffConfigs(before.config, after.config);
        return jsonOutcome({
          applied: true,
          tenantId: ctx.client.tenantId,
          etag: after.etag,
          chat: after.config.session.chat,
          changes,
          changeSummary: summarizeChanges(changes),
          note:
            validatedChat.ui === 'external'
              ? 'External chat: the widget no longer renders a chat panel; forward AGIL chat events to your messenger and send replies via sendChat()/postMessage {type:"agil:chat-send"} or POST /v1/admin/rooms/:id/chat.'
              : validatedChat.ui === 'hidden'
                ? 'Chat is disabled in the widget; features.chat still gates posting via API.'
                : 'Built-in chat panel is used.',
        });
      },
    }),

    defineTool({
      name: 'agil_get_providers',
      title: 'Get capability providers',
      description:
        'Get the six replaceable capability providers (chat, files, stt, notifications, recording, backgrounds) with their status: ' +
        'mode (builtin/external/disabled), providerName, configured, available and fallback (GET /v1/admin/providers). ' +
        'Everything is builtin by default; see agil_explain_providers / docs/extensibility.md for the contract. Requires a running server.',
      inputSchema: z.object({}),
      handler: async (_args, ctx) => {
        const response = await ctx.client.get<ProvidersResponse>('/v1/admin/providers');
        const counts = { builtin: 0, external: 0, disabled: 0 };
        for (const provider of response.providers) counts[provider.mode] += 1;
        return jsonOutcome({
          tenantId: ctx.client.tenantId,
          allBuiltin: counts.external === 0 && counts.disabled === 0,
          counts,
          providers: response.providers,
          docs: 'agil/core/docs/extensibility.md',
          tips: [
            'builtin is the default and needs no external service.',
            'To replace a capability: agil_set_providers with dryRun:true, review warnings, then apply.',
            'External chat UI is a separate switch: agil_set_chat_mode({sessionChat:{ui:"external"}}).',
          ],
        });
      },
    }),

    defineTool({
      name: 'agil_set_providers',
      title: 'Update capability providers',
      description:
        'Merge a partial ProvidersConfig into TenantConfig.providers (PUT /v1/admin/providers) and return the diff and warnings. ' +
        'Slots: chat, files, stt, notifications, recording, backgrounds. Per slot: mode builtin|external|disabled, providerName, endpoint, apiKeyEnv (env-var name, never the secret), timeoutMs, fallback builtin|fail, options. ' +
        'With dryRun=true nothing is saved: the merged config is validated locally and diffed. ' +
        'Warn on: external without endpoint/apiKeyEnv, non-HTTPS endpoint, fallback="fail" (502 on outage), disabled slot with an enabled feature. Requires a running server.',
      inputSchema: z.object({
        providers: providersPatchSchema,
        dryRun: z.boolean().default(false).describe('Merge and validate locally without saving'),
      }),
      handler: async (args, ctx) => {
        const configPath = tenantPath(ctx.client, '/config');
        const before = await ctx.client.get<ConfigResponse>(configPath, { auth: false });
        const current = before.config.providers;
        const nextProviders: Record<string, ProviderSlot> = { ...current };
        for (const slot of PROVIDER_SLOTS) {
          const patch = args.providers[slot];
          if (!patch) continue;
          const defined: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(patch)) {
            if (value !== undefined) defined[key] = value;
          }
          nextProviders[slot] = { ...current[slot], ...defined } as ProviderSlot;
        }
        let validated: ProvidersConfig;
        try {
          validated = providersSchema.parse(nextProviders);
        } catch (error) {
          throw new ToolError(
            `Invalid providers config: ${error instanceof Error ? error.message : String(error)}`,
            'mode: builtin|external|disabled; timeoutMs 200–30000; fallback builtin|fail; options is a JSON object.',
          );
        }
        const warnings = providerWarnings(validated, before.config);
        const changes = diffConfigs(current, validated);
        if (args.dryRun) {
          return jsonOutcome({
            dryRun: true,
            applied: false,
            tenantId: ctx.client.tenantId,
            providers: validated,
            changes,
            changeSummary: summarizeChanges(changes),
            warnings,
            note: 'Nothing saved. Apply with dryRun:false once the warnings are acceptable.',
          });
        }
        const saved = await ctx.client.put<ProvidersResponse>('/v1/admin/providers', {
          providers: validated,
        });
        return jsonOutcome({
          dryRun: false,
          applied: true,
          tenantId: ctx.client.tenantId,
          providers: saved.providers,
          changes,
          changeSummary: summarizeChanges(changes),
          warnings,
          note: 'Saved via PUT /v1/admin/providers (audit event providers.updated); applies to new requests immediately.',
        });
      },
    }),

    defineTool({
      name: 'agil_test_provider',
      title: 'Test capability provider',
      description:
        'Perform a signed test call against one provider slot (POST /v1/admin/providers/test) and return {ok, providerName, latencyMs, detail}. ' +
        'Use it after agil_set_providers to prove the company endpoint + apiKeyEnv work; a failed test with fallback="builtin" still keeps the call working. ' +
        'Requires a running server.',
      inputSchema: z.object({
        slot: providerSlotNameSchema,
        payload: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Optional synthetic payload; defaults to a small capability-specific probe'),
      }),
      handler: async (args, ctx) => {
        const body: Record<string, unknown> = { slot: args.slot };
        if (args.payload) body.payload = args.payload;
        const response = await ctx.client.post<ProviderTestResponse>('/v1/admin/providers/test', body);
        return jsonOutcome({
          tenantId: ctx.client.tenantId,
          ...response,
          note: response.ok
            ? `Provider "${response.providerName}" answered in ${response.latencyMs}ms.`
            : 'Test call failed: check endpoint, apiKeyEnv, HTTPS and that the company endpoint implements the signed envelope (agil_explain_providers).',
        });
      },
    }),

    defineTool({
      name: 'agil_get_scale',
      title: 'Get scale configuration',
      description:
        'Get the tenant scale-out configuration (GET /v1/admin/scale): media mode mesh|sfu|broadcast, participant limits, multi-node signaling (nodeId/redis/sticky/nodes), ' +
        'SFU, TURN pool, load balancer, webinar/broadcast and streaming/CDN settings, plus the server limitations list. ' +
        'Falls back to TenantConfig.scale when the admin endpoint is not implemented. Requires a running server.',
      inputSchema: z.object({}),
      handler: async (_args, ctx) => {
        try {
          const payload = await ctx.client.get<Record<string, unknown>>('/v1/admin/scale');
          return jsonOutcome({
            tenantId: ctx.client.tenantId,
            source: 'admin',
            docs: 'agil/core/docs/scaling.md',
            ...payload,
          });
        } catch (error) {
          if (error instanceof ApiError && (error.status === 404 || error.status === 405 || error.status === 501)) {
            const configPayload = await ctx.client.get<ConfigResponse>(tenantPath(ctx.client, '/config'), {
              auth: false,
            });
            return jsonOutcome({
              tenantId: ctx.client.tenantId,
              source: 'config',
              config: configPayload.config.scale,
              mediaMode: effectiveMediaMode(configPayload.config.scale),
              limitations: [
                'Multi-node Redis fan-out, real SFU orchestration and CDN integration are not implemented in the single-node MVP (docs/scaling.md §9).',
              ],
              docs: 'agil/core/docs/scaling.md',
              note: 'Admin endpoint is not available; read TenantConfig.scale.',
            });
          }
          throw error;
        }
      },
    }),

    defineTool({
      name: 'agil_set_scale',
      title: 'Update scale configuration',
      description:
        'Merge a deep-partial ScaleConfig into TenantConfig.scale (PUT /v1/admin/scale), validate it against the protocol schema, return the diff and semantic warnings. ' +
        'Warns about: mesh mediaMode with a large maxParticipants, sfu mode without sfu.url, TURN servers without credentialEnv, webinar without broadcast mode, ' +
        'empty redisUrl with several signaling nodes, streaming enabled without a provider/URL, CDN without baseUrl. ' +
        '`dryRun:true` merges/validates locally without saving. Falls back to PATCH config.scale when the admin endpoint is absent. ' +
        'Secrets are env-variable NAMES only. See docs/scaling.md. Requires a running server.',
      inputSchema: z.object({
        scale: scalePatchSchema,
        dryRun: z.boolean().default(false).describe('Merge and validate locally without saving'),
      }),
      handler: async (args, ctx) => {
        const configPath = tenantPath(ctx.client, '/config');
        const before = await ctx.client.get<ConfigResponse>(configPath, { auth: false });
        const current = before.config.scale;
        let validated: ScaleConfig;
        try {
          validated = scaleConfigSchema.parse(deepMerge(current, args.scale));
        } catch (error) {
          throw new ToolError(
            `Invalid scale config: ${error instanceof Error ? error.message : String(error)}`,
            'mediaMode mesh|sfu|broadcast; maxParticipants 2..50000; turn[] entries need id/urls/username/credentialEnv/region/weight; secrets are env-var names.',
          );
        }
        const warnings = scaleWarnings(validated);
        const changes = diffConfigs(current, validated);
        if (args.dryRun) {
          return jsonOutcome({
            dryRun: true,
            applied: false,
            tenantId: ctx.client.tenantId,
            mediaMode: effectiveMediaMode(validated),
            config: validated,
            changes,
            changeSummary: summarizeChanges(changes),
            warnings,
            note: 'Nothing saved. Apply with dryRun:false once the warnings are acceptable.',
          });
        }
        try {
          const saved = await ctx.client.put<Record<string, unknown>>('/v1/admin/scale', { scale: validated });
          return jsonOutcome({
            dryRun: false,
            applied: true,
            source: 'admin',
            tenantId: ctx.client.tenantId,
            mediaMode: effectiveMediaMode(validated),
            config: validated,
            response: saved,
            changes,
            changeSummary: summarizeChanges(changes),
            warnings,
          });
        } catch (error) {
          if (error instanceof ApiError && (error.status === 404 || error.status === 405 || error.status === 501)) {
            const after = await ctx.client.patch<ConfigResponse>(configPath, { scale: validated });
            return jsonOutcome({
              dryRun: false,
              applied: true,
              source: 'config-patch',
              tenantId: ctx.client.tenantId,
              etag: after.etag,
              mediaMode: effectiveMediaMode(after.config.scale),
              config: after.config.scale,
              changes,
              changeSummary: summarizeChanges(changes),
              warnings,
              note: 'Admin endpoint is not available; saved via PATCH config.scale.',
            });
          }
          throw error;
        }
      },
    }),

    defineTool({
      name: 'agil_get_cluster_status',
      title: 'Get cluster status',
      description:
        'Get multi-node signaling status (GET /v1/admin/cluster/status): nodeId, nodes (id/url/region/weight/healthy), LB strategy, redisConfigured, stickySessions ' +
        'and multiNodeActive. Falls back to TenantConfig.scale.signaling when the admin endpoint is absent. Requires a running server.',
      inputSchema: z.object({}),
      handler: async (_args, ctx) => {
        try {
          const payload = await ctx.client.get<Record<string, unknown>>('/v1/admin/cluster/status');
          return jsonOutcome({ tenantId: ctx.client.tenantId, source: 'admin', ...payload, docs: 'agil/core/docs/scaling.md' });
        } catch (error) {
          if (error instanceof ApiError && (error.status === 404 || error.status === 405 || error.status === 501)) {
            const configPayload = await ctx.client.get<ConfigResponse>(tenantPath(ctx.client, '/config'), {
              auth: false,
            });
            const scale = configPayload.config.scale;
            return jsonOutcome({
              tenantId: ctx.client.tenantId,
              source: 'config',
              nodeId: scale.signaling.nodeId,
              nodes: scale.signaling.nodes.map((node) => ({
                id: node.id,
                url: node.url,
                region: node.region,
                weight: node.weight,
                healthy: node.healthy ?? null,
              })),
              strategy: scale.loadBalancer.strategy,
              redisConfigured: Boolean(scale.signaling.redisUrl),
              stickySessions: scale.signaling.stickySessions,
              multiNodeActive: false,
              docs: 'agil/core/docs/scaling.md',
              note: 'Admin endpoint is not available; derived from TenantConfig.scale. Multi-node fan-out is not active in the MVP.',
            });
          }
          throw error;
        }
      },
    }),

    defineTool({
      name: 'agil_preview_in_call_command',
      title: 'Preview an in-call assistant command',
      description:
        'Ask the configured LLM for an in-call reply and permitted actions. Uses the short-lived ' +
        'AGIL_MCP_PARTICIPANT_TOKEN from the MCP process environment. The tool returns the proposal ' +
        'for the participant; execution and any recording consent belong to the live widget.',
      inputSchema: z.object({
        roomId: z.string().trim().min(1).max(160),
        text: z.string().trim().min(1).max(2000),
        locale: z.enum(['ru', 'en']).optional(),
      }),
      handler: async ({ roomId, text, locale }, ctx) => {
        const token = process.env.AGIL_MCP_PARTICIPANT_TOKEN?.trim();
        if (!token) throw new ToolError('Set AGIL_MCP_PARTICIPANT_TOKEN in the MCP process environment.');
        const reply = await ctx.client.post<unknown>(
          `/v1/rooms/${encodeURIComponent(roomId)}/assistant`,
          { text, locale },
          { auth: false, headers: { Authorization: `Bearer ${token}` } },
        );
        return jsonOutcome({ reply, executed: false });
      },
    }),

    defineTool({
      name: 'agil_get_in_call_agent',
      title: 'Get in-call assistant settings',
      description:
        'Get the in-call AI assistant configuration (session.inCallAgent): enabled, mode local|external|hybrid, endpoint, apiKeyEnv (env-var name, never the secret), ' +
        'timeoutMs, systemPrompt, model, spotlight, allowedTools, maxActionsPerReply, audit, denyMessage. ' +
        'Reads GET /v1/admin/in-call-agent and falls back to the tenant config when that admin endpoint is not implemented. Requires a running server.',
      inputSchema: z.object({}),
      handler: async (_args, ctx) => {
        try {
          const payload = await ctx.client.get<unknown>('/v1/admin/in-call-agent');
          return jsonOutcome({ tenantId: ctx.client.tenantId, source: 'admin', ...(isPlainObject(payload) ? payload : { config: payload }) });
        } catch (error) {
          if (error instanceof ApiError && (error.status === 404 || error.status === 405 || error.status === 501)) {
            const configPayload = await ctx.client.get<ConfigResponse>(tenantPath(ctx.client, '/config'), {
              auth: false,
            });
            return jsonOutcome({
              tenantId: ctx.client.tenantId,
              source: 'config',
              config: configPayload.config.session.inCallAgent,
              note: 'Admin endpoint is not available; read session.inCallAgent from the tenant config. The assistant acts only with the user permissions (docs/in-call-agent.md).',
            });
          }
          throw error;
        }
      },
    }),

    defineTool({
      name: 'agil_set_in_call_agent',
      title: 'Update in-call assistant settings',
      description:
        'Merge a Partial<InCallAgentConfig> into session.inCallAgent. Tries PUT /v1/admin/in-call-agent and, if the server does not expose it (404/405/501), falls back to PATCH config.session.inCallAgent. ' +
        '`dryRun:true` merges/validates locally and returns the diff + warnings without saving. ' +
        'Set compressContext to request conversation history compression from a compatible external agent. System instructions are preserved. ' +
        'Warns when mode=external/hybrid without endpoint or apiKeyEnv, when allowedTools is empty, or when enabled=false. ' +
        'The assistant acts strictly with the user permissions; `local` mode works offline. Requires a running server.',
      inputSchema: z.object({
        config: inCallAgentPartialSchema,
        dryRun: z.boolean().default(false).describe('Merge and validate locally without saving'),
      }),
      handler: async (args, ctx) => {
        const configPath = tenantPath(ctx.client, '/config');
        const before = await ctx.client.get<ConfigResponse>(configPath, { auth: false });
        const current = before.config.session.inCallAgent;
        const defined: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(args.config)) {
          if (value !== undefined) defined[key] = value;
        }
        const merged = { ...current, ...defined };
        let validated: TenantConfig['session']['inCallAgent'];
        try {
          validated = sessionSchema.shape.inCallAgent.parse(merged);
          tenantConfigSchema.parse(deepMerge(before.config, { session: { inCallAgent: validated } }));
        } catch (error) {
          throw new ToolError(
            `Invalid session.inCallAgent: ${error instanceof Error ? error.message : String(error)}`,
            'Fields: enabled, mode local|external|hybrid, endpoint, apiKeyEnv, timeoutMs 500–30000, systemPrompt, model, compressContext, spotlight, allowedTools, maxActionsPerReply 1–10, audit, denyMessage.',
          );
        }
        const warnings: string[] = [];
        if (!validated.enabled) warnings.push('session.inCallAgent.enabled=false: the in-call assistant is turned off.');
        if (validated.mode !== 'local' && !validated.endpoint) {
          warnings.push(`session.inCallAgent.mode="${validated.mode}" requires a non-empty endpoint.`);
        }
        if (validated.mode !== 'local' && !validated.apiKeyEnv) {
          warnings.push('session.inCallAgent.apiKeyEnv is empty: external LLM calls will be unsigned.');
        }
        if (validated.allowedTools.length === 0) {
          warnings.push('session.inCallAgent.allowedTools is empty: the assistant cannot perform actions.');
        }
        if (!validated.spotlight) {
          warnings.push('session.inCallAgent.spotlight=false: answers are text-only, no "press here" highlighting.');
        }
        const changes = diffConfigs(current, validated);
        if (args.dryRun) {
          return jsonOutcome({
            dryRun: true,
            applied: false,
            tenantId: ctx.client.tenantId,
            config: validated,
            diff: changes,
            changeSummary: summarizeChanges(changes),
            warnings,
            note: 'Nothing saved. External/hybrid mode needs endpoint + apiKeyEnv; local mode is fully offline.',
          });
        }
        try {
          const saved = await ctx.client.put<unknown>('/v1/admin/in-call-agent', { config: validated });
          return jsonOutcome({
            dryRun: false,
            applied: true,
            source: 'admin',
            tenantId: ctx.client.tenantId,
            config: validated,
            response: saved,
            diff: changes,
            changeSummary: summarizeChanges(changes),
            warnings,
          });
        } catch (error) {
          if (error instanceof ApiError && (error.status === 404 || error.status === 405 || error.status === 501)) {
            const after = await ctx.client.patch<ConfigResponse>(configPath, {
              session: { inCallAgent: validated },
            });
            return jsonOutcome({
              dryRun: false,
              applied: true,
              source: 'config-patch',
              tenantId: ctx.client.tenantId,
              etag: after.etag,
              config: after.config.session.inCallAgent,
              diff: changes,
              changeSummary: summarizeChanges(changes),
              warnings,
              note: 'Admin endpoint is not available; saved via PATCH config.session.inCallAgent.',
            });
          }
          throw error;
        }
      },
    }),

    defineTool({
      name: 'agil_list_roles',
      title: 'List roles',
      description:
        'List the three built-in roles (host/moderator/guest, `builtin:true`) and company-defined custom roles (GET /v1/admin/roles), ' +
        'with baseRole, features, canModerate, color and `assigned` counters. Falls back to TenantConfig.security.accessPolicy when the admin endpoint is absent. ' +
        'Requires a running server. See docs/api-guide.md §3.',
      inputSchema: z.object({}),
      handler: async (_args, ctx) => {
        const { roles, source } = await loadRoles(ctx);
        const builtin = roles.filter((role) => role.builtin !== false);
        const custom = roles.filter((role) => role.builtin === false);
        return jsonOutcome({
          tenantId: ctx.client.tenantId,
          source,
          counts: { total: roles.length, builtin: builtin.length, custom: custom.length, limit: 30 },
          roles,
          builtinRoleIds: builtin.map((role) => role.id),
          docs: 'agil/core/docs/api-guide.md',
        });
      },
    }),

    defineTool({
      name: 'agil_create_role',
      title: 'Create custom role',
      description:
        'Create a company-defined role (POST /v1/admin/roles): {id, name, description?, baseRole: host|moderator|guest, features: FeatureKey[], canModerate?, color?}. ' +
        'Validates the schema, reserved ids (host/moderator/guest/anonymous/system/admin), duplicates and the 30-role limit; ' +
        'warns about empty features, guest baseRole with recording, guest + canModerate. `dryRun:true` validates without saving. ' +
        'Issue a token with `roleId` to use it. Falls back to PATCH config when the admin endpoint is absent. Requires a running server.',
      inputSchema: z.object({
        role: roleCreateSchema,
        dryRun: z.boolean().default(false).describe('Validate and show warnings without saving'),
      }),
      handler: async (args, ctx) => {
        const existing = await loadRoles(ctx);
        const candidate = customRoleSchema.parse(args.role);
        const { errors, warnings } = roleWarnings({
          role: candidate,
          existingRoles: existing.roles,
          reserved: RESERVED_ROLE_IDS,
        });
        if (errors.length > 0) {
          throw new ToolError(`Invalid role:\n${errors.join('\n')}`, 'Call agil_explain_roles for the model and examples.');
        }
        const base = {
          role: candidate,
          warnings,
          source: existing.source,
          existingCount: existing.roles.length,
          docs: 'agil/core/docs/api-guide.md',
        };
        if (args.dryRun) {
          return jsonOutcome({
            dryRun: true,
            applied: false,
            valid: true,
            ...base,
            note: `Nothing saved. Use agil_create_token({ roleId: "${candidate.id}" }) after applying.`,
          });
        }
        try {
          const saved = await ctx.client.post<Record<string, unknown>>('/v1/admin/roles', asWireRole(candidate));
          return jsonOutcome({ dryRun: false, applied: true, ...base, response: saved });
        } catch (error) {
          if (error instanceof ApiError && (error.status === 404 || error.status === 405 || error.status === 501)) {
            const customRoles = [...existing.roles.filter((role) => role.builtin === false).map(asWireRole), candidate];
            const after = await patchCustomRoles(ctx, customRoles);
            return jsonOutcome({
              dryRun: false,
              applied: true,
              ...base,
              source: 'config-patch',
              etag: after.etag,
              customRoles: after.config.security.accessPolicy.customRoles,
              note: 'Admin roles endpoint is absent; saved via PATCH security.accessPolicy.customRoles.',
            });
          }
          throw error;
        }
      },
    }),

    defineTool({
      name: 'agil_update_role',
      title: 'Update custom role',
      description:
        'Update a company-defined role (PUT /v1/admin/roles/:id) by merging a partial {name?, description?, baseRole?, features?, canModerate?, color?}. ' +
        'The id is immutable; built-in roles cannot be patched here — use agil_set_access_policy (roleDefaults). ' +
        'Validates the merged role, supports `dryRun`. Falls back to PATCH config when the admin endpoint is absent. Requires a running server.',
      inputSchema: z.object({
        id: z.string().min(1).max(40).describe('Custom role id'),
        patch: rolePatchSchema,
        dryRun: z.boolean().default(false),
      }),
      handler: async (args, ctx) => {
        const existing = await loadRoles(ctx);
        const current = existing.roles.find((role) => role.id === args.id);
        if (!current) {
          throw new ToolError(
            `Role "${args.id}" not found.`,
            `Available roles: ${existing.roles.map((role) => role.id).join(', ')}.`,
          );
        }
        if (current.builtin !== false) {
          throw new ToolError(
            `Built-in role "${args.id}" cannot be updated via the roles API.`,
            'Edit its feature list with agil_set_access_policy({policy:{roleDefaults:{...}}}).',
          );
        }
        const defined: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(args.patch)) {
          if (value !== undefined) defined[key] = value;
        }
        const merged = customRoleSchema.parse({ ...asWireRole(current), ...defined });
        const { errors, warnings } = roleWarnings({
          role: merged,
          existingRoles: existing.roles,
          updating: true,
          reserved: RESERVED_ROLE_IDS,
        });
        if (errors.length > 0) throw new ToolError(`Invalid role:\n${errors.join('\n')}`);
        if (args.dryRun) {
          return jsonOutcome({ dryRun: true, applied: false, role: merged, changes: diffConfigs(asWireRole(current), merged), warnings });
        }
        try {
          const saved = await ctx.client.put<Record<string, unknown>>(
            `/v1/admin/roles/${encodeURIComponent(args.id)}`,
            asWireRole(merged),
          );
          return jsonOutcome({ dryRun: false, applied: true, role: merged, warnings, response: saved });
        } catch (error) {
          if (error instanceof ApiError && (error.status === 404 || error.status === 405 || error.status === 501)) {
            const customRoles = existing.roles
              .filter((role) => role.builtin === false)
              .map((role) => (role.id === merged.id ? merged : asWireRole(role)));
            const after = await patchCustomRoles(ctx, customRoles);
            return jsonOutcome({
              dryRun: false,
              applied: true,
              role: merged,
              warnings,
              source: 'config-patch',
              etag: after.etag,
              note: 'Admin roles endpoint is absent; saved via PATCH security.accessPolicy.customRoles.',
            });
          }
          throw error;
        }
      },
    }),

    defineTool({
      name: 'agil_delete_role',
      title: 'Delete custom role',
      description:
        'Delete a company-defined role (DELETE /v1/admin/roles/:id). Built-in roles cannot be deleted (their defaults are edited via agil_set_access_policy). ' +
        'Live tokens issued with this role fall back to their baseRole until expiry. Supports `dryRun`. Falls back to PATCH config when the admin endpoint is absent. ' +
        'Requires a running server.',
      inputSchema: z.object({
        id: z.string().min(1).max(40).describe('Custom role id'),
        dryRun: z.boolean().default(false),
      }),
      handler: async (args, ctx) => {
        const existing = await loadRoles(ctx);
        const current = existing.roles.find((role) => role.id === args.id);
        if (!current) {
          throw new ToolError(`Role "${args.id}" not found.`, `Available roles: ${existing.roles.map((role) => role.id).join(', ')}.`);
        }
        if (current.builtin !== false) {
          throw new ToolError(
            `Built-in role "${args.id}" cannot be deleted.`,
            'Use agil_set_access_policy to change its roleDefaults instead.',
          );
        }
        const warnings =
          current.assigned && current.assigned > 0
            ? [`${current.assigned} participant(s)/token(s) currently use this role; live tokens fall back to baseRole "${current.baseRole}" until expiry.`]
            : [];
        if (args.dryRun) {
          return jsonOutcome({ dryRun: true, deleted: false, id: args.id, role: current, warnings });
        }
        try {
          const saved = await ctx.client.request<Record<string, unknown>>(`/v1/admin/roles/${encodeURIComponent(args.id)}`, {
            method: 'DELETE',
          });
          return jsonOutcome({ dryRun: false, deleted: true, id: args.id, fallbackRole: current.baseRole, warnings, response: saved });
        } catch (error) {
          if (error instanceof ApiError && (error.status === 404 || error.status === 405 || error.status === 501)) {
            const customRoles = existing.roles
              .filter((role) => role.builtin === false && role.id !== args.id)
              .map(asWireRole);
            const after = await patchCustomRoles(ctx, customRoles);
            return jsonOutcome({
              dryRun: false,
              deleted: true,
              id: args.id,
              fallbackRole: current.baseRole,
              warnings,
              source: 'config-patch',
              etag: after.etag,
              note: 'Admin roles endpoint is absent; removed via PATCH security.accessPolicy.customRoles.',
            });
          }
          throw error;
        }
      },
    }),

    defineTool({
      name: 'agil_get_ai_agent',
      title: 'Get AI agent settings',
      description:
        'Get the corporate AI-agent configuration from session.aiAgent (GET /v1/admin/ai-agent). ' +
        'The API key itself is never returned — only the env-var name (apiKeyEnv) and whether the server can resolve it. Requires a running server.',
      inputSchema: z.object({}),
      handler: async (_args, ctx) => jsonOutcome(await ctx.client.get<unknown>('/v1/admin/ai-agent')),
    }),

    defineTool({
      name: 'agil_set_ai_agent',
      title: 'Update AI agent settings',
      description:
        'Merge a partial AI-agent config into session.aiAgent (PUT /v1/admin/ai-agent). ' +
        'Validates the payload locally first (mode, timeout, batch size, policyRules…). Never send the secret itself — use `apiKeyEnv`. ' +
        'Requires a running server.',
      inputSchema: z.object({
        config: aiAgentConfigSchema
          .partial()
          .describe(
            'Partial AiAgentConfig: {enabled?, mode?: local|external|hybrid, endpoint?, apiKeyEnv?, timeoutMs?, sendTranscripts?, sendChat?, batchSize?, retentionMin?, notifyModerators?, policyText?, policyRules?}',
          ),
      }),
      handler: async (args, ctx) =>
        jsonOutcome(await ctx.client.put<unknown>('/v1/admin/ai-agent', { config: args.config })),
    }),

    defineTool({
      name: 'agil_get_access_policy',
      title: 'Get access policy',
      description:
        'Get the tenant access policy plus the effective feature list per role (GET /v1/admin/access-policy; resolved with resolveAccess). ' +
        'Also returns customRoles (company-defined roles) and a role summary — use agil_list_roles for full role definitions. ' +
        'Falls back to TenantConfig.security.accessPolicy. Requires a running server.',
      inputSchema: z.object({}),
      handler: async (_args, ctx) => {
        let payload: Record<string, unknown>;
        let source: 'admin' | 'config' = 'admin';
        try {
          payload = await ctx.client.get<Record<string, unknown>>('/v1/admin/access-policy');
        } catch (error) {
          if (error instanceof ApiError && (error.status === 404 || error.status === 405 || error.status === 501)) {
            const configPayload = await ctx.client.get<ConfigResponse>(tenantPath(ctx.client, '/config'), { auth: false });
            payload = { policy: configPayload.config.security.accessPolicy };
            source = 'config';
          } else {
            throw error;
          }
        }
        const policy = isPlainObject(payload.policy) ? payload.policy : null;
        const customRoles = Array.isArray(policy?.customRoles) ? policy.customRoles : [];
        return jsonOutcome({
          tenantId: ctx.client.tenantId,
          source,
          ...payload,
          customRoles,
          roleSummary: {
            builtin: [...BUILTIN_ROLE_IDS],
            customCount: customRoles.length,
            customLimit: 30,
          },
          docs: 'agil/core/docs/api-guide.md',
        });
      },
    }),

    defineTool({
      name: 'agil_set_access_policy',
      title: 'Update access policy',
      description:
        'Merge a partial AccessPolicy into security.accessPolicy (PUT /v1/admin/access-policy). ' +
        'With dryRun=true nothing is saved: the policy is merged locally, the effective features per role are recomputed ' +
        'with resolveAccess and the diff is returned. ' +
        'Example: deny recording and the knowledge agent for guests → {deniedFeatures:["recording","knowledgeAgent"]} or edit roleDefaults.guest. ' +
        'Requires a running server.',
      inputSchema: z.object({
        policy: accessPolicyPartialSchema,
        dryRun: z.boolean().default(false).describe('Compute the effective policy locally without saving'),
      }),
      handler: async (args, ctx) => {
        const current = await ctx.client.get<AccessPolicyResponse>('/v1/admin/access-policy');
        const merged = accessPolicySchema.parse(deepMerge(current.policy, args.policy));
        const changes = diffConfigs(current.policy, merged);
        if (args.dryRun) {
          const configPayload = await ctx.client.get<ConfigResponse>(tenantPath(ctx.client, '/config'), { auth: false });
          let effective: Record<Role, FeatureKey[]>;
          try {
            effective = computeEffective(configPayload.config, merged);
          } catch (error) {
            throw new ToolError(
              `The policy would be invalid: ${error instanceof Error ? error.message : String(error)}`,
              'Check that every feature key exists in features.',
            );
          }
          return jsonOutcome({
            dryRun: true,
            applied: false,
            tenantId: ctx.client.tenantId,
            policy: merged,
            featureKeys: current.featureKeys,
            effective,
            changes,
            changeSummary: summarizeChanges(changes),
          });
        }
        const saved = await ctx.client.put<AccessPolicyResponse>('/v1/admin/access-policy', {
          policy: args.policy,
        });
        return jsonOutcome({
          dryRun: false,
          applied: true,
          tenantId: ctx.client.tenantId,
          ...saved,
          changes: diffConfigs(current.policy, saved.policy),
        });
      },
    }),

    defineTool({
      name: 'agil_get_knowledge_agent',
      title: 'Get knowledge agent settings',
      description:
        'Get the corporate knowledge-agent (wiki/RAG) configuration from session.knowledgeAgent (GET /v1/admin/knowledge-agent). ' +
        'Returns config, endpointConfigured and apiKeyConfigured — never the key. Requires a running server.',
      inputSchema: z.object({}),
      handler: async (_args, ctx) => jsonOutcome(await ctx.client.get<unknown>('/v1/admin/knowledge-agent')),
    }),

    defineTool({
      name: 'agil_set_knowledge_agent',
      title: 'Update knowledge agent settings',
      description:
        'Merge a partial KnowledgeAgentConfig into session.knowledgeAgent (PUT /v1/admin/knowledge-agent). ' +
        'Fields: enabled, endpoint, apiKeyEnv (env-var name, never the secret), timeoutMs, allowedRoles, requirePermission, citations, maxAnswerChars, systemPrompt, denyMessage. ' +
        'Requires a running server.',
      inputSchema: z.object({
        config: knowledgeAgentPartialSchema,
      }),
      handler: async (args, ctx) =>
        jsonOutcome(await ctx.client.put<unknown>('/v1/admin/knowledge-agent', { config: args.config })),
    }),

    defineTool({
      name: 'agil_ask_knowledge_agent',
      title: 'Ask knowledge agent',
      description:
        'Ask the corporate knowledge agent a question (POST /v1/admin/knowledge/ask). ' +
        'Returns {answer, citations[], confidence?, refused?}. Citations are untrusted URLs: render them safely. ' +
        'The server enforces the knowledge-agent permissions; online-only.',
      inputSchema: z.object({
        question: z.string().min(1).max(2000).describe('Question for the corporate wiki / RAG agent'),
        userId: z.string().max(128).optional(),
        role: roleSchema.optional(),
        roomId: z.string().max(64).optional(),
        locale: z.enum(['ru', 'en']).optional(),
      }),
      handler: async (args, ctx) => {
        const body: Record<string, unknown> = { question: args.question };
        if (args.userId !== undefined) body.userId = args.userId;
        if (args.role !== undefined) body.role = args.role;
        if (args.roomId !== undefined) body.roomId = args.roomId;
        if (args.locale !== undefined) body.locale = args.locale;
        const answer = await ctx.client.post<Record<string, unknown>>('/v1/admin/knowledge/ask', body);
        return jsonOutcome({
          tenantId: ctx.client.tenantId,
          ...answer,
          citationsNote: 'Citation URLs come from the company knowledge base and are untrusted; open them with rel="noopener noreferrer".',
        });
      },
    }),

    defineTool({
      name: 'agil_get_webhooks',
      title: 'Get webhook endpoints',
      description:
        'List configured webhook endpoints and the most recent delivery records ' +
        '(GET /v1/admin/webhooks). Webhook events: room.created, room.closed, participant.joined/left, chat.message, file.shared, ' +
        'recording.ready, transcript.ready, analysis.ready, knowledge.answer, compliance.finding, security.event. Requires a running server.',
      inputSchema: z.object({}),
      handler: async (_args, ctx) => jsonOutcome(await ctx.client.get<WebhooksResponse>('/v1/admin/webhooks')),
    }),

    defineTool({
      name: 'agil_set_webhooks',
      title: 'Replace webhook endpoints',
      description:
        'Replace the whole webhook endpoint list (PUT /v1/admin/webhooks; stored in integrations.webhooks). ' +
        'Each endpoint: {id, url (HTTPS), events[], secretEnv (env-var name of the HMAC secret), enabled, retries, timeoutMs, description?}. ' +
        'The payload is validated locally first. Requires a running server.',
      inputSchema: z.object({
        webhooks: webhooksInputSchema,
      }),
      handler: async (args, ctx) =>
        jsonOutcome(await ctx.client.put<unknown>('/v1/admin/webhooks', { webhooks: args.webhooks })),
    }),

    defineTool({
      name: 'agil_test_webhook',
      title: 'Test webhook delivery',
      description:
        'Send a test `security.event` delivery to one configured webhook endpoint (POST /v1/admin/webhooks/test). ' +
        'Returns {endpointId, status, statusCode?, error?}. Requires a running server.',
      inputSchema: z.object({
        endpointId: z.string().min(1).max(64),
      }),
      handler: async (args, ctx) =>
        jsonOutcome(await ctx.client.post<unknown>('/v1/admin/webhooks/test', { endpointId: args.endpointId })),
    }),

    defineTool({
      name: 'agil_get_openapi',
      title: 'Get OpenAPI spec',
      description:
        'Fetch the live OpenAPI 3.1 specification (GET /openapi.json) and optionally filter it by tag ' +
        '(e.g. "admin", "rooms", "access", "knowledge", "webhooks"). ' +
        'Use it to discover exact request/response schemas; the interactive explorer is served at /docs. Requires a running server.',
      inputSchema: z.object({
        tag: z.string().max(60).optional().describe('Return only operations with this tag'),
      }),
      handler: async (args, ctx) => {
        const spec = await ctx.client.get<OpenApiSpec>('/openapi.json', { auth: false });
        if (!args.tag) return jsonOutcome(spec);
        const tag = args.tag;
        const filteredPaths: Record<string, Record<string, unknown>> = {};
        for (const [path, operations] of Object.entries(spec.paths ?? {})) {
          if (!isPlainObject(operations)) continue;
          const matching: Record<string, unknown> = {};
          for (const [method, operation] of Object.entries(operations)) {
            const { tags } = methodSummary(operation);
            if (tags.includes(tag)) matching[method] = operation;
          }
          if (Object.keys(matching).length > 0) filteredPaths[path] = matching;
        }
        return jsonOutcome({
          openapi: spec.openapi ?? '3.1.0',
          info: spec.info,
          servers: spec.servers,
          tags: spec.tags,
          components: spec.components,
          filter: { tag },
          availableTags: API_TAGS,
          paths: filteredPaths,
        });
      },
    }),

    defineTool({
      name: 'agil_get_api_endpoints',
      title: 'List API endpoints',
      description:
        'Return a compact list of every API endpoint (method, path, summary, tags, auth). ' +
        'Reads the live OpenAPI document when the server is available and falls back to the embedded catalog from docs/contract.md when it is not — ' +
        'so this tool also works offline. Use it to find the right endpoint before calling admin tools.',
      inputSchema: z.object({
        tag: z.string().max(60).optional().describe('Filter by tag, e.g. "admin" or "webhooks"'),
      }),
      handler: async (args, ctx) => {
        let endpoints: ApiEndpointDoc[];
        let source: 'live' | 'embedded';
        let note: string | undefined;
        try {
          const spec = await ctx.client.get<OpenApiSpec>('/openapi.json', { auth: false, timeoutMs: 4000 });
          endpoints = endpointsFromOpenApi(spec);
          source = 'live';
        } catch (error) {
          if (error instanceof ServerUnavailableError || error instanceof ApiError) {
            endpoints = API_ENDPOINTS;
            source = 'embedded';
            note = `Server unavailable (${ctx.env.serverUrl}); returned the embedded API catalog. Start the server to get the live OpenAPI list.`;
          } else {
            throw error;
          }
        }
        const filtered = args.tag ? endpoints.filter((endpoint) => endpoint.tags.includes(args.tag ?? '')) : endpoints;
        return jsonOutcome({
          source,
          ...(note ? { note } : {}),
          count: filtered.length,
          endpoints: filtered,
        });
      },
    }),

    defineTool({
      name: 'agil_get_audit',
      title: 'Get audit log',
      description:
        'Read tenant audit entries (GET /v1/admin/audit?limit=&type=&roomId=). IP addresses are stored only as salted hashes. ' +
        'Event types: room.created, room.closed, join.allowed, join.denied, password.failed, geo.blocked, lockout, config.updated, ' +
        'recording.*, file.shared, chat.sent, integrity.flagged, session.bound, knowledge.query, knowledge.denied, access.updated, admin.action. ' +
        'Requires a running server.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).default(50),
        type: z.string().max(60).optional().describe('Audit event type filter'),
        roomId: z.string().max(64).optional(),
      }),
      handler: async (args, ctx) =>
        jsonOutcome(
          await ctx.client.get<unknown>('/v1/admin/audit', {
            query: { limit: args.limit, type: args.type, roomId: args.roomId },
          }),
        ),
    }),

    defineTool({
      name: 'agil_get_security_overview',
      title: 'Get security overview',
      description:
        'Get the tenant security overview: recent events, failed/blocked joins (24h), suspicious participants and country distribution ' +
        '(GET /v1/admin/security). Requires a running server.',
      inputSchema: z.object({}),
      handler: async (_args, ctx) => jsonOutcome(await ctx.client.get<unknown>('/v1/admin/security')),
    }),

    defineTool({
      name: 'agil_get_server_health',
      title: 'Get server health',
      description:
        'Check whether the AGIL server is reachable and healthy (GET /v1/health): version, uptime, rooms, tenants and security features ' +
        '(geo, media integrity, STT, AI agent). Use it before online tools to give the user a clear diagnosis. No auth needed.',
      inputSchema: z.object({}),
      handler: async (_args, ctx) => jsonOutcome(await ctx.client.get<HealthResponse>('/v1/health', { auth: false })),
    }),
  ];
}
