/**
 * Cluster enrollment store: hashed one-time tokens + the node / standby Core
 * registry (docs/api/cluster.md).
 *
 * Persistence is a single JSON document under `<AGIL_DATA_DIR>/cluster/`,
 * written atomically (tmp + rename). Only token **hashes** (sha256 with
 * `AGIL_IP_SALT`) and per-node key hashes are stored — the plaintext enrollment
 * token and node key are returned once and never logged or persisted.
 *
 * Leader election/failover is implemented separately (Redis lease,
 * `./leader.ts`, docs/ha-leader.md); this store only enforces the resulting
 * leader-only gate and holds the local registry.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CLUSTER_BASELINE_LIMITATIONS,
  ENROLLMENT_TOKEN_PREFIX,
  NODE_HEARTBEAT_INTERVAL_SEC,
  NODE_KEY_PREFIX,
  NODE_MODULE_COMMAND_MAX_QUEUE,
  NODE_OFFLINE_AFTER_SEC,
  clusterIdSchema,
  isNodeModuleAutoStartAction,
  nodeCapacityInputSchema,
  nodeCustomModuleTemplatesSchema,
  isCustomNodeModuleAction,
  isComposeProvisionedNodeModuleImage,
  isOperatorManagedNodeModule,
  nodeMetricsSchema,
  nodeModuleAvailabilitySchema,
  nodeModuleContainerIdSchema,
  nodeModuleFailureSchema,
  nodeModuleKindSchema,
  nodeModuleKinds,
  NODE_MODULE_MAX_ITEMS,
  nodeTurnEndpointSchema,
  type Cluster,
  type ClusterJoinRequest,
  type ClusterJoinResponse,
  type ClusterNodeCounts,
  type ClusterRegistryStatus,
  type ClusterRole,
  type EnrollmentKind,
  type EnrollmentRole,
  type EnrollmentToken,
  type EnrollmentTokenCreateRequest,
  type EnrollmentTokenStatus,
  type EnrollmentTokenSummary,
  type NodeCapacity,
  type NodeCapacityInput,
  type NodeHeartbeatRequest,
  type NodeMetrics,
  type NodeMetricsInput,
  type NodeModule,
  type NodeModuleAction,
  type NodeModuleAvailability,
  type NodeModuleCommand,
  type NodeModuleFailure,
  type NodeModuleKind,
  type NodeModuleLogWindows,
  type NodeModuleResult,
  type NodeRegistrationResponse,
  type NodeRole,
  type NodeStatus,
  type TurnNodeState,
  type NodeSummary,
  type NodeCustomModuleTemplate,
  type NodeTurnEndpoint,
  type NodeUpdateRequest,
  type StandbyCoreSummary,
} from '@agil/protocol';
import type { Env } from './env.js';
import { HttpError } from './http.js';
import {
  LeaderElector,
  leaderStatusOf,
  leaseStatusOf,
  type LeaderSnapshot,
  type LeadershipGate,
} from './leader.js';
import type { Logger } from './logger.js';
import {
  createModuleCommand,
  isKnownNodeModule,
  nodeModuleCatalogEntry,
  publicModuleCommand,
  sanitizeModuleReports,
  storedModuleCommands,
  storedModules,
  type StoredModuleCommand,
} from './node-modules.js';

const DEFAULT_TOKEN_TTL_SEC = 3600;
const MAX_TOKEN_TTL_SEC = 30 * 24 * 3600;
const MAX_TOKENS_PER_TENANT = 500;
const MAX_NODES_PER_TENANT = 500;
const RETIRED_TOKEN_RETENTION_MS = 30 * 24 * 3600 * 1000;
/** Advisory registry lock: wait up to 1 s, reclaim locks older than 30 s. */
const LOCK_WAIT_MS = 1_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 5;

/** Synchronous sleep for the advisory write lock (no event loop / no deps). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface StoredToken {
  id: string;
  tenantId: string;
  kind: EnrollmentKind;
  role: EnrollmentRole;
  features: string[];
  /** sha256(ipSalt:plaintext) — the plaintext is never stored. */
  hash: string;
  expiresAt: number;
  uses: number;
  used: number;
  createdBy: string;
  createdAt: number;
  revokedAt: number | null;
  label: string;
}

interface StoredNode {
  id: string;
  tenantId: string;
  role: NodeRole;
  features: string[];
  /** Capacity last supplied by the node. Operator overrides take precedence per field. */
  capacity: NodeCapacity;
  capacityOverrides?: NodeCapacityInput;
  name: string;
  endpoint: string;
  healthPath: string;
  region: string;
  version: string;
  /** Last self-reported live metrics snapshot; `null` = never reported. */
  metrics: NodeMetrics | null;
  /** The administrator explicitly excluded SFU from this node's features. */
  sfuFeatureDisabled?: true;
  sfuReady?: boolean;
  sfuReadyReportedAt?: number;
  /** Keep maintenance while a delivered graceful stop can still be taking effect. */
  externalSfuStopTarget?: string;
  externalSfuRestart?: 'stopping' | 'starting';
  turnReady?: boolean;
  turnReadyReportedAt?: number;
  turnEndpoint?: NodeTurnEndpoint;
  turnSignerFingerprint?: string;
  /**
   * Last full module inventory snapshot reported on heartbeat; `null` = never
   * reported (old agent), `[]` = reported "no modules installed".
   */
  modules: NodeModule[] | null;
  moduleTemplates?: NodeCustomModuleTemplate[];
  /** Core receipt time of the last full inventory, independent of node liveness. */
  modulesReportedAt: number | null;
  disabledModules?: NodeModuleKind[];
  moduleAvailability?: NodeModuleAvailability;
  /** Queued module commands (pending + delivered in-flight), TTL-pruned. */
  moduleCommands: StoredModuleCommand[];
  moduleFailures: NodeModuleFailure[];
  /** sha256(ipSalt:nodeKey) — the node key is shown once at registration. */
  keyHash: string;
  enabled: boolean;
  drain: boolean;
  createdAt: number;
  registeredAt: number;
  lastSeenAt: number | null;
  /** Last self-reported liveness (a node can announce a graceful offline). */
  lastStatus: 'online' | 'offline';
  /** Epoch ms when the node key stops working; `null` = no expiry. */
  keyExpiresAt: number | null;
  /** Epoch ms of the last admin rotation; `null` for the original key. */
  keyRotatedAt: number | null;
}

interface StoredStandby {
  id: string;
  tenantId: string;
  clusterId: string;
  version: string;
  region: string;
  registeredAt: number;
  lastSeenAt: number | null;
}

interface ClusterStateFile {
  version: 1;
  clusterId: string;
  tokens: StoredToken[];
  nodes: StoredNode[];
  standbys: StoredStandby[];
}

export interface ClusterStoreOptions {
  env: Env;
  dataDir: string;
  /** Server version reported as the cluster `version`. */
  version: string;
  logger?: Logger;
  /**
   * Leader lease gate. `index.ts` attaches the Redis-backed `LeaderElector`
   * after construction; without it the store uses the static
   * `AGIL_CLUSTER_ROLE` (standalone behaviour).
   */
  leadership?: LeadershipGate;
  /**
   * Called after a drain marker changes (also for `drain: false`). Used by the
   * continuity service to mark/clear the rooms pinned to that node; a failing
   * listener must never block the registry write.
   */
  onDrainChange?: (change: { tenantId: string; nodeId: string; drain: boolean; node: NodeSummary }) => void;
}

const TOKEN_ID_RE = /^enr_[0-9a-f]{16}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function defaultRole(kind: EnrollmentKind): EnrollmentRole {
  return kind === 'core' ? 'standby' : 'all';
}

function roleFitsKind(kind: EnrollmentKind, role: EnrollmentRole): boolean {
  if (kind === 'core') return role === 'leader' || role === 'standby';
  return role === 'sfu' || role === 'turn' || role === 'stun' || role === 'all';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizeFeatures(features: readonly string[] | undefined): string[] {
  if (!features || features.length === 0) return [];
  return [...new Set(features.map((feature) => feature.trim()).filter(Boolean))].slice(0, 16);
}

/** Merge a partial capacity report into the stored one (0 = not reported). */
function mergeCapacity(base: NodeCapacity, patch: NodeCapacityInput | undefined): NodeCapacity {
  if (!patch) return base;
  return {
    maxRooms: patch.maxRooms ?? base.maxRooms,
    maxParticipants: patch.maxParticipants ?? base.maxParticipants,
    bandwidthMbps: patch.bandwidthMbps ?? base.bandwidthMbps,
  };
}

/**
 * Merge a live-metrics report into the last snapshot. Only fields the node
 * actually sent are replaced; an empty `metrics: {}` (for example an agent that
 * JSON-serialised all-`undefined` values) is a no-op, not an erased snapshot.
 * `reportedAt` is the client capture time, or the Core receipt time when the
 * node omitted it — the server never invents metric *values*.
 *
 * Returns `base` unchanged when the report carries no metric field, otherwise a
 * new snapshot (the input object is never mutated).
 */
function mergeNodeMetrics(
  base: NodeMetrics | null,
  patch: NodeMetricsInput | undefined,
  receivedAt: number,
): NodeMetrics | null {
  if (!patch) return base;
  if (
    patch.cpuPercent === undefined &&
    patch.memoryPercent === undefined &&
    patch.load1 === undefined &&
    patch.activeRooms === undefined &&
    patch.participants === undefined &&
    patch.bandwidthMbps === undefined &&
    patch.uptimeSec === undefined &&
    patch.version === undefined
  ) {
    return base;
  }
  return {
    ...(base ?? {}),
    ...(patch.cpuPercent !== undefined ? { cpuPercent: patch.cpuPercent } : {}),
    ...(patch.memoryPercent !== undefined ? { memoryPercent: patch.memoryPercent } : {}),
    ...(patch.load1 !== undefined ? { load1: patch.load1 } : {}),
    ...(patch.activeRooms !== undefined ? { activeRooms: patch.activeRooms } : {}),
    ...(patch.participants !== undefined ? { participants: patch.participants } : {}),
    ...(patch.bandwidthMbps !== undefined ? { bandwidthMbps: patch.bandwidthMbps } : {}),
    ...(patch.uptimeSec !== undefined ? { uptimeSec: patch.uptimeSec } : {}),
    ...(patch.version !== undefined ? { version: patch.version } : {}),
    reportedAt: patch.reportedAt ?? receivedAt,
  };
}

/**
 * Validates a persisted metrics snapshot when the registry file is re-read.
 * Damaged/out-of-range values are dropped (the node is kept, `metrics` becomes
 * `null`) rather than failing the whole registry or surfacing fake data.
 */
function storedMetrics(value: unknown): NodeMetrics | null {
  if (!isObject(value)) return null;
  const parsed = nodeMetricsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** One command acknowledgement the Core applied on a heartbeat (audited). */
export interface AcknowledgedModuleCommand {
  command: StoredModuleCommand;
  result: NodeModuleResult;
}

/** Heartbeat result: the refreshed node plus module queue traffic. */
export interface HeartbeatOutcome {
  node: NodeSummary;
  /** Commands delivered by this heartbeat (exactly once; empty when none). */
  moduleCommands: NodeModuleCommand[];
  /** Command results applied during this heartbeat (for audit). */
  acknowledgedModuleResults: AcknowledgedModuleCommand[];
  automaticSfuStart?: NodeModuleCommand;
}

/** Read-only per-node module view (`GET /v1/admin/nodes/:nodeId/modules`). */
export interface NodeModulesView {
  nodeId: string;
  modules: NodeModule[];
  moduleAvailability?: NodeModuleAvailability;
  moduleTemplates?: NodeCustomModuleTemplate[];
  logWindows?: NodeModuleLogWindows;
  inventoryStale: boolean;
  pendingCommands: NodeModuleCommand[];
  inFlightCommands: NodeModuleCommand[];
  failures: NodeModuleFailure[];
}

/**
 * Cluster registry. One instance per server (constructed in index.ts); all
 * mutating methods persist synchronously so a crash cannot lose a token use.
 */
export class ClusterStore {
  private readonly env: Env;
  private readonly file: string;
  private readonly serverVersion: string;
  private readonly logger?: Logger;
  /** Continuity hook: marks the rooms pinned to a node when drain changes. */
  private readonly onDrainChange?: ClusterStoreOptions['onDrainChange'];
  /** Leader gate: static `AGIL_CLUSTER_ROLE` until `setLeadership()` runs. */
  private leadership: LeadershipGate;
  private state: ClusterStateFile;
  private readonly moduleLogWindows = new Map<string, { reportedAt: number; windows: NodeModuleLogWindows }>();
  /** True when the registry file had to be created/changed at startup. */
  private needsInitialWrite = false;
  /**
   * Serialized snapshot of the last successful write. If a write fails (for
   * example a live foreign lock), the in-memory mutation is rolled back to this
   * snapshot before the request fails with `503 registry_unavailable`, so the
   * process never reports success for a change it did not persist.
   */
  private lastPersisted: string | null = null;

  constructor(options: ClusterStoreOptions) {
    this.env = options.env;
    this.serverVersion = options.version;
    this.logger = options.logger;
    this.onDrainChange = options.onDrainChange;
    this.file = path.join(options.dataDir, 'cluster', 'cluster.json');
    const loaded = this.loadState();
    this.state = loaded.state;
    this.needsInitialWrite = loaded.needsWrite;
    this.leadership =
      options.leadership ??
      // Standalone fallback while the HTTP server is being built: in Redis mode
      // this elector starts as standby (fail closed) until `start()` acquires
      // the lease, so no mutation can slip through during startup.
      new LeaderElector({
        env: options.env,
        clusterId: loaded.state.clusterId,
        version: options.version,
        publicOrigin: options.env.publicOrigin,
        ...(options.logger ? { logger: options.logger } : {}),
      });
    this.lastPersisted = JSON.stringify(this.state);
    if (loaded.needsWrite) {
      try {
        this.persist();
      } catch {
        // persist() already logged; the registry is best-effort durable, so the
        // server can start and retry on the next mutation.
      }
    }
  }

  /** Replaces the static gate with the Redis-backed elector (index.ts). */
  setLeadership(leadership: LeadershipGate): void {
    this.leadership = leadership;
  }

  /** The active gate (used by index.ts to start/close it and by tests). */
  getLeadership(): LeadershipGate {
    return this.leadership;
  }

  /* ------------------------------------------------------------------ */
  /* Identity / persistence                                              */
  /* ------------------------------------------------------------------ */

  private loadState(): { state: ClusterStateFile; needsWrite: boolean } {
    // In HA mode every Core must share the same cluster id: an empty value
    // falls back to `default` rather than a per-data-dir random id.
    const configuredId = this.env.clusterId.trim();
    const envClusterId = configuredId || (this.env.redisUrl ? 'default' : '');
    const fallbackId = `cl_${randomBytes(6).toString('hex')}`;
    let stored: ClusterStateFile | null = null;
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
        if (isObject(parsed) && Array.isArray(parsed.tokens) && Array.isArray(parsed.nodes) && Array.isArray(parsed.standbys)) {
          stored = {
            version: 1,
            clusterId: typeof parsed.clusterId === 'string' && clusterIdSchema.safeParse(parsed.clusterId).success
              ? parsed.clusterId
              : fallbackId,
            tokens: parsed.tokens.filter((token): token is StoredToken => this.isStoredToken(token)),
            nodes: parsed.nodes
              .filter((node): node is StoredNode => this.isStoredNode(node))
              .map((node) => ({
                ...node,
                capacityOverrides: nodeCapacityInputSchema.safeParse(node.capacityOverrides).data,
                metrics: storedMetrics((node as { metrics?: unknown }).metrics),
                sfuFeatureDisabled: node.sfuFeatureDisabled === true ? true : undefined,
                sfuReady: typeof node.sfuReady === 'boolean' ? node.sfuReady : undefined,
                sfuReadyReportedAt: Number.isSafeInteger(node.sfuReadyReportedAt) ? node.sfuReadyReportedAt : undefined,
                externalSfuStopTarget: nodeModuleContainerIdSchema.safeParse(node.externalSfuStopTarget).data,
                externalSfuRestart: node.externalSfuRestart === 'stopping' || node.externalSfuRestart === 'starting'
                  ? node.externalSfuRestart : undefined,
                turnReady: typeof node.turnReady === 'boolean' ? node.turnReady : undefined,
                turnReadyReportedAt: Number.isSafeInteger(node.turnReadyReportedAt) ? node.turnReadyReportedAt : undefined,
                turnEndpoint: nodeTurnEndpointSchema.safeParse(node.turnEndpoint).data,
                turnSignerFingerprint: HASH_RE.test(node.turnSignerFingerprint ?? '') ? node.turnSignerFingerprint : undefined,
                disabledModules: nodeModuleKindSchema.array().safeParse(node.disabledModules).data,
                modules: storedModules((node as { modules?: unknown }).modules),
                moduleTemplates: nodeCustomModuleTemplatesSchema.safeParse(node.moduleTemplates).data,
                modulesReportedAt: typeof node.modulesReportedAt === 'number' &&
                  Number.isSafeInteger(node.modulesReportedAt) && node.modulesReportedAt >= 0
                  ? node.modulesReportedAt : null,
                moduleAvailability: nodeModuleAvailabilitySchema.safeParse(node.moduleAvailability).data,
                moduleCommands: storedModuleCommands((node as { moduleCommands?: unknown }).moduleCommands, Date.now()),
                moduleFailures: (nodeModuleFailureSchema.array().safeParse(node.moduleFailures).data ?? [])
                  .filter((failure) => nodeModuleCatalogEntry(failure.moduleId) || isCustomNodeModuleAction(failure.action)),
              })),
            standbys: parsed.standbys.filter((standby): standby is StoredStandby => this.isStoredStandby(standby)),
          };
        }
      }
    } catch (error) {
      // Keep the damaged file for forensics.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        renameSync(this.file, backup);
      } catch {
        /* best effort */
      }
      this.logger?.warn('cluster registry could not be read — starting empty', {
        backup,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const validEnvId = envClusterId && clusterIdSchema.safeParse(envClusterId).success ? envClusterId : '';
    const state: ClusterStateFile = stored ?? { version: 1, clusterId: validEnvId || fallbackId, tokens: [], nodes: [], standbys: [] };
    const previousId = state.clusterId;
    if (validEnvId) state.clusterId = validEnvId;
    return { state, needsWrite: !stored || state.clusterId !== previousId || !existsSync(this.file) };
  }

  private isStoredToken(value: unknown): value is StoredToken {
    if (!isObject(value)) return false;
    return (
      typeof value.id === 'string' &&
      TOKEN_ID_RE.test(value.id) &&
      typeof value.tenantId === 'string' &&
      (value.kind === 'core' || value.kind === 'node') &&
      typeof value.role === 'string' &&
      Array.isArray(value.features) &&
      typeof value.hash === 'string' &&
      HASH_RE.test(value.hash) &&
      typeof value.expiresAt === 'number' &&
      typeof value.uses === 'number' &&
      typeof value.used === 'number'
    );
  }

  private isStoredNode(value: unknown): value is StoredNode {
    if (!isObject(value)) return false;
    return (
      typeof value.id === 'string' &&
      typeof value.tenantId === 'string' &&
      (value.role === 'sfu' || value.role === 'turn' || value.role === 'stun' || value.role === 'all') &&
      Array.isArray(value.features) &&
      isObject(value.capacity) &&
      typeof value.keyHash === 'string' &&
      HASH_RE.test(value.keyHash) &&
      typeof value.registeredAt === 'number' &&
      (value.keyExpiresAt === undefined || value.keyExpiresAt === null || typeof value.keyExpiresAt === 'number') &&
      (value.keyRotatedAt === undefined || value.keyRotatedAt === null || typeof value.keyRotatedAt === 'number')
    );
  }

  private isStoredStandby(value: unknown): value is StoredStandby {
    if (!isObject(value)) return false;
    return typeof value.id === 'string' && typeof value.tenantId === 'string' && typeof value.registeredAt === 'number';
  }

  /**
   * Persists the current state or fails the operation. A failed write restores
   * the last durable snapshot and throws `503 registry_unavailable`, so the
   * process never keeps an unpersisted token/node in memory.
   */
  private persist(): void {
    // The leader lease alone is not enough: in HA mode a Core must also still
    // hold the explicit node-registry lock (a separate Redis key) so two Cores
    // cannot write the registry during a handover.
    this.leadership.assertRegistryWritable();
    this.prune();
    const lockFile = `${this.file}.lock`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const lockToken = this.acquireLock(lockFile);
      try {
        const tmp = `${this.file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
        renameSync(tmp, this.file);
      } finally {
        this.releaseLock(lockFile, lockToken);
      }
      this.lastPersisted = JSON.stringify(this.state);
      this.needsInitialWrite = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.lastPersisted !== null) {
        this.state = JSON.parse(this.lastPersisted) as ClusterStateFile;
      }
      this.logger?.warn('cluster registry write failed', { error: message, rolledBack: this.lastPersisted !== null });
      throw new HttpError(503, 'registry_unavailable', 'Cluster registry write failed; retry the request');
    }
  }

  /**
   * Best-effort cross-process write lock. It prevents interleaved atomic
   * renames from two Cores sharing `AGIL_DATA_DIR`; it does NOT make the
   * in-memory registries coherent. Returns the lock token this writer owns.
   */
  private acquireLock(lockFile: string): string {
    const deadline = Date.now() + LOCK_WAIT_MS;
    const token = `${process.pid}:${randomBytes(6).toString('hex')}`;
    for (;;) {
      try {
        const fd = openSync(lockFile, 'wx');
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
        } finally {
          closeSync(fd);
        }
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (this.staleLock(lockFile)) {
          try {
            unlinkSync(lockFile);
          } catch {
            /* raced with another reclaimer */
          }
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`cluster registry is locked (${lockFile})`);
        sleepSync(LOCK_RETRY_MS);
      }
    }
  }

  /** Removes the lock only when it is still the one this writer created. */
  private releaseLock(lockFile: string, token: string): void {
    try {
      const parsed = JSON.parse(readFileSync(lockFile, 'utf8')) as { token?: unknown };
      if (parsed.token !== token) return;
      unlinkSync(lockFile);
    } catch {
      /* already released or reclaimed */
    }
  }

  private staleLock(lockFile: string): boolean {
    try {
      const parsed = JSON.parse(readFileSync(lockFile, 'utf8')) as { at?: unknown };
      if (typeof parsed.at === 'number') return Date.now() - parsed.at > LOCK_STALE_MS;
    } catch {
      /* fall through to the mtime check */
    }
    // A lock that exists but is not valid JSON yet (the owner is between
    // openSync and writeFileSync) must NOT be treated as immediately stale:
    // that race would let two writers enter at once. Use the file mtime.
    try {
      return Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }

  private moduleFailuresAt(node: StoredNode, now: number): NodeModuleFailure[] {
    const failures = new Map(node.moduleFailures.map((failure) => [failure.moduleId, { ...failure }]));
    for (const command of node.moduleCommands) {
      if (command.expiresAt > now) continue;
      failures.set(command.moduleId, {
        moduleId: command.moduleId,
        action: command.action,
        reason: command.deliveredAt === null ? 'delivery_expired' : 'result_expired',
      });
    }
    return [...failures.values()].slice(-NODE_MODULE_MAX_ITEMS);
  }

  /** Records expiration without changing the node-reported module inventory. */
  private pruneModuleCommands(node: StoredNode, now: number): void {
    if (node.moduleCommands.some((command) => command.expiresAt <= now)) {
      node.moduleFailures = this.moduleFailuresAt(node, now);
    }
    node.moduleCommands = node.moduleCommands.filter((command) => command.expiresAt > now);
    if (node.moduleCommands.length > NODE_MODULE_COMMAND_MAX_QUEUE) {
      node.moduleCommands = node.moduleCommands.slice(-NODE_MODULE_COMMAND_MAX_QUEUE);
    }
  }

  /** Drops long-retired tokens and enforces per-tenant caps (oldest first). */
  private prune(): void {
    const now = Date.now();
    const active = (token: StoredToken): boolean =>
      !token.revokedAt && token.expiresAt > now && token.used < token.uses;
    this.state.tokens = this.state.tokens.filter(
      (token) => active(token) || now - token.createdAt < RETIRED_TOKEN_RETENTION_MS,
    );
    const byTenant = new Map<string, StoredToken[]>();
    for (const token of this.state.tokens) {
      const list = byTenant.get(token.tenantId) ?? [];
      list.push(token);
      byTenant.set(token.tenantId, list);
    }
    const kept: StoredToken[] = [];
    for (const list of byTenant.values()) {
      if (list.length <= MAX_TOKENS_PER_TENANT) {
        kept.push(...list);
        continue;
      }
      const sorted = [...list].sort((a, b) => a.createdAt - b.createdAt);
      // Retire the oldest inactive tokens first; never drop an active one.
      const dropCount = sorted.length - MAX_TOKENS_PER_TENANT;
      const dropped = new Set<string>();
      for (const token of sorted) {
        if (dropped.size >= dropCount) break;
        if (!active(token)) dropped.add(token.id);
      }
      for (const token of sorted) {
        if (dropped.size >= dropCount) break;
        dropped.add(token.id);
      }
      kept.push(...sorted.filter((token) => !dropped.has(token.id)));
    }
    this.state.tokens = kept;
    const nodesByTenant = new Map<string, StoredNode[]>();
    for (const node of this.state.nodes) {
      const list = nodesByTenant.get(node.tenantId) ?? [];
      list.push(node);
      nodesByTenant.set(node.tenantId, list);
    }
    const keptNodes: StoredNode[] = [];
    for (const list of nodesByTenant.values()) {
      const sorted = [...list].sort((a, b) => a.registeredAt - b.registeredAt);
      keptNodes.push(...sorted.slice(Math.max(0, sorted.length - MAX_NODES_PER_TENANT)));
    }
    this.state.nodes = keptNodes;
    for (const node of this.state.nodes) this.pruneModuleCommands(node, now);
  }

  private hashSecret(raw: string): string {
    return createHash('sha256').update(`${this.env.ipSalt}:${raw}`, 'utf8').digest('hex');
  }

  identity(): Cluster {
    return { id: this.state.clusterId, role: this.leadership.role(), version: this.serverVersion };
  }

  /**
   * Leader-only mutation gate. With Redis this consults the fenced lease
   * (synchronous, no network I/O: the local deadline is authoritative and is
   * refreshed by the renewal timer); without Redis it is the static
   * `AGIL_CLUSTER_ROLE`. A standby gets `409 not_leader` before touching state.
   */
  assertLeader(operation: string): void {
    this.leadership.assertLeader(operation);
  }

  /** True while this Core may accept mutations (used by the admin gate). */
  isLeader(): boolean {
    return this.leadership.isLeader();
  }

  /** Called by the elector right after this Core acquires the lease. */
  onPromote(): void {
    // The registry is a per-Core JSON file. In a shared-data-dir deployment the
    // previous leader may have written while this Core was standby, so re-read
    // the file before accepting writes.
    this.reloadFromDisk();
    if (this.needsInitialWrite) {
      try {
        this.persist();
      } catch (error) {
        this.logger?.warn('cluster registry could not be initialized after promotion', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Re-reads the registry file after promotion; keeps memory on parse errors. */
  private reloadFromDisk(): void {
    if (!existsSync(this.file)) return;
    try {
      const loaded = this.loadState();
      this.state = loaded.state;
      this.lastPersisted = JSON.stringify(this.state);
      this.needsInitialWrite = loaded.needsWrite;
      this.logger?.info('cluster registry reloaded after leadership acquisition', {
        clusterId: this.state.clusterId,
        tokens: this.state.tokens.length,
        nodes: this.state.nodes.length,
        standbys: this.state.standbys.length,
      });
    } catch (error) {
      this.logger?.warn('cluster registry reload failed; keeping the in-memory copy', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Enrollment tokens                                                   */
  /* ------------------------------------------------------------------ */

  private tokenStatus(token: StoredToken, now = Date.now()): EnrollmentTokenStatus {
    if (token.revokedAt) return 'revoked';
    if (token.expiresAt <= now) return 'expired';
    if (token.used >= token.uses) return 'used';
    return 'active';
  }

  private summarizeToken(token: StoredToken): EnrollmentTokenSummary {
    const now = Date.now();
    return {
      id: token.id,
      kind: token.kind,
      role: token.role,
      features: [...token.features],
      expiresAt: token.expiresAt,
      uses: token.uses,
      remainingUses: Math.max(0, token.uses - token.used),
      createdBy: token.createdBy,
      createdAt: token.createdAt,
      revokedAt: token.revokedAt,
      label: token.label,
      status: this.tokenStatus(token, now),
    };
  }

  /** Issues a token; the returned plaintext is the only copy that ever exists. */
  createToken(
    input: EnrollmentTokenCreateRequest & { tenantId: string; createdBy: string; now?: number },
  ): { token: string; enrollment: EnrollmentTokenSummary } {
    this.assertLeader('issuing enrollment tokens');
    const now = input.now ?? Date.now();
    const kind = input.kind;
    const role = input.role ?? defaultRole(kind);
    if (!roleFitsKind(kind, role)) {
      throw new HttpError(400, 'validation_failed', `Role ${role} is not valid for a ${kind} enrollment token`);
    }
    const ttlSec = clamp(input.ttlSec ?? DEFAULT_TOKEN_TTL_SEC, 1, MAX_TOKEN_TTL_SEC);
    const uses = clamp(input.uses ?? 1, 1, 100);
    const features = kind === 'node' ? normalizeFeatures(input.features) : [];
    const plaintext = `${ENROLLMENT_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
    const stored: StoredToken = {
      id: `enr_${randomBytes(8).toString('hex')}`,
      tenantId: input.tenantId,
      kind,
      role,
      features,
      hash: this.hashSecret(plaintext),
      expiresAt: now + ttlSec * 1000,
      uses,
      used: 0,
      createdBy: input.createdBy,
      createdAt: now,
      revokedAt: null,
      label: (input.label ?? '').trim().slice(0, 80),
    };
    this.state.tokens.push(stored);
    this.persist();
    return { token: plaintext, enrollment: this.summarizeToken(stored) };
  }

  listTokens(tenantId: string): EnrollmentTokenSummary[] {
    return this.state.tokens
      .filter((token) => token.tenantId === tenantId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((token) => this.summarizeToken(token));
  }

  /** Revokes one token; returns null when the tenant has no such token. */
  revokeToken(tenantId: string, tokenId: string): EnrollmentTokenSummary | null {
    this.assertLeader('token revocation');
    const token = this.state.tokens.find((candidate) => candidate.tenantId === tenantId && candidate.id === tokenId);
    if (!token) return null;
    if (!token.revokedAt) {
      token.revokedAt = Date.now();
      this.persist();
    }
    return this.summarizeToken(token);
  }

  private findToken(raw: string): StoredToken | null {
    if (!raw || raw.length > 200) return null;
    const hash = this.hashSecret(raw);
    for (const token of this.state.tokens) {
      if (safeEqualHex(token.hash, hash)) return token;
    }
    return null;
  }

  /**
   * Validates a token without consuming a use. Uses one generic message for
   * unknown tokens so an attacker cannot probe which ids exist.
   */
  private validateToken(raw: string, kind: EnrollmentKind): StoredToken {
    const token = this.findToken(raw);
    if (!token) throw new HttpError(401, 'unauthorized', 'Invalid enrollment token');
    if (token.kind !== kind) {
      throw new HttpError(403, 'forbidden', `This enrollment token is not valid for ${kind} enrollment`);
    }
    const status = this.tokenStatus(token);
    if (status === 'revoked') throw new HttpError(401, 'unauthorized', 'Enrollment token was revoked');
    if (status === 'expired') throw new HttpError(401, 'unauthorized', 'Enrollment token expired');
    if (status === 'used') throw new HttpError(401, 'unauthorized', 'Enrollment token has already been used');
    return token;
  }

  /**
   * Consumes one use. Called only after every scope/duplicate check passed, so a
   * rejected registration does not burn a one-time token.
   */
  private consumeToken(token: StoredToken): void {
    token.used += 1;
    // Persist before handing out credentials: a crash must not resurrect a use.
    this.persist();
  }

  /* ------------------------------------------------------------------ */
  /* Node registry                                                       */
  /* ------------------------------------------------------------------ */

  private nodeStatus(node: StoredNode, now = Date.now()): NodeStatus {
    if (!node.enabled) return 'disabled';
    if (node.drain) return 'draining';
    if (node.lastStatus === 'offline') return 'offline';
    const lastSeen = node.lastSeenAt ?? node.registeredAt;
    return now - lastSeen <= NODE_OFFLINE_AFTER_SEC * 1000 ? 'online' : 'offline';
  }

  private moduleInventoryFresh(node: StoredNode, now: number): boolean {
    const reportedAt = node.modulesReportedAt;
    return reportedAt !== null && reportedAt <= now && now - reportedAt <= NODE_OFFLINE_AFTER_SEC * 1000;
  }

  private composeWorkerReadOnly(node: StoredNode, moduleId: string): boolean {
    return node.modules?.some((module) => module.id === moduleId && isComposeProvisionedNodeModuleImage(module.id, module.image)) === true;
  }

  private canManageExternalSfu(node: StoredNode, action: NodeModuleAction, targetContainerId: string | undefined, now: number): boolean {
    const sfu = node.modules?.find(({ id }) => id === 'sfu');
    return node.drain && node.enabled && node.lastStatus !== 'offline' &&
      (node.role === 'sfu' || node.role === 'all') && node.features.includes('sfu') && !node.sfuFeatureDisabled &&
      this.moduleInventoryFresh(node, now) && !!targetContainerId && sfu?.lifecycleContainerId === targetContainerId &&
      (action === 'start' ? sfu.status === 'stopped' || sfu.status === 'error' :
        (action === 'stop' || action === 'restart') && !node.externalSfuStopTarget &&
          sfu.status === 'running' && sfu.sfuDrainState === 'available');
  }

  private moduleViews(node: StoredNode): NodeModule[] {
    return (node.modules ?? []).map((module) => ({
      ...module,
      ports: [...module.ports],
      ...(module.id === 'sfu' && module.status === 'running' && node.externalSfuStopTarget &&
        node.externalSfuStopTarget === module.lifecycleContainerId
        ? { sfuDrainState: node.externalSfuRestart ? 'restart_requested' as const : 'requested' as const } : {}),
    }));
  }

  private advanceExternalSfuLifecycle(node: StoredNode, body: NodeHeartbeatRequest,
    results: AcknowledgedModuleCommand[], now: number): StoredModuleCommand | undefined {
    const heldTarget = node.externalSfuStopTarget;
    if (!heldTarget || body.status === 'offline') return;
    const sfu = node.modules?.find(({ id }) => id === 'sfu');
    const target = sfu?.lifecycleContainerId;
    if (!sfu || !target) return;

    const stopRejected = results.some(({ command, result }) => command.moduleId === 'sfu' &&
      (command.action === 'stop' || command.action === 'restart') && command.targetContainerId === heldTarget && !result.ok);
    const healthy = sfu.sfuDrainState === 'available' && body.sfuReady === true;
    const stopped = target === heldTarget && sfu.status === 'stopped';
    const stillActive = node.moduleCommands.some((command) => command.moduleId === 'sfu');
    const clear = () => { node.externalSfuStopTarget = undefined; node.externalSfuRestart = undefined; };

    if (healthy && (target !== heldTarget || node.externalSfuRestart === 'starting')) {
      clear();
      return;
    }
    if (stopRejected && sfu.sfuDrainState === 'available') {
      clear();
      return;
    }
    if (!stopped || stillActive) return;
    if (node.externalSfuRestart !== 'stopping' || !node.enabled || !node.drain || node.sfuFeatureDisabled ||
      node.disabledModules?.includes('sfu') || !node.features.includes('sfu') || (node.role !== 'all' && node.role !== 'sfu')) {
      clear();
      return;
    }
    if (body.moduleAvailability === 'disabled' || body.moduleAvailability === 'unavailable' ||
      node.moduleCommands.length >= NODE_MODULE_COMMAND_MAX_QUEUE) return;
    const start = createModuleCommand({ moduleId: 'sfu', action: 'start', targetContainerId: heldTarget, now });
    node.moduleCommands.push(start);
    node.externalSfuRestart = 'starting';
    return start;
  }

  private turnReportFresh(node: StoredNode, now: number): boolean {
    const reportedAt = node.turnReadyReportedAt;
    return reportedAt !== undefined && reportedAt <= now && now - reportedAt <= NODE_OFFLINE_AFTER_SEC * 1000;
  }

  private moduleInventoryBlock(node: StoredNode, status: NodeStatus, now: number): TurnNodeState | null {
    if (status !== 'online') return `node_${status}`;
    if (node.moduleAvailability === 'disabled') return 'module_management_disabled';
    if (node.moduleAvailability === 'unavailable') return 'docker_unavailable';
    if (!this.moduleInventoryFresh(node, now)) return 'inventory_stale';
    return null;
  }

  private summarizeNode(node: StoredNode, now = Date.now()): NodeSummary {
    const status = this.nodeStatus(node, now);
    const sfuRole = node.role === 'sfu' || node.role === 'all';
    const turnReady = node.turnReady !== undefined && node.features.includes('turn')
      ? node.turnReady && status === 'online' && this.turnReportFresh(node, now) : undefined;
    const availableModules = this.moduleInventoryBlock(node, status, now) === null
      ? (node.modules ?? []).flatMap(({ id, status: moduleStatus, health }) =>
        isKnownNodeModule(id) && !node.disabledModules?.includes(id) && moduleStatus === 'running' &&
          (health === 'healthy' || health === 'unknown') ? [id] : [])
      : [];
    return {
      id: node.id,
      role: node.role,
      features: [...node.features],
      capacity: mergeCapacity({ ...node.capacity }, node.capacityOverrides),
      status,
      tenantId: node.tenantId,
      name: node.name,
      endpoint: node.endpoint,
      healthPath: node.healthPath,
      region: node.region,
      version: node.version,
      // Absent until the node reports metrics: no zero-filled/fake snapshot.
      ...(node.metrics ? { metrics: { ...node.metrics } } : {}),
      ...(node.sfuReady !== undefined ? { sfuReady: node.sfuReady && status === 'online' &&
        sfuRole && !node.sfuFeatureDisabled && !node.disabledModules?.includes('sfu') &&
        node.sfuReadyReportedAt !== undefined && node.sfuReadyReportedAt <= now &&
        now - node.sfuReadyReportedAt <= NODE_OFFLINE_AFTER_SEC * 1000 } : {}),
      ...(turnReady !== undefined ? { turnReady } : {}),
      ...(turnReady && node.turnEndpoint ? { turnEndpoint: { ...node.turnEndpoint } } : {}),
      ...(turnReady && node.turnEndpoint && node.turnSignerFingerprint &&
        node.turnSignerFingerprint === this.turnSignerFingerprint(node) ? { automaticTurnVerified: true } : {}),
      // Absent until the node reports its first module inventory; `[]` is an
      // honest "reported: nothing installed" and stays present.
      ...(node.modules ? { modules: this.moduleViews(node) } : {}),
      availableModules,
      ...(node.disabledModules?.length ? { disabledModules: [...node.disabledModules] } : {}),
      inventoryStale: node.modules !== null && !this.moduleInventoryFresh(node, now),
      ...(node.moduleAvailability ? { moduleAvailability: node.moduleAvailability } : {}),
      enabled: node.enabled,
      drain: node.drain,
      createdAt: node.createdAt,
      registeredAt: node.registeredAt,
      lastSeenAt: node.lastSeenAt,
      keyExpiresAt: node.keyExpiresAt ?? null,
      keyRotatedAt: node.keyRotatedAt ?? null,
    };
  }

  listNodes(tenantId: string): NodeSummary[] {
    return this.state.nodes
      .filter((node) => node.tenantId === tenantId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((node) => this.summarizeNode(node));
  }

  getNode(tenantId: string, nodeId: string): NodeSummary | null {
    const node = this.state.nodes.find((candidate) => candidate.tenantId === tenantId && candidate.id === nodeId);
    return node ? this.summarizeNode(node) : null;
  }

  private turnSignerKey(node: StoredNode): string | undefined {
    const keys = Object.hasOwn(this.env.coturnAutoSecrets, node.tenantId) ? this.env.coturnAutoSecrets[node.tenantId] : undefined;
    return keys && Object.hasOwn(keys, node.id) ? keys[node.id] : undefined;
  }

  private turnSignerFingerprint(node: StoredNode): string | undefined {
    const key = this.turnSignerKey(node);
    return key ? createHash('sha256').update(key).digest('hex') : undefined;
  }

  turnNodeState(tenantId: string, nodeId: string): TurnNodeState {
    const node = this.state.nodes.find((candidate) => candidate.tenantId === tenantId && candidate.id === nodeId);
    if (!node) return 'node_not_found';
    const now = Date.now();
    const status = this.nodeStatus(node, now);
    if (status !== 'online') return `node_${status}`;
    if (node.turnReady !== undefined) {
      if (!node.features.includes('turn')) return 'turn_feature_disabled';
      if (!this.turnReportFresh(node, now)) return 'inventory_stale';
      return node.turnReady ? 'ready' : 'turn_unhealthy';
    }
    if (node.disabledModules?.includes('turn')) return 'module_disabled';
    const blocked = this.moduleInventoryBlock(node, status, now);
    if (blocked) return blocked;
    const turn = node.modules?.find((module) => module.id === 'turn');
    if (!turn) return 'turn_not_installed';
    if (turn.status !== 'running') return 'turn_not_running';
    return turn.health === 'healthy' || turn.health === 'unknown' ? 'ready' : 'turn_unhealthy';
  }

  /**
   * Registers a node with a one-time `node` token. Role and features are scoped
   * by the token; a duplicate live node id is a conflict (409).
   */
  registerNode(input: {
    request: {
      token: string;
      nodeId?: string;
      role: NodeRole;
      name?: string;
      features?: string[];
      capacity?: NodeCapacityInput;
      endpoint?: string;
      healthPath?: string;
      region?: string;
      version?: string;
      keyTtlSec?: number;
    };
    now?: number;
  }): NodeRegistrationResponse {
    this.assertLeader('node registration');
    const now = input.now ?? Date.now();
    const request = input.request;
    const token = this.validateToken(request.token, 'node');
    if (token.role !== 'all' && token.role !== request.role) {
      throw new HttpError(403, 'forbidden', `Enrollment token is scoped to the ${token.role} role`);
    }
    const requestedFeatures = request.features === undefined ? [...token.features] : normalizeFeatures(request.features);
    if (token.features.length > 0) {
      const denied = requestedFeatures.filter((feature) => !token.features.includes(feature));
      if (denied.length > 0) {
        throw new HttpError(403, 'forbidden', `Features not allowed by the enrollment token: ${denied.join(', ')}`);
      }
    }
    const nodeId = request.nodeId ?? `node_${randomBytes(6).toString('hex')}`;
    const existing = this.state.nodes.find((node) => node.tenantId === token.tenantId && node.id === nodeId);
    if (existing) {
      throw new HttpError(409, 'node_exists', `Node ${nodeId} is already registered`);
    }
    this.consumeToken(token);
    const nodeKey = `${NODE_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const keyTtlSec = request.keyTtlSec ?? this.env.nodeKeyTtlSec;
    const keyExpiresAt = keyTtlSec > 0 ? now + keyTtlSec * 1000 : null;
    const stored: StoredNode = {
      id: nodeId,
      tenantId: token.tenantId,
      role: request.role,
      features: requestedFeatures,
      capacity: mergeCapacity({ maxRooms: 0, maxParticipants: 0, bandwidthMbps: 0 }, request.capacity),
      name: (request.name ?? '').trim().slice(0, 80),
      endpoint: (request.endpoint ?? '').trim().slice(0, 300),
      healthPath: (request.healthPath ?? '/health').trim().slice(0, 200) || '/health',
      region: (request.region ?? '').trim().slice(0, 64),
      version: (request.version ?? '').trim().slice(0, 32),
      metrics: null,
      modules: null,
      modulesReportedAt: null,
      moduleCommands: [],
      moduleFailures: [],
      keyHash: this.hashSecret(nodeKey),
      enabled: true,
      drain: false,
      createdAt: now,
      registeredAt: now,
      lastSeenAt: null,
      lastStatus: 'online',
      keyExpiresAt,
      keyRotatedAt: null,
    };
    this.state.nodes.push(stored);
    this.persist();
    return {
      node: this.summarizeNode(stored, now),
      nodeKey,
      keyExpiresAt,
      heartbeatIntervalSec: NODE_HEARTBEAT_INTERVAL_SEC,
      cluster: this.identity(),
    };
  }

  private findNodeByKey(raw: string): StoredNode | null {
    if (!raw || raw.length > 200) return null;
    const hash = this.hashSecret(raw);
    for (const node of this.state.nodes) {
      if (safeEqualHex(node.keyHash, hash)) return node;
    }
    return null;
  }

  /**
   * Refreshes liveness/capacity for the node bound to `rawKey` and handles the
   * per-node module queue.
   *
   * Order matters: command results are applied first (they reference commands
   * delivered on an earlier beat), then the `modules` snapshot replaces the
   * previous inventory, then pending commands are marked delivered. Each command
   * is therefore returned by exactly one heartbeat. An acknowledgement is only
   * accepted for a command this node was actually given; unknown/expired ids are
   * ignored (a late ack after the TTL is normal). A graceful `status: "offline"`
   * beat does not deliver new commands, so work is not started during shutdown.
   */
  heartbeat(input: {
    rawKey: string;
    nodeId: string;
    body: NodeHeartbeatRequest;
    now?: number;
    /**
     * Called after the credential, node id, enabled flag and key expiry all
     * passed, immediately before the state mutation. The HTTP layer uses it to
     * charge the per-node rate-limit bucket only for authenticated beats. The
     * tenant is passed too: node ids are unique per tenant only, so the bucket
     * key must be `tenantId + nodeId`.
     */
    onAuthenticated?: (node: { id: string; tenantId: string }) => void;
  }): HeartbeatOutcome {
    this.assertLeader('node heartbeat');
    const now = input.now ?? Date.now();
    const node = this.findNodeByKey(input.rawKey);
    if (!node) throw new HttpError(401, 'unauthorized', 'Invalid node credential');
    if (node.id !== input.nodeId) throw new HttpError(403, 'forbidden', 'Node credential does not match this node');
    if (!node.enabled) throw new HttpError(403, 'forbidden', 'Node is disabled');
    if (node.keyExpiresAt != null && now >= node.keyExpiresAt) {
      throw new HttpError(
        401,
        'unauthorized',
        'Node key expired; rotate it with POST /v1/admin/nodes/:nodeId/rotate-key',
      );
    }
    input.onAuthenticated?.({ id: node.id, tenantId: node.tenantId });

    // 1. Drop expired commands first, so a late ack/result for an expired command
    //    is ignored and an expired command is never delivered.
    this.pruneModuleCommands(node, now);

    // 2. Command results: ack + reflect the reported outcome in the inventory.
    const acknowledgedModuleResults: AcknowledgedModuleCommand[] = [];
    if (input.body.moduleResults && input.body.moduleResults.length > 0) {
      for (const result of input.body.moduleResults) {
        const index = node.moduleCommands.findIndex(
          (command) => command.id === result.commandId && command.deliveredAt !== null,
        );
        if (index < 0) continue;
        const [command] = node.moduleCommands.splice(index, 1);
        if (!command) continue;
        node.moduleFailures = node.moduleFailures.filter((failure) => failure.moduleId !== command.moduleId);
        if (!result.ok) {
          node.moduleFailures.push({ moduleId: command.moduleId, action: command.action, error: result.error });
        }
        const module = node.modules?.find((candidate) => candidate.id === command.moduleId);
        if (module && (!command.targetContainerId || module.lifecycleContainerId === command.targetContainerId) &&
          !isNodeModuleAutoStartAction(command.action)) {
          module.status = result.status;
          // A command result reports process state. Readiness belongs to the next inventory.
          if (result.status === 'running' && ['install', 'start', 'restart'].includes(command.action)) {
            module.health = 'degraded';
          }
          module.updatedAt = now;
          if (result.error) module.lastError = result.error;
          else delete module.lastError;
        }
        acknowledgedModuleResults.push({ command, result });
      }
    }

    // 2. Inventory snapshot: omitted keeps the previous one (old agents), an
    //    explicit array replaces it (sanitized against the Core allowlist).
    let automaticSfuStart: StoredModuleCommand | undefined;
    if (input.body.modules !== undefined) {
      node.modules = sanitizeModuleReports(input.body.modules, now);
      node.modulesReportedAt = now;
      automaticSfuStart = this.advanceExternalSfuLifecycle(node, input.body, acknowledgedModuleResults, now);
      if (input.body.status !== 'offline' && input.body.moduleAvailability !== 'disabled' &&
        input.body.moduleAvailability !== 'unavailable') {
        node.moduleTemplates = input.body.moduleTemplates;
      }
    }
    const { moduleAvailability } = input.body;
    const logKey = `${node.tenantId}\0${node.id}`;
    if (input.body.status === 'offline' || moduleAvailability === 'disabled' || moduleAvailability === 'unavailable') {
      node.modulesReportedAt = null;
      this.moduleLogWindows.delete(logKey);
    } else if (input.body.modules !== undefined) {
      const reports = input.body.modules;
      const eligibleIds = new Set(node.modules?.map(({ id }) => id));
      const windows = reports.flatMap(({ id, logs }) =>
        logs && eligibleIds.has(id) && reports.filter((report) => report.id === id).length === 1
          ? [{ moduleId: id, status: logs.status, events: logs.status === 'ready' ? logs.events : [] }] : []).slice(0, 4);
      this.moduleLogWindows.delete(logKey);
      if (windows.length) {
        this.moduleLogWindows.set(logKey, { reportedAt: now, windows });
        if (this.moduleLogWindows.size > 64) this.moduleLogWindows.delete(this.moduleLogWindows.keys().next().value!);
      }
    }
    // A liveness-only heartbeat may be from a legacy agent. Keep explicit
    // Docker failures until it reports availability or a fresh inventory.
    if (input.body.status !== 'offline' && (moduleAvailability !== undefined || input.body.modules !== undefined ||
      (node.moduleAvailability !== 'disabled' && node.moduleAvailability !== 'unavailable'))) {
      node.moduleAvailability = moduleAvailability;
    }

    // 3. Liveness/capacity/metrics contract (unchanged).
    node.capacity = mergeCapacity(node.capacity, input.body.capacity);
    node.metrics = mergeNodeMetrics(node.metrics, input.body.metrics, now);
    node.lastSeenAt = now;
    node.lastStatus = input.body.status === 'offline' ? 'offline' : 'online';
    if (node.lastStatus === 'offline') node.sfuReadyReportedAt = undefined;
    else if (node.externalSfuStopTarget || node.modules?.some(({ id, sfuDrainState }) => id === 'sfu' && sfuDrainState === 'requested')) {
      node.sfuReady = false;
      node.sfuReadyReportedAt = undefined;
    } else if (input.body.sfuReady !== undefined) {
      node.sfuReady = input.body.sfuReady;
      node.sfuReadyReportedAt = now;
    }
    if (node.lastStatus === 'offline') node.turnReadyReportedAt = undefined;
    else if (input.body.turnReady !== undefined) {
      // Remember that this node reports bundled TURN even when its feature is off.
      // Only enabled reports can establish readiness for new ICE sessions.
      const turnEnabled = node.features.includes('turn');
      node.turnReady = input.body.turnReady;
      node.turnReadyReportedAt = turnEnabled ? now : undefined;
      node.turnEndpoint = turnEnabled && input.body.turnReady ? input.body.turnEndpoint : undefined;
      node.turnSignerFingerprint = undefined;
      const endpoint = node.turnEndpoint;
      const key = this.turnSignerKey(node);
      if (endpoint?.credentialMode === 'rest' && key && input.body.turnEndpointProof) {
        const proof = createHmac('sha256', key).update(JSON.stringify([
          'agil-turn-auto-v1', node.id, input.rawKey, endpoint.ip, endpoint.port, endpoint.tlsPort, endpoint.tlsHostname,
        ])).digest('hex');
        if (safeEqualHex(proof, input.body.turnEndpointProof)) node.turnSignerFingerprint = this.turnSignerFingerprint(node);
      }
    }

    // 4. Deliver pending commands exactly once (never during a graceful offline
    //    beat). Expired commands were already dropped above.
    if (input.body.status !== 'offline' && input.body.modules !== undefined &&
      node.moduleAvailability !== 'unavailable' && node.moduleAvailability !== 'disabled') {
      node.moduleCommands = node.moduleCommands.filter((command) => {
        if (command.deliveredAt !== null) return true;
        const catalog = nodeModuleCatalogEntry(command.moduleId);
        const allowed = !this.composeWorkerReadOnly(node, command.moduleId) && (!catalog || catalog.actions.includes(command.action));
        const validSfu = command.moduleId !== 'sfu' || this.canManageExternalSfu(node, command.action, command.targetContainerId, now);
        const validTarget = validSfu && (!command.targetContainerId || node.modules?.some(({ id, lifecycleContainerId, templateRemovable, status }) =>
          id === command.moduleId && lifecycleContainerId === command.targetContainerId &&
          (command.action !== 'remove' || templateRemovable) &&
          (command.action !== 'install' || (templateRemovable && status === 'running'))));
        const validTemplate = command.action !== 'install' || !!nodeModuleCatalogEntry(command.moduleId) ||
          (node.moduleTemplates?.some(({ id, image, installable, cached, blockedReason, profileChanged }) =>
            id === command.moduleId && image === command.image && installable && cached && !blockedReason &&
            (!command.targetContainerId || profileChanged || !node.modules?.some((module) =>
              module.id === id && module.image === image))) &&
            (command.targetContainerId || !node.modules?.some(({ id }) => id === command.moduleId)));
        if (allowed && validTarget && validTemplate) return true;
        node.moduleFailures = node.moduleFailures.filter(({ moduleId }) => moduleId !== command.moduleId);
        node.moduleFailures.push({ moduleId: command.moduleId, action: command.action, reason: 'target_changed' });
        return false;
      });
    }
    const pending = input.body.status === 'offline' || node.moduleAvailability === 'unavailable' || node.moduleAvailability === 'disabled'
      ? []
      : node.moduleCommands.filter((command) => {
        if (command.deliveredAt !== null || node.disabledModules?.some((id) => id === command.moduleId)) return false;
        const catalog = nodeModuleCatalogEntry(command.moduleId);
        if (this.composeWorkerReadOnly(node, command.moduleId) || (catalog && !catalog.actions.includes(command.action))) return false;
        if (command.moduleId === 'sfu') {
          return input.body.modules !== undefined && this.canManageExternalSfu(node, command.action, command.targetContainerId, now);
        }
        if (command.targetContainerId || !nodeModuleCatalogEntry(command.moduleId)) return input.body.modules !== undefined && !node.drain;
        return !isNodeModuleAutoStartAction(command.action) || (input.body.modules !== undefined &&
          node.modules?.some((module) => module.id === command.moduleId && module.autoStart !== undefined));
      });
    for (const command of pending) {
      command.deliveredAt = now;
      if (command.moduleId === 'sfu' && (command.action === 'stop' || command.action === 'restart')) {
        node.externalSfuStopTarget = command.targetContainerId;
        node.externalSfuRestart = command.action === 'restart' ? 'stopping' : undefined;
        node.sfuReady = false;
        node.sfuReadyReportedAt = undefined;
      }
    }
    if (node.moduleFailures.length > NODE_MODULE_MAX_ITEMS) {
      node.moduleFailures = node.moduleFailures.slice(-NODE_MODULE_MAX_ITEMS);
    }
    this.persist();
    return {
      node: this.summarizeNode(node, now),
      moduleCommands: pending.map(publicModuleCommand),
      acknowledgedModuleResults,
      ...(automaticSfuStart ? { automaticSfuStart: publicModuleCommand(automaticSfuStart) } : {}),
    };
  }

  private requireNode(tenantId: string, nodeId: string): StoredNode {
    const node = this.state.nodes.find((candidate) => candidate.tenantId === tenantId && candidate.id === nodeId);
    if (!node) throw new HttpError(404, 'not_found', 'Node not found');
    return node;
  }

  updateNode(tenantId: string, nodeId: string, patch: NodeUpdateRequest): NodeSummary {
    this.assertLeader('node updates');
    const node = this.requireNode(tenantId, nodeId);
    if (patch.role !== undefined && patch.role !== node.role) {
      node.role = patch.role;
      node.sfuReadyReportedAt = undefined;
      if (node.role === 'sfu' || node.role === 'all') node.sfuReady ??= false;
    }
    if (patch.features !== undefined) {
      const features = normalizeFeatures(patch.features);
      const disabled = !features.includes('sfu');
      if (disabled || node.sfuFeatureDisabled || !node.features.includes('sfu')) {
        node.sfuReadyReportedAt = undefined;
        if (node.role === 'sfu' || node.role === 'all') node.sfuReady ??= false;
      }
      node.sfuFeatureDisabled = disabled ? true : undefined;
      node.features = features;
      if (!node.features.includes('turn')) node.turnReadyReportedAt = undefined;
    }
    if (patch.capacity !== undefined) node.capacityOverrides = { ...node.capacityOverrides, ...patch.capacity };
    if (patch.moduleEnabled) {
      const disabled = new Set(node.disabledModules);
      for (const moduleId of nodeModuleKinds) {
        const enabled = patch.moduleEnabled[moduleId];
        if (enabled === false) {
          disabled.add(moduleId);
          if (moduleId === 'sfu') {
            node.sfuReady ??= false;
            node.sfuReadyReportedAt = undefined;
          }
          node.moduleCommands = node.moduleCommands.filter((command) => command.moduleId !== moduleId || command.deliveredAt !== null);
        } else if (enabled && disabled.delete(moduleId)) {
          // Reuse the existing intermediate health state until a new inventory arrives.
          const module = node.modules?.find(({ id }) => id === moduleId);
          if (module) module.health = 'degraded';
          if (moduleId === 'sfu') node.sfuReadyReportedAt = undefined;
        }
      }
      node.disabledModules = disabled.size ? nodeModuleKinds.filter((moduleId) => disabled.has(moduleId)) : undefined;
    }
    if (patch.name !== undefined) node.name = patch.name.trim().slice(0, 80);
    if (patch.endpoint !== undefined) node.endpoint = patch.endpoint.trim().slice(0, 300);
    if (patch.healthPath !== undefined) node.healthPath = patch.healthPath.trim().slice(0, 200) || '/health';
    if (patch.region !== undefined) node.region = patch.region.trim().slice(0, 64);
    this.persist();
    return this.summarizeNode(node);
  }

  setDisabled(tenantId: string, nodeId: string, disabled: boolean): NodeSummary {
    this.assertLeader('node disable/enable');
    const node = this.requireNode(tenantId, nodeId);
    node.enabled = !disabled;
    if (disabled) {
      // Keep delivered commands so the agent can acknowledge work it already received.
      node.moduleCommands = node.moduleCommands.filter((command) => command.deliveredAt !== null);
      node.modulesReportedAt = null;
      this.moduleLogWindows.delete(`${tenantId}\0${nodeId}`);
      node.sfuReadyReportedAt = undefined;
      node.turnReadyReportedAt = undefined;
    }
    this.persist();
    return this.summarizeNode(node);
  }

  setDrain(tenantId: string, nodeId: string, drain: boolean): NodeSummary {
    this.assertLeader('node drain');
    const node = this.requireNode(tenantId, nodeId);
    if (!drain && (node.externalSfuStopTarget || node.modules?.some(({ id, sfuDrainState }) =>
      id === 'sfu' && sfuDrainState === 'requested'))) {
      throw new HttpError(409, 'sfu_drain_in_progress', 'Keep maintenance on until the external SFU operation is confirmed complete');
    }
    // A report from before maintenance cannot reopen direct SFU ingress.
    if (drain && !node.drain) node.sfuReadyReportedAt = undefined;
    // An SFU command queued under a previous maintenance window must not reappear.
    if (!drain) node.moduleCommands = node.moduleCommands.filter(({ moduleId, deliveredAt }) => moduleId !== 'sfu' || deliveredAt !== null);
    node.drain = drain;
    this.persist();
    const summary = this.summarizeNode(node);
    try {
      this.onDrainChange?.({ tenantId, nodeId, drain, node: summary });
    } catch {
      /* continuity hook is best-effort; the marker itself is durable */
    }
    return summary;
  }

  /**
   * Issues a fresh per-node key and invalidates the previous one immediately.
   * `keyTtlSec` overrides the env default; 0/undefined keeps the deployment
   * default (which is itself 0 = no expiry unless AGIL_NODE_KEY_TTL_SEC is set).
   */
  rotateNodeKey(
    tenantId: string,
    nodeId: string,
    keyTtlSec?: number,
  ): { node: NodeSummary; nodeKey: string; keyExpiresAt: number | null } {
    this.assertLeader('key rotation');
    const node = this.requireNode(tenantId, nodeId);
    const now = Date.now();
    const nodeKey = `${NODE_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const ttl = keyTtlSec ?? this.env.nodeKeyTtlSec;
    node.keyHash = this.hashSecret(nodeKey);
    node.keyExpiresAt = ttl > 0 ? now + ttl * 1000 : null;
    node.keyRotatedAt = now;
    this.persist();
    return { node: this.summarizeNode(node), nodeKey, keyExpiresAt: node.keyExpiresAt };
  }

  /** Removes a node record so the id can be enrolled again. */
  deleteNode(tenantId: string, nodeId: string): boolean {
    this.assertLeader('node deletion');
    const before = this.state.nodes.length;
    this.state.nodes = this.state.nodes.filter((node) => !(node.tenantId === tenantId && node.id === nodeId));
    if (this.state.nodes.length === before) return false;
    this.moduleLogWindows.delete(`${tenantId}\0${nodeId}`);
    this.persist();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Per-node modules (Docker add-on packages)                          */
  /* ------------------------------------------------------------------ */

  /**
   * Queues one allowlisted module action for a node. Leader-only and
   * tenant-scoped. The image is always resolved from the Core catalog — the
   * request cannot carry one. A module accepts a new command after the
   * current one is acknowledged or expires.
   *
   * Errors: `404 not_found` unknown node/module, `400 validation_failed`
   * action not supported by the module, `409 module_command_pending` busy module,
   * `409 module_queue_full` (max 16 per node), `409 not_leader` on a standby and
   * `503 registry_unavailable` when the queue could not be persisted.
   */
  queueModuleCommand(input: {
    tenantId: string;
    nodeId: string;
    moduleId: string;
    action: NodeModuleAction;
    targetContainerId?: string;
    expectedImage?: string;
    now?: number;
  }): NodeModuleCommand {
    this.assertLeader('node module commands');
    const now = input.now ?? Date.now();
    const node = this.requireNode(input.tenantId, input.nodeId);
    const entry = nodeModuleCatalogEntry(input.moduleId);
    const operatorManaged = isOperatorManagedNodeModule(input.moduleId);
    const custom = entry && !operatorManaged ? undefined : node.modules?.find(({ id }) => id === input.moduleId);
    const templateInstall = !entry && input.action === 'install';
    const template = templateInstall && node.moduleTemplates?.find(({ id, installable, blockedReason }) =>
      id === input.moduleId && (installable || blockedReason));
    if (!entry && !custom && !template) throw new HttpError(404, 'not_found', `Unknown node module: ${input.moduleId}`);
    if (entry ? !entry.actions.includes(input.action) : templateInstall ? !template :
      !isCustomNodeModuleAction(input.action) || (input.action === 'remove' && !custom?.templateRemovable)) {
      throw new HttpError(400, 'validation_failed', `Module ${input.moduleId} does not support action ${input.action}`);
    }
    if (this.composeWorkerReadOnly(node, input.moduleId)) {
      throw new HttpError(409, 'module_compose_read_only', 'Manage this worker with its node Compose project');
    }
    if (entry && !operatorManaged && input.targetContainerId !== undefined) {
      throw new HttpError(400, 'validation_failed', 'Catalog commands cannot select a container id');
    }
    if (!templateInstall && input.expectedImage !== undefined) {
      throw new HttpError(400, 'validation_failed', 'Only a custom template install can specify the expected image');
    }
    if (!node.enabled) {
      throw new HttpError(409, 'node_disabled', 'Enable the node before managing its modules');
    }
    if (entry && node.disabledModules?.includes(entry.id)) {
      throw new HttpError(409, 'module_disabled', `Enable module ${entry.id} before managing it`);
    }
    if (node.moduleAvailability === 'unavailable' || node.moduleAvailability === 'disabled') {
      throw new HttpError(409, 'node_modules_unavailable', 'Module management is unavailable on this node');
    }
    if (templateInstall && (!template || !template.installable || template.blockedReason || !template.cached ||
      template.image !== input.expectedImage || node.drain ||
      (input.targetContainerId ? !custom?.templateRemovable || custom.status !== 'running' ||
        custom.lifecycleContainerId !== input.targetContainerId || (custom.image === input.expectedImage && !template.profileChanged) : !!custom) ||
      !this.moduleInventoryFresh(node, now) || this.nodeStatus(node, now) !== 'online')) {
      throw new HttpError(409, 'module_target_changed', 'Refresh the inventory and check the approved template before trying again');
    }
    if (input.moduleId === 'sfu' && !this.canManageExternalSfu(node, input.action, input.targetContainerId, now)) {
      const expected = input.action === 'start' ? 'a stopped SFU' : 'a running SFU available for graceful stop';
      throw new HttpError(409, 'module_target_changed', `This command requires maintenance and a current approved container for ${expected}`);
    }
    if (input.moduleId !== 'sfu' && (!entry || operatorManaged) && !templateInstall && (!custom || (operatorManaged && node.drain) ||
      !this.moduleInventoryFresh(node, now) || this.nodeStatus(node, now) !== 'online' ||
      !custom.lifecycleContainerId || custom.lifecycleContainerId !== input.targetContainerId)) {
      throw new HttpError(409, 'module_target_changed', 'Refresh the inventory and check the current container before trying again');
    }
    const autoStartAction = isNodeModuleAutoStartAction(input.action);
    if (autoStartAction && !node.modules?.some((module) => module.id === input.moduleId && module.autoStart !== undefined)) {
      throw new HttpError(409, 'module_autostart_unavailable', 'The node has not reported a manageable restart policy for this module');
    }
    this.pruneModuleCommands(node, now);
    const activeCommand = node.moduleCommands.find((command) => command.moduleId === input.moduleId);
    if (activeCommand) {
      throw new HttpError(
        409,
        'module_command_pending',
        activeCommand.deliveredAt === null
          ? `A ${activeCommand.action} command for module ${input.moduleId} is already queued`
          : `A ${activeCommand.action} command for module ${input.moduleId} is awaiting a result`,
        { commandId: activeCommand.id },
      );
    }
    if (node.moduleCommands.length >= NODE_MODULE_COMMAND_MAX_QUEUE) {
      throw new HttpError(
        409,
        'module_queue_full',
        'The node module command queue is full; wait for the next heartbeat',
      );
    }
    const command = createModuleCommand({
      moduleId: input.moduleId, action: input.action, targetContainerId: input.targetContainerId,
      templateImage: template ? template.image : undefined, now,
    });
    node.moduleCommands.push(command);
    this.persist();
    return publicModuleCommand(command);
  }

  /**
   * Read-only per-node module view for the dashboard's expanded node card: the
   * last reported inventory plus active commands. No leader gate.
   */
  listNodeModules(tenantId: string, nodeId: string, now = Date.now()): NodeModulesView {
    const node = this.requireNode(tenantId, nodeId);
    const active = node.moduleCommands.filter((command) => command.expiresAt > now);
    const logSnapshot = this.moduleLogWindows.get(`${tenantId}\0${nodeId}`);
    const logWindows = logSnapshot && now - logSnapshot.reportedAt < NODE_OFFLINE_AFTER_SEC * 1000 &&
      this.nodeStatus(node, now) === 'online' && this.moduleInventoryFresh(node, now) ? logSnapshot.windows : undefined;
    return {
      nodeId: node.id,
      modules: this.moduleViews(node),
      ...(node.moduleTemplates ? { moduleTemplates: node.moduleTemplates.map((template) => ({ ...template })) } : {}),
      ...(logWindows ? { logWindows } : {}),
      inventoryStale: node.modules !== null && !this.moduleInventoryFresh(node, now),
      ...(node.moduleAvailability ? { moduleAvailability: node.moduleAvailability } : {}),
      pendingCommands: active
        .filter((command) => command.deliveredAt === null)
        .map(publicModuleCommand),
      inFlightCommands: active
        .filter((command) => command.deliveredAt !== null)
        .map(publicModuleCommand),
      failures: this.moduleFailuresAt(node, now),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Standby Core registry                                               */
  /* ------------------------------------------------------------------ */

  private summarizeStandby(standby: StoredStandby): StandbyCoreSummary {
    return {
      id: standby.id,
      tenantId: standby.tenantId,
      clusterId: standby.clusterId,
      version: standby.version,
      region: standby.region,
      registeredAt: standby.registeredAt,
      lastSeenAt: standby.lastSeenAt,
    };
  }

  listStandbys(tenantId: string): StandbyCoreSummary[] {
    return this.state.standbys
      .filter((standby) => standby.tenantId === tenantId)
      .sort((a, b) => a.registeredAt - b.registeredAt)
      .map((standby) => this.summarizeStandby(standby));
  }

  /**
   * Registers a standby Core with a `core` token. Registry only: the standby is
   * listed in the cluster status and does not receive room/config state. With a
   * Redis lease the response names the current leader so the standby can retry
   * writes against it (docs/ha-leader.md).
   */
  joinCluster(input: {
    request: ClusterJoinRequest;
    publicOrigin: string;
    now?: number;
  }): ClusterJoinResponse {
    this.assertLeader('standby join');
    const now = input.now ?? Date.now();
    const token = this.validateToken(input.request.token, 'core');
    if (token.role !== 'standby') {
      throw new HttpError(403, 'forbidden', 'Only standby Core tokens can join a cluster');
    }
    const standbyId = input.request.nodeId ?? `core_${randomBytes(6).toString('hex')}`;
    const duplicate = this.state.standbys.find((standby) => standby.tenantId === token.tenantId && standby.id === standbyId);
    if (duplicate) throw new HttpError(409, 'node_exists', `Standby Core ${standbyId} is already registered`);
    this.consumeToken(token);
    const remainingUses = Math.max(0, token.uses - token.used);
    const stored: StoredStandby = {
      id: standbyId,
      tenantId: token.tenantId,
      clusterId: this.state.clusterId,
      version: (input.request.version ?? '').trim().slice(0, 32),
      region: (input.request.region ?? '').trim().slice(0, 64),
      registeredAt: now,
      lastSeenAt: null,
    };
    this.state.standbys.push(stored);
    this.persist();
    // Standalone reports the configured cluster id; with a lease the standby
    // gets the id of the Core that actually holds leadership.
    const snapshot = this.leadership.snapshot();
    return {
      cluster: this.identity(),
      leader: {
        nodeId: snapshot.mode === 'redis' ? (snapshot.leaderId ?? this.state.clusterId) : this.state.clusterId,
        version: this.serverVersion,
        publicOrigin: input.publicOrigin,
      },
      standby: this.summarizeStandby(stored),
      token: { id: token.id, remainingUses },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Status                                                              */
  /* ------------------------------------------------------------------ */

  counts(tenantId: string): ClusterNodeCounts {
    const nodes = this.listNodes(tenantId);
    const count = (status: NodeStatus): number => nodes.filter((node) => node.status === status).length;
    return {
      nodes: nodes.length,
      online: count('online'),
      offline: count('offline'),
      draining: count('draining'),
      disabled: count('disabled'),
      standbys: this.listStandbys(tenantId).length,
    };
  }

  registryStatus(tenantId: string): ClusterRegistryStatus {
    return this.buildRegistryStatus(tenantId, this.leadership.snapshot());
  }

  /**
   * Status for `GET /v1/admin/cluster/status`: refreshes the leader/lease view
   * from Redis (standby) or renews it (leader) before building the payload.
   */
  async statusSnapshot(tenantId: string): Promise<ClusterRegistryStatus> {
    return this.buildRegistryStatus(tenantId, await this.leadership.describe());
  }

  private buildRegistryStatus(tenantId: string, snapshot: LeaderSnapshot): ClusterRegistryStatus {
    return {
      cluster: this.identity(),
      leader: leaderStatusOf(snapshot),
      lease: leaseStatusOf(snapshot),
      ha: {
        mode: snapshot.mode,
        nodeId: snapshot.nodeId,
        registryLockHeld: snapshot.registryLockHeld,
        registryLockTtlRemainingMs: snapshot.registryLockTtlRemainingMs,
        roomStateReplicated: false,
        tenantConfigReplicated: false,
        nodeRegistryReplicated: false,
        stateStore: 'local-file',
      },
      failover: snapshot.failover,
      standbys: this.listStandbys(tenantId),
      enrolledNodes: this.listNodes(tenantId),
      counts: this.counts(tenantId),
      limitations: [...CLUSTER_BASELINE_LIMITATIONS],
    };
  }
}

/** Re-exported for tests and callers that need the token shape. */
export type { EnrollmentToken, NodeSummary };
