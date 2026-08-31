// Cross-platform platform layer for qsyy.
// Centralizes every OS-specific concern: client installation discovery,
// session-cookie decryption, ffmpeg lookup, and user-facing folder opening.
// Each platform block is guarded so an unknown platform degrades gracefully
// (features depending on the client simply report unavailable).

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const PLATFORM = process.platform; // 'darwin' | 'win32' | 'linux'

// Mobile access (Android / iOS browsers hitting this server over the LAN)
// needs no platform-specific server logic: the UI is responsive and every
// media response already supports Range. The notes below document where the
// desktop client integration does / does not apply.
export const MOBILE_CLIENT_NOTES = {
  android: {
    // The Android client stores its cache in app-private storage
    // (Android/data/…), not readable without root — remote servers simply
    // don't see it. Mobile browsers get playback via the online path and the
    // LAN desktop's cache instead.
    localCache: 'unavailable-outside-desktop',
    onlinePlayback: 'supported',
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
  if (PLATFORM === 'darwin') {
    return { app: '/Applications/汽水音乐.app', name: '汽水音乐' };
  }
  if (PLATFORM === 'win32') {
    // Per-user install is the default; the machine-wide one is the fallback.
    const candidates = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'qishui'),
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
export const CLIENT_DATA = (() => {
  if (PLATFORM === 'darwin') {
    const base = path.join(HOME, 'Library', 'Application Support', 'SodaMusic');
    return { data: base, cache: base, cookies: path.join(base, 'Cookies'), cookiesKind: 'sqlite-plain' };
  }
  if (PLATFORM === 'win32') {
    const base = path.join(HOME, 'AppData', 'Roaming', 'SodaMusic') || path.join(HOME, 'AppData', 'Roaming', 'qishui');
    return { data: base, cache: base, cookies: path.join(base, 'Cookies'), cookiesKind: 'sqlite-plain' };
  }
  const base = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'SodaMusic')
    : path.join(HOME, '.config', 'SodaMusic');
  return { data: base, cache: path.join(HOME, '.cache', 'SodaMusic'), cookies: path.join(base, 'Cookies'), cookiesKind: 'sqlite-plain' };
})();

export const CLIENT_PACKAGES = path.join(CLIENT_DATA.data, 'Packages');

// ---------------------------------------------------------------- qsyy own data

export const QSYY_CACHE_DIR = process.env.QSYY_CACHE_DIR || CLIENT_DATA.cache && path.join(CLIENT_DATA.cache, 'LunaCacheV2');
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

// Session cookies for qishui.com. All desktop builds store cookies in a
// plain SQLite database (Chromium variants without OS-keychain encryption),
// so the same sqlite3 CLI query works everywhere.
export function cookieQueryCommand(dbPath) {
  return {
    cmd: 'sqlite3',
    args: [dbPath, "SELECT name || '=' || value FROM cookies WHERE host_key IN ('.qishui.com','.bytedance.com');"],
  };
}

// ---------------------------------------------------------------- shell open

// Reveal a folder in the platform file manager.
export function openFolder(dir) {
  if (PLATFORM === 'darwin') return { cmd: 'open', args: [dir] };
  if (PLATFORM === 'win32') return { cmd: 'explorer', args: [dir] };
  return { cmd: 'xdg-open', args: [dir] };
}

// Launch the desktop client (used by the "play once to cache" fallback).
export function openClient() {
  if (PLATFORM === 'darwin') return { cmd: 'open', args: ['-a', '汽水音乐'] };
  if (PLATFORM === 'win32') {
    const exe = CLIENT_ROOTS.app ? path.join(CLIENT_ROOTS.app, '汽水音乐.exe') : '';
    return { cmd: 'cmd', args: ['/c', 'start', '', exe || '汽水音乐:'] };
  }
  return { cmd: 'xdg-open', args: ['qishui://'] }; // deb/rpm builds register the scheme
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
  ffmpeg: findFfmpeg(),
  deviceNode: findDeviceNode(),
};
