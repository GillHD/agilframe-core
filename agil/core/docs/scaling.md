# Масштабирование: тысячи участников, мульти-нода, TURN-пул, SFU и стримы

Документ описывает **заложенную возможность** масштабирования и вещания на
тысячи зрителей. Важно: в текущем MVP реально работает **mesh-режим** — P2P для
звонка один на один (2 участника) и небольшой групповой mesh (до 8 участников)
на одном узле; для 3+ участников рекомендуется SFU. Конфигурация
мульти-ноды/SFU/TURN-пула/стримов принимается, валидируется, отдаётся через
admin API и влияет на выдачу ICE-серверов и лимитов комнат, но **оркестрация
кластера и SFU ещё не реализована** — тестировать этот функционал пока не на
чем (см. §9). Контракт нужен, чтобы интеграторы и дашборд могли готовить
инфраструктуру заранее.

## 1. Сценарии

| Сценарий | Участники | Медиа-режим |
|---|---|---|
| Личный звонок 1:1 (`mode:'direct'`, `transport:'p2p'`) | 2 | `mesh` (P2P, без серверного медиа) |
| Групповой звонок | 3–8 на mesh; 3+ с настроенным SFU | `sfu` (рекомендуется для 3+), небольшой `mesh` — запасной |
| Вебинар | 1–50 спикеров + 100–10 000 зрителей | `broadcast` (SFU + receive-only зрители) |
| Стрим на внешнюю площадку | зрители на YouTube/VK/сайте | `broadcast` + RTMP/HLS egress |
| Крупная конференция | до нескольких тысяч | SFU-пул + CDN + мульти-нода сигналинга |

### 1.1 P2P только для 1:1, SFU для 3+

`mode:'direct', transport:'p2p'` — явный P2P-режим: ровно 2 места,
`mediaMode:'mesh'`, медиа идёт между браузерами и не проходит через сервер
(`docs/p2p.md`). Он не масштабируется и **не** является режимом для 200
участников: P2P отклоняется для `group` (400), при `maxParticipants > 2` (400) и
при включённых серверных egress/стримах/вебинарах (409 `p2p_unsupported`).
Локальная запись в браузере остаётся доступной.

Для 3+ участников используйте SFU. `transport:'sfu'` (или отсутствие
`transport`) сохраняет текущее поведение: эффективный режим берётся из
`scale.mediaMode`; на mesh-тенанте direct-комната останется mesh, на SFU-тенанте
получит серверную медиасессию. Ёмкость 200 участников относится только к
SFU/broadcast и требует профиля `high` и нагрузочного теста — см.
`large-rooms.md`.

## 2. Конфигурация тенанта: `TenantConfig.scale`

```jsonc
{
  "scale": {
    "mediaMode": "mesh",              // mesh | sfu | broadcast
    "maxParticipants": 200,           // дефолт на комнату (2..50000); stage 1
    "maxVideoSubscriptions": 36,      // жёсткий потолок видео-потоков клиента (SFU)
    // "maxVisibleVideos": 2,          // опционально: бюджет видео на страницу галереи
    // адаптивный дефолт: ≤8 — все видимые, 9+ — бюджет профиля ёмкости
    // (low 2 / standard 6 / high 12; pinned + active speaker первыми)
    "signaling": {
      "nodeId": "node-1",
      "redisUrl": "redis://redis:6379",       // пусто = single-node
      "pubsubChannel": "agil:signaling",
      "stickySessions": true,
      "nodes": [
        { "id": "node-1", "url": "https://calls-1.example", "region": "ru-msk", "weight": 100 },
        { "id": "node-2", "url": "https://calls-2.example", "region": "ru-spb", "weight": 100 }
      ]
    },
    "sfu": {
      "provider": "livekit",          // livekit | mediasoup | external
      "url": "wss://sfu.example",
      "apiKeyEnv": "AGIL_SFU_API_KEY",
      "apiSecretEnv": "AGIL_SFU_API_SECRET",
      "region": "ru-msk",
      "maxParticipants": 5000,
      // Профиль ёмкости: low | standard | high.
      // Переопределяется env AGIL_SFU_PROFILE (деплой), иначе standard.
      // Участников на ноду: low 25, standard 50, high 200; эффективный лимит
      // комнаты = min(room.maxParticipants, scale.maxParticipants,
      // profile.participants, sfu.maxParticipants).
      "capacityProfile": "standard"
    },
    "turn": [
      {
        "id": "turn-msk",
        "urls": ["turn:turn-msk.example:3478?transport=udp", "turns:turn-msk.example:5349"],
        "username": "agil",
        "credentialEnv": "AGIL_TURN_MSK_SECRET",
        "region": "ru-msk",
        "weight": 100
      }
    ],
    "loadBalancer": { "strategy": "least-rooms", "healthPath": "/v1/health", "stickyCookie": "agil_node" },
    "webinar": {
      "enabled": false,
      "hostOnlyPublish": true,
      "viewerLimit": 10000,
      "chatMode": "moderated",
      "reactions": true,
      "raiseHandQueue": true
    },
    "streaming": { "enabled": false, "provider": "none", "rtmpUrl": "", "hlsUrl": "", "latencyMode": "low" },
    "cdn": { "enabled": false, "baseUrl": "", "provider": "" }
  }
}
```

Правила:
- `turn[].credentialEnv` — **имя** env-переменной, не секрет; сервер подставляет
  credential в `welcome.iceServers`. STUN добавляется автоматически.
- `signaling.nodes` — реестр узлов для LB/дашборда; в MVP используется только
  для статуса.
- `webinar.enabled` + `mediaMode != mesh` → эффективный режим `broadcast`;
  `transport:'p2p'` в такой организации отклоняется (409), потому что
  вебинар требует SFU.
- `transport:'p2p'` — только `mode:'direct'`, ровно 2 места; не используйте его
  как замену SFU для групп (docs/p2p.md).
- `limits.maxParticipants` и `scale.maxParticipants` подняты до 50 000, но
  фактический предел задаёт медиаплейн (mesh/SFU) и тариф.

## 3. Admin API (реализовано в контракте MVP)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/v1/admin/scale` | `ScaleStatusResponse`: конфиг, эффективный mediaMode, реестр узлов, TURN-пул (configured-флаги), SFU/webinar/streaming, `sfuCapacity.participants`, `effectiveMaxParticipants` и `capacity` (лимит комнаты по профилю), ограничения |
| PUT | `/v1/admin/scale` | merge `{scale: Partial<ScaleConfig>}` в конфиг тенанта (SSRF-валидация URL, секреты только как env-имена) |
| GET | `/v1/admin/cluster/status` | `ClusterStatusResponse`: узлы, strategy, redisConfigured, `multiNodeActive` (MVP: `false`) |
| POST | `/v1/admin/scale/turn/test` | Проверка доступности с Core. Для UDP выполняет STUN Binding, для TCP проверяет соединение, для TLS — рукопожатие. Проверка сертификата, выделения адреса реле и передачи данных описана в runbook. |

MCP: `agil_get_scale`, `agil_set_scale`, `agil_get_cluster_status`,
`agil_explain_scaling` (офлайн-гайд). Дашборд: карточка «Масштабирование» на
экране «Интеграции». Редактор: секция «Масштабирование и стриминг».

## 4. Мульти-нода сигналинга (design)

Проблема: WS-комнаты живут в памяти узла; при нескольких узлах участники одной
комнаты должны попадать на один узел, а broadcast (чат/присутствие/config/
анализ) — доходить до всех.

```
                 ┌──────────── LB (L7, sticky cookie / SNI+path) ────────────┐
                 │                                                          │
   browser ──────┼──► node-1 (WS+API) ◄── Redis pub/sub ──► node-2 (WS+API) │
                 │         │                                  │              │
                 │         └──────────► SFU-пул (LiveKit/mediasoup) ◄───────┘
                 │                        │
                 │                        └──► TURN-пул / CDN
```

- **Sticky routing:** LB по cookie `agil_node` (или consistent hash по roomId)
  → участник всегда на «своём» узле комнаты.
- **Room ownership:** у комнаты есть владелец-узел (lease в Redis); join
  перенаправляется на владельца (302/WS-редирект).
- **Broadcast:** чат, presence, state, config, analysis — публикуются в Redis
  канал `agil:signaling` с `{roomId, exceptNode}`; узлы рассылают локальным
  сокетам. Медиа не идёт через signaling.
- **Fan-out SFU:** медиа-потоки живут на SFU; signaling-узел только выдаёт
  токены и координирует.
- **Health/registry:** узлы регистрируются (TTL в Redis), LB опрашивает
  `/v1/health`, strategy `least-rooms`/`round-robin`/`geo`/`weighted`.
- **Sticky sessions** обязательны для mesh; для SFU — желательны.

MVP-статус: single-node (state в памяти), но контракт и health-флаги готовы;
реализация Redis-шины — следующий этап.

## 5. TURN-пул

- Несколько TURN в разных регионах/провайдерах: клиент получает весь пул в
  `welcome.iceServers`, браузер сам выбирает рабочий.
- Для существующего TURN-пула используется постоянный логин и переменная
  окружения `credentialEnv`. Для coturn можно включить `credentialMode: "rest"`.
  Core создаёт временные данные при входе в комнату. [Настройка coturn](operations.md#temporary-coturn-credentials)
- TURN помогает передавать медиа, когда прямой путь блокирует сеть или NAT.
  Сигнализация идёт по WebSocket. Для SFU параметры ICE и TURN настраиваются в
  медиасервере. [Проверка TURN и откат](operations.md#25-turn)
- Bandwidth: SFU-поток 720p ≈ 2–3 Мбит/с на зрителя; для 10 000 зрителей —
  CDN/мультикаст (B2B-сценарии — 1–2 тыс. на SFU-ноду + CDN).
- Мониторинг: алерты на allocation failures, relay port exhaustion, RTT.

## 6. SFU и вебинары

- **SFU:** LiveKit (Apache-2.0, Go) или mediasoup (ISC, Node). Клиент публикует
  один поток и получает бюджет видео на страницу по профилю ёмкости (≤8
  участников — все видимые, 9+ — low 2 / standard 6 / high 12: pinned + active
  speaker первыми); `maxVideoSubscriptions` остаётся жёстким потолком,
  `limits.galleryVideoBudget` / `scale.maxVisibleVideos` — override
  (docs/large-rooms.md). Профиль задаётся `AGIL_SFU_PROFILE` (деплой) или
  `scale.sfu.capacityProfile`; дефолт новых установок — standard. Аудио
  подписывается для всех участников. 50 видео на клиента требует каскада/
  нескольких SFU-узлов, одного узла недостаточно.
- **Лимит участников следует профилю.** Эффективная ёмкость комнаты:
  `min(room.maxParticipants, scale.maxParticipants, profile.participants,
  sfu.maxParticipants)`, где `profile.participants` = 25 (low), 50 (standard),
  200 (high). Лимит применяется при создании комнаты, в REST join, lobby admit
  и WS-handshake; при переполнении — `409 room_full` с `details.reason`
  (`profile|sfu|scale|room`) и сообщением вида «capacity profile low allows 25
  participants». Поэтому на пилоте 1 vCPU / 2 GB комната с запрошенными 200
  местами создаётся с лимитом 25, а 26-й участник получает отказ. `/v1/admin/scale`
  отдаёт `sfuCapacity.participants`, `effectiveMaxParticipants` и `capacity`;
  детали комнаты (`GET /v1/admin/rooms/:roomId`) — `effectiveMaxParticipants` и
  `capacity`.
- **Режим `broadcast`:** спикеры публикуют; зрители только получают
  (receive-only), UI скрывает mic/cam/share, показывает «Вы зритель».
  `webinar.hostOnlyPublish`, `viewerLimit`, `chatMode` (moderated — сообщения
  проходят модерацию/очередь), `raiseHandQueue`.
- **Стрим наружу:** `streaming.provider = rtmp|hls|webrtc`; egress-сервис
  (LiveKit Egress/ffmpeg-воркер) публикует RTMP в YouTube/VK или HLS-плейлист;
  `latencyMode` low/standard.
- **CDN:** HLS/LL-HLS через CDN для тысяч пассивных зрителей; интерактив
  (спикеры) — через SFU.
- **Запись/транскрипт** на масштабе — server-side egress (не клиентская
  MediaRecorder), отдельный воркер.

## 7. Лимиты и capacity-план (ориентиры)

| Компонент | Один узел | Масштабирование |
|---|---|---|
| Signaling WS | ~5–10 тыс. соединений (Node, 1 vCPU/1 ГБ) | больше узлов + Redis |
| SFU | ~1–2 тыс. подписок на потоковую ноду (зависит от CPU) | пул SFU + регион |
| SFU: ёмкость комнаты по профилю | low 25 / standard 50 / high 200 участников; эффективный лимит также ограничен room/scale/sfu.maxParticipants | high-профиль = отдельная нода, load test |
| TURN | ~1–3 Гбит/с relay на сервер | пул TURN + anycast |
| Пассивные зрители | HLS/LL-HLS через CDN | CDN-провайдер |
| Чат на вебинаре | 50–100 сообщений/с на узел | Redis-шина + ограничение отправки |

## 8. Как включить (когда появится инфраструктура)

1. Поднять Redis, SFU (LiveKit), TURN-пул, LB (Nginx/HAProxy/облачный L7).
2. Заполнить `scale` через `PUT /v1/admin/scale` (или редактор/дашборд/MCP).
3. Убедиться, что `welcome.iceServers` содержит TURN-пул (проверить `/v1/health`,
   открыть звонок, `chrome://webrtc-internals`).
4. Для вебинара: `webinar.enabled=true`, `mediaMode='broadcast'`, создать
   комнату с `maxParticipants` из тарифа; зрители входят как `guest` с
   receive-only.
5. Для стрима: `streaming.enabled=true`, `provider='rtmp'`, `rtmpUrl` площадки.
6. Подключить мониторинг (PROMETHEUS/Grafana), алерты.

## 9. Что реализовано, а что нет

**Сделано в MVP (без тестирования масштаба — инфраструктуры пока нет):**
- Схема `TenantConfig.scale` (zod), дефолты, DTO и admin-эндпоинты;
- лимиты участников до 50 000, `RoomInfo.mediaMode`/`maxParticipants`;
- TURN-пул: подстановка ICE-серверов из конфига в `welcome` (STUN + TURN,
  credentials из env) — конфигурационно;
- UI редактора/дашборда для ввода топологии; MCP-инструменты; документация;
- enrollment baseline: одноразовые токены, реестр узлов и резервных Core,
  heartbeat/drain/disable, панель «Инфраструктура» — см.
  [api/cluster.md](api/cluster.md);
- **HA Core baseline**: выборы лидера через Redis lease, standby read-only
  (`409 not_leader` на мутации), автоматический failover по TTL, статус и панель
  — см. [ha-leader.md](ha-leader.md). Репликация состояния комнат/конфига и
  планирование комнат на узлы — следующий этап.

**Не реализовано (нужна инфраструктура и отдельный этап):**
- реальная Redis-шина мульти-ноды, room ownership/lease, sticky redirect
  (leader lease уже есть, но состояние комнат между Cores не реплицируется);
- интеграция SFU (LiveKit/mediasoup), токены публикации/подписок, SVC/слои;
- receive-only режим зрителя на уровне сервера/медиа (сейчас — UI-гейтинг);
- RTMP/HLS egress, CDN, запись/транскрипт на масштабе;
- автоскейлинг, health-checks TURN/SFU, rate-limit на Redis;
- нагрузочные тесты (k6/webrtc-perf) и тюнинг.

Ориентир по срокам — `agil/core/docs/estimate.md` (production-блок), подробный план —
`agil/core/docs/backlog.md`.

> **Stage 1 (200 участников):** галерея виджета виртуализирована (25–36 плиток
> на страницу), клиент подписывает видео только для видимой страницы, пина и
> активного спикера, а аудио — для всех. Ёмкость комнаты ограничивается
> `min(room.maxParticipants, scale.maxParticipants, profile.participants,
> sfu.maxParticipants)`: профиль `low` — 25, `standard` — 50, `high` — 200;
> лимит проверяется при создании комнаты, REST join, lobby admit и WS-handshake.
> Размеры нод и честные ограничения — в [`large-rooms.md`](./large-rooms.md).
