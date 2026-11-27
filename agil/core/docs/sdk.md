# AgilFrame SDK — документация интегратора

`@agil/calls-sdk` — минимальный слой для встраивания звонков AgilFrame в
корпоративное приложение: глобальный скрипт `AGILCalls` (один файл, всё внутри)
или ESM-модуль; плюс iframe-режим с postMessage-контрактом.

См. также: `agil/core/docs/contract.md` §6–§8, §22, `agil/websdk/sdk/README.md`,
`agil/core/docs/frontend.md` (устройство виджета).

## 1. Подключение

**IIFE (проще всего):**

```html
<script src="https://calls.example.com/sdk/agilframe.js"></script>
<div id="call" style="height: 640px; border-radius: 16px; overflow: hidden"></div>
<script>
  AgilFrame.mount('#call', {
    serverUrl: 'https://calls.example.com',
    tenantId: 'acme',
    room: 'daily-sync',
    token: '<join-token>',
    participantName: 'Анна',
    theme: { scheme: 'auto' },
  }).then((call) => {
    call.on('joined', () => console.log('connected'));
  });
</script>
```

**ESM:**

```ts
import { mount, createEmbed, themePresets } from '@agil/calls-sdk';
import type { CallState, AgilWidgetEvent } from '@agil/calls-sdk';
```

SDK сам инжектит CSS виджета (id `agil-calls-widget-styles`), отдельный
`<link>` не нужен. Скрипт не использует `eval`/`Function`, не навигирует
top-frame — пригоден для sandbox-iframe (`allow-scripts allow-same-origin`).

## 2. `AGILCalls`

| Член | Тип | Описание |
|---|---|---|
| `version` | `string` | Версия SDK. |
| `mount(container, options)` | `Promise<AgilWidgetInstance>` | Контейнер — элемент или CSS-селектор; user gesture не требуется; камера — по кнопке join. |
| `resume(container?, overrides?)` | `Promise<AgilWidgetInstance \| null>` | Поднять звонок из `sessionStorage`-handoff (см. §6). |
| `createEmbed(options)` | `{html, iframe, url}` | iframe-встраивание `/embed.html`. |
| `compileRoomProfile(profile, room)` | `CreateRoomRequest` | Валидирует профиль и собирает запрос создания комнаты. |
| `createProfileRoom(options)` | `Promise<ProfileRoomResult>` | Создаёт комнату из профиля на доверенном сервере компании. |
| `createVoiceChannelSwitcher(container, options)` | `VoiceChannelSwitcher` | Запрашивает допуск у сервера компании и последовательно переключает активный голосовой канал. |
| `injectStyles()` | `void` | Идемпотентная инъекция CSS. |
| `themePresets` | `Record<ThemePresetName, ThemeTokens>` | 5 пресетов. |
| `presets` | `string[]` | `['light','dark','corporate','night','minimal']`. |
| `resolveTheme(patch, scheme?)` | `ThemeTokens` | Собрать полную тему. |
| `generatePalette(brand, scheme)` | `BrandPalette` | Палитра из бренд-цвета. |
| `auditTheme(theme)` | `ThemeAuditIssue[]` | Контраст/a11y-проверки. |

## 3. `mount(container, options)`

| Опция | Тип | По умолчанию | Смысл |
|---|---|---|---|
| `serverUrl` | `string` | `location.origin` | База REST/WS. |
| `room` | `string` (обяз.) | — | id комнаты. |
| `audioOnly` | `boolean` | `false` | Вход с микрофоном без запроса камеры. Переход на видео по согласию доступен для `direct` + `p2p`. |
| `token` | `string` | — | Join-token; без него виджет сам вызывает `POST /v1/rooms/:id/join`. |
| `tenantId` | `string` | `demo` | Тенант. |
| `participantName` | `string` | «Гость» | Отображаемое имя. |
| `role` | `'host'\|'moderator'\|'guest'` | `guest` | Роль (для анонимного режима). |
| `locale` | `'ru'\|'en'` | из конфига | Локаль UI. |
| `theme` | `ThemePatch` | — | Локальный оверлей темы. |
| `config` | `TenantConfigPatch` | — | Локальный оверлей конфига. |
| `embedded` | `boolean` | `false` | Без внешней рамки. |
| `resume` | `boolean` | `false` | Подхватить сохранённую сессию. |
| `onEvent` | `(event) => void` | — | Все события (см. §4). |
| `onChat` | `(message) => void` | — | Только чат. |

## 4. Инстанс звонка

```ts
interface AgilWidgetInstance {
  join(): Promise<void>;
  leave(): void;
  destroy(): void;
  updateTheme(patch: ThemePatch): void;
  updateConfig(patch: TenantConfigPatch): void;
  setThemeScheme(scheme: 'light' | 'dark' | 'auto'): void;
  sendChat(text: string): Promise<ChatMessage>;
  toggleMic(force?: boolean): Promise<boolean>;
  toggleCamera(force?: boolean): Promise<boolean>;
  requestVideoUpgrade(): boolean;
  respondToVideoUpgrade(requestId: string, accept: boolean): Promise<boolean>;
  toggleScreenShare(force?: boolean): Promise<boolean>;
  setBlurMode(mode: 'off' | 'blur' | 'image', imageUrl?: string): Promise<void>;
  getStats(): Promise<CallStats>;
  getState(): CallState;
  on(event: AgilWidgetEventName, listener: (payload: unknown) => void): () => void;
  // §22
  minimize(): void;
  restore(): void;
  isMinimized(): boolean;
  requestPictureInPicture(): Promise<boolean>;
  persistSession(enabled?: boolean): void;
  resume(): Promise<void>;
  setChatMode(mode: 'builtin' | 'external' | 'hidden'): void;
  requestFullscreen(): Promise<void>;
  exitFullscreen(): Promise<void>;
  isFullscreen(): boolean;
  getCallUrl(): string;
  openInNewTab(): Window | null;
}
```

События: `ready`, `joined`, `left`, `participant-joined`, `participant-left`,
`remote-stream`, `chat`, `quality-changed`, `connection-state`, `error`,
`screen-share-changed`, `theme-changed`, `media-state`, `noise-detected`,
`minimized-changed`, `chat-mode-changed`.

`noise-detected` (`{ level, rms, at }`) — локальная подсказка «слишком шумно»;
аудио не покидает браузер (см. `noise-detection.md`).

`getStats()` возвращает: качество/тир, RTT/потери/джиттер/битрейт, разрешение
и FPS, число пиров, длительность, запись/субтитры/блюр (с `blurDegraded`),
ICE-restart счётчик, состояние сервера/WS и т.д.

### Личный P2P-аудиозвонок

Создайте комнату с `mode: 'direct'` и `transport: 'p2p'`. Передайте `audioOnly: true` в `mount()` обоим участникам. Встроенная кнопка «Предложить видеозвонок» отправляет запрос собеседнику. До подтверждения камеры не запрашиваются. Если собеседник отклонит запрос или не ответит в течение 30 секунд, связь остаётся аудио. При согласии каждый браузер запрашивает камеру и звонок продолжается в той же комнате.

Для `ui: 'headless'` вызывайте `call.requestVideoUpgrade()` по кнопке и подписывайтесь через `call.subscribe()`. При `state.videoUpgrade?.direction === 'incoming'` покажите два действия и вызовите `call.respondToVideoUpgrade(state.videoUpgrade.requestId, true)` или `false`. Переданные `true` от методов означают, что сигнал отправлен. Фактическое включение камеры проверяйте через `state.settings.camEnabled`. Для `createEmbed()` и `createCallUrl()` используйте ту же опцию `audioOnly: true`.

## 5. iframe-режим

```ts
const { html, iframe } = AgilFrame.createEmbed({
  serverUrl, room, token, tenantId, participantName, locale,
  theme: { scheme: 'dark' }, width: '100%', height: 640,
});
container.append(iframe!);
```

URL: `/embed.html?server=&room=&token=&tenant=&lang=&theme=&name=&role=`. Для аудиорежима добавьте `audioOnly=1`.

`<agil-call audio-only>` поддерживает те же действия. В `agil-state` доступны `audioOnly` и `videoUpgrade`. `requestVideoUpgrade()` отправляет `agil:action` с действием `request-video-upgrade`. `respondToVideoUpgrade(requestId, accept)` отправляет `agil:video-upgrade-response` с идентификатором текущего запроса и явным ответом. Методы компонента подтверждают отправку команды в iframe. Состояние камеры приходит отдельным событием `agil-state`. Для управления со страницы должны быть разрешены её origin и `embedPostMessage`.

### Сообщения родитель → iframe

| Сообщение | Действие |
|---|---|
| `{type:'agil:config', config}` | `updateConfig(config)` локально. |
| `{type:'agil:theme', theme}` | `updateTheme(theme)`. |
| `{type:'agil:scheme', scheme}` | `setThemeScheme`. |
| `{type:'agil:action', action}` | `toggle-mic`, `toggle-camera`, `toggle-chat`, `share-screen`, `blur-on`, `blur-off`, `minimize`, `restore`, `pip`, `fullscreen`, `newtab`, `leave`. |
| `{type:'agil:chat-send', text}` | `sendChat(text)` (кроме `chatMode:'hidden'`). |
| `{type:'agil:ping'}` | ответ `{type:'agil:pong'}`. |

### iframe → родитель

`{type:'agil:ready', capabilities:{media,blur,screenShare,captions,recording}}`,
`{type:'agil:event', event, payload}`, `{type:'agil:chat', message}`,
`{type:'agil:state', state:{participants,quality,connectionState,minimized,chatMode,fullscreen,…}}`,
`{type:'agil:minimized', minimized}`, `{type:'agil:fullscreen', fullscreen}`, `{type:'agil:pong'}`.
Запрещённое/неизвестное действие → `agil:event {event:'action-denied', payload:{action, reason}}`.

**Origin-политика:** сообщения принимаются только от `window.parent`; origin
должен быть same-origin или входить в `integrations.allowedOrigins` тенанта.
Пустой список = только same-origin. Для встраивания на домене компании добавьте
`https://app.company.com` в `integrations.allowedOrigins`.

## 6. Персист звонка между страницами

1. Включите `layout.persistAcrossPages: true` в конфиге тенанта **или** вызовите
   `call.persistSession(true)`.
2. Виджет пишет в `sessionStorage` ключ `agil-calls:session`:
   `{room, token, tenantId, participantName, serverUrl, role, locale, theme}`.
3. На новой странице:

```ts
const call = await AgilFrame.resume('#call');
// → null, если сохранённой сессии нет
```

В SPA виджет монтируется один раз и не разрушается при смене роутов — звонок не
прерывается. При полной навигации медиа пересоздаётся (камера/микрофон
запрашиваются заново).

## 7. Темы

Тема — это `ThemeTokens` (`@agil/protocol/theme.ts`): 36 цветовых токенов,
типографика, радиусы/тени, плотность, фон (solid/gradient/image), лого, motion.
Виджет сериализует их в `--agil-*` на корне; собственных цветов в CSS нет.

```ts
call.updateTheme({ colors: { primary: '#0b5fff' } });
call.updateConfig({ theme: { scheme: 'auto' } });
AgilFrame.auditTheme(AgilFrame.themePresets.corporate); // подсказки по контрасту
```

Смешанные preset×scheme нормализуются: `AgilFrame.themeForScheme(preset, scheme)`
пересобирает палитру нужной схемы и доводит контраст ссылок/навигации/бейджей до
WCAG AA; `AgilFrame.ensureReadableTheme(theme)` можно применить к своей теме.
Полная тема/конфиг приходят с сервера (`GET /v1/tenants/:id/config`), локальные
оверлеи `options.theme`/`options.config` применяются поверх.

## 8. Права, локация, безопасность

- `permissions` из join/welcome — единственный источник правды: UI скрывает
  недоступные функции; сервер всё равно проверяет права.
- Локация: страна/город — только модератору/хосту; GPS — только по явному
  согласию (`security.geo.gpsEnabled` + чекбокс), отправляется
  `{type:'location', lat, lon, accuracyM, consent:true}`.
- Все пользовательские строки вставляются как `textContent`; URL — только
  `http(s)` и `rel="noopener noreferrer"`.

## 9. Провайдеры и автономность

Всё работает из коробки (builtin), компания может заменить отдельные
возможности своими системами (`agil/core/docs/extensibility.md`).

| Слот | Влияние на виджет |
|---|---|
| `providers.chat.mode` | `external` (и `session.chat.ui` не задан явно) → виджет ведёт себя как `chat.ui='external'`: своей панели нет, сообщения — через `onEvent('chat')`/`agil:chat`, отправка — `sendChat()`/`agil:chat-send`. `disabled` → чат скрыт. Явный `session.chat.ui` (сервер или `options.config`) приоритетнее. |
| `providers.backgrounds.mode` | `external` → список из `GET /v1/tenants/:id/backgrounds` (`{backgrounds:[{id,name,url}], provider}`); иначе — `session.virtualBackgrounds`. Провайдер недоступен → тихий fallback на встроенные фоны/градиенты. |
| `providers.files`, `providers.stt`, `providers.recording` | Полностью серверная маршрутизация, API виджета не меняется. При 502 от `/v1/stt/transcribe` — сообщение «сервис компании недоступен, используется встроенный» и fallback на браузерный Web Speech. |

Виджет не требует внешних сервисов: медиа/чат/файлы/запись/браузерный STT/
локальные заметки/темы/права/аудит работают автономно. Интернет нужен только для
TURN, CDN MediaPipe (иначе degraded-блюр) и опциональных AI/knowledge/integrity.

## 10. Звонок в мессенджере

Полный гайд — [agil/core/docs/messenger.md](messenger.md). SDK-часть:

```ts
// deep link на звонок (для карточки в чате/письме/уведомлении)
const url = AgilFrame.createCallUrl({
  serverUrl, room, token, tenantId, participantName, locale,
  theme: { scheme: 'auto' },
});

// открыть звонок в новой вкладке (null при блокировке popup)
const win = AgilFrame.openCall({ serverUrl, room, token, tenantId });
```

Виджет-часть: `requestFullscreen()/exitFullscreen()/isFullscreen()` (кнопка
`data-agil-action="fullscreen"`, Esc синхронизируется), `openInNewTab()`
(кнопка `data-agil-action="newtab"`, при popup blocked — toast со ссылкой),
`minimize()`/`requestPictureInPicture()`.

Если `room.mode='direct'` и в комнате двое, виджет предлагает spotlight-лейаут
(когда `layout.mode` не задан явно) и показывает в шапке `room.context.title`
или имя собеседника. Рекомендуемые настройки для мессенджера:
`layout.chrome='none'`, `session.chat.ui='hidden'`, `layout.minimized.enabled=true`.

> **Токен в URL.** `getCallUrl()`/`createCallUrl()` кладут join-token в query
> (`/embed.html?...&token=...`). Токен короткоживущий; не логируйте ссылку,
> используйте минимальный TTL, `POST /v1/admin/rooms/:id/lock`/`kick` при утечке.

## 11. Ассистент в звонке

In-call AI-агент с правами пользователя и spotlight-подсказками
([agil/core/docs/in-call-agent.md](in-call-agent.md)), внешняя LLM —
[agil/core/docs/llm-integrations.md](llm-integrations.md).

```ts
// панель открывается кнопкой data-agil-action="assistant"
// или программно через чат-подобный UI; агент отвечает на команды:
// «включи запись» (если есть право recording), «открой чат», «где микрофон?»
```

- `config.session.inCallAgent`: `enabled`, `mode` (`local|external|hybrid`),
  `allowedTools`, `spotlight`, `maxActionsPerReply`, `denyMessage`.
- **local** — офлайн-движок `localAssistantReply` (`@agil/protocol`): работает
  без сети и LLM; понимает ru/en команды, возвращает `actions` и `spotlight`.
- **external/hybrid** — `POST /v1/rooms/:roomId/assistant`
  (`authorization: Bearer <join token>`, тело `{text, locale, state}`) →
  `AssistantReply`. Ответ валидируется `assistantReplySchema`; действия
  фильтруются `filterAssistantActions` по правам пользователя. При 501/404/
  локальном сервере или (в hybrid) ошибке — fallback на локальный движок.
- Действия исполняются через публичные методы инстанса: запись (host/moderator),
  mic/camera/screen share, hand raise, открытие чата/файлов/участников/заметок/
  настроек, blur, minimize/restore, fullscreen, new tab, копирование invite.
  Недоступное — тост `denyMessage`, звонок не прерывается.
- **Spotlight**: затемнение, подсветка по target (`mic`, `camera`, `screen`,
  `chat`, `files`, `participants`, `notes`, `settings`, `blur`, `recording`,
  `minimize`, `fullscreen`, `newtab`, `invite` или CSS-селектор), подсказка с
  шагами Далее/Назад/Понятно, Esc, `aria-live`; `data-agil-spotlight` на корне и
  `[data-agil-spotlight-target]` на элементе. Не блокирует звонок.
- E2E: `data-agil-assistant-ready`, `[data-agil-assistant-panel]`,
  `[data-agil-assistant-input]`, `[data-agil-assistant-send]`,
  `[data-agil-assistant-message]`, `[data-agil-assistant-answer]`.

## 12. Вебинары и стримы (broadcast)

UI-гейтинг [agil/core/docs/scaling.md](scaling.md):

- `welcome.room.mediaMode` / `config.scale.mediaMode` + `scale.webinar`;
  на корне `data-agil-media-mode="mesh|sfu|broadcast"` и
  `data-agil-viewer="true|false"`;
- в broadcast/host-only-publish гость — зритель: mic/camera/screen/blur
  скрыты и не публикуются, бейдж «Вы зритель» + «Поднимите руку…»; чат, рука и
  реакции доступны (реакции по `webinar.reactions`), хост/модератор публикует
  как обычно;
- в шапке — бейдж mediaMode и число зрителей; рендерится ≤50 плиток, остальные
  суммируются в «+N зрителей» (клик — панель участников);
- moderated chat: после отправки зрителю показывается «Сообщение отправлено на
  модерацию»;
- `getStats()` содержит `mediaMode`/`viewer`. Серверный receive-only/SFU —
  отдельный этап; в mesh-звонке поведение не меняется.

## 13. Кастомизация лейаута (island, скрытие, порядок)

Полное описание — [agil/core/docs/layout.md](layout.md). Пример:

```ts
const call = await AgilFrame.mount('#call', {
  serverUrl, room, token,
  config: {
    layout: {
      chrome: 'none',                 // без шапки/фона — как часть страницы компании
      controlsStyle: 'island',        // плавающий остров
      controlsAnchor: 'bottom-center',
      hiddenControls: ['chat', 'recording'], // чат остаётся в мессенджере
      controlOrder: ['mic', 'camera', 'screen', 'leave'],
      autoHideControls: true,
      autoHideDelaySec: 4,
      minimized: { enabled: true, mode: 'bubble' },
    },
  },
});

// на лету, без перезагрузки:
call.updateConfig({ layout: { controlsStyle: 'minimal', controlsAnchor: 'bottom-right' } });
```

- `controlsStyle`: `bar` | `island` | `minimal`; island показывает ключевые
  кнопки и «⋯»-popover, minimal — только mic/camera/leave + «⋯».
- `hiddenControls` — только визуально (API/шорткаты доступны); `controlOrder`
  сортирует; `autoHideControls/autoHideDelaySec` — скрытие по простою и показ
  по pointermove/tap/focus.
- data-атрибуты: `data-agil-controls-style`, `data-agil-controls-anchor`,
  `data-agil-control="mic|..."`, `[data-agil-more]`.
- Готовый образец «чужого» стиля — страница `/index.html` в demo
  ([agil/core/docs/layout.md §4](layout.md)).

## 14. Используемые серверные API

`GET /v1/health`, `GET /v1/tenants/:id/config`, `POST /v1/rooms`,
`POST /v1/rooms/:id/join`, `POST /v1/files`, `POST /v1/recordings`,
`POST /v1/stt/transcribe`, WS `/ws` (§5), а также (для внешнего чата хоста)
`POST /v1/rooms/:id/chat` и admin `POST /v1/admin/rooms/:id/chat` — их вызывает
интеграция компании, не SDK.

## 15. Troubleshooting

| Симптом | Причина/решение |
|---|---|
| «Сервер недоступен» | Проверьте `serverUrl`, CORS/прокси; виджет предложит демо-режим без сети. |
| Нет камеры/микрофона | Разрешения браузера, HTTPS/localhost; доступен режим «только слушать». |
| `action-denied` в iframe | Origin не в `integrations.allowedOrigins` или фича запрещена правами. |
| «Сегментация недоступна (CDN)» | Заблокирован jsdelivr/storage.googleapis.com — включён упрощённый блюр. |
| Субтитры не работают | Web Speech только Chrome/Edge; серверный STT должен быть настроен (иначе 501). |
| «Сервис компании недоступен…» | 502 от `/v1/stt/transcribe` (внешний STT-провайдер упал) — включён встроенный браузерный STT. |
| Свой чат не отображается | `providers.chat.mode='external'` или `session.chat.ui='external'/'hidden'` — это ожидаемо; смотрите `data-agil-chat-mode` и `setChatMode()`. |
| Ассистент не выполняет действие | Нет права на tool (см. `assistantToolRequirements`); показывается `denyMessage`. Панель при этом остаётся доступной. |
| Ассистент отвечает «агент компании недоступен» | `mode='external'`, endpoint недоступен и fallback не разрешён; проверьте `PUT /v1/admin/ai-agent`/providers и `agil/core/docs/llm-integrations.md`. |
| Document PiP вернул `false` | Браузер не поддерживает `documentPictureInPicture` — включён fallback на мини-окно. |

## 16. Профили комнат

Профиль хранится в каталоге вашей организации и описывает тип комнаты, выбор медиа и доступные функции. `schemaVersion` определяет формат профиля, `id` и `version` определяют опубликованную редакцию вашей организации. Сервер компании выбирает профиль из своего каталога. Сохраните `ProfileRoomResult.profile` вместе с `room.id` в карточке события, чтобы связать его с версией профиля.

```ts
import { createProfileRoom, type RoomProfileV1 } from '@agil/calls-sdk';

const training = {
  schemaVersion: 1,
  id: 'training',
  version: 1,
  room: { mode: 'group', media: 'sfu' },
  features: ['chat', 'participantList', 'screenShare'],
  roles: {
    host: ['chat', 'participantList', 'screenShare'],
    moderator: ['chat', 'participantList'],
    guest: ['chat'],
  },
} satisfies RoomProfileV1;

const event = await createProfileRoom({
  serverUrl: process.env.AGIL_SERVER_URL!,
  apiKey: process.env.AGIL_TENANT_KEY!,
  profile: training,
  room: { tenantId: 'acme', roomId: 'training-2026-11-27', name: 'Тренинг', maxParticipants: 12 },
});
```

`createProfileRoom` выполняется на сервере компании и использует `POST /v1/admin/rooms`. Ключ организации остаётся на сервере компании. Для отдельной проверки заявки используйте `compileRoomProfile`. Она возвращает `CreateRoomRequest`, который можно передать через существующий админ-клиент. При `media: 'sfu'` используйте `createProfileRoom` для проверки настроек организации перед созданием и фактического медиарежима из ответа Core.

| `room.media` | Что выбирает Core |
|---|---|
| `tenant` | Текущий медиарежим организации с учётом `room.mode`. |
| `p2p` | Прямую комнату на два места. Серверный egress, стриминг и вебинар отключаются для этой комнаты. |
| `sfu` | SFU, если профиль организации даёт `sfu` для этого типа комнаты. При несовпадении SDK возвращает `room_profile_media_mismatch`. |

`features` задаёт набор функций комнаты. Каждая роль в профиле может получать функции только из этого набора. Core применяет эти списки как значения по умолчанию для `host`, `moderator` и `guest`. Действующие правила организации, такие как строгий режим, явные полномочия токена, пользовательские и корпоративные роли и глобальные запреты, продолжают участвовать в расчёте доступа. Запись, SFU и другие интеграции требуют соответствующих провайдеров. Для комнаты со списком `allowedParticipantIds` сервер компании выдаёт индивидуальные токены допущенным участникам и передаёт браузеру только токен текущего пользователя.

Встроенный виджет и `ui: 'headless'` читают `call.getState().permissions` и фактический медиарежим из одной сессии. Для headless UI используйте `call.subscribe(render)`, чтобы обновлять действия после входа, переподключения и смены правил. Core продолжает проверять полномочия на сервере.

Для локальной приёмки соберите SDK и запустите сценарий из корня репозитория. Тест создаёт две версии одного профиля, проверяет роли на живом Core и подключает стандартный и headless SDK.

```sh
npm run build -w @agil/calls-sdk
node --import tsx agil/core/qa/room-profiles-e2e.mjs
```

## 17. Переключение голосовых каналов

Сервер компании создаёт каналы и состав участников через `POST /v1/admin/voice-channels`. Когда пользователь выбирает канал, сервер компании удостоверяет его личность и запрашивает персональный допуск через `POST /v1/admin/voice-channels/:channelId/join` с корпоративным `participantId`. Браузер получает `{roomId, token}` своего пользователя. При новой попытке входа запрашивайте новый допуск. После изменения состава канала или восстановления Core идентификатор комнаты может измениться.

```ts
import { createVoiceChannelSwitcher } from '@agil/calls-sdk';

const channels = createVoiceChannelSwitcher('#call', {
  call: { serverUrl: 'https://calls.example.com', tenantId: 'acme' },
  async getGrant(channelId, signal) {
    const response = await fetch(`/voice-channels/${encodeURIComponent(channelId)}/join`, {
      method: 'POST', signal,
    });
    if (!response.ok) throw new Error('Не удалось войти в голосовой канал');
    return response.json();
  },
});

const selected = await channels.switchTo('daily');
if (selected) console.log(selected.call.getState().phase);
// При выходе с экрана каналов
await channels.leave();
```

SDK сначала получает допуск в новый канал. Если выдача допуска завершилась ошибкой, текущий разговор продолжается. Получив допуск, SDK закрывает старый вызов перед входом в новый. Последний выбор пользователя заменяет ожидающие запросы, которые возвращают `null`. Новый вызов начинается с выключенной камерой. Её можно включить через `call.toggleCamera()` при наличии доступа. Для своего интерфейса укажите `call.ui: 'headless'` и обновите плееры при смене сессии, используя `remote-stream` и снимок `getRemoteStreams()`.

Локальная проверка поднимает два закрытых канала, подключает двух собеседников и сравнивает декодированный звук до и после переключения.

```sh
npm run build -w @agil/calls-sdk
node --import tsx agil/core/qa/voice-channel-switch-e2e.mjs
```
