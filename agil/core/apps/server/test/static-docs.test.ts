/** Static serving, SPA fallback, security headers, /docs and /openapi.json. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startTestServer, type TestServer } from './helpers.js';

let ts: TestServer;
let staticDir: string;
let repoDocsDir: string;

before(async () => {
  staticDir = mkdtempSync(path.join(tmpdir(), 'agil-static-'));
  writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>AGIL demo</title><div id="demo-marker">ok</div>');
  writeFileSync(path.join(staticDir, 'embed.html'), '<!doctype html><title>embed</title><div>embed</div>');
  writeFileSync(path.join(staticDir, 'app.js'), 'console.log("hi")');
  writeFileSync(path.join(staticDir, 'agil-calls.js'), 'window.AgilFrame = {};');
  repoDocsDir = mkdtempSync(path.join(tmpdir(), 'agil-docs-'));
  writeFileSync(path.join(repoDocsDir, 'api.md'), '# API\n\nПолная документация.');
  writeFileSync(path.join(repoDocsDir, 'openapi.json'), JSON.stringify({ openapi: '3.1.0' }));
  ts = await startTestServer({ staticDir, docsDir: repoDocsDir, sdkDir: staticDir });
});

after(async () => {
  await ts.close();
  rmSync(staticDir, { recursive: true, force: true });
  rmSync(repoDocsDir, { recursive: true, force: true });
});

test('GET / serves the demo index.html with no-cache; only known pages use the SPA shell', async () => {
  const root = await ts.api('GET', '/');
  assert.equal(root.status, 200);
  assert.ok(root.text.includes('demo-marker'));
  assert.ok(root.headers.get('content-type')?.includes('text/html'));
  assert.equal(root.headers.get('cache-control'), 'no-cache');

  const explicitIndex = await ts.api('GET', '/index.html');
  assert.equal(explicitIndex.status, 200);
  assert.ok(explicitIndex.text.includes('demo-marker'));

  // Editor/dashboard SPAs keep their client-side routing.
  const editorRoute = await ts.api('GET', '/editor/deep/client/route');
  assert.equal(editorRoute.status, 200);
  assert.ok(editorRoute.headers.get('content-type')?.includes('text/html'));

  const asset = await ts.api('GET', '/app.js');
  assert.equal(asset.status, 200);
  assert.ok(asset.headers.get('content-type')?.includes('javascript'));
});

test('F-05: unknown paths, /api/* and /mcp return JSON 404 instead of demo HTML', async () => {
  for (const pathname of ['/definitely-not-a-route-qa', '/nonexistent', '/mcp', '/api/', '/api/v1/thing', '/some/client/route']) {
    const response = await ts.api('GET', pathname);
    assert.equal(response.status, 404, `expected 404 for ${pathname}`);
    assert.equal(response.body.error.code, 'not_found', `expected JSON error for ${pathname}`);
    assert.ok(!response.text.includes('demo-marker'), `${pathname} must not leak the demo HTML`);
  }
});

test('both SDK URLs serve the same JavaScript bundle', async () => {
  const current = await ts.api('GET', '/sdk/agilframe.js');
  const legacy = await ts.api('GET', '/sdk/agil-calls.js');
  assert.equal(current.status, 200);
  assert.equal(legacy.status, 200);
  assert.match(current.headers.get('content-type') ?? '', /javascript/);
  assert.equal(current.text, legacy.text);
});

test('embed.html gets an explicit frame-ancestors CSP (no COOP)', async () => {
  const embed = await ts.api('GET', '/embed.html');
  assert.equal(embed.status, 200);
  assert.ok(embed.headers.get('content-security-policy')?.includes('frame-ancestors'));
  assert.equal(embed.headers.get('cross-origin-opener-policy'), null);
});

test('legacy call links bypass the optional demo page and preserve their query', async () => {
  const query = '?room=qa-room&tenant=demo&token=fixture&name=QA%20Guest';
  for (const [method, entry] of [['GET', '/'], ['HEAD', '/index.html']] as const) {
    const response = await ts.api(method, entry + query);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `/embed.html${query}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
  assert.equal((await ts.api('GET', '/?room=')).status, 200);
});

test('unknown /v1 route → JSON 404; missing static asset → JSON 404; traversal blocked', async () => {
  const unknown = await ts.api('GET', '/v1/definitely-not-a-route');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'not_found');

  const missing = await ts.api('GET', '/widget/missing.js');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');

  const traversal = await ts.api('GET', '/editor/..%2f..%2fpackage.json');
  assert.ok([400, 404].includes(traversal.status), `status ${traversal.status}`);
  assert.ok(!traversal.text.includes('"workspaces"'));
});

test('repository docs are served read-only as markdown/json', async () => {
  const markdown = await ts.api('GET', '/docs/api.md');
  assert.equal(markdown.status, 200);
  assert.ok(markdown.headers.get('content-type')?.includes('text/markdown'));
  assert.match(markdown.text, /Полная документация/);
  assert.equal(markdown.headers.get('cache-control'), 'no-store');

  const json = await ts.api('GET', '/docs/openapi.json');
  assert.equal(json.status, 200);
  assert.ok(json.headers.get('content-type')?.includes('application/json'));
  assert.equal(json.body.openapi, '3.1.0');

  const missing = await ts.api('GET', '/docs/missing.md');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');

  const traversal = await ts.api('GET', '/docs/..%2fpackage.json');
  assert.equal(traversal.status, 404);
});

test('GET /docs is a self-contained offline explorer', async () => {
  const docs = await ts.api('GET', '/docs');
  assert.equal(docs.status, 200);
  assert.ok(docs.headers.get('content-type')?.includes('text/html'));
  assert.ok(docs.text.includes('Документация API AgilFrame'));
  assert.match(docs.text, /<details class="guide" id="guide">\s*<summary>С чего начать<\/summary>/, 'quick-start guide is collapsed by default');
  assert.ok(docs.text.includes('Авторизация') && docs.text.includes('Коды ошибок'));
  assert.ok(docs.text.includes('Копировать curl'), 'explorer can generate curl examples');
  assert.ok(docs.text.includes('/wiki/#sdk'), 'explorer links the integration guide in Wiki');
  assert.ok(!docs.text.includes('Copy curl') && !docs.text.includes('>Send<'), 'actions are localized');
  assert.ok(!/https?:\/\/cdn\./i.test(docs.text), 'explorer must not depend on a CDN');
  assert.ok(docs.headers.get('content-security-policy')?.includes("default-src 'self'"));

  // ED-01: path/query/header parameters get inputs and missing path params block Send/curl.
  assert.ok(docs.text.includes("p.in === 'path'"));
  assert.ok(docs.text.includes('Заполните обязательные параметры'));
  assert.ok(docs.text.includes('Параметры'));
  // ED-05: AA-safe light-theme tokens (links/primary/method GET/placeholder).
  assert.ok(docs.text.includes('--accent:#1d4ed8'), 'light links/primary pass AA');
  assert.ok(docs.text.includes('--accent-strong:#1d4ed8'));
  assert.ok(docs.text.includes('--get:#0a7a43'), 'light GET badge passes AA');
  assert.ok(docs.text.includes('--placeholder:#4b5563'));
  assert.ok(docs.text.includes('min-height:40px'), 'controls meet the 40px target');
  // ED-09/ED-18: public docs menu is curated, collapsed, and titles lose raw backticks.
  assert.ok(docs.text.includes('Публичные документы'));
  assert.ok(docs.text.includes('<details class="guide" id="docs-menu">'));
  assert.ok(!/qa-[a-z]/.test(docs.text), 'internal QA docs are not listed');
  assert.ok(!docs.text.includes('backlog.md'));
  assert.ok(!docs.text.includes('estimate.md'));
  assert.ok(!docs.text.includes('security-audit.md'));
});

test('GET /openapi.json is a valid public OpenAPI 3.1 document (no admin surface)', async () => {
  const response = await ts.api('GET', '/openapi.json');
  assert.equal(response.status, 200);
  const spec = response.body;
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(typeof spec.info.title, 'string');
  assert.equal(spec.components.securitySchemes.bearer.scheme, 'bearer');
  assert.equal(spec.components.securitySchemes.apiKey, undefined, 'public spec must not expose the admin key scheme');
  assert.ok(!Object.keys(spec.paths).some((route) => route.startsWith('/v1/admin/')), 'public spec hides admin paths');
  for (const route of ['/v1/health', '/v1/rooms/{roomId}/join', '/v1/tenants/{tenantId}/backgrounds']) {
    assert.ok(spec.paths[route], `missing path ${route}`);
  }
  assert.ok(Object.keys(spec.paths).length >= 10);

  const admin = await ts.api('GET', '/openapi.admin.json');
  assert.equal(admin.status, 200);
  assert.equal(admin.body.components.securitySchemes.apiKey.in, 'header');
  assert.ok(admin.body.paths['/v1/admin/overview']);
  assert.ok(admin.body.paths['/v1/admin/access-policy']);
  assert.ok(admin.body.paths['/v1/admin/providers']);
  assert.ok(admin.body.paths['/v1/admin/webhooks']);
  assert.ok(admin.body.paths['/v1/admin/roles']);
  assert.ok(admin.body.paths['/v1/admin/roles/{id}']);
  assert.equal(admin.body.paths['/v1/admin/roles'].post.requestBody.content['application/json'].example.id, 'streamer');
  assert.ok((admin.body.info.description as string).includes('/docs/api-guide.md'));
  assert.ok(admin.body.paths['/v1/admin/scale'].get.summary.match(/[а-яА-Я]/), 'Russian summaries for humans');
  assert.ok(Object.keys(admin.body.paths).length > Object.keys(spec.paths).length);

  // Cluster/enrollment surface (docs/api/cluster.md) is discoverable in both specs.
  for (const route of ['/v1/cluster/join', '/v1/nodes/register', '/v1/nodes/{nodeId}/heartbeat']) {
    assert.ok(spec.paths[route], `public spec is missing ${route}`);
    assert.ok(admin.body.paths[route], `admin spec is missing ${route}`);
  }
  assert.equal(
    spec.paths['/v1/nodes/{nodeId}/heartbeat'].post.parameters[1].name,
    'x-node-token',
    'heartbeat credential is documented',
  );
  // Live node metrics are documented on both the heartbeat request and NodeSummary.
  const heartbeatSpec = spec.paths['/v1/nodes/{nodeId}/heartbeat'].post;
  assert.equal(heartbeatSpec.requestBody.content['application/json'].schema.$ref, '#/components/schemas/NodeHeartbeatRequest');
  assert.equal(
    spec.components.schemas.NodeHeartbeatRequest.properties.metrics.$ref,
    '#/components/schemas/NodeMetricsInput',
    'heartbeat accepts optional metrics',
  );
  const metricsInput = spec.components.schemas.NodeMetricsInput;
  assert.equal(metricsInput.properties.cpuPercent.type, 'number');
  assert.equal(metricsInput.properties.cpuPercent.minimum, 0);
  assert.equal(metricsInput.properties.cpuPercent.maximum, 100);
  assert.equal(metricsInput.properties.activeRooms.type, 'integer');
  assert.equal(spec.components.schemas.NodeMetrics.properties.reportedAt.type, 'integer');
  assert.equal(
    spec.components.schemas.NodeSummary.properties.metrics.$ref,
    '#/components/schemas/NodeMetrics',
    'node summaries expose the last metrics snapshot',
  );
  assert.ok(admin.body.components.schemas.NodeMetricsInput && admin.body.components.schemas.NodeMetrics);
  for (const route of [
    '/v1/admin/cluster/tokens',
    '/v1/admin/cluster/tokens/{tokenId}',
    '/v1/admin/nodes',
    '/v1/admin/nodes/{nodeId}',
    '/v1/admin/nodes/{nodeId}/disable',
    '/v1/admin/nodes/{nodeId}/drain',
    '/v1/admin/nodes/{nodeId}/rotate-key',
  ]) {
    assert.ok(admin.body.paths[route], `admin spec is missing ${route}`);
    assert.equal(spec.paths[route], undefined, `public spec must not expose ${route}`);
  }
  assert.ok(admin.body.components.schemas.NodeKeyRotationResponse);
  assert.ok(spec.paths['/v1/nodes/register'].post.responses['201']);

  // Per-node modules (docs/api/cluster.md §10): catalog + control are admin-only,
  // while the heartbeat/NodeSummary module fields are part of the public contract.
  for (const route of [
    '/v1/admin/node-modules/catalog',
    '/v1/admin/nodes/{nodeId}/modules',
    '/v1/admin/nodes/{nodeId}/modules/{moduleId}/actions',
  ]) {
    assert.ok(admin.body.paths[route], `admin spec is missing ${route}`);
    assert.equal(spec.paths[route], undefined, `public spec must not expose ${route}`);
  }
  const catalogSpec = admin.body.paths['/v1/admin/node-modules/catalog'].get;
  assert.match(catalogSpec.summary, /Allowlisted node add-on modules/);
  const actionSpec = admin.body.paths['/v1/admin/nodes/{nodeId}/modules/{moduleId}/actions'].post;
  assert.equal(actionSpec.requestBody.content['application/json'].schema.$ref, '#/components/schemas/NodeModuleActionRequest');
  assert.equal(actionSpec.requestBody.content['application/json'].example.action, 'restart');
  assert.equal(
    spec.components.schemas.NodeSummary.properties.modules.items.$ref,
    '#/components/schemas/NodeModule',
    'node summaries expose the module inventory',
  );
  assert.equal(
    spec.components.schemas.NodeHeartbeatRequest.properties.modules.items.$ref,
    '#/components/schemas/NodeModuleReport',
  );
  assert.equal(
    spec.components.schemas.NodeHeartbeatRequest.properties.moduleResults.items.$ref,
    '#/components/schemas/NodeModuleResult',
  );
  assert.equal(
    spec.components.schemas.NodeHeartbeatResponse.properties.moduleCommands.items.$ref,
    '#/components/schemas/NodeModuleCommand',
  );
  assert.deepEqual(spec.components.schemas.NodeModule.properties.status.enum, [
    'running',
    'stopped',
    'error',
    'installing',
    'unknown',
  ]);
  assert.equal(spec.components.schemas.NodeModuleCommand.properties.image.type, 'string');
  assert.ok(admin.body.components.schemas.NodeModuleCatalogEntry.properties.env);
});
