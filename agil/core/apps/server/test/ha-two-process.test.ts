/**
 * Two-process HA gate (docs/ha-leader.md): two real `Core` OS processes share
 * one Redis lease. This complements `ha-cluster.test.ts`, which runs two Cores
 * in a single test process; here the leader is killed with SIGKILL (no release,
 * no graceful shutdown) and the standby must take over only after the lease
 * expires, then keep serving mutations.
 *
 * Redis comes from `AGIL_TEST_REDIS_URL`/`AGIL_REDIS_URL` when set, otherwise
 * from the bundled RESP stub (`scripts/support/mini-redis.mjs`). The stub is a
 * test double, not a Redis replacement.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROOT_DIR } from '../src/env.js';
import { openWs, type WsClient } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const PLATFORM = { 'x-api-key': 'ha-wiki-platform' };
const SERVER_DIR = path.join(ROOT_DIR, 'agil', 'core', 'apps', 'server');
const REDIS_SCRIPT = path.join(ROOT_DIR, 'agil', 'core', 'scripts', 'support', 'mini-redis.mjs');
const LEASE_TTL_MS = 2_500;
const POLL_MS = 100;

interface RedisHandle {
  url: string;
  stop(): void;
}

interface CoreProcess {
  child: ChildProcess;
  base: string;
  logs: string[];
  api(method: string, route: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  status(): Promise<any>;
  kill(): Promise<void>;
}

/** Reserves an ephemeral port, then releases it for the child to bind. */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

async function startRedis(): Promise<RedisHandle> {
  const external = (process.env.AGIL_TEST_REDIS_URL ?? process.env.AGIL_REDIS_URL ?? '').trim();
  if (external) return { url: external, stop() {} };
  const child = spawn(process.execPath, [REDIS_SCRIPT, '--port', '0', '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('mini-redis did not start in 5 s')), 5_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      for (const line of output.split(/\r?\n/)) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const parsed = JSON.parse(line) as { port?: number };
          if (parsed.port) {
            clearTimeout(timer);
            resolve(parsed.port);
          }
        } catch {
          /* wait for a complete line */
        }
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
    stop() {
      child.kill('SIGKILL');
    },
  };
}

/** Spawns one real server process (`node --import tsx src/index.ts`). */
async function startCoreProcess(options: {
  dataDir: string;
  docsDataDir: string;
  redisUrl: string;
  nodeId: string;
}): Promise<CoreProcess> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AGIL_DATA_DIR: options.dataDir,
      AGIL_DOCS_DATA_DIR: options.docsDataDir,
      AGIL_DOCS_ENABLED: '1',
      AGIL_PLATFORM_KEY: PLATFORM['x-api-key'],
      AGIL_TOKEN_SECRET: 'test-secret-0123456789',
      AGIL_API_KEYS: 'dev-key:demo',
      AGIL_ALLOW_ANONYMOUS: '1',
      AGIL_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      AGIL_CLUSTER_ID: 'ha-process-test',
      AGIL_CLUSTER_NODE_ID: options.nodeId,
      AGIL_REDIS_URL: options.redisUrl,
      AGIL_CONTINUITY: '1',
      AGIL_ROOM_SNAPSHOT_STORE: 'redis',
      AGIL_ROOM_SNAPSHOT_FLUSH_MS: '100',
      AGIL_LEADER_LEASE_TTL_MS: String(LEASE_TTL_MS),
      AGIL_LEADER_RENEW_INTERVAL_MS: '400',
      AGIL_LEADER_RETRY_INTERVAL_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  const collect = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    logs.push(text);
    // Keep the diagnostic buffer bounded in long runs.
    if (logs.length > 400) logs.splice(0, logs.length - 400);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const base = `http://127.0.0.1:${port}`;
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const core: CoreProcess = {
    child,
    base,
    logs,
    async api(method, route, body, headers = ADMIN) {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: response.status, body: parsed };
    },
    async status() {
      const response = await fetch(`${base}/v1/admin/cluster/status`, {
        headers: ADMIN,
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.status, 200, `status ${response.status}`);
      return response.json();
    },
    /** SIGKILL: the lease is not released; the standby must wait for the TTL. */
    async kill() {
      if (exited) return;
      const done = new Promise<void>((resolve) => {
        if (exited) return resolve();
        child.once('exit', () => resolve());
      });
      child.kill('SIGKILL');
      // Never let cleanup hang the whole suite if the OS does not report exit.
      await Promise.race([
        done,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          timer.unref?.();
        }),
      ]);
    },
  };

  // Wait for the HTTP listener instead of parsing log lines (buffering differs
  // between POSIX pipes and Windows).
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (exited) {
      throw new Error(`core ${options.nodeId} exited during startup:\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return core;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      await core.kill().catch(() => {});
      throw new Error(`core ${options.nodeId} did not start in 20 s:\n${logs.join('')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = 15_000,
  child?: CoreProcess,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${label}${child ? `\n${child.logs.join('')}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

test('two Core processes + Redis: kill -9 the leader, standby takes over after the lease expires', { timeout: 90_000 }, async () => {
  const redis = await startRedis();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-ha-proc-'));
  const standbyDir = mkdtempSync(path.join(tmpdir(), 'agil-ha-standby-'));
  const docsDataDir = mkdtempSync(path.join(tmpdir(), 'agil-ha-docs-'));
  const cores: CoreProcess[] = [];
  const clients: WsClient[] = [];
  try {
    const a = await startCoreProcess({ dataDir, docsDataDir, redisUrl: redis.url, nodeId: 'proc-a' });
    cores.push(a);
    const leaderA = await waitFor('proc-a leader', async () => {
      const status = await a.status();
      return status.cluster.role === 'leader' && status.lease?.held ? status : null;
    }, 15_000, a);
    assert.equal(leaderA.lease.mode, 'redis');
    assert.equal(leaderA.leader.self, true);
    assert.ok(leaderA.lease.validUntil > Date.now());

    const b = await startCoreProcess({ dataDir: standbyDir, docsDataDir, redisUrl: redis.url, nodeId: 'proc-b' });
    cores.push(b);
    const standbyB = await waitFor('proc-b standby', async () => {
      const status = await b.status();
      return status.cluster.role === 'standby' && status.lease?.held === false ? status : null;
    }, 15_000, b);
    assert.equal(standbyB.leader.id, 'proc-a');
    assert.equal(standbyB.leader.self, false);
    assert.deepEqual(await a.api('GET', '/v1/ready', undefined, {}), { status: 200, body: { ready: true } });
    assert.deepEqual(await b.api('GET', '/v1/ready', undefined, {}), { status: 503, body: { ready: false } });
    assert.equal((await b.api('GET', '/v1/health', undefined, {})).status, 200);

    // Standby is read-only at the HTTP layer, in a separate OS process.
    const blocked = await b.api('POST', '/v1/rooms', { name: 'Standby room' });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error.code, 'not_leader');

    // Leader mutations still work.
    const roomA = await a.api('POST', '/v1/rooms', { name: 'Leader room', allowedParticipantIds: ['company-alice'] });
    assert.equal(roomA.status, 200, JSON.stringify(roomA.body));
    assert.ok(roomA.body.room.id);
    const liveTokenResult = await a.api('POST', '/v1/tokens', {
      tenantId: 'demo', roomId: roomA.body.room.id,
      participant: { name: 'Alice', participantId: 'company-alice' },
    });
    assert.equal(liveTokenResult.status, 200);
    const token = liveTokenResult.body.token as string;
    const protocols = ['agil-calls.v1', `agil-token.${encodeURIComponent(token)}`];
    const connected = await openWs(a.base.replace(/^http:/, 'ws:') + '/ws?resume=1', protocols);
    clients.push(connected);
    const welcome = await connected.waitFor((message) => message.type === 'welcome');
    const resumeToken = welcome.resume?.token as string;
    assert.ok(resumeToken);
    assert.equal(welcome.self.id, 'company-alice');

    const lobby = await a.api('POST', '/v1/rooms', {
      name: 'Failover lobby', configOverrides: { security: { waitingRoom: true } },
    });
    assert.equal(lobby.status, 200);
    const lobbyPrefix = `/v1/rooms/${lobby.body.room.id}`;
    const pending = await a.api('POST', lobbyPrefix + '/join', { name: 'Pending guest', participantId: 'pending-guest' }, {});
    const admitted = await a.api('POST', lobbyPrefix + '/join', { name: 'Admitted guest', participantId: 'admitted-guest' }, {});
    assert.equal(pending.status, 202);
    assert.equal(admitted.status, 202);
    const pendingUrl = `${lobbyPrefix}/lobby/${pending.body.requestId}`;
    const admittedUrl = `${lobbyPrefix}/lobby/${admitted.body.requestId}`;
    const admission = await a.api('POST', admittedUrl + '/admit');
    assert.equal(admission.status, 200);

    const documentName = 'wiki-setup.md';
    const docPath = '/v1/admin/docs/' + documentName;
    const original = await a.api('GET', docPath, undefined, PLATFORM);
    assert.equal(original.status, 200);
    const first = await a.api('PUT', docPath, { content: '# First Wiki publication', expectedRevision: original.body.revision }, PLATFORM);
    assert.equal(first.status, 200);
    const latest = await a.api('PUT', docPath, { content: '# Current Wiki publication', expectedRevision: first.body.revision }, PLATFORM);
    assert.equal(latest.status, 200);
    assert.equal((await a.api('PUT', '/v1/admin/docs/default', { name: documentName }, PLATFORM)).status, 200);
    assert.equal((await b.api('GET', '/docs/' + documentName)).body, latest.body.content);
    const before = await a.api('GET', docPath + '/versions', undefined, PLATFORM);
    assert.equal(before.status, 200);
    const archived = before.body.versions.find((version: { isCurrent: boolean }) => !version.isCurrent);
    assert.ok(archived);
    const readOnly = await b.api('PUT', docPath, { content: '# Standby write' }, PLATFORM);
    assert.equal(readOnly.status, 409);
    assert.equal(readOnly.body.error.code, 'not_leader');
    const restorePath = docPath + '/versions/' + archived.id + '/restore';
    const blockedRestore = await b.api('POST', restorePath, { expectedRevision: latest.body.revision }, PLATFORM);
    assert.equal(blockedRestore.status, 409);
    assert.equal(blockedRestore.body.error.code, 'not_leader');
    const blockedReset = await b.api('DELETE', docPath, undefined, PLATFORM);
    assert.equal(blockedReset.status, 409);
    assert.equal(blockedReset.body.error.code, 'not_leader');
    assert.equal((await a.api('GET', '/docs/' + documentName)).body, latest.body.content);

    // Wait for the agreed snapshot boundary before simulating a hard failure.
    const url = new URL(redis.url);
    const { RedisClient } = await import('../src/redis-client.js');
    const client = new RedisClient({ url: url.toString() });
    try {
      await client.connect();
      await waitFor('live participant snapshot in shared Redis', async () => {
        const raw = await client.command(['GET', 'agil:room:demo:' + roomA.body.room.id]);
        if (typeof raw !== 'string') return null;
        const snapshot = JSON.parse(raw) as { participants: Array<{ participant: { id: string }; resumeTokenHash?: string }> };
        return snapshot.participants.some((entry) => entry.participant.id === 'company-alice' && entry.resumeTokenHash) ? true : null;
      });
      const lobbySnapshot = await client.command(['GET', 'agil:room:demo:' + lobby.body.room.id]);
      assert.equal(typeof lobbySnapshot, 'string');
      assert.equal(typeof JSON.parse(String(lobbySnapshot)).sealedLobby, 'string');
      assert.ok(!String(lobbySnapshot).includes(admission.body.token));
      assert.ok(!String(lobbySnapshot).includes(pending.body.cancelToken));
    } finally {
      client.close();
    }

    // Kill -9 the leader: no release, no flush, no cleanup.
    const fenceDeadline = (await a.status()).lease.validUntil;
    await a.kill();
    const killedAt = Date.now();

    const leaderB = await waitFor('proc-b takeover', async () => {
      const status = await b.status();
      return status.cluster.role === 'leader' && status.lease?.held ? status : null;
    }, 15_000, b);
    const takeoverAt = Date.now();

    // The standby cannot acquire before the dead leader's own fencing
    // deadline: that window is exactly what prevents split-brain mutations.
    assert.ok(
      takeoverAt >= fenceDeadline,
      `standby became leader ${fenceDeadline - takeoverAt} ms before the previous lease deadline`,
    );
    assert.ok(takeoverAt - killedAt >= LEASE_TTL_MS / 2, 'takeover was suspiciously fast for a SIGKILL');
    assert.equal(leaderB.leader.self, true);
    assert.equal(leaderB.failover.detected, true);
    assert.equal(leaderB.failover.previousLeaderId, 'proc-a');
    assert.match(leaderB.failover.message, /not replicated/i);

    await waitFor('proc-b ready after room restoration', async () =>
      (await b.api('GET', '/v1/ready', undefined, {})).status === 200 ? true : null, 5_000, b);
    const waiting = await b.api('GET', pendingUrl, undefined, {});
    assert.deepEqual(waiting, { status: 200, body: {
      requestId: pending.body.requestId, status: 'pending', expiresAt: pending.body.expiresAt,
    } });
    const restoredQueue = await b.api('GET', `${lobbyPrefix}/lobby`);
    assert.deepEqual(restoredQueue.body.requests.map((item: { requestId: string; id?: string }) => item.requestId ?? item.id), [pending.body.requestId]);
    assert.equal((await b.api('POST', admittedUrl + '/admit')).status, 404);
    const polls = await Promise.all([b.api('GET', admittedUrl, undefined, {}), b.api('GET', admittedUrl, undefined, {})]);
    assert.ok(polls.every((poll) => poll.status === 200 && poll.body.status === 'admitted'));
    assert.deepEqual(polls.flatMap((poll) => poll.body.token ? [poll.body.token] : []), [admission.body.token]);
    assert.ok(polls.filter((poll) => !poll.body.token).every((poll) => !poll.body.joinUrl && !poll.body.embedUrl));
    assert.equal((await b.api('POST', pendingUrl + '/cancel', { cancelToken: pending.body.cancelToken }, {})).status, 200);

    const after = await b.api('GET', docPath, undefined, PLATFORM);
    assert.equal(after.status, 200);
    assert.equal(after.body.revision, latest.body.revision);
    assert.equal(after.body.isDefault, true);
    assert.equal((await b.api('GET', '/docs/' + documentName)).body, latest.body.content);
    const history = await b.api('GET', docPath + '/versions', undefined, PLATFORM);
    assert.deepEqual(history.body.versions, before.body.versions);
    assert.equal((await b.api('POST', restorePath)).status, 403);
    const restored = await b.api('POST', restorePath, { expectedRevision: latest.body.revision }, PLATFORM);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.content, first.body.content);

    const recovered = await waitFor('existing room on the new leader', async () => {
      const response = await b.api('GET', '/v1/rooms/' + roomA.body.room.id);
      return response.status === 200 ? response.body.room : null;
    }, 5_000, b);
    assert.equal(recovered.id, roomA.body.room.id);
    assert.equal(recovered.name, 'Leader room');
    const resumed = await openWs(b.base.replace(/^http:/, 'ws:') + '/ws?resume=1', [
      ...protocols, `agil-resume.${encodeURIComponent(resumeToken)}`,
    ]);
    clients.push(resumed);
    const restoredWelcome = await resumed.waitFor((message) => message.type === 'welcome');
    assert.equal(restoredWelcome.resumed, true);
    assert.equal(restoredWelcome.room.id, recovered.id);
    assert.equal(restoredWelcome.self.id, welcome.self.id);
    const denied = await b.api('POST', '/v1/tokens', {
      tenantId: 'demo', roomId: recovered.id, participant: { name: 'Other', participantId: 'company-other' },
    });
    assert.equal(denied.status, 403);
    const allowed = await b.api('POST', '/v1/tokens', {
      tenantId: 'demo', roomId: recovered.id, participant: { name: 'Alice', participantId: 'company-alice' },
    });
    assert.equal(allowed.status, 200);

    // Mutations continue on the new leader.
    const roomB = await b.api('POST', '/v1/rooms', { name: 'After failover' });
    assert.equal(roomB.status, 200, JSON.stringify(roomB.body));
    const tokenB = await b.api('POST', '/v1/tokens', {
      tenantId: 'demo',
      roomId: roomB.body.room.id,
      participant: { name: 'B' },
    });
    assert.equal(tokenB.status, 200, JSON.stringify(tokenB.body));
    assert.ok(tokenB.body.token);

    // The old node id comes back as standby, not as a second leader.
    const a2 = await startCoreProcess({ dataDir, docsDataDir, redisUrl: redis.url, nodeId: 'proc-a' });
    cores.push(a2);
    const standbyA2 = await waitFor('restarted proc-a standby', async () => {
      const status = await a2.status();
      return status.cluster.role === 'standby' ? status : null;
    }, 15_000, a2);
    assert.equal(standbyA2.lease.held, false);
    const rejectedA2 = await a2.api('POST', '/v1/rooms', { name: 'Nope' });
    assert.equal(rejectedA2.status, 409);
    assert.equal(rejectedA2.body.error.code, 'not_leader');
    assert.equal((await a2.api('GET', '/docs/' + documentName)).body, restored.body.content);
    assert.equal((await b.status()).cluster.role, 'leader');
    assert.equal((await a2.api('GET', '/v1/ready', undefined, {})).status, 503);
    await b.kill();
    await waitFor('restarted proc-a ready after second takeover', async () =>
      (await a2.api('GET', '/v1/ready', undefined, {})).status === 200 ? true : null, 15_000, a2);
    const delivered = await a2.api('GET', admittedUrl, undefined, {});
    assert.equal(delivered.status, 200);
    assert.equal(delivered.body.status, 'admitted');
    assert.equal(delivered.body.token, undefined);
    assert.equal(delivered.body.joinUrl, undefined);
    assert.equal(delivered.body.embedUrl, undefined);
    assert.equal((await a2.api('GET', pendingUrl, undefined, {})).status, 404);
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    for (const core of cores) await core.kill().catch(() => {});
    redis.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(standbyDir, { recursive: true, force: true });
    rmSync(docsDataDir, { recursive: true, force: true });
  }
});
