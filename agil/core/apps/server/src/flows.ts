/**
 * Generic media flow routing (`docs/flows.md`): tenant-scoped flow storage, the
 * evaluator that turns a flow into egress/webhook work, and the live triggers
 * (manual test, room start, edge online, schedule).
 *
 * Execution is honest about the platform:
 *  - a **supported** source/sink/processor runs on the existing LiveKit egress
 *    client (RTMP/HLS/MP4, composite layouts, native audio mix) or the webhook
 *    dispatcher (signed JSON POST);
 *  - a **pending** adapter (ingest, file, sip, srt, cdn, room→another-room,
 *    transcode, WEBM) is validated and stored but never started. The evaluator
 *    reports `pending` + the reason and starts nothing that would misrepresent
 *    the configured media path.
 *
 * Idempotency, tenant isolation, secret redaction and the SSRF policy mirror
 * the routing baseline (`routing.ts`): jobs are deduplicated per process, the
 * stored URL/stream key never reaches a response/audit entry, and every stored
 * endpoint is re-checked at start time.
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  FLOW_DEFAULTS,
  FLOW_LIMITATIONS,
  FLOW_MAX_FLOWS_PER_TENANT,
  FLOW_MAX_URL_LENGTH,
  FLOW_CROSS_ROOM_MIX_REASON,
  FLOW_EDGE_OFFLINE_REASON,
  FLOW_PROCESSOR_ADAPTERS,
  FLOW_ROOM_FORWARD_REASON,
  FLOW_SOURCE_ADAPTERS,
  FLOW_SINK_ADAPTERS,
  FLOW_TRIGGER_ADAPTERS,
  expandFlowTemplate,
  flowCreateSchema,
  flowFallbackChain,
  flowPatchSchema,
  flowSchema,
  flowSinkView,
  flowTestRequestSchema,
  flowView,
  isFlowScheduleDue,
  managedRtmpRoom,
  managedPullSource,
  type ManagedPullTransport,
  mergeFlow,
  nextFlowRunAt,
  normalizeFlow,
  planFlowExecution,
  selectFlow,
  validateFlowFallback,
  type AuditEntry,
  type Flow,
  type FlowCreate,
  type FlowEdgeJoinResult,
  type FlowEffectiveSink,
  type FlowExecutionChannel,
  type FlowMixerState,
  type FlowPatch,
  type FlowRunJob,
  type FlowRunPending,
  type FlowRunRecord,
  type FlowRunStatus,
  type FlowRunSummary,
  type FlowSink,
  type FlowSinkKind,
  type FlowSource,
  type FlowSourceIdentity,
  type FlowStatus,
  type FlowTestRequest,
  type FlowTestResponse,
  type FlowTickResponse,
  type FlowTriggerKind,
  type FlowView,
  type FlowWebhookEvent,
  type RoutingEffectiveDestination,
  type RoutingEgressSummary,
  type RoutingLayout,
  type RoutingStatus,
} from '@agil/protocol';
import { issueToken } from './auth.js';
import { isEgressUnavailableCode, type EgressClient, type EgressLayout, type EgressStartResult } from './egress.js';
import { sanitizeEgressErrorText } from './error-text.js';
import type { Env } from './env.js';
import type { FlowStore } from './flow-store.js';
import { HttpError, zodErrorMessage } from './http.js';
import type { RtmpIngressLifecycle, PullIngressLifecycle } from './ingress-lifecycle.js';
import { ingressControlConfigured } from './ingress.js';
import type { PullIngressSource } from './ingress-sources.js';
import type { LeadershipGate } from './leader.js';
import type { Logger } from './logger.js';
import { isValidRoomId, type Room, type RoomLifecycleEvent, type RoomRegistry } from './rooms.js';
import { roomMediaMode } from './scale.js';
import { resolveTenantSecret } from './secret-env.js';
import { capRoomParticipantsForSfu, sfuRoomName } from './sfu.js';
import type { TenantStore } from './tenants.js';
import { implicitEdgeRoomId } from './routing.js';
import { isSecureMode, validateNetworkEndpoint } from './url-policy.js';

const EGRESS_FAILURE_RETRY_MS = 15_000;
const ACTIVE_EGRESS_STATUS = /^(?:(?:EGRESS_)?ACTIVE|1)$/i;
const TERMINAL_EGRESS_STATUS = /^(?:(?:EGRESS_)?(?:COMPLETE|FAILED|ABORTED|LIMIT_REACHED)|[3-6])$/i;
const MAX_TRACKED_EGRESS_JOBS = 2_000;
const MAX_JOIN_TOKEN_TTL_SEC = 24 * 3600;
const WEBHOOK_TIMEOUT_MS = 5_000;

export interface FlowEndpointIssue {
  path: string;
  message: string;
}

/**
 * SSRF/secret policy for every stored flow endpoint. Pending adapters are
 * validated too (host policy only, no TLS requirement): the URL is stored for a
 * future adapter, so it must not point at a private/metadata host. Supported
 * endpoints get the full policy and are re-checked at start time.
 */
export function validateFlowEndpoints(flow: Flow, options: { secure: boolean }): FlowEndpointIssue[] {
  const issues: FlowEndpointIssue[] = [];
  const check = (
    issuePath: string,
    raw: string | undefined,
    schemes: readonly string[],
    applyHostPolicy: boolean,
    secure = options.secure,
  ): void => {
    if (!raw) return;
    if (raw.length > FLOW_MAX_URL_LENGTH) {
      issues.push({ path: issuePath, message: 'URL is too long' });
      return;
    }
    const result = validateNetworkEndpoint(raw, { secure, schemes, applyHostPolicy });
    if (!result.ok) issues.push({ path: issuePath, message: result.reason });
  };
  flow.sources.forEach((source, index) => {
    if (source.secretRef) return; // the resolved value is validated at start
    const issuePath = `sources.${index}.url`;
    switch (source.kind) {
      case 'rtmp_ingest':
        check(issuePath, source.url, ['rtmp:', 'rtmps:'], true);
        return;
      case 'srt_ingest':
        check(issuePath, source.url, ['srt:'], true, false);
        return;
      case 'hls_ingest':
      case 'file':
        check(issuePath, source.url, ['https:', 'http:'], true);
        return;
      default:
        return;
    }
  });
  flow.sinks.forEach((sink, index) => {
    if (sink.secretRef) return;
    const issuePath = `sinks.${index}.url`;
    switch (sink.kind) {
      case 'rtmp':
        check(issuePath, sink.url, ['rtmp:', 'rtmps:'], true);
        return;
      case 'srt':
        check(issuePath, sink.url, ['srt:'], true, false);
        return;
      case 'webhook':
        check(issuePath, sink.url, ['https:', 'http:'], true);
        return;
      default:
        return;
    }
  });
  return issues;
}

/* ------------------------------------------------------------------ */
/* Evaluation internals                                                */
/* ------------------------------------------------------------------ */

interface PlannedEgressJob {
  kind: 'rtmp' | 'hls' | 'recording';
  layout: EgressLayout;
  audioOnly: boolean;
  urls: string[];
  indexes: number[];
}

interface EgressJobState {
  status: RoutingStatus;
  egressId?: string;
  error?: string;
  at: number;
}

interface RoomTarget {
  roomId?: string;
  roomSink?: FlowSink;
  roomSinkIndex: number;
  implicitFromEdge: boolean;
  error?: string;
}

interface EvaluateContext {
  trigger: FlowTriggerKind;
  identity: FlowSourceIdentity;
  /** Room supplied by a live trigger or an explicit test override. */
  roomId?: string;
  /** Create the target room when it does not exist (edge/manual). */
  createRoom?: boolean;
  /** `false` = dry run: resolve and report, start/notify nothing. */
  apply: boolean;
  ip?: string;
}

interface EvaluateResult {
  roomId?: string;
  roomCreated: boolean;
  mixer: FlowMixerState;
  sinks: FlowEffectiveSink[];
  summary: FlowRunSummary;
  jobs: FlowRunJob[];
  errors: string[];
  pending: FlowRunPending[];
}

/** Mapping from a flow sink kind to the run-job vocabulary. */
const SINK_JOB_KIND: Record<FlowSinkKind, FlowRunJob['kind']> = {
  room: 'room',
  rtmp: 'rtmp',
  hls: 'hls',
  srt: 'srt',
  recording: 'recording',
  cdn: 'cdn',
  webhook: 'webhook',
};

const SINK_EXECUTION: Record<FlowSinkKind, FlowExecutionChannel> = {
  room: 'egress',
  rtmp: 'egress',
  hls: 'egress',
  srt: 'none',
  recording: 'egress',
  cdn: 'none',
  webhook: 'webhook',
};

function uniqStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const normalized = sanitizeEgressErrorText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.slice(0, 6);
}

function uniqPending(pending: FlowRunPending[]): FlowRunPending[] {
  const seen = new Set<string>();
  const out: FlowRunPending[] = [];
  for (const entry of pending) {
    const key = `${entry.path}|${entry.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...entry, reason: sanitizeEgressErrorText(entry.reason).slice(0, 300) });
  }
  return out;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function aggregateFlowStatus(sinks: FlowEffectiveSink[]): { status: FlowRunStatus; code?: FlowRunSummary['code'] } {
  const statuses = sinks.map((sink) => sink.status);
  const active = statuses.filter((status) => status !== 'skipped');
  if (active.length === 0) return { status: 'skipped' };
  const failing = active.filter((status) => status === 'failed' || status === 'unavailable');
  const good = active.filter((status) => status === 'started' || status === 'ready');
  const adapterPending = sinks.some((sink) => sink.status === 'pending' && Boolean(sink.pendingReason));
  const egressPending = sinks.some((sink) => sink.status === 'pending' && !sink.pendingReason);
  if (failing.length === 0) {
    if (egressPending) return { status: 'pending' };
    if (adapterPending) {
      // A pending branch alongside a running one is a partial delivery, not a
      // run that started nothing.
      return good.length > 0
        ? { status: 'partial', code: 'adapter_pending' }
        : { status: 'pending', code: 'adapter_pending' };
    }
    return { status: 'started' };
  }
  if (good.length === 0 && !egressPending) {
    return {
      status: failing.every((status) => status === 'unavailable') ? 'unavailable' : 'failed',
      code: failing.every((status) => status === 'unavailable') ? 'egress_unavailable' : 'egress_failed',
    };
  }
  return { status: 'partial', code: 'partial_failure' };
}

/** Room id template variables for one flow evaluation. */
function templateVars(flow: Flow, identity: FlowSourceIdentity): Record<string, string> {
  const sourceId = identity.edgeId ?? identity.roomId ?? '';
  return {
    tenantId: flow.tenantId,
    routeId: flow.id,
    flowId: flow.id,
    edgeId: identity.edgeId ?? '',
    roomId: identity.roomId ?? '',
    tag: identity.tag ?? '',
    sourceId,
    participantId: identity.participantId ?? (identity.type === 'participant' && identity.tag ? identity.tag : ''),
  };
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export type FlowAuditSink = (entry: Omit<AuditEntry, 'id' | 'ts'> & { ip?: string }) => void;

export interface FlowServiceOptions {
  env: Env;
  logger: Logger;
  store: FlowStore;
  tenants: TenantStore;
  rooms: RoomRegistry;
  egress: EgressClient;
  audit: FlowAuditSink;
  now?: () => number;
  leadership?: () => Pick<LeadershipGate, 'assertLeader'> | null;
  managedRtmp?: () => RtmpIngressLifecycle | undefined;
  managedPull?: (transport: ManagedPullTransport) => PullIngressLifecycle | undefined;
}

export class FlowService {
  private readonly env: Env;
  private readonly logger: Logger;
  private readonly store: FlowStore;
  private readonly tenants: TenantStore;
  private readonly rooms: RoomRegistry;
  private readonly egress: EgressClient;
  private readonly auditSink: FlowAuditSink;
  private readonly now: () => number;
  private readonly leadership?: FlowServiceOptions['leadership'];
  private readonly managedRtmp?: FlowServiceOptions['managedRtmp'];
  private readonly managedPull?: FlowServiceOptions['managedPull'];
  private leadershipEpoch = 0;
  private readonly mutations = new Map<string, Promise<void>>();
  /** Terminal job cache: `${tenant}:${room}:${kind}:${layout}:${audioOnly}:${urlHash}`. */
  private readonly egressJobs = new Map<string, EgressJobState>();
  private readonly egressInflight = new Map<string, Promise<EgressJobState>>();

  constructor(options: FlowServiceOptions) {
    this.env = options.env;
    this.logger = options.logger;
    this.store = options.store;
    this.tenants = options.tenants;
    this.rooms = options.rooms;
    this.egress = options.egress;
    this.auditSink = options.audit;
    this.now = options.now ?? Date.now;
    this.leadership = options.leadership;
    this.managedRtmp = options.managedRtmp;
    this.managedPull = options.managedPull;
  }

  onLeadershipChanged(): void {
    this.leadershipEpoch += 1;
    this.store.clearCache();
  }

  private mutationEpoch(): number {
    this.leadership?.()?.assertLeader('flow mutations');
    return this.leadershipEpoch;
  }

  private assertMutationEpoch(epoch: number): void {
    if (this.mutationEpoch() !== epoch) {
      throw new HttpError(409, 'not_leader', 'Core leadership changed during the flow operation');
    }
  }

  // Fallback relationships are tenant-wide. Read and validate inside the queue
  // so concurrent edits see the outcome of the previous mutation.
  private async mutate<T>(tenantId: string, apply: (guard: () => void) => Promise<T>): Promise<T> {
    const epoch = this.mutationEpoch();
    const guard = (): void => this.assertMutationEpoch(epoch);
    const previous = this.mutations.get(tenantId) ?? Promise.resolve();
    const pending = previous.then(() => {
      guard();
      return apply(guard);
    });
    const tail = pending.then(() => undefined, () => undefined);
    this.mutations.set(tenantId, tail);
    try {
      return await pending;
    } finally {
      if (this.mutations.get(tenantId) === tail) this.mutations.delete(tenantId);
    }
  }

  /* ------------------------------- admin ------------------------------- */

  async listFlows(tenantId: string): Promise<FlowView[]> {
    return (await this.store.list(tenantId)).map(flowView);
  }

  async getFlow(tenantId: string, flowId: string): Promise<FlowView | null> {
    const flow = (await this.store.list(tenantId)).find((item) => item.id === flowId);
    return flow ? flowView(flow) : null;
  }

  /** Creates a flow; validates schema, adapters, fallback chain and endpoint policy. */
  createFlow(tenantId: string, input: FlowCreate, context: { ip?: string } = {}): Promise<FlowView> {
    return this.mutate(tenantId, (guard) => this.createFlowDefinition(tenantId, input, context, guard));
  }

  private async createFlowDefinition(
    tenantId: string, input: FlowCreate, context: { ip?: string }, guard: () => void,
  ): Promise<FlowView> {
    const parsed = flowCreateSchema.safeParse(input);
    if (!parsed.success) {
      throw new HttpError(400, 'validation_failed', zodErrorMessage(parsed.error), parsed.error.issues);
    }
    const id = parsed.data.id ?? `fl_${randomBytes(8).toString('hex')}`;
    const now = this.now();
    const normalized = normalizeFlow(parsed.data);
    const candidate: Flow = { ...normalized, id, tenantId, createdAt: now, updatedAt: now };
    const rule = this.assertFlow(candidate);
    const managedRoom = managedRtmpRoom(rule.sources);
    if (managedRoom) {
      this.requireManagedRtmp();
      this.managedIngressRoom(tenantId, managedRoom);
    }
    const pull = managedPullSource(rule.sources);
    if (pull) this.validatePullTarget(tenantId, pull);
    await this.store.change(tenantId, guard, (current) => {
      if (current.length >= FLOW_MAX_FLOWS_PER_TENANT) {
        throw new HttpError(409, 'flow_limit', `Flow limit reached (${FLOW_MAX_FLOWS_PER_TENANT} per tenant)`);
      }
      if (current.some((item) => item.id === id)) {
        throw new HttpError(409, 'flow_exists', 'A flow with this id already exists');
      }
      this.assertFallback(rule, current);
      return { value: undefined, flows: [...current, rule] };
    });
    this.audit({
      type: 'flow.created',
      severity: 'info',
      tenantId,
      ip: context.ip,
      message: `Flow created: ${rule.id} (${describeFlow(rule)}, priority ${rule.priority})`,
      details: {
        kind: 'flow.created',
        flowId: rule.id,
        enabled: rule.enabled,
        priority: rule.priority,
        sources: rule.sources.map((source) => source.kind),
        sinks: rule.sinks.map((sink) => sink.kind),
        processors: rule.processors.map((processor) => processor.kind),
        triggers: rule.triggers.map((trigger) => trigger.kind),
        executable: planFlowExecution(rule).executable,
      },
    });
    return flowView(rule);
  }

  /** Deep-partial update; list fields (`sources`/`sinks`/…) replace wholesale. */
  patchFlow(tenantId: string, flowId: string, input: FlowPatch, context: { ip?: string } = {}): Promise<FlowView> {
    return this.mutate(tenantId, (guard) => this.patchFlowDefinition(tenantId, flowId, input, context, guard));
  }

  private async patchFlowDefinition(
    tenantId: string, flowId: string, input: FlowPatch, context: { ip?: string }, guard: () => void,
  ): Promise<FlowView> {
    const parsed = flowPatchSchema.safeParse(input);
    if (!parsed.success) {
      throw new HttpError(400, 'validation_failed', zodErrorMessage(parsed.error), parsed.error.issues);
    }
    if (Object.keys(parsed.data).length === 0) {
      throw new HttpError(400, 'validation_failed', 'Flow patch must contain at least one field');
    }
    const patch = parsed.data;
    const rule = await this.store.change(tenantId, guard, (flows) => {
      const current = flows.find((item) => item.id === flowId);
      if (!current) throw new HttpError(404, 'not_found', 'Flow not found');
      const merged = mergeFlow(current, patch, Math.max(this.now(), current.updatedAt + 1));
      const normalized = normalizeFlow(merged);
      const next = this.assertFlow({ ...merged, ...normalized });
      this.assertFallback(next, flows);
      const oldRoom = managedRtmpRoom(current.sources);
      const newRoom = managedRtmpRoom(next.sources);
      const oldPull = managedPullSource(current.sources);
      const newPull = managedPullSource(next.sources);
      const pullChanged = oldPull?.transport !== newPull?.transport || oldPull?.roomId !== newPull?.roomId
        || oldPull?.sourceId !== newPull?.sourceId;
      if (newRoom && newRoom !== oldRoom) {
        this.requireManagedRtmp();
        this.managedIngressRoom(tenantId, newRoom);
      }
      if (newPull && pullChanged) this.validatePullTarget(tenantId, newPull);
      return {
        value: next,
        flows: flows.map((item) => item.id === flowId ? next : item),
        ...(oldRoom && (!next.enabled || oldRoom !== newRoom)
          ? { beforeCommit: () => this.revokeManagedRtmp(tenantId, flowId) } : {}),
        ...(oldPull && (!next.enabled || pullChanged)
          ? { beforeCommit: () => this.revokeManagedPull(tenantId, flowId, oldPull.transport) } : {}),
      };
    });
    this.audit({
      type: 'flow.updated',
      severity: 'info',
      tenantId,
      ip: context.ip,
      message: `Flow updated: ${rule.id} (${describeFlow(rule)}, priority ${rule.priority})`,
      details: {
        kind: 'flow.updated',
        flowId: rule.id,
        fields: Object.keys(parsed.data).sort(),
        enabled: rule.enabled,
        priority: rule.priority,
        sources: rule.sources.map((source) => source.kind),
        sinks: rule.sinks.map((sink) => sink.kind),
        executable: planFlowExecution(rule).executable,
      },
    });
    return flowView(rule);
  }

  deleteFlow(tenantId: string, flowId: string, context: { ip?: string } = {}): Promise<void> {
    return this.mutate(tenantId, async (guard) => {
      await this.store.change(tenantId, guard, (current) => {
        const flow = current.find((item) => item.id === flowId);
        if (!flow) throw new HttpError(404, 'not_found', 'Flow not found');
        const pull = managedPullSource(flow.sources);
        return {
          value: undefined,
          flows: current.filter((item) => item.id !== flowId),
          ...(managedRtmpRoom(flow.sources) ? { beforeCommit: () => this.revokeManagedRtmp(tenantId, flowId) } : {}),
          ...(pull ? { beforeCommit: () => this.revokeManagedPull(tenantId, flowId, pull.transport) } : {}),
        };
      });
      this.audit({
        type: 'flow.deleted',
        severity: 'warn',
        tenantId,
        ip: context.ip,
        message: `Flow deleted: ${flowId}`,
        details: { kind: 'flow.deleted', flowId },
      });
    });
  }

  createPullIngress(tenantId: string, flowId: string, transport: ManagedPullTransport): Promise<{
    roomId: string; sourceId: string; status: Awaited<ReturnType<PullIngressLifecycle['status']>>;
  }> {
    return this.mutate(tenantId, async (guard) => {
      const target = await this.requireManagedPullFlow(tenantId, flowId, transport);
      guard();
      if (!target.enabled) throw new HttpError(409, 'flow_disabled', 'Enable the flow before provisioning Ingress');
      if (!this.env.sfuUrl || !ingressControlConfigured(this.env)) {
        throw new HttpError(503, `${transport}_ingress_unavailable`, 'Configure the shared LiveKit Ingress control endpoint');
      }
      const { room, binding } = this.validatePullTarget(tenantId, { ...target, transport });
      const lifecycle = this.requireManagedPull(transport);
      await this.withIngress(() => lifecycle.create({ tenantId, flowId }, room, binding), transport);
      guard();
      const status = await this.withIngress(() => lifecycle.status({ tenantId, flowId }), transport);
      guard();
      return { roomId: target.roomId, sourceId: target.sourceId, status };
    });
  }

  getPullIngress(tenantId: string, flowId: string, transport: ManagedPullTransport): Promise<{
    roomId: string; sourceId: string; status: Awaited<ReturnType<PullIngressLifecycle['status']>>;
  }> {
    return this.mutate(tenantId, async (guard) => {
      const { roomId, sourceId } = await this.requireManagedPullFlow(tenantId, flowId, transport);
      guard();
      const status = await this.withIngress(() => this.requireManagedPull(transport).status({ tenantId, flowId }), transport);
      guard();
      return { roomId, sourceId, status };
    });
  }

  stopPullIngress(tenantId: string, flowId: string, transport: ManagedPullTransport): Promise<void> {
    return this.mutate(tenantId, async (guard) => {
      await this.requireManagedPullFlow(tenantId, flowId, transport);
      guard();
      await this.revokeManagedPull(tenantId, flowId, transport);
      guard();
    });
  }

  private requireManagedPull(transport: ManagedPullTransport): PullIngressLifecycle {
    const lifecycle = this.managedPull?.(transport);
    if (!lifecycle) throw new HttpError(503, `${transport}_ingress_unavailable`, 'Managed Ingress requires Redis flow storage');
    return lifecycle;
  }

  private async requireManagedPullFlow(tenantId: string, flowId: string, transport: ManagedPullTransport): Promise<{
    roomId: string; sourceId: string; enabled: boolean;
  }> {
    const flow = (await this.store.list(tenantId)).find((item) => item.id === flowId);
    const source = flow && managedPullSource(flow.sources);
    if (!flow || source?.transport !== transport) throw new HttpError(404, 'not_found', 'Managed Ingress flow not found');
    return { ...source, enabled: flow.enabled };
  }

  private validatePullTarget(tenantId: string, source: { roomId: string; sourceId: string; transport: ManagedPullTransport }): {
    room: Room; binding: PullIngressSource;
  } {
    this.requireManagedPull(source.transport);
    const sources = source.transport === 'hls' ? this.env.hlsIngressSources : this.env.srtIngressSources;
    const binding = sources.find((item) => item.tenantId === tenantId && item.sourceId === source.sourceId);
    if (!binding) throw new HttpError(404, 'not_found', 'Ingress source not found');
    return { room: this.managedIngressRoom(tenantId, source.roomId, source.transport), binding };
  }

  private async revokeManagedPull(tenantId: string, flowId: string, transport: ManagedPullTransport): Promise<void> {
    const result = await this.withIngress(() => this.requireManagedPull(transport).revoke({ tenantId, flowId }), transport);
    if (result !== 'complete') {
      throw new HttpError(409, `${transport}_ingress_revoke_pending`, 'The provider has not confirmed Ingress revocation');
    }
  }

  createRtmpIngress(tenantId: string, flowId: string): Promise<{ url: string; streamKey: string }> {
    return this.mutate(tenantId, async (guard) => {
      const flow = await this.requireManagedFlow(tenantId, flowId);
      guard();
      if (!flow.enabled) throw new HttpError(409, 'flow_disabled', 'Enable the flow before provisioning RTMP Ingress');
      if (!this.env.sfuUrl || !ingressControlConfigured(this.env)) {
        throw new HttpError(503, 'rtmp_ingress_unavailable', 'Configure the shared LiveKit Ingress control endpoint');
      }
      const room = this.managedIngressRoom(tenantId, flow.roomId);
      const result = await this.withIngress(() => this.requireManagedRtmp().create({ tenantId, flowId }, room));
      guard();
      return { url: result.url, streamKey: result.streamKey };
    });
  }

  getRtmpIngress(tenantId: string, flowId: string): Promise<{
    roomId: string; status: Awaited<ReturnType<RtmpIngressLifecycle['status']>>;
  }> {
    return this.mutate(tenantId, async (guard) => {
      const { roomId } = await this.requireManagedFlow(tenantId, flowId);
      guard();
      const status = await this.withIngress(() => this.requireManagedRtmp().status({ tenantId, flowId }));
      guard();
      return { roomId, status };
    });
  }

  stopRtmpIngress(tenantId: string, flowId: string): Promise<void> {
    return this.mutate(tenantId, async (guard) => {
      await this.requireManagedFlow(tenantId, flowId);
      guard();
      await this.revokeManagedRtmp(tenantId, flowId);
      guard();
    });
  }

  private requireManagedRtmp(): RtmpIngressLifecycle {
    const lifecycle = this.managedRtmp?.();
    if (!lifecycle) throw new HttpError(503, 'rtmp_ingress_unavailable', 'Managed RTMP Ingress requires Redis flow storage');
    return lifecycle;
  }

  private async requireManagedFlow(tenantId: string, flowId: string): Promise<{ roomId: string; enabled: boolean }> {
    const flow = (await this.store.list(tenantId)).find((item) => item.id === flowId);
    const roomId = flow && managedRtmpRoom(flow.sources);
    if (!flow || !roomId) throw new HttpError(404, 'not_found', 'Managed RTMP flow not found');
    return { roomId, enabled: flow.enabled };
  }

  private managedIngressRoom(tenantId: string, roomId: string, transport: 'rtmp' | ManagedPullTransport = 'rtmp'): Room {
    const room = this.rooms.get(roomId);
    if (!room || room.tenantId !== tenantId) throw new HttpError(404, 'not_found', 'Ingress room not found');
    if (room.mediaMode !== 'sfu' && room.mediaMode !== 'broadcast') {
      throw new HttpError(409, `${transport}_ingress_requires_sfu`, 'Managed Ingress requires an SFU room');
    }
    return room;
  }

  private async revokeManagedRtmp(tenantId: string, flowId: string): Promise<void> {
    const result = await this.withIngress(() => this.requireManagedRtmp().revoke({ tenantId, flowId }));
    if (result !== 'complete') {
      throw new HttpError(409, 'rtmp_ingress_revoke_pending', 'The provider has not confirmed RTMP Ingress revocation');
    }
  }

  private async withIngress<T>(operation: () => Promise<T>, transport: 'rtmp' | ManagedPullTransport = 'rtmp'): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, `${transport}_ingress_unavailable`, 'LiveKit Ingress did not confirm the operation');
    }
  }

  /** `GET /v1/admin/flows/:id/status`: capability/trigger/schedule diagnostics. */
  async getStatus(tenantId: string, flowId: string): Promise<FlowStatus> {
    const flows = await this.store.list(tenantId);
    const flow = flows.find((item) => item.id === flowId);
    if (!flow) throw new HttpError(404, 'not_found', 'Flow not found');
    const plan = planFlowExecution(flow);
    const nextRunAt = nextFlowRunAt(flow);
    const triggers = flow.triggers.map((trigger) => {
      const capability = FLOW_TRIGGER_ADAPTERS[trigger.kind];
      return {
        kind: trigger.kind,
        supported: capability.state === 'supported',
        ...(trigger.kind === 'schedule' && nextRunAt !== null ? { nextRunAt } : {}),
        ...(capability.reason ? { reason: capability.reason } : {}),
      };
    });
    return {
      flowId: flow.id,
      tenantId: flow.tenantId,
      enabled: flow.enabled,
      priority: flow.priority,
      plan,
      triggers,
      fallbackChain: flowFallbackChain(flows, flow).map((candidate) => candidate.id),
      activeRoomIds: this.activeRoomIds(flow),
      ...(flow.lastFiredAt !== undefined ? { lastFiredAt: flow.lastFiredAt } : {}),
      ...(flow.lastRun ? { lastRun: flow.lastRun } : {}),
    };
  }

  /* ----------------------------- evaluation --------------------------- */

  /**
   * `POST /v1/admin/flows/:id/test`: diagnostic evaluation. `apply:false` is a
   * dry run; the default starts egress/delivers webhooks exactly like a live
   * trigger. Fallback flows are tried when the primary run cannot deliver.
   */
  async testFlow(
    tenantId: string,
    flowId: string,
    input: FlowTestRequest,
    context: { ip?: string } = {},
  ): Promise<FlowTestResponse> {
    const epoch = this.mutationEpoch();
    const flows = await this.store.list(tenantId);
    this.assertMutationEpoch(epoch);
    const flow = flows.find((item) => item.id === flowId);
    if (!flow) throw new HttpError(404, 'not_found', 'Flow not found');
    const parsed = flowTestRequestSchemaSafe(input);
    const trigger = parsed.trigger ?? 'manual';
    const identity = this.identityFor(flow, trigger, parsed);
    const base = {
      flowId: flow.id,
      trigger,
      sourceIdentity: identity,
      limitations: [...FLOW_LIMITATIONS],
    };
    if (!flow.enabled) {
      return {
        ...base,
        matched: false,
        disabled: true,
        applied: false,
        mixer: this.emptyMixer(flow),
        sinks: [],
        summary: { status: 'skipped', jobs: 0, sinks: 0, errors: [], pending: [] },
        errors: ['flow is disabled'],
      };
    }
    if (trigger !== 'manual' && !flow.triggers.some((candidate) => candidate.kind === trigger)) {
      return {
        ...base,
        matched: false,
        disabled: false,
        applied: false,
        mixer: this.emptyMixer(flow),
        sinks: [],
        summary: { status: 'skipped', jobs: 0, sinks: 0, errors: [], pending: [] },
        errors: [`flow does not declare the ${trigger} trigger`],
      };
    }
    if (trigger !== 'manual') {
      const selected = selectFlow(flows, { trigger, identity });
      if (selected && selected.id !== flow.id) {
        return {
          ...base,
          matched: false,
          disabled: false,
          shadowedBy: selected.id,
          applied: false,
          mixer: this.emptyMixer(flow),
          sinks: [],
          summary: { status: 'skipped', jobs: 0, sinks: 0, errors: [], pending: [] },
          errors: [`flow is shadowed by higher-priority flow ${selected.id}`],
        };
      }
    }
    const apply = parsed.apply ?? true;
    const runContext: EvaluateContext = {
      trigger,
      identity,
      ...(parsed.roomId ? { roomId: parsed.roomId } : {}),
      createRoom: apply && identity.type === 'edge',
      apply,
      ...(context.ip ? { ip: context.ip } : {}),
    };
    let evaluatedFlow = flow;
    let result = await this.evaluate(flow, runContext);
    this.assertMutationEpoch(epoch);
    let fallbackOf: string | undefined;
    if (apply && needsFallback(result)) {
      await this.recordRun(flow, trigger, result, epoch);
      for (const candidate of flowFallbackChain(flows, flow).slice(1)) {
        fallbackOf = flow.id;
        evaluatedFlow = candidate;
        result = await this.evaluate(candidate, runContext);
        this.assertMutationEpoch(epoch);
        await this.recordRun(candidate, trigger, result, epoch);
        if (!needsFallback(result)) break;
      }
    } else {
      await this.recordRun(flow, trigger, result, epoch);
    }
    this.audit({
      type: 'flow.tested',
      severity: result.summary.status === 'failed' || result.summary.status === 'unavailable' ? 'warn' : 'info',
      tenantId,
      ip: context.ip,
      message: `Flow tested: ${flow.id}${fallbackOf ? ` → fallback ${evaluatedFlow.id}` : ''} (${result.summary.status})`,
      details: {
        kind: 'flow.tested',
        flowId: flow.id,
        ...(fallbackOf ? { fallbackOf } : {}),
        trigger,
        applied: apply,
        roomId: result.roomId,
        status: result.summary.status,
        jobs: result.summary.jobs,
        pending: result.pending.map((entry) => entry.kind),
      },
    });
    return {
      ...base,
      matched: true,
      disabled: false,
      applied: apply,
      ...(result.roomId ? { roomId: result.roomId } : {}),
      roomCreated: result.roomCreated,
      mixer: result.mixer,
      sinks: result.sinks,
      summary: result.summary,
      ...(fallbackOf ? { fallbackOf } : {}),
      errors: result.errors,
    };
  }

  /**
   * Edge enrollment through a flow (`docs/flows.md`): selects the highest
   * priority `edge_online` flow for the identity, resolves/creates its room,
   * issues a join token and starts its sinks. Returns `null` when no flow
   * applies (the caller keeps the baseline `404 no_route`).
   *
   * A flow that cannot execute (pending source/processor adapter) answers
   * `409 flow_pending` instead of silently issuing a token for nothing.
   */
  async joinEdge(input: {
    tenantId: string;
    edgeId: string;
    tag?: string;
    name?: string;
    ip?: string;
  }): Promise<FlowEdgeJoinResult | null> {
    const identity: FlowSourceIdentity = {
      type: 'edge',
      edgeId: input.edgeId,
      ...(input.tag ? { tag: input.tag } : {}),
    };
    const epoch = this.leadershipEpoch;
    const flow = selectFlow(await this.store.list(input.tenantId), { trigger: 'edge_online', identity });
    if (!flow) return null;
    this.assertMutationEpoch(epoch);
    const plan = planFlowExecution(flow);
    if (!plan.executable) {
      const reason = plan.pending[0]?.reason ?? ADAPTER_FALLBACK;
      throw new HttpError(409, 'flow_pending', `Flow ${flow.id} cannot execute yet: ${reason}`);
    }
    const target = this.resolveRoomTarget(flow, plan, {
      trigger: 'edge_online',
      identity,
      apply: true,
    });
    if (!target.roomId || !isValidRoomId(target.roomId)) {
      throw new HttpError(400, 'validation_failed', target.error ?? 'Flow has no valid room target');
    }
    const ensured = this.ensureRoom(input.tenantId, target.roomId, {
      create: true,
      name: flow.name ?? input.name ?? `Edge ${input.edgeId}`,
    });
    const role = target.roomSink?.role ?? FLOW_DEFAULTS.role;
    const publish =
      target.roomSink?.publish && target.roomSink.publish.length > 0
        ? [...target.roomSink.publish]
        : [...FLOW_DEFAULTS.publish];
    const issued = issueToken(this.env, {
      participantId: `edge-${input.edgeId}`,
      name: (input.name ?? `Edge ${input.edgeId}`).slice(0, 120),
      role,
      tenantId: input.tenantId,
      roomId: ensured.room.id,
      ttlSec: this.joinTokenTtlSec(),
    });
    const result = await this.evaluate(flow, {
      trigger: 'edge_online',
      identity,
      roomId: ensured.room.id,
      createRoom: false,
      apply: true,
      ...(input.ip ? { ip: input.ip } : {}),
    });
    this.assertMutationEpoch(epoch);
    await this.recordRun(flow, 'edge_online', result, epoch);
    this.audit({
      type: result.summary.status === 'failed' || result.summary.status === 'unavailable' ? 'flow.failed' : 'flow.started',
      severity: result.summary.status === 'failed' || result.summary.status === 'unavailable' ? 'warn' : 'info',
      tenantId: input.tenantId,
      roomId: ensured.room.id,
      ip: input.ip,
      message: `Edge ${input.edgeId} online for flow ${flow.id} → room ${ensured.room.id} (${result.summary.status})`,
      details: {
        kind: 'flow.started',
        flowId: flow.id,
        edgeId: input.edgeId,
        roomId: ensured.room.id,
        roomCreated: ensured.created,
        status: result.summary.status,
        jobs: result.summary.jobs,
        pending: result.pending.map((entry) => entry.kind),
      },
    });
    return {
      flowId: flow.id,
      roomId: ensured.room.id,
      room: {
        id: ensured.room.id,
        tenantId: ensured.room.tenantId,
        name: ensured.room.name,
        mediaMode: ensured.room.mediaMode,
        maxParticipants: ensured.room.maxParticipants,
      },
      role,
      publish,
      joinToken: issued.token,
      expiresAt: issued.expiresAt,
      destinations: projectDestinations(result.sinks),
      egress: projectEgressSummary(result.summary),
      limitations: [...FLOW_LIMITATIONS],
    };
  }

  /* ------------------------------ triggers ---------------------------- */

  /**
   * Room lifecycle hook: the first participant makes a room active, which is
   * when a `room_start` flow starts egress (idempotent across re-evaluations).
   * Never throws: a flow failure must not break a call.
   */
  onRoomEvent(event: RoomLifecycleEvent): void {
    if (event.type !== 'joined') return;
    const room = event.room;
    if (room.breakoutParentId) return;
    if (room.participantCount !== 1) return;
    void this.onRoomStarted(room).catch((error: unknown) => {
      const message = sanitizeEgressErrorText(error instanceof Error ? error.message : String(error));
      this.logger.warn('flow room trigger failed', { tenantId: room.tenantId, roomId: room.id, error: message });
      this.audit({
        type: 'flow.failed',
        severity: 'warn',
        tenantId: room.tenantId,
        roomId: room.id,
        message: `Room flow failed: ${message}`,
        details: { kind: 'flow.failed', roomId: room.id, trigger: 'room_start' },
      });
    });
  }

  private async onRoomStarted(room: Room): Promise<void> {
    const epoch = this.mutationEpoch();
    const flows = await this.store.list(room.tenantId);
    this.assertMutationEpoch(epoch);
    const identity: FlowSourceIdentity = { type: 'room', roomId: room.id };
    const flow = selectFlow(flows, { trigger: 'room_start', identity });
    if (!flow) return;
    const result = await this.evaluate(flow, {
      trigger: 'room_start',
      identity,
      roomId: room.id,
      apply: true,
    });
    this.assertMutationEpoch(epoch);
    await this.recordRun(flow, 'room_start', result, epoch);
    this.audit({
      type: result.summary.status === 'failed' || result.summary.status === 'unavailable' ? 'flow.failed' : 'flow.matched',
      severity: result.summary.status === 'failed' || result.summary.status === 'unavailable' ? 'warn' : 'info',
      tenantId: room.tenantId,
      roomId: room.id,
      message: `Room flow matched: ${flow.id} (${result.summary.status})`,
      details: {
        kind: 'flow.matched',
        flowId: flow.id,
        trigger: 'room_start',
        roomId: room.id,
        status: result.summary.status,
        jobs: result.summary.jobs,
        pending: result.pending.map((entry) => entry.kind),
      },
    });
  }

  /**
   * Edge-online hook called by the routing baseline after an Edge joined its
   * room. Fire-and-forget; a failure is audited, never thrown.
   */
  onEdgeOnline(event: {
    tenantId: string;
    edgeId: string;
    tag?: string;
    roomId: string;
    roomName: string;
  }): void {
    void this.runEdgeOnline(event).catch((error: unknown) => {
      const message = sanitizeEgressErrorText(error instanceof Error ? error.message : String(error));
      this.logger.warn('flow edge-online trigger failed', {
        tenantId: event.tenantId,
        edgeId: event.edgeId,
        error: message,
      });
    });
  }

  private async runEdgeOnline(event: {
    tenantId: string;
    edgeId: string;
    tag?: string;
    roomId: string;
    roomName: string;
  }): Promise<void> {
    const epoch = this.mutationEpoch();
    const identity: FlowSourceIdentity = {
      type: 'edge',
      edgeId: event.edgeId,
      ...(event.tag ? { tag: event.tag } : {}),
    };
    const flow = selectFlow(await this.store.list(event.tenantId), { trigger: 'edge_online', identity });
    this.assertMutationEpoch(epoch);
    if (!flow) return;
    const result = await this.evaluate(flow, {
      trigger: 'edge_online',
      identity,
      roomId: event.roomId,
      apply: true,
    });
    this.assertMutationEpoch(epoch);
    await this.recordRun(flow, 'edge_online', result, epoch);
    this.audit({
      type: result.summary.status === 'failed' || result.summary.status === 'unavailable' ? 'flow.failed' : 'flow.started',
      severity: result.summary.status === 'failed' || result.summary.status === 'unavailable' ? 'warn' : 'info',
      tenantId: event.tenantId,
      roomId: event.roomId,
      message: `Edge ${event.edgeId} online for flow ${flow.id} → room ${event.roomId} (${result.summary.status})`,
      details: {
        kind: 'flow.started',
        flowId: flow.id,
        edgeId: event.edgeId,
        trigger: 'edge_online',
        roomId: event.roomId,
        status: result.summary.status,
        jobs: result.summary.jobs,
        pending: result.pending.map((entry) => entry.kind),
      },
    });
  }

  /** Runs due schedule triggers for every tenant known to the store. */
  async tickAll(): Promise<void> {
    for (const tenantId of this.store.tenantIds()) {
      try {
        await this.tickTenant(tenantId);
      } catch (error) {
        this.logger.warn('flow schedule tick failed', {
          tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Runs due schedule triggers for one tenant. Exposed as
   * `POST /v1/admin/flows/tick` (ops/diagnostic) and called in-process every
   * 30 s. A due flow is marked fired even when it is skipped, so a schedule
   * cannot retry-storm every tick.
   */
  async tickTenant(tenantId: string, now = this.now()): Promise<FlowTickResponse> {
    const epoch = this.mutationEpoch();
    const response: FlowTickResponse = { tenantId, now, due: [], evaluated: [], skipped: [] };
    for (const flow of await this.store.list(tenantId)) {
      this.assertMutationEpoch(epoch);
      if (!flow.enabled) continue;
      if (!isFlowScheduleDue(flow, now)) continue;
      response.due.push(flow.id);
      try {
        const plan = planFlowExecution(flow);
        const target = this.resolveRoomTarget(flow, plan, {
          trigger: 'schedule',
          identity: { type: 'room', roomId: '' },
          apply: true,
        });
        if (!target.roomId || !isValidRoomId(target.roomId)) {
          response.skipped.push({ flowId: flow.id, reason: target.error ?? 'no room target' });
          await this.updateFlowMetadata(flow, epoch, { lastFiredAt: now });
          continue;
        }
        const room = this.rooms.get(target.roomId);
        if (!room || room.tenantId !== tenantId) {
          response.skipped.push({ flowId: flow.id, reason: `room ${target.roomId} does not exist` });
          await this.updateFlowMetadata(flow, epoch, { lastFiredAt: now });
          continue;
        }
        if (room.participantCount === 0) {
          response.skipped.push({ flowId: flow.id, reason: `room ${target.roomId} has no participants` });
          await this.updateFlowMetadata(flow, epoch, { lastFiredAt: now });
          continue;
        }
        const identity: FlowSourceIdentity = { type: 'room', roomId: room.id };
        const result = await this.evaluate(flow, {
          trigger: 'schedule',
          identity,
          roomId: room.id,
          apply: true,
        });
        this.assertMutationEpoch(epoch);
        await this.recordRun(flow, 'schedule', result, epoch, now);
        response.evaluated.push(flow.id);
        this.audit({
          type: result.summary.status === 'failed' || result.summary.status === 'unavailable' ? 'flow.failed' : 'flow.started',
          severity: result.summary.status === 'failed' || result.summary.status === 'unavailable' ? 'warn' : 'info',
          tenantId,
          roomId: room.id,
          message: `Scheduled flow ${flow.id} → room ${room.id} (${result.summary.status})`,
          details: {
            kind: 'flow.started',
            flowId: flow.id,
            trigger: 'schedule',
            roomId: room.id,
            status: result.summary.status,
            jobs: result.summary.jobs,
            pending: result.pending.map((entry) => entry.kind),
          },
        });
      } catch (error) {
        this.assertMutationEpoch(epoch);
        const message = sanitizeEgressErrorText(error instanceof Error ? error.message : String(error));
        this.logger.warn('scheduled flow evaluation failed', { tenantId, flowId: flow.id, error: message });
        response.skipped.push({ flowId: flow.id, reason: message });
        await this.updateFlowMetadata(flow, epoch, { lastFiredAt: now });
      }
    }
    if (response.due.length > 0) {
      this.audit({
        type: 'flow.schedule.tick',
        severity: 'info',
        tenantId,
        message: `Flow schedule tick: ${response.evaluated.length}/${response.due.length} evaluated`,
        details: {
          kind: 'flow.schedule.tick',
          due: response.due.length,
          evaluated: response.evaluated.length,
          skipped: response.skipped.length,
        },
      });
    }
    return response;
  }

  /* --------------------------- evaluation core ------------------------ */

  private emptyMixer(flow: Flow): FlowMixerState {
    const plan = planFlowExecution(flow);
    return {
      status: 'skipped',
      layout: plan.layout,
      audioMix: plan.audioMix,
      transcodeProfiles: plan.transcodeProfiles,
      sourceCount: 0,
      roomIds: [],
    };
  }

  /**
   * Resolves sources → one mix room → processors → sinks. Every pending step is
   * reported instead of being skipped silently, and a pending source/processor
   * blocks execution (nothing is started that would misrepresent the flow).
   */
  private async evaluate(flow: Flow, context: EvaluateContext): Promise<EvaluateResult> {
    const plan = planFlowExecution(flow);
    const pending: FlowRunPending[] = [...plan.pending];
    const errors: string[] = [];
    const target = this.resolveRoomTarget(flow, plan, context);
    if (target.error) errors.push(target.error);
    const sourceRooms = this.resolveSourceRooms(flow, context, target.roomId, pending, errors);
    const supportedSourceCount = flow.sources.filter(
      (source) => source.kind === 'room' || source.kind === 'edge' || source.kind === 'participant',
    ).length;
    const mixer: FlowMixerState = {
      status: 'skipped',
      layout: plan.layout,
      audioMix: plan.audioMix,
      transcodeProfiles: plan.transcodeProfiles,
      sourceCount: supportedSourceCount,
      roomIds: sourceRooms.rooms,
      ...(target.error ? { reason: target.error } : {}),
    };
    const sourcePending = pending.some((entry) => entry.path.startsWith('sources.'));
    const processorPending = pending.some((entry) => entry.path.startsWith('processors.'));
    const blockingReason =
      target.error ??
      (sourcePending || processorPending
        ? pending.find((entry) => entry.path.startsWith('sources.') || entry.path.startsWith('processors.'))?.reason
        : undefined) ??
      (sourceRooms.rooms.length > 1 ? FLOW_CROSS_ROOM_MIX_REASON : undefined);

    if (!context.apply) {
      const sinks = flow.sinks.map((sink, index) =>
        skippedSink(sink, index, plan.sinks[index]?.reason),
      );
      const dryPending = uniqPending(pending);
      return {
        ...(target.roomId ? { roomId: target.roomId } : {}),
        roomCreated: false,
        mixer: { ...mixer, status: 'skipped', ...(blockingReason ? { reason: blockingReason } : {}) },
        sinks,
        summary: {
          status: 'skipped',
          jobs: 0,
          sinks: sinks.length,
          errors: uniqStrings([...errors, ...dryPending.map((entry) => entry.reason)]),
          pending: dryPending,
          ...(dryPending[0] ? { error: dryPending[0].reason } : {}),
        },
        jobs: sinks.map((sink) => ({
          kind: SINK_JOB_KIND[sink.kind],
          status: 'skipped' as const,
          index: sink.index,
          ...(sink.pendingReason ? { pendingReason: sink.pendingReason } : {}),
        })),
        errors: uniqStrings(errors),
        pending: dryPending,
      };
    }

    if (blockingReason || !target.roomId) {
      const reason = blockingReason ?? 'flow has no room target';
      const sinks = flow.sinks.map((sink, index) => ({
        ...skippedSink(sink, index, plan.sinks[index]?.reason),
        status: 'pending' as const,
        pendingReason: plan.sinks[index]?.reason ?? reason,
      }));
      const blockPending = uniqPending([
        ...pending,
        ...(pending.some((entry) => entry.path.startsWith('sources.') || entry.path.startsWith('processors.')) ||
        target.error ||
        sourceRooms.rooms.length > 1
          ? [{ path: 'mixer', kind: 'mixer', reason }]
          : []),
      ]);
      const errorsOut = uniqStrings([reason, ...errors, ...blockPending.map((entry) => entry.reason)]);
      return {
        ...(target.roomId ? { roomId: target.roomId } : {}),
        roomCreated: false,
        mixer: { ...mixer, status: 'pending', reason },
        sinks,
        summary: {
          status: 'pending',
          code: sourcePending ? 'source_pending' : 'adapter_pending',
          jobs: 0,
          sinks: sinks.length,
          errors: errorsOut,
          ...(errorsOut[0] ? { error: errorsOut[0] } : {}),
          pending: blockPending,
        },
        jobs: sinks.map((sink) => ({
          kind: SINK_JOB_KIND[sink.kind],
          status: 'pending' as const,
          index: sink.index,
          ...(sink.pendingReason ? { pendingReason: sink.pendingReason } : {}),
        })),
        errors: errorsOut,
        pending: blockPending,
      };
    }

    // Room is known and the mix is executable: resolve/create it.
    const ensured = this.ensureRoom(flow.tenantId, target.roomId, {
      create: Boolean(context.createRoom),
      name: flow.name ?? (context.identity.type === 'edge' ? `Edge ${context.identity.edgeId}` : 'Flow room'),
    });
    const applied = await this.applySinks(flow, plan, ensured.room, context);
    const summary = this.summarize(flow, plan, applied, pending);
    const mixerStatus: FlowRunStatus = summary.status;
    return {
      roomId: ensured.room.id,
      roomCreated: ensured.created,
      mixer: {
        ...mixer,
        status: mixerStatus,
        roomIds: [ensured.room.id],
        ...(summary.status === 'pending' ? { reason: summary.pending[0]?.reason ?? summary.error } : {}),
      },
      sinks: applied.sinks,
      summary,
      jobs: applied.jobs,
      errors: summary.errors,
      pending: summary.pending,
    };
  }

  /**
   * Resolves the single mix/publish room:
   *  1. the room supplied by a live trigger or an explicit test override,
   *  2. the first room sink (`roomId` or expanded `template`),
   *  3. the single room of a room-bound source,
   *  4. an implicit `edge-<edgeId>` room for an Edge flow.
   *
   * When the trigger room differs from the room sink, the sink is a
   * "publish into another room" branch (pending forward), not the mix target.
   */
  private resolveRoomTarget(flow: Flow, plan: ReturnType<typeof planFlowExecution>, context: EvaluateContext): RoomTarget {
    const roomSinkIndex = plan.roomSinkIndexes[0];
    const roomSink = roomSinkIndex !== undefined ? flow.sinks[roomSinkIndex] : undefined;
    const vars = templateVars(flow, context.identity);
    const sinkRoomId = roomSink
      ? roomSink.roomId ?? (roomSink.template ? expandFlowTemplate(roomSink.template, vars) : '')
      : '';
    if (roomSink && sinkRoomId && !isValidRoomId(sinkRoomId)) {
      return {
        roomSink,
        roomSinkIndex: roomSinkIndex ?? -1,
        implicitFromEdge: false,
        error: `flow ${flow.id} produced an invalid room id (check roomId/template)`,
      };
    }
    if (context.roomId) {
      const matchesTarget = sinkRoomId === context.roomId;
      return {
        roomId: context.roomId,
        ...(matchesTarget ? { roomSink, roomSinkIndex: roomSinkIndex ?? -1 } : { roomSinkIndex: -1 }),
        implicitFromEdge: false,
      };
    }
    if (roomSink && sinkRoomId) {
      return { roomId: sinkRoomId, roomSink, roomSinkIndex: roomSinkIndex ?? -1, implicitFromEdge: false };
    }
    const sourceRooms = unique(
      flow.sources
        .filter((source) => source.kind === 'room' && source.roomId)
        .map((source) => source.roomId as string),
    );
    if (sourceRooms.length === 1) {
      return { roomId: sourceRooms[0], roomSinkIndex: -1, implicitFromEdge: false };
    }
    if (sourceRooms.length > 1) {
      return { roomSinkIndex: -1, implicitFromEdge: false, error: FLOW_CROSS_ROOM_MIX_REASON };
    }
    if (context.identity.type === 'edge' && context.identity.edgeId) {
      return {
        roomId: implicitEdgeRoomId(context.identity.edgeId),
        roomSinkIndex: -1,
        implicitFromEdge: true,
      };
    }
    return { roomSinkIndex: -1, implicitFromEdge: false, error: 'flow has no room target' };
  }

  /**
   * Resolves each source to a room. A source that resolves to a different room
   * than the target is a pending mixer/forward adapter, never a silent drop.
   */
  private resolveSourceRooms(
    flow: Flow,
    context: EvaluateContext,
    targetRoomId: string | undefined,
    pending: FlowRunPending[],
    errors: string[],
  ): { rooms: string[] } {
    const rooms: string[] = [];
    for (const [index, source] of flow.sources.entries()) {
      const issuePath = `sources.${index}`;
      if (source.kind === 'room') {
        const room = source.roomId;
        if (!room) continue;
        rooms.push(room);
        if (targetRoomId && room !== targetRoomId) {
          pending.push({ path: issuePath, kind: source.kind, reason: FLOW_ROOM_FORWARD_REASON });
        }
        continue;
      }
      if (source.kind === 'edge') {
        const room = context.roomId ?? targetRoomId;
        if (!room) {
          pending.push({ path: issuePath, kind: source.kind, reason: FLOW_EDGE_OFFLINE_REASON });
          errors.push(FLOW_EDGE_OFFLINE_REASON);
          continue;
        }
        rooms.push(room);
        continue;
      }
      if (source.kind === 'participant') {
        const room = source.roomId ?? context.roomId ?? targetRoomId;
        if (!room) {
          pending.push({
            path: issuePath,
            kind: source.kind,
            reason: 'participant source is not bound to a room and no room context was supplied',
          });
          continue;
        }
        rooms.push(room);
        if (targetRoomId && room !== targetRoomId) {
          pending.push({ path: issuePath, kind: source.kind, reason: FLOW_CROSS_ROOM_MIX_REASON });
        }
        continue;
      }
      // Ingest/file/sip sources are pending adapters (already reported by the plan).
    }
    const uniqueRooms = unique(rooms);
    if (uniqueRooms.length > 1 && targetRoomId) {
      for (const [index, source] of flow.sources.entries()) {
        if (source.kind !== 'room' && source.kind !== 'participant') continue;
        if (source.roomId && source.roomId !== targetRoomId) {
          pending.push({ path: `sources.${index}`, kind: source.kind, reason: FLOW_CROSS_ROOM_MIX_REASON });
        }
      }
    }
    return { rooms: uniqueRooms };
  }

  /** Starts egress jobs and delivers webhook sinks; collects per-sink results. */
  private async applySinks(
    flow: Flow,
    plan: ReturnType<typeof planFlowExecution>,
    room: Room,
    context: EvaluateContext,
  ): Promise<{ sinks: FlowEffectiveSink[]; jobs: FlowRunJob[]; mediaJobs: number }> {
    const sinks: Array<FlowEffectiveSink | undefined> = new Array(flow.sinks.length);
    const runtimeErrors = new Map<number, string>();
    const planned: PlannedEgressJob[] = [];
    const findJob = (kind: PlannedEgressJob['kind'], layout: EgressLayout, audioOnly = false): PlannedEgressJob | undefined =>
      planned.find((job) => job.kind === kind && job.layout === layout && job.audioOnly === audioOnly);

    for (const [index, sink] of flow.sinks.entries()) {
      const planPart = plan.sinks[index];
      if (planPart?.state === 'pending') {
        sinks[index] = {
          index,
          kind: sink.kind,
          status: 'pending',
          execution: 'none',
          ...sinkViewFields(sink),
          pendingReason: planPart.reason,
        };
        continue;
      }
      if (sink.kind === 'room') {
        // A room sink is the publish target only when it resolves to the mix
        // room; a different room is a "publish into another room" forward
        // (pending adapter). Additional room sinks are pending by the plan.
        const vars = templateVars(flow, context.identity);
        const raw = sink.roomId ?? (sink.template ? expandFlowTemplate(sink.template, vars) : '');
        if (raw === room.id) {
          sinks[index] = {
            index,
            kind: sink.kind,
            status: 'ready',
            execution: 'egress',
            roomId: room.id,
            role: sink.role ?? FLOW_DEFAULTS.role,
            publish: sink.publish && sink.publish.length > 0 ? [...sink.publish] : [...FLOW_DEFAULTS.publish],
            ...sinkViewFields(sink),
          };
        } else {
          sinks[index] = {
            index,
            kind: sink.kind,
            status: 'pending',
            execution: 'none',
            ...(raw ? { roomId: raw } : {}),
            pendingReason: FLOW_ROOM_FORWARD_REASON,
            ...sinkViewFields(sink),
          };
        }
        continue;
      }
      if (sink.kind === 'rtmp') {
        const resolved = this.resolveSinkUrl(flow, sink, index, runtimeErrors);
        if (!resolved) continue;
        const layout = (sink.layout ?? plan.layout) as EgressLayout;
        const job = findJob('rtmp', layout) ?? { kind: 'rtmp', layout, audioOnly: false, urls: [], indexes: [] };
        if (!planned.includes(job)) planned.push(job);
        job.urls.push(resolved);
        job.indexes.push(index);
        continue;
      }
      if (sink.kind === 'hls') {
        const layout = (sink.layout ?? plan.layout) as EgressLayout;
        const job = findJob('hls', layout) ?? { kind: 'hls', layout, audioOnly: false, urls: [], indexes: [] };
        if (!planned.includes(job)) planned.push(job);
        job.indexes.push(index);
        continue;
      }
      if (sink.kind === 'recording') {
        const layout = (sink.layout ?? plan.layout) as EgressLayout;
        const audioOnly = Boolean(sink.audioOnly);
        const job = findJob('recording', layout, audioOnly) ?? {
          kind: 'recording' as const,
          layout,
          audioOnly,
          urls: [],
          indexes: [],
        };
        if (!planned.includes(job)) planned.push(job);
        job.indexes.push(index);
        continue;
      }
      if (sink.kind === 'webhook') {
        // Delivered after the media jobs so the payload carries their outcome.
        sinks[index] = {
          index,
          kind: sink.kind,
          status: 'pending',
          execution: 'webhook',
          ...sinkViewFields(sink),
        };
        continue;
      }
      // srt/cdn are pending adapters (handled by the plan) — defensive fallback.
      sinks[index] = {
        index,
        kind: sink.kind,
        status: 'pending',
        execution: 'none',
        pendingReason: FLOW_SINK_ADAPTERS[sink.kind].reason ?? ADAPTER_FALLBACK,
        ...sinkViewFields(sink),
      };
    }

    const jobResults = await Promise.all(
      planned.map(async (job) => {
        const key = this.egressKey(flow.tenantId, room, job);
        const state = await this.ensureEgress(key, job, flow, room);
        return { job, state };
      }),
    );
    const states = new Map<number, EgressJobState>();
    for (const result of jobResults) {
      for (const index of result.job.indexes) states.set(index, result.state);
      const error = result.state.error ? sanitizeEgressErrorText(result.state.error) : undefined;
      for (const index of result.job.indexes) {
        const sink = flow.sinks[index] as FlowSink;
        sinks[index] = {
          index,
          kind: sink.kind,
          status: result.state.status,
          execution: 'egress',
          ...(result.state.egressId ? { egressId: result.state.egressId } : {}),
          ...sinkViewFields(sink, result.job.layout),
          ...(error ? { error } : {}),
        };
      }
    }
    // A sink whose credential failed before a job existed.
    for (const [index, error] of runtimeErrors.entries()) {
      const sink = flow.sinks[index] as FlowSink;
      sinks[index] = {
        index,
        kind: sink.kind,
        status: 'unavailable',
        execution: SINK_EXECUTION[sink.kind],
        ...sinkViewFields(sink),
        error: sanitizeEgressErrorText(error),
      };
    }

    const jobs: FlowRunJob[] = [];
    const mediaJobs = jobResults.length;
    const mediaStatuses: RoutingStatus[] = [];
    for (const [index, sink] of flow.sinks.entries()) {
      if (sink.kind === 'webhook') continue;
      const result = sinks[index];
      if (!result) continue;
      if (result.kind === 'recording') mediaStatuses.push(result.status);
      jobs.push({
        kind: SINK_JOB_KIND[result.kind],
        status: result.status,
        index,
        ...(result.egressId ? { egressId: result.egressId } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.pendingReason ? { pendingReason: result.pendingReason } : {}),
      });
    }

    // Webhook sinks: deliver after the media outcome is known.
    const preliminary: FlowEffectiveSink[] = sinks.filter((sink): sink is FlowEffectiveSink => Boolean(sink));
    const preliminarySummary = this.summarize(flow, plan, { sinks: preliminary, jobs, mediaJobs }, []);
    const webhookEvent: FlowWebhookEvent =
      preliminarySummary.status === 'failed' || preliminarySummary.status === 'unavailable' ? 'failed' : 'started';
    for (const [index, sink] of flow.sinks.entries()) {
      if (sink.kind !== 'webhook') continue;
      const delivery = await this.deliverWebhook(flow, sink, index, room, context, preliminarySummary, webhookEvent);
      const base = sinks[index] ?? {
        index,
        kind: sink.kind,
        status: 'pending' as const,
        execution: 'webhook' as const,
        ...sinkViewFields(sink),
      };
      sinks[index] = {
        ...base,
        status: delivery.status === 'delivered' ? 'started' : delivery.status === 'skipped' ? 'skipped' : 'failed',
        delivery: delivery.status === 'skipped' ? undefined : delivery.status,
        ...(delivery.error ? { error: delivery.error } : {}),
      };
      jobs.push({
        kind: 'webhook',
        status: sinks[index]!.status,
        index,
        ...(delivery.error ? { error: delivery.error } : {}),
      });
    }

    const finalSinks = sinks.filter((sink): sink is FlowEffectiveSink => Boolean(sink));
    return { sinks: finalSinks, jobs, mediaJobs };
  }

  /** Aggregates sink/job outcomes into the persisted run summary. */
  private summarize(
    flow: Flow,
    plan: ReturnType<typeof planFlowExecution>,
    applied: { sinks: FlowEffectiveSink[]; jobs: FlowRunJob[]; mediaJobs: number },
    pending: FlowRunPending[],
  ): FlowRunSummary {
    const aggregate = aggregateFlowStatus(applied.sinks);
    const pendingEntries = uniqPending([...pending, ...plan.pending]);
    const errors = uniqStrings([
      ...applied.sinks.map((sink) => sink.error),
      ...pendingEntries.map((entry) => entry.reason),
    ]);
    const webhookFailed = applied.sinks.some((sink) => sink.kind === 'webhook' && sink.status === 'failed');
    const status = webhookFailed && (aggregate.status === 'started' || aggregate.status === 'pending')
      ? 'partial'
      : aggregate.status;
    return {
      status,
      ...(webhookFailed && status === 'partial' ? { code: 'webhook_failed' as const } : aggregate.code ? { code: aggregate.code } : {}),
      jobs: applied.mediaJobs,
      sinks: applied.sinks.length,
      errors,
      ...(errors[0] ? { error: errors[0] } : {}),
      pending: pendingEntries,
    };
  }

  /**
   * Resolves an `rtmp` sink URL: inline `url` or a server-owned
   * `AGIL_ROUTE_SECRET_*` variable, re-checked against the SSRF policy at start
   * time. A missing/invalid credential is a sink error, never a thrown request.
   */
  private resolveSinkUrl(flow: Flow, sink: FlowSink, index: number, errors: Map<number, string>): string | null {
    let url = sink.url;
    let fromSecret = false;
    if (!url && sink.secretRef) {
      const secret = resolveTenantSecret(this.env, sink.secretRef, 'route');
      if (!secret.allowed) {
        errors.set(index, 'flow secret reference is not allowed');
        return null;
      }
      if (!secret.value) {
        errors.set(index, `flow secret ${sink.secretRef} is not set`);
        return null;
      }
      url = secret.value;
      fromSecret = true;
    }
    if (!url) {
      errors.set(index, `${sink.kind} sink has no url`);
      return null;
    }
    const schemes = sink.kind === 'srt' ? ['srt:'] : ['rtmp:', 'rtmps:'];
    const check = validateNetworkEndpoint(url, {
      secure: sink.kind === 'srt' ? false : isSecureMode(this.env),
      schemes,
      applyHostPolicy: true,
    });
    if (!check.ok) {
      errors.set(
        index,
        fromSecret
          ? `resolved flow secret is not a valid ${sink.kind.toUpperCase()} URL: ${check.reason}`
          : `${sink.kind} URL is not allowed: ${check.reason}`,
      );
      return null;
    }
    return url;
  }

  /** Digs the first room sink out of a flow (used for edge join role/publish). */
  private firstRoomSink(flow: Flow): FlowSink | undefined {
    return flow.sinks.find((sink) => sink.kind === 'room');
  }

  private ensureRoom(
    tenantId: string,
    roomId: string,
    options: { create: boolean; name?: string },
  ): { room: Room; created: boolean } {
    const existing = this.rooms.get(roomId);
    if (existing) {
      if (existing.tenantId !== tenantId) {
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
        name: (options.name ?? 'Flow room').slice(0, 120),
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
        throw new HttpError(400, 'validation_failed', `Invalid flow room id: ${roomId}`);
      }
      throw error;
    }
  }

  private egressKey(tenantId: string, room: Room, job: PlannedEgressJob): string {
    const signature = createHash('sha256')
      .update([...job.urls].sort().join('\n'))
      .digest('hex')
      .slice(0, 16);
    return `${tenantId}:${room.id}:${job.kind}:${job.layout}:${job.audioOnly ? 'audio' : 'av'}:${signature}`;
  }

  /** Reuses a live egress job, including one still starting or stopping. */
  private ensureEgress(key: string, job: PlannedEgressJob, flow: Flow, room: Room): Promise<EgressJobState> {
    const inflight = this.egressInflight.get(key);
    if (inflight) return inflight;
    const cached = this.egressJobs.get(key);
    let cachedEgressId = cached && (cached.status === 'started' || cached.status === 'pending') ? cached.egressId : undefined;
    if (cached && !cachedEgressId && this.now() - cached.at < EGRESS_FAILURE_RETRY_MS) return Promise.resolve(cached);
    const roomName = sfuRoomName(room.tenantId, room.id);
    const promise = (async (): Promise<EgressJobState> => {
      try {
        if (cached && cachedEgressId) {
          const existing = await this.egress.info(roomName, cachedEgressId, room.tenantId);
          const status = String(existing?.status ?? '');
          if (existing && !TERMINAL_EGRESS_STATUS.test(status)) {
            if (cached.status === 'pending' && ACTIVE_EGRESS_STATUS.test(status)) {
              const active: EgressJobState = { ...cached, status: 'started' };
              this.storeEgressState(key, active);
              return active;
            }
            return cached;
          }
          cachedEgressId = undefined;
        }
        let result: EgressStartResult;
        if (job.kind === 'rtmp') {
          result = await this.egress.start({
            roomName,
            kind: 'rtmp',
            layout: job.layout,
            rtmpUrl: job.urls[0],
            rtmpUrls: job.urls,
            tenantId: room.tenantId,
            roomId: room.id,
          });
        } else if (job.kind === 'hls') {
          result = await this.egress.start({
            roomName,
            kind: 'hls',
            layout: job.layout,
            tenantId: room.tenantId,
            roomId: room.id,
          });
        } else {
          result = await this.egress.start({
            roomName,
            kind: 'recording',
            layout: job.layout,
            audioOnly: job.audioOnly,
            tenantId: room.tenantId,
            roomId: room.id,
          });
        }
        const state: EgressJobState = {
          status: /START/i.test(result.status) ? 'pending' : 'started',
          egressId: result.egressId,
          at: this.now(),
        };
        this.storeEgressState(key, state);
        return state;
      } catch (error) {
        const code = (error as { code?: string }).code;
        const status: RoutingStatus = isEgressUnavailableCode(code) ? 'unavailable' : 'failed';
        const state: EgressJobState = {
          status,
          error: sanitizeEgressErrorText(error instanceof Error ? error.message : String(error)),
          at: this.now(),
        };
        // A failed lookup does not prove that the old job stopped.
        if (!cachedEgressId) this.storeEgressState(key, state);
        this.logger.warn(cachedEgressId ? 'flow egress status check failed' : 'flow egress start failed', {
          flowId: flow.id,
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

  private storeEgressState(key: string, state: EgressJobState): void {
    this.egressJobs.set(key, state);
    if (this.egressJobs.size <= MAX_TRACKED_EGRESS_JOBS) return;
    const oldest = this.egressJobs.keys().next();
    if (!oldest.done) this.egressJobs.delete(oldest.value);
  }

  /**
   * Delivers one webhook sink: a signed JSON POST. The URL is re-checked at
   * delivery time; a `secretRef` adds an `x-agil-signature` HMAC header. A
   * failure is reported on the sink and audited, never thrown.
   */
  private async deliverWebhook(
    flow: Flow,
    sink: FlowSink,
    index: number,
    room: Room,
    context: EvaluateContext,
    summary: FlowRunSummary,
    event: FlowWebhookEvent,
  ): Promise<{ status: 'delivered' | 'failed' | 'skipped'; error?: string }> {
    const events = sink.events && sink.events.length > 0 ? sink.events : [...FLOW_DEFAULTS.webhookEvents];
    if (!events.includes(event)) return { status: 'skipped' };
    let url = sink.url;
    let fromSecret = false;
    if (!url && sink.secretRef) {
      const secret = resolveTenantSecret(this.env, sink.secretRef, 'route');
      if (!secret.allowed) return { status: 'failed', error: 'webhook secret reference is not allowed' };
      if (!secret.value) return { status: 'failed', error: `webhook secret ${sink.secretRef} is not set` };
      url = secret.value;
      fromSecret = true;
    }
    if (!url) return { status: 'failed', error: 'webhook sink has no url' };
    const check = validateNetworkEndpoint(url, {
      secure: isSecureMode(this.env),
      schemes: ['https:', 'http:'],
      applyHostPolicy: true,
    });
    if (!check.ok) {
      return {
        status: 'failed',
        error: `${fromSecret ? 'resolved webhook secret is not a valid URL' : 'webhook URL is not allowed'}: ${check.reason}`,
      };
    }
    const payload = {
      id: randomUUID(),
      type: `flow.${event}` as const,
      ts: this.now(),
      tenantId: flow.tenantId,
      flowId: flow.id,
      trigger: context.trigger,
      roomId: room.id,
      status: summary.status,
      sinks: summary.sinks,
      jobs: summary.jobs,
      errors: summary.errors.slice(0, 3),
      ...(context.identity.edgeId ? { edgeId: context.identity.edgeId } : {}),
    };
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'agil-core-flow-webhook',
      'x-agil-flow-id': flow.id,
      'x-agil-flow-event': `flow.${event}`,
    };
    if (sink.secretRef) {
      const secret = resolveTenantSecret(this.env, sink.secretRef, 'route');
      if (!secret.allowed) return { status: 'failed', error: 'webhook signing secret is not allowed' };
      if (!secret.value) return { status: 'failed', error: `webhook signing secret ${sink.secretRef} is not set` };
      const hmac = createHmac('sha256', secret.value).update(body).digest('hex');
      headers['x-agil-signature'] = `sha256=${hmac}`;
      headers['x-agil-timestamp'] = String(payload.ts);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
      if (response.ok) {
        this.audit({
          type: 'flow.started',
          severity: 'info',
          tenantId: flow.tenantId,
          roomId: room.id,
          message: `Flow webhook delivered: ${flow.id} sink ${index} (${payload.type})`,
          details: { kind: 'flow.started', flowId: flow.id, sinkIndex: index, event: payload.type, statusCode: response.status },
        });
        return { status: 'delivered' };
      }
      const error = `webhook HTTP ${response.status}`;
      this.logger.warn('flow webhook rejected', { flowId: flow.id, sinkIndex: index, status: response.status });
      return { status: 'failed', error };
    } catch (error) {
      const message = sanitizeEgressErrorText(error instanceof Error ? error.message : String(error));
      this.logger.warn('flow webhook failed', { flowId: flow.id, sinkIndex: index, error: message });
      return { status: 'failed', error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ----------------------------- internals ---------------------------- */

  private audit(entry: Omit<AuditEntry, 'id' | 'ts'> & { ip?: string }): void {
    try {
      this.auditSink(entry);
    } catch {
      /* flow audit is best-effort */
    }
  }

  private joinTokenTtlSec(): number {
    return Math.max(300, Math.min(MAX_JOIN_TOKEN_TTL_SEC, this.env.tokenTtlSec));
  }

  /** Validates a candidate flow with the schema + endpoint policy + room target. */
  private assertFlow(candidate: Flow): Flow {
    const parsed = flowSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new HttpError(400, 'validation_failed', zodErrorMessage(parsed.error), parsed.error.issues);
    }
    const issues = validateFlowEndpoints(parsed.data, { secure: isSecureMode(this.env) });
    if (issues.length > 0) {
      throw new HttpError(400, 'validation_failed', 'Invalid flow endpoint', issues);
    }
    return parsed.data;
  }

  private assertFallback(candidate: Flow, others: readonly Flow[]): void {
    const issues = validateFlowFallback(candidate, others.filter((flow) => flow.id !== candidate.id));
    if (issues.length > 0) {
      throw new HttpError(400, 'validation_failed', 'Invalid flow fallback', issues);
    }
  }

  private async recordRun(
    flow: Flow, trigger: FlowTriggerKind, result: EvaluateResult, epoch: number, firedAt?: number,
  ): Promise<void> {
    const run: FlowRunRecord = {
      at: this.now(),
      trigger,
      status: result.summary.status,
      ...(result.roomId ? { roomId: result.roomId } : {}),
      jobs: result.jobs,
      pending: result.pending,
      ...(result.summary.error ? { error: result.summary.error.slice(0, 300) } : {}),
    };
    try {
      await this.updateFlowMetadata(flow, epoch, {
        lastRun: run,
        ...(firedAt !== undefined ? { lastFiredAt: firedAt } : {}),
      });
    } catch (error) {
      this.assertMutationEpoch(epoch);
      this.logger.warn('flow run record failed', {
        flowId: flow.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async updateFlowMetadata(
    flow: Flow, epoch: number, update: Pick<Flow, 'lastRun' | 'lastFiredAt'>,
  ): Promise<void> {
    await this.store.change(flow.tenantId, () => this.assertMutationEpoch(epoch), (flows) => {
      const current = flows.find((item) => item.id === flow.id);
      if (!current || current.createdAt !== flow.createdAt || current.updatedAt !== flow.updatedAt) {
        return { value: undefined };
      }
      return { value: undefined, flows: flows.map((item) => item === current ? { ...item, ...update } : item) };
    });
  }

  /** Rooms known to the registry that this flow would mix (status endpoint). */
  private activeRoomIds(flow: Flow): string[] {
    const ids = new Set<string>();
    const plan = planFlowExecution(flow);
    const target = this.resolveRoomTarget(flow, plan, {
      trigger: 'manual',
      identity: { type: 'room', roomId: '' },
      apply: false,
    });
    if (target.roomId) ids.add(target.roomId);
    for (const source of flow.sources) {
      if (source.roomId) ids.add(source.roomId);
    }
    return [...ids].filter((roomId) => {
      const room = this.rooms.get(roomId);
      return Boolean(room && room.tenantId === flow.tenantId);
    });
  }

  /** Builds the evaluation identity from an explicit test request or the flow. */
  private identityFor(flow: Flow, trigger: FlowTriggerKind, request: FlowTestRequest): FlowSourceIdentity {
    const edgeSource = flow.sources.find((source) => source.kind === 'edge');
    const participantSource = flow.sources.find((source) => source.kind === 'participant');
    const roomSource = flow.sources.find((source) => source.kind === 'room');
    const edgeId = request.edgeId ?? edgeSource?.edgeId;
    const tag = request.tag ?? edgeSource?.tag ?? participantSource?.tag;
    const roomId = request.roomId ?? roomSource?.roomId ?? participantSource?.roomId;
    if (trigger === 'edge_online' || request.edgeId !== undefined || (edgeSource && !roomSource && !participantSource)) {
      return { type: 'edge', ...(edgeId ? { edgeId } : {}), ...(tag ? { tag } : {}) };
    }
    if (request.participantId !== undefined || (trigger === 'room_start' && !roomSource && participantSource)) {
      return {
        type: 'participant',
        ...(roomId ? { roomId } : {}),
        ...(request.participantId ?? participantSource?.participantId
          ? { participantId: request.participantId ?? participantSource?.participantId }
          : {}),
        ...(tag ? { tag } : {}),
      };
    }
    return { type: 'room', ...(roomId ? { roomId } : {}) };
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/** Non-fatal reason used when an adapter has no specific message. */
const ADAPTER_FALLBACK = 'adapter is not implemented in this build';

function needsFallback(result: EvaluateResult): boolean {
  return result.summary.status === 'failed' || result.summary.status === 'unavailable';
}

function skippedSink(sink: FlowSink, index: number, pendingReason?: string): FlowEffectiveSink {
  return {
    index,
    kind: sink.kind,
    status: 'skipped',
    execution: SINK_EXECUTION[sink.kind],
    ...sinkViewFields(sink),
    ...(pendingReason ? { pendingReason } : {}),
  };
}

/** Secret-free sink fields reused by every effective-sink construction. */
function sinkViewFields(sink: FlowSink, layout?: EgressLayout): Partial<FlowEffectiveSink> {
  const view = flowSinkView(sink);
  return {
    ...(view.urlHost ? { urlHost: view.urlHost } : {}),
    ...(view.secretRef ? { secretRef: view.secretRef } : {}),
    hasSecret: view.hasSecret,
    ...(layout ? { layout: layout as RoutingLayout } : sink.layout ? { layout: sink.layout } : {}),
    ...(sink.latency ? { latency: sink.latency } : {}),
  };
}

/** Projects flow sinks onto the legacy join-destination shape. */
function projectDestinations(sinks: FlowEffectiveSink[]): RoutingEffectiveDestination[] {
  const destinations: RoutingEffectiveDestination[] = [];
  for (const sink of sinks) {
    if (sink.kind === 'webhook' || sink.kind === 'recording') continue;
    if (sink.kind === 'room') {
      destinations.push({
        index: sink.index,
        type: 'room',
        ...(sink.roomId ? { roomId: sink.roomId } : {}),
        ...(sink.role ? { role: sink.role } : {}),
        ...(sink.publish ? { publish: sink.publish } : {}),
        status: sink.status,
      });
      continue;
    }
    destinations.push({
      index: sink.index,
      type: 'stream',
      ...(sink.kind === 'rtmp' || sink.kind === 'hls' ? { provider: sink.kind } : {}),
      ...(sink.layout ? { layout: sink.layout } : {}),
      ...(sink.latency ? { latency: sink.latency } : {}),
      ...(sink.urlHost ? { urlHost: sink.urlHost } : {}),
      ...(sink.secretRef ? { secretRef: sink.secretRef } : {}),
      ...(sink.hasSecret !== undefined ? { hasSecret: sink.hasSecret } : {}),
      status: sink.status,
      ...(sink.egressId ? { egressId: sink.egressId } : {}),
      ...(sink.error ? { error: sink.error } : {}),
    });
  }
  return destinations;
}

function projectEgressSummary(summary: FlowRunSummary): RoutingEgressSummary {
  return {
    status: summary.status,
    ...(summary.code === 'egress_unavailable'
      ? { code: 'egress_unavailable' as const }
      : summary.code === 'egress_failed'
        ? { code: 'egress_failed' as const }
        : summary.status === 'partial'
          ? { code: 'partial_failure' as const }
          : {}),
    jobs: summary.jobs,
    destinations: summary.sinks,
    errors: summary.errors,
    ...(summary.error ? { error: summary.error } : {}),
  };
}

/** Zod-validates a test request for direct service callers. */
function flowTestRequestSchemaSafe(input: FlowTestRequest): FlowTestRequest {
  const parsed = flowTestRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, 'validation_failed', zodErrorMessage(parsed.error), parsed.error.issues);
  }
  return parsed.data;
}

function describeFlow(flow: Flow): string {
  const sources = flow.sources.map((source) => describeSource(source)).join(' + ');
  const sinks = flow.sinks.map((sink) => sink.kind).join(' + ');
  return `${sources || 'no sources'} → ${sinks || 'no sinks'}`;
}

function describeSource(source: FlowSource): string {
  switch (source.kind) {
    case 'room':
      return `room:${source.roomId ?? '?'}`;
    case 'edge':
      return `edge${source.edgeId ? `:${source.edgeId}` : ''}${source.tag ? `/${source.tag}` : ''}`;
    case 'participant':
      return `participant:${source.participantId ?? source.tag ?? source.roomId ?? '?'}`;
    default:
      return source.kind;
  }
}

/** Kept for callers that only need the first room id of a flow. */
export function flowRoomId(flow: Flow): string | null {
  const sink = flow.sinks.find((candidate) => candidate.kind === 'room');
  if (sink?.roomId) return sink.roomId;
  const source = flow.sources.find((candidate) => candidate.kind === 'room');
  return source?.roomId ?? null;
}

/** True when a flow declares at least one schedule trigger (ticker gating). */
export function hasScheduledFlow(flow: Flow): boolean {
  return flow.triggers.some((trigger) => trigger.kind === 'schedule');
}

/** Re-exported capability lookups for the admin/status layer. */
export const flowAdapterCapabilities = {
  sources: FLOW_SOURCE_ADAPTERS,
  sinks: FLOW_SINK_ADAPTERS,
  processors: FLOW_PROCESSOR_ADAPTERS,
  triggers: FLOW_TRIGGER_ADAPTERS,
} as const;
