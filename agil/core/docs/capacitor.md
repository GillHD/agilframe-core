# AgilFrame в Capacitor: плагин `@agil/calls-capacitor` (P1)

Документ описывает Capacitor-плагин `@agil/calls-capacitor`
(`agil/mobile/capacitor`). Это **WebView-оболочка** hosted-виджета `/embed.html`
для iOS, Android и Web: плагин открывает звонок во встроенном
WKWebView/Android WebView (или в системном браузере), проксирует события через
`AgilBridge` и управляет разрешениями камеры/микрофона. Медиа, чат, темы и
участники остаются в веб-виджете.

См. также: [README пакета](../../mobile/capacitor/README.md),
[agil/core/docs/mobile.md](mobile.md) (React Native), [agil/core/docs/flutter-sdk.md](flutter-sdk.md)
(Flutter), [agil/core/docs/sdk.md](sdk.md) (веб-SDK/iframe), [agil/core/docs/contract.md](contract.md) §7.

## 1. Что входит в P1

| Возможность | iOS | Android | Web |
|---|---|---|---|
| `openCall()` c `/embed.html?...` | ✅ WKWebView | ✅ Android WebView | ✅ iframe / new tab |
| `close()` / `isSupported()` / `setTheme()` | ✅ | ✅ | ✅ |
| `checkPermissions()` / `requestPermissions()` | ✅ AVFoundation | ✅ runtime permissions | ✅ Permissions API / getUserMedia |
| События `ready/joined/left/chat/error/state/...` | ✅ | ✅ | ✅ |
| Origin allowlist + navigation guard | ✅ | ✅ | ✅ (iframe origin check) |
| «Открыть в браузере» (`presentation: 'external'`) | ✅ | ✅ | ✅ |
| Проверки URL, событий и ограничения источника | — | — | 42 теста SDK |

Новых серверных endpoint'ов нет: join-token выдаётся существующим
`POST /v1/rooms/:roomId/join`.

## 2. Архитектура

```
┌──────────────────────── Capacitor app ────────────────────────┐
│  AgilCalls.openCall(options)                                  │
│    ├─ normalizeOpenCallOptions + buildWidgetUrl (JS)          │
│    └─ native.openCall({url, allowedOrigins, permissions})     │
│          ├─ iOS: AgilCallViewController (WKWebView)           │
│          │     ├─ WKUserScript at .atDocumentStart → шим      │
│          │     ├─ WKScriptMessageHandler "AgilBridge"         │
│          │     └─ navigationDelegate: origin guard            │
│          ├─ Android: AgilCallActivity (WebView)               │
│          │     ├─ addJavascriptInterface("AgilBridge")        │
│          │     ├─ onPageStarted/onPageFinished → шим          │
│          │     └─ WebViewClient: origin guard                 │
│          └─ Web: full-screen iframe + postMessage             │
│  AgilCalls.addListener('callEvent') ← parse/sanitize (JS)     │
└───────────────┬───────────────────────────────────────────────┘
                │ HTTPS/WSS + WebRTC (same-origin page)
┌───────────────▼───────────────────────────────────────────────┐
│ AgilFrame server: REST, WS-сигналинг, статика, TURN/SFU      │
└───────────────────────────────────────────────────────────────┘
```

Ключевые решения:

1. **URL собирается в JS** (`buildWidgetUrl`), а не в Swift/Kotlin. Одна
   реализация валидации для всех платформ, токен не попадает в нативные логи;
   нативный слой получает готовый `url` и `allowedOrigins`.
2. **Native → JS передаёт только сырой JSON** (`callMessage`), а парсинг и
   санитайзинг делает `src/bridge.ts` — одно место для всех платформ.
3. **`AgilBridge`** — единое имя канала: на iOS шим создаёт
   `window.AgilBridge` поверх `webkit.messageHandlers`, на Android — поверх
   `addJavascriptInterface`, на web мост идёт через `postMessage` с проверкой
   `event.origin`/`event.source`. Канал глобальный для WebView, поэтому
   входящие `agil:*` привязываются к origin виджета: iOS проверяет
   `WKFrameInfo.securityOrigin`, Android — одноразовый nonce, который шим
   получает только на странице origin'а виджета. Сообщения с разрешённых
   SSO-origin'ов отклоняются.
4. **`openCall` идемпотентен по сессии**: новый вызов закрывает предыдущий
   WebView/iframe.
5. **Входящий Android-конверт разворачивается нативно**: шим шлёт
   `{__agilBridgeNonce,message}`; после проверки nonce Activity передаёт в JS
   только `message`, иначе `parseWidgetMessage()` видел объект без `type` и
   отбрасывал все события. JS дополнительно вызывает `unwrapBridgeEnvelope()`
   как защиту для старых/иных оболочек.

## 3. Публичный API

```ts
import { AgilCalls } from '@agil/calls-capacitor';

const call = await AgilCalls.openCall({ serverUrl, roomId, joinToken });
const support = await AgilCalls.isSupported();
const perms = await AgilCalls.requestPermissions();
await AgilCalls.setTheme({ scheme: 'dark' });
const handle = await AgilCalls.addListener('callEvent', (event) => {});
await AgilCalls.close();
await handle.remove();
```

| Метод | Результат |
|---|---|
| `openCall(options)` | `Promise<{ callId, mode: 'in-app' \| 'external' }>` |
| `close()` | `Promise<void>` |
| `isSupported()` | `Promise<{ supported, inAppWebView, reason? }>` |
| `setTheme({ scheme?, theme? })` | `Promise<void>` (`agil:scheme`/`agil:theme`) |
| `sendAction(action)` | `Promise<void>` (`agil:action`; mic/camera/chat/leave/minimize/…); до готовности страницы — в очереди |
| `sendChat(text)` | `Promise<void>` (`agil:chat-send`, ≤4000 chars); до готовности страницы — в той же очереди |
| `checkPermissions()` | `Promise<{ camera, microphone, settingsRequired }>` |
| `requestPermissions()` | то же после системного prompt |
| `addListener('callEvent', cb)` | `Promise<PluginListenerHandle>` |
| `removeAllListeners()` | `Promise<void>` |

`AGIL_CALL_ACTIONS` and `version` are exported from the package entry point, so
hosts can validate actions before calling `sendAction()`.

`sendAction()`/`sendChat()`, вызванные сразу после `openCall()`, не теряются:
пока страница не прислала первое принятое сообщение (обычно `agil:ready`),
команды стоят в общей очереди (не больше 20, порядок сохраняется) и уходят в
WebView после готовности. При переполнении вызов отклоняется, а при закрытии
звонка недоставленная очередь отбрасывается.

Опции `openCall` — `serverUrl`, `roomId`, `tenantId`, `joinToken`,
`identityToken`, `participantName`, `role`, `theme`, `language`, `relayOnly`,
`widgetPath`, `allowedOrigins`, `allowInsecure`, `presentation`, `permissions`.
Все поля провалидированы в JS; ошибка имеет `code: 'invalid-config'` и не
содержит токен.

## 4. Контракт URL

```
https://<host>[/subpath]/embed.html?server=…&room=…[&token=…]&tenant=…[&lang=…]
  [&name=…][&role=…][&identity_token=…][&theme=…][&relay=1]
```

- `serverUrl` — только `http(s)`, без credentials/query/fragment; подпуть
  сохраняется;
- HTTP запрещён вне `localhost`/`127.0.0.1`/`::1`/`10.0.2.2` или без
  `allowInsecure: true` (dev);
- `widgetPath` — относительный, без `..`, `//`, query/fragment и абсолютных URL;
  `/embed.html` — корень домена;
- токены ≤ 8192, без пробелов/control-символов;
- `parseAgilCallLink` для http(s) сверяет `server` с origin/путём ссылки, для
  custom scheme требует `allowedOrigins`;
- `redactCallUrl`/`redactTokenText` маскируют токены и JWT.

## 5. События

| Событие | Payload |
|---|---|
| `ready` | `capabilities`, `room?`, `server?` |
| `joined` / `left` | `payload?` |
| `chat` | `message: AgilChatMessage` |
| `error` | `error: AgilCallError` (`widget-error`, `load-failed`, `navigation-blocked`, …; `timeout` — в web-режиме) |
| `state` | `state: AgilCallState` |
| `minimized` / `fullscreen` | `boolean` |
| `event` | `name`, `payload?` (остальные события виджета) |

Нативные ошибки (загрузка, битый мост) приходят как
`agil:event {event:'error'}` и маппятся в `AgilCallError`; в web-режиме туда же
добавляется `timeout` (iframe не прислал `agil:ready` за 20 с). На web iframe
события приходят из `postMessage` после проверки origin.

## 6. Безопасность

| Угроза | Мера |
|---|---|
| Кража join-token через подделку ссылки | `server` == origin ссылки; custom scheme — только с `allowedOrigins` |
| Утечка токена | URL не возвращается из `openCall`; ошибки/логи редактируются (JS и нативные `error.description`); нативные логи не содержат URL |
| Открытие чужих origin | `navigation guard` в WKWebView/WebView/iframe; внешние http(s) — в системный браузер, остальные блокируются |
| HTTP-перехват | HTTPS обязателен; cleartext только dev |
| Вредоносный payload | санитайзер `agil:*` (глубина/размер/`__proto__`), лимит 256 КиБ |
| Подмена iframe-сообщений | проверка `event.source` и `event.origin` |
| Подмена сообщений из SSO-origin | iOS: `WKFrameInfo.securityOrigin` (порт `0` → дефолт 443/80, иначе обычный HTTPS-widget не проходил); Android: per-load nonce + разворачивание конверта до JS |
| Утечка через WebView-данные | рекомендация: чистить `WKWebsiteDataStore`/`WebView` data при выходе из аккаунта |

Остаточные риски: токен в URL WebView, доверие к домену AgilFrame, сторонний JS
виджета выполняется в WebView.

## 7. Платформы и нативная конфигурация

### iOS

- deployment target **14.0**, `AgilCalls.podspec` зависит от `Capacitor`;
- `Info.plist`: `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`;
- шим — `WKUserScript` на `.atDocumentStart` (событие `agil:ready` не теряется);
- origin нормализуется чистым `AgilOriginNormalizer` (Foundation-only): порт `0`
  из `WKSecurityOrigin` — это дефолтный порт схемы, поэтому `https://host`,
  `https://host:443` и `securityOrigin.port == 0` сравниваются как один origin;
  нестандартный порт сохраняется, credentials/не-http(s) отклоняются;
  XCTest — `ios/Tests/AgilCallsPluginTests/AgilOriginNormalizerTests.swift`
  (готов для Xcode test target; .xcodeproj в репозитории нет);
- `WKUIDelegate.requestMediaCapturePermissionFor` (iOS 15+) разрешает захват,
  если запрошенный тип не отключён в `permissions.camera`/`microphone`.
  Для `.cameraAndMicrophone` решение одно на запрос: если хотя бы один тип
  отключён, запрос целиком отклоняется (ограничение WebKit — раздельно выдать
  камеру и микрофон в одном callback нельзя);
- экран — полноэкранный `AgilCallViewController`, свайп-назад отключён.

### Android

- `minSdk 22+`, `compileSdk 34`, Kotlin, зависимость от `capacitor-android`;
- разрешения объявлены в манифесте плагина (`CAMERA`, `RECORD_AUDIO`,
  `MODIFY_AUDIO_SETTINGS`, `INTERNET`) и смержатся в приложение;
- `AgilCallActivity` — полноэкранный WebView, `hardwareAccelerated`,
  `configChanges` для поворотов;
- `WebChromeClient.onPermissionRequest` выдаёт каждый тип capture независимо
  (`camera:false` отключает только видео, микрофон продолжает работать);
- `BridgeInterface` проверяет nonce и разворачивает конверт
  `{__agilBridgeNonce,message}` — в JS уходит только сообщение виджета
  (`ready/event/chat/state/minimized/fullscreen`);
- `sendAction`/`sendChat` до первого принятого сообщения виджета стоят в
  очереди (20, порядок сохраняется); на `onPageStarted` готовность сбрасывается,
  чтобы команды не улетели в перезагружаемую страницу;
- шим ставится в `onPageStarted` + `onPageFinished` (у Android нет
  document-start инжекта) — ранний `agil:ready` может быть потерян;
- cleartext HTTP — только dev (`usesCleartextTraffic`/network-security-config).

### Web

- `src/web.ts` монтирует full-screen iframe (`allow="camera; microphone;
  fullscreen; display-capture; autoplay; clipboard-write"`);
- родитель проверяет `event.source`/`event.origin`;
- без iframe или при `presentation: 'external'` — новая вкладка.

## 8. Сборка и проверка

```bash
cd agil/mobile/capacitor
npm run typecheck     # tsc --noEmit (src + test)
npm test              # 33 unit-теста
npm run build         # dist/ (ESM) + dist/cjs/ (CommonJS)
npm pack --dry-run
```

Нативные таргеты:

```bash
npx cap sync ios && npx cap open ios         # macOS/Xcode
npx cap sync android && npx cap open android # Android Studio
```

**Фактическая проверка в этом окружении** (macOS/Xcode и Android SDK
отсутствуют):

- `tsc --noEmit` в изолированном проекте с `@capacitor/core@6` — без ошибок;
- `tsc -p tsconfig.build.json` — `dist/` собран (ESM + d.ts);
- `tsx --test` — **33/33 passed** (`url.test.ts`, `bridge.test.ts`,
  `native-source.test.ts` — статические guard'ы Swift/Kotlin);
- `tsx --test` проверяет точный Android-конверт
  `{__agilBridgeNonce,message}` и парсинг `ready/chat/state` после
  `unwrapBridgeEnvelope()`;
- Swift/Kotlin/Gradle/podspec **не компилировались** и не запускались на
  устройствах — это ограничение окружения, а не API. Для iOS добавлен
  Foundation-only `AgilOriginNormalizer` с XCTest-файлом (запускается после
  добавления Xcode test target).

## 9. Ограничения и следующий этап

- **Не нативный WebRTC**: медиа/чат/темы в веб-виджете; ограничения autoplay,
  кодеков и фонового режима зависят от WebView.
- **Нет push/CallKit/ConnectionService**, входящих звонков и системного Call UI.
- **Нет screen share** в мобильных WebView.
- **Один звонок на экран.** `openCall` закрывает предыдущую сессию.
- **Android: поздний инжект шима** (см. §7); ранний `agil:ready` может быть
  потерян. Команды `sendAction`/`sendChat`, отправленные до готовности страницы,
  стоят в ограниченной очереди (20, порядок сохраняется) и доставляются после
  первого принятого сообщения виджета; если виджет не поднялся, очередь
  отбрасывается при закрытии звонка.
- **Web-режим** ограничен iframe-политикой браузера; для продакшена — нативные
  таргеты.
- **`presentation: 'external'`** не даёт событий `callEvent` (виджет вне
  приложения).
- Следующий этап: нативный LiveKit (iOS/Android), CallKit/ConnectionService,
  push, background audio.

## 10. Диагностика

| Симптом | Что проверить |
|---|---|
| `invalid-config` | `serverUrl` (`http` вне dev, credentials, query), `roomId`, `widgetPath` |
| Нет событий | `npx cap sync` выполнен? используется нативная сборка, а не web-заглушка? |
| `permission-denied` | `requestPermissions()`, затем настройки приложения; Info.plist на iOS |
| Падение iOS при входе | отсутствуют usage strings камеры/микрофона |
| Чёрный экран Android | cleartext HTTP заблокирован; в проде — HTTPS |
| `navigation-blocked` | origin не входит в `serverUrl`/`allowedOrigins` |
| iframe без камеры | ограничение браузера для cross-origin iframe |
