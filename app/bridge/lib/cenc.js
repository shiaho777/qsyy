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

module.exports = { decodeSpadeA, stripEncryptionBoxes };
