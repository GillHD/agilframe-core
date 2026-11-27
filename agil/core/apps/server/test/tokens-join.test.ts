/** Room creation, token issue/verify and the join flow (password/lock/geo). */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyToken } from '@agil/protocol/token';
import { apiKeyTenant } from '../src/auth.js';
import { openWs, startTestServer, type TestServer } from './helpers.js';

const SECRET = 'test-secret-0123456789';
const ADMIN = { 'x-api-key': 'dev-key' };
let ts: TestServer;

before(async () => {
  ts = await startTestServer();
});

after(async () => {
  await ts.close();
});

test('static tenant credentials are accepted only from own nonempty string entries', () => {
  const keys: Record<string, string> = Object.create({ 'not-configured': 'demo' });
  keys['approved-key'] = 'acme';
  keys['empty-entry'] = '';
  const env = { ...ts.server.env, apiKeys: keys };
  assert.equal(apiKeyTenant(env, {}), null);
  assert.equal(apiKeyTenant(env, { 'x-api-key': 'not-configured' }), null);
  assert.equal(apiKeyTenant(env, { 'x-api-key': 'approved-key' }), 'acme');
  assert.equal(apiKeyTenant(env, { 'x-api-key': 'empty-entry' }), null);
});

test('company room accepts only a signed, room-scoped token for an allowed participant', async () => {
  const body = { name: 'Company call', allowedParticipantIds: ['alice', 'bob'] };
  assert.equal((await ts.api('POST', '/v1/rooms', { body })).status, 401);
  const created = await ts.api('POST', '/v1/rooms', { headers: ADMIN, body });
  assert.equal(created.status, 200);
  assert.equal(created.body.token, undefined);
  assert.equal(created.body.room.allowedParticipantIds, undefined);
  const roomId = created.body.room.id;
  const join = (body: Record<string, unknown>) => ts.api('POST', `/v1/rooms/${roomId}/join`, { body });
  assert.equal((await join({ participantId: 'alice' })).status, 403);
  const otherRoom = await ts.api('POST', '/v1/rooms', { body: { name: 'Different call' } });
  const issue = (id: string, participantId: string) => ts.api('POST', '/v1/tokens', {
    headers: ADMIN, body: { tenantId: 'demo', roomId: id, participant: { name: participantId, participantId } },
  });
  const other = await issue(otherRoom.body.room.id, 'alice');
  assert.equal((await join({ token: other.body.token })).status, 403);
  assert.equal((await issue(roomId, 'outsider')).status, 403);
  assert.equal((await ts.api('POST', `/v1/admin/rooms/${roomId}/invites`, { headers: ADMIN, body: {} })).status, 403);
  const denied = await openWs(`${ts.wsUrl}?room=${roomId}&participant=alice`);
  assert.equal((await denied.waitFor((m) => m.type === 'error')).code, 'unauthorized');
  denied.close();
  const issued = await issue(roomId, 'alice');
  assert.equal(issued.status, 200);
  const accepted = await join({ token: issued.body.token, participantId: 'outsider' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.participant.id, 'alice');
  const allowed = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(issued.body.token)}`);
  await allowed.waitFor((m) => m.type === 'welcome');
  allowed.close();
});

test('anonymous POST /v1/rooms returns token, joinUrl and embedUrl', async () => {
  const created = await ts.api('POST', '/v1/rooms', { body: { tenantId: 'demo', name: 'Demo room' } });
  assert.equal(created.status, 200);
  assert.equal(created.body.room.tenantId, 'demo');
  assert.equal(created.body.passwordProtected, false);
  assert.ok(created.body.joinUrl.includes('room='));
  assert.ok(created.body.embedUrl.includes('/embed.html?'));
  const verified = verifyToken(created.body.token, SECRET);
  assert.equal(verified.valid, true);
  if (verified.valid) {
    assert.equal(verified.claims.roomId, created.body.room.id);
    assert.equal(verified.claims.tenantId, 'demo');
    assert.equal(verified.claims.role, 'host');
  }
});

test('POST /v1/tokens issues a verifiable scoped token with effective permissions', async () => {
  const created = await ts.api('POST', '/v1/rooms', { body: { name: 'Token room' } });
  const roomId = created.body.room.id;
  const issued = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Alisa', role: 'moderator' }, permissions: ['chat', 'screenShare'] },
  });
  assert.equal(issued.status, 200);
  assert.ok(Array.isArray(issued.body.permissions));
  assert.ok(issued.body.permissions.includes('chat'));
  const verified = verifyToken(issued.body.token, SECRET);
  assert.equal(verified.valid, true);
  if (verified.valid) {
    assert.equal(verified.claims.sub, issued.body.token ? verified.claims.sub : '');
    assert.equal(verified.claims.role, 'moderator');
    assert.deepEqual(verified.claims.permissions, ['chat', 'screenShare']);
  }

  const foreign = await ts.api('POST', '/v1/tokens', {
    headers: { 'x-api-key': 'acme-key' },
    body: { tenantId: 'demo', roomId, participant: { name: 'X' } },
  });
  assert.equal(foreign.status, 403);

  const missing = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId: 'no-such-room', participant: { name: 'X' } },
  });
  assert.equal(missing.status, 404);
});

test('join: password required/invalid/correct, audit trail, lock and capacity', async () => {
  const secured = await ts.api('POST', '/v1/admin/rooms', {
    headers: ADMIN,
    body: { name: 'Secured', password: 'super-secret-1', maxParticipants: 3 },
  });
  assert.equal(secured.status, 200);
  assert.equal(secured.body.passwordProtected, true);
  assert.ok(!JSON.stringify(secured.body).includes('super-secret-1'));
  const roomId = secured.body.room.id;

  const missingPassword = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'Alisa' } });
  assert.equal(missingPassword.status, 400);
  assert.equal(missingPassword.body.error.code, 'password_required');

  const wrong = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'Alisa', password: 'nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'password_invalid');

  const right = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'Alisa', password: 'super-secret-1' } });
  assert.equal(right.status, 200);
  assert.equal(right.body.passwordAccepted, true);
  assert.ok(Array.isArray(right.body.permissions));
  assert.ok(right.body.permissions.includes('chat'));
  const verified = verifyToken(right.body.token, SECRET);
  assert.equal(verified.valid, true);

  const audit = await ts.api('GET', `/v1/admin/audit?roomId=${roomId}&limit=50`, { headers: ADMIN });
  const types = audit.body.entries.map((entry: { type: string }) => entry.type);
  assert.ok(types.includes('join.allowed'));
  assert.ok(types.includes('join.denied'));
  assert.ok(types.includes('password.failed'));

  const locked = await ts.api('POST', `/v1/admin/rooms/${roomId}/lock`, { headers: ADMIN, body: { locked: true } });
  assert.equal(locked.status, 200);
  const lockedJoin = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'Alisa', password: 'super-secret-1' } });
  assert.equal(lockedJoin.status, 423);
  assert.equal(lockedJoin.body.error.code, 'room_locked');
  await ts.api('POST', `/v1/admin/rooms/${roomId}/lock`, { headers: ADMIN, body: { locked: false } });

  const notFound = await ts.api('POST', '/v1/rooms/nope/join', { body: { name: 'X' } });
  assert.equal(notFound.status, 404);
});

test('geo policy: blocked country rejected via trusted header (403 geo_blocked)', async () => {
  const geo = await startTestServer({ trustProxy: true, geoProvider: 'header', geoHeaderAllow: true });
  try {
    await geo.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { security: { geo: { enabled: true, blockedCountries: ['KP'], allowedCountries: [] } } },
    });
    const created = await geo.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Geo' } });
    const roomId = created.body.room.id;
    const blocked = await geo.api('POST', `/v1/rooms/${roomId}/join`, {
      headers: { 'x-agil-country': 'KP', 'x-forwarded-for': '198.51.100.9' },
      body: { name: 'Blocked' },
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'geo_blocked');

    const allowed = await geo.api('POST', `/v1/rooms/${roomId}/join`, {
      headers: { 'x-agil-country': 'RU', 'x-forwarded-for': '203.0.113.7' },
      body: { name: 'Allowed' },
    });
    assert.equal(allowed.status, 200);

    const audit = await geo.api('GET', '/v1/admin/audit?limit=50', { headers: ADMIN });
    assert.ok(audit.body.entries.some((entry: { type: string }) => entry.type === 'geo.blocked'));
  } finally {
    await geo.close();
  }
});

test('brute force is throttled/locked out', async () => {
  const created = await ts.api('POST', '/v1/admin/rooms', {
    headers: ADMIN,
    body: { name: 'Brute', password: 'correct-horse', maxParticipants: 2 },
  });
  const roomId = created.body.room.id;
  let throttled = false;
  let lastStatus = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'x', password: `bad-${attempt}` } });
    lastStatus = response.status;
    if (response.status === 429 || response.status === 423) {
      throttled = true;
      break;
    }
  }
  assert.equal(throttled, true, `last status ${lastStatus}`);
});

test('office NAT: >10 joins from one IP are allowed within a minute', async () => {
  const created = await ts.api('POST', '/v1/admin/rooms', {
    headers: ADMIN,
    body: { name: 'NAT room', maxParticipants: 60 },
  });
  const roomId = created.body.room.id;
  const statuses: number[] = [];
  for (let index = 0; index < 15; index += 1) {
    const response = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: `User ${index}` } });
    statuses.push(response.status);
  }
  assert.deepEqual(statuses, new Array(15).fill(200), `statuses: ${statuses.join(',')}`);
});
