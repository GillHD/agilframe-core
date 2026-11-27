/**
 * Client for an external in-call AI assistant (docs/in-call-agent.md).
 *
 * The server resolves the user's effective permissions, builds an
 * `InCallAssistantRequest` (`participant.permissions`, `tools`, compact
 * `state`, optional `systemPrompt`) and POSTs it to the company endpoint.
 * The answer is untrusted: `parseInCallAssistantResponse` validates text,
 * actions and spotlight, then the server filters actions through
 * `filterAssistantActions` (an LLM can never do more than the user may).
 *
 * Same auth scheme as the AI/knowledge agents:
 *   `content-type: application/json`, `x-agil-request-id`, `x-agil-tenant`,
 *   optional `authorization: Bearer <apiKey>`, optional
 *   `x-agil-signature: <hex HMAC-SHA256(secret, rawBody)>`.
 *
 * No secrets are logged (this module does not log at all).
 */
import { inCallAssistantRequestSchema, parseInCallAssistantResponse } from '@agil/protocol';
import type { InCallAssistantRequest, InCallAssistantResponse } from '@agil/protocol';
import { SignedWebhookTransport } from './webhook-transport.js';

export interface InCallAssistantClientOptions {
  endpoint: string;
  apiKey?: string;
  hmacSecret?: string;
  /** Default 8000 ms (interactive assistant — keep the budget short). */
  timeoutMs?: number;
  /** Retries after the first attempt; default 1. */
  maxRetries?: number;
}

export type InCallAssistantClientResult =
  | { ok: true; response: InCallAssistantResponse; provider: string }
  | { ok: false; error: string; retryable: boolean };

/**
 * HTTPS client for an external in-call assistant ("any LLM behind a proxy").
 *
 * ```ts
 * const client = new InCallAssistantClient({ endpoint: 'https://llm-gw.corp/agil/assistant', hmacSecret: '...' });
 * const result = await client.ask(request);
 * if (result.ok) widget.render(result.response.text, result.response.actions, result.response.spotlight);
 * ```
 */
export class InCallAssistantClient {
  private readonly transport: SignedWebhookTransport;

  constructor(opts: InCallAssistantClientOptions) {
    this.transport = new SignedWebhookTransport({
      label: 'In-call assistant',
      endpoint: typeof opts?.endpoint === 'string' ? opts.endpoint : '',
      apiKey: opts?.apiKey,
      hmacSecret: opts?.hmacSecret,
      timeoutMs: opts?.timeoutMs ?? 8000,
      maxRetries: opts?.maxRetries ?? 1,
    });
  }

  /** `true` when an endpoint is configured (`mode: 'local'` returns false). */
  isConfigured(): boolean {
    return this.transport.isConfigured();
  }

  /**
   * Ask the external in-call assistant. Never throws for network/http/schema
   * problems: returns `ok:false` with `retryable` explaining what happened.
   */
  async ask(request: InCallAssistantRequest): Promise<InCallAssistantClientResult> {
    if (!this.isConfigured()) {
      return { ok: false, error: 'In-call assistant endpoint is not configured', retryable: false };
    }

    const parsed = inCallAssistantRequestSchema.safeParse(request);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue ? ` at ${issue.path.join('.') || '<root>'}: ${issue.message}` : '';
      return { ok: false, error: `invalid InCallAssistantRequest${where}`.slice(0, 300), retryable: false };
    }
    const payload: InCallAssistantRequest = parsed.data;

    let rawBody: string;
    try {
      rawBody = JSON.stringify(payload);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      return { ok: false, error: `failed to serialize InCallAssistantRequest: ${reason}`, retryable: false };
    }

    const result = await this.transport.post(rawBody, {
      requestId: payload.requestId,
      tenantId: payload.tenantId,
    });
    if (!result.ok) return result;

    const validated = parseInCallAssistantResponse(result.json);
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
