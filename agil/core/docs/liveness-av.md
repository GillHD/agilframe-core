# Liveness и антивирусная проверка загрузок

Бесплатный/open-source baseline для двух задач:

1. **Liveness** — сервер выдаёт случайное задание, браузер проверяет его локально
   (MediaPipe), сервер выносит **советующее** (advisory) решение. Видео не
   покидает устройство участника.
2. **AV-скан загрузок** — ClamAV (clamd, `INSTREAM`) и/или YARA как **внешние
   процессы**, карантин, аудит и явная политика fail-open/fail-closed.

Обе функции **выключены по умолчанию**: liveness — флагом тенанта (движок есть,
но не используется), AV — отсутствием настроенного движка и флагом тенанта.

Результат проверки подлинности служит ориентиром для модерации. На него влияют
сигналы браузера и состояние движка liveness. В настройках подлинности медиа
поле `security.mediaIntegrity.externalProvider` хранится для совместимости.
Для подключения внешнего движка серверного liveness используют `AGIL_LIVENESS_ENGINE`
и `AGIL_LIVENESS_URL`.

| Что | Где | По умолчанию |
|---|---|---|
| Liveness challenge/verify | `POST /v1/rooms/{roomId}/liveness/challenge`, `POST /v1/rooms/{roomId}/liveness/{sessionId}/verify` | флаг `security.liveness.enabled=false` → 403 `liveness_disabled` |
| Liveness-движок | `ChallengeLivenessEngine` (free) / `HttpLivenessEngine` (self-hosted) | `challenge`; внешний — только с `AGIL_LIVENESS_ENGINE=external` + `AGIL_LIVENESS_URL` |
| AV-движок | `ClamAvScanner` (clamd), `YaraScanner` (CLI), `CompositeAvScanner` | нет движка → AV не работает |
| Флаг AV | `security.avScan.enabled` | `false` (файл сохраняется без скана) |
| Карантин | `<AGIL_DATA_DIR>/quarantine` + `GET/DELETE /v1/admin/quarantine` | пусто; payload никогда не отдаётся по HTTP |
| Аудит | `liveness.*`, `file.scanned`, `file.quarantined`, `file.quarantine_failed`, `file.scan_unavailable` | JSONL audit + ring; вебхук `security.event` |

Пакеты: `@agil/security` (`liveness.ts`, `av.ts`, `quarantine.ts`,
`upload-scan.ts`), контракт — `@agil/protocol` (`liveness.ts`, `config.ts`),
эндпоинты — `apps/server/src/public-api.ts`/`admin-api.ts`, клиент —
`agil/websdk/widget/src/call/integrity.ts`.

---

## 1. Liveness (advisory, не сертификация)

### 1.1 Флаг, движки, env

| Env | Default | Смысл |
|---|---|---|
| `AGIL_LIVENESS_ENGINE` | `challenge` | `challenge` = встроенный бесплатный движок; `external` = self-hosted HTTP-детектор |
| `AGIL_LIVENESS_URL` | — | база self-hosted детектора (`http://liveness:8080`); пусто → движок не сконфигурирован → 501 |
| `AGIL_LIVENESS_KEY` | — | Bearer для детектора (никогда не логируется) |
| `AGIL_LIVENESS_TIMEOUT_MS` | `5000` (500..30000) | таймаут запроса к детектору |
| `AGIL_LIVENESS_TTL_SEC` | `180` (30..600) | TTL задания |
| `AGIL_LIVENESS_MAX_ATTEMPTS` | `2` (1..10) | попыток на одну сессию |

Движки подключаемые (`LivenessEngine`): `ChallengeLivenessEngine` (по умолчанию,
без внешних зависимостей) и `HttpLivenessEngine` — **только self-hosted**
модель (Silent-Face-Anti-Spoofing, DeepFace и т.п.), никаких платных API.
Для тестов/встраивания есть seam `createAgilServer({ securityEngines: {
livenessEngine } })`. В дашборде — «Безопасность» → блок «Серверный
liveness-челлендж» (флаг + политика ошибок).

### 1.2 Контракт API

`POST /v1/rooms/{roomId}/liveness/challenge` (Bearer join-token; токен должен
принадлежать этой комнате):

```json
{ "sessionId": "uuid", "task": "blink|head-left|head-right",
  "issuedAt": 1700000000000, "expiresAt": 1700000180000, "ttlSec": 180,
  "engine": "challenge", "advisory": true }
```

`POST /v1/rooms/{roomId}/liveness/{sessionId}/verify`:

```json
{ "signals": { "faceDetected": true, "blinkDetected": true,
               "headTurnDetected": false, "modelAvailable": true,
               "confidence": 0.87, "framesAnalyzed": 42, "durationMs": 3100 } }
```

Ответ: `{sessionId, passed, status, score, flags, engine, attempts, maxAttempts,
advisory}`; `status ∈ verified|failed|unavailable|invalid|expired`. Все поля
`signals`, кроме схемы, ограничены по диапазону (`confidence` 0..1,
`framesAnalyzed` ≤100000, `durationMs` ≤600000) — тело валидируется zod.

Сервер проверяет, что присланный сигнал соответствует выданному заданию:
`blink` → `blinkDetected`, `head-left|head-right` → `headTurnDetected`.
`modelAvailable:false` → `unavailable` (не обвинение), `faceDetected:false` →
`failed` с флагом `no_face`, отсутствие сигнала → `failed`
(`liveness_signal_missing`), низкая `confidence` (<0.4) добавляет флаг
`low_confidence`, но не валит попытку.

Коды ошибок: `403 liveness_disabled` (флаг тенанта), `501
liveness_not_configured` (движок не сконфигурирован), `401/403/404` — токен и
комната, `400 validation_failed` — тело/`sessionId` (строгий
`[A-Za-z0-9-]{1,64}`), `429` — rate limit (20 запросов/мин на tenant+participant).

### 1.3 Политика

- Сессии **tenant-scoped** (`tenantId:sessionId`), привязка к комнате и
  участнику; чужая комната/участник → `invalid` без расходования чужой сессии.
- Одна успешная попытка **расходует** сессию (повтор → `invalid`); лимит попыток
  исчерпан → `expired`.
- Сессии **не персистятся** (in-memory, ограниченный store, ≤10000, sweep без
  таймеров): liveness — сигнал «здесь и сейчас», после рестарта он бессмыслен.
- Политика ошибок движка — `security.liveness.onEngineError`:
  - `fail-open` (default) — таймаут/ошибка/недоступность → `unavailable`, участник
    **не** обвиняется, UI деградирует в локальную проверку;
  - `fail-closed` — то же событие → `failed` + флаг
    `liveness_engine_unavailable_fail_closed`.
- `passed` **не** является доказательством личности; при `verified` участнику
  ставится `integrity: verified`, при `failed` — `unknown` (не `suspicious`),
  чтобы неудачная проверка не выглядела как обвинение в дипфейке.

### 1.4 Виджет

- При `security.liveness.enabled` виджет запрашивает challenge на входе в звонок,
  показывает задание (тосты `livenessBlink|livenessHeadLeft|livenessHeadRight`),
  прогоняет MediaPipe Face Landmarker **локально** и отправляет только сигналы.
- Сервер недоступен → тост `livenessServerUnavailable`, остаётся локальная
  проверка (звонок не блокируется).
- Модель не загрузилась (CDN закрыт) → тост `livenessUnavailable`, на сервер
  уходит `modelAvailable:false` для аудита, «фальшивого» pass нет.
- Легаси-режим `security.mediaIntegrity.livenessChallenge` (локальная задача без
  HTTP) сохранён для тенантов, которым серверный эндпоинт не нужен.

### 1.5 Аудит

Типы audit: `liveness.challenge` (info), `liveness.verified` (info),
`liveness.failed` (warn), `liveness.unavailable` (info). При `failed` уходит
вебхук `security.event` с `kind:'liveness.failed'`, `score`, `flags`, `engine`.
`details` не содержит кадров/изображений — только сигналы, score и engine.

### 1.6 Честные ограничения

- Сигналы формирует браузер: их можно подделать (расширение/скрипт). Проверка
  ловит случайного нарушителя, а не целенаправленную атаку.
- Запись с заранее снятым «морганием/поворотом» и её воспроизведение может
  пройти задание; случайность задания лишь повышает стоимость атаки.
- Нет пассивной deepfake-детекции, voice-clone/liveness, привязки к личности,
  проверки документа, C2PA-провенанса.
- Вердикт всегда `advisory: true` и не является юридическим доказательством;
  не сертифицирован по ISO/IEC 30107-3 (PAD) и не заменяет KYC.
- Сессии живут в памяти процесса: при рестарте/переключении лидера проверка
  теряется (это осознанно, см. §1.3).

---

## 2. Антивирусная проверка загрузок (ClamAV / YARA)

### 2.1 Флаг, env

| Env | Default | Смысл |
|---|---|---|
| `AGIL_CLAMAV_HOST` | — | TCP-хост clamd; пусто = ClamAV не используется |
| `AGIL_CLAMAV_PORT` | `3310` | TCP-порт clamd |
| `AGIL_CLAMAV_SOCKET` | — | unix-socket clamd (`/var/run/clamav/clamd.ctl`); приоритетнее host/port |
| `AGIL_CLAMAV_TIMEOUT_MS` | `10000` (500..60000) | таймаут скана (движок дополнительно клампит 100 мс..120 с) |
| `AGIL_YARA_RULES` | — | путь к `.yar`/`.yara`; пусто = YARA выключена |
| `AGIL_YARA_BIN` | `yara` | CLI (BSD-3-Clause) |
| `AGIL_AV_CONCURRENCY` | `1` (1..4) | параллельных сканов |
| `AGIL_AV_QUEUE_LIMIT` | `50` (1..1000) | размер очереди до применения error-политики |
| `AGIL_AV_QUEUE_DIR` | `<AGIL_DATA_DIR>/av-queue` | durable-spool принятых async-заданий (payload + метаданные) |
| `AGIL_QUARANTINE_DIR` | `<AGIL_DATA_DIR>/quarantine` | каталог карантина |

Политика тенанта (`security.avScan`, deep-partial patch требует **все** поля):

```json
{ "security": { "avScan": { "enabled": true, "mode": "async",
  "onScanError": "fail-open", "maxScanMb": 25 } } }
```

При `enabled:false` (default) файл сохраняется без скана, событий нет.
В дашборде — «Безопасность» → блок «Антивирусная проверка загрузок» (флаг,
режим, политика ошибок, `maxScanMb`).

### 2.2 Движки

- **ClamAvScanner** — протокол clamd `INSTREAM` (команда `zINSTREAM\0`, кадры
  `uint32 BE length` + байты, терминатор длиной 0), TCP или unix-socket,
  zero-dependency (`node:net`). Ответ разбирается как `stream: OK` /
  `stream: <Signature> FOUND`; любой другой ответ — `error`, не «clean».
- **YaraScanner** — `yara [-w] <rules> <tmpfile>`; файл пишется с правами `0600`
  и удаляется в `finally`, exit code 1 = совпадение правил (валидный скан),
  timeout/2+ = scanner error.
- **CompositeAvScanner** — заражение любого движка побеждает; иначе ошибка любого
  движка поднимается как `error` (чтобы fail-closed сработал); `clean` только
  если все настроенные движки ответили `clean`/`skipped`.
- Движок **никогда не бросает** на scanner-сбое: возвращает `status:'error'`
  (контракт `AvScanner`), решение принимает `UploadScanService`.

Лимиты движка: ClamAV пропускает файлы >64 MiB (`skipped`), YARA — >25 MiB;
дополнительно тенантский `maxScanMb` (1..100, default 25) отсекает файл до
отправки в демон.

### 2.3 Политика скана (`UploadScanService`)

| Режим | Поведение |
|---|---|
| `async` (default) | Загрузка сразу получает 200 + запись с подписанной ссылкой; скан идёт в bounded-очереди, при заражении копия удаляется и уходит в карантин. Ссылка после этого отдаёт 403. Принятая задача **сначала пишется на диск** (`AGIL_AV_QUEUE_DIR`) и восстанавливается после рестарта. |
| `sync` | Ответ ждёт вердикт. `infected` → `422 file_infected`; `error` при `fail-closed` → `503 scan_unavailable`; `error` при `fail-open` → 200 (файл остаётся). |

- `onScanError:'fail-open'` (default) — «демон недоступен» не блокирует файлообмен;
  файл остаётся непроверенным, но это **явно** пишется в аудит (`file.scanned`,
  severity `warn`).
- `onScanError:'fail-closed'` — непроверенные байты не отдаются: в `async` файл
  удаляется и уходит в карантин (клиент уже получил 200 — ссылка перестаёт
  работать), в `sync` загрузка отклоняется `503`.
- Очередь ограничена (`AGIL_AV_QUEUE_LIMIT`) и однопоточная по умолчанию: clamd
  обрабатывает один `INSTREAM` за раз, а неограниченная буферизация 25 MiB —
  memory-DoS. Переполнение применяет ту же error-политику.
- **Durability (crash/restart).** Перед ответом `queued` сервис пишет payload
  (`<id>.bin`, mode `0600`) и атомарно (tmp+rename) метаданные политики
  (`<id>.json`) в `AGIL_AV_QUEUE_DIR`; запись удаляется только после завершения
  скана. При старте Core `recoverPending()` перечитывает незавершённые задания и
  сканирует их заново, поэтому `fail-closed` не теряется между 200 и сканом. Если запись
  в spool не удалась, загрузка **не** подтверждается как `queued`: скан
  выполняется inline (ответ ждёт вердикт), чтобы не принять непроверенные байты.
  **Если при рестарте движок не настроен** (убрали `AGIL_CLAMAV_*`/`AGIL_YARA_RULES`
  или ошиблись в деплое, `isEnabled() === false`), восстановленные задания всё
  равно **fail-closed**: `scan_error`, карантин, удаление живой копии, block-маркер
  и critical `file.scan_unavailable` (audit + `security.event` /
  `kind:'scan_unavailable'`, `recovered:true`). Рестарт без сканера не может
  «разморозить» ранее принятый файл (QA P2-3-R).
  Гарантия — at-least-once: падение между сканом и удалением spool-файла может
  повторить скан/событие (`security.event`, `file.shared` или
  `file.scan_unavailable`), но не потерять его.
  Повреждённые/усечённые spool-файлы не сканируются как «чистые»: файл
  удаляется/блокируется с `scan_error` (fail-closed) — см. тест.
  Размер spool ограничен очередью (`queueLimit` × `maxUploadMb`); каталог должен
  лежать на защищённом диске, как карантин.
- Файлы больше `maxScanMb` не буферизуются в демон: `skipped` (документированный
  лимит), политика сбоя **не** применяется.
- Сканируются только пользовательские загрузки `POST /v1/files`; записи
  (`/v1/recordings`) не сканируются (это видео самого клиента — см. §2.7).

### 2.4 Карантин и admin API

- Запись: `<dir>/<uuid>` (payload) + `<dir>/<uuid>.json` (метаданные) — та же
  безопасная схема id, что у `FileStore`; tenantId, roomId, sourceId, имя, MIME,
  размер, SHA-256, reason (`infected|scan_error|manual`), engine, signature,
  detail, `quarantinedAt`, `uploadedBy`.
- Payload карантина **никогда** не отдаётся по HTTP (только метаданные): отдавать
  живой malware обратно — новая уязвимость.
- `GET /v1/admin/quarantine?limit=` — список по тенанту (метаданные +
  `downloadable:false`), `DELETE /v1/admin/quarantine/{id}` — purge (tenant-scoped,
  чужой id → 404, без утечки существования). Purge пишется в аудит как
  `admin.action` (`kind:'quarantine.purged'`).
- Удаление живой копии выполняется даже если запись карантина не удалась. Если
  удалить копию не удалось, файл помечается в `<quarantine>/blocked/` как
  «не отдавать»: `GET /v1/files/:id` отвечает `403`, даже когда байты физически
  остались на диске; маркер переживает рестарт и tenant-scoped. Такая ситуация
  (включая полный отказ — не записался карантин и не удалилась копия) пишется
  как **critical** `file.quarantine_failed` + `security.event` /
  `kind:'file.quarantine_failed'` с `fileId`, `archived`, `blocked`,
  `blockPersisted`, `error`/`removeError`; запись карантина (если она всё же
  удалась) дополнительно даёт `file.quarantined`. Payload не отдаётся никогда,
  но если диск/права не позволяют удалить файл, оператору нужно удалить его
  вручную (fileId есть в аудите). Серверный слой пишет block-маркер для любого
  `blocked`-вердикта (включая восстановленное без сканера задание), не полагаясь
  только на успешное удаление живой копии.

### 2.5 Аудит и вебхуки

- `file.scanned` — каждый завершённый скан (`info`, `warn` при ошибке), детали:
  `fileId`, `engine`, `status`, `signature?`, `quarantined`, `removed`, `blocked`.
- `file.quarantined` — severity `critical`, детали: `quarantineId`, `fileId`,
  `engine`, `reason`, `signature?`, `size`, `sha256`.
- `file.quarantine_failed` — severity `critical`, когда живую копию не удалось
  удалить: `fileId`, `quarantineId?`, `reason`, `archived`, `removed:false`,
  `blocked:true`, `blockPersisted`, `error?`/`removeError?`.
- `file.scan_unavailable` — severity `critical`, когда принятое/восстановленное
  задание не удалось просканировать из-за отсутствия настроенного движка
  (`isEnabled() === false`): `fileId`, `reason:'scan_error'`, `recovered`,
  `engine`, `blocked`, `quarantined`, `removed`. Вебхук `security.event` /
  `kind:'scan_unavailable'`. Файл уже изолирован/удалён — это сигнал о
  fail-closed bypass-попытке (рестарт без сканера), а не «файл безопасен».
- Вебхук `security.event` / `kind:'file.quarantined'` — для SIEM/алертинга;
  эмитится один раз из callback'а сканера (вместе с аудитом), поэтому работает и
  для async-сканов. При отказе удаления дополнительно уходит
  `security.event` / `kind:'file.quarantine_failed'`, а при отсутствии движка —
  `security.event` / `kind:'scan_unavailable'`.
- `file.shared` — **ровно один** вебхук на успешно сохранённый файл:
  - AV выключен (`enabled:false`) — сразу после записи файла (как и аудит);
  - AV включён (`sync` или `async`) — только после вердикта, при котором файл не
    заблокирован (`clean`, `skipped`, `error` при `fail-open`); для `async`
    событие приходит после скана, а не до него;
  - для `infected` и `fail-closed`-ошибок (`blocked:true`) — **никогда**, даже
    если карантин/удаление не удались. Аудит `file.shared` пишется провайдером
    при сохранении (до скана) — это журнал записи, а не контракт интеграции.

### 2.6 EICAR и как проверить вручную

EICAR — безвредная 68-байтная тестовая строка; в репозитории она **собирается в
runtime** (`EICAR_TEST_STRING` из трёх частей), чтобы антивирусы не помечали
исходники. Тесты:

- `packages/security/test/av.test.ts` — реальный `INSTREAM` (loopback-сервер
  clamd-эмулятор), EICAR → `infected` + `Eicar-Test-Signature`, таймауты,
  `parseClamAvResponse`, композит;
- `packages/security/test/upload-scan.test.ts` — fake-движки: async/sync,
  fail-open/fail-closed, переполнение очереди, oversized, двойной отказ
  карантина/блокировка, durable spool + restart/truncated recovery;
- `apps/server/test/liveness-av.test.ts` — эндпоинты с fake-движками: liveness
  (403/501/verified/failed/unavailable/audit), AV (EICAR → 422, карантин,
  tenant-scoping, purge, async-карантин, 503 при fail-closed), ровно один
  `file.shared` для AV-off/clean и ни одного для quarantined, критический
  `file.quarantine_failed` + restart recovery;
- `websdk/widget/test/liveness.test.ts` — клиент: server challenge, недоступная
  модель → `modelAvailable:false` (без фальшивого pass), сервер недоступен →
  локальная деградация.

Ручная проверка (если clamd запущен; EICAR создаётся вручную и удаляется):

```bash
# The 68-byte EICAR literal is split into three parts (same hygiene as the code
# in av.ts): a monolithic string in docs can be flagged by endpoint AV/email
# scanners on clone or review.
printf '%s%s%s' \
  'X5O!P%@AP[4\PZX54(P^)7CC)7}$' \
  'EICAR-STAN' \
  'DARD-ANTIVIRUS-TEST-FILE!$H+H*' > /tmp/eicar.com
curl -fsS -H "authorization: Bearer $TOKEN" -H 'x-file-name: eicar.com' \
     -H 'content-type: application/octet-stream' \
     --data-binary @/tmp/eicar.com "$AGIL_PUBLIC_ORIGIN/v1/files"
rm -f /tmp/eicar.com
```

Ожидание при `security.avScan.enabled=true`: `200` (async, затем карантин) или
`422 file_infected` (sync), запись в `GET /v1/admin/quarantine`.

### 2.7 Честные ограничения

- Сигнатурный AV не ловит zero-day; ClamAV — базовый слой, не замена EDR/песочнице.
- `fail-open` по умолчанию означает, что при недоступном демоне файл остаётся
  непроверенным (но это видно в аудите). Для строгого режима включайте
  `fail-closed` — и следите за health clamd, иначе загрузки начнут отклоняться.
- В `async` есть окно между 200 и сканом, в течение которого подписанная ссылка
  работает; после карантина — 403. Это окно **переживает рестарт**: принятая
  задача лежит в `AGIL_AV_QUEUE_DIR` и будет досканирована (а при отсутствии
  движка — fail-closed изолирована с critical `file.scan_unavailable`);
  at-least-once может повторить скан/событие после падения между
  скан-вердиктом и очисткой spool (два одинаковых события в редком окне), но не
  теряет `fail-closed`.
- Если удалить живую копию не удалось, файл блокируется на уровне download
  (`blocked/`), но байты остаются на диске — это аварийная ситуация для
  оператора (см. §2.4), а не «тихий» warning.
- Проверяются только `/v1/files`; записи/транскрипты/аватары не сканируются.
- Ограничение размера (`maxScanMb`/`maxUploadMb`) — не защита от zip-бомб внутри
  архива (ClamAV имеет собственные лимиты распаковки; настраивайте clamd).
- YARA-правила пишет оператор; качество детекции = качество правил.
- Карантин лежит на том же диске и не шифруется: доступ ограничен файловой
  системой и API (payload не отдаётся), но это не WORM-хранилище.
- Liveness и AV не связаны: успешный liveness не делает файлы «доверенными».

---

## 3. Лицензии (что можно и что нельзя)

| Компонент | Лицензия | Как используется | Обязательства |
|---|---|---|---|
| ClamAV / clamd | **GPL-2.0** | отдельный процесс/контейнер, обмен по документированному `INSTREAM` через сокет | Код GPL **не линкуется** и не копируется в `@agil/security`, поэтому GPL не «заражает» сервер. При распространении модифицированного ClamAV — обычные GPL-обязательства (исходники/уведомления). |
| ClamAV virus DB (freshclam) | условия ClamAV | обновляется `freshclam` на стороне эксплуатации | Не вендорим базу в репозиторий; актуализация — обязанность деплоя. |
| YARA (CLI) | **BSD-3-Clause** | необязательный внешний бинарник | сохранение copyright notice при распространении бинарника. |
| MediaPipe Tasks Vision `0.10.14` | **Apache-2.0** | ленивая загрузка JS/wasm из CDN браузером | NOTICE/attribution при распространении; сервер не зависит. |
| Модель `face_landmarker.task` | Apache-2.0 (проверяйте конкретную модель) | загружается браузером с Google Storage | атрибуция; CDN можно заблокировать — есть деградация. |
| OpenCV (если используется в своём детекторе) | **Apache-2.0** (4.x) | не входит в репозиторий | — |
| Silent-Face-Anti-Spoofing | **Apache-2.0** | опциональный self-hosted детектор | не входит в поставку; запускается отдельно. |
| DeepFace | **MIT** | опциональный self-hosted детектор | — |
| EICAR test file | стандартный тестовый артефакт | строка собирается в runtime | безвреден; не коммитить как файл. |
| Платные API | — | **не используются** | сознательное ограничение: только free/OSS. |

Итог: в серверный процесс не попадает GPL-код; ClamAV остаётся отдельным
процессом, YARA — отдельным CLI. Это же правило нужно сохранять при доработках
(не переносить код clamd/YARA внутрь `@agil/security`).

---

## 4. Внешние бинарники и модели (что нужно «извне»)

В репозитории **нет** вендоренных бинарников/моделей; тесты работают без сети и
без демонов.

| Зависимость | Где нужна | Обязательна | Где взять |
|---|---|---|---|
| `clamd` (ClamAV ≥1.0) | сервер/контейнер рядом с Core | для ClamAV-скана | дистрибутив/официальный образ `clamav/clamav` |
| `freshclam` + актуальный CVD | там же | для ClamAV-скана | обновление баз по расписанию |
| `yara` CLI | сервер (если включён YARA) | опционально | пакет дистрибутива |
| Правила YARA | файл, путь в `AGIL_YARA_RULES` | опционально | собственные/публичные правила (проверять лицензию правил) |
| MediaPipe `tasks-vision@0.10.14` + `face_landmarker.task` | браузер участника (CDN) | для локальной проверки | jsDelivr + Google Storage; при блокировке — `unavailable` |
| Self-hosted liveness-детектор | отдельный сервис, `AGIL_LIVENESS_URL` | опционально | Silent-Face-Anti-Spoofing / DeepFace |
| `curl`/`printf` | ручной smoke (не автоматика) | нет | — |

Никакой платный API не вызывается ни в liveness, ни в AV.

---

## 5. Развёртывание (пример; в этой задаче деплой не выполнялся)

`clamd` — отдельный сервис с unix-socket в общем volume; Core получает
`AGIL_CLAMAV_SOCKET`. Фрагмент compose (адаптируйте под свой проект):

```yaml
services:
  clamav:
    image: clamav/clamav:1.4
    volumes:
      - clamav-run:/run/clamav
    restart: unless-stopped
  core:
    # ... существующий сервис Core
    environment:
      AGIL_CLAMAV_SOCKET: /run/clamav/clamd.ctl
      AGIL_CLAMAV_TIMEOUT_MS: "10000"
      # AGIL_YARA_RULES: /etc/agil/rules/custom.yar
    volumes:
      - clamav-run:/run/clamav:ro
volumes:
  clamav-run:
```

Важно: в quickstart compose Core получает **явный** список env — новые
`AGIL_CLAMAV_*`/`AGIL_LIVENESS_*` нужно добавить в этот список вручную (или
передать через `environment:` своего деплоя), иначе переменные не дойдут.
Проверка после запуска: `GET /v1/health` не меняется, а факт ошибки скана виден в
аудите (`file.scanned`, `warn`) и в логах `av`; readiness clamd — `clamdcheck`
или `docker exec clamav clamdcheck`.

Отключить всё можно, не меняя код: `security.avScan.enabled=false` (или убрать
`AGIL_CLAMAV_*`/`AGIL_YARA_RULES`) и `security.liveness.enabled=false`.

---

## 6. Карта тестов

| Файл | Что покрывает |
|---|---|
| `packages/security/test/liveness.test.ts` | движки, TTL/попытки, tenant-scoping, fail-open/closed, HTTP-detector (таймаут/мусор), «нет движка» → `SecurityError` |
| `packages/security/test/av.test.ts` | `INSTREAM`-фрейминг, парсинг ответов, EICAR, таймауты/недоступность, YARA CLI, композит |
| `packages/security/test/upload-scan.test.ts` | async/sync, карантин + callback, fail-open/closed, очередь/oversized, выключенный флаг, двойной отказ карантина (fault injection) + durable-block маркер, crash/restart recovery из spool, **restart без сканера → fail-closed (`scan_unavailable`)**, fallback inline при недоступном spool |
| `apps/server/test/liveness-av.test.ts` | HTTP-эндпоинты: 403/501, advisory-контракт, аудит, EICAR → 422/карантин/purge/403 после карантина, async-карантин, 503 fail-closed, ровно один `file.shared` для AV-off/async-clean/sync-clean и ни одного для quarantined, critical `file.quarantine_failed` + блокировка download при двойном отказе, restart без сканера → критический `file.scan_unavailable` + 403 |
| `apps/dashboard/test/security-liveness-av.test.ts` | дефолты блоков liveness/AV (выключены, async/fail-open/25 MB) и полный save-payload (`liveness` + `avScan`) |
| `websdk/widget/test/liveness.test.ts` | клиент: вызов challenge/verify, `modelAvailable:false` без фальшивого pass, деградация при недоступном сервере |

---

## 7. Чек-лист эксплуатации

- [ ] clamd поднят, `clamdcheck` проходит, `freshclam` обновляет базу.
- [ ] `AGIL_CLAMAV_SOCKET`/`HOST` передан Core; в аудите появляются `file.scanned`.
- [ ] Выбрана политика: `mode` (async/sync) и `onScanError` (fail-open/fail-closed)
      осознанно; для fail-closed настроен алерт на `file.scanned` severity=warn.
- [ ] `maxScanMb` согласован с `AGIL_MAX_UPLOAD_MB` и лимитами clamd.
- [ ] Каталог карантина на отдельном разделе с ограниченным доступом; purge —
      через `DELETE /v1/admin/quarantine/{id}` (аудит `admin.action`).
- [ ] `AGIL_AV_QUEUE_DIR` на защищённом диске с запасом под `queueLimit ×
      maxUploadMb`; после рестарта в логе есть `recovered pending antivirus
      scans`, а `file.quarantine_failed` и `file.scan_unavailable` настроены как
      critical-алерты (последний ловит рестарт без сканера).
- [ ] Liveness: решение, нужен ли серверный челлендж; если да — выбран движок и
      `onEngineError`; команда понимает, что вердикт advisory.
