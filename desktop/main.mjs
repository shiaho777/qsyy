// qsyy desktop shell (macOS / Windows).
// Loads the standalone server in-process (same server.mjs as `npm run
// standalone`) and points a BrowserWindow at it. The server module resolves
// the client install, cache and cookies exactly as it does headless, so the
// desktop app is a pure presentation shell — no server logic is duplicated.
import { app, BrowserWindow, shell, Menu } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: desktop/main.mjs → ../app/standalone/server.mjs. In packaged
// apps the app/ tree ships inside the asar, same relative position.
const serverDir = path.join(root, '..', 'app', 'standalone');

// The server reads QSYY_PORT at import time and prints its URL; keep the
// default stable so the window only ever aims at one port.
process.env.QSYY_PORT = process.env.QSYY_PORT || '18790';
process.env.QSYY_HOST = '127.0.0.1';

// server.mjs starts an http server at import time (top-level await style
// module). Importing it is the boot; failures must surface as a dialog
// instead of a silent dead window.
let serverUrl = `http://127.0.0.1:${process.env.QSYY_PORT}`;
try {
  await import(path.join(serverDir, 'server.mjs'));
} catch (error) {
  const { dialog } = await import('electron');
  dialog.showErrorBox('qsyy 启动失败', String(error?.stack || error));
  app.exit(1);
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0c12',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Media keys / Now Playing: proxy the page's MediaSession metadata to the
  // OS integration Electron already provides via `media-*` handlers.
  mainWindow.webContents.on('media-started-playing', () => {});
  mainWindow.loadURL(serverUrl);

  // External links (roadmap links, GitHub) open in the system browser; the
  // app itself is the only surface allowed inside the window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(serverUrl)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// A short retry loop: server.mjs listens synchronously during import, but on
// slow disks the listen callback may trail the first loadURL by a beat.
async function boot() {
  Menu.setApplicationMenu(null);
  createWindow();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const { net } = await import('electron');
      const ok = await new Promise(resolve => {
        const request = net.request(`${serverUrl}/api/weblogin/status`);
        request.on('response', res => resolve(res.statusCode === 200));
        request.on('error', () => resolve(false));
        request.end();
      });
      if (ok) { mainWindow.loadURL(serverUrl); break; }
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

app.whenReady().then(boot);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });
