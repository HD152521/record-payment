'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lib/ledger.js');
const HM = require('../src/lib/home.js');

// 2026-11-26(목) 정오
const NOW = new Date(2026, 10, 26, 12).getTime();
const at = (m, d) => new Date(2026, m, d).getTime();
const sub = (over = {}) => L.createRecord({
  kind: 'subscription', cycle: 'monthly', amount: 13500, currency: 'KRW', review: 'confirmed', userEdited: true,
  site: 'netflix.com', startedAt: at(5, 27), ...over,
}, at(5, 1));

test('shortMoney: 만 원 단위는 "1.3만", 작은 돈은 그대로, 달러는 $', () => {
  assert.equal(HM.shortMoney(13500, 'KRW'), '1.4만');
  assert.equal(HM.shortMoney(23900, 'KRW'), '2.4만');
  assert.equal(HM.shortMoney(100000, 'KRW'), '10만');
  assert.equal(HM.shortMoney(5500, 'KRW'), '5,500');
  assert.equal(HM.shortMoney(20, 'USD'), '$20');
  assert.equal(HM.shortMoney(8.75, 'USD'), '$8.75');
});

test('dayStrip: 오늘부터 14칸, 결제가 있는 날엔 기록과 원화 합계, 가장 큰 날 표시', () => {
  const records = [
    sub({ id: 'a', startedAt: at(5, 27) }), // 매달 27일 → 내일
    sub({ id: 'b', site: 'claude.ai', amount: 20, currency: 'USD', startedAt: at(5, 30) }), // 11/30
    sub({ id: 'c', site: 'youtube.com', amount: 29900, startedAt: at(11, 3) }), // 12/3 (첫 결제)
    sub({ id: 'p', review: 'pending', userEdited: false, startedAt: at(5, 28) }), // 확인 전: 빠짐
    sub({ id: 'x', status: 'canceled', canceledAt: at(9, 1), startedAt: at(5, 29) }), // 해지: 빠짐
  ];
  const strip = HM.dayStrip(records, NOW, { usdKrw: 1400 });
  assert.equal(strip.length, 14);
  assert.equal(strip[0].isToday, true);
  assert.equal(strip[0].weekday, '목');
  assert.equal(strip[0].day, 26);
  assert.deepEqual(strip[1].items.map((i) => i.record.id), ['a']);
  assert.equal(strip[1].krw, 13500);
  assert.equal(strip[4].krw, 28000);
  assert.equal(strip[7].day, 3);
  assert.equal(strip[7].isBiggest, true);
  assert.equal(strip.filter((d) => d.isBiggest).length, 1);
  assert.equal(strip[2].items.length, 0, '확인 전 기록은 안 나온다');
  assert.equal(strip[3].items.length, 0, '해지한 구독은 안 나온다');
  assert.equal(strip[2].isWeekend, true);
  const total = HM.stripTotals(strip);
  assert.deepEqual(total, { count: 3, krw: 13500 + 28000 + 29900 });
});

test('dayStrip: 사용료 연결에 든 기록은 빼고, 기록이 없으면 빈 칸 14개', () => {
  const strip = HM.dayStrip([sub({ id: 'a' })], NOW, { usdKrw: 1400, isCovered: () => true });
  assert.equal(strip.every((d) => d.items.length === 0), true);
  assert.equal(HM.dayStrip([], NOW, {}).length, 14);
  assert.equal(HM.dayStrip([], NOW, {}).some((d) => d.isBiggest), false);
});

test('todoList: 곧 끝나는 무료 체험, 확인할 기록, 카드 안 정한 기록', () => {
  const records = [
    sub({ id: 't', site: 'youtube.com', trial: true, startedAt: at(11, 3), card: { brand: 'Visa', last4: '1234' } }),
    sub({ id: 'far', trial: true, startedAt: at(11, 30) }), // 34일 뒤: 아직
    sub({ id: 'p1', review: 'pending', userEdited: false, site: 'auto.example' }),
    L.createRecord({ id: 'p2', kind: 'one_time', amount: 1000, currency: 'KRW', site: 'shop.example' }, at(10, 20)),
    sub({ id: 'n1', card: null }),
  ];
  const items = HM.todoList(records, NOW);
  assert.deepEqual(items.map((i) => i.kind), ['trial', 'pending', 'nocard']);
  assert.equal(items[0].record.id, 't');
  assert.equal(items[0].days, 7);
  assert.deepEqual(items[1].records.map((r) => r.id).sort(), ['p1', 'p2']);
  assert.equal(items[2].count, 2, '아직 먼 체험(카드 없음) + 카드 없는 구독');
});

test('todoList: 할 일이 없으면 빈 목록', () => {
  assert.deepEqual(HM.todoList([], NOW), []);
  assert.deepEqual(HM.todoList([sub({ card: { brand: 'Visa', last4: '1111' } })], NOW), []);
});

test('budgetPace: 오늘까지 쓸 만한 돈과 남은 날 하루 몫', () => {
  const p = HM.budgetPace(190360, 300000, NOW);
  assert.equal(p.level, 'ok');
  assert.equal(p.left, 109640);
  assert.equal(p.dayShare, 0.87); // 26/30
  assert.equal(p.allowedKRW, 260000);
  assert.equal(p.daysLeft, 4);
  assert.equal(p.perDayKRW, 27410);
  assert.equal(p.usedPct, 63);
  assert.equal(HM.budgetPace(1000, null, NOW), null);
  const over = HM.budgetPace(13500, 10000, NOW);
  assert.equal(over.level, 'over');
  assert.equal(over.perDayKRW, 0);
  assert.equal(over.usedPct, 135);
});

test('chartModel: 달마다 쌓을 칸 비율, 평균선, 비었는지', () => {
  const months = [
    { key: '2026-10', label: '10월', isCurrent: false, parts: { subscription: 60000, one_time: 0, cloud: 40000 }, total: 100000 },
    { key: '2026-11', label: '11월', isCurrent: true, parts: { subscription: 150000, one_time: 50000, cloud: 0 }, total: 200000 },
  ];
  const m = HM.chartModel(months, ['subscription', 'one_time', 'cloud']);
  assert.equal(m.isEmpty, false);
  assert.equal(m.avg, 150000);
  assert.ok(m.max >= 200000);
  const cur = m.bars[1];
  assert.equal(cur.isCurrent, true);
  assert.deepEqual(cur.segs.map((s) => s.key), ['subscription', 'one_time'], '0원 칸은 뺀다');
  assert.equal(Math.round(cur.segs[0].pct + cur.segs[1].pct), Math.round(cur.heightPct));
  assert.ok(m.avgPct > 0 && m.avgPct < 100);
  assert.equal(HM.chartModel([{ key: 'a', label: '1월', isCurrent: true, parts: {}, total: 0 }], []).isEmpty, true);
});

test('shares: 비율을 정수 %로, 합은 100', () => {
  const rows = HM.shares([{ key: 'a', krw: 1 }, { key: 'b', krw: 1 }, { key: 'c', krw: 1 }]);
  assert.equal(rows.reduce((acc, r) => acc + r.pct, 0), 100);
  assert.deepEqual(HM.shares([{ key: 'a', krw: 0 }]).map((r) => r.pct), [0]);
  assert.deepEqual(HM.shares([{ key: 'a', krw: 3 }, { key: 'b', krw: 1 }]).map((r) => r.pct), [75, 25]);
});

test('kindCounts·siteGroups: 이번 달 결제가 있는 구독·일회성 수, 분류별 사이트(큰 순)', () => {
  const records = [
    sub({ id: 'a', site: 'netflix.com' }),
    sub({ id: 'b', site: 'claude.ai', amount: 20, currency: 'USD', startedAt: at(5, 10) }),
    L.createRecord({ id: 'o', kind: 'one_time', amount: 5000, currency: 'KRW', site: 'x.example', review: 'confirmed', startedAt: at(10, 3) }, at(10, 3)),
    L.createRecord({ id: 'o2', kind: 'one_time', amount: 5000, currency: 'KRW', site: 'y.example', review: 'confirmed', startedAt: at(9, 3) }, at(9, 3)),
  ];
  assert.deepEqual(HM.kindCounts(records, NOW), { subscription: 2, one_time: 1 });
  const cat = (r) => ({ 'netflix.com': 'life', 'claude.ai': 'ai' })[r.site] || 'other';
  const groups = HM.siteGroups(records, NOW, { categoryOf: cat, usdKrw: 1400 });
  assert.deepEqual(groups, { life: ['netflix.com'], ai: ['claude.ai'], other: ['x.example'] });
});

test('lastMonthKRW·deltaInfo: 지난달 결제 + 그달 사용료, 비교 문구', () => {
  const records = [sub({ id: 'a', startedAt: at(5, 5) })];
  const cloudHistory = { '2026-10': { a1: { amount: 30, currency: 'USD', final: true } } };
  const last = HM.lastMonthKRW(records, NOW, { usdKrw: 1400, cloudHistory });
  assert.equal(last, 13500 + 42000);
  assert.deepEqual(HM.deltaInfo(13500, 55500), { text: '지난달(55,500원)보다 42,000원 적어요', trend: 'down', diff: -42000 });
  assert.equal(HM.deltaInfo(100, 100).text, '지난달과 같아요');
  assert.equal(HM.deltaInfo(100, 0).text, '');
  assert.equal(HM.deltaInfo(200, 100).trend, 'up');
});

test('coverage: 이번 달은 지금 연결, 지난 달은 그달 사용료 기록으로 판단', () => {
  const aws = L.createRecord({ site: 'aws.amazon.com', kind: 'subscription' });
  const isCovered = HM.coverage(new Set(['aws']), { '2026-10': { a: { provider: 'openai' } } });
  assert.equal(isCovered(aws), true);
  assert.equal(isCovered(aws, { key: '2026-10', isCurrent: false }), false);
  assert.equal(isCovered(aws, { key: '2026-11', isCurrent: true }), true);
});
