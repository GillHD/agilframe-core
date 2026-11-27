import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { EgressError } from '../src/egress.js';
import { EgressStartLedger } from '../src/egress-start-ledger.js';
import type { CreateServerOptions } from '../src/index.js';
import { startTestServer, type TestServer } from './helpers.js';

const admin = { 'x-api-key': 'dev-key' };
const streamUrl = 'rtmp://recordings.example/live/a-private-stream-key';
const roomId = 'manual-egress-qa';

function barrier() {
  let signal!: () => void;
  const promise = new Promise<void>((resolve) => { signal = resolve; });
  return { promise, signal };
}

async function fixture(t: TestContext) {
  let requested = 0;
  let next: { action: 'drop' | Promise<void>; entered: () => void } | undefined;
  const twirp = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    assert.equal(request.url, '/twirp/livekit.Egress/StartRoomCompositeEgress');
    const job = 'EG_IDEMPOTENCY_' + ++requested;
    const upcoming = next;
    next = undefined;
    upcoming?.entered();
    if (upcoming?.action === 'drop') {
      response.destroy();
      return;
    }
    await upcoming?.action;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ egress_id: job, status: 'EGRESS_STARTING' }));
  });
  twirp.listen(0, '127.0.0.1');
  await once(twirp, 'listening');
  const bound = twirp.address();
  assert.ok(bound && typeof bound === 'object');
  const apps = new Set<TestServer>();
  const directories: string[] = [];
  t.after(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    await new Promise<void>((resolve) => twirp.close(() => resolve()));
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  });
  const directory = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agil-egress-start-test-'));
    directories.push(dir);
    return dir;
  };
  const boot = async (dataDir: string, options: CreateServerOptions = {}) => {
    const app = await startTestServer({
      dataDir,
      egressUrl: `http://127.0.0.1:${bound.port}`,
      egressApiKey: 'test-egress-key',
      egressApiSecret: 'test-egress-secret',
      egressEnabled: true,
      ...options,
    });
    apps.add(app);
    const configured = await app.api('PATCH', '/v1/tenants/demo/config', {
      headers: admin,
      body: {
        features: { recording: true, liveStreaming: true },
        scale: { streaming: { enabled: true } },
        mediaProcessing: { mode: 'server-assisted', egress: true },
      },
    });
    assert.equal(configured.status, 200, configured.text);
    const room = await app.api('POST', '/v1/admin/rooms', { headers: admin, body: { roomId, name: 'Egress start QA' } });
    // A Core using room continuity can have restored the same room.
    assert.ok(room.status === 200 || (room.status === 409 && room.body.error?.code === 'validation_failed'), room.text);
    return app;
  };
  const close = async (app: TestServer) => {
    await app.close();
    apps.delete(app);
  };
  return { boot, close, directory, count: () => requested, next: (action: 'drop' | Promise<void>) => {
    const entered = barrier();
    next = { action, entered: entered.signal };
    return entered.promise;
  } };
}

function start(app: TestServer, key: string, body: Record<string, unknown> = { kind: 'recording' }, headers: Record<string, string> = admin) {
  return app.api('POST', `/v1/rooms/${roomId}/egress/start`, { headers: { ...headers, 'idempotency-key': key }, body });
}

test('parallel equivalent starts share one Egress request, while other keys are independent', async (t) => {
  const lab = await fixture(t);
  const dataDir = await lab.directory();
  const app = await lab.boot(dataDir);
  const pending = barrier();
  const arrived = lab.next(pending.promise);
  const first = start(app, 'same-intent', { kind: 'rtmp', rtmpUrl: streamUrl });
  await Promise.race([arrived, first.then((response) => { throw new Error(`The first call never reached test Egress (HTTP ${response.status}).`); })]);
  const second = start(app, 'same-intent', { layout: 'grid', kind: 'rtmp', rtmpUrl: streamUrl, audioOnly: false });
  let independent;
  try {
    independent = await start(app, 'another-intent', { kind: 'rtmp', rtmpUrl: streamUrl });
    assert.equal(independent.status, 200);
    const conflict = await start(app, 'same-intent', { kind: 'rtmp', layout: 'speaker', rtmpUrl: streamUrl });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'idempotency_conflict');
    assert.equal(lab.count(), 2);
  } finally {
    pending.signal();
  }
  const [original, replay] = await Promise.all([first, second]);
  assert.equal(original.status, 200);
  assert.deepEqual(replay.body, original.body);
  assert.notEqual(original.body.egressId, independent.body.egressId);
  assert.equal((await start(app, 'same-intent', { kind: 'rtmp', rtmpUrl: streamUrl }, { 'x-api-key': 'acme-key' })).status, 403);
  assert.equal((await start(app, 'invalid,key')).status, 400);
  assert.equal(lab.count(), 2);

  const ledger = path.join(dataDir, 'egress-starts');
  const records = await Promise.all((await readdir(ledger)).map((file) => readFile(path.join(ledger, file), 'utf8')));
  assert.equal(records.length, 2);
  for (const raw of records) {
    assert.ok(!raw.includes('same-intent') && !raw.includes('a-private-stream-key'));
  }
});

test('completed and uncertain starts survive a Core restart without a second dispatch', async (t) => {
  const lab = await fixture(t);
  const dataDir = await lab.directory();
  const first = await lab.boot(dataDir);
  const completed = await start(first, 'completed');
  assert.equal(completed.status, 200);
  lab.next('drop');
  assert.equal((await start(first, 'external-outcome-unclear')).status, 502);
  await lab.close(first);

  const restarted = await lab.boot(dataDir);
  const replay = await start(restarted, 'completed');
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, completed.body);
  const uncertain = await start(restarted, 'external-outcome-unclear');
  assert.equal(uncertain.status, 409);
  assert.equal(uncertain.body.error.code, 'egress_start_outcome_unknown');
  const conflict = await start(restarted, 'completed', { kind: 'hls' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'idempotency_conflict');
  assert.equal(lab.count(), 2);
});

test('a confirmed local refusal releases its idempotency reservation for the same intent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agil-egress-start-ledger-'));
  const ledger = new EgressStartLedger(dir, 'test-ledger-secret');
  const input = { tenantId: 'demo', roomId, roomName: 'demo__' + roomId, kind: 'recording' as const };
  try {
    await assert.rejects(ledger.start('retry', input, async () => {
      throw new EgressError(503, 'egress_node_unavailable', 'Egress node is unavailable');
    }), { code: 'egress_node_unavailable' });
    const result = { roomName: input.roomName, kind: input.kind, status: 'EGRESS_ACTIVE', egressId: 'EG_RETRY' };
    assert.deepEqual(await ledger.start('retry', input, async () => result), result);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a new Core leader with its own disk reuses the Redis registration', { skip: !process.env.AGIL_TEST_REDIS_URL }, async (t) => {
  const lab = await fixture(t);
  const common: CreateServerOptions = {
    redisUrl: process.env.AGIL_TEST_REDIS_URL,
    clusterId: `qa-egress-idempotency-${randomUUID()}`,
    clusterRole: 'leader',
  };
  const first = await lab.boot(await lab.directory(), { ...common, clusterNodeId: 'first-core' });
  const accepted = await start(first, 'redis-job');
  assert.equal(accepted.status, 200, accepted.text);
  lab.next('drop');
  assert.equal((await start(first, 'redis-ambiguous')).status, 502);
  await lab.close(first);
  const second = await lab.boot(await lab.directory(), { ...common, clusterNodeId: 'successor-core' });
  const replay = await start(second, 'redis-job');
  assert.equal(replay.status, 200, replay.text);
  assert.deepEqual(replay.body, accepted.body);
  const uncertain = await start(second, 'redis-ambiguous');
  assert.equal(uncertain.status, 409);
  assert.equal(uncertain.body.error.code, 'egress_start_outcome_unknown');
  assert.equal(lab.count(), 2);
});
