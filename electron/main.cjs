// SITE-9 desktop shell: the built game (dist/) in a fullscreen window.
// Files are served through a privileged app:// protocol (fetch() of audio and the
// physics WASM is blocked on file://). Pointer lock comes from the game itself
// (PLAY / clicking the game captures the mouse; Esc releases it to the pause menu).
const { app, BrowserWindow, protocol, net, globalShortcut } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const DIST = path.join(__dirname, '..', 'dist');

function createWindow() {
  // Dev: --url=<address> loads that instead, in a window that is never shown (trailer
  // capture against the dev server: no focus stealing, no taskbar entry, still renders).
  const devUrl = process.argv.find((a) => a.startsWith('--url='));
  const win = new BrowserWindow({
    fullscreen: !devUrl,
    width: 1280,
    height: 720,
    skipTaskbar: !!devUrl,
    focusable: !devUrl,
    paintWhenInitiallyHidden: true,
    autoHideMenuBar: true,
    backgroundColor: '#05070a',
    title: 'SITE-9',
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    webPreferences: {
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  if (!devUrl) win.once('ready-to-show', () => win.show());
  win.loadURL(devUrl ? devUrl.slice(6) : 'app://game/index.html?mouse');
  // F11: fullscreen on/off. The game handles Esc (pause menu).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });
}

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  app.quit();
});
