/**
 * Routing baseline: tenant-scoped route storage + the evaluator that starts
 * egress from a routed room.
 *
 * Design (see docs/routing.md):
 *  - a route maps one source (`edge` | `room` | `participant`) to at most one
 *    room plus stream/recording destinations; lower `priority` wins;
 *  - an Edge device publishes media **once** into the resolved room. RTMP/HLS
 *    are derived server-side by the LiveKit egress worker from that same room,
 *    so an Edge→stream route is really Edge→room + room→stream and never needs
 *    a direct RTMP encoder on the Edge;
 *  - a room-source route starts egress when the room becomes active (first
 *    participant) or when an admin runs `POST /v1/admin/routes/:id/test`;
 *  - every start is idempotent per process (`tenant+room+kind+layout+urls`),
 *    tenant-scoped, and failures are stored on the rule (`lastRun`) and audited
 *    with sanitized text — never the RTMP URL/stream key;
 *  - an unavailable egress worker is reported as `egress_unavailable`/`pending`
 *    and never breaks the call or the Edge join.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ROUTING_DEFAULTS,
  ROUTING_EDGE_TOKEN_PREFIX,
  ROUTING_LIMITATIONS,
  ROUTING_MAX_RULES_PER_TENANT,
  ROUTING_MAX_URL_LENGTH,
  compareRoutingRules,
  edgeEnrollmentCreateRequestSchema,
  edgeJoinRequestSchema,
  expandRoutingTemplate,
  mergeRoutingRule,
  normalizeRoutingRule,
  routingEdgeIdSchema,
  routingRuleCreateSchema,
  routingRulePatchSchema,
  routingRuleSchema,
  routingRuleView,
  routingTagSchema,
  routingTestRequestSchema,
  routingDestinationView,
  routingUrlHost,
  matchesRoutingSource,
  selectRoutingRule,
  RoutingPatchError,
  type AuditEntry,
  type EdgeEnrollmentCreateRequest,
  type EdgeEnrollmentCreatedResponse,
  type EdgeEnrollmentTokenSummary,
  type EdgeJoinRequest,
  type EdgeJoinResponse,
  type FlowEdgeJoinResult,
  type Role,
  type RoutingDestination,
  type RoutingEffectiveDestination,
  type RoutingEgressSummary,
  type RoutingPublishKind,
  type RoutingRule,
  type RoutingRuleCreate,
  type RoutingRulePatch,
  type RoutingRuleView,
  type RoutingRunJob,
  type RoutingRunRecord,
  type RoutingRunStatus,
  type RoutingSourceIdentity,
  type RoutingStatus,
  type RoutingTestRequest,
  type RoutingTestResponse,
  type TenantConfig,
} from '@agil/protocol';
import { issueToken } from './auth.js';
import { isEgressUnavailableCode, type EgressClient, type EgressStartResult, type EgressLayout } from './egress.js';
import { sanitizeEgressErrorText } from './error-text.js';
import type { Env } from './env.js';
import { HttpError, zodErrorMessage } from './http.js';
import type { Logger } from './logger.js';
import { isValidRoomId, type Room, type RoomLifecycleEvent, type RoomRegistry } from './rooms.js';
import { roomMediaMode } from './scale.js';
import { resolveTenantSecret } from './secret-env.js';
import { capRoomParticipantsForSfu, sfuRoomName } from './sfu.js';
import type { TenantStore } from './tenants.js';
import { isSecureMode, validateNetworkEndpoint } from './url-policy.js';

/** Egress job results are re-tried after this delay (an unavailable worker may recover). */
const EGRESS_FAILURE_RETRY_MS = 15_000;
const MAX_EDGE_TOKENS_PER_TENANT = 200;
const MAX_TRACKED_EGRESS_JOBS = 2_000;
const MAX_JOIN_TOKEN_TTL_SEC = 24 * 3600;

const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/* ------------------------------------------------------------------ */
/* Persistent store                                                    */
/* ------------------------------------------------------------------ */

interface StoredEdgeToken {
  id: string;
  tenantId: string;
  name: string;
  edgeId?: string;
  tag?: string;
  /** sha256(ipSalt:plaintext) — the plaintext token is never stored. */
  hash: string;
  createdAt: number;
  expiresAt: number;
  uses: number;
  used: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

interface TenantRoutingState {
  version: number;
  routes: RoutingRule[];
  edgeTokens: StoredEdgeToken[];
}

export interface RoutingStoreOptions {
  /** One JSON file per tenant under this directory. */
  dir: string;
  /** Salt for Edge enrollment-token hashes (`AGIL_IP_SALT`). */
  ipSalt: string;
  now?: () => number;
  logger?: Logger;
}

function safeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
  } catch {
    return false;
  }
}

function isStoredEdgeToken(value: unknown): value is StoredEdgeToken {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const token = value as Record<string, unknown>;
  return (
    typeof token.id === 'string' &&
    typeof token.tenantId === 'string' &&
    typeof token.name === 'string' &&
    typeof token.hash === 'string' &&
    typeof token.createdAt === 'number' &&
    typeof token.expiresAt === 'number' &&
    typeof token.uses === 'number' &&
    typeof token.used === 'number' &&
    (token.edgeId === undefined || typeof token.edgeId === 'string') &&
    (token.tag === undefined || typeof token.tag === 'string') &&
    (token.revokedAt === null || typeof token.revokedAt === 'number') &&
    (token.lastUsedAt === null || typeof token.lastUsedAt === 'number')
  );
}

/** Lifecycle-derived status of an Edge enrollment token. */
export function edgeTokenStatus(token: StoredEdgeToken, now = Date.now()): EdgeEnrollmentTokenSummary['status'] {
  if (token.revokedAt) return 'revoked';
  if (token.expiresAt <= now) return 'expired';
  if (token.used >= token.uses) return 'used';
  return 'active';
}

/** Secret-free admin view of an Edge enrollment token. */
export function summarizeEdgeToken(token: StoredEdgeToken, now = Date.now()): EdgeEnrollmentTokenSummary {
  return {
    id: token.id,
    tenantId: token.tenantId,
    name: token.name,
    ...(token.edgeId ? { edgeId: token.edgeId } : {}),
    ...(token.tag ? { tag: token.tag } : {}),
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    uses: token.uses,
    used: token.used,
    ...(token.revokedAt ? { revokedAt: token.revokedAt } : {}),
    ...(token.lastUsedAt ? { lastUsedAt: token.lastUsedAt } : {}),
    status: edgeTokenStatus(token, now),
  };
}

/**
 * File-backed routing store: `<dir>/<tenantId>.json` with routes and hashed
 * Edge enrollment tokens. Writes are atomic (tmp + rename). The store never
 * validates endpoint policy (that is the service's job) but re-validates every
 * loaded rule, so a hand-edited file cannot inject an unknown shape.
 */
export class RoutingStore {
  private readonly dir: string;
  private readonly ipSalt: string;
  private readonly now: () => number;
  private readonly cache = new Map<string, TenantRoutingState>();

  constructor(options: RoutingStoreOptions) {
    this.dir = options.dir;
    this.ipSalt = options.ipSalt;
    this.now = options.now ?? Date.now;
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      /* the store still works in memory when the directory is not writable */
    }
  }

  private filePath(tenantId: string): string {
    const safe = TENANT_ID_RE.test(tenantId)
      ? tenantId
      : createHash('sha256').update(tenantId).digest('hex').slice(0, 16);
    return path.join(this.dir, `${safe}.json`);
  }

  private load(tenantId: string): TenantRoutingState {
    const cached = this.cache.get(tenantId);
    if (cached) return cached;
    const state: TenantRoutingState = { version: 1, routes: [], edgeTokens: [] };
    try {
      const raw = JSON.parse(readFileSync(this.filePath(tenantId), 'utf8')) as Record<string, unknown> | null;
      if (raw && typeof raw === 'object') {
        for (const candidate of Array.isArray(raw.routes) ? raw.routes : []) {
          const parsed = routingRuleSchema.safeParse(candidate);
          if (parsed.success && parsed.data.tenantId === tenantId) state.routes.push(parsed.data);
        }
        for (const candidate of Array.isArray(raw.edgeTokens) ? raw.edgeTokens : []) {
          if (isStoredEdgeToken(candidate) && candidate.tenantId === tenantId) state.edgeTokens.push(candidate);
        }
      }
    } catch {
      /* missing/corrupt file: start empty; a write replaces it */
    }
    this.cache.set(tenantId, state);
    return state;
  }

  private persist(tenantId: string): void {
    const state = this.load(tenantId);
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = this.filePath(tenantId);
      const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
      writeFileSync(tmp, `${JSON.stringify({ ...state, version: 1 }, null, 2)}\n`, 'utf8');
      try {
        renameSync(tmp, file);
      } catch {
        // Windows can refuse to replace an open file; retry after removing it.
        rmSync(file, { force: true });
        renameSync(tmp, file);
      }
    } catch {
      /* persistence is best-effort: the process keeps serving from memory */
    }
  }

  /* ------------------------------- routes ------------------------------- */

  listRules(tenantId: string): RoutingRule[] {
    return [...this.load(tenantId).routes].sort(compareRoutingRules);
  }

  countRules(tenantId: string): number {
    return this.load(tenantId).routes.length;
  }

  getRule(tenantId: string, routeId: string): RoutingRule | null {
    return this.load(tenantId).routes.find((rule) => rule.id === routeId) ?? null;
  }

  createRule(rule: RoutingRule): void {
    const state = this.load(rule.tenantId);
    state.routes.push(rule);
    this.persist(rule.tenantId);
  }

  replaceRule(rule: RoutingRule): boolean {
    const state = this.load(rule.tenantId);
    const index = state.routes.findIndex((candidate) => candidate.id === rule.id);
    if (index < 0) return false;
    state.routes[index] = rule;
    this.persist(rule.tenantId);
    return true;
  }

  deleteRule(tenantId: string, routeId: string): boolean {
    const state = this.load(tenantId);
    const index = state.routes.findIndex((candidate) => candidate.id === routeId);
    if (index < 0) return false;
    state.routes.splice(index, 1);
    this.persist(tenantId);
    return true;
  }

  /** Stores the sanitized outcome of the last evaluation on the rule. */
  recordRun(tenantId: string, routeId: string, run: RoutingRunRecord): boolean {
    const rule = this.getRule(tenantId, routeId);
    if (!rule) return false;
    rule.lastRun = run;
    return this.replaceRule(rule);
  }

  /* --------------------------- Edge tokens ----------------------------- */

  hashToken(raw: string): string {
    return createHash('sha256').update(`${this.ipSalt}:${raw}`, 'utf8').digest('hex');
  }

  createEdgeToken(token: StoredEdgeToken): void {
    const state = this.load(token.tenantId);
    state.edgeTokens.push(token);
    if (state.edgeTokens.length > MAX_EDGE_TOKENS_PER_TENANT) {
      const now = this.now();
      const active = (candidate: StoredEdgeToken): boolean =>
        !candidate.revokedAt && candidate.expiresAt > now && candidate.used < candidate.uses;
      // Retire the oldest inactive tokens first; never drop an active one.
      const sorted = [...state.edgeTokens].sort((a, b) => a.createdAt - b.createdAt);
      while (sorted.length > MAX_EDGE_TOKENS_PER_TENANT) {
        const index = sorted.findIndex((candidate) => !active(candidate));
        if (index < 0) break;
        sorted.splice(index, 1);
      }
      state.edgeTokens = sorted;
    }
    this.persist(token.tenantId);
  }

  listEdgeTokens(tenantId: string): StoredEdgeToken[] {
    return [...this.load(tenantId).edgeTokens].sort((a, b) => b.createdAt - a.createdAt);
  }

  findEdgeToken(raw: string): StoredEdgeToken | null {
    if (!raw || raw.length > 200) return null;
    const hash = this.hashToken(raw);
    // The tenant is unknown at redemption time, so every tenant file is checked
    // (loaded states first; the file names are the only tenant index available).
    const states = new Map(this.cache);
    for (const tenantId of this.tenantIdsOnDisk()) {
      if (!states.has(tenantId)) states.set(tenantId, this.load(tenantId));
    }
    for (const state of states.values()) {
      for (const token of state.edgeTokens) {
        if (safeEqualHex(token.hash, hash)) return token;
      }
    }
    return null;
  }

  private tenantIdsOnDisk(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.slice(0, -'.json'.length))
        .filter((tenantId) => TENANT_ID_RE.test(tenantId));
    } catch {
      return [];
    }
  }

  updateEdgeToken(token: StoredEdgeToken): void {
    const state = this.load(token.tenantId);
    const index = state.edgeTokens.findIndex((candidate) => candidate.id === token.id);
    if (index < 0) return;
    state.edgeTokens[index] = token;
    this.persist(token.tenantId);
  }

  revokeEdgeToken(tenantId: string, tokenId: string): StoredEdgeToken | null {
    const token = this.load(tenantId).edgeTokens.find((candidate) => candidate.id === tokenId);
    if (!token) return null;
    if (!token.revokedAt) {
      token.revokedAt = this.now();
      this.persist(tenantId);
    }
    return token;
  }
}

/* ------------------------------------------------------------------ */
/* Endpoint policy (SSRF / secrets)                                    */
/* ------------------------------------------------------------------ */

export interface RoutingEndpointIssue {
  path: string;
  message: string;
}

/**
 * SSRF/secret policy for every stored stream destination.
 *
 * `url` is an outbound endpoint the egress worker connects to; the shared URL
 * policy rejects credentials-in-userinfo, private/metadata hosts and (in secure
 * mode) plaintext `rtmp://`. `secretRef` is validated by the protocol schema
 * (`AGIL_ROUTE_SECRET_*`); its value is resolved only at start time.
 */
export function validateRoutingRuleEndpoints(rule: RoutingRule, options: { secure: boolean }): RoutingEndpointIssue[] {
  const issues: RoutingEndpointIssue[] = [];
  rule.destinations.forEach((destination, index) => {
    if (destination.type !== 'stream') return;
    if (destination.provider !== 'rtmp' || !destination.url) return;
    if (destination.url.length > ROUTING_MAX_URL_LENGTH) {
      issues.push({ path: `destinations.${index}.url`, message: 'URL is too long' });
      return;
    }
    const result = validateNetworkEndpoint(destination.url, {
      secure: options.secure,
      schemes: ['rtmp:', 'rtmps:'],
      applyHostPolicy: true,
    });
    if (!result.ok) issues.push({ path: `destinations.${index}.url`, message: result.reason });
  });
  return issues;
}

/* ------------------------------------------------------------------ */
/* Evaluator service                                                   */
/* ------------------------------------------------------------------ */

/** Audit sink accepting `ip` (hashed by the audit log) like the HTTP layer. */
export type RoutingAuditSink = (entry: Omit<AuditEntry, 'id' | 'ts'> & { ip?: string }) => void;

export interface RoutingServiceOptions {
  env: Env;
  logger: Logger;
  store: RoutingStore;
  tenants: TenantStore;
  rooms: RoomRegistry;
  egress: EgressClient;
  audit: RoutingAuditSink;
  now?: () => number;
  /**
   * Optional flow evaluator (`docs/flows.md`) consulted when no legacy route
   * matches an Edge join. It may throw `HttpError` (e.g. 409 `flow_pending`);
   * `null` keeps the baseline `404 no_route`.
   */
  flowEdgeJoin?: (input: {
    tenantId: string;
    edgeId: string;
    tag?: string;
    name?: string;
    ip?: string;
  }) => Promise<FlowEdgeJoinResult | null>;
  /**
   * Notified after an Edge successfully joined its routed room, so generic
   * `edge_online` flows can derive egress from that same room. Fire-and-forget:
   * an error here never affects the join.
   */
  onEdgeOnline?: (event: {
    tenantId: string;
    edgeId: string;
    tag?: string;
    roomId: string;
    roomName: string;
  }) => void;
}

interface RoomPlan {
  roomId: string;
  role: Role;
  publish: RoutingPublishKind[];
  roomDestinationIndex: number;
}

interface PlannedJob {
  kind: 'rtmp' | 'hls' | 'recording';
  layout: EgressLayout;
  audioOnly: boolean;
  urls: string[];
  indexes: number[];
}

interface JobState {
  status: RoutingStatus;
  egressId?: string;
  error?: string;
  at: number;
}

interface ApplyResult {
  destinations: RoutingEffectiveDestination[];
  summary: RoutingEgressSummary;
  errors: string[];
  jobs: RoutingRunJob[];
}

function aggregateRunStatus(statuses: RoutingStatus[]): RoutingRunStatus {
  const active = statuses.filter((status) => status !== 'skipped');
  if (active.length === 0) return 'skipped';
  const good = active.filter((status) => status === 'started' || status === 'pending' || status === 'ready');
  const pending = active.some((status) => status === 'pending');
  const failing = active.filter((status) => status === 'failed' || status === 'unavailable');
  if (failing.length === 0) return pending ? 'pending' : 'started';
  if (good.length === 0) return failing.every((status) => status === 'unavailable') ? 'unavailable' : 'failed';
  return 'partial';
}

function uniqMessages(messages: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const message of messages) {
    const normalized = sanitizeEgressErrorText(message);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.slice(0, 5);
}

/** Stable child room id for an Edge route that has no explicit room destination. */
export function implicitEdgeRoomId(edgeId: string): string {
  const cleaned = edgeId
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64);
  const candidate = cleaned ? `edge-${cleaned}` : 'edge-room';
  return candidate.slice(0, 64);
}

export class RoutingService {
  private readonly env: Env;
  private readonly logger: Logger;
  private readonly store: RoutingStore;
  private readonly tenants: TenantStore;
  private readonly rooms: RoomRegistry;
  private readonly egress: EgressClient;
  private readonly auditSink: RoutingAuditSink;
  private readonly now: () => number;
  private readonly flowEdgeJoin?: RoutingServiceOptions['flowEdgeJoin'];
  private readonly onEdgeOnline?: RoutingServiceOptions['onEdgeOnline'];
  /** Successful/terminal job cache: `${tenant}:${room}:${kind}:${layout}:${urlHash}`. */
  private readonly egressJobs = new Map<string, JobState>();
  private readonly egressInflight = new Map<string, Promise<JobState>>();

  constructor(options: RoutingServiceOptions) {
    this.env = options.env;
    this.logger = options.logger;
    this.store = options.store;
    this.tenants = options.tenants;
    this.rooms = options.rooms;
    this.egress = options.egress;
    this.auditSink = options.audit;
    this.now = options.now ?? Date.now;
    this.flowEdgeJoin = options.flowEdgeJoin;
    this.onEdgeOnline = options.onEdgeOnline;
  }

  /* ------------------------------- admin ------------------------------- */

  listRoutes(tenantId: string): RoutingRuleView[] {
    return this.store.listRules(tenantId).map(routingRuleView);
  }

  getRoute(tenantId: string, routeId: string): RoutingRuleView | null {
    const rule = this.store.getRule(tenantId, routeId);
    return rule ? routingRuleView(rule) : null;
  }

  /** Creates a rule; validates schema, SSRF policy and the tenant route cap. */
  createRoute(tenantId: string, input: RoutingRuleCreate, context: { ip?: string } = {}): RoutingRuleView {
    const parsed = routingRuleCreateSchema.safeParse(input);
    if (!parsed.success) {
      throw new HttpError(400, 'validation_failed', zodErrorMessage(parsed.error), parsed.error.issues);
    }
    if (this.store.countRules(tenantId) >= ROUTING_MAX_RULES_PER_TENANT) {
      throw new HttpError(409, 'route_limit', `Route limit reached (${ROUTING_MAX_RULES_PER_TENANT} per tenant)`);
    }
    const id = parsed.data.id ?? `rt_${randomBytes(8).toString('hex')}`;
    if (this.store.getRule(tenantId, id)) {
      throw new HttpError(409, 'route_exists', 'A route with this id already exists');
    }
    const now = this.now();
    const normalized = normalizeRoutingRule(parsed.data);
    const rule = this.assertRule({ ...normalized, id, tenantId, createdAt: now, updatedAt: now });
    this.store.createRule(rule);
    this.audit({
      type: 'route.created',
      severity: 'info',
      tenantId,
      ip: context.ip,
      message: `Routing rule created: ${rule.id} (${describeRule(rule)}, priority ${rule.priority})`,
      details: {
        kind: 'route.created',
        routeId: rule.id,
        enabled: rule.enabled,
        priority: rule.priority,
        source: rule.source,
        destinations: destinationSummary(rule),
      },
    });
    return routingRuleView(rule);
  }

  /** Deep-partial update of one rule. */
  patchRoute(
    tenantId: string,
    routeId: string,
    input: RoutingRulePatch,
    context: { ip?: string } = {},
  ): RoutingRuleView {
    const current = this.store.getRule(tenantId, routeId);
    if (!current) throw new HttpError(404, 'not_found', 'Route not found');
    const parsed = routingRulePatchSchema.safeParse(input);
    if (!parsed.success) {
      throw new HttpError(400, 'validation_failed', zodErrorMessage(parsed.error), parsed.error.issues);
    }
    if (Object.keys(parsed.data).length === 0) {
      throw new HttpError(400, 'validation_failed', 'Route patch must contain at least one field');
    }
    let merged: RoutingRule;
    try {
      merged = mergeRoutingRule(current, parsed.data, this.now());
    } catch (error) {
      if (error instanceof RoutingPatchError) {
        throw new HttpError(400, 'validation_failed', 'Invalid route patch', error.issues);
      }
      throw error;
    }
    const normalized = normalizeRoutingRule(merged);
    const rule = this.assertRule({ ...merged, ...normalized });
    if (!this.store.replaceRule(rule)) throw new HttpError(404, 'not_found', 'Route not found');
    this.audit({
      type: 'route.updated',
      severity: 'info',
      tenantId,
      ip: context.ip,
      message: `Routing rule updated: ${rule.id} (${describeRule(rule)}, priority ${rule.priority})`,
      details: {
        kind: 'route.updated',
        routeId: rule.id,
        fields: Object.keys(parsed.data).sort(),
        enabled: rule.enabled,
        priority: rule.priority,
        destinations: destinationSummary(rule),
      },
    });
    return routingRuleView(rule);
  }

  deleteRoute(tenantId: string, routeId: string, context: { ip?: string } = {}): void {
    if (!this.store.getRule(tenantId, routeId)) throw new HttpError(404, 'not_found', 'Route not found');
    this.store.deleteRule(tenantId, routeId);
    this.audit({
      type: 'route.deleted',
      severity: 'warn',
      tenantId,
      ip: context.ip,
      message: `Routing rule deleted: ${routeId}`,
      details: { kind: 'route.deleted', routeId },
    });
  }

  /* --------------------------- Edge tokens ---------------------------- */

  issueEdgeToken(
    tenantId: string,
    input: EdgeEnrollmentCreateRequest,
    context: { ip?: string; createdBy?: string } = {},
  ): EdgeEnrollmentCreatedResponse {
    const parsed = edgeEnrollmentCreateRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new HttpError(400, 'validation_failed', zodErrorMessage(parsed.error), parsed.error.issues);
    }
    const now = this.now();
    const ttlSec = clamp(parsed.data.ttlSec ?? 3600, 60, 30 * 24 * 3600);
    const uses = clamp(parsed.data.uses ?? 1, 1, 100);
    const records = this.store.listEdgeTokens(tenantId);
    if (records.filter((token) => edgeTokenStatus(token, now) === 'active').length >= MAX_EDGE_TOKENS_PER_TENANT) {
      throw new HttpError(409, 'route_token_limit', 'Too many active Edge enrollment tokens');
    }
    const plaintext = `${ROUTING_EDGE_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
    const token: StoredEdgeToken = {
      id: `edge_${randomBytes(8).toString('hex')}`,
      tenantId,
      name: (parsed.data.name ?? '').trim().slice(0, 80) || `Edge token ${new Date(now).toISOString().slice(0, 10)}`,
      ...(parsed.data.edgeId ? { edgeId: parsed.data.edgeId } : {}),
      ...(parsed.data.tag ? { tag: parsed.data.tag } : {}),
      hash: this.store.hashToken(plaintext),
      createdAt: now,
      expiresAt: now + ttlSec * 1000,
      uses,
      used: 0,
      revokedAt: null,
      lastUsedAt: null,
    };
    this.store.createEdgeToken(token);
    this.audit({
      type: 'route.edge_token_issued',
      severity: 'info',
      tenantId,
      ip: context.ip,
      message: `Edge enrollment token issued: ${token.id} (${uses} use(s), ${ttlSec}s)`,
      details: {
        kind: 'route.edge_token_issued',
        tokenId: token.id,
        ...(context.createdBy ? { createdBy: context.createdBy } : {}),
        ...(token.edgeId ? { edgeId: token.edgeId } : {}),
        ...(token.tag ? { tag: token.tag } : {}),
        uses,
        expiresAt: token.expiresAt,
      },
    });
    return { token: plaintext, enrollment: summarizeEdgeToken(token, now) };
  }

  listEdgeTokens(tenantId: string): EdgeEnrollmentTokenSummary[] {
    const now = this.now();
    return this.store.listEdgeTokens(tenantId).map((token) => summarizeEdgeToken(token, now));
  }

  revokeEdgeToken(tenantId: string, tokenId: string, context: { ip?: string } = {}): EdgeEnrollmentTokenSummary | null {
    const token = this.store.revokeEdgeToken(tenantId, tokenId);
    if (!token) return null;
    this.audit({
      type: 'route.edge_token_revoked',
      severity: 'warn',
      tenantId,
      ip: context.ip,
      message: `Edge enrollment token revoked: ${token.id}`,
      details: { kind: 'route.edge_token_revoked', tokenId: token.id },
    });
    return summarizeEdgeToken(token, this.now());
  }

  /* --------------------------- Evaluation ----------------------------- */

  /**
   * `POST /v1/edge/join`: redeems an enrollment token, selects the Edge rule,
   * returns the room + join token + effective (secret-free) destinations and
   * starts egress from the resolved room (one publish target for the Edge).
   */
  async joinEdge(input: { request: EdgeJoinRequest; ip?: string }): Promise<EdgeJoinResponse> {
    const parsed = edgeJoinRequestSchema.safeParse(input.request);
    if (!parsed.success) {
      throw new HttpError(400, 'validation_failed', zodErrorMessage(parsed.error), parsed.error.issues);
    }
    const redeemed = this.validateEdgeToken(parsed.data.token);
    const tenantId = redeemed.tenantId;
    const edgeId = redeemed.edgeId ?? parsed.data.edgeId;
    if (!edgeId) {
      throw new HttpError(400, 'validation_failed', 'edgeId is required when the enrollment token is not bound to an Edge id');
    }
    if (!routingEdgeIdSchema.safeParse(edgeId).success) {
      throw new HttpError(400, 'validation_failed', 'Invalid edgeId');
    }
    const tag = redeemed.tag ?? parsed.data.tag;
    if (tag && !routingTagSchema.safeParse(tag).success) {
      throw new HttpError(400, 'validation_failed', 'Invalid tag');
    }
    const identity: RoutingSourceIdentity = { type: 'edge', edgeId, ...(tag ? { tag } : {}) };
    const rule = selectRoutingRule(this.store.listRules(tenantId), identity);
    if (!rule) {
      // Generic flows (`docs/flows.md`) are the second selection surface: an
      // Edge can join a flow-resolved room when no legacy route matches.
      const viaFlow = this.flowEdgeJoin
        ? await this.flowEdgeJoin({
            tenantId,
            edgeId,
            ...(tag ? { tag } : {}),
            ...(parsed.data.name ? { name: parsed.data.name } : {}),
            ...(input.ip ? { ip: input.ip } : {}),
          })
        : null;
      if (!viaFlow) throw new HttpError(404, 'no_route', `No enabled routing rule matches edge ${edgeId}`);
      this.consumeEdgeToken(redeemed);
      this.audit({
        type: 'edge.joined',
        severity: viaFlow.egress.status === 'failed' || viaFlow.egress.status === 'unavailable' ? 'warn' : 'info',
        tenantId,
        roomId: viaFlow.roomId,
        ip: input.ip,
        message: `Edge ${edgeId} joined flow ${viaFlow.flowId} → room ${viaFlow.roomId} (egress: ${viaFlow.egress.status})`,
        details: {
          kind: 'edge.joined',
          flowId: viaFlow.flowId,
          edgeId,
          ...(tag ? { tag } : {}),
          roomId: viaFlow.roomId,
          egressStatus: viaFlow.egress.status,
          jobs: viaFlow.egress.jobs,
        },
      });
      return {
        tenantId,
        edgeId,
        routeId: viaFlow.flowId,
        flowId: viaFlow.flowId,
        publishTarget: 'room',
        roomId: viaFlow.roomId,
        room: viaFlow.room,
        joinToken: viaFlow.joinToken,
        expiresAt: viaFlow.expiresAt,
        publisher: { role: viaFlow.role, publish: viaFlow.publish },
        destinations: viaFlow.destinations,
        egress: viaFlow.egress,
        limitations: [...viaFlow.limitations, ...ROUTING_LIMITATIONS],
      };
    }

    const roomPlan = this.resolveRoomPlan(rule, identity, true);
    const { room, created } = this.ensureRoom(tenantId, roomPlan.roomId, {
      create: true,
      name: rule.name ?? parsed.data.name ?? `Edge ${edgeId}`,
    });
    // Consume only after every check passed, but before credentials are issued:
    // a crash must not resurrect a one-time token.
    this.consumeEdgeToken(redeemed);
    const issued = issueToken(this.env, {
      participantId: `edge-${edgeId}`,
      name: (parsed.data.name ?? `Edge ${edgeId}`).slice(0, 120),
      role: roomPlan.role,
      tenantId,
      roomId: room.id,
      ttlSec: this.edgeJoinTokenTtlSec(),
    });
    const apply = await this.applyRule(rule, room, 'edge_join');
    this.recordRun(rule, 'edge_join', room.id, apply);
    // Generic `edge_online` flows derive their own egress from the same room.
    // Fire-and-forget: a flow failure must never break the Edge join.
    if (this.onEdgeOnline) {
      try {
        this.onEdgeOnline({
          tenantId,
          edgeId,
          ...(tag ? { tag } : {}),
          roomId: room.id,
          roomName: room.name,
        });
      } catch (error) {
        this.logger.warn('flow edge-online trigger failed', {
          tenantId,
          edgeId,
          roomId: room.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.audit({
      type: 'edge.joined',
      severity: apply.summary.status === 'failed' || apply.summary.status === 'unavailable' ? 'warn' : 'info',
      tenantId,
      roomId: room.id,
      ip: input.ip,
      message: `Edge ${edgeId} joined route ${rule.id} → room ${room.id} (egress: ${apply.summary.status})`,
      details: {
        kind: 'edge.joined',
        routeId: rule.id,
        edgeId,
        ...(tag ? { tag } : {}),
        roomId: room.id,
        roomCreated: created,
        egressStatus: apply.summary.status,
        jobs: apply.summary.jobs,
        destinations: apply.summary.destinations,
      },
    });
    return {
      tenantId,
      edgeId,
      routeId: rule.id,
      publishTarget: 'room',
      roomId: room.id,
      room: {
        id: room.id,
        tenantId: room.tenantId,
        name: room.name,
        mediaMode: room.mediaMode,
        maxParticipants: room.maxParticipants,
      },
      joinToken: issued.token,
      expiresAt: issued.expiresAt,
      publisher: { role: roomPlan.role, publish: roomPlan.publish },
      destinations: apply.destinations,
      egress: apply.summary,
      limitations: [...ROUTING_LIMITATIONS],
    };
  }

  /**
   * Room lifecycle hook: the first participant makes a room "active", which is
   * when a room-source route starts egress (idempotent across re-evaluations).
   * Never throws: a routing failure must not break a call.
   */
  onRoomEvent(event: RoomLifecycleEvent): void {
    if (event.type !== 'joined') return;
    const room = event.room;
    if (room.breakoutParentId) return;
    if (room.participantCount !== 1) return;
    void this.onRoomStarted(room).catch((error: unknown) => {
      const message = sanitizeEgressErrorText(error instanceof Error ? error.message : String(error));
      this.logger.warn('room routing failed', { tenantId: room.tenantId, roomId: room.id, error: message });
      this.audit({
        type: 'route.egress.failed',
        severity: 'warn',
        tenantId: room.tenantId,
        roomId: room.id,
        message: `Room routing failed: ${message}`,
        details: { kind: 'route.egress.failed', roomId: room.id, trigger: 'room_start' },
      });
    });
  }

  private async onRoomStarted(room: Room): Promise<void> {
    const rule = selectRoutingRule(this.store.listRules(room.tenantId), { type: 'room', roomId: room.id });
    if (!rule) return;
    const apply = await this.applyRule(rule, room, 'room_start');
    this.recordRun(rule, 'room_start', room.id, apply);
    this.audit({
      type: 'route.matched',
      severity: 'info',
      tenantId: room.tenantId,
      roomId: room.id,
      message: `Room route matched: ${rule.id} (egress: ${apply.summary.status})`,
      details: {
        kind: 'route.matched',
        routeId: rule.id,
        trigger: 'room_start',
        roomId: room.id,
        egressStatus: apply.summary.status,
        jobs: apply.summary.jobs,
      },
    });
  }

  /**
   * `POST /v1/admin/routes/:id/test`: diagnostic evaluation. `apply:false` is a
   * dry run (nothing is created or started); the default starts egress from the
   * room, exactly like a live trigger. The response is secret-free.
   */
  async testRoute(tenantId: string, routeId: string, input: RoutingTestRequest, context: { ip?: string } = {}): Promise<RoutingTestResponse> {
    const route = this.store.getRule(tenantId, routeId);
    if (!route) throw new HttpError(404, 'not_found', 'Route not found');
    const parsed = routingTestRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new HttpError(400, 'validation_failed', zodErrorMessage(parsed.error), parsed.error.issues);
    }
    const requested = parsed.data;
    const edgeId = requested.edgeId ?? route.source.edgeId;
    const roomId = requested.roomId ?? route.source.roomId;
    const tag = requested.tag ?? route.source.tag;
    const identity: RoutingSourceIdentity =
      route.source.type === 'edge'
        ? { type: 'edge', ...(edgeId ? { edgeId } : {}), ...(tag ? { tag } : {}) }
        : {
            type: route.source.type,
            ...(roomId ? { roomId } : {}),
            ...(tag ? { tag } : {}),
          };
    const base = {
      routeId: route.id,
      source: route.source,
      sourceIdentity: identity,
      limitations: [...ROUTING_LIMITATIONS],
    };
    if (!route.enabled) {
      return {
        ...base,
        matched: false,
        disabled: true,
        applied: false,
        destinations: [],
        egress: { status: 'skipped', jobs: 0, destinations: 0, errors: [] },
        errors: ['route is disabled'],
      };
    }
    const selected = selectRoutingRule(this.store.listRules(tenantId), identity);
    const shadowedBy = selected && selected.id !== route.id ? selected.id : undefined;
    if (!matchesRoutingSource(route.source, identity)) {
      return {
        ...base,
        matched: false,
        disabled: false,
        applied: false,
        destinations: [],
        egress: { status: 'skipped', jobs: 0, destinations: 0, errors: [] },
        errors: ['route source does not match the supplied identity'],
      };
    }
    if (shadowedBy) {
      return {
        ...base,
        matched: false,
        disabled: false,
        shadowedBy,
        applied: false,
        destinations: [],
        egress: { status: 'skipped', jobs: 0, destinations: 0, errors: [] },
        errors: [`route is shadowed by higher-priority route ${shadowedBy}`],
      };
    }
    const roomPlan = this.resolveRoomPlan(route, identity, route.source.type === 'edge');
    const apply = requested.apply ?? true;
    if (!apply) {
      const destinations = this.plannedDestinations(route, roomPlan);
      this.audit({
        type: 'route.tested',
        severity: 'info',
        tenantId,
        ip: context.ip,
        message: `Route tested (dry run): ${route.id}`,
        details: { kind: 'route.tested', routeId: route.id, applied: false, roomId: roomPlan.roomId },
      });
      return {
        ...base,
        matched: true,
        disabled: false,
        applied: false,
        roomId: roomPlan.roomId,
        roomCreated: false,
        destinations,
        egress: { status: 'skipped', jobs: 0, destinations: destinations.length, errors: [] },
        errors: [],
      };
    }
    let room: Room;
    let created = false;
    if (route.source.type === 'room' || route.source.type === 'participant') {
      const existing = this.rooms.get(roomPlan.roomId);
      if (!existing) throw new HttpError(404, 'not_found', 'Room not found');
      if (existing.tenantId !== tenantId) throw new HttpError(403, 'forbidden', 'API key does not belong to this tenant');
      room = existing;
    } else {
      const ensured = this.ensureRoom(tenantId, roomPlan.roomId, { create: true, name: route.name ?? 'Route test' });
      room = ensured.room;
      created = ensured.created;
    }
    const result = await this.applyRule(route, room, 'route_test');
    this.recordRun(route, 'route_test', room.id, result);
    this.audit({
      type: 'route.tested',
      severity: 'info',
      tenantId,
      ip: context.ip,
      message: `Route tested: ${route.id} → room ${room.id} (egress: ${result.summary.status})`,
      details: {
        kind: 'route.tested',
        routeId: route.id,
        applied: true,
        roomId: room.id,
        egressStatus: result.summary.status,
        jobs: result.summary.jobs,
      },
    });
    return {
      ...base,
      matched: true,
      disabled: false,
      applied: true,
      roomId: room.id,
      roomCreated: created,
      destinations: result.destinations,
      egress: result.summary,
      errors: result.errors,
    };
  }

  /* --------------------------- Internals ------------------------------ */

  private audit(entry: Omit<AuditEntry, 'id' | 'ts'> & { ip?: string }): void {
    try {
      this.auditSink(entry);
    } catch {
      /* routing audit is best-effort */
    }
  }

  private edgeJoinTokenTtlSec(): number {
    return Math.max(300, Math.min(MAX_JOIN_TOKEN_TTL_SEC, this.env.tokenTtlSec));
  }

  /** Validates a candidate rule with the schema + endpoint policy. */
  private assertRule(candidate: RoutingRule): RoutingRule {
    const parsed = routingRuleSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new HttpError(400, 'validation_failed', zodErrorMessage(parsed.error), parsed.error.issues);
    }
    const issues = validateRoutingRuleEndpoints(parsed.data, { secure: isSecureMode(this.env) });
    if (issues.length > 0) {
      throw new HttpError(400, 'validation_failed', 'Invalid routing destination', issues);
    }
    return parsed.data;
  }

  /**
   * Validates an Edge enrollment token without consuming a use, so a join that
   * fails on `no_route` or a room conflict does not burn a one-time token.
   */
  private validateEdgeToken(raw: string): StoredEdgeToken {
    const token = this.store.findEdgeToken(raw);
    if (!token) throw new HttpError(401, 'unauthorized', 'Invalid edge enrollment token');
    const status = edgeTokenStatus(token, this.now());
    if (status === 'revoked') throw new HttpError(401, 'unauthorized', 'Edge enrollment token was revoked');
    if (status === 'expired') throw new HttpError(401, 'unauthorized', 'Edge enrollment token expired');
    if (status === 'used') throw new HttpError(401, 'unauthorized', 'Edge enrollment token has already been used');
    return token;
  }

  /**
   * Consumes one use. Called after every scope/room check passed and before the
   * join token is issued; re-checks the status so two concurrent joins with the
   * same one-time token cannot both succeed.
   */
  private consumeEdgeToken(token: StoredEdgeToken): void {
    const status = edgeTokenStatus(token, this.now());
    if (status !== 'active') {
      throw new HttpError(401, 'unauthorized', status === 'used' ? 'Edge enrollment token has already been used' : 'Edge enrollment token is not active');
    }
    token.used += 1;
    token.lastUsedAt = this.now();
    this.store.updateEdgeToken(token);
  }

  private templateVars(rule: RoutingRule, identity: RoutingSourceIdentity): Record<string, string> {
    const sourceId = identity.edgeId ?? identity.roomId ?? '';
    return {
      tenantId: rule.tenantId,
      routeId: rule.id,
      edgeId: identity.edgeId ?? '',
      roomId: identity.roomId ?? '',
      tag: identity.tag ?? '',
      sourceId,
      participantId: identity.type === 'participant' && identity.tag ? identity.tag : '',
    };
  }

  /**
   * Resolves the single room a rule publishes into: the first (and only) room
   * destination, or — for an Edge source — an implicit `edge-<edgeId>` room so
   * an Edge→stream-only rule still has one publish target.
   */
  private resolveRoomPlan(rule: RoutingRule, identity: RoutingSourceIdentity, allowImplicitEdgeRoom: boolean): RoomPlan {
    const index = rule.destinations.findIndex((destination) => destination.type === 'room');
    if (index >= 0) {
      const destination = rule.destinations[index] as RoutingDestination;
      const raw = destination.roomId ?? (destination.template ? expandRoutingTemplate(destination.template, this.templateVars(rule, identity)) : '');
      if (!isValidRoomId(raw)) {
        throw new HttpError(400, 'validation_failed', `Routing rule ${rule.id} produced an invalid room id`, [
          { path: `destinations.${index}.roomId`, message: 'expanded room id is not a valid room id' },
        ]);
      }
      return {
        roomId: raw,
        role: destination.role ?? ROUTING_DEFAULTS.roomRole,
        publish: destination.publish && destination.publish.length > 0 ? [...destination.publish] : [...ROUTING_DEFAULTS.publish],
        roomDestinationIndex: index,
      };
    }
    if (!allowImplicitEdgeRoom || identity.type !== 'edge' || !identity.edgeId) {
      // A room/participant source derives egress from the source room itself when
      // the rule has no explicit room destination (room→stream-only rule).
      if ((identity.type === 'room' || identity.type === 'participant') && identity.roomId) {
        return {
          roomId: identity.roomId,
          role: ROUTING_DEFAULTS.roomRole,
          publish: [...ROUTING_DEFAULTS.publish],
          roomDestinationIndex: -1,
        };
      }
      throw new HttpError(400, 'validation_failed', 'Route has no room destination to publish into');
    }
    return {
      roomId: implicitEdgeRoomId(identity.edgeId),
      role: ROUTING_DEFAULTS.roomRole,
      publish: [...ROUTING_DEFAULTS.publish],
      roomDestinationIndex: -1,
    };
  }

  /** Finds or creates the routed room; never crosses a tenant boundary. */
  private ensureRoom(
    tenantId: string,
    roomId: string,
    options: { create: boolean; name?: string },
  ): { room: Room; created: boolean } {
    const existing = this.rooms.get(roomId);
    if (existing) {
      if (existing.tenantId !== tenantId) {
        // Room ids are global in the in-memory registry; do not confirm which
        // tenant owns the collision.
        throw new HttpError(409, 'room_conflict', `Room ${roomId} is already in use`);
      }
      return { room: existing, created: false };
    }
    if (!options.create) throw new HttpError(404, 'not_found', 'Room not found');
    const config = this.tenants.getConfig(tenantId);
    const mediaMode = roomMediaMode(config.scale, 'group');
    const requestedMax = config.limits.maxParticipants;
    const maxParticipants = capRoomParticipantsForSfu(this.env, config, mediaMode, Math.max(2, requestedMax));
    try {
      const room = this.rooms.create({
        id: roomId,
        tenantId,
        name: (options.name ?? 'Edge room').slice(0, 120),
        maxParticipants,
        ttlSec: this.env.roomTtlSec,
        mediaMode,
      });
      return { room, created: true };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'room_exists') {
        const raced = this.rooms.get(roomId);
        if (raced && raced.tenantId === tenantId) return { room: raced, created: false };
        throw new HttpError(409, 'room_conflict', `Room ${roomId} is already in use`);
      }
      if (code === 'invalid_room_id') {
        throw new HttpError(400, 'validation_failed', `Invalid routed room id: ${roomId}`);
      }
      throw error;
    }
  }

  /** Secret-free destination list for a dry run. */
  private plannedDestinations(rule: RoutingRule, roomPlan: RoomPlan): RoutingEffectiveDestination[] {
    return rule.destinations.map((destination, index) => {
      if (destination.type === 'room') {
        return {
          index,
          type: 'room' as const,
          roomId: roomPlan.roomId,
          role: destination.role ?? ROUTING_DEFAULTS.roomRole,
          publish: destination.publish && destination.publish.length > 0 ? [...destination.publish] : [...ROUTING_DEFAULTS.publish],
          status: 'skipped' as const,
        };
      }
      const view = routingDestinationView(destination);
      if (view.type !== 'stream') return { index, type: 'stream' as const, status: 'skipped' as const };
      return {
        index,
        type: 'stream' as const,
        provider: view.provider,
        layout: view.layout,
        latency: view.latency,
        ...(view.urlHost ? { urlHost: view.urlHost } : {}),
        ...(view.secretRef ? { secretRef: view.secretRef } : {}),
        hasSecret: view.hasSecret,
        status: 'skipped' as const,
      };
    });
  }

  /**
   * Starts (idempotently) every egress job derived from a routed room and
   * returns the effective destinations plus the sanitized run outcome.
   */
  private async applyRule(rule: RoutingRule, room: Room, trigger: 'edge_join' | 'room_start' | 'route_test'): Promise<ApplyResult> {
    const destinationErrors = new Map<number, string>();
    const planned = this.planJobs(rule, destinationErrors);
    const states = new Map<number, JobState>();
    const jobResults = await Promise.all(
      planned.map(async (job) => {
        const key = this.egressKey(rule.tenantId, room, job);
        const state = await this.ensureEgress(key, job, rule, room);
        for (const index of job.indexes) states.set(index, state);
        return { job, state };
      }),
    );

    const roomDestinationIndex = rule.destinations.findIndex((destination) => destination.type === 'room');
    const destinations: RoutingEffectiveDestination[] = [];
    const runJobs: RoutingRunJob[] = [];
    if (roomDestinationIndex >= 0) {
      const destination = rule.destinations[roomDestinationIndex] as RoutingDestination;
      destinations.push({
        index: roomDestinationIndex,
        type: 'room',
        roomId: room.id,
        role: destination.role ?? ROUTING_DEFAULTS.roomRole,
        publish: destination.publish && destination.publish.length > 0 ? [...destination.publish] : [...ROUTING_DEFAULTS.publish],
        status: 'ready',
      });
      runJobs.push({ kind: 'room', status: 'ready', index: roomDestinationIndex });
    }
    for (const [index, destination] of rule.destinations.entries()) {
      if (destination.type === 'room') continue;
      const view = routingDestinationView(destination);
      if (view.type !== 'stream') continue;
      const state = states.get(index);
      const error = state?.error ?? destinationErrors.get(index);
      const status: RoutingStatus = state?.status ?? (destinationErrors.has(index) ? 'unavailable' : 'skipped');
      destinations.push({
        index,
        type: 'stream',
        provider: view.provider,
        layout: view.layout,
        latency: view.latency,
        ...(view.urlHost ? { urlHost: view.urlHost } : {}),
        ...(view.secretRef ? { secretRef: view.secretRef } : {}),
        hasSecret: view.hasSecret,
        status,
        ...(state?.egressId ? { egressId: state.egressId } : {}),
        ...(error ? { error: sanitizeEgressErrorText(error) } : {}),
      });
      runJobs.push({
        kind: view.provider,
        status,
        index,
        ...(state?.egressId ? { egressId: state.egressId } : {}),
        ...(error ? { error: sanitizeEgressErrorText(error) } : {}),
      });
    }
    // Recording has no participant-visible destination; it is reported as a run
    // job and in the summary only.
    for (const result of jobResults) {
      if (result.job.kind !== 'recording') continue;
      runJobs.push({
        kind: 'recording',
        status: result.state.status,
        ...(result.state.egressId ? { egressId: result.state.egressId } : {}),
        ...(result.state.error ? { error: sanitizeEgressErrorText(result.state.error) } : {}),
      });
    }
    const statuses = destinations
      .filter((destination) => destination.type === 'stream')
      .map((destination) => destination.status);
    for (const result of jobResults) {
      if (result.job.kind === 'recording') statuses.push(result.state.status);
    }
    const status = aggregateRunStatus(statuses);
    const errors = uniqMessages([
      ...destinationErrors.values(),
      ...jobResults.map((result) => result.state.error ?? ''),
    ]);
    const summary: RoutingEgressSummary = {
      status,
      ...(status === 'unavailable'
        ? { code: 'egress_unavailable' as const }
        : status === 'failed'
          ? { code: 'egress_failed' as const }
          : status === 'partial'
            ? { code: 'partial_failure' as const }
            : {}),
      jobs: jobResults.filter((result) => result.job.kind !== 'recording').length,
      destinations: destinations.length,
      errors,
      ...(errors[0] ? { error: errors[0] } : {}),
    };
    const auditMessage = `Routing ${trigger} on room ${room.id}: ${status}`;
    if (status === 'failed' || status === 'unavailable' || status === 'partial') {
      this.audit({
        type: 'route.egress.failed',
        severity: 'warn',
        tenantId: rule.tenantId,
        roomId: room.id,
        message: `${auditMessage}${errors.length > 0 ? ` (${errors[0]})` : ''}`,
        details: {
          kind: 'route.egress.failed',
          routeId: rule.id,
          trigger,
          roomId: room.id,
          status,
          jobs: summary.jobs,
          errors: errors.slice(0, 3),
        },
      });
    } else if (status === 'started' || status === 'pending') {
      this.audit({
        type: 'route.egress.started',
        severity: 'info',
        tenantId: rule.tenantId,
        roomId: room.id,
        message: `${auditMessage} (${summary.jobs} job(s))`,
        details: {
          kind: 'route.egress.started',
          routeId: rule.id,
          trigger,
          roomId: room.id,
          status,
          jobs: summary.jobs,
          egressIds: jobResults.map((result) => result.state.egressId).filter((id): id is string => Boolean(id)),
        },
      });
    }
    return { destinations, summary, errors, jobs: runJobs };
  }

  /**
   * Builds egress jobs from a rule: RTMP destinations are grouped by layout (one
   * composite job with several stream outputs = one encode), HLS/recording get
   * one job each. A missing route secret is a destination-level error, never a
   * thrown request failure.
   */
  private planJobs(rule: RoutingRule, destinationErrors: Map<number, string>): PlannedJob[] {
    const jobs: PlannedJob[] = [];
    const findJob = (kind: PlannedJob['kind'], layout: EgressLayout): PlannedJob | undefined =>
      jobs.find((job) => job.kind === kind && job.layout === layout);
    for (const [index, destination] of rule.destinations.entries()) {
      if (destination.type !== 'stream') continue;
      const layout = (destination.layout ?? ROUTING_DEFAULTS.layout) as EgressLayout;
      if (destination.provider === 'hls') {
        const job = findJob('hls', layout) ?? { kind: 'hls', layout, audioOnly: false, urls: [], indexes: [] };
        if (!jobs.includes(job)) jobs.push(job);
        job.indexes.push(index);
        continue;
      }
      let url = destination.url;
      let fromSecret = false;
      if (!url && destination.secretRef) {
        const secret = resolveTenantSecret(this.env, destination.secretRef, 'route');
        if (!secret.allowed) {
          destinationErrors.set(index, 'route secret reference is not allowed');
          continue;
        }
        if (!secret.value) {
          destinationErrors.set(index, `route secret ${destination.secretRef} is not set`);
          continue;
        }
        url = secret.value;
        fromSecret = true;
      }
      if (!url) {
        destinationErrors.set(index, 'rtmp destination has no url');
        continue;
      }
      // Re-check at start time as defence in depth (the policy may have tightened
      // since the rule was written, and the file could be hand-edited).
      const check = validateNetworkEndpoint(url, {
        secure: isSecureMode(this.env),
        schemes: ['rtmp:', 'rtmps:'],
        applyHostPolicy: true,
      });
      if (!check.ok) {
        destinationErrors.set(
          index,
          fromSecret ? `resolved route secret is not a valid RTMP URL: ${check.reason}` : `rtmp URL is not allowed: ${check.reason}`,
        );
        continue;
      }
      const job = findJob('rtmp', layout) ?? { kind: 'rtmp', layout, audioOnly: false, urls: [], indexes: [] };
      if (!jobs.includes(job)) jobs.push(job);
      job.urls.push(url);
      job.indexes.push(index);
    }
    if (rule.recording?.enabled) {
      jobs.push({
        kind: 'recording',
        layout: (rule.recording.layout ?? ROUTING_DEFAULTS.layout) as EgressLayout,
        audioOnly: Boolean(rule.recording.audioOnly),
        urls: [],
        indexes: [],
      });
    }
    return jobs;
  }

  private egressKey(tenantId: string, room: Room, job: PlannedJob): string {
    const signature = createHash('sha256')
      .update([...job.urls].sort().join('\n'))
      .digest('hex')
      .slice(0, 16);
    return `${tenantId}:${room.id}:${job.kind}:${job.layout}:${signature}`;
  }

  /**
   * Idempotent egress start. A started/pending job is reused; a failure is
   * cached for {@link EGRESS_FAILURE_RETRY_MS} and then retried. Concurrent
   * evaluations share one in-flight promise, so a room join storm cannot start
   * duplicate jobs.
   */
  private ensureEgress(key: string, job: PlannedJob, rule: RoutingRule, room: Room): Promise<JobState> {
    const cached = this.egressJobs.get(key);
    if (cached && (cached.status === 'started' || cached.status === 'pending')) return Promise.resolve(cached);
    if (cached && this.now() - cached.at < EGRESS_FAILURE_RETRY_MS) return Promise.resolve(cached);
    const inflight = this.egressInflight.get(key);
    if (inflight) return inflight;
    const promise = (async (): Promise<JobState> => {
      try {
        let result: EgressStartResult;
        if (job.kind === 'rtmp') {
          result = await this.egress.start({
            roomName: sfuRoomName(room.tenantId, room.id),
            kind: 'rtmp',
            layout: job.layout,
            rtmpUrl: job.urls[0],
            rtmpUrls: job.urls,
            tenantId: room.tenantId,
            roomId: room.id,
          });
        } else if (job.kind === 'hls') {
          result = await this.egress.start({
            roomName: sfuRoomName(room.tenantId, room.id),
            kind: 'hls',
            layout: job.layout,
            tenantId: room.tenantId,
            roomId: room.id,
          });
        } else {
          result = await this.egress.start({
            roomName: sfuRoomName(room.tenantId, room.id),
            kind: 'recording',
            layout: job.layout,
            audioOnly: job.audioOnly,
            tenantId: room.tenantId,
            roomId: room.id,
          });
        }
        const state: JobState = {
          status: /START/i.test(result.status) ? 'pending' : 'started',
          egressId: result.egressId,
          at: this.now(),
        };
        this.storeEgressState(key, state);
        return state;
      } catch (error) {
        const code = (error as { code?: string }).code;
        const status: RoutingStatus = isEgressUnavailableCode(code) ? 'unavailable' : 'failed';
        const state: JobState = {
          status,
          error: sanitizeEgressErrorText(error instanceof Error ? error.message : String(error)),
          at: this.now(),
        };
        this.storeEgressState(key, state);
        this.logger.warn('routing egress start failed', {
          routeId: rule.id,
          roomId: room.id,
          kind: job.kind,
          status,
          error: state.error,
        });
        return state;
      } finally {
        this.egressInflight.delete(key);
      }
    })();
    this.egressInflight.set(key, promise);
    return promise;
  }

  private storeEgressState(key: string, state: JobState): void {
    this.egressJobs.set(key, state);
    if (this.egressJobs.size <= MAX_TRACKED_EGRESS_JOBS) return;
    const oldest = this.egressJobs.keys().next();
    if (!oldest.done) this.egressJobs.delete(oldest.value);
  }

  private recordRun(rule: RoutingRule, trigger: RoutingRunRecord['trigger'], roomId: string, apply: ApplyResult): void {
    const run: RoutingRunRecord = {
      at: this.now(),
      trigger,
      status: apply.summary.status,
      roomId,
      jobs: apply.jobs,
      ...(apply.errors.length > 0 ? { error: apply.errors.join('; ').slice(0, 300) } : {}),
    };
    try {
      this.store.recordRun(rule.tenantId, rule.id, run);
    } catch (error) {
      this.logger.warn('routing run record failed', {
        routeId: rule.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function describeRule(rule: RoutingRule): string {
  const source = rule.source.type === 'edge'
    ? `edge${rule.source.edgeId ? `:${rule.source.edgeId}` : ''}${rule.source.tag ? `/${rule.source.tag}` : ''}`
    : `${rule.source.type}:${rule.source.roomId ?? rule.source.tag ?? '?'}`;
  const parts: string[] = [];
  const room = rule.destinations.find((destination) => destination.type === 'room');
  if (room) parts.push(room.roomId ? `room ${room.roomId}` : `room ${room.template ?? '?'}`);
  for (const destination of rule.destinations) {
    if (destination.type !== 'stream') continue;
    parts.push(`${destination.provider ?? 'rtmp'}${destination.url ? ` ${routingUrlHost(destination.url)}` : ''}`);
  }
  if (rule.recording?.enabled) parts.push('recording');
  return `${source} → ${parts.join(' + ') || 'nothing'}`;
}

/** Audit-safe destination summary: type/provider/layout only, never URLs/keys. */
function destinationSummary(rule: RoutingRule): Array<Record<string, unknown>> {
  return rule.destinations.map((destination) => {
    if (destination.type === 'room') {
      return { type: 'room', ...(destination.roomId ? { roomId: destination.roomId } : {}), ...(destination.template ? { template: destination.template } : {}) };
    }
    return {
      type: 'stream',
      provider: destination.provider,
      layout: destination.layout ?? ROUTING_DEFAULTS.layout,
      ...(destination.secretRef ? { secretRef: destination.secretRef } : {}),
    };
  });
}
