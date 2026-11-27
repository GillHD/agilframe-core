# Локальный SIP/PSTN-стенд: LiveKit SIP + Asterisk

> **Дата:** 16.11.2026 · **Статус:** реализовано и **прогнано локально** на
> WSL2 Ubuntu 20.04 + Docker Engine 26.1.3 (host networking), 57 проверок
> пройдено · **Прод/реальный транк:** не выполнялись, внешний оператор не
> подключался · **Секреты:** только lab-значения (`devkey`/lab-secret/AMI-lab),
> реальных секретов и аккаунтов оператора в репозитории нет
>
> Связанные документы: [`sip.md`](sip.md) (control-plane приложения),
> [`api.md` §37](api.md#37-sippstn-телефонный-дозвон-опционально-по-умолчанию-выключено)
> (REST-контракт), `qa-sip.md` (baseline-отчёт без живого транка).
>
> **Что это:** полностью локальная замена оператору: LiveKit SIP + один
> Asterisk-контейнер, который играет роль и «транка» (PSTN-плечо), и «телефона».
> Ни DID, ни оплачиваемого PSTN-трафика, ни внешней сети — все вызовы остаются
> на хосте/WSL2.

## 0. TL;DR

| Что | Где |
|---|---|
| Стенд | [`agil/core/deploy/sip/docker-compose.yml`](../deploy/sip/docker-compose.yml) (redis, livekit, sip, asterisk; host networking) |
| Конфиги LiveKit | `livekit.yaml` (SFU) и `SIP_CONFIG_BODY` в compose (SIP worker) |
| Asterisk | [`asterisk/`](../deploy/sip/asterisk/): `pjsip.conf`, `extensions.conf`, `rtp.conf`, `manager.conf`, `logger.conf`, `modules.conf` |
| Медиа-доказательство | `recordings/*.wav` + анализ RMS/доминирующей частоты: leg A шлёт **440 Гц**, leg B — **880 Гц**; каждый получает тон другого |
| Скрипты | `scripts/gen-tones.mjs`, `scripts/lab-init.mjs`, `scripts/lab-up.sh`, `scripts/lab-down.sh`, `scripts/e2e.mjs` |
| Запуск | `cp .env.example .env` → `./scripts/lab-up.sh` → `node scripts/lab-init.mjs` → приложение с `AGIL_SIP_*` → `node scripts/e2e.mjs` |
| Проверки | RTP в обе стороны, DTMF, list/stop, inbound (dispatch rule), trunk-down `502`, E2EE `409` |
| CI-гейт без Docker | `npm run test:sip-lab` (`node --test agil/core/scripts/test/sip-local-lab.test.mjs`) |
| Ограничения | Linux/WSL2 с host networking, G.711/PCMU/PCMA, статический транк. Базовый режим использует UDP. Проверка реального PSTN описана в §8–§9 |

**Жёсткое правило:** это **не** production-развёртывание и **не** замена
проверке с реальным оператором. Стенд доказывает, что приложение корректно
управляет LiveKit SIP, а медиа/DTMF реально ходят через SFU; PSTN-плечо
(оператор, DID, TLS/SRTP, STIR/SHAKEN, экстренные вызовы) остаётся внешним.

## 1. Что доказывает стенд — и чего не доказывает

Доказывается (реально прогнано, см. §7):

- приложение создаёт SIP-участника через LiveKit Twirp и **реальный INVITE**
  уходит на SIP-плечо (Asterisk) → `200 OK` → `ACK`;
- **RTP идёт в обе стороны** через LiveKit SFU: тон 440 Гц от leg A слышен
  leg B, тон 880 Гц от leg B слышен leg A (проверено по записям Asterisk);
- **DTMF** доходит от LiveKit SIP до Asterisk (Asterisk `Read` собирает цифры
  и пишет их в `recordings/dtmf.log`);
- `GET …/sip` и `POST …/sip/:id/stop` реально снимают участников, комната
  LiveKit очищается;
- **входящий** сценарий (Asterisk звонит на inbound-транк LiveKit) работает:
  dispatch rule кладёт вызов в комнату приложения, аудио слышно;
- сломанный/несуществующий транк и остановленный SIP-worker дают
  `502 sip_failed` без утечки номера/URL;
- E2EE-комната отдаёт `409 e2ee_incompatible`.

Не доказывается (см. §9 «Blocked»):

- реальный оператор/DID, TLS/SRTP с оператором, digest-auth, STIR/SHAKEN, биллинг;
- качество PSTN (джиттер/потери на реальной сети), G.722/Opus-транскодинг,
  факс/T.38, перевод/удержание, экстренные вызовы;
- multi-node SIP, отказоустойчивость оператора, лицензии/регуляторика.

## 2. Топология и порты

```text
┌──────────────────────────┐        Twirp HTTP (:7880)       ┌──────────────────────────┐
│ AgilFrame server        │ ──────────────────────────────► │ LiveKit SFU v1.13.11     │
│ (control plane, app)     │ ◄────────────────────────────── │ + Redis :6385            │
└──────────────────────────┘                                 └────────────┬─────────────┘
                                                                          │ RTC/WebRTC (audio)
                                                              ┌───────────▼─────────────┐
                                                              │ LiveKit SIP v1.24       │
                                                              │ SIP :5070, RTP 10000-10100 │
                                                              └───────┬──────────┬──────┘
                                                       outbound INVITE│          │inbound INVITE
                                                                      ▼          ▲
                                                              ┌──────────────────────────┐
                                                              │ Asterisk 20 (lab trunk  │
                                                              │ + lab "phone")          │
                                                              │ PJSIP :5060, RTP 16000-16100 │
                                                              │ AMI :5038 (127.0.0.1)   │
                                                              └──────────────────────────┘
```

| Порт | Протокол | Кто | Назначение |
|---|---|---|---|
| 7880 | TCP | LiveKit SFU | HTTP/WS + Twirp (`AGIL_SIP_URL`) |
| 7881 | TCP | LiveKit SFU | RTC/TCP fallback |
| 50100-50200 | UDP | LiveKit SFU | WebRTC media (в аудио-лабе не нужен) |
| 5070 | UDP/TCP | LiveKit SIP | SIP-сигналинг (Asterisk ходит сюда) |
| 28083 | TCP | LiveKit SIP | HTTP-проверка процесса воркера на тестовом хосте |
| 10000-10100 | UDP | LiveKit SIP | RTP SIP-плеча |
| 5060 | UDP | Asterisk | PJSIP (LiveKit outbound trunk ходит сюда) |
| 16000-16100 | UDP | Asterisk | RTP Asterisk |
| 5038 | TCP | Asterisk | AMI, bind 127.0.0.1 (только lab-скрипты) |
| 6385 | TCP | Redis | состояние комнат/диспетчеризации |

Диапазоны намеренно не пересекаются: по `recordings` и SDP видно, где чей порт.

## 3. Требования

- **Linux или WSL2-дистрибутив с Docker Engine** (host networking). Docker
  Desktop для Windows не подходит: `network_mode: host` там не даёт нужного
  сетевого поведения для SIP/RTP.
- Docker 26+, Compose v2.20+, Node.js ≥ 20 (скрипты и приложение).
- Свободные порты из таблицы выше; для WSL2 — доступ к Docker Hub (или
  корпоративному registry mirror).
- Запущенное приложение AgilFrame с `AGIL_SIP_ENABLED=1`, `AGIL_SIP_URL`,
  `AGIL_SIP_API_KEY`, `AGIL_SIP_API_SECRET` (ключи те же, что у LiveKit).

## 4. Быстрый старт

```bash
cd agil/core/deploy/sip
cp .env.example .env          # lab-ключи, не production-секреты

./scripts/lab-up.sh           # docker compose up -d + ожидание Redis, LiveKit, SIP и Asterisk
node scripts/lab-init.mjs     # создаёт outbound/inbound транки, печатает ST_…

# в другом терминале — приложение с теми же ключами:
cd agil/core/apps/server
AGIL_SIP_ENABLED=1 \
AGIL_SIP_URL=http://127.0.0.1:7880 \
AGIL_SIP_API_KEY=devkey \
AGIL_SIP_API_SECRET=agil-sip-lab-secret-0123456789abcdef \
npm start

# проверки стенда (создаёт комнату, звонит, слушает, останавливает):
cd agil/core/deploy/sip
node scripts/e2e.mjs
```

`lab-up.sh` проверяет ответы LiveKit и SIP-воркера по отдельности. Если
`http://127.0.0.1:7880/` отвечает, а `http://127.0.0.1:28083/` недоступен,
проверьте `docker compose logs sip`. Порт 28083 предназначен для проверки
на тестовом хосте. Для проверки транка и прохождения аудио запустите `e2e.mjs`.

`lab-up.sh` сам вызывает `gen-tones.mjs`: образ `andrius/asterisk` **не содержит
звуковых файлов**, поэтому стенд генерирует три тональных WAV и монтирует их в
`/var/lib/asterisk/sounds/en`. Без них `Playback()` молча ничего не играет и
RTP-проверка становится бессмысленной.

Остановка:

```bash
./scripts/lab-down.sh          # контейнеры; записи остаются
./scripts/lab-down.sh --clean  # + удалить recordings/ и logs/
```

### Исходящий звонок с TLS и SRTP

Подготовьте отдельную копию стенда. В Asterisk добавьте PJSIP-транспорт
`protocol=tls`, `bind=127.0.0.1:5061`, `method=tlsv1_2` и укажите
`cert_file` и `priv_key_file`. На endpoint `agil-livekit` выберите этот
транспорт, `media_encryption=sdes` и `media_encryption_optimistic=no`.
В контейнерах тестового стенда сертификат и ключ монтируются только для
чтения. Создайте ключ в файловой системе Linux, выдайте владельцу процесса
Asterisk право чтения (`0600`) и добавьте `127.0.0.1` как IP SAN сертификата.
В прогоне Asterisk работал с UID 1000. При ошибке чтения ключа проверьте
`docker compose exec asterisk asterisk -rx 'pjsip show transports'` и логи.
[Параметры PJSIP Asterisk 20.7](https://docs.asterisk.org/Certified-Asterisk_20.7_Documentation/API_Documentation/Module_Configuration/res_pjsip/).

Настройте Worker LiveKit SIP на доверие к тестовому сертификату через
`SSL_CERT_FILE`. В проверенной копии `SIP_CONFIG_BODY` также содержал
`tls.port: 5071` и пару `cert_file` / `key_file` в `tls.certs`. После
старта дождитесь TLS-рукопожатия на 5061 с проверкой IP SAN через
`openssl s_client -connect 127.0.0.1:5061 -verify_ip 127.0.0.1 -verify_return_error -CAfile /path/to/cert.pem`.
Затем включите `pjsip set logger on` в CLI Asterisk. Запустите проверку
с ключами этой копии и адресом локального Core.

```bash
LAB_SIP_OUTBOUND_TLS=1 \
LAB_RECORDINGS_DIR=/path/to/copy/recordings \
LAB_ASTERISK_LOG=/path/to/copy/logs/asterisk/full \
node scripts/e2e.mjs --only=rtp,dtmf
```

В этом режиме скрипт создаёт исходящий транк к `127.0.0.1:5061` с
обязательным SRTP, проверяет TLS и `RTP/SAVP` по журналу и сравнивает
частоты тонов, полученных обоими участниками. Полный SIP-трейс может
содержать данные сеанса. Для отчёта используйте итоговые признаки и счётчики.
[Настройки защищённого транка LiveKit](https://docs.livekit.io/telephony/features/secure-trunking/).

### Входящий звонок с TLS и SRTP

В той же копии стенда настройте `agil-sip-out` на TLS-транспорт с
`verify_server=yes`, доверенным тестовым сертификатом в `ca_list_file`
и обязательным `media_encryption=sdes`. Укажите контакт
`contact=sip:127.0.0.1:5071\;transport=tls` в `pjsip.conf`. Обратная косая
черта сохраняет `;transport=tls` как часть URI при разборе конфига Asterisk.
URI `sips:` заставляет Asterisk требовать такой же URI в ответе, а LiveKit
SIP v1.24 возвращает контакт `sip:` с транспортом TLS.

На одном хосте `media_nat_1_to_1_ip: '127.0.0.1'` задаёт адрес медиа в SDP.
Этот адрес относится к тестовому стенду, где Asterisk и SIP-воркер работают
на одном хосте. Для подключения к внешнему SBC укажите адрес, доступный SBC.

Запустите `node scripts/e2e.mjs --only=inbound` с `LAB_SIP_INBOUND_TLS=1`,
`LAB_SIP_OUTBOUND_TLS=1` и теми же путями к записям и журналу. Скрипт
создаёт временный входящий транк с обязательным SRTP, проверяет попадание
в нужную комнату, тон 880 Гц, завершение участника и TLS/SRTP в трассе.
[Выбор транспорта PJSIP](https://docs.asterisk.org/Configuration/Channel-Drivers/SIP/Configuring-res_pjsip/PJSIP-Transport-Selection/).

### Ротация SIP Digest на тестовом транке

Запустите сценарий в отдельной Linux QA VM с Node.js 20 или новее и локальным
Docker Compose v2. Нужны четыре образа из `docker-compose.yml` этого стенда.
Сценарий создаёт отдельный Compose-проект и использует свои порты. Номера
синтетические, а пароли и контрольные тоны генерируются при запуске.

```bash
node agil/core/deploy/sip/scripts/digest-rotation-e2e.mjs
```

Если в VM доступ к локальному Docker настроен через `sudo -n`, добавьте
`AGIL_QA_SUDO_DOCKER=1` перед командой. Сценарий проверяет два SIP-плеча между
Asterisk и LiveKit SIP в одной комнате. До и после ротации встречные записи RTP
содержат тоны 880 и 440 Гц. После смены данных отдельно проверяются отказы
старых пар со стороны Asterisk и LiveKit SIP. Сценарий сопоставляет ответ с
тем же SIP `Call-ID` и номером последовательности авторизованного `INVITE`.
Проверка использует G.711 по UDP и тестовый SBC. Для внешнего оператора,
совместного применения Digest и TLS/SRTP и непрерывной ротации во время
активного звонка нужны отдельные прогоны. [LiveKit SIP API](https://docs.livekit.io/reference/telephony/sip-api/).

### Ротация ключа LiveKit для SIP-воркера

В той же Linux QA VM запустите отдельный режим сценария.

```bash
node agil/core/deploy/sip/scripts/digest-rotation-e2e.mjs --rotate-worker-key
```

Режим оставляет пароли Digest и настройки обоих транков прежними. На этапе
перекрытия SFU принимает обе пары ключей, а SIP-воркер пересоздаётся с новой.
Затем SFU перезапускается с новой парой воркера и прежней парой оператора.
Старая пара воркера получает `HTTP 401` при вызове `RoomService.ListRooms`.
Тест проверяет новый двусторонний RTP после отзыва и сохранение контейнеров
Redis и обновлённого SIP-воркера. Вызовы завершаются перед каждым этапом
перезапуска SFU.

## 5. Как устроено

### 5.1. Compose

Четыре сервиса на host networking:

- `redis` — `redis-server --port 6385` (не пересекается с реальным 6379);
- `livekit` — `livekit/livekit-server:v1.13.11`, ключи через `LIVEKIT_KEYS`
  (в YAML секретов нет), `rtc.port_range 50100-50200`;
- `sip` — `livekit/sip:v1.24`, конфиг через `SIP_CONFIG_BODY`
  (`sip_port: 5070`, `rtp_port: 10000-10100`, `use_external_ip: false`,
  только PCMU/PCMA);
- `asterisk` — `andrius/asterisk:20.7-cert12_debian-trixie` с шестью
  конфигами, тонами, `recordings/` и `logs/asterisk/`.

Healthcheck’и: `redis-cli ping`, `/livekit-server --help`, `asterisk -rx 'core
show uptime'`. Логи ограничены (`json-file`, 10 MB × 3).

### 5.2. Asterisk

- `pjsip.conf`: транспорт UDP `0.0.0.0:5060`, `local_net` **на транспорте**
  (в `[global]` Asterisk 20 его отвергает); `[agil-livekit]` — identify by IP
  `127.0.0.1/32`, `context=from-livekit`, G.711, `direct_media=no`,
  `rtp_symmetric=yes`; `[agil-sip-out]` — исходящий peer на `127.0.0.1:5070`.
  Никакого REGISTER и digest-auth: LiveKit SIP не регистрируется, лаб работает
  на статическом peer, как SBC у оператора.
- `extensions.conf`:
  - `+15550100` — leg A: Answer → `MixMonitor(mix, r(rx)t(tx))` → `Playback(agil-tone-a)` (440 Гц);
  - `+15550102` — leg B: то же с `agil-tone-b` (880 Гц); вызовы идут в одну
    комнату, поэтому rx-файл A может содержать только B и наоборот;
  - `+15550101` — DTMF: `Read(DTMF_DIGITS,,8,,1,12)` → строка в
    `recordings/dtmf.log` → короткий beep;
  - `[lab-inbound]` — helper 900 для ручной проверки (MixMonitor + `Dial(PJSIP/600@agil-sip-out)`).
- `rtp.conf`: 16000-16100, `strictrtp=no` (лаб-компромисс: LiveKit SIP может
  переиспользовать порт/SSRC).
- `manager.conf`: AMI на `127.0.0.1:5038`, пользователь `agil` (lab-секрет),
  классы `call` **и `originate`** — в Asterisk 20 `Action: Originate` без
  отдельного класса `originate` отвечает `Permission denied`.
  **Только single-user lab:** секрет фиксированный и известен из репозитория, а
  классы (`system,command,config,originate`) широкие; на общем или
  многопользовательском хосте любой локальный пользователь может подключиться к
  AMI. Не запускайте стенд на shared host; для своего окружения сгенерируйте
  случайный секрет и передайте его через `.env`, а классы урежьте до
  `call,originate` (production AMI — §10).
- `logger.conf`: `console`/`messages` с verbose (маркеры `AGIL_LAB_*`),
  `full` с debug — туда же попадает `pjsip set logger on` (SIP-трасса).
- `modules.conf`: `autoload=yes`, `noload` для legacy `chan_sip` (иначе он
  дерется с PJSIP за 5060), `chan_skinny`, `chan_mgcp`.

### 5.3. Скрипты

| Файл | Роль |
|---|---|
| `scripts/gen-tones.mjs` | генерирует `agil-tone-{a,b,beep}.wav` (8 кГц, PCM16, 440/880/1000 Гц) |
| `scripts/lab-up.sh` | `docker compose up -d`, тоны, ожидание сервисов |
| `scripts/lab-down.sh` | остановка (+ `--clean` для записей/логов) |
| `scripts/lab-init.mjs` | идемпотентно создаёт/пересоздаёт outbound/inbound транки и default dispatch rule, пишет `.lab-trunks.json` |
| `scripts/e2e.mjs` | все проверки стенда (§6) |
| `scripts/lib/*.mjs` | Twirp/JWT, AMI-клиент, парсер WAV/тонов, env (без зависимостей) |

`lab-init.mjs` сознательно **не** трогает приложение: транки — внешняя
инфраструктура, а `scale.sip.trunkId` настраивается через API тенанта (это
делает e2e). Номера: `600` зарезервирован под e2e inbound (эфемерный транк),
`601/602` — для ручных тестов софтфоном; LiveKit не разрешает два inbound-транка
с одним номером, поэтому номера разведены.

## 6. Что проверяет `e2e.mjs`

| Фаза | Проверки | Чем доказано |
|---|---|---|
| 0. Preflight | приложение живо, шлюз настроен, Twirp/AMI доступны, тоны на месте | HTTP `/v1/health`, `/v1/admin/sip/status`, `RoomService.ListRooms`, AMI login |
| 1. Конфиг | транк создан/переиспользован, tenant-конфиг включён, mock/live тесты | `PATCH /v1/tenants/:t/config`, `/v1/admin/sip/test` |
| 2. RTP | два вызова в одну комнату; оба листаются; **аудио в обе стороны** | `recordings/a-{mix,rx,tx}.wav`, `b-*.wav`: RMS/active + доминирующая частота (A→440, B→880); плюс SIP-трасса `INVITE sip:+15550100@…`, `200 OK`, `ACK` |
| 3. list/stop | список из двух, stop по одному, комната пустеет | `GET/POST …/sip`, livekit `ListParticipants`, audit `sip.dialin.started/stopped` |
| 4. DTMF | приложение передаёт `dtmf`, Asterisk собирает цифры | строка `DTMF=123 STATUS=OK` в `recordings/dtmf.log`, `Read` status OK |
| 5. inbound | Asterisk звонит на inbound-транк; dispatch rule кладёт в комнату приложения; входящий слышен; stop входящего | `OriginateResponse` success, `INVITE sip:600@127.0.0.1:5070`, участник `sip_…` в списке, rx-запись слушателя ~880 Гц |
| 6. trunk-down | неизвестный `trunkId` → `502 sip_failed`; остановленный SIP-worker (`--service-down`) → `502`; восстановление | HTTP-ответы, audit `sip.dialin.failed`, отсутствие номера/URL в тексте |
| 7. E2EE | включённый E2EE → `409 e2ee_incompatible` | HTTP-ответ |
| 8. Нода SIP | остановленный по heartbeat модуль запрещает новые вызовы, уже подключённого участника можно увидеть и завершить, после восстановления проходит новый вызов | `503 sip_node_unavailable`, список реальных участников LiveKit и успешная повторная попытка |

Флаги: `--only=rtp,dtmf,stop,inbound,trunkdown,e2ee,managed`, `--keep`,
`--service-down` (+ `LAB_DOCKER=1`, нужен docker CLI в том же окружении).

Анализ записей (`scripts/lib/audio.mjs`): парсит WAV (в т.ч. незакрытый файл,
где `data size` ещё placeholder), считает RMS/peak/active-время и мощность
Гёрцеля на 440/880/1000 Гц. Именно частотная проверка отличает «звук есть» от
«через SFU прошёл именно тон другой стороны»: ошибка маршрутизации/one-way
даёт неверную доминирующую частоту и тест падает.

## 7. Журнал прогона (16.11.2026, WSL2)

Окружение: Ubuntu 20.04 (WSL2), Docker Engine 26.1.3, Compose v2.29.7,
Asterisk certified-20.7-cert12, LiveKit server 1.13.11, LiveKit SIP 1.24.0.

```text
0. Preflight
  ✔ app /v1/health — HTTP 200
  ✔ gateway configured in the app
  ✔ LiveKit Twirp reachable by the lab operator — 0 room(s)
  ✔ tone prompts for the Asterisk dialplan
  ✔ Asterisk AMI login — 127.0.0.1:5038

2. RTP — bidirectional audio between two Asterisk legs in one LiveKit room
  ✔ dial-in leg A (app → Asterisk, 440 Hz tone) — sip_935475…
  ✔ dial-in leg B (app → Asterisk, 880 Hz tone) — sip_0db07f…
  ✔ app lists both SIP participants — …:active, …:active
  ✔ LiveKit room has two SIP participants
  ✔ leg A transmitted audio — 4.1 s, active 2.1 s, rms -17.0 dBFS, dominant ~440 Hz
  ✔ leg B transmitted audio — 4.1 s, active 3.1 s, rms -15.3 dBFS, dominant ~880 Hz
  ✔ leg A received leg B audio (rx) — 4.1 s, active 2.9 s, dominant ~880 Hz
  ✔ leg B received leg A audio (rx) — 4.1 s, active 2.0 s, dominant ~440 Hz
  ✔ tone check: leg A tx is A tone (~440 Hz)
  ✔ tone check: leg B rx is A tone (~440 Hz)
  ✔ tone check: leg B tx is B tone (~880 Hz)
  ✔ tone check: leg A rx is B tone (~880 Hz)
  ✔ a-mix / b-mix recording is valid WAV
  ✔ Asterisk channels reached Up (INVITE answered) — PJSIP/agil-livekit-00000000/1
  ✔ SIP trace: LiveKit INVITE to +15550100 — logs/asterisk/full
...
4. DTMF
  ✔ Asterisk received DTMF digits — DTMF=123 STATUS=OK
5. inbound
  ✔ Asterisk originated INVITE to the LiveKit inbound trunk (answered) — PJSIP/agil-sip-out-00000004
  ✔ app lists the inbound caller as a SIP participant — sip_284b7e…
  ✔ inbound audio reached the room listener — 2.0 s, active 1.8 s, dominant ~880 Hz
  ✔ SIP trace: Asterisk INVITE sip:600@127.0.0.1:5070
  ✔ stop inbound caller (no phone number in the URL)
6. trunk-down
  ✔ dial-in with an unknown trunk → 502 sip_failed
  ✔ 502 does not echo the number or the gateway URL
7. E2EE
  ✔ dial-in with E2EE enabled → 409 e2ee_incompatible

Summary: 57 passed, 0 failed, 1 skipped
```

Отдельно проверено вручную (эквивалент `--service-down`, docker CLI в WSL):

```text
# docker compose stop sip; POST /v1/rooms/<id>/sip/dial-in
dial while worker stopped -> 502 sip_failed | text has number: false
# docker compose start sip
worker back up after 0 s
dial after restart -> 200 sip_<hex>   (participants: active)
stop -> 200
```

Фрагменты реальной SIP-трассы из `logs/asterisk/full`:

```text
INVITE sip:+15550100@127.0.0.1:5060;transport=udp SIP/2.0     # LiveKit SIP → Asterisk
SIP/2.0 200 OK                                                # Asterisk отвечает
ACK sip:127.0.0.1:5060 SIP/2.0                                # LiveKit подтверждает
INVITE sip:600@127.0.0.1:5070 SIP/2.0                         # Asterisk → LiveKit (inbound)
```

SDP (Asterisk ↔ LiveKit SIP, G.711):

```text
c=IN IP4 127.0.0.1          m=audio 16004 RTP/AVP 0 8 101     # Asterisk offers PCMU/PCMA + telephone-event
c=IN IP4 10.255.255.254     m=audio 10036 RTP/AVP 9 0 8 101   # LiveKit SIP (audio + telephone-event)
```

`10.255.255.254` — WSL2-адрес, который SIP-сервис выбрал для SDP (см. §8);
медиа остаётся внутри хоста, поэтому вызовы работают.

Дополнительно проверено на реальном gateway (входящий вызов, у которого identity —
номер телефона; сценарий фикса #7–#8):

```text
GET /v1/rooms/<room>/sip
  { "id": "PA_rCT49cJnUYWq", "identity": "+1••••••••88",
    "name": "Phone +1••••••••88", "masked": true, "status": "active", ... }
LiveKit raw:  sip_+15559998888  sid=PA_rCT49cJnUYWq
POST …/sip/PA_rCT49cJnUYWq/stop -> 200 {"stopped":true,"participantId":"PA_rCT49cJnUYWq"}
listener still present: 1 | audit has phone: false | audit has opaque id: true
```

## 8. Подводные камни стенда (найдены при прогоне)

1. **`local_net` в `[global]` pjsip.conf** — Asterisk 20 не грузит объект
   `global` и пишет `Could not find option suitable for category 'global'`.
   Перенесено в `[transport-udp]`.
2. **В образе Asterisk нет звуков** (`/var/lib/asterisk/sounds` пуст):
   `Playback(hello-world)` падает, записи тихие, RTP «не идёт». Решение —
   генерировать тональные WAV (`gen-tones.mjs`) и монтировать их.
3. **`MixMonitor(...,r(rx),t(tx))`** — опции `r()`/`t()` должны быть **одним**
   аргументом (`r(rx)t(tx)`); с запятой Asterisk трактует `t(...)` как shell-
   команду, и tx-файла нет.
4. **AMI `Originate` требует класс `originate`** (Asterisk 20 отвечает
   `Permission denied`, даже если есть `call`). Добавлено в `read`/`write`.
5. **Один номер — один inbound-транк**: LiveKit отвергает второй транк с тем же
   номером. Поэтому 600 — только для эфемерного e2e-транка, 601/602 — ручные.
6. **JWT с `roomAdmin` без `room`** не даёт доступ к участникам комнаты
   (`401`); e2e использует room-scoped токен.
7. **WSL2**: SIP-сервис объявляет в SDP `10.255.255.254` (loopback-alias WSL);
   для лаба это работает (всё локально), но на реальном хосте задавайте
   `nat_1_to_1_ip`/`media_nat_1_to_1_ip` или публичный IP. Также WSL2-дистрибутив
   может «уснуть» без активных процессов — держите сессию (например,
   `wsl -e sleep infinity`) на время прогона.
8. **host networking** — только Linux/WSL2; Docker Desktop для Windows не
   подходит. Это ограничение выбрано сознательно (как в upstream LiveKit SIP
   sample): SIP-сервис обязан объявлять достижимый SDP/RTP адрес.

## 9. Что проверено здесь, а что **Blocked**

| Проверка | Статус | Комментарий |
|---|---|---|
| LiveKit SIP + Asterisk локально | ✅ **прогнано** | 57 проверок, §7 |
| Реальный INVITE/200/ACK | ✅ **прогнано** | SIP-трасса в `logs/asterisk/full` |
| RTP в обе стороны (G.711) | ✅ **прогнано** | тон-анализ записей Asterisk |
| DTMF (RFC 2833/4733) | ✅ **прогнано** | `DTMF=123`, `STATUS=OK` |
| list/stop, входящий вызов, dispatch rule | ✅ **прогнано** | комната очищается, входящий слышен |
| trunk-down `502` | ✅ **прогнано** | неизвестный транк + остановленный SIP-worker |
| E2EE `409` | ✅ **прогнано** | — |
| **Реальный транк/DID/оператор** (real trunk, DID, carrier) | **⛔ Blocked** | нужен внешний провайдер, договор, номера; не в этом окружении |
| TLS/SRTP и digest-auth оператора | **⛔ Blocked** | нужны внешний SBC и сертификаты оператора. Для локального TLS/SRTP есть отдельный исходящий сценарий |
| STIR/SHAKEN, верификация caller ID | **⛔ Blocked** | зона оператора |
| Экстренные вызовы (112/911) | **⛔ Blocked** | запрещены baseline; нет геолокации/SLA |
| Реальное качество PSTN, джиттер/потери | **⛔ Blocked** | нет внешней сети и оператора |
| G.722/Opus-транскодинг, факс/T.38 | **⛔ Blocked** | лаб только PCMU/PCMA; не проверялось |
| `--service-down` внутри e2e | ⚠️ **skipped** | на Windows/WSL не было docker CLI в PATH; проверено вручную (§7) |
| Docker Desktop (Windows engine) | **⛔ Blocked** | нет host networking для SIP/RTP |
| Multi-node SIP / failover оператора | **⛔ Blocked** | один SIP-worker, один транк |

## 10. Production gates (что нужно перед реальным PSTN)

1. **Транк оператора**: termination URI/SBC, TLS 5061, SRTP, IP-allowlist +
   digest-auth/SBC-аутентификация, разрешённые направления и лимиты каналов.
2. **From/caller ID**: номер, выделенный оператором; проверка права на From
   (STIR/SHAKEN у оператора); `callerId` в конфиге тенанта.
3. **DID + dispatch rules**: реальные номера, правило DID→комната, pin/
   allowlist/часы, политика «кто может входить по телефону».
4. **Сеть**: публичный/NAT-адрес SIP-сервиса, RTP 10000-20000/UDP открыт,
   `use_external_ip: true` или `nat_1_to_1_ip`, firewall, anti-fraud лимиты.
5. **Секреты**: `AGIL_SIP_*` — в секрет-менеджере, не в git; AMI выключен или
   за management-сетью с TLS и отдельными учётками; lab-секреты из этого стенда
   не переиспользовать.
6. **E2EE**: для комнат с PSTN выключен (`409 e2ee_incompatible` — ожидаемое
   поведение); запись/уведомление сторон и retention — по требованиям
   регулятора.
7. **Мониторинг**: `sip.dialin.failed`, доля `502`, `active` SIP-участники,
   RTP QoS/джиттер/потери SIP-сервиса, длительность и стоимость вызовов,
   алерты на исчерпание каналов оператора.
8. **Юридика**: лицензия/договор оператора, запись разговоров и уведомление,
   хранение метаданных, запрет экстренных вызовов без отдельного контура.

## 11. Найденные и исправленные баги

Стенд нашёл реальные проблемы — и в конфигах лаборатории, и в приложении
(`agil/core/apps/server/src/sip.ts`, покрыто тестами `test/sip.test.ts`):

| # | Проблема | Исправление |
|---|---|---|
| 1 | `local_net` в `[global]` ломал загрузку PJSIP | перенесён в `[transport-udp]` (`pjsip.conf`), регрессия в static-тесте |
| 2 | в образе нет звуков → `Playback` падает, RTP молчит | `gen-tones.mjs` + монтаж `asterisk/sounds`, тона 440/880/1000 Гц |
| 3 | `MixMonitor(...,r(x),t(y))` → `t()` исполнялся как команда, tx-файла нет | один аргумент опций: `r(x)t(y)` |
| 4 | AMI `Originate` → `Permission denied` | класс `originate` в `manager.conf` (`read`/`write`) |
| 5 | **Приложение не умело передавать DTMF** — IVR-сценарий и DTMF-тест невозможны | `dtmf` в `POST …/sip/dial-in`: валидация `0-9*#w` (≤32), уходит в `CreateSIPParticipant.dtmf`, **не** пишется в логи/аудит |
| 6 | Устаревший локальный счётчик `maxConcurrent`: если абонент положил трубку сам, а `ListParticipants` падает, dial-in ложно получал `409` | локальный fallback сверяется с успешным ответом LiveKit (только opaque identity, номера не хранятся) |
| 7 | **Входящего телефонного участника нельзя было остановить**: identity = номер → маскируется, а stop отклоняет phone-like id | `id` для phone-like identity = participant id LiveKit (`PA_…`); stop резолвит его на сервере и шлёт `RemoveParticipant` с identity; в ответе `masked: true`, в URL/аудите только `PA_…` |
| 8 | **Утечка номера в `name`**: LiveKit для входящего вызова синтезирует имя `Phone +1555…`, а проверка «вся строка — номер» его не маскировала | `maskPhoneNumbersInText()` маскирует номера внутри имени (`Phone +1••••••••88`); проверено на реальном gateway и в mock-тесте |

Изменения публичного контракта (аддитивные/уточняющие):

- `POST /v1/rooms/:id/sip/dial-in` принимает `dtmf?: string`;
- `SipParticipant.id` — opaque-хэндл: identity, либо `PA_…` для phone-like
  identity; добавлено `masked?: boolean`;
- `POST /v1/rooms/:id/sip/:participantId/stop` принимает этот `id`
  (phone-like значения по-прежнему `400 validation_failed`);
- OpenAPI (`docs/openapi.json`, `docs/openapi.admin.json`) перегенерирован.

## 12. Файлы

- [`agil/core/deploy/sip/docker-compose.yml`](../deploy/sip/docker-compose.yml)
- [`agil/core/deploy/sip/livekit.yaml`](../deploy/sip/livekit.yaml), [`.env.example`](../deploy/sip/.env.example)
- [`agil/core/deploy/sip/asterisk/`](../deploy/sip/asterisk/) — `pjsip.conf`, `extensions.conf`, `rtp.conf`, `manager.conf`, `logger.conf`, `modules.conf`
- [`agil/core/deploy/sip/scripts/`](../deploy/sip/scripts/) — `gen-tones.mjs`, `lab-up.sh`, `lab-down.sh`, `lab-init.mjs`, `e2e.mjs`, `lib/*`
- [`agil/core/scripts/test/sip-local-lab.test.mjs`](../scripts/test/sip-local-lab.test.mjs) — CI-гейт без Docker (`npm run test:sip-lab`)
- Приложение: [`agil/core/apps/server/src/sip.ts`](../apps/server/src/sip.ts), тесты [`test/sip.test.ts`](../apps/server/test/sip.test.ts)
- Документация: [`sip.md`](sip.md), [`api.md` §37](api.md), `qa-sip.md`, [`free-open-source-plan.md`](free-open-source-plan.md) (§6)

## 13. Как воспроизвести проверки без Docker

```bash
npm run test:sip-lab    # статический контракт стенда + анализ WAV/тонов
cd agil/core/apps/server && npx tsx --test "test/sip.test.ts"   # mock Twirp
```

Эти тесты не требуют Docker и проверяют: пины образов, порты/диапазоны,
монтирования, dialplan/Asterisk-конфиги/AMI-классы, скрипты, отсутствие секретов,
документацию, а также RMS/частотный анализ и идемпотентность парсера `.env`.

Итоговые прогоны 16.11.2026: **57/57** живых проверок стенда (`e2e.mjs`,
1 skipped — `--service-down` без docker CLI на Windows), **12/12** статических
(`npm run test:sip-lab`), **23/23** SIP-тестов приложения и **259/259** всего
серверного набора (`npx tsx --test "test/*.test.ts"`, `tsc --noEmit` чистый).
