/* 이번 달 칸 중 "어디에 쓰나"(분류 비율, 달마다 분류별 보기와 같은 계산)와 "카드별"(카드 화면과 같은 계산). */
(() => {
  'use strict';

  const L = globalThis.PaymentLedger;
  const H = globalThis.PaymentHistory;
  const K = globalThis.PaymentCatalog;
  const HM = globalThis.PaymentHome;
  const { el, brandAvatar } = globalThis.PaymentUI;
  const $ = (id) => document.getElementById(id);
  const won = (n) => L.formatMoney(n, 'KRW');
  const MAX_LOGOS = 3;
  const MAX_CARDS = 4;
  // 달마다 화면과 같은 색 순서: 큰 분류부터 1·2·3·4, 기타는 늘 5
  const COLORS = [1, 2, 3, 4, 5].map((n) => `var(--series-${n})`);

  const categoryOf = (r) => { const item = K.findBySite(r.site); return item ? item.category : null; };

  function categoryRows(ctx) {
    const result = H.groupedMonthly(ctx.records, ctx.now, {
      months: 1, by: 'category', isCovered: ctx.isCovered, usdKrw: ctx.usdKrw, categoryOf,
      cloudKRW: () => ctx.cloudNow.projected,
    });
    const [month] = result.months;
    let next = 0;
    const rows = result.series
      .map((s) => ({ ...s, krw: month.parts[s.key] || 0, color: s.key === 'other' ? COLORS[4] : COLORS[next++] }))
      .filter((s) => s.krw > 0);
    return HM.shares(rows);
  }

  // 분류마다 대표 로고: 이번 달 돈이 큰 서비스 순, 서버·API는 연결한 서비스도
  function logosFor(ctx, groups, key) {
    const fromRecords = (groups[key] || []).map((site) => K.findBySite(site)).filter(Boolean);
    const connected = key === 'cloud' ? [...ctx.cloudView.connected].map((p) => K.ITEMS.find((i) => i.connect === p)).filter(Boolean) : [];
    const items = [...fromRecords, ...connected].filter((item, i, list) => list.indexOf(item) === i).slice(0, MAX_LOGOS);
    return el('span', { class: 'logos', 'aria-hidden': 'true' }, items.map((item) => brandAvatar(item)));
  }

  function renderCats(ctx) {
    const rows = categoryRows(ctx);
    const groups = HM.siteGroups(ctx.records, ctx.now, { categoryOf, usdKrw: ctx.usdKrw, isCovered: ctx.isCovered });
    $('cat-seg').replaceChildren(...rows.map((r) => el('i', { style: `flex:${r.krw};background:${r.color}` })));
    $('cat-seg').setAttribute('aria-label', rows.map((r) => `${r.label} ${r.pct}%`).join(', ') || '이번 달 분류별 지출 없음');
    $('cat-seg').hidden = rows.length === 0;
    $('cat-grid').replaceChildren(...rows.map((r) => el('li', { class: 'cat' },
      el('i', { style: `background:${r.color}`, 'aria-hidden': 'true' }),
      el('span', { class: 'cat-name' }, r.label, el('small', {}, ` · ${r.pct}%`)),
      logosFor(ctx, groups, r.key),
      el('b', { class: 'num' }, won(r.krw)))));
    $('cat-empty').hidden = rows.length > 0;
  }

  const mdText = (ts) => `${new Date(ts).getMonth() + 1}월 ${new Date(ts).getDate()}일`;

  function cardItems(ctx) {
    const opts = { isCovered: (r) => ctx.isCovered(r) };
    const list = L.cardSummary(ctx.records, ctx.cards, ctx.now, opts)
      .map((c) => ({ ...c, krw: L.krwTotal(c.thisMonth, ctx.usdKrw).krw }));
    const none = L.unassignedSummary(ctx.records, ctx.now, opts);
    const noneRow = none.count ? [{ ...none, isNone: true, label: '카드 안 정함', krw: L.krwTotal(none.thisMonth, ctx.usdKrw).krw }] : [];
    const sorted = [...list].sort((a, b) => b.krw - a.krw).slice(0, MAX_CARDS);
    return [...sorted, ...noneRow];
  }

  function cardRow(c, max) {
    const meta = c.isNone ? `기록 ${c.count}개`
      : `구독 ${c.count}개${c.nextCharge ? ` · 다음 ${mdText(c.nextCharge)}` : ''}`;
    return el('li', { class: `cc${c.isNone ? ' is-none' : ''}${c.registered === false ? ' is-unregistered' : ''}` },
      el('span', { class: 'plate', 'aria-hidden': 'true' }, c.isNone ? '?' : c.last4),
      el('div', { class: 't' },
        el('b', {}, c.label),
        el('span', {}, meta),
        el('span', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: `width:${max ? Math.max(2, Math.round((c.krw / max) * 100)) : 0}%` }))),
      el('span', { class: 'amt num' }, won(c.krw)));
  }

  function renderCards(ctx) {
    const items = cardItems(ctx);
    const max = Math.max(0, ...items.map((c) => c.krw));
    $('cardsum-list').replaceChildren(...items.map((c) => cardRow(c, max)));
    $('cardsum-empty').hidden = ctx.cards.length > 0 || items.length > 0;
  }

  function render(ctx) {
    renderCats(ctx);
    renderCards(ctx);
  }

  $('cardsum-add').addEventListener('click', () => $('card-add').click());

  globalThis.PaymentHomeSpend = { render };
})();
