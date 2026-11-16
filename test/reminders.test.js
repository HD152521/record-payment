const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lib/ledger.js');
const R = require('../src/lib/reminders.js');
const ST = require('../src/lib/settings.js');

const NOW = new Date(2026, 10, 12, 9).getTime(); // 2026-11-12 09:00
const day = (m, d, y = 2026) => new Date(y, m - 1, d).getTime();
const rec = (fields) => L.createRecord({
  id: 'r1', site: 'netflix.com', kind: 'subscription', cycle: 'monthly', amount: 13500, currency: 'KRW',
  review: 'confirmed', startedAt: day(10, 13), ...fields,
}, day(10, 1));

test('결제일이 알림 기간 안에 들면 한 번 알려 준다', () => {
  const due = R.dueReminders([rec({})], NOW, { daysBefore: 1, sent: {} });
  assert.equal(due.length, 1);
  assert.equal(due[0].key, 'r1:2026-11-13');
  assert.match(due[0].title, /내일/);
  assert.match(due[0].message, /netflix\.com/);
  assert.match(due[0].message, /13,500원/);
});

test('이미 알린 결제일은 다시 알리지 않는다', () => {
  assert.equal(R.dueReminders([rec({})], NOW, { daysBefore: 1, sent: { 'r1:2026-11-13': NOW } }).length, 0);
});

test('알림 기간 밖, 확인 대기, 해지한 구독은 알리지 않는다', () => {
  const list = [
    rec({ id: 'far', startedAt: day(10, 20) }),
    rec({ id: 'pending', review: 'pending' }),
    rec({ id: 'gone', status: 'canceled', canceledAt: day(11, 1) }),
  ];
  assert.deepEqual(R.dueReminders(list, NOW, { daysBefore: 1, sent: {} }), []);
});

test('오늘 결제일이면 "오늘", 무료 체험이면 체험 끝난다고 알린다', () => {
  const [today] = R.dueReminders([rec({ startedAt: day(11, 12, 2026) + 23 * 3600e3 })], NOW, { daysBefore: 0, sent: {} });
  assert.match(today.title, /오늘/);
  const [trial] = R.dueReminders([rec({ trial: true, startedAt: day(11, 14) })], NOW, { daysBefore: 3, sent: {} });
  assert.match(trial.title, /체험/);
  assert.match(trial.title, /2일 뒤/);
});

test('보낸 기록은 40일 지난 것부터 지운다', () => {
  const sent = { old: NOW - 41 * 864e5, fresh: NOW - 2 * 864e5 };
  assert.deepEqual(Object.keys(R.pruneSent(sent, NOW)), ['fresh']);
});

test('설정은 범위 밖 값을 기본값으로 되돌린다', () => {
  assert.deepEqual(ST.normalizeSettings(undefined), ST.DEFAULT_SETTINGS);
  assert.deepEqual(ST.normalizeSettings({ budgetKRW: '150000', remind: { enabled: true, daysBefore: 3 } }),
    { budgetKRW: 150000, remind: { enabled: true, daysBefore: 3 } });
  assert.deepEqual(ST.normalizeSettings({ budgetKRW: -5, remind: { enabled: 'yes', daysBefore: 99 } }),
    { budgetKRW: null, remind: { enabled: false, daysBefore: 1 } });
});

test('예산 상태는 80% 넘으면 주의, 100% 넘으면 초과', () => {
  assert.equal(ST.budgetState(50000, null), null);
  assert.deepEqual(ST.budgetState(50000, 100000), { ratio: 0.5, level: 'ok', left: 50000 });
  assert.equal(ST.budgetState(85000, 100000).level, 'warn');
  assert.deepEqual(ST.budgetState(120000, 100000), { ratio: 1.2, level: 'over', left: -20000 });
});
