/**
 * Universal LLM client: one `chat()` API over three provider families.
 *
 *   - `openai-compatible` — OpenAI, Azure OpenAI, OpenRouter, Together, vLLM,
 *     LM Studio, Ollama in OpenAI mode (`/v1/chat/completions`);
 *   - `anthropic` — Anthropic Messages API (`/v1/messages`);
 *   - `ollama` — native Ollama chat API (`/api/chat`).
 *
 * Provider callers map the returned text onto their own contract; see
 * `agil/core/docs/llm-integrations.md` §2.1 and `agil/core/docs/in-call-agent.md`.
 *
 * Configuration comes from constructor options or environment:
 *   `AGIL_LLM_PROVIDER`, `AGIL_LLM_URL`, `AGIL_LLM_KEY`, `AGIL_LLM_MODEL`.
 *
 * Safety: timeouts via `AbortController`, retries only for network/timeout/5xx,
 * provider responses are untrusted, and API keys are redacted from errors.
 * This module never logs.
 */
import { clampInt } from './webhook-transport.js';

export type LlmProvider = 'openai-compatible' | 'anthropic' | 'ollama';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmChatRequest {
  messages: LlmMessage[];
  /** Ask the provider for a JSON object (`response_format`/`format`/prompt hint). */
  jsonMode?: boolean;
  /** Default 1024; clamped to 1..32000. */
  maxTokens?: number;
  /** Clamped to 0..2; omitted when not provided. */
  temperature?: number;
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LlmChatResult {
  /** Assistant text, joined from the provider response. */
  text: string;
  /** Raw parsed provider response (untrusted data, useful for gateway mapping). */
  raw: unknown;
  usage?: LlmUsage;
}

export type LlmErrorCode =
  | 'not_configured'
  | 'invalid_request'
  | 'timeout'
  | 'network'
  | 'http'
  | 'invalid_response'
  | 'empty_response';

/** Error raised by `UniversalLlmClient.chat()`. Messages never contain secrets. */
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(code: LlmErrorCode, message: string, options: { retryable?: boolean; status?: number } = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.status !== undefined) this.status = options.status;
  }
}

export interface UniversalLlmClientOptions {
  /** Default: `AGIL_LLM_PROVIDER` or `'openai-compatible'`. */
  provider?: LlmProvider;
  /** Base URL (the client appends the provider path). Default: `AGIL_LLM_URL`. */
  endpoint?: string;
  /** API key. Default: `AGIL_LLM_KEY`. Not required for local Ollama. */
  apiKey?: string;
  /** Model id. Default: `AGIL_LLM_MODEL` or a provider default. */
  model?: string;
  /** Default 30000 ms. */
  timeoutMs?: number;
  /** Retries after the first attempt; default 1. */
  maxRetries?: number;
  /** Extra HTTP headers merged into provider headers (e.g. tenancy headers). */
  extraHeaders?: Record<string, string>;
}

const PROVIDER_DEFAULTS: Record<LlmProvider, { baseUrl: string; model: string }> = {
  'openai-compatible': { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-sonnet-latest' },
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:7b' },
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_MAX_TOKENS = 1024;
const RETRY_DELAY_MS = 100;
const MAX_ERROR_TEXT = 300;
const ANTHROPIC_VERSION = '2023-06-01';
const JSON_MODE_HINT = 'Respond with a single valid JSON object only, no prose, no markdown fences.';

function envString(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function resolveProvider(value: string | undefined): LlmProvider {
  if (value === 'anthropic' || value === 'ollama' || value === 'openai-compatible') return value;
  return 'openai-compatible';
}

function clampNumber(value: number | undefined, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, value));
}

function openAiChatUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function anthropicMessagesUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (trimmed.endsWith('/messages')) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

function ollamaChatUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (trimmed.endsWith('/api/chat')) return trimmed;
  if (trimmed.endsWith('/api')) return `${trimmed}/chat`;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed.replace(/\/v\d+$/, '')}/api/chat`;
  return `${trimmed}/api/chat`;
}

interface PreparedRequest {
  messages: LlmMessage[];
  jsonMode: boolean;
  maxTokens: number;
  temperature: number | undefined;
}

interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('');
}

/**
 * One client for OpenAI-compatible, Anthropic and Ollama APIs.
 *
 * ```ts
 * const llm = new UniversalLlmClient({ provider: 'ollama', model: 'qwen2.5:7b' });
 * const { text, usage } = await llm.chat({ messages: [{ role: 'user', content: '…' }], jsonMode: true });
 * ```
 */
export class UniversalLlmClient {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly baseUrl: string;

  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: UniversalLlmClientOptions = {}) {
    this.provider = opts.provider ?? resolveProvider(envString('AGIL_LLM_PROVIDER'));
    const defaults = PROVIDER_DEFAULTS[this.provider];
    this.baseUrl = firstNonEmpty(opts.endpoint, envString('AGIL_LLM_URL'), defaults.baseUrl) ?? defaults.baseUrl;
    this.model = firstNonEmpty(opts.model, envString('AGIL_LLM_MODEL'), defaults.model) ?? defaults.model;
    this.apiKey = firstNonEmpty(opts.apiKey, envString('AGIL_LLM_KEY'));
    this.timeoutMs = clampInt(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 180_000);
    this.maxRetries = clampInt(opts.maxRetries, DEFAULT_MAX_RETRIES, 0, 5);
    this.extraHeaders = { ...(opts.extraHeaders ?? {}) };
  }

  /** `true` when both a base URL and a model are resolved. */
  isConfigured(): boolean {
    return this.baseUrl.length > 0 && this.model.length > 0;
  }

  /**
   * Send a chat completion and return the assistant text.
   * Throws {@link LlmError} for invalid requests, timeouts, network/HTTP errors
   * and malformed provider responses.
   */
  async chat(request: LlmChatRequest): Promise<LlmChatResult> {
    if (!this.isConfigured()) {
      throw new LlmError('not_configured', `LLM (${this.provider}) is not configured`, { retryable: false });
    }
    const prepared = this.prepare(request);
    const providerRequest = this.buildProviderRequest(prepared);
    const attempts = this.maxRetries + 1;
    let lastError: LlmError = new LlmError('invalid_response', `LLM (${this.provider}) request failed`);

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.attempt(providerRequest);
      } catch (error) {
        lastError = error instanceof LlmError ? error : new LlmError('network', this.sanitize(String(error)), {
          retryable: true,
        });
        if (!lastError.retryable) throw lastError;
        if (attempt + 1 < attempts) await this.delay(RETRY_DELAY_MS * (attempt + 1));
      }
    }
    throw lastError;
  }

  private prepare(request: LlmChatRequest): PreparedRequest {
    if (!isRecord(request) || !Array.isArray(request.messages) || request.messages.length === 0) {
      throw new LlmError('invalid_request', 'messages must be a non-empty array', { retryable: false });
    }
    const messages: LlmMessage[] = request.messages.map((message, index) => {
      if (!isRecord(message)) {
        throw new LlmError('invalid_request', `messages[${index}] must be an object`, { retryable: false });
      }
      const role = message.role;
      const content = message.content;
      if (role !== 'system' && role !== 'user' && role !== 'assistant') {
        throw new LlmError('invalid_request', `messages[${index}].role is invalid`, { retryable: false });
      }
      if (typeof content !== 'string') {
        throw new LlmError('invalid_request', `messages[${index}].content must be a string`, { retryable: false });
      }
      return { role, content };
    });
    return {
      messages,
      jsonMode: request.jsonMode === true,
      maxTokens: clampInt(request.maxTokens, DEFAULT_MAX_TOKENS, 1, 32_000),
      temperature: clampNumber(request.temperature, 0, 2),
    };
  }

  private buildProviderRequest(prepared: PreparedRequest): ProviderRequest {
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    if (this.provider === 'openai-compatible') {
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const payload: Record<string, unknown> = {
        model: this.model,
        messages: prepared.messages,
        max_tokens: prepared.maxTokens,
      };
      if (prepared.temperature !== undefined) payload.temperature = prepared.temperature;
      if (prepared.jsonMode) payload.response_format = { type: 'json_object' };
      return {
        url: openAiChatUrl(this.baseUrl),
        headers: { ...headers, ...this.extraHeaders },
        body: JSON.stringify(payload),
      };
    }

    if (this.provider === 'anthropic') {
      if (this.apiKey) headers['x-api-key'] = this.apiKey;
      headers['anthropic-version'] = ANTHROPIC_VERSION;
      const systemParts: string[] = [];
      const chatMessages: LlmMessage[] = [];
      for (const message of prepared.messages) {
        if (message.role === 'system') systemParts.push(message.content);
        else chatMessages.push(message);
      }
      if (chatMessages.length === 0) {
        throw new LlmError('invalid_request', 'anthropic requires at least one user/assistant message', {
          retryable: false,
        });
      }
      if (prepared.jsonMode) systemParts.push(JSON_MODE_HINT);
      const system = systemParts.join('\n\n');
      const payload: Record<string, unknown> = {
        model: this.model,
        max_tokens: prepared.maxTokens,
        messages: chatMessages,
      };
      if (system.length > 0) payload.system = system;
      if (prepared.temperature !== undefined) payload.temperature = prepared.temperature;
      return {
        url: anthropicMessagesUrl(this.baseUrl),
        headers: { ...headers, ...this.extraHeaders },
        body: JSON.stringify(payload),
      };
    }

    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const options: Record<string, unknown> = { num_predict: prepared.maxTokens };
    if (prepared.temperature !== undefined) options.temperature = prepared.temperature;
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: prepared.messages,
      stream: false,
      options,
    };
    if (prepared.jsonMode) payload.format = 'json';
    return {
      url: ollamaChatUrl(this.baseUrl),
      headers: { ...headers, ...this.extraHeaders },
      body: JSON.stringify(payload),
    };
  }

  private async attempt(providerRequest: ProviderRequest): Promise<LlmChatResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(providerRequest.url, {
          method: 'POST',
          headers: providerRequest.headers,
          body: providerRequest.body,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new LlmError('timeout', `LLM (${this.provider}) request timed out after ${this.timeoutMs}ms`, {
            retryable: true,
          });
        }
        throw new LlmError(
          'network',
          this.sanitize(`LLM (${this.provider}) network error: ${error instanceof Error ? error.message : String(error)}`),
          { retryable: true },
        );
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (controller.signal.aborted) {
          throw new LlmError('timeout', `LLM (${this.provider}) request timed out after ${this.timeoutMs}ms`, {
            retryable: true,
          });
        }
        throw new LlmError(
          'network',
          this.sanitize(`failed to read LLM (${this.provider}) response: ${error instanceof Error ? error.message : String(error)}`),
          { retryable: true },
        );
      }

      if (response.status < 200 || response.status >= 300) {
        throw this.httpError(response.status, text);
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new LlmError('invalid_response', `LLM (${this.provider}) returned invalid JSON (HTTP ${response.status})`, {
          status: response.status,
        });
      }

      const answer = this.extractText(json);
      if (answer.trim().length === 0) {
        throw new LlmError('empty_response', `LLM (${this.provider}) returned empty assistant text`, {
          status: response.status,
        });
      }
      const usage = this.extractUsage(json);
      const result: LlmChatResult = { text: answer, raw: json };
      if (usage) result.usage = usage;
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  private extractText(json: unknown): string {
    if (!isRecord(json)) {
      throw new LlmError('invalid_response', `LLM (${this.provider}) returned a non-object response`);
    }

    if (this.provider === 'openai-compatible') {
      const choices = json.choices;
      const first = Array.isArray(choices) ? choices[0] : undefined;
      if (isRecord(first)) {
        if (isRecord(first.message) && first.message.content !== undefined) {
          return textFromContent(first.message.content);
        }
        if (typeof first.text === 'string') return first.text;
      }
      throw new LlmError('invalid_response', 'LLM (openai-compatible) response has no choices[0].message.content');
    }

    if (this.provider === 'anthropic') {
      const content = json.content;
      if (!Array.isArray(content)) {
        throw new LlmError('invalid_response', 'LLM (anthropic) response has no content[]');
      }
      const parts: string[] = [];
      for (const block of content) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
      if (parts.length === 0) {
        throw new LlmError('invalid_response', 'LLM (anthropic) response has no text blocks');
      }
      return parts.join('');
    }

    const message = json.message;
    if (isRecord(message) && typeof message.content === 'string') return message.content;
    if (typeof json.response === 'string') return json.response;
    throw new LlmError('invalid_response', 'LLM (ollama) response has no message.content');
  }

  private extractUsage(json: unknown): LlmUsage | undefined {
    if (!isRecord(json) || !isRecord(json.usage)) {
      // Native Ollama reports usage as top-level counters.
      if (this.provider === 'ollama' && isRecord(json)) {
        const prompt = json.prompt_eval_count;
        const completion = json.eval_count ?? json.completion_eval_count;
        if (typeof prompt === 'number' || typeof completion === 'number') {
          const usage: LlmUsage = {};
          if (typeof prompt === 'number') usage.promptTokens = prompt;
          if (typeof completion === 'number') usage.completionTokens = completion;
          if (typeof prompt === 'number' || typeof completion === 'number') {
            usage.totalTokens = (typeof prompt === 'number' ? prompt : 0) + (typeof completion === 'number' ? completion : 0);
          }
          return usage;
        }
      }
      return undefined;
    }
    const usage = json.usage;
    if (typeof usage.prompt_tokens === 'number' || typeof usage.completion_tokens === 'number') {
      const mapped: LlmUsage = {};
      if (typeof usage.prompt_tokens === 'number') mapped.promptTokens = usage.prompt_tokens;
      if (typeof usage.completion_tokens === 'number') mapped.completionTokens = usage.completion_tokens;
      if (typeof usage.total_tokens === 'number') mapped.totalTokens = usage.total_tokens;
      return mapped;
    }
    if (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number') {
      const prompt = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
      const completion = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
      return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
    }
    return undefined;
  }

  private httpError(status: number, body: string): LlmError {
    let hint = '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    if (isRecord(parsed)) {
      const error = parsed.error;
      const candidate =
        (typeof parsed.error === 'string' ? parsed.error : undefined) ??
        (typeof parsed.message === 'string' ? parsed.message : undefined) ??
        (isRecord(error) && typeof error.message === 'string' ? error.message : undefined);
      if (candidate) hint = candidate;
    }
    if (!hint) hint = body.replace(/\s+/g, ' ').trim();
    const suffix = hint ? `: ${hint}` : '';
    return new LlmError('http', this.sanitize(`LLM (${this.provider}) responded HTTP ${status}${suffix}`), {
      retryable: status >= 500,
      status,
    });
  }

  private sanitize(text: string): string {
    let out = text;
    if (this.apiKey) {
      out = out.split(this.apiKey).join('[redacted]');
      out = out.split(`Bearer ${this.apiKey}`).join('Bearer [redacted]');
    }
    return out.slice(0, MAX_ERROR_TEXT);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
