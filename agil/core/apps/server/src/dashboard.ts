/**
 * Dashboard mascot assistant (DeepSeek-backed) + prompt catalogue.
 *
 * The API key lives only in the environment (`AGIL_DEEPSEEK_API_KEY`) and is
 * never returned, logged or echoed in replies. When the key is missing or the
 * provider fails, a deterministic local rule-based answer is returned with
 * `fallback: true` (the dashboard must never break because of an LLM outage).
 */
import { ASSISTANT_PROMPTS, localAssistantReply, promptForRole } from '@agil/ai';
import type {
  AssistantPromptInfo,
  DashboardAssistantMessage,
  DashboardAssistantRequest,
  DashboardAssistantResponse,
  DashboardAssistantRole,
} from '@agil/protocol';
import type { Env } from './env.js';
import { dashboardRoleInstructions } from './dashboard-prompts.js';

export const MAX_HISTORY_MESSAGES = 12;
export const MAX_HISTORY_CHARS = 8000;
export const MAX_REPLY_CHARS = 8000;

/** Prompt catalogue for the dashboard/MCP (roles, titles, starters). */
export function assistantPromptInfo(): AssistantPromptInfo[] {
  return ASSISTANT_PROMPTS.map((prompt) => ({
    role: prompt.role,
    title: prompt.title,
    description: prompt.description,
    starters: [...prompt.starters],
  }));
}

/** Keeps the newest ≤12 messages / ≤8000 chars (drops oldest first). */
export function trimHistory(messages: DashboardAssistantMessage[]): DashboardAssistantMessage[] {
  const cleaned = messages
    .filter((message) => message && typeof message.content === 'string' && message.content.trim().length > 0)
    .map((message) => ({ role: message.role, content: message.content.trim().slice(0, 4000) }));
  const tail = cleaned.slice(-MAX_HISTORY_MESSAGES);
  let total = tail.reduce((sum, message) => sum + message.content.length, 0);
  while (total > MAX_HISTORY_CHARS && tail.length > 1) {
    total -= tail[0]!.content.length;
    tail.shift();
  }
  return tail;
}

function compactConfig(value: unknown): string {
  if (value === undefined) return '';
  try {
    const json = JSON.stringify(value);
    return json.length > 4000 ? `${json.slice(0, 4000)}…` : json;
  } catch {
    return '';
  }
}

/** System prompt = role instructions + minimal screen/tenant/config context. */
export function buildSystemPrompt(request: DashboardAssistantRequest): string {
  const prompt = promptForRole(request.role);
  const context = request.context ?? {};
  const parts = [dashboardRoleInstructions(prompt.role)];
  const contextLines: string[] = [];
  if (context.screen) contextLines.push(`Экран панели: ${context.screen}`);
  if (context.tenantId) contextLines.push(`Тенант: ${context.tenantId}`);
  if (context.roomId) contextLines.push(`Комната: ${context.roomId}`);
  const config = compactConfig(context.currentConfig);
  if (config) contextLines.push(`Текущий конфиг (сжато): ${config}`);
  if (contextLines.length > 0) {
    parts.push('', 'Контекст текущего экрана (не раскрывай секреты):', ...contextLines.map((line) => `- ${line}`));
  }
  // Optional agent memory from previous admin conversations: untrusted excerpts,
  // capped so a long history cannot overflow the prompt (and never invent facts).
  const memory = typeof context.memory === 'string' ? context.memory.trim().slice(0, 2000) : '';
  if (memory) {
    parts.push(
      '',
      'Память предыдущих бесед администратора (используй только если релевантно, не выдумывай):',
      memory,
    );
  }
  return parts.join('\n');
}

interface DeepSeekChoice {
  message?: { content?: unknown };
}

/** Calls the OpenAI-compatible DeepSeek endpoint; throws on any failure. */
async function callDeepSeek(
  env: Env,
  messages: Array<{ role: string; content: string }>,
): Promise<{ reply: string; model: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.deepseekTimeoutMs);
  try {
    const base = env.deepseekBaseUrl.replace(/\/+$/, '');
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: env.deepseekModel,
        messages,
        temperature: 0.3,
        max_tokens: 900,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
    const data = (await response.json()) as { model?: unknown; choices?: DeepSeekChoice[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) throw new Error('DeepSeek returned an empty answer');
    return {
      reply: content.trim().slice(0, MAX_REPLY_CHARS),
      model: typeof data.model === 'string' && data.model ? data.model : env.deepseekModel,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Removes accidental secret echoes (the key must never reach a response). */
function scrubReply(reply: string, env: Env): string {
  let safe = reply;
  if (env.deepseekApiKey) safe = safe.split(env.deepseekApiKey).join('[redacted]');
  return safe.slice(0, MAX_REPLY_CHARS);
}

/**
 * One dashboard assistant turn: DeepSeek when configured, otherwise the local
 * rule-based assistant. Never throws for provider errors (fallback instead).
 */
export async function answerDashboardAssistant(
  env: Env,
  request: DashboardAssistantRequest,
): Promise<DashboardAssistantResponse> {
  const role = request.role ?? 'assistant';
  const prompt = promptForRole(role);
  const history = trimHistory(request.messages);
  const fallback = (): DashboardAssistantResponse => {
    const local = localAssistantReply({ ...request, role, messages: history });
    return {
      ...local,
      reply: scrubReply(local.reply, env),
      suggestions: local.suggestions.length > 0 ? local.suggestions : [...prompt.starters],
    };
  };

  if (!env.deepseekApiKey) return fallback();
  try {
    const messages = [
      { role: 'system', content: buildSystemPrompt({ ...request, role, messages: history }) },
      ...history.map((message) => ({ role: message.role, content: message.content })),
    ];
    const answer = await callDeepSeek(env, messages);
    return {
      reply: scrubReply(answer.reply, env),
      role,
      model: answer.model,
      fallback: false,
      suggestions: [...prompt.starters],
    };
  } catch {
    return fallback();
  }
}
