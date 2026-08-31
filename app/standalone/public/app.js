// qsyy — standalone frontend for the QiShui local player.
/* global MediaMetadata */
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
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3200);
  setTimeout(() => el.remove(), 3600);
}

function fmtTime(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
  document.querySelectorAll('.pl-item').forEach(el => {
    el.onclick = () => openPlaylist(state.playlists[Number(el.dataset.i)]);
  });
  loadMe();
  if (target) openPlaylist(target, openSaved);
}

async function openPlaylist(pl, resume = false) {
  document.querySelectorAll('.pl-item').forEach(el =>
    el.classList.toggle('active', state.playlists[Number(el.dataset.i)]?.id === pl.id));
  ls.set('lastPlaylist', pl.id);
  state.current = {
    id: pl.id, title: pl.title, cover: pl.cover, count: pl.count,
    tracks: [], cursor: '', hasMore: true, loading: false, rendered: 0,
  };
  state.filtered = null;
  $('search').value = '';
  renderHero();
  showSkeleton();
  await loadMore();
  if (resume) {
    const last = ls.get('lastTrack', null);
    if (last && last.playlistId === pl.id) {
      const idx = state.current.tracks.findIndex(t => t.id === last.trackId);
      if (idx >= 0) {
        state.queue = state.current.tracks.slice();
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
    <img id="hero-cover" class="hero-cover" src="${(playing?.cover || cur.cover) ? coverUrl(playing?.cover || cur.cover, 300) : ''}" alt="" data-url="${playing?.cover || cur.cover || ''}">
    <div class="hero-info">
      <div class="hero-kicker" id="hero-kicker">${playing ? '<span class="live-dot"></span>正在播放' : 'PLAYLIST'}</div>
      <div class="hero-title">${esc(cur.title)}</div>
      <div class="hero-sub" id="hero-sub">${cur.count} 首 · 加载中…</div>
      <div class="hero-actions">
        <button id="play-all" class="btn primary">▶ 播放全部</button>
        <button id="shuffle-play" class="btn ghost">⤨ 随机播放</button>
      </div>
    </div>`;
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
  img.style.opacity = '0';
  const reveal = () => requestAnimationFrame(() => { img.style.opacity = '1'; });
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
        };
      });
    cur.tracks.push(...items);
    cur.hasMore = Boolean(data?.has_more) && Boolean(data?.next_cursor);
    cur.cursor = data?.next_cursor || '';
    appendRows(items, startIdx);
    updateHeroSub();
  } catch (e) {
    toast(`歌单加载失败:${e.message}`, 'err');
  }
  cur.loading = false;
  $('sentinel').textContent = cur.hasMore ? '继续下拉加载更多…' : '· 没有更多了 ·';
}

// ------------------------------------------------------------------ rendering (incremental)

function visibleTracks() {
  return state.filtered ?? state.current?.tracks ?? [];
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
  decoratePlayingRow();
}

function rowEl(t, i) {
  const el = document.createElement('div');
  el.className = 'track';
  el.dataset.id = t.id;
  el.style.setProperty('--i', String(i));
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
    mediaSource.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

function teardownEffectChain() {
  try { effectChain.input?.disconnect(); } catch (_) {}
  for (const n of effectChain.nodes) {
    try { (n.output || n).disconnect(); } catch (_) {}
  }
  effectChain = { input: null, output: null, nodes: [] };
  try { mediaSource.disconnect(); mediaSource.connect(audioCtx.destination); } catch (_) {}
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
    prev.connect(audioCtx.destination);
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

// ---------------------------------------------------------------- store manager (cache sets / list / backup)

async function openStorePanel() {
  // Panels share one anchor (right/bottom) and one z-index, so a sibling left
  // open paints over this one — the wider lyrics panel hides it completely.
  closePanel($('queue-panel'));
  closePanel($('downloads-panel'));
  closePanel($('lyrics-panel'));
  $('store-panel').classList.remove('hidden');
  await Promise.all([renderStoreSets(), renderStoreTracks()]);
}

async function renderStoreSets() {
  try {
    const r = await (await fetch('/api/store/sets')).json();
    $('store-sets-hint').textContent = `${r.sets.length} 个库`;
    $('store-sets').innerHTML = r.sets.map(set => `
      <div class="store-set ${set.active ? 'active' : ''}" data-set="${esc(set.name)}">
        <span class="s-name">${esc(set.name)}</span>
        ${set.active ? '<span class="s-tag">使用中</span>' : ''}
        <span class="s-meta">${set.tracks} 首 · ${(set.size / 1048576).toFixed(1)}MB</span>
        ${set.active ? '' : `<button class="mini-btn s-switch">切换</button><button class="mini-btn s-del">删除</button>`}
      </div>`).join('');
    $('store-sets').querySelectorAll('.store-set').forEach(row => {
      const name = row.dataset.set;
      row.querySelector('.s-switch')?.addEventListener('click', async () => {
        const r = await (await fetch('/api/store/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })).json();
        if (r?.ok) { toast(`已切换到缓存库「${name}」`, 'ok'); setTimeout(() => location.reload(), 600); }
        else toast(r?.error || '切换失败', 'err');
      });
      row.querySelector('.s-del')?.addEventListener('click', async () => {
        if (!confirm(`删除缓存库「${name}」?其中歌曲将全部移除。`)) return;
        await fetch('/api/store/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
        renderStoreSets();
      });
    });
  } catch (_) {}
}

async function renderStoreTracks() {
  try {
    const r = await (await fetch('/api/store/tracks')).json();
    const list = r.tracks || [];
    $('store-tracks-hint').textContent = `${list.length} 首 · ${list.filter(t => t.preview).length} 试听`;
    if (!list.length) {
      $('store-tracks').innerHTML = '<div class="store-empty">当前缓存库还没有歌曲 — 播放过的在线歌曲会自动缓存到这里</div>';
      return;
    }
    // 曲名:优先用元数据里存的,再用已加载歌单里的,最后退化为 ID
    const known = new Map();
    for (const t of (state.current?.tracks || [])) known.set(String(t.id), t.name);
    $('store-tracks').innerHTML = list.map(t => `
      <div class="store-track" data-id="${t.id}">
        <span class="t-name">${esc(t.name || known.get(String(t.id)) || `曲目 ${String(t.id).slice(-6)}`)}${t.preview ? ' <span class="cap-hint">试听</span>' : ''}</span>
        <span class="t-size">${(t.size / 1048576).toFixed(1)}MB${t.complete ? '' : ' · 未完成'}</span>
        <button class="mini-btn t-del">移除</button>
      </div>`).join('');
    $('store-tracks').querySelectorAll('.store-track').forEach(row => {
      row.querySelector('.t-del').addEventListener('click', async () => {
        await fetch('/api/store/remove-track', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: row.dataset.id }) });
        state.storeProgress.delete(row.dataset.id);
        renderStoreTracks();
        renderStoreSets();
        decorateCacheBadges();
      });
    });
  } catch (_) {}
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
  $('p-cover').src = t.cover ? coverUrl(t.cover, 140) : '';
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
      // stream failed: check whether the track is simply unavailable online
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
audio.onplaying = () => {
  $('p-play').innerHTML = ICONS.pause;
  decoratePlayingRow();
  const t = state.queue[state.queueIndex];
  document.title = t ? `▶ ${t.name} · qsyy` : 'qsyy';
};
audio.onpause = () => { $('p-title').textContent = $('p-title').textContent.replace(' — 点 ▶ 开始', ''); $('p-play').innerHTML = ICONS.play; decoratePlayingRow(); };
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

if ($('p-play')) $('p-play').onclick = () => { if (!audio.src) { const v = visibleTracks(); if (v.length) setQueue(v.slice(), 0); return; } audio.paused ? audio.play() : audio.pause(); };
if ($('p-prev')) $('p-prev').onclick = () => playNextIndex(-1);
if ($('p-next')) $('p-next').onclick = () => playNextIndex(1);

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
    navigator.mediaSession.setActionHandler('play', () => audio.play());
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
    el.onclick = () => { state.queueIndex = Number(el.dataset.i); startCurrent(); };
  });
}
// panel helpers: fade out before hiding so closing isn't abrupt
function closePanel(el) {
  if (el.classList.contains('hidden')) return;
  el.classList.add('closing');
  setTimeout(() => { el.classList.add('hidden'); el.classList.remove('closing'); }, 190);
}

if ($('p-queue-btn')) $('p-queue-btn').onclick = () => {
  $('queue-panel').classList.remove('hidden');
  closePanel($('downloads-panel'));
  closePanel($('lyrics-panel'));
  renderQueuePanel();
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
  panel.classList.remove('hidden');
  closePanel($('queue-panel'));
  closePanel($('downloads-panel'));
  ls.set('lyrics-open', true);
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
if ($('lyrics-close')) $('lyrics-close').onclick = () => { stopLyricsLoop(); closePanel($('lyrics-panel')); ls.set('lyrics-open', false); };

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
}
if ($('p-downloads-btn')) $('p-downloads-btn').onclick = openDownloads;
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
    state.filtered = cur.tracks.filter(t =>
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
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  // mobile browsers have no hardware keyboard; skip path is harmless
  if (e.code === 'Space') { e.preventDefault(); $('p-play').click(); }
  else if (e.code === 'ArrowRight' && audio.duration) audio.currentTime = Math.min(audio.duration - 1, audio.currentTime + 5);
  else if (e.code === 'ArrowLeft' && audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 5);
  else if (e.code === 'ArrowUp') { e.preventDefault(); $('p-vol').value = String(Math.min(100, Number($('p-vol').value) + 5)); $('p-vol').dispatchEvent(new Event('input')); }
  else if (e.code === 'ArrowDown') { e.preventDefault(); $('p-vol').value = String(Math.max(0, Number($('p-vol').value) - 5)); $('p-vol').dispatchEvent(new Event('input')); }
});

if ($('refresh')) $('refresh').onclick = async () => {
  toast('同步收藏…');
  try { await loadPlaylists(false, true); toast('已同步', 'ok'); }
  catch (e) { toast(`同步失败:${e.message}`, 'err'); }
};

const sentinelObserver = new IntersectionObserver(entries => {
  if (entries.some(en => en.isIntersecting) && !state.filtered) loadMore();
}, { rootMargin: '500px' });
sentinelObserver.observe($('sentinel'));

// auto-sync playlists every 5 minutes
setInterval(() => { loadPlaylists(false).catch(() => {}); }, 5 * 60 * 1000);

// ------------------------------------------------------------------ boot

let footCacheText = '';
function updateFootHint() {
  const el = $('foot-hint');
  if (!el) return;
  const mode = state.onlineAvailable ? '未缓存直接在线播放' : '未缓存需在汽水播放或扫码解锁';
  el.textContent = footCacheText ? `${mode} · ${footCacheText}` : mode;
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
  if ($('store-btn')) $('store-btn').onclick = openStorePanel;
  if ($('store-close')) $('store-close').onclick = () => $('store-panel').classList.add('hidden');
  if ($('backup-btn')) $('backup-btn').onclick = () => {
    toast('正在打包当前缓存库(浏览器开始下载)…');
    const a = document.createElement('a');
    a.href = '/api/backup';
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  if ($('restore-btn')) $('restore-btn').onclick = () => $('restore-file').click();
  if ($('restore-file')) $('restore-file').onchange = async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const setName = file.name.replace(/\.tar$/i, '');
    toast(`正在导入「${file.name}」(${(file.size / 1048576).toFixed(1)}MB)…`);
    try {
      const r = await (await fetch(`/api/restore?set=${encodeURIComponent(setName)}`, { method: 'POST', body: file })).json();
      if (r?.ok) {
        toast(`导入完成:${r.imported} 个文件,已切换到缓存库「${r.set}」`, 'ok');
        setTimeout(() => location.reload(), 1000);
      } else {
        toast('导入失败:' + (r?.error || '文件格式不正确'), 'err');
      }
    } catch (err) {
      toast('导入失败:' + err.message, 'err');
    }
  };
  if ($('store-new-btn')) $('store-new-btn').onclick = async () => {
    const name = $('store-new-name').value.trim();
    if (!name) return;
    const r = await (await fetch('/api/store/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })).json();
    if (r?.ok) { $('store-new-name').value = ''; renderStoreSets(); toast(`已新建缓存库「${name}」`, 'ok'); }
    else toast(r?.error || '新建失败', 'err');
  };
  if ($('store-clear-btn')) $('store-clear-btn').onclick = async () => {
    if (!confirm('清空当前缓存库的全部歌曲?')) return;
    await fetch('/api/store/clear', { method: 'POST' });
    toast('已清空', 'ok');
    renderStoreSets();
    renderStoreTracks();
    state.storeProgress.clear();
    decorateCacheBadges();
  };
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  try {
    // boot in parallel: /api/me + /api/stats + /api/effects don't depend on
    // the playlist, and loadPlaylists already calls loadMe itself
    loadStats();
    await loadPlaylists(true);
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
