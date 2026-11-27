/**
 * Core leader election and failover through a Redis lease (docs/ha-leader.md).
 *
 * One Redis key per cluster holds the leader id with a TTL:
 *
 *   agil:cluster:<clusterId>:leader          SET NX PX <ttl>; renewed via Lua
 *   agil:cluster:<clusterId>:registry-lock   node-registry write lock (same TTL)
 *   agil:cluster:<clusterId>:state           HSET leaderId/since/heartbeatAt/…
 *
 * Safety model: a Core acts as leader only while `Date.now() < validUntil`,
 * where `validUntil` is computed from the moment the renewing command was
 * **sent** plus the TTL. That fence prevents split-brain: a standby cannot
 * acquire before the key expires, and the previous leader cannot mutate after
 * its local deadline.
 *
 * Without `AGIL_REDIS_URL` there is no lease: the process runs standalone and
 * `AGIL_CLUSTER_ROLE` decides between active and read-only.
 */
import { hostname } from 'node:os';
import {
  clusterIdSchema,
  type ClusterFailoverStatus,
  type ClusterLeaderStatus,
  type ClusterMode,
  type ClusterRole,
  type LeaderLeaseStatus,
} from '@agil/protocol';
import type { Env } from './env.js';
import { HttpError } from './http.js';
import type { Logger } from './logger.js';
import { RedisClient } from './redis-client.js';

/** Compare-and-PEXPIRE: renew only while this Core still owns the key. */
export const RENEW_LEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
/** Compare-and-DEL: release only a lease this Core still owns. */
export const RELEASE_LEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const LEADER_VALUE_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return {'fenced'} end
local current = redis.call('get', KEYS[2]) or ''
if ARGV[2] == 'read' or current ~= ARGV[3] then return {'observed', current} end
if ARGV[4] == '' then redis.call('del', KEYS[2]) else redis.call('set', KEYS[2], ARGV[4]) end
return {'updated', ARGV[4]}
`;

/** Synchronous role gate used by the registry/token/room mutations. */
export interface LeadershipGate {
  readonly mode: ClusterMode;
  role(): ClusterRole;
  /** True while this Core may accept mutations (leader + unexpired fence). */
  isLeader(): boolean;
  /** Throws `409 not_leader` when this Core may not mutate. */
  assertLeader(operation: string): void;
  /** Throws when the node-registry write lock is not held. */
  assertRegistryWritable(): void;
  /** Refreshes from Redis when possible and returns the current view. */
  describe(): Promise<LeaderSnapshot>;
  /** Current cached view without network I/O. */
  snapshot(): LeaderSnapshot;
  close(): Promise<void>;
}

/** Immutable view of leadership state used to build the admin status. */
export interface LeaderSnapshot {
  mode: ClusterMode;
  nodeId: string;
  clusterId: string;
  role: ClusterRole;
  leaderId: string | null;
  leaderSince: number | null;
  heartbeatAt: number | null;
  leaseTtlMs: number;
  leaseTtlRemainingMs: number | null;
  validUntil: number | null;
  registryLockHeld: boolean;
  registryLockTtlRemainingMs: number | null;
  redisConnected: boolean;
  renewalFailures: number;
  reason: string;
  failover: ClusterFailoverStatus;
}

export interface LeaderElectorOptions {
  env: Env;
  clusterId: string;
  /** Server version reported in the shared state hash. */
  version: string;
  publicOrigin: string;
  logger?: Logger;
  /** Called synchronously after this Core becomes leader (reload the registry). */
  onPromote?: () => void;
  /** Called synchronously after leadership is lost (clear in-memory rooms). */
  onDemote?: () => void;
}

/** Effective cluster id shared by the registry and the lease namespace. */
export function resolveClusterId(env: Pick<Env, 'clusterId' | 'redisUrl'>): string {
  const configured = env.clusterId.trim();
  if (configured && clusterIdSchema.safeParse(configured).success) return configured;
  return env.redisUrl ? 'default' : '';
}

/** Lease value / operator id: `<hostname>:<port>` unless configured. */
export function resolveNodeId(env: Pick<Env, 'clusterNodeId' | 'port'>): string {
  const raw = env.clusterNodeId.trim() || `${hostname()}:${env.port}`;
  const cleaned = raw
    .replace(/[^A-Za-z0-9._:-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64);
  return cleaned || `core-${process.pid}`;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function asRecord(reply: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!Array.isArray(reply)) return result;
  for (let index = 0; index + 1 < reply.length; index += 2) {
    const key = String(reply[index]);
    const value = String(reply[index + 1]);
    result[key] = value;
  }
  return result;
}

function notLeaderError(reason: string, operation: string): HttpError {
  return new HttpError(
    409,
    'not_leader',
    `This Core is a standby (${reason}); ${operation} requires the leader lease — retry against the current leader (docs/ha-leader.md)`,
  );
}

/**
 * Leader election state machine. One instance per Core; `start()` connects and
 * tries to acquire immediately, then a single timer renews or retries.
 */
export class LeaderElector implements LeadershipGate {
  readonly mode: ClusterMode;
  readonly nodeId: string;
  readonly clusterId: string;

  private readonly env: Env;
  private readonly version: string;
  private readonly publicOrigin: string;
  private readonly logger?: Logger;
  private readonly onPromote?: () => void;
  private readonly onDemote?: () => void;
  private readonly participates: boolean;
  private readonly leaseKey: string;
  private readonly registryLockKey: string;
  private readonly stateKey: string;
  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;
  private readonly retryIntervalMs: number;

  private client: RedisClient | null = null;
  private roleValue: ClusterRole = 'standby';
  private leaderIdValue: string | null = null;
  private leaderSinceValue: number | null = null;
  private heartbeatAtValue: number | null = null;
  private validUntilValue: number | null = null;
  private registryValidUntilValue: number | null = null;
  private registryLockHeldValue = false;
  private leaseRemainingMs: number | null = null;
  private renewalFailuresValue = 0;
  private redisConnectedValue = false;
  private reasonValue = 'starting';
  private failoverDetectedValue = false;
  private previousLeaderIdValue: string | null = null;
  private failoverChangedAtValue: number | null = null;
  /** Last leader observed through Redis while this Core was standby. */
  private observedLeaderId: string | null = null;

  private started = false;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private lastRenewAt = 0;
  private lastAttemptAt = 0;
  private lastRefreshAt = 0;

  constructor(options: LeaderElectorOptions) {
    this.env = options.env;
    this.mode = options.env.redisUrl ? 'redis' : 'standalone';
    this.clusterId = options.clusterId || 'default';
    this.nodeId = resolveNodeId(options.env);
    this.version = options.version;
    this.publicOrigin = options.publicOrigin;
    this.logger = options.logger;
    this.onPromote = options.onPromote;
    this.onDemote = options.onDemote;
    this.participates = options.env.clusterRole !== 'standby';
    this.ttlMs = options.env.leaderLeaseTtlMs;
    this.renewIntervalMs = options.env.leaderRenewIntervalMs;
    this.retryIntervalMs = options.env.leaderRetryIntervalMs;
    const base = `${options.env.redisKeyPrefix}:cluster:${this.clusterId}`;
    this.leaseKey = `${base}:leader`;
    this.registryLockKey = `${base}:registry-lock`;
    this.stateKey = `${base}:state`;
    if (this.mode === 'standalone') {
      this.roleValue = options.env.clusterRole;
      this.reasonValue =
        this.roleValue === 'leader'
          ? 'standalone (AGIL_REDIS_URL is empty): this Core is the single active Core'
          : 'standalone (AGIL_REDIS_URL is empty) + AGIL_CLUSTER_ROLE=standby: read-only';
      this.leaderIdValue = this.roleValue === 'leader' ? this.nodeId : null;
      this.leaderSinceValue = this.roleValue === 'leader' ? Date.now() : null;
      this.heartbeatAtValue = this.leaderSinceValue;
    }
  }

  /* ------------------------------------------------------------------ */
  /* LeadershipGate                                                      */
  /* ------------------------------------------------------------------ */

  role(): ClusterRole {
    if (this.mode === 'standalone') return this.roleValue;
    // Lazy fencing: even if the timer is delayed or stopped, a Core whose
    // deadline passed can never accept a mutation.
    if (this.roleValue === 'leader' && !this.leaseValid()) {
      this.demote('leader lease deadline passed without a renewal (fenced)');
    }
    return this.roleValue;
  }

  isLeader(): boolean {
    return this.role() === 'leader';
  }

  assertLeader(operation: string): void {
    if (this.role() === 'leader') return;
    throw notLeaderError(this.reasonValue, operation);
  }

  /** Read shared data from either role. All changes still go through the lease check. */
  async readSharedValue(key: string): Promise<string | null> {
    if (!this.client) throw new HttpError(503, 'shared_state_unavailable', 'Shared state requires Redis');
    const value = await this.client.command(['GET', `${this.stateKey}:value:${key}`]).catch(() => {
      throw new HttpError(503, 'shared_state_unavailable', 'Shared state is unavailable');
    });
    if (value !== null && typeof value !== 'string') {
      throw new HttpError(503, 'shared_state_unavailable', 'Redis returned invalid shared state');
    }
    return value;
  }

  /** Run an atomic data write whose script checks the current lease before changing any key. */
  async writeUnderLease(script: string, keys: string[], args: Array<string | number>): Promise<void> {
    const operation = 'room snapshot write';
    this.assertLeader(operation);
    if (!this.client) throw new HttpError(503, 'shared_state_unavailable', 'Shared leader state requires Redis');
    const reply = await this.client.command(['EVAL', script, keys.length + 1, this.leaseKey, ...keys, this.nodeId, ...args]);
    if (reply === 0) {
      this.demote('Redis lease lost before room snapshot write');
      throw notLeaderError(this.reasonValue, operation);
    }
    if (reply !== 1) throw new HttpError(503, 'shared_state_unavailable', 'Redis returned an invalid room snapshot result');
    this.assertLeader(operation);
  }

  /** Reads or conditionally replaces a non-empty shared value with the lease check in the same Redis command. */
  async leaderValue(key: string, change?: { expected: string | null; next: string | null }): Promise<{
    value: string | null;
    changed: boolean;
  }> {
    const operation = 'shared leader state';
    this.assertLeader(operation);
    if (!this.client) throw new HttpError(503, 'shared_state_unavailable', 'Shared leader state requires Redis');
    const reply = await this.client.command([
      'EVAL', LEADER_VALUE_SCRIPT, 2, this.leaseKey, `${this.stateKey}:value:${key}`, this.nodeId,
      change ? 'compare' : 'read', change?.expected ?? '', change?.next ?? '',
    ]).catch(() => {
      throw new HttpError(503, 'shared_state_unavailable', 'Shared leader state is unavailable');
    });
    if (Array.isArray(reply) && reply[0] === 'fenced') {
      this.demote('Redis lease lost before shared state operation');
      throw notLeaderError(this.reasonValue, operation);
    }
    if (!Array.isArray(reply) || (reply[0] !== 'observed' && reply[0] !== 'updated') || typeof reply[1] !== 'string') {
      throw new HttpError(503, 'shared_state_unavailable', 'Redis returned invalid shared leader state');
    }
    this.assertLeader(operation);
    return { value: reply[1] || null, changed: reply[0] === 'updated' };
  }

  assertRegistryWritable(): void {
    this.assertLeader('node registry writes');
    if (this.mode === 'standalone') return;
    if (!this.registryLockHeldValue || this.registryValidUntilValue === null || Date.now() >= this.registryValidUntilValue) {
      this.demote('node registry lock expired (fail closed)');
      throw new HttpError(
        503,
        'registry_unavailable',
        'This Core lost the node-registry lock; retry against the current leader',
      );
    }
  }

  private leaseValid(): boolean {
    return this.validUntilValue !== null && Date.now() < this.validUntilValue;
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.mode === 'standalone') {
      this.logger?.info('leadership: standalone mode (no AGIL_REDIS_URL)', { role: this.roleValue, nodeId: this.nodeId });
      return;
    }
    this.client = new RedisClient({
      url: this.env.redisUrl,
      onConnect: () => {
        this.redisConnectedValue = true;
        // Newly connected: try to take the lease immediately instead of waiting
        // for the next retry tick.
        this.lastAttemptAt = 0;
        if (this.roleValue !== 'leader') {
          this.reasonValue = this.participates
            ? 'connected to Redis; trying to acquire the leader lease'
            : 'AGIL_CLUSTER_ROLE=standby: connected to Redis, election opted out';
        }
      },
      onDisconnect: (error) => {
        this.redisConnectedValue = false;
        if (this.roleValue === 'leader') {
          this.reasonValue = `leader: Redis connection lost (${error.message}); fencing deadline in ${Math.max(0, (this.validUntilValue ?? 0) - Date.now())} ms`;
          this.logger?.warn('leadership: Redis connection lost; mutations stop at the fencing deadline', {
            nodeId: this.nodeId,
            validUntil: this.validUntilValue,
            error: error.message,
          });
        } else {
          this.reasonValue = `standby: Redis connection lost (${error.message}); retrying`;
        }
      },
      onConnectError: (error) => {
        this.redisConnectedValue = false;
        this.reasonValue = `standby: Redis unavailable (${error.message}); retrying`;
      },
    });
    this.reasonValue = this.participates
      ? 'starting: connecting to Redis to acquire the leader lease'
      : 'AGIL_CLUSTER_ROLE=standby: this Core opts out of leader election';
    try {
      await this.client.connect();
      this.redisConnectedValue = true;
      if (this.participates) await this.tryAcquire();
      else await this.refreshFromRedis();
    } catch (error) {
      this.redisConnectedValue = false;
      this.reasonValue = `standby: Redis unavailable (${error instanceof Error ? error.message : String(error)}); retrying`;
      this.logger?.warn('leadership: cannot reach Redis; starting as standby (fail closed)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const tickMs = Math.max(100, Math.min(this.renewIntervalMs, this.retryIntervalMs));
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.mode === 'redis' && this.client?.connected && this.roleValue === 'leader') {
      try {
        await this.releaseLease();
      } catch {
        /* best effort: the TTL expires the lease anyway */
      }
    }
    this.roleValue = 'standby';
    this.registryLockHeldValue = false;
    this.validUntilValue = null;
    this.registryValidUntilValue = null;
    this.client?.close();
    this.client = null;
  }

  /**
   * Test/ops hook: stop renewing and drop the Redis socket **without**
   * releasing the lease, emulating a crashed or network-partitioned process
   * that is still running. Fencing keeps it from mutating after `validUntil`.
   */
  disconnect(): void {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.client?.close();
    this.client = null;
    this.redisConnectedValue = false;
    this.reasonValue = `leader: Redis disconnected without releasing the lease; fencing deadline in ${Math.max(0, (this.validUntilValue ?? 0) - Date.now())} ms`;
  }

  /* ------------------------------------------------------------------ */
  /* Lease operations                                                    */
  /* ------------------------------------------------------------------ */

  private async tryAcquire(): Promise<void> {
    if (this.closed || !this.client?.connected) return;
    this.lastAttemptAt = Date.now();
    const sentAt = Date.now();
    let reply;
    try {
      reply = await this.client.command(['SET', this.leaseKey, this.nodeId, 'NX', 'PX', String(this.ttlMs)]);
      this.redisConnectedValue = true;
    } catch (error) {
      this.redisConnectedValue = false;
      this.reasonValue = `standby: lease acquisition failed (${error instanceof Error ? error.message : String(error)}); retrying`;
      return;
    }
    if (reply !== 'OK') {
      this.reasonValue = 'standby: the leader lease is held by another Core (or not yet expired)';
      await this.refreshFromRedis();
      return;
    }
    // The node-registry write lock is a second, explicit shared lock: the
    // registry is a file, but only the Core holding this key may write it.
    const registrySentAt = Date.now();
    let lockReply;
    try {
      lockReply = await this.client.command([
        'SET',
        this.registryLockKey,
        this.nodeId,
        'NX',
        'PX',
        String(this.ttlMs),
      ]);
    } catch (error) {
      await this.releaseLease();
      this.reasonValue = `standby: registry lock acquisition failed (${error instanceof Error ? error.message : String(error)}); retrying`;
      return;
    }
    if (lockReply !== 'OK') {
      await this.releaseLease();
      this.reasonValue = 'standby: the node-registry lock is held by another Core; released the lease and retrying';
      this.logger?.warn('leadership: lease won but registry lock was held; stepped down', { nodeId: this.nodeId });
      return;
    }
    this.becomeLeader(sentAt, registrySentAt, Date.now());
  }

  private becomeLeader(leaseSentAt: number, registrySentAt: number, now: number): void {
    // Failover is reported only when another leader was actually observed
    // before this acquisition.
    const previous = this.observedLeaderId && this.observedLeaderId !== this.nodeId ? this.observedLeaderId : null;
    if (previous && previous !== this.nodeId) {
      this.failoverDetectedValue = true;
      this.previousLeaderIdValue = previous;
      this.failoverChangedAtValue = now;
    }
    this.roleValue = 'leader';
    this.leaderIdValue = this.nodeId;
    this.observedLeaderId = this.nodeId;
    this.leaderSinceValue = now;
    this.heartbeatAtValue = now;
    // Fence from the send time: Redis expires the key no earlier than
    // `leaseSentAt + ttl`, so the local deadline is conservative.
    this.validUntilValue = leaseSentAt + this.ttlMs;
    this.registryValidUntilValue = registrySentAt + this.ttlMs;
    this.registryLockHeldValue = true;
    this.leaseRemainingMs = this.ttlMs;
    this.renewalFailuresValue = 0;
    this.reasonValue = 'leader: lease acquired';
    this.lastRenewAt = now;
    this.logger?.info('leadership: acquired the leader lease', {
      nodeId: this.nodeId,
      clusterId: this.clusterId,
      previousLeaderId: this.previousLeaderIdValue,
      failover: this.failoverDetectedValue,
      validUntil: this.validUntilValue,
    });
    try {
      this.onPromote?.();
    } catch (error) {
      this.logger?.warn('leadership: onPromote hook failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.writeSharedState();
  }

  private async renew(): Promise<void> {
    if (this.closed || this.roleValue !== 'leader' || !this.client?.connected) return;
    const now = Date.now();
    if (!this.leaseValid()) {
      this.demote('leader lease deadline passed before renewal (fenced)');
      return;
    }
    const leaseSentAt = now;
    try {
      const renewed = await this.client.command([
        'EVAL',
        RENEW_LEASE_SCRIPT,
        '1',
        this.leaseKey,
        this.nodeId,
        String(this.ttlMs),
      ]);
      if (Number(renewed) !== 1) {
        this.demote('leader lease lost (expired or taken by another Core)');
        return;
      }
      this.validUntilValue = leaseSentAt + this.ttlMs;
      const registrySentAt = Date.now();
      const registryRenewed = await this.client.command([
        'EVAL',
        RENEW_LEASE_SCRIPT,
        '1',
        this.registryLockKey,
        this.nodeId,
        String(this.ttlMs),
      ]);
      if (Number(registryRenewed) !== 1) {
        this.demote('node registry lock lost (fail closed)');
        await this.releaseLease();
        return;
      }
      this.registryValidUntilValue = registrySentAt + this.ttlMs;
      this.heartbeatAtValue = now;
      this.leaseRemainingMs = Math.max(0, this.validUntilValue - Date.now());
      this.renewalFailuresValue = 0;
      this.reasonValue = 'leader: lease renewed';
      this.lastRenewAt = now;
      this.writeSharedState();
    } catch (error) {
      this.renewalFailuresValue += 1;
      const message = error instanceof Error ? error.message : String(error);
      const remaining = Math.max(0, (this.validUntilValue ?? 0) - Date.now());
      if (remaining <= 0) {
        this.demote(`lease renewal failed and the fencing deadline passed (${message})`);
      } else {
        this.reasonValue = `leader: renewal failed (${message}); fencing deadline in ${remaining} ms`;
        this.logger?.warn('leadership: lease renewal failed; still leader until the fencing deadline', {
          nodeId: this.nodeId,
          failures: this.renewalFailuresValue,
          remainingMs: remaining,
          error: message,
        });
      }
    }
  }

  private demote(reason: string): void {
    if (this.roleValue !== 'leader' && this.reasonValue === reason) return;
    const wasLeader = this.roleValue === 'leader';
    this.roleValue = 'standby';
    this.registryLockHeldValue = false;
    this.registryValidUntilValue = null;
    this.validUntilValue = null;
    this.leaseRemainingMs = 0;
    this.leaderIdValue = this.observedLeaderId === this.nodeId ? null : this.observedLeaderId;
    this.reasonValue = `standby: ${reason}`;
    if (!wasLeader) return;
    this.logger?.warn('leadership: stepped down', { nodeId: this.nodeId, reason });
    try {
      this.onDemote?.();
    } catch (error) {
      this.logger?.warn('leadership: onDemote hook failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async releaseLease(): Promise<void> {
    if (!this.client?.connected) return;
    try {
      await this.client.command(['EVAL', RELEASE_LEASE_SCRIPT, '1', this.leaseKey, this.nodeId]);
      await this.client.command(['EVAL', RELEASE_LEASE_SCRIPT, '1', this.registryLockKey, this.nodeId]);
    } catch {
      /* best effort: the TTL is the backstop */
    }
  }

  /** Publishes leader id/heartbeat so a standby can show who leads. */
  private writeSharedState(): void {
    if (!this.client?.connected) return;
    const now = this.heartbeatAtValue ?? Date.now();
    void this.client
      .command([
        'HSET',
        this.stateKey,
        'leaderId',
        this.nodeId,
        'since',
        String(this.leaderSinceValue ?? now),
        'heartbeatAt',
        String(now),
        'version',
        this.version,
        'publicOrigin',
        this.publicOrigin,
        'leaseTtlMs',
        String(this.ttlMs),
      ])
      .then(() => this.client?.command(['PEXPIRE', this.stateKey, String(Math.max(this.ttlMs * 3, 15_000))]))
      .catch(() => {
        /* the lease itself is authoritative; state is advisory */
      });
  }

  /* ------------------------------------------------------------------ */
  /* Tick / observation                                                  */
  /* ------------------------------------------------------------------ */

  private async tick(): Promise<void> {
    if (this.closed || this.mode === 'standalone' || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      if (!this.client?.connected) {
        try {
          await this.client?.connect();
        } catch {
          return;
        }
      }
      if (!this.client?.connected) return;
      const now = Date.now();
      if (this.roleValue === 'leader') {
        if (!this.leaseValid()) {
          this.demote('leader lease deadline passed without renewal (fenced)');
          return;
        }
        if (now - this.lastRenewAt >= this.renewIntervalMs) await this.renew();
        return;
      }
      if (this.participates && now - this.lastAttemptAt >= this.retryIntervalMs) {
        await this.tryAcquire();
        return;
      }
      if (now - this.lastRefreshAt >= this.renewIntervalMs) await this.refreshFromRedis();
    } finally {
      this.tickInFlight = false;
    }
  }

  /** Reads the shared leader/hash state while standby (status + takeover prep). */
  private async refreshFromRedis(): Promise<void> {
    if (!this.client?.connected) return;
    this.lastRefreshAt = Date.now();
    try {
      const [pttlReply, stateReply] = await Promise.all([
        this.client.command(['PTTL', this.leaseKey]),
        this.client.command(['HGETALL', this.stateKey]),
      ]);
      this.redisConnectedValue = true;
      const pttl = Number(pttlReply);
      this.leaseRemainingMs = pttl > 0 ? pttl : 0;
      const state = asRecord(stateReply);
      const leaderId = pttl > 0 && state.leaderId ? state.leaderId : null;
      const since = isPositiveInt(Number(state.since)) ? Number(state.since) : null;
      const heartbeat = isPositiveInt(Number(state.heartbeatAt)) ? Number(state.heartbeatAt) : null;
      if (leaderId && leaderId !== this.observedLeaderId) {
        if (this.observedLeaderId && this.observedLeaderId !== this.nodeId) {
          this.previousLeaderIdValue = this.observedLeaderId;
          this.failoverChangedAtValue = Date.now();
        }
        this.logger?.info('leadership: observed a new leader', { leaderId, nodeId: this.nodeId });
      }
      // Keep the last observed leader instead of clearing it when the lease
      // disappears: the key can expire between `SET NX` (which failed) and
      // `PTTL` (which now reads 0), and the Core that acquires next must still
      // report the takeover; a cold start keeps `null`.
      if (leaderId) this.observedLeaderId = leaderId;
      if (this.roleValue !== 'leader') {
        this.leaderIdValue = leaderId;
        this.leaderSinceValue = since;
        this.heartbeatAtValue = heartbeat;
        if (leaderId === this.nodeId) {
          this.reasonValue = `standby: a lease for this node id is held elsewhere — AGIL_CLUSTER_NODE_ID must be unique per Core`;
        } else if (leaderId) {
          this.reasonValue = `standby: lease held by ${leaderId} (${pttl} ms remaining)`;
        } else {
          this.reasonValue = 'standby: no leader lease — retrying acquisition';
        }
      }
    } catch (error) {
      this.redisConnectedValue = false;
      this.reasonValue = `standby: cannot read the shared state (${error instanceof Error ? error.message : String(error)}); retrying`;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Status                                                              */
  /* ------------------------------------------------------------------ */

  private failoverStatus(): ClusterFailoverStatus {
    return {
      detected: this.failoverDetectedValue,
      previousLeaderId: this.previousLeaderIdValue,
      changedAt: this.failoverChangedAtValue,
      message: this.failoverMessage(),
    };
  }

  private failoverMessage(): string {
    if (this.roleValue === 'leader') {
      if (this.failoverDetectedValue) {
        return (
          `Leadership was acquired from ${this.previousLeaderIdValue ?? 'the previous leader'} at ` +
          `${new Date(this.failoverChangedAtValue ?? Date.now()).toISOString()}. Live state is not replicated continuously. ` +
          'Rooms can be restored when shared snapshots are configured (docs/ha-leader.md).'
        );
      }
      return 'This Core holds the leader lease. Shared room snapshots support recovery on failover (docs/ha-leader.md).';
    }
    if (this.mode === 'standalone') {
      // The leader branch returned above, so standalone here means read-only.
      return 'Standalone mode (no AGIL_REDIS_URL) with AGIL_CLUSTER_ROLE=standby: mutations return 409 not_leader.';
    }
    return (
      `This Core is a standby; mutations return 409 not_leader until it acquires the leader lease` +
      `${this.leaderIdValue ? ` held by ${this.leaderIdValue}` : ''}. Live state is not replicated continuously. ` +
      'Shared room snapshots support recovery on failover (docs/ha-leader.md).'
    );
  }

  /** Synchronous snapshot (no Redis round-trip) for the mutation gate/tests. */
  snapshot(): LeaderSnapshot {
    const now = Date.now();
    const leader = this.roleValue === 'leader';
    return {
      mode: this.mode,
      nodeId: this.nodeId,
      clusterId: this.clusterId,
      role: this.roleValue,
      leaderId: leader ? this.nodeId : this.leaderIdValue,
      leaderSince: leader ? this.leaderSinceValue : this.leaderSinceValue,
      heartbeatAt: this.heartbeatAtValue,
      leaseTtlMs: this.mode === 'redis' ? this.ttlMs : 0,
      leaseTtlRemainingMs: this.mode === 'redis'
        ? leader && this.validUntilValue !== null
          ? Math.max(0, this.validUntilValue - now)
          : this.leaseRemainingMs
        : null,
      validUntil: this.mode === 'redis' ? this.validUntilValue : null,
      registryLockHeld: this.mode === 'standalone' ? leader : this.registryLockHeldValue,
      registryLockTtlRemainingMs:
        this.mode === 'redis' && this.registryValidUntilValue !== null
          ? Math.max(0, this.registryValidUntilValue - now)
          : null,
      redisConnected: this.mode === 'standalone' ? false : this.redisConnectedValue,
      renewalFailures: this.renewalFailuresValue,
      reason: this.reasonValue,
      failover: this.failoverStatus(),
    };
  }

  async describe(): Promise<LeaderSnapshot> {
    if (this.mode === 'redis') {
      if (this.roleValue === 'leader') {
        if (this.leaseValid() && Date.now() - this.lastRenewAt >= this.renewIntervalMs) await this.renew();
      } else if (this.client?.connected) {
        await this.refreshFromRedis();
      }
    }
    return this.snapshot();
  }
}

/** Maps an elector snapshot to the protocol `LeaderLeaseStatus`. */
export function leaseStatusOf(snapshot: LeaderSnapshot): LeaderLeaseStatus {
  return {
    mode: snapshot.mode,
    held: snapshot.role === 'leader',
    ttlMs: snapshot.leaseTtlMs,
    ttlRemainingMs: snapshot.leaseTtlRemainingMs,
    validUntil: snapshot.validUntil,
    heartbeatAt: snapshot.heartbeatAt,
    redisConnected: snapshot.redisConnected,
    renewalFailures: snapshot.renewalFailures,
    reason: snapshot.reason,
  };
}

/** Maps an elector snapshot to the protocol `ClusterLeaderStatus`. */
export function leaderStatusOf(snapshot: LeaderSnapshot): ClusterLeaderStatus {
  return {
    id: snapshot.leaderId,
    since: snapshot.leaderSince,
    heartbeatAt: snapshot.heartbeatAt,
    self: snapshot.role === 'leader',
  };
}
