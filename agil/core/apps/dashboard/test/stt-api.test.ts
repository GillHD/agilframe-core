/**
 * Dashboard STT status contract (P3-5).
 *
 * The settings screen calls `GET /v1/admin/stt`; this test pins the URL, the
 * admin key header and the typed shape the status card renders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// `api.ts` uses window.setTimeout/clearTimeout; Node has the timers but not `window`.
(globalThis as unknown as { window: unknown }).window = {
  setTimeout,
  clearTimeout,
  dispatchEvent: () => true,
};

const { AdminApi } = await import('../src/api.js');

test('sttStatus reads /v1/admin/stt with the tenant admin key', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const api = new AdminApi({
    baseUrl: 'https://app.example',
    apiKey: 'tenant-key',
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({
          privacyMode: 'standard',
          stt: {
            provider: 'local',
            configured: true,
            local: true,
            engine: 'whisper-cpp:ggml-small.bin',
            available: true,
            model: 'ggml-small.bin',
            ffmpeg: true,
            localFilesOnly: true,
          },
          translation: {
            provider: 'local',
            configured: true,
            available: true,
            engine: 'opus-mt:translate',
            model: 'translate',
            localFilesOnly: true,
            nonCommercial: false,
          },
          consent: { required: true, retentionSec: 3600 },
          caveats: ['Model files are not bundled; download them with scripts/local/download-models.mjs.'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  });

  const status = await api.sttStatus();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://app.example/v1/admin/stt');
  assert.equal((calls[0]?.init.method ?? 'GET'), 'GET');
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'tenant-key');
  assert.equal(status.stt.configured, true);
  assert.equal(status.stt.code, undefined);
  assert.equal(status.translation.engine, 'opus-mt:translate');
  assert.equal(status.consent.retentionSec, 3600);
  assert.equal(status.caveats.length, 1);
});
