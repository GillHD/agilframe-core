/** Health, ICE, tenant configuration: public reads + admin writes. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { TenantStore } from '../src/tenants.js';
import { startTestServer, type TestServer } from './helpers.js';

let ts: TestServer;

before(async () => {
  ts = await startTestServer();
});

after(async () => {
  await ts.close();
});

test('GET /v1/health returns the contract shape and security headers', async () => {
  const response = await ts.api('GET', '/v1/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(typeof response.body.rooms, 'number');
  assert.equal(typeof response.body.tenants, 'number');
  assert.equal(typeof response.body.security.sttConfigured, 'boolean');
  assert.equal(typeof response.body.security.geoEnabled, 'boolean');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.ok(response.headers.get('permissions-policy')?.includes('camera=(self)'));
  assert.ok(response.headers.get('x-request-id'));
});

test('GET /v1/ice returns the configured STUN server', async () => {
  const response = await ts.api('GET', '/v1/ice');
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.iceServers));
  assert.equal(response.body.iceServers[0].urls, 'stun:stun.l.google.com:19302');
});

test('a complete editor draft can clear optional gallery budget overrides', async () => {
  const route = '/v1/tenants/acme/config';
  const headers = { 'x-api-key': 'acme-key' };
  const seeded = await ts.api('PATCH', route, {
    headers, body: { limits: { galleryVideoBudget: 2 }, scale: { maxVisibleVideos: 3 } },
  });
  assert.equal(seeded.status, 200);
  const ordinary = await ts.api('PATCH', route, { headers, body: { limits: { maxDurationMin: 60 } } });
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.body.config.limits.galleryVideoBudget, 2);
  assert.equal(ordinary.body.config.scale.maxVisibleVideos, 3);
  const draft = ordinary.body.config;
  delete draft.limits.galleryVideoBudget;
  delete draft.scale.maxVisibleVideos;
  const published = await ts.api('PATCH', route, { headers, body: { editorDraft: draft } });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const saved = await ts.api('GET', route);
  assert.equal(saved.body.config.limits.galleryVideoBudget, undefined);
  assert.equal(saved.body.config.scale.maxVisibleVideos, undefined);
  assert.equal(saved.body.config.limits.maxDurationMin, 60);
});

test('only one of two draft publications based on the same configuration can commit', async () => {
  const route = '/v1/tenants/acme/config';
  const headers = { 'x-api-key': 'acme-key' };
  const { config, etag } = (await ts.api('GET', route)).body;
  const publish = (name: string) => ts.api('PATCH', route, {
    headers,
    body: { editorDraft: { ...config, branding: { ...config.branding, productName: name } }, baseEtag: etag },
  });
  const results = await Promise.all([publish('First editor'), publish('Second editor')]);
  const accepted = results.find((result) => result.status === 200);
  const conflict = results.find((result) => result.status === 409);
  assert.ok(accepted && conflict);
  assert.equal(conflict.body.error.code, 'config_conflict');
  const saved = await ts.api('GET', route);
  assert.equal(saved.body.config.branding.productName, accepted.body.config.branding.productName);
  assert.equal(saved.body.etag, accepted.body.etag);
});

test('tenant config: public read, default for unknown tenant, admin write', async () => {
  const read = await ts.api('GET', '/v1/tenants/demo/config');
  assert.equal(read.status, 200);
  assert.equal(read.body.config.tenantId, 'demo');
  assert.equal(typeof read.body.config.theme.colors.primary, 'string');
  assert.equal(typeof read.body.etag, 'string');

  const unknown = await ts.api('GET', '/v1/tenants/unknown-tenant/config');
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.config.tenantId, 'unknown-tenant');

  const noKey = await ts.api('PATCH', '/v1/tenants/demo/config', { body: { branding: { productName: 'Hacked' } } });
  assert.equal(noKey.status, 401);
  assert.equal(noKey.body.error.code, 'unauthorized');

  const foreign = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: { 'x-api-key': 'acme-key' },
    body: { branding: { productName: 'Hacked' } },
  });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error.code, 'forbidden');

  const invalid = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: { 'x-api-key': 'dev-key' },
    body: { limits: { maxParticipants: 0 } },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'validation_failed');

  const patched = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: { 'x-api-key': 'dev-key' },
    body: { branding: { productName: 'ACME Calls' }, theme: { colors: { primary: '#0b5fff' } } },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.config.branding.productName, 'ACME Calls');
  assert.notEqual(patched.body.etag, read.body.etag);
  const reRead = await ts.api('GET', '/v1/tenants/demo/config');
  assert.equal(reRead.body.config.branding.productName, 'ACME Calls');
});

test('PUT tenant config replaces the document and validates its shape', async () => {
  const current = await ts.api('GET', '/v1/tenants/demo/config');
  const config = current.body.config;
  config.room.name = 'Полная замена';
  const replaced = await ts.api('PUT', '/v1/tenants/demo/config', {
    headers: { 'x-api-key': 'dev-key' },
    body: config,
  });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.config.room.name, 'Полная замена');

  const broken = await ts.api('PUT', '/v1/tenants/demo/config', {
    headers: { 'x-api-key': 'dev-key' },
    body: { configVersion: 1 },
  });
  assert.equal(broken.status, 400);
  assert.ok(Array.isArray(broken.body.error.details));
});

test('editor publication revokes removed overrides while ordinary PATCH merges records', async () => {
  const route = '/v1/tenants/acme/config';
  const headers = { 'x-api-key': 'acme-key' };
  const seed = await ts.api('PATCH', route, { headers, body: {
    branding: {
      customDomain: 'meet.acme.test',
      mascotExpressions: { wave: '/wave.png', thinking: '/thinking.png' },
    },
    security: { accessPolicy: { userOverrides: { member: ['chat'], colleague: ['fileShare'] } } },
  } });
  assert.equal(seed.status, 200);

  const merged = await ts.api('PATCH', route, { headers, body: {
    branding: { mascotExpressions: { wave: '/updated.png' } },
    security: { accessPolicy: { userOverrides: { member: ['recording'] } } },
  } });
  assert.equal(merged.status, 200);
  assert.equal(merged.body.editorDraftPublished, undefined);
  assert.deepEqual(merged.body.config.branding.mascotExpressions, { wave: '/updated.png', thinking: '/thinking.png' });
  assert.deepEqual(merged.body.config.security.accessPolicy.userOverrides, { member: ['recording'], colleague: ['fileShare'] });

  const editorDraft = structuredClone(merged.body.config);
  delete editorDraft.branding.mascotExpressions.wave;
  delete editorDraft.security.accessPolicy.userOverrides.member;
  editorDraft.branding.customDomain = 'unused.acme.test';
  editorDraft.branding.productName = 'Published from editor';

  const foreign = await ts.api('PATCH', route, { headers: { 'x-api-key': 'dev-key' }, body: { editorDraft } });
  assert.equal(foreign.status, 403);
  const invalid = await ts.api('PATCH', route, { headers, body: { editorDraft: { branding: { productName: 'Partial draft' } } } });
  assert.equal(invalid.status, 400);
  const mixed = await ts.api('PATCH', route, { headers, body: { editorDraft, branding: { productName: 'Mixed request' } } });
  assert.equal(mixed.status, 400);
  assert.equal((await ts.api('GET', route)).body.etag, merged.body.etag);

  const published = await ts.api('PATCH', route, { headers, body: { editorDraft } });
  assert.equal(published.status, 200);
  assert.equal(published.body.editorDraftPublished, true);
  assert.equal(published.body.config.branding.productName, 'Published from editor');
  assert.equal(published.body.config.branding.customDomain, 'meet.acme.test');
  assert.deepEqual(published.body.config.branding.mascotExpressions, { thinking: '/thinking.png' });
  assert.deepEqual(published.body.config.security.accessPolicy.userOverrides, { colleague: ['fileShare'] });

  const clear = structuredClone(published.body.config);
  delete clear.branding.mascotExpressions;
  clear.security.accessPolicy.userOverrides = {};
  const cleared = await ts.api('PATCH', route, { headers, body: { editorDraft: clear } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.editorDraftPublished, true);
  const persisted = await ts.api('GET', route);
  assert.deepEqual(persisted.body.config.branding.mascotExpressions, {});
  assert.deepEqual(persisted.body.config.security.accessPolicy.userOverrides, {});
  const tenantDir = join(ts.dataDir, 'tenants');
  assert.deepEqual(new TenantStore({ dir: tenantDir }).getConfig('acme').security.accessPolicy.userOverrides, {});

  const filename = join(tenantDir, 'acme.json');
  const previousFile = join(tenantDir, 'acme.qa-previous');
  renameSync(filename, previousFile);
  mkdirSync(filename);
  try {
    clear.branding.productName = 'Must remain a draft';
    const failedWrite = await ts.api('PATCH', route, { headers, body: { editorDraft: clear } });
    assert.equal(failedWrite.status, 500);
    assert.equal((await ts.api('GET', route)).body.etag, persisted.body.etag);
  } finally {
    rmdirSync(filename);
    renameSync(previousFile, filename);
  }
});

test('SSRF policy rejects unsafe AI/knowledge/webhook endpoints', async () => {
  const cases = [
    { session: { aiAgent: { endpoint: 'file:///etc/passwd' } } },
    { session: { knowledgeAgent: { endpoint: 'http://169.254.169.254/latest/meta-data' } } },
    { integrations: { webhooks: [{ id: 'w1', url: 'http://10.0.0.1/hook', events: ['room.created'], secretEnv: 'X_KEY', enabled: true, retries: 0, timeoutMs: 1000 }] } },
  ];
  for (const body of cases) {
    const response = await ts.api('PATCH', '/v1/tenants/demo/config', { headers: { 'x-api-key': 'dev-key' }, body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error.code, 'validation_failed');
  }
});
