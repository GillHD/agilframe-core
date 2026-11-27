import { HttpError } from './http.js';
import type { IngressOwnership, IngressOwnershipStore, IngressScope } from './ingress-ownership.js';
import type { IngressTarget, RtmpIngressClient, RtmpIngressCredentials, IngressHandle, IngressStatus, PullIngressClient } from './ingress.js';
import type { PullIngressSource } from './ingress-sources.js';

type IngressRoom = { tenantId: string; id: string };
type IngressControl = Pick<RtmpIngressClient, 'findOwned' | 'revoke' | 'status'>;

/** Coordinates the Redis reservation with LiveKit. Callers authorize the flow and room before entering. */
class IngressLifecycle {
  constructor(
    private readonly store: IngressOwnershipStore,
    private readonly ingress: IngressControl,
  ) {}

  protected async createReceiver<T extends { handle: IngressHandle }>(
    scope: IngressScope, room: IngressRoom, start: (target: IngressTarget) => Promise<T>,
  ): Promise<T> {
    const reservation = await this.store.reserve(scope, room);
    const target = { roomName: reservation.roomName, participantIdentity: reservation.participantIdentity };
    const result = await start(target);
    await this.store.bind(reservation, result.handle);
    return result;
  }

  async recover(scope: IngressScope): Promise<IngressOwnership | null> {
    const reservation = await this.store.get(scope);
    if (!reservation || reservation.phase !== 'provisioning') return reservation;
    const handle = await this.ingress.findOwned(reservation);
    // No remote record yet can mean the previous CreateIngress request is still in flight.
    // Keep the reservation so a retry cannot create another receiver or complete a premature deletion.
    if (!handle) return reservation;
    try {
      return await this.store.bind(reservation, handle);
    } catch (error) {
      if (!ownershipChanged(error)) throw error;
      const current = await this.store.get(scope);
      if (current?.participantIdentity === reservation.participantIdentity
        && current.phase !== 'provisioning' && current.ingressId === handle.id) return current;
      throw error;
    }
  }

  async status(scope: IngressScope): Promise<IngressStatus | 'absent' | 'provisioning' | 'revoking' | 'missing'> {
    const ownership = await this.recover(scope);
    if (!ownership) return 'absent';
    if (ownership.phase !== 'bound') return ownership.phase;
    return await this.ingress.status({
      id: ownership.ingressId, roomName: ownership.roomName, participantIdentity: ownership.participantIdentity,
    }) ?? 'missing';
  }

  async revoke(scope: IngressScope): Promise<'complete' | 'pending'> {
    const ownership = await this.recover(scope);
    if (!ownership) return 'complete';
    if (ownership.phase === 'provisioning') return 'pending';
    let revoking = ownership;
    if (ownership.phase === 'bound') {
      try {
        revoking = await this.store.beginRevoke(ownership);
      } catch (error) {
        if (!ownershipChanged(error)) throw error;
        const current = await this.store.get(scope);
        if (!current) return 'complete';
        if (current.phase !== 'revoking' || current.participantIdentity !== ownership.participantIdentity
          || current.ingressId !== ownership.ingressId) throw error;
        revoking = current;
      }
    }
    if (revoking.phase !== 'revoking') throw new Error('RTMP Ingress is not ready for revocation');
    const handle = { id: revoking.ingressId, roomName: revoking.roomName, participantIdentity: revoking.participantIdentity };
    await this.ingress.revoke(handle);
    if (await this.ingress.status(handle) !== null) return 'pending';
    try {
      await this.store.finishRevoke(revoking);
    } catch (error) {
      if (!ownershipChanged(error) || await this.store.get(scope)) throw error;
    }
    return 'complete';
  }
}

export class RtmpIngressLifecycle extends IngressLifecycle {
  constructor(store: IngressOwnershipStore, private readonly client: Pick<RtmpIngressClient, 'create'> & IngressControl) {
    super(store, client);
  }

  create(scope: IngressScope, room: IngressRoom): Promise<RtmpIngressCredentials> {
    return this.createReceiver(scope, room, (target) => this.client.create(target));
  }
}

export class PullIngressLifecycle extends IngressLifecycle {
  constructor(store: IngressOwnershipStore, private readonly client: Pick<PullIngressClient, 'create'> & IngressControl) {
    super(store, client);
  }

  async create(scope: IngressScope, room: IngressRoom, binding: PullIngressSource): Promise<void> {
    if (binding.tenantId !== scope.tenantId) throw new HttpError(404, 'not_found', 'Ingress source not found');
    await this.createReceiver(scope, room, (target) => this.client.create(target, binding));
  }
}

function ownershipChanged(error: unknown): boolean {
  return error instanceof HttpError && error.code === 'ingress_ownership_changed';
}
