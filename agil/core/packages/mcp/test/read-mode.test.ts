/**
 * Read-only exposure mode over stdio (docs/api-exposure.md):
 * AGIL_MCP_MODE=read keeps the stdio transport but registers only
 * read/design tools, and write calls fail with an explanatory isError result.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { McpStdioClient } from './stdio-client.js';

const WRITE_TOOLS = [
  'agil_update_config',
  'agil_create_room',
  'agil_create_invite',
  'agil_create_token',
  'agil_post_room_chat',
  'agil_set_chat_mode',
  'agil_set_ai_agent',
  'agil_set_access_policy',
  'agil_set_knowledge_agent',
  'agil_set_webhooks',
  'agil_set_providers',
  'agil_test_webhook',
  'agil_test_provider',
  'agil_run_analysis',
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
];

let client: McpStdioClient;

before(async () => {
  client = await McpStdioClient.start({
    env: { AGIL_MCP_MODE: 'read', AGIL_MCP_TIMEOUT_MS: '2000' },
  });
});

after(async () => {
  await client?.stop();
});

test('read mode (stdio): tools/list has no write tools but keeps read/design tools', async () => {
  const tools = await client.listTools();
  const names = tools.map((tool) => tool.name);
  for (const writeTool of WRITE_TOOLS) {
    assert.ok(!names.includes(writeTool), `${writeTool} must not be exposed in read mode`);
  }
  for (const readTool of [
    'agil_validate_config',
    'agil_generate_theme',
    'agil_get_config_schema',
    'agil_explain_access',
    'agil_explain_providers',
    'agil_get_config',
    'agil_get_providers',
    'agil_get_assistant_tools',
    'agil_explain_spotlight',
    'agil_explain_feature',
    'agil_explain_scaling',
    'agil_explain_roles',
    'agil_list_roles',
    'agil_assess_change',
    'agil_dashboard_assistant',
    'agil_list_assistant_prompts',
    'agil_list_polls',
    'scim_list_users',
    'scim_get_user',
    'scim_list_groups',
    'scim_service_provider_config',
    'egress_status',
    'egress_list',
    'billing_usage',
    'billing_status',
    'agil_ask_knowledge_agent',
  ]) {
    assert.ok(names.includes(readTool), `${readTool} must be available in read mode`);
  }
  assert.equal(names.length, 84 - WRITE_TOOLS.length);
});

test('read mode (stdio): offline read/design tools still work', async () => {
  const generated = await client.callToolJson<{ theme: { colors: { primary: string } } }>('agil_generate_theme', {
    brandColor: '#0b5fff',
  });
  assert.equal(generated.result.isError, undefined);
  assert.equal(generated.value.theme.colors.primary, '#0b5fff');
});

test('read mode (stdio): calling a write tool returns a clear isError', async () => {
  const result = await client.callTool('agil_update_config', { patch: { branding: { productName: 'Acme' } } });
  assert.equal(result.isError, true);
  const text = result.content[0]?.text ?? '';
  assert.ok(text.includes('write tool'));
  assert.ok(text.includes('disabled in read-only mode'));
  assert.ok(text.includes('AGIL_MCP_MODE=read'));
});
