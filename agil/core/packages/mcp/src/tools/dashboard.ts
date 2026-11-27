/**
 * Dashboard assistant, prompt library and critical-change guard tools.
 *
 * The Core assistant and a guard that assesses a proposed change before it is applied.
 * Every tool has a deterministic local fallback (`assessChange`,
 * `localAssistantReply`, `ASSISTANT_PROMPTS`) and reports when it fell back.
 */
import { z } from 'zod';
import {
  defaultConfig,
  type DashboardAssistantRequest,
  type DashboardAssistantResponse,
  type DashboardAssistantRole,
  type GuardAssessRequest,
  type GuardAssessResponse,
} from '@agil/protocol';
import { ASSISTANT_PROMPTS, assessChange, localAssistantReply } from '@agil/ai';
import { ApiError, ServerUnavailableError } from '../http-client.js';
import { defineTool, jsonOutcome, type AnyToolSpec, type ToolContext } from '../tool-kit.js';

const CHANGE_KINDS = [
  'config',
  'roles',
  'access',
  'scale',
  'providers',
  'webhook',
  'room',
  'integrations',
] as const;

const ASSISTANT_ROLES = [
  'assistant',
  'config-guardian',
  'security-reviewer',
  'onboarding',
  'api-helper',
  'scaling-advisor',
  'roles-admin',
] as const satisfies readonly DashboardAssistantRole[];

const changeKindSchema = z.enum(CHANGE_KINDS);
const assistantRoleSchema = z.enum(ASSISTANT_ROLES);
const assistantCatalogueSchema = z.object({ prompts: z.array(z.object({
  role: assistantRoleSchema, title: z.string(), description: z.string(), starters: z.array(z.string()),
})) });

const messageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1).max(4000),
});

const contextSchema = z.object({
  screen: z.string().max(120).optional(),
  tenantId: z.string().max(64).optional(),
  roomId: z.string().max(64).optional(),
  currentConfig: z.record(z.string(), z.unknown()).optional(),
});

interface FallbackInfo {
  fallback: true;
  reason: string;
  note: string;
}

/** Decides whether an error means "endpoint missing/unreachable/invalid → use local fallback". */
function localFallbackReason(error: unknown): string | null {
  if (error instanceof ServerUnavailableError) return 'server_unavailable';
  if (error instanceof ApiError) {
    if ([404, 405, 501].includes(error.status)) return `endpoint_${error.status}`;
    if (error.code === 'invalid_response') return 'invalid_response';
  }
  return null;
}

async function liveTenantConfig(ctx: ToolContext): Promise<unknown> {
  try {
    const payload = await ctx.client.get<{ config?: unknown }>(
      `/v1/tenants/${encodeURIComponent(ctx.env.tenantId)}/config`,
      { auth: false },
    );
    return payload.config ?? payload;
  } catch {
    return defaultConfig({ tenantId: ctx.env.tenantId });
  }
}

function fallbackInfo(reason: string, what: string): FallbackInfo {
  return {
    fallback: true,
    reason,
    note: `${what} unavailable on the server (${reason}); answered locally with @agil/ai. Start the server/endpoint or set the provider key to get model answers.`,
  };
}

export function dashboardToolSpecs(): AnyToolSpec[] {
  return [
    defineTool({
      name: 'agil_assess_change',
      title: 'Assess a risky change (guard)',
      description:
        'Assess a proposed dashboard change BEFORE applying it (guard). Returns risk (low|medium|high|critical), requiresConfirmation, summary, a plain-language message, findings ' +
        '(severity/title/impact/affected/confirmation) and safer recommendations. Kinds: config|roles|access|scale|providers|webhook|room|integrations. ' +
        'Calls POST /v1/admin/guard/assess; on 404/405/501 or when the server is down it falls back to the deterministic local `assessChange` (@agil/ai) ' +
        'with the live tenant config (or protocol defaults) and marks the reply with `fallback:true` + reason. ' +
        'Always show findings and ask for explicit confirmation before promoting a critical change. Requires a server for live context.',
      inputSchema: z.object({
        kind: changeKindSchema,
        next: z.unknown().describe('Proposed value (config patch, role list, access policy, scale/provider/webhook change, …)'),
        current: z.unknown().optional().describe('Current value; server uses the live tenant config when omitted'),
        intent: z.string().max(300).optional().describe('Human intent, e.g. "выключить запись звонков"'),
      }),
      handler: async (args, ctx) => {
        const request: GuardAssessRequest = {
          kind: args.kind,
          next: args.next,
          ...(args.current !== undefined ? { current: args.current } : {}),
          ...(args.intent ? { intent: args.intent } : {}),
        };
        try {
          const response = await ctx.client.post<GuardAssessResponse>('/v1/admin/guard/assess', request);
          if (typeof response?.message !== 'string' || typeof response?.risk !== 'string') {
            throw new ApiError('invalid_response', 'Guard endpoint returned an unexpected payload', 502);
          }
          return jsonOutcome({ ...response, source: 'server', fallback: false, tenantId: ctx.env.tenantId });
        } catch (error) {
          const reason = localFallbackReason(error);
          if (!reason) throw error;
          const current = args.current !== undefined ? args.current : await liveTenantConfig(ctx);
          let response: GuardAssessResponse;
          try {
            response = assessChange(request, current, {});
          } catch (assessError) {
            throw new Error(
              `Local guard could not assess the change: ${assessError instanceof Error ? assessError.message : String(assessError)}`,
            );
          }
          return jsonOutcome({
            ...response,
            source: 'local',
            tenantId: ctx.env.tenantId,
            ...fallbackInfo(reason, 'Guard endpoint'),
            guidance:
              'Present the findings to the admin, recommend safer alternatives, and require explicit confirmation when requiresConfirmation=true.',
          });
        }
      },
    }),

    defineTool({
      name: 'agil_dashboard_assistant',
      title: 'Ask the dashboard assistant',
      description:
        'Ask the AgilFrame dashboard assistant (the mascot). Sends the conversation to POST /v1/admin/assistant with an optional role ' +
        '(assistant|config-guardian|security-reviewer|onboarding|api-helper|scaling-advisor|roles-admin) and context {screen, tenantId, roomId, currentConfig}. ' +
        'Returns reply, role, model, fallback and suggestions (+optional risk assessment). ' +
        'If the endpoint is missing/unreachable it answers with the deterministic local `localAssistantReply` (@agil/ai) and says so (`fallback:true`, model "local-rules"). ' +
        'Never paste secrets (API keys, tokens, env values) into messages. Requires a server for model answers.',
      inputSchema: z.object({
        messages: z.array(messageSchema).min(1).max(50),
        role: assistantRoleSchema.optional(),
        context: contextSchema.optional(),
      }),
      handler: async (args, ctx) => {
        const request: DashboardAssistantRequest = {
          messages: args.messages,
          ...(args.role ? { role: args.role } : {}),
          ...(args.context ? { context: args.context } : {}),
        };
        try {
          const response = await ctx.client.post<DashboardAssistantResponse>('/v1/admin/assistant', request);
          if (typeof response?.reply !== 'string') {
            throw new ApiError('invalid_response', 'Assistant endpoint returned an unexpected payload', 502);
          }
          return jsonOutcome({ ...response, source: 'server' });
        } catch (error) {
          const reason = localFallbackReason(error);
          if (!reason) throw error;
          const local = localAssistantReply(request);
          return jsonOutcome({
            ...local,
            source: 'local',
            model: local.model || 'local-rules',
            ...fallbackInfo(reason, 'Dashboard assistant endpoint'),
            modelHint:
              'Local rule engine: answers are deterministic and may be shorter than the model (DeepSeek) answer. The reason contains the exact fallback trigger.',
          });
        }
      },
    }),

    defineTool({
      name: 'agil_list_assistant_prompts',
      title: 'List assistant role prompts',
      description:
        'List dashboard-assistant roles with title, description and starter questions. ' +
        'Reads GET /v1/admin/assistant/prompts or returns the built-in role catalogue when Core is unavailable. ' +
        'Use agil_dashboard_assistant({role,messages}) to ask the assistant.',
      inputSchema: z.object({}),
      handler: async (_args, ctx) => {
        try {
          const payload = assistantCatalogueSchema.safeParse(await ctx.client.get('/v1/admin/assistant/prompts'));
          if (payload.success) {
            return jsonOutcome({
              source: 'server',
              fallback: false,
              count: payload.data.prompts.length,
              prompts: payload.data.prompts,
            });
          }
          throw new ApiError('invalid_response', 'Assistant prompts endpoint returned an unexpected payload', 502);
        } catch (error) {
          const reason = localFallbackReason(error);
          if (!reason) throw error;
          const prompts = ASSISTANT_PROMPTS;
          return jsonOutcome({
            source: 'local',
            count: prompts.length,
            prompts,
            ...fallbackInfo(reason, 'Assistant prompts endpoint'),
          });
        }
      },
    }),
  ];
}
