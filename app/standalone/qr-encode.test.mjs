import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr, qrSvg, qrSvgDataUrl, dataCodewords } from './qr-encode.mjs';

const SCAN_URL = 'https://bff-pc.qishui.com/light/invoke/scan_login?token=6d81fc226078332d55dcd97df82d39a5_lf&os=Windows&computer_name=DESKTOP-ABC';

function assertFinder(modules, left, top) {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      assert.equal(modules[top + dy][left + dx], ring !== 2, `finder at ${left},${top} (${dx},${dy})`);
    }
  }
}

test('dataCodewords matches the ECC level M capacity table', () => {
  assert.equal(dataCodewords(1), 16);
  assert.equal(dataCodewords(8), 154);
  assert.equal(dataCodewords(40), 2334);
});

test('encodeQr picks the smallest version and size 4v+17', () => {
  assert.equal(encodeQr('a').version, 1);
  assert.equal(encodeQr('a'.repeat(14)).version, 1);
  assert.equal(encodeQr('a'.repeat(15)).version, 2);
  const qr = encodeQr(SCAN_URL);
  assert.equal(qr.size, qr.version * 4 + 17);
  assert.equal(qr.modules.length, qr.size);
  assert.ok(qr.modules.every((row) => row.length === qr.size));
});

test('encodeQr draws finder, timing and dark-module patterns', () => {
  const { size, modules } = encodeQr(SCAN_URL);
  assertFinder(modules, 0, 0);
  assertFinder(modules, size - 7, 0);
  assertFinder(modules, 0, size - 7);
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0);
    assert.equal(modules[i][6], i % 2 === 0);
  }
  assert.equal(modules[size - 8][8], true);
});

test('encodeQr rejects payloads beyond version 40', () => {
  assert.throws(() => encodeQr('a'.repeat(2400)), /too long/);
});

test('qrSvgDataUrl wraps a white-background SVG', () => {
  const svg = qrSvg('hello');
  assert.match(svg, /^<svg [^>]*viewBox="0 0 29 29"/);
  assert.match(svg, /fill="#fff"/);
  const url = qrSvgDataUrl('hello');
  assert.ok(url.startsWith('data:image/svg+xml;base64,'));
  assert.equal(Buffer.from(url.split(',')[1], 'base64').toString(), svg);
});
