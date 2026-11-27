import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { loadEnv } from '../src/env.js';
import { RtmpIngressOwnershipStore } from '../src/ingress-ownership.js';
import { LeaderElector } from '../src/leader.js';
import { RedisClient } from '../src/redis-client.js';

const redisUrl = process.env.AGIL_TEST_REDIS_URL?.trim() || '';
const scope = { tenantId: 'demo', flowId: 'input' };
const room = { tenantId: scope.tenantId, id: 'video_1' };

test('RTMP ownership rejects foreign rooms and ambiguous legacy room names before reserving', async () => {
  const store = new RtmpIngressOwnershipStore({
    leaderValue: async () => { throw new Error('Invalid ownership must not contact Redis'); },
  });
  await assert.rejects(store.reserve(scope, { ...room, tenantId: 'other' }), { code: 'foreign_ingress_room' });
  await assert.rejects(store.reserve(scope, { ...room, id: 'video__1' }), { code: 'ambiguous_ingress_room' });
  await assert.rejects(store.reserve({ ...scope, tenantId: 'org__team' }, { ...room, tenantId: 'org__team' }), {
    code: 'ambiguous_ingress_room',
  });
});

function elector(clusterId: string, clusterNodeId: string, prefix = 'agil-ingress-test'): LeaderElector {
  return new LeaderElector({
    env: loadEnv({
      redisUrl, redisKeyPrefix: prefix, clusterNodeId, clusterRole: 'leader',
      leaderLeaseTtlMs: 2300, leaderRenewIntervalMs: 500, leaderRetryIntervalMs: 120,
    }),
    clusterId, version: 'qa', publicOrigin: '',
  });
}

test('RTMP ownership survives Core takeover and preserves tenant, room and receiver generation', {
  skip: !redisUrl && 'Set AGIL_TEST_REDIS_URL to run against Redis',
}, async (t) => {
  const clusterId = 'ingress-' + randomUUID();
  const first = elector(clusterId, 'qa-owner-first');
  const successor = elector(clusterId, 'qa-owner-next');
  t.after(async () => { await Promise.all([first.close(), successor.close()]); });
  await first.start();
  await successor.start();
  assert.ok(first.isLeader() && !successor.isLeader());
  const oldStore = new RtmpIngressOwnershipStore(first);
  const newStore = new RtmpIngressOwnershipStore(successor);
  await assert.rejects(newStore.reserve(scope, room), { code: 'not_leader' });

  const settled = await Promise.allSettled([oldStore.reserve(scope, room), oldStore.reserve(scope, room)]);
  const [accepted, rejected] = settled.sort((left, right) => left.status.localeCompare(right.status));
  assert.ok(accepted?.status === 'fulfilled' && rejected?.status === 'rejected');
  assert.equal(rejected.reason.code, 'ingress_already_reserved');
  const reservation = accepted.value;
  assert.equal(reservation.roomName, 'demo__video_1');
  const handle = { id: 'IN_fixture_1', roomName: reservation.roomName, participantIdentity: reservation.participantIdentity };
  await assert.rejects(oldStore.bind(reservation, { ...handle, participantIdentity: 'someone-else' }), {
    code: 'ingress_binding_mismatch',
  });
  const providerResponse = { ...handle, streamKey: 'test-only-value' };
  const installed = await oldStore.bind(reservation, providerResponse);
  assert.deepEqual(await oldStore.get(scope), installed);
  assert.equal('streamKey' in installed, false);
  assert.equal(await oldStore.get({ ...scope, tenantId: 'other' }), null);

  first.disconnect();
  const deadline = Date.now() + 7000;
  while (!successor.isLeader() && Date.now() < deadline) await delay(100);
  assert.equal(successor.isLeader(), true);
  await assert.rejects(oldStore.beginRevoke(installed), { code: 'not_leader' });
  const recovered = await newStore.get(scope);
  assert.ok(recovered?.phase === 'bound');
  assert.deepEqual(recovered, installed);
  const revoking = await newStore.beginRevoke(recovered);
  assert.deepEqual(await newStore.get(scope), revoking);
  await assert.rejects(newStore.bind(reservation, handle), { code: 'ingress_ownership_changed' });
  await newStore.finishRevoke(revoking);
  assert.equal(await newStore.get(scope), null);
  const replacement = await newStore.reserve(scope, { ...room, id: 'next-room' });
  assert.notEqual(replacement.participantIdentity, reservation.participantIdentity);
  await assert.rejects(newStore.finishRevoke(revoking), { code: 'ingress_ownership_changed' });
  assert.deepEqual(await newStore.get(scope), replacement);
  const replacementHandle = { id: 'IN_fixture_2', roomName: replacement.roomName, participantIdentity: replacement.participantIdentity };
  await newStore.finishRevoke(await newStore.beginRevoke(await newStore.bind(replacement, replacementHandle)));
});

test('RTMP ownership Redis lease check fences a stale local leader before committing', {
  skip: !redisUrl && 'Set AGIL_TEST_REDIS_URL to run against Redis',
}, async (t) => {
  const clusterId = 'ingress-' + randomUUID();
  const prefix = 'agil-ingress-fence-test';
  const first = elector(clusterId, 'qa-fence-first', prefix);
  const redis = new RedisClient({ url: redisUrl });
  t.after(async () => { await first.close(); redis.close(); });
  await first.start();
  await redis.connect();
  assert.equal(first.isLeader(), true);
  const store = new RtmpIngressOwnershipStore(first);
  const leaseKey = `${prefix}:cluster:${clusterId}:leader`;
  await redis.command(['SET', leaseKey, 'replacement-holder', 'PX', 1000]);
  assert.equal(first.isLeader(), true, 'the old Core still has a locally valid deadline');
  await assert.rejects(store.reserve(scope, room), { code: 'not_leader' });
  assert.equal(first.isLeader(), false);
  const digest = createHash('sha256').update(JSON.stringify([scope.tenantId, scope.flowId])).digest('hex');
  assert.equal(await redis.command(['GET', `${prefix}:cluster:${clusterId}:state:value:rtmp-ingress:${digest}`]), null);
});
