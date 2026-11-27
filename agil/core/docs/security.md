# Безопасность AgilFrame

Документ описывает модель угроз, реализованные меры, честные ограничения MVP и
рекомендации по эксплуатации. Технические сигнатуры и примеры — в
`agil/core/packages/security/README.md`; границы ответственности с приложением компании —
в `agil/core/docs/integration-boundaries.md`.

## 1. Модель угроз

**Что защищаем**

| Актив | Риск |
|---|---|
| Медиа/аудио звонка | перехват, несанкционированная запись, дипфейк/подмена участника |
| Чат, файлы, записи, транскрипты | утечка, вредоносный контент, доступ по угаданной ссылке |
| Персональные данные (IP, имя, email, страна) | деанонимизация, нарушение GDPR/152-ФЗ |
| Пароли комнат | brute-force, утечка из хранилища/логов |
| API-ключи, join-токены, JWT-секрет | подделка токена, захват комнаты |
| Корпоративные интеграции (AI/knowledge-агент, вебхуки) | SSRF, подделка событий, утечка ключей |
| Конфиги тенантов и права | повышение привилегий, доступ к чужим функциям |
| Доступность | DoS на WebSocket/upload/join, переполнение памяти |

**Кто угрожает**

- внешний гость по ссылке: brute-force пароля комнаты, спам/флуд, обход
  гео-политики через VPN/заголовки, попытки SSRF через настраиваемые endpoint'ы;
- злоумышленник с украденной ссылкой/токеном: вход в активную комнату,
  повторное использование ссылки;
- недоверенный браузер участника: подмена клиентских эвристик, инъекции в чат/файлы;
- инсайдер/модератор: доступ к записям и аудиту, экспорт данных;
- вредоносный контент: HTML/SVG/JS в файлах, path traversal, огромные файлы;
- дипфейк/voice-clone: подмена личности участника;
- сеть/инфраструктура: MITM, перехват TURN-трафика, утечка секретов из репозитория;
- supply chain: скомпрометированный npm-пакет.

**Границы доверия**

- Браузер участника — недоверенный источник. Всё, что он присылает (имя, SDP,
  чат, файлы, `frameTimingRegularity`, `externalScore`), валидируется и
  ограничивается по размеру/схеме.
- HTTP-заголовки (`x-forwarded-for`, `x-agil-country`, `cf-ipcountry`)
  доверяются **только** при `AGIL_TRUST_PROXY=1` и только если сервер стоит за
  контролируемым reverse-proxy; иначе они игнорируются.
- Ответы внешних сервисов (ipapi, STT, AI-агент, knowledge-агент, детектор
  дипфейков) — недоверенный вход: таймауты, ограничение размера, валидация
  (zod/структурный парсинг), никакого исполнения.
- Секреты компании (AI-ключи и т.п.) хранятся только как **имя env-переменной**
  в конфиге тенанта; значения — в окружении/secret manager.

## 2. Реализованные меры (`@agil/security`)

### 2.1 Пароли комнат

- Хэш: scrypt `N=16384, r=8, p=1`, соль 16 байт, ключ 64 байта, формат
  `scrypt$N$r$p$<salt b64url>$<hash b64url>`.
- Проверка — `verifyPassword` через `crypto.timingSafeEqual`; битый/чужой/
  усечённый хэш → `false` без исключений. Параметры из строки валидируются с
  ограничениями (защита от DoS подделанным хэшем).
- Пароль нигде не хранится в открытом виде, не логируется и не возвращается API
  (только `passwordProtected: boolean`); в аудит попадает лишь `password.failed`.
- Lockout: `config.security.maxFailedJoinAttempts` за `lockoutSec`, событие
  `lockout` в аудите. Второй слой — rate-limit join (10/мин на IP+комнату).

### 2.2 Гео-политика и VPN

- `resolveGeo` **никогда не бросает**: таймаут (`AbortController`), сеть, 4xx/5xx,
  битый JSON → `{ source: 'none', vpn: false }`.
- `provider: 'header'` — страны из доверенных заголовков
  (`countryFromHeaders`), `provider: 'ipapi'` — внешний lookup с кэшем 10 мин,
  `provider: 'none'` — выключено.
- Код страны нормализуется и валидируется (ISO alpha-2, заглушки `XX/ZZ`
  отбрасываются). Пустой `allowedCountries` = разрешены все; неизвестная страна
  при непустом allow-list = отказ (`geo_blocked`, событие `geo.blocked`).
- `blockVpn`: флаг `vpn` из внешнего lookup (поля `security.vpn/proxy/tor`);
  при провайдере `header` VPN определить нельзя — не блокируем по VPN.
- GPS-локация (если включена в конфиге тенанта) — только по явному согласию
  участника (`gpsEnabled/requireConsent`); геолокация — чувствительные данные,
  хранить/логировать координаты в открытом виде нельзя.

### 2.3 Сессии и токены

- Join-токен — HS256 JWT с коротким TTL; секрет `AGIL_TOKEN_SECRET` только на
  сервере, в клиентский бандл не попадает; токен передаётся, но не хранится в
  логике.
- Блок `sessionBinding` сохранён для совместимости с прежними конфигурациями.
  Core не применяет его как ограничение входа. При отправке GPS с согласия
  участника журнал сохраняет исторический тип `session.bound` и уточнение
  `details.kind: "location.updated"`.
- `security.requireToken`, `waitingRoom`, `lockRoom`, `moderatorJoinFirst` —
  серверный enforcement; права на функции — `resolveAccess` (§18 контракта),
  клиент лишь скрывает недоступный UI.

### 2.4 Rate-limit

`createRateLimiter` — фиксированное окно с bounded memory (LRU-eviction):
join 300/мин на IP+комнату, files/STT 30/мин на тенант, admin 120/мин, пароль —
`maxFailedJoinAttempts` за `lockoutSec`. WS-лимит 40 сообщений/с на сокет,
3 нарушения → закрытие 1008. Это защита от случайного/простого флуда, а не от
распределённого L3/L4-DoS (см. §4).

### 2.5 Аудит и приватность

- JSONL per tenant, append-only, in-memory ring 2000 для admin API.
- Сырой IP в аудит **не** пишется: только `hashIp(ip, AGIL_IP_SALT)` (sha256,
  128 бит). Соль делает хэши несопоставимыми между инсталляциями.
- События `AuditEventType`: создание/закрытие комнаты, join allowed/denied,
  password.failed, geo.blocked, lockout, config.updated, recording.*, file.shared,
  file.scanned, file.quarantined, file.quarantine_failed, file.scan_unavailable,
  chat.sent, integrity.flagged, session.bound, admin.action.
- Ошибки аудита **не проглатываются**: если запись не удалась, операция не
  должна выглядеть успешной.

### 2.6 Файлы и записи

- Хранение: `<AGIL_DATA_DIR>/files|recordings/<id>` + `<id>.json` метаданные.
- Скачивание — только по подписанной ссылке
  `?sig=<HMAC-SHA256 base64url>&exp=<epoch ms>`; подпись покрывает
  `file:<id>:<exp>` / `recording:<id>:<exp>`, проверка constant-time.
- TTL ссылки (`AGIL_FILE_TTL_SEC`, default 86400), `id` — UUID и строгая
  валидация `[A-Za-z0-9_-]` (path traversal невозможен), размеры лимитируются
  (`AGIL_MAX_UPLOAD_MB`, лимит записей), MIME-allow-list и запрет активного
  контента (HTML/SVG/JS), имя файла санитизируется (`sanitizeFilename`).
- Отдача бинаря — с `Content-Disposition: attachment` (на стороне сервера) и
  `X-Content-Type-Options: nosniff`; не позволять браузеру рендерить загрузки на
  origin API.
- Антивирусная проверка загрузок — опционально (`security.avScan`, ClamAV через
  clamd / YARA CLI, выключено по умолчанию); карантин, аудит и ограничения —
  `docs/liveness-av.md`.

### 2.7 Медиа-интеграция (anti-deepfake): честно

- `MediaIntegrityService` — эвристический риск-скор 0..1 (тайминги кадров,
  liveness, наличие лица, внешний скор, гео-несовпадение) с порогом
  `mediaIntegrity.flagThreshold`; результат — `unknown|verified|suspicious` +
  флаги. Это не доказательство подделки.
- Браузерные эвристики вероятностные и обходятся современными дипфейками;
  `externalScore` приходит только от внешнего детектора
  (`AGIL_INTEGRITY_URL/AGIL_INTEGRITY_KEY`), который вызывает сервер.
- Юридически значимая детекция требует внешней модели + liveness-challenge +
  провенанс-меток (C2PA) и организационных процедур. В MVP этого нет — roadmap.
- `autoMuteOnHighRisk` — реакция на риск, а не наказание; решение принимает
  модератор, событие `integrity.flagged` идёт в аудит.
- Серверные liveness-челленджи (`security.liveness`, задачи blink/head-left/
  head-right) — отдельный, тоже advisory-механизм; эндпоинты, политика
  fail-open/fail-closed и честные ограничения: `docs/liveness-av.md`.

### 2.8 STT и корпоративный AI

- `SttService` — OpenAI-совместимый endpoint, `Authorization: Bearer` только если
  ключ задан; ключ не логируется и не попадает в URL/ошибки; таймаут
  `AbortController`.
- Не настроено → `isConfigured() === false`, эндпоинт 501 с подсказкой.
- AI/knowledge-агент: ключ только по имени env-переменной; запросы подписаны HMAC
  (`x-agil-signature`), ответы валидируются zod (недоверенный вход), таймауты и
  один ретрай на 5xx/сеть.
- Транскрипты/записи — персональные данные: срок хранения `retentionMin`,
  согласие участников (`recording.consentRequired`) и уведомление
  (`notifyParticipants`) — обязанность сервера/тенанта.

### 2.9 Сетевые вызовы компании (SSRF/подпись)

Сервер вызывает **настраиваемые тенантом** endpoint'ы: AI-агент, knowledge-агент,
webhooks, внешний детектор медиа (`AGIL_INTEGRITY_URL`) и STT. Это классический
вектор SSRF, если URL не проверять.

- `validateOutboundUrl(raw, { allowHttp?, allowPrivate? })` — синхронная проверка
  **перед каждым вызовом** и на старте для `AGIL_INTEGRITY_URL`:
  - только `https` (в проде; `allowHttp` — только для локальной разработки);
  - URL ≤ 500 символов, без `user:password@`;
  - блокируются `localhost`, `127.0.0.0/8`, `0.0.0.0/8`, `169.254.0.0/16`
    (cloud metadata), `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`,
    `fc00::/7`, `fe80::/10`, IPv4-mapped формы (`::ffff:127.0.0.1`),
    числовые/hex-формы IPv4;
  - `allowPrivate: true` — только dev, никогда в проде; DNS-имена не резолвятся
    синхронно, поэтому дополнительно нужен egress-firewall/DNS-pinning.
- HMAC-заголовки для вебхуков: `x-agil-signature` (hex HMAC-SHA256 по
  `${timestamp}.${rawBody}`), `x-agil-delivery`, `x-agil-event`,
  `x-agil-timestamp`; `signWebhookPayload`/`verifyWebhookSignature`
  (constant-time + окно timestamp, default 300 с) — защита от подделки и replay.
- Таймауты обязательны на всех сетевых вызовах (`AbortController`), размеры
  ответов ограничиваются, ошибки наружу отдаются без деталей чужих сервисов.
- Секреты компании хранятся только в env/secret manager; в `TenantConfig` —
  имя переменной (`secretEnv`, `apiKeyEnv`), причём только из allowlist
  namespace'ов (§2.11).

### 2.10 Вебхуки: подпись и стык с приложением компании

Подробный контракт — `agil/core/docs/integration-boundaries.md`.

- Подписка: `integrations.webhooks[]` (`url`, `events`, `secretEnv`, `retries`,
  `timeoutMs`).
- Доставка: `POST` JSON `WebhookPayload` с заголовками `x-agil-signature`,
  `x-agil-delivery`, `x-agil-event`, `x-agil-timestamp`; подпись —
  `hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)`.
- Секрет живёт в env по имени `secretEnv`; в конфиге и логах его нет. Имя
  обязано быть `AGIL_WEBHOOK_*` (§2.11); ключ не меняется автоматически —
  ротация через env/secret manager.
- Получатель обязан: проверить подпись constant-time, проверить окно timestamp
  (replay), ответить 2xx быстро (тяжёлую обработку — асинхронно), дедуплицировать
  по `x-agil-delivery`.
- Ретраи с backoff, таймаут, лог последних 200 доставок (in-memory) для
  диагностики; события: `room.created/closed`, `participant.joined/left`,
  `chat.message`, `file.shared`, `recording.ready`, `transcript.ready`,
  `analysis.ready`, `knowledge.answer`, `compliance.finding`, `security.event`.
- Наш сервер **не** содержит бизнес-логику компании (каталог сотрудников, wiki,
  корпоративные правила), а компания не реализует медиа-часть — это граница
  ответственности, см. `agil/core/docs/integration-boundaries.md`.

### 2.11 Ссылки на секреты в конфиге тенанта (`*Env`)

Конфиг тенанта может **называть** env-переменную, но никогда не хранит секрет.
До харденинга сервер резолвил имя через `process.env[name]`, поэтому tenant admin
(или держатель admin-сессии SSO) мог записать
`session.aiAgent.apiKeyEnv = "AGIL_TOKEN_SECRET"` и получить значение на свой
endpoint — произвольное чтение секретов сервера (`AGIL_PLATFORM_KEY`,
`AGIL_API_KEYS`, `AGIL_SCIM_TOKEN`, cloud credentials). Такие же примитивы были
у `providers.*.apiKeyEnv`, `webhooks[].secretEnv`, SIEM `secretEnv`,
`scale.sfu.*` и `scale.turn[].credentialEnv`.

Теперь действует allowlist **серверных namespace'ов** + снапшот env на старте:

| Поле конфига | Разрешённое имя |
|---|---|
| `session.aiAgent.apiKeyEnv`, `session.knowledgeAgent.apiKeyEnv`, `session.inCallAgent.apiKeyEnv`, `providers.<slot>.apiKeyEnv` | `AGIL_INTEGRATION_*` (legacy: `AGIL_AI_AGENT_KEY`, `AGIL_KNOWLEDGE_AGENT_KEY`, `AGIL_INCALL_AGENT_KEY`, `AGIL_{CHAT,FILES,STT,NOTIFICATIONS,RECORDING,BACKGROUNDS}_PROVIDER_KEY`) |
| `integrations.webhooks[].secretEnv` | `AGIL_WEBHOOK_*` |
| `integrations.siem.secretEnv` | `AGIL_SIEM_*` |
| `scale.sfu.apiKeyEnv`, `scale.sfu.apiSecretEnv` | `AGIL_SFU_*` |
| `scale.turn[].credentialEnv` | `AGIL_TURN_*` |
| `integrations.identity.clientSecretEnv` | `AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>` или имя из `AGIL_OIDC_TENANT_SECRETS` (namespace `AGIL_OIDC_CLIENT_SECRET*`) |

- Пустая строка = «не настроено». Любое другое имя → `400 validation_failed`
  на записи конфига: `PATCH/PUT /v1/tenants/:id/config`, админские
  `PUT /v1/admin/{ai-agent,knowledge-agent,in-call-agent,webhooks,providers,scale}`
  и per-room `configOverrides`.
- На старте сервер копирует только эти namespace'ы в `env.tenantSecretEnv`.
  При использовании значение берётся **только** из снапшота — `process.env` по
  имени из конфига не читается. Переменная, появившаяся после старта, не видна
  (нужен рестарт процесса).
- Повторная проверка при использовании (defense in depth): даже старый или
  рукописный конфиг с `apiKeyEnv: "AGIL_TOKEN_SECRET"` не прочитает секрет и не
  сделает HTTP-вызов — knowledge/WS `501 knowledge_not_configured`, webhook и
  provider возвращают ошибку «not allowed», in-call assistant — `502`, SIEM
  отправляет событие **без** HMAC (`x-agil-signature` не ставится), SFU/TURN
  считаются незаданными (`sfuConfigured`/`credentialConfigured=false`).
- Allowlisted, но незаданная переменная → «не настроено» (`501`/ошибка доставки),
  без значения и без fallback на другую переменную. Имя переменной может попасть
  в сообщение/статус (это не секрет), значение — никогда.
- OIDC-секрет дополнительно **привязан к тенанту** (P2): `clientSecretEnv` обязан
  иметь вид `AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>` (соглашение доступно только
  для канонических id тенанта — строчные латинские буквы/цифры, сегмент в верхнем
  регистре) либо быть явно закреплён за тенантом в
  `AGIL_OIDC_TENANT_SECRETS="tenant=ENV_NAME,..."`. Ключ карты сравнивается с id
  тенанта **точно и с учётом регистра**: `demo` не авторизует `DEMO`, а `a-b` не
  авторизует `a_b`/`a.b`/`A_B`; повторяющийся ключ тенанта отключает всю карту
  (fail closed). Глобальное `AGIL_OIDC_CLIENT_SECRET` и имена без tenant-сегмента
  принимаются только через карту. `demo` + `AGIL_OIDC_CLIENT_SECRET_ACME_*` →
  `400 validation_failed` (на записи и при обмене; token endpoint не вызывается),
  поэтому один тенант не может отправить OIDC-секрет другого на свой endpoint.
  Подробности — `docs/sso-oidc.md` §2.2.
- Регрессии: `apps/server/test/secret-env.test.ts`,
  `apps/server/test/oidc-sso.test.ts`, `packages/protocol/test/secret-env.test.ts`,
  `packages/protocol/test/oidc-secret-env.test.ts` (включая «секрет не уходит на
  endpoint атакующего», «PATCH отклонён», «allowlisted unset → 501/error» и
  матрицу коллизий `a-b`/`a_b`/`a.b`/`A_B`, `demo`/`DEMO`).

## 3. Что НЕ решает MVP

- **E2EE медиа**: нет; транспорт защищён DTLS-SRTP (WebRTC) + TLS signalling/TURN,
  но сервер (SFU) видит медиа. E2EE — roadmap.
- **Надёжный deepfake-детект**: только эвристики + внешний детектор, вероятностно.
- **SSO/SCIM/OIDC**: проверка OIDC identity JWT по JWKS и вход в панель по
  authorization code + PKCE реализованы; есть email/domain allowlist,
  group→role, tenantClaim и серверный отзыв сессии (in-memory). Поддержаны
  OIDC discovery (`discovery`/`discoveryUrl`, issuer-pinned),
  `client_secret_post`/`client_secret_basic`, `response_mode=form_post` и
  RP-initiated logout (`end_session_endpoint` + state). SCIM 2.0 —
  провижининг каталога. Ограничения потока (in-memory state/deny-list,
  cross-origin cookie-binding, отсутствие `private_key_jwt`/mTLS и
  `id_token_hint`) перечислены в разделе «Dashboard SSO (OIDC authorization
  code)» и `docs/sso-oidc.md`.
- **2FA/MFA, RBAC-движок**: только роли host/moderator/guest + `resolveAccess`.
- **Антивирус/DLP** для файлов и записей: нет (только MIME/size/HMAC).
- **Горизонтальное масштабирование**: rate-limit и аудит in-memory/локальный
  диск; multi-node требует Redis/S3.
- **C2PA/провенанс записей**, автоматический retention-экспорт, SIEM-коннектор.
- **Защита от L3/L4-DoS**: вне приложения (CDN/WAF/прокси).

## 4. Рекомендации по эксплуатации

**Транспорт и периметр**

- Только TLS (HTTPS/WSS) на периметре: reverse-proxy (nginx/Caddy/ALB) + HSTS,
  редирект HTTP→HTTPS. `AGIL_PUBLIC_ORIGIN` — https-origin.
- TURN: `turns:` с TLS-сертификатом, ephemeral credentials (TURN REST
  `time-based`), а не статические логин/пароль в клиенте; STUN — публичный.
- `AGIL_TRUST_PROXY=1` включать **только** за своим прокси, который сам
  перезаписывает `x-forwarded-for`/гео-заголовки; иначе клиент подделает страну.
- WAF/CDN: rate-limit на join/files, лимит размера тела, блокировка подозрительных
  гео/ASN — до приложения.

**Секреты**

- `AGIL_TOKEN_SECRET`, `AGIL_IP_SALT`, файловые секреты, ключи STT/AI —
  только через secret manager/env, не в git, с ротацией и разными значениями
  на окружения. Соль IP — стабильная в рамках инсталляции, иначе корреляция
  аудита ломается; при её смене старые хэши не сопоставимы (это ок).
- Не логировать заголовки `authorization`, `x-api-key`, тела с паролями/
  транскриптами; `console.log` секретов запрещён на ревью.

**Данные и соответствие**

- GDPR/152-ФЗ: согласие на запись (`recording.consentRequired`,
  `notifyParticipants`), минимизация (IP — хэшем, страна — кодом), сроки
  хранения (`retentionMin`, `AGIL_FILE_TTL_SEC`), право на удаление
  (`DELETE /v1/admin/recordings/:id`, удаление файлов), DPA с тенантом,
  оценка трансграничной передачи (ipapi/STT/AI — за пределами РФ/ЕС?);
  для 152-ФЗ — локализация БД с персональными данными.
- Каталоги `audit/`, `files/`, `recordings/` — вне web-root, права только сервису,
  бэкапы шифровать; диск с записями — шифрование at rest.
- Аудит хранить не менее срока, оговорённого политикой тенанта; выгрузка — через
  admin API/log shipping, не через публичные пути.

**Мониторинг**

- Алерты: всплеск `password.failed`/`join.denied`/`geo.blocked`/`lockout`,
  `integrity.flagged`, 5xx на webhooks/STT/AI, рост `rate_limited`, ошибки аудита
  (запись не удалась), размер каталогов files/recordings.
- Проверять доставки вебхуков (`GET /v1/admin/webhooks`, recentDeliveries) и
  валидность внешних endpoint'ов при изменении конфига.

## 5. Ссылки

- Контракт и API: `agil/core/docs/contract.md` (§12 — security, §14 — REST, §18–§21).
- Интеграционные границы и вебхуки: `agil/core/docs/integration-boundaries.md`.
- Аудит безопасности и roadmap-меры: `agil/core/docs/security-audit.md`.
- Развёртывание: `agil/core/docs/deployment.md`.
- API библиотеки и примеры: `agil/core/packages/security/README.md`.

---

## E2EE (SFU) — серверная часть

- `security.e2ee` + `mediaMode: sfu|broadcast` → в `join.media`/`welcome.media` добавляется `e2ee {key, algorithm:'AES-GCM', keyIndex:0}`.
- Ключ: `HMAC-SHA256(AGIL_E2EE_SECRET, "<tenantId>:<roomId>")` → 32 байта base64url, одинаковый для всех участников комнаты; в JWT/логах/аудите ключа нет.
- Без `AGIL_E2EE_SECRET` — dev-fallback на join-секрет с предупреждением в `/v1/admin/media/processing`; в продакшене обязателен отдельный секрет.
- E2EE несовместим с egress/transcoding/серверной записью/серверным STT (SFU не расшифрует): статус `e2eeConflict:true`, `misconfigured:true`, воркеры не запускаются.

## SSO / OIDC (verified joins)

`integrations.identity` (tenant) с `mode:"oidc"`: `POST /v1/auth/oidc/verify` и
`POST /v1/rooms/:id/join` принимают `identityToken` (RS256/ES256 JWT). Проверка
по JWKS (`jwksUrl`, timeout 3s, кэш 10 мин + `Cache-Control`, один rate-limited
refetch при ротации `kid`, негативный кэш 30 c), обязательный точный `iss`,
`aud`/`azp`, `exp/nbf/iat` с настраиваемым clock skew, RSA ≥ 2048 бит, только
`RS256/ES256`, `typ` не `at+jwt`. Политика: email/domain allowlist
(`allowedEmails`/`allowedEmailDomains`, явный `email_verified:false` запрещает),
группы IdP → роль (`groupRoleMap`, при непустой карте авторитетны только группы),
привязка к тенанту (`tenantClaim`), `maxTokenAgeSec`.
`security.requireVerifiedIdentity` требует `verifiedClaim:true`. Name/role/
permissions берутся из проверенных claims; токен не логируется и не попадает в
аудит. Отказ: `401 identity_required` / `401 invalid_identity_token` /
`403 identity_not_allowed` / `403 tenant_mismatch`.

## Dashboard SSO (OIDC authorization code)

«Войти через SSO» на экране входа панели: `GET /v1/auth/oidc/start` →
authorization code + PKCE (S256) у IdP → `GET /v1/auth/oidc/callback`.

- **state/nonce/PKCE**: 32 байта random каждое, state одноразовый, TTL 10 минут
  (`AGIL_OIDC_STATE_TTL_SEC`), хранится в памяти процесса (не на диске, не в
  логах). Для same-origin панели state привязан к HttpOnly/SameSite=Lax cookie
  `agil_oidc_binding` (`AGIL_OIDC_COOKIE_BINDING=0` отключает): callback без
  cookie отклоняется и state сжигается (login-CSRF). Повторный/чужой/истёкший
  state → `#sso_error=state_invalid|state_expired`.
- **returnTo**: относительный путь или абсолютный URL только из
  `AGIL_PUBLIC_ORIGIN` / `integrations.allowedOrigins`; относительный путь
  разрешается и **после разрешения** обязан сохранить origin публичного адреса
  (scheme+host+port). Обратные слэши/управляющие символы (`/\evil.example`,
  `%2F%5C…`), `//…`, credentials и чужие origin → `400 validation_failed`;
  authorization URL не выдаётся — открытого редиректа и утечки фрагмента с
  сессией на чужой origin нет.
- **Обмен кода**: POST на `tokenEndpoint` с `code_verifier`; клиент
  аутентифицируется `client_secret_post` (секрет в form-body, по умолчанию) или
  `client_secret_basic` (HTTP Basic, RFC 6749 §2.3.1 — значения
  form-urlencoded перед base64). Секрет читается только из серверного снимка
  env-переменных
  `AGIL_OIDC_CLIENT_SECRET*`, имя выбирается в `clientSecretEnv` **и обязано быть
  привязано к тенанту** (`AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>` для канонического
  lower-case id или точная запись в `AGIL_OIDC_TENANT_SECRETS`). Чужое/непривязанное
  имя (например `AGIL_TOKEN_SECRET`, `AGIL_OIDC_CLIENT_SECRET_ACME_A` для `demo`,
  `AGIL_OIDC_CLIENT_SECRET_*_A_B` для `a-b`/`a_b`/`a.b`/`A_B`) отклоняется при
  записи конфига и при обмене кода; сам секрет никогда не хранится в конфиге и не
  логируется; ответ IdP не пересылается клиенту (только HTTP-статус в тексте
  ошибки).
- **id_token**: проверяется тем же верификатором, что join-токены — подпись по
  JWKS, обязательный `iss`, `aud` (принимается `identity.audience` **или**
  `clientId`), `azp` для multi-aud, `exp`/`nbf`/`iat`, `nonce`, опционально
  `tenantClaim`; email/domain allowlist и `dashboardAdminGroups` проверяются до
  выдачи сессии. `verifiedClaim:false` → `identity_not_verified`; allowlist/
  группа → `identity_not_allowed`; чужой tenant → `tenant_mismatch`.
- **Сессия панели**: HS256 JWT `{kind:"admin_session", role:"admin", tenantId,
  sub, name, jti, iat, exp}`, TTL 900 c (`AGIL_ADMIN_SESSION_TTL_SEC`). Ключ
  подписи — `HMAC(AGIL_TOKEN_SECRET, "agil-admin-session-v1")`: домен-сепарация
  не даёт переиспользовать join-токен как admin-сессию и наоборот. Принимается
  как `Authorization: Bearer` только на tenant-эндпоинтах; платформенные
  маршруты (`/v1/admin/tenants`) отвечают 403. Права не пинуются в токене —
  сервер читает конфиг тенанта на каждом запросе.
- **Выход/отзыв**: `POST /v1/auth/oidc/logout` отзывает `jti` сессии в
  in-memory deny-list до `exp` (идемпотентно, 204; Bearer-only — CSRF не
  применим). Панель вызывает его при выходе и при переходе на API-ключ. Отзыв
  действует в пределах процесса. Если настроен `end_session_endpoint`
  (явно или через discovery), панель после отзыва уходит на IdP RP-initiated
  logout (`GET /v1/auth/oidc/logout` → одноразовый state) — тогда завершается и
  корпоративная сессия IdP; иначе IdP-сессия не завершается.
- **Токен в браузере**: приходит только во фрагменте `#sso_token=…` (фрагмент не
  уходит на сервер, не попадает в access-логи/прокси/Referer; `Referrer-Policy:
  no-referrer` и meta referrer). Панель сразу стирает его из адресной строки
  (`history.replaceState`), хранит в `localStorage` и никогда не рендерит в
  DOM/логи; уходит только в заголовке `Authorization` к своему серверу.
- **Аудит**: `admin.action` «Dashboard SSO login»/«Dashboard SSO logout»
  (tenant, IP-hash) без токена, кода, id_token и PII.
- **Ограничения**: pending state/logout-state и deny-list в памяти → мульти-нода
  требует sticky sessions/shared store; поддерживаются
  `client_secret_post`/`client_secret_basic` (без `private_key_jwt`/mTLS),
  `response_mode=query`/`form_post` (form_post требует HTTPS и
  `SameSite=None; Secure`) и RP-initiated logout без `id_token_hint` (IdP,
  требующий hint, не поддержан); по умолчанию
  **любой** пользователь, которого IdP аутентифицирует для этого OAuth-клиента,
  получает tenant admin — задайте `dashboardAdminGroups` и/или ограничьте клиент
  в IdP. Cross-origin панель не получает cookie-привязку state (документировано
  в `agil/core/docs/sso-oidc.md`).


## SCIM 2.0 directory

`/scim/v2/{Users,Groups,...}` — провижининг из IdP. Auth:
`Authorization: Bearer $AGIL_SCIM_TOKEN` (501 если не задан, 401 при неверном),
тенант — `x-tenant-id`; `application/scim+json`. Хранится per-tenant JSON в
`<data>/scim/<tenant>.json` (атомарно), без паролей. SCIM-роли — только данные,
admin-права из SCIM не выдаются автоматически (`roles[].agilRole` — расширение,
применение через access policy). Аудит `scim.user.*`/`scim.group.*` без email/PII.

## SIEM-экспорт аудита

`integrations.siem` (off by default): audit append → очередь → HTTP POST в SIEM
(JSON или CEF), optional HMAC `x-agil-signature` (hex HMAC-SHA256 raw body) из
env-переменной `secretEnv` — только `AGIL_SIEM_*` (§2.11), в конфиге только имя.
Timeout/retries, fail-open:
аудит не блокируется; `GET /v1/admin/siem/status` показывает очередь/последнюю
ошибку/доставку без URL и секретов; `POST /v1/admin/siem/test` — тест (501 если
выключено). В payload только `ipHash`, без raw IP и секретов; URL проходит
SSRF-политику.

## Egress (recording/RTMP/HLS)

`GET/POST /v1/rooms/:id/egress…` — host/moderator или admin key; сервер вызывает
LiveKit Egress Twirp с HS256 JWT (`video.roomRecord`), credentials воркера клиенту
не выдаются. Gating: recording (features.recording + mediaProcessing.egress или
streaming), rtmp/hls (features.liveStreaming + scale.streaming.enabled).
E2EE + egress → `409 e2ee_incompatible`. RTMP URL валидируется по схеме; в
логах/аудите/ответах редактируется до host (stream key не пишется). Env
`AGIL_EGRESS_*`; `AGIL_EGRESS_ENABLED=0` → 501. Аудит `egress.started/stopped/failed`;
статус `/v1/admin/egress/status` без URL/секретов.
