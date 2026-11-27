# AgilFrame в Electron (и других браузерных обёртках)

Виджет — обычная веб-страница на стандартных Web API, поэтому работает в
Electron, WebView2, CEF, Tauri (WebView2/WKWebView). Ниже — корректная
интеграция и подводные камни. Рабочий пример: `agil/core/examples/electron/`.

## 1. Быстрый старт (Electron)

```bash
# 1) поднимите сервер AgilFrame
npm run build && npm start            # http://localhost:8787

# 2) соберите/запустите пример
cd agil/core/examples/electron && npm install
AGIL_SERVER_URL=http://localhost:8787 npm start
```

Пример открывает окно, запрашивает комнату через `POST /v1/rooms`
(demo-тенант), монтирует виджет `AGILCalls.mount('#call', …)` и настраивает
разрешения/демонстрацию экрана.

## 2. Обязательные настройки BrowserWindow

```js
new BrowserWindow({
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    autoplayPolicy: 'no-user-gesture-required', // для тестов; в проде можно убрать
  },
});
```

- **Не отключайте `webSecurity`** — это ломает CORS/CSP-модель.
- Загружайте UI с `http(s)://` (localhost/ваш домен) или через custom protocol
  (`app://`), а не `file://`: `file://`-origin хуже для `fetch`/CSP/iframe.
- `contextIsolation:true` + `sandbox:true` — чтобы SDK не получил доступ к Node.

## 3. Разрешения на камеру/микрофон/экран

Electron не показывает стандартный permission-prompt как Chrome — нужно
обработать самому:

```js
const ses = session.defaultSession;
const allowed = new Set(['media', 'display-capture', 'clipboard-read', 'fullscreen']);
ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
```

Демонстрация экрана (`getDisplayMedia`) без обработчика молча падает:

```js
ses.setDisplayMediaRequestHandler((_request, callback) => {
  desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
    callback({ video: sources[0], audio: 'loopback' }); // 'loopback' — системный звук (Windows)
  });
}, { useSystemPicker: false });
```

В проде покажите свой выбор источника (окно/экран), как это делает
`setDisplayMediaRequestHandler` с UI, а не берите первый экран автоматически.

## 4. "Свернуть звонок в маленькое окно"

В Electron это делается на уровне окон, а не только внутри страницы:

- **Мини-окно**: `new BrowserWindow({ width: 360, height: 220, alwaysOnTop: true,
  frame: false, resizable: true })`, загружает тот же `embed.html` с
  `layout.chrome='none'`/`minimized` — звонок продолжается.
- **PiP-поведение**: `win.setAlwaysOnTop(true, 'floating')`,
  `win.setSkipTaskbar(true)` в свёрнутом режиме.
- **Документ-PiP** (Chromium): `instance.requestPictureInPicture()` — окно
  поверх всех приложений, управляется кнопкой в виджете. В Electron работает.
- **Скрыть основное окно, оставить мини-окно** — «звонок на фоне» при работе в
  других приложениях.

## 5. Безопасность обёртки

- `will-navigate`/`setWindowOpenHandler` — блокируйте переходы на чужие origin
  (пример в `main.cjs`).
- CSP: подключайте SDK с вашего домена; `script-src 'self' <server>`; без
  `unsafe-eval`.
- Токены — получайте на бэкенде компании и передавайте в приложение; не храните
  долгоживущие API-ключи в renderer.
- Автообновление — electron-updater, подпись кода (Windows/macOS), отдельный
  канал обновлений.
- `setPermissionCheckHandler` обязателен: некоторые API проверяют разрешение
  синхронно.

## 6. WebView2 / CEF / Tauri

| Обёртка | Камера/мик | Экран | Нюансы |
|---|---|---|---|
| WebView2 (Windows) | `CoreWebView2.PermissionRequested` | `getDisplayMedia` + `ScreenCaptureStarting` | нужен https/localhost (secure context) |
| CEF | `OnRequestMediaAccessPermission` | свой picker | проверять версию CEF |
| Tauri (WebView2) | разрешения через Tauri API/плагины | ограниченно | Windows ок |
| Tauri (WKWebView, macOS/iOS) | `WKUIDelegate` requestMediaCapturePermission | ограниченно | **нужен https**; iOS-экран — нативно |
| CEF/WebView | — | — | автоплей: `--autoplay-policy=no-user-gesture-required` при необходимости |

## 7. Troubleshooting

| Симптом | Причина/решение |
|---|---|
| Камера не включается | нет `setPermissionRequestHandler`; проверьте системные разрешения ОС |
| «Демонстрация экрана не работает» | нет `setDisplayMediaRequestHandler` |
| Пустой экран, CORS-ошибки | загрузка с `file://`; используйте localhost/custom protocol |
| Виджет не грузится в iframe | CSP `frame-ancestors` сервера (`integrations.allowedOrigins`) |
| Звонок не устанавливается | нет TURN; для корпоративных сетей настройте coturn |
| Высокий CPU при blur | MediaPipe дорог; отключите blur на слабых машинах (флаг/настройка) |
| Чат компании не виден | `session.chat.ui='external'` — рисуйте свой чат; сообщения приходят событиями |

## 8. Чек-лист

- [ ] `contextIsolation/sandbox`, `webSecurity` включены
- [ ] permission handlers (media, display-capture) настроены
- [ ] `setDisplayMediaRequestHandler` + свой picker
- [ ] навигация ограничена доверенными origin
- [ ] мини-окно (alwaysOnTop) для «свернуть звонок»
- [ ] TURN настроен (корпоративные сети)
- [ ] подпись кода и автообновление для дистрибуции
- [ ] проверено на целевой версии Electron/WebView2
