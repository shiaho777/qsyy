// ---------------------------------------------------------------- audio effects (Web Audio DSP, aligned with track_v2 audio_effects)

let audioCtx = null;
let mediaSource = null;      // MediaElementSource(只能建一次)
let outputTap = null;        // 常驻汇流点:mediaSource → (音效链) → outputTap → analyser → destination
let analyser = null;         // 实时频谱分析,驱动列表小波浪
let eqFreq = null;
let effectChain = { input: null, output: null, nodes: [] };

function dbToGain(db) { return Math.pow(10, db / 20); }

function buildEqNode(ctx, bandStr) {
  // "LowShelf,31,1.0,-9.98" → biquad(f, Q, gain)
  const [type, freq, q, gain] = bandStr.split(',');
  const filter = ctx.createBiquadFilter();
  const map = { LowShelf: 'lowshelf', HighShelf: 'highshelf', Peaking: 'peaking', LowPass: 'lowpass', HighPass: 'highpass' };
  filter.type = map[type] || 'peaking';
  filter.frequency.value = Number(freq);
  filter.Q.value = Number(q);
  filter.gain.value = Number(gain);
  return filter;
}

function buildReverbIR(ctx, rt60, dry2wet) {
  const seconds = Math.max(0.3, Math.min(2.5, rt60 || 1));
  const rate = ctx.sampleRate;
  const length = Math.floor(seconds * rate);
  const ir = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch += 1) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i += 1) {
      const t = i / length;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.2) * (1 - t * 0.15);
    }
  }
  return ir;
}

// 按 track_v2 下发的 DSP 链构建 Web Audio 节点
function buildEffectNodes(ctx, config) {
  const chain = (config?.chains || []).find(c => c.enable !== false) || (config?.chains || [])[0];
  const nodes = [];
  for (const node of (chain?.nodes || [])) {
    if (node.enable === false) continue;
    if (node.type === 'gain') {
      const g = ctx.createGain();
      g.gain.value = dbToGain(node.gain_db || 0);
      nodes.push(g);
    } else if (node.type === 'equalizer') {
      const preset = (node.presets || []).find(p => p.name === (node.use_preset || 'custom')) || (node.presets || [])[0];
      for (const band of (preset?.band_params || [])) {
        const f = buildEqNode(ctx, band);
        if (f) nodes.push(f);
      }
    } else if (node.type === 'drc') {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = node.compressor_threshold ?? -24;
      comp.knee.value = node.compressor_knee_width ?? 3;
      comp.ratio.value = node.compressor_ratio ?? 2;
      comp.attack.value = Math.max(0.001, (node.attack_time || 20) / 1000);
      comp.release.value = Math.max(0.01, (node.release_time || 200) / 1000);
      nodes.push(comp);
      if (node.make_up_gain) {
        const g = ctx.createGain();
        g.gain.value = dbToGain(node.make_up_gain);
        nodes.push(g);
      }
    } else if (node.type === 'stereo_width') {
      // M/S 展宽:side *= width(简化实现,近似官方 ms_crossfeed)
      const ms = node.ms_crossfeed_params || {};
      if (ms.enable !== false && (ms.width || 1) !== 1) {
        const splitter = ctx.createChannelSplitter(2);
        const merger = ctx.createChannelMerger(2);
        const mid = ctx.createGain(); mid.gain.value = 0.5;
        const side = ctx.createGain(); side.gain.value = 0.5 * (ms.width ?? 1);
        const midL = ctx.createGain(); midL.gain.value = 1;
        const midR = ctx.createGain(); midR.gain.value = 1;
        const sideL = ctx.createGain(); sideL.gain.value = 1;
        const sideR = ctx.createGain(); sideR.gain.value = -1;
        splitter.connect(mid, 0); splitter.connect(mid, 1);
        splitter.connect(sideL, 0); splitter.connect(sideR, 1);
        sideL.connect(side); sideR.connect(side);
        mid.connect(midL); mid.connect(midR);
        midL.connect(merger, 0, 0); side.connect(merger, 0, 0);
        midR.connect(merger, 0, 1); side.connect(merger, 0, 1);
        nodes.push({ input: splitter, output: merger });
      }
    } else if (node.type === 'fdn_reverb') {
      const convolver = ctx.createConvolver();
      convolver.buffer = buildReverbIR(ctx, node.rt60, node.dry2wet_ratio);
      const wet = ctx.createGain();
      wet.gain.value = node.dry2wet_ratio ?? 0.5;
      const dry = ctx.createGain();
      dry.gain.value = 1 - (node.dry2wet_ratio ?? 0.5) * 0.6; // 保留干声主体,避免糊
      const merge = ctx.createGain();
      const input = ctx.createGain();
      input.connect(dry); dry.connect(merge);
      input.connect(convolver); convolver.connect(wet); wet.connect(merge);
      nodes.push({ input, output: merge });
    } else if (node.type === 'limiter_lookahead_sig') {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -(node.ceiling_dB || 0.4) - 6;
      comp.knee.value = node.knee_dB ?? 0.2;
      comp.ratio.value = 20;
      comp.attack.value = Math.max(0.00002, (node.attack_time_ms || 0.0001) / 1000);
      comp.release.value = Math.max(0.005, (node.release_time_ms || 20) / 1000);
      nodes.push(comp);
    }
  }
  return nodes;
}

function ensureGraph() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    mediaSource = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 32;                 // 16 个频点,够驱动 3 根柱子
    analyser.smoothingTimeConstant = 0.7;
    eqFreq = new Uint8Array(analyser.frequencyBinCount);
    outputTap = audioCtx.createGain();
    mediaSource.connect(outputTap);
    outputTap.connect(analyser);
    analyser.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().then(startEqLoop).catch(() => {});
  else startEqLoop();
}

function teardownEffectChain() {
  try { effectChain.input?.disconnect(); } catch (_) {}
  for (const n of effectChain.nodes) {
    try { (n.output || n).disconnect(); } catch (_) {}
  }
  effectChain = { input: null, output: null, nodes: [] };
  try { mediaSource.disconnect(); mediaSource.connect(outputTap); } catch (_) {}
}

