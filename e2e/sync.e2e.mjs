// 실제 Chromium에서 동기화 켜기·올리기·받기·삭제·모두 지우기를 확인한다.
// 기기 두 대 사이의 전송(구글 서버)은 흉내 낼 수 없어서, 다른 기기의 변경은 storage.sync에 직접 써서 재현한다.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
await context.route('https://*/**', (route) => route.fulfill({ status: 404 }));
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extId = worker.url().split('/')[2];
const area = (name) => worker.evaluate((n) => chrome.storage[n].get(null), name);

async function until(check, label) {
  for (let i = 0; i < 60; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`시간 초과: ${label}`);
}

try {
  assert.equal(extId, 'pegbceebehidemhlhjjfepaphbkaaleg', 'manifest key로 확장 ID가 고정된다');
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${extId}/src/dashboard.html#settings`);
  const record = { id: 'e2e-a', site: 'a.com', kind: 'subscription', cycle: 'monthly', amount: 1000, currency: 'KRW', review: 'confirmed' };
  await page.evaluate((r) => chrome.runtime.sendMessage({ type: 'upsert', record: r }), record);
  await worker.evaluate(() => chrome.storage.local.set({ cloudAccounts: [{ secret: 'TOP-SECRET' }] }));
  assert.deepEqual(await area('sync'), {}, '켜기 전에는 올리지 않는다');

  await page.check('#sync-enabled');
  await until(async () => (await area('sync'))['r:e2e-a'], '올리기');
  await until(async () => /마지막 동기화/.test(await page.textContent('#sync-status')), '상태 표시');
  assert.ok(!JSON.stringify(await area('sync')).includes('TOP-SECRET'));

  // 다른 기기에서 새 기록이 온 상황
  await worker.evaluate((r) => chrome.storage.sync.set({ 'r:e2e-b': { ...r, id: 'e2e-b', site: 'b.com' } }), record);
  await until(async () => (await area('local')).records.some((r) => r.id === 'e2e-b'), '받기');

  // 이 기기에서 지우면 삭제 표시가 올라간다
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'delete', id: 'e2e-a' }));
  await until(async () => typeof (await area('sync'))['r:e2e-a']?.x === 'number', '삭제 올리기');

  const wiped = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'wipe' }));
  assert.equal(wiped.ok, true);
  await new Promise((r) => setTimeout(r, 4500));
  assert.deepEqual(Object.keys(await area('sync')), ['wiped']);
  assert.equal((await area('local')).records, undefined);
  assert.deepEqual(errors, []);
  console.log('동기화 E2E 통과');
} finally {
  await context.close();
}
