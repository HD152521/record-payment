// 구독 계정 페이지 읽기: 가짜 사이트 응답(단순화한 가짜 HTML)을 route로 내려 안내 → 추가 / 이미 있으면 안 띄움 / 거절 30일을 확인한다.
// 실제 사이트에는 요청하지 않는다. 확장 밖으로 나가는 요청은 route가 가로채 가짜 응답만 준다.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => fs.readFile(path.join(ROOT, 'test', 'fixtures', 'accounts', `${name}.html`), 'utf8');
const BIG_FONT_CSS = '<style>* { font-size: 40px !important; color: red !important; }</style>';

const PAGES = {
  'https://www.netflix.com/account': await fixture('netflix'),
  'https://www.spotify.com/kr-ko/account/overview/': await fixture('spotify'),
  'https://claude.ai/settings/billing': BIG_FONT_CSS + await fixture('claude'),
  'https://www.youtube.com/paid_memberships': await fixture('unrelated'),
  'https://www.netflix.com/browse': await fixture('netflix'),
  'https://blog.example/post': await fixture('netflix'),
};

const requested = [];
const context = await chromium.launchPersistentContext('', {
  reducedMotion: 'reduce', // 금액 카운트업이 끝나기 전 글자를 읽지 않게
  channel: 'chromium',
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
await context.route('https://**/*', (route) => {
  const url = route.request().url().split('?')[0];
  requested.push(url);
  const body = PAGES[url];
  return body ? route.fulfill({ contentType: 'text/html; charset=utf-8', body }) : route.fulfill({ status: 404 });
});
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const errors = [];
const records = () => worker.evaluate(() => chrome.storage.local.get('records').then((s) => s.records || []));
const dismissed = () => worker.evaluate(() => chrome.storage.local.get('accountDismissed').then((s) => s.accountDismissed || {}));
const PROMPT = 'text=결제 기록장에 추가할까요?';
const SETTLE_MS = 2500; // 안내가 안 뜨는 걸 확인할 때 재시도(1.5초 간격)를 한 번은 지나게 기다린다

async function open(url) {
  const page = await context.newPage();
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(url);
  return page;
}

async function assertNoPrompt(page) {
  await page.waitForTimeout(SETTLE_MS);
  assert.equal(await page.locator(PROMPT).count(), 0);
}

try {
  // 1) Netflix: 안내가 뜨고 내용이 맞고, 누르면 확인할 기록으로 들어간다
  const netflix = await open('https://www.netflix.com/account');
  await netflix.waitForSelector(PROMPT);
  const detail = await netflix.locator('.detail').allTextContents();
  assert.match(detail.join(' '), /Netflix · 프리미엄/);
  assert.match(detail.join(' '), /월 17,000원 · 다음 결제 12월 5일/);
  await netflix.getByRole('button', { name: '추가하기' }).click();
  await netflix.waitForSelector('text=확인할 기록에 넣었어요');
  const saved = await records();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].site, 'netflix.com');
  assert.equal(saved[0].kind, 'subscription');
  assert.equal(saved[0].review, 'pending');
  assert.equal(saved[0].amount, 17000);
  assert.equal(saved[0].cycle, 'monthly');
  assert.equal(saved[0].note, '프리미엄');
  assert.equal(new Date(saved[0].startedAt).getMonth(), 11);
  assert.equal(new Date(saved[0].startedAt).getDate(), 5);
  assert.equal(saved[0].siteUrl, 'https://www.netflix.com');
  await netflix.close();

  // 2) 이미 기록된 구독이면 다시 열어도 안내하지 않는다
  const again = await open('https://www.netflix.com/account');
  await assertNoPrompt(again);
  assert.equal((await records()).length, 1);
  await again.close();

  // 3) 대상이 아닌 페이지(같은 사이트의 다른 경로, 다른 사이트)에서는 읽지도 않는다
  for (const url of ['https://www.netflix.com/browse', 'https://blog.example/post']) {
    const page = await open(url);
    await assertNoPrompt(page);
    await page.close();
  }

  // 4) 못 읽는 페이지는 조용히 넘어간다
  const youtube = await open('https://www.youtube.com/paid_memberships');
  await assertNoPrompt(youtube);
  await youtube.close();

  // 5) 거절하면 30일 기록이 남고 다시 열어도 묻지 않는다. 기록은 늘지 않는다
  const spotify = await open('https://www.spotify.com/kr-ko/account/overview/');
  await spotify.waitForSelector(PROMPT);
  await spotify.getByRole('button', { name: '괜찮아요' }).click();
  await spotify.waitForFunction(() => !document.body.innerText.includes('추가할까요'));
  await spotify.waitForTimeout(300);
  const marks = await dismissed();
  assert.ok(Date.now() - marks.spotify < 60000);
  await spotify.reload();
  await assertNoPrompt(spotify);
  assert.equal((await records()).length, 1);
  await spotify.close();

  // 6) 페이지 스타일이 안내를 망가뜨리지 못한다(Shadow DOM 격리), 페이지 글은 HTML로 해석되지 않는다
  const claude = await open('https://claude.ai/settings/billing');
  await claude.waitForSelector(PROMPT);
  const style = await claude.locator('.title').first().evaluate((n) => ({ size: getComputedStyle(n).fontSize, color: getComputedStyle(n).color }));
  assert.equal(style.size, '13px');
  assert.notEqual(style.color, 'rgb(255, 0, 0)');
  assert.match((await claude.locator('.detail').allTextContents()).join(' '), /Claude · Max 5x.*월 \$100/);
  await claude.close();

  // 7) 이 기능이 새로 만든 외부 요청은 없다(받은 건 우리가 연 가짜 페이지뿐. 환율 조회는 기존 동작이라 제외)
  const unexpected = requested.filter((u) => !(u in PAGES) && !u.startsWith('https://open.er-api.com/'));
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.error('account e2e 통과');
} finally {
  await context.close();
}
