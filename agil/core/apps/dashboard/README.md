# AgilFrame — панель разработчика (`@agil/dashboard`)

Встроенная Vite-панель для интеграторов AgilFrame: тестовые комнаты и
приглашения, live-мониторинг звонка, безопасность и аудит, права доступа,
корпоративный knowledge-агент, вебхуки и генератор embed-сниппетов.

Без React и UI-библиотек: нативные DOM/CSS, тема — на токенах
`@agil/protocol` (`themePresets` + `toCssVars`, light/dark/auto).

## Запуск

```bash
npm install                       # один раз в корне монорепо
npm run dev                       # server:8787 + demo:5173 + editor:5174
npm run dev -w @agil/dashboard    # только панель: http://localhost:5175/dashboard/
```

В dev-режиме запросы `/v1` и `/sdk` проксируются на `http://localhost:8787`.
В продакшене панель отдаёт сам сервер по `/dashboard/` (base `/dashboard/`).

Проверки:

```bash
npm run typecheck -w @agil/dashboard
npm run build -w @agil/dashboard      # dist с base '/dashboard/'
```

## Вход

1. Сервер: `http://localhost:8787` (по умолчанию — текущий origin).
2. API-ключ: `dev-key` на dev-сервере (задаётся `AGIL_API_KEYS`).
3. «Проверить подключение» → `GET /v1/admin/overview`.

Адрес сервера, ключ и тенант хранятся в `localStorage`
(`agil_server_url`, `agil_api_key`, `agil_tenant_id`). Ключ не логируется и
не показывается в интерфейсе кроме поля ввода (по умолчанию скрыт).

Если сервер недоступен, панель показывает оффлайн-экран с инструкцией
`npm run dev`, не падая; все экраны умеют повторять загрузку.

## Экраны

Маршруты — hash-роутер: `#/overview`, `#/rooms`, `#/rooms/:id`,
`#/security`, `#/audit`, `#/access`, `#/integrations`, `#/knowledge`,
`#/recordings`, `#/settings`.

| Экран | Что делает |
|---|---|
| **Обзор** `#/overview` | KPI (активные комнаты/участники/записи/события безопасности 24ч), последние комнаты, распределение по странам, health сервера, быстрый старт (demo, редактор, API docs, OpenAPI, доступы, knowledge), кнопка «Создать тестовую комнату». |
| **Комнаты** `#/rooms` | Таблица с поиском и фильтрами (пароль/замок): участники X/Y, тип (`1:1`/`группа`), messenger/context, создана, записи. Действия: копировать join/embed, открыть demo, приглашение, lock/unlock, удалить. Создание: имя, roomId, пароль (+генератор), maxParticipants, TTL, `mode` group/direct и контекст мессенджера (messenger/conversationId/directPeerId/title) — результат с join/embed ссылками и токеном. |
| **Комната** `#/rooms/:id` | Join/embed ссылки, статус пароля, бейджи режима чата, типа комнаты (`1:1`/`группа`) и контекста мессенджера. Live-участники с поллингом 3 с: роль, страна/город + источник IP/GPS + VPN?, verified, integrity, mic/cam, права, kick. Кнопка «Сообщение от бота» (POST /v1/admin/rooms/:id/chat). Вкладки: Чат, Транскрипт (сегменты с таймкодами, обновление), Заметки (summary, выдержки с таймкодами, задачи, решения, риски, топики, sentiment), Compliance (findings по severity, фильтр, «Запустить анализ»), Записи (скачать/удалить). |
| **Безопасность** `#/security` | Конфиг тенанта: пароли/lockout, лобби, гео (allowed/blocked ISO-2, blockVpn, `gpsEnabled`, `requireConsent` с пояснением про 152-ФЗ), mediaIntegrity (liveness/порог/autoMute), sessionBinding. AI-агент (§13): mode/endpoint/apiKeyEnv/timeout/batch/policyText + редактор policyRules. Справа — SecurityOverview (failed/blocked joins, suspicious, страны) и аудит-лента безопасности с фильтрами. |
| **Аудит** `#/audit` | Полная таблица (ts, type, severity, tenant, room, participant, country, message, ipHash, details), фильтры по типу/уровню/комнате, пагинация limit/offset, экспорт JSON. Типы безопасности (`geo.blocked`, `password.failed`, `lockout`, `knowledge.query/denied`, `webhook.failed`, `integrity.flagged`, `join.denied`) вынесены в отдельную группу. |
| **Доступы** `#/access` | Секция «Роли»: встроенные host/moderator/guest (builtin, права меняются в матрице) и свои роли компании — создание/редактирование/удаление (`GET/POST/PUT/DELETE /v1/admin/roles`), warning про baseRole и affectedParticipants. Матрица роль × фича (host/moderator/guest), режим `role-defaults`/`strict`, глобальные `deniedFeatures`, `userOverrides`; эффективные права считаются через `resolveAccess` из `@agil/protocol`. Выдача токена: комната, имя, роль, своя роль (roleId), userId, TTL, опциональный пиннинг прав → `POST /v1/tokens`; показ токена/expiresAt/roleName/эффективных прав, копирование, открытие demo, предупреждение «токен = доступ». |
| **Интеграции** `#/integrations` | Identity (token/OIDC, issuer/audience/JWKS, маппинг claims), allowedOrigins, embedPostMessage; блок «Провайдеры» (6 слотов: chat/files/stt/notifications/recording/backgrounds — статус mode/configured/available/fallback из `GET /v1/admin/providers`, «Тест» → POST test с latency/detail, редактор mode/endpoint/apiKeyEnv/timeoutMs/fallback → PUT); карточка «Масштабирование» (mediaMode, cluster/nodeId/strategy/redis/sticky/multiNodeActive, TURN-пул с тестом, SFU/webinar/streaming, limitations; редактор scale: signaling-узлы, SFU, TURN-пул, LB, вебинар, стриминг, CDN → PUT /v1/admin/scale, TURN test); вебхуки (URL, 12 типов событий, secretEnv, ретраи, таймаут), сохранение `PUT /v1/admin/webhooks`, тест `POST /v1/admin/webhooks/test`, последние доставки; ссылки `/docs`, `/openapi.json`, `agil/core/docs/security-audit.md`, `agil/core/docs/extensibility.md`, `agil/core/docs/messenger.md`, `agil/core/docs/scaling.md`, `agil/core/docs/backlog.md` + предупреждение про CSP frame-ancestors. |
| **Knowledge-агент** `#/knowledge` | Настройки `session.knowledgeAgent` (enabled/endpoint/apiKeyEnv/timeout/allowedRoles/requirePermission/citations/maxAnswerChars/systemPrompt/denyMessage) через `GET/PUT /v1/admin/knowledge-agent`. Блок «Проверить»: вопрос → `POST /v1/admin/knowledge/ask`, ответ с цитатами (untrusted URL, `rel="noopener noreferrer"`); если не настроено — понятная подсказка. |
| **Записи** `#/recordings` | Список записей (roomId, размер, длительность, автор, транскрипт), скачивание по подписанной ссылке, удаление; сводка по количеству/размеру/длительности. |
| **Настройки и Embed** `#/settings` | Смена serverUrl/apiKey с проверкой, генератор embed-сниппета (SDK и iframe, тема, фичи, `chat`/`layout`/`resume`, генерация токена), секция «Встраивание и поведение» (`session.chat`, `layout.chrome`, `layout.minimized.*`, `persistAcrossPages`, `inheritHostStyles`) с сохранением через PATCH конфига, карточка «Маскот-помощник и брендинг» (`branding.mascotEnabled/mascotName/mascotUrl/mascotExpressions`, preview и guard-сохранение), публичные endpoints, `/docs` + `/openapi.json` + `agil/core/docs/api-guide.md` + `agil/core/docs/api.md` + `agil/core/docs/contract.md`, конфиг MCP, сброс настроек, предпросмотр iframe и предупреждение про CSP. |
| **Маскот «Аги» + guard** (глобально) | Плавающий draggable-маскот (idle wave, thinking/thumbsup/celebrate/alert/angry, static/аватар-fallback, на 390 — компактный аватар), панель чата с DeepSeek-assistant (7 ролей, стартеры, suggestions, история, локальный fallback при 404/сети), «Что я заметил» (риски из аудита, 429/401), `guardedSave` → `POST /v1/admin/guard/assess` с модалкой риска и чекбоксом «Я понимаю последствия» для критических сохранений. Детали — [agil/core/docs/dashboard-assistant.md](../../docs/dashboard-assistant.md). |

## Типичный сценарий

1. Войти с `dev-key`.
2. **Обзор → «Создать тестовую комнату»**: имя, при желании пароль
   (генератор), лимит участников, TTL → модалка с join/embed и токеном.
3. Скопировать join-ссылку и открыть **Demo** (ссылка в сайдбаре/модалке).
4. В **Комнате** смотреть участников, чат, транскрипт, заметки и
   compliance-findings; при необходимости отправить сообщение от бота.
5. **Безопасность** — настроить гео/пароли/integrity и AI-агента;
   **Аудит** — проверить события; **Доступы** — выдать токен с правами.
6. **Интеграции** — добавить вебхук; **Настройки** — собрать embed-сниппет.

## Замечания по интеграции

- `chat.ui = external|hidden`: панель показывает историю чата для
  мониторинга; сообщения от компании/бота отправляются через
  `POST /v1/admin/rooms/:roomId/chat` (§22).
- Если сервер закрывает iframe через CSP `frame-ancestors`/`X-Frame-Options`,
  встраивание на чужом origin блокируется: добавьте origin в «Интеграции →
  Разрешённые origin» и проверьте вкладку Network; в настройках есть
  «Проверить iframe».
- GPS-координаты в панели не отображаются: только страна/город, источник
  (`IP`/`GPS`) и признак VPN. Согласие на геолокацию фиксируется отдельно.
- Аудит использует серверные `severity` и `offset`, ответ —
  `AuditListResponse` с `total`; пагинация и экспорт считаются по total.
- `analysis/run` в MVP синхронный: кнопка disabled на время запроса (таймаут
  30 с); если сервер не успел, панель пишет «анализ продолжается на сервере» и
  предлагает обновить вкладку.
- `agil/core/docs/security-audit.md` — относительная ссылка из `/dashboard/`: при
  настроенном `AGIL_DOCS_DIR` открывается с сервера, иначе файл берётся из
  репозитория.
- `allowedOrigins`, identity и postMessage правятся только через admin API
  (`PATCH /v1/tenants/:tenantId/config`); публичного эндпоинта для них нет.
- Провайдеры: по умолчанию все 6 слотов `builtin` и работают автономно;
  `external` — endpoint компании с HMAC-подписью, `fallback` решает, откатиться
  на builtin или вернуть 502; правки — через `PUT /v1/admin/providers`
  (экран «Интеграции → Провайдеры», документация `agil/core/docs/extensibility.md`).
- Звонки из мессенджера: создание комнаты с `mode:'direct'|'group'` и
  `context {messenger, conversationId, directPeerId, title}`; панель показывает
  тип комнаты и контекст, подробности — `agil/core/docs/messenger.md`.
- Масштабирование: карточка «Масштабирование» — статус `GET /v1/admin/scale`
  (+`/v1/admin/cluster/status`) и редактор `PUT /v1/admin/scale`; в MVP реально
  работает single-node mesh, конфигурация cluster/SFU/TURN/стриминга
  принимается и влияет на ICE/лимиты, оркестрация — roadmap (`agil/core/docs/scaling.md`,
  `agil/core/docs/backlog.md`).

## Структура

```
agil/core/apps/dashboard/
  index.html
  vite.config.ts          # base '/dashboard/', dev 5175, proxy /v1 и /sdk
  src/
    api.ts                # типизированный admin/public клиент (x-api-key, таймаут 10с)
    auth.ts               # localStorage, проверка подключения
    router.ts             # hash-роутер без зависимостей
    theme.ts              # themePresets/toCssVars, light/dark/auto
    context.ts            # AppContext/ScreenFactory
    links.ts              # demo/editor/docs/security-audit URL
    features.ts           # русские названия и группы фич
    dom.ts, format.ts, errors.ts, storage.ts, icons.ts
    ui/                   # layout, table, card/KPI, badge, modal, toast, tabs,
                          # empty-state, skeleton, copy-button, code-block,
                          # confirm-dialog, controls, audit-entry
    screens/              # login, overview, rooms, room, security, audit,
                          # access, knowledge, integrations, recordings, settings
    styles.css            # только var(--agil-...)
```

## A11y и адаптив

- Сайдбар сворачивается на десктопе (состояние в localStorage) и становится
  off-canvas на мобильных; menu/scrim/Escape управляют drawer.
- Модалки: `role="dialog"`, `aria-modal`, focus-trap, Escape/backdrop,
  возврат фокуса; тосты — `aria-live`/`role="alert"`; таблицы — `th scope`;
  вкладки — `role="tablist"` с roving tabindex и стрелками.
- Уважается `prefers-reduced-motion`; все интерактивные элементы имеют
  `:focus-visible`.
- Контраст (QA `agil/core/docs/qa-visual.md`): локальные `--dash-color-muted` /
  `--dash-color-link` примешивают `--agil-color-text` к токенам, поэтому
  заголовки таблиц, ссылки и навигация дают ≥4.57:1 в light/dark/auto
  (computed-style + WCAG-формула); темы при этом не меняются.
- Тосты ограничены по высоте, `z-index` ниже topbar/sidebar и на мобильном
  растягиваются над нижней кромкой — не перекрывают навигацию, «Настройки» и
  «Выйти»; side-бар на узком экране off-canvas и не закрывает контент.
