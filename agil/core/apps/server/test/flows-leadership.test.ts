import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { flowSchema } from '@agil/protocol';
import { RedisClient } from '../src/redis-client.js';
import { startTestServer } from './helpers.js';

const headers = { 'x-api-key': 'dev-key' };
const source = { kind: 'room', roomId: 'qa-room' };
const sink = { kind: 'room', roomId: 'qa-room' };
const flow = { id: 'qa-flow', name: 'Initial', sources: [source], sinks: [sink] };
const route = '/v1/admin/flows/' + flow.id;
const redisUrl = process.env.AGIL_TEST_REDIS_URL?.trim() || '';
const redisPrefix = 'agil-flow-leadership-test';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

test('a failed flow snapshot replacement is reported and the staged change stays out of reads', async (t) => {
  const core = await startTestServer();
  t.after(() => core.close());
  const listed = await core.api('GET', '/v1/admin/flows', { headers });
  assert.deepEqual(listed.body.flows, []);
  await mkdir(path.join(core.dataDir, 'flows', 'demo.json'), { recursive: true });
  const created = await core.api('POST', '/v1/admin/flows', { headers, body: flow });
  assert.equal(created.status, 503);
  assert.equal(created.body.error.code, 'flow_storage_unavailable');
  assert.equal((await core.api('GET', route, { headers })).status, 404);
});

test('flow writes use the active Core and takeover discards the previous cached definition', {
  skip: !redisUrl && 'Set AGIL_TEST_REDIS_URL to run against Redis',
}, async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'agil-flow-failover-'));
  const clusterId = 'qa-flow-' + randomUUID();
  const env = {
    dataDir, clusterId, redisUrl, redisKeyPrefix: 'agil-flow-leadership-test',
    leaderLeaseTtlMs: 2300, leaderRenewIntervalMs: 500, leaderRetryIntervalMs: 120,
  };
  const primary = await startTestServer({ ...env, clusterNodeId: 'qa-flow-primary' });
  const standby = await startTestServer({ ...env, clusterNodeId: 'qa-flow-successor' });
  t.after(async () => {
    await Promise.all([primary.close(), standby.close()]);
    await rm(dataDir, { force: true, recursive: true });
  });
  assert.ok(primary.server.leader.isLeader() && !standby.server.leader.isLeader());
  const initial = await primary.api('POST', '/v1/admin/flows', { headers, body: flow });
  assert.equal(initial.status, 200, initial.text);
  assert.equal((await standby.api('GET', route, { headers })).body.flow.name, 'Initial');
  for (const response of await Promise.all([
    standby.api('POST', '/v1/admin/flows', { headers, body: { ...flow, id: 'standby-write' } }),
    standby.api('PATCH', route, { headers, body: { name: 'Standby edit' } }),
    standby.api('DELETE', route, { headers }),
    standby.api('POST', route + '/test', { headers, body: { apply: false } }),
    standby.api('POST', '/v1/admin/flows/tick', { headers }),
  ])) {
    assert.equal(response.status, 409, response.text);
    assert.equal(response.body.error.code, 'not_leader');
  }
  const concurrent = await Promise.all([
    primary.api('PATCH', route, { headers, body: { name: 'Latest' } }),
    primary.api('PATCH', route, { headers, body: { description: 'Concurrent field' } }),
  ]);
  assert.ok(concurrent.every((response) => response.status === 200));
  primary.server.leader.disconnect();
  const deadline = Date.now() + 7500;
  while (!standby.server.leader.isLeader() && Date.now() < deadline) await delay(100);
  assert.ok(standby.server.leader.isLeader());
  const afterTakeover = await standby.api('GET', route, { headers });
  assert.equal(afterTakeover.body.flow.name, 'Latest');
  assert.equal(afterTakeover.body.flow.description, 'Concurrent field');
  const former = await primary.api('DELETE', route, { headers });
  assert.ok(['not_leader', 'shared_state_unavailable'].includes(former.body.error?.code), former.text);
  assert.equal((await standby.api('DELETE', route, { headers })).status, 200);
  assert.equal((await standby.api('GET', route, { headers })).status, 404);
  const snapshot = JSON.parse(await readFile(path.join(dataDir, 'flows', 'demo.json'), 'utf8'));
  assert.deepEqual(snapshot.flows, []);
});

test('an in-flight flow run on the former Core cannot overwrite flow metadata after takeover', {
  skip: !redisUrl && 'Set AGIL_TEST_REDIS_URL to run against Redis',
}, async (t) => {
  let requestStarted!: () => void;
  let allowResponse!: () => void;
  const received = new Promise<void>((resolve) => { requestStarted = resolve; });
  const release = new Promise<void>((resolve) => { allowResponse = resolve; });
  const receiver = createServer(async (_request, response) => {
    requestStarted();
    await release;
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const port = (receiver.address() as AddressInfo).port;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'agil-stale-flow-run-'));
  const env = {
    dataDir, clusterId: 'qa-flow-' + randomUUID(), redisUrl, redisKeyPrefix: 'agil-flow-leadership-test',
    leaderLeaseTtlMs: 2200, leaderRenewIntervalMs: 500, leaderRetryIntervalMs: 120,
  };
  const first = await startTestServer({ ...env, clusterNodeId: 'qa-run-first' });
  const next = await startTestServer({ ...env, clusterNodeId: 'qa-run-next' });
  t.after(async () => {
    allowResponse();
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await Promise.all([first.close(), next.close()]);
    await rm(dataDir, { force: true, recursive: true });
  });
  const room = await first.api('POST', '/v1/admin/rooms', { headers, body: { name: 'Failover room' } });
  assert.equal(room.status, 200, room.text);
  const created = await first.api('POST', '/v1/admin/flows', {
    headers,
    body: {
      ...flow,
      sources: [{ ...source, roomId: room.body.room.id }],
      sinks: [{ kind: 'webhook', url: `http://127.0.0.1:${port}/qa`, events: ['started'] }],
    },
  });
  assert.equal(created.status, 200, created.text);
  const inFlight = first.api('POST', route + '/test', { headers, body: { apply: true } });
  await Promise.race([received, delay(2500).then(() => { throw new Error('Webhook was not reached'); })]);
  first.server.leader.disconnect();
  const deadline = Date.now() + 7500;
  while (!next.server.leader.isLeader() && Date.now() < deadline) await delay(100);
  assert.ok(next.server.leader.isLeader());
  const updated = await next.api('PATCH', route, { headers, body: { name: 'Successor' } });
  assert.equal(updated.status, 200, updated.text);
  allowResponse();
  const rejected = await inFlight;
  assert.equal(rejected.body.error.code, 'not_leader', rejected.text);
  const snapshot = JSON.parse(await readFile(path.join(dataDir, 'flows', 'demo.json'), 'utf8'));
  assert.equal(snapshot.flows[0].name, 'Successor');
  assert.equal(snapshot.flows[0].lastRun, undefined);
});

test('Redis shares revisioned flow configurations across separate Core disks and keeps deletions after takeover', {
  skip: !redisUrl && 'Set AGIL_TEST_REDIS_URL to run against Redis',
}, async (t) => {
  const firstDir = await mkdtemp(path.join(tmpdir(), 'agil-flow-first-'));
  const secondDir = await mkdtemp(path.join(tmpdir(), 'agil-flow-second-'));
  const clusterId = 'qa-flow-' + randomUUID();
  const coreOptions = {
    clusterId, redisUrl, redisKeyPrefix: redisPrefix, flowStore: 'redis' as const,
    leaderLeaseTtlMs: 2300, leaderRenewIntervalMs: 500, leaderRetryIntervalMs: 120,
  };
  const cores: Array<Awaited<ReturnType<typeof startTestServer>>> = [];
  const redis = new RedisClient({ url: redisUrl });
  const keyRoot = `${redisPrefix}:cluster:${clusterId}:state:value:flows:`;
  const snapshotKey = keyRoot + 'tenant:' + digest('demo');
  t.after(async () => {
    await Promise.all(cores.map((core) => core.close()));
    await redis.command(['DEL', snapshotKey, keyRoot + 'bootstrap']).catch(() => {});
    redis.close();
    await Promise.all([firstDir, secondDir].map((dir) => rm(dir, { recursive: true, force: true })));
  });
  const legacy = await startTestServer({ dataDir: firstDir, redisUrl: '', flowStore: 'file' });
  try {
    assert.equal((await legacy.api('POST', '/v1/admin/flows', { headers, body: flow })).status, 200);
  } finally {
    await legacy.close();
  }
  const legacyPath = path.join(firstDir, 'flows', 'demo.json');
  const legacySnapshot = JSON.parse(await readFile(legacyPath, 'utf8'));
  delete legacySnapshot.revision;
  await writeFile(legacyPath, JSON.stringify(legacySnapshot));
  const stalePath = path.join(secondDir, 'flows', 'demo.json');
  await mkdir(path.dirname(stalePath));
  await writeFile(stalePath, JSON.stringify({
    ...legacySnapshot, flows: [{ ...legacySnapshot.flows[0], name: 'Independent stale disk' }],
  }));
  await redis.connect();
  const snapshot = async () => JSON.parse(String(await redis.command(['GET', snapshotKey])));
  const first = await startTestServer({ ...coreOptions, dataDir: firstDir, clusterNodeId: 'qa-shared-first' });
  cores.push(first);
  assert.equal((await first.api('GET', route, { headers })).body.flow.name, 'Initial');
  assert.equal((await snapshot()).revision, 0);
  const second = await startTestServer({ ...coreOptions, dataDir: secondDir, clusterNodeId: 'qa-shared-next' });
  cores.push(second);
  assert.equal((await second.api('GET', route, { headers })).body.flow.name, 'Initial');
  assert.equal((await second.api('GET', route, { headers: { 'x-api-key': 'acme-key' } })).status, 404);
  const patches = await Promise.all([
    first.api('PATCH', route, { headers, body: { name: 'Latest Redis configuration' } }),
    first.api('PATCH', route, { headers, body: { description: 'Other concurrent change' } }),
  ]);
  assert.ok(patches.every(({ status }) => status === 200));
  const live = await second.api('GET', route, { headers });
  assert.equal(live.body.flow.name, 'Latest Redis configuration');
  assert.equal(live.body.flow.description, 'Other concurrent change');
  assert.equal((await snapshot()).revision, 2);
  first.server.leader.disconnect();
  const deadline = Date.now() + 7500;
  while (!second.server.leader.isLeader() && Date.now() < deadline) await delay(100);
  assert.ok(second.server.leader.isLeader());
  assert.equal((await second.api('PATCH', route, { headers, body: { priority: 25 } })).status, 200);
  assert.equal((await first.api('PATCH', route, { headers, body: { priority: 5 } })).body.error.code, 'not_leader');
  assert.equal((await snapshot()).revision, 3);
  assert.equal((await second.api('DELETE', route, { headers })).status, 200);
  assert.deepEqual(await snapshot(), { version: 1, revision: 4, flows: [] });
  assert.equal((await second.api('GET', route, { headers })).status, 404);
  assert.equal(JSON.parse(await readFile(stalePath, 'utf8')).flows[0].name, 'Independent stale disk');
  await second.close();
  const restarted = await startTestServer({ ...coreOptions, dataDir: secondDir, clusterNodeId: 'qa-shared-restart' });
  cores.push(restarted);
  assert.ok(restarted.server.leader.isLeader());
  assert.equal((await restarted.api('GET', route, { headers })).status, 404);
  assert.equal((await restarted.api('POST', '/v1/admin/flows', { headers, body: flow })).status, 200);
  assert.equal((await snapshot()).revision, 5);
});

test('interrupted flow migration waits for the original file before enabling writes', {
  skip: !redisUrl && 'Set AGIL_TEST_REDIS_URL to run against Redis',
}, async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'agil-flow-migration-'));
  const clusterId = 'qa-flow-' + randomUUID();
  const keyRoot = `${redisPrefix}:cluster:${clusterId}:state:value:flows:`;
  const redis = new RedisClient({ url: redisUrl });
  const core = await startTestServer({
    dataDir, clusterId, redisUrl, redisKeyPrefix: redisPrefix, flowStore: 'redis', clusterNodeId: 'qa-flow-migration',
  });
  t.after(async () => {
    await core.close();
    await redis.command(['DEL', keyRoot + 'bootstrap', keyRoot + 'tenant:' + digest('demo')]).catch(() => {});
    redis.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await redis.connect();
  const saved = flowSchema.parse({
    ...flow, tenantId: 'demo', createdAt: 1, updatedAt: 1, enabled: true, priority: 100,
    processors: [], triggers: [{ kind: 'manual' }],
  });
  const config = JSON.stringify({ version: 1, revision: 0, flows: [saved] });
  await redis.command(['SET', keyRoot + 'bootstrap', JSON.stringify([{ tenantId: 'demo', digest: digest(config) }])]);
  const pending = await core.api('POST', '/v1/admin/flows', { headers, body: { ...flow, id: 'premature' } });
  assert.equal(pending.status, 503, pending.text);
  const diskPath = path.join(dataDir, 'flows', 'demo.json');
  await mkdir(path.dirname(diskPath), { recursive: true });
  await writeFile(diskPath, config);
  assert.equal((await core.api('GET', route, { headers })).body.flow.name, 'Initial');
  assert.equal(await redis.command(['GET', keyRoot + 'bootstrap']), 'ready-v1');
  assert.equal((await core.api('GET', '/v1/admin/flows/premature', { headers })).status, 404);
});
