/**
 * Corporate knowledge agent proxy (contract §18).
 *
 * The server never stores wiki/internal content: it forwards the user's
 * question to the company's RAG endpoint over HTTPS with the same HMAC scheme
 * as the AI agent, validates the untrusted answer with
 * `parseKnowledgeQueryResponse` from `@agil/protocol` and returns citations as
 * data (the UI must render them as untrusted links). The wire format is the
 * `@agil/ai` knowledge-agent contract.
 */
import { createHmac, randomUUID } from 'node:crypto';
import {
  knowledgeQueryRequestSchema,
  parseKnowledgeQueryResponse,
  type KnowledgeQueryRequest,
  type KnowledgeQueryResponse,
  type TenantConfig,
} from '@agil/protocol';
import type { Env } from './env.js';
import type { Logger } from './logger.js';
import { resolveTenantSecret } from './secret-env.js';

export interface KnowledgeServiceOptions {
  env: Env;
  logger: Logger;
}

export interface AskKnowledgeInput {
  config: TenantConfig;
  tenantId: string;
  question: string;
  role: 'host' | 'moderator' | 'guest';
  userId?: string;
  participantId?: string;
  participantName?: string;
  roomId?: string;
  roomName?: string;
  locale?: 'ru' | 'en';
}

export type KnowledgeAskOutcome =
  | { ok: true; response: KnowledgeQueryResponse; provider: string }
  | { ok: false; error: string; retryable: boolean };

const MAX_QUESTION_CHARS = 2000;

function sign(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class KnowledgeService {
  private readonly env: Env;
  private readonly logger: Logger;

  constructor(options: KnowledgeServiceOptions) {
    this.env = options.env;
    this.logger = options.logger;
  }

  /** True when the tenant has an enabled knowledge endpoint. */
  isConfigured(config: TenantConfig): boolean {
    const agent = config.session.knowledgeAgent;
    return agent.enabled && agent.endpoint.trim().length > 0;
  }

  /** Builds the signed request body (exported for tests/documentation). */
  buildRequest(input: AskKnowledgeInput): KnowledgeQueryRequest {
    const agent = input.config.session.knowledgeAgent;
    const request: KnowledgeQueryRequest = {
      requestId: randomUUID(),
      tenantId: input.tenantId,
      role: input.role,
      question: input.question.slice(0, MAX_QUESTION_CHARS),
      ...(input.roomId ? { roomId: input.roomId } : {}),
      ...(input.userId ? { userId: input.userId.slice(0, 128) } : {}),
      ...(input.participantId ? { participantId: input.participantId.slice(0, 64) } : {}),
      ...(input.participantName ? { participantName: input.participantName.slice(0, 120) } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
      context: {
        ...(input.roomName ? { roomName: input.roomName.slice(0, 120) } : {}),
        ...(agent.systemPrompt ? { systemPrompt: agent.systemPrompt.slice(0, 4000) } : {}),
        citations: agent.citations,
        maxAnswerChars: agent.maxAnswerChars,
      },
    };
    return request;
  }

  /**
   * Asks the company's knowledge agent. Never throws; failures are reported as
   * `{ok:false, error, retryable}` so the caller can degrade gracefully.
   */
  async ask(input: AskKnowledgeInput): Promise<KnowledgeAskOutcome> {
    const agent = input.config.session.knowledgeAgent;
    if (!agent.enabled) return { ok: false, error: 'knowledge_agent_disabled', retryable: false };
    if (!agent.endpoint) return { ok: false, error: 'knowledge_agent_not_configured', retryable: false };

    const request = this.buildRequest(input);
    const parsedRequest = knowledgeQueryRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return { ok: false, error: `invalid_request: ${parsedRequest.error.issues[0]?.message ?? 'validation failed'}`, retryable: false };
    }
    const rawBody = JSON.stringify(parsedRequest.data);
    // Defence in depth: config may only name an `AGIL_INTEGRATION_*` variable,
    // and the value comes from the startup snapshot (never `process.env[name]`).
    const secretRef = resolveTenantSecret(this.env, agent.apiKeyEnv, 'integration');
    if (!secretRef.allowed) {
      return { ok: false, error: 'knowledge_agent_secret_env_not_allowed', retryable: false };
    }
    if (secretRef.ref && !secretRef.value) {
      return { ok: false, error: `knowledge agent secret env ${secretRef.ref} is not configured`, retryable: false };
    }
    const apiKey = secretRef.value;
    const hmacSecret = this.env.aiAgentHmacSecret;
    const timeoutMs = Math.max(500, Math.min(30_000, Math.trunc(agent.timeoutMs) || 8000));

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-agil-request-id': parsedRequest.data.requestId,
      'x-agil-tenant': input.tenantId,
      accept: 'application/json',
    };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    if (hmacSecret) headers['x-agil-signature'] = sign(rawBody, hmacSecret);

    const attempts = 2; // one retry on network/5xx
    let lastError = 'knowledge agent request failed';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(agent.endpoint, {
          method: 'POST',
          headers,
          body: rawBody,
          signal: controller.signal,
        });
        if (!response.ok) {
          lastError = `HTTP ${response.status}`;
          if (response.status < 500 && response.status !== 429) {
            return { ok: false, error: lastError, retryable: false };
          }
        } else {
          const payload: unknown = await response.json();
          const parsed = parseKnowledgeQueryResponse(payload);
          if (!parsed) {
            this.logger.warn('knowledge agent returned an invalid payload', { tenantId: input.tenantId });
            return { ok: false, error: 'invalid_response', retryable: false };
          }
          return { ok: true, response: parsed, provider: parsed.provider ?? 'company' };
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer);
      }
      if (attempt < attempts) await sleep(150);
    }
    return { ok: false, error: lastError, retryable: true };
  }
}
