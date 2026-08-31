'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

function firstExisting(paths, filesystem = fs) {
  return paths.find(candidate => candidate && filesystem.existsSync(candidate));
}

function resolveMacRuntime({ env, home, filesystem }) {
  const macBridgeRoot = env.QISHUI_PLUGIN_ROOT
    || path.resolve(__dirname, '..', '..', 'mac', 'bridge');
  const installRoot = env.QSYY_SODA_ROOT || env.QISHUI_SODA_ROOT || '/Applications/汽水音乐.app';
  return {
    script: firstExisting([path.join(macBridgeRoot, 'restore_cache.js')], filesystem),
    lmdb: firstExisting([path.join(macBridgeRoot, 'node_modules', 'lmdb')], filesystem),
    // Not loaded by the mac restore script; the client's copy is only probed
    // so the dependency check in RestoreService passes.
    device: firstExisting([
      path.join(installRoot, 'Contents', 'Resources', 'app.asar.unpacked', 'device.node'),
    ], filesystem),
    ffmpeg: firstExisting([
      env.FFMPEG_PATH,
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
    ], filesystem) || 'ffmpeg',
    cacheDir: env.QISHUI_CACHE_DIR
      || path.join(home, 'Library', 'Application Support', 'SodaMusic', 'LunaCacheV2'),
  };
}

function createRuntimeResolver({ env = process.env, home = os.homedir(), temp = os.tmpdir(), filesystem = fs } = {}) {
  return function resolveRuntime() {
    if (process.platform === 'darwin' || env.QSYY_MAC === '1' || env.SODA_MAC === '1') return resolveMacRuntime({ env, home, filesystem });
    const userHome = env.USERPROFILE || home;
    const installRoot = env.QSYY_SODA_ROOT || env.QISHUI_SODA_ROOT || 'M:\\Soda Music';
    const pluginRoot = env.QISHUI_PLUGIN_ROOT || path.join(installRoot, 'QiShuiMusicPlugins');
    let packageVersion = '3.6.1';
    try {
      const configPath = path.join(installRoot, 'Packages', 'config.json');
      const config = JSON.parse(filesystem.readFileSync(configPath, 'utf8'));
      if (typeof config.latestVersion === 'string' && /^[0-9.]+$/.test(config.latestVersion)) {
        packageVersion = config.latestVersion;
      }
    } catch (_) {}
    const packageRoot = path.join(installRoot, 'Packages', packageVersion);
    return {
      script: firstExisting([
        path.join(pluginRoot, 'bridge', 'restore_cache.js'),
        path.join(userHome, '.codex', 'skills', 'qishui-music', 'scripts', 'restore_cache.js'),
      ], filesystem),
      lmdb: firstExisting([
        path.join(pluginRoot, 'bridge', 'node_modules', 'lmdb'),
        path.join(temp, 'qishui-lmdb-reader', 'node_modules', 'lmdb'),
        path.join(temp, 'qsyy-lmdb-reader', 'node_modules', 'lmdb'),
      ], filesystem),
      device: firstExisting([
        path.join(packageRoot, 'app.asar.unpacked', 'device.node'),
      ], filesystem),
      ffmpeg: firstExisting([
        path.join(pluginRoot, 'bridge', 'ffmpeg.exe'),
        'M:\\ffmpeg-6.0-full_build\\ffmpeg-6.0-full_build\\bin\\ffmpeg.exe',
      ], filesystem) || 'ffmpeg',
      cacheDir: path.join(
        env.APPDATA || path.join(userHome, 'AppData', 'Roaming'),
        'SodaMusic',
        'LunaCacheV2',
      ),
    };
  };
}

module.exports = { createRuntimeResolver, firstExisting };
