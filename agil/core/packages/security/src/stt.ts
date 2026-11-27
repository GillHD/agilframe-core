/**
 * Server-side Speech-to-Text adapter (OpenAI-compatible `/audio/transcriptions`).
 *
 * Configuration (AGIL_STT_URL / AGIL_STT_KEY / AGIL_STT_MODEL):
 *   - `url`   — base URL, e.g. `https://api.openai.com/v1` (empty = not configured);
 *   - `key`   — bearer token, sent only in the Authorization header, never logged;
 *   - `model` — default `whisper-1`.
 *
 * When not configured `isConfigured()` returns false and `transcribe()` throws
 * `SecurityError('stt_not_configured')` (server maps it to HTTP 501).
 * The API key never appears in error messages.
 */
import type { SttResponse } from '@agil/protocol';
import { SecurityError } from './errors.js';

export interface SttServiceOptions {
  /** OpenAI-compatible base URL; empty/undefined means STT is disabled. */
  url?: string;
  /** Bearer API key (optional: local whisper servers may not need one). */
  key?: string;
  /** Model name (default `whisper-1`). */
  model?: string;
  /** Request timeout in milliseconds (default 30000, capped at 120000). */
  timeoutMs?: number;
  /** Fetch implementation override (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface TranscribeOptions {
  /** Audio MIME type from the upload (`audio/webm`, `audio/wav`, ...). */
  mime: string;
  /** Optional language hint: `ru`, `en`, `auto` (auto = omit). */
  language?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MODEL = 'whisper-1';

const MIME_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

const LANGUAGE_NAMES: Record<string, string> = {
  russian: 'ru',
  english: 'en',
  ru: 'ru',
  en: 'en',
};

function normalizeMime(mime: unknown): string {
  if (typeof mime !== 'string') return 'audio/webm';
  const bare = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  return bare.length > 0 ? bare : 'audio/webm';
}

function extensionForMime(mime: string): string {
  return MIME_EXTENSIONS[mime] ?? 'bin';
}

function normalizeLanguage(language: unknown): string | undefined {
  if (typeof language !== 'string') return undefined;
  const value = language.trim().toLowerCase();
  if (!value || value === 'auto') return undefined;
  const mapped = LANGUAGE_NAMES[value];
  if (mapped) return mapped;
  // Accept ru-RU / en-US style tags; keep exotic values only when short and safe.
  const primary = value.split(/[-_]/)[0] ?? '';
  if (/^[a-z]{2,3}$/.test(primary)) return primary;
  return undefined;
}

function normalizeResponseLanguage(language: unknown): string | undefined {
  if (typeof language !== 'string') return undefined;
  const value = language.trim();
  if (!value || value.length > 32) return undefined;
  const mapped = LANGUAGE_NAMES[value.toLowerCase()];
  if (mapped) return mapped;
  const primary = value.toLowerCase().split(/[-_]/)[0] ?? '';
  return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseSegments(raw: unknown): SttResponse['segments'] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const segments: NonNullable<SttResponse['segments']> = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (!text) continue;
    const start = typeof record.start === 'number' && Number.isFinite(record.start) ? record.start : 0;
    const end = typeof record.end === 'number' && Number.isFinite(record.end) ? record.end : start;
    segments.push({ start, end, text });
  }
  return segments.length > 0 ? segments : undefined;
}

/** Maps an untrusted provider payload onto the public `SttResponse` contract. */
function parseSttResponse(raw: unknown): SttResponse {
  const record = asRecord(raw);
  if (!record) throw new Error('stt: invalid JSON response (expected an object)');

  if (record.error !== undefined) {
    const message =
      typeof record.error === 'string'
        ? record.error
        : (() => {
            const nested = asRecord(record.error);
            return typeof nested?.message === 'string' ? nested.message : 'unknown provider error';
          })();
    throw new Error(`stt provider error: ${message}`);
  }

  const segments = parseSegments(record.segments);
  const text = typeof record.text === 'string' ? record.text.trim() : (segments?.map((s) => s.text).join(' ').trim() ?? '');

  const response: SttResponse = { text, provider: 'server' };
  const language = normalizeResponseLanguage(record.language);
  if (language) response.language = language;
  if (typeof record.duration === 'number' && Number.isFinite(record.duration) && record.duration >= 0) {
    response.durationSec = record.duration;
  }
  if (segments) response.segments = segments;
  return response;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

export class SttService {
  private readonly url: string;
  private readonly key: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SttServiceOptions = {}) {
    const options = opts && typeof opts === 'object' ? opts : {};
    this.url = typeof options.url === 'string' ? options.url.trim().replace(/\/+$/, '') : '';
    this.key = typeof options.key === 'string' ? options.key.trim() : '';
    this.model = typeof options.model === 'string' && options.model.trim() ? options.model.trim() : DEFAULT_MODEL;
    this.timeoutMs =
      Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0
        ? Math.min(MAX_TIMEOUT_MS, Math.floor(options.timeoutMs as number))
        : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** True when `AGIL_STT_URL` is set; `transcribe()` is available. */
  isConfigured(): boolean {
    return this.url.length > 0;
  }

  /** Model name that will be sent to the provider. */
  get modelName(): string {
    return this.model;
  }

  /**
   * Transcribes an audio buffer via POST `${url}/audio/transcriptions`
   * (multipart/form-data, OpenAI-compatible).
   *
   * @throws SecurityError `stt_not_configured` when no URL is configured;
   *         Error with a human-readable message on network/HTTP/provider errors.
   */
  async transcribe(audio: Buffer, opts: TranscribeOptions): Promise<SttResponse> {
    if (!this.isConfigured()) {
      throw new SecurityError('stt_not_configured', 'STT is not configured (AGIL_STT_URL is empty)');
    }
    if (!Buffer.isBuffer(audio)) {
      throw new Error('stt: audio must be a Buffer');
    }

    const mime = normalizeMime(opts?.mime);
    const language = normalizeLanguage(opts?.language);

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `audio.${extensionForMime(mime)}`);
    form.append('model', this.model);
    form.append('response_format', 'verbose_json');
    if (language) form.append('language', language);

    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.key) headers.authorization = `Bearer ${this.key}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}/audio/transcriptions`, {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'network error';
      throw new Error(`stt request failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await readErrorBody(response);
      throw new Error(`stt request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('stt: invalid JSON response');
    }

    const parsed = parseSttResponse(payload);
    if (!parsed.language && language) parsed.language = language;
    return parsed;
  }
}
