# Live-call continuity (Stage 2)

Дата: 16.11.2026. Область: `agil/core/apps/server` (control plane), `agil/websdk/widget` (клиент).
Статус: реализовано и покрыто точечными тестами; деплой не выполнялся.

Цель — пережить короткий обрыв signaling и рестарт Core без потери звонка:
комнаты и участники восстанавливаются из снимка, клиент переподключается по
resume-token, SFU-сессия переиспользуется или переподключается, в списке
участников не появляются дубликаты, а UI честно показывает
`reconnecting` → `restored`.

---

## 1. Что переживает, а что нет

| Сценарий | Control plane (комната, участники, права) | Signaling / chat | Presence | Медиа | Итог |
|---|---|---|---|---|---|
| Обрыв WS на 1–20 с (тот же Core) | сохраняется | авто-reconnect | `reconnecting` → `restored` | mesh/SFU не рвётся или переподключается | звонок продолжается, без `peer-left`/`peer-joined` |
| Рестарт Core, SFU (LiveKit) жив | восстанавливается из снимка | после reconnect | `reconnecting` → `restored` | SFU-комната жива: клиент переиспользует сессию/переподключается | звонок продолжается после reconnect каждого клиента |
| Рестарт Core, SFU тоже умер | восстанавливается | работает | `reconnecting` → `restored` | медиа нет; mesh-фолбэк ≤8 участников или retry SFU | голос/видео деградируют, чат и presence живы |
| Потеря узла LiveKit при работающем Core | комната Core остаётся | работает | без изменений | медиасоединение прерывается | в локальном кластере из двух LiveKit браузеры восстановили видео на втором узле за 14,8 с. [Сценарий](sfu-multinode.md#локальное-восстановление-после-потери-узла) |
| Рестарт Core + потеря снапшота/диска | нет | — | — | — | комната не восстанавливается, участники получают `Room not found` |
| Перезагрузка вкладки браузера | комната жива | новый WS | новый participant id (если не `resume()`/`persistSession`) | новая сессия | считается новым входом |

Важно: «SFU rejoin» — это повторный вход в **ту же** LiveKit-комнату
(`tenant__room`) по свежему токену. Перенос комнаты на другой SFU-узел
(seamless failover) не реализован: `Room.sfuNodeId` — это pin, а не миграция.

---

## 2. Что именно сохраняется

Снимок — это **только control-plane метаданные**; медиа-ключи и пользовательский
контент в него не попадают.

```jsonc
{
  "version": 1,
  "tenantId": "demo",
  "room": {
    "id": "standup",
    "name": "Daily standup",
    "createdAt": 1730000000000,
    "lastActivityAt": 1730000123000,
    "locked": false,
    "maxParticipants": 25,
    "ttlSec": 0,
    "passwordHash": "scrypt$…",          // только если у комнаты был пароль
    "configOverrides": { },              // per-room overrides
    "mode": "group",
    "mediaMode": "sfu",
    "context": { "messenger": "…" }
  },
  "participants": [
    {
      "participant": {
        "id": "u-1",
        "name": "Alisa",
        "role": "host",
        "joinedAt": 1730000000000,
        "state": { "mic": "on", "cam": "on", "screen": false, "handRaised": false, "network": "good" },
        "verified": false,
        "integrity": "unknown",
        "permissions": ["chat", "screen_share", "…"]
      },
      "joinedAt": 1730000000000,
      "resumeCapable": true,
      "resumeTokenHash": "sha256…",       // не сам токен
      "resumeExpiresAt": 1730000900000,
      "resumeTokenHashPrev": "sha256…",   // один предыдущий токен (потерянный welcome)
      "resumeExpiresAtPrev": 1730000600000
    }
  ],
  "permissions": { "u-1": ["chat", "…"] },
  "sfu": { "nodeId": "sfu-node-2", "room": "demo__standup", "provider": "livekit", "mode": "sfu" },
  "draining": false,
  "savedAt": 1730000123000,
  "expiresAt": 1730000923000
}
```

**НЕ сохраняется:** SDP/ICE, SRTP/DTLS-ключи, LiveKit access token, E2EE-ключ,
чат, транскрипты/субтитры, whiteboard/annotations, опросы, lobby-решения,
compliance findings, записи/egress, file uploads. После рестарта Core эти
поверхности начинаются заново (чат доступен из своего provider-хранилища, если
он настроен отдельно).

---

## 3. Хранилища

### 3.1 Файловое (по умолчанию)

`<AGIL_DATA_DIR>/rooms/<tenant>/<room>.json` (переопределяется
`AGIL_ROOM_SNAPSHOT_DIR`).

- запись атомарная: `file.<pid>.<rand>.tmp` → `rename`;
- каталог на тенанта — структурная изоляция: `list(tenant)` читает только его
  каталог, а `tenantId` внутри файла обязан совпадать с каталогом;
- идентификаторы, не проходящие `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`,
  хешируются в имя сегмента (path traversal невозможен).

### 3.2 Redis-совместимое (`AGIL_ROOM_SNAPSHOT_STORE=redis`)

Используется только при заданном `AGIL_REDIS_URL`; файловое хранилище остаётся
write-through зеркалом (если Redis недоступен, снимок всё равно на диске).

Ключи:

```
agil:room:<tenant>:<room>       JSON + SET … PX <ttl>
agil:room:index:<tenant>        SET roomId (для list(tenant))
agil:room:tenants               SET tenantId
```

Поддерживаются Redis, Valkey, KeyDB, Dragonfly и облака с RESP2
(`SET/GET/DEL/SADD/SREM/SMEMBERS`). Отдельный брокер/pub-sub не нужен: снимки
не являются шиной событий, их читает только лидер при promote/старте.

**Redis здесь — persistence, а не replication.** Общий стор позволяет другому
Core прочитать снимок; он не реплицирует комнаты, не переизбирает лидера и не
спасает от потери/эвикции данных: если ключи Redis пропали (flush/eviction/
пустой инстанс), комнаты не восстановятся, даже если LiveKit-комнаты живы.
Redis-replica/Sentinel, TTL-эвикция на живом сервере и реальный
Redis/Valkey в тестах **не проверялись**: `continuity.test.ts` использует fake
RESP-клиент (layout/индексы/деградация в файловое зеркало).

---

## 4. Жизненный цикл снимка

```
room created ──► assign SFU node ──► schedule save (debounce 200 ms)
join / leave / resume ─────────────► schedule save
every AGIL_ROOM_SNAPSHOT_FLUSH_MS ─► flushAll (5 s по умолчанию)
room closed (ttl/delete) ──────────► delete snapshot
room closed (server_shutdown,
              leadership_lost) ─────► snapshot retained for next boot/leader
SIGTERM / close() ─────────────────► flushAll() ДО rooms.clear()
```

- `expiresAt = savedAt + max(room.ttlSec, AGIL_ROOM_SNAPSHOT_MAX_AGE_SEC)`:
  TTL комнаты определяет, когда умирает **пустая** комната, а снимок живёт
  минимум orphan-retention, поэтому долгий тихий звонок не теряет снимок.
- периодический flush обновляет **все** живые комнаты (не только dirty), чтобы
  TTL файла/Redis-ключа не истёк посреди звонка; debounce 200 мс не даёт писать
  файл на каждый `state`-фрейм.
- sweeper раз в 30 с удаляет истёкшие снимки **только для комнат, которых уже
  нет в реестре** (в Redis ключ истекает сам).
- после закрытия комнаты по TTL/admin delete снимок удаляется сразу.
- При положительном TTL отсчёт начинается при создании пустой комнаты и заново после выхода последнего участника. Перезапуск Core сохраняет исходный срок. Комната с `ttlSec: 0` остаётся доступной после перезапуска.

---

## 5. Восстановление после рестарта Core

`RoomContinuity.restore()` вызывается:

1. при старте — **после** `leader.start()`, только если Core стал лидером
   (в standalone-режиме — всегда);
2. повторно в `LeaderElector.onPromote()` — если Core стартовал standby и
   получил лизинг позже.

Правила:

- снимок с `expiresAt <= now` удаляется и не восстанавливается;
- снимок неизвестного тенанта (нет в `TenantStore.listTenants()`) **не**
  воскрешается — удалённый тенант не возвращается;
- снимок с несовпадающим `tenantId`/каталогом отбрасывается;
- комната с уже существующим id пропускается (идемпотентный retry);
- `RoomRegistry.restore()` **не** эмитит `created` (биллинг не считает комнату
  созданной второй раз), эмитит `restored`;
- все участники восстанавливаются офлайн: `presence: "reconnecting"`, слот,
  права, `joinedAt` и последнее медиа-состояние сохранены;
- `createdAt`/`lastActivityAt`/`sfuNodeId`/`draining` восстанавливаются;
- участник, не пришедший до истечения resume-токена, вычищается heartbeat-сканом
  (`reason: "resume_expired"`), чтобы строка `reconnecting` не висела вечно;
- **capacity после рестарта:** восстановленные офлайн-участники не занимают
  место (`Room.seatedParticipantCount()`), поэтому комната без живых сокетов не
  остаётся «полной» до истечения resume-токенов. Место, удерживаемое активным
  grace-lease (обрыв в этом же процессе), по-прежнему считается занятым.
  Если «призраки» вернутся после того, как их места заняли новые участники,
  комната может временно превысить `maxParticipants`: вернувшемуся участнику
  capacity не отказывает (это тот же слот, а не новый вход);
- **биллинг после рестарта:** минуты возобновлённого звонка снова метрятся с
  момента первого resume/fresh-join (сессия переоткрывается, простой Core не
  тарифицируется); resume не увеличивает `participantJoins`. Восстановленная
  комната без единого reconnect не метрится. См. `docs/billing.md` §2.

Standby Core ничего не восстанавливает до получения лизинга: иначе два Core
подняли бы одни комнаты.

### 5.1 HA и общий стор

- Redis-режим: лидерство — единственный writer/reader восстановления; при
  demote снимки сохраняются, комнаты очищаются (`leadership_lost` — retained
  reason), новый лидер восстанавливает их из общего стора.
- Файловый стор на общем volume — то же поведение; на локальных дисках
  разных Core непрерывность между хостами отсутствует (только рестарт того же Core).

---

## 6. Resume: signaling, SFU, клиент

### 6.1 Протокол

- `welcome.resume = { token, expiresAt, graceSec }` — короткоживущий
  HMAC-токен (`r1.<payload>.<sig>`, `AGIL_RESUME_TOKEN_TTL_SEC`, 15 мин).
  Сервер хранит только `sha256(token)`; токен не логируется.
- `welcome.resumed = true` — сокет «подсажен» на существующего участника:
  `peer-left`/`peer-joined` не рассылаются, `joinedAt`/медиа-состояние
  сохраняются.
- `presence` фрейм: `{ type:"presence", participantId, presence:"reconnecting"|"online" }`.
- `RoomInfo.draining` / `RoomInfo.sfuNodeId` — состояние SFU-узла комнаты.
- `Participant.presence` — `reconnecting` для удерживаемого/восстановленного
  участника; виджет рисует этот статус в панели участников и на тайле
  (badge «Переподключается… / Reconnecting…»), а не только локальный pill.
- При `AGIL_CONTINUITY=0` `welcome.resume` **не выдаётся**: grace-lease
  выключен и `verifyResume` всегда отвергает токен, поэтому рекламировать
  capability бессмысленно.

Resume-token передаётся **только** в `Sec-WebSocket-Protocol`:
`agil-resume.<percent-encoded-token>` (рядом с `agil-token.<join-token>`),
никогда в URL — URL печатается браузером в консоль при ошибке upgrade.
Opt-in флаг `?resume=1` (не секрет) включает grace-lease для сокета.

### 6.2 Серверный grace-lease

- сокет с `?resume=1` (виджет всегда) при обрыве **не** удаляется сразу:
  `Room.markReconnecting()` заменяет соединение офлайн-заглушкой,
  присутствие → `reconnecting`, пирам уходит `presence`, а не `peer-left`;
- `AGIL_RESUME_GRACE_SEC` (по умолчанию 20 с): в окне принимается reconnect с
  валидным resume-token; иначе `peer-left` с `reason:"reconnect_timeout"`;
- Для SFU Core одновременно завершает медиасессию участника через `RemoveParticipant`
  на управляющем адресе `AGIL_SFU_URL`. Запрос использует ключ и секрет SFU
  из окружения Core. Повторный вход с тем же идентификатором ждёт завершения
  этого запроса. При ошибке Core сохраняет событие ухода и пишет предупреждение
  об очистке медиасессии в журнал.
- валидация: HMAC + `tenantId` + `roomId` + `participantId` + `exp` + совпадение
  хеша (текущего или одного предыдущего — на случай потерянного welcome);
- старые клиенты/тесты без `?resume=1` сохраняют прежнее поведение
  (немедленный `peer-left`);
- `bye` отменяет grace и завершает участие сразу.

### 6.3 Клиент (widget)

`src/call/resume-state.ts` — DOM-free автомат:

```
socket close ─► reconnecting ─► socket open ─► restoring
                                                   │ welcome.resumed
                                                   ▼
                                                restored ──(4 s)──► idle
          exhausted / rejected ─────────────────► failed  ──(8 s)──► idle
```

Решение по медиа на `welcome`:

| Условие | keepMedia | rejoinSfu | rebuildPeers |
|---|---|---|---|
| resume + SFU connected + тот же `media.room` | да | нет | нет |
| resume + SFU-токен истёк/сессия потеряна | нет | да | нет |
| resume + mesh с действующим медиасоединением | да | нет | нет |
| resume + mesh без действующих медиасоединений | нет | нет | да |
| resume отклонён сервером | нет | да (если есть media) | да |
| обычный reconnect вне автомата (switch/retry) | нет | по media | да |

- локальные треки (камера/микрофон) **никогда** не пересоздаются на обрыве;
- дубликаты: `resume` не рассылает join/leave, клиент не создаёт второй peer;
- при исчерпании backoff или истёкшем join-token виджет делает один
  `POST /v1/rooms/:id/join` с прежним `participantId` и переподключается;
  новый `SignalingClient` наследует resume-token старого и снова предлагает
  `agil-resume.<token>` в handshake. Поэтому сервер resume'ит удержанный слот,
  если он ещё жив, либо создаёт того же участника заново (fresh join), когда
  grace/TTL уже истёк;
- `presence: reconnecting` от пира виден в списке участников и на его тайле
  (badge), пока сервер держит слот; после `presence: online` badge исчезает;
- `CallState.resumeStatus` (`idle|reconnecting|restoring|restored|failed`)
  отдаётся в `on('state')`, `getStats().resumeStatus` и в pill «Соединение
  восстановлено»; в `connection-state` payload добавлены `resumeStatus` и
  `reason`.

---

## 7. Node drain

`POST /v1/admin/nodes/:nodeId/drain` (существующий endpoint) → `ClusterStore.setDrain`
→ hook `onDrainChange` → `RoomContinuity.markNodeDraining(tenantId, nodeId, drain)`.

- все комнаты тенанта, запиненные на узел, получают `draining = true`
  (и в памяти, и в снимке);
- **rejoin разрешён**: capacity/locked-проверки не меняются, участник может
  вернуться в комнату на дренируемом узле; новые *аллокации* обходят узел
  (`allocateNode` фильтрует `drain`);
- `drain:false` снимает маркер;
- tenant-scoped: комнаты другого тенанта на тот же `nodeId` не затрагиваются.

Что переживает drain: control plane и signaling комнаты — да, до её закрытия.
При аварийной остановке SFU текущие медиатранспорты прерываются. В локальном
прогоне клиенты повторно подключились к тому же звонку через оставшийся LiveKit.

---

## 8. Конфигурация

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `AGIL_CONTINUITY` | `1` | выключить весь модуль (`0`) — снимки не пишутся |
| `AGIL_ROOM_SNAPSHOT_DIR` | `<dataDir>/rooms` | каталог файлового стора |
| `AGIL_ROOM_SNAPSHOT_STORE` | `file` | `file` или `redis` (нужен `AGIL_REDIS_URL`) |
| `AGIL_ROOM_SNAPSHOT_FLUSH_MS` | `5000` | периодический flush; `0` = только события |
| `AGIL_ROOM_SNAPSHOT_MAX_AGE_SEC` | `86400` | retention комнат без TTL |
| `AGIL_RESUME_GRACE_SEC` | `20` | окно удержания presence; `0` = legacy |
| `AGIL_RESUME_TOKEN_TTL_SEC` | `900` | срок жизни resume-token |
| `AGIL_SFU_NODE_ID` | — | предпочтительная нода из карты прямых адресов при готовности и свободной ёмкости. Если ID вне карты организации, сохраняется как логическая привязка |
| `AGIL_ROOM_TTL_SEC` | `0` | TTL пустой комнаты (был и раньше) |

Диагностика в процессе: `server.continuity.stats()` →
`{ enabled, store, resumeGraceSec, restoredRooms, restoredTenants, lastRestoreAt, pendingSaves }`.

---

## 9. Безопасность и приватность

- снимок не содержит токенов, SDP/ICE, E2EE-ключей и пользовательского
  контента; только `passwordHash` (scrypt) комнаты и `sha256` resume-token;
- resume-token: HMAC-SHA256 на `AGIL_TOKEN_SECRET`, сравнение constant-time,
  привязка tenant+room+participant, TTL, ротация на каждый welcome;
- каталог снимков надо защищать как `<dataDir>` в целом: там же audit/billing;
- `AGIL_CONTINUITY=0` полностью отключает запись на диск/в Redis;
- восстановление ограничено известными тенантами — снимок чужого/удалённого
  тенанта не воскрешает данные.

---

## 10. Ограничения

1. **Нет seamless SFU failover.** Комната пиннится к узлу; при потере узла
   медиа теряется, нужен ручной reallocate/повторный вход. Drain лишь
   останавливает новые аллокации и разрешает rejoin.
2. **Continuity между разными Core** возможна только через общий стор
   (Redis или общий volume). Локальные диски — только рестарт того же Core.
3. **Окно потери данных** до `AGIL_ROOM_SNAPSHOT_FLUSH_MS` (5 с) плюс debounce:
   после жёсткого kill последние изменения mic/cam/прав могут быть старее.
4. **Контент не сохраняется:** чат, транскрипт, whiteboard, опросы и записи.
5. **Lobby/waiting room** сохраняет заявки с исходным сроком и решения. При
   включённой continuity создание, отмена, решение и получение токена ждут
   записи снимка. Ключ для расшифровки выводится из общего `AGIL_TOKEN_SECRET`.
   После выдачи токен и содержащие его ссылки удаляются из снимка до отправки
   ответа. При потере ответа после записи клиент может повторить вход, а
   прежний запрос не выдаёт токен второй раз. Breakout-подкомнаты из снимка
   восстанавливаются как обычные комнаты.
6. **Смена per-room пароля/overrides** после снимка применится только из
   актуального конфига тенанта; `passwordHash` комнаты восстанавливается из
   снимка (это поведение комнаты, не конфига).
7. **E2EE**: ключ выводится детерминированно из env (`AGIL_E2EE_SECRET`), но
   SFU-сессия после рестарта пересоздаётся; при потере SFU-узла E2EE-медиа
   не восстанавливается автоматически.
8. **Клиентский resume требует `?resume=1`.** Старые/сторонние клиенты
   сохраняют legacy-поведение (мгновенный `peer-left`).
9. **Redis-стор не заменяет leader election**: писать/восстанавливать должен
   только лидер; при split-brain возможны конфликтующие снимки (last-write-wins
   по `savedAt`, восстановление пропускает уже существующий room id).
10. **Redis — persistence, а не replication.** Он не реплицирует комнаты и не
    переживает потерю/эвикцию своих данных: без снимка комнаты не
    восстановятся. Redis-replica/Sentinel/эвикция — вне Stage 2; реальный
    Redis/Valkey не тестировался (только fake RESP-клиент).
11. **Capacity после рестарта**: офлайн-«призраки» не блокируют новые входы, но
    если они вернутся после заполнения комнаты, `participantCount` может
    временно превысить `maxParticipants`. Это осознанный компромисс: новые
    гости не должны ждать 15 минут TTL, а вернувшемуся участнику нельзя
    отказать в его собственном слоте.
12. **Биллинг после рестарта**: простой между рестартом Core и первым
    reconnect не тарифицируется; сессия минут переоткрывается с момента
    первого resume/fresh-join. `participantJoins` не считает resume и
    duplicate-socket замены.

---

## 11. Тесты

Сервер (`agil/core/apps/server/test/continuity.test.ts`, 14 тестов):

```bash
cd agil/core/apps/server
npx tsx --test test/continuity.test.ts
npx tsx --test test/billing.test.ts
npx tsx --test test/ws.test.ts
```

Покрыто: snapshot/restore через рестарт (комната, участники, права, SFU-node,
`createdAt`), duplicate join + resume без peer-churn и без дублей, **минуты
возобновлённого после рестарта звонка** (P2-1), **capacity без офлайн-призраков
и с удержанием места на grace-lease** (P2-2), **legacy duplicate socket не
увеличивает `participantJoins`** (P3-1), отсутствие `welcome.resume` при
`AGIL_CONTINUITY=0` (P3-3), **flushAll не воскрешает закрытую комнату и
сохраняет снимок при shutdown/demote** (P3-6),
TTL/sweep и удаление снимка пустой комнаты, tenant isolation
(list/get/restore/токен), node drain + rejoin + tenant-scope,
Redis-стор (layout, индексы, деградация в зеркало, **pruning протухших
индексов** — P3-7), file store с хешированным tenant-каталогом (P3-7).

Клиент (`agil/websdk/widget/test/resume-state.test.ts`, 9 тестов +
`custom-ui.test.ts`):

```bash
cd agil/websdk/widget
node --import tsx --import ./test/register-loader.mjs --test test/resume-state.test.ts test/custom-ui.test.ts
npm run typecheck
```

Покрыто: матрица reconnect-решений (keep SFU / rejoin SFU / rebuild mesh /
rejected), сохранение локальных треков, отсутствие дубликатов, settle/reset,
subprotocol resume-token без дублей и с percent-encoding, **перенос
resume-token в replacement-клиент `recoverSession()`** (P3-2), **отрисовка
`presence: reconnecting` в панели участников и на тайле** (P3-4).

Регрессии: `test/ws.test.ts`, `test/tokens-join.test.ts`,
`test/breakouts.test.ts` (server) и весь widget unit suite — зелёные.

---

## 12. Файлы

- `agil/core/apps/server/src/continuity.ts` — снимки, стор (file/redis/memory),
  restore, TTL, resume-token, node drain, pruning индексов, защита от
  resurrection закрытой комнаты при flush.
- `agil/core/apps/server/src/rooms.ts` — `RoomRegistry.restore`,
  `Room.resumeMember`, `Room.markReconnecting`, offline-соединения,
  `seatedParticipantCount` (capacity), draining.
- `agil/core/apps/server/src/billing.ts` — метринг минут по `joined`/`resumed`/
  `left`/`closed` (resume переоткрывает сессию, duplicate socket не считается
  join).
- `agil/core/apps/server/src/signaling.ts` — resume subprotocol, grace-lease,
  `presence`-фреймы, восстановление после снимка, sweep офлайн-участников,
  capacity по seated-участникам.
- `agil/core/apps/server/src/index.ts` — wiring: restore после `leader.start()`,
  flush на shutdown/demote, Redis-стор, drain-hook.
- `agil/core/apps/server/src/cluster.ts` — `onDrainChange` hook.
- `agil/core/apps/server/src/env.ts` — новые env-флаги.
- `agil/core/packages/protocol/src/signaling.ts` — `welcome.resume/resumed`,
  `presence`, `RoomInfo.draining/sfuNodeId`, `Participant.presence`.
- `agil/websdk/widget/src/call/resume-state.ts` — клиентский автомат.
- `agil/websdk/widget/src/call/signaling-client.ts` — resume subprotocol,
  перенос resume-token в replacement-клиент.
- `agil/websdk/widget/src/index.ts` — wiring статусов, keep/rejoin SFU,
  token-refresh + reconnect, `presence`-обработка.
- `agil/websdk/widget/src/ui/participants-panel.ts`,
  `src/ui/video-tile.ts` — отрисовка `presence: reconnecting` у пиров.
- `agil/websdk/widget/test/resume-state.test.ts` — unit-тесты автомата и
  переноса resume-token.
