const { test } = require('node:test');
const assert = require('node:assert/strict');
const ST = require('../src/lib/settings.js');
const O = require('../src/lib/onboarding.js');

const settings = (onboarding) => ST.normalizeSettings({ onboarding });

test('설정: 안내 상태는 기본이 꺼짐이고 잘못된 값은 기본값으로 돌린다', () => {
  assert.deepEqual(ST.DEFAULT_SETTINGS.onboarding, { started: false, dismissed: false });
  assert.deepEqual(ST.normalizeSettings({ onboarding: { started: 'yes', dismissed: 1 } }).onboarding, { started: false, dismissed: false });
  assert.deepEqual(ST.normalizeSettings({ onboarding: { started: true, dismissed: true } }).onboarding, { started: true, dismissed: true });
  assert.deepEqual(ST.normalizeSettings({ onboarding: 'x' }).onboarding, { started: false, dismissed: false });
});

test('단계 체크: 기록·카드·연결이 하나라도 있으면 해당 단계가 끝난 것', () => {
  assert.deepEqual(O.steps({ records: [], cards: [], cloudCount: 0 }).map((s) => [s.id, s.done]),
    [['subs', false], ['card', false], ['cloud', false]]);
  assert.deepEqual(O.steps({ records: [{}], cards: [{}], cloudCount: 2 }).map((s) => s.done), [true, true, true]);
  assert.deepEqual(O.steps({ records: undefined, cards: null, cloudCount: undefined }).map((s) => s.done), [false, false, false]);
});

test('안내 카드: 기록이 없으면 보이고, 닫으면 안 보인다', () => {
  assert.equal(O.isVisible({ settings: settings(), records: [] }), true);
  assert.equal(O.isVisible({ settings: settings({ dismissed: true }), records: [] }), false);
});

test('안내 카드: 설치로 시작했으면 기록을 담은 뒤에도 계속 보인다', () => {
  assert.equal(O.isVisible({ settings: settings(), records: [{}] }), false);
  assert.equal(O.isVisible({ settings: settings({ started: true }), records: [{}] }), true);
  assert.equal(O.isVisible({ settings: settings({ started: true, dismissed: true }), records: [{}] }), false);
});

test('설치 직후에는 대시보드를 열고 안내를 시작으로 저장한다', async () => {
  const calls = [];
  await O.handleInstalled({ reason: 'install' }, {
    loadSettings: async () => ({ ...ST.DEFAULT_SETTINGS, budgetKRW: 5000 }),
    saveSettings: async (s) => calls.push(['save', s]),
    openDashboard: async () => calls.push(['open']),
  });
  assert.deepEqual(calls.map((c) => c[0]), ['save', 'open']);
  assert.equal(calls[0][1].onboarding.started, true);
  assert.equal(calls[0][1].budgetKRW, 5000);
});

test('업데이트·브라우저 업데이트 때는 아무것도 열지 않는다', async () => {
  for (const reason of ['update', 'chrome_update', 'shared_module_update', undefined]) {
    const calls = [];
    await O.handleInstalled({ reason }, {
      loadSettings: async () => ST.DEFAULT_SETTINGS,
      saveSettings: async () => calls.push('save'),
      openDashboard: async () => calls.push('open'),
    });
    assert.deepEqual(calls, []);
  }
});

test('저장이 실패해도 대시보드는 연다', async () => {
  const calls = [];
  await O.handleInstalled({ reason: 'install' }, {
    loadSettings: async () => { throw new Error('boom'); },
    saveSettings: async () => {},
    openDashboard: async () => calls.push('open'),
  }, () => {});
  assert.deepEqual(calls, ['open']);
});

test('닫기: 안내를 닫은 설정을 돌려주고 원래 값은 바꾸지 않는다', () => {
  const before = settings({ started: true });
  const after = O.dismissed(before);
  assert.equal(after.onboarding.dismissed, true);
  assert.equal(before.onboarding.dismissed, false);
});
