// 첫 실행 안내: 설치 직후 대시보드가 열리고 안내 카드가 보인다 → 구독을 담으면 1단계 체크 → 닫으면 새로고침해도 안 뜬다.
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
await context.route('https://open.er-api.com/**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ rates: { KRW: 1400 } }) }));
const errors = [];

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extId = worker.url().split('/')[2];
  const dashUrl = (p) => p.url().startsWith(`chrome-extension://${extId}/src/dashboard.html`);

  // 1) 설치 직후 대시보드 탭이 저절로 열린다
  const deadline = Date.now() + 15000;
  while (!context.pages().some(dashUrl) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  const dash = context.pages().find(dashUrl);
  assert.ok(dash, '설치 직후 대시보드가 열려야 해요');
  dash.on('pageerror', (err) => errors.push(err.message));
  await dash.setViewportSize({ width: 1280, height: 900 });
  await dash.reload();
  await dash.waitForSelector('#onboarding:not([hidden])');
  assert.equal(await dash.locator('#onboarding-steps li').count(), 3);
  assert.equal(await dash.locator('#onboarding-steps li.is-done').count(), 0);

  // 2) 구독 하나를 담으면 1단계가 체크되고 카드는 남아 있다
  await dash.click('#onboarding-steps li[data-step=subs] button');
  await dash.waitForSelector('#picker[open]');
  await dash.fill('#picker-form [name=q]', '미드저니');
  await dash.locator('#picker-list .picker-item').first().click();
  await dash.click('#picker-submit');
  await dash.waitForFunction(() => !document.querySelector('#picker').open);
  await dash.waitForSelector('#onboarding-steps li[data-step=subs].is-done');
  assert.equal(await dash.locator('#onboarding').isVisible(), true);

  // 3) 카드 단계 버튼은 카드 등록 창을 연다
  await dash.click('#onboarding-steps li[data-step=card] button');
  await dash.waitForSelector('#card-dialog[open]');
  await dash.click('#card-cancel');

  // 4) 닫은 뒤 새로고침해도 안 뜬다
  await dash.click('#onboarding-dismiss');
  await dash.waitForSelector('#onboarding', { state: 'hidden' });
  await dash.reload();
  await dash.waitForSelector('#monthly-total');
  await dash.waitForFunction(() => globalThis.PaymentDashboard.getRecords().length > 0);
  assert.equal(await dash.locator('#onboarding').isVisible(), false);

  // 5) 업데이트(reason update)는 대시보드를 열지 않는다
  const before = context.pages().length;
  const opened = await worker.evaluate(async () => {
    let called = false;
    await PaymentOnboarding.handleInstalled({ reason: 'update' }, {
      loadSettings: async () => PaymentSettings.DEFAULT_SETTINGS, saveSettings: async () => {}, openDashboard: async () => { called = true; },
    });
    return called;
  });
  assert.equal(opened, false);
  assert.equal(context.pages().length, before);

  assert.deepEqual(errors, []);
  console.error('onboarding e2e ok');
} finally {
  await context.close();
}
