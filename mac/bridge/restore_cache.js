'use strict';

// macOS port of the Windows restore_cache.js contract.
// Reads the Soda Music (Mac) LunaCacheV2 index with lmdb, locates the cached
// chunk for a track, and copies it out as a plain media file. The Mac client
// stores cache files unencrypted, so no device.node step is needed.
//
// The live entries.db can abort an lmdb open while the client writes to it,
// so every scan runs against a fresh file snapshot inside a forked child; a
// crashed child is simply retried with a new snapshot.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

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

// ---------------------------------------------------------------------------
// CENC (cenc-aes-ctr) sample decryption, ported from the official
// QiShuiMusicPlugins restore_cache.js (GPL-3.0, same project family).

function readBox(buffer, offset, end) {
  if (offset + 8 > end) return undefined;
  let size = buffer.readUInt32BE(offset);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > end) throw new Error('Invalid extended MP4 box');
    size = Number(buffer.readBigUInt64BE(offset + 8));
    header = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < header || offset + size > end) throw new Error(`Invalid MP4 box at ${offset}`);
  return { type: buffer.toString('ascii', offset + 4, offset + 8), offset, size, header, payload: offset + header, end: offset + size };
}

function childBoxes(buffer, parent) {
  const result = [];
  for (let offset = parent.payload; offset + 8 <= parent.end;) {
    const box = readBox(buffer, offset, parent.end);
    if (!box) break;
    result.push(box);
    offset += box.size;
  }
  return result;
}

function descendants(buffer, parent, type) {
  const result = [];
  for (const child of childBoxes(buffer, parent)) {
    if (child.type === type) result.push(child);
    if (!['mdat', 'free', 'skip', 'wide'].includes(child.type)) {
      try { result.push(...descendants(buffer, child, type)); } catch (_) {}
    }
  }
  return result;
}

function findRawBox(buffer, type, start, end) {
  for (let cursor = start + 4; cursor + 4 <= end; cursor += 1) {
    if (buffer.toString('ascii', cursor, cursor + 4) !== type) continue;
    const box = readBox(buffer, cursor - 4, end);
    if (box && box.type === type) return box;
  }
  return undefined;
}

function findTrackTables(buffer) {
  const first = readBox(buffer, 0, buffer.length);
  const moov = first.type === 'ftyp' ? readBox(buffer, first.size, buffer.length) : first;
  if (!moov || moov.type !== 'moov') throw new Error('MP4 moov box not found');
  for (const stbl of descendants(buffer, moov, 'stbl')) {
    const direct = childBoxes(buffer, stbl);
    const byType = type => direct.find(box => box.type === type);
    const stco = byType('stco') || byType('co64');
    const stsc = byType('stsc');
    const stsz = byType('stsz');
    const senc = byType('senc');
    if (stco && stsc && stsz && senc) {
      const stsd = byType('stsd');
      const tenc = stsd && findRawBox(buffer, 'tenc', stsd.payload, stsd.end);
      return { stco, stsc, stsz, senc, tenc };
    }
  }
  throw new Error('CENC audio sample tables not found');
}

function parseSampleTables(buffer, tables) {
  const { stco, stsc, stsz, senc, tenc } = tables;
  const read = offset => buffer.readUInt32BE(offset);
  const stscCount = read(tables.stsc.payload + 4);
  const stscEntries = [];
  for (let i = 0; i < stscCount; i += 1) {
    const offset = tables.stsc.payload + 8 + i * 12;
    stscEntries.push({ firstChunk: read(offset), samplesPerChunk: read(offset + 4) });
  }
  const fixedSampleSize = read(stsz.payload + 4);
  const sampleCount = read(stsz.payload + 8);
  const sampleSizes = fixedSampleSize
    ? Array(sampleCount).fill(fixedSampleSize)
    : Array.from({ length: sampleCount }, (_, i) => read(stsz.payload + 12 + i * 4));
  const chunkCount = read(stco.payload + 4);
  const chunkOffsets = Array.from({ length: chunkCount }, (_, i) => {
    const offset = stco.payload + 8 + i * (stco.type === 'co64' ? 8 : 4);
    return stco.type === 'co64' ? Number(buffer.readBigUInt64BE(offset)) : read(offset);
  });

  let ivSize = 8;
  let constantIv;
  if (tenc) {
    const version = buffer[tenc.payload];
    const candidates = version === 0
      ? [tenc.payload + 6, tenc.payload + 7]
      : [tenc.payload + 7, tenc.payload + 8];
    const field = candidates.find(offset => [8, 16].includes(buffer[offset])) || candidates[0];
    ivSize = buffer[field];
    if (!ivSize) {
      const constantSize = buffer[field + 16];
      constantIv = buffer.subarray(field + 17, field + 17 + constantSize);
      ivSize = constantIv.length;
    }
  }
  if (![8, 16].includes(ivSize)) throw new Error(`Unsupported CENC IV size: ${ivSize}`);

  const sencFlags = read(senc.payload) & 0x00ffffff;
  const sencCount = read(senc.payload + 4);
  if (sencCount !== sampleCount) throw new Error(`senc/stsz count mismatch: ${sencCount}/${sampleCount}`);
  const samples = [];
  let cursor = senc.payload + 8;
  for (let i = 0; i < sencCount; i += 1) {
    const iv = constantIv || buffer.subarray(cursor, cursor + ivSize);
    if (!constantIv) cursor += ivSize;
    const subsamples = [];
    if (sencFlags & 2) {
      const count = buffer.readUInt16BE(cursor);
      cursor += 2;
      for (let j = 0; j < count; j += 1) {
        subsamples.push({ clear: buffer.readUInt16BE(cursor), encrypted: read(cursor + 2) });
        cursor += 6;
      }
    }
    samples.push({ iv: Buffer.from(iv), subsamples });
  }

  const offsets = [];
  let sampleIndex = 0;
  for (let chunk = 1; chunk <= chunkCount; chunk += 1) {
    let entry = stscEntries[0];
    for (const candidate of stscEntries) {
      if (candidate.firstChunk <= chunk) entry = candidate;
      else break;
    }
    let offset = chunkOffsets[chunk - 1];
    for (let i = 0; i < entry.samplesPerChunk && sampleIndex < sampleCount; i += 1) {
      offsets.push({ offset, size: sampleSizes[sampleIndex], ...samples[sampleIndex] });
      offset += sampleSizes[sampleIndex];
      sampleIndex += 1;
    }
  }
  if (sampleIndex !== sampleCount) throw new Error(`Sample table ended early: ${sampleIndex}/${sampleCount}`);
  return offsets;
}

function decryptSample(input, key, sample) {
  const iv = sample.iv.length === 16 ? sample.iv : Buffer.concat([sample.iv, Buffer.alloc(16 - sample.iv.length)]);
  const decipher = crypto.createDecipheriv('aes-128-ctr', key, iv);
  if (!sample.subsamples.length) return Buffer.concat([decipher.update(input), decipher.final()]);
  const output = Buffer.alloc(input.length);
  let sourceOffset = 0;
  let outputOffset = 0;
  for (const part of sample.subsamples) {
    input.copy(output, outputOffset, sourceOffset, sourceOffset + part.clear);
    sourceOffset += part.clear;
    outputOffset += part.clear;
    const encrypted = input.subarray(sourceOffset, sourceOffset + part.encrypted);
    const plaintext = decipher.update(encrypted);
    plaintext.copy(output, outputOffset);
    sourceOffset += part.encrypted;
    outputOffset += plaintext.length;
  }
  input.copy(output, outputOffset, sourceOffset);
  const tail = decipher.final();
  if (tail.length) tail.copy(output, outputOffset);
  return output;
}

function decryptMp4(source, destination, key) {
  const input = fs.readFileSync(source);
  const tables = findTrackTables(input);
  const samples = parseSampleTables(input, tables);
  const output = Buffer.from(input);
  for (const sample of samples) {
    if (sample.offset < 0 || sample.offset + sample.size > input.length) throw new Error(`Sample outside file at ${sample.offset}`);
    const encrypted = input.subarray(sample.offset, sample.offset + sample.size);
    const plaintext = decryptSample(encrypted, key, sample);
    if (plaintext.length !== sample.size) throw new Error('Decrypted sample size changed');
    plaintext.copy(output, sample.offset);
  }
  fs.writeFileSync(destination, output);
  return samples.length;
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
      ...asUrlList(args['audio-url']).flatMap(url => ['--audio-url', url]),
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
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
  // Decrypt a standalone encrypted MP4 (e.g. downloaded from the online CDN)
  // using the spade_a key material that came with its play URL.
  if (args['decrypt-online']) {
    const input = args['input'];
    const output = args['output'];
    const spade = args['spade'];
    const devicePath = args['device-node'];
    if (!input || !output || !spade || !devicePath) {
      throw new Error('decrypt-online requires --input, --output, --spade, --device-node');
    }
    const device = require(path.resolve(devicePath));
    if (typeof device.decodeSpade !== 'function') throw new Error('device.node has no decodeSpade');
    const keyHex = device.decodeSpade(spade);
    if (!/^[0-9a-f]{32}$/i.test(String(keyHex))) throw new Error('decodeSpade did not return an AES-128 key');
    const decrypted = `${output}.dec.m4a`;
    const samples = decryptMp4(path.resolve(input), decrypted, Buffer.from(String(keyHex), 'hex'));
    if (args.ffmpeg && fs.existsSync(args.ffmpeg)) {
      const { spawnSync } = require('child_process');
      const remux = spawnSync(args.ffmpeg, ['-y', '-v', 'error', '-i', decrypted, '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', output], { encoding: 'utf8' });
      if (remux.status === 0 && fs.existsSync(output)) {
        fs.unlinkSync(decrypted);
        emit({ ok: true, output, samples });
        return;
      }
    }
    fs.renameSync(decrypted, output);
    emit({ ok: true, output, samples });
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
        const devicePath = args['device-node'];
        if (!devicePath) throw new Error('encrypted audio requires --device-node');
        const device = require(path.resolve(devicePath));
        if (typeof device.decodeSpade !== 'function') throw new Error('device.node has no decodeSpade');
        const keyHex = device.decodeSpade(best.encryption.spade);
        if (!/^[0-9a-f]{32}$/i.test(String(keyHex))) throw new Error('decodeSpade did not return an AES-128 key');
        const decrypted = path.join(outputDir, `.qsyy-restore-${best.chunkId}.dec.${extension}`);
        const samples = decryptMp4(source, decrypted, Buffer.from(String(keyHex), 'hex'));
        if (args.ffmpeg && args.ffmpeg !== 'ffmpeg' ? fs.existsSync(args.ffmpeg) : true) {
          try {
            const { spawnSync } = require('child_process');
            const remux = spawnSync(args.ffmpeg || 'ffmpeg', ['-y', '-v', 'error', '-i', decrypted, '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', target], { encoding: 'utf8' });
            if (remux.status === 0 && fs.existsSync(target)) {
              fs.unlinkSync(decrypted);
              emit({ ok: true, chunkId: best.chunkId, output: target, validated: true, size: best.size, quality: best.entryQuality, isPreview: best.isPreview, codec: 'AAC', samples });
              return;
            }
          } catch (_) {}
        }
        fs.renameSync(decrypted, target);
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
