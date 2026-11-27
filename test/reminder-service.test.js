'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function load(permission) {
  const created = [];
  globalThis.chrome = {
    runtime: { getURL: (p) => p },
    notifications: {
      getPermissionLevel: async () => permission,
      create: async (id, options) => { created.push({ id, options }); return id; },
    },
  };
  delete require.cache[require.resolve('../src/reminder-service.js')];
  require('../src/reminder-service.js');
  return { service: globalThis.PaymentReminderService, created };
}

test('알림 미리 보기는 허용돼 있으면 알림을 하나 만든다', async () => {
  const { service, created } = load('granted');
  assert.deepEqual(await service.sendTest(), { ok: true });
  assert.equal(created.length, 1);
});

test('크롬이 알림을 막아 두었으면 보냈다고 하지 않고 이유를 알려 준다', async () => {
  const { service, created } = load('denied');
  await assert.rejects(service.sendTest(), /알림이 막혀/);
  assert.equal(created.length, 0);
});
