// qsyy — standalone frontend for the QiShui local player.
/* global MediaMetadata */
// 首帧淡入:boot 里首个 rAF 揭开,避免白屏硬切;下面还有超时兜底
document.body.classList.add('booting');
const $ = id => document.getElementById(id);
const ls = {
  // storage keys renamed soda-app-* → qsyy-*; fall back to the old key once,
  // copying it over so existing settings (queue, volume, quality) survive.
  get: (k, d) => {
    try {
      let v = localStorage.getItem('qsyy-' + k);
      if (v === null) {
        v = localStorage.getItem('soda-app-' + k);
        if (v === null) return d;
        localStorage.setItem('qsyy-' + k, v);
      }
      return JSON.parse(v);
    } catch (_) { return d; }
  },
  set: (k, v) => { try { localStorage.setItem('qsyy-' + k, JSON.stringify(v)); } catch (_) {} },
};

const state = {
  me: null,
  playlists: [],
  current: null,          // { id, title, cover, count, tracks, cursor, hasMore, loading, rendered }
  filtered: null,         // search-filtered subset view
  queue: [],
  queueIndex: -1,
  shuffle: ls.get('shuffle', false),
  repeat: ls.get('repeat', 'off'),   // off | all | one
  cacheStatus: new Map(),
  fmt: ls.get('fmt', 'source'),
  quality: ls.get('quality', 'highest'),
  volume: ls.get('volume', 0.9),
  batchActive: false,
  onlineAvailable: false,   // 客户端会话(ttnet)或网页会话任一可用
  storeProgress: new Map(),  // trackId → { complete, progress }(自有增量缓存)
  effect: ls.get('effect', null),   // 当前音效 key(null=关)
  trackEffects: [],                // 当前曲目可用音效
  effectOn: false,
  storeView: null,                 // 当前打开的缓存库视图 { name } | null(歌单视图)
  storeSets: [], storeActive: '', storeTracks: [],
};

const audio = $('audio');
const fmtOptions = [
  ['source', '源文件'], ['m4a', 'M4A'], ['mp3', 'MP3'], ['flac', 'FLAC'], ['wav', 'WAV'], ['ogg', 'OGG'],
];

const ICONS = {
  play: '<svg class="ic solid" viewBox="0 0 24 24"><path d="M8 5.5v13l10-6.5z"/></svg>',
  pause: '<svg class="ic solid" viewBox="0 0 24 24"><rect x="7" y="5.5" width="3.4" height="13" rx="1"/><rect x="13.6" y="5.5" width="3.4" height="13" rx="1"/></svg>',
  repeatOne: '<svg class="ic" viewBox="0 0 24 24"><path d="M4 12V9a3 3 0 0 1 3-3h13m0 0l-3-3m3 3l-3 3M20 12v3a3 3 0 0 1-3 3H4m0 0l3 3m-3-3l3-3"/><path d="M11.4 14.8l1-4.6M13.2 10.9l-1.9.6"/></svg>',
  volHigh: '<svg class="ic" viewBox="0 0 24 24"><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5zM15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/></svg>',
  volLow: '<svg class="ic" viewBox="0 0 24 24"><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5zM15.5 9a4.2 4.2 0 0 1 0 6"/></svg>',
  volMute: '<svg class="ic" viewBox="0 0 24 24"><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5zM16 9.5l5 5M21 9.5l-5 5"/></svg>',
  note: '<svg class="ic" viewBox="0 0 24 24"><path d="M9 18V6l10-2v12"/><circle cx="6.8" cy="18" r="2.2"/><circle cx="16.8" cy="16" r="2.2"/></svg>',
  warn: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 4L2.8 19.5h18.4zM12 10v4.5"/><circle cx="12" cy="17.2" r=".4"/></svg>',
  folder: '<svg class="ic" viewBox="0 0 24 24"><path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9.5V17A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17z"/></svg>',
  downloadRow: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14"/></svg>',
  playRow: '<svg class="ic solid" viewBox="0 0 24 24"><path d="M8 5.5v13l10-6.5z"/></svg>',
};
function setVolIcon() {
  $('p-vol-icon').innerHTML = state.volume === 0 ? ICONS.volMute
    : state.volume < 0.5 ? ICONS.volLow : ICONS.volHigh;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3620);
}

function fmtTime(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 图片淡入:等真正解码完成再显形(complete 对已缓存/空 src 也成立,占位底色照常显示)
function armImg(img) {
  if (!img) return;
  if (img.complete) { img.classList.add('loaded'); return; }
  img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
}
function armImgs(root) { root.querySelectorAll('img').forEach(armImg); }

// 从封面取色,派生整窗对角渐变主题(对齐官方汽水客户端:封面主色铺整窗背景,
// 左下深 → 右上浅)。官方色值来自接口 cover_color.base_five_color,此处用 canvas
// 自采样:16x16 抽样,饱和度加权取主色,再按官方截图实测(底 L≈18-29%,顶 L≈30-48%,
// 顶≈底x1.7)派生深/中/浅三档写进 @property 注册的颜色变量,渐变随切歌平滑过渡。
const glowCanvas = document.createElement('canvas');
const clamp01 = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hslStr = (h, s, l) =>
  `hsl(${Math.round(h)},${Math.round(clamp01(s, 0, 1) * 100)}%,${Math.round(clamp01(l, 0, 1) * 100)}%)`;
function applyCoverGlow(url) {
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    try {
      const sz = 16;
      glowCanvas.width = glowCanvas.height = sz;
      const ctx = glowCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, sz, sz);
      const { data } = ctx.getImageData(0, 0, sz, sz);
      let r = 0, g = 0, b = 0, wSum = 0;
      for (let i = 0; i < data.length; i += 4) {
        const rr = data[i], gg = data[i + 1], bb = data[i + 2];
        const mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb);
        if (mx < 36) continue;                    // 跳过近黑
        const sat = mx - mn;
        if (sat < 10) continue;                   // 跳过灰白
        const w = sat * (0.5 + mx / 255);         // 饱和且亮的像素权重大
        r += rr * w; g += gg * w; b += bb * w; wSum += w;
      }
      if (!wSum) return;
      r /= wSum; g /= wSum; b /= wSum;
      const rs = document.documentElement.style;
      rs.setProperty('--glow', `${Math.round(r)},${Math.round(g)},${Math.round(b)}`);
      // RGB → HSL
      const rn = r / 255, gn = g / 255, bn = b / 255;
      const cmax = Math.max(rn, gn, bn), cmin = Math.min(rn, gn, bn);
      const l = (cmax + cmin) / 2, d = cmax - cmin;
      const sH = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
      let h = 0;
      if (d > 0) {
        if (cmax === rn) h = 60 * (((gn - bn) / d) % 6);
        else if (cmax === gn) h = 60 * ((bn - rn) / d + 2);
        else h = 60 * ((rn - gn) / d + 4);
      }
      h = (h + 360) % 360;
      // 派生三档:底 L≈18-29% → 顶 L≈30-48%(≈1.7 倍),饱和度收拢防艳俗
      const sB = clamp01(sH * 0.95, 0.10, 0.48);
      const sT = clamp01(sH * 0.9, 0.08, 0.42);
      const lB = clamp01(0.13 + 0.24 * l, 0.13, 0.30);
      const lT = clamp01(lB * (1.25 + 0.5 * l) + 0.03, 0.28, 0.47);
      rs.setProperty('--th-deep', hslStr(h, sB, lB));
      rs.setProperty('--th-mid', hslStr(h, (sB + sT) / 2, (lB + lT) * 0.47));
      rs.setProperty('--th-lite', hslStr(h, sT, lT));
    } catch (_) {}
  };
  img.src = url;
}
function coverUrl(info, size = 220) {
  if (!info?.uri) return '';
  const template = info.template_prefix
    ? `${info.template_prefix}-crop-center:${size}:${size}.jpg`
    : `c5_${size}x${size}.jpg`;
  return `/api/cover?url=${encodeURIComponent((info.urls?.[0] || '') + info.uri + '~' + template)}`;
}

// ------------------------------------------------------------------ data

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

async function loadMe() {
  try {
    const me = await api('/api/me');
    state.me = me;
    const info = me?.my_info;
    $('user').innerHTML = info ? `
      <img src="${coverUrl(info.larger_avatar_url || info.avatar_url, 80)}" alt="">
      <div><div class="name">${esc(info.nickname || '')}</div>
      <div class="hint">${state.playlists.length ? state.playlists.length + ' 个歌单' : '已登录'}</div></div>` : '';
    armImgs($('user'));
  } catch (_) {
    $('user').innerHTML = '<div class="hint" style="padding:4px 6px">登录态失效 — 打开一次汽水音乐后点同步</div>';
  }
}

async function loadPlaylists(openSaved = true, fresh = false) {
  const data = await api(`/api/playlists?count=500${fresh ? '&fresh=1' : ''}`);
  state.playlists = (data?.playlists || []).map(p => ({
    id: String(p.id), title: p.title || '未命名',
    count: p.count_tracks ?? p.stats?.track_count ?? 0,
    cover: p.url_cover,
  }));
  const saved = ls.get('lastPlaylist', null);
  const liked = state.playlists.find(p => p.title.includes('我喜欢')) || state.playlists[0];
  const target = openSaved ? (state.playlists.find(p => p.id === saved) || liked) : liked;
  $('playlists').innerHTML = state.playlists.map((p, i) => `
    <div class="pl-item${p === target ? ' active' : ''}" data-i="${i}">
      ${p.cover ? `<img loading="lazy" src="${coverUrl(p.cover, 96)}" alt="">` : ''}
      <div><div class="t">${esc(p.title)}</div><div class="c">${p.count} 首</div></div>
    </div>`).join('');
  document.querySelectorAll('#playlists .pl-item').forEach(el => {
    el.onclick = () => openPlaylist(state.playlists[Number(el.dataset.i)]);
  });
  armImgs($('playlists'));
  loadMe();
  if (target) openPlaylist(target, openSaved);
}

async function openPlaylist(pl, resume = false) {
  document.querySelectorAll('#playlists .pl-item').forEach(el =>
    el.classList.toggle('active', state.playlists[Number(el.dataset.i)]?.id === pl.id));
  // leaving the cache-library view: back to playlist mode
  state.storeView = null;
  ls.set('storeView', '');
  setMainMode('playlist');
  loadStores();
  ls.set('lastPlaylist', pl.id);
  state.current = {
    id: pl.id, title: pl.title, cover: pl.cover, count: pl.count,
    tracks: [], cursor: '', hasMore: true, loading: false, rendered: 0,
  };
  state.filtered = null;
  $('search').value = '';
  renderHero();
  showSkeleton();
  // Chrome restores the previous scrollTop of inner scrollers on reload,
  // which lands the view mid-list with the hero off-screen; start clean.
  document.querySelector('.main').scrollTop = 0;
  history.scrollRestoration = 'manual';
  await loadMore();
  await restorePlaylistOrder();
  if (resume) {
    const last = ls.get('lastTrack', null);
    if (last && last.playlistId === pl.id) {
      const list = displayTracks();
      const idx = list.findIndex(t => t.id === last.trackId);
      if (idx >= 0) {
        state.queue = list.slice();
        state.queueIndex = idx;
        startCurrent(false);
        const pos = Number(last.position) || 0;
        if (pos > 5 && audio.duration) audio.currentTime = Math.min(pos, audio.duration - 2);
        else audio.addEventListener('loadedmetadata', () => { if (pos > 5) audio.currentTime = pos; }, { once: true });
      }
    }
  }
}

function renderHero() {
  const cur = state.current;
  const playing = state.queue[state.queueIndex];
  $('hero').innerHTML = `
    <div class="hero-cover-wrap"><img id="hero-cover" class="hero-cover" src="${(playing?.cover || cur.cover) ? coverUrl(playing?.cover || cur.cover, 300) : ''}" alt="" data-url="${playing?.cover || cur.cover || ''}"></div>
    <div class="hero-info">
      <div class="hero-kicker" id="hero-kicker">${playing ? '<span class="live-dot"></span>正在播放' : 'PLAYLIST'}</div>
      <div class="hero-title">${esc(cur.title)}</div>
      <div class="hero-sub" id="hero-sub">${cur.count} 首 · 加载中…</div>
      <div class="hero-actions">
        <button id="play-all" class="btn primary">▶ 播放全部</button>
        <button id="shuffle-play" class="btn ghost">⤨ 随机播放</button>
      </div>
    </div>`;
  armImg($('hero-cover'));
  if ($('play-all')) $('play-all').onclick = () => { setQueue(visibleTracks().slice(), 0); };
  if ($('shuffle-play')) $('shuffle-play').onclick = () => {
    const list = visibleTracks().slice();
    for (let i = list.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    setQueue(list, 0);
    state.shuffle = true; ls.set('shuffle', true); updateModeButtons();
  };
}

// The hero artwork follows the currently playing track (crossfade on change),
// falling back to the playlist cover when idle.
function updateHeroPlayback() {
  const t = state.queue[state.queueIndex];
  const kicker = $('hero-kicker');
  if (kicker) kicker.innerHTML = t ? '<span class="live-dot"></span>正在播放' : 'PLAYLIST';
  if (!t?.cover) return;
  const img = $('hero-cover');
  if (!img) return;
  const url = coverUrl(t.cover, 300);
  if (img.dataset.url === t.cover) return;
  img.dataset.url = t.cover;
  applyCoverGlow(url);
  img.classList.remove('loaded');
  const reveal = () => requestAnimationFrame(() => { img.classList.add('loaded'); });
  img.onload = reveal;
  img.src = url;
  if (img.complete) reveal();
}

function updateHeroSub() {
  const cur = state.current;
  const el = $('hero-sub');
  if (!el || !cur) return;
  const cachedCount = cur.tracks.filter(t => state.cacheStatus.get(t.id)?.ready).length;
  el.textContent = `${cur.count} 首 · 已加载 ${cur.tracks.length}${cur.hasMore ? '+' : ''} · 本地缓存 ${cachedCount}`;
}

async function loadMore() {
  const cur = state.current;
  if (!cur || cur.loading || !cur.hasMore) return;
  cur.loading = true;
  $('sentinel').textContent = '加载中…';
  try {
    const search = new URLSearchParams({ playlist_id: cur.id, cursor: cur.cursor, count: 100 });
    const data = await api(`/api/playlist/${cur.id}?${search}`);
    const startIdx = cur.tracks.length;
      const items = (data?.media_resources || [])
      .filter(m => m?.type === 'track' && m?.entity?.track_wrapper?.track)
      .map(m => {
        const t = m.entity.track_wrapper.track;
        return {
          id: String(t.id), name: t.name,
          artists: (t.artists || []).map(a => a.name).filter(Boolean),
          album: t.album?.name || '', duration: Number(t.duration) || 0,
          cover: t.album?.url_cover, vip: (t.is_vip === true) || (t.audition_info?.is_audition === true),
          qualities: Array.isArray(t.bit_rates) ? t.bit_rates.map(b => b.quality || b).filter(Boolean) : [],
          // 有无歌词的近似信号:接口无显式字段,词作者/卡拉OK支持任一即视为有词
          lyric: Boolean(t.song_maker_team?.lyricists?.length) || Boolean(t.karaoke?.supported),
        };
      });
    cur.tracks.push(...items);
    cur.hasMore = Boolean(data?.has_more) && Boolean(data?.next_cursor);
    cur.cursor = data?.next_cursor || '';
    if (cur.order) rerenderRows(items.map(t => t.id));
    else appendRows(items, startIdx);
    updateHeroSub();
  } catch (e) {
    toast(`歌单加载失败:${e.message}`, 'err');
  }
  cur.loading = false;
  $('sentinel').textContent = cur.hasMore ? '继续下拉加载更多…' : '· 没有更多了 ·';
}

// ------------------------------------------------------------------ rendering (incremental)

function visibleTracks() {
  return state.filtered ?? displayTracks();
}

// ------------------------------------------------------------------ ordering (sort / drag)

// 显示顺序 = order.ids 映射出曲目,不在 ids 里的(后加载的新歌)按官方顺序追加在尾部。
// state.current.tracks 始终保持官方顺序(分页追加的真相源),order 只是视图层排序。
function displayTracks() {
  const cur = state.current;
  if (!cur?.tracks) return [];
  if (!cur.order?.ids?.length) return cur.tracks;
  const byId = new Map(cur.tracks.map(t => [t.id, t]));
  const seen = new Set();
  const list = [];
  for (const id of cur.order.ids) {
    const t = byId.get(id);
    if (t && !seen.has(id)) { seen.add(id); list.push(t); }
  }
  for (const t of cur.tracks) if (!seen.has(t.id)) list.push(t);
  return list;
}

// 排序生效期间整表重渲染,关掉行入场动画避免每页追加都闪一遍
function rerenderRows(extraIds) {
  const cur = state.current;
  if (!cur) return;
  const list = visibleTracks();
  const frag = document.createDocumentFragment();
  list.forEach((t, i) => frag.appendChild(rowEl(t, i)));
  $('tracks').classList.add('no-anim');
  $('tracks').innerHTML = '';
  $('tracks').appendChild(frag);
  cur.rendered = list.length;
  // 行 DOM 重建后缓存环/徽标状态全空:先用 state.cacheStatus 就地回填(零请求),
  // 未查过的 id 批量补查 —— 此前只靠逐行 hover 逐首补,排序/拖拽后对号"半天才"回来
  decorateCacheBadges();
  requestCacheStatus(extraIds?.length ? extraIds : list.map(t => t.id));
  decoratePlayingRow();
}

// 顺序持久化:自定义/随机记 ids(必须),其余只记模式(新歌加入后重排自动纳入)
function persistOrder() {
  const cur = state.current;
  if (!cur) return;
  const o = cur.order;
  if (!o) { ls.set('order-' + cur.id, null); return; }
  ls.set('order-' + cur.id, (o.mode === 'custom' || o.mode === 'random') ? { mode: o.mode, ids: o.ids } : { mode: o.mode });
}

function applySortMode(mode, savedIds) {
  const cur = state.current;
  if (!cur) return;
  if (mode === 'default') cur.order = null;
  else if ((mode === 'custom' || mode === 'random') && savedIds?.length) cur.order = { mode, ids: savedIds };
  else {
    const list = cur.tracks.slice(); // 从官方顺序起算,排序结果与显示顺序解耦
    if (mode === 'az') {
      list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN', { sensitivity: 'base', numeric: true }));
    } else if (mode === 'duration') {
      list.sort((a, b) => (a.duration || 0) - (b.duration || 0));
    } else if (mode === 'lyric') {
      list.sort((a, b) => (b.lyric ? 1 : 0) - (a.lyric ? 1 : 0)); // 有词在前,组内保持原相对顺序(稳定排序)
    } else if (mode === 'random') {
      for (let i = list.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    } else if (mode === 'custom') {
      list.length = 0; list.push(...displayTracks()); // 无保存顺序时:固化当前显示顺序
    }
    cur.order = { mode, ids: list.map(t => t.id) };
  }
  persistOrder();
  rerenderRows();
  if ($('sort-select')) $('sort-select').value = mode;
}

// 排序要对整个歌单生效,先把分页拉完(失败循环保护:上限 50 页)
async function loadAllTracks() {
  const cur = state.current;
  if (!cur) return;
  let guard = 0;
  while (cur.hasMore && !cur.loading && guard < 50) { await loadMore(); guard += 1; }
}

async function restorePlaylistOrder() {
  const cur = state.current;
  if (!cur) return;
  const saved = ls.get('order-' + cur.id, null);
  if (!saved?.mode || saved.mode === 'default') { cur.order = null; if ($('sort-select')) $('sort-select').value = 'default'; return; }
  if (cur.hasMore) await loadAllTracks();
  applySortMode(saved.mode, saved.ids);
}

function showSkeleton() {
  $('tracks').innerHTML = Array.from({ length: 8 }, () =>
    `<div class="skel"><i style="width:16px"></i><i style="width:44px;height:44px"></i><i></i><i style="width:60%"></i><i style="width:55%"></i><i style="width:30px"></i><i style="width:80px"></i></div>`).join('');
}

function appendRows(items, startIdx) {
  if (state.current.rendered === 0) $('tracks').innerHTML = '';
  const frag = document.createDocumentFragment();
  items.forEach((t, i) => frag.appendChild(rowEl(t, startIdx + i)));
  $('tracks').appendChild(frag);
  state.current.rendered += items.length;
  // 行挂上后立即用内存已知状态回填缓存环:切回看过的歌单时所有 id 都已
  // 缓存,requestCacheStatus 会全部跳过、不发请求,若无此行环会一直空着
  decorateCacheBadges();
  requestCacheStatus(items.map(t => t.id));
  decoratePlayingRow();
}

function rebuildRows() {
  const cur = state.current;
  if (!cur) return;
  cur.rendered = 0;
  $('tracks').innerHTML = '';
  const list = visibleTracks();
  const CHUNK = 120;
  for (let i = 0; i < list.length && i < CHUNK; i += 1) $('tracks').appendChild(rowEl(list[i], i));
  cur.rendered = Math.min(list.length, CHUNK);
  // 同 rerenderRows:行重建即回填缓存状态,未知 id 批量补查(不再依赖逐行 hover)
  decorateCacheBadges();
  requestCacheStatus(list.map(t => t.id));
  decoratePlayingRow();
}

function rowEl(t, i) {
  const el = document.createElement('div');
  el.className = 'track';
  el.dataset.id = t.id;
  el.style.setProperty('--i', String(i));
  el.draggable = true;   // 拖动排序(搜索过滤时 dragstart 会拦下)
  const qualityTags = qualityBadges(t.qualities);
  el.innerHTML = `
    <div class="cell-idx"><span class="num">${i + 1}</span><button class="hovp" title="播放">${ICONS.playRow}</button><div class="eq"><i></i><i></i><i></i></div></div>
    <img class="cover" loading="lazy" src="${t.cover ? coverUrl(t.cover, 96) : ''}" alt="">
    <div class="name"><span class="t-name">${esc(t.name)}</span>${t.vip ? '<span class="badge vip">VIP</span>' : ''}${qualityTags}<span class="badge cached" style="display:none">缓存</span><span class="badge preview" style="display:none">试听</span></div>
    <div class="artist">${esc(t.artists.join(' / '))}</div>
    <div class="album">${esc(t.album)}</div>
    <div class="dur">${fmtTime(t.duration)}</div>
    <div class="cell-cache"><svg class="ring" viewBox="0 0 24 24"><g transform="rotate(-90 12 12)"><circle class="ring-bg" cx="12" cy="12" r="8.5"/><circle class="ring-fill" cx="12" cy="12" r="8.5"/></g><path class="ring-check" d="M7.9 12.3l3 3 5.2-5.6"/></svg></div>`;
  el.querySelector('.hovp').onclick = e => { e.stopPropagation(); playOrPrime(t); };
  el.onclick = () => playOrPrime(t);
  el.onmouseenter = () => requestCacheStatus([t.id]);
  // 行尾缓存环:点击弹 清理/重加载 菜单
  const cacheCell = el.querySelector('.cell-cache');
  if (cacheCell) {
    cacheCell.title = '缓存操作:清理 / 重加载';
    cacheCell.onclick = e => { e.stopPropagation(); openCacheMenu(t, cacheCell); };
  }
  el.querySelectorAll('img').forEach(img => { img.draggable = false; }); // 别劫持行拖拽
  armImgs(el);
  return el;
}

function qualityBadges(qualities) {
  if (!qualities?.length) return '';
  const marks = [];
  if (qualities.includes('hi_res')) marks.push(['hr', 'Hi-Res']);
  else if (qualities.includes('lossless')) marks.push(['hr', '无损']);
  if (qualities.includes('spatial')) marks.push(['sp', '空间音频']);
  return marks.map(([cls, label]) => `<span class="badge ${cls}">${label}</span>`).join('');
}

// Play if cached; if a web session exists the server streams online instead.
// Only when both are unavailable do we fall back to "play it once in the
// official client so it gets cached" flow.
function playOrPrime(t) {
  ensureGraph();   // 用户手势内建图,AudioContext 才能恢复;否则静音
  const info = state.cacheStatus.get(t.id);
  const list = visibleTracks().slice();
  const idx = list.findIndex(x => x.id === t.id);
  if (info?.ready || state.onlineAvailable) {
    if (!info?.ready) {
      toast(`「${t.name}」在线播放准备中(约几秒)…`);
      busyCacheRings.add(t.id);
      decorateCacheBadges();
      pollProgress();
    }
    setQueue(list, idx);
    return;
  }
  primeInClient(t);
}

function primeInClient(t) {
  toast(`「${t.name}」还没有本地缓存,正在打开汽水音乐…`);
  fetch('/api/open-client', { method: 'POST' }).catch(() => {});
  toast(`请在汽水音乐里播放「${t.name}」,这里会自动检测到缓存`, 'ok');
  fetch(`/api/monitor/${t.id}`).then(r => r.json()).then(res => {
    if (!res?.ready) return;
    state.cacheStatus.delete(t.id);
    requestCacheStatus([t.id]);
    toast(`「${t.name}」已缓存,可以播放了 ✓`, 'ok');
  }).catch(() => {});
}

// ---------------------------------------------------------------- audio effects (Web Audio DSP, aligned with track_v2 audio_effects)

let audioCtx = null;
let mediaSource = null;      // MediaElementSource(只能建一次)
let outputTap = null;        // 常驻汇流点:mediaSource → (音效链) → outputTap → analyser → destination
let analyser = null;         // 实时频谱分析,驱动列表小波浪
let eqFreq = null;
let effectChain = { input: null, output: null, nodes: [] };

function dbToGain(db) { return Math.pow(10, db / 20); }

function buildEqNode(ctx, bandStr) {
  // "LowShelf,31,1.0,-9.98" → biquad(f, Q, gain)
  const [type, freq, q, gain] = bandStr.split(',');
  const filter = ctx.createBiquadFilter();
  const map = { LowShelf: 'lowshelf', HighShelf: 'highshelf', Peaking: 'peaking', LowPass: 'lowpass', HighPass: 'highpass' };
  filter.type = map[type] || 'peaking';
  filter.frequency.value = Number(freq);
  filter.Q.value = Number(q);
  filter.gain.value = Number(gain);
  return filter;
}

function buildReverbIR(ctx, rt60, dry2wet) {
  const seconds = Math.max(0.3, Math.min(2.5, rt60 || 1));
  const rate = ctx.sampleRate;
  const length = Math.floor(seconds * rate);
  const ir = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch += 1) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i += 1) {
      const t = i / length;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.2) * (1 - t * 0.15);
    }
  }
  return ir;
}

// 按 track_v2 下发的 DSP 链构建 Web Audio 节点
function buildEffectNodes(ctx, config) {
  const chain = (config?.chains || []).find(c => c.enable !== false) || (config?.chains || [])[0];
  const nodes = [];
  for (const node of (chain?.nodes || [])) {
    if (node.enable === false) continue;
    if (node.type === 'gain') {
      const g = ctx.createGain();
      g.gain.value = dbToGain(node.gain_db || 0);
      nodes.push(g);
    } else if (node.type === 'equalizer') {
      const preset = (node.presets || []).find(p => p.name === (node.use_preset || 'custom')) || (node.presets || [])[0];
      for (const band of (preset?.band_params || [])) {
        const f = buildEqNode(ctx, band);
        if (f) nodes.push(f);
      }
    } else if (node.type === 'drc') {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = node.compressor_threshold ?? -24;
      comp.knee.value = node.compressor_knee_width ?? 3;
      comp.ratio.value = node.compressor_ratio ?? 2;
      comp.attack.value = Math.max(0.001, (node.attack_time || 20) / 1000);
      comp.release.value = Math.max(0.01, (node.release_time || 200) / 1000);
      nodes.push(comp);
      if (node.make_up_gain) {
        const g = ctx.createGain();
        g.gain.value = dbToGain(node.make_up_gain);
        nodes.push(g);
      }
    } else if (node.type === 'stereo_width') {
      // M/S 展宽:side *= width(简化实现,近似官方 ms_crossfeed)
      const ms = node.ms_crossfeed_params || {};
      if (ms.enable !== false && (ms.width || 1) !== 1) {
        const splitter = ctx.createChannelSplitter(2);
        const merger = ctx.createChannelMerger(2);
        const mid = ctx.createGain(); mid.gain.value = 0.5;
        const side = ctx.createGain(); side.gain.value = 0.5 * (ms.width ?? 1);
        const midL = ctx.createGain(); midL.gain.value = 1;
        const midR = ctx.createGain(); midR.gain.value = 1;
        const sideL = ctx.createGain(); sideL.gain.value = 1;
        const sideR = ctx.createGain(); sideR.gain.value = -1;
        splitter.connect(mid, 0); splitter.connect(mid, 1);
        splitter.connect(sideL, 0); splitter.connect(sideR, 1);
        sideL.connect(side); sideR.connect(side);
        mid.connect(midL); mid.connect(midR);
        midL.connect(merger, 0, 0); side.connect(merger, 0, 0);
        midR.connect(merger, 0, 1); side.connect(merger, 0, 1);
        nodes.push({ input: splitter, output: merger });
      }
    } else if (node.type === 'fdn_reverb') {
      const convolver = ctx.createConvolver();
      convolver.buffer = buildReverbIR(ctx, node.rt60, node.dry2wet_ratio);
      const wet = ctx.createGain();
      wet.gain.value = node.dry2wet_ratio ?? 0.5;
      const dry = ctx.createGain();
      dry.gain.value = 1 - (node.dry2wet_ratio ?? 0.5) * 0.6; // 保留干声主体,避免糊
      const merge = ctx.createGain();
      const input = ctx.createGain();
      input.connect(dry); dry.connect(merge);
      input.connect(convolver); convolver.connect(wet); wet.connect(merge);
      nodes.push({ input, output: merge });
    } else if (node.type === 'limiter_lookahead_sig') {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -(node.ceiling_dB || 0.4) - 6;
      comp.knee.value = node.knee_dB ?? 0.2;
      comp.ratio.value = 20;
      comp.attack.value = Math.max(0.00002, (node.attack_time_ms || 0.0001) / 1000);
      comp.release.value = Math.max(0.005, (node.release_time_ms || 20) / 1000);
      nodes.push(comp);
    }
  }
  return nodes;
}

function ensureGraph() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    mediaSource = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 32;                 // 16 个频点,够驱动 3 根柱子
    analyser.smoothingTimeConstant = 0.7;
    eqFreq = new Uint8Array(analyser.frequencyBinCount);
    outputTap = audioCtx.createGain();
    mediaSource.connect(outputTap);
    outputTap.connect(analyser);
    analyser.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().then(startEqLoop).catch(() => {});
  else startEqLoop();
}

function teardownEffectChain() {
  try { effectChain.input?.disconnect(); } catch (_) {}
  for (const n of effectChain.nodes) {
    try { (n.output || n).disconnect(); } catch (_) {}
  }
  effectChain = { input: null, output: null, nodes: [] };
  try { mediaSource.disconnect(); mediaSource.connect(outputTap); } catch (_) {}
}

// ---------------------------------------------------------------- real-time equalizer (playing row)
// 读 analyser 的真实频谱驱动列表里那三根柱子,替代无限循环的假动画。
// 低频/中频/高频各取一段频点平均,平滑后写 scaleY;暂停时伏到最低。
let eqRaf = 0;
const eqSmooth = [0.18, 0.18, 0.18];
function eqFloor() {
  const eq = document.querySelector('.track.playing .eq.live');
  if (eq) eq.querySelectorAll('i').forEach(el => { el.style.transform = 'scaleY(0.18)'; });
}
function startEqLoop() {
  if (eqRaf || !analyser || !eqFreq) return;
  const tick = () => {
    eqRaf = 0;
    if (!audioCtx || audioCtx.state !== 'running' || audio.paused) { eqFloor(); return; }
    const eq = document.querySelector('.track.playing .eq');
    if (eq) {
      eq.classList.add('live');
      analyser.getByteFrequencyData(eqFreq);
      const bars = eq.querySelectorAll('i');
      const band = (a, b) => { let s = 0; for (let k = a; k <= b; k += 1) s += eqFreq[k]; return s / ((b - a + 1) * 255); };
      const targets = [band(1, 4), band(5, 9), band(10, 15)];
      for (let i = 0; i < 3; i += 1) {
        if (!bars[i]) break;
        const v = Math.min(1, Math.pow(targets[i], 0.75) * 1.15);
        eqSmooth[i] += (v - eqSmooth[i]) * 0.4;
        bars[i].style.transform = `scaleY(${(0.18 + eqSmooth[i] * 0.82).toFixed(3)})`;
      }
    }
    eqRaf = requestAnimationFrame(tick);
  };
  eqRaf = requestAnimationFrame(tick);
}
function stopEqLoop() {
  if (eqRaf) cancelAnimationFrame(eqRaf);
  eqRaf = 0;
  eqFloor();
}

async function applyEffect(key) {
  state.effect = key || null;
  ls.set('effect', state.effect);
  if (!key) { teardownEffectChain(); state.effectOn = false; renderFxOptions(); return; }
  const fx = state.trackEffects.find(f => f.key === key);
  if (!fx) return;
  ensureGraph();
  try {
    let config = fx.config || null;
    if (!config && fx.configUrl) config = await (await fetch(`/api/effect-config?url=${encodeURIComponent(fx.configUrl)}`)).json();
    if (!config?.chains?.length) throw new Error('empty config');
    if (state.effect !== key) return; // 已切走
    teardownEffectChain();           // 此时 source → destination 直通
    mediaSource.disconnect();        // 断开直通旁路
    const nodes = buildEffectNodes(audioCtx, config);
    let prev = mediaSource;
    for (const n of nodes) {
      const input = n.input || n;
      const output = n.output || n;
      prev.connect(input);
      prev = output;
    }
    prev.connect(outputTap);
    effectChain = { input: nodes[0] ? (nodes[0].input || nodes[0]) : null, output: prev, nodes };
    state.effectOn = true;
  } catch (e) {
    toast('音效加载失败,已保持原声', 'err');
    state.effect = null;
    ls.set('effect', null);
    state.effectOn = false;
  }
  renderFxOptions();
}

async function refreshTrackEffects() {
  const t = state.queue[state.queueIndex];
  if (!t) { renderFxOptions(); return; }
  try {
    const r = await (await fetch(`/api/effects/${t.id}`)).json();
    state.trackEffects = r.effects || [];
  } catch (_) { state.trackEffects = []; }
  // 对齐客户端行为:当前音效在新歌上不可用时自动关闭
  if (state.effect && !state.trackEffects.some(f => f.key === state.effect)) {
    if (state.effectOn) { teardownEffectChain(); state.effectOn = false; }
    state.effect = null;
    ls.set('effect', null);
  } else if (state.effect && !state.effectOn) {
    applyEffect(state.effect);
  }
  renderFxOptions();
}

function renderFxOptions() {
  const select = $('fx-select');
  if (!select) return;
  const fx = state.trackEffects.find(f => f.key === 'intelligent');
  const presets = state.trackEffects.filter(f => f.key !== 'intelligent');
  const options = ['<option value="">原声</option>'];
  if (fx) options.push(`<option value="intelligent"${state.effect === 'intelligent' ? ' selected' : ''}>智能音效</option>`);
  for (const p of presets) options.push(`<option value="${p.key}"${state.effect === p.key ? ' selected' : ''}>${esc(p.name)}</option>`);
  select.innerHTML = options.join('');
  select.value = state.effect || '';
  select.title = fx
    ? '智能音效为汽水接口逐曲调校;其余为官方同款目录,Web Audio 实时渲染'
    : '当前歌曲无智能音效;预置音效为官方同款目录,Web Audio 实时渲染';
}

// ---------------------------------------------------------------- my cache (multi-library manager)

const storeCoverUrl = name => `/api/store/cover?set=${encodeURIComponent(name)}`;
const storeJson = (p, body) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

// 导入流程:选文件 → 一个弹窗里问 合并/替换(单入口,选择出现在导入时) → 执行
let pendingImportFile = null;
let pendingImportTarget = null;   // 'new' = 侧栏＋导入(自动取名建新库);null = 当前库视图内导入
function openImportModal() {
  const m = $('import-modal');
  if (!m) return;
  m.classList.remove('hidden');
  requestAnimationFrame(() => m.classList.add('open'));
}
function closeImportModal() {
  const m = $('import-modal');
  if (!m) return;
  m.classList.remove('open');
  setTimeout(() => m.classList.add('hidden'), 220);
  pendingImportFile = null;
}
async function runImport(mode) {
  const job = pendingImportFile;
  closeImportModal();
  if (!job) return;
  toast(`正在${mode === 'merge' ? '合并' : '替换'}导入「${job.file.name}」到「${job.name}」…`);
  try {
    const r = await (await fetch(`/api/restore?set=${encodeURIComponent(job.name)}&mode=${mode}&activate=0`, { method: 'POST', body: job.file })).json();
    if (r?.ok) {
      toast(`导入完成:${r.imported} 个文件${r.skipped ? `,跳过 ${r.skipped}` : ''}`, 'ok');
      renderStoreHero(); renderStoreTracksView(); loadStores(); decorateCacheBadges();
    } else toast('导入失败:' + (r?.error || '文件格式不正确'), 'err');
  } catch (err) { toast('导入失败:' + err.message, 'err'); }
}

async function loadStores() {
  try {
    const r = await (await fetch('/api/store/sets')).json();
    state.storeSets = r.sets || [];
    state.storeActive = r.active;
    $('stores').innerHTML = state.storeSets.map((s, i) => `
      <div class="pl-item st-item${state.storeView?.name === s.name ? ' active' : ''}" data-i="${i}">
        ${s.cover
          ? `<img loading="lazy" src="${storeCoverUrl(s.name)}" alt="">`
          : `<span class="st-fallback sm">${esc([...s.name][0] || '库')}</span>`}
        <div><div class="t">${esc(s.name)}</div><div class="c">${s.tracks} 首 · ${(s.size / 1048576).toFixed(1)}MB${s.active ? ' · 使用中' : ''}</div></div>
        ${s.active ? '' : `<button class="st-row-del" data-name="${esc(s.name)}" title="删除此缓存库">✕</button>`}
      </div>`).join('') || '<div class="store-empty">还没有缓存库 — 播放在线歌曲会自动建立</div>';
    $('stores').querySelectorAll('.st-row-del').forEach(btn => {
      btn.onclick = async e => {
        e.stopPropagation();
        const name = btn.dataset.name;
        if (!confirm(`删除缓存库「${name}」?其中歌曲将全部移除。`)) return;
        const r = await storeJson('/api/store/delete', { name });
        if (r?.ok) {
          toast(`已删除「${name}」`, 'ok');
          if (state.storeView?.name === name) { ls.set('storeView', ''); setTimeout(() => location.reload(), 500); }
          else loadStores();
        } else toast(r?.error || '删除失败', 'err');
      };
    });
    $('stores').querySelectorAll('.st-item').forEach(el => {
      el.onclick = () => openStoreView(state.storeSets[Number(el.dataset.i)].name);
    });
    armImgs($('stores'));
  } catch (_) {}
}

function setMainMode(mode) {
  const store = mode === 'store';
  document.querySelector('.toolbar').classList.toggle('hidden', store);
  $('list-head').classList.toggle('hidden', store);
  $('sentinel').classList.toggle('hidden', store);
  if (store) { state.filtered = null; $('search').value = ''; }
}

function openStoreView(name) {
  state.storeView = { name };
  ls.set('storeView', name);
  setMainMode('store');
  $('tracks').innerHTML = '';
  renderStoreHero();
  renderStoreTracksView();
  loadStores();
}

async function renderStoreHero() {
  const name = state.storeView?.name;
  if (!name) return;
  const r = await (await fetch('/api/store/sets')).json();
  const set = (r.sets || []).find(s => s.name === name);
  if (!set) { state.storeView = null; ls.set('storeView', ''); setMainMode('playlist'); return; }
  state.storeSets = r.sets; state.storeActive = r.active;
  const firstChar = esc([...set.name][0] || '库');
  $('hero').innerHTML = `
    <div class="hero-cover-wrap">${set.cover
      ? `<img id="hero-cover" class="hero-cover" src="${storeCoverUrl(name)}" alt="">`
      : `<div id="hero-cover" class="st-fallback big" title="设置封面可替换">${firstChar}</div>`}</div>
    <div class="hero-info">
      <div class="hero-kicker">缓存库${set.active ? ' · <span class="live-dot"></span>使用中' : ''}</div>
      <div class="hero-title">${esc(set.name)}</div>
      <div class="hero-sub">${set.tracks} 首 · ${(set.size / 1048576).toFixed(1)}MB</div>
      <div class="hero-actions store-hero-actions">
        ${set.active ? '' : '<button id="st-use" class="btn primary">使用此库</button>'}
        <button id="st-import" class="btn ghost">导入</button>
        <button id="st-cover" class="btn ghost">设置封面</button>
        ${set.cover ? '<button id="st-cover-rm" class="btn ghost">移除封面</button>' : ''}
        <button id="st-backup" class="btn ghost">备份</button>
        ${set.active ? '<button id="st-clear" class="btn ghost">清空</button>' : ''}
        <button id="st-del" class="btn ghost st-danger">删除</button>
      </div>
    </div>`;
  armImg($('hero-cover'));
  if ($('st-use')) $('st-use').onclick = async () => {
    const res = await storeJson('/api/store/switch', { name });
    if (res?.ok) { ls.set('storeView', name); toast(`已切换到缓存库「${name}」`, 'ok'); setTimeout(() => location.reload(), 500); }
    else toast(res?.error || '切换失败', 'err');
  };
  if ($('st-import')) $('st-import').onclick = () => $('restore-file').click();
  if ($('st-cover')) $('st-cover').onclick = () => $('cover-file').click();
  if ($('st-cover-rm')) $('st-cover-rm').onclick = async () => {
    const res = await storeJson('/api/store/cover', { name, data: '' });
    if (res?.ok) { toast('封面已移除', 'ok'); renderStoreHero(); loadStores(); }
  };
  if ($('st-backup')) $('st-backup').onclick = () => {
    toast('正在打包该缓存库(浏览器开始下载)…');
    const a = document.createElement('a');
    a.href = `/api/backup?set=${encodeURIComponent(name)}`; a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
  };
  if ($('st-clear')) $('st-clear').onclick = async () => {
    if (!confirm(`清空缓存库「${name}」的全部歌曲?`)) return;
    await fetch('/api/store/clear', { method: 'POST' });
    state.storeProgress.clear(); toast('已清空', 'ok');
    renderStoreHero(); renderStoreTracksView(); loadStores(); decorateCacheBadges();
  };
  if ($('st-del')) $('st-del').onclick = async () => {
    if (!confirm(`删除缓存库「${name}」?其中歌曲将全部移除。`)) return;
    const res = await storeJson('/api/store/delete', { name });
    if (res?.ok) { ls.set('storeView', ''); toast(`已删除「${name}」`, 'ok'); setTimeout(() => location.reload(), 500); }
    else toast(res?.error || '删除失败', 'err');
  };
}

async function renderStoreTracksView() {
  const name = state.storeView?.name;
  if (!name) return;
  const [tr, setR] = await Promise.all([
    (await fetch(`/api/store/tracks?set=${encodeURIComponent(name)}`)).json(),
    (await fetch(`/api/store/set?set=${encodeURIComponent(name)}`)).json(),
  ]);
  const list = tr.tracks || [];
  state.storeTracks = list;
  const isActiveSet = name === state.storeActive;
  if (!list.length) {
    $('tracks').innerHTML = '<div class="empty">这个缓存库还没有歌曲 — 播放过的在线歌曲会自动缓存到使用中的库,或用「导入」导入歌单包</div>';
    return;
  }
  // 库内歌单分组(set.json 的 songs 顺序即排序);不在任何歌单的进「未分组」
  const byId = new Map(list.map(t => [t.id, t]));
  const inGroup = new Set();
  const pls = (setR?.playlists || []).map(pl => ({
    name: pl.name || '未命名歌单',
    icon: pl.icon || null,
    items: (pl.songs || []).map(id => byId.get(id)).filter(Boolean),
  }));
  for (const g of pls) for (const t of g.items) inGroup.add(t.id);
  const ungrouped = list.filter(t => !inGroup.has(t.id));
  const collapsed = new Set(ls.get('storecol-' + name, []));
  const frag = document.createDocumentFragment();
  let rowIdx = 0;
  const addGroup = (title, iconDataUrl, items) => {
    const key = title;
    const isCollapsed = collapsed.has(key);
    const group = document.createElement('div');
    group.className = 'st-group' + (isCollapsed ? ' collapsed' : '');
    const head = document.createElement('button');
    head.className = 'st-group-head';
    head.innerHTML = `
      <span class="st-caret">${isCollapsed ? '▸' : '▾'}</span>
      ${iconDataUrl
        ? `<img class="st-pl-icon" src="${iconDataUrl}" alt="">`
        : `<span class="st-fallback sm">${esc([...title][0] || '歌')}</span>`}
      <span class="st-pl-name">${esc(title)}</span>
      <span class="st-pl-meta">${items.length} 首</span>`;
    head.onclick = () => {
      group.classList.toggle('collapsed');
      const nowCollapsed = group.classList.contains('collapsed');
      const cur = new Set(ls.get('storecol-' + name, []));
      if (nowCollapsed) cur.add(key); else cur.delete(key);
      ls.set('storecol-' + name, [...cur]);
      head.querySelector('.st-caret').textContent = nowCollapsed ? '▸' : '▾';
    };
    const body = document.createElement('div');
    body.className = 'st-group-body';
    items.forEach(t => { body.appendChild(storeRowEl(t, rowIdx, isActiveSet)); rowIdx += 1; });
    group.appendChild(head);
    group.appendChild(body);
    frag.appendChild(group);
  };
  pls.forEach(g => addGroup(g.name, g.icon, g.items));
  if (ungrouped.length) addGroup('未分组', null, ungrouped);
  $('tracks').innerHTML = '';
  $('tracks').appendChild(frag);
}

function storeRowEl(t, i, isActiveSet) {
  const el = document.createElement('div');
  el.className = 'track store-row';
  el.dataset.id = t.id;
  el.style.setProperty('--i', String(i));
  const playable = isActiveSet && t.complete;
  el.innerHTML = `
    <div class="cell-idx"><span class="num">${i + 1}</span>${playable ? `<button class="hovp" title="播放">${ICONS.playRow}</button>` : ''}</div>
    <div class="name"><span class="t-name">${esc(t.name || `曲目 ${String(t.id).slice(-6)}`)}</span>${t.preview ? '<span class="badge preview">试听</span>' : ''}${t.quality ? `<span class="badge qual">${esc(t.quality)}</span>` : ''}</div>
    <div class="artist st-size">${(t.size / 1048576).toFixed(1)}MB</div>
    <div class="album st-state${t.complete ? ' ok' : ''}">${t.complete ? '已缓存' : '未完成'}</div>
    <div class="cell-cache"><button class="mini-btn st-rm">移除</button></div>`;
  const play = () => { if (!playable) { if (!isActiveSet) toast('先「使用此库」再播放', 'err'); return; } playStoreTrack(t); };
  el.onclick = play;
  el.querySelector('.hovp')?.addEventListener('click', e => { e.stopPropagation(); play(); });
  el.querySelector('.st-rm').addEventListener('click', async e => {
    e.stopPropagation();
    await storeJson('/api/store/remove-track', { id: t.id, set: state.storeView?.name });
    state.storeProgress.delete(t.id);
    renderStoreTracksView(); renderStoreHero(); loadStores(); decorateCacheBadges();
  });
  return el;
}

function playStoreTrack(track) {
  const playable = (state.storeTracks || []).filter(t => t.complete);
  const idx = playable.findIndex(t => t.id === track.id);
  if (idx < 0) return;
  const objs = playable.map(t => ({ id: t.id, name: t.name || `曲目 ${String(t.id).slice(-6)}`, artists: [], album: '', duration: 0, cover: null, vip: false, qualities: [] }));
  setQueue(objs, idx);
}

// ---------------------------------------------------------------- export wizard (playlist package → zip)

// 三步向导:① 选歌单/歌曲(复选+全选+搜索+计数) ② 库名必填+库图标(可选)
// ③ 选目标文件夹(showDirectoryPicker)或直接进下载目录 → <库名>-qsyy.zip
const exportWizard = {
  tracks: new Map(),     // playlistId → tracks[](展开时懒加载全部分页)
  icons: new Map(),      // playlistId → 封面 dataURL(导出时作为歌单图标)
  selected: new Map(),   // playlistId → Set(trackId)
  expanded: new Set(),
  name: '',
  icon: null,            // 库图标 dataURL
  jobId: null,
  pollTimer: null,
};

async function fetchPlaylistTracksFull(id) {
  const all = [];
  let cursor = '';
  let guard = 0;
  while (guard < 60) {
    guard += 1;
    const data = await api(`/api/playlist/${id}?${new URLSearchParams({ playlist_id: id, cursor, count: 100 })}`);
    const items = (data?.media_resources || [])
      .filter(m => m?.type === 'track' && m?.entity?.track_wrapper?.track)
      .map(m => {
        const t = m.entity.track_wrapper.track;
        return { id: String(t.id), name: t.name, artists: (t.artists || []).map(a => a.name).filter(Boolean), album: t.album?.name || '', duration: Number(t.duration) || 0 };
      });
    all.push(...items);
    if (!data?.has_more || !data?.next_cursor) break;
    cursor = data.next_cursor;
  }
  return all;
}

const expCloseModal = () => {
  const m = $('export-modal');
  if (!m) return;
  m.classList.remove('open');
  setTimeout(() => m.classList.add('hidden'), 220);
  if (exportWizard.pollTimer) { clearInterval(exportWizard.pollTimer); exportWizard.pollTimer = null; }
};

function openExportWizard() {
  const w = exportWizard;
  w.tracks.clear(); w.icons.clear(); w.selected.clear(); w.expanded.clear();
  w.name = ''; w.icon = null; w.jobId = null;
  $('exp-name').value = '';
  $('exp-filename').textContent = '-qsyy.zip';
  $('exp-icon-preview').innerHTML = '库';
  $('exp-icon-preview').classList.remove('has-img');
  $('exp-icon-rm').classList.add('hidden');
  $('exp-progress').textContent = '';
  $('exp-progress').classList.remove('done');
  $('exp-done-hint').textContent = '';
  if (!window.showDirectoryPicker) $('exp-pick-dir').classList.add('hidden');
  expGotoStep(1);
  renderExportStep1();
  const m = $('export-modal');
  m.classList.remove('hidden');
  requestAnimationFrame(() => m.classList.add('open'));
}

function expGotoStep(n) {
  exportWizard.step = n;
  ['exp-step1', 'exp-step2', 'exp-step3'].forEach(id => $(id).classList.add('hidden'));
  $(n === 1 ? 'exp-step1' : n === 2 ? 'exp-step2' : 'exp-step3').classList.remove('hidden');
}

async function toggleExportPlaylist(plId) {
  const w = exportWizard;
  if (w.expanded.has(plId)) w.expanded.delete(plId);
  else w.expanded.add(plId);
  renderExportStep1();
  if (w.expanded.has(plId) && !w.tracks.has(plId)) {
    const pl = state.playlists.find(p => p.id === plId);
    if (!pl) return;
    const [tracks, icon] = await Promise.all([fetchPlaylistTracksFull(plId), fetchCover(pl)]);
    w.tracks.set(plId, tracks);
    if (icon) w.icons.set(plId, icon);
    if (!w.selected.has(plId)) w.selected.set(plId, new Set());
    renderExportStep1();
  }
}

function renderExportStep1() {
  const w = exportWizard;
  const q = ($('exp-search').value || '').trim().toLowerCase();
  const list = $('exp-list');
  list.innerHTML = state.playlists.map((pl, i) => {
    const sel = w.selected.get(pl.id);
    const tracks = w.tracks.get(pl.id) || [];
    const expanded = w.expanded.has(pl.id);
    const allChecked = tracks.length > 0 && sel?.size === tracks.length;
    const some = sel?.size > 0 && !allChecked;
    const match = t => !q || t.name.toLowerCase().includes(q) || t.artists.join(' ').toLowerCase().includes(q);
    const visCount = tracks.filter(match).length;
    const plHide = q && !pl.title.toLowerCase().includes(q) && visCount === 0;
    const songs = tracks.map((t, j) => `
      <label class="exp-song${match(t) ? '' : ' hidden'}" data-pl="${pl.id}" data-id="${t.id}">
        <input type="checkbox" class="exp-song-check" ${sel?.has(t.id) ? 'checked' : ''}>
        <span class="s-name">${esc(t.name)}</span>
        <span class="s-artist">${esc(t.artists.join(' / '))}</span>
      </label>`).join('');
    return `<div class="exp-pl${expanded ? ' open' : ''}${plHide ? ' hidden' : ''}" data-id="${pl.id}">
      <div class="exp-pl-head">
        <button class="exp-caret" title="展开/收起">${expanded ? '▾' : '▸'}</button>
        <input type="checkbox" class="exp-pl-check" ${allChecked ? 'checked' : ''} ${some ? 'style="opacity:.5"' : ''}>
        <span class="exp-pl-title">${esc(pl.title)}</span>
        <span class="exp-pl-meta">${tracks.length || pl.count} 首${w.selected.get(pl.id)?.size ? ` · 已选 ${w.selected.get(pl.id).size}` : ''}</span>
      </div>
      <div class="exp-songs${expanded ? '' : ' hidden'}">${expanded ? (tracks.length ? songs : '<div class="exp-loading">加载中…</div>') : ''}</div>
    </div>`;
  }).join('');
  list.querySelectorAll('.exp-caret').forEach(el => { el.onclick = () => toggleExportPlaylist(el.closest('.exp-pl').dataset.id); });
  list.querySelectorAll('.exp-pl-check').forEach(el => {
    el.onchange = async () => {
      const plId = el.closest('.exp-pl').dataset.id;
      if (!w.tracks.has(plId)) await toggleExportPlaylist(plId); // 勾选未展开的歌单:先拉全曲目
      const tracks = w.tracks.get(plId) || [];
      const set = w.selected.get(plId) || new Set();
      if (el.checked) tracks.forEach(t => set.add(t.id));
      else set.clear();
      w.selected.set(plId, set);
      renderExportStep1();
    };
  });
  list.querySelectorAll('.exp-song-check').forEach(el => {
    el.onchange = () => {
      const row = el.closest('.exp-song');
      const set = w.selected.get(row.dataset.pl) || new Set();
      if (el.checked) set.add(row.dataset.id); else set.delete(row.dataset.id);
      w.selected.set(row.dataset.pl, set);
      renderExportStep1();
    };
  });
  const plCount = [...w.selected.values()].filter(s => s.size > 0).length;
  const songCount = [...w.selected.values()].reduce((n, s) => n + s.size, 0);
  $('exp-count').textContent = `已选 ${plCount} 个歌单 · ${songCount} 首`;
  $('exp-next').disabled = songCount === 0;
}

async function expConfirm() {
  const w = exportWizard;
  w.name = ($('exp-name').value || '').trim();
  if (!w.name) return;
  const playlists = [];
  for (const [plId, sel] of w.selected) {
    if (!sel.size) continue;
    const pl = state.playlists.find(p => p.id === plId);
    const tracks = w.tracks.get(plId) || [];
    playlists.push({
      name: pl?.title || '未命名歌单',
      icon: w.icons.get(plId) || null,
      songs: tracks.filter(t => sel.has(t.id)).map(t => ({ id: t.id, name: t.name, artist: t.artists.join(' / '), album: t.album, duration: t.duration })),
    });
  }
  if (!playlists.length) return;
  try {
    const r = await (await fetch('/api/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: w.name, libraryIcon: w.icon, playlists }) })).json();
    if (!r?.ok) { toast(r?.error || '导出失败', 'err'); return; }
    w.jobId = r.jobId;
    expGotoStep(3);
    $('exp-progress').textContent = '正在构建导出包…';
    exportWizard.pollTimer = setInterval(expPoll, 600);
  } catch (e) { toast('导出失败:' + e.message, 'err'); }
}

async function expPoll() {
  const w = exportWizard;
  if (!w.jobId) return;
  try {
    const r = await (await fetch(`/api/export/status?job=${encodeURIComponent(w.jobId)}`)).json();
    if (r?.status === 'error') { clearInterval(w.pollTimer); w.pollTimer = null; $('exp-progress').textContent = `导出失败:${r.error || '未知错误'}`; return; }
    if (r?.status === 'building') { $('exp-progress').textContent = `${r.phase}…(${r.done}/${r.total})`; return; }
    if (r?.status === 'done') {
      clearInterval(w.pollTimer); w.pollTimer = null;
      $('exp-progress').textContent = `导出包就绪:${(r.size / 1048576).toFixed(1)}MB`;
      $('exp-progress').classList.add('done');
    }
  } catch (_) {}
}

async function expPickDir() {
  const w = exportWizard;
  if (!w.jobId) return;
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    const handle = await dir.getFileHandle(`${w.name}-qsyy.zip`, { create: true });
    const writable = await handle.createWritable();
    const blob = await (await fetch(`/api/export/file?job=${encodeURIComponent(w.jobId)}`)).blob();
    await writable.write(blob);
    await writable.close();
    $('exp-done-hint').textContent = `已导出到所选文件夹:${w.name}-qsyy.zip`;
    toast('导出完成', 'ok');
  } catch (e) {
    if (e?.name === 'AbortError') return; // 用户取消目录选择
    toast('导出失败:' + e.message, 'err');
  }
}

async function expToDownloads() {
  const w = exportWizard;
  if (!w.jobId) return;
  try {
    const r = await storeJson('/api/export/save', { jobId: w.jobId });
    if (r?.ok) { $('exp-done-hint').textContent = `已导出:${r.path}`; toast('已导出到下载目录', 'ok'); }
    else toast(r?.error || '导出失败', 'err');
  } catch (e) { toast('导出失败:' + e.message, 'err'); }
}

// ---------------------------------------------------------------- online availability (client session)

async function refreshWebLogin() {
  try {
    const r = await (await fetch('/api/weblogin/status')).json();
    state.onlineAvailable = Boolean(r.clientSession) || Boolean(r.loggedIn);
  } catch (_) { state.onlineAvailable = false; }
  updateFootHint();
}

function decoratePlayingRow() {
  const current = state.queue[state.queueIndex];
  document.querySelectorAll('.track').forEach(el => {
    el.classList.toggle('playing', Boolean(current) && el.dataset.id === current.id);
  });
  const eq = document.querySelector('.track.playing .eq');
  if (eq) eq.classList.toggle('paused', audio.paused);
}

function decorateCacheBadges() {
  for (const el of document.querySelectorAll('.track')) {
    const id = el.dataset.id;
    const info = state.cacheStatus.get(id);
    const store = state.storeProgress.get(id);
    const storeComplete = Boolean(store?.complete);
    const cached = el.querySelector('.badge.cached');
    const preview = el.querySelector('.badge.preview');
    if (cached && preview) {
      const storeFull = storeComplete && !store?.preview;          // 完整曲入库才算缓存
      const isPreview = (info?.ready && info.isPreview) || (storeComplete && store?.preview);
      cached.style.display = (info?.ready && !info.isPreview) || storeFull ? '' : 'none';
      preview.style.display = isPreview ? '' : 'none';
    }
    setCacheRing(el, storeComplete ? 1 : (store?.progress || 0), storeComplete || (info?.ready && !info.isPreview), busyCacheRings.has(id));
  }
  updateHeroSub();
}

// 进度圈:p∈[0,1]。done 满圈+对勾;busy 流动扫描(解析中);其余按真实比例
function setCacheRing(el, p, done, busy) {
  const ring = el.querySelector('.ring');
  if (!ring) return;
  const C = 2 * Math.PI * 8.5;
  const isDone = Boolean(done) && !busy;
  const pp = isDone ? 1 : Math.max(0, Math.min(1, p || 0));
  const fill = ring.querySelector('.ring-fill');
  ring.classList.toggle('busy', Boolean(busy) && !isDone);
  if (!ring.classList.contains('busy')) {
    fill.style.strokeDasharray = String(C);
    fill.style.strokeDashoffset = String(C * (1 - pp));
  } else {
    fill.style.strokeDasharray = '';
    fill.style.strokeDashoffset = '';
  }
  ring.classList.toggle('done', isDone);
}

// 自有缓存的实时进度:SSE 推流(250ms)+ 轮询兜底
const busyCacheRings = new Set();   // 解析中/排队中:圈做流动扫描

// ---------------------------------------------------------------- 行尾缓存环操作菜单(清理/重加载)
// position:fixed 贴 viewport 定位 + 高 z-index:避免早前 absolute 浮层被
// 同级行遮挡的层叠问题;点击外部/Esc 关闭。
let cacheMenuEl = null;
function closeCacheMenu() {
  cacheMenuEl?.remove();
  cacheMenuEl = null;
  document.removeEventListener('pointerdown', onCacheMenuOutside, true);
}
function onCacheMenuOutside(e) {
  if (cacheMenuEl && !cacheMenuEl.contains(e.target)) closeCacheMenu();
}
function openCacheMenu(track, anchor) {
  closeCacheMenu();
  const m = document.createElement('div');
  m.className = 'cache-menu';
  m.innerHTML = '<button class="cm-item">清理缓存</button><button class="cm-item">重加载缓存</button>';
  document.body.appendChild(m);
  const rect = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(rect.right - mw, window.innerWidth - mw - 8))}px`;
  m.style.top = `${rect.bottom + 6 + mh > window.innerHeight ? rect.top - mh - 6 : rect.bottom + 6}px`;
  cacheMenuEl = m;
  const [clearBtn, reloadBtn] = m.querySelectorAll('.cm-item');
  clearBtn.onclick = () => { closeCacheMenu(); doClearTrackCache(track); };
  reloadBtn.onclick = () => { closeCacheMenu(); doReloadTrackCache(track); };
  setTimeout(() => document.addEventListener('pointerdown', onCacheMenuOutside, true), 0);
}

async function doClearTrackCache(track) {
  // 只清理 qsyy 自己的增量缓存;汽水客户端的缓存只读不动
  if (!state.storeProgress.get(track.id)?.complete) {
    toast(state.cacheStatus.get(track.id)?.ready
      ? '这首歌的缓存在汽水音乐客户端内,qsyy 对客户端文件只读,无法清理'
      : '这首歌还没有缓存', 'err');
    return;
  }
  await storeJson('/api/store/remove-track', { id: track.id });
  state.storeProgress.delete(track.id);
  state.cacheStatus.delete(track.id);
  requestCacheStatus([track.id]);   // 重新评估:若客户端缓存仍在,环会保持
  decorateCacheBadges();
  toast(`已清理「${track.name}」的缓存`, 'ok');
}

async function doReloadTrackCache(track) {
  if (state.storeProgress.get(track.id)?.complete) {
    // 重加载 = 先清旧副本再走在线通路拉新
    await storeJson('/api/store/remove-track', { id: track.id });
    state.storeProgress.delete(track.id);
  }
  const r = await storeJson('/api/store/cache', { id: track.id });
  if (r?.ok) {
    busyCacheRings.add(track.id);
    decorateCacheBadges();
    pollProgress();                 // SSE 断线时的轮询兜底;进度本身走 progress-stream
    toast(`正在重新缓存「${track.name}」…`);
  } else toast('缓存任务提交失败', 'err');
}
let progressTimer = null;

function applyProgress(all) {
  let changed = false;
  for (const [id, st] of Object.entries(all || {})) {
    const prev = state.storeProgress.get(id);
    if (st.progress > 0 || st.complete || prev) busyCacheRings.delete(id);
    if (!prev || prev.complete !== st.complete || Math.abs((prev.progress || 0) - (st.progress || 0)) > 0.002) {
      state.storeProgress.set(id, st);
      changed = true;
      if (st.complete) state.cacheStatus.set(id, { ...(state.cacheStatus.get(id) || {}), ready: true, isPreview: false });
    }
  }
  if (changed) decorateCacheBadges();
}

function startProgressStream() {
  try {
    const source = new EventSource('/api/progress-stream');
    source.onmessage = ev => {
      try { applyProgress(JSON.parse(ev.data).all); } catch (_) {}
      if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    };
    source.onerror = () => {
      source.close();
      setTimeout(() => { if (!progressTimer) pollProgress(); }, 2000);
    };
  } catch (_) { pollProgress(); }
}

async function pollProgress() {
  try {
    const r = await (await fetch('/api/progress')).json();
    applyProgress(r.all);
  } catch (_) {}
  clearInterval(progressTimer);
  progressTimer = setInterval(pollProgress, 4000);
}

// cache-status: accumulating queue + sequential batches. Earlier version
// canceled pending timers on new requests, which silently dropped ids and
// left badges unloaded until every row had been hovered.
const cacheQueue = [];
const cacheQueued = new Set();
let cacheBusy = false;
function requestCacheStatus(ids) {
  for (const id of ids) {
    if (id && !state.cacheStatus.has(id) && !cacheQueued.has(id)) {
      cacheQueued.add(id);
      cacheQueue.push(id);
    }
  }
  if (!cacheBusy) pumpCacheQueue();
}
async function pumpCacheQueue() {
  if (cacheBusy || !cacheQueue.length) return;
  cacheBusy = true;
  while (cacheQueue.length) {
    const batch = cacheQueue.splice(0, 80);
    try {
      const data = await api(`/api/cache-status?ids=${batch.join(',')}`);
      for (const [id, info] of Object.entries(data.tracks || {})) {
        state.cacheStatus.set(id, info || { ready: false });
        cacheQueued.delete(id);
      }
      for (const [id, st] of Object.entries(data.store || {})) {
        state.storeProgress.set(id, st);
        if (st.complete) state.cacheStatus.set(id, { ...(state.cacheStatus.get(id) || {}), ready: true, isPreview: false });
      }
      decorateCacheBadges();
    } catch (_) {
      // leave unmarked so a later hover/page-append retries this batch
      batch.forEach(id => cacheQueued.delete(id));
      break;
    }
  }
  cacheBusy = false;
}

// ------------------------------------------------------------------ playback

function setQueue(list, index) {
  state.queue = list;
  state.queueIndex = index;
  persistQueue();
  startCurrent(true);
}

function persistQueue() {
  try {
    ls.set('queue', {
      playlistId: state.current?.id,
      ids: state.queue.map(t => t.id),
      index: state.queueIndex,
    });
  } catch (_) {}
}

function restoreQueue() {
  const saved = ls.get('queue', null);
  if (!saved?.ids?.length || saved.playlistId !== state.current?.id) return false;
  const byId = new Map(state.current.tracks.map(t => [t.id, t]));
  const queue = saved.ids.map(id => byId.get(id)).filter(Boolean);
  if (!queue.length) return false;
  state.queue = queue;
  state.queueIndex = Math.min(Math.max(0, saved.index), queue.length - 1);
  return true;
}

function startCurrent(autoplay = true) {
  const t = state.queue[state.queueIndex];
  if (!t) return;
  refreshTrackEffects();
  persistQueue();
  decoratePlayingRow();
  $('p-title').textContent = t.name;
  $('p-artist').textContent = t.artists.join(' / ');
  const pCover = $('p-cover');
  pCover.classList.remove('loaded');
  pCover.src = t.cover ? coverUrl(t.cover, 140) : '';
  applyCoverGlow(t.cover ? coverUrl(t.cover, 96) : '');
  $('p-queue-count').textContent = state.queue.length > 0 ? `${state.queueIndex + 1}/${state.queue.length}` : '';
  renderQueuePanel();
  updateMediaSession(t);
  if (!$('lyrics-panel').classList.contains('hidden') || ls.get('lyrics-open', false)) loadLyrics(t);
  ls.set('lastTrack', { playlistId: state.current?.id, trackId: t.id, position: 0 });
  audio.src = `/api/stream/${t.id}`;
  updateHeroPlayback();
  if (autoplay) {
    audio.play().catch(async err => {
      if (err?.name === 'NotAllowedError') {
        $('p-title').textContent = `${t.name} — 点 ▶ 开始`;
        return;
      }
      // clicking another song swaps audio.src: the old play() promise rejects
      // with AbortError. That's a supersede, not a failure — don't fall back.
      if (err?.name === 'AbortError') return;
      if (audio.src !== `/api/stream/${t.id}` && !audio.src.endsWith(`/api/stream/${t.id}`)) return;
      // stream failed: most often a transient (decrypt warming up, scan
      // snapshot retry). Retry once before concluding anything; only then
      // distinguish "genuinely unavailable" from "needs the client".
      let retried = false;
      try {
        await new Promise(r => setTimeout(r, 800));
        const head = await fetch(`/api/stream/${t.id}`, { headers: { range: 'bytes=0-1' } });
        if (head.ok || head.status === 206) {
          retried = true;
          audio.src = `/api/stream/${t.id}`;
          await audio.play();
          return;
        }
      } catch (_) {}
      if (retried) return;
      if (state.onlineAvailable) {
        let unavailable = false;
        try {
          const probe = await (await fetch(`/api/online/${t.id}`)).json();
          unavailable = probe?.ok === false && probe?.error === 'unavailable';
        } catch (_) {}
        if (unavailable) {
          $('p-title').textContent = `${t.name}(暂无在线资源)`;
          toast(`「${t.name}」暂时无法在线播放(资源不可用)`, 'err');
          return;
        }
        $('p-title').textContent = `${t.name}(在线播放失败)`;
        toast(`「${t.name}」在线播放失败,转为客户端缓存流程`, 'err');
        primeInClient(t);
      } else {
        $('p-title').textContent = `${t.name}(未缓存)`;
        toast('这首歌还没有本地缓存 — 在汽水音乐里播放一次后再试', 'err');
      }
    });
  }
}

function playNextIndex(step) {
  if (!state.queue.length) return;
  if (state.shuffle && step > 0 && state.queue.length > 1) {
    let n = state.queueIndex;
    while (n === state.queueIndex) n = Math.floor(Math.random() * state.queue.length);
    state.queueIndex = n;
    startCurrent();
    return;
  }
  let next = state.queueIndex + step;
  if (next >= state.queue.length) {
    if (state.repeat === 'all') next = 0;
    else { audio.pause(); return; }
  }
  if (next < 0) next = 0;
  state.queueIndex = next;
  startCurrent();
}

audio.onended = () => {
  if (state.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  playNextIndex(1);
};

// ---------------------------------------------------------------- prefetch (zero-latency switching)

// Prefetch the next track's stream head (~512KB) and lyrics the moment the
// current one starts playing. Server-side cache + browser HTTP cache make a
// subsequent play of that track near-instant; the aborted range request
// costs a fraction of a track's bandwidth.
let prefetchSeq = 0;
function prefetchNext() {
  if (!state.queue.length) return;
  let next = state.queueIndex + 1;
  if (state.shuffle) next = Math.floor(Math.random() * state.queue.length);
  if (next >= state.queue.length) next = state.repeat === 'all' ? 0 : -1;
  const t = next >= 0 ? state.queue[next] : null;
  if (!t) return;
  const seq = ++prefetchSeq;
  const id = t.id;
  // stream head: served from the server's decrypt/store cache, then cached
  // by the browser; 512KB covers a few seconds of audio start
  fetch(`/api/stream/${id}`, { headers: { range: 'bytes=0-524287' } }).then(r => r.body?.cancel()).catch(() => {});
  // lyrics ride along the resolve path; warming it makes panel open instant
  fetch(`/api/lyrics/${id}`).then(r => r.json()).catch(() => {});
  if (seq !== prefetchSeq) return; // superseded while in flight — nothing to do
}
audio.onplaying = () => {
  $('p-play').innerHTML = ICONS.pause;
  decoratePlayingRow();
  const t = state.queue[state.queueIndex];
  document.title = t ? `▶ ${t.name} · qsyy` : 'qsyy';
  prefetchNext();
  startEqLoop();
};
audio.onpause = () => { $('p-title').textContent = $('p-title').textContent.replace(' — 点 ▶ 开始', ''); $('p-play').innerHTML = ICONS.play; decoratePlayingRow(); stopEqLoop(); };
audio.ontimeupdate = () => {
  highlightLyric();
  if (!audio.duration || seeking) return;
  setSeekUI(audio.currentTime / audio.duration);
  $('p-cur').textContent = fmtTime(audio.currentTime * 1000);
  $('p-dur').textContent = fmtTime(audio.duration * 1000);
  const track = state.queue[state.queueIndex];
  if (track && Math.floor(audio.currentTime) % 5 === 0) {
    ls.set('lastTrack', { playlistId: state.current?.id, trackId: track.id, position: audio.currentTime });
  }
};
audio.onprogress = () => {
  try {
    if (audio.buffered.length && audio.duration) {
      seekBuffer.style.width = `${(audio.buffered.end(audio.buffered.length - 1) / audio.duration * 100).toFixed(1)}%`;
    }
  } catch (_) {}
};
// ------------------------------------------------------------------ seekbar (custom, draggable)

const seekbar = $('p-seekbar');
const seekFill = $('p-fill');
const seekThumb = $('p-thumb');
const seekBuffer = $('p-buffer');
let seeking = false;

function setSeekUI(ratio) {
  const r = Math.max(0, Math.min(1, ratio));
  seekFill.style.width = `${(r * 100).toFixed(2)}%`;
  seekThumb.style.left = `${(r * 100).toFixed(2)}%`;
}
function seekRatio(event) {
  const rect = seekbar.getBoundingClientRect();
  return rect.width ? (event.clientX - rect.left) / rect.width : 0;
}
seekbar.addEventListener('pointerdown', event => {
  if (!audio.duration) return;
  seeking = true;
  seekbar.classList.add('dragging');
  seekbar.setPointerCapture(event.pointerId);
  const r = seekRatio(event);
  setSeekUI(r);
  $('p-cur').textContent = fmtTime(r * audio.duration * 1000);
});
seekbar.addEventListener('pointermove', event => {
  if (!seeking || !audio.duration) return;
  const r = seekRatio(event);
  setSeekUI(r);
  $('p-cur').textContent = fmtTime(r * audio.duration * 1000);
});
seekbar.addEventListener('pointerup', event => {
  if (!seeking) return;
  seeking = false;
  seekbar.classList.remove('dragging');
  if (audio.duration) audio.currentTime = seekRatio(event) * audio.duration;
});
seekbar.addEventListener('pointercancel', () => {
  seeking = false;
  seekbar.classList.remove('dragging');
});
$('p-vol').value = String(Math.round(state.volume * 100));
audio.volume = state.volume;
$('p-vol').style.setProperty('--fill', `${Math.round(state.volume * 100)}%`);
setVolIcon();
if ($('p-vol')) $('p-vol').oninput = e => {
  state.volume = e.target.value / 100;
  audio.volume = state.volume; ls.set('volume', state.volume);
  e.target.style.setProperty('--fill', `${e.target.value}%`);
  setVolIcon();
};
if ($('p-vol-icon')) $('p-vol-icon').onclick = () => {
  state.volume = state.volume > 0 ? 0 : 0.9;
  audio.volume = state.volume;
  $('p-vol').value = String(state.volume * 100);
  $('p-vol').style.setProperty('--fill', `${Math.round(state.volume * 100)}%`);
  ls.set('volume', state.volume);
  setVolIcon();
};

if ($('p-play')) $('p-play').onclick = () => { ensureGraph(); if (!audio.src) { const v = visibleTracks(); if (v.length) setQueue(v.slice(), 0); return; } audio.paused ? audio.play() : audio.pause(); };
if ($('p-prev')) $('p-prev').onclick = () => { ensureGraph(); playNextIndex(-1); };
if ($('p-next')) $('p-next').onclick = () => { ensureGraph(); playNextIndex(1); };

// 播放栏封面:常驻淡入(src 每次切歌都换,once 不够),点开看大图
if ($('p-cover')) {
  $('p-cover').addEventListener('load', () => $('p-cover').classList.add('loaded'));
  $('p-cover').addEventListener('click', () => {
    const t = state.queue[state.queueIndex];
    if (!t?.cover) return;
    $('ce-art').src = coverUrl(t.cover, 720);
    $('ce-title').textContent = t.name;
    $('ce-artist').textContent = t.artists.join(' / ');
    $('cover-expander').classList.add('open');
  });
}
const coverExpander = $('cover-expander');
function closeCoverExpander() { coverExpander?.classList.remove('open'); }
if ($('ce-close')) $('ce-close').onclick = closeCoverExpander;
if (coverExpander) coverExpander.addEventListener('click', e => { if (e.target === coverExpander) closeCoverExpander(); });

const REPEAT_SVG = '<svg class="ic" viewBox="0 0 24 24"><path d="M4 12V9a3 3 0 0 1 3-3h13m0 0l-3-3m3 3l-3 3M20 12v3a3 3 0 0 1-3 3H4m0 0l3 3m-3-3l3-3"/></svg>';
function updateModeButtons() {
  $('p-shuffle').classList.toggle('active', state.shuffle);
  $('p-repeat').classList.toggle('active', state.repeat !== 'off');
  $('p-repeat').innerHTML = state.repeat === 'one' ? ICONS.repeatOne : REPEAT_SVG;
}
if ($('p-shuffle')) $('p-shuffle').onclick = () => { state.shuffle = !state.shuffle; ls.set('shuffle', state.shuffle); updateModeButtons(); toast(state.shuffle ? '随机播放开' : '随机播放关'); };
if ($('p-repeat')) $('p-repeat').onclick = () => {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  ls.set('repeat', state.repeat); updateModeButtons();
  toast(state.repeat === 'off' ? '循环关' : state.repeat === 'all' ? '列表循环' : '单曲循环');
};

// ------------------------------------------------------------------ MediaSession (system media keys / Now Playing)

function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  try {
    const artwork = t.cover ? [{ src: location.origin + coverUrl(t.cover, 512), sizes: '512x512', type: 'image/jpeg' }] : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.name, artist: t.artists.join(' / '), album: t.album || '', artwork,
    });
    navigator.mediaSession.setActionHandler('play', () => { ensureGraph(); audio.play(); });
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => playNextIndex(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => playNextIndex(1));
    navigator.mediaSession.setActionHandler('seekto', d => { if (d.seekTime != null && audio.duration) audio.currentTime = d.seekTime; });
  } catch (_) {}
}

// ------------------------------------------------------------------ queue panel

function renderQueuePanel() {
  if ($('queue-panel').classList.contains('hidden')) return;
  $('queue-list').innerHTML = state.queue.map((t, i) => `
    <div class="q-item${i === state.queueIndex ? ' current' : ''}" data-i="${i}">
      <div class="q-idx">${i + 1}</div>
      <img loading="lazy" src="${t.cover ? coverUrl(t.cover, 72) : ''}" alt="">
      <div><div class="q-name">${esc(t.name)}</div><div class="q-artist">${esc(t.artists.join(' / '))}</div></div>
    </div>`).join('');
  document.querySelectorAll('.q-item').forEach(el => {
    el.onclick = () => { ensureGraph(); state.queueIndex = Number(el.dataset.i); startCurrent(); };
  });
  armImgs($('queue-list'));
}
// 面板开关与侧栏按钮高亮同步(closing 视为已关)
function syncSideButtons() {
  const open = id => { const el = $(id); return Boolean(el) && !el.classList.contains('hidden') && !el.classList.contains('closing'); };
  $('p-queue-btn')?.classList.toggle('on', open('queue-panel'));
  $('p-downloads-btn')?.classList.toggle('on', open('downloads-panel'));
  $('p-lyrics-btn')?.classList.toggle('on', open('lyrics-panel'));
}
// panel helpers: fade out before hiding so closing isn't abrupt
function closePanel(el) {
  if (el.classList.contains('hidden')) return;
  el.classList.add('closing');
  // 只有仍在 closing 状态才落 hidden:若期间被重新打开(remove closing),不抢关
  setTimeout(() => { if (el.classList.contains('closing')) { el.classList.add('hidden'); el.classList.remove('closing'); } }, 190);
  syncSideButtons();
}

if ($('p-queue-btn')) $('p-queue-btn').onclick = () => {
  const panel = $('queue-panel');
  // 再点一次同一按钮 = 关闭(toggle)
  if (!panel.classList.contains('hidden')) { closePanel(panel); return; }
  panel.classList.remove('hidden');
  closePanel($('downloads-panel'));
  closePanel($('lyrics-panel'));
  renderQueuePanel();
  syncSideButtons();
};
if ($('close-queue')) $('close-queue').onclick = () => closePanel($('queue-panel'));

// ------------------------------------------------------------------ lyrics

// v2 payload: { lines: [{ ms, dur, text, cn?, words?: [{ t, d, w }] }] } — the
// per-word timings drive the karaoke highlight. v1 (lrc string only) still
// renders, just without word-level progress.
const LYRIC_LATENCY_MS = 160;   // nudge the highlight to match what you hear
const LYRIC_HOLD_MS = 2400;     // pause auto-follow after the user scrolls
const lyricsState = {
  trackId: '', lines: [], activeIdx: -1, requestSeq: 0,
  rows: [], wordSpans: [], centers: [], measured: false,
  raf: 0, lastScroll: -1, holdUntil: 0,
};

// v1 fallback: standard LRC in which a translation is a second line sharing
// the original's timestamp — fold it back into the same entry.
function lrcToLines(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const m = raw.match(/^\[(\d+):(\d+)(?:[.:](\d+))?\](.*)$/);
    if (!m) continue;
    const ms = Number(m[1]) * 60000 + Number(m[2]) * 1000 + (m[3] ? Number(m[3].padEnd(3, '0')) : 0);
    const body = m[4].trim();
    if (!body) continue;
    const prev = out[out.length - 1];
    if (prev && prev.ms === ms && !prev.cn) { prev.cn = body; continue; }
    out.push({ ms, dur: 0, text: body, words: null });
  }
  return out;
}

function renderLyrics(message = '这首歌暂时没有歌词') {
  const wrap = $('lyrics-lines');
  const empty = $('lyrics-empty');
  stopLyricsLoop();
  lyricsState.rows = [];
  lyricsState.wordSpans = [];
  lyricsState.centers = [];
  lyricsState.measured = false;
  lyricsState.activeIdx = -1;
  if (!lyricsState.lines.length) {
    wrap.innerHTML = '';
    empty.textContent = message;
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  // no spacer elements: the flex `gap` would offset them, so the half-viewport
  // headroom is applied as padding once the row heights are known
  wrap.style.paddingTop = '0px';
  wrap.style.paddingBottom = '0px';
  wrap.innerHTML = lyricsState.lines.map((l, i) => {
    const words = l.words?.length
      ? l.words.map(w => `<span class="lw">${esc(w.w)}</span>`).join('')
      : '';
    const main = words
      ? `<div class="lyric-line">${words}</div>`
      : `<div class="lyric-line plain">${esc(l.text)}</div>`;
    const tn = l.cn ? `<div class="lyric-line tn plain">${esc(l.cn)}</div>` : '';
    return `<div class="lyric-row" data-i="${i}" data-ms="${l.ms}">${main}${tn}</div>`;
  }).join('');
  lyricsState.rows = [...wrap.querySelectorAll('.lyric-row')];
  lyricsState.wordSpans = lyricsState.rows.map(r => [...r.querySelectorAll('.lw')]);
  const body = $('lyrics-body');
  body.scrollTop = 0;
  lyricsState.lastScroll = 0;
  lyricsState.holdUntil = 0;
  lyricsState.rows.forEach(el => {
    el.onclick = () => {
      if (!audio.duration) return;
      audio.currentTime = Number(el.dataset.ms) / 1000 + 0.05;
      lyricsState.holdUntil = 0;
      if (audio.paused) audio.play().catch(() => {});
      highlightLyric(true);
    };
  });
  highlightLyric(true);
  startLyricsLoop();
}

// Two passes: size the half-viewport padding from the row heights (padding, not
// spacer elements — the flex `gap` would shove spacers off-centre), then read
// back each row's centre within the scroll content.
function measureLyrics() {
  const body = $('lyrics-body');
  const wrap = $('lyrics-lines');
  lyricsState.measured = false;
  if (!body?.clientHeight || !lyricsState.rows.length) return false;
  const half = body.clientHeight / 2;
  const first = lyricsState.rows[0];
  const last = lyricsState.rows[lyricsState.rows.length - 1];
  wrap.style.paddingTop = `${Math.max(0, half - first.offsetHeight / 2)}px`;
  wrap.style.paddingBottom = `${Math.max(0, half - last.offsetHeight / 2)}px`;
  const base = wrap.offsetTop;
  lyricsState.centers = lyricsState.rows.map(r => r.offsetTop - base + r.offsetHeight / 2);
  lyricsState.measured = true;
  return true;
}

function lyricIndexAt(nowMs) {
  const lines = lyricsState.lines;
  let lo = 0;
  let hi = lines.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].ms <= nowMs) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return idx;
}

function activateRow(idx) {
  const prev = lyricsState.activeIdx;
  if (prev >= 0) {
    const spans = lyricsState.wordSpans[prev];
    if (spans) for (const s of spans) s.style.setProperty('--p', '0%');
  }
  for (const row of lyricsState.rows) row.classList.remove('active', 'near');
  lyricsState.activeIdx = idx;
  if (idx < 0) return;
  if (lyricsState.rows[idx]) lyricsState.rows[idx].classList.add('active');
  if (lyricsState.rows[idx - 1]) lyricsState.rows[idx - 1].classList.add('near');
  if (lyricsState.rows[idx + 1]) lyricsState.rows[idx + 1].classList.add('near');
}

function paintWords(idx, nowMs) {
  const words = lyricsState.lines[idx]?.words;
  const spans = lyricsState.wordSpans[idx];
  if (!words || !spans) return;
  for (let i = 0; i < spans.length; i += 1) {
    const w = words[i];
    if (!w) break;
    const p = w.d > 0 ? (nowMs - w.t) / w.d : (nowMs >= w.t ? 1 : 0);
    spans[i].style.setProperty('--p', `${Math.max(0, Math.min(1, p)) * 100}%`);
  }
}

function jumpToLyrics() {
  const body = $('lyrics-body');
  if (!lyricsState.measured || lyricsState.activeIdx < 0) return;
  body.scrollTop = Math.max(0, lyricsState.centers[lyricsState.activeIdx] - body.clientHeight / 2);
  lyricsState.lastScroll = body.scrollTop;
  lyricsState.holdUntil = 0;
}

function followLyrics(idx) {
  const body = $('lyrics-body');
  if (idx < 0 || !lyricsState.measured) return;
  const target = Math.max(0, lyricsState.centers[idx] - body.clientHeight / 2);
  // Any scroll we did not cause hands control back to the user for a moment.
  const drift = Math.abs(body.scrollTop - lyricsState.lastScroll);
  if (drift > 3) {
    lyricsState.lastScroll = body.scrollTop;
    lyricsState.holdUntil = Date.now() + LYRIC_HOLD_MS;
    return;
  }
  if (lyricsState.holdUntil > Date.now()) return;
  const cur = body.scrollTop;
  if (Math.abs(target - cur) > 600) { jumpToLyrics(); return; }
  if (Math.abs(target - cur) < 0.6) { lyricsState.lastScroll = target; return; }
  body.scrollTop = cur + (target - cur) * 0.16;
  lyricsState.lastScroll = body.scrollTop;
}

function highlightLyric(force = false) {
  const panel = $('lyrics-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  if (!lyricsState.lines.length) return;
  if (!lyricsState.measured && !measureLyrics()) return;
  const nowMs = audio.currentTime * 1000 + LYRIC_LATENCY_MS;
  const idx = lyricIndexAt(nowMs);
  if (idx !== lyricsState.activeIdx || force) {
    activateRow(idx);
    if (force) jumpToLyrics();
  }
  if (idx >= 0) paintWords(idx, nowMs);
  followLyrics(idx);
}

function startLyricsLoop() {
  if (lyricsState.raf) return;
  lyricsState.raf = requestAnimationFrame(function tick() {
    const panel = $('lyrics-panel');
    if (!panel || panel.classList.contains('hidden')) { stopLyricsLoop(); return; }
    lyricsState.raf = requestAnimationFrame(tick);
    highlightLyric(false);
  });
}

function stopLyricsLoop() {
  if (lyricsState.raf) cancelAnimationFrame(lyricsState.raf);
  lyricsState.raf = 0;
}

async function loadLyrics(track) {
  const seq = ++lyricsState.requestSeq;
  lyricsState.trackId = track.id;
  lyricsState.lines = [];
  $('lyrics-lines').innerHTML = '';
  $('lyrics-empty').textContent = '正在加载歌词…';
  $('lyrics-empty').classList.remove('hidden');
  $('lyrics-title').textContent = `${track.name} · 歌词`;
  try {
    const data = await api(`/api/lyrics/${track.id}`);
    if (seq !== lyricsState.requestSeq) return;
    if (data.ok && Array.isArray(data.lines) && data.lines.length) lyricsState.lines = data.lines;
    else if (data.ok && data.lrc) lyricsState.lines = lrcToLines(data.lrc);
    else {
      lyricsState.lines = [];
      renderLyrics(data.error === 'unavailable' ? '这首歌暂无歌词资源' : '这首歌暂时没有歌词');
      return;
    }
    renderLyrics();
  } catch (_) {
    if (seq === lyricsState.requestSeq) { lyricsState.lines = []; renderLyrics(); }
  }
}

if ($('p-lyrics-btn')) $('p-lyrics-btn').onclick = () => {
  const panel = $('lyrics-panel');
  // 再点一次同一按钮 = 关闭(toggle)
  if (!panel.classList.contains('hidden')) {
    stopLyricsLoop(); closePanel(panel); ls.set('lyrics-open', false); return;
  }
  panel.classList.remove('hidden');
  closePanel($('queue-panel'));
  closePanel($('downloads-panel'));
  ls.set('lyrics-open', true);
  syncSideButtons();
  const t = state.queue[state.queueIndex];
  if (!t) { renderLyrics('播放一首歌来查看歌词'); return; }
  if (lyricsState.trackId !== t.id || !lyricsState.lines.length) {
    loadLyrics(t);
    return;
  }
  // re-measure: the panel was display:none, so the first pass had no height
  lyricsState.measured = false;
  highlightLyric(true);
  startLyricsLoop();
};
if ($('lyrics-close')) $('lyrics-close').onclick = () => { stopLyricsLoop(); closePanel($('lyrics-panel')); ls.set('lyrics-open', false); syncSideButtons(); };

window.addEventListener('resize', () => {
  if ($('lyrics-panel').classList.contains('hidden')) return;
  lyricsState.measured = false;
  highlightLyric(true);
});

// ------------------------------------------------------------------ downloads

async function download(t) {
  const fmt = state.fmt;
  toast(`开始下载:${t.name}`);
  try {
    const coverData = await fetchCover(t);
    await api('/api/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trackId: t.id, title: t.name,
        artist: t.artists.join(' / '), album: t.album,
        quality: state.quality, outputFormat: fmt, coverData,
      }),
    });
    openDownloads();
  } catch (e) {
    toast(`下载请求失败:${e.message}`, 'err');
  }
}

async function fetchCover(t) {
  if (!t.cover) return '';
  try {
    const response = await fetch(coverUrl(t.cover, 600));
    const blob = await response.blob();
    return await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } catch (_) { return ''; }
}

function openDownloads() {
  closePanel($('queue-panel'));
  closePanel($('lyrics-panel'));
  closePanel($('store-panel'));
  $('downloads-panel').classList.remove('hidden');
  syncSideButtons();
}
if ($('p-downloads-btn')) $('p-downloads-btn').onclick = () => {
  const panel = $('downloads-panel');
  // 再点一次同一按钮 = 关闭(toggle);openDownloads 供下载流程强制打开,不做 toggle
  if (!panel.classList.contains('hidden')) { closePanel(panel); return; }
  openDownloads();
};
if ($('close-downloads')) $('close-downloads').onclick = () => closePanel($('downloads-panel'));

async function pollDownloads() {
  if ($('downloads-panel').classList.contains('hidden')) return;
  try {
    const data = await api('/api/downloads');
    $('download-list').innerHTML = data.jobs.map(j => `
      <div class="dl-item ${j.status}" data-track="${esc(j.trackId)}" data-title="${esc(j.title)}" data-artist="${esc(String(j.artist || ''))}" data-album="${esc(String(j.album || ''))}">
        <div class="dl-row1"><span class="dl-name">${esc(j.title)}</span>
        <span class="dl-state">${j.status === 'completed' ? '完成 ✓' : j.status === 'failed' ? '失败' : j.status === 'waiting' ? '等待缓存' : j.progress + '%'}</span></div>
        <div class="dl-bar"><i style="width:${j.status === 'completed' ? 100 : j.progress}%"></i></div>
        ${j.error ? `<div class="dl-err">${esc(j.error)}</div>` : ''}
        ${j.status === 'failed' ? '<div class="dl-retry">重试</div>' : ''}
      </div>`).join('') + (data.jobs.length
      ? `<div class="dl-open-folder">${ICONS.folder} 打开下载文件夹</div>`
      : '<div class="empty" style="padding:30px 0">还没有下载任务</div>');
    document.querySelectorAll('.dl-retry').forEach(el => {
      el.onclick = async () => {
        const item = el.closest('.dl-item');
        await download({ id: item.dataset.track, name: item.dataset.title, artists: item.dataset.artist ? [item.dataset.artist] : [], album: item.dataset.album, cover: null });
      };
    });
    const openBtn = document.querySelector('.dl-open-folder');
    if (openBtn && !openBtn.dataset.bound) {
      openBtn.dataset.bound = '1';
      openBtn.onclick = () => fetch('/api/open-downloads', { method: 'POST' }).catch(() => {});
    }
  } catch (_) {}
}
setInterval(pollDownloads, 1000);

// download the currently selected (playing) single track
if ($('download-current')) $('download-current').onclick = async () => {
  const t = state.queue[state.queueIndex];
  if (!t) {
    toast('先点击播放一首歌,再用「下载单曲」', 'err');
    return;
  }
  await download(t);
};

// batch download with concurrency 2
if ($('download-all')) $('download-all').onclick = async () => {
  if (state.batchActive) { toast('批量下载进行中…'); return; }
  const list = visibleTracks().filter(t => state.cacheStatus.get(t.id)?.ready);
  if (!list.length) { toast('当前列表还没有已缓存的歌(先在汽水里播放过才行)', 'err'); return; }
  state.batchActive = true;
  const fmt = state.fmt;
  toast(`批量下载 ${list.length} 首(${fmt === 'source' ? '源文件' : fmt.toUpperCase()})`, 'ok');
  openDownloads();
  let done = 0; let failed = 0;
  const worker = async () => {
    while (list.length) {
      const t = list.shift();
      try {
        const coverData = await fetchCover(t);
        await api('/api/download', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ trackId: t.id, title: t.name, artist: t.artists.join(' / '), album: t.album, quality: state.quality, outputFormat: fmt, coverData }),
        });
      } catch (_) { failed += 1; }
      done += 1;
    }
  };
  await Promise.all([worker(), worker()]);
  state.batchActive = false;
  toast(`批量下载完成:${done - failed} 成功${failed ? `,${failed} 失败` : ''}`, failed ? 'err' : 'ok');
};

// ------------------------------------------------------------------ search / toolbar / keyboard

let searchTimer = null;
if ($('search')) $('search').oninput = e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim().toLowerCase();
  searchTimer = setTimeout(() => {
    const cur = state.current;
    if (!cur) return;
    if (!q) { state.filtered = null; rebuildRows(); return; }
    state.filtered = displayTracks().filter(t =>
      t.name.toLowerCase().includes(q)
      || t.artists.join(' ').toLowerCase().includes(q)
      || (t.album || '').toLowerCase().includes(q));
    rebuildRows();
    if (!state.filtered.length) {
      $('tracks').innerHTML = `<div class="empty">${ICONS.note}<br>没有匹配的歌曲</div>`;
    }
  }, 180);
};

$('quality-select').value = state.quality;
$('format-select').value = state.fmt;
if ($('quality-select')) $('quality-select').onchange = e => { state.quality = e.target.value; ls.set('quality', state.quality); toast(`下载音质:${e.target.selectedOptions[0].textContent}`, 'ok'); };
if ($('format-select')) $('format-select').onchange = e => { state.fmt = e.target.value; ls.set('fmt', state.fmt); toast(`默认格式:${e.target.selectedOptions[0].textContent}`, 'ok'); };

document.addEventListener('keydown', e => {
  if (e.code === 'Escape' && cacheMenuEl) { closeCacheMenu(); return; }
  if (e.code === 'Escape' && $('export-modal') && !$('export-modal').classList.contains('hidden')) { expCloseModal(); return; }
  if (e.code === 'Escape' && $('import-modal') && !$('import-modal').classList.contains('hidden')) { closeImportModal(); return; }
  if (e.code === 'Escape' && coverExpander?.classList.contains('open')) { closeCoverExpander(); return; }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  // mobile browsers have no hardware keyboard; skip path is harmless
  if (e.code === 'Space') { e.preventDefault(); $('p-play').click(); }
  else if (e.code === 'ArrowRight' && audio.duration) audio.currentTime = Math.min(audio.duration - 1, audio.currentTime + 5);
  else if (e.code === 'ArrowLeft' && audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 5);
  else if (e.code === 'ArrowUp') { e.preventDefault(); $('p-vol').value = String(Math.min(100, Number($('p-vol').value) + 5)); $('p-vol').dispatchEvent(new Event('input')); }
  else if (e.code === 'ArrowDown') { e.preventDefault(); $('p-vol').value = String(Math.max(0, Number($('p-vol').value) - 5)); $('p-vol').dispatchEvent(new Event('input')); }
});

if ($('refresh')) $('refresh').onclick = async () => {
  toast('同步收藏…(歌单顺序将重置为汽水默认)');
  try {
    // 同步官方数据 = 放弃全部本地排序:清空所有歌单的自定义顺序
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('qsyy-order-')) { try { localStorage.removeItem(key); } catch (_) {} }
      else if (key.startsWith('soda-app-order-')) { try { localStorage.removeItem(key); } catch (_) {} }
    }
    await loadPlaylists(false, true);
    toast('已同步,顺序已恢复汽水默认', 'ok');
  } catch (e) { toast(`同步失败:${e.message}`, 'err'); }
};

// ------------------------------------------------------------------ sort-select + drag-to-reorder

if ($('sort-select')) {
  $('sort-select').value = state.current?.order?.mode || 'default';
  $('sort-select').onchange = async e => {
    const mode = e.target.value;
    if (mode === 'custom') return; // 占位项,由拖拽触发进入
    await loadAllTracks();
    applySortMode(mode);
    const labels = { az: '字母 A→Z', duration: '时长 短→长', lyric: '有歌词在前', random: '随机' };
    if (labels[mode]) toast(`已按${labels[mode]}排序`, 'ok');
  };
}

// 拖动排序:委托在 #tracks 上;搜索过滤中禁用;拖完固化当前顺序为 custom
(() => {
  const tracksEl = $('tracks');
  if (!tracksEl) return;
  let dragId = null;
  let dragOverEl = null;
  tracksEl.addEventListener('dragstart', e => {
    const row = e.target.closest('.track');
    if (!row || state.filtered) { e.preventDefault(); return; }
    dragId = row.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragId); } catch (_) {}
    row.classList.add('dragging');
  });
  tracksEl.addEventListener('dragend', () => {
    dragId = null;
    tracksEl.querySelectorAll('.track.dragging').forEach(el => el.classList.remove('dragging'));
    tracksEl.querySelectorAll('.track.drop-above, .track.drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
    dragOverEl = null;
  });
  tracksEl.addEventListener('dragover', e => {
    if (!dragId || state.filtered) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const row = e.target.closest('.track');
    if (!row || row.dataset.id === dragId) return;
    if (dragOverEl && dragOverEl !== row) dragOverEl.classList.remove('drop-above', 'drop-below');
    dragOverEl = row;
    const rect = row.getBoundingClientRect();
    row.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drop-above' : 'drop-below');
  });
  tracksEl.addEventListener('drop', e => {
    if (!dragId || state.filtered) return;
    e.preventDefault();
    const row = e.target.closest('.track');
    if (!row || row.dataset.id === dragId) return;
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    // 移动源,显示顺序固化为新顺序 → custom
    const list = displayTracks().slice();
    const from = list.findIndex(t => t.id === dragId);
    if (from < 0) return;
    const [moved] = list.splice(from, 1);
    let to = list.findIndex(t => t.id === row.dataset.id);
    if (to < 0) return;
    if (!before) to += 1;
    list.splice(to, 0, moved);
    state.current.order = { mode: 'custom', ids: list.map(t => t.id) };
    persistOrder();
    rerenderRows();
    if ($('sort-select')) $('sort-select').value = 'custom';
  });
})();

const sentinelObserver = new IntersectionObserver(entries => {
  if (entries.some(en => en.isIntersecting) && !state.filtered) loadMore();
}, { rootMargin: '500px' });
sentinelObserver.observe($('sentinel'));

// auto-sync playlists every 5 minutes
setInterval(() => { loadPlaylists(false).catch(() => {}); }, 5 * 60 * 1000);

// ------------------------------------------------------------------ boot

let footCacheText = '';
function updateFootHint() {
  // 缓存量小字已并入 GitHub 行(Issue #23),这里只更新它的悬停提示
  const meta = $('foot-meta');
  if (!meta) return;
  const mode = state.onlineAvailable ? '未缓存直接在线播放' : '未缓存需在汽水播放或扫码解锁';
  meta.title = footCacheText ? `${mode} · ${footCacheText}` : mode;
}

// ------------------------------------------------------------------ about/update

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function loadAppVersion() {
  try {
    const v = await api('/api/version');
    if (v?.version && v.version !== 'dev') $('app-version').textContent = `v${v.version}`;
  } catch (_) {}
}

async function checkUpdate() {
  const btn = $('check-update');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  toast('正在检查更新…');
  try {
    const info = await api('/api/version').catch(() => ({}));
    const local = info?.version || 'dev';
    const repoPath = new URL($('gh-link').href).pathname; // 单一来源:页面的仓库链接
    let tag = '';
    // 主通道:GitHub API(快)。共享出口 IP 撞上未登录限流(403)是常态，
    // 失败不报错，静默走服务端兜底。
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const r = await fetch(`https://api.github.com/repos${repoPath}/releases/latest`, { signal: ctl.signal });
        if (r.ok) tag = (await r.json()).tag_name || '';
      } finally { clearTimeout(timer); }
    } catch (_) {}
    // 兜底:服务端读 github.com 网页跳转拿 tag(不受 API 限流影响)
    if (!tag) {
      try { tag = (await api('/api/latest-release')).tag || ''; } catch (_) {}
    }
    if (!tag) {
      toast('检查失败:GitHub 访问受限，已为你打开 Releases 页', 'err');
      window.open(`${$('gh-link').href}/releases`, '_blank');
      return;
    }
    if (local !== 'dev' && cmpVersion(tag.replace(/^v/, ''), local) <= 0) {
      toast(`已是最新版 v${local}`, 'ok');
      return;
    }
    toast(`发现新版 ${tag}(当前 ${local === 'dev' ? 'dev' : `v${local}`})，正在打开…`, 'ok');
    window.open(`${$('gh-link').href}/releases/tag/${tag}`, '_blank');
  } catch (e) { toast(`检查失败:${e.message}`, 'err'); }
  finally { btn.disabled = false; }
}

async function loadStats() {
  try {
    const stats = await api('/api/stats');
    const gb = (Number(stats.totalCachedSize) / 1024 / 1024 / 1024).toFixed(1);
    footCacheText = `缓存 ${gb} GB`;
  } catch (_) {}
  updateFootHint();
}
setInterval(loadStats, 10 * 60 * 1000);

(async () => {
  // 首帧淡入:下一帧揭开 .booting;超时兜底防极端情况下白屏
  requestAnimationFrame(() => document.body.classList.remove('booting'));
  setTimeout(() => document.body.classList.remove('booting'), 800);
  // AudioContext 被系统挂起(如蓝牙断连)时的兜底:任何点击/按键都尝试恢复
  ['pointerdown', 'keydown'].forEach(evt => document.addEventListener(evt, () => {
    if (audioCtx?.state === 'suspended') audioCtx.resume().then(startEqLoop).catch(() => {});
  }, { passive: true }));
  updateModeButtons();
  // mobile: sidebar drawer toggle (elements only visible under 720px)
  const sidebar = document.querySelector('.sidebar');
  const backdrop = $('sidebar-backdrop');
  const setDrawer = open => {
    sidebar?.classList.toggle('open', open);
    backdrop?.classList.toggle('show', open);
  };
  if ($('sidebar-toggle')) $('sidebar-toggle').onclick = () => setDrawer(!sidebar?.classList.contains('open'));
  if (backdrop) backdrop.onclick = () => setDrawer(false);
  // picking a playlist closes the drawer (openPlaylist is delegated further up)
  if ($('playlists')) $('playlists').addEventListener('click', () => setDrawer(false));
  refreshWebLogin().catch(() => {});
  startProgressStream();
  fetch('/api/effects').then(r => r.json()).then(r => {
    if (Array.isArray(r?.effects) && r.effects.length) {
      state.trackEffects = state.trackEffects.length ? state.trackEffects : r.effects;
      renderFxOptions();
    }
  }).catch(() => {});
  if ($('fx-select')) $('fx-select').onchange = e => applyEffect(e.target.value || null);
  if ($('store-btn')) $('store-btn').onclick = async () => {
    const r = await (await fetch('/api/store/sets')).json();
    openStoreView(r.active);
  };
  if ($('check-update')) $('check-update').onclick = checkUpdate;
  // 选完文件 → 弹窗里问 合并/替换(单入口导入);＋ 的"导入压缩包"走自动取名建新库
  if ($('restore-file')) $('restore-file').onchange = async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (pendingImportTarget === 'new') {
      pendingImportTarget = null;
      toast(`正在导入「${file.name}」(${(file.size / 1048576).toFixed(1)}MB)…`);
      try {
        // 不带 set:服务端从 qsyy.json 自动取名(重名加 -2/-3 后缀),导入并切换到新库
        const r = await (await fetch('/api/restore?mode=replace&activate=1', { method: 'POST', body: file })).json();
        if (r?.ok) {
          toast(`已导入缓存库「${r.set}」`, 'ok');
          ls.set('storeView', r.set);
          setTimeout(() => location.reload(), 500);
        } else toast('导入失败:' + (r?.error || '文件格式不正确'), 'err');
      } catch (err) { toast('导入失败:' + err.message, 'err'); }
      return;
    }
    const name = state.storeView?.name;
    if (!name) { toast('先在侧栏「我的缓存」选择一个缓存库再导入', 'err'); return; }
    pendingImportFile = { file, name };
    $('im-set').textContent = name;
    $('im-file').textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)}MB`;
    openImportModal();
  };
  if ($('im-merge')) $('im-merge').onclick = () => runImport('merge');
  if ($('im-replace')) $('im-replace').onclick = () => runImport('replace');
  if ($('im-cancel')) $('im-cancel').onclick = closeImportModal;
  const importModal = $('import-modal');
  if (importModal) importModal.addEventListener('click', e => { if (e.target === importModal) closeImportModal(); });

  // ---------------------------------------------------------------- export wizard bindings
  if ($('export-btn')) $('export-btn').onclick = openExportWizard;
  const exportModal = $('export-modal');
  if (exportModal) exportModal.addEventListener('click', e => { if (e.target === exportModal) expCloseModal(); });
  if ($('exp-cancel1')) $('exp-cancel1').onclick = expCloseModal;
  if ($('exp-close3')) $('exp-close3').onclick = expCloseModal;
  if ($('exp-next')) $('exp-next').onclick = () => {
    expGotoStep(2);
    $('exp-filename').textContent = '…-qsyy.zip';
  };
  if ($('exp-back')) $('exp-back').onclick = () => expGotoStep(1);
  if ($('exp-search')) $('exp-search').oninput = () => renderExportStep1();
  if ($('exp-name')) $('exp-name').oninput = e => {
    const v = (e.target.value || '').trim();
    $('exp-confirm').disabled = !v;
    $('exp-filename').textContent = `${v || '…'}-qsyy.zip`;
  };
  if ($('exp-confirm')) $('exp-confirm').onclick = expConfirm;
  if ($('exp-icon-btn')) $('exp-icon-btn').onclick = () => $('export-icon-file').click();
  if ($('exp-icon-rm')) $('exp-icon-rm').onclick = () => {
    exportWizard.icon = null;
    $('exp-icon-preview').innerHTML = '库';
    $('exp-icon-preview').classList.remove('has-img');
    $('exp-icon-rm').classList.add('hidden');
  };
  if ($('export-icon-file')) $('export-icon-file').onchange = async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('请选择图片文件(jpg/png/webp)', 'err'); return; }
    const data = await new Promise(res => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.readAsDataURL(file); });
    exportWizard.icon = data;
    $('exp-icon-preview').innerHTML = `<img src="${data}" alt="">`;
    $('exp-icon-preview').classList.add('has-img');
    $('exp-icon-rm').classList.remove('hidden');
  };
  if ($('exp-pick-dir')) $('exp-pick-dir').onclick = expPickDir;
  if ($('exp-to-downloads')) $('exp-to-downloads').onclick = expToDownloads;

  if ($('cover-file')) $('cover-file').onchange = async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const name = state.storeView?.name;
    if (!name) return;
    if (!/^image\//.test(file.type)) { toast('请选择图片文件(jpg/png/webp)', 'err'); return; }
    const data = await new Promise(res => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.readAsDataURL(file); });
    const r = await storeJson('/api/store/cover', { name, data });
    if (r?.ok) { toast('封面已更新', 'ok'); renderStoreHero(); loadStores(); }
    else toast(r?.error || '封面设置失败', 'err');
  };
  // 侧栏「＋」添加库:导入压缩包(自动取名)或新建空库
  const toggleAddMenu = show => {
    $('store-add-menu')?.classList.toggle('hidden', !show);
    if (show) $('store-new-form')?.classList.add('hidden');
  };
  if ($('store-add-btn')) $('store-add-btn').onclick = () => toggleAddMenu($('store-add-menu')?.classList.contains('hidden'));
  if ($('store-import-btn')) $('store-import-btn').onclick = () => {
    pendingImportTarget = 'new';
    toggleAddMenu(false);
    $('restore-file').click();
  };
  if ($('store-empty-btn')) $('store-empty-btn').onclick = () => {
    toggleAddMenu(false);
    const form = $('store-new-form');
    form.classList.remove('hidden');
    $('store-new-name').focus();
  };
  const doCreateStore = async () => {
    const name = ($('store-new-name').value || '').trim();
    if (!name) return;
    const r = await storeJson('/api/store/create', { name });
    if (r?.ok) {
      $('store-new-name').value = '';
      $('store-new-form').classList.add('hidden');
      toast(`已新建缓存库「${name}」`, 'ok');
      loadStores(); openStoreView(name);
    } else toast(r?.error || '新建失败', 'err');
  };
  if ($('store-new-ok')) $('store-new-ok').onclick = doCreateStore;
  if ($('store-new-name')) $('store-new-name').addEventListener('keydown', e => { if (e.key === 'Enter') doCreateStore(); });
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  try {
    // boot in parallel: /api/me + /api/stats + /api/effects don't depend on
    // the playlist, and loadPlaylists already calls loadMe itself
    loadStats();
    loadAppVersion();
    loadStores();
    await loadPlaylists(true);
    // reopen the cache-library view if that's where the user last was
    const lastStore = ls.get('storeView', '');
    if (lastStore) openStoreView(lastStore);
    if (!restoreQueue()) {
      const saved = ls.get('lastTrack', null);
      // queue restore happens after playlist loads in openPlaylist resume path
      if (!saved) { /* nothing */ }
    } else {
      startCurrent(false);
    }
  } catch (e) {
    $('tracks').innerHTML = `<div class="empty">${ICONS.warn}<br>加载失败:${esc(e.message)}<br>试试点击左下角「同步收藏」</div>`;
  }
})();
