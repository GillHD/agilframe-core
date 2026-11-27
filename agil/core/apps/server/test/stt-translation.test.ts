/**
 * Local STT v2 + machine translation — server integration.
 *
 * A `FakeSttEngine` / `FakeTranslator` are injected through `sttEngines`, so the
 * suite needs no whisper.cpp binary, Python package, model file or network.
 * Covers: consent gating, tenant translation policy, the transcript and
 * translate endpoints, honest status, and "translation must never cost the
 * transcript" degradation.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import {
  FakeSttEngine,
  FakeTranslator,
  OpusMtTranslator,
  WhisperCppEngine,
  type SttAvailability,
} from '@agil/ai';
import { openWs, startTestServer, delay, type TestServer } from './helpers.js';
import { sanitizePublicReason } from '../src/stt-translation.js';
import { parseChunkOffset } from '../src/public-api.js';
import { HttpError } from '../src/http.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const ACME_ADMIN = { 'x-api-key': 'acme-key' };

/**
 * Engine/weights ready, transport (ffmpeg) missing: `availability()` reports
 * `ffmpeg_missing`, but a raw WAV chunk is still transcribable.
 */
class WavOnlyEngine extends FakeSttEngine {
  override async availability(): Promise<SttAvailability> {
    const base = await super.availability();
    return {
      ...base,
      available: true,
      code: 'ffmpeg_missing',
      ffmpeg: false,
      reason: 'ffmpeg is not installed: browser webm/opus chunks cannot be converted to 16 kHz WAV.',
    };
  }

  async modelAvailability(): Promise<SttAvailability> {
    return super.availability();
  }

  override async transcribe(request: Parameters<FakeSttEngine['transcribe']>[0]) {
    if (!request.mime.includes('wav')) {
      throw Object.assign(new Error('ffmpeg is required to convert browser audio (webm/opus) to 16 kHz WAV'), {
        code: 'ffmpeg_missing',
      });
    }
    return super.transcribe(request);
  }
}

const RU_FIXTURE = [
  { start: 0, end: 2, text: 'привет мир' },
  { start: 2, end: 4, text: 'доброе утро' },
];

interface HarnessOptions {
  consentRequired?: boolean;
  translateTo?: 'none' | 'ru' | 'en';
  retentionSec?: number;
  featuresTranslation?: boolean;
  sttEngine?: FakeSttEngine;
  translator?: FakeTranslator | null;
}

interface Harness {
  ts: TestServer;
  roomId: string;
  hostToken: string;
  guestToken: string;
  engine: FakeSttEngine;
  translator: FakeTranslator | null;
  close(): Promise<void>;
}

/** Starts a hermetic server with local STT/translation fakes and a room. */
async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const engine =
    options.sttEngine ??
    new FakeSttEngine({ model: 'tiny-fixture', language: 'ru', segments: RU_FIXTURE });
  const translator =
    options.translator === null
      ? null
      : (options.translator ??
        new FakeTranslator({
          model: 'fixture-mt',
          dictionary: { 'привет мир': 'hello world', 'доброе утро': 'good morning' },
        }));
  const ts = await startTestServer({
    sttProvider: 'local',
    translateProvider: translator ? 'local' : 'none',
    transcriptConsentRequired: options.consentRequired ?? false,
    ...(translator ? { sttEngines: { sttEngine: engine, translator } } : { sttEngines: { sttEngine: engine } }),
  });
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'STT room' } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const roomId = created.body.room.id as string;

  const patched = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: {
      features: { captions: true, translation: options.featuresTranslation ?? true },
      session: {
        transcription: {
          enabled: true,
          provider: 'server',
          language: 'ru',
          showCaptionsByDefault: true,
          saveTranscript: true,
          translateTo: options.translateTo ?? 'none',
          consentRequired: options.consentRequired ?? false,
          retentionSec: options.retentionSec ?? 0,
        },
      },
    },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));

  const host = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Host', role: 'host' } },
  });
  const guest = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Guest', role: 'guest' } },
  });
  return {
    ts,
    roomId,
    hostToken: host.body.token,
    guestToken: guest.body.token,
    engine,
    translator,
    close: () => ts.close(),
  };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function transcribe(
  h: Harness,
  token: string,
  extra: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return h.ts.api('POST', '/v1/stt/transcribe', {
    headers: { ...bearer(token), 'content-type': 'audio/wav', ...extra },
    rawBody: Buffer.from('RIFF....fake-wav'),
  });
}

test('STT does not return a delayed chunk after the participant withdraws and grants consent again', async () => {
  let started!: () => void;
  let finish!: () => void;
  const reached = new Promise<void>((resolve) => { started = resolve; });
  const release = new Promise<void>((resolve) => { finish = resolve; });
  class DelayedEngine extends FakeSttEngine {
    override async transcribe(request: Parameters<FakeSttEngine['transcribe']>[0]) {
      started();
      await release;
      return super.transcribe(request);
    }
  }
  const h = await harness({ consentRequired: true, sttEngine: new DelayedEngine({ segments: RU_FIXTURE }) });
  try {
    const consent = (granted: boolean) => h.ts.api('POST', `/v1/rooms/${h.roomId}/transcript/consent`, {
      headers: bearer(h.guestToken), body: { granted },
    });
    assert.equal((await consent(true)).status, 200);
    const pending = transcribe(h, h.guestToken);
    await Promise.race([reached, pending.then(({ status }) => assert.fail(`STT returned ${status} before reaching the engine`))]);
    assert.equal((await consent(false)).status, 200);
    assert.equal((await consent(true)).status, 200);
    finish();
    const stale = await pending;
    assert.equal(stale.status, 403);
    assert.equal(stale.body.error.code, 'consent_required');
    assert.equal(stale.body.text, undefined);
    assert.equal((await transcribe(h, h.guestToken)).status, 200);
  } finally {
    finish();
    await h.close();
  }
});

/**
 * `fetch` normalizes an empty header value into "absent"; this raw request is
 * the only way to exercise an explicitly sent empty `x-chunk-offset:`.
 */
function rawTranscribe(h: Harness, token: string, chunkOffset: string): Promise<{ status: number; body: any }> {
  const payload = Buffer.from('RIFF....fake-wav');
  const port = Number(new URL(h.ts.base).port);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/stt/transcribe',
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'audio/wav',
          'content-length': payload.length,
          'x-chunk-offset': chunkOffset,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: any = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

test('local transcribe: consent gate, RU fixture, timestamps and machine translation', async () => {
  const h = await harness({ consentRequired: true, translateTo: 'en' });
  try {
    const consentPath = `/v1/rooms/${h.roomId}/transcript/consent`;
    const initialConsent = await h.ts.api('GET', consentPath, { headers: bearer(h.guestToken) });
    assert.equal(initialConsent.status, 200);
    assert.deepEqual(initialConsent.body, { consentRequired: true, consented: false });
    const blocked = await transcribe(h, h.guestToken, { 'x-translate-to': 'en' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'consent_required');

    const consent = await h.ts.api('POST', consentPath, {
      headers: bearer(h.guestToken),
      body: { granted: true },
    });
    assert.equal(consent.status, 200, JSON.stringify(consent.body));
    assert.equal(consent.body.consent.granted, true);
    assert.deepEqual((await h.ts.api('GET', consentPath, { headers: bearer(h.guestToken) })).body,
      { consentRequired: true, consented: true });
    assert.deepEqual((await h.ts.api('GET', consentPath, { headers: bearer(h.hostToken) })).body,
      { consentRequired: true, consented: false });

    const response = await transcribe(h, h.guestToken, { 'x-translate-to': 'en' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const body = response.body;
    assert.equal(body.provider, 'local');
    assert.equal(body.local, false, 'the fake engine is not a real on-box model');
    assert.equal(body.engine, 'fake:tiny-fixture');
    assert.equal(body.language, 'ru');
    assert.equal(body.text, 'привет мир доброе утро');
    assert.equal(body.segments.length, 2);
    assert.deepEqual(
      body.segments.map((segment: any) => [segment.start, segment.end, segment.text]),
      [
        [0, 2, 'привет мир'],
        [2, 4, 'доброе утро'],
      ],
    );
    assert.equal(body.segments[0].translation.text, 'hello world');
    assert.equal(body.segments[0].translation.lang, 'en');
    assert.equal(body.segments[1].translation.text, 'good morning');
    assert.equal(body.translation.targetLang, 'en');
    assert.equal(body.translation.provider, 'stub');
    assert.match(String(body.notice), /Machine translation/i);
    assert.equal(h.engine.calls.length, 1);
    assert.equal(h.engine.calls[0]?.mime, 'audio/wav');

    // On-demand re-translation for browser-STT captions.
    const translated = await h.ts.api('POST', `/v1/rooms/${h.roomId}/transcript/translate`, {
      headers: bearer(h.guestToken),
      body: { text: 'привет мир', sourceLang: 'ru', targetLang: 'en' },
    });
    assert.equal(translated.status, 200, JSON.stringify(translated.body));
    assert.equal(translated.body.translation.text, 'hello world');
    assert.equal(translated.body.translation.lang, 'en');
    assert.match(String(translated.body.notice), /Machine translation/i);
  } finally {
    await h.close();
  }
});

test('admin status is honest and never leaks secrets or model paths', async () => {
  const h = await harness({ translateTo: 'en' });
  try {
    const status = await h.ts.api('GET', '/v1/admin/stt', { headers: ADMIN });
    assert.equal(status.status, 200, JSON.stringify(status.body));
    const body = status.body;
    assert.equal(body.privacyMode, 'standard');
    assert.equal(body.stt.provider, 'local');
    assert.equal(body.stt.local, true);
    assert.equal(body.stt.configured, true);
    assert.equal(body.stt.available, true);
    assert.equal(body.stt.engine, 'fake:tiny-fixture');
    assert.equal(body.translation.provider, 'local');
    assert.equal(body.translation.configured, true);
    assert.equal(body.translation.available, true);
    assert.equal(body.translation.engine, 'fixture-mt');
    assert.equal(body.consent.required, false);
    assert.ok(Array.isArray(body.caveats) && body.caveats.length >= 2);
    assert.ok(body.caveats.some((caveat: string) => /not bundled/i.test(caveat)));
    assert.ok(body.caveats.some((caveat: string) => /never downloaded automatically/i.test(caveat)));
    // No API keys, tokens or absolute model paths in the status payload.
    const serialized = JSON.stringify(body);
    assert.ok(!/api[_-]?key|secret|token/i.test(serialized), serialized);
    assert.ok(!/\\\\|[A-Za-z]:\\\\/.test(serialized), `absolute paths leaked: ${serialized}`);
  } finally {
    await h.close();
  }
});

test('real adapters never leak host paths to any tenant admin (P2-1)', async () => {
  const secretModel =
    process.platform === 'win32'
      ? 'C:\\Users\\qa-user\\secret\\models\\ggml-small.bin'
      : '/home/qa-user/secret/models/ggml-small.bin';
  const secretModelDir =
    process.platform === 'win32' ? 'D:\\host-secret\\translate' : '/host-secret/translate';
  const ts = await startTestServer({
    sttProvider: 'local',
    translateProvider: 'local',
    sttEngines: {
      sttEngine: new WhisperCppEngine({ binary: process.execPath, modelPath: secretModel }),
      translator: new OpusMtTranslator({ python: process.execPath, modelDir: secretModelDir }),
    },
  });
  try {
    for (const headers of [ADMIN, ACME_ADMIN]) {
      const status = await ts.api('GET', '/v1/admin/stt', { headers });
      assert.equal(status.status, 200, JSON.stringify(status.body));
      const body = status.body;
      assert.equal(body.stt.available, false);
      assert.equal(body.stt.configured, false);
      assert.equal(body.stt.code, 'model_missing');
      assert.equal(body.stt.model, 'ggml-small.bin');
      assert.equal(body.translation.available, false);
      assert.equal(body.translation.code, 'model_dir_missing');
      assert.equal(body.translation.model, 'translate');
      const serialized = JSON.stringify(body);
      for (const secret of ['qa-secret', 'qa-user', 'host-secret', 'C:\\', 'D:\\', '/home/', '/host-secret']) {
        assert.ok(!serialized.includes(secret), `secret "${secret}" leaked: ${serialized}`);
      }
      assert.ok(!serialized.includes('\\\\'), `windows path leaked: ${serialized}`);
      assert.ok(!/(?:^|[^A-Za-z])[A-Za-z]:[\\/]/.test(serialized), `absolute path leaked: ${serialized}`);
    }
    const anonymous = await ts.api('GET', '/v1/admin/stt');
    assert.equal(anonymous.status, 401);
  } finally {
    await ts.close();
  }
});

test('legacy NLLB settings report an offline migration even when STT downloads are enabled', async () => {
  for (const config of [
    { translateLocalEngine: 'nllb' as const },
    { translateLocalEngine: 'opus-mt' as const, translateLocalModel: 'facebook/nllb-200-distilled-600M' },
  ]) {
    const ts = await startTestServer({
      ...config,
      translateProvider: 'local',
      localModelsAllowDownload: true,
    });
    try {
      const result = await ts.api('GET', '/v1/admin/stt', { headers: ADMIN });
      assert.equal(result.status, 200);
      assert.equal(result.body.translation.available, false);
      assert.equal(result.body.translation.code, 'translation_model_retired');
      assert.equal(result.body.translation.nonCommercial, true);
      assert.equal(result.body.translation.localFilesOnly, true);
      assert.match(result.body.translation.reason, /--mt pair/);
      assert.ok(result.body.caveats.some((caveat: string) => /CC-BY-NC/.test(caveat)));
    } finally {
      await ts.close();
    }
  }
});

test('x-chunk-offset makes local segment timestamps absolute (P3-1)', async () => {
  const h = await harness();
  try {
    const shifted = await transcribe(h, h.guestToken, { 'x-chunk-offset': '10.5' });
    assert.equal(shifted.status, 200, JSON.stringify(shifted.body));
    assert.deepEqual(
      shifted.body.segments.map((segment: any) => [segment.start, segment.end]),
      [
        [10.5, 12.5],
        [12.5, 14.5],
      ],
    );
    assert.equal(h.engine.calls[0]?.offsetSec, 10.5);

    const invalid = await transcribe(h, h.guestToken, { 'x-chunk-offset': '-1' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'invalid_chunk_offset');

    // Explicitly sent empty/blank headers must be rejected (fetch cannot carry
    // them, so use a raw Node request).
    for (const raw of ['', ' ']) {
      const empty = await rawTranscribe(h, h.guestToken, raw);
      assert.equal(empty.status, 400, `expected 400 for ${JSON.stringify(raw)}: ${JSON.stringify(empty.body)}`);
      assert.equal(empty.body.error.code, 'invalid_chunk_offset');
    }

    const plain = await transcribe(h, h.guestToken);
    assert.deepEqual(
      plain.body.segments.map((segment: any) => [segment.start, segment.end]),
      [
        [0, 2],
        [2, 4],
      ],
    );
  } finally {
    await h.close();
  }
});

test('features.translation=false cannot be bypassed by x-translate-to (P3-2)', async () => {
  const h = await harness({ translateTo: 'en', featuresTranslation: false });
  try {
    const response = await transcribe(h, h.guestToken, { 'x-translate-to': 'en' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.translation, undefined);
    assert.equal(response.body.segments[0].translation, undefined);
    assert.match(String(response.body.notice), /features\.translation=false|disabled/i);
    assert.equal(h.translator?.calls.length, 0, 'the translation engine must not run');

    // The notice must also appear when the client sends no header at all.
    const withoutHeader = await transcribe(h, h.guestToken);
    assert.equal(withoutHeader.status, 200, JSON.stringify(withoutHeader.body));
    assert.equal(withoutHeader.body.translation, undefined);
    assert.match(String(withoutHeader.body.notice), /features\.translation=false|disabled/i);

    const endpoint = await h.ts.api('POST', `/v1/rooms/${h.roomId}/transcript/translate`, {
      headers: bearer(h.guestToken),
      body: { text: 'привет мир', targetLang: 'en' },
    });
    assert.equal(endpoint.status, 501);
    assert.equal(endpoint.body.error.code, 'translation_not_configured');
  } finally {
    await h.close();
  }
});

test('audio/wav is accepted without ffmpeg (P2-R regression)', async () => {
  const h = await harness({ sttEngine: new WavOnlyEngine({ model: 'tiny-fixture', language: 'ru', segments: RU_FIXTURE }) });
  try {
    const response = await transcribe(h, h.guestToken);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.text, 'привет мир доброе утро');

    // Status is honest: engine+weights are ready (`available:true`), but the
    // browser transport is missing and reported explicitly.
    const status = await h.ts.api('GET', '/v1/admin/stt', { headers: ADMIN });
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.body.stt.available, true);
    assert.equal(status.body.stt.configured, true);
    assert.equal(status.body.stt.code, 'ffmpeg_missing');
    assert.equal(status.body.stt.ffmpeg, false);
    assert.match(String(status.body.stt.reason), /webm\/opus/i);

    // webm/opus without ffmpeg is a clear, actionable 501 rather than a 502.
    const webm = await transcribe(h, h.guestToken, { 'content-type': 'audio/webm' });
    assert.equal(webm.status, 501, JSON.stringify(webm.body));
    assert.equal(webm.body.error.code, 'ffmpeg_missing');
    assert.match(String(webm.body.error.message), /ffmpeg/i);
  } finally {
    await h.close();
  }
});

test('sanitizePublicReason keeps API routes but redacts filesystem paths', () => {
  assert.equal(
    sanitizePublicReason('POST /v1/rooms/abc/transcript/translate'),
    'POST /v1/rooms/abc/transcript/translate',
  );
  assert.equal(sanitizePublicReason('model at /home/qa-user/models/ggml-small.bin'), 'model at <path>');
  assert.equal(sanitizePublicReason('model at C:\\Users\\qa-user\\models\\ggml-small.bin'), 'model at <path>');
  assert.equal(sanitizePublicReason('see https://example.com/models/x'), 'see https://example.com/models/x');
});

test('parseChunkOffset rejects an empty or non-numeric header', () => {
  for (const raw of ['', ' ', 'abc', '-1', 'Infinity']) {
    assert.throws(
      () => parseChunkOffset(raw),
      (error: unknown) => error instanceof HttpError && error.code === 'invalid_chunk_offset',
      `expected 400 for ${JSON.stringify(raw)}`,
    );
  }
  assert.equal(parseChunkOffset(undefined), undefined);
  assert.equal(parseChunkOffset('10.5'), 10.5);
});

test('consent is enforced even when the room is gone (P3-6)', async () => {
  const consenting = await harness({ consentRequired: true });
  const open = await harness({ consentRequired: false });
  try {
    for (const h of [consenting, open]) {
      const deleted = await h.ts.api('DELETE', `/v1/admin/rooms/${h.roomId}`, { headers: ADMIN });
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    }
    const blocked = await transcribe(consenting, consenting.guestToken);
    assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error.code, 'consent_required');
    assert.match(String(blocked.body.error.message), /no longer active/i);

    // Without a consent requirement, a closed room still transcribes (nothing
    // is stored because the room is gone) — documented in §5.
    const allowed = await transcribe(open, open.guestToken);
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  } finally {
    await consenting.close();
    await open.close();
  }
});

test('server STT translation is reused by the WS caption (no double engine work, P3-7)', async () => {
  const h = await harness({ translateTo: 'en' });
  try {
    const response = await transcribe(h, h.guestToken);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.segments[0].translation.text, 'hello world');
    assert.equal(h.translator?.calls.length, 2, 'two segments were translated by the STT request');

    const host = await openWs(`${h.ts.wsUrl}?token=${encodeURIComponent(h.hostToken)}`);
    const guest = await openWs(`${h.ts.wsUrl}?token=${encodeURIComponent(h.guestToken)}`);
    await host.waitFor((message) => message.type === 'welcome');
    await guest.waitFor((message) => message.type === 'welcome');
    guest.send({ type: 'caption', text: 'привет мир', isFinal: true, lang: 'ru' });
    const translated = await host.waitFor((message) => message.type === 'caption' && message.translated === true);
    assert.equal(translated.translation, 'hello world');
    assert.equal(h.translator?.calls.length, 2, 'the cached translation is reused');
    await guest.close();
    await host.close();
  } finally {
    await h.close();
  }
});

test('translation cache is cleared when consent is withdrawn or the transcript is purged', async () => {
  const h = await harness({ translateTo: 'en' });
  try {
    const translated = await transcribe(h, h.guestToken);
    assert.equal(translated.status, 200, JSON.stringify(translated.body));
    assert.equal(h.translator?.calls.length, 2);

    const translateLine = () =>
      h.ts.api('POST', `/v1/rooms/${h.roomId}/transcript/translate`, {
        headers: bearer(h.guestToken),
        body: { text: 'привет мир', sourceLang: 'ru', targetLang: 'en' },
      });

    // Cache hit: the same line is not translated twice.
    const cached = await translateLine();
    assert.equal(cached.status, 200, JSON.stringify(cached.body));
    assert.equal(h.translator?.calls.length, 2);

    const withdrawn = await h.ts.api('POST', `/v1/rooms/${h.roomId}/transcript/consent`, {
      headers: bearer(h.guestToken),
      body: { granted: false },
    });
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    const afterWithdrawal = await translateLine();
    assert.equal(afterWithdrawal.status, 200, JSON.stringify(afterWithdrawal.body));
    assert.equal(h.translator?.calls.length, 3, 'consent withdrawal drops cached translations');

    const purged = await h.ts.api('DELETE', `/v1/admin/rooms/${h.roomId}/transcript`, { headers: ADMIN });
    assert.equal(purged.status, 200, JSON.stringify(purged.body));
    const afterPurge = await translateLine();
    assert.equal(afterPurge.status, 200, JSON.stringify(afterPurge.body));
    assert.equal(h.translator?.calls.length, 4, 'admin purge drops cached translations');
  } finally {
    await h.close();
  }
});

test('translation failure keeps the transcript and reports it', async () => {
  const h = await harness({
    translateTo: 'en',
    translator: new FakeTranslator({ model: 'broken-mt', failWith: 'model is not loaded' }),
  });
  try {
    const response = await transcribe(h, h.guestToken, { 'x-translate-to': 'en' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.provider, 'local');
    assert.equal(response.body.text, 'привет мир доброе утро');
    assert.equal(response.body.segments.length, 2);
    assert.equal(response.body.segments[0].translation, undefined, 'no fabricated translation');
    assert.match(String(response.body.notice), /unavailable|not ready/i);

    const translated = await h.ts.api('POST', `/v1/rooms/${h.roomId}/transcript/translate`, {
      headers: bearer(h.guestToken),
      body: { text: 'привет мир', targetLang: 'en' },
    });
    assert.equal(translated.status, 503);
    assert.equal(translated.body.error.code, 'translation_unavailable');

    const status = await h.ts.api('GET', '/v1/admin/stt', { headers: ADMIN });
    assert.equal(status.body.translation.available, false);
    assert.match(String(status.body.translation.reason), /not loaded/i);
  } finally {
    await h.close();
  }
});

test('unavailable local engine answers 501 with an actionable reason', async () => {
  const h = await harness({
    sttEngine: new FakeSttEngine({ failWith: 'ggml-small.bin not found; run the model download script' }),
  });
  try {
    const response = await transcribe(h, h.guestToken);
    assert.equal(response.status, 501);
    assert.equal(response.body.error.code, 'stt_not_configured');
    assert.match(String(response.body.error.message), /ggml-small\.bin/);

    const status = await h.ts.api('GET', '/v1/admin/stt', { headers: ADMIN });
    assert.equal(status.body.stt.configured, false);
    assert.equal(status.body.stt.available, false);
  } finally {
    await h.close();
  }
});

test('WS captions: consent is enforced, translation arrives as a follow-up frame', async () => {
  const h = await harness({ consentRequired: true, translateTo: 'en' });
  try {
    const host = await openWs(`${h.ts.wsUrl}?token=${encodeURIComponent(h.hostToken)}`);
    const guest = await openWs(`${h.ts.wsUrl}?token=${encodeURIComponent(h.guestToken)}`);
    await host.waitFor((message) => message.type === 'welcome');
    await guest.waitFor((message) => message.type === 'welcome');

    guest.send({ type: 'caption', text: 'привет мир', isFinal: true, lang: 'ru' });
    const denied = await guest.waitFor((message) => message.type === 'error' && message.code === 'consent_required');
    assert.match(String(denied.message), /consent/i);

    const consent = await h.ts.api('POST', `/v1/rooms/${h.roomId}/transcript/consent`, {
      headers: bearer(h.guestToken),
      body: { granted: true },
    });
    assert.equal(consent.status, 200);

    guest.send({ type: 'caption', text: 'привет мир', isFinal: true, lang: 'ru' });
    const caption = await host.waitFor((message) => message.type === 'caption' && message.translated !== true);
    assert.equal(caption.text, 'привет мир');
    const translated = await host.waitFor((message) => message.type === 'caption' && message.translated === true);
    assert.equal(translated.translation, 'hello world');
    assert.equal(translated.translationLang, 'en');
    assert.equal(translated.translationProvider, 'stub');
    assert.equal(translated.segmentId, caption.segmentId);

    // The stored transcript carries the same translation for later export.
    const transcript = await h.ts.api('GET', `/v1/rooms/${h.roomId}/transcript`, {
      headers: bearer(h.guestToken),
    });
    assert.equal(transcript.status, 200, JSON.stringify(transcript.body));
    assert.equal(transcript.body.translation.enabled, true);
    assert.equal(transcript.body.translation.target, 'en');
    assert.equal(transcript.body.retention.consentRequired, true);
    assert.equal(transcript.body.retention.consented, true);
    const stored = transcript.body.segments.find((segment: any) => segment.text === 'привет мир');
    assert.ok(stored, 'caption is stored');
    assert.equal(stored.translation.text, 'hello world');

    const disabled = await h.ts.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN, body: { session: { transcription: { saveTranscript: false } } },
    });
    assert.equal(disabled.status, 200);
    guest.send({ type: 'caption', text: 'привет мир', isFinal: true, lang: 'ru' });
    const live = await host.waitFor((message) => message.type === 'caption' && !message.translated && message.segmentId === undefined);
    const liveTranslation = await host.waitFor((message) => message.type === 'caption' && message.translated && message.segmentId === undefined);
    assert.equal(live.text, 'привет мир');
    assert.equal(liveTranslation.translation, 'hello world');
    const preserved = await h.ts.api('GET', `/v1/rooms/${h.roomId}/transcript`, { headers: bearer(h.guestToken) });
    assert.deepEqual(preserved.body.segments, transcript.body.segments);

    await guest.close();
    await host.close();
  } finally {
    await h.close();
  }
});

test('consent withdrawal erases stored segments and retention prunes old ones', async () => {  const h = await harness({ consentRequired: true, retentionSec: 1 });
  try {
    const host = await openWs(`${h.ts.wsUrl}?token=${encodeURIComponent(h.hostToken)}`);
    const guest = await openWs(`${h.ts.wsUrl}?token=${encodeURIComponent(h.guestToken)}`);
    await host.waitFor((message) => message.type === 'welcome');
    await guest.waitFor((message) => message.type === 'welcome');

    const consent = await h.ts.api('POST', `/v1/rooms/${h.roomId}/transcript/consent`, {
      headers: bearer(h.guestToken),
      body: { granted: true },
    });
    assert.equal(consent.status, 200);

    guest.send({ type: 'caption', text: 'привет мир', isFinal: true, lang: 'ru' });
    await host.waitFor((message) => message.type === 'caption' && message.text === 'привет мир');
    const stored = await h.ts.api('GET', `/v1/rooms/${h.roomId}/transcript`, { headers: bearer(h.guestToken) });
    assert.equal(stored.status, 200, JSON.stringify(stored.body));
    assert.ok(stored.body.segments.some((segment: any) => segment.text === 'привет мир'));

    const withdrawn = await h.ts.api('POST', `/v1/rooms/${h.roomId}/transcript/consent`, {
      headers: bearer(h.guestToken),
      body: { granted: false },
    });
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    assert.ok(withdrawn.body.removedSegments >= 1, 'withdrawal erases this participant\'s segments');

    // Re-grant only to read the room transcript; the old segment must be gone.
    await h.ts.api('POST', `/v1/rooms/${h.roomId}/transcript/consent`, {
      headers: bearer(h.guestToken),
      body: { granted: true },
    });
    const afterWithdrawal = await h.ts.api('GET', `/v1/rooms/${h.roomId}/transcript`, {
      headers: bearer(h.guestToken),
    });
    assert.equal(afterWithdrawal.status, 200);
    assert.ok(!afterWithdrawal.body.segments.some((segment: any) => segment.text === 'привет мир'));

    // A new segment is kept for ~1 s and then pruned by retention on read.
    guest.send({ type: 'caption', text: 'доброе утро', isFinal: true, lang: 'ru' });
    await host.waitFor((message) => message.type === 'caption' && message.text === 'доброе утро');
    await delay(1200);
    const pruned = await h.ts.api('GET', `/v1/rooms/${h.roomId}/transcript`, { headers: bearer(h.guestToken) });
    assert.equal(pruned.status, 200);
    assert.ok(
      !pruned.body.segments.some((segment: any) => segment.text === 'доброе утро'),
      'retentionSec=1 drops the segment after it expires',
    );

    await guest.close();
    await host.close();
  } finally {
    await h.close();
  }
});

test('PRIVACY_MODE=local refuses the legacy remote STT path', async () => {
  const ts = await startTestServer({
    sttProvider: 'remote',
    sttUrl: 'https://stt.example.com/v1',
    sttKey: 'test-key',
    privacyMode: 'local',
  });
  try {
    const patched = await ts.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { features: { captions: true } },
    });
    assert.equal(patched.status, 200);
    const created = await ts.api('POST', '/v1/rooms', { body: { name: 'Privacy STT room' } });
    const token = created.body.token as string;

    const response = await ts.api('POST', '/v1/stt/transcribe', {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/webm' },
      rawBody: Buffer.from('audio'),
    });
    assert.equal(response.status, 501);
    assert.equal(response.body.error.code, 'stt_not_configured');
    assert.match(String(response.body.error.message), /PRIVACY_MODE=local/);

    const status = await ts.api('GET', '/v1/admin/stt', { headers: ADMIN });
    assert.equal(status.status, 200);
    assert.equal(status.body.privacyMode, 'local');
    assert.equal(status.body.stt.provider, 'remote');
    assert.equal(status.body.stt.configured, false);
    assert.match(String(status.body.stt.reason), /PRIVACY_MODE=local/);
  } finally {
    await ts.close();
  }
});

test('the optional remote STT binding leaves the on-box engine available', async () => {
  const h = await harness();
  try {
    const patched = await h.ts.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN, body: { session: { transcription: { nodeId: 'missing-remote-stt' } } },
    });
    assert.equal(patched.status, 200, patched.text);
    assert.equal((await transcribe(h, h.guestToken)).status, 200);
  } finally {
    await h.close();
  }
});
