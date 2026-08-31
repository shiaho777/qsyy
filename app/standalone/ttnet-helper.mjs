// TTNet helper: a resident subprocess that runs the QiShui client's own
// network stack (libsscronet + mssdk signing) so the standalone app can call
// signed endpoints (track_v2 play URLs) with the client's session — zero login.
//
// Protocol: JSON lines on stdin/stdout.
//   → {"cmd":"resolve","trackId":"123"}
//   ← {"ok":true,"url":"https://...","quality":"highest","bitrate":260000}
//   ← {"ok":false,"error":"..."}
//
// Native modules can hard-crash (CHECK-failed FATAL); running them in this
// dedicated process keeps the main server alive — it just respawns on demand.
//
// Cross-platform notes:
//   macOS    — dylibs under Contents/Frameworks, loaded with RTLD_GLOBAL so
//              mssdk is resident before sscronet looks it up by name.
//   Windows  — DLLs under resources\app.asar.unpacked; the signing DLL is
//              preloaded so load-time imports resolve to the resident copy.
//   Linux    — same preload order via RTLD_GLOBAL; SONAME resolution finds it.
// If the client or its libraries are missing, the helper starts with
// ok:false and the server transparently falls back to the QR web-session path.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PLATFORM, CLIENT_DATA, CLIENT_PACKAGES, NATIVE_LIBS } from './platform.mjs';

const HOME = os.homedir();

function latestPackageDir() {
  try {
    const version = JSON.parse(fs.readFileSync(path.join(CLIENT_PACKAGES, 'config.json'), 'utf8')).latestVersion;
    return path.join(CLIENT_PACKAGES, version, 'app.asar.unpacked');
  } catch (_) {
    for (const fallback of ['3.6.0']) {
      const dir = path.join(CLIENT_PACKAGES, fallback, 'app.asar.unpacked');
      if (fs.existsSync(dir)) return dir;
    }
    return '';
  }
}

const require2 = createRequire(import.meta.url);
const dlopen = file => {
  if (!file || !fs.existsSync(file)) return false;
  try {
    process.dlopen({ exports: {} }, file, os.constants.dlopen.RTLD_GLOBAL | os.constants.dlopen.RTLD_NOW);
    return true;
  } catch (e) {
    // "did not self-register" still leaves the lib loaded in the process
    if (!/self-register/.test(e.message)) return false;
    return true;
  }
};

// Order matters on every platform: the signing lib (mssdk) must be resident
// before the cronet engine resolves it by name.
const metasecOk = dlopen(NATIVE_LIBS.metasec);
const engineOk = dlopen(NATIVE_LIBS.cronet);

// The client's ttnet native module (same module name on all platforms).
const ttnetModule = (() => {
  const dir = latestPackageDir();
  if (!dir) return '';
  const file = path.join(dir, 'ttnet.node');
  return fs.existsSync(file) ? file : '';
})();

let ttnet = null;
if (metasecOk && engineOk && ttnetModule) {
  try { ttnet = require2(ttnetModule); } catch (_) {}
}

function readCookies() {
  try {
    return execSync(
      `sqlite3 "${CLIENT_DATA.cookies}" "SELECT name || '=' || value FROM cookies WHERE host_key IN ('.qishui.com','.bytedance.com');"`,
      { encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean).join('; ');
  } catch (_) { return ''; }
}

function deviceParams() {
  // Same identity the client itself uses (from its API query strings).
  return { deviceid: '2433637762995168', installid: '1167019340224857' };
}

let ready = false;
if (ttnet) {
  try {
    const store = path.join(os.tmpdir(), 'qsyy-ttnet');
    fs.rmSync(store, { recursive: true, force: true });
    fs.mkdirSync(store, { recursive: true });
    const dev = deviceParams();
    ttnet.initTTNet({
      appName: 'SodaMusic', appID: 386088, channel: 'official',
      versionCode: '30060000', deviceID: dev.deviceid,
      devicePlatform: PLATFORM === 'darwin' ? 'MacOS' : 'PC',
      deviceType: PLATFORM === 'darwin' ? 'Mac' : 'PC',
      isMainProcess: true, storagePath: store,
      useInjectMode: false,               // own global context instead of waiting for the client's network service
      domainHttpDns: 'httpdns.volcengine.com',
      domainBOE: 'boe.bytedance.com',
      domainNetlog: 'log.qishui.com',
    });
    ready = true;
  } catch (_) {}
}

function engineRequest(url, method, headers, body) {
  return new Promise(resolve => {
    let acc = '';
    let status = 0;
    const timer = setTimeout(() => resolve({ status: 0, body: '' }), 15000);
    try {
      ttnet.request({ url, method, headers, body: body || undefined }, {
        onEvent: ev => {
          if (ev.type === 'response') status = ev.statusCode;
          else if (ev.type === 'data') acc += typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
          else if (ev.type === 'end') { clearTimeout(timer); resolve({ status, body: acc }); }
          else if (ev.type === 'error') { clearTimeout(timer); resolve({ status, body: '' }); }
        },
      });
    } catch (e) { clearTimeout(timer); resolve({ status: 0, body: '' }); }
  });
}

function pickBestUrl(payload) {
  let model = payload?.track_player?.video_model;
  for (let depth = 0; depth < 3 && typeof model === 'string'; depth += 1) {
    try { model = JSON.parse(model); } catch (_) { model = null; }
  }
  let best = null;
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.main_url) {
      const bitrate = node.video_meta?.bitrate || 0;
      if (!best || bitrate > best.bitrate) {
        let url = String(node.main_url);
        if (!/^https?:\/\//.test(url)) { try { url = Buffer.from(url, 'base64').toString('utf8'); } catch (_) { return; } }
        if (/^https?:\/\//.test(url)) {
          // streams from the CDN are CENC-encrypted; the key material rides along
          const info = node.encrypt_info || {};
          best = {
            url, bitrate, quality: node.video_meta?.quality || '', size: node.video_meta?.size || 0,
            encrypted: Boolean(info.encrypt),
            method: info.encryption_method || '',
            spade: info.spade_a || '',
          };
        }
      }
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(model);
  if (!best) {
    // some responses keep play info on the track object instead
    const list = payload?.track?.audio_info?.play_info_list || payload?.track?.play_info_list || [];
    for (const item of list) {
      if (item.main_play_url && /^https?:\/\//.test(item.main_play_url) && (!best || (item.bitrate || 0) > best.bitrate)) {
        best = { url: item.main_play_url, bitrate: item.bitrate || 0, quality: item.quality || '', size: item.size || 0, encrypted: false, method: '', spade: '' };
      }
    }
  }
  return best;
}

async function resolveTrack(trackId) {
  if (!ready) return { ok: false, error: 'ttnet unavailable' };
  const cookie = readCookies();
  if (!cookie) return { ok: false, error: 'client not logged in' };
  const dev = deviceParams();
  const q = `aid=386088&app_version=3.6.0&channel=official&device_platform=MacOS&deviceid=${dev.deviceid}&installid=${dev.installid}&os=Darwin`;
  const r = await engineRequest(
    `https://api.qishui.com/luna/pc/track_v2?${q}&track_id=${trackId}&media_type=track`,
    'POST',
    { cookie, 'content-type': 'application/json' },
    JSON.stringify({ track_id: trackId, media_type: 'track', queue_type: 'favorite_track_playlist', scene_name: 'library' }),
  );
  if (process.env.TTNET_DEBUG) console.error('DEBUG track_v2:', r.status, r.body.length, 'B,', r.body.slice(0, 150));
  if (r.status !== 200 || !r.body) return { ok: false, error: `upstream ${r.status || 'error'}` };
  let payload = null;
  try { payload = JSON.parse(r.body); } catch (_) {}
  if (!payload?.track_player) {
    // risk-gated / restricted track (short payload without player data)
    return { ok: false, error: 'restricted' };
  }
  const best = pickBestUrl(payload);
  if (!best) return { ok: false, error: 'no stream url' };
  const effects = payload.track_player?.audio_effects || null;
  // entitlement gate: non-VIP accounts get ~60s streams for VIP tracks
  const trackSeconds = (payload.track?.duration || 0) / 1000;
  const streamSeconds = best.bitrate ? (best.size * 8) / best.bitrate : 0;
  const preview = trackSeconds > 30 && streamSeconds > 0 && streamSeconds < trackSeconds * 0.6;
  // LRC lyrics ride along in the same payload (content = "[mm:ss.xx] line" text)
  const lyric = payload.lyric?.content
    ? { content: payload.lyric.content, cn: payload.lyric?.translations?.cn || '' }
    : null;
  return { ok: true, ...best, effects, preview, lyric, name: payload.track?.name || '' };
}

// ---- line protocol ----
process.stdout.write(JSON.stringify({ ok: ready, cmd: 'hello', platform: PLATFORM }) + '\n');
let buffer = '';
let pending = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg = null;
    try { msg = JSON.parse(line); } catch (_) {}
    if (msg?.cmd === 'resolve' && msg.trackId) {
      pending += 1;
      resolveTrack(String(msg.trackId))
        .then(result => process.stdout.write(JSON.stringify({ cmd: 'resolve', trackId: msg.trackId, ...result }) + '\n'))
        .catch(error => process.stdout.write(JSON.stringify({ cmd: 'resolve', trackId: msg.trackId, ok: false, error: String(error?.message || error) }) + '\n'))
        .finally(() => { pending -= 1; });
    }
  }
});
process.stdin.on('end', () => {
  const exitWhenIdle = () => (pending === 0 ? process.exit(0) : setTimeout(exitWhenIdle, 100));
  exitWhenIdle();
});
