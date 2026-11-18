// Folia GET /v1/lyric payload builder. Pure transform from the qsyy v2 lyrics
// shape ({ v:2, lines:[{ ms, dur, text, cn?, words?:[{ t,d,w }] }] }) to Folia's
// LyricData contract (seconds, words always non-empty). No I/O; the server
// wires track + lyrics in and serves the result (or null) as JSON.
//
// Line end-time fallback chain mirrors obs-folia/src/main.tsx mapLines:
// dur > 0 → ms + dur, else next line's ms, else start + 4s; always at least
// start + 0.2s. Blank-text lines are dropped before the chain runs.
//
// Synthesis strategy for lines without native words: when the text contains
// whitespace-delimited words (Latin etc.) split on whitespace and attach the
// separator to the preceding token; otherwise (CJK etc.) split per character.
// Each piece gets an equal share of the line duration. wordByWord is true iff
// any surviving line has native words — synthesized lines still fill in.

const round3 = seconds => Math.round(seconds * 1000) / 1000;

// Split text into pieces whose concatenation equals the original text.
function splitPieces(text) {
  if (/\s/.test(text.trim())) {
    const pieces = [];
    const re = /\S+\s*/g;
    let match;
    while ((match = re.exec(text))) pieces.push(match[0]);
    if (!pieces.length) return [text];
    const lead = /^\s+/.exec(text);
    if (lead) pieces[0] = lead[0] + pieces[0];
    return pieces;
  }
  return Array.from(text);
}

function synthesizeWords(text, startMs, endMs) {
  const pieces = splitPieces(text);
  const span = Math.max(0, endMs - startMs);
  const per = span / pieces.length;
  return pieces.map((piece, i) => ({
    text: piece,
    startTime: round3((startMs + per * i) / 1000),
    endTime: round3((startMs + per * (i + 1)) / 1000),
  }));
}

// { track, lyrics } → LyricData | null. lyrics null / v1 (lrc only) / no
// usable lines → null. offset = Number(lyrics.offset) || 0, clamped to
// ±10000 ms (positive delays lyrics); clipStartMs is always 0 (full track).
export function buildFoliaLyricPayload({ track, lyrics } = {}) {
  if (!lyrics || !Array.isArray(lyrics.lines)) return null;
  const rows = lyrics.lines.filter(line => String(line?.text ?? '').trim());
  if (!rows.length) return null;

  const rawOffset = Number(lyrics.offset) || 0;
  const offset = Math.max(-10000, Math.min(10000, rawOffset));
  let wordByWord = false;

  const lines = rows.map((row, index) => {
    const startMs = Number(row.ms) || 0;
    const durMs = Number(row.dur) || 0;
    let endMs;
    if (durMs > 0) endMs = startMs + durMs;
    else {
      const next = rows[index + 1];
      endMs = next ? (Number(next.ms) || 0) : startMs + 4000;
    }
    endMs = Math.max(startMs + 200, endMs);

    const native = (Array.isArray(row.words) ? row.words : [])
      .map(word => ({
        text: String(word?.w ?? ''),
        startTime: round3((Number(word?.t) || 0) / 1000),
        endTime: round3(((Number(word?.t) || 0) + (Number(word?.d) || 0)) / 1000),
      }))
      .filter(word => word.text.trim());
    if (native.length) wordByWord = true;

    const text = String(row.text);
    const line = {
      text,
      startTime: round3(startMs / 1000),
      endTime: round3(endMs / 1000),
      words: native.length ? native : synthesizeWords(text, startMs, endMs),
    };
    const translation = String(row.cn ?? '').trim();
    if (translation) line.translation = translation;
    const romanization = String(row.roman ?? '').trim();
    if (romanization) line.romanization = romanization;
    // TTML background vocals (x-bg spans) → Folia backgroundVocals array.
    const bg = row.bg;
    if (bg && String(bg.text ?? '').trim()) {
      const bgStart = Number(bg.ms) || 0;
      const bgEnd = bgStart + Math.max(200, Number(bg.dur) || 2000);
      const bgNative = (Array.isArray(bg.words) ? bg.words : [])
        .map(word => ({
          text: String(word?.w ?? ''),
          startTime: round3((Number(word?.t) || 0) / 1000),
          endTime: round3(((Number(word?.t) || 0) + (Number(word?.d) || 0)) / 1000),
        }))
        .filter(word => word.text.trim());
      const vocal = {
        text: String(bg.text),
        startTime: round3(bgStart / 1000),
        endTime: round3(bgEnd / 1000),
        words: bgNative.length ? bgNative : synthesizeWords(String(bg.text), bgStart, bgEnd),
      };
      const bgTranslation = String(bg.cn ?? '').trim();
      if (bgTranslation) vocal.translation = bgTranslation;
      const bgRoman = String(bg.roman ?? '').trim();
      if (bgRoman) vocal.romanization = bgRoman;
      line.backgroundVocals = [vocal];
    }
    return line;
  });

  const payload = { offset, clipStartMs: 0, lines, wordByWord };
  const title = String(track?.title ?? '').trim();
  const artist = String(track?.artist ?? '').trim();
  if (title) payload.title = title;
  if (artist) payload.artist = artist;
  return payload;
}
