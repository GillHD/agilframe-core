# SIP/PSTN для AgilFrame (опционально, baseline)

Статус: **baseline control-plane**, по умолчанию **выключен**. Сервер умеет
создавать/останавливать SIP-участника в комнате через LiveKit SIP и показывать
статус; медиа и SIP-сигналинг идут через LiveKit SIP, а не через AgilFrame.
Транки, DID-номера, dispatch rules и PSTN-оператор в этом репозитории **не
разворачиваются** — это внешняя инфраструктура (см. «Требования к транку»).

REST-контракт и примеры — [agil/core/docs/api.md §37](api.md#37-sippstn-телефонный-дозвон-опционально-по-умолчанию-выключено).
UI (кнопка «Позвонить», список телефонов) — следующий этап, в этом baseline его нет.
Локальный стенд без оператора (LiveKit SIP + Asterisk: реальный INVITE/200/ACK,
RTP в обе стороны, DTMF, list/stop, inbound через dispatch rule, trunk-down) —
[`sip-local-lab.md`](sip-local-lab.md).

## 1. Топология

```text
┌──────────────┐   WebRTC    ┌────────────────────┐   SIP/TLS (5061)   ┌──────────────┐
│ браузер /    │◄───────────►│ LiveKit SFU        │◄──────────────────►│ SIP trunk /  │
│ SDK / widget │  audio/video│ + LiveKit SIP      │   RTP/SRTP         │ SBC/оператор │
└──────────────┘             │ (отдельный сервис) │                    └──────┬───────┘
                             └─────────┬──────────┘                           │
                                       │ Twirp HTTP(S)                        │ PSTN
                             ┌─────────▼──────────┐                    ┌──────▼───────┐
                             │ AgilFrame server  │                    │ телефон      │
                             │ control plane:     │                    │ абонента     │
                             │ sip.ts + JWT       │                    └──────────────┘
                             └─────────┬──────────┘
                                       │ audit / API / config
                             ┌─────────▼──────────┐
                             │ Redis (LiveKit)    │  ← room/SIP state, нужен LiveKit SIP
                             └────────────────────┘
```

- **AgilFrame server** (`agil/core/apps/server/src/sip.ts`) — control plane: выпускает
  короткоживущий JWT, вызывает Twirp LiveKit, проверяет права/фичи/лимиты, пишет
  аудит. Медиа через него не идут.
- **LiveKit SFU + LiveKit SIP** — media plane. SIP-сервис регистрирует транк,
  принимает/делает SIP-вызовы и бриджует RTP в комнату LiveKit.
- **SIP trunk / SBC / оператор** — PSTN-плечо: номера, маршрутизация, тарифы,
  запись на стороне оператора (если нужна), регуляторика.
- Комнаты в LiveKit называются `<tenantId>__<roomId>` (`sfuRoomName`), тот же
  формат используют SFU-токены и egress; SIP-участник попадает в эту же комнату.

Сценарий baseline — **исходящий** звонок из комнаты: host/moderator нажимает
«Позвонить», сервер вызывает `CreateSIPParticipant` с номером, LiveKit SIP звонит
через outbound-транк, после ответа абонент слышит комнату как guest-участник.
Входящий сценарий (абонент набирает DID и попадает в комнату) настраивается
dispatch rules в LiveKit; приложение пока не создаёт их через API.

## 2. Конфигурация

### 2.1. Env сервера (секреты — только здесь)

| Переменная | Default | Смысл |
|---|---|---|
| `AGIL_SIP_URL` | — | Twirp base URL LiveKit, `http(s)://host:port` (не `ws://`); **приоритетнее** `scale.sip.httpUrl` |
| `AGIL_SIP_API_KEY` | `AGIL_SFU_API_KEY` | LiveKit API key |
| `AGIL_SIP_API_SECRET` | `AGIL_SFU_API_SECRET` | LiveKit API secret; в ответы/логи не попадает |
| `AGIL_SIP_ENABLED` | `0` | главный выключатель интеграции |

`AGIL_SIP_ENABLED=1` **недостаточно**: нужны URL + ключи, `features.sipDialIn=true`
и `scale.sip.enabled=true`. Если URL/ключи не заданы — `501 sip_not_configured`.
URL берётся из `AGIL_SIP_URL`, а `scale.sip.httpUrl` — только fallback при пустом
env (код: `env.sipUrl || config.scale.sip.httpUrl`). Для LiveKit на localhost/в
приватной сети задавайте `AGIL_SIP_URL` и оставляйте `scale.sip.httpUrl` пустым:
tenant-конфиг проходит SSRF/TLS-политику, поэтому приватный/`http://` URL там
будет отклонён в production-режиме (`NODE_ENV=production` или
`AGIL_TRUST_PROXY=1`), а `AGIL_SIP_URL` — доверенный операторский параметр.

### 2.2. `TenantConfig.scale.sip`

```json
{
  "enabled": false,
  "provider": "livekit-sip",
  "wsUrl": "",
  "httpUrl": "",
  "trunkId": "",
  "dialInNumbers": ["+74951234567"],
  "callerId": "+74950000000",
  "maxConcurrent": 10,
  "maxCallDurationSec": 3600,
  "region": ""
}
```

- `wsUrl` — WebSocket URL LiveKit для будущего UI/клиента (информационно;
  в production-режиме требуется `wss://`, host policy не применяется);
- `httpUrl` — HTTP(S) Twirp endpoint; если пусто, используется `AGIL_SIP_URL`
  (env имеет приоритет, см. 2.1). Проверяется SSRF-политикой **и на
  `PUT /v1/admin/scale`, и на `PATCH/PUT /v1/tenants/:id/config`**: публичный
  HTTPS в проде, без приватных/loopback/link-local/metadata хостов;
- `trunkId` — `ST_…` outbound-транка LiveKit; обязателен при `enabled=true`
  (проверяется в `/v1/admin/scale`);
- `dialInNumbers[]` — опубликованные DID (E.164) для входящих/справочно;
- `callerId` — исходящий From (E.164); пусто = номер транка;
- `maxConcurrent` — максимум одновременных SIP-участников **на комнату**;
  локальный best-effort предохранитель: create-вызовы в одном процессе
  сериализуются по комнате, но между нодами возможен TOCTOU — для жёсткого
  лимита используйте настройки LiveKit/оператора;
- `maxCallDurationSec` — жёсткий предел одного звонка (60…86400, по умолчанию
  3600); уходит в Twirp как `max_call_duration: "3600s"`, `ringing_timeout: "60s"`;
- `region` — метка региона/площадки для операторов.

#### Привязка шлюза к узлу

В редакторе откройте «Масштабирование» → «SIP» и укажите **ID узла SIP**. Через API то же поле доступно как `scale.sip.nodeId`. Укажите ID из реестра своей организации. Пустое значение снимает привязку.

Если привязка задана, Core отправляет новый исходящий вызов только при наличии работающего `sip` в `availableModules` узла. При недоступности вызов получает `503 sip_node_unavailable`, а `GET /v1/admin/sip/status` возвращает `nodeAvailable: false`. Список участников и завершение существующего вызова остаются доступны через LiveKit. Привязка действует на уровне организации, включая комнаты с собственными настройками SIP. Входящие вызовы по DID по-прежнему обслуживаются правилами LiveKit и SIP-транком.

В панели откройте «Интеграции» → «Телефония SIP». Карточка показывает, заданы ли подключение к LiveKit и исходящий транк, доступен ли привязанный узел и сколько SIP-участников Core видит в комнатах. После восстановления модуля нажмите «Обновить статус SIP». Для проверки передачи звука выполните тестовый звонок по инструкции ниже.

Patch — deep-partial (как весь `TenantConfig`), включая `scale.sip`: можно
отправить только `{enabled, trunkId}`, остальные поля сохранят текущие значения
или дефолты. `PATCH /v1/tenants/:id/config` и `PUT /v1/admin/scale` применяют
URL/TLS-валидацию; `PUT /v1/admin/scale` дополнительно проверяет trunk/E.164.
Полный `PUT /v1/tenants/:id/config` без `scale.sip` тоже принимается: отсутствующий
объект `scale.sip` заполняется дефолтами, а сохранённые legacy-настройки тенанта
(например `features.chat=false`) не теряются при загрузке старого файла конфига.
Пример включения — [agil/core/docs/api.md §37](api.md#37-sippstn-телефонный-дозвон-опционально-по-умолчанию-выключено).

## 3. Требования к транку и LiveKit SIP

Ничего из этого не создаётся кодом приложения; это чек-лист для DevOps/оператора.

### 3.1. LiveKit SIP service

- Отдельный сервис `livekit/sip` (или managed LiveKit Cloud SIP), тот же
  Redis/API key/secret, что у SFU; SFU и SIP должны видеть комнаты.
- `AGIL_SIP_URL` указывает на HTTP(S) Twirp API LiveKit (обычно `:7880`).
- Порты: SIP 5060/5061 (UDP/TCP/TLS), RTP LiveKit SIP — **10000–20000/UDP** по
  умолчанию (настраивается в конфиге SIP-сервиса); это не WebRTC media-диапазон
  LiveKit (50000–60000/UDP), который открывается отдельно для SFU. Исходящий
  HTTPS к оператору; NAT/публичный IP, если оператор требует.
- Регион/латентность: SIP-сервис ближе к оператору; PSTN-задержка + WebRTC
  бюджет ≤ 300 мс в одну сторону — иначе эхо/перебивание.
- Кодеки: G.711 A-law/µ-law и G.722 обязательны, Opus — желателен; LiveKit SIP
  транскодирует при необходимости (это нагрузка на CPU).
- DTMF: RFC 2833/4733; факс/T.38 не поддерживается baseline.

### 3.2. Outbound trunk (звонки из комнаты)

- Termination URI/SBC оператора, транспорт TLS (5061) предпочтительно; SRTP
  обязателен, если оператор его поддерживает, иначе RTP только в доверенной сети.
- Аутентификация: IP-allowlist SIP-сервиса и/или digest username/password в
  настройках транка (не в AGIL-конфиге).
- From/caller ID: номер, выделенный оператором, в E.164; `callerId` в конфиге
  перекрывает дефолт транка. Оператор должен разрешать этот From (STIR/SHAKEN,
  верификация номера).
- Разрешённые направления/регионы и лимиты каналов — на стороне оператора;
  `maxConcurrent` в AGIL — только локальный предохранитель на комнату, а
  `maxCallDurationSec` ограничивает длительность звонка.
- Разрешить исходящие на номера экстренных служб **нельзя** (см. ограничения).

### 3.3. Inbound trunk + dispatch rules (для входящих DID)

- Inbound-транк с DID-номерами из `scale.sip.dialInNumbers`.
- Dispatch rule: DID → комната (например, pin/room prefix) или IVR; правило
  создаётся в LiveKit, не в AgilFrame.
- Политика «кто может входить по телефону» (pin, allowlist, время) — на стороне
  LiveKit/оператора; приложение увидит SIP-участника как guest и не различит
  «свой»/«чужой» DID без дополнительных атрибутов.

### 3.4. Номера и регуляторика

- E.164 (`+<country><number>`), без пробелов/скобок; `dialInNumbers` и `callerId`
  валидируются.
- Локальные требования (лицензия оператора, запись разговоров, уведомление
  участников, хранение метаданных) — на стороне компании/оператора.
- Экстренные вызовы (112/911) через этот baseline **запрещены**: нет определения
  местоположения, маршрутизации и SLA.

## 4. Безопасность

- **Секреты только в env.** В `TenantConfig` нет API key/secret; URL шлюза не
  отдаётся. `/v1/admin/sip/status` возвращает только флаги и `numbers` —
  опубликованные DID из конфига тенанта (не набранные номера и не PII звонка);
  `/v1/admin/sip/test` — флаги/латентность.
- **JWT по операции.** HS256, `exp = now + 120 c`, `nbf = now − 5 c` (окно
  ≤125 c), `iss` = API key, `sub` = `agil-sip-controller`; create —
  `video:{room,roomJoin}` + `sip:{call}`; list/remove — `video:{room,roomAdmin}`;
  live-тест — `video:{roomList}`. Токен не логируется и не отдаётся клиенту.
- **Права.** Dial-in: host/moderator join-токен **или** admin key, обязательно
  `features.sipDialIn` + `scale.sip.enabled`. Гость получает 403. Stop/list —
  те же права, feature-флаг не блокирует cleanup; **cleanup readiness** требует
  только URL/ключи шлюза, поэтому list/stop работают и при
  `AGIL_SIP_ENABLED=0`, и при пустом/удалённом `trunkId`. Tenant isolation:
  комната проверяется по tenant ключа/токена (403 на чужую).
- **E2EE.** При `security.e2ee=true` SIP невозможен: шлюз не расшифрует медиа →
  `409 e2ee_incompatible` (как egress). Не включайте E2EE и PSTN одновременно.
- **Телефонные номера / PII.** Номер не сохраняется в реестре комнат, не
  возвращается в ответах, не пишется в аудит/логи. В Twirp уходит
  `hide_phone_number:true`, чтобы LiveKit не подставил номер в identity/name/
  attributes; identity — случайный `sip_<hex>`, имя — `name` или `SIP guest`.
  Если LiveKit всё же синтезировал имя/identity из номера (входящий вызов),
  номер маскируется и в `identity`, и внутри `name` (`Phone +7••••••••67`).
  В аудите `numberMasked` (`+7••••••••67`). `POST …/sip/:id/stop` отклоняет
  digits-only/phone-like id (`400 validation_failed`) и пишет в аудит только
  маскированное значение; raw URL/телефон не попадают в request-логи. Ошибки
  шлюза перед возвратом/аудитом очищаются от телефонов, URL, bearer/токенов и
  email (`scrubSensitiveText`).
- **Rate limit / concurrency.** Dial-in — 10 попыток/мин на tenant+room+IP
  (429); list — 30/мин, stop — 10/мин на ту же пару (429). Phone-like
  `participantId` в stop расходует stop-лимитер **до** аудита: первые 10 попыток
  отклоняются 400 с маскированным аудитом, дальнейшие — 429 без новых записей
  (в request-логах phone-like сегмент пути маскируется). `maxConcurrent` на
  комнату (409 `sip_limit_reached`) сериализует create в одном процессе; между
  нодами остаётся best-effort TOCTOU, жёсткий лимит — на стороне LiveKit.
  `maxCallDurationSec` и `ringing_timeout=60s` ограничивают стоимость звонка.
- **SSRF.** `scale.sip.httpUrl` — серверный outbound-вызов; проверяется
  `validateScale`/`validateConfigEndpoints` на `PUT /v1/admin/scale`, на
  `PATCH/PUT /v1/tenants/:id/config` **и в per-room `configOverrides`** при
  создании комнаты (`POST /v1/rooms` и `/v1/admin/rooms`, включая анонимное
  создание): схема, TLS в проде, host policy: приватные, loopback, link-local и
  metadata-хосты отклоняются до создания комнаты. `scale.sip.wsUrl`
  проверяется на схему/TLS. Env `AGIL_SIP_URL` — доверенный операторский
  параметр, как `AGIL_EGRESS_URL`; не принимайте его из пользовательского ввода.
- **Аудит.** `sip.dialin.started` / `sip.dialin.stopped` / `sip.dialin.failed`;
  в `details` — identity (маскированная при phone-like), `action` (`start`/
  `stop`), `numberMasked` для старта, `error` без номера/URL/токена; имя
  участника не пишется. IP хранится только как `ipHash`.
- **Отказоустойчивость.** Ошибки Twirp → `502 sip_failed` с очищенным текстом
  (URL/токены/номера не утекают), шлюз не блокирует остальной сервер; таймаут
  10 с; `live`-тест — только чтение (`ListRooms`).
- **Медиа.** SIP — аудио-only; видео PSTN не поддерживает. Запись SIP-разговора
  в baseline не включена: включайте запись на стороне оператора/SBC с
  уведомлением сторон.

## 5. Ограничения baseline (честно)

- Только **outbound**-создание звонка из комнаты; входящие DID обрабатываются
  dispatch rules LiveKit, приложение не управляет ими и не знает, какой DID
  позвонил.
- Нет CRUD транков/dispatch rules, нет выбора транка per-room (один `trunkId` на
  тенант), нет failover между операторами/регионами.
- Нет transfer, hold, DTMF-UI, IVR, voicemail, записи/транскрипции SIP-плеча,
  вебхуков статуса вызова, биллинга минут PSTN и UI в виджете/панели.
  DTMF можно передать при дозвоне (`dtmf` в `POST …/sip/dial-in`, цифры не
  логируются/не аудируются) — этого достаточно для IVR-расширения и
  локального DTMF-теста.
- `active` в статусе — best-effort: максимум 50 комнат тенанта; при ошибке
  `ListParticipants` используется локальный счётчик созданных этим процессом
  identity, поэтому значение может быть завышено/устаревшим. Это не биллинговый
  счётчик.
- `Live`-тест проверяет только доступность Twirp (`ListRooms`), а не реальный
  вызов и не качество PSTN.
- Один шлюз/один регион на тенант; нет мультирегионального резервирования.
- SIP-участники видны в LiveKit-комнате, но не в in-memory реестре комнат AGIL:
  списки участников панели/чата их не включают (отдельный этап).
- Если SIP-участник создан в обход API (например, входящий DID), его identity
  может быть телефоном: в списке она маскируется, а `id` становится opaque
  participant id LiveKit (`PA_…`) — по нему `…/sip/:id/stop` корректно снимает
  вызов, не принимая номер в URL/аудит; phone-like id по-прежнему отклоняется.
- Cleanup (`GET …/sip`, `POST …/sip/:id/stop`) доступен и при выключенной
  интеграции/пустом транке, но всё равно требует URL и ключи шлюза.
- Экстренные вызовы, факс/T.38, видео и E2EE не поддерживаются.

### Перевод на телефон или корпоративную АТС (проект)

- **«Пригласить по телефону»** — браузерная встреча продолжается. LiveKit
  добавляет абонента как аудиоучастника через `CreateSIPParticipant` и
  исходящий транк. Серверный вызов уже есть в baseline.
- **«Перевести на АТС»** — действующий SIP-абонент переводится из комнаты на
  внутренний номер, очередь поддержки или внешний номер. LiveKit вызывает
  `TransferSIPParticipant`, который отправляет `SIP REFER`. Транк и АТС
  должны поддерживать перевод. После подтверждённого перевода этот абонент
  покидает комнату, остальные продолжают встречу. Дальнейший разговор идёт
  через АТС или оператора, вне записей и транскрипции комнаты AGIL.
  [Перевод вызовов в LiveKit](https://docs.livekit.io/telephony/features/transfers/cold/)
- Для участника из браузера сценарий продолжения разговора на телефоне
  требует отдельного исходящего аудиовызова и подтверждения перехода после
  ответа. Видео и экран остаются в браузере.

Для первого выпуска использовать именованные направления из панели
организации, например «Поддержка» или «Дежурный». Core проверяет доступ
к комнате, права пользователя и разрешённое направление. Выводить статус
попытки и писать в аудит результат с маскировкой номера. При таймауте с
неизвестным исходом обновить состояние перед повторной попыткой. Если
перевод запускает MCP-клиент, действуют те же права пользователя и
ограничения токена. Пользователь подтверждает направление перед вызовом.

Проверить на локальном стенде Asterisk успешный перевод, занятую линию,
отказ, таймаут, повтор запроса и сохранение встречи для остальных. Для
внешних номеров отдельно проверить поддержку перевода у выбранного оператора.

## 6. Тесты и проверка

```bash
# контракт protocol (scale.sip defaults/deep-partial/E.164)
npm run test -w @agil/protocol

# только SIP-тесты сервера (mock Twirp, без реального транка)
cd agil/core/apps/server && npx tsx --test "test/sip.test.ts"

# весь сервер + typecheck + сборка
npm run test -w @agil/calls-server
npm run typecheck -w @agil/calls-server
npm run build -w @agil/protocol && npm run build -w @agil/calls-server

# OpenAPI артефакты (после правок схемы)
npm run openapi -w @agil/calls-server

# живая проверка (нужен развёрнутый LiveKit SIP и транк)
curl -s http://localhost:8787/v1/admin/sip/status -H 'x-api-key: dev-key'
curl -X POST http://localhost:8787/v1/admin/sip/test -H 'x-api-key: dev-key' \
  -H 'content-type: application/json' -d '{"mode":"live"}'

# статический контракт локального стенда (без Docker) + приложение к нему
npm run test:sip-lab
```

Mock Twirp в тестах:
`test/sip.test.ts` поднимает HTTP-сервер с `CreateSIPParticipant`,
`ListParticipants`, `RemoveParticipant`, `ListRooms`, проверяет тело запроса,
JWT-гранты, маскирование, аудит и изоляцию тенантов. Реальные звонки/номера в
CI не используются.

## 7. Чек-лист включения

1. Развернуть LiveKit SIP (Redis, API key/secret, HTTP(S) Twirp, RTP-порты).
2. Создать outbound-транк у оператора; проверить From/caller ID и кодек G.711.
3. Задать `AGIL_SIP_URL`, `AGIL_SIP_API_KEY`, `AGIL_SIP_API_SECRET`,
   `AGIL_SIP_ENABLED=1`; перезапустить сервер.
4. В конфиге тенанта: `features.sipDialIn=true`, `scale.sip.enabled=true`,
   `trunkId`, `callerId`, `dialInNumbers`, `maxConcurrent`. Достаточно
   deep-partial PATCH `{"scale":{"sip":{"enabled":true,"trunkId":"ST_…"}}}`;
   остальные поля сохранят текущие значения/дефолты.
5. `POST /v1/admin/sip/test {"mode":"mock"}` → `ok:true`; затем `live`.
6. Позвонить на тестовый номер из host-токена; проверить звук в обе стороны,
   `GET /v1/rooms/:id/sip`, `stop`, аудит `sip.dialin.*`.
7. Настроить алерты на `sip.dialin.failed`/502 и лимиты оператора; отключить
   E2EE для комнат с PSTN.
