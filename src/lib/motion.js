/* 작은 화면 움직임: 금액 카운트업, 목록 계단 등장. 움직임 줄이기 설정을 켠 사람에겐 바로 끝값을 보여 준다. */
(function (root) {
  'use strict';

  const COUNT_MS = 600;
  const STAGGER_MS = 40;
  const STAGGER_MAX = 8; // 그 뒤 줄은 같이 나온다(긴 목록이 늦게 채워지지 않게)

  /** @param {number} p 0~1 진행률 @returns {number} */
  const easeOut = (p) => 1 - (1 - p) ** 3;

  /** 시작값→끝값 사이에서 진행률 p일 때 보여 줄 정수 */
  function countValue(from, to, p) {
    const clamped = Math.min(1, Math.max(0, p));
    return clamped === 1 ? to : Math.round(from + (to - from) * easeOut(clamped));
  }

  const shouldAnimate = (from, to, reduced) => !reduced && Number.isFinite(from) && from !== to;

  const prefersReducedMotion = () =>
    Boolean(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const frames = new WeakMap();

  /**
   * node의 글자를 지금 보이는 값에서 value까지 올리거나 내린다. 처음엔 0에서 시작한다.
   * 같은 값으로 다시 그리면(저장값이 여러 번 바뀌는 첫 로딩) 돌던 움직임을 그대로 둔다.
   * @param {HTMLElement} node @param {number} value @param {(n: number) => string} format
   */
  function countUp(node, value, format) {
    const finalText = format(value); // 원화로 못 바꾼 금액 글자까지 같아야 '같은 값'이다
    if (frames.has(node) && node.dataset.countFinal === finalText) return;
    const shown = node.dataset.countShown === undefined ? 0 : Number(node.dataset.countShown);
    node.dataset.countFinal = finalText;
    root.cancelAnimationFrame(frames.get(node));
    frames.delete(node);
    const paint = (n) => { node.dataset.countShown = String(n); node.textContent = format(n); };
    if (!shouldAnimate(shown, value, prefersReducedMotion())) { paint(value); return; }
    const start = root.performance.now();
    const step = (t) => {
      const p = (t - start) / COUNT_MS;
      paint(countValue(shown, value, p));
      if (p < 1) frames.set(node, root.requestAnimationFrame(step));
      else frames.delete(node);
    };
    frames.set(node, root.requestAnimationFrame(step));
  }

  /** 목록 줄이 위에서부터 차례로 나타나게 한다. 같은 목록을 다시 그릴 땐(저장값이 바뀔 때마다) 안 움직인다. */
  function staggerIn(list) {
    const rows = [...list.children].filter((li) => !li.classList.contains('empty'));
    if (list.dataset.entered || !rows.length || prefersReducedMotion()) return;
    list.dataset.entered = '1';
    rows.forEach((li, i) => {
      li.style.setProperty('--stagger', `${Math.min(i, STAGGER_MAX) * STAGGER_MS}ms`);
      li.classList.add('stagger-in');
    });
  }

  const api = { easeOut, countValue, shouldAnimate, countUp, staggerIn, COUNT_MS };
  root.PaymentMotion = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
