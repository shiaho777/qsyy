'use strict';

// CENC helpers for 汽水 audio: spade_a → AES-128 key, and in-place removal of
// the encryption boxes after per-sample decryption.
//
// decodeSpadeA is ported from guowenye/qishui-api (src/audioDecryptor.js):
//   MIT License, Copyright (c) 2026 arrow
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the
//   "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to permit
//   persons to whom the Software is furnished to do so, subject to the
//   following conditions: The above copyright notice and this permission
//   notice shall be included in all copies or substantial portions of the
//   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

const crypto = require('crypto');
const fs = require('fs');

function decodeBase36(codePoint) {
  if (codePoint >= 48 && codePoint <= 57) return codePoint - 48;
  if (codePoint >= 97 && codePoint <= 122) return codePoint - 97 + 10;
  return 0xff;
}

function bitCount(number) {
  let value = number - ((number >> 1) & 0x55555555);
  value = (value & 0x33333333) + ((value >> 2) & 0x33333333);
  return (((value + (value >> 4)) & 0xf0f0f0f) * 0x1010101) >> 24;
}

function decryptSpadeInner(spadeKey) {
  const result = new Uint8Array(spadeKey);
  const buffer = new Uint8Array(2 + spadeKey.length);
  buffer.set([0xfa, 0x55], 0);
  buffer.set(spadeKey, 2);
  for (let index = 0; index < result.length; index += 1) {
    let value = (spadeKey[index] ^ buffer[index]) - bitCount(index) - 21;
    while (value < 0) value += 0xff;
    result[index] = value;
  }
  return result;
}

// Same result as the client's device.node decodeSpade (verified on 202 cache
// entries). Throws instead of returning '' so a bad key never reaches decrypt.
function decodeSpadeA(spadeA) {
  const bytes = new Uint8Array(Buffer.from(String(spadeA || '').trim(), 'base64'));
  const length = bytes.length;
  if (length < 3) throw new Error('spade_a too short');
  const paddingLength = (bytes[0] ^ bytes[1] ^ bytes[2]) - 48;
  if (paddingLength < 0 || length < paddingLength + 2) throw new Error('spade_a padding invalid');
  const decoded = decryptSpadeInner(bytes.slice(1, length - paddingLength));
  if (!decoded.length) throw new Error('spade_a empty');
  const skipBytes = decodeBase36(decoded[0]);
  const endIndex = 1 + (length - paddingLength - 2) - skipBytes;
  if (endIndex < 1 || endIndex > decoded.length) throw new Error('spade_a length invalid');
  const key = Buffer.from(decoded.slice(1, endIndex)).toString('utf8').trim();
  if (!/^[0-9a-f]{32}$/i.test(key)) throw new Error('spade_a did not decode to an AES-128 key');
  return key.toLowerCase();
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta']);
const DROP = new Set(['sinf', 'senc', 'saio', 'saiz', 'pssh']);

function findFrma(buf, start, end) {
  let off = start;
  while (off + 8 <= end) {
    const size = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (size < 8 || off + size > end) return '';
    if (type === 'sinf') {
      let o = off + 8;
      while (o + 8 <= off + size) {
        const s = buf.readUInt32BE(o);
        if (buf.toString('ascii', o + 4, o + 8) === 'frma') return buf.toString('ascii', o + 8, o + 12);
        if (s < 8) break;
        o += s;
      }
    }
    off += size;
  }
  return '';
}

function walk(buf, start, end, log) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); header = 16; }
    else if (size === 0) size = end - off;
    if (size < 8 || off + size > end) break;
    if (DROP.has(type)) { buf.write('free', off + 4, 'ascii'); log.push(type); }
    else if (CONTAINERS.has(type)) walk(buf, off + header, off + size, log);
    else if (type === 'stsd') walk(buf, off + header + 8, off + size, log);
    else if (type === 'enca' || type === 'encv') {
      const childStart = off + header + (type === 'enca' ? 28 : 78);
      const frma = findFrma(buf, childStart, off + size);
      if (!frma) throw new Error(`${type} without frma`);
      walk(buf, childStart, off + size, log);
      buf.write(frma, off + 4, 'ascii');
      log.push(`${type}->${frma}`);
    }
    off += size;
  }
}

// After per-sample decryption the file still declares itself encrypted
// (enca + sinf/senc/…), which AVFoundation refuses to open. Rename those boxes
// in place — enca back to its frma format, the rest to free — so sizes and
// every chunk offset stay valid without a remux.
function stripEncryptionBoxes(buf) {
  const log = [];
  walk(buf, 0, buf.length, log);
  if (!log.some(item => item.startsWith('enca') || item.startsWith('encv'))) {
    throw new Error('no encrypted sample entry found');
  }
  return log;
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
  stripEncryptionBoxes(output);
  fs.writeFileSync(destination, output);
  return samples.length;
}

module.exports = { decodeSpadeA, stripEncryptionBoxes, decryptMp4 };
