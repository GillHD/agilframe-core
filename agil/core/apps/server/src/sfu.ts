/**
 * SFU media plane (LiveKit-compatible) session issuing.
 *
 * The signaling server stays the control plane: when the effective media mode
 * is `sfu`/`broadcast` and the SFU is configured (env first, then the tenant
 * `scale.sfu` config), the join response and the WebSocket welcome carry a
 * short-lived HS256 JWT and the SFU URL. Tokens are never logged.
 */
import { createHmac } from 'node:crypto';
import {
  DEFAULT_SFU_CAPACITY_PROFILE,
  SFU_CAPACITY_PROFILES,
  effectiveMediaMode,
  resolveSfuCapacityProfile,
  type CapacityLimit,
  type MediaMode,
  type ParticipantCapacity,
  type Role,
  type SfuCapacityProfile,
  type SfuMediaSession,
  type TenantConfig,
} from '@agil/protocol';
import type { Env } from './env.js';
import { resolveTenantSecret } from './secret-env.js';

export interface SfuSettings {
  enabled: boolean;
  url: string;
  apiKey: string;
  apiSecret: string;
  provider: string;
  /** Why the SFU is unavailable (for diagnostics, no secrets). */
  reason?: string;
}

/** Resolves the effective SFU settings (env overrides tenant scale config). */
export function resolveSfuSettings(env: Env, config: TenantConfig): SfuSettings {
  const sfu = config.scale.sfu;
  const url = (env.sfuUrl || sfu.url).trim();
  // Tenant-selected names are resolved from the startup snapshot and only in
  // the `AGIL_SFU_*` namespace (never `process.env[name]`).
  const apiKey = env.sfuApiKey || resolveTenantSecret(env, sfu.apiKeyEnv, 'sfu').value || '';
  const apiSecret = env.sfuApiSecret || resolveTenantSecret(env, sfu.apiSecretEnv, 'sfu').value || '';
  if (!env.sfuEnabled) return { enabled: false, url, apiKey, apiSecret, provider: sfu.provider, reason: 'sfu_disabled' };
  if (!url) return { enabled: false, url, apiKey, apiSecret, provider: sfu.provider, reason: 'sfu_url_missing' };
  if (!apiKey || !apiSecret) {
    return { enabled: false, url, apiKey, apiSecret, provider: sfu.provider, reason: 'sfu_credentials_missing' };
  }
  return { enabled: true, url, apiKey, apiSecret, provider: sfu.provider };
}

/** True when the SFU can actually be used for this tenant. */
export function sfuConfigured(env: Env, config: TenantConfig): boolean {
  return resolveSfuSettings(env, config).enabled;
}

/**
 * Effective gallery capacity profile: `AGIL_SFU_PROFILE` env (deployment size)
 * → tenant `scale.sfu.capacityProfile` → `standard`. Unknown values fall back
 * to the default.
 */
export function effectiveSfuCapacityProfile(env: Env, config: TenantConfig): SfuCapacityProfile {
  if (env.sfuProfile) return env.sfuProfile;
  return resolveSfuCapacityProfile(config.scale?.sfu?.capacityProfile ?? DEFAULT_SFU_CAPACITY_PROFILE);
}

/**
 * Tenant config as a client should see it, with the effective capacity profile
 * applied (env wins over `scale.sfu.capacityProfile`). Does not mutate the
 * stored config and only allocates when the effective value differs.
 */
export function applySfuCapacityProfile(env: Env, config: TenantConfig): TenantConfig {
  const profile = effectiveSfuCapacityProfile(env, config);
  if (config.scale.sfu.capacityProfile === profile) return config;
  return {
    ...config,
    scale: {
      ...config.scale,
      sfu: { ...config.scale.sfu, capacityProfile: profile },
    },
  };
}

/** Smallest valid participant cap accepted by the config schemas. */
const MIN_PARTICIPANTS = 2;

function participantLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_PARTICIPANTS
    ? Math.trunc(value)
    : fallback;
}

/**
 * Capacity guard shared by room creation and join: the effective SFU cap is the
 * smaller of the profile and the tenant `scale.sfu.maxParticipants`. The SFU
 * profile applies to sfu/broadcast rooms even while `sfuConfigured` is false
 * (`scale.mediaMode` declares the intended media plane); mesh rooms are limited
 * by the tenant `scale.maxParticipants` only.
 */
export function sfuParticipantLimit(env: Env, config: TenantConfig): number {
  const profile = effectiveSfuCapacityProfile(env, config);
  const profileParticipants = SFU_CAPACITY_PROFILES[profile].participants;
  return Math.min(profileParticipants, participantLimit(config.scale?.sfu?.maxParticipants, profileParticipants));
}

/**
 * Full capacity breakdown for one room: `min(room, scale, profile, sfu)` for
 * SFU/broadcast, `min(room, scale)` for mesh. `limit` names the binding
 * constraint (see `capacityLimitMessage`).
 */
export function roomCapacityInfo(
  env: Env,
  config: TenantConfig,
  mediaMode: MediaMode,
  roomMaxParticipants: number,
): ParticipantCapacity {
  const roomLimit = participantLimit(roomMaxParticipants, MIN_PARTICIPANTS);
  const scaleLimit = participantLimit(config.scale?.maxParticipants, roomLimit);
  const profile = effectiveSfuCapacityProfile(env, config);
  const profileParticipants = SFU_CAPACITY_PROFILES[profile].participants;
  const sfuMaxParticipants = participantLimit(config.scale?.sfu?.maxParticipants, profileParticipants);
  const sfuLimit = Math.min(profileParticipants, sfuMaxParticipants);

  // Candidate order is the documented tie-break: a cap equal to the profile is
  // reported as `profile`, not as a room/scale/sfu tie.
  const candidates: Array<{ limit: CapacityLimit; value: number }> =
    mediaMode === 'mesh'
      ? [
          { limit: 'scale', value: scaleLimit },
          { limit: 'room', value: roomLimit },
        ]
      : [
          { limit: 'profile', value: profileParticipants },
          { limit: 'sfu', value: sfuLimit },
          { limit: 'scale', value: scaleLimit },
          { limit: 'room', value: roomLimit },
        ];
  let binding = candidates[0]!;
  for (const candidate of candidates) {
    if (candidate.value < binding.value) binding = candidate;
  }
  return {
    effectiveMaxParticipants: binding.value,
    limit: binding.limit,
    profile,
    profileParticipants,
    roomMaxParticipants: roomLimit,
    scaleMaxParticipants: scaleLimit,
    sfuMaxParticipants,
  };
}

/** Effective participant cap for a room: see {@link roomCapacityInfo}. */
export function effectiveRoomCapacity(
  env: Env,
  config: TenantConfig,
  mediaMode: MediaMode,
  roomMaxParticipants: number,
): number {
  return roomCapacityInfo(env, config, mediaMode, roomMaxParticipants).effectiveMaxParticipants;
}

/** Clamps a requested room limit to the effective capacity (creation time). */
export function capRoomParticipantsForSfu(
  env: Env,
  config: TenantConfig,
  mediaMode: MediaMode,
  requested: number,
): number {
  return effectiveRoomCapacity(env, config, mediaMode, requested);
}

/** Human-readable `room_full` reason that names the binding capacity limit. */
export function capacityLimitMessage(capacity: ParticipantCapacity): string {
  switch (capacity.limit) {
    case 'profile':
      return `Room is full: capacity profile ${capacity.profile} allows ${capacity.profileParticipants} participants`;
    case 'sfu':
      return `Room is full: SFU maxParticipants is ${capacity.sfuMaxParticipants}`;
    case 'scale':
      return `Room is full: tenant scale.maxParticipants is ${capacity.scaleMaxParticipants}`;
    default:
      return `Room is full: room maxParticipants is ${capacity.roomMaxParticipants}`;
  }
}

/** LiveKit room name: tenant + room ids are already validated; strip separators. */
export function sfuRoomName(tenantId: string, roomId: string): string {
  return `${tenantId}__${roomId}`.replace(/[:/]/g, '_');
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

export function signLiveKitToken(apiSecret: string, claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac('sha256', apiSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Control grants may only go to the operator-configured SFU endpoint. */
async function callSfuRoomService(
  env: Env,
  operation: 'DeleteRoom' | 'RemoveParticipant',
  payload: { room: string; identity?: string },
  grant: { roomCreate: true } | { roomAdmin: true; room: string },
): Promise<boolean> {
  const controlUrl = env.sfuControlUrl || env.sfuUrl;
  if (!env.sfuEnabled || !controlUrl || !env.sfuApiKey || !env.sfuApiSecret) return false;
  const endpoint = new URL(controlUrl);
  if (endpoint.protocol === 'ws:') endpoint.protocol = 'http:';
  if (endpoint.protocol === 'wss:') endpoint.protocol = 'https:';
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Invalid LiveKit control endpoint');
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/twirp/livekit.RoomService/${operation}`;
  const now = Math.floor(Date.now() / 1000);
  const token = signLiveKitToken(env.sfuApiSecret, {
    iss: env.sfuApiKey,
    sub: 'agil-room-controller',
    nbf: now - 5,
    exp: now + 30,
    video: grant,
  });
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  await response.body?.cancel();
  if (operation === 'RemoveParticipant' && response.status === 404) return true;
  if (!response.ok) throw new Error(`LiveKit ${operation} returned HTTP ${response.status}`);
  return true;
}

export function closeSfuRoom(env: Env, tenantId: string, roomId: string): Promise<boolean> {
  return callSfuRoomService(env, 'DeleteRoom', { room: sfuRoomName(tenantId, roomId) }, { roomCreate: true });
}

export function removeSfuParticipant(env: Env, tenantId: string, roomId: string, participantId: string): Promise<boolean> {
  const room = sfuRoomName(tenantId, roomId);
  return callSfuRoomService(env, 'RemoveParticipant', { room, identity: participantId }, { roomAdmin: true, room });
}

export interface SfuSessionInput {
  tenantId: string;
  roomId: string;
  participantId: string;
  name?: string;
  role: Role;
  canPublish: boolean;
  /** Requested lifetime; capped at 1 hour so a leaked token expires quickly. */
  ttlSec?: number;
  durationDeadlineAt?: number;
  config: TenantConfig;
  env: Env;
}

export interface E2eeKeyResult {
  key: string;
  algorithm: 'AES-GCM';
  keyIndex: number;
  /** 'env' = AGIL_E2EE_SECRET, 'fallback' = dev-only join-token secret. */
  source: 'env' | 'fallback';
}

/** Deterministic per-room E2EE key (same for every participant of the room). */
export function deriveE2eeKey(env: Env, tenantId: string, roomId: string): E2eeKeyResult {
  const source: 'env' | 'fallback' = env.e2eeSecret ? 'env' : 'fallback';
  const secret = env.e2eeSecret || env.tokenSecret;
  const key = createHmac('sha256', secret).update(`${tenantId}:${roomId}`, 'utf8').digest('base64url');
  return { key, algorithm: 'AES-GCM', keyIndex: 0, source };
}

export interface SfuSessionResult {
  media: SfuMediaSession;
  settings: SfuSettings;
}

/** HS256 JWT with LiveKit access-token claims. */
export function issueSfuSession(input: SfuSessionInput): SfuSessionResult | null {
  const settings = resolveSfuSettings(input.env, input.config);
  if (!settings.enabled) return null;
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.min(3600, Math.max(60, Math.trunc(input.ttlSec ?? 3600)));
  const expires = input.durationDeadlineAt === undefined
    ? now + ttl
    : Math.min(now + ttl, Math.ceil(input.durationDeadlineAt / 1000));
  if (expires <= now) return null;
  const room = sfuRoomName(input.tenantId, input.roomId);
  const token = signLiveKitToken(settings.apiSecret, {
    iss: settings.apiKey,
    sub: input.participantId,
    ...(input.name ? { name: input.name.slice(0, 120) } : {}),
    nbf: now,
    exp: expires,
    video: {
      room,
      roomJoin: true,
      canPublish: Boolean(input.canPublish),
      canSubscribe: true,
    },
  });
  const media: SfuMediaSession = {
    mode: 'sfu',
    url: settings.url,
    token,
    room,
    canPublish: Boolean(input.canPublish),
    expiresAt: expires * 1000,
  };
  // The E2EE key goes only into the media block — never into the LiveKit JWT,
  // logs or audit. Deterministic per room, so all participants derive the same key.
  if (input.config.security.e2ee) {
    const e2ee = deriveE2eeKey(input.env, input.tenantId, input.roomId);
    media.e2ee = { key: e2ee.key, algorithm: e2ee.algorithm, keyIndex: e2ee.keyIndex };
  }
  return { media, settings };
}

/**
 * Builds the media block for a join/welcome when the effective mode is SFU
 * (or broadcast) and the SFU is configured. Guests in a webinar/broadcast are
 * receive-only; hosts/moderators always publish.
 */
export function buildSfuMedia(
  env: Env,
  config: TenantConfig,
  input: {
    tenantId: string;
    roomId: string;
    participantId: string;
    name?: string;
    role: Role;
    ttlSec?: number;
    durationDeadlineAt?: number;
    sfuNodeId?: string;
    /**
     * Effective room plane (RoomInfo.mediaMode). Without it the tenant default
     * is used; a per-room P2P override must never receive a server media block.
     */
    mediaMode?: MediaMode;
  },
): SfuMediaSession | null {
  const mode = input.mediaMode ?? effectiveMediaMode(config.scale);
  if (mode !== 'sfu' && mode !== 'broadcast') return null;
  const viewerOnly =
    input.role === 'guest' &&
    (mode === 'broadcast' || (config.scale.webinar.enabled && config.scale.webinar.hostOnlyPublish));
  const result = issueSfuSession({
    env,
    config,
    tenantId: input.tenantId,
    roomId: input.roomId,
    participantId: input.participantId,
    ...(input.name ? { name: input.name } : {}),
    role: input.role,
    canPublish: !viewerOnly,
    ...(input.ttlSec !== undefined ? { ttlSec: input.ttlSec } : {}),
    durationDeadlineAt: input.durationDeadlineAt ?? Date.now() + config.limits.maxDurationMin * 60_000,
  });
  if (!result) return null;
  const endpoint = input.sfuNodeId && env.sfuNodeUrls.get(input.tenantId)?.get(input.sfuNodeId);
  if (!endpoint) return result.media;
  const shared = URL.canParse(result.media.url) ? new URL(result.media.url) : null;
  return {
    ...result.media,
    url: endpoint,
    ...(shared && (shared.protocol === 'ws:' || shared.protocol === 'wss:') &&
      !shared.username && !shared.password && !shared.search && !shared.hash && shared.href !== new URL(endpoint).href
      ? { fallbackUrl: shared.href } : {}),
  };
}
