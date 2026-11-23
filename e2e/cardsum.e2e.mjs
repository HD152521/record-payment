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

  assert.deepEqual(errors, []);
  process.stdout.write('cardsum e2e ok\n');
} finally {
  await context.close();
}
