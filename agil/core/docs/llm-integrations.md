# Подключение любых нейросетей (модели, MCP, вебхуки)

AgilFrame не привязан к вендору модели. Нейросеть можно подключить на любом из
уровней — от «анализировать диалоги» до «управлять звонком». Все контракты
описаны схемами zod (`@agil/protocol`) и одинаково работают для облачных,
локальных и корпоративных моделей.

## 1. Четыре плоскости подключения

| Плоскость | Что делает модель | Контракт | Где настраивается |
|---|---|---|---|
| **MCP** (инструменты) | читает/меняет конфиг, комнаты, права, провайдеры; читает OpenAPI | MCP (stdio/HTTP) | `agil/core/packages/mcp`, `agil/core/docs/mcp.md` |
| **AI-агент анализа** | транскрипт/чат → findings + summary/выдержки/action items | `AiAgentRequest` → `AiAgentResponse` | `PUT /v1/admin/ai-agent` |
| **Knowledge-агент** | вопрос → ответ по wiki/внутренним ресурсам + цитаты | `KnowledgeQueryRequest` → `KnowledgeQueryResponse` | `PUT /v1/admin/knowledge-agent` |
| **In-call ассистент** | фраза пользователя → текст + действия + spotlight | `InCallAssistantRequest` → `InCallAssistantResponse` | `PUT /v1/admin/in-call-agent` (config) |

Плюс события наружу (вебхуки, HMAC) для ваших пайплайнов: `transcript.ready`,
`analysis.ready`, `knowledge.answer`, `compliance.finding`, `security.event`.

## 2. Как подключить конкретную модель

### 2.1 OpenAI-совместимый API (`/v1/chat/completions`)
Работает с OpenAI, Azure OpenAI, OpenRouter, Together, vLLM, LM Studio, Ollama
(openai-режим), большинством корпоративных шлюзов.

Мини-шлюз (30 строк) превращает наш контракт в вызов модели:

```js
// POST /agil/ai/analyze  (заголовок x-agil-signature проверяется вами)
app.post('/agil/analyze', async (req, res) => {
  // req.body = AiAgentRequest (см. agil/core/docs/ai-agent.md)
  const prompt = `Ты — корпоративный ассистент. Правила: ...\n` +
    req.body.segments.map((s) => `${s.participantName}: ${s.text}`).join('\n');
  const r = await fetch(`${process.env.LLM_URL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.LLM_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.LLM_MODEL,
      response_format: { type: 'json_object' },   // если модель поддерживает
      messages: [{ role: 'system', content: 'Верни JSON по схеме ...' }, { role: 'user', content: prompt }],
    }),
  });
  const json = await r.json();
  const answer = JSON.parse(json.choices[0].message.content);
  // ответ: { requestId, summary, findings, notes:{summary, excerpts, actionItems} }
  res.json({ requestId: req.body.requestId, ...answer });
});
```
`PUT /v1/admin/ai-agent` → `{enabled:true, mode:'external', endpoint:'https://llm-gw.company/agil/analyze', apiKeyEnv:'AGIL_AI_AGENT_KEY'}`.

### 2.2 Anthropic Messages API
Тот же шлюз, меняется только вызов модели (`/v1/messages`, `anthropic-version`,
`content[].text`). В `@agil/ai` есть `UniversalLlmClient` с адаптерами
`openai-compatible` и `anthropic` — можно использовать его как основу шлюза.

### 2.3 Ollama / локальные модели
```bash
ollama serve
ollama pull qwen2.5:7b
# шлюз → POST http://localhost:11434/api/chat или openai-режим http://localhost:11434/v1
```
Идеально для 152-ФЗ/on-prem: данные не покидают контур, LLM-агент — внутренний.

### 2.4 MCP-клиенты (Claude Desktop / Cursor / Claude Code / свой агент)
```jsonc
{
  "mcpServers": {
    "agil-calls": {
      "command": "node",
      "args": ["/opt/agil/packages/mcp/dist/index.js"],
      "env": { "AGIL_SERVER_URL": "http://agil-api:8787", "AGIL_API_KEY": "key", "AGIL_MCP_MODE": "read" }
    }
  }
}
```
или HTTP-MCP: `POST http://agil-mcp:8791/mcp`, `Authorization: Bearer <token>`
(см. `agil/core/docs/mcp.md`, `agil/core/docs/api-exposure.md`). 44 инструмента, read-only режим.

### 2.5 LangChain / LlamaIndex / свой оркестратор
Подключение через MCP (инструменты) и/или HTTP-контракты: ваш оркестратор
вызывает наш API (tokens/rooms/transcript/analysis), а мы — ваш LLM-endpoint.
Никакого SDK вендора не требуется.

### 2.6 Вебхук-агенты (без LLM API)
Агент компании принимает `analysis.ready`/`transcript.ready` (HMAC-подписанные),
запускает свою логику (правила, поиск, DLP) и возвращает результат через
`PUT /v1/admin/ai-agent` endpoint по тому же контракту.

## 3. In-call ассистент: любая модель за прокси

`POST /v1/rooms/:id/assistant` (Bearer) → ваш endpoint получает
`InCallAssistantRequest` с полями `requestId`, `tenantId`, `roomId`, `text`,
`locale`, `participant`, `tools`, `state`, `systemPrompt`,
`contextCompression` и заданным `model`. В `InCallAssistantResponse` верните
тот же `requestId`, текст и предложения `actions` и `spotlight`.
Core фильтрует предложения по правам участника и настройкам организации.

Если прокси поддерживает сжатие, применяйте `contextCompression.enabled`
только к сохранённым сообщениям. При каждом вызове модели передавайте весь
`systemPrompt` в системной роли. [Настройка ассистента и политики](in-call-agent.md).

Для сквозной проверки внешней модели соберите сервер и пакеты проекта,
передайте `AGIL_QA_LLM_URL`, `AGIL_QA_LLM_MODEL` и `AGIL_QA_LLM_KEY` через
окружение и выполните `node qa/in-call-live-provider-e2e.mjs` из `agil/core`.
Тест создаёт временный Core и адаптер на loopback, подписывает отдельную
тестовую политику и отправляет модели только её инструкции и синтетический
вопрос. Конфигурация действующих организаций остаётся прежней. Для проверки
настроенной организации дополнительно проверьте маршрут в её звонке.

Чтобы в том же прогоне открыть звонок в Chromium, задайте
`AGIL_QA_BROWSER_ORIGIN` с адресом `http://127.0.0.1` и свободным портом,
например `http://127.0.0.1:18887`. Тест подключит браузер к временному Core
и проверит политику, подтверждение действия, ограничения гостя и ответ при
недоступном адаптере. Сессия гостя передаётся браузеру через stdin.

## 4. Рекомендации по выбору

| Задача | Модель/подход |
|---|---|
| Быстрое внедрение | OpenAI/Azure/OpenRouter + JSON-mode |
| Данные не должны покидать контур | Ollama/vLLM + on-prem шлюз |
| Сложный комплаенс | локальные правила (builtin) + корпоративная модель только для summary |
| Управление платформой | MCP (read-only для агентов, full для админов) |
| Диалоги/выдержки | внешний AI-агент (analysis.ready) или локальный экстрактивный fallback |

## 5. Безопасность и приватность

- Секреты LLM — только в env на сервере/шлюзе компании (`apiKeyEnv` в конфиге —
  имя переменной, не значение).
- Все ответы моделей — **недоверенный вход**: zod-валидация, ограничения длины,
  никакого исполнения; действия фильтруются правами.
- Минимизация: в AI-агент уходят транскрипт/чат по настройке
  (`sendTranscripts`/`sendChat`), в in-call — только фраза + роли/permissions.
- Retention: `session.aiAgent.retentionMin`, удаление записей/транскриптов;
  on-prem — без внешних вызовов.
- Аудит: `knowledge.query`, `assistant.usage`, `analysis.ready`,
  `compliance.finding`; ключи не логируются.
- Prompt injection: текст участников — данные; модель не получает прав
  выполнять действия/менять конфиг; MCP write-инструменты можно отключить
  (`AGIL_MCP_MODE=read`).
