# @agil/mcp

Stdio [Model Context Protocol](https://modelcontextprotocol.io) server for AgilFrame.
It lets an LLM inspect, validate and improve call embeds, tenant configs, themes,
access policies and transcripts — with **offline** tools that need no server and
**online** tools backed by the AgilFrame HTTP API.

Full documentation: [`agil/core/docs/mcp.md`](../../docs/mcp.md).

## Build & run

```bash
npm run build -w @agil/mcp
node agil/core/packages/mcp/dist/index.js     # stdio; normally launched by the MCP client
```

`@agil/ai` must be built before this package (`npm run build -w @agil/ai`) because
`agil_summarize_meeting` and `agil_analyze_compliance` use its local extractor and
compliance engine.

### HTTP transport (streamable HTTP)

```bash
AGIL_MCP_HTTP_ENABLED=1 \
AGIL_MCP_HTTP_TOKEN='<strong token>' \
AGIL_MCP_HTTP_ALLOW_IPS='127.0.0.1,10.0.0.0/8' \
AGIL_MCP_HTTP_PORT=8791 \
node agil/core/packages/mcp/dist/http.js
# or: npm run start:http -w @agil/mcp
# or: AGIL_MCP_HTTP_ENABLED=1 node agil/core/packages/mcp/dist/index.js
```

- `POST /mcp` — stateless streamable HTTP with JSON responses;
  `Authorization: Bearer $AGIL_MCP_HTTP_TOKEN` (constant-time compare, 401 otherwise),
  `AGIL_MCP_HTTP_ALLOW_IPS` allowlist (403), `cache-control: no-store`, body limit
  (`AGIL_MCP_HTTP_MAX_BODY_BYTES`, default 1 MiB → 413).
- Keep the HTTP-MCP port (`8791`) separate from the API (`8787`); don't expose it publicly.
- `AGIL_MCP_MODE=read` (both transports) registers only read/design tools (51 of 83):
  `agil_update_config`, `agil_create_*`, `agil_set_*`, `agil_post_room_chat` and friends
  are not available, so an agent cannot change the tenant by accident.
- Access model, allowlists and deployment recipes: `agil/core/docs/api-exposure.md` and
  `agil/core/docs/mcp.md` («HTTP-режим и токен», «Read-only режим»).

Env: `AGIL_SERVER_URL` (default `http://localhost:8787`), `AGIL_API_KEY`
(default `dev-key`), `AGIL_TENANT_ID` (default `demo`), `AGIL_MCP_TIMEOUT_MS`
(default `8000`), `AGIL_SCIM_TOKEN` (optional, SCIM Bearer; never logged).
API keys/tokens are never written to logs or error messages.

## Tools

Offline (no network): `agil_get_config_schema`, `agil_validate_config`,
`agil_generate_theme`, `agil_apply_theme_to_config`, `agil_apply_theme`,
`agil_list_theme_presets`, `agil_audit_accessibility`,
`agil_suggest_lowbandwidth_profile`, `agil_get_embed_snippet`,
`agil_summarize_meeting`, `agil_analyze_compliance`, `agil_explain_access`,
`agil_explain_providers`, `agil_get_assistant_tools`, `agil_explain_spotlight`,
`agil_explain_feature`, `agil_explain_scaling`, `agil_explain_roles`, `agil_get_docs`.

Online (AGIL server): `agil_get_config`, `agil_update_config`, `agil_create_room`,
`agil_create_invite`, `agil_create_token`, `agil_list_rooms`, `agil_get_room`,
`agil_get_transcript`, `agil_get_analysis`, `agil_run_analysis`, `agil_post_room_chat`,
`agil_set_chat_mode`, `agil_get_ai_agent`,
`agil_set_ai_agent`, `agil_get_access_policy`, `agil_set_access_policy`,
`agil_get_knowledge_agent`, `agil_set_knowledge_agent`, `agil_ask_knowledge_agent`,
`agil_get_webhooks`, `agil_set_webhooks`, `agil_test_webhook`, `agil_get_providers`,
`agil_set_providers`, `agil_test_provider`, `agil_get_in_call_agent`,
`agil_set_in_call_agent`, `agil_get_scale`, `agil_set_scale`,
`agil_get_cluster_status`, `agil_get_openapi`,
`agil_list_roles`, `agil_create_role`, `agil_update_role`, `agil_delete_role`,
`agil_assess_change`, `agil_dashboard_assistant`, `agil_list_assistant_prompts`,
`agil_list_polls`, `agil_create_poll`, `agil_vote_poll`, `agil_close_poll`,
`scim_list_users`, `scim_get_user`, `scim_list_groups`, `scim_service_provider_config`,
`scim_create_user`, `scim_update_user`, `scim_delete_user`, `scim_create_group`,
`scim_update_group`, `scim_delete_group`,
`egress_status`, `egress_list`, `egress_start_recording`, `egress_start_rtmp`,
`egress_start_hls`, `egress_stop`,
`billing_usage`, `billing_status`,
`agil_get_api_endpoints`, `agil_get_audit`, `agil_get_security_overview`,
`agil_get_server_health`.

Scaling (`agil/core/docs/scaling.md`): `agil_explain_scaling` (offline guide for
mesh/sfu/broadcast, Redis/multi-node, TURN pool, webinar/streaming/CDN),
`agil_get_scale` / `agil_set_scale` (deep-partial merge, `dryRun`, diff and
semantic warnings) and `agil_get_cluster_status`; both read from the admin
endpoint and fall back to `TenantConfig.scale` when it is absent.

Roles (`agil/core/docs/api-guide.md` §3): `agil_explain_roles` (offline guide: built-in vs
custom roles, precedence, examples), `agil_list_roles` /
`agil_create_role` / `agil_update_role` / `agil_delete_role` (validated, `dryRun`,
reserved-id/duplicate/limit checks, fallback to PATCH `customRoles`);
`agil_create_token` accepts `roleId`, `agil_get_access_policy` returns `customRoles`.

Room polls (Wave 1): `agil_list_polls` (results; read mode), `agil_create_poll`
(host/moderator, validated `dryRun`), `agil_vote_poll` (participant, idempotent,
`dryRun`), `agil_close_poll` (host/moderator, `dryRun`). Errors explain 403/404/409
and the required host/moderator vs participant permissions.

SCIM 2.0 provisioning (`/scim/v2/*`): `scim_list_users`, `scim_get_user`,
`scim_list_groups`, `scim_service_provider_config` (read mode); create/update/delete
for users and groups (write mode). Bearer token only from `AGIL_SCIM_TOKEN`, tenant via
`x-tenant-id`; SCIM+JSON, Russian errors, no token in logs/results.

Egress/RTMP/HLS: `egress_status`, `egress_list` (read); `egress_start_recording`,
`egress_start_rtmp`, `egress_start_hls`, `egress_stop` (write). RTMP URLs and
stream keys are redacted from results and never logged.

Billing/quota (read-only, `agil/core/docs/billing.md`): `billing_usage` (monthly room
minutes, rooms, participant joins, peak participants, recordings + live minutes,
quota warnings; optional `month=YYYY-MM`) and `billing_status` (plan,
enforcement flag, limits, overage policy, plan catalog, usage summary). Both are
available in read mode. There are no payment tools and no card data.

Dashboard assistant & guard: `agil_assess_change` (risk/confirmation/findings
before risky changes; local `assessChange` fallback), `agil_dashboard_assistant`
(LLM + role prompt, local `localAssistantReply` fallback; reports `model`/`fallback`),
`agil_list_assistant_prompts` (7 public role prompts). The MCP prompt catalog also
exposes the 7 assistant roles with their system prompts.

**Safety rules in the server instructions:** call `agil_assess_change` before risky
changes, show findings/recommendations, ask for explicit confirmation when required,
never perform critical changes without consent, never print secrets.

`agil_get_embed_snippet` also supports the §22 layout knobs: `chrome`
(full/compact/none), `minimized` (bar/bubble mini-window), `persistAcrossPages`
(plus an `AGILCalls.resume()` hint) and `inheritHostStyles`.

`agil_create_room` supports `mode: direct|group` + `context`
(messenger/conversationId/directPeerId/title) for calls started from a corporate
messenger (see `agil/core/docs/messenger.md`); `agil_get_room` surfaces `mode`/`context`.
Replaceable capability providers (§23, see `agil/core/docs/extensibility.md`) are managed
with `agil_get_providers` / `agil_set_providers` / `agil_test_provider`, and
explained offline by `agil_explain_providers`.

In-call assistant (`agil/core/docs/in-call-agent.md`, `agil/core/docs/llm-integrations.md`):
`agil_get_assistant_tools` lists the 18 user-scoped tools with their
feature/role requirements and spotlight targets; `agil_explain_spotlight` and
`agil_explain_feature` explain the "press here" tours offline; configuration is
read/updated with `agil_get_in_call_agent` / `agil_set_in_call_agent` (falls back
to PATCH `config.session.inCallAgent` when the admin endpoint is absent).

When the server is unreachable, online tools return `isError: true` with a message
naming `AGIL_SERVER_URL`; offline tools keep working.

## Resources & prompts

- Resources: `agil://docs/theming`, `agil://docs/api`, `agil://config/schema`,
  `agil://docs/security`, `agil://docs/embedding`.
- Prompts: `agil-brand-setup`, `agil-embed-install`, `agil-compliance-review`, plus the
  7 dashboard-assistant roles: `dashboard-assistant`, `config-guardian`,
  `security-reviewer`, `onboarding`, `api-helper`, `scaling-advisor`, `roles-admin`.

## Tests

```bash
npm run typecheck -w @agil/mcp
npm test -w @agil/mcp
```

`test/protocol.test.ts` spawns the built `dist/index.js` and speaks JSON-RPC over
stdio (`initialize`, `tools/list`, `tools/call`, resources, prompts), including the
"server is down" behavior. Build the package first.
