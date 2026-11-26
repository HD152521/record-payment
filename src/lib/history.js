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

  const TOP_SERIES = 4;
  const MAX_SERIES = 5;
  const CATEGORY_LABELS = { ai: 'AI', dev: '개발 도구', work: '업무 도구', life: '생활 구독', cloud: '서버·API', other: '기타' };
  const ALL_SERIES = [
    { key: 'subscription', label: '구독' }, { key: 'one_time', label: '일회성' }, { key: 'cloud', label: '서버·API' },
  ];
  const NO_CARD = '__none';
  const CARD_CLOUD = '__cloud';

  const keyFns = {
    all: (r) => r.kind,
    card: (r) => (r.card && r.card.last4) || NO_CARD,
    category: (r, o) => (o.categoryOf && o.categoryOf(r)) || 'other',
  };
  const cloudKeys = { all: 'cloud', card: CARD_CLOUD, category: 'cloud' };

  /** 한 달 안에서 계열 키별 원화 금액. 반올림 차이는 가장 큰 계열에 얹어 합계를 전체 보기와 맞춘다. */
  function partsOfMonth(counted, w, o, cloudKRW) {
    const byGroup = {};
    const byKind = { subscription: {}, one_time: {} };
    for (const r of counted) {
      const paid = paidIn(r, w.from, w.to);
      if (!paid) continue;
      const g = keyFns[o.by](r, o);
      byGroup[g] = add(byGroup[g] || {}, r.currency, paid);
      byKind[r.kind] = add(byKind[r.kind] || {}, r.currency, paid);
    }
    const parts = Object.fromEntries(Object.entries(byGroup).map(([g, byCur]) => [g, L.krwTotal(byCur, o.usdKrw).krw]));
    if (cloudKRW) parts[cloudKeys[o.by]] = (parts[cloudKeys[o.by]] || 0) + cloudKRW;
    const total = L.krwTotal(byKind.subscription, o.usdKrw).krw + L.krwTotal(byKind.one_time, o.usdKrw).krw + cloudKRW;
    const keys = Object.keys(parts);
    if (keys.length) {
      const big = keys.reduce((best, k) => (parts[k] > parts[best] ? k : best), keys[0]);
      parts[big] += total - keys.reduce((acc, k) => acc + parts[k], 0);
    }
    return { parts, total };
  }

  /** 계열이 5개를 넘으면 합계가 큰 4개만 남기고 나머지는 기타로 묶는다. */
  function collapseSeries(rows, labelOf) {
    const sums = {};
    for (const row of rows) for (const [k, v] of Object.entries(row.parts)) sums[k] = (sums[k] || 0) + v;
    const ranked = Object.keys(sums).sort((a, b) => sums[b] - sums[a] || (a < b ? -1 : 1));
    if (ranked.length <= MAX_SERIES) return { keys: ranked, rows };
    const keep = ranked.filter((k) => k !== 'other').slice(0, TOP_SERIES);
    const merged = rows.map((row) => {
      const parts = {};
      for (const [k, v] of Object.entries(row.parts)) {
        const target = keep.includes(k) ? k : 'other';
        parts[target] = (parts[target] || 0) + v;
      }
      return { ...row, parts };
    });
    return { keys: [...keep, 'other'], rows: merged };
  }

  /**
   * 달별 원화 금액을 보기(all 구독·일회성·서버API / card 카드별 / category 분류별)로 나눈다.
   * 어느 보기든 달별 합계는 같다. cloudKRW(달 키, 이번 달 여부)는 사용료 연결 값(원화).
   */
  function groupedMonthly(records, now, options = {}) {
    const o = { by: 'all', months: 12, isCovered: () => false, cloudKRW: () => 0, ...options };
    if (!keyFns[o.by]) o.by = 'all';
    const rows = monthWindows(now, o.months).map((w) => {
      const { parts, total } = partsOfMonth(countedIn(records, o.isCovered, w), w, o, o.cloudKRW(w.key, w.isCurrent) || 0);
      return { key: w.key, label: w.label, isCurrent: w.isCurrent, parts, total };
    });
    if (o.by === 'all') {
      return { series: ALL_SERIES, months: rows.map((m) => ({ ...m, parts: Object.fromEntries(ALL_SERIES.map((s) => [s.key, m.parts[s.key] || 0])) })) };
    }
    const { keys, rows: grouped } = collapseSeries(rows, null);
    const labelOf = (k) => {
      if (o.by === 'category') return CATEGORY_LABELS[k] || k;
      if (k === NO_CARD) return '카드 안 정함';
      if (k === CARD_CLOUD) return '서버·API 연결';
      if (k === 'other') return '기타';
      return o.cardLabel ? o.cardLabel(k) : `카드 ····${k}`;
    };
    return {
      series: keys.map((k) => ({ key: k, label: labelOf(k) })),
      months: grouped.map((m) => ({ ...m, parts: Object.fromEntries(keys.map((k) => [k, m.parts[k] || 0])) })),
    };
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

  const api = { providersIn, monthWindows, monthlyHistory, groupedMonthly, topSites, mergeCloudHistory, cloudMonthKRW, monthKey: (ts) => keyOf(new Date(ts)) };
  root.PaymentHistory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
