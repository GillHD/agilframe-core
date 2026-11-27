/** Replaceable capability providers (§23) + virtual-background library. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { delay, relativeUrl, startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const RECEIVER_SECRET = 'provider-hmac-secret';
let ts: TestServer;
let receiver: Server;
let receiverUrl: string;
const calls: Array<{ body: any; headers: Record<string, string | string[] | undefined> }> = [];
let chatExternalFails = false;
let notificationsFail = true;

function envelope(action: string, capability: string, payload: any): unknown {
  if (capability === 'chat' && action === 'post') {
    if (chatExternalFails) return { ok: false };
    return { ok: true, data: { message: { id: 'ext-chat-1', text: `external: ${payload.text}`, from: { id: 'corp', name: 'Corp Messenger', role: 'guest' } } } };
  }
  if (capability === 'chat' && action === 'history') return { ok: true, data: { messages: [] } };
  if (capability === 'files' && action === 'put') {
    return {
      ok: true,
      data: {
        file: {
          id: 'ext-file-1',
          tenantId: 'demo',
          roomId: payload.roomId ?? '',
          name: payload.name,
          size: payload.size,
          mime: payload.mime,
          url: `${receiverUrl}/provider/files/ext-file-1?sig=s3&exp=9999999999999`,
          createdAt: Date.now(),
          expiresAt: Date.now() + 3600_000,
          uploadedBy: payload.uploadedBy,
        },
      },
    };
  }
  if (capability === 'files' && action === 'get') {
    return {
      ok: true,
      data: {
        file: {
          id: payload.id,
          tenantId: 'demo',
          roomId: '',
          name: 's3.txt',
          size: 14,
          mime: 'text/plain',
          url: `${receiverUrl}/provider/files/${payload.id}`,
          createdAt: Date.now(),
          expiresAt: Date.now() + 3600_000,
          uploadedBy: 'u1',
        },
        dataBase64: Buffer.from('external-data!').toString('base64'),
      },
    };
  }
  if (capability === 'files' && action === 'list') return { ok: true, data: { files: [] } };
  if (capability === 'stt' && action === 'transcribe') return { ok: true, data: { text: 'привет из облака' } };
  if (capability === 'backgrounds' && action === 'list') {
    return { ok: true, data: { backgrounds: [{ id: 'corp-1', name: 'Офис компании', url: 'https://cdn.example.com/office.jpg' }] } };
  }
  if (capability === 'notifications' && action === 'send') {
    return notificationsFail ? { ok: false } : { ok: true, data: { sent: true } };
  }
  return { ok: true, data: {} };
}

async function startReceiver(): Promise<void> {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.url === '/webhook') {
        res.statusCode = 200;
        res.end('ok');
        return;
      }
      let parsed: any = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      calls.push({ body: parsed, headers: req.headers });
      const envelopeResponse = envelope(parsed.action, parsed.capability, parsed.payload ?? {});
      if (!chatExternalFails && parsed.capability !== 'notifications') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(envelopeResponse));
        return;
      }
      res.statusCode = 500;
      res.end('boom');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
}

async function setProvider(slot: string, value: Record<string, unknown>): Promise<any> {
  return ts.api('PUT', '/v1/admin/providers', { headers: ADMIN, body: { providers: { [slot]: value } } });
}

function providerConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'external',
    providerName: 'company',
    endpoint: `${receiverUrl}/provider`,
    apiKeyEnv: 'AGIL_INTEGRATION_TEST_PROVIDER_KEY',
    timeoutMs: 2000,
    fallback: 'builtin',
    options: {},
    ...overrides,
  };
}

before(async () => {
  process.env.AGIL_INTEGRATION_TEST_PROVIDER_KEY = RECEIVER_SECRET;
  process.env.AGIL_WEBHOOK_TEST_SECRET = RECEIVER_SECRET;
  await startReceiver();
  ts = await startTestServer();
});

after(async () => {
  delete process.env.AGIL_INTEGRATION_TEST_PROVIDER_KEY;
  delete process.env.AGIL_WEBHOOK_TEST_SECRET;
  await ts.close();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

test('providers status: builtin by default, available, no key required for backgrounds', async () => {
  const unauthorized = await ts.api('GET', '/v1/admin/providers');
  assert.equal(unauthorized.status, 401);

  const status = await ts.api('GET', '/v1/admin/providers', { headers: ADMIN });
  assert.equal(status.status, 200);
  assert.equal(status.body.providers.length, 6);
  const chat = status.body.providers.find((slot: { slot: string }) => slot.slot === 'chat');
  assert.equal(chat.mode, 'builtin');
  assert.equal(chat.available, true);
  assert.equal(chat.fallback, 'builtin');

  const backgrounds = await ts.api('GET', '/v1/tenants/demo/backgrounds');
  assert.equal(backgrounds.status, 200);
  assert.equal(backgrounds.body.provider, 'builtin');
  assert.ok(backgrounds.body.backgrounds.length >= 1);
  assert.ok(backgrounds.body.backgrounds.every((item: { id: string; name: string }) => item.id && item.name));
});

test('PUT providers validates URL/secret and requires an endpoint for external mode', async () => {
  const missingEndpoint = await setProvider('chat', { mode: 'external', endpoint: '', apiKeyEnv: 'AGIL_INTEGRATION_TEST_PROVIDER_KEY' });
  assert.equal(missingEndpoint.status, 400);

  const privateEndpoint = await setProvider('chat', providerConfig({ endpoint: 'http://10.0.0.5/provider' }));
  assert.equal(privateEndpoint.status, 400);
  assert.equal(privateEndpoint.body.error.code, 'validation_failed');

  const badSecret = await setProvider('chat', providerConfig({ apiKeyEnv: 'not-an-env-name' }));
  assert.equal(badSecret.status, 400);

  // Admin keys route to their own tenant: the same call with acme-key updates acme, not demo.
  const otherTenant = await ts.api('PUT', '/v1/admin/providers', {
    headers: { 'x-api-key': 'acme-key' },
    body: { providers: { chat: providerConfig() } },
  });
  assert.equal(otherTenant.status, 200);
  const demoStatus = await ts.api('GET', '/v1/admin/providers', { headers: ADMIN });
  assert.equal(demoStatus.body.providers.find((slot: { slot: string }) => slot.slot === 'chat').mode, 'builtin');
});

test('external chat: signed envelope is used, message broadcast/history mirror', async () => {
  const configured = await setProvider('chat', providerConfig());
  assert.equal(configured.status, 200);
  assert.equal(configured.body.providers.find((slot: { slot: string }) => slot.slot === 'chat').mode, 'external');

  const created = await ts.api('POST', '/v1/rooms', { body: { name: 'Provider chat' } });
  const token = created.body.token;
  const roomId = created.body.room.id;

  const posted = await ts.api('POST', `/v1/rooms/${roomId}/chat`, {
    headers: { authorization: `Bearer ${token}` },
    body: { text: 'привет', id: 'p-chat-1' },
  });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  assert.equal(posted.body.message.text, 'external: привет');
  assert.equal(posted.body.message.from.name, 'Corp Messenger');

  const call = calls.filter((entry) => entry.body.capability === 'chat' && entry.body.action === 'post').at(-1);
  assert.ok(call, 'provider received chat.post');
  assert.equal(call.body.tenantId, 'demo');
  assert.equal(call.body.roomId, roomId);
  const signature = String(call.headers['x-agil-signature'] ?? '');
  assert.equal(call.headers['x-agil-capability'], 'chat');
  assert.ok(call.headers['x-agil-request-id']);
  const expected = createHmac('sha256', RECEIVER_SECRET).update(JSON.stringify(call.body), 'utf8').digest('hex');
  assert.equal(signature, expected);

  const status = await ts.api('GET', '/v1/admin/providers', { headers: ADMIN });
  const chatStatus = status.body.providers.find((slot: { slot: string }) => slot.slot === 'chat');
  assert.equal(chatStatus.available, true);
  assert.equal(chatStatus.providerName, 'company');
});

test('external chat failure: fallback builtin, and fallback=fail returns 502 provider_failed', async () => {
  chatExternalFails = true;
  const created = await ts.api('POST', '/v1/rooms', { body: { name: 'Fallback chat' } });
  const roomId = created.body.room.id;
  const token = created.body.token;

  const fallback = await ts.api('POST', `/v1/rooms/${roomId}/chat`, {
    headers: { authorization: `Bearer ${token}` },
    body: { text: 'локальный чат', id: 'fallback-1' },
  });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.message.text, 'локальный чат');

  await setProvider('chat', providerConfig({ fallback: 'fail' }));
  const failed = await ts.api('POST', `/v1/rooms/${roomId}/chat`, {
    headers: { authorization: `Bearer ${token}` },
    body: { text: 'не должно пройти' },
  });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, 'provider_failed');

  chatExternalFails = false;
  await setProvider('chat', providerConfig());
});

test('external files: put/get route through the provider', async () => {
  const configured = await setProvider('files', providerConfig());
  assert.equal(configured.status, 200);
  await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { features: { fileShare: true } } });
  const created = await ts.api('POST', '/v1/rooms', { body: { name: 'Provider files' } });
  const token = created.body.token;

  const uploaded = await ts.api('POST', '/v1/files', {
    headers: { authorization: `Bearer ${token}`, 'x-file-name': 's3.txt', 'content-type': 'text/plain' },
    rawBody: 'hello s3',
  });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.id, 'ext-file-1');
  assert.ok(uploaded.body.url.includes('provider/files/ext-file-1'));
  const putCall = calls.filter((entry) => entry.body.capability === 'files' && entry.body.action === 'put').at(-1);
  assert.equal(Buffer.from(putCall.body.payload.dataBase64, 'base64').toString('utf8'), 'hello s3');

  const providerUrl = new URL(uploaded.body.url);
  const sig = providerUrl.searchParams.get('sig') ?? '';
  const exp = providerUrl.searchParams.get('exp') ?? '';
  const downloaded = await ts.api('GET', `/v1/files/${uploaded.body.id}?sig=${encodeURIComponent(sig)}&exp=${encodeURIComponent(exp)}&tenant=demo`);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.text, 'external-data!');

  const badSignature = await ts.api('GET', `/v1/files/${uploaded.body.id}?sig=bad&exp=9999999999999&tenant=demo`);
  assert.ok([200, 403].includes(badSignature.status));
  await setProvider('files', { mode: 'builtin', providerName: '', endpoint: '', apiKeyEnv: '', timeoutMs: 5000, fallback: 'builtin', options: {} });
});

test('external STT: transcribe goes to the vendor endpoint', async () => {
  const configured = await setProvider('stt', providerConfig());
  assert.equal(configured.status, 200);
  await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { features: { captions: true } } });
  const created = await ts.api('POST', '/v1/rooms', { body: { name: 'Provider stt' } });
  const token = created.body.token;
  const response = await ts.api('POST', '/v1/stt/transcribe', {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/webm' },
    rawBody: Buffer.from('fake audio'),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.text, 'привет из облака');
  await setProvider('stt', { mode: 'builtin', providerName: '', endpoint: '', apiKeyEnv: '', timeoutMs: 5000, fallback: 'builtin', options: {} });
});

test('managed remote STT checks the tenant node for both live chunks and uploaded audio', async () => {
  const nodeId = 'qa-stt-bound';
  const configureBinding = (id: string) => ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN, body: { features: { captions: true }, session: { transcription: { nodeId: id } } },
  });
  const enroll = async (headers: Record<string, string>) => {
    const issued = await ts.api('POST', '/v1/admin/cluster/tokens', { headers, body: { kind: 'node', role: 'all' } });
    assert.equal(issued.status, 201, issued.text);
    const registered = await ts.api('POST', '/v1/nodes/register', { body: { token: issued.body.token, role: 'all', nodeId } });
    assert.equal(registered.status, 201, registered.text);
    return registered.body.nodeKey as string;
  };
  const beat = (key: string, status: string) => ts.api('POST', `/v1/nodes/${nodeId}/heartbeat`, {
    headers: { 'x-node-token': key },
    body: { modules: [{ id: 'stt', image: 'agil/node-stt:0.1.0', status, health: 'healthy' }] },
  });
  assert.equal((await setProvider('stt', providerConfig())).status, 200);
  try {
    assert.equal((await configureBinding('https://invalid')).status, 400);
    assert.equal((await configureBinding(nodeId)).status, 200);
    const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Managed STT' } });
    assert.equal(created.status, 200, created.text);
    const transcribe = (mime: string, offset?: number) => ts.api('POST', '/v1/stt/transcribe', {
      headers: { authorization: `Bearer ${created.body.token}`, 'content-type': mime, ...(offset === undefined ? {} : { 'x-chunk-offset': String(offset) }) },
      rawBody: Buffer.from('test-only audio'),
    });
    const assertUnavailable = async () => {
      const before = calls.length;
      for (const response of [await transcribe('audio/webm', 8), await transcribe('audio/wav')]) {
        assert.equal(response.status, 503, response.text);
        assert.equal(response.body.error.code, 'stt_node_unavailable');
      }
      assert.equal(calls.length, before, 'audio is not forwarded');
    };
    const foreign = await enroll({ 'x-api-key': 'acme-key' });
    assert.equal((await beat(foreign, 'running')).status, 200);
    await assertUnavailable();
    const status = () => ts.api('GET', '/v1/admin/stt', { headers: ADMIN });
    assert.equal((await status()).body.stt.nodeAvailable, false);
    const key = await enroll(ADMIN);
    await assertUnavailable();
    assert.equal((await beat(key, 'running')).status, 200);
    const chunk = await transcribe('audio/webm', 8);
    assert.equal(chunk.status, 200, chunk.text);
    assert.equal(chunk.body.text, 'привет из облака');
    assert.equal((await status()).body.stt.nodeAvailable, true);
    assert.equal((await beat(key, 'stopped')).status, 200);
    await assertUnavailable();
    assert.equal((await beat(key, 'running')).status, 200);
    assert.equal((await transcribe('audio/wav')).status, 200);
    assert.equal((await beat(key, 'stopped')).status, 200);
    assert.equal((await configureBinding('')).status, 200);
    assert.equal((await transcribe('audio/wav')).status, 200);
    assert.equal((await status()).body.stt.nodeAvailable, undefined);
  } finally {
    await configureBinding('');
    await setProvider('stt', { mode: 'builtin', providerName: '', endpoint: '', apiKeyEnv: '', timeoutMs: 5000, fallback: 'builtin', options: {} });
  }
});

test('external backgrounds list; disabled mode returns 403', async () => {
  const configured = await setProvider('backgrounds', providerConfig());
  assert.equal(configured.status, 200);
  const list = await ts.api('GET', '/v1/tenants/demo/backgrounds');
  assert.equal(list.status, 200);
  assert.equal(list.body.provider, 'company');
  assert.equal(list.body.backgrounds[0].id, 'corp-1');

  await setProvider('backgrounds', { ...providerConfig(), mode: 'disabled' });
  const disabled = await ts.api('GET', '/v1/tenants/demo/backgrounds');
  assert.equal(disabled.status, 403);
  await setProvider('backgrounds', { mode: 'builtin', providerName: '', endpoint: '', apiKeyEnv: '', timeoutMs: 5000, fallback: 'builtin', options: {} });
});

test('notifications are best-effort and never block join/leave', async () => {
  notificationsFail = true;
  const configured = await setProvider('notifications', providerConfig({ fallback: 'fail' }));
  assert.equal(configured.status, 200);
  const created = await ts.api('POST', '/v1/rooms', { body: { name: 'Notify room' } });
  const roomId = created.body.room.id;
  const token = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Notify' } },
  });
  const { openWs } = await import('./helpers.js');
  const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(token.body.token)}`);
  await client.waitFor((message) => message.type === 'welcome');
  await client.close();
  await delay(200);
  const health = await ts.api('GET', '/v1/health');
  assert.equal(health.status, 200);
  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  assert.ok(
    audit.body.entries.some(
      (entry: { type: string; details?: { kind?: string } }) =>
        entry.type === 'webhook.failed' && entry.details?.kind === 'provider.notification_failed',
    ),
    'notification failure is audited',
  );
  await setProvider('notifications', { mode: 'builtin', providerName: '', endpoint: '', apiKeyEnv: '', timeoutMs: 5000, fallback: 'builtin', options: {} });
});

test('recording slot: external is unsupported; builtin provider test works', async () => {
  const configured = await setProvider('recording', providerConfig());
  assert.equal(configured.status, 200);
  const patched = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { session: { recording: { enabled: true, storeOnServer: true } }, features: { recording: true } },
  });
  assert.equal(patched.status, 200);
  const created = await ts.api('POST', '/v1/rooms', { body: { name: 'Recording provider' } });
  const token = created.body.token;
  const roomId = created.body.room.id;
  const response = await ts.api('POST', '/v1/recordings', {
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'video/webm',
      'x-recording-meta': JSON.stringify({ roomId, durationSec: 2, mimeType: 'video/webm' }),
    },
    rawBody: Buffer.from('webm'),
  });
  assert.equal(response.status, 501);
  assert.equal(response.body.error.code, 'provider_unsupported');

  await setProvider('recording', { mode: 'builtin', providerName: '', endpoint: '', apiKeyEnv: '', timeoutMs: 5000, fallback: 'builtin', options: {} });
  const test = await ts.api('POST', '/v1/admin/providers/test', { headers: ADMIN, body: { slot: 'recording' } });
  assert.equal(test.status, 200);
  assert.equal(test.body.ok, true);
});

test('POST /v1/admin/providers/test: builtin probe and external latency', async () => {
  const builtin = await ts.api('POST', '/v1/admin/providers/test', { headers: ADMIN, body: { slot: 'chat' } });
  assert.equal(builtin.status, 200);
  assert.equal(builtin.body.ok, true);
  assert.equal(typeof builtin.body.latencyMs, 'number');

  await setProvider('chat', providerConfig());
  const external = await ts.api('POST', '/v1/admin/providers/test', {
    headers: ADMIN,
    body: { slot: 'chat', payload: { probe: true } },
  });
  assert.equal(external.status, 200);
  assert.equal(external.body.ok, true);
  assert.equal(external.body.providerName, 'company');
  await setProvider('chat', { mode: 'builtin', providerName: '', endpoint: '', apiKeyEnv: '', timeoutMs: 5000, fallback: 'builtin', options: {} });
});

test('room.created webhook carries messenger mode/context for direct rooms', async () => {
  const saved = await ts.api('PUT', '/v1/admin/webhooks', {
    headers: ADMIN,
    body: {
      webhooks: [
        {
          id: 'hook-room',
          url: `${receiverUrl}/webhook`,
          events: ['room.created'],
          secretEnv: 'AGIL_WEBHOOK_TEST_SECRET',
          enabled: true,
          retries: 0,
          timeoutMs: 2000,
        },
      ],
    },
  });
  assert.equal(saved.status, 200);
  const created = await ts.api('POST', '/v1/admin/rooms', {
    headers: ADMIN,
    body: {
      name: 'Direct call',
      mode: 'direct',
      context: { messenger: 'telegram', conversationId: 'conv-42', title: 'Чат с клиентом' },
    },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.room.mode, 'direct');
  assert.equal(created.body.room.maxParticipants, 2);
  const detail = await ts.api('GET', `/v1/admin/rooms/${created.body.room.id}`, { headers: ADMIN });
  assert.equal(detail.body.room.mode, 'direct');
  assert.equal(detail.body.room.context.conversationId, 'conv-42');

  // Public creation + join carry the same messenger metadata.
  const publicDirect = await ts.api('POST', '/v1/rooms', {
    body: { name: 'Slack call', mode: 'direct', context: { messenger: 'slack', conversationId: 'c-2' }, maxParticipants: 10 },
  });
  assert.equal(publicDirect.status, 200);
  assert.equal(publicDirect.body.room.mode, 'direct');
  assert.equal(publicDirect.body.room.context.messenger, 'slack');
  const joined = await ts.api('POST', `/v1/rooms/${publicDirect.body.room.id}/join`, { body: { name: 'Guest' } });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.room.mode, 'direct');
  assert.equal(joined.body.room.context.conversationId, 'c-2');

  const groupDefault = await ts.api('POST', '/v1/rooms', { body: { name: 'Group call' } });
  assert.equal(groupDefault.body.room.mode, 'group');
  assert.equal(groupDefault.body.room.context, undefined);

  await ts.api('PUT', '/v1/admin/webhooks', { headers: ADMIN, body: { webhooks: [] } });
});
