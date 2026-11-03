// ---------------------------------------------------------------- online availability (client session)

function sodaBridgeStatus() {
  try {
    const raw = window.QsyyAndroid?.sodaStatus?.();
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

function androidLoginHint() {
  const soda = sodaBridgeStatus() || state.sodaProbe;
  if (!window.QsyyAndroid && !soda) return '本地库仍可播放';
  if (soda?.imported) return '已导入汽水登录文件，正在读取';
  if (soda?.readable) return '已找到汽水共享目录。登录文件若在里面会自动读；否则请扫码';
  if (soda?.installed || soda?.found) {
    return '汽水已安装。安卓里每个 App 是独立用户，qsyy 读不了汽水的私有目录；Mac 能免扫码是因为桌面程序共用同一个用户目录。请扫码，或授权汽水数据目录';
  }
  if (soda?.installed === false) return '未检测到汽水音乐。安装后可扫码同步歌单，或授权它的数据目录';
  return '用汽水音乐扫码后可同步歌单、在线播放';
}

async function refreshWebLogin() {
  try {
    const r = await (await fetch('/api/weblogin/status')).json();
    state.onlineAvailable = Boolean(r.clientSession) || Boolean(r.loggedIn);
    if (r.soda) state.sodaProbe = r.soda;
  } catch (_) { state.onlineAvailable = false; }
  updateFootHint();
}

function qrImageSrc(qrcode, url) {
  const raw = String(qrcode || '').trim();
  if (raw.startsWith('data:')) return raw;
  if (/^https?:\/\//.test(raw)) return raw;
  if (raw) return `data:image/png;base64,${raw.replace(/\s/g, '')}`;
  return String(url || '');
}

let qrPoll = null;
let qrToken = '';
function stopQrPoll() {
  if (qrPoll) { clearInterval(qrPoll); qrPoll = null; }
  try { window.QsyyAndroid?.stopPassportPoll?.(); } catch (_) {}
  try { window.QsyyDesktop?.stopPassportPoll?.(); } catch (_) {}
}
function hasSignedPoller() {
  return Boolean(window.QsyyAndroid?.pollPassport || window.QsyyDesktop?.pollPassport);
}
function closeQrModal() {
  stopQrPoll();
  const m = $('qr-modal');
  if (!m) return;
  m.classList.remove('open');
  setTimeout(() => m.classList.add('hidden'), 220);
}
function pickSodaFolder() {
  try { window.QsyyAndroid?.pickSodaFolder?.(); }
  catch (err) { toast('无法打开目录选择:' + (err.message || err), 'err'); }
}
async function onQrSuccess() {
  stopQrPoll();
  toast('登录成功', 'ok');
  closeQrModal();
  await loadMe();
  await loadPlaylists(true, true).catch(() => {});
}
function applyQrPollView(r) {
  if (!r) return;
  if (r.message && $('qr-status')) $('qr-status').textContent = r.message;
  if (r.status === 'success') {
    onQrSuccess();
    return;
  }
  if (r.status === 'expired') stopQrPoll();
  if ((r.limited || r.signer) && window.QsyyAndroid?.pollPassport && qrToken) {
    try { window.QsyyAndroid.pollPassport(qrToken); } catch (_) {}
  }
}
async function pollQr() {
  if (!qrToken) return;
  try {
    if (window.QsyyAndroid?.pollPassport) {
      try { window.QsyyAndroid.pollPassport(qrToken); } catch (_) {}
      const r = await (await fetch(`/api/weblogin/poll?token=${encodeURIComponent(qrToken)}&peek=1`)).json();
      applyQrPollView(r);
      return;
    }
    if (window.QsyyDesktop?.pollPassport) {
      const signed = await window.QsyyDesktop.pollPassport(qrToken);
      applyQrPollView(signed);
      return;
    }
    const r = await (await fetch(`/api/weblogin/poll?token=${encodeURIComponent(qrToken)}`)).json();
    applyQrPollView(r);
  } catch (err) {
    if ($('qr-status')) $('qr-status').textContent = '轮询失败: ' + (err.message || err);
  }
}
async function startQr() {
  stopQrPoll();
  qrToken = '';
  if ($('qr-status')) $('qr-status').textContent = '正在获取二维码…';
  if ($('qr-image')) { $('qr-image').hidden = true; $('qr-image').removeAttribute('src'); }
  const folderBtn = $('qr-soda-folder');
  if (folderBtn) folderBtn.hidden = !window.QsyyAndroid?.pickSodaFolder;
  try {
    const r = await (await fetch('/api/weblogin/qr')).json();
    if (!r?.ok) { if ($('qr-status')) $('qr-status').textContent = r?.error || '二维码获取失败'; return; }
    qrToken = r.token || '';
    const src = qrImageSrc(r.qrcode, r.url);
    if (src && $('qr-image')) { $('qr-image').src = src; $('qr-image').hidden = false; }
    if ($('qr-hint') && r.hint) $('qr-hint').textContent = r.hint;
    if ($('qr-status')) {
      $('qr-status').textContent = hasSignedPoller() ? '正在接通汽水登录通道…' : '等待扫码';
    }
    if (qrToken) {
      qrPoll = setInterval(pollQr, 2800);
      pollQr();
    }
  } catch (err) {
    if ($('qr-status')) $('qr-status').textContent = err.message || '二维码获取失败';
  }
}
function openQrModal() {
  const m = $('qr-modal');
  if (!m) return;
  m.classList.remove('hidden');
  requestAnimationFrame(() => m.classList.add('open'));
  startQr();
}
window.__qsyyOnQrSuccess = onQrSuccess;
window.__qsyyOnQrPoll = function (payload) {
  try { applyQrPollView(typeof payload === 'string' ? JSON.parse(payload) : payload); }
  catch (_) {}
};
window.__qsyySodaImported = async function (ok) {
  toast(ok ? '已导入汽水登录文件，正在读取' : '这个目录里没有找到 Cookies 文件。可改选汽水数据目录，或继续扫码', ok ? 'ok' : 'err');
  await loadMe();
};

function decoratePlayingRow() {
  const current = state.queue[state.queueIndex];
  // 高亮仅作用于"播放来源上下文 == 当前浏览上下文":库视图播的歌不串染
  // 歌单里同 id 的行(反之亦然)——它们只是同名曲目,不是同一次播放
  const viewCtx = state.storeView ? `store:${state.storeView.name}` : 'playlist';
  const sameCtx = !state.queueContext || state.queueContext === viewCtx;
  document.querySelectorAll('.track').forEach(el => {
    el.classList.toggle('playing', Boolean(current) && sameCtx && el.dataset.id === current.id);
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
    const local = el.dataset.local;
    // 完整缓存只由行尾的缓存环表示;标题旁只保留「试听」,因为缓存环表达不了它
    const preview = el.querySelector('.badge.preview');
    if (preview) {
      const storeFull = (storeComplete && !store?.preview) || local === 'full';
      const clientFull = Boolean(info?.ready && !info.isPreview);
      const isPreview = !storeFull && !clientFull && ((info?.ready && info.isPreview) || (storeComplete && store?.preview) || local === 'preview');
      preview.style.display = isPreview ? '' : 'none';
    }
    const ringDone = local === 'full' || (storeComplete && !store?.preview) || (info?.ready && !info.isPreview);
    const failed = !ringDone && failedCacheRings.has(id);
    setCacheRing(el, ringDone ? 1 : (store?.progress || 0), ringDone, !ringDone && !failed && busyCacheRings.has(id), failed);
    const cell = el.querySelector('.cell-cache');
    if (cell) cell.title = failed && store?.error ? store.error : '缓存操作:清理 / 重加载';
  }
  updateHeroSub();
}

// 进度圈:p∈[0,1]。done 满圈+对勾;busy 流动扫描(解析中);其余按真实比例
function setCacheRing(el, p, done, busy, failed) {
  const ring = el.querySelector('.ring');
  if (!ring) return;
  const C = 2 * Math.PI * 8.5;
  const isDone = Boolean(done);
  const isFailed = Boolean(failed) && !isDone;
  const isBusy = Boolean(busy) && !isDone && !isFailed;
  const pp = isDone ? 1 : Math.max(0, Math.min(1, p || 0));
  const fill = ring.querySelector('.ring-fill');
  ring.classList.toggle('busy', isBusy);
  ring.classList.toggle('failed', isFailed);
  ring.classList.toggle('done', isDone);
  if (!isBusy) {
    fill.style.strokeDasharray = String(C);
    fill.style.strokeDashoffset = String(C * (1 - (isFailed && pp === 0 ? 0.18 : pp)));
  } else {
    fill.style.strokeDasharray = '';
    fill.style.strokeDashoffset = '';
  }
}

// 自有缓存的实时进度:SSE 推流(250ms)+ 轮询兜底
// busy 只表示「还在排队或下载」。完成、失败、超时都必须离开这个集合，否则圈会一直转。
const busyCacheRings = new Set();
const failedCacheRings = new Set();
const busySince = new Map();
const CACHE_BUSY_GRACE_MS = 8000;

function markCacheBusy(id) {
  const key = String(id);
  if (!busyCacheRings.has(key)) busySince.set(key, Date.now());
  busyCacheRings.add(key);
  failedCacheRings.delete(key);
}

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
  // 只清理 qsyy 自己的增量缓存;汽水客户端的缓存只读不动。
  // 正在看某个缓存库时,清的是这一库里的文件,并把它从同一张列表里拿掉。
  const viewing = state.current?.kind === 'store' ? state.current.storeName : '';
  const inLibrary = Boolean(viewing) && state.current.tracks.some(t => t.id === String(track.id) && t.storeSrc);
  const store = state.storeProgress.get(track.id);
  // 未完成的在线下载也在 qsyy 自己的库里(.part)。以前只认 complete,
  // 失败的半截文件清不掉,下次播放还是用它。
  if (!store && !inLibrary) {
    toast(state.cacheStatus.get(track.id)?.ready
      ? '这首歌的缓存在汽水音乐客户端内,qsyy 对客户端文件只读,无法清理'
      : '这首歌还没有缓存', 'err');
    return;
  }
  await storeJson('/api/store/remove-track', { id: track.id, ...(viewing ? { set: viewing } : {}) });
  state.storeProgress.delete(track.id);
  state.cacheStatus.delete(track.id);
  busyCacheRings.delete(String(track.id));
  failedCacheRings.delete(String(track.id));
  busySince.delete(String(track.id));
  if (viewing && state.current?.storeName === viewing) {
    const id = String(track.id);
    state.current.tracks = state.current.tracks.filter(t => t.id !== id);
    state.current.count = state.current.tracks.length;
    state.storeTracks = state.current.tracks;
    if (state.current.order?.ids) state.current.order.ids = state.current.order.ids.filter(x => String(x) !== id);
    if (!state.current.tracks.length) {
      $('tracks').innerHTML = '<div class="empty">这个缓存还没有歌曲。在线播放会写进当前写入库,也可以用「导入」加入歌单包</div>';
      $('sentinel').textContent = '';
    } else rerenderRows();
    updateHeroSub();
    loadStores();
  } else requestCacheStatus([track.id]);
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
    markCacheBusy(track.id);
    decorateCacheBadges();
    pollProgress();                 // SSE 断线时的轮询兜底;进度本身走 progress-stream
    toast(`正在重新缓存「${track.name}」…`);
  } else toast('缓存任务提交失败', 'err');
}
let progressTimer = null;

function applyProgress(all) {
  const seen = new Set();
  let changed = false;
  for (const [id, st] of Object.entries(all || {})) {
    seen.add(id);
    const prev = state.storeProgress.get(id);
    const phase = st.phase || (st.complete ? 'done' : '');
    const next = { ...st, phase };
    if (next.complete || phase === 'done' || phase === 'failed' || next.progress > 0) {
      busyCacheRings.delete(id);
      busySince.delete(id);
    }
    if (phase === 'failed') failedCacheRings.add(id);
    else if (phase === 'done' || next.complete || phase === 'queued' || phase === 'running') failedCacheRings.delete(id);
    if ((phase === 'queued' || phase === 'running') && !(next.progress > 0) && !next.complete) {
      if (!busyCacheRings.has(id)) busySince.set(id, Date.now());
      busyCacheRings.add(id);
    }
    if (!prev || prev.complete !== next.complete || prev.phase !== next.phase || prev.error !== next.error
      || Math.abs((prev.progress || 0) - (next.progress || 0)) > 0.002) {
      state.storeProgress.set(id, next);
      changed = true;
      if (next.complete) state.cacheStatus.set(id, { ...(state.cacheStatus.get(id) || {}), ready: true, isPreview: Boolean(next.preview) });
    }
  }
  const now = Date.now();
  for (const id of [...busyCacheRings]) {
    if (seen.has(id)) continue;
    if (state.storeProgress.get(id)?.complete || state.cacheStatus.get(id)?.ready) {
      busyCacheRings.delete(id);
      busySince.delete(id);
      failedCacheRings.delete(id);
      changed = true;
      continue;
    }
    if (now - (busySince.get(id) || now) < CACHE_BUSY_GRACE_MS) continue;
    busyCacheRings.delete(id);
    busySince.delete(id);
    failedCacheRings.add(id);
    const prev = state.storeProgress.get(id) || {};
    state.storeProgress.set(id, { ...prev, phase: 'failed', error: prev.error || '缓存没有完成' });
    changed = true;
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
        if (info?.ready && !info.isPreview) {
          busyCacheRings.delete(id);
          busySince.delete(id);
          failedCacheRings.delete(id);
        }
      }
      for (const [id, st] of Object.entries(data.store || {})) {
        state.storeProgress.set(id, st);
        if (st.complete) {
          state.cacheStatus.set(id, { ...(state.cacheStatus.get(id) || {}), ready: true, isPreview: Boolean(st.preview) });
          busyCacheRings.delete(id);
          busySince.delete(id);
          failedCacheRings.delete(id);
        }
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

function setQueue(list, index, context) {
  state.queue = list;
  state.queueIndex = index;
  // 播放来源上下文('playlist' | 'store:<名>'):行高亮只作用于同上下文,
  // 否则库里播的歌会让歌单里同 id 的行也"亮着",看起来两处同时在播
  state.queueContext = context || (state.storeView ? `store:${state.storeView.name}` : 'playlist');
  persistQueue();
  startCurrent(true);
}

function persistQueue() {
  try {
    ls.set('queue', {
      playlistId: state.current?.id,
      context: state.queueContext || 'playlist',
      ids: state.queue.map(t => t.id),
      index: state.queueIndex,
    });
  } catch (_) {}
}

function restoreQueue() {
  const saved = ls.get('queue', null);
  if (!saved?.ids?.length) return false;
  // 库队列和歌单队列同一套曲目对象,存在 current.tracks 里。
  if (saved.context?.startsWith('store:')) {
    if (state.current?.id !== saved.context || !state.current.tracks?.length) return false;
    const byId = new Map(state.current.tracks.map(t => [t.id, t]));
    const queue = saved.ids.map(id => byId.get(String(id))).filter(Boolean);
    if (!queue.length) return false;
    state.queue = queue;
    state.queueIndex = Math.min(Math.max(0, saved.index), queue.length - 1);
    state.queueContext = saved.context;
    return true;
  }
  if (saved.playlistId !== state.current?.id) return false;
  const byId = new Map(state.current.tracks.map(t => [t.id, t]));
  const queue = saved.ids.map(id => byId.get(id)).filter(Boolean);
  if (!queue.length) return false;
  state.queue = queue;
  state.queueIndex = Math.min(Math.max(0, saved.index), queue.length - 1);
  state.queueContext = 'playlist';
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
  pCover.src = trackCoverUrl(t, 140);
  applyCoverGlow(trackCoverUrl(t, 96));
  $('p-queue-count').textContent = state.queue.length > 0 ? `${state.queueIndex + 1}/${state.queue.length}` : '';
  renderQueuePanel();
  updateMediaSession(t);
  if (!$('lyrics-panel').classList.contains('hidden') || ls.get('lyrics-open', false)) loadLyrics(t);
  ls.set('lastTrack', { playlistId: state.current?.id, trackId: t.id, position: 0, context: state.queueContext || 'playlist' });
  // 库限定流(?set=):本地 m4a 直取,免登录免在线解析
  audio.src = t.storeSrc || `/api/stream/${t.id}`;
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
      if (state.queue[state.queueIndex] !== t) return;
      if (t.storeSrc) {
        toast('本地音频无法播放，请检查文件是否完整或重新导入；无需登录汽水音乐', 'err');
        return;
      }
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
  updateHeroPlayback();
  const t = state.queue[state.queueIndex];
  document.title = t ? `▶ ${t.name} · qsyy` : 'qsyy';
  prefetchNext();
  startEqLoop();
};
audio.onpause = () => { $('p-title').textContent = $('p-title').textContent.replace(' — 点 ▶ 开始', ''); $('p-play').innerHTML = ICONS.play; decoratePlayingRow(); updateHeroPlayback(); stopEqLoop(); };
audio.ontimeupdate = () => {
  highlightLyric();
  if (!audio.duration || seeking) return;
  setSeekUI(audio.currentTime / audio.duration);
  $('p-cur').textContent = fmtTime(audio.currentTime * 1000);
  $('p-dur').textContent = fmtTime(audio.duration * 1000);
  const track = state.queue[state.queueIndex];
  if (track && Math.floor(audio.currentTime) % 5 === 0) {
    ls.set('lastTrack', { playlistId: state.current?.id, trackId: track.id, position: audio.currentTime, context: state.queueContext || 'playlist' });
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
    const src = trackCoverUrl(t, 720);
    if (!src) return;
    $('ce-art').src = src;
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
    const art = trackCoverUrl(t, 512);
    const artwork = art ? [{ src: location.origin + art, sizes: '512x512', type: 'image/jpeg' }] : [];
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
      <img loading="lazy" src="${trackCoverUrl(t, 72)}" alt="">
      <div><div class="q-name">${esc(t.name)}${t.vip ? '<span class="badge vip">VIP</span>' : ''}${qualityBadges(t.qualities)}</div><div class="q-artist">${esc(t.artists.join(' / '))}</div></div>
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
  if (!el || el.classList.contains('hidden')) return;
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
  // 前奏/未开播时没有当前行：把第一行作为「即将唱到」清晰显示，避免整屏都是虚化的
  if (idx < 0) { lyricsState.rows[0]?.classList.add('near'); return; }
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

function trackStoreName(t) {
  const src = String(t?.storeSrc || '');
  const at = src.indexOf('set=');
  if (at >= 0) {
    const raw = src.slice(at + 4).split('&')[0];
    try { return decodeURIComponent(raw); } catch (_) { return raw; }
  }
  const ctx = String(state.queueContext || '');
  return ctx.startsWith('store:') ? ctx.slice('store:'.length) : '';
}

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
        artist: (t.artists || []).join(' / '), album: t.album,
        quality: state.quality, outputFormat: fmt, coverData,
        set: trackStoreName(t),
      }),
    });
    openDownloads();
  } catch (e) {
    toast(`下载请求失败:${e.message}`, 'err');
  }
}

async function fetchCover(t) {
  const src = trackCoverUrl(t, 600);
  if (!src) return '';
  try {
    const response = await fetch(src);
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
  const panel = $('downloads-panel');
  if (!panel) return;
  panel.classList.remove('hidden');
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
      openBtn.onclick = () => {
        if (window.QsyyAndroid?.openDownloads) { window.QsyyAndroid.openDownloads(); return; }
        fetch('/api/open-downloads', { method: 'POST' }).catch(() => {});
      };
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
          body: JSON.stringify({ trackId: t.id, title: t.name, artist: (t.artists || []).join(' / '), album: t.album, quality: state.quality, outputFormat: fmt, coverData, set: trackStoreName(t) }),
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
  if (e.code === 'Escape' && $('sync-modal') && !$('sync-modal').classList.contains('hidden')) { closeSyncModal(); return; }
  if (e.code === 'Escape' && $('export-modal') && !$('export-modal').classList.contains('hidden')) { expCloseModal(); return; }
  if (e.code === 'Escape' && $('import-modal') && !$('import-modal').classList.contains('hidden')) { closeImportModal(); return; }
  if (e.code === 'Escape' && $('qr-modal') && !$('qr-modal').classList.contains('hidden')) { closeQrModal(); return; }
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

// ------------------------------------------------------------------ boot

let footCacheText = '';
function updateFootHint() {
  // 缓存量小字已并入 GitHub 行(Issue #23),这里只更新它的悬停提示
  const meta = $('foot-meta');
  if (!meta) return;
  const mode = state.onlineAvailable ? '未缓存直接在线播放' : '未缓存需在汽水播放或扫码解锁';
  meta.title = footCacheText ? `${mode} · ${footCacheText}` : mode;
}

