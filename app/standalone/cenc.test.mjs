import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decodeSpadeA, stripEncryptionBoxes, decryptMp4 } = require('../bridge/lib/cenc.js');

// Synthetic vectors (no real key material), each confirmed against the
// official client's device.node decodeSpade.
const VECTORS = [
  { spade: 'nbwT+1qyEf5fsxDjaZoS5myaK9JhmC3VYpsyykiwNM1LsTES+Q==', key: '0123456789abcdef0123456789abcdef' },
  { spade: 'p78pxFK9K8V6izTGeY0yx3iBBf15hwP+UbEe/1CzHPhXvko=', key: 'fedcba9876543210fedcba9876543210' },
  { spade: 'pLIi9Vu9IfddvSHxX7wX8129FO1flRPvXZUT6UOUEutBrTkpugZLMXA=', key: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' },
  { spade: 'k7MT9VuyEvtZshL5X7UR+0G2DvlfqSbQXakm0luuJdClrCY9oLRU16o=', key: '00112233445566778899aabbccddeeff' },
];

test('decodeSpadeA matches device.node on synthetic vectors', () => {
  for (const { spade, key } of VECTORS) assert.equal(decodeSpadeA(spade), key);
});

test('decodeSpadeA tolerates surrounding whitespace', () => {
  assert.equal(decodeSpadeA(`  ${VECTORS[0].spade}\n`), VECTORS[0].key);
});

test('decodeSpadeA throws instead of returning an unusable key', () => {
  assert.throws(() => decodeSpadeA(''), /too short/);
  assert.throws(() => decodeSpadeA(undefined), /too short/);
  assert.throws(() => decodeSpadeA('AAAAAAAAAAAAAAAAAAAAAAAA'));
  assert.throws(() => decodeSpadeA(VECTORS[0].spade.slice(0, 20)));
});

function box(type, ...children) {
  const body = Buffer.concat(children);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, body]);
}

function sampleEntry(type, sinf) {
  return box(type, Buffer.alloc(28), box('esds', Buffer.alloc(4)), ...(sinf ? [sinf] : []));
}

function mp4(entry) {
  const stsd = box('stsd', Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), entry);
  const stbl = box('stbl', stsd, box('stsz', Buffer.alloc(12)),
    box('senc', Buffer.alloc(8)), box('saio', Buffer.alloc(8)), box('saiz', Buffer.alloc(9)));
  const moov = box('moov', box('mvhd', Buffer.alloc(100)), box('pssh', Buffer.alloc(24)),
    box('trak', box('mdia', box('minf', stbl))));
  return Buffer.concat([box('ftyp', Buffer.from('M4A \0\0\0\0')), moov, box('mdat', Buffer.from('payload-bytes'))]);
}

const SINF = box('sinf', box('frma', Buffer.from('mp4a')), box('schm', Buffer.alloc(12)),
  box('schi', box('tenc', Buffer.alloc(24))));

test('stripEncryptionBoxes renames encryption boxes in place', () => {
  const buf = mp4(sampleEntry('enca', SINF));
  const before = Buffer.from(buf);
  const log = stripEncryptionBoxes(buf);
  assert.deepEqual(log, ['pssh', 'sinf', 'enca->mp4a', 'senc', 'saio', 'saiz']);
  assert.equal(buf.length, before.length);
  for (const type of ['enca', 'sinf', 'senc', 'saio', 'saiz', 'pssh']) {
    assert.equal(buf.indexOf(type, 0, 'ascii'), -1, `${type} left behind`);
  }
  const entryAt = before.indexOf('enca', 0, 'ascii');
  assert.equal(buf.toString('ascii', entryAt, entryAt + 4), 'mp4a');
  const mdatAt = before.indexOf('mdat', 0, 'ascii');
  assert.ok(buf.subarray(mdatAt).equals(before.subarray(mdatAt)));
});

test('stripEncryptionBoxes rejects input that is not encrypted', () => {
  assert.throws(() => stripEncryptionBoxes(mp4(sampleEntry('mp4a'))), /no encrypted sample entry/);
});

test('stripEncryptionBoxes rejects enca without frma', () => {
  const sinf = box('sinf', box('schm', Buffer.alloc(12)));
  assert.throws(() => stripEncryptionBoxes(mp4(sampleEntry('enca', sinf))), /enca without frma/);
});

// decryptMp4 round trip on a synthetic cenc-aes-ctr file: real stsz/stsc/stco/
// senc tables, two chunks with a gap between them, samples encrypted here
// with a known key.
const KEY = Buffer.from(VECTORS[0].key, 'hex');
const SIZES = [16, 23, 7, 40, 31];
const GAP = Buffer.from('gap!!');

function full(flags, body) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(flags);
  return Buffer.concat([head, body]);
}

function u32(...values) {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => buf.writeUInt32BE(value, i * 4));
  return buf;
}

function ivOf(i) {
  const iv = Buffer.alloc(8);
  iv.writeUInt32BE(0x1000 + i, 4);
  return iv;
}

function subsamplesOf(size) {
  return size >= 20
    ? [{ clear: 2, encrypted: 5 }, { clear: 3, encrypted: size - 13 }]
    : [{ clear: 2, encrypted: size - 5 }];
}

function encryptSample(plain, iv, subs) {
  const cipher = crypto.createCipheriv('aes-128-ctr', KEY, Buffer.concat([iv, Buffer.alloc(8)]));
  if (!subs) return cipher.update(plain);
  const out = Buffer.from(plain);
  let at = 0;
  for (const { clear, encrypted } of subs) {
    at += clear;
    cipher.update(plain.subarray(at, at + encrypted)).copy(out, at);
    at += encrypted;
  }
  return out;
}

function encryptedMp4({ subsamples = false } = {}) {
  const plains = SIZES.map((size, i) => Buffer.from(Array.from({ length: size }, (_, j) => (i * 31 + j * 7 + 1) & 0xff)));
  const subs = SIZES.map(size => (subsamples ? subsamplesOf(size) : null));
  const enc = plains.map((plain, i) => encryptSample(plain, ivOf(i), subs[i]));
  const chunk1 = Buffer.concat(enc.slice(0, 3));
  const chunk2 = Buffer.concat(enc.slice(3));
  const sencRows = SIZES.map((_, i) => {
    if (!subsamples) return ivOf(i);
    const count = Buffer.alloc(2);
    count.writeUInt16BE(subs[i].length);
    const rows = subs[i].map(({ clear, encrypted }) => {
      const row = Buffer.alloc(6);
      row.writeUInt16BE(clear, 0);
      row.writeUInt32BE(encrypted, 2);
      return row;
    });
    return Buffer.concat([ivOf(i), count, ...rows]);
  });
  const senc = full(subsamples ? 2 : 0, Buffer.concat([u32(SIZES.length), ...sencRows]));
  const tenc = full(0, Buffer.concat([Buffer.from([0, 0, 1, 8]), Buffer.alloc(16)]));
  const sinf = box('sinf', box('frma', Buffer.from('mp4a')), box('schm', Buffer.alloc(12)), box('schi', box('tenc', tenc)));
  const build = (first, second) => box('moov', box('trak', box('mdia', box('minf', box('stbl',
    box('stsd', full(0, u32(1)), sampleEntry('enca', sinf)),
    box('stsz', full(0, u32(0, SIZES.length, ...SIZES))),
    box('stsc', full(0, u32(2, 1, 3, 1, 2, 2, 1))),
    box('stco', full(0, u32(2, first, second))),
    box('senc', senc))))));
  const ftyp = box('ftyp', Buffer.from('M4A \0\0\0\0'));
  const base = ftyp.length + build(0, 0).length + 8;
  const second = base + chunk1.length + GAP.length;
  const file = Buffer.concat([ftyp, build(base, second), box('mdat', chunk1, GAP, chunk2)]);
  const offsets = [];
  let at = base;
  SIZES.forEach((size, i) => {
    if (i === 3) at = second;
    offsets.push(at);
    at += size;
  });
  return { file, plains, offsets, gapAt: base + chunk1.length };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qsyy-cenc-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let runs = 0;

function runDecrypt(file, key = KEY) {
  runs += 1;
  const source = path.join(tmp, `in-${runs}.mp4`);
  const destination = path.join(tmp, `out-${runs}.m4a`);
  fs.writeFileSync(source, file);
  const count = decryptMp4(source, destination, key);
  assert.ok(fs.readFileSync(source).equals(file), 'source file modified');
  return { count, output: fs.readFileSync(destination) };
}

for (const subsamples of [false, true]) {
  test(`decryptMp4 restores every sample (${subsamples ? 'subsamples' : 'full-sample'})`, () => {
    const { file, plains, offsets, gapAt } = encryptedMp4({ subsamples });
    const { count, output } = runDecrypt(file);
    assert.equal(count, SIZES.length);
    assert.equal(output.length, file.length);
    plains.forEach((plain, i) => {
      assert.ok(output.subarray(offsets[i], offsets[i] + plain.length).equals(plain), `sample ${i}`);
    });
    assert.ok(output.subarray(gapAt, gapAt + GAP.length).equals(GAP));
    for (const type of ['enca', 'sinf', 'senc']) {
      assert.equal(output.indexOf(type, 0, 'ascii'), -1, `${type} left behind`);
    }
  });
}

test('decryptMp4 with the wrong key does not yield the plaintext', () => {
  const { file, plains, offsets } = encryptedMp4();
  const { output } = runDecrypt(file, Buffer.from(VECTORS[1].key, 'hex'));
  assert.ok(!output.subarray(offsets[0], offsets[0] + plains[0].length).equals(plains[0]));
});

test('decryptMp4 rejects a file without CENC tables', () => {
  assert.throws(() => runDecrypt(mp4(sampleEntry('mp4a'))), /CENC audio sample tables not found/);
});
