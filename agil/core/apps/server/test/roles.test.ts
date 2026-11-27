/** Custom roles CRUD + token/join/WS integration (protocol § accessPolicy.customRoles). */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyToken } from '@agil/protocol/token';
import { openWs, startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const SECRET = 'test-secret-0123456789';
let ts: TestServer;
let roomId: string;

before(async () => {
  ts = await startTestServer();
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Roles room' } });
  roomId = created.body.room.id;
});

after(async () => {
  await ts.close();
});

function roleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'qa-lead',
    name: 'QA Lead',
    description: 'Роль для проверки качества: чат и экран без записи',
    baseRole: 'guest',
    features: ['chat', 'screenShare'],
    canModerate: true,
    color: '#123456',
    ...overrides,
  };
}

test('access policy preconditions protect a personal override from stale creation and revocation', async () => {
  const headers = { 'x-api-key': 'acme-key' };
  const endpoint = '/v1/admin/access-policy';
  const userId = 'concurrent-qa';
  const update = (body: Record<string, unknown>) => ts.api('PUT', endpoint, { headers, body });
  const read = async () => (await ts.api('GET', endpoint, { headers })).body.policy;
  assert.equal((await update({
    policy: { userOverrides: { [userId]: ['chat'] } },
    expectedPolicy: { userOverrides: { [userId]: null } },
  })).status, 200);
  const staleCreate = await update({
    policy: { userOverrides: { [userId]: ['fileShare'] } },
    expectedPolicy: { userOverrides: { [userId]: null } },
  });
  assert.equal(staleCreate.status, 409);
  assert.equal(staleCreate.body.error.code, 'access_policy_conflict');
  assert.equal((await update({
    policy: { userOverrides: { [userId]: ['fileShare'] } },
    expectedPolicy: { userOverrides: { [userId]: ['chat'] } },
  })).status, 200);
  const staleRevoke = await update({
    clearUserOverrides: [userId],
    expectedPolicy: { userOverrides: { [userId]: ['chat'] } },
  });
  assert.equal(staleRevoke.status, 409);
  assert.deepEqual((await read()).userOverrides[userId], ['fileShare']);
  assert.equal((await update({
    clearUserOverrides: [userId],
    expectedPolicy: { userOverrides: { [userId]: ['fileShare'] } },
  })).status, 200);
  assert.equal(Object.hasOwn((await read()).userOverrides, userId), false);
});

test('GET /v1/admin/roles: auth + built-in roles', async () => {
  const unauthorized = await ts.api('GET', '/v1/admin/roles');
  assert.equal(unauthorized.status, 401);

  const response = await ts.api('GET', '/v1/admin/roles', { headers: ADMIN });
  assert.equal(response.status, 200);
  const builtin = response.body.roles.filter((role: { builtin: boolean }) => role.builtin);
  assert.deepEqual(builtin.map((role: { id: string }) => role.id), ['host', 'moderator', 'guest']);
  for (const role of builtin) {
    assert.ok(role.name.length > 0);
    assert.ok(role.description.length > 0);
    assert.ok(Array.isArray(role.features));
  }
});

test('POST /v1/admin/roles: create, validation, reserved ids, duplicates', async () => {
  const created = await ts.api('POST', '/v1/admin/roles', { headers: ADMIN, body: roleBody() });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.id, 'qa-lead');
  assert.equal(created.body.builtin, false);
  assert.deepEqual(created.body.features, ['chat', 'screenShare']);
  assert.equal(created.body.canModerate, true);

  const duplicate = await ts.api('POST', '/v1/admin/roles', { headers: ADMIN, body: roleBody() });
  assert.equal(duplicate.status, 409);

  for (const reserved of ['host', 'moderator', 'guest']) {
    const response = await ts.api('POST', '/v1/admin/roles', { headers: ADMIN, body: roleBody({ id: reserved }) });
    assert.equal(response.status, 400, `reserved id ${reserved}`);
  }
  const invalidId = await ts.api('POST', '/v1/admin/roles', { headers: ADMIN, body: roleBody({ id: 'Bad ID' }) });
  assert.equal(invalidId.status, 400);
  const invalidFeature = await ts.api('POST', '/v1/admin/roles', {
    headers: ADMIN,
    body: roleBody({ id: 'bad-feature', features: ['not-a-feature'] }),
  });
  assert.equal(invalidFeature.status, 400);

  const list = await ts.api('GET', '/v1/admin/roles', { headers: ADMIN });
  assert.ok(list.body.roles.some((role: { id: string; builtin: boolean }) => role.id === 'qa-lead' && role.builtin === false));
});

test('tokens with roleId: roleId/roleName, effective features, overrides and flags', async () => {
  const issued = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Alisa', roleId: 'qa-lead' } },
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.equal(issued.body.roleId, 'qa-lead');
  assert.equal(issued.body.roleName, 'QA Lead');
  assert.ok(issued.body.permissions.includes('chat'));
  assert.ok(issued.body.permissions.includes('screenShare'));
  assert.ok(!issued.body.permissions.includes('recording'));
  const verified = verifyToken(issued.body.token, SECRET);
  assert.equal(verified.valid, true);
  if (verified.valid) assert.equal((verified.claims as { roleId?: string }).roleId, 'qa-lead');

  const unknownRole = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'X', roleId: 'nope' } },
  });
  assert.equal(unknownRole.status, 400);

  // Token-pinned permissions override the custom role list (then feature flags apply).
  const pinned = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Pinned', roleId: 'qa-lead' }, permissions: ['chat'] },
  });
  assert.deepEqual(pinned.body.permissions, ['chat']);

  // deniedFeatures subtract from the custom role features.
  await ts.api('PUT', '/v1/admin/access-policy', {
    headers: ADMIN,
    body: { policy: { deniedFeatures: ['screenShare'] } },
  });
  const denied = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Alisa', roleId: 'qa-lead' } },
  });
  assert.ok(!denied.body.permissions.includes('screenShare'));
  await ts.api('PUT', '/v1/admin/access-policy', { headers: ADMIN, body: { policy: { deniedFeatures: [] } } });

  // Disabled tenant feature flag still removes the feature from the role.
  await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { features: { screenShare: false } } });
  const flagged = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Alisa', roleId: 'qa-lead' } },
  });
  assert.ok(!flagged.body.permissions.includes('screenShare'));
  await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { features: { screenShare: true } } });
});

test('join and welcome use the custom role (roleName, permissions)', async () => {
  const issued = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Alisa', roleId: 'qa-lead' } },
  });
  const joined = await ts.api('POST', `/v1/rooms/${roomId}/join`, {
    headers: { authorization: `Bearer ${issued.body.token}` },
    body: { name: 'Alisa' },
  });
  assert.equal(joined.status, 200);
  assert.ok(joined.body.permissions.includes('chat'));
  assert.ok(!joined.body.permissions.includes('recording'));

  const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(issued.body.token)}`);
  const welcome = await client.waitFor((message) => message.type === 'welcome');
  assert.equal(welcome.self.roleName, 'QA Lead');
  assert.equal(welcome.self.role, 'guest');
  assert.ok(welcome.self.permissions.includes('chat'));
  await client.close();
});

test('PUT/DELETE: built-ins protected, update works, delete reports affected participants', async () => {
  const builtinUpdate = await ts.api('PUT', '/v1/admin/roles/host', { headers: ADMIN, body: roleBody() });
  assert.equal(builtinUpdate.status, 403);
  const builtinDelete = await ts.api('DELETE', '/v1/admin/roles/guest', { headers: ADMIN });
  assert.equal(builtinDelete.status, 403);
  const unknownUpdate = await ts.api('PUT', '/v1/admin/roles/nope', { headers: ADMIN, body: roleBody({ id: 'nope' }) });
  assert.equal(unknownUpdate.status, 404);

  const updated = await ts.api('PUT', '/v1/admin/roles/qa-lead', {
    headers: ADMIN,
    body: roleBody({ name: 'QA Lead v2', features: ['chat', 'reactions'] }),
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.name, 'QA Lead v2');
  assert.deepEqual(updated.body.features, ['chat', 'reactions']);

  // A connected participant with this role makes `affectedParticipants` > 0.
  const issued = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Affected', roleId: 'qa-lead' } },
  });
  const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(issued.body.token)}`);
  await client.waitFor((message) => message.type === 'welcome');

  const deleted = await ts.api('DELETE', '/v1/admin/roles/qa-lead', { headers: ADMIN });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, true);
  assert.equal(deleted.body.affectedParticipants, 1);
  const again = await ts.api('DELETE', '/v1/admin/roles/qa-lead', { headers: ADMIN });
  assert.equal(again.status, 404);

  // Tokens for the deleted role are rejected; the connected participant falls back to baseRole on reconnect.
  const staleToken = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'X', roleId: 'qa-lead' } },
  });
  assert.equal(staleToken.status, 400);
  await client.close();

  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  const kinds = audit.body.entries.map((entry: { details?: { kind?: string } }) => entry.details?.kind);
  assert.ok(kinds.includes('role.created'));
  assert.ok(kinds.includes('role.updated'));
  assert.ok(kinds.includes('role.deleted'));
});

test('custom roles are limited to 30', async () => {
  for (let index = 0; index < 30; index += 1) {
    const response = await ts.api('POST', '/v1/admin/roles', {
      headers: ADMIN,
      body: roleBody({ id: `limit-${index}`, name: `Limit ${index}` }),
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  const overLimit = await ts.api('POST', '/v1/admin/roles', {
    headers: ADMIN,
    body: roleBody({ id: 'limit-over', name: 'Over' }),
  });
  assert.equal(overLimit.status, 409);
});
