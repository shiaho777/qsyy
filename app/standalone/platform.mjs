// Cross-platform platform layer for qsyy.
// Centralizes every OS-specific concern: client installation discovery,
// session-cookie decryption, ffmpeg lookup, and user-facing folder opening.
// Each platform block is guarded so an unknown platform degrades gracefully
// (features depending on the client simply report unavailable).

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// QSYY_PLATFORM lets the Android shell and tests select this profile.
// nodejs-mobile already reports process.platform as "android".
export const PLATFORM = process.env.QSYY_PLATFORM || process.platform; // 'darwin' | 'win32' | 'linux' | 'android'
export const isAndroid = PLATFORM === 'android';

// The Android APK embeds this server. The phone may have 汽水 installed
// (com.luna.music), but that app's login and cache live in another app's
// sandbox. We probe shared storage; when the OS blocks it, login falls
// back to scanning with 汽水.
export const ANDROID_SODA_PACKAGE = 'com.luna.music';

export function androidImportedCookiesPath(home = process.env.QSYY_HOME || os.homedir()) {
  return path.join(home, 'soda-import', 'Cookies');
}

export function pickAndroidCookiesPath({ imported = '', probedCookies = '' } = {}) {
  return imported || probedCookies || '';
}

export function androidSodaDataCandidates(storageRoots = ['/storage/emulated/0', '/sdcard', process.env.EXTERNAL_STORAGE].filter(Boolean)) {
  const seen = new Set();
  const out = [];
  for (const root of storageRoots) {
    if (!root) continue;
    const base = path.join(root, 'Android', 'data', ANDROID_SODA_PACKAGE);
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(base);
  }
  return out;
}

export function probeAndroidSoda(filesystem = fs, storageRoots, home) {
  let imported = false;
  try { imported = filesystem.existsSync(androidImportedCookiesPath(home)); } catch (_) { imported = false; }
  for (const base of androidSodaDataCandidates(storageRoots)) {
    let exists = false;
    try { exists = filesystem.existsSync(base); } catch (_) { exists = false; }
    if (!exists) continue;
    try {
      filesystem.readdirSync(base);
      return { found: true, readable: true, path: base, imported };
    } catch (_) {
      return { found: true, readable: false, path: base, imported };
    }
  }
  return { found: false, readable: false, path: '', imported };
}

export const MOBILE_CLIENT_NOTES = {
  android: {
    localCache: 'other-app-sandbox',
    onlinePlayback: 'web-session',
  },
  ios: {
    localCache: 'unavailable-outside-desktop',
    onlinePlayback: 'supported',
  },
};

const HOME = os.homedir();

// ---------------------------------------------------------------- client roots

// The desktop client's install location per platform.
export const CLIENT_ROOTS = (() => {
  if (PLATFORM === 'android') return { app: '', name: '汽水音乐' };
  if (PLATFORM === 'darwin') {
    return { app: '/Applications/汽水音乐.app', name: '汽水音乐' };
  }
  if (PLATFORM === 'win32') {
    // Per-user install is the default; the machine-wide one is the fallback.
    const local = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    const candidates = [
      path.join(local, 'Programs', 'qishui'),
      path.join(local, 'Programs', 'SodaMusic'),
      path.join(local, 'Programs', '汽水音乐'),
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'qishui'),
      process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'qishui'),
    ].filter(Boolean);
    return { app: candidates.find(p => fs.existsSync(p)) || candidates[0] || '', name: '汽水音乐' };
  }
  // Linux: AppImage extracts vary, but the deb/rpm layout is standard.
  const candidates = ['/opt/qishui', '/opt/汽水音乐', '/usr/lib/qishui'];
  return { app: candidates.find(p => fs.existsSync(p)) || candidates[0] || '', name: '汽水音乐' };
})();

// Native signing libraries shipped with the client (ttnet-helper consumers).
export const NATIVE_LIBS = (() => {
  if (PLATFORM === 'android') return { metasec: '', cronet: '' };
  if (PLATFORM === 'darwin') {
    return {
      metasec: path.join(CLIENT_ROOTS.app, 'Contents', 'Frameworks', 'mssdk', 'libMetaSecML.dylib'),
      cronet: path.join(CLIENT_ROOTS.app, 'Contents', 'Frameworks', 'libsscronet.dylib'),
    };
  }
  if (PLATFORM === 'win32') {
    return {
      metasec: path.join(CLIENT_ROOTS.app, 'resources', 'app.asar.unpacked', 'mssdk', 'mssdk.dll'),
      cronet: path.join(CLIENT_ROOTS.app, 'resources', 'app.asar.unpacked', 'ttnet', 'libsscronet.dll'),
    };
  }
  return {
    metasec: path.join(CLIENT_ROOTS.app, 'resources', 'app.asar.unpacked', 'mssdk', 'libmetasec_ml.so'),
    cronet: path.join(CLIENT_ROOTS.app, 'resources', 'app.asar.unpacked', 'ttnet', 'libsscronet.so'),
  };
})();

// The client's native key module (decodeSpade), used to decrypt CENC streams.
export function findDeviceNode({ asarUnpackedDir } = {}) {
  if (PLATFORM === 'android') return '';
  const moduleName = PLATFORM === 'win32' ? 'device.node' : 'device.node'; // same name on all platforms
  const candidates = [];
  if (asarUnpackedDir) candidates.push(path.join(asarUnpackedDir, moduleName));
  if (PLATFORM === 'darwin') {
    candidates.push(path.join(CLIENT_ROOTS.app, 'Contents', 'Resources', 'app.asar.unpacked', moduleName));
  } else if (CLIENT_ROOTS.app) {
    candidates.push(path.join(CLIENT_ROOTS.app, 'resources', 'app.asar.unpacked', moduleName));
  }
  return candidates.find(p => p && fs.existsSync(p)) || candidates[0] || '';
}

// Cache / data roots of the desktop client.
function androidClientData() {
  const imported = (() => {
    try {
      const candidate = androidImportedCookiesPath();
      return fs.existsSync(candidate) ? candidate : '';
    } catch (_) { return ''; }
  })();
  const hit = probeAndroidSoda();
  const probedCookies = hit.path ? [
    path.join(hit.path, 'Cookies'),
    path.join(hit.path, 'files', 'Cookies'),
    path.join(hit.path, 'app_webview', 'Default', 'Cookies'),
  ].find(candidate => {
    try { return fs.existsSync(candidate); } catch (_) { return false; }
  }) || '' : '';
  const cookies = pickAndroidCookiesPath({ imported, probedCookies });
  return {
    data: hit.readable ? hit.path : '',
    cache: hit.readable ? hit.path : '',
    cookies,
    cookiesKind: cookies ? 'sqlite-plain' : 'none',
    imported: Boolean(imported),
  };
}

export const CLIENT_DATA = (() => {
  if (PLATFORM === 'android') return androidClientData();
  if (PLATFORM === 'darwin') {
    const base = path.join(HOME, 'Library', 'Application Support', 'SodaMusic');
    return { data: base, cache: base, cookies: path.join(base, 'Cookies'), cookiesKind: 'sqlite-plain' };
  }
  if (PLATFORM === 'win32') {
    const roaming = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    const candidates = [path.join(roaming, 'SodaMusic'), path.join(roaming, 'qishui')];
    const base = candidates.find(p => fs.existsSync(p)) || candidates[0];
    return { data: base, cache: base, cookies: path.join(base, 'Cookies'), cookiesKind: 'sqlite-plain' };
  }
  const base = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'SodaMusic')
    : path.join(HOME, '.config', 'SodaMusic');
  return { data: base, cache: path.join(HOME, '.cache', 'SodaMusic'), cookies: path.join(base, 'Cookies'), cookiesKind: 'sqlite-plain' };
})();

export const CLIENT_PACKAGES = path.join(CLIENT_DATA.data, 'Packages');

// ---------------------------------------------------------------- qsyy own data

export function resolveClientCookiesPath() {
  if (process.env.QSYY_COOKIES_DB) return process.env.QSYY_COOKIES_DB;
  if (PLATFORM === 'android') return androidClientData().cookies || '';
  return CLIENT_DATA.cookies;
}

export const QSYY_CACHE_DIR = process.env.QSYY_CACHE_DIR
  || (CLIENT_DATA.cache ? path.join(CLIENT_DATA.cache, 'LunaCacheV2') : '');
export const QSYY_COOKIES_DB = process.env.QSYY_COOKIES_DB || CLIENT_DATA.cookies;
export const QSYY_DOWNLOAD_DIR = process.env.QSYY_DOWNLOAD_DIR
  || path.join(HOME, 'Downloads', 'qsyy');
export const QSYY_DECRYPT_DIR = path.join(os.tmpdir?.() || '/tmp', '..', 'qsyy')
  // tmpdir on Windows is under the user profile; prefer a stable per-user dir
  || QSYY_CACHE_DIR;

// Decrypted copies / incremental store live with the OS cache conventions.
export const OS_CACHE_ROOT = PLATFORM === 'darwin'
  ? path.join(HOME, 'Library', 'Caches')
  : PLATFORM === 'win32'
    ? path.join(HOME, 'AppData', 'Local', 'qsyy')
    : (process.env.XDG_CACHE_HOME ? path.join(process.env.XDG_CACHE_HOME, 'qsyy') : path.join(HOME, '.cache', 'qsyy'));

// ---------------------------------------------------------------- ffmpeg

export function findFfmpeg() {
  if (PLATFORM === 'android') return '';
  const fromEnv = process.env.FFMPEG_PATH;
  const candidates = [
    fromEnv,
    // macOS homebrew
    '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg',
    // windows common installs
    'C:/ffmpeg/bin/ffmpeg.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    // linux standard paths
    '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/snap/bin/ffmpeg',
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || 'ffmpeg';
}

// ---------------------------------------------------------------- cookies

// Session cookies for qishui.com. Desktop builds store them in a plain
// SQLite Cookies file. Callers should use cookies.mjs (CLI if present,
// otherwise a JS reader) — Windows and Docker typically have no sqlite3 binary.
export function cookieQueryCommand(dbPath) {
  if (!dbPath) return null;
  return {
    cmd: 'sqlite3',
    args: [dbPath, "SELECT name || '=' || value FROM cookies WHERE host_key IN ('.qishui.com','.bytedance.com');"],
  };
}

// ---------------------------------------------------------------- shell open

// Reveal a folder in the platform file manager.
export function openFolder(dir) {
  if (PLATFORM === 'android') return null;
  if (PLATFORM === 'darwin') return { cmd: 'open', args: [dir] };
  if (PLATFORM === 'win32') return { cmd: 'explorer', args: [dir] };
  return { cmd: 'xdg-open', args: [dir] };
}

// PID of the process listening on a TCP port ('' when unknown). Used by the
// port-takeover handshake to locate a qsyy sibling that predates the instance
// file / pid-in-/api/version conventions. Never called on foreign holders —
// the caller verifies qsyy identity via /api/version first.
export function findPortHolderPid(port) {
  if (PLATFORM === 'android') return '';
  try {
    if (PLATFORM === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 8000 });
      const line = out.split('\n').find(l => l.includes(`:${port}`) && /LISTENING/i.test(l));
      return Number(line?.trim().split(/\s+/).pop()) || '';
    }
    const out = execFileSync('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 8000 });
    return Number(out.trim().split('\n')[0]) || '';
  } catch (_) { return ''; }
}

// Launch the desktop client (used by the "play once to cache" fallback).
export function openClient() {
  if (PLATFORM === 'android') return null;
  if (PLATFORM === 'darwin') return { cmd: 'open', args: ['-a', '汽水音乐'] };
  if (PLATFORM === 'win32') {
    const exe = CLIENT_ROOTS.app ? path.join(CLIENT_ROOTS.app, '汽水音乐.exe') : '';
    return { cmd: 'cmd', args: ['/c', 'start', '', exe || '汽水音乐:'] };
  }
  return { cmd: 'xdg-open', args: ['qishui://'] }; // deb/rpm builds register the scheme
}

// ---------------------------------------------------------------- node children

// Desktop and Electron can spawn this process's executable as Node
// (Electron needs ELECTRON_RUN_AS_NODE). nodejs-mobile cannot: its
// process.execPath is /system/bin/app_process64, and spawning that starts
// another app process rather than a script. Callers must skip the child.
export function nodeChildLaunch() {
  if (isAndroid) return null;
  if (!process.execPath) return null;
  const env = { ...process.env };
  if (!env.ELECTRON_RUN_AS_NODE && process.versions?.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return { command: process.execPath, env };
}

// ---------------------------------------------------------------- helpers

export const isWindows = PLATFORM === 'win32';
export const isMac = PLATFORM === 'darwin';
export const isLinux = PLATFORM === 'linux';

export const platformSummary = {
  platform: PLATFORM,
  clientRoot: CLIENT_ROOTS.app || null,
  cacheDir: QSYY_CACHE_DIR || null,
  cookiesDb: QSYY_COOKIES_DB || null,
  ffmpeg: findFfmpeg() || null,
  deviceNode: findDeviceNode() || null,
  nodeChild: Boolean(nodeChildLaunch()),
};
