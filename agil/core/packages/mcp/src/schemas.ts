/**
 * Shared zod input schemas for MCP tools.
 *
 * Every tool argument that comes from the model is untrusted input: it must be
 * validated here before it reaches the protocol schemas or the HTTP server.
 * `configJsonSchema()`/`configMarkdown()` in `config-doc.ts` describe the full
 * TenantConfig/Theme JSON Schema advertised to clients.
 */
import { z } from 'zod';
import {
  accessPolicySchema,
  compliancePolicyRuleSchema,
  featureKeySchema,
  featureKeys,
  providersSchema,
  providerSlotSchema,
  resolveTenantConfig,
  scaleConfigPatchSchema,
  sessionSchema,
  tenantConfigPatchSchema,
  tenantConfigSchema,
  transcriptSegmentSchema,
  webhookEndpointSchema,
  type FeatureKey,
  type TenantConfig,
  type TenantConfigPatch,
} from '@agil/protocol';
import { CONFIG_SECTIONS } from './config-doc.js';
import { LOW_BANDWIDTH_SCENARIOS } from './constants.js';
import { DOC_TOPICS } from './docs.js';

/** A full TenantConfig or a deep-partial patch; validated by protocol schemas later. */
export const configInputSchema = z
  .record(z.string(), z.unknown())
  .describe('TenantConfig object (full) or a deep-partial patch such as {"theme":{"colors":{"primary":"#0b5fff"}}}');

export const themeInputSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'Theme object: full ThemeTokens or a deep-partial ThemePatch (scheme, colors, typography, shape, spacing, background, logo, motion)',
  );

export const segmentsInputSchema = z
  .array(transcriptSegmentSchema)
  .min(1, 'Provide at least one transcript segment')
  .max(500, 'At most 500 segments per call; batch larger transcripts')
  .describe('Final transcript segments: {id, participantId, participantName, text, start, end, isFinal, ts}');

export const rulesInputSchema = z
  .array(compliancePolicyRuleSchema)
  .max(100)
  .describe(
    'Compliance policy rules {id, name, type: phrase|regex|pii|external, pattern, severity, action, enabled}',
  );

export const featureOverridesSchema = z
  .record(z.string(), z.boolean())
  .describe('Local feature overrides, e.g. {"chat": true, "recording": false}');

export const presetSchema = z.enum(['light', 'dark', 'corporate', 'night', 'minimal']).describe('Base theme preset');

export const schemeSchema = z.enum(['light', 'dark', 'auto']).describe('Color scheme; auto follows the OS preference');

export const configSectionSchema = z
  .enum([...CONFIG_SECTIONS, 'all'] as [string, ...string[]])
  .describe('Restrict the documentation to one top-level section');

export const docTopicSchema = z.enum(DOC_TOPICS).describe('Documentation topic');

export const lowBandwidthScenarioSchema = z.enum(LOW_BANDWIDTH_SCENARIOS).describe('Network scenario');

export const roleSchema = z.enum(['host', 'moderator', 'guest']);

/** Access policy partial update (PUT /v1/admin/access-policy). */
export const accessPolicyPartialSchema = accessPolicySchema
  .partial()
  .describe(
    'Partial AccessPolicy: {mode?: "role-defaults"|"strict", roleDefaults?: {host,moderator,guest: FeatureKey[]}, deniedFeatures?: FeatureKey[], userOverrides?: Record<userId, FeatureKey[]>}',
  );

/** Knowledge-agent partial update (PUT /v1/admin/knowledge-agent). */
export const knowledgeAgentPartialSchema = sessionSchema.shape.knowledgeAgent
  .partial()
  .describe(
    'Partial KnowledgeAgentConfig: {enabled?, endpoint?, apiKeyEnv?, timeoutMs?, allowedRoles?, requirePermission?, citations?, maxAnswerChars?, systemPrompt?, denyMessage?}',
  );

/** Chat ownership partial update (session.chat, contract §22). */
export const sessionChatPartialSchema = sessionSchema.shape.chat
  .partial()
  .describe(
    'Partial session.chat: {ui?: "builtin"|"external"|"hidden", externalProviderName?, allowHostInjection?, allowSystemMessages?}. ' +
      'ui="external" hides the built-in chat and lets the company chat drive it; ui="hidden" disables chat completely.',
  );

/** In-call assistant partial update (session.inCallAgent). */
export const inCallAgentPartialSchema = tenantConfigPatchSchema.shape.session.unwrap().shape.inCallAgent.unwrap()
  .describe(
    'Partial InCallAgentConfig: {enabled?, mode?: local|external|hybrid, endpoint?, apiKeyEnv?, timeoutMs?, systemPrompt?, model?, compressContext?, spotlight?, allowedTools?: AssistantTool[], maxActionsPerReply?, audit?, denyMessage?}. ' +
      'The assistant acts strictly with the user permissions; local mode works offline.',
  );

/** Deep-partial of ScaleConfig (TenantConfig.scale). */
export const scalePatchSchema = scaleConfigPatchSchema
  .describe(
    'Partial ScaleConfig: {mediaMode?: mesh|sfu|broadcast, maxParticipants? 2..50000, maxVideoSubscriptions?, ' +
      'signaling?: {nodeId?, redisUrl?, pubsubChannel?, stickySessions?, nodes?: [{id,url,region,weight}]}, ' +
      'sfu?: {provider?, url?, apiKeyEnv?, apiSecretEnv?, region?, maxParticipants?}, ' +
      'turn?: [{id, urls[], username, credentialEnv, region, weight}], ' +
      'loadBalancer?: {strategy?, healthPath?, stickyCookie?}, ' +
      'webinar?: {enabled?, hostOnlyPublish?, viewerLimit?, chatMode?, reactions?, raiseHandQueue?}, ' +
      'streaming?: {enabled?, provider?, rtmpUrl?, hlsUrl?, latencyMode?}, cdn?: {enabled?, baseUrl?, provider?}}',
  );

/* ------------------------------------------------------------------ */
/* Custom roles (security.accessPolicy.customRoles)                    */
/* ------------------------------------------------------------------ */

export const customRoleSchema = accessPolicySchema.shape.customRoles.element;

const roleIdSchema = customRoleSchema.shape.id.describe(
  'Role id: lowercase latin, digits, _ and - (1..40); built-ins host/moderator/guest are reserved',
);

/** Create payload for agil_create_role / POST /v1/admin/roles. */
export const roleCreateSchema = z
  .object({
    id: roleIdSchema,
    name: customRoleSchema.shape.name,
    description: customRoleSchema.shape.description.default(''),
    baseRole: customRoleSchema.shape.baseRole,
    features: z.array(featureKeySchema).default([]),
    canModerate: z.boolean().default(false),
    color: customRoleSchema.shape.color.default('#4f8cff'),
  })
  .describe(
    'New custom role: {id, name, description?, baseRole: host|moderator|guest, features: FeatureKey[], canModerate?, color?}',
  );

/** Update payload for agil_update_role / PUT /v1/admin/roles/:id (id is immutable). */
export const rolePatchSchema = z
  .object({
    name: customRoleSchema.shape.name.optional(),
    description: customRoleSchema.shape.description.optional(),
    baseRole: customRoleSchema.shape.baseRole.optional(),
    features: z.array(featureKeySchema).optional(),
    canModerate: z.boolean().optional(),
    color: customRoleSchema.shape.color.optional(),
  })
  .describe('Partial custom role to merge: {name?, description?, baseRole?, features?, canModerate?, color?}');

/** Full replacement of the webhook endpoint list. */
export const webhooksInputSchema = z
  .array(webhookEndpointSchema)
  .max(20)
  .describe('Webhook endpoints: {id, url, events: WebhookEventType[], secretEnv, enabled, retries, timeoutMs, description?}');

export const providerSlotNames = [
  'chat',
  'files',
  'stt',
  'notifications',
  'recording',
  'backgrounds',
] as const;

export const providerSlotNameSchema = z
  .enum(providerSlotNames)
  .describe('Capability slot: chat | files | stt | notifications | recording | backgrounds');

const providerSlotPatchSchema = providerSlotSchema.partial();

/**
 * Deep-partial of ProvidersConfig: any or all of the six slots, each a partial
 * slot ({mode, providerName, endpoint, apiKeyEnv, timeoutMs, fallback, options}).
 */
export const providersPatchSchema = z
  .object({
    chat: providerSlotPatchSchema.optional(),
    files: providerSlotPatchSchema.optional(),
    stt: providerSlotPatchSchema.optional(),
    notifications: providerSlotPatchSchema.optional(),
    recording: providerSlotPatchSchema.optional(),
    backgrounds: providerSlotPatchSchema.optional(),
  })
  .describe(
    'Partial ProvidersConfig: {chat?, files?, stt?, notifications?, recording?, backgrounds?}, each {mode?: builtin|external|disabled, providerName?, endpoint?, apiKeyEnv?, timeoutMs?, fallback?: builtin|fail, options?}',
  );

/** Validation helper for a merged providers object (config.providers). */
export function parseProvidersConfig(raw: unknown) {
  return providersSchema.safeParse(raw);
}

export const FEATURE_KEYS = featureKeys as FeatureKey[];

export { featureKeySchema };

export function featureKeysText(): string {
  return FEATURE_KEYS.join(', ');
}

export type ParseConfigResult = { ok: true; config: TenantConfig } | { ok: false; errors: string[] };
export type ParsePatchResult = { ok: true; patch: TenantConfigPatch } | { ok: false; errors: string[] };

function zodErrors(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

/** Resolves a deep-partial patch on top of the protocol defaults (validated). */
export function resolvePatch(patch: TenantConfigPatch, tenantId?: string): TenantConfig {
  return resolveTenantConfig(patch, undefined, tenantId ? { tenantId } : {});
}

/**
 * Accepts either a complete TenantConfig or a deep-partial patch and resolves it
 * into a validated full config (missing fields come from protocol defaults).
 */
export function parseConfigInput(raw: unknown): ParseConfigResult {
  const full = tenantConfigSchema.safeParse(raw);
  if (full.success) return { ok: true, config: full.data };
  const patch = tenantConfigPatchSchema.safeParse(raw);
  if (!patch.success) return { ok: false, errors: zodErrors(patch.error) };
  try {
    return { ok: true, config: resolvePatch(patch.data) };
  } catch (error) {
    if (error instanceof z.ZodError) return { ok: false, errors: zodErrors(error) };
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

/** Parses a raw patch (used by agil_update_config before sending it to the server). */
export function parsePatchInput(raw: unknown): ParsePatchResult {
  const parsed = tenantConfigPatchSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
  return { ok: true, patch: parsed.data };
}
