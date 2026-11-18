// amll-ttml-db (CC0 community TTML lyrics) lookup helpers. Pure functions, no
// I/O: the caller fetches the index / TTML bodies and feeds text in here.
// Attribution is not required by CC0 but entries keep `author` so responses
// can credit the submitter.
//
// The database has no API — it is a JSONL index plus static TTML files on
// GitHub. raw.githubusercontent.com times out on some networks, so URL
// builders return a priority list (direct first, then mirrors) and callers
// try them in order with short timeouts.

const RAW_BASE = 'https://raw.githubusercontent.com/amll-dev/amll-ttml-db/main/';

// Priority order: direct raw first, then proxies, then the jsDelivr CDN.
// Callers may override via { prefixes } on the URL builders.
export const TTML_DB_PREFIXES = Object.freeze([
  RAW_BASE,
  `https://ghproxy.net/${RAW_BASE}`,
  `https://gh-proxy.com/${RAW_BASE}`,
  'https://cdn.jsdelivr.net/gh/amll-dev/amll-ttml-db@main/',
]);

// Full-width ASCII → half-width, ideographic space → plain space.
function foldWidth(s) {
  return String(s ?? '')
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
}

function collapse(s) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Only feat/ft/featuring/prod/with bracket segments are noise; Live/Remix
// version tags are kept in the key and used for secondary matching.
const FEAT_SEGMENT = /^\s*(?:feat|ft|featuring|prod|with)(?:\.|\b)/i;

export function normalizeArtist(s) {
  return collapse(foldWidth(s));
}

export function normalizeTitle(s) {
  const folded = foldWidth(s)
    .replace(/[([{]([^)\]}]*)[)\]}]/g, (whole, inner) => (FEAT_SEGMENT.test(inner) ? ' ' : whole));
  return collapse(folded);
}

// Secondary key: drop *all* bracket segments (version tags included).
function stripVersionSegments(s) {
  return collapse(foldWidth(s).replace(/[([{][^)\]}]*[)\]}]/g, ' '));
}

// File names come from a community index — never let them escape raw-lyrics/.
export function isSafeTtmlFile(file) {
  return typeof file === 'string' && /^[A-Za-z0-9._-]+$/.test(file) && file !== '.' && file !== '..';
}

// JSONL text → Map<normalizedTitle, entry[]> with entries in index order
// (oldest → newest, so the last match wins). Bad lines are skipped, never
// thrown: a 5.8 MB community file always contains some garbage.
// entry = { musicName, artists: string[], album, ncmId, author, file }
export function parseTtmlIndex(text) {
  const index = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try { row = JSON.parse(trimmed); } catch (_) { continue; }
    const file = row?.rawLyricFile;
    if (!isSafeTtmlFile(file)) continue;
    // metadata is [["key", ["value", ...]], ...] — flatten to an object.
    const meta = {};
    if (Array.isArray(row.metadata)) {
      for (const pair of row.metadata) {
        if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue;
        meta[pair[0]] = Array.isArray(pair[1]) ? pair[1].map(v => String(v))
          : pair[1] != null ? [String(pair[1])] : [];
      }
    }
    const musicName = (meta.musicName || []).join(' ').trim();
    const key = normalizeTitle(musicName);
    if (!key) continue;
    const entry = {
      musicName,
      artists: (meta.artists || []).map(s => s.trim()).filter(Boolean),
      album: (meta.album || []).join(' ').trim(),
      ncmId: (meta.ncmMusicId || []).join(' ').trim() || String(row.id || ''),
      author: (meta.ttmlAuthorGithubLogin || []).join(' ').trim(),
      file,
    };
    const list = index.get(key);
    if (list) list.push(entry);
    else index.set(key, [entry]);
  }
  return index;
}

// Query artists may be a string or an array; "A / B" style credits are split
// on common separators, and the whole string is kept as a candidate too so
// names that legitimately contain "&" or "/" still match exactly.
function queryArtistNames(artist) {
  const raw = Array.isArray(artist) ? artist : [artist];
  const names = new Set();
  for (const value of raw) {
    const whole = normalizeArtist(value);
    if (!whole) continue;
    names.add(whole);
    for (const part of whole.split(/[,，、/＆&;；]/)) {
      const piece = part.trim();
      if (piece) names.add(piece);
    }
  }
  return [...names];
}

// Best entry for a track, or null. Tiers: exact artist intersection first,
// then containment (either direction, both sides ≥ 2 chars to avoid trivial
// substring hits). Within a tier the last index entry wins (= newest upload).
// Without artist info a title is accepted only when it maps to a single song
// (duplicates of the same ncmId count as one) — 宁缺毋滥.
export function matchTtmlEntry(index, { title, artist } = {}) {
  if (!(index instanceof Map)) return null;
  const key = normalizeTitle(title);
  if (!key) return null;
  let candidates = index.get(key) || [];
  if (!candidates.length) {
    // Secondary pass: query carries a version tag the index entry lacks.
    const loose = stripVersionSegments(title);
    if (loose && loose !== key) candidates = index.get(loose) || [];
  }
  if (!candidates.length) return null;

  const wanted = queryArtistNames(artist);
  if (!wanted.length) {
    const songs = new Set(candidates.map(e => e.ncmId || e.file));
    return songs.size === 1 ? candidates[candidates.length - 1] : null;
  }

  let best = null;
  for (const entry of candidates) {
    const names = entry.artists.map(normalizeArtist).filter(Boolean);
    if (names.some(name => wanted.includes(name))) best = entry;
  }
  if (best) return best;
  for (const entry of candidates) {
    const names = entry.artists.map(normalizeArtist).filter(Boolean);
    if (names.some(name => wanted.some(q =>
      name.length >= 2 && q.length >= 2 && (name.includes(q) || q.includes(name))))) best = entry;
  }
  return best;
}

// Ranked candidates for manual matching (the auto matcher is deliberately
// strict; this one is deliberately generous). Title equality / prefix /
// containment score 3/2/1, artist overlap adds a bonus. Same song uploaded
// twice keeps only the newest entry. Returns entries plus `score` for the UI.
export function searchTtmlEntries(index, { title, artist, limit = 12 } = {}) {
  if (!(index instanceof Map)) return [];
  const q = normalizeTitle(title);
  if (!q) return [];
  const wanted = queryArtistNames(artist);
  const out = [];
  for (const [key, entries] of index) {
    let titleScore = 0;
    if (key === q) titleScore = 3;
    else if (key.startsWith(q) || q.startsWith(key)) titleScore = 2;
    else if (key.includes(q) || q.includes(key)) titleScore = 1;
    if (!titleScore) continue;
    const bySong = new Map();
    for (const entry of entries) bySong.set(entry.ncmId || entry.file, entry);
    for (const entry of bySong.values()) {
      const names = entry.artists.map(normalizeArtist).filter(Boolean);
      const artistHit = wanted.length && names.some(name =>
        wanted.some(w => name === w || (name.length >= 2 && w.length >= 2 && (name.includes(w) || w.includes(name)))));
      out.push({ ...entry, score: titleScore * 10 + (artistHit ? 5 : 0) });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(1, Math.min(50, Number(limit) || 12)));
}

function cleanPrefixes(prefixes) {
  const list = Array.isArray(prefixes) && prefixes.length ? prefixes : TTML_DB_PREFIXES;
  return list
    .filter(p => typeof p === 'string' && /^https?:\/\//.test(p))
    .map(p => (p.endsWith('/') ? p : `${p}/`));
}

export function ttmlIndexUrls(options = {}) {
  return cleanPrefixes(options.prefixes).map(p => `${p}ncm-lyrics/index.jsonl`);
}

export function ttmlFileUrls(file, options = {}) {
  if (!isSafeTtmlFile(file)) return [];
  return cleanPrefixes(options.prefixes).map(p => `${p}raw-lyrics/${file}`);
}

// True when a built lyrics payload (null / v1 / v2) carries any native
// word-level timing — i.e. at least one line has a non-empty words array.
export function hasWordTimings(built) {
  return Boolean(built && Array.isArray(built.lines)
    && built.lines.some(line => Array.isArray(line?.words) && line.words.length > 0));
}
