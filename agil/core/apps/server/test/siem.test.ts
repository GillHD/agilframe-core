/** SIEM audit export: JSON/CEF, HMAC, retries/timeout, fail-open, status/test endpoint. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const SECRET = 'siem-secret-value';
let ts: TestServer;
let receiver: Server;
let receiverUrl = '';
let slowServer: Server;
let slowUrl = '';
let mode: 'ok' | 'fail' | 'hang' | 'slow' = 'ok';
let requests: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
let failuresLeft = 0;

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('waitFor timeout');
}

async function configureSiem(overrides: Record<string, unknown> = {}): Promise<void> {
  const patched = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: {
      integrations: {
        siem: {
          enabled: true,
          url: receiverUrl,
          format: 'json',
          secretEnv: 'AGIL_SIEM_TEST_SECRET',
          events: ['room.created'],
          timeoutMs: 1000,
          retries: 0,
          ...overrides,
        },
      },
    },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
}

before(async () => {
  process.env.AGIL_SIEM_TEST_SECRET = SECRET;
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (mode === 'hang') return; // never respond → client timeout
      if (mode === 'slow') {
        setTimeout(() => { res.statusCode = 200; res.end('late'); }, 3000);
        return;
      }
      if (mode === 'fail' || failuresLeft > 0) {
        if (failuresLeft > 0) failuresLeft -= 1;
        res.statusCode = 500;
        res.end('fail');
        return;
      }
      res.statusCode = 200;
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', () => resolve()));
  const port = (receiver.address() as { port: number }).port;
  receiverUrl = `http://127.0.0.1:${port}/siem`;
  slowServer = createServer((req, res) => {
    req.resume();
    setTimeout(() => {
      res.statusCode = 200;
      res.end('late');
    }, 5000);
  });
  await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', () => resolve()));
  slowUrl = `http://127.0.0.1:${(slowServer.address() as { port: number }).port}/siem`;
  ts = await startTestServer();
});

after(async () => {
  delete process.env.AGIL_SIEM_TEST_SECRET;
  await ts.close();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await new Promise<void>((resolve) => slowServer.close(() => resolve()));
});

test('SIEM disabled by default: status off, test endpoint 501 (no secrets)', async () => {
  const status = await ts.api('GET', '/v1/admin/siem/status', { headers: ADMIN });
  assert.equal(status.status, 200);
  assert.equal(status.body.configured, false);
  assert.equal(status.body.enabled, false);
  assert.equal(status.body.format, 'json');
  assert.equal(status.body.queue, 0);
  assert.equal(status.body.lastError, null);
  assert.ok(!JSON.stringify(status.body).includes('secret'));

  const tested = await ts.api('POST', '/v1/admin/siem/test', { headers: ADMIN });
  assert.equal(tested.status, 501);
  assert.equal(tested.body.error.code, 'siem_not_configured');
});

test('SIEM JSON delivery: payload, ipHash only, HMAC signature, status lastDelivery', async () => {
  requests = [];
  mode = 'ok';
  await configureSiem();
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'SIEM room' } });
  assert.equal(created.status, 200);
  const request = await waitFor(() => requests.find((entry) => entry.body.includes('room.created')));
  const payload = JSON.parse(request.body) as Record<string, unknown>;
  assert.ok(payload.deliveryId);
  assert.equal(payload.tenantId, 'demo');
  assert.equal(payload.event, 'room.created');
  assert.equal(payload.severity, 'info');
  assert.equal(typeof payload.message, 'string');
  assert.ok(payload.details && typeof payload.details === 'object');
  assert.equal(payload.ipHash === null || typeof payload.ipHash === 'string', true);
  assert.ok(!request.body.includes('127.0.0.1'), 'raw IP is not exported');
  assert.ok(!request.body.includes(SECRET), 'secret is not exported');
  assert.equal(request.headers['content-type'], 'application/json');
  const expected = createHmac('sha256', SECRET).update(request.body, 'utf8').digest('hex');
  assert.equal(request.headers['x-agil-signature'], expected, 'HMAC over the raw JSON body');

  const status = await ts.api('GET', '/v1/admin/siem/status', { headers: ADMIN });
  assert.equal(status.body.configured, true);
  assert.equal(status.body.enabled, true);
  assert.equal(status.body.lastDelivery.ok, true);
  assert.equal(status.body.lastDelivery.statusCode, 200);
  assert.equal(status.body.lastError, null);
  assert.ok(!JSON.stringify(status.body).includes(receiverUrl), 'collector URL is not exposed');
});

test('SIEM CEF format: CEF header and extension fields', async () => {
  requests = [];
  await configureSiem({ format: 'cef', events: ['room.closed'] });
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'CEF room' } });
  await ts.api('DELETE', `/v1/admin/rooms/${created.body.room.id}`, { headers: ADMIN });
  const request = await waitFor(() => requests.find((entry) => entry.body.startsWith('CEF:')));
  assert.ok(request.body.startsWith('CEF:0|AGIL|Calls|0.1|room.closed|'));
  assert.ok(request.body.includes('tenantId=demo'));
  assert.ok(request.body.includes('event=room.closed'));
  assert.equal(request.headers['content-type'], 'text/plain; charset=utf-8');
  const expected = createHmac('sha256', SECRET).update(request.body, 'utf8').digest('hex');
  assert.equal(request.headers['x-agil-signature'], expected);
});

test('SIEM retries + timeout are fail-open and never block audit/API', async () => {
  requests = [];
  mode = 'fail';
  failuresLeft = 2;
  await configureSiem({ retries: 1, timeoutMs: 500, events: ['room.created'] });
  const started = Date.now();
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Retry room' } });
  assert.equal(created.status, 200);
  assert.ok(Date.now() - started < 2000, 'API is not blocked by SIEM delivery');
  await waitFor(() => requests.length >= 2, 6000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const failedStatus = await ts.api('GET', '/v1/admin/siem/status', { headers: ADMIN });
  assert.equal(failedStatus.body.lastDelivery.ok, false);
  assert.equal(failedStatus.body.lastDelivery.attempts, 2, 'one retry performed');
  assert.ok(failedStatus.body.lastDelivery.statusCode === 500);
  assert.ok(failedStatus.body.lastError);

  // Audit trail still contains the event despite SIEM failures.
  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  assert.ok(audit.body.entries.some((entry: { type: string }) => entry.type === 'room.created'));

  // Timeout: a slow collector must not block the API and must record lastError.
  requests = [];
  await configureSiem({ url: slowUrl, retries: 0, timeoutMs: 500, events: ['room.created'] });
  const before = Date.now();
  const timed = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Timeout room' } });
  assert.equal(timed.status, 200);
  assert.ok(Date.now() - before < 2000);
  let timeoutStatus = await ts.api('GET', '/v1/admin/siem/status', { headers: ADMIN });
  for (let attempt = 0; attempt < 30 && !(timeoutStatus.body.lastDelivery?.attempts === 1 && /timeout|abort/i.test(String(timeoutStatus.body.lastError))); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    timeoutStatus = await ts.api('GET', '/v1/admin/siem/status', { headers: ADMIN });
  }
  assert.equal(timeoutStatus.body.lastDelivery.ok, false);
  assert.match(String(timeoutStatus.body.lastError), /timeout|abort/i);
});

test('SIEM test endpoint sends a test event and audits siem.test without secrets', async () => {
  requests = [];
  mode = 'ok';
  await configureSiem({ events: [] });
  const tested = await ts.api('POST', '/v1/admin/siem/test', { headers: ADMIN });
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.equal(tested.body.ok, true);
  assert.equal(tested.body.statusCode, 200);
  assert.equal(typeof tested.body.latencyMs, 'number');
  const request = await waitFor(() => requests.find((entry) => entry.body.includes('siem.test') || entry.body.includes('SIEM test')));
  assert.ok(request.body.includes('siem.test') || request.body.includes('SIEM test'));
  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  assert.ok(audit.body.entries.some((entry: { details?: { kind?: string } }) => entry.details?.kind === 'siem.test'));
  assert.ok(!JSON.stringify(audit.body).includes(SECRET));
});
