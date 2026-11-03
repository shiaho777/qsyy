// Lyrics parsing for the soda client's lyric payloads. Pure functions, no I/O;
// the on-disk lyrics cache stays in server.mjs (it depends on DECRYPT_DIR).

// The client ships karaoke LRC: every line is "[startMs,durMs]" followed by
// per-word tags "<offsetMs,durMs,0>word", offsets relative to the line start.
// Translations (`cn`) are a plain LRC block whose timestamps match the original
// lines exactly — pair them by ms, never by an invented offset.
const WORD_TAG_RE = /<(\d+),(\d+)(?:,\d+)?>([^<]*)/g;
const LRC_STAMP_RE = /^\[(\d+):(\d+)(?:[.:](\d+))?\]/;

export function lrcStamp(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function parseLrcBlock(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const m = raw.match(LRC_STAMP_RE);
    if (!m) continue;
    const ms = Number(m[1]) * 60000 + Number(m[2]) * 1000 + (m[3] ? Number(m[3].padEnd(3, '0')) : 0);
    const body = raw.replace(/^\[[^\]]*\]/, '').trim();
    if (body) out.push({ ms, text: body });
  }
  return out;
}

// → { v, name, lines: [{ ms, dur, text, cn?, words?: [{ t, d, w }] }], lrc }
export function buildLyrics(resolved) {
  const content = resolved?.lyric?.content;
  if (!content) return null;
  const lines = [];
  for (const raw of content.split('\n')) {
    const head = raw.match(/^\[(\d+),(\d+)\]/);
    if (head) {
      const start = Number(head[1]);
      const dur = Number(head[2]);
      const body = raw.slice(head[0].length);
      const words = [];
      WORD_TAG_RE.lastIndex = 0;
      let m;
      while ((m = WORD_TAG_RE.exec(body))) {
        if (!m[3]) continue;
        words.push({ t: start + Number(m[1]), d: Number(m[2]), w: m[3] });
      }
      const text = words.length
        ? words.map(w => w.w).join('').trim()
        : body.replace(/<\d+,\d+(?:,\d+)?>/g, '').trim();
      if (!text) continue;
      lines.push({ ms: start, dur, text, words: words.length ? words : null });
      continue;
    }
    // some tracks ship plain [mm:ss.xx] LRC instead of the karaoke form
    const stamp = raw.match(LRC_STAMP_RE);
    if (stamp) {
      const ms = Number(stamp[1]) * 60000 + Number(stamp[2]) * 1000 + (stamp[3] ? Number(stamp[3].padEnd(3, '0')) : 0);
      const text = raw.replace(/^\[[^\]]*\]/, '').trim();
      if (text) lines.push({ ms, dur: 0, text, words: null });
    }
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a.ms - b.ms);

  const cn = parseLrcBlock(resolved.lyric.cn);
  const cnByMs = new Map(cn.map(l => [l.ms, l.text]));
  for (let i = 0; i < lines.length; i += 1) {
    const hit = cnByMs.get(lines[i].ms);
    if (hit) { lines[i].cn = hit; continue; }
    if (cn.length === lines.length && cn[i]) lines[i].cn = cn[i].text;
  }

  const lrc = lines
    .map(l => (l.cn ? `[${lrcStamp(l.ms)}]${l.text}\n[${lrcStamp(l.ms)}]${l.cn}` : `[${lrcStamp(l.ms)}]${l.text}`))
    .join('\n');
  return { v: 2, name: resolved.name || '', lines, lrc };
}
