# AgilFrame как SaaS: мультиорганизационность

Дата: 2026-11-13 · зона: `agil/core/apps/server` · статус: реализовано (MVP).

Один процесс/API обслуживает несколько организаций (тенантов). У каждой
организации — собственный конфиг (`TenantConfig`): брендинг (название, логотип,
support/footer), тема, фичи, лимиты, безопасность, встроенные/внешние
провайдеры, AI/knowledge, scale. Комнаты, файлы, записи, аудит и
WS-подключения всегда скоупятся `tenantId`.

## 1. Два типа credentials

| Credential | env | Назначение |
|---|---|---|
| Platform key | `AGIL_PLATFORM_KEY` | управление организациями: `GET/POST /v1/admin/tenants`, `POST /v1/admin/tenants/:id/keys`, `DELETE /v1/admin/tenants/:id`; **не является tenant-ключом** |
| Tenant API key | `AGIL_API_KEYS` (env) и динамические | обычный admin key: `/v1/admin/*`, создание комнат, токены; видит только свой тенант |

Динамические ключи создаются через platform API и хранятся **только хэшем**
(`sha256(AGIL_IP_SALT + ':' + key)`) в `AGIL_DATA_DIR/api-keys.json`
(атомарная запись). Plaintext возвращается один раз в ответе на создание/ротацию
и больше не показывается ни в списках, ни в аудите. Redis/БД не требуются —
файл на volume.

Ротация: `POST /v1/admin/tenants/:id/keys` заменяет динамический ключ тенанта
(старый сразу даёт 401). Env-ключи API не отзывает — удаление env-key тенанта
запрещено, чтобы не оставить «вечный» ключ.

## 2. Онбординг организации

`POST /v1/admin/tenants`:

- `tenantId` — `[a-zA-Z0-9._-]{1,64}`, уникален глобально (409 при дубле);
- `name`, `organizationName`, `branding{productName,logoUrl,faviconUrl,supportUrl,footerText}`;
- `theme{preset?,scheme?,colors?}`;
- `preset`: `default` | `corporate` | `minimal` (см. таблицу);
- `features` при необходимости задаёт отдельные флаги поверх выбранного шаблона. Например, `{"fileShare":true}` возвращает обмен файлами в конфигурацию `minimal`;
- `templateTenantId` — копия конфига существующего тенанта (брендинг/тема
  применяются поверх).

| Preset | Что включает |
|---|---|
| `default` | обычный `defaultConfig` (как demo) |
| `corporate` | waiting room, строгий lockout (`maxFailedJoinAttempts=5`, `lockoutSec=600`), файлы/запись выключены |
| `minimal` | только базовый звонок/чат: без файлов, записи, субтитров, knowledge, screen share, вебинаров, breakout, перевода |

Ответ содержит `tenant`, однократно выдаваемый `apiKey` и адрес `embedUrl`. Для запуска виджета добавьте `room` с идентификатором комнаты организации и, если вход ограничен, персональный токен. В панели после создания можно скопировать шаблон с `ROOM_ID`.

## 3. Изоляция и авторизация

`apiKeyTenant` резолвит env-ключи, затем динамические (constant-time compare).
Platform key намеренно не резолвится как tenant. `requireApiKeyTenant`:
platform key на tenant-ручке → 403, неизвестный/отозванный → 401. Все
admin/public ручки проверяют `requireTenantMatch`/tenant-скоуп; чужая комната →
404/403 по контракту, чужие данные не утекают. Tenant-ручки
`GET/PATCH /v1/admin/tenants/:id` доступны платформе и самому тенанту;

## 4. Жизненный цикл и удаление

`DELETE /v1/admin/tenants/:id`:
- demo (`AGIL_DEFAULT_TENANT`) и тенанты из `AGIL_API_KEYS` защищены (400);
- конфиг архивируется в `AGIL_DATA_DIR/tenants/.archive/retired/<id>.json`. Этот файл резервирует идентификатор после перезапуска. Старые архивы вида `.archive/<id>-<ts>.json` также резервируют ID, если активной организации с ним уже нет;
- динамический ключ удаляется; все in-memory комнаты тенанта закрываются;
- аудит `tenant.deleted`. Записи/файлы на диске остаются (retention — политика
  компании; purge — roadmap).
- созданию новой организации с архивным идентификатором соответствует HTTP 409. Создание, изменение, ротация ключа и удаление выполняются на лидере Core. Каталог архива следует сохранять при резервном копировании и переносе данных.

Аудит платформенных операций: `tenant.created`, `tenant.updated`,
`tenant.key.rotated`, `tenant.deleted` (без секретов/ключей).

## 5. Кастомные домены и биллинг

Кастомные домены реализованы в baseline (подробно — `agil/core/docs/custom-domains.md`):

- `branding.customDomain` + `GET/PUT/POST/DELETE /v1/admin/domain` и
  `POST /v1/admin/domain/verify` (tenant admin);
- реестр `AGIL_DATA_DIR/domains.json` хранит `domain → tenantId`, статус
  `pending|verified`, verification token и timestamps; при старте и на каждую
  запись конфига он синхронизируется с `branding.customDomain`;
- DNS-верификация: TXT `_agil-calls.<domain>` = `agil-verify=<token>`
  **обязателен для первой верификации** (доказательство владения); CNAME
  `<domain>` → `AGIL_DOMAIN_TARGET` отвечает за маршрутизацию и допускается
  один только при повторной проверке уже verified-домена; `verified` —
  единственный статус, при котором `Host` резолвится в тенант;
- `GET /v1/host` отдаёт tenant/branding текущего Host, `GET /v1/domain/ask` —
  on-demand TLS approval hook для Caddy/HAProxy: только для IP прокси
  (`AGIL_DOMAIN_ASK_ALLOW_IPS`, по умолчанию loopback), Host gate
  `AGIL_DOMAIN_ASK_HOSTS` и **обязательный** `AGIL_DOMAIN_ASK_SECRET`
  (пустой = `403`, hook выключен); неверные секреты лимитируются per-client,
  успешные ask — per-peer; `tenantId` не раскрывается; в публичном Caddy
  site-block нужен `respond /v1/domain/ask 404`;
- TLS/ACME — внешний reverse-proxy (SNI); Node остаётся HTTP-бэкендом, общий
  Caddy в репозитории не меняется;
- fallback: неизвестный/битый Host и pending-домены → `AGIL_DEFAULT_TENANT`;
  `?tenant=` остаётся явным override.

Ограничения baseline: verify запускается вручную (нет периодического recheck),
нет wildcard/IDN-кириллицы, один домен на тенант, один `domains.json` на
процесс/volume (в кластере нужен общий volume или внешний registry).

Дальше по доменам: периодический recheck с алертами, wildcard/IDN, автоудаление
при отзыве DNS, UI панели платформы. **Биллинг**: план/лимиты
(`limits.maxParticipants`, запись, AI-квоты) в отдельном биллинг-сервисе;
usage-события (комнаты/участники/минуты) уже можно отдавать вебхуками, добавить
`billing.usage` sink.

3. **Admin UI платформы**: список организаций, создание/ротация/удаление,
   «войти как тенант» (impersonation через короткоживущий platform-issued
   ключ с аудитом) — отдельная панель.
4. **Персистентность ключей**: файл → БД/секрет-менеджер, кэш резолва,
   инвалидация по webhook.
5. **Квоты/rate-limit per tenant** (сейчас общий limiter per tenant key).
