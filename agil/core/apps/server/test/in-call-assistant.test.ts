/** In-call assistant: local-only 501, external proxy, action filtering, fallbacks. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, type TestServer } from './helpers.js';
import { IN_CALL_SECURITY_RULES } from '../src/in-call-security-rules.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const HMAC_SECRET = 'assistant-hmac-secret';
let ts: TestServer;
let receiver: Server;
let receiverUrl: string;
const requests: Array<{ body: any; headers: Record<string, string | string[] | undefined> }> = [];
let receiverFails = false;
let receiverRequestId: string | undefined;
let createdRoom: { roomId: string; token: string; participantId: string };

function assistantReply(body: any): unknown {
  return {
    requestId: receiverRequestId ?? body.requestId,
    text: 'Нажмите на микрофон или откройте чат.',
    actions: [
      { tool: 'toggle_mic' },
      { tool: 'start_recording' },
      { tool: 'open_chat' },
      { tool: 'open_settings' },
    ],
    spotlight: [{ target: 'mic', text: 'Кнопка микрофона', step: 0 }, { target: 'settings', text: 'Настройки' }],
    provider: 'test-llm',
    model: 'llm-1',
    securityPolicy: { environment: 'production', version: 'ignored-provider-field' },
  };
}

before(async () => {
  process.env.AGIL_INTEGRATION_TEST_ASSISTANT_KEY = 'assistant-secret';
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body: any = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      requests.push({ body, headers: req.headers });
      if (receiverFails) {
        res.statusCode = 500;
        res.end('boom');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(assistantReply(body)));
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  ts = await startTestServer({ aiAgentHmacSecret: HMAC_SECRET });
});

after(async () => {
  delete process.env.AGIL_INTEGRATION_TEST_ASSISTANT_KEY;
  await ts.close();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

async function setupRoom(): Promise<{ roomId: string; token: string; participantId: string }> {
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Assistant room' } });
  const roomId = created.body.room.id;
  const issued = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Alisa', role: 'guest', participantId: 'p-assistant' } },
  });
  return { roomId, token: issued.body.token, participantId: 'p-assistant' };
}

async function setAgent(config: Record<string, unknown>): Promise<any> {
  return ts.api('PUT', '/v1/admin/in-call-agent', { headers: ADMIN, body: { config } });
}

test('in-call agent settings: admin only, defaults to local mode', async () => {
  const unauthorized = await ts.api('GET', '/v1/admin/in-call-agent');
  assert.equal(unauthorized.status, 401);
  const settings = await ts.api('GET', '/v1/admin/in-call-agent', { headers: ADMIN });
  assert.equal(settings.status, 200);
  assert.equal(settings.body.config.mode, 'local');
  assert.equal(settings.body.endpointConfigured, false);
  assert.equal(settings.body.apiKeyConfigured, false);

  const invalidEndpoint = await setAgent({ mode: 'external', endpoint: 'http://10.0.0.5/agent', apiKeyEnv: 'AGIL_INTEGRATION_TEST_ASSISTANT_KEY' });
  assert.equal(invalidEndpoint.status, 400);
  const invalidSecret = await setAgent({ mode: 'external', endpoint: `${receiverUrl}/assistant`, apiKeyEnv: 'bad name' });
  assert.equal(invalidSecret.status, 400);
});

test('mode local → 501 assistant_local_only; disabled tenant → 403', async () => {
  createdRoom = await setupRoom();
  const local = await ts.api('POST', `/v1/rooms/${createdRoom.roomId}/assistant`, {
    headers: { authorization: `Bearer ${createdRoom.token}` },
    body: { text: 'Как начать запись?' },
  });
  assert.equal(local.status, 501);
  assert.equal(local.body.error.code, 'assistant_local_only');

  await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { session: { inCallAgent: { enabled: false } } } });
  const disabled = await ts.api('POST', `/v1/rooms/${createdRoom.roomId}/assistant`, {
    headers: { authorization: `Bearer ${createdRoom.token}` },
    body: { text: 'привет' },
  });
  assert.equal(disabled.status, 403);
  await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { session: { inCallAgent: { enabled: true } } } });
});

test('external mode: signed request, permission-filtered actions, spotlight', async () => {
  const configured = await setAgent({
    enabled: true,
    mode: 'external',
    endpoint: `${receiverUrl}/assistant`,
    apiKeyEnv: 'AGIL_INTEGRATION_TEST_ASSISTANT_KEY',
    timeoutMs: 3000,
    spotlight: true,
    allowedTools: ['toggle_mic', 'start_recording', 'open_chat'],
    maxActionsPerReply: 2,
    systemPrompt: 'Ты помощник AgilFrame.',
    model: 'qa-model',
    compressContext: true,
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.equal(configured.body.endpointConfigured, true);

  const response = await ts.api('POST', `/v1/rooms/${createdRoom.roomId}/assistant`, {
    headers: { authorization: `Bearer ${createdRoom.token}` },
    body: { text: 'Помоги включить запись', locale: 'ru', state: { participants: 2, mic: 'on', recording: false } },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.source, 'external');
  assert.ok(response.body.id);
  assert.ok(response.body.actions.length <= 2);
  assert.ok(!response.body.actions.some((action: { tool: string }) => action.tool === 'start_recording'), 'guest cannot record');
  assert.ok(response.body.actions.some((action: { tool: string }) => action.tool === 'toggle_mic'));
  assert.equal(response.body.spotlight.length, 1);

  const call = requests.at(-1);
  assert.ok(call);
  assert.equal(call.body.roomId, createdRoom.roomId);
  assert.equal(call.body.participant.role, 'guest');
  assert.ok(Array.isArray(call.body.participant.permissions));
  assert.deepEqual(call.body.tools, ['toggle_mic', 'open_chat']);
  assert.equal(call.body.systemPrompt, `${IN_CALL_SECURITY_RULES}\n\nТы помощник AgilFrame.`);
  assert.equal(call.body.model, 'qa-model');
  assert.deepEqual(call.body.contextCompression, { enabled: true, preserveSystemPrompt: true });
  assert.equal(response.body.actions.some((action: { tool: string }) => action.tool === 'open_settings'), false);
  assert.equal(response.body.securityPolicy, undefined);
  assert.deepEqual(call.body.state, { participants: 2, mic: 'on', recording: false });
  const signature = String(call.headers['x-agil-signature'] ?? '');
  const expected = createHmac('sha256', HMAC_SECRET).update(JSON.stringify(call.body), 'utf8').digest('hex');
  assert.equal(signature, expected);

  const audit = await ts.api('GET', '/v1/admin/audit?type=admin.action&limit=100', { headers: ADMIN });
  assert.ok(audit.body.entries.some((entry: { details?: { kind?: string } }) => entry.details?.kind === 'assistant.usage'));
  assert.ok(!JSON.stringify(audit.body).includes('Помоги включить запись'), 'prompt text is not logged');
});

test('assistant authorization is scoped to the room in the join token', async () => {
  const adjacent = await setupRoom();
  const requestsBefore = requests.length;
  const denied = await ts.api('POST', `/v1/rooms/${adjacent.roomId}/assistant`, {
    headers: { authorization: `Bearer ${createdRoom.token}` },
    body: { text: 'QA room scope' },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'forbidden');
  assert.equal(requests.length, requestsBefore, 'requests outside the token room must stop before the provider');
});

test('assistant rejects a response for a different request', async () => {
  receiverRequestId = 'unrelated-request';
  try {
    const response = await ts.api('POST', `/v1/rooms/${createdRoom.roomId}/assistant`, {
      headers: { authorization: `Bearer ${createdRoom.token}` }, body: { text: 'Настройки' },
    });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'provider_failed');
  } finally {
    receiverRequestId = undefined;
  }
});

test('signed policy binds the endpoint and narrows tools without losing any instructions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agil-agent-policy-'));
  const file = join(directory, 'policy.json');
  const key = generateKeyPairSync('ed25519');
  const endpoint = `${receiverUrl}/assistant`;
  const instructions = `Правила организации. ${'Сохранять точный текст. '.repeat(200)}Конец правил.`;
  const payload = JSON.stringify({ tenantId: 'demo', endpoint, version: 'qa-v1', environment: 'test',
    expiresAt: new Date(Date.now() + 60000).toISOString(), allowedTools: ['open_chat'], instructions });
  const signature = sign(null, Buffer.from(payload), key.privateKey).toString('base64');
  const save = (value: string) => writeFile(file, JSON.stringify({ payload: value, signature }));
  await save(payload);
  const core = await startTestServer({ inCallPolicyPath: file,
    inCallPolicyPublicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
  try {
    const configured = await core.api('PUT', '/v1/admin/in-call-agent', { headers: ADMIN, body: { config: {
      mode: 'hybrid', endpoint, compressContext: true, allowedTools: ['toggle_mic', 'open_chat'],
    } } });
    assert.equal(configured.status, 200);
    const room = await core.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Policy QA' } });
    const ask = () => core.api('POST', `/v1/rooms/${room.body.room.id}/assistant`, {
      headers: { authorization: `Bearer ${room.body.token}` }, body: { text: 'Покажи чат' },
    });
    const response = await ask();
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.securityPolicy, { version: 'qa-v1', environment: 'test' });
    assert.deepEqual(response.body.actions, [{ tool: 'open_chat' }]);
    assert.deepEqual(requests.at(-1)?.body.tools, ['open_chat']);
    assert.equal(requests.at(-1)?.body.systemPrompt, `${IN_CALL_SECURITY_RULES}\n\n${instructions}`);

    receiverFails = true;
    const failed = await ask();
    assert.equal(failed.body.error.code, 'assistant_policy_unverified');
    receiverFails = false;

    await save(payload.replace('qa-v1', 'tampered'));
    const calls = requests.length;
    const denied = await ask();
    assert.equal(denied.status, 503);
    assert.equal(denied.body.error.code, 'assistant_policy_unverified');
    assert.equal(requests.length, calls);
  } finally {
    receiverFails = false;
    await core.close();
    await rm(file, { force: true });
    await rmdir(directory);
  }
});

test('external failure → 502 provider_failed; hybrid failure → 501 local fallback', async () => {
  receiverFails = true;
  const external = await ts.api('POST', `/v1/rooms/${createdRoom.roomId}/assistant`, {
    headers: { authorization: `Bearer ${createdRoom.token}` },
    body: { text: 'вопрос' },
  });
  assert.equal(external.status, 502);
  assert.equal(external.body.error.code, 'provider_failed');

  await setAgent({ mode: 'hybrid', endpoint: `${receiverUrl}/assistant`, apiKeyEnv: 'AGIL_INTEGRATION_TEST_ASSISTANT_KEY' });
  const hybrid = await ts.api('POST', `/v1/rooms/${createdRoom.roomId}/assistant`, {
    headers: { authorization: `Bearer ${createdRoom.token}` },
    body: { text: 'вопрос' },
  });
  assert.equal(hybrid.status, 501);
  assert.equal(hybrid.body.error.code, 'assistant_local_only');
  receiverFails = false;
});

test('assistant requests are rate-limited per participant', async () => {
  await setAgent({ mode: 'external', endpoint: `${receiverUrl}/assistant`, apiKeyEnv: 'AGIL_INTEGRATION_TEST_ASSISTANT_KEY' });
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await ts.api('POST', `/v1/rooms/${createdRoom.roomId}/assistant`, {
      headers: { authorization: `Bearer ${createdRoom.token}` },
      body: { text: `вопрос ${attempt}` },
    });
    statuses.push(response.status);
  }
  assert.ok(statuses.includes(429), `expected a 429, got ${statuses.join(',')}`);
  // Restore the default local mode for other suites.
  await setAgent({ mode: 'local', endpoint: '', apiKeyEnv: 'AGIL_INCALL_AGENT_KEY' });
});
