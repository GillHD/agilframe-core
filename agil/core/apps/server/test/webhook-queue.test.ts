import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyWebhookSignature } from '@agil/security';
import { delay, startTestServer } from './helpers.js';

const SECRET_ENV = 'AGIL_WEBHOOK_QUEUE_TEST_SECRET';
const ADMIN = { 'x-api-key': 'dev-key' };
const OTHER_ADMIN = { 'x-api-key': 'acme-key' };

interface DeliveryRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

async function setup(respond: (request: DeliveryRequest, response: ServerResponse, number: number) => void) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agil-webhook-queue-'));
  const oldSecret = process.env[SECRET_ENV];
  const requests: DeliveryRequest[] = [];
  const receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const received = { path: request.url ?? '/', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') };
    requests.push(received);
    respond(received, response, requests.length);
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  const queueDir = join(dataDir, 'webhook-queue');
  function core(secret = 'queue-fixture-secret') {
    process.env[SECRET_ENV] = secret;
    return startTestServer({ dataDir });
  }
  function close(): Promise<void> {
    if (oldSecret === undefined) delete process.env[SECRET_ENV];
    else process.env[SECRET_ENV] = oldSecret;
    rmSync(dataDir, { force: true, recursive: true });
    return new Promise((resolve) => {
      receiver.close(() => resolve());
      receiver.closeAllConnections();
    });
  }
  return { core, requests, dataDir, queueDir, origin, close };
}

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(20);
  assert.ok(predicate(), 'pending delivery did not reach the expected state');
}

async function subscribe(core: Awaited<ReturnType<typeof startTestServer>>, url: string, headers = ADMIN) {
  const response = await core.api('PUT', '/v1/admin/webhooks', {
    headers,
    body: { webhooks: [{ id: 'same-endpoint', url, events: ['recording.ready'], enabled: true, secretEnv: SECRET_ENV, retries: 1, timeoutMs: 2000 }] },
  });
  assert.equal(response.status, 200);
}

test('webhook queue resumes an interrupted attempt with the same body, ID and remaining retry budget', async () => {
  const fixture = await setup((_request, response, number) => {
    if (number === 2) return; // remote has seen the request but did not acknowledge it
    response.writeHead(number === 1 ? 503 : 204).end();
  });
  let core: Awaited<ReturnType<typeof startTestServer>> | undefined;
  try {
    core = await fixture.core();
    const target = `${fixture.origin}/tenant-first`;
    await subscribe(core, target);
    const firstDispatcher = core.server.services.webhooks;
    const data = { recordingId: 'recording-one', details: { state: 'original' } };
    assert.equal(firstDispatcher.emit('recording.ready', { tenantId: 'demo', roomId: 'room-one' }, data, { eventId: 'recording-one' }), 1);
    data.details.state = 'changed after emit';
    assert.equal(firstDispatcher.emit('recording.ready', { tenantId: 'demo', roomId: 'room-one' }, data, { eventId: 'recording-one' }), 1);

    await until(() => fixture.requests.length === 2);
    const files = readdirSync(fixture.queueDir);
    assert.equal(files.length, 1);
    const raw = readFileSync(join(fixture.queueDir, files[0]!), 'utf8');
    const entry = JSON.parse(raw);
    assert.equal(entry.failures, 1);
    assert.ok(entry.retryAfter > 0);
    assert.ok(!raw.includes(target));
    assert.ok(!raw.includes('queue-fixture-secret'));
    assert.equal(entry.payload.data.details.state, 'original');

    await firstDispatcher.close(0);
    await core.close();
    core = await fixture.core('rotated-queue-fixture-secret');
    await until(() => fixture.requests.length === 3 && readdirSync(fixture.queueDir).length === 0);
    const [initial, interrupted, recovered] = fixture.requests;
    assert.ok(initial && interrupted && recovered);
    for (const request of [interrupted, recovered]) {
      assert.equal(request.body, initial.body);
      assert.equal(request.headers['x-agil-delivery'], initial.headers['x-agil-delivery']);
    }
    assert.equal(recovered.headers['x-agil-delivery'], entry.payload.id);
    assert.notEqual(recovered.headers['x-agil-timestamp'], interrupted.headers['x-agil-timestamp']);
    assert.ok(verifyWebhookSignature(recovered.body, 'rotated-queue-fixture-secret', String(recovered.headers['x-agil-signature']), String(recovered.headers['x-agil-timestamp'])));
    assert.equal(core.server.services.webhooks.list(1)[0]?.attempts, 2);

    // An independently configured tenant can use the same endpoint ID.
    await subscribe(core, `${fixture.origin}/tenant-other`, OTHER_ADMIN);
    assert.equal(core.server.services.webhooks.emit('recording.ready', { tenantId: 'acme' }, {}, { eventId: 'recording-one' }), 1);
    await until(() => fixture.requests.length === 4 && readdirSync(fixture.queueDir).length === 0);
    for (const [headers, request] of [[ADMIN, recovered], [OTHER_ADMIN, fixture.requests[3]!]] as const) {
      const response = await core.api('GET', '/v1/admin/webhooks', { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.recentDeliveries.map((record: { id: string }) => record.id), [request.headers['x-agil-delivery']]);
    }
    assert.notEqual(fixture.requests[3]!.headers['x-agil-delivery'], recovered.headers['x-agil-delivery']);

    await core.close();
    core = await fixture.core();
    await core.server.services.webhooks.drain();
    assert.equal(fixture.requests.length, 4, 'acknowledged entries are not replayed');
  } finally {
    await core?.close();
    await fixture.close();
  }
});

test('queued webhook does not send an old payload to a replacement recipient', async () => {
  const fixture = await setup(() => { /* hold the original request open */ });
  let core: Awaited<ReturnType<typeof startTestServer>> | undefined;
  try {
    core = await fixture.core();
    await subscribe(core, `${fixture.origin}/former`);
    const firstDispatcher = core.server.services.webhooks;
    assert.equal(firstDispatcher.emit('recording.ready', { tenantId: 'demo' }, { recordingId: 'private-recording' }), 1);
    await until(() => fixture.requests.length === 1);
    await firstDispatcher.close(0);
    await subscribe(core, `${fixture.origin}/replacement`);
    await core.close();
    core = await fixture.core();
    await core.server.services.webhooks.drain();
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(readdirSync(fixture.queueDir), []);
    assert.equal(core.server.services.webhooks.list(1)[0]?.status, 'failed');
  } finally {
    await core?.close();
    await fixture.close();
  }
});

test('an accepted webhook survives abrupt Core process termination', { timeout: 25_000 }, async () => {
  const fixture = await setup((_request, response, number) => {
    if (number > 1) response.writeHead(204).end();
  });
  const first = await fixture.core();
  let reopened: Awaited<ReturnType<typeof startTestServer>> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let exited: ReturnType<typeof once> | undefined;
  try {
    await subscribe(first, `${fixture.origin}/crash-test`);
    await first.close();
    const script = `
      import { createAgilServer } from './agil/core/apps/server/src/index.ts';
      import { silentLogger } from './agil/core/apps/server/src/logger.ts';
      const server = await createAgilServer({
        host: '127.0.0.1', port: 0, dataDir: process.env.AGIL_TEST_WEBHOOK_DATA_DIR,
        logger: silentLogger, docsDataDir: '',
      });
      const accepted = server.services.webhooks.emit('recording.ready', { tenantId: 'demo' }, { scene: 'crash' });
      process.send({ accepted });
    `;
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: new URL('../../../../../', import.meta.url),
      env: { ...process.env, AGIL_TEST_WEBHOOK_DATA_DIR: fixture.dataDir },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    exited = once(child, 'exit');
    const [message] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(15_000) }),
      exited.then(([code]) => { throw new Error(`Core child stopped before accepting a webhook (${code})`); }),
    ]);
    assert.deepEqual(message, { accepted: 1 });
    await until(() => fixture.requests.length === 1, 6000);
    assert.ok(child.kill('SIGKILL'));
    await exited;
    assert.equal(readdirSync(fixture.queueDir).length, 1);

    reopened = await fixture.core();
    await until(() => fixture.requests.length === 2 && readdirSync(fixture.queueDir).length === 0);
    assert.equal(fixture.requests[1]!.headers['x-agil-delivery'], fixture.requests[0]!.headers['x-agil-delivery']);
    assert.equal(fixture.requests[1]!.body, fixture.requests[0]!.body);
  } finally {
    if (child && !child.killed && child.exitCode === null) child.kill('SIGKILL');
    await exited;
    await reopened?.close();
    await first.close();
    await fixture.close();
  }
});
