/**
 * Local machine-translation adapter tests: deterministic fakes and the
 * unavailable/refusal paths. No Python, models or network are used.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FakeTranslator,
  LlmTranslator,
  OpusMtTranslator,
  TranslationError,
  chunkText,
  createLocalTranslator,
  detectLanguage,
  opusWorkerArgs,
  translateInChunks,
  translateSegments,
} from '../src/index.js';

test('detectLanguage separates Cyrillic RU from Latin EN', () => {
  assert.equal(detectLanguage('Привет, как дела?'), 'ru');
  assert.equal(detectLanguage('Hello, how are you?'), 'en');
  assert.equal(detectLanguage('Привет hello'), 'ru', 'ties fall back to RU');
  assert.equal(detectLanguage(''), 'ru');
});

test('fake translator uses its dictionary and built-in tiny fixture', async () => {
  const translator = new FakeTranslator({
    dictionary: { 'добрый день': 'good afternoon' },
    model: 'fixture-mt',
  });

  const dictionary = await translator.translate({ text: 'Добрый день', targetLang: 'en' });
  assert.equal(dictionary.text, 'good afternoon');
  assert.equal(dictionary.sourceLang, 'ru');
  assert.equal(dictionary.provider, 'stub');
  assert.equal(dictionary.engine, 'fixture-mt');

  const fixture = await translator.translate({ text: 'привет мир', targetLang: 'en' });
  assert.equal(fixture.text, 'hello world');

  const reverse = await translator.translate({ text: 'thank you', targetLang: 'ru' });
  assert.equal(reverse.text, 'спасибо');
  assert.equal(translator.calls.length, 3);
});

test('fake translator falls back to a deterministic marker and strips quotes', async () => {
  const translator = new FakeTranslator({
    translate: (text, target) => `«${target}:${text}»`,
  });
  const result = await translator.translate({ text: 'неизвестная фраза', targetLang: 'en' });
  assert.equal(result.text, 'en:неизвестная фраза', 'outer guillemets are removed');
});

test('fake translator is empty-safe and reports configured failures', async () => {
  const translator = new FakeTranslator();
  const empty = await translator.translate({ text: '   ', targetLang: 'en' });
  assert.equal(empty.text, '');

  const failing = new FakeTranslator({ failWith: 'worker crashed' });
  const availability = await failing.availability();
  assert.equal(availability.available, false);
  assert.equal(availability.reason, 'worker crashed');
  await assert.rejects(
    () => failing.translate({ text: 'привет', targetLang: 'en' }),
    (error: unknown) => error instanceof TranslationError && error.code === 'translation_failed',
  );
});

test('LLM translator is refused in local-only privacy mode', async () => {
  const translator = new LlmTranslator({
    chat: async () => 'hello',
    localOnly: true,
    llmModel: 'test-chat',
  });
  const availability = await translator.availability();
  assert.equal(availability.available, false);
  assert.match(String(availability.reason), /local-only/i);
  await assert.rejects(
    () => translator.translate({ text: 'привет', targetLang: 'en' }),
    (error: unknown) => error instanceof TranslationError && error.code === 'translation_local_only',
  );
});

test('LLM translator sanitizes chat output and requires a chat function', async () => {
  const calls: Array<{ role: string; content: string }[]> = [];
  const translator = new LlmTranslator({
    llmModel: 'test-chat',
    chat: async (messages) => {
      calls.push(messages);
      return 'Translation: Hello world';
    },
  });
  const result = await translator.translate({ text: 'Привет мир', sourceLang: 'ru', targetLang: 'en' });
  assert.equal(result.text, 'Hello world');
  assert.equal(result.provider, 'llm');
  assert.equal(result.sourceLang, 'ru');
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.[0]?.content ?? '', /machine-translation engine/i);

  const missing = new LlmTranslator({ llmModel: 'test-chat' });
  assert.equal((await missing.availability()).available, false);
});

test('OPUS-MT adapter explains missing Python/model configuration', async () => {
  const noPython = new OpusMtTranslator({
    python: 'agil-missing-python-xyz',
    modelDir: 'missing-models',
  });
  const availability = await noPython.availability();
  assert.equal(availability.available, false);
  assert.match(String(availability.reason), /Python executable/i);
  assert.match(String(availability.reason), /TRANSLATE_LOCAL_PYTHON/);

  const noModels = new OpusMtTranslator({ modelDir: '' });
  const noModelsAvailability = await noModels.availability();
  assert.equal(noModelsAvailability.available, false);
  assert.ok(String(noModelsAvailability.reason).length > 0);
});

test('translation availability never echoes absolute model or worker paths', async () => {
  const secretModelDir =
    process.platform === 'win32' ? 'D:\\host-secret\\translate' : '/host-secret/translate';
  const translator = new OpusMtTranslator({ python: process.execPath, modelDir: secretModelDir });
  const availability = await translator.availability();
  assert.equal(availability.available, false);
  assert.equal(availability.code, 'model_dir_missing');
  assert.equal(availability.model, 'translate');
  assert.ok(!String(availability.reason).includes('host-secret'), availability.reason);
  assert.ok(!/[A-Za-z]:[\\/]/.test(String(availability.reason)), availability.reason);

  const secretWorker =
    process.platform === 'win32'
      ? 'C:\\Users\\qa-user\\workers\\opus_mt_worker.py'
      : '/home/qa-user/workers/opus_mt_worker.py';
  const brokenWorker = new OpusMtTranslator({ python: process.execPath, workerScript: secretWorker, modelDir: secretModelDir });
  const workerAvailability = await brokenWorker.availability();
  assert.equal(workerAvailability.code, 'worker_script_missing');
  assert.ok(!String(workerAvailability.reason).includes('qa-user'), workerAvailability.reason);
});

test('OPUS-MT availability requires Marian config, tokenizer and weights in both directions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agil-mt-model-'));
  try {
    const modelDir = path.join(root, 'translate');
    for (const direction of ['ru-en', 'en-ru']) {
      await mkdir(path.join(modelDir, direction), { recursive: true });
      await writeFile(path.join(modelDir, direction, 'config.json'), '{"model_type":"marian"}');
      for (const name of ['source.spm', 'target.spm', 'vocab.json']) {
        await writeFile(path.join(modelDir, direction, name), 'test tokenizer fixture');
      }
      await writeFile(path.join(modelDir, direction, 'model.safetensors'), 'fake-weight');
    }
    const workerScript = path.join(root, 'custom-worker.js');
    await writeFile(workerScript, '');
    const ready = new OpusMtTranslator({ python: process.execPath, modelDir, workerScript });
    const availability = await ready.availability();
    assert.equal(availability.available, true);
    assert.equal(availability.model, 'translate');
    assert.equal(availability.localFilesOnly, true);

    const missingPythonPackages = new OpusMtTranslator({ python: process.execPath, modelDir });
    assert.equal((await missingPythonPackages.availability()).code, 'python_package_missing');

    // Availability rejects a different architecture before loading any weights.
    await writeFile(path.join(modelDir, 'en-ru', 'config.json'), '{"model_type":"m2m_100"}');
    const wrongArchitecture = new OpusMtTranslator({ python: process.execPath, modelDir });
    assert.equal((await wrongArchitecture.availability()).code, 'model_incomplete');

    await writeFile(path.join(modelDir, 'en-ru', 'config.json'), '{"model_type":"marian"}');
    await rm(path.join(modelDir, 'en-ru', 'model.safetensors'));
    const incomplete = new OpusMtTranslator({ python: process.execPath, modelDir });
    const incompleteAvailability = await incomplete.availability();
    assert.equal(incompleteAvailability.available, false);
    assert.equal(incompleteAvailability.code, 'model_incomplete');
    assert.match(String(incompleteAvailability.reason), /en-ru/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retired NLLB is unavailable even with an OPUS-MT engine flag', async () => {
  for (const options of [
    { engine: 'nllb' as const },
    { engine: 'opus-mt' as const, modelName: 'facebook/nllb-200-distilled-600M' },
  ]) {
    const translator = new OpusMtTranslator({ ...options, python: 'agil-missing-python', modelDir: 'models' });
    const availability = await translator.availability();
    assert.equal(availability.available, false);
    assert.equal(availability.code, 'translation_model_retired');
    assert.equal(availability.localFilesOnly, true);
    assert.equal(availability.nonCommercial, true);
    assert.match(String(availability.reason), /--mt pair/);
    await assert.rejects(translator.translate({ text: 'Test', targetLang: 'ru' }), /NLLB-200/);
  }
});

test('OPUS worker receives only the offline paired model path', () => {
  const args = opusWorkerArgs({ modelDir: 'models' }, 'opus-mt');
  assert.deepEqual(args.slice(1), ['--engine', 'opus-mt', '--model-dir', 'models', '--device', 'cpu']);
});

test('translator factory: none -> null, fake -> FakeTranslator, injection wins', () => {
  assert.equal(createLocalTranslator({ provider: 'none' }), null);
  assert.ok(createLocalTranslator({ provider: 'fake' }) instanceof FakeTranslator);

  const injected = new FakeTranslator({ model: 'injected' });
  assert.equal(createLocalTranslator({ provider: 'local', translatorImpl: injected }), injected);
  assert.ok(createLocalTranslator({ provider: 'local' }) instanceof OpusMtTranslator);
  assert.ok(createLocalTranslator({ provider: 'llm', chat: async () => 'x' }) instanceof LlmTranslator);
});

test('translateInChunks calls the engine once per chunk and preserves order', async () => {
  const text = 'Первое предложение. Второе предложение. Третье предложение. Четвёртое предложение.';
  const chunks = chunkText(text, 80);
  assert.ok(chunks.length > 1, 'fixture must actually split');

  const seen: string[] = [];
  const result = await translateInChunks(text, 80, async (chunk) => {
    seen.push(chunk);
    return `[${chunk.length}]`;
  });
  assert.equal(seen.length, chunks.length);
  assert.equal(result, chunks.map((chunk) => `[${chunk.length}]`).join(' '));
});

test('translateSegments skips empty and same-language segments', async () => {
  const translator = new FakeTranslator();
  const results = await translateSegments(
    translator,
    [
      { text: 'привет мир', lang: 'ru' },
      { text: '   ', lang: 'ru' },
      { text: 'hello world', lang: 'en' },
      { text: 'спасибо', lang: 'ru' },
    ],
    'en',
  );
  assert.equal(results.length, 4);
  assert.equal(results[0]?.text, 'hello world');
  assert.equal(results[1], null);
  assert.equal(results[2], null, 'already in the target language');
  assert.equal(results[3]?.text, 'thank you');
  assert.equal(translator.calls.length, 2);
});
