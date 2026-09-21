// qsyy desktop shell (macOS / Windows).
// Loads the standalone server in-process (same server.mjs as `npm run
// standalone`) and points a BrowserWindow at it. The server module resolves
// the client install, cache and cookies exactly as it does headless, so the
// desktop app is a pure presentation shell — no server logic is duplicated.
import { app, BrowserWindow, shell, Menu, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: desktop/main.mjs → ../app/standalone/server.mjs. In packaged
// apps the app/ tree ships inside the asar, same relative position.
const serverDir = path.join(root, '..', 'app', 'standalone');

// Dev-shell identity: when run from source (`npm start`), Electron otherwise
// shows the stock Electron icon + "Electron" name in Dock / About. setName
// must happen before app ready; the dock icon is applied in boot().
app.setName('qsyy');

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
      if (mainWindow && verifiedUrl) mainWindow.loadURL(verifiedUrl);
    }
  });
}

// server.mjs starts an http server at import time (top-level await style
// module). Importing it is the boot; failures must surface as a dialog
// instead of a silent dead window.
// The embedded server publishes its actual bound address in QSYY_SERVER_URL
// once listening (it may fall back to an ephemeral port when 18790 is held by
// a foreign process). Until then we only know the intended default.
const EXPECTED_REPO = 'https://github.com/shiaho777/qsyy';
let serverUrl = `http://127.0.0.1:${process.env.QSYY_PORT}`;
// Set only after the probe confirms OUR server owns the address — re-created
// windows (activate / second-instance) load this and nothing else.
let verifiedUrl = '';
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

  // External links (roadmap links, GitHub) open in the system browser; the
  // app itself is the only surface allowed inside the window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(serverUrl)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// Probe + identity check: the window must only ever load OUR embedded server.
// The old probe hit `/`, which any HTTP service answers — a stale standalone
// (or any foreign app) squatting on 18790 used to get its UI loaded instead.
// /api/version is in-memory (no auth/backend wait — unlike the earlier
// /api/weblogin/status probe that blocked on the signing helper for ~4s) and
// carries `repo`, so a foreign responder fails the check. Returns the verified
// base URL, or null while the embedded server is still binding.
async function serverAlive() {
  const { net } = await import('electron');
  const target = process.env.QSYY_SERVER_URL || serverUrl;
  return new Promise(resolve => {
    const timer = setTimeout(() => { try { request.abort(); } catch (_) {} resolve(null); }, 1500);
    const request = net.request(`${target}/api/version`);
    let body = '';
    request.on('response', res => {
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const json = JSON.parse(body);
          resolve(json && json.repo === EXPECTED_REPO ? target : null);
        } catch (_) { resolve(null); }
      });
    });
    request.on('error', () => { clearTimeout(timer); resolve(null); });
    request.end();
  });
}

async function boot() {
  Menu.setApplicationMenu(null);
  // 开发壳 Dock 品牌:让 `npm start` 跑起来的窗口也显示 qsyy 图标和名字
  if (process.platform === 'darwin' && app.dock) {
    try {
      const img = nativeImage.createFromPath(path.join(root, 'assets', 'icon.png'));
      if (!img.isEmpty()) app.dock.setIcon(img);
    } catch (_) {}
  }
  createWindow();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const verified = await serverAlive();
    if (verified) {
      serverUrl = verified;
      verifiedUrl = verified;
      mainWindow.loadURL(serverUrl);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const { dialog } = await import('electron');
  dialog.showErrorBox('qsyy 启动失败', '内嵌服务未就绪:端口被占用且无法接管,或服务启动超时。');
  app.exit(1);
}

app.whenReady().then(boot);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  // count real windows, not just our reference: a lost reference must never
  // let repeated Dock clicks stack extra windows. loadURL moved out of
  // createWindow (boot only loads after the probe verifies our own server),
  // so a re-created window must re-load the verified address itself.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    if (mainWindow && verifiedUrl) mainWindow.loadURL(verifiedUrl);
  }
});
