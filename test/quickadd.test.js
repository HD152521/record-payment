const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lib/ledger.js');
const K = require('../src/lib/catalog.js');
const Q = require('../src/lib/quickadd.js');

const day = (m, d, y = 2026) => new Date(y, m - 1, d, 0, 0, 0).getTime();
const NOW = new Date(2026, 10, 14, 15, 30).getTime(); // 2026-11-14 오후
const item = (id) => K.ITEMS.find((i) => i.id === id);
const sub = (fields) => L.createRecord({ site: 'x.com', kind: 'subscription', cycle: 'monthly', amount: 1, currency: 'KRW', review: 'confirmed', ...fields }, day(10, 1));

test('결제일 고르기: 오늘·어제·이번 달 1일을 자정 기준으로 준다', () => {
  const choices = Q.dateChoices(NOW);
  assert.deepEqual(choices.map((c) => [c.id, c.label, c.ts]), [
    ['today', '오늘', day(11, 14)],
    ['yesterday', '어제', day(11, 13)],
    ['first', '이번 달 1일', day(11, 1)],
  ]);
});

test('결제일 고르기: 같은 날이 겹치면 한 번만 보여 준다', () => {
  assert.deepEqual(Q.dateChoices(day(11, 1) + 5000).map((c) => c.id), ['today', 'yesterday']);
  assert.deepEqual(Q.dateChoices(day(11, 2) + 5000).map((c) => c.id), ['today', 'yesterday']);
});

test('먼저 고를 카드: 사용 중인 구독에 가장 많이 쓴 카드', () => {
  const records = [
    sub({ card: { brand: 'Visa', last4: '1111' } }),
    sub({ card: { brand: 'Visa', last4: '2222' } }),
    sub({ card: { brand: 'Visa', last4: '2222' } }),
    sub({ card: { brand: 'Visa', last4: '1111' }, status: 'canceled', canceledAt: day(10, 2) }),
  ];
  assert.equal(Q.preferredCard(records, []), '2222');
});

test('먼저 고를 카드: 확인 대기 중인(자동 감지) 기록의 카드는 세지 않는다', () => {
  const records = [sub({ card: { brand: 'Visa', last4: '9999' }, review: 'pending' })];
  assert.equal(Q.preferredCard(records, [{ last4: '4242' }]), '4242');
  assert.equal(Q.preferredCard(records, []), null);
});

test('먼저 고를 카드: 기록이 없으면 등록한 카드가 한 장일 때만 그 카드', () => {
  assert.equal(Q.preferredCard([], [{ last4: '4242' }]), '4242');
  assert.equal(Q.preferredCard([], [{ last4: '4242' }, { last4: '5555' }]), null);
  assert.equal(Q.preferredCard([], []), null);
});

test('여러 개를 한 번에: 고른 요금제로 금액·주기를 채우고 확인된 기록으로 만든다', () => {
  const records = Q.buildRecords([
    { item: item('netflix'), planIndex: 1 },
    { item: item('cursor'), planIndex: 0 },
  ], { card: { brand: 'Visa', last4: '4242' }, startedAt: day(11, 1), now: NOW });
  assert.equal(records.length, 2);
  const [netflix, cursor] = records;
  const plan = item('netflix').plans[1];
  assert.equal(netflix.site, 'netflix.com');
  assert.equal(netflix.amount, plan.amount);
  assert.equal(netflix.currency, plan.currency);
  assert.equal(netflix.note, plan.name);
  assert.equal(netflix.kind, 'subscription');
  assert.equal(netflix.review, 'confirmed');
  assert.equal(netflix.userEdited, true);
  assert.equal(netflix.startedAt, day(11, 1));
  assert.deepEqual(netflix.card, { brand: 'Visa', last4: '4242' });
  assert.equal(cursor.amount, 20);
  assert.notEqual(netflix.id, cursor.id);
});

test('요금제가 없는 곳은 넣은 금액을 쓰고, 없으면 금액 없이 만든다', () => {
  const [gcp, ncloud] = Q.buildRecords([
    { item: item('gcp'), amount: '12.5' },
    { item: item('ncloud'), amount: '' },
  ], { card: null, startedAt: day(11, 14), now: NOW });
  assert.equal(gcp.amount, 12.5);
  assert.equal(gcp.currency, 'USD');
  assert.equal(ncloud.amount, null);
  assert.equal(ncloud.currency, 'KRW');
  assert.equal(gcp.card, null);
});

test('잘못된 금액·너무 많은 선택은 받지 않는다', () => {
  const [bad] = Q.buildRecords([{ item: item('gcp'), amount: '-3' }], { card: null, startedAt: day(11, 1), now: NOW });
  assert.equal(bad.amount, null);
  const many = Array.from({ length: Q.MAX_BATCH + 1 }, () => ({ item: item('gcp') }));
  assert.throws(() => Q.buildRecords(many, { card: null, startedAt: day(11, 1), now: NOW }), /한 번에/);
});
