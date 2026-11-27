/**
 * Local STT v2 adapter tests without model binaries or Python packages.
 *
 * The deterministic `FakeSttEngine` exercises chunk offsets, segmentation and
 * availability, while the real adapters are only asked for their *actionable*
 * "not installed" reasons (they must never throw at import/status time).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  FakeSttEngine,
  FasterWhisperEngine,
  WhisperCppEngine,
  chunkText,
  createLocalSttEngine,
  describeEngine,
  fasterWhisperWorkerArgs,
  resolveFasterWhisperModel,
} from '../src/index.js';
import { JsonLineWorker } from '../src/local-support.js';

const AUDIO = Buffer.from('fake-wav-bytes');

test('stop gives the local worker time to finish its EOF cleanup', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agil-worker-stop-'));
  const marker = path.join(directory, 'stopped');
  const program = `
    const input = require('node:readline').createInterface({ input: process.stdin });
    input.on('close', () => require('node:fs').writeFileSync(process.argv[1], 'stopped'));
    console.log(JSON.stringify({ ready: true }));
  `;
  const worker = new JsonLineWorker(process.execPath, ['-e', program, marker]);
  try {
    await worker.start();
    worker.stop();
    const deadline = Date.now() + 2500;
    let result;
    do {
      result = await readFile(marker, 'utf8').catch(() => undefined);
      if (result) break;
      await delay(25);
    } while (Date.now() < deadline);
    assert.equal(result, 'stopped');
  } finally {
    worker.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('local workers use UTF-8 even when a character crosses pipe reads', async () => {
  const fixture = `
    const { createInterface } = require('node:readline');
    console.log(JSON.stringify({ ready: true, encoding: process.env.PYTHONIOENCODING }));
    createInterface({ input: process.stdin }).on('line', (line) => {
      const { id, text } = JSON.parse(line);
      const reply = Buffer.from(JSON.stringify({ id, ok: true, text }) + '\\n');
      const boundary = reply.indexOf(Buffer.from(text)) + 1;
      process.stdout.write(reply.subarray(0, boundary));
      setTimeout(() => process.stdout.write(reply.subarray(boundary)), 50);
    });`;
  const worker = new JsonLineWorker(process.execPath, ['-e', fixture], 5000, {
    env: { ...process.env, PYTHONIOENCODING: 'cp1251' },
  });
  try {
    assert.equal((await worker.start()).encoding, 'utf-8');
    const text = 'Субтитры';
    assert.equal((await worker.request({ text })).text, text);
  } finally {
    worker.stop();
  }
});

test('fake engine returns the fixture, applies chunk offset and joins text', async () => {
  const engine = new FakeSttEngine({
    model: 'tiny-fixture',
    language: 'ru',
    segments: [
      { start: 1, end: 2, text: '  привет  ' },
      { start: 3, end: 4, text: 'мир' },
      { start: 4, end: 5, text: '   ' },
    ],
  });
  const result = await engine.transcribe({ audio: AUDIO, mime: 'audio/wav', offsetSec: 5, language: 'ru' });

  assert.equal(result.engine, 'fake');
  assert.equal(result.fake, true);
  assert.equal(result.text, 'привет мир');
  assert.equal(result.language, 'ru');
  assert.equal(result.segments.length, 2, 'blank segments are dropped');
  assert.deepEqual(
    result.segments.map((segment) => [segment.start, segment.end, segment.text]),
    [
      [6, 7, 'привет'],
      [8, 9, 'мир'],
    ],
    'offsetSec is added to absolute timestamps',
  );
  assert.equal(result.durationSec, 9);
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0]?.offsetSec, 5);
});

test('fake engine clamps negative timestamps and caps segment text', async () => {
  const engine = new FakeSttEngine({
    segments: [{ start: -4, end: -2, text: 'x'.repeat(5000) }],
  });
  const result = await engine.transcribe({ audio: AUDIO, mime: 'audio/webm', offsetSec: 0 });
  const segment = result.segments[0];
  assert.ok(segment);
  assert.equal(segment.start, 0);
  assert.equal(segment.end, 0);
  assert.equal(segment.text.length, 4000);
});

test('fake engine reports unavailability without running a process', async () => {
  const engine = new FakeSttEngine({ failWith: 'model file is missing' });
  const availability = await engine.availability();
  assert.equal(availability.available, false);
  assert.equal(availability.reason, 'model file is missing');
  assert.equal(availability.engine, 'fake');
  await assert.rejects(
    () => engine.transcribe({ audio: AUDIO, mime: 'audio/wav' }),
    /model file is missing/,
  );
});

test('whisper.cpp adapter explains a missing binary instead of throwing', async () => {
  const engine = new WhisperCppEngine({
    binary: 'agil-missing-whisper-binary-xyz',
    modelPath: 'missing-ggml-small.bin',
  });
  const availability = await engine.availability();
  assert.equal(availability.available, false);
  assert.match(String(availability.reason), /not found on PATH/i);
  assert.match(String(availability.reason), /STT_LOCAL_BINARY/);
});

test('faster-whisper adapter explains a missing Python interpreter', async () => {
  const engine = new FasterWhisperEngine({ python: 'agil-missing-python-xyz' });
  const availability = await engine.availability();
  assert.equal(availability.available, false);
  assert.match(String(availability.reason), /Python executable/i);
  assert.match(String(availability.reason), /STT_LOCAL_PYTHON/);
});

test('availability reasons never echo absolute model or worker paths', async () => {
  const secretModel =
    process.platform === 'win32'
      ? 'C:\\Users\\qa-user\\secret\\models\\ggml-small.bin'
      : '/home/qa-user/secret/models/ggml-small.bin';
  const whisper = new WhisperCppEngine({ binary: process.execPath, modelPath: secretModel });
  const whisperAvailability = await whisper.availability();
  assert.equal(whisperAvailability.available, false);
  assert.equal(whisperAvailability.code, 'model_missing');
  assert.equal(whisperAvailability.model, 'ggml-small.bin');
  assert.ok(!String(whisperAvailability.reason).includes('qa-user'), whisperAvailability.reason);
  assert.ok(!/[A-Za-z]:[\\/]/.test(String(whisperAvailability.reason)), whisperAvailability.reason);
  assert.ok(!String(whisperAvailability.reason).includes('secret'), whisperAvailability.reason);

  const secretWorker =
    process.platform === 'win32'
      ? 'D:\\host-secret\\workers\\faster_whisper_worker.py'
      : '/host-secret/workers/faster_whisper_worker.py';
  const faster = new FasterWhisperEngine({ python: process.execPath, workerScript: secretWorker });
  const fasterAvailability = await faster.availability();
  assert.equal(fasterAvailability.available, false);
  assert.equal(fasterAvailability.code, 'worker_script_missing');
  assert.ok(!String(fasterAvailability.reason).includes('host-secret'), fasterAvailability.reason);
  assert.ok(!String(fasterAvailability.reason).includes('qa-user'), fasterAvailability.reason);
});

test('whisper.cpp availability checks ffmpeg for browser webm/opus chunks', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agil-stt-model-'));
  try {
    const modelPath = path.join(dir, 'ggml-small.bin');
    await writeFile(modelPath, 'fake-weight');
    const missingFfmpeg = new WhisperCppEngine({
      binary: process.execPath,
      modelPath,
      ffmpegPath: 'agil-missing-ffmpeg-xyz',
    });
    const wavOnly = await missingFfmpeg.availability();
    assert.equal(wavOnly.available, true, 'engine+weights are ready; only the transport is missing');
    assert.equal(wavOnly.code, 'ffmpeg_missing');
    assert.equal(wavOnly.ffmpeg, false);
    assert.match(String(wavOnly.reason), /ffmpeg/i);
    // A raw WAV chunk needs no conversion: the engine/weights themselves are
    // ready, so `transcribe()` must not be gated by the missing ffmpeg.
    const modelReady = await missingFfmpeg.modelAvailability();
    assert.equal(modelReady.available, true);
    assert.equal(modelReady.modelPath, modelPath);
    await assert.rejects(
      () => missingFfmpeg.transcribe({ audio: Buffer.from('webm-bytes'), mime: 'audio/webm' }),
      (error: unknown) => (error as { code?: string }).code === 'ffmpeg_missing',
      'webm/opus without ffmpeg must be a clear ffmpeg_missing error',
    );

    const ready = new WhisperCppEngine({ binary: process.execPath, modelPath, ffmpegPath: process.execPath });
    const available = await ready.availability();
    assert.equal(available.available, true);
    assert.equal(available.ffmpeg, true);
    assert.equal(available.model, 'ggml-small.bin');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('faster-whisper model resolution checks local weights before allowing a download', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agil-fw-model-'));
  try {
    const localDir = path.join(root, 'local-model');
    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(localDir, 'model.bin'), 'fake-ct2-weight');
    const local = await resolveFasterWhisperModel(localDir);
    assert.equal(local.state, 'local');
    assert.equal(local.label, 'local-model');
    assert.equal(local.path, localDir);

    const emptyDir = path.join(root, 'empty-model');
    await mkdir(emptyDir, { recursive: true });
    assert.equal((await resolveFasterWhisperModel(emptyDir)).state, 'incomplete');

    // No cache: the default is a hard "missing", never an implicit download.
    const emptyCache = path.join(root, 'empty-cache');
    await mkdir(emptyCache, { recursive: true });
    assert.equal((await resolveFasterWhisperModel('small', { cacheDirs: [emptyCache] })).state, 'missing');
    assert.equal(
      (await resolveFasterWhisperModel('small', { cacheDirs: [emptyCache], allowDownload: true })).state,
      'download',
    );

    // A CTranslate2 snapshot in the HuggingFace cache counts as local weights.
    const cacheDir = path.join(emptyCache, 'models--Systran--faster-whisper-small', 'snapshots', 'abc123');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, 'model.bin'), 'cached-weight');
    const cached = await resolveFasterWhisperModel('small', { cacheDirs: [emptyCache] });
    assert.equal(cached.state, 'local');
    assert.equal(cached.path, cacheDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('faster-whisper worker args are local-files-only unless downloading is explicit', () => {
  const localOnly = fasterWhisperWorkerArgs({}, 'small');
  assert.ok(localOnly.includes('--local-files-only'));
  const downloading = fasterWhisperWorkerArgs({ allowDownload: true, gpu: true }, 'small');
  assert.ok(!downloading.includes('--local-files-only'));
  assert.ok(downloading.includes('float16'));
});

test('engine factory honors injection and auto-detects configured engine', () => {
  const injected = new FakeSttEngine({ model: 'injected' });
  assert.equal(createLocalSttEngine({ engineImpl: injected }), injected);

  const whisper = createLocalSttEngine({ modelPath: 'models/ggml-small.bin' });
  assert.ok(whisper instanceof WhisperCppEngine);
  assert.equal(describeEngine(whisper), 'whisper-cpp:ggml-small.bin');

  const faster = createLocalSttEngine({ engine: 'faster-whisper', model: 'medium' });
  assert.ok(faster instanceof FasterWhisperEngine);
  assert.equal(describeEngine(faster), 'faster-whisper:medium');
});

test('chunkText splits long RU text under the limit without losing words', () => {
  const text = 'Это первое предложение о встрече. '.repeat(30).trim();
  const chunks = chunkText(text, 120);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 120, `chunk too long: ${chunk.length}`);
    assert.ok(chunk.trim().length > 0);
  }
  const rejoined = chunks.join(' ').replace(/\s+/g, ' ').trim();
  assert.equal(rejoined, text.replace(/\s+/g, ' ').trim());
});

test('chunkText returns a single chunk for short text and clamps the limit', () => {
  assert.deepEqual(chunkText('привет мир', 800), ['привет мир']);
  assert.deepEqual(chunkText('   ', 800), []);
  // The minimum effective limit is 80 characters, even if a caller asks for 10.
  const short = 'a'.repeat(50);
  assert.deepEqual(chunkText(short, 10), [short]);
});
