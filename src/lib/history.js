/* 달마다 나간 돈. 기록에서 달별 결제를 다시 계산하고, 사용료 연결은 받아 둔 값을 달별로 쌓아 둔다. */
(function (root) {
  'use strict';

  const L = root.PaymentLedger || (typeof require === 'function' ? require('./ledger.js') : null);
  const CLOUD_KEEP_MONTHS = 24;

  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

  /** 오래된 달부터 이번 달까지 [{ key, label, from, to, isCurrent }] */
  function monthWindows(now, months) {
    const d = new Date(now);
    return Array.from({ length: months }, (_, i) => {
      const start = new Date(d.getFullYear(), d.getMonth() - (months - 1 - i), 1);
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
      const sameYear = start.getFullYear() === d.getFullYear();
      return {
        key: keyOf(start),
        label: sameYear ? `${start.getMonth() + 1}월` : `${String(start.getFullYear()).slice(2)}년 ${start.getMonth() + 1}월`,
        from: start.getTime(),
        to: end.getTime(),
        isCurrent: i === months - 1,
      };
    });
  }

  const add = (acc, cur, v) => (v ? { ...acc, [cur]: Math.round(((acc[cur] || 0) + v) * 100) / 100 } : acc);
  // isCovered(기록, 달): 그 달 사용료 연결 값에 이미 들어 있는 기록이면 true
  const countedIn = (records, isCovered, w) => records.filter((r) => L.isConfirmed(r) && !isCovered(r, w));
  const sumIn = (records, w) => records.reduce((acc, r) => add(acc, r.currency, paidIn(r, w.from, w.to)), {});

  /** 한 기록이 [from, to) 사이에 낸 돈 */
  function paidIn(r, from, to) {
    if (r.amount == null || !r.currency) return 0;
    if (r.kind === 'one_time') return r.startedAt >= from && r.startedAt < to ? r.amount : 0;
    return r.amount * L.chargeDates(r, from, to).length;
  }

  /** 달별 구독·일회성 합계(통화별). 이번 달은 아직 안 온 결제일도 포함한다. */
  function monthlyHistory(records, now, { months = 12, isCovered = () => false } = {}) {
    return monthWindows(now, months).map((w) => {
      const counted = countedIn(records, isCovered, w);
      return {
        ...w,
        subscription: sumIn(counted.filter((r) => r.kind === 'subscription'), w),
        one_time: sumIn(counted.filter((r) => r.kind === 'one_time'), w),
      };
    });
  }

  /** 최근 몇 달 동안 많이 쓴 곳(원화 환산 큰 순서) */
  function topSites(records, now, usdKrw, { months = 12, limit = 5, isCovered = () => false } = {}) {
    const bySite = monthWindows(now, months).reduce((acc, w) => countedIn(records, isCovered, w).reduce((inner, r) => {
      const paid = paidIn(r, w.from, w.to);
      return paid ? { ...inner, [r.site]: add(inner[r.site] || {}, r.currency, paid) } : inner;
    }, acc), {});
    return Object.entries(bySite)
      .map(([site, byCurrency]) => ({ site, byCurrency, krw: L.krwTotal(byCurrency, usdKrw).krw }))
      .sort((a, b) => b.krw - a.krw)
      .slice(0, limit);
  }

  /**
   * 사용료 연결 값을 달별로 쌓는다. 이번 달은 누적(확정 전), 지난달은 확정값.
   * 확정값은 나중에 들어온 누적값으로 덮지 않는다. 24개월만 남긴다.
   */
  function mergeCloudHistory(history, costs, { thisKey, lastKey }) {
    const put = (acc, month, id, value) => {
      const existing = acc[month] && acc[month][id];
      if (existing && existing.final && !value.final) return acc;
      return { ...acc, [month]: { ...(acc[month] || {}), [id]: value } };
    };
    const merged = Object.entries(costs || {}).reduce((acc, [id, c]) => {
      if (!c || c.month !== thisKey || !c.currency) return acc;
      const withLast = c.lastMonth != null ? put(acc, lastKey, id, { amount: c.lastMonth, currency: c.currency, final: true, provider: c.provider }) : acc;
      return c.monthToDate != null ? put(withLast, thisKey, id, { amount: c.monthToDate, currency: c.currency, final: false, provider: c.provider }) : withLast;
    }, history || {});
    const keep = Object.keys(merged).sort().slice(-CLOUD_KEEP_MONTHS);
    return Object.fromEntries(keep.map((k) => [k, merged[k]]));
  }

  /** 한 달 사용료 합계(원화). 환율이 없어 못 바꾼 금액은 빼고 hasUnconverted로 알린다. */
  function cloudMonthKRW(history, key, usdKrw) {
    const byCurrency = Object.values((history || {})[key] || {})
      .reduce((acc, v) => add(acc, v.currency, v.amount), {});
    const { krw, unconverted } = L.krwTotal(byCurrency, usdKrw);
    return { krw, hasUnconverted: Object.keys(unconverted).length > 0 };
  }

  /** 그 달 사용료 기록이 있는 서비스(aws, openai …) */
  const providersIn = (history, key) => new Set(Object.values((history || {})[key] || {}).map((v) => v.provider).filter(Boolean));

  const api = { providersIn, monthWindows, monthlyHistory, topSites, mergeCloudHistory, cloudMonthKRW, monthKey: (ts) => keyOf(new Date(ts)) };
  root.PaymentHistory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
