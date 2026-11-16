const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/lib/forecast.js');

const NOW = new Date(2026, 10, 17, 12).getTime();
const view = (over = {}) => ({ accounts: [{ id: 'a' }], total: { monthToDate: 30000, projected: 50000 }, hasUnconverted: false, ...over });

test('서버·API: 로컬 달과 사용료 달이 같으면 지금·월말 예상을 쓴다', () => {
  assert.deepEqual(F.cloudParts(view(), NOW, '2026-11'), { now: 30000, projected: 50000, hasUnconverted: false });
});

test('서버·API: 월말 예상이 지금보다 작으면 지금 값으로 올린다', () => {
  const parts = F.cloudParts(view({ total: { monthToDate: 40000, projected: 10000 } }), NOW, '2026-11');
  assert.equal(parts.projected, 40000);
});

test('서버·API: 달이 다르거나 연결이 없으면 0', () => {
  assert.deepEqual(F.cloudParts(view(), NOW, '2026-10'), { now: 0, projected: 0, hasUnconverted: false });
  assert.deepEqual(F.cloudParts({ accounts: [], total: {}, hasUnconverted: false }, NOW, '2026-11'), { now: 0, projected: 0, hasUnconverted: false });
});

test('이번 달 예상 = 나간 돈(결제 + 서버 지금) + 나갈 돈(남은 결제 + 서버 남은 예상)', () => {
  const s = { paidThisMonth: { KRW: 10000, USD: 10 }, dueThisMonth: { KRW: 5000 }, thisMonth: { KRW: 15000, USD: 10 } };
  const f = F.monthForecast(s, { now: 30000, projected: 50000 }, 1400);
  assert.deepEqual(f, { paidKRW: 10000 + 14000 + 30000, dueKRW: 5000 + 20000, totalKRW: 79000, unconverted: {} });
});

test('환율로 못 바꾼 통화는 따로 남긴다', () => {
  const s = { paidThisMonth: { EUR: 5 }, dueThisMonth: {}, thisMonth: { EUR: 5 } };
  assert.deepEqual(F.monthForecast(s, { now: 0, projected: 0 }, 1400).unconverted, { EUR: 5 });
});
