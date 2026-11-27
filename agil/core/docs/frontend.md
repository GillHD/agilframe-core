# AgilFrame frontend — архитектура виджета

Документ для инженеров, которые будут менять `agil/websdk/widget` (и `agil/websdk/sdk`,
`agil/websdk/demo`). Контракт публичного API — `agil/core/docs/contract.md` §6–§8, §22;
документация интегратора — `agil/core/docs/sdk.md`.

## 1. Принципы

- **Без фреймворка**: нативные Web Components/DOM, один ES-бандл. Никаких новых
  npm-зависимостей; `@agil/protocol` и `zod` инлайнятся в бандл.
- **Тема = токены**: весь визуал через `var(--agil-*)`, которые выставляет
  `theme/apply.ts` из `ThemeTokens` (`toCssVars`). В `style.css` нет
  захардкоженных цветов.
- **Единый стор**: `state.ts` (`CallStore`) — единственный источник состояния
  рендера. UI ничего не запрашивает напрямую, он читает `CallState` и зовёт
  действия из `index.ts`.
- **Ошибки не роняют звонок**: сеть/медиа/CDN-ошибки превращаются в
  локализованные сообщения, тосты, баннеры и флаги `degraded`.

## 2. Карта модулей

```
agil/websdk/widget/src/
  index.ts                 mountWidget(), сессия (join flow, WS-хендлеры, публичный API)
  types.ts                 публичные типы §6 (+ §22): options/instance/state/stats
  state.ts                 CallStore + createInitialState
  api.ts                   REST-клиент: config/join/files/recordings/stt
  config-loader.ts         server config → options.config → options.theme, offline fallback
  permissions.ts           permissions из welcome/join; canFeature()
  i18n.ts                  ru/en словари, plural
  dom.ts                   h(), иконки-хелперы, форматирование
  icons.ts                 inline SVG иконки
  emitter.ts               типизированный emitter
  theme/apply.ts           displayTheme + toCssVars, prefers-color-scheme, data-атрибуты
  style.css                вся стилизация (токены, адаптив, a11y, мини-режим, chrome)
  call/
    signaling-client.ts    WS, reconnect/backoff, heartbeat ping, очередь, парсинг
    webrtc-engine.ts       mesh, perfect negotiation, simulcast, stats→quality, ICE restart
    media.ts               getUserMedia/enumerateDevices/getDisplayMedia, ошибки
    blur.ts                MediaStreamTrackProcessor/canvas + MediaPipe CDN (fallback)
    mediapipe.ts           ленивый dynamic import tasks-vision
    recording.ts           canvas-микс + AudioContext → MediaRecorder → upload/download
    captions.ts            Web Speech API / server STT fallback
    integrity.ts           liveness (Face Landmarker) + frame-timing эвристики
    chat.ts                чат через WebSocket и обмен файлами
    notes.ts               анализ {type:'analysis'} + локальный экстрактивный fallback
    assistant.ts           knowledge-agent: assistant-query/answer
  ui/
    app.ts                 layout: header/сетка/caption-overlay/панели/banner/тосты
    video-tile.ts          плитка участника (+ стабильные data-атрибуты)
    controls.ts            панель управления (в т.ч. minimize/pip/assistant)
    chat-panel.ts          встроенный чат
    participants-panel.ts  участники, роли, страны/город (для модераторов), GPS/VPN
    notes-panel.ts         заметки + комплаенс-findings
    transcript-panel.ts    транскрипт + экспорт .txt
    settings-panel.ts      устройства/фон/язык/тема/локация-consent/диагностика
    assistant-panel.ts     «Спросить ассистента» (textContent, citations как ссылки)
    join-screen.ts         превью + имя + пароль + ошибки + offline
    security-badge.ts      E2EE/geo/audit/integrity бейдж
    banner.ts, toasts.ts   деградация и уведомления
```

## 3. Жизненный цикл

1. `mountWidget(container, options)` создаёт корень `[data-agil-root]`, применяет
   тему из `defaultConfig()` (чтобы UI был виден сразу), грузит конфиг
   (`loadConfig`) — сервер → `options.config` → `options.theme`.
2. Показывается join-screen. **Камера не запрашивается до join** (кроме
   `embed.html` с токеном, где join автоматический: e2e ждёт `data-state="joined"`).
3. `join()`:
   - `MediaController.acquire()` — микрофон и камера отдельно, отказ одного не
     блокирует другой; полный отказ → режим «только слушать»;
   - без `options.token` → `POST /v1/rooms/:id/join` (пароль/гео/lock/rate-limit
     → человеческие ошибки);
   - WS `/ws?token=…`, ожидание `welcome`;
   - `welcome` → self/room/participants/history/config/permissions/iceServers,
     создаётся `WebRtcEngine`, добавляются пиры, отправляются `hello` и начальный
     `state`.
4. `leave()`/`destroy()` — закрытие WS (bye), engine.close(), остановка медиа,
   таймеров, captions/integrity/recording, очистка sessionStorage-handoff.

## 4. Сигналинг и WebRTC

- **Один WS на участника**. `SignalingClient`: JSON.parse в try/catch, heartbeat
  `ping` каждые 20 с, очередь исходящих при обрыве, reconnect с экспоненциальным
  backoff из `config.fallback.lowBandwidth.autoReconnect`.
- **Mesh**: `RTCPeerConnection` на каждого удалённого участника, максимум 8
  (константа `MAX_MESH_PEERS`). Инициатор — меньший `participantId`.
- **Perfect negotiation**: `negotiationneeded` + `makingOffer`, вежливый пир (с
  большим id) откатывает свой offer (`rollback`) при glare. SDP/ICE приходят
  раньше `peer-joined` — движок буферизует orphan SDP/ICE.
- **Медиа**: стабильные transceiver'ы (audio/video) → `replaceTrack` для
  смены камеры/блюра/демонстрации без renegotiation; simulcast (3 слоя) при
  `video.simulcast`; `setCodecPreferences` по `video.codecs`/`audio.codecs`;
  `degradationPreference`, `contentHint`, `playoutDelayHint=0`,
  `jitterBufferTarget`.
- **Качество**: каждые 2 с `pc.getStats()` → `QualitySnapshot` (RTT/потери/
  джиттер/битрейт/FPS/разрешение) → `evaluateQuality()` → действия
  (`video reduced/off`, `chatFallback`, `reconnect`). Применяется: понижение
  битрейта/FPS, приостановка отправки видео (`replaceTrack(null)`), баннер
  «слабый канал — чат продолжает работать», ICE restart с кулдауном.
- **Чат** всегда идёт по сигналингу (работает при деградации медиа);
  Повторную доставку отфильтровываем по `message.id`.

## 5. Медиа-конвейер

- **Блюр/фон**: `MediaStreamTrackProcessor` (или video-элемент fallback) →
  source canvas → сегментация selfie_segmenter из CDN MediaPipe → композит
  (blur/картинка/градиент) → `captureStream()` → `engine.setVideoOverride(track)`.
  CDN недоступен → упрощённое размытие всем кадром, `degraded:true`,
  предупреждение. Виртуальные фоны с пустым `url` рисуются градиентом из темы.
- **Screen share**: `getDisplayMedia` с `session.screenShare`, заменяет
  отправляемый видео-трек (`setScreenTrack`), на `ended` — автостоп.
- **Запись**: canvas-сетка (все стримы) + AudioContext-микс → MediaRecorder
  (webm/mp4 по `session.recording.format`) → `POST /v1/recordings`
  (`x-recording-meta`, Bearer) или локальное скачивание. Согласие — отдельный
  диалог, уведомление участникам, индикатор REC.
- **Субтитры**: Web Speech API (Chrome/Edge, ru/en, continuous/interim) —
  финальные сегменты → `{type:'caption'}` → overlay + панель «Транскрипт» +
  экспорт .txt. В серверном режиме MediaRecorder пишет аудиофрагменты по 8 с
  в поддерживаемом браузером формате WebM, Ogg или MP4 и отправляет их в
  `POST /v1/stt/transcribe`. При ответе 501 интерфейс сообщает, что STT недоступен.
  Выключение субтитров останавливает захват, отбрасывает незавершённый фрагмент и
  прекращает публикацию результатов уже отправленных запросов.
- **Liveness/integrity**: случайная задача (моргнуть/повернуть голову) через
  Face Landmarker (CDN) + frame-timing эвристики; результат →
  `{type:'integrity', status, score, flags}`, бейджи в плитках/панели.
  Честно: браузерная детекция вероятностная; провал liveness → `unknown`,
  `suspicious` — только по аномалиям.
- **Заметки**: `{type:'analysis'}` (findings + notes) → панель «Заметки» с
  выдержками и таймкодами; при отсутствии AI — детерминированный локальный
  экстрактивный fallback (`call/notes.ts`).
- **Вебинар/broadcast**: `updateScaleState()` считает эффективный
  `mediaMode` (room.mediaMode → config.scale + webinar) и `viewer` для гостя
  при broadcast/host-only-publish; UI прячет публикацию, выключает локальные
  треки, показывает viewer-бар; в шапке mediaMode-бейдж и счётчик зрителей;
  `renderGrid()` виртуализирует список (≤50 плиток + «+N зрителей»).
- **Ассистент в звонке**: `call/in-call-assistant.ts` — local-движок
  `localAssistantReply` из `@agil/protocol` или `POST /v1/rooms/:id/assistant`
  (external/hybrid, fallback на local при 501/404/ошибке). Действия гейтятся
  `filterAssistantActions`/`isAssistantToolAllowed` и исполняются через обычные
  методы инстанса; `ui/spotlight.ts` рисует затемнение, подсветку
  `[data-agil-spotlight-target]` и шаги подсказки (Esc, aria-live, не блокирует
  звонок).

## 6. Темизация, chrome и мини-режим

- `theme/apply.ts` подписан на `prefers-color-scheme`; для `scheme:'auto'`
  рендерится `displayTheme()`. На корне: `data-theme`, `data-agil-scheme`,
  `data-density`, `data-layout`, `data-bg`, `data-chrome`, `data-inherit-host`.
- `layout.mode='sidebar'` открывает список участников рядом с сеткой при
  наличии права `participantList`. В виджете шириной до 640 px список
  располагается под видео. Панель можно закрыть и открыть кнопкой участников.
- `layout.chrome`:
  - `full` — обычная шапка/фон;
  - `compact` — сжатая шапка;
  - `none` — только сетка+контролы, прозрачный фон (звонок как часть страницы).
- `layout.inheritHostStyles` — `font-family/color: inherit` (когда токены не
  заданы явно).
- Мини-режим (`layout.minimized`): корень становится `position:fixed` окном
  (`bar`/`bubble`, позиция из конфига), показывается одна плитка (self или
  первый удалённый), кнопка «развернуть», клик по окну разворачивает. API:
  `minimize/restore/isMinimized`, data-атрибут `data-agil-minimized`.
- Document PiP: `requestPictureInPicture()` переносит корень в
  `documentPictureInPicture.requestWindow()` (Chromium), клонирует `<style>`/
  `<link>`; при закрытии окна — возврат на место. Не поддержано → fallback на
  мини-окно и `false`.
- Мессенджер (agil/core/docs/messenger.md): Fullscreen API на корне
  (`requestFullscreen/exitFullscreen/isFullscreen`, `data-agil-fullscreen`,
  синхронизация с Esc через `fullscreenchange`), `getCallUrl()` —
  deep link `/embed.html?server&room&token&tenant&name&theme`,
  `openInNewTab()` (popup blocked → toast со ссылкой). `room.mode='direct'` +
  2 участника → spotlight, если `layout.mode` не задан явно; шапка показывает
  `room.context.title`/имя собеседника.

## 7. Права, i18n, a11y

- `welcome.self.permissions` (или `JoinRoomResponse.permissions`) — источник
  правды. `canFeature(state, key)` возвращает `permissions.includes(key)`, до
  join — локальный `resolveAccess()` из `@agil/protocol`.
  Кнопки/панели без права скрываются; серверная проверка остаётся.
- i18n: одна `i18n.ts` (ru/en), переключение языка пересоздаёт UI
  (`rebuildApp`), состояние сохраняется.
- a11y: `focus-visible`-обводка, `aria-label`/`role`, `aria-live` у чата и
  тостов, keyboard shortcuts (`m`, `v`, `c`, `b`), `prefers-reduced-motion`.
- Адаптив: mobile ≤720px — панель на весь экран, сетка 2 колонки, контролы
  сжимаются; мини-окно на весь экран не выходит.
- Безопасный рендер: всё пользовательское — `textContent`; URL (лого, фон,
  цитаты) — только `http(s)` + `rel="noopener noreferrer"`.

## 8. Внешний чат и handoff между страницами (§22)

- `session.chat.ui`: `builtin` — панель внутри; `external` — панели нет,
  сообщения отдаются `onEvent('chat')`/postMessage, отправка — `sendChat()`;
  `hidden` — чат выключен. `setChatMode()` меняет режим на лету,
  `data-agil-chat-mode` на корне.
- `layout.persistAcrossPages` / `persistSession()` — handoff в `sessionStorage`
  (`agil-calls:session`), `AGILCalls.resume()`/`mount(...,{resume:true})`
  восстанавливает. В SPA инстанс живёт, звонок не прерывается.

## 9. Стабильные e2e-хуки (не менять)

```
[data-agil-root][data-state="idle|joining|joined|left|error"][data-agil-scheme][data-agil-quality][data-agil-chat-mode][data-agil-minimized]
[data-agil-tile][data-participant-id][data-self="true|false"] (внутри <video>)
[data-agil-chat-input], [data-agil-chat-send], [data-agil-chat-message][data-message-id]
[data-agil-participants-count], [data-agil-connection]
[data-agil-action="mic|camera|screen|blur|chat|hand|leave|settings|recording|assistant|captions|minimize|restore|pip"]
```

## 10. Как добавить фичу/флаг

1. Флаг уже есть в `@agil/protocol` (`features.*`) — правки protocol не нужны.
2. Добавьте поле в `CallSettingsState`/`CallState` (`types.ts`) и инициализацию
   в `createInitialState`/`createInitialSettings` (`state.ts`).
3. Реализуйте контроллер в `call/` (если нужны сеть/медиа) и подключите в
   `index.ts` (создание, обработчики, cleanup в `leave()`).
4. UI: панель в `ui/`, кнопку — в `controls.ts` с `data-agil-action`, в
   `merge`-логике `app.ts`; право — через `canFeature()`.
5. Строки — в `i18n.ts` (ru и en), стили — только токены в `style.css`.
6. Проверьте, что фича не рисуется без права (permissions), обновите
   `agil/core/docs/sdk.md`/README и e2e-хуки при необходимости.
7. `npm run typecheck -w @agil/calls-widget && npm run build -w @agil/calls-widget`.

## 11. Сборка, dev, тесты

```bash
npm run build -w @agil/calls-widget      # dist/agil-calls-widget.{js,css}
npm run build -w @agil/calls-sdk         # dist/agil-calls.js (IIFE), agil-calls-sdk.js (ES)
npm run build -w @agil/demo              # dist/index.html + dist/embed.html
npm run dev                              # server:8787 + demo:5173 + editor:5174
node agil/core/scripts/e2e.mjs                     # headless Chrome: API + 2 участника
```

Демо (`agil/websdk/demo`): `index.html` — хост-страница «как встроить», `embed.html` —
полноэкранный виджет для iframe. Vite-прокси в dev: `/v1`, `/ws`, `/sdk`,
`/widget` → `localhost:8787`.

## 12. Ограничения и зависимости от сервера

- Mesh ≤ 8 — для больших комнат нужен SFU (roadmap).
- Блюр/фон и liveness требуют CDN MediaPipe (jsdelivr + storage.googleapis.com);
  офлайн деградирует, но работает.
- Web Speech API — Chrome/Edge; серверный STT (если настроен) — fallback.
- Document PiP — Chromium.
- Используемые серверные API: `GET /v1/tenants/:id/config`, `POST
  /v1/rooms/:id/join`, `POST /v1/files`, `POST /v1/recordings`, `POST
  /v1/stt/transcribe`, WS `/ws` (§5), плюс `GET /v1/health` для демо.
- Отдельного эндпоинта для «скачать запись по id» виджет не вызывает: сервер
  возвращает подписанный `url` в `RecordingRecord`, виджет качает по нему.
