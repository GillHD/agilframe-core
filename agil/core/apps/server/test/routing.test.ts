/**
 * Routing baseline integration tests (docs/routing.md):
 * admin CRUD + tenant isolation, Edge enrollment/join, Edge→room+stream
 * expansion, room→stream on first join, priority/disabled selection,
 * idempotency, egress failures and secret redaction. Egress is a local mock
 * Twirp server, so no worker/CDN is needed.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyToken } from '@agil/protocol/token';
import { delay, openWs, startTestServer, type TestServer } from './helpers.js';

/**
 * `fetch` (undici) refuses to connect to a list of "bad ports" (e.g. 6000), and
 * an ephemeral port may land on one. Pin a random high port outside that list.
 */
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
const STREAM_KEY = 'route-super-secret-key';
const RTMP = `rtmp://live.example/app/${STREAM_KEY}`;

let ts: TestServer;
let disabledTs: TestServer;
let twirp: Server;
let requests: Array<{ method: string; body: Record<string, any> }> = [];
let failStart = false;
let startSequence = 0;
let egressItems: Array<Record<string, unknown>> = [];

function startRequests(): Array<{ method: string; body: Record<string, any> }> {
  return requests.filter((entry) => entry.method === 'StartRoomCompositeEgress');
}

function resetRequests(): void {
  requests = [];
}

async function createRoute(body: Record<string, unknown>, headers = ADMIN) {
  return ts.api('POST', '/v1/admin/routes', { headers, body });
}

async function createRoom(name = `Route room ${Date.now()}`) {
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return { roomId: created.body.room.id as string, token: created.body.token as string };
}

async function issueEdgeToken(body: Record<string, unknown> = {}) {
  const issued = await ts.api('POST', '/v1/admin/routes/edge-tokens', { headers: ADMIN, body });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  return issued.body;
}

async function edgeJoin(body: Record<string, unknown>) {
  return ts.api('POST', '/v1/edge/join', { body });
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!fn()) {
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
          res.end(JSON.stringify({ code: 'internal', msg: `worker exploded for ${String(body.stream_outputs?.[0]?.urls?.[0] ?? '')}` }));
          return;
        }
        startSequence += 1;
        const egressId = `EG_ROUTE_${startSequence}`;
        egressItems = [{ egress_id: egressId, room_name: body.room_name, status: 'EGRESS_ACTIVE' }];
        res.end(JSON.stringify({ egress_id: egressId, status: 'EGRESS_STARTING' }));
        return;
      }
      if (method === 'ListEgress') {
        res.end(JSON.stringify({ items: body.active ? egressItems : egressItems.filter((item) => item.room_name === body.room_name) }));
        return;
      }
      if (method === 'StopEgress') {
        res.end(JSON.stringify({ egress_id: body.egress_id, status: 'EGRESS_COMPLETE' }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => twirp.listen(0, '127.0.0.1', () => resolve()));
  const twirpUrl = `http://127.0.0.1:${(twirp.address() as AddressInfo).port}`;
  ts = await startSafeServer({
    egressUrl: twirpUrl,
    egressApiKey: 'egress-key',
    egressApiSecret: 'egress-secret',
    egressEnabled: true,
    tenantSecretEnv: {
      AGIL_ROUTE_SECRET_DEMO_MAIN: RTMP,
      AGIL_ROUTE_SECRET_DEMO_MISSING: '',
    },
  });
  disabledTs = await startSafeServer({ egressEnabled: false });
});

after(async () => {
  await ts.close();
  await disabledTs.close();
  await new Promise<void>((resolve) => twirp.close(() => resolve()));
});

test('admin CRUD: deep-partial patch, tenant isolation, secret-free responses and audit', async () => {
  resetRequests();
  const created = await createRoute({
    name: 'Hall broadcast',
    source: { type: 'edge', edgeId: 'cam-hall' },
    destinations: [
      { type: 'room', roomId: 'hall-main', role: 'host' },
      { type: 'stream', provider: 'rtmp', url: RTMP, layout: 'grid' },
    ],
    priority: 20,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const route = created.body.route;
  assert.equal(route.priority, 20);
  assert.equal(route.enabled, true);
  assert.equal(route.tenantId, 'demo');
  const streamView = route.destinations.find((destination: any) => destination.type === 'stream');
  assert.equal(streamView.urlHost, 'rtmp://live.example/…');
  assert.equal(streamView.hasSecret, true);
  assert.equal(streamView.url, undefined, 'raw RTMP URL is never returned');
  assert.ok(!JSON.stringify(created.body).includes(STREAM_KEY));

  const listed = await ts.api('GET', '/v1/admin/routes', { headers: ADMIN });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.routes.some((candidate: any) => candidate.id === route.id));
  const listedText = JSON.stringify(listed.body);
  assert.ok(!listedText.includes(STREAM_KEY), 'list response is secret-free');

  // Deep-partial PATCH: only priority + nested destination layout change.
  const patched = await ts.api('PATCH', `/v1/admin/routes/${route.id}`, {
    headers: ADMIN,
    body: { priority: 5, destinations: [{}, { layout: 'speaker' }] },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.route.priority, 5);
  assert.equal(patched.body.route.name, 'Hall broadcast');
  assert.equal(patched.body.route.destinations[0].roomId, 'hall-main');
  assert.equal(patched.body.route.destinations[1].layout, 'speaker');
  assert.ok(patched.body.route.destinations[1].hasSecret, 'the stored credential survives a patch');

  // Empty patch and invalid priority are rejected.
  assert.equal((await ts.api('PATCH', `/v1/admin/routes/${route.id}`, { headers: ADMIN, body: {} })).status, 400);
  assert.equal(
    (await ts.api('PATCH', `/v1/admin/routes/${route.id}`, { headers: ADMIN, body: { priority: 1001 } })).status,
    400,
  );

  // Tenant isolation: another tenant cannot read/patch/delete this route.
  const acmeRoute = await createRoute(
    { source: { type: 'room', roomId: 'acme-room' }, destinations: [{ type: 'stream', provider: 'hls' }] },
    ACME,
  );
  assert.equal(acmeRoute.status, 200, JSON.stringify(acmeRoute.body));
  const foreign = acmeRoute.body.route.id;
  assert.equal((await ts.api('GET', `/v1/admin/routes/${foreign}`, { headers: ADMIN })).status, 404);
  assert.equal((await ts.api('PATCH', `/v1/admin/routes/${foreign}`, { headers: ADMIN, body: { priority: 1 } })).status, 404);
  assert.equal((await ts.api('DELETE', `/v1/admin/routes/${foreign}`, { headers: ADMIN })).status, 404);
  const acmeList = await ts.api('GET', '/v1/admin/routes', { headers: ACME });
  assert.ok(!acmeList.body.routes.some((candidate: any) => candidate.id === route.id));

  // No credential = 401.
  assert.equal((await ts.api('GET', '/v1/admin/routes')).status, 401);

  const audit = await ts.api('GET', '/v1/admin/audit?type=route.created&limit=100', { headers: ADMIN });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.entries.length > 0);
  const auditText = JSON.stringify(audit.body);
  assert.ok(!auditText.includes(STREAM_KEY), 'audit never stores the stream key');
  assert.ok(auditText.includes('rtmp://live.example/…'), 'audit stores the redacted host');

  const deleted = await ts.api('DELETE', `/v1/admin/routes/${route.id}`, { headers: ADMIN });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { deleted: true, id: route.id });
  assert.equal((await ts.api('GET', `/v1/admin/routes/${route.id}`, { headers: ADMIN })).status, 404);
  await ts.api('DELETE', `/v1/admin/routes/${foreign}`, { headers: ACME });
});

test('validation: SSRF/secret policy and rule shape', async () => {
  const base = { source: { type: 'room', roomId: 'validate-room' } };
  const cases: Array<{ label: string; body: Record<string, unknown> }> = [
    { label: 'plaintext http rtmp', body: { ...base, destinations: [{ type: 'stream', provider: 'rtmp', url: 'http://live.example/app/key' }] } },
    { label: 'private RTC host', body: { ...base, destinations: [{ type: 'stream', provider: 'rtmp', url: 'rtmp://10.1.2.3/app/key' }] } },
    { label: 'credentials in URL', body: { ...base, destinations: [{ type: 'stream', provider: 'rtmp', url: 'rtmp://user:pass@live.example/app/key' }] } },
    { label: 'bad secret namespace', body: { ...base, destinations: [{ type: 'stream', provider: 'rtmp', secretRef: 'AGIL_WEBHOOK_SECRET' }] } },
    { label: 'two room destinations', body: { ...base, destinations: [{ type: 'room', roomId: 'a' }, { type: 'room', roomId: 'b' }] } },
    { label: 'room source without roomId', body: { source: { type: 'room' }, destinations: [{ type: 'stream', provider: 'hls' }] } },
    { label: 'hls with url', body: { ...base, destinations: [{ type: 'stream', provider: 'hls', url: 'https://cdn.example/live.m3u8' }] } },
  ];
  for (const entry of cases) {
    const response = await createRoute(entry.body);
    assert.equal(response.status, 400, `${entry.label}: expected 400, got ${response.status} ${JSON.stringify(response.body)}`);
  }
  // A valid secretRef rule is accepted (the value stays server-side).
  const secretRoute = await createRoute({
    source: { type: 'room', roomId: 'validate-room' },
    destinations: [{ type: 'stream', provider: 'rtmp', secretRef: 'AGIL_ROUTE_SECRET_DEMO_MAIN' }],
  });
  assert.equal(secretRoute.status, 200, JSON.stringify(secretRoute.body));
  const view = secretRoute.body.route.destinations[0];
  assert.equal(view.secretRef, 'AGIL_ROUTE_SECRET_DEMO_MAIN');
  assert.equal(view.hasSecret, true);
  assert.ok(!JSON.stringify(secretRoute.body).includes(STREAM_KEY));
  await ts.api('DELETE', `/v1/admin/routes/${secretRoute.body.route.id}`, { headers: ADMIN });
});

test('Edge join: enrollment token, priority selection, disabled fallback and room/stream destinations', async () => {
  resetRequests();
  const high = await createRoute({
    name: 'High priority',
    priority: 10,
    source: { type: 'edge', edgeId: 'cam-priority' },
    destinations: [
      { type: 'room', roomId: 'priority-high', role: 'host' },
      { type: 'stream', provider: 'rtmp', url: RTMP },
    ],
  });
  assert.equal(high.status, 200, JSON.stringify(high.body));
  const low = await createRoute({
    name: 'Low priority',
    priority: 500,
    source: { type: 'edge', edgeId: 'cam-priority' },
    destinations: [{ type: 'room', roomId: 'priority-low' }],
  });
  assert.equal(low.status, 200, JSON.stringify(low.body));

  const issued = await issueEdgeToken({ edgeId: 'cam-priority', name: 'Hall camera' });
  assert.ok(issued.token.startsWith('agil_edge_'));
  assert.equal(issued.enrollment.edgeId, 'cam-priority');
  const tokenList = await ts.api('GET', '/v1/admin/routes/edge-tokens', { headers: ADMIN });
  assert.equal(tokenList.status, 200);
  assert.ok(!JSON.stringify(tokenList.body).includes(issued.token), 'plaintext token is never listed');
  assert.ok(!JSON.stringify(tokenList.body).includes('hash'), 'token hash is never listed');

  const joined = await edgeJoin({ token: issued.token });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.publishTarget, 'room');
  assert.equal(joined.body.roomId, 'priority-high');
  assert.equal(joined.body.routeId, high.body.route.id);
  assert.equal(joined.body.publisher.role, 'host');
  const roomDestination = joined.body.destinations.find((destination: any) => destination.type === 'room');
  assert.equal(roomDestination.status, 'ready');
  const streamDestination = joined.body.destinations.find((destination: any) => destination.type === 'stream');
  assert.equal(streamDestination.status, 'pending');
  assert.equal(streamDestination.urlHost, 'rtmp://live.example/…');
  assert.ok(!JSON.stringify(joined.body).includes(STREAM_KEY), 'join response is secret-free');

  // The join token is a normal room token for the resolved room.
  const claims = verifyToken(joined.body.joinToken, ts.server.env.tokenSecret);
  assert.equal(claims.valid, true);
  if (claims.valid) {
    assert.equal(claims.claims.tenantId, 'demo');
    assert.equal(claims.claims.roomId, 'priority-high');
    assert.equal(claims.claims.role, 'host');
  }
  // Egress was started from the routed room (one publish target for the Edge).
  const starts = startRequests();
  assert.equal(starts.length, 1, JSON.stringify(starts.map((entry) => entry.body)));
  assert.equal(starts[0]!.body.room_name, 'demo__priority-high');
  assert.deepEqual(starts[0]!.body.stream_outputs, [{ protocol: 'RTMP', urls: [RTMP] }]);

  // One-time token: the same token cannot be redeemed twice.
  const reused = await edgeJoin({ token: issued.token });
  assert.equal(reused.status, 401);
  assert.equal(reused.body.error.code, 'unauthorized');

  // Disable the high-priority rule: the lower-priority rule wins.
  resetRequests();
  const disabled = await ts.api('PATCH', `/v1/admin/routes/${high.body.route.id}`, { headers: ADMIN, body: { enabled: false } });
  assert.equal(disabled.status, 200);
  const secondToken = await issueEdgeToken({ edgeId: 'cam-priority' });
  const secondJoin = await edgeJoin({ token: secondToken.token });
  assert.equal(secondJoin.status, 200, JSON.stringify(secondJoin.body));
  assert.equal(secondJoin.body.roomId, 'priority-low');
  assert.equal(secondJoin.body.routeId, low.body.route.id);
  assert.equal(startRequests().length, 0, 'a room-only destination starts no egress');

  // All matching rules disabled -> explicit no_route, never a stray join.
  await ts.api('PATCH', `/v1/admin/routes/${low.body.route.id}`, { headers: ADMIN, body: { enabled: false } });
  const thirdToken = await issueEdgeToken({ edgeId: 'cam-priority' });
  const noRoute = await edgeJoin({ token: thirdToken.token });
  assert.equal(noRoute.status, 404);
  assert.equal(noRoute.body.error.code, 'no_route');

  // Unknown/revoked tokens are rejected.
  assert.equal((await edgeJoin({ token: 'agil_edge_unknown_unknown_unknown' })).status, 401);
  const revokedToken = await issueEdgeToken({ edgeId: 'cam-revoked' });
  const revoked = await ts.api('DELETE', `/v1/admin/routes/edge-tokens/${revokedToken.enrollment.id}`, { headers: ADMIN });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revoked, true);
  assert.equal((await edgeJoin({ token: revokedToken.token })).status, 401);

  await ts.api('DELETE', `/v1/admin/routes/${high.body.route.id}`, { headers: ADMIN });
  await ts.api('DELETE', `/v1/admin/routes/${low.body.route.id}`, { headers: ADMIN });
});

test('Edge→stream expansion: Edge→room + room→egress (RTMP grouped, HLS) and idempotency', async () => {
  resetRequests();
  const route = await createRoute({
    name: 'Expanded stream',
    source: { type: 'edge', tag: 'broadcast' },
    destinations: [
      { type: 'stream', provider: 'rtmp', url: RTMP, layout: 'grid' },
      { type: 'stream', provider: 'rtmp', url: 'rtmp://backup.example/app/second-key', layout: 'grid' },
      { type: 'stream', provider: 'hls', layout: 'speaker' },
    ],
  });
  assert.equal(route.status, 200, JSON.stringify(route.body));
  const issued = await issueEdgeToken({ tag: 'broadcast' });
  const joined = await edgeJoin({ token: issued.token, edgeId: 'cam-expand', name: 'Expand camera' });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.roomId, 'edge-cam-expand', 'implicit room for a stream-only Edge route');
  assert.equal(joined.body.destinations.filter((destination: any) => destination.type === 'room').length, 0);

  const starts = startRequests();
  assert.equal(starts.length, 2, 'one grouped RTMP job + one HLS job');
  const rtmp = starts.find((entry) => entry.body.stream_outputs);
  assert.ok(rtmp);
  assert.equal(rtmp!.body.room_name, 'demo__edge-cam-expand');
  assert.deepEqual(rtmp!.body.stream_outputs[0].urls.sort(), [RTMP, 'rtmp://backup.example/app/second-key'].sort());
  const hls = starts.find((entry) => entry.body.segment_outputs);
  assert.ok(hls);
  assert.equal(hls!.body.segment_outputs[0].protocol, 'HLS_PROTOCOL');
  assert.equal(hls!.body.layout, 'speaker');
  assert.ok(!JSON.stringify(joined.body).includes('second-key'));

  const streamStatuses = joined.body.destinations.filter((destination: any) => destination.type === 'stream');
  assert.deepEqual(streamStatuses.map((destination: any) => destination.status).sort(), ['pending', 'pending', 'pending']);

  // Idempotent: a route test with the same destination signature starts nothing new.
  resetRequests();
  const tested = await ts.api('POST', `/v1/admin/routes/${route.body.route.id}/test`, {
    headers: ADMIN,
    body: { edgeId: 'cam-expand', tag: 'broadcast' },
  });
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.equal(tested.body.matched, true);
  assert.equal(tested.body.applied, true);
  assert.equal(tested.body.roomId, 'edge-cam-expand');
  assert.equal(tested.body.egress.status, 'pending');
  assert.equal(startRequests().length, 0, 'no duplicate egress start (one feed, one encode)');

  // Dry run starts nothing.
  resetRequests();
  const dry = await ts.api('POST', `/v1/admin/routes/${route.body.route.id}/test`, {
    headers: ADMIN,
    body: { edgeId: 'cam-dry', tag: 'broadcast', apply: false },
  });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.applied, false);
  assert.equal(dry.body.egress.status, 'skipped');
  assert.equal(startRequests().length, 0);
  assert.ok(dry.body.destinations.every((destination: any) => destination.status === 'skipped'));

  await ts.api('DELETE', `/v1/admin/routes/${route.body.route.id}`, { headers: ADMIN });
});

test('recording destination starts a file egress job from the routed room', async () => {
  resetRequests();
  const route = await createRoute({
    name: 'Recorded hall',
    source: { type: 'edge', edgeId: 'cam-recording' },
    destinations: [{ type: 'room', roomId: 'recording-room' }],
    recording: { enabled: true, layout: 'speaker', audioOnly: false },
  });
  assert.equal(route.status, 200, JSON.stringify(route.body));
  const issued = await issueEdgeToken({ edgeId: 'cam-recording' });
  const joined = await edgeJoin({ token: issued.token });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.roomId, 'recording-room');
  assert.equal(joined.body.egress.status, 'pending');
  assert.equal(joined.body.egress.jobs, 0, 'recording is not a stream destination');
  const recording = startRequests().find((entry) => entry.body.file_outputs);
  assert.ok(recording, JSON.stringify(requests.map((entry) => entry.body)));
  assert.equal(recording!.body.room_name, 'demo__recording-room');
  assert.equal(recording!.body.layout, 'speaker');
  assert.equal(recording!.body.file_outputs[0].file_type, 'MP4');
  assert.match(String(recording!.body.file_outputs[0].filepath), /^demo\/recording-room\/.*\.mp4$/);
  await ts.api('DELETE', `/v1/admin/routes/${route.body.route.id}`, { headers: ADMIN });
});

test('room→stream: first participant starts egress; idempotent; secretRef resolves server-side', async () => {
  resetRequests();
  const room = await createRoom('Room source stream');
  const route = await createRoute({
    name: 'Room stream',
    source: { type: 'room', roomId: room.roomId },
    destinations: [{ type: 'stream', provider: 'rtmp', secretRef: 'AGIL_ROUTE_SECRET_DEMO_MAIN', layout: 'speaker' }],
  });
  assert.equal(route.status, 200, JSON.stringify(route.body));

  const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(room.token)}`);
  await client.waitFor((message) => message.type === 'welcome');
  await waitFor(() => startRequests().length === 1);
  const start = startRequests()[0]!;
  assert.equal(start.body.room_name, `demo__${room.roomId}`);
  assert.equal(start.body.layout, 'speaker');
  assert.deepEqual(start.body.stream_outputs, [{ protocol: 'RTMP', urls: [RTMP] }]);

  // Second participant and a route test do not start a second job.
  const guest = await ts.api('POST', `/v1/rooms/${room.roomId}/join`, { body: { name: 'Guest' } });
  assert.equal(guest.status, 200, JSON.stringify(guest.body));
  const guestWs = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(guest.body.token)}`);
  await guestWs.waitFor((message) => message.type === 'welcome');
  const tested = await ts.api('POST', `/v1/admin/routes/${route.body.route.id}/test`, {
    headers: ADMIN,
    body: { roomId: room.roomId },
  });
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.equal(tested.body.egress.status, 'pending');
  assert.equal(startRequests().length, 1, 'idempotent egress');

  // A room-source rule is bound to its room: another room id is reported as a
  // non-match (diagnostic 200), never as an egress job.
  const otherRoom = await ts.api('POST', `/v1/admin/routes/${route.body.route.id}/test`, {
    headers: ADMIN,
    body: { roomId: 'no-such-room' },
  });
  assert.equal(otherRoom.status, 200);
  assert.equal(otherRoom.body.matched, false);
  assert.equal(startRequests().length, 1);

  const lastRun = await ts.api('GET', `/v1/admin/routes/${route.body.route.id}`, { headers: ADMIN });
  assert.equal(lastRun.body.route.lastRun.status, 'pending');
  assert.ok(!JSON.stringify(lastRun.body).includes(STREAM_KEY));

  await client.close();
  await guestWs.close();
  await ts.api('DELETE', `/v1/admin/routes/${route.body.route.id}`, { headers: ADMIN });
});

test('egress failure is stored on the rule and reported, never thrown', async () => {
  resetRequests();
  const room = await createRoom('Failing stream');
  const route = await createRoute({
    name: 'Failing route',
    source: { type: 'room', roomId: room.roomId },
    destinations: [{ type: 'stream', provider: 'rtmp', url: RTMP }],
  });
  assert.equal(route.status, 200, JSON.stringify(route.body));
  failStart = true;
  try {
    const tested = await ts.api('POST', `/v1/admin/routes/${route.body.route.id}/test`, {
      headers: ADMIN,
      body: { roomId: room.roomId },
    });
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    assert.equal(tested.body.egress.status, 'failed');
    assert.ok(tested.body.errors.length > 0);
    assert.ok(!JSON.stringify(tested.body).includes(STREAM_KEY), 'failure text is sanitized');

    const stored = await ts.api('GET', `/v1/admin/routes/${route.body.route.id}`, { headers: ADMIN });
    assert.equal(stored.body.route.lastRun.status, 'failed');
    assert.ok(stored.body.route.lastRun.jobs.some((job: any) => job.status === 'failed'));
    assert.ok(!JSON.stringify(stored.body).includes(STREAM_KEY));
    assert.ok(!JSON.stringify(stored.body).includes('stream_outputs'), 'upstream body is never stored');

    const audit = await ts.api('GET', '/v1/admin/audit?type=route.egress.failed&limit=100', { headers: ADMIN });
    assert.ok(audit.body.entries.length > 0);
    assert.ok(!JSON.stringify(audit.body).includes(STREAM_KEY));
  } finally {
    failStart = false;
    await ts.api('DELETE', `/v1/admin/routes/${route.body.route.id}`, { headers: ADMIN });
  }
});

test('egress unavailable is explicit: Edge join still succeeds, status is egress_disabled', async () => {
  const roomRoute = await disabledTs.api('POST', '/v1/admin/routes', {
    headers: ADMIN,
    body: {
      source: { type: 'edge', edgeId: 'cam-disabled-egress' },
      destinations: [
        { type: 'room', roomId: 'disabled-egress-room' },
        { type: 'stream', provider: 'rtmp', url: RTMP },
      ],
    },
  });
  assert.equal(roomRoute.status, 200, JSON.stringify(roomRoute.body));
  const issued = await disabledTs.api('POST', '/v1/admin/routes/edge-tokens', {
    headers: ADMIN,
    body: { edgeId: 'cam-disabled-egress' },
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const joined = await disabledTs.api('POST', '/v1/edge/join', { body: { token: issued.body.token } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.roomId, 'disabled-egress-room');
  assert.equal(joined.body.egress.status, 'unavailable');
  assert.ok(joined.body.egress.errors.some((message: string) => /egress_disabled|Egress отключён/i.test(message)));
  const stream = joined.body.destinations.find((destination: any) => destination.type === 'stream');
  assert.equal(stream.status, 'unavailable');
  assert.ok(!JSON.stringify(joined.body).includes(STREAM_KEY));

  const tested = await disabledTs.api('POST', `/v1/admin/routes/${roomRoute.body.route.id}/test`, {
    headers: ADMIN,
    body: { edgeId: 'cam-disabled-egress' },
  });
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.equal(tested.body.egress.status, 'unavailable');
});

test('bound Egress node unavailable: Edge joins and the stream destination reports unavailable', async () => {
  resetRequests();
  const setBinding = (egressNodeId: string) => ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN, body: { mediaProcessing: { egressNodeId } },
  });
  const route = await createRoute({
    name: 'Bound provider', source: { type: 'edge', edgeId: 'cam-managed-egress' },
    destinations: [{ type: 'room', roomId: 'managed-egress-room' }, { type: 'stream', provider: 'hls' }],
  });
  assert.equal(route.status, 200, route.text);
  try {
    assert.equal((await setBinding('offline-egress-node')).status, 200);
    const issued = await issueEdgeToken({ edgeId: 'cam-managed-egress' });
    const joined = await edgeJoin({ token: issued.token });
    assert.equal(joined.status, 200, joined.text);
    assert.equal(joined.body.roomId, 'managed-egress-room');
    assert.equal(joined.body.egress.code, 'egress_unavailable');
    assert.equal(joined.body.destinations.find((dest: { type: string }) => dest.type === 'stream').status, 'unavailable');
    assert.equal(startRequests().length, 0);
  } finally {
    assert.equal((await setBinding('')).status, 200);
    await ts.api('DELETE', `/v1/admin/routes/${route.body.route.id}`, { headers: ADMIN });
  }
});

test('missing route secret is a destination error, not a failed request', async () => {
  resetRequests();
  const issued = await issueEdgeToken({ edgeId: 'cam-missing-secret' });
  const route = await createRoute({
    name: 'Missing secret',
    source: { type: 'edge', edgeId: 'cam-missing-secret' },
    destinations: [
      { type: 'room', roomId: 'missing-secret-room' },
      { type: 'stream', provider: 'rtmp', secretRef: 'AGIL_ROUTE_SECRET_NOT_SET' },
    ],
  });
  assert.equal(route.status, 200, JSON.stringify(route.body));
  const joined = await edgeJoin({ token: issued.token });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.roomId, 'missing-secret-room');
  assert.equal(joined.body.egress.status, 'unavailable');
  const stream = joined.body.destinations.find((destination: any) => destination.type === 'stream');
  assert.equal(stream.status, 'unavailable');
  assert.match(stream.error, /AGIL_ROUTE_SECRET_NOT_SET/);
  assert.equal(startRequests().length, 0, 'no egress job without a URL');
  assert.ok(!JSON.stringify(joined.body).includes(STREAM_KEY));
  await ts.api('DELETE', `/v1/admin/routes/${route.body.route.id}`, { headers: ADMIN });
});
