/* 이번 달 예상 = 나간 돈 + 나갈 돈. 홈과 팝업이 같은 규칙으로 계산한다. */
(function (root) {
  'use strict';

  const L = root.PaymentLedger || (typeof require === 'function' ? require('./ledger.js') : null);
  const ZERO = Object.freeze({ now: 0, projected: 0, hasUnconverted: false });

  const pad = (n) => String(n).padStart(2, '0');
  const localMonthKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };

  /**
   * 서버·API 사용료(원화). 사용료는 UTC 달로 묶여서, 로컬 달과 다를 때(매달 1일 새벽 등)는 이번 달 값이 아니니 0.
   * @param {{accounts: object[], total: {monthToDate: number, projected: number}, hasUnconverted: boolean}} view cloudOverview 결과
   * @param {number} now
   * @param {string} billingKey 사용료 달(YYYY-MM)
   */
  function cloudParts(view, now, billingKey) {
    if (!view.accounts.length) return ZERO;
    if (localMonthKey(now) !== billingKey) return { ...ZERO, hasUnconverted: view.hasUnconverted };
    const { monthToDate, projected } = view.total;
    return { now: monthToDate, projected: Math.max(projected, monthToDate), hasUnconverted: view.hasUnconverted };
  }

  /**
   * @param {{paidThisMonth: object, dueThisMonth: object, thisMonth: object}} s summarize 결과
   * @param {{now: number, projected: number}} cloud cloudParts 결과
   * @param {number} usdKrw
   * @returns {{paidKRW: number, dueKRW: number, totalKRW: number, unconverted: object}}
   */
  function monthForecast(s, cloud, usdKrw) {
    const paidKRW = L.krwTotal(s.paidThisMonth, usdKrw).krw + cloud.now;
    const dueKRW = L.krwTotal(s.dueThisMonth, usdKrw).krw + (cloud.projected - cloud.now);
    return { paidKRW, dueKRW, totalKRW: paidKRW + dueKRW, unconverted: L.krwTotal(s.thisMonth, usdKrw).unconverted };
  }

  const api = { cloudParts, monthForecast };
  root.PaymentForecast = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
