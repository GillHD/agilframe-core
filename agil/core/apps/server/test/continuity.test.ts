/**
 * Live-call continuity (docs/call-continuity.md):
 *   - room snapshot persistence and restore after a Core restart;
 *   - duplicate join / resume without a duplicate peer;
 *   - resumed/restored billing and capacity (P2 fixes);
 *   - TTL cleanup of stale snapshots and offline participants;
 *   - tenant isolation of snapshots and resume tokens;
 *   - drain marking keeps rooms joinable;
 *   - Redis-compatible store key layout (fake RESP client), stale-index pruning;
 *   - close-during-flush ordering and exotic tenant ids in the global list.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgilServer, type AgilServer, type CreateServerOptions } from '../src/index.js';
import { silentLogger } from '../src/logger.js';
import { issueToken } from '../src/auth.js';
import { loadEnv } from '../src/env.js';
import { RoomRegistry, type RoomConnection } from '../src/rooms.js';
import {
  FileRoomSnapshotStore,
  MemoryRoomSnapshotStore,
  RedisRoomSnapshotStore,
  RoomContinuity,
  hashResumeToken,
  issueResumeToken,
  type RoomSnapshot,
  type RoomSnapshotRedis,
} from '../src/continuity.js';
import { delay, openWs, startTestServer, waitForClose, type WsClient } from './helpers.js';

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'agil-continuity-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function boot(dataDir: string, overrides: Partial<CreateServerOptions> = {}): Promise<AgilServer> {
  return createAgilServer({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    tokenSecret: 'test-secret-0123456789',
    apiKeys: { 'dev-key': 'demo', 'acme-key': 'acme' },
    allowAnonymous: true,
    publicOrigin: 'http://127.0.0.1:1',
    logger: silentLogger,
    ...overrides,
  });
}

function wsUrl(server: AgilServer, query: Record<string, string> = {}): string {
  const url = new URL(`ws://127.0.0.1:${server.port}/ws`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

function joinToken(server: AgilServer, roomId: string, participantId: string, name: string, tenantId = 'demo'): string {
  return issueToken(server.env, { tenantId, roomId, participantId, name, role: 'guest' }).token;
}

test('file snapshots preserve pending and admitted lobby requests through restarts', async () => {
  const dataDir = tempDir();
  let core = await boot(dataDir);
  const request = async (method: string, route: string, body?: object, admin = false) => {
    const response = await fetch(`http://127.0.0.1:${core.port}${route}`, {
      method,
      headers: {
        ...(admin ? { 'x-api-key': 'dev-key' } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.deepEqual(await request('GET', '/v1/ready'), { status: 200, body: { ready: true } });
    const created = await request('POST', '/v1/rooms', { name: 'Restart lobby', configOverrides: { security: { waitingRoom: true } } }, true);
    assert.equal(created.status, 200);
    const room = `/v1/rooms/${created.body.room.id}`;
    const pending = await request('POST', room + '/join', { name: 'Waiting' });
    const admitted = await request('POST', room + '/join', { name: 'Admitted' });
    assert.equal(pending.status, 202);
    assert.equal(admitted.status, 202);
    const pendingUrl = `${room}/lobby/${pending.body.requestId}`;
    const admittedUrl = `${room}/lobby/${admitted.body.requestId}`;
    const accepted = await request('POST', admittedUrl + '/admit', undefined, true);
    assert.equal(accepted.status, 200);
    await core.close();
    core = await boot(dataDir);
    assert.deepEqual(await request('GET', pendingUrl), { status: 200, body: {
      requestId: pending.body.requestId, status: 'pending', expiresAt: pending.body.expiresAt,
    } });
    assert.equal((await request('GET', admittedUrl)).body.token, accepted.body.token);
    await core.close();
    core = await boot(dataDir);
    const repeat = await request('GET', admittedUrl);
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.status, 'admitted');
    assert.equal(repeat.body.token, undefined);
    assert.equal(repeat.body.joinUrl, undefined);
    assert.equal(repeat.body.embedUrl, undefined);
    assert.equal((await request('POST', pendingUrl + '/cancel', { cancelToken: pending.body.cancelToken })).status, 200);
  } finally {
    await core.close();
  }
});

/** Opens a socket; `resumeToken` travels in the subprotocol, never the URL. */
function openClient(
  server: AgilServer,
  token: string,
  options: { resume?: boolean; resumeToken?: string } = {},
): Promise<WsClient> {
  const protocols = ['agil-calls.v1', `agil-token.${encodeURIComponent(token)}`];
  if (options.resumeToken) protocols.push(`agil-resume.${encodeURIComponent(options.resumeToken)}`);
  const query: Record<string, string> = { token };
  if (options.resume) query.resume = '1';
  return openWs(wsUrl(server, query), protocols);
}

function makeSnapshot(
  tenantId: string,
  roomId: string,
  options: { expiresAt?: number; participantId?: string; sfuNodeId?: string; participants?: number } = {},
): RoomSnapshot {
  const participantId = options.participantId ?? 'p1';
  const memberCount = options.participants ?? 1;
  return {
    version: 1,
    tenantId,
    room: {
      id: roomId,
      name: `room ${roomId}`,
      createdAt: 1_700_000_000_000,
      lastActivityAt: 1_700_000_010_000,
      locked: false,
      maxParticipants: 10,
      ttlSec: 0,
      mode: 'group',
      mediaMode: 'sfu',
    },
    participants: Array.from({ length: memberCount }, (_, index) => ({
      participant: {
        id: index === 0 ? participantId : `${participantId}-${index}`,
        name: `Guest ${index}`,
        role: 'guest' as const,
        joinedAt: 1_700_000_000_000,
        state: { mic: 'on' as const, cam: 'on' as const, screen: false, handRaised: false, network: 'good' as const },
        verified: false,
        integrity: 'unknown' as const,
        permissions: ['chat'],
      },
      joinedAt: 1_700_000_000_000,
      resumeCapable: false,
    })),
    permissions: { [participantId]: ['chat'] },
    sfu: options.sfuNodeId ? { nodeId: options.sfuNodeId, room: `${tenantId}__${roomId}`, provider: 'external', mode: 'sfu' } : null,
    draining: false,
    savedAt: Date.now(),
    expiresAt: options.expiresAt ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* Snapshot / restore                                                  */
/* ------------------------------------------------------------------ */

test('new room pins use SFU readiness without changing ongoing room pins or node liveness', async () => {
  const dataDir = tempDir();
  let core = await startTestServer({ dataDir });
  const headers = { 'x-api-key': 'dev-key' };
  try {
    const register = async (nodeId: string, features: string[]) => {
      const issued = await core.api('POST', '/v1/admin/cluster/tokens', { headers, body: { kind: 'node', role: 'all' } });
      assert.equal(issued.status, 201);
      const registered = await core.api('POST', '/v1/nodes/register', {
        body: { token: issued.body.token, nodeId, role: 'all', features },
      });
      assert.equal(registered.status, 201);
      return async (body: { sfuReady?: boolean; status?: 'online' | 'offline' }) => {
        const beat = await core.api('POST', `/v1/nodes/${nodeId}/heartbeat`, {
          headers: { 'x-node-token': registered.body.nodeKey }, body,
        });
        assert.equal(beat.status, 200);
        return beat.body.node;
      };
    };
    const relay = await register('a-turn-stun', ['turn', 'stun']);
    await relay({});
    await register('aa-waiting-for-first-heartbeat', ['sfu']);
    const first = await register('b-sfu', ['sfu', 'turn']);
    const second = await register('c-legacy', []);
    const createRoom = (name: string) => core.server.rooms.create({
      id: name, tenantId: 'demo', name, mediaMode: 'sfu', maxParticipants: 10,
    });

    assert.equal((await first({ sfuReady: false })).status, 'online');
    assert.equal((await second({})).sfuReady, undefined);
    const existing = createRoom('existing');
    assert.equal(existing.sfuNodeId, 'c-legacy');
    await first({ sfuReady: true });
    const onFirst = createRoom('new-ready');
    assert.equal(onFirst.sfuNodeId, 'b-sfu');
    assert.equal(existing.sfuNodeId, 'c-legacy');

    const configure = async (features: string[]) => {
      const response = await core.api('PATCH', '/v1/admin/nodes/b-sfu', { headers, body: { features } });
      assert.equal(response.status, 200, response.text);
      return response.body.node;
    };
    await configure(['turn']);
    await first({ sfuReady: true });
    assert.equal(createRoom('new-sfu-disabled').sfuNodeId, 'c-legacy');
    assert.equal((await configure(['sfu', 'turn'])).sfuReady, false);
    assert.equal(createRoom('new-sfu-waiting').sfuNodeId, 'c-legacy');
    assert.equal(onFirst.sfuNodeId, 'b-sfu');
    assert.equal((await first({ sfuReady: true })).sfuReady, true);
    assert.equal(createRoom('new-sfu-restored').sfuNodeId, 'b-sfu');

    await configure([]);
    const emptyFeaturesBeat = await first({ sfuReady: true });
    assert.equal(createRoom('new-sfu-empty-features').sfuNodeId, 'c-legacy');
    assert.equal(emptyFeaturesBeat.sfuReady, false);
    await core.close();
    core = await startTestServer({ dataDir });
    assert.equal((await first({ sfuReady: true })).sfuReady, false);
    assert.equal(createRoom('new-sfu-empty-after-restart').sfuNodeId, 'c-legacy');
    assert.equal(core.server.rooms.get(onFirst.id)?.sfuNodeId, 'b-sfu');
    assert.equal((await configure(['sfu', 'turn'])).sfuReady, false);
    assert.equal(createRoom('new-sfu-empty-rollback-waiting').sfuNodeId, 'c-legacy');
    await first({ sfuReady: true });
    assert.equal(createRoom('new-sfu-empty-rollback-ready').sfuNodeId, 'b-sfu');

    const updateRole = (role: string) => core.api('PATCH', '/v1/admin/nodes/b-sfu', { headers, body: { role } });
    assert.equal((await updateRole('turn')).status, 200);
    assert.equal((await first({ sfuReady: true })).sfuReady, false);
    assert.equal(createRoom('new-sfu-role-off').sfuNodeId, 'c-legacy');
    const roleRestored = await updateRole('all');
    assert.equal(roleRestored.status, 200);
    assert.equal(roleRestored.body.node.sfuReady, false);
    assert.equal(createRoom('new-sfu-role-waiting').sfuNodeId, 'c-legacy');
    assert.equal((await first({ sfuReady: true })).sfuReady, true);
    assert.equal(createRoom('new-sfu-role-restored').sfuNodeId, 'b-sfu');
    assert.equal(onFirst.sfuNodeId, 'b-sfu');

    const dedicated = await updateRole('sfu');
    assert.equal(dedicated.status, 200, dedicated.text);
    assert.equal((await first({ sfuReady: true })).sfuReady, true);
    assert.equal((await configure([])).sfuReady, false);
    assert.equal((await first({ sfuReady: true })).sfuReady, false);
    assert.equal(createRoom('new-dedicated-sfu-disabled').sfuNodeId, 'c-legacy');
    assert.equal((await configure(['sfu'])).sfuReady, false);
    assert.equal(createRoom('new-dedicated-sfu-waiting').sfuNodeId, 'c-legacy');
    assert.equal((await first({ sfuReady: true })).sfuReady, true);
    assert.equal(createRoom('new-dedicated-sfu-restored').sfuNodeId, 'b-sfu');
    assert.equal(onFirst.sfuNodeId, 'b-sfu');

    await first({ status: 'offline' });
    assert.equal((await first({ status: 'online' })).sfuReady, false);
    assert.equal(createRoom('new-after-offline').sfuNodeId, 'c-legacy');
  } finally {
    await core.close();
  }
});

test('direct SFU placement skips nodes at the effective room limit', async () => {
  const endpoints = new Map([['a-sfu', 'wss://a.example.test'], ['b-sfu', 'wss://b.example.test']]);
  const core = await startTestServer({ sfuNodeUrls: new Map([['demo', endpoints]]) });
  const headers = { 'x-api-key': 'dev-key' };
  try {
    for (const nodeId of endpoints.keys()) {
      const issued = await core.api('POST', '/v1/admin/cluster/tokens', { headers, body: { kind: 'node', role: 'sfu' } });
      assert.equal(issued.status, 201);
      const registered = await core.api('POST', '/v1/nodes/register', {
        body: { token: issued.body.token, nodeId, role: 'sfu' },
      });
      assert.equal(registered.status, 201);
      const configured = await core.api('PATCH', `/v1/admin/nodes/${nodeId}`, {
        headers, body: { capacity: { maxRooms: nodeId === 'a-sfu' ? 1 : 2 } },
      });
      assert.equal(configured.status, 200);
      const beat = await core.api('POST', `/v1/nodes/${nodeId}/heartbeat`, {
        headers: { 'x-node-token': registered.body.nodeKey }, body: { sfuReady: true, capacity: { maxRooms: 42 } },
      });
      assert.equal(beat.status, 200);
    }
    const createRoom = (id: string) => core.server.rooms.create({ id, tenantId: 'demo', name: id, mediaMode: 'sfu', maxParticipants: 5 });
    const first = createRoom('first');
    assert.equal(first.sfuNodeId, 'a-sfu');
    assert.equal(createRoom('second').sfuNodeId, 'b-sfu');
    assert.equal(createRoom('third').sfuNodeId, 'b-sfu', 'A is full even though both nodes have the same number of rooms');
    assert.equal(createRoom('fallback').sfuNodeId, undefined, 'A full direct pool retains the shared ingress fallback');
    core.server.rooms.close(first.id, 'admin_closed');
    assert.equal(createRoom('slot-reused').sfuNodeId, 'a-sfu');
    const clearLimit = await core.api('PATCH', '/v1/admin/nodes/b-sfu', { headers, body: { capacity: { maxRooms: 0 } } });
    assert.equal(clearLimit.status, 200);
    assert.equal(createRoom('no-reported-limit').sfuNodeId, 'b-sfu');
  } finally {
    await core.close();
  }
});

test('room snapshot survives a Core restart: room, participants, permissions, SFU node, timestamps', async () => {
  const dataDir = tempDir();
  const first = await boot(dataDir, { resumeGraceSec: 0 });
  const room = first.rooms.create({
    id: 'restart-room',
    tenantId: 'demo',
    name: 'Restart call',
    maxParticipants: 10,
    mediaMode: 'sfu',
  });
  const createdAt = room.createdAt;
  const alisaId = 'alisa-restart';
  const bobId = 'bob-restart';
  const alisaToken = joinToken(first, room.id, alisaId, 'Alisa');
  const bobToken = joinToken(first, room.id, bobId, 'Bob');

  const alisa = await openClient(first, alisaToken, { resume: true });
  const alisaWelcome = await alisa.waitFor((message) => message.type === 'welcome');
  assert.ok(alisaWelcome.resume?.token, 'continuity socket receives a resume token');
  const bob = await openClient(first, bobToken, { resume: true });
  await bob.waitFor((message) => message.type === 'welcome');
  await alisa.waitFor((message) => message.type === 'peer-joined');
  assert.equal(room.participantCount, 2);
  assert.ok(room.sfuNodeId, 'SFU room is pinned to a node');

  await first.continuity.flushAll();
  const snapshot = await new FileRoomSnapshotStore(path.join(dataDir, 'rooms')).get('demo', room.id);
  assert.ok(snapshot, 'snapshot file exists');
  assert.equal(snapshot.participants.length, 2);
  assert.deepEqual(
    (snapshot.permissions[alisaId] ?? []).slice().sort(),
    (alisaWelcome.self.permissions ?? []).slice().sort(),
  );
  assert.equal(snapshot.sfu?.nodeId, room.sfuNodeId);
  const sfuNodeId = room.sfuNodeId;

  // The server closes the live sockets during shutdown; members must still be
  // in the room when the shutdown flush runs, so they are not closed here.
  await first.close();

  const second = await boot(dataDir, { resumeGraceSec: 0 });
  try {
    const restored = second.rooms.get(room.id);
    assert.ok(restored, 'active room restored on startup');
    assert.equal(restored.tenantId, 'demo');
    assert.equal(restored.createdAt, createdAt, 'createdAt survives the restart');
    assert.equal(restored.participantCount, 2);
    assert.equal(restored.sfuNodeId, sfuNodeId);
    assert.deepEqual(
      restored.participants().map((participant) => participant.presence),
      ['reconnecting', 'reconnecting'],
    );
    assert.ok(second.continuity.stats().restoredRooms >= 1);
    assert.ok(second.continuity.stats().restoredTenants.includes('demo'));

    // A restored participant resumes the same slot after the restart.
    const resumed = await openClient(second, alisaToken, { resume: true, resumeToken: alisaWelcome.resume.token });
    const resumedWelcome = await resumed.waitFor((message) => message.type === 'welcome');
    assert.equal(resumedWelcome.resumed, true, 'welcome marks the connection as resumed');
    assert.equal(resumedWelcome.self.id, alisaId);
    assert.equal(second.rooms.get(room.id)?.participantCount, 2, 'no duplicate participant after resume');
    await resumed.close();
  } finally {
    await second.close();
  }
});

/* ------------------------------------------------------------------ */
/* P2: resumed/restored calls keep metering                            */
/* ------------------------------------------------------------------ */

test('a resumed call after a Core restart meters live minutes without a duplicate join', async () => {
  const dataDir = tempDir('agil-continuity-billing-');
  const first = await boot(dataDir, { resumeGraceSec: 5 });
  const room = first.rooms.create({ id: 'billing-resume', tenantId: 'demo', name: 'Billing', maxParticipants: 10 });
  const alisaToken = joinToken(first, room.id, 'alisa', 'Alisa');
  const alisa = await openClient(first, alisaToken, { resume: true });
  const alisaWelcome = await alisa.waitFor((message) => message.type === 'welcome');
  const resumeToken = alisaWelcome.resume?.token as string;
  assert.ok(resumeToken);
  await first.continuity.flushAll();
  assert.equal(first.services.billing.getUsage('demo').participantJoins, 1);
  await first.close();

  const second = await boot(dataDir, { resumeGraceSec: 5 });
  try {
    assert.ok(second.rooms.get(room.id), 'room restored');
    assert.equal(second.rooms.get(room.id)?.seatedParticipantCount(), 0, 'no live seat before resume');
    const resumed = await openClient(second, alisaToken, { resume: true, resumeToken });
    const resumedWelcome = await resumed.waitFor((message) => message.type === 'welcome');
    assert.equal(resumedWelcome.resumed, true);
    const afterResume = second.services.billing.getUsage('demo');
    assert.equal(afterResume.participantJoins, 1, 'resume is not a new join');

    await delay(1200);
    const liveResumedOnly = second.services.billing.liveMinutes('demo');
    assert.ok(liveResumedOnly > 0, `resumed call must meter live minutes (got ${liveResumedOnly})`);

    // A fresh join in the same room joins the same meter: it must not reset
    // the session start (that would lose the resumed minutes).
    const bobToken = joinToken(second, room.id, 'bob', 'Bob');
    const bob = await openClient(second, bobToken);
    await bob.waitFor((message) => message.type === 'welcome');
    await delay(500);
    const liveAfterFreshJoin = second.services.billing.liveMinutes('demo');
    assert.ok(
      liveAfterFreshJoin > liveResumedOnly,
      `fresh join continues the resumed session (${liveResumedOnly} -> ${liveAfterFreshJoin})`,
    );
    assert.equal(second.services.billing.getUsage('demo').participantJoins, 2);
    await bob.close();
    await resumed.close();
  } finally {
    await second.close();
  }
});

/* ------------------------------------------------------------------ */
/* P2: restored ghosts do not block capacity                           */
/* ------------------------------------------------------------------ */

test('restored offline ghosts do not block new joins; grace-held members still do', async () => {
  const dataDir = tempDir('agil-continuity-capacity-');
  const first = await boot(dataDir, { resumeGraceSec: 20 });
  const room = first.rooms.create({ id: 'capacity-room', tenantId: 'demo', name: 'Capacity', maxParticipants: 2 });
  const oneToken = joinToken(first, room.id, 'one', 'One');
  const twoToken = joinToken(first, room.id, 'two', 'Two');
  const one = await openClient(first, oneToken, { resume: true });
  const oneWelcome = await one.waitFor((message) => message.type === 'welcome');
  const oneResume = oneWelcome.resume?.token as string;
  const two = await openClient(first, twoToken);
  await two.waitFor((message) => message.type === 'welcome');
  assert.equal(room.participantCount, 2);
  await first.continuity.flushAll();
  await first.close();

  const second = await boot(dataDir, { resumeGraceSec: 20 });
  try {
    const restored = second.rooms.get(room.id);
    assert.ok(restored);
    assert.equal(restored.participantCount, 2);
    assert.equal(restored.seatedParticipantCount(), 0, 'restored ghosts own no seat');
    assert.deepEqual(
      restored.participants().map((participant) => participant.presence),
      ['reconnecting', 'reconnecting'],
    );

    // A third, brand-new participant can join the otherwise "full" room.
    const threeToken = joinToken(second, room.id, 'three', 'Three');
    const three = await openClient(second, threeToken);
    const threeWelcome = await three.waitFor((message) => message.type === 'welcome');
    assert.equal(threeWelcome.self.id, 'three');
    assert.equal(restored.participantCount, 3);
    assert.equal(restored.seatedParticipantCount(), 1);

    // The REST join path uses the same seated count (not raw participantCount).
    const restJoin = await fetch(`http://127.0.0.1:${second.port}/v1/rooms/${room.id}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rest guest' }),
    });
    assert.equal(restJoin.status, 200, `restored ghosts must not block REST join: ${await restJoin.text()}`);

    // An existing participant still resumes its slot (capacity never rejects
    // a replacing connection).
    const resumed = await openClient(second, oneToken, { resume: true, resumeToken: oneResume });
    const resumedWelcome = await resumed.waitFor((message) => message.type === 'welcome');
    assert.equal(resumedWelcome.resumed, true);
    assert.equal(restored.participantCount, 3, 'resume does not duplicate the participant');
    assert.equal(restored.seatedParticipantCount(), 2);
    await resumed.close();
    await three.close();
  } finally {
    await second.close();
  }
});

test('a grace-held participant keeps its seat until the lease expires', async () => {
  const dataDir = tempDir('agil-continuity-grace-seat-');
  const server = await boot(dataDir, { resumeGraceSec: 1 });
  try {
    const room = server.rooms.create({ id: 'grace-seat', tenantId: 'demo', name: 'Grace seat', maxParticipants: 2 });
    const alisaToken = joinToken(server, room.id, 'alisa', 'Alisa');
    const bobToken = joinToken(server, room.id, 'bob', 'Bob');
    const alisa = await openClient(server, alisaToken, { resume: true });
    await alisa.waitFor((message) => message.type === 'welcome');
    const bob = await openClient(server, bobToken);
    await bob.waitFor((message) => message.type === 'welcome');
    assert.equal(room.seatedParticipantCount(), 2);

    // Alisa drops: her seat is reserved for the 1 s grace window.
    await alisa.close();
    await bob.waitFor((message) => message.type === 'presence' && message.presence === 'reconnecting');
    assert.equal(room.seatedParticipantCount(), 2, 'grace lease keeps the seat reserved');

    const threeToken = joinToken(server, room.id, 'three', 'Three');
    const rejected = await openClient(server, threeToken);
    const failure = await rejected.waitFor((message) => message.type === 'error', 3000);
    assert.equal(failure.code, 'room_full', 'a held seat is not free for a newcomer');
    await rejected.close();

    // After the lease times out the participant is really gone and the seat frees.
    await bob.waitFor((message) => message.type === 'peer-left' && message.participantId === 'alisa', 4000);
    assert.equal(room.seatedParticipantCount(), 1);
    const admitted = await openClient(server, threeToken);
    const welcome = await admitted.waitFor((message) => message.type === 'welcome');
    assert.equal(welcome.self.id, 'three');
    assert.equal(room.participantCount, 2);
    await admitted.close();
    await bob.close();
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* P3: duplicate socket does not inflate participantJoins              */
/* ------------------------------------------------------------------ */

test('legacy duplicate socket (no resume token) does not increment participantJoins', async () => {
  const dataDir = tempDir('agil-continuity-duplicate-');
  const server = await boot(dataDir);
  try {
    const room = server.rooms.create({ id: 'legacy-dup', tenantId: 'demo', name: 'Legacy dup', maxParticipants: 10 });
    const token = joinToken(server, room.id, 'alisa', 'Alisa');
    const first = await openClient(server, token);
    await first.waitFor((message) => message.type === 'welcome');
    assert.equal(server.services.billing.getUsage('demo').participantJoins, 1);

    const second = await openClient(server, token);
    const welcome = await second.waitFor((message) => message.type === 'welcome');
    assert.equal(Boolean(welcome.resumed), false, 'no resume token, legacy replace path');
    assert.equal(server.services.billing.getUsage('demo').participantJoins, 1, 'same participant is not a new join');
    assert.equal(room.participantCount, 1);
    await second.close();
    await first.close();
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* P3: continuity disabled advertises no resume capability             */
/* ------------------------------------------------------------------ */

test('AGIL_CONTINUITY=0: welcome.resume is absent and grace is off', async () => {
  const dataDir = tempDir('agil-continuity-disabled-');
  const server = await boot(dataDir, { continuityEnabled: false, resumeGraceSec: 20 });
  try {
    assert.equal(server.continuity.stats().enabled, false);
    assert.equal(server.continuity.stats().resumeGraceSec, 0);
    const room = server.rooms.create({ id: 'disabled-room', tenantId: 'demo', name: 'Disabled', maxParticipants: 5 });
    const bobToken = joinToken(server, room.id, 'bob', 'Bob');
    const bob = await openClient(server, bobToken);
    await bob.waitFor((message) => message.type === 'welcome');

    const alisaToken = joinToken(server, room.id, 'alisa', 'Alisa');
    const alisa = await openClient(server, alisaToken, { resume: true });
    const welcome = await alisa.waitFor((message) => message.type === 'welcome');
    assert.equal(welcome.resume, undefined, 'disabled continuity must not issue a resume token');
    await bob.waitFor((message) => message.type === 'peer-joined');

    // Legacy immediate departure: no grace lease exists.
    const left = bob.waitFor((message) => message.type === 'peer-left' && message.participantId === 'alisa');
    await alisa.close();
    assert.equal((await left).reason, 'disconnected');
    assert.equal(room.participantCount, 1);
    assert.equal(await server.continuity.flushAll(), 0, 'disabled continuity writes no snapshots');
    await bob.close();
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* P3: flushAll must not resurrect a room closed during the save       */
/* ------------------------------------------------------------------ */

test('flushAll drops a snapshot when its room closes while the write is in flight', async () => {
  const env = loadEnv({ dataDir: tempDir('agil-continuity-flush-'), tokenSecret: 'test-secret', continuityEnabled: true });
  const rooms = new RoomRegistry();
  const store = new MemoryRoomSnapshotStore();
  const continuity = new RoomContinuity({ env, rooms, logger: silentLogger, store });
  const room = rooms.create({ id: 'race-room', tenantId: 'demo', name: 'Race', maxParticipants: 2 });
  const realSave = store.save.bind(store);
  let closed = false;
  store.save = async (snapshot) => {
    await realSave(snapshot);
    if (!closed) {
      closed = true;
      // Close (admin delete / TTL) between snapshot capture and the write
      // finishing: `onRoomEvent('closed')` deletes the snapshot asynchronously.
      rooms.close(room.id, 'admin_delete');
    }
  };

  const saved = await continuity.flushAll();
  assert.equal(closed, true);
  assert.equal(saved, 0, 'a closed room is not reported as saved');
  assert.equal(await store.get('demo', room.id), null, 'no snapshot left behind');
  assert.equal(rooms.get(room.id), undefined);
});

test('flushAll keeps the snapshot when a demote closes the room mid-write', async () => {
  const env = loadEnv({ dataDir: tempDir('agil-continuity-demote-'), tokenSecret: 'test-secret', continuityEnabled: true });
  const rooms = new RoomRegistry();
  const store = new MemoryRoomSnapshotStore();
  const continuity = new RoomContinuity({ env, rooms, logger: silentLogger, store });
  const room = rooms.create({ id: 'demote-room', tenantId: 'demo', name: 'Demote', maxParticipants: 2 });
  const realSave = store.save.bind(store);
  let demoted = false;
  store.save = async (snapshot) => {
    await realSave(snapshot);
    if (!demoted) {
      demoted = true;
      // onDemote(): flushAll is fire-and-forget, then the registry drops rooms.
      rooms.clear('leadership_lost');
    }
  };

  const saved = await continuity.flushAll();
  assert.equal(demoted, true);
  assert.equal(saved, 1, 'retained close is still a successful snapshot');
  assert.ok(await store.get('demo', room.id), 'leadership_lost snapshot survives for the next leader');
  assert.equal(rooms.get(room.id), undefined);
});

/* ------------------------------------------------------------------ */
/* Duplicate join / resume                                             */
/* ------------------------------------------------------------------ */

test('duplicate join and resume: one participant slot, no peer-left/peer-joined storm', async () => {
  const dataDir = tempDir();
  const server = await boot(dataDir, { resumeGraceSec: 1 });
  try {
    const room = server.rooms.create({ id: 'resume-room', tenantId: 'demo', name: 'Resume', maxParticipants: 10 });
    const alisaToken = joinToken(server, room.id, 'alisa', 'Alisa');
    const bobToken = joinToken(server, room.id, 'bob', 'Bob');

    const bob = await openClient(server, bobToken);
    await bob.waitFor((message) => message.type === 'welcome');

    const first = await openClient(server, alisaToken, { resume: true });
    const firstWelcome = await first.waitFor((message) => message.type === 'welcome');
    await bob.waitFor((message) => message.type === 'peer-joined');
    const resumeToken = firstWelcome.resume?.token as string;
    assert.ok(resumeToken);

    // A second socket for the same participant while the first is still live:
    // it resumes, the old socket is closed silently and no peer is announced.
    const second = await openClient(server, alisaToken, { resume: true, resumeToken });
    const secondWelcome = await second.waitFor((message) => message.type === 'welcome');
    assert.equal(secondWelcome.resumed, true);
    assert.equal(secondWelcome.self.id, 'alisa');
    assert.equal(await waitForClose(first), 1000);
    assert.equal(room.participantCount, 2, 'room counts one Alisa + one Bob');
    assert.equal(room.participants().filter((participant) => participant.id === 'alisa').length, 1);
    const presence = await bob.waitFor((message) => message.type === 'presence' && message.presence === 'online');
    assert.equal(presence.participantId, 'alisa');

    // Socket drop: presence becomes reconnecting, no peer-left yet.
    await second.close();
    await bob.waitFor((message) => message.type === 'presence' && message.presence === 'reconnecting');
    assert.equal(room.member('alisa')?.connection.offline, true);
    assert.equal(room.participantCount, 2);

    // Resume inside the grace window: same slot, peers never saw a leave.
    const third = await openClient(server, alisaToken, { resume: true, resumeToken });
    const thirdWelcome = await third.waitFor((message) => message.type === 'welcome');
    assert.equal(thirdWelcome.resumed, true);
    await bob.waitFor((message) => message.type === 'presence' && message.presence === 'online');
    assert.equal(room.participantCount, 2);
    const announcements = bob.messages.filter(
      (message) => message.type === 'peer-left' || message.type === 'peer-joined',
    );
    assert.equal(announcements.length, 1, 'only Bob saw Alisa join once; no leave/re-join churn');

    // Beyond the grace window the participant is really gone.
    await third.close();
    const left = await bob.waitFor(
      (message) => message.type === 'peer-left' && message.participantId === 'alisa',
      4000,
    );
    assert.equal(left.reason, 'reconnect_timeout');
    assert.equal(room.participantCount, 1);
    assert.equal(room.member('alisa'), undefined);
    await bob.close();
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* TTL / stale cleanup                                                 */
/* ------------------------------------------------------------------ */

test('stale snapshots are swept by TTL and empty rooms delete their snapshot', async () => {
  const dataDir = tempDir();
  const file = new FileRoomSnapshotStore(path.join(dataDir, 'rooms'));
  await file.save(makeSnapshot('demo', 'expired', { expiresAt: Date.now() - 1000 }));
  await file.save(makeSnapshot('demo', 'valid', { expiresAt: Date.now() + 60_000 }));
  assert.equal(await file.sweep(), 1);
  assert.equal(await file.get('demo', 'expired'), null);
  assert.ok(await file.get('demo', 'valid'));

  const memory = new MemoryRoomSnapshotStore();
  await memory.save(makeSnapshot('demo', 'm-expired', { expiresAt: Date.now() - 1 }));
  await memory.save(makeSnapshot('demo', 'm-valid', { expiresAt: Date.now() + 60_000 }));
  assert.equal(await memory.sweep(), 1);
  assert.equal(memory.size, 1);

  const server = await boot(dataDir, { roomTtlSec: 1 });
  try {
    const room = server.rooms.create({ id: 'ttl-room', tenantId: 'demo', name: 'TTL', maxParticipants: 10 });
    const unused = server.rooms.create({ id: 'unused-ttl', tenantId: 'demo', name: 'Unused', maxParticipants: 2 });
    const persistent = server.rooms.create({ id: 'zero-ttl', tenantId: 'demo', name: 'Persistent', maxParticipants: 2, ttlSec: 0 });
    const token = joinToken(server, room.id, 'guest-ttl', 'Guest');
    const guest = await openClient(server, token);
    await guest.waitFor((message) => message.type === 'welcome');
    await delay(1250);
    assert.equal(server.rooms.get(unused.id), undefined, 'room expires even before its first join');
    assert.equal(server.rooms.get(room.id), room, 'first join cancels the empty-room timer');
    assert.equal(server.rooms.get(persistent.id), persistent, 'zero TTL disables empty-room expiry');
    await guest.close();
    await server.continuity.flushAll();
    assert.ok(await new FileRoomSnapshotStore(path.join(dataDir, 'rooms')).get('demo', room.id));
    // Room is empty: its TTL closes the room and the snapshot is deleted.
    await delay(1600);
    assert.equal(server.rooms.get(room.id), undefined);
    assert.equal(
      await new FileRoomSnapshotStore(path.join(dataDir, 'rooms')).get('demo', room.id),
      null,
      'closed room snapshot removed',
    );
  } finally {
    await server.close();
  }
});

test('Core restart keeps the original TTL deadline of unused rooms', async () => {
  const dataDir = tempDir();
  const first = await boot(dataDir);
  const setup = (id: string, ttlSec: number) => first.rooms.create({ id, tenantId: 'demo', name: id, maxParticipants: 2, ttlSec });
  const expired = setup('expire-during-restart', 1);
  const waiting = setup('wait-through-restart', 5);
  const persistent = setup('keep-through-restart', 0);
  const store = new FileRoomSnapshotStore(path.join(dataDir, 'rooms'));
  try {
    await first.continuity.flushAll();
    assert.ok(await store.get('demo', expired.id));
  } finally {
    await first.close();
  }

  await delay(Math.max(0, expired.createdAt + 1100 - Date.now()));
  const second = await boot(dataDir);
  try {
    assert.equal(second.rooms.get(expired.id), undefined, 'expiry during downtime prevents restoration');
    assert.equal(await store.get('demo', expired.id), null, 'the expired snapshot is deleted on boot');
    assert.ok(second.rooms.get(waiting.id), 'valid empty room is restored');
    await delay(Math.max(0, waiting.createdAt + 5100 - Date.now()));
    assert.equal(second.rooms.get(waiting.id), undefined, 'boot does not extend the empty-room deadline');
    assert.ok(second.rooms.get(persistent.id), 'zero-TTL empty room is retained across restart');
  } finally {
    await second.close();
  }
});

test('active duration begins at first connection and survives restart without extending', async () => {
  const dataDir = tempDir();
  const store = new FileRoomSnapshotStore(path.join(dataDir, 'rooms'));
  const first = await boot(dataDir);
  const roomId = 'meeting-time-limit';
  let deadline: number;
  try {
    const room = first.rooms.create({
      id: roomId, tenantId: 'demo', name: 'Time limit', maxParticipants: 2, ttlSec: 0,
      configOverrides: { limits: { maxDurationMin: 1 } },
    });
    assert.equal(room.durationDeadlineAt, undefined);
    const started = Date.now();
    const socket = await openClient(first, joinToken(first, roomId, 'guest-1', 'Guest One'), { resume: true });
    await socket.waitFor((message) => message.type === 'welcome');
    assert.ok(room.durationDeadlineAt !== undefined);
    deadline = room.durationDeadlineAt;
    assert.ok(deadline >= started + 60_000 && deadline <= Date.now() + 60_000);
    await first.continuity.flushAll();
    assert.equal((await store.get('demo', roomId))?.room.durationDeadlineAt, deadline);
  } finally {
    await first.close();
  }

  const second = await boot(dataDir);
  try {
    const restored = second.rooms.get(roomId);
    assert.equal(restored?.durationDeadlineAt, deadline);
    const guest = await openClient(second, joinToken(second, roomId, 'guest-2', 'Guest Two'));
    await guest.waitFor((message) => message.type === 'welcome');
    assert.equal(restored?.durationDeadlineAt, deadline);
  } finally {
    await second.close();
  }

  const expired = await store.get('demo', roomId);
  assert.ok(expired);
  expired.room.durationDeadlineAt = Date.now() - 1;
  await store.save(expired);
  const third = await boot(dataDir);
  try {
    assert.equal(third.rooms.get(roomId), undefined);
    assert.equal(await store.get('demo', roomId), null);
  } finally {
    await third.close();
  }
});

test('a duration expiry closes the meeting and its breakout rooms', () => {
  let now = Date.now();
  const registry = new RoomRegistry({ now: () => now, maxDurationMs: () => 60_000 });
  const input = { tenantId: 'demo', name: 'Timed room', maxParticipants: 2 };
  const main = registry.create(input);
  const child = registry.create({ ...input, breakoutParentId: main.id });
  const participant = makeSnapshot('demo', main.id).participants[0]!.participant;
  const byes: string[] = [];
  const connection: RoomConnection = {
    send: (message) => {
      if (message.type === 'bye') byes.push(message.reason ?? '');
    },
    close: () => undefined,
  };
  try {
    main.addMember(participant, connection);
    now += 10_000;
    const emptyChild = registry.create({ ...input, breakoutParentId: main.id });
    assert.equal(emptyChild.durationDeadlineAt, main.durationDeadlineAt);
    child.addMember(participant, connection);
    assert.equal(child.durationDeadlineAt, main.durationDeadlineAt);
    now += 50_000;
    assert.equal(registry.get(main.id), undefined);
    assert.equal(registry.get(child.id), undefined);
    assert.equal(registry.get(emptyChild.id), undefined);
    assert.deepEqual(byes, ['duration_expired', 'duration_expired']);
  } finally {
    registry.clear();
  }
});

for (const reason of ['duration_expired', 'admin_closed']) {
  test(`a closed SFU room id can be reused after remote cleanup (${reason})`, async () => {
    let resolveCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { resolveCleanup = resolve; });
    const registry = new RoomRegistry({ onSfuRoomClose: () => cleanup });
    const input = { id: 'sfuroom', tenantId: 'demo', name: 'SFU room', maxParticipants: 2, mediaMode: 'sfu' as const };
    registry.create(input);
    assert.equal(registry.close(input.id, reason), true);
    assert.throws(() => registry.create(input), { code: 'room_exists' });
    resolveCleanup();
    await delay(0);
    assert.equal(registry.create(input).id, input.id);
    registry.clear();
  });
}

/* ------------------------------------------------------------------ */
/* Tenant isolation                                                    */
/* ------------------------------------------------------------------ */

test('tenant isolation: per-tenant listing, restore and resume-token binding', async () => {
  const dataDir = tempDir();
  const first = await boot(dataDir, { resumeGraceSec: 5 });
  try {
    const demoRoom = first.rooms.create({ id: 'demo-room', tenantId: 'demo', name: 'Demo', maxParticipants: 5 });
    const acmeRoom = first.rooms.create({ id: 'acme-room', tenantId: 'acme', name: 'Acme', maxParticipants: 5 });
    await first.continuity.flushAll();

    const store = new FileRoomSnapshotStore(path.join(dataDir, 'rooms'));
    assert.deepEqual((await store.list('demo')).map((snapshot) => snapshot.room.id), ['demo-room']);
    assert.deepEqual((await store.list('acme')).map((snapshot) => snapshot.room.id), ['acme-room']);
    assert.equal(await store.get('demo', 'acme-room'), null, 'cross-tenant get is refused');
    assert.equal(await store.get('acme', 'demo-room'), null);

    // A resume token is bound to tenant + room + participant.
    const resume = first.continuity.issueResume(demoRoom, 'demo-guest');
    const claims = JSON.parse(Buffer.from(resume.token.split('.')[1] as string, 'base64url').toString('utf8'));
    assert.equal(claims.tenantId, 'demo');
    assert.equal(claims.roomId, 'demo-room');
    assert.equal(claims.participantId, 'demo-guest');
    assert.equal(first.continuity.verifyResume(demoRoom, 'demo-guest', resume.token), false, 'no stored hash yet');
    // Token signed for another tenant/room can never verify here.
    const foreign = issueResumeToken(first.env.tokenSecret, {
      v: 1,
      tenantId: 'acme',
      roomId: 'acme-room',
      participantId: 'demo-guest',
      exp: Date.now() + 60_000,
      nonce: 'n',
    });
    assert.equal(first.continuity.verifyResume(demoRoom, 'demo-guest', foreign), false);
    assert.equal(claims.exp > Date.now(), true);
    assert.equal(acmeRoom.tenantId, 'acme');
  } finally {
    await first.close();
  }

  // A snapshot copied into another tenant's directory is ignored on restore.
  mkdirSync(path.join(dataDir, 'rooms', 'demo'), { recursive: true });
  writeFileSync(
    path.join(dataDir, 'rooms', 'demo', 'copied.json'),
    JSON.stringify({ ...makeSnapshot('acme', 'copied-room'), tenantId: 'acme' }),
  );
  // A snapshot for a tenant this Core does not know is not resurrected either.
  mkdirSync(path.join(dataDir, 'rooms', 'ghost'), { recursive: true });
  writeFileSync(
    path.join(dataDir, 'rooms', 'ghost', 'ghost-room.json'),
    JSON.stringify(makeSnapshot('ghost', 'ghost-room')),
  );

  const second = await boot(dataDir);
  try {
    assert.ok(second.rooms.get('demo-room'));
    assert.ok(second.rooms.get('acme-room'));
    assert.equal(second.rooms.get('copied-room'), undefined, 'cross-tenant snapshot ignored');
    assert.equal(second.rooms.get('ghost-room'), undefined, 'unknown tenant snapshot ignored');
  } finally {
    await second.close();
  }
});

/* ------------------------------------------------------------------ */
/* Node drain                                                          */
/* ------------------------------------------------------------------ */

test('node drain marks rooms, keeps them joinable, and is tenant-scoped', async () => {
  const dataDir = tempDir();
  const server = await boot(dataDir);
  try {
    const demoRoom = server.rooms.create({
      id: 'drain-room',
      tenantId: 'demo',
      name: 'Draining',
      maxParticipants: 5,
      mediaMode: 'sfu',
      sfuNodeId: 'sfu-1',
    });
    const otherTenantRoom = server.rooms.create({
      id: 'acme-drain-room',
      tenantId: 'acme',
      name: 'Other tenant',
      maxParticipants: 5,
      mediaMode: 'sfu',
      sfuNodeId: 'sfu-1',
    });

    const result = await server.continuity.markNodeDraining('demo', 'sfu-1', true);
    assert.equal(result.affected, 1);
    assert.equal(demoRoom.draining, true);
    assert.equal(demoRoom.info().draining, true);
    assert.equal(otherTenantRoom.draining, false, 'drain is tenant-scoped');
    const snapshot = await server.continuity.saveRoom(demoRoom);
    assert.equal(snapshot?.draining, true);

    // Draining does not block rejoin: a participant still joins the room.
    const token = joinToken(server, demoRoom.id, 'late-guest', 'Late guest');
    const guest = await openClient(server, token);
    const welcome = await guest.waitFor((message) => message.type === 'welcome');
    assert.equal(welcome.room.draining, true);
    assert.equal(demoRoom.participantCount, 1);
    await guest.close();

    // Clearing the drain marker returns the room to service.
    await server.continuity.markNodeDraining('demo', 'sfu-1', false);
    assert.equal(demoRoom.draining, false);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* Redis-compatible store                                              */
/* ------------------------------------------------------------------ */

test('Redis-compatible snapshot store: SET/GET/DEL layout with per-tenant indexes', async () => {
  const values = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const commands: string[] = [];
  const fake: RoomSnapshotRedis = {
    async command(args) {
      const name = String(args[0]).toUpperCase();
      commands.push(name);
      if (name === 'SET') {
        values.set(String(args[1]), String(args[2]));
        void args[3];
        return 'OK';
      }
      if (name === 'GET') return values.get(String(args[1])) ?? null;
      if (name === 'DEL') return values.delete(String(args[1])) ? 1 : 0;
      if (name === 'SADD') {
        const key = String(args[1]);
        const set = sets.get(key) ?? new Set<string>();
        set.add(String(args[2]));
        sets.set(key, set);
        return 1;
      }
      if (name === 'SREM') {
        sets.get(String(args[1]))?.delete(String(args[2]));
        return 1;
      }
      if (name === 'SMEMBERS') return [...(sets.get(String(args[1])) ?? [])];
      return null;
    },
  };
  const store = new RedisRoomSnapshotStore({ redis: fake, prefix: 'agil' });
  await store.save(makeSnapshot('demo', 'r1', { expiresAt: Date.now() + 60_000 }));
  await store.save(makeSnapshot('acme', 'r2'));
  assert.ok(values.has('agil:room:demo:r1'));
  assert.ok(commands.includes('SET'));
  assert.deepEqual((await store.list('demo')).map((snapshot) => snapshot.room.id), ['r1']);
  assert.deepEqual((await store.list('acme')).map((snapshot) => snapshot.room.id), ['r2']);
  assert.equal((await store.list()).length, 2);

  // TTL (`PX`) expires the key without touching the index SETs. `list()` must
  // prune the dead member and the now-empty tenant from the global index.
  values.delete('agil:room:demo:r1');
  assert.deepEqual((await store.list()).map((snapshot) => snapshot.room.id), ['r2']);
  assert.equal(sets.get('agil:room:index:demo')?.has('r1') ?? false, false, 'stale index member pruned');
  assert.equal(sets.get('agil:room:tenants')?.has('demo') ?? false, false, 'empty tenant pruned');

  await store.delete('acme', 'r2');
  assert.equal(values.has('agil:room:acme:r2'), false);
  assert.equal(await store.get('acme', 'r2'), null);
  assert.equal(sets.get('agil:room:tenants')?.has('acme') ?? false, false, 'last room delete prunes the tenant');

  // A dead Redis falls back to the write-through mirror instead of losing rooms.
  const mirror = new MemoryRoomSnapshotStore();
  const dead: RoomSnapshotRedis = { command: async () => Promise.reject(new Error('redis down')) };
  const mirrored = new RedisRoomSnapshotStore({ redis: dead, mirror });
  const snapshot = makeSnapshot('demo', 'mirrored');
  await assert.rejects(mirrored.save(snapshot));
  assert.ok(await mirror.get('demo', 'mirrored'));
  assert.ok(await mirrored.get('demo', 'mirrored'));

  const healthy = new RedisRoomSnapshotStore({ redis: fake, mirror });
  assert.equal(await healthy.get('demo', 'mirrored'), null, 'a stale mirror cannot resurrect a deleted Redis room');
  assert.deepEqual(await healthy.list(), []);

  // The token hash — never the resume token — is what a snapshot may carry.
  assert.equal(hashResumeToken('r1.payload.sig').length, 64);
  assert.ok(!JSON.stringify(await mirror.get('demo', 'mirrored')).includes('r1.payload.sig'));
});

/* ------------------------------------------------------------------ */
/* File store: global listing with hashed tenant directories           */
/* ------------------------------------------------------------------ */

test('file store global list resolves hashed tenant dirs without breaking isolation', async () => {
  const dir = tempDir('agil-continuity-filelist-');
  const store = new FileRoomSnapshotStore(dir);
  const exotic = 'tenant with space';
  await store.save(makeSnapshot('demo', 'demo-room'));
  await store.save(makeSnapshot(exotic, 'exotic-room'));

  const all = await store.list();
  assert.deepEqual(
    all.map((snapshot) => `${snapshot.tenantId}/${snapshot.room.id}`).sort(),
    ['demo/demo-room', `${exotic}/exotic-room`].sort(),
    'unscoped list derives the tenant from the snapshot, not the hashed dir name',
  );
  assert.deepEqual((await store.list(exotic)).map((snapshot) => snapshot.room.id), ['exotic-room']);
  assert.ok(await store.get(exotic, 'exotic-room'));

  // A snapshot copied into a foreign tenant directory is still ignored.
  mkdirSync(path.join(dir, 'demo'), { recursive: true });
  writeFileSync(path.join(dir, 'demo', 'copied.json'), JSON.stringify(makeSnapshot(exotic, 'copied')));
  assert.equal((await store.list('demo')).some((snapshot) => snapshot.room.id === 'copied'), false);
  assert.equal((await store.list()).some((snapshot) => snapshot.room.id === 'copied'), false);
});
