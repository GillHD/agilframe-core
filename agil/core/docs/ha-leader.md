# HA: лидер-Core, standby read-only и failover (Redis lease)

Статус: **реализован baseline** в `@agil/calls-server` + `@agil/protocol` +
дашборде. Деплой в этом этапе не входит: документ описывает поведение, проверки и
границы применимости.

Связанные документы: [`api/cluster.md`](api/cluster.md) (токены, реестр узлов,
HTTP-контракт), [`scaling.md`](scaling.md) (§4 — что ещё не сделано для
мульти-ноды), [`operations.md`](operations.md) (эксплуатация, health, DR),
`qa-cluster.md` (QA-сценарии).

---

## 1. Что решает этот этап

До этого этапа каждый Core был самостоятельным: два процесса на одном домене
могли одновременно выдавать токены, менять конфиг организации и создавать
комнаты, а «резервный Core» был только строкой в реестре.

Теперь:

- Cores с общим `AGIL_REDIS_URL` выбирают **одного лидера** через аренду
  (lease) в Redis;
- лидер — единственный, кто принимает **мутации** (комнаты, токены доступа,
  enrollment-токены, узлы, конфиг организации, домены и прочие admin-записи);
- остальные Cores — **standby**: читают, но на мутации отвечают
  `409 not_leader`, и перехватывают лидерство автоматически, когда аренда
  истекает;
- статус (`GET /v1/admin/cluster/status`) и панель **Инфраструктура** показывают
  лидера, TTL аренды, дедлайн fencing, состояние Redis, факт failover и явные
  ограничения;
- есть тесты на двух Cores в одном процессе и на **двух реальных процессах** с
  `SIGKILL` лидера (§8).

Без `AGIL_REDIS_URL` поведение прежнее: один активный Core (standalone).
`AGIL_CLUSTER_ROLE=standby` в standalone-режиме по-прежнему делает Core
read-only (без выборов).

---

## 2. Топология

```
                    ┌──────────────────────────┐
   клиенты/LB  ───► │ Core A (leader)          │ ──┐
                    │  lease: SET NX PX + renew │   │
                    └──────────────────────────┘   │
                                                   ▼
                                          ┌─────────────────┐
                                          │ Redis / Valkey  │
                                          │ agil:cluster:…  │
                                          └─────────────────┘
                                                   ▲
                    ┌──────────────────────────┐   │
   клиенты/LB  ───► │ Core B (standby)         │ ──┘
                    │  PTTL/HGETALL, retry SET  │
                    └──────────────────────────┘
```

Redis хранит аренду и, при соответствующей настройке, снимки комнат.
Для публикаций Wiki и истории можно подключить отдельное общее файловое
хранилище. Активные подключения, конфиг организации и файл реестра узлов
хранятся на локальных дисках Core (§7).

Redis-совместимость: RESP2-клиент в `apps/server/src/redis-client.ts` не тянет
npm-зависимостей; поддерживаются `redis://`, `rediss://` (TLS), AUTH и выбор БД
из URL. Тесты по умолчанию используют RESP-заглушку
(`scripts/support/mini-redis.mjs`), против реального Redis —
`AGIL_TEST_REDIS_URL`.

---

## 3. Переменные окружения

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `AGIL_REDIS_URL` | пусто = standalone | `redis://[user:pass@]host:port[/db]` или `rediss://…`. Пусто — один активный Core, failover нет |
| `AGIL_DOCS_DATA_DIR` | `AGIL_DATA_DIR/docs` | Существующий каталог для публикаций CMS, истории и основного документа. Для Wiki с failover подключите один общий каталог на всех Core |
| `AGIL_CLUSTER_ID` | `default` в Redis-режиме; иначе id кластера | Общий namespace аренды: `<prefix>:cluster:<clusterId>:…`. Должен совпадать у всех Cores |
| `AGIL_CLUSTER_NODE_ID` | `<hostname>:<PORT>` | Уникальный id Core в аренде. Задавайте явно, если несколько Cores на одном хосте (в т.ч. `PORT=0`) |
| `AGIL_CLUSTER_ROLE` | `leader` | В Redis-режиме `standby` = **не участвовать** в выборах и быть read-only; `leader` = участвовать нормально |
| `AGIL_REDIS_KEY_PREFIX` | `agil` | Префикс ключей |
| `AGIL_LEADER_LEASE_TTL_MS` | `10000` | TTL аренды, 2000…120000. Верхняя граница = худшее время failover |
| `AGIL_LEADER_RENEW_INTERVAL_MS` | `TTL/3` | Период продления, 100…TTL−100 |
| `AGIL_LEADER_RETRY_INTERVAL_MS` | `1500` | Период попыток standby забрать аренду, 100…60000 |

Ориентир: TTL 10 с → обнаружение падения лидера ≈ 10 с, продление каждые ~3.3 с.
Меньше TTL — быстрее failover, но больше риск ложного демоута при сетевых
задержках/паузах GC. Не ставьте `RENEW_INTERVAL` близко к TTL: нужен хотя бы один
retry до истечения.

> **Всегда задавайте `AGIL_CLUSTER_ID` в Redis-режиме.** Если он пуст, namespace
> аренды — `default`, а `cluster.id` в API по-прежнему генерируется/хранится в
> `AGIL_DATA_DIR` каждого Core. Cores будут делить одну аренду, но показывать
> разные `cluster.id` — путаница в статусе и панели. Одинаковый
> `AGIL_CLUSTER_ID` (и разный `AGIL_CLUSTER_NODE_ID`) у всех Cores — обязательное
> условие корректной топологии.

---

## 4. Ключи Redis и модель безопасности

Для каждого кластера:

| Ключ | Тип | Что внутри |
|---|---|---|
| `<prefix>:cluster:<clusterId>:leader` | string + TTL | id Core-лидера (`AGIL_CLUSTER_NODE_ID`); ставится `SET NX PX <ttl>`, продлевается Lua compare-and-PEXPIRE |
| `<prefix>:cluster:<clusterId>:registry-lock` | string + TTL | второй, явный lock на запись файла реестра узлов; его держит только лидер |
| `<prefix>:cluster:<clusterId>:state` | hash + TTL | `leaderId`, `since`, `heartbeatAt`, `version`, `publicOrigin`, `leaseTtlMs` — **advisory**, для статуса standby; TTL = max(3×leaseTtl, 15 с) |

Lua-скрипты продления/освобождения сравнивают значение ключа с собственным id,
поэтому нельзя продлить или удалить чужую аренду:

```lua
-- renew (compare-and-PEXPIRE)
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end
```

### 4.1 Fencing: почему нет split-brain

Лидер считает себя лидером только пока `Date.now() < validUntil`, где
`validUntil = момент отправки SET/EVAL + TTL`. Ключевые свойства:

1. Redis не истечёт аренду **раньше** `validUntil` (команда отправлена не позже,
   чем получена сервером; TTL отсчитывается от получения).
2. Значит standby не сможет взять `SET NX` раньше `validUntil` старого лидера.
3. Старый лидер **сам** перестаёт принимать мутации в `validUntil`, даже если не
   может достучаться до Redis и не знает, что аренда потеряна (lazy fence в
   `role()` + таймер).

Окно «никто не лидер» (от истечения аренды до `SET NX` standby) безопасно:
мутации временно отклоняются `409`, данные не расходятся. Окно «два лидера»
отсутствует при одном исправном Redis.

При потере аренды вызывается `onDemote`: in-memory комнаты очищаются
(`rooms.clear('leadership_lost')`), чтобы демоутнутый Core не продолжал обслуживать
звонки со stale-состоянием. При получении аренды — `onPromote`: реестр узлов
перечитывается с диска (standby мог видеть устаревшую копию).

### 4.2 Чего fencing **не** закрывает

- **Потеря данных Redis.** Если Redis переехал на реплику без этой аренды
  (failover без persistence), standby может взять `SET NX` до `validUntil`
  старого лидера — окно split-brain на время дедлайна. Держите Redis с
  persistence/нормальным HA; отдельного fencing-token (epoch) в baseline нет.
- **Кража/подмена значения аренды** в Redis в обход Lua-сравнения (нужен доступ
  к Redis — он доверенный компонент).
- **Разные часы.** Безопасность не требует синхронизации часов (её держит Redis),
  но при переводе часов **назад** лидер может считать аренду живой дольше, чем
  она есть в Redis: тогда `EVAL` вернёт 0 и Core демоутнется; мутации до этого
  могли отклоняться. При переводе **вперёд** лидер демоутнется раньше — безопасно.
- **Долгая пауза процесса** (GC/swap/отладчик): после `validUntil` мутации
  отклоняются при первом же обращении (`role()`), даже если таймер не успел.

---

## 5. Поведение при сбоях

| Сценарий | Лидер | Standby | Клиенты |
|---|---|---|---|
| Redis недоступен на старте | — | стартует standby, `lease.redisConnected=false`, повторяет | мутации `409 not_leader` (fail closed) |
| Redis пропал у лидера | продолжает до `validUntil`, продления падают (`renewalFailures++`) | ждёт истечения TTL | мутации лидера работают до дедлайна, затем `409` |
| Процесс лидера убит (`SIGKILL`) | — | забирает аренду после TTL, `failover.detected=true` | окно `409`, затем мутации на новом лидере |
| Лидер graceful shutdown | освобождает аренду (`EVAL` compare-and-del) | забирает почти сразу | короткое окно `409` |
| Два Core с одинаковым `AGIL_CLUSTER_NODE_ID` | один получает аренду | второй видит «свой» id и остаётся standby с предупреждением в `lease.reason` | мутации только у реального держателя; **исправьте id** |
| Сеть разделила Core и Redis | лидер демоутнется по дедлайну | заберёт аренду после TTL | без split-brain; возможны `409` |
| Redis переехал с потерей данных | см. §4.2 | может забрать аренду раньше дедлайна | потенциальное окно split-brain — нужен устойчивый Redis |

Философия: **fail closed**. Если Core не может доказать, что держит аренду, он
не принимает мутации. Чтения (GET/списки/статус/health) остаются доступны, но
standby видит **своё** локальное состояние — комнат и конфига лидера там нет.

Гейт покрывает **все не-GET** запросы `/v1/admin/*`, включая диагностические POST
(`/v1/admin/assistant`, `/v1/admin/guard/assess`, `/v1/admin/scale/turn/test`,
`/v1/admin/siem/test`): на standby они тоже отвечают `409 not_leader`. Запускайте
диагностику на лидере (или через LB, который знает лидера). Это осознанно
консервативно: такие POST пишут audit/могут менять память ассистента, а общий
allowlist «безопасных» POST — следующий шаг.

---

## 6. Статус и панель

`GET /v1/admin/cluster/status` (tenant admin key) дополнен полями:

```jsonc
{
  "cluster": { "id": "ha-test", "role": "leader", "version": "0.1.0" },
  "leader":  { "id": "core-a", "since": 1794835000000, "heartbeatAt": 1794835001200, "self": true },
  "lease": {
    "mode": "redis",              // "redis" | "standalone"
    "held": true,                 // локально подтверждённая аренда (после fencing)
    "ttlMs": 2500,
    "ttlRemainingMs": 1800,       // PTTL общего ключа (null в standalone)
    "validUntil": 1794835003800,  // дедлайн: после него мутации запрещены
    "heartbeatAt": 1794835001200,
    "redisConnected": true,
    "renewalFailures": 0,
    "reason": "leader: lease renewed"
  },
  "ha": {
    "mode": "redis",
    "nodeId": "core-a",
    "registryLockHeld": true,
    "registryLockTtlRemainingMs": 1900,
    "roomStateReplicated": false,
    "tenantConfigReplicated": false,
    "nodeRegistryReplicated": false,
    "stateStore": "local-file"
  },
  "failover": {
    "detected": false,            // sticky: true, если этот Core перехватил лидерство
    "previousLeaderId": null,
    "changedAt": null,
    "message": "This Core holds the leader lease. Rooms/presence are in-process only — a failover loses them (docs/ha-leader.md)."
  },
  "standbys": [],
  "enrolledNodes": [],
  "counts": { "nodes": 0, "online": 0, "offline": 0, "draining": 0, "disabled": 0, "standbys": 0 },
  "limitations": ["core: rooms/presence are in-process …", "…"]
}
```

Семантика:

- `lease.held` — **локальная** вера с учётом fencing, а не просто «ключ есть в
  Redis». Именно она определяет, примет ли Core мутацию.
- `leader.id` на standby читается из общего hash/ключа; `leader.self` — этот ли
  Core лидер.
- `lease.ttlRemainingMs` на standby — `PTTL` общего ключа; на лидере — остаток до
  собственного `validUntil` (консервативнее Redis).
- `failover.detected` — липкий флаг процесса: Core видел другого лидера и затем
  получил аренду. Сообщение всегда содержит оговорку про нереплицированные
  комнаты.
- `reason` — человекочитаемая причина; показывается в панели и логах
  (`leadership state`, `leadership: acquired the leader lease`,
  `leadership: stepped down`).

Панель **Инфраструктура** (`#/infrastructure`) показывает карточку «Кластер»:
id/роль/версия/nodeId, текущий лидер, источник лидерства (`Redis lease` /
`standalone`), удержание аренды, TTL, `validUntil`, состояние Redis, heartbeat,
registry lock, `lease.reason`, флаги репликации и, при перехвате, жёлтый
**failover-баннер** с id предыдущего лидера и текстом ограничения.

---

## 7. Ограничения baseline (осознанные)

### Публикации Wiki и история

Оставьте `AGIL_DATA_DIR` раздельным. Смонтируйте один общий каталог для CMS
на каждом Core и задайте `AGIL_DOCS_DATA_DIR` с путём этого монтирования.
Хранилище должно поддерживать атомарное переименование файлов в каталоге
и видимость записи с других хостов. Используйте одинаковую сборку и одинаковый
набор исходных документов из `AGIL_DOCS_DIR` на всех Core. Храните резервные
копии общего каталога.

Для Docker Compose добавьте к сервису Core монтирование общего каталога.
Замените `core` на имя сервиса вашего файла Compose. Пользователю контейнера
нужны права записи в каталог и его `.history`. На каждом хосте сначала
проверьте, что путь указывает на общее хранилище.

```yaml
services:
  core:
    environment:
      AGIL_DOCS_DATA_DIR: /app/wiki-data
    volumes:
      - type: bind
        source: /mnt/agil-wiki
        target: /app/wiki-data
        bind:
          create_host_path: false
```

При переносе остановите изменения Wiki, сохраните резервную копию и
скопируйте содержимое `AGIL_DATA_DIR/docs` текущего лидера в общий каталог,
включая `.history` и `.default.json`. Подключите путь на всех Core, затем
сверьте текущую публикацию и список версий на лидере и standby. Изменения
принимает лидер. Если используется прежний локальный каталог, новый лидер
читает собственные публикации и историю.

### Остальные ограничения

Core поддерживает выбор лидера, read-only standby и восстановление комнат из снимков. Учитывайте следующие ограничения:

1. **Восстановление комнат.** При `AGIL_ROOM_SNAPSHOT_STORE=redis` новый лидер
   загружает снимки из общего Redis, в том числе при раздельных дисках Core.
   Изменения после последнего сохранения могут потеряться. Клиенты переподключаются,
   состояние медиатранспорта и временные подписки зависят от используемого транспорта.
   См. [восстановление звонка](call-continuity.md).
2. **Репликация конфига организации и реестра узлов.** Оба — локальные файлы под
   `AGIL_DATA_DIR`. Общий `AGIL_DATA_DIR` на нескольких хостах не поддержан;
   файловый lock защищает только от переплетения записей, не от расхождения
   in-memory копий. Загрузки файлов и записей тоже пишутся в локальный volume и
   не реплицируются, поэтому standby отклоняет их с `409 not_leader`, а не
   принимает данные, которые потеряются при failover.
3. **Pub/sub fan-out и sticky routing.** Нет широковещания чата/presence между
   Cores и нет маршрутизации участника комнаты на владеющий Core.
4. **Leader-aware балансировка.** `/v1/health` проверяет процесс независимо от роли.
   `/v1/ready` возвращает `200` на активном Core после восстановления комнат и
   `503` на standby, во время восстановления и остановки. Настройте проверку
   `/v1/ready` для каждого upstream Core и ведите HTTP и новые WS-соединения через
   один backend. В интервале между проверками трафик может попасть на демотированный
   Core. Мутации там получают `409 not_leader`. Установленные WS переподключает
   клиент. [Пример HAProxy](../../infra/examples/haproxy/haproxy.cfg)
5. **Кворум/консенсус.** Это **lease на одном Redis**, а не Raft/Paxos: нет
   голосования, нет защиты от потери данных Redis (§4.2).
6. **Fencing-token (epoch) для внешних ресурсов.** Смена лидера не передаёт
   монотонный номер в S3/egress/БД; внешние писатели не могут отвергнуть записи
   старого лидера.
7. **Graceful handover.** Нет команды «передай лидерство»/дренажа лидера: только
   остановка процесса или ожидание TTL.

Поэтому production-топология «два app-реплики за LB с общим состоянием» пока
**не** заявляется: это только baseline отказоустойчивости **мутаций**, не
мульти-нода (§3 `scaling.md`).

---

## 8. Проверки (тесты)

Все тесты — `agil/core/apps/server/test/`:

1. `ha-cluster.test.ts` — два Core в одном процессе:
   - standalone: роль `leader`, `lease.mode=standalone`, `ha.*Replicated=false`;
   - два Core + Redis: ровно один лидер, standby `409 not_leader` на
     `POST /v1/rooms`, `POST /v1/tokens`, `POST /v1/admin/cluster/tokens`,
     `PATCH /v1/admin/nodes/:id`, `PATCH /v1/tenants/:id/config`,
     `POST /v1/cluster/join`; комната лидера не видна standby (`404`);
   - «замороженный» лидер (`leader.disconnect()`: сокет закрыт, аренда **не**
     освобождена) перестаёт принимать мутации после дедлайна, standby забирает
     аренду, `failover.detected=true`, мутации продолжаются;
   - перезапуск старого node id возвращается standby, лидер по-прежнему один;
   - `AGIL_CLUSTER_ROLE=standby` + Redis: Core не участвует в выборах и read-only.
2. `ha-two-process.test.ts` — **два реальных процесса** ОС + Redis:
   - лидер и standby в разных процессах, standby отдаёт `409`, лидер — `200`;
   - `SIGKILL` лидера (без освобождения аренды): standby становится лидером
     **не раньше** `validUntil` убитого лидера (проверяется по времени), затем
     создаёт комнату/токен;
   - `failover.detected=true`, `previousLeaderId` совпадает;
   - перезапущенный старый node id — снова standby.

Команды:

```bash
cd agil/core/apps/server
npx tsx --test test/ha-cluster.test.ts
npx tsx --test test/ha-two-process.test.ts

# против реального Redis (иначе — встроенная RESP-заглушка):
AGIL_TEST_REDIS_URL=redis://127.0.0.1:6379 npx tsx --test test/ha-cluster.test.ts
AGIL_TEST_REDIS_URL=redis://127.0.0.1:6379 npx tsx --test test/ha-two-process.test.ts
```

Заглушка `scripts/support/mini-redis.mjs` реализует только нужный набор команд
(`SET NX PX`, `GET`, `DEL`, `PTTL`, `PEXPIRE`, `HSET/HGETALL`, два Lua-скрипта) и
**не** является заменой Redis (нет persistence/репликации/pub-sub). Если в
окружении нет `redis-server`/Docker, тесты идут на ней и это явно указано в
отчёте; production-приёмка требует реального Redis/Valkey.

---

## 9. Операционный runbook (baseline)

### 9.1 Запуск двух Cores

```bash
# Core A
AGIL_REDIS_URL=redis://redis.internal:6379 \
AGIL_CLUSTER_ID=prod \
AGIL_CLUSTER_NODE_ID=core-a \
AGIL_DATA_DIR=/var/lib/agil \
PORT=8787 node dist/index.js

# Core B (другой хост; свой data dir)
AGIL_REDIS_URL=redis://redis.internal:6379 \
AGIL_CLUSTER_ID=prod \
AGIL_CLUSTER_NODE_ID=core-b \
AGIL_DATA_DIR=/var/lib/agil \
PORT=8787 node dist/index.js
```

Проверка:

```bash
curl -s -H "x-api-key: $AGIL_API_KEY" http://core-a:8787/v1/admin/cluster/status | jq '.lease'
# ожидаем: mode=redis, held=true, redisConnected=true, renewalFailures=0
curl -s -H "x-api-key: $AGIL_API_KEY" http://core-b:8787/v1/admin/cluster/status | jq '{role:.cluster.role, leader:.leader.id, held:.lease.held}'
# ожидаем: standby, leader core-a, held=false
```

Ключи в Redis:

```bash
redis-cli --scan --pattern 'agil:cluster:*'
redis-cli PTTL agil:cluster:prod:leader     # > 0, пока лидер жив
redis-cli GET  agil:cluster:prod:leader     # id лидера
redis-cli HGETALL agil:cluster:prod:state
```

### 9.2 Ручная проверка failover

1. Остановите Core A (`SIGKILL`, не graceful) и засеките время.
2. В течение `AGIL_LEADER_LEASE_TTL_MS` write на B отвечает `409 not_leader`.
3. После TTL B становится лидером; `POST /v1/rooms` на B → `200`.
4. `GET /v1/admin/cluster/status` на B: `failover.detected=true`,
   `previousLeaderId=core-a`, `lease.reason` содержит `acquired`.
5. Верните A: он должен стартовать standby (`held=false`) и отдавать `409`.
6. Убедитесь, что `A.leader.id` и `B.leader.id` в один момент не равны разным
   значениям при живом Redis (кроме окна до истечения TTL, когда лидера нет).

### 9.3 Типовые проблемы

| Симптом | Причина / действие |
|---|---|
| Все Cores standby, `redisConnected=false` | неверный URL/сеть/ACL/пароль; проверьте `redis-cli -u $AGIL_REDIS_URL PING`, TLS для `rediss://` |
| `reason`: «a lease for this node id is held elsewhere» | одинаковый `AGIL_CLUSTER_NODE_ID` у двух Cores — задайте уникальные |
| Постоянные `409`, хотя лидер жив | LB шлёт write на standby; нужен sticky/лидер-роутинг или retry (§7.4) |
| `renewalFailures` растёт, `held=true` | деградация Redis/сети; лидер держится до `validUntil`, затем демоут. Не «лечите» увеличением TTL без нужды |
| После failover пропали комнаты | ожидаемо: room state не реплицируется; выпустите новые токены/комнаты |
| Долгий failover | уменьшите `AGIL_LEADER_LEASE_TTL_MS`/`RETRY_INTERVAL` в разумных пределах (§3) |

Логи: `leadership state` при старте, `leadership: acquired the leader lease`
(+`previousLeaderId`, `failover`), `leadership: stepped down`, `leadership: lease
renewal failed; still leader until the fencing deadline`.

---

## 10. Что дальше (порядок работ)

1. Репликация комнат/presence и tenant config (Redis pub/sub + snapshot или
   durable store) и room ownership/lease.
2. Сквозная проверка маршрутов API и WS через балансировщик при failover,
   включая период между проверками готовности.
3. Durable node registry (Postgres/Redis) вместо файла.
4. Fencing-token/epoch для внешних писателей (egress/S3/БД).
5. Redis HA (replica + Sentinel/managed) и проверка поведения lease при
   failover Redis (включая persistence).
6. Graceful handover (`POST /v1/admin/cluster/leader/step-down`) и drain лидера.
