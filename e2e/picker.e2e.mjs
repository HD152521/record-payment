// 고르기 화면 + 내 카드 흐름. 카드 등록 → 목록에서 넷플릭스 → 요금제·카드가 채워진 채 저장 → AWS는 연결 화면으로.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.join(ROOT, 'e2e', 'screenshots');

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
await context.route('https://open.er-api.com/**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ rates: { KRW: 1400 } }) }));
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extId = worker.url().split('/')[2];
const stored = (key) => worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k] || [], key);
const errors = [];

try {
  const dash = await context.newPage();
  dash.on('pageerror', (err) => errors.push(err.message));
  await dash.setViewportSize({ width: 1280, height: 900 });
  await dash.goto(`chrome-extension://${extId}/src/dashboard.html`);

  // 1) 카드 등록
  await dash.click('#card-add');
  await dash.fill('#card-form [name=label]', '신한 개인');
  await dash.selectOption('#card-form [name=brand]', 'Visa');
  await dash.fill('#card-form [name=last4]', '4242');
  await dash.click('#card-form button[type=submit]');
  await dash.waitForSelector('#card-list li');
  assert.deepEqual((await stored('cards')).map((c) => [c.label, c.last4]), [['신한 개인', '4242']]);

  // 카드가 한 장뿐이어도, 카드 없이 감지된 기존 기록을 수정할 때는 카드가 저절로 붙지 않는다
  await worker.evaluate(() => chrome.storage.local.set({ records: [{
    id: 'seed-1', site: 'old.example', kind: 'card_registered', cycle: null, amount: null, currency: null,
    card: null, pg: null, trial: false, status: 'active', note: '', userEdited: false, evidence: [],
    startedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }] }));
  await dash.waitForSelector('#rows tr');
  await dash.click('#rows button.link');
  assert.equal(await dash.inputValue('#editor-form [name=cardKey]'), '');
  await dash.click('#editor-form button[type=submit]');
  await dash.waitForFunction(() => !document.querySelector('#editor').open);
  assert.equal((await stored('records'))[0].card, null);
  await worker.evaluate(() => chrome.storage.local.set({ records: [] }));
  await dash.waitForFunction(() => document.querySelectorAll('#rows tr').length === 0);

  // 2) 추가 → 검색 "넷플" → 넷플릭스
  await dash.click('#add-btn');
  await dash.fill('#picker-form [name=q]', '넷플');
  await dash.screenshot({ path: path.join(SHOT_DIR, 'picker-search.png') });
  await dash.click('.picker-item:has-text("Netflix")');
  assert.equal(await dash.inputValue('#editor-form [name=site]'), 'netflix.com');
  assert.equal(await dash.inputValue('#editor-form [name=amount]'), '5500');
  assert.equal(await dash.inputValue('#editor-form [name=cardKey]'), '4242', '카드가 하나면 자동 선택');

  // 요금제를 스탠다드로 바꾸면 금액·메모가 따라 바뀐다
  await dash.selectOption('#editor-form [name=plan]', '1');
  assert.equal(await dash.inputValue('#editor-form [name=amount]'), '13500');
  assert.equal(await dash.inputValue('#editor-form [name=note]'), '스탠다드');
  await dash.screenshot({ path: path.join(SHOT_DIR, 'picker-editor.png') });
  await dash.click('#editor-form button[type=submit]');
  await dash.waitForFunction(() => document.querySelectorAll('#rows tr').length === 1);

  const [rec] = await stored('records');
  assert.equal(rec.site, 'netflix.com');
  assert.equal(rec.amount, 13500);
  assert.equal(rec.cycle, 'monthly');
  assert.deepEqual(rec.card, { brand: 'Visa', last4: '4242' });
  await dash.waitForFunction(() => document.querySelector('#card-list').textContent.includes('13,500원/월'));

  // 3) 새 카드 입력은 "내 카드"에도 저장된다
  await dash.click('#add-btn');
  await dash.click('#picker-cats button:has-text("AI")');
  await dash.click('.picker-item:has-text("Cursor")');
  await dash.selectOption('#editor-form [name=cardKey]', '__new');
  await dash.fill('#editor-form [name=last4]', '1111');
  await dash.click('#editor-form button[type=submit]');
  await dash.waitForFunction(() => document.querySelectorAll('#card-list li').length === 2);
  assert.ok((await stored('cards')).some((c) => c.last4 === '1111'));

  // 달러 구독은 원화로 합친다: 13,500 + 20 × 1,400 = 41,500
  await dash.waitForFunction(() => document.querySelector('#monthly-total').textContent === '41,500원');
  assert.match(await dash.textContent('#all-total'), /달러 구독 \$20\.00 포함/);
  assert.equal(await dash.isVisible('#last4-row'), false);

  // 4) AWS는 기록 양식이 아니라 연결 화면으로
  await dash.click('#add-btn');
  await dash.fill('#picker-form [name=q]', 'aws');
  await dash.click('.picker-item:has-text("AWS")');
  assert.ok(await dash.isVisible('#cloud-dialog'));
  assert.equal(await dash.isChecked('#cloud-form input[value=aws]'), true);
  await dash.click('#cloud-cancel');

  await dash.screenshot({ path: path.join(SHOT_DIR, 'picker-dashboard.png'), fullPage: true });
  await dash.setViewportSize({ width: 375, height: 800 });
  await dash.click('#add-btn');
  await dash.screenshot({ path: path.join(SHOT_DIR, 'picker-mobile.png') });

  assert.deepEqual(errors, []);
  process.stdout.write('picker e2e ok\n');
} finally {
  await context.close();
}
