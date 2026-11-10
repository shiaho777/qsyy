'use strict';

// macOS port of the Windows restore_cache.js contract.
// Reads the Soda Music (Mac) LunaCacheV2 index with lmdb, locates the cached
// chunk for a track, and copies it out as a plain media file. Encrypted
// (CENC) entries are decrypted in pure JS via lib/cenc.js; no client native
// module and no ffmpeg are involved.
//
// The live entries.db can abort an lmdb open while the client writes to it,
// so every scan runs against a fresh file snapshot inside a forked child; a
// crashed child is simply retried with a new snapshot.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { decodeSpadeA, decryptMp4 } = require('./lib/cenc');

// Detached children are re-parented to launchd/init when the server dies
// without running its exit handlers (SIGKILL, native crash). Scans and
// restore/transcode jobs must not keep running headless after that. Two
// seconds covers the normal parent-exit race without polling hard.
const PARENT_PID = process.ppid;
function parentStillAlive() {
  if (process.ppid !== PARENT_PID) return false;
  try { process.kill(PARENT_PID, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}
if (PARENT_PID > 1) {
  const parentWatchdog = setInterval(() => {
    if (parentStillAlive()) return;
    clearInterval(parentWatchdog);
    process.exit(1);
  }, 2000);
  parentWatchdog.unref?.();
}

function parseArgs(argv) {
  const args = {};
  const push = (key, value) => {
    if (args[key] === undefined) args[key] = value;
    else if (Array.isArray(args[key])) args[key].push(value);
    else args[key] = [args[key], value];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      push(key, next);
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function normalizeQuality(value) {
  const key = String(value || '').trim().toLowerCase();
  return ({ standard: 'medium', 'hi-res': 'hi_res', hires: 'hi_res', flac: 'lossless' })[key] || key;
}

const QUALITY_RANK = ['lossless', 'hi_res', 'spatial', 'highest', 'higher', 'medium', 'default'];

function qualityScore(requested, entryQuality) {
  if (entryQuality === requested) return 100 - QUALITY_RANK.indexOf(entryQuality);
  const rank = QUALITY_RANK.indexOf(entryQuality);
  return rank === -1 ? -1 : 50 - rank;
}

function emit(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function urlObjectName(url) {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] || '';
  } catch (_) {
    return '';
  }
}

function asUrlList(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function parseEntry(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    return null;
  }
}

function readCandidates(env, trackId, requestedQuality) {
  const candidates = [];
  for (const key of env.getKeys()) {
    const parts = String(key).split('_');
    if (parts.length < 3) continue;
    const kind = parts[parts.length - 2];
    const entryQuality = parts[parts.length - 1];
    const entry = parseEntry(env.get(key));
    if (!entry?.chunkId || String(entry?.info?.trackId || '') !== String(trackId)) continue;
    candidates.push({
      key,
      kind,
      entryQuality,
      chunkId: entry.chunkId,
      size: Number(entry.size) || 0,
      bitrate: Number(entry.info?.bitrate) || 0,
      isPreview: entry.info?.isPreview === true,
    });
  }
  candidates.sort((left, right) => {
    const byFull = (left.kind === 'F' ? 1 : 0) - (right.kind === 'F' ? 1 : 0);
    if (byFull !== 0) return -byFull;
    const byQuality = qualityScore(requestedQuality, left.entryQuality)
      - qualityScore(requestedQuality, right.entryQuality);
    if (byQuality !== 0) return -byQuality;
    return right.bitrate - left.bitrate;
  });
  return candidates;
}

// Resolves a track id from audio stream URLs (douyinvod object names are
// stable and unique per resource).
function resolveTrackIdByUrls(env, audioUrls) {
  const wanted = asUrlList(audioUrls).map(urlObjectName).filter(Boolean);
  if (!wanted.length) return '';
  for (const key of env.getKeys()) {
    const entry = parseEntry(env.get(key));
    const urls = Array.isArray(entry?.info?.urls) ? entry.info.urls : [];
    for (const url of urls) {
      if (wanted.includes(urlObjectName(url))) return String(entry.info?.trackId || '');
    }
  }
  return '';
}

// Reads the encryption metadata for a cache entry. Each quality rendition
// carries its own key, so match by the entry's quality first. On mac the key
// material lives in encrypt_info.spade_a (Windows stores it in info.spade).
function encryptionOf(entry) {
  const list = entry?.info?.mediaDetail?.video_model?.video_list || [];
  const selected = list.find(item => item?.video_meta?.quality === entry?.info?.quality) || list[0] || {};
  const info = selected.encrypt_info || {};
  return {
    encrypted: Boolean(info.encrypt),
    method: info.encryption_method || '',
    spade: info.spade_a || entry?.info?.spade || '',
  };
}

function inspectChunk(cacheDir, chunkId, expectedSize) {  const file = path.join(cacheDir, `${chunkId}.bin`);
  if (!fs.existsSync(file)) return { file, ready: false, valid: false };
  const stat = fs.statSync(file);
  const header = Buffer.alloc(12);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, header, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  const hasFtyp = header.subarray(4, 8).toString('ascii') === 'ftyp';
  const complete = !expectedSize || stat.size === expectedSize;
  return {
    file,
    ready: hasFtyp && complete,
    valid: hasFtyp,
    size: stat.size,
    brand: hasFtyp ? header.subarray(8, 12).toString('ascii') : '',
  };
}

function scanSnapshot(args) {
  const lmdb = require(args['lmdb-module']);
  const env = lmdb.open({ path: args.snapshot, readOnly: true, useVersions: false });
  try {
    // full sweep: every ready chunk in the client cache, best candidate per
    // track (完整 kind=F 优先,同曲取最大体积)——「同步汽水音乐缓存为库」用
    if (args['scan-all']) {
      const byTrack = new Map();
      for (const key of env.getKeys()) {
        const parts = String(key).split('_');
        if (parts.length < 3) continue;
        const entry = parseEntry(env.get(key));
        if (!entry?.chunkId) continue;
        const trackId = String(entry?.info?.trackId || '');
        if (!trackId) continue;
        if (!byTrack.has(trackId)) byTrack.set(trackId, []);
        byTrack.get(trackId).push({
          key,
          kind: parts[parts.length - 2],
          entryQuality: parts[parts.length - 1],
          chunkId: entry.chunkId,
          size: Number(entry.size) || 0,
          isPreview: entry.info?.isPreview === true,
          encryption: encryptionOf(entry),
        });
      }
      const result = {};
      for (const [trackId, candidates] of byTrack) {
        const full = candidates.filter(c => c.kind === 'F');
        const best = (full.length ? full : candidates).sort((a, b) => b.size - a.size)[0];
        if (best && best.size && inspectChunk(args['cache-dir'], best.chunkId, best.size).ready) {
          result[trackId] = { ...best, ready: true };
        }
      }
      return { batch: result };
    }
    // batch mode: report readiness for many track ids at once
    if (args['track-ids']) {
      const wanted = String(args['track-ids']).split(',').filter(Boolean);
      const byTrack = new Map(wanted.map(id => [id, []]));
      for (const key of env.getKeys()) {
        const parts = String(key).split('_');
        if (parts.length < 3) continue;
        const entry = parseEntry(env.get(key));
        if (!entry?.chunkId) continue;
        const trackId = String(entry?.info?.trackId || '');
        if (!byTrack.has(trackId)) continue;
        byTrack.get(trackId).push({
          kind: parts[parts.length - 2],
          entryQuality: parts[parts.length - 1],
          chunkId: entry.chunkId,
          size: Number(entry.size) || 0,
          isPreview: entry.info?.isPreview === true,
        });
      }
      const result = {};
      for (const [trackId, candidates] of byTrack) {
        const full = candidates.filter(c => c.kind === 'F');
        const best = (full.length ? full : candidates).sort((a, b) => b.size - a.size)[0] || null;
        result[trackId] = best
          ? { ...best, ready: Boolean(best.size) && inspectChunk(args['cache-dir'], best.chunkId, best.size).ready }
          : null;
      }
      return { batch: result };
    }
    let trackId = String(args['track-id'] || '').trim();
    if (!trackId) trackId = resolveTrackIdByUrls(env, args['audio-url']);
    if (!trackId) return { trackId: '', candidates: [] };
    const candidates = readCandidates(env, trackId, normalizeQuality(args.quality));
    let best = null;
    for (const candidate of candidates) {
      const chunk = inspectChunk(args['cache-dir'], candidate.chunkId, candidate.size);
      if (chunk.ready) {
        best = { ...candidate, size: chunk.size, brand: chunk.brand };
        break;
      }
    }
    if (best) {
      const entry = parseEntry(env.get(best.key));
      best.encryption = encryptionOf(entry);
    }
    return { trackId, candidates: best ? [best] : [] };
  } finally {
    try { env.close(); } catch (_) {}
  }
}

// Materialize every ready chunk in the client cache into outputDir as
// <trackId>.m4a — used by 「同步汽水音乐缓存为库」. One lmdb snapshot, one
// process, sequential writes; each track emits a JSON line so the parent can
// stream progress. Plaintext entries are copied as-is; cenc-aes-ctr entries go
// through decodeSpadeA + per-sample AES-CTR decrypt + in-place box cleanup.
// 30s preview chunks are reported but never imported (the online path serves
// them better).
function restoreAllSnapshot(args) {
  const lmdb = require(args['lmdb-module']);
  const env = lmdb.open({ path: args.snapshot, readOnly: true, useVersions: false });
  const outputDir = args['output-dir'];
  const cacheDir = args['cache-dir'];
  fs.mkdirSync(outputDir, { recursive: true });
  try {
    const byTrack = new Map();
    for (const key of env.getKeys()) {
      const parts = String(key).split('_');
      if (parts.length < 3) continue;
      const entry = parseEntry(env.get(key));
      if (!entry?.chunkId) continue;
      const trackId = String(entry?.info?.trackId || '');
      if (!trackId) continue;
      if (!byTrack.has(trackId)) byTrack.set(trackId, []);
      byTrack.get(trackId).push({
        kind: parts[parts.length - 2],
        entryQuality: parts[parts.length - 1],
        chunkId: entry.chunkId,
        size: Number(entry.size) || 0,
        isPreview: entry.info?.isPreview === true,
        encryption: encryptionOf(entry),
      });
    }
    const rank = q => { const i = QUALITY_RANK.indexOf(q); return i < 0 ? QUALITY_RANK.length : i; };
    const picks = [];
    for (const [trackId, candidates] of byTrack) {
      const full = candidates.filter(c => c.kind === 'F');
      // 完整条目优先;同档按音质序(QUALITY_RANK),再按体积兜底
      const best = (full.length ? full : candidates)
        .sort((a, b) => rank(a.entryQuality) - rank(b.entryQuality) || b.size - a.size)[0];
      if (best && best.size && inspectChunk(cacheDir, best.chunkId, best.size).ready) {
        picks.push({ trackId, ...best });
      }
    }
    emit({ type: 'summary', total: picks.length });
    for (const pick of picks) {
      const target = path.join(outputDir, `${pick.trackId}.m4a`);
      if (pick.isPreview) { emit({ type: 'track', trackId: pick.trackId, ok: false, preview: true, size: pick.size, quality: pick.entryQuality }); continue; }
      if (fs.existsSync(target)) { emit({ type: 'track', trackId: pick.trackId, ok: true, existed: true, size: fs.statSync(target).size, quality: pick.entryQuality }); continue; }
      const source = path.join(cacheDir, `${pick.chunkId}.bin`);
      const tmp = path.join(outputDir, `.qsyy-sync-${pick.trackId}.m4a`);
      try {
        if (pick.encryption?.encrypted && pick.encryption.method === 'cenc-aes-ctr') {
          decryptMp4(source, tmp, Buffer.from(decodeSpadeA(pick.encryption.spade), 'hex'));
        } else {
          fs.copyFileSync(source, tmp);
        }
        fs.renameSync(tmp, target);
        emit({ type: 'track', trackId: pick.trackId, ok: true, size: fs.statSync(target).size, quality: pick.entryQuality });
      } catch (error) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        emit({ type: 'track', trackId: pick.trackId, ok: false, error: error?.message || String(error), size: pick.size, quality: pick.entryQuality });
      }
    }
    emit({ type: 'done' });
  } finally {
    try { env.close(); } catch (_) {}
  }
}

function runScanChild(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [
      __filename,
      '--scan-child',
      '--snapshot', args.snapshot,
      '--lmdb-module', args['lmdb-module'],
      '--cache-dir', args['cache-dir'],
      '--quality', args.quality || 'highest',
      ...('track-id' in args ? ['--track-id', args['track-id']] : []),
      ...('track-ids' in args ? ['--track-ids', args['track-ids']] : []),
      ...('scan-all' in args ? ['--scan-all'] : []),
      ...asUrlList(args['audio-url']).flatMap(url => ['--audio-url', url]),
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
      // execPath may be the Electron binary inside the desktop shell; never
      // rely on env inheritance alone (same guard as restore-service.js)
      env: { ...process.env, ELECTRON_RUN_AS_NODE: process.versions.electron ? '1' : process.env.ELECTRON_RUN_AS_NODE },
    });
    let output = '';
    const finish = value => {
      try { child.kill(); } catch (_) {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 30000);
    child.stdout.on('data', data => { output += data.toString(); });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const lines = output.trim().split(/\r?\n/).filter(Boolean);
        finish(lines.length ? JSON.parse(lines[lines.length - 1]) : null);
      } catch (_) {
        finish(null);
      }
    });
  });
}

async function scanWithRetry(scanArgs, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const snapshot = path.join(os.tmpdir(), `qsyy-entries-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    try {
      fs.copyFileSync(path.join(scanArgs['cache-dir'], 'entries.db'), snapshot);
      const result = await runScanChild({ ...scanArgs, snapshot });
      if (result) return result;
    } catch (_) {} finally {
      try { fs.unlinkSync(snapshot); } catch (_) {}
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['scan-child']) {
    emit(scanSnapshot(args));
    return;
  }
  // Bulk materialize: every ready client-cache chunk → <trackId>.m4a in
  // output-dir, one JSON line per track for live progress.
  if (args['restore-all']) {
    if (!args.snapshot || !args['output-dir']) throw new Error('restore-all requires --snapshot and --output-dir');
    restoreAllSnapshot(args);
    return;
  }

  const cacheDir = args['cache-dir'];
  const outputDir = args['output-dir'];
  const lmdbModule = args['lmdb-module'];
  const requestedQuality = normalizeQuality(args.quality);
  const audioUrls = asUrlList(args['audio-url']);
  const waitMs = Number(args['wait-ms']) || 120000;
  if (!cacheDir || !outputDir || !lmdbModule) throw new Error('cache-dir, output-dir and lmdb-module are required');

  fs.mkdirSync(outputDir, { recursive: true });
  const scanArgs = {
    'lmdb-module': lmdbModule,
    'cache-dir': cacheDir,
    quality: requestedQuality,
    ...(args['track-id'] ? { 'track-id': String(args['track-id']).trim() } : {}),
    ...(audioUrls.length ? { 'audio-url': audioUrls } : {}),
  };
  if (!scanArgs['track-id'] && !audioUrls.length) {
    throw new Error('trackId is required on macOS restore (no audio-url fallback provided)');
  }

  const startedAt = Date.now();
  for (;;) {
    const result = await scanWithRetry(scanArgs);
    const best = result?.candidates?.[0];
    if (best) {
      const extension = /M4A|NDSH/i.test(best.brand || '') ? 'm4a' : 'mp4';
      const target = path.join(outputDir, `.qsyy-restore-${best.chunkId}.${extension}`);
      const source = path.join(cacheDir, `${best.chunkId}.bin`);
      if (best.encryption?.encrypted && best.encryption.method === 'cenc-aes-ctr') {
        decryptMp4(source, target, Buffer.from(decodeSpadeA(best.encryption.spade), 'hex'));
      } else {
        fs.copyFileSync(source, target);
      }
      emit({
        ok: true,
        chunkId: best.chunkId,
        output: target,
        validated: true,
        size: best.size,
        quality: best.entryQuality,
        isPreview: best.isPreview,
        codec: 'AAC',
      });
      return;
    }
    if (Date.now() - startedAt >= waitMs) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  emit({ ok: false, error: `No matching resourceId or chunkId for track ${scanArgs['track-id'] || '(url match)'} (${requestedQuality})` });
}

main().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
