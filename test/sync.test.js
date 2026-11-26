const test = require('node:test');
const assert = require('node:assert/strict');

const L = require('../src/lib/ledger.js');
const S = require('../src/lib/sync.js');

const QUOTA_BYTES = 102400;
const QUOTA_PER_ITEM = 8192;
const MAX_ITEMS = 512;
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sizeOf = (data) => Object.entries(data).reduce((n, [k, v]) => n + Buffer.byteLength(k + JSON.stringify(v)), 0);

/** chrome.storage 흉내. quota를 주면 sync처럼 한도를 넘는 set 전체를 거절한다. */
function area(quota = false) {
  let data = {};
  const writes = [];
  return {
    writes,
    dump: () => clone(data),
    async get(keys) {
      if (keys == null) return clone(data);
      return Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, clone(data[k])]));
    },
    async set(patch) {
      const next = { ...data, ...clone(patch) };
      if (quota) {
        const tooBig = Object.entries(patch).some(([k, v]) => Buffer.byteLength(k + JSON.stringify(v)) > QUOTA_PER_ITEM);
        if (tooBig || sizeOf(next) > QUOTA_BYTES || Object.keys(next).length > MAX_ITEMS) throw new Error('QUOTA_BYTES quota exceeded');
      }
      writes.push(Object.keys(patch));
      data = next;
    },
    async remove(keys) {
      data = Object.fromEntries(Object.entries(data).filter(([k]) => ![].concat(keys).includes(k)));
    },
  };
}

function setup() {
  const cloud = area(true);
  const clock = { now: T0 };
  const device = () => {
    const local = area();
    const sync = S.createSync({ local, remote: cloud, now: () => clock.now });
    return {
      local,
      sync,
      records: async () => (await local.get('records')).records || [],
      cards: async () => (await local.get('cards')).cards || [],
      settings: async () => (await local.get('settings')).settings,
      put: (records) => local.set({ records }),
    };
  };
  return { cloud, clock, device };
}

const rec = (id, extra = {}) => L.sanitizeRecord({
  id, site: `${id}.com`, kind: 'subscription', cycle: 'monthly', amount: 1000, currency: 'KRW',
  review: 'confirmed', startedAt: T0, createdAt: T0, updatedAt: T0, ...extra,
});
const amounts = async (d) => Object.fromEntries((await d.records()).map((r) => [r.id, r.amount]));

async function paired(records = [rec('a')]) {
  const env = setup();
  const one = env.device();
  const two = env.device();
  await one.put(records);
  await one.sync.enable();
  await two.sync.enable();
  return { ...env, one, two };
}

test('꺼져 있으면 클라우드에 아무것도 올리지 않는다', async () => {
  const { cloud, device } = setup();
  const one = device();
  await one.put([rec('a')]);
  await one.sync.run();
  assert.deepEqual(cloud.dump(), {});
});

test('켜면 올리고, 두 번째 기기는 받는다(자기 기록도 남는다)', async () => {
  const { device } = setup();
  const one = device();
  const two = device();
  await one.put([rec('a')]);
  await two.put([rec('b')]);
  await one.sync.enable();
  await two.sync.enable();
  await one.sync.run();
  assert.deepEqual(Object.keys(await amounts(one)).sort(), ['a', 'b']);
  assert.deepEqual(Object.keys(await amounts(two)).sort(), ['a', 'b']);
});

test('바뀐 게 없으면 다시 쓰지 않는다', async () => {
  const { cloud, one, two } = await paired();
  const before = cloud.writes.length;
  const localBefore = two.local.writes.filter((k) => k.includes('records')).length;
  await one.sync.run();
  await two.sync.run();
  assert.equal(cloud.writes.length, before);
  assert.equal(two.local.writes.filter((k) => k.includes('records')).length, localBefore);
});

test('한쪽에서 고치면 다른 쪽에 반영된다', async () => {
  const { one, two } = await paired();
  await one.put([rec('a', { amount: 2000, updatedAt: T0 + 1 })]);
  await one.sync.run();
  await two.sync.run();
  assert.deepEqual(await amounts(two), { a: 2000 });
});

test('양쪽에서 같은 기록을 고치면 나중에 고친 값이 이긴다', async () => {
  const { one, two } = await paired();
  await one.put([rec('a', { amount: 2000, updatedAt: T0 + 10 })]);
  await two.put([rec('a', { amount: 3000, updatedAt: T0 + 20 })]);
  await one.sync.run();
  await two.sync.run();
  await one.sync.run();
  assert.deepEqual(await amounts(one), { a: 3000 });
  assert.deepEqual(await amounts(two), { a: 3000 });
});

test('삭제가 다른 기기에 전해지고 되살아나지 않는다', async () => {
  const { one, two } = await paired([rec('a'), rec('b')]);
  await one.put([rec('b')]);
  await one.sync.run();
  await two.sync.run();
  await two.sync.run();
  await one.sync.run();
  assert.deepEqual(Object.keys(await amounts(one)), ['b']);
  assert.deepEqual(Object.keys(await amounts(two)), ['b']);
});

test('삭제를 되돌리면 다시 지워지지 않고 양쪽에 돌아온다', async () => {
  const { clock, one, two } = await paired();
  clock.now += DAY;
  await one.put([]);
  await one.sync.run();
  await two.sync.run();
  await one.put([rec('a')]); // 되돌리기: 예전 updatedAt 그대로
  await one.sync.run();
  await two.sync.run();
  assert.deepEqual(await amounts(one), { a: 1000 });
  assert.deepEqual(await amounts(two), { a: 1000 });
});

test('한쪽은 지우고 다른 쪽은 고쳤으면 고친 기록을 살린다', async () => {
  const { one, two } = await paired();
  await one.put([]);
  await two.put([rec('a', { amount: 5000, updatedAt: T0 + 5 })]);
  await one.sync.run();
  await two.sync.run();
  await one.sync.run();
  assert.deepEqual(await amounts(one), { a: 5000 });
  assert.deepEqual(await amounts(two), { a: 5000 });
});

test('카드는 끝 4자리로 한 장이 되고, 삭제도 전해진다', async () => {
  const { device } = setup();
  const one = device();
  const two = device();
  await one.local.set({ cards: [{ id: 'card-1-1234', label: '내 카드', brand: '신한', last4: '1234', createdAt: T0 }] });
  await two.local.set({ cards: [{ id: 'card-2-1234', label: '카드', brand: '신한', last4: '1234', createdAt: T0 - 1 }] });
  await one.sync.enable();
  await two.sync.enable();
  await one.sync.run();
  assert.equal((await one.cards()).length, 1);
  assert.equal((await two.cards()).length, 1);
  await two.local.set({ cards: [] });
  await two.sync.run();
  await one.sync.run();
  assert.deepEqual(await one.cards(), []);
});

test('설정: 새 기기는 클라우드 설정을 받고, 첫 실행 안내 상태는 올리지 않는다', async () => {
  const { cloud, device } = setup();
  const one = device();
  const two = device();
  await one.local.set({ settings: { budgetKRW: 50000, onboarding: { started: true, dismissed: true } } });
  await two.local.set({ settings: { budgetKRW: null, onboarding: { started: false, dismissed: false } } });
  await one.sync.enable();
  await two.sync.enable();
  assert.equal((await two.settings()).budgetKRW, 50000);
  assert.equal((await two.settings()).onboarding.dismissed, false);
  assert.ok(!JSON.stringify(cloud.dump()).includes('onboarding'));
});

test('연결 키 같은 다른 저장 값은 클라우드에 올리지 않는다', async () => {
  const { cloud, device } = setup();
  const one = device();
  await one.put([rec('a')]);
  await one.local.set({ cloudAccounts: [{ secret: 'TOP-SECRET' }], cloudCosts: { x: 'COST' }, accountDismissed: { y: 1 } });
  await one.sync.enable();
  const dumped = JSON.stringify(cloud.dump());
  assert.ok(!dumped.includes('TOP-SECRET') && !dumped.includes('COST') && !dumped.includes('accountDismissed'));
});

test('클라우드의 이상한 값은 건너뛰고 로컬 기록을 지키며, 그 값을 덮어쓰지 않는다', async () => {
  const { cloud, device } = setup();
  await cloud.set({ 'r:bad': { id: 'bad' }, 'r:a': 'garbage', 'c:9999': { last4: 'x' }, s: 7 });
  const one = device();
  await one.put([rec('a')]);
  await one.sync.enable();
  assert.deepEqual(await amounts(one), { a: 1000 });
  assert.equal(cloud.dump()['r:a'], 'garbage');
  assert.deepEqual(await one.cards(), []);
});

test('용량이 넘쳐도 받기는 되고, 이유를 남기고, 로컬 기록은 그대로다', async () => {
  const { device } = setup();
  const one = device();
  const two = device();
  await one.put([rec('a')]);
  await one.sync.enable();
  const many = Array.from({ length: 600 }, (_, i) => rec(`big${i}`));
  await two.put(many);
  const status = await two.sync.enable();
  assert.match(status.error, /용량/);
  assert.equal((await two.records()).length, 601);
});

test('용량이 넘친 상태에서도 삭제는 올라간다', async () => {
  const { cloud, one } = await paired([rec('a'), rec('b')]);
  await one.put([rec('b'), ...Array.from({ length: 600 }, (_, i) => rec(`big${i}`))]);
  await one.sync.run();
  assert.equal(typeof cloud.dump()['r:a'].x, 'number');
});

test('오래된 삭제 표시는 치운다', async () => {
  const { cloud, clock, one } = await paired();
  await one.put([]);
  await one.sync.run();
  assert.ok(cloud.dump()['r:a']);
  clock.now += 91 * DAY;
  await one.sync.run();
  assert.equal(cloud.dump()['r:a'], undefined);
});

test('끄면 더 올리지 않고 클라우드 사본은 남는다', async () => {
  const { cloud, one } = await paired();
  await one.sync.disable();
  await one.put([rec('a', { amount: 9, updatedAt: T0 + 9 })]);
  await one.sync.run();
  assert.equal(cloud.dump()['r:a'].amount, 1000);
});

test('모두 지우기: 클라우드 사본을 지우고, 다른 기기는 동기화를 끄되 기록은 둔다', async () => {
  const { cloud, one, two } = await paired();
  await one.sync.wipeRemote();
  await one.local.set({ records: [], syncState: { enabled: false } });
  assert.ok(!Object.keys(cloud.dump()).some((k) => k.startsWith('r:')));
  const status = await two.sync.run();
  assert.equal(status.enabled, false);
  assert.match(status.error, /다른 기기/);
  assert.deepEqual(await amounts(two), { a: 1000 });
  assert.ok(!Object.keys(cloud.dump()).some((k) => k.startsWith('r:')));
});

test('모두 지운 뒤에도 다시 켜면 정상 동작한다', async () => {
  const { one, two } = await paired();
  await one.sync.wipeRemote();
  await two.sync.run();
  const status = await two.sync.enable();
  assert.equal(status.enabled, true);
  assert.equal(status.error, null);
});

test('클라우드에 우리 데이터가 없으면 wipeRemote는 아무것도 쓰지 않는다', async () => {
  const { cloud, device } = setup();
  await device().sync.wipeRemote();
  assert.deepEqual(cloud.dump(), {});
});

test('모두 지우기의 삭제가 표시보다 먼저 도착해도 다른 기기가 다시 올리지 않는다', async () => {
  const { cloud, one, two } = await paired();
  await cloud.remove(['r:a']);
  await two.sync.run();
  assert.equal(cloud.dump()['r:a'], undefined);
  assert.deepEqual(await amounts(two), { a: 1000 });
});

test('끈 동안 지운 기록은 다시 켜도 되살아나지 않고, 삭제가 전해진다', async () => {
  const { one, two } = await paired();
  await one.sync.disable();
  await one.put([]);
  await one.sync.enable();
  await two.sync.run();
  assert.deepEqual(await amounts(one), {});
  assert.deepEqual(await amounts(two), {});
});

test('클라우드가 통째로 비었으면 다시 켤 때 전부 올린다', async () => {
  const { cloud, one } = await paired();
  await one.sync.disable();
  await cloud.remove(Object.keys(cloud.dump()));
  await one.sync.enable();
  assert.ok(cloud.dump()['r:a']);
});

test('아직 클라우드를 못 받은 새 기기의 기본 설정은 올리지 않는다', async () => {
  const { cloud, device } = setup();
  const fresh = device();
  await fresh.local.set({ settings: { budgetKRW: null, onboarding: { started: true, dismissed: false } } });
  await fresh.sync.enable();
  assert.equal(cloud.dump().s, undefined);
});

test('켠 것보다 먼저 생긴 지우기 표시가 늦게 도착하면 동기화를 끄지 않는다', async () => {
  const { cloud, clock, device } = setup();
  const one = device();
  await one.put([rec('a')]);
  await one.sync.enable();
  await cloud.set({ wiped: { at: clock.now - DAY, id: 'old' } });
  assert.equal((await one.sync.run()).enabled, true);
});

test('크롬이 예전 삭제를 골라 보내도 나중에 고친 기록은 살린다', async () => {
  const { cloud, one } = await paired();
  await one.put([rec('a', { amount: 7000, updatedAt: T0 + 100 })]);
  await one.sync.run();
  await cloud.set({ 'r:a': { x: T0 + 50 } });
  await one.sync.run();
  assert.deepEqual(await amounts(one), { a: 7000 });
  assert.equal(cloud.dump()['r:a'].amount, 7000);
});

test('크롬이 예전 값을 골라 보내도 나중에 고친 값이 남는다', async () => {
  const { cloud, one } = await paired();
  await one.put([rec('a', { amount: 7000, updatedAt: T0 + 100 })]);
  await one.sync.run();
  await cloud.set({ 'r:a': { ...cloud.dump()['r:a'], amount: 5, updatedAt: T0 + 50 } });
  await one.sync.run();
  assert.deepEqual(await amounts(one), { a: 7000 });
});

test('클라우드 항목이 512개로 꽉 차도 모두 지우기가 된다', async () => {
  const { cloud, one } = await paired();
  const used = Object.keys(cloud.dump()).length;
  await cloud.set(Object.fromEntries(Array.from({ length: MAX_ITEMS - used }, (_, i) => [`r:f${i}`, { x: T0 }])));
  await one.sync.wipeRemote();
  assert.deepEqual(Object.keys(cloud.dump()), ['wiped']);
});

test('오래된 삭제 표시를 덮어 되살린 항목은 정리에서 지우지 않는다', async () => {
  const { cloud, clock, one } = await paired();
  await one.put([]);
  await one.sync.run();
  clock.now += 91 * DAY;
  await one.put([rec('a')]);
  await one.sync.run();
  assert.equal(cloud.dump()['r:a'].amount, 1000);
});

test('새 항목이 용량을 넘겨도 이미 올라간 항목의 수정은 올라간다', async () => {
  const { cloud, one } = await paired();
  await one.put([rec('a', { amount: 2, updatedAt: T0 + 1 }), ...Array.from({ length: 600 }, (_, i) => rec(`big${i}`))]);
  await one.sync.run();
  assert.equal(cloud.dump()['r:a'].amount, 2);
});

test('클라우드를 읽지 못하면 이유를 남긴다', async () => {
  const local = area();
  const broken = { get: async () => { throw new Error('offline'); }, set: async () => {}, remove: async () => {} };
  const sync = S.createSync({ local, remote: broken });
  await local.set({ syncState: { enabled: true, base: {} } });
  assert.match((await sync.run()).error, /다시 시도/);
});
