/**
 * Shared MCP server factory used by both transports (stdio and streamable HTTP).
 *
 * Tool exposure modes (docs/api-exposure.md, docs/mcp.md):
 *  - `AGIL_MCP_MODE=full` (default) registers every tool;
 *  - `AGIL_MCP_MODE=read` registers only read/design tools — `tools/list` is
 *    filtered (the list is intentionally smaller), and accidental calls to a
 *    write tool return a clear `isError: true` instead of running it.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpEnv } from './env.js';
import { findPrompt, PROMPTS, promptNames } from './prompts.js';
import { createResources, findResource, resourceUris } from './resources.js';
import { registerTools, type AnyToolSpec, type RegisteredTool, type ToolContext } from './tool-kit.js';
import { offlineToolSpecs } from './tools/offline.js';
import { onlineToolSpecs } from './tools/online.js';
import { dashboardToolSpecs } from './tools/dashboard.js';
import { pollToolSpecs, POLL_PERMISSION_NOTE } from './tools/polls.js';
import { scimToolSpecs } from './tools/scim.js';
import { egressToolSpecs } from './tools/egress.js';
import { billingToolSpecs } from './tools/billing.js';

export const SERVER_NAME = 'agil-calls-mcp';
export const SERVER_VERSION = '0.1.0';

/** Mutating tools: excluded from AGIL_MCP_MODE=read (single source of truth). */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'agil_update_config',
  'agil_create_room',
  'agil_create_invite',
  'agil_create_token',
  'agil_run_analysis',
  'agil_post_room_chat',
  'agil_set_chat_mode',
  'agil_set_ai_agent',
  'agil_set_access_policy',
  'agil_set_knowledge_agent',
  'agil_set_webhooks',
  'agil_test_webhook',
  'agil_set_providers',
  'agil_test_provider',
  'agil_set_in_call_agent',
  'agil_set_scale',
  'agil_create_role',
  'agil_update_role',
  'agil_delete_role',
  'agil_create_poll',
  'agil_vote_poll',
  'agil_close_poll',
  'scim_create_user',
  'scim_update_user',
  'scim_delete_user',
  'scim_create_group',
  'scim_update_group',
  'scim_delete_group',
  'egress_start_recording',
  'egress_start_rtmp',
  'egress_start_hls',
  'egress_stop',
]);

const BASE_INSTRUCTIONS = [
  'AgilFrame MCP server: inspect, validate and improve AgilFrame video-call embeds.',
  '',
  'Offline tools (no server needed): agil_get_config_schema, agil_validate_config, agil_generate_theme,',
  'agil_apply_theme_to_config, agil_apply_theme, agil_list_theme_presets, agil_audit_accessibility,',
  'agil_suggest_lowbandwidth_profile, agil_get_embed_snippet, agil_summarize_meeting, agil_analyze_compliance,',
  'agil_explain_access, agil_explain_providers, agil_get_assistant_tools, agil_explain_spotlight,',
  'agil_explain_feature, agil_explain_scaling, agil_explain_roles, agil_get_docs.',
  '',
  'Online tools (need AGIL_SERVER_URL, default http://localhost:8787): agil_get_config, agil_update_config,',
  'agil_create_room, agil_create_invite, agil_create_token, agil_list_rooms, agil_get_room, agil_get_transcript,',
  'agil_get_analysis, agil_run_analysis, agil_post_room_chat, agil_get_ai_agent, agil_set_ai_agent,',
  'agil_get_access_policy, agil_set_access_policy, agil_get_knowledge_agent, agil_set_knowledge_agent,',
  'agil_ask_knowledge_agent, agil_get_webhooks, agil_set_webhooks, agil_test_webhook, agil_set_chat_mode,',
  'agil_get_providers, agil_set_providers, agil_test_provider, agil_get_in_call_agent, agil_set_in_call_agent,',
  'agil_preview_in_call_command uses the room participant token from AGIL_MCP_PARTICIPANT_TOKEN and previews the assistant reply without executing actions.',
  'agil_get_scale, agil_set_scale, agil_get_cluster_status, agil_list_roles, agil_create_role,',
  'agil_update_role, agil_delete_role, agil_assess_change, agil_dashboard_assistant,',
  'agil_list_assistant_prompts, agil_list_polls, agil_create_poll, agil_vote_poll, agil_close_poll,',
  'SCIM provisioning: scim_list_users, scim_get_user, scim_list_groups, scim_service_provider_config (read-only);',
  'scim_create_user, scim_update_user, scim_delete_user, scim_create_group, scim_update_group, scim_delete_group (write).',
  'SCIM auth: Bearer token from env AGIL_SCIM_TOKEN + tenantId= x-tenant-id; never print the token. SCIM roles are data only — no admin rights.',
  'Egress/RTMP/HLS: egress_status, egress_list (read); egress_start_recording, egress_start_rtmp (rtmpUrl), egress_start_hls, egress_stop (write).',
  'Billing/quota (read-only): billing_usage (monthly minutes/participants/recordings + live + quota warnings), billing_status (plan, limits, overage policy). No card data; no payment tools.',
  'Never print RTMP URLs or stream keys: results are redacted; the MCP does not log them.',
  'agil_get_openapi, agil_get_api_endpoints, agil_get_audit, agil_get_security_overview, agil_get_server_health.',
  '',
  'SAFETY RULES (critical): before ANY risky change (features, security, access policy, roles,',
  'scale, providers, webhooks, room limits) call agil_assess_change("config"|"roles"|"access"|"scale"|',
  '"providers"|"webhook"|"room"|"integrations", next, intent) and show its findings + recommendations',
  'in plain language. If requiresConfirmation=true or risk is high/critical, ASK for explicit',
  'confirmation BEFORE calling write tools (agil_update_config, agil_set_*, agil_create_*,',
  'agil_delete_*, agil_set_scale, …). Never perform critical changes without explicit consent.',
  'Never print secrets: API keys, tokens, passwords, HMAC secrets or env values; apiKeyEnv/',
  'credentialEnv are env-var NAMES. For dashboard questions use agil_dashboard_assistant or',
  'agil_list_assistant_prompts; MCP role prompts delegate requests to the Core assistant.',
  '',
  'Recommended flow: agil_get_config_schema → agil_generate_theme / agil_explain_access →',
  'agil_apply_theme_to_config → agil_validate_config + agil_audit_accessibility →',
  'agil_update_config(dryRun=true) → agil_update_config → agil_get_embed_snippet.',
  '',
  'Resources: agil://docs/theming, agil://docs/api, agil://config/schema, agil://docs/security, agil://docs/embedding.',
  POLL_PERMISSION_NOTE,
  'Prompts: agil-brand-setup, agil-embed-install, agil-compliance-review + 7 assistant roles',
  '(dashboard-assistant, config-guardian, security-reviewer, onboarding, api-helper, scaling-advisor, roles-admin).',
].join('\n');

const READ_ONLY_NOTE =
  '\n\nREAD-ONLY MODE (AGIL_MCP_MODE=read): only read/design tools are registered. ' +
  'Config, room, webhook, provider, SCIM and egress mutations are disabled; ask the operator to restart MCP in full mode if a change is required.';

export interface ServerBundle {
  server: Server;
  tools: RegisteredTool[];
}

export function log(message: string): void {
  // stderr only: stdout carries the MCP protocol.
  console.error(`[agil-mcp] ${message}`);
}

/** All tool specs with transport flags applied. */
export function allToolSpecs(): AnyToolSpec[] {
  return [
    ...offlineToolSpecs(),
    ...onlineToolSpecs().map((spec) => ({ ...spec, online: true })),
    // Dashboard assistant & guard endpoints — same HTTP server, local fallbacks inside.
    ...dashboardToolSpecs().map((spec) => ({ ...spec, online: true })),
    ...pollToolSpecs().map((spec) => ({ ...spec, online: true })),
    ...scimToolSpecs().map((spec) => ({ ...spec, online: true })),
    ...egressToolSpecs().map((spec) => ({ ...spec, online: true })),
    ...billingToolSpecs().map((spec) => ({ ...spec, online: true })),
    // The write flag is derived from one central list so read mode stays in sync.
  ].map((spec) => ({ ...spec, write: WRITE_TOOL_NAMES.has(spec.name) }));
}

/** Tool specs visible in the given exposure mode. */
export function toolSpecsForMode(mode: McpEnv['mode']): AnyToolSpec[] {
  const specs = allToolSpecs();
  return mode === 'read' ? specs.filter((spec) => !spec.write) : specs;
}

/** Builds the MCP server with tools/resources/prompts registered for the mode. */
export function createMcpServer(toolContext: ToolContext): ServerBundle {
  const mode = toolContext.env.mode;
  const instructions = mode === 'read' ? `${BASE_INSTRUCTIONS}${READ_ONLY_NOTE}` : BASE_INSTRUCTIONS;
  const server = new Server(
    { name: SERVER_NAME, title: 'AgilFrame', version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions,
    },
  );

  const tools = registerTools(toolSpecsForMode(mode), toolContext);
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
  const resources = createResources();
  const prompts = PROMPTS;

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArguments } = request.params;
    const tool = toolByName.get(name);
    if (!tool) {
      const readOnlyHint =
        mode === 'read' && WRITE_TOOL_NAMES.has(name)
          ? ` Tool "${name}" is a write tool and is disabled in read-only mode (AGIL_MCP_MODE=read).`
          : '';
      return {
        content: [
          {
            type: 'text' as const,
            text: `Unknown tool "${name}".${readOnlyHint} Available tools: ${tools.map((entry) => entry.name).join(', ')}.`,
          },
        ],
        isError: true,
      };
    }
    const outcome = await tool.run(rawArguments);
    log(`tool ${name} ${outcome.isError ? 'failed' : 'ok'}`);
    return {
      content: [{ type: 'text' as const, text: outcome.text }],
      ...(outcome.isError ? { isError: true } : {}),
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      title: resource.title,
      description: resource.description,
      mimeType: resource.mimeType,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    const { uri } = request.params;
    const resource = findResource(uri, resources);
    if (!resource) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown resource "${uri}". Available resources: ${resourceUris(resources)}.`,
      );
    }
    return {
      contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.read() }],
    };
  });

  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: prompts.map((prompt) => ({
      name: prompt.name,
      title: prompt.title,
      description: prompt.description,
      arguments: prompt.arguments.map((argument) => ({
        name: argument.name,
        description: argument.description,
        required: argument.required,
      })),
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, (request) => {
    const { name, arguments: rawArguments } = request.params;
    const prompt = findPrompt(name, prompts);
    if (!prompt) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown prompt "${name}". Available prompts: ${promptNames(prompts)}.`,
      );
    }
    const args: Record<string, string | undefined> = {};
    if (rawArguments && typeof rawArguments === 'object') {
      for (const [key, value] of Object.entries(rawArguments)) {
        if (typeof value === 'string') args[key] = value;
      }
    }
    const rendered = prompt.render(args);
    return { description: rendered.description, messages: rendered.messages };
  });

  return { server, tools };
}
