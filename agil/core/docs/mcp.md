# AgilFrame MCP server

`@agil/mcp` — stdio-сервер [Model Context Protocol](https://modelcontextprotocol.io),
который даёт нейросети (Claude Desktop/Code, Cursor, Cline, собственные агенты)
инструменты для работы с AgilFrame: читать и валидировать конфиг тенанта,
генерировать темы из бренд-цвета, собирать embed-сниппеты, объяснять права ролей,
разбирать транскрипты (заметки/выдержки/compliance) и управлять сервером через
admin API (комнаты, доступы, knowledge-агент, вебхуки).

Оффлайн-инструменты работают **без сервера** (это чистая логика `@agil/protocol` +
`@agil/ai`). Онлайн-инструменты при недоступном сервере возвращают `isError: true`
с понятной подсказкой, а не падают.

Транспорты: **stdio** (по умолчанию) и **streamable HTTP** (`POST /mcp`, включается
явно). Режимы доступа: `full` (84 инструмента) и `read` (52 read/design-инструмента,
без изменений конфига/комнат/вебхуков/провайдеров/масштабирования/ролей). См. `agil/core/docs/api-exposure.md`.

## Быстрый старт

```bash
npm install
npm run build -w @agil/protocol   # уже собран, если делал Lead
npm run build -w @agil/ai         # нужен для summarize/compliance
npm run build -w @agil/mcp
node agil/core/packages/mcp/dist/index.js   # stdio; обычно запускается самим MCP-клиентом
```

Или `npm run mcp` из корня.

HTTP-режим (для централизованных агентов):

```bash
AGIL_MCP_HTTP_ENABLED=1 \
AGIL_MCP_HTTP_TOKEN='<сильный токен>' \
AGIL_MCP_HTTP_ALLOW_IPS='10.0.0.0/8,127.0.0.1' \
AGIL_MCP_HTTP_PORT=8791 \
node agil/core/packages/mcp/dist/http.js
# или: node agil/core/packages/mcp/dist/index.js  (index сам переключится на HTTP при флаге)

curl -s http://127.0.0.1:8791/mcp \
  -H "authorization: Bearer $AGIL_MCP_HTTP_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### Переменные окружения

| Переменная | Default | Смысл |
|---|---|---|
| `AGIL_SERVER_URL` | `http://localhost:8787` | база AGIL HTTP API |
| `AGIL_API_KEY` | `dev-key` | tenant API key (`x-api-key`); **никогда не логируется** |
| `AGIL_SCIM_TOKEN` | — | Bearer-токен SCIM 2.0 (`/scim/v2/*`); **только env, никогда не логируется** |
| `AGIL_MCP_PARTICIPANT_TOKEN` | — | Короткоживущий токен участника для `agil_preview_in_call_command` |
| `AGIL_TENANT_ID` | `demo` | тенант для онлайн-инструментов и валидации |
| `AGIL_MCP_TIMEOUT_MS` | `8000` | таймаут HTTP-запросов |
| `AGIL_MCP_MODE` | `full` | `read` — инструменты чтения и проектирования. Неизвестное значение включает `read` и пишет предупреждение. |
| `AGIL_MCP_HTTP_ENABLED` | `0` | `1` — `dist/index.js` поднимает HTTP вместо stdio |
| `AGIL_MCP_HTTP_PORT` | `8791` | порт HTTP-MCP (отдельный от API `8787`); `0` — эфемерный |
| `AGIL_MCP_HTTP_HOST` | `127.0.0.1` | интерфейс HTTP-MCP (внутренний IP/VPN — по необходимости) |
| `AGIL_MCP_HTTP_TOKEN` | — | Bearer-токен; при пустом значении все запросы получают 401 |
| `AGIL_MCP_HTTP_ALLOW_IPS` | пусто = все | allowlist: IP или IPv4-CIDR (`10.0.0.0/8`), через запятую |
| `AGIL_MCP_HTTP_MAX_BODY_BYTES` | `1048576` | лимит тела запроса (1024…16 МиБ) |
| `AGIL_TRUST_PROXY` | `0` | `1` — брать IP из первого `x-forwarded-for` (только за доверенным прокси) |

### Проверка ассистента звонка

`agil_preview_in_call_command` принимает `roomId`, `text` и опциональный `locale`.
Настройте режим `external` или `hybrid` и провайдер организации по [руководству ассистента](in-call-agent.md).
Запускайте MCP для конкретного звонка с токеном его участника. Инструмент возвращает ответ с `executed: false`.
В интерфейсе кнопка «Ассистент» открывает панель. Действия выполняются с правами участника, а запуск записи использует штатный диалог согласия.

### Подключение к Claude Desktop

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "agil-calls": {
      "command": "node",
      "args": ["E:/Claude/VideoCalls/agil/core/packages/mcp/dist/index.js"],
      "env": {
        "AGIL_SERVER_URL": "http://localhost:8787",
        "AGIL_API_KEY": "dev-key",
        "AGIL_TENANT_ID": "demo"
      }
    }
  }
}
```

### Подключение к Cursor

`.cursor/mcp.json` в проекте (или `~/.cursor/mcp.json` глобально):

```json
{
  "mcpServers": {
    "agil-calls": {
      "command": "node",
      "args": ["E:/Claude/VideoCalls/agil/core/packages/mcp/dist/index.js"],
      "env": { "AGIL_SERVER_URL": "http://localhost:8787", "AGIL_API_KEY": "dev-key" }
    }
  }
}
```

### Claude Code / CLI

```bash
claude mcp add agil-calls -- node E:/Claude/VideoCalls/agil/core/packages/mcp/dist/index.js
```

### Другие клиенты (MCP SDK)

Любой MCP-клиент с stdio-транспортом:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['E:/Claude/VideoCalls/agil/core/packages/mcp/dist/index.js'],
  env: { AGIL_SERVER_URL: 'http://localhost:8787', AGIL_API_KEY: 'dev-key', AGIL_TENANT_ID: 'demo' },
});
const client = new Client({ name: 'my-app', version: '0.0.1' });
await client.connect(transport);
await client.listTools();
await client.callTool({ name: 'agil_generate_theme', arguments: { brandColor: '#0b5fff' } });
```

Важно: stdout — только MCP JSON-RPC. Все логи сервера идут в stderr, поэтому
`node agil/core/packages/mcp/dist/index.js` в терминале выглядит «пустым» — это нормально.

## HTTP-режим и токен

Транспорт — MCP **streamable HTTP** (`StreamableHTTPServerTransport`), stateless:
каждый `POST /mcp` независим, `mcp-session-id` не выдаётся, ответы — JSON
(`enableJsonResponse`), поэтому `GET`/SSE не используются.

- Endpoint: `POST /mcp` (другие пути → 404, другие методы → 405).
- Авторизация: `Authorization: Bearer ${AGIL_MCP_HTTP_TOKEN}`; сравнение
  constant-time по SHA-256-дайджестам. Нет заголовка/неверный токен → **401**
  (`www-authenticate: Bearer`); пустой `AGIL_MCP_HTTP_TOKEN` → 401 для всех,
  сервер пишет предупреждение в stderr. Токен **никогда не логируется**.
- Allowlist: `AGIL_MCP_HTTP_ALLOW_IPS` проверяется по реальному IP соединения
  (`socket.remoteAddress`; `x-forwarded-for` только при `AGIL_TRUST_PROXY=1`).
  Не прошёл → **403**. Поддерживаются IP и IPv4-CIDR; IPv6 — точное совпадение.
- `cache-control: no-store` на всех ответах (данные тенанта не кэшируются).
- Лимит тела: `AGIL_MCP_HTTP_MAX_BODY_BYTES` (default 1 МиБ) → **413**.
  `content-type` не `application/json` → **415**, битый JSON → **400**.
- Порт: `AGIL_MCP_HTTP_PORT` (default `8791`) — держите его отдельно от API
  (`8787`) и не публикуйте наружу; `AGIL_MCP_HTTP_HOST` default `127.0.0.1`
  (для внутренней сети/VPN укажите внутренний IP).
- Запуск: `node agil/core/packages/mcp/dist/http.js` (всегда HTTP) или
  `AGIL_MCP_HTTP_ENABLED=1 node agil/core/packages/mcp/dist/index.js` (index переключает
  транспорт на HTTP и stdio в этом процессе не поднимает). Скрипты пакета:
  `npm run start:http -w @agil/mcp`, `npm run dev:http -w @agil/mcp`.
- Rate-limit/CORS: на этом порту не реализованы — ставьте MCP за reverse proxy
  (nginx/ingress) с rate-limit и без CORS, как в `agil/core/docs/api-exposure.md` §2.

## Read-only режим

`AGIL_MCP_MODE=read` (работает и для stdio, и для HTTP) регистрирует только
read/design-инструменты. Это защита от случайных изменений продакшена:

- `tools/list` **отфильтрован** — клиент видит 51 инструмент вместо 83;
  write-инструменты не регистрируются вообще (а не просто «падают»);
- вызов write-инструмента по имени возвращает `isError: true` с текстом
  `... is a write tool and is disabled in read-only mode (AGIL_MCP_MODE=read)`;
- read/design-инструменты, включая `agil_validate_config`, `agil_generate_theme`,
  `agil_explain_access`, `agil_explain_providers`, `agil_get_*`, `agil_list_*`,
  `agil_ask_knowledge_agent` (POST-запрос без мутаций) — доступны.

Отключены в read-режиме: `agil_update_config`, `agil_create_room`,
`agil_create_invite`, `agil_create_token`, `agil_run_analysis`,
`agil_post_room_chat`, `agil_set_chat_mode`, `agil_set_ai_agent`,
`agil_set_access_policy`, `agil_set_knowledge_agent`, `agil_set_webhooks`,
`agil_test_webhook`, `agil_set_providers`, `agil_test_provider`,
`agil_set_in_call_agent`, `agil_set_scale`, `agil_create_role`,
`agil_update_role`, `agil_delete_role`.

Важно: список инструментов в read-режиме **намеренно короче** — это видно
клиенту в `tools/list`. Если нужен неизменный список, запускайте `full` и
ограничивайте права API-ключа тенанта.

## Кто и как даёт доступ нейросетям

| Способ | Кто настраивает | Аутентификация | Когда использовать |
|---|---|---|---|
| stdio | пользователь/агент локально | процесс запускает сам агент | Claude Desktop/Code, Cursor, локальные IDE — рекомендуемый путь |
| HTTP (`POST /mcp`) | админ/DevOps компании | Bearer-токен + IP-allowlist + отдельный порт | централизованный агент, корпоративный чат-бот, сервис без доступа к файловой системе |
| OpenAPI как контекст | инженер | `GET /openapi.json` из внутренней сети | агент строит интеграции по контракту без MCP |

Правила выдачи доступа:

1. HTTP-MCP включайте только с `AGIL_MCP_HTTP_TOKEN` и allowlist (VPN/внутренняя
   сеть), на отдельном порту (`8791`), не публикуя его во внешний ingress.
2. Для агентов, которые анализируют данные, но не должны менять тенант, ставьте
   `AGIL_MCP_MODE=read` и отдельный API-ключ тенанта с минимальными правами.
3. `AGIL_API_KEY` — ключ тенанта: онлайн-инструменты действуют от его имени;
   не выдавайте прод-ключ с правом `PUT /v1/admin/*` агентам без необходимости.
4. Allowlist смотрите на реальный IP; за прокси включайте `AGIL_TRUST_PROXY=1`
   только если прокси доверенный, иначе IP подменяется заголовком.
5. Логи без токенов; `cache-control: no-store`; при выключении HTTP-MCP порт
   просто не слушается (не «404 vs 403»-утечка).
6. Полная матрица режимов и чек-лист — `agil/core/docs/api-exposure.md`.

## Инструменты

### Оффлайн (без сервера и сети)

| Инструмент | Что делает |
|---|---|
| `agil_get_config_schema` | полная схема `TenantConfig` (markdown с типами/дефолтами или JSON Schema); `section` — одна секция (`theme`, `security`, `session`, `integrations`, …) |
| `agil_validate_config` | zod-валидация конфига/патча + `auditTheme` + семантические предупреждения (roadmap-флаги, кодек↔preferred, гео, доступы, knowledge/AI-агент, вебхуки) → `{valid, errors, warnings, themeAudit}` |
| `agil_generate_theme` | полная тема (36 токенов) из одного бренд-цвета → `{theme, cssVars, contrastIssues, palette, accessible}` |
| `agil_apply_theme_to_config` | новый валидный конфиг с применённой темой (`brandColor`, `themePatch`, `preset`) + diff и CSS-переменные |
| `agil_apply_theme` | алиас предыдущего (имя из контракта §9) |
| `agil_list_theme_presets` | 5 пресетов: light/dark/corporate/night/minimal с цветами и назначением |
| `agil_audit_accessibility` | WCAG-контраст темы, текущие ratio и предложенные читаемые цвета |
| `agil_suggest_lowbandwidth_profile` | патч `fallback.lowBandwidth` под `mobile-3g`, `satellite`, `office-wifi`, `audio-only` |
| `agil_get_embed_snippet` | HTML/JS для встраивания: SDK (`AGILCalls.mount`) и iframe (`/embed.html?...`), значения экранированы; §22 — `chrome` (full/compact/none), `minimized` (bar/bubble, позиция), `persistAcrossPages` (+ `AGILCalls.resume()`), `inheritHostStyles` |
| `agil_summarize_meeting` | заметки встречи оффлайн: summary, дословные выдержки с таймкодами и спикерами, action items, decisions, risks, topics |
| `agil_analyze_compliance` | детерминированные локальные правила (phrase/regex/PII) по сегментам транскрипта |
| `agil_explain_access` | что реально увидит роль/пользователь: `resolveAccess` (role defaults → user override → token permissions → denied → ∩ features) + `resolveKnowledgeAgentAccess` |
| `agil_explain_providers` | оффлайн-гайд по 6 заменяемым провайдерам (chat/files/stt/notifications/recording/backgrounds): что такое builtin, как заменить на систему компании, контракт слота, fallback; ссылка на `agil/core/docs/extensibility.md` |
| `agil_get_assistant_tools` | 18 инструментов in-call ассистента с требованиями из `assistantToolRequirements` (фича/роль), spotlight-target и признаком «понимает локальный офлайн-движок»; опционально `{role, permissions}` → allowed/denied |
| `agil_explain_spotlight` | markdown-гид по 14 логическим spotlight-target’ам (mic/camera/screen/chat/files/participants/notes/settings/blur/recording/minimize/fullscreen/newtab/invite): где кнопка, какие tool’ы, туры, a11y (или один `target`) |
| `agil_explain_feature` | объяснение фичи + **spotlight-подсказка**: какой target подсветит ассистент, какие tool’ы, как работает тур (см. `agil/core/docs/in-call-agent.md`) |
| `agil_explain_scaling` | оффлайн-гайд по масштабированию: mesh/sfu/broadcast, когда нужны Redis/мульти-нода/SFU/TURN-пул/CDN, вебинар и стриминг, capacity-ориентиры, что реализовано в MVP, а что roadmap; готовые JSON-рецепты (вебинар на 5000, TURN-пул); ссылка `agil/core/docs/scaling.md` §4–§9 |
| `agil_explain_roles` | оффлайн-гайд по модели прав: 3 встроенные роли vs до 30 своих, precedence (token permissions → user override → custom role → strict → role defaults → deniedFeatures → ∩ features), создание/изменение/удаление ролей, токены с `roleId`, примеры «оператор/стример/наблюдатель»; ссылка `agil/core/docs/api-guide.md` §3 |
| `agil_get_docs` | встроенная документация: `theming`, `api`, `embedding`, `security`, `mcp`, `ai-agent` |

### Онлайн (нужен запущенный сервер)

| Инструмент | Endpoint |
|---|---|
| `agil_get_config` | `GET /v1/tenants/:tenantId/config` |
| `agil_update_config` | `PATCH /v1/tenants/:tenantId/config`; `dryRun: true` — локальный merge + diff без сохранения |
| `agil_create_room` | `POST /v1/admin/rooms`; `mode: direct\|group` + `context` ({messenger, conversationId, directPeerId, title}); `direct` = 1:1 из мессенджера, `maxParticipants: 2` (см. `agil/core/docs/messenger.md`); пароль хранится только хэшем |
| `agil_create_invite` | `POST /v1/admin/rooms/:roomId/invites` |
| `agil_create_token` | `POST /v1/tokens` (можно закрепить `permissions`) |
| `agil_list_rooms` | `GET /v1/admin/rooms` |
| `agil_get_room` | `GET /v1/admin/rooms/:roomId` — участники, чат, ссылки; отдельно отдаёт `mode`/`context` комнаты |
| `agil_get_transcript` | `GET /v1/admin/rooms/:roomId/transcript` |
| `agil_get_analysis` | `GET /v1/admin/rooms/:roomId/analysis` |
| `agil_run_analysis` | `POST /v1/admin/rooms/:roomId/analysis/run` |
| `agil_post_room_chat` | `POST /v1/admin/rooms/:roomId/chat` — сообщение от бота/CRM/внешнего чата (`kind: text\|system`, `from`, идемпотентный `id`) |
| `agil_set_chat_mode` | merge в `session.chat` + `PATCH /v1/tenants/:tenantId/config`: `ui` builtin/external/hidden, `externalProviderName`, `allowHostInjection`, `allowSystemMessages` |
| `agil_get_ai_agent` / `agil_set_ai_agent` | `GET/PUT /v1/admin/ai-agent` |
| `agil_get_access_policy` / `agil_set_access_policy` | `GET/PUT /v1/admin/access-policy`; `dryRun` — effective по ролям + diff |
| `agil_get_knowledge_agent` / `agil_set_knowledge_agent` | `GET/PUT /v1/admin/knowledge-agent` |
| `agil_ask_knowledge_agent` | `POST /v1/admin/knowledge/ask` → answer + citations |
| `agil_get_webhooks` / `agil_set_webhooks` | `GET/PUT /v1/admin/webhooks` |
| `agil_test_webhook` | `POST /v1/admin/webhooks/test` |
| `agil_get_providers` | `GET /v1/admin/providers` — статус 6 слотов (mode, providerName, configured, available, fallback) |
| `agil_set_providers` | merge `Partial<ProvidersConfig>` → `PUT /v1/admin/providers`; `dryRun` — локальный merge + diff + предупреждения (endpoint/apiKeyEnv/HTTPS/fallback=fail/disabled-слот) |
| `agil_test_provider` | `POST /v1/admin/providers/test` — подписанный тестовый вызов слота (`{ok, providerName, latencyMs, detail}`) |
| `agil_get_in_call_agent` | `GET /v1/admin/in-call-agent` (fallback: `session.inCallAgent` из конфига) — enabled/mode/endpoint/apiKeyEnv/systemPrompt/model/spotlight/allowedTools/maxActionsPerReply/audit/denyMessage |
| `agil_set_in_call_agent` | merge `Partial<InCallAgentConfig>` → `PUT /v1/admin/in-call-agent`, при 404/405/501 — `PATCH config.session.inCallAgent`; `dryRun` — локальный merge + diff + предупреждения |
| `agil_get_scale` | `GET /v1/admin/scale` — mediaMode/лимиты/сигналинг+узлы/SFU/TURN-пул/LB/вебинар/стриминг/CDN + limitations (fallback: `TenantConfig.scale`) |
| `agil_set_scale` | merge deep-partial `ScaleConfig` → `PUT /v1/admin/scale` (fallback PATCH `config.scale`); `dryRun` + diff + предупреждения (mesh при больших лимитах, sfu без url, TURN без credentialEnv, webinar без broadcast, redisUrl пуст, streaming без provider, CDN без baseUrl) |
| `agil_get_cluster_status` | `GET /v1/admin/cluster/status` — узлы, здоровье, стратегия LB, redisConfigured, stickySessions, multiNodeActive (fallback: из `scale.signaling`) |
| `agil_list_roles` | `GET /v1/admin/roles` — встроенные (`builtin:true`) + свои роли с `assigned` (fallback: из `security.accessPolicy`) |
| `agil_create_role` | `POST /v1/admin/roles` — {id,name,description?,baseRole,features,canModerate?,color?}; валидация схемы/зарезервированных id/дубликатов/лимита 30, `dryRun`, предупреждения (пустые features, guest+recording); fallback PATCH `customRoles` |
| `agil_update_role` | `PUT /v1/admin/roles/:id` — merge patch (id неизменяем); встроенные роли → ошибка с подсказкой про access-policy; `dryRun` |
| `agil_delete_role` | `DELETE /v1/admin/roles/:id` — встроенные нельзя; живые токены падают на `baseRole`; `dryRun` |
| `agil_assess_change` | `POST /v1/admin/guard/assess` — оценка риска изменения (`config\|roles\|access\|scale\|providers\|webhook\|room\|integrations`): risk/requiresConfirmation/findings/recommendations; при 404/405/501 или недоступном сервере — **локальный** `assessChange` (@agil/ai) с live-конфигом/дефолтами, `fallback:true` + reason |
| `agil_dashboard_assistant` | `POST /v1/admin/assistant` — помощник панели (DeepSeek + role system prompt): reply/model/fallback/suggestions; при отсутствии endpoint/ключа — `localAssistantReply` (@agil/ai), явно `fallback:true`, `model:"local-rules"` |
| `agil_list_assistant_prompts` | `GET /v1/admin/assistant/prompts` — 7 ролей с title/description/starters. При недоступности Core используется метаданный каталог `ASSISTANT_PROMPTS` (@agil/ai, `source:"local"`) |
| `agil_list_polls` | `GET /v1/rooms/:roomId/polls` — опросы/Q&A комнаты с результатами (votes, share, voted, status); доступен в read-режиме |
| `agil_create_poll` | `POST /v1/rooms/:roomId/polls` — вопрос 3–500, 2–10 уникальных вариантов, multiple/anonymous/kind (poll/qna); host/moderator; `dryRun` — локальная валидация без создания |
| `agil_vote_poll` | `POST /v1/rooms/:roomId/polls/:pollId/vote` — голос по optionIds (идемпотентно для single-choice); `dryRun` — без голосования; `accepted:false` + reason при повторе/закрытом опросе |
| `agil_close_poll` | `POST /v1/rooms/:roomId/polls/:pollId/close` — закрыть опрос (host/moderator); `dryRun`; результаты остаются в `agil_list_polls` |
| `agil_get_openapi` | `GET /openapi.json` (можно фильтровать по `tag`) |
| `agil_get_api_endpoints` | краткий список эндпоинтов; живой OpenAPI или встроенный каталог (работает оффлайн) |
| `agil_get_audit` | `GET /v1/admin/audit?limit=&type=&roomId=` |
| `agil_get_security_overview` | `GET /v1/admin/security` |
| `agil_get_server_health` | `GET /v1/health` |
| `scim_list_users` / `scim_get_user` | `GET /scim/v2/Users[?filter=&startIndex=&count=]`, `GET /scim/v2/Users/:id` — SCIM ListResponse/User (read) |
| `scim_create_user` / `scim_update_user` / `scim_delete_user` | `POST/PATCH/DELETE /scim/v2/Users[/:id]` — userName/name/emails/active/roles, PatchOp (write) |
| `scim_list_groups` / `scim_create_group` / `scim_update_group` / `scim_delete_group` | `GET/POST/PATCH/DELETE /scim/v2/Groups[/:id]` — displayName/members (2 read/3 write) |
| `scim_service_provider_config` | `GET /scim/v2/ServiceProviderConfig` — patch/filter, maxResults 1000 (read) |
| `egress_status` / `egress_list` | `GET /v1/admin/egress/status`; `GET /v1/rooms/:roomId/egress/list` — статус воркера/сессии (read, URL redacted) |
| `egress_start_recording` / `egress_start_rtmp` / `egress_start_hls` | `POST /v1/rooms/:roomId/egress/start` — kind recording/rtmp/hls (write; rtmpUrl только `rtmp(s)://`, не эхо) |
| `egress_stop` | `POST /v1/rooms/:roomId/egress/stop` — sessionId или все сессии (write) |
| `billing_usage` | `GET /v1/admin/billing/usage[?month=YYYY-MM]` — минуты/комнаты/участники/записи, live-минуты, quota, warnings (read) |
| `billing_status` | `GET /v1/admin/billing/plan` — тариф, enforcement, лимиты, каталог планов, usage (read) |

### Ресурсы

- `agil://docs/theming` — токены/CSS-переменные/пресеты;
- `agil://docs/api` — HTTP API;
- `agil://config/schema` — JSON Schema (draft-07) всего `TenantConfig`;
- `agil://docs/security` — ключи, пароли, гео, аудит, media integrity;
- `agil://docs/embedding` — SDK/iframe/postMessage.

### Промпты

- `agil-brand-setup` (`companyName`, `brandColor?`, `preset?`, `supportUrl?`) — брендирование под компанию;
- `agil-embed-install` (`room?`, `framework?`, `serverUrl?`) — встраивание на сайт/SPA;
- `agil-compliance-review` (`transcript?`, `rules?`, `roomId?`) — разбор транскрипта и правил;
- **7 ролей помощника панели**, которые делегируют запрос в Core:
  `dashboard-assistant`, `config-guardian`, `security-reviewer`, `onboarding`,
  `api-helper`, `scaling-advisor`, `roles-admin`; аргумент `request?` — свободный запрос.
  `prompts/list` показывает все 10. `prompts/get` возвращает инструкцию по вызову `agil_dashboard_assistant` с выбранной ролью и вопросом.

## In-call ассистент и spotlight

В звонке доступен ассистент (`session.inCallAgent`), который по фразе пользователя
либо **выполняет действие**, либо **подсвечивает нужную кнопку** (затемнение UI +
кольцо/подсказка, многошаговые туры). Ключевое правило: агент действует **строго с
правами пользователя** — действия фильтруются `isAssistantToolAllowed` (фича + роль)
на клиенте и повторно проверяются + аудируются на сервере.

- `agil_get_assistant_tools` — 18 инструментов (`start_recording`, `toggle_mic`,
  `open_chat`, `request_fullscreen`, `copy_invite_link`, …) с `requiredFeature`,
  `requiredRoles`, `spotlightTarget` и `localIntent` (понимает ли офлайн-движок);
  с `{role}` или `{permissions}` — ещё и allowed/denied.
- `agil_explain_spotlight` — 14 логических target’ов (mic, camera, screen, chat,
  files, participants, notes, settings, blur, recording, minimize, fullscreen,
  newtab, invite): где кнопка, какие tool’ы, туры, a11y.
- `agil_explain_feature` — объяснение фичи + подсказка про spotlight-тур.
- `agil_get_in_call_agent` / `agil_set_in_call_agent` — настройки
  (local/external/hybrid, endpoint, apiKeyEnv, systemPrompt, model, spotlight,
  allowedTools, maxActionsPerReply, audit, denyMessage); `dryRun` показывает diff.

Режимы: `local` — детерминированные правила ru/en без сети (офлайн, ноль утечек);
`external` — нейросеть компании за HMAC-прокси (`agil/core/docs/llm-integrations.md`);
`hybrid` — LLM + локальный fallback. Wire-протокол:
`POST /v1/rooms/:roomId/assistant` (`InCallAssistantRequest` → `InCallAssistantResponse`).
Полное описание: `agil/core/docs/in-call-agent.md`.

## Подключение внешнего агента к звонку

Проект интерфейса. Текущий participant MCP умеет предварительно разобрать
команду и возвращает `executed: false`. MCP для звонка предоставляет инструменты
управления конкретной комнатой. Core применяет действующие права подключившего
агента участника и исполняет команды.

### Подключение через веб-интерфейс

1. Агент или его MCP-адаптер начинает привязку к Core по HTTPS. Адаптер хранит
   случайный проверочный секрет и передаёт Core его хеш. Запрос на привязку
   получает короткий идентификатор, по которому пользователь может открыть
   экран подтверждения в AgilFrame.
2. В звонке пользователь открывает «Ассистент → Подключить внешнего агента».
   Диалог показывает организацию, комнату, название клиента, запрашиваемые
   действия, срок доступа и ограничения токена, если пользователь их установил.
   Название незарегистрированного клиента
   помечается как предоставленное самим клиентом. Право подключения
   определяется политикой организации и ролью пользователя.
3. После [подтверждения через passkey](#подтверждение-выдачи-кода) Core
   показывает одноразовый код. Пользователь
   вставляет его в защищённое поле подключения агента или локального
   адаптера. Агент обменивает код вместе с проверочным секретом на
   короткоживущий токен. Стартовые значения для MVP — две минуты на обмен
   и до 15 минут на сессию в пределах одного звонка.
4. Пока агент подключён, в звонке видны его имя, выданные права и кнопка
   «Отключить». Выход пользователя, потеря нужной роли или завершение звонка
   прекращают доступ. Повторное подключение и снятие ограничений токена
   требуют нового подтверждения.

Для локального клиента подходит MCP по stdio с исходящим HTTPS к Core.
Для удалённого клиента — отдельный Streamable HTTP-ресурс, например
`/mcp/call`, с OAuth и PKCE по спецификации MCP. Экран подтверждения
можно использовать в обоих вариантах. Веб-страница служит для выдачи и
отзыва доступа, команды идут через Core. Постоянный локальный HTTP-порт
для этого сценария не требуется.
[Авторизация MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

### Права, исполнение и проверка

- Агенту доступны опубликованные в MCP инструменты, которые пользователь
  может применять в этой комнате. При выдаче токена пользователь может
  ограничить набор функций, например оставить только просмотр статуса.
- Для каждой команды Core сверяет комнату, организацию, срок и отзыв токена,
  текущее участие пользователя и его действующие права по штатным правилам
  комнаты и политике организации. Если токен ограничивает функции, Core
  дополнительно проверяет это ограничение. Агент получает собственную метку
  в аудите вместе с ID пользователя, выдавшего доступ.
- Запуск записи, публичного эфира и завершение встречи для всех требуют
  отдельного подтверждения в интерфейсе. Запись проходит штатный сценарий
  согласия участников. Подтверждение связано с конкретным действием и его
  параметрами. Повторная отправка одного запроса не запускает действие снова.
- Core хранит хеш одноразового кода и атомарно погашает его при обмене, в том
  числе при двух одновременных запросах на разных нодах. У кода и токена
  разные назначения. Значения секретов передаются только через защищённые
  поля подключения, вне истории чата, контекста модели, URL и журналов.
  Токен действителен только для указанного интерфейса управления звонком.
- Для приёмки проверить отказ и отмену в браузере, истечение и повтор
  обмена кода, обмен из другого клиента, другую комнату и организацию,
  потерю роли, отзыв при открытом соединении, повтор команды и отказ
  записи без требуемого согласия.

## Делегированный MCP для панели управления

Проект интеграции. Встроенный помощник остаётся в панели. Администратор
сможет подключить свой MCP-клиент, например Claude или Codex, и выдать ему
временный доступ от своего имени. Аккаунт и токены поставщика модели
обслуживают работу модели. AGIL выдаёт отдельный токен для действий в панели.

В панели администратор открывает «Интеграции → Внешние агенты» и подтверждает
доступ клиента к текущей панели и срок действия токена. По умолчанию в рамках
этой панели агент может выполнять опубликованные в MCP действия, разрешённые
подключившему его пользователю. Core использует существующие роли и правила
доступа. При выдаче токена администратор может сузить набор функций, например
оставить только чтение или разрешить только управление комнатами.

Токен связан с учётной записью и выбранной областью работы. Токен организации
привязан к конкретной организации. Токен платформы выдаётся из панели
платформы пользователю, который уже имеет к ней доступ. Токен звонка привязан
к конкретной комнате. На каждом вызове Core проверяет область, действующие
права пользователя и ограничения токена. `tools/list` применяет те же правила.
Изменения прав учитываются и во время открытого соединения. Пользователь
может отозвать токен из панели, после чего он перестаёт действовать на всех
нодах.

Операции с высоким риском, например изменение ролей и политик доступа,
удаление организации или массовый экспорт, требуют отдельного подтверждения
в панели. Подтверждение связано с конкретным запросом, ресурсом и параметрами.
Его можно использовать один раз до истечения срока. Для платформенных
операций над организацией панель явно показывает её название. В аудит
пишутся инициатор, делегировавший администратор, организация, операция и
результат. Секреты интеграций и постоянные административные ключи агенту
не выдаются.

### Подтверждение выдачи кода

1. Клиент создаёт запрос на привязку. Страница подтверждения открывается
   в авторизованном интерфейсе AgilFrame. Она показывает имя клиента,
   область доступа, ограничения токена и срок. MCP-клиент может получить только
   статус запроса. Его токен не даёт право одобрять привязку или получать код.
2. Для выдачи кода в панели и в звонке пользователь подтверждает запрос
   через passkey или совместимый аппаратный ключ с WebAuthn и параметром
   `userVerification: "required"`. Core выдаёт одноразовый challenge,
   связанный с браузерной сессией, запросом, клиентом и параметрами токена.
   Core проверяет подпись, origin, RP ID, срок действия и флаг UV.
   Подтверждение из браузера защищено от CSRF. Для запросов и обмена действуют
   лимиты попыток. CAPTCHA можно использовать дополнительно для снижения
   потока автоматических запросов. [Спецификация WebAuthn](https://www.w3.org/TR/webauthn-3/)
3. Панель показывает код один раз. Пользователь передаёт его через
   защищённое поле подключения клиента или локального MCP-адаптера. Core
   атомарно погашает код только при предъявлении секрета, привязанного к
   запросу исходного клиента. Код и токены исключены из URL, ответов MCP,
   журналов и истории чата. Для подключения локального клиента достаточно
   исходящего HTTPS. Для удалённых клиентов используется отдельный
   Streamable HTTP-ресурс с OAuth и PKCE.

Приёмка проверяет выдачу кода с действующей браузерной сессией и passkey,
отказ без флага UV, недоступность кода через MCP и отказ при повторном
использовании challenge или кода на любой ноде. Отдельные сценарии проверяют
отказ при доступе к чужой организации, применении токена в другой области,
вызове функции за пределами ограничений токена и изменении параметров после
подтверждения. Проверяется, что без ограничений токена доступны все действия
из каталога MCP, разрешённые пользователю в этой области, и что изменение
прав или отзыв токена учитываются во время активной сессии.
WebAuthn проверяет пользователя на устройстве. Одобрение запроса самим
администратором остаётся частью модели доверия.

## Масштабирование и мульти-нода

`TenantConfig.scale` описывает медиа-плоскость и кластер. По умолчанию —
single-node `mesh`, без TURN/SFU: ровно текущее MVP-поведение.

- **mediaMode:** `mesh` (P2P, ≤ ~12 участников) → `sfu` (один SFU-хоп: LiveKit/mediasoup) →
  `broadcast` (спикеры публикуют, зрители receive-only — вебинар/стрим).
- **Сигналинг/кластер:** `nodeId`, `redisUrl` (Redis-compatible pub/sub),
  `pubsubChannel`, `stickySessions` (обязательны для mesh при нескольких узлах),
  `nodes[]`; LB — `loadBalancer{strategy, healthPath, stickyCookie}`.
- **TURN-пул:** `turn[]` (`id`, `urls`, `username`, `credentialEnv` — только имя
  env-переменной, `region`, `weight`); пул автоматически попадает в
  `welcome.iceServers`.
- **SFU:** `sfu{provider, url, apiKeyEnv, apiSecretEnv, region, maxParticipants}`.
- **Вебинар:** `webinar{enabled, hostOnlyPublish, viewerLimit, chatMode, reactions, raiseHandQueue}`
  + `mediaMode:"broadcast"`.
- **Стриминг/CDN:** `streaming{provider: rtmp|hls|webrtc, rtmpUrl, hlsUrl, latencyMode}`,
  `cdn{enabled, baseUrl, provider}`.
- **Честный статус:** контракт, admin API, лимиты до 50 000, TURN→ICE-подстановка,
  редактор/MCP — реализованы; Redis fan-out, реальная SFU-оркестрация, egress/CDN —
  roadmap. Подробно: `agil/core/docs/scaling.md` §4–§9.
- Инструменты: `agil_explain_scaling` (оффлайн-гайд + рецепты), `agil_get_scale`,
  `agil_set_scale` (`dryRun` сначала: diff + предупреждения), `agil_get_cluster_status`.

## Роли: встроенные и свои

Три **встроенные** роли (`host`/`moderator`/`guest`) + до **30 своих**
(`security.accessPolicy.customRoles`). Своя роль выдаётся токену через `roleId` и
заменяет role defaults; итоговые права: token permissions → user override →
**custom role** → strict → role defaults, затем `deniedFeatures` и пересечение с
включёнными `features.*`.

- `agil_explain_roles` — оффлайн-гайд (precedence, builtin vs custom, примеры
  operator/streamer/viewer, как выдать токен).
- `agil_list_roles` — встроенные + свои (baseRole/features/canModerate/color/assigned).
- `agil_create_role` / `agil_update_role` / `agil_delete_role` — `dryRun`,
  валидация схемы и зарезервированных id (`host/moderator/guest/anonymous/system/admin`),
  дубликатов и лимита 30; предупреждения про пустые features и `baseRole=guest`+`recording`;
  встроенные роли не удаляются и не патчатся здесь — только через `agil_set_access_policy`.
- `agil_create_token({ roleId })` — токен с ролью (ответ содержит `roleId`/`roleName`);
  `agil_get_access_policy` возвращает `customRoles` и `roleSummary`.
- Полное руководство: `agil/core/docs/api-guide.md` §3, контракт §18.

## Помощник панели и guard

`agil_assess_change` — **guard перед рискованными изменениями**: оценивает
предлагаемое изменение и возвращает `risk` (low/medium/high/critical),
`requiresConfirmation`, `summary`, plain-language `message`, `findings[]`
(severity/title/impact/affected/confirmation) и `recommendations[]`.
Kinds: `config`, `roles`, `access`, `scale`, `providers`, `webhook`, `room`,
`integrations`; `intent` — человеческая формулировка («выключить запись»).
Использует `POST /v1/admin/guard/assess`; при 404/405/501 или недоступном сервере —
локальный `assessChange` (@agil/ai) с live-конфигом тенанта (или дефолтами) и
`fallback:true`/`reason`.

`agil_dashboard_assistant` — ответы помощника панели (DeepSeek через сервер) с
опциональной ролью и контекстом `{screen, tenantId, roomId, currentConfig}`.
Если endpoint/ключ недоступны — `localAssistantReply` (@agil/ai): детерминированные
правила, `fallback:true`, `model:"local-rules"`, причина в `reason`.

`agil_list_assistant_prompts` возвращает поля `role`, `title`, `description` и `starters`. Полные системные инструкции применяются в Core при вызове помощника. Интеграции, использовавшие поле `systemPrompt`, могут передать `role` и `messages` в `agil_dashboard_assistant`.

**Правило поведения** (прописано в `BASE_INSTRUCTIONS` сервера): перед любым
рискованным изменением вызывай `agil_assess_change`, покажи findings и рекомендации,
и **спроси явное подтверждение**, если `requiresConfirmation` или risk high/critical;
не выполняй критичные изменения без согласия; никогда не выводи секреты
(API-ключи, токены, пароли, HMAC-секреты, значения env — только имена переменных).

## Опросы и Q&A в комнате (Wave 1)

Опросы — комнатные сущности, не часть `TenantConfig`: создаёт host/moderator,
участники голосуют, результаты/статус транслируются по WS (`poll.updated`) в
виджет и панель. MCP-инструменты:

- `agil_list_polls { roomId }` — список с результатами (`options[].votes/share/selected`,
  `totalVotes`, `status`, `voted`, `createdBy`); доступен в read-режиме;
- `agil_create_poll { roomId, question, options: string[], multiple?, anonymous?, kind?: 'poll'|'qna', dryRun? }`
  — валидация по `createPollSchema` (3–500 симв., 2–10 уникальных непустых вариантов);
  `dryRun` возвращает готовый payload без создания; ошибки 403/404/409 — с подсказкой
  про host/moderator и актуальные roomId/pollId;
- `agil_vote_poll { roomId, pollId, optionIds: string[], dryRun? }` — голос участника
  (идемпотентно для single-choice; повтор возвращает `accepted:false` и `reason`,
  а не падение); `dryRun` только валидирует optionIds;
- `agil_close_poll { roomId, pollId, dryRun? }` — закрыть (host/moderator),
  результаты остаются доступны через `agil_list_polls`.

`agil_create_poll` / `agil_vote_poll` / `agil_close_poll` — write-инструменты
(в `AGIL_MCP_MODE=read` не регистрируются), `agil_list_polls` — read. Endpoint'ы
могут отсутствовать на старом сервере: инструменты вернут понятную ошибку 404 с
подсказкой про Wave 1 polls.

**«Создай опрос и покажи результаты»**

`agil_list_polls({ roomId: "room-1" })` → выбрать pollId/optionIds.
`agil_create_poll({ roomId: "room-1", question: "Когда проводим демо?", options: ["Сегодня", "Завтра", "На следующей неделе"], multiple: false, anonymous: true, dryRun: true })`
→ проверить payload и предупреждения → тот же вызов без `dryRun`.
Участники: `agil_vote_poll({ roomId: "room-1", pollId: "poll-7", optionIds: ["opt-2"] })`.
Закрыть: `agil_close_poll({ roomId: "room-1", pollId: "poll-7" })`; результаты —
`agil_list_polls`. Опросы эфемерны и не меняют конфиг тенанта.

## SCIM 2.0: провижининг пользователей и групп (§32)

Каталог компании синхронизируется через SCIM 2.0 (`/scim/v2/*`). Auth —
`Authorization: Bearer $AGIL_SCIM_TOKEN` **только из переменной окружения**;
tenant передаётся аргументом `tenantId` и уходит в `x-tenant-id`; медиа-тип —
`application/scim+json` (Accept/Content-Type). `x-api-key` для SCIM не используется.
Токен не попадает в логи, ошибки и результаты инструментов.

**Read-only (доступны в `AGIL_MCP_MODE=read`):**
`scim_list_users` (tenantId, filter?, startIndex?, count?), `scim_get_user`,
`scim_list_groups`, `scim_service_provider_config`.

**Write (в read-режиме не регистрируются):**
`scim_create_user` (userName/name/emails/active/roles), `scim_update_user`
(PATCH active/name/emails/roles/userName через SCIM PatchOp),
`scim_delete_user`, `scim_create_group` (displayName/members), `scim_update_group`
(PATCH displayName/members), `scim_delete_group`.

Ошибки — по-русски и с подсказками: нет `AGIL_SCIM_TOKEN`; 401/403 (токен/права),
404 (нет пользователя/группы), 409 (дубль userName/displayName), 501 (SCIM выключен).
`roles[].agilRole` — только данные SCIM и **не дают admin-прав**; роль в AGIL
выдаётся отдельно через access policy/token. `active:false` — soft-деактивация,
DELETE — удаление ресурса.

**Пример:** `scim_list_users({ tenantId: "demo", filter: "userName eq \"alice@example.com\"", count: 1 })`;
`scim_create_user({ tenantId: "demo", userName: "bob@example.com", name: { givenName: "Bob" }, emails: [{ value: "bob@example.com", primary: true }], active: true })`;
`scim_update_user({ tenantId: "demo", id: "u2", active: false })`.

## Egress / RTMP / HLS (запись и трансляции)

Egress-воркер управляется backend API (`/v1/rooms/:roomId/egress/*`,
`/v1/admin/egress/status`); MCP только вызывает его административным ключом.

- **Read:** `egress_status` — статус воркера (`configured/workerConfigured/detail`);
  `egress_list { roomId }` — сессии комнаты (`kind/status/startedAt`).
- **Write:** `egress_start_recording { roomId }` (kind=recording),
  `egress_start_rtmp { roomId, rtmpUrl }` (kind=rtmp, только `rtmp(s)://`),
  `egress_start_hls { roomId }` (kind=hls), `egress_stop { roomId, sessionId? }`
  (без sessionId — остановить все сессии комнаты). В `AGIL_MCP_MODE=read` write-инструменты
  не регистрируются.

Безопасность: RTMP URL и stream key **не возвращаются** — ответы рекурсивно
редактируются (`url`/`rtmpUrl`/`streamKey`/`token` → `[redacted]`, URL в строках →
`[redacted-url]`); ошибки на русском без URL/ключей. Ошибки: 401/403 (права),
404 (комната/сессия), 409 (уже запущен/остановлен), 501 (egress-воркер не настроен),
400 (неверный kind/rtmpUrl). Перед стартом рекомендуется `egress_status` +
`egress_list`; `egress_list` использует `/egress/list` и делает fallback на `/egress`
для совместимости со сборками backend.

**Пример:** `egress_list({ roomId: "room-1" })` → `egress_start_recording({roomId:"room-1"})`
→ `egress_stop({roomId:"room-1", sessionId:"e1"})`; RTMP:
`egress_start_rtmp({roomId:"room-1", rtmpUrl:"rtmps://live.example/key"})` (URL не попадёт в ответ).

## Биллинг и квоты (read-only)

Два read-only инструмента, доступны и в `AGIL_MCP_MODE=read`. Оплат и card data
нет; метринг и admin API описаны в `agil/core/docs/billing.md`.

- `billing_usage { month? }` → `GET /v1/admin/billing/usage[?month=YYYY-MM]`.
  Возвращает `plan`, `enforcementEnabled`, `overagePolicy`, `usage`
  (minutes/roomsCreated/participantJoins/peakParticipants/recordings/recordingMinutes),
  `live` (activeRooms/activeParticipants/liveMinutes/totalMinutes), `quota`
  (лимиты, minutesRemaining/overageMinutes), `months` и `warnings`. Без `month` —
  текущий UTC-месяц; неверный формат отклоняется схемой инструмента.
- `billing_status {}` → `GET /v1/admin/billing/plan`. Возвращает `plan`,
  `enforcementEnabled`, `includedMinutes`, `maxParticipants`, `maxRooms`,
  `overagePolicy`, каталог `plans` (free/team/business/enterprise) и сводку
  `usage`. Полезно, чтобы объяснить 402/429/quota_exceeded у комнат.

**Пример:** `billing_status({})` → понять лимиты; `billing_usage({month:"2026-11"})`
→ показать расход и предупреждения. Ошибки: 401/403 (нужен admin-ключ тенанта),
400 (формат месяца), 404 (старая сборка без billing endpoints).

## Примеры диалогов

**«Сделай бренд под компанию Acme, цвет #ff6b00»**

1. `agil_generate_theme({ brandColor: "#ff6b00", preset: "corporate" })` → тема, CSS-переменные, проблемы контраста.
2. `agil_apply_theme_to_config({ config: <текущий или {}>, brandColor: "#ff6b00" })`.
3. `agil_validate_config({ config })` → ошибки/предупреждения.
4. `agil_update_config({ patch, dryRun: true })` → diff, затем `agil_update_config({ patch })`.
5. `agil_get_embed_snippet({ room: "acme-demo" })`.

**«Проверь контраст моей темы»**

`agil_audit_accessibility({ theme })` → `passed`, список issues с текущим ratio и
предложенным цветом. Если ошибок нет, модель честно ответит, что тема проходит WCAG AA.

**«Создай тестовую комнату и ссылку»**

`agil_create_room({ name: "Тест", maxParticipants: 8 })` → `joinUrl`/`embedUrl`/`token`;
при необходимости `agil_create_invite({ roomId, ttlSec: 3600 })`.

**«Ограничь гостям запись и knowledge-агент»**

`agil_get_access_policy({})` → `agil_set_access_policy({ policy: { roleDefaults: { guest: [...] } }, dryRun: true })`
→ посмотреть effective для гостя → `agil_set_access_policy({ policy })` без dryRun.
Оффлайн можно прикинуть: `agil_explain_access({ role: "guest" })`.

**«Дай пользователю user-42 доступ к ассистенту»**

`agil_get_config({})` → патч `security.accessPolicy.userOverrides["user-42"]` с
`knowledgeAgent` в списке → `agil_validate_config` → `agil_update_config({ patch, dryRun: true })`
→ `agil_update_config({ patch })`.

**«Покажи OpenAPI и добавь вебхук на analysis.ready»**

`agil_get_openapi({ tag: "webhooks" })` → `agil_get_webhooks({})` →
`agil_set_webhooks({ webhooks: [{ id: "siem", url: "https://...", events: ["analysis.ready"], secretEnv: "AGIL_WEBHOOK_SIEM_SECRET", enabled: true, retries: 3, timeoutMs: 5000 }] })`
→ `agil_test_webhook({ endpointId: "siem" })`.

**«Разбери транскрипт на compliance»**

`agil_analyze_compliance({ segments, rules })` → findings по severity с цитатами;
`agil_summarize_meeting({ segments })` → summary, выдержки, action items.

**«Встрой чат компании вместо встроенного»**

`agil_set_chat_mode({ sessionChat: { ui: "external", externalProviderName: "Corp Messenger", allowHostInjection: true, allowSystemMessages: true } })`
→ виджет прячет свой чат, отдаёт сообщения через `agil:chat`/`onEvent('chat')`, а хост отправляет ответы
`instance.sendChat()` / `postMessage {type:'agil:chat-send'}` / `POST /v1/rooms/:roomId/chat`.
Для бота/CRM без WebSocket — `agil_post_room_chat({ roomId, text, kind: "system", from: { name: "Бот" } })`.

**«Сверни звонок в мини-окно и не теряй его при переходах»**

`agil_get_embed_snippet({ room: "team-sync", chrome: "compact", minimized: { enabled: true, mode: "bubble", position: "bottom-right", showSelfView: true, keepControls: true }, persistAcrossPages: true })`
→ в сниппете `config.layout` с mini-режимом и комментарий про `AGILCalls.resume()` на следующей странице.
`chrome: "none"` — вариант «звонок как часть страницы», без собственной шапки.

**«Замени чат на корпоративный мессенджер»**

`agil_get_providers({})` → `agil_set_providers({ providers: { chat: { mode: "external", providerName: "corp-messenger", endpoint: "https://example.com/agil/chat", apiKeyEnv: "AGIL_CHAT_PROVIDER_KEY", fallback: "builtin", timeoutMs: 5000 } }, dryRun: true })`
→ проверить warnings (HTTPS/endpoint/apiKeyEnv) → тот же вызов без `dryRun` → `agil_test_provider({ slot: "chat" })`.
Если нужен ещё и UI компании — `agil_set_chat_mode({ sessionChat: { ui: "external", externalProviderName: "corp-messenger" } })`.
Полное руководство: `agil/core/docs/extensibility.md`, оффлайн — `agil_explain_providers({ slot: "chat" })`.

**«Переключи STT на вендора с fallback на встроенный»**

`agil_set_providers({ providers: { stt: { mode: "external", providerName: "deepgram", endpoint: "https://example.com/agil/stt", apiKeyEnv: "AGIL_STT_PROVIDER_KEY", fallback: "builtin" } }, dryRun: true })`
→ `agil_set_providers({ ... })` → `agil_test_provider({ slot: "stt" })`.
`fallback:"builtin"` означает: при таймауте/ошибке вендора сервер прозрачно использует Web Speech / `AGIL_STT_*`.

**«Сделай 1:1 звонок из чата мессенджера»**

`agil_create_room({ name: "Звонок с Анной", mode: "direct", context: { messenger: "corp-chat", conversationId: "dm-42", directPeerId: "user-7", title: "1:1" } })`
→ `joinUrl`/`embedUrl` для карточки звонка в переписке; `maxParticipants` автоматически = 2. Контекст вернётся в `room.mode`/`room.context` и в `agil_get_room`. Сценарий целиком: `agil/core/docs/messenger.md`.

**«Включи запись и покажи, где кнопка» / «Где чат?»**

`agil_get_assistant_tools({ role: "host" })` → видно, что `start_recording` требует
`recording` + роль host/moderator, а spotlight-target — `recording`.
`agil_explain_spotlight({ target: "recording" })` → где кнопка и как строится тур.
Конфигурация: `agil_set_in_call_agent({ config: { mode: "hybrid", endpoint: "https://example.com/agil/assistant", apiKeyEnv: "AGIL_INCALL_AGENT_KEY", spotlight: true, maxActionsPerReply: 3 }, dryRun: true })`
→ diff/предупреждения → применение. Полный сценарий: `agil/core/docs/in-call-agent.md`.

**«Подготовь тенант к вебинару на 5000»**

`agil_explain_scaling({})` → понять требования (SFU, broadcast, viewerLimit, CDN/стриминг).
`agil_get_scale({})` → текущая топология. Затем `agil_set_scale({ scale: { mediaMode: "broadcast", maxParticipants: 5000, sfu: { provider: "livekit", url: "https://sfu.example.com", apiKeyEnv: "AGIL_SFU_API_KEY", apiSecretEnv: "AGIL_SFU_API_SECRET", maxParticipants: 5000 }, webinar: { enabled: true, hostOnlyPublish: true, viewerLimit: 5000, chatMode: "moderated", reactions: true, raiseHandQueue: true }, streaming: { enabled: true, provider: "rtmp", rtmpUrl: "rtmp://…" } }, dryRun: true })`
→ предупреждения (`sfu.url`, `rtmpUrl`, `cdn.baseUrl`) → тот же вызов без `dryRun`.
`agil_get_cluster_status({})` → какой узел/стратегия LB/Redis.

**«Добавь TURN-пул»**

`agil_explain_scaling({})` → раздел TURN. `agil_set_scale({ scale: { turn: [ { id: "eu-1", urls: ["turn:turn-eu.example.com:3478?transport=udp"], username: "agil", credentialEnv: "AGIL_TURN_EU_CREDENTIAL", region: "eu", weight: 10 }, { id: "us-1", urls: ["turns:turn-us.example.com:5349?transport=tcp"], username: "agil", credentialEnv: "AGIL_TURN_US_CREDENTIAL", region: "us", weight: 10 } ] }, dryRun: true })`.
Секреты — только имена env-переменных; после применения пул уходит в `welcome.iceServers`
(проверить через звонок / `chrome://webrtc-internals`).

**«Создай роль стримера и выдай токен»**

`agil_explain_roles({})` → модель прав и пример стримера.
`agil_create_role({ role: { id: "streamer", name: "Стример", description: "Ведёт трансляцию, без записи", baseRole: "host", features: ["chat","screenShare","fullscreen","knowledgeAgent"], canModerate: false, color: "#8576ff" }, dryRun: true })`
→ предупреждения/валидация → тот же вызов без `dryRun`.
`agil_get_room({ roomId: "…" })` → `agil_create_token({ roomId: "…", name: "Игорь", role: "host", roleId: "streamer" })`
→ токен с эффективными правами роли (`roleId`/`roleName` в ответе). Если состав роли
меняется: `agil_update_role({ id: "streamer", patch: { features: ["chat","screenShare","fullscreen"] }, dryRun: true })`;
удаление — `agil_delete_role({ id: "streamer" })` (живые токены падают на `baseRole=host`).
Полный сценарий: `agil/core/docs/api-guide.md` §3.

**«Проверь, можно ли отключить запись»**

`agil_assess_change({ kind: "config", intent: "выключить запись звонков", next: { features: { recording: false } } })`
→ `risk`, `requiresConfirmation`, `findings` (кто/что затронуто, согласие участников,
аудит, записи в хранилище), `recommendations` (например, оставить `session.recording.enabled`
и выключить только `features.recording`, предупредить тенантов, проверить вебхуки).
Если guard-endpoint ещё не задеплоен — ответ придёт с `fallback:true` из локального
`assessChange`. При `requiresConfirmation=true` модель обязана спросить подтверждение
и не вызывать `agil_update_config` без явного согласия.

**«Создай роль и предупреди о рисках»**

`agil_explain_roles({})` → `agil_create_role({ role: { id: "operator", name: "Оператор", baseRole: "moderator", features: ["chat","participantList","recording"] }, dryRun: true })`
→ `agil_assess_change({ kind: "roles", intent: "новая роль с записью", next: { customRoles: [ … ] } })`
→ показать findings (`recording` + consent, `baseRole=guest`/`canModerate`, лимит 30),
затем при подтверждении `agil_create_role` без `dryRun`, и
`agil_create_token({ roleId: "operator", … })`. Ошибки валидации (reserved id, дубликаты,
пустые features) возвращаются до записи.

## Разработка и тесты

```bash
npm run build -w @agil/mcp
npm run typecheck -w @agil/mcp
npm test -w @agil/mcp        # tsx --test "test/*.test.ts"
```

Тесты делятся на два уровня:

1. `test/unit.test.ts` — чистые функции (темы, валидация, профили, сниппеты, доступы, diff, каталог API).
2. `test/protocol.test.ts` — запускает **собранный** `node dist/index.js` как child
   process и общается с ним по JSON-RPC: `initialize`, `tools/list` (все имена),
   `tools/call` оффлайн-инструментов, `resources/list|read`, `prompts/list|get`,
   а также проверяет, что при недоступном сервере онлайн-инструмент возвращает
   `isError: true` с подсказкой `AGIL_SERVER_URL`, а оффлайн-инструменты продолжают работать.

Поэтому перед тестами нужен `npm run build -w @agil/mcp` (и собранный `@agil/ai`).

## Безопасность

- Транскрипты, конфиги и темы от модели — **недоверенный вход**: всё валидируется zod
  до использования; внешние ответы (сервер/AI-агент) тоже валидируются.
- `AGIL_API_KEY` и `AGIL_SCIM_TOKEN` никогда не пишутся в логи и не попадают в текст ошибок; SCIM-токен берётся только из env.
- `agil_get_embed_snippet` HTML/JS-экранирует `room`, `token`, `serverUrl`, тему и фичи:
  сниппет нельзя «сломать» подстановкой `</script>`.
- Пароль комнаты передаётся один раз и хранится сервером только как scrypt-хэш;
  MCP его не логирует.
- Citation URL knowledge-агента — недоверенные: открывать с `rel="noopener noreferrer"`.
