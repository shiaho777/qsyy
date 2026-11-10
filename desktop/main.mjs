// qsyy desktop shell (macOS / Windows).
// Loads the standalone server in-process (same server.mjs as `npm run
// standalone`) and points a BrowserWindow at it. The server module resolves
// the client install, cache and cookies exactly as it does headless, so the
// desktop app is a pure presentation shell — no server logic is duplicated.
import { app, BrowserWindow, shell, Menu, nativeImage, ipcMain, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: desktop/main.mjs → ../app/standalone/server.mjs. Packaged,
// main.mjs is inside app.asar and extraResources puts app/ beside it, so
// ../app/standalone still resolves to a real directory.
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
    // mainWindow, not getAllWindows()[0]: that may be the floating lyrics
    const win = mainWindow;
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
  // Windows 盘符路径会被 ESM 当成 URL 协议(protocol 'd:' / 'c:')直接拒绝。
  // file:// 在各平台都合法,打包后 server 在 asar 外的 extraResources 里。
  await import(pathToFileURL(path.join(serverDir, 'server.mjs')).href);
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
      preload: path.join(root, 'preload.cjs'),
    },
  });

  // External links (roadmap links, GitHub) open in the system browser; the
  // app itself is the only surface allowed inside the window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(serverUrl)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    closeDesktopLyrics(false);
    // 扫码隐藏窗口也属于主窗口会话。若主窗口先关而 signer 还开着，它既会
    // 留下一个无界面的 renderer，也会让 window-all-closed 永远不触发。
    closeAllQrSigners();
  });
}

// ------------------------------------------------------------ desktop lyrics
// A transparent always-on-top window (public/desktop-lyrics.html). The main
// window owns playback and pushes { state, clock }; this process only relays,
// remembers geometry, and implements lock: when locked the window ignores the
// mouse except over the lock button, found by polling the cursor because a
// click-through window gets no hover events of its own.
const DL_FILE = () => path.join(app.getPath('userData'), 'desktop-lyrics.json');
const dl = { win: null, locked: false, hotspot: null, state: null, clock: null, timer: null, hover: null, passThrough: null, saveTimer: null };

function dlPrefs() {
  try { return JSON.parse(fs.readFileSync(DL_FILE(), 'utf8')) || {}; } catch (_) { return {}; }
}
function dlSave(patch) {
  try { fs.writeFileSync(DL_FILE(), JSON.stringify({ ...dlPrefs(), ...patch })); } catch (_) {}
}
function dlSend(channel, value) {
  if (dl.win && !dl.win.isDestroyed()) dl.win.webContents.send(channel, value);
}
function dlNotifyMain() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('qsyy-dl-visible', Boolean(dl.win));
}

function dlDefaultBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(900, Math.round(area.width * 0.6));
  return { width, height: 140, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + area.height - 140 - 60) };
}

// saved bounds only count while they still overlap a connected display
function dlRestoreBounds() {
  const saved = dlPrefs().bounds;
  if (!saved || !(saved.width > 0)) return dlDefaultBounds();
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    saved.x < a.x + a.width - 40 && saved.x + saved.width > a.x + 40 && saved.y < a.y + a.height - 20 && saved.y + saved.height > a.y);
  return visible ? saved : dlDefaultBounds();
}

function dlSetPassThrough(on) {
  if (!dl.win || dl.passThrough === on) return;
  dl.passThrough = on;
  dl.win.setIgnoreMouseEvents(on, { forward: true });
}

function dlTick() {
  const win = dl.win;
  if (!win || win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  if (inside !== dl.hover) { dl.hover = inside; dlSend('qsyy-dl-hover', inside); }
  if (!dl.locked) { dlSetPassThrough(false); return; }
  const h = dl.hotspot;
  const pad = 6;
  const overLock = Boolean(h) && inside
    && p.x >= b.x + h.x - pad && p.x < b.x + h.x + h.width + pad
    && p.y >= b.y + h.y - pad && p.y < b.y + h.y + h.height + pad;
  dlSetPassThrough(!overLock);
}

function openDesktopLyrics() {
  if (dl.win && !dl.win.isDestroyed()) { dl.win.showInactive(); return; }
  const bounds = dlRestoreBounds();
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 360,
    minHeight: 80,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(root, 'preload.cjs'),
    },
  });
  dl.win = win;
  dl.hover = null;
  dl.passThrough = null;
  dl.locked = Boolean(dlPrefs().locked);
  win.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const persist = () => {
    clearTimeout(dl.saveTimer);
    dl.saveTimer = setTimeout(() => { if (!win.isDestroyed()) dlSave({ bounds: win.getBounds() }); }, 300);
  };
  win.on('moved', persist);
  win.on('resized', persist);
  win.on('closed', () => {
    if (dl.win === win) { dl.win = null; clearInterval(dl.timer); dl.timer = null; }
    dlNotifyMain();
  });
  win.webContents.on('did-finish-load', () => {
    dlSend('qsyy-dl-locked', dl.locked);
    if (dl.state) dlSend('qsyy-dl-state', dl.state);
    if (dl.clock) dlSend('qsyy-dl-clock', dl.clock);
    win.showInactive();
  });
  win.loadURL(`${verifiedUrl || serverUrl}/desktop-lyrics.html`);
  clearInterval(dl.timer);
  dl.timer = setInterval(dlTick, 80);
  dlSave({ enabled: true });
  dlNotifyMain();
}

// remember=false: closing because the app/main window goes away, so the
// lyrics come back next launch; an explicit close turns them off for good.
function closeDesktopLyrics(remember = true) {
  if (remember) dlSave({ enabled: false });
  const win = dl.win;
  dl.win = null;
  clearInterval(dl.timer);
  dl.timer = null;
  if (win && !win.isDestroyed()) {
    dlSave({ bounds: win.getBounds() });
    win.close();
  }
  dlNotifyMain();
}

ipcMain.handle('qsyy-dl-toggle', (_event, want) => {
  const open = typeof want === 'boolean' ? want : !dl.win;
  if (open) openDesktopLyrics(); else closeDesktopLyrics();
  return { visible: Boolean(dl.win), locked: dl.locked };
});
ipcMain.handle('qsyy-dl-status', () => ({ visible: Boolean(dl.win), locked: dl.locked }));
ipcMain.on('qsyy-dl-state', (_event, state) => { dl.state = state; dlSend('qsyy-dl-state', state); });
ipcMain.on('qsyy-dl-clock', (_event, clock) => { dl.clock = clock; dlSend('qsyy-dl-clock', clock); });
ipcMain.on('qsyy-dl-hotspot', (_event, rect) => {
  if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.width)) dl.hotspot = rect;
});
ipcMain.on('qsyy-dl-fit', (_event, height) => {
  const win = dl.win;
  if (!win || win.isDestroyed() || !(height > 0)) return;
  const b = win.getBounds();
  const h = Math.max(80, Math.min(400, Math.round(height)));
  // grow upward from the bottom edge: lyrics usually sit near the dock/taskbar
  if (h !== b.height) win.setBounds({ x: b.x, y: b.y + b.height - h, width: b.width, height: h });
});
ipcMain.on('qsyy-dl-lock', (_event, locked) => {
  dl.locked = Boolean(locked);
  dlSave({ locked: dl.locked });
  dlSend('qsyy-dl-locked', dl.locked);
  dlTick();
});
ipcMain.on('qsyy-dl-cmd', (_event, cmd) => {
  if (cmd === 'close') { closeDesktopLyrics(); return; }
  if (cmd === 'show-main' && mainWindow) { mainWindow.show(); mainWindow.focus(); return; }
  if (['prev', 'next', 'toggle'].includes(cmd) && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('qsyy-dl-command', cmd);
  }
});

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
      if (dlPrefs().enabled) openDesktopLyrics();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const { dialog } = await import('electron');
  dialog.showErrorBox('qsyy 启动失败', '内嵌服务未就绪:端口被占用且无法接管,或服务启动超时。');
  app.exit(1);
}

const qrSigners = new Map();

async function jsonRequest(method, url, body) {
  const { net } = await import('electron');
  return new Promise((resolve, reject) => {
    const request = net.request({ method, url });
    if (body != null) request.setHeader('content-type', 'application/json');
    let data = '';
    request.on('response', res => {
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    if (body != null) request.write(JSON.stringify(body));
    request.end();
  });
}

function closeQrSigner(token) {
  const win = qrSigners.get(token);
  qrSigners.delete(token);
  if (win && !win.isDestroyed()) win.close();
}

function closeAllQrSigners() {
  for (const token of [...qrSigners.keys()]) closeQrSigner(token);
}

async function ensureQrSigner(token) {
  const existing = qrSigners.get(token);
  if (existing) {
    if (!existing.isDestroyed()) return existing;
    qrSigners.delete(token);
  }
  const win = new BrowserWindow({
    show: false,
    width: 420,
    height: 420,
    webPreferences: {
      webSecurity: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: `persist:qsyy-qr-${token}`,
    },
  });
  // 先登记再加载: loadURL/executeJavaScript 失败时, closeAllQrSigners()
  // 也必须能找到这个窗口; 原来成功后才 set, 失败就漏一个隐藏 renderer。
  qrSigners.set(token, win);
  win.on('closed', () => { if (qrSigners.get(token) === win) qrSigners.delete(token); });
  try {
    const base = verifiedUrl || serverUrl;
    await win.loadURL(`${base}/qr-signer.html`);
    await win.webContents.executeJavaScript('window.qsyyWhenReady()');
    return win;
  } catch (error) {
    closeQrSigner(token);
    throw error;
  }
}

ipcMain.handle('qsyy-qr-poll', async (_event, token) => {
  const key = String(token || '');
  if (!key) return { status: 'expired', message: '二维码已过期,请重新生成' };
  const base = verifiedUrl || serverUrl;
  try {
    const spec = await jsonRequest('GET', `${base}/api/weblogin/poll-spec?token=${encodeURIComponent(key)}`);
    if (!spec?.ok) return { status: 'expired', message: '二维码已过期,请重新生成' };
    const win = await ensureQrSigner(key);
    const headers = { ...(spec.headers || {}) };
    delete headers.cookie;
    delete headers.Cookie;
    const poll = await win.webContents.executeJavaScript(
      `window.qsyyPassportPoll(${JSON.stringify({
        postUrl: spec.postUrl,
        getUrl: spec.getUrl,
        body: spec.body,
        headers,
      })})`,
    );
    const cookies = await win.webContents.session.cookies.get({});
    const view = await jsonRequest('POST', `${base}/api/weblogin/poll-result`, {
      token: key,
      ...poll,
      signed: true,
      httpStatus: poll?.status || 0,
      browserCookies: cookies.map(item => ({ name: item.name, value: item.value })),
    });
    if (view?.status === 'success' || view?.status === 'expired') closeQrSigner(key);
    return view;
  } catch (error) {
    return { status: 'error', message: String(error?.message || error) };
  }
});

ipcMain.handle('qsyy-qr-stop', async (_event, token) => {
  const key = String(token || '');
  if (key) closeQrSigner(key);
  else for (const item of [...qrSigners.keys()]) closeQrSigner(item);
  return { ok: true };
});

app.whenReady().then(boot);
app.on('before-quit', () => {
  closeAllQrSigners();
  closeDesktopLyrics(false);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  // count real windows, not just our reference: a lost reference must never
  // let repeated Dock clicks stack extra windows. loadURL moved out of
  // createWindow (boot only loads after the probe verifies our own server),
  // so a re-created window must re-load the verified address itself.
  // mainWindow, not a window count: the floating lyrics window must not stop
  // a Dock click from bringing the main window back.
  if (!mainWindow) {
    createWindow();
    if (mainWindow && verifiedUrl) {
      mainWindow.loadURL(verifiedUrl);
      if (dlPrefs().enabled) openDesktopLyrics();
    }
  }
});
