import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTtmlIndex,
  normalizeTitle,
  normalizeArtist,
  matchTtmlEntry,
  searchTtmlEntries,
  ttmlIndexUrls,
  ttmlFileUrls,
  hasWordTimings,
  TTML_DB_PREFIXES,
} from './ttml-db.mjs';

// Inline sample mirrors the real ncm-lyrics/index.jsonl line format.
const idxRow = (id, name, artists, file, author = 'Steve-xmh') => JSON.stringify({
  id,
  metadata: [
    ['album', ['Test Album']],
    ['artists', artists],
    ['musicName', [name]],
    ['ncmMusicId', [id]],
    ['ttmlAuthorGithubLogin', [author]],
  ],
  rawLyricFile: file,
});

const SAMPLE = [
  idxRow('2048982668', 'Idol', ['YOASOBI'], 'old-idol.ttml'),
  'not json at all {{{',
  '',
  JSON.stringify({ id: 'x', metadata: [['musicName', ['NoFile']]] }), // no rawLyricFile
  JSON.stringify({ id: 'x', metadata: [['musicName', ['BadFile']]], rawLyricFile: '../escape.ttml' }),
  idxRow('2048982668', 'Idol', ['YOASOBI'], 'new-idol.ttml', 'mizuhara37'),
  idxRow('1921983207', 'ラグトレイン', ['稲葉曇', '歌愛ユキ'], 'lagtrain.ttml'),
  idxRow('111', 'Hello', ['Adele'], 'hello-adele.ttml'),
  idxRow('222', 'Hello', ['OMFG'], 'hello-omfg.ttml'),
  idxRow('333', 'Solo Song', [], 'solo.ttml'),
].join('\n');

test('parseTtmlIndex maps metadata pairs and skips bad lines', () => {
  const index = parseTtmlIndex(SAMPLE);
  const idol = index.get('idol');
  assert.equal(idol.length, 2);
  assert.deepEqual(idol[1], {
    musicName: 'Idol',
    artists: ['YOASOBI'],
    album: 'Test Album',
    ncmId: '2048982668',
    author: 'mizuhara37',
    file: 'new-idol.ttml',
  });
  assert.equal(index.has('nofile'), false);
  assert.equal(index.has('badfile'), false);
  assert.deepEqual(index.get('ラグトレイン')[0].artists, ['稲葉曇', '歌愛ユキ']);
});

test('normalizeTitle folds width/case/space and strips only feat/prod/with segments', () => {
  assert.equal(normalizeTitle('Ｉｄｏｌ'), 'idol');
  assert.equal(normalizeTitle('  Idol   （feat. Ayase） '), 'idol');
  assert.equal(normalizeTitle('Song (prod. someone) [feat. x]'), 'song');
  assert.equal(normalizeTitle('Song (with friend)'), 'song');
  assert.equal(normalizeTitle('Song [Live]'), 'song [live]');
  assert.equal(normalizeTitle('Song (Remix)'), 'song (remix)');
});

test('normalizeArtist folds width, case and whitespace', () => {
  assert.equal(normalizeArtist('  ＹＯＡＳＯＢＩ　 '), 'yoasobi');
  assert.equal(normalizeArtist(null), '');
});

test('matchTtmlEntry prefers artist intersection and newest upload', () => {
  const index = parseTtmlIndex(SAMPLE);
  const hit = matchTtmlEntry(index, { title: 'Idol', artist: 'YOASOBI' });
  assert.equal(hit.file, 'new-idol.ttml');
  assert.equal(hit.author, 'mizuhara37');
  // multi-artist entry matches on any one artist
  assert.equal(matchTtmlEntry(index, { title: 'ラグトレイン', artist: ['歌愛ユキ'] }).file, 'lagtrain.ttml');
  // containment tier: credited name contains the index artist
  assert.equal(matchTtmlEntry(index, { title: 'Hello', artist: 'Adele Adkins' }).file, 'hello-adele.ttml');
  // wrong artist rejects even with exact title
  assert.equal(matchTtmlEntry(index, { title: 'Idol', artist: 'Nobody' }), null);
  // feat noise in the query title is normalized away
  assert.equal(matchTtmlEntry(index, { title: 'Idol (feat. Ayase)', artist: 'YOASOBI' }).file, 'new-idol.ttml');
});

test('matchTtmlEntry without artist only accepts an unambiguous title', () => {
  const index = parseTtmlIndex(SAMPLE);
  // two different songs share "Hello" → refuse
  assert.equal(matchTtmlEntry(index, { title: 'Hello' }), null);
  // duplicates of the same ncmId count as one song → newest wins
  assert.equal(matchTtmlEntry(index, { title: 'Idol' }).file, 'new-idol.ttml');
  assert.equal(matchTtmlEntry(index, { title: 'Missing Song', artist: 'YOASOBI' }), null);
  assert.equal(matchTtmlEntry(null, { title: 'Idol' }), null);
});

test('URL builders order direct first then mirrors and reject injection', () => {
  const urls = ttmlIndexUrls();
  assert.equal(urls.length, TTML_DB_PREFIXES.length);
  assert.equal(urls[0], 'https://raw.githubusercontent.com/amll-dev/amll-ttml-db/main/ncm-lyrics/index.jsonl');
  assert.ok(urls.some(u => u.startsWith('https://ghproxy.net/https://')));
  const fileUrls = ttmlFileUrls('1689103578000-39523898-85d330ae.ttml');
  assert.equal(fileUrls[0], 'https://raw.githubusercontent.com/amll-dev/amll-ttml-db/main/raw-lyrics/1689103578000-39523898-85d330ae.ttml');
  assert.ok(fileUrls.some(u => u.startsWith('https://cdn.jsdelivr.net/gh/amll-dev/amll-ttml-db@main/raw-lyrics/')));
  assert.deepEqual(ttmlFileUrls('../server.mjs'), []);
  assert.deepEqual(ttmlFileUrls('a/b.ttml'), []);
  assert.deepEqual(ttmlFileUrls('..'), []);
  assert.deepEqual(ttmlFileUrls('x.ttml?evil=1'), []);
  const custom = ttmlFileUrls('a.ttml', { prefixes: ['https://mirror.example/db'] });
  assert.deepEqual(custom, ['https://mirror.example/db/raw-lyrics/a.ttml']);
});

test('searchTtmlEntries ranks exact > prefix > contains, artist bonus, newest dedupe', () => {
  const index = parseTtmlIndex(SAMPLE);
  // exact title + artist hit ranks first; duplicates collapse to newest
  const hits = searchTtmlEntries(index, { title: 'Idol', artist: 'YOASOBI' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'new-idol.ttml');
  // ambiguous title returns both songs; artist bonus orders them
  const hellos = searchTtmlEntries(index, { title: 'Hello', artist: 'OMFG' });
  assert.equal(hellos.length, 2);
  assert.equal(hellos[0].file, 'hello-omfg.ttml');
  assert.ok(hellos[0].score > hellos[1].score);
  // prefix / containment tiers still surface candidates
  const partial = searchTtmlEntries(index, { title: 'Solo' });
  assert.equal(partial.length, 1);
  assert.equal(partial[0].file, 'solo.ttml');
  // limit clamps, bad inputs return []
  assert.equal(searchTtmlEntries(index, { title: 'Hello', limit: 1 }).length, 1);
  assert.deepEqual(searchTtmlEntries(index, { title: '  ' }), []);
  assert.deepEqual(searchTtmlEntries(null, { title: 'Idol' }), []);
});

test('hasWordTimings handles null / v1 / v2 shapes', () => {
  assert.equal(hasWordTimings(null), false);
  assert.equal(hasWordTimings({ v: 1, lrc: '[00:01.00]hi' }), false);
  assert.equal(hasWordTimings({ v: 2, lines: [{ ms: 0, dur: 1000, text: 'hi' }] }), false);
  assert.equal(hasWordTimings({ v: 2, lines: [{ ms: 0, dur: 1000, text: 'hi', words: [] }] }), false);
  assert.equal(hasWordTimings({
    v: 2,
    lines: [{ ms: 0, text: 'a' }, { ms: 1000, text: 'b', words: [{ t: 1000, d: 500, w: 'b' }] }],
  }), true);
});
