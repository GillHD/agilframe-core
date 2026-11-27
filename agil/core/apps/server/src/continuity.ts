/**
 * Live-call continuity (docs/call-continuity.md).
 *
 * Rooms live in memory, so a Core restart would otherwise drop every active
 * call. This module persists a bounded control-plane snapshot of each room
 * (tenant, settings, participants + permissions, SFU node pin, timestamps) to a
 * local directory or a Redis-compatible store, restores non-expired rooms on
 * startup and cleans them up by TTL.
 *
 * Media (SRTP/DTLS keys), chat/transcripts/captions, whiteboard strokes, polls,
 * compliance findings, SFU access tokens and E2EE keys are
 * never persisted. A restored participant is offline (`presence: 'reconnecting'`)
 * until it offers the resume token from `welcome.resume`; the signaling layer
 * then swaps it onto the new socket without announcing a leave/join.
 *
 * Storage backends: `FileRoomSnapshotStore` (default; per-tenant directories for
 * tenant isolation, atomic tmp+rename writes) and `RedisRoomSnapshotStore` (key
 * TTL plus per-tenant/global indexes). Both implement the injectable
 * `RoomSnapshotStore`, so tests drive them with an in-memory store.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  FeatureKey,
  MediaMode,
  NodeSummary,
  Participant,
  RoomContext,
  RoomMode,
  TenantConfigPatch,
} from '@agil/protocol';
import type { Env } from './env.js';
import type { Logger } from './logger.js';
import type { RespValue } from './redis-client.js';
import {
  RoomRegistryError,
  type LobbyDecision,
  type LobbyRequest,
  type Room,
  type RoomLifecycleEvent,
  type RoomRegistry,
  type RestoreRoomInput,
} from './rooms.js';

export const ROOM_SNAPSHOT_VERSION = 1;

/** One restored/offline participant with its resume metadata. */
export interface RoomSnapshotMember {
  participant: Participant;
  joinedAt: number;
  resumeCapable: boolean;
  resumeTokenHash?: string;
  resumeExpiresAt?: number;
  /** Previous token hash: one rotation may happen before the client sees it. */
  resumeTokenHashPrev?: string;
  resumeExpiresAtPrev?: number;
}

export interface RoomSnapshotRoom {
  id: string;
  name: string;
  createdAt: number;
  chatHistoryInstanceId?: string;
  lastActivityAt: number;
  locked: boolean;
  maxParticipants: number;
  ttlSec: number;
  durationDeadlineAt?: number;
  passwordHash?: string;
  configOverrides?: TenantConfigPatch;
  mode: RoomMode;
  context?: RoomContext;
  allowedParticipantIds?: string[];
  mediaMode: MediaMode;
  breakoutParentId?: string;
}

export interface RoomSnapshot {
  version: typeof ROOM_SNAPSHOT_VERSION;
  tenantId: string;
  room: RoomSnapshotRoom;
  participants: RoomSnapshotMember[];
  /** Authenticated encryption protects waiting-room cancellation and join capabilities. */
  sealedLobby?: string;
  /** Effective permissions at snapshot time (also present on each participant). */
  permissions: Record<string, FeatureKey[]>;
  /**
   * SFU node pin. `null` for mesh rooms. The room name is the LiveKit room and
   * does not contain secrets; the access token is absent.
   */
  sfu: { nodeId: string; room: string; provider: string; mode: MediaMode } | null;
  draining: boolean;
  /** Epoch ms of this write. */
  savedAt: number;
  /** Epoch ms after which the snapshot must not be restored (0 = never). */
  expiresAt: number;
}

export interface RoomSnapshotStore {
  readonly kind: 'file' | 'redis' | 'memory';
  save(snapshot: RoomSnapshot): Promise<void>;
  get(tenantId: string, roomId: string): Promise<RoomSnapshot | null>;
  list(tenantId?: string, options?: { requirePrimary?: boolean }): Promise<RoomSnapshot[]>;
  delete(tenantId: string, roomId: string): Promise<void>;
  /** Deletes expired snapshots; returns how many were removed. */
  sweep(now?: number): Promise<number>;
  close?(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Key/path safety                                                     */
/* ------------------------------------------------------------------ */

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Tenant/room ids are validated by their own layers; hash anything unexpected. */
function safeSegment(value: string): string {
  if (SEGMENT_RE.test(value)) return value;
  return `h_${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 40)}`;
}

function isSnapshot(value: unknown): value is RoomSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RoomSnapshot>;
  if (candidate.version !== ROOM_SNAPSHOT_VERSION) return false;
  if (typeof candidate.tenantId !== 'string' || !candidate.tenantId) return false;
  const room = candidate.room as Partial<RoomSnapshotRoom> | undefined;
  if (!room || typeof room !== 'object') return false;
  if (typeof room.id !== 'string' || !room.id) return false;
  if (typeof room.createdAt !== 'number') return false;
  if (room.allowedParticipantIds !== undefined && (!Array.isArray(room.allowedParticipantIds) ||
    !room.allowedParticipantIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64))) return false;
  if (!Array.isArray(candidate.participants)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* File store (default)                                                */
/* ------------------------------------------------------------------ */

/**
 * One JSON file per room under `<dir>/<tenant>/<room>.json`.
 *
 * Per-tenant directories make tenant isolation structural: a list/get call is
 * always scoped by tenant and a snapshot's `tenantId` must match its directory.
 * Writes are atomic (tmp file + rename) so a crash never leaves a truncated
 * snapshot that would fail to parse on restart.
 */
export class FileRoomSnapshotStore implements RoomSnapshotStore {
  readonly kind = 'file' as const;
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private tenantDir(tenantId: string): string {
    return path.join(this.dir, safeSegment(tenantId));
  }

  private fileFor(tenantId: string, roomId: string): string {
    return path.join(this.tenantDir(tenantId), `${safeSegment(roomId)}.json`);
  }

  async save(snapshot: RoomSnapshot): Promise<void> {
    mkdirSync(this.tenantDir(snapshot.tenantId), { recursive: true });
    const file = this.fileFor(snapshot.tenantId, snapshot.room.id);
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, 'utf8');
    try {
      renameSync(tmp, file);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best effort */
      }
      throw error;
    }
  }

  async get(tenantId: string, roomId: string): Promise<RoomSnapshot | null> {
    const file = this.fileFor(tenantId, roomId);
    if (!existsSync(file)) return null;
    return this.read(file, tenantId);
  }

  private read(file: string, tenantId?: string): RoomSnapshot | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isSnapshot(parsed)) return null;
      // Structural tenant isolation: a snapshot must live in the directory its
      // own tenantId maps to. A tenant-scoped read additionally requires the
      // caller's tenant; an unscoped listing derives the tenant from the file
      // (hashed dirs for exotic ids would otherwise be rejected).
      const expectedDir = tenantId !== undefined ? tenantId : parsed.tenantId;
      if (parsed.tenantId !== expectedDir) return null;
      if (path.basename(path.dirname(file)) !== safeSegment(expectedDir)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async list(tenantId?: string): Promise<RoomSnapshot[]> {
    const snapshots: RoomSnapshot[] = [];
    const tenantDirs: Array<{ dir: string; tenant: string; scoped: boolean }> = tenantId
      ? [{ dir: safeSegment(tenantId), tenant: tenantId, scoped: true }]
      : this.safeReaddir(this.dir)
          .filter((entry) => !entry.startsWith('.'))
          .map((entry) => ({ dir: entry, tenant: entry, scoped: false }));
    for (const { dir: tenantDir, tenant, scoped } of tenantDirs) {
      const dir = path.join(this.dir, tenantDir);
      for (const file of this.safeReaddir(dir)) {
        if (!file.endsWith('.json')) continue;
        const snapshot = scoped ? this.read(path.join(dir, file), tenant) : this.read(path.join(dir, file));
        if (snapshot) snapshots.push(snapshot);
      }
    }
    return snapshots.sort((a, b) => a.savedAt - b.savedAt);
  }

  private safeReaddir(dir: string): string[] {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  }

  async delete(tenantId: string, roomId: string): Promise<void> {
    try {
      unlinkSync(this.fileFor(tenantId, roomId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async sweep(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const snapshot of await this.list()) {
      if (snapshot.expiresAt > 0 && snapshot.expiresAt <= now) {
        await this.delete(snapshot.tenantId, snapshot.room.id);
        removed += 1;
      }
    }
    return removed;
  }
}

/* ------------------------------------------------------------------ */
/* Redis-compatible store                                              */
/* ------------------------------------------------------------------ */

/** The tiny subset of the Core Redis client the store needs. */
export interface RoomSnapshotRedis {
  command(args: Array<string | number>): Promise<RespValue>;
}

type SnapshotFence = (script: string, keys: string[], args: Array<string | number>) => Promise<void>;

const FENCED_SNAPSHOT_SAVE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[3] == '0' then redis.call('SET', KEYS[2], ARGV[2])
else redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3]) end
redis.call('SADD', KEYS[3], ARGV[4])
redis.call('SADD', KEYS[4], ARGV[5])
return 1`;

const FENCED_SNAPSHOT_DELETE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[4] == 'prune' then
  if redis.call('EXISTS', KEYS[2]) == 1 then return 1 end
else redis.call('DEL', KEYS[2]) end
redis.call('SREM', KEYS[3], ARGV[2])
if redis.call('SCARD', KEYS[3]) == 0 then redis.call('SREM', KEYS[4], ARGV[3]) end
return 1`;

/**
 * Redis-compatible store: `agil:room:<tenant>:<room>` JSON values with a key
 * TTL, plus per-tenant and global indexes for `list()`. Speaks the RESP command
 * subset implemented in `redis-client.ts` (Redis, Valkey, KeyDB, Dragonfly).
 *
 * A file store can be supplied as a write-through mirror: if Redis is down the
 * snapshot still survives on local disk (the mirror is consulted on read).
 */
export class RedisRoomSnapshotStore implements RoomSnapshotStore {
  readonly kind = 'redis' as const;
  private readonly redis: RoomSnapshotRedis;
  private readonly prefix: string;
  private readonly mirror?: RoomSnapshotStore;
  private readonly fence?: SnapshotFence;

  constructor(options: { redis: RoomSnapshotRedis; prefix?: string; mirror?: RoomSnapshotStore; fence?: SnapshotFence }) {
    this.redis = options.redis;
    this.prefix = options.prefix ?? 'agil';
    this.mirror = options.mirror;
    this.fence = options.fence;
  }

  private key(tenantId: string, roomId: string): string {
    return `${this.prefix}:room:${safeSegment(tenantId)}:${safeSegment(roomId)}`;
  }

  private tenantIndex(tenantId: string): string {
    return `${this.prefix}:room:index:${safeSegment(tenantId)}`;
  }

  private tenantsIndex(): string {
    return `${this.prefix}:room:tenants`;
  }

  async save(snapshot: RoomSnapshot): Promise<void> {
    const key = this.key(snapshot.tenantId, snapshot.room.id);
    const payload = JSON.stringify(snapshot);
    const ttlMs = snapshot.expiresAt > 0 ? Math.max(1, snapshot.expiresAt - Date.now()) : 0;
    if (this.fence) {
      await this.fence(FENCED_SNAPSHOT_SAVE, [key, this.tenantIndex(snapshot.tenantId), this.tenantsIndex()],
        [payload, ttlMs, snapshot.room.id, snapshot.tenantId]);
      await this.mirror?.save(snapshot).catch(() => undefined);
      return;
    }
    try {
      if (ttlMs > 0) await this.redis.command(['SET', key, payload, 'PX', String(ttlMs)]);
      else await this.redis.command(['SET', key, payload]);
      await this.redis.command(['SADD', this.tenantIndex(snapshot.tenantId), snapshot.room.id]);
      await this.redis.command(['SADD', this.tenantsIndex(), snapshot.tenantId]);
    } catch (error) {
      // A dead Redis must never break a live call: write the mirror, then bail.
      if (this.mirror) await this.mirror.save(snapshot);
      throw error;
    }
    if (this.mirror) await this.mirror.save(snapshot);
  }

  private async readSnapshot(tenantId: string, roomId: string): Promise<RoomSnapshot | null> {
    const raw = await this.redis.command(['GET', this.key(tenantId, roomId)]);
    if (typeof raw !== 'string' || !raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isSnapshot(parsed) && parsed.tenantId === tenantId && parsed.room.id === roomId ? parsed : null;
    } catch {
      return null;
    }
  }

  async get(tenantId: string, roomId: string): Promise<RoomSnapshot | null> {
    try {
      return await this.readSnapshot(tenantId, roomId);
    } catch {
      return this.mirror ? this.mirror.get(tenantId, roomId) : null;
    }
  }

  private async members(key: string): Promise<string[]> {
    const raw = await this.redis.command(['SMEMBERS', key]);
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
  }

  async list(tenantId?: string, options?: { requirePrimary?: boolean }): Promise<RoomSnapshot[]> {
    try {
      const tenants = tenantId ? [tenantId] : await this.members(this.tenantsIndex());
      const snapshots: RoomSnapshot[] = [];
      for (const tenant of tenants) {
        let live = 0;
        for (const roomId of await this.members(this.tenantIndex(tenant))) {
          const snapshot = await this.readSnapshot(tenant, roomId);
          if (snapshot) {
            snapshots.push(snapshot);
            live += 1;
          } else if (this.fence) {
            await this.fence(FENCED_SNAPSHOT_DELETE, [this.key(tenant, roomId), this.tenantIndex(tenant), this.tenantsIndex()],
              [roomId, tenant, 'prune']);
          } else {
            await this.redis.command(['SREM', this.tenantIndex(tenant), roomId]);
          }
        }
        if (live === 0 && !tenantId && !this.fence) await this.redis.command(['SREM', this.tenantsIndex(), tenant]);
      }
      // A missing key in a reachable Redis may have been deleted by another Core.
      // Never merge a stale local mirror into an authoritative Redis listing.
      return snapshots.sort((a, b) => a.savedAt - b.savedAt);
    } catch (error) {
      if (this.mirror && !options?.requirePrimary) return this.mirror.list(tenantId);
      throw error;
    }
  }

  async delete(tenantId: string, roomId: string): Promise<void> {
    if (this.fence) {
      await this.fence(FENCED_SNAPSHOT_DELETE, [this.key(tenantId, roomId), this.tenantIndex(tenantId), this.tenantsIndex()],
        [roomId, tenantId]);
      await this.mirror?.delete(tenantId, roomId).catch(() => undefined);
      return;
    }
    try {
      await this.redis.command(['DEL', this.key(tenantId, roomId)]);
      await this.redis.command(['SREM', this.tenantIndex(tenantId), roomId]);
      if ((await this.members(this.tenantIndex(tenantId))).length === 0) {
        await this.redis.command(['SREM', this.tenantsIndex(), tenantId]);
      }
    } catch {
      /* best effort: the key TTL still removes it */
    }
    if (this.mirror) await this.mirror.delete(tenantId, roomId);
  }

  async sweep(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const snapshot of await this.list()) {
      if (snapshot.expiresAt > 0 && snapshot.expiresAt <= now) {
        await this.delete(snapshot.tenantId, snapshot.room.id);
        removed += 1;
      }
    }
    return removed;
  }
}

/* ------------------------------------------------------------------ */
/* In-memory store (tests / disabled persistence)                      */
/* ------------------------------------------------------------------ */

export class MemoryRoomSnapshotStore implements RoomSnapshotStore {
  readonly kind = 'memory' as const;
  private readonly snapshots = new Map<string, RoomSnapshot>();

  constructor(initial: RoomSnapshot[] = []) {
    for (const snapshot of initial) this.put(snapshot);
  }

  private put(snapshot: RoomSnapshot): void {
    this.snapshots.set(`${snapshot.tenantId}\u0000${snapshot.room.id}`, snapshot);
  }

  async save(snapshot: RoomSnapshot): Promise<void> {
    this.put(JSON.parse(JSON.stringify(snapshot)) as RoomSnapshot);
  }

  async get(tenantId: string, roomId: string): Promise<RoomSnapshot | null> {
    return this.snapshots.get(`${tenantId}\u0000${roomId}`) ?? null;
  }

  async list(tenantId?: string): Promise<RoomSnapshot[]> {
    return [...this.snapshots.values()]
      .filter((snapshot) => !tenantId || snapshot.tenantId === tenantId)
      .sort((a, b) => a.savedAt - b.savedAt);
  }

  async delete(tenantId: string, roomId: string): Promise<void> {
    this.snapshots.delete(`${tenantId}\u0000${roomId}`);
  }

  async sweep(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const [key, snapshot] of [...this.snapshots]) {
      if (snapshot.expiresAt > 0 && snapshot.expiresAt <= now) {
        this.snapshots.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.snapshots.size;
  }
}

/* ------------------------------------------------------------------ */
/* Resume tokens                                                       */
/* ------------------------------------------------------------------ */

export const RESUME_TOKEN_PREFIX = 'r1';
export const RESUME_TOKEN_MAX_LENGTH = 2048;

export interface ResumeTokenClaims {
  v: 1;
  tenantId: string;
  roomId: string;
  participantId: string;
  /** Epoch ms. */
  exp: number;
  /** Random nonce so tokens are not deterministic. */
  nonce: string;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('base64url');
}

/** Signs a short-lived resume capability (HMAC-SHA256, `r1.<payload>.<sig>`). */
export function issueResumeToken(secret: string, claims: ResumeTokenClaims): string {
  const payload = base64url(JSON.stringify(claims));
  return `${RESUME_TOKEN_PREFIX}.${payload}.${hmac(secret, `${RESUME_TOKEN_PREFIX}.${payload}`)}`;
}

/** Verifies signature, shape and expiry; never throws. */
export function verifyResumeToken(secret: string, raw: string | undefined, now = Date.now()): ResumeTokenClaims | null {
  if (!secret || typeof raw !== 'string' || raw.length === 0 || raw.length > RESUME_TOKEN_MAX_LENGTH) return null;
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== RESUME_TOKEN_PREFIX) return null;
  const [, payload = '', signature = ''] = parts;
  const expected = hmac(secret, `${RESUME_TOKEN_PREFIX}.${payload}`);
  const actual = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return null;
  let claims: ResumeTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ResumeTokenClaims;
  } catch {
    return null;
  }
  if (!claims || claims.v !== 1) return null;
  if (typeof claims.tenantId !== 'string' || typeof claims.roomId !== 'string') return null;
  if (typeof claims.participantId !== 'string' || typeof claims.exp !== 'number') return null;
  if (claims.exp <= now) return null;
  return claims;
}

/** sha256 of the token; only the hash is stored in rooms and snapshots. */
export function hashResumeToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ */
/* Continuity service                                                  */
/* ------------------------------------------------------------------ */

type PlacementNode = Pick<NodeSummary, 'id' | 'role' | 'features' | 'status' | 'drain' | 'enabled' | 'lastSeenAt' | 'sfuReady' | 'capacity'>;

export interface RoomContinuityOptions {
  env: Env;
  rooms: RoomRegistry;
  logger: Logger;
  /** Tenant registry: rejects snapshots of removed tenants on restore. */
  tenants?: { listTenants(): string[] };
  /** Cluster node registry: pins a room to a healthy SFU node. */
  cluster?: {
    listNodes(tenantId: string): PlacementNode[];
    identity(): { id: string };
  };
  /** Restore only on the leader; standbys wait for promotion. */
  isLeader?: () => boolean;
  store?: RoomSnapshotStore;
  now?: () => number;
  /** Write-through Redis client (only used when AGIL_ROOM_SNAPSHOT_STORE=redis). */
  redis?: RoomSnapshotRedis;
  snapshotFence?: SnapshotFence;
}

export interface RestoreResult {
  restored: number;
  skipped: number;
  /** Tenants for which at least one room was restored. */
  tenants: string[];
  /** True when this Core is a standby and restored nothing. */
  deferred: boolean;
}

export interface NodeDrainResult {
  tenantId: string;
  nodeId: string;
  draining: boolean;
  affected: number;
}

const DEBOUNCE_MS = 200;
/** Rooms closed for these reasons keep their snapshot for the next leader/boot. */
const RETAIN_ON_CLOSE = new Set(['server_shutdown', 'leadership_lost']);
const SWEEP_INTERVAL_MS = 30_000;

export class RoomContinuity {
  private readonly env: Env;
  private readonly rooms: RoomRegistry;
  private readonly logger: Logger;
  private readonly tenants?: RoomContinuityOptions['tenants'];
  private readonly cluster?: RoomContinuityOptions['cluster'];
  private readonly isLeader: () => boolean;
  private readonly store: RoomSnapshotStore;
  private readonly now: () => number;
  private readonly resumeSecret: string;
  private readonly lobbyKey: Buffer;
  private readonly dirty = new Set<string>();
  private readonly snapshotWrites = new Map<string, Promise<void>>();
  /**
   * Rooms closed for a retained reason (`server_shutdown`/`leadership_lost`).
   * A flush that is already in flight when the registry drops them must still
   * keep their snapshot for the next boot/leader.
   */
  private readonly retainedRooms = new Set<string>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private restorePromise: Promise<RestoreResult> | null = null;
  private restoreGeneration = 0;
  private restoredRooms = 0;
  private restoredTenants: string[] = [];
  private lastRestoreAt = 0;
  private closed = false;

  constructor(options: RoomContinuityOptions) {
    this.env = options.env;
    this.rooms = options.rooms;
    this.logger = options.logger;
    this.tenants = options.tenants;
    this.cluster = options.cluster;
    this.isLeader = options.isLeader ?? (() => true);
    this.now = options.now ?? Date.now;
    this.resumeSecret = options.env.tokenSecret;
    this.lobbyKey = createHmac('sha256', this.resumeSecret).update('agil:continuity:lobby:v1').digest();
    this.store = options.store ?? buildRoomSnapshotStore(options.env, options.logger, options.redis, options.snapshotFence);
    this.unsubscribe = this.rooms.subscribe((event) => this.onRoomEvent(event));
  }

  /* --------------------------- lifecycle --------------------------- */

  get enabled(): boolean {
    return this.env.continuityEnabled;
  }

  get storeKind(): RoomSnapshotStore['kind'] {
    return this.store.kind;
  }

  get resumeGraceSec(): number {
    return this.enabled ? this.env.resumeGraceSec : 0;
  }

  /** Starts the periodic flush + snapshot TTL sweeper (idempotent). */
  start(): void {
    if (!this.enabled || this.closed) return;
    if (this.env.roomSnapshotFlushMs > 0 && !this.flushTimer) {
      this.flushTimer = setInterval(() => {
        // Refresh *every* live room, not only the dirty set: a long, quiet call
        // must not let its snapshot (and Redis key TTL) expire mid-call.
        void this.flushAll();
      }, this.env.roomSnapshotFlushMs);
      this.flushTimer.unref?.();
    }
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => {
        void this.sweep();
      }, SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
    }
  }

  /** Stops timers and persists everything one last time. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const timer of [this.debounceTimer, this.flushTimer, this.sweepTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.debounceTimer = null;
    this.flushTimer = null;
    this.sweepTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.enabled) await this.flushAll();
    await this.store.close?.();
  }

  /** Diagnostics for `/v1/health`-style readiness checks and tests. */
  stats(): {
    enabled: boolean;
    store: RoomSnapshotStore['kind'];
    resumeGraceSec: number;
    restoredRooms: number;
    restoredTenants: string[];
    lastRestoreAt: number;
    pendingSaves: number;
  } {
    return {
      enabled: this.enabled,
      store: this.store.kind,
      resumeGraceSec: this.resumeGraceSec,
      restoredRooms: this.restoredRooms,
      restoredTenants: [...this.restoredTenants],
      lastRestoreAt: this.lastRestoreAt,
      pendingSaves: this.dirty.size,
    };
  }

  /* ----------------------------- restore ----------------------------- */

  /**
   * Rebuilds non-expired rooms from the store.
   *
   * Runs on the leader only (or standalone): in Redis HA mode a standby must
   * not resurrect rooms before it owns the lease. Idempotent — rooms that
   * already exist are skipped, so a retry after a partial failure is safe.
   */
  async restore(): Promise<RestoreResult> {
    if (!this.enabled) return { restored: 0, skipped: 0, tenants: [], deferred: false };
    if (this.closed) return { restored: 0, skipped: 0, tenants: [], deferred: false };
    if (!this.isLeader()) {
      return { restored: 0, skipped: 0, tenants: [], deferred: true };
    }
    if (this.restorePromise) return this.restorePromise;
    const restoration = this.performRestore(this.restoreGeneration).finally(() => {
      if (this.restorePromise === restoration) this.restorePromise = null;
    });
    this.restorePromise = restoration;
    return restoration;
  }

  invalidateRestore(): void {
    this.restoreGeneration += 1;
    this.restorePromise = null;
  }

  private async performRestore(generation: number): Promise<RestoreResult> {
    const known = new Set(this.tenants?.listTenants() ?? []);
    const now = this.now();
    let restored = 0;
    let skipped = 0;
    const tenants = new Set<string>();
    let snapshots: RoomSnapshot[] = [];
    try {
      snapshots = await this.store.list(undefined, { requirePrimary: this.store.kind === 'redis' });
    } catch (error) {
      this.logger.warn('room snapshot listing failed', {
        error: error instanceof Error ? error.message : String(error),
        store: this.store.kind,
      });
      throw error;
    }
    for (const snapshot of snapshots) {
      if (generation !== this.restoreGeneration || this.closed || !this.isLeader()) break;
      if (!isSnapshot(snapshot)) {
        skipped += 1;
        continue;
      }
      if (snapshot.expiresAt > 0 && snapshot.expiresAt <= now) {
        skipped += 1;
        await this.store.delete(snapshot.tenantId, snapshot.room.id).catch(() => undefined);
        continue;
      }
      // Tenant isolation: never resurrect a room for a tenant this Core does
      // not know about (deleted tenant / snapshot copied from another cluster).
      if (known.size > 0 && !known.has(snapshot.tenantId)) {
        skipped += 1;
        continue;
      }
      if (this.rooms.has(snapshot.room.id)) {
        skipped += 1;
        continue;
      }
      try {
        const input = this.restoreInput(snapshot);
        const lastActivityAt = input.lastActivityAt ?? snapshot.room.createdAt;
        const idleSince = Number.isFinite(lastActivityAt) ? Math.max(snapshot.room.createdAt, lastActivityAt) : snapshot.room.createdAt;
        const idleTtlMs = (input.ttlSec ?? 0) * 1000;
        const expiredByDuration = input.durationDeadlineAt !== undefined && input.durationDeadlineAt <= this.now();
        if (expiredByDuration) {
          const expired = this.rooms.restore(input);
          this.rooms.close(expired.id, 'duration_expired');
          skipped += 1;
          await this.store.delete(snapshot.tenantId, snapshot.room.id).catch(() => undefined);
          continue;
        }
        if (!input.participants?.length && idleTtlMs > 0 && idleSince + idleTtlMs <= this.now()) {
          skipped += 1;
          await this.store.delete(snapshot.tenantId, snapshot.room.id).catch(() => undefined);
          continue;
        }
        const room = this.rooms.restore(input);
        room.locked = Boolean(snapshot.room.locked);
        this.restoreLobby(room, snapshot.sealedLobby);
        this.dirty.delete(room.id);
        restored += 1;
        tenants.add(snapshot.tenantId);
        this.logger.info('room restored from snapshot', {
          roomId: room.id,
          tenantId: room.tenantId,
          participants: room.participantCount,
          sfuNodeId: room.sfuNodeId,
        });
      } catch (error) {
        if (error instanceof RoomRegistryError) skipped += 1;
        else {
          skipped += 1;
          this.logger.warn('room snapshot could not be restored', {
            roomId: snapshot.room.id,
            tenantId: snapshot.tenantId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    this.restoredRooms += restored;
    this.restoredTenants = [...new Set([...this.restoredTenants, ...tenants])];
    this.lastRestoreAt = this.now();
    return { restored, skipped, tenants: [...tenants], deferred: false };
  }

  private restoreInput(snapshot: RoomSnapshot): RestoreRoomInput {
    const room = snapshot.room;
    const participants = (snapshot.participants ?? [])
      .filter((member) => member && typeof member === 'object' && member.participant?.id)
      .map((member) => ({
        participant: {
          ...member.participant,
          // Permissions are re-resolved on resume; keep the snapshot value so
          // the admin list is truthful while the participant is offline.
          permissions: member.participant.permissions ?? snapshot.permissions?.[member.participant.id] ?? [],
        } as Participant,
        joinedAt: member.joinedAt,
        ...(member.resumeCapable ? { resumeCapable: true } : {}),
        ...(member.resumeTokenHash ? { resumeTokenHash: member.resumeTokenHash } : {}),
        ...(member.resumeExpiresAt ? { resumeExpiresAt: member.resumeExpiresAt } : {}),
        ...(member.resumeTokenHashPrev ? { resumeTokenHashPrev: member.resumeTokenHashPrev } : {}),
        ...(member.resumeExpiresAtPrev ? { resumeExpiresAtPrev: member.resumeExpiresAtPrev } : {}),
      }));
    return {
      id: room.id,
      tenantId: snapshot.tenantId,
      name: room.name,
      maxParticipants: room.maxParticipants,
      ttlSec: room.ttlSec,
      ...(typeof room.durationDeadlineAt === 'number' && Number.isFinite(room.durationDeadlineAt)
        ? { durationDeadlineAt: room.durationDeadlineAt }
        : {}),
      createdAt: room.createdAt,
      ...(typeof room.chatHistoryInstanceId === 'string' && room.chatHistoryInstanceId
        ? { chatHistoryInstanceId: room.chatHistoryInstanceId } : {}),
      lastActivityAt: room.lastActivityAt,
      mode: room.mode === 'direct' ? 'direct' : 'group',
      mediaMode: room.mediaMode === 'sfu' || room.mediaMode === 'broadcast' ? room.mediaMode : 'mesh',
      ...(room.passwordHash ? { passwordHash: room.passwordHash } : {}),
      ...(room.configOverrides ? { configOverrides: room.configOverrides } : {}),
      ...(room.context ? { context: room.context } : {}),
      ...(room.allowedParticipantIds ? { allowedParticipantIds: room.allowedParticipantIds } : {}),
      ...(room.breakoutParentId ? { breakoutParentId: room.breakoutParentId } : {}),
      ...(snapshot.sfu?.nodeId ? { sfuNodeId: snapshot.sfu.nodeId } : {}),
      draining: Boolean(snapshot.draining),
      participants,
    };
  }

  /* ----------------------------- snapshots ----------------------------- */

  private sealLobby(room: Room): string | undefined {
    const requests = room.lobbyList();
    const decisions = [...room.lobbyDecisions];
    if (requests.length === 0 && decisions.length === 0) return undefined;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.lobbyKey, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([room.tenantId, room.id])));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ requests, decisions })), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }

  private restoreLobby(room: Room, sealed?: string): void {
    if (!sealed) return;
    try {
      const payload = Buffer.from(sealed, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.lobbyKey, payload.subarray(0, 12));
      decipher.setAAD(Buffer.from(JSON.stringify([room.tenantId, room.id])));
      decipher.setAuthTag(payload.subarray(12, 28));
      const plaintext = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
      const state = JSON.parse(plaintext.toString('utf8')) as {
        requests: LobbyRequest[];
        decisions: Array<[string, LobbyDecision]>;
      };
      for (const request of state.requests) room.lobby.set(request.id, request);
      for (const [id, decision] of state.decisions) room.lobbyDecisions.set(id, decision);
      // Last-known expiry is preserved, including requests that elapsed during downtime.
      room.lobbyList();
    } catch {
      this.logger.warn('room lobby snapshot could not be opened', { tenantId: room.tenantId, roomId: room.id });
    }
  }

  private queueSnapshotWrite(tenantId: string, roomId: string, operation: () => Promise<void>): Promise<void> {
    const id = JSON.stringify([tenantId, roomId]);
    const previous = this.snapshotWrites.get(id);
    const write = (previous ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.snapshotWrites.set(id, write);
    return write.finally(() => {
      if (this.snapshotWrites.get(id) === write) this.snapshotWrites.delete(id);
    });
  }

  private writeSnapshot(snapshot: RoomSnapshot): Promise<void> {
    return this.queueSnapshotWrite(snapshot.tenantId, snapshot.room.id, () => this.store.save(snapshot));
  }

  private onRoomEvent(event: RoomLifecycleEvent): void {
    if (!this.enabled) return;
    if (event.type === 'created') {
      this.retainedRooms.delete(event.room.id);
      if (!event.room.sfuNodeId) event.room.sfuNodeId = this.allocateNode(event.room);
      this.schedule(event.room.id);
      return;
    }
    if (event.type === 'joined' || event.type === 'left' || event.type === 'resumed') {
      this.schedule(event.room.id);
      return;
    }
    if (event.type === 'closed') {
      this.dirty.delete(event.room.id);
      if (RETAIN_ON_CLOSE.has(event.reason)) {
        // Shutdown/demote keeps the snapshot for the next boot/leader. A flush
        // already writing this room must not treat the dropped registry entry as
        // a deletion (see `flushAll`).
        this.retainedRooms.add(event.room.id);
        return;
      }
      this.retainedRooms.delete(event.room.id);
      void this.queueSnapshotWrite(event.room.tenantId, event.room.id,
        () => this.store.delete(event.room.tenantId, event.room.id)).catch((error: unknown) => {
        this.logger.warn('room snapshot delete failed', {
          roomId: event.room.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    // `restored` needs no write: the snapshot it came from is already valid.
    if (event.type === 'restored') this.retainedRooms.delete(event.room.id);
  }

  private schedule(roomId: string): void {
    this.dirty.add(roomId);
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flushDirty();
    }, DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  /** Snapshots every live room (startup/shutdown/demote). */
  async flushAll(): Promise<number> {
    if (!this.enabled) return 0;
    const pending: Array<{ room: Room; snapshot: RoomSnapshot }> = [];
    for (const room of this.rooms.list()) {
      const snapshot = this.snapshotRoom(room);
      if (snapshot) pending.push({ room, snapshot });
    }
    this.dirty.clear();
    let saved = 0;
    await Promise.all(pending.map(async ({ room, snapshot }) => {
      try {
        await this.writeSnapshot(snapshot);
      } catch (error) {
        this.logger.warn('room snapshot save failed', {
          roomId: snapshot.room.id,
          tenantId: snapshot.tenantId,
          error: error instanceof Error ? error.message : String(error),
          store: this.store.kind,
        });
        return;
      }
      // A regular close queues its delete after any in-flight save. A retained
      // close (shutdown/demote) intentionally keeps the saved snapshot.
      if (this.rooms.get(snapshot.room.id) !== room && !this.retainedRooms.has(snapshot.room.id)) {
        return;
      }
      saved += 1;
    }));
    return saved;
  }

  /** Flushes only rooms touched since the last write. */
  async flushDirty(): Promise<number> {
    if (!this.enabled || this.dirty.size === 0) return 0;
    const ids = [...this.dirty];
    this.dirty.clear();
    let saved = 0;
    await Promise.all(ids.map(async (id) => {
      const room = this.rooms.get(id);
      if (!room) return;
      const snapshot = this.snapshotRoom(room);
      if (!snapshot) return;
      try {
        await this.writeSnapshot(snapshot);
      } catch (error) {
        this.logger.warn('room snapshot save failed', {
          roomId: id,
          error: error instanceof Error ? error.message : String(error),
          store: this.store.kind,
        });
        return;
      }
      if (this.rooms.get(id) !== room && !this.retainedRooms.has(id)) {
        return;
      }
      saved += 1;
    }));
    return saved;
  }

  /** Persists one room immediately (used by tests and drain handling). */
  async saveRoom(room: Room): Promise<RoomSnapshot | null> {
    if (!this.enabled || this.rooms.get(room.id) !== room) return null;
    const snapshot = this.snapshotRoom(room);
    if (!snapshot) return null;
    this.dirty.delete(room.id);
    await this.writeSnapshot(snapshot);
    if (this.rooms.get(snapshot.room.id) !== room && !this.retainedRooms.has(snapshot.room.id)) {
      return null;
    }
    return snapshot;
  }

  snapshotRoom(room: Room): RoomSnapshot | null {
    if (room.voiceChannel) return null;
    const members: RoomSnapshotMember[] = [];
    const permissions: Record<string, FeatureKey[]> = {};
    for (const participant of room.participants()) {
      const member = room.member(participant.id);
      if (!member) continue;
      const connection = member.connection;
      if (participant.permissions && participant.permissions.length > 0) {
        permissions[participant.id] = [...participant.permissions] as FeatureKey[];
      }
      members.push({
        participant: { ...participant },
        joinedAt: connection.joinedAt || participant.joinedAt,
        resumeCapable: Boolean(connection.resumeCapable),
        ...(connection.resumeTokenHash ? { resumeTokenHash: connection.resumeTokenHash } : {}),
        ...(connection.resumeExpiresAt ? { resumeExpiresAt: connection.resumeExpiresAt } : {}),
        ...(connection.resumeTokenHashPrev ? { resumeTokenHashPrev: connection.resumeTokenHashPrev } : {}),
        ...(connection.resumeExpiresAtPrev ? { resumeExpiresAtPrev: connection.resumeExpiresAtPrev } : {}),
      });
    }
    const ttlSec = room.ttlSec > 0 ? room.ttlSec : 0;
    // A room TTL only says when an *empty* room dies; the snapshot must live at
    // least as long as the orphan retention so a live long call never loses it.
    const retentionSec = Math.max(ttlSec, this.env.roomSnapshotMaxAgeSec);
    const savedAt = this.now();
    const sealedLobby = this.sealLobby(room);
    return {
      version: ROOM_SNAPSHOT_VERSION,
      tenantId: room.tenantId,
      room: {
        id: room.id,
        name: room.name,
        createdAt: room.createdAt,
        chatHistoryInstanceId: room.chatHistoryInstanceId,
        lastActivityAt: room.lastActivityAt,
        locked: room.locked,
        maxParticipants: room.maxParticipants,
        ttlSec: room.ttlSec,
        ...(room.durationDeadlineAt === undefined ? {} : { durationDeadlineAt: room.durationDeadlineAt }),
        ...(room.passwordHash ? { passwordHash: room.passwordHash } : {}),
        ...(room.configOverrides ? { configOverrides: room.configOverrides } : {}),
        mode: room.mode,
        ...(room.context ? { context: room.context } : {}),
        ...(room.allowedParticipantIds ? { allowedParticipantIds: [...room.allowedParticipantIds] } : {}),
        mediaMode: room.mediaMode,
        ...(room.breakoutParentId ? { breakoutParentId: room.breakoutParentId } : {}),
      },
      participants: members,
      ...(sealedLobby ? { sealedLobby } : {}),
      permissions,
      sfu: room.sfuNodeId
        ? {
            nodeId: room.sfuNodeId,
            room: sfuRoomNameFor(room.tenantId, room.id),
            provider: this.env.sfuUrl ? 'livekit' : 'external',
            mode: room.mediaMode,
          }
        : null,
      draining: room.draining,
      savedAt,
      expiresAt: savedAt + Math.max(1, retentionSec) * 1000,
    };
  }

  /** Deletes expired orphan snapshots (Redis also expires keys by TTL). */
  async sweep(now = this.now()): Promise<number> {
    if (!this.enabled || !this.isLeader()) return 0;
    let removed = 0;
    try {
      // A live room is never swept, even if its file says otherwise: the room
      // registry is the source of truth while the process is running.
      for (const snapshot of await this.store.list()) {
        if (this.closed || !this.isLeader()) break;
        if (!(snapshot.expiresAt > 0) || snapshot.expiresAt > now) continue;
        if (this.rooms.has(snapshot.room.id)) continue;
        await this.store.delete(snapshot.tenantId, snapshot.room.id);
        this.retainedRooms.delete(snapshot.room.id);
        removed += 1;
      }
      return removed;
    } catch (error) {
      this.logger.warn('room snapshot sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return removed;
    }
  }

  /* --------------------------- SFU node pin --------------------------- */

  /**
   * Resolves the SFU node for a new room: an unmanaged pin or an eligible
   * mapped pin, then the least loaded eligible SFU with spare room capacity,
   * then the deployment fallback. Mesh rooms are not pinned.
   */
  allocateNode(room: Pick<Room, 'tenantId' | 'mediaMode'>): string | undefined {
    if (room.mediaMode === 'mesh') return undefined;
    const preferred = this.env.sfuNodeId;
    const endpoints = this.env.sfuNodeUrls.get(room.tenantId);
    if (preferred && !endpoints?.has(preferred)) return preferred;
    if (this.cluster) {
      let candidates: PlacementNode[] = [];
      try {
        candidates = this.cluster.listNodes(room.tenantId).filter(
          (node) => node.enabled && node.status === 'online' && !node.drain && node.lastSeenAt !== null && node.sfuReady !== false &&
            (!endpoints || (endpoints.has(node.id) && node.sfuReady === true)) &&
            (node.role === 'sfu' || (node.role === 'all' && (
              node.features.includes('sfu') || !node.features.some((feature) => feature === 'turn' || feature === 'stun')
            ))),
        );
      } catch {
        candidates = [];
      }
      if (candidates.length > 0) {
        const assignedRooms = new Map<string, number>();
        for (const existing of this.rooms.list(room.tenantId)) {
          if (existing.sfuNodeId) assignedRooms.set(existing.sfuNodeId, (assignedRooms.get(existing.sfuNodeId) ?? 0) + 1);
        }
        const load = (id: string): number => assignedRooms.get(id) ?? 0;
        const available = candidates.filter(({ id, capacity }) => capacity.maxRooms === 0 || load(id) < capacity.maxRooms);
        if (preferred && available.some(({ id }) => id === preferred)) return preferred;
        available.sort((a, b) => load(a.id) - load(b.id) || a.id.localeCompare(b.id));
        if (available[0]) return available[0].id;
      }
    }
    if (endpoints) return undefined; // buildSfuMedia uses the configured shared endpoint.
    const fallback = this.env.clusterNodeId || this.cluster?.identity().id;
    if (fallback) return fallback;
    return this.env.sfuUrl ? 'core-default' : undefined;
  }

  /**
   * Marks every room pinned to a draining node (tenant-scoped) and persists the
   * snapshot. Rooms stay joinable — only new allocations avoid the node.
   */
  async markNodeDraining(tenantId: string, nodeId: string, draining: boolean): Promise<NodeDrainResult> {
    let affected = 0;
    if (!this.enabled) return { tenantId, nodeId, draining, affected };
    for (const room of this.rooms.list(tenantId)) {
      if (room.sfuNodeId !== nodeId) continue;
      room.draining = draining;
      this.schedule(room.id);
      affected += 1;
    }
    if (affected > 0) await this.flushDirty();
    this.logger.info('room drain marker updated', { tenantId, nodeId, draining, rooms: affected });
    return { tenantId, nodeId, draining, affected };
  }

  /** Rooms pinned to a node (tenant-scoped; tests/diagnostics). */
  roomsOnNode(tenantId: string, nodeId: string): Room[] {
    return this.rooms.list(tenantId).filter((room) => room.sfuNodeId === nodeId);
  }

  /* --------------------------- resume tokens --------------------------- */

  /** Mints a resume token and stores only its hash on the connection. */
  issueResume(
    room: Room,
    participantId: string,
    connection?: {
      resumeTokenHash?: string;
      resumeExpiresAt?: number;
      resumeTokenHashPrev?: string;
      resumeExpiresAtPrev?: number;
      resumeCapable?: boolean;
    },
  ): { token: string; expiresAt: number; graceSec: number } | undefined {
    // With the module disabled there is no grace lease and `verifyResume`
    // always fails: advertising a token would only mislead the client.
    if (!this.enabled) return undefined;
    const expiresAt = this.now() + this.env.resumeTokenTtlSec * 1000;
    const token = issueResumeToken(this.resumeSecret, {
      v: 1,
      tenantId: room.tenantId,
      roomId: room.id,
      participantId,
      exp: expiresAt,
      nonce: randomBytes(12).toString('base64url'),
    });
    const hash = hashResumeToken(token);
    if (connection) {
      // Keep one previous hash: a reconnect rotates the token, and if the new
      // `welcome` never reaches the client the old token must still work.
      if (connection.resumeTokenHash && connection.resumeTokenHash !== hash) {
        connection.resumeTokenHashPrev = connection.resumeTokenHash;
        connection.resumeExpiresAtPrev = connection.resumeExpiresAt;
      }
      connection.resumeTokenHash = hash;
      connection.resumeExpiresAt = expiresAt;
      connection.resumeCapable = true;
    }
    return { token, expiresAt, graceSec: this.resumeGraceSec };
  }

  /**
   * Validates a presented resume token against the room member's stored hash.
   * Binds tenant + room + participant, so a token from another tenant/room can
   * never resume anyone (tenant isolation).
   */
  verifyResume(room: Room, participantId: string, raw: string | undefined): boolean {
    if (!this.enabled || !rareValid(raw)) return false;
    const claims = verifyResumeToken(this.resumeSecret, raw, this.now());
    if (!claims) return false;
    if (claims.tenantId !== room.tenantId || claims.roomId !== room.id || claims.participantId !== participantId) {
      return false;
    }
    const member = room.member(participantId);
    if (!member) return false;
    const presented = hashResumeToken(raw);
    const current = member.connection.resumeTokenHash;
    const previous = member.connection.resumeTokenHashPrev;
    const previousExpiry = member.connection.resumeExpiresAtPrev ?? 0;
    return (
      (current ? safeEqualHex(presented, current) : false) ||
      (previous && previousExpiry > this.now() ? safeEqualHex(presented, previous) : false)
    );
  }

  /** True when this participant may be held in the room after a socket drop. */
  canHoldResume(room: Room, participantId: string): boolean {
    if (this.resumeGraceSec <= 0) return false;
    const member = room.member(participantId);
    if (!member || member.connection.offline) return false;
    return Boolean(member.connection.resumeCapable || member.connection.resumeTokenHash);
  }
}

function rareValid(raw: string | undefined): raw is string {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= RESUME_TOKEN_MAX_LENGTH;
}

/** Constant-time comparison of two lowercase hex digests. */
function safeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** LiveKit room name (mirrors `sfu.ts` without importing the SFU module). */
function sfuRoomNameFor(tenantId: string, roomId: string): string {
  return `${tenantId}__${roomId}`.replace(/[:/]/g, '_');
}

/**
 * Builds the default store for an Env: Redis when `AGIL_ROOM_SNAPSHOT_STORE=redis`
 * and a client is supplied (file store kept as a write-through mirror),
 * otherwise the local file store.
 */
export function buildRoomSnapshotStore(
  env: Env,
  logger: Logger,
  redis?: RoomSnapshotRedis,
  fence?: SnapshotFence,
): RoomSnapshotStore {
  const file = new FileRoomSnapshotStore(env.roomSnapshotDir);
  if (env.roomSnapshotStore === 'redis' && redis) {
    logger.info('room snapshots use the Redis-compatible store', {
      prefix: env.redisKeyPrefix,
      mirror: env.roomSnapshotDir,
    });
    return new RedisRoomSnapshotStore({ redis, prefix: env.redisKeyPrefix, mirror: file, fence });
  }
  return file;
}
