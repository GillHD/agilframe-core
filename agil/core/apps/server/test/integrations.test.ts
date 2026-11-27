/** Corporate integrations: signed webhooks, knowledge agent proxy, access policy + WS assistant. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from '@agil/security';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { delay, openWs, startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
let ts: TestServer;
let receiver: Server;
let receiverUrl: string;
const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
const knowledgeAnswers: unknown[] = [];

interface ReceiverHandle {
  server: Server;
  url: string;
}
async function startReceiver(): Promise<ReceiverHandle> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ headers: req.headers, body });
      if (req.url === '/kb') {
        let requestId = 'unknown';
        try {
          requestId = JSON.parse(body).requestId;
        } catch {
          /* ignore */
        }
        const answer = { requestId, answer: 'Отпуск оформляется в HR-портале.', citations: [{ title: 'HR wiki', url: 'https://example.com/wiki/leave' }], confidence: 0.9, provider: 'test-kb' };
        knowledgeAnswers.push(answer);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(answer));
        return;
      }
      res.statusCode = 200;
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

before(async () => {
  // The secret snapshot is taken at startup: allowlisted names must be present
  // before `startTestServer()`.
  process.env.AGIL_WEBHOOK_TEST_SECRET = 'webhook-secret-value';
  process.env.AGIL_INTEGRATION_TEST_KB_KEY = 'test-kb-key';
  ts = await startTestServer();
  const handle = await startReceiver();
  receiver = handle.server;
  receiverUrl = handle.url;
});

after(async () => {
  delete process.env.AGIL_WEBHOOK_TEST_SECRET;
  delete process.env.AGIL_INTEGRATION_TEST_KB_KEY;
  await ts.close();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

test('webhooks: PUT validates URLs, test delivery is signed, deliveries are logged', async () => {
  const invalid = await ts.api('PUT', '/v1/admin/webhooks', {
    headers: ADMIN,
    body: { webhooks: [{ id: 'bad', url: 'ftp://example.com/hook', events: ['room.created'], secretEnv: 'AGIL_WEBHOOK_TEST_SECRET', enabled: true, retries: 0, timeoutMs: 1000 }] },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'validation_failed');

  const invalidEnv = await ts.api('PUT', '/v1/admin/webhooks', {
    headers: ADMIN,
    body: { webhooks: [{ id: 'bad', url: `${receiverUrl}/hook`, events: ['room.created'], secretEnv: 'lower-case', enabled: true, retries: 0, timeoutMs: 1000 }] },
  });
  assert.equal(invalidEnv.status, 400);

  const saved = await ts.api('PUT', '/v1/admin/webhooks', {
    headers: ADMIN,
    body: {
      webhooks: [
        {
          id: 'hook1',
          url: `${receiverUrl}/hook`,
          events: ['security.event', 'room.created'],
          secretEnv: 'AGIL_WEBHOOK_TEST_SECRET',
          enabled: true,
          retries: 0,
          timeoutMs: 2000,
          description: 'test receiver',
        },
      ],
    },
  });
  assert.equal(saved.status, 200, 'saved should be 200 but got ' + saved.status + ' ' + JSON.stringify(saved.body));
  assert.equal(saved.body.webhooks.length, 1);

  const tested = await ts.api('POST', '/v1/admin/webhooks/test', { headers: ADMIN, body: { endpointId: 'hook1' } });
  assert.equal(tested.status, 200);
  assert.equal(tested.body.status, 'delivered');

  const request = received[received.length - 1];
  assert.ok(request, 'receiver got the delivery');
  const signature = String(request.headers['x-agil-signature'] ?? '');
  const timestamp = String(request.headers['x-agil-timestamp'] ?? '');
  // Contract §19: the timestamp is covered by HMAC(`${timestamp}.${rawBody}`).
  const expected = createHmac('sha256', 'webhook-secret-value').update(`${timestamp}.${request.body}`, 'utf8').digest('hex');
  assert.equal(signature, expected);
  assert.ok(/^\d{10,16}$/.test(timestamp), `timestamp header: ${timestamp}`);
  assert.equal(verifyWebhookSignature(request.body, 'webhook-secret-value', signature, timestamp), true);
  assert.equal(verifyWebhookSignature(request.body, 'webhook-secret-value', signature, String(Number(timestamp) - 400_000)), false);
  assert.ok(request.headers['x-agil-delivery']);
  assert.equal(request.headers['x-agil-event'], 'security.event');

  // A room.created event fan-outs to the same endpoint.
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Webhook room' } });
  assert.equal(created.status, 200);
  for (let attempt = 0; attempt < 30 && !received.some((entry) => entry.headers['x-agil-event'] === 'room.created'); attempt += 1) {
    await delay(50);
  }
  assert.ok(received.some((entry) => entry.headers['x-agil-event'] === 'room.created'));

  const list = await ts.api('GET', '/v1/admin/webhooks', { headers: ADMIN });
  assert.equal(list.status, 200);
  assert.ok(list.body.recentDeliveries.length >= 2);
  assert.ok(list.body.recentDeliveries.some((delivery: { status: string }) => delivery.status === 'delivered'));
});

test('knowledge agent: settings, admin ask proxy, audit', async () => {
  // BUG-KNOW-03: not configured → 501 knowledge_not_configured (not 403).
  const unavailable = await ts.api('POST', '/v1/admin/knowledge/ask', { headers: ADMIN, body: { question: 'x' } });
  assert.equal(unavailable.status, 501, 'unavailable should be 501 but got ' + unavailable.status + ' ' + JSON.stringify(unavailable.body));
  assert.equal(unavailable.body.error.code, 'knowledge_not_configured');
  assert.match(unavailable.body.error.message, /не настроен/i);

  // Enabled + endpoint but missing API-key env → still 501 with the env name.
  await ts.api('PUT', '/v1/admin/knowledge-agent', {
    headers: ADMIN,
    body: { config: { enabled: true, endpoint: `${receiverUrl}/kb`, apiKeyEnv: 'AGIL_INTEGRATION_MISSING_KB_KEY' } },
  });
  const missingKey = await ts.api('POST', '/v1/admin/knowledge/ask', { headers: ADMIN, body: { question: 'x', role: 'host' } });
  assert.equal(missingKey.status, 501);
  assert.equal(missingKey.body.error.code, 'knowledge_not_configured');
  assert.match(missingKey.body.error.message, /AGIL_INTEGRATION_MISSING_KB_KEY/);

  const saved = await ts.api('PUT', '/v1/admin/knowledge-agent', {
    headers: ADMIN,
    body: {
      config: {
        enabled: true,
        endpoint: `${receiverUrl}/kb`,
        apiKeyEnv: 'AGIL_INTEGRATION_TEST_KB_KEY',
        allowedRoles: ['host', 'moderator'],
        requirePermission: false,
        citations: true,
        timeoutMs: 2000,
      },
    },
  });
  assert.equal(saved.status, 200, 'saved should be 200 but got ' + saved.status + ' ' + JSON.stringify(saved.body));
  assert.equal(saved.body.config.enabled, true);
  assert.equal(saved.body.endpointConfigured, true);

  const asked = await ts.api('POST', '/v1/admin/knowledge/ask', {
    headers: ADMIN,
    body: { question: 'Как оформить отпуск?', role: 'host' },
  });
  assert.equal(asked.status, 200, 'asked should be 200 but got ' + asked.status + ' ' + JSON.stringify(asked.body));
  assert.match(String(asked.body.answer), /отпуск/i, 'answer: ' + JSON.stringify(asked.body));
  assert.equal(asked.body.citations.length, 1);
  assert.equal(asked.body.provider, 'test-kb');

  const denied = await ts.api('POST', '/v1/admin/knowledge/ask', {
    headers: ADMIN,
    body: { question: 'Как оформить отпуск?', role: 'guest' },
  });
  assert.equal(denied.status, 403, 'denied should be 403 but got ' + denied.status + ' ' + JSON.stringify(denied.body));

  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  const types = audit.body.entries.map((entry: { type: string }) => entry.type);
  assert.ok(types.includes('knowledge.query'));
  assert.ok(types.includes('knowledge.denied'));
});

test('WS assistant-query: host gets a cited answer; guest is forbidden', async () => {
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Assistant room' } });
  const roomId = created.body.room.id;
  const hostToken = await ts.api('POST', '/v1/tokens', { headers: ADMIN, body: { tenantId: 'demo', roomId, participant: { name: 'Host', role: 'host' } } });
  const guestToken = await ts.api('POST', '/v1/tokens', { headers: ADMIN, body: { tenantId: 'demo', roomId, participant: { name: 'Guest', role: 'guest' } } });

  const host = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(hostToken.body.token)}`);
  await host.waitFor((message) => message.type === 'welcome');
  host.send({ type: 'assistant-query', id: 'q-host', question: 'Как оформить отпуск?' });
  const answer = await host.waitFor((message) => message.type === 'assistant-answer' && message.id === 'q-host');
  assert.match(String(answer.answer), /отпуск/i, JSON.stringify(answer));
  assert.equal(answer.citations.length, 1);

  const guest = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(guestToken.body.token)}`);
  await guest.waitFor((message) => message.type === 'welcome');
  guest.send({ type: 'assistant-query', id: 'q-guest', question: 'А мне можно?' });
  const denied = await guest.waitFor((message) => message.type === 'assistant-answer' && message.id === 'q-guest');
  assert.equal(denied.error, 'forbidden');
  assert.deepEqual(denied.citations, []);

  await host.close();
  await guest.close();
});

test('access policy: PUT updates effective features and is enforced on chat', async () => {
  const before = await ts.api('GET', '/v1/admin/access-policy', { headers: ADMIN });
  assert.equal(before.status, 200);
  assert.ok(Array.isArray(before.body.featureKeys));
  assert.ok(Array.isArray(before.body.effective.host));
  assert.ok(before.body.effective.host.includes('chat'));

  const updated = await ts.api('PUT', '/v1/admin/access-policy', {
    headers: ADMIN,
    body: { policy: { deniedFeatures: ['chat'] } },
  });
  assert.equal(updated.status, 200);
  assert.ok(!updated.body.effective.host.includes('chat'));
  assert.ok(!updated.body.effective.guest.includes('chat'));

  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Policy room' } });
  const roomId = created.body.room.id;
  const token = await ts.api('POST', '/v1/tokens', { headers: ADMIN, body: { tenantId: 'demo', roomId, participant: { name: 'Guest' } } });
  const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(token.body.token)}`);
  const welcome = await client.waitFor((message) => message.type === 'welcome');
  assert.ok(!welcome.self.permissions.includes('chat'));
  client.send({ type: 'chat', id: 'denied-chat', text: 'не должно пройти' });
  const error = await client.waitFor((message) => message.type === 'error' && message.code === 'unauthorized');
  assert.match(String(error.message), /chat/i);
  await client.close();

  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  assert.ok(audit.body.entries.some((entry: { type: string }) => entry.type === 'access.updated'));

  // Restore the default policy for other tests in this file.
  await ts.api('PUT', '/v1/admin/access-policy', { headers: ADMIN, body: { policy: { deniedFeatures: [] } } });
});
