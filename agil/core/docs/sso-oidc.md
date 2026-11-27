# SSO / OIDC: вход в панель и подтверждённые join

Документ описывает корпоративную федерацию идентичности AgilFrame: вход в
панель по **authorization code + PKCE** и проверку **identity JWT** при join.
Краткая версия — `docs/security.md` и `docs/api.md` §31; здесь — модель угроз,
полный справочник настроек, пример Keycloak и операторские процедуры.

Код: `agil/core/apps/server/src/oidc.ts` (верификатор),
`oidc-flow.ts` (auth-code flow + RP-initiated logout), `oidc-discovery.ts`
(discovery), `admin-session.ts` (сессия + отзыв), `public-api.ts` (маршруты),
дашборд — `apps/dashboard/src/sso.ts`. Тесты: `apps/server/test/oidc.test.ts`,
`oidc-sso.test.ts`, `oidc-hardening.test.ts`, `oidc-corporate.test.ts`
(герметичный mock IdP/JWKS/discovery/logout, без сети и Keycloak).

---

## 1. Два потока с одним корнем доверия

```
                         ┌──────────────────────────────┐
  браузер панели         │  GET /v1/auth/oidc/start      │  state + nonce + PKCE(S256)
  ──────────────────────▶│  (tenant config → IdP URL)    │  + HttpOnly binding cookie
                         └──────────────┬───────────────┘
                                        │ 302 на authorizationEndpoint
                                        ▼
                                   ┌─────────┐
                                   │   IdP   │  логин пользователя
                                   └────┬────┘
                                        │ redirect_uri?code&state
                                        ▼
                         ┌──────────────────────────────┐
                         │ GET /v1/auth/oidc/callback   │  state(+cookie) → code exchange
                         │ tokenEndpoint (client_secret)│  id_token: JWKS/iss/aud/azp/
                         └──────────────┬───────────────┘  exp/nonce/tenant/email/groups
                                        │ 302
                                        ▼
                    /dashboard/#sso_token=<HS256 admin session>
                    (фрагмент; сервер его не видит и не логирует)
```

Verified join использует тот же верификатор, но без code flow: клиент присылает
уже выпущенный IdP `identityToken` в `POST /v1/auth/oidc/verify` или
`POST /v1/rooms/:id/join`. Токен проверяется локально по JWKS тенанта; сервер
не ходит к IdP, кроме загрузки JWKS.

---

## 2. Настройка `integrations.identity`

Все поля — в конфиге тенанта (`PATCH /v1/tenants/:id/config`), UI — «Интеграции →
Вход» и «Безопасность → Корпоративный вход».

### 2.1 Базовые

| Поле | По умолчанию | Назначение |
|---|---|---|
| `mode` | `token` | `oidc` включает JWKS-проверку и SSO. |
| `issuer` | — | **Обязателен** для `oidc`; сравнивается точно (`iss`). |
| `audience` | — | API-audience join-токенов; для панели дополнительно принимается `clientId`. |
| `jwksUrl` | — | JWKS тенанта (https в production; URL-политика/SSRF). |
| `userIdClaim` | `sub` | Claim с id пользователя (обрезается до 200, control-chars вырезаются). |
| `nameClaim` | `name` | Display name (до 120). |
| `roleClaim` | `role` | `host`/`moderator`/`guest`; иначе `guest` (если нет `groupRoleMap`). |
| `permissionsClaim` | `permissions` | Массив известных feature keys; неизвестные отбрасываются. |
| `verifiedClaim` | `verified` | `true`/`"true"`/`1`; при `security.requireVerifiedIdentity` обязателен. |

### 2.2 Вход в панель

| Поле | По умолчанию | Назначение |
|---|---|---|
| `authorizationEndpoint` | — | Куда уходит браузер. Пусто + `discovery` → из метаданных IdP. |
| `tokenEndpoint` | — | Серверный обмен кода. Пусто + `discovery` → из метаданных. |
| `clientId` | — | OAuth client id. |
| `clientSecretEnv` | — | **Имя** env-переменной с секретом, привязанное к тенанту: `AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>` (например `AGIL_OIDC_CLIENT_SECRET_DEMO_KEYCLOAK`) или имя из карты `AGIL_OIDC_TENANT_SECRETS`. Глобальное/legacy-имя без привязки отклоняется (`400 validation_failed`) при записи конфига и при обмене кода. |
| `tokenEndpointAuthMethod` | `client_secret_post` | `client_secret_post` (секрет в form-body) или `client_secret_basic` (HTTP Basic, RFC 6749 §2.3.1). При discovery, если `token_endpoint_auth_methods_supported` не содержит выбранный метод, — fail closed `501`. |
| `redirectUri` | `<publicOrigin>/v1/auth/oidc/callback` | Должен совпадать с IdP. |
| `responseMode` | `query` | `query` или `form_post` (OAuth 2.0 Form Post Response Mode; IdP POST-ит code/state на callback). `form_post` требует HTTPS и cookie `SameSite=None`. |
| `scopes` | `[]` | `openid` добавляется всегда. |
| `dashboardAdminGroups` | `[]` | Группы, которым разрешён вход в панель. Пусто = любой аутентифицированный клиентом пользователь (P1-контракт). |
| `endSessionEndpoint` | — | IdP `end_session_endpoint` для RP-initiated logout. Пусто + `discovery` → из метаданных; если нигде нет — RP logout недоступен (GET `/v1/auth/oidc/logout` → 501), панель отзывает только локальную сессию. |
| `postLogoutRedirectUri` | `<publicOrigin>/v1/auth/oidc/logout/callback` | Зарегистрированный в IdP `post_logout_redirect_uri`. По умолчанию — серверный callback, который проверяет одноразовый `state` и возвращает на `returnTo` дашборда. |
| `discovery` | `false` | Включить OIDC Discovery 1.0 с `issuer`. |
| `discoveryUrl` | `` | Необязательный явный URL discovery-документа (IdP с нестандартным путём); непустое значение включает discovery. |

Секреты OIDC-клиентов считываются в память при старте сервера (снимок
`AGIL_OIDC_CLIENT_SECRET*`); после изменения переменной окружения перезапустите
процесс.

#### Привязка секрета к тенанту (P2)

Одного попадания в namespace `AGIL_OIDC_CLIENT_SECRET*` недостаточно: имя
обязано принадлежать тенанту. Иначе тенант `demo` мог бы выбрать
`AGIL_OIDC_CLIENT_SECRET_ACME_*` и отправить секрет acme на свой token endpoint
(межтенантная утечка credential). Поддерживаются два способа привязки:

1. **Соглашение имён** — `AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>`, где
   `<TENANT>` — id тенанта в верхнем регистре (`[A-Z0-9]+`), `<NAME>` —
   произвольный суффикс (`[A-Za-z0-9_]+`). Соглашение доступно **только для
   канонических id тенанта** — строчные латинские буквы и цифры (`[a-z0-9]+`):
   `demo` → сегмент `DEMO`. Id с заглавными буквами или `.`/`-`/`_` не могут
   использовать соглашение (иначе `a-b`, `a_b`, `a.b` и `A_B` схлопнулись бы в
   один `A_B`, а `demo` и `DEMO` — в `DEMO`); для них обязательна явная карта.
   Примеры для `demo`/`acme`: `AGIL_OIDC_CLIENT_SECRET_DEMO_KEYCLOAK`,
   `AGIL_OIDC_CLIENT_SECRET_ACME_A`. Тенант `demo` может выбрать только имя с
   сегментом `DEMO`, `acme` — только `ACME`; `demo` +
   `AGIL_OIDC_CLIENT_SECRET_ACME_A` → `400 validation_failed`.
2. **Явная карта** — `AGIL_OIDC_TENANT_SECRETS` (пары `tenantId=ENV_NAME`
   через запятую или пробел). Нужна для legacy/глобального
   `AGIL_OIDC_CLIENT_SECRET`, для произвольного имени без tenant-сегмента и для
   id тенанта с заглавными буквами, `-`, `.` или `_` (соглашение такие id не
   выражает):

   ```bash
   export AGIL_OIDC_TENANT_SECRETS="demo=AGIL_OIDC_CLIENT_SECRET,acme=AGIL_OIDC_CLIENT_SECRET_ACME_A"
   ```

Правила проверки:

- ключ карты сравнивается с id тенанта **точно и с учётом регистра** (та же
  политика, что в `TenantStore`): `demo` не авторизует `DEMO`, `a-b` не
  авторизует `a_b`/`a.b`/`A_B`, и наоборот; нормализация id для выбора секрета
  не применяется;
- карта авторитетна: имя, привязанное к одному тенанту, недоступно остальным,
  даже если оно совпадает с их соглашением имён;
- одно имя нельзя выдать двум тенантам — конфликтующая пара игнорируется (fail
  closed);
- повторяющийся ключ тенанта в карте (`demo=…,demo=…`) делает неоднозначной всю
  карту: она игнорируется целиком, и ни один mapped-секрет не выбирается
  (fail closed при старте). Исправьте карту и перезапустите процесс;
- глобальное `AGIL_OIDC_CLIENT_SECRET` и имя `AGIL_OIDC_CLIENT_SECRET_<NAME>` без
  tenant-сегмента допустимы **только** через карту; иначе `400
  validation_failed`;
- проверка выполняется при записи конфига (`PATCH`/`PUT`) и повторно при
  `/start` и обмене кода; при отказе token endpoint не вызывается;
- миграция существующего конфига: переименуйте переменную в
  `AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>` и обновите `clientSecretEnv` либо
  добавьте запись в `AGIL_OIDC_TENANT_SECRETS`.

### 2.3 Политика доступа (join и панель)

| Поле | По умолчанию | Семантика |
|---|---|---|
| `emailClaim` | `email` | Claim с email. |
| `emailVerifiedClaim` | `email_verified` | Явный `false` всегда запрещает; `requireEmailVerified` требует `true`. |
| `requireEmailVerified` | `false` | Fail closed при отсутствии/`false`. |
| `allowedEmails` | `[]` | Точные адреса, case-insensitive. |
| `allowedEmailDomains` | `[]` | `example.com` — только этот домен; `*.example.com` — только поддомены. |
| `groupsClaim` | `groups` | Массив строк или строка через пробел/запятую. |
| `groupRoleMap` | `[]` | `[{group, role}]`, role ∈ `host/moderator/guest`. Непустая карта авторитетна: нет совпадения → `guest`, `roleClaim` игнорируется; при нескольких совпадениях побеждает старшая роль. |
| `tenantClaim` | `` | Claim должен точно совпасть с `tenantId` тенанта (защита от replay между тенантами с общим issuer/audience). |
| `maxTokenAgeSec` | `0` | Максимум `exp − iat`; `0` — без ограничения. При >0 отсутствие `iat` отклоняется. |
| `clockSkewSec` | `60` | Допуск для `exp`/`nbf`/`iat`, 0–300. |

Важно: непустой, но полностью некорректный allowlist (опечатка в домене)
**запрещает всех** — это осознанный fail closed; проверяйте конфиг после
сохранения.

### 2.4 OIDC discovery (корпоративная совместимость)

Корпоративные IdP (Keycloak, Entra ID, Okta, ADFS, Ping) публикуют метаданные
по `issuer + /.well-known/openid-configuration` (OIDC Discovery 1.0). Включение:

```json
{
  "integrations": {
    "identity": {
      "mode": "oidc",
      "issuer": "https://sso.example.com/realms/corp",
      "discovery": true,
      "clientId": "agil-dashboard",
      "clientSecretEnv": "AGIL_OIDC_CLIENT_SECRET_DEMO_KEYCLOAK"
    }
  }
}
```

Что делает сервер (`oidc-discovery.ts`):

- загружает документ с таймаутом 4 c, без редиректов, ≤256 КиБ, один fetch на
  URL одновременно; кэш 10 минут (`Cache-Control: max-age` в диапазоне 1–60
  минут; `no-store`/`no-cache` отключают кэш), негативный кэш 30 c;
- берёт `authorization_endpoint`, `token_endpoint`, `jwks_uri`,
  `end_session_endpoint`, `token_endpoint_auth_methods_supported`,
  `response_modes_supported`;
- **проверяет `issuer` документа**: он обязан совпадать с настроенным
  `issuer` (допускается только отличие на один завершающий `/`). Иначе документ
  отклоняется — защита от mix-up/подмены метаданных;
- все endpoint'ы проходят ту же URL-политику (https в production, запрет
  private/loopback/metadata хостов, без credentials);
- **явно заполненные поля конфига имеют приоритет** над discovered-значениями
  (удобно переопределить один endpoint, например внутренний `token_endpoint`),
  а если discovery недоступен/отклонён — сервер продолжает работать на явных
  endpoint'ах (fallback). Если нужных endpoint'ов нет ни там, ни там —
  `501 identity_not_configured` (fail closed);
- если метаданные перечисляют `token_endpoint_auth_methods_supported` /
  `response_modes_supported` и выбранный `tokenEndpointAuthMethod` /
  `responseMode` там отсутствует — `501 identity_not_configured` до начала
  входа (не отправляем credential в заведомо неподдерживаемом формате);
- `jwks_uri` из discovery используется и для verified join (если `jwksUrl`
  пуст).

`discoveryUrl` (необязательно) позволяет указать нестандартный URL
discovery-документа; непустое значение включает discovery даже при
`discovery:false`.

### 2.5 RP-initiated logout

Если у тенанта есть `end_session_endpoint` (явно или из discovery), панель при
выходе дополнительно завершает **корпоративную сессию IdP**:

1. дашборд отзывает локальную AGIL-сессию (`POST /v1/auth/oidc/logout`, 204);
2. дашборд запрашивает `GET /v1/auth/oidc/logout` → получает `logoutUrl`;
3. браузер уходит на IdP `end_session_endpoint?client_id=…&post_logout_redirect_uri=…&state=…`;
4. IdP возвращает браузер на `post_logout_redirect_uri` (по умолчанию
   `<publicOrigin>/v1/auth/oidc/logout/callback?state=…`);
5. сервер проверяет и сжигает одноразовый `state`, возвращает 302 на
   `returnTo` дашборда (без токенов и IdP-данных в URL).

Ограничения:

- `id_token_hint` не отправляется: сервер не хранит IdP `id_token` (он
  отбрасывается после проверки). По OIDC RP может опустить hint, идентифицируя
  клиента через `client_id` + зарегистрированный `post_logout_redirect_uri`;
  IdP, который **требует** `id_token_hint`, этим путём не поддержан —
  сохраняется локальный logout;
- `post_logout_redirect_uri` должен быть зарегистрирован в IdP; при кастомном
  значении (например, страница дашборда) серверный callback/проверка `state`
  не участвуют — `state` в этом случае возвращается вашей странице;
- pending logout `state` хранится в памяти процесса (мульти-нода — те же
  ограничения, что у login state).

Если RP logout не настроен, дашборд работает как раньше: локальный отзыв и
экран входа, IdP-сессия не завершается.

---

## 3. Проверка id_token / identity JWT

Порядок и правила (`verifyOidcToken`):

1. `mode:"oidc"`, непустые `issuer` и (`audience` или `clientId`) — иначе
   `501 identity_not_configured` (раньше пустой issuer означал «не проверять»,
   теперь это запрещено).
2. Компактный JWT из трёх частей, ≤16 КиБ; header/payload — JSON-объекты.
3. `alg` ∈ `RS256`,`ES256`; `typ`, если есть, равен `JWT`/`application/jwt`
   (`at+jwt` отклоняется); `kid` — строка ≤256.
4. Подпись по JWKS; `kid` ищется точно, при отсутствии — один rate-limited
   refetch (ротация). `oct`/`enc`-ключи, `key_ops` без `verify`, RSA < 2048 бит
   игнорируются.
5. `exp` (number, `now − skew`), `nbf` (number, `now + skew`), `iat` (number, не
   в будущем; `exp − iat ≤ maxTokenAgeSec`).
6. `iss` строго равен конфигу; `aud` содержит `audience`/`clientId`; при
   multi-aud (`aud` — массив из 2+ значений) обязателен `azp` из доверенных
   значений. Для одиночного `aud` `azp` не проверяется (IdP может указывать там
   resource client id).
7. `nonce` (постоянное по времени сравнение) — для code flow обязателен.
8. `tenantClaim`, email/domain allowlist, `email_verified`, `dashboardAdminGroups`
   (только панель).
9. Маппинг: роль из `groupRoleMap` или `roleClaim`; permissions из claim;
   имя/id очищаются от control chars и обрезаются.

Коды ошибок: `401 invalid_identity_token` (подпись/claims/iss/aud/exp/nonce/alg),
`403 identity_not_allowed` (email/домен/группа), `403 tenant_mismatch`,
`403 identity_not_verified`, `501 identity_not_configured`, `503` при
недоступном JWKS (в HTTP — `503 identity_not_configured`).

---

## 4. JWKS: кэш, ротация, сбои

`jwksUrl` может быть задан явно или получен из discovery (`jwks_uri`), см. §2.4.

- TTL по умолчанию 10 минут; `Cache-Control: max-age` учитывается в диапазоне
  1–60 минут. `ETag`/`If-None-Match` поддерживается (304 продлевает кэш).
- `Cache-Control: no-store` или `no-cache` от IdP отключает кэш: ключи
  перезапрашиваются на каждой проверке (отозванный ключ не живёт в кэше до
  10 минут).
- Один `fetch` на URL одновременно (single-flight); таймаут 3 c, редиректы
  запрещены, ответ ≤512 КиБ, ≤32 пригодных ключей, кэш ≤64 URL.
- Неизвестный `kid` → **один** refetch на URL за 30 c. Это защищает IdP от
  amplification: поток токенов со случайным `kid` не вызывает fetch на каждый
  запрос.
- Ошибка загрузки: короткий негативный кэш 30 c; истёкший кэш не используется
  (fail closed). Если не удался именно forced-refetch ротации, ещё валидные
  ключи из кэша остаются доступны — решение всё равно за проверкой подписи.
- Диагностика: `oidcJwksDiagnostics()` (URL, число ключей, fetchedAt, fetchCount,
  lastError; токенов там нет).
- Ротация в IdP: публикуйте новый ключ рядом со старым (`kid` обязателен),
  дождитесь TTL/форс-рефреша, затем удаляйте старый.

---

## 5. Сессия панели, logout и отзыв

- Сессия — HS256 JWT `{kind:"admin_session", role:"admin", tenantId, sub, name,
  jti, iat, exp}`; ключ = `HMAC(AGIL_TOKEN_SECRET, "agil-admin-session-v1")`,
  TTL `AGIL_ADMIN_SESSION_TTL_SEC` (900 c, минимум 120).
- Принимается как `Authorization: Bearer` на tenant-эндпоинтах; платформенные
  маршруты (`/v1/admin/tenants`) отвечают 403. Права не пинуются — конфиг
  читается на каждом запросе.
- **Logout**: `POST /v1/auth/oidc/logout` с Bearer. Сервер добавляет `jti` в
  in-memory deny-list до `exp` и отвечает 204 (даже для неизвестного токена —
  без oracle). Bearer-only ⇒ CSRF не применим (cross-site форма не поставит
  заголовок). Панель вызывает logout при выходе и при переходе на API-ключ, затем
  удаляет токен из `localStorage`.
- **RP-initiated logout** (опционально, §2.5): при наличии
  `end_session_endpoint` панель после локального отзыва запрашивает
  `GET /v1/auth/oidc/logout` и уходит на IdP logout; серверный callback
  проверяет одноразовый `state` и возвращает на дашборд. `id_token_hint` не
  отправляется.
- Ограничение: deny-list и pending logout `state` process-local. В мульти-ноде
  logout должен попасть на все узлы (sticky sessions / общий store — roadmap);
  до этого украденный токен живёт ≤ TTL.

---

## 6. CSRF и токены в URL

- **Login CSRF**: `state` одноразовый и привязан к HttpOnly cookie
  `agil_oidc_binding` (`SameSite=Lax`, `Path=/v1/auth/oidc`, `Max-Age`=TTL) для
  same-origin старта. Callback без cookie → `state_invalid`, state сжигается.
  `AGIL_OIDC_COOKIE_BINDING=0` отключает.
- **returnTo (open-redirect guard)**: относительный путь разрешается против
  `AGIL_PUBLIC_ORIGIN`, и после разрешения требуется точное совпадение
  `origin` (scheme+host+port); абсолютный URL допускается только с origin
  `AGIL_PUBLIC_ORIGIN` или из `integrations.allowedOrigins`. Обратные слэши и
  управляющие символы (`/\evil.example`, `%2F%5C…`, CR/LF/NUL) отклоняются до
  парсинга, credentials и фрагмент запрещены. Иначе `400 validation_failed`, и
  authorization URL не выдаётся — сессия не может уйти на чужой origin.
- **Cross-origin панель** (дашборд на другом хосте, чем API): браузер не
  сохранит `Set-Cookie` с cross-origin ответа без credentialed CORS, поэтому
  привязка автоматически не ставится. State/nonce/PKCE остаются; login-CSRF
  остаётся теоретическим (атакующий может залогинить жертву в свою учётку).
  Рекомендация: отдавать панель с того же origin, что API (или настроить
  credentialed CORS и доработать привязку).
- **`response_mode=form_post`** (опционально): IdP POST-ит `code`/`state`/`error`
  как `application/x-www-form-urlencoded` (≤64 КиБ) на тот же redirect URI;
  сервер принимает `POST /v1/auth/oidc/callback` и проверяет те же state/nonce/
  PKCE/id_token. Для cross-site POST binding-cookie ставится с `SameSite=None`
  (в production добавляется `Secure`), поэтому form_post требует HTTPS в
  реальном браузере; в dev/http cookie браузер может не сохранить. Неверный
  `Content-Type` или переразмеренное тело → `#sso_error=validation_failed`,
  state не сжигается до чтения параметров; привязка/state проверяются как в
  query-режиме. Панель и OpenAPI поддерживают оба режима.
- Токен сессии — только в URL-**фрагменте**; сервер отдаёт 302 с
  `Cache-Control: no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer`.
  Access-токен IdP не сохраняется и не используется. Код авторизации приходит в
  query (требование OAuth), но access-логи пишут только pathname — код, id_token,
  client secret и сессия не попадают в логи/аудит. В аудите только tenant +
  IP-hash + «Dashboard SSO login/logout».
- Панель: meta `referrer=no-referrer`, немедленный `history.replaceState`,
  ограничение длины токена и строгий regex для `#sso_error`, никакого рендера
  токена в DOM. Переразмеренный или битый `#sso_*`-фрагмент тоже стирается из
  адресной строки (даже когда содержимое отклонено).

---

## 7. Пример Keycloak (локально, не в CI)

CI использует герметичный mock IdP (см. §9) — Keycloak не требуется. Для ручной
проверки:

1. Realm `corp`, client `agil-dashboard` (confidential, Standard Flow, PKCE
   S256 обязателен), Valid redirect URI
   `http://localhost:8787/v1/auth/oidc/callback`.
2. Client scopes: `openid`, `profile`, `email`, `groups` (mapper
   `Group Membership` → claim `groups`, full path off, или realm roles → `groups`).
3. Группы `agil-dashboard-admins`, `agil-hosts`, `agil-mods`; пользователь в
   нужных группах.
4. Конфиг тенанта:

```json
{
  "integrations": {
    "identity": {
      "mode": "oidc",
      "issuer": "http://localhost:8080/realms/corp",
      "discovery": false,
      "audience": "agil-calls",
      "jwksUrl": "http://localhost:8080/realms/corp/protocol/openid-connect/certs",
      "authorizationEndpoint": "http://localhost:8080/realms/corp/protocol/openid-connect/auth",
      "tokenEndpoint": "http://localhost:8080/realms/corp/protocol/openid-connect/token",
      "tokenEndpointAuthMethod": "client_secret_post",
      "responseMode": "query",
      "endSessionEndpoint": "http://localhost:8080/realms/corp/protocol/openid-connect/logout",
      "postLogoutRedirectUri": "http://localhost:8787/v1/auth/oidc/logout/callback",
      "clientId": "agil-dashboard",
      "clientSecretEnv": "AGIL_OIDC_CLIENT_SECRET_DEMO_KEYCLOAK",
      "scopes": ["profile", "email"],
      "emailClaim": "email",
      "allowedEmailDomains": ["example.com"],
      "groupsClaim": "groups",
      "groupRoleMap": [
        {"group": "agil-hosts", "role": "host"},
        {"group": "agil-mods", "role": "moderator"}
      ],
      "dashboardAdminGroups": ["agil-dashboard-admins"],
      "tenantClaim": "tenant"
    }
  }
}
```

Вместо четырёх endpoint'ов выше для Keycloak можно оставить только `issuer` +
`discovery:true` (Keycloak публикует метаданные) — `tokenEndpointAuthMethod`
возьмите из `token_endpoint_auth_methods_supported` (Keycloak обычно принимает
`client_secret_post` и `client_secret_basic`).

5. `export AGIL_OIDC_CLIENT_SECRET_DEMO_KEYCLOAK=…` на сервере (не в конфиге!).
6. `GET /v1/auth/oidc/start?tenantId=demo` → открыть `authorizationUrl` в
   браузере того же origin.

`tenantClaim` появится только если в токен добавлен mapper (например, hardcoded
claim `tenant=demo`); без него не включайте проверку.

---

## 8. Диагностика

| Симптом | Причина/действие |
|---|---|
| `501 identity_not_configured` на `/start` | Нет `issuer`/`clientId`/endpoint'ов/JWKS URL или URL отклонён политикой; либо discovery включён, но документ недоступен/не совпал `issuer`/не поддерживает выбранный auth method или response mode. |
| `#sso_error=state_invalid` после IdP | Нет cookie привязки (другой браузер/хост, `AGIL_OIDC_COOKIE_BINDING=0` несоответствие, `form_post` без HTTPS), state истёк/уже использован. |
| `#sso_error=idp_error` | Token endpoint недоступен/вернул ошибку, PKCE mismatch, нет client secret в env. |
| `400 validation_failed` на `/start` | Плохой `returnTo` (чужой origin, обратный слэш/управляющий символ), `clientSecretEnv` вне `AGIL_OIDC_CLIENT_SECRET*` / не привязан к тенанту (§2.2), либо `discoveryUrl`/`endSessionEndpoint` не прошли URL-политику. |
| `#sso_error=validation_failed` на POST callback | Не `application/x-www-form-urlencoded` или тело >64 КиБ (form_post). |
| `501` на `GET /v1/auth/oidc/logout` | Нет `endSessionEndpoint` (и discovery не дал `end_session_endpoint`) — RP logout не настроен, локальный logout работает. |
| `#sso_error=invalid_identity_token` | `iss`/`aud`/`azp`/`exp`/`nonce`/`alg`/`kid`; сверьте часы и JWKS. |
| `#sso_error=identity_not_allowed` | Email/домен вне allowlist, `email_verified:false`, нет `dashboardAdminGroups`. |
| `#sso_error=tenant_mismatch` | `tenantClaim` не совпал с `tenantId`. |
| 401 после входа | Сессия истекла/отозвана (logout), другой `AGIL_TOKEN_SECRET`, перезапуск процесса (deny-list/state в памяти). |
| 503 на verify/join | JWKS/discovery недоступен; смотрите `oidcJwksDiagnostics()`/`oidcDiscoveryDiagnostics()`, негативный кэш 30 c. |

Проверка конфига: `GET /v1/tenants/:id/config`; аудит:
`GET /v1/admin/audit?type=admin.action` (без токенов/PII).

---

## 9. Тесты

Только targeted, без полного monorepo build и браузерных ферм:

```bash
npx tsx --test agil/core/apps/server/test/oidc.test.ts \
  agil/core/apps/server/test/oidc-sso.test.ts \
  agil/core/apps/server/test/oidc-hardening.test.ts \
  agil/core/apps/server/test/oidc-corporate.test.ts
npm run test -w @agil/protocol
npm run test -w @agil/dashboard
npm run typecheck -w @agil/calls-server
npm run typecheck -w @agil/dashboard
```

Что покрыто (герметичный in-process mock IdP + JWKS на 127.0.0.1):

- happy path code+PKCE, state single-use/TTL, nonce, audience/`azp`, issuer,
  `exp/nbf/iat`, `typ`, alg none/HS256, weak RSA, kid rotation/cooldown,
  негативный кэш (`Cache-Control: no-store` отключает TTL), allowlist/домены/
  `email_verified` (явный `false` запрещает и без allowlist), группы→роль,
  tenantClaim, dashboard admin groups, logout/revoke, отсутствие токенов/кода/
  id_token в логах/аудите, cookie-привязка state.
- **discovery** (`oidc-corporate.test.ts`): endpoints только из метаданных,
  путь от `issuer`, caching между start/exchange/JWKS, несовпадение `issuer`
  документа → fail closed (и fallback на явные endpoints), HTTP-ошибка
  discovery → fallback, URL-политика `discoveryUrl` (metadata host → 400),
  неподдерживаемый IdP auth method/response mode → 501.
- **token_endpoint_auth_method**: `client_secret_basic` (HTTP Basic,
  form-urlencoded credentials, секрет не в body), `client_secret_post`
  (по умолчанию), валидация enum при записи конфига; отсутствие секрета в
  логах/логах запросов для обоих методов.
- **RP-initiated logout**: `end_session_endpoint` явный и из discovery,
  `client_id`/`post_logout_redirect_uri`/`state`, отсутствие `id_token_hint`,
  одноразовый state, callback → 302 на дашборд без токена, `501` без endpoint,
  независимость от локального `POST /logout` (revoke 204).
- **response_mode=form_post**: `response_mode` в authorization URL,
  `SameSite=None` binding-cookie, POST callback, ошибки content-type/размера,
  одноразовость state, совместная работа с discovery.
- open-redirect guard: `returnTo` с обратным слэшем (`/\evil.example`,
  `%2F%5C…`), protocol-relative (`//`), `http:\\…`, CR/LF/NUL, credentials и
  чужим origin → `400 validation_failed`; same-origin относительный/абсолютный
  путь по-прежнему принимается. Cookie-привязка сравнивает полный origin
  (scheme+host+port).
- P1/P2: `clientSecretEnv` вне `AGIL_OIDC_CLIENT_SECRET*` или не привязанный к
  тенанту (`AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>` для канонического lower-case
  id / точная запись `AGIL_OIDC_TENANT_SECRETS`) отклоняется при записи конфига и
  при `/start`/обмене кода (token endpoint не вызывается, чужая env-переменная и
  межтенантный секрет не читаются); allowlisted-имя без значения → `501
  identity_not_configured`. Матрица коллизий `a-b`/`a_b`/`a.b`/`A_B` и
  `demo`/`DEMO` проверяется в `packages/protocol/test/oidc-secret-env.test.ts` и
  `apps/server/test/oidc-sso.test.ts`; повторяющийся ключ карты отключает её
  (`apps/server/test/secret-env.test.ts`).
- admin-сессия: non-finite `exp`/`iat` отклоняются.
- панель: `readSsoFragment`/`consumeSsoFragment` (включая переразмеренный и
  битый `#sso_*`), `ssoErrorInfo`, `isSafeAuthorizationUrl`, `ssoReturnTo`,
  `requestLogoutUrl` (501/offline/небезопасный URL → `null`, локальный logout
  не блокируется).
- протокол: новые поля и их defaults/enum (`oidc-corporate-config.test.ts`).
- Не покрыто автоматически: реальный Keycloak/Entra/Okta/ADFS (различия
  claim'ов и discovery-документов), `private_key_jwt`/mTLS, мульти-нода
  state/deny-list, реальный браузер (SameSite=None в form_post, cross-origin),
  IdP, требующий `id_token_hint` для logout.

---

## 10. Известные ограничения / gaps

1. **In-memory** pending login/logout state и deny-list: multi-node требует
   sticky sessions или shared store (Redis) — иначе callback/logout может
   попасть на другой узел.
2. `client_secret_basic`/`client_secret_post` поддержаны; `private_key_jwt` и
   mTLS — нет.
3. `form_post` поддержан, но требует HTTPS в реальном браузере
   (`SameSite=None; Secure`) и POST-callback; dev/http-браузер может не
   сохранить binding-cookie.
4. Cross-origin панель не получает cookie-binding (см. §6); рекомендуется
   same-origin.
5. RP-initiated logout поддержан через `end_session_endpoint` + state, но без
   `id_token_hint`; IdP, требующий hint, не поддержан. `postLogoutRedirectUri`
   должен быть зарегистрирован в IdP.
6. Discovery metadata не подписывается (OIDC Discovery 1.0): доверие к
   документу основано на TLS + точном совпадении `issuer`; скомпрометированный
   IdP-хост может подменить endpoints в рамках своего issuer.
7. JWKS не проверяет DNS-rebinding (базовая URL-политика без resolve);
   production — egress proxy/allowlist.
8. Нет автоматического теста против Keycloak (осознанно: дорого для CI);
   mock IdP покрывает протокол, но не vendor-специфичные claim'ы.
9. Роль панели всегда `admin`; RBAC для нескольких ролей панели не вводится —
   ограничивайте `dashboardAdminGroups`.

---

## 11. Корпоративные поля, которые нужно запросить у заказчика

Для подключения реального корпоративного IdP без внешних credentials в этой
среде нужны (и не могут быть выдуманы):

1. **`issuer`** — точный `iss` из токена/метаданных (например
   `https://sso.example.com/realms/corp`); при discovery = база для
   `/.well-known/openid-configuration`. Регистр/путь должны совпадать
   (допускается только завершающий `/`).
2. **`clientId`** — OAuth client id приложения панели.
3. **`clientSecretEnv`** — *имя* серверной env-переменной с client secret
   (сам секрет задаётся оператором: `AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>` или
   `AGIL_OIDC_TENANT_SECRETS`). Также: поддерживает ли IdP
   `client_secret_post` или требует только `client_secret_basic`.
4. **Redirect URI** — что зарегистрировано в IdP: login
   `<publicOrigin>/v1/auth/oidc/callback` и, для RP logout,
   `<publicOrigin>/v1/auth/oidc/logout/callback` (или иной
   `postLogoutRedirectUri`); для `form_post` — тот же login callback.
5. **`groups`/`tenant` claims** — имя claim'а групп (обычно `groups` или
   `realm_access.roles`), формат (массив/строка) и значения групп для
   `dashboardAdminGroups`/`groupRoleMap`; claim арендатора (`tenantClaim`) и его
   значение, если один issuer/audience обслуживает несколько организаций;
   `email`/`email_verified` claims и требуемый allowlist домена.
6. **MFA policy** — политика MFA/step-up задаётся на стороне IdP; приложению
   нужно знать: (а) гарантирует ли IdP MFA для выбранного client/группы;
   (б) есть ли claim assurance (`acr`/`amr`) и нужно ли его проверять — сейчас
   приложение не проверяет `acr`/`amr`, полагаясь на `email_verified`/
   `verifiedClaim` и `dashboardAdminGroups`; (в) требует ли IdP
   `prompt=login`/`max_age` для повторной аутентификации (не отправляется).
7. Дополнительно: discovery URL, если он нестандартный; `end_session_endpoint`
   и требование `id_token_hint`; поддерживаемые `response_mode` и
   `token_endpoint_auth_methods_supported` (можно получить из discovery);
   максимальный возраст токена и допустимый clock skew.
