import { createHash, randomBytes } from 'node:crypto';
import { flowIdSchema, routingRoomIdSchema } from '@agil/protocol';
import { z } from 'zod';
import { HttpError } from './http.js';
import type { IngressHandle } from './ingress.js';
import type { LeaderElector } from './leader.js';
import { sfuRoomName } from './sfu.js';

const scopeSchema = z.object({
  tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  flowId: flowIdSchema,
});
export type IngressScope = z.infer<typeof scopeSchema>;

const baseSchema = scopeSchema.extend({
  roomId: routingRoomIdSchema,
  roomName: z.string().min(1),
  participantIdentity: z.string().regex(/^agil-(?:rtmp|srt|hls)-[0-9a-f]{32}$/),
});
const provisioningSchema = baseSchema.extend({ phase: z.literal('provisioning') }).strict();
const boundSchema = baseSchema.extend({ phase: z.literal('bound'), ingressId: z.string().min(1).max(256) }).strict();
const revokingSchema = boundSchema.extend({ phase: z.literal('revoking') });
const recordSchema = z.discriminatedUnion('phase', [provisioningSchema, boundSchema, revokingSchema]);
type Provisioning = z.infer<typeof provisioningSchema>;
type Bound = z.infer<typeof boundSchema>;
type Revoking = z.infer<typeof revokingSchema>;
export type IngressOwnership = z.infer<typeof recordSchema>;

function keyFor(scope: IngressScope, transport: 'rtmp' | 'srt' | 'hls'): string {
  const parsed = scopeSchema.safeParse(scope);
  if (!parsed.success) throw new HttpError(400, 'invalid_ingress_scope', 'Invalid RTMP Ingress scope');
  const digest = createHash('sha256').update(JSON.stringify([scope.tenantId, scope.flowId])).digest('hex');
  return `${transport}-ingress:${digest}`;
}

function roomFor(tenantId: string, roomId: string): string | null {
  // Managed receivers cannot choose a name with an ambiguous legacy tenant/room separator.
  if (tenantId.includes('__') || roomId.includes('__') || !routingRoomIdSchema.safeParse(roomId).success) {
    return null;
  }
  return sfuRoomName(tenantId, roomId);
}

/** Ownership only. The caller must validate the saved flow and reconcile the external operation. */
export class IngressOwnershipStore {
  constructor(
    private readonly leader: Pick<LeaderElector, 'leaderValue'>,
    private readonly transport: 'rtmp' | 'srt' | 'hls' = 'rtmp',
  ) {}

  async get(scope: IngressScope): Promise<IngressOwnership | null> {
    const { value } = await this.leader.leaderValue(keyFor(scope, this.transport));
    if (value === null) return null;
    let stored: unknown;
    try {
      stored = JSON.parse(value);
    } catch {
      throw new HttpError(503, 'invalid_ingress_ownership', 'Stored RTMP Ingress ownership is invalid');
    }
    const record = recordSchema.safeParse(stored);
    if (!record.success || record.data.tenantId !== scope.tenantId || record.data.flowId !== scope.flowId
      || !record.data.participantIdentity.startsWith(`agil-${this.transport}-`)
      || record.data.roomName !== roomFor(record.data.tenantId, record.data.roomId)) {
      throw new HttpError(503, 'invalid_ingress_ownership', 'Stored RTMP Ingress ownership is invalid');
    }
    return record.data;
  }

  async reserve(scope: IngressScope, room: { tenantId: string; id: string }): Promise<Provisioning> {
    const key = keyFor(scope, this.transport);
    if (room.tenantId !== scope.tenantId) {
      throw new HttpError(403, 'foreign_ingress_room', 'RTMP Ingress room belongs to another organization');
    }
    const roomName = roomFor(scope.tenantId, room.id);
    if (!roomName) {
      throw new HttpError(409, 'ambiguous_ingress_room', 'RTMP Ingress requires an unambiguous SFU room name');
    }
    const reservation: Provisioning = {
      tenantId: scope.tenantId,
      flowId: scope.flowId,
      roomId: room.id,
      roomName,
      participantIdentity: `agil-${this.transport}-${randomBytes(16).toString('hex')}`,
      phase: 'provisioning',
    };
    const result = await this.leader.leaderValue(key, { expected: null, next: JSON.stringify(reservation) });
    if (!result.changed) throw new HttpError(409, 'ingress_already_reserved', 'This flow already owns an RTMP receiver');
    return reservation;
  }

  async bind(reservation: Provisioning, handle: IngressHandle): Promise<Bound> {
    const current = provisioningSchema.parse(reservation);
    if (reservation.roomName !== handle.roomName || reservation.participantIdentity !== handle.participantIdentity) {
      throw new HttpError(409, 'ingress_binding_mismatch', 'RTMP receiver does not match the reservation');
    }
    const bound = boundSchema.parse({ ...current, phase: 'bound', ingressId: handle.id });
    await this.transition(current, bound);
    return bound;
  }

  async beginRevoke(bound: Bound): Promise<Revoking> {
    const current = boundSchema.parse(bound);
    const revoking = revokingSchema.parse({ ...current, phase: 'revoking' });
    await this.transition(current, revoking);
    return revoking;
  }

  /** Called after the provider confirms that the receiver is gone. */
  async finishRevoke(revoking: Revoking): Promise<void> {
    await this.transition(revokingSchema.parse(revoking), null);
  }

  private async transition(current: IngressOwnership, next: IngressOwnership | null): Promise<void> {
    const result = await this.leader.leaderValue(keyFor(current, this.transport), {
      expected: JSON.stringify(current),
      next: next === null ? null : JSON.stringify(next),
    });
    if (!result.changed) throw new HttpError(409, 'ingress_ownership_changed', 'RTMP Ingress ownership changed');
  }
}

export { IngressOwnershipStore as RtmpIngressOwnershipStore };
