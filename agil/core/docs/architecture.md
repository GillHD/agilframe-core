# AgilFrame — архитектура (этап 1: браузер)

> Коротко: AgilFrame — это **встраиваемый слой видеозвонков** для корпоративных
> сервисов. Заказчик подключает JS SDK или iframe, задаёт тему/фичи через API или
> визуальный редактор, а нейросети настраивают панель через MCP. Всё, что видит
> пользователь, описано дизайн-токенами, всё, что происходит в звонке — событиями
> API, поэтому «свой дизайн» не требует форка кода.

## 1. Цели и ограничения

**Цели продукта**

1. Простой и гибкий API: `AGILCalls.mount(...)` в 5 строк, REST + WebSocket для
   серверной интеграции, MCP для AI-агентов.
2. Полная кастомизация: 36 цветовых токенов, типографика, радиусы, плотность,
   фон, логотип, лейауты, светлая/тёмная/авто тема — на тенант и на конкретный
   embed.
3. Все ключевые функции звонка: видео/аудио, чат, файлы, демонстрация экрана,
   запись, транскрипт и заметки, блюр/замена фона, реакции, поднятая рука,
   качество связи и деградация.
4. Корпоративная безопасность: пароли и локальные комнаты, гео-политики,
   проверка подлинности (verified identity + liveness), аудит, rate-limit,
   подписанные ссылки на файлы/записи, аннонимные токены с TTL.
5. Аналитика диалогов: STT → транскрипт → **выдержки**, summary, action items,
   compliance-правила; подключение корпоративного AI-агента через API.
6. Первый этап — браузер (Chromium/Firefox/Safari), затем мобильные SDK.

**Вне этапа 1 (roadmap, см. `agil/core/docs/features.md`)**: SFU-масштабирование на
LiveKit/mediasoup, мобильные нативные SDK, E2EE, SIP/PSTN, breakout rooms,
доска, опросы, вебинары, стриминг, календарные интеграции, перевод, запись на
сервере (egress), SSO/SCIM, on-premise Kubernetes-оператор.

## 2. Компоненты

```
                     ┌───────────────────────────── Браузер клиента ─────────────────────────────┐
                     │                                                                          │
  Хост-приложение    │  AGILCalls.mount()  ──►  @agil/calls-widget (Web Components/DOM)         │
  (React/Vue/…)  ────┼──►  или <iframe src=/embed.html>                                          │
                     │        ├─ SignalingClient  ─────────── WebSocket ──┐                      │
                     │        ├─ WebRtcEngine (mesh, кодек-политика) ──┐  │                      │
                     │        ├─ Media/Blur (MediaPipe, WebGL)         │  │                      │
                     │        ├─ Chat / Files / Recording / Captions   │  │                      │
                     │        └─ Theme (CSS vars из токенов)           │  │                      │
                     └─────────────────────────────────────────────────┼──┼──────────────────────┘
                                                                       │  │
                                    RTP/RTCP (P2P mesh, SRTP/DTLS)     │  │
                     ┌─────────────────────────────────────────────────┘  │
                     │                                                    │
        ┌────────────▼─────────────┐                       ┌──────────────▼──────────────────┐
        │  Другой участник (браузер)│                      │  @agil/calls-server (Node 23)    │
        └──────────────────────────┘                       │  HTTP REST + WS signaling        │
                                                           │  ├─ Rooms/Registry/Presence      │
        ┌──────────────────────────┐                       │  ├─ TenantStore (config JSON)    │
        │  @agil/security          │◄──────────────────────┤  ├─ Admin API (x-api-key)        │
        │  password/geo/audit/     │                       │  ├─ Public API (join/files/rec)  │
        │  files/recordings/STT/   │                       │  ├─ Static (demo/editor/dash/sdk)│
        │  media integrity         │                       │  └─ Analysis pipeline            │
        └──────────────────────────┘                       └──────────────┬───────────────────┘
                                                                          │
        ┌──────────────────────────┐                       ┌──────────────▼───────────────────┐
        │  @agil/ai                │◄──────────────────────┤  Corporate AI Agent (HTTPS)      │
        │  локальные правила,      │  AiAgentRequest       │  (LLM/аналитика диалогов)         │
        │  экстрактивные заметки,  │  HMAC-подпись         │  → findings + выдержки/summary   │
        │  клиент AI-агента        │──────────────────────►│                                   │
        └──────────────────────────┘  AiAgentResponse                                      │
                                                                                           │
        ┌──────────────────────────┐   ┌──────────────────┐   ┌──────────────────────┐      │
        │  @agil/mcp (stdio)       │   │  agil/core/apps/editor     │   │  agil/core/apps/dashboard      │      │
        │  инструменты для LLM     │   │  визуальный      │   │  тестовые комнаты,   │      │
        │  (тема/конфиг/данные)    │   │  редактор темы   │   │  аудит, безопасность │      │
        └──────────────────────────┘   └──────────────────┘   └──────────────────────┘      │
```

### Пакеты

| Пакет | Роль | Ключевые решения |
|---|---|---|
| `agil/core/packages/protocol` | Контракты: TenantConfig, дизайн-токены, signaling, quality, compliance, JWT | zod-схемы — единый источник; браузер-безопасный (кроме `/token`) |
| `agil/core/apps/server` | REST + WS + статика + admin API | `node:http`, `ws`, без express; in-memory комнаты (MVP); JSON-персист конфигов |
| `agil/core/packages/security` | Пароли, гео, аудит, файлы/записи, integrity, STT | scrypt, HMAC-ссылки, JSONL-аудит, ноль сырых IP |
| `agil/core/packages/ai` | Compliance-правила, заметки/выдержки, клиент AI-агента | детерминированный локальный fallback всегда работает |
| `agil/websdk/widget` | UI+движок звонка | DOM/Web Components, токены через CSS vars, mesh WebRTC |
| `agil/websdk/sdk` | `agil-calls.js` (global `AGILCalls`) | IIFE со встроенным виджетом и CSS; iframe-режим |
| `agil/core/packages/mcp` | MCP-сервер для нейросетей | stdio, 13+ инструментов, офлайн/онлайн-плоскости |
| `agil/websdk/demo` | Демо «как встроить» + `embed.html` | Vite, прокси на сервер |
| `agil/core/apps/editor` | Визуальный редактор панели | Без импорта виджета: iframe + postMessage |
| `agil/core/apps/dashboard` | Панель разработчика | x-api-key, live-поллинг, аудит/безопасность |

## 3. Поток «вход в комнату» (join)

```
1. Хост-приложение получает token: POST /v1/tokens (x-api-key)  ── или ──
   POST /v1/rooms/:id/join {name?, password?} (публичный, rate-limited)
2. Виджет грузит конфиг тенанта: GET /v1/tenants/:id/config (публично)
   + local overrides (options.theme/options.config) + пресет темы
3. mountWidget → тема (CSS vars) → экран preview → getUserMedia
4. WS /ws?token=<jwt> → welcome {self, room, participants, config, iceServers}
5. На каждого участника: RTCPeerConnection, addTrack, инициатор — меньший id
6. SDP/ICE relay через сервер, медиа идёт P2P (SRTP/DTLS)
7. Чат/присутствие/реакции/captions — по WS (надёжный канал), файлы — REST
```

**Почему mesh на этапе 1.** Для 2–8 участников mesh даёт минимальную задержку и
не требует SFU-инфраструктуры; протокол сигналинга уже отделяет control plane от
media plane, поэтому переход на SFU (LiveKit/mediasoup) не меняет публичный API —
комнаты получат `mediaMode: 'mesh' | 'sfu'`, а сервер станет выдавать
SFU-транспорты. Это зафиксировано в `agil/core/docs/estimate.md` как рекомендация (C1).

## 4. Темизация

- **Дизайн-токены** (`protocol/theme.ts`): 36 цветов, типографика, форма,
  плотность, фон, логотип, анимации. Полная тема — сериализуемый JSON.
- **5 пресетов**: light, dark, corporate, night, minimal. `resolveTheme(patch)`
  мержит частичный патч в пресет и валидирует.
- **scheme: 'auto'**: `displayTheme(theme, prefersDark)` держит кастомную
  светлую палитру днём и выводит читаемую тёмную из бренд-цвета ночью.
- **Бренд-цвет → палитра**: `generatePalette(color, scheme)` (hover/active/
  onPrimary/focusRing/accent с контролем контраста WCAG).
- **Применение**: `toCssVars()` → CSS-переменные `--agil-*` на корне виджета;
  в вёрстке нет хардкод-цветов. CSS-переменные можно переопределить снаружи —
  хост-приложение может встроить виджет в свой дизайн-систем.
- **Аудит доступности**: `auditTheme()` возвращает ошибки контраста; редактор,
  MCP и дашборд показывают их при правке.
- **Три канала настройки**: REST (`PUT/PATCH /v1/tenants/:id/config`), визуальный
  редактор (тот же REST), MCP (`agil_generate_theme`, `agil_update_config`).

## 5. Медиа-слой

| Функция | Реализация |
|---|---|
| Кодеки видео | `setCodecPreferences` по `config.video.codecs` (AV1/VP9/H264/VP8), `contentHint`, `degradationPreference`, keyframe interval |
| Масштабирование | simulcast (3 слоя) при `simulcast:true`; SVC при поддержке браузера |
| Аудио | Opus (+RED), DTX, ptime, битрейт, echoCancellation/NS/AGC, `jitterBufferTarget` |
| Низкая задержка | `playoutDelayHint=0`, `jitterBufferTarget`, отключение видео-слоёв при деградации |
| Качество | `evaluateQuality(stats, lowBandwidthCfg)` → tier + действия: reduced/off video, audio-only, chat-fallback, reconnect; гистерезис; UI-баннер |
| Блюр/замена фона | MediaPipe `ImageSegmenter` через динамический CDN-import + канвас-композит; fallback — CSS-блюр с флагом `degraded` |
| Шумоподавление | браузерное (`noiseSuppression`), RNNoise — roadmap |
| Запись | `MediaRecorder` (canvas-микс + audio mix), consent-баннер, опциональная загрузка на сервер |
| Демонстрация экрана | `getDisplayMedia` + `replaceTrack`, параметры fps/width/audio |
| STT | Web Speech API (Chrome/Edge) → caption-сегменты в WS; серверный Whisper-совместимый fallback |
| Файлы | POST /v1/files (Bearer join-token), подписанные GET-ссылки, лимиты по конфигу |

## 6. Анализ диалогов и корпоративный AI-агент

```
captions ──► TranscriptSegment (WS) ──► room transcript (server, retention)
                                          │
                     ┌────────────────────┴─────────────────────┐
                     ▼                                          ▼
        ComplianceEngine (локально, всегда)          AiAgentClient (если настроен)
        phrase/regex/PII правила                     POST AiAgentRequest (HMAC)
        → findings[]                                  → AiAgentResponse (zod-валидация)
                     │                                          │
                     └──────────────► MeetingNotes (summary, выдержки-цитаты,
                                      action items, решения, риски, топики)
                                          │
                    broadcast {type:'analysis'} → виджет (панель «Заметки»,
                    compliance-бейджи) → дашборд (вкладки Notes/Compliance) →
                    аудит → прикрепление к записи звонка
```

Принципы: локальные правила работают без сети; внешний AI — опциональный и
сменный (корпоративный endpoint, локальная LLM/Ollama), ключ хранится только в
env (в конфиге — имя переменной); ответ модели — недоверенный вход
(схема-валидация, ограничения длины, никакого исполнения); выдержки — дословные
цитаты с таймкодами, а не пересказ (юридическая ценность); приватность —
`retentionMin`, `sendTranscripts`, `sendChat` регулируются на тенант.

## 7. Безопасность (сводно)

| Угроза | Мера в MVP |
|---|---|
| Посторонний вход | JWT-токен с room/tenant/role, TTL; пароль комнаты (scrypt-хэш только на сервере); lock/waiting room; лимит попыток + lockout |
| Утечка ссылки | короткий TTL токена, отзыв ключа тенанта, kick, audit |
| Нежелательная география | `security.geo.allowed/blockedCountries`, `blockVpn`, аудит `geo.blocked` |
| Подмена личности | подпись токена, `verified` при корпоративном issuer (SSO — roadmap), бейдж «проверен» |
| Deepfake/AI-медиа | liveness-challenge (MediaPipe), frame-timing эвристики, внешний детектор (`AGIL_INTEGRITY_URL`), статус `verified/suspicious`, аудит; честно: не 100% |
| Перехват медиа | DTLS-SRTP обязательно (WebRTC), TURN с TLS — прод; E2EE — roadmap |
| Утечка данных | подписанные ссылки на файлы/записи с TTL, лимиты размера, аудит, IP только хэшем |
| Abuse API | rate-limit по IP/тенанту, лимиты участников/чатов/файлов, heartbeat-контроль WS |
| Комплаенс | локальные PII-правила, аудит-лог JSONL, экспорт транскрипта, retention |

Подробности — `agil/core/docs/security.md`.

## 8. Масштабирование и deployment (MVP)

```
                 ┌────────────┐      ┌───────────────────────────┐
  Browser ──────►│  Nginx/TLS │─────►│  Node: API + WS + статика │──► JSON-файлы (.data)
                 │  WAF, rate │      │  (1..N инстансов*)        │
                 └────────────┘      └────────────┬──────────────┘
                                                    │ webhooks
                                            ┌───────▼────────┐
                                            │ Corporate AI   │
                                            └────────────────┘
  * MVP: state в памяти одного инстанса; горизонтальное масштабирование — Redis
    pub/sub для signaling + sticky sessions; медиа — TURN/SFU; объектное хранилище
    для файлов/записей (S3-совместимое).
```

MVP разворачивается одним процессом: `npm run build && npm start` (порт 8787)
отдаёт API, WS, demo, редактор, дашборд и SDK. Для продакшена обязательны TLS,
TURN (coturn), внешнее хранилище и отдельный AI-агент.

## 9. Принятые решения (ADR-lite)

1. **Не форкаем Jitsi/Janus** — свои контракты и UI; медиаплейн позже берём
   LiveKit (Apache-2.0). Причины: лицензии (GPL у Janus), вес и сложность форка,
   несовместимость с продуктовой моделью «тематизация через токены».
2. **Тема как данные, а не SCSS** — позволяет менять дизайн рантайм, из API,
   редактора и MCP-агента, и хранить версионируемый JSON на тенант.
3. **Чат по сигналингу** — соединение для доставки сообщений работает при
   деградации медиа и применяет права комнаты.
4. **Mesh для MVP, интерфейс media plane абстрагирован** — быстрый выход на
   рынок, без потери пути к SFU.
5. **AI-анализ: локальные правила + внешний агент** — работает офлайн, не
   привязывает к вендору, юридически значимые выдержки берутся дословно.
6. **MCP с офлайн-инструментами** — нейросеть может проектировать тему/конфиг
   даже без запущенного сервера, а онлайн-инструменты дают доступ к данным.
7. **Node 23 + Vite 6 + zod 3** — минимум зависимостей, нативный TS-стек,
   браузерные бандлы без фреймворка (встраиваемость важнее DX).

## 10. Соответствие контракту

Публичные API зафиксированы в `agil/core/docs/contract.md` (§4 REST, §5 WS, §6 widget,
§8 SDK, §9 MCP, §10 editor, §14 join/files/recordings/STT/admin, §15 dashboard,
§18 права/knowledge-agent, §19 интеграции/вебхуки, §20 OpenAPI).
Все изменения контракта проходят через Lead и отражаются в схеме zod — она
является исполняемой документацией.

## 11. Граница «наш продукт / приложение компании»

Мы сознательно разделяем слои, чтобы продукт оставался платформой, а не
коробочным «всё-в-одном» с чужой бизнес-логикой:

| Что | Где живёт | Как стыкуется |
|---|---|---|
| Медиа, комнаты, чат, файлы, запись, транскрипт | **AgilFrame** | SDK / iframe / REST / WS |
| Дизайн (токены, темы, пресеты, рендер) | **AgilFrame** | `config.theme` через API/редактор/MCP |
| **Исполнение** прав на функции | **AgilFrame** (`access.ts`) | `accessPolicy` + `permissions` в токене |
| **Решение**, кто что получает | Компания (IdP/каталог/политика) | выпуск токенов, `PUT /v1/admin/access-policy` |
| STT/транскрипт/локальные правила/выдержки | **AgilFrame** (fallback без сети) | — |
| Корпоративная модель и правила комплаенса | Компания | `ai-agent` endpoint + findings/notes |
| Wiki/внутренние ресурсы, RAG | Компания | `knowledge-agent` endpoint, цитаты |
| Аудит/безопасность/подписи | **AgilFrame** | `GET /v1/admin/audit`, вебхуки |
| SIEM/DLP/retention/удаление | Компания | вебхуки, `DELETE` записей, TTL |

Правило: наш сервер не хранит контент компании (wiki, каталог сотрудников,
секреты) — только имя env-переменной для ключа; компания не реализует медиа-часть.
Полное описание, диаграмма, чек-лист — `agil/core/docs/integration-boundaries.md`.

**API как продукт.** Помимо REST/WS/SDK мы отдаём машиночитаемый контракт:
OpenAPI 3.1 (`GET /openapi.json`) + офлайн-интерактивный explorer (`GET /docs`)
+ MCP-сервер для LLM-агентов. Это позволяет компании интегрироваться без
чтения исходников, а нейросети — проектировать темы, конфиги, права и
анализировать встречи по документированным инструментам.

## 12. Структура файлов и правила модульности

Проект — модульный монорепо: каждый пакет собирается отдельно, публичный API —
только через `index.ts` пакета (никаких «глубоких» импортов `pkg/src/...` из
других пакетов). Это исключает монолит и позволяет переиспользовать слои
(например, `protocol` в браузере и на сервере, `security`/`ai` в воркерах).

**Правило зависимостей (строго в одну сторону):**

```
protocol  (zod, DOM-free, без Node-импортов; token.ts — отдельный Node-entry)
   ▲   ▲   ▲
   │   │   └──────────── widget/sdk (браузер: только protocol root)
   │   └────────────── ai, security (Node-библиотеки; import type из protocol)
   └────────────────── server (Node: protocol + security + ai)
                         ▲
        editor/dashboard ┘ (только HTTP + protocol-типы; без исходников сервера)
        mcp ─────────────┘ (protocol + ai для оффлайн-инструментов + HTTP)
```

Запрещено: app → `agil/core/apps/server/src/*`; widget → `security`/`ai`; server →
`widget`; циклические зависимости пакетов; `eval`/`new Function`; импорт
Node-модулей в браузерных пакетах (проверяется Vite-сборкой).

**Модули по пакетам** (один файл — одна ответственность, ориентир ≤400 строк):

| Пакет | Файлы/модули | Ответственность |
|---|---|---|
| `protocol` | `color`, `theme`, `config`, `signaling`, `quality`, `access`, `compliance`, `integrations`, `admin`, `token`(Node), `index` | схемы/zod, типы, чистые функции; никакой I/O |
| `security` | `errors`, `password`, `ip`, `geo`, `rate-limit`, `audit`, `files`, `recordings`, `integrity`, `stt`, `signing`, `webhooks`, `sanitize`, `url-validation`, `storage` | сервисы безопасности; файловые/сетевые адаптеры |
| `ai` | `compliance-engine`, `notes`, `agent-client`, `knowledge-client`, `request-builder`, `text` | локальные правила, экстрактивные заметки, клиенты внешних AI |
| `server` | `env`, `tenants`, `rooms`, `auth`, `http` (router), `public-api`, `admin-api`, `signaling` (WS), `static`, `openapi`, `tools/export-openapi`, `index` | транспорт и оркестрация; бизнес-логика — в сервисах, роутер тонкий |
| `widget` | `index`, `state`, `call/{signaling-client,webrtc-engine,media,blur,recording,captions,integrity,chat,notes}`, `ui/{app,layout,video-tile,controls,chat,participants,notes,transcript,settings,join-screen,security-badge,toasts,banner}`, `theme/apply`, `i18n`, `style.css` | UI и медиа-движок; только DOM/CSS-переменные |
| `sdk` | `index`, `vite` (два формата сборки) | фасад `AGILCalls`, iframe/embed, ES+IIFE |
| `mcp` | `index`, `http-client`, `schemas`, `tools/*` (по группам), `resources`, `prompts` | MCP-протокол; stdout — только JSON-RPC, логи в stderr |
| `editor` | `main`, `state`, `api`, `preview` (postMessage), `sections/*` | визуальный редактор; без импорта виджета |
| `dashboard` | `main`, `api`, `auth`, `router`, `ui/*`, `screens/*` | админ-панель; только HTTP + protocol-типы |

**Соглашения кода:** ESM, `import type` (verbatimModuleSyntax), относительные
импорты с `.js`, kebab-case имена файлов, без default-export в библиотеках,
ошибки — типизированные (`SecurityError`, `ApiErrorBody`), валидация входа —
zod на границе, никаких `any` в публичных API.

**Границы состояния.** Источник правды: на сервере — `rooms`/`tenants` реестры;
на клиенте — единый `state.ts` (компоненты не хранят дублирующее состояние);
на диске — `.data` (JSON-конфиги, JSONL-аудит, файлы/записи).

**Качество.** Каждый пакет обязан проходить `npm run build -w <pkg>`,
`npm run typecheck -w <pkg>`, а `protocol`/`security`/`ai`/`server`/`mcp` —
ещё и `npm test -w <pkg>`. Перед релизом: `npm test`, `npm run e2e`,
`npm run audit` (security baseline), `npm run perf`, `npm run build` и сборка
Docker-образа.

## 13. Заменяемые провайдеры возможностей

Каждая возможность — «builtin по умолчанию + внешний провайдер по желанию»
(`TenantConfig.providers`, контракт — `agil/core/docs/extensibility.md`):

| Слот | Builtin | Внешний |
|---|---|---|
| `chat` | комнатный чат по WS + история | корпоративный мессенджер |
| `files` | `.data/files` + подписанные ссылки | S3/DMS/ECM |
| `stt` | Web Speech / `AGIL_STT_*` | вендор STT |
| `notifications` | UI-события | email/Telegram/Teams |
| `recording` | MediaRecorder + локальное хранилище | объектное хранилище/egress |
| `backgrounds` | `session.virtualBackgrounds` | библиотека компании |

Внешний вызов — подписанный HMAC `POST` с конвертом
`{capability, action, requestId, tenantId, roomId?, payload}`; ответ `{ok,data}`
валидируется адаптером. `fallback:'builtin'` — прозрачный откат при ошибке,
`'fail'` — 502. Секреты — только env по имени (`apiKeyEnv`), endpoint
валидируется SSRF-политикой. Это даёт **автономность из коробки** (всё работает
без внешних сервисов) и **заменяемость** без форка: чат/файлы/STT/уведомления/
запись/фоны, а также AI/knowledge/identity/вебхуки/медиаплейн (roadmap).
