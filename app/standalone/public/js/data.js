// ------------------------------------------------------------------ data

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

function bindUserActions() {
  if ($('web-login')) $('web-login').onclick = e => { e.preventDefault(); openQrModal(); };
  if ($('soda-folder')) $('soda-folder').onclick = e => { e.preventDefault(); pickSodaFolder(); };
  if ($('web-logout')) $('web-logout').onclick = async e => {
    e.preventDefault();
    try { await fetch('/api/weblogin/logout', { method: 'POST' }); } catch (_) {}
    state.onlineAvailable = false;
    toast('已退出网页登录');
    await loadMe();
  };
}

async function loadMe() {
  let info = null;
  try {
    const me = await api('/api/me');
    state.me = me;
    info = me?.my_info || null;
  } catch (_) {
    state.me = null;
  }
  await refreshWebLogin();
  const box = $('user');
  if (!box) return;
  if (info) {
    box.innerHTML = `
      <img src="${coverUrl(info.larger_avatar_url || info.avatar_url, 80)}" alt="">
      <div class="user-copy"><div class="name">${esc(info.nickname || '')}</div>
      <div class="hint">${state.playlists.length ? state.playlists.length + ' 个歌单' : '已登录'}</div></div>`;
    armImgs(box);
  } else if (state.onlineAvailable) {
    box.innerHTML = `
      <div class="user-copy"><div class="name">已登录</div>
      <div class="hint">网页会话 · 可在线播放</div></div>
      <button id="web-logout" class="user-btn" type="button">退出</button>`;
  } else {
    box.innerHTML = `
      <div class="user-copy"><div class="name">未登录汽水</div>
      <div class="hint">${androidLoginHint()}</div></div>
      <button id="web-login" class="user-btn" type="button">扫码登录</button>
      ${window.QsyyAndroid?.pickSodaFolder ? '<button id="soda-folder" class="user-btn" type="button">授权目录</button>' : ''}`;
  }
  bindUserActions();
}

async function loadPlaylists(openSaved = true, fresh = false, autoOpen = true) {
  if (!$('playlists')) return;
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
  if (target && autoOpen && (fresh || !state.storeView)) await openPlaylist(target, openSaved);
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
  setSearchPlaceholder();
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
    if (last && last.playlistId === pl.id && (!last.context || last.context === 'playlist')) {
      const list = displayTracks();
      const idx = list.findIndex(t => t.id === last.trackId);
      if (idx >= 0) {
        state.queue = list.slice();
        state.queueIndex = idx;
        state.queueContext = 'playlist';
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
  if (!cur) return;
  const playing = state.queue[state.queueIndex];
  const sameCtx = !playing || !state.queueContext || state.queueContext === (cur.kind === 'store' ? `store:${cur.storeName}` : 'playlist');
  const heroCover = (sameCtx ? trackCoverUrl(playing, 300) : '') || (cur.cover ? coverUrl(cur.cover, 300) : '') || cur.coverUrl || '';
  const kicker = playing && sameCtx && !audio.paused ? '<span class="live-dot"></span>正在播放' : (cur.kind === 'store' ? '缓存库' : 'PLAYLIST');
  $('hero').innerHTML = `
    <div class="hero-cover-wrap"><img id="hero-cover" class="hero-cover" src="${heroCover}" alt="" data-url="${heroCover}"></div>
    <div class="hero-info">
      <div class="hero-kicker" id="hero-kicker">${kicker}</div>
      <div class="hero-title">${esc(cur.title)}</div>
      <div class="hero-sub" id="hero-sub">${cur.count} 首 · 加载中…</div>
      <div class="hero-actions">
        <button id="play-all" class="btn primary">▶ 播放全部</button>
        <button id="shuffle-play" class="btn ghost">⤨ 随机播放</button>
        ${cur.kind === 'store' ? '<button id="lib-menu" class="btn ghost">管理</button>' : ''}
      </div>
    </div>`;
  armImg($('hero-cover'));
  const playList = () => {
    const list = visibleTracks().slice();
    if (!list.length) { toast('还没有歌曲', 'err'); return null; }
    return list;
  };
  if ($('play-all')) $('play-all').onclick = () => { const list = playList(); if (list) setQueue(list, 0); };
  if ($('shuffle-play')) $('shuffle-play').onclick = () => {
    const list = playList();
    if (!list) return;
    for (let i = list.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    setQueue(list, 0);
    state.shuffle = true; ls.set('shuffle', true); updateModeButtons();
  };
  if ($('lib-menu')) $('lib-menu').onclick = e => openLibraryMenu(e.currentTarget);
}

// The hero artwork follows the currently playing track (crossfade on change),
// falling back to the playlist cover when idle.
function updateHeroPlayback() {
  const t = state.queue[state.queueIndex];
  const cur = state.current;
  const sameCtx = !t || !state.queueContext || state.queueContext === (cur?.kind === 'store' ? `store:${cur.storeName}` : 'playlist');
  const kicker = $('hero-kicker');
  if (kicker) kicker.innerHTML = t && sameCtx && !audio.paused ? '<span class="live-dot"></span>正在播放' : (cur?.kind === 'store' ? '缓存库' : 'PLAYLIST');
  const url = sameCtx ? trackCoverUrl(t, 300) : '';
  if (!url) return;
  let img = $('hero-cover');
  if (!img) return;
  if (img.dataset.url === url) return;
  // 库视图里 hero-cover 可能是占位字符块(库没设封面时)——换成 img 才能显示曲目封面
  if (img.tagName !== 'IMG') {
    const el = document.createElement('img');
    el.id = 'hero-cover';
    el.className = 'hero-cover';
    el.alt = '';
    img.replaceWith(el);
    img = el;
  }
  img.dataset.url = url;
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
  if (cur.kind === 'store') {
    const mb = Number(cur.storeMeta?.size) || cur.tracks.reduce((n, t) => n + (Number(t.size) || 0), 0);
    el.textContent = `${cur.tracks.length} 首${mb ? ` · ${(mb / 1048576).toFixed(1)}MB` : ''}${cur.storeMeta?.active ? ' · 写入' : ''}`;
    return;
  }
  // 歌单元数据里的 count 可能滞后于实际曲目数，取两者较大值，避免出现「75 首 · 已加载 91」
  const total = Math.max(Number(cur.count) || 0, cur.tracks.length);
  // 与行尾缓存环口径一致:试听片段不算已缓存
  const cachedCount = cur.tracks.filter(t => { const i = state.cacheStatus.get(t.id); return i?.ready && !i.isPreview; }).length;
  const parts = [`${total} 首`];
  if (cur.hasMore) parts.push(`已载入 ${cur.tracks.length}`);
  if (cachedCount) parts.push(!cur.hasMore && cachedCount >= cur.tracks.length ? '全部已缓存' : `${cachedCount} 首已缓存`);
  el.textContent = parts.join(' · ');
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

