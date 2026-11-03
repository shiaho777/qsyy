import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { crc32, dosDateTime, zipBuildStream, zipParse } from './zip.mjs';

function centralMethods(buf) {
  const methods = {};
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054B50) eocd -= 1;
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < buf.readUInt16LE(eocd + 10); n += 1) {
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    methods[name] = buf.readUInt16LE(p + 10);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return methods;
}

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('dosDateTime packs local date and time', () => {
  const { time, day } = dosDateTime(new Date(2024, 0, 15, 13, 45, 30));
  assert.equal(time, (13 << 11) | (45 << 5) | 15);
  assert.equal(day, (44 << 9) | (1 << 5) | 15);
});

test('zipBuildStream output round-trips through zipParse', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsyy-zip-'));
  try {
    const json = Buffer.from(JSON.stringify({ v: 1, sets: [{ name: '歌单', songs: ['1', '2'] }] }).repeat(20));
    const audio = crypto.randomBytes(4096);
    const entries = [
      { name: 'set.json', data: json, deflate: true },
      { name: '歌曲/a.m4a', data: audio },
      { name: 'empty.txt', data: Buffer.alloc(0), deflate: true },
    ];
    const out = path.join(dir, 'lib-qsyy.zip');
    await zipBuildStream(entries, out);
    const buf = fs.readFileSync(out);

    assert.deepEqual(centralMethods(buf), { 'set.json': 8, '歌曲/a.m4a': 0, 'empty.txt': 0 });
    const parsed = zipParse(buf);
    assert.deepEqual(parsed.map(e => e.name), entries.map(e => e.name));
    for (let i = 0; i < entries.length; i += 1) {
      assert.ok(parsed[i].data.equals(entries[i].data), entries[i].name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('zipParse rejects buffers without an end-of-central-directory record', () => {
  assert.throws(() => zipParse(Buffer.alloc(64)), /EOCD/);
});
