// ---------------------------------------------------------------- export wizard (playlist package → zip)

// 向导:① 选歌单/歌曲 ② 库名+图标 ③ 缺缓存确认(按需) ④ 选导出位置
const exportWizard = {
  tracks: new Map(),     // playlistId → tracks[](展开时懒加载全部分页)
  icons: new Map(),      // playlistId → 封面 dataURL(导出时作为歌单图标)
  selected: new Map(),   // playlistId → Set(trackId)
  expanded: new Set(),
  name: '',
  icon: null,            // 库图标 dataURL
  jobId: null,
  pollTimer: null,
  pendingPlaylists: null,
  pendingIncomplete: null,
  exporting: false,
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
        return { id: String(t.id), name: t.name, artists: (t.artists || []).map(a => a.name).filter(Boolean), album: t.album?.name || '', duration: Number(t.duration) || 0, cover: t.album?.url_cover || null };
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
  w.pendingPlaylists = null; w.pendingIncomplete = null; w.exporting = false;
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
  ['exp-step1', 'exp-step2', 'exp-step-gap', 'exp-step3'].forEach(id => $(id).classList.add('hidden'));
  const id = n === 1 ? 'exp-step1' : n === 2 ? 'exp-step2' : n === 'gap' ? 'exp-step-gap' : 'exp-step3';
  $(id).classList.remove('hidden');
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

function collectExportPlaylists() {
  const w = exportWizard;
  const playlists = [];
  for (const [plId, sel] of w.selected) {
    if (!sel.size) continue;
    const pl = state.playlists.find(p => p.id === plId);
    const tracks = w.tracks.get(plId) || [];
    playlists.push({
      name: pl?.title || '未命名歌单',
      icon: w.icons.get(plId) || null,
      songs: tracks.filter(t => sel.has(t.id)).map(t => ({
        id: t.id, name: t.name, artist: t.artists.join(' / '), album: t.album,
        duration: t.duration, cover: t.cover ? coverCdnUrl(t.cover, 300) : '',
      })),
    });
  }
  return playlists;
}

async function loadActiveStoreById() {
  try {
    const r = await (await fetch('/api/store/tracks')).json();
    return new Map((r.tracks || []).map(t => [String(t.id), t]));
  } catch (_) { return new Map(); }
}

function incompleteExportSongs(playlists, storeById) {
  const seen = new Set();
  const out = [];
  for (const pl of playlists) {
    for (const s of pl.songs || []) {
      const id = String(s.id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const st = storeById.get(id);
      const reasons = [];
      const playlistName = String(s.name || '').trim();
      const storeName = String(st?.name || '').trim();
      if (!playlistName) reasons.push('没有歌名');
      else if (st && !storeName) reasons.push('缓存里没有歌名');
      if (st?.preview) reasons.push('只有试听');
      else if (!st?.complete) reasons.push('还没缓存');
      if (st?.complete && !st.hasCover && !s.cover) reasons.push('没有封面');
      if (reasons.length) out.push({ id, name: playlistName || `曲目 ${id.slice(-6)}`, reasons });
    }
  }
  return out;
}

function dropExportSongs(playlists, skipIds) {
  return playlists
    .map(pl => ({ ...pl, songs: (pl.songs || []).filter(s => !skipIds.has(String(s.id))) }))
    .filter(pl => pl.songs.length);
}

function renderExportGap(incomplete, keptCount) {
  const n = incomplete.length;
  const primary = t => t.reasons.includes('只有试听') ? '只有试听' : t.reasons.includes('还没缓存') ? '还没缓存' : (t.reasons[0] || '还不完整');
  const nPreview = incomplete.filter(t => primary(t) === '只有试听').length;
  const nNoCache = incomplete.filter(t => primary(t) === '还没缓存').length;
  const nNoName = incomplete.filter(t => primary(t) === '没有歌名').length;
  const bits = [];
  if (nNoCache) bits.push(`${nNoCache} 首还没缓存`);
  if (nPreview) bits.push(`${nPreview} 首只有试听`);
  if (nNoName) bits.push(`${nNoName} 首没有歌名`);
  let sub = `导出包只会带上当前写入库里已经下完的音频。已选的歌里，${bits.join('，')}。放进包里的话，导入之后只能在线播。要一起带走吗？`;
  if (keptCount > 0) sub += `另外 ${keptCount} 首有完整缓存，会照常打包。`;
  $('exp-gap-sub').textContent = sub;
  const cap = 20;
  $('exp-gap-list').innerHTML = incomplete.slice(0, cap).map(t => `
    <div class="exp-gap-row">
      <span class="s-name">${esc(t.name)}</span>
      <span class="s-tag">${esc(t.reasons.join(' · '))}</span>
    </div>`).join('') + (n > cap ? `<div class="exp-gap-more">还有 ${n - cap} 首没列出来</div>` : '');
  $('exp-gap-count').textContent = `${n} 首不完整`;
}

async function expConfirm() {
  const w = exportWizard;
  w.name = ($('exp-name').value || '').trim();
  if (!w.name) return;
  const playlists = collectExportPlaylists();
  if (!playlists.length) return;
  const btn = $('exp-confirm');
  if (btn) btn.disabled = true;
  try {
    const storeById = await loadActiveStoreById();
    const incomplete = incompleteExportSongs(playlists, storeById);
    w.pendingPlaylists = playlists;
    w.pendingIncomplete = incomplete;
    if (!incomplete.length) { await startExport(playlists); return; }
    const selected = new Set();
    for (const pl of playlists) for (const s of pl.songs) selected.add(String(s.id));
    renderExportGap(incomplete, selected.size - incomplete.length);
    expGotoStep('gap');
  } catch (e) { toast('导出失败:' + e.message, 'err'); }
  finally { if (btn) btn.disabled = !($('exp-name').value || '').trim(); }
}

async function startExport(playlists) {
  const w = exportWizard;
  if (!playlists.length) { toast('没有可以导出的歌曲', 'err'); return; }
  if (w.exporting) return;
  w.exporting = true;
  try {
    const r = await (await fetch('/api/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: w.name, libraryIcon: w.icon, playlists }) })).json();
    if (!r?.ok) { toast(r?.error || '导出失败', 'err'); return; }
    w.jobId = r.jobId;
    w.pendingPlaylists = null;
    w.pendingIncomplete = null;
    expGotoStep(3);
    $('exp-progress').textContent = '正在构建导出包…';
    exportWizard.pollTimer = setInterval(expPoll, 600);
  } catch (e) { toast('导出失败:' + e.message, 'err'); }
  finally { w.exporting = false; }
}

function expGapKeep() {
  if (!exportWizard.pendingPlaylists) return;
  startExport(exportWizard.pendingPlaylists);
}

function expGapSkip() {
  const w = exportWizard;
  if (!w.pendingPlaylists || !w.pendingIncomplete) return;
  const kept = dropExportSongs(w.pendingPlaylists, new Set(w.pendingIncomplete.map(t => t.id)));
  if (!kept.length) { toast('跳过之后就没有歌可以导出了', 'err'); return; }
  startExport(kept);
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
    if (r?.ok) {
      let where = `已导出:${r.path}`;
      if (window.QsyyAndroid?.publishDownload) {
        const err = String(window.QsyyAndroid.publishDownload(r.path) || '');
        where = err ? `导出文件已生成，放进系统下载目录失败:${err}` : '已导出到系统下载目录';
        toast(err ? where : '已导出到下载目录', err ? 'err' : 'ok');
      } else toast('已导出到下载目录', 'ok');
      $('exp-done-hint').textContent = where;
    }
    else toast(r?.error || '导出失败', 'err');
  } catch (e) { toast('导出失败:' + e.message, 'err'); }
}

