# AgilFrame — контракт монорепо (для команды и для агентов)

Этот файл — единый источник правды по границам пакетов, API, сигналингу и
именам. Если код расходится с контрактом — правится либо код, либо контракт
(через Lead), но не «каждый по-своему».

## 1. Раскладка и владение

| Путь | Что это | Владелец |
|---|---|---|
| `agil/core/packages/protocol` | Общие контракты: темы/токены, TenantConfig, сигналинг, quality-политика, JWT | Lead (заморожен) |
| `agil/core/apps/server` | HTTP REST API + WebSocket сигналинг + статика | backend |
| `agil/websdk/widget` | Встраиваемый UI: WebRTC-движок, темы, чат, блюр фона | frontend |
| `agil/websdk/sdk` | `agil-calls.js` (global `AGILCalls`) + iframe-режим | frontend |
| `agil/websdk/demo` | Хост-страница «как встроить», `embed.html` | frontend |
| `agil/core/packages/mcp` | MCP-сервер (stdio) для нейросетей | mcp-editor |
| `agil/core/apps/editor` | Визуальный редактор панели (тема/фичи/лейаут) | mcp-editor |
| `agil/core/docs/` | Архитектура, API, RE-анализ, оценки | Lead + researcher |
| `package.json`, `tsconfig*.json`, `agil/core/scripts/` | Каркас | Lead (менять только через Lead) |

Правила: не ставить новые npm-зависимости (все уже в корневом `package.json`),
не менять файлы чужих пакетов, не трогать корневой `package.json`/lockfile.
Нужна библиотека — сообщи Lead.

## 2. Окружение и команды

```bash
npm install                      # один раз в корне
npm run build                    # protocol -> server -> widget -> sdk -> mcp -> demo -> editor
npm test                         # protocol + server + mcp тесты
npm run dev                      # server:8787 + demo:5173 + editor:5174
node agil/core/scripts/dev.mjs             # то же самое
npm run e2e                      # headless Chrome: 2 участника, чат, тема
```

Node 23, TypeScript 5.9, Vite 6, zod 3.25, ws 8, @modelcontextprotocol/sdk 1.32,
puppeteer-core 25 (headless Chrome/Edge уже установлены).

Порты: **server 8787**, **demo 5173**, **editor 5174** (base `/editor/`).

Переменные окружения сервера (все с dev-дефолтами):

| Переменная | Default | Смысл |
|---|---|---|
| `PORT` | `8787` | HTTP+WS порт |
| `AGIL_TOKEN_SECRET` | `dev-secret-agil-calls` | секрет JWT (HS256) |
| `AGIL_API_KEYS` | `dev-key:demo` | `key:tenant[,key:tenant]` |
| `AGIL_ALLOW_ANONYMOUS` | `1` | разрешить `POST /v1/rooms` и WS без токена (demo) |
| `AGIL_PUBLIC_ABUSE_MODE` | `off` | режим лимитов публичного доступа по умолчанию: `off`, `observe` или `enforce`. Организация может выбрать свой режим через `security.publicAbuseMode` |
| `AGIL_DATA_DIR` | `.data` | персист конфигов тенантов |
| `AGIL_STATIC_DIR` | `agil/websdk/demo/dist` | статика demo |
| `AGIL_EDITOR_DIR` | `agil/core/apps/editor/dist` | статика редактора (`/editor/`) |
| `AGIL_SDK_DIR` | `agil/websdk/sdk/dist` | статика SDK (`/sdk/`) |
| `AGIL_WIDGET_DIR` | `agil/websdk/widget/dist` | статика виджета (`/widget/`) |
| `AGIL_PUBLIC_ORIGIN` | `http://localhost:8787` | база для `joinUrl`/`embedUrl` |
| `AGIL_ICE_SERVERS` | `[{"urls":"stun:stun.l.google.com:19302"}]` | JSON, отдаётся в `welcome` |
| `AGIL_ROOM_TTL_SEC` | `0` | авто-закрытие пустых комнат (0 = выкл) |

## 3. `@agil/protocol` (главное)

Экспорт из `@agil/protocol` (браузер-безопасно):

```ts
// theme.ts
themePresets: Record<'light'|'dark'|'corporate'|'night'|'minimal', ThemeTokens>
themeSchema, themePatchSchema, themeColorKeys
resolveTheme(patch?, scheme?: 'light'|'dark'|'auto'): ThemeTokens
deepMerge(base, patch)
effectiveScheme(theme, prefersDark): 'light'|'dark'
applyBrandColor(theme, color): ThemeTokens
themeFromBrandColor(color, preset?): ThemeTokens
toCssVars(theme): Record<string,string>        // --agil-color-primary, --agil-radius-md, ...
cssVarsToString(vars): string
auditTheme(theme): ThemeAuditIssue[]
suggestOnColor(bg, candidates?): string

// color.ts
normalizeHex, hexToRgb, rgbToHex, contrastRatio, relativeLuminance, mix,
lighten, darken, withAlpha, isDark, bestTextColor, generatePalette(brand, scheme), isHexColor

// config.ts
tenantConfigSchema, tenantConfigPatchSchema  // zod: полный / deep-partial
defaultConfig({tenantId?, themePreset?, themePatch?, roomName?, overrides?}): TenantConfig
resolveTenantConfig(patch, base?, opts?): TenantConfig
DEFAULT_TENANT_ID, DEFAULT_FEATURES, DEFAULT_LAYOUT, ...
enabledFeatures(config), isEnabled(config, feature)

// signaling.ts — все типы сообщений и zod-схемы (см. §5)
clientMessageSchema, parseClientMessage(raw), encodeMessage(msg),
Participant, ParticipantState, RoomInfo, ChatMessage, ChatId, ServerMessage, WelcomeMessage

// quality.ts
evaluateQuality(snapshot, lowBandwidthConfig, previousTier?): QualityDecision
scoreQuality(snapshot, cfg): number
shouldEscalate(prev, next), tierLabel(tier, locale)
```

Node-only: `@agil/protocol/token`:

```ts
signToken(claims: Omit<TokenClaims,'iat'|'exp'>, secret, {ttlSec?, now?}): string
verifyToken(token, secret, {now?, clockToleranceSec?}): {valid:true, claims} | {valid:false, error}
decodeTokenUnsafe(token): TokenClaims|null
```

`TenantConfig` — полный вид (обязательные поля, валидируется zod):
`{ configVersion:1, tenantId, branding, theme, features, audio, video, limits,
   fallback:{lowBandwidth}, security, layout, session, room }`.
Патч — любой deep-partial (в т.ч. `{theme:{colors:{primary:'#0b5fff'}}}`).

Тема: `scheme:'light'|'dark'|'auto'`, `colors` (36 токенов), `typography`,
`shape`, `spacing`, `background`, `logo`, `motion`. Всё, что видно в UI, берётся
из `toCssVars()`; захардкоженных цветов в вёрстке виджета быть не должно
(только `var(--agil-...)`).

## 4. HTTP API (agil/core/apps/server)

Префикс `/v1`. JSON, `content-type: application/json`. CORS: `*`,
разрешены заголовки `content-type, x-api-key`. Ошибки: `{error:{code,message}}`.

| Метод | Путь | Auth | Тело | Ответ |
|---|---|---|---|---|
| GET | `/v1/health` | — | — | `{ok:true,name,version,uptimeSec,rooms,tenants}` |
| GET | `/v1/ice` | — | — | `{iceServers:IceServerConfig[]}`, только STUN без учётных данных. TURN передаётся в `welcome.iceServers`. |
| GET | `/v1/tenants/:tenantId/config` | — | — | `{config:TenantConfig, etag}` (неизвестный тенант → дефолт) |
| PUT | `/v1/tenants/:tenantId/config` | `x-api-key` | `TenantConfig` | `{config, etag}` |
| PATCH | `/v1/tenants/:tenantId/config` | `x-api-key` | `TenantConfigPatch` | `{config, etag}` |
| POST | `/v1/rooms` | `x-api-key` или anonymous | `{tenantId?, roomId?, name?, configOverrides?}` | `{room, joinUrl, embedUrl, token?}` |
| POST | `/v1/tokens` | `x-api-key` | `{tenantId, roomId, participant:{name, role?}, ttlSec?}` | `{token, expiresAt, tenantId, roomId}` |
| GET | `/v1/rooms/:roomId` | `x-api-key` | — | `{room, participants, createdAt}` |
| DELETE | `/v1/rooms/:roomId` | `x-api-key` | — | `{closed:true}` |
| GET | `/v1/rooms/:roomId/messages?limit=100` | `x-api-key` | — | `{messages:ChatMessage[]}` |

Детали:
- `POST /v1/rooms` создаёт тенанту комнату (id = `crypto.randomUUID()` или
  `roomId`), `joinUrl = ${AGIL_PUBLIC_ORIGIN}/?room=<id>&token=<jwt>&tenant=<t>`,
  `embedUrl = ${AGIL_PUBLIC_ORIGIN}/embed.html?room=<id>&token=<jwt>&tenant=<t>`.
  Если `AGIL_ALLOW_ANONYMOUS=1` — токен выдаётся сразу и возвращается в ответе.
- `PUT/PATCH /v1/tenants/:id/config`: ключ должен принадлежать этому тенанту,
  иначе 403. Валидация zod; ошибка 400 с перечнем issues. После сохранения —
  broadcast `{type:'config', config}` во все WS-сокеты комнат тенанта.
- Персист: `<AGIL_DATA_DIR>/tenants/<tenantId>.json` (mkdir -p, atomic write).
- Комнаты/участники/история чата — в памяти; история чата опционально пишется в
  `<AGIL_DATA_DIR>/rooms/<roomId>.json` (последние 200 сообщений).
- Статика: `/` → demo (SPA fallback на index.html), `/editor/` → editor,
  `/sdk/*` → sdk, `/widget/*` → widget. `/v1/*` и `/ws` не перехватываются.

## 5. WebSocket сигналинг (`/ws`)

Подключение: `ws(s)://<host>/ws?token=<jwt>` (предпочтительно для CLI/серверных
клиентов) либо, при `AGIL_ALLOW_ANONYMOUS=1`,
`?tenant=<t>&room=<id>&name=<name>&role=guest`. Браузерный виджет передаёт JWT
в handshake-заголовке `Sec-WebSocket-Protocol` (`agil-calls.v1` +
`agil-token.<url-encoded-jwt>`), а не в URL; сервер принимает оба варианта.
Сразу после подключения сервер шлёт `welcome` или `error` (fatal) и закрывает.

Клиент → сервер (`ClientMessage`):

| type | Поля | Смысл |
|---|---|---|
| `hello` | `{name?, locale?}` | уточнить имя/локаль после входа |
| `sdp` | `{to, description:{type:'offer'\|'answer', sdp}}` | relay SDP конкретному пиру |
| `ice` | `{to, candidate:{candidate, sdpMid?, sdpMLineIndex?, usernameFragment?}}` | relay ICE |
| `chat` | `{id, text (1..4000), attachment?, acknowledge?}` | Сообщение чата с идентификатором клиента. Передайте `acknowledge: true`, если `welcome.chatAcknowledgements` установлено. |
| `state` | `{state: Partial<ParticipantState>}` | mic/cam/screen/handRaised/network |
| `reaction` | `{emoji, ts?}` | реакция |
| `ping` | `{ts, refreshIce?, refreshSfu?}` | Keepalive. Set `refreshIce: true` to receive fresh temporary TURN data when due. `refreshSfu: true` requests a new media token for the current SFU room and participant. |
| `history` | `{limit?}` | запросить историю чата |
| `bye` | `{}` | выйти |

Сервер → клиент (`ServerMessage`):

| type | Поля |
|---|---|
| `welcome` | `{self, room, participants[], config, iceServers[], serverTime, history[], chatAcknowledgements?}` |
| `peer-joined` | `{participant}` |
| `peer-left` | `{participantId, reason?}` |
| `sdp` | `{from, description}` |
| `ice` | `{from, candidate}` |
| `chat` | `{message}` — отправляется всем, включая автора (дедуп по `id`) |
| `chat-result` | `{id, message}` или `{id, error}`. Ответ получает отправитель, запросивший подтверждение. `id` совпадает с идентификатором запроса, даже если провайдер назначил сообщению другой идентификатор. Ошибки: `unauthorized`, `delivery_failed`. |
| `chat-history` | `{messages}` |
| `state` | `{participantId, state}` |
| `reaction` | `{participantId, emoji, ts}` |
| `room` | `{room, participants}` |
| `config` | `{config}` (при изменении конфига тенанта) |
| `error` | `{code, message, fatal?}` |
| `pong` | `{ts, iceServers?, sfuMedia?}`. `sfuMedia` is returned only after `refreshSfu` and is `null` when the session cannot be renewed. ICE data is present only when a requested refresh is due. |
| `bye` | `{reason}` |

Коды ошибок: `bad_request | unauthorized | room_full | room_locked | unknown_peer
| rate_limited | internal_error`. Лимит: 40 сообщений/сек на сокет, больше —
`error rate_limited`; 3 нарушения → закрытие 1008.

Гарантии:
- Чат идёт **по сигналингу**. Для получения новых сообщений и запроса истории
  требуется включённый чат и эффективное право `chat` в комнате.
- `welcome.history` содержит до 200 последних сообщений комнаты при наличии
  прав `chat` и `chatHistoryOnJoin` и включённой истории при входе.
- `security.guestCanChat` управляет отправкой сообщений гостями.
- Новый участник получает `welcome` со списком текущих участников; все текущие
  получают `peer-joined`.

Mesh-согласование (детерминированно, без гонок):
1. Обе стороны узнают друг о друге (`welcome.participants` / `peer-joined`) и
   создают `RTCPeerConnection` + добавляют локальные треки.
2. **Инициатор — тот, чей `participant.id` лексикографически меньше.** Он делает
   `createOffer` → `sdp{to}`. Второй ждёт, отвечает `answer`.
3. ICE: обе стороны шлют `ice{to}` по мере появления кандидатов.
4. Renegotiation (screen share, смена треков) — через perfect negotiation
   (`negotiationneeded` + rollback на glare).
5. Медиа-деградация: `quality.evaluateQuality()` → действия (reduced/off video,
   chat-fallback), ICE-restart и переподключение с backoff из
   `config.fallback.lowBandwidth.autoReconnect`.

## 6. Виджет: публичный API (`@agil/calls-widget`)

```ts
export interface AgilCallOptions {
  serverUrl?: string;                 // default: window.location.origin
  room: string;
  token?: string;
  tenantId?: string;                  // default 'demo'
  participantName?: string;           // default 'Гость'
  role?: 'host' | 'moderator' | 'guest';
  locale?: 'ru' | 'en';
  theme?: ThemePatch;                 // локальный оверрайд темы поверх серверной
  config?: TenantConfigPatch;         // локальные оверрайды конфига
  embedded?: boolean;                 // true = без рамок, на весь контейнер
  onEvent?: (event: AgilWidgetEvent) => void;
  onChat?: (message: ChatMessage) => void;
}

export interface AgilWidgetInstance {
  join(): Promise<void>;
  leave(): void;
  destroy(): void;
  updateTheme(patch: ThemePatch): void;
  updateConfig(patch: TenantConfigPatch): void;
  setThemeScheme(scheme: 'light' | 'dark' | 'auto'): void;
  sendChat(text: string): Promise<ChatMessage>;
  toggleMic(force?: boolean): Promise<boolean>;
  toggleCamera(force?: boolean): Promise<boolean>;
  toggleScreenShare(force?: boolean): Promise<boolean>;
  setBlurMode(mode: 'off' | 'blur' | 'image', imageUrl?: string): Promise<void>;
  getStats(): Promise<CallStats>;
  getState(): CallState;
  on(event: AgilWidgetEventName, listener: (payload: unknown) => void): () => void;
}

export function mountWidget(container: HTMLElement, options: AgilCallOptions): Promise<AgilWidgetInstance>;
```

События: `ready, joined, left, participant-joined, participant-left,
remote-stream, chat, quality-changed, connection-state, error,
screen-share-changed, theme-changed, media-state`.

UI обязано: тёмная/светлая/авто тема (prefers-color-scheme), полный набор
токенов через CSS-переменные, чат-панель, участники, качество связи, контролы
(mic/cam/демонстрация/блюр/чат/рука/настройки/выход), сетка/спотлайт,
self-view, PiP, фуллскрин, горячие клавиши (`m`, `v`, `c`, `b`), i18n ru/en,
баннер деградации «слабый канал — чат продолжает работать», a11y (focus, aria).

Блюр/замена фона: `MediaStreamTrackProcessor`/canvas, сегментация
`@mediapipe/tasks-vision` через динамический `import()` с CDN
(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision`) — если сеть/CDN
недоступны, деградирует до CSS-блюра превью и флага `degraded:true` в
`getStats()`. Виртуальные фоны из `config.session.virtualBackgrounds`.

Кодеки/низкая задержка: применяет `config.video.codecs`/`audio.codecs` через
`setCodecPreferences`, simulcast (`sendEncodings` 3 слоя), SVC если
`scalableVideoCoding`, `degradationPreference`, `playoutDelayHint=0`,
`jitterBufferTarget`, DTX/RED из конфига, `contentHint`; умеет понижать
разрешение/битрейт по `evaluateQuality`.

## 7. `embed.html` (agil/websdk/demo) — iframe-контракт

URL: `/embed.html?server=<url>&room=<id>&token=<jwt>&tenant=<id>&lang=ru&theme=light|dark|auto&name=<name>&role=guest&identity_token=<oidc-jwt>`.
`theme` — только схема; полная тема/конфиг приходит с сервера и/или postMessage.
`identity_token` и `role` используются мобильными SDK и `<agil-call>`; `role`
допускает `host`/`moderator`/`guest`.

`postMessage` в iframe (от родителя):
- `{type:'agil:config', config: TenantConfigPatch|TenantConfig}` — применить
  локально (тема+фичи), не сохраняя. В окне `?preview=1` редактор передаёт
  `replace:true` с полным черновиком, чтобы предпросмотр применял и удаление
  необязательных полей.
- `{type:'agil:theme', theme: ThemePatch}`; `{type:'agil:scheme', scheme}`;
- `{type:'agil:chat-send', text}` — внешний чат;
- `{type:'agil:action', action:'toggle-mic'|'toggle-camera'|'toggle-chat'|'share-screen'|'blur-on'|'blur-off'|'leave'|'minimize'|'restore'|'pip'|'fullscreen'|'newtab'|'request-video-upgrade'}`;
- `{type:'agil:video-upgrade-response', requestId: string, accept: boolean}` — ответ на входящий запрос в прямом P2P-аудиозвонке;
- `{type:'agil:ping'}` → ответ `{type:'agil:pong'}`.

Из iframe (родителю; hosted `embed.html` использует `targetOrigin:'*'` для MVP,
SDK-обёртки проверяют `event.source` и `event.origin`):
- `{type:'agil:ready', capabilities:{media, blur, screenShare, captions, recording}}`;
- `{type:'agil:event', event, payload}`; `{type:'agil:chat', message}`;
- `{type:'agil:state', state:{participants, quality, connectionState, audioOnly, videoUpgrade, …}}`;
- `{type:'agil:minimized', minimized:boolean}`; `{type:'agil:fullscreen', fullscreen:boolean}`.

Флаг `agil:ready.capabilities.screenShare` показывает доступность захвата
экрана на устройстве. Если комната разрешает демонстрацию, но захват недоступен,
команда `share-screen` возвращает `action-denied` с действием `share-screen`
и причиной `screen-share-unavailable`. Входящая демонстрация остаётся доступной.

<a id="embed-postmessage-state"></a>

Первый снимок `agil:state` отправляется после `agil:ready`. Следующие снимки
передаются при изменении любого из опубликованных полей, включая
`settings.panel`, `recording`, `remoteRecording` и `minimized`.
`recording` показывает локальную запись текущего участника, а `remoteRecording`
показывает запись другим участником. После выхода `phase` принимает
значение `left`, `participants` равен нулю, а `participantIds` пуст.

## 8. SDK (`@agil/calls-sdk`) — `agil-calls.js`

```html
<script src="http://localhost:8787/sdk/agil-calls.js"></script>
<script>
  const call = await AGILCalls.mount('#call', {
    room: 'team-sync', token: '<jwt>', serverUrl: 'http://localhost:8787',
    theme: { scheme: 'dark' }
  });
  // либо iframe-режим:
  const { html } = AGILCalls.createEmbed({ room:'team-sync', token:'<jwt>', serverUrl:'http://localhost:8787', theme:{scheme:'auto'} });
</script>
```
Global `AGILCalls`: `{ version, mount, createEmbed, themePresets, resolveTheme,
generatePalette, auditTheme, presets: themePresetNames }`.
`mount` при `typeof window === 'undefined'` бросает ошибку; контейнер — элемент
или CSS-селектор. SDK бандлит виджет внутрь IIFE (один скрипт = всё).
ESM-сборка: `dist/agil-calls-sdk.js`; IIFE: `dist/agil-calls.js` (global).

## 9. MCP-сервер (`@agil/mcp`)

Транспорт: stdio (по умолчанию), запуск `node agil/core/packages/mcp/dist/index.js`.
Env: `AGIL_SERVER_URL` (default `http://localhost:8787`), `AGIL_API_KEY`
(default `dev-key`), `AGIL_TENANT_ID` (default `demo`).

Инструменты (имена фиксированы): `agil_get_config`, `agil_validate_config`,
`agil_update_config`, `agil_generate_theme`, `agil_apply_theme`,
`agil_list_theme_presets`, `agil_create_room`, `agil_create_token`,
`agil_get_embed_snippet`, `agil_audit_accessibility`,
`agil_suggest_lowbandwidth_profile`, `agil_get_server_health`,
`agil_get_docs`.
Ресурсы: `agil://docs/theming`, `agil://docs/api`, `agil://config/schema`.
Промпты: `agil-brand-setup`, `agil-embed-install`.
Требование: инструменты, которым нужен сервер, при недоступном сервере
возвращают **понятную** ошибку (`isError:true`, текст с подсказкой
`AGIL_SERVER_URL`), а оффлайн-инструменты (`generate_theme`, `validate_config`,
`audit_accessibility`, `get_embed_snippet`) работают без сети.

## 10. Визуальный редактор (`agil/core/apps/editor`)

Vite-приложение (base `/editor/`, dev 5174), без импорта виджета: превью —
iframe на `VITE_PREVIEW_URL` (default `http://localhost:5173/embed.html`)
+ `postMessage` из §7. Секции: Brand (цвет бренда → `generatePalette`, лого,
название), Presets (5 пресетов), Colors (все токены с color-picker и
контраст-бейджем из `auditTheme`), Typography/Shape/Spacing, Background,
Features (тумблеры), Layout, Audio/Video (кодеки, bitrate, simulcast),
Fallback (порог/стратегия), Security, Session (blur/фоны), Preview (iframe),
импорт/экспорт JSON, «Сохранить в тенант» (PATCH `/v1/tenants/:id/config` с
`x-api-key` из localStorage), «Скопировать embed-сниппет». Всё работает и без
сервера (локальный режим).

## 11. Definition of done для каждой зоны

- `npm run typecheck -w <пакет>` — без ошибок.
- `npm run build -w <пакет>` — собирается.
- `npm test -w <пакет>` — тесты зелёные (server/mcp/protocol).
- Публичный API соответствует §6–§10, README/доки не врут.
- Никаких секретов в клиентском бандле; токен только передаётся.
- Русские тексты UI в `ru`, английские в `en`, ключи i18n в одном файле.

---

# Расширение: безопасность, AI-агент, панель разработчика

## 12. `@agil/security` (Node-only, `agil/core/packages/security`)

Библиотека сервисов безопасности, которую импортирует сервер. Публичный API
(детали — в `agil/core/packages/security/README.md`):

```ts
hashPassword(plain: string): string        // scrypt N=16384 r=8 p=1, формат scrypt$N$r$p$saltB64$hashB64
verifyPassword(plain, stored): boolean     // constant-time
hashIp(ip: string, salt: string): string   // sha256 hex, 32 символа
resolveClientIp(input: {headers: Record<string,string|string[]|undefined>; remoteAddress?: string}): string
resolveGeo(ip, opts): Promise<{ country?: string; city?: string; vpn: boolean; source: 'header'|'lookup'|'none' }>
createRateLimiter(opts: {windowMs: number; max: number; maxKeys?: number}): { check(key): {allowed, retryAfterMs, remaining}; reset(key): void }
class AuditLog { constructor({dir, salt}); append(entry: Omit<AuditEntry,'id'|'ts'>): AuditEntry; list(opts?: {limit?, type?, roomId?, since?}): AuditEntry[]; countByType(since: number): Record<string,number> }
class FileStore { constructor({dir, secret, baseUrl, ttlSec}); save(opts): FileRecord; get(id, sig, exp): {record: FileRecord; data: Buffer} | null; list(opts): FileRecord[] }
class RecordingStore { constructor({dir, secret, baseUrl, ttlSec}); save(opts): RecordingRecord; get(id, sig, exp); list(opts); remove(id): boolean; attachTranscript(id, text): void }
class MediaIntegrityService { constructor(cfg); evaluate(input): {status: 'unknown'|'verified'|'suspicious'; score: number; flags: string[]} }
class SttService { isConfigured(): boolean; transcribe(audio: Buffer, opts: {mime: string; language?: string}): Promise<SttResponse> }
class SecurityError extends Error { code: 'password_required'|'password_invalid'|'geo_blocked'|'rate_limited'|'room_locked'|'file_too_large'|'unsupported_mime'|'not_found'|'stt_not_configured'|'integrity_failed' }
```

Правила:
- Пароль комнаты: `POST /v1/admin/rooms`/`POST /v1/rooms` принимает `password`,
  сервер хранит **только** `hashPassword(password)` в метаданных комнаты;
  в конфиг и в ответы API пароль/хэш не попадают (есть `passwordProtected`).
- Гео: `AGIL_GEO_PROVIDER` = `header` (по умолчанию; доверяем заголовкам
  `x-agil-country`, `cf-ipcountry`, `x-vercel-ip-country` при
  `AGIL_TRUST_PROXY=1`), `ipapi` (внешний lookup с кэшем 10 мин, timeout 1.2s,
  при ошибке `source:'none'`), `none`. Сервис **никогда не бросает**.
- Политика гео: заблокированные/неразрешённые страны → отказ в join
  (`geo_blocked`), событие `geo.blocked` в аудите. Пустой `allowedCountries` =
  разрешены все.
- Rate-limit: join (10/мин на IP+комнату), пароль (maxFailedJoinAttempts за
  lockoutSec → `lockout`), files/stt (30/мин на тенант), admin (120/мин).
- Аудит: JSONL `<AGIL_DATA_DIR>/audit/<tenantId>.jsonl`, IP только как
  `hashIp(ip, AGIL_IP_SALT)`; события из `AuditEventType`.
- Файлы/записи: `<AGIL_DATA_DIR>/files|recordings/<id>`, метаданные рядом
  (`<id>.json`), ссылки подписываются HMAC (`?sig=&exp=`), TTL
  `AGIL_FILE_TTL_SEC` (default 86400).
- Медиа-интеграция (anti-deepfake): локальные эвристики + опциональный внешний
  детектор (`AGIL_INTEGRITY_URL`, `AGIL_INTEGRITY_KEY`). Честные ограничения
  описать в README: браузерная детекция вероятностная, юридически значимая —
  только внешняя модель + liveness-challenge + C2PA-метки записей.
- STT: `AGIL_STT_URL` (OpenAI-совместимый базовый URL), `AGIL_STT_KEY`,
  `AGIL_STT_MODEL` (default `whisper-1`). Не настроено → `SttService.isConfigured()===false`,
  эндпоинт отвечает 501 с подсказкой. В браузере используется
  Web Speech API (Chrome/Edge), серверный STT — как fallback.

## 13. `@agil/ai` (Node-only, `agil/core/packages/ai`) — корпоративный AI-агент

```ts
class ComplianceEngine {
  constructor(opts: {rules: CompliancePolicyRule[]});
  analyzeSegment(segment: TranscriptSegment): ComplianceFinding[];  // phrase/regex/pii
}
class LocalNotesExtractor {
  extract(segments: TranscriptSegment[], opts?: {locale?: 'ru'|'en'; maxExcerpts?: number}): MeetingNotes;
}
class AiAgentClient {
  constructor(opts: {endpoint: string; apiKey?: string; hmacSecret?: string; timeoutMs?: number; maxRetries?: number});
  isConfigured(): boolean;
  analyze(request: AiAgentRequest): Promise<{ ok: true; response: AiAgentResponse; provider: string } | { ok: false; error: string; retryable: boolean }>;
}
```

- `ComplianceEngine` — детерминированные локальные правила (фразы, regex, PII:
  телефон/email/карта/паспорт), работают всегда и без сети.
- `LocalNotesExtractor` — экстрактивный суммаризатор: `MeetingNotes` с
  **выдержками** (`excerpts` — дословные цитаты с таймкодами и спикером),
  `summary`, `actionItems`, `decisions`, `risks`, `topics`, `sentiment`.
  Работает без AI-модели (нужен для офлайн-MVP и для fallback).
- `AiAgentClient` — вызов корпоративного AI-агента: POST `AiAgentRequest` c
  заголовками `x-agil-signature` (hex HMAC-SHA256 тела), `x-agil-request-id`,
  `x-agil-tenant`, `content-type: application/json`; ответ валидируется
  `parseAiAgentResponse` (недоверенный вход!), таймаут через AbortController,
  один ретрай на 5xx/сеть. Ответ = `findings[]` + `notes` (summary, excerpts,
  actionItems…).
- Поток: caption/transcript сегменты → локальные правила → (если
  `session.aiAgent.mode` = `external`|`hybrid`) батч в корпоративный агент →
  findings + notes → broadcast `{type:'analysis'}` модераторам, запись в аудит,
  прикрепление к записи звонка. Выдержки/заметки видны в панели «Заметки» и в
  дашборде (вкладки Transcript / Notes / Compliance).

`TenantConfig.session.aiAgent` (см. `compliance.ts`): `enabled, mode
('local'|'external'|'hybrid'), endpoint, apiKeyEnv, timeoutMs, sendTranscripts,
sendChat, batchSize, retentionMin, notifyModerators, policyText, policyRules[]`.
Сервер не хранит ключ AI-агента — только имя env-переменной (`apiKeyEnv`).

## 14. REST: join / файлы / записи / STT / admin

### Публичные (участник)

| Метод | Путь | Auth | Описание |
|---|---|---|---|
| POST | `/v1/rooms/:roomId/join` | — (rate-limited) | `JoinRoomRequest` → `JoinRoomResponse`. Проверяет пароль/гео/lock/лимит, пишет аудит, выдаёт token |
| POST | `/v1/files` | `authorization: Bearer <join token>` | raw body + `x-file-name`, `content-type` → `FileRecord` (лимит `session.fileShare.maxFileSizeMb`) |
| GET | `/v1/files/:id?sig=&exp=` | подпись | бинарь |
| POST | `/v1/recordings` | Bearer | raw webm/mp4 + `x-recording-meta` JSON `{roomId, durationSec, mimeType}` → `RecordingRecord` |
| GET | `/v1/recordings/:id?sig=&exp=` | подпись | бинарь |
| POST | `/v1/stt/transcribe` | Bearer | raw audio (`audio/webm`, `audio/wav`) + `x-language: ru|en` → `SttResponse`; 501 если STT не настроен |

### Admin (`x-api-key`, тенант из ключа)

| Метод | Путь | Описание |
|---|---|---|
| GET | `/v1/admin/overview` | `AdminOverview` |
| GET | `/v1/admin/rooms` | `{rooms: AdminRoomSummary[]}` |
| POST | `/v1/admin/rooms` | `CreateRoomRequest` → `CreateRoomResponse` (пароль только хэшем) |
| GET | `/v1/admin/rooms/:roomId` | `RoomDetail` (участники, чат, ссылки) |
| DELETE | `/v1/admin/rooms/:roomId` | `{closed:true}` |
| POST | `/v1/admin/rooms/:roomId/invites` | `{ttlSec?, role?}` → `InviteLink` |
| POST | `/v1/admin/rooms/:roomId/lock` | `{locked}` → `{locked}` |
| POST | `/v1/admin/rooms/:roomId/kick` | `{participantId}` → `{kicked:true}` |
| GET | `/v1/admin/rooms/:roomId/transcript` | `TranscriptResponse` |
| GET | `/v1/admin/rooms/:roomId/analysis` | `AnalysisResponse` (report+findings+notes) |
| POST | `/v1/admin/rooms/:roomId/analysis/run` | принудительный прогон AI-агента → `AnalysisResponse` |
| GET | `/v1/admin/audit?limit=&type=&roomId=` | `{entries: AuditEntry[]}` |
| GET | `/v1/admin/security` | `SecurityOverview` |
| GET | `/v1/admin/recordings?roomId=` | `{recordings: RecordingRecord[]}` |
| DELETE | `/v1/admin/recordings/:id` | `{deleted:true}` |
| GET | `/v1/admin/ai-agent` | `AiAgentSettingsResponse` |
| PUT | `/v1/admin/ai-agent` | `{config: Partial<AiAgentConfig>}` → `AiAgentSettingsResponse` (merge в `session.aiAgent`; секрет — только имя env-переменной) |

Коды ошибок: `unauthorized, forbidden, not_found, password_required,
password_invalid, geo_blocked, room_locked, room_full, rate_limited,
file_too_large, unsupported_mime, stt_not_configured, validation_failed,
internal_error`.

Новые env: `AGIL_TRUST_PROXY`, `AGIL_GEO_PROVIDER` (`header|ipapi|none`),
`AGIL_IP_SALT`, `AGIL_FILE_TTL_SEC`, `AGIL_MAX_UPLOAD_MB` (25),
`AGIL_RECORDINGS_DIR`, `AGIL_STT_URL|AGIL_STT_KEY|AGIL_STT_MODEL`,
`AGIL_INTEGRITY_URL|AGIL_INTEGRITY_KEY`, `AGIL_DASHBOARD_DIR`,
`AGIL_ADMIN_RATE_LIMIT_PER_MIN`.

## 15. Панель разработчика (`agil/core/apps/dashboard`)

Vite-приложение, dev 5175, base `/dashboard/`, статика на сервере `/dashboard/`.
Без внешних UI-библиотек; тема light/dark на токенах `@agil/protocol`
(`themePresets`, `toCssVars`) — панель сама демонстрирует темизацию.

Экраны:
1. **Вход**: поле `AGIL_SERVER_URL` (default текущий origin) и API-ключа
   (хранится в `localStorage`), кнопка «Проверить» → `GET /v1/admin/overview`.
2. **Обзор**: KPI (активные комнаты, участники, записи, события безопасности
   за 24ч), карта стран (список), кнопка «Создать тестовую комнату».
3. **Комнаты**: таблица (id, имя, участники, пароль, создана, ссылки), быстрые
   действия: копировать invite/embed, открыть в demo, удалить, lock.
   Создание: имя, пароль (опционально), лимит участников, TTL, overrides.
4. **Комната**: live-детали (участники с страной/verified/integrity), вкладки
   Чат / Транскрипт / Заметки (выдержки, summary, action items) / Compliance
   (findings по severity) / Записи. Поллинг 3–5 с.
5. **Безопасность**: гео-политика, пароли/lockout, media integrity, AI-агент
   (mode/endpoint/apiKeyEnv/правила), аудит-лог с фильтрами.
6. **Настройки/Embed**: генератор сниппетов embed + ссылка на визуальный
   редактор (`/editor/`), список публичных endpoints.

Все запросы — `fetch` с `x-api-key`; при недоступном сервере — понятный
оффлайн-экран с подсказкой, без падений. Формат ошибок — `ApiErrorBody`.

## 16. Feature parity (все фичи конкурентов)

`features` дополнен флагами уровня «как у Jitsi/Telemost/Zoom/Daily»:
`breakoutRooms, polls, whiteboard, annotations, liveStreaming, sipDialIn,
calendarIntegration, translation, aiAssistant, aiCompliance, autoFraming,
lowLightEnhancement, speakerSpotlight, remoteControl, webinarMode, meetingNotes`.
Флаги — единый переключатель для редактора/дашборда/MCP. МVP реализует ядро
(чат, файлы, экран, запись, STT, блюр/фон, качество, безопасность, заметки,
AI-агент); остальные флаги включены в roadmap и описаны в `agil/core/docs/features.md`
(матрица «фича → конкурент → статус: MVP/roadmap»). Флаги, которые ещё не
реализованы, UI не показывает (или показывает бейдж «скоро»), а API возвращает
их как есть — интеграторы видят полный контракт заранее.

## 17. Граф зависимостей и порядок сборки

```
protocol ─┬─► security ─┐
          ├─► ai ───────┴─► server ◄─ admin API ◄─ dashboard
          ├─► widget ──► sdk
          │      └────► demo (embed.html)
          └─► editor (preview via iframe demo)
mcp ──► protocol + ai + security (оффлайн-инструменты) + HTTP server (онлайн)
```
Порядок `npm run build`: protocol → security → ai → server → widget → sdk → mcp →
demo → editor → dashboard. Пакеты `security`/`ai` импортируются в `server`
только как собранный `dist` (`@agil/security`, `@agil/ai`); их владельцы обязаны
первым делом сделать `npm run build -w <пакет>`.

---

# Доступы, корпоративные интеграции, OpenAPI

## 18. Права пользователей (наша сторона определяет правила)

Логика — `@agil/protocol` → `access.ts`:

```ts
resolveAccess({config, role, userId?, tokenPermissions?}): {allowed: FeatureKey[], denied, source, role}
isFeatureAllowed(context, feature): boolean
resolveKnowledgeAgentAccess(context): {allowed, reason?: 'disabled'|'role'|'permission'|'not_configured', denyMessage?}
describeAccess(resolution): string
```

Порядок: role defaults (`security.accessPolicy.roleDefaults`) → per-user override
(`userOverrides[userId]`) → `tokenPermissions` из токена (заменяет всё, решает
выпускающий токен) → вычитание `deniedFeatures` → пересечение с включёнными
`features.*`. `mode:'strict'` — только явные выдачи (токен/override), role
defaults игнорируются.

Публичные изменения API:
- `POST /v1/tokens` принимает `permissions?: FeatureKey[]` (x-api-key), ответ —
  `TokenResponse` {token, expiresAt, tenantId, roomId, permissions} (эффективные).
- `POST /v1/rooms/:roomId/join` возвращает `JoinRoomResponse.permissions`
  (эффективные для этого участника).
- `welcome.self.permissions` — тот же список; виджет обязан скрывать/дизейблить
  функции, которых нет в списке (единый источник правды на клиенте и сервере).
- WS `assistant-query` разрешён только если `resolveKnowledgeAgentAccess().allowed`;
  иначе `assistant-answer {error:'forbidden', answer: denyMessage}`; аудит
  `knowledge.query`/`knowledge.denied`; rate-limit 10/мин на участника.

Admin API (`x-api-key`, тенант из ключа):

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| GET | `/v1/admin/access-policy` | — | `AccessPolicyResponse` {policy, featureKeys, effective} |
| PUT | `/v1/admin/access-policy` | `{policy?: AccessPolicyPatch, clearUserOverrides?: string[], expectedPolicy?: AccessPolicyExpected}` | `AccessPolicyResponse` (merge в `security.accessPolicy`, аудит `access.updated`) или `409 access_policy_conflict`, если переданные предыдущие значения изменились |
| GET | `/v1/admin/knowledge-agent` | — | `KnowledgeAgentSettingsResponse` {config, endpointConfigured, apiKeyConfigured} |
| PUT | `/v1/admin/knowledge-agent` | `{config: Partial<KnowledgeAgentConfig>}` | `KnowledgeAgentSettingsResponse` (merge в `session.knowledgeAgent`; ключ — имя env-переменной) |
| POST | `/v1/admin/knowledge/ask` | `KnowledgeAskRequest` {question, userId?, role?, roomId?, locale?} | `KnowledgeAskResponse` {answer, citations[], confidence?, provider?, model?, refused?} |

Knowledge agent (вопросы по wiki/внутренним ресурсам компании) —
`session.knowledgeAgent`: `{enabled, endpoint, apiKeyEnv, timeoutMs,
allowedRoles, requirePermission, citations, maxAnswerChars, systemPrompt,
denyMessage}`. Запрос к компании подписывается HMAC (как AI-агент, §13),
`KnowledgeQueryRequest`/`KnowledgeQueryResponse` — в `compliance.ts`.
Мы **не храним** содержимое wiki: только проксируем вопрос и валидируем ответ
(zod), цитаты показываем как ссылки (untrusted URL — с `rel="noopener noreferrer"`).

## 19. Интеграционные границы и вебхуки

`TenantConfig.integrations` (`integrations.ts`): `webhooks[]` (url, events,
secretEnv, retries, timeoutMs), `identity` (`mode:'token'|'oidc'`, issuer,
audience, jwksUrl, claim-маппинг), `allowedOrigins`, `embedPostMessage`.

При загрузке `/embed.html` окно читает опубликованные `allowedOrigins` и
`embedPostMessage`. Если управление выключено, команды родительской
страницы получают `action-denied` с причиной `bridge-disabled`. Проверка
готовности через `agil:ping` работает для разрешённого origin. Предпросмотр
редактора с того же origin сохраняет управление оформлением и симуляцией.
Чтобы применить изменённую политику к открытому iframe, перезагрузите его.

**Разделение ответственности (кратко):**

| Слой | AgilFrame (наш продукт) | Компания (их приложение) | Стык |
|---|---|---|---|
| Звонок/медиа | комнаты, WebRTC, чат, файлы, запись, транскрипт | — | JS SDK / iframe / REST |
| Дизайн | токены, темы, пресеты, рендер | бренд-цвета, логотип, лого-ассеты | PATCH config / редактор / MCP |
| Пользователи и вход | проверка токена, пароли, лобби, kick | IdP/SSO, каталог сотрудников, выпуск токенов | `POST /v1/tokens` (permissions), OIDC (roadmap) |
| Права на функции | enforcement `resolveAccess`, скрытие UI | кто и что получает (политика) | `PUT /v1/admin/access-policy`, токен-права |
| Wiki/внутренние ресурсы | прокси запросов, цитаты, аудит | RAG/поиск, права на документы | knowledge-agent endpoint (`KnowledgeQueryRequest`) |
| AI-анализ диалогов | STT, транскрипт, локальные правила, выдержки (fallback) | корпоративная модель/политика | AI-agent endpoint + `analysis.ready` webhook |
| Аудит/безопасность | события, rate-limit, подписанные ссылки, IP-хэши | SIEM, DLP, retention-политика | `GET /v1/admin/audit`, webhooks `security.event` |
| Данные | хранение звонковых артефактов (после согласия) | решает, что и сколько хранить | retentionMin, DELETE recordings, webhooks |

Вехи соблюдения границы: наш сервер **не** содержит бизнес-логику компании
(нет каталога сотрудников, нет wiki-контента, нет корпоративных правил — только
исполнение переданной политики), а компания не реализует медиа-часть.

**Вебхуки (мы → компания).** Подписка в `integrations.webhooks[].events`:
`room.created, room.closed, participant.joined, participant.left, chat.message,
file.shared, recording.ready, transcript.ready, analysis.ready,
knowledge.answer, compliance.finding, security.event`.
Доставка: `POST` JSON `WebhookPayload`, заголовки `x-agil-signature` (hex
HMAC-SHA256 сырого тела, ключ из env по `secretEnv`), `x-agil-delivery`,
`x-agil-event`, `x-agil-timestamp`; таймаут, N ретраев с backoff, лог доставок
(200 последних, in-memory). `@agil/security` предоставляет helpers подписи
(`signWebhookPayload`/`verifyWebhookSignature` — добавить владельцу security).

Admin API:

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| GET | `/v1/admin/webhooks` | — | `WebhooksResponse` {webhooks, recentDeliveries} |
| PUT | `/v1/admin/webhooks` | `{webhooks: WebhookEndpointConfig[]}` | `WebhooksResponse` (полная замена списка в `integrations.webhooks`) |
| POST | `/v1/admin/webhooks/test` | `{endpointId}` | `WebhookTestResponse` (тестовая доставка `security.event`) |

`identity.mode:'oidc'` — конфиг принимается и валидируется, но проверка JWKS в
MVP не реализована (501 + подсказка); MVP-путь — `mode:'token'` (наш HS256 JWT).

## 20. OpenAPI / Swagger и документация API

Сервер обязан предоставлять:
- `GET /openapi.json` — **OpenAPI 3.1** спецификация всех публичных и admin
  эндпоинтов (схемы из zod-описаний, security schemes: `apiKey` (x-api-key),
  `bearer` (join-token), примеры запросов/ответов, коды ошибок `ApiErrorBody`).
- `GET /docs` — интерактивный API Explorer **без CDN** (self-contained HTML+JS,
  офлайн): список эндпоинтов по тегам, форма параметров/тела, кнопка «Send»
  (fetch), отображение ответа, ввод API-ключа/Bearer, кнопки «Скачать OpenAPI».
  Совместимо со Swagger UI/Redoc/Postman: спека открывается ими как есть.
- Скрипт `npm run openapi -w @agil/calls-server` — выгружает
  `agil/core/docs/openapi.json` (артефакт для клиентов и генерации SDK).
MCP: инструменты `agil_get_openapi` (полная спека или фильтр по тегу) и
`agil_get_api_endpoints` (краткий список) — нейросеть может сама разобраться в
API. В `agil/core/apps/dashboard` — ссылки на `/docs` и `/openapi.json`.

## 21. Definition of done (обновлено)

Дополнительно к §11: `resolveAccess` применяется на сервере при join и при
`assistant-query`; permissions отдаются клиенту; admin-эндпоинты §18/§19
работают с аудитом; `/openapi.json` + `/docs` открываются без интернета;
вебхуки подписаны и ретраятся; MCP-инструменты §18/§20 доступны; редактор и
дашборд умеют править access policy и knowledge agent.

## 22. Внешний чат и «свернуть звонок»

### 22.1 Чат может быть чужим

`session.chat = {ui:'builtin'|'external'|'hidden', externalProviderName,
allowHostInjection, allowSystemMessages}`. При `ui:'external'` виджет **не
рисует** свой чат: он отдаёт сообщения хосту через события
(`onEvent('chat')` / postMessage `agil:chat`) и принимает исходящие через
`instance.sendChat(text)` / postMessage `{type:'agil:chat-send', text}`.
При `ui:'hidden'` чат полностью выключен (компания использует свой мессенджер
рядом со звонком).

API для интеграции внешнего чата с бэкенда компании (без WebSocket):
- `POST /v1/rooms/:roomId/chat` — `authorization: Bearer <join token>`,
  тело `ChatPostRequest` {text, kind?:'text'|'system', from?, id?} →
  `ChatPostResponse`; проверяются фича `chat`, `session.chat.allowHostInjection`,
  права участника, `guestCanChat` для гостей и привязка токена к комнате.
  Сообщение получают участники с правом `chat`. Оно также попадает в
  историю и вебхук `chat.message`. Поле `id` обеспечивает идемпотентность.
- `POST /v1/admin/rooms/:roomId/chat` — `x-api-key`, тело `ChatPostRequest`
  (kind `'system'` разрешён при `allowSystemMessages`), от имени бота/CRM;
  используется для «чат компании → чат звонка».

### 22.2 Мини-режим и переходы по страницам

`layout = {chrome:'full'|'compact'|'none', minimized:{enabled, mode:'bar'|'bubble',
position, showSelfView, keepControls}, persistAcrossPages, inheritHostStyles}`.
- `chrome:'none'` — виджет рендерит только видео-сетку и управление, без
  собственных шапок/фонов: встраивается как часть страницы компании.
- `minimized` — «свернуть в маленькое окно»: плавающая панель/пузырь поверх
  приложения компании (позиция из конфига), аудио и звонок продолжаются;
  разворачивается обратно кликом. Дополнительно — Document Picture-in-Picture
  (Chromium) для окна поверх всех вкладок; в остальных браузерах — fallback на
  плавающую панель.
- В отдельном окне выберите «Ещё» → «Развернуть звонок» или закройте окно
  кнопкой браузера. В обоих случаях виджет возвращается в исходную вкладку.
  Встраивающее приложение может вызвать `restore()` или отправить разрешённое
  сообщение `agil:action` с `action: 'restore'`.
- `persistAcrossPages` — SPA/многостраничный сценарий: `sessionStorage`
  хранит `{room, token, tenant, name, theme}`, и на новой странице
  `AGILCalls.resume()` (или `mount` с `resume:true`) поднимает звонок заново
  (медиа-поток при полной навигации пересоздаётся; в SPA `mount` один раз —
  инстанс живёт, звонок не прерывается).

Дополнение к API виджета (§6):

```ts
minimize(): void;
restore(): void;
isMinimized(): boolean;
requestPictureInPicture(): Promise<boolean>;   // Document PiP, false если не поддержано
persistSession(enabled?: boolean): void;       // sessionStorage handoff
resume(): Promise<void>;                       // восстановить звонок из sessionStorage
setChatMode(mode: 'builtin' | 'external' | 'hidden'): void;
```

postMessage (iframe): в дополнение к §7 — вход `{type:'agil:chat-send', text}`,
`{type:'agil:action', action:'minimize'|'restore'|'pip'}`; выход
`{type:'agil:minimized', minimized:boolean}` и уже существующий `agil:chat`.
