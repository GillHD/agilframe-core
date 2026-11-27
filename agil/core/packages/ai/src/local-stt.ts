/**
 * Local (on-box) speech-to-text adapter.
 *
 * Two engines are supported behind one interface:
 *   - **whisper.cpp** (`whisper-cli -m ggml-small.bin -oj ...`): per-chunk CLI
 *     invocation; audio must be WAV, so ffmpeg converts the browser's
 *     webm/opus chunks;
 *   - **faster-whisper** (CTranslate2): a long-lived Python worker keeps the
 *     model in RAM/VRAM.
 *
 * `FakeSttEngine` is a deterministic engine for tests and demos; it never
 * touches the filesystem or network. `createLocalSttEngine()` returns `null`
 * when STT is disabled, and an engine whose `availability()` explains every
 * missing piece otherwise — importing the package never fails because a model
 * is absent.
 *
 * Streaming: the server/widget protocol is *chunked*, not true streaming. The
 * widget sends ~8 s MediaRecorder chunks; callers pass `offsetSec` so segment
 * timestamps stay absolute.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import type { SttSegment } from '@agil/protocol';
import {
  LocalProcessError,
  dirExists,
  fileExists,
  findExecutable,
  findHfCachedModel,
  hasCTranslate2Weights,
  huggingFaceCacheDirs,
  convertToWav,
  JsonLineWorker,
  runProcess,
  withTempDir,
} from './local-support.js';

export type SttLanguage = 'ru' | 'en' | 'auto';
export type LocalSttEngineName = 'whisper-cpp' | 'faster-whisper' | 'fake';

export interface LocalSttSegment extends SttSegment {
  lang?: 'ru' | 'en';
}

export interface LocalSttRequest {
  audio: Buffer;
  /** MIME of the uploaded chunk (`audio/webm`, `audio/wav`, …). */
  mime: string;
  language?: SttLanguage;
  /** Seconds since call start added to every returned timestamp. */
  offsetSec?: number;
  /** Optional previous transcript tail used as a decoding prompt. */
  prompt?: string;
}

export interface LocalSttResult {
  text: string;
  language?: 'ru' | 'en';
  durationSec?: number;
  segments: LocalSttSegment[];
  engine: LocalSttEngineName;
  model: string;
  latencyMs: number;
  /** True for the deterministic fake engine. */
  fake?: boolean;
}

export interface SttAvailability {
  available: boolean;
  engine: LocalSttEngineName;
  model: string;
  /** Concrete model file/dir or worker label (never exposed by the admin API). */
  modelPath?: string;
  gpu?: boolean;
  /** Stable, path-free reason code (`model_missing`, `ffmpeg_missing`, …). */
  code?: string;
  /** True when ffmpeg is available for webm/opus → WAV conversion. */
  ffmpeg?: boolean;
  /** True when the engine is restricted to already-downloaded weights. */
  localFilesOnly?: boolean;
  /** Actionable caveat/reason. Never contains host paths. */
  reason?: string;
}

export interface LocalSttEngine {
  readonly name: LocalSttEngineName;
  readonly modelLabel: string;
  availability(): Promise<SttAvailability>;
  /**
   * Engine + weights readiness without transport prerequisites. Used by
   * `transcribe()` so raw `audio/wav` works even when ffmpeg is absent; falls
   * back to {@link availability} for engines that do not implement it.
   */
  modelAvailability?(): Promise<SttAvailability>;
  transcribe(request: LocalSttRequest): Promise<LocalSttResult>;
  dispose?(): Promise<void>;
}

export type LocalSttEnginePreference = 'whisper-cpp' | 'faster-whisper' | 'auto';

export interface LocalSttOptions {
  engine?: LocalSttEnginePreference;
  /** whisper.cpp binary (default `whisper-cli`, or its absolute path). */
  binary?: string;
  /** Path to a GGML model, e.g. `models/ggml-small.bin`. */
  modelPath?: string;
  /** faster-whisper model name (`small`, `medium`, …) or a local converted model dir. */
  model?: string;
  python?: string;
  /** Python worker script; defaults to the bundled `scripts/local/faster_whisper_worker.py`. */
  workerScript?: string;
  threads?: number;
  /** faster-whisper device: CUDA when true, CPU otherwise. */
  gpu?: boolean;
  timeoutMs?: number;
  ffmpegPath?: string;
  /**
   * Opt in to a one-time HuggingFace download when the faster-whisper weights
   * are not on disk. Off by default: a status probe and the first request never
   * touch the network without this flag (`AGIL_STT_ALLOW_DOWNLOAD=1`).
   */
  allowDownload?: boolean;
  /** Override the HuggingFace cache roots (tests / offline provisioning). */
  cacheDirs?: readonly string[];
  /** Injected engine (tests, custom runtime). Wins over every other option. */
  engineImpl?: LocalSttEngine;
}

const DEFAULT_WHISPER_BINARY = 'whisper-cli';
const DEFAULT_FASTER_WHISPER_MODEL = 'small';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_WORKER_SCRIPT = fileURLToPath(
  new URL('../scripts/local/faster_whisper_worker.py', import.meta.url),
);

/** `small`/`medium`/… map to the Systran CTranslate2 repositories. */
const FASTER_WHISPER_SIZES = new Set([
  'tiny',
  'tiny.en',
  'base',
  'base.en',
  'small',
  'small.en',
  'medium',
  'medium.en',
  'large-v1',
  'large-v2',
  'large-v3',
  'large-v3-turbo',
  'turbo',
  'distil-small.en',
  'distil-medium.en',
  'distil-large-v2',
  'distil-large-v3',
]);

export interface LocalModelResolution {
  /** `local` = weights found on disk, `download` = opt-in fetch, else missing. */
  state: 'local' | 'download' | 'missing' | 'incomplete';
  /** Basename-style label that is safe to return in status payloads. */
  label: string;
  /** Concrete local directory when `state === 'local'`. */
  path?: string;
}

/** HuggingFace repository id for a faster-whisper size name or explicit id. */
export function fasterWhisperRepoId(model: string): string {
  const value = model.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return value;
  if (FASTER_WHISPER_SIZES.has(value)) return `Systran/faster-whisper-${value}`;
  return value;
}

function modelLabelOf(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, '');
  return path.basename(trimmed) || trimmed || 'unknown';
}

function looksLikeLocalPath(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('.') || value.includes('\\');
}

/**
 * Resolves faster-whisper weights **without network access**.
 *
 * Order: an existing local directory (CTranslate2 `model.bin` required), then
 * the HuggingFace cache (`models--Systran--faster-whisper-*`). A missing cache
 * is only reported as `download` when `allowDownload` is explicitly true.
 */
export async function resolveFasterWhisperModel(
  model: string,
  options: { allowDownload?: boolean; cacheDirs?: readonly string[] } = {},
): Promise<LocalModelResolution> {
  const value = model.trim();
  const label = modelLabelOf(value);
  if (value && (await dirExists(value))) {
    return (await hasCTranslate2Weights(value))
      ? { state: 'local', label, path: value }
      : { state: 'incomplete', label };
  }
  if (looksLikeLocalPath(value)) return { state: 'missing', label };
  const repository = fasterWhisperRepoId(value);
  if (!repository) return { state: 'missing', label: 'unknown' };
  const cacheDirs = options.cacheDirs ?? huggingFaceCacheDirs();
  const cached = await findHfCachedModel(repository, ['model.bin'], [], cacheDirs);
  if (cached) return { state: 'local', label, path: cached };
  return options.allowDownload === true ? { state: 'download', label } : { state: 'missing', label };
}

/** Arguments for the persistent faster-whisper worker (local-only by default). */
export function fasterWhisperWorkerArgs(options: LocalSttOptions, modelArgument: string): string[] {
  const args = [
    options.workerScript?.trim() || DEFAULT_WORKER_SCRIPT,
    '--model',
    modelArgument,
    '--device',
    options.gpu ? 'cuda' : 'cpu',
    '--compute-type',
    options.gpu ? 'float16' : 'int8',
  ];
  if (options.allowDownload !== true) args.push('--local-files-only');
  return args;
}

/** ffmpeg executable used by both engines; `null` when it is not installed. */
function resolveFfmpeg(ffmpegPath: string | undefined): string | null {
  return findExecutable(ffmpegPath?.trim() || 'ffmpeg');
}

function normalizeLanguage(language: SttLanguage | undefined): SttLanguage {
  return language === 'ru' || language === 'en' ? language : 'auto';
}

function resultLanguage(value: unknown, fallback: SttLanguage): 'ru' | 'en' | undefined {
  if (value === 'ru' || value === 'en') return value;
  return fallback === 'auto' ? undefined : fallback;
}

function clampSegment(segment: { start: number; end: number; text: string }, offsetSec: number): LocalSttSegment | null {
  const text = segment.text.trim();
  if (!text) return null;
  const start = Math.max(0, (Number.isFinite(segment.start) ? segment.start : 0) + offsetSec);
  const end = Math.max(start, (Number.isFinite(segment.end) ? segment.end : 0) + offsetSec);
  return { start: roundSeconds(start), end: roundSeconds(end), text: text.slice(0, 4000) };
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function joinSegments(segments: readonly LocalSttSegment[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20_000);
}

/* ------------------------------------------------------------------ */
/* Fake engine (tests / demos)                                         */
/* ------------------------------------------------------------------ */

export interface FakeSttOptions {
  model?: string;
  segments?: LocalSttSegment[];
  text?: string;
  language?: 'ru' | 'en';
  /** Throw this message from `transcribe()` and report unavailable. */
  failWith?: string;
  /** Artificial latency (ms). */
  delayMs?: number;
}

/** Deterministic engine: returns the configured fixture and records calls. */
export class FakeSttEngine implements LocalSttEngine {
  readonly name = 'fake' as const;
  readonly modelLabel: string;
  readonly calls: LocalSttRequest[] = [];
  private readonly options: FakeSttOptions;

  constructor(options: FakeSttOptions = {}) {
    this.options = options;
    this.modelLabel = options.model ?? 'fake-small';
  }

  async availability(): Promise<SttAvailability> {
    return {
      available: !this.options.failWith,
      engine: this.name,
      model: this.modelLabel,
      ...(this.options.failWith ? { reason: this.options.failWith } : {}),
    };
  }

  async transcribe(request: LocalSttRequest): Promise<LocalSttResult> {
    this.calls.push(request);
    if (this.options.delayMs && this.options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }
    if (this.options.failWith) throw new Error(this.options.failWith);
    const offset = Math.max(0, request.offsetSec ?? 0);
    const configured = this.options.segments;
    const segments = configured
      ? configured
          .map((segment) => clampSegment(segment, offset))
          .filter((segment): segment is LocalSttSegment => segment !== null)
      : [{ start: offset, end: offset + 1, text: this.options.text ?? 'привет мир' }];
    const language = resultLanguage(this.options.language ?? request.language, normalizeLanguage(request.language));
    return {
      text: joinSegments(segments),
      ...(language ? { language } : {}),
      durationSec: segments.reduce((max, segment) => Math.max(max, segment.end), 0),
      segments,
      engine: this.name,
      model: this.modelLabel,
      latencyMs: 0,
      fake: true,
    };
  }
}

/* ------------------------------------------------------------------ */
/* whisper.cpp                                                         */
/* ------------------------------------------------------------------ */

interface WhisperCppJson {
  result?: { language?: unknown };
  transcription?: Array<{
    offsets?: { from?: unknown; to?: unknown };
    timestamps?: { from?: unknown; to?: unknown };
    text?: unknown;
  }>;
  segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }>;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number((match[4] ?? '0').padEnd(3, '0'));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function parseWhisperCppJson(raw: string, offsetSec: number): { segments: LocalSttSegment[]; language?: 'ru' | 'en' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LocalProcessError('invalid_output', 'whisper.cpp produced invalid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new LocalProcessError('invalid_output', 'whisper.cpp JSON is not an object');
  }
  const json = parsed as WhisperCppJson;
  const segments: LocalSttSegment[] = [];
  for (const entry of json.transcription ?? []) {
    const offsets = entry?.offsets;
    const timestamps = entry?.timestamps;
    let start: number | null =
      typeof offsets?.from === 'number' && Number.isFinite(offsets.from) ? offsets.from / 1000 : null;
    let end: number | null = typeof offsets?.to === 'number' && Number.isFinite(offsets.to) ? offsets.to / 1000 : null;
    if (start === null) start = parseTimestamp(timestamps?.from);
    if (end === null) end = parseTimestamp(timestamps?.to);
    const text = typeof entry?.text === 'string' ? entry.text : '';
    const segment = clampSegment({ start: start ?? 0, end: end ?? start ?? 0, text }, offsetSec);
    if (segment) segments.push(segment);
  }
  // Some forks emit `segments` with seconds instead of `transcription`.
  if (segments.length === 0) {
    for (const entry of json.segments ?? []) {
      const start = typeof entry?.start === 'number' ? entry.start : 0;
      const end = typeof entry?.end === 'number' ? entry.end : start;
      const text = typeof entry?.text === 'string' ? entry.text : '';
      const segment = clampSegment({ start, end, text }, offsetSec);
      if (segment) segments.push(segment);
    }
  }
  const detected = json.result?.language;
  const language = detected === 'ru' || detected === 'en' ? detected : undefined;
  return { segments, ...(language ? { language } : {}) };
}

export class WhisperCppEngine implements LocalSttEngine {
  readonly name = 'whisper-cpp' as const;
  readonly modelLabel: string;
  private readonly options: LocalSttOptions;

  constructor(options: LocalSttOptions = {}) {
    this.options = options;
    this.modelLabel = options.modelPath ? path.basename(options.modelPath) : 'ggml-small';
  }

  /**
   * Engine/weights readiness without transport prerequisites: a raw
   * `audio/wav` chunk is passed through even when `ffmpeg` is absent.
   */
  async modelAvailability(): Promise<SttAvailability> {
    const binary = findExecutable(this.options.binary?.trim() || DEFAULT_WHISPER_BINARY);
    if (!binary) {
      return {
        available: false,
        engine: this.name,
        model: this.modelLabel,
        code: 'binary_missing',
        reason: `whisper.cpp binary "${path.basename(this.options.binary?.trim() || DEFAULT_WHISPER_BINARY)}" was not found on PATH. Build whisper.cpp or set STT_LOCAL_BINARY.`,
      };
    }
    const modelPath = this.options.modelPath?.trim() ?? '';
    if (!modelPath) {
      return {
        available: false,
        engine: this.name,
        model: this.modelLabel,
        code: 'model_not_configured',
        reason: 'STT_LOCAL_MODEL_PATH is not set (expected a ggml-*.bin model from scripts/local/download-models.mjs).',
      };
    }
    if (!(await fileExists(modelPath))) {
      return {
        available: false,
        engine: this.name,
        model: this.modelLabel,
        code: 'model_missing',
        reason: `whisper.cpp model file not found: ${this.modelLabel}. Run scripts/local/download-models.mjs or fix STT_LOCAL_MODEL_PATH.`,
      };
    }
    return { available: true, engine: this.name, model: this.modelLabel, modelPath };
  }

  async availability(): Promise<SttAvailability> {
    const model = await this.modelAvailability();
    if (!model.available) return model;
    if (!resolveFfmpeg(this.options.ffmpegPath)) {
      return {
        ...model,
        available: true,
        ffmpeg: false,
        code: 'ffmpeg_missing',
        reason:
          'ffmpeg is not installed: browser webm/opus chunks cannot be converted to 16 kHz WAV. Install ffmpeg or set STT_LOCAL_FFMPEG (raw audio/wav chunks are still accepted).',
      };
    }
    return { ...model, ffmpeg: true };
  }

  async transcribe(request: LocalSttRequest): Promise<LocalSttResult> {
    // WAV chunks need no ffmpeg, so the transport check must not gate them.
    const availability = await this.modelAvailability();
    if (!availability.available || !availability.modelPath) {
      throw new LocalProcessError('not_found', availability.reason ?? 'whisper.cpp is not available');
    }
    const startedAt = Date.now();
    const language = normalizeLanguage(request.language);
    const binary = findExecutable(this.options.binary?.trim() || DEFAULT_WHISPER_BINARY);
    if (!binary) throw new LocalProcessError('not_found', 'whisper.cpp binary disappeared');
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const threads = Math.max(1, Math.min(32, Math.trunc(this.options.threads ?? 4)));

    return withTempDir('agil-stt-', async (dir) => {
      const wav = await convertToWav(request.audio, request.mime, {
        workDir: dir,
        ffmpegPath: this.options.ffmpegPath,
        timeoutMs,
      });
      const outputBase = path.join(dir, 'out');
      const args = [
        '-m',
        availability.modelPath as string,
        '-f',
        wav.file,
        '-oj',
        '-of',
        outputBase,
        '-l',
        language,
        '-t',
        String(threads),
      ];
      const result = await runProcess(binary, args, { timeoutMs });
      if (result.timedOut) throw new LocalProcessError('timeout', 'whisper.cpp transcription timed out');
      if (result.code !== 0) {
        throw new LocalProcessError(
          'failed',
          `whisper.cpp exited with code ${result.code}`,
          result.stderr.trim().slice(0, 400),
        );
      }
      const jsonText = await readFile(`${outputBase}.json`, 'utf8').catch(() => null);
      if (!jsonText) {
        throw new LocalProcessError(
          'invalid_output',
          'whisper.cpp did not produce the expected JSON output; check that the binary supports -oj',
        );
      }
      const parsed = parseWhisperCppJson(jsonText, Math.max(0, request.offsetSec ?? 0));
      const languageOut = resultLanguage(parsed.language ?? language, language);
      return {
        text: joinSegments(parsed.segments),
        ...(languageOut ? { language: languageOut } : {}),
        durationSec: parsed.segments.reduce((max, segment) => Math.max(max, segment.end), 0),
        segments: parsed.segments,
        engine: this.name,
        model: this.modelLabel,
        latencyMs: Date.now() - startedAt,
      };
    });
  }
}

/* ------------------------------------------------------------------ */
/* faster-whisper (persistent Python worker)                           */
/* ------------------------------------------------------------------ */

export class FasterWhisperEngine implements LocalSttEngine {
  readonly name = 'faster-whisper' as const;
  readonly modelLabel: string;
  private readonly options: LocalSttOptions;
  private worker: JsonLineWorker | null = null;
  private cachedModelAvailability: SttAvailability | null = null;
  private checkedAt = 0;

  constructor(options: LocalSttOptions = {}) {
    this.options = options;
    this.modelLabel = modelLabelOf(options.model?.trim() || DEFAULT_FASTER_WHISPER_MODEL);
  }

  private modelInput(): string {
    return this.options.model?.trim() || DEFAULT_FASTER_WHISPER_MODEL;
  }

  private pythonCommand(): string {
    return this.options.python?.trim() || (process.platform === 'win32' ? 'python' : 'python3');
  }

  private scriptPath(): string {
    return this.options.workerScript?.trim() || DEFAULT_WORKER_SCRIPT;
  }

  async modelAvailability(): Promise<SttAvailability> {
    if (this.cachedModelAvailability && Date.now() - this.checkedAt < 60_000) return this.cachedModelAvailability;
    const python = findExecutable(this.pythonCommand());
    if (!python) {
      return this.cache({
        available: false,
        engine: this.name,
        model: this.modelLabel,
        code: 'python_missing',
        reason: `Python executable "${path.basename(this.pythonCommand())}" was not found. Install Python 3 and faster-whisper, or set STT_LOCAL_PYTHON.`,
      });
    }
    const script = this.scriptPath();
    if (!(await fileExists(script))) {
      return this.cache({
        available: false,
        engine: this.name,
        model: this.modelLabel,
        code: 'worker_script_missing',
        reason: `faster-whisper worker script not found: ${path.basename(script)}. Set STT_LOCAL_WORKER or reinstall @agil/ai.`,
      });
    }
    const probe = await runProcess(
      python,
      ['-c', 'import faster_whisper, sys; sys.stdout.write(faster_whisper.__version__)'],
      { timeoutMs: 20_000 },
    ).catch((error: unknown) => {
      throw new LocalProcessError('failed', `cannot probe faster-whisper: ${String(error)}`);
    });
    if (probe.timedOut || probe.code !== 0) {
      return this.cache({
        available: false,
        engine: this.name,
        model: this.modelLabel,
        code: 'python_package_missing',
        reason:
          'Python package "faster_whisper" is not importable. Run: python -m pip install faster-whisper (see docs/stt-translation-local.md).',
      });
    }
    const resolution = await resolveFasterWhisperModel(this.modelInput(), {
      allowDownload: this.options.allowDownload === true,
      ...(this.options.cacheDirs ? { cacheDirs: this.options.cacheDirs } : {}),
    });
    if (resolution.state === 'missing' || resolution.state === 'incomplete') {
      return this.cache({
        available: false,
        engine: this.name,
        model: resolution.label,
        code: resolution.state === 'incomplete' ? 'model_incomplete' : 'model_missing',
        localFilesOnly: this.options.allowDownload !== true,
        reason:
          resolution.state === 'incomplete'
            ? `faster-whisper model "${resolution.label}" exists but has no CTranslate2 model.bin. Re-download the model weights.`
            : `faster-whisper model "${resolution.label}" is not present locally. Download it with scripts/local/download-models.mjs, point STT_LOCAL_MODEL at a local model directory, or set AGIL_STT_ALLOW_DOWNLOAD=1 to allow a one-time HuggingFace download.`,
      });
    }
    return this.cache({
      available: true,
      engine: this.name,
      model: resolution.label,
      modelPath: resolution.path ?? this.modelInput(),
      gpu: this.options.gpu === true,
      localFilesOnly: this.options.allowDownload !== true,
    });
  }

  async availability(): Promise<SttAvailability> {
    const model = await this.modelAvailability();
    if (!model.available) return model;
    if (!resolveFfmpeg(this.options.ffmpegPath)) {
      return {
        ...model,
        available: true,
        ffmpeg: false,
        code: 'ffmpeg_missing',
        localFilesOnly: this.options.allowDownload !== true,
        reason:
          'ffmpeg is not installed: browser webm/opus chunks cannot be converted to 16 kHz WAV. Install ffmpeg or set STT_LOCAL_FFMPEG (raw audio/wav chunks are still accepted).',
      };
    }
    return { ...model, ffmpeg: true };
  }

  private cache(availability: SttAvailability): SttAvailability {
    this.cachedModelAvailability = availability;
    this.checkedAt = Date.now();
    return availability;
  }

  private async getWorker(): Promise<JsonLineWorker> {
    if (this.worker?.isRunning()) return this.worker;
    const python = findExecutable(this.pythonCommand());
    if (!python) throw new LocalProcessError('not_found', `Python executable "${path.basename(this.pythonCommand())}" was not found`);
    const resolution = await resolveFasterWhisperModel(this.modelInput(), {
      allowDownload: this.options.allowDownload === true,
      ...(this.options.cacheDirs ? { cacheDirs: this.options.cacheDirs } : {}),
    });
    const modelArgument = resolution.state === 'local' && resolution.path ? resolution.path : this.modelInput();
    const args = fasterWhisperWorkerArgs(this.options, modelArgument);
    const localOnly = this.options.allowDownload !== true;
    this.worker = new JsonLineWorker(python, args, this.options.timeoutMs ?? 180_000, {
      ...(localOnly
        ? { env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } }
        : {}),
    });
    return this.worker;
  }

  async transcribe(request: LocalSttRequest): Promise<LocalSttResult> {
    // WAV chunks need no ffmpeg, so the transport check must not gate them.
    const availability = await this.modelAvailability();
    if (!availability.available) {
      throw new LocalProcessError('not_found', availability.reason ?? 'faster-whisper is not available');
    }
    const startedAt = Date.now();
    const language = normalizeLanguage(request.language);
    return withTempDir('agil-stt-fw-', async (dir) => {
      const wav = await convertToWav(request.audio, request.mime, {
        workDir: dir,
        ffmpegPath: this.options.ffmpegPath,
        timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      const worker = await this.getWorker();
      const response = await worker.request(
        {
          audio: wav.file,
          language: language === 'auto' ? null : language,
          offsetSec: Math.max(0, request.offsetSec ?? 0),
          prompt: request.prompt ?? '',
        },
        this.options.timeoutMs ?? 180_000,
      );
      const rawSegments = Array.isArray(response.segments) ? response.segments : [];
      const offset = Math.max(0, request.offsetSec ?? 0);
      const segments: LocalSttSegment[] = [];
      for (const entry of rawSegments) {
        if (typeof entry !== 'object' || entry === null) continue;
        const record = entry as Record<string, unknown>;
        const text = typeof record.text === 'string' ? record.text : '';
        const start = typeof record.start === 'number' ? record.start : 0;
        const end = typeof record.end === 'number' ? record.end : start;
        const segment = clampSegment({ start, end, text }, offset);
        if (segment) segments.push(segment);
      }
      const detected = response.language;
      const languageOut = resultLanguage(detected ?? language, language);
      return {
        text: joinSegments(segments),
        ...(languageOut ? { language: languageOut } : {}),
        durationSec:
          typeof response.durationSec === 'number' && Number.isFinite(response.durationSec)
            ? response.durationSec
            : segments.reduce((max, segment) => Math.max(max, segment.end), 0),
        segments,
        engine: this.name,
        model: this.modelLabel,
        latencyMs: Date.now() - startedAt,
      };
    });
  }

  async dispose(): Promise<void> {
    this.worker?.stop();
    this.worker = null;
  }
}

/**
 * Builds the configured local engine. Returns a `FakeSttEngine` when
 * `engineImpl` is injected, never throws for a missing binary/model — ask
 * `availability()` for the actionable reason.
 */
export function createLocalSttEngine(options: LocalSttOptions = {}): LocalSttEngine {
  if (options.engineImpl) return options.engineImpl;
  const requested = options.engine ?? 'auto';
  if (requested === 'whisper-cpp') return new WhisperCppEngine(options);
  if (requested === 'faster-whisper') return new FasterWhisperEngine(options);
  // auto: prefer whichever engine has explicit configuration.
  if (options.modelPath?.trim()) return new WhisperCppEngine(options);
  if (options.model?.trim() || options.python?.trim()) return new FasterWhisperEngine(options);
  return new WhisperCppEngine(options);
}

/** Human-readable label for status/health payloads. */
export function describeEngine(engine: LocalSttEngine): string {
  return `${engine.name}:${engine.modelLabel}`;
}
