// ---------------------------------------------------------------- sleep timer
// Wall-clock timer that fades the current playback out over 30 seconds and
// pauses. Kept in its own file so the player module does not grow another
// cross-cutting concern; it uses the shared `audio` / `$` / `toast` globals.

(() => {
  const button = $('p-sleep-btn');
  const pop = $('sleep-pop');
  const count = $('p-sleep-count');
  if (!button || !pop || !audio) return;

  const FADE_MS = 30000;
  const state = { endsAt: 0, minutes: 0, tick: 0, fade: null, ending: false };

  const remaining = () => Math.max(0, state.endsAt - Date.now());
  const fmtRemaining = ms => {
    const total = Math.ceil(ms / 1000);
    if (total >= 60) return `${Math.ceil(total / 60)}m`;
    return `${total}s`;
  };

  const hide = () => {
    pop.classList.add('hidden');
    pop.setAttribute('aria-hidden', 'true');
    button.classList.remove('on');
  };
  const show = () => {
    pop.classList.remove('hidden');
    pop.setAttribute('aria-hidden', 'false');
    button.classList.add('on');
    render();
  };

  const render = () => {
    const active = state.endsAt > 0;
    button.classList.toggle('on', active || !pop.classList.contains('hidden'));
    count.textContent = active ? fmtRemaining(remaining()) : '';
    button.title = active ? `睡眠定时器：剩余 ${fmtRemaining(remaining())}` : '睡眠定时器';
    pop.querySelectorAll('[data-min]').forEach(el => {
      el.classList.toggle('active', active && Number(el.dataset.min) === state.minutes);
    });
    const hint = $('sleep-hint');
    if (hint) {
      hint.textContent = active
        ? `剩余 ${fmtRemaining(remaining())}；到点后音量渐出并暂停`
        : '到点后音量渐出并暂停';
    }
  };

  const stopFade = (restore = true) => {
    if (!state.fade) return;
    cancelAnimationFrame(state.fade.raf);
    if (restore) {
      try { audio.volume = state.fade.from; } catch (_) {}
    }
    state.fade = null;
    state.ending = false;
  };

  const clearTimer = ({ announce = false, restore = true } = {}) => {
    state.endsAt = 0;
    state.minutes = 0;
    state.ending = false;
    if (state.tick) clearInterval(state.tick);
    state.tick = 0;
    stopFade(restore);
    render();
    if (announce) toast('睡眠定时器已关闭', 'ok');
  };

  const finish = () => {
    if (!state.endsAt) return;
    const from = audio.volume;
    if (audio.paused || from <= 0.001) {
      audio.pause();
      clearTimer({ announce: true, restore: false });
      try { audio.volume = from; } catch (_) {}
      return;
    }
    const fade = { from, raf: 0, started: performance.now() };
    state.fade = fade;
    const tick = now => {
      if (state.fade !== fade) return;
      const progress = Math.min(1, (now - fade.started) / FADE_MS);
      try { audio.volume = Math.max(0, fade.from * (1 - progress)); } catch (_) {}
      if (progress >= 1) {
        state.ending = true;
        audio.pause();
        try { audio.volume = fade.from; } catch (_) {}
        state.ending = false;
        state.fade = null;
        clearTimer({ announce: true, restore: false });
        return;
      }
      fade.raf = requestAnimationFrame(tick);
    };
    fade.raf = requestAnimationFrame(tick);
    render();
  };

  const start = minutes => {
    const value = Math.max(1, Number(minutes) || 0);
    if (!value) return;
    clearTimer({ restore: true });
    state.minutes = value;
    state.endsAt = Date.now() + value * 60000;
    state.tick = setInterval(() => {
      if (!state.endsAt) return;
      if (remaining() <= 0) {
        clearInterval(state.tick);
        state.tick = 0;
        finish();
        return;
      }
      render();
    }, 1000);
    render();
    toast(`睡眠定时器：${value} 分钟后暂停`, 'ok');
  };

  button.onclick = () => {
    if (pop.classList.contains('hidden')) show();
    else hide();
  };
  pop.querySelectorAll('[data-min]').forEach(el => {
    el.onclick = () => start(el.dataset.min);
  });
  const off = $('sleep-off');
  if (off) off.onclick = () => clearTimer({ announce: true });

  document.addEventListener('pointerdown', event => {
    if (pop.classList.contains('hidden')) return;
    if (pop.contains(event.target) || button.contains(event.target)) return;
    hide();
  }, { passive: true });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !pop.classList.contains('hidden')) hide();
  });

  // A deliberate play or volume touch after the timer fired means the listener
  // wants to keep listening: cancel the fade instead of fighting the fade loop.
  audio.addEventListener('play', () => {
    if (state.fade && !state.ending) clearTimer({ announce: false });
  });
  const volume = $('p-vol');
  if (volume) volume.addEventListener('pointerdown', () => {
    if (state.fade) clearTimer({ announce: false });
  });

  if (state.endsAt) state.tick = setInterval(render, 1000);
  render();
})();
