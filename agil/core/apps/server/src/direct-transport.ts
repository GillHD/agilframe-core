/**
 * Explicit transport for direct (1:1) rooms.
 *
 * `transport:'p2p'` is a hard product decision, not a hint: the room is created
 * on the mesh media plane with exactly two seats. Anything that only the server
 * media plane can do (egress recording, RTMP/HLS streaming, webinars) is
 * rejected with a clear 409 before the room exists — silently creating a mesh
 * room that can never start egress would be worse than failing.
 *
 * Local/client-side recording (`features.recording`) is *not* blocked: it runs
 * in the browser and does not need an SFU. See `docs/p2p.md`.
 */
import type { MediaMode, RoomMode, TenantConfig, TenantConfigPatch } from '@agil/protocol';
import { HttpError } from './http.js';

export type RoomTransport = 'p2p' | 'sfu';

export interface DirectTransportPlan {
  /** `mesh` for p2p; undefined means "keep the current effective media plane". */
  mediaMode?: MediaMode;
  /** `2` for p2p; undefined means "keep the current cap calculation". */
  maxParticipants?: number;
}

export interface DirectTransportInput {
  transport?: RoomTransport;
  mode: RoomMode;
  maxParticipants?: number;
  config: TenantConfig;
  configOverrides?: TenantConfigPatch;
}

type Blocker = 'egress' | 'streaming' | 'webinar';

interface TransportOverrides {
  mediaProcessing?: { egress?: boolean };
  scale?: {
    streaming?: { enabled?: boolean };
    webinar?: { enabled?: boolean };
  };
}

/** Effective server-side feature flags (tenant config + per-room overrides). */
function serverSfuOnlyFeature(input: DirectTransportInput): Blocker | null {
  const overrides = input.configOverrides as TransportOverrides | undefined;
  const egress = overrides?.mediaProcessing?.egress ?? input.config.mediaProcessing.egress;
  if (egress) return 'egress';
  const streaming = overrides?.scale?.streaming?.enabled ?? input.config.scale.streaming.enabled;
  if (streaming) return 'streaming';
  const webinar = overrides?.scale?.webinar?.enabled ?? input.config.scale.webinar.enabled;
  if (webinar) return 'webinar';
  return null;
}

function unsupportedMessage(blocker: Blocker): string {
  const feature =
    blocker === 'egress'
      ? 'server-side egress recording'
      : blocker === 'streaming'
        ? 'server-side RTMP/HLS streaming'
        : 'webinar/broadcast mode';
  return (
    `P2P direct calls cannot use ${feature}: it needs an SFU media plane. ` +
    "Disable it for this room, or create the room with transport:'sfu'. " +
    'Local (client-side) recording is unaffected and still works in a P2P call.'
  );
}

/**
 * Validates `transport` and returns the overrides to apply when creating the
 * room. Throws:
 *  - 400 `validation_failed` for group mode, p2p with more than two seats, or an
 *    unknown transport shape (zod rejects the latter earlier);
 *  - 409 `p2p_unsupported` when the tenant/room needs server media features.
 */
export function resolveDirectTransport(input: DirectTransportInput): DirectTransportPlan {
  const { transport, mode } = input;
  if (!transport) return {};
  if (mode !== 'direct') {
    throw new HttpError(
      400,
      'validation_failed',
      "transport is supported only for mode:'direct' (1:1) rooms; group rooms follow the tenant media plane",
      { transport, mode },
    );
  }
  if (transport === 'sfu') {
    // Current behaviour: the tenant's roomMediaMode() decides mesh vs sfu.
    return {};
  }
  if (input.maxParticipants !== undefined && input.maxParticipants > 2) {
    throw new HttpError(
      400,
      'validation_failed',
      "P2P direct rooms have exactly 2 seats; omit maxParticipants or set it to 2 (use transport:'sfu' for more participants)",
      { transport, maxParticipants: input.maxParticipants, limit: 2 },
    );
  }
  const blocker = serverSfuOnlyFeature(input);
  if (blocker) {
    throw new HttpError(409, 'p2p_unsupported', unsupportedMessage(blocker), {
      transport: 'p2p',
      feature: blocker,
      hint: "Use transport:'sfu' for server egress/streaming or webinars",
    });
  }
  return { mediaMode: 'mesh', maxParticipants: 2 };
}
