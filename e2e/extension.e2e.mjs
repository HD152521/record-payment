// 실제 Chromium에 확장프로그램을 올려 결제 흐름 3가지를 재현한다. 네트워크는 전부 route로 가짜 응답.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.join(ROOT, 'e2e', 'screenshots');

const PAGES = {
  'https://saas.example/checkout': `<h1>Pro 플랜</h1><p>월 9,900원</p><p>매월 자동 결제됩니다</p>
    <form onsubmit="event.preventDefault()"><input autocomplete="cc-number" name="cardnumber">
    <button type="submit">구독 시작하기</button></form>`,
  'https://shop.example/order': `<h1>주문/결제</h1><p>상품금액</p><p>25,000원</p><p>배송비</p><p>3,000원</p>
    <p>총 결제금액</p><p>26,000원</p>
    <button onclick="window.open('https://pay.toss.im/checkout','pg','width=400,height=600')">결제하기</button>`,
  'https://pay.toss.im/checkout': '<p>토스페이 결제</p><p>결제금액 26,000원</p><button>다음</button>',
  'https://blog.example/post': '<p>오늘의 일기</p><button>확인</button>',
  'https://video.example/watch': '<p>재미있는 영상</p><button>구독</button>',
  'https://portal.example/': '<a href="https://news.example/pay" target="_blank">뉴스 구독하러 가기</a>',
  'https://news.example/pay': `<p>디지털 구독 결제</p><p>연 99,000원</p><input autocomplete="cc-number" name="cardnumber">
    <button>결제하기</button>`,
};

const html = (body) => `<!doctype html><html lang="ko"><meta charset="utf-8"><body>${body}</body></html>`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
await context.route('https://*/**', (route) => {
  const url = route.request().url().split('?')[0];
  const body = PAGES[url];
  return body ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html(body) }) : route.fulfill({ status: 404 });
});

const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extId = worker.url().split('/')[2];
const records = () => worker.evaluate(async () => (await chrome.storage.local.get('records')).records || []);

try {
  // 1) 구독: 카드 입력 후 구독 버튼
  const saas = await context.newPage();
  await saas.goto('https://saas.example/checkout');
  await saas.fill('input[name=cardnumber]', '4242 4242 4242 4242');
  await saas.locator('input').blur();
  await wait(700);
  await saas.click('button');
  await wait(700);

  // 2) 일회성: 쇼핑몰에서 결제하기 → 토스 팝업에서 다음
  const shop = await context.newPage();
  await shop.goto('https://shop.example/order');
  const [popup] = await Promise.all([shop.waitForEvent('popup'), shop.click('button')]);
  await popup.waitForLoadState();
  await popup.click('button');
  await wait(700);

  // 3) 결제와 무관한 페이지의 "확인" 버튼은 기록되면 안 된다
  const blog = await context.newPage();
  await blog.goto('https://blog.example/post');
  await blog.click('button');
  await wait(700);

  // 4) 영상 사이트의 "구독" 버튼은 결제가 아니다
  const video = await context.newPage();
  await video.goto('https://video.example/watch');
  await video.click('button');
  await wait(700);

  // 5) 다른 사이트에서 새 탭으로 연 결제 페이지는 그 페이지 사이트로 기록돼야 한다
  const portal = await context.newPage();
  await portal.goto('https://portal.example/');
  const [news] = await Promise.all([context.waitForEvent('page'), portal.click('a')]);
  await news.waitForLoadState();
  await news.fill('input[name=cardnumber]', '5555555555554444');
  await news.locator('input').blur();
  await wait(700);
  await news.click('button');
  await wait(700);

  const list = await records();
  console.log(JSON.stringify(list.map(({ site, kind, cycle, amount, currency, card, pg, evidence }) => ({ site, kind, cycle, amount, currency, card, pg, evidence })), null, 2));

  assert.equal(list.length, 3, '기록은 3개여야 한다 (블로그·영상 구독 제외)');
  const newsRecord = list.find((r) => r.site === 'news.example');
  assert.ok(newsRecord, '새 탭 결제는 portal.example이 아니라 news.example로 기록');
  assert.deepEqual([newsRecord.kind, newsRecord.cycle, newsRecord.amount, newsRecord.card.brand], ['subscription', 'yearly', 99000, 'Mastercard']);
  const sub = list.find((r) => r.site === 'saas.example');
  assert.deepEqual([sub.kind, sub.cycle, sub.amount, sub.currency], ['subscription', 'monthly', 9900, 'KRW']);
  assert.deepEqual(sub.card, { brand: 'VISA', last4: '4242' });
  const order = list.find((r) => r.site === 'shop.example');
  assert.deepEqual([order.kind, order.amount, order.pg], ['one_time', 26000, '토스페이']);
  assert.ok(!list.some((r) => r.site === 'pay.toss.im'), 'PG 도메인이 사이트로 잡히면 안 된다');

  // 대시보드 렌더 확인
  const dash = await context.newPage();
  await dash.setViewportSize({ width: 1280, height: 800 });
  await dash.goto(`chrome-extension://${extId}/src/dashboard.html`);
  await dash.waitForSelector('#rows tr');
  assert.equal(await dash.textContent('#monthly-total'), '18,150원');

  // 대시보드에서 금액 수정 → background 큐를 거쳐 저장되는지
  await dash.locator('#rows tr', { hasText: 'saas.example' }).getByRole('button', { name: '수정' }).click();
  await dash.fill('input[name=amount]', '12000');
  await dash.click('button[type=submit]');
  await dash.waitForFunction(() => document.querySelector('#monthly-total').textContent === '20,250원');
  const edited = (await records()).find((r) => r.site === 'saas.example');
  assert.deepEqual([edited.amount, edited.userEdited], [12000, true]);
  await dash.screenshot({ path: path.join(SHOT_DIR, 'dashboard.png'), fullPage: true });
  await dash.setViewportSize({ width: 375, height: 800 });
  await dash.screenshot({ path: path.join(SHOT_DIR, 'dashboard-mobile.png'), fullPage: true });

  const pop = await context.newPage();
  await pop.setViewportSize({ width: 360, height: 420 });
  await pop.goto(`chrome-extension://${extId}/src/popup.html`);
  await pop.waitForSelector('#recent li');
  await pop.screenshot({ path: path.join(SHOT_DIR, 'popup.png') });

  console.log('E2E 통과');
} finally {
  await context.close();
}
