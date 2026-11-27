/**
 * In-call AI assistant with user-scoped tool calling (docs/in-call-agent.md).
 *
 * The assistant acts **on behalf of the connected participant**: the server
 * resolves that participant's effective permissions, forwards them with an
 * HMAC-signed request to the tenant's agent endpoint, then filters every
 * proposed action through the same access rules (the client check is UX only).
 *
 * `mode:'local'` is handled by the widget (offline deterministic assistant), so
 * the server answers 501 `assistant_local_only`. In `hybrid` an endpoint failure
 * degrades to the widget too; `external` is fail-closed (502 provider_failed).
 */
import { createHmac, randomUUID } from 'node:crypto';
import {
  filterAssistantActions,
  inCallAssistantRequestSchema,
  isAssistantSpotlightAllowed,
  isAssistantToolAllowed,
  parseInCallAssistantResponse,
  sanitizeAssistantAction,
  type AssistantReply,
  type AssistantTool,
  type InCallAssistantRequest,
  type InCallAssistantResponse,
  type TenantConfig,
} from '@agil/protocol';
import type { Env } from './env.js';
import type { Logger } from './logger.js';
import { resolveTenantSecret } from './secret-env.js';
import { IN_CALL_SECURITY_RULES } from './in-call-security-rules.js';
import type { InCallSecurityPolicy } from './in-call-security-policy.js';

export interface AssistantStateInput {
  participants?: number;
  recording?: boolean;
  mic?: 'on' | 'off';
  camera?: 'on' | 'off';
  screenSharing?: boolean;
  chatOpen?: boolean;
  layoutMode?: string;
  qualityTier?: string;
}

export interface BuildAssistantInput {
  config: TenantConfig;
  tenantId: string;
  roomId: string;
  participant: { id: string; name: string; role: 'host' | 'moderator' | 'guest' };
  permissions: string[];
  text: string;
  locale?: 'ru' | 'en';
  state?: AssistantStateInput;
  policy?: InCallSecurityPolicy;
}

function sign(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/** Builds (and validates) the signed request envelope sent to the tenant agent. */
export function buildAssistantRequest(input: BuildAssistantInput): InCallAssistantRequest {
  const agent = input.config.session.inCallAgent;
  const access = { role: input.participant.role, permissions: input.permissions };
  const tools = agent.allowedTools.filter((tool) => isAssistantToolAllowed(tool, access) &&
    (!input.policy || input.policy.allowedTools.includes(tool)));
  const systemPrompt = [IN_CALL_SECURITY_RULES, input.policy?.instructions, agent.systemPrompt].filter(Boolean).join('\n\n');
  const request: InCallAssistantRequest = {
    requestId: randomUUID(),
    tenantId: input.tenantId,
    roomId: input.roomId,
    participant: {
      id: input.participant.id,
      name: input.participant.name,
      role: input.participant.role,
      permissions: input.permissions.slice(0, 60),
    },
    text: input.text.slice(0, 2000),
    ...(input.locale ? { locale: input.locale } : {}),
    tools: tools.slice(0, 40),
    ...(agent.model ? { model: agent.model } : {}),
    contextCompression: { enabled: agent.compressContext, preserveSystemPrompt: true },
    ...(input.state ? { state: input.state } : {}),
    systemPrompt,
  };
  return inCallAssistantRequestSchema.parse(request);
}

export type AssistantCallOutcome =
  | { ok: true; response: InCallAssistantResponse; provider: string }
  | { ok: false; error: string; retryable: boolean };

const MAX_ASSISTANT_CHARS = 2000;

/** Calls the external in-call agent; validates untrusted output with zod. Never throws. */
export async function callInCallAssistant(
  env: Env,
  config: TenantConfig,
  request: InCallAssistantRequest,
): Promise<AssistantCallOutcome> {
  const agent = config.session.inCallAgent;
  const endpoint = agent.endpoint.trim();
  if (!endpoint) return { ok: false, error: 'assistant endpoint is not configured', retryable: false };
  const rawBody = JSON.stringify(request);
  // Fail closed on a non-allowlisted name: never read an arbitrary env var, and
  // never call the tenant endpoint pretending the key was simply absent.
  const secretRef = resolveTenantSecret(env, agent.apiKeyEnv, 'integration');
  if (!secretRef.allowed) {
    return { ok: false, error: 'assistant secret env is not allowed (expected AGIL_INTEGRATION_*)', retryable: false };
  }
  const apiKey = secretRef.value;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-agil-request-id': request.requestId,
    'x-agil-tenant': request.tenantId,
    'x-agil-assistant': 'in-call',
    accept: 'application/json',
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (env.aiAgentHmacSecret) headers['x-agil-signature'] = sign(env.aiAgentHmacSecret, rawBody);

  const timeoutMs = Math.max(500, Math.min(30_000, agent.timeoutMs || 8000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}`, retryable: response.status >= 500 };
    }
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, error: 'empty assistant response', retryable: false };
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 64 * 1024) {
        await reader.cancel();
        return { ok: false, error: 'assistant response too large', retryable: false };
      }
      chunks.push(value);
    }
    const payload: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
    const parsed = parseInCallAssistantResponse(payload);
    if (!parsed || parsed.requestId !== request.requestId) {
      return { ok: false, error: 'invalid assistant response', retryable: false };
    }
    return { ok: true, response: parsed, provider: parsed.provider ?? 'external' };
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError' ? 'timeout' : (error as Error).message;
    return { ok: false, error: message, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

export interface AssistantReplyInput {
  response: InCallAssistantResponse;
  config: TenantConfig;
  role: 'host' | 'moderator' | 'guest';
  permissions: string[];
  tools: AssistantTool[];
  policy?: InCallSecurityPolicy;
  now?: number;
}

export interface AssistantReplyResult {
  reply: AssistantReply;
  /** Actions the model proposed but the participant may not execute. */
  denied: number;
}

/** Applies permission filtering + tenant limits to the model's proposed reply. */
export function buildAssistantReply(input: AssistantReplyInput): AssistantReplyResult {
  const agent = input.config.session.inCallAgent;
  const limit = Math.max(1, Math.min(10, agent.maxActionsPerReply || 5));
  const access = {
    role: input.role,
    permissions: input.permissions,
    tools: input.tools,
  };
  const filtered = filterAssistantActions(input.response.actions, access);
  const safeActions = filtered.allowed.flatMap((action) => sanitizeAssistantAction(action) ?? []);
  const reply: AssistantReply = {
    id: randomUUID(),
    text: (input.response.text ?? '').slice(0, MAX_ASSISTANT_CHARS),
    actions: safeActions.slice(0, limit),
    spotlight: agent.spotlight ? input.response.spotlight.filter(({ target }) => isAssistantSpotlightAllowed(target, access)).slice(0, 20) : [],
    source: 'external',
    ...(input.policy ? { securityPolicy: { version: input.policy.version, environment: input.policy.environment } } : {}),
    ts: input.now ?? Date.now(),
  };
  return { reply, denied: input.response.actions.length - safeActions.length };
}

/** Logger helper: audit one assistant usage without storing the prompt text. */
export function assistantAuditEntry(input: {
  tenantId: string;
  roomId: string;
  participantId: string;
  provider: string;
  ok: boolean;
  actions: number;
  denied: number;
  policy?: Pick<InCallSecurityPolicy, 'version' | 'environment'>;
}): {
  type: 'admin.action';
  severity: 'info' | 'warn';
  tenantId: string;
  roomId: string;
  message: string;
  details: Record<string, unknown>;
} {
  return {
    type: 'admin.action',
    severity: input.ok ? 'info' : 'warn',
    tenantId: input.tenantId,
    roomId: input.roomId,
    message: `In-call assistant request (${input.ok ? 'answered' : 'failed'}, ${input.actions} actions)`,
    details: {
      kind: 'assistant.usage',
      provider: input.provider,
      ok: input.ok,
      actions: input.actions,
      denied: input.denied,
      ...(input.policy ? { policyVersion: input.policy.version, policyEnvironment: input.policy.environment } : {}),
      // No prompt/completion text: privacy by default.
    },
  };
}

/** Small helper for tests/docs. */
export function assistantRequestText(request: InCallAssistantRequest): string {
  return request.text.slice(0, 80);
}
