/**
 * Generic media flow integration tests (`docs/flows.md`):
 * CRUD/tenant isolation/redaction, branching to egress + webhook, fan-in,
 * priority/shadowing/disabled/fallback, pending adapters (never faked), room
 * start, edge online (flow join + route hook), schedule tick and dry runs.
 * Egress is a local mock Twirp server and webhooks a local HTTP receiver, so no
 * worker/CDN is required.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyToken } from '@agil/protocol/token';
import { delay, openWs, startTestServer, type TestServer } from './helpers.js';

/** Keep ephemeral ports outside undici's "bad ports" list (e.g. 6000). */
async function startSafeServer(overrides: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = 30000 + randomInt(0, 20000);
    try {
      return await startTestServer({ ...overrides, port });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('could not start test server');
}

const ADMIN = { 'x-api-key': 'dev-key' };
const ACME = { 'x-api-key': 'acme-key' };
const STREAM_KEY = 'flow-super-secret-key';
const RTMP = `rtmp://live.example/app/${STREAM_KEY}`;

let ts: TestServer;
let twirp: Server;
let hooks: Server;
let hookUrl = '';
let hookRequests: Array<{ path: string; body: Record<string, any>; headers: Record<string, string | string[] | undefined> }> = [];
let requests: Array<{ method: string; body: Record<string, any> }> = [];
let failStart = false;
let failList = false;
let startSequence = 0;
let egressItems: Array<Record<string, unknown>> = [];

function startRequests(): Array<{ method: string; body: Record<string, any> }> {
  return requests.filter((entry) => entry.method === 'StartRoomCompositeEgress');
}

function resetRequests(): void {
  requests = [];
  hookRequests = [];
}

async function createFlow(body: Record<string, unknown>, headers = ADMIN) {
  return ts.api('POST', '/v1/admin/flows', { headers, body });
}

async function createRoom(name = `Flow room ${Date.now()}`) {
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return { roomId: created.body.room.id as string, token: created.body.token as string };
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!await fn()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await delay(25);
  }
}

before(async () => {
  twirp = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>;
      const method = (req.url ?? '').split('/').pop() ?? '';
      requests.push({ method, body });
      res.setHeader('content-type', 'application/json');
      if (method === 'StartRoomCompositeEgress') {
        if (failStart) {
          res.statusCode = 500;
          res.end(JSON.stringify({ code: 'internal', msg: 'worker exploded' }));
          return;
        }
        startSequence += 1;
        const egressId = `EG_FLOW_${startSequence}`;
        egressItems.push({ egress_id: egressId, room_name: body.room_name, status: 'EGRESS_ACTIVE' });
        res.end(JSON.stringify({ egress_id: egressId, status: 'EGRESS_STARTING' }));
        return;
      }
      if (method === 'ListEgress') {
        if (failList) {
          res.statusCode = 503;
          res.end(JSON.stringify({ code: 'unavailable', msg: 'could not confirm current jobs' }));
          return;
        }
        res.end(JSON.stringify({
          items: egressItems.filter((item) => body.active ? item.status === 'EGRESS_ACTIVE' : item.room_name === body.room_name),
        }));
        return;
      }
      if (method === 'StopEgress') {
        const job = egressItems.find((item) => item.egress_id === body.egress_id);
        if (job) job.status = 'EGRESS_COMPLETE';
        res.end(JSON.stringify({ egress_id: body.egress_id, status: 'EGRESS_COMPLETE' }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => twirp.listen(0, '127.0.0.1', () => resolve()));
  const twirpUrl = `http://127.0.0.1:${(twirp.address() as AddressInfo).port}`;

  hooks = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, any> = {};
      try {
        body = JSON.parse(raw) as Record<string, any>;
      } catch {
        body = { raw };
      }
      hookRequests.push({ path: req.url ?? '', body, headers: req.headers });
      res.statusCode = (req.url ?? '').includes('fail') ? 500 : 200;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => hooks.listen(0, '127.0.0.1', () => resolve()));
  hookUrl = `http://127.0.0.1:${(hooks.address() as AddressInfo).port}/hook`;

  ts = await startSafeServer({
    egressUrl: twirpUrl,
    egressApiKey: 'egress-key',
    egressApiSecret: 'egress-secret',
    egressEnabled: true,
    tenantSecretEnv: {
      AGIL_ROUTE_SECRET_DEMO_MAIN: RTMP,
      AGIL_ROUTE_SECRET_NOT_SET: '',
    },
  });
});

after(async () => {
  await ts.close();
  await new Promise<void>((resolve) => twirp.close(() => resolve()));
  await new Promise<void>((resolve) => hooks.close(() => resolve()));
});

test('flows CRUD: plan, tenant isolation, secret-free views, patch and audit', async () => {
  resetRequests();
  const created = await createFlow({
    name: 'Hall branch',
    priority: 20,
    sources: [{ kind: 'room', roomId: 'crud-hall' }],
    processors: [{ kind: 'layout', layout: 'speaker' }, { kind: 'audio_mix' }],
    sinks: [
      { kind: 'room', roomId: 'crud-hall', role: 'host' },
      { kind: 'rtmp', url: RTMP, layout: 'grid' },
      { kind: 'hls', layout: 'speaker' },
      { kind: 'recording', audioOnly: false },
      { kind: 'webhook', url: hookUrl, events: ['started', 'failed'] },
    ],
    triggers: [{ kind: 'manual' }, { kind: 'room_start' }],
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const flow = created.body.flow;
  assert.equal(flow.tenantId, 'demo');
  assert.equal(flow.enabled, true);
  assert.equal(flow.priority, 20);
  assert.equal(flow.plan.executable, true, JSON.stringify(flow.plan));
  assert.equal(flow.plan.layout, 'speaker');
  assert.equal(flow.plan.audioMix, true);
  assert.deepEqual(flow.plan.webhookSinkIndexes, [4]);
  assert.equal(flow.sinks[1].urlHost, 'rtmp://live.example/…');
  assert.equal(flow.sinks[1].hasSecret, true);
  assert.equal(flow.sinks[1].url, undefined, 'raw RTMP URL is never returned');
  assert.ok(!JSON.stringify(created.body).includes(STREAM_KEY));

  const listed = await ts.api('GET', '/v1/admin/flows', { headers: ADMIN });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.flows.some((candidate: any) => candidate.id === flow.id));
  assert.ok(!JSON.stringify(listed.body).includes(STREAM_KEY));

  // PATCH: scalars merge; `sinks` replaces the whole list (no positional merge).
  const patched = await ts.api('PATCH', `/v1/admin/flows/${flow.id}`, {
    headers: ADMIN,
    body: { priority: 5, sinks: [{ kind: 'rtmp', url: RTMP, layout: 'speaker' }], triggers: [{ kind: 'manual' }] },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.flow.priority, 5);
  assert.equal(patched.body.flow.sinks.length, 1);
  assert.equal(patched.body.flow.sinks[0].kind, 'rtmp');
  assert.equal(patched.body.flow.sinks[0].layout, 'speaker');
  assert.equal(patched.body.flow.name, 'Hall branch');
  assert.equal(patched.body.flow.triggers.length, 1);
  assert.equal((await ts.api('PATCH', `/v1/admin/flows/${flow.id}`, { headers: ADMIN, body: {} })).status, 400);
  assert.equal((await ts.api('PATCH', `/v1/admin/flows/${flow.id}`, { headers: ADMIN, body: { priority: 1001 } })).status, 400);

  // Tenant isolation: acme cannot read/patch/delete a demo flow.
  const acmeFlow = await createFlow(
    { sources: [{ kind: 'room', roomId: 'acme-room' }], sinks: [{ kind: 'hls' }] },
    ACME,
  );
  assert.equal(acmeFlow.status, 200, JSON.stringify(acmeFlow.body));
  const foreign = acmeFlow.body.flow.id;
  assert.equal((await ts.api('GET', `/v1/admin/flows/${foreign}`, { headers: ADMIN })).status, 404);
  assert.equal((await ts.api('PATCH', `/v1/admin/flows/${foreign}`, { headers: ADMIN, body: { priority: 1 } })).status, 404);
  assert.equal((await ts.api('DELETE', `/v1/admin/flows/${foreign}`, { headers: ADMIN })).status, 404);
  const acmeList = await ts.api('GET', '/v1/admin/flows', { headers: ACME });
  assert.ok(!acmeList.body.flows.some((candidate: any) => candidate.id === flow.id));
  assert.equal((await ts.api('GET', '/v1/admin/flows')).status, 401);

  const audit = await ts.api('GET', '/v1/admin/audit?type=flow.created&limit=100', { headers: ADMIN });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.entries.length > 0);
  assert.ok(!JSON.stringify(audit.body).includes(STREAM_KEY), 'audit never stores the stream key');

  const deleted = await ts.api('DELETE', `/v1/admin/flows/${flow.id}`, { headers: ADMIN });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { deleted: true, id: flow.id });
  assert.equal((await ts.api('GET', `/v1/admin/flows/${flow.id}`, { headers: ADMIN })).status, 404);
  await ts.api('DELETE', `/v1/admin/flows/${foreign}`, { headers: ACME });
});

test('branching: one source → room + rtmp + hls + recording + webhook; dry run starts nothing', async () => {
  resetRequests();
  const room = await createRoom('Branch room');
  const created = await createFlow({
    name: 'Branch',
    sources: [{ kind: 'room', roomId: room.roomId }],
    processors: [{ kind: 'layout', layout: 'speaker' }, { kind: 'audio_mix' }],
    sinks: [
      { kind: 'room', roomId: room.roomId, role: 'host' },
      { kind: 'rtmp', url: RTMP, layout: 'grid' },
      { kind: 'hls', layout: 'speaker' },
      { kind: 'recording', layout: 'grid' },
      { kind: 'webhook', url: hookUrl, events: ['started', 'failed'] },
    ],
    triggers: [{ kind: 'manual' }, { kind: 'room_start' }],
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const flowId = created.body.flow.id as string;

  // Dry run: resolve the plan, start nothing, notify nobody.
  const dry = await ts.api('POST', `/v1/admin/flows/${flowId}/test`, { headers: ADMIN, body: { apply: false } });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.applied, false);
  assert.equal(dry.body.summary.status, 'skipped');
  assert.equal(dry.body.sinks.length, 5);
  assert.ok(dry.body.sinks.every((sink: any) => sink.status === 'skipped'));
  assert.equal(startRequests().length, 0);
  assert.equal(hookRequests.length, 0);

  // Apply: one RTMP job (one encode), one HLS job, one recording job, one webhook.
  const applied = await ts.api('POST', `/v1/admin/flows/${flowId}/test`, { headers: ADMIN, body: {} });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.applied, true);
  assert.equal(applied.body.matched, true);
  assert.equal(applied.body.roomId, room.roomId);
  const rtmp = startRequests().find((entry) => entry.body.stream_outputs);
  assert.ok(rtmp, JSON.stringify(requests.map((entry) => entry.method)));
  assert.equal(rtmp!.body.room_name, `demo__${room.roomId}`);
  assert.deepEqual(rtmp!.body.stream_outputs, [{ protocol: 'RTMP', urls: [RTMP] }]);
  const hls = startRequests().find((entry) => entry.body.segment_outputs);
  assert.ok(hls);
  assert.equal(hls!.body.layout, 'speaker', 'processor layout feeds HLS when the sink has none');
  const recording = startRequests().find((entry) => entry.body.file_outputs);
  assert.ok(recording);
  assert.equal(recording!.body.layout, 'grid');
  assert.equal(hookRequests.length, 1, 'one webhook delivery for the started event');
  assert.equal(hookRequests[0]!.body.type, 'flow.started');
  assert.equal(hookRequests[0]!.body.flowId, flowId);
  assert.equal(hookRequests[0]!.body.roomId, room.roomId);
  const roomSink = applied.body.sinks.find((sink: any) => sink.kind === 'room');
  assert.equal(roomSink.status, 'ready');
  const mediaSinks = applied.body.sinks.filter((sink: any) => sink.kind !== 'webhook' && sink.kind !== 'room');
  assert.ok(mediaSinks.every((sink: any) => sink.status === 'pending'), 'mock worker returns EGRESS_STARTING');
  assert.equal(applied.body.summary.jobs, 3);
  assert.equal(applied.body.summary.status, 'pending');
  assert.ok(!JSON.stringify(applied.body).includes(STREAM_KEY), 'test response is secret-free');

  // Idempotent: the same evaluation starts no duplicate job and re-delivers no webhook twice per run.
  resetRequests();
  const again = await ts.api('POST', `/v1/admin/flows/${flowId}/test`, { headers: ADMIN, body: {} });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(startRequests().length, 0, 'egress jobs are deduplicated per process');
  assert.equal(hookRequests.length, 1, 'each evaluation delivers one webhook');

  const stored = await ts.api('GET', `/v1/admin/flows/${flowId}`, { headers: ADMIN });
  assert.equal(stored.body.flow.lastRun.status, 'started');
  assert.ok(stored.body.flow.lastRun.pending.length === 0);
  assert.ok(!JSON.stringify(stored.body).includes(STREAM_KEY));
  await ts.api('DELETE', `/v1/admin/flows/${flowId}`, { headers: ADMIN });
});

test('a stopped flow job can be started again without duplicate concurrent starts', async () => {
  resetRequests();
  const { roomId, token } = await createRoom();
  const created = await createFlow({
    sources: [{ kind: 'room', roomId }],
    sinks: [{ kind: 'rtmp', url: RTMP }],
  });
  assert.equal(created.status, 200);
  const route = `/v1/admin/flows/${created.body.flow.id}/test`;
  const apply = () => ts.api('POST', route, { headers: ADMIN, body: {} });
  const first = await apply();
  assert.equal(first.status, 200);
  const oldId = first.body.sinks[0].egressId as string;
  assert.ok(oldId);

  const repeatedWhileActive = await apply();
  assert.equal(repeatedWhileActive.body.sinks[0].egressId, oldId);
  assert.equal(repeatedWhileActive.body.sinks[0].status, 'started');
  assert.equal(startRequests().length, 1);
  const oldJob = egressItems.find((item) => item.egress_id === oldId);
  assert.ok(oldJob);
  oldJob.status = 'EGRESS_ENDING';
  assert.equal((await apply()).body.sinks[0].egressId, oldId, 'Do not start while the old job is ending.');
  failList = true;
  try {
    const uncertain = await apply();
    assert.match(uncertain.body.summary.status, /^(failed|unavailable)$/);
    assert.equal(startRequests().length, 1, 'A failed status check must not start a duplicate.');
  } finally {
    failList = false;
  }
  assert.equal((await apply()).body.sinks[0].egressId, oldId, 'Keep tracking the old job after a failed status check.');
  const stopped = await ts.api('POST', `/v1/rooms/${roomId}/egress/${oldId}/stop`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));

  const [firstRestart, repeatedRestart] = await Promise.all([apply(), apply()]);
  assert.equal(firstRestart.status, 200);
  assert.equal(repeatedRestart.status, 200);
  const newId = firstRestart.body.sinks[0].egressId;
  assert.ok(newId);
  assert.notEqual(newId, oldId);
  assert.equal(repeatedRestart.body.sinks[0].egressId, newId);
  assert.equal(startRequests().length, 2);
});

test('fan-in: several same-room sources mix once; cross-room fan-in is pending and starts nothing', async () => {
  resetRequests();
  const room = await createRoom('Fan-in room');
  const sameRoom = await createFlow({
    name: 'Fan-in same room',
    sources: [
      { kind: 'room', roomId: room.roomId },
      { kind: 'edge', edgeId: 'cam-fan' },
    ],
    processors: [{ kind: 'layout', layout: 'grid' }, { kind: 'audio_mix' }],
    sinks: [{ kind: 'hls', layout: 'grid' }],
    triggers: [{ kind: 'manual' }, { kind: 'room_start' }, { kind: 'edge_online' }],
  });
  assert.equal(sameRoom.status, 200, JSON.stringify(sameRoom.body));
  const mixed = await ts.api('POST', `/v1/admin/flows/${sameRoom.body.flow.id}/test`, {
    headers: ADMIN,
    body: { roomId: room.roomId, edgeId: 'cam-fan' },
  });
  assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
  assert.equal(mixed.body.mixer.sourceCount, 2);
  assert.deepEqual(mixed.body.mixer.roomIds, [room.roomId]);
  assert.equal(mixed.body.summary.status, 'pending');
  assert.equal(startRequests().length, 1, 'one composite job for the mixed room');

  // A flow that declares two different rooms cannot be mixed by one composite.
  resetRequests();
  const otherRoom = await createRoom('Fan-in second room');
  const crossRoom = await createFlow({
    name: 'Fan-in cross room',
    sources: [
      { kind: 'room', roomId: room.roomId },
      { kind: 'room', roomId: otherRoom.roomId },
    ],
    sinks: [{ kind: 'hls' }],
    triggers: [{ kind: 'manual' }],
  });
  assert.equal(crossRoom.status, 200, JSON.stringify(crossRoom.body));
  const blocked = await ts.api('POST', `/v1/admin/flows/${crossRoom.body.flow.id}/test`, {
    headers: ADMIN,
    body: { roomId: room.roomId, apply: true },
  });
  assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
  assert.equal(blocked.body.summary.status, 'pending');
  assert.equal(blocked.body.summary.code, 'source_pending');
  assert.equal(blocked.body.summary.jobs, 0);
  assert.equal(startRequests().length, 0, 'nothing is started for an un-mixable flow');
  assert.ok(blocked.body.summary.pending.some((entry: any) => /different rooms|mixer/i.test(entry.reason)));
  await ts.api('DELETE', `/v1/admin/flows/${sameRoom.body.flow.id}`, { headers: ADMIN });
  await ts.api('DELETE', `/v1/admin/flows/${crossRoom.body.flow.id}`, { headers: ADMIN });
});

test('pending adapters are reported, never faked (transcode/srt/cdn/participant)', async () => {
  resetRequests();
  const room = await createRoom('Pending room');
  const created = await createFlow({
    name: 'Pending mix',
    sources: [
      { kind: 'room', roomId: room.roomId },
      { kind: 'participant', tag: 'panel' },
    ],
    processors: [{ kind: 'layout', layout: 'grid' }, { kind: 'transcode', profile: 'h264_720p30' }],
    sinks: [
      { kind: 'hls' },
      { kind: 'srt', url: 'srt://srt.example:9000?streamid=secret' },
      { kind: 'cdn', provider: 's3', bucket: 'videos' },
    ],
    triggers: [{ kind: 'manual' }],
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const flow = created.body.flow;
  assert.equal(flow.plan.executable, false);
  const pendingKinds = flow.plan.pending.map((entry: any) => entry.kind).sort();
  assert.deepEqual(pendingKinds, ['cdn', 'participant', 'srt', 'transcode']);
  const tested = await ts.api('POST', `/v1/admin/flows/${flow.id}/test`, {
    headers: ADMIN,
    body: { roomId: room.roomId },
  });
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.equal(tested.body.summary.status, 'pending');
  assert.equal(tested.body.summary.code, 'source_pending');
  assert.equal(tested.body.summary.jobs, 0);
  assert.equal(startRequests().length, 0, 'a pending source/processor starts nothing');
  for (const sink of tested.body.sinks) {
    assert.equal(sink.status, 'pending');
    assert.ok(sink.pendingReason, `sink ${sink.kind} carries a pending reason`);
  }
  const status = await ts.api('GET', `/v1/admin/flows/${flow.id}/status`, { headers: ADMIN });
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.status.plan.executable, false);
  assert.deepEqual(status.body.status.triggers, [{ kind: 'manual', supported: true }]);
  await ts.api('DELETE', `/v1/admin/flows/${flow.id}`, { headers: ADMIN });
});

test('external ingest remains pending even when the flow also has a room source', async () => {
  resetRequests();
  const room = await createRoom('External ingest room');
  const sources = [
    { kind: 'rtmp_ingest', url: 'rtmps://ingest.example/live/key' },
    { kind: 'srt_ingest', url: 'srt://ingest.example:9000' },
    { kind: 'hls_ingest', url: 'https://ingest.example/live/index.m3u8' },
  ];
  for (const source of sources) {
    const created = await createFlow({
      name: `External ${source.kind}`,
      sources: [{ kind: 'room', roomId: room.roomId }, source],
      sinks: [{ kind: 'hls' }],
      triggers: [{ kind: 'manual' }],
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const { id, plan } = created.body.flow;
    try {
      assert.equal(plan.executable, false, source.kind);
      assert.deepEqual(plan.pending.map((entry: { kind: string }) => entry.kind), [source.kind]);
      const run = await ts.api('POST', `/v1/admin/flows/${id}/test`, {
        headers: ADMIN,
        body: { roomId: room.roomId, apply: true },
      });
      assert.equal(run.status, 200, JSON.stringify(run.body));
      assert.equal(run.body.applied, true, source.kind);
      assert.equal(run.body.summary.status, 'pending', source.kind);
      assert.equal(run.body.summary.code, 'source_pending', source.kind);
      assert.equal(run.body.summary.jobs, 0, source.kind);
      assert.equal(startRequests().length, 0, source.kind);
    } finally {
      await ts.api('DELETE', `/v1/admin/flows/${id}`, { headers: ADMIN });
    }
  }
});

test('priority, disabled and shadowing across flows; fallback runs when the primary cannot deliver', async () => {
  resetRequests();
  const room = await createRoom('Priority room');
  const high = await createFlow({
    name: 'High',
    priority: 10,
    sources: [{ kind: 'room', roomId: room.roomId }],
    sinks: [{ kind: 'hls' }],
    triggers: [{ kind: 'manual' }, { kind: 'room_start' }],
  });
  const low = await createFlow({
    name: 'Low',
    priority: 500,
    sources: [{ kind: 'room', roomId: room.roomId }],
    sinks: [{ kind: 'hls' }],
    triggers: [{ kind: 'manual' }, { kind: 'room_start' }],
  });
  assert.equal(high.status, 200, JSON.stringify(high.body));
  assert.equal(low.status, 200, JSON.stringify(low.body));
  const shadowed = await ts.api('POST', `/v1/admin/flows/${low.body.flow.id}/test`, {
    headers: ADMIN,
    body: { trigger: 'room_start', roomId: room.roomId, apply: false },
  });
  assert.equal(shadowed.status, 200, JSON.stringify(shadowed.body));
  assert.equal(shadowed.body.matched, false);
  assert.equal(shadowed.body.shadowedBy, high.body.flow.id);
  assert.equal(startRequests().length, 0);

  // Disabled flow is reported, not applied.
  const disabled = await ts.api('PATCH', `/v1/admin/flows/${high.body.flow.id}`, { headers: ADMIN, body: { enabled: false } });
  assert.equal(disabled.status, 200);
  const disabledTest = await ts.api('POST', `/v1/admin/flows/${high.body.flow.id}/test`, { headers: ADMIN, body: {} });
  assert.equal(disabledTest.status, 200);
  assert.equal(disabledTest.body.disabled, true);
  assert.equal(disabledTest.body.matched, false);

  // Fallback: the primary's RTMP secret is missing → unavailable → the fallback runs.
  const primary = await createFlow({
    name: 'Primary (missing secret)',
    priority: 1,
    sources: [{ kind: 'room', roomId: room.roomId }],
    sinks: [{ kind: 'rtmp', secretRef: 'AGIL_ROUTE_SECRET_NOT_SET' }],
    triggers: [{ kind: 'manual' }],
  });
  assert.equal(primary.status, 200, JSON.stringify(primary.body));
  const fallback = await createFlow({
    name: 'Fallback (hls)',
    priority: 900,
    sources: [{ kind: 'room', roomId: room.roomId }],
    sinks: [{ kind: 'hls' }],
    triggers: [{ kind: 'manual' }],
  });
  assert.equal(fallback.status, 200, JSON.stringify(fallback.body));
  const linked = await ts.api('PATCH', `/v1/admin/flows/${primary.body.flow.id}`, {
    headers: ADMIN,
    body: { fallbackFlowId: fallback.body.flow.id },
  });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  // Unknown fallback and self-fallback are rejected.
  assert.equal(
    (await ts.api('PATCH', `/v1/admin/flows/${fallback.body.flow.id}`, { headers: ADMIN, body: { fallbackFlowId: 'fl_missing' } })).status,
    400,
  );
  assert.equal(
    (await ts.api('PATCH', `/v1/admin/flows/${fallback.body.flow.id}`, { headers: ADMIN, body: { fallbackFlowId: fallback.body.flow.id } })).status,
    400,
  );
  resetRequests();
  const tested = await ts.api('POST', `/v1/admin/flows/${primary.body.flow.id}/test`, {
    headers: ADMIN,
    body: { roomId: room.roomId },
  });
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.equal(tested.body.fallbackOf, primary.body.flow.id);
  assert.equal(tested.body.summary.status, 'pending');
  assert.equal(startRequests().length, 1, 'only the fallback started egress');
  assert.equal(startRequests()[0]!.body.segment_outputs[0].protocol, 'HLS_PROTOCOL');
  const fallbackStored = await ts.api('GET', `/v1/admin/flows/${fallback.body.flow.id}`, { headers: ADMIN });
  assert.equal(fallbackStored.body.flow.lastRun.trigger, 'manual');
  assert.equal(fallbackStored.body.flow.lastRun.status, 'pending');
  // The primary's failure is stored on the primary too.
  const primaryStored = await ts.api('GET', `/v1/admin/flows/${primary.body.flow.id}`, { headers: ADMIN });
  assert.equal(primaryStored.body.flow.lastRun.status, 'unavailable');
  assert.ok(!JSON.stringify(primaryStored.body).includes(STREAM_KEY));

  for (const id of [high.body.flow.id, low.body.flow.id, primary.body.flow.id, fallback.body.flow.id]) {
    await ts.api('DELETE', `/v1/admin/flows/${id}`, { headers: ADMIN });
  }
});

test('room_start: first participant starts the flow; disabled flow does nothing', async () => {
  resetRequests();
  const room = await createRoom('Room start flow');
  const created = await createFlow({
    name: 'Room start',
    sources: [{ kind: 'room', roomId: room.roomId }],
    sinks: [{ kind: 'hls', layout: 'speaker' }],
    triggers: [{ kind: 'room_start' }],
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const flowId = created.body.flow.id as string;
  const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(room.token)}`);
  await client.waitFor((message) => message.type === 'welcome');
  await waitFor(() => startRequests().length === 1);
  assert.equal(startRequests()[0]!.body.room_name, `demo__${room.roomId}`);
  await waitFor(async () => {
    const lastRun = (await ts.server.flows.getFlow('demo', flowId))?.lastRun;
    return lastRun?.trigger === 'room_start' && lastRun?.status === 'pending';
  });
  // Re-evaluation on a second participant does not start a duplicate job.
  const guest = await ts.api('POST', `/v1/rooms/${room.roomId}/join`, { body: { name: 'Guest' } });
  assert.equal(guest.status, 200, JSON.stringify(guest.body));
  const guestWs = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(guest.body.token)}`);
  await guestWs.waitFor((message) => message.type === 'welcome');
  await delay(150);
  assert.equal(startRequests().length, 1);
  await client.close();
  await guestWs.close();
  await ts.api('DELETE', `/v1/admin/flows/${flowId}`, { headers: ADMIN });
});

test('edge online: a flow-only tenant can enroll and join; the joined room feeds the flow', async () => {
  resetRequests();
  const flow = await createFlow({
    name: 'Edge flow',
    sources: [{ kind: 'edge', edgeId: 'cam-flow' }],
    sinks: [
      { kind: 'room', roomId: 'flow-edge-room', role: 'host' },
      { kind: 'hls' },
    ],
    triggers: [{ kind: 'manual' }, { kind: 'edge_online' }],
  });
  assert.equal(flow.status, 200, JSON.stringify(flow.body));
  // The flow surface exposes Edge enrollment tokens under its own alias.
  const issued = await ts.api('POST', '/v1/admin/flows/edge-tokens', {
    headers: ADMIN,
    body: { edgeId: 'cam-flow', name: 'Flow camera' },
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const joined = await ts.api('POST', '/v1/edge/join', { body: { token: issued.body.token } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.flowId, flow.body.flow.id);
  assert.equal(joined.body.routeId, flow.body.flow.id);
  assert.equal(joined.body.roomId, 'flow-edge-room');
  assert.equal(joined.body.publisher.role, 'host');
  const claims = verifyToken(joined.body.joinToken, ts.server.env.tokenSecret);
  assert.equal(claims.valid, true);
  if (claims.valid) assert.equal(claims.claims.roomId, 'flow-edge-room');
  assert.equal(joined.body.egress.status, 'pending');
  assert.equal(startRequests().length, 1, 'the flow HLS sink starts egress from the joined room');
  assert.equal(startRequests()[0]!.body.room_name, 'demo__flow-edge-room');
  assert.ok(!JSON.stringify(joined.body).includes(STREAM_KEY));
  const stored = await ts.api('GET', `/v1/admin/flows/${flow.body.flow.id}`, { headers: ADMIN });
  assert.equal(stored.body.flow.lastRun.trigger, 'edge_online');
  assert.equal(stored.body.flow.lastRun.status, 'pending');
  await ts.api('DELETE', `/v1/admin/flows/${flow.body.flow.id}`, { headers: ADMIN });
});

test('edge online hook: a route-joined Edge also triggers its edge_online flow', async () => {
  resetRequests();
  const route = await ts.api('POST', '/v1/admin/routes', {
    headers: ADMIN,
    body: {
      source: { type: 'edge', edgeId: 'cam-hook' },
      destinations: [{ type: 'room', roomId: 'hook-room', role: 'host' }],
    },
  });
  assert.equal(route.status, 200, JSON.stringify(route.body));
  const flow = await createFlow({
    name: 'Recording hook',
    sources: [{ kind: 'edge', edgeId: 'cam-hook' }],
    sinks: [{ kind: 'recording', layout: 'grid', audioOnly: false }],
    triggers: [{ kind: 'edge_online' }],
  });
  assert.equal(flow.status, 200, JSON.stringify(flow.body));
  const issued = await ts.api('POST', '/v1/admin/routes/edge-tokens', { headers: ADMIN, body: { edgeId: 'cam-hook' } });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const joined = await ts.api('POST', '/v1/edge/join', { body: { token: issued.body.token } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.routeId, route.body.route.id, 'the legacy route resolved the join');
  assert.equal(joined.body.flowId, undefined);
  // The flow is triggered asynchronously by the edge-online hook.
  await waitFor(() => startRequests().some((entry) => entry.body.file_outputs));
  const recording = startRequests().find((entry) => entry.body.file_outputs)!;
  assert.equal(recording.body.room_name, 'demo__hook-room');
  await waitFor(async () => (await ts.server.flows.getFlow('demo', flow.body.flow.id))?.lastRun?.trigger === 'edge_online');
  await ts.api('DELETE', `/v1/admin/flows/${flow.body.flow.id}`, { headers: ADMIN });
  await ts.api('DELETE', `/v1/admin/routes/${route.body.route.id}`, { headers: ADMIN });
});

test('edge online hook: the joined room wins; a different room sink is a pending forward', async () => {
  resetRequests();
  const route = await ts.api('POST', '/v1/admin/routes', {
    headers: ADMIN,
    body: {
      source: { type: 'edge', edgeId: 'cam-forward' },
      destinations: [{ type: 'room', roomId: 'forward-join-room', role: 'host' }],
    },
  });
  assert.equal(route.status, 200, JSON.stringify(route.body));
  const flow = await createFlow({
    name: 'Forward branch',
    sources: [{ kind: 'edge', edgeId: 'cam-forward' }],
    sinks: [
      { kind: 'room', roomId: 'forward-other-room' },
      { kind: 'hls' },
    ],
    triggers: [{ kind: 'edge_online' }],
  });
  assert.equal(flow.status, 200, JSON.stringify(flow.body));
  const issued = await ts.api('POST', '/v1/admin/routes/edge-tokens', { headers: ADMIN, body: { edgeId: 'cam-forward' } });
  const joined = await ts.api('POST', '/v1/edge/join', { body: { token: issued.body.token } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  await waitFor(() => startRequests().some((entry) => entry.body.segment_outputs));
  const hls = startRequests().find((entry) => entry.body.segment_outputs)!;
  assert.equal(hls.body.room_name, 'demo__forward-join-room', 'egress derives from the room the Edge actually joined');
  await waitFor(async () => Boolean((await ts.server.flows.getFlow('demo', flow.body.flow.id))?.lastRun));
  const stored = (await ts.server.flows.getFlow('demo', flow.body.flow.id))!;
  const roomSink = stored.lastRun?.jobs.find((job) => job.kind === 'room');
  assert.equal(roomSink?.status, 'pending');
  assert.match(String(roomSink?.pendingReason), /another room|forwarding/i);
  assert.equal(stored.lastRun?.status, 'pending');
  await ts.api('DELETE', `/v1/admin/flows/${flow.body.flow.id}`, { headers: ADMIN });
  await ts.api('DELETE', `/v1/admin/routes/${route.body.route.id}`, { headers: ADMIN });
});

test('edge online flow with a pending adapter answers 409 flow_pending (no fake join)', async () => {
  resetRequests();
  const flow = await createFlow({
    name: 'Transcoded edge',
    sources: [{ kind: 'edge', edgeId: 'cam-transcode' }],
    processors: [{ kind: 'transcode', profile: 'h264_1080p30' }],
    sinks: [{ kind: 'room', roomId: 'transcode-room' }],
    triggers: [{ kind: 'edge_online' }],
  });
  assert.equal(flow.status, 200, JSON.stringify(flow.body));
  const issued = await ts.api('POST', '/v1/admin/flows/edge-tokens', {
    headers: ADMIN,
    body: { edgeId: 'cam-transcode' },
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const joined = await ts.api('POST', '/v1/edge/join', { body: { token: issued.body.token } });
  assert.equal(joined.status, 409, JSON.stringify(joined.body));
  assert.equal(joined.body.error.code, 'flow_pending');
  assert.match(String(joined.body.error.message), /transcode|pending/i);
  assert.equal(startRequests().length, 0);
  await ts.api('DELETE', `/v1/admin/flows/${flow.body.flow.id}`, { headers: ADMIN });
});

test('schedule: due flow evaluates only with an active room; tick is idempotent', async () => {
  resetRequests();
  const room = await createRoom('Scheduled room');
  const flow = await createFlow({
    name: 'Scheduled',
    sources: [{ kind: 'room', roomId: room.roomId }],
    sinks: [{ kind: 'hls' }],
    triggers: [{ kind: 'schedule', at: Date.now() - 60_000 }],
  });
  assert.equal(flow.status, 200, JSON.stringify(flow.body));
  const flowId = flow.body.flow.id as string;
  // Room exists but has no participants → skipped, no egress.
  const emptyTick = await ts.api('POST', '/v1/admin/flows/tick', { headers: ADMIN });
  assert.equal(emptyTick.status, 200, JSON.stringify(emptyTick.body));
  assert.deepEqual(emptyTick.body.due, [flowId]);
  assert.deepEqual(emptyTick.body.evaluated, []);
  assert.match(String(emptyTick.body.skipped[0]?.reason), /no participants/);
  assert.equal(startRequests().length, 0);
  const status = await ts.api('GET', `/v1/admin/flows/${flowId}/status`, { headers: ADMIN });
  assert.equal(status.body.status.lastFiredAt !== undefined, true);

  // A second occurrence: reset lastFiredAt via PATCH of triggers (future at) then a new active room.
  const activeRoom = await createRoom('Scheduled active room');
  const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(activeRoom.token)}`);
  await client.waitFor((message) => message.type === 'welcome');
  resetRequests();
  const active = await createFlow({
    name: 'Scheduled active',
    sources: [{ kind: 'room', roomId: activeRoom.roomId }],
    sinks: [{ kind: 'hls' }],
    triggers: [{ kind: 'schedule', everySec: 30 }],
  });
  assert.equal(active.status, 200, JSON.stringify(active.body));
  // everySec=30 from creation: not due immediately.
  const notDue = await ts.api('POST', '/v1/admin/flows/tick', { headers: ADMIN });
  assert.deepEqual(notDue.body.evaluated, []);
  assert.equal(notDue.body.due.includes(active.body.flow.id), false);
  await client.close();

  // Force the schedule due by rewriting it to an instant in the past.
  const patched = await ts.api('PATCH', `/v1/admin/flows/${active.body.flow.id}`, {
    headers: ADMIN,
    body: { triggers: [{ kind: 'schedule', at: Date.now() - 1_000 }] },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const dueTick = await ts.api('POST', '/v1/admin/flows/tick', { headers: ADMIN });
  assert.equal(dueTick.status, 200, JSON.stringify(dueTick.body));
  assert.ok(dueTick.body.due.includes(active.body.flow.id));
  // The room has no participants now (WS closed) → skipped.
  assert.match(String(dueTick.body.skipped.find((entry: any) => entry.flowId === active.body.flow.id)?.reason), /no participants/);
  for (const id of [flowId, active.body.flow.id]) {
    await ts.api('DELETE', `/v1/admin/flows/${id}`, { headers: ADMIN });
  }
});

test('webhook failure is reported per sink and degrades the run to partial', async () => {
  resetRequests();
  const room = await createRoom('Webhook fail room');
  const failUrl = hookUrl.replace('/hook', '/fail-hook');
  const created = await createFlow({
    name: 'Webhook failure',
    sources: [{ kind: 'room', roomId: room.roomId }],
    sinks: [
      { kind: 'hls' },
      { kind: 'webhook', url: failUrl, events: ['started'] },
    ],
    triggers: [{ kind: 'manual' }],
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const tested = await ts.api('POST', `/v1/admin/flows/${created.body.flow.id}/test`, {
    headers: ADMIN,
    body: { roomId: room.roomId },
  });
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  const webhook = tested.body.sinks.find((sink: any) => sink.kind === 'webhook');
  assert.equal(webhook.status, 'failed');
  assert.equal(webhook.delivery, 'failed');
  assert.match(String(webhook.error), /HTTP 500/);
  assert.equal(tested.body.summary.status, 'partial');
  assert.equal(tested.body.summary.code, 'webhook_failed');
  assert.equal(hookRequests.length, 1);
  await ts.api('DELETE', `/v1/admin/flows/${created.body.flow.id}`, { headers: ADMIN });
});

test('SSRF/secret policy: unsafe endpoints and bad fallback are rejected', async () => {
  const invalid: Array<{ label: string; body: Record<string, unknown> }> = [
    {
      label: 'private rtmp host',
      body: { sources: [{ kind: 'room', roomId: 'ssrf-room' }], sinks: [{ kind: 'rtmp', url: 'rtmp://10.1.2.3/app/key' }] },
    },
    {
      label: 'plaintext http rtmp',
      body: { sources: [{ kind: 'room', roomId: 'ssrf-room' }], sinks: [{ kind: 'rtmp', url: 'http://live.example/app/key' }] },
    },
    {
      label: 'webhook to metadata',
      body: {
        sources: [{ kind: 'room', roomId: 'ssrf-room' }],
        sinks: [{ kind: 'webhook', url: 'http://metadata.google.internal/hook' }],
      },
    },
    {
      label: 'foreign secret namespace',
      body: { sources: [{ kind: 'room', roomId: 'ssrf-room' }], sinks: [{ kind: 'rtmp', secretRef: 'AGIL_SFU_KEY' }] },
    },
    {
      label: 'webhook with credentials in url',
      body: {
        sources: [{ kind: 'room', roomId: 'ssrf-room' }],
        sinks: [{ kind: 'webhook', url: 'http://user:pass@hooks.example/x' }],
      },
    },
    {
      label: 'room_start without room source',
      body: {
        sources: [{ kind: 'edge', edgeId: 'cam-x' }],
        sinks: [{ kind: 'room', roomId: 'ssrf-room' }],
        triggers: [{ kind: 'room_start' }],
      },
    },
  ];
  for (const entry of invalid) {
    const response = await createFlow(entry.body);
    assert.equal(response.status, 400, `${entry.label}: expected 400, got ${response.status} ${JSON.stringify(response.body)}`);
  }
  // A secretRef in the route namespace is accepted and stays server-side.
  const valid = await createFlow({
    sources: [{ kind: 'room', roomId: 'ssrf-room' }],
    sinks: [{ kind: 'rtmp', secretRef: 'AGIL_ROUTE_SECRET_DEMO_MAIN' }],
    triggers: [{ kind: 'manual' }],
  });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
  assert.equal(valid.body.flow.sinks[0].secretRef, 'AGIL_ROUTE_SECRET_DEMO_MAIN');
  assert.ok(!JSON.stringify(valid.body).includes(STREAM_KEY));
  await ts.api('DELETE', `/v1/admin/flows/${valid.body.flow.id}`, { headers: ADMIN });
});
