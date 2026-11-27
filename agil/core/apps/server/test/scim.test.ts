/** SCIM 2.0 directory: auth, Users/Groups CRUD, filtering, PATCH, isolation, audit. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const SCIM_HEADERS = {
  authorization: 'Bearer scim-secret',
  'x-tenant-id': 'demo',
  'content-type': 'application/scim+json',
};
let ts: TestServer;

before(async () => {
  ts = await startTestServer({ scimToken: 'scim-secret' });
});

after(async () => {
  await ts.close();
});

async function scim(
  method: string,
  path: string,
  options: { tenant?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any; headers: Headers; text: string }> {
  const headers: Record<string, string> = {
    ...(options.token === undefined ? { authorization: SCIM_HEADERS.authorization } : { authorization: `Bearer ${options.token}` }),
    'x-tenant-id': options.tenant ?? 'demo',
    'content-type': 'application/scim+json',
  };
  return ts.api(method, path, {
    headers,
    ...(options.body !== undefined ? { rawBody: JSON.stringify(options.body) } : {}),
  });
}

test('SCIM auth: disabled → 501, bad token → 401, missing tenant → 400', async () => {
  const disabled = await startTestServer();
  try {
    const response = await disabled.api('GET', '/scim/v2/Users', {
      headers: { authorization: 'Bearer anything', 'x-tenant-id': 'demo' },
    });
    assert.equal(response.status, 501);
    assert.equal(response.body.schemas[0], 'urn:ietf:params:scim:api:messages:2.0:Error');
  } finally {
    await disabled.close();
  }
  const badToken = await scim('GET', '/scim/v2/Users', { token: 'wrong-token' });
  assert.equal(badToken.status, 401);
  assert.equal(badToken.body.schemas[0], 'urn:ietf:params:scim:api:messages:2.0:Error');
  const noTenant = await ts.api('GET', '/scim/v2/Users', { headers: { authorization: 'Bearer scim-secret' } });
  assert.equal(noTenant.status, 400);
  assert.equal(noTenant.body.status, '400');
});

test('SCIM Users: create/read/list/filter/count/duplicate/update/patch/soft-deactivate/delete', async () => {
  const created = await scim('POST', '/scim/v2/Users', {
    body: {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'alice@example.com',
      externalId: 'ext-1',
      name: { givenName: 'Alice', familyName: 'Smith' },
      displayName: 'Alice Smith',
      emails: [{ value: 'alice@example.com', type: 'work', primary: true }],
      active: true,
      roles: [{ value: 'employee', agilRole: 'guest' }],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(created.headers.get('content-type')?.includes('application/scim+json'));
  assert.ok(created.headers.get('location')?.endsWith(`/scim/v2/Users/${created.body.id}`));
  assert.equal(created.body.userName, 'alice@example.com');
  assert.equal(created.body.active, true);
  assert.equal(created.body.meta.resourceType, 'User');
  const id = created.body.id;

  const get = await scim('GET', `/scim/v2/Users/${id}`);
  assert.equal(get.status, 200);
  assert.equal(get.body.id, id);

  const list = await scim('GET', '/scim/v2/Users');
  assert.equal(list.status, 200);
  assert.equal(list.body.schemas[0], 'urn:ietf:params:scim:api:messages:2.0:ListResponse');
  assert.equal(list.body.totalResults, 1);
  assert.equal(list.body.startIndex, 1);

  const byName = await scim('GET', `/scim/v2/Users?filter=${encodeURIComponent('userName eq "alice@example.com"')}&startIndex=1&count=1`);
  assert.equal(byName.status, 200);
  assert.equal(byName.body.totalResults, 1);
  assert.equal(byName.body.itemsPerPage, 1);
  const byEmail = await scim('GET', `/scim/v2/Users?filter=${encodeURIComponent('emails.value eq "alice@example.com"')}`);
  assert.equal(byEmail.body.totalResults, 1);
  const badFilter = await scim('GET', `/scim/v2/Users?filter=${encodeURIComponent('unknown eq "x"')}`);
  assert.equal(badFilter.status, 400);
  assert.equal(badFilter.body.scimType, 'invalidFilter');

  const duplicate = await scim('POST', '/scim/v2/Users', { body: { userName: 'ALICE@example.com' } });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.scimType, 'uniqueness');

  const put = await scim('PUT', `/scim/v2/Users/${id}`, {
    body: { userName: 'alice@example.com', name: { givenName: 'Alicia' }, active: true },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.name.givenName, 'Alicia');

  const patch = await scim('PATCH', `/scim/v2/Users/${id}`, {
    body: {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        { op: 'replace', path: 'active', value: false },
        { op: 'replace', path: 'name.givenName', value: 'Alisa' },
        { op: 'add', path: 'roles', value: [{ value: 'viewer', agilRole: 'guest' }] },
      ],
    },
  });
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  assert.equal(patch.body.active, false, 'soft deactivation via active=false');
  assert.equal(patch.body.name.givenName, 'Alisa');
  assert.deepEqual(patch.body.roles, [{ value: 'viewer', agilRole: 'guest' }]);

  const remove = await scim('PATCH', `/scim/v2/Users/${id}`, {
    body: { Operations: [{ op: 'remove', path: 'roles' }] },
  });
  assert.equal(remove.status, 200);
  assert.deepEqual(remove.body.roles, []);

  const deleted = await scim('DELETE', `/scim/v2/Users/${id}`);
  assert.equal(deleted.status, 204);
  assert.ok(deleted.headers.get('content-type')?.includes('application/scim+json') ?? true);
  assert.equal((await scim('GET', `/scim/v2/Users/${id}`)).status, 404);
});

test('SCIM Groups: CRUD, members, filter, duplicate, patch and tenant isolation', async () => {
  const group = await scim('POST', '/scim/v2/Groups', {
    body: { displayName: 'Engineering', members: [{ value: 'user-1', display: 'User One' }] },
  });
  assert.equal(group.status, 201, JSON.stringify(group.body));
  assert.equal(group.body.meta.resourceType, 'Group');
  const groupId = group.body.id;
  assert.equal((await scim('GET', `/scim/v2/Groups?filter=${encodeURIComponent('displayName eq "engineering"')}`)).body.totalResults, 1);
  const duplicate = await scim('POST', '/scim/v2/Groups', { body: { displayName: 'engineering' } });
  assert.equal(duplicate.status, 409);

  const patched = await scim('PATCH', `/scim/v2/Groups/${groupId}`, {
    body: {
      Operations: [
        { op: 'add', path: 'members', value: [{ value: 'user-2', display: 'User Two' }] },
        { op: 'replace', path: 'displayName', value: 'Platform' },
      ],
    },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.displayName, 'Platform');
  assert.equal(patched.body.members.length, 1);

  const put = await scim('PUT', `/scim/v2/Groups/${groupId}`, { body: { displayName: 'Platform', members: [] } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.members, []);
  assert.equal((await scim('DELETE', `/scim/v2/Groups/${groupId}`)).status, 204);
  assert.equal((await scim('GET', `/scim/v2/Groups/${groupId}`)).status, 404);

  // Tenant isolation: same SCIM token, different x-tenant-id → separate directories.
  const demoUser = await scim('POST', '/scim/v2/Users', {
    body: { userName: 'isolation@example.com', active: true },
  });
  assert.equal(demoUser.status, 201);
  const acmeList = await scim('GET', '/scim/v2/Users', { tenant: 'acme' });
  assert.equal(acmeList.body.totalResults, 0, 'acme does not see demo users');
  const acmeUser = await scim('POST', '/scim/v2/Users', { tenant: 'acme', body: { userName: 'isolation@example.com' } });
  assert.equal(acmeUser.status, 201, 'same userName is fine in another tenant');
  assert.equal((await scim('GET', '/scim/v2/Users')).body.totalResults, 1);
  assert.equal((await scim('GET', '/scim/v2/Users', { tenant: 'acme' })).body.totalResults, 1);
});

test('SCIM ServiceProviderConfig/Schemas/ResourceTypes and audit without PII', async () => {
  const config = await scim('GET', '/scim/v2/ServiceProviderConfig');
  assert.equal(config.status, 200);
  assert.equal(config.body.patch.supported, true);
  assert.equal(config.body.filter.maxResults, 1000);
  assert.ok(config.headers.get('content-type')?.includes('application/scim+json'));
  assert.equal((await scim('GET', '/scim/v2/Schemas')).body.totalResults, 2);
  assert.equal((await scim('GET', '/scim/v2/ResourceTypes')).body.totalResults, 2);

  const created = await scim('POST', '/scim/v2/Users', {
    body: { userName: 'audit@example.com', emails: [{ value: 'secret@example.com' }], active: true },
  });
  assert.equal(created.status, 201);
  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  const kinds = audit.body.entries.map((entry: { details?: { kind?: string } }) => entry.details?.kind).filter(Boolean);
  assert.ok(kinds.includes('scim.user.created'));
  assert.ok(kinds.includes('scim.user.deleted') || kinds.includes('scim.group.created'), 'SCIM mutations are audited');
  const auditText = JSON.stringify(audit.body);
  assert.ok(!auditText.includes('secret@example.com'), 'no PII/emails in audit');
  assert.ok(auditText.includes('audit@example.com'), 'userName is allowed in audit');
});
