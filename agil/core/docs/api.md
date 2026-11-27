# AgilFrame — API (REST + WebSocket)

Версия: **0.1.0** · База: `http://localhost:8787` (все пути с префиксом `/v1`,
кроме `/openapi.json`, `/openapi.admin.json`, `/docs`, `/ws`). Машиночитаемая спека —
**две**: `GET /openapi.json` — только публичные эндпоинты (без admin-путей и схемы
`x-api-key`); `GET /openapi.admin.json` — полная спека (внутренний доступ).
Интерактивный офлайн-эксплорер — `GET /docs`. Артефакты для клиентов:
`agil/core/docs/openapi.json` + `agil/core/docs/openapi.admin.json` (`npm run openapi -w @agil/calls-server`).
Публикация agil/core/docs/OpenAPI/admin управляется env — см. §17 и `agil/core/docs/api-exposure.md`.

## Содержание

1. [Аутентификация и права](#1-аутентификация-и-права)
2. [Формат ошибок](#2-формат-ошибок)
3. [Публичный REST](#3-публичный-rest)
4. [Join и пароли](#4-join-и-пароли)
5. [Файлы, записи, STT](#5-файлы-записи-stt)
6. [Внешний чат (без WebSocket)](#6-внешний-чат-без-websocket)
7. [Admin REST](#7-admin-rest)
8. [Доступы, AI- и knowledge-агенты](#8-доступы-ai--и-knowledge-агенты)
9. [Вебхуки (мы → компания)](#9-вебхуки-мы--компания)
10. [WebSocket-сигналинг](#10-websocket-сигналинг)
11. [Mesh-согласование](#11-mesh-согласование)
12. [Лимиты и безопасность](#12-лимиты-и-безопасность)
13. [Коды ошибок](#13-коды-ошибок)

---

## 1. Аутентификация и права

| Креденшл | Как передаётся | Где |
|---|---|---|
| Admin API-ключ тенанта | `x-api-key: dev-key` | конфиг тенанта, `/v1/admin/*`, `POST /v1/tokens` |
| SSO admin-сессия (панель) | `authorization: Bearer <admin session JWT>` | те же tenant-эндпоинты вместо `x-api-key` (§31.1); на `/v1/admin/tenants` — 403 |
| Join-токен участника | `authorization: Bearer <jwt>` | WS, `POST /v1/rooms/:id/chat`, файлы/записи/STT |
| Подписанная ссылка | `?sig=<base64url>&exp=<epoch ms>` | `GET /v1/files/:id`, `GET /v1/recordings/:id` |
| Приглашение | `?token=<jwt>` в `joinUrl`/`embedUrl` | WS |
| Анонимный доступ | без заголовков | `GET /v1/health`, `/v1/ice`, `GET config`, `POST /v1/rooms`, `POST join` (при `AGIL_ALLOW_ANONYMOUS=1`) |

`join` возвращает токен (HS256, TTL 4 ч: `AGIL_TOKEN_TTL_SEC`) и **эффективные
права** `permissions: FeatureKey[]` — тот же список уходит в `welcome.self.permissions`.
Права считает `resolveAccess` из `@agil/protocol`:

```
roleDefaults[role]  →  userOverrides[userId]  →  token.permissions (заменяет всё)
                    →  − deniedFeatures  →  ∩ включённые config.features.*
```

- `security.accessPolicy.mode='strict'` — только явные выдачи;
- токен с `permissions` фиксирует точный список (решает выпускающий);
- клиент **обязан** скрывать кнопки, которых нет в `permissions`; сервер
  параллельно применяет те же правила (chat, assistant, API-инъекция чата).

Пример admin-запроса:

```bash
curl -X POST http://localhost:8787/v1/tokens \
  -H 'content-type: application/json' -H 'x-api-key: dev-key' \
  -d '{"tenantId":"demo","roomId":"<room>","participant":{"name":"Alisa","role":"moderator"},
       "permissions":["chat","screenShare","fileShare"]}'
```

```json
{ "token": "eyJ...", "expiresAt": 1760000000000, "tenantId": "demo",
  "roomId": "<room>", "permissions": ["chat", "fileShare", "screenShare"] }
```

## 2. Формат ошибок

Все ошибки REST — JSON одного вида:

```json
{ "error": { "code": "password_invalid", "message": "Wrong room password" } }
```

`details` (массив issues zod или объект) добавляется для `validation_failed`.
Каждый ответ содержит `x-request-id`. Коды и статусы — в [§13](#13-коды-ошибок).

CORS: по умолчанию `access-control-allow-origin: *` без credentials; если у тенанта
задан `integrations.allowedOrigins`, сервер echoes origin только из списка
(всегда `vary: origin`). Разрешены заголовки `content-type, x-api-key, authorization,
x-file-name, x-recording-meta, x-language, x-request-id, x-agil-country`.

## 3. Публичный REST

### `GET /v1/health`

```bash
curl -s http://localhost:8787/v1/health | jq
```
```json
{ "ok": true, "name": "agil-calls-server", "version": "0.1.0",
  "uptimeSec": 42, "rooms": 1, "tenants": 1,
  "security": { "geoEnabled": false, "integrityEnabled": false,
                "sttConfigured": false, "aiAgentConfigured": false,
                "recordingsDir": "E:/Claude/VideoCalls/.data/recordings" } }
```

### `GET /v1/ice`

```json
{ "iceServers": [ { "urls": "stun:stun.l.google.com:19302" } ] }
```

Публичный метод возвращает только адреса STUN без учётных данных. Если STUN не
настроен, массив пуст. При входе в комнату настройки TURN приходят клиенту в
сообщении `welcome.iceServers` по WebSocket. Для настройки TURN используйте
`AGIL_ICE_SERVERS` или пул организации `scale.turn`.
Для каждого UDP `turn:` URL сервер автоматически добавляет TCP-fallback
(`?transport=tcp`, а для `?transport=udp` — заменой на `tcp`): это спасает в
сетях, где UDP заблокирован. Отключить можно через `AGIL_ICE_TCP_FALLBACK=0`.
Пример ICE-настроек в сообщении `welcome`:

```json
{ "iceServers": [
  { "urls": ["turn:203.0.113.7:3478", "turn:203.0.113.7:3478?transport=tcp"],
    "username": "agil", "credential": "…" }
] }
```

### `GET /v1/host` (публично, кастомные домены)

Резолвит фактический `Host` запроса в тенант (белый список verified-доменов,
см. §25) и отдаёт его брендинг. Нужен, чтобы один и тот же билд landing и
`/embed.html` работал на любом домене без `localhost`/хардкода:

```bash
curl -s -H 'Host: meet.acme.com' http://localhost:8787/v1/host | jq
# → {"host":"meet.acme.com","tenantId":"acme","defaultTenantId":"demo",
#    "resolved":"domain","customDomain":"meet.acme.com","verified":true,
#    "branding":{"productName":"ACME Meet","organizationName":"ACME LLC",
#                "logoUrl":"...","faviconUrl":"...","supportUrl":"...","footerText":"..."}}
```

`resolved:"default"` и `customDomain:""` — неизвестный/неподтверждённый/битый
`Host` (fallback на `AGIL_DEFAULT_TENANT`, никогда не 4xx). Порт, регистр и
точка в конце нормализуются; `x-forwarded-host` учитывается только при
`AGIL_TRUST_PROXY=1`. `?tenant=` в URL остаётся явным override.

### `GET /v1/domain/ask?domain=` (только reverse-proxy)

Approval-hook для on-demand TLS (Caddy `on_demand_tls { ask … }`, HAProxy ACL):
`200 {"allowed":true,"domain":"meet.acme.com"}` для verified домена, `404` для
неизвестного/неподтверждённого, `400` для невалидного имени.

Эндпоинт **не публичный** и по умолчанию выключен:

- `AGIL_DOMAIN_ASK_SECRET` — **обязателен**: пустой секрет = `403` всегда
  (on-demand TLS не работает). Прокси передаёт его заголовком
  `x-agil-domain-ask-secret` или `?key=…`; для Caddy — `?key=`;
- `AGIL_DOMAIN_ASK_HOSTS` — Host hook'а (по умолчанию `127.0.0.1,localhost,::1`).
  Внутренний ask Caddy идёт на `127.0.0.1:8787`, а внешний запрос через
  публичный site-block сохраняет публичный Host и получает `403` (Caddy
  проксирует все пути на один backend, поэтому peer у них одинаковый). `*`
  отключает проверку — только вместе с секретом и path-block;
- `AGIL_DOMAIN_ASK_ALLOW_IPS` — IP/CIDR **TCP-peer сокета** (по умолчанию
  только loopback; пустое значение тоже loopback). `X-Forwarded-For` не
  учитывается. Непустой список без валидных IP/CIDR → `403`, а env-значение
  останавливает старт (fail-closed);
- `AGIL_DOMAIN_ASK_RATE_LIMIT_PER_MIN` — неверные секреты ограничиваются
  per-client, успешные ask — per-peer (`429` + `retry-after`), поэтому внешний
  флуд не исчерпывает лимит Caddy;
- публичный путь `/v1/domain/ask` должен быть закрыт в reverse-proxy
  (`respond 404`), иначе вторая линия — секрет/Host/ACL;
- `tenantId` в ответе **не отдаётся**: прокси достаточно `200`/`404`.

### `GET /v1/tenants/:tenantId/config` (публично)

```bash
curl -s http://localhost:8787/v1/tenants/demo/config | jq '{etag:.etag, primary:.config.theme.colors.primary}'
```
Неизвестный тенант → валидный дефолтный конфиг. Виджет грузит это **до** join
(тема/фичи/лейаут), затем получает `config` ещё раз в join/welcome.

### `PUT|PATCH /v1/tenants/:tenantId/config` (`x-api-key`)

- `PUT` — полный `TenantConfig`, `PATCH` — deep-partial (тема, фичи, security,
  `session.chat`, `layout.chrome`, `integrations`, ...);
- редактор отправляет полный `editorDraft` и `baseEtag` из ответа `GET`. Если после чтения настройки изменились, Core возвращает `409 config_conflict` и сохраняет текущую конфигурацию. В этой форме `security.accessPolicy.userOverrides` и `branding.mascotExpressions` заменяются полностью. Ответ `editorDraftPublished: true` подтверждает запись. Домен организации сохраняется из серверной конфигурации;
- ключ должен принадлежать этому тенанту, иначе `403`;
- невалидная схема → `400` + `details[].path`;
- изменение конфига брокдачится в WS: `{"type":"config","config":{...}}`;
- внешние URL (`session.aiAgent.endpoint`, `session.knowledgeAgent.endpoint`,
  `integrations.webhooks[].url`) проходят SSRF-политику.

```bash
curl -X PATCH http://localhost:8787/v1/tenants/demo/config \
  -H 'content-type: application/json' -H 'x-api-key: dev-key' \
  -d '{"branding":{"productName":"ACME Calls"},
       "theme":{"colors":{"primary":"#0b5fff"}},
       "session":{"chat":{"ui":"external","allowHostInjection":true},
                  "knowledgeAgent":{"enabled":true,"endpoint":"https://kb.example.com/ask"}}}'
```

### Лимиты публичного доступа

Администратор организации может выбрать режим в панели **Безопасность → Лимиты публичного доступа** или отправить `PATCH /v1/tenants/<tenantId>/config` с ключом организации и телом `{"security":{"publicAbuseMode":"observe"}}`. Режим `observe` отмечает превышения в аудите и пропускает запрос по обычным правилам. Режим `enforce` ограничивает запросы. `off` отключает дополнительные лимиты, `null` возвращает настройку сервера. Настройка сервера задаётся через `AGIL_PUBLIC_ABUSE_MODE=off|observe|enforce`. По умолчанию применяется `off`, в том числе для прежних конфигураций без этого поля.

| Действие | С одного IP в организации за минуту | На организацию за минуту |
| --- | ---: | ---: |
| Создание комнаты без API-ключа | 5 | 100 |
| Анонимный вход через REST или WebSocket | 120 суммарно по всем комнатам | 1 000 |

При создании комнат также действует общий порог в 20 запросов за минуту с одного IP по организациям с тем же активным режимом. При `enforce` REST возвращает `429 rate_limited` и `Retry-After` в секундах. Клиенту следует дождаться указанного интервала. Старый WebSocket-клиент без токена получает `rate_limited` и закрытие соединения. Обычный SDK может получить гостевой токен через REST и подключиться по WebSocket с этим токеном. Для ключа организации при создании, подписанного токена этой комнаты и OIDC-личности, подтверждённой по настройкам организации, действуют их обычные ограничения и права.

Фильтр аудита **Превышен лимит публичного доступа** показывает действие, режим и уровень достигнутого порога. Core сохраняет до одной отметки по сочетанию этих параметров за минуту на организацию. Отметки предназначены для наблюдения за превышениями. Счётчики работают в памяти ведущего Core и начинают новое окно после перезапуска или смены ведущего. Обращения с одного NAT делят лимит IP. Защита контролирует частоту запросов. Подтверждение человека требует отдельной проверки.

### `POST /v1/rooms` (анонимно при `AGIL_ALLOW_ANONYMOUS=1`)

Тело: `{tenantId?, roomId?, name?, password?, maxParticipants?, ttlSec?, configOverrides?}`.
`configOverrides.scale.sip.httpUrl`/`wsUrl` проверяются той же SSRF/TLS-политикой,
что и конфиг тенанта: в secure-режиме приватные/loopback/metadata хосты и
`http://`/`ws://` отклоняются 400 до создания комнаты (включая анонимное создание).
Ответ (`200`):

```json
{ "room": { "id":"4f0c...","tenantId":"demo","name":"Demo","createdAt":1760000000000,"locked":false },
  "joinUrl": "http://localhost:8787/?room=4f0c...&tenant=demo&token=eyJ...",
  "embedUrl": "http://localhost:8787/embed.html?room=4f0c...&tenant=demo&token=eyJ...",
  "token": "eyJ...", "expiresAt": 1760014400000, "passwordProtected": false }
```

Для комнаты с паролем токен в ответе не выдаётся — его получают через join/инвайт.

### `POST|DELETE /v1/admin/rooms/:roomId/password` (`x-api-key`)

Смена/установка/снятие пароля комнаты из дашборда:

```bash
# установить свой пароль
curl -X POST http://localhost:8787/v1/admin/rooms/<roomId>/password \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"password":"new-secret-123"}'
# → { "updated": true, "passwordProtected": true, "generated": false }

# сгенерировать: body {} или {"password":""} → вернёт пароль ОДИН раз
curl -X POST http://localhost:8787/v1/admin/rooms/<roomId>/password \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' -d '{}'
# → { "updated": true, "passwordProtected": true, "generated": true, "password": "K7mQ2pX9rT4wZa" }

# снять пароль (комната снова публичная)
curl -X DELETE http://localhost:8787/v1/admin/rooms/<roomId>/password -H 'x-api-key: dev-key'
# → { "updated": true, "passwordProtected": false, "removed": true }
```

Пароль хранится только scrypt-хэшем; `GET /v1/admin/rooms/:id` и списки комнат
отдают лишь `passwordProtected:true` и никогда — пароль или `passwordHash`.
Сгенерированный пароль возвращается **один раз** (в ответе на POST), аудит
`admin.action` kind `room.password.changed` пишется без пароля. Валидация длины
та же, что при создании (1..200 символов); неизвестная комната → `404 not_found`.

### `GET /v1/rooms/:roomId` (`x-api-key`), `DELETE /v1/rooms/:roomId` (`x-api-key`)

`GET` → `{room, participants, createdAt}`. `DELETE` → `{closed:true}` (WS получают `bye`).

### `GET /v1/rooms/:roomId/messages?limit=100` (`x-api-key`)

`{messages: ChatMessage[]}` (история хранит последние 200 сообщений).

## 4. Join и пароли

### `POST /v1/rooms/:roomId/join`

Тело: `{name?, password?, participantId?, locale?}`; опционально
`authorization: Bearer <invite token>` (тогда пароль не требуется).

Проверки по порядку: rate-limit (`AGIL_JOIN_RATE_LIMIT_PER_MIN`, по умолчанию 300/мин на IP+комнату — 200 мест + запас для офисного NAT; брутфорс пароля ограничен отдельным lockout) → lockout после серии
неверных паролей → lock комнаты (`423`) → geo-политика (`403 geo_blocked`) →
пароль (`400 password_required` / `401 password_invalid`, событие
`password.failed` в аудите) → waiting room/moderator-first (`403`) → лимит
участников (`409 room_full`) → выпуск токена + аудит `join.allowed`.

```bash
# без пароля
curl -s -X POST http://localhost:8787/v1/rooms/demo-room/join \
  -H 'content-type: application/json' -d '{"name":"Гость"}'

# с паролем и гео-заголовком (только при AGIL_TRUST_PROXY=1)
curl -s -X POST http://localhost:8787/v1/rooms/secured/join \
  -H 'content-type: application/json' \
  -H 'x-forwarded-for: 203.0.113.7' -H 'x-agil-country: RU' \
  -d '{"name":"Alisa","password":"super-secret-1"}'
```

Ответ:

```json
{ "token":"eyJ...", "expiresAt":1760014400000,
  "room":{ "id":"secured","tenantId":"demo","name":"Secured","createdAt":1760000000000,"locked":false },
  "participant":{ "id":"uuid","name":"Alisa","role":"guest" },
  "config":{ "...": "TenantConfig" },
  "passwordAccepted": true,
  "permissions": ["chat","reactions","screenShare","..."] }
```

Гео-политика: `security.geo.enabled`, `allowedCountries`/`blockedCountries`
(ISO-3166 alpha-2), `blockVpn`. Пустой `allowedCountries` = разрешены все; при
непустом allow-list неизвестная страна блокируется. Страна из заголовков
(`x-agil-country`, `cf-ipcountry`, `x-vercel-ip-country`) принимается только при
`AGIL_TRUST_PROXY=1`; иначе источник — `ipapi` или `none`.

### Инвайты (admin)

`POST /v1/admin/rooms/:roomId/invites` `{ttlSec?, role?}` → `InviteLink`
`{roomId, joinUrl, embedUrl, token, expiresAt, passwordProtected}`.

## 5. Файлы, записи, STT

### `POST /v1/files` (`Bearer` join-токен)

Сырое тело + `content-type` + `x-file-name` (можно percent-encoded). Лимит —
`min(session.fileShare.maxFileSizeMb, AGIL_MAX_UPLOAD_MB)`.

```bash
curl -X POST http://localhost:8787/v1/files \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: text/plain' -H 'x-file-name: notes.txt' \
  --data-binary 'hello AgilFrame'
```
```json
{ "id":"<uuid>", "tenantId":"demo", "roomId":"<room>", "name":"notes.txt",
  "size":16, "mime":"text/plain",
  "url":"http://localhost:8787/v1/files/<uuid>?sig=...&exp=1760086400000",
  "createdAt":1760000000000, "expiresAt":1760086400000, "uploadedBy":"<pid>" }
```

`GET /v1/files/:id?sig=&exp=` — байты (`content-disposition: attachment`).
Битая/просроченная подпись → `403`; небезопасный id → `404`; MIME html/svg/js
запрещены (`415 unsupported_mime`). Событие аудита `file.shared`, вебхук `file.shared`
(ровно один: сразу при AV-off либо после чистого вердикта; для заражённого/заблокированного
файла не эмитится — см. `docs/liveness-av.md` §2.5).

### Записи

`POST /v1/recordings` (`Bearer`) — сырое `video/webm|audio/webm|video/mp4` +
`x-recording-meta: {"roomId":"...","durationSec":123.4,"mimeType":"video/webm"}`.
Требует `session.recording.enabled && storeOnServer`, иначе `403`.
Ответ — `RecordingRecord` (с подписанным `url`); `GET /v1/recordings/:id?sig=&exp=`.
Admin: `GET /v1/admin/recordings?roomId=`, `DELETE /v1/admin/recordings/:id`.
Вебхук `recording.ready`, аудит `recording.saved`.

### `POST /v1/stt/transcribe` (`Bearer`)

Сырое аудио (`audio/webm`, `audio/wav`, ...), `x-language: ru|en`,
`x-translate-to: ru|en|none` (только при `features.translation=true`) и
`x-chunk-offset: <секунды>` для абсолютных таймстемпов сторонних чанкеров.
Не настроен STT → `501 stt_not_configured` (подсказка в `message`).
Ответ `SttResponse {text, provider, language?, durationSec?, segments?}`.
Локальный STT/перевод и лицензионные gates — `docs/stt-translation-local.md`.

## 6. Внешний чат (без WebSocket)

Чат может принадлежать компании (`session.chat.ui = 'builtin'|'external'|'hidden'`).
API-инъекция работает и при `external`, и при `hidden` — в соответствии с
`allowHostInjection` / `allowSystemMessages`, независимо от UI.

### `POST /v1/rooms/:roomId/chat` (`Bearer` join-токен)

```bash
curl -X POST http://localhost:8787/v1/rooms/demo-room/chat \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"Клиент в очереди","id":"crm-42","from":{"name":"CRM","role":"moderator"}}'
```
```json
{ "message": { "id":"crm-42","roomId":"demo-room",
               "from":{"id":"<sub>","name":"CRM","role":"moderator"},
               "text":"Клиент в очереди","ts":1760000000000,"kind":"text" } }
```

- требует эффективную фичу `chat`;
- `kind:'system'` — нужны `session.chat.allowSystemMessages` **и** роль
  host/moderator (иначе `403`); автор по умолчанию `{name:"Система", role:"moderator"}`;
- текстовые сообщения — `session.chat.allowHostInjection` (иначе `403`);
- `id` — идемпотентность: повтор возвращает уже созданное сообщение;
- сообщение бродкастится всем по WS (`{"type":"chat","message":...}`), попадает в
  историю, аудируется (`chat.sent`) и уходит вебхуком `chat.message`;
- текст 1..4000 символов (`400` иначе), комната locked → `423`.

### `POST /v1/admin/rooms/:roomId/chat` (`x-api-key`)

То же тело, но для бота/CRM; автор по умолчанию `{id:"system", name:"Система",
role:"moderator"}`. Гейты `allowSystemMessages`/`allowHostInjection` соблюдаются,
аудит `chat.sent` + `admin.action`, вебхук `chat.message`.

## 7. Admin REST

Все запросы — `x-api-key`, тенант берётся из ключа; чужая комната → `403`,
неизвестная → `404`. Лимит `AGIL_ADMIN_RATE_LIMIT_PER_MIN` (120/мин).

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/v1/admin/overview` | `AdminOverview` (KPI, страны) |
| GET | `/v1/admin/rooms` | `{rooms: AdminRoomSummary[]}` |
| POST | `/v1/admin/rooms` | `CreateRoomResponse` (пароль только хэшем) |
| GET | `/v1/admin/rooms/:roomId` | `RoomDetail` (участники, чат, ссылки) |
| DELETE | `/v1/admin/rooms/:roomId` | `{closed:true}` |
| POST | `/v1/admin/rooms/:roomId/invites` | `InviteLink` |
| POST | `/v1/admin/rooms/:roomId/lock` | `{locked}` |
| POST | `/v1/admin/rooms/:roomId/kick` | `{kicked:true}` (WS закрывается) |
| POST | `/v1/admin/rooms/:roomId/chat` | `ChatPostResponse` |
| GET | `/v1/admin/rooms/:roomId/transcript` | `TranscriptResponse` |
| DELETE | `/v1/admin/rooms/:roomId/transcript` | Очистить транскрипт активной комнаты. Ответ содержит `roomId`, `removedSegments` и `clearedAt` в миллисекундах Unix. |
| GET | `/v1/admin/rooms/:roomId/analysis` | `AnalysisResponse` |
| POST | `/v1/admin/rooms/:roomId/analysis/run` | `AnalysisResponse` (принудительный прогон) |
| GET | `/v1/admin/rooms/:roomId/locations` | локации + GPS-координаты (только admin) |
| GET | `/v1/admin/audit?limit=&offset=&anchorId=&type=&severity=&roomId=&q=` | `AuditListResponse {entries,total,offset,limit,anchorId?}` |
| GET | `/v1/admin/security` | `SecurityOverview` |
| GET | `/v1/admin/recordings?roomId=` | `{recordings}` |
| DELETE | `/v1/admin/recordings/:id` | `{deleted:true}` |
| GET | `/v1/admin/files?roomId=` | `{files}` |
| GET | `/v1/admin/billing/usage?month=` | `BillingUsageResponse` (usage, live, quota; §35) |
| GET | `/v1/admin/billing/plan` | `BillingPlanResponse` (тариф + каталог + usage) |
| PATCH | `/v1/admin/billing/plan` | `BillingPlanResponse` (тариф/лимиты, аудит `billing.updated`) |

`q` ищет по текущей выборке журнала организации до пагинации. Запрос принимает до
200 символов. Все слова должны совпасть без учёта регистра хотя бы в одном из
полей события: тексте, типе, идентификаторах события, комнаты и участника,
коде страны или хэше IP. `total` показывает число совпадений с учётом всех
применённых фильтров.

Для перехода по страницам и экспорта передайте `anchorId` из ответа первой
страницы с теми же фильтрами. Новые события появятся в следующем запросе без
`anchorId`. Граница действует, пока её запись хранится в журнале в памяти Core.

```bash
KEY='x-api-key: dev-key'
curl -s -X POST http://localhost:8787/v1/admin/rooms \
  -H "$KEY" -H 'content-type: application/json' \
  -d '{"name":"Планёрка","password":"pass1234","maxParticipants":8}' | jq

curl -s "http://localhost:8787/v1/admin/audit?severity=warn&limit=20&offset=0" -H "$KEY" | jq '.total, .entries[0]'
```

`CreateRoomResponse` никогда не содержит пароль или `passwordHash` — только
`passwordProtected:true`. Брутфорс пароля фиксируется (`password.failed`,
`lockout`), kick немедленно закрывает WebSocket (`bye{reason:"kicked"}` + close 1008).

## 8. Доступы, AI- и knowledge-агенты

### Access policy

```bash
curl -s http://localhost:8787/v1/admin/access-policy -H "$KEY" | jq
curl -X PUT http://localhost:8787/v1/admin/access-policy \
  -H "$KEY" -H 'content-type: application/json' \
  -d '{"policy":{"deniedFeatures":["translation"],"roleDefaults":{"guest":["chat","reactions"]}}}'
```
Ответ: `{policy, featureKeys, effective:{host:[],moderator:[],guest:[]}}`.
Аудит — `access.updated`.

### Ссылки на секреты: allowlist env-переменных

Во всех полях `*Env` (`apiKeyEnv`, `secretEnv`, `credentialEnv`,
`clientSecretEnv`) конфиг хранит **только имя** переменной окружения. Имя обязано
принадлежать серверному namespace — иначе `400 validation_failed` (проверяется на
записи конфига, в room `configOverrides` и повторно при использовании):

| Поле | Допустимое имя |
|---|---|
| `session.aiAgent.apiKeyEnv`, `session.knowledgeAgent.apiKeyEnv`, `session.inCallAgent.apiKeyEnv`, `providers.<slot>.apiKeyEnv` | `AGIL_INTEGRATION_*` (legacy: `AGIL_AI_AGENT_KEY`, `AGIL_KNOWLEDGE_AGENT_KEY`, `AGIL_INCALL_AGENT_KEY`, `AGIL_{CHAT,FILES,STT,NOTIFICATIONS,RECORDING,BACKGROUNDS}_PROVIDER_KEY`) |
| `integrations.webhooks[].secretEnv` | `AGIL_WEBHOOK_*` |
| `integrations.siem.secretEnv` | `AGIL_SIEM_*` |
| `scale.sfu.apiKeyEnv`, `scale.sfu.apiSecretEnv` | `AGIL_SFU_*` |
| `scale.turn[].credentialEnv` | `AGIL_TURN_*` |
| `integrations.identity.clientSecretEnv` | `AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>` (канонический lower-case id тенанта) или **точная** запись в `AGIL_OIDC_TENANT_SECRETS` (namespace `AGIL_OIDC_CLIENT_SECRET*`; ключ карты сравнивается с id с учётом регистра) |

Пустая строка = «не настроено». Значения читаются из снапшота env, снятого на
старте процесса; `process.env` по имени из конфига не опрашивается, поэтому
переменная, заданная после старта, не видна до рестарта. Allowlisted, но
незаданная переменная даёт `501`/ошибку доставки без значения; произвольное имя
(например `AGIL_TOKEN_SECRET`, `AGIL_PLATFORM_KEY`, `AGIL_API_KEYS`) отклоняется
и никогда не читается — см. `security.md` §2.11.

### AI-агент (анализ транскрипта, §13)

`GET /v1/admin/ai-agent` → `AiAgentSettingsResponse {config, endpointConfigured,
apiKeyConfigured}` (при ненастроенном агенте — дефолтный конфиг, не ошибка).

`PUT /v1/admin/ai-agent` `{config: Partial<AiAgentConfig>}` — merge в
`session.aiAgent`; ключ только как имя env-переменной (`apiKeyEnv`, namespace
`AGIL_INTEGRATION_*` — см. выше).

Поток: caption-сегменты → локальные правила `ComplianceEngine` (offline) →
при `mode:'external'|'hybrid'` HTTP POST на `endpoint` с HMAC-подписью
(`x-agil-signature` = hex HMAC-SHA256 сырого тела, `x-agil-request-id`,
`x-agil-tenant`) → `findings` + `notes` → broadcast `{"type":"analysis"}`,
audit, вебхуки `analysis.ready` / `compliance.finding`.

Пример запроса к **внешнему AI-агенту** (наша сторона → endpoint компании):

```http
POST https://ai.example.com/agil/analyze
x-agil-request-id: 8f2c...
x-agil-tenant: demo
x-agil-signature: 9f2a... (hex HMAC-SHA256 тела)
content-type: application/json
```
```json
{
  "requestId": "8f2c...",
  "tenantId": "demo",
  "roomId": "demo-room",
  "roomName": "Планёрка",
  "locale": "ru",
  "role": "participant",
  "participants": [ { "id":"p1","name":"Alisa","role":"host","verified":false } ],
  "segments": [
    { "id":"s1","participantId":"p1","participantName":"Alisa",
      "text":"Пароль от прод-базы — в тикете SEC-42.","start":12.4,"end":15.1,
      "isFinal":true,"lang":"ru","ts":1760000000000 }
  ],
  "policy": { "rules":[{"id":"confidential","name":"Конфиденциально","type":"phrase",
             "pattern":"пароль","severity":"critical","action":"flag","enabled":true}],
              "policyText":"" },
  "meetingContext": { "startedAt":1760000000000, "hostName":"Alisa" }
}
```

Ожидаемый ответ (валидируется zod `parseAiAgentResponse`, длина строк
ограничивается, поля не исполняются):

```json
{
  "requestId": "8f2c...",
  "summary": "Обсуждали инцидент и доступ к прод-базе.",
  "findings": [
    { "ruleId":"confidential","ruleName":"Конфиденциально","severity":"critical",
      "action":"flag","participantId":"p1",
      "excerpt":"Пароль от прод-базы — в тикете SEC-42.",
      "confidence":0.92,"recommendation":"Удалить фразу из записи и напомнить политику." }
  ],
  "notes": {
    "summary":"Инцидент SEC-42, доступ к БД.",
    "excerpts":[{"id":"e1","kind":"risk","text":"Пароль от прод-базы — в тикете SEC-42.",
                 "participantName":"Alisa","start":12.4,"end":15.1,
                 "note":"Утечка секрета в транскрипте"}],
    "actionItems":[{"id":"a1","text":"Ротировать пароль прод-базы","owner":"Alisa"}],
    "decisions":["Провести внеплановый аудит доступа"],
    "risks":["Компрометация прод-базы"],"topics":["безопасность","доступ"],
    "sentiment":"negative"
  },
  "provider":"company-llm","model":"corp-llm-1"
}
```

Локальный fallback (`LocalNotesExtractor`) всегда доступен: `notes.excerpts` —
дословные цитаты с таймкодами и спикером (без пересказа AI).

### Knowledge-агент (вопросы по wiki компании)

```bash
curl -s http://localhost:8787/v1/admin/knowledge-agent -H "$KEY" | jq
curl -X PUT http://localhost:8787/v1/admin/knowledge-agent \
  -H "$KEY" -H 'content-type: application/json' \
  -d '{"config":{"enabled":true,"endpoint":"https://kb.example.com/agil/ask",
       "apiKeyEnv":"AGIL_INTEGRATION_KNOWLEDGE_AGENT_KEY","allowedRoles":["host","moderator"],
       "requirePermission":true,"citations":true}}'

curl -s -X POST http://localhost:8787/v1/admin/knowledge/ask \
  -H "$KEY" -H 'content-type: application/json' \
  -d '{"question":"Как оформить отпуск?","role":"host","userId":"u-1"}' | jq
```
```json
{ "answer":"Отпуск оформляется в HR-портале: раздел «Отпуска».",
  "citations":[{"title":"HR wiki — Отпуска","url":"https://wiki.example.com/hr/leave",
                "snippet":"Заявление за 14 дней"}],
  "confidence":0.87, "provider":"company-rag", "model":"rag-1" }
```

Запрос к компании — `KnowledgeQueryRequest` (HMAC-подпись как у AI-агента),
ответ валидируется `parseKnowledgeQueryResponse`; цитаты — недоверенные ссылки
(UI: `rel="noopener noreferrer"`). Права: `session.knowledgeAgent.enabled`,
`allowedRoles`, при `requirePermission` — фича `knowledgeAgent`. В звонке то же
доступно через WS `assistant-query` (см. §10) с лимитом 10 вопросов/мин.
Если агент включён, но не заданы endpoint/ключ — HTTP `501 knowledge_not_configured`
(не 403): UI показывает «Ассистент знаний не настроен».

### Экспорт заметок и анализа

`GET /v1/admin/rooms/:id/notes` → JSON `{roomId, notes, updatedAt}`;
`GET /v1/admin/rooms/:id/analysis` → JSON (`AnalysisResponse`). Для кнопок
«Скачать» оба поддерживают `?format=md` (Markdown) и `&download=1`
(`content-disposition: attachment`).

## 9. Вебхуки (мы → компания)

Настройка: `PUT /v1/admin/webhooks` `{webhooks: WebhookEndpointConfig[]}` (полная
замена, до 20), `GET /v1/admin/webhooks` → `{webhooks, recentDeliveries}` (лог 200
последних in-memory), `POST /v1/admin/webhooks/test` `{endpointId}` → `WebhookTestResponse`.

`WebhookEndpointConfig`: `{id, url, events[], secretEnv, enabled, retries, timeoutMs, description?}`.
`secretEnv` — имя env-переменной с HMAC-секретом (сам секрет в конфиг не попадает);
допускается только `AGIL_WEBHOOK_*` (см. «Ссылки на секреты: allowlist env-переменных»).

События: `room.created, room.closed, participant.joined, participant.left,
chat.message, file.shared, recording.ready, transcript.ready, analysis.ready,
knowledge.answer, compliance.finding, security.event`.

Доставка: `POST` JSON `WebhookPayload`:

```json
{ "id":"<delivery-uuid>", "type":"analysis.ready", "ts":1760000000000,
  "tenantId":"demo", "roomId":"demo-room",
  "data": { "findings": 2, "summary":"Инцидент SEC-42", "provider":"local" } }
```

Заголовки: `x-agil-signature: <hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>`,
`x-agil-delivery: <id>`, `x-agil-event: <type>`, `x-agil-timestamp: <epoch-ms>`.
Подпись покрывает timestamp (окно ±300 s) — пересланная старая доставка
отвергается, replay невозможен. Таймаут/ретраи — из endpoint (`retries` 0..10,
`timeoutMs` 500..30000) с экспоненциальным backoff; итог в аудите
(`webhook.delivered` / `webhook.failed`). URL проходит SSRF-политику
(в production — только https и публичные хосты).

Проверка подписи на стороне компании (или готовый
`verifyWebhookSignature` из `@agil/security`):

```js
const timestamp = req.headers['x-agil-timestamp'];
const expected = crypto.createHmac('sha256', process.env.COMPANY_WEBHOOK_SECRET)
  .update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-agil-signature']));
const fresh = Math.abs(Date.now() - Number(timestamp)) <= 300_000;
if (!ok || !fresh) return res.status(401).end();
```

## 10. WebSocket-сигналинг

Подключение: `ws://localhost:8787/ws?token=<jwt>` (предпочтительно для CLI/серверных
клиентов) либо, при `AGIL_ALLOW_ANONYMOUS=1`,
`?room=<id>&tenant=demo&name=Гость&role=guest`. Браузерный виджет передаёт JWT
не в URL, а в handshake-заголовке `Sec-WebSocket-Protocol`:
`agil-calls.v1` + `agil-token.<url-encoded-jwt>` — так токен не попадает в
URL, который браузер печатает в консоль при неудачном upgrade. Сервер
принимает оба варианта.
Непосредственно после connect сервер присылает `welcome` либо `error` (fatal) и
закрывает. Max payload 1 МиБ, heartbeat 30 с, лимит 40 сообщений/с
(3 нарушения → close 1008), невалидный JSON → `error bad_request` без разрыва.

```bash
npx wscat -c "ws://localhost:8787/ws?token=$TOKEN"
> {"type":"ping","ts":1}
< {"type":"pong","ts":1}
> {"type":"chat","id":"c1","text":"привет"}
```

### Клиент → сервер

| type | Поля | Смысл |
|---|---|---|
| `hello` | `{name?, locale?}` | уточнить имя/локаль |
| `sdp` | `{to, description:{type:'offer'\|'answer', sdp}}` | relay SDP пиру |
| `ice` | `{to, candidate:{...}}` | relay ICE |
| `chat` | `{id, text(1..4000), attachment?}` | чат (id — UUID для дедупа) |
| `state` | `{state: Partial<{mic,cam,screen,handRaised,network}>}` | состояние медиа |
| `reaction` | `{emoji, ts?}` | реакция |
| `caption` | `{text, isFinal, lang?}` | субтитр → транскрипт (STT) |
| `integrity` | `{status, score?, flags?}` | liveness/anti-deepfake сигнал |
| `location` | `{lat, lon, accuracyM?, consent:true}` | GPS при `security.geo.gpsEnabled` |
| `ping` | `{ts, refreshIce?, refreshSfu?}` | Поддержание соединения. `refreshIce: true` запрашивает обновление временных TURN-данных. `refreshSfu: true` запрашивает новый медиатокен для текущей комнаты и участника. |
| `history` | `{limit?}` | история чата |
| `analysis-request` | `{sinceTs?}` | принудительный прогон AI-пайплайна |
| `assistant-query` | `{id, question}` | вопрос knowledge-агенту |
| `whiteboard.open` | `{}` | открыть доску (`features.whiteboard`) |
| `whiteboard.close` | `{reason?}` | host/moderator: закрыть и заблокировать доску |
| `whiteboard.stroke` | `{id?, tool, color?, width?, points?}` | штрих (`pen`/`eraser`) или команда (`clear`/`undo`) |
| `whiteboard.sync` | `{}` | запросить снапшот доски |
| `annotation.stroke` | `{id?, tool, color?, width?, points}` | пометка поверх показа экрана (`features.annotations`) |
| `annotation.clear` | `{}` | ведущий показа или host/moderator: очистить пометки |
| `bye` | `{}` | выйти |

### Сервер → клиент

| type | Поля |
|---|---|
| `welcome` | `{self, room, participants[], config, iceServers[], serverTime, history[]}` |
| `peer-joined` | `{participant}` |
| `peer-left` | `{participantId, reason?}` |
| `sdp` | `{from, description}` |
| `ice` | `{from, candidate}` |
| `chat` | `{message}` — всем, включая автора |
| `chat-history` | `{messages}` |
| `state` | `{participantId, state}` |
| `reaction` | `{participantId, emoji, ts}` |
| `caption` | `{participantId, text, isFinal, ts}` |
| `integrity` | `{participantId, status, score?, flags, ts}` |
| `location` | `{participantId, location:{country?,city?,source,accuracyM?}, ts}` — без координат |
| `room` | `{room, participants}` |
| `config` | `{config}` — при изменении конфига тенанта |
| `analysis` | `{roomId, findings[], summary?, ts}` |
| `assistant-answer` | `{id, answer, citations[], confidence?, error?, ts}` |
| `whiteboard.open` | `{roomId, by, ts}` |
| `whiteboard.close` | `{roomId, by, reason, ts}` |
| `whiteboard.sync` | `{roomId, snapshot, reason, ts}` — `join\|open\|close\|request\|clear\|undo\|trim` |
| `whiteboard.stroke` | `{roomId, stroke, revision, ts, trimmed?}` |
| `annotation.sync` | `{roomId, snapshot, ts}` |
| `annotation.stroke` | `{roomId, stroke, revision, ts, trimmed?}` |
| `annotation.clear` | `{roomId, by?, presenterId, reason, ts}` |
| `error` | `{code, message, fatal?}` |
| `pong` | `{ts, iceServers?, sfuMedia?}`. После `refreshSfu` Core возвращает медиасессию или `null`, если обновление недоступно. Поле ICE есть, если клиент запросил обновление и пришло его время. |
| `bye` | `{reason}` |

`welcome.self.permissions` — эффективные фичи; `welcome.history` — последние 200
сообщений (при `features.chatHistoryOnJoin`).

`assistant-answer.error`: `forbidden` (нет прав/роли/агент выключен),
`rate_limited` (10/мин на участника), `unavailable`/`internal_error` (агент компании
не ответил). Денай-сообщение — `session.knowledgeAgent.denyMessage`.

## 11. Mesh-согласование

```
A ──welcome(participants=[B]) / peer-joined(B)──┐
B ──welcome(participants=[A]) / peer-joined(A)──┤  обе стороны: RTCPeerConnection + addTrack
                                                ▼
Инициатор = участник с лексикографически меньшим participant.id
   initiator: createOffer → sdp{to: B} ──► relay ──► B
   B: setRemote(offer) → createAnswer → sdp{to: A} ──► relay ──► A
   обе: onicecandidate → ice{to: peer} ──► relay ──► peer.addIceCandidate
   renegotiation (screen share): perfect negotiation + rollback на glare
   деградация: quality.evaluateQuality() → reduced video/audio-only/chat-fallback,
               ICE-restart и reconnect с backoff из fallback.lowBandwidth.autoReconnect
```

Сервер — детерминированный relay (без состояния SDP): он только проверяет, что
`to` есть в комнате (`error unknown_peer`), и пересылает `from`. Топология mesh:
каждый с каждым; `limits.maxParticipants` ограничивает комнату.

## 12. Лимиты и безопасность

| Что | Лимит |
|---|---|
| JSON body | 1 МиБ → `413` |
| Файл | `min(session.fileShare.maxFileSizeMb, AGIL_MAX_UPLOAD_MB)` |
| Запись | `AGIL_MAX_RECORDING_MB` (200) |
| Join | `AGIL_JOIN_RATE_LIMIT_PER_MIN` (300/мин) на IP+комнату; lockout: `maxFailedJoinAttempts` за `lockoutSec` |
| Admin API | `AGIL_ADMIN_RATE_LIMIT_PER_MIN` (120/мин) |
| Файлы/STT | 30/мин на тенант |
| Knowledge | 10/мин на участника |
| WS | 40 сообщений/с; 3 нарушения → close 1008 |
| Чат | 1..4000 символов; история — 200 сообщений |

Заголовки ответов: `x-content-type-options: nosniff`,
`referrer-policy: strict-origin-when-cross-origin`, `x-frame-options: SAMEORIGIN`,
`permissions-policy: camera=(self), microphone=(self), geolocation=(self)`,
`cross-origin-opener-policy: same-origin`, HSTS при `AGIL_TRUST_PROXY=1`.
`/embed.html` — CSP `frame-ancestors` из `integrations.allowedOrigins`
(пустой список = разрешено всем; для прода задайте список).
Аудит: `<AGIL_DATA_DIR>/audit/<tenant>.jsonl`, IP — только `hashIp`. Пароли и
ключи не логируются; `/v1/health` не раскрывает имена env-переменных.

## 13. Коды ошибок

| HTTP | `error.code` | Когда |
|---|---|---|
| 400 | `validation_failed` | кривой JSON/zod-issues/URL/неизвестный audit-фильтр |
| 400 | `password_required` | у комнаты есть пароль, но он не передан |
| 401 | `unauthorized` | нет/невалиден `x-api-key` или join-токен |
| 401 | `password_invalid` | неверный пароль комнаты |
| 403 | `forbidden` | чужой тенант, запрещённая фича/роль, `geo_blocked`-политика, выключенная инъекция чата. При политике входа организатора или модератора первым и выключенном зале ожидания `error.details.reason` содержит `host_not_joined`, пока никого из них нет в комнате |
| 403 | `feature_disabled` | функция выключена флагом тенанта (`features.*`: файлы/запись/STT/чат/…), даже если роль её разрешает; UI и API проверяют одинаково |
| 403 | `geo_blocked` | страна/AVPN/неизвестная страна при allow-list |
| 404 | `not_found` | комната/запись/файл/документ не найдены |
| 409 | `room_full` | достигнут `maxParticipants` |
| 402 | `quota_exceeded` | превышена квота тарифа при создании комнаты (`billing.overagePolicy="block"`, §35) |
| 429 | `quota_exceeded` | превышена квота участников/минут при join (WS: error `quota_exceeded`) |
| 413 | `file_too_large` | тело/файл больше лимита |
| 415 | `unsupported_mime` | запрещённый MIME или не аудио для STT |
| 423 | `room_locked` | комната залочена admin'ом |
| 429 | `rate_limited` | rate-limit или lockout после паролей |
| 501 | `stt_not_configured` | не задан `AGIL_STT_URL` |
| 501 | `knowledge_not_configured` | knowledge-агент включён, но не заданы endpoint/ключ (UI: «Ассистент знаний не настроен») |
| 501 | `assistant_local_only` | in-call ассистент в `local`-режиме (движок в виджете) или hybrid-fallback |
| 501 | `provider_unsupported` | слот провайдера не поддерживает external в MVP (recording) |
| 502 | `provider_failed` | внешний провайдер/AI/knowledge/STT не ответил (при `fallback:'fail'`) |
| 502 | `internal_error` | внешний STT/AI/knowledge не ответил |
| 500 | `internal_error` | непредвиденная ошибка (детали — в логе, не клиенту) |

WS-коды: `bad_request | unauthorized | room_full | room_locked | unknown_peer |
rate_limited | quota_exceeded | internal_error`; fatal-ошибки сопровождаются close 1008.

---

## 14. In-call AI-ассистент (с правами участника)

`POST /v1/rooms/:roomId/assistant` — `authorization: Bearer <join token>`.
Ассистент действует **от имени подключённого пользователя**: сервер передаёт
эффективные `permissions`, а затем фильтрует предложенные моделью действия по тем
же правилам (клиентская проверка — только UX). Rate-limit: 10 запросов/мин на
участника. Промпт и ответ в аудит **не пишутся** (только событие `assistant.usage`).

```bash
curl -X POST http://localhost:8787/v1/rooms/demo-room/assistant \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"Помоги включить запись","locale":"ru",
       "state":{"participants":2,"recording":false,"mic":"on"}}'
```

```json
{ "id":"reply-uuid",
  "text":"Нажмите «Запись» в нижней панели — я подсвечу кнопку.",
  "actions":[{"tool":"start_recording"},{"tool":"open_chat"}],
  "spotlight":[{"target":"recording","text":"Кнопка записи","step":0}],
  "source":"external","ts":1760000000000 }
```

Проверки: `session.inCallAgent.enabled` (иначе `403`); `mode:'local'` → `501
assistant_local_only` (движок выполняется в виджете офлайн); `external`/`hybrid` →
подписанный POST на `session.inCallAgent.endpoint` (ключ из env по `apiKeyEnv`,
HMAC `x-agil-signature`), тело `InCallAssistantRequest` (participant.permissions,
`tools = allowedTools`, `systemPrompt`, компактный `state`). Ответ валидируется
`parseInCallAssistantResponse` (недоверенный вход), действия фильтруются
`filterAssistantActions` и обрезаются до `maxActionsPerReply`; `spotlight`
отключается конфигом. Ошибка endpoint: `hybrid` → `501 assistant_local_only`
(fallback в виджете), `external` → `502 provider_failed`.

Admin: `GET|PUT /v1/admin/in-call-agent` (`x-api-key`) — merge в
`session.inCallAgent`; ответ `{config, endpointConfigured, apiKeyConfigured}`
(секрет — только имя env-переменной).

## 15. Заменяемые провайдеры (builtin → external)

`TenantConfig.providers` — 6 слотов: `chat`, `files`, `stt`, `notifications`,
`recording`, `backgrounds`. По умолчанию всё работает автономно (builtin);
компания может заменить нужное, не форкая продукт (`agil/core/docs/extensibility.md`).

```bash
curl -s http://localhost:8787/v1/admin/providers -H 'x-api-key: dev-key' | jq
curl -X PUT http://localhost:8787/v1/admin/providers \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"providers":{"files":{"mode":"external",
        "providerName":"s3","endpoint":"https://example.com/agil/files",
        "apiKeyEnv":"AGIL_FILES_PROVIDER_KEY","timeoutMs":5000,
        "fallback":"builtin","options":{}}}}'
curl -X POST http://localhost:8787/v1/admin/providers/test \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"slot":"files","payload":{"probe":true}}'
```

Статус слота: `{slot, mode, providerName, configured, available, fallback, note?}`.
PUT валидирует внешний endpoint через SSRF-политику (http(s); в «secure» режиме —
только https и публичные хосты), `apiKeyEnv` — только имя env-переменной.
`mode:'external'` требует непустой endpoint; `disabled` выключает возможность
(API отвечает `403`), `recording` в MVP поддерживает только builtin
(`provider_unsupported` → `501`).

**Конверт провайдера** (мы → endpoint компании): `POST` JSON
`{capability, action, requestId, tenantId, roomId?, payload}` с заголовками
`x-agil-signature` (hex HMAC-SHA256 сырого тела; секрет из env по `apiKeyEnv`),
`x-agil-capability`, `x-agil-request-id`, `x-agil-tenant`, `content-type`.
Ответ: `{ok:true, data}`; `data` валидируется адаптером. При ошибке/таймауте/
невалидном ответе: `fallback:'builtin'` — прозрачное использование builtin
(лог + аудит `admin.action` kind `provider.fallback`), `fallback:'fail'` — `502
provider_failed`. Payload’ы: `chat.post {text,kind,from,id?}` / `chat.history
{limit}`; `files.put {name,mime,size,dataBase64,uploadedBy}` / `files.get {id,sig,
exp}` → `data {file,dataBase64}` / `files.list` / `files.remove`; `stt.transcribe
{mime,language,audioBase64}`; `notifications.send {type,message,data}` (best-effort,
никогда не блокирует звонок; сбой → аудит `webhook.failed` kind
`provider.notification_failed`); `backgrounds.list` → `data {backgrounds}`.

Уведомления builtin — только UI-события; external получает `participant.joined`,
`participant.left`, `room.closed`, `recording.ready`, `analysis.ready`.
Файлы/STT/запись маршрутизируются сервером прозрачно для виджета.

### `GET /v1/tenants/:tenantId/backgrounds` (публично, без auth)

`{backgrounds:[{id,name,url}], provider:'builtin'|'<external>'}` — builtin берёт
`session.virtualBackgrounds`, external — список компании. `disabled` → `403`.

## 16. Звонки из мессенджера (direct/group)

`RoomInfo.mode` (`direct` | `group`, по умолчанию `group`) и `RoomInfo.context`
(`{messenger?, conversationId?, directPeerId?, title?}`) принимаются в
`POST /v1/rooms` и `POST /v1/admin/rooms`:

```bash
curl -X POST http://localhost:8787/v1/rooms \
  -H 'content-type: application/json' \
  -d '{"name":"Звонок из Slack","mode":"direct","transport":"p2p",
       "context":{"messenger":"slack","conversationId":"C-42","title":"Чат с клиентом"}}'
```

Правила: `mode:'direct'` — 1:1, `maxParticipants` принудительно ≤ 2 (если не
задан — 2); `group` — лимит из конфига тенанта. Необязательный
`transport` (`p2p` | `sfu`) допустим только для `direct`: `p2p` принудительно
даёт `mediaMode:'mesh'` и 2 места без серверного медиа; `sfu`/пусто — текущий
эффективный режим организации. `p2p` с `group`, `maxParticipants > 2` —
`400 validation_failed`; `p2p` при включённых серверных egress/стримах/вебинаре
— `409 p2p_unsupported` (локальная запись в браузере разрешена). Подробно:
`agil/core/docs/p2p.md`. `mode`/`context` возвращаются в room/join/
welcome/admin room detail/public room info и уходят в вебхук `room.created`
(`data.mode`, `data.context`; при явном `transport` — ещё и `data.transport`,
`data.mediaMode`). `context` — строки с лимитами, без секретов.

Карточка звонка в мессенджере (рекомендуемый сценарий): бот создаёт direct-комнату,
получает `joinUrl`/`embedUrl`, отправляет карточку в чат (conversationId в context),
подписывается на `room.created`/`room.closed`/`participant.*` вебхуки и удаляет
карточку по `room.closed`. См. `agil/core/docs/messenger.md`.

## 17. Управление публикацией agil/core/docs/OpenAPI/admin

Полная таблица — `agil/core/docs/api-exposure.md`. Ключевое:

| Env | Default | Поведение |
|---|---|---|
| `AGIL_DOCS_ENABLED` | `1` в dev (в production по умолчанию `0`) | `0` → `/docs`, `/docs/:file`, `/openapi.json`, `/openapi.admin.json` отдают одинаковый `404` (без утечки «docs есть») |
| `AGIL_DOCS_ALLOW_IPS` | пусто = все | CIDR-список (`10.0.0.0/8,203.0.113.0/24`); проверка по resolved IP (с учётом `AGIL_TRUST_PROXY`); вне списка → `404` |
| `AGIL_DOCS_PORT` / `AGIL_DOCS_HOST` | основной порт | отдельный HTTP-порт только для agil/core/docs/OpenAPI (docs-сервис); на основном порту docs тогда `404` |
| `AGIL_DOCS_RATE_LIMIT_PER_MIN` | `120` | rate-limit agil/core/docs/OpenAPI на IP (`429`) |
| `AGIL_ADMIN_API_ENABLED` | `1` | `0` → весь `/v1/admin/*` = `404` (публичный API работает) |
| `AGIL_ADMIN_ALLOW_IPS` | пусто = все | allowlist admin-API; вне списка → `403` |
| `AGIL_ENROLL_ALLOW_IPS` | пусто = все | отдельный allowlist enrollment-поверхности (`/v1/cluster/join`, `/v1/nodes/register`, `/v1/nodes/:id/heartbeat`); не зависит от `AGIL_ADMIN_*`; вне списка → `403` |
| `AGIL_HEARTBEAT_RATE_LIMIT_PER_MIN` | `10` | heartbeat на узел в минуту, ключ = tenant id + аутентифицированный node id (списывается только после проверки ключа; одинаковые id у разных тенантов не пересекаются), не общий с enrollment-лимитом |
| `AGIL_HEARTBEAT_IP_RATE_LIMIT_PER_MIN` | `600` | внешний лимит на IP: все heartbeat-попытки (включая неверные/отсутствующие ключи) до проверки credentials; 61 узел за NAT ≈122/мин проходит |
| `AGIL_NODE_KEY_TTL_SEC` | `0` | TTL ключа узла по умолчанию (0 = бессрочно; максимум 90 дней) |
| `AGIL_CLUSTER_ROLE` | `leader` | `standby` — read-only: без Redis фиксирует роль, с `AGIL_REDIS_URL` исключает Core из выборов; любые записи → `409 not_leader` |
| `AGIL_REDIS_URL` | пусто = standalone | `redis://`/`rediss://` для аренды лидера: выборы, standby read-only, failover по TTL — `agil/core/docs/ha-leader.md` |
| `AGIL_CLUSTER_ID` | `default` (Redis) / id кластера | общий namespace аренды; должен совпадать у всех Cores |
| `AGIL_CLUSTER_NODE_ID` | `<hostname>:<PORT>` | уникальный id Core в аренде (задавайте явно при нескольких Cores на хосте) |
| `AGIL_LEADER_LEASE_TTL_MS` | `10000` | TTL аренды, 2000…120000 мс; верхняя граница ≈ худшее время failover |
| `AGIL_LEADER_RENEW_INTERVAL_MS` | `TTL/3` | период продления (100…TTL−100) |
| `AGIL_LEADER_RETRY_INTERVAL_MS` | `1500` | период попыток standby забрать аренду |
| `AGIL_REDIS_KEY_PREFIX` | `agil` | префикс ключей `<prefix>:cluster:<id>:leader` |
| `AGIL_MCP_HTTP_ENABLED` / `AGIL_MCP_HTTP_PORT` / `AGIL_MCP_HTTP_TOKEN` / `AGIL_MCP_HTTP_ALLOW_IPS` | off / — | флаги HTTP-MCP (сам `/mcp` реализует пакет `@agil/mcp` на своём порту); `/v1/health` отдаёт `security.mcpHttpEnabled` |

`/openapi.json` содержит только публичные пути и не содержит security-scheme
`apiKey`; admin-спека — только `/openapi.admin.json` (и требует docs-доступа).
Ответы agil/core/docs/OpenAPI — `cache-control: no-store`/`no-cache`, секретов в спеке нет.
`/v1/health` отдаёт `security.docsEnabled`, `security.adminApiEnabled`,
`security.mcpHttpEnabled`.

Для `AGIL_DOCS_ALLOW_IPS`/`AGIL_ADMIN_ALLOW_IPS`/`AGIL_ENROLL_ALLOW_IPS`:
пусто = без ограничения; непустой список **без единого валидного IP/CIDR**
(опечатка, hostname, `/33`) — fail-closed, не проходит никто
(`net-policy.ts`, `isIpAllowed`). `AGIL_MCP_HTTP_ALLOW_IPS` обрабатывается
HTTP-MCP и при непустом списке без совпадений тоже не пропускает запрос.

---

## 18. Масштабирование: TURN-пул, мульти-нода, SFU, вебинары

MVP работает **single-node mesh**; конфигурация масштабирования принимается,
валидируется, отдаётся в admin API и **влияет на практическую часть**:
`welcome.iceServers` (STUN + весь TURN-пул с credential из env) и
`RoomInfo.mediaMode`/`maxParticipants` при создании комнаты. Реальная
оркестрация кластера/SFU/стриминга — следующий этап (`agil/core/docs/scaling.md` §9).

`TenantConfig.scale`: `mediaMode` (`mesh|sfu|broadcast`), `maxParticipants`
(2..50000, дефолт комнаты), `maxVideoSubscriptions`, `signaling` (nodeId,
redisUrl, pubsubChannel, stickySessions, nodes[]), `sfu` (provider, url,
apiKeyEnv, apiSecretEnv, region, maxParticipants, capacityProfile
`low|standard|high` — профиль ёмкости: бюджет видео и лимит комнаты
25/50/200 участников; env `AGIL_SFU_PROFILE` важнее, дефолт `standard`), `turn[]` (id, urls[], username, credentialEnv, region,
weight), `loadBalancer` (strategy, healthPath, stickyCookie), `webinar`
(enabled, hostOnlyPublish, viewerLimit, chatMode, reactions, raiseHandQueue),
`streaming` (enabled, provider, rtmpUrl, hlsUrl, playbackProtocol, whepUrl, latencyMode), `cdn`
(enabled, baseUrl, provider).

Для выбора просмотра передайте `scale.streaming.playbackProtocol` со значением `hls` или `whep` через `PUT /v1/admin/scale`. По умолчанию используется HLS. Адреса `hlsUrl` и `whepUrl` сохраняются отдельно, а `provider` и `rtmpUrl` описывают провайдера и адрес выхода. Пример частичного запроса:

```json
{"scale":{"streaming":{"enabled":true,"playbackProtocol":"whep","whepUrl":"https://edge.example/game/whep"}}}
```

Для собственного интерфейса сформируйте `/live.html?hls=…` или `/live.html?whep=…` через `URLSearchParams`. Передавайте адрес просмотра. Ключ публикации остаётся у издателя. Настройка определяет действие в панели. Вход RTP, публикация WHEP и преобразование кодеков конфигурируются на Edge.

```bash
# статус: конфиг, эффективный mediaMode, кластер, TURN-пул (configured-флаги), SFU/webinar/streaming
curl -s http://localhost:8787/v1/admin/scale -H 'x-api-key: dev-key' | jq

# merge конфигурации (deep-partial, массивы заменяются)
curl -X PUT http://localhost:8787/v1/admin/scale \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"scale":{
        "mediaMode":"sfu",
        "maxParticipants":500,
        "signaling":{"nodes":[{"id":"node-2","url":"https://calls-2.example","region":"ru-spb","weight":100}],"stickySessions":true},
        "sfu":{"provider":"livekit","url":"wss://sfu.example","apiKeyEnv":"AGIL_SFU_API_KEY","apiSecretEnv":"AGIL_SFU_API_SECRET"},
        "turn":[{"id":"turn-msk","urls":["turn:turn-msk.example:3478?transport=udp","turns:turn-msk.example:5349"],
                 "username":"agil","credentialEnv":"AGIL_TURN_MSK_SECRET","region":"ru-msk","weight":100}]}}'

# статус кластера (MVP: multiNodeActive=false)
curl -s http://localhost:8787/v1/admin/cluster/status -H 'x-api-key: dev-key' | jq

# реальная проверка TURN: STUN Binding по UDP + TCP/TLS-connect (короткий timeout)
curl -X POST http://localhost:8787/v1/admin/scale/turn/test \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' -d '{"id":"turn-msk"}'
# → {"id":"turn-msk","ok":true,"latencyMs":18,
#    "detail":"TURN relay reachable: UDP turn:…:3478: ok 12ms (STUN response); TCP turn:…?transport=tcp: ok 6ms (TCP connect)"}
# ok=false + detail с failed/timeout/ECONNREFUSED, если relay недоступен или TCP не слушает.
# Полный allocate с long-term credentials выполняет медиа-плоскость; здесь проверяется
# реальная сеть (UDP STUN + TCP/TLS), а не только конфиг.
```

Правила валидации: `turn[].urls` — только `turn:|turns:|stun:|stuns:` (TURN
адвертизируется браузеру, сервер его не вызывает — приватные корпоративные TURN
разрешены); `signaling.nodes[].url`, `sfu.url`, `streaming.hlsUrl`, `streaming.whepUrl`,
`cdn.baseUrl` — SSRF-политика (в production-режиме TLS + публичные хосты,
приватные/loopback/metadata запрещены); `streaming.rtmpUrl` — `rtmp:|rtmps:`;
`sfu.apiKeyEnv/apiSecretEnv` — только `AGIL_SFU_*`, `turn[].credentialEnv` —
только `AGIL_TURN_*` (только имена переменных; секреты в конфиг/ответы не
попадают, статус отдаёт лишь `credentialConfigured`). Произвольные имена env
отклоняются на записи и не читаются при использовании (`security.md` §2.11).

`ScaleStatusResponse`: `{config, mediaMode (эффективный), cluster:{nodeId,nodes,
strategy,redisConfigured,stickySessions}, turn:[{id,urls,region,weight,
usernameConfigured,credentialConfigured}], sfuConfigured, sfuProfile
(effective low|standard|high), sfuCapacity:{profile,vcpu,memoryGb,participants,
remoteVideosPerClient,note}, effectiveMaxParticipants, capacity:{effectiveMaxParticipants,
limit (room|scale|profile|sfu), profile, profileParticipants, roomMaxParticipants,
scaleMaxParticipants, sfuMaxParticipants}, webinarEnabled, streamingProvider,
limitations[]}` —
`config` и `sfuProfile` показывают эффективный профиль ёмкости (env
`AGIL_SFU_PROFILE` важнее `scale.sfu.capacityProfile`), `sfuCapacity.participants`
— участников на ноду (low 25 / standard 50 / high 200), `effectiveMaxParticipants`
— эффективный лимит комнаты `min(room, scale, profile, sfu.maxParticipants)`, а
`limitations` честно перечисляет, что не реализовано (cluster/SFU/webinar media
enforcement/streaming/TURN probing, отсутствие 200 HD).
`RoomDetail` (`GET /v1/admin/rooms/:roomId`) дополнительно отдаёт
`effectiveMaxParticipants` и тот же `capacity` с `limit` — какое ограничение
сработало; переполнение при join/lobby/WS — `409 room_full` с
`details.reason` (`profile|sfu|scale|room`).
`ClusterStatusResponse`: `{nodeId,nodes,strategy,redisConfigured,stickySessions,
multiNodeActive:false}`. Если на сервере есть реестр enrollment, добавляются
`cluster:{id,role,version}`, `standbys[]`, `enrolledNodes[]`, `counts` и
`limitations[]` — контракт в [api/cluster.md](api/cluster.md).
`TURN test`: `{id,ok,latencyMs,detail}` (проверка схемы
URL, username, наличия credential-env; allocate не выполняется).

### Enrollment: токены, резервный Core и узлы

Одноразовые токены выдаёт **лидер** (admin-ключ организации); резервный Core и
узлы обменивают их на подключение. Токен и per-node ключ хранятся только
хэшем (sha256 + `AGIL_IP_SALT`), показываются один раз и никогда не логируются.

| Метод | Путь | Кто | Ответ |
|---|---|---|---|
| POST | `/v1/admin/cluster/tokens` | admin | 201 `{token, enrollment}` (plaintext один раз) |
| GET | `/v1/admin/cluster/tokens` | admin | `{tokens: EnrollmentTokenSummary[]}` (без секретов) |
| DELETE | `/v1/admin/cluster/tokens/:id` | admin | `{revoked:true, enrollment}` |
| POST | `/v1/cluster/join` | core-токен | `{cluster, leader, standby, token}` |
| POST | `/v1/nodes/register` | node-токен | 201 `{node, nodeKey (один раз), heartbeatIntervalSec, cluster}` |
| POST | `/v1/nodes/:id/heartbeat` | `x-node-token: nk_…` | `{node, drain, heartbeatIntervalSec, serverTime, moduleCommands[]}` |
| GET | `/v1/admin/node-modules/catalog` | admin | `{catalog: NodeModuleCatalogEntry[], actions[]}` — allowlist модулей (образ/порты/env-**подсказки**, без значений и секретов) |
| GET | `/v1/admin/nodes/:id/modules` | admin | `{nodeId, modules: NodeModule[], pendingCommands[]}` — раскрытая карточка узла |
| POST | `/v1/admin/nodes/:id/modules/:moduleId/actions` | admin | `{action}` → `201 {command}` — команда ставится в очередь узла; `404` неизвестный узел/модуль, `400` неизвестное действие, `409 module_command_pending` / `module_queue_full` |
| GET | `/v1/admin/nodes?role=&status=&limit=&offset=` | admin | `{nodes: NodeSummary[]}` (+`total/limit/offset` при пагинации) |
| PATCH | `/v1/admin/nodes/:id` | admin | `{node}` |
| POST | `/v1/admin/nodes/:id/disable` | admin | `{node}` (`{disabled?:true}`) |
| POST | `/v1/admin/nodes/:id/drain` | admin | `{node}` (`{drain?:true}`) |
| POST | `/v1/admin/nodes/:id/rotate-key` | admin | `{node, nodeKey (один раз), keyExpiresAt, heartbeatIntervalSec}` — старый ключ сразу недействителен |
| DELETE | `/v1/admin/nodes/:id` | admin | `{deleted:true}` |

Типы: `cluster {id, role: leader|standby, version}`, `node {id, role:
sfu|turn|stun|all, features[], capacity, status: online|offline|draining|disabled,
metrics?, modules?, keyExpiresAt, keyRotatedAt}`, `module {id, kind, name,
version, image, status: running|stopped|error|installing|unknown, health:
healthy|degraded|unhealthy|unknown, ports[], updatedAt, lastError?}`, `module
command {id, moduleId, action, image?, createdAt, expiresAt}`, `enrollment token
{id, kind: core|node, role, features, expiresAt, uses, createdBy}`. `uses` — максимум использований (1 =
одноразовый), TTL 1 с … 30 суток. Heartbeat раз в 30 с, `offline` после 90 с
тишины. Ключ узла может иметь TTL (`keyTtlSec` / `AGIL_NODE_KEY_TTL_SEC`,
0 = бессрочно) и ротируется admin-эндпоинтом; истёкший ключ даёт `401`.
Лимиты раздельные: enrollment — 120/мин на IP; heartbeat — внешний bucket
на IP (`AGIL_HEARTBEAT_IP_RATE_LIMIT_PER_MIN`, по умолчанию 600/мин, списывается
до проверки ключа) и 10/мин на узел после успешной аутентификации
(`AGIL_HEARTBEAT_RATE_LIMIT_PER_MIN`; ключ — tenant id + node id, поэтому
одинаковый node id у двух тенантов не делит bucket), поэтому NAT-флот не
троттлит себя, а поток
разных поддельных ключей с одного IP упирается в IP-bucket.

**Модули узла (Docker add-on пакеты).** Разрешены только `egress`, `stt`,
`recorder`, `turn`, `sip` и действия `start|stop|restart|install|remove`.
Дашборд не передаёт образ или команду — тело действия только `{action}`, образ
для `install` всегда берётся из каталога Core (сопоставление по Docker-
репозиторию, поэтому допустим только другой тег/дайджест разрешённого образа).
Узел присылает в heartbeat полный снимок `modules[]` (неизвестные id и чужие
образы отбрасываются) и подтверждения `moduleResults[]`; ответ heartbeat всегда
содержит `moduleCommands[]` — каждая команда доставляется ровно один раз, TTL
5 минут, не более 16 в очереди на узел, `status:"offline"` не получает новых
команд. Команды и подтверждения аудируются (`cluster.node.module.command` /
`cluster.node.module.result`), без секретов. Полный контракт (каталог, очереди,
семантика `NodeSummary.modules`, flow для UI/агента) — в
[api/cluster.md §10](api/cluster.md#10-per-node-modules-docker-add-on-packages).

Enrollment
дополнительно можно ограничить `AGIL_ENROLL_ALLOW_IPS` (независимо от
`AGIL_ADMIN_*`). Записи (токены/join/register/heartbeat, admin
PATCH/disable/drain/delete/rotate узлов, комнаты, конфиг организации) выполняет
только лидер: на standby или Core без действующей аренды — `409 not_leader`. С
`AGIL_REDIS_URL` роль определяется арендой в Redis (failover, fencing — см.
`agil/core/docs/ha-leader.md`), без него — `AGIL_CLUSTER_ROLE=standby`. Если
запись реестра не удалась (например, живой foreign-lock), ответ `503
registry_unavailable`, а in-memory изменение откатывается — повтор безопасен.

```bash
TOKEN=$(curl -s -X POST http://localhost:8787/v1/admin/cluster/tokens \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"kind":"node","role":"sfu","features":["sfu"],"ttlSec":3600}' | jq -r .token)

curl -s -X POST http://localhost:8787/v1/nodes/register \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"nodeId\":\"edge-1\",\"role\":\"sfu\",\"endpoint\":\"https://sfu-1.example:7880\"}" | jq
# → {node, nodeKey:"nk_…" (один раз), heartbeatIntervalSec:30, cluster:{…}}
```

CLI: `node agil/core/scripts/agil-cli.mjs token create|list|revoke`,
`nodes list|register|heartbeat|rotate-key`, `cluster status` (env: `AGIL_CORE_URL`,
`AGIL_API_KEY`, `AGIL_NODE_TOKEN`, `AGIL_NODE_KEY`, `AGIL_NODE_ID`, …).
Ограничения baseline (нет выборов лидера/failover/планирования комнат) — в
[api/cluster.md](api/cluster.md).

Практические эффекты: `welcome.iceServers = STUN (AGIL_ICE_SERVERS) + TURN-пул
config.scale.turn` (credential из env; пустой env → без credential);
`mediaMode` комнаты = `effectiveMediaMode(scale, roomMode)` (webinar+non-mesh →
`broadcast`; direct → `sfu` только если scale sfu); дефолтный
`maxParticipants` комнаты = `scale.maxParticipants` (direct ≤ 2); `GET /v1/ice`
отдаёт публичные STUN-адреса без учётных данных; `/v1/health` →
`security.mediaMode`, `security.scaleConfigured`.

---

## 19. Роли: встроенные и кастомные

Три встроенные роли — `host` (организатор), `moderator`, `guest` — задаются
`security.accessPolicy.roleDefaults` и меняются через `PUT /v1/admin/access-policy`.
Компания может создавать **свои роли** (до 30) с произвольным набором фич; токен
выпускается с `participant.roleId`, и эффективные права считаются по фичам роли
(затем действуют `deniedFeatures`, права токена и включённые `features.*`).

```bash
# список: встроенные + кастомные (с числом активных участников)
curl -s http://localhost:8787/v1/admin/roles -H 'x-api-key: dev-key' | jq

# создать роль
curl -X POST http://localhost:8787/v1/admin/roles \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"id":"streamer","name":"Стример","description":"Ведущий трансляции",
       "baseRole":"moderator","features":["chat","screenShare","liveStreaming"],
       "canModerate":true,"color":"#7c3aed"}'

# выпустить токен с этой ролью
curl -X POST http://localhost:8787/v1/tokens \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"tenantId":"demo","roomId":"<room>","participant":{"name":"Анна","roleId":"streamer"}}'
# → { token, permissions:[...], roleId:"streamer", roleName:"Стример" }

# изменить / удалить кастомную роль
curl -X PUT http://localhost:8787/v1/admin/roles/streamer \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"name":"Стример v2","baseRole":"moderator","features":["chat","screenShare"]}'
curl -X DELETE http://localhost:8787/v1/admin/roles/streamer -H 'x-api-key: dev-key'
# → { "deleted": true, "affectedParticipants": 1 }
```

Правила: `id` — `^[a-z0-9][a-z0-9_-]*$` (1..40); встроенные id
`host|moderator|guest` зарезервированы (POST → 400, PUT/DELETE → 403); дубль id →
409; лимит 30 → 409. `RoleDefinition`: `{id,name,description,baseRole,features,
canModerate,color,builtin,assigned?}`. `welcome.self.roleName` показывает
отображаемое имя кастомной роли; при удалении роли участники остаются в комнате и
откатываются на `baseRole` (их токены продолжают работать; новые токены с удалённым
`roleId` → 400 `validation_failed`). Аудит: `admin.action` kind
`role.created|role.updated|role.deleted`.


---

## 20. Ассистент панели (DeepSeek) и Guard критических изменений

### 20.1. Каталог промптов

`GET /v1/admin/assistant/prompts` (x-api-key) → `{prompts:[{role,title,description,starters,systemPrompt}]}`.
Роли: `assistant`, `config-guardian`, `security-reviewer`, `onboarding`,
`api-helper`, `scaling-advisor`, `roles-admin`.

### 20.2. Ответ ассистента

`POST /v1/admin/assistant` (x-api-key)

```bash
curl -X POST http://localhost:8787/v1/admin/assistant \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Что будет, если выключить запись?"}],
       "role":"config-guardian",
       "context":{"screen":"settings","tenantId":"demo"}}'
```

```json
{
  "reply": "Если выключить запись, участники не смогут начать запись…",
  "role": "config-guardian",
  "model": "deepseek-chat",
  "fallback": false,
  "suggestions": ["Можно ли отключить запись?", "…"]
}
```

Серверная логика: системный промпт роли + краткий контекст экрана/тенанта
(конфиг — сжато), история ≤12 сообщений/≤8000 символов. Если задан
`AGIL_DEEPSEEK_API_KEY` — запрос в `${AGIL_DEEPSEEK_BASE_URL}/chat/completions`
(OpenAI-compatible, `model`, temperature 0.3, max_tokens 900, timeout 20 s);
ключ никогда не возвращается и не логируется. При ошибке/отсутствии ключа —
детерминированный локальный ответ, `fallback: true`, модель `local-rules`,
HTTP всегда 200. Аудит: `admin.action` c `details.kind = "admin.assistant.used"`
(role/fallback/model/messageLength, без текста сообщений). Лимит: 10 запросов/мин
на тенант.

### 20.3. Guard критических изменений

`POST /v1/admin/guard/assess` (x-api-key)

Необязательное поле `locale` выбирает язык заключения о рисках. Поддерживаются `ru` и `en`, по умолчанию используется `ru`. Применяются одинаковые правила оценки и подтверждения на обоих языках.

```bash
curl -X POST http://localhost:8787/v1/admin/guard/assess \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"kind":"config","next":{"features":{"recording":false}},"intent":"выключить запись"}'
```

`kind`: `config|roles|access|scale|providers|webhook|room|integrations`.
`current` по умолчанию — живой конфиг тенанта (для `roles` — массив из
`GET /v1/admin/roles`); `next` валидируется (для `config` — deep-partial
`tenantConfigSchema`, иначе объект/массив). Ответ: `{risk, requiresConfirmation,
summary, message, findings[], recommendations[]}`. Аудит: `admin.action` c
`details.kind = "admin.guard.assessed"` (changeKind/risk/findings).

### 20.4. Изменения безопасности (QA S-01…S-10)

| ID | Поведение |
|---|---|
| S-02 | Вебхуки подписываются `hex HMAC-SHA256(secret, `${x-agil-timestamp}.${rawBody}`)`; заголовки `x-agil-timestamp`/`x-agil-signature`, окно ±300 s; совместимо с `verifyWebhookSignature` из `@agil/security` |
| S-01 | `x-agil-country` не принимается по умолчанию; только при `AGIL_GEO_HEADER_ALLOW=1` (демо/edge). В проде страна — ipapi/edge |
| S-03 | Join-токен комнаты A не даёт роль в комнате B: чужие claims игнорируются, вход как `guest` |
| S-06 | `PUT /v1/admin/access-policy` принимает `clearUserOverrides:["userId"]`; `policy.userOverrides:{}` заменяет карту (отзыв прав) |
| S-08 | JSON-тело больше лимита → `413 payload_too_large`; файлы — `413 file_too_large` |
| S-10 | Admin CORS не отдаёт `*`: только origin из `integrations.allowedOrigins`, иначе ACAO отсутствует |


---

## 21. Документация (Docs CMS): редактирование, загрузка, версии

Документация в панели открывается как страница, а не сырой `.md`. Встроенные
документы из `agil/core/docs/` (репозиторий) доступны только для чтения; правки и загрузки
создают **custom-копию** в `AGIL_DATA_DIR/docs/`, история — в
`AGIL_DATA_DIR/docs/.history/<name>/<timestamp>.json`, выбранный основной
документ — `AGIL_DATA_DIR/docs/.default.json`. Public `/docs/:file` отдаёт
custom-копию, если она есть (иначе bundled), `Content-Type: text/markdown`;
листинга каталога и доступа к служебным файлам нет.

```bash
KEY='-H "x-api-key: dev-key"'

# список: bundled + custom, defaultName, editable
curl -s http://localhost:8787/v1/admin/docs -H 'x-api-key: dev-key' | jq

# прочитать
curl -s http://localhost:8787/v1/admin/docs/api-guide.md -H 'x-api-key: dev-key' | jq -r .content

# сохранить правку (≤200KB; старая версия уходит в историю)
curl -X PUT http://localhost:8787/v1/admin/docs/api-guide.md \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"content":"# AgilFrame API\n\nОбновлённое описание.","title":"AgilFrame API"}'

# загрузить .md/.txt: raw body + x-file-name или JSON {name,content}
curl -X POST http://localhost:8787/v1/admin/docs/upload \
  -H 'x-api-key: dev-key' -H 'x-file-name: onboarding.md' -H 'content-type: text/markdown' \
  --data-binary @onboarding.md

# версии и восстановление
curl -s http://localhost:8787/v1/admin/docs/api-guide.md/versions -H 'x-api-key: dev-key' | jq
curl -s http://localhost:8787/v1/admin/docs/api-guide.md/versions/<id> -H 'x-api-key: dev-key' | jq -r .content
curl -X POST http://localhost:8787/v1/admin/docs/api-guide.md/versions/<id>/restore -H 'x-api-key: dev-key'

# выбрать основной документ
curl -X PUT http://localhost:8787/v1/admin/docs/default \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"name":"api-guide.md"}'

# сбросить custom к bundled (или удалить загруженный документ)
curl -X DELETE http://localhost:8787/v1/admin/docs/api-guide.md -H 'x-api-key: dev-key'
```

Правила: имя — `[a-z0-9][a-z0-9._-]*.(md|txt)` (traversal/абсолютные пути/вложенные
каталоги запрещены, путь дополнительно проверяется `resolve` внутри каталога);
размер ≤200KB (`413 payload_too_large`); каждый PUT/upload/restore архивирует
предыдущую эффективную версию; `DELETE` сбрасывает custom к bundled, для
загруженного без bundled — удаляет. Аудит: `admin.action` kind
`docs.updated|docs.uploaded|docs.reset|docs.restored|docs.default.changed` —
без содержимого документов. Explorer `/docs` показывает список документов и
выбранный основной (без `.history` и служебных файлов).

Для восстановления передайте `{"expectedRevision":"…"}` в JSON-теле POST,
используя `revision` из последнего чтения текущей публикации. Если публикация
успела измениться, Core вернёт `409 document_conflict` и сохранит текущий
текст и историю. Успешное восстановление записывает в аудит имя документа
и идентификатор архивной версии. Для совместимости допускается POST без
тела. В кластере с выбором лидера восстановление и сброс принимает лидер.

`DELETE /v1/admin/docs/:name` принимает тот же необязательный JSON с
`expectedRevision`. При конфликте Core сохраняет публикацию, историю и
выбранный основной документ.

`PUT /v1/admin/docs/:name` и JSON-форма `POST /v1/admin/docs/upload`
принимают `expectedRevision: null` для создания документа только при
свободном имени. Для замены существующего документа передайте его
текущую ревизию. При конфликте Core возвращает `409 document_conflict`
до изменения публикации или истории.

---

## 22. SaaS: организации (мультитенантность)

Один сервер/API обслуживает несколько организаций; у каждой свой конфиг
(брендинг, тема, фичи, безопасность, провайдеры). **Платформенный ключ**
`x-api-key: $AGIL_PLATFORM_KEY` управляет организациями; остальные ключи —
обычные tenant-ключи и видят только свой тенант. Environment-ключи
`AGIL_API_KEYS` продолжают работать (обратная совместимость); динамические ключи
хранятся **хэшем** в `AGIL_DATA_DIR/api-keys.json`.

### Платформенный список

```bash
curl -s https://calls.example.com/v1/admin/tenants \
  -H "x-api-key: $AGIL_PLATFORM_KEY" | jq
# → { "platform": true, "tenants": [{ "tenantId":"demo", "name":"AgilFrame",
#      "organizationName":"", "productName":"AgilFrame", "logoUrl":"",
#      "scheme":"auto", "rooms":0, "participants":0, "recordings":0,
#      "apiKeyConfigured":true, "createdAt":1760000000000 }] }
```

### Создать организацию (ключ показывается один раз)

```bash
curl -X POST https://calls.example.com/v1/admin/tenants \
  -H "x-api-key: $AGIL_PLATFORM_KEY" -H 'content-type: application/json' \
  -d '{
    "tenantId":"acme",
    "name":"ACME Meet",
    "organizationName":"ACME LLC",
    "branding":{"productName":"ACME Meet","logoUrl":"https://example.com/logo.png"},
    "theme":{"scheme":"dark"},
    "preset":"corporate"
  }'
# → { "tenant": {...}, "apiKey":"agil_acme_…", "embedUrl":"https://.../embed.html?tenant=acme" }
```

`preset`: `default` | `corporate` (waiting room, строгий lockout, без файлов/записи)
| `minimal` (только базовый звонок/чат). `templateTenantId` копирует конфиг
существующего тенанта. `tenantId` — `[a-zA-Z0-9._-]{1,64}`, дубль → `409`.

### Ключи и жизненный цикл

```bash
# ротация: старый динамический ключ этого тенанта инвалидируется
curl -X POST https://calls.example.com/v1/admin/tenants/acme/keys \
  -H "x-api-key: $AGIL_PLATFORM_KEY"
# → { "tenantId":"acme", "apiKey":"agil_acme_…" }   # сохранить, показывается один раз

# summary/изменение брендинга (платформа или сам тенант своим ключом)
curl -s https://calls.example.com/v1/admin/tenants/acme -H "x-api-key: agil_acme_…"
curl -X PATCH https://calls.example.com/v1/admin/tenants/acme \
  -H 'x-api-key: agil_acme_…' -H 'content-type: application/json' \
  -d '{"branding":{"productName":"ACME Meet v2"}}'

# удаление (только платформа; demo и env-ключевые тенанты защищены)
curl -X DELETE https://calls.example.com/v1/admin/tenants/acme \
  -H "x-api-key: $AGIL_PLATFORM_KEY"
```

Изоляция: ключ тенанта A на админ/публичных ручках тенанта B → `403`
(и `404` для чужих комнат), платформенный ключ не является tenant-ключом
(на tenant-ручках → `403`). Удаление архивирует конфиг в
`AGIL_DATA_DIR/tenants/.archive/`, отзывает динамический ключ и закрывает
in-memory комнаты; env-ключи API отозвать не может (такие тенанты не удаляются).
Аудит: `tenant.created|tenant.updated|tenant.key.rotated|tenant.deleted`.

---

## 23. Лобби (waiting room с admit/reject)

При `security.waitingRoom=true` гость после пароля попадает в очередь, а не
получает токен: `POST /v1/rooms/:id/join` → **202**
`{pending:true, requestId, roomId, status:"pending", expiresAt, pollAfterMs:2000}`.
Хост/модератор с валидным room-токеном или tenant-admin-ключом проходит сразу;
`waitingRoom=false` — прежнее поведение.

```bash
# гость
curl -X POST http://localhost:8787/v1/rooms/<room>/join \
  -H 'content-type: application/json' -d '{"name":"Гость"}'
# → 202 {"pending":true,"requestId":"...","status":"pending",...}

# хост/модератор: очередь (Bearer host-токен или x-api-key)
curl -s http://localhost:8787/v1/rooms/<room>/lobby -H 'authorization: Bearer <HOST_TOKEN>'
# → {"roomId":"...","requests":[{"id","name","country","createdAt","expiresAt","status":"pending"}]}

# впустить / отклонить / убрать из очереди
curl -X POST http://localhost:8787/v1/rooms/<room>/lobby/<requestId>/admit \
  -H 'authorization: Bearer <HOST_TOKEN>'
curl -X POST http://localhost:8787/v1/rooms/<room>/lobby/<requestId>/reject \
  -H 'authorization: Bearer <HOST_TOKEN>' -H 'content-type: application/json' -d '{"reason":"busy"}'
curl -X DELETE http://localhost:8787/v1/rooms/<room>/lobby/<requestId> -H 'authorization: Bearer <HOST_TOKEN>'

# гость опрашивает свою заявку; токен отдаётся ОДИН раз после admit
curl -s http://localhost:8787/v1/rooms/<room>/lobby/<requestId>
# → {"status":"admitted","token":"...","joinUrl":"...","embedUrl":"..."}  (повторно token отсутствует)
```

WS для host/moderator: `lobby.queue` при welcome, `lobby.pending`,
`lobby.admitted`, `lobby.rejected`. Лимит/TTL: `AGIL_LOBBY_MAX` (50) и
`AGIL_LOBBY_TTL_SEC` (600); при переполнении — `409 lobby_full`, истёкшая
заявка в poll — `status:"expired"`. Аудит: `lobby.pending`, `lobby.admitted`,
`lobby.rejected`, `lobby.expired`.

## 24. Календарь (ICS)

`GET /v1/rooms/:id/calendar.ics[?start=ISO&durationMin=60&download=1]` —
публичный (capability = roomId) `text/calendar; charset=utf-8`: VCALENDAR/VEVENT
с UTC `DTSTART/DTEND`, `SUMMARY` (имя комнаты), `DESCRIPTION/LOCATION/URL`
(join-ссылка), `UID=<roomId>@<host>`, `STATUS:CONFIRMED`. `download=1` —
`content-disposition: attachment`. Неизвестная комната → 404, неверный `start` → 400.

## 25. Кастомные домены (white-label, host-resolution + DNS verify)

`GET/PUT/POST/DELETE /v1/admin/domain` + `POST /v1/admin/domain/verify`
(tenant admin). Полный сценарий, reverse-proxy (Caddy/HAProxy, SNI/ACME) и
ограничения — `agil/core/docs/custom-domains.md`.

```bash
# 1) задать домен: сохраняется в branding.customDomain, статус pending
curl -X PUT http://localhost:8787/v1/admin/domain \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"domain":"meet.acme.com"}'
# → {"domain":"meet.acme.com","status":"pending","verified":false,
#    "verification":{"token":"4f1c…","method":"txt",
#      "txt":{"name":"_agil-calls.meet.acme.com","value":"agil-verify=4f1c…","ttl":300},
#      "cname":{"name":"meet.acme.com","value":"calls.example.com","ttl":300}},
#    "dnsInstructions":{"type":"CNAME","name":"meet.acme.com","value":"calls.example.com","ttl":300},
#    "docsHint":"..."}

# 2) опубликовать DNS: TXT _agil-calls.meet.acme.com = "agil-verify=<token>"
#    (обязательно для первой верификации) и CNAME meet.acme.com -> AGIL_DOMAIN_TARGET
#    (маршрутизация; без TXT первая верификация не пройдёт)

# 3) проверить (200 + status pending|verified; pending содержит lastError)
curl -X POST http://localhost:8787/v1/admin/domain/verify -H 'x-api-key: dev-key'
# → {"domain":"meet.acme.com","status":"verified","verified":true,
#    "verification":{"method":"txt","verifiedAt":1763…}}

# 4) статус/сброс
curl -s http://localhost:8787/v1/admin/domain -H 'x-api-key: dev-key' | jq
curl -X DELETE http://localhost:8787/v1/admin/domain -H 'x-api-key: dev-key'
```

Правила:

- формат: bare hostname (lowercase, без схемы/пути/порта, метки 1..63, ≤253,
  без IP/localhost/wildcards); пустая строка/DELETE — сброс;
- `pending` → `verified` только после DNS-подтверждения: **TXT token
  обязателен для первой верификации** (доказывает владение доменом), CNAME на
  `AGIL_DOMAIN_TARGET` — маршрутизация; CNAME без TXT принимается только как
  повторная проверка уже verified-домена; pending-домен **не** резолвится,
  трафик идёт на default tenant;
- один домен на тенант и один тенант на домен; чужой домен → `409
  domain_conflict`;
- host-mapping персистится в `AGIL_DATA_DIR/domains.json`; `branding.customDomain`,
  записанный старым `PATCH /v1/tenants/:id/config`, импортируется как pending;
- запрос через verified-домен: `Host` → tenant (после `x-api-key`/Bearer/path),
  `/v1/host` отдаёт брендинг, анонимная комната без `tenantId` создаётся в этом
  тенанте, `joinUrl`/`embedUrl` строятся на `https://<домен>`;
- неизвестный/битый `Host` → fallback на `AGIL_DEFAULT_TENANT` (200, без утечки
  ошибки); `?tenant=` остаётся явным override;
- TLS/ACME — внешний Caddy/HAProxy; `GET /v1/domain/ask?domain=` — hook для
  on-demand TLS (200 только для verified; только с IP прокси, по умолчанию
  loopback, обязательный секрет, Host allowlist и rate-limit; без `tenantId` в
  ответе);
- аудит: `domain.updated`, `domain.verified`, `domain.verify_failed`.

Ограничения baseline: нет автоматического recheck по таймеру (verify вручную),
нет wildcard/IDN-кириллицы (только punycode), DNS должен быть виден серверу,
один общий `domains.json` на процесс/volume (в кластере — общий volume или
внешний registry).

---

## 26. Опросы и Q&A

Опросы живут в комнате (in-memory, до 50 на комнату) и синхронизируются по WS
событием `poll.updated {roomId, poll, reason:"created"|"voted"|"closed"}`.
Создавать/закрывать может host/moderator (room-scoped Bearer host/moderator или
tenant admin key), голосовать — участник с join-токеном.

Результаты для участников, организатора и администратора содержат суммарные
голоса по вариантам. Параметр `anonymous` сохранён для совместимости. Значение
`false` не добавляет имена голосующих или их индивидуальные ответы. Участник
видит свой выбор, а событие аудита `poll.voted` хранит его ID без варианта ответа.

```bash
# создать (host/moderator)
curl -X POST http://localhost:8787/v1/rooms/<room>/polls \
  -H 'authorization: Bearer <HOST_TOKEN>' -H 'content-type: application/json' \
  -d '{"question":"Куда идём на обед?","options":[{"text":"Пицца"},{"text":"Суши"}],
       "multiple":false,"anonymous":true,"kind":"poll"}'
# → RoomPoll {id, options:[{id,text,votes,share}], status:"open", totalVotes:0, ...}

# список (любой участник; selected/voted персонализируются по токену)
curl -s http://localhost:8787/v1/rooms/<room>/polls \
  -H 'authorization: Bearer <GUEST_TOKEN>'

# голос (один на участника; optionIds 1..10; для multiple — несколько)
curl -X POST http://localhost:8787/v1/rooms/<room>/polls/<pollId>/vote \
  -H 'authorization: Bearer <GUEST_TOKEN>' -H 'content-type: application/json' \
  -d '{"optionIds":["<optionId>"]}'
# → {poll, accepted:true}  |  повтор: {accepted:false, reason:"already_voted"}

# закрыть (host/moderator)
curl -X POST http://localhost:8787/v1/rooms/<room>/polls/<pollId>/close \
  -H 'authorization: Bearer <HOST_TOKEN>'
# → RoomPoll status:"closed", closedAt
```

Ограничения: question 3..500, вариантов 2..10 (текст 1..200), нельзя два варианта
в single-choice (`accepted:false reason:"single_choice_only"`), невалидный
optionId → `accepted:false reason:"invalid_option"`, голос после закрытия →
`409 poll_closed`, неизвестный poll → `404 poll_not_found`, лимит комнаты →
`409 poll_limit`, гость создаёт/закрывает → `403`. `share` — доля от числа
голосующих (0..1), `totalVotes` — число проголосовавших. Аудит: `poll.created`,
`poll.voted` (participantId, без имени), `poll.closed`.

---

## 27. Breakout rooms

Host/moderator делит участников на подкомнаты: создаются child-комнаты в том же
тенанте, каждому участнику выдаётся room-токен на его подкомнату и приходит WS
`breakout.assigned`; все видят `breakout.started {plan}`. Активен только один
план; лимит 20 подкомнат; child-комнаты скрыты из общего списка комнат админки.

```bash
# старт (host/moderator room Bearer или tenant admin key)
curl -X POST http://localhost:8787/v1/rooms/<room>/breakouts/start \
  -H 'authorization: Bearer <HOST_TOKEN>' -H 'content-type: application/json' \
  -d '{"mode":"random","count":2,"durationMin":15,"allowReturn":true}'
# manual: {"mode":"manual","rooms":[{"name":"Дизайн","participantIds":["p1","p2"]},
#                                  {"name":"Разработка","participantIds":["p3"]}]}
# → BreakoutPlan {id,status:"active",rooms:[{id,roomId,name,index,participantIds,status}],
#                 assignments:{participantId:breakoutRoomId}, endsAt?}

# текущий план (host/moderator/admin)
curl -s http://localhost:8787/v1/rooms/<room>/breakouts -H 'authorization: Bearer <HOST_TOKEN>'

# вернуться в основной звонок (участник; 403 если allowReturn=false)
curl -X POST http://localhost:8787/v1/rooms/<room>/breakouts/return \
  -H 'authorization: Bearer <MAIN_TOKEN>'
# → {"returnToRoomId":"<main-room>"}

# закрыть (host/moderator/admin): child-комнаты закрываются, план closed
curl -X POST http://localhost:8787/v1/rooms/<room>/breakouts/close \
  -H 'authorization: Bearer <HOST_TOKEN>'
```

Ограничения/ошибки: уже активен → `409 breakout_active`; <2 участников →
`409 not_enough_participants`; count/rooms вне 2..20 → `400`; manual с чужим/
дублирующим participantId → `400`; нет плана → `404`; старт/закрытие/список
гостем → `403`. `durationMin` (1..240) задаёт `endsAt`; по истечении план
закрывается лениво при следующем GET/start и таймером `setTimeout` (если процесс
жив), с broadcast `breakout.closed`. WS: `breakout.started {plan}`,
`breakout.assigned {assignment}` (каждому участнику, включая host),
`breakout.closed {plan}`. Токены основной комнаты остаются валидны; child-комнаты
имеют собственный capacity и не попадают в список комнат админки. Аудит:
`breakout.started`, `breakout.closed` (и `admin.action` kind `breakout.returned`).

---

## 28. SFU media (SFU-плоскость)

Когда эффективный режим медиа — `sfu`/`broadcast` (см. `config.scale.mediaMode`
/ webinar) **и** SFU настроен, сервер выдаёт клиенту короткоживущий HS256 JWT
(LiveKit-совместимый) в `JoinRoomResponse.media` и `welcome.media`:

```json
{
  "mode": "sfu",
  "url": "wss://sfu.example.com",
  "token": "eyJhbGciOiJIUzI1NiIs…",
  "room": "demo__<roomId>",
  "canPublish": true,
  "expiresAt": 1794600000000
}
```

Claims: `iss` = API key SFU, `sub` = participantId, `name`, `nbf/exp`
(TTL = min(1h, TTL join-токена)), `video:{room, roomJoin:true, canPublish,
canSubscribe:true}`. Подпись HS256 секретом SFU (`node:crypto`), токены не
логируются. Комната SFU = `<tenantId>__<roomId>` (небезопасные разделители
заменяются). `canPublish`: host/moderator всегда; guest — по умолчанию да
(MVP mesh-паритет), но в webinar/broadcast viewer (`scale.webinar.enabled &&
hostOnlyPublish` или `mediaMode=broadcast` для guest) — `false`
(receive-only). `canSubscribe` всегда true.

Настройка (env приоритетнее tenant-конфига):
`AGIL_SFU_URL`, `AGIL_SFU_API_KEY`, `AGIL_SFU_API_SECRET`,
`AGIL_SFU_ENABLED` (default auto = все три заданы), `AGIL_SFU_PROFILE`
(`low|standard|high`; default `standard`, важнее
`scale.sfu.capacityProfile`; пилот 1 vCPU/2 GB задаёт `low`).
Профиль задаёт и бюджет видео, и лимит комнаты: `low` 25, `standard` 50,
`high` 200 участников, а эффективный лимит —
`min(room.maxParticipants, scale.maxParticipants, profile.participants,
sfu.maxParticipants)`. Он проверяется при создании комнаты (лимит
уменьшается), в REST join, lobby admit и WS-handshake; при переполнении —
`409 room_full`, `details.reason=profile|sfu|scale|room`, сообщение называет
профиль. `GET /v1/admin/scale` показывает реальный `sfuConfigured`, эффективный
`sfuProfile`, `sfuCapacity.participants`, `effectiveMaxParticipants` и `capacity`;
`GET /v1/admin/rooms/:roomId` — `effectiveMaxParticipants`/`capacity`.
Если SFU не настроен/выключен — `media` отсутствует, клиент остаётся на mesh
(обратная совместимость); при mesh-режиме media не выдаётся. UI (SfuEngine)
подключается к `url` с `token`.

---

## 29. Обработка медиа на сервере (опционально, по умолчанию выключено)

Политика — `TenantConfig.mediaProcessing` (default: `client-only`, все
компоненты `false`, `provider:"none"`). Вся обработка видео/аудио — на клиентах;
сервер не транскодирует, не блюрит и не микширует аудио, egress-воркеры в этой
сборке не запускаются. SFU (если включён) только пересылает медиа.

```bash
curl -s http://localhost:8787/v1/admin/media/processing -H 'x-api-key: dev-key'
# → { "policy":{"mode":"client-only","video":false,"audio":false,
#              "egress":false,"transcoding":false,"provider":"none"},
#     "serverProcessingActive":false, "sfuForwardingOnly":false,
#     "egressConfigured":false, "misconfigured":false, "note":"client-only: …" }

# включить политику server-assisted (только декларация; воркеров нет)
curl -X PATCH http://localhost:8787/v1/tenants/demo/config \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"mediaProcessing":{"mode":"server-assisted","video":true,"audio":true,
       "egress":true,"transcoding":true,"provider":"livekit-egress"}}'
# ответ содержит mediaProcessing-статус; PATCH проходит и при неполной политике,
# но добавляет warning + misconfigured:true (не блокирует)
```

Флаги:
- `serverProcessingActive` = `mode==="server-assisted"` и хотя бы один из
  `video|audio|egress|transcoding` включён;
- `sfuForwardingOnly` = `scale.mediaMode !== "mesh"` (SFU/broadcast — только
  пересылка);
- `egressConfigured` = `egress && provider !== "none"` (декларация; egress-воркер
  не реализован — в `note` предупреждение);
- `misconfigured` = `server-assisted` без единого компонента (warning, не 4xx).

Валидация — zod (`media.processing` в `tenantConfigPatchSchema`): неизвестный
mode/provider → `400 validation_failed`. Изменение политики аудитируется
(`config.updated`, `details.kind="media.processing.updated"`, без секретов).
`GET /v1/admin/scale` содержит краткий `mediaProcessing` summary. По умолчанию
никакие серверные транскод/блюр/аудио-миксы и egress не запускаются.

---

## 30. E2EE (SFU/LiveKit): ключ комнаты

При `security.e2ee=true` и активном SFU-медиа (`mediaMode: sfu|broadcast` + настроенный SFU) сервер раздаёт участникам комнаты **один и тот же** ключ шифрования в `media.e2ee` (`JoinRoomResponse.media` и `welcome.media`):

```json
{
  "mode": "sfu",
  "url": "wss://sfu.example.com",
  "token": "eyJ…",
  "room": "demo__<roomId>",
  "canPublish": true,
  "expiresAt": 1794600000000,
  "e2ee": { "key": "base64url-32-bytes", "algorithm": "AES-GCM", "keyIndex": 0 }
}
```

- Ключ детерминированный: `HMAC-SHA256(secret, "${tenantId}:${roomId}")` → 32 байта, `base64url`; все участники комнаты получают одинаковый, разные комнаты — разные ключи.
- `secret` = `AGIL_E2EE_SECRET`; если он не задан — **dev-only fallback** на секрет join-токена (`AGIL_TOKEN_SECRET`) с предупреждением в `GET /v1/admin/media/processing` (`e2eeConfigured:false`, note). В проде задавайте отдельный `AGIL_E2EE_SECRET`.
- Ключ **не включается в LiveKit JWT**, не пишется в логи и аудит; передаётся только в media-блоке участнику.
- `mediaMode: mesh` или `e2ee=false` → поля `e2ee`/`media` нет.
- **Конфликт с серверной обработкой:** при E2EE + `mediaProcessing.egress|transcoding` или серверной записи/STT сервер не сможет расшифровать поток — `GET /v1/admin/media/processing` возвращает `e2eeConflict:true`, `misconfigured:true` и предупреждение; egress/обработка не запускаются. `GET /v1/admin/scale` содержит `mediaProcessing.e2eeConfigured/e2eeActive`.

Формат для фронтенда (SfuEngine): `media.e2ee = { key, algorithm:'AES-GCM', keyIndex:0 }` — использовать как shared room key для Encoded Transform/Insertable Streams; ключ не логировать.

---

## 31. SSO / OIDC: подтверждённые входы и вход в панель

Проверка **OIDC identity JWT** при join и **вход в панель управления** по
authorization code + PKCE (SCIM — отдельный раздел §32). Подробный операторский
гайд, Keycloak-пример и модель угроз — `docs/sso-oidc.md`.
Настройка — `integrations.identity` тенанта: `mode:"oidc"`, `issuer`, `audience`,
`jwksUrl`, `userIdClaim/nameClaim/roleClaim/permissionsClaim/verifiedClaim`
(`jwksUrl` не нужен при `discovery:true` — берётся `jwks_uri` из метаданных), а
для входа в панель также `authorizationEndpoint`, `tokenEndpoint`, `clientId`,
`clientSecretEnv`, `redirectUri`, `scopes`, `tokenEndpointAuthMethod`,
`responseMode`, `endSessionEndpoint`, `postLogoutRedirectUri`, `discovery`,
`discoveryUrl`.
Политика доступа (все поля необязательны, но рекомендуются): `emailClaim`,
`emailVerifiedClaim`, `requireEmailVerified`, `allowedEmails`,
`allowedEmailDomains`, `groupsClaim`, `groupRoleMap`, `dashboardAdminGroups`,
`tenantClaim`, `maxTokenAgeSec`, `clockSkewSec`.

```bash
# проверить identity без выдачи токенов
curl -X POST http://localhost:8787/v1/auth/oidc/verify \
  -H 'content-type: application/json' \
  -d '{"tenantId":"demo","identityToken":"eyJhbGciOiJSUzI1NiIs…"}'
# → { "userId":"user-123", "name":"Иван Петров", "role":"moderator",
#     "permissions":["chat","screenShare"], "verified":true, "issuer":"https://sso.example" }

# join с identity (при security.requireVerifiedIdentity=true обязателен)
curl -X POST http://localhost:8787/v1/rooms/<room>/join \
  -H 'content-type: application/json' \
  -d '{"identityToken":"eyJhbGciOiJSUzI1NiIs…"}'
```

Проверяется: подпись RS256/ES256 по ключам из `jwksUrl` (fetch с timeout 3s,
кэш 10 мин с учётом `Cache-Control: max-age` в диапазоне 1–60 мин, один
rate-limited refetch при неизвестном `kid`, негативный кэш 30 c при сбое;
редиректы запрещены, URL проходит URL-политику; никакой SSRF за пределы
настроенного `jwksUrl`). Ключи `oct`/`enc` и RSA < 2048 бит игнорируются, `alg`
только RS256/ES256 и должен совпадать с типом ключа, `typ: at+jwt` отклоняется.
`iss` обязателен для `mode:"oidc"` и сравнивается точно; `aud` — `audience` или
`clientId`, для multi-aud обязателен доверенный `azp`; `exp`/`nbf`/`iat` — с
настраиваемым `clockSkewSec` (60 c по умолчанию, 0–300), опционально
`maxTokenAgeSec` ограничивает `exp − iat`. Маппинг claims: `name/role/
permissions` из проверенных claims; роль — `groupRoleMap` (если задан: только
группы IdP, иначе guest) либо `roleClaim`; permissions — только известные feature
keys. `verifiedClaim` должен быть `true` при
`security.requireVerifiedIdentity=true`, иначе `401 invalid_identity_token`.
Политика: непустые `allowedEmails`/`allowedEmailDomains` требуют email из
allowlist (домен точно либо `*.domain` — только поддомены; явный
`email_verified:false` запрещает вход даже без allowlist/`requireEmailVerified`,
битый список запрещает всех —
fail closed); непустой `dashboardAdminGroups` ограничивает вход в панель;
`tenantClaim` должен совпасть с `tenantId` тенанта. Нарушения — `403
identity_not_allowed` / `403 tenant_mismatch`.
Без токена при обязательной идентичности — `401 identity_required`. Токен
никогда не пишется в логи/аудит. Ошибки: `identity_required`,
`invalid_identity_token`, `identity_not_allowed`, `tenant_mismatch`,
`identity_not_configured` (если OIDC не настроен/JWKS недоступен). Токены на
`/v1/auth/oidc/verify` не выдаются.

### 31.1 Вход в панель: authorization code + PKCE

Кнопка «Войти через SSO» на экране входа панели. Дополнительные поля
`integrations.identity`: `authorizationEndpoint`, `tokenEndpoint` (пусты при
`discovery:true` — берутся из метаданных IdP; явные значения имеют приоритет),
`clientId`,
`clientSecretEnv` (имя env-переменной с секретом — сам секрет в конфиг не
попадает; имя обязано быть привязано к тенанту: `AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>`
для канонического lower-case id или **точная** запись в `AGIL_OIDC_TENANT_SECRETS`
(ключ сравнивается с id с учётом регистра; коллизии `a-b`/`a_b`/`a.b`/`A_B` и
`demo`/`DEMO` не алиасятся); чужое/непривязанное имя даёт `400
validation_failed`, значения читаются при старте сервера), `redirectUri` (пусто — `<AGIL_PUBLIC_ORIGIN>/v1/auth/oidc/callback`) и
`scopes` (пусто — только `openid`; `openid` добавляется всегда).
`tokenEndpointAuthMethod` — `client_secret_post` (default) или
`client_secret_basic`; `responseMode` — `query` (default) или `form_post`;
`discovery`/`discoveryUrl` включают OIDC discovery; `endSessionEndpoint` +
`postLogoutRedirectUri` включают RP-initiated logout.

```bash
# 1. Начать вход: сервер создаёт state+nonce+PKCE(S256), TTL 10 минут (в памяти)
#    Для same-origin браузера также ставит HttpOnly cookie привязки state.
curl 'http://localhost:8787/v1/auth/oidc/start?tenantId=demo&returnTo=%2Fdashboard%2F'
# → { "authorizationUrl": "https://sso.example.com/authorize?...", "expiresAt": 1731690000000 }

# 2. Браузер уходит на authorizationUrl, IdP возвращает на redirectUri:
#    GET /v1/auth/oidc/callback?code=…&state=…   (cookie привязки обязательна)

# 3. Сервер обменивает code (client_secret из env), проверяет id_token
#    (JWKS, iss/aud/azp/exp/nbf/iat/nonce, tenant/email/group policy) и отвечает 302:
#    Location: http://localhost:8787/dashboard/#sso_token=<admin session JWT>

# 4. Выход: отзывает jti текущей сессии на сервере (204), затем панель удаляет токен
curl -X POST http://localhost:8787/v1/auth/oidc/logout \
  -H "authorization: Bearer <admin session JWT>"
```

- `returnTo` — относительный путь (`/dashboard/`) либо абсолютный URL того же
  origin или из `integrations.allowedOrigins`; иначе `400 validation_failed`
  (защита от open redirect). Относительный путь разрешается против
  `AGIL_PUBLIC_ORIGIN`, и **после разрешения** его origin обязан совпасть с
  публичным (scheme+host+port). Обратные слэши и управляющие символы
  (`/\evil.example`, `%2F%5C…`, CR/LF/NUL), protocol-relative `//…`, credentials
  и фрагменты отклоняются; authorization URL в этом случае не выдаётся.
  `tenantId` необязателен (по умолчанию `AGIL_DEFAULT_TENANT`).
- `state` одноразовый, 32 random байта, привязан к cookie
  `agil_oidc_binding` (HttpOnly, SameSite=Lax, Path=`/v1/auth/oidc`) для
  same-origin панели: callback без cookie отклоняется (`state_invalid`) и state
  сжигается. `AGIL_OIDC_COOKIE_BINDING=0` отключает привязку; для cross-origin
  панели она пропускается автоматически (браузер не сохранит Set-Cookie), при
  этом state/nonce/PKCE продолжают действовать — см. `docs/sso-oidc.md`.
- **OIDC discovery**: `integrations.identity.discovery:true` (или непустой
  `discoveryUrl`) — сервер загружает `/.well-known/openid-configuration`,
  проверяет `issuer` документа и резолвит authorization/token/JWKS/
  end_session endpoints; явные endpoint-поля имеют приоритет и служат fallback
  при недоступном discovery. `tokenEndpointAuthMethod`: `client_secret_post`
  (по умолчанию) или `client_secret_basic`; `responseMode`: `query` или
  `form_post` (POST на тот же `/v1/auth/oidc/callback`, cookie `SameSite=None`).
- Токен сессии добавляется **только во фрагмент** (`#sso_token=…`): фрагмент не
  уходит на сервер, не попадает в логи/прокси/Referer и стирается из адресной
  строки панелью сразу после загрузки.
- Сессия — HS256 JWT `{kind:"admin_session", role:"admin", tenantId, sub, name,
  jti, iat, exp}`; TTL `AGIL_ADMIN_SESSION_TTL_SEC` (900 c по умолчанию).
  Ключ подписи производится из `AGIL_TOKEN_SECRET` с отдельной меткой, поэтому
  join-токен нельзя использовать как admin-сессию (и наоборот).
- Сессия принимается как `Authorization: Bearer <session>` **вместо** `x-api-key`
  на tenant-эндпоинтах (`/v1/admin/*`, `PATCH /v1/tenants/:id/config`); на
  платформенных маршрутах (`/v1/admin/tenants`) она даёт `403 forbidden`.
- `POST /v1/auth/oidc/logout` отзывает `jti` в in-memory deny-list до `exp`
  (идемпотентно, 204 и для неизвестного токена; Bearer-only, поэтому CSRF не
  применим). Отзыв действует в пределах процесса.
- **RP-initiated logout** (если задан `endSessionEndpoint` или discovery дал
  `end_session_endpoint`): `GET /v1/auth/oidc/logout?tenantId=&returnTo=` →
  200 `{logoutUrl, expiresAt}`; URL содержит `client_id`, зарегистрированный
  `postLogoutRedirectUri` (по умолчанию `<AGIL_PUBLIC_ORIGIN>/v1/auth/oidc/
  logout/callback`) и одноразовый `state`. IdP возвращает браузер на callback,
  сервер сжигает state и 302-ит на `returnTo` панели (без токенов). Без
  endpoint'а — `501 identity_not_configured` (локальный logout работает).
- Ошибки не возвращают JSON (браузер в середине навигации): редирект на
  `returnTo#sso_error=<code>`. Коды: `state_invalid` (state не найден/повторно
  использован/нет cookie привязки), `state_expired` (истекли 10 минут),
  `access_denied` (IdP отклонил), `idp_error` (token endpoint недоступен/ошибка/
  PKCE mismatch), `invalid_identity_token` (подпись/iss/aud/azp/exp/nonce/typ),
  `identity_not_verified` (`verifiedClaim:false`), `identity_not_allowed`
  (email/домен/группа вне allowlist), `tenant_mismatch` (tenantClaim не совпал),
  `identity_not_configured` (нет параметров OIDC/секрета в env, discovery не дал
  endpoint'ов, IdP не поддерживает выбранный auth method/response mode),
  `validation_failed` (плохой `returnTo`, неверный Content-Type/размер
  form_post-тела).
- Аудит: `admin.action` «Dashboard SSO login» и «Dashboard SSO logout» (tenant,
  IP-hash); ни токен, ни authorization code, ни id_token, ни секрет клиента не
  пишутся в логи и аудит.
- Ограничения: pending state/deny-list хранятся в памяти процесса
  (мульти-нода — sticky sessions/shared store), поддерживаются
  `client_secret_post`/`client_secret_basic` (без `private_key_jwt`/mTLS);
  `form_post` и RP-initiated logout работают, но требуют HTTPS в реальном
  браузере; `id_token_hint` для logout не отправляется (сервер не хранит
  id_token) — IdP, требующий его, не поддержан. По
  умолчанию любой пользователь, успешно вошедший в этот OAuth-клиент, получает
  **tenant admin** — задайте `dashboardAdminGroups` и/или ограничьте клиент в IdP.

---

## 32. SCIM 2.0 (Users + Groups)

Провижининг корпоративного каталога. Auth: `Authorization: Bearer $AGIL_SCIM_TOKEN`
(если env не задан — `501`, неверный токен — `401`), тенант — заголовок
`x-tenant-id`. Content-Type: `application/scim+json`.

| Метод | Путь | Назначение |
|---|---|---|
| GET/POST | `/scim/v2/Users` | список (`startIndex`, `count`, `filter`) / создание |
| GET/PUT/PATCH/DELETE | `/scim/v2/Users/:id` | чтение/замена/PATCH/удаление |
| GET/POST | `/scim/v2/Groups` | список / создание |
| GET/PUT/PATCH/DELETE | `/scim/v2/Groups/:id` | чтение/замена/PATCH/удаление |
| GET | `/scim/v2/ServiceProviderConfig` | возможности (patch/filter, maxResults 1000) |
| GET | `/scim/v2/Schemas` | схемы User/Group |
| GET | `/scim/v2/ResourceTypes` | типы ресурсов |

```bash
TENANT=demo; SCIM="Authorization: Bearer $AGIL_SCIM_TOKEN"
curl -X POST http://localhost:8787/scim/v2/Users \
  -H "$SCIM" -H "x-tenant-id: $TENANT" -H 'content-type: application/scim+json' \
  -d '{"userName":"alice@example.com","name":{"givenName":"Alice","familyName":"Smith"},
       "emails":[{"value":"alice@example.com","primary":true}],"active":true,
       "roles":[{"value":"employee","agilRole":"guest"}]}'
# 201 + Location: /scim/v2/Users/<id>

curl -s "http://localhost:8787/scim/v2/Users?filter=userName%20eq%20%22alice%40corp.ru%22&count=1" \
  -H "$SCIM" -H "x-tenant-id: $TENANT"
# SCIM ListResponse {schemas,totalResults,startIndex,itemsPerPage,Resources}
```

Фильтры: `userName eq "…"`, `emails.value eq "…"`, `displayName eq "…"`
(для групп — `displayName`). Ответы/ошибки — стандартные SCIM (`ListResponse`,
`Error` с `scimType`); дубль `userName`/`displayName` → `409 uniqueness`;
`active:false` — soft-деактивация (DELETE удаляет ресурс, 204).
PATCH: `Operations:[{op:'add'|'replace'|'remove',path,value}]` для `active`,
`userName`, `displayName`, `name.givenName/familyName`, `emails`, `roles`,
`members`, `externalId`. Данные — per-tenant JSON в `<AGIL_DATA_DIR>/scim/<tenant>.json`
(атомарная запись), пароли/секреты не хранятся. Роли SCIM маппятся только как
данные (`roles[].agilRole` — расширение) и **не дают admin-прав автоматически**;
роль в AGIL выдаётся отдельно через access policy/token. Аудит:
`admin.action` kind `scim.user.created|updated|deleted`,
`scim.group.created|updated|deleted` (id + userName, без email/PII). Изоляция:
тенант из `x-tenant-id`, один токен может обслуживать несколько тенантов.

---

## 33. SIEM-экспорт аудита

Опциональная отправка аудита во внешний SIEM (по умолчанию выключено).
Конфиг тенанта `integrations.siem`:

```json
{ "enabled": true, "url": "https://siem.example.com/events",
  "format": "json", "secretEnv": "AGIL_SIEM_SECRET",
  "events": ["room.created", "join.denied", "security.event"],
  "timeoutMs": 3000, "retries": 2 }
```

- `events: []` — все события; иначе только перечисленные типы.
- JSON payload: `{deliveryId,ts,tenantId,event,severity,message,details,ipHash}`
  (сырой IP не отправляется, только `ipHash`; секретов в payload нет).
- CEF: `CEF:0|AGIL|Calls|0.1|<event>|<message>|<severity>|tenantId=… event=… severity=… rt=… src=<ipHash> msg=…`.
- HMAC (опционально): если `secretEnv` задан (**только `AGIL_SIEM_*`**) и
  переменная существует — заголовок `x-agil-signature` = hex
  `HMAC-SHA256(secret, rawBody)`. Произвольное имя env отклоняется на записи и
  не читается при использовании.
- Доставка fail-open: аудит и API не блокируются/не падают; таймаут (500..30000 мс)
  и retries (0..10) с backoff; последний результат — в статусе.
- URL проходит SSRF-политику (в production HTTPS/публичный хост); редиректы запрещены.

```bash
curl -s http://localhost:8787/v1/admin/siem/status -H 'x-api-key: dev-key' | jq
# → {"configured":true,"enabled":true,"format":"json","queue":0,
#    "lastError":null,"lastDelivery":{"at":…,"ok":true,"statusCode":200,"latencyMs":18,"attempts":1}}
# URL/секрет в статусе не отдаются.

curl -X POST http://localhost:8787/v1/admin/siem/test -H 'x-api-key: dev-key'
# → {"ok":true,"statusCode":200,"latencyMs":12,"detail":"test event delivered"}
# 501 siem_not_configured, если SIEM выключен/без url.
```

Тестовое событие пишется в аудит как `admin.action` kind `siem.test`.
`configured` = url задан; `enabled` = enabled && url; `queue` — размер очереди.

---

## 34. Egress: запись / RTMP / HLS

Серверный контроллер LiveKit Egress (Twirp JSON); **воркер egress — отдельный
сервис, не на app-VPS**. Клиенты не получают egress-credentials.

Env: `AGIL_EGRESS_URL` (Twirp base, например `http://127.0.0.1:7880`),
`AGIL_EGRESS_API_KEY` / `AGIL_EGRESS_API_SECRET` (по умолчанию SFU-ключи),
`AGIL_EGRESS_ENABLED` (`0` → `501 egress_disabled`).

```bash
# start (host/moderator join-token или admin key)
curl -X POST http://localhost:8787/v1/rooms/<room>/egress/start \
  -H "authorization: Bearer <host-token>" -H 'content-type: application/json' \
  -H 'Idempotency-Key: 00000000-0000-4000-8000-000000000001' \
  -d '{"kind":"recording","layout":"grid","audioOnly":false}'
# → {"egressId":"EG_…","kind":"recording","status":"EGRESS_STARTING","roomName":"demo__<room>"}

curl -X POST http://localhost:8787/v1/rooms/<room>/egress/start \
  -H "authorization: Bearer <host-token>" -H 'content-type: application/json' \
  -d '{"kind":"rtmp","rtmpUrl":"rtmp://live.example/app/<stream-key>"}'
curl -X POST http://localhost:8787/v1/rooms/<room>/egress/start -d '{"kind":"hls"}'

curl -s http://localhost:8787/v1/rooms/<room>/egress -H "authorization: Bearer <host-token>"
curl -X POST http://localhost:8787/v1/rooms/<room>/egress/<egressId>/stop -H "authorization: Bearer <host-token>"
curl -s http://localhost:8787/v1/admin/egress/status -H 'x-api-key: dev-key'
# → {"configured":true,"enabled":true,"urlConfigured":true,"startNodeAvailable":true,"activeCount":1,"lastError":null}
```

Gating: `recording` — `features.recording=true` **и** (`mediaProcessing.egress`
или `scale.streaming.enabled`); `rtmp`/`hls` — `features.liveStreaming=true` и
`scale.streaming.enabled`, иначе `403 feature_disabled`. Если организация
привязала Egress к ноде через `mediaProcessing.egressNodeId`, поле
`startNodeAvailable=false` в административном статусе показывает, что нода
пока не принимает новые задания. Активные задания можно просматривать и
останавливать через настроенный контроллер. При активном E2EE
(`security.e2ee` + sfu/broadcast) — `409 e2ee_incompatible` (SFU не расшифрует
медиа). Список заданий содержит `startRestrictions` для `recording`, `rtmp`
и `hls`. Значение `null` означает, что политика комнаты разрешает запуск
этого вида задания. Core отдельно проверяет полномочия и готовность Egress.
`rtmpUrl` — только `rtmp://`/`rtmps://`, внешний хост разрешён; в
логах/аудите/ответах URL редактируется до `rtmp://host/…` (stream key не
утекает). Twirp: `POST /twirp/livekit.Egress/StartRoomCompositeEgress` с
`{room_name,layout,audio_only,file_outputs|stream_outputs|segment_outputs}`;
JWT HS256 с `video:{room,roomRecord:true}`, короткий TTL; List/Stop —
`ListEgress`/`StopEgress`, фильтр по room. Аудит: `admin.action` kind
`egress.started/stopped/failed` (без URL stream key). Ошибки Twirp → `502
egress_failed`; статус — без URL и секретов.

Передавайте новый `Idempotency-Key` для каждого отдельного запуска, например
UUID. Если HTTP-запрос приходится повторить, используйте тот же ключ и те же
настройки. Повтор вернёт исходный `egressId` после подтверждённого запуска.
Core проверяет права на каждом запросе. Ключ действует в пределах организации и
комнаты. Изменение настроек при том же ключе даёт `409 idempotency_conflict`.
Если LiveKit мог принять запрос, а Core не получил подтверждение, повтор даёт
`409 egress_start_outcome_unknown`. Проверьте список Egress комнаты перед новым
запуском. Состояние сохраняется в `<AGIL_DATA_DIR>/egress-starts` или в общем
Redis в кластере. Старые клиенты могут вызывать endpoint без этого заголовка.

## 35. Биллинг и квоты (P2 baseline)

Метринг usage + admin-тариф; **оплат/card data нет** (см. `agil/core/docs/billing.md`).
Default: `plan=free`, `enabled=false` (enforcement выключен), `overagePolicy=warn`.
Метринг пишется всегда в `<AGIL_DATA_DIR>/billing/<tenantId>/<YYYY-MM>.json` (UTC).

`TenantConfig.billing`: `enabled`, `plan` (`free|team|business|enterprise`),
`includedMinutes`, `maxParticipants`, `maxRooms`, `overagePolicy`
(`allow|warn|block`). Каталог: free 0/12/5, team 3000/25/50,
business 15000/100/500, enterprise 100000/500/5000.

Считаются: минуты комнат (от первого WS-join до последнего leave/закрытия),
`roomsCreated`, `participantJoins`, `peakParticipants`, `recordings` +
`recordingMinutes` (upload `POST /v1/recordings`). Live-минуты занятых комнат
входят в `totalMinutes` без ожидания закрытия.

```bash
# usage текущего месяца (+ live и quota) и конкретного месяца
curl -s http://localhost:8787/v1/admin/billing/usage -H 'x-api-key: dev-key' | jq
curl -s 'http://localhost:8787/v1/admin/billing/usage?month=2026-10' -H 'x-api-key: dev-key' | jq
# тариф + каталог
curl -s http://localhost:8787/v1/admin/billing/plan -H 'x-api-key: dev-key' | jq
# смена тарифа (strict body; неизвестные поля/card data → 400)
curl -X PATCH http://localhost:8787/v1/admin/billing/plan \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"plan":"team","enabled":true,"includedMinutes":5000,"overagePolicy":"block"}'
```

Enforcement: `POST /v1/rooms`/`POST /v1/admin/rooms` → **402 `quota_exceeded`**
(минуты/комнаты); `POST /v1/rooms/:id/join` → **429 `quota_exceeded`**;
WebSocket → error `quota_exceeded` + close 1008. При `overagePolicy=warn`
ответ содержит `billingWarning` и заголовок `x-agil-billing-warning`.
Reconnect существующего участника квоту не расходует. Успешный PATCH
аудируется как `admin.action` kind `billing.updated` (plan/previousPlan/лимиты,
без секретов). MCP: read-only `billing_usage`, `billing_status`.

Ограничения: single-node/in-process (нет ledger/агрегатора), аварийный рестарт
теряет незавершённые live-минуты, звонок на границе месяца относится к месяцу
завершения, egress-записи не считаются, breakout-комнаты считаются отдельно,
dashboard-UI позже.

## 36. Whiteboard и аннотации на демонстрации экрана (P2, опционально)

Флаги `features.whiteboard` и `features.annotations` (по умолчанию `false`).
REST-эндпоинтов нет: доска и пометки живут на WebSocket-сигналинге и в памяти
комнаты (без персистентности). Полный контракт, лимиты и права —
[agil/core/docs/whiteboard.md](whiteboard.md).

```text
# открыть доску (любой участник с правом whiteboard)
{ "type": "whiteboard.open" }

# штрих: нормализованные координаты 0..1, ширина — доля высоты поверхности
{ "type": "whiteboard.stroke", "id": "wb-1", "tool": "pen",
  "color": "#3b82f6", "width": 0.012,
  "points": [{"x":0.12,"y":0.30},{"x":0.28,"y":0.22}] }

# стереть свой последний штрих / очистить доску (clear — только host/moderator)
{ "type": "whiteboard.stroke", "tool": "undo" }
{ "type": "whiteboard.stroke", "tool": "clear" }

# закрыть и заблокировать доску (только host/moderator), с аудитом
{ "type": "whiteboard.close", "reason": "moving on" }

# пометка поверх текущего показа экрана
{ "type": "annotation.stroke", "tool": "pen", "color": "#f59e0b",
  "points": [{"x":0.1,"y":0.2},{"x":0.4,"y":0.3}] }
{ "type": "annotation.clear" }
```

Сервер отвечает `whiteboard.sync {snapshot}` (также приходит в `welcome` —
replay on join), `whiteboard.stroke/close/open`, `annotation.sync/stroke/clear`.
Снапшот доски: `{roomId, open, locked, strokes[], revision, updatedAt, ts}`;
снапшот пометок: `{roomId, presenterId, strokes[], revision, updatedAt, ts}`.

Права: рисовать могут все участники с флагом; `clear`/`close` — только
host/moderator; `undo` удаляет последний штрих вызывающего; гость не может
открыть доску, закрытую организатором; `annotation.clear` — ведущий показа или
host/moderator. Ошибки: выключенный флаг/нет права/закрытая доска →
`error{code:"unauthorized"}`; невалидный штрих/лимит/нет активного показа →
`error{code:"bad_request"}`.

Лимиты: 200 штрихов и 20 000 точек на доску, 1000 точек и 32 КБ на штрих;
100 штрихов и 8 000 точек на слой пометок (24 КБ на штрих). При вытеснении
приходит `whiteboard.sync` с `reason:"trim"`. Пометки сбрасываются при смене
ведущего или завершении показа (`annotation.clear` с `share_ended` /
`presenter_changed`). Аудит: `whiteboard.opened`, `whiteboard.cleared`,
`whiteboard.closed`, `annotation.cleared`; сами штрихи не аудируются.

## 37. SIP/PSTN: телефонный дозвон (опционально, по умолчанию выключено)

Шлюз — **LiveKit SIP**; сервер остаётся control-plane и не трогает медиа.
SIP-участник создаётся в комнате LiveKit, аудио PSTN ↔ SFU бриджует SIP-сервис.
По умолчанию выключено: `AGIL_SIP_ENABLED=0`, `features.sipDialIn=false`,
`scale.sip.enabled=false`. Полное руководство — [agil/core/docs/sip.md](sip.md).

Env (секреты только здесь, в конфиг/ответы/логи не попадают):

| Переменная | Default | Назначение |
|---|---|---|
| `AGIL_SIP_URL` | — | Twirp base URL LiveKit (`http(s)://…`; не `ws://`); приоритетнее `scale.sip.httpUrl` |
| `AGIL_SIP_API_KEY` / `AGIL_SIP_API_SECRET` | ключи SFU | LiveKit API key/secret для SIP Twirp |
| `AGIL_SIP_ENABLED` | `0` | включить шлюз; всё равно нужны `features.sipDialIn` и `scale.sip.enabled` |

`scale.sip` (deep-partial, значения по умолчанию):

```json
{ "enabled": false, "provider": "livekit-sip", "wsUrl": "", "httpUrl": "",
  "trunkId": "", "dialInNumbers": [], "callerId": "", "maxConcurrent": 10,
  "maxCallDurationSec": 3600, "region": "" }
```

`dialInNumbers[]` — опубликованные E.164-номера (DID) для входящих; `callerId` —
исходящий From (пусто = номер транка); `trunkId` — `ST_…` LiveKit SIP trunk.
`AGIL_SIP_URL` имеет приоритет, `scale.sip.httpUrl` — fallback при пустом env;
оба варианта, tenant PATCH/PUT и per-room `configOverrides.scale.sip` (при
создании комнаты, включая анонимное) проходят SSRF/TLS-политику. Полный
`PUT /v1/tenants/:id/config` без `scale.sip` принимается: объект заполняется
дефолтами, legacy-настройки тенанта сохраняются.

```bash
# статус (admin): без URL/ключей; numbers — DID из конфига тенанта (не набранные
# номера), active — best-effort
curl -s http://localhost:8787/v1/admin/sip/status -H 'x-api-key: dev-key'
# → {"configured":true,"enabled":true,"trunkConfigured":true,
#    "numbers":["+74951234567"],"active":1}

# включить фичу и SIP в конфиге тенанта (deep-partial: можно только enabled/trunkId)
curl -X PATCH http://localhost:8787/v1/tenants/demo/config -H 'x-api-key: dev-key' \
  -H 'content-type: application/json' -d '{"features":{"sipDialIn":true},
  "scale":{"sip":{"enabled":true,"trunkId":"ST_…","httpUrl":"https://livekit.example",
  "dialInNumbers":["+74951234567"],"callerId":"+74950000000","maxConcurrent":10}}}'

# начать исходящий звонок в комнату (host/moderator join-токен или admin key)
curl -X POST http://localhost:8787/v1/rooms/<room>/sip/dial-in \
  -H "authorization: Bearer <host-token>" -H 'content-type: application/json' \
  -d '{"number":"+79991234567","name":"Анна"}'
# опционально — DTMF после ответа (IVR-расширение): цифры, *, #, w=пауза 0.5 с,
# максимум 32 символа; не пишутся в ответ/аудит/логи
curl -X POST http://localhost:8787/v1/rooms/<room>/sip/dial-in \
  -H "authorization: Bearer <host-token>" -H 'content-type: application/json' \
  -d '{"number":"+79991234567","dtmf":"w123#"}'
# → {"id":"sip_<hex>","identity":"sip_<hex>","name":"Анна","role":"guest",
#    "roomId":"<room>","source":"sip","status":"dialing"}

# активные SIP-участники комнаты / положить трубку
curl -s http://localhost:8787/v1/rooms/<room>/sip -H "authorization: Bearer <host-token>"
curl -X POST http://localhost:8787/v1/rooms/<room>/sip/<participantId>/stop \
  -H "authorization: Bearer <host-token>"
# → {"stopped":true,"participantId":"sip_<hex>"}

# тест шлюза: mock (по умолчанию) — только конфиг, live — реальный RoomService.ListRooms
curl -X POST http://localhost:8787/v1/admin/sip/test -H 'x-api-key: dev-key' \
  -H 'content-type: application/json' -d '{"mode":"mock","number":"+74951234567"}'
curl -X POST http://localhost:8787/v1/admin/sip/test -H 'x-api-key: dev-key' \
  -H 'content-type: application/json' -d '{"mode":"live"}'
# → {"ok":true,"mode":"live","configured":true,"trunkConfigured":true,
#    "detail":"LiveKit Twirp reachable (RoomService.ListRooms)","latencyMs":18}
```

Порядок проверок `dial-in`: auth (401/403; host/moderator/admin) → шлюз
(501 `sip_disabled` / `sip_not_configured` / `sip_trunk_not_configured`) →
E2EE (409 `e2ee_incompatible`) → `features.sipDialIn` + `scale.sip.enabled`
(403 `feature_disabled`) → E.164 (400 `validation_failed`) → rate limit
(10/мин на tenant+room+IP, 429 `rate_limited`) → `maxConcurrent`
(409 `sip_limit_reached`). `stop`/list не требуют feature-флага (cleanup) и
работают при `AGIL_SIP_ENABLED=0`/пустом trunk: им нужны только URL и ключи
шлюза (иначе 501 `sip_not_configured`). Дополнительно list — 30/мин, stop —
10/мин (429). Phone-like `participantId` в stop расходует stop-лимитер **до**
аудита: первые 10 попыток отклоняются 400 с маскированным аудитом, 11-я и далее —
429 без новых audit-записей; phone-like сегмент пути маскируется в request-логах.

Twirp (JSON, Bearer JWT HS256, `exp = now + 120 c`, `nbf = now − 5 c`):
`POST /twirp/livekit.SIP/CreateSIPParticipant` с
`{sip_trunk_id,sip_call_to,room_name,participant_identity,participant_name,
participant_metadata,hide_phone_number,sip_number?,dtmf?,ringing_timeout,max_call_duration}`
и грантами `video:{room,roomJoin}` + `sip:{call}`; ответ
`SIPParticipantInfo` — identity берётся из `participant_identity` (не из
`participant_id`), поэтому `id/identity` ответа совпадает с list/stop.
`POST /twirp/livekit.RoomService/ListParticipants` и
`RemoveParticipant` — `video:{room,roomAdmin}`; live-тест —
`RoomService/ListRooms` с `video:{roomList}`. SIP-участник — **guest**
(`participant_metadata` `{source:"sip",role:"guest",tenantId,roomId}`), тот же
tenant/room scope, что и обычный гость; host/moderator-прав у телефона нет.

Приватность: номер не пишется в комнату/ответы/аудит; `hide_phone_number:true`
не даёт LiveKit подставить номер в identity/attributes; в аудите только
`numberMasked` (`+7••••••••67`) для старта; `dtmf`-цифры не возвращаются,
не аудируются и не логируются. Если LiveKit синтезировал identity/name из
номера, номер маскируется в обоих полях (`+7••••••••67` / `Phone +7••••••••67`),
а `id` = participant id LiveKit
(`PA_…`): по нему stop резолвит identity на сервере, поэтому номер не попадает
в URL/аудит; phone-like `participantId` по-прежнему `400 validation_failed`.
Ошибки Twirp очищаются от телефонов, URL, bearer/
токенов и email (не только цифр), JWT/URL/ключи не логируются. Аудит:
`sip.dialin.started` / `sip.dialin.stopped` / `sip.dialin.failed`
(identity, action `start`/`stop`, masked number, error; без имени и номера).
Ошибки шлюза → 502 `sip_failed`. `active` в статусе считается по комнатам
тенанта (не более 50) и не является биллинговым счётчиком.

Ограничения baseline: транки/DID/dispatch rules и PSTN-оператор разворачиваются
отдельно (API для их CRUD нет), входящая маршрутизация DID→комната — только
через dispatch rules LiveKit (в приложении не реализована), нет transfer/DTMF-UI,
записи SIP-звонка, вебхуков статуса вызова и UI (следующий этап). Подробно —
[agil/core/docs/sip.md](sip.md).
