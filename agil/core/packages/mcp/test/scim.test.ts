/**
 * SCIM 2.0 tools: mocked fetch — no live server needed.
 * Verifies auth headers/tenant, SCIM+JSON media types, read/write flags,
 * PATCH operation building and Russian error messages.
 */
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { McpEnv } from '../src/env.js';
import { AgilHttpClient } from '../src/http-client.js';
import { scimToolSpecs } from '../src/tools/scim.js';
import type { ToolContext } from '../src/tool-kit.js';

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];

interface MockResponse {
  status: number;
  body: unknown;
}

function makeContext(overrides: Partial<McpEnv> = {}): ToolContext {
  const env: McpEnv = {
    serverUrl: 'http://scim.test',
    apiKey: 'api-key-not-for-scim',
    tenantId: 'demo',
    scimToken: 'scim-secret-token',
    timeoutMs: 5000,
    mode: 'full',
    ...overrides,
  };
  return { env, client: new AgilHttpClient(env) };
}

async function call(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<string> {
  const spec = scimToolSpecs().find((candidate) => candidate.name === name);
  assert.ok(spec, `${name} must exist`);
  const outcome = await spec.handler(args, ctx);
  assert.equal(outcome.isError, undefined);
  return outcome.text;
}

function mockFetch(response: MockResponse): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    if (response.body instanceof Response) return response.body;
    if (response.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/scim+json' },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  calls.length = 0;
  mockFetch({ status: 200, body: { schemas: [], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] } });
});

after(() => {
  globalThis.fetch = originalFetch;
});

test('scim read tools are marked read-only, writes are write', () => {
  const specs = scimToolSpecs();
  assert.equal(specs.length, 10);
  for (const name of ['scim_list_users', 'scim_get_user', 'scim_list_groups', 'scim_service_provider_config']) {
    assert.equal(specs.find((spec) => spec.name === name)?.write, false, `${name} must be read-only`);
  }
  for (const name of ['scim_create_user', 'scim_update_user', 'scim_delete_user', 'scim_create_group', 'scim_update_group', 'scim_delete_group']) {
    assert.equal(specs.find((spec) => spec.name === name)?.write, true, `${name} must be write`);
  }
});

test('scim_list_users: Bearer env token, tenant header, SCIM+JSON, no x-api-key', async () => {
  mockFetch({
    status: 200,
    body: {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
      Resources: [{ id: 'u1', userName: 'alice@example.com', active: true }],
    },
  });
  const text = await call(makeContext(), 'scim_list_users', {
    tenantId: 'acme',
    filter: 'userName eq "alice@example.com"',
    startIndex: 1,
    count: 50,
  });
  const payload = JSON.parse(text) as { totalResults: number; Resources: Array<{ userName: string }> };
  assert.equal(payload.totalResults, 1);
  assert.equal(payload.Resources[0]?.userName, 'alice@example.com');
  assert.equal(calls.length, 1);
  const request = calls[0]!;
  assert.match(request.url, /^http:\/\/scim\.test\/scim\/v2\/Users\?/);
  assert.match(request.url, /filter=userName\+eq\+%22alice%40example\.com%22/);
  assert.equal(request.headers.get('authorization'), 'Bearer scim-secret-token');
  assert.equal(request.headers.get('x-tenant-id'), 'acme');
  assert.equal(request.headers.get('accept'), 'application/scim+json');
  assert.equal(request.headers.get('content-type'), 'application/scim+json');
  assert.equal(request.headers.get('x-api-key'), null);
});

test('scim_create_user / scim_update_user: JSON body and SCIM PatchOp; delete returns 204', async () => {
  mockFetch({ status: 201, body: { id: 'u2', userName: 'bob@example.com', active: true } });
  const created = JSON.parse(
    await call(makeContext(), 'scim_create_user', {
      tenantId: 'demo',
      userName: 'bob@example.com',
      name: { givenName: 'Bob', familyName: 'Smith' },
      emails: [{ value: 'bob@example.com', primary: true }],
      active: true,
      roles: [{ value: 'employee', agilRole: 'guest' }],
    }),
  ) as { created: boolean; user: { userName: string } };
  assert.equal(created.created, true);
  assert.equal(created.user.userName, 'bob@example.com');
  assert.equal(calls[0]?.method, 'POST');
  const createBody = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
  assert.equal(createBody.userName, 'bob@example.com');
  assert.equal(createBody.active, true);

  mockFetch({ status: 200, body: { id: 'u2', userName: 'bob@example.com', active: false } });
  const updated = JSON.parse(
    await call(makeContext(), 'scim_update_user', {
      tenantId: 'demo',
      id: 'u2',
      active: false,
      name: { familyName: 'Johnson' },
      emails: [{ value: 'bob2@example.com' }],
      roles: [{ value: 'contractor', agilRole: 'guest' }],
    }),
  ) as { updated: boolean };
  assert.equal(updated.updated, true);
  assert.equal(calls[1]?.method, 'PATCH');
  const patch = JSON.parse(calls[1]!.body!) as { schemas: string[]; Operations: Array<{ op: string; path: string; value: unknown }> };
  assert.equal(patch.schemas[0], 'urn:ietf:params:scim:api:messages:2.0:PatchOp');
  assert.deepEqual(
    patch.Operations.map((operation) => operation.path),
    ['active', 'name.familyName', 'emails', 'roles'],
  );

  mockFetch({ status: 204, body: null });
  const deleted = JSON.parse(await call(makeContext(), 'scim_delete_user', { tenantId: 'demo', id: 'u2' })) as { deleted: boolean; id: string };
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.id, 'u2');
  assert.equal(calls[2]?.method, 'DELETE');
});

test('scim groups + ServiceProviderConfig use /scim/v2 paths', async () => {
  mockFetch({ status: 200, body: { id: 'g1', displayName: 'Engineering', members: [] } });
  const group = JSON.parse(
    await call(makeContext(), 'scim_create_group', {
      tenantId: 'demo',
      displayName: 'Engineering',
      members: [{ value: 'u1', display: 'Alice' }],
    }),
  ) as { created: boolean; group: { displayName: string } };
  assert.equal(group.group.displayName, 'Engineering');
  assert.equal(calls[0]?.url, 'http://scim.test/scim/v2/Groups');

  mockFetch({ status: 200, body: { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'], patch: { supported: true }, filter: { maxResults: 1000 } } });
  const config = JSON.parse(await call(makeContext(), 'scim_service_provider_config', { tenantId: 'demo' })) as {
    serviceProviderConfig: { filter: { maxResults: number } };
  };
  assert.equal(config.serviceProviderConfig.filter.maxResults, 1000);
  assert.equal(calls[1]?.url, 'http://scim.test/scim/v2/ServiceProviderConfig');
});

test('SCIM errors are Russian and never include the token', async () => {
  const missing = makeContext({ scimToken: '' });
  await assert.rejects(
    () => call(missing, 'scim_list_users', { tenantId: 'demo' }),
    (error: unknown) => error instanceof Error && /AGIL_SCIM_TOKEN/.test(error.message) && !/scim-secret-token/.test(error.message),
  );

  mockFetch({
    status: 401,
    body: { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], detail: 'invalid token', status: '401' },
  });
  await assert.rejects(
    () => call(makeContext(), 'scim_get_user', { tenantId: 'demo', id: 'u1' }),
    (error: unknown) =>
      error instanceof Error &&
      /SCIM отклонил токен/.test(error.message) &&
      !/scim-secret-token/.test(error.message),
  );

  await assert.rejects(
    () => call(makeContext(), 'scim_update_user', { tenantId: 'demo', id: 'u1' }),
    (error: unknown) => error instanceof Error && /Нет изменений/.test(error.message),
  );
});
