/** Dashboard mascot assistant (DeepSeek + local fallback) and change guard API. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './helpers.js';
import { buildSystemPrompt } from '../src/dashboard.js';

const ADMIN = { 'x-api-key': 'dev-key' };
let ts: TestServer;

before(async () => {
  ts = await startTestServer();
});

after(async () => {
  await ts.close();
});

test('GET /v1/admin/assistant/prompts lists dashboard roles', async () => {
  assert.equal((await ts.api('GET', '/v1/admin/assistant/prompts')).status, 401);
  const response = await ts.api('GET', '/v1/admin/assistant/prompts', { headers: ADMIN });
  assert.equal(response.status, 200);
  const roles = response.body.prompts.map((prompt: { role: string }) => prompt.role);
  assert.deepEqual(roles, [
    'assistant',
    'config-guardian',
    'security-reviewer',
    'onboarding',
    'api-helper',
    'scaling-advisor',
    'roles-admin',
  ]);
  for (const prompt of response.body.prompts) {
    assert.ok(prompt.title.length > 0);
    assert.ok(prompt.description.length > 0);
    assert.ok(Array.isArray(prompt.starters) && prompt.starters.length > 0);
    assert.equal('systemPrompt' in prompt, false);
  }
  assert.match(buildSystemPrompt({ role: 'config-guardian', messages: [] }), /Роль: страж критических изменений/);
});

test('POST /v1/admin/assistant falls back locally without a key and never leaks secrets', async () => {
  const response = await ts.api('POST', '/v1/admin/assistant', {
    headers: ADMIN,
    body: {
      messages: [{ role: 'user', content: 'Как выключить запись в комнате?' }],
      role: 'config-guardian',
      context: { screen: 'settings', tenantId: 'demo' },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.fallback, true);
  assert.equal(response.body.model, 'local-rules');
  assert.equal(response.body.role, 'config-guardian');
  assert.ok(typeof response.body.reply === 'string' && response.body.reply.length > 0);
  assert.ok(Array.isArray(response.body.suggestions) && response.body.suggestions.length > 0);
  assert.ok(!JSON.stringify(response.body).includes('AGIL_DEEPSEEK'));

  const audit = await ts.api('GET', '/v1/admin/audit?limit=20', { headers: ADMIN });
  const used = audit.body.entries.find((entry: { details?: { kind?: string } }) => entry.details?.kind === 'admin.assistant.used');
  assert.ok(used);
  assert.equal(used.details.role, 'config-guardian');
  assert.equal(used.details.fallback, true);
  assert.ok(used.details.messageLength > 0);
  assert.ok(!JSON.stringify(used).includes('Как выключить запись'), 'prompt text is not stored in audit');
});

test('POST /v1/admin/assistant: provider failure → local fallback, HTTP 200', async () => {
  const broken = await startTestServer({
    deepseekApiKey: 'test-key-do-not-print',
    deepseekBaseUrl: 'http://127.0.0.1:1',
    deepseekTimeoutMs: 1000,
  });
  try {
    const response = await broken.api('POST', '/v1/admin/assistant', {
      headers: ADMIN,
      body: { messages: [{ role: 'user', content: 'Привет' }] },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.fallback, true);
    assert.ok(!JSON.stringify(response.body).includes('test-key-do-not-print'));
  } finally {
    await broken.close();
  }
});

test('POST /v1/admin/guard/assess: config change risk + audit', async () => {
  const response = await ts.api('POST', '/v1/admin/guard/assess', {
    headers: ADMIN,
    body: { kind: 'config', next: { features: { recording: false }, security: { waitingRoom: true } }, intent: 'выключить запись' },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(['low', 'medium', 'high', 'critical'].includes(response.body.risk));
  assert.equal(typeof response.body.requiresConfirmation, 'boolean');
  assert.ok(Array.isArray(response.body.findings));
  assert.ok(response.body.message.length > 0);
  assert.ok(Array.isArray(response.body.recommendations));

  const audit = await ts.api('GET', '/v1/admin/audit?limit=20', { headers: ADMIN });
  const assessed = audit.body.entries.find((entry: { details?: { kind?: string } }) => entry.details?.kind === 'admin.guard.assessed');
  assert.ok(assessed);
  assert.equal(assessed.details.changeKind, 'config');
});

test('POST /v1/admin/guard/assess: English preserves findings, severity and confirmation', async () => {
  const change = { kind: 'config', next: { security: { accessPolicy: { mode: 'strict' } } } };
  const russian = await ts.api('POST', '/v1/admin/guard/assess', { headers: ADMIN, body: change });
  const english = await ts.api('POST', '/v1/admin/guard/assess', { headers: ADMIN, body: { ...change, locale: 'en' } });
  assert.equal(russian.status, 200);
  assert.equal(english.status, 200);
  assert.match(russian.body.summary, /Обнаружено/);
  assert.match(english.body.summary, /Findings: 1/);
  assert.match(english.body.message, /Affected: all roles, participants/);
  assert.match(english.body.findings[0].impact, /Active rooms: \d+/);
  assert.equal(english.body.risk, russian.body.risk);
  assert.equal(english.body.requiresConfirmation, true);
  assert.equal(english.body.requiresConfirmation, russian.body.requiresConfirmation);
  assert.equal(english.body.findings[0].id, russian.body.findings[0].id);
  assert.equal(english.body.findings[0].severity, russian.body.findings[0].severity);
  assert.doesNotMatch(JSON.stringify(english.body), /\p{Script=Cyrillic}/u);

  const invalid = await ts.api('POST', '/v1/admin/guard/assess', { headers: ADMIN, body: { ...change, locale: 'fr' } });
  assert.equal(invalid.status, 400);
});

test('POST /v1/admin/guard/assess: roles (custom role removal → critical), access and validation', async () => {
  const created = await ts.api('POST', '/v1/admin/roles', {
    headers: ADMIN,
    body: { id: 'guard-role', name: 'Guard role', baseRole: 'guest', features: ['chat'], canModerate: false },
  });
  assert.equal(created.status, 200);

  const currentRoles = await ts.api('GET', '/v1/admin/roles', { headers: ADMIN });
  const withoutRole = currentRoles.body.roles.filter((role: { id: string }) => role.id !== 'guard-role');
  const rolesAssessment = await ts.api('POST', '/v1/admin/guard/assess', {
    headers: ADMIN,
    body: { kind: 'roles', next: { roles: withoutRole }, intent: 'удалить роль' },
  });
  assert.equal(rolesAssessment.status, 200);
  assert.equal(rolesAssessment.body.risk, 'critical');
  assert.equal(rolesAssessment.body.requiresConfirmation, true);
  assert.ok(rolesAssessment.body.findings.some((finding: { severity: string }) => finding.severity === 'critical'));

  const accessAssessment = await ts.api('POST', '/v1/admin/guard/assess', {
    headers: ADMIN,
    body: { kind: 'access', next: { policy: { deniedFeatures: ['recording'] } } },
  });
  assert.equal(accessAssessment.status, 200);
  assert.ok(Array.isArray(accessAssessment.body.findings));

  const invalid = await ts.api('POST', '/v1/admin/guard/assess', {
    headers: ADMIN,
    body: { kind: 'config', next: { security: { geo: { enabled: 'not-a-boolean' } } } },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'validation_failed');

  const unknownKind = await ts.api('POST', '/v1/admin/guard/assess', {
    headers: ADMIN,
    body: { kind: 'nope', next: {} },
  });
  assert.equal(unknownKind.status, 400);
});


test('assistant memory: put into the system prompt (≤2000 chars), chatId in audit, no memory text stored', async () => {
  const request = {
    messages: [{ role: 'user' as const, content: 'Что мы обсуждали про запись?' }],
    role: 'assistant' as const,
    context: {
      screen: 'settings',
      tenantId: 'demo',
      memory: 'Админ ранее просил включить запись только для вебинаров.',
      chatId: 'chat-qa-42',
    },
  };
  const prompt = buildSystemPrompt(request);
  assert.ok(prompt.includes('Память предыдущих бесед администратора'));
  assert.ok(prompt.includes('только для вебинаров'));
  assert.equal(prompt.includes('Память предыдущих бесед'), true);

  const longMemory = buildSystemPrompt({
    messages: [],
    context: { memory: 'x'.repeat(5000) },
  });
  const memoryBlock = longMemory.split('Память предыдущих бесед администратора')[1] ?? '';
  assert.ok(memoryBlock.length <= 2100, `memory block is capped: ${memoryBlock.length}`);
  assert.ok(!buildSystemPrompt({ messages: [] }).includes('Память предыдущих бесед'), 'no memory block without memory');

  const response = await ts.api('POST', '/v1/admin/assistant', { headers: ADMIN, body: request });
  assert.equal(response.status, 200);
  assert.equal(response.body.fallback, true);
  const audit = await ts.api('GET', '/v1/admin/audit?limit=20', { headers: ADMIN });
  const used = audit.body.entries.find(
    (entry: { details?: { kind?: string; chatId?: string } }) => entry.details?.kind === 'admin.assistant.used' && entry.details.chatId === 'chat-qa-42',
  );
  assert.ok(used, 'audit records chatId');
  assert.ok(!JSON.stringify(audit.body).includes('только для вебинаров'), 'memory text is not stored in audit');
});
