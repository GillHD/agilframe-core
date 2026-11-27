/**
 * Embedded API catalog — the offline fallback for `agil_get_api_endpoints`.
 *
 * Kept in sync with docs/contract.md §4, §14, §18, §19, §20 and used when the
 * server (and therefore `GET /openapi.json`) is not reachable.
 */
export interface ApiEndpointDoc {
  method: string;
  path: string;
  summary: string;
  tags: string[];
  auth: 'none' | 'api-key' | 'bearer' | 'signature' | 'token' | 'node-key';
}

export const API_TAGS = [
  'health',
  'config',
  'rooms',
  'tokens',
  'admin',
  'access',
  'knowledge',
  'webhooks',
  'providers',
  'assistant',
  'scaling',
  'cluster',
  'roles',
  'billing',
  'openapi',
  'participant',
] as const;

export const API_ENDPOINTS: ApiEndpointDoc[] = [
  // Public
  { method: 'GET', path: '/v1/health', summary: 'Server health, version, uptime, rooms, tenants, security flags', tags: ['health'], auth: 'none' },
  { method: 'GET', path: '/v1/ice', summary: 'Public STUN servers for WebRTC', tags: ['health'], auth: 'none' },
  { method: 'GET', path: '/v1/tenants/:tenantId/config', summary: 'Read tenant config; unknown tenant returns the default config', tags: ['config'], auth: 'none' },
  { method: 'PUT', path: '/v1/tenants/:tenantId/config', summary: 'Replace tenant config (full TenantConfig)', tags: ['config'], auth: 'api-key' },
  { method: 'PATCH', path: '/v1/tenants/:tenantId/config', summary: 'Deep-partial config update; broadcasts to live rooms', tags: ['config'], auth: 'api-key' },
  { method: 'POST', path: '/v1/rooms', summary: 'Create a room (optionally anonymous in demo mode)', tags: ['rooms'], auth: 'api-key' },
  { method: 'POST', path: '/v1/tokens', summary: 'Mint a join token, optionally with pinned feature permissions', tags: ['tokens'], auth: 'api-key' },
  { method: 'POST', path: '/v1/rooms/:roomId/join', summary: 'Join with password/geo/lock checks; returns token + effective permissions', tags: ['participant'], auth: 'none' },
  { method: 'GET', path: '/v1/rooms/:roomId', summary: 'Room details and participants', tags: ['rooms'], auth: 'api-key' },
  { method: 'DELETE', path: '/v1/rooms/:roomId', summary: 'Close a room', tags: ['rooms'], auth: 'api-key' },
  { method: 'GET', path: '/v1/rooms/:roomId/messages', summary: 'Chat history (limit)', tags: ['rooms'], auth: 'api-key' },
  { method: 'GET', path: '/v1/ice', summary: 'ICE configuration', tags: ['health'], auth: 'none' },
  { method: 'POST', path: '/v1/rooms/:roomId/chat', summary: 'Post a chat message with a join token (external chat bridge)', tags: ['participant', 'rooms'], auth: 'bearer' },
  { method: 'POST', path: '/v1/admin/rooms/:roomId/chat', summary: 'Post a bot/system chat message from the company system', tags: ['admin', 'rooms'], auth: 'api-key' },
  { method: 'POST', path: '/v1/files', summary: 'Upload a shared file (raw body + x-file-name)', tags: ['participant'], auth: 'bearer' },
  { method: 'GET', path: '/v1/files/:id', summary: 'Download a shared file via signed URL', tags: ['participant'], auth: 'signature' },
  { method: 'POST', path: '/v1/recordings', summary: 'Upload a call recording', tags: ['participant'], auth: 'bearer' },
  { method: 'GET', path: '/v1/recordings/:id', summary: 'Download a recording via signed URL', tags: ['participant'], auth: 'signature' },
  { method: 'POST', path: '/v1/stt/transcribe', summary: 'Server-side STT fallback (501 when not configured)', tags: ['participant'], auth: 'bearer' },
  // Admin rooms / security
  { method: 'GET', path: '/v1/admin/overview', summary: 'Tenant KPI overview', tags: ['admin'], auth: 'api-key' },
  { method: 'GET', path: '/v1/admin/rooms', summary: 'List rooms with participants and links', tags: ['admin', 'rooms'], auth: 'api-key' },
  { method: 'POST', path: '/v1/admin/rooms', summary: 'Create a room (password stored as scrypt hash)', tags: ['admin', 'rooms'], auth: 'api-key' },
  { method: 'GET', path: '/v1/admin/rooms/:roomId', summary: 'Room detail: participants, chat, links', tags: ['admin', 'rooms'], auth: 'api-key' },
  { method: 'DELETE', path: '/v1/admin/rooms/:roomId', summary: 'Close a room', tags: ['admin', 'rooms'], auth: 'api-key' },
  { method: 'POST', path: '/v1/admin/rooms/:roomId/invites', summary: 'Create a short-lived invite link', tags: ['admin', 'rooms'], auth: 'api-key' },
  { method: 'POST', path: '/v1/admin/rooms/:roomId/lock', summary: 'Lock / unlock a room', tags: ['admin', 'rooms'], auth: 'api-key' },
  { method: 'POST', path: '/v1/admin/rooms/:roomId/kick', summary: 'Remove a participant', tags: ['admin', 'rooms'], auth: 'api-key' },
  { method: 'GET', path: '/v1/admin/rooms/:roomId/transcript', summary: 'Transcript segments of a room', tags: ['admin'], auth: 'api-key' },
  { method: 'GET', path: '/v1/admin/rooms/:roomId/analysis', summary: 'Latest compliance analysis (report, findings, notes)', tags: ['admin'], auth: 'api-key' },
  { method: 'POST', path: '/v1/admin/rooms/:roomId/analysis/run', summary: 'Run the AI/compliance analysis now', tags: ['admin'], auth: 'api-key' },
  { method: 'GET', path: '/v1/admin/ai-agent', summary: 'Corporate AI-agent settings', tags: ['admin'], auth: 'api-key' },
  { method: 'PUT', path: '/v1/admin/ai-agent', summary: 'Update AI-agent settings (secret is an env-var name)', tags: ['admin'], auth: 'api-key' },
  { method: 'GET', path: '/v1/admin/audit', summary: 'Audit log entries (limit/type/roomId filters)', tags: ['admin'], auth: 'api-key' },
  { method: 'GET', path: '/v1/admin/security', summary: 'Security overview: failed/blocked joins, countries, events', tags: ['admin'], auth: 'api-key' },
  { method: 'GET', path: '/v1/admin/recordings', summary: 'List recordings', tags: ['admin'], auth: 'api-key' },
  { method: 'DELETE', path: '/v1/admin/recordings/:id', summary: 'Delete a recording', tags: ['admin'], auth: 'api-key' },
  // Access policy
  { method: 'GET', path: '/v1/admin/access-policy', summary: 'Access policy + effective feature list per role', tags: ['access', 'admin'], auth: 'api-key' },
  { method: 'PUT', path: '/v1/admin/access-policy', summary: 'Merge a partial access policy into security.accessPolicy', tags: ['access', 'admin'], auth: 'api-key' },
  // Knowledge agent
  { method: 'GET', path: '/v1/admin/knowledge-agent', summary: 'Knowledge-agent settings', tags: ['knowledge', 'admin'], auth: 'api-key' },
  { method: 'PUT', path: '/v1/admin/knowledge-agent', summary: 'Update knowledge-agent settings (merge)', tags: ['knowledge', 'admin'], auth: 'api-key' },
  { method: 'POST', path: '/v1/admin/knowledge/ask', summary: 'Ask the corporate knowledge agent (RAG/wiki proxy)', tags: ['knowledge', 'admin'], auth: 'api-key' },
  // Webhooks
  { method: 'GET', path: '/v1/admin/webhooks', summary: 'Webhook endpoints + recent deliveries', tags: ['webhooks', 'admin'], auth: 'api-key' },
  { method: 'PUT', path: '/v1/admin/webhooks', summary: 'Replace the webhook endpoint list (integrations.webhooks)', tags: ['webhooks', 'admin'], auth: 'api-key' },
  { method: 'POST', path: '/v1/admin/webhooks/test', summary: 'Send a test security.event delivery to one endpoint', tags: ['webhooks', 'admin'], auth: 'api-key' },
  // Providers
  { method: 'GET', path: '/v1/admin/providers', summary: 'Status of the 6 capability providers (mode/configured/available/fallback)', tags: ['providers', 'admin'], auth: 'api-key' },
  { method: 'PUT', path: '/v1/admin/providers', summary: 'Merge a partial ProvidersConfig into TenantConfig.providers', tags: ['providers', 'admin'], auth: 'api-key' },
  { method: 'POST', path: '/v1/admin/providers/test', summary: 'Signed test call to one provider slot → {ok, latencyMs, detail}', tags: ['providers', 'admin'], auth: 'api-key' },
  { method: 'GET', path: '/v1/tenants/:tenantId/backgrounds', summary: 'Virtual backgrounds list (builtin config or external provider)', tags: ['providers'], auth: 'none' },
  // In-call assistant
  { method: 'POST', path: '/v1/rooms/:roomId/assistant', summary: 'In-call assistant: text → actions + spotlight (needs a join token)', tags: ['assistant'], auth: 'bearer' },
  { method: 'GET', path: '/v1/admin/in-call-agent', summary: 'In-call assistant settings (session.inCallAgent)', tags: ['assistant', 'admin'], auth: 'api-key' },
  { method: 'PUT', path: '/v1/admin/in-call-agent', summary: 'Update in-call assistant settings (merge)', tags: ['assistant', 'admin'], auth: 'api-key' },
  // Scaling / cluster
  { method: 'GET', path: '/v1/admin/scale', summary: 'Scale-out config: media mode, signaling nodes, SFU, TURN pool, webinar, streaming, CDN', tags: ['scaling', 'admin'], auth: 'api-key' },
  { method: 'PUT', path: '/v1/admin/scale', summary: 'Merge a partial ScaleConfig into TenantConfig.scale', tags: ['scaling', 'admin'], auth: 'api-key' },
  { method: 'GET', path: '/v1/admin/cluster/status', summary: 'Multi-node signaling status: nodes, LB strategy, Redis/sticky flags', tags: ['scaling', 'admin'], auth: 'api-key' },
  { method: 'POST', path: '/v1/admin/cluster/tokens', summary: 'Issue a one-time Core/Node enrollment token (plaintext returned once)', tags: ['scaling', 'admin', 'cluster'], auth: 'api-key' },
  { method: 'GET', path: '/v1/admin/cluster/tokens', summary: 'List enrollment tokens (hashed at rest, no plaintext)', tags: ['scaling', 'admin', 'cluster'], auth: 'api-key' },
  { method: 'DELETE', path: '/v1/admin/cluster/tokens/:tokenId', summary: 'Revoke an enrollment token immediately', tags: ['scaling', 'admin', 'cluster'], auth: 'api-key' },
  { method: 'GET', path: '/v1/admin/nodes', summary: 'Node registry: role/features/capacity/status/heartbeat', tags: ['scaling', 'admin', 'cluster'], auth: 'api-key' },
  { method: 'PATCH', path: '/v1/admin/nodes/:nodeId', summary: 'Update node role/features/capacity/name/region', tags: ['scaling', 'admin', 'cluster'], auth: 'api-key' },
  { method: 'POST', path: '/v1/admin/nodes/:nodeId/disable', summary: 'Disable/enable a node (blocks heartbeat)', tags: ['scaling', 'admin', 'cluster'], auth: 'api-key' },
  { method: 'POST', path: '/v1/admin/nodes/:nodeId/drain', summary: 'Drain/undrain a node (status marker for the future scheduler)', tags: ['scaling', 'admin', 'cluster'], auth: 'api-key' },
  { method: 'DELETE', path: '/v1/admin/nodes/:nodeId', summary: 'Remove a node from the registry (frees its id)', tags: ['scaling', 'admin', 'cluster'], auth: 'api-key' },
  { method: 'POST', path: '/v1/cluster/join', summary: 'Standby Core joins with a one-time core token', tags: ['scaling', 'cluster'], auth: 'token' },
  { method: 'POST', path: '/v1/nodes/register', summary: 'Node registers with a one-time node token → per-node key once', tags: ['scaling', 'cluster'], auth: 'token' },
  { method: 'POST', path: '/v1/nodes/:nodeId/heartbeat', summary: 'Node liveness/capacity heartbeat (x-node-token: nk_…)', tags: ['scaling', 'cluster'], auth: 'node-key' },
  // Billing / quota metering (no payments, no card data)
  { method: 'GET', path: '/v1/admin/billing/usage', summary: 'Monthly usage: room minutes, rooms, participant joins, recordings, live minutes', tags: ['billing', 'admin'], auth: 'api-key' },
  { method: 'GET', path: '/v1/admin/billing/plan', summary: 'Billing plan, limits, overage policy and usage summary', tags: ['billing', 'admin'], auth: 'api-key' },
  { method: 'PATCH', path: '/v1/admin/billing/plan', summary: 'Update plan/quotas (catalog presets + explicit overrides), audited', tags: ['billing', 'admin'], auth: 'api-key' },
  // Roles
  { method: 'GET', path: '/v1/admin/roles', summary: 'Built-in + custom roles (RoleDefinition[] with assigned counters)', tags: ['roles', 'admin'], auth: 'api-key' },
  { method: 'POST', path: '/v1/admin/roles', summary: 'Create a company-defined custom role', tags: ['roles', 'admin'], auth: 'api-key' },
  { method: 'PUT', path: '/v1/admin/roles/:roleId', summary: 'Update a custom role (id immutable; built-ins via access-policy)', tags: ['roles', 'admin'], auth: 'api-key' },
  { method: 'DELETE', path: '/v1/admin/roles/:roleId', summary: 'Delete a custom role (live tokens fall back to baseRole)', tags: ['roles', 'admin'], auth: 'api-key' },
  // Dashboard assistant, prompts and guard
  { method: 'POST', path: '/v1/admin/assistant', summary: 'Dashboard assistant (LLM with role system prompts, local fallback)', tags: ['assistant', 'admin'], auth: 'api-key' },
  { method: 'GET', path: '/v1/admin/assistant/prompts', summary: 'Dashboard-assistant role metadata and starter questions', tags: ['assistant', 'admin'], auth: 'api-key' },
  { method: 'POST', path: '/v1/admin/guard/assess', summary: 'Risk assessment of a proposed change (findings, confirmation, recommendations)', tags: ['assistant', 'admin'], auth: 'api-key' },
  // Egress / RTMP / HLS (backend API; URLs/stream keys are redacted in MCP results)
  { method: 'POST', path: '/v1/rooms/:roomId/egress/start', summary: 'Start egress: recording / RTMP / HLS', tags: ['rooms', 'egress'], auth: 'api-key' },
  { method: 'POST', path: '/v1/rooms/:roomId/egress/stop', summary: 'Stop one or all egress sessions', tags: ['rooms', 'egress'], auth: 'api-key' },
  { method: 'GET', path: '/v1/rooms/:roomId/egress/list', summary: 'List room egress sessions (URLs redacted)', tags: ['rooms', 'egress'], auth: 'api-key' },
  { method: 'GET', path: '/v1/admin/egress/status', summary: 'Egress worker status', tags: ['egress', 'admin'], auth: 'api-key' },
  // SCIM 2.0 provisioning (contract §32; Bearer AGIL_SCIM_TOKEN + x-tenant-id)
  { method: 'GET/POST', path: '/scim/v2/Users', summary: 'List/create SCIM users (filter, startIndex, count)', tags: ['scim', 'admin'], auth: 'bearer' },
  { method: 'GET/PATCH/DELETE', path: '/scim/v2/Users/:id', summary: 'Read/patch/delete a SCIM user', tags: ['scim', 'admin'], auth: 'bearer' },
  { method: 'GET/POST', path: '/scim/v2/Groups', summary: 'List/create SCIM groups', tags: ['scim', 'admin'], auth: 'bearer' },
  { method: 'GET/PATCH/DELETE', path: '/scim/v2/Groups/:id', summary: 'Read/patch/delete a SCIM group', tags: ['scim', 'admin'], auth: 'bearer' },
  { method: 'GET', path: '/scim/v2/ServiceProviderConfig', summary: 'SCIM capabilities (patch/filter, maxResults)', tags: ['scim', 'admin'], auth: 'bearer' },
  // Room polls & Q&A
  { method: 'GET', path: '/v1/rooms/:roomId/polls', summary: 'List polls/Q&A with live results', tags: ['rooms', 'polls'], auth: 'api-key' },
  { method: 'POST', path: '/v1/rooms/:roomId/polls', summary: 'Create a poll/Q&A (host/moderator)', tags: ['rooms', 'polls'], auth: 'api-key' },
  { method: 'POST', path: '/v1/rooms/:roomId/polls/:pollId/vote', summary: 'Vote in a poll (participant, idempotent)', tags: ['rooms', 'polls'], auth: 'bearer' },
  { method: 'POST', path: '/v1/rooms/:roomId/polls/:pollId/close', summary: 'Close a poll (host/moderator)', tags: ['rooms', 'polls'], auth: 'api-key' },
  // Docs
  { method: 'GET', path: '/openapi.json', summary: 'OpenAPI 3.1 specification of the whole API', tags: ['openapi'], auth: 'none' },
  { method: 'GET', path: '/docs', summary: 'Self-contained API explorer (no CDN)', tags: ['openapi'], auth: 'none' },
];

export function groupedApiCatalog(): Array<{ tag: string; endpoints: ApiEndpointDoc[] }> {
  return API_TAGS.map((tag) => ({
    tag,
    endpoints: API_ENDPOINTS.filter((endpoint) => endpoint.tags.includes(tag)),
  })).filter((group) => group.endpoints.length > 0);
}

/** Markdown summary used by the offline fallback and by `agil_get_docs`. */
export function apiCatalogMarkdown(): string {
  const lines: string[] = ['# AgilFrame API endpoints (embedded catalog)', ''];
  for (const group of groupedApiCatalog()) {
    lines.push(`## ${group.tag}`);
    lines.push('');
    for (const endpoint of group.endpoints) {
      const auth = endpoint.auth === 'none' ? '' : ` _(${endpoint.auth})_`;
      lines.push(`- \`${endpoint.method} ${endpoint.path}\` — ${endpoint.summary}${auth}`);
    }
    lines.push('');
  }
  lines.push(
    'Live, machine-readable version: `GET /openapi.json` (OpenAPI 3.1); interactive explorer: `GET /docs`.',
  );
  return lines.join('\n');
}
