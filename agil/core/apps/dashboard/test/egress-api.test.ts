/**
 * Dashboard egress contract tests (P1-1/P1-2).
 *
 * The dashboard used to POST to a non-existent `/egress/stop` route and read
 * `sessions`/`active` while the server returns `{ roomId, egress: EgressInfo[] }`.
 * These tests mock `fetch` and assert the exact request URL/method/body and the
 * normalization of raw LiveKit proto-JSON (`egress_id`, `EGRESS_*`,
 * `started_at` in ns, `*_results`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// `api.ts` uses window.setTimeout/clearTimeout; Node has the timers but not `window`.
(globalThis as unknown as { window: unknown }).window = {
  setTimeout,
  clearTimeout,
  dispatchEvent: () => true,
};

const { AdminApi, ApiError, normalizeEgressStatus } = await import('../src/api.js');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('startEgress forwards the caller idempotency key for the same start attempt', async () => {
  const keys: (string | null)[] = [];
  const api = new AdminApi({ baseUrl: 'https://app.example', apiKey: 'dev-key', fetchImpl: async (url, request) => {
    assert.equal(url, 'https://app.example/v1/rooms/room%2F1/egress/start');
    assert.equal(request?.method, 'POST');
    keys.push(new Headers(request?.headers).get('idempotency-key'));
    return jsonResponse({ egressId: 'EG_recording' });
  } });
  await api.startEgress('room/1', { kind: 'recording' }, 'same-intent');
  await api.startEgress('room/1', { kind: 'recording' }, 'same-intent');
  await api.startEgress('room/1', { kind: 'recording' }, 'separate-intent');
  assert.deepEqual(keys, ['same-intent', 'same-intent', 'separate-intent']);
});

test('normalizeEgressStatus maps raw LiveKit EgressInfo (P1-2)', () => {
  const status = normalizeEgressStatus({
    roomId: 'room-1',
    egress: [
      {
        egress_id: 'EG_rtmp',
        status: 'EGRESS_ACTIVE',
        started_at: '1700000000123456789',
        stream_results: [{ url: 'rtmp://live.example/app/***' }],
        request: { stream_outputs: [{ protocol: 'RTMP', urls: ['rtmp://live.example/app/***'] }] },
      },
      {
        egress_id: 'EG_hls',
        status: 1,
        started_at: '1700000000000000000',
        segment_results: [{ playlist_location: 'https://cdn.example/index.m3u8', live_playlist_location: 'https://cdn.example/live.m3u8' }],
      },
      {
        egress_id: 'EG_rec',
        status: 'EGRESS_COMPLETE',
        file_results: [{ location: 's3://bucket/tenant/room/file.mp4' }],
      },
      // No egress id: cannot be stopped, so it must not render as a stop-able card.
      { status: 'EGRESS_ACTIVE' },
    ],
  });

  assert.equal(status.sessions.length, 3);
  assert.equal(status.startRestrictions, undefined, 'the old Core response remains usable');
  assert.deepEqual(status.sessions[0], {
    id: 'EG_rtmp',
    kind: 'rtmp',
    status: 'EGRESS_ACTIVE',
    url: 'rtmp://live.example/app/***',
    startedAt: 1_700_000_000_123,
  });
  assert.deepEqual(status.sessions[1], {
    id: 'EG_hls',
    kind: 'hls',
    status: 'EGRESS_ACTIVE',
    url: 'https://cdn.example/index.m3u8',
    startedAt: 1_700_000_000_000,
  });
  assert.deepEqual(status.sessions[2], {
    id: 'EG_rec',
    kind: 'recording',
    status: 'EGRESS_COMPLETE',
    url: 's3://bucket/tenant/room/file.mp4',
  });
});

test('normalizeEgressStatus keeps legacy/alternate list shapes and flags', () => {
  const legacy = normalizeEgressStatus({ configured: true, sessions: [{ egressId: 'legacy-1', id: 'ignored', status: 'active' }] });
  assert.equal(legacy.configured, true);
  assert.equal(legacy.sessions.length, 1);
  assert.equal(legacy.sessions[0]?.id, 'legacy-1');

  const active = normalizeEgressStatus({ active: [{ id: 'active-1', status: 'EGRESS_ACTIVE' }], enabled: false });
  assert.equal(active.enabled, false);
  assert.equal(active.sessions[0]?.id, 'active-1');

  assert.deepEqual(normalizeEgressStatus({ egress: [] }).sessions, []);
  assert.deepEqual(normalizeEgressStatus(null).sessions, []);
});

test('stopEgress uses the server path route, no body, encoded id (P1-1)', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const api = new AdminApi({
    baseUrl: 'https://app.example',
    apiKey: 'tenant-key',
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ egressId: 'EG/1', status: 'stopped' });
    }) as typeof fetch,
  });

  await api.stopEgress('room 1', 'EG/1');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://app.example/v1/rooms/room%201/egress/EG%2F1/stop');
  assert.equal(calls[0]?.init.method, 'POST');
  assert.equal(calls[0]?.init.body, undefined);
  assert.deepEqual(calls[0]?.init.headers, { accept: 'application/json', 'x-api-key': 'tenant-key' });
  await assert.rejects(
    () => api.stopEgress('room 1', '   '),
    (error: unknown) => error instanceof ApiError && error.code === 'validation_failed',
  );
});

test('egress() fetches the room list and normalizes the server shape', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const api = new AdminApi({
    baseUrl: 'https://app.example/',
    apiKey: 'tenant-key',
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({
        roomId: 'room/1',
        egress: [{ egress_id: 'EG_list', status: 'EGRESS_ACTIVE', started_at: '1700000000000000000' }],
      });
    }) as typeof fetch,
  });

  const status = await api.egress('room/1');

  assert.equal(calls[0]?.url, 'https://app.example/v1/rooms/room%2F1/egress');
  assert.equal(calls[0]?.init.method, 'GET');
  assert.equal(status.sessions[0]?.id, 'EG_list');
  assert.equal(status.sessions[0]?.status, 'EGRESS_ACTIVE');
});

test('egressPlayback mints a signed link on the encoded playback route (TTL optional)', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const api = new AdminApi({
    baseUrl: 'https://app.example',
    apiKey: 'tenant-key',
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({
        egressId: 'EG/1',
        kind: 'hls',
        url: 'https://app.example/v1/rooms/room%2F1/egress/EG%2F1/playlist?token=abc.def',
        expiresAt: 1_700_000_000_000,
        ttlSec: 3600,
      });
    }) as typeof fetch,
  });

  const link = await api.egressPlayback('room/1', 'EG/1', 3600);
  assert.equal(calls[0]?.url, 'https://app.example/v1/rooms/room%2F1/egress/EG%2F1/playback');
  assert.equal(calls[0]?.init.method, 'POST');
  assert.equal(calls[0]?.init.body, JSON.stringify({ ttlSec: 3600 }));
  assert.deepEqual(calls[0]?.init.headers, {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-api-key': 'tenant-key',
  });
  assert.equal(link.kind, 'hls');
  assert.match(link.url, /\/playlist\?token=abc\.def$/, 'capability URL is passed through untouched');
  assert.equal(link.expiresAt, 1_700_000_000_000);

  // Without a TTL the body is `{}` (the server applies its default).
  await api.egressPlayback('room-1', 'EG_1');
  assert.equal(calls[1]?.init.body, '{}');

  // A blank egress id is rejected client-side, without a network call.
  await assert.rejects(
    () => api.egressPlayback('room-1', '   '),
    (error: unknown) => error instanceof ApiError && error.code === 'validation_failed',
  );
  assert.equal(calls.length, 2);
});

test('egressWorkersHealth reads the admin worker probe and keeps reachability detail', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const api = new AdminApi({
    baseUrl: 'https://app.example',
    apiKey: 'tenant-key',
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({
        configured: true,
        enabled: true,
        urlConfigured: true,
        activeCount: 2,
        lastError: null,
        worker: { urlConfigured: true, reachable: true, status: 'ok', cpuLoad: 1.25 },
        checkedAt: 1_700_000_000_000,
      });
    }) as typeof fetch,
  });

  const health = await api.egressWorkersHealth();
  assert.equal(calls[0]?.url, 'https://app.example/v1/admin/egress/workers');
  assert.equal(calls[0]?.init.method, 'GET');
  assert.deepEqual(calls[0]?.init.headers, { accept: 'application/json', 'x-api-key': 'tenant-key' });
  assert.equal(health.worker?.reachable, true);
  assert.equal(health.worker?.cpuLoad, 1.25);
  assert.equal(health.activeCount, 2);
});
