/**
 * Core/Node enrollment + registry baseline (docs/api/cluster.md):
 * hashed one-time tokens (TTL/uses/revoke), node register/heartbeat/duplicate,
 * drain/disable, standby Core join, tenant/platform auth and no secret leakage.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgilServer } from '../src/index.js';
import { silentLogger } from '../src/logger.js';
import { delay, startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const ACME = { 'x-api-key': 'acme-key' };
const PLATFORM = { 'x-api-key': 'platform-test-key' };
let ts: TestServer;

before(async () => {
  ts = await startTestServer({ platformKey: 'platform-test-key' });
});

after(async () => {
  await ts.close();
});

interface CreatedToken {
  token: string;
  enrollment: {
    id: string;
    kind: string;
    role: string;
    features: string[];
    expiresAt: number;
    uses: number;
    remainingUses: number;
    createdBy: string;
    createdAt: number;
    revokedAt: number | null;
    label: string;
    status: string;
  };
}

async function createToken(body: Record<string, unknown>, headers: Record<string, string> = ADMIN): Promise<CreatedToken> {
  const response = await ts.api('POST', '/v1/admin/cluster/tokens', { headers, body });
  assert.equal(response.status, 201, `token create failed: ${response.text}`);
  return response.body as CreatedToken;
}

function registerNode(token: string, extra: Record<string, unknown> = {}) {
  return ts.api('POST', '/v1/nodes/register', { body: { token, role: 'sfu', ...extra } });
}

function heartbeat(nodeId: string, key: string, body: Record<string, unknown> = {}) {
  return ts.api('POST', `/v1/nodes/${encodeURIComponent(nodeId)}/heartbeat`, {
    headers: { 'x-node-token': key },
    body,
  });
}

test('token endpoints require a tenant admin credential (platform key is rejected)', async () => {
  const anonymous = await ts.api('GET', '/v1/admin/cluster/tokens');
  assert.equal(anonymous.status, 401);

  const platformTokens = await ts.api('GET', '/v1/admin/cluster/tokens', { headers: PLATFORM });
  assert.equal(platformTokens.status, 403);
  const platformCreate = await ts.api('POST', '/v1/admin/cluster/tokens', {
    headers: PLATFORM,
    body: { kind: 'node', role: 'sfu' },
  });
  assert.equal(platformCreate.status, 403);
  const platformNodes = await ts.api('GET', '/v1/admin/nodes', { headers: PLATFORM });
  assert.equal(platformNodes.status, 403);

  const created = await createToken({ kind: 'node', role: 'sfu', features: ['sfu'], label: 'demo-sfu' });
  assert.match(created.token, /^agil_enr_[A-Za-z0-9_-]{20,}$/);
  assert.equal(created.enrollment.kind, 'node');
  assert.equal(created.enrollment.role, 'sfu');
  assert.deepEqual(created.enrollment.features, ['sfu']);
  assert.equal(created.enrollment.uses, 1);
  assert.equal(created.enrollment.remainingUses, 1);
  assert.equal(created.enrollment.status, 'active');
  assert.equal(created.enrollment.createdBy, 'api-key:demo');
  assert.ok(created.enrollment.id.startsWith('enr_'));

  // A tenant key never sees another tenant's tokens.
  const acmeCreated = await createToken({ kind: 'node', role: 'turn', features: ['turn'] }, ACME);
  const demoList = await ts.api('GET', '/v1/admin/cluster/tokens', { headers: ADMIN });
  assert.equal(demoList.status, 200);
  const demoIds = demoList.body.tokens.map((token: { id: string }) => token.id);
  assert.ok(demoIds.includes(created.enrollment.id));
  assert.ok(!demoIds.includes(acmeCreated.enrollment.id));
  const acmeList = await ts.api('GET', '/v1/admin/cluster/tokens', { headers: ACME });
  assert.deepEqual(
    acmeList.body.tokens.map((token: { id: string }) => token.id),
    [acmeCreated.enrollment.id],
  );
});

test('token TTL: an expired token cannot register a node', async () => {
  const created = await createToken({ kind: 'node', role: 'sfu', ttlSec: 1 });
  assert.equal(created.enrollment.status, 'active');
  await delay(1200);
  const expired = await registerNode(created.token, { nodeId: 'ttl-node' });
  assert.equal(expired.status, 401);
  assert.match(expired.body.error.message, /expired/i);

  const list = await ts.api('GET', '/v1/admin/cluster/tokens', { headers: ADMIN });
  const listed = list.body.tokens.find((token: { id: string }) => token.id === created.enrollment.id);
  assert.equal(listed.status, 'expired');
  assert.equal(listed.remainingUses, 1);
});

test('one-time and multi-use tokens: uses are consumed exactly once', async () => {
  const oneTime = await createToken({ kind: 'node', role: 'sfu' });
  const first = await registerNode(oneTime.token, { nodeId: 'once-node-a' });
  assert.equal(first.status, 201, first.text);
  const reuse = await registerNode(oneTime.token, { nodeId: 'once-node-b' });
  assert.equal(reuse.status, 401);
  assert.match(reuse.body.error.message, /already been used/i);

  const multi = await createToken({ kind: 'node', role: 'sfu', uses: 2 });
  assert.equal(multi.enrollment.remainingUses, 2);
  assert.equal((await registerNode(multi.token, { nodeId: 'multi-node-a' })).status, 201);
  const second = await registerNode(multi.token, { nodeId: 'multi-node-b' });
  assert.equal(second.status, 201, second.text);
  const third = await registerNode(multi.token, { nodeId: 'multi-node-c' });
  assert.equal(third.status, 401);

  const list = await ts.api('GET', '/v1/admin/cluster/tokens', { headers: ADMIN });
  const used = list.body.tokens.find((token: { id: string }) => token.id === multi.enrollment.id);
  assert.equal(used.status, 'used');
  assert.equal(used.remainingUses, 0);
});

test('token revoke: revoked tokens stop working and revocation is idempotent', async () => {
  const created = await createToken({ kind: 'node', role: 'sfu' });
  const revoked = await ts.api('DELETE', `/v1/admin/cluster/tokens/${created.enrollment.id}`, { headers: ADMIN });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revoked, true);
  assert.equal(revoked.body.enrollment.status, 'revoked');
  assert.equal(typeof revoked.body.enrollment.revokedAt, 'number');

  const attempt = await registerNode(created.token, { nodeId: 'revoked-node' });
  assert.equal(attempt.status, 401);
  assert.match(attempt.body.error.message, /revoked/i);

  // Revoking again is a no-op (still 200), an unknown id is 404.
  assert.equal((await ts.api('DELETE', `/v1/admin/cluster/tokens/${created.enrollment.id}`, { headers: ADMIN })).status, 200);
  assert.equal((await ts.api('DELETE', '/v1/admin/cluster/tokens/enr_0000000000000000', { headers: ADMIN })).status, 404);

  // A revoked token is never redeemable, even before its TTL.
  const list = await ts.api('GET', '/v1/admin/cluster/tokens', { headers: ADMIN });
  assert.equal(list.body.tokens.find((token: { id: string }) => token.id === created.enrollment.id).status, 'revoked');
});

test('node registration is scoped by the token and rejects duplicate ids without burning the token', async () => {
  const scoped = await createToken({ kind: 'node', role: 'sfu', features: ['sfu', 'egress'] });

  const wrongRole = await registerNode(scoped.token, { role: 'turn', features: ['turn'] });
  assert.equal(wrongRole.status, 403);
  const wrongFeatures = await registerNode(scoped.token, { features: ['turn'] });
  assert.equal(wrongFeatures.status, 403);

  const created = await registerNode(scoped.token, { nodeId: 'scoped-node', name: 'Edge SFU', capacity: { maxRooms: 5 } });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.node.id, 'scoped-node');
  assert.equal(created.body.node.role, 'sfu');
  assert.deepEqual(created.body.node.features, ['sfu', 'egress']);
  assert.equal(created.body.node.capacity.maxRooms, 5);
  assert.equal(created.body.node.status, 'online');
  assert.equal(created.body.node.tenantId, 'demo');
  assert.equal(created.body.heartbeatIntervalSec, 30);
  assert.equal(created.body.cluster.role, 'leader');
  assert.match(created.body.nodeKey, /^nk_[A-Za-z0-9_-]{20,}$/);

  // One-time token was consumed by the successful registration only.
  const duplicateToken = await createToken({ kind: 'node', role: 'sfu' });
  const duplicate = await registerNode(duplicateToken.token, { nodeId: 'scoped-node' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'node_exists');
  // The failed duplicate did not consume the token: the same token works for a new id.
  const retry = await registerNode(duplicateToken.token, { nodeId: 'scoped-node-2' });
  assert.equal(retry.status, 201, retry.text);

  // Tenant isolation: another tenant sees neither node.
  const acmeNodes = await ts.api('GET', '/v1/admin/nodes', { headers: ACME });
  assert.equal(acmeNodes.status, 200);
  assert.equal(acmeNodes.body.nodes.length, 0);
  const demoNodes = await ts.api('GET', '/v1/admin/nodes', { headers: ADMIN });
  assert.ok(demoNodes.body.nodes.some((node: { id: string }) => node.id === 'scoped-node'));
});

test('heartbeat refreshes liveness/capacity and rejects bad or foreign credentials', async () => {
  const created = await createToken({ kind: 'node', role: 'sfu' });
  const registration = await registerNode(created.token, { nodeId: 'hb-node', capacity: { maxRooms: 2 } });
  assert.equal(registration.status, 201, registration.text);
  const nodeKey = registration.body.nodeKey as string;

  const missing = await ts.api('POST', '/v1/nodes/hb-node/heartbeat', { body: {} });
  assert.equal(missing.status, 401);
  const wrongKey = await heartbeat('hb-node', 'nk_not-a-real-key');
  assert.equal(wrongKey.status, 401);
  const foreignNode = await heartbeat('other-node', nodeKey);
  assert.equal(foreignNode.status, 403);

  const beat = await heartbeat('hb-node', nodeKey, { capacity: { maxParticipants: 300 } });
  assert.equal(beat.status, 200, beat.text);
  assert.equal(beat.body.node.capacity.maxRooms, 2);
  assert.equal(beat.body.node.capacity.maxParticipants, 300);
  assert.equal(beat.body.drain, false);
  assert.ok(beat.body.node.lastSeenAt >= registration.body.node.registeredAt);
  assert.equal(beat.body.heartbeatIntervalSec, 30);
  assert.equal(typeof beat.body.serverTime, 'number');
  assert.ok(!beat.text.includes('keyHash'), 'heartbeat must not expose the node key hash');
  assert.ok(!beat.text.includes(nodeKey), 'heartbeat must not echo the node key');

  const list = await ts.api('GET', '/v1/admin/nodes', { headers: ADMIN });
  const listed = list.body.nodes.find((node: { id: string }) => node.id === 'hb-node');
  assert.equal(listed.capacity.maxParticipants, 300);
});

test('heartbeat metrics: validated, merged into the node and exposed by GET /v1/admin/nodes', async () => {
  const created = await createToken({ kind: 'node', role: 'sfu' });
  const registration = await registerNode(created.token, { nodeId: 'metrics-node', version: '1.0.0' });
  assert.equal(registration.status, 201, registration.text);
  const nodeKey = registration.body.nodeKey as string;

  // A node that has not reported metrics yet exposes no `metrics` field at all:
  // absence means "not reported", never a zero-filled snapshot.
  const before = await ts.api('GET', '/v1/admin/nodes', { headers: ADMIN });
  const beforeNode = before.body.nodes.find((node: { id: string }) => node.id === 'metrics-node');
  assert.equal('metrics' in beforeNode, false);

  const reportedAt = Date.now() - 1000;
  const expected = {
    cpuPercent: 12.5,
    memoryPercent: 43,
    load1: 0.42,
    activeRooms: 3,
    participants: 17,
    bandwidthMbps: 12.5,
    uptimeSec: 86_400,
    version: '0.2.0',
    reportedAt,
  };
  const beat = await heartbeat('metrics-node', nodeKey, { metrics: expected });
  assert.equal(beat.status, 200, beat.text);
  assert.deepEqual(beat.body.node.metrics, expected);
  // The registration version is a separate field from the self-reported agent version.
  assert.equal(beat.body.node.version, '1.0.0');
  assert.equal(beat.body.node.metrics.version, '0.2.0');

  const listed = await ts.api('GET', '/v1/admin/nodes', { headers: ADMIN });
  const listedNode = listed.body.nodes.find((node: { id: string }) => node.id === 'metrics-node');
  assert.deepEqual(listedNode.metrics, expected);

  // A partial report refreshes only the fields it carries (and reportedAt).
  const later = reportedAt + 30_000;
  const partial = await heartbeat('metrics-node', nodeKey, { metrics: { cpuPercent: 5, reportedAt: later } });
  assert.equal(partial.status, 200, partial.text);
  assert.deepEqual(partial.body.node.metrics, { ...expected, cpuPercent: 5, reportedAt: later });

  // Old agents send only capacity/status: the last snapshot is preserved, not erased.
  const oldStyle = await heartbeat('metrics-node', nodeKey, { capacity: { maxRooms: 4 } });
  assert.equal(oldStyle.status, 200, oldStyle.text);
  assert.deepEqual(oldStyle.body.node.metrics, { ...expected, cpuPercent: 5, reportedAt: later });

  // `metrics: {}` (an agent that serialised only undefined values) is a no-op too.
  const empty = await heartbeat('metrics-node', nodeKey, { metrics: {} });
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.body.node.metrics, { ...expected, cpuPercent: 5, reportedAt: later });

  // Omitting `reportedAt` makes the Core stamp its receipt time — it never
  // invents metric values, but the snapshot always has an honest timestamp.
  const stampStart = Date.now();
  const stamped = await heartbeat('metrics-node', nodeKey, { metrics: { memoryPercent: 44 } });
  assert.equal(stamped.status, 200, stamped.text);
  const stampedAt = stamped.body.node.metrics.reportedAt as number;
  assert.ok(stampedAt >= stampStart && stampedAt <= Date.now(), `unexpected reportedAt ${stampedAt}`);
  assert.equal(stamped.body.node.metrics.memoryPercent, 44);
  assert.equal(stamped.body.node.metrics.cpuPercent, 5, 'the previous partial report is still merged');

  // The snapshot is persisted in the registry file, not only kept in memory.
  const file = path.join(ts.dataDir, 'cluster', 'cluster.json');
  const state = JSON.parse(readFileSync(file, 'utf8')) as { nodes: Array<{ id: string; metrics: unknown }> };
  assert.deepEqual(state.nodes.find((node) => node.id === 'metrics-node')?.metrics, {
    ...expected,
    cpuPercent: 5,
    memoryPercent: 44,
    reportedAt: stampedAt,
  });
});

test('heartbeat metrics: out-of-range/non-finite values are rejected and never stored', async () => {
  const created = await createToken({ kind: 'node', role: 'sfu' });
  const registration = await registerNode(created.token, { nodeId: 'metrics-bad-node' });
  assert.equal(registration.status, 201, registration.text);
  const nodeKey = registration.body.nodeKey as string;

  const valid = await heartbeat('metrics-bad-node', nodeKey, { metrics: { cpuPercent: 10 } });
  assert.equal(valid.status, 200, valid.text);
  const stored = valid.body.node.metrics;

  const invalid = [
    { cpuPercent: 101 },
    { cpuPercent: -1 },
    { memoryPercent: 100.5 },
    { load1: -0.1 },
    { activeRooms: 1.5 },
    { participants: -1 },
    { bandwidthMbps: Number.MAX_VALUE },
    { uptimeSec: -1.5 },
    { version: '' },
    { version: 'x'.repeat(33) },
    { reportedAt: -1 },
    { reportedAt: 1.5 },
    { cpuPercent: '50' },
  ];
  for (const metrics of invalid) {
    const response = await heartbeat('metrics-bad-node', nodeKey, { metrics });
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(metrics)}: ${response.text}`);
    assert.equal(response.body.error.code, 'validation_failed', response.text);
    assert.ok(Array.isArray(response.body.error.details), 'validation details are returned');
  }

  // JSON.parse('1e999') === Infinity: non-finite numbers are rejected, not coerced.
  const nonFinite = await ts.api('POST', '/v1/nodes/metrics-bad-node/heartbeat', {
    headers: { 'x-node-token': nodeKey },
    rawBody: '{"metrics":{"cpuPercent":1e999}}',
  });
  assert.equal(nonFinite.status, 400);
  assert.equal(nonFinite.body.error.code, 'validation_failed');

  // None of the rejected reports changed the stored snapshot.
  const listed = await ts.api('GET', '/v1/admin/nodes', { headers: ADMIN });
  const listedNode = listed.body.nodes.find((node: { id: string }) => node.id === 'metrics-bad-node');
  assert.deepEqual(listedNode.metrics, stored);
});

test('registry reload: persisted metrics load, corrupted metrics are dropped (no fabricated values)', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-metrics-reload-'));
  const nodeBase = {
    tenantId: 'demo',
    role: 'sfu',
    features: [],
    capacity: { maxRooms: 1, maxParticipants: 10, bandwidthMbps: 100 },
    name: 'reload-node',
    endpoint: '',
    healthPath: '/health',
    region: '',
    version: '1.0.0',
    keyHash: 'a'.repeat(64),
    enabled: true,
    drain: false,
    createdAt: 1_700_000_000_000,
    registeredAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    lastStatus: 'online',
    keyExpiresAt: null,
    keyRotatedAt: null,
  };
  mkdirSync(path.join(dataDir, 'cluster'), { recursive: true });
  writeFileSync(
    path.join(dataDir, 'cluster', 'cluster.json'),
    JSON.stringify({
      version: 1,
      clusterId: 'cl_test',
      tokens: [],
      standbys: [],
      nodes: [
        {
          ...nodeBase,
          id: 'reload-valid',
          metrics: { cpuPercent: 25, participants: 2, version: '0.3.0', reportedAt: 1_700_000_000_500 },
        },
        { ...nodeBase, id: 'reload-corrupt', metrics: { cpuPercent: 150, reportedAt: -1 } },
        { ...nodeBase, id: 'reload-legacy' },
      ],
    }),
    'utf8',
  );
  const server = await createAgilServer({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    tokenSecret: 'test-secret-0123456789',
    apiKeys: { 'dev-key': 'demo' },
    allowAnonymous: true,
    publicOrigin: 'http://127.0.0.1:1',
    logger: silentLogger,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/admin/nodes`, { headers: { 'x-api-key': 'dev-key' } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { nodes: Array<{ id: string; metrics?: unknown }> };
    assert.deepEqual(body.nodes.find((node) => node.id === 'reload-valid')?.metrics, {
      cpuPercent: 25,
      participants: 2,
      version: '0.3.0',
      reportedAt: 1_700_000_000_500,
    });
    // Corrupted metrics are dropped instead of failing the registry or surfacing them.
    assert.equal('metrics' in (body.nodes.find((node) => node.id === 'reload-corrupt') ?? {}), false);
    // A legacy node record without metrics stays metrics-free.
    assert.equal('metrics' in (body.nodes.find((node) => node.id === 'reload-legacy') ?? {}), false);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('drain, disable and update: admin controls gate heartbeat and status', async () => {
  const created = await createToken({ kind: 'node', role: 'sfu' });
  const registration = await registerNode(created.token, { nodeId: 'ops-node' });
  assert.equal(registration.status, 201, registration.text);
  const nodeKey = registration.body.nodeKey as string;

  const drain = await ts.api('POST', '/v1/admin/nodes/ops-node/drain', { headers: ADMIN, body: { drain: true } });
  assert.equal(drain.status, 200);
  assert.equal(drain.body.node.status, 'draining');
  const drainingBeat = await heartbeat('ops-node', nodeKey);
  assert.equal(drainingBeat.status, 200);
  assert.equal(drainingBeat.body.drain, true);

  const undrain = await ts.api('POST', '/v1/admin/nodes/ops-node/drain', { headers: ADMIN, body: { drain: false } });
  assert.equal(undrain.body.node.status, 'online');

  const disable = await ts.api('POST', '/v1/admin/nodes/ops-node/disable', { headers: ADMIN, body: { disabled: true } });
  assert.equal(disable.status, 200);
  assert.equal(disable.body.node.status, 'disabled');
  const disabledBeat = await heartbeat('ops-node', nodeKey);
  assert.equal(disabledBeat.status, 403);
  assert.match(disabledBeat.body.error.message, /disabled/i);

  const enable = await ts.api('POST', '/v1/admin/nodes/ops-node/disable', { headers: ADMIN, body: { disabled: false } });
  assert.equal(enable.body.node.status, 'online');
  assert.equal((await heartbeat('ops-node', nodeKey)).status, 200);

  const update = await ts.api('PATCH', '/v1/admin/nodes/ops-node', {
    headers: ADMIN,
    body: { name: 'Ops SFU', features: ['sfu', 'egress'], capacity: { maxRooms: 9 }, region: 'ru-msk' },
  });
  assert.equal(update.status, 200, update.text);
  assert.equal(update.body.node.name, 'Ops SFU');
  assert.deepEqual(update.body.node.features, ['sfu', 'egress']);
  assert.equal(update.body.node.capacity.maxRooms, 9);
  assert.equal(update.body.node.region, 'ru-msk');

  const removed = await ts.api('DELETE', '/v1/admin/nodes/ops-node', { headers: ADMIN });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted, true);
  // A removed node id can be enrolled again; its old key no longer works.
  assert.equal((await heartbeat('ops-node', nodeKey)).status, 401);
  const reEnrolled = await registerNode((await createToken({ kind: 'node', role: 'sfu' })).token, { nodeId: 'ops-node' });
  assert.equal(reEnrolled.status, 201, reEnrolled.text);
});

test('standby Core join: core tokens work, node tokens do not, duplicates conflict', async () => {
  const coreToken = await createToken({ kind: 'core' });
  assert.equal(coreToken.enrollment.role, 'standby');
  const joined = await ts.api('POST', '/v1/cluster/join', {
    body: { token: coreToken.token, nodeId: 'standby-core-1', version: '0.1.0', region: 'ru-msk' },
  });
  assert.equal(joined.status, 200, joined.text);
  assert.equal(joined.body.cluster.role, 'leader');
  assert.equal(typeof joined.body.cluster.id, 'string');
  assert.equal(joined.body.cluster.version.length > 0, true);
  assert.equal(joined.body.leader.nodeId, joined.body.cluster.id);
  assert.equal(typeof joined.body.leader.publicOrigin, 'string');
  assert.equal(joined.body.standby.id, 'standby-core-1');
  assert.equal(joined.body.standby.clusterId, joined.body.cluster.id);
  assert.equal(joined.body.token.remainingUses, 0);

  const reuse = await ts.api('POST', '/v1/cluster/join', { body: { token: coreToken.token, nodeId: 'standby-core-2' } });
  assert.equal(reuse.status, 401);

  const duplicateToken = await createToken({ kind: 'core' });
  const duplicate = await ts.api('POST', '/v1/cluster/join', { body: { token: duplicateToken.token, nodeId: 'standby-core-1' } });
  assert.equal(duplicate.status, 409);

  const nodeToken = await createToken({ kind: 'node', role: 'sfu' });
  const wrongKind = await ts.api('POST', '/v1/cluster/join', { body: { token: nodeToken.token, nodeId: 'standby-core-3' } });
  assert.equal(wrongKind.status, 403);

  const coreOnRegister = await registerNode(coreToken.token, { nodeId: 'not-a-node' });
  assert.equal(coreOnRegister.status, 403); // a `core` token never enrolls a node
  const freshCore = await createToken({ kind: 'core' });
  assert.equal((await registerNode(freshCore.token, { nodeId: 'not-a-node-2' })).status, 403);

  const status = await ts.api('GET', '/v1/admin/cluster/status', { headers: ADMIN });
  assert.equal(status.status, 200);
  assert.equal(status.body.cluster.role, 'leader');
  assert.ok(status.body.standbys.some((standby: { id: string }) => standby.id === 'standby-core-1'));
  assert.equal(status.body.counts.standbys >= 1, true);
  assert.ok(Array.isArray(status.body.limitations) && status.body.limitations.length >= 2);
  assert.ok(Array.isArray(status.body.enrolledNodes));
  // Legacy fields stay intact for older clients.
  assert.equal(status.body.multiNodeActive, false);
  assert.equal(typeof status.body.nodeId, 'string');
});

test('no secret leakage: list/status/audit responses and the registry file only hold hashes', async () => {
  const created = await createToken({ kind: 'node', role: 'turn', features: ['turn'], label: 'leak-check' });
  const registration = await registerNode(created.token, { nodeId: 'leak-node', role: 'turn', features: ['turn'] });
  assert.equal(registration.status, 201, registration.text);
  const nodeKey = registration.body.nodeKey as string;

  const tokenList = await ts.api('GET', '/v1/admin/cluster/tokens', { headers: ADMIN });
  assert.ok(!tokenList.text.includes(created.token), 'token list must not echo the plaintext token');
  assert.ok(!tokenList.text.includes('"hash"'), 'token list must not expose stored hashes');

  const nodeList = await ts.api('GET', '/v1/admin/nodes', { headers: ADMIN });
  assert.ok(!nodeList.text.includes(nodeKey), 'node list must not echo the node key');
  assert.ok(!nodeList.text.includes('keyHash'), 'node list must not expose key hashes');

  const status = await ts.api('GET', '/v1/admin/cluster/status', { headers: ADMIN });
  assert.ok(!status.text.includes(created.token));
  assert.ok(!status.text.includes(nodeKey));

  const audit = await ts.api('GET', '/v1/admin/audit?limit=500', { headers: ADMIN });
  assert.equal(audit.status, 200);
  assert.ok(!audit.text.includes(created.token), 'audit must not contain the plaintext enrollment token');
  assert.ok(!audit.text.includes(nodeKey), 'audit must not contain the node key');
  const kinds = audit.body.entries.map((entry: { details?: { kind?: string } }) => entry.details?.kind);
  assert.ok(kinds.includes('cluster.token.created'));
  assert.ok(kinds.includes('cluster.node.registered'));

  // At rest: only sha256 hashes + metadata, never the secrets.
  const file = path.join(ts.dataDir, 'cluster', 'cluster.json');
  const text = readFileSync(file, 'utf8');
  assert.ok(!text.includes(created.token), 'registry file must not contain the plaintext token');
  assert.ok(!text.includes(nodeKey), 'registry file must not contain the plaintext node key');
  const state = JSON.parse(text) as {
    clusterId: string;
    tokens: Array<{ id: string; hash: string }>;
    nodes: Array<{ id: string; keyHash: string }>;
  };
  const storedToken = state.tokens.find((token) => token.id === created.enrollment.id);
  assert.match(storedToken?.hash ?? '', /^[0-9a-f]{64}$/);
  const storedNode = state.nodes.find((node) => node.id === 'leak-node');
  assert.match(storedNode?.keyHash ?? '', /^[0-9a-f]{64}$/);
  assert.equal(typeof state.clusterId, 'string');
});

/* ------------------------------------------------------------------ */
/* Fix round: P1/P2/P3 regressions                                     */
/* ------------------------------------------------------------------ */

test('P1: 61 nodes behind one NAT keep heartbeating (heartbeat limiter is per node, not per IP)', async () => {
  // The old implementation shared the 120/min per-IP enrollment limiter with
  // heartbeats: 61 registrations + 61 heartbeats (=122) already caused 429s.
  const fleet: Array<{ id: string; key: string }> = [];
  for (let index = 0; index < 61; index += 1) {
    const nodeId = `nat-node-${index}`;
    const created = await createToken({ kind: 'node', role: 'sfu' });
    const registration = await registerNode(created.token, { nodeId });
    assert.equal(registration.status, 201, registration.text);
    fleet.push({ id: nodeId, key: registration.body.nodeKey as string });
  }

  // Two beats per node = 122 requests/min from one IP: the outer IP bucket
  // (default 600/min) must leave every one of them untouched.
  const statuses: number[] = [];
  for (const node of fleet) {
    for (let round = 0; round < 2; round += 1) {
      const beat = await heartbeat(node.id, node.key);
      statuses.push(beat.status);
      assert.equal(beat.status, 200, `${node.id} round ${round}: ${beat.text}`);
    }
  }
  assert.equal(statuses.filter((status) => status === 429).length, 0, 'a 61-node NAT fleet must not be throttled');

  const listed = await ts.api('GET', '/v1/admin/nodes?status=online', { headers: ADMIN });
  assert.equal(listed.status, 200);
  const onlineIds = new Set(listed.body.nodes.map((node: { id: string }) => node.id));
  for (const node of fleet) assert.ok(onlineIds.has(node.id), `${node.id} should be online`);
});

test('P1-R: distinct bogus heartbeat keys are bounded by the outer IP bucket (40/100 attempts)', async () => {
  // P1-R: the limiter used to key on `nodeId + sha256(presented credential)`,
  // so a fresh bogus key per request got a fresh 10/min bucket and 40 bogus
  // requests were 40 × 401 with no 429. The outer IP bucket is charged before
  // credential validation, so it must now stop the flood.
  const limited = await startTestServer({ heartbeatIpRateLimitPerMin: 50 });
  try {
    const statuses: number[] = [];
    const retryAfter: Array<string | null> = [];
    for (let index = 0; index < 100; index += 1) {
      const response = await limited.api('POST', '/v1/nodes/victim-node/heartbeat', {
        headers: { 'x-node-token': `nk_bogus_${index}` },
        body: {},
      });
      statuses.push(response.status);
      retryAfter.push(response.headers.get('retry-after'));
    }
    // 40 distinct keys stay inside the configured budget; 100 exhaust it.
    assert.deepEqual(statuses.slice(0, 40), Array(40).fill(401));
    assert.deepEqual(statuses.slice(0, 50), Array(50).fill(401));
    assert.deepEqual(statuses.slice(50), Array(50).fill(429));
    for (let index = 50; index < 100; index += 1) {
      const retry = Number(retryAfter[index]);
      assert.ok(
        Number.isFinite(retry) && retry >= 58 && retry <= 60,
        `429 at attempt ${index + 1} must carry Retry-After ~60, got ${retryAfter[index]}`,
      );
    }
    // The bucket is per IP, not per node id: another path/node is throttled too.
    const otherNode = await limited.api('POST', '/v1/nodes/another-victim/heartbeat', {
      headers: { 'x-node-token': 'nk_bogus_after_exhaustion' },
      body: {},
    });
    assert.equal(otherNode.status, 429);
  } finally {
    await limited.close();
  }
});

test('P1-R: the no-credential heartbeat path stays IP-limited', async () => {
  const limited = await startTestServer({ heartbeatIpRateLimitPerMin: 3 });
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const missing = await limited.api('POST', '/v1/nodes/nobody/heartbeat', { body: {} });
      assert.equal(missing.status, 401, `attempt ${attempt}`);
    }
    const blocked = await limited.api('POST', '/v1/nodes/nobody/heartbeat', { body: {} });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'rate_limited');
    assert.equal(blocked.headers.get('retry-after'), '60');
  } finally {
    await limited.close();
  }
});

test('P1-R: invalid keys do not consume a valid node per-node bucket (bucket is charged after auth)', async () => {
  const created = await createToken({ kind: 'node', role: 'sfu' });
  const registration = await registerNode(created.token, { nodeId: 'auth-then-limit-node' });
  assert.equal(registration.status, 201, registration.text);
  const nodeKey = registration.body.nodeKey as string;

  // Ten distinct bogus keys for the same node id: the old limiter would have
  // created ten buckets, and a limiter charged pre-auth would have burned the
  // node's own bucket. Neither may affect the real node's allowance.
  for (let index = 0; index < 10; index += 1) {
    const bogus = await heartbeat('auth-then-limit-node', `nk_bogus_auth_${index}`);
    assert.equal(bogus.status, 401);
  }
  for (let beatNumber = 1; beatNumber <= 10; beatNumber += 1) {
    const beat = await heartbeat('auth-then-limit-node', nodeKey);
    assert.equal(beat.status, 200, `valid beat ${beatNumber}: ${beat.text}`);
  }
});

test('heartbeat limiter still bounds a single node (10/min by default, 429 + Retry-After)', async () => {
  const created = await createToken({ kind: 'node', role: 'sfu' });
  const registration = await registerNode(created.token, { nodeId: 'burst-node' });
  assert.equal(registration.status, 201, registration.text);
  const nodeKey = registration.body.nodeKey as string;

  for (let beatNumber = 1; beatNumber <= 10; beatNumber += 1) {
    assert.equal((await heartbeat('burst-node', nodeKey)).status, 200, `beat ${beatNumber}`);
  }
  const limited = await heartbeat('burst-node', nodeKey);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
  assert.equal(limited.headers.get('retry-after'), '60');
});

test('P2-R: the per-node heartbeat bucket is tenant-scoped (same node id in two tenants)', async () => {
  // P2-R: the bucket was keyed by `heartbeat:${nodeId}`, so demo and acme both
  // owning `collide-node` shared one 10/min bucket (one tenant could throttle
  // the other). The key must be tenantId + nodeId.
  const scoped = await startTestServer({
    apiKeys: { 'dev-key': 'demo', 'acme-key': 'acme', 'gamma-key': 'gamma' },
  });
  const registerIn = async (tenantKey: string, nodeId: string): Promise<string> => {
    const created = await scoped.api('POST', '/v1/admin/cluster/tokens', {
      headers: { 'x-api-key': tenantKey },
      body: { kind: 'node', role: 'sfu' },
    });
    assert.equal(created.status, 201, created.text);
    const registration = await scoped.api('POST', '/v1/nodes/register', {
      body: { token: created.body.token, role: 'sfu', nodeId },
    });
    assert.equal(registration.status, 201, registration.text);
    return registration.body.nodeKey as string;
  };
  const beat = (nodeId: string, key: string) =>
    scoped.api('POST', `/v1/nodes/${encodeURIComponent(nodeId)}/heartbeat`, {
      headers: { 'x-node-token': key },
      body: {},
    });

  try {
    const sharedId = 'collide-node';
    const demoKey = await registerIn('dev-key', sharedId);
    const acmeKey = await registerIn('acme-key', sharedId);
    const gammaKey = await registerIn('gamma-key', sharedId);

    // Ten beats each: on the old shared key both tenants would run dry after
    // five rounds (10 total), not after ten each.
    for (let beatNumber = 1; beatNumber <= 10; beatNumber += 1) {
      const demoBeat = await beat(sharedId, demoKey);
      assert.equal(demoBeat.status, 200, `demo beat ${beatNumber}: ${demoBeat.text}`);
      const acmeBeat = await beat(sharedId, acmeKey);
      assert.equal(acmeBeat.status, 200, `acme beat ${beatNumber}: ${acmeBeat.text}`);
    }

    // The 11th beat is still limited per tenant, with the same 429 contract.
    for (const [tenant, key] of [
      ['demo', demoKey],
      ['acme', acmeKey],
    ] as const) {
      const limited = await beat(sharedId, key);
      assert.equal(limited.status, 429, `${tenant} 11th beat must be limited`);
      assert.equal(limited.body.error.code, 'rate_limited');
      const retryAfter = Number(limited.headers.get('retry-after'));
      assert.ok(
        Number.isFinite(retryAfter) && retryAfter >= 58 && retryAfter <= 60,
        `${tenant} retry-after must be ~60s, got ${limited.headers.get('retry-after')}`,
      );
    }

    // A third tenant's node with the same id keeps its own bucket untouched.
    const gammaBeat = await beat(sharedId, gammaKey);
    assert.equal(gammaBeat.status, 200, `gamma must not be throttled by demo/acme: ${gammaBeat.text}`);
  } finally {
    await scoped.close();
  }
});

test('P2-5: node key TTL expires heartbeat; admin rotation issues a new key and revokes the old', async () => {
  const created = await createToken({ kind: 'node', role: 'sfu' });
  const registration = await registerNode(created.token, { nodeId: 'key-ttl-node', keyTtlSec: 1 });
  assert.equal(registration.status, 201, registration.text);
  const oldKey = registration.body.nodeKey as string;
  assert.equal(typeof registration.body.keyExpiresAt, 'number');
  assert.equal(registration.body.node.keyExpiresAt, registration.body.keyExpiresAt);
  assert.equal(registration.body.node.keyRotatedAt, null);

  await delay(1200);
  const expired = await heartbeat('key-ttl-node', oldKey);
  assert.equal(expired.status, 401);
  assert.match(expired.body.error.message, /expired/i);
  assert.match(expired.body.error.message, /rotate/i);

  const rotated = await ts.api('POST', '/v1/admin/nodes/key-ttl-node/rotate-key', {
    headers: ADMIN,
    body: { keyTtlSec: 3600 },
  });
  assert.equal(rotated.status, 200, rotated.text);
  const newKey = rotated.body.nodeKey as string;
  assert.match(newKey, /^nk_[A-Za-z0-9_-]{20,}$/);
  assert.notEqual(newKey, oldKey);
  assert.equal(rotated.body.heartbeatIntervalSec, 30);
  assert.equal(typeof rotated.body.keyExpiresAt, 'number');
  assert.equal(rotated.body.node.keyRotatedAt > 0, true);

  assert.equal((await heartbeat('key-ttl-node', oldKey)).status, 401);
  assert.equal((await heartbeat('key-ttl-node', newKey)).status, 200);
  assert.ok(!rotated.text.includes('keyHash'));

  const audit = await ts.api('GET', '/v1/admin/audit?limit=200', { headers: ADMIN });
  assert.ok(
    audit.body.entries.some((entry: { details?: { kind?: string } }) => entry.details?.kind === 'cluster.node.key-rotated'),
  );
  assert.ok(!audit.text.includes(newKey), 'audit must not contain the rotated node key');
  assert.equal(
    (await ts.api('POST', '/v1/admin/nodes/unknown-node/rotate-key', { headers: ADMIN, body: {} })).status,
    404,
  );
});

test('P2-6/P3-R1: AGIL_CLUSTER_ROLE=standby rejects every registry write (leader-only) and stays readable', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-standby-test-'));
  try {
    // Build a real registry on a leader first, then restart the same data dir as
    // a standby: P3-R1 was found with a copied registry, where PATCH/drain/delete
    // returned 200 while token/join/register/heartbeat/rotate returned 409.
    const leader = await startTestServer({ dataDir });
    let nodeId = '';
    let nodeTokenId = '';
    let tokenId = '';
    try {
      const nodeToken = await leader.api('POST', '/v1/admin/cluster/tokens', {
        headers: ADMIN,
        body: { kind: 'node', role: 'sfu' },
      });
      assert.equal(nodeToken.status, 201, nodeToken.text);
      nodeTokenId = nodeToken.body.enrollment.id;
      nodeId = 'standby-gated-node';
      const registration = await leader.api('POST', '/v1/nodes/register', {
        body: { token: nodeToken.body.token, role: 'sfu', nodeId, name: 'Original Name' },
      });
      assert.equal(registration.status, 201, registration.text);
      const coreToken = await leader.api('POST', '/v1/admin/cluster/tokens', {
        headers: ADMIN,
        body: { kind: 'core' },
      });
      assert.equal(coreToken.status, 201, coreToken.text);
      tokenId = coreToken.body.enrollment.id;
    } finally {
      await leader.close();
    }

    const standby = await startTestServer({ dataDir, clusterRole: 'standby' });
    try {
      const create = await standby.api('POST', '/v1/admin/cluster/tokens', {
        headers: ADMIN,
        body: { kind: 'node', role: 'sfu' },
      });
      assert.equal(create.status, 409);
      assert.equal(create.body.error.code, 'not_leader');

      const join = await standby.api('POST', '/v1/cluster/join', {
        body: { token: 'agil_enr_standby_should_not_join_123456', nodeId: 'standby-x' },
      });
      assert.equal(join.status, 409);
      assert.equal(join.body.error.code, 'not_leader');

      const register = await standby.api('POST', '/v1/nodes/register', {
        body: { token: 'agil_enr_standby_should_not_register_123456', role: 'sfu', nodeId: 'node-x' },
      });
      assert.equal(register.status, 409);
      assert.equal(register.body.error.code, 'not_leader');

      const beat = await standby.api('POST', '/v1/nodes/node-x/heartbeat', {
        headers: { 'x-node-token': 'nk_standby_should_not_beat_123456' },
        body: {},
      });
      assert.equal(beat.status, 409);
      assert.equal(beat.body.error.code, 'not_leader');

      // P3-R1: every admin registry mutation is leader-only, including the ones
      // that previously returned 200 on a standby with a copied registry.
      const mutations: Array<[string, string, Record<string, string>, Record<string, unknown>?]> = [
        ['PATCH', `/v1/admin/nodes/${nodeId}`, ADMIN, { name: 'Renamed On Standby' }],
        ['POST', `/v1/admin/nodes/${nodeId}/disable`, ADMIN, { disabled: true }],
        ['POST', `/v1/admin/nodes/${nodeId}/drain`, ADMIN, { drain: true }],
        ['POST', `/v1/admin/nodes/${nodeId}/rotate-key`, ADMIN, {}],
        ['DELETE', `/v1/admin/nodes/${nodeId}`, ADMIN],
        ['DELETE', `/v1/admin/cluster/tokens/${tokenId}`, ADMIN],
      ];
      for (const [method, route, headers, body] of mutations) {
        const response = await standby.api(method, route, body === undefined ? { headers } : { headers, body });
        assert.equal(response.status, 409, `${method} ${route}: ${response.text}`);
        assert.equal(response.body.error.code, 'not_leader', `${method} ${route}`);
      }

      // Read-only surfaces keep working and report the standby role; the local
      // registry is untouched by the rejected mutations.
      const status = await standby.api('GET', '/v1/admin/cluster/status', { headers: ADMIN });
      assert.equal(status.status, 200);
      assert.equal(status.body.cluster.role, 'standby');
      const tokens = await standby.api('GET', '/v1/admin/cluster/tokens', { headers: ADMIN });
      assert.equal(tokens.status, 200);
      assert.deepEqual(
        tokens.body.tokens.map((token: { id: string }) => token.id).sort(),
        [nodeTokenId, tokenId].sort(),
      );
      const nodes = await standby.api('GET', '/v1/admin/nodes', { headers: ADMIN });
      assert.equal(nodes.status, 200);
      assert.equal(nodes.body.nodes.length, 1);
      assert.equal(nodes.body.nodes[0].name, 'Original Name');
      assert.equal(nodes.body.nodes[0].enabled, true);
      assert.equal(nodes.body.nodes[0].drain, false);
      assert.equal(nodes.body.nodes[0].keyRotatedAt, null);
    } finally {
      await standby.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('P2-4: AGIL_ENROLL_ALLOW_IPS fences only the machine enrollment surface', async () => {
  const guarded = await startTestServer({ enrollAllowIps: ['203.0.113.7'] });
  try {
    const register = await guarded.api('POST', '/v1/nodes/register', {
      body: { token: 'agil_enr_blocked_by_enroll_allowlist_123456', role: 'sfu', nodeId: 'blocked-node' },
    });
    assert.equal(register.status, 403);
    assert.equal(register.body.error.code, 'forbidden');
    assert.match(register.body.error.message, /Enrollment API/);

    const join = await guarded.api('POST', '/v1/cluster/join', {
      body: { token: 'agil_enr_blocked_by_enroll_allowlist_123456' },
    });
    assert.equal(join.status, 403);
    const beat = await guarded.api('POST', '/v1/nodes/blocked-node/heartbeat', {
      headers: { 'x-node-token': 'nk_blocked_by_enroll_allowlist_123456' },
      body: {},
    });
    assert.equal(beat.status, 403);

    // Admin API is independent: token creation still works from the same IP.
    const created = await guarded.api('POST', '/v1/admin/cluster/tokens', {
      headers: ADMIN,
      body: { kind: 'node', role: 'sfu' },
    });
    assert.equal(created.status, 201, created.text);

    // With AGIL_TRUST_PROXY the allowlist sees the forwarded client IP.
    const trusted = await startTestServer({ enrollAllowIps: ['203.0.113.7'], trustProxy: true });
    try {
      const allowed = await trusted.api('POST', '/v1/nodes/register', {
        headers: { 'x-forwarded-for': '203.0.113.7' },
        body: { token: 'agil_enr_allowed_but_unknown_123456', role: 'sfu', nodeId: 'allowed-node' },
      });
      // Past the allowlist → normal token validation (401, not 403).
      assert.equal(allowed.status, 401);
      assert.equal(allowed.body.error.code, 'unauthorized');
    } finally {
      await trusted.close();
    }
  } finally {
    await guarded.close();
  }
});

test('P3: endpoint rejects credential-bearing and cloud-metadata URLs', async () => {
  const created = await createToken({ kind: 'node', role: 'sfu' });
  const metadata = await registerNode(created.token, {
    nodeId: 'metadata-node',
    endpoint: 'http://169.254.169.254/latest/meta-data/',
  });
  assert.equal(metadata.status, 400);
  assert.equal(metadata.body.error.code, 'validation_failed');

  const userinfo = await registerNode(created.token, {
    nodeId: 'userinfo-node',
    endpoint: 'https://user:pass@example.com/hook',
  });
  assert.equal(userinfo.status, 400);
  assert.equal(userinfo.body.error.code, 'validation_failed');

  const good = await registerNode(created.token, { nodeId: 'good-endpoint-node', endpoint: 'https://sfu-1.example:7880' });
  assert.equal(good.status, 201, good.text);
  const patched = await ts.api('PATCH', '/v1/admin/nodes/good-endpoint-node', {
    headers: ADMIN,
    body: { endpoint: 'http://169.254.169.254/' },
  });
  assert.equal(patched.status, 400);
  assert.equal(patched.body.error.code, 'validation_failed');
});

test('P3: stale registry lock is reclaimed and the lock is released after a write', async () => {
  const lockFile = path.join(ts.dataDir, 'cluster', 'cluster.json.lock');
  writeFileSync(lockFile, JSON.stringify({ pid: 999_999, at: Date.now() - 60_000 }), 'utf8');
  const created = await createToken({ kind: 'node', role: 'sfu', label: 'lock-check' });
  assert.equal(created.enrollment.status, 'active');
  const registration = await registerNode(created.token, { nodeId: 'lock-node' });
  assert.equal(registration.status, 201, registration.text);
  assert.equal(existsSync(lockFile), false, 'the advisory lock must be released after persist');
  const stored = JSON.parse(readFileSync(path.join(ts.dataDir, 'cluster', 'cluster.json'), 'utf8')) as {
    nodes: Array<{ id: string }>;
  };
  assert.ok(stored.nodes.some((node) => node.id === 'lock-node'));
});

test('P3-R2: a live foreign lock fails the write (503, no phantom token) and a retry survives restart', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-lock-test-'));
  const lockFile = path.join(dataDir, 'cluster', 'cluster.json.lock');
  try {
    const server = await startTestServer({ dataDir });
    try {
      // Simulate another live Core's lock: fresh timestamp, valid JSON, foreign token.
      writeFileSync(lockFile, JSON.stringify({ pid: 999_999, at: Date.now(), token: 'foreign-writer' }), 'utf8');
      const blocked = await server.api('POST', '/v1/admin/cluster/tokens', {
        headers: ADMIN,
        body: { kind: 'node', role: 'sfu', label: 'blocked-by-lock' },
      });
      // P3-R2: previously 201 with the token only in memory (lost on restart).
      assert.equal(blocked.status, 503, blocked.text);
      assert.equal(blocked.body.error.code, 'registry_unavailable');
      assert.equal(existsSync(lockFile), true, 'a foreign lock must be preserved, not deleted');

      // The failed mutation must be rolled back in memory and on disk.
      const listed = await server.api('GET', '/v1/admin/cluster/tokens', { headers: ADMIN });
      assert.equal(listed.status, 200);
      assert.ok(
        !listed.body.tokens.some((token: { label: string }) => token.label === 'blocked-by-lock'),
        'a write that returned 503 must not stay visible in memory',
      );
      assert.ok(
        !readFileSync(path.join(dataDir, 'cluster', 'cluster.json'), 'utf8').includes('blocked-by-lock'),
        'a write that returned 503 must not reach the registry file',
      );

      // Once the foreign lock is gone, the same operation succeeds...
      rmSync(lockFile, { force: true });
      const retried = await server.api('POST', '/v1/admin/cluster/tokens', {
        headers: ADMIN,
        body: { kind: 'node', role: 'sfu', label: 'after-lock-release' },
      });
      assert.equal(retried.status, 201, retried.text);
      assert.equal(existsSync(lockFile), false, 'the lock must be released after a successful write');
    } finally {
      await server.close();
    }

    // ...and a restart keeps the token (restart durability).
    const restarted = await startTestServer({ dataDir });
    try {
      const tokens = await restarted.api('GET', '/v1/admin/cluster/tokens', { headers: ADMIN });
      assert.equal(tokens.status, 200);
      assert.ok(
        tokens.body.tokens.some((token: { label: string }) => token.label === 'after-lock-release'),
        'a token persisted by a successful write must survive a restart',
      );
      assert.ok(
        !tokens.body.tokens.some((token: { label: string }) => token.label === 'blocked-by-lock'),
        'the rolled-back token must not reappear after a restart',
      );
    } finally {
      await restarted.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('P3: node list pagination is opt-in and keeps the full list by default', async () => {
  const all = await ts.api('GET', '/v1/admin/nodes', { headers: ADMIN });
  assert.equal(all.status, 200);
  assert.ok(all.body.nodes.length > 2);
  assert.equal(all.body.total, undefined, 'default response stays compatible');

  const page = await ts.api('GET', '/v1/admin/nodes?limit=2&offset=1', { headers: ADMIN });
  assert.equal(page.status, 200);
  assert.equal(page.body.limit, 2);
  assert.equal(page.body.offset, 1);
  assert.equal(page.body.total, all.body.nodes.length);
  assert.equal(page.body.nodes.length, 2);
  assert.deepEqual(
    page.body.nodes.map((node: { id: string }) => node.id),
    all.body.nodes.slice(1, 3).map((node: { id: string }) => node.id),
  );
});
