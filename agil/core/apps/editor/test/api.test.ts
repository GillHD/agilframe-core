/**
 * Editor → tenant-config payload contract.
 *
 * `PATCH /v1/tenants/:id/config` bypasses the custom-domain ownership checks
 * (no TXT token, no 409), so the editor must never send `branding.customDomain`
 * — even when it was loaded from the server or pasted through the JSON import.
 * Domain management belongs to `PUT/POST/DELETE /v1/admin/domain`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '@agil/protocol';
import {
  buildEmbedSnippet,
  buildTenantPayload,
  defaultServerUrl,
  loadServerSettings,
  saveTenantConfig,
  type ServerSettings,
} from '../src/api.js';

test('save payload never carries branding.customDomain', () => {
  const config = defaultConfig({ tenantId: 'demo' });
  config.branding.productName = 'ACME Meet';
  config.branding.organizationName = 'ACME LLC';
  config.branding.customDomain = 'evil.example.net';

  const payload = buildTenantPayload(config, 'acme');
  assert.equal(payload.tenantId, 'acme');

  const branding = payload.branding as Record<string, unknown>;
  assert.equal('customDomain' in branding, false, 'customDomain must be stripped from the PATCH body');
  assert.equal(branding.productName, 'ACME Meet');
  assert.equal(branding.organizationName, 'ACME LLC');
  // The caller's config object is not mutated (other sections keep working).
  assert.equal(config.branding.customDomain, 'evil.example.net');

  // The payload is JSON-serialisable and keeps the rest of the config intact.
  const roundTrip = JSON.parse(JSON.stringify(payload)) as Record<string, any>;
  assert.equal(roundTrip.tenantId, 'acme');
  assert.equal(roundTrip.branding.customDomain, undefined);
  assert.equal(roundTrip.theme.colors.primary, config.theme.colors.primary);
});

test('a domain-looking value in the raw config never reaches the PATCH body', () => {
  // JSON import / hand-edited config can contain a URL instead of a bare host.
  // Whatever the shape, the editor must not forward it to the config endpoint.
  const config = defaultConfig({ tenantId: 'demo' });
  config.branding.customDomain = 'https://legacy.example.com/path';
  const branding = buildTenantPayload(config, 'demo').branding as Record<string, unknown>;
  assert.equal(branding.customDomain, undefined);
});

/* ------------------------------------------------------------------ */
/* Same-origin default (QA P1)                                         */
/* ------------------------------------------------------------------ */

const PROD_HOST = 'calls.mock.test';
const PROD_ORIGIN = `https://${PROD_HOST}`;

function fakeWindow(location: { hostname: string; origin: string }, stored: Record<string, string> = {}) {
  const values = new Map(Object.entries(stored));
  return {
    location,
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
}

async function withFakeWindow<T>(
  location: { hostname: string; origin: string },
  stored: Record<string, string>,
  run: () => Promise<T> | T,
): Promise<T> {
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = fakeWindow(location, stored);
  try {
    return await run();
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
}

test('production default server URL is the current origin, never localhost', () => {
  assert.equal(defaultServerUrl({ hostname: PROD_HOST, origin: PROD_ORIGIN }), PROD_ORIGIN);
  assert.equal(defaultServerUrl({ hostname: 'localhost', origin: 'http://localhost:5174' }), 'http://localhost:8787');
  assert.equal(defaultServerUrl(null), 'http://localhost:8787');
});

test('a stale localhost URL is ignored on production and the origin is used', async () => {
  await withFakeWindow(
    { hostname: PROD_HOST, origin: PROD_ORIGIN },
    { 'agil.editor.serverUrl': 'http://localhost:8787' },
    () => {
      const settings = loadServerSettings('demo');
      assert.equal(settings.serverUrl, PROD_ORIGIN);
    },
  );
});

test('embed snippet uses the same origin and never localhost', async () => {
  await withFakeWindow({ hostname: PROD_HOST, origin: PROD_ORIGIN }, {}, () => {
    const settings: ServerSettings = { serverUrl: PROD_ORIGIN, tenantId: 'demo', apiKey: 'k' };
    const snippet = buildEmbedSnippet(settings, 'dark');
    assert.match(snippet, new RegExp(`<script src="${PROD_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/sdk/agilframe.js">`));
    assert.doesNotMatch(snippet, /localhost:8787/);
  });
});

test('save publishes the complete draft to the same-origin tenant-config endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const baseEtag = 'a'.repeat(64);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body), ['editorDraft', 'baseEtag']);
    assert.equal(body.baseEtag, baseEtag);
    assert.deepEqual(body.editorDraft.security.accessPolicy.userOverrides, {});
    assert.equal(body.editorDraft.branding.customDomain, undefined);
    return new Response(JSON.stringify({ etag: '"mock-etag"', editorDraftPublished: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await withFakeWindow({ hostname: PROD_HOST, origin: PROD_ORIGIN }, {}, async () => {
      const settings = loadServerSettings('demo');
      assert.equal(settings.serverUrl, PROD_ORIGIN);
      const result = await saveTenantConfig(defaultConfig({ tenantId: 'demo' }), settings, baseEtag);
      assert.equal(result.ok, true);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [`${PROD_ORIGIN}/v1/tenants/demo/config`]);
});

test('a legacy merge response cannot report a successful draft publication', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ etag: 'unchanged' });
  try {
    await withFakeWindow({ hostname: PROD_HOST, origin: PROD_ORIGIN }, {}, async () => {
      const result = await saveTenantConfig(defaultConfig(), loadServerSettings('demo'), 'a'.repeat(64));
      assert.equal(result.ok, false);
      assert.match(result.message, /Обновите Core/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
