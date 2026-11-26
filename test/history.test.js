const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lib/ledger.js');
const H = require('../src/lib/history.js');

const NOW = new Date(2026, 10, 12, 12).getTime(); // 2026-11-12
const day = (m, d, y = 2026) => new Date(y, m - 1, d).getTime();
const rec = (fields) => L.createRecord({
  site: 'x.com', kind: 'subscription', cycle: 'monthly', amount: 10000, currency: 'KRW',
  review: 'confirmed', startedAt: day(9, 5), ...fields,
}, day(9, 5));

test('달마다 내역은 오래된 달부터 이번 달까지 정해진 개수만큼 나온다', () => {
  const months = H.monthlyHistory([], NOW, { months: 12 });
  assert.equal(months.length, 12);
  assert.equal(months[0].key, '2025-12');
  assert.equal(months[11].key, '2026-11');
  assert.equal(months[11].isCurrent, true);
  assert.equal(months[11].label, '11월');
  assert.equal(months[0].label, '25년 12월');
});

test('매월 구독은 첫 결제일부터 달마다 한 번씩 잡힌다', () => {
  const months = H.monthlyHistory([rec({})], NOW, { months: 4 });
  assert.deepEqual(months.map((m) => m.subscription), [{}, { KRW: 10000 }, { KRW: 10000 }, { KRW: 10000 }]);
});

test('일회성은 결제한 달에만, 해지한 구독은 해지한 뒤로 빠진다', () => {
  const months = H.monthlyHistory([
    rec({ kind: 'one_time', cycle: null, amount: 30000, startedAt: day(10, 3) }),
    rec({ site: 'old.com', status: 'canceled', canceledAt: day(10, 1) }),
  ], NOW, { months: 3 });
  assert.deepEqual(months.map((m) => m.one_time), [{}, { KRW: 30000 }, {}]);
  assert.deepEqual(months.map((m) => m.subscription), [{ KRW: 10000 }, {}, {}]);
});

test('확인 대기·연결 값에 포함된 기록은 달마다 내역에서도 뺀다', () => {
  const months = H.monthlyHistory([
    rec({ review: 'pending' }),
    rec({ site: 'aws.amazon.com' }),
  ], NOW, { months: 1, isCovered: (r) => r.site === 'aws.amazon.com' });
  assert.deepEqual(months[0].subscription, {});
});

test('연결 값에 포함됐는지는 달마다 따로 본다(그 달 사용료 기록이 있을 때만 뺀다)', () => {
  const aws = rec({ site: 'aws.amazon.com', amount: 50000 });
  const months = H.monthlyHistory([aws], NOW, { months: 3, isCovered: (r, m) => m.key === '2026-10' });
  assert.deepEqual(months.map((m) => m.subscription), [{ KRW: 50000 }, {}, { KRW: 50000 }]);
});

test('많이 쓴 곳은 원화로 바꿔 큰 순서대로, 정해진 개수만', () => {
  const top = H.topSites([
    rec({ site: 'a.com', amount: 5000 }),
    rec({ site: 'b.com', amount: 10, currency: 'USD' }),
    rec({ site: 'c.com', kind: 'one_time', cycle: null, amount: 1000, startedAt: day(11, 1) }),
  ], NOW, 1400, { months: 3, limit: 2 });
  assert.deepEqual(top.map((t) => [t.site, t.krw]), [['b.com', 42000], ['a.com', 15000]]);
});

test('사용료 기록은 이번 달 누적과 지난달 확정값을 달별로 쌓는다', () => {
  const costs = {
    a1: { provider: 'aws', month: '2026-11', monthToDate: 12.5, lastMonth: 40, currency: 'USD' },
    b2: { provider: 'openai', month: '2026-10', monthToDate: 3, lastMonth: null, currency: 'USD' },
  };
  const next = H.mergeCloudHistory({ '2026-09': { a1: { amount: 30, currency: 'USD', final: true } } }, costs, { thisKey: '2026-11', lastKey: '2026-10' });
  assert.deepEqual(next['2026-11'], { a1: { amount: 12.5, currency: 'USD', final: false, provider: 'aws' } });
  assert.deepEqual(next['2026-10'], { a1: { amount: 40, currency: 'USD', final: true, provider: 'aws' } });
  assert.deepEqual(next['2026-09'].a1.amount, 30, '예전 달은 그대로 둔다');
  assert.equal(next['2026-10'].b2, undefined, '지난달 값이 아닌 숫자는 쌓지 않는다');
});

test('사용료 기록은 24개월만 남기고, 확정값을 누적값으로 덮지 않는다', () => {
  const old = Object.fromEntries(Array.from({ length: 30 }, (_, i) => {
    const d = new Date(2024, i, 1);
    return [`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, { a1: { amount: 1, currency: 'USD', final: true } }];
  }));
  const next = H.mergeCloudHistory({ ...old, '2026-11': { a1: { amount: 99, currency: 'USD', final: true } } },
    { a1: { month: '2026-11', monthToDate: 5, currency: 'USD' } }, { thisKey: '2026-11', lastKey: '2026-10' });
  assert.equal(Object.keys(next).length, 24);
  assert.equal(next['2026-11'].a1.amount, 99);
});

test('그 달 사용료 기록이 있는 서비스 목록', () => {
  const history = { '2026-10': { a1: { amount: 1, currency: 'USD', final: true, provider: 'aws' }, x: { amount: 1, currency: 'USD' } } };
  assert.deepEqual([...H.providersIn(history, '2026-10')], ['aws']);
  assert.equal(H.providersIn(history, '2026-01').size, 0);
});

test('달별 사용료 합계는 원화로 바꾸고, 못 바꾸면 빼고 표시한다', () => {
  const history = { '2026-10': { a1: { amount: 10, currency: 'USD', final: true }, k: { amount: 5000, currency: 'KRW', final: true } } };
  assert.deepEqual(H.cloudMonthKRW(history, '2026-10', 1400), { krw: 19000, hasUnconverted: false });
  assert.deepEqual(H.cloudMonthKRW(history, '2026-10', null), { krw: 5000, hasUnconverted: true });
  assert.deepEqual(H.cloudMonthKRW(history, '2026-01', 1400), { krw: 0, hasUnconverted: false });
});

// ---- 달마다 보기: 카드별·분류별 ----
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const KR = (site, fields = {}) => rec({ site, ...fields });
const catOf = (r) => ({ 'claude.ai': 'ai', 'github.com': 'dev', 'notion.so': 'work', 'netflix.com': 'life', 'vercel.com': 'cloud' }[r.site] || null);
const opts = { months: 3, usdKrw: 1400, categoryOf: catOf, cloudKRW: (key) => (key === '2026-11' ? 5000 : 0) };
const mixed = () => [
  KR('claude.ai', { amount: 20, currency: 'USD', card: { brand: '신한', last4: '1111' } }),
  KR('github.com', { amount: 4.33, currency: 'USD', card: { brand: '신한', last4: '1111' } }),
  KR('notion.so', { amount: 12345, card: { brand: '삼성', last4: '2222' } }),
  KR('netflix.com', { amount: 17000 }),
  KR('mystery.io', { amount: 3333, card: { brand: '삼성', last4: '2222' } }),
  rec({ site: 'shop.com', kind: 'one_time', cycle: null, amount: 55555, startedAt: day(10, 3) }),
];

test('보기마다 달별 합계가 전체 보기와 같다', () => {
  const all = H.groupedMonthly(mixed(), NOW, { ...opts, by: 'all' });
  for (const by of ['card', 'category']) {
    const view = H.groupedMonthly(mixed(), NOW, { ...opts, by });
    assert.deepEqual(view.months.map((m) => m.total), all.months.map((m) => m.total), by);
    for (const m of view.months) assert.equal(sum(m.parts), m.total, `${by} ${m.key} 계열 합 = 합계`);
  }
  assert.ok(all.months[2].total > 0);
});

test('전체 보기는 구독·일회성·서버API 세 계열', () => {
  const all = H.groupedMonthly(mixed(), NOW, { ...opts, by: 'all' });
  assert.deepEqual(all.series.map((s) => s.key), ['subscription', 'one_time', 'cloud']);
  assert.equal(all.months[2].parts.cloud, 5000);
  assert.equal(all.months[2].parts.one_time, 0);
  assert.equal(all.months[1].parts.one_time, 55555);
});

test('분류별은 카탈로그 분류를 쓰고 없는 기록은 기타, 연결 사용료는 서버·API', () => {
  const v = H.groupedMonthly(mixed().filter((r) => r.site !== 'notion.so'), NOW, { ...opts, by: 'category' });
  const keys = v.series.map((s) => s.key);
  assert.ok(keys.includes('other'));
  assert.ok(keys.includes('cloud'));
  assert.equal(v.series.find((s) => s.key === 'cloud').label, '서버·API');
  assert.equal(v.series.find((s) => s.key === 'other').label, '기타');
  assert.equal(v.months[2].parts.cloud, 5000);
  assert.equal(v.months[2].parts.ai, 28000);
  assert.equal(v.months[2].parts.other, 3333);
});

test('계열이 5개를 넘으면 상위 4개 + 기타로 묶고, 합계는 그대로', () => {
  const v = H.groupedMonthly(mixed(), NOW, { ...opts, by: 'category' });
  assert.equal(v.series.length, 5);
  assert.equal(v.series[4].key, 'other');
  const all = H.groupedMonthly(mixed(), NOW, { ...opts, by: 'all' });
  assert.deepEqual(v.months.map((m) => m.total), all.months.map((m) => m.total));
  // 6개 분류: 가장 작은 둘(생활 17000·기타 3333 중 하나 이상)이 기타로 합쳐진다
  assert.ok(v.months[2].parts.other >= 3333);
});

test('카드별은 끝 4자리로 나누고 카드 없는 기록은 카드 안 정함', () => {
  const v = H.groupedMonthly(mixed(), NOW, { ...opts, by: 'card', cardLabel: (l4) => `카드 ${l4}` });
  const labels = Object.fromEntries(v.series.map((s) => [s.key, s.label]));
  assert.equal(labels['1111'], '카드 1111');
  assert.equal(labels.__none, '카드 안 정함');
  assert.equal(v.months[2].parts['2222'], 12345 + 3333);
  assert.equal(v.months[2].parts['1111'], 28000 + Math.round(4.33 * 1400));
});

test('환율 반올림 차이가 있어도 계열 합이 전체 합계와 같다', () => {
  const recs = [1, 2, 3].map((i) => KR(`s${i}.com`, { amount: 0.37 + i, currency: 'USD', card: { brand: 'a', last4: `000${i}` } }));
  const v = H.groupedMonthly(recs, NOW, { months: 1, usdKrw: 1333, by: 'card' });
  const all = H.groupedMonthly(recs, NOW, { months: 1, usdKrw: 1333, by: 'all' });
  assert.equal(v.months[0].total, all.months[0].total);
  assert.equal(sum(v.months[0].parts), v.months[0].total);
});

test('확인 대기 기록은 어느 보기에서도 빠진다', () => {
  const v = H.groupedMonthly([KR('claude.ai', { review: 'pending' })], NOW, { ...opts, by: 'category' });
  assert.deepEqual(v.months.map((m) => m.total), [0, 0, 5000 * 0 + 5000]);
});
