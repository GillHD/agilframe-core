/**
 * Local machine-translation adapters.
 *
 * Providers (`TRANSLATE_PROVIDER`):
 *   - `local` — OPUS-MT / MarianMT pair models (ru→en, en→ru), run by a
 *     long-lived Python worker on the same box (no network);
 *   - `llm`   — optional external/self-hosted chat model through a caller-provided
 *     `chat()` function. Disabled by `privacyMode: 'local'` (privacy mode is
 *     local-only by contract);
 *   - `none`  — translation disabled (the UI never promises it).
 *
 * Translation is explicitly **machine translation**: it is labelled as such in
 * the API and the UI, and never described as human-quality.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dirExists,
  fileExists,
  findExecutable,
  hasTransformersWeights,
  JsonLineWorker,
  runProcess,
  chunkText,
} from './local-support.js';

export type TranslationLanguage = 'ru' | 'en';
export type TranslationProviderMode = 'local' | 'llm' | 'none' | 'fake';
export type TranslationProviderName = 'local' | 'llm' | 'stub';
export type TranslationEngineName = 'opus-mt' | 'marian' | 'nllb';

export interface TranslationRequest {
  text: string;
  /** `auto` uses a Cyrillic/Latin heuristic for the ru/en pair. */
  sourceLang?: TranslationLanguage | 'auto';
  targetLang: TranslationLanguage;
}

export interface TranslationResult {
  text: string;
  sourceLang?: TranslationLanguage;
  targetLang: TranslationLanguage;
  provider: TranslationProviderName;
  engine?: string;
  model?: string;
  latencyMs: number;
}

export interface TranslatorAvailability {
  available: boolean;
  provider: TranslationProviderName;
  engine: string;
  model?: string;
  /** Stable, path-free reason code (`model_missing`, `translation_model_retired`, …). */
  code?: string;
  /** True when the engine is restricted to already-downloaded weights. */
  localFilesOnly?: boolean;
  /** True when a retired CC-BY-NC NLLB configuration was detected. */
  nonCommercial?: boolean;
  reason?: string;
}

export interface Translator {
  readonly provider: TranslationProviderName;
  readonly engineLabel: string;
  availability(): Promise<TranslatorAvailability>;
  translate(request: TranslationRequest): Promise<TranslationResult>;
  dispose?(): Promise<void>;
}

export type TranslationErrorCode =
  | 'translation_not_configured'
  | 'translation_unavailable'
  | 'translation_failed'
  | 'translation_timeout'
  | 'translation_local_only'
  | 'translation_too_long';

export class TranslationError extends Error {
  readonly code: TranslationErrorCode;

  constructor(code: TranslationErrorCode, message: string) {
    super(message);
    this.name = 'TranslationError';
    this.code = code;
  }
}

export type TranslateEnginePreference = TranslationEngineName | 'auto';

export interface LocalTranslateOptions {
  provider?: TranslationProviderMode;
  engine?: TranslateEnginePreference;
  /** Directory with `ru-en/` and `en-ru/` model subdirectories (OPUS-MT). */
  modelDir?: string;
  /** Legacy single-model configuration, retained to report migration guidance. */
  modelName?: string;
  python?: string;
  workerScript?: string;
  timeoutMs?: number;
  /** Max characters per translation request (long texts are split). */
  maxChars?: number;
  gpu?: boolean;
  /** Privacy mode: `llm` is refused, only on-box models are allowed. */
  localOnly?: boolean;
  /** Chat function used by the `llm` provider (injected by the caller). */
  chat?: (messages: Array<{ role: 'system' | 'user'; content: string }>, options?: { timeoutMs?: number }) => Promise<string>;
  llmModel?: string;
  /** Injected translator (tests, custom runtime). Wins over every other option. */
  translatorImpl?: Translator;
}

const DEFAULT_PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CHARS = 800;
const DEFAULT_WORKER_SCRIPT = fileURLToPath(new URL('../scripts/local/opus_mt_worker.py', import.meta.url));

/** Cyrillic/Latin heuristic for the ru/en pair (short utterances only). */
export function detectLanguage(text: string): TranslationLanguage {
  const cyrillic = (text.match(/[\u0400-\u04FF]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return cyrillic >= latin ? 'ru' : 'en';
}

function resolveDirection(request: TranslationRequest): { source: TranslationLanguage; target: TranslationLanguage } {
  const target = request.targetLang;
  const source = request.sourceLang === 'ru' || request.sourceLang === 'en'
    ? request.sourceLang
    : detectLanguage(request.text);
  return { source, target };
}

/** Splits long text and concatenates the translated chunks in order. */
export async function translateInChunks(
  text: string,
  maxChars: number,
  translateChunk: (chunk: string) => Promise<string>,
): Promise<string> {
  const chunks = chunkText(text, maxChars);
  const translated: string[] = [];
  for (const chunk of chunks) {
    const piece = (await translateChunk(chunk)).trim();
    if (piece) translated.push(piece);
  }
  return translated.join(' ').trim();
}

function sanitizeTranslation(raw: string, maxChars: number): string {
  let value = raw.trim();
  value = value.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
  value = value.replace(/^(translation|перевод)\s*[:：-]\s*/i, '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('«') && value.endsWith('»'))) {
    value = value.slice(1, -1).trim();
  }
  return value.slice(0, Math.max(200, maxChars * 4));
}

/* ------------------------------------------------------------------ */
/* Fake translator (tests / demos)                                     */
/* ------------------------------------------------------------------ */

export interface FakeTranslatorOptions {
  /** Exact dictionary; looked up case-insensitively. */
  dictionary?: Record<string, string>;
  /** Function override for anything not in the dictionary. */
  translate?: (text: string, targetLang: TranslationLanguage) => string;
  model?: string;
  failWith?: string;
  delayMs?: number;
  provider?: TranslationProviderName;
}

/** Deterministic translator with a tiny built-in ru/en fixture. */
export class FakeTranslator implements Translator {
  readonly provider: TranslationProviderName;
  readonly engineLabel: string;
  readonly calls: TranslationRequest[] = [];
  private readonly options: FakeTranslatorOptions;

  constructor(options: FakeTranslatorOptions = {}) {
    this.options = options;
    this.provider = options.provider ?? 'stub';
    this.engineLabel = options.model ?? 'fake-mt';
  }

  async availability(): Promise<TranslatorAvailability> {
    return {
      available: !this.options.failWith,
      provider: this.provider,
      engine: this.engineLabel,
      model: this.engineLabel,
      ...(this.options.failWith ? { reason: this.options.failWith } : {}),
    };
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    this.calls.push(request);
    if (this.options.delayMs && this.options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }
    if (this.options.failWith) throw new TranslationError('translation_failed', this.options.failWith);
    if (!request.text.trim()) return this.emptyResult(request);
    if (request.text.length > 8000) {
      throw new TranslationError('translation_too_long', 'text exceeds the local translation limit');
    }
    const { source, target } = resolveDirection(request);
    const dictionary = this.options.dictionary ?? {};
    const lookup = dictionary[request.text.trim().toLowerCase()];
    let text = lookup;
    if (!text && this.options.translate) text = this.options.translate(request.text, target);
    if (!text) text = source === target ? request.text : this.defaultFixture(request.text, target);
    return {
      text: sanitizeTranslation(text, 8000),
      sourceLang: source,
      targetLang: target,
      provider: this.provider,
      engine: this.engineLabel,
      model: this.engineLabel,
      latencyMs: 0,
    };
  }

  private emptyResult(request: TranslationRequest): TranslationResult {
    return {
      text: '',
      sourceLang: request.sourceLang === 'auto' ? undefined : request.sourceLang,
      targetLang: request.targetLang,
      provider: this.provider,
      engine: this.engineLabel,
      model: this.engineLabel,
      latencyMs: 0,
    };
  }

  /** Tiny two-phrase fixture so demos/tests have a deterministic mapping. */
  private defaultFixture(text: string, target: TranslationLanguage): string {
    const pairs: Record<string, { ru: string; en: string }> = {
      'hello world': { ru: 'привет мир', en: 'hello world' },
      'привет мир': { ru: 'привет мир', en: 'hello world' },
      'good morning': { ru: 'доброе утро', en: 'good morning' },
      'доброе утро': { ru: 'доброе утро', en: 'good morning' },
      'thank you': { ru: 'спасибо', en: 'thank you' },
      'спасибо': { ru: 'спасибо', en: 'thank you' },
    };
    const entry = pairs[text.trim().toLowerCase()];
    return entry ? entry[target] : `[${target}] ${text}`;
  }
}

/* ------------------------------------------------------------------ */
/* OPUS-MT / Marian (persistent Python worker)                         */
/* ------------------------------------------------------------------ */

function modelLabelOf(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, '');
  return path.basename(trimmed) || trimmed || 'unknown';
}

/** Arguments for the offline OPUS-MT worker. */
export function opusWorkerArgs(options: LocalTranslateOptions, engine: TranslationEngineName): string[] {
  return [
    options.workerScript?.trim() || DEFAULT_WORKER_SCRIPT,
    '--engine', engine,
    '--model-dir', options.modelDir?.trim() ?? '',
    '--device', options.gpu ? 'cuda' : 'cpu',
  ];
}

/** Both directions must contain a Marian model and its tokenizer files. */
export async function opusPairSnapshotState(
  modelDir: string,
): Promise<{ complete: boolean; missing: string[]; incomplete: string[] }> {
  const missing: string[] = [];
  const incomplete: string[] = [];
  for (const direction of ['ru-en', 'en-ru'] as const) {
    const directory = path.join(modelDir, direction);
    if (!(await dirExists(directory))) {
      missing.push(direction);
      continue;
    }
    const config = await readFile(path.join(directory, 'config.json'), 'utf8')
      .then((source) => (JSON.parse(source) as { model_type?: string } | null)?.model_type)
      .catch(() => undefined);
    const tokenizer = await Promise.all(['source.spm', 'target.spm', 'vocab.json'].map((name) => fileExists(path.join(directory, name))));
    if (config !== 'marian' || !tokenizer.every(Boolean) || !(await hasTransformersWeights(directory))) {
      incomplete.push(direction);
    }
  }
  return { complete: missing.length === 0 && incomplete.length === 0, missing, incomplete };
}

export class OpusMtTranslator implements Translator {
  readonly provider = 'local' as const;
  readonly engineLabel: string;
  private readonly options: LocalTranslateOptions;
  private worker: JsonLineWorker | null = null;
  private cachedAvailability: TranslatorAvailability | null = null;
  private checkedAt = 0;

  constructor(options: LocalTranslateOptions = {}) {
    this.options = options;
    const engine = this.engineName();
    const label = options.modelName?.trim()
      ? modelLabelOf(options.modelName)
      : options.modelDir?.trim()
        ? modelLabelOf(options.modelDir)
        : 'opus-mt';
    this.engineLabel = `${engine}:${label}`;
  }

  private engineName(): TranslationEngineName {
    // Recognize the legacy single-model shape before any worker can start.
    if (this.options.modelName?.trim()) return 'nllb';
    const requested = this.options.engine;
    if (requested === 'opus-mt' || requested === 'marian' || requested === 'nllb') return requested;
    return 'opus-mt';
  }

  private pythonCommand(): string {
    return this.options.python?.trim() || DEFAULT_PYTHON;
  }

  private scriptPath(): string {
    return this.options.workerScript?.trim() || DEFAULT_WORKER_SCRIPT;
  }

  private directionDir(source: TranslationLanguage, target: TranslationLanguage): string | null {
    if (!this.options.modelDir?.trim()) return null;
    return path.join(this.options.modelDir.trim(), `${source}-${target}`);
  }

  async availability(): Promise<TranslatorAvailability> {
    if (this.cachedAvailability && Date.now() - this.checkedAt < 60_000) return this.cachedAvailability;
    const nonCommercial = this.engineName() === 'nllb';
    if (this.options.localOnly && this.options.provider === 'llm') {
      return this.cache({
        available: false,
        provider: this.provider,
        engine: this.engineLabel,
        ...(nonCommercial ? { nonCommercial: true } : {}),
        reason: 'privacy mode is local-only: TRANSLATE_PROVIDER=llm is disabled for this tenant',
      });
    }
    if (nonCommercial) {
      return this.cache({
        available: false,
        provider: this.provider,
        engine: this.engineLabel,
        code: 'translation_model_retired',
        nonCommercial: true,
        localFilesOnly: true,
        reason:
          'NLLB-200 (CC-BY-NC-4.0) has been retired. Install OPUS-MT with download-models.mjs --mt pair, set TRANSLATE_LOCAL_ENGINE=opus-mt and TRANSLATE_LOCAL_MODEL_DIR, and unset TRANSLATE_LOCAL_MODEL.',
      });
    }
    const python = findExecutable(this.pythonCommand());
    if (!python) {
      return this.cache({
        available: false,
        provider: this.provider,
        engine: this.engineLabel,
        code: 'python_missing',
        reason: `Python executable "${path.basename(this.pythonCommand())}" was not found. Install Python 3 + transformers, or set TRANSLATE_LOCAL_PYTHON.`,
      });
    }
    if (!(await fileExists(this.scriptPath()))) {
      return this.cache({
        available: false,
        provider: this.provider,
        engine: this.engineLabel,
        code: 'worker_script_missing',
        reason: `translation worker script not found: ${path.basename(this.scriptPath())}. Set TRANSLATE_LOCAL_WORKER or reinstall @agil/ai.`,
      });
    }
    const modelDir = this.options.modelDir?.trim() ?? '';
    if (!modelDir) {
      return this.cache({
        available: false,
        provider: this.provider,
        engine: this.engineLabel,
        code: 'model_dir_not_configured',
        reason:
          'TRANSLATE_LOCAL_MODEL_DIR is not set (expected ru-en/ and en-ru/ model folders from scripts/local/download-models.mjs).',
      });
    }
    if (!(await dirExists(modelDir))) {
      return this.cache({
        available: false,
        provider: this.provider,
        engine: this.engineLabel,
        code: 'model_dir_missing',
        model: modelLabelOf(modelDir),
        reason: `translation model directory not found: ${modelLabelOf(modelDir)}. Run scripts/local/download-models.mjs or fix TRANSLATE_LOCAL_MODEL_DIR.`,
      });
    }
    const snapshot = await opusPairSnapshotState(modelDir);
    if (!snapshot.complete) {
      const detail = snapshot.missing.length > 0 ? `missing ${snapshot.missing.join(', ')}` : `incomplete ${snapshot.incomplete.join(', ')}`;
      return this.cache({
        available: false,
        provider: this.provider,
        engine: this.engineLabel,
        code: 'model_incomplete',
        model: modelLabelOf(modelDir),
        localFilesOnly: true,
        reason: `translation model snapshot ${detail} (Marian config.json, tokenizer and weights required); run scripts/local/download-models.mjs --mt pair.`,
      });
    }
    if (!this.options.workerScript?.trim()) {
      const probe = await runProcess(
        python,
        ['-c', 'import torch, sentencepiece; from transformers import MarianMTModel, MarianTokenizer'],
        { timeoutMs: 20_000 },
      ).catch(() => null);
      if (!probe || probe.timedOut || probe.code !== 0) {
        return this.cache({
          available: false,
          provider: this.provider,
          engine: this.engineLabel,
          code: 'python_package_missing',
          localFilesOnly: true,
          reason: 'The Python interpreter cannot load the Marian worker dependencies. Install torch, transformers, sentencepiece and sacremoses in TRANSLATE_LOCAL_PYTHON.',
        });
      }
    }
    return this.cache({
      available: true,
      provider: this.provider,
      engine: this.engineLabel,
      model: modelLabelOf(modelDir),
      localFilesOnly: true,
    });
  }

  private cache(availability: TranslatorAvailability): TranslatorAvailability {
    this.cachedAvailability = availability;
    this.checkedAt = Date.now();
    return availability;
  }

  private getWorker(): JsonLineWorker {
    if (this.worker?.isRunning()) return this.worker;
    const python = findExecutable(this.pythonCommand());
    if (!python) throw new TranslationError('translation_unavailable', 'Python was not found');
    const args = opusWorkerArgs(this.options, this.engineName());
    this.worker = new JsonLineWorker(python, args, this.options.timeoutMs ?? 120_000, {
      env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
    });
    return this.worker;
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const availability = await this.availability();
    if (!availability.available) {
      throw new TranslationError('translation_unavailable', availability.reason ?? 'local translation is not available');
    }
    if (!request.text.trim()) {
      return {
        text: '',
        sourceLang: request.sourceLang === 'auto' ? undefined : request.sourceLang,
        targetLang: request.targetLang,
        provider: this.provider,
        engine: this.engineLabel,
        latencyMs: 0,
      };
    }
    const startedAt = Date.now();
    const { source, target } = resolveDirection(request);
    if (source === target) {
      return {
        text: request.text,
        sourceLang: source,
        targetLang: target,
        provider: this.provider,
        engine: this.engineLabel,
        latencyMs: 0,
      };
    }
    const maxChars = Math.max(100, Math.min(4000, this.options.maxChars ?? DEFAULT_MAX_CHARS));
    if (request.text.length > 20_000) {
      throw new TranslationError('translation_too_long', 'text exceeds the 20 000 character translation limit');
    }
    const worker = this.getWorker();
    const text = await translateInChunks(request.text, maxChars, async (chunk) => {
      const response = await worker.request(
        { text: chunk, source, target },
        this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      if (typeof response.translation !== 'string') {
        throw new TranslationError('translation_failed', 'translation worker returned no text');
      }
      return response.translation;
    });
    return {
      text: sanitizeTranslation(text, 20_000),
      sourceLang: source,
      targetLang: target,
      provider: this.provider,
      engine: this.engineLabel,
      model: availability.model,
      latencyMs: Date.now() - startedAt,
    };
  }

  async dispose(): Promise<void> {
    this.worker?.stop();
    this.worker = null;
  }
}

/* ------------------------------------------------------------------ */
/* LLM provider (optional, explicit opt-in)                            */
/* ------------------------------------------------------------------ */

export class LlmTranslator implements Translator {
  readonly provider = 'llm' as const;
  readonly engineLabel: string;
  private readonly options: LocalTranslateOptions;

  constructor(options: LocalTranslateOptions = {}) {
    this.options = options;
    this.engineLabel = `llm:${options.llmModel?.trim() || 'chat'}`;
  }

  async availability(): Promise<TranslatorAvailability> {
    if (this.options.localOnly) {
      return {
        available: false,
        provider: this.provider,
        engine: this.engineLabel,
        reason: 'privacy mode is local-only: TRANSLATE_PROVIDER=llm is disabled for this tenant',
      };
    }
    if (!this.options.chat) {
      return {
        available: false,
        provider: this.provider,
        engine: this.engineLabel,
        reason: 'no LLM chat function is configured (set a server LLM key or pass a chat function)',
      };
    }
    return { available: true, provider: this.provider, engine: this.engineLabel, model: this.options.llmModel };
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    if (this.options.localOnly) {
      throw new TranslationError('translation_local_only', 'privacy mode is local-only: refusing the LLM translator');
    }
    const availability = await this.availability();
    if (!availability.available) {
      throw new TranslationError('translation_unavailable', availability.reason ?? 'LLM translation is not configured');
    }
    const chat = this.options.chat;
    if (!chat) throw new TranslationError('translation_unavailable', 'LLM chat function is missing');
    const text = request.text.trim();
    if (!text) {
      return {
        text: '',
        sourceLang: request.sourceLang === 'auto' ? undefined : request.sourceLang,
        targetLang: request.targetLang,
        provider: this.provider,
        engine: this.engineLabel,
        latencyMs: 0,
      };
    }
    const startedAt = Date.now();
    const { source, target } = resolveDirection(request);
    const maxChars = Math.max(100, Math.min(8000, this.options.maxChars ?? 2000));
    const translated = await translateInChunks(text, maxChars, async (chunk) => {
      const raw = await chat(
        [
          {
            role: 'system',
            content:
              'You are a literal machine-translation engine. Translate the user text and output ONLY the translation, ' +
              'without quotes, comments or explanations. Preserve names, numbers and formatting. ' +
              'If the text is already in the target language, return it unchanged.',
          },
          {
            role: 'user',
            content: `Translate from ${source === 'ru' ? 'Russian' : 'English'} to ${target === 'ru' ? 'Russian' : 'English'}:\n\n${chunk}`,
          },
        ],
        { timeoutMs: this.options.timeoutMs ?? 20_000 },
      );
      return sanitizeTranslation(raw, chunk.length * 3);
    });
    return {
      text: translated,
      sourceLang: source,
      targetLang: target,
      provider: this.provider,
      engine: this.engineLabel,
      model: this.options.llmModel,
      latencyMs: Date.now() - startedAt,
    };
  }
}

/** Builds a translator for the requested provider; `none`/unknown returns null. */
export function createLocalTranslator(options: LocalTranslateOptions = {}): Translator | null {
  if (options.translatorImpl) return options.translatorImpl;
  const provider = options.provider ?? 'none';
  if (provider === 'none') return null;
  if (provider === 'fake') return new FakeTranslator();
  if (provider === 'llm') return new LlmTranslator(options);
  return new OpusMtTranslator(options);
}

/** Translates a batch of text segments, skipping empty/identical-language ones. */
export async function translateSegments(
  translator: Translator,
  segments: ReadonlyArray<{ text: string; lang?: string }>,
  targetLang: TranslationLanguage,
): Promise<Array<TranslationResult | null>> {
  const results: Array<TranslationResult | null> = [];
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) {
      results.push(null);
      continue;
    }
    const sourceLang = segment.lang === 'ru' || segment.lang === 'en' ? segment.lang : 'auto';
    if (sourceLang === targetLang) {
      results.push(null);
      continue;
    }
    results.push(await translator.translate({ text, sourceLang, targetLang }));
  }
  return results;
}
