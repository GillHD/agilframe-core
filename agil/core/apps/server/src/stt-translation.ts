/**
 * Local STT + translation service for the server.
 *
 * Wraps the optional `@agil/ai` engines (whisper.cpp / faster-whisper / OPUS-MT)
 * with everything the REST/WS layer needs:
 *   - tenant policy: `session.transcription.translateTo`, consent, retention;
 *   - a serialized translation queue (one CPU-heavy job at a time by default);
 *   - honest status objects for admins (no secrets, actionable reasons);
 *   - failure isolation: a missing model/binary never breaks startup, and a
 *     translation failure never discards a transcript.
 *
 * Privacy: `PRIVACY_MODE=local` refuses every external path. `TRANSLATE_PROVIDER=llm`
 * additionally requires explicit `TRANSLATE_LLM_*` configuration.
 */
import {
  UniversalLlmClient,
  TranslationError,
  createLocalSttEngine,
  createLocalTranslator,
  detectLanguage,
  describeEngine,
  type LocalSttEngine,
  type LocalSttResult,
  type TranslationLanguage,
  type Translator,
  type TranslatorAvailability,
} from '@agil/ai';
import type { SttResponse, SttSegment, TenantConfig, TranscriptSegment, TranscriptTranslation } from '@agil/protocol';
import type { Env } from './env.js';
import type { Logger } from './logger.js';

export type TranscriptTranslationTarget = 'none' | 'ru' | 'en';

export interface SttTranslationStatus {
  privacyMode: Env['privacyMode'];
  stt: {
    provider: Env['sttProvider'];
    configured: boolean;
    local: boolean;
    engine?: string;
    available?: boolean;
    model?: string;
    /** Stable, path-free reason code (`model_missing`, `ffmpeg_missing`, …). */
    code?: string;
    ffmpeg?: boolean;
    localFilesOnly?: boolean;
    reason?: string;
  };
  translation: {
    provider: Env['translateProvider'];
    configured: boolean;
    available?: boolean;
    engine?: string;
    model?: string;
    code?: string;
    localFilesOnly?: boolean;
    nonCommercial?: boolean;
    reason?: string;
  };
  consent: { required: boolean; retentionSec: number };
  caveats: string[];
}

export class SttTranslationError extends Error {
  readonly code:
    | 'stt_not_configured'
    | 'stt_unavailable'
    | 'stt_failed'
    | 'translation_not_configured'
    | 'translation_unavailable'
    | 'translation_failed'
    | 'translation_local_only'
    | 'translation_too_long'
    | 'ffmpeg_missing'
    | 'consent_required';
  readonly status: number;

  constructor(code: SttTranslationError['code'], message: string, status?: number) {
    super(message);
    this.name = 'SttTranslationError';
    this.code = code;
    this.status = status ?? (code === 'consent_required' ? 403 : code === 'translation_too_long' ? 413 : 422);
  }
}

interface TranslateJob {
  tenantId: string;
  text: string;
  sourceLang?: TranslationLanguage;
  targetLang: TranslationLanguage;
}

interface CachedTranslation {
  text: string;
  provider: Translator['provider'];
  engine?: string;
  expiresAt: number;
}

/** Dedupe window for identical translation jobs (server STT + WS caption). */
const TRANSLATION_CACHE_TTL_MS = 60_000;
const TRANSLATION_CACHE_MAX_ENTRIES = 256;

const TRANSLATION_NOTICE =
  'Machine translation (local model). Names, numbers and overlapping speech may be wrong; do not treat it as human-quality.';

/** Upper bound for a public status/error reason (documents stay readable). */
const MAX_PUBLIC_REASON = 400;

/**
 * Defence in depth for `/v1/admin/stt` and error messages: real adapters only
 * emit basenames, but an injected/custom engine must never be able to leak an
 * absolute path, a model directory or a username through a reason string.
 */
export function sanitizePublicReason(input: unknown, maxLength = MAX_PUBLIC_REASON): string {
  let value = typeof input === 'string' ? input : String(input ?? '');
  value = value.replace(/\s+/g, ' ').trim();
  // Windows drive paths (C:\..., C:/...), including spaces in directory names.
  // The lookbehind keeps URL schemes such as `https://` intact.
  value = value.replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^"'<>|\r\n]*/g, '<path>');
  // UNC paths (\\server\share\...).
  value = value.replace(/\\\\[^"'<>|\r\n]*/g, '<path>');
  // POSIX absolute paths with at least two components (/home/user/models/...).
  // Known API route prefixes are preserved so error messages can still name an
  // endpoint (`POST /v1/rooms/...`), while filesystem paths are redacted.
  value = value.replace(
    /(^|[\s("'=])\/(?!v1\/|docs\/|scim\/|api\/|admin\/|openapi|health\b|ice\b|ws\b|mcp\b|metrics\b)(?:[^\s"'<>|/]+\/)+[^\s"'<>|]*/g,
    (_match, prefix: string) => `${prefix}<path>`,
  );
  return value.slice(0, maxLength);
}

function isTarget(value: unknown): value is 'ru' | 'en' {
  return value === 'ru' || value === 'en';
}

/** Builds the optional LLM chat function for TRANSLATE_PROVIDER=llm. */
function buildLlmChat(
  env: Env,
): ((messages: Array<{ role: 'system' | 'user'; content: string }>, options?: { timeoutMs?: number }) => Promise<string>) | undefined {
  if (env.privacyMode === 'local') return undefined;
  if (!env.translateLlmKey && !env.translateLlmUrl) return undefined;
  const client = new UniversalLlmClient({
    ...(env.translateLlmProvider ? { provider: env.translateLlmProvider } : {}),
    ...(env.translateLlmUrl ? { endpoint: env.translateLlmUrl } : {}),
    ...(env.translateLlmKey ? { apiKey: env.translateLlmKey } : {}),
    ...(env.translateLlmModel ? { model: env.translateLlmModel } : {}),
    timeoutMs: env.translateLlmTimeoutMs,
    maxRetries: 0,
  });
  return async (messages) => {
    const result = await client.chat({ messages, temperature: 0.1, maxTokens: 1024 });
    return result.text;
  };
}

export interface SttTranslationServiceOptions {
  env: Env;
  logger: Logger;
  getConfig: (tenantId: string) => TenantConfig;
  /** Injected engine (tests, self-hosted runtime). Wins over the env-built engine. */
  engineImpl?: LocalSttEngine;
  /** Injected translator (tests, self-hosted runtime). Wins over the env-built one. */
  translatorImpl?: Translator;
}

export class SttTranslationService {
  private readonly env: Env;
  private readonly logger: Logger;
  private readonly getConfig: (tenantId: string) => TenantConfig;
  private readonly engine: LocalSttEngine | null;
  private readonly translator: Translator | null;
  /** Serializes translation jobs so one CPU core is not oversubscribed. */
  private translateChain: Promise<unknown> = Promise.resolve();
  /** Recent translations, so the REST result and the WS caption frame do not translate twice. */
  private readonly translationCache = new Map<string, CachedTranslation>();
  private readonly sttSlots = 2;
  private sttActive = 0;
  private readonly sttWaiters: Array<() => void> = [];

  constructor(options: SttTranslationServiceOptions) {
    this.env = options.env;
    this.logger = options.logger;
    this.getConfig = options.getConfig;
    this.engine =
      options.env.sttProvider === 'local'
        ? (options.engineImpl ??
          createLocalSttEngine({
            engine: options.env.sttLocalEngine,
            binary: options.env.sttLocalBinary,
            modelPath: options.env.sttLocalModelPath,
            model: options.env.sttLocalModel,
            python: options.env.sttLocalPython,
            ...(options.env.sttLocalWorker ? { workerScript: options.env.sttLocalWorker } : {}),
            threads: options.env.sttLocalThreads,
            gpu: options.env.sttLocalGpu,
            timeoutMs: options.env.sttLocalTimeoutMs,
            ...(options.env.sttLocalFfmpeg ? { ffmpegPath: options.env.sttLocalFfmpeg } : {}),
            allowDownload: options.env.localModelsAllowDownload,
          }))
        : null;
    this.translator =
      options.env.translateProvider === 'none'
        ? null
        : (options.translatorImpl ??
          createLocalTranslator({
            provider: options.env.translateProvider,
            engine: options.env.translateLocalEngine,
            modelDir: options.env.translateLocalModelDir,
            ...(options.env.translateLocalModel ? { modelName: options.env.translateLocalModel } : {}),
            python: options.env.translateLocalPython,
            ...(options.env.translateLocalWorker ? { workerScript: options.env.translateLocalWorker } : {}),
            timeoutMs: options.env.translateLocalTimeoutMs,
            gpu: options.env.translateLocalGpu,
            maxChars: options.env.translateLocalMaxChars,
            localOnly: options.env.privacyMode === 'local',
            ...(options.env.translateProvider === 'llm' ? { chat: buildLlmChat(options.env) } : {}),
            ...(options.env.translateLlmModel ? { llmModel: options.env.translateLlmModel } : {}),
          }));
  }

  /* ------------------------------- policy ------------------------------- */

  get sttProvider(): Env['sttProvider'] {
    return this.env.sttProvider;
  }

  get usesLocalStt(): boolean {
    return this.engine !== null;
  }

  get translationProvider(): Env['translateProvider'] {
    return this.env.translateProvider;
  }

  translationTarget(tenantId: string, override?: unknown): TranscriptTranslationTarget {
    // The tenant feature flag is a server-side gate: a client header must never
    // re-enable translation that the tenant explicitly disabled.
    if (this.getConfig(tenantId).features.translation !== true) return 'none';
    if (override === 'none' || override === 'ru' || override === 'en') return override;
    const configured = this.getConfig(tenantId).session.transcription.translateTo;
    return configured === 'ru' || configured === 'en' ? configured : 'none';
  }

  translationEnabled(tenantId: string): boolean {
    return this.translator !== null && this.translationTarget(tenantId) !== 'none';
  }

  consentRequired(tenantId: string): boolean {
    return this.getConfig(tenantId).session.transcription.consentRequired || this.env.transcriptConsentRequired;
  }

  retentionSec(tenantId: string): number {
    const configured = this.getConfig(tenantId).session.transcription.retentionSec;
    return configured > 0 ? configured : this.env.transcriptRetentionSec;
  }

  /** True when the local STT engine (not remote) is configured. */
  isLocalSttConfigured(): boolean {
    return this.engine !== null;
  }

  translationEngineLabel(): string {
    return this.translator?.engineLabel ?? 'none';
  }

  /** True when the configured local MT engine is NLLB-200 (CC-BY-NC-4.0). */
  translationUsesNcModel(): boolean {
    if (this.translator?.provider !== 'local') return false;
    const label = this.translator.engineLabel;
    return this.env.translateLocalEngine === 'nllb' || label === 'nllb' || label.startsWith('nllb:');
  }

  /* -------------------------------- STT --------------------------------- */

  private async acquireSttSlot(): Promise<() => void> {
    if (this.sttActive < this.sttSlots) {
      this.sttActive += 1;
      return () => this.releaseSttSlot();
    }
    await new Promise<void>((resolve) => this.sttWaiters.push(resolve));
    this.sttActive += 1;
    return () => this.releaseSttSlot();
  }

  private releaseSttSlot(): void {
    this.sttActive = Math.max(0, this.sttActive - 1);
    const next = this.sttWaiters.shift();
    if (next) next();
  }

  /**
   * Transcribes one audio chunk with the local engine and (optionally) attaches
   * machine translations to every segment. Throws {@link SttTranslationError}
   * only when STT itself cannot run; translation degradation is reported in
   * `notice` instead of losing the transcript.
   */
  async transcribe(input: {
    tenantId: string;
    audio: Buffer;
    mime: string;
    language?: 'ru' | 'en' | 'auto';
    translateTo?: unknown;
    offsetSec?: number;
  }): Promise<SttResponse> {
    if (!this.engine) {
      throw new SttTranslationError(
        'stt_not_configured',
        'Local STT is disabled. Set STT_PROVIDER=local with STT_LOCAL_MODEL_PATH (docs/stt-translation-local.md).',
        501,
      );
    }
    // WAV chunks need no ffmpeg, so gate on engine/weights readiness, not on
    // the transport prerequisite reported by `availability()`.
    const availability = this.engine.modelAvailability
      ? await this.engine.modelAvailability()
      : await this.engine.availability();
    if (!availability.available) {
      throw new SttTranslationError(
        'stt_not_configured',
        sanitizePublicReason(availability.reason ?? 'Local STT is not available on this host.'),
        501,
      );
    }
    const release = await this.acquireSttSlot();
    let result: LocalSttResult;
    try {
      result = await this.engine.transcribe({
        audio: input.audio,
        mime: input.mime,
        language: input.language ?? 'auto',
        offsetSec: input.offsetSec ?? 0,
      });
    } catch (error) {
      if (error instanceof SttTranslationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('local stt failed', { engine: this.engine.name, error: message });
      if ((error as { code?: string }).code === 'ffmpeg_missing') {
        throw new SttTranslationError(
          'ffmpeg_missing',
          sanitizePublicReason(`Local STT conversion failed: ${message}`, 300),
          501,
        );
      }
      throw new SttTranslationError(
        'stt_failed',
        sanitizePublicReason(`Local STT failed: ${message}`, 300),
        502,
      );
    } finally {
      release();
    }

    const segments: SttSegment[] = result.segments.map((segment) => ({
      start: segment.start,
      end: segment.end,
      text: segment.text,
      ...(segment.lang ? { lang: segment.lang } : {}),
    }));
    if (segments.length === 0 && result.text.trim()) {
      segments.push({ start: 0, end: result.durationSec ?? 0, text: result.text.trim().slice(0, 4000) });
    }

    const config = this.getConfig(input.tenantId);
    const featureEnabled = config.features.translation === true;
    const configuredTarget = config.session.transcription.translateTo;
    const target = this.translationTarget(input.tenantId, input.translateTo);
    const translator = this.translator;
    let translatedCount = 0;
    let translationEngine: string | undefined;
    let notice: string | undefined;
    let translationSummary: SttResponse['translation'] | undefined;
    if (
      target === 'none' &&
      !featureEnabled &&
      this.env.translateProvider !== 'none' &&
      (configuredTarget === 'ru' ||
        configuredTarget === 'en' ||
        input.translateTo === 'ru' ||
        input.translateTo === 'en')
    ) {
      notice = 'Translation is disabled for this tenant (features.translation=false); returning the original-language transcript.';
    }
    if (target !== 'none' && translator) {
      try {
        const availability = await translator.availability();
        if (!availability.available) {
          notice = `Translation is unavailable: ${sanitizePublicReason(availability.reason ?? 'engine not ready')}. The transcript is original-language only.`;
        } else {
          translationEngine = translator.engineLabel;
          for (const segment of segments) {
            if (segment.lang === target) continue;
            try {
              const translated = await this.scheduleTranslation({
                tenantId: input.tenantId,
                text: segment.text,
                ...(segment.lang === 'ru' || segment.lang === 'en' ? { sourceLang: segment.lang } : {}),
                targetLang: target,
              });
              if (translated) {
                segment.translation = {
                  text: translated.text,
                  lang: target,
                  provider: translated.provider,
                  ...(translated.engine ? { engine: translated.engine } : {}),
                };
                translatedCount += 1;
              }
            } catch (error) {
              this.logger.warn('segment translation failed', {
                engine: translator.engineLabel,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          if (translatedCount === 0 && target !== result.language) {
            notice = `Translation returned no text (engine ${translator.engineLabel}).`;
          }
          if (translatedCount > 0) {
            translationSummary = {
              targetLang: target,
              provider: translator.provider,
              ...(translationEngine ? { engine: translationEngine } : {}),
            };
          }
        }
      } catch (error) {
        notice = `Translation failed: ${sanitizePublicReason(error instanceof Error ? error.message : String(error))}. The transcript is original-language only.`;
      }
    }

    return {
      text: result.text,
      provider: 'local',
      ...(result.language ? { language: result.language } : input.language && input.language !== 'auto' ? { language: input.language } : {}),
      ...(result.durationSec !== undefined ? { durationSec: result.durationSec } : {}),
      segments,
      engine: describeEngine(this.engine),
      model: result.model,
      local: availability.engine !== 'fake',
      ...(translationSummary ? { translation: translationSummary } : {}),
      ...(translatedCount > 0 ? { notice: TRANSLATION_NOTICE } : notice ? { notice } : {}),
    };
  }

  /* ----------------------------- translation ----------------------------- */

  /** Serialized translation; rejects with a `TranslationError` on engine failure. */
  private scheduleTranslation(job: TranslateJob): Promise<{
    text: string;
    provider: Translator['provider'];
    engine?: string;
  } | null> {
    const run = async (): Promise<{ text: string; provider: Translator['provider']; engine?: string } | null> => {
      const translator = this.translator;
      if (!translator) return null;
      // Server STT already translated this text a moment ago; the WS caption
      // frame for the same segment must not pay for a second engine pass.
      const cached = this.readTranslationCache(job);
      if (cached) return cached;
      const result = await translator.translate({
        text: job.text,
        targetLang: job.targetLang,
        ...(job.sourceLang ? { sourceLang: job.sourceLang } : {}),
      });
      if (!result.text.trim()) return null;
      const translated = {
        text: result.text,
        provider: translator.provider,
        ...(result.engine ? { engine: result.engine } : {}),
      };
      this.writeTranslationCache(job, translated);
      return translated;
    };
    const next = this.translateChain.then(run, run);
    this.translateChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private translationCacheKey(job: TranslateJob): string {
    // `auto` and an explicit language that resolves to the same pair are the
    // same job: the STT response omits `lang`, the WS caption carries it.
    const source = job.sourceLang ?? detectLanguage(job.text);
    return `${job.tenantId}\u0000${job.targetLang}\u0000${source}\u0000${job.text}`;
  }

  private readTranslationCache(job: TranslateJob): { text: string; provider: Translator['provider']; engine?: string } | null {
    const key = this.translationCacheKey(job);
    const hit = this.translationCache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.translationCache.delete(key);
      return null;
    }
    return {
      text: hit.text,
      provider: hit.provider,
      ...(hit.engine ? { engine: hit.engine } : {}),
    };
  }

  private writeTranslationCache(
    job: TranslateJob,
    value: { text: string; provider: Translator['provider']; engine?: string },
  ): void {
    if (this.translationCache.size >= TRANSLATION_CACHE_MAX_ENTRIES) {
      const oldest = this.translationCache.keys().next().value;
      if (oldest !== undefined) this.translationCache.delete(oldest);
    }
    this.translationCache.set(this.translationCacheKey(job), {
      ...value,
      expiresAt: Date.now() + TRANSLATION_CACHE_TTL_MS,
    });
  }

  /**
   * Drops the translation dedupe cache after consent withdrawal or an admin
   * transcript purge: cached text must not outlive the erased transcript.
   */
  clearTranslationCache(): void {
    this.translationCache.clear();
  }

  /**
   * Translates one transcript/caption line for the live WS pipeline.
   * Returns `null` when translation is disabled or would be a no-op.
   */
  async translateCaption(input: {
    tenantId: string;
    text: string;
    sourceLang?: 'ru' | 'en';
    targetLang?: unknown;
  }): Promise<TranscriptTranslation | null> {
    const text = input.text.trim();
    if (!text || !this.translator) return null;
    const target = this.translationTarget(input.tenantId, input.targetLang);
    if (target === 'none') return null;
    const source = input.sourceLang;
    if (source === target) return null;
    if (text.length > 4000) {
      throw new SttTranslationError('translation_too_long', 'caption exceeds the 4000 character translation limit', 413);
    }
    const availability = await this.translator.availability();
    if (!availability.available) {
      throw new SttTranslationError(
        'translation_unavailable',
        sanitizePublicReason(availability.reason ?? 'translation engine is not available'),
        503,
      );
    }
    const translated = await this.scheduleTranslation({
      tenantId: input.tenantId,
      text,
      ...(source ? { sourceLang: source } : {}),
      targetLang: target,
    });
    if (!translated) return null;
    return {
      text: translated.text,
      lang: target,
      provider: translated.provider,
      ...(translated.engine ? { engine: translated.engine } : {}),
    };
  }

  /** Explicit text translation endpoint helper (tenant policy still applies). */
  async translateText(input: {
    tenantId: string;
    text: string;
    targetLang?: unknown;
    sourceLang?: unknown;
  }): Promise<{ translation: TranscriptTranslation; notice: string }> {
    if (!this.translator) {
      throw new SttTranslationError(
        'translation_not_configured',
        'Translation is disabled (TRANSLATE_PROVIDER=none).',
        501,
      );
    }
    const translation = await this.translateCaption({
      tenantId: input.tenantId,
      text: input.text,
      ...(input.sourceLang === 'ru' || input.sourceLang === 'en' ? { sourceLang: input.sourceLang } : {}),
      targetLang: input.targetLang,
    });
    if (!translation) {
      if (this.translationTarget(input.tenantId, input.targetLang) === 'none') {
        throw new SttTranslationError(
          'translation_not_configured',
          'Translation into the requested language is disabled for this tenant.',
          501,
        );
      }
      throw new SttTranslationError('translation_failed', 'Translation produced no text', 502);
    }
    return { translation, notice: TRANSLATION_NOTICE };
  }

  /* ------------------------------- status ------------------------------- */

  /** Admin status: never includes paths of secrets/keys; reasons are actionable. */
  async status(): Promise<SttTranslationStatus> {
    let sttAvailability: Awaited<ReturnType<LocalSttEngine['availability']>> | null = null;
    if (this.engine) {
      try {
        sttAvailability = await this.engine.availability();
      } catch (error) {
        sttAvailability = {
          available: false,
          engine: this.engine.name,
          model: sanitizePublicReason(this.engine.modelLabel, 120),
          code: 'availability_probe_failed',
          reason: sanitizePublicReason(error instanceof Error ? error.message : String(error)),
        };
      }
    }
    let translationAvailability: TranslatorAvailability | null = null;
    if (this.translator) {
      try {
        translationAvailability = await this.translator.availability();
      } catch (error) {
        translationAvailability = {
          available: false,
          provider: this.translator.provider,
          engine: sanitizePublicReason(this.translator.engineLabel, 160),
          code: 'availability_probe_failed',
          reason: sanitizePublicReason(error instanceof Error ? error.message : String(error)),
        };
      }
    }
    const remoteConfigured = Boolean(this.env.sttUrl);
    const privacyBlocked = this.env.privacyMode === 'local' && this.env.sttProvider === 'remote';
    const sttConfigured =
      this.env.sttProvider === 'local'
        ? Boolean(sttAvailability?.available)
        : this.env.sttProvider === 'remote'
          ? remoteConfigured && !privacyBlocked
          : false;
    const nllb = this.translationUsesNcModel();
    const caveats = [
      'Baseline small models: expect errors on names, numbers, accents and overlapping speech.',
      'This is not a replacement for a paid ASR service and is not human-quality translation.',
      'Model files are not bundled; download them with scripts/local/download-models.mjs. Local translation loads only files already on disk.',
    ];
    if (this.env.localModelsAllowDownload) {
      caveats.push(
        'Automatic STT model download is enabled (AGIL_STT_ALLOW_DOWNLOAD=1): the first request may fetch missing weights from HuggingFace.',
      );
    } else {
      caveats.push(
        'STT weights are never downloaded automatically unless AGIL_STT_ALLOW_DOWNLOAD=1.',
      );
    }
    if (nllb) {
      caveats.push('NLLB-200 (CC-BY-NC-4.0) has been retired. Migrate this installation to the offline OPUS-MT pair.');
    }
    return {
      privacyMode: this.env.privacyMode,
      stt: {
        provider: this.env.sttProvider,
        configured: sttConfigured,
        local: this.env.sttProvider === 'local',
        ...(this.engine ? { engine: sanitizePublicReason(describeEngine(this.engine), 160) } : {}),
        ...(sttAvailability ? { available: sttAvailability.available } : {}),
        ...(sttAvailability?.model ? { model: sanitizePublicReason(sttAvailability.model, 120) } : {}),
        ...(sttAvailability?.code ? { code: sttAvailability.code } : {}),
        ...(sttAvailability?.ffmpeg !== undefined ? { ffmpeg: sttAvailability.ffmpeg } : {}),
        ...(sttAvailability?.localFilesOnly !== undefined ? { localFilesOnly: sttAvailability.localFilesOnly } : {}),
        ...(privacyBlocked
          ? { reason: 'PRIVACY_MODE=local allows only STT_PROVIDER=local; remote STT is disabled.' }
          : sttAvailability?.reason
            ? { reason: sanitizePublicReason(sttAvailability.reason) }
            : {}),
      },
      translation: {
        provider: this.env.translateProvider,
        configured: Boolean(translationAvailability?.available),
        ...(translationAvailability
          ? {
              available: translationAvailability.available,
              engine: sanitizePublicReason(translationAvailability.engine, 160),
              ...(translationAvailability.model
                ? { model: sanitizePublicReason(translationAvailability.model, 120) }
                : {}),
              ...(translationAvailability.code ? { code: translationAvailability.code } : {}),
              ...(translationAvailability.localFilesOnly !== undefined
                ? { localFilesOnly: translationAvailability.localFilesOnly }
                : {}),
              ...(nllb || translationAvailability.nonCommercial ? { nonCommercial: true } : {}),
              ...(translationAvailability.reason
                ? { reason: sanitizePublicReason(translationAvailability.reason) }
                : {}),
            }
          : {}),
      },
      consent: {
        required: this.env.transcriptConsentRequired,
        retentionSec: this.env.transcriptRetentionSec,
      },
      caveats,
    };
  }

  /** Best-effort cleanup on server shutdown (kills persistent Python workers). */
  async close(): Promise<void> {
    await this.translator?.dispose?.().catch(() => undefined);
    await this.engine?.dispose?.().catch(() => undefined);
  }
}

export { TRANSLATION_NOTICE };
