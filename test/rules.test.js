const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lib/ledger.js');
const K = require('../src/lib/catalog.js');

const NOW = new Date(2026, 10, 12, 12).getTime(); // 2026-11-12
const day = (m, d, y = 2026) => new Date(y, m - 1, d).getTime();

function rec(fields) {
  return L.createRecord({
    site: 'x.com', kind: 'subscription', cycle: 'monthly', amount: 10000, currency: 'KRW',
    review: 'confirmed', startedAt: day(10, 20), ...fields,
  }, day(10, 20));
}

// ── 1. 자동 감지 기록은 확인 전까지 합계에서 뺀다
test('자동 감지(확인 대기) 기록은 합계에 들어가지 않고 pending으로 모인다', () => {
  const s = L.summarize([rec({}), rec({ site: 'auto.com', review: 'pending' })], NOW);
  assert.deepEqual(s.monthly, { KRW: 10000 });
  assert.deepEqual(s.pending.map((r) => r.site), ['auto.com']);
  assert.equal(s.activeSubscriptions, 1);
});

test('review가 없던 예전 기록은 사용자가 고친 것만 확인된 것으로 본다', () => {
  assert.equal(L.isConfirmed({ userEdited: true }), true);
  assert.equal(L.isConfirmed({ userEdited: false }), false);
  assert.equal(L.isConfirmed({ review: 'confirmed' }), true);
});

test('새로 만든 기록은 기본이 확인 대기다', () => {
  assert.equal(L.createRecord({ site: 'a.com' }, NOW).review, 'pending');
});

test('markConfirmed는 원본을 바꾸지 않고 확인·사용자 수정 표시를 붙인다', () => {
  const r = rec({ review: 'pending' });
  const ok = L.markConfirmed(r, NOW);
  assert.equal(ok.review, 'confirmed');
  assert.equal(ok.userEdited, true);
  assert.equal(r.review, 'pending');
});

test('결제수단 등록만 한 기록은 확인할 목록에 넣지 않는다', () => {
  const s = L.summarize([rec({ kind: 'card_registered', review: 'pending', amount: null })], NOW);
  assert.equal(s.pending.length, 0);
});

// ── 2. 이번 달 실제로 나가는 돈
test('연간 구독은 결제일이 든 달에만 전액이 이번 달 금액에 들어간다', () => {
  const thisMonth = rec({ cycle: 'yearly', amount: 120000, startedAt: day(11, 3, 2025) });
  const otherMonth = rec({ cycle: 'yearly', amount: 60000, startedAt: day(3, 3, 2026) });
  const s = L.summarize([thisMonth, otherMonth], NOW);
  assert.deepEqual(s.thisMonth, { KRW: 120000 });
  assert.deepEqual(s.monthly, { KRW: 15000 }); // 월 평균은 그대로 1/12
});

test('이번 달 금액은 아직 안 온 이번 달 결제일과 이번 달 일회성 결제를 더한다', () => {
  const s = L.summarize([
    rec({ startedAt: day(10, 25) }), // 11/25 결제 예정
    rec({ kind: 'one_time', cycle: null, amount: 3000, startedAt: day(11, 2) }),
    rec({ kind: 'one_time', cycle: null, amount: 9999, startedAt: day(10, 2) }),
  ], NOW);
  assert.deepEqual(s.thisMonth, { KRW: 13000 });
  assert.deepEqual(s.oneTimeThisMonth, { KRW: 3000 });
});

test('주간 구독은 이번 달에 든 결제일 수만큼 더한다', () => {
  const s = L.summarize([rec({ cycle: 'weekly', amount: 1000, startedAt: day(11, 2) })], NOW);
  assert.deepEqual(s.thisMonth, { KRW: 5000 }); // 11/2, 9, 16, 23, 30
});

// ── 3. 사용료 연결이 된 서비스는 연결 값이 이긴다
test('연결 값에 포함된 기록은 합계에서 빼고 covered로 따로 센다', () => {
  const vercel = rec({ site: 'vercel.com', amount: 20, currency: 'USD' });
  const s = L.summarize([rec({}), vercel], NOW, { isCovered: (r) => r.site === 'vercel.com' });
  assert.deepEqual(s.monthly, { KRW: 10000 });
  assert.deepEqual(s.thisMonth, { KRW: 10000 });
  assert.deepEqual(s.covered.map((r) => r.site), ['vercel.com']);
});

test('coveredBy는 연결된 서비스의 기록만 덮고 GitHub 요금제는 덮지 않는다', () => {
  const connected = new Set(['vercel', 'github', 'aws']);
  assert.equal(K.coveredBy({ site: 'vercel.com' }, connected), 'vercel');
  assert.equal(K.coveredBy({ site: 'vercel.com' }, new Set(['aws'])), null);
  assert.equal(K.coveredBy({ site: 'github.com' }, connected), null);
  assert.equal(K.coveredBy({ site: 'netflix.com' }, connected), null);
});

// ── 4. 결제일·무료 체험
test('무료 체험은 첫 결제일(체험 끝나는 날)을 다음 결제일로 잡고 표시한다', () => {
  const r = rec({ trial: true, startedAt: day(11, 20) });
  assert.equal(L.nextChargeDate(r, NOW).getTime(), day(11, 20));
  const [up] = L.summarize([r], NOW).upcoming;
  assert.equal(up.isTrialEnd, true);
  assert.equal(L.summarize([rec({ trial: true, startedAt: day(10, 1) })], NOW).upcoming[0].isTrialEnd, false);
});

test('체험이 다음 달에 끝나면 이번 달 금액에는 없다', () => {
  const s = L.summarize([rec({ trial: true, startedAt: day(12, 5) })], NOW);
  assert.deepEqual(s.thisMonth, {});
});

// ── 5. 해지
test('해지 전 이번 달에 이미 나간 결제는 남기고, 해지 뒤 결제일은 뺀다', () => {
  const paidThenCanceled = rec({ startedAt: day(10, 3), status: 'canceled', canceledAt: day(11, 5) });
  const canceledBefore = rec({ startedAt: day(10, 20), status: 'canceled', canceledAt: day(11, 5) });
  const s = L.summarize([paidThenCanceled, canceledBefore], NOW);
  assert.deepEqual(s.thisMonth, { KRW: 10000 });
  assert.deepEqual(s.monthly, {});
  assert.equal(s.upcoming.length, 0);
});

test('해지로 올해 아낀 돈은 해지 뒤 지나간 결제일만큼이다', () => {
  const r = rec({ startedAt: day(1, 10), status: 'canceled', canceledAt: day(9, 1) });
  assert.deepEqual(L.summarize([r], NOW).savedThisYear, { KRW: 30000 }); // 9/10, 10/10, 11/10
});

test('sanitizeRecord는 해지일을 채우고 사용중이면 지운다', () => {
  const canceled = L.sanitizeRecord({ id: 'a', site: 'a.com', status: 'canceled', updatedAt: 123 });
  assert.equal(canceled.canceledAt, 123);
  const active = L.sanitizeRecord({ id: 'a', site: 'a.com', status: 'active', canceledAt: 5 });
  assert.equal(active.canceledAt, null);
  assert.equal(L.sanitizeRecord({ id: 'a', site: 'a.com', review: 'confirmed' }).review, 'confirmed');
  assert.equal(L.sanitizeRecord({ id: 'a', site: 'a.com', review: 'weird' }).review, 'pending');
});
