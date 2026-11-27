# AI-агент AgilFrame: архитектура, интеграция, приватность

Документ описывает слой корпоративного AI в AgilFrame: локальные правила
compliance, экстрактивные заметки без LLM, внешний AI-агент анализа диалогов
(контракт §13), knowledge-агент компании по wiki/внутренним ресурсам
(контракт §18), in-call ассистент
([`agil/core/docs/in-call-agent.md`](in-call-agent.md)) и универсальный LLM-клиент для
подключения любых нейросетей ([`agil/core/docs/llm-integrations.md`](llm-integrations.md)).
Публичный API пакета — [`agil/core/packages/ai/README.md`](../packages/ai/README.md);
контракты типов — [`agil/core/packages/protocol/src/compliance.ts`](../packages/protocol/src/compliance.ts)
и [`agil/core/packages/protocol/src/assistant.ts`](../packages/protocol/src/assistant.ts).

Главный принцип: **наш продукт не содержит бизнес-логику компании** — ни
корпоративные правила, ни wiki-контент, ни модель. Мы поставляем транспорт,
локальные детерминированные fallback-алгоритмы, подпись вебхуков, валидацию
недоверенных ответов и UI. Компания реализует endpoint(ы) и решает, что и кому
разрешено видеть.

---

## 1. Поток данных

### 1.1. Анализ диалога (заметки + compliance)

```
 браузерный STT / серверный STT
            │  TranscriptSegment[] (text, start/end, participantId/Name, isFinal, lang)
            ▼
 ┌───────────────────────────── AGIL (сервер) ─────────────────────────────┐
 │  ComplianceEngine (local)         всегда, без сети, детерминированно    │
 │   phrase / regex / pii(email, phone, card+Luhn, inn/СНИЛС)              │
 │            │ findings[] (source:'local')                                │
 │            ▼                                                            │
 │  LocalNotesExtractor (local)      fallback и офлайн-MVP                 │
 │   summary, excerpts (дословные), actionItems, decisions, risks, topics  │
 │            │ MeetingNotes (source:'local')                              │
 │            ▼                                                            │
 │  mode = 'local'  ──► findings + notes сразу в UI/аудит                   │
 │  mode = 'external'/'hybrid'                                             │
 │            │ AiAgentRequest (batchSize сегментов, policy, участники)    │
 │            ▼  HTTPS + HMAC-SHA256                                       │
 │      AiAgentClient ──────────────►  корпоративный AI-агент (компания)   │
 │            │                        корпоративная модель/политика       │
 │            │  AiAgentResponse (findings[] + notes), zod-валидация       │
 │            ▼                                                            │
 │  merge: local findings + external findings, notes (external/hybrid)     │
 │            │                                                            │
 │            ├─► broadcast WS {type:'analysis'} модераторам               │
 │            ├─► audit log (compliance.finding, analysis.ready)           │
 │            ├─► attach к записи звонка (transcript + notes)              │
 │            └─► webhook компании analysis.ready                          │
 └─────────────────────────────────────────────────────────────────────────┘
```

Режимы (`session.aiAgent.mode`):
- `local` — только локальные правила и `LocalNotesExtractor`; сеть не нужна.
- `external` — только корпоративный AI-агент (локальные правила compliance при
  этом всё равно работают: это защитный слой, который нельзя отключить
  внешним ответом).
- `hybrid` — оба; внешние findings/notes мержатся с локальными, источник
  помечается (`source:'local'|'external'|'hybrid'`).

### 1.2. Вопрос по внутренним ресурсам компании (knowledge)

```
 участник: вопрос в панели «Помощник»
            │ WS assistant-query
            ▼
 сервер: resolveKnowledgeAgentAccess({config, role, userId, tokenPermissions})
            │ allowed?  ── нет ──► assistant-answer {error:'forbidden', answer:denyMessage}
            ▼ да                       + audit knowledge.denied + rate-limit
 KnowledgeAgentClient ── HTTPS + HMAC ──► knowledge-агент компании (wiki/RAG)
            │                                   поиск по внутренним документам,
            │                                   проверка прав на документы,
            │                                   генерация ответа + цитат
            │ KnowledgeQueryResponse (answer, citations[], confidence?, refused?, provider?)
            ▼  zod-валидация (parseKnowledgeQueryResponse), обрезка по maxAnswerChars
 assistant-answer {answer, citations, confidence, provider, refused}
 + audit knowledge.answer + webhook knowledge.answer
```

Мы **не храним** содержимое wiki и не индексируем документы: только
проксируем вопрос и отображаем валидированный ответ. Права на документы
проверяет компания; мы лишь передаём идентичность/роль после собственной
проверки доступа к функции.

---

## 2. Компоненты `@agil/ai`

| Класс/функция | Сеть | Что делает |
|---|---|---|
| `ComplianceEngine({rules})` | нет | `analyzeSegment(segment)`, `analyzeSegments(segments)` → `ComplianceFinding[]`; `phrase` (регистронезависимо, грубая ru/en-морфология, нормализация ё/е), `regex` (safe compile, лимит паттерна 500), `pii` (email/phone/card-Luhn/СНИЛС-ИНН); дедуп `(ruleId, excerpt)` в сегменте, excerpt ≤200, confidence 1 |
| `LocalNotesExtractor()` | нет | `extract(segments, {locale, maxExcerpts, maxActionItems})` → `MeetingNotes`: экстрактивный summary (3–6 склеенных сегментов), 5–10 дословных `excerpts` с таймкодами/спикером/`kind`/`note`, `actionItems` (owner = спикер, due по regex), `decisions`, `risks`, `topics` (топ-8), `sentiment` |
| `AiAgentClient({endpoint, apiKey?, hmacSecret?, timeoutMs?, maxRetries?})` | да | `isConfigured()`, `analyze(AiAgentRequest)` → `{ok:true,response,provider}` \| `{ok:false,error,retryable}` |
| `KnowledgeAgentClient({endpoint, apiKey?, hmacSecret?, timeoutMs?, maxRetries?})` | да | `isConfigured()`, `ask(KnowledgeQueryRequest)` → `{ok:true,response,provider}` \| `{ok:false,error,retryable}`; ответ обрезается по `context.maxAnswerChars` |
| `InCallAssistantClient({endpoint, apiKey?, hmacSecret?, timeoutMs?, maxRetries?})` | да | `isConfigured()`, `ask(InCallAssistantRequest)` → `{ok:true,response,provider}` \| `{ok:false,error,retryable}`; ответ проверяется `parseInCallAssistantResponse` |
| `UniversalLlmClient({provider?, endpoint?, apiKey?, model?, timeoutMs?, maxRetries?})` | да | `chat({messages, jsonMode?, maxTokens?, temperature?})` → `{text, raw, usage?}` для `openai-compatible`/`anthropic`/`ollama`; ошибки — `LlmError` |
| `buildAiAgentRequest(input)` | нет | собирает и валидирует `AiAgentRequest` (`aiAgentRequestSchema.parse`, бросает `ZodError`) |
| `clampAnswerLength(answer, max)` | нет | verbatim-префикс ответа knowledge-агента + «…», длина ≤ лимита |

Агентские клиенты (`AiAgentClient`, `KnowledgeAgentClient`,
`InCallAssistantClient`) используют общий `SignedWebhookTransport`:
- POST JSON с заголовками `content-type: application/json`,
  `x-agil-request-id`, `x-agil-tenant`, `authorization: Bearer <apiKey>`
  (если задан), `x-agil-signature` = hex HMAC-SHA256(секрет, **сырое тело**)
  (если задан);
- таймаут — `AbortController` (`timeoutMs`, по умолчанию 8000/10000/8000 мс);
- ретрай только на сеть/таймаут/HTTP 5xx (по умолчанию 1); HTTP 4xx не
  ретраится (кроме 408/429 — они попадают в 4xx и тоже не ретраятся: это
  осознанно, чтобы не усиливать rate-limit компании);
- запрос валидируется zod-схемой до сети; ответ — недоверенный вход:
  JSON.parse + zod-валидация; при мусоре `ok:false, retryable:false`;
- ключи/секреты никогда не логируются, в сообщениях об ошибках они
  редактируются (`[redacted]`).

---

## 3. Схема `AiAgentRequest` / `AiAgentResponse`

`AiAgentRequest` (`aiAgentRequestSchema`):

| Поле | Тип | Обязательно | Комментарий |
|---|---|---|---|
| `requestId` | string 1..∞ | да | идемпотентность; генерируется `buildAiAgentRequest`/сервером |
| `tenantId` | string | да | тенант |
| `roomId` | string | да | комната/звонок |
| `roomName` | string ≤120 | да | может быть `''` |
| `locale` | `'ru'\|'en'` | да | язык UI/ожидаемого ответа |
| `participants` | массив (без лимита в схеме) | да | `{id, name≤120, role:'host'\|'moderator'\|'guest', country?='RU', verified:boolean}` |
| `segments` | `TranscriptSegment[]` ≤200 | да | `{id, participantId, participantName, text≤4000, start, end, isFinal, lang?, ts}` |
| `chat` | массив ≤200 | да | `{id, fromName≤120, text≤4000, ts}` — только если `sendChat` |
| `policy.rules` | `CompliancePolicyRule[]` ≤100 | да | правила компании (id≤64, name≤120, pattern≤500) |
| `policy.policyText` | string ≤20000 | да | текст политики/инструкции для модели |
| `meetingContext` | `{startedAt?, hostName?}` | нет | контекст встречи |

`AiAgentResponse` (`aiAgentResponseSchema`, валидируется
`parseAiAgentResponse`, `null` при несоответствии):

| Поле | Тип | Комментарий |
|---|---|---|
| `requestId` | string 1..128 | должен совпадать с запросом (сервер может проверить) |
| `summary` | string ≤4000? | exec-summary созвона |
| `findings` | массив ≤50 | `{ruleId≤64 (default 'ai.custom'), ruleName≤160, severity, action (default 'flag'), participantId?, excerpt≤600, confidence? 0..1, recommendation?≤600}` |
| `notes` | partial `MeetingNotes` без `createdAt/source/segmentsAnalyzed` | `summary, excerpts[]≤50, actionItems[]≤50, decisions[]≤50, risks[]≤50, topics[]≤30, sentiment?` |
| `provider` | string ≤120? | компания/шлюз; клиент возвращает `provider ?? 'external'` |
| `model` | string ≤120? | модель/версия для аудита |

Пример ответа — в [`agil/core/packages/ai/README.md`](../packages/ai/README.md#формат-webhook-ответа-ai-агента).

---

## 4. Как корпоративный AI-агент подключается через API

1. Компания поднимает HTTPS endpoint, например
   `https://ai-gateway.corp.example/agil/analyze`, и заводит секрет в env
   сервера AGIL: `AGIL_AI_KEY` (API-ключ) и/или `AGIL_AI_HMAC` (HMAC-секрет).
2. В конфиге тенанта задаётся
   `session.aiAgent = {enabled:true, mode:'external'|'hybrid',
   endpoint:'https://…', apiKeyEnv:'AGIL_AI_KEY', timeoutMs:8000,
   sendTranscripts:true, sendChat:false, batchSize:50, retentionMin:1440,
   notifyModerators:true, policyText:'…', policyRules:[…]}`.
   **Сервер хранит только имя env-переменной**, не сам ключ; секрет не попадает
   в конфиг, UI, ответы admin API и логи.
3. Сервер шлёт подписанный POST на endpoint (см. §2). Компания проверяет
   подпись по **сырому телу** (до JSON.parse!) и `x-agil-request-id` для
   идемпотентности.
4. Компания отвечает JSON `AiAgentResponse` в пределах `timeoutMs`. Невалидный
   ответ = `ok:false` у нас, находки не применяются; повторной попытки для 4xx
   и «мусорного» 200 нет.

Минимальный приёмник на Node (`node:http`), проверяющий HMAC и
возвращающий ответ:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const HMAC_SECRET = process.env.AGIL_AI_HMAC!;

function verify(rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', HMAC_SECRET).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');     // подпись — по этому телу
    if (req.method !== 'POST' || !verify(rawBody, req.headers['x-agil-signature'] as string | undefined)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid signature' }));
      return;
    }
    const request = JSON.parse(rawBody);                        // AiAgentRequest
    const response = {
      requestId: request.requestId,
      summary: '…',
      findings: [],
      notes: { summary: '…', excerpts: [], actionItems: [], decisions: [], risks: [], topics: [] },
      provider: 'ai-gateway.corp',
      model: 'corp-llm-v2',
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
}).listen(8090, '127.0.0.1');
```

Рекомендации компании: отвечать быстро (LLM — асинхронно/стримингом внутри
себя), ограничивать размер ответа схемой, не исполнять текст транскрипта как
инструкции (prompt injection: `policyText` — единственный доверенный системный
промпт), возвращать `refused`-подобную семантику через `findings`, логировать
только `requestId`/тенант/латентность.

После ответа AGIL объединяет результаты локальной и внешней проверки. Когда включено `notifyModerators`, организатор и модераторы с правом `aiCompliance` получают замечания в звонке. Результаты доступны администратору через API. Запись в журнал аудита и настроенные вебхуки выполняются в обоих режимах уведомлений.

---

## 5. Knowledge-агент компании (wiki/RAG)

### 5.1. Зачем

Участник в звонке спрашивает «как оформить отпуск?» — ответ должен прийти из
**внутренней базы компании** (wiki, Confluence, портал, RAG), с ссылками-
цитатами и с учётом прав этого сотрудника. AgilFrame не индексирует и не
хранит документы: он проверяет право на функцию, проксирует вопрос и
показывает валидированный ответ.

### 5.2. Настройки (`session.knowledgeAgent`, §18)

```ts
{
  enabled: boolean;
  endpoint: string;          // HTTPS endpoint компании
  apiKeyEnv: string;         // имя env-переменной с ключом (не сам ключ!)
  timeoutMs: number;
  allowedRoles: Array<'host' | 'moderator' | 'guest'>;
  requirePermission: boolean; // нужен ли feature permission помимо роли
  citations: boolean;        // запрашивать/показывать цитаты
  maxAnswerChars: number;    // верхняя граница длины ответа
  systemPrompt: string;      // доверенный системный промпт компании
  denyMessage: string;       // текст отказа в UI
}
```

Доступ считается на нашей стороне:
`resolveKnowledgeAgentAccess({config, role, userId?, tokenPermissions?})` →
`{allowed, reason?: 'disabled'|'role'|'permission'|'not_configured', denyMessage?}`.
Порядок: feature-флаг → `allowedRoles` → (если `requirePermission`) право
`aiAssistant`/токен-права → наличие endpoint. Запрещённый `assistant-query`
получает `assistant-answer {error:'forbidden', answer: denyMessage}`, пишется
audit `knowledge.denied`; разрешённый — rate-limit 10/мин на участника, audit
`knowledge.query` + `knowledge.answer`.

Admin API: `GET/PUT /v1/admin/knowledge-agent`
(`KnowledgeAgentSettingsResponse {config, endpointConfigured, apiKeyConfigured}`),
`POST /v1/admin/knowledge/ask` (проверка/ручной вопрос из дашборда).

### 5.3. `KnowledgeQueryRequest` — что уходит наружу

| Поле | Тип | Обязательно | Комментарий |
|---|---|---|---|
| `requestId` | string 1..128 | да | идемпотентность/аудит |
| `tenantId` | string | да | тенант |
| `roomId` | string? | нет | звонок, если вопрос из звонка |
| `userId` | string ≤128? | нет | id сотрудника (из токена/IdP) — компания сама применяет ACL |
| `participantId` / `participantName` | string? | нет | участник звонка |
| `role` | `'host'\|'moderator'\|'guest'` | да | уже проверенная роль |
| `question` | string 1..2000 | да | вопрос пользователя |
| `locale` | `'ru'\|'en'`? | нет | язык ответа |
| `context.roomName` | string ≤120? | нет | контекст для модели |
| `context.transcriptTail` | string ≤4000? | нет | хвост транскрипта для разрешения местоимений; **opt-in тенанта** |
| `context.systemPrompt` | string ≤4000? | нет | доверенный системный промпт компании |
| `context.citations` | boolean? | нет | запросить цитаты |
| `context.maxAnswerChars` | int 100..20000? | нет | лимит ответа; клиент обрежет |

Мы **не отправляем** содержимое wiki/документов, медиа, файлы и полный
транскрипт (только `transcriptTail`, если тенант явно включил). `userId`/роль
нужны, чтобы компания применила собственные права на документы; мы не решаем,
какие документы сотруднику доступны.

### 5.4. `KnowledgeQueryResponse` — что принимаем

```json
{
  "requestId": "kq-7f3a…",
  "answer": "Заявление на отпуск подаётся в HR-портале не позднее чем за 14 дней. См. инструкцию.",
  "citations": [
    {
      "title": "HR wiki: Оформление отпуска",
      "url": "https://wiki.corp.example/hr/vacation",
      "snippet": "Заявление подаётся за 14 дней до начала отпуска."
    }
  ],
  "confidence": 0.86,
  "refused": false,
  "provider": "wiki-rag-gateway",
  "model": "corp-llm-v2"
}
```

Правила обработки:
- `parseKnowledgeQueryResponse` (zod): невалидный ответ → `ok:false,
  retryable:false`, пользователь видит «помощник недоступен»;
- `answer` обрезается до `context.maxAnswerChars` (verbatim-префикс + «…»;
  длина гарантированно ≤ лимита);
- `citations[]` — **недоверенные URL**: открывать только по клику с
  `rel="noopener noreferrer"` и `target="_blank"`, не подгружать превью/iframe
  автоматически, не выполнять HTML из `snippet`;
- `refused:true` показывается как отказ (без ошибки), `confidence` — для UI;
- `provider`/`model` — для аудита и поддержки, не для показа пользователю.

Пример реализации endpoint компании (фрагмент) — тот же HMAC-контракт, что у
AI-агента:

```ts
// POST /agil/knowledge/ask
const rawBody = await readRaw(req);
if (!verifyHmac(rawBody, req.headers['x-agil-signature'], process.env.AGIL_KNOWLEDGE_HMAC!)) {
  return send(res, 401, { error: 'invalid signature' });
}
const query = knowledgeQueryRequestSchema.parse(JSON.parse(rawBody)); // KnowledgeQueryRequest
// 1) проверить права query.userId на документы (ACL компании)
// 2) поиск по индексу (RAG) с фильтрацией по правам
// 3) сгенерировать ответ моделью с цитатами
// 4) вернуть KnowledgeQueryResponse
send(res, 200, {
  requestId: query.requestId,
  answer,
  citations,
  confidence,
  refused,
  provider: 'wiki-rag-gateway',
});
```

Приватность knowledge-потока:
- мы не храним wiki-контент и не кешируем ответы по умолчанию;
- вопрос/ответ попадают в аудит (`knowledge.answer`/`knowledge.denied`) в
  объёме, который определяет retention тенанта; персональные данные в вопросе —
  ответственность компании и её DLP;
- `transcriptTail` отправляется только при явном opt-in; по умолчанию — нет;
- секрет подписи — только имя env-переменной в конфиге; значения резолвит
  сервер и никогда не логирует;
- ответ считается недоверенным: никакого исполнения, только текст + ссылки.

---

## 6. In-call ассистент (любая LLM за прокси)

Участник звонка просит «включи запись», «открой чат», «как поменять камеру?» —
ассистент либо выполняет действие, либо подсвечивает нужную кнопку (spotlight).
Модель может быть любой: облачной, локальной или корпоративной; AgilFrame
общается с ней через подписанный endpoint компании. Полный UX, права и режимы —
[`agil/core/docs/in-call-agent.md`](in-call-agent.md).

### 6.1. Поток

```
виджет: assistant-query {text, locale?, state?}
   │ WS
сервер: token/room + session.inCallAgent.enabled + rate-limit (10/мин на участника)
   │
   ├─ mode='local' → 501 assistant_local_only (виджет исполняет localAssistantReply
   │                  из @agil/protocol офлайн, без сети)
   └─ mode='external'|'hybrid'
        → InCallAssistantClient.ask(InCallAssistantRequest)  (HMAC/Bearer, timeoutMs)
        → parseInCallAssistantResponse (zod, untrusted)
        → filterAssistantActions(actions, {role, permissions}) + maxActionsPerReply
        → audit assistant.usage → AssistantReply {text, actions, spotlight, source:'external'}
```

### 6.2. Контракт (`assistant.ts`)

`InCallAssistantRequest` (`inCallAssistantRequestSchema`):

| Поле | Тип | Обязательно | Комментарий |
|---|---|---|---|
| `requestId` | string 1..128 | да | идемпотентность/аудит |
| `tenantId`, `roomId` | string | да | тенант/комната |
| `participant` | `{id, name≤120, role, permissions[]≤60}` | да | уже проверенные права пользователя |
| `text` | string 1..2000 | да | фраза пользователя (данные, не инструкции) |
| `locale` | `'ru'\|'en'`? | нет | язык ответа |
| `tools` | `AssistantTool[]` ≤40 | да | какие инструменты доступны в тенанте |
| `state` | `{participants?, recording?, mic?, camera?, screenSharing?, chatOpen?, layoutMode?, qualityTier?}`? | нет | компактный state, без медиа/чата/транскрипта |
| `systemPrompt` | string ≤4000? | нет | доверенный промпт компании |

`InCallAssistantResponse` (`parseInCallAssistantResponse`):
`{requestId, text≤4000, actions[]≤10 ({tool, args?}), spotlight[]≤20
({target, text, step?}), model?, provider?}`.

### 6.3. Клиент

```ts
import { InCallAssistantClient } from '@agil/ai';

const client = new InCallAssistantClient({
  endpoint: process.env.AGIL_INCALL_ENDPOINT ?? '',
  apiKey: process.env.AGIL_INCALL_KEY,
  hmacSecret: process.env.AGIL_INCALL_HMAC,
  timeoutMs: 8000, // интерактивный UX — короткий бюджет
  maxRetries: 1,
});

const result = await client.ask(request);
if (result.ok) {
  result.response.text;      // текст ответа
  result.response.actions;   // AssistantAction[] — дальше фильтруются правами
  result.response.spotlight; // AssistantSpotlight[] — «куда нажать»
  result.provider;
} else {
  result.error; result.retryable;
}
```

Запрос валидируется `inCallAssistantRequestSchema` **до** сети; 4xx не
ретраится; таймаут/сеть/5xx — один ретрай; ответ-мусор → `ok:false`
(`retryable:false`). Типы `InCallAssistantRequest/Response`, `AssistantAction`,
`AssistantSpotlight` реэкспортируются из `@agil/ai` (origin — `@agil/protocol`).

### 6.4. Безопасность и приватность

- **Нет эскалации прав**: `filterAssistantActions` режет действия по
  `permissions`/`role`; сервер — источник истины, клиентская проверка — только
  UX. Инъекция «игнорируй права» не проходит серверный фильтр.
- **Нет скрытых действий**: args не исполняются сервером; spotlight `target` —
  логическое имя/CSS-селектор из виджета, не произвольный код.
- Наружу уходят только имя/роль/`permissions` участника, его фраза и компактный
  `state` (без аудио/видео/чата/транскрипта); ключ LLM — только env на
  сервере/шлюзе; вызовы аудируются (`assistant.usage`, rate-limit 10/мин).
- `enabled:false`, пустой `allowedTools` или `spotlight:false` отключают
  ассистента/инструменты/подсветку соответственно.

---

## 7. Любая LLM через `UniversalLlmClient`

`UniversalLlmClient` — единый `chat()` для трёх семейств API. Он не заменяет
наши контракты, а служит основой шлюза «любая нейросеть → `AiAgentRequest` /
`KnowledgeQueryRequest` / `InCallAssistantRequest`» на стороне компании
([`agil/core/docs/llm-integrations.md`](llm-integrations.md) §2.1).

### 7.1. API и конфигурация

```ts
import { UniversalLlmClient, LlmError } from '@agil/ai';

const llm = new UniversalLlmClient({
  provider: 'openai-compatible',          // | 'anthropic' | 'ollama'
  endpoint: process.env.AGIL_LLM_URL,     // base URL, путь провайдера добавится
  apiKey: process.env.AGIL_LLM_KEY,
  model: process.env.AGIL_LLM_MODEL,
  timeoutMs: 30_000,
  maxRetries: 1,
});

const { text, raw, usage } = await llm.chat({
  messages: [
    { role: 'system', content: 'Верни JSON по схеме AiAgentResponse.' },
    { role: 'user', content: transcript },
  ],
  jsonMode: true,
  maxTokens: 2048,
  temperature: 0.2,
});
```

Env-фолбэки (явные опции приоритетнее): `AGIL_LLM_PROVIDER`, `AGIL_LLM_URL`,
`AGIL_LLM_KEY`, `AGIL_LLM_MODEL`.

| `provider` | base URL по умолчанию | путь запроса | аутентификация | `jsonMode` |
|---|---|---|---|---|
| `openai-compatible` | `https://api.openai.com/v1` | `/v1/chat/completions` | `authorization: Bearer` | `response_format:{type:'json_object'}` |
| `anthropic` | `https://api.anthropic.com` | `/v1/messages` | `x-api-key` + `anthropic-version` | JSON-инструкция в `system` |
| `ollama` | `http://127.0.0.1:11434` | `/api/chat` | опционально `Bearer` | `format:'json'` |

`maxTokens`/`temperature` маппятся в `options.num_predict`/`options.temperature`
(Ollama); `usage` нормализуется в `{promptTokens?, completionTokens?,
totalTokens?}`; `raw` — сырой ответ провайдера (тоже недоверенный).

### 7.2. Пример шлюза (in-call / analysis)

```ts
// POST /agil/assistant → любая модель → InCallAssistantResponse
const llm = new UniversalLlmClient({ provider: 'ollama', model: 'qwen2.5:7b', timeoutMs: 20_000 });

app.post('/agil/assistant', async (req, res) => {
  const request = inCallAssistantRequestSchema.parse(req.body);
  const { text } = await llm.chat({
    messages: [
      {
        role: 'system',
        content:
          'Ты — ассистент звонка. Верни JSON {text, actions[], spotlight[]}. ' +
          `Доступные tools: ${request.tools.join(', ')}. ${request.systemPrompt ?? ''}`,
      },
      { role: 'user', content: request.text },
    ],
    jsonMode: true,
    maxTokens: 512,
    temperature: 0.2,
  });
  const answer = parseInCallAssistantResponse({ requestId: request.requestId, ...JSON.parse(text) });
  res.json(answer ?? { requestId: request.requestId, text: 'Не удалось ответить', actions: [], spotlight: [] });
});
```

Ключевое: ответ модели — недоверенный вход, zod-валидация до возврата; права
фильтрует AgilFrame; ключ модели остаётся в env шлюза и не попадает ни в
ответ, ни в логи (`LlmError` редактирует секреты в сообщениях).

### 7.3. Ошибки и ограничения

`LlmError` содержит `code`, `retryable`, `status?`:

| `code` | Когда | Ретрай |
|---|---|---|
| `invalid_request` | пустые/битые messages, system-only для Anthropic | нет, до сети |
| `timeout` / `network` | AbortController / fetch ошибка | да |
| `http` | не-2xx ответ провайдера | только 5xx |
| `invalid_response` / `empty_response` | не JSON / нет текста в ответе | нет |

`jsonMode` у Anthropic — подсказка, а не гарантия (JSON проверяйте сами);
streaming не поддерживается (ответ одним JSON); для локальных моделей
увеличивайте `timeoutMs` (clamp до 180000) и уменьшайте `maxTokens`; не
передавайте ключ в query-string `endpoint`.

---

## 8. Приватность и 152-ФЗ

### 8.1. Что уходит наружу

| Направление | Данные | Условие |
|---|---|---|
| `AiAgentClient` | `tenantId`, `roomId/roomName`, имена и роли участников, `country`/`verified`, текст политики и разрешённые данные звонка | Агент включён в режиме `external` или `hybrid`. Выбор данных описан ниже. |
| `KnowledgeAgentClient` | `tenantId`, `roomId?`, `userId?`, `participantName?`, `role`, вопрос, `roomName`, опционально `transcriptTail` (opt-in), systemPrompt | явный вопрос участника; доступ проверен `resolveKnowledgeAgentAccess`; rate-limit 10/мин |
| `InCallAssistantClient` | `tenantId`, `roomId`, имя/роль/`permissions` участника, фраза, компактный `state`, `systemPrompt` | `session.inCallAgent.mode = 'external'\|'hybrid'`; rate-limit 10/мин на участника; аудит `assistant.usage` |
| `UniversalLlmClient` (шлюз компании) | ровно то, что шлюз отправляет в модель (определяет компания: сообщения/промпты) | только на стороне компании; ключ модели — env шлюза, в AGIL не попадает |

Наружу **не уходят**: медиа/аудио (STT выполняется до отправки), файлы,
содержимое wiki, пароль/токены комнаты, IP-адреса (в компании уходит только
идентичность и текст), секреты (только HMAC-подпись).

### 8.2. Минимизация и согласие

- Роли и права: в запросе — уже проверенная роль, права на документы решает
  компания по `userId`.
- `batchSize` задаёт число новых финальных фрагментов для автоматического запуска анализа.
- `sendTranscripts` включает фрагменты расшифровки в запрос, `sendChat` включает сообщения чата. Если оба переключателя выключены или разрешённых данных для отправки нет, Core пропускает внешний запрос. Локальный анализ расшифровки и правила продолжают работать. Имена участников и текст политики входят в отправляемый запрос независимо от выбора текста звонка.
- `policyText`/`systemPrompt` — только политика компании, без ПДн.
- Запись звонка, транскрипт и STT включаются только после согласия участников;
  UI обязан уведомить о записи/расшифровке. AI-анализ — производная от
  транскрипта, поэтому наследует согласие на запись/расшифровку; для
  внешней передачи (external-режим) рекомендуется отдельное уведомление в
  политике конфиденциальности тенанта.
- Данные уходят только на endpoint компании (или on-prem LLM, §9), который
  определяет тенант; cross-border transfer — на стороне компании.

### 8.3. Retention и удаление

- `session.aiAgent.retentionMin` задаёт срок жизни замечаний, отчёта и заметок в памяти Core. Истёкшие результаты исключаются из JSON и Markdown при чтении. Core также очищает память раз в 30 секунд. Каждый результат стареет от момента создания. У расшифровки, журнала аудита и уже экспортированных копий свои правила хранения.
- Вопросы и ответы `session.knowledgeAgent` хранятся в аудите по политике организации.
- Записи звонков: `GET/DELETE /v1/admin/recordings`, подписанные ссылки с TTL
  (`AGIL_FILE_TTL_SEC`); attachment заметок удаляется вместе с записью.
- Аудит: JSONL `<AGIL_DATA_DIR>/audit/<tenantId>.jsonl`, IP только хэшем;
  события `compliance.finding`, `analysis.ready`, `knowledge.query`,
  `knowledge.denied`, `knowledge.answer`, `assistant.usage`.
- Компания обязана реализовать retention/удаление на своей стороне (её
  endpoint/модель), мы не управляем её хранилищем.

### 8.4. Безопасность AI-слоя

- Ответы — недоверенный вход: zod-валидация, лимиты длин, никакого исполнения.
- Prompt injection: транскрипт/чат — данные, а не инструкции; доверенный
  системный промпт передаётся только в `policyText`/`systemPrompt`.
- HMAC-SHA256 по сырому телу + `requestId` против replay/подмены; ключ — в env
  сервера, сравнение подписи — constant-time.
- HTTP 4xx (включая 401/429) не ретраятся, чтобы не усиливать блокировки.
- Секреты не попадают в клиентский бандл и логи; admin API показывает только
  `endpointConfigured`/`apiKeyConfigured`.

---

## 9. Локальная LLM / Ollama вместо облака

Требование «данные не покидают контур» решается локальным endpoint'ом:
AgilFrame одинаково ходит на любой HTTPS/HTTP endpoint компании, поэтому
достаточно поднять on-prem шлюз (LLM в той же сети) и указать его в
`session.aiAgent.endpoint`/`session.knowledgeAgent.endpoint`/`session.inCallAgent.endpoint`.
Для шлюза «наш контракт → модель» удобно взять `UniversalLlmClient`
(`provider:'ollama'` — нативный `/api/chat`, `'openai-compatible'` — Ollama
openai-режим, `'anthropic'` — Claude; см. §7): он сам решает таймауты, ретраи и
нормализацию ответа. Режим
`external` при этом остаётся, но «внешний» = внутренний контур компании.

Вариант с Ollama (OpenAI-совместимый `/v1/chat/completions`):

```ts
// on-prem шлюз: POST /agil/analyze → Ollama → AiAgentResponse
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const HMAC = process.env.AGIL_HMAC!;
const OLLAMA = 'http://127.0.0.1:11434/v1/chat/completions';
const MODEL = 'qwen2.5:14b-instruct';

function verify(raw: string, sig: string | undefined): boolean {
  if (!sig) return false;
  const expected = createHmac('sha256', HMAC).update(raw, 'utf8').digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!verify(raw, req.headers['x-agil-signature'] as string | undefined)) {
      res.writeHead(401).end();
      return;
    }
    const request = JSON.parse(raw); // AiAgentRequest
    const transcript = request.segments.map((s: { participantName: string; text: string }) =>
      `${s.participantName}: ${s.text}`).join('\n');

    const llmResponse = await fetch(OLLAMA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `Ты — комплаенс-ассистент. Правила компании:\n${request.policy.policyText}\nВерни ТОЛЬКО JSON AiAgentResponse.` },
          { role: 'user', content: transcript },
        ],
      }),
    });
    const completion = await llmResponse.json() as { choices: Array<{ message: { content: string } }> };
    const parsed = JSON.parse(completion.choices[0]!.message.content) as Record<string, unknown>;
    // вернуть валидный AiAgentResponse: requestId обязателен
    const answer = { ...parsed, requestId: request.requestId, provider: 'on-prem-ollama', model: MODEL };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
  });
}).listen(8090, '127.0.0.1');
```

Для knowledge-агента — тот же шлюз: локальный RAG-индекс (например, `pgvector`
или SQLite FTS) + Ollama, возвращает `KnowledgeQueryResponse` с цитатами;
`KnowledgeAgentClient` не меняется.

Плюсы: данные и промпты не покидают контур, нет внешних зависимостей, работает
офлайн; `mode:'local'` + `LocalNotesExtractor`/`ComplianceEngine` полностью
закрывают сценарий без модели. Ограничения: качество модели/железо на стороне
компании; latency локальной LLM выше — увеличивайте `timeoutMs` (clamp
100..120000) и уменьшайте `batchSize`; streaming в контракте нет (ответ — один
JSON), поэтому UI получает результат по завершении.

---

## 10. Ошибки, ретраи, наблюдаемость

| Ситуация | Результат клиента |
|---|---|
| endpoint пуст | `ok:false, retryable:false`, `'… endpoint is not configured'`; локальный режим продолжает работать |
| невалидный `request` | `ok:false, retryable:false` до сети (ZodError → текст) |
| сеть/таймаут | ретрай (по `maxRetries`), затем `ok:false, retryable:true` |
| HTTP 5xx | ретрай, затем `ok:false, retryable:true` |
| HTTP 4xx | без ретрая, `ok:false, retryable:false` (в `error` — статус и короткий hint) |
| 2xx + не JSON | `ok:false, retryable:false` (`invalid JSON`) |
| 2xx + JSON не по схеме | `ok:false, retryable:false` (`schema validation`) |
| 2xx + валидный ответ | `ok:true, response, provider` |

Наблюдаемость: сервер пишет audit-события (`compliance.finding`,
`analysis.ready`, `knowledge.*`), рассылает `{type:'analysis'}` модераторам,
отправляет webhooks (`analysis.ready`, `knowledge.answer`) и прикрепляет
заметки к записи. Логировать стоит `requestId`, тенант, режим, латентность,
`http status`, `retryable`; **не** логировать тела транскриптов, вопросы,
ответы и ключи.

---

## 11. Ограничения и roadmap

- `ComplianceEngine` — эвристики (грубая морфология, regex без таймаута, PII
  без DLP-контекста); для юридически значимого compliance нужна внешняя
  модель + правила компании.
- `LocalNotesExtractor` — экстрактивный fallback: summary/excerpts — цитаты, а
  не парафраз; action items/due — регулярки; sentiment — маленький лексикон.
  Для качества — `mode:'external'/'hybrid'` с корпоративной LLM.
- Внешний ответ недоверенный: никаких побочных эффектов, только данные.
- Нет streaming/ASR-интеграции в этом пакете: сегменты приходят от STT-слоя
  (`@agil/security`/браузер), пакет работает с готовым транскриптом.
- Roadmap: батчирование/стриминг ответов, кэш знаний по правам, локализация
  notes (`ru`/`en` уже частично), метрики качества выдержек.
