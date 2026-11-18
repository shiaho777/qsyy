// ---------------------------------------------------------------- command palette
// Cmd/Ctrl+K opens a keyboard-first switcher over the current view: playback
// commands, the current list's tracks, playlists and cache libraries. It is
// deliberately read-only apart from invoking the same UI handlers the mouse
// uses, so every action keeps its existing guards.

(() => {
  const root = $('cmdk');
  const input = $('cmdk-input');
  const results = $('cmdk-results');
  if (!root || !input || !results) return;

  const MAX_TRACKS = 8;
  const MAX_COLLECTIONS = 5;
  let items = [];
  let active = 0;
  let lastFocus = null;

  const normalize = value => String(value || '').toLowerCase();
  const score = (query, text) => {
    const q = normalize(query).replace(/\s+/g, '');
    const t = normalize(text);
    if (!q) return 0;
    let qi = 0;
    let last = -2;
    let value = 0;
    for (let i = 0; i < t.length && qi < q.length; i += 1) {
      if (t[i] !== q[qi]) continue;
      value += 2;
      if (i === last + 1) value += 2;
      if (i === 0 || /[\s\-_/]/.test(t[i - 1])) value += 3;
      last = i;
      qi += 1;
    }
    if (qi < q.length) return -1;
    if (t.startsWith(q)) value += 8;
    return value - Math.min(20, t.length * 0.02);
  };

  const rowIcon = (html, image) => image
    ? `<img loading="lazy" src="${esc(image)}" alt="">`
    : (html || '<span class="cmdk-letter">·</span>');

  const makeCommand = (id, title, sub, run, opts = {}) => ({
    kind: 'cmd', group: '命令', id, title, sub, run,
    icon: opts.icon || ICONS.play,
    keywords: opts.keywords || '',
    key: opts.key || '',
  });

  const commandList = () => {
    const commands = [
      makeCommand('play', audio.paused ? '播放' : '暂停', '播放 / 暂停当前歌曲', () => $('p-play')?.click(), {
        icon: audio.paused ? ICONS.play : ICONS.pause, key: 'Space', keywords: 'play pause 播放 暂停',
      }),
      makeCommand('prev', '上一首', '回到上一首', () => $('p-prev')?.click(), {
        icon: ICONS.play, key: '⌘←', keywords: 'previous prev 上一首',
      }),
      makeCommand('next', '下一首', '跳到下一首', () => $('p-next')?.click(), {
        icon: ICONS.play, key: '⌘→', keywords: 'next 下一首',
      }),
      makeCommand('shuffle', state.shuffle ? '关闭随机播放' : '开启随机播放', '切换随机模式', () => $('p-shuffle')?.click(), {
        icon: ICONS.play, keywords: 'shuffle random 随机',
      }),
      makeCommand('repeat', '切换循环模式', '关 / 列表循环 / 单曲循环', () => $('p-repeat')?.click(), {
        icon: ICONS.play, keywords: 'repeat loop 循环',
      }),
      makeCommand('lyrics', '打开歌词', '当前歌曲的逐字歌词', () => $('p-lyrics-btn')?.click(), {
        icon: ICONS.note, keywords: 'lyrics 歌词',
      }),
      makeCommand('now-playing', '全屏播放页', '大封面 + 歌词', () => openNowPlaying(), {
        icon: ICONS.play, keywords: 'fullscreen now playing 全屏 播放页',
      }),
      makeCommand('sleep', '睡眠定时器', '到点渐出并暂停', () => $('p-sleep-btn')?.click(), {
        icon: ICONS.note, keywords: 'sleep timer 睡眠 定时',
      }),
      makeCommand('obs', '打开 OBS 歌词覆盖层', '透明背景，可加入 OBS 浏览器源', () => window.open('/obs.html', '_blank', 'noopener'), {
        icon: ICONS.note, keywords: 'obs overlay 歌词 覆盖',
      }),
      makeCommand('obs-cappella', '群唱舞台', '聊天气泡流歌词，对唱自动分边', () => window.open('/obs-folia/?mode=cappella', '_blank', 'noopener'), {
        icon: ICONS.note, keywords: 'obs cappella 群唱 气泡 聊天',
      }),
      makeCommand('obs-fume', '浮名舞台', '整篇排版 + 相机飞行，副歌大字块', () => window.open('/obs-folia/?mode=fume', '_blank', 'noopener'), {
        icon: ICONS.note, keywords: 'obs fume 浮名 排版 相机',
      }),
      makeCommand('lyric-match', '匹配社区歌词', '从 TTML 社区库手动匹配这首歌的逐字歌词', () => {
        const panel = $('lyrics-panel');
        if (panel?.classList.contains('hidden')) $('p-lyrics-btn')?.click();
        setTimeout(() => $('lyric-match-btn')?.click(), 60);
      }, {
        icon: ICONS.note, keywords: 'match ttml 匹配 歌词 社区',
      }),
      makeCommand('download', '下载当前歌曲', '导出当前播放的歌曲', () => $('download-current')?.click(), {
        icon: ICONS.downloadRow, keywords: 'download 下载',
      }),
    ];
    if ($('p-desklyrics-btn') && !$('p-desklyrics-btn').classList.contains('hidden')) {
      commands.push(makeCommand('desktop-lyrics', '切换桌面歌词', '透明置顶悬浮歌词窗', () => $('p-desklyrics-btn')?.click(), {
        icon: ICONS.note, keywords: 'desktop lyrics 桌面歌词 浮窗',
      }));
    }
    return commands;
  };

  const commandItems = query => commandList()
    .map(command => ({ command, rank: score(query, `${command.title} ${command.sub} ${command.keywords}`) }))
    .filter(entry => entry.rank >= 0)
    .sort((a, b) => b.rank - a.rank)
    .map(({ command }) => command);

  const trackItems = query => {
    const list = typeof visibleTracks === 'function' ? visibleTracks() : [];
    const seen = new Set();
    return list
      .map(track => {
        const text = `${track.name || ''} ${(track.artists || []).join(' ')} ${track.album || ''}`;
        return { track, rank: score(query, text) };
      })
      .filter(entry => entry.rank >= 0 && !seen.has(String(entry.track.id)) && seen.add(String(entry.track.id)))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, MAX_TRACKS)
      .map(({ track }) => ({
        kind: 'track', group: '歌曲', id: `track:${track.id}`,
        title: track.name || '未命名',
        sub: [ (track.artists || []).join(' / '), track.album ].filter(Boolean).join(' · ') || '播放这首歌',
        icon: ICONS.note,
        image: typeof trackCoverUrl === 'function' ? trackCoverUrl(track, 64) : '',
        keywords: `${track.name || ''} ${(track.artists || []).join(' ')}`,
        run: () => { if (typeof playOrPrime === 'function') playOrPrime(track); },
      }));
  };

  const playlistItems = query => (state.playlists || [])
    .map(pl => ({ pl, rank: score(query, `${pl.title} ${pl.count || ''}`) }))
    .filter(entry => entry.rank >= 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, MAX_COLLECTIONS)
    .map(({ pl }) => ({
      kind: 'playlist', group: '歌单', id: `playlist:${pl.id}`,
      title: pl.title || '未命名歌单', sub: `${pl.count || 0} 首`,
      icon: ICONS.folder,
      image: pl.cover && typeof coverUrl === 'function' ? coverUrl(pl.cover, 64) : '',
      keywords: pl.title || '',
      run: () => openPlaylist(pl),
    }));

  const storeItems = query => (state.storeSets || [])
    .map(store => ({ store, rank: score(query, store.name || '') }))
    .filter(entry => entry.rank >= 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, MAX_COLLECTIONS)
    .map(({ store }) => ({
      kind: 'store', group: '缓存库', id: `store:${store.name}`,
      title: store.name || '未命名缓存库',
      sub: store.active ? '当前写入库' : '打开缓存库',
      icon: ICONS.folder,
      keywords: store.name || '',
      run: () => openStoreView(store.name),
    }));

  const build = query => {
    const groups = [
      commandItems(query),
      trackItems(query),
      playlistItems(query),
      storeItems(query),
    ];
    return groups.flat();
  };

  const render = () => {
    const query = input.value.trim();
    items = build(query);
    if (!items.length) {
      results.innerHTML = `<div class="cmdk-empty">没有找到「${esc(query)}」</div>`;
      active = 0;
      return;
    }
    if (active >= items.length) active = items.length - 1;
    if (active < 0) active = 0;
    let html = '';
    let lastGroup = '';
    items.forEach((item, index) => {
      if (item.group !== lastGroup) {
        html += `<div class="cmdk-group">${esc(item.group)}</div>`;
        lastGroup = item.group;
      }
      html += `<div class="cmdk-row${index === active ? ' active' : ''}" data-i="${index}" role="option" aria-selected="${index === active}">
        <span class="cmdk-ico">${rowIcon(item.icon, item.image)}</span>
        <span class="cmdk-copy"><span class="cmdk-title">${esc(item.title)}</span><span class="cmdk-sub">${esc(item.sub || '')}</span></span>
        ${item.key ? `<span class="cmdk-key">${esc(item.key)}</span>` : ''}
      </div>`;
    });
    results.innerHTML = html;
    results.querySelector('.cmdk-row.active')?.scrollIntoView({ block: 'nearest' });
  };

  const close = () => {
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
    input.value = '';
    items = [];
    active = 0;
    results.innerHTML = '';
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (_) {}
    }
    lastFocus = null;
  };

  const open = () => {
    lastFocus = document.activeElement;
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    input.value = '';
    active = 0;
    render();
    input.focus();
  };

  const run = item => {
    if (!item) return;
    close();
    try { item.run(); } catch (error) { toast(error?.message || '操作失败', 'err'); }
  };

  const move = delta => {
    if (!items.length) return;
    active = (active + delta + items.length) % items.length;
    render();
  };

  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Enter') { event.preventDefault(); run(items[active]); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
  });

  results.addEventListener('click', event => {
    const row = event.target.closest('.cmdk-row');
    if (!row) return;
    run(items[Number(row.dataset.i)]);
  });
  results.addEventListener('mousemove', event => {
    const row = event.target.closest('.cmdk-row');
    if (!row || Number(row.dataset.i) === active) return;
    active = Number(row.dataset.i);
    results.querySelectorAll('.cmdk-row').forEach((el, index) => el.classList.toggle('active', index === active));
  });

  root.addEventListener('click', event => { if (event.target === root) close(); });

  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (root.classList.contains('hidden')) open();
      else close();
      return;
    }
    if (event.key === 'Escape' && !root.classList.contains('hidden')) {
      event.preventDefault();
      close();
    }
  });
})();
