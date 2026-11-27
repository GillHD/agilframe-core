/** Docs CMS admin API: list/read/write/upload/versions/restore/reset/default + public overrides. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DocsStore } from '../src/docs-cms.js';
import { loadEnv } from '../src/env.js';
import { startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const MAX = 200 * 1024;
let ts: TestServer;

before(async () => {
  ts = await startTestServer();
});

after(async () => {
  await ts.close();
});

test('configured CMS storage requires a writable directory separate from bundled docs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agil-docs-storage-'));
  const docsDir = path.join(root, 'bundled');
  const file = path.join(root, 'file');
  const alias = path.join(root, 'bundled-alias');
  try {
    mkdirSync(docsDir);
    writeFileSync(file, 'not a directory');
    symlinkSync(docsDir, alias, 'junction');
    const open = (docsDataDir: string) => new DocsStore({ env: loadEnv({ docsDir, docsDataDir, dataDir: root }) });
    for (const invalid of [path.join(root, 'missing'), file]) {
      assert.throws(() => open(invalid), /AGIL_DOCS_DATA_DIR requires an existing writable directory/);
    }
    for (const invalid of [docsDir, alias]) {
      assert.throws(() => open(invalid), /must be separate directories/);
    }
    assert.equal(open('').customDir, path.join(root, 'docs'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Wiki rejects duplicate and reserved anchor IDs before changing the publication or history', async () => {
  const name = 'wiki-setup.md';
  const endpoint = `/v1/admin/docs/${name}`;
  const valid = '# Wiki\n\n## [devices] Devices\n\n```md\n## [devices] Example\n```\n\n### [microphone] Microphone';
  const published = await ts.api('PUT', endpoint, { headers: ADMIN, body: { content: valid } });
  assert.equal(published.status, 200);
  const history = await ts.api('GET', `${endpoint}/versions`, { headers: ADMIN });
  for (const content of [valid + '\n\n## [microphone] A duplicate', '# Wiki\n\n## [main] Reserved']) {
    const response = await ts.api('PUT', endpoint, { headers: ADMIN, body: { content, expectedRevision: published.body.revision } });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'wiki_anchor_conflict');
  }
  assert.equal((await publicDoc(name)).text, valid);
  assert.deepEqual((await ts.api('GET', `${endpoint}/versions`, { headers: ADMIN })).body, history.body);
  await ts.api('DELETE', endpoint, { headers: ADMIN });
});

async function publicDoc(name: string): Promise<{ status: number; text: string; type: string | null; source: string | null }> {
  const response = await ts.api('GET', `/docs/${encodeURIComponent(name)}`);
  return {
    status: response.status,
    text: response.text,
    type: response.headers.get('content-type'),
    source: response.headers.get('x-agil-doc-source'),
  };
}

test('Wiki can restore an older archive that predates local link validation', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agil-wiki-reference-archive-'));
  try {
    const store = new DocsStore({ env: loadEnv({ docsDir: path.join(root, 'bundled'), docsDataDir: '', dataDir: root }) });
    const name = 'wiki-setup.md';
    const old = '# Старая редакция\n\n[Удалённый раздел](#former)';
    mkdirSync(store.customDir, { recursive: true });
    writeFileSync(path.join(store.customDir, name), old);
    const current = store.write(name, '# Исправленная редакция');
    const archived = store.versions(name).find((version) => !version.isCurrent);
    assert.ok(archived);
    assert.equal(store.restore(name, archived.id, current.revision).content, old);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('platform publication and version history are separated from tenant administration', async () => {
  const server = await startTestServer({ platformKey: 'qa-platform-docs' });
  const document = '/v1/admin/docs/platform-guide.md';
  const body = { content: '# Platform guide' };
  try {
    const list = await server.api('GET', '/v1/admin/docs', { headers: ADMIN });
    assert.equal(list.body.editable, false);
    const tenantWrite = await server.api('PUT', document, { headers: ADMIN, body });
    assert.equal(tenantWrite.status, 403);
    const platform = { 'x-api-key': 'qa-platform-docs' };
    assert.equal((await server.api('PUT', document, { headers: platform, body })).status, 200);
    assert.equal((await server.api('GET', document + '/versions', { headers: ADMIN })).status, 403);
    assert.equal((await server.api('GET', document + '/versions', { headers: platform })).status, 200);
    assert.match((await server.api('GET', '/docs/platform-guide.md')).text, /Platform guide/);
  } finally {
    await server.close();
  }
});

test('docs list/read: bundled docs, default document, auth', async () => {
  assert.equal((await ts.api('GET', '/v1/admin/docs')).status, 401);
  assert.equal((await ts.api('GET', '/v1/admin/docs/api-guide.md')).status, 401);

  const list = await ts.api('GET', '/v1/admin/docs', { headers: ADMIN });
  assert.equal(list.status, 200);
  assert.equal(list.body.editable, true);
  assert.equal(list.body.defaultName, 'api-guide.md');
  assert.ok(Array.isArray(list.body.docs) && list.body.docs.length > 0);
  const guide = list.body.docs.find((doc: { name: string }) => doc.name === 'api-guide.md');
  assert.ok(guide);
  assert.equal(guide.bundled, true);
  assert.equal(guide.custom, false);
  assert.equal(guide.isDefault, true);
  assert.ok(guide.title.length > 0);
  assert.ok(guide.sizeBytes > 0);
  assert.equal(typeof guide.updatedAt, 'number');
  assert.ok(!JSON.stringify(list.body).includes('.history'), 'internal files are not listed');

  const read = await ts.api('GET', '/v1/admin/docs/api-guide.md', { headers: ADMIN });
  assert.equal(read.status, 200);
  assert.equal(read.body.name, 'api-guide.md');
  assert.ok(read.body.content.includes('# AgilFrame API'));
  assert.equal(read.body.bundled, true);
  assert.equal(read.body.custom, false);
  assert.equal(read.body.isDefault, true);

  assert.equal((await ts.api('GET', '/v1/admin/docs/nope.md', { headers: ADMIN })).status, 404);
});

test('write custom override, public /docs serves it, versions + restore + audit', async () => {
  const first = await ts.api('PUT', '/v1/admin/docs/api-guide.md', {
    headers: ADMIN,
    body: { content: '# Custom API guide\n\nEdited by QA.', title: 'Custom API guide' },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.custom, true);
  assert.equal(first.body.bundled, true);
  assert.equal(first.body.title, 'Custom API guide');
  assert.ok(first.body.content.includes('Edited by QA'));

  const publicCustom = await publicDoc('api-guide.md');
  assert.equal(publicCustom.source, 'published');
  assert.equal(publicCustom.status, 200);
  assert.ok(publicCustom.text.includes('Edited by QA'), 'public /docs/:file serves the custom copy');
  assert.ok(publicCustom.type?.includes('text/markdown'));

  const list = await ts.api('GET', '/v1/admin/docs', { headers: ADMIN });
  const entry = list.body.docs.find((doc: { name: string }) => doc.name === 'api-guide.md');
  assert.equal(entry.custom, true);
  assert.ok(entry.versions >= 1, 'previous bundled content archived');

  const second = await ts.api('PUT', '/v1/admin/docs/api-guide.md', {
    headers: ADMIN,
    body: { content: '# Custom API guide v2\n\nSecond edit.' },
  });
  assert.equal(second.status, 200);

  const history = await ts.api('GET', '/v1/admin/docs/api-guide.md/versions', { headers: ADMIN });
  assert.equal(history.status, 200);
  assert.ok(history.body.versions.length >= 2);
  assert.equal(history.body.versions[0].isCurrent, true);
  assert.equal(history.body.versions[0].author, 'admin');
  const older = history.body.versions[history.body.versions.length - 1];
  const olderContent = await ts.api('GET', `/v1/admin/docs/api-guide.md/versions/${older.id}`, { headers: ADMIN });
  assert.equal(olderContent.status, 200);
  assert.equal(typeof olderContent.body.content, 'string');

  const restorePath = `/v1/admin/docs/api-guide.md/versions/${older.id}/restore`;
  const conflict = await ts.api('POST', restorePath, { headers: ADMIN, body: { expectedRevision: first.body.revision } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'document_conflict');
  assert.equal((await publicDoc('api-guide.md')).text, second.body.content);
  const restored = await ts.api('POST', restorePath, { headers: ADMIN, body: { expectedRevision: second.body.revision } });
  assert.equal(restored.status, 200);
  const afterRestore = await ts.api('GET', '/v1/admin/docs/api-guide.md', { headers: ADMIN });
  assert.equal(afterRestore.body.content, olderContent.body.content);

  const versionsAfter = await ts.api('GET', '/v1/admin/docs/api-guide.md/versions', { headers: ADMIN });
  assert.ok(versionsAfter.body.versions.length >= 3);
  assert.equal(versionsAfter.body.versions[1].note, `restore:${older.id}`);
  assert.equal((await ts.api('GET', '/v1/admin/docs/api-guide.md/versions/not-a-version', { headers: ADMIN })).status, 400);
  assert.equal((await ts.api('GET', '/v1/admin/docs/api-guide.md/versions/1700000000000-deadbeef', { headers: ADMIN })).status, 404);

  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  const kinds = audit.body.entries
    .map((entry: { details?: { kind?: string } }) => entry.details?.kind)
    .filter(Boolean);
  assert.ok(kinds.includes('docs.updated'));
  assert.ok(kinds.includes('docs.restored'));
  assert.ok(!JSON.stringify(audit.body).includes('Edited by QA'), 'audit never stores content');
});

test('uploaded text appears in the list and the first edit leaves a restorable version', async () => {
  const base = '/v1/admin/docs/versioned-upload.txt';
  await ts.api('PUT', base, { headers: ADMIN, body: { content: '# Initial version' } });
  const list = await ts.api('GET', '/v1/admin/docs', { headers: ADMIN });
  assert.ok(list.body.docs.some((doc: { name: string }) => doc.name === 'versioned-upload.txt'));
  const { body: history } = await ts.api('GET', `${base}/versions`, { headers: ADMIN });
  assert.equal(history.versions.length, 1);
  const current = await ts.api('GET', `${base}/versions/${history.versions[0].id}`, { headers: ADMIN });
  assert.equal(current.body.content, '# Initial version');

  await ts.api('PUT', base, { headers: ADMIN, body: { content: '# Second version' } });
  const { body: updated } = await ts.api('GET', `${base}/versions`, { headers: ADMIN });
  assert.deepEqual(updated.versions.map((version: { isCurrent: boolean }) => version.isCurrent), [true, false]);
  const restore = await ts.api('POST', `${base}/versions/${updated.versions[1].id}/restore`, { headers: ADMIN });
  assert.equal(restore.status, 200);
  assert.equal(restore.body.content, '# Initial version');
});

test('upload raw + JSON, traversal-safe names, no directory listing', async () => {
  const raw = await ts.api('POST', '/v1/admin/docs/upload', {
    headers: { ...ADMIN, 'x-file-name': 'uploaded-doc.md', 'content-type': 'text/markdown' },
    rawBody: '# Uploaded doc\n\nFrom raw upload.',
  });
  assert.equal(raw.status, 200, JSON.stringify(raw.body));
  assert.equal(raw.body.name, 'uploaded-doc.md');
  assert.equal(raw.body.custom, true);
  assert.equal(raw.body.bundled, false);
  assert.ok((await publicDoc('uploaded-doc.md')).text.includes('From raw upload'));

  const jsonUpload = await ts.api('POST', '/v1/admin/docs/upload', {
    headers: ADMIN,
    body: { name: 'json-doc.md', content: '# JSON doc\n\nUploaded as JSON.', title: 'JSON doc', expectedRevision: null },
  });
  assert.equal(jsonUpload.status, 200);
  assert.equal(jsonUpload.body.name, 'json-doc.md');
  const collision = await ts.api('POST', '/v1/admin/docs/upload', {
    headers: ADMIN,
    body: { name: 'json-doc.md', content: '# Another document', expectedRevision: null },
  });
  assert.equal(collision.status, 409);
  assert.equal(collision.body.error.code, 'document_conflict');
  assert.equal((await publicDoc('json-doc.md')).text, jsonUpload.body.content);
  const update = await ts.api('POST', '/v1/admin/docs/upload', {
    headers: ADMIN,
    body: { name: 'json-doc.md', content: '# Reviewed replacement', expectedRevision: jsonUpload.body.revision },
  });
  assert.equal(update.status, 200);
  const staleUpdate = await ts.api('PUT', '/v1/admin/docs/json-doc.md', {
    headers: ADMIN, body: { content: '# Stale replacement', expectedRevision: jsonUpload.body.revision },
  });
  assert.equal(staleUpdate.status, 409);
  assert.equal((await publicDoc('json-doc.md')).text, update.body.content);

  // Path traversal in the upload file name is sanitised to a basename.
  const traversal = await ts.api('POST', '/v1/admin/docs/upload', {
    headers: { ...ADMIN, 'x-file-name': '../../evil.md', 'content-type': 'text/markdown' },
    rawBody: '# Evil\n\npath traversal attempt',
  });
  assert.equal(traversal.status, 200);
  assert.equal(traversal.body.name, 'evil.md');
  const outside = await publicDoc('../evil.md');
  assert.equal(outside.status, 404);

  // Invalid document names are rejected by the strict regex.
  const badName = await ts.api('PUT', '/v1/admin/docs/bad%20name.md', { headers: ADMIN, body: { content: '# x' } });
  assert.equal(badName.status, 400);
  assert.equal((await ts.api('PUT', '/v1/admin/docs/.hidden.md', { headers: ADMIN, body: { content: '# x' } })).status, 400);

  // No directory listing / internal history exposure over the public route.
  assert.equal((await ts.api('GET', '/docs/.history')).status, 404);
  const docsDirPath = await ts.api('GET', '/docs/');
  assert.ok([200, 404].includes(docsDirPath.status));
  assert.ok(!docsDirPath.text.includes('.history'));
  assert.ok(!docsDirPath.text.includes('.default.json'));

  const list = await ts.api('GET', '/v1/admin/docs', { headers: ADMIN });
  assert.ok(list.body.docs.some((doc: { name: string; custom: boolean }) => doc.name === 'uploaded-doc.md' && doc.custom));
});

test('size limits and reset/default behaviour', async () => {
  const tooBig = await ts.api('PUT', '/v1/admin/docs/api-guide.md', {
    headers: ADMIN,
    body: { content: `# Big\n\n${'x'.repeat(MAX)}` },
  });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.error.code, 'payload_too_large');

  const bigUpload = await ts.api('POST', '/v1/admin/docs/upload', {
    headers: { ...ADMIN, 'x-file-name': 'big.md', 'content-type': 'text/markdown' },
    rawBody: 'x'.repeat(MAX + 1),
  });
  assert.equal(bigUpload.status, 413);

  const defaultChanged = await ts.api('PUT', '/v1/admin/docs/default', { headers: ADMIN, body: { name: 'api.md' } });
  assert.equal(defaultChanged.status, 200);
  assert.equal(defaultChanged.body.defaultName, 'api.md');
  const defaulted = await ts.api('GET', '/v1/admin/docs/api.md', { headers: ADMIN });
  assert.equal(defaulted.body.isDefault, true);
  assert.equal((await ts.api('GET', '/v1/admin/docs', { headers: ADMIN })).body.defaultName, 'api.md');
  assert.equal((await ts.api('PUT', '/v1/admin/docs/default', { headers: ADMIN, body: { name: 'missing.md' } })).status, 404);

  // Reset a bundled override → bundled content is back.
  const reset = await ts.api('DELETE', '/v1/admin/docs/api-guide.md', { headers: ADMIN });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.reset, true);
  assert.equal(reset.body.bundled, true);
  const read = await ts.api('GET', '/v1/admin/docs/api-guide.md', { headers: ADMIN });
  assert.equal(read.body.custom, false);
  const publicBundled = await publicDoc('api-guide.md');
  assert.equal(publicBundled.source, 'bundled');
  assert.ok(publicBundled.text.includes('# AgilFrame API'));
  assert.ok(!publicBundled.text.includes('Edited by QA'));

  // Uploaded-only doc: reset deletes it, then it is gone.
  assert.equal((await ts.api('DELETE', '/v1/admin/docs/uploaded-doc.md', { headers: ADMIN })).status, 200);
  assert.equal((await ts.api('GET', '/v1/admin/docs/uploaded-doc.md', { headers: ADMIN })).status, 404);
  assert.equal((await ts.api('DELETE', '/v1/admin/docs/never-existed.md', { headers: ADMIN })).status, 404);

  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  const kinds = audit.body.entries
    .map((entry: { details?: { kind?: string } }) => entry.details?.kind)
    .filter(Boolean);
  assert.ok(kinds.includes('docs.reset'));
  assert.ok(kinds.includes('docs.default.changed'));
});

test('a stale editor cannot replace a newer publication and reset preserves the publication', async () => {
  const path = '/v1/admin/docs/api-guide.md';
  const opened = await ts.api('GET', path, { headers: ADMIN });
  const previousRevision = opened.body.revision;
  assert.match(previousRevision, /^[0-9a-f]{64}$/);
  const latest = { content: '# First tab publication', expectedRevision: previousRevision };
  const saved = await ts.api('PUT', path, { headers: ADMIN, body: latest });
  assert.equal(saved.status, 200);
  assert.notEqual(saved.body.revision, previousRevision);
  const stale = await ts.api('PUT', path, { headers: ADMIN, body: { content: '# Stale draft', expectedRevision: previousRevision } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'document_conflict');
  assert.equal((await publicDoc('api-guide.md')).text, latest.content);

  const beforeReset = await ts.api('GET', path + '/versions', { headers: ADMIN });
  const rejectedReset = await ts.api('DELETE', path, { headers: ADMIN, body: { expectedRevision: previousRevision } });
  assert.equal(rejectedReset.status, 409);
  assert.equal(rejectedReset.body.error.code, 'document_conflict');
  assert.equal((await publicDoc('api-guide.md')).text, latest.content);
  assert.deepEqual((await ts.api('GET', path + '/versions', { headers: ADMIN })).body, beforeReset.body);
  assert.equal((await ts.api('DELETE', path, { headers: ADMIN, body: { expectedRevision: saved.body.revision } })).status, 200);
  const history = await ts.api('GET', path + '/versions', { headers: ADMIN });
  const reset = history.body.versions.find((version: { note?: string }) => version.note === 'reset');
  assert.ok(reset);
  const restored = await ts.api('POST', path + '/versions/' + reset.id + '/restore', { headers: ADMIN });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.content, latest.content);
  assert.equal((await ts.api('DELETE', path, { headers: ADMIN })).status, 200);
});

test('the version list preserves archived document metadata after copying the archive', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agil-docs-history-'));
  try {
    const store = new DocsStore({ env: loadEnv({ docsDir: path.join(root, 'bundled'), docsDataDir: '', dataDir: root }) });
    const name = 'archive-metadata.md';
    const content = '# Версия\n\nТекст с Unicode и "кавычками".';
    store.write(name, content);
    store.write(name, '# Замена', undefined, 'upload');
    const archived = store.versions(name).find((version) => !version.isCurrent);
    assert.ok(archived);
    const folder = path.join(store.customDir, '.history', name);
    const copiedAt = new Date('2030-10-01T00:00:00Z');
    utimesSync(path.join(folder, `${archived.id}.json`), copiedAt, copiedAt);
    writeFileSync(path.join(folder, '1900000000000-invalid0.json'), 'null');
    const list = store.versions(name);
    assert.equal(list.length, 2);
    assert.deepEqual(list[1], archived);
    assert.deepEqual(store.versionContent(name, archived.id), { version: archived, content });
    assert.equal(archived.sizeBytes, Buffer.byteLength(content));
    assert.notEqual(archived.createdAt, copiedAt.getTime());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /docs explorer lists documents and the selected default', async () => {
  const explorer = await ts.api('GET', '/docs');
  assert.equal(explorer.status, 200);
  assert.ok(explorer.text.includes('Публичные документы'));
  assert.ok(explorer.text.includes('api-guide.md'));
  assert.ok(explorer.text.includes('основной:'));
  assert.ok(!explorer.text.includes('.history'));
  assert.ok(!explorer.text.includes('.default.json'));
});
