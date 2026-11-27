/**
 * AgilFrame + Electron — минимальный корректный пример.
 *
 * Что важно для WebRTC в Electron:
 *  - contextIsolation:true, nodeIntegration:false, sandbox:true;
 *  - обработчик разрешений (камера/микрофон/экран);
 *  - setDisplayMediaRequestHandler для getDisplayMedia (иначе screen share молчит);
 *  - автоплей без жеста (для тестового стенда);
 *  - грузим UI с http://localhost/custom protocol, а не file:// (стабильнее для API).
 *
 * Запуск:
 *   cd examples/electron && npm install
 *   AGIL_SERVER_URL=http://localhost:8787 npm start
 *   (опционально AGIL_TOKEN=<join token>, если комната закрыта)
 */
const { app, BrowserWindow, session, desktopCapturer } = require('electron');
const path = require('node:path');

const SERVER_URL = process.env.AGIL_SERVER_URL || 'http://localhost:8787';
const TOKEN = process.env.AGIL_TOKEN || '';
const ROOM = process.env.AGIL_ROOM || 'electron-demo';
const TENANT = process.env.AGIL_TENANT || 'demo';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 360,
    minHeight: 480,
    backgroundColor: '#0b0f17',
    title: 'AgilFrame (Electron)',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  const params = new URLSearchParams({ server: SERVER_URL, tenant: TENANT, room: ROOM, name: 'Electron' });
  if (TOKEN) params.set('token', TOKEN);
  win.loadFile(path.join(__dirname, 'index.html'), { query: Object.fromEntries(params) });
}

app.whenReady().then(() => {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(allowed.has(permission));
  });
  ses.setPermissionCheckHandler((_webContents, permission) => allowed.has(permission));

  // getDisplayMedia(): Electron не показывает picker сам — выбираем первый экран
  // (в реальном приложении покажите свой выбор source-а).
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const screen = sources.find((source) => source.id.startsWith('screen:')) ?? sources[0];
          callback({ video: screen, audio: 'loopback' });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );

  // Безопасность навигации: не пускаем окно на чужие origin'ы.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      const target = new URL(url);
      const server = new URL(SERVER_URL);
      if (target.origin !== server.origin && target.protocol !== 'file:') event.preventDefault();
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
