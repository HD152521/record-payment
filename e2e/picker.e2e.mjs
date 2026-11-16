// 빠른 추가 + 내 카드 흐름. 카드 등록 → 여러 곳을 골라 칩으로 요금제·카드·결제일 → 한 번에 저장(되돌리기) → AWS는 연결 화면으로.
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
  const checked = (formSel, name) => dash.evaluate(([f, n]) => {
    const input = document.querySelector(`${f} input[name="${n}"]:checked`);
    return input ? input.value : null;
  }, [formSel, name]);
  await dash.setViewportSize({ width: 1280, height: 900 });
  await dash.goto(`chrome-extension://${extId}/src/dashboard.html#cards`);

  // 1) 카드 등록
  await dash.click('#card-add');
  await dash.fill('#card-form [name=last4]', '4242');
  await dash.click('#card-form label:has(input[name=brand][value=Visa])');
  await dash.fill('#card-form [name=label]', '신한 개인');
  assert.equal(await dash.textContent('#card-preview-last4'), '4242');
  await dash.screenshot({ path: path.join(SHOT_DIR, 'card-dialog.png') });
  await dash.click('#card-form button[type=submit]');
  await dash.waitForSelector('#card-list li');
  assert.deepEqual((await stored('cards')).map((c) => [c.label, c.last4]), [['신한 개인', '4242']]);

  // 카드가 한 장뿐이어도, 카드 없이 감지된 기존 기록을 수정할 때는 카드가 저절로 붙지 않는다
  await worker.evaluate(() => chrome.storage.local.set({ records: [{
    id: 'seed-1', site: 'old.example', kind: 'card_registered', cycle: null, amount: null, currency: null,
    card: null, pg: null, trial: false, status: 'active', note: '', userEdited: false, evidence: [],
    startedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }] }));
  await dash.click('#tabs a[data-page=records]');
  await dash.waitForSelector('#rows tr');
  await dash.click('#rows button.link');
  assert.equal(await checked('#editor-form', 'cardKey'), '');
  await dash.click('#editor-form button[type=submit]');
  await dash.waitForFunction(() => !document.querySelector('#editor').open);
  assert.equal((await stored('records'))[0].card, null);
  await worker.evaluate(() => chrome.storage.local.set({ records: [] }));
  await dash.waitForFunction(() => document.querySelectorAll('#rows tr').length === 0);

  // 2) 하나만 담고 "되돌리기": 추가한 기록이 다시 사라진다
  await dash.click('#add-btn');
  await dash.fill('#picker-form [name=q]', '미드저니');
  await dash.click('.picker-item:has-text("Midjourney")');
  await dash.click('#picker-submit');
  await dash.waitForFunction(() => document.querySelectorAll('#rows tr').length === 1);
  await dash.click('.toast-action');
  await dash.waitForFunction(() => document.querySelectorAll('#rows tr').length === 0);
  assert.deepEqual(await stored('records'), []);

  // 열린 시트 위에도 오류 알림이 맨 위 층(popover)으로 뜬다: "날짜 고르기"를 누르고 날짜를 비우면
  await dash.click('#add-btn');
  await dash.fill('#picker-form [name=q]', '미드저니');
  await dash.click('.picker-item:has-text("Midjourney")');
  await dash.click('#tray-dates label:has(input[value=custom])');
  await dash.fill('#picker-form [name=trayDate]', '');
  await dash.click('#picker-submit');
  await dash.waitForFunction(() => document.querySelector('#toaster').matches(':popover-open'));
  assert.match(await dash.textContent('#toaster'), /첫 결제일을 골라 주세요/);
  await dash.click('#picker-cancel');
  assert.deepEqual(await stored('records'), []);

  // 3) 여러 개를 한 번에: 넷플릭스(스탠다드) + Cursor, 카드는 한 장뿐이라 미리 골라져 있다
  await dash.click('#add-btn');
  await dash.fill('#picker-form [name=q]', '넷플');
  await dash.screenshot({ path: path.join(SHOT_DIR, 'picker-search.png') });
  await dash.click('.picker-item:has-text("Netflix")');
  await dash.fill('#picker-form [name=q]', '');
  await dash.click('#picker-cats button:has-text("AI")');
  await dash.click('.picker-item:has-text("Cursor")');
  assert.equal(await dash.textContent('#picker-submit'), '2개 추가');
  assert.equal(await checked('#picker-form', 'trayCard'), '4242', '카드가 하나면 미리 고른다');
  await dash.click('#tray-list label:has(input[name=plan-netflix][value="1"])');
  await dash.screenshot({ path: path.join(SHOT_DIR, 'picker-tray.png') });
  await dash.click('#picker-submit');
  await dash.waitForFunction(() => document.querySelectorAll('#rows tr').length === 2);
  const added = await stored('records');
  const netflix = added.find((r) => r.site === 'netflix.com');
  const cursor = added.find((r) => r.site === 'cursor.com');
  assert.deepEqual([netflix.amount, netflix.cycle, netflix.note, netflix.review], [13500, 'monthly', '스탠다드', 'confirmed']);
  assert.deepEqual(netflix.card, { brand: 'Visa', last4: '4242' });
  assert.deepEqual([cursor.amount, cursor.currency], [20, 'USD']);
  await dash.waitForFunction(() => document.querySelector('#card-list').textContent.includes('13,500원/월'));

  // 4) 하나만 담고 "자세히 입력": 요금제가 채워진 양식, 요금제 칩을 바꾸면 금액·메모가 따라 바뀐다
  await dash.click('#add-btn');
  await dash.fill('#picker-form [name=q]', '넷플');
  await dash.click('.picker-item:has-text("Netflix")');
  await dash.click('#picker-manual');
  assert.equal(await dash.inputValue('#editor-form [name=site]'), 'netflix.com');
  assert.equal(await dash.inputValue('#editor-form [name=amount]'), '5500');
  assert.equal(await checked('#editor-form', 'cardKey'), '4242', '자주 쓰는 카드를 미리 고른다');
  await dash.click('#plan-chips label:has(input[value="1"])');
  assert.equal(await dash.inputValue('#editor-form [name=amount]'), '13500');
  assert.equal(await dash.inputValue('#editor-form [name=note]'), '스탠다드');
  await dash.screenshot({ path: path.join(SHOT_DIR, 'picker-editor.png') });
  await dash.click('#cancel-btn');

  // 5) 수정 양식의 "새 카드"는 "내 카드"에도 저장된다
  await dash.click('#tabs a[data-page=records]');
  await dash.locator('#rows tr', { hasText: 'cursor.com' }).getByRole('button', { name: '수정' }).click();
  await dash.click('#card-chips label:has(input[value=__new])');
  await dash.fill('#editor-form [name=last4]', '1111');
  await dash.click('#editor-form button[type=submit]');
  await dash.waitForFunction(() => document.querySelectorAll('#card-list li').length === 2);
  assert.ok((await stored('cards')).some((c) => c.last4 === '1111'));

  // 이번 달 결제일이 든 달러 구독도 원화로 합친다: 13,500 + 20 × 1,400 = 41,500
  await dash.waitForFunction(() => document.querySelector('#monthly-total').textContent === '41,500원');
  assert.match(await dash.textContent('#all-total'), /달러 결제 \$20\.00 포함/);
  // 실시간 환율을 못 받아도 "0원 + $20.00"이 아니라 참고 환율로 원화에 합친다
  await worker.evaluate(() => chrome.storage.local.set({ cloudMeta: { fxTriedAt: Date.now() } }));
  await dash.waitForFunction(() => /참고 환율/.test(document.querySelector('#all-total').textContent));
  assert.equal(await dash.textContent('#monthly-total'), '41,500원');
  assert.doesNotMatch(await dash.textContent('#yearly-total'), /\+/);
  assert.equal(await dash.isVisible('#last4-row'), false);

  // 6) AWS는 담지 않고 연결 화면으로
  await dash.click('#add-btn');
  await dash.fill('#picker-form [name=q]', 'aws');
  await dash.click('.picker-item:has-text("AWS")');
  assert.ok(await dash.isVisible('#cloud-dialog'));
  assert.equal(await dash.isChecked('#cloud-form input[value=aws]'), true);
  await dash.click('#cloud-cancel');

  await dash.click('#tabs a[data-page=home]');
  await dash.screenshot({ path: path.join(SHOT_DIR, 'picker-dashboard.png'), fullPage: true });
  await dash.setViewportSize({ width: 375, height: 800 });
  await dash.screenshot({ path: path.join(SHOT_DIR, 'dashboard-mobile.png'), fullPage: true });
  await dash.click('#add-btn');
  await dash.screenshot({ path: path.join(SHOT_DIR, 'picker-mobile.png') });
  await dash.click('#picker-cancel');
  await dash.setViewportSize({ width: 1280, height: 900 });

  // 7) 모든 데이터 지우기: "지우기"를 입력해야만 버튼이 켜지고, 지우면 기록·카드·연결이 모두 비어 있다
  await worker.evaluate(() => chrome.storage.local.set({ cloudAccounts: [{ id: 'a1', provider: 'aws' }] }));
  await dash.click('#tabs a[data-page=settings]');
  await dash.click('#wipe-btn');
  await dash.waitForFunction(() => document.querySelector('#wipe-summary').textContent.includes('2개'));
  assert.match(await dash.textContent('#wipe-summary'), /카드 2장/);
  assert.equal(await dash.isDisabled('#wipe-submit'), true);
  await dash.fill('#wipe-form [name=confirm]', '지워');
  assert.equal(await dash.isDisabled('#wipe-submit'), true);
  await dash.screenshot({ path: path.join(SHOT_DIR, 'wipe-dialog.png') });
  await dash.fill('#wipe-form [name=confirm]', '지우기');
  await Promise.all([dash.waitForEvent('load'), dash.click('#wipe-submit')]);
  // 다시 열린 대시보드가 환율을 새로 받아 cloudMeta를 쓸 수 있으니, 사용자 데이터 키만 본다
  assert.deepEqual(await worker.evaluate(() => chrome.storage.local.get(['records', 'cards', 'cloudAccounts', 'cloudCosts'])), {});
  await dash.waitForFunction(() => document.querySelector('#monthly-total').textContent === '0원');
  assert.equal(await dash.evaluate(() => document.querySelector('#empty').hidden), false);
  assert.equal(await dash.evaluate(() => location.hash), '#home');

  assert.deepEqual(errors, []);
  process.stdout.write('picker e2e ok\n');
} finally {
  await context.close();
}
