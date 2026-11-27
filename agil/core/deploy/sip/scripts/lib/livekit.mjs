/**
 * Local SIP lab — LiveKit Twirp helpers (operator tooling only).
 *
 * The app has no trunk/dispatch-rule CRUD (by design: they are external
 * infrastructure). The lab therefore creates them directly over the same Twirp
 * API the app uses, with an operator JWT:
 *
 *   video: { roomList, roomCreate, rooms admin }  — rooms/participants
 *   sip:   { admin: true }                        — trunk + dispatch-rule CRUD
 *
 * Secrets/key handling mirrors apps/server/src/sip.ts: HS256, short-lived,
 * never printed.
 */
import { createHmac } from 'node:crypto';

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/** Builds a short-lived HS256 LiveKit JWT for the lab operator. */
export function operatorToken(config, ttlSec = 120) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: config.apiKey,
      sub: 'agil-sip-lab',
      nbf: now - 5,
      exp: now + ttlSec,
      video: { roomList: true, roomCreate: true, roomAdmin: true },
      sip: { admin: true },
    }),
  );
  const signature = createHmac('sha256', config.apiSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/**
 * Room-scoped admin token. LiveKit's `roomAdmin` grant only applies to the
 * room named in `video.room` (an empty room does not mean "all rooms"), so the
 * participant helpers below must use this instead of {@link operatorToken}.
 */
export function roomToken(config, roomName, ttlSec = 120, { sipCall = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: config.apiKey,
      sub: 'agil-sip-lab',
      nbf: now - 5,
      exp: now + ttlSec,
      video: { room: roomName, roomAdmin: true },
      ...(sipCall ? { sip: { call: true } } : {}),
    }),
  );
  const signature = createHmac('sha256', config.apiSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export class TwirpError extends Error {
  constructor(service, method, status, text) {
    super(`LiveKit ${service}/${method} failed (HTTP ${status}): ${String(text).slice(0, 300)}`);
    this.name = 'TwirpError';
    this.service = service;
    this.method = method;
    this.status = status;
  }
}

/** POSTs a Twirp JSON request; throws a readable error on non-2xx. */
export async function twirp(config, service, method, body = {}, token = operatorToken(config)) {
  const response = await fetch(`${config.livekitUrl}/twirp/${service}/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new TwirpError(service, method, response.status, text);
  return text ? JSON.parse(text) : {};
}

/* ------------------------------- trunks ---------------------------------- */

export async function listOutboundTrunks(config) {
  const response = await twirp(config, 'livekit.SIP', 'ListSIPOutboundTrunk', {});
  return Array.isArray(response.items) ? response.items : [];
}

export async function listInboundTrunks(config) {
  const response = await twirp(config, 'livekit.SIP', 'ListSIPInboundTrunk', {});
  return Array.isArray(response.items) ? response.items : [];
}

export async function createOutboundTrunk(config, trunk) {
  const response = await twirp(config, 'livekit.SIP', 'CreateSIPOutboundTrunk', { trunk });
  return response.sip_trunk_id ?? response;
}

export async function createInboundTrunk(config, trunk) {
  const response = await twirp(config, 'livekit.SIP', 'CreateSIPInboundTrunk', { trunk });
  return response.sip_trunk_id ?? response;
}

export async function deleteTrunk(config, trunkId) {
  await twirp(config, 'livekit.SIP', 'DeleteSIPTrunk', { sip_trunk_id: trunkId });
}

/**
 * Returns an existing outbound trunk with the same name/address or creates it.
 * Idempotent so the lab can be re-run without piling up trunks.
 */
export async function ensureOutboundTrunk(config, spec) {
  const existing = (await listOutboundTrunks(config)).find(
    (entry) => entry.name === spec.name && entry.address === spec.address,
  );
  if (existing && spec.transport === 'SIP_TRANSPORT_TLS' &&
    (existing.transport !== spec.transport || existing.media_encryption !== spec.media_encryption)) {
    throw new Error('Existing SIP lab trunk does not require TLS and SRTP. Use a separate trunk name for the secure lab.');
  }
  if (existing) return { id: existing.sip_trunk_id, created: false, trunk: existing };
  const id = await createOutboundTrunk(config, spec);
  return { id, created: true };
}

/* --------------------------- dispatch rules ------------------------------ */

export async function listDispatchRules(config) {
  const response = await twirp(config, 'livekit.SIP', 'ListSIPDispatchRule', {});
  return Array.isArray(response.items) ? response.items : [];
}

/**
 * Creates a direct dispatch rule: calls to `numbers` on `trunkIds` land in
 * `roomName`. `hidePhoneNumber` (default) keeps the caller number out of the
 * LiveKit identity so the app can list/stop the inbound participant like any
 * other; pass `false` to exercise the phone-like-identity path.
 */
export async function createDirectDispatchRule(config, { name, trunkIds, numbers, roomName, hidePhoneNumber = true }) {
  const response = await twirp(config, 'livekit.SIP', 'CreateSIPDispatchRule', {
    dispatch_rule: {
      name,
      rule: { dispatch_rule_direct: { room_name: roomName } },
      trunk_ids: trunkIds,
      numbers,
      hide_phone_number: hidePhoneNumber,
    },
  });
  return response.sip_dispatch_rule_id ?? response;
}

/**
 * Creates an "individual" rule: each call gets a new room named
 * `<roomPrefix>_<random>`. Used by lab-init for ad-hoc softphone tests; the e2e
 * script uses a direct rule so the call lands in a known app room.
 */
export async function createIndividualDispatchRule(config, { name, trunkIds, numbers, roomPrefix }) {
  const response = await twirp(config, 'livekit.SIP', 'CreateSIPDispatchRule', {
    dispatch_rule: {
      name,
      rule: { dispatch_rule_individual: { room_prefix: roomPrefix, no_randomness: false } },
      trunk_ids: trunkIds,
      numbers,
      hide_phone_number: true,
    },
  });
  return response.sip_dispatch_rule_id ?? response;
}

export async function deleteDispatchRule(config, ruleId) {
  await twirp(config, 'livekit.SIP', 'DeleteSIPDispatchRule', { sip_dispatch_rule_id: ruleId });
}

/* ------------------------ rooms and participants ------------------------- */

export async function listRooms(config) {
  const response = await twirp(config, 'livekit.RoomService', 'ListRooms', {});
  return Array.isArray(response.rooms) ? response.rooms : [];
}

/** Raw ParticipantInfo entries of a LiveKit room (includes SIP participants). */
export async function listParticipants(config, roomName) {
  const response = await twirp(
    config,
    'livekit.RoomService',
    'ListParticipants',
    { room: roomName },
    roomToken(config, roomName),
  );
  return Array.isArray(response.participants) ? response.participants : [];
}

export async function removeParticipant(config, roomName, identity) {
  await twirp(
    config,
    'livekit.RoomService',
    'RemoveParticipant',
    { room: roomName, identity },
    roomToken(config, roomName),
  );
}

/** Proves the Twirp API (and therefore the SIP service behind it) is reachable. */
export async function probe(config) {
  const rooms = await listRooms(config);
  return rooms.length;
}

/** True when a participant object is a SIP participant (kind 3 or sip.* attributes). */
export function isSipParticipant(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (raw.kind === 3 || raw.kind === 'SIP' || raw.kind === 'sip') return true;
  const attributes = raw.attributes;
  return Boolean(
    attributes &&
      typeof attributes === 'object' &&
      Object.keys(attributes).some((key) => key.toLowerCase().startsWith('sip.')),
  );
}
