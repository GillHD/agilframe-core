/**
 * Client for the corporate AI agent webhook (contract §13).
 *
 * Request: POST JSON (`AiAgentRequest`) with headers
 *   `x-agil-request-id`, `x-agil-tenant`, `content-type: application/json`,
 *   optional `authorization: Bearer <apiKey>` and
 *   `x-agil-signature: <hex HMAC-SHA256(secret, rawBody)>`.
 *
 * Safety:
 *   - no secrets are ever logged (this module does not log at all);
 *   - the response is untrusted input and is validated with
 *     `parseAiAgentResponse` (zod) before being returned;
 *   - `AbortController` enforces `timeoutMs`;
 *   - one retry by default, but only for network errors / timeouts / HTTP 5xx;
 *     HTTP 4xx is never retried.
 */
import { aiAgentRequestSchema, parseAiAgentResponse } from '@agil/protocol';
import type { AiAgentRequest, AiAgentResponse } from '@agil/protocol';
import { SignedWebhookTransport } from './webhook-transport.js';

export interface AiAgentClientOptions {
  endpoint: string;
  apiKey?: string;
  hmacSecret?: string;
  /** Default 8000 ms. */
  timeoutMs?: number;
  /** Retries after the first attempt; default 1. */
  maxRetries?: number;
}

export type AiAgentClientResult =
  | { ok: true; response: AiAgentResponse; provider: string }
  | { ok: false; error: string; retryable: boolean };

/**
 * HTTPS client for a corporate AI agent.
 *
 * ```ts
 * const client = new AiAgentClient({ endpoint: 'https://ai.corp/agil', hmacSecret: '...' });
 * const result = await client.analyze(request);
 * if (result.ok) console.log(result.response.findings);
 * ```
 */
export class AiAgentClient {
  private readonly transport: SignedWebhookTransport;

  constructor(opts: AiAgentClientOptions) {
    this.transport = new SignedWebhookTransport({
      label: 'AI agent',
      endpoint: typeof opts?.endpoint === 'string' ? opts.endpoint : '',
      apiKey: opts?.apiKey,
      hmacSecret: opts?.hmacSecret,
      timeoutMs: opts?.timeoutMs ?? 8000,
      maxRetries: opts?.maxRetries ?? 1,
    });
  }

  /** `true` when an endpoint is configured (local-only mode returns false). */
  isConfigured(): boolean {
    return this.transport.isConfigured();
  }

  /**
   * Send an `AiAgentRequest` and validate the untrusted JSON answer.
   * Never throws for network/http/schema problems: returns `ok:false`.
   */
  async analyze(request: AiAgentRequest): Promise<AiAgentClientResult> {
    if (!this.isConfigured()) {
      return { ok: false, error: 'AI agent endpoint is not configured', retryable: false };
    }

    const parsed = aiAgentRequestSchema.safeParse(request);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue ? ` at ${issue.path.join('.') || '<root>'}: ${issue.message}` : '';
      return { ok: false, error: `invalid AiAgentRequest${where}`.slice(0, 300), retryable: false };
    }
    const payload: AiAgentRequest = parsed.data;

    let rawBody: string;
    try {
      rawBody = JSON.stringify(payload);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      return { ok: false, error: `failed to serialize AiAgentRequest: ${reason}`, retryable: false };
    }

    const result = await this.transport.post(rawBody, {
      requestId: payload.requestId,
      tenantId: payload.tenantId,
    });
    if (!result.ok) return result;

    const validated = parseAiAgentResponse(result.json);
    if (!validated) {
      return {
        ok: false,
        error: `${this.transport.label} response failed schema validation (HTTP ${result.status})`,
        retryable: false,
      };
    }
    return { ok: true, response: validated, provider: validated.provider ?? 'external' };
  }
}
