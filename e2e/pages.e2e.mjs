// 화면 나누기 + 달마다 그래프 + 설정(예산·알림·백업/복원) 흐름.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.join(ROOT, 'e2e', 'screenshots');

const context = await chromium.launchPersistentContext('', {
  reducedMotion: 'reduce', // 금액 카운트업이 끝나기 전 글자를 읽지 않게
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

  // 1-1) 움직임을 켠 사람: 금액은 0에서 올라가 같은 값에서 멈추고, 곧 나갈 돈 목록은 차례로 나타난다
  await dash.emulateMedia({ reducedMotion: 'no-preference' });
  await dash.reload();
  // 0원과 끝값 사이의 값이 한 번은 보여야 카운트업이다
  await dash.waitForFunction(() => /^[1-9][\d,]*원$/.test(document.querySelector('#monthly-total').textContent)
    && document.querySelector('#monthly-total').textContent !== '13,500원');
  await dash.waitForFunction(() => document.querySelector('#monthly-total').textContent === '13,500원');
  await dash.waitForSelector('#upcoming-list li.stagger-in');
  await dash.emulateMedia({ reducedMotion: 'reduce' });

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

  // 2-b) 나눠 보기: 분류별로 바꾸면 계열이 바뀌고 같은 달 합계는 그대로, 새로고침 뒤에도 유지
  const totalBefore = await dash.locator('#trend-chart .bar').nth(3).getAttribute('aria-label').then((s) => s.match(/합계 ([\d,]+원)/)[1]);
  await dash.click('#trend-view button[data-view=category]');
  await dash.waitForFunction(() => /생활 구독/.test(document.querySelector('#trend-legend').textContent));
  assert.match(await dash.textContent('#trend-legend'), /기타/, '카탈로그에 없는 기록은 기타');
  assert.match(await dash.textContent('#trend-legend'), /서버·API/);
  assert.match(await dash.locator('#trend-chart .bar').nth(3).getAttribute('aria-label'), new RegExp(`합계 ${totalBefore}`));
  await dash.locator('#trend-chart .bar').nth(3).hover();
  await dash.waitForSelector('#trend-tip:not([hidden])');
  assert.match(await dash.textContent('#trend-tip'), /생활 구독/);
  await dash.waitForFunction(() => chrome.storage.local.get('settings').then((s) => s.settings && s.settings.trendView === 'category'));
  await dash.reload();
  await dash.click('#tabs a[data-page=trends]');
  await dash.waitForFunction(() => document.querySelector('#trend-view button[data-view=category]').getAttribute('aria-pressed') === 'true');
  await dash.waitForFunction(() => /생활 구독/.test(document.querySelector('#trend-legend').textContent));
  await dash.click('#trend-view button[data-view=card]');
  await dash.waitForFunction(() => /카드 안 정함/.test(document.querySelector('#trend-legend').textContent));
  await dash.click('#trend-view button[data-view=all]');
  await dash.waitForFunction(() => document.querySelectorAll('#trend-legend li').length === 3);

  // 2-c) 사용법 화면: 탭으로 열리고, 안에서 설정 화면으로 갈 수 있다
  await dash.click('#tabs a[data-page=help]');
  await dash.waitForSelector('#page-help', { state: 'visible' });
  assert.equal(await dash.isVisible('#page-trends'), false);
  assert.match(await dash.textContent('#page-help'), /맞아요.*알림이 안 보여요/s);
  await dash.screenshot({ path: path.join(SHOT_DIR, 'help.png'), fullPage: true });
  await dash.click('#page-help a[href="#settings"]');
  await dash.waitForSelector('#page-settings', { state: 'visible' });

  // 3) 예산: 이번 달 13,500원인데 예산 10,000원이면 초과
  await dash.click('#tabs a[data-page=settings]');
  await dash.fill('#budget-form [name=budget]', '10000');
  await dash.click('#budget-form button[type=submit]');
  await dash.waitForFunction(() => /10,000원/.test((document.querySelector('#toaster')?.textContent || '')));
  await dash.click('#tabs a[data-page=home]');
  await dash.waitForFunction(() => document.querySelector('#budget').dataset.level === 'over');
  assert.match(await dash.textContent('#budget-text'), /예산을 넘었어요.*3,500원 더/);

  assert.equal(await dash.isVisible('#sync-now'), false, '동기화를 안 켰으면 "지금 맞추기"는 숨긴다');

  // 4) 결제 알림 켜기 → 설정에 저장된다
  await dash.click('#tabs a[data-page=settings]');
  await dash.selectOption('#remind-form [name=daysBefore]', '3');
  await dash.check('#remind-form [name=enabled]');
  await dash.waitForFunction(() => /알림을 켰어요/.test((document.querySelector('#toaster')?.textContent || '')));
  const settings = await worker.evaluate(() => chrome.storage.local.get('settings').then((s) => s.settings));
  assert.deepEqual({ budgetKRW: settings.budgetKRW, remind: settings.remind }, { budgetKRW: 10000, remind: { enabled: true, daysBefore: 3 } });

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
  await dash.waitForFunction(() => /기록 3개/.test((document.querySelector('#toaster')?.textContent || '')));
  const restored = await worker.evaluate(() => chrome.storage.local.get('records').then((s) => s.records.map((r) => r.id).sort()));
  assert.deepEqual(restored, ['macbook', 'netflix', 'pending']);
  assert.equal(await dash.evaluate(() => document.querySelector('#toaster').matches(':popover-open')), true, '안내는 토스트로 뜬다');
  await dash.screenshot({ path: path.join(SHOT_DIR, 'settings.png'), fullPage: true });

  // 6) 기록 화면 검색
  await dash.click('#tabs a[data-page=records]');
  await dash.fill('#record-search', 'netf');
  await dash.waitForFunction(() => document.querySelectorAll('#rows tr').length === 1);

  // 모바일
  await dash.setViewportSize({ width: 375, height: 800 });
  await dash.click('#tabs a[data-page=trends]');
  await dash.click('#trend-range button[data-months="6"]');
  await dash.waitForFunction(() => document.querySelectorAll('#trend-chart .bar').length === 6);
  await dash.screenshot({ path: path.join(SHOT_DIR, 'trends-mobile.png'), fullPage: true });

  assert.deepEqual(errors, []);
  process.stdout.write('pages e2e ok\n');
} finally {
  await context.close();
}
