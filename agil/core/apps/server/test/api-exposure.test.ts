/** Managed docs/OpenAPI/admin exposure (§24, docs/api-exposure.md). */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('default exposure: docs/Public OpenAPI enabled, admin spec available, health flags', async () => {
  const ts = await startTestServer();
  try {
    const health = await ts.api('GET', '/v1/health');
    assert.equal(health.body.security.docsEnabled, true);
    assert.equal(health.body.security.adminApiEnabled, true);
    assert.equal(health.body.security.mcpHttpEnabled, false);

    assert.equal((await ts.api('GET', '/docs')).status, 200);
    assert.equal((await ts.api('GET', '/docs/api.md')).status, 200);
    assert.equal((await ts.api('GET', '/openapi.json')).status, 200);
    assert.equal((await ts.api('GET', '/openapi.admin.json')).status, 200);
  } finally {
    await ts.close();
  }
});

test('AGIL_DOCS_ENABLED=0 → identical 404 for /docs, /docs/:file, /openapi*.json', async () => {
  const ts = await startTestServer({ docsEnabled: false });
  try {
    const responses = await Promise.all([
      ts.api('GET', '/docs'),
      ts.api('GET', '/docs/api.md'),
      ts.api('GET', '/openapi.json'),
      ts.api('GET', '/openapi.admin.json'),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'not_found');
      assert.equal(response.body.error.message, 'Not found');
    }
    const health = await ts.api('GET', '/v1/health');
    assert.equal(health.body.security.docsEnabled, false);
    assert.equal((await ts.api('GET', '/v1/health')).status, 200, 'core API keeps working');
  } finally {
    await ts.close();
  }
});

test('AGIL_ADMIN_API_ENABLED=0 → all /v1/admin/* are indistinguishable 404', async () => {
  const ts = await startTestServer({ adminApiEnabled: false });
  try {
    const overview = await ts.api('GET', '/v1/admin/overview', { headers: ADMIN });
    assert.equal(overview.status, 404);
    assert.equal(overview.body.error.code, 'not_found');
    const rooms = await ts.api('GET', '/v1/admin/rooms', { headers: ADMIN });
    assert.equal(rooms.status, 404);
    const unknown = await ts.api('GET', '/v1/definitely-not-a-route');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'not_found');
    assert.equal(overview.body.error.code, 'not_found');
    // Public API and WS still work.
    const created = await ts.api('POST', '/v1/rooms', { body: { name: 'No admin' } });
    assert.equal(created.status, 200);
    const health = await ts.api('GET', '/v1/health');
    assert.equal(health.body.security.adminApiEnabled, false);
  } finally {
    await ts.close();
  }
});

test('IP allowlists (CIDR) for docs and admin use the resolved client IP', async () => {
  const ts = await startTestServer({
    trustProxy: true,
    docsAllowIps: ['203.0.113.0/24'],
    adminAllowIps: ['10.0.0.0/8', '127.0.0.1'],
  });
  try {
    const blockedDocs = await ts.api('GET', '/openapi.json', { headers: { 'x-forwarded-for': '198.51.100.9' } });
    assert.equal(blockedDocs.status, 404, 'docs allowlist hides the surface');

    const allowedDocs = await ts.api('GET', '/openapi.json', { headers: { 'x-forwarded-for': '203.0.113.7' } });
    assert.equal(allowedDocs.status, 200);
    const adminSpecBlocked = await ts.api('GET', '/openapi.admin.json', { headers: { 'x-forwarded-for': '198.51.100.9' } });
    assert.equal(adminSpecBlocked.status, 404);
    const adminSpecAllowed = await ts.api('GET', '/openapi.admin.json', { headers: { 'x-forwarded-for': '203.0.113.7' } });
    assert.equal(adminSpecAllowed.status, 200);

    const adminBlocked = await ts.api('GET', '/v1/admin/overview', {
      headers: { ...ADMIN, 'x-forwarded-for': '198.51.100.9' },
    });
    assert.equal(adminBlocked.status, 403);
    const adminAllowed = await ts.api('GET', '/v1/admin/overview', {
      headers: { ...ADMIN, 'x-forwarded-for': '10.9.8.7' },
    });
    assert.equal(adminAllowed.status, 200);
  } finally {
    await ts.close();
  }
});

test('AGIL_DOCS_PORT isolates docs/OpenAPI on a dedicated HTTP port', async () => {
  const docsPort = await freePort();
  const ts = await startTestServer({ docsPort, docsHost: '127.0.0.1' });
  try {
    assert.equal(ts.server.docsPort, docsPort);
    assert.ok(ts.server.docsServer);
    const docsBase = `http://127.0.0.1:${docsPort}`;
    const onDocsPort = async (route: string): Promise<{ status: number; body: any }> => {
      const response = await fetch(`${docsBase}${route}`);
      const text = await response.text();
      let body: any = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* html/text */
      }
      return { status: response.status, body };
    };
    assert.equal((await onDocsPort('/openapi.json')).status, 200);
    assert.equal((await onDocsPort('/openapi.admin.json')).status, 200);
    assert.equal((await onDocsPort('/docs')).status, 200);
    assert.equal((await onDocsPort('/v1/health')).status, 404, 'docs port serves documentation only');
    assert.equal((await onDocsPort('/v1/admin/overview')).status, 404);

    // Main port keeps the API but no longer serves docs.
    assert.equal((await ts.api('GET', '/v1/health')).status, 200);
    assert.equal((await ts.api('GET', '/openapi.json')).status, 404);
    assert.equal((await ts.api('GET', '/docs')).status, 404);
  } finally {
    await ts.close();
  }
});

test('docs rate limit is enforced per client IP', async () => {
  const ts = await startTestServer({ docsRateLimitPerMin: 3 });
  try {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await ts.api('GET', '/openapi.json')).status);
    }
    assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
    assert.equal(statuses[3], 429);
    assert.equal((await ts.api('GET', '/openapi.admin.json')).status, 429);
    assert.equal((await ts.api('GET', '/v1/health')).status, 200, 'rate limit is docs-only');
  } finally {
    await ts.close();
  }
});

test('docs response is never cached and has no secrets', async () => {
  const ts = await startTestServer();
  try {
    const docs = await ts.api('GET', '/docs');
    assert.equal(docs.headers.get('cache-control'), 'no-cache');
    const spec = await ts.api('GET', '/openapi.json');
    assert.equal(spec.headers.get('cache-control'), 'no-store');
    const text = JSON.stringify(spec.body);
    // Placeholder example passwords are fine; real secrets/hashes/env names are not.
    assert.ok(!/passwordHash|AGIL_TOKEN_SECRET|AGIL_API_KEYS|audit-secret|turn-secret-value|sfu-secret-value/i.test(text), 'no secrets in the public spec');
  } finally {
    await ts.close();
  }
});

// Keep the type import used even if helpers evolve.
export type { TestServer };
