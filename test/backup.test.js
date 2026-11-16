const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lib/ledger.js');
globalThis.PaymentLedger = L;
const ST = require('../src/lib/settings.js');
globalThis.PaymentSettings = ST;
const B = require('../src/lib/backup.js');

const NOW = new Date(2026, 10, 12).getTime();
const record = L.createRecord({ id: 'r1', site: 'netflix.com', kind: 'subscription', cycle: 'monthly', amount: 13500, currency: 'KRW', review: 'confirmed' }, NOW);
const card = { id: 'card-1', label: '신한', brand: 'Visa', last4: '4242', createdAt: NOW };

test('백업에는 기록·카드·설정만 들어가고 연결 키는 들어가지 않는다', () => {
  const json = B.buildBackup({ records: [record], cards: [card], settings: { budgetKRW: 100000 }, cloudAccounts: [{ secret: 'x' }] }, NOW);
  const data = JSON.parse(json);
  assert.equal(data.app, 'payment-tracker');
  assert.equal(data.version, 1);
  assert.deepEqual(Object.keys(data).sort(), ['app', 'cards', 'exportedAt', 'records', 'settings', 'version']);
  assert.ok(!json.includes('secret'));
});

test('백업을 다시 읽으면 같은 기록·카드·설정이 나온다', () => {
  const parsed = B.parseBackup(B.buildBackup({ records: [record], cards: [card], settings: { budgetKRW: 100000 } }, NOW));
  assert.equal(parsed.records[0].site, 'netflix.com');
  assert.equal(parsed.cards[0].last4, '4242');
  assert.equal(parsed.settings.budgetKRW, 100000);
  assert.equal(parsed.skipped, 0);
});

test('이상한 기록은 건너뛰고 몇 개 건너뛰었는지 알려 준다', () => {
  const text = JSON.stringify({ app: 'payment-tracker', version: 1, records: [record, { id: '' }, 'x'], cards: [{ last4: 'abcd' }] });
  const parsed = B.parseBackup(text);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.cards.length, 0);
  assert.equal(parsed.skipped, 3);
});

test('다른 앱 파일·깨진 파일·너무 큰 파일은 거절한다', () => {
  assert.throws(() => B.parseBackup('{not json'), /백업 파일/);
  assert.throws(() => B.parseBackup(JSON.stringify({ app: 'other', records: [] })), /결제 기록장 백업/);
  assert.throws(() => B.parseBackup(JSON.stringify({ app: 'payment-tracker', version: 1, records: Array(B.MAX_RECORDS + 1).fill(record) })), /너무 많/);
});

test('가져오기는 같은 id 기록을 새 값으로 바꾸고 나머지는 남긴다', () => {
  const other = { ...record, id: 'r2', site: 'b.com' };
  const merged = B.mergeById([record, other], [{ ...record, amount: 9900 }]);
  assert.deepEqual(merged.map((r) => [r.id, r.amount]), [['r1', 9900], ['r2', 13500]]);
});

test('백업에는 결제 페이지 주소의 쿼리·조각이 빠지고 origin만 남는다', () => {
  const withUrl = { ...record, siteUrl: 'https://pay.example.com/checkout?session=SECRET#token=X' };
  const json = B.buildBackup({ records: [withUrl] }, NOW);
  assert.ok(!json.includes('SECRET'));
  assert.equal(JSON.parse(json).records[0].siteUrl, 'https://pay.example.com');
  assert.equal(L.originOnly('javascript:alert(1)'), undefined);
});

test('가져온 파일 안의 같은 id는 하나만 남고, 합쳐서 너무 많으면 거절한다', () => {
  const merged = B.mergeById([], [{ ...record, amount: 1 }, { ...record, amount: 2 }]);
  assert.deepEqual(merged.map((r) => r.amount), [2]);
  const many = Array.from({ length: B.MAX_RECORDS }, (_, i) => ({ ...record, id: `x${i}` }));
  assert.throws(() => B.mergeById(many, [{ ...record, id: 'new' }]), /넘어서/);
});
