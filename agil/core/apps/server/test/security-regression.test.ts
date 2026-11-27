/**
 * Security regression tests for the QA findings S-01/S-03/S-06/S-08/S-10.
 * Each test names the finding it locks down.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
let ts: TestServer;

before(async () => {
  ts = await startTestServer();
});

after(async () => {
  await ts.close();
});

test('S-01: x-agil-country is ignored unless AGIL_GEO_HEADER_ALLOW=1', async () => {
  // Default: spoofed header cannot pass a geo allowlist.
  const strict = await startTestServer({ trustProxy: true, geoProvider: 'header' });
  try {
    await strict.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { security: { geo: { enabled: true, allowedCountries: ['RU'], blockedCountries: [] } } },
    });
    const created = await strict.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Geo spoof' } });
    const roomId = created.body.room.id;
    const spoofed = await strict.api('POST', `/v1/rooms/${roomId}/join`, {
      headers: { 'x-agil-country': 'RU', 'x-forwarded-for': '203.0.113.50' },
      body: { name: 'Spoof' },
    });
    assert.equal(spoofed.status, 403, 'spoofed country header must not satisfy the allowlist');
    assert.equal(spoofed.body.error.code, 'geo_blocked');
  } finally {
    await strict.close();
  }

  // Explicit demo/edge opt-in enables the header.
  const demo = await startTestServer({ trustProxy: true, geoProvider: 'header', geoHeaderAllow: true });
  try {
    await demo.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { security: { geo: { enabled: true, allowedCountries: ['RU'], blockedCountries: [] } } },
    });
    const created = await demo.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Geo opt-in' } });
    const allowed = await demo.api('POST', `/v1/rooms/${created.body.room.id}/join`, {
      headers: { 'x-agil-country': 'RU', 'x-forwarded-for': '203.0.113.51' },
      body: { name: 'Header allowed' },
    });
    assert.equal(allowed.status, 200, 'AGIL_GEO_HEADER_ALLOW=1 enables the trusted-edge header');
  } finally {
    await demo.close();
  }
});

test('S-03: a join token from room A is not trusted in room B', async () => {
  const first = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Room A' } });
  const second = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Room B' } });
  const roomA = first.body.room.id;
  const roomB = second.body.room.id;
  const issued = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId: roomA, participant: { name: 'Host A', role: 'host' } },
  });
  assert.equal(issued.status, 200);

  const foreign = await ts.api('POST', `/v1/rooms/${roomB}/join`, { body: { name: 'Intruder', token: issued.body.token } });
  assert.equal(foreign.status, 200);
  assert.equal(foreign.body.participant.role, 'guest', 'foreign-room token must not grant host');
  assert.ok(!foreign.body.permissions.includes('recording'));
  assert.ok(!foreign.body.permissions.includes('knowledgeAgent'));

  const own = await ts.api('POST', `/v1/rooms/${roomA}/join`, { body: { name: 'Host A', token: issued.body.token } });
  assert.equal(own.status, 200);
  assert.equal(own.body.participant.role, 'host');
});

test('S-06: userOverrides can be revoked with clearUserOverrides or an empty object', async () => {
  await ts.api('PUT', '/v1/admin/access-policy', {
    headers: ADMIN,
    body: { policy: { userOverrides: { 'user-1': ['chat'], 'user-2': ['chat', 'screenShare'] } } },
  });
  let policy = (await ts.api('GET', '/v1/admin/access-policy', { headers: ADMIN })).body.policy;
  assert.deepEqual(Object.keys(policy.userOverrides).sort(), ['user-1', 'user-2']);

  await ts.api('PUT', '/v1/admin/access-policy', { headers: ADMIN, body: { clearUserOverrides: ['user-1'] } });
  policy = (await ts.api('GET', '/v1/admin/access-policy', { headers: ADMIN })).body.policy;
  assert.deepEqual(Object.keys(policy.userOverrides), ['user-2']);

  await ts.api('PUT', '/v1/admin/access-policy', { headers: ADMIN, body: { policy: { userOverrides: {} } } });
  policy = (await ts.api('GET', '/v1/admin/access-policy', { headers: ADMIN })).body.policy;
  assert.deepEqual(policy.userOverrides, {}, 'empty object replaces the override map (revocation works)');

  const audit = await ts.api('GET', '/v1/admin/audit?limit=20', { headers: ADMIN });
  assert.ok(audit.body.entries.some((entry: { details?: { revokedOverrides?: number } }) => entry.details?.revokedOverrides === 1));
});

test('S-08: oversized JSON returns 413 payload_too_large (files keep file_too_large)', async () => {
  const oversized = JSON.stringify({ name: 'x'.repeat(1024 * 1024 + 100) });
  const response = await ts.api('POST', '/v1/rooms', { rawBody: oversized, contentType: 'application/json' });
  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, 'payload_too_large');

  const small = await startTestServer({ maxUploadMb: 1 });
  try {
    const created = await small.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Too big file' } });
    const joined = await small.api('POST', `/v1/rooms/${created.body.room.id}/join`, { body: { name: 'Uploader' } });
    await small.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { features: { fileShare: true } } });
    const upload = await small.api('POST', '/v1/files', {
      headers: { authorization: `Bearer ${joined.body.token}`, 'x-file-name': 'big.bin', 'content-type': 'application/octet-stream' },
      rawBody: Buffer.alloc(1024 * 1024 + 10, 120),
    });
    assert.equal(upload.status, 413);
    assert.equal(upload.body.error.code, 'file_too_large');
  } finally {
    await small.close();
  }
});

test('S-10: admin CORS never grants a wildcard origin', async () => {
  const preflightAdmin = await ts.api('OPTIONS', '/v1/admin/roles', {
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
  });
  assert.equal(preflightAdmin.status, 204);
  assert.equal(preflightAdmin.headers.get('access-control-allow-origin'), null, 'admin CORS has no default grant');

  const preflightPublic = await ts.api('OPTIONS', '/v1/health', {
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
  });
  assert.equal(preflightPublic.headers.get('access-control-allow-origin'), '*', 'public call surface keeps demo CORS');

  await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { integrations: { allowedOrigins: ['https://dashboard.example'] } },
  });
  const allowed = await ts.api('OPTIONS', '/v1/admin/roles', {
    headers: { origin: 'https://dashboard.example', 'access-control-request-method': 'GET' },
  });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://dashboard.example');
  const denied = await ts.api('OPTIONS', '/v1/admin/roles', {
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
  });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.notEqual(denied.headers.get('access-control-allow-origin'), '*');
});
