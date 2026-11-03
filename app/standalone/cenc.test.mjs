import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decodeSpadeA, stripEncryptionBoxes } = require('../bridge/lib/cenc.js');

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
