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
    <img class="cover" loading="lazy" src="${trackCoverUrl(t, 96)}" alt="">
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
  if (t.storeSrc) el.dataset.local = 'full';
  else if (t.preview) el.dataset.local = 'preview';
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
  if (idx < 0) return;
  if (t.storeSrc || info?.ready || state.onlineAvailable) {
    if (!t.storeSrc && !info?.ready) {
      toast(`「${t.name}」在线播放准备中(约几秒)…`);
      markCacheBusy(t.id);
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

