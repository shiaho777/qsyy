// Lyrics parsing for QiShui payloads and local lyric files. Pure functions,
// no I/O; the on-disk lyrics cache stays in server.mjs.
//
// QiShui ships karaoke LRC: every line is "[startMs,durMs]" followed by
// per-word tags "<offsetMs,durMs,0>word", offsets relative to the line start.
// Translations (`cn`) are a plain LRC block whose timestamps match the original
// lines exactly — pair them by ms, never by an invented offset.
//
// The same entry point also accepts the formats found next to local audio:
// plain / enhanced LRC, WebVTT, TTML, QRC, YRC and KRC. The output shape is the
// v2 payload the front end already consumes, so callers do not need branches.

const WORD_KRC_RE = /<(\d+),(\d+)(?:,\d+)?>([^<]*)/g;
const WORD_LRC_RE = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>([^<]*)/g;
const WORD_VTT_RE = /<((?:\d{1,3}:)?\d{2}:\d{2}[.:]\d{1,3})>([^<]*)/g;
const VTT_TIMING_RE = /^\s*((?:\d{1,3}:)?\d{2}:\d{2}[.:]\d{1,3})\s*-->\s*((?:\d{1,3}:)?\d{2}:\d{2}[.:]\d{1,3})/;
const WORD_YRC_RE = /\((\d+),(\d+)(?:,\d+)?\)([^()]*)/g;
const LRC_STAMP_RE = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/;
const KRC_LINE_RE = /^\[(\d+),(\d+)\](.*)$/;
const MULTI_LRC_RE = /^((?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$/;
const META_RE = /^\[(ti|ar|al|by|offset|length|re|ve|au|language):([^\]]*)\]$/i;

export function lrcStamp(ms) {
  const m = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  const s = Math.floor((Math.max(0, Number(ms) || 0) % 60000) / 1000);
  const cs = Math.floor((Math.max(0, Number(ms) || 0) % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function stampMs(min, sec, frac) {
  const f = frac ? Number(String(frac).padEnd(3, '0').slice(0, 3)) : 0;
  return Number(min) * 60000 + Number(sec) * 1000 + f;
}

export function parseLrcBlock(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const m = raw.match(LRC_STAMP_RE);
    if (!m) continue;
    const ms = stampMs(m[1], m[2], m[3]);
    const body = raw.replace(/^\[[^\]]*\]/, '').trim();
    if (body) out.push({ ms, text: body });
  }
  return out;
}

function safeCodePoint(value) {
  const code = Number(value);
  return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : '';
}
function decodeEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(dec))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function stripTags(value) {
  return decodeEntities(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseTimeValue(raw) {
  const value = String(raw || '').trim();
  if (!value) return 0;
  // Fraction digits are decimal fractions of a second: ".68" = 680 ms, not
  // 68 ms. Scale by digit count instead of right-padding (AMLL TTML uses
  // two-digit fractions throughout).
  const fracMs = frac => (frac ? Math.round(Number(`0.${frac}`) * 1000) : 0);
  const clock = value.match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,3}))?$/);
  if (clock) {
    if (clock[3] !== undefined) {
      return Number(clock[1]) * 3600000 + Number(clock[2]) * 60000
        + Number(clock[3]) * 1000 + fracMs(clock[4]);
    }
    return Number(clock[1]) * 60000 + Number(clock[2]) * 1000 + fracMs(clock[4]);
  }
  const unit = value.match(/^([\d.]+)\s*(h|m|s|ms)$/i);
  if (unit) {
    const n = Number(unit[1]);
    const kind = unit[2].toLowerCase();
    if (kind === 'h') return n * 3600000;
    if (kind === 'm') return n * 60000;
    if (kind === 'ms') return n;
    return n * 1000;
  }
  const alternates = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?$/i);
  if (alternates && (alternates[1] || alternates[2] || alternates[3])) {
    return Number(alternates[1] || 0) * 3600000 + Number(alternates[2] || 0) * 60000
      + Number(alternates[3] || 0) * 1000;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n * 1000 : 0;
}

export function detectLyricFormat(text, filename = '') {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  const ext = String(filename || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
  if (ext === 'vtt') return 'vtt';
  if (ext === 'ttml' || ext === 'xml') return 'ttml';
  if (ext === 'qrc') return 'qrc';
  if (ext === 'yrc') return 'yrc';
  if (ext === 'krc') return 'krc';
  if (ext === 'lrc') {
    if (/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/.test(raw)) return 'enhanced-lrc';
    return 'lrc';
  }
  if (!raw) return 'lrc';
  if (/^WEBVTT\b/i.test(raw) || /(?:^|\n)\s*(?:\d{1,3}:)?\d{2}:\d{2}[.:]\d{1,3}\s*-->\s*/m.test(raw)) return 'vtt';
  if (/<tt(?:\s|>)/i.test(raw)
    && (/<p\b[^>]*\bbegin\s*=/i.test(raw) || /(?:xmlns|ttm:|itunes:)/i.test(raw))) return 'ttml';
  const firstLine = raw.split('\n').find(line => KRC_LINE_RE.test(line.trim()));
  if (firstLine) {
    const body = firstLine.match(KRC_LINE_RE)?.[3] || '';
    if (/\((\d+),(\d+)(?:,\d+)?\)/.test(body)) return 'yrc';
    return 'krc';
  }
  if (/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/.test(raw)) return 'enhanced-lrc';
  return 'lrc';
}

function parseWordTags(body, format, lineStart) {
  const words = [];
  const push = (start, dur, text) => {
    const value = String(text || '');
    if (!value) return;
    words.push({ t: Math.max(0, Math.round(start)), d: Math.max(0, Math.round(dur)), w: value });
  };
  if (format === 'vtt') {
    WORD_VTT_RE.lastIndex = 0;
    let m;
    while ((m = WORD_VTT_RE.exec(body))) push(parseTimeValue(m[1]), 0, m[2]);
  } else if (format === 'yrc') {
    WORD_YRC_RE.lastIndex = 0;
    let m;
    while ((m = WORD_YRC_RE.exec(body))) push(Number(m[1]), Number(m[2]), m[3]);
  } else if (format === 'krc' || format === 'qrc') {
    WORD_KRC_RE.lastIndex = 0;
    let m;
    while ((m = WORD_KRC_RE.exec(body))) push(lineStart + Number(m[1]), Number(m[2]), m[3]);
  } else {
    WORD_LRC_RE.lastIndex = 0;
    let m;
    while ((m = WORD_LRC_RE.exec(body))) push(stampMs(m[1], m[2], m[3]), 0, m[4]);
  }
  return words;
}

function wordsText(words) {
  return words.map(word => word.w).join('').replace(/\s+/g, ' ').trim();
}

function textWithoutTags(value) {
  return decodeEntities(String(value || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// Word tags are allowed to omit parts of a cue (WebVTT voice spans, TTML
// rubies). Only keep them when they cover the whole line; otherwise render
// plain text instead of silently dropping the untagged words.
function safeWords(words, body, format) {
  if (!words.length) return null;
  if (format === 'yrc') return words;
  return wordsText(words).replace(/\s+/g, '') === textWithoutTags(body).replace(/\s+/g, '') ? words : null;
}

function parseTimedText(text, format) {
  const lines = [];
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || META_RE.test(line)) continue;

    const krc = line.match(KRC_LINE_RE);
    if (krc && (format === 'krc' || format === 'qrc' || format === 'yrc')) {
      const start = Number(krc[1]);
      const dur = Number(krc[2]);
      const body = krc[3].trim();
      if (!body) continue;
      const words = safeWords(parseWordTags(body, format, start), body, format);
      // Word text is authoritative when every word is tagged; stripTags()
      // inserts spaces where a tag was removed and would turn "Hel"/"lo"
      // into "Hel lo".
      const value = words ? wordsText(words) : stripTags(body);
      if (value) lines.push({ ms: start, dur, text: value, words });
      continue;
    }

    const multi = line.match(MULTI_LRC_RE);
    if (multi) {
      const stamps = [...multi[1].matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
      const body = multi[2].trim();
      for (const stamp of stamps) {
        const start = stampMs(stamp[1], stamp[2], stamp[3]);
        if (!body) continue;
        const words = safeWords(parseWordTags(body, 'enhanced-lrc', start), body, 'enhanced-lrc');
        const value = words ? wordsText(words) : stripTags(body);
        if (value) lines.push({ ms: start, dur: 0, text: value, words });
      }
      continue;
    }

    const plain = line.match(KRC_LINE_RE);
    if (plain) {
      const start = Number(plain[1]);
      const dur = Number(plain[2]);
      const body = plain[3].trim();
      if (!body) continue;
      const words = parseWordTags(body, 'krc', start);
      const value = words.length ? wordsText(words) : stripTags(body);
      if (value) lines.push({ ms: start, dur, text: value, words: words.length ? words : null });
    }
  }
  return lines;
}

function parseVtt(text) {
  const lines = [];
  const blocks = String(text || '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const rows = block.split('\n').map(row => row.trim()).filter(Boolean);
    if (!rows.length) continue;
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/i.test(rows[0])) continue;
    const timingIndex = rows.findIndex(row => VTT_TIMING_RE.test(row));
    if (timingIndex < 0) continue;
    const timing = rows[timingIndex].match(VTT_TIMING_RE);
    if (!timing) continue;
    const start = parseTimeValue(timing[1]);
    const end = parseTimeValue(timing[2]);
    const body = rows.slice(timingIndex + 1).join(' ').trim();
    if (!body) continue;
    const words = safeWords(parseWordTags(body, 'vtt', start), body, 'vtt');
    const value = words ? wordsText(words) : stripTags(body);
    if (value) lines.push({ ms: start, dur: Math.max(0, end - start), text: value, words });
  }
  return lines;
}

function parseTtml(text) {
  const lines = [];
  const source = String(text || '').replace(/\r\n?/g, '\n');
  const attrOf = (attrs, name) =>
    attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1] || '';
  // AMLL/Apple-style TTML marks translations and background vocals with
  // ttm:role. Background spans nest word spans, so match balanced one level
  // deep instead of the flat non-greedy span regex (which used to cut the
  // block at the first inner </span> and leak the rest into the main line).
  const BG_SPAN_RE = /<span\b([^>]*\bttm:role\s*=\s*["']x-bg["'][^>]*)>((?:[^<]|<(?!\/?span\b)|<span\b[^>]*>[^<]*<\/span>)*)<\/span>/gi;
  const TR_SPAN_RE = /<span\b[^>]*\bttm:role\s*=\s*["']x-translation["'][^>]*>[\s\S]*?<\/span>/gi;
  const ROMAN_SPAN_RE = /<span\b[^>]*\bttm:role\s*=\s*["']x-roman["'][^>]*>[\s\S]*?<\/span>/gi;
  const parseSpans = (body, lineStart) => {
    const words = [];
    const spanRe = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
    let span;
    while ((span = spanRe.exec(body))) {
      const spanAttrs = span[1] || '';
      // Word text is whitespace-significant (" beat" carries the separator);
      // only decode entities and drop inner tags (ruby bases etc.).
      const value = decodeEntities(String(span[2] || '').replace(/<[^>]*>/g, ''));
      if (!value.trim()) continue;
      const spanBegin = attrOf(spanAttrs, 'begin');
      const spanEnd = attrOf(spanAttrs, 'end');
      const spanDur = attrOf(spanAttrs, 'dur');
      const wordStart = spanBegin ? parseTimeValue(spanBegin) : lineStart;
      const wordEnd = spanEnd ? parseTimeValue(spanEnd) : spanDur ? wordStart + parseTimeValue(spanDur) : 0;
      words.push({ t: wordStart, d: Math.max(0, wordEnd - wordStart), w: value });
    }
    return words;
  };
  const paragraphRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let paragraph;
  while ((paragraph = paragraphRe.exec(source))) {
    const attrs = paragraph[1] || '';
    let body = paragraph[2] || '';
    const begin = attrOf(attrs, 'begin');
    const end = attrOf(attrs, 'end');
    const dur = attrOf(attrs, 'dur');
    const start = parseTimeValue(begin);
    const endMs = end ? parseTimeValue(end) : dur ? start + parseTimeValue(dur) : 0;

    // Pull background-vocal blocks out first (they carry their own words
    // and translation), then the line-level translation span.
    let bg = null;
    body = body.replace(BG_SPAN_RE, (whole, bgAttrs, bgBody) => {
      const bgStart = attrOf(bgAttrs, 'begin');
      const bgEnd = attrOf(bgAttrs, 'end');
      const bgBeginMs = bgStart ? parseTimeValue(bgStart) : start;
      const bgEndMs = bgEnd ? parseTimeValue(bgEnd) : 0;
      const bgPlain = bgBody.replace(TR_SPAN_RE, '').replace(ROMAN_SPAN_RE, '');
      const bgWords = parseSpans(bgPlain, bgBeginMs);
      const bgCn = stripTags(bgBody.match(TR_SPAN_RE)?.[0] || '');
      const bgRoman = stripTags(bgBody.match(ROMAN_SPAN_RE)?.[0] || '');
      const bgText = bgWords.length ? wordsText(bgWords) : stripTags(bgPlain);
      if (bgText) {
        bg = { ms: bgBeginMs, dur: Math.max(0, bgEndMs - bgBeginMs), text: bgText, words: bgWords.length ? bgWords : null };
        if (bgCn) bg.cn = bgCn;
        if (bgRoman) bg.roman = bgRoman;
      }
      return '';
    });
    const cn = stripTags(body.match(TR_SPAN_RE)?.[0] || '');
    const roman = stripTags(body.match(ROMAN_SPAN_RE)?.[0] || '');
    body = body.replace(TR_SPAN_RE, '').replace(ROMAN_SPAN_RE, '');

    const words = parseSpans(body, start);
    const safe = safeWords(words, body, 'ttml');
    const value = safe ? wordsText(safe) : stripTags(body);
    if (!value) continue;
    const line = { ms: start, dur: Math.max(0, endMs - start), text: value, words: safe };
    if (cn) line.cn = cn;
    if (roman) line.roman = roman;
    if (bg) line.bg = bg;
    // Duet marker: cappella-style renderers map distinct agents to senders.
    const agent = attrOf(attrs, 'ttm:agent');
    if (agent) line.agent = agent;
    lines.push(line);
  }
  return lines;
}

function parseRaw(text, format) {
  if (format === 'vtt') return parseVtt(text);
  if (format === 'ttml') return parseTtml(text);
  return parseTimedText(text, format);
}

function parseMetadata(text) {
  let offset = 0;
  for (const raw of String(text || '').split('\n')) {
    const match = raw.trim().match(META_RE);
    if (!match) continue;
    if (match[1].toLowerCase() === 'offset') {
      const value = Number(String(match[2]).trim());
      if (Number.isFinite(value)) offset = value;
    }
  }
  return { offset };
}

function shiftLines(lines, offset) {
  if (!offset) return;
  for (const line of lines) {
    line.ms = Math.max(0, line.ms + offset);
    if (line.words) for (const word of line.words) word.t = Math.max(0, word.t + offset);
  }
}

function pairTranslation(lines, translationText, translationFormat) {
  if (!translationText || !lines.length) return;
  const translated = parseRaw(translationText, translationFormat || detectLyricFormat(translationText));
  if (!translated.length) return;
  const byMs = new Map(translated.map(line => [line.ms, line.text]));
  let matched = 0;
  for (const line of lines) {
    const hit = byMs.get(line.ms);
    if (hit) { line.cn = hit; matched += 1; }
  }
  if (matched) return;
  if (translated.length === lines.length) {
    for (let i = 0; i < lines.length; i += 1) lines[i].cn = translated[i].text;
  }
}

function buildLrc(lines) {
  return lines
    .map(line => (line.cn ? `[${lrcStamp(line.ms)}]${line.text}\n[${lrcStamp(line.ms)}]${line.cn}` : `[${lrcStamp(line.ms)}]${line.text}`))
    .join('\n');
}

export function parseLyricText(text, options = {}) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  if (!raw.trim()) return null;
  const format = options.format || detectLyricFormat(raw, options.filename);
  const lines = parseRaw(raw, format);
  if (!lines.length) return null;
  const { offset } = parseMetadata(raw);
  shiftLines(lines, offset);
  pairTranslation(lines, options.translation, options.translationFormat);
  lines.sort((a, b) => a.ms - b.ms);
  return { v: 2, name: options.name || '', lines, lrc: buildLrc(lines) };
}

export function parseLyricFile(text, filename, options = {}) {
  return parseLyricText(text, {
    ...options,
    filename,
    format: options.format || detectLyricFormat(text, filename),
  });
}

// → { v, name, lines: [{ ms, dur, text, cn?, words?: [{ t, d, w }] }], lrc }
export function buildLyrics(resolved) {
  const content = resolved?.lyric?.content;
  if (!content) return null;
  const built = parseLyricText(content, {
    name: resolved.name || '',
    translation: resolved.lyric.cn,
    translationFormat: 'lrc',
  });
  return built && built.lines.length ? built : null;
}
