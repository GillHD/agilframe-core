# `@agil/calls-server` — HTTP + WebSocket сервер AgilFrame

Сервер встраиваемой WebRTC-платформы видеозвонков: REST control plane, admin API,
WebSocket-сигналинг (mesh), чат, файлы, записи, STT, комплаенс/AI-агент,
knowledge-агент, исходящие вебхуки, статика демо/редактора/дашборда/SDK/виджета,
OpenAPI 3.1 и офлайн API-explorer.

Ноль UI-зависимостей на сервере: `node:http` + `ws` + `zod` + `@agil/protocol` +
`@agil/security` + `@agil/ai`.

## Быстрый старт

```bash
# из корня монорепо (сначала соберите зависимости)
npm run build -w @agil/protocol && npm run build -w @agil/security && npm run build -w @agil/ai
npm run build -w @agil/calls-server

npm start -w @agil/calls-server     # node dist/index.js, порт 8787
npm run dev -w @agil/calls-server   # tsx watch src/index.ts

# или весь стек (server:8787 + demo:5173 + editor:5174 + dashboard:5175)
npm run dev
```

Проверка:

```bash
curl -s http://localhost:8787/v1/health | jq
curl -s http://localhost:8787/openapi.json | jq '.info'
open http://localhost:8787/docs          # офлайн-эксплорер (без CDN)
open http://localhost:8787/              # demo (после npm run build демо)
```

Команды пакета:

| Команда | Что делает |
|---|---|
| `npm run build -w @agil/calls-server` | `tsc -p tsconfig.json` → `dist/` |
| `npm run typecheck -w @agil/calls-server` | проверка типов без эмита |
| `npm run test -w @agil/calls-server` | `tsx --test test/*.test.ts` (59 тестов) |
| `npm run openapi -w @agil/calls-server` | выгружает `agil/core/docs/openapi.json` |
| `npm run dev -w @agil/calls-server` | запуск с watch |

## Переменные окружения

Все значения имеют dev-дефолты; секретов в клиент никогда не отдаём.

| Переменная | Default | Смысл |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | HTTP+WS порт и адрес |
| `AGIL_TOKEN_SECRET` | `dev-secret-agil-calls` | HS256 секрет join-токенов и HMAC подписанных URL |
| `AGIL_API_KEYS` | `dev-key:demo` | `key:tenant[,key:tenant]` — admin-ключи |
| `AGIL_ALLOW_ANONYMOUS` | `1` | анонимные `POST /v1/rooms` и WS (demo) |
| `AGIL_DEFAULT_TENANT` | `demo` | тенант по умолчанию |
| `AGIL_DATA_DIR` | `.data` | данные: `tenants/`, `audit/`, `files/`, `recordings/` |
| `AGIL_STATIC_DIR` | `agil/websdk/demo/dist` | demo SPA (`/`) |
| `AGIL_EDITOR_DIR` | `agil/core/apps/editor/dist` | редактор (`/editor/`) |
| `AGIL_DASHBOARD_DIR` | `agil/core/apps/dashboard/dist` | панель (`/dashboard/`) |
| `AGIL_SDK_DIR` | `agil/websdk/sdk/dist` | SDK (`/sdk/`) |
| `AGIL_WIDGET_DIR` | `agil/websdk/widget/dist` | виджет (`/widget/`) |
| `AGIL_DOCS_DIR` | `docs` | репозиторная документация, read-only `/docs/<file>` |
| `AGIL_DOCS_DATA_DIR` | `AGIL_DATA_DIR/docs` | Публикации CMS, история и выбор основного документа. В HA укажите путь к одному общему хранилищу, смонтированному на всех Core |
| `AGIL_PUBLIC_ORIGIN` | `http://localhost:8787` | база для `joinUrl`/`embedUrl`/подписанных ссылок (fallback для кастомных доменов) |
| `AGIL_DOMAIN_TARGET` | host из `AGIL_PUBLIC_ORIGIN` | цель CNAME для `/v1/admin/domain` и DNS-верификации кастомных доменов |
| `AGIL_DOMAIN_DNS_TIMEOUT_MS` | `5000` | таймаут одного DNS-запроса при verify (250..30000) |
| `AGIL_ICE_SERVERS` | STUN Google | JSON-массив `{urls,username?,credential?}`; для UDP TURN автоматически добавляется `?transport=tcp` |
| `AGIL_ICE_TCP_FALLBACK` | `1` | TCP-fallback для UDP TURN-URL (сети, блокирующие UDP); `0` — выключить |
| `AGIL_ROOM_TTL_SEC` | `0` | закрытие пустой комнаты через N секунд (0 = выкл) |
| `AGIL_TOKEN_TTL_SEC` | `14400` | TTL join-токена |
| `AGIL_TRUST_PROXY` | `0` | доверять `x-forwarded-for` и geo-заголовкам; включает «production-secure» режим URL-политики |
| `AGIL_GEO_PROVIDER` | `header` | `header` \| `ipapi` \| `none` |
| `AGIL_IP_SALT` | dev-соль | соль для `hashIp` (в аудит попадает только хэш) |
| `AGIL_FILE_TTL_SEC` | `86400` | TTL подписанных ссылок |
| `AGIL_MAX_UPLOAD_MB` | `25` | жёсткий потолок загрузки файлов |
| `AGIL_MAX_RECORDING_MB` | `200` | потолок записи |
| `AGIL_RECORDINGS_DIR` | `<data>/recordings` | каталог записей |
| `AGIL_STT_URL` / `AGIL_STT_KEY` / `AGIL_STT_MODEL` | — / — / `whisper-1` | OpenAI-совместимый серверный STT (пусто = 501) |
| `AGIL_INTEGRITY_URL` / `AGIL_INTEGRITY_KEY` | — | внешний детектор deepfake (MVP: конфиг валидируется, сетевой вызов не реализован — см. ограничения) |
| `AGIL_AI_AGENT_HMAC_SECRET` | — | HMAC-подпись запросов к AI/knowledge/in-call агентам компании |
| `AGIL_INCALL_POLICY_PATH` | — | Путь к подписанной политике внешнего ассистента звонка для заданной организации |
| `AGIL_INCALL_POLICY_PUBLIC_KEY` | — | Открытый Ed25519-ключ в формате PEM для проверки файла политики. Задаётся вместе с `AGIL_INCALL_POLICY_PATH` |
| `AGIL_WEBHOOK_TIMEOUT_MS` / `AGIL_WEBHOOK_RETRIES` | `5000` / `2` | дефолты исходящих вебхуков |
| `AGIL_ADMIN_RATE_LIMIT_PER_MIN` | `120` | лимит admin API |
| `AGIL_JOIN_RATE_LIMIT_PER_MIN` | `300` | join-попыток в минуту на (IP, комнату) — 200 мест + запас для офисного NAT; брутфорс пароля отдельно ограничен lockout |
| `AGIL_LOBBY_TTL_SEC` | `600` | TTL заявки в лобби (waiting room) |
| `AGIL_LOBBY_MAX` | `50` | максимум заявок в очереди комнаты |
| `AGIL_SFU_URL` / `AGIL_SFU_API_KEY` / `AGIL_SFU_API_SECRET` | — | SFU (LiveKit-compatible) media plane: JWT-сессии в `join.media`/`welcome.media` |
| `AGIL_SFU_ENABLED` | auto | `0` — принудительно отключить SFU-сессии (mesh fallback); по умолчанию включено, если есть URL+ключи |
| `AGIL_SFU_PROFILE` | unset = `standard` | Профиль ёмкости: `low` (2 видео/клиента, 1–2 vCPU/2 GB, **25 участников**), `standard` (6, 8–16 vCPU/16 GB, **50**), `high` (12, 16–32 vCPU/32 GB, **200**). Важнее `scale.sfu.capacityProfile`; эффективный лимит комнаты = `min(room.maxParticipants, scale.maxParticipants, profile.participants, sfu.maxParticipants)`. Текущий пилот 1 vCPU/2 GB должен задать `low` явно — иначе комната с 200 местами будет ограничена 25/50 и join вернёт `409 room_full` |
| `AGIL_E2EE_SECRET` | — | секрет для ключей E2EE комнат (HMAC-SHA256); без него dev-fallback на join-секрет с предупреждением |
| `AGIL_SCIM_TOKEN` | — | SCIM 2.0 bearer token (`/scim/v2`, tenant из `x-tenant-id`); пусто = 501 |
| `AGIL_EGRESS_URL` | — | LiveKit Egress Twirp base URL (воркер отдельно; например `http://127.0.0.1:7880`) |
| `AGIL_EGRESS_API_KEY` / `AGIL_EGRESS_API_SECRET` | SFU-ключи | ключи Egress (по умолчанию `AGIL_SFU_*`) |
| `AGIL_EGRESS_ENABLED` | `1` | `0` — отключить egress (`501 egress_disabled`) |
| `AGIL_DOCS_ENABLED` | `1` в dev (production: `0`) | `/docs`, `/docs/:file`, `/openapi*.json` |
| `AGIL_DOCS_ALLOW_IPS` | пусто = все | CIDR-allowlist agil/core/docs/OpenAPI |
| `AGIL_DOCS_PORT` / `AGIL_DOCS_HOST` | основной порт | отдельный agil/core/docs/OpenAPI-порт |
| `AGIL_DOCS_RATE_LIMIT_PER_MIN` | `120` | rate-limit docs на IP |
| `AGIL_ADMIN_API_ENABLED` | `1` | `0` → `/v1/admin/*` = 404 |
| `AGIL_ADMIN_ALLOW_IPS` | пусто = все | allowlist admin API (403) |
| `AGIL_ENROLL_ALLOW_IPS` | пусто = все | отдельный allowlist enrollment (`/v1/cluster/join`, `/v1/nodes/register`, `/v1/nodes/:id/heartbeat`); не зависит от admin-флагов |
| `AGIL_HEARTBEAT_RATE_LIMIT_PER_MIN` | `10` | heartbeat на узел в минуту (per-node bucket после успешной аутентификации, ключ = tenant id + node id; enrollment-лимит отдельный, 120/мин на IP) |
| `AGIL_HEARTBEAT_IP_RATE_LIMIT_PER_MIN` | `600` | внешний heartbeat-bucket на IP: все попытки до проверки ключа (поддельные/отсутствующие ключи включены); 61 узел за NAT ≈122/мин проходит |
| `AGIL_NODE_KEY_TTL_SEC` | `0` | TTL per-node ключа по умолчанию (0 = бессрочно) |
| `AGIL_CLUSTER_ROLE` | `leader` | `standby` = read-only реестр; любые записи (токены, join/register/heartbeat, PATCH/disable/drain/delete/rotate узлов) → `409 not_leader` |
| `AGIL_MCP_HTTP_ENABLED` / `_PORT` / `_TOKEN` / `_ALLOW_IPS` | off | флаги HTTP-MCP (обслуживает `@agil/mcp`; в `/v1/health`) |
| `AGIL_MCP_MODE` | `full` | `read` — только read-only MCP-инструменты |
| `AGIL_QUIET` | `0` | отключить логи |

Ключи AI/knowledge агентов в БД **не хранятся**: в конфиге только имя env-переменной
(`session.aiAgent.apiKeyEnv`, `session.knowledgeAgent.apiKeyEnv`), причём только из
серверного namespace (`AGIL_INTEGRATION_*`; аналогично `AGIL_WEBHOOK_*` /
`AGIL_SIEM_*` / `AGIL_SFU_*` / `AGIL_TURN_*`). Значения берутся из снапшота env на
старте; `process.env` по имени из конфига не читается (см. `docs/security.md` §2.11).

## Реализованные эндпоинты

Полная спека — `GET /openapi.json` (+ `npm run openapi` → `agil/core/docs/openapi.json`),
человекочитаемая документация — `agil/core/docs/api.md`. Кратко:

**Публичные**: `GET /v1/health`, `GET /v1/ice`, `GET|PUT|PATCH /v1/tenants/:id/config`,
`GET /v1/tenants/:id/backgrounds`, `POST /v1/rooms` (+ `mode`/`context` для
мессенджеров), `POST /v1/tokens`, `POST /v1/rooms/:id/join`,
`POST /v1/rooms/:id/chat` (Bearer, внешний чат), `POST /v1/rooms/:id/assistant`
(in-call AI-ассистент с правами участника), `GET|DELETE /v1/rooms/:id`,
`GET /v1/rooms/:id/messages`, `POST /v1/files`, `GET /v1/files/:id?sig=&exp=`,
`POST /v1/recordings`, `GET /v1/recordings/:id?sig=&exp=`, `POST /v1/stt/transcribe`,
`GET /openapi.json` (только публичные пути), `GET /openapi.admin.json` (полная
спека, внутренний доступ), `GET /docs`, `GET /docs/:file`.

**Admin (`x-api-key`)**: `overview`, `rooms` CRUD, `rooms/:id` (participants+chat+links),
`invites`, `lock`, `kick`, `rooms/:id/chat` (бот/CRM), `transcript`,
`analysis` (+`/run`), `locations` (GPS-координаты только тут), `audit`
(limit/offset/type/severity/roomId → `entries,total,offset,limit`), `security`,
`recordings` (+delete), `files`, `ai-agent` GET/PUT, `knowledge-agent` GET/PUT,
`knowledge/ask`, `in-call-agent` GET/PUT, `access-policy` GET/PUT, `roles`
GET/POST, `roles/:id` PUT/DELETE (встроенные host/moderator/guest + кастомные,
до 30; токены с `roleId`), `providers` GET/PUT + `providers/test`, `webhooks`
GET/PUT + `webhooks/test`, `scale` GET/PUT, `cluster/status`, `scale/turn/test`.

**Масштабирование (agil/core/docs/scaling.md, agil/core/docs/api.md §18)**: `TenantConfig.scale`
(mediaMode mesh/sfu/broadcast, maxParticipants до 50 000, реестр узлов, SFU,
TURN-пул, webinar, streaming, CDN) принимается и валидируется; `welcome.iceServers`
= STUN + TURN-пул с credential из env (практический эффект), комнаты получают
`mediaMode`/`maxParticipants` из scale. Реальная оркестрация кластера/SFU/RTMP —
не реализована (статус `limitations[]`, `multiNodeActive:false`).

**Биллинг/квоты (agil/core/docs/billing.md, agil/core/docs/api.md §35)**: `TenantConfig.billing`
(plan/enabled/includedMinutes/maxParticipants/maxRooms/overagePolicy), метринг
комнат/участников/записей в `AGIL_DATA_DIR/billing/<tenantId>/<YYYY-MM>.json`,
`GET /v1/admin/billing/usage|plan`, `PATCH /v1/admin/billing/plan` (аудит
`billing.updated`); 402 при create, 429/WS `quota_exceeded` при join. Default —
free/off + soft warning; оплат и card data нет.

**Провайдеры (§23)**: слоты `chat/files/stt/notifications/recording/backgrounds`
— builtin по умолчанию, `external` через подписанный JSON-конверт
(`{capability,action,requestId,tenantId,roomId?,payload}` + `x-agil-signature`),
`fallback:'builtin'|'fail'`, `disabled`; `recording` в MVP — только builtin
(`provider_unsupported`).

**WebSocket `/ws`**: `welcome`, `peer-joined/left`, `sdp`, `ice`, `chat`,
`chat-history`, `state`, `reaction`, `caption`, `integrity`, `location`, `room`,
`config`, `analysis`, `assistant-answer`, `error`, `pong`, `bye`.
Лимит 40 сообщений/с на сокет (3 нарушения → close 1008), heartbeat 30 с,
maxPayload 1 МиБ.

## Безопасность

- Пароли комнат: только `scrypt`-хэш (`@agil/security`), в API/конфиг не попадают;
  брутфорс ограничен `maxFailedJoinAttempts`/`lockoutSec` + rate-limit 10 join/мин.
- Гео-политика: `allowedCountries`/`blockedCountries`/`blockVpn`; страна из
  доверенных заголовков только при `AGIL_TRUST_PROXY=1`, иначе `ipapi`/`none`.
- Аудит: JSONL `<data>/audit/<tenant>.jsonl`, IP только `hashIp(ip, salt)`;
  админ видит только свой тенант.
- Файлы/записи: HMAC-подписанные ссылки с TTL, MIME-фильтр (html/svg/js запрещены),
  лимиты размера, защита от path traversal.
- SSRF-политика внешних URL (вебхуки, AI/knowledge endpoints): только http(s);
  в «secure» режиме (`NODE_ENV=production` или `AGIL_TRUST_PROXY=1`) только https и
  публичные хосты; RFC1918/link-local/metadata-адреса блокируются и в dev
  (loopback разрешён для локальных тестовых приёмников). DNS-rebinding не покрыт —
  нужен egress-proxy.
- Заголовки: `x-content-type-options`, `referrer-policy`, `x-frame-options`,
  `permissions-policy`, `cross-origin-opener-policy`, HSTS при trustProxy;
  для `embed.html` — CSP `frame-ancestors` из `integrations.allowedOrigins`.
- Приватность: GPS-координаты (при `security.geo.gpsEnabled` + consent) не
  бродкастятся — только грубая локация участникам, точные координаты — в admin API
  (`/v1/admin/rooms/:id/locations`).
- `agil/core/scripts/security-audit.mjs` (в корне): 31/31 проверок на собранном сервере.

## Тесты

`test/*.test.ts` (node:test + tsx): health/config, токены/join (пароль, lock, geo,
брутфорс), WS (два клиента, SDP/ICE, чат, состояние, ping, peer-left), admin
(overview, rooms, invites, kick, transcript, analysis, audit/security), файлы/записи/STT,
статика + `/docs` + `/openapi.json`, интеграции (подписанные вебхуки, knowledge-агент,
assistant-query, access policy), внешний чат (§22).

Каждый файл поднимает сервер на порту `0` с временным `dataDir` и закрывает его в
`after()` — процессы/файлы не остаются.

## Ограничения (честно)

- **Комнаты и чат — in-memory.** Перезапуск сервера теряет комнаты/сообщения
  (персистятся только конфиги тенантов, файлы, записи и аудит). Поэтому
  горизонтальное масштабирование требует общего состояния — см. roadmap.
- **Mesh, не SFU.** Медиа идёт peer-to-peer; комнаты рассчитаны на ~12 участников
  (`limits.maxParticipants`). Для больших звонков нужен SFU за тем же сигналингом.
- **Медиа-путь не проходит через сервер.** Сервер — relay SDP/ICE, поэтому в
  проде обязателен TURN (STUN недостаточно для NAT/CGNAT; сейчас `AGIL_ICE_SERVERS`
  отдаёт только STUN по умолчанию).
- **AI/knowledge — прокси.** Сервер не хранит содержимое wiki и не содержит
  бизнес-логику компании; ответы внешних агентов — недоверенный вход (zod).
- **Anti-deepfake — эвристики.** Локальный score вероятностный; юридически
  значимая проверка — только внешняя модель + liveness + C2PA-метки записей.
  Внешний detector URL валидируется, но сетевой вызов в MVP не подключён.
- **OIDC/JWKS** проверяется для SSO-joins (`identityToken`, RS256/ES256), SCIM 2.0
  каталог поддерживает Users/Groups; полного redirect-flow и SCIM bulk/sort нет.
- **SIEM-экспорт** аудита (`integrations.siem`, JSON/CEF, HMAC, retries) —
  fail-open; egress-воркеров и гарантированной доставки нет.
- **Waiting room** — простая политика «гость ждёт, пока в комнате есть
  host/moderator»; полноценного approve-flow нет.
- **Access policy** применяется к join/WS (chat, assistant, files-гейт через
  `session`), но `features.fileShare/recording` в MVP остаются advisory-флагами —
  серверный гейт для них `session.fileShare.enabled`/`session.recording.*`.
- **Провайдеры** вызываются синхронно в рамках запроса (таймауты слота), без
  очередей/circuit breaker; `recording` external в MVP не поддерживается
  (`501 provider_unsupported`) — используйте files-провайдер (S3) для архива
  записей; provider-specific SDK (S3/Deepgram) не подключаются как зависимости.
- **In-call ассистент** в `mode:'local'` выполняется в виджете (сервер отвечает
  `501 assistant_local_only`); сервер проксирует только external/hybrid и всегда
  фильтрует действия по эффективным правам участника.
- **Публикация agil/core/docs/OpenAPI/admin** управляется env (`AGIL_DOCS_*`,
  `AGIL_ADMIN_*`): в production docs по умолчанию выключены; `/openapi.json` —
  только публичная спека, полная — `/openapi.admin.json` (внутренний доступ);
  см. `agil/core/docs/api-exposure.md`.

## Roadmap масштабирования

1. **Redis/ValKey pub/sub**: комнаты, presence, чат, permission-кэш, config-broadcast,
   rate-limit (общий счётчик) → несколько инстансов сервера за LB с sticky WS.
2. **SFU** (mediasoup/LiveKit-совместимый): сервер выдаёт transport-параметры и
   роутит треки; сигналинг-конверт §5 сохраняется, меняется только media plane.
3. **TURN** (coturn) и `iceServers` с credentials, ротация; geo-DNS для медиа.
4. **Персист**: PostgreSQL для комнат/сообщений/транскриптов, S3 для файлов/записей,
   ClickHouse для аудита; retention по `aiAgent.retentionMin`.
5. **Очереди**: analysis/STT-задачи в BullMQ/Kafka, идемпотентные воркеры,
   backpressure; вебхуки через outbox-паттерн с DLQ.
6. **Multi-region**: шардирование комнат по региону, глобальный каталог, rate-limit
   per-region; SSO (OIDC+JWKS), SCIM-каталог.
7. **Наблюдаемость**: OpenTelemetry-трейсы (join→WS→chat→analysis), метрики
   Prometheus, redaction секретов.





### Дополнительные public/admin ручки

- Лобби: `GET /v1/rooms/:id/lobby`, `GET/POST /v1/rooms/:id/lobby/:requestId[/admit|/reject]`, `DELETE /v1/rooms/:id/lobby/:requestId`.
- Breakout rooms: `GET /v1/rooms/:id/breakouts`, `POST /v1/rooms/:id/breakouts/start|close|return`.
- Опросы/Q&A: `GET/POST /v1/rooms/:id/polls`, `POST /v1/rooms/:id/polls/:pollId/vote`, `POST /v1/rooms/:id/polls/:pollId/close`.
- Календарь: `GET /v1/rooms/:id/calendar.ics`.
- Кастомные домены: `GET/PUT/POST/DELETE /v1/admin/domain`, `POST /v1/admin/domain/verify`, публичные `GET /v1/host` и `GET /v1/domain/ask` (Host→tenant + DNS TXT/CNAME; см. `agil/core/docs/custom-domains.md`).
- Медиа-обработка: `GET /v1/admin/media/processing` (client-first по умолчанию; см. `agil/core/docs/media-processing.md`).
- SaaS организации: `GET/POST /v1/admin/tenants`, `GET/PATCH/DELETE /v1/admin/tenants/:id`, `POST /v1/admin/tenants/:id/keys` (platform key).
