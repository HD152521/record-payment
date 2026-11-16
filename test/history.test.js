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
