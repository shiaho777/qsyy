// qsyy desktop shell (macOS / Windows).
// Loads the standalone server in-process (same server.mjs as `npm run
// standalone`) and points a BrowserWindow at it. The server module resolves
// the client install, cache and cookies exactly as it does headless, so the
// desktop app is a pure presentation shell — no server logic is duplicated.
import { app, BrowserWindow, shell, Menu } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: desktop/main.mjs → ../app/standalone/server.mjs. In packaged
// apps the app/ tree ships inside the asar, same relative position.
const serverDir = path.join(root, '..', 'app', 'standalone');

// The server reads QSYY_PORT at import time and prints its URL; keep the
// default stable so the window only ever aims at one port.
process.env.QSYY_PORT = process.env.QSYY_PORT || '18790';
process.env.QSYY_HOST = '127.0.0.1';
// 侧栏 GitHub 行展示 + 检查更新:Electron 的真实版本只有这里拿得到
// (server 读不到 asar 内的 package.json),随服务一起注入。
process.env.QSYY_VERSION = process.env.QSYY_VERSION || app.getVersion();

// Single instance: a second launch (Dock click during a slow start, an app
// copy still running from the DMG, double-clicking the binary) must focus
// the existing window instead of stacking a whole new server + window.
// Without this, every overlapping launch produced another visible window.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else {
      createWindow();
    }
  });
}

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
// slow disks the listen callback may trail the first loadURL by a beat. The
// probe hits `/` (in-memory route, no auth/backend work) with a hard timeout
// — the previous probe used /api/weblogin/status, which awaits the signing
// helper (up to 4s) and made the first launch feel hung.
async function serverAlive() {
  const { net } = await import('electron');
  return new Promise(resolve => {
    const timer = setTimeout(() => { try { request.abort(); } catch (_) {} resolve(false); }, 1500);
    const request = net.request(`${serverUrl}/`);
    request.on('response', res => {
      res.resume();
      clearTimeout(timer);
      resolve(res.statusCode === 200);
    });
    request.on('error', () => { clearTimeout(timer); resolve(false); });
    request.end();
  });
}

async function boot() {
  Menu.setApplicationMenu(null);
  createWindow();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await serverAlive()) {
      mainWindow.loadURL(serverUrl);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

app.whenReady().then(boot);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  // count real windows, not just our reference: a lost reference must never
  // let repeated Dock clicks stack extra windows
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
