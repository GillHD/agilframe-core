# Панель разработчика AgilFrame — экраны, API и оффлайн-поведение

Документ описывает `agil/core/apps/dashboard` (§15 контракта) и его интеграцию с сервером
по §4, §14, §18, §19, §22. Панель — отдельное Vite-приложение с base
`/dashboard/`, dev-порт 5175; в продакшене статика раздаётся сервером.

## 1. Принципы

- **Ноль новых зависимостей.** DOM/CSS вручную; тема — `@agil/protocol`
  (`themePresets`, `displayTheme`, `toCssVars`) → светлая/тёмная/авто тема на
  тех же `--agil-*` токенах, что и виджет.
- **Контракт — источник URL.** Все admin-пути берутся из `adminPaths`,
  публичные — из `publicPaths`; конфиг тенанта — `GET/PATCH
  /v1/tenants/:tenantId/config`.
- **Ключ не утекает.** `x-api-key` подставляется клиентом; ключ не пишется в
  логи/ошибки, в интерфейсе — только поле ввода.
- **Оффлайн-устойчивость.** Любой экран при сетевой ошибке показывает
  русскоязычное объяснение и кнопку повтора; при старте — оффлайн-экран с
  инструкцией запуска сервера.

## 2. Маршруты и экраны

```
#/overview              Обзор: KPI, последние комнаты, страны, health, быстрый старт
#/rooms                 Комнаты: поиск/фильтры, создание, invite/embed/lock/delete
#/rooms/:id             Комната: live-участники, чат, транскрипт, заметки,
                        compliance, записи, сообщение от бота
#/security              Безопасность: пароли, гео, integrity, session binding,
                        AI-агент, сводка безопасности, аудит-лента
#/audit                 Аудит: полная таблица, фильтры, пагинация, экспорт JSON
#/access                Доступы: role × feature, strict/role-defaults, denied,
                        userOverrides, выдача токена с permissions
#/integrations          Интеграции: identity/OIDC, allowedOrigins, postMessage,
                        вебхуки + тест доставки, /docs и /openapi.json
#/knowledge             Knowledge-агент: настройки RAG-прокси + «Проверить»
#/recordings            Записи: список, скачивание, удаление
#/infrastructure        Инфраструктура: токены enrollment, резервные Core, реестр
                        узлов (drain/disable/features/capacity) — docs/api/cluster.md
#/settings              Настройки/Embed: креды, генератор сниппета,
                        session.chat/layout (§22), публичные endpoints, MCP, сброс
```

Неизвестный hash → экран «Страница не найдена» (без редиректа, чтобы не
терять введённый маршрут). Пустой hash → `#/overview`.

## 3. Вход и хранение

| Ключ localStorage | Назначение |
|---|---|
| `agil_server_url` | база API; default — `location.origin` |
| `agil_api_key` | ключ тенанта; default `dev-key` |
| `agil_sso_token` | SSO-сессия администратора (JWT, Bearer); живёт недолго (15 мин) |
| `agil_tenant_id` | тенант, определённый по `GET /v1/admin/overview` |
| `agil_dashboard_theme` | `light` \| `dark` \| `auto` |
| `agil_dashboard_sidebar` | `collapsed` \| `expanded` |

Поток входа:

1. если ни ключ, ни SSO-сессия не сохранены — экран входа (поля
   serverUrl/apiKey, dev-подсказка, блок «Войти через SSO»);
2. «Проверить подключение» → `GET /v1/admin/overview` → сохранить и открыть
   панель; при 401 — сообщение про ключ, при сети — оффлайн-панель с
   инструкцией `npm run dev`;
3. при сохранённом ключе — авто-проверка на старте; ошибка снова показывает
   экран входа с объяснением (в т.ч. оффлайн).

## 3.1 Вход через SSO (OIDC)

Кнопка «Войти через SSO» под формой ключа: поле «Организация (tenantId)» (по
умолчанию последний использованный тенант) → `GET /v1/auth/oidc/start` →
переход на `authorizationUrl` корпоративного IdP → возврат на
`/dashboard/#sso_token=…`.

- Токен приходит **только во фрагменте** URL; `main.ts` разбирает его до первого
  рендера, стирает фрагмент (`history.replaceState` → `#/overview`), проверяет
  сессию через `GET /v1/admin/overview` и сохраняет в `localStorage`.
  Переразмеренный (>16 КиБ) или битый `#sso_*`-фрагмент тоже стирается из
  адресной строки, хотя его содержимое не используется.
- Все запросы уходят с `Authorization: Bearer <session>` (без `x-api-key`);
  SSO-сессия никогда не включает платформенный режим.
- Ошибки приходят как `#sso_error=<code>` и показываются русскоязычным
  `alert` вверху карточки входа: `state_invalid`/`state_expired` (ссылка
  использована/истекла, нет cookie привязки), `idp_error`/`access_denied` (IdP),
  `invalid_identity_token` (iss/aud/azp/exp/nonce/alg), `identity_not_verified`,
  `identity_not_allowed` (email/домен/группа), `tenant_mismatch`,
  `identity_not_configured`, `validation_failed`; истёкшая или отвергнутая сессия —
  отдельный экран «SSO-сессия истекла» (токен удаляется). Код ошибки из URL
  проверяется строгим regex, неизвестный код показывается без отражения текста.
- В URL, DOM, логах и сообщениях об ошибках токена нет; поле ключа при активной
  SSO-сессии помечено как необязательное, а ввод ключа завершает SSO-сессию.
- Выход (`logout` в меню) и переход на API-ключ вызывают
  `POST /v1/auth/oidc/logout` (серверный отзыв `jti`), затем удаляют
  `agil_sso_token`, ключ и тенант; при недоступном сервере локальный выход всё
  равно выполняется (TTL сессии 15 минут — страховка).

Статус сервера в топбаре обновляется `GET /v1/health` при старте, каждые 30 с,
при `online`/`offline` событиях браузера и возврате вкладки в фокус.

## 4. Используемые эндпоинты

### Публичные

| Метод | Путь | Где |
|---|---|---|
| GET | `/v1/health` | статус в топбаре, карточка сервера, «Проверить подключение» |
| GET | `/v1/auth/oidc/start` | кнопка «Войти через SSO» (tenantId + returnTo) |
| GET | `/v1/auth/oidc/callback` | возврат от IdP → `#sso_token=…` (навигация браузера, не вызов панели) |
| POST | `/v1/auth/oidc/logout` | выход / переход на API-ключ → серверный отзыв сессии |
| GET | `/v1/tenants/:tenantId/config` | безопасность, интеграции, режим чата в комнате, «Встраивание и поведение» |
| PATCH | `/v1/tenants/:tenantId/config` | сохранение security/integrations/chat/layout |
| POST | `/v1/tokens` | генерация токена (экран «Доступы» и embed-генератор) |

### Admin (`x-api-key` или `Authorization: Bearer <SSO-сессия>`)

| Метод | Путь | Где |
|---|---|---|
| GET | `/v1/admin/overview` | вход, обзор |
| GET | `/v1/admin/rooms` | обзор, комнаты, доступы, настройки |
| POST | `/v1/admin/rooms` | создание тестовой комнаты |
| GET | `/v1/admin/rooms/:id` | карточка комнаты + поллинг 3 с |
| DELETE | `/v1/admin/rooms/:id` | удаление |
| POST | `/v1/admin/rooms/:id/invites` | приглашение с токеном |
| POST | `/v1/admin/rooms/:id/lock` | lock/unlock |
| POST | `/v1/admin/rooms/:id/kick` | kick участника |
| POST | `/v1/admin/rooms/:id/chat` | «Сообщение от системы/бота» (§22) |
| GET | `/v1/admin/rooms/:id/transcript` | вкладка «Транскрипт» |
| GET | `/v1/admin/rooms/:id/analysis` | вкладки «Заметки»/«Compliance» |
| POST | `/v1/admin/rooms/:id/analysis/run` | «Запустить анализ» |
| GET | `/v1/admin/audit` | аудит: фильтры `type/severity/roomId`, пагинация `limit/offset`, ответ `AuditListResponse {entries,total,offset,limit}` |
| GET | `/v1/admin/security` | сводка безопасности |
| GET | `/v1/admin/recordings?roomId=` | записи (общий список и комната) |
| DELETE | `/v1/admin/recordings/:id` | удаление записи |
| GET/PUT | `/v1/admin/ai-agent` | AI-агент |
| GET/PUT | `/v1/admin/access-policy` | матрица прав |
| GET/POST | `/v1/admin/roles` | встроенные + свои роли компании |
| PUT/DELETE | `/v1/admin/roles/:roleId` | редактирование/удаление своей роли |
| GET/PUT | `/v1/admin/knowledge-agent` | knowledge-агент |
| POST | `/v1/admin/knowledge/ask` | «Проверить» knowledge-агента |
| GET/PUT | `/v1/admin/webhooks` | вебхуки + последние доставки |
| POST | `/v1/admin/webhooks/test` | тест доставки |
| GET/PUT | `/v1/admin/providers` | статус и настройка 6 слотов провайдеров (§23) |
| POST | `/v1/admin/providers/test` | тестовый вызов слота, `{ok,latencyMs,detail}` |
| GET/PUT | `/v1/admin/scale` | `ScaleStatusResponse` / merge `{scale}` (§24) |
| GET | `/v1/admin/cluster/status` | узлы, strategy, redisConfigured, `multiNodeActive` |
| POST | `/v1/admin/scale/turn/test` | проверка TURN-сервера по `{id}` |

### Ссылки на соседние приложения

- `/docs` — API Explorer, `/openapi.json` — спецификация (§20);
- `agil/core/docs/security-audit.md` — отчёт по безопасности (относительная ссылка из
  `/dashboard/`; при `AGIL_DOCS_DIR` открывается с сервера).
- `agil/core/docs/extensibility.md` — провайдеры и расширяемость (ссылка на экране
  «Интеграции»);
- `agil/core/docs/messenger.md` — интеграция звонков в корпоративный мессенджер
  (ссылка в настройках и интеграциях);
- `agil/core/docs/scaling.md` — масштабирование, мульти-нода, TURN-пул, SFU, вебинары;
- `agil/core/docs/backlog.md` — roadmap-план (масштабирование — блок B);
- `agil/core/docs/api-guide.md` — понятное руководство для интегратора, `agil/core/docs/api.md` —
  reference, `agil/core/docs/contract.md` — контракт монорепо (ссылки в настройках и
  интеграциях);
- demo и редактор: в продакшене `/index.html` и `/editor/` того же origin, в dev —
  `localhost:5173/index.html` и `localhost:5174/editor/` (вычисляется по порту 5175,
  override — `VITE_DEMO_URL`, `VITE_EDITOR_URL`);
- «Открыть демо» из приглашения ведёт на `/embed.html` с комнатой, организацией и токеном. При заданном `VITE_DEMO_URL` приглашение использует указанный адрес.
- MCP: конфиг stdio и env (`AGIL_SERVER_URL`, `AGIL_API_KEY`,
  `AGIL_TENANT_ID`) с копированием; документация — `agil/core/docs/mcp.md`.

## 5. Скриншот-описание экранов

**Вход.** Центрированная карточка на градиентном фоне: логотип, два поля
(адрес сервера, API-ключ с иконкой «показать»), кнопка «Проверить
подключение», подсказка про `dev-key`, ссылки Demo/Редактор/API docs; при
ошибке — красный алерт или оффлайн-панель с командами запуска. В правом верхнем
углу — переключатель темы.

**Обзор.** Слева сайдбар (Обзор, Комнаты, Безопасность, Аудит, Доступы,
Интеграции, Knowledge-агент, Записи, Настройки и Embed; внизу — Demo/Редактор/
API agil/core/docs/OpenAPI/Security audit и версия). В топбаре — статус сервера, чип
тенанта, переключатель темы, «Выйти». Далее: 4 KPI-плитки с цветной полосой
(активные комнаты, участники, записи, события безопасности за 24 ч), таблица
последних комнат и бары стран, карточки «Быстрый старт» и «Сервер» (health,
uptime, подсистемы).

**Комнаты.** Панель фильтров над таблицей (поиск, пароль, замок, счётчик,
сброс). В строке: название+ID+контекст мессенджера, «2 / 12», тип
(`1:1`/`группа`), бейджи «Да/Нет», «Открыта/Закрыта», дата, число записей и ряд
иконок-действий (join, embed, demo, приглашение, lock/unlock, удалить).
Создание комнаты — модалка с валидацией, генератором пароля, `mode`
group/direct, `maxParticipants` (2–50 000, дефолт из `scale.maxParticipants`),
полями контекста мессенджера и read-only эффективным `mediaMode` из
`GET /v1/admin/scale` (per-room mediaMode сервер пока не принимает); после
создания — модалка ссылок и токена с предупреждением.

**Комната.** Хлебные крошки «Все комнаты», название, ID, чипы «Открыта»,
«Пароль», «N онлайн», «чат: встроенный/внешний/скрыт», тип комнаты
(`1:1`/`группа`), messenger/context. Кнопки «Обновить», «Сообщение от бота»,
«Приглашение», «Закрыть/Открыть», «Удалить». Карточка подключения:
join/embed строки с копированием и открытием demo, KV-параметры (включая тип
комнаты и контекст мессенджера).
Карточка live-участников: имя/ID, роль, локация (флаг, город, источник IP/GPS,
VPN?, точность GPS), identity, integrity, mic/cam/экран/рука, права, kick.
Вкладки: чат (с баннером для external/hidden), транскрипт, заметки, compliance,
записи. Внешний вид: светлая/тёмная тема, карточки с мягкой тенью.

**Безопасность.** Две колонки: слева формы (пароли, гео, integrity, session
binding, AI-агент с редактором правил), справа сводка (KPI отказов/блокировок/
подозрительных, бары стран) и лента аудита с фильтрами. Вверху — «Сохранить
настройки». Пояснения про 152-ФЗ и отсутствие GPS-координат в UI.

**Аудит.** Выберите тип и уровень события, укажите ID комнаты при необходимости
и нажмите «Применить» или Enter. В строке события «Подробности» раскрывают
дополнительные поля. Переход между страницами, кнопка «Обновить» и «Экспорт JSON»
используют применённые фильтры. «Сбросить» возвращает все события и 50 строк на странице.
Экспорт сохраняет до 500 последних совпадений и указывает общее число найденных записей.
Панель читает журнал текущего процесса Core из буфера на 2000 событий. События
организации и фильтры отбираются до разбивки на страницы. Долговременный журнал
хранится в JSONL и может передаваться в SIEM.

**Доступы.** Слева карточка «Роли» (встроенные host/moderator/guest с бейджем
builtin и кнопкой «Изменить права» → фокус на матрице; свои роли с baseRole,
функциями, цветом, `assigned`, кнопками «Редактировать»/«Удалить»; «Создать
роль» → модалка id/name/description/baseRole/функции/canModerate/color;
409/400/403 показываются понятными сообщениями). Ниже — матрица: селектор
режима, таблица с группами фич и чекбоксами по ролям
(host/moderator/guest), кнопки «все», блок глобально запрещённых фич и
редактор userOverrides. Справа — «Выдать токен» (комната, имя, роль, своя роль
roleId, userId, TTL, пиннинг прав) и карточка эффективных прав с вычислением
через `resolveAccess`; результат показывает roleName/roleId и эффективные
функции.

**Интеграции.** Карточка identity (режим, issuer, audience, JWKS,
OIDC-discovery (`discovery`/`discoveryUrl`), OIDC-эндпоинты
входа: authorizationEndpoint, tokenEndpoint, clientId, clientSecretEnv (только
привязанное к тенанту имя — `AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>` для канонического
lower-case id или **точная** запись в `AGIL_OIDC_TENANT_SECRETS`), redirectUri,
scopes, tokenEndpointAuthMethod (post/basic), responseMode (query/form_post),
endSessionEndpoint/postLogoutRedirectUri для RP-initiated logout, маппинг claims;
политика доступа: email/email_verified claims,
allowedEmails/allowedEmailDomains, groupsClaim, groupRoleMap, dashboardAdminGroups,
tenantClaim, maxTokenAgeSec/clockSkewSec; allowedOrigins, postMessage), карточка
«Провайдеры» (6 слотов:
chat/files/stt/notifications/recording/backgrounds — mode, providerName,
configured/available, fallback, note, кнопка «Тест» с latency/detail и режим
редактирования → PUT), карточка «Масштабирование» (mediaMode,
cluster/nodeId/узлы/strategy/redis/sticky/multiNodeActive, TURN-пул с тестом,
SFU/webinar/streaming, баннер limitations; редактор scale и сохранение через
PUT /v1/admin/scale), карточка вебхуков: раскрывающиеся строки с URL,
секретом-env, ретраями, таймаутом, чипами 12 событий, тестом и удалением;
ниже — таблица последних доставок и карточка документации API с
CSP-предупреждением и ссылками `agil/core/docs/extensibility.md`, `agil/core/docs/messenger.md`,
`agil/core/docs/scaling.md`, `agil/core/docs/backlog.md`.

**Knowledge-агент.** Слева настройки (enabled, endpoint, env-ключ, таймаут,
роли, requirePermission, citations, промпт, denyMessage), справа — «Проверить»:
вопрос, роль, userId/roomId, кнопка и карточка ответа с цитатами.

**Записи.** KPI-сводка (количество, размер, длительность, с транскриптом),
фильтр по комнате и таблица с кнопками скачивания/удаления.

**Настройки и Embed.** Слева подключение, генератор (комната, тема, токен,
фичи, chat/layout/resume, два code-блока SDK/iframe, предпросмотр iframe) и
«Встраивание и поведение». Справа публичные endpoints, документация/OpenAPI/
security-audit/MCP-конфиг и сброс настроек.

## 6. §22: внешний чат и мини-окно- В комнате бейдж режима чата берётся из `GET /v1/tenants/:id/config`
  (`session.chat.ui`). Для `external`/`hidden` показывается баннер: панель
  мониторит историю, а не рисует чат.
- «Сообщение от системы/бота» → `POST /v1/admin/rooms/:id/chat` с телом
  `{text, kind:'text'|'system', from:{name, role}, id}` (id —
  идемпотентность). Если `allowSystemMessages=false`, вариант `system`
  отключён; при `allowHostInjection=false` выводится предупреждение.
- «Встраивание и поведение» сохраняет `session.chat` и `layout.chrome`,
  `layout.minimized.{enabled,mode,position,showSelfView,keepControls}`,
  `layout.persistAcrossPages`, `layout.inheritHostStyles` через PATCH.
- `allowedOrigins` (и identity/postMessage) правятся только через admin API
  (`PATCH /v1/tenants/:tenantId/config`); отдельного публичного эндпоинта нет.
  Для iframe это единственный способ разрешить внешний origin, если сервер
  включил CSP `frame-ancestors`/`X-Frame-Options`; панель честно предупреждает,
  что гарантировать встраивание нельзя.
- Генератор передаёт режим чата через `config.session.chat.ui` и оформление
  через `config.layout.chrome`. Для восстановления в той же вкладке он
  добавляет `layout.persistAcrossPages` и `resume:true`. iframe принимает
  эквивалентные параметры `chat`, `layout` и `resume=1`. Список функций
  применяется к сниппету SDK. Остальные настройки загружаются с сервера.

## 6а. §23: заменяемые провайдеры

Экран «Интеграции» содержит блок «Провайдеры» для 6 слотов
(`chat/files/stt/notifications/recording/backgrounds`):

- **статус** — `GET /v1/admin/providers`: `mode` (builtin/external/disabled),
  `providerName`, `configured`, `available`, `fallback`, `note`;
- **тест** — `POST /v1/admin/providers/test {slot}` → `{slot, ok, providerName,
  latencyMs, detail}`; результат показывается inline (OK/ОШИБКА · мс · detail)
  и тостом;
- **редактирование** — режим переключается кнопкой «Редактировать»; поля
  `mode/providerName/endpoint/apiKeyEnv/timeoutMs/fallback` правятся по слотам,
  сохранение — `PUT /v1/admin/providers {providers}` (merge в конфиг тенанта).
  `options` провайдера сохраняются как есть;
- пояснение в UI: по умолчанию всё **builtin** и работает автономно;
  **external** — система компании (сервер вызывает endpoint с HMAC-подписью и
  таймаутом), **fallback** решает, откатиться на builtin или вернуть 502;
  **disabled** — возможность выключена;
- ссылка на `agil/core/docs/extensibility.md`.

`providers.*` — маршрутизация/хранение; что именно рисует виджет, по-прежнему
определяет `session.chat.ui` и layout (§22).

## 6б. Комнаты из мессенджера

Модалка создания комнаты содержит `mode` (`group` по умолчанию / `direct`) и
опциональный контекст: `messenger`, `conversationId`, `directPeerId`, `title`
→ `POST /v1/admin/rooms {tenantId,name,mode,transport,maxParticipants,ttlSec,context?}`.
Для `direct` лимит участников фиксируется на 2, для `group` — обычный диапазон
2–200. Для `direct` доступен `transport`:

- **SFU** — текущий режим (эффективный медиаплейн организации);
- **P2P** — напрямую между браузерами, ровно 2 места, без серверного медиа.
  Панель предупреждает о двух местах, видимости IP-адресов собеседнику и TURN,
  а также о том, что серверная запись/трансляция/вебинар вернут 409
  (`p2p_unsupported`, docs/p2p.md).

Селектор `transport` отключён для `group`; для `group` поле не отправляется
(сервер отклонил бы его 400). Пустые поля контекста не отправляются.

`room.mode` и `room.context` возвращаются в `RoomInfo` (создание/join/welcome/
admin detail) и показываются:

- в таблице комнат — колонка «Тип» (`1:1`/`группа`) и строка контекста под ID
  (messenger · title/conversationId);
- в карточке комнаты — чипы типа и контекста, а также KV-блок «Тип комнаты» и
  «Контекст мессенджера» (включая directPeerId);
- в окне результата создания — бейджи режима/messenger/title.

Если сервер не вернул `mode`, панель считает комнату групповой; если нет
`context` — контекст не отображается. Поток «позвонить из чата» описан в
`agil/core/docs/messenger.md`, ссылка на него есть в «Настройках» и «Интеграциях».

## 6в. §24: масштабирование, мульти-нода, TURN, SFU, вебинары

Карточка «Масштабирование» на экране «Интеграции»:

- **статус** — `GET /v1/admin/scale` (`ScaleStatusResponse`): эффективный
  `mediaMode`, `config.scale`, cluster-сводка (`nodeId`, `nodes`, `strategy`,
  `redisConfigured`, `stickySessions`), TURN-пул с флагами
  `usernameConfigured`/`credentialConfigured`, `sfuConfigured`,
  `webinarEnabled`, `streamingProvider`, `limitations`; отдельно
  `GET /v1/admin/cluster/status` добавляет `multiNodeActive`. Показываются
  таблица узлов (healthy/null), TURN-таблица с inline-тестом, KV-сводка и
  предупреждающий баннер «кластер/SFU/стриминг не реализованы» (текст берётся
  из `limitations`, иначе — дефолтная формулировка MVP).
- **тест TURN** — `POST /v1/admin/scale/turn/test {id}` → `{ok, latencyMs,
  detail}`; результат inline и тостом.
- **редактор** — `PUT /v1/admin/scale` (merge `{scale}`): mediaMode,
  maxParticipants (2..50000), maxVideoSubscriptions; signaling (nodeId,
  redisUrl, pubsubChannel, stickySessions + таблица узлов id/url/region/weight);
  sfu (provider/url/apiKeyEnv/apiSecretEnv/region/maxParticipants); TURN-пул
  (id, urls по одному на строку, username, credentialEnv, region, weight);
  loadBalancer; webinar (enabled/hostOnlyPublish/viewerLimit/chatMode/reactions/
  raiseHandQueue); streaming (enabled/provider/rtmpUrl/hlsUrl/latencyMode); cdn
  (enabled/baseUrl/provider).
- **валидация**: `redis(s)://` для redisUrl, `http(s)://` для URL узлов/CDN/HLS,
  `ws(s)://` для SFU, `turn:`/`turns:` для каждого TURN-URL, `rtmp(s)://` для RTMP;
  секреты — только имена env-переменных (`ENV_NAME`); ошибки собираются в
  alert, сохранение блокируется до исправления.
- MVP-факт: реально работает single-node mesh; конфигурация кластера/SFU/
  вебинаров/стриминга принимается, валидируется, влияет на `welcome.iceServers`
  и лимиты комнат, но оркестрация — roadmap (`agil/core/docs/scaling.md`,
  `agil/core/docs/backlog.md`, блоки B1–B6). Ссылки на оба документа — в карточке, а
  также в «Настройках».
- В создании комнаты показывается эффективный `mediaMode` из scale и лимит
  участников до 50 000; `RoomInfo.mediaMode`/`maxParticipants` отображаются в
  карточке комнаты и окне создания.

## 7. Оффлайн-режим и ошибки

Роли и доступы: `GET /v1/admin/roles` отдаёт встроенные и свои роли;
панель сохраняет `customRoles` при PATCH/PUT политики, поэтому создание/
удаление ролей не теряется при сохранении матрицы. Встроенные роли
host/moderator/guest не удаляются — их права меняются в `roleDefaults`
(кнопка «Изменить права» ведёт к матрице). Удаление своей роли не завершает
звонки: активные участники получают `baseRole`. Токен можно выдать с
`participant.roleId` — в результате показываются `roleName` и эффективные
`permissions`.

Контраст и оверлеи (QA `agil/core/docs/qa-visual.md`): панель переопределяет только
локальные производные цвета (`--dash-color-muted/link` = color-mix токена с
`--agil-color-text`) и не мутирует тему тенанта; computed-contrast для th,
ссылок и навигации ≥4.57:1 в light/dark/auto. Тосты имеют `z-index` ниже
topbar/sidebar, ограничены `max-height` и на мобильном идут над нижней кромкой,
поэтому не перекрывают «Настройки/Выйти»; сайдбар на узком экране off-canvas.

- Сеть/таймаут (10 с; `analysis/run` — 30 с) → `ApiError` с кодами
  `offline`/`timeout`; экран показывает «Сервер недоступен», инструкцию запуска
  и «Повторить». Для анализа таймаут не означает ошибку: панель сообщает, что
  прогон продолжается на сервере, и предлагает обновить вкладку.
- 401 → «Нет доступа», подсказка про `dev-key`; 403 → ключ чужого тенанта;
  4xx/5xx — русские сообщения по коду (`validation_failed`, `room_locked`,
  `not_found`, …).
- Битый JSON/пустой ответ → `invalid_response` с просьбой проверить версию
  сервера.
- Кнопки обновления и мутаций имеют loading-состояние и не дублируют запрос.

## 8. Известные ограничения

1. **Синхронный `analysis/run`.** В MVP прогон AI-агента синхронный;
   клиент ждёт до 30 с, кнопка disabled на время запроса. При таймауте
   показывается «Анализ продолжается на сервере — обновите вкладку через
   минуту» и остаётся кнопка «Обновить» (на вкладках «Заметки»/«Compliance»).
   Async-job — roadmap.
2. **Записи комнаты** читаются через `GET /v1/admin/recordings?roomId=`;
   отдельного «room recordings» эндпоинта нет и не требуется.
3. **`agil/core/docs/security-audit.md`** — ссылка относительная
   (`../docs/security-audit.md` из `/dashboard/`), чтобы не зависеть от
   хардкода. Если сервер не раздаёт `AGIL_DOCS_DIR`, файл открывается из
   репозитория; при настроенной раздаче — по `/docs/security-audit.md`.
4. **Локация участника.** Панель читает `participant.location` (страна/город,
   источник, vpnSuspected, accuracy) и откатывается на `participant.country`;
   координаты не отображаются. Если сервер не отдаёт `location`, колонка
   показывает «источник: IP» только при наличии `country`.
5. **Права участника.** Колонка «Права» появляется, только если сервер вернул
   `participant.permissions`; иначе скрывается.
6. **iframe/CSP.** Сервер добавляет security headers и может запретить
   встраивание через `frame-ancestors`/`X-Frame-Options`. `allowedOrigins`
   задаются через admin API; в UI есть предупреждение и кнопка «Проверить
   iframe» (детектор по таймауту загрузки), но гарантии встраивания нет.
7. **Качество ссылок demo/editor** в dev вычисляется эвристикой по порту 5175;
   для нестандартной раскладки — `VITE_DEMO_URL`/`VITE_EDITOR_URL`.
8. **Масштабирование декларативно.** Кластер/SFU/стриминг не реализованы в
   MVP: панель честно показывает баннер limitations, конфиг сохраняется и
   влияет только на ICE/лимиты. TURN-тест в MVP — конфигурационная проверка.
9. **`GET /v1/admin/ai-agent`** при ненастроенном агенте бэкенд отдаёт
   дефолтный конфиг (согласовано); панель дополнительно показывает
   `endpointConfigured`/`apiKeyConfigured` и не хранит секрет.

Решённое ранее (для истории): `publicPaths.tokens` добавлен в protocol;
`AuditListResponse` с `total/offset/limit` и серверным `severity` используется
панелью; `ChatPostRequest/Response` (§22) — из protocol.

## 9. Проверки

```bash
npm run typecheck -w @agil/dashboard   # tsc strict, 0 ошибок
npm run build -w @agil/dashboard       # dist, base '/dashboard/'
```

Дополнительно панель прогнана в headless Chrome с mock-API: все 10 маршрутов,
вкладки комнаты, отправка сообщения бота, переключение темы, генерация
snippet-ов с `chat/layout/resume`, экран входа — без JS-ошибок.
