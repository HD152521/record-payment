const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lib/ledger.js');

const NOW = new Date(2026, 8, 29).getTime();

function sub(fields) {
  return L.createRecord({ site: 'x.com', kind: 'subscription', cycle: 'monthly', amount: 10000, currency: 'KRW', review: 'confirmed', ...fields }, NOW);
}

test('formatMoney labels currencies other than KRW and USD', () => {
  assert.equal(L.formatMoney(12.5, 'EUR'), '12.5 EUR');
  assert.equal(L.formatMoney(9900, 'KRW'), '9,900원');
});

test('monthlyEquivalent converts yearly and ignores canceled or one-time', () => {
  assert.equal(L.monthlyEquivalent(sub({ cycle: 'yearly', amount: 120000 })), 10000);
  assert.equal(L.monthlyEquivalent(sub({ status: 'canceled' })), 0);
  assert.equal(L.monthlyEquivalent(sub({ kind: 'one_time' })), 0);
});

test('nextChargeDate steps forward from the start date', () => {
  const r = sub({ startedAt: new Date(2026, 7, 15).getTime() });
  const next = L.nextChargeDate(r, NOW);
  assert.deepEqual([next.getFullYear(), next.getMonth(), next.getDate()], [2026, 9, 15]);
});

test('nextChargeDate clamps month-end start dates', () => {
  const r = sub({ startedAt: new Date(2026, 0, 31).getTime() });
  const next = L.nextChargeDate(r, new Date(2026, 1, 1).getTime());
  assert.deepEqual([next.getMonth(), next.getDate()], [1, 28]);
});

test('summarize splits totals by currency and counts one-time spend this month', () => {
  const records = [
    sub({ amount: 9900 }),
    sub({ amount: 20, currency: 'USD' }),
    sub({ amount: 5000, status: 'canceled' }),
    L.createRecord({ site: 'shop.com', kind: 'one_time', amount: 30000, currency: 'KRW', review: 'confirmed' }, NOW),
    L.createRecord({ site: 'old.com', kind: 'one_time', amount: 1000, currency: 'KRW', review: 'confirmed' }, new Date(2026, 5, 1).getTime()),
  ];
  const s = L.summarize(records, NOW);
  assert.deepEqual(s.monthly, { KRW: 9900, USD: 20 });
  assert.deepEqual(s.oneTimeThisMonth, { KRW: 30000 });
  assert.equal(s.activeSubscriptions, 2);
});

test('이번 달 돈은 나간 돈(오늘까지 결제일)과 나갈 돈(남은 결제일)으로 나뉜다', () => {
  const now = new Date(2026, 10, 14, 15).getTime(); // 11-14 오후
  const day = (d) => new Date(2026, 10, d).getTime();
  const records = [
    sub({ amount: 10000, startedAt: new Date(2026, 9, 5).getTime() }), // 11-05 결제 → 나간 돈
    sub({ amount: 13500, startedAt: new Date(2026, 9, 14).getTime() }), // 오늘 결제 → 나간 돈
    sub({ amount: 20, currency: 'USD', startedAt: new Date(2026, 9, 20).getTime() }), // 11-20 → 나갈 돈
    L.createRecord({ site: 'shop.com', kind: 'one_time', amount: 30000, currency: 'KRW', review: 'confirmed', startedAt: day(3) }, day(3)),
    L.createRecord({ site: 'pre.com', kind: 'one_time', amount: 5000, currency: 'KRW', review: 'confirmed', startedAt: day(25) }, day(3)),
  ];
  const s = L.summarize(records, now);
  assert.deepEqual(s.paidThisMonth, { KRW: 53500 });
  assert.deepEqual(s.dueThisMonth, { USD: 20, KRW: 5000 });
  assert.deepEqual(s.thisMonth, { KRW: 58500, USD: 20 });
});

test('곧 나갈 돈: 7일 안 결제 예정 합계(다음 달로 넘어가도 센다)', () => {
  const now = new Date(2026, 10, 28, 12).getTime(); // 11-28
  const records = [
    sub({ amount: 13500, startedAt: new Date(2026, 9, 30).getTime() }), // 11-30, D-2
    sub({ amount: 20, currency: 'USD', startedAt: new Date(2026, 9, 3).getTime() }), // 12-03, D-5
    sub({ amount: 9900, startedAt: new Date(2026, 9, 15).getTime() }), // 12-15, 7일 밖
  ];
  const s = L.summarize(records, now);
  assert.deepEqual(s.soon, { KRW: 13500, USD: 20 });
  assert.equal(s.upcoming.length, 3, '목록은 그대로 30일 안');
  assert.deepEqual(s.upcoming.map((u) => L.daysUntil(u.date, now)), [2, 5, 17]);
});

test('mergeRecord upgrades kind but never downgrades it', () => {
  const base = L.createRecord({ site: 'a.com', kind: 'card_registered' }, NOW);
  const up = L.mergeRecord(base, { kind: 'subscription', amount: 5000, currency: 'KRW' }, NOW);
  assert.equal(up.kind, 'subscription');
  assert.equal(L.mergeRecord(up, { kind: 'one_time' }, NOW).kind, 'subscription');
  assert.equal(base.kind, 'card_registered');
});

test('mergeRecord leaves user-edited records untouched, including card and pg', () => {
  const edited = { ...sub({ amount: 7000, card: null, pg: null }), userEdited: true };
  const merged = L.mergeRecord(edited, { amount: 1, currency: 'USD', pg: 'Stripe', card: { brand: 'VISA', last4: '1111' } }, NOW);
  assert.equal(merged.amount, 7000);
  assert.equal(merged.pg, null);
  assert.equal(merged.card, null);
});

test('toCsv escapes quotes and neutralizes spreadsheet formulas', () => {
  const csv = L.toCsv([sub({ site: '=cmd', note: 'say "hi"' })]);
  assert.match(csv, /"'=cmd"/);
  assert.match(csv, /"say ""hi"""/);
});

test('normalizeCard keeps a short label, brand and exactly four digits', () => {
  const card = L.normalizeCard({ label: '  회사 법인카드  ', brand: 'Visa', last4: '1234' }, NOW);
  assert.equal(card.label, '회사 법인카드');
  assert.equal(card.brand, 'Visa');
  assert.equal(card.last4, '1234');
  assert.equal(typeof card.id, 'string');
  assert.throws(() => L.normalizeCard({ label: 'x', last4: '12a4' }), /4자리/);
  assert.equal(L.normalizeCard({ label: 'x'.repeat(100), last4: '0000' }).label.length, 30);
  assert.equal(L.normalizeCard({ last4: '0000' }).label, '카드 ····0000');
});

test('upsertCard replaces a card with the same last four digits', () => {
  const a = L.normalizeCard({ label: 'A', last4: '1111' }, NOW);
  const b = L.normalizeCard({ label: 'B', last4: '1111' }, NOW + 1);
  const list = L.upsertCard([a], b);
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'B');
  assert.equal(list[0].id, a.id);
});

test('cardSummary groups subscriptions by card and lists cards only seen in records', () => {
  const cards = [L.normalizeCard({ label: '신한', brand: 'Visa', last4: '1111' }, NOW)];
  const records = [
    sub({ amount: 10000, card: { brand: 'Visa', last4: '1111' } }),
    sub({ amount: 120000, cycle: 'yearly', card: { brand: 'Visa', last4: '1111' } }),
    sub({ amount: 20, currency: 'USD', card: { brand: 'Mastercard', last4: '2222' } }),
    sub({ amount: 5000, card: { brand: 'Visa', last4: '1111' }, status: 'canceled' }),
  ];
  const summary = L.cardSummary(records, cards);
  assert.deepEqual(summary.map((c) => [c.last4, c.label, c.registered, c.count]), [
    ['1111', '신한', true, 2],
    ['2222', 'Mastercard ····2222', false, 1],
  ]);
  assert.deepEqual(summary[0].monthly, { KRW: 20000 });
  assert.deepEqual(summary[1].monthly, { USD: 20 });
});

test('krwTotal converts USD with a rate and keeps what it cannot convert', () => {
  assert.deepEqual(L.krwTotal({ KRW: 13500, USD: 20 }, 1400), { krw: 41500, unconverted: {} });
  assert.deepEqual(L.krwTotal({ KRW: 13500, USD: 20 }, null), { krw: 13500, unconverted: { USD: 20 } });
  assert.deepEqual(L.krwTotal({}, 1400), { krw: 0, unconverted: {} });
});

test('normalizeCard ignores a caller-supplied id and a non-numeric createdAt', () => {
  const card = L.normalizeCard({ id: 'other-card-id', createdAt: { evil: 1 }, last4: '1234' }, NOW);
  assert.notEqual(card.id, 'other-card-id');
  assert.equal(card.createdAt, NOW);
});

test('upsertCard keeps the existing label and brand when the new one is only a default', () => {
  const named = L.normalizeCard({ label: '신한 월급', brand: 'Visa', last4: '1234' }, NOW);
  const bare = L.normalizeCard({ last4: '1234' }, NOW + 1);
  const [kept] = L.upsertCard([named], bare);
  assert.deepEqual([kept.label, kept.brand], ['신한 월급', 'Visa']);
});

test('sanitizeRecord keeps valid fields and drops malformed ones from the dashboard', () => {
  const clean = L.sanitizeRecord({
    ...sub({ note: 'x'.repeat(500), card: { brand: 7, last4: '12' } }),
    site: '  netflix.com ', amount: -5, currency: 'EUR', kind: 'evil', status: 'gone', trial: 'yes',
  });
  assert.equal(clean.site, 'netflix.com');
  assert.equal(clean.amount, null);
  assert.equal(clean.currency, 'KRW');
  assert.equal(clean.kind, 'unknown');
  assert.equal(clean.status, 'active');
  assert.equal(clean.trial, false);
  assert.equal(clean.card, null);
  assert.equal(clean.note.length, 200);
  assert.throws(() => L.sanitizeRecord({ id: 'a', site: '' }), /사이트/);
  const ok = L.sanitizeRecord(sub({ card: { brand: 'Visa', last4: '4242' } }));
  assert.deepEqual(ok.card, { brand: 'Visa', last4: '4242' });
  assert.equal(ok.amount, 10000);
});

// ---- Step 3: 카드별 이번 달 합계 ----
const F = require('../src/lib/forecast.js');
const MNOW = new Date(2026, 10, 14, 15).getTime(); // 11-14 오후
const mday = (d, m = 10) => new Date(2026, m, d).getTime();
const VISA = { brand: 'Visa', last4: '1111' };
const MC = { brand: 'Mastercard', last4: '2222' };
const monthRecords = () => [
  sub({ amount: 10000, card: VISA, startedAt: mday(5, 9) }), // 11-05 나간 돈
  sub({ amount: 20, currency: 'USD', card: MC, startedAt: mday(20, 9) }), // 11-20 나갈 돈
  L.createRecord({ site: 'shop.com', kind: 'one_time', amount: 30000, currency: 'KRW', review: 'confirmed', card: VISA, startedAt: mday(3) }, mday(3)),
  sub({ amount: 7000, card: null, startedAt: mday(25, 9) }), // 카드 미지정, 나갈 돈
  L.createRecord({ site: 'old.com', kind: 'one_time', amount: 999, currency: 'KRW', review: 'confirmed', startedAt: mday(1, 5) }, mday(1, 5)), // 지난 일회성: 제외
  sub({ amount: 5000, card: VISA, review: 'pending' }), // 미확인: 제외
  sub({ amount: 8000, card: VISA, status: 'canceled', canceledAt: mday(1, 8), startedAt: mday(9, 7) }), // 해지: 제외
];

test('cardSummary는 카드별 이번 달 나간 돈·나갈 돈을 구독과 일회성 합쳐 센다', () => {
  const cards = [L.normalizeCard({ label: '신한', brand: 'Visa', last4: '1111' }, NOW)];
  const summary = L.cardSummary(monthRecords(), cards, MNOW);
  const visa = summary.find((c) => c.last4 === '1111');
  const mc = summary.find((c) => c.last4 === '2222');
  assert.deepEqual(visa.paid, { KRW: 40000 });
  assert.deepEqual(visa.due, {});
  assert.deepEqual(visa.thisMonth, { KRW: 40000 });
  assert.deepEqual(mc.due, { USD: 20 });
  assert.equal(mc.registered, false);
  assert.equal(visa.records.length, 2);
  assert.equal(new Date(visa.nextCharge).getDate(), 5);
  assert.equal(new Date(visa.nextCharge).getMonth(), 11);
});

test('카드별 합계의 합 + 카드 미지정 = 홈 이번 달 예상(서버·API 제외)', () => {
  const records = [
    ...monthRecords(),
    // 이번 달 결제된 뒤 이번 달 안에 해지: 카드·미지정 합계에도 들어가야 한다
    sub({ amount: 3000, card: VISA, status: 'canceled', startedAt: mday(5, 9), canceledAt: mday(10) }),
    sub({ amount: 2000, card: null, status: 'canceled', startedAt: mday(6, 9), canceledAt: mday(11) }),
  ];
  const cards = [L.normalizeCard({ label: '신한', brand: 'Visa', last4: '1111' }, NOW)];
  const fx = 1400;
  const home = F.monthForecast(L.summarize(records, MNOW), { now: 0, projected: 0 }, fx).totalKRW;
  const perCard = L.cardSummary(records, cards, MNOW).reduce((sum, c) => sum + L.krwTotal(c.thisMonth, fx).krw, 0);
  const none = L.krwTotal(L.unassignedSummary(records, MNOW).thisMonth, fx).krw;
  assert.equal(perCard + none, home);
  assert.equal(none, 9000);
});

test('unassignedSummary는 카드 없는 확인된 구독·이번 달 일회성만 모은다', () => {
  const u = L.unassignedSummary(monthRecords(), MNOW);
  assert.equal(u.count, 1);
  assert.deepEqual(u.records.map((r) => r.amount), [7000]);
  assert.deepEqual(u.due, { KRW: 7000 });
});

test('사용료 연결로 이미 센 기록(isCovered)은 카드 합계에서도 뺀다', () => {
  const records = monthRecords();
  const isCovered = (r) => r.site === 'shop.com';
  const visa = L.cardSummary(records, [], MNOW, { isCovered }).find((c) => c.last4 === '1111');
  assert.deepEqual(visa.thisMonth, { KRW: 10000 });
});

test('cardSummary 기본 호출(now 생략)도 기존처럼 count·monthly를 준다', () => {
  const [c] = L.cardSummary([sub({ card: VISA })], []);
  assert.equal(c.count, 1);
  assert.deepEqual(c.monthly, { KRW: 10000 });
});
