// ---------------------------------------------------------------- real-time equalizer (playing row)
// 读 analyser 的真实频谱驱动列表里那三根柱子,替代无限循环的假动画。
// 低频/中频/高频各取一段频点平均,平滑后写 scaleY;暂停时伏到最低。
let eqRaf = 0;
const eqSmooth = [0.18, 0.18, 0.18];
function eqFloor() {
  const eq = document.querySelector('.track.playing .eq.live');
  if (eq) eq.querySelectorAll('i').forEach(el => { el.style.transform = 'scaleY(0.18)'; });
}
function startEqLoop() {
  if (eqRaf || !analyser || !eqFreq) return;
  const tick = () => {
    eqRaf = 0;
    if (!audioCtx || audioCtx.state !== 'running' || audio.paused) { eqFloor(); return; }
    const eq = document.querySelector('.track.playing .eq');
    if (eq) {
      eq.classList.add('live');
      analyser.getByteFrequencyData(eqFreq);
      const bars = eq.querySelectorAll('i');
      const band = (a, b) => { let s = 0; for (let k = a; k <= b; k += 1) s += eqFreq[k]; return s / ((b - a + 1) * 255); };
      const targets = [band(1, 4), band(5, 9), band(10, 15)];
      for (let i = 0; i < 3; i += 1) {
        if (!bars[i]) break;
        const v = Math.min(1, Math.pow(targets[i], 0.75) * 1.15);
        eqSmooth[i] += (v - eqSmooth[i]) * 0.4;
        bars[i].style.transform = `scaleY(${(0.18 + eqSmooth[i] * 0.82).toFixed(3)})`;
      }
    }
    eqRaf = requestAnimationFrame(tick);
  };
  eqRaf = requestAnimationFrame(tick);
}
function stopEqLoop() {
  if (eqRaf) cancelAnimationFrame(eqRaf);
  eqRaf = 0;
  eqFloor();
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
    prev.connect(outputTap);
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

