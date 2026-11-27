/**
 * End-to-end protocol tests: spawn the built stdio server (exactly like an MCP
 * client does) and exercise initialize / tools / resources / prompts through
 * line-delimited JSON-RPC 2.0.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { McpStdioClient, findClosedPort } from './stdio-client.js';

const REQUIRED_TOOLS = [
  // offline
  'agil_get_config_schema',
  'agil_validate_config',
  'agil_generate_theme',
  'agil_apply_theme_to_config',
  'agil_apply_theme',
  'agil_list_theme_presets',
  'agil_audit_accessibility',
  'agil_suggest_lowbandwidth_profile',
  'agil_get_embed_snippet',
  'agil_summarize_meeting',
  'agil_analyze_compliance',
  'agil_explain_access',
  'agil_explain_providers',
  'agil_get_assistant_tools',
  'agil_explain_spotlight',
  'agil_explain_feature',
  'agil_explain_scaling',
  'agil_explain_roles',
  'agil_get_docs',
  // online
  'agil_get_config',
  'agil_update_config',
  'agil_create_room',
  'agil_create_invite',
  'agil_create_token',
  'agil_list_rooms',
  'agil_get_room',
  'agil_get_transcript',
  'agil_get_analysis',
  'agil_run_analysis',
  'agil_post_room_chat',
  'agil_set_chat_mode',
  'agil_get_ai_agent',
  'agil_set_ai_agent',
  'agil_get_access_policy',
  'agil_set_access_policy',
  'agil_get_knowledge_agent',
  'agil_set_knowledge_agent',
  'agil_ask_knowledge_agent',
  'agil_get_webhooks',
  'agil_set_webhooks',
  'agil_test_webhook',
  'agil_get_providers',
  'agil_set_providers',
  'agil_test_provider',
  'agil_get_in_call_agent',
  'agil_set_in_call_agent',
  'agil_preview_in_call_command',
  'agil_get_scale',
  'agil_set_scale',
  'agil_get_cluster_status',
  'agil_list_roles',
  'agil_create_role',
  'agil_update_role',
  'agil_delete_role',
  'agil_assess_change',
  'agil_dashboard_assistant',
  'agil_list_assistant_prompts',
  'agil_list_polls',
  'agil_create_poll',
  'agil_vote_poll',
  'agil_close_poll',
  'scim_list_users',
  'scim_get_user',
  'scim_create_user',
  'scim_update_user',
  'scim_delete_user',
  'scim_list_groups',
  'scim_create_group',
  'scim_update_group',
  'scim_delete_group',
  'scim_service_provider_config',
  'egress_status',
  'egress_list',
  'egress_start_recording',
  'egress_start_rtmp',
  'egress_start_hls',
  'egress_stop',
  'billing_usage',
  'billing_status',
  'agil_get_openapi',
  'agil_get_api_endpoints',
  'agil_get_audit',
  'agil_get_security_overview',
  'agil_get_server_health',
] as const;

const REQUIRED_RESOURCES = [
  'agil://docs/theming',
  'agil://docs/api',
  'agil://config/schema',
  'agil://docs/security',
] as const;

const REQUIRED_PROMPTS = [
  'agil-brand-setup',
  'agil-embed-install',
  'agil-compliance-review',
  'dashboard-assistant',
  'config-guardian',
  'security-reviewer',
  'onboarding',
  'api-helper',
  'scaling-advisor',
  'roles-admin',
] as const;

const SEGMENTS = [
  {
    id: 's1',
    participantId: 'p1',
    participantName: 'Анна',
    text: 'Обсудим план запуска продукта на следующей неделе.',
    start: 0,
    end: 4,
    isFinal: true,
    ts: 1,
  },
  {
    id: 's2',
    participantId: 'p2',
    participantName: 'Иван',
    text: 'Решили запустить релиз в четверг, я подготовлю отчёт к среде.',
    start: 4,
    end: 9,
    isFinal: true,
    ts: 2,
  },
  {
    id: 's3',
    participantId: 'p1',
    participantName: 'Анна',
    text: 'Есть риск, что не успеем с тестированием, пароль от стенда пришлю позже.',
    start: 9,
    end: 13,
    isFinal: true,
    ts: 3,
  },
];

let client: McpStdioClient;

before(async () => {
  client = await McpStdioClient.start({ env: { AGIL_MCP_MODE: 'full', AGIL_MCP_TIMEOUT_MS: '3000' } });
});

after(async () => {
  await client?.stop();
});

test('initialize: reports the AgilFrame MCP server', () => {
  assert.equal(client.serverInfo.name, 'agil-calls-mcp');
  assert.equal(typeof client.serverInfo.version, 'string');
});

test('in-call MCP preview sends only the participant token and returns a proposal', async () => {
  const proposal = { text: 'Открыть чат?', actions: [{ tool: 'open_chat' }] };
  const received: Array<{ url?: string; method?: string; authorization?: string; apiKey?: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.authorization,
      apiKey: request.headers['x-api-key'] as string | undefined,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(proposal));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let preview: McpStdioClient | undefined;
  try {
    preview = await McpStdioClient.start({ env: {
      AGIL_SERVER_URL: `http://127.0.0.1:${address.port}`,
      AGIL_API_KEY: 'qa-unused-admin-key',
      AGIL_MCP_PARTICIPANT_TOKEN: 'qa-participant-token',
      AGIL_MCP_MODE: 'read',
    } });
    const result = await preview.callToolJson('agil_preview_in_call_command', { roomId: 'qa-room', text: 'Открой чат', locale: 'ru' });
    assert.deepEqual(result.value, {
      reply: proposal,
      executed: false,
    });
    assert.deepEqual(received, [{
      url: '/v1/rooms/qa-room/assistant',
      method: 'POST',
      authorization: 'Bearer qa-participant-token',
      apiKey: undefined,
      body: { text: 'Открой чат', locale: 'ru' },
    }]);
  } finally {
    await preview?.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('tools/list: exposes every contract tool with a valid input schema', async () => {
  const tools = await client.listTools();
  const names = tools.map((tool) => tool.name);
  for (const required of REQUIRED_TOOLS) {
    assert.ok(names.includes(required), `missing tool ${required}. Got: ${names.join(', ')}`);
  }
  assert.equal(names.length, REQUIRED_TOOLS.length);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const createRoom = byName.get('agil_create_room');
  assert.ok(createRoom?.inputSchema.properties?.mode, 'agil_create_room must accept mode');
  assert.ok(createRoom?.inputSchema.properties?.context, 'agil_create_room must accept context');
  assert.ok(createRoom?.inputSchema.properties?.allowedParticipantIds);
  assert.ok((byName.get('agil_get_room')?.description ?? '').includes('mode'));
  const createToken = byName.get('agil_create_token');
  assert.ok(createToken?.inputSchema.properties?.roleId, 'agil_create_token must accept roleId');
  assert.ok((byName.get('agil_get_access_policy')?.description ?? '').includes('customRoles'));
  for (const name of ['agil_get_providers', 'agil_set_providers', 'agil_test_provider', 'agil_explain_providers']) {
    assert.ok(byName.has(name), `missing providers tool ${name}`);
  }
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 20, `short description for ${tool.name}`);
    assert.equal(tool.inputSchema.type, 'object', `inputSchema.type for ${tool.name}`);
  }
});

test('tools/call agil_validate_config: valid and invalid configs', async () => {
  const valid = await client.callToolJson<{
    valid: boolean;
    errors: string[];
    warnings: string[];
    themeAudit: { errors: number; warnings: number };
  }>('agil_validate_config', { config: { theme: { colors: { primary: '#0b5fff' } } } });
  assert.equal(valid.result.isError, undefined);
  assert.equal(valid.value.valid, true);
  assert.deepEqual(valid.value.errors, []);
  assert.ok(Array.isArray(valid.value.warnings));

  const invalid = await client.callToolJson<{ valid: boolean; errors: string[] }>('agil_validate_config', {
    config: { theme: { colors: { primary: 'definitely-not-a-color' } } },
  });
  assert.equal(invalid.value.valid, false);
  assert.ok(invalid.value.errors.some((error) => error.includes('theme.colors.primary')));
});

test('tools/call agil_generate_theme: brand color produces theme + cssVars', async () => {
  const generated = await client.callToolJson<{
    theme: { colors: { primary: string } };
    cssVars: Record<string, string>;
    contrastIssues: unknown[];
    accessible: boolean;
  }>('agil_generate_theme', { brandColor: '#0b5fff', preset: 'corporate' });
  assert.equal(generated.result.isError, undefined);
  assert.equal(generated.value.theme.colors.primary, '#0b5fff');
  assert.ok(Object.keys(generated.value.cssVars).length > 30);
  assert.ok(Array.isArray(generated.value.contrastIssues));
});

test('tools/call agil_summarize_meeting: summary and verbatim excerpts', async () => {
  const summary = await client.callToolJson<{
    notes: { summary: string; excerpts: unknown[]; actionItems: unknown[]; source: string };
    markdown: string;
  }>('agil_summarize_meeting', { segments: SEGMENTS, locale: 'ru' });
  assert.equal(summary.result.isError, undefined);
  assert.ok(summary.value.notes.summary.length > 0);
  assert.ok(summary.value.notes.excerpts.length > 0);
  assert.equal(summary.value.notes.source, 'local');
  assert.ok(summary.value.markdown.includes('Excerpts'));
});

test('tools/call agil_analyze_compliance: catches a phrase rule', async () => {
  const analysis = await client.callToolJson<{
    summary: { total: number; bySeverity: Record<string, number> };
    findings: Array<{ excerpt: string; severity: string }>;
  }>('agil_analyze_compliance', {
    segments: SEGMENTS,
    rules: [
      {
        id: 'phrase.password',
        name: 'Password disclosure',
        type: 'phrase',
        pattern: 'пароль',
        severity: 'critical',
        action: 'flag',
        enabled: true,
      },
    ],
  });
  assert.equal(analysis.result.isError, undefined);
  assert.equal(analysis.value.summary.total, 1);
  assert.equal(analysis.value.findings[0]?.severity, 'critical');
  assert.ok(analysis.value.findings[0]?.excerpt.includes('пароль'));
});

test('tools/call agil_get_embed_snippet: SDK and iframe snippets', async () => {
  const embed = await client.callToolJson<{
    sdkHtml: string;
    iframeHtml: string;
    iframeUrl: string;
  }>('agil_get_embed_snippet', { room: 'team-sync', token: 'jwt-token', mode: 'sdk' });
  assert.equal(embed.result.isError, undefined);
  assert.ok(embed.value.sdkHtml.includes('AgilFrame.mount'));
  assert.ok(embed.value.iframeHtml.includes('/embed.html'));
  assert.ok(embed.value.iframeUrl.includes('room=team-sync'));
});

test('tools/call agil_explain_access: guest vs host permissions', async () => {
  const guest = await client.callToolJson<{ allowed: string[]; denied: string[]; source: string }>(
    'agil_explain_access',
    { role: 'guest' },
  );
  assert.equal(guest.result.isError, undefined);
  assert.ok(Array.isArray(guest.value.allowed));
  assert.ok(guest.value.denied.includes('recording'));
  assert.ok(['role-defaults', 'user-override', 'token', 'strict'].includes(guest.value.source));
});

test('tools/call agil_get_api_endpoints: works offline via the embedded catalog', async () => {
  const catalog = await client.callToolJson<{ source: string; endpoints: Array<{ path: string }> }>(
    'agil_get_api_endpoints',
    {},
  );
  assert.equal(catalog.result.isError, undefined);
  assert.ok(['embedded', 'live'].includes(catalog.value.source));
  assert.ok(catalog.value.endpoints.length > 10);
});

test('tools/call agil_explain_providers: explains the six builtin slots', async () => {
  const result = await client.callTool('agil_explain_providers', {});
  assert.equal(result.isError, undefined);
  const text = result.content[0]?.text ?? '';
  assert.ok(text.includes('builtin'));
  assert.ok(text.includes('agil/core/docs/extensibility.md'));
  for (const slot of ['chat', 'files', 'stt', 'notifications', 'recording', 'backgrounds']) {
    assert.ok(text.includes(slot), `missing slot ${slot}`);
  }
  const stt = await client.callTool('agil_explain_providers', { slot: 'stt' });
  assert.ok((stt.content[0]?.text ?? '').includes('Speech-to-text'));
});

test('tools/call agil_get_assistant_tools: tools, features/roles and spotlight targets', async () => {
  const listed = await client.callToolJson<{
    count: number;
    tools: Array<{ tool: string; requiredFeature: string | null; requiredRoles: string[] | null; spotlightTarget: string | null }>;
    spotlightTargets: string[];
  }>('agil_get_assistant_tools', {});
  assert.equal(listed.result.isError, undefined);
  assert.equal(listed.value.count, 18);
  const recording = listed.value.tools.find((tool) => tool.tool === 'start_recording');
  assert.equal(recording?.requiredFeature, 'recording');
  assert.deepEqual(recording?.requiredRoles, ['host', 'moderator']);
  assert.equal(listed.value.spotlightTargets.length, 14);

  const guest = await client.callToolJson<{ denied: Array<{ tool: string }>; allowed: string[] }>(
    'agil_get_assistant_tools',
    { role: 'guest' },
  );
  assert.ok(guest.value.denied.some((entry) => entry.tool === 'start_recording'));
  assert.ok(guest.value.allowed.includes('toggle_mic'));
});

test('tools/call agil_explain_spotlight / agil_explain_feature: markdown guides', async () => {
  const spotlight = await client.callTool('agil_explain_spotlight', {});
  assert.equal(spotlight.isError, undefined);
  const spotlightText = spotlight.content[0]?.text ?? '';
  assert.ok(spotlightText.includes('spotlight'));
  assert.ok(spotlightText.includes('recording'));
  assert.ok(spotlightText.includes('agil/core/docs/in-call-agent.md'));

  const feature = await client.callTool('agil_explain_feature', { feature: 'recording' });
  assert.equal(feature.isError, undefined);
  const featureText = feature.content[0]?.text ?? '';
  assert.ok(featureText.includes('Spotlight'));
  assert.ok(featureText.includes('start_recording'));
});

test('tools/call agil_explain_scaling: offline scaling guide', async () => {
  const result = await client.callTool('agil_explain_scaling', {});
  assert.equal(result.isError, undefined);
  const text = result.content[0]?.text ?? '';
  assert.ok(text.includes('agil/core/docs/scaling.md'));
  assert.ok(text.includes('mesh'));
  assert.ok(text.includes('sfu'));
  assert.ok(text.includes('broadcast'));
  assert.ok(text.includes('TURN'));
  assert.ok(text.includes('Redis'));
  assert.ok(text.includes('webinar'));
  assert.ok(text.includes('agil_set_scale'));
});

test('tools/call agil_explain_roles: offline roles guide', async () => {
  const result = await client.callTool('agil_explain_roles', {});
  assert.equal(result.isError, undefined);
  const text = result.content[0]?.text ?? '';
  assert.ok(text.includes('agil/core/docs/api-guide.md'));
  assert.ok(text.includes('host'));
  assert.ok(text.includes('moderator'));
  assert.ok(text.includes('guest'));
  assert.ok(text.includes('roleId'));
  assert.ok(text.includes('streamer'));
  assert.ok(text.includes('customRoles'));
});

test('prompts/list shows the 7 assistant role prompts; prompts/get delegates to Core', async () => {
  const listed = await client.request<{ prompts: Array<{ name: string }> }>('prompts/list', {});
  const names = listed.prompts.map((prompt) => prompt.name);
  for (const rolePrompt of [
    'dashboard-assistant',
    'config-guardian',
    'security-reviewer',
    'onboarding',
    'api-helper',
    'scaling-advisor',
    'roles-admin',
  ]) {
    assert.ok(names.includes(rolePrompt), `missing prompt ${rolePrompt}`);
  }
  assert.equal(names.length, REQUIRED_PROMPTS.length);

  const guardian = await client.request<{ messages: Array<{ content: { text: string } }> }>('prompts/get', {
    name: 'config-guardian',
    arguments: { request: 'выключить запись звонков' },
  });
  const text = guardian.messages[0]?.content.text ?? '';
  assert.match(text, /agil_dashboard_assistant.*config-guardian/);
  assert.doesNotMatch(text, /Роль: страж критических изменений/);
  assert.ok(text.includes('выключить запись звонков'));
});

test('assistant catalogue projects metadata from a legacy Core response', async () => {
  const role = { role: 'assistant', title: 'Assistant', description: 'Admin help', starters: ['Start here'] };
  const server = createServer((request, response) => {
    if (request.url !== '/v1/admin/assistant/prompts') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ prompts: [{ ...role, systemPrompt: 'Legacy internal instructions', internal: true }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let catalogue: McpStdioClient | undefined;
  try {
    catalogue = await McpStdioClient.start({ env: {
      AGIL_SERVER_URL: `http://127.0.0.1:${address.port}`, AGIL_API_KEY: 'qa-catalogue-key', AGIL_MCP_MODE: 'read',
    } });
    const result = await catalogue.callToolJson('agil_list_assistant_prompts', {});
    assert.deepEqual(result.value, { source: 'server', fallback: false, count: 1, prompts: [role] });
  } finally {
    await catalogue?.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('tools/call unknown tool: friendly isError result', async () => {
  const result = await client.callTool('agil_does_not_exist', {});
  assert.equal(result.isError, true);
  assert.ok(result.content[0]?.text?.includes('Available tools'));
});

test('resources/list and resources/read serve contract resources', async () => {
  const listed = await client.request<{
    resources: Array<{ uri: string; mimeType?: string; description?: string }>;
  }>('resources/list', {});
  const uris = listed.resources.map((resource) => resource.uri);
  for (const required of REQUIRED_RESOURCES) {
    assert.ok(uris.includes(required), `missing resource ${required}`);
  }
  const schema = await client.request<{ contents: Array<{ uri: string; text: string; mimeType: string }> }>(
    'resources/read',
    { uri: 'agil://config/schema' },
  );
  assert.equal(schema.contents[0]?.mimeType, 'application/json');
  const parsed = JSON.parse(schema.contents[0]?.text ?? '{}') as { properties?: Record<string, unknown> };
  assert.ok(parsed.properties?.theme);
  assert.ok(parsed.properties?.integrations);

  const theming = await client.request<{ contents: Array<{ text: string }> }>('resources/read', {
    uri: 'agil://docs/theming',
  });
  assert.ok(theming.contents[0]?.text.includes('--agil-color-primary'));
  assert.ok(uris.includes('agil://docs/mcp'));
  const guide = await client.request<{ contents: Array<{ mimeType: string; text: string }> }>('resources/read', {
    uri: 'agil://docs/mcp',
  });
  assert.equal(guide.contents[0]?.mimeType, 'text/markdown');
  assert.ok(guide.contents[0]?.text.includes('AGIL_MCP_MODE'));
});

test('prompts/list and prompts/get return actionable prompts', async () => {
  const listed = await client.request<{ prompts: Array<{ name: string; arguments?: unknown[] }> }>('prompts/list', {});
  const names = listed.prompts.map((prompt) => prompt.name);
  for (const required of REQUIRED_PROMPTS) {
    assert.ok(names.includes(required), `missing prompt ${required}`);
  }
  const brand = await client.request<{ messages: Array<{ role: string; content: { type: string; text: string } }> }>(
    'prompts/get',
    { name: 'agil-brand-setup', arguments: { companyName: 'Acme', brandColor: '#0b5fff' } },
  );
  const text = brand.messages[0]?.content.text ?? '';
  assert.ok(text.includes('agil_generate_theme'));
  assert.ok(text.includes('Acme'));
  assert.ok(text.includes('agil_validate_config'));
});

test('offline tools keep working while online tools fail with a clear error', async () => {
  const closedPort = await findClosedPort();
  const offlineClient = await McpStdioClient.start({
    env: {
      AGIL_SERVER_URL: `http://127.0.0.1:${closedPort}`,
      AGIL_MCP_TIMEOUT_MS: '2000',
    },
  });
  try {
    const online = await offlineClient.callTool('agil_get_config', {});
    assert.equal(online.isError, true);
    const text = online.content[0]?.text ?? '';
    assert.ok(text.includes('AGIL_SERVER_URL'), text);
    assert.ok(text.includes('not reachable'), text);
    // the API key must never appear in error messages
    assert.ok(!text.includes('dev-key'), text);

    const offline = await offlineClient.callToolJson<{ valid: boolean }>('agil_validate_config', {
      config: { branding: { productName: 'Acme' } },
    });
    assert.equal(offline.result.isError, undefined);
    assert.equal(offline.value.valid, true);

    // the embedded catalog fallback works without a server, too
    const catalog = await offlineClient.callToolJson<{ source: string }>('agil_get_api_endpoints', {});
    assert.equal(catalog.value.source, 'embedded');

    const openapi = await offlineClient.callTool('agil_get_openapi', {});
    assert.equal(openapi.isError, true);

    // §22 tools are online-only too
    const chatPost = await offlineClient.callTool('agil_post_room_chat', { roomId: 'r1', text: 'hi' });
    assert.equal(chatPost.isError, true);
    const chatMode = await offlineClient.callTool('agil_set_chat_mode', { sessionChat: { ui: 'external' } });
    assert.equal(chatMode.isError, true);
    assert.ok((chatMode.content[0]?.text ?? '').includes('AGIL_SERVER_URL'));

    // §23 provider tools are online-only
    assert.equal((await offlineClient.callTool('agil_get_providers', {})).isError, true);
    assert.equal(
      (await offlineClient.callTool('agil_set_providers', { providers: { chat: { mode: 'external' } } })).isError,
      true,
    );
    assert.equal((await offlineClient.callTool('agil_test_provider', { slot: 'chat' })).isError, true);

    // In-call assistant admin tools are online-only
    assert.equal((await offlineClient.callTool('agil_get_in_call_agent', {})).isError, true);
    assert.equal(
      (await offlineClient.callTool('agil_set_in_call_agent', { config: { mode: 'local' } })).isError,
      true,
    );

    // Scaling admin tools are online-only
    assert.equal((await offlineClient.callTool('agil_get_scale', {})).isError, true);
    assert.equal((await offlineClient.callTool('agil_set_scale', { scale: { mediaMode: 'sfu' } })).isError, true);
    assert.equal((await offlineClient.callTool('agil_get_cluster_status', {})).isError, true);

    // Dashboard assistant/guard: local fallbacks keep working without a server
    const assessment = await offlineClient.callToolJson<{
      risk: string;
      requiresConfirmation: boolean;
      findings: unknown[];
      recommendations: string[];
      source: string;
      fallback?: boolean;
    }>('agil_assess_change', {
      kind: 'config',
      next: { features: { recording: false } },
      intent: 'выключить запись звонков',
    });
    assert.equal(assessment.result.isError, undefined);
    assert.ok(typeof assessment.value.risk === 'string');
    assert.ok(Array.isArray(assessment.value.findings));
    assert.equal(assessment.value.source, 'local');
    assert.equal(assessment.value.fallback, true);

    const assistant = await offlineClient.callToolJson<{ reply: string; role: string; model: string; fallback: boolean; source: string }>(
      'agil_dashboard_assistant',
      { messages: [{ role: 'user', content: 'как выключить запись?' }], role: 'config-guardian' },
    );
    assert.equal(assistant.result.isError, undefined);
    assert.ok(assistant.value.reply.length > 0);
    assert.equal(assistant.value.role, 'config-guardian');
    assert.equal(assistant.value.fallback, true);
    assert.equal(assistant.value.source, 'local');

    const promptList = await offlineClient.callToolJson<{ source: string; count: number; prompts: Array<{ role: string; starters: string[] }> }>(
      'agil_list_assistant_prompts',
      {},
    );
    assert.equal(promptList.result.isError, undefined);
    assert.equal(promptList.value.source, 'local');
    assert.equal(promptList.value.count, 7);
    assert.ok(promptList.value.prompts.every((prompt) => prompt.starters.length > 0 && !('systemPrompt' in prompt)));

    // Polls: list needs the server, write tools validate dry-run locally
    assert.equal((await offlineClient.callTool('agil_list_polls', { roomId: 'room-1' })).isError, true);
    const pollDry = await offlineClient.callToolJson<{ dryRun: boolean; payload: { options: unknown[]; kind: string } }>('agil_create_poll', {
      roomId: 'room-1',
      question: 'Какой вариант выбрать?',
      options: ['Да', 'Нет'],
      kind: 'poll',
      dryRun: true,
    });
    assert.equal(pollDry.result.isError, undefined);
    assert.equal(pollDry.value.dryRun, true);
    assert.equal(pollDry.value.payload.options.length, 2);
    const voteDry = await offlineClient.callToolJson<{ dryRun: boolean; payload: { optionIds: string[] } }>('agil_vote_poll', {
      roomId: 'room-1',
      pollId: 'poll-1',
      optionIds: ['opt-1'],
      dryRun: true,
    });
    assert.equal(voteDry.result.isError, undefined);
    assert.deepEqual(voteDry.value.payload.optionIds, ['opt-1']);
    const badPoll = await offlineClient.callTool('agil_create_poll', { roomId: 'room-1', question: 'Вопрос?', options: ['Единственный'] });
    assert.equal(badPoll.isError, true);
    const badPollText = badPoll.content.find((block) => block.type === 'text')?.text ?? '';
    assert.match(badPollText, /Invalid arguments|options|at least 2/i);

    // Roles admin tools are online-only
    assert.equal((await offlineClient.callTool('agil_list_roles', {})).isError, true);
    const roleCreate = await offlineClient.callTool('agil_create_role', {
      role: { id: 'streamer', name: 'Стример', baseRole: 'host', features: ['chat'] },
    });
    assert.equal(roleCreate.isError, true);
    assert.ok((roleCreate.content[0]?.text ?? '').includes('AGIL_SERVER_URL'));
  } finally {
    await offlineClient.stop();
  }
});
