// ------------------------------------------------------------------ onboarding
// 首次启动引导(3 屏)+ 侧栏「引导」按钮回看。
// 与更新弹窗互斥:本次启动展示过引导 → about.js 的 initUpdateNotices 不再弹。
// 全局入口 window.qsyyShowOnboarding 供命令面板等后续接线。

window.qsyyOnboardingShown = false; // 本次启动是否展示过引导(含回看)
let obStep = 0;

function qsyyOnboardingVisible() {
  const el = $('onboarding');
  return !!el && !el.classList.contains('hidden');
}
window.qsyyOnboardingVisible = qsyyOnboardingVisible;

function obGoto(step) {
  obStep = Math.max(0, Math.min(2, step));
  document.querySelectorAll('.ob-screen').forEach(s => {
    s.classList.toggle('active', Number(s.dataset.ob) === obStep);
  });
  document.querySelectorAll('.ob-dot').forEach(d => {
    d.classList.toggle('active', Number(d.dataset.obDot) === obStep);
  });
  const next = $('ob-next');
  if (next) next.textContent = obStep >= 2 ? '开始使用' : '下一屏';
}

function obOnKey(e) {
  if (e.key !== 'Escape') return;
  // 捕获阶段拦截:引导期间 Esc 只用于跳过,不触发播放页/面板的 Esc 行为
  e.preventDefault();
  e.stopPropagation();
  obFinish();
}

function obFinish() {
  ls.set('onboarded', true);
  document.removeEventListener('keydown', obOnKey, true);
  const el = $('onboarding');
  if (!el) return;
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
  setTimeout(() => el.classList.add('hidden'), 260);
}

function qsyyShowOnboarding() {
  const el = $('onboarding');
  if (!el || qsyyOnboardingVisible()) return;
  window.qsyyOnboardingShown = true;
  obGoto(0);
  el.classList.remove('hidden');
  el.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => el.classList.add('open'));
  document.addEventListener('keydown', obOnKey, true);
}
window.qsyyShowOnboarding = qsyyShowOnboarding;

if ($('ob-skip')) $('ob-skip').onclick = obFinish;
if ($('ob-next')) $('ob-next').onclick = () => { if (obStep >= 2) obFinish(); else obGoto(obStep + 1); };
document.querySelectorAll('.ob-dot').forEach(d => {
  d.onclick = () => obGoto(Number(d.dataset.obDot));
});
if ($('ob-replay')) $('ob-replay').onclick = qsyyShowOnboarding;

// 首次安装(键不存在 / false)自动展示;完成或跳过都会写 onboarded=true
if (ls.get('onboarded', false) !== true) qsyyShowOnboarding();