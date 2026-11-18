import test from 'node:test';
import assert from 'node:assert/strict';
import { detectChorusLines, markChorus } from './chorus.mjs';

// verse lines are unique; the hook repeats at 10s / 40s / 70s across a 90s song
const song = () => {
  const lines = [];
  for (let i = 0; i < 9; i += 1) {
    lines.push({ ms: i * 10000, text: i % 3 === 1 ? '我爱你中国亲爱的母亲' : `独特歌词第${i}句不一样` });
  }
  return lines;
};

test('repeated hook spanning the song is detected', () => {
  const hits = detectChorusLines(song());
  assert.deepEqual([...hits].sort((a, b) => a - b), [1, 4, 7]);
});

test('punctuation / case / full-width differences still group', () => {
  const lines = [
    { ms: 0, text: 'Hello World!' },
    { ms: 10000, text: '一句完全不同的主歌歌词' },
    { ms: 20000, text: 'hello world' },
    { ms: 30000, text: '另一句完全不同的主歌歌词' },
    { ms: 40000, text: 'Ｈｅｌｌｏ Ｗｏｒｌｄ～' },
    { ms: 60000, text: '别的歌词完全不同收尾' },
  ];
  assert.deepEqual([...detectChorusLines(lines)].sort((a, b) => a - b), [0, 2, 4]);
});

test('short ad-libs never qualify', () => {
  const lines = [
    { ms: 0, text: 'yeah' }, { ms: 30000, text: 'Yeah!' }, { ms: 60000, text: 'yeah' },
    { ms: 90000, text: '一句足够长的收尾歌词' },
  ];
  assert.equal(detectChorusLines(lines).size, 0);
});

test('repeats clustered in one section do not qualify (span gate)', () => {
  const lines = [
    { ms: 0, text: '重复的桥段歌词句子' },
    { ms: 1000, text: '重复的桥段歌词句子' },
    { ms: 2000, text: '重复的桥段歌词句子' },
    { ms: 3000, text: '重复的桥段歌词句子' },
    { ms: 60000, text: '尾声另外一句长歌词' },
  ];
  assert.equal(detectChorusLines(lines).size, 0);
});

test('at most three groups are marked, ranked by count × span', () => {
  const lines = [];
  const hooks = ['副歌甲句子足够长', '副歌乙句子足够长', '副歌丙句子足够长', '副歌丁句子足够长'];
  hooks.forEach((text, h) => {
    for (let r = 0; r < 3 + (h === 0 ? 2 : 0); r += 1) {
      lines.push({ ms: r * 25000 + h * 1000, text });
    }
  });
  lines.push({ ms: 130000, text: '收尾一句不同的长歌词' });
  lines.sort((a, b) => a.ms - b.ms);
  const hits = detectChorusLines(lines);
  const marked = new Set(lines.filter((_, i) => hits.has(i)).map(l => l.text));
  assert.equal(marked.size, 3);
  assert.ok(marked.has('副歌甲句子足够长')); // 5 repeats wins
  assert.ok(!marked.has('副歌丁句子足够长') || marked.size === 3);
});

test('malformed / tiny inputs return an empty set', () => {
  assert.equal(detectChorusLines(null).size, 0);
  assert.equal(detectChorusLines([]).size, 0);
  assert.equal(detectChorusLines([{ ms: 0, text: '只有一句足够长的歌词' }]).size, 0);
  assert.equal(detectChorusLines([{ text: '没有时间戳的歌词句子' }, { text: '没有时间戳的歌词句子' }, { text: '没有时间戳的歌词句子' }]).size, 0);
});

test('markChorus is idempotent and safe on null / v1 payloads', () => {
  const built = { v: 2, lines: song() };
  markChorus(built);
  assert.deepEqual(built.lines.map(l => Boolean(l.chorus)), [false, true, false, false, true, false, false, true, false]);
  markChorus(built);
  assert.equal(built.lines.filter(l => l.chorus).length, 3);
  assert.equal(markChorus(null), null);
  const v1 = { v: 1, lrc: '[00:01.00]x' };
  assert.equal(markChorus(v1), v1);
  // re-marking after text edits clears stale flags
  built.lines[1].text = '改掉了不再是副歌的句子';
  markChorus(built);
  assert.ok(!built.lines[1].chorus);
});