# AgilFrame на мобильных: React Native (P1)

Документ описывает первый мобильный SDK — `@agil/calls-react-native`
(`agil/mobile/react-native`). Это **WebView-обёртка** hosted-виджета
`/embed.html`, а не нативный WebRTC-клиент. Она даёт React Native-приложению
готовый экран звонка, двусторонний `postMessage`-мост, deep links и управление
нативными разрешениями без изменения виджета и сервера.

См. также: [README пакета](../../mobile/react-native/README.md),
[agil/core/docs/sdk.md](sdk.md) (веб-SDK/iframe), [agil/core/docs/contract.md](contract.md) §6–§7,
[agil/core/docs/electron.md](electron.md) (другие браузерные обёртки).

## 1. Что входит в P1

| Возможность | Статус |
|---|---|
| `<AgilCall />` на `react-native-webview` (iOS/Android) | ✅ |
| URL `/embed.html?...`: server/tenant/room/token/name/lang/theme/role | ✅ |
| Мост `ready / joined / left / chat / error / state / minimized / fullscreen` | ✅ |
| Императивные действия (mic/camera/chat/leave/theme/config) | ✅ |
| Deep link `myapp://call?...` + безопасный разбор `/embed.html?...` | ✅ |
| Navigation guard (запрет `javascript:`/`file:`/чужих origin) | ✅ |
| Android runtime-разрешения, iOS system prompt, open Settings | ✅ |
| Expo config plugin (Info.plist + AndroidManifest) | ✅ |
| Unit-тесты URL/моста/рендер-хелпера, typecheck, ESM+CJS build | ✅ (52 теста) |
| Нативный WebRTC, CallKit/ConnectionService, push, background, screen share | ❌ следующий этап |

Виджет и сервер **не меняются**. Новых endpoint’ов для P1 нет: используется
существующий `POST /v1/rooms/:roomId/join` и hosted-страница `/embed.html`.

## 2. Архитектура

```
┌─────────────────────── React Native app ───────────────────────┐
│  <AgilCall serverUrl roomId joinToken … />                    │
│    ├─ buildWidgetUrl()  → https://calls.example.com/embed.html │
│    ├─ WebView (react-native-webview)                           │
│    │    ├─ injected shim: parent.postMessage → RN bridge       │
│    │    ├─ embed.html + widget (WebRTC, chat, themes)          │
│    │    └─ onMessage: agil:ready/event/chat/state/…            │
│    ├─ permissions: Android runtime / iOS WKWebView prompt      │
│    └─ navigation guard: только serverUrl + allowedOrigins      │
└───────────────┬────────────────────────────────────────────────┘
                │ HTTPS/WSS + WebRTC (same-origin page)
┌───────────────▼────────────────────────────────────────────────┐
│ AgilFrame server: REST, WS-сигналинг, статика, TURN/SFU       │
└────────────────────────────────────────────────────────────────┘
```

Ключевая деталь: `embed.html` отправляет события через
`window.parent.postMessage(...)`. В обычном iframe `window.parent` — это
родительская страница, а в top-level WebView `window.parent === window`, и
сообщения уходят «в себя». Пакет инжектит шим, который:

1. перехватывает `window.parent.postMessage` и передаёт JSON в
   `window.ReactNativeWebView.postMessage`;
2. вызывает исходный `postMessage`, чтобы собственный `message`-listener
   страницы продолжал работать;
3. идемпотентен и не ломает страницу без `ReactNativeWebView` (web).

Обратные сообщения (`agil:action`, `agil:chat-send`, `agil:scheme`, …)
инжектятся в страницу через `injectJavaScript` и отправляются в
`window.postMessage(..., window.location.origin)`; сохранённый оригинальный
`postMessage` не даёт эху уходить обратно в native.

## 3. Совместимость

| Платформа | Требование |
|---|---|
| React Native | 0.71+ (проверялось на современном Hermes/Metro; CJS+ESM exports) |
| React | 18+ |
| `react-native-webview` | 13+ |
| iOS | 14.3+ (WebRTC в WKWebView), Xcode с поддержкой WKWebView |
| Android | 8.0+ (API 26), AndroidX WebView, рекомендуется WebView 90+ |
| Сервер | `/embed.html` и статика виджета; HTTPS; существующий API комнат |
| URL-полифилл | не нужен: `url.ts` не использует глобальные `URL`/`URLSearchParams` (Hermes-safe) |
| Expo | SDK с `react-native-webview` 13+; config plugin для usage strings; dev/prod build (не Expo Go) |

## 4. Установка и запуск

```bash
npm install @agil/calls-react-native react-native-webview
# Expo
npx expo install react-native-webview
```

`react`, `react-native`, `react-native-webview` — peer dependencies. В
`peerDependenciesMeta` они помечены `optional`, чтобы монорепо/CI не тянул React
Native; приложение устанавливает их явно.

```tsx
import { AgilCall } from '@agil/calls-react-native';

<AgilCall
  serverUrl="https://calls.example.com"
  tenantId="acme"
  roomId="daily-sync"
  joinToken={joinToken}
  participantName="Анна"
  theme="auto"
  language="ru"
  permissions={{ camera: true, microphone: true }}
  onEvent={(event) => console.log(event.type)}
  onError={(error) => console.warn(error.code, error.message)}
  style={{ flex: 1 }}
/>
```

Полная таблица props/events/handle — в
[README пакета](../../mobile/react-native/README.md). Кратко:

- **Props:** `serverUrl`, `roomId`, `joinToken`, `tenantId`,
  `participantName`, `role`, `theme`, `language`, `identityToken`,
  `relayOnly`, `widgetPath`, `permissions`, `requestPermissionsOnMount`,
  `readyTimeoutMs`, `allowedOrigins`, `onEvent`, `onError`, `onExternalLink`,
  `safeAreaInsets`, `style`, `testID`.
- **События:** `ready`, `joined`, `left`, `chat`, `error`, `state`,
  `minimized`, `fullscreen`, `event` (остальные).
- **Ref:** `reload`, `sendAction`, `sendChat`, `setThemeScheme`,
  `applyTheme`, `applyConfig`, `ping`.

### 4.1. Токен

`POST /v1/rooms/:roomId/join` (документирован в [agil/core/docs/api.md](api.md) §4)
возвращает `token`, `expiresAt`, `participant`, `permissions`. Выпускайте токен
на своём backend; **не** храните admin API key (`x-api-key`) в мобильном
приложении. Ошибки `400 password_required`, `401 password_invalid`,
`403 geo_blocked`, `202` waiting room, `409 room_full` обрабатываются до
монтирования `<AgilCall />`; после успешного join передайте `token` в
`joinToken`.

Без `joinToken` виджет показывает свой экран входа: пользователь вводит имя и
нажимает «Войти» (камера запрашивается по этому действию). Это удобно для
гостевых сценариев, но не для корпоративного SSO.

### 4.2. Какие серверные endpoint’ы нужны

| Endpoint | Нужен в P1 | Назначение |
|---|---|---|
| `GET /embed.html` + статика виджета | да, уже есть | hosted-виджет в WebView |
| `POST /v1/rooms/:roomId/join` | да, уже есть | выпуск join-token (вызывает backend приложения) |
| `GET /v1/tenants/:tenantId/config` | да, уже есть | тема/фичи/локаль (виджет запрашивает сам) |
| Новые мобильные endpoint’ы | **нет** | P1 не добавляет серверных изменений |

Если для нативного этапа (P2) понадобятся регистрация push-устройств или
выдача LiveKit-токена, их нужно добавить в `agil/core/docs/api.md`/OpenAPI отдельным
этапом; в P1 таких вызовов нет.

## 5. Deep links и iframe-безопасность

### 5.1. Deep link

```ts
import { Linking } from 'react-native';
import { buildCallDeepLink, parseAgilCallLink } from '@agil/calls-react-native';

const link = buildCallDeepLink(
  { serverUrl: 'https://calls.example.com', tenantId: 'acme', roomId: 'daily-sync', joinToken },
  'myapp',
); // myapp://call?server=…&room=daily-sync&tenant=acme&token=…

const initial = await Linking.getInitialURL();
const call = initial
  ? parseAgilCallLink(initial, {
      allowedOrigins: ['https://calls.example.com'],
      allowedSchemes: ['myapp'],
    })
  : null;
```

Для backend/скриптов (push, письма, QR) доступен subpath без React Native:
`import { buildCallDeepLink } from '@agil/calls-react-native/url'`.

`parseAgilCallLink` возвращает `null` для:

- `javascript:`, `file:`, `data:`, HTTP-ссылок без `/embed.html`;
- ссылок без `room`;
- `server`-параметра с чужим origin/путём (защита join-token от exfiltration);
- слишком длинных значений и control-символов;
- неизвестных схем, если они не перечислены в `allowedSchemes`.

Для custom scheme **обязательно** передавайте `allowedOrigins`: ОС может
передать ссылку любому приложению, зарегистрировавшему схему. Для продакшена
предпочтительны Universal Links / App Links (https-ссылка на
`/embed.html?...`); `parseAgilCallLink` поддерживает и их.

### 5.2. iframe-режим

Тот же `embed.html` можно встроить в web-приложение через iframe. Тогда
родительский origin должен быть в `integrations.allowedOrigins` тенанта
([agil/core/docs/sdk.md](sdk.md) §5); пустой список = только same-origin. В React Native
WebView страница открывается top-level, поэтому её собственный origin совпадает
с `window.location.origin` и дополнительный allowlist не нужен. Если внутри
WebView открывается HTML-обёртка с iframe, добавьте origin обёртки в
`allowedOrigins`.

### 5.3. Navigation guard

`<AgilCall />` блокирует навигацию за пределы `serverUrl` и
`allowedOrigins`:

```ts
isAllowedNavigation('https://calls.example.com/embed.html?room=r', {
  serverUrl: 'https://calls.example.com',
  allowedOrigins: ['https://idp.example.com'],
}); // true
isAllowedNavigation('javascript:alert(1)', policy); // false
```

Заблокированный `http(s)`-адрес передаётся в `onExternalLink` — приложение
само решает, открыть его в системном браузере (`Linking.openURL`) или
проигнорировать. `javascript:`, `file:`, `intent:`, `data:` не открываются
никогда.

## 6. Нативная конфигурация

### 6.1. iOS (WKWebView)

`Info.plist`:

```xml
<key>NSCameraUsageDescription</key>
<string>Разрешите доступ к камере для видеозвонков</string>
<key>NSMicrophoneUsageDescription</key>
<string>Разрешите доступ к микрофону для звонков</string>
```

- Без usage strings приложение завершается при первом `getUserMedia()`.
- WKWebView сам показывает системный prompt; `permissions` на iOS — это
  декларация намерения, а не pre-grant.
- Компонент включает `allowsInlineMediaPlayback`,
  `mediaPlaybackRequiresUserAction={false}`,
  `mediaCapturePermissionGrantType="grant"`.
- iOS 14.3+ обязателен: более ранние версии не поддерживают WebRTC в WKWebView.
- `permissions` — декларация намерения, не ACL: на iOS WKWebView сам показывает
  системный prompt, на Android prop запускает runtime-запрос.
- **Ограничение RN:** `react-native-webview` предоставляет только общий
  `mediaCapturePermissionGrantType` на запрос. Компонент выставляет `deny`
  только при полном запрете обоих медиа (`{camera:false,microphone:false}`);
  частичный запрет нужно дополнительно проверять в приложении/виджете.
  Capacitor-плагин на Android выдаёт каждый тип независимо, а на iOS
  отклоняет комбинированный `.cameraAndMicrophone` запрос, если хотя бы один
  тип отключён (ограничение WebKit).
- `getDisplayMedia`/screen share в WKWebView недоступны.
- Для фонового аудио/видео нужны нативные Background Modes + CallKit; в P1 их
  нет.

### 6.2. Android (AndroidX WebView)

`AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
```

- `requestPermissionsOnMount` (по умолчанию `true`) вызывает
  `PermissionsAndroid.requestMultiple([CAMERA, RECORD_AUDIO])` при монтировании.
  Если пользователь отказал навсегда — `onError` с
  `{ code:'permission-denied', fatal:false }`; `openAppSettings()` открывает
  настройки приложения.
- `react-native-webview` 13+ реализует `WebChromeClient.onPermissionRequest` для
  приложения, уже получившего runtime-разрешения. При кастомном WebView нужно
  явно разрешить `RESOURCE_VIDEO_CAPTURE`/`RESOURCE_AUDIO_CAPTURE`.
- Автоплей: компонент выставляет `mediaPlaybackRequiresUserAction={false}`
  (WebSettings `setMediaPlaybackRequiresUserGesture(false)`) и
  `allowsInlineMediaPlayback`.
- HTTP — только dev: `android:usesCleartextTraffic="true"` или
  network-security-config. В проде HTTPS; `mixedContentMode="never"` уже
  выставлен компонентом.
- Эмулятор: `serverUrl: 'http://10.0.2.2:8787'`; физическое устройство — IP
  dev-машины (телефон и ноутбук в одной сети).

### 6.3. Expo config plugin

Пакет поставляет `@agil/calls-react-native/expo-plugin`:

```json
{
  "expo": {
    "scheme": "myapp",
    "plugins": [
      [
        "@agil/calls-react-native/expo-plugin",
        {
          "cameraPermission": "Разрешите доступ к камере для видеозвонков",
          "microphonePermission": "Разрешите доступ к микрофону для звонков"
        }
      ]
    ]
  }
}
```

Что делает плагин: добавляет `NSCameraUsageDescription`/
`NSMicrophoneUsageDescription`, `uses-permission` CAMERA/RECORD_AUDIO и
`uses-feature camera required=false`. Нативных бинарников нет.

Если нужен свой плагин (например, добавить `NSAppTransportSecurity` для dev),
используйте тот же API Expo:

```js
// plugins/withAgilCall.js
const { withInfoPlist, withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withAgilCall(config) {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.NSCameraUsageDescription ||= 'Разрешите доступ к камере';
    cfg.modResults.NSMicrophoneUsageDescription ||= 'Разрешите доступ к микрофону';
    return cfg;
  });
  config = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest['uses-permission'] ||= [];
    manifest['uses-permission'].push({ $: { 'android:name': 'android.permission.CAMERA' } });
    manifest['uses-permission'].push({ $: { 'android:name': 'android.permission.RECORD_AUDIO' } });
    return cfg;
  });
  return config;
};
```

После изменения плагина нужен `npx expo prebuild --clean` / новый EAS Build;
Expo Go использует стандартные разрешения и не применяет кастомные строки.

### 6.4. Safe area и autoplay

Виджет использует `env(safe-area-inset-*)`, но Android WebView не поддерживает
эти CSS-переменные. Передайте отступы из `react-native-safe-area-context`:

```tsx
const insets = useSafeAreaInsets();
<AgilCall safeAreaInsets={insets} style={{ flex: 1 }} … />
```

Компонент добавляет `paddingTop/Right/Bottom/Left` к внешнему контейнеру;
WebView занимает оставшуюся область. Автоплей включается
`allowsInlineMediaPlayback` + `mediaPlaybackRequiresUserAction={false}`; на iOS
дополнительно нужен `mediaCapturePermissionGrantType="grant"` (уже задан).

## 7. Безопасность

- **HTTPS** в проде; HTTP — только localhost/эмулятор.
- **Токен** короткоживущий, выпускается backend’ом; не логируется, не попадает
  в ошибки. `redactCallUrl()`/`redactTokenText()` маскируют JWT и
  `token`/`identity_token` в сообщениях.
- **Origin**: `serverUrl` — только `http(s)`, без credentials/query/hash;
  навигация вне `serverUrl` + `allowedOrigins` блокируется.
- **Deep link**: `server`-параметр проверяется на совпадение origin и пути;
  cross-origin ссылка отбрасывается. Для custom scheme — allowlist origin’ов.
- **Bridge**: сообщения ограничены по размеру (`262144` символов), payload
  санитайзится (глубина, массивы, ключи, строки, `__proto__`/`constructor`),
  неизвестные типы игнорируются; инжектируемый JSON экранирует
  `<`, `>`, `&`, U+2028/U+2029. RN/Flutter/Android дополнительно тегируют
  пересланные сообщения одноразовым nonce, который знает только шим на
  origin’е виджета; прямой `postMessage` со страницы SSO-origin’а отклоняется.
  iOS (Capacitor) проверяет `WKFrameInfo.securityOrigin`.
- **Ошибки**: `widgetError()`/`onError` редактируют `token`,
  `identity_token`, `access_token` и JWT-подобные строки (включая нативные
  `error.description`).
- **WebView**: `javaScriptCanOpenWindowsAutomatically={false}`,
  `setSupportMultipleWindows={false}`, `allowFileAccess={false}`,
  `allowUniversalAccessFromFileURLs={false}`, `mixedContentMode="never"`.
- **Права**: UI виджета скрывает недоступные функции, но окончательно права
  проверяет сервер; мобильная обёртка не обходит эту модель.
- **Никаких нативных бинарников**: пакет не содержит WebRTC-модулей, не
  требует `pod install`/Gradle-плагина.

### 7.1. Коды ошибок: соответствие SDK

Единого enum во всех SDK нет; ниже — как читать коды друг друга. Веб-коды,
которых нет в RN/Flutter/Capacitor, отмечены явно.

| Смысл | `@agil/calls-embed` | RN / Flutter | Capacitor |
|---|---|---|---|
| Неверная конфигурация | `invalid-config`, `missing-room` | `invalid-config` | `invalid-config` |
| Нет комнаты | `missing-room` | `invalid-config` | `invalid-config` |
| Таймаут загрузки/рукопожатия | `load-timeout`, `bridge-timeout` | `timeout` | `timeout` |
| Ошибка загрузки страницы | `iframe-error` | `load-failed`, `http-error` | `load-failed`, `http-error` |
| Навигация заблокирована | — | `navigation-blocked` | `navigation-blocked` |
| Процесс WebView умер | — | `render-process-gone` | `render-process-gone` |
| Ошибка моста | `bridge-error` | `bridge-error` | `bridge-error` |
| Ошибка/denial от виджета | `widget-error`, `action-denied` | `widget-error` (+ `widgetCode`) | `widget-error` (+ `widgetCode`) |
| Элемент уничтожен | `destroyed` | — | — |
| Нет платформенной поддержки | — | — | `unsupported` |
| Нет прав камеры/микрофона | — | `permission-denied` | `permission-denied` |

`widget-error` в embed считается `fatal`, если пришёл до `agil:ready`; в мобильных
SDK `fatal:false` (виджет обычно продолжает работать в listen-only режиме).
Маппинг нативный кодов в Capacitor выполняет фасад (`src/index.ts`).

## 8. Ограничения P1

| Ограничение | Следствие |
|---|---|
| WebView, не нативный WebRTC | Зависимость от Chromium/WKWebView, больший CPU/батарея, нет нативного видео-пайплайна |
| Нет CallKit/ConnectionService | Нет системного входящего звонка, экрана блокировки, нативного аудио-роутинга |
| Нет push/background | Приложение в фоне может приостановить звонок; нет восстановления после kill |
| Нет screen share | `getDisplayMedia` недоступен в мобильном WebView |
| Нет PiP | `requestPictureInPicture` виджета в WebView не работает |
| File picker/download | Загрузка файлов и скачивание записи требуют нативной обработки |
| Токен в URL | Виден в истории WebView; короткий TTL, HTTPS, очистка данных |
| Один звонок на экран | Не монтируйте несколько WebView с медиа одновременно |

### 8.1. Что нужно для нативного этапа (P2)

Нативный LiveKit RN SDK + CallKit/ConnectionService потребуют:

- выдачи LiveKit-токена и параметров SFU (сейчас медиа-сессия создаётся
  виджетом через существующий API; отдельного мобильного endpoint’а нет);
- push-регистрации (APNs/FCM) и серверной отправки входящих звонков;
- нативного аудио-менеджера, background modes, screen share, PiP;
- новых серверных endpoint’ов для регистрации устройств/токенов — **в P1 они не
  добавлялись**; при реализации их нужно задокументировать в `agil/core/docs/api.md` и
  OpenAPI.

## 9. Проверка и QA

```bash
npm run typecheck -w @agil/calls-react-native
npm test -w @agil/calls-react-native
npm run build -w @agil/calls-react-native
npm pack --dry-run -w @agil/calls-react-native
```

UNIT (Node, без React Native):

- `test/url.test.ts` — normalize/build/parse/deep-link/navigation/redaction;
- `test/bridge.test.ts` — parse/sanitize/map, инжект-скрипты, shim в `node:vm`
  (forward в native, сохранение same-page dispatch, идемпотентность, no-op без
  `ReactNativeWebView`).

Минимальный ручной чек-лист на устройстве:

1. iOS 16/17 и Android 12/13/14; чистая установка.
2. Разрешения: разрешить, отказать, «больше не спрашивать» → `onError`,
   `openAppSettings`.
3. Вход по `joinToken` и через экран входа; join/leave/повторный вход.
4. Камера/микрофон, переключение устройств, mute, смена темы, чат.
5. Deep link: холодный старт и foreground; чужой `server` отклоняется.
6. Блокировка навигации: ссылка на внешний сайт → `onExternalLink`.
7. Фон/возврат, поворот экрана, safe area (вырез/жесты).
8. Плохая сеть/офлайн: `timeout`, `load-failed`, `reload()`.
9. Утечки: в логах нет `token`/`identity_token`.

## 10. Troubleshooting

| Симптом | Решение |
|---|---|
| `timeout` | Проверьте `serverUrl`/`/embed.html` в браузере, HTTPS, CSP, `onHttpError`; увеличьте `readyTimeoutMs`. |
| Нет событий, видео идёт | Обновите `react-native-webview`; проверьте, что инжект не блокируется CSP (нужен `script-src` для inline? инжект WebView обычно обходит CSP, но кастомные настройки могут мешать). |
| Android: нет камеры | Manifest + runtime permission; кастомный WebView — `onPermissionRequest`. |
| iOS: краш при входе | Нет usage strings в Info.plist. |
| `navigation-blocked` | Добавьте origin в `allowedOrigins` или обработайте `onExternalLink`. |
| Чёрный экран | HTTP/self-signed/mixed content; проверьте `onError`/`onHttpError`. |
| Нет звука в фоне | Ограничение WebView; нужен нативный этап. |
| Expo Go не применяет строки разрешений | Нужен dev/prod build с config plugin. |
