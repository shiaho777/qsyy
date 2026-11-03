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
    if (v?.shell) state.shell = v.shell;
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
  if ($('stores')) $('stores').addEventListener('click', () => setDrawer(false));
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
    // 写入库可能是隐藏暂存(.transient,不在列表):落到第一个真库,没有则提示
    const target = (r.sets || []).find(s => s.name === r.active) || (r.sets || [])[0];
    if (target) openStoreView(target.name);
    else toast('还没有缓存库 — 点「我的缓存」的 ＋ 同步或导入', 'err');
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
    const name = libraryActionName || state.storeView?.name;
    libraryActionName = '';
    if (!name) { toast('先选择一个缓存库再导入', 'err'); return; }
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
  const qrModal = $('qr-modal');
  if (qrModal) qrModal.addEventListener('click', e => { if (e.target === qrModal) closeQrModal(); });
  if ($('qr-close')) $('qr-close').onclick = closeQrModal;
  if ($('qr-refresh')) $('qr-refresh').onclick = startQr;
  if ($('qr-soda-folder')) $('qr-soda-folder').onclick = pickSodaFolder;

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
  if ($('exp-gap-back')) $('exp-gap-back').onclick = () => expGotoStep(2);
  if ($('exp-gap-skip')) $('exp-gap-skip').onclick = expGapSkip;
  if ($('exp-gap-keep')) $('exp-gap-keep').onclick = expGapKeep;
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
    const name = libraryActionName || state.storeView?.name;
    libraryActionName = '';
    if (!name) return;
    if (!/^image\//.test(file.type)) { toast('请选择图片文件(jpg/png/webp)', 'err'); return; }
    const data = await new Promise(res => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.readAsDataURL(file); });
    const r = await storeJson('/api/store/cover', { name, data });
    if (r?.ok) {
      toast('封面已更新', 'ok');
      if (state.current?.kind === 'store' && state.current.storeName === name) {
        state.current.coverUrl = `${storeCoverUrl(name)}&v=${Date.now()}`;
        state.current.storeMeta = { ...state.current.storeMeta, cover: true };
        renderHero();
        updateHeroSub();
      }
      loadStores();
    }
    else toast(r?.error || '封面设置失败', 'err');
  };
  // 侧栏「＋」添加库:同步客户端缓存 / 导入压缩包 / 新建空库
  const hideAddPop = () => {
    $('store-pop')?.classList.add('hidden');
    document.removeEventListener('pointerdown', onAddPopOutside, true);
  };
  const onAddPopOutside = e => {
    if ($('store-pop')?.contains(e.target) || e.target === $('store-add-btn')) return;
    hideAddPop();
  };
  const showAddPop = which => {
    $('store-pop')?.classList.remove('hidden');
    $('store-add-menu')?.classList.toggle('hidden', which !== 'menu');
    $('store-new-form')?.classList.toggle('hidden', which !== 'new');
    if (which === 'new') $('store-new-name')?.focus();
    setTimeout(() => document.addEventListener('pointerdown', onAddPopOutside, true), 0);
  };
  if ($('store-add-btn')) $('store-add-btn').onclick = () => {
    if ($('store-pop')?.classList.contains('hidden')) showAddPop('menu');
    else hideAddPop();
  };
  if ($('store-sync-btn')) $('store-sync-btn').onclick = () => { hideAddPop(); openSyncModal(); };
  const syncModal = $('sync-modal');
  if (syncModal) syncModal.addEventListener('click', e => { if (e.target === syncModal) closeSyncModal(); });
  if ($('sync-cancel')) $('sync-cancel').onclick = closeSyncModal;
  if ($('sync-name')) $('sync-name').oninput = e => { $('sync-confirm').disabled = !(e.target.value || '').trim(); };
  if ($('sync-confirm')) $('sync-confirm').onclick = startSync;
  // 系统目录选择器:只在桌面壳出现(standalone 返回 400,按钮本来就隐藏)
  if ($('sync-dir-btn')) $('sync-dir-btn').onclick = async () => {
    try {
      const r = await (await fetch('/api/pick-directory', { method: 'POST' })).json();
      if (r?.ok && r.path) $('sync-dir').value = r.path;
      else if (r?.error) toast(r.error, 'err');
    } catch (_) {}
  };
  if ($('sync-icon-btn')) $('sync-icon-btn').onclick = () => $('sync-icon-file').click();
  if ($('sync-icon-rm')) $('sync-icon-rm').onclick = () => {
    syncWizard.icon = null;
    $('sync-icon-preview').innerHTML = '库';
    $('sync-icon-preview').classList.remove('has-img');
    $('sync-icon-rm').classList.add('hidden');
  };
  if ($('sync-icon-file')) $('sync-icon-file').onchange = async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('请选择图片文件(jpg/png/webp)', 'err'); return; }
    const data = await new Promise(res => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.readAsDataURL(file); });
    syncWizard.icon = data;
    $('sync-icon-preview').innerHTML = `<img src="${data}" alt="">`;
    $('sync-icon-preview').classList.add('has-img');
    $('sync-icon-rm').classList.remove('hidden');
  };
  if ($('store-import-btn')) $('store-import-btn').onclick = () => {
    pendingImportTarget = 'new';
    hideAddPop();
    $('restore-file').click();
  };
  if ($('store-empty-btn')) $('store-empty-btn').onclick = () => showAddPop('new');
  const doCreateStore = async () => {
    const name = ($('store-new-name').value || '').trim();
    if (!name) return;
    const dir = ($('store-new-dir')?.value || '').trim();
    const r = await storeJson('/api/store/create', { name, dir });
    if (r?.ok) {
      $('store-new-name').value = '';
      if ($('store-new-dir')) $('store-new-dir').value = '';
      hideAddPop();
      toast(`已新建缓存库「${name}」`, 'ok');
      if (!state.storeSets.some(s => s.active)) await storeJson('/api/store/switch', { name });
      loadStores(); openStoreView(name);
    } else toast(r?.error || '新建失败', 'err');
  };
  if ($('store-new-form')) $('store-new-form').onsubmit = e => { e.preventDefault(); doCreateStore(); };
  if ($('store-new-ok')) $('store-new-ok').onclick = doCreateStore;
  if ($('store-new-name')) $('store-new-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doCreateStore(); } });
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  try {
    // boot in parallel: /api/me + /api/stats + /api/effects don't depend on
    // the playlist, and loadPlaylists already calls loadMe itself.
    // loadPlaylists may fail without 汽水 login — that must not block the
    // library-first path: local store import/browse/play work logged-out.
    loadStats();
    loadAppVersion();
    loadMe().catch(() => {});
    // 首页是汽水歌单,成员来自歌单接口。缓存库是同一套界面的另一种打开方式,
    // 不在启动时新建,也不用磁盘文件代替歌单。
    try { await loadPlaylists(true); } catch (_) {}
    if (!state.current) {
      const r = await fetch('/api/store/sets').then(x => x.json()).catch(() => null);
      const sets = r?.sets || [];
      const preferred = ls.get('storeView', '');
      const pick = sets.find(s => s.name === preferred) || sets.find(s => s.active) || sets[0];
      if (pick) await openStoreView(pick.name);
    }
    if (!restoreQueue()) {
      const saved = ls.get('lastTrack', null);
      // queue restore happens after playlist loads in openPlaylist resume path
      if (!saved) { /* nothing */ }
    } else {
      startCurrent(false);
    }
  } catch (e) {
    $('tracks').innerHTML = `<div class="empty">${ICONS.warn}<br>加载失败:${esc(e.message)}<br>试试从侧栏打开一个歌单或缓存库</div>`;
  }
})();
