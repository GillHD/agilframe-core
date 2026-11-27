/**
 * Shared signed-JSON webhook transport for corporate agent endpoints
 * (AI agent §13, knowledge agent §18, in-call assistant).
 *
 * POST JSON with:
 *   content-type: application/json
 *   x-agil-request-id, x-agil-tenant
 *   authorization: Bearer <apiKey>                         (optional)
 *   x-agil-signature: hex HMAC-SHA256(secret, raw body)     (optional)
 *
 * `AbortController` enforces `timeoutMs`; one retry by default and only for
 * network errors, timeouts and HTTP 5xx (4xx is never retried). The response is
 * returned as untrusted `unknown` for the caller to validate with zod.
 *
 * No secrets are ever logged (this module does not log at all) and error
 * messages are redacted so API keys cannot leak into logs/UI.
 */
import { createHmac } from 'node:crypto';

export interface SignedWebhookTransportOptions {
  /** Human-readable label used in error messages, e.g. `'AI agent'`. */
  label: string;
  endpoint: string;
  apiKey?: string;
  hmacSecret?: string;
  /** Default 8000 ms. */
  timeoutMs?: number;
  /** Retries after the first attempt; default 1. */
  maxRetries?: number;
}

export type SignedWebhookResult =
  | { ok: true; json: unknown; status: number }
  | { ok: false; error: string; retryable: boolean };

export type SignedWebhookFailure = Extract<SignedWebhookResult, { ok: false }>;

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RETRIES = 1;
const RETRY_DELAY_MS = 100;
const MAX_ERROR_TEXT = 300;

export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length === 0) continue;
    out = out.split(secret).join('[redacted]');
    out = out.split(`Bearer ${secret}`).join('Bearer [redacted]');
  }
  return out;
}

export class SignedWebhookTransport {
  readonly label: string;
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly hmacSecret: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: SignedWebhookTransportOptions) {
    this.label = opts.label;
    this.endpoint = typeof opts.endpoint === 'string' ? opts.endpoint.trim() : '';
    this.apiKey = typeof opts.apiKey === 'string' && opts.apiKey.length > 0 ? opts.apiKey : undefined;
    this.hmacSecret = typeof opts.hmacSecret === 'string' && opts.hmacSecret.length > 0 ? opts.hmacSecret : undefined;
    this.timeoutMs = clampInt(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 120_000);
    this.maxRetries = clampInt(opts.maxRetries, DEFAULT_MAX_RETRIES, 0, 5);
  }

  /** `true` when an endpoint is configured. */
  isConfigured(): boolean {
    return this.endpoint.length > 0;
  }

  /** POST `body` (JSON string) with the agent auth headers and retry policy. */
  async post(body: string, meta: { requestId: string; tenantId: string }): Promise<SignedWebhookResult> {
    if (!this.isConfigured()) {
      return { ok: false, error: `${this.label} endpoint is not configured`, retryable: false };
    }
    const headers = this.buildHeaders(meta, body);
    const attempts = this.maxRetries + 1;
    let lastFailure: SignedWebhookFailure = { ok: false, error: `${this.label} request failed`, retryable: false };

    for (let attempt = 0; attempt < attempts; attempt++) {
      const result = await this.attempt(body, headers);
      if (result.ok) return result;
      lastFailure = result;
      if (!result.retryable) return result;
      if (attempt + 1 < attempts) await delay(RETRY_DELAY_MS * (attempt + 1));
    }
    return lastFailure;
  }

  private buildHeaders(meta: { requestId: string; tenantId: string }, body: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-agil-request-id': meta.requestId,
      'x-agil-tenant': meta.tenantId,
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (this.hmacSecret) headers['x-agil-signature'] = this.sign(body, this.hmacSecret);
    return headers;
  }

  private sign(body: string, secret: string): string {
    return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  }

  private sanitize(text: string): string {
    return redactSecrets(text, [this.apiKey, this.hmacSecret]);
  }

  private async attempt(body: string, headers: Record<string, string>): Promise<SignedWebhookResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return { ok: false, error: `${this.label} request timed out after ${this.timeoutMs}ms`, retryable: true };
        }
        return {
          ok: false,
          error: this.sanitize(`${this.label} network error: ${errorMessage(error)}`).slice(0, MAX_ERROR_TEXT),
          retryable: true,
        };
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (controller.signal.aborted) {
          return { ok: false, error: `${this.label} request timed out after ${this.timeoutMs}ms`, retryable: true };
        }
        return {
          ok: false,
          error: this.sanitize(`failed to read ${this.label} response: ${errorMessage(error)}`).slice(0, MAX_ERROR_TEXT),
          retryable: true,
        };
      }

      if (response.status >= 200 && response.status < 300) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          return {
            ok: false,
            error: `${this.label} returned invalid JSON (HTTP ${response.status})`,
            retryable: false,
          };
        }
        return { ok: true, json, status: response.status };
      }

      return {
        ok: false,
        error: this.httpErrorMessage(response.status, text),
        retryable: response.status >= 500,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private httpErrorMessage(status: number, body: string): string {
    let hint = '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      const candidate =
        (typeof record.error === 'string' ? record.error : undefined) ??
        (typeof record.message === 'string' ? record.message : undefined) ??
        (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string'
          ? ((error as Record<string, unknown>).message as string)
          : undefined);
      if (candidate) hint = candidate;
    }
    if (!hint) hint = body.replace(/\s+/g, ' ').trim();
    const suffix = hint ? `: ${hint}` : '';
    return this.sanitize(`${this.label} responded HTTP ${status}${suffix}`).slice(0, MAX_ERROR_TEXT);
  }
}
