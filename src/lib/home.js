/* 이번 달(홈)·팝업 칸에 쓰는 계산. 2주 띠, 챙길 일, 예산 속도, 달마다 막대 비율, 분류 비율.
   전부 기존 규칙(ledger·history·settings·catalog)을 다시 쓰는 순수 함수라 테스트로 확인한다. */
(function (root) {
  'use strict';

  const need = (name, file) => root[name] || (typeof require === 'function' ? require(file) : null);
  const L = need('PaymentLedger', './ledger.js');
  const H = need('PaymentHistory', './history.js');
  const ST = need('PaymentSettings', './settings.js');
  const K = need('PaymentCatalog', './catalog.js');

  const STRIP_DAYS = 14;
  const TRIAL_SOON_DAYS = 14;
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const CHART_HEADROOM = 1.12;

  const addDays = (ts, n) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };
  const hasCard = (r) => Boolean(r.card && r.card.last4);
  const won = (n) => L.formatMoney(n, 'KRW');

  /** 2주 띠에 들어가는 짧은 금액: 13,500원 → "1.4만", 5,500원 → "5,500", $20 → "$20" */
  function shortMoney(amount, currency) {
    const n = Number(amount) || 0;
    if (currency === 'USD') return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
    if (n >= 10000) return `${+(n / 10000).toFixed(n >= 100000 ? 0 : 1)}만`;
    return Math.round(n).toLocaleString('ko-KR');
  }

  // 홈 합계와 같은 규칙: 확인됐고, 사용료 연결 값에 안 든 사용 중 구독
  const countedSubs = (records, isCovered) => records.filter((r) => L.isConfirmed(r) && !isCovered(r) && L.isActiveSubscription(r));

  /**
   * 오늘부터 days일의 칸. 결제일은 nextChargeDate와 같이 "지금 이후"만 센다(오늘 0시 결제는 이미 나간 돈).
   * @returns {{ts:number, day:number, weekday:string, isToday:boolean, isWeekend:boolean, items:object[], krw:number, isBiggest:boolean}[]}
   */
  function dayStrip(records, now, { days = STRIP_DAYS, usdKrw = 0, isCovered = () => false } = {}) {
    const subs = countedSubs(records, isCovered);
    const cells = Array.from({ length: days }, (_, i) => {
      const from = addDays(now, i);
      const to = addDays(now, i + 1);
      const items = subs.flatMap((record) => L.chargeDates(record, Math.max(from, now + 1), to)
        .map(() => ({ record, amount: record.amount, currency: record.currency || 'KRW' })))
        .filter((it) => it.amount != null);
      const byCurrency = items.reduce((acc, it) => ({ ...acc, [it.currency]: (acc[it.currency] || 0) + it.amount }), {});
      const d = new Date(from);
      return { ts: from, day: d.getDate(), weekday: WEEKDAYS[d.getDay()], isToday: i === 0, isWeekend: d.getDay() % 6 === 0,
        items, krw: L.krwTotal(byCurrency, usdKrw).krw, isBiggest: false };
    });
    const withCharges = cells.filter((c) => c.items.length);
    if (withCharges.length < 2) return cells;
    const biggest = withCharges.reduce((best, c) => (c.krw > best.krw ? c : best), withCharges[0]);
    return cells.map((c) => (c === biggest ? { ...c, isBiggest: true } : c));
  }

  /** 띠 전체의 결제 수·원화 합계 */
  const stripTotals = (strip) => strip.reduce((acc, c) => ({ count: acc.count + c.items.length, krw: acc.krw + c.krw }), { count: 0, krw: 0 });

  function trialsEndingSoon(records, now) {
    return records
      .filter((r) => L.isConfirmed(r) && L.isActiveSubscription(r) && r.trial && r.startedAt > now)
      .map((record) => ({ kind: 'trial', record, days: L.daysUntil(record.startedAt, now), date: record.startedAt }))
      .filter((t) => t.days <= TRIAL_SOON_DAYS)
      .sort((a, b) => a.days - b.days);
  }

  /**
   * 챙길 일: 곧 끝나는 무료 체험, 확인할 기록(자동 감지), 카드 안 정한 기록. 기존 데이터에서만 뽑는다.
   * @returns {({kind:'trial', record, days, date}|{kind:'pending', records}|{kind:'nocard', count})[]}
   */
  function todoList(records, now, { isCovered = () => false } = {}) {
    const pending = records.filter((r) => !L.isConfirmed(r) && (r.kind === 'subscription' || r.kind === 'one_time'));
    const noCard = L.unassignedSummary(records, now, { isCovered }).count;
    return [
      ...trialsEndingSoon(records, now),
      ...(pending.length ? [{ kind: 'pending', records: pending }] : []),
      ...(noCard ? [{ kind: 'nocard', count: noCard }] : []),
    ];
  }

  /** 예산 상태 + 오늘까지 쓸 만한 몫(달의 지난 날 비율)과 남은 날 하루 몫. 예산이 없으면 null. */
  function budgetPace(spentKRW, budgetKRW, now) {
    const state = ST.budgetState(spentKRW, budgetKRW);
    if (!state) return null;
    const d = new Date(now);
    const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const share = d.getDate() / daysInMonth;
    const daysLeft = daysInMonth - d.getDate();
    return {
      ...state,
      usedPct: Math.round((spentKRW / budgetKRW) * 100),
      dayShare: Math.round(share * 100) / 100,
      allowedKRW: Math.round(budgetKRW * share),
      daysLeft,
      perDayKRW: daysLeft > 0 && state.left > 0 ? Math.floor(state.left / daysLeft) : 0,
    };
  }

  // 0부터 시작하는 보기 좋은 위 끝(1·2·5 단위)
  function niceTop(max) {
    if (max <= 0) return 1;
    const mag = 10 ** Math.floor(Math.log10(max));
    return [1, 2, 2.5, 5, 10].map((k) => k * mag).find((v) => v >= max);
  }

  /**
   * 홈 막대: 달마다 계열 칸 높이(%)와 평균선. months는 history.groupedMonthly(by: all)의 months.
   * @param {{key, label, isCurrent, parts: object, total: number}[]} months @param {string[]} order 아래부터 쌓는 계열 순서
   */
  function chartModel(months, order) {
    const totals = months.map((m) => m.total);
    const avg = months.length ? Math.round(totals.reduce((a, b) => a + b, 0) / months.length) : 0;
    const max = niceTop(Math.max(0, ...totals) * CHART_HEADROOM);
    const pct = (v) => (v / max) * 100;
    const bars = months.map((m) => ({
      key: m.key, label: m.label, isCurrent: m.isCurrent, total: m.total, heightPct: pct(m.total),
      segs: order.filter((k) => (m.parts[k] || 0) > 0).map((k) => ({ key: k, value: m.parts[k], pct: pct(m.parts[k]) })),
    }));
    return { isEmpty: totals.every((t) => !t), max, avg, avgPct: pct(avg), bars };
  }

  /** 금액 목록을 정수 % 로(가장 큰 나머지 방식이라 합이 100) */
  function shares(items) {
    const total = items.reduce((acc, it) => acc + Math.max(0, it.krw), 0);
    if (!total) return items.map((it) => ({ ...it, pct: 0 }));
    const raw = items.map((it) => (Math.max(0, it.krw) / total) * 100);
    const floors = raw.map(Math.floor);
    let rest = 100 - floors.reduce((a, b) => a + b, 0);
    const order = raw.map((v, i) => [v - floors[i], i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
    const pcts = [...floors];
    for (const i of order) { if (rest <= 0) break; pcts[i] += 1; rest -= 1; }
    return items.map((it, i) => ({ ...it, pct: pcts[i] }));
  }

  // 이번 달에 실제로 돈이 나가는(나갈) 확인된 기록과 그 금액
  function paidThisMonth(records, now, isCovered) {
    const [from, to] = L.monthRange(now);
    return records.filter((r) => L.isConfirmed(r) && !isCovered(r) && r.amount != null).map((r) => {
      const times = r.kind === 'subscription' ? L.chargeDates(r, from, to).length
        : r.kind === 'one_time' && r.startedAt >= from && r.startedAt < to ? 1 : 0;
      return { record: r, amount: r.amount * times };
    }).filter((p) => p.amount > 0);
  }

  /** 이번 달 결제가 있는 구독 수·일회성 수 */
  function kindCounts(records, now, { isCovered = () => false } = {}) {
    const paid = paidThisMonth(records, now, isCovered);
    return { subscription: paid.filter((p) => p.record.kind === 'subscription').length, one_time: paid.filter((p) => p.record.kind === 'one_time').length };
  }

  /** 분류별로 이번 달 돈이 나가는 사이트(원화 큰 순) — 로고 묶음용 */
  function siteGroups(records, now, { categoryOf = () => 'other', usdKrw = 0, isCovered = () => false } = {}) {
    const krwOf = (p) => L.krwTotal({ [p.record.currency || 'KRW']: p.amount }, usdKrw).krw;
    return paidThisMonth(records, now, isCovered)
      .sort((a, b) => krwOf(b) - krwOf(a))
      .reduce((acc, p) => {
        const cat = categoryOf(p.record) || 'other';
        const list = acc[cat] || [];
        return list.includes(p.record.site) ? acc : { ...acc, [cat]: [...list, p.record.site] };
      }, {});
  }

  /** 지난달 = 기록에서 다시 계산한 결제 + 그달 사용료 확정값(원화) */
  function lastMonthKRW(records, now, { usdKrw = 0, isCovered = () => false, cloudHistory = {} } = {}) {
    const [last] = H.monthlyHistory(records, now, { months: 2, isCovered });
    const fromRecords = L.krwTotal(last.subscription, usdKrw).krw + L.krwTotal(last.one_time, usdKrw).krw;
    return fromRecords + H.cloudMonthKRW(cloudHistory, last.key, usdKrw).krw;
  }

  /** 지난달 대비 문구. 지난달 기록이 없으면 빈 글자. */
  function deltaInfo(thisKRW, lastKRW) {
    const diff = thisKRW - lastKRW;
    const trend = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
    if (!lastKRW) return { text: '', trend, diff };
    const text = diff === 0 ? '지난달과 같아요'
      : `지난달(${won(lastKRW)})보다 ${won(Math.abs(diff))} ${diff > 0 ? '많아요' : '적어요'}`;
    return { text, trend, diff };
  }

  /** 사용료 연결 값에 이미 든 기록인지. 이번 달은 지금 연결, 지난 달은 그달 사용료 기록으로 본다. */
  function coverage(connected, cloudHistory) {
    return (r, month) => (month && !month.isCurrent
      ? K.coveredBy(r, H.providersIn(cloudHistory, month.key)) != null
      : K.coveredBy(r, connected) != null);
  }

  const api = { STRIP_DAYS, shortMoney, dayStrip, stripTotals, todoList, budgetPace, chartModel, shares, kindCounts, siteGroups, lastMonthKRW, deltaInfo, coverage };
  root.PaymentHome = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
