# AgilFrame во Flutter: SDK `agil_calls` (P1)

Документ описывает Flutter-обёртку `agil_calls` (`agil/mobile/flutter`). Это
**WebView-интеграция** hosted-виджета `/embed.html`, а не нативный WebRTC-клиент:
медиа, чат, темы и участники выполняются веб-виджетом, а Flutter-приложение
получает готовый экран звонка, события `ready/joined/left/chat/error/state`,
команды (mute/camera/chat/theme) и origin-guard.

См. также: [README пакета](../../mobile/flutter/README.md),
[agil/core/docs/sdk.md](sdk.md) (веб-SDK/iframe), [agil/core/docs/mobile.md](mobile.md) (React Native),
[agil/core/docs/capacitor.md](capacitor.md) (Capacitor), [agil/core/docs/contract.md](contract.md) §7.

Для подготовки Android установите Flutter версии 3.24 или новее, JDK 17, Android SDK Platform-Tools, Command-line Tools, платформу и Build-Tools под версию сборки. Android-модули этого репозитория используют `compileSdk = 35`. Проверьте раздел Android toolchain командой `flutter doctor -v` и наличие устройства командой `adb devices -l`. Запуск приложения и проверку звонка на устройстве выполняют отдельно. [Настройка Flutter для Android](https://docs.flutter.dev/platform-integration/android/setup).

## 1. Что входит в P1

| Возможность | Статус |
|---|---|
| `AgilCall` (StatefulWidget) на `webview_flutter` 4.x | ✅ |
| URL `/embed.html?...`: server/tenant/room/token/name/lang/theme/role/relay | ✅ |
| JS-мост `AgilBridge.postMessage` (шим `parent.postMessage` → канал) | ✅ |
| События `ready / joined / left / chat / error / state` + `minimized/fullscreen/event` | ✅ |
| Команды mute/camera/chat/theme + `applyConfig`/`ping`/`reload` | ✅ |
| `safeArea`, `allowedOrigins`, `readyTimeout`, буфер команд до `ready` | ✅ |
| Чистые Dart-тесты URL/парсера/моста (33 теста) | ✅ |
| `example/lib/main.dart` | ✅ |
| Нативный WebRTC, CallKit/ConnectionService, push, background, screen share | ❌ следующий этап |

Виджет и сервер **не меняются**. Новых endpoint'ов нет: используется
существующий `POST /v1/rooms/:roomId/join` и hosted-страница `/embed.html`.

## 2. Архитектура

```
┌──────────────────────── Flutter app ────────────────────────┐
│  AgilCall(serverUrl, roomId, joinToken, …)                 │
│    ├─ buildWidgetUrl() → https://calls.example.com/embed.html
│    ├─ WebViewController (webview_flutter)                   │
│    │    ├─ JS channel: AgilBridge                           │
│    │    ├─ injected shim: parent.postMessage → AgilBridge   │
│    │    ├─ embed.html + widget (WebRTC, chat, themes)       │
│    │    └─ onMessageReceived: agil:ready/event/chat/state   │
│    ├─ AgilCallController: mute/camera/chat/theme/config     │
│    └─ navigation guard: serverUrl + allowedOrigins          │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTPS/WSS + WebRTC (same-origin page)
┌───────────────▼─────────────────────────────────────────────┐
│ AgilFrame server: REST, WS-сигналинг, статика, TURN/SFU    │
└─────────────────────────────────────────────────────────────┘
```

`embed.html` отправляет события через `window.parent.postMessage(...)`. В
top-level WebView `window.parent === window`, поэтому сообщения уходили бы «в
себя». Инжектится шим, который:

1. перехватывает `window.parent.postMessage` и передаёт JSON в
   `window.AgilBridge.postMessage` (нативный JavaScript-канал);
2. вызывает исходный `postMessage`, чтобы собственный `message`-listener
   страницы продолжал работать;
3. идемпотентен, проверяет `location.origin` и молча выходит без канала (обычный
   браузер).

Обратные команды идут скриптом
`window.__agilFlutterPostToPage({type:'agil:action',action:'toggle-mic'}, origin)`.
Сообщения до `agil:ready` буферизуются (до 50) и отправляются после готовности.

## 3. Контракт URL

`buildWidgetUrl(AgilCallUrlOptions(...))` собирает:

```
https://<host>[/subpath]/embed.html?server=…&room=…[&token=…]&tenant=…[&lang=…]
  [&name=…][&role=…][&identity_token=…][&theme=…][&relay=1]
```

Правила валидации (одинаковые для Flutter и Capacitor):

- `serverUrl` — только `http(s)`, без credentials/query/fragment, без хвостового
  `/`; подпуть сохраняется;
- HTTP запрещён вне `localhost`, `127.0.0.1`, `::1`, `10.0.2.2`, если не задан
  `allowInsecure: true` (только разработка);
- `roomId` ≤ 200 символов, `tenantId` ≤ 64, `participantName` ≤ 120,
  `joinToken`/`identityToken` ≤ 8192 и без пробелов/control-символов;
- `widgetPath` — относительный путь, без `..`, `//`, query/fragment и без
  абсолютных URL; `/embed.html` адресует корень домена;
- ошибки никогда не содержат токен (`AgilConfigException.message`).

`parseAgilCallLink()` принимает `/embed.html?...` и `myapp://call?...`:

- для http(s) параметр `server` обязан совпадать с origin и путём ссылки — нельзя
  увести join-token на чужой хост;
- для custom scheme **обязателен** непустой `allowedOrigins`
  (иначе ссылка отклоняется);
- отклоняются `javascript:`, `file:`, неизвестные схемы, ссылки без `room`,
  слишком длинные значения и control-символы.

## 4. Мост и события

| Направление | Сообщение | Назначение |
|---|---|---|
| widget → host | `agil:ready` | capabilities, room, server |
| widget → host | `agil:event` | `joined`, `left`, `error`, `participant-joined`, `quality-changed`, `action-denied`, … |
| widget → host | `agil:chat` | сообщение чата |
| widget → host | `agil:state` | снимок состояния |
| widget → host | `agil:minimized` / `agil:fullscreen` | мини-режим/fullscreen |
| host → widget | `agil:action` | `toggle-mic`, `toggle-camera`, `toggle-chat`, `share-screen`, `blur-on/off`, `leave`, … |
| host → widget | `agil:chat-send` | текст сообщения (≤ 4000 символов) |
| host → widget | `agil:scheme` / `agil:theme` / `agil:config` | тема и конфиг |
| host → widget | `agil:ping` | ответ `agil:pong` (события не даёт) |

Парсер (`AgilBridge.parseWidgetMessage`) отклоняет не-`agil:*`, битый JSON и
сообщения больше 256 КиБ; payload санитайзится: глубина ≤ 8, ≤ 100 ключей/элементов,
≤ 32 КиБ на строку, вырезаются `__proto__`/`prototype`/`constructor`, циклы
заменяются на `null`. Это же поведение у React Native и Capacitor.

## 5. Безопасность

| Угроза | Мера |
|---|---|
| Кража join-token через поддельную ссылку | `parseAgilCallLink`: `server` == origin ссылки; custom scheme — только с `allowedOrigins` |
| Утечка токена в логи/ошибки | `redactCallUrl`/`redactTokenText`/`redactSecrets`; `widgetError` редактирует `token`/`identity_token`/`access_token`/JWT; сообщения конфигурации без токена |
| Навигация на чужой origin / `javascript:` / `file:` | navigation guard в WebView (`isAllowedNavigation`) |
| HTTP-перехват | HTTPS обязателен; HTTP только loopback/dev или явный `allowInsecure` |
| Вредоносный контент в WebView | парсер и санитайзер моста, лимиты размера/глубины |
| Подмена `postMessage` | шим проверяет `location.origin`; target origin — origin виджета; пересланные сообщения несут одноразовый nonce, поэтому прямой `AgilBridge.postMessage` с разрешённого SSO-origin’а отклоняется |

Остаточные риски: токен всё равно находится в URL WebView (история/кэш), а
WebView выполняет сторонний JS самого виджета — доверие к домену AgilFrame
обязательно.

## 6. Платформы

| Платформа | Минимум | Замечания |
|---|---|---|
| iOS | 14+ | WKWebView; `NSCameraUsageDescription`/`NSMicrophoneUsageDescription` обязательны; `getDisplayMedia` недоступен |
| Android | 8+ (API 26 рекомендуется) | AndroidX WebView 90+. Добавьте `CAMERA` и `RECORD_AUDIO` в манифест. SDK запрашивает их у ОС для origin виджета. HTTP предназначен для локальной разработки. |
| Web/desktop | — | `webview_flutter` не поддерживает web/desktop: используйте `@agil/calls-sdk` или Capacitor web |

## 7. Сборка и проверка

```bash
cd agil/mobile/flutter
flutter pub get
flutter analyze
flutter test
```

Пример приложения находится в `agil/mobile/flutter/example`. Сгенерируйте
Android-хост командой `flutter create --platforms=android --project-name agil_calls_example .`
из каталога примера, добавьте разрешения в манифест и выполните
`flutter build apk --debug`. Для звонков на устройстве укажите HTTPS-адрес Core
или настройте `adb reverse` для debug-сборки.
[Манифест и запуск примера](../../mobile/flutter/README.md#android-androidx-webview).

## 8. Ограничения и следующий этап

- **Не нативный WebRTC.** WebView-стек, ограничения autoplay/кодеков зависят от
  ОС и версии WebView.
- **Инжект шима.** У `webview_flutter` нет document-start инжекта: шим ставится
  в `onPageStarted`, повторяется в `onPageFinished` и через 250 мс. Ранний
  `agil:ready` может быть потерян; очередь команд разбудится первым
  `agil:state`/`agil:event` (сессия при этом работает).
- **Нет background/CallKit/push** и **screen share**.
- **Один звонок на экран.**
- **Deep links** регистрирует приложение; SDK даёт только безопасный разбор.
- Следующий этап: нативный LiveKit Flutter SDK, CallKit/ConnectionService,
  push-уведомления, background audio.

## 9. Диагностика

| Симптом | Что проверить |
|---|---|
| `timeout` | `/embed.html` не открылся: DNS/TLS, CSP, `serverUrl`, HTTP на iOS |
| Нет событий, видео идёт | Шим не установился до `agil:ready`; обновите `webview_flutter`, включён ли JavaScript |
| `permission-denied` | Android runtime-разрешения, `NSCameraUsageDescription` на iOS |
| `navigation-blocked` | Добавьте origin в `allowedOrigins`/обработайте `onExternalLink` |
| Чёрный экран | HTTP/mixed content, self-signed сертификат |
