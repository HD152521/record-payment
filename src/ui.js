/* 대시보드·팝업 공용 DOM 헬퍼. 사이트명 등 외부 값은 textContent로만 넣는다(innerHTML 금지). */
(function (root) {
  'use strict';

  const L = root.PaymentLedger;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child != null && child !== false) node.append(child);
    }
    return node;
  }

  function formatTotals(byCurrency) {
    const entries = Object.entries(byCurrency);
    if (!entries.length) return '0원';
    return entries.map(([cur, v]) => L.formatMoney(v, cur)).join(' + ');
  }

  function amountText(r) {
    const money = L.formatMoney(r.amount, r.currency);
    return r.kind === 'subscription' && r.cycle && r.amount != null ? `${money} / ${L.CYCLE_LABEL[r.cycle]}` : money;
  }

  function kindBadge(r) {
    return el('span', { class: `badge kind-${r.kind}` }, L.KIND_LABEL[r.kind] || r.kind);
  }

  const formatDate = (ts) => new Date(ts).toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });

  // 클라우드 연결 결과를 화면용으로 정리한다. 이번 달 값이 아닌(지난달에 받아 둔) 숫자는 합계에서 뺀다.
  function cloudOverview(costs, meta, now = Date.now()) {
    const C = root.PaymentCloudCosts;
    const thisKey = C.billingWindow(now).thisKey;
    const accounts = Object.entries(costs || {})
      .map(([id, entry]) => ({ id, ...entry }))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const current = accounts.filter((a) => a.month === thisKey);
    const usdKrw = meta && meta.usdKrw;
    return {
      accounts,
      usdKrw,
      total: C.totalKRW(current, usdKrw),
      hasUnconverted: current.some((a) => C.toKRW(a.monthToDate, a.currency, usdKrw) == null),
      lastRefreshAt: meta && meta.lastRefreshAt,
    };
  }

  const formatTime = (ts) => new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  root.PaymentUI = { el, formatTotals, amountText, kindBadge, formatDate, formatTime, cloudOverview };
})(globalThis);
