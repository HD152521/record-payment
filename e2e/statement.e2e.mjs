// 카드 이용내역 가져오기: 가짜 CSV → 반복 결제 후보 → 확인할 기록. 파일을 읽는 동안 외부 요청 0건, 원문은 저장 안 됨.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => path.join(ROOT, 'test', 'fixtures', name);
const context = await chromium.launchPersistentContext('', {
  reducedMotion: 'reduce', // 금액 카운트업이 끝나기 전 글자를 읽지 않게
  channel: 'chromium',
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
await context.route('https://open.er-api.com/**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ rates: { KRW: 1400 } }) }));
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extId = worker.url().split('/')[2];
const errors = [];
const outside = [];

const records = () => worker.evaluate(() => chrome.storage.local.get('records').then((s) => s.records || []));

try {
  await worker.evaluate(() => chrome.storage.local.set({
    cards: [{ id: 'c1', label: '내 신한', brand: 'Visa', last4: '4242', createdAt: 1 }],
    cloudMeta: { usdKrw: 1400, fxAt: Date.now() },
  }));
  const dash = await context.newPage();
  dash.on('pageerror', (err) => errors.push(err.message));
  await dash.setViewportSize({ width: 1280, height: 900 });
  await dash.goto(`chrome-extension://${extId}/src/dashboard.html#settings`);
  await dash.waitForSelector('#stmt-file', { state: 'attached' });
  dash.on('request', (req) => { if (!req.url().startsWith('chrome-extension://') && !req.url().startsWith('data:')) outside.push(req.url()); });

  // 1) 신한 양식: 넷플릭스 후보 하나, 내 카드(4242)와 연결, 체크하고 넣기
  await dash.setInputFiles('#stmt-file', fixture('shinhan.csv'));
  await dash.waitForSelector('#stmt-panel .stmt-list li');
  assert.match(await dash.textContent('#stmt-panel'), /신한카드 양식으로 읽었어요/);
  assert.equal(await dash.locator('#stmt-panel .stmt-list li').count(), 1);
  assert.match(await dash.textContent('#stmt-panel .stmt-list'), /netflix\.com[\s\S]*15,000원 \/ 월[\s\S]*····4242/);
  await dash.click('#stmt-panel .btn:has-text("확인할 기록으로 넣기")');
  await dash.waitForFunction(() => document.querySelector('#stmt-panel').hidden);
  let saved = await records();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].review, 'pending');
  assert.equal(saved[0].site, 'netflix.com');
  assert.deepEqual(saved[0].card, { brand: 'Visa', last4: '4242' });

  // 2) 같은 파일을 다시 올리면 겹치는 기록이라 넣지 않는다
  await dash.setInputFiles('#stmt-file', fixture('shinhan.csv'));
  await dash.waitForSelector('#stmt-panel');
  assert.match(await dash.textContent('#stmt-panel'), /이미 있는 1개는 뺐어요/);
  assert.equal(await dash.locator('#stmt-panel .stmt-list').count(), 0);
  await dash.click('#stmt-panel .btn:has-text("닫기")');
  assert.equal((await records()).length, 1);

  // 3) 모르는 양식: 열 고르기
  await dash.setInputFiles('#stmt-file', fixture('unknown.csv'));
  await dash.waitForSelector('#stmt-panel form.stmt-pick');
  await dash.selectOption('select[name=date]', '1');
  await dash.selectOption('select[name=merchant]', '2');
  await dash.selectOption('select[name=amount]', '3');
  await dash.click('#stmt-panel button:has-text("이 열로 읽기")');
  await dash.waitForSelector('#stmt-panel .stmt-list li');
  assert.match(await dash.textContent('#stmt-panel .stmt-list'), /가짜클라우드/);
  await dash.click('#stmt-panel .btn:has-text("확인할 기록으로 넣기")');
  await dash.waitForFunction(() => document.querySelector('#stmt-panel').hidden);
  saved = await records();
  assert.equal(saved.length, 2);
  assert.ok(saved.every((r) => r.review === 'pending'));

  // 4) 파일 내용은 저장되지 않고, 외부 요청도 없다
  const everything = JSON.stringify(await worker.evaluate(() => chrome.storage.local.get(null)));
  for (const secret of ['가짜식당', '9999-', '가짜서점', '가짜빵집']) assert.ok(!everything.includes(secret), `${secret} 저장됨`);
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  process.stdout.write('statement e2e ok\n');
} finally {
  await context.close();
}
