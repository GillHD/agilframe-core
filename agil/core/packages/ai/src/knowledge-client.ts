/**
 * Client for the company's knowledge agent (corporate wiki / internal resources
 * Q&A; contract §18).
 *
 * Prompt flow: a participant asks a question in the call UI → the server
 * resolves `resolveKnowledgeAgentAccess()` → this client POSTs a signed
 * `KnowledgeQueryRequest` to the company endpoint → the answer (untrusted) is
 * validated with `parseKnowledgeQueryResponse`, clamped to the requested
 * `context.maxAnswerChars` and shown to the participant with citations.
 *
 * We never store wiki content on our side: only the question and the validated
 * answer are proxied. Same auth scheme as the AI agent (§13):
 *   `x-agil-request-id`, `x-agil-tenant`, optional `authorization: Bearer`,
 *   optional `x-agil-signature: <hex HMAC-SHA256(secret, rawBody)>`.
 *
 * No secrets are logged (this module does not log at all).
 */
import { knowledgeQueryRequestSchema, parseKnowledgeQueryResponse } from '@agil/protocol';
import type { KnowledgeQueryRequest, KnowledgeQueryResponse } from '@agil/protocol';
import { SignedWebhookTransport } from './webhook-transport.js';

export interface KnowledgeAgentClientOptions {
  endpoint: string;
  apiKey?: string;
  hmacSecret?: string;
  /** Default 10000 ms. */
  timeoutMs?: number;
  /** Retries after the first attempt; default 1. */
  maxRetries?: number;
}

export type KnowledgeAgentClientResult =
  | { ok: true; response: KnowledgeQueryResponse; provider: string }
  | { ok: false; error: string; retryable: boolean };

/**
 * Clamp a (potentially huge) answer to `maxAnswerChars` from the request.
 * The result is a verbatim prefix of the answer, at most `maxAnswerChars`.
 */
export function clampAnswerLength(answer: string, maxAnswerChars?: number): string {
  if (typeof maxAnswerChars !== 'number' || answer.length <= maxAnswerChars) return answer;
  if (maxAnswerChars <= 1) return answer.slice(0, Math.max(0, maxAnswerChars));
  const budget = maxAnswerChars - 1; // reserve one char for the ellipsis
  let cut = answer.slice(0, budget);
  const space = cut.lastIndexOf(' ');
  if (space > Math.floor(budget * 0.6)) cut = cut.slice(0, space);
  return `${cut}…`.slice(0, maxAnswerChars);
}

/**
 * HTTPS client for a corporate wiki/RAG knowledge agent.
 *
 * ```ts
 * const client = new KnowledgeAgentClient({ endpoint: 'https://wiki.corp/agil/ask', hmacSecret: '...' });
 * const result = await client.ask(query);
 * if (result.ok) render(result.response.answer, result.response.citations);
 * ```
 */
export class KnowledgeAgentClient {
  private readonly transport: SignedWebhookTransport;

  constructor(opts: KnowledgeAgentClientOptions) {
    this.transport = new SignedWebhookTransport({
      label: 'Knowledge agent',
      endpoint: typeof opts?.endpoint === 'string' ? opts.endpoint : '',
      apiKey: opts?.apiKey,
      hmacSecret: opts?.hmacSecret,
      timeoutMs: opts?.timeoutMs ?? 10_000,
      maxRetries: opts?.maxRetries ?? 1,
    });
  }

  /** `true` when an endpoint is configured (feature stays local otherwise). */
  isConfigured(): boolean {
    return this.transport.isConfigured();
  }

  /**
   * Ask the company knowledge agent. Never throws for network/http/schema
   * problems: returns `ok:false` with `retryable` explaining what happened.
   */
  async ask(request: KnowledgeQueryRequest): Promise<KnowledgeAgentClientResult> {
    if (!this.isConfigured()) {
      return { ok: false, error: 'Knowledge agent endpoint is not configured', retryable: false };
    }

    const parsed = knowledgeQueryRequestSchema.safeParse(request);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue ? ` at ${issue.path.join('.') || '<root>'}: ${issue.message}` : '';
      return { ok: false, error: `invalid KnowledgeQueryRequest${where}`.slice(0, 300), retryable: false };
    }
    const payload: KnowledgeQueryRequest = parsed.data;
    const maxAnswerChars = payload.context?.maxAnswerChars;

    let rawBody: string;
    try {
      rawBody = JSON.stringify(payload);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      return { ok: false, error: `failed to serialize KnowledgeQueryRequest: ${reason}`, retryable: false };
    }

    const result = await this.transport.post(rawBody, {
      requestId: payload.requestId,
      tenantId: payload.tenantId,
    });
    if (!result.ok) return result;

    const validated = parseKnowledgeQueryResponse(result.json);
    if (!validated) {
      return {
        ok: false,
        error: `${this.transport.label} response failed schema validation (HTTP ${result.status})`,
        retryable: false,
      };
    }
    return {
      ok: true,
      response: {
        ...validated,
        answer: clampAnswerLength(validated.answer, maxAnswerChars),
      },
      provider: validated.provider ?? 'external',
    };
  }
}
