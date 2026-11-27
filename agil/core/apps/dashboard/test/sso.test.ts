/**
 * Dashboard SSO fragment handling (P3-5).
 *
 * The OIDC callback delivers the admin session in `#sso_token=…`; the dashboard
 * must read it once, strip it from the address bar/history immediately, and
 * never trust the URL (length bound, strict error-code regex). These tests use a
 * minimal DOM stub, mirroring the other dashboard API tests — no browser needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

interface FakeWindow {
  location: { origin: string; pathname: string; search: string; hash: string };
  history: { replaced: string[]; replaceState: (data: unknown, title: string, url: string) => void };
  localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  dispatchEvent: () => boolean;
}

function playWindow(options: { hash?: string; pathname?: string; search?: string; historyThrows?: boolean } = {}): FakeWindow {
  const fake = {
    location: {
      origin: 'https://calls.example',
      pathname: options.pathname ?? '/dashboard/',
      search: options.search ?? '',
      hash: options.hash ?? '',
    },
    history: {
      replaced: [] as string[],
      replaceState(data: unknown, _title: string, url: string): void {
        void data;
        if (options.historyThrows) throw new Error('history unavailable');
        fake.history.replaced.push(url);
        cleanFakeUrl(fake, url);
      },
    },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    setTimeout,
    clearTimeout,
    dispatchEvent: () => true,
  };
  (globalThis as unknown as { window: FakeWindow }).window = fake;
  return fake;
}

/** Mirrors `history.replaceState` for the fake location (only the hash matters). */
function cleanFakeUrl(fake: FakeWindow, url: string): void {
  const hashIndex = url.indexOf('#');
  fake.location.hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
}

// `sso.ts` imports `api.ts`, which needs `window` timers at module scope only;
// install a stub before the dynamic import (same pattern as egress-api.test.ts).
playWindow();
const { consumeSsoFragment, isSafeAuthorizationUrl, readSsoFragment, requestLogoutUrl, ssoErrorInfo, ssoReturnTo } = await import(
  '../src/sso.js'
);

test('valid #sso_token is read once and stripped from the address bar', () => {
  const fake = playWindow({ hash: '#sso_token=header.payload.signature' });
  assert.equal(readSsoFragment()?.token, 'header.payload.signature');
  const fragment = consumeSsoFragment();
  assert.equal(fragment?.token, 'header.payload.signature');
  assert.deepEqual(fake.history.replaced, ['/dashboard/#/overview']);
  assert.equal(fake.location.hash, '#/overview', 'token no longer in the URL');
});

test('valid #sso_error is read and stripped; unknown codes fall back safely', () => {
  const fake = playWindow({ hash: '#sso_error=state_invalid' });
  assert.equal(readSsoFragment()?.error, 'state_invalid');
  assert.equal(consumeSsoFragment()?.error, 'state_invalid');
  assert.deepEqual(fake.history.replaced, ['/dashboard/#/overview']);
  assert.equal(ssoErrorInfo('state_invalid').title, 'Ссылка входа недействительна');
  assert.equal(ssoErrorInfo('some_unknown_code').title, 'Вход через SSO не выполнен');
  assert.equal(ssoErrorInfo('<script>').title, 'Провайдер входа недоступен');
});

test('oversized SSO fragments are rejected AND removed from the address bar', () => {
  const fake = playWindow({ hash: `#sso_token=${'a'.repeat(16_385)}` });
  assert.equal(readSsoFragment(), null, 'oversized token is never parsed');
  assert.equal(consumeSsoFragment(), null);
  assert.deepEqual(fake.history.replaced, ['/dashboard/#/overview'], 'dirty fragment is still stripped');
  assert.equal(fake.location.hash, '#/overview');
});

test('malformed #sso_* fragments are stripped; ordinary router hashes are untouched', () => {
  const malformed = playWindow({ hash: '#sso_error=<script>alert(1)</script>' });
  assert.equal(readSsoFragment(), null);
  assert.equal(consumeSsoFragment(), null);
  assert.deepEqual(malformed.history.replaced, ['/dashboard/#/overview'], 'non-matching error code is stripped');

  const router = playWindow({ hash: '#/rooms' });
  assert.equal(readSsoFragment(), null);
  assert.equal(consumeSsoFragment(), null);
  assert.deepEqual(router.history.replaced, [], 'normal navigation is not rewritten');
  assert.equal(router.location.hash, '#/rooms');
});

test('hash fallback still removes the SSO fragment when history is unavailable', () => {
  const fake = playWindow({ hash: '#sso_token=abc.def.ghi', historyThrows: true });
  assert.equal(consumeSsoFragment()?.token, 'abc.def.ghi');
  assert.equal(fake.location.hash, '#/overview');
});

test('only http(s) authorization URLs are followed', () => {
  assert.equal(isSafeAuthorizationUrl('https://sso.example/authorize?x=1'), true);
  assert.equal(isSafeAuthorizationUrl('http://127.0.0.1:8080/auth'), true);
  assert.equal(isSafeAuthorizationUrl('javascript:alert(1)'), false);
  assert.equal(isSafeAuthorizationUrl('data:text/html,<script>'), false);
  assert.equal(isSafeAuthorizationUrl('/relative/path'), false);
  assert.equal(isSafeAuthorizationUrl(''), false);
  assert.equal(isSafeAuthorizationUrl(null), false);
  assert.equal(isSafeAuthorizationUrl(`https://x.example/${'a'.repeat(5000)}`), false);
});

test('ssoReturnTo is the current dashboard page without a fragment', () => {
  playWindow({ pathname: '/dashboard/login', search: '?tenant=demo', hash: '#sso_token=leak' });
  assert.equal(ssoReturnTo(), 'https://calls.example/dashboard/login');
});

/** Runs `requestLogoutUrl` against a stubbed fetch (no network). */
async function withFetch<T>(implementation: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('requestLogoutUrl returns only a safe IdP logout URL (RP-initiated logout)', async () => {
  playWindow();
  let requested = '';
  const url = await withFetch(
    (async (input: string | URL | Request) => {
      requested = String(input);
      return jsonResponse(200, { logoutUrl: 'https://sso.example/logout?client_id=a&state=b', expiresAt: 1 });
    }) as typeof fetch,
    () => requestLogoutUrl({ serverUrl: 'https://api.example', tenantId: 'demo' }),
  );
  assert.equal(url, 'https://sso.example/logout?client_id=a&state=b');
  assert.ok(requested.includes('/v1/auth/oidc/logout'), `unexpected request URL: ${requested}`);
  assert.ok(requested.includes('tenantId=demo'));
  assert.ok(requested.includes('returnTo='));
});

test('requestLogoutUrl falls back to null when RP logout is not configured or unsafe', async () => {
  playWindow();
  const notConfigured = await withFetch(
    (async () => jsonResponse(501, { error: { code: 'identity_not_configured', message: 'RP logout не настроен' } })) as typeof fetch,
    () => requestLogoutUrl({ serverUrl: 'https://api.example', tenantId: 'demo' }),
  );
  assert.equal(notConfigured, null, '501 keeps the local-only logout');

  const unsafe = await withFetch(
    (async () => jsonResponse(200, { logoutUrl: 'javascript:alert(1)', expiresAt: 1 })) as typeof fetch,
    () => requestLogoutUrl({ serverUrl: 'https://api.example', tenantId: 'demo' }),
  );
  assert.equal(unsafe, null, 'non-http(s) logout URL is never followed');

  const offline = await withFetch(
    (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch,
    () => requestLogoutUrl({ serverUrl: 'https://api.example', tenantId: 'demo' }),
  );
  assert.equal(offline, null, 'offline server never blocks the local logout');
});
