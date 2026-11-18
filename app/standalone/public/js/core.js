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
  queueContext: '',            // 播放来源上下文 'playlist' | 'store:<名>';行高亮门控用
  shuffle: ls.get('shuffle', false),
  repeat: ls.get('repeat', 'off'),   // off | all | one
  cacheStatus: new Map(),
  fmt: ls.get('fmt', 'source'),
  quality: ls.get('quality', 'highest'),
  volume: ls.get('volume', 0.9),
  batchActive: false,
  onlineAvailable: false,   // 客户端会话(ttnet)或网页会话任一可用
  shell: '',                // 'electron' = 桌面壳(有系统目录选择器) | '' = 浏览器
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
// 封面取色主题已抽到 cover-theme.js(面积聚类 + OKLCH 强调色),
// 加载顺序在本文件之后,重定义 applyCoverGlow;调用方签名不变。
// 封面 CDN 绝对 URL(播放建档落盘/导出打包用);coverUrl 是其代理形态
function coverCdnUrl(info, size = 300) {
  if (!info?.uri) return '';
  const template = info.template_prefix
    ? `${info.template_prefix}-crop-center:${size}:${size}.jpg`
    : `c5_${size}x${size}.jpg`;
  return (info.urls?.[0] || '') + info.uri + '~' + template;
}
function coverUrl(info, size = 220) {
  const url = coverCdnUrl(info, size);
  return url ? `/api/cover?url=${encodeURIComponent(url)}` : '';
}
// 队列条目的封面地址:库曲目用已落盘的本地封面(coverLocal),歌单曲目走
// CDN 代理。播库歌时封面/渐变/MediaSession/大图展开与歌单播放对齐。
function trackCoverUrl(t, size = 220) {
  return t?.coverLocal || (t?.cover ? coverUrl(t.cover, size) : '');
}

