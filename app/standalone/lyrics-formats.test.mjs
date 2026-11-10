import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLyricFormat, parseLyricText, parseLyricFile } from './lyrics.mjs';

test('detectLyricFormat recognises local lyric formats', () => {
  assert.equal(detectLyricFormat('[00:01.00]A'), 'lrc');
  assert.equal(detectLyricFormat('[00:01.00]<00:01.50>Hi'), 'enhanced-lrc');
  assert.equal(detectLyricFormat('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi'), 'vtt');
  assert.equal(detectLyricFormat('<tt xmlns="http://www.w3.org/ns/ttml"><body><p begin="1s" end="2s">Hi</p></body></tt>'), 'ttml');
  assert.equal(detectLyricFormat('[1000,500]<0,500,0>Hi'), 'krc');
  assert.equal(detectLyricFormat('[1000,500](1000,500,0)Hi'), 'yrc');
  assert.equal(detectLyricFormat('[1000,500]<0,500,0>Hi', 'track.qrc'), 'qrc');
});

test('plain LRC honours [offset:] and multiple timestamps', () => {
  const built = parseLyricText('[offset:500]\n[00:01.00][00:03.00]A\n[00:02.00]B');
  assert.deepEqual(built.lines.map(line => [line.ms, line.text]), [[1500, 'A'], [2500, 'B'], [3500, 'A']]);
});

test('enhanced LRC keeps word timings and translation', () => {
  const built = parseLyricText('[00:01.00]<00:01.00>Hel<00:01.50>lo', {
    translation: '[00:01.00]你好',
  });
  assert.equal(built.lines[0].text, 'Hello');
  assert.equal(built.lines[0].cn, '你好');
  assert.deepEqual(built.lines[0].words, [
    { t: 1000, d: 0, w: 'Hel' },
    { t: 1500, d: 0, w: 'lo' },
  ]);
});

test('WebVTT parses cues, durations and partial word tags without losing text', () => {
  const built = parseLyricText([
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:03.000',
    '<v Singer>Hello <00:00:01.500>world</v>',
  ].join('\n'));
  assert.equal(built.lines.length, 1);
  assert.equal(built.lines[0].ms, 1000);
  assert.equal(built.lines[0].dur, 2000);
  assert.equal(built.lines[0].text, 'Hello world');
  assert.equal(built.lines[0].words, null);
});

test('WebVTT full-line word tags use absolute hh:mm:ss times', () => {
  const built = parseLyricText([
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:03.000',
    '<00:00:01.000>Hel<00:00:01.500>lo',
  ].join('\n'));
  assert.equal(built.lines[0].text, 'Hello');
  assert.deepEqual(built.lines[0].words, [
    { t: 1000, d: 0, w: 'Hel' },
    { t: 1500, d: 0, w: 'lo' },
  ]);
});

test('TTML parses paragraph and span timings', () => {
  const built = parseLyricText([
    '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">',
    '<body><div>',
    '<p begin="00:00:01.000" end="00:00:03.000">',
    '<span begin="00:00:01.000" end="00:00:01.500">Hel</span>',
    '<span begin="00:00:01.500" end="00:00:03.000">lo</span>',
    '</p></div></body></tt>',
  ].join(''));
  assert.equal(built.lines[0].ms, 1000);
  assert.equal(built.lines[0].dur, 2000);
  assert.equal(built.lines[0].text, 'Hello');
  assert.deepEqual(built.lines[0].words, [
    { t: 1000, d: 500, w: 'Hel' },
    { t: 1500, d: 1500, w: 'lo' },
  ]);
});

test('QRC and YRC word tags resolve to absolute milliseconds', () => {
  const qrc = parseLyricText('[1000,2000]<0,500,0>Hel<500,500,0>lo', { format: 'qrc' });
  assert.equal(qrc.lines[0].text, 'Hello');
  assert.deepEqual(qrc.lines[0].words, [
    { t: 1000, d: 500, w: 'Hel' },
    { t: 1500, d: 500, w: 'lo' },
  ]);

  const yrc = parseLyricText('[1000,2000](1000,500,0)Hel(1500,500,0)lo', { format: 'yrc' });
  assert.equal(yrc.lines[0].text, 'Hello');
  assert.deepEqual(yrc.lines[0].words, [
    { t: 1000, d: 500, w: 'Hel' },
    { t: 1500, d: 500, w: 'lo' },
  ]);
});

test('parseLyricFile picks the format from the file extension', () => {
  const built = parseLyricFile('[00:01.00]A', 'track.lrc');
  assert.equal(built.lines[0].text, 'A');
  const vtt = parseLyricFile('WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nB', 'track.vtt');
  assert.equal(vtt.lines[0].ms, 2000);
});

test('invalid or empty lyric text returns null', () => {
  assert.equal(parseLyricText(''), null);
  assert.equal(parseLyricText('   '), null);
  assert.equal(parseLyricText('not lyrics at all'), null);
  assert.equal(parseLyricFile('', 'track.lrc'), null);
});
