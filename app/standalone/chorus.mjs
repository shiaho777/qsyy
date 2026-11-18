// Chorus detection for lyric lines. Pure functions, no I/O — the server runs
// this once when lyrics are built/persisted and stores `chorus: true` on the
// repeated hook lines so the front end can emphasise them.
//
// Heuristic (deliberately conservative, 宁缺毋滥):
//   1. normalise each line's text (case/width fold, strip punctuation);
//   2. group identical texts; a group qualifies when it repeats ≥ minRepeats
//      times AND the occurrences span ≥ 25% of the song's lyric timeline
//      (a refrain hammered 4× inside one bridge is not a chorus);
//   3. very short lines (< 4 chars after folding) never qualify — "yeah"
//      ad-libs repeat everywhere;
//   4. at most 3 distinct groups are marked, ranked by repeat count × span,
//      so a song with many recurring ad-libs still gets a focused highlight.

const MIN_REPEATS = 3;
const MIN_SPAN_RATIO = 0.25;
const MIN_TEXT_LENGTH = 4;
const MAX_GROUPS = 3;

function foldText(s) {
  return String(s ?? '')
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    // drop punctuation/symbols/whitespace, keep letters+digits+CJK
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

// lines: [{ ms, text, ... }] in playback order. Returns a Set of line indexes
// that belong to a detected chorus group. Never throws on malformed input.
export function detectChorusLines(lines, { minRepeats = MIN_REPEATS } = {}) {
  const out = new Set();
  if (!Array.isArray(lines) || lines.length < minRepeats * 2) return out;
  const first = Number(lines[0]?.ms) || 0;
  const last = Number(lines[lines.length - 1]?.ms) || 0;
  const timeline = last - first;
  if (timeline <= 0) return out;

  const groups = new Map();
  lines.forEach((line, index) => {
    const key = foldText(line?.text);
    if (key.length < MIN_TEXT_LENGTH) return;
    const list = groups.get(key);
    if (list) list.push(index);
    else groups.set(key, [index]);
  });

  const qualified = [];
  for (const indexes of groups.values()) {
    if (indexes.length < minRepeats) continue;
    const span = (Number(lines[indexes[indexes.length - 1]].ms) || 0)
      - (Number(lines[indexes[0]].ms) || 0);
    if (span / timeline < MIN_SPAN_RATIO) continue;
    qualified.push({ indexes, score: indexes.length * (span / timeline) });
  }
  qualified.sort((a, b) => b.score - a.score);
  for (const group of qualified.slice(0, MAX_GROUPS)) {
    for (const index of group.indexes) out.add(index);
  }
  return out;
}

// Mutates a built lyrics payload in place: sets `chorus: true` on detected
// lines. Safe on null / v1 / already-marked payloads (idempotent).
export function markChorus(built) {
  if (!built || !Array.isArray(built.lines)) return built;
  const hits = detectChorusLines(built.lines);
  built.lines.forEach((line, index) => {
    if (hits.has(index)) line.chorus = true;
    else if (line.chorus) delete line.chorus;
  });
  return built;
}