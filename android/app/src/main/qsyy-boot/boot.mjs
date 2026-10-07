// Android entry. The APK copies the standalone server next to this file and
// starts it with nodejs-mobile. The WebView then opens 127.0.0.1 — there is
// no desktop machine and no address to type.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const logPath = process.env.QSYY_LOG || '';
function log(line) {
  try { if (logPath) fs.appendFileSync(logPath, `${line}\n`); } catch (_) {}
}

process.on('uncaughtException', (error) => {
  log(`uncaught ${error?.stack || error}`);
});
process.on('unhandledRejection', (error) => {
  log(`rejection ${error?.stack || error}`);
});

try {
  const root = process.env.QSYY_APP_ROOT;
  if (!root) throw new Error('QSYY_APP_ROOT is not set');
  const home = process.env.QSYY_HOME || root;
  process.env.HOME = home;
  process.env.TMPDIR = process.env.TMPDIR || path.join(home, 'tmp');
  process.env.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
  process.env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  process.env.QSYY_PLATFORM = 'android';
  process.env.QSYY_HOST = '127.0.0.1';
  process.env.QSYY_PORT = process.env.QSYY_PORT || '18790';
  process.env.QSYY_DOWNLOAD_DIR = process.env.QSYY_DOWNLOAD_DIR || path.join(home, 'Downloads');
  // No QSYY_CACHE_DIR. The phone has no 汽水 LunaCacheV2; pointing the
  // scanner at an empty directory only makes every playlist poll retry.
  fs.mkdirSync(process.env.TMPDIR, { recursive: true });
  fs.mkdirSync(process.env.QSYY_DOWNLOAD_DIR, { recursive: true });
  fs.mkdirSync(process.env.XDG_CACHE_HOME, { recursive: true });
  fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
  log(`boot root=${root} execPath=${process.execPath} platform=${process.platform}`);
  process.chdir(root);
  await import(pathToFileURL(path.join(root, 'standalone', 'server.mjs')).href);
  log('server module evaluated');
} catch (error) {
  log(`boot failed\n${error?.stack || error}`);
  process.exitCode = 1;
}
