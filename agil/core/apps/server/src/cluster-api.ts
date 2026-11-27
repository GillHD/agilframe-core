/**
 * Machine-to-machine enrollment endpoints (no admin API key):
 *
 *   POST /v1/cluster/join             standby Core joins with a `core` token
 *   POST /v1/nodes/register           node registers with a `node` token
 *   POST /v1/nodes/:id/heartbeat      node liveness with its per-node key
 *
 * The enrollment token (or node key) is the only credential. The token's tenant
 * scopes the resulting registry entry; nothing is accepted from headers. The
 * plaintext token/node key is never logged or echoed back by any other route.
 */
import {
  NODE_HEARTBEAT_INTERVAL_SEC,
  clusterJoinRequestSchema,
  clusterPaths,
  nodeHeartbeatRequestSchema,
  nodeRegisterRequestSchema,
} from '@agil/protocol';
import { assertRateLimit, bearerToken, header } from './auth.js';
import { HttpError, safeAudit, type RequestContext, type Router } from './http.js';

/** Reads the per-node credential from `x-node-token` (or `Authorization: Bearer`). */
function nodeCredentialValue(ctx: RequestContext): string | null {
  const explicit = header(ctx.headers, 'x-node-token');
  if (explicit && explicit.trim()) return explicit.trim();
  return bearerToken(ctx.headers);
}

function nodeCredential(ctx: RequestContext): string {
  const credential = nodeCredentialValue(ctx);
  if (credential) return credential;
  throw new HttpError(401, 'unauthorized', 'Missing node credential (x-node-token)');
}

/** Enrollment (join/register) is IP-scoped: 120/min per client IP by default. */
function limitEnrollment(ctx: RequestContext): void {
  assertRateLimit(
    ctx.services.limiters.enrollment.check(`cluster:${ctx.ipHash}`),
    ctx,
    'Too many enrollment requests',
  );
}

/**
 * Outer heartbeat bucket: **every** attempt is charged against the client IP
 * before the credential is hashed or validated, so a client sending a fresh
 * bogus `x-node-token` per request still shares one bucket.
 */
function limitHeartbeatAttempt(ctx: RequestContext): void {
  assertRateLimit(
    ctx.services.limiters.heartbeatIp.check(`heartbeat-ip:${ctx.ipHash}`),
    ctx,
    'Too many heartbeat requests from this address',
  );
}

/**
 * Per-node bucket (contract 2 beats/min, default allowance 10/min), charged
 * only after the credential has authenticated as this node. The key is
 * `tenantId + nodeId`: node ids are unique per tenant only, so same-id nodes of
 * different tenants must not share one bucket. A caller cannot mint per-node
 * buckets with invalid keys; a third party that knows a node id cannot exhaust
 * its bucket without also holding its key.
 */
function limitHeartbeatNode(ctx: RequestContext, tenantId: string, nodeId: string): void {
  assertRateLimit(
    ctx.services.limiters.heartbeat.check(`heartbeat:${tenantId}:${nodeId}`),
    ctx,
    'Too many heartbeat requests for this node',
  );
}

async function joinHandler(ctx: RequestContext): Promise<void> {
  limitEnrollment(ctx);
  const body = await ctx.jsonSchema(clusterJoinRequestSchema);
  const result = ctx.cluster.joinCluster({ request: body, publicOrigin: ctx.env.publicOrigin });
  safeAudit(ctx.logger, ctx.services.audit, {
    type: 'admin.action',
    severity: 'info',
    tenantId: result.standby.tenantId,
    ip: ctx.ip,
    message: `Standby Core joined the cluster: ${result.standby.id}`,
    details: {
      kind: 'cluster.join',
      standbyId: result.standby.id,
      clusterId: result.cluster.id,
      version: result.standby.version,
    },
  });
  ctx.send(200, result);
}

async function registerHandler(ctx: RequestContext): Promise<void> {
  limitEnrollment(ctx);
  const body = await ctx.jsonSchema(nodeRegisterRequestSchema);
  const result = ctx.cluster.registerNode({ request: body });
  safeAudit(ctx.logger, ctx.services.audit, {
    type: 'admin.action',
    severity: 'info',
    tenantId: result.node.tenantId,
    ip: ctx.ip,
    message: `Node registered: ${result.node.id} (${result.node.role})`,
    details: {
      kind: 'cluster.node.registered',
      nodeId: result.node.id,
      role: result.node.role,
      features: result.node.features,
      endpoint: result.node.endpoint,
    },
  });
  // 201: a node record was created; `nodeKey` is shown exactly once.
  ctx.send(201, result);
}

async function heartbeatHandler(ctx: RequestContext): Promise<void> {
  // Charged first and for every attempt, valid credential or not.
  limitHeartbeatAttempt(ctx);
  const body = await ctx.jsonSchema(nodeHeartbeatRequestSchema);
  const nodeId = ctx.params.nodeId as string;
  const outcome = ctx.cluster.heartbeat({
    rawKey: nodeCredential(ctx),
    nodeId,
    body,
    // Per-node bucket only after the credential proved it belongs to this node;
    // the tenant scopes the key so same-id nodes of other tenants are unaffected.
    onAuthenticated: (node) => limitHeartbeatNode(ctx, node.tenantId, node.id),
  });
  // Module command acknowledgements are audited here (the heartbeat itself is
  // too frequent to audit): operator-visible proof that a queued Docker action
  // reached the node and what it reported. The node-supplied error text is
  // never copied into the audit record.
  for (const ack of outcome.acknowledgedModuleResults) {
    safeAudit(ctx.logger, ctx.services.audit, {
      type: 'admin.action',
      severity: ack.result.ok ? 'info' : 'warn',
      tenantId: outcome.node.tenantId,
      ip: ctx.ip,
      message: `Node module ${ack.command.action} result for ${ack.command.moduleId} (${ack.result.ok ? 'ok' : 'failed'})`,
      details: {
        kind: 'cluster.node.module.result',
        nodeId: outcome.node.id,
        moduleId: ack.command.moduleId,
        action: ack.command.action,
        commandId: ack.command.id,
        ok: ack.result.ok,
        status: ack.result.status,
        hasError: Boolean(ack.result.error),
      },
    });
  }
  const start = outcome.automaticSfuStart;
  if (start) {
    safeAudit(ctx.logger, ctx.services.audit, {
      type: 'admin.action',
      severity: 'info',
      tenantId: outcome.node.tenantId,
      ip: ctx.ip,
      message: `Node module start queued after SFU drain: ${outcome.node.id}/sfu`,
      details: {
        kind: 'cluster.node.module.command',
        nodeId: outcome.node.id,
        moduleId: start.moduleId,
        action: start.action,
        commandId: start.id,
        targetContainerId: start.targetContainerId,
        expiresAt: start.expiresAt,
        source: 'graceful_sfu_restart',
      },
    });
  }
  ctx.send(200, {
    node: outcome.node,
    drain: outcome.node.drain,
    heartbeatIntervalSec: NODE_HEARTBEAT_INTERVAL_SEC,
    serverTime: Date.now(),
    moduleCommands: outcome.moduleCommands,
  });
}

/** Registers the enrollment surface (called from index.ts, outside `/v1/admin`). */
export function registerClusterRoutes(router: Router): void {
  router.post(clusterPaths.join, joinHandler);
  router.post(clusterPaths.nodeRegister, registerHandler);
  router.post('/v1/nodes/:nodeId/heartbeat', heartbeatHandler);
}
