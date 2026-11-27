/**
 * Capacity-profile-aware room limits.
 *
 * The deployed SFU profile is the media-plane capacity contract:
 *   low = 25, standard = 50, high = 200 participants per node.
 * The effective room cap is
 *   min(room.maxParticipants, scale.maxParticipants, profile.participants,
 *       scale.sfu.maxParticipants)
 * and must be enforced at room creation, REST join, lobby admit and the WS
 * token handshake. A full room returns 409 `room_full` with a reason that names
 * the binding limit (the capacity profile, not a generic "full").
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openWs, startTestServer, type TestServer } from './helpers.js';
import { offlineConnection } from '../src/rooms.js';
import type { Participant } from '@agil/protocol';

const ADMIN = { 'x-api-key': 'dev-key' };
const SFU = {
  sfuUrl: 'wss://sfu.test',
  sfuApiKey: 'sfu-key-123',
  sfuApiSecret: 'sfu-secret-456',
  sfuEnabled: true,
};

/** Started with the deployment env profile (`AGIL_SFU_PROFILE=low`). */
let low: TestServer;
/** No env; the capacity-profile default (`standard`) applies. */
let standard: TestServer;
/** Tenant `scale.sfu.capacityProfile='high'`. */
let high: TestServer;

before(async () => {
  process.env.AGIL_SFU_PROFILE = 'low';
  low = await startTestServer(SFU);
  delete process.env.AGIL_SFU_PROFILE;
  standard = await startTestServer(SFU);
  high = await startTestServer(SFU);
  await Promise.all([
    configure(low, {}),
    configure(standard, {}),
    configure(high, { sfu: { capacityProfile: 'high' } }),
  ]);
});

after(async () => {
  delete process.env.AGIL_SFU_PROFILE;
  await Promise.all([low.close(), standard.close(), high.close()]);
});

async function configure(ts: TestServer, extraScale: Record<string, unknown>): Promise<void> {
  const response = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { scale: { mediaMode: 'sfu', ...extraScale } },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

async function createRoom(ts: TestServer, body: Record<string, unknown>): Promise<{ id: string; maxParticipants: number }> {
  const response = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Capacity room', ...body } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.room;
}

/**
 * Fills seats without opening sockets: an offline member inside an active
 * resume-grace lease counts as seated (the same rule a dropped/reconnecting
 * participant uses). This keeps 25/50/200-seat tests fast and deterministic.
 */
function seatParticipants(ts: TestServer, roomId: string, count: number): void {
  const room = ts.server.rooms.get(roomId);
  assert.ok(room, `room ${roomId} exists`);
  const now = Date.now();
  for (let index = 0; index < count; index += 1) {
    const participant: Participant = {
      id: `seed-${index}`,
      name: `Seed ${index}`,
      role: 'guest',
      joinedAt: now,
      state: { mic: 'off', cam: 'off', screen: false, handRaised: false, network: 'good' },
      verified: false,
      integrity: 'unknown',
    };
    room.addMember(participant, offlineConnection({ joinedAt: now, seatReservedUntil: now + 5 * 60_000 }));
  }
  assert.equal(room.seatedParticipantCount(), count);
}

async function joinStatus(ts: TestServer, roomId: string, name = 'Guest'): Promise<any> {
  return ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name } });
}

async function adminScale(ts: TestServer): Promise<any> {
  const response = await ts.api('GET', '/v1/admin/scale', { headers: ADMIN });
  assert.equal(response.status, 200);
  return response.body;
}

test('low profile: 25 seats, 26th REST join and WS handshake get room_full/profile', async () => {
  const room = await createRoom(low, { maxParticipants: 200 });
  assert.equal(room.maxParticipants, 25, 'requested 200 is clamped to low profile participants');

  const detail = await low.api('GET', `/v1/admin/rooms/${room.id}`, { headers: ADMIN });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.effectiveMaxParticipants, 25);
  assert.equal(detail.body.capacity.profile, 'low');
  assert.equal(detail.body.capacity.profileParticipants, 25);
  assert.equal(detail.body.capacity.limit, 'profile');

  seatParticipants(low, room.id, 25);

  const rejected = await joinStatus(low, room.id, 'TwentySixth');
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'room_full');
  assert.equal(rejected.body.error.details.reason, 'profile');
  assert.equal(rejected.body.error.details.profile, 'low');
  assert.equal(rejected.body.error.details.profileParticipants, 25);
  assert.match(rejected.body.error.message, /capacity profile low/i);

  const issued = await low.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId: room.id, participant: { name: 'WS 26' } },
  });
  const socket = await openWs(`${low.wsUrl}?token=${encodeURIComponent(issued.body.token)}`);
  try {
    const error = await socket.waitFor((message) => message.type === 'error');
    assert.equal(error.code, 'room_full');
    assert.match(error.message, /capacity profile low/i);
  } finally {
    await socket.close();
  }

  const status = await adminScale(low);
  assert.equal(status.sfuProfile, 'low');
  assert.equal(status.sfuCapacity.participants, 25);
  assert.equal(status.effectiveMaxParticipants, 25);
  assert.equal(status.capacity.limit, 'profile');
  assert.equal(status.capacity.profileParticipants, 25);
});

test('standard profile (no explicit profile): 50 seats, 51st join rejected', async () => {
  assert.equal((await adminScale(standard)).sfuProfile, 'standard');
  const room = await createRoom(standard, { maxParticipants: 200 });
  assert.equal(room.maxParticipants, 50);

  const detail = await standard.api('GET', `/v1/admin/rooms/${room.id}`, { headers: ADMIN });
  assert.equal(detail.body.effectiveMaxParticipants, 50);
  assert.equal(detail.body.capacity.profile, 'standard');
  assert.equal(detail.body.capacity.profileParticipants, 50);
  assert.equal(detail.body.capacity.limit, 'profile');

  seatParticipants(standard, room.id, 50);
  const rejected = await joinStatus(standard, room.id, 'FiftyFirst');
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'room_full');
  assert.equal(rejected.body.error.details.reason, 'profile');
  assert.match(rejected.body.error.message, /capacity profile standard/i);

  const status = await adminScale(standard);
  assert.equal(status.sfuCapacity.participants, 50);
  assert.equal(status.effectiveMaxParticipants, 50);
});

test('high profile: 200 seats, 201st join rejected', async () => {
  assert.equal((await adminScale(high)).sfuProfile, 'high');
  const room = await createRoom(high, { maxParticipants: 5000 });
  assert.equal(room.maxParticipants, 200);

  const detail = await high.api('GET', `/v1/admin/rooms/${room.id}`, { headers: ADMIN });
  assert.equal(detail.body.effectiveMaxParticipants, 200);
  assert.equal(detail.body.capacity.profile, 'high');
  assert.equal(detail.body.capacity.profileParticipants, 200);
  assert.equal(detail.body.capacity.limit, 'profile');

  seatParticipants(high, room.id, 200);
  const rejected = await joinStatus(high, room.id, 'TwoHundredFirst');
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'room_full');
  assert.equal(rejected.body.error.details.reason, 'profile');
  assert.match(rejected.body.error.message, /capacity profile high/i);

  const status = await adminScale(high);
  assert.equal(status.sfuCapacity.participants, 200);
  assert.equal(status.effectiveMaxParticipants, 200);
});

test('a lower room or scale limit wins over the profile', async () => {
  // Room max (10) < profile (200): the room is the binding limit.
  const room = await createRoom(high, { maxParticipants: 10 });
  assert.equal(room.maxParticipants, 10);
  const detail = await high.api('GET', `/v1/admin/rooms/${room.id}`, { headers: ADMIN });
  assert.equal(detail.body.effectiveMaxParticipants, 10);
  assert.equal(detail.body.capacity.limit, 'room');

  seatParticipants(high, room.id, 10);
  const rejected = await joinStatus(high, room.id, 'Eleventh');
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'room_full');
  assert.equal(rejected.body.error.details.reason, 'room');
  assert.match(rejected.body.error.message, /room maxParticipants is 10/i);

  // scale.maxParticipants (8) < profile (200): the tenant scale limit wins.
  const patched = await high.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { scale: { maxParticipants: 8 } },
  });
  assert.equal(patched.status, 200);
  try {
    const scaled = await createRoom(high, {});
    assert.equal(scaled.maxParticipants, 8);
    const scaledDetail = await high.api('GET', `/v1/admin/rooms/${scaled.id}`, { headers: ADMIN });
    assert.equal(scaledDetail.body.effectiveMaxParticipants, 8);
    assert.equal(scaledDetail.body.capacity.limit, 'scale');
  } finally {
    await high.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { scale: { maxParticipants: 200 } },
    });
  }
});

test('lobby admit enforces the capacity profile when the room fills while pending', async () => {
  const patched = await low.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { security: { waitingRoom: true } },
  });
  assert.equal(patched.status, 200);
  try {
    const room = await createRoom(low, { maxParticipants: 25 });
    seatParticipants(low, room.id, 24);

    const pending = await joinStatus(low, room.id, 'Lobby guest');
    assert.equal(pending.status, 202, JSON.stringify(pending.body));
    assert.equal(typeof pending.body.requestId, 'string');

    // The room fills while the guest waits.
    seatParticipants(low, room.id, 25);
    const admitted = await low.api('POST', `/v1/rooms/${room.id}/lobby/${pending.body.requestId}/admit`, {
      headers: ADMIN,
    });
    assert.equal(admitted.status, 409, JSON.stringify(admitted.body));
    assert.equal(admitted.body.error.code, 'room_full');
    assert.equal(admitted.body.error.details.reason, 'profile');
    assert.match(admitted.body.error.message, /capacity profile low/i);
  } finally {
    await low.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { security: { waitingRoom: false } },
    });
  }
});
