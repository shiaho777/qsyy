import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFoliaLyricPayload } from './lyric-api.mjs';

const track = { id: 't1', title: 'Idol', artist: 'YOASOBI' };

test('null / v1 / empty inputs produce null', () => {
  assert.equal(buildFoliaLyricPayload({ track, lyrics: null }), null);
  assert.equal(buildFoliaLyricPayload({ track }), null);
  assert.equal(buildFoliaLyricPayload(), null);
  // v1 shape: lrc only, no lines
  assert.equal(buildFoliaLyricPayload({ track, lyrics: { v: 1, lrc: '[00:01.00]hi' } }), null);
  assert.equal(buildFoliaLyricPayload({ track, lyrics: { v: 2, lines: [] } }), null);
  assert.equal(buildFoliaLyricPayload({ track, lyrics: { v: 2, lines: [{ ms: 0, text: '   ' }] } }), null);
});

test('line-level lyrics synthesize words per character for CJK', () => {
  const payload = buildFoliaLyricPayload({
    track,
    lyrics: { v: 2, lines: [{ ms: 1000, dur: 2000, text: '你好世界' }] },
  });
  assert.equal(payload.wordByWord, false);
  assert.equal(payload.offset, 0);
  assert.equal(payload.clipStartMs, 0);
  assert.equal(payload.title, 'Idol');
  assert.equal(payload.artist, 'YOASOBI');
  const [line] = payload.lines;
  assert.equal(line.startTime, 1);
  assert.equal(line.endTime, 3);
  assert.equal(line.words.length, 4);
  assert.deepEqual(line.words[0], { text: '你', startTime: 1, endTime: 1.5 });
  assert.deepEqual(line.words[3], { text: '界', startTime: 2.5, endTime: 3 });
  assert.equal(line.words.map(w => w.text).join(''), '你好世界');
});

test('whitespace-delimited text splits per word, mixed CJK falls back to chars', () => {
  const payload = buildFoliaLyricPayload({
    track: {},
    lyrics: {
      v: 2,
      lines: [
        { ms: 0, dur: 3000, text: 'hello wide world' },
        { ms: 3000, dur: 2000, text: '你好world' },
      ],
    },
  });
  const [en, mixed] = payload.lines;
  assert.equal(en.words.length, 3);
  assert.deepEqual(en.words.map(w => w.text), ['hello ', 'wide ', 'world']);
  assert.deepEqual(en.words[0], { text: 'hello ', startTime: 0, endTime: 1 });
  // no whitespace between CJK and Latin → per-character split
  assert.equal(mixed.words.length, 7);
  assert.equal(mixed.words.map(w => w.text).join(''), '你好world');
  // empty track strings omit title/artist fields entirely
  assert.equal('title' in payload, false);
  assert.equal('artist' in payload, false);
});

test('native word timings pass through and flip wordByWord', () => {
  const payload = buildFoliaLyricPayload({
    track,
    lyrics: {
      v: 2,
      lines: [
        { ms: 0, dur: 1000, text: 'plain line' },
        {
          ms: 1000,
          dur: 2000,
          text: 'ka ra ok',
          words: [
            { t: 1000, d: 500, w: 'ka' },
            { t: 1500, d: 500, w: 'ra' },
            { t: 2000, d: 1000, w: 'ok' },
            { t: 2500, d: 100, w: '  ' }, // blank word dropped
          ],
        },
      ],
    },
  });
  assert.equal(payload.wordByWord, true);
  const karaoke = payload.lines[1];
  assert.deepEqual(karaoke.words[0], { text: 'ka', startTime: 1, endTime: 1.5 });
  assert.deepEqual(karaoke.words[2], { text: 'ok', startTime: 2, endTime: 3 });
  assert.equal(karaoke.words.length, 3);
  // the line without native words is still synthesized
  assert.equal(payload.lines[0].words.length, 2);
});

test('offset accepts negatives and clamps to ±10000', () => {
  const make = offset => buildFoliaLyricPayload({
    track,
    lyrics: { v: 2, offset, lines: [{ ms: 0, dur: 1000, text: 'x' }] },
  }).offset;
  assert.equal(make(-250), -250);
  assert.equal(make(300), 300);
  assert.equal(make(99999), 10000);
  assert.equal(make(-99999), -10000);
  assert.equal(make('nonsense'), 0);
});

test('endTime fallback chain: dur → next ms → +4s, floor +0.2s', () => {
  const payload = buildFoliaLyricPayload({
    track,
    lyrics: {
      v: 2,
      lines: [
        { ms: 0, dur: 0, text: 'a' }, // no dur → next line ms = 5000
        { ms: 5000, dur: 0, text: 'b' }, // last, no dur → +4s = 9
        { ms: 9000, dur: 50, text: 'c' }, // tiny dur → floor start + 0.2
      ],
    },
  });
  // rows keep index order (source is sorted); chain uses the next row
  assert.equal(payload.lines[0].endTime, 5);
  assert.equal(payload.lines[1].endTime, 9);
  assert.equal(payload.lines[2].endTime, 9.2);
});

test('translations pass through when non-empty, blank lines are filtered', () => {
  const payload = buildFoliaLyricPayload({
    track,
    lyrics: {
      v: 2,
      lines: [
        { ms: 0, dur: 1000, text: 'hello', cn: '你好' },
        { ms: 1000, dur: 1000, text: '  ' }, // filtered
        { ms: 2000, dur: 1000, text: 'bye', cn: '   ' }, // blank cn omitted
      ],
    },
  });
  assert.equal(payload.lines.length, 2);
  assert.equal(payload.lines[0].translation, '你好');
  assert.equal('translation' in payload.lines[1], false);
  // blank row removed before the fallback chain: line 0 falls to +4s? no —
  // it has dur; line 1 is last with dur so its own end is used
  assert.equal(payload.lines[1].endTime, 3);
});

test('times are rounded to 3 decimals', () => {
  const payload = buildFoliaLyricPayload({
    track,
    lyrics: { v: 2, lines: [{ ms: 1234, dur: 999, text: 'ab' }] },
  });
  const [line] = payload.lines;
  assert.equal(line.startTime, 1.234);
  assert.equal(line.endTime, 2.233);
  assert.equal(line.words[0].endTime, 1.734); // 1234 + 999/2 = 1733.5 → round
});

test('TTML background vocals map to backgroundVocals with words and translation', () => {
  const payload = buildFoliaLyricPayload({
    track,
    lyrics: {
      v: 2,
      lines: [{
        ms: 1000, dur: 3000, text: 'main line', roman: 'main ro-man',
        bg: {
          ms: 2000, dur: 1500, text: '(oh yeah)', cn: '背景翻译', roman: 'bg ro-man',
          words: [{ t: 2000, d: 500, w: '(oh' }, { t: 2500, d: 1000, w: ' yeah)' }],
        },
      }],
    },
  });
  const [line] = payload.lines;
  assert.equal(line.romanization, 'main ro-man');
  assert.equal(line.backgroundVocals.length, 1);
  const [vocal] = line.backgroundVocals;
  assert.equal(vocal.text, '(oh yeah)');
  assert.equal(vocal.startTime, 2);
  assert.equal(vocal.endTime, 3.5);
  assert.equal(vocal.translation, '背景翻译');
  assert.equal(vocal.romanization, 'bg ro-man');
  assert.deepEqual(vocal.words[0], { text: '(oh', startTime: 2, endTime: 2.5 });
});

test('background vocals without words synthesize; blank bg is omitted', () => {
  const payload = buildFoliaLyricPayload({
    track,
    lyrics: {
      v: 2,
      lines: [
        { ms: 0, dur: 2000, text: 'a', bg: { ms: 500, dur: 0, text: '嗯嗯' } },
        { ms: 2000, dur: 1000, text: 'b', bg: { ms: 2000, text: '  ' } },
      ],
    },
  });
  const [first, second] = payload.lines;
  assert.equal(first.backgroundVocals[0].endTime, 2.5); // dur 0 → +2s default
  assert.equal(first.backgroundVocals[0].words.length, 2);
  assert.equal('translation' in first.backgroundVocals[0], false);
  assert.equal('backgroundVocals' in second, false);
});
