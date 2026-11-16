// 화면 나누기 + 달마다 그래프 + 설정(예산·알림·백업/복원) 흐름.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.join(ROOT, 'e2e', 'screenshots');

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  acceptDownloads: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
await context.route('https://open.er-api.com/**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ rates: { KRW: 1400 } }) }));
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extId = worker.url().split('/')[2];
const errors = [];

// 날짜는 오늘 기준으로 만든다: 넷플릭스는 5달 전부터 매달, 일회성은 2달 전, 지난달 서버 사용료 $30
const seed = await worker.evaluate(() => {
  const now = new Date();
  const monthsAgo = (n, d = 5) => new Date(now.getFullYear(), now.getMonth() - n, d).getTime();
  const pad = (n) => String(n).padStart(2, '0');
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const base = { card: null, pg: null, trial: false, status: 'active', canceledAt: null, note: '', review: 'confirmed', userEdited: true, evidence: [] };
  const records = [
    { ...base, id: 'netflix', site: 'netflix.com', kind: 'subscription', cycle: 'monthly', amount: 13500, currency: 'KRW', startedAt: monthsAgo(5), createdAt: monthsAgo(5), updatedAt: monthsAgo(5) },
    { ...base, id: 'macbook', site: 'apple.com', kind: 'one_time', cycle: null, amount: 50000, currency: 'KRW', startedAt: monthsAgo(2, 10), createdAt: monthsAgo(2, 10), updatedAt: monthsAgo(2, 10) },
    { ...base, id: 'pending', site: 'auto.example', kind: 'subscription', cycle: 'monthly', amount: 999999, currency: 'KRW', review: 'pending', startedAt: monthsAgo(3), createdAt: monthsAgo(3), updatedAt: monthsAgo(3) },
  ];
  const cloudHistory = { [`${last.getFullYear()}-${pad(last.getMonth() + 1)}`]: { a1: { amount: 30, currency: 'USD', final: true } } };
  return chrome.storage.local.set({ records, cloudHistory, cloudMeta: { usdKrw: 1400, fxAt: Date.now() } }).then(() => ({ records: records.length }));
});
assert.equal(seed.records, 3);

try {
  const dash = await context.newPage();
  dash.on('pageerror', (err) => errors.push(err.message));
  await dash.setViewportSize({ width: 1280, height: 900 });
  await dash.goto(`chrome-extension://${extId}/src/dashboard.html`);

  // 1) 처음은 이번 달 화면 하나만 보인다
  assert.equal(await dash.isVisible('#page-home'), true);
  assert.equal(await dash.isVisible('#page-trends'), false);
  assert.equal(await dash.getAttribute('#tabs a[data-page=home]', 'aria-current'), 'page');
  await dash.waitForFunction(() => document.querySelector('#monthly-total').textContent === '13,500원');
  // 지난달: 넷플릭스 13,500 + 서버 $30 × 1,400 = 55,500 → 이번 달이 42,000원 적다
  await dash.waitForFunction(() => /지난달\(55,500원\)보다 42,000원 적어요/.test(document.querySelector('#month-delta').textContent));

  // 2) 달마다: 12달 막대, 확인 대기 기록은 빠진다
  await dash.click('#tabs a[data-page=trends]');
  await dash.waitForFunction(() => document.querySelectorAll('#trend-chart .bar').length === 12);
  assert.equal(await dash.locator('#trend-legend li').count(), 3);
  const twoAgo = await dash.locator('#trend-chart .bar').nth(9).getAttribute('aria-label');
  assert.match(twoAgo, /합계 63,500원/, '두 달 전 = 넷플릭스 + 일회성 50,000');
  assert.doesNotMatch(await dash.textContent('#trend-chart'), /999/, '확인 대기 기록은 그래프에 없다');
  await dash.locator('#trend-chart .bar').nth(10).hover();
  await dash.waitForSelector('#trend-tip:not([hidden])');
  assert.match(await dash.textContent('#trend-tip'), /서버·API/);
  await dash.screenshot({ path: path.join(SHOT_DIR, 'trends.png'), fullPage: true });
  await dash.click('#trend-table-btn');
  assert.equal(await dash.locator('#trend-table tbody tr').count(), 12);
  await dash.click('#trend-range button[data-months="6"]');
  await dash.waitForFunction(() => document.querySelectorAll('#trend-chart .bar').length === 6);
  assert.match(await dash.textContent('#top-list li:first-child'), /netflix\.com.*81,000원/);
  assert.match(await dash.textContent('#trend-stats'), /6개월 합계/);

  // 3) 예산: 이번 달 13,500원인데 예산 10,000원이면 초과
  await dash.click('#tabs a[data-page=settings]');
  await dash.fill('#budget-form [name=budget]', '10000');
  await dash.click('#budget-form button[type=submit]');
  await dash.waitForFunction(() => /10,000원/.test(document.querySelector('#settings-status').textContent));
  await dash.click('#tabs a[data-page=home]');
  await dash.waitForFunction(() => document.querySelector('#budget').dataset.level === 'over');
  assert.match(await dash.textContent('#budget-text'), /예산을 넘었어요.*3,500원 더/);

  // 4) 결제 알림 켜기 → 설정에 저장된다
  await dash.click('#tabs a[data-page=settings]');
  await dash.selectOption('#remind-form [name=daysBefore]', '3');
  await dash.check('#remind-form [name=enabled]');
  await dash.waitForFunction(() => /알림을 켰어요/.test(document.querySelector('#settings-status').textContent));
  const settings = await worker.evaluate(() => chrome.storage.local.get('settings').then((s) => s.settings));
  assert.deepEqual(settings, { budgetKRW: 10000, remind: { enabled: true, daysBefore: 3 } });

  // 5) 백업 받기 → 기록을 비운 뒤 파일에서 가져오기 → 돌아온다. 연결 키는 파일에 없다
  await worker.evaluate(() => chrome.storage.local.set({ cloudAccounts: [{ id: 'a1', credentials: { secretAccessKey: 'SECRET-SHOULD-NOT-LEAK' } }] }));
  const [download] = await Promise.all([dash.waitForEvent('download'), dash.click('#backup-btn')]);
  const file = await download.path();
  const text = await fs.readFile(file, 'utf8');
  assert.ok(!text.includes('SECRET-SHOULD-NOT-LEAK'));
  assert.equal(JSON.parse(text).records.length, 3);
  await worker.evaluate(() => chrome.storage.local.set({ records: [] }));
  dash.once('dialog', (d) => d.accept());
  await dash.setInputFiles('#restore-file', file);
  await dash.waitForFunction(() => /기록 3개/.test(document.querySelector('#settings-status').textContent));
  const restored = await worker.evaluate(() => chrome.storage.local.get('records').then((s) => s.records.map((r) => r.id).sort()));
  assert.deepEqual(restored, ['macbook', 'netflix', 'pending']);
  await dash.screenshot({ path: path.join(SHOT_DIR, 'settings.png'), fullPage: true });

  // 6) 기록 화면 검색
  await dash.click('#tabs a[data-page=records]');
  await dash.fill('#record-search', 'netf');
  await dash.waitForFunction(() => document.querySelectorAll('#rows tr').length === 1);

  // 모바일
  await dash.setViewportSize({ width: 375, height: 800 });
  await dash.click('#tabs a[data-page=trends]');
  await dash.waitForFunction(() => document.querySelectorAll('#trend-chart .bar').length === 6);
  await dash.screenshot({ path: path.join(SHOT_DIR, 'trends-mobile.png'), fullPage: true });

  assert.deepEqual(errors, []);
  process.stdout.write('pages e2e ok\n');
} finally {
  await context.close();
}
