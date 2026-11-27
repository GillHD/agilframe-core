/** SaaS multi-tenancy: platform key, tenant onboarding, dynamic keys, isolation. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio, defaultConfig } from '@agil/protocol';
import { TenantStore } from '../src/tenants.js';
import { startTestServer, type TestServer } from './helpers.js';

const PLATFORM = { 'x-api-key': 'platform-secret' };
const DEMO = { 'x-api-key': 'dev-key' };
let ts: TestServer;
const created: Array<{ tenantId: string; apiKey: string }> = [];

before(async () => {
  ts = await startTestServer({ platformKey: 'platform-secret' });
});

after(async () => {
  for (const tenant of created) {
    await ts.api('DELETE', `/v1/admin/tenants/${tenant.tenantId}`, { headers: PLATFORM });
  }
  await ts.close();
});

test('persisted legacy product branding is read as AgilFrame and company branding is preserved', () => {
  const directory = join(ts.dataDir, 'brand-migration');
  mkdirSync(directory);
  for (const [tenantId, name] of [['legacy-brand', 'AGIL Calls'], ['company-brand', 'Acme Connect']] as const) {
    const config = defaultConfig({ tenantId });
    config.branding.productName = name;
    writeFileSync(join(directory, `${tenantId}.json`), JSON.stringify(config));
  }
  const store = new TenantStore({ dir: directory });
  assert.equal(store.getConfig('legacy-brand').branding.productName, 'AgilFrame');
  assert.equal(store.getConfig('company-brand').branding.productName, 'Acme Connect');
});

test('platform tenants list: auth + TenantSummary without secrets', async () => {
  assert.equal((await ts.api('GET', '/v1/admin/tenants')).status, 401);
  assert.equal((await ts.api('GET', '/v1/admin/tenants', { headers: DEMO })).status, 403);

  const list = await ts.api('GET', '/v1/admin/tenants', { headers: PLATFORM });
  assert.equal(list.status, 200);
  assert.equal(list.body.platform, true);
  const demo = list.body.tenants.find((tenant: { tenantId: string }) => tenant.tenantId === 'demo');
  assert.ok(demo);
  assert.equal(demo.apiKeyConfigured, true);
  assert.equal(typeof demo.rooms, 'number');
  assert.equal(typeof demo.participants, 'number');
  assert.equal(typeof demo.recordings, 'number');
  assert.ok(!JSON.stringify(list.body).includes('dev-key'), 'tenant keys are never listed');
  assert.ok(!JSON.stringify(list.body).includes('platform-secret'));
});

test('create organisation: defaults/presets/branding, plaintext key once, validation', async () => {
  const createdOrg = await ts.api('POST', '/v1/admin/tenants', {
    headers: PLATFORM,
    body: {
      tenantId: 'org-a',
      name: 'Org A',
      organizationName: 'A LLC',
      branding: { productName: 'A Calls', logoUrl: 'https://a.example/logo.png', supportUrl: 'https://a.example/help' },
      theme: { scheme: 'dark' },
      preset: 'corporate',
      features: { fileShare: true },
    },
  });
  assert.equal(createdOrg.status, 200, JSON.stringify(createdOrg.body));
  assert.match(createdOrg.body.apiKey, /^agil_/);
  assert.equal(createdOrg.body.apiKey.split('.').length, 1);
  assert.ok(createdOrg.body.embedUrl.includes('tenant=org-a'));
  assert.equal(createdOrg.body.tenant.tenantId, 'org-a');
  assert.equal(createdOrg.body.tenant.name, 'A Calls');
  assert.equal(createdOrg.body.tenant.organizationName, 'A LLC');
  assert.equal(createdOrg.body.tenant.logoUrl, 'https://a.example/logo.png');
  assert.equal(createdOrg.body.tenant.scheme, 'dark');
  assert.equal(createdOrg.body.tenant.apiKeyConfigured, true);
  created.push({ tenantId: 'org-a', apiKey: createdOrg.body.apiKey });

  const config = await ts.api('GET', '/v1/tenants/org-a/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.config.branding.productName, 'A Calls');
  assert.equal(config.body.config.security.waitingRoom, true, 'corporate preset is stricter');
  assert.equal(config.body.config.features.fileShare, true, 'explicit flags override the preset');
  assert.equal(config.body.config.features.recording, false, 'other preset flags remain in force');

  const duplicate = await ts.api('POST', '/v1/admin/tenants', { headers: PLATFORM, body: { tenantId: 'org-a', name: 'Again' } });
  assert.equal(duplicate.status, 409);
  const invalidId = await ts.api('POST', '/v1/admin/tenants', { headers: PLATFORM, body: { tenantId: 'bad/id', name: 'X' } });
  assert.equal(invalidId.status, 400);
  const invalidPreset = await ts.api('POST', '/v1/admin/tenants', { headers: PLATFORM, body: { tenantId: 'org-x', name: 'X', preset: 'nope' } });
  assert.equal(invalidPreset.status, 400);
  const unknownTemplate = await ts.api('POST', '/v1/admin/tenants', { headers: PLATFORM, body: { tenantId: 'org-x', name: 'X', templateTenantId: 'nope' } });
  assert.equal(unknownTemplate.status, 400);

  const second = await ts.api('POST', '/v1/admin/tenants', { headers: PLATFORM, body: { tenantId: 'org-b', name: 'Org B', preset: 'minimal' } });
  assert.equal(second.status, 200);
  created.push({ tenantId: 'org-b', apiKey: second.body.apiKey });
  const secondConfig = await ts.api('GET', '/v1/tenants/org-b/config');
  assert.equal(secondConfig.body.config.features.fileShare, false);
});

test('dynamic tenant key works, tenant isolation holds', async () => {
  const orgA = created.find((tenant) => tenant.tenantId === 'org-a')!;
  const orgB = created.find((tenant) => tenant.tenantId === 'org-b')!;

  const overview = await ts.api('GET', '/v1/admin/overview', { headers: { 'x-api-key': orgA.apiKey } });
  assert.equal(overview.status, 200);
  assert.equal(overview.body.tenantId, 'org-a');

  // A cannot read B's summary or data.
  assert.equal((await ts.api('GET', '/v1/admin/tenants/org-b', { headers: { 'x-api-key': orgA.apiKey } })).status, 403);
  assert.equal((await ts.api('GET', '/v1/admin/tenants/org-a', { headers: { 'x-api-key': orgA.apiKey } })).status, 200);
  assert.equal((await ts.api('GET', '/v1/admin/tenants/org-a', { headers: PLATFORM })).status, 200);
  assert.equal((await ts.api('GET', '/v1/admin/overview', { headers: PLATFORM })).status, 403, 'platform key is not a tenant key');

  // Rooms are tenant-scoped: a room of B is invisible to A.
  const roomB = await ts.api('POST', '/v1/admin/rooms', { headers: { 'x-api-key': orgB.apiKey }, body: { name: 'B room' } });
  assert.equal(roomB.status, 200);
  const roomBId = roomB.body.room.id;
  assert.equal((await ts.api('GET', `/v1/admin/rooms/${roomBId}`, { headers: { 'x-api-key': orgA.apiKey } })).status, 403);
  const listB = await ts.api('GET', '/v1/admin/rooms', { headers: { 'x-api-key': orgB.apiKey } });
  assert.ok(listB.body.rooms.length >= 1);
});

test('key rotation invalidates the previous dynamic key; platform audit is not exposed to tenants', async () => {
  const orgA = created.find((tenant) => tenant.tenantId === 'org-a')!;
  const rotated = await ts.api('POST', '/v1/admin/tenants/org-a/keys', { headers: PLATFORM });
  assert.equal(rotated.status, 200);
  assert.match(rotated.body.apiKey, /^agil_/);
  assert.equal(rotated.body.tenantId, 'org-a');
  assert.equal((await ts.api('GET', '/v1/admin/overview', { headers: { 'x-api-key': orgA.apiKey } })).status, 401, 'old key revoked');
  assert.equal((await ts.api('GET', '/v1/admin/overview', { headers: { 'x-api-key': rotated.body.apiKey } })).status, 200);
  orgA.apiKey = rotated.body.apiKey;

  const tenantsAudit = await ts.api('GET', '/v1/admin/audit?limit=200', { headers: { 'x-api-key': orgA.apiKey } });
  assert.equal(tenantsAudit.status, 200);
  const kinds = tenantsAudit.body.entries.map((entry: { details?: { kind?: string } }) => entry.details?.kind);
  assert.ok(kinds.includes('tenant.created'));
  assert.ok(kinds.includes('tenant.key.rotated'));

  const unknownTenantKey = await ts.api('POST', '/v1/admin/tenants/org-a/keys', { headers: { 'x-api-key': orgA.apiKey } });
  assert.equal(unknownTenantKey.status, 403, 'only platform can rotate keys');
});

test('PATCH tenant: platform/self only; delete protections and cleanup', async () => {
  const orgA = created.find((tenant) => tenant.tenantId === 'org-a')!;
  const patched = await ts.api('PATCH', '/v1/admin/tenants/org-a', {
    headers: PLATFORM,
    body: { branding: { productName: 'A Calls v2' }, organizationName: 'A LLC 2' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.name, 'A Calls v2');
  assert.equal(patched.body.organizationName, 'A LLC 2');

  const selfPatch = await ts.api('PATCH', '/v1/admin/tenants/org-a', {
    headers: { 'x-api-key': orgA.apiKey },
    body: { name: 'Self renamed' },
  });
  assert.equal(selfPatch.status, 200);
  assert.equal(selfPatch.body.name, 'Self renamed');

  const orgB = created.find((tenant) => tenant.tenantId === 'org-b')!;
  assert.equal((await ts.api('PATCH', '/v1/admin/tenants/org-b', { headers: { 'x-api-key': orgA.apiKey }, body: { name: 'Nope' } })).status, 403);

  assert.equal((await ts.api('DELETE', '/v1/admin/tenants/demo', { headers: PLATFORM })).status, 400, 'demo is protected');
  assert.equal((await ts.api('DELETE', '/v1/admin/tenants/demo', { headers: DEMO })).status, 403, 'tenant key cannot manage tenants');

  const removed = await ts.api('DELETE', '/v1/admin/tenants/org-b', { headers: PLATFORM });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted, true);
  assert.equal((await ts.api('GET', '/v1/admin/overview', { headers: { 'x-api-key': orgB.apiKey } })).status, 401, 'deleted tenant key revoked');
  assert.equal((await ts.api('DELETE', '/v1/admin/tenants/org-b', { headers: PLATFORM })).status, 404);
  assert.equal((await ts.api('GET', '/v1/tenants/org-b/config')).status, 404);
  const reserved = await ts.api('POST', '/v1/admin/tenants', {
    headers: PLATFORM, body: { tenantId: 'org-b', name: 'New organization' },
  });
  assert.equal(reserved.status, 409, 'a retired organization keeps its ID');
  assert.equal((await ts.api('POST', '/v1/admin/tenants/org-b/keys', { headers: PLATFORM })).status, 404);
  assert.equal(new TenantStore({ dir: join(ts.dataDir, 'tenants') }).isRetired('org-b'), true);

  const all = await ts.server.services.audit.list({ limit: 1000 });
  const kinds = all.map((entry) => (entry.details as { kind?: string } | undefined)?.kind);
  assert.ok(kinds.includes('tenant.deleted'));
  assert.ok(kinds.includes('tenant.updated'));
  assert.ok(kinds.includes('tenant.key.rotated'));
});

test('older archived tenant IDs are recognized by a fresh store', () => {
  const dir = join(ts.dataDir, 'legacy-tenants');
  mkdirSync(join(dir, '.archive'), { recursive: true });
  writeFileSync(join(dir, '.archive', 'legacy-org-1720000000000.json'), '{}');
  writeFileSync(join(dir, '.archive', 'active-org-1720000000000.json'), '{}');
  const store = new TenantStore({ dir, initialTenants: ['active-org'] });
  assert.equal(store.isRetired('legacy-org'), true);
  assert.equal(store.isRetired('legacy'), false);
  assert.equal(store.isRetired('active-org'), false);
});

test('tenant theme: dark/light schemes get a COMPLETE palette with readable contrast', async () => {
  const dark = await ts.api('POST', '/v1/admin/tenants', {
    headers: PLATFORM,
    body: {
      tenantId: 'org-dark',
      name: 'Dark Org',
      theme: { scheme: 'dark', colors: { primary: '#22c55e', background: '#05080f', surface: '#0b1220' } },
    },
  });
  assert.equal(dark.status, 200, JSON.stringify(dark.body));
  created.push({ tenantId: 'org-dark', apiKey: dark.body.apiKey });
  const darkConfig = await ts.api('GET', '/v1/tenants/org-dark/config');
  const darkTheme = darkConfig.body.config.theme;
  assert.equal(darkTheme.scheme, 'dark');
  assert.equal(darkTheme.colors.background, '#05080f');
  assert.equal(darkTheme.colors.surface, '#0b1220');
  assert.equal(darkTheme.colors.primary, '#22c55e');
  // Semantic tokens must come from the dark palette, not the light default.
  assert.notEqual(darkTheme.colors.text.toLowerCase(), '#0f172a');
  assert.notEqual(darkTheme.colors.textSecondary.toLowerCase(), '#475569');
  assert.notEqual(darkTheme.colors.primaryHover.toLowerCase(), '#1d4ed8');
  assert.ok(contrastRatio(darkTheme.colors.text, darkTheme.colors.background) >= 4.5, 'text/background contrast');
  assert.ok(contrastRatio(darkTheme.colors.text, darkTheme.colors.surface) >= 4.5, 'text/surface contrast');
  assert.ok(contrastRatio(darkTheme.colors.textSecondary, darkTheme.colors.surface) >= 4.5, 'secondary/surface contrast');
  assert.ok(
    contrastRatio(darkTheme.colors.chatIncomingText, darkTheme.colors.chatIncomingBg) >= 4.5,
    'chat text contrast',
  );
  assert.ok(contrastRatio(darkTheme.colors.controlText, darkTheme.colors.controlBg) >= 4.5, 'control text contrast');

  const light = await ts.api('POST', '/v1/admin/tenants', {
    headers: PLATFORM,
    body: {
      tenantId: 'org-light',
      name: 'Light Org',
      theme: { scheme: 'light', colors: { primary: '#7c3aed', background: '#ffffff', surface: '#f8fafc' } },
    },
  });
  assert.equal(light.status, 200, JSON.stringify(light.body));
  created.push({ tenantId: 'org-light', apiKey: light.body.apiKey });
  const lightConfig = await ts.api('GET', '/v1/tenants/org-light/config');
  const lightTheme = lightConfig.body.config.theme;
  assert.equal(lightTheme.scheme, 'light');
  assert.equal(lightTheme.colors.text.toLowerCase(), '#0f172a');
  assert.equal(lightTheme.colors.background, '#ffffff');
  assert.ok(contrastRatio(lightTheme.colors.text, lightTheme.colors.background) >= 4.5);
  assert.ok(contrastRatio(lightTheme.colors.text, lightTheme.colors.surface) >= 4.5);
  assert.ok(
    contrastRatio(lightTheme.colors.chatIncomingText, lightTheme.colors.chatIncomingBg) >= 4.5,
    'light chat contrast',
  );
});

test('tenant theme PATCH: switching to dark rebuilds the full palette', async () => {
  const patched = await ts.api('PATCH', '/v1/admin/tenants/org-light', {
    headers: PLATFORM,
    body: { theme: { scheme: 'dark', colors: { background: '#070b14', surface: '#101826' } } },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const config = await ts.api('GET', '/v1/tenants/org-light/config');
  const theme = config.body.config.theme;
  assert.equal(theme.scheme, 'dark');
  assert.notEqual(theme.colors.text.toLowerCase(), '#0f172a');
  assert.ok(contrastRatio(theme.colors.text, theme.colors.background) >= 4.5);
  assert.ok(contrastRatio(theme.colors.text, theme.colors.surface) >= 4.5);
  assert.ok(contrastRatio(theme.colors.controlText, theme.colors.controlBg) >= 4.5);
});
