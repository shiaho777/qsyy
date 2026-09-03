// qsyy standalone app server.
// A self-contained local web app: browse your QiShui collections via the
// official API (session reused from the installed client), play tracks from
// the local LunaCacheV2 cache, and download/convert with the existing chain.
//
//   node app/standalone/server.mjs   →  http://127.0.0.1:18790
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_DATA, OS_CACHE_ROOT,
  findDeviceNode, findFfmpeg, cookieQueryCommand, openFolder, openClient,
} from './platform.mjs';

const require = createRequire(import.meta.url);
const { RestoreService } = require('../bridge/lib/restore-service.js');
const { DownloadEventBus } = require('../bridge/lib/events.js');
const { createLogger } = require('../bridge/lib/logger.js');
const { createRuntimeResolver } = require('../bridge/lib/runtime.js');

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const PORT = Number(process.env.QSYY_PORT || process.env.SODA_APP_PORT || 18790);
// 127.0.0.1 by default; QSYY_HOST=0.0.0.0 exposes the app on the LAN so
// phones / tablets (Android, iOS, any browser) can open the same UI.
const HOST = process.env.QSYY_HOST || '127.0.0.1';
const API_BASE = 'https://api.qishui.com';
const CACHE_DIR = process.env.QSYY_CACHE_DIR
  || path.join(CLIENT_DATA.cache, 'LunaCacheV2');
const DOWNLOAD_DIR = process.env.QSYY_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'qsyy');
const COOKIES_DB = process.env.QSYY_COOKIES_DB || CLIENT_DATA.cookies;
// 应用版本号(侧栏 GitHub 行展示 + 检查更新比对):桌面壳由 main.mjs 经
// QSYY_VERSION 注入 app.getVersion();源码运行读仓库 desktop/package.json;
// 兜底 'dev'(此时检查更新只报远端版本,不做新旧判定)。
const APP_VERSION = (() => {
  if (process.env.QSYY_VERSION) return process.env.QSYY_VERSION;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, '..', '..', 'desktop', 'package.json'), 'utf8'));
    if (pkg.version) return pkg.version;
  } catch (_) {}
  return 'dev';
})();
const APP_REPO = 'https://github.com/shiaho777/qsyy';
const RESTORE_SCRIPT = path.join(root, '..', 'bridge', 'restore_cache.js');
const LMDB_MODULE = path.join(root, '..', 'bridge', 'node_modules', 'lmdb');
const FFMPEG = findFfmpeg();
const DEVICE_NODE = findDeviceNode();
// Decrypted copies / lyrics / incremental stores live under the OS cache root.
const DECRYPT_DIR = path.join(OS_CACHE_ROOT, 'qsyy');
// One-time migration from the previous app name (SodaCollection).
try {
  const legacyDir = path.join(os.homedir(), 'Library', 'Caches', 'SodaCollection');
  if (fs.existsSync(legacyDir) && !fs.existsSync(DECRYPT_DIR)) fs.renameSync(legacyDir, DECRYPT_DIR);
} catch (_) {}

const logger = createLogger(path.join(root, '..', 'debug', 'qsyy.log'));
const events = new DownloadEventBus({ logger });

// Child processes run plain Node scripts. When this server lives inside the
// Electron desktop shell, process.execPath points at the Electron binary,
// which needs ELECTRON_RUN_AS_NODE=1 to behave as node — without it the
// binary swallows the script silently (exit 0, no output), so cache scans
// found nothing and the UI showed every track as uncached. Pure-node runs
// already have execPath=node; the extra env var is harmless there.
const CHILD_NODE_ENV = { ...process.env };
if (!CHILD_NODE_ENV.ELECTRON_RUN_AS_NODE && process.versions.electron) {
  CHILD_NODE_ENV.ELECTRON_RUN_AS_NODE = '1';
}

// ---------------------------------------------------------------- crash safety

// Process-level safety net: a stray exception (from a native callback, a
// malformed response, anywhere) must never take the server down — playback
// stops for every device on the LAN. Log, count, and keep serving; if errors
// storm (>60/min) restart is the honest option, so exit and let the
// supervisor / user relaunch.
let faultCount = 0;
let faultWindowAt = Date.now();
function recordFault(kind, error) {
  const now = Date.now();
  if (now - faultWindowAt > 60000) { faultWindowAt = now; faultCount = 0; }
  faultCount += 1;
  logger(`process-${kind}`, { message: error?.message || String(error), stack: error?.stack?.split('\n').slice(0, 4).join(' | ') || '' });
  if (faultCount > 60) {
    console.error(`[qsyy] ${kind} storm (${faultCount}/min) — exiting for clean restart`);
    process.exit(1);
  }
}
process.on('uncaughtException', error => recordFault('uncaught-exception', error));
process.on('unhandledRejection', error => recordFault('unhandled-rejection', error));

// ---------------------------------------------------------------- auth/session

const COMMON_QUERY = (() => {
  const configPath = path.join(root, 'device.json');
  let device = { deviceid: '2433637762995168', installid: '1167019340224857' };
  try { device = { ...device, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }; } catch (_) {}
  return new URLSearchParams({
    aid: '386088',
    app_version: '3.6.0',
    channel: 'official',
    device_platform: 'MacOS',
    os: 'Darwin',
    deviceid: device.deviceid,
    installid: device.installid,
  });
})();

let cookieCache = { value: '', at: 0 };
function sessionCookies(callback) {
  if (cookieCache.value && Date.now() - cookieCache.at < 120000) {
    callback(cookieCache.value);
    return;
  }
  const { cmd, args } = cookieQueryCommand(COOKIES_DB);
  execFile(cmd, args, { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
    if (!error) cookieCache = { value: stdout.trim().split('\n').filter(Boolean).join('; '), at: Date.now() };
    callback(cookieCache.value);
  });
}

// Keep-alive agents: a fresh TLS handshake used to precede every playlist
// page and image proxy call. Two pools so bulk CDN traffic can't evict the
// few API connections.
const apiAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });
const cdnAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });

// Short-TTL cache for idempotent GETs (playlists / playlist pages): paging
// around the UI and the 5-minute auto-sync then stop re-hitting the API.
// POSTs and `fresh=1` requests bypass it.
const apiGetCache = new Map(); // key → { status, json, at }
const API_GET_CACHE_MAX = 60;

function upstream(pathname, search = '', method = 'GET', body = null, ttlMs = 0) {
  return new Promise(resolveOuter => {
    const cacheKey = method === 'GET' && ttlMs > 0 ? `${pathname}?${search}` : null;
    if (cacheKey) {
      const hit = apiGetCache.get(cacheKey);
      if (hit && Date.now() - hit.at < ttlMs) { resolveOuter(hit); return; }
    }
    sessionCookies(cookie => {
      const url = new URL(pathname + (search ? `?${search}` : ''), API_BASE);
      for (const [key, value] of COMMON_QUERY) url.searchParams.set(key, value);
      if (search) for (const [key, value] of new URLSearchParams(search)) url.searchParams.set(key, value);
      const request = https.request(url, {
        method,
        agent: apiAgent,
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
          cookie,
          accept: 'application/json, text/plain, */*',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            const result = { status: response.statusCode, json: JSON.parse(text) };
            // cache only payloads that actually carry data: an auth-expired
            // 200 with an error/empty body must not poison the TTL cache
            const hasData = result.json && Object.keys(result.json).length > 0
              && result.json.code === undefined && result.json.status_code === undefined;
            if (cacheKey && result.status === 200 && hasData) {
              apiGetCache.set(cacheKey, { ...result, at: Date.now() });
              if (apiGetCache.size > API_GET_CACHE_MAX) apiGetCache.delete(apiGetCache.keys().next().value);
            }
            resolveOuter(result);
          } catch (_) { resolveOuter({ status: response.statusCode, json: null, text }); }
        });
      });
      request.on('error', error => resolveOuter({ status: 0, json: null, error: error?.message || String(error) }));
      if (body) request.write(JSON.stringify(body));
      request.end();
    });
  });
}

// ---------------------------------------------------------------- cache access

// LMDB entries.db snapshot shared by concurrent scans: copying the DB is the
// expensive part, so we keep one open snapshot for up to 10s and let every
// scan in that window reuse it (LMDB readers may share a file read-only).
const SCAN_SNAPSHOT_TTL = 10000;
let scanSnapshot = null; // { path, at, refs }
let scanSeq = 0;

function acquireScanSnapshot() {
  return new Promise(resolve => {
    if (scanSnapshot && Date.now() - scanSnapshot.at < SCAN_SNAPSHOT_TTL) {
      scanSnapshot.refs += 1;
      resolve(scanSnapshot);
      return;
    }
    if (scanSnapshot) {
      // expired but children may still read it; replace only when unused
      if (scanSnapshot.refs > 0) { scanSnapshot.refs += 1; resolve(scanSnapshot); return; }
      try { fs.unlinkSync(scanSnapshot.path); } catch (_) {}
      try { fs.unlinkSync(`${scanSnapshot.path}-lock`); } catch (_) {}
      scanSnapshot = null;
    }
    const snapshotPath = path.join(os.tmpdir(), `qsyy-scan-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    fs.copyFile(path.join(CACHE_DIR, 'entries.db'), snapshotPath, error => {
      if (error) { resolve(null); return; }
      scanSnapshot = { path: snapshotPath, at: Date.now(), refs: 1 };
      resolve(scanSnapshot);
    });
  });
}

function releaseScanSnapshot(snapshot) {
  snapshot.refs = Math.max(0, snapshot.refs - 1);
  // expired-and-unused snapshots (either replaced by a newer one or past TTL
  // with no successor) must not linger in tmpdir
  const expired = Date.now() - snapshot.at >= SCAN_SNAPSHOT_TTL;
  if (snapshot.refs === 0 && (scanSnapshot !== snapshot || expired)) {
    if (scanSnapshot === snapshot) scanSnapshot = null;
    try { fs.unlinkSync(snapshot.path); } catch (_) {}
    try { fs.unlinkSync(`${snapshot.path}-lock`); } catch (_) {}
  }
}

// A scan can only report what the client has written so far — the entries
// database doesn't change within seconds, so identical scans are collapsed
// into one shared child process (rapid play-switching used to spawn a copy +
// an LMDB reader per request and starve everything else).
// Scan results are cached well past the 5s dedupe window: a track's cached
// chunk basically never disappears mid-session (the client only adds), so
// 90s hits keep every replay/revisit at zero subprocess cost. Entries are
// invalidated implicitly by the janitor sweep.
const SCAN_CACHE_TTL = 90000;
const SCAN_DEDUPE_TTL = 5000;
const scanCache = new Map();   // key → { at, value }
const scanInflight = new Map(); // key → Promise

// Key MUST be derived from the raw argv array: extraArgs is an array, and
// indexing it by property name ('--track-ids') yields undefined — every scan
// used to share one cache slot, so one stale/empty result poisoned every
// track's cache-status (harmless at the old 5s TTL, severe at 90s).
function scanKey(extraArgs) {
  return extraArgs.join('|');
}

// Cache entries are stamped when their LMDB snapshot was taken; a single
// track probe may hit a stale batch (missing the newest chunk), so results
// from an older snapshot are re-scanned once when explicitly probed.
function runScan(extraArgs) {
  const key = scanKey(extraArgs);
  const cached = scanCache.get(key);
  if (cached && Date.now() - cached.at < SCAN_CACHE_TTL) return Promise.resolve(cached.value);
  if (scanCache.size > 400) {
    // hard cap: each entry is a batch result; unbounded growth on long
    // sessions of browsing many playlists is the only leak path
    for (const [k, v] of scanCache) {
      if (Date.now() - v.at >= SCAN_CACHE_TTL) scanCache.delete(k);
    }
    while (scanCache.size > 400) scanCache.delete(scanCache.keys().next().value);
  }
  const inflight = scanInflight.get(key);
  if (inflight) return inflight;
  const promise = (async () => {
    // a snapshot copied while the client writes entries.db can be unreadable
    // (LMDB aborts the open) — retry with a fresh snapshot before giving up;
    // a bare null here used to surface as a bogus "not cached" 404
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await acquireScanSnapshot();
      if (!snapshot) { await new Promise(r => setTimeout(r, 300 * (attempt + 1))); continue; }
      const seq = ++scanSeq;
      try {
        const value = await new Promise(resolve => {
          const child = spawn(process.execPath, [
            RESTORE_SCRIPT, '--scan-child',
            '--snapshot', snapshot.path,
            '--lmdb-module', LMDB_MODULE,
            '--cache-dir', CACHE_DIR,
            '--quality', 'highest',
            ...extraArgs,
          ], { stdio: ['ignore', 'pipe', 'ignore'], env: CHILD_NODE_ENV });
          let output = '';
          const done = value => {
            try { child.kill(); } catch (_) {}
            resolve(value);
          };
          const timer = setTimeout(() => done(null), 30000);
          child.stdout.on('data', d => { output += d.toString(); });
          child.on('error', () => { clearTimeout(timer); done(null); });
          child.on('close', () => {
            clearTimeout(timer);
            try {
              const lines = output.trim().split(/\r?\n/).filter(Boolean);
              done(lines.length ? JSON.parse(lines[lines.length - 1]) : null);
            } catch (_) { done(null); }
          });
          if (process.env.QSYY_DEBUG) console.error(`[qsyy] scan #${seq} → ${key.slice(0, 80)}`);
        });
        if (value !== null) return value;
        // null child result on a fresh snapshot: retry with a new one
        releaseScanSnapshot(snapshot);
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        continue;
      } catch (_) {
        releaseScanSnapshot(snapshot);
      }
    }
    return null;
  })();
  scanInflight.set(key, promise);
  promise.then(
    value => {
      scanInflight.delete(key);
      if (value !== null) scanCache.set(key, { at: Date.now(), value });
    },
    () => scanInflight.delete(key),
  );
  return promise;
}

// janitors merged into one 5-min sweep: a 5s timer woke the loop ~17k/hour
// to delete entries that stay valid for 90s anyway; lazy TTL checks at read
// time make correctness independent of the sweep
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of scanCache) {
    if (now - entry.at >= SCAN_CACHE_TTL) scanCache.delete(key);
  }
  for (const [id, hit] of ttnetCache) {
    if (now - hit.at >= (hit.result.ok ? 20 : 1) * 60 * 1000) ttnetCache.delete(id);
  }
  for (const [id, hit] of onlineCache) {
    if (now - hit.at >= 25 * 60 * 1000) onlineCache.delete(id);
  }
}, 300000).unref();


const scanTrack = trackId => runScan(['--track-id', String(trackId)]);
const scanTracks = trackIds => runScan(['--track-ids', trackIds.join(',')]);

// Keep one warm scan child pre-forked? Not possible with the snapshot-copy
// model; instead, pre-warm the snapshot itself at boot so the first scan
// after launch pays only the child spawn, not the DB copy.
acquireScanSnapshot().then(snapshot => { if (snapshot) releaseScanSnapshot(snapshot); }).catch(() => {});

// ---------------------------------------------------------------- downloads

const restoreService = new RestoreService({
  runtime: createRuntimeResolver(),
  events,
  logger,
  timeoutMs: 180000,
});

const downloadJobs = new Map();
const jobsHistoryPath = path.join(root, '..', 'debug', 'qsyy-jobs.json');
try {
  // one-time rename from the previous history file name
  const legacyJobs = path.join(root, '..', 'debug', 'standalone-jobs.json');
  if (!fs.existsSync(jobsHistoryPath) && fs.existsSync(legacyJobs)) fs.renameSync(legacyJobs, jobsHistoryPath);
} catch (_) {}
try {
  const saved = JSON.parse(fs.readFileSync(jobsHistoryPath, 'utf8'));
  for (const job of Array.isArray(saved) ? saved.slice(-100) : []) {
    if (job?.jobId) downloadJobs.set(job.jobId, { ...job, frozen: true });
  }
} catch (_) {}
let jobsSaveTimer = null;
function persistJobs() {
  clearTimeout(jobsSaveTimer);
  jobsSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(jobsHistoryPath), { recursive: true });
      fs.writeFileSync(jobsHistoryPath, JSON.stringify([...downloadJobs.values()].slice(-100), null, 1));
    } catch (_) {}
  }, 1500);
}

// ------------------------------------------------------------------ lyrics parsing

// The client ships karaoke LRC: every line is "[startMs,durMs]" followed by
// per-word tags "<offsetMs,durMs,0>word", offsets relative to the line start.
// Translations (`cn`) are a plain LRC block whose timestamps match the original
// lines exactly — pair them by ms, never by an invented offset.
const WORD_TAG_RE = /<(\d+),(\d+)(?:,\d+)?>([^<]*)/g;
const LRC_STAMP_RE = /^\[(\d+):(\d+)(?:[.:](\d+))?\]/;

function lrcStamp(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function parseLrcBlock(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const m = raw.match(LRC_STAMP_RE);
    if (!m) continue;
    const ms = Number(m[1]) * 60000 + Number(m[2]) * 1000 + (m[3] ? Number(m[3].padEnd(3, '0')) : 0);
    const body = raw.replace(/^\[[^\]]*\]/, '').trim();
    if (body) out.push({ ms, text: body });
  }
  return out;
}

// → { v, name, lines: [{ ms, dur, text, cn?, words?: [{ t, d, w }] }], lrc }
function buildLyrics(resolved) {
  const content = resolved?.lyric?.content;
  if (!content) return null;
  const lines = [];
  for (const raw of content.split('\n')) {
    const head = raw.match(/^\[(\d+),(\d+)\]/);
    if (head) {
      const start = Number(head[1]);
      const dur = Number(head[2]);
      const body = raw.slice(head[0].length);
      const words = [];
      WORD_TAG_RE.lastIndex = 0;
      let m;
      while ((m = WORD_TAG_RE.exec(body))) {
        if (!m[3]) continue;
        words.push({ t: start + Number(m[1]), d: Number(m[2]), w: m[3] });
      }
      const text = words.length
        ? words.map(w => w.w).join('').trim()
        : body.replace(/<\d+,\d+(?:,\d+)?>/g, '').trim();
      if (!text) continue;
      lines.push({ ms: start, dur, text, words: words.length ? words : null });
      continue;
    }
    // some tracks ship plain [mm:ss.xx] LRC instead of the karaoke form
    const stamp = raw.match(LRC_STAMP_RE);
    if (stamp) {
      const ms = Number(stamp[1]) * 60000 + Number(stamp[2]) * 1000 + (stamp[3] ? Number(stamp[3].padEnd(3, '0')) : 0);
      const text = raw.replace(/^\[[^\]]*\]/, '').trim();
      if (text) lines.push({ ms, dur: 0, text, words: null });
    }
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a.ms - b.ms);

  const cn = parseLrcBlock(resolved.lyric.cn);
  const cnByMs = new Map(cn.map(l => [l.ms, l.text]));
  for (let i = 0; i < lines.length; i += 1) {
    const hit = cnByMs.get(lines[i].ms);
    if (hit) { lines[i].cn = hit; continue; }
    if (cn.length === lines.length && cn[i]) lines[i].cn = cn[i].text;
  }

  const lrc = lines
    .map(l => (l.cn ? `[${lrcStamp(l.ms)}]${l.text}\n[${lrcStamp(l.ms)}]${l.cn}` : `[${lrcStamp(l.ms)}]${l.text}`))
    .join('\n');
  return { v: 2, name: resolved.name || '', lines, lrc };
}

function writeLyricsCache(trackId, built) {
  const lyricsDir = path.join(DECRYPT_DIR, 'lyrics');
  try {
    fs.mkdirSync(lyricsDir, { recursive: true });
    fs.writeFileSync(path.join(lyricsDir, `${trackId}.json`), JSON.stringify(built));
    fs.writeFileSync(path.join(lyricsDir, `${trackId}.lrc`), `${built.lrc}\n`);
  } catch (_) {}
}

// Best-effort lyrics for a download job: reuse the on-disk lyrics cache,
// otherwise resolve via ttnet once. Returns '' when unavailable.
async function lyricsForDownload(trackId) {
  const lyricsDir = path.join(DECRYPT_DIR, 'lyrics');
  try {
    const cached = JSON.parse(fs.readFileSync(path.join(lyricsDir, `${trackId}.json`), 'utf8'));
    if (cached?.lrc) return cached.lrc;
  } catch (_) {}
  try {
    const resolved = await ttnetResolve(trackId);
    const built = buildLyrics(resolved);
    if (!built) return '';
    writeLyricsCache(trackId, built);
    return built.lrc;
  } catch (_) {
    return '';
  }
}

async function startDownload({ trackId, title, artist, album, quality, outputFormat, coverData }) {
  let jobId = '';
  try {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    jobId = `app-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const job = {
      jobId, trackId: String(trackId), title: title || '', artist: artist || '', album: album || '',
      quality: quality || 'highest', outputFormat: outputFormat || 'source',
      status: 'downloading', progress: 0, phase: '准备恢复缓存', error: '', output: '', startedAt: Date.now(),
    };
    downloadJobs.set(jobId, job);
  const lyricsText = await lyricsForDownload(String(trackId));
  restoreService.restore({
    jobId,
    trackId: String(trackId),
    quality: quality || 'highest',
    outputDir: DOWNLOAD_DIR,
    title: title || 'unknown',
    artist: artist || '',
    album: album || '',
    lyricsEnabled: Boolean(lyricsText),
    lyricsText,
    coverData: coverData || '',
    outputFormat: outputFormat || 'source',
    audioUrls: [],
  }).then(result => {
    Object.assign(job, { status: 'completed', progress: 100, phase: '下载完成', output: result?.output || '' });
    persistJobs();
  }).catch(error => {
    const waiting = error?.waiting === true;
    Object.assign(job, {
      status: waiting ? 'waiting' : 'failed',
      phase: waiting ? '等待缓存生成' : '下载失败',
      error: error?.message || String(error),
    });
    persistJobs();
  });
  return job;
  } catch (error) {
    // bad input / fs failure: record the failure instead of blowing up the caller
    logger('download-start-failed', { trackId, message: error?.message || String(error) });
    const job = {
      jobId: jobId || `app-${Date.now()}-err`, trackId: String(trackId || ''), title: title || '',
      artist: artist || '', album: album || '', quality: quality || 'highest',
      outputFormat: outputFormat || 'source', status: 'failed', progress: 0,
      phase: '下载失败', error: error?.message || String(error), output: '', startedAt: Date.now(),
    };
    if (job.jobId) downloadJobs.set(job.jobId, job);
    return job;
  }
}

// wire event bus into job records by jobId; download activity also flips the
// dirty flags that gate /api/progress-stream pushes
const progressWakers = new Set();
const originalPublish = events.publish.bind(events);
events.publish = (type, input, jobId, payload) => {
  const job = downloadJobs.get(jobId);
  if (job) Object.assign(job, payload, { jobId });
  originalPublish(type, input, jobId, payload);
  persistJobs();
  for (const wake of progressWakers) wake();
};

// ---------------------------------------------------------------- streaming

// ------------------------------------------------------------ decrypt concurrency

// Spawning a decrypt child per stream request used to stampede the machine
// (each one loads LMDB + device.node + ffmpeg). Cap it and deduplicate by
// trackId so switching songs quickly cancels nothing but never doubles work.
const DECRYPT_MAX_CONCURRENT = 2;
let decryptActive = 0;
const decryptWaiters = [];
const decryptInflight = new Map(); // trackId → Promise<path>

async function acquireDecryptSlot() {
  if (decryptActive < DECRYPT_MAX_CONCURRENT) {
    decryptActive += 1;
    return;
  }
  await new Promise(resolve => decryptWaiters.push(resolve));
  decryptActive += 1;
}

function releaseDecryptSlot() {
  decryptActive = Math.max(0, decryptActive - 1);
  const next = decryptWaiters.shift();
  if (next) next();
}

// Successful decrypts, by cache chunk id: the m4a already sits in DECRYPT_DIR
// keyed by chunkId, so a repeat stream of the same file skips the LMDB +
// device.node + ffmpeg child entirely.
const decryptedChunkCache = new Map(); // chunkId → m4a path

function decryptForStreaming(trackId) {
  const existing = decryptInflight.get(trackId);
  if (existing) return existing;
  const promise = (async () => {
    await acquireDecryptSlot();
    try {
      fs.mkdirSync(DECRYPT_DIR, { recursive: true });
      return await new Promise(resolve => {
        const child = spawn(process.execPath, [
          RESTORE_SCRIPT,
          '--cache-dir', CACHE_DIR,
          '--output-dir', DECRYPT_DIR,
          '--lmdb-module', LMDB_MODULE,
          '--device-node', DEVICE_NODE,
          '--ffmpeg', FFMPEG,
          '--quality', 'highest',
          '--wait-ms', '5000',
          '--track-id', String(trackId),
        ], { stdio: ['ignore', 'pipe', 'ignore'], env: CHILD_NODE_ENV });
        let output = '';
        child.stdout.on('data', d => { output += d.toString(); });
        const timer = setTimeout(() => { try { child.kill(); } catch (_) {} resolve(''); }, 120000);
        child.on('close', () => {
          clearTimeout(timer);
          try {
            const lines = output.trim().split(/\r?\n/).filter(Boolean);
            const result = JSON.parse(lines[lines.length - 1]);
            const restored = result?.output || '';
            if (result?.ok && restored && fs.existsSync(restored)) {
              const target = path.join(DECRYPT_DIR, `${result.chunkId}.m4a`);
              if (restored !== target) fs.renameSync(restored, target);
              decryptedChunkCache.set(result.chunkId, target);
              resolve(target);
              return;
            }
          } catch (_) {}
          resolve('');
        });
        child.on('error', () => { clearTimeout(timer); resolve(''); });
      });
    } finally {
      releaseDecryptSlot();
      decryptInflight.delete(trackId);
    }
  })();
  decryptInflight.set(trackId, promise);
  return promise;
}

function serveStream(request, response, file) {
  let stat;
  try { stat = fs.statSync(file); } catch (_) { response.writeHead(404).end('not found'); return; }
  const range = request.headers.range;
  const headers = {
    'content-type': 'audio/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  let start = 0;
  let end = stat.size - 1;
  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    start = match && match[1] ? Number(match[1]) : 0;
    end = match && match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) {
      response.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end();
      return;
    }
    response.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'content-length': end - start + 1,
    });
  } else {
    response.writeHead(200, { ...headers, 'content-length': stat.size });
  }
  // 256KB highWaterMark: audio streams ride in larger chunks → fewer syscalls
  // and fewer buffer allocations per second than the 64KB default
  const stream = fs.createReadStream(file, { start, end, highWaterMark: 262144 });
  stream.on('error', () => { try { response.destroy(); } catch (_) {} });
  response.on('close', () => stream.destroy()); // caller gone → stop reading
  stream.pipe(response);
}

function proxyImage(url, response) {
  try {
    const target = new URL(url);
    if (!/douyinpic\.com|bytedanceapi|snssdk/.test(target.hostname)) {
      response.writeHead(403).end();
      return;
    }
    https.get(target, { headers: { 'user-agent': 'Mozilla/5.0' }, agent: cdnAgent }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode || 502, {
        'content-type': upstreamResponse.headers['content-type'] || 'image/jpeg',
        'cache-control': 'public, max-age=86400',
      });
      upstreamResponse.pipe(response);
    }).on('error', () => response.writeHead(502).end());
  } catch (_) {
    response.writeHead(400).end();
  }
}

// ---------------------------------------------------------------- ttnet client-session playback (zero login)

// Resident ttnet-helper subprocess: resolves play URLs through the client's
// own signed network stack (mssdk), using the client's session. Crashes are
// contained (native CHECK failures kill only the helper; we respawn on demand).
let ttnetChild = null;
const ttnetWaiters = [];
const ttnetCache = new Map(); // trackId → { result, at }

function ttnetHealthy() {
  return ttnetChild && !ttnetChild.killed && ttnetChild.exitCode === null;
}

// Cheap probe for the status endpoint: a healthy helper that said hello means
// the client-session path is available. Doesn't hit the API on every poll.
let ttnetProbeAt = 0;
let ttnetProbeOk = false;
async function ttnetResolveProbe() {
  if (Date.now() - ttnetProbeAt < 60000) return ttnetProbeOk;
  ttnetProbeAt = Date.now();
  if (!ttnetHealthy()) spawnTtnetHelper();
  for (let i = 0; i < 40; i += 1) {
    if (ttnetChild?.__ready) break;
    await new Promise(r => setTimeout(r, 100));
  }
  ttnetProbeOk = Boolean(ttnetChild?.__ready);
  return ttnetProbeOk;
}

function spawnTtnetHelper() {
  const child = spawn(process.execPath, [path.join(root, 'ttnet-helper.mjs')], { stdio: ['pipe', 'pipe', 'ignore'], env: CHILD_NODE_ENV });
  ttnetChild = child;
  child.stdout.setEncoding('utf8');
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.cmd === 'hello') child.__ready = Boolean(msg.ok);
        if (msg.cmd === 'resolve') {
          const waiter = ttnetWaiters.shift();
          if (waiter) waiter(msg);
        }
      } catch (_) {}
    }
  });
  child.on('error', error => {
    // spawn/ENOENT etc: fail everyone waiting on this child, don't crash
    recordFault('ttnet-spawn-error', error);
    failAllTtnetWaiters('helper spawn failed');
    ttnetChild = null;
  });
  child.on('exit', () => {
    // a native CHECK failure or stdin close must not strand queued waiters —
    // they would each hang for their full 20s timeout otherwise
    if (ttnetChild === child) ttnetChild = null;
    failAllTtnetWaiters('helper exited');
  });
  return child;
}

// Reject every pending waiter (their promise resolves null → caller falls
// back to the web-session path or reports unavailable).
function failAllTtnetWaiters(reason) {
  while (ttnetWaiters.length) {
    const waiter = ttnetWaiters.shift();
    try { waiter({ ok: false, error: reason }); } catch (_) {}
  }
}

const killTtnetHelper = () => { try { ttnetChild?.kill(); } catch (_) {} };
process.on('exit', killTtnetHelper);
process.on('SIGTERM', () => { killTtnetHelper(); process.exit(0); });
process.on('SIGINT', () => { killTtnetHelper(); process.exit(0); });

// ttnetBusy is a lock around the single-flight resolve; the old polling wait
// (up to 25s) could livelock if an exception path ever skipped the reset.
// A proper FIFO queue can't deadlock: every settle path clears the flag.
let ttnetBusy = false;
const ttnetTurnQueue = [];
async function acquireTtnetTurn() {
  if (!ttnetBusy) { ttnetBusy = true; return; }
  await new Promise(resolve => ttnetTurnQueue.push(resolve));
  ttnetBusy = true;
}
function releaseTtnetTurn() {
  ttnetBusy = false;
  const next = ttnetTurnQueue.shift();
  if (next) next(); // the woken turn re-locks in acquireTtnetTurn
}

async function ttnetResolve(trackId) {
  const hit = ttnetCache.get(trackId);
  if (hit && Date.now() - hit.at < (hit.result.ok ? 20 : 1) * 60 * 1000) return hit.result.ok ? hit.result : null;
  await acquireTtnetTurn();
  try {
    let child = ttnetChild;
    if (!ttnetHealthy()) child = spawnTtnetHelper();
    if (!child) return null;
    for (let i = 0; i < 40 && !child.__ready; i += 1) await new Promise(r => setTimeout(r, 100));
    if (!child.__ready) return null;
    const result = await new Promise(resolve => {
      const waiter = msg => { clearTimeout(timer); resolve(msg); };
      const timer = setTimeout(() => {
        const idx = ttnetWaiters.indexOf(waiter);
        if (idx >= 0) ttnetWaiters.splice(idx, 1);
        console.error('[ttnet] resolve timeout', trackId, 'ready=', Boolean(child.__ready));
        resolve(null);
      }, 20000);
      ttnetWaiters.push(waiter);
      try {
        child.stdin.write(JSON.stringify({ cmd: 'resolve', trackId: String(trackId) }) + '\n');
      } catch (error) {
        // EPIPE: the helper died between the health check and the write
        clearTimeout(timer);
        const idx = ttnetWaiters.indexOf(waiter);
        if (idx >= 0) ttnetWaiters.splice(idx, 1);
        resolve(null);
      }
    });
    if (process.env.QSYY_DEBUG || process.env.SODA_DEBUG) console.error('[ttnet] resolve', trackId, JSON.stringify({ ok: result?.ok, error: result?.error }));
    const settled = result || { ok: false, error: 'no-response' };
    ttnetCache.set(trackId, { result: settled, at: Date.now() });
    // a successful resolve carries the lyrics payload — persist it right away
    // so opening the lyrics panel later is served from disk instantly instead
    // of serializing behind the per-track resolve busy-loop
    if (settled.ok && settled.lyric?.content) {
      try {
        const built = buildLyrics(settled);
        if (built) writeLyricsCache(trackId, built);
      } catch (_) {}
    }
    return settled;
  } finally {
    releaseTtnetTurn();
  }
}

// ---------------------------------------------------------------- web session (QR login → online playback)

// The desktop client's cookies are rejected by /luna/pc/track_v2 (play URLs);
// that endpoint only answers a *web* session, obtained via passport QR login.
// We create the QR, the user scans it once with the mobile app, and we keep
// the resulting cookies here. Fully standalone — the client is never touched.
const WEB_SESSION_FILE = path.join(root, 'web-session.json');
const PASSPORT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SodaMusic/3.1.0 Chrome/136.0.7103.59 Electron/36.4.0-rs.22.release.main.1 TTElectron/36.4.0-rs.22.release.main.1 Safari/537.36';

let webSession = null;
try { webSession = JSON.parse(fs.readFileSync(WEB_SESSION_FILE, 'utf8')); } catch (_) {}

function saveWebSession(cookieMap) {
  const keep = ['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt', 'uid_tt', 'uid_tt_ss', 'ssid_ucp_v1', 'sid_ucp_v1', 'passport_csrf_token', 'ttwid', 'odin_tt', 'n_mh', 'passport_assist_user', 'session_tlb_tag', 'uid'];
  const filtered = {};
  for (const name of keep) if (cookieMap[name]) filtered[name] = cookieMap[name];
  if (!filtered.sessionid) return false;
  webSession = { cookie: Object.entries(filtered).map(([k, v]) => `${k}=${v}`).join('; '), savedAt: Date.now() };
  fs.writeFileSync(WEB_SESSION_FILE, JSON.stringify(webSession, null, 2));
  onlineCache.clear();
  return true;
}

function passportQuery(extra = {}) {
  const now = String(Date.now());
  const params = [
    ['passport_jssdk_version', '2.4.13'], ['passport_jssdk_type', 'normal'], ['is_from_ttaccountsdk', '1'],
    ['aid', '386088'], ['language', 'zh'], ['account_sdk_source', 'web'], ['account_sdk_source_info', ''],
    ['p_js_v', '2.4.13'], ['p_js_t', 'pro'], ['p_zt', '3.3.5'], ['p_ver', '1.0.29'],
    ['request_host', 'app%3A%2F%2Fresources'], ['p_bd', '1.0.0.41'],
    ['biz_trace_id', String(Date.now() + Math.floor(Math.random() * 1000))],
    ['is_new_login', '1'], ['is_from_iesaccountsaas', '1'],
    ['device_id', now], ['install_id', String(Date.now() + 1)], ['did', now], ['iid', String(Date.now() + 1)],
    ['device_platform', 'PC'], ['version_code', '3.3.0'],
    ...Object.entries(extra),
  ];
  return params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

const PASSPORT_HEADERS = {
  'user-agent': PASSPORT_UA,
  'accept': 'application/json, text/javascript',
  'bd-ticket-guard-version': '2',
  'bd-ticket-guard-iteration-version': '2',
  'bd-ticket-guard-ree-public-key': 'BAnIxKL96Jby5x+Um9i7HZ2c8O6lfZJRxm6yk73Mqcr06l2qIw2iqu2Mtm3U/6OI98usukA9dqxUlsctVWK9rKA=',
  'bd-ticket-guard-server-cert-sn': '0',
};

function collectCookies(setCookieHeaders, into = {}) {
  for (const raw of setCookieHeaders || []) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) into[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return into;
}

const qrPending = new Map(); // token → { cookies }

async function createQrLogin() {
  const search = passportQuery({ next: 'https://api.qishui.com', need_logo: 'false', need_short_url: 'false', is_frontier: 'true' });
  const result = await new Promise(resolve => {
    https.get(`${API_BASE}/passport/web/get_qrcode/?${search}`, { headers: PASSPORT_HEADERS }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const cookies = collectCookies(res.headers['set-cookie']);
        try { resolve({ status: res.statusCode, cookies, json: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (_) { resolve({ status: res.statusCode, cookies, json: null }); }
      });
    }).on('error', () => resolve({ status: 0, cookies: {}, json: null }));
  });
  const data = result.json?.data || {};
  if (!data.token) throw new Error(result.json?.message || `get_qrcode failed (${result.status})`);
  qrPending.set(data.token, { cookies: result.cookies });
  setTimeout(() => qrPending.delete(data.token), 10 * 60 * 1000);
  return { token: data.token, qrcode: data.qrcode || '', url: data.qrcode_index_url || data.web_url || '' };
}

async function pollQrLogin(token) {
  const pending = qrPending.get(token);
  if (!pending) return { status: 'expired', message: '二维码已过期,请重新生成' };
  const search = passportQuery();
  const form = new URLSearchParams({ need_logo: 'false', need_short_url: 'false', is_frontier: 'true', token, is_new_login: '1', next: 'https://api.qishui.com' });
  const result = await new Promise(resolve => {
    const req = https.request(`${API_BASE}/passport/web/check_qrconnect/?${search}`, {
      method: 'POST',
      headers: { ...PASSPORT_HEADERS, 'content-type': 'application/x-www-form-urlencoded', cookie: Object.entries(pending.cookies).map(([k, v]) => `${k}=${v}`).join('; ') },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const cookies = collectCookies(res.headers['set-cookie']);
        try { resolve({ status: res.statusCode, cookies, json: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (_) { resolve({ status: res.statusCode, cookies, json: null }); }
      });
    });
    req.on('error', () => resolve({ status: 0, cookies: {}, json: null }));
    req.end(form.toString());
  });
  const data = result.json?.data || {};
  if (data.error_code === 7) return { status: 'waiting', message: '等待中' };
  const merged = { ...pending.cookies, ...result.cookies };
  if (merged.sessionid && saveWebSession(merged)) {
    qrPending.delete(token);
    return { status: 'success', message: '登录成功' };
  }
  const status = String(data.status || '').toLowerCase();
  if (status === 'confirmed' || status === 'scanned') return { status: 'scanned', message: '已扫码,请在手机上确认' };
  if (status === 'new' || status === '') return { status: 'waiting', message: '等待扫码' };
  if (status === 'expired') { qrPending.delete(token); return { status: 'expired', message: '二维码已过期' }; }
  return { status: 'waiting', message: result.json?.message || '等待扫码' };
}

// Resolve an online play URL for a track via the web track_v2 endpoint.
// The CDN URL embeds signed params, so playback is proxied through us.
const onlineCache = new Map(); // trackId → { info, at }

async function resolveOnlineTrack(trackId) {
  const hit = onlineCache.get(trackId);
  if (hit && Date.now() - hit.at < 25 * 60 * 1000) return hit.info;
  if (!webSession?.cookie) return null;
  const result = await new Promise(resolve => {
    https.get(`${API_BASE}/luna/pc/track_v2?track_id=${trackId}&media_type=track&aid=386088&device_platform=web&channel=pc_web`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'referer': 'https://luna-web.douyin.com/',
        cookie: webSession.cookie,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
        catch (_) { resolve({ status: res.statusCode, json: null, text }); }
      });
    }).on('error', () => resolve({ status: 0, json: null }));
  });
  if (result.status !== 200 || !result.json) return null;
  const track = result.json?.track_player?.track
    || result.json?.data?.track_player?.track
    || result.json?.track
    || result.json?.data?.track;
  const candidates = [];
  const push = (rawUrl, quality, format, bitrate, size) => {
    if (!rawUrl) return;
    let url = String(rawUrl).trim();
    if (!/^https?:\/\//.test(url)) {
      try { url = Buffer.from(url, 'base64').toString('utf8'); } catch (_) { return; }
      if (!/^https?:\/\//.test(url)) return;
    }
    candidates.push({ url, quality: quality || '', format: format || 'm4a', bitrate: bitrate || 0, size: size || 0 });
  };
  for (const item of track?.audio_info?.play_info_list || []) {
    push(item.main_play_url, item.quality, item.format, item.bitrate, item.size);
  }
  for (const item of track?.play_info_list || []) {
    push(item.main_play_url, item.quality, item.format, item.bitrate, item.size);
  }
  // video_model arrives as a JSON string (sometimes double-encoded);
  // walk it for any stream entries
  let model = result.json?.track_player?.video_model ?? result.json?.data?.track_player?.video_model;
  for (let depth = 0; depth < 3 && typeof model === 'string'; depth += 1) {
    try { model = JSON.parse(model); } catch (_) { model = null; break; }
  }
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.main_url || node.main_play_url) {
      push(node.main_url || node.main_play_url, node.video_meta?.quality || node.quality, 'm4a', node.video_meta?.bitrate || node.bitrate, node.video_meta?.size || node.size);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(model);
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  const info = { ...candidates[0], trackId };
  onlineCache.set(trackId, { info, at: Date.now() });
  return info;
}

// Online playback cache: CDN streams are CENC-encrypted; downloads go into a
// Downloads go into a persistent, resumable store; once complete we decrypt to
// a faststart M4A and keep it — next session the track plays instantly and
// shows the same 缓存 badge as client-cached songs.
// Cache store, organized as switchable named sets under stores/:
//   stores/<name>/{<trackId>.m4a,.json,.part}
// imports arrive as new sets; switching swaps the active one.
const STORES_ROOT = path.join(DECRYPT_DIR, 'stores');
const ACTIVE_STORE_FILE = path.join(DECRYPT_DIR, 'active-store.json');
let STORE_DIR = path.join(STORES_ROOT, 'default');
const storeMeta = new Map();        // trackId → { size, downloaded, spade, complete }
const setNameOk = name => /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 -]{0,31}$/.test(name) && !/[\/]/.test(name);

(function initStores() {
  try {
    fs.mkdirSync(STORES_ROOT, { recursive: true });
    const legacy = path.join(DECRYPT_DIR, 'online');
    if (fs.existsSync(legacy) && !fs.existsSync(path.join(STORES_ROOT, 'default'))) {
      try { fs.renameSync(legacy, path.join(STORES_ROOT, 'default')); } catch (_) {}
    }
    let active = 'default';
    try { active = JSON.parse(fs.readFileSync(ACTIVE_STORE_FILE, 'utf8')).name || 'default'; } catch (_) {}
    if (setNameOk(active) && fs.existsSync(path.join(STORES_ROOT, active))) STORE_DIR = path.join(STORES_ROOT, active);
    else active = 'default';
    try { fs.writeFileSync(ACTIVE_STORE_FILE, JSON.stringify({ name: path.basename(STORE_DIR) })); } catch (_) {}
  } catch (_) {}
})();

function activeStoreName() { return path.basename(STORE_DIR); }

function switchStore(name) {
  STORE_DIR = path.join(STORES_ROOT, name);
  try { fs.mkdirSync(STORE_DIR, { recursive: true }); } catch (_) {}
  try { fs.writeFileSync(ACTIVE_STORE_FILE, JSON.stringify({ name })); } catch (_) {}
  downloadQueue.length = 0;
  storeMeta.clear();
  loadStoreMeta();
}
const downloadQueue = [];           // { trackId, resolve }
const effectConfigs = new Map();     // configUrl → parsed DSP chain (capped; each config is a few KB)
function cacheEffectConfig(url, config) {
  effectConfigs.set(url, config);
  if (effectConfigs.size > 24) effectConfigs.delete(effectConfigs.keys().next().value);
}

// 官方音效目录(与客户端 lottieRegistry 的 effect 键一致);
// DSP 链与 track_v2 下发的智能音效配置同构,由前端 Web Audio 统一渲染
const EQ = (t, f, q, g) => `${t},${f},${q},${g}`;
const PRESET_EFFECTS = [
  { key: 'bass_enhance', name: '超重低音', config: { chains: [{ enable: true, modes: ['normal'], name: 'chain_normal', nodes: [
    { type: 'gain', enable: true, gain_db: -2.5 },
    { type: 'equalizer', enable: true, band_num: 5, use_preset: 'custom', presets: [{ name: 'custom', enable: true, band_params: [
      EQ('LowShelf', 45, 0.9, 8.5), EQ('Peaking', 90, 1.0, 5), EQ('Peaking', 200, 1.2, -2), EQ('Peaking', 3000, 1.4, 1.5), EQ('HighShelf', 10000, 1.2, 1) ] }] },
    { type: 'drc', enable: true, attack_time: 25, release_time: 180, compressor_threshold: -18, compressor_ratio: 2.5, compressor_knee_width: 4, make_up_gain: 1.5 },
    { type: 'limiter_lookahead_sig', enable: true, ceiling_dB: 0.4, attack_time_ms: 0.0001, release_time_ms: 20, knee_dB: 0.2 },
  ] }] } },
  { key: 'voice_clean', name: '清澈人声', config: { chains: [{ enable: true, modes: ['normal'], name: 'chain_normal', nodes: [
    { type: 'gain', enable: true, gain_db: -1 },
    { type: 'equalizer', enable: true, band_num: 7, use_preset: 'custom', presets: [{ name: 'custom', enable: true, band_params: [
      EQ('HighPass', 75, 0.9, 0), EQ('Peaking', 180, 1.2, -3), EQ('Peaking', 400, 1.4, 2.5), EQ('Peaking', 1600, 1.3, 2), EQ('Peaking', 3200, 1.4, 3), EQ('Peaking', 6500, 1.2, 1), EQ('HighShelf', 12000, 1.2, 1.5) ] }] },
    { type: 'limiter_lookahead_sig', enable: true, ceiling_dB: 0.4, attack_time_ms: 0.0001, release_time_ms: 20, knee_dB: 0.2 },
  ] }] } },
  { key: 'hifi_live', name: '现场', config: { chains: [{ enable: true, modes: ['normal'], name: 'chain_normal', nodes: [
    { type: 'equalizer', enable: true, band_num: 2, use_preset: 'custom', presets: [{ name: 'custom', enable: true, band_params: [
      EQ('Peaking', 150, 1.2, -1.5), EQ('Peaking', 2500, 1.3, 1.5) ] }] },
    { type: 'stereo_width', enable: true, ms_crossfeed_params: { enable: true, width: 1.35, mix_ratio: 0.3, dry_ratio: 0.7, gain: 0 } },
    { type: 'fdn_reverb', enable: true, rt60: 0.45, dry2wet_ratio: 0.22, gain: 0 },
    { type: 'drc', enable: true, attack_time: 30, release_time: 220, compressor_threshold: -20, compressor_ratio: 1.8, compressor_knee_width: 5, make_up_gain: 1 },
  ] }] } },
  { key: 'rock', name: '摇滚', config: { chains: [{ enable: true, modes: ['normal'], name: 'chain_normal', nodes: [
    { type: 'equalizer', enable: true, band_num: 4, use_preset: 'custom', presets: [{ name: 'custom', enable: true, band_params: [
      EQ('LowShelf', 70, 0.9, 4.5), EQ('Peaking', 500, 1.2, -2.5), EQ('Peaking', 1500, 1.2, 1), EQ('HighShelf', 8000, 1.1, 4) ] }] },
    { type: 'drc', enable: true, attack_time: 15, release_time: 120, compressor_threshold: -20, compressor_ratio: 2.8, compressor_knee_width: 4, make_up_gain: 2 },
    { type: 'limiter_lookahead_sig', enable: true, ceiling_dB: 0.4, attack_time_ms: 0.0001, release_time_ms: 20, knee_dB: 0.2 },
  ] }] } },
  { key: 'vinyl', name: '黑胶', config: { chains: [{ enable: true, modes: ['normal'], name: 'chain_normal', nodes: [
    { type: 'equalizer', enable: true, band_num: 5, use_preset: 'custom', presets: [{ name: 'custom', enable: true, band_params: [
      EQ('HighPass', 30, 0.9, 0), EQ('Peaking', 60, 1.0, 1.5), EQ('Peaking', 120, 1.2, 2), EQ('Peaking', 400, 1.3, -1.5), EQ('HighShelf', 11000, 1.2, -3.5) ] }] },
    { type: 'fdn_reverb', enable: true, rt60: 0.25, dry2wet_ratio: 0.06, gain: 0 },
  ] }] } },
  { key: 'vibrant_electronic', name: '动感电音', config: { chains: [{ enable: true, modes: ['normal'], name: 'chain_normal', nodes: [
    { type: 'equalizer', enable: true, band_num: 6, use_preset: 'custom', presets: [{ name: 'custom', enable: true, band_params: [
      EQ('LowShelf', 55, 0.9, 6.5), EQ('Peaking', 120, 1.1, 3), EQ('Peaking', 350, 1.2, -2), EQ('Peaking', 2500, 1.3, 2.5), EQ('Peaking', 6000, 1.2, 3), EQ('HighShelf', 10000, 1.1, 2.5) ] }] },
    { type: 'drc', enable: true, attack_time: 8, release_time: 100, compressor_threshold: -16, compressor_ratio: 3.5, compressor_knee_width: 3, make_up_gain: 2.5 },
    { type: 'limiter_lookahead_sig', enable: true, ceiling_dB: 0.4, attack_time_ms: 0.0001, release_time_ms: 20, knee_dB: 0.2 },
  ] }] } },
  { key: 'stereo_enhance', name: '360环绕', config: { chains: [{ enable: true, modes: ['normal'], name: 'chain_normal', nodes: [
    { type: 'gain', enable: true, gain_db: -1.5 },
    { type: 'stereo_width', enable: true, ms_crossfeed_params: { enable: true, width: 1.8, mix_ratio: 0.45, dry_ratio: 0.55, gain: 0 } },
    { type: 'fdn_reverb', enable: true, rt60: 0.3, dry2wet_ratio: 0.12, gain: 0 },
    { type: 'limiter_lookahead_sig', enable: true, ceiling_dB: 0.4, attack_time_ms: 0.0001, release_time_ms: 20, knee_dB: 0.2 },
  ] }] } },
];

function loadStoreMeta() {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    for (const file of fs.readdirSync(STORE_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(STORE_DIR, file), 'utf8'));
        if (meta?.trackId) storeMeta.set(meta.trackId, meta);
      } catch (_) {}
    }
  } catch (_) {}
}
loadStoreMeta();

const partPath = id => path.join(STORE_DIR, `${id}.part`);
const m4aPath = id => path.join(STORE_DIR, `${id}.m4a`);
function saveStoreMeta(meta) {
  try { fs.writeFileSync(path.join(STORE_DIR, `${meta.trackId}.json`), JSON.stringify(meta)); } catch (_) {}
}
// progress-tick saver: at most one flush per 400ms per track (JSON writes
// were previously one per network chunk — hundreds per second per stream)
const metaSaveAt = new Map();
function saveStoreMetaThrottled(meta) {
  const now = Date.now();
  if (now - (metaSaveAt.get(meta.trackId) || 0) < 400) return;
  metaSaveAt.set(meta.trackId, now);
  saveStoreMeta(meta);
}
function storeStatus(id) {
  const meta = storeMeta.get(id);
  if (!meta) return null;
  const complete = Boolean(meta.complete && fs.existsSync(m4aPath(id)));
  return {
    complete,
    progress: complete ? 1 : (meta.size ? Math.max(0, Math.min(1, meta.downloaded / meta.size)) : 0),
    preview: Boolean(meta.preview),
  };
}

function decryptStoreFile(trackId) {
  const meta = storeMeta.get(trackId) || {};
  return new Promise(resolve => {
    const target = m4aPath(trackId);
    const child = spawn(process.execPath, [
      RESTORE_SCRIPT, '--decrypt-online',
      '--input', partPath(trackId),
      '--output', target,
      '--spade', String(meta.spade || ''),
      '--device-node', DEVICE_NODE,
      '--ffmpeg', FFMPEG,
    ], { stdio: ['ignore', 'pipe', 'ignore'], env: CHILD_NODE_ENV });
    let output = '';
    child.stdout.on('data', d => { output += d.toString(); });
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} resolve(''); }, 120000);
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const lines = output.trim().split(/\r?\n/).filter(Boolean);
        const result = JSON.parse(lines[lines.length - 1]);
        resolve(result?.ok && fs.existsSync(target) ? target : '');
      } catch (_) { resolve(''); }
    });
  });
}

// Fetch the encrypted CDN stream. A fresh download (no resumable .part) uses
// 4 parallel range segments — CDN throughput per connection is the bottleneck,
// and segmented fetch typically cuts wall time 3-4x. Resume keeps the plain
// single stream so existing .part bytes stay valid. All segments write into
// one preallocated file at their own offsets, so the layout is identical to a
// sequential download.
function fetchSegment(url, headers, range) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { ...headers, range }, agent: cdnAgent }, res => {
      if (res.statusCode !== 206) { res.resume(); reject(new Error(`segment status ${res.statusCode}`)); return; }
      resolve(res);
    }).on('error', reject);
  });
}

async function downloadParallel(url, headers, filePath, totalSize, onProgress) {
  const fd = fs.openSync(filePath, 'w');
  const SEGMENTS = 4;
  const segSize = Math.ceil(totalSize / SEGMENTS);
  let received = 0;
  try {
    await Promise.all(Array.from({ length: SEGMENTS }, (_, i) => {
      const start = i * segSize;
      const end = i === SEGMENTS - 1 ? totalSize - 1 : start + segSize - 1;
      let offset = start;
      return fetchSegment(url, headers, `bytes=${start}-${end}`).then(res => new Promise((resolve, reject) => {
        res.on('data', chunk => {
          fs.writeSync(fd, chunk, 0, chunk.length, offset);
          offset += chunk.length;
          received += chunk.length;
          onProgress(received);
        });
        res.on('aborted', () => reject(new Error('segment aborted')));
        res.on('end', () => (offset === end + 1 ? resolve() : reject(new Error('segment short'))));
        res.on('error', reject);
      }));
    }));
  } finally {
    fs.closeSync(fd);
  }
}
// Download (resuming a .part if present) → decrypt when full.
async function resumeDownload(trackId) {
  const resolved = await ttnetResolve(trackId);
  const info = resolved?.ok ? resolved : (webSession?.cookie ? await resolveOnlineTrack(trackId) : null);
  if (!info) return null;
  const meta = storeMeta.get(trackId) || { trackId, size: 0, downloaded: 0, complete: false, spade: '', preview: false };
  meta.spade = info.spade || meta.spade;
  meta.size = info.size || meta.size;
  if (info.preview) meta.preview = true;
  if (info.name) meta.name = info.name;
  if (info.quality) meta.quality = info.quality;
  storeMeta.set(trackId, meta);
  saveStoreMeta(meta);
  if (!info.encrypted) return { plainUrl: info.url };

  let start = fs.existsSync(partPath(trackId)) ? fs.statSync(partPath(trackId)).size : 0;
  if (start > 0 && meta.size && start > meta.size) start = 0;
  const ok = await new Promise(resolve => {
    if (start === 0 && meta.size > 0) {
      // fresh download: 4 parallel segments into a preallocated file
      downloadParallel(info.url, {
        'user-agent': 'Mozilla/5.0',
        referer: 'https://api.qishui.com/',
      }, partPath(trackId), meta.size, received => {
        meta.downloaded = received;
        saveStoreMetaThrottled(meta);
      }).then(() => resolve(true)).catch(() => resolve(false));
      return;
    }
    const go = (url, depth = 0) => {
      if (depth > 4) { resolve(false); return; }
      const request = https.get(url, {
        headers: {
          'user-agent': 'Mozilla/5.0',
          referer: 'https://api.qishui.com/',
          ...(start > 0 ? { range: `bytes=${start}-` } : {}),
        },
      }, res => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307) {
          res.resume();
          go(res.headers.location, depth + 1);
          return;
        }
        if (res.statusCode !== (start > 0 ? 206 : 200)) { res.resume(); resolve(false); return; }
        if (start === 0 && res.headers['content-length']) meta.size = Number(res.headers['content-length']) || meta.size;
        meta.downloaded = start;
        const out = fs.createWriteStream(partPath(trackId), { flags: start > 0 ? 'a' : 'w' });
        res.on('data', chunk => {
          meta.downloaded += chunk.length;
          saveStoreMetaThrottled(meta);
        });
        res.on('aborted', () => resolve(false));
        out.on('finish', () => resolve(true));
        out.on('error', () => resolve(false));
        res.pipe(out);
      });
      request.on('error', () => resolve(false));
    };
    go(info.url);
  });
  saveStoreMeta(meta);
  if (!ok && meta.downloaded === 0) return null;
  if (meta.size && meta.downloaded >= meta.size) {
    const out = await decryptStoreFile(trackId);
    if (out) {
      meta.complete = true;
      saveStoreMeta(meta);
      try { fs.unlinkSync(partPath(trackId)); } catch (_) {} // m4a replaces the encrypted part
      return { m4a: out };
    }
  }
  return null; // partial (kept for next resume) or decrypt failure
}

// Two lanes: /api/stream (playback) gets a dedicated download lane so a batch
// of cache downloads can never starve the song the user just clicked. The
// download-lane pool only runs while the playback lane is idle-free.
const DOWNLOAD_MAX_CONCURRENT = 2;
let downloadActiveCount = 0;
let playbackDownloadActive = 0;

function startDownloadJob(job) {
  downloadActiveCount += 1;
  resumeDownload(job.trackId)
    .then(result => job.resolve(result))
    .catch(() => job.resolve(null))
    .finally(() => {
      downloadActiveCount -= 1;
      if (job.lane === 'playback') playbackDownloadActive -= 1;
      pumpDownloadQueue();
    });
}

function pumpDownloadQueue() {
  // one lane is always reserved for playback jobs
  const playbackCapacity = playbackDownloadActive ? 0 : 1;
  const backgroundCapacity = DOWNLOAD_MAX_CONCURRENT - playbackCapacity - playbackDownloadActive;
  while (downloadQueue.length
    && downloadActiveCount < DOWNLOAD_MAX_CONCURRENT
    && (downloadQueue[0].lane === 'playback' ? playbackCapacity > 0 : backgroundCapacity > 0)) {
    const job = downloadQueue.shift();
    if (job.lane === 'playback') {
      playbackDownloadActive += 1;
      startDownloadJob(job);
    } else {
      backgroundCapacity -= 1;
      startDownloadJob(job);
    }
  }
}

// Resolve with { m4a } / { plainUrl } / null once the track is stored.
// Concurrent callers for the same track share one queued job.
function ensureOnlineCached(trackId, priority = false) {
  if (storeStatus(trackId)?.complete) return Promise.resolve({ m4a: m4aPath(trackId) });
  const lane = priority ? 'playback' : 'background';
  return new Promise(resolve => {
    const existing = downloadQueue.find(job => job.trackId === trackId);
    if (existing) {
      const prev = existing.resolve;
      existing.resolve = value => { prev(value); resolve(value); };
      if (priority && existing.lane !== 'playback') {
        // upgrade a queued background job to the playback lane
        downloadQueue.splice(downloadQueue.indexOf(existing), 1);
        existing.lane = 'playback';
        downloadQueue.unshift(existing);
      }
    } else {
      const job = { trackId, lane, resolve };
      if (priority) downloadQueue.unshift(job); else downloadQueue.push(job);
    }
    pumpDownloadQueue();
  });
}

// Proxy a signed/plaintext CDN stream with Range passthrough for <audio>.
function proxyOnlineStream(request, response, info) {
  const target = new URL(info.url);
  const headers = {
    'user-agent': PASSPORT_UA,
    'referer': 'https://luna-web.douyin.com/',
    ...(request.headers.range ? { range: request.headers.range } : {}),
  };
  https.get(target, { headers, agent: cdnAgent }, upstream => {
    if (upstream.statusCode === 301 || upstream.statusCode === 302 || upstream.statusCode === 303 || upstream.statusCode === 307) {
      info.url = upstream.headers.location;
      proxyOnlineStream(request, response, info);
      return;
    }
    response.writeHead(upstream.statusCode || 502, {
      'content-type': upstream.headers['content-type'] || 'audio/mp4',
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      ...(upstream.headers['content-length'] ? { 'content-length': upstream.headers['content-length'] } : {}),
      ...(upstream.headers['content-range'] ? { 'content-range': upstream.headers['content-range'] } : {}),
    });
    upstream.pipe(response);
  }).on('error', () => response.writeHead(502).end());
}

// ---------------------------------------------------------------- http plumbing

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    request.on('error', reject);
  });
}

const serverHandler = async (request, response) => {
  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  const route = `${request.method} ${url.pathname}`;

  try {
    if (route === 'GET /') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(staticFiles.index);
      return;
    }
    for (const file of ['app.js', 'style.css', 'manifest.webmanifest']) {
      if (url.pathname === `/${file}`) {
        const types = {
          'app.js': 'text/javascript',
          'style.css': 'text/css',
          'manifest.webmanifest': 'application/manifest+json',
        };
        response.writeHead(200, { 'content-type': `${types[file]}; charset=utf-8`, 'cache-control': 'no-store' })
          .end(staticFiles[file]);
        return;
      }
    }
    // 应用图标:public/icons 下的生成产物(见 scripts/make-icons.py)。
    // 文件名白名单(无斜杠/无点点,防路径穿越),命中则长缓存。
    if (url.pathname.startsWith('/icons/')) {
      const name = url.pathname.slice('/icons/'.length);
      const m = name.match(/^([a-z0-9-]+)\.(png|svg|ico)$/i);
      const types = { png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon' };
      if (m) {
        const buf = staticFiles.icon(name);
        if (buf.length) {
          response.writeHead(200, { 'content-type': types[m[2].toLowerCase()], 'cache-control': 'public, max-age=86400' })
            .end(buf);
          return;
        }
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }

    if (route === 'GET /api/me') {
      const result = await upstream('/luna/pc/me', '', 'GET', null, 30000);
      sendJson(response, 200, result.json);
      return;
    }
    if (route === 'GET /api/playlists') {
      // `fresh=1` (同步收藏按钮) forces a real fetch; plain loads serve the
      // 90s cache (auto-sync keeps it fresh on its own 5-min cadence)
      const fresh = url.searchParams.has('fresh');
      const result = await upstream('/luna/pc/me/playlist', url.search.replace(/^\?/, ''), 'GET', null, fresh ? 0 : 90000);
      sendJson(response, 200, result.json);
      return;
    }
    if (route === 'GET /api/collections') {
      const result = await upstream('/luna/pc/me/collection/mixed', url.search.replace(/^\?/, ''));
      sendJson(response, 200, result.json);
      return;
    }
    if (url.pathname.startsWith('/api/playlist/') && request.method === 'GET') {
      const id = url.pathname.split('/').pop();
      const search = new URLSearchParams({ playlist_id: id, ...Object.fromEntries(url.searchParams) });
      search.delete('fresh');
      const result = await upstream('/luna/pc/playlist/detail', search.toString(), 'GET', null, 60000);
      sendJson(response, 200, result.json);
      return;
    }
    if (route === 'GET /api/cache-status') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 80);
      if (!ids.length) { sendJson(response, 200, { tracks: {} }); return; }
      // per-id hit: reuse cached per-track results and only scan the misses —
      // paging back over already-visited rows stays subprocess-free.
      // scanTracks batches in slices of 20 so hits stay granular on re-visit.
      const tracks = {};
      const misses = [];
      for (const id of ids) {
        const hit = scanCache.get(`--track-ids|${id}`);
        if (hit && Date.now() - hit.at < SCAN_CACHE_TTL && hit.value?.batch?.[id]) tracks[id] = hit.value.batch[id];
        else misses.push(id);
      }
      if (misses.length) {
        const results = await Promise.all(
          Array.from({ length: Math.ceil(misses.length / 20) }, (_, i) =>
            scanTracks(misses.slice(i * 20, (i + 1) * 20))),
        );
        for (const result of results) Object.assign(tracks, result?.batch || {});
      }
      const store = {};
      for (const id of ids) {
        const status = storeStatus(id);
        if (status && (status.complete || status.progress > 0)) store[id] = status;
      }
      sendJson(response, 200, { tracks, store });
      return;
    }
    if (url.pathname.startsWith('/api/stream/') && request.method === 'GET') {
      const trackId = url.pathname.split('/').pop();
      const scan = await scanTrack(trackId);
      const candidate = scan?.candidates?.[0];
      // client-cached previews are 30s; the online path returns 60s at top
      // quality — prefer online for those, keep the cache as fallback
      const clientPreview = candidate?.isPreview === true;
      // start the online cache/download race immediately in parallel: when the
      // local file is ready we drop the online work, when it isn't we've saved
      // a full serialized round-trip (scan → resolve → CDN download)
      const onlineRace = (clientPreview || !candidate)
        ? ensureOnlineCached(trackId, true).catch(() => null)
        : null;
      if (candidate && !clientPreview) {
        const file = candidate.encryption?.encrypted
          ? (decryptedChunkCache.get(candidate.chunkId) || await decryptForStreaming(trackId))
          : path.join(CACHE_DIR, `${candidate.chunkId}.bin`);
        if (file) { serveStream(request, response, file); return; }
      }
      if (candidate && clientPreview) {
        const online = await onlineRace;
        if (online?.m4a) { serveStream(request, response, online.m4a); return; }
        if (online?.plainUrl) { proxyOnlineStream(request, response, { url: online.plainUrl }); return; }
        // online unavailable → fall back to the shorter client preview
        const file = candidate.encryption?.encrypted
          ? (decryptedChunkCache.get(candidate.chunkId) || await decryptForStreaming(trackId))
          : path.join(CACHE_DIR, `${candidate.chunkId}.bin`);
        if (file) { serveStream(request, response, file); return; }
      }
      // not cached (or decrypt failed) → online: download (resumable) + decrypt + serve.
      // onlineRace is a PROMISE — `||` binds the promise object itself
      // (JSON.stringify(promise) === '{}', then serveStream 404s on it).
      // It must always be awaited.
      const online = await (onlineRace ?? ensureOnlineCached(trackId, true));
      if (online?.m4a) { serveStream(request, response, online.m4a); return; }
      if (online?.plainUrl) { proxyOnlineStream(request, response, { url: online.plainUrl }); return; }
      sendJson(response, 404, { ok: false, error: 'not cached and not resolvable online' });
      return;
    }
    if (route === 'GET /api/progress-stream') {
      // real-time push while downloads run (ring animation in the UI).
      // Pushes are dirty-gated: an idle listener used to cost a full
      // storeMeta sweep + JSON serialize every 250ms around the clock.
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      let dirty = true;
      let lastPayload = '';
      const wake = () => { dirty = true; };
      progressWakers.add(wake);
      const send = () => {
        if (!dirty) return;
        dirty = false;
        const all = {};
        for (const id of storeMeta.keys()) {
          const status = storeStatus(id);
          if (status && (status.complete || status.progress > 0)) all[id] = status;
        }
        const payload = `data: ${JSON.stringify({ all })}\n\n`;
        if (payload === lastPayload) return; // no visible change → skip write
        lastPayload = payload;
        try { response.write(payload); } catch (_) {}
      };
      const timer = setInterval(send, 250);
      request.on('close', () => { clearInterval(timer); progressWakers.delete(wake); });
      send();
      return;
    }
    if (route === 'GET /api/progress') {
      const all = {};
      let activeCount = 0;
      for (const id of storeMeta.keys()) {
        const status = storeStatus(id);
        if (!status) continue;
        if (status.complete || status.progress > 0) all[id] = status;
        if (!status.complete) activeCount += 1;
      }
      sendJson(response, 200, { all, activeCount });
      return;
    }
    if (route === 'GET /api/weblogin/status') {
      sendJson(response, 200, {
        loggedIn: Boolean(webSession?.cookie),
        clientSession: await ttnetResolveProbe(),
        savedAt: webSession?.savedAt || 0,
      });
      return;
    }
    if (route === 'POST /api/weblogin/logout') {
      webSession = null;
      try { fs.unlinkSync(WEB_SESSION_FILE); } catch (_) {}
      onlineCache.clear();
      sendJson(response, 200, { ok: true });
      return;
    }
    if (route === 'GET /api/weblogin/qr') {
      try { sendJson(response, 200, { ok: true, ...(await createQrLogin()) }); }
      catch (error) { sendJson(response, 500, { ok: false, error: error.message }); }
      return;
    }
    if (url.pathname.startsWith('/api/weblogin/poll') && request.method === 'GET') {
      sendJson(response, 200, { ok: true, ...(await pollQrLogin(url.searchParams.get('token') || '')) });
      return;
    }
    if (route === 'GET /api/store/sets') {
      const sets = [];
      try {
        for (const name of fs.readdirSync(STORES_ROOT)) {
          const dir = path.join(STORES_ROOT, name);
          if (!fs.statSync(dir).isDirectory()) continue;
          let tracks = 0, size = 0;
          for (const f of fs.readdirSync(dir)) {
            const st = fs.statSync(path.join(dir, f));
            size += st.size;
            if (f.endsWith('.m4a')) tracks += 1;
          }
          sets.push({ name, tracks, size, active: name === activeStoreName() });
        }
      } catch (_) {}
      sets.sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
      sendJson(response, 200, { active: activeStoreName(), sets });
      return;
    }
    if (route === 'POST /api/store/switch') {
      const input = await readBody(request);
      const name = String(input.name || '');
      if (!setNameOk(name) || !fs.existsSync(path.join(STORES_ROOT, name))) { sendJson(response, 400, { ok: false, error: '无效的缓存库名' }); return; }
      switchStore(name);
      sendJson(response, 200, { ok: true, active: name });
      return;
    }
    if (route === 'POST /api/store/create') {
      const input = await readBody(request);
      const name = String(input.name || '').trim();
      if (!setNameOk(name)) { sendJson(response, 400, { ok: false, error: '名称需为 1-32 位中文/字母/数字/短横线' }); return; }
      const dir = path.join(STORES_ROOT, name);
      if (fs.existsSync(dir)) { sendJson(response, 400, { ok: false, error: '已存在同名缓存库' }); return; }
      fs.mkdirSync(dir, { recursive: true });
      sendJson(response, 200, { ok: true });
      return;
    }
    if (route === 'POST /api/store/delete') {
      const input = await readBody(request);
      const name = String(input.name || '');
      if (!setNameOk(name) || name === activeStoreName()) { sendJson(response, 400, { ok: false, error: '不能删除当前使用中的缓存库' }); return; }
      fs.rmSync(path.join(STORES_ROOT, name), { recursive: true, force: true });
      sendJson(response, 200, { ok: true });
      return;
    }
    if (route === 'GET /api/store/tracks') {
      const tracks = [];
      for (const [id, meta] of storeMeta) {
        const complete = meta.complete && fs.existsSync(m4aPath(id));
        let size = 0;
        try { size = complete ? fs.statSync(m4aPath(id)).size : meta.downloaded; } catch (_) {}
        tracks.push({ id, name: meta.name || '', complete, preview: Boolean(meta.preview), size, quality: meta.quality || '' });
      }
      tracks.sort((a, b) => Number(b.complete) - Number(a.complete) || (b.size - a.size));
      sendJson(response, 200, { set: activeStoreName(), tracks });
      return;
    }
    if (route === 'POST /api/store/remove-track') {
      const input = await readBody(request);
      const id = String(input.id || '');
      if (!/^\d+$/.test(id)) { sendJson(response, 400, { ok: false }); return; }
      for (const suffix of ['m4a', 'json', 'part']) {
        try { fs.unlinkSync(path.join(STORE_DIR, `${id}.${suffix}`)); } catch (_) {}
      }
      storeMeta.delete(id);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (route === 'POST /api/store/clear') {
      downloadQueue.length = 0;
      fs.rmSync(STORE_DIR, { recursive: true, force: true });
      switchStore(activeStoreName());
      sendJson(response, 200, { ok: true });
      return;
    }
    if (route === 'GET /api/backup') {
      // stream the whole incremental-cache store as a tar (audio is already
      // compressed, so no gzip pass) — backup.json rides along as manifest
      const manifest = {
        version: 1, app: 'qsyy', createdAt: Date.now(),
        tracks: [...storeMeta.values()].map(m => ({ id: m.trackId, complete: Boolean(m.complete && fs.existsSync(m4aPath(m.trackId))), preview: Boolean(m.preview) })),
      };
      const manifestPath = path.join(STORE_DIR, 'backup.json');
      try { fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1)); } catch (_) {}
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      response.writeHead(200, {
        'content-type': 'application/x-tar',
        'content-disposition': `attachment; filename="qsyy-cache-${stamp}.tar"`,
      });
      const child = spawn('tar', ['-cf', '-', '-C', STORE_DIR, '.']);
      child.stdout.pipe(response);
      child.stderr.resume();
      child.on('close', () => {
        try { fs.unlinkSync(manifestPath); } catch (_) {}
        try { response.end(); } catch (_) {}
      });
      response.on('close', () => { try { child.kill(); } catch (_) {} });
      return;
    }
    if (route === 'POST /api/restore') {
      // streaming tar import into a NEW set (named after the backup file),
      // then switched active. Only accepts plain <trackId>.<m4a|json|part>
      // entries (path-traversal safe by construction).
      let setName = (url.searchParams.get('set') || '').replace(/\.tar$/i, '').trim();
      if (!setNameOk(setName)) setName = `导入-${new Date().toISOString().slice(5, 10).replace('-', '')}`;
      const targetDir = path.join(STORES_ROOT, setName);
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(targetDir, { recursive: true });
      const validEntry = name => /^\d+\.(m4a|json|part)$/.test(name);
      let imported = 0;
      let skipped = 0;
      let buffer = Buffer.alloc(0);
      let mode = 'header';
      let current = null; // { size, taken, out?, need? }
      const padNeeded = size => (512 - (size % 512)) % 512;
      try {
        for await (const chunk of request) {
          buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
          while (buffer.length > 0) {
            if (mode === 'header') {
              if (buffer.length < 512) break;
              const header = buffer.subarray(0, 512);
              buffer = buffer.subarray(512);
              const name = header.toString('utf8', 0, 100).replace(/\0[\s\S]*$/, '');
              const sizeField = header.toString('utf8', 124, 136).replace(/[\0 ]/g, '');
              const size = parseInt(sizeField, 8) || 0;
              const type = header[156];
              const base = path.basename(name);
              const regular = type === 48 || type === 0;
              if (regular && base !== 'backup.json' && validEntry(base)) {
                imported += 1;
                mode = 'data';
                current = { size, taken: 0, out: fs.createWriteStream(path.join(targetDir, base)) };
              } else {
                if (regular && name) skipped += 1;
                const pad = padNeeded(size);
                if (size > 0) { mode = 'skip'; current = { size, taken: 0, need: pad }; }
                else current = null;
              }
            } else if (mode === 'data') {
              const want = Math.min(buffer.length, current.size - current.taken);
              current.out.write(buffer.subarray(0, want));
              current.taken += want;
              buffer = buffer.subarray(want);
              if (current.taken >= current.size) {
                current.out.end();
                const pad = padNeeded(current.size);
                if (pad > 0) { mode = 'pad'; current = { need: pad, taken: 0 }; }
                else current = null, mode = 'header';
              }
            } else if (mode === 'skip') {
              const want = Math.min(buffer.length, current.size - current.taken);
              current.taken += want;
              buffer = buffer.subarray(want);
              if (current.taken >= current.size) {
                if (current.need > 0) { mode = 'pad'; current = { need: current.need, taken: 0 }; }
                else { current = null; mode = 'header'; }
              }
            } else { // pad
              const want = Math.min(buffer.length, current.need - current.taken);
              current.taken += want;
              buffer = buffer.subarray(want);
              if (current.taken >= current.need) { current = null; mode = 'header'; }
            }
          }
        }
        if (current?.out) current.out.end();
        switchStore(setName);
        sendJson(response, 200, { ok: true, imported, skipped, set: setName });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error.message });
      }
      return;
    }
    if (route === 'GET /api/effects' || url.pathname === '/api/effects/') {
      sendJson(response, 200, { ok: true, effects: PRESET_EFFECTS.map(p => ({ key: p.key, name: p.name })) });
      return;
    }
    if (url.pathname.startsWith('/api/effects/') && request.method === 'GET') {
      // per-track availability: 智能音效 comes from track_v2 audio_effects (API
      // aligned, tuned per song); the preset catalog mirrors the client's own
      // effect registry (bass_enhance/voice_clean/... ) with equivalent Web
      // Audio chains in the same config format. Availability is derived from
      // the resolve result which is already cached — no extra wait here.
      const trackId = url.pathname.split('/').pop();
      const resolved = await ttnetResolve(trackId);
      const map = resolved?.ok ? resolved.effects : null;
      const effects = [];
      if (map?.intelligent) effects.push({ key: 'intelligent', name: '智能音效', configUrl: map.intelligent, perTrack: true });
      for (const preset of PRESET_EFFECTS) effects.push({ ...preset });
      sendJson(response, 200, { ok: effects.length > 0, effects });
      return;
    }
    if (route === 'GET /api/effect-config') {
      // fetch the DSP chain JSON for an effect (cached; qishui CDN only)
      const target = url.searchParams.get('url') || '';
      let parsed;
      try {
        parsed = new URL(target);
        if (!/(^|\.)qishui\.com$/.test(parsed.hostname)) throw new Error('bad host');
      } catch (_) { sendJson(response, 400, { ok: false }); return; }
      if (effectConfigs.has(target)) { sendJson(response, 200, effectConfigs.get(target)); return; }
      https.get(parsed, { headers: { 'user-agent': 'Mozilla/5.0' }, agent: cdnAgent }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const config = JSON.parse(Buffer.concat(chunks).toString());
            cacheEffectConfig(target, config);
            sendJson(response, 200, config);
          } catch (_) { sendJson(response, 502, { ok: false }); }
        });
      }).on('error', () => sendJson(response, 502, { ok: false }));
      return;
    }
    if (url.pathname.startsWith('/api/online/') && request.method === 'GET') {
      const trackId = url.pathname.split('/').pop();
      const resolved = await ttnetResolve(trackId);
      const info = resolved?.ok ? resolved : (webSession?.cookie ? await resolveOnlineTrack(trackId) : null);
      sendJson(response, 200, {
        ok: Boolean(info),
        error: info ? '' : (resolved?.error === 'restricted' || resolved?.error === 'upstream 200' ? 'unavailable' : (resolved?.error || 'unavailable')),
        info: info ? { quality: info.quality, bitrate: info.bitrate, size: info.size } : null,
      });
      return;
    }
    if (url.pathname.startsWith('/api/lyrics/') && request.method === 'GET') {
      // Lyrics ride along in the signed track_v2 payload (ttnet path). v2 keeps
      // the per-word timings so the front end can render karaoke highlight; the
      // flat LRC is still produced for file tagging. Cached on disk per track,
      // and a v1 (lrc-only) cache is transparently upgraded on next request.
      const trackId = url.pathname.split('/').pop();
      if (!/^\d+$/.test(trackId)) { sendJson(response, 400, { ok: false, error: 'bad track id' }); return; }
      const lyricsDir = path.join(DECRYPT_DIR, 'lyrics');
      let cached = null;
      try { cached = JSON.parse(fs.readFileSync(path.join(lyricsDir, `${trackId}.json`), 'utf8')); } catch (_) {}
      if (cached?.v === 2 && Array.isArray(cached.lines) && cached.lines.length) {
        sendJson(response, 200, { ok: true, ...cached, cached: true });
        return;
      }
      const resolved = await ttnetResolve(trackId);
      const built = buildLyrics(resolved);
      if (built) {
        writeLyricsCache(trackId, built);
        sendJson(response, 200, { ok: true, ...built, cached: false });
        return;
      }
      if (cached?.lrc) {
        sendJson(response, 200, { ok: true, v: 1, lrc: cached.lrc, name: cached.name || '', cached: true });
        return;
      }
      sendJson(response, 200, { ok: false, error: resolved?.ok === false && resolved?.error === 'restricted' ? 'unavailable' : 'no-lyric' });
      return;
    }
    if (route === 'GET /api/cover') {
      proxyImage(url.searchParams.get('url') || '', response);
      return;
    }
    if (route === 'POST /api/download') {
      const input = await readBody(request);
      const job = await startDownload(input);
      sendJson(response, 200, { ok: true, job });
      return;
    }
    if (route === 'GET /api/downloads') {
      sendJson(response, 200, { jobs: [...downloadJobs.values()].slice(-100).reverse(), dir: DOWNLOAD_DIR });
      return;
    }
    if (route === 'POST /api/open-downloads') {
      try {
        const { cmd, args } = openFolder(DOWNLOAD_DIR);
        execFileSync(cmd, args, { stdio: 'ignore' });
        sendJson(response, 200, { ok: true });
      }
      catch (error) { sendJson(response, 500, { ok: false, error: error.message }); }
      return;
    }
    if (route === 'POST /api/open-client') {
      try {
        const { cmd, args } = openClient();
        execFileSync(cmd, args, { stdio: 'ignore' });
        sendJson(response, 200, { ok: true });
      }
      catch (error) { sendJson(response, 500, { ok: false, error: error.message }); }
      return;
    }
    if (url.pathname.startsWith('/api/monitor/') && request.method === 'GET') {
      // long-poll: wait until the track has a ready cache chunk (user plays it
      // in the official client meanwhile), up to 120s
      const trackId = url.pathname.split('/').pop();
      const deadline = Date.now() + 120000;
      const check = async () => {
        const scan = await scanTrack(trackId);
        if (scan?.candidates?.[0]) { sendJson(response, 200, { ok: true, ready: true }); return; }
        if (Date.now() > deadline || response.writableEnded) { sendJson(response, 200, { ok: true, ready: false }); return; }
        setTimeout(check, 3000);
      };
      check();
      return;
    }
    if (route === 'GET /api/version') {
      sendJson(response, 200, { ok: true, version: APP_VERSION, repo: APP_REPO });
      return;
    }
    if (route === 'GET /api/stats') {
      try {
        const snapshot = path.join(os.tmpdir(), `qsyy-info-${Date.now()}.db`);
        fs.copyFileSync(path.join(CACHE_DIR, 'info.db'), snapshot);
        const lmdb = require(LMDB_MODULE);
        const env = lmdb.open({ path: snapshot, readOnly: true, useVersions: false });
        const totalCachedSize = Number(env.get('totalCachedSize')) || 0;
        env.close();
        fs.unlinkSync(snapshot);
        sendJson(response, 200, { ok: true, totalCachedSize });
      } catch (_) {
        sendJson(response, 200, { ok: true, totalCachedSize: 0 });
      }
      return;
    }
    if (route === 'GET /api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
      });
      response.write(':ok\n\n');
      // push-on-change: the 1s serialize-everything timer only existed to
      // catch job updates; the bus knows when they happen
      let lastPayload = '';
      const send = () => {
        const snapshot = [...downloadJobs.values()].slice(-20).map(j => ({ jobId: j.jobId, status: j.status, progress: j.progress, phase: j.phase }));
        const payload = `data: ${JSON.stringify({ jobs: snapshot })}\n\n`;
        if (payload === lastPayload) return;
        lastPayload = payload;
        try { response.write(payload); } catch (_) {}
      };
      const wake = () => send();
      progressWakers.add(wake);
      request.on('close', () => progressWakers.delete(wake));
      send();
      return;
    }
    sendJson(response, 404, { ok: false, error: 'not found' });
  } catch (error) {
    logger('standalone-request-failed', { route, message: error?.message || String(error) });
    try { sendJson(response, 500, { ok: false, error: error?.message || String(error) }); }
    catch (_) { try { response.destroy(); } catch (_) {} }
  }
};

const server = http.createServer((request, response) => {
  // a rejected handler promise must never escape as an unhandledRejection
  Promise.resolve(serverHandler(request, response)).catch(error => recordFault('handler-rejection', error));
});

// Abrupt socket teardowns (phone locking mid-stream, Wi-Fi drops) emit
// 'clientError'; without a listener Node would answer with a raw 400 and in
// some paths surface the exception. Reply politely and move on.
server.on('clientError', (error, socket) => {
  try {
    if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
  } catch (_) { try { socket.destroy(); } catch (_) {} }
});

// Static assets are tiny and read on every page load — keep them in memory
// instead of hitting disk per request, BUT re-read when the file changes on
// disk (mtime): a stale in-memory copy once served an old app.js for the
// whole session, since frontend edits don't restart the server.
const staticFiles = (() => {
  const cache = new Map(); // name → { buf, mtimeMs }
  const load = name => {
    const file = path.join(publicDir, name);
    try {
      const mtimeMs = fs.statSync(file).mtimeMs;
      let entry = cache.get(name);
      if (!entry || entry.mtimeMs !== mtimeMs) {
        entry = { buf: fs.readFileSync(file), mtimeMs };
        cache.set(name, entry);
      }
      return entry.buf;
    } catch (_) { return Buffer.alloc(0); }
  };
  return {
    get index() { return load('index.html'); },
    get 'app.js'() { return load('app.js'); },
    get 'style.css'() { return load('style.css'); },
    get 'manifest.webmanifest'() { return load('manifest.webmanifest'); },
    icon: name => load(`icons/${name}`),
  };
})();

// (resolve/online cache sweeping merged into the 5-min janitor above)

server.listen(PORT, HOST, () => {
  console.log(`[qsyy] standalone app: http://${HOST}:${PORT}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    for (const [name, infos] of Object.entries(os.networkInterfaces())) {
      for (const info of infos || []) {
        if (info.family === 'IPv4' && !info.internal) console.log(`[qsyy] LAN: http://${info.address}:${PORT}  (${name})`);
      }
    }
  }
  console.log(`[qsyy] cache: ${CACHE_DIR}`);
  console.log(`[qsyy] downloads: ${DOWNLOAD_DIR}`);
});
