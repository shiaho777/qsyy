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
      openStoreView(job.name); loadStores();
    } else toast('导入失败:' + (r?.error || '文件格式不正确'), 'err');
  } catch (err) { toast('导入失败:' + err.message, 'err'); }
}

function setSearchPlaceholder() {
  const input = $('search');
  if (!input) return;
  input.placeholder = state.current?.kind === 'store' ? '在当前缓存内搜索…' : '在当前歌单内搜索…';
}

async function loadStores() {
  try {
    const r = await (await fetch('/api/store/sets')).json();
    state.storeSets = r.sets || [];
    state.storeActive = r.active;
    $('stores').innerHTML = state.storeSets.map((s, i) => {
      const playingHere = state.queueContext === `store:${s.name}`;
      return `
      <div class="pl-item st-item${state.storeView?.name === s.name ? ' active' : ''}" data-i="${i}">
        ${s.cover
          ? `<img loading="lazy" src="${storeCoverUrl(s.name)}" alt="">`
          : `<span class="st-fallback sm">${esc([...s.name][0] || '库')}</span>`}
        <div class="st-main">
          <div class="t"><span class="nm">${esc(s.name)}</span>${s.active ? '<span class="st-pill" title="新的在线缓存写进这个库">写入</span>' : ''}</div>
          <div class="c">${s.tracks} 首 · ${(s.size / 1048576).toFixed(1)}MB${playingHere ? ' · 播放中' : ''}</div>
        </div>
        <button class="st-more" type="button" data-i="${i}" aria-label="「${esc(s.name)}」的操作" title="库操作">⋯</button>
      </div>`;
    }).join('') || '<div class="store-empty">还没有缓存库。点右上角 ＋ 新建、导入或同步。</div>';
    $('stores').querySelectorAll('.st-more').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        openLibraryMenu(btn, state.storeSets[Number(btn.dataset.i)]);
      };
    });
    $('stores').querySelectorAll('.st-item').forEach(el => {
      el.onclick = () => openStoreView(state.storeSets[Number(el.dataset.i)].name);
    });
    armImgs($('stores'));
  } catch (_) {}
}

function setMainMode() {
  document.querySelector('.toolbar')?.classList.remove('hidden');
  $('list-head')?.classList.remove('hidden');
  $('sentinel')?.classList.remove('hidden');
}

function songId(song) {
  if (song && typeof song === 'object') return String(song.id || '');
  return String(song || '');
}

function flattenStoreTracks(list, playlists) {
  const byId = new Map((list || []).map(t => [String(t.id), t]));
  const seen = new Set();
  const ordered = [];
  for (const pl of playlists || []) {
    for (const song of pl.songs || []) {
      const raw = byId.get(songId(song));
      if (raw && !seen.has(String(raw.id))) { seen.add(String(raw.id)); ordered.push(raw); }
    }
  }
  for (const t of list || []) if (!seen.has(String(t.id))) ordered.push(t);
  return ordered;
}

function storeTrackAsPlaylist(t, setName) {
  const set = encodeURIComponent(setName);
  return {
    id: String(t.id),
    name: t.name || `曲目 ${String(t.id).slice(-6)}`,
    artists: t.artist ? String(t.artist).split(' / ').filter(Boolean) : [],
    album: t.album || '',
    duration: Number(t.duration) || 0,
    cover: null,
    vip: false,
    qualities: t.quality ? [t.quality] : [],
    lyric: false,
    preview: Boolean(t.preview),
    coverLocal: t.hasCover ? `/api/store/track-cover?set=${set}&id=${t.id}` : '',
    storeSrc: t.complete ? `/api/stream/${t.id}?set=${set}` : '',
  };
}

let libraryActionName = '';

function openLibraryMenu(anchor, set) {
  const picked = set?.name ? set : (state.current?.kind === 'store' ? { name: state.current.storeName, ...(state.current.storeMeta || {}) } : null);
  if (!picked?.name) return;
  const name = picked.name;
  closeCacheMenu();
  const m = document.createElement('div');
  m.className = 'cache-menu';
  const items = [];
  if (!picked.active) items.push(['use', '设为写入库']);
  items.push(['import', '导入到此库'], ['cover', '设置封面']);
  if (picked.cover) items.push(['uncover', '移除封面']);
  items.push(['backup', '备份']);
  if (picked.active) items.push(['clear', '清空歌曲']);
  items.push(['del', '删除']);
  m.innerHTML = items.map(([k, label]) => `<button class="cm-item" data-k="${k}">${label}</button>`).join('');
  document.body.appendChild(m);
  const rect = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(rect.right - mw, window.innerWidth - mw - 8))}px`;
  m.style.top = `${rect.bottom + 6 + mh > window.innerHeight ? rect.top - mh - 6 : rect.bottom + 6}px`;
  cacheMenuEl = m;
  m.onclick = async e => {
    const key = e.target?.dataset?.k;
    if (!key) return;
    closeCacheMenu();
    if (key === 'use') {
      const res = await storeJson('/api/store/switch', { name });
      if (res?.ok) {
        toast(`「${name}」已设为写入库`, 'ok');
        loadStores();
        if (state.current?.kind === 'store') {
          state.current.storeMeta = { ...state.current.storeMeta, active: state.current.storeName === name };
          updateHeroSub();
        }
      }
      else toast(res?.error || '切换失败', 'err');
    } else if (key === 'import') { libraryActionName = name; pendingImportTarget = null; $('restore-file').click(); }
    else if (key === 'cover') { libraryActionName = name; $('cover-file').click(); }
    else if (key === 'uncover') {
      const res = await storeJson('/api/store/cover', { name, data: '' });
      if (res?.ok) {
        toast('封面已移除', 'ok');
        if (state.current?.storeName === name) {
          state.current.coverUrl = '';
          state.current.storeMeta = { ...state.current.storeMeta, cover: '' };
          renderHero(); updateHeroSub();
        }
        loadStores();
      }
    } else if (key === 'backup') {
      toast('正在打包该缓存库(浏览器开始下载)…');
      const a = document.createElement('a');
      a.href = `/api/backup?set=${encodeURIComponent(name)}`; a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
    } else if (key === 'clear') {
      if (!confirm(`清空缓存库「${name}」的全部歌曲?`)) return;
      await fetch('/api/store/clear', { method: 'POST' });
      state.storeProgress.clear();
      toast('已清空', 'ok');
      openStoreView(name);
    } else if (key === 'del') {
      const playingHere = state.queueContext === `store:${name}`;
      let msg = `删除缓存库「${name}」?其中歌曲将全部移除。`;
      if (playingHere) msg = `「${name}」正在播放。${msg}`;
      if (picked.active) msg = `「${name}」是写入库(新的在线缓存会写进它)。${msg}\n删除后写入将${(state.storeSets?.length || 0) > 1 ? '改到剩下的库' : '先不落盘,下次在线播放再按需建立'}。`;
      if (!confirm(msg)) return;
      const res = await storeJson('/api/store/delete', { name });
      if (res?.ok) { ls.set('storeView', ''); toast(`已删除「${name}」`, 'ok'); setTimeout(() => location.reload(), 500); }
      else toast(res?.error || '删除失败', 'err');
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', onCacheMenuOutside, true), 0);
}

async function openStoreView(name) {
  state.storeView = { name };
  ls.set('storeView', name);
  document.querySelectorAll('#playlists .pl-item').forEach(el => el.classList.remove('active'));
  setMainMode();
  state.filtered = null;
  if ($('search')) $('search').value = '';
  document.querySelector('.main').scrollTop = 0;
  showSkeleton();
  loadStores();
  let tr, setR, setsR;
  try {
    [tr, setR, setsR] = await Promise.all([
      fetch(`/api/store/tracks?set=${encodeURIComponent(name)}`).then(r => r.json()),
      fetch(`/api/store/set?set=${encodeURIComponent(name)}`).then(r => r.json()),
      fetch('/api/store/sets').then(r => r.json()),
    ]);
  } catch (e) {
    if (state.storeView?.name !== name) return;
    $('tracks').innerHTML = `<div class="empty">加载失败:${esc(e.message)}</div>`;
    return;
  }
  if (state.storeView?.name !== name) return;
  const set = (setsR?.sets || []).find(s => s.name === name);
  if (!set) {
    state.storeView = null;
    ls.set('storeView', '');
    toast('缓存库不存在', 'err');
    return;
  }
  state.storeSets = setsR.sets || [];
  state.storeActive = setsR.active;
  const tracks = flattenStoreTracks(tr.tracks || [], setR?.playlists).map(t => storeTrackAsPlaylist(t, name));
  state.storeTracks = tracks;
  state.current = {
    id: `store:${name}`,
    kind: 'store',
    storeName: name,
    title: set.name,
    cover: null,
    coverUrl: set.cover ? storeCoverUrl(name) : '',
    count: tracks.length,
    tracks,
    cursor: '',
    hasMore: false,
    loading: false,
    rendered: 0,
    order: null,
    storeMeta: set,
  };
  setSearchPlaceholder();
  renderHero();
  updateHeroSub();
  if (!tracks.length) {
    $('tracks').innerHTML = '<div class="empty">这个缓存还没有歌曲。在线播放会写进当前写入库,也可以用「导入」加入歌单包</div>';
    $('sentinel').textContent = '';
    if ($('sort-select')) $('sort-select').value = 'default';
    return;
  }
  await restorePlaylistOrder();
  if (state.storeView?.name !== name) return;
  if (!state.current.order) {
    state.current.rendered = 0;
    appendRows(tracks, 0);
  }
  $('sentinel').textContent = '· 没有更多了 ·';
}


// 同步汽水音乐缓存为库:填名+图标(可选)→ POST /api/store/sync → 轮询进度
const syncWizard = { icon: null, jobId: null, poll: null };
function closeSyncModal() {
  const m = $('sync-modal');
  if (!m) return;
  m.classList.remove('open');
  setTimeout(() => m.classList.add('hidden'), 220);
  if (syncWizard.poll) { clearInterval(syncWizard.poll); syncWizard.poll = null; }
}
function openSyncModal() {
  syncWizard.icon = null; syncWizard.jobId = null;
  $('sync-name').value = '';
  $('sync-dir').value = '';
  $('sync-dir-btn').classList.toggle('hidden', state.shell !== 'electron');
  $('sync-progress').textContent = '';
  $('sync-progress').classList.remove('done');
  $('sync-icon-preview').innerHTML = '库';
  $('sync-icon-preview').classList.remove('has-img');
  $('sync-icon-rm').classList.add('hidden');
  $('sync-confirm').disabled = true;
  $('sync-confirm').textContent = '开始同步';
  $('sync-cancel').classList.remove('hidden');
  const m = $('sync-modal');
  m.classList.remove('hidden');
  requestAnimationFrame(() => m.classList.add('open'));
}
async function startSync() {
  const name = ($('sync-name').value || '').trim();
  if (!name) return;
  try {
    const dir = ($('sync-dir').value || '').trim();
    const r = await (await fetch('/api/store/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, icon: syncWizard.icon, dir }) })).json();
    if (!r?.ok) { toast(r?.error || '同步失败', 'err'); return; }
    syncWizard.jobId = r.jobId;
    $('sync-confirm').disabled = true;
    $('sync-confirm').textContent = '同步中…';
    $('sync-cancel').classList.add('hidden');
    $('sync-progress').textContent = '扫描客户端缓存…';
    syncWizard.poll = setInterval(async () => {
      try {
        const s = await (await fetch(`/api/store/sync-status?job=${encodeURIComponent(syncWizard.jobId)}`)).json();
        if (s?.status === 'error') { clearInterval(syncWizard.poll); syncWizard.poll = null; $('sync-progress').textContent = `同步失败:${s.error}`; return; }
        if (s?.status === 'importing' || s?.status === 'enriching' || s?.status === 'scanning') { $('sync-progress').textContent = `${s.phase || '处理中'}…`; return; }
        if (s?.status === 'done') {
          clearInterval(syncWizard.poll); syncWizard.poll = null;
          $('sync-progress').textContent = s.total ? `完成:${s.total} 首` : (s.phase || '客户端缓存为空');
          $('sync-progress').classList.add('done');
          $('sync-confirm').textContent = '完成';
          loadStores();
          if (s.total) setTimeout(() => { closeSyncModal(); openStoreView(name); }, 900);
        }
      } catch (_) {}
    }, 700);
  } catch (e) { toast('同步失败:' + e.message, 'err'); }
}

