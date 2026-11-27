// 카드별 이번 달 합계 + 카드 상세 + 카드 안 정한 기록 한 번에 카드 정하기. 가짜 데이터만 쓴다.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

await worker.evaluate(() => {
  const now = new Date();
  const at = (d) => new Date(now.getFullYear(), now.getMonth() - 1, d).getTime(); // 지난달 d일 시작 → 매달 d일
  const base = { pg: null, trial: false, status: 'active', canceledAt: null, note: '', review: 'confirmed', userEdited: true, evidence: [], cycle: 'monthly', currency: 'KRW', kind: 'subscription' };
  const rec = (id, site, amount, card, d) => ({ ...base, id, site, amount, card, startedAt: at(d), createdAt: at(d), updatedAt: at(d) });
  const visa = { brand: 'Visa', last4: '4242' };
  return chrome.storage.local.set({
    cards: [{ id: 'c1', label: '신한 개인', brand: 'Visa', last4: '4242', createdAt: 1 }],
    cloudMeta: { usdKrw: 1400, fxAt: Date.now() },
    records: [
      rec('a', 'netflix.com', 13500, visa, 1),
      rec('b', 'spotify.com', 10900, visa, 28),
      rec('c', 'notion.so', 8000, null, 2),
      rec('d', 'figma.com', 15000, null, 3),
    ],
  });
});

try {
  const dash = await context.newPage();
  dash.on('pageerror', (err) => errors.push(err.message));
  await dash.setViewportSize({ width: 1280, height: 900 });
  await dash.goto(`chrome-extension://${extId}/src/dashboard.html#cards`);

  await dash.waitForSelector('#card-list li');
  assert.match(await dash.textContent('#card-list li'), /이번 달 24,400원/);
  assert.match(await dash.textContent('#card-unassigned'), /카드 안 정한 기록 2개 · 이번 달 23,000원/);

  // 카드 상세: 이번 달 금액과 목록
  await dash.click('#card-list .card-open');
  await dash.waitForSelector('#card-detail[open]');
  assert.match(await dash.textContent('#card-detail-total'), /24,400원/);
  assert.equal(await dash.locator('#card-detail-list li').count(), 2);
  assert.match(await dash.textContent('#card-detail-list'), /netflix\.com[\s\S]*spotify\.com/);
  assert.match(await dash.textContent('#card-detail-sub'), /다음 결제일/);
  await dash.click('#card-detail-close');

  // 카드 안 정한 기록 2개를 한 번에 카드 지정
  await dash.click('#card-unassigned-btn');
  await dash.waitForSelector('#card-detail[open]');
  assert.equal(await dash.locator('#card-detail-list input:checked').count(), 2);
  await dash.click('#card-assign-btn');
  await dash.waitForFunction(() => document.querySelector('#card-unassigned').hidden);
  const cards = await worker.evaluate(() => chrome.storage.local.get('records').then((s) => s.records.map((r) => [r.id, r.card && r.card.last4]).sort()));
  assert.deepEqual(cards, [['a', '4242'], ['b', '4242'], ['c', '4242'], ['d', '4242']]);
  await dash.click('#card-detail-close');
  assert.match(await dash.textContent('#card-list li'), /이번 달 47,400원/);

  // 등록한 카드가 하나도 없을 때: 그 창에서 바로 카드를 등록하고 이어서 정한다
  await worker.evaluate(() => chrome.storage.local.get('records').then((s) => chrome.storage.local.set({ cards: [], records: s.records.map((r) => ({ ...r, card: null })) })));
  await dash.waitForFunction(() => !document.querySelector('#card-unassigned').hidden && document.querySelectorAll('#card-list li').length === 0);
  await dash.click('#card-unassigned-btn');
  await dash.waitForSelector('#card-detail[open]');
  assert.equal(await dash.isVisible('#card-assign-pick'), false, '고를 카드가 없으면 빈 드롭다운은 숨긴다');
  assert.equal(await dash.isVisible('#card-assign-btn'), false);
  await dash.screenshot({ path: path.join(ROOT, 'e2e', 'screenshots', 'card-assign-empty.png') });
  await dash.uncheck('#card-detail-list li[data-id="b"] input');
  await dash.click('#card-assign-add');
  await dash.waitForSelector('#card-dialog[open]');

  // 카드 미리보기는 넓은 화면과 폰 너비 모두에서 실제 카드 비율(85.6×53.98mm)이다
  for (const width of [1280, 360]) {
    await dash.setViewportSize({ width, height: 900 });
    const box = await dash.$eval('.card-preview', (n) => ({ w: n.offsetWidth, h: n.offsetHeight }));
    assert.ok(Math.abs(box.w / box.h - 85.6 / 53.98) < 0.03, `${width}px에서 카드 비율이 ${(box.w / box.h).toFixed(2)}:1`);
    await dash.screenshot({ path: path.join(ROOT, 'e2e', 'screenshots', `card-dialog-${width}.png`) });
  }
  await dash.setViewportSize({ width: 1280, height: 900 });
  await dash.fill('#card-form [name=last4]', '1234');
  await dash.click('#card-form button[type=submit]');
  await dash.waitForFunction(() => document.querySelector('#card-assign-pick').value === '1234');
  assert.equal(await dash.isVisible('#card-detail'), true, '등록한 뒤에도 정하던 창이 그대로다');
  assert.equal(await dash.isVisible('#card-assign-add'), true, '카드가 있어도 새 카드를 더 등록할 수 있다');
  assert.equal(await dash.isChecked('#card-detail-list li[data-id="b"] input'), false, '카드를 등록해도 뺀 기록은 빠진 채다');
  await dash.click('#card-assign-btn');
  await dash.waitForFunction(() => document.querySelectorAll('#card-detail-list li').length === 1);
  const left = await worker.evaluate(() => chrome.storage.local.get('records').then((s) => s.records.filter((r) => !r.card).map((r) => r.id)));
  assert.deepEqual(left, ['b']);
  // 창을 새로 열면 다시 전부 고른 상태로 시작한다
  await dash.click('#card-detail-close');
  await dash.click('#card-unassigned-btn');
  await dash.waitForSelector('#card-detail[open]');
  assert.equal(await dash.isChecked('#card-detail-list li[data-id="b"] input'), true);

  assert.deepEqual(errors, []);
  process.stdout.write('cardsum e2e ok\n');
} finally {
  await context.close();
}
