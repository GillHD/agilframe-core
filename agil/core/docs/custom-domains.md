# Кастомные домены (white-label, P2 baseline)

Дата: 2026-11-15 · зона: `agil/core/apps/server` + `agil/websdk/demo` · статус: реализовано
(host-resolution + DNS-верификация; TLS/ACME — внешний reverse-proxy).

Один процесс AgilFrame обслуживает несколько организаций. Кастомный домен
позволяет открывать **тот же** landing/`/embed.html`/виджет/API на
`https://meet.acme.com`, при этом сервер по заголовку `Host` определяет тенант
`acme` и отдаёт его `branding`, тему, фичи и CORS/frame-policy. TLS и SNI
терминируются на Caddy/HAProxy: Node-сервер остаётся обычным HTTP-бэкендом.

> В репозитории **нет** изменений общего Caddy/HAProxy. Примеры конфигурации
> ниже — для владельца инфраструктуры; менять общий прокси можно только по
> согласованной процедуре и после теста на отдельном домене.

## 1. Что происходит end-to-end

```
браузер → https://meet.acme.com (Caddy/HAProxy: SNI + ACME-сертификат)
        → http://127.0.0.1:8787  (Host: meet.acme.com сохраняется)
        → DomainRegistry.resolveHost("meet.acme.com") → tenant "acme"
        → статика /, /embed.html, /widget/* + API /v1/* из одного origin
        → GET /v1/host → {tenantId:"acme", branding:{...}}
        → виджет грузит GET /v1/tenants/acme/config и рисует бренд acme
```

Ключевые свойства:

| Свойство | Поведение |
|---|---|
| `Host` → tenant | только **verified** домены; порт/регистр/точка в конце нормализуются |
| Приоритет tenant | `x-api-key` → Bearer join-token → `/v1/tenants/:id/...` в пути → verified `Host` → `AGIL_DEFAULT_TENANT` |
| Неизвестный/битый `Host` | fallback на default tenant, ответы 200 (не 400) |
| Pending-домен | не резолвится, трафик идёт на default tenant, пока DNS не подтверждён |
| Один тенант | максимум один домен; новый домен вытесняет старый (старый host перестаёт резолвиться) |
| Один домен | принадлежит ровно одному тенанту; попытка занять чужой → `409 domain_conflict` |
| Ссылки `joinUrl`/`embedUrl` | если запрос пришёл через verified-домен, ссылки строятся на `https://<домен>`; иначе — `AGIL_PUBLIC_ORIGIN` |
| Анонимное создание комнаты | на кастомном домене без `tenantId` комната создаётся в тенанте этого домена |
| Same-origin | `/`, `/embed.html`, `/widget/`, `/sdk/`, `/v1/*`, `/ws` — один origin; жёстко прописанных `localhost:8787` в клиенте нет |

## 2. Настройка за 6 шагов

### Шаг 1. Публичный origin сервера

```env
AGIL_PUBLIC_ORIGIN=https://calls.example.com
# Необязательно: куда должен указывать CNAME (по умолчанию host из PUBLIC_ORIGIN)
AGIL_DOMAIN_TARGET=calls.example.com
# Таймаут DNS-проверки, мс (250..30000)
AGIL_DOMAIN_DNS_TIMEOUT_MS=5000

# On-demand TLS approval hook (/v1/domain/ask) — только для reverse-proxy.
# AGIL_DOMAIN_ASK_SECRET ОБЯЗАТЕЛЕН: пустой секрет = hook всегда 403 (on-demand
# TLS не работает). Caddy передаёт его в ?key=.
# AGIL_DOMAIN_ASK_SECRET=CHANGE_ME
# AGIL_DOMAIN_ASK_HOSTS — Host, на который отвечает hook (Caddy ask идёт на
# 127.0.0.1; внешний запрос через site-block сохраняет публичный Host и получает
# 403). `*` отключает проверку — только вместе с секретом и path-block.
# AGIL_DOMAIN_ASK_HOSTS=127.0.0.1,localhost,::1
# ACL проверяет TCP-peer сокета, X-Forwarded-For игнорируется. Непустой список
# без валидных IP/CIDR (опечатка, hostname, /33) = 403 и отказ старта, а не «все».
# В Docker запрос от Caddy на хосте приходит с bridge-gateway (172.17.0.1),
# поэтому либо укажите 172.17.0.1/32 (или docker-сеть), либо запускайте
# контейнер с network_mode: host.
# AGIL_DOMAIN_ASK_ALLOW_IPS=127.0.0.1,::1,10.0.0.0/8
# Неверные секреты ограничиваются per-client, успешные ask — per-peer, поэтому
# внешний флуд не исчерпывает лимит Caddy.
# AGIL_DOMAIN_ASK_RATE_LIMIT_PER_MIN=120

# HSTS: max-age и includeSubDomains. Для customer-хостов includeSubDomains
# по умолчанию НЕ выставляется (его нельзя отозвать до истечения max-age).
# AGIL_HSTS_MAX_AGE_SEC=15552000
# AGIL_HSTS_INCLUDE_SUBDOMAINS=1
# AGIL_HSTS_INCLUDE_SUBDOMAINS_CUSTOM=0
```

`AGIL_PUBLIC_ORIGIN` — основной адрес сервера. `AGIL_DOMAIN_TARGET` — цель
CNAME, которую API показывает клиенту и принимает при верификации. Если сервер
за CDN, укажите в `AGIL_DOMAIN_TARGET` имя, на которое реально направлен CNAME.

### Шаг 2. Установить домен (tenant admin key)

```bash
curl -X PUT https://calls.example.com/v1/admin/domain \
  -H "x-api-key: $AGIL_API_KEY" -H 'content-type: application/json' \
  -d '{"domain":"meet.acme.com"}'
```

Ответ — домен в статусе `pending` и инструкции:

```json
{
  "domain": "meet.acme.com",
  "status": "pending",
  "verified": false,
  "verification": {
    "token": "4f1c…32hex…",
    "method": "txt",
    "txt":  { "name": "_agil-calls.meet.acme.com", "value": "agil-verify=4f1c…", "ttl": 300 },
    "cname": { "name": "meet.acme.com", "value": "calls.example.com", "ttl": 300 }
  },
  "dnsInstructions": { "type": "CNAME", "name": "meet.acme.com", "value": "calls.example.com", "ttl": 300 },
  "docsHint": "1) Добавьте TXT… 2) … 3) POST /v1/admin/domain/verify…"
}
```

Домен также сохраняется в `branding.customDomain` (его видно в
`GET /v1/tenants/:id/config`), поэтому старые интеграции продолжают работать.

### Шаг 3. DNS у клиента

Нужны **обе** записи (TXT — доказательство владения, CNAME — маршрутизация):

```dns
; подтверждение владения — ОБЯЗАТЕЛЬНО для первой верификации
_agil-calls.meet.acme.com. 300 IN TXT "agil-verify=4f1c…32hex…"

; маршрутизация трафика
meet.acme.com.             300 IN CNAME calls.example.com.
```

Правило владения (P1, evidence §8.1):

1. **TXT обязателен для первой верификации.** `_agil-calls.<домен>` должен
   содержать `agil-verify=<token>` (или просто `<token>` — для ручной
   настройки). CNAME — публичная информация, поэтому сам по себе он **не**
   доказывает владение: без TXT домен остаётся `pending`.
2. **CNAME — для маршрутизации.** `<домен>` → `AGIL_DOMAIN_TARGET` (точка в
   конце и регистр нормализуются).
3. **CNAME без TXT** принимается только как повторная проверка домена, который
   уже был verified (TXT проверялся при первой верификации). Такой re-check
   сохраняет `verified`, пока CNAME на месте.
4. Если пропали **обе** записи, повторный verify переводит домен в `pending`
   (fail-closed).
5. **У CNAME-only re-check нет срока действия.** Пока `status:"verified"` и
   CNAME указывает на `AGIL_DOMAIN_TARGET`, `verify` сохраняет домен verified
   без TXT неограниченно долго; TTL/периодической TXT-перепроверки в baseline
   нет. Легаси-запись `verified` без `verifiedAt` (из старого `domains.json`)
   тоже считается verified по `status`, а `verifiedAt` проставляется при
   следующем успешном verify. Практическая процедура — §5, «Периодическая
   TXT-перепроверка и передача владения».

Проверка:

```bash
dig +short TXT _agil-calls.meet.acme.com
dig +short CNAME meet.acme.com
# или
nslookup -type=TXT _agil-calls.meet.acme.com
```

Подождите распространения DNS (TTL 300; у некоторых провайдеров до 24 ч).

### Шаг 4. Подтвердить домен

```bash
curl -X POST https://calls.example.com/v1/admin/domain/verify \
  -H "x-api-key: $AGIL_API_KEY"
# → {"domain":"meet.acme.com","status":"verified","verified":true,
#    "verification":{"method":"txt","verifiedAt":1763…}}
```

Пока DNS не готов, ответ — `200` со `status:"pending"` и
`verification.lastError` (это нормальный шаг настройки, не ошибка сервера).
`POST /v1/admin/domain` — алиас verify. Повторная проверка после успеха
пере-верифицирует домен; если пропал TXT, но CNAME на месте, verified
сохраняется (владение уже было доказано); если пропали обе записи, статус
вернётся в `pending` и host перестанет резолвиться (fail-closed).

### Шаг 5. Reverse-proxy: SNI, сертификат, Host

Сервер должен получить **исходный `Host`** (не `127.0.0.1:8787`) и, если он за
доверенным прокси, `X-Forwarded-For`/`X-Forwarded-Proto`. Для этого:

```env
AGIL_TRUST_PROXY=1
```

`AGIL_TRUST_PROXY=1` включает доверие `X-Forwarded-*` (IP, geo, `x-forwarded-host`)
и HSTS-заголовок. Включайте только если прокси действительно ваш.

HSTS (`strict-transport-security`) выставляет Node, когда `AGIL_TRUST_PROXY=1`.
`includeSubDomains` — необратимое на `max-age` обязательство для **всех**
поддоменов, поэтому он выставляется только для платформенного хоста
(`AGIL_PUBLIC_ORIGIN` / `AGIL_DOMAIN_TARGET`). На customer-домене
(`meet.acme.com`) заголовок по умолчанию без `includeSubDomains`; включать его
можно только осознанно через `AGIL_HSTS_INCLUDE_SUBDOMAINS_CUSTOM=1` (и лучше
не включать, если заказчик не контролирует все поддомены). Отключить HSTS
целиком — `AGIL_HSTS_MAX_AGE_SEC=0`; `AGIL_HSTS_INCLUDE_SUBDOMAINS=0` убирает
`includeSubDomains` везде.

#### Caddy (пример, не применять к общему Caddy без теста)

Вариант A — явный site-блок на каждый домен (Caddy сам выпускает сертификат по
ACME, SNI = `meet.acme.com`):

```caddyfile
meet.acme.com {
	encode zstd gzip
	# Публичный путь к on-demand hook'у закрыт (см. Вариант B).
	@agilAsk path /v1/domain/ask
	respond @agilAsk 404
	reverse_proxy 127.0.0.1:8787 {
		header_up Host {host}
		header_up X-Forwarded-Proto {scheme}
	}
}
```

Вариант B — on-demand TLS для произвольных клиентских доменов. Caddy спрашивает
разрешённый ли домен у AGIL перед выпуском сертификата:

```caddyfile
{
	on_demand_tls {
		# 200 = домен подтверждён (verified), 404 = отказ.
		# Секрет ОБЯЗАТЕЛЕН: без него /v1/domain/ask всегда 403, и Caddy
		# не выпустит сертификат. Caddy умеет передавать только URL — ?key=.
		ask http://127.0.0.1:8787/v1/domain/ask?key=[ASK_SECRET]
	}
}

:443 {
	# Публичный путь к hook'у закрыт: внешний запрос через site-block не должен
	# доходить до приложения. Собственный ask Caddy идёт напрямую и не страдает.
	@agilAsk path /v1/domain/ask
	respond @agilAsk 404
	tls {
		on_demand
	}
	reverse_proxy 127.0.0.1:8787 {
		header_up Host {host}
		header_up X-Forwarded-Proto {scheme}
	}
}
```

Если Caddy уже стоит за HAProxy (типовая прод-топология: HAProxy :443 →
Caddy :9443 → Node :8787), этот блок должен слушать `:9443`
(`https://:9443`), а не `:443`, иначе он конфликтует с HAProxy и запрос уйдёт
в пустой `200`. SNI/ACL нового домена добавляется на HAProxy, а сертификат
Caddy выпускает для `https://<домен>:9443`.

`GET /v1/domain/ask?domain=meet.acme.com` возвращает `200
{"allowed":true,"domain":"meet.acme.com"}` только для verified-доменов и `404`
для остальных; `tenantId` намеренно **не** отдаётся.

Caddy проксирует *все* пути (включая `/v1/domain/ask`) на `127.0.0.1:8787`,
поэтому peer-ACL не отличает внутренний ask от внешнего запроса — у них один
TCP-peer. Защита:

- `AGIL_DOMAIN_ASK_SECRET` — **обязателен**. Пустой секрет = hook выключен
  (`403`). Caddy передаёт его в `?key=`; используйте URL-safe значение
  (`[A-Za-z0-9_-]`), иначе кодирование URL сломает сравнение;
- `AGIL_DOMAIN_ASK_HOSTS` — Host hook'а (по умолчанию `127.0.0.1,localhost,::1`).
  Внутренний ask Caddy идёт на `127.0.0.1:8787`; внешний запрос через site-block
  сохраняет публичный Host и получает `403`. Если ask-URL использует другое имя
  (имя контейнера, `host.docker.internal`), добавьте его в список; `*` — только
  вместе с секретом и path-block;
- `AGIL_DOMAIN_ASK_ALLOW_IPS` — TCP-peer сокета (по умолчанию loopback;
  `X-Forwarded-For` игнорируется; непустой список без валидных CIDR → 403/отказ
  старта);
- `AGIL_DOMAIN_ASK_RATE_LIMIT_PER_MIN` — неверные секреты ограничиваются
  per-client, успешные ask — per-peer, поэтому внешний флуд не исчерпывает
  лимит Caddy.

**Обязательно:** `respond /v1/domain/ask 404` в публичном site-block (см.
пример). Server-side секрет/Host/ACL — вторая линия, не замена path-block.

#### HAProxy (пример; только если HAProxy сам терминирует TLS)

Если HAProxy уже стоит перед Caddy (топология стенда: HAProxy :443 → Caddy
:9443 → Node), TLS терминирует Caddy, и HAProxy работает в `mode tcp` с
SNI-ACL — см. `agil/core/docs/pilot/domain-tls.md` §4.0/Вариант C. Пример ниже —
для конфигурации, где HAProxy сам владеет сертификатом и терминирует TLS;
без `mode http` директивы `option forwardfor`/`http-request` молча не работают.

```haproxy
frontend fe_agil
    mode http
    bind *:443 ssl crt-list /etc/haproxy/agil.crtlist alpn h2,http/1.1
    # SNI сохраняется; Host не переписываем
    option forwardfor
    http-request set-header X-Forwarded-Proto https
    timeout client 1m
    timeout server 1m
    timeout tunnel 3600s
    default_backend agil_calls

backend agil_calls
    mode http
    server app 127.0.0.1:8787 check
```

Перед reload: `haproxy -c -f /etc/haproxy/haproxy.cfg`, затем
`systemctl reload haproxy` (без простоя).

`crt-list` — по строке на домен (`meet.acme.com /etc/ssl/meet.acme.com.pem`).
HAProxy не умеет ACME сам: выпускайте сертификаты certbot/acme.sh и
перезагружайте `crt-list` (`echo | openssl s_client ...` для проверки SNI).
Альтернативно — один wildcard-сертификат `*.acme.com`, если домены клиента
всегда поддомены.

### Шаг 6. Проверить

```bash
# host-resolution без изменения DNS (curl --resolve подставляет IP)
curl -s --resolve meet.acme.com:443:203.0.113.10 https://meet.acme.com/v1/host | jq
# → {"host":"meet.acme.com","tenantId":"acme","resolved":"domain",
#    "customDomain":"meet.acme.com","verified":true,"branding":{"productName":"ACME Meet",…}}

# та же проверка локально, минуя TLS
curl -s -H 'Host: meet.acme.com' http://127.0.0.1:8787/v1/host | jq

# приложение и API на одном origin
curl -sI --resolve meet.acme.com:443:203.0.113.10 https://meet.acme.com/embed.html
curl -s  --resolve meet.acme.com:443:203.0.113.10 https://meet.acme.com/v1/health
```

В браузере: `https://meet.acme.com/` → заголовок/логотип тенанта,
`/embed.html?room=<id>` → виджет с брендом тенанта. `?tenant=` в URL остаётся
явным override (например, для alias/CDN).

## 3. API

| Метод | Путь | Auth | Назначение |
|---|---|---|---|
| `GET` | `/v1/admin/domain` | tenant `x-api-key` | текущий домен, статус, token, TXT/CNAME-инструкции |
| `PUT` | `/v1/admin/domain` | tenant `x-api-key` | задать/сменить домен (`{"domain":"…"}`, пустая строка — сброс); статус `pending` |
| `POST` | `/v1/admin/domain/verify` (алиас `POST /v1/admin/domain`) | tenant `x-api-key` | выполнить DNS-проверку, вернуть `pending`/`verified` |
| `DELETE` | `/v1/admin/domain` | tenant `x-api-key` | удалить домен и host-mapping |
| `GET` | `/v1/host` | публично | `Host` → `{tenantId, resolved, customDomain, verified, branding}` |
| `GET` | `/v1/domain/ask?domain=` | только reverse-proxy: обязательный `AGIL_DOMAIN_ASK_SECRET` + Host allowlist + TCP-peer ACL | on-demand TLS approval: 200 только для verified; `tenantId` не отдаётся; 403 без секрета/чужой Host/peer, 429 при превышении rate-limit |

Статусы: `none` (домена нет) → `pending` (DNS ещё не подтверждён) →
`verified`. `verified` — единственный статус, при котором `Host` резолвится в
тенант.

Аудит: `domain.updated` (set/reset), `domain.verified`, `domain.verify_failed`
(без token в сообщении; token — публичная DNS-запись).

## 4. Хранение и multi-node

`AGIL_DATA_DIR/domains.json` (атомарная запись tmp+rename):

```json
{
  "version": 1,
  "domains": {
    "meet.acme.com": {
      "domain": "meet.acme.com", "tenantId": "acme",
      "status": "verified", "token": "4f1c…", "method": "txt",
      "createdAt": 1763000000000, "verifiedAt": 1763000123456,
      "lastCheckedAt": 1763000123456
    }
  }
}
```

При старте сервер импортирует `branding.customDomain` из конфигов тенантов (как
`pending`) и далее слушает все записи конфига. Поэтому домен, выставленный
старым `PATCH /v1/tenants/:id/config`, появляется в реестре, но требует
верификации.

Файл — единственный источник правды для host-mapping. В кластере из нескольких
нод либо используйте общий volume, либо синхронизируйте `domains.json` и
перезапускайте ноды после изменения (hot-reload реестра пока нет). Это
ограничение baseline, а не готовое SaaS-решение.

## 5. Ограничения baseline

- **TLS/ACME — только внешний прокси.** Node не слушает 443, не выпускает
  сертификаты и не читает SNI. Без прокси кастомный домен работать не будет.
- **Нет автоматического recheck по таймеру.** Верификация запускается явным
  `POST …/verify` (или вручную из панели/скрипта). После смены DNS вызовите её
  ещё раз; устаревший verified-домен сам не «протухнет», пока не будет
  пере-верифицирован.
- **Только один домен на тенант** и **один тенант на домен**; wildcard-домены,
  IP-адреса, `localhost` и punycode-кириллица в текущей валидации запрещены
  (используйте `xn--…`).
- **DNS должен быть виден серверу.** Split-horizon/приватный DNS, CDN с
  скрытым CNAME или блокировка исходящего DNS на сервере → verify не пройдёт.
- **CNAME — не доказательство владения.** Первая верификация требует TXT-token;
  иначе любой тенант мог бы «занять» домен, который уже CNAME'ится на
  платформу. CNAME-only — только re-check уже verified-домена.
- **CNAME-only re-check бессрочен, автоматического TXT-recheck нет.** Пока
  `status:"verified"` и CNAME на месте, домен остаётся verified без TXT; сервер
  не отзывает его по возрасту `verifiedAt` и не замечает смену владельца DNS.
  Это осознанный компромисс (TXT мог быть удалён после первой проверки), но
  оператор обязан проводить периодическую проверку вручную — см.
  «Периодическая TXT-перепроверка и передача владения» ниже.
- **Нет автоматического удаления при отзыве DNS.** Fail-closed только при
  повторном verify: если пропали **обе** записи (TXT и CNAME), домен
  переводится в `pending`.
- **Легаси-запись `verified` без `verifiedAt`** (старый `domains.json`) считается
  verified по `status`; CNAME-only recheck её сохраняет, `verifiedAt`
  проставляется при следующем успешном verify. Не редактируйте `domains.json`
  вручную, чтобы «сбросить» такую запись, — используйте `DELETE`/`PUT`.
- **Кэш/CDN.** Прокси/CDN должен сохранять `Host` и учитывать его в ключе кэша
  (`Vary: Host`) либо не кэшировать HTML; `/v1/host` отдаётся с
  `cache-control: no-store`. Иначе пользователь одного тенанта увидит бренд
  другого из общего кэша.
- **DNS TTL** и распространение записей не ускоряются сервером.
- **Host — не аутентификация.** Он выбирает tenant для публичных поверхностей;
  админ-доступ по-прежнему требует `x-api-key` своего тенанта, join — токен.
- **Один процесс/файл.** Горизонтальное масштабирование требует общего
  `AGIL_DATA_DIR` (или внешнего registry) — см. раздел 4.
- **CORS/frame policy** берётся из `integrations.allowedOrigins` тенанта,
  определённого по `Host`; для встраивания добавьте origin родительской страницы
  в конфиг тенанта.
- **WebSocket** (`/ws`) должен проксироваться тем же reverse-proxy; проверьте
  upgrade-заголовки (`Connection: Upgrade`, `Upgrade: websocket`) и таймауты.
  Браузерный `Origin` проверяется по `AGIL_PUBLIC_ORIGIN`, verified-домену
  тенанта, `AGIL_WS_ALLOWED_ORIGINS` и `integrations.allowedOrigins`;
  `Origin: null`/чужие origins отклоняются, non-browser SDK без `Origin`
  допускается только с join-токеном (`AGIL_WS_ORIGIN_ENFORCE=0` — legacy
  escape hatch).
  **Миграция:** пустой `integrations.allowedOrigins` больше не означает «любой
  origin» для WS (CORS/frame при этом пока `*`). Если SDK/headless виджет
  открывает `/ws` с сайта заказчика, добавьте этот origin в allowlist (или `*`)
  до обновления, иначе клиент получит `close 1008`.

### Периодическая TXT-перепроверка и передача владения (P1)

`verify` принимает CNAME-only для уже verified домена **бессрочно**: TTL у
verified-статуса нет, возраст `verifiedAt` на решение не влияет, смену
владельца DNS сервер не замечает. Поэтому оператор обязан:

1. **Плановая проверка** — раз в квартал и при смене DNS-провайдера,
   регистратора или контакта заказчика:
   - `GET /v1/admin/domain` → `status`, `verifiedAt`, `lastCheckedAt`;
   - `dig +short TXT _agil-calls.<домен>` → должен содержать
     `agil-verify=<token>`;
   - если TXT пропал — запросить запись у заказчика; если CNAME тоже больше не
     указывает на платформу, повторный `verify` переведёт домен в `pending`
     (fail-closed).
2. **Передача домена новому владельцу** (продажа, смена юрлица, смена
   подрядчика):
   - прежний тенант: `DELETE /v1/admin/domain` — освобождает домен и
     host-mapping; DNS/прокси/сертификат убирает оператор
     (`pilot/domain-tls.md` §8);
   - новый владелец: свой `PUT /v1/admin/domain` (новый token), TXT нового
     владельца, CNAME, `POST …/verify`;
   - не полагаться на то, что старый verified «сам отвалится»: без `DELETE`
     новый `PUT` получит `409 domain_conflict`, а старый тенант продолжит
     получать трафик.
3. **Строгий режим** (TTL у TXT-подтверждения, обязательный периодический
   TXT-recheck, авто-отзыв при смене владельца) в baseline **не реализован** —
   это продуктовое решение. До его появления шаги 1–2 — операционная
   обязанность, а не автоматика.

## 6. Troubleshooting

| Симптом | Причина / решение |
|---|---|
| `verify` → `pending`, `TXT` пустой | запись ещё не распространилась; `dig +short TXT _agil-calls.<домен>`; подождите TTL. Без TXT первая верификация невозможна |
| `verify` → `pending`, `CNAME` пустой | CNAME указывает не на `AGIL_DOMAIN_TARGET` или proxied через CDN; сравните `dig +short CNAME` |
| `verify` → `pending`, `lastError` про «mandatory for the first verification» | опубликован только CNAME; добавьте TXT `_agil-calls.<домен>` = `agil-verify=<token>` |
| `/v1/host` на домене отдаёт `tenantId:"demo"` | домен не `verified` либо прокси переписал `Host`; проверьте `curl -H 'Host: …' http://127.0.0.1:8787/v1/host` |
| 502/504 от прокси | бэкенд не слушает/недоступен; `curl http://127.0.0.1:8787/v1/health` |
| Сертификат не выпускается (Caddy on-demand) | `/v1/domain/ask?domain=…` вернул 404 (домен не verified), 403 (не задан/неверный `AGIL_DOMAIN_ASK_SECRET`, чужой Host, peer не прокси или allowlist без валидных CIDR) или 429 (rate-limit). Секрет обязателен; публичный путь должен быть закрыт `respond 404` в site-block. `X-Forwarded-For` для ACL не важен |
| `409 domain_conflict` | домен уже закреплён за другим тенантом; сначала `DELETE /v1/admin/domain` у него |
| Виджет показывает чужой бренд | в URL остался `?tenant=…`/старый `tenantId` в localStorage; уберите override |
| `joinUrl` на основном домене | запрос создавался не через кастомный Host (или домен не verified); ссылки строятся от фактического origin |

См. также: `agil/core/docs/api.md` §25, `agil/core/docs/saas.md` §5, `agil/core/docs/deployment.md`
(reverse-proxy/HTTPS), `agil/core/docs/api-exposure.md` (ограничение admin API по IP).
