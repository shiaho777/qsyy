// 封面取色主题(算法借鉴 Folia 的封面主题管线,独立重写,非代码拷贝):
// 50×50 高质量降采样 → OKLab 桶量化 → 确定性加权 k-means(最重桶播种,
// weight×dist² 选后续种子) → 面积×彩度×亮度可用性打分取主色。
// 强调色不再"主色混白",而是在 OKLCH 感知空间按封面彩度生成,再沿 L 步进
// 求解与深底的 WCAG 对比度(≥3.2),色域越界用二分降 C 保 L/H。
// 输出仍是同一组 CSS 变量(--glow/--th-deep/--th-mid/--th-lite/--accent),
// 切歌时 900ms @property 过渡照常生效。加载顺序在 core.js 之后,
// 重定义 applyCoverGlow(data.js/player.js 只在事件回调里调用,不受影响)。

const ctCanvas = document.createElement('canvas');
const CT_SIZE = 50;
const CT_BIN_L = 0.04;
const CT_BIN_AB = 0.025;
const CT_KMEANS_ITERS = 8;
const CT_PICK_GAP = 0.06;

const ctClamp01 = v => Math.min(1, Math.max(0, v));
const ctSmoothstep = (e0, e1, x) => {
  const t = ctClamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// ---- sRGB ↔ OKLab(Ottosson 标准矩阵) ----
const ctSrgbToLinear = c => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const ctLinearToSrgb = v => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(ctClamp01(c) * 255);
};
function ctRgbToOklab(r, g, b) {
  const lr = ctSrgbToLinear(r), lg = ctSrgbToLinear(g), lb = ctSrgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
// 返回 [r,g,b](0-255);gamut 越界时通道 clamp(仅用于背景/主色)。
function ctOklabToRgb(L, a, b) {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
  return [
    ctLinearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    ctLinearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    ctLinearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}
const ctInGamut = (L, C, h) => {
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  return lin.every(v => v >= -0.001 && v <= 1.001);
};
// 保 L/h 二分降 C 直到入色域(16 步)。
function ctFitOklch(L, C, h) {
  if (ctInGamut(L, C, h)) return [L, C, h];
  let lo = 0, hi = C;
  for (let i = 0; i < 16; i += 1) {
    const mid = (lo + hi) / 2;
    if (ctInGamut(L, mid, h)) lo = mid; else hi = mid;
  }
  return [L, lo, h];
}
const ctOklchToRgb = (L, C, h) => ctOklabToRgb(L, C * Math.cos(h), C * Math.sin(h));

// WCAG 相对亮度与对比度(输入 0-255 rgb)。
const ctRelLum = ([r, g, b]) =>
  0.2126 * ctSrgbToLinear(r) + 0.7152 * ctSrgbToLinear(g) + 0.0722 * ctSrgbToLinear(b);
const ctContrast = (a, b) => {
  const la = ctRelLum(a), lb = ctRelLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

// ---- 桶量化 + 加权 k-means ----
function ctExtractPalette(imageData, count = 5) {
  const bins = new Map();
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const [L, a, b] = ctRgbToOklab(d[i], d[i + 1], d[i + 2]);
    const key = `${Math.round(L / CT_BIN_L)}:${Math.round(a / CT_BIN_AB)}:${Math.round(b / CT_BIN_AB)}`;
    const bin = bins.get(key);
    if (bin) { bin.L += L; bin.a += a; bin.b += b; bin.w += 1; }
    else bins.set(key, { L, a, b, w: 1 });
  }
  const pts = [...bins.values()].map(bin => ({ L: bin.L / bin.w, a: bin.a / bin.w, b: bin.b / bin.w, w: bin.w }));
  if (!pts.length) return [];
  const dist2 = (p, q) => (p.L - q.L) ** 2 + (p.a - q.a) ** 2 + (p.b - q.b) ** 2;

  // 确定性 k-means++:最重桶优先,后续种子取 weight×minDist² 最大者。
  const k = Math.min(pts.length, Math.max(count + 3, 8));
  const seeds = [pts.reduce((best, p) => (p.w > best.w ? p : best), pts[0])];
  while (seeds.length < k) {
    let best = null, bestScore = -1;
    for (const p of pts) {
      const minD = Math.min(...seeds.map(s => dist2(p, s)));
      const score = p.w * minD;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best || bestScore <= 0) break;
    seeds.push(best);
  }
  let centers = seeds.map(s => ({ L: s.L, a: s.a, b: s.b }));
  let groups = [];
  for (let iter = 0; iter < CT_KMEANS_ITERS; iter += 1) {
    groups = centers.map(() => ({ L: 0, a: 0, b: 0, w: 0 }));
    for (const p of pts) {
      let ci = 0, cd = Infinity;
      for (let j = 0; j < centers.length; j += 1) {
        const dd = dist2(p, centers[j]);
        if (dd < cd) { cd = dd; ci = j; }
      }
      const g = groups[ci];
      g.L += p.L * p.w; g.a += p.a * p.w; g.b += p.b * p.w; g.w += p.w;
    }
    centers = groups.filter(g => g.w > 0).map(g => ({ L: g.L / g.w, a: g.a / g.w, b: g.b / g.w }));
    groups = groups.filter(g => g.w > 0);
    if (!centers.length) break;
  }
  const total = groups.reduce((sum, g) => sum + g.w, 0) || 1;
  const scored = groups.map((g, i) => {
    const c = centers[i];
    const share = g.w / total;
    const chroma = Math.hypot(c.a, c.b);
    const area = Math.sqrt(share) * (0.1 + 0.9 * ctSmoothstep(0.004, 0.03, share));
    const chromaScore = 0.2 + 0.8 * ctSmoothstep(0.02, 0.13, chroma);
    const lightScore = 0.25 + 0.75 * Math.max(0, 1 - ((c.L - 0.62) / 0.42) ** 2);
    return { ...c, w: g.w, share, chroma, score: area * chromaScore * lightScore };
  }).sort((x, y) => y.score - x.score);

  // 相邻 pick OKLab 距离 ≥0.06 去重,最多 count 个。
  const picks = [];
  for (const c of scored) {
    if (picks.every(p => dist2(p, c) >= CT_PICK_GAP ** 2)) picks.push(c);
    if (picks.length >= count) break;
  }
  return picks;
}

// ---- 主题角色生成(深色 UI 固定) ----
function ctBuildTheme(palette) {
  // 主色:第一个 score>0.012 的非灰簇;全灰封面按面积出灰。
  const base = palette.find(c => c.score > 0.012 && c.chroma > 0.02) || palette[0];
  if (!base) return null;
  const baseRgb = ctOklabToRgb(base.L, base.a, base.b);
  const baseHue = Math.atan2(base.b, base.a);

  // 背景三档:主色色相,低饱和深底(沿用既有观感区间,L 感知亮度 0.16-0.34)。
  const bgC = Math.min(0.045, Math.max(0.012, base.chroma * 0.25));
  const deep = ctOklchToRgb(...ctFitOklch(0.17, bgC, baseHue));
  const mid = ctOklchToRgb(...ctFitOklch(0.22, bgC * 0.9, baseHue));
  const lite = ctOklchToRgb(...ctFitOklch(0.30, bgC * 0.8, baseHue));

  // 强调色:OKLCH 深色带 L[0.74,0.82] C[0.07,0.13],彩度随封面 vividness;
  // 色相取主色和谐偏移(近似色 ±25°,封面双色时优先第二主色色相)。
  const support = palette.find(c => c !== base && c.chroma >= 0.035
    && Math.abs(Math.atan2(c.b, c.a) - baseHue) > 0.35);
  const vividness = ctClamp01(base.chroma / 0.2);
  // 近灰封面:强调色退为中性亮灰(atan2(0,0)=0 会给出无意义的红黄色相)。
  const nearGray = base.chroma < 0.02 && !support;
  let h = support ? Math.atan2(support.b, support.a) : baseHue + 0.35;
  let C = nearGray ? 0.005 : (0.07 + (0.13 - 0.07) * vividness);
  let L = 0.78;
  // 沿 L 步进求解与深底对比度 ≥3.2(深底恒暗,L 向上走)。
  let accent = ctOklchToRgb(...ctFitOklch(L, C, h));
  for (let i = 0; i < 20 && ctContrast(accent, deep) < 3.2; i += 1) {
    L = Math.min(0.95, L + 0.01);
    accent = ctOklchToRgb(...ctFitOklch(L, C, h));
  }
  return { glow: baseRgb, deep, mid, lite, accent };
}

const ctRgbStr = ([r, g, b]) => `rgb(${r},${g},${b})`;
let ctLastUrl = '';
function applyCoverGlow(url) {
  if (!url || url === ctLastUrl) return;
  ctLastUrl = url;
  const img = new Image();
  img.onload = () => {
    try {
      ctCanvas.width = ctCanvas.height = CT_SIZE;
      const ctx = ctCanvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, CT_SIZE, CT_SIZE);
      const palette = ctExtractPalette(ctx.getImageData(0, 0, CT_SIZE, CT_SIZE));
      const theme = ctBuildTheme(palette);
      if (!theme) return;
      const rs = document.documentElement.style;
      rs.setProperty('--glow', theme.glow.join(','));
      rs.setProperty('--th-deep', ctRgbStr(theme.deep));
      rs.setProperty('--th-mid', ctRgbStr(theme.mid));
      rs.setProperty('--th-lite', ctRgbStr(theme.lite));
      rs.setProperty('--accent', ctRgbStr(theme.accent));
    } catch (_) {}
  };
  img.onerror = () => { ctLastUrl = ''; };
  img.src = url;
}