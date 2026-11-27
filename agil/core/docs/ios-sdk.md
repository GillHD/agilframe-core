# AgilFrame iOS SDK `AgilCallsSDK` (P1)

Документ описывает нативный iOS-модуль `AgilCallsSDK` (`agil/mobile/ios`). Это
**tier-1 WebView-интеграция** hosted-виджета `/embed.html`: SDK открывает звонок
в `WKWebView`, проксирует события через `AgilBridge`, управляет навигацией,
разрешениями камеры/микрофона и умеет получить join-token через публичный
`POST /v1/rooms/:id/join`.

Медиа (WebRTC), чат, темы, участники, запись и SFU остаются в веб-виджете.
SDK **не** является нативным WebRTC-клиентом и не заменяет LiveKit/CallKit.

См. также: [README пакета](../../mobile/ios/README.md),
[example](../../mobile/ios/Example/README.md), [agil/core/docs/mobile.md](mobile.md)
(React Native), [agil/core/docs/capacitor.md](capacitor.md),
[agil/core/docs/flutter-sdk.md](flutter-sdk.md), [agil/core/docs/sdk.md](sdk.md) (web),
[agil/core/docs/contract.md](contract.md) §7.

## 1. Что входит в P1

| Возможность | Статус |
|---|---|
| `Package.swift`, iOS **14.3+**, модуль `AgilCallsSDK`, без сторонних зависимостей | ✅ |
| `AgilCallConfiguration` с валидацией (server/tenant/room/token/name/theme/lang/relay/origins/path/identity) | ✅ |
| `AgilClient` — async/await `POST /v1/rooms/:id/join` (`x-api-key`/`identityToken` опционально), typed errors | ✅ |
| `AgilCallView` (`UIView` + `WKWebView`): safe URL, inline media/autoplay, camera/mic policy, safe-area | ✅ |
| JS-мост `AgilBridge.postMessage`: `ready/joined/left/chat/error/state` + minimized/fullscreen/generic | ✅ |
| Команды mute/camera/chat/theme/leave, fullscreen/minimize/restore/blur/share-screen/pip/newtab, буфер до `agil:ready`, ping-watchdog | ✅ |
| SwiftUI `AgilCall`, `AgilCallViewController`, пример приложения | ✅ |
| Origin allowlist (HTTPS/loopback), navigation guard, `frameInfo.securityOrigin` + per-load nonce, token redaction, no `*` targetOrigin | ✅ |
| XCTest URL-билдера/валидации/моста/клиента/JSON | ✅ 63/63 на Linux (Foundation-only копия; без Xcode) |
| Нативный WebRTC, CallKit, push, background audio, screen share | ❌ следующий этап |

Сервер и виджет **не меняются**. Новых endpoint'ов нет: join-token выдаёт
существующий `POST /v1/rooms/:roomId/join` (`agil/core/docs/api.md` §4).

## 2. Архитектура

```
┌──────────────────────── iOS app ──────────────────────────────┐
│  AgilCallConfiguration (валидация + нормализация)              │
│    ├─ AgilClient.join() → POST /v1/rooms/:id/join → joinToken  │
│    └─ AgilCallView / AgilCall / AgilCallViewController         │
│          ├─ WKWebView + ephemeral data store                   │
│          ├─ WKUserScript at .atDocumentStart                   │
│          │    window.AgilBridge.postMessage → native channel   │
│          ├─ WKScriptMessageHandler "AgilBridge"                 │
│          ├─ navigationDelegate: exact-origin allowlist          │
│          ├─ uiDelegate: media capture policy                    │
│          └─ agil:* parser/sanitizer → AgilCallEvent             │
└───────────────┬────────────────────────────────────────────────┘
                │ HTTPS/WSS + WebRTC (страница на origin AgilFrame)
┌───────────────▼────────────────────────────────────────────────┐
│ AgilFrame server: REST, WS-сигналинг, статика, TURN/SFU       │
└────────────────────────────────────────────────────────────────┘
```

Ключевые решения:

1. **URL собирается в Swift** (`AgilWidgetURL.build`) и валидируется до загрузки.
   Пароль в URL не попадает. `token` (join-token) и `identity_token` передаются в
   query страницы, потому что это контракт embed (`agil/core/docs/contract.md` §7); оба
   токена — короткоживущие секреты, см. §8 и §9.
2. **Шим ставится на `.atDocumentStart`**, поэтому ранний `agil:ready` не
   теряется. Шим идемпотентен, проверяет `location.origin` и молча выходит в
   обычном браузере. Каждая загрузка, инициированная SDK, получает случайный
   nonce, который оборачивает исходящие сообщения.
3. **Команды host → page** идут через сохранённый оригинальный `postMessage` с
   `window.location.origin` — никогда с `"*"`.
4. **Входящие сообщения** принимаются только из main frame, только если
   `frameInfo.securityOrigin` равен origin виджета (а не любому
   `allowedOrigins`), только с текущим nonce и только для известных `agil:*`
   типов; payload санитайзится (глубина/размер/ключи).
5. **Никаких логов**: SDK не вызывает `print`/`NSLog`/`os_log`, а все ошибки и
   `description` редактируют токены.

## 3. Требования и установка

- iOS **14.3+** (первая версия iOS с `getUserMedia` в WKWebView);
- Xcode 15+, Swift 5.7+ (async/await), macOS для сборки;
- SwiftPM, без CocoaPods/Carthage и без сторонних зависимостей.

```swift
// Package.swift приложения
dependencies: [
    .package(path: "../VideoCalls/packages/ios")
    // или .package(url: "https://<repo>/packages/ios.git", from: "0.1.0")
],
targets: [
    .target(name: "App", dependencies: ["AgilCallsSDK"])
]
```

Xcode: File → Add Package Dependencies → Add Local… → `agil/mobile/ios` → продукт
`AgilCallsSDK`.

`Info.plist` приложения (обязательно, иначе iOS завершит приложение при
системном запросе камеры/микрофона):

```xml
<key>NSCameraUsageDescription</key>
<string>Камера нужна для видеозвонка.</string>
<key>NSMicrophoneUsageDescription</key>
<string>Микрофон нужен для голосового звонка.</string>
```

## 4. Быстрый старт

### SwiftUI

```swift
import AgilCallsSDK
import SwiftUI

struct CallScreen: View {
    let configuration: AgilCallConfiguration

    var body: some View {
        AgilCall(
            configuration: configuration,
            onViewReady: { callView in
                // callView.toggleMicrophone(), .leave(), .setTheme(.dark), ...
            },
            onFailure: { failure in
                print(failure.code.rawValue, failure.localizedDescription)
            },
            onEvent: { event in
                if case .joined = event { print("joined") }
            }
        )
        .ignoresSafeArea()
    }
}
```

### UIKit

```swift
import AgilCallsSDK
import UIKit

let controller = AgilCallViewController(configuration: configuration)
controller.dismissOnLeave = true
controller.onEvent = { event in /* ... */ }
controller.present(from: self)
```

### Полный join-flow с токеном

```swift
let client = try AgilClient(serverURL: URL(string: "https://calls.example.com")!)

do {
    switch try await client.join(roomId: "support-42", name: "Alice") {
    case .joined(let result):
        let configuration = try AgilCallConfiguration(
            serverURL: client.serverURL,
            tenantId: result.room.tenantId ?? "demo",
            roomId: result.room.id,
            joinToken: result.joinToken,
            participantName: result.participant.name ?? "Alice",
            theme: .dark,
            language: "ru"
        )
        let controller = AgilCallViewController(configuration: configuration)
        controller.present(from: self)
    case .waitingRoom(let ticket):
        // Включён waiting room: покажите ожидание и опрашивайте lobby на backend.
        print("lobby request", ticket.requestId, ticket.pollAfter ?? 2)
    }
} catch let error as AgilClientError {
    // Типизированные ошибки: .roomLocked, .roomFull, .passwordRequired, ...
} catch let error as AgilConfigurationError {
    // Ошибка конфигурации: field + reason, без значений и токенов.
}
```

`AgilClient` намеренно реализует только публичный join. Admin API и
`x-api-key` не должны попадать в бандл приложения; токен выпускает ваш backend.

### Ошибки клиента

| `AgilClientError` | Причина |
|---|---|
| `.notFound` | `404 not_found` |
| `.roomLocked` / `.roomFull` | `423` / `409` |
| `.passwordRequired` / `.passwordInvalid` | `400` / `401` |
| `.identityRequired` / `.identityInvalid` | OIDC SSO включён на тенанте (`identity_required` / `invalid_identity_token`) |
| `.identityNotVerified` / `.identityNotConfigured` | OIDC отклонил identity (`identity_not_verified`, 403) или тенант не настроен (`identity_not_configured`, 501) |
| `.geoBlocked` / `.forbidden` / `.unauthorized` | `403` / `401` |
| `.rateLimited(retryAfter:)` | `429 rate_limited` + `Retry-After` (секунды или HTTP-date) |
| `.quotaExceeded` | `429 quota_exceeded` (billing) |
| `.validationFailed(message:)` | `400`; сообщение отредактировано |
| `.serviceUnavailable` | `503` |
| `.server(status:code:)` | неизвестный код; текст сервера не пробрасывается |
| `.transport(.offline/.timedOut/...)` | сеть/DNS/TLS |
| `.cancelled`, `.invalidResponse`, `.invalidRequestBody` | локальные ошибки |

## 5. Конфигурация

`AgilCallConfiguration` бросает `AgilConfigurationError` (field + reason) до
любой загрузки; значения в ошибку не попадают.

| Поле | Тип / default | Правила |
|---|---|---|
| `serverURL` | `URL`/`String`, обязателен | `http(s)`, без credentials/query/fragment; подпуть сохраняется; host нормализуется в lowercase, `.`/`..` сегменты (включая `%2e%2e`) запрещены; HTTPS обязателен, HTTP — только `localhost`/`127.0.0.1`/`::1` или `allowsInsecureHTTP` |
| `tenantId` | `String`, `"demo"` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` |
| `roomId` | `String`, обязателен | тот же шаблон, ≤ 64 (серверный `ROOM_ID_RE`) |
| `joinToken` | `String?` | ≤ 8192, без пробелов/control-символов |
| `participantName` | `String?` | ≤ 120, обрезается |
| `theme` | `.light/.dark/.auto?` | `?theme=` |
| `language` | `String?` | принимает BCP-47, нормализует к `ru`/`en` (`en-US` → `en`); другие языки — `.invalidLanguageTag`, `?lang=` |
| `relayOnly` | `Bool`, `false` | `?relay=1` (TURN-only) |
| `allowedOrigins` | `[String]`, `[]` | точные origin, ≤ 32, без `*`/path/query/credentials; HTTPS, HTTP только loopback или при `allowsInsecureHTTP`; origin виджета доверен всегда. Расширяет **навигацию**, не native-сообщения |
| `widgetPath` | `String`, `"embed.html"` | относительный путь; `"/embed.html"` — корень origin, `"embed.html"` — относительно подпути `serverURL`; завершающий `/` запрещён |
| `identityToken` | `String?` | ≤ 16384; передаётся как `?identity_token=` (контракт embed) |
| `allowsInsecureHTTP` | `Bool`, `false` | только разработка; разрешает plain HTTP для `serverURL` и `allowedOrigins` |

`configuration.widgetOrigin` — канонический origin (`scheme://host[:port]`),
`configuration.description` не содержит токенов. `allowedOrigins` расширяет
только allowlist **навигации**; native-сообщения принимаются исключительно от
origin виджета (плюс main frame и per-load nonce). Захват камеры/микрофона
разрешается **только** основному origin виджета.

## 6. Контракт URL

```
https://<host>[/subpath]/embed.html?server=…&room=…[&token=…]&tenant=…
  [&lang=…][&name=…][&identity_token=…][&theme=…][&relay=1]
```

- все значения кодируются как UTF-8 query-компоненты; `+` → `%2B`
  (серверы, декодирующие `+` как пробел, не портят токен);
- `identity_token` **находится в URL страницы**: это часть контракта
  `/embed.html` (`agil/core/docs/contract.md` §7), которую используют мобильные SDK и
  `<agil-call>`. Считайте его короткоживущим секретом; не логируйте URL;
- `lang` после нормализации — только `ru` или `en`, даже если host передал
  `en-US`;
- `widgetPath` не может быть абсолютным URL, начинаться с `//`, содержать `\`,
  `?`, `#`, пробелы, `.`/`..` (включая `%2e%2e`), завершающий `/` или уходить с
  origin сервера;
- итоговый origin обязан совпадать с `serverURL`; иначе — ошибка
  `.escapeFromServerOrigin`;
- SDK никогда не добавляет `*` в targetOrigin.

## 7. События и команды

### События (`AgilCallEvent`)

| Событие | Payload |
|---|---|
| `.ready(AgilReadyInfo)` | `capabilities` (media/blur/screenShare/captions/recording), `room`, `server` |
| `.joined(AgilJSONValue?)` | payload виджета |
| `.left(AgilJSONValue?)` | payload виджета |
| `.chat(AgilChatMessage)` | `text`, `id`, `participantId`, `participantName`, `timestamp`, `raw` |
| `.error(AgilCallFailure)` | `code`, `message`, `widgetCode?`, `fatal`; сообщение отредактировано |
| `.state(AgilCallSnapshot)` | phase/participants/quality/connection/recording/settings/... |
| `.minimized(Bool)`, `.fullscreen(Bool)` | UI-режим |
| `.event(name:payload:)` | остальные (`participant-joined`, `quality-changed`, `action-denied`, …) |

Для `.chat` поля `participantId`/`participantName` берутся из плоских полей, а
если их нет — из `from.id`/`from.name` (формат `ChatMessage` из
`agil/core/packages/protocol/src/signaling.ts`); исходный объект доступен в `raw`.

Нативные ошибки: `load-failed`, `navigation-blocked`, `permission-denied`,
`bridge-timeout`, `bridge-error`, `render-process-gone`, `invalid-config`,
`widget-error`. `failure.fatal == true` переводит view в `.failed`.

События доставляются в `delegate`, `onEvent` и (для ошибок) `onFailure`.
`AgilCallView.State`: `idle → loading → ready → joined/left`, либо `failed`.

### Команды

| Метод | `agil:*` сообщение |
|---|---|
| `toggleMicrophone()` | `agil:action toggle-mic` |
| `toggleCamera()` | `agil:action toggle-camera` |
| `toggleChat()` | `agil:action toggle-chat` |
| `leave()` | `agil:action leave` |
| `requestPictureInPicture()` | `agil:action pip` (виджет может ответить `action-denied`, если WKWebView не поддерживает Document PiP) |
| `openInNewTab()` | `agil:action newtab` (popup проходит через `WKUIDelegate` и может быть заблокирован) |
| `setTheme(_:)` | `agil:scheme` |
| `setThemePatch(_:)` | `agil:theme` (санитайзинг, ≤ 500 ключей/8192 символов) |
| `sendChatMessage(_:)` | `agil:chat-send` (1…4000 символов) |
| `send(.action(...))` | остальные действия: `share-screen`, `blur-on`, `blur-off`, `minimize`, `restore`, `fullscreen` (и forward-compatible `join`) |
| `send(.action/.theme/.themePatch/.sendChat/.ping)` | типизированный API |

`join` оставлен для совместимости со списком действий `agil/websdk/embed`, но
hosted `/embed.html` отвечает на него `action-denied`: host «входит» в комнату,
загружая страницу с `room`/`token`, а виджет показывает собственный join-screen.

Виджет также присылает generic `agil:event` для каждого события; из-за этого
`.event(name:)` может дублировать имя, для которого SDK уже отдал типизированное
`.joined`/`.left`/`.chat`/`.state`. Это документированное поведение, а не
потеря события.

До `agil:ready` команды буферизуются (до 50) и отправляются после handshake;
`ping` каждую секунду и watchdog `readyTimeout` (20 с) дают `.bridge-timeout`,
если виджет не поднялся.

## 8. `Info.plist`, приватность и App Store

Обязательные ключи:

```xml
<key>NSCameraUsageDescription</key>
<string>…</string>
<key>NSMicrophoneUsageDescription</key>
<string>…</string>
```

- **Не нужны** `UIBackgroundModes` (audio/VoIP), PushKit, CallKit, entitlements:
  SDK не поддерживает фоновые звонки и входящие вызовы.
- В продакшене — только HTTPS. Для локального `http://localhost:8787` в
  примере добавлено исключение ATS (`NSExceptionDomains → localhost`); в
  приложении его нужно удалить.
- SDK не запрашивает доступ к контактам, микрофону в фоне, геолокации,
  галерее; `AgilCallPermissions.request()` дергает только AVFoundation
  camera/microphone.
- `PrivacyInfo.xcprivacy` пакета: `NSPrivacyTracking=false`, пустые
  `NSPrivacyCollectedDataTypes` и `NSPrivacyAccessedAPITypes`.
  SDK сам не собирает данные и не использует required-reason API.
- Виджет выполняет сетевые запросы на домен AgilFrame (REST/WS/WebRTC,
  TURN/SFU). Для App Store это трафик приложения; политику приватности и
  cookies/LocalStorage сайта определяет hosted-страница и ваш тенант.
- WebView по умолчанию использует `WKWebsiteDataStore.nonPersistent()`, поэтому
  URL с токеном не оседает в дисковом кэше. Если вы передаёте собственный
  `WKWebViewConfiguration` с persistent store, вызывайте
  `AgilCallView.clearWebsiteData()` при logout.
- Переданные токены (`token`, `identity_token`) неизбежно находятся в URL
  страницы внутри WKWebView (история/память процесса, query-логи
  сервера/прокси): это контракт `/embed.html`, а не выбор SDK. SDK не пишет их в
  DOM-текст, JS-исходники, ошибки и логи; используйте короткоживущие join/OIDC
  токены и ephemeral data store (см. выше).

## 9. Безопасность

| Угроза | Мера |
|---|---|
| Кража join-token через поддельный URL | `serverURL` валидируется; итоговый origin обязан совпасть; `widgetPath` не уходит с origin |
| Утечка токена в логи/ошибки | `AgilRedaction`, token-free `AgilConfigurationError`/`AgilClientError`, кастомные `description`; SDK не логирует |
| Токен в JS/DOM | токены только в URL страницы; команды и шим не содержат токенов; identity token — тоже часть URL-контракта embed |
| Wildcard `targetOrigin` | host → page всегда `window.location.origin`; `*` в коде SDK отсутствует |
| Навигация на чужой origin / `javascript:` / `file:` | navigation guard: только `about:blank`, `about:srcdoc` и точные origin из allowlist; plain HTTP — только loopback/dev; popups блокируются |
| Подмена postMessage | шим только на main frame + `location.origin` guard; нативная проверка `frameInfo.securityOrigin == widgetOrigin`, `isMainFrame` и per-load nonce-envelope; `allowedOrigins` не даёт права слать native-сообщения |
| Вредоносный payload | санитайзер: глубина 8, 100 ключей/элементов, 32 КиБ на строку, вырезаются `__proto__`/`prototype`/`constructor`, лимит сообщения 256 КиБ |
| HTTP-перехват | HTTPS обязателен для `serverURL` и `allowedOrigins`; HTTP — только loopback/явный dev-флаг |
| Несанкционированный захват камеры | `WKUIDelegate.requestMediaCapturePermissionFor` (iOS 15+): только доверенный origin и только разрешённые `AgilMediaCapture`; на iOS 14.x delegate-хука нет — `allowedMediaCapture` не отменяет системный prompt, нужны usage strings и проверка разрешений в приложении |
| Утечка через persistent cookies | ephemeral data store по умолчанию + `clearWebsiteData()` |
| Секреты в `description` | `AgilCallConfiguration`, `AgilJoinResult`, `AgilMediaGrant`, `AgilClient` печатают `redacted` |

Остаточные риски: доверие к домену AgilFrame и JS виджета; `token` и
`identity_token` в URL WebView (контракт embed — история/память процесса, а
также query-логи сервера/прокси, если они включены); на iOS 14.3–14.x нет
delegate-хука media capture; встроенный WebView не даёт screen share.

## 10. Сборка и тесты

```bash
cd agil/mobile/ios

# Манифест и зависимости (macOS, Swift 5.7+)
swift package describe
swift package dump-package
swift package resolve

# Список scheme (Xcode генерирует имя пакета; иногда с суффиксом -Package)
xcodebuild -list -json

# Сборка под устройство (без подписи)
xcodebuild -scheme AgilCallsSDK \
  -destination 'generic/platform=iOS' \
  -configuration Debug \
  -derivedDataPath .build/DerivedData \
  CODE_SIGNING_ALLOWED=NO build

# Unit-тесты на симуляторе
xcodebuild -scheme AgilCallsSDK \
  -destination 'platform=iOS Simulator,name=iPhone 15' \
  -configuration Debug \
  -derivedDataPath .build/DerivedData \
  CODE_SIGNING_ALLOWED=NO test
```

Если scheme называется иначе:

```bash
xcodebuild -scheme AgilCallsSDK-Package \
  -destination 'platform=iOS Simulator,name=iPhone 15' test
```

CI/локально одной командой:

```bash
cd agil/mobile/ios && bash agil/core/scripts/ci.sh
# переопределения:
SCHEME=AgilCallsSDK-Package SIMULATOR="iPhone 16" bash agil/core/scripts/ci.sh
```

`swift test` на macOS не подходит: пакет объявляет только `.iOS("14.3")`, а
`UIKit`/`WebKit` на macOS отсутствуют. XCTest запускается через
`xcodebuild test` на iOS Simulator.

**Фактическая проверка в этом окружении.** Хост — Windows, без Xcode и Apple
SDK, поэтому iOS-сборка `xcodebuild` и компиляция UIKit/WebKit/SwiftUI слоёв
**не выполнялись**. Что проверено:

- Foundation-only ядро (`AgilJSONValue`, `AgilValidation`, `AgilRedaction`,
  `AgilWidgetURL`, `AgilCallConfiguration`, `AgilBridge`, `AgilClient`)
  собрано компилятором **Swift 5.10.1** (Linux/WSL) во временном SwiftPM-пакете
  без изменения исходников для iOS (на Linux добавлен только
  `import FoundationNetworking` в копии трёх файлов: `AgilClient.swift`,
  `TestSupport.swift`, `AgilClientTests.swift`);
- **63/63 XCTest прошли** на Linux: 14 конфигурация, 13 URL/redaction,
  21 мост, 14 REST-клиент, 1 JSON (`swift test`);
- UI-файлы (`AgilCallView`, `AgilCallViewController`, `AgilCall`,
  `AgilPermissions`, пример) прошли официальный `swiftc -parse` (Swift 5.10.1);
  типы UIKit/WebKit/SwiftUI не проверялись компилятором, потому что Apple SDK на
  этом хосте нет;
- сгенерированный JS-шим и host→page скрипт выполнены в Node.js-харнессе
  (VM с фейковым `window`/`webkit.messageHandlers`): nonce-envelope,
  отклонение прямого вызова handler, origin-guard на SSO-странице,
  идемпотентность, `Object.defineProperty` fallback и точный `targetOrigin`;
- `Info.plist`, `PrivacyInfo.xcprivacy` — валидный XML/plist;
  `Example/project.yml` — валидный YAML, local package path `..`;
  `agil/core/scripts/ci.sh` — `bash -n`.

Это ограничение окружения, а не API. Команды выше — для macOS/CI; первый
`xcodebuild test` на macOS остаётся обязательным перед публикацией.

## 11. Ограничения и следующий этап

- **Не нативный WebRTC**: медиа/чат/темы — hosted-виджет; ограничения autoplay,
  кодеков, аудио-маршрутизации и качества зависят от WKWebView.
- **iOS 14.3+**: на 14.x нет `requestMediaCapturePermissionFor`; permission
  flow опирается на системный prompt WKWebView и AVFoundation preflight.
- **Нет CallKit/ConnectionService, push, background audio, входящих звонков**
  и системного Call UI.
- **Нет screen share** в iOS WKWebView (`getDisplayMedia` недоступен); кнопка
  виджета может быть скрыта или вернуть `action-denied`.
- **Один звонок на view**: для нового звонка создавайте новый `AgilCallView`.
  Не переиспользуйте один `WKWebViewConfiguration` между view: обработчик
  `AgilBridge`, шим и nonce принадлежат конкретному `AgilCallView`.
  `reload()` очищает очередь команд, отправленных до `agil:ready`.
- **PiP без гарантий**: `requestPictureInPicture()` / `agil:action pip` зависит
  от WKWebView (Document PiP) и может вернуть `action-denied`.
- **`join` не управляет входом**: текущий hosted `/embed.html` отвечает на
  `agil:action join` как на неизвестное действие; вход выполняет host через
  конфигурацию (`room`/`token`) и join-screen виджета.
- **Токены `token`/`identity_token` в URL WebView** — остаточный риск
  (история/память процесса), см. §8.
- **Deep links/custom scheme** разбирает приложение; SDK даёт только безопасный
  builder.
- **Android**: в этом пакете только iOS; отдельный нативный Android SDK —
  [agil/core/docs/android-sdk.md](android-sdk.md) (см. также [agil/core/docs/capacitor.md](capacitor.md),
  [agil/core/docs/flutter-sdk.md](flutter-sdk.md)).
- Следующий этап: нативный LiveKit iOS SDK, CallKit, PushKit, background audio,
  screen share через Broadcast Upload Extension.

## 12. Диагностика

| Симптом | Что проверить |
|---|---|
| `.invalid-config` / `AgilConfigurationError` | `serverURL` (HTTPS, credentials/query), `roomId`, `widgetPath`, `allowedOrigins` |
| `load-failed` | DNS/TLS, CSP `script-src`/`connect-src`/mixed content, сервер отдаёт `/embed.html` (`frame-ancestors` не мешает top-level WebView) |
| `bridge-timeout` | Виджет не загрузился/не выполнил `agil:ready`; проверьте консоль WebView (Safari → Develop) и CSP |
| Нет событий, видео идёт | Шим не установился или nonce не совпал? Проверьте `window.AgilBridge`, что страница на origin виджета и не шлёт в handler напрямую |
| `navigation-blocked` | Добавьте HTTPS-origin в `allowedOrigins` (или loopback/dev-флаг для HTTP) либо используйте виджет на `serverURL` |
| `permission-denied` | `NSCameraUsageDescription`/`NSMicrophoneUsageDescription`, настройки приложения, `allowedMediaCapture` |
| Чёрный экран | HTTP/mixed content, self-signed сертификат, ATS |
| Токен не принимается | Токен истёк/другой tenant; join-token выпускается на backend, не admin-ключом |
| Events после смены комнаты не приходят | Не переиспользуйте `AgilCallView` после `destroy()`; создайте новый |

## 13. Публикация

1. Semver-тег (`0.1.0`) и `CHANGELOG` (`agil/mobile/ios/CHANGELOG.md`; в этом
   репозитории пакет версионируется вместе с монорепо; для отдельного
   репозитория добавьте тег).
2. `swift package describe` и `xcodebuild test` зелёные на macOS/CI.
3. Проверьте, что `PrivacyInfo.xcprivacy` попал в бандл
   (`Bundle.module`/Build Phases) и приложение содержит usage strings.
4. Убедитесь, что в приложении нет admin API key и логов токенов.
5. Для распространения как отдельного репозитория: добавьте `LICENSE`
   (в монорепо лицензия не задана; в `agil/mobile/ios` пока нет файла лицензии) и
   укажите git URL в README.
