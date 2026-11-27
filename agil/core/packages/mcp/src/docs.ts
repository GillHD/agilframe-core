/**
 * Built-in documentation served by the agil_get_docs tool and by MCP resources.
 * These strings are the single source of truth for what an LLM can learn offline.
 */
export const DOC_TOPICS = ['theming', 'api', 'embedding', 'security', 'mcp', 'ai-agent'] as const;
export type DocTopic = (typeof DOC_TOPICS)[number];

export const DOCS: Record<DocTopic, string> = {
  theming: `# AgilFrame theming

The embeddable widget has no hard-coded colors: everything is rendered from _design tokens_
exposed as CSS custom properties (\`--agil-color-primary\`, \`--agil-radius-md\`, …).

## Theme shape

A theme is \`{ scheme, colors, typography, shape, spacing, background, logo, motion }\`.

- \`scheme\`: \`light\` | \`dark\` | \`auto\` (\`auto\` follows \`prefers-color-scheme\`).
- \`colors\`: 36 tokens (\`primary\`, \`onPrimary\`, \`background\`, \`surface\`, \`text\`,
  \`textSecondary\`, \`danger\`, \`chatOutgoingBg\`, \`controlBg\`, \`focusRing\`, …).
- \`typography\`: font families, base size, weights, line height, letter spacing.
- \`shape\`: corner radii, shadows, backdrop blur.
- \`spacing\`: density (\`compact\`/\`comfortable\`/\`spacious\`), gutter, control size/gap.
- \`background\`: \`solid\` | \`gradient\` | \`image\` + overlay opacity.
- \`logo\`: url, alt, height, position (\`header-left\`, \`header-center\`, \`watermark\`).
- \`motion\`: speed and durations.

## Presets

\`light\`, \`dark\`, \`corporate\`, \`night\`, \`minimal\` — complete validated themes.
Patch a preset instead of writing all tokens from scratch.

## Brand color in one call

\`agil_generate_theme({ brandColor: "#0b5fff", preset: "corporate", scheme: "light" })\`
returns a complete theme, CSS variables and contrast issues. It derives hover/active,
on-primary/accent text colors, focus ring and accent hue automatically.

## Apply it

\`agil_apply_theme_to_config({ config, brandColor: "#0b5fff" })\` returns a new validated
TenantConfig. Or send just the patch over HTTP:

\`\`\`json
PATCH /v1/tenants/demo/config
{ "theme": { "scheme": "light", "colors": { "primary": "#0b5fff" } } }
\`\`\`

## Accessibility

\`agil_audit_accessibility({ theme })\` checks WCAG contrast (4.5:1 body text, 3:1 large
text/UI) and suggests replacement colors. Always run it after customizing colors.`,

  api: `# AgilFrame HTTP API (v1)

JSON over HTTP, prefix \`/v1\`, errors are \`{ error: { code, message } }\`.
Admin endpoints require the tenant API key in \`x-api-key\`.

## Public

| Method | Path | Notes |
|---|---|---|
| GET | /v1/health | server name, version, uptime, rooms, tenants, security flags |
| GET | /v1/ice | Public STUN servers. The room welcome supplies TURN. |
| GET | /v1/tenants/:tenantId/config | \`{config, etag}\`; unknown tenant returns the default config |
| POST | /v1/rooms/:roomId/join | join by link; checks password/geo/lock/limits, returns a join token |
| POST | /v1/rooms/:roomId/assistant | in-call assistant: phrase → text + actions + spotlight (join token) |
| POST | /v1/rooms/:roomId/chat | post a chat message with a join token (external chat bridge) |
| POST | /v1/files, /v1/recordings, /v1/stt/transcribe | participant uploads (Bearer join token) |

## Admin (\`x-api-key\`)

| Method | Path | Notes |
|---|---|---|
| GET | /v1/admin/overview | KPI: rooms, participants, recordings, security events |
| GET/POST | /v1/admin/rooms | list / create a room (password stored only as a scrypt hash) |
| GET/DELETE | /v1/admin/rooms/:roomId | room detail (participants, chat, links) / close |
| POST | /v1/admin/rooms/:roomId/invites | short-lived invite link |
| POST | /v1/admin/rooms/:roomId/lock \\| /kick | lock the room / remove a participant |
| POST | /v1/admin/rooms/:roomId/chat | bot/system chat message from the company system (§22) |
| GET | /v1/admin/rooms/:roomId/transcript | transcript segments |
| GET/POST | /v1/admin/rooms/:roomId/analysis[/run] | compliance report, findings, notes |
| GET | /v1/admin/audit?limit=&type=&roomId= | audit log, IP stored only as a salted hash |
| GET | /v1/admin/security | security overview (failed joins, blocked joins, countries) |
| GET/PUT | /v1/admin/ai-agent | corporate AI-agent settings (secret is an env-var name, never the key) |
| GET/PUT | /v1/admin/access-policy | per-role/per-user feature policy + effective list per role |
| GET/PUT | /v1/admin/knowledge-agent | corporate knowledge agent (wiki/RAG) settings |
| POST | /v1/admin/knowledge/ask | ask the knowledge agent; answer + citations |
| GET/PUT | /v1/admin/webhooks | webhook endpoints + recent deliveries / replace the list |
| POST | /v1/admin/webhooks/test | send a test security.event delivery |
| GET/PUT | /v1/admin/providers | 6 replaceable capability providers: status / merge config |
| POST | /v1/admin/providers/test | signed test call to one provider slot |
| GET/PUT | /v1/admin/in-call-agent | in-call assistant settings (session.inCallAgent, local/external/hybrid) |
| GET/PUT | /v1/admin/scale | scale-out: media mode, signaling nodes, SFU, TURN pool, webinar, streaming, CDN |
| GET | /v1/admin/cluster/status | multi-node signaling status (nodes, LB strategy, Redis/sticky) |
| POST/GET | /v1/admin/cluster/tokens | issue a one-time Core/Node enrollment token / list tokens (hashes only) |
| DELETE | /v1/admin/cluster/tokens/:tokenId | revoke an enrollment token |
| GET/PATCH | /v1/admin/nodes, /v1/admin/nodes/:nodeId | node registry (role/features/capacity/status) / update |
| POST | /v1/admin/nodes/:nodeId/disable, …/drain | disable/enable or drain a node |
| POST | /v1/cluster/join | standby Core joins with a core token |
| POST | /v1/nodes/register, /v1/nodes/:nodeId/heartbeat | node enrollment (token) and liveness (node key) |
| GET/POST | /v1/admin/roles | built-in + custom roles / create a custom role |
| PUT/DELETE | /v1/admin/roles/:roleId | update / delete a custom role (built-ins via access-policy) |
| POST | /v1/admin/assistant | dashboard assistant (LLM + role system prompts, local fallback) |
| GET | /v1/admin/assistant/prompts | 7 dashboard-assistant role prompts |
| POST | /v1/rooms/:roomId/egress/start | start egress recording/RTMP/HLS |
| POST | /v1/rooms/:roomId/egress/stop | stop one/all egress sessions |
| GET | /v1/rooms/:roomId/egress/list | list egress sessions (URLs redacted) |
| GET | /v1/admin/egress/status | egress worker status |
| GET/POST | /scim/v2/Users | SCIM users: list/create (Bearer AGIL_SCIM_TOKEN, x-tenant-id) |
| GET/PATCH/DELETE | /scim/v2/Users/:id | SCIM user read/patch/delete |
| GET/POST | /scim/v2/Groups | SCIM groups: list/create |
| GET/PATCH/DELETE | /scim/v2/Groups/:id | SCIM group read/patch/delete |
| GET | /scim/v2/ServiceProviderConfig | SCIM capabilities (patch/filter, maxResults 1000) |
| POST | /v1/admin/guard/assess | risk assessment of a proposed change (findings + confirmation) |
| GET/POST | /v1/rooms/:roomId/polls | list polls/Q&A with results / create a poll (host) |
| POST | /v1/rooms/:roomId/polls/:pollId/vote | vote in a poll (participant, idempotent) |
| POST | /v1/rooms/:roomId/polls/:pollId/close | close a poll (host/moderator) |
| GET | /v1/tenants/:tenantId/backgrounds | virtual backgrounds (builtin config or external provider) |
| PATCH/PUT | /v1/tenants/:tenantId/config | update config; broadcast to live room sockets |
| GET | /openapi.json | OpenAPI 3.1 specification of everything above |
| GET | /docs | self-contained interactive API explorer (no CDN) |

Codes: \`unauthorized, forbidden, not_found, password_required, password_invalid,
geo_blocked, room_locked, room_full, rate_limited, file_too_large, unsupported_mime,
stt_not_configured, validation_failed, internal_error\`.`,

  embedding: `# Embedding AgilFrame

Two supported modes, both served by the AGIL server.

## SDK mode (\`/sdk/agil-calls.js\`)

\`\`\`html
<script src="http://localhost:8787/sdk/agil-calls.js"></script>
<div id="agil-call" style="height: 640px"></div>
<script>
  AGILCalls.mount('#agil-call', {
    room: 'team-sync',
    token: '<short-lived JWT>',
    serverUrl: 'http://localhost:8787',
    tenantId: 'demo',
    theme: { scheme: 'auto' }
  });
</script>
\`\`\`

\`mount\` returns a Promise of the widget instance: \`join, leave, destroy, updateTheme,
updateConfig, setThemeScheme, sendChat, toggleMic, toggleCamera, toggleScreenShare,
setBlurMode, getStats, getState, on\`.

## iframe mode (\`/embed.html\`)

\`\`\`html
<iframe
  src="http://localhost:8787/embed.html?room=team-sync&token=JWT&tenant=demo&lang=ru&theme=auto"
  allow="camera; microphone; display-capture; fullscreen"
  style="width:100%;height:640px;border:0"></iframe>
\`\`\`

Query params: \`server, room, token, tenant, lang (ru|en), theme (light|dark|auto), name, role\`.

## Layout, mini-mode and external chat (contract §22)

\`config.layout\` controls how much call UI the embed renders and how it survives
navigation:

- \`chrome: 'full' | 'compact' | 'none'\` — \`none\` renders only the video grid and
  controls, so the call becomes part of the company page (no header/background).
- \`minimized: {enabled, mode:'bar'|'bubble', position, showSelfView, keepControls}\` —
  collapse the call into a floating window that keeps audio/video running while the
  user navigates; Chromium can additionally use Document Picture-in-Picture
  (\`requestPictureInPicture()\`), other browsers fall back to the floating panel.
- \`persistAcrossPages: true\` — keeps \`{room, token, tenant, name, theme}\` in
  \`sessionStorage\`; on the next page call \`AGILCalls.resume()\` (or
  \`mount({resume:true})\`). In a SPA mount once and the call never drops.
- \`inheritHostStyles: true\` — unset tokens fall back to the host page fonts/colors.

SDK calls: \`minimize()\`, \`restore()\`, \`isMinimized()\`, \`persistSession(enabled?)\`,
\`resume()\`, \`setChatMode('builtin'|'external'|'hidden')\`.

Chat ownership lives in \`session.chat\`: \`ui:'builtin'|'external'|'hidden'\`,
\`externalProviderName\`, \`allowHostInjection\`, \`allowSystemMessages\`. With
\`ui:'external'\` the widget hides its own chat: host receives
\`{type:'agil:chat'}\`/\`onEvent('chat')\` and sends replies via
\`instance.sendChat(text)\`, \`postMessage {type:'agil:chat-send', text}\` or the
server API (\`POST /v1/rooms/:roomId/chat\` with a join token,
\`POST /v1/admin/rooms/:roomId/chat\` for bots/CRM).

## postMessage contract

Parent → iframe: \`{type:'agil:config', config}\`, \`{type:'agil:theme', theme}\`,
\`{type:'agil:scheme', scheme}\`, \`{type:'agil:action', action}\`, \`{type:'agil:ping'}\`.

iframe → parent: \`{type:'agil:ready', capabilities}\`, \`{type:'agil:event', event, payload}\`,
\`{type:'agil:chat', message}\`, \`{type:'agil:state', state}\`, \`{type:'agil:pong'}\`.

§22 additions: parent → iframe \`{type:'agil:chat-send', text}\` and
\`{type:'agil:action', action:'minimize'|'restore'|'pip'}\`; iframe → parent
\`{type:'agil:minimized', minimized:boolean}\`.

## Tokens

Room links contain a short-lived JWT. Mint them server-side (\`POST /v1/tokens\` or
\`agil_create_token\`); never ship the tenant API key to a browser.`,

  security: `# AgilFrame security

## Keys and tokens

- Tenant API key (\`x-api-key\`) is server-side only; the server maps it to a tenant.
- Participants get short-lived JWT join tokens (HS256, default TTL 1h) with
  \`tenant, room, participant, role\` claims. \`AGIL_ALLOW_ANONYMOUS=1\` is a demo-only escape hatch.
- Every tool response must be validated: server/LLM input is untrusted (zod on the server,
  zod schemas in the MCP tools).

## Rooms

- Optional room password: sent once at creation, stored **only** as a scrypt hash
  (\`hashPassword\`, N=16384 r=8 p=1). The API returns \`passwordProtected\`, never the password.
- Lockout after \`security.maxFailedJoinAttempts\` failures for \`lockoutSec\`.
- \`security.waitingRoom\`, \`lockRoom\`, \`moderatorJoinFirst\`, guest permissions.

## Access policy (who sees what)

\`security.accessPolicy\` decides the effective feature list per participant:
role defaults → per-user override → token permissions → remove \`deniedFeatures\` →
intersect with enabled \`features.*\`. Mode \`strict\` ignores role defaults and allows only
explicit grants. The resolved list is sent to the widget (\`welcome.self.permissions\`),
so UI gating and server enforcement agree. Inspect it with \`agil_explain_access\` (offline)
or \`GET /v1/admin/access-policy\`.

## Identity and webhooks

\`integrations.identity\` accepts \`mode:'token'\` (our HS256 JWTs, the MVP path) or
\`mode:'oidc'\`: the server verifies identity/id_token JWTs against \`jwksUrl\`
(RS256/ES256, issuer/audience/exp, nonce in the login flow), and the dashboard logs
in with authorization code + PKCE (\`authorizationEndpoint\`, \`tokenEndpoint\`,
\`clientId\`, \`clientSecretEnv\`, \`redirectUri\`, \`scopes\`). The code exchange reads the
client secret from the tenant-bound env var named by \`clientSecretEnv\`
(\`AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>\` or an \`AGIL_OIDC_TENANT_SECRETS\` entry). \`integrations.webhooks[]\`
receives signed events (\`x-agil-signature\` = hex HMAC-SHA256 of the raw body, secret
from the env var named by \`secretEnv\`).

## Replaceable providers

\`TenantConfig.providers\` has six slots (\`chat, files, stt, notifications, recording,
backgrounds\`). Each: \`mode builtin|external|disabled\`, \`providerName\`, \`endpoint\`,
\`apiKeyEnv\` (env-var name), \`timeoutMs\`, \`fallback builtin|fail\`, \`options\`. Everything
is builtin by default; external endpoints receive an HMAC-signed JSON envelope and
must answer \`{ok, data}\`. See \`agil/core/docs/extensibility.md\` and use \`agil_explain_providers\`.

## Geo

\`security.geo.allowedCountries\` / \`blockedCountries\` (ISO-3166 alpha-2, uppercase);
empty allowed list means "allow all". Blocked joins emit \`geo.blocked\` and are audited.
\`blockVpn\` rejects proxy/VPN-looking requests when the geo provider can tell.

## Media integrity (anti-deepfake)

Honest limits: browser heuristics are probabilistic. \`security.mediaIntegrity\` supports
a liveness challenge, client frame-timing heuristics and an optional external detector
(\`AGIL_INTEGRITY_URL\`). Legally meaningful verification requires an external model plus
liveness challenges and C2PA-signed recordings.

## Audit

JSONL per tenant (\`.data/audit/<tenantId>.jsonl\`). IPs are stored as \`sha256(ip + salt)\`.
Event types include \`join.allowed, join.denied, password.failed, geo.blocked, lockout,
config.updated, integrity.flagged\`.

## Transport

- WebRTC media is DTLS-SRTP encrypted (mandatory in browsers).
- \`security.e2ee\` is the per-tenant E2EE flag (insertable streams) — verify support in the
  widget before promising it to users.
- Serve production over HTTPS/WSS; STUN/TURN via \`AGIL_ICE_SERVERS\`.`,

  mcp: `# AgilFrame MCP server

\`@agil/mcp\` is a stdio Model Context Protocol server: it lets an LLM inspect, validate and
improve AgilFrame embeds, themes and tenant configs.

## Environment

- \`AGIL_SERVER_URL\` (default \`http://localhost:8787\`)
- \`AGIL_API_KEY\` (default \`dev-key\`) — never printed
- \`AGIL_TENANT_ID\` (default \`demo\`)
- \`AGIL_MCP_TIMEOUT_MS\` (default 8000)
- \`AGIL_MCP_MODE=read\` — only read/design tools are registered (no config/room/webhook mutations)

## HTTP transport (streamable HTTP)

stdio is the default. For a centralized agent run the HTTP entry:

\`\`\`bash
AGIL_MCP_HTTP_ENABLED=1 AGIL_MCP_HTTP_TOKEN=<token> \\
AGIL_MCP_HTTP_ALLOW_IPS=10.0.0.0/8 AGIL_MCP_HTTP_PORT=8791 \\
node agil/core/packages/mcp/dist/http.js
\`\`\`

- Endpoint: \`POST /mcp\` (stateless, JSON responses; no session id).
- Auth: \`Authorization: Bearer $AGIL_MCP_HTTP_TOKEN\` (constant-time compare); missing/wrong → 401.
- \`AGIL_MCP_HTTP_ALLOW_IPS\` allowlist on the real connection IP (IPv4 CIDR + exact IPs) → 403.
- \`cache-control: no-store\`, body limit (\`AGIL_MCP_HTTP_MAX_BODY_BYTES\`, default 1 MiB → 413).
- Ports: keep HTTP-MCP (8791) separate from the API (8787); do not expose it to the public ingress.

Access modes: stdio is launched by the user's agent; HTTP is issued by the company
(Bearer token + IP allowlist + separate port); \`AGIL_MCP_MODE=read\` lets an agent
analyze data without changing the tenant. Full guide: \`agil/core/docs/api-exposure.md\`.

## Offline tools (no server needed)

\`agil_get_config_schema\`, \`agil_validate_config\`, \`agil_generate_theme\`,
\`agil_apply_theme_to_config\`, \`agil_apply_theme\`, \`agil_list_theme_presets\`,
\`agil_audit_accessibility\`, \`agil_suggest_lowbandwidth_profile\`, \`agil_get_embed_snippet\`,
\`agil_summarize_meeting\`, \`agil_analyze_compliance\`, \`agil_explain_access\`, \`agil_explain_providers\`,
\`agil_get_assistant_tools\`, \`agil_explain_spotlight\`, \`agil_explain_feature\`, \`agil_explain_scaling\`, \`agil_explain_roles\`, \`agil_get_docs\`.

## Online tools (require a running server)

\`agil_get_config\`, \`agil_update_config\`, \`agil_create_room\`, \`agil_create_invite\`,
\`agil_create_token\`, \`agil_list_rooms\`, \`agil_get_room\`, \`agil_get_transcript\`,
\`agil_get_analysis\`, \`agil_run_analysis\`, \`agil_get_ai_agent\`, \`agil_set_ai_agent\`,
\`agil_get_access_policy\`, \`agil_set_access_policy\`, \`agil_get_knowledge_agent\`,
\`agil_set_knowledge_agent\`, \`agil_ask_knowledge_agent\`, \`agil_post_room_chat\`,
\`agil_set_chat_mode\`, \`agil_get_webhooks\`,
\`agil_set_webhooks\`, \`agil_test_webhook\`, \`agil_get_providers\`, \`agil_set_providers\`,
\`agil_test_provider\`, \`agil_get_in_call_agent\`, \`agil_set_in_call_agent\`,
\`agil_get_scale\`, \`agil_set_scale\`, \`agil_get_cluster_status\`, \`agil_list_roles\`,\n\`agil_list_polls\`, \`agil_create_poll\`, \`agil_vote_poll\`, \`agil_close_poll\`,
\`agil_create_role\`, \`agil_update_role\`, \`agil_delete_role\`, \`agil_assess_change\`,
\`agil_dashboard_assistant\`, \`agil_list_assistant_prompts\`,
\`agil_get_openapi\`, \`agil_get_api_endpoints\`,
\`agil_get_audit\`, \`agil_get_security_overview\`, \`agil_get_server_health\`.

\`agil_get_api_endpoints\` falls back to an embedded endpoint catalog when the server is
unreachable — it works offline too.

When the server is unreachable, online tools return \`isError: true\` with a message that
names \`AGIL_SERVER_URL\`; offline tools keep working, so a model can still prepare a config
and embed snippet.

## Recommended flow

1. \`agil_get_config_schema\` (learn the fields) → 2. \`agil_generate_theme\` (brand color) →
3. \`agil_apply_theme_to_config\` (merge) → 4. \`agil_validate_config\` + \`agil_audit_accessibility\`
→ 5. \`agil_update_config\` with \`dryRun: true\` (review diff) → 6. \`agil_update_config\` →
7. \`agil_get_embed_snippet\` for the site.

Resources: \`agil://docs/theming\`, \`agil://docs/api\`, \`agil://docs/security\`,
\`agil://config/schema\`. Prompts: \`agil-brand-setup\`, \`agil-embed-install\`,
\`agil-compliance-review\`.

## In-call assistant (docs/in-call-agent.md, docs/llm-integrations.md)

\`session.inCallAgent\`: enabled, mode \`local\` (deterministic offline intent engine) |
\`external\` | \`hybrid\`, endpoint, apiKeyEnv, timeoutMs, systemPrompt, model, spotlight,
allowedTools (18 tools), maxActionsPerReply, audit, denyMessage.

The assistant acts **strictly with the user permissions**: actions are filtered by
\`isAssistantToolAllowed\` (feature + role) on the client and re-checked + audited on
the server. "Where do I press?" answers use **spotlight** targets (\`mic\`, \`camera\`,
\`screen\`, \`chat\`, \`files\`, \`participants\`, \`notes\`, \`settings\`, \`blur\`, \`recording\`,
\`minimize\`, \`fullscreen\`, \`newtab\`, \`invite\`). Explore offline with
\`agil_get_assistant_tools\`, \`agil_explain_spotlight\`, \`agil_explain_feature\`; configure
with \`agil_get_in_call_agent\` / \`agil_set_in_call_agent\`.

## Scaling and multi-node (docs/scaling.md)

\`TenantConfig.scale\`: mediaMode \`mesh\` (P2P default) | \`sfu\` | \`broadcast\`,
maxParticipants up to 50 000, maxVideoSubscriptions, signaling (nodeId, Redis URL,
pubsub channel, sticky sessions, node list), SFU (LiveKit/mediasoup), TURN pool
(\`credentialEnv\` is an env-var name), load balancer, webinar (hostOnlyPublish,
viewerLimit, chatMode, reactions, raise-hand queue), streaming (rtmp/hls/webrtc)
and CDN. The contract/admin API are implemented; Redis fan-out, real SFU
orchestration and CDN integration are roadmap. Use \`agil_explain_scaling\`
(offline), \`agil_get_scale\`, \`agil_set_scale\` (dryRun first) and
\`agil_get_cluster_status\`.

## Roles: built-in and custom (docs/api-guide.md §3)

Three built-in roles (\`host\`/\`moderator\`/\`guest\`) plus up to 30
\`security.accessPolicy.customRoles\`. A token can carry \`roleId\`; effective features are
resolved as: token permissions → user override → **custom role** → strict → role defaults,
then \`deniedFeatures\` are removed and the result is intersected with enabled \`features.*\`.
Custom roles are edited via \`/v1/admin/roles\`; built-in defaults only via
\`/v1/admin/access-policy\`. Use \`agil_explain_roles\` (offline), \`agil_list_roles\`,
\`agil_create_role\` / \`agil_update_role\` / \`agil_delete_role\` (dryRun + validation) and
\`agil_create_token({ roleId })\`; \`agil_get_access_policy\` returns \`customRoles\`.

## Dashboard assistant and guard

\`POST /v1/admin/assistant\` answers dashboard questions with an LLM (DeepSeek by
default) using a role instruction held in Core. Roles: \`assistant\`, \`config-guardian\`, \`security-reviewer\`, \`onboarding\`,
\`api-helper\`, \`scaling-advisor\`, \`roles-admin\`. \`GET /v1/admin/assistant/prompts\`
returns role metadata and starter questions. If the endpoint/key is missing the assistant falls
back to the deterministic \`localAssistantReply\` (no network).

\`POST /v1/admin/guard/assess\` evaluates a proposed change (config/roles/access/scale/
providers/webhook/room/integrations): \`{risk, requiresConfirmation, summary, message,
findings, recommendations}\`. On 404/405/501 or when the server is down, MCP works
locally via \`assessChange\` (@agil/ai) using the live tenant config (or protocol
defaults) and marks the reply \`fallback:true\` with a reason.

Tools: \`agil_assess_change\`, \`agil_dashboard_assistant\`, \`agil_list_assistant_prompts\`.
**Rule:** before any risky change call \`agil_assess_change\`, show findings and
recommendations, and ask for explicit confirmation when required — never perform
critical changes without consent, never print secrets.

MCP prompts delegate the seven roles to \`agil_dashboard_assistant\`: \`dashboard-assistant\`,
\`config-guardian\`, \`security-reviewer\`, \`onboarding\`, \`api-helper\`, \`scaling-advisor\`,
\`roles-admin\`.

## Replaceable providers (contract §23)

Six capability slots — \`chat, files, stt, notifications, recording, backgrounds\` —
work **builtin** by default and can be pointed at the company's own systems:
\`agil_get_providers\` (status), \`agil_set_providers\` (merge, \`dryRun\`),
\`agil_test_provider\` (signed test call), \`agil_explain_providers\` (offline guide).
Full manual: \`agil/core/docs/extensibility.md\`. Chat routing (\`providers.chat\`) is separate
from the chat UI (\`session.chat.ui\`).`,

  'ai-agent': `# Corporate AI agent, compliance and meeting notes

## Local, deterministic layer (always on)

- \`ComplianceEngine\` runs \`phrase\`, \`regex\` and \`pii\` rules over transcript segments.
  It needs no network and no model: \`agil_analyze_compliance\` is fully offline.
- \`LocalNotesExtractor\` builds extractive meeting notes with **verbatim excerpts**
  (quote + speaker + timecodes), a summary, action items, decisions, risks and topics.
  \`agil_summarize_meeting\` is fully offline.

## Tenant config

\`session.aiAgent\`: \`{ enabled, mode: 'local'|'external'|'hybrid', endpoint, apiKeyEnv,
timeoutMs, sendTranscripts, sendChat, batchSize, retentionMin, notifyModerators,
policyText, policyRules[] }\`.

\`policyRules\` item: \`{ id, name, type: 'phrase'|'regex'|'pii'|'external', pattern,
severity: 'info'|'warn'|'critical', action: 'flag'|'warn'|'mute'|'block', enabled }\`.

The server never stores the AI-agent key: \`apiKeyEnv\` names an environment variable.

## External agent contract

The server POSTs \`AiAgentRequest\` (\`requestId, tenantId, roomId, segments, chat, policy,
participants\`) to \`endpoint\` with \`x-agil-signature\` (HMAC-SHA256 of the body),
\`x-agil-request-id\` and \`x-agil-tenant\`. The answer is schema-validated
(\`findings[]\`, optional \`notes\`) and clamped — external AI output is untrusted input.

## Findings

Each finding: \`{ ruleId, ruleName, severity, action, participantId?, excerpt, confidence?,
recommendation? }\`. Findings are shown to moderators, written to the audit log and
attached to the recording transcript.

## Knowledge agent (corporate wiki / RAG)

\`session.knowledgeAgent\`: \`{ enabled, endpoint, apiKeyEnv, timeoutMs, allowedRoles,
requirePermission, citations, maxAnswerChars, systemPrompt, denyMessage }\`. The server
proxies a question to the company's RAG endpoint with an HMAC signature, validates the
answer with zod and returns \`{answer, citations[], confidence?, refused?}\`. We never store
wiki content; citation URLs are untrusted (render with \`rel="noopener noreferrer"\`).
Access: role check → optional \`knowledgeAgent\` feature permission → endpoint configured.
Use \`agil_ask_knowledge_agent\` (server) and \`agil_explain_access\` (offline) to debug it.

## Legal note

AI-assisted compliance review is a helper, not a legal guarantee. Keep the original
transcript and recordings (with consent) as evidence.`,
};

export function getDocMarkdown(topic: DocTopic): string {
  return DOCS[topic];
}
