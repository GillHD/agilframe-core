/**
 * Edge machine surface (no admin API key):
 *
 *   POST /v1/edge/join   redeem an Edge enrollment token
 *
 * The token is the only credential; its tenant scopes the resulting room, join
 * token and egress jobs. The response never contains an RTMP URL/stream key —
 * the Edge publishes media once to the returned room and the server derives
 * every configured stream destination from that room.
 *
 * The path is registered as an enrollment surface in `http.ts`, so the optional
 * `AGIL_ENROLL_ALLOW_IPS` allowlist applies.
 */
import { edgeJoinRequestSchema } from '@agil/protocol';
import { assertRateLimit } from './auth.js';
import type { RequestContext, Router } from './http.js';

async function edgeJoinHandler(ctx: RequestContext): Promise<void> {
  assertRateLimit(
    ctx.services.limiters.enrollment.check(`edge:${ctx.ipHash}`),
    ctx,
    'Too many edge join requests',
  );
  // A standby Core may hold a stale routing file/room registry: no Edge join
  // (room creation + egress start) may run there (fail closed, 409 not_leader).
  ctx.cluster.assertLeader('edge join');
  const body = await ctx.jsonSchema(edgeJoinRequestSchema);
  const result = await ctx.routing.joinEdge({ request: body, ip: ctx.ip });
  ctx.send(200, result);
}

/** Registers the Edge surface (called from index.ts, outside `/v1/admin`). */
export function registerEdgeRoutes(router: Router): void {
  router.post('/v1/edge/join', edgeJoinHandler);
}
