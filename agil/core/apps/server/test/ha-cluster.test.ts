/**
 * Leader election / failover tests (docs/ha-leader.md).
 *
 * Uses a real TCP Redis-compatible stub (`scripts/support/mini-redis.mjs`) so
 * the lease traffic goes through the same RESP client as production; set
 * AGIL_TEST_REDIS_URL to run the same assertions against a real Redis.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgilServer, type AgilServer } from '../src/index.js';
import { ROOT_DIR } from '../src/env.js';
import { silentLogger } from '../src/logger.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const API_KEYS = { 'dev-key': 'demo', 'acme-key': 'acme' };

interface Core {
  server: AgilServer;
  base: string;
  api(method: string, route: string, options?: { headers?: Record<string, string>; body?: unknown }): Promise<{
    status: number;
    body: any;
    text: string;
  }>;
  status(): Promise<any>;
}

interface MiniRedis {
  url: string;
  child: ChildProcess;
  stop(): void;
}

/** Starts the bundled stub (or uses a real Redis from AGIL_TEST_REDIS_URL). */
async function startRedis(): Promise<MiniRedis | { url: string; stop(): void }> {
  const external = (process.env.AGIL_TEST_REDIS_URL ?? process.env.AGIL_REDIS_URL ?? '').trim();
  if (external) return { url: external, stop() {} };
  const script = path.join(ROOT_DIR, 'agil', 'core', 'scripts', 'support', 'mini-redis.mjs');
  const child = spawn(process.execPath, [script, '--port', '0', '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('mini-redis did not start in 5 s')), 5_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const line = output.split(/\r?\n/).find((entry) => entry.trim().startsWith('{'));
      if (!line) return;
      try {
        const parsed = JSON.parse(line) as { port?: number };
        if (parsed.port) {
          clearTimeout(timer);
          resolve(parsed.port);
        }
      } catch {
        /* wait for a complete line */
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`mini-redis exited early (code ${code})`));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return {
    url: `redis://127.0.0.1:${port}`,
    child,
    stop() {
      child.kill();
    },
  };
}

async function startCore(
  dataDir: string,
  overrides: Record<string, unknown> = {},
): Promise<Core> {
  const server = await createAgilServer({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    tokenSecret: 'test-secret-0123456789',
    apiKeys: API_KEYS,
    allowAnonymous: true,
    publicOrigin: 'http://127.0.0.1:1',
    logger: silentLogger,
    ...overrides,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const api: Core['api'] = async (method, route, options = {}) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await fetch(`${base}${route}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed, text };
  };
  return {
    server,
    base,
    api,
    status: async () => (await api('GET', '/v1/admin/cluster/status', { headers: ADMIN })).body,
  };
}

async function waitFor<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const HA_ENV = {
  clusterId: 'ha-test',
  leaderLeaseTtlMs: 2_500,
  leaderRenewIntervalMs: 400,
  leaderRetryIntervalMs: 400,
};

test('standalone (no AGIL_REDIS_URL): single active Core, lease shows standalone', { timeout: 20_000 }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-ha-standalone-'));
  const core = await startCore(dataDir);
  try {
    const status = await core.status();
    assert.equal(status.status ?? 200, 200);
    assert.equal(status.cluster.role, 'leader');
    assert.equal(status.lease.mode, 'standalone');
    assert.equal(status.lease.held, true);
    assert.equal(status.ha.mode, 'standalone');
    assert.equal(status.ha.roomStateReplicated, false);
    assert.equal(status.ha.nodeRegistryReplicated, false);
    assert.ok(
      status.limitations.some((entry: string) => entry.includes('replicated')),
      `limitations must state the replication gap: ${JSON.stringify(status.limitations)}`,
    );

    const room = await core.api('POST', '/v1/rooms', { headers: ADMIN, body: { name: 'Standalone' } });
    assert.equal(room.status, 200, room.text);
    const token = await core.api('POST', '/v1/tokens', {
      headers: ADMIN,
      body: { tenantId: 'demo', roomId: room.body.room.id, participant: { name: 'A' } },
    });
    assert.equal(token.status, 200, token.text);
    assert.ok(token.body.token);
  } finally {
    await core.server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('two Cores + Redis: one leader, standby is read-only, failover without split-brain', { timeout: 40_000 }, async () => {
  const redis = await startRedis();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-ha-cluster-'));
  let coreA: Core | null = null;
  let coreB: Core | null = null;
  let restarted: Core | null = null;
  try {
    // Shared data dir: the promoted Core re-reads the registry file on takeover.
    coreA = await startCore(dataDir, { ...HA_ENV, redisUrl: redis.url, clusterNodeId: 'core-a' });
    const aLeader = await waitFor('core-a leadership', async () => {
      const status = await coreA!.status();
      return status.lease?.held ? status : null;
    });
    assert.equal(aLeader.cluster.role, 'leader');
    assert.equal(aLeader.lease.mode, 'redis');
    assert.ok(aLeader.lease.ttlMs > 0);
    assert.ok(aLeader.lease.validUntil > Date.now());
    assert.equal(aLeader.lease.reason.includes('leader'), true, aLeader.lease.reason);

    coreB = await startCore(dataDir, { ...HA_ENV, redisUrl: redis.url, clusterNodeId: 'core-b' });
    const bStandby = await waitFor('core-b standby', async () => {
      const status = await coreB!.status();
      return status.cluster.role === 'standby' && status.lease.held === false ? status : null;
    });
    assert.equal(bStandby.cluster.role, 'standby');
    assert.equal(bStandby.lease.mode, 'redis');
    assert.equal(bStandby.leader.self, false);
    assert.equal(bStandby.leader.id, aLeader.ha.nodeId ?? 'core-a');
    assert.ok(bStandby.lease.ttlRemainingMs !== null && bStandby.lease.ttlRemainingMs > 0);
    assert.match(bStandby.failover.message, /standby/i);
    assert.match(bStandby.failover.message, /not replicated/i);

    // A standby joining through the leader is told the real leader id (Redis
    // mode); in standalone the historical cluster-id value is kept.
    const coreToken = await coreA.api('POST', '/v1/admin/cluster/tokens', {
      headers: ADMIN,
      body: { kind: 'core', role: 'standby', ttlSec: 600 },
    });
    assert.equal(coreToken.status, 201, coreToken.text);
    const joined = await coreA.api('POST', '/v1/cluster/join', {
      headers: ADMIN,
      body: { token: coreToken.body.token, nodeId: 'standby-joined', version: '0.1.0' },
    });
    assert.equal(joined.status, 200, joined.text);
    assert.equal(joined.body.leader.nodeId, 'core-a');

    // Every mutation surface central to this stage returns 409 not_leader.
    const mutations: Array<[string, string, Record<string, unknown> | undefined]> = [
      ['POST', '/v1/rooms', { name: 'Standby room' }],
      ['POST', '/v1/tokens', { tenantId: 'demo', roomId: 'x', participant: { name: 'A' } }],
      ['POST', '/v1/admin/cluster/tokens', { kind: 'node', role: 'sfu' }],
      ['PATCH', '/v1/admin/nodes/some-node', { name: 'x' }],
      ['PATCH', '/v1/tenants/demo/config', { room: { name: 'Renamed' } }],
      ['POST', '/v1/cluster/join', { token: 'agil_enr_should_not_join_123456', nodeId: 'standby-x' }],
      ['POST', '/v1/nodes/register', { token: 'agil_enr_should_not_register_123456', role: 'sfu' }],
    ];
    for (const [method, route, body] of mutations) {
      const response = await coreB.api(method, route, { headers: ADMIN, body });
      assert.equal(response.status, 409, `${method} ${route}: ${response.text}`);
      assert.equal(response.body.error.code, 'not_leader', `${method} ${route}`);
    }
    // Room created on the leader is not visible on the standby (documented).
    const room = await coreA.api('POST', '/v1/rooms', { headers: ADMIN, body: { name: 'Leader room' } });
    assert.equal(room.status, 200, room.text);
    const roomId = room.body.room.id;
    assert.ok(roomId, room.text);
    const missing = await coreB.api('GET', `/v1/rooms/${roomId}`, { headers: ADMIN });
    assert.equal(missing.status, 404);

    // Mutations on the leader keep working while the standby waits.
    const token = await coreA.api('POST', '/v1/tokens', {
      headers: ADMIN,
      body: { tenantId: 'demo', roomId, participant: { name: 'A' } },
    });
    assert.equal(token.status, 200, token.text);

    // Local-volume writes (uploads) are leader-only too: a standby would lose
    // them on failover because files/recordings are not replicated.
    const uploadAuth = { authorization: `Bearer ${token.body.token}` };
    const blockedUpload = await coreB.api('POST', '/v1/files', {
      headers: { ...uploadAuth, 'x-file-name': 'standby.txt' },
      body: 'standby content',
    });
    assert.equal(blockedUpload.status, 409, blockedUpload.text);
    assert.equal(blockedUpload.body.error.code, 'not_leader');
    const blockedRecording = await coreB.api('POST', '/v1/recordings', {
      headers: {
        ...uploadAuth,
        'x-recording-meta': JSON.stringify({ roomId, mime: 'video/webm' }),
      },
      body: 'standby recording',
    });
    assert.equal(blockedRecording.status, 409, blockedRecording.text);
    assert.equal(blockedRecording.body.error.code, 'not_leader');
    // The same request on the leader passes the leadership gate (the tenant
    // may still disable file sharing, so only assert it is not `not_leader`).
    const leaderUpload = await coreA.api('POST', '/v1/files', {
      headers: { ...uploadAuth, 'x-file-name': 'leader.txt' },
      body: 'leader content',
    });
    assert.ok(
      !(leaderUpload.status === 409 && leaderUpload.body.error?.code === 'not_leader'),
      leaderUpload.text,
    );

    // Simulate a crash: stop renewing and drop the socket WITHOUT releasing the
    // lease. The old Core must keep working for at most its fencing deadline
    // and then become read-only; the standby may take over only afterwards.
    const beforeCrash = await coreA.status();
    const fenceDeadline = beforeCrash.lease.validUntil;
    coreA.server.leader.disconnect();

    let observedBothLeaders = false;
    let oldCoreRejected = false;
    await waitFor('core-b takeover', async () => {
      const [a, b] = await Promise.all([coreA!.status(), coreB!.status()]);
      if (a.cluster.role === 'leader' && b.cluster.role === 'leader') observedBothLeaders = true;
      if (a.cluster.role === 'standby') {
        const rejected = await coreA!.api('POST', '/v1/rooms', { headers: ADMIN, body: { name: 'After fence' } });
        if (rejected.status === 409 && rejected.body.error.code === 'not_leader') {
          oldCoreRejected = true;
        } else {
          assert.fail(`old leader accepted a mutation after the fence: ${rejected.status} ${rejected.text}`);
        }
      }
      return b.cluster.role === 'leader' && b.lease.held ? b : null;
    }, 12_000);
    assert.equal(observedBothLeaders, false, 'two Cores were leaders at the same time');
    assert.equal(oldCoreRejected, true, 'the fenced old leader never observed 409');
    assert.ok(Date.now() >= (fenceDeadline ?? 0));
    assert.equal((await coreA.status()).cluster.role, 'standby');

    // Mutations continue on the new leader.
    const newLeader = await coreB.status();
    assert.equal(newLeader.failover.detected, true);
    assert.match(newLeader.failover.message, /not replicated/i);
    const newRoom = await coreB.api('POST', '/v1/rooms', { headers: ADMIN, body: { name: 'After failover' } });
    assert.equal(newRoom.status, 200, newRoom.text);
    const newToken = await coreB.api('POST', '/v1/tokens', {
      headers: ADMIN,
      body: { tenantId: 'demo', roomId: newRoom.body.room.id, participant: { name: 'B' } },
    });
    assert.equal(newToken.status, 200, newToken.text);
    const takeoverStatus = await coreB.status();
    assert.ok(takeoverStatus.lease.ttlRemainingMs === null || takeoverStatus.lease.ttlRemainingMs > 0);

    // Restarting the old node id must come back as standby: it cannot grab the
    // lease while the new leader renews it, so there is still one leader.
    await coreA.server.close();
    restarted = await startCore(dataDir, { ...HA_ENV, redisUrl: redis.url, clusterNodeId: 'core-a' });
    const restartedStatus = await waitFor('restarted core standby', async () => {
      const status = await restarted!.status();
      return status.cluster.role === 'standby' ? status : null;
    });
    assert.equal(restartedStatus.lease.held, false);
    const restartedMutation = await restarted.api('POST', '/v1/rooms', { headers: ADMIN, body: { name: 'Nope' } });
    assert.equal(restartedMutation.status, 409);
    assert.equal(restartedMutation.body.error.code, 'not_leader');

    const [bNow, restartedNow] = await Promise.all([coreB.status(), restarted.status()]);
    assert.equal(bNow.cluster.role, 'leader');
    assert.equal(restartedNow.cluster.role, 'standby');
  } finally {
    await coreA?.server.close().catch(() => {});
    await coreB?.server.close().catch(() => {});
    await restarted?.server.close().catch(() => {});
    if ('child' in redis) redis.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Redis configured but role=standby opts out of election and stays read-only', { timeout: 20_000 }, async () => {
  const redis = await startRedis();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-ha-optout-'));
  const core = await startCore(dataDir, {
    ...HA_ENV,
    redisUrl: redis.url,
    clusterRole: 'standby',
    clusterNodeId: 'core-passive',
  });
  try {
    const status = await waitFor('passive standby status', async () => {
      const value = await core.status();
      return value.lease?.mode === 'redis' ? value : null;
    });
    assert.equal(status.cluster.role, 'standby');
    assert.equal(status.lease.held, false);
    const response = await core.api('POST', '/v1/rooms', { headers: ADMIN, body: { name: 'Blocked' } });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'not_leader');
  } finally {
    await core.server.close();
    if ('child' in redis) redis.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Redis voice channels survive a Core takeover without reusing old room grants', { timeout: 30_000 }, async () => {
  const redis = await startRedis();
  const firstDir = mkdtempSync(path.join(tmpdir(), 'agil-ha-voice-a-'));
  const nextDir = mkdtempSync(path.join(tmpdir(), 'agil-ha-voice-b-'));
  const options = { ...HA_ENV, redisUrl: redis.url, redisKeyPrefix: path.basename(firstDir) };
  const base = '/v1/admin/voice-channels';
  const endpoint = base + '/department/join';
  const member = { participantId: 'department-moderator', name: 'Moderator', role: 'moderator' };
  let first: Core | undefined;
  let next: Core | undefined;
  try {
    first = await startCore(firstDir, { ...options, clusterNodeId: 'voice-a' });
    await waitFor('first voice leader', async () => first?.server.leader.isLeader() ? true : null);
    next = await startCore(nextDir, { ...options, clusterNodeId: 'voice-b' });
    await waitFor('voice standby', async () => (await next?.status())?.leader?.id === 'voice-a' ? true : null);
    const created = await first.api('POST', base, { headers: ADMIN, body: { id: 'department', name: 'Department', members: [member] } });
    assert.equal(created.status, 201, created.text);
    const before = await first.api('POST', endpoint, { headers: ADMIN, body: { participantId: member.participantId } });
    assert.equal(before.status, 200, before.text);
    const shared = await next.api('GET', base + '/department', { headers: ADMIN });
    assert.deepEqual(shared.body.channel, created.body.channel);
    assert.equal((await next.api('POST', endpoint, { headers: ADMIN, body: { participantId: member.participantId } })).status, 409);
    assert.equal((await next.api('GET', base + '/department', { headers: { 'x-api-key': 'acme-key' } })).status, 404);

    await first.server.close();
    first = undefined;
    await waitFor('second voice leader', async () => next?.server.leader.isLeader() ? true : null);
    const after = await next.api('POST', endpoint, { headers: ADMIN, body: { participantId: member.participantId } });
    assert.equal(after.status, 200, after.text);
    assert.notEqual(after.body.roomId, before.body.roomId);
    const join = '/v1/rooms/' + after.body.roomId + '/join';
    assert.equal((await next.api('POST', join, { body: { token: before.body.token } })).status, 403);
    const newJoin = await next.api('POST', join, { body: { token: after.body.token } });
    assert.equal(newJoin.status, 200, newJoin.text);
    assert.deepEqual(newJoin.body.participant, { id: member.participantId, name: member.name, role: member.role });
  } finally {
    await first?.server.close();
    await next?.server.close();
    redis.stop();
    rmSync(firstDir, { recursive: true, force: true });
    rmSync(nextDir, { recursive: true, force: true });
  }
});
