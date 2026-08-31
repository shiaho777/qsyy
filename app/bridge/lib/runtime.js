'use strict';

// Runtime path resolution for the restore/decrypt chain, per platform.
// Every path can be overridden through environment variables, so unusual
// installs (portable Windows builds, XDG-conforming Linux setups) work
// without code changes.

const os = require('os');
const fs = require('fs');
const path = require('path');

function firstExisting(paths, filesystem = fs) {
  return paths.find(candidate => candidate && filesystem.existsSync(candidate));
}

const FFMPEG_FALLBACKS = {
  darwin: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
  win32: ['C:/ffmpeg/bin/ffmpeg.exe'],
  linux: ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/snap/bin/ffmpeg'],
};

function clientDataRoot(platform, { env, home }) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'SodaMusic');
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'SodaMusic');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'SodaMusic');
}

function clientInstallRoot(platform, { env, home, filesystem }) {
  if (platform === 'darwin') {
    return env.QSYY_SODA_ROOT || env.QISHUI_SODA_ROOT || '/Applications/汽水音乐.app';
  }
  if (platform === 'win32') {
    const candidates = [
      env.QSYY_SODA_ROOT && env.QISHUI_SODA_ROOT,
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'qishui'),
      env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'qishui'),
      env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'qishui'),
    ].filter(Boolean);
    return candidates.find(p => filesystem.existsSync(p)) || candidates[0] || '';
  }
  const candidates = [
    env.QSYY_SODA_ROOT && env.QISHUI_SODA_ROOT,
    '/opt/qishui', '/opt/汽水音乐', '/usr/lib/qishui',
  ].filter(Boolean);
  return candidates.find(p => filesystem.existsSync(p)) || candidates[0] || '';
}

// resources/app.asar.unpacked differs between bundle layouts:
//   macOS    — Contents/Resources/app.asar.unpacked
//   win/linux — resources/app.asar.unpacked
function unpackedDir(platform, installRoot) {
  if (!installRoot) return '';
  return platform === 'darwin'
    ? path.join(installRoot, 'Contents', 'Resources', 'app.asar.unpacked')
    : path.join(installRoot, 'resources', 'app.asar.unpacked');
}

function resolvePlatformRuntime(platform, { env, home, filesystem }) {
  const bridgeRoot = env.QISHUI_PLUGIN_ROOT
    || path.resolve(__dirname, '..', '..');
  const installRoot = clientInstallRoot(platform, { env, home, filesystem });
  const unpacked = unpackedDir(platform, installRoot);
  return {
    script: firstExisting([path.join(bridgeRoot, 'restore_cache.js')], filesystem),
    lmdb: firstExisting([path.join(bridgeRoot, 'node_modules', 'lmdb')], filesystem),
    // Only probed so the dependency check in RestoreService passes; the
    // restore script loads it itself when it meets an encrypted entry.
    device: firstExisting([unpacked && path.join(unpacked, 'device.node')], filesystem),
    ffmpeg: firstExisting([
      env.FFMPEG_PATH,
      ...FFMPEG_FALLBACKS[platform] || [],
    ], filesystem) || 'ffmpeg',
    cacheDir: env.QISHUI_CACHE_DIR
      || path.join(clientDataRoot(platform, { env, home }), 'LunaCacheV2'),
  };
}

function createRuntimeResolver({ env = process.env, home = os.homedir(), temp = os.tmpdir(), filesystem = fs } = {}) {
  return function resolveRuntime() {
    const platform = env.QSYY_PLATFORM
      || (env.QSYY_MAC === '1' || env.SODA_MAC === '1' ? 'darwin' : undefined)
      || process.platform;
    return resolvePlatformRuntime(platform, { env, home, filesystem });
  };
}

module.exports = { createRuntimeResolver, firstExisting };
