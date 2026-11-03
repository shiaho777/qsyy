import test from 'node:test';
import assert from 'node:assert/strict';
import { lrcStamp, parseLrcBlock, buildLyrics } from './lyrics.mjs';

test('lrcStamp formats mm:ss.cs', () => {
  assert.equal(lrcStamp(0), '00:00.00');
  assert.equal(lrcStamp(61234), '01:01.23');
  assert.equal(lrcStamp(600000), '10:00.00');
});

test('parseLrcBlock keeps stamped non-empty lines and pads fractions to ms', () => {
  const out = parseLrcBlock('[00:01.50]hello\n[00:02]\nnot lrc\n[01:00.123]x');
  assert.deepEqual(out, [
    { ms: 1500, text: 'hello' },
    { ms: 60123, text: 'x' },
  ]);
  assert.deepEqual(parseLrcBlock(undefined), []);
});

test('buildLyrics returns null without usable content', () => {
  assert.equal(buildLyrics(null), null);
  assert.equal(buildLyrics({ lyric: { content: '' } }), null);
  assert.equal(buildLyrics({ lyric: { content: 'no stamps here' } }), null);
});

test('buildLyrics parses karaoke words and pairs translations by ms', () => {
  const built = buildLyrics({
    name: 'Song',
    lyric: {
      content: '[1000,2000]<0,500,0>Hel<500,500,0>lo\n[3000,1000]<0,1000,0>World',
      cn: '[00:01.00]你好\n[00:03.00]世界',
    },
  });
  assert.equal(built.v, 2);
  assert.equal(built.name, 'Song');
  assert.deepEqual(built.lines, [
    {
      ms: 1000, dur: 2000, text: 'Hello', cn: '你好',
      words: [{ t: 1000, d: 500, w: 'Hel' }, { t: 1500, d: 500, w: 'lo' }],
    },
    {
      ms: 3000, dur: 1000, text: 'World', cn: '世界',
      words: [{ t: 3000, d: 1000, w: 'World' }],
    },
  ]);
  assert.equal(built.lrc, '[00:01.00]Hello\n[00:01.00]你好\n[00:03.00]World\n[00:03.00]世界');
});

test('buildLyrics keeps untagged karaoke lines as plain text', () => {
  const built = buildLyrics({ lyric: { content: '[1000,500]plain text' } });
  assert.deepEqual(built.lines, [{ ms: 1000, dur: 500, text: 'plain text', words: null }]);
});

test('buildLyrics falls back to plain LRC and sorts by time', () => {
  const built = buildLyrics({ lyric: { content: '[00:05.00]B\n[00:01.00]A' } });
  assert.equal(built.name, '');
  assert.deepEqual(built.lines, [
    { ms: 1000, dur: 0, text: 'A', words: null },
    { ms: 5000, dur: 0, text: 'B', words: null },
  ]);
  assert.equal(built.lrc, '[00:01.00]A\n[00:05.00]B');
});

test('buildLyrics pairs translations by index only when line counts match', () => {
  const content = '[1000,500]<0,500,0>a\n[2000,500]<0,500,0>b';
  const paired = buildLyrics({ lyric: { content, cn: '[00:01.10]甲\n[00:02.10]乙' } });
  assert.deepEqual(paired.lines.map(l => l.cn), ['甲', '乙']);
  const unpaired = buildLyrics({ lyric: { content, cn: '[00:01.10]甲' } });
  assert.deepEqual(unpaired.lines.map(l => l.cn), [undefined, undefined]);
});
