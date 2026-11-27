import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveGeo,
  countryFromHeaders,
  normalizeCountryCode,
  clearGeoCache,
  assertCountryAllowed,
} from '../src/geo.js';
import { SecurityError } from '../src/errors.js';

const originalFetch = globalThis.fetch;

interface FetchCall {
  url: string;
}

/** Replaces globalThis.fetch; returns restore() and the call log. */
function mockFetch(handler: (url: string) => Promise<unknown> | unknown): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url });
    return handler(url);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

beforeEach(() => clearGeoCache());

test('provider=header: валидный код -> country/source header, vpn=false', async () => {
  const geo = await resolveGeo('203.0.113.7', { provider: 'header', headerCountry: 'ru' });
  assert.deepEqual(geo, { country: 'RU', vpn: false, source: 'header' });
});

test('provider=header: невалидный/отсутствующий код -> source none', async () => {
  for (const headerCountry of ['', 'XYZ', 'XX', 'R', '1A', undefined]) {
    assert.deepEqual(
      await resolveGeo('203.0.113.7', { provider: 'header', headerCountry }),
      { source: 'none', vpn: false },
    );
  }
});

test('provider=none: без сетевых вызовов', async () => {
  const mock = mockFetch(() => {
    throw new Error('fetch must not be called');
  });
  try {
    assert.deepEqual(await resolveGeo('8.8.8.8', { provider: 'none' }), { source: 'none', vpn: false });
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('provider=ipapi: успешный lookup + кэш (повторный вызов без fetch)', async () => {
  const mock = mockFetch(() => jsonResponse({ country_code: 'DE', city: ' Berlin ' }));
  try {
    const first = await resolveGeo('8.8.8.8', { provider: 'ipapi', timeoutMs: 500 });
    assert.deepEqual(first, { country: 'DE', city: 'Berlin', vpn: false, source: 'lookup' });
    assert.equal(mock.calls.length, 1);
    assert.match(mock.calls[0]!.url, /^https:\/\/ipapi\.co\/8\.8\.8\.8\/json\/$/);

    const second = await resolveGeo('8.8.8.8', { provider: 'ipapi', timeoutMs: 500 });
    assert.deepEqual(second, first);
    assert.equal(mock.calls.length, 1, 'второй вызов должен обслуживаться кэшем');
  } finally {
    mock.restore();
  }
});

test('provider=ipapi: cacheTtlMs=0 отключает кэш', async () => {
  const mock = mockFetch(() => jsonResponse({ country_code: 'FR' }));
  try {
    await resolveGeo('8.8.4.4', { provider: 'ipapi', cacheTtlMs: 0 });
    await resolveGeo('8.8.4.4', { provider: 'ipapi', cacheTtlMs: 0 });
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

test('provider=ipapi: vpn определяется по security.vpn / security.proxy / proxy', async () => {
  const variants: Array<[Record<string, unknown>, boolean]> = [
    [{ country_code: 'NL', security: { vpn: true } }, true],
    [{ country_code: 'NL', security: { proxy: true } }, true],
    [{ country_code: 'NL', security: { tor: true } }, true],
    [{ country_code: 'NL', proxy: true }, true],
    [{ country_code: 'NL', security: { vpn: false } }, false],
    [{ country_code: 'NL' }, false],
  ];
  let index = 0;
  const mock = mockFetch(() => jsonResponse(variants[index++]![0]));
  try {
    for (const [, expectedVpn] of variants) {
      const geo = await resolveGeo(`198.51.100.${index + 1}`, { provider: 'ipapi', cacheTtlMs: 0 });
      assert.equal(geo.vpn, expectedVpn);
      assert.equal(geo.source, 'lookup');
    }
  } finally {
    mock.restore();
  }
});

test('provider=ipapi: любая ошибка -> source none, без исключения', async () => {
  const failing = mockFetch(() => {
    throw new Error('network down');
  });
  try {
    assert.deepEqual(await resolveGeo('8.8.8.8', { provider: 'ipapi', cacheTtlMs: 0 }), { source: 'none', vpn: false });
  } finally {
    failing.restore();
  }

  const httpError = mockFetch(() => jsonResponse({ error: true, reason: 'RateLimited' }, 429));
  try {
    assert.deepEqual(await resolveGeo('1.1.1.1', { provider: 'ipapi', cacheTtlMs: 0 }), { source: 'none', vpn: false });
  } finally {
    httpError.restore();
  }

  const bodyError = mockFetch(() => jsonResponse({ error: true, reason: 'Invalid IP' }));
  try {
    assert.deepEqual(await resolveGeo('1.0.0.1', { provider: 'ipapi', cacheTtlMs: 0 }), { source: 'none', vpn: false });
  } finally {
    bodyError.restore();
  }

  const badJson = mockFetch(() => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error('invalid json');
    },
  }) as unknown as Response);
  try {
    assert.deepEqual(await resolveGeo('9.9.9.9', { provider: 'ipapi', cacheTtlMs: 0 }), { source: 'none', vpn: false });
  } finally {
    badJson.restore();
  }
});

test('provider=ipapi: таймаут через AbortController -> source none', async () => {
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as typeof fetch;
  try {
    const started = Date.now();
    const geo = await resolveGeo('8.8.8.8', { provider: 'ipapi', timeoutMs: 25, cacheTtlMs: 0 });
    assert.deepEqual(geo, { source: 'none', vpn: false });
    assert.ok(Date.now() - started < 2000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provider=ipapi: невалидный IP не вызывает fetch', async () => {
  const mock = mockFetch(() => {
    throw new Error('fetch must not be called');
  });
  try {
    for (const ip of ['', 'not-an-ip', '999.1.1.1', '   ']) {
      assert.deepEqual(await resolveGeo(ip, { provider: 'ipapi' }), { source: 'none', vpn: false });
    }
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('countryFromHeaders: приоритет и регистронезависимость', () => {
  assert.equal(countryFromHeaders({ 'cf-ipcountry': 'de' }), 'DE');
  assert.equal(countryFromHeaders({ 'CF-IPCountry': 'RU' }), 'RU');
  assert.equal(countryFromHeaders({ 'x-agil-country': 'kz', 'cf-ipcountry': 'DE' }), 'KZ');
  assert.equal(countryFromHeaders({ 'cf-ipcountry': 'XX', 'x-vercel-ip-country': 'FR' }), 'FR');
  assert.equal(countryFromHeaders({}), undefined);
  assert.equal(countryFromHeaders(undefined), undefined);
});

test('normalizeCountryCode: alpha-2, без заглушек', () => {
  assert.equal(normalizeCountryCode('ru'), 'RU');
  assert.equal(normalizeCountryCode(' KZ '), 'KZ');
  assert.equal(normalizeCountryCode('XX'), undefined);
  assert.equal(normalizeCountryCode('ZZ'), undefined);
  assert.equal(normalizeCountryCode('T1'), undefined);
  assert.equal(normalizeCountryCode('RUS'), undefined);
  assert.equal(normalizeCountryCode(42), undefined);
});

test('assertCountryAllowed: блокировки и allow-list', () => {
  assert.throws(
    () => assertCountryAllowed('RU', { blockedCountries: ['RU'] }),
    (error: unknown) => error instanceof SecurityError && error.code === 'geo_blocked',
  );
  assert.throws(
    () => assertCountryAllowed('RU', { allowedCountries: ['KZ', 'BY'] }),
    (error: unknown) => error instanceof SecurityError && error.code === 'geo_blocked',
  );
  assert.throws(
    () => assertCountryAllowed(undefined, { allowedCountries: ['KZ'] }),
    (error: unknown) => error instanceof SecurityError && error.code === 'geo_blocked',
  );
  assert.doesNotThrow(() => assertCountryAllowed('RU', { allowedCountries: ['RU'] }));
  assert.doesNotThrow(() => assertCountryAllowed('RU', { allowedCountries: [] }));
  assert.doesNotThrow(() => assertCountryAllowed(undefined, {}));
});
