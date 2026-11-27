# @agil/ai

Node-only библиотека корпоративной AI-интеграции AgilFrame (контракт §13 и §18
в [`agil/core/docs/contract.md`](../../docs/contract.md), архитектура — в
[`agil/core/docs/ai-agent.md`](../../docs/ai-agent.md)).

Пакет импортируется сервером и MCP как **собранный `dist`** (`@agil/ai`), поэтому
после изменений обязателен `npm run build -w @agil/ai`. В браузерные бандлы
(`widget`/`sdk`/`demo`) этот пакет не попадает: он использует `node:crypto` и
`fetch`, а также рассчитан на доверенный серверный контекст.

Пакет не хранит секреты: ключи AI/knowledge-агентов приходят в конструктор из
env-переменных, которые резолвит сервер (`apiKeyEnv` в конфиге тенанта), и
никогда не логируются.

## Возможности

| Экспорт | Назначение |
|---|---|
| `ComplianceEngine` | детерминированные локальные правила: `phrase`, `regex`, встроенные PII (`email`, `phone`, `card` c Luhn, `inn`/СНИЛС) — работают офлайн |
| `LocalNotesExtractor` | экстрактивный суммаризатор без LLM: `summary`, дословные `excerpts` с таймкодами и спикером, `actionItems`, `decisions`, `risks`, `topics`, `sentiment` |
| `AiAgentClient` | подписанный HTTPS-вебхук к корпоративному AI-агенту (findings + notes), ответ валидируется zod |
| `KnowledgeAgentClient` | подписанный HTTPS-вебхук к корпоративному knowledge-агенту (wiki/RAG): вопрос → ответ с цитатами |
| `InCallAssistantClient` | подписанный HTTPS-вебхук к внешнему in-call ассистенту (любая LLM за прокси): текст + действия + spotlight |
| `UniversalLlmClient` | единый `chat()` для OpenAI-compatible / Anthropic / Ollama; основа шлюза «любая нейросеть → наши контракты» |
| `buildAiAgentRequest` | сборка и валидация `AiAgentRequest` перед отправкой |
| `clampAnswerLength` | обрезка ответа knowledge-агента по `maxAnswerChars` |
| `DEFAULT_PII_RULES` | готовый набор PII-правил для `CompliancePolicyRule[]` |

Типы (`TranscriptSegment`, `CompliancePolicyRule`, `ComplianceFinding`,
`MeetingNotes`, `AiAgentRequest/Response`, `KnowledgeQueryRequest/Response`,
`KnowledgeCitation`, `InCallAssistantRequest/Response`, `AssistantAction`,
`AssistantSpotlight`, …) живут в `@agil/protocol` (`compliance.ts`,
`assistant.ts`) и реэкспортируются из `@agil/ai` как type-only.

## Быстрый старт

### Локальный compliance

```ts
import { ComplianceEngine, DEFAULT_PII_RULES } from '@agil/ai';
import type { CompliancePolicyRule, TranscriptSegment } from '@agil/protocol';

const customRules: CompliancePolicyRule[] = [
  {
    id: 'confidential',
    name: 'Конфиденциальная информация',
    type: 'phrase',
    pattern: 'конфиденциальная информация',
    severity: 'critical',
    action: 'warn',
    enabled: true,
  },
  {
    id: 'order-number',
    name: 'Номер заказа',
    type: 'regex',
    pattern: 'заказ\\s*№\\s*\\d{4,10}',
    severity: 'info',
    action: 'flag',
    enabled: true,
  },
];

const engine = new ComplianceEngine({ rules: [...customRules, ...DEFAULT_PII_RULES] });

const segment: TranscriptSegment = {
  id: 'seg-1', participantId: 'p-1', participantName: 'Анна',
  text: 'Это конфиденциальная информация, мой телефон +7 (912) 345-67-89.',
  start: 12.5, end: 17.2, isFinal: true, lang: 'ru', ts: Date.now(),
};

const findings = engine.analyzeSegment(segment);
// findings: ComplianceFinding[] c source:'local', severity/action из правила,
// excerpt ≤200 символов вокруг совпадения, participantId/participantName, confidence:1

const all = engine.analyzeSegments(segments); // батч по транскрипту
```

Правила `type:'pii'` используют встроенные детекторы. Какие именно — задаётся
id/pattern правила (`pii.email`, `pii.phone`, `pii.card`, `pii.inn`); для
неизвестного pattern запускаются все четыре. `card` проверяется по Luhn,
СНИЛС/ИНН — отдельным паттерном под `pii.inn`. Дедуп — по `(ruleId, excerpt)` в
пределах сегмента.

### Заметки без LLM

```ts
import { LocalNotesExtractor } from '@agil/ai';

const notes = new LocalNotesExtractor().extract(segments, {
  locale: 'ru',         // по умолчанию — детект по тексту
  maxExcerpts: 8,       // 5–10 по умолчанию (8), максимум 50
  maxActionItems: 10,
});

notes.summary;      // 3–6 склеенных сегментов (verbatim-фрагменты, не парафраз)
notes.excerpts;     // TranscriptExcerpt[]: kind, text (дословно!), спикер, start/end, note
notes.actionItems;  // ActionItem[]: owner = спикер, due = «до пятницы» / «15.03» / «tomorrow»
notes.decisions;    // string[] из excerpt.kind === 'decision'
notes.risks;        // string[] из excerpt.kind === 'risk'
notes.topics;       // до 8 ключевых слов
notes.sentiment;    // 'positive' | 'neutral' | 'negative'
notes.source;       // 'local'
notes.language;     // 'ru' | 'en'
```

Гарантия: `notes.excerpts[i].text` всегда **дословно** присутствует в
`segment.text` — это важно для панели «Заметки» и юридически значимых выдержек.

### Корпоративный AI-агент

```ts
import { AiAgentClient, buildAiAgentRequest } from '@agil/ai';

const request = buildAiAgentRequest({
  tenantId: 'acme',
  roomId: 'room-42',
  roomName: 'Синк по проекту',
  locale: 'ru',
  participants: [{ id: 'p-1', name: 'Анна', role: 'host', country: 'RU', verified: true }],
  segments,
  chat,
  policy: { rules, policyText: 'Политика ИБ компании…' },
  meetingContext: { startedAt, hostName: 'Анна' },
}); // бросает ZodError на невалидном payload (например, >200 сегментов)

const client = new AiAgentClient({
  endpoint: process.env.AGIL_AI_ENDPOINT ?? '',
  apiKey: process.env.AGIL_AI_KEY,          // опционально
  hmacSecret: process.env.AGIL_AI_HMAC,     // опционально, но рекомендовано
  timeoutMs: 8000,
  maxRetries: 1,
});

if (client.isConfigured()) {
  const result = await client.analyze(request);
  if (result.ok) {
    result.response.findings; // ComplianceFinding[]-совместимые записи (source добавит сервер)
    result.response.notes;    // частичные MeetingNotes от агента
    result.provider;          // response.provider ?? 'external'
  } else {
    // result.error, result.retryable
  }
}
```

Заголовки запроса: `content-type: application/json`, `x-agil-request-id`,
`x-agil-tenant`, `authorization: Bearer <apiKey>` (если задан),
`x-agil-signature` = hex HMAC-SHA256(secret, сырое тело) (если задан).
Таймаут — `AbortController`; один ретрай только на сеть/таймаут/HTTP 5xx;
4xx не ретраится; ответ проверяется `parseAiAgentResponse` (недоверенный вход).

### Knowledge-агент компании (wiki/RAG)

```ts
import { KnowledgeAgentClient } from '@agil/ai';
import type { KnowledgeQueryRequest } from '@agil/protocol';

const client = new KnowledgeAgentClient({
  endpoint: process.env.AGIL_KNOWLEDGE_ENDPOINT ?? '',
  apiKey: process.env.AGIL_KNOWLEDGE_KEY,
  hmacSecret: process.env.AGIL_KNOWLEDGE_HMAC,
  timeoutMs: 10_000,
  maxRetries: 1,
});

const query: KnowledgeQueryRequest = {
  requestId: crypto.randomUUID(),
  tenantId: 'acme',
  roomId: 'room-42',
  participantId: 'p-1',
  participantName: 'Анна',
  role: 'guest',                 // host | moderator | guest
  question: 'Как оформить отпуск?',
  locale: 'ru',
  context: {
    roomName: 'Синк по проекту',
    transcriptTail: '…последние реплики для разрешения местоимений (если включено у тенанта)',
    citations: true,
    maxAnswerChars: 4000,
  },
};

const result = await client.ask(query);
if (result.ok) {
  result.response.answer;                // обрезан до context.maxAnswerChars
  result.response.citations;             // KnowledgeCitation[]: title, url, snippet?
  result.response.confidence;            // 0..1, опционально
  result.response.refused;               // агент может отказаться отвечать
  result.response.provider;              // строка для аудита/UI
}
```

Контракт ответа — `KnowledgeQueryResponse` в `@agil/protocol`. Мы **не храним
содержимое wiki**: сервер только проксирует вопрос и валидирует/обрезает ответ.
Цитаты — недоверенные URL, UI обязан открывать их с
`rel="noopener noreferrer"`.

### In-call ассистент (любая LLM за прокси)

```ts
import { InCallAssistantClient } from '@agil/ai';
import type { InCallAssistantRequest } from '@agil/protocol';

const client = new InCallAssistantClient({
  endpoint: process.env.AGIL_INCALL_ENDPOINT ?? '',
  apiKey: process.env.AGIL_INCALL_KEY,
  hmacSecret: process.env.AGIL_INCALL_HMAC,
  timeoutMs: 8000, // интерактивно — короткий бюджет
  maxRetries: 1,
});

const request: InCallAssistantRequest = {
  requestId: crypto.randomUUID(),
  tenantId: 'acme',
  roomId: 'room-42',
  participant: { id: 'p-1', name: 'Анна', role: 'host', permissions: ['chat', 'recording'] },
  text: 'Включи запись и открой чат',
  locale: 'ru',
  tools: ['start_recording', 'open_chat'],
  state: { participants: 3, recording: false, mic: 'on' },
  systemPrompt: 'Ты — ассистент звонка. Отвечай кратко.',
};

const result = await client.ask(request);
if (result.ok) {
  result.response.text;      // текст ответа
  result.response.actions;   // AssistantAction[]: tool + args? — сервер отфильтрует правами
  result.response.spotlight; // AssistantSpotlight[]: target/text/step — «куда нажать»
  result.provider;
}
```

Заголовки, HMAC, таймаут и ретраи — общий `SignedWebhookTransport` (как у
AI- и knowledge-агента). Ответ — недоверенный вход:
`inCallAssistantRequestSchema` + `parseInCallAssistantResponse`; сервер обязан
прогнать `filterAssistantActions`, поэтому LLM не может выполнить действие вне
прав пользователя. Режимы `session.inCallAgent.mode` (`local`/`external`/
`hybrid`), spotlight и enforcement — в
[`agil/core/docs/in-call-agent.md`](../../docs/in-call-agent.md).

### Любая LLM через `UniversalLlmClient`

```ts
import { UniversalLlmClient, LlmError } from '@agil/ai';

const llm = new UniversalLlmClient({
  provider: 'openai-compatible',        // | 'anthropic' | 'ollama'
  endpoint: process.env.AGIL_LLM_URL,   // base URL, путь провайдера добавится
  apiKey: process.env.AGIL_LLM_KEY,
  model: process.env.AGIL_LLM_MODEL,
  timeoutMs: 30_000,
  maxRetries: 1,
});

const { text, usage, raw } = await llm.chat({
  messages: [
    { role: 'system', content: 'Верни JSON по схеме AiAgentResponse.' },
    { role: 'user', content: transcript },
  ],
  jsonMode: true,
  maxTokens: 2048,
  temperature: 0.2,
});
```

Env-фолбэки (если поля не переданы): `AGIL_LLM_PROVIDER`, `AGIL_LLM_URL`,
`AGIL_LLM_KEY`, `AGIL_LLM_MODEL`.

| `provider` | base URL по умолчанию | путь запроса | аутентификация |
|---|---|---|---|
| `openai-compatible` | `https://api.openai.com/v1` | `/v1/chat/completions` | `authorization: Bearer` |
| `anthropic` | `https://api.anthropic.com` | `/v1/messages` | `x-api-key` + `anthropic-version` |
| `ollama` | `http://127.0.0.1:11434` | `/api/chat` | опционально `Bearer` |

Маппинг особенностей: `jsonMode` → `response_format:{type:'json_object'}`
(OpenAI), `format:'json'` (Ollama), JSON-инструкция в `system` (Anthropic);
`maxTokens`/`temperature` → `options.num_predict`/`options.temperature`
(Ollama); `usage` нормализуется в `{promptTokens, completionTokens,
totalTokens}`. Ошибки — `LlmError` с `code: 'not_configured' |
'invalid_request' | 'timeout' | 'network' | 'http' | 'invalid_response' |
'empty_response'`, `retryable`, `status?`; ретраи только сеть/таймаут/5xx;
ключи в сообщениях редактируются (`[redacted]`). Готовый пример шлюза «наш
контракт → модель» (включая in-call) — в
[`agil/core/docs/llm-integrations.md`](../../docs/llm-integrations.md) §2.1.

## Формат webhook-ответа AI-агента

Ответ — `AiAgentResponse` (zod `aiAgentResponseSchema`), валидируется
`parseAiAgentResponse`:

```json
{
  "requestId": "b3f3c0e2-6a1f-4e0f-9d6f-3f5f3f0f3a11",
  "summary": "Команда согласовала пилот интеграции; риск — нехватка ресурсов.",
  "findings": [
    {
      "ruleId": "policy.confidential",
      "ruleName": "Разглашение конфиденциальной информации",
      "severity": "critical",
      "action": "warn",
      "participantId": "p-1",
      "excerpt": "Это конфиденциальная информация клиента",
      "confidence": 0.92,
      "recommendation": "Остановить обсуждение и напомнить о NDA"
    },
    {
      "ruleId": "ai.custom",
      "ruleName": "Упоминание конкурента",
      "severity": "info",
      "action": "flag",
      "excerpt": "У конкурента это сделано лучше",
      "confidence": 0.7
    }
  ],
  "notes": {
    "summary": "...",
    "excerpts": [
      {
        "id": "ex-1",
        "kind": "decision",
        "text": "Мы решили запустить пилот интеграции",
        "participantId": "p-1",
        "participantName": "Анна",
        "start": 42.1,
        "end": 48.7,
        "note": "Принятое решение"
      }
    ],
    "actionItems": [
      {
        "id": "ai-1",
        "text": "Анна сделает отчёт до 15.03",
        "owner": "Анна",
        "due": "15.03",
        "sourceTs": 1700000000000
      }
    ],
    "decisions": ["Запустить пилот"],
    "risks": ["Нехватка ресурсов"],
    "topics": ["интеграция", "пилот", "ресурсы"],
    "sentiment": "neutral"
  },
  "provider": "corp-ai-gateway",
  "model": "corp-llm-v2"
}
```

Ограничения схемы: `findings` ≤ 50, `excerpt` ≤ 600, `notes.excerpts` ≤ 50,
`notes.actionItems` ≤ 50, строки решений/рисков ≤ 600. Ответ никогда не
исполняется; сервер только валидирует и отображает.

## Ограничения

- **Морфология грубая**: `phrase`-правила ищут основу слова (обрезка типовых
  окончаний ru/en), поэтому возможны и пропуски (нерегулярные формы), и ложные
  срабатывания (основа внутри другого слова).
- **Regex без таймаута**: JS не умеет прерывать catastrophic backtracking.
  Паттерны длиннее 500 символов игнорируются, битые — пропускаются, но сложные
  вложенные квантификаторы могут «повесить» обработку сегмента. Держите правила
  простыми; сегмент ограничен 4000 символов схемой протокола.
- **PII — эвристики**: email/телефон/карта(Luhn)/СНИЛС/ИНН; ложные
  срабатывания и пропуски возможны, для DLP нужен внешний детектор.
- **Суммаризация экстрактивная**: summary/`excerpts` — фрагменты транскрипта,
  не парафраз; темы — TF-топ, sentiment — маленький лексикон, не ML.
- **Дедуп findings** — по `(ruleId, excerpt)` в пределах сегмента: несколько
  совпадений одного правила в коротком сегменте схлопываются в один finding.
- **Сеть**: только `fetch` с `AbortController`; нет streaming/keep-alive
  настроек, нет автоматического circuit breaker — ретраи ограничены
  `maxRetries` (clamp 0..5), таймаут clamp 100..120000 мс (у
  `UniversalLlmClient` — 100..180000).
- **In-call ассистент**: ответ LLM — предложение, а не приказ: действия
  фильтруются правами (`filterAssistantActions`), spotlight-таргеты — логические
  имена/CSS из виджета; `timeoutMs` держите коротким (интерактивный UX),
  `spotlight` можно отключить конфигом тенанта.
- **UniversalLlmClient**: провайдеры различаются форматом (см. таблицу выше);
  `jsonMode` у Anthropic — это подсказка в `system`, а не жёсткая гарантия;
  streaming не поддерживается (ответ одним JSON); локальные модели медленнее —
  увеличивайте `timeoutMs` и уменьшайте `maxTokens`; не передавайте ключ в
  query-string `endpoint` (в ошибках редактируется только значение из
  `apiKey`).
- **Оффлайн**: `LocalNotesExtractor`/`ComplianceEngine` не требуют модели; это
  fallback для `session.aiAgent.mode: 'local'` и MCP-инструментов без сети.
- **Секреты**: пакет не логирует ключи и не хранит их; все клиенты редактируют
  секреты в сообщениях об ошибках (`[redacted]`), но ответственность за резолв
  `apiKeyEnv`/HMAC-секрета/`AGIL_LLM_KEY` — на сервере.

## Разработка

```bash
npm run build -w @agil/ai      # tsc → dist (обязательно первым: server/mcp ждут dist)
npm run typecheck -w @agil/ai
npm test -w @agil/ai           # node:test + tsx; сеть только локальный http-сервер (port 0)
```

Структура: `src/compliance-engine.ts`, `src/notes.ts`, `src/agent-client.ts`,
`src/knowledge-client.ts`, `src/in-call-assistant-client.ts`,
`src/universal-llm.ts`, `src/webhook-transport.ts` (общий HMAC/таймаут/ретраи
для агентских клиентов), `src/request-builder.ts`, `src/text.ts`,
`src/index.ts`. Тесты — `test/*.test.ts` (65 тестов, включая локальные
`node:http`-серверы для всех трёх провайдеров LLM и агентских клиентов).
