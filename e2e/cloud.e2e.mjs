// 클라우드 연결 흐름을 실제 Chromium에서 확인한다. AWS·OpenAI·환율은 route로 가짜 응답.
// Microsoft 토큰 요청의 Origin 제거 규칙은 로컬 에코 서버로 확인한다.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.join(ROOT, 'e2e', 'screenshots');
const now = new Date();
const ym = (offset) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return d.toISOString().slice(0, 10);
};

const AWS_RESPONSE = {
  ResultsByTime: [
    { TimePeriod: { Start: ym(-1) }, Groups: [{ Keys: ['Amazon ECS'], Metrics: { UnblendedCost: { Amount: '120', Unit: 'USD' } } }] },
    { TimePeriod: { Start: ym(0) }, Groups: [
      { Keys: ['Amazon Elastic Container Service'], Metrics: { UnblendedCost: { Amount: '17.8', Unit: 'USD' } } },
      { Keys: ['Amazon Relational Database Service'], Metrics: { UnblendedCost: { Amount: '7.31', Unit: 'USD' } } },
      { Keys: ['Amazon ElastiCache'], Metrics: { UnblendedCost: { Amount: '4.66', Unit: 'USD' } } },
      { Keys: ['Tax'], Metrics: { UnblendedCost: { Amount: '3', Unit: 'USD' } } },
    ] },
  ],
};
const OPENAI_RESPONSE = {
  data: [{ start_time: Date.parse(`${ym(0)}T00:00:00Z`) / 1000, results: [{ amount: { value: 4.2, currency: 'usd' }, line_item: 'gpt-5, input' }] }],
  has_more: false,
};

const context = await chromium.launchPersistentContext('', {
  reducedMotion: 'reduce', // 금액 카운트업이 끝나기 전 글자를 읽지 않게
  channel: 'chromium',
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
const seen = { aws: [], openai: [] };
await context.route('https://ce.us-east-1.amazonaws.com/', (route) => {
  const h = route.request().headers();
  seen.aws.push(h);
  if (!String(h.authorization || '').startsWith('AWS4-HMAC-SHA256 Credential=AKIAABCDEFGHIJKLMNOP/')) {
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ __type: 'UnrecognizedClientException' }) });
  }
  return route.fulfill({ contentType: 'application/x-amz-json-1.1', body: JSON.stringify(AWS_RESPONSE) });
});
await context.route('https://api.openai.com/**', (route) => {
  seen.openai.push(route.request().headers());
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(OPENAI_RESPONSE) });
});
await context.route('https://open.er-api.com/**', (route) =>
  route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: 'success', rates: { KRW: 1400 } }) }));

const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extId = worker.url().split('/')[2];
const storage = (key) => worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);

try {
  const dash = await context.newPage();
  const pageErrors = [];
  dash.on('pageerror', (e) => pageErrors.push(e.message));
  await dash.setViewportSize({ width: 1280, height: 900 });
  await dash.goto(`chrome-extension://${extId}/src/dashboard.html#cloud`);
  await dash.waitForSelector('#cloud-empty:not([hidden])');

  // 1) 틀린 형식의 키는 저장하지 않고 이유를 보여준다
  await dash.click('#cloud-add');
  await dash.fill('input[name=accessKeyId]', 'wrong');
  await dash.fill('input[name=secretAccessKey]', 'x'.repeat(40));
  await dash.click('#cloud-submit');
  await dash.waitForFunction(() => document.querySelector('#cloud-status').textContent.includes('AKIA'));
  assert.equal((await storage('cloudAccounts') || []).length, 0, '틀린 키는 저장되면 안 된다');

  // 2) 올바른 키 → 실제로 한 번 불러보고 저장
  await dash.fill('input[name=accessKeyId]', 'AKIAABCDEFGHIJKLMNOP');
  await dash.fill('#cloud-form input[name=label]', '회사 AWS');
  await dash.click('#cloud-submit');
  await dash.waitForFunction(() => !document.querySelector('#cloud-dialog').open);
  await dash.waitForSelector('.cloud-card.provider-aws');
  assert.equal(seen.aws.at(-1)['x-amz-target'], 'AWSInsightsIndexService.GetCostAndUsage');

  // 3) OpenAI: 프로젝트 키는 거절, 관리자 키는 통과
  await dash.click('#cloud-add');
  await dash.click('.provider-grid label:has(input[value=openai])');
  assert.equal(await dash.isVisible('input[name=accessKeyId]'), false, '다른 서비스 입력칸은 숨겨져야 한다');
  await dash.fill('input[name=adminKey]', 'sk-proj-abc');
  await dash.click('#cloud-submit');
  await dash.waitForFunction(() => document.querySelector('#cloud-status').textContent.includes('관리자'));
  await dash.fill('input[name=adminKey]', 'sk-admin-test123');
  await dash.click('#cloud-submit');
  await dash.waitForSelector('.cloud-card.provider-openai');
  assert.equal(seen.openai.at(-1).authorization, 'Bearer sk-admin-test123');

  // 4) 합계: AWS 32.77 + OpenAI 4.2 = 36.97달러 × 1400
  await dash.waitForFunction(() => document.querySelector('#cloud-total').textContent === '51,758원');
  // 4-1) 움직임을 켠 사람: 사용료 합계도 0과 끝값 사이를 거쳐 같은 값에서 멈춘다
  await dash.emulateMedia({ reducedMotion: 'no-preference' });
  await dash.reload();
  await dash.waitForFunction(() => /^[1-9][\d,]*원$/.test(document.querySelector('#cloud-total').textContent)
    && document.querySelector('#cloud-total').textContent !== '51,758원');
  await dash.waitForFunction(() => document.querySelector('#cloud-total').textContent === '51,758원');
  await dash.emulateMedia({ reducedMotion: 'reduce' });
  const costs = await storage('cloudCosts');
  assert.ok(!JSON.stringify(costs).includes('sk-admin'), '화면용 저장소에 비밀값이 섞이면 안 된다');
  const awsCard = await dash.textContent('.cloud-card.provider-aws');
  assert.match(awsCard, /회사 AWS/);
  assert.match(awsCard, /\$32\.77/);
  assert.match(awsCard, /Amazon Elastic Container Service/);

  // 5) Azure: 앱 ID가 없으면 연결 화면·빠른 추가 목록에 선택지가 없다
  await dash.click('#cloud-add');
  assert.equal(await dash.locator('.provider-grid label:has(input[value=azure])').isVisible(), false);
  assert.equal(await dash.locator('.provider-grid label:visible').count(), 5);
  assert.equal(await dash.locator('.provider-chips li', { hasText: 'Azure' }).count(), 0);
  // 5-b) 이미 저장된 Azure 연결은 앱 ID가 비어 있어도 지우거나 숨기지 않는다(새 연결만 막는다)
  await dash.click('#cloud-cancel');
  const [openaiAccount] = (await storage('cloudAccounts')).filter((a) => a.provider === 'openai');
  const costsNow = await storage('cloudCosts');
  const azure = { ...openaiAccount, id: 'azure-saved', provider: 'azure', label: '회사 Azure' };
  await worker.evaluate(async ([acc, cost]) => {
    const { cloudAccounts, cloudCosts } = await chrome.storage.local.get(['cloudAccounts', 'cloudCosts']);
    await chrome.storage.local.set({ cloudAccounts: [...cloudAccounts, acc], cloudCosts: { ...cloudCosts, [acc.id]: cost } });
  }, [azure, { ...costsNow[openaiAccount.id], provider: 'azure', label: '회사 Azure' }]);
  await dash.waitForSelector('.cloud-card.provider-azure');
  assert.match(await dash.textContent('.cloud-card.provider-azure'), /회사 Azure/);
  await dash.click('#cloud-refresh');
  await dash.waitForFunction(() => !document.querySelector('#cloud-refresh').disabled);
  assert.ok((await storage('cloudAccounts')).some((a) => a.id === 'azure-saved'), '갱신해도 저장된 Azure 연결이 남는다');
  assert.equal(await dash.locator('.cloud-card.provider-azure').count(), 1);
  await worker.evaluate(async () => {
    const { cloudAccounts, cloudCosts } = await chrome.storage.local.get(['cloudAccounts', 'cloudCosts']);
    const { 'azure-saved': _drop, ...rest } = cloudCosts;
    await chrome.storage.local.set({ cloudAccounts: cloudAccounts.filter((a) => a.id !== 'azure-saved'), cloudCosts: rest });
  });
  await dash.waitForFunction(() => !document.querySelector('.cloud-card.provider-azure'));
  await dash.click('#cloud-add');

  // 6) 베타 표시: AWS만 없고 나머지 연결 서비스 선택지·카드에는 있다
  const betaOf = (p) => dash.locator(`.provider-grid label:has(input[value=${p}]) .badge-beta`).count();
  assert.equal(await betaOf('aws'), 0);
  for (const p of ['openai', 'cloudflare', 'github', 'vercel']) assert.equal(await betaOf(p), 1, p);
  assert.equal(await dash.isVisible('#cloud-beta-note'), false, 'AWS에는 베타 안내가 없다');
  await dash.click('.provider-grid label:has(input[value=openai])');
  assert.equal(await dash.isVisible('#cloud-beta-note'), true);
  assert.match(await dash.getAttribute('#cloud-beta-note a', 'href'), /github\.com\/.+\/issues/);
  assert.equal(await dash.locator('.cloud-card.provider-aws .badge-beta').count(), 0);
  assert.equal(await dash.locator('.cloud-card.provider-openai .badge-beta').count(), 1);
  assert.equal(await dash.locator('.cloud-card.provider-openai .feedback-link').count(), 1);
  assert.equal(await dash.locator('.cloud-card.provider-aws .feedback-link').count(), 0);
  assert.ok(await dash.locator('.badge-beta').first().evaluate((n) => parseFloat(getComputedStyle(n).fontSize) <= 12));
  await dash.click('.provider-grid label:has(input[value=aws])');
  await dash.screenshot({ path: path.join(SHOT_DIR, 'cloud-dialog-aws.png') });
  await dash.click('#cloud-cancel');
  await dash.click('#add-btn');
  await dash.fill('#picker-form [name=q]', 'azure');
  await dash.waitForSelector('#picker-empty', { state: 'visible' });
  assert.equal(await dash.locator('#picker-list li').count(), 0);
  await dash.click('#picker-cancel');

  // 6) 갱신 실패 시 지난 숫자는 남기고 오류만 표시
  await context.unroute('https://api.openai.com/**');
  await context.route('https://api.openai.com/**', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'bad key' } }) }));
  await dash.click('#cloud-refresh');
  await dash.waitForSelector('.cloud-card.provider-openai.has-error');
  assert.match(await dash.textContent('.cloud-card.provider-openai'), /\$4\.20/);
  await dash.screenshot({ path: path.join(SHOT_DIR, 'cloud-dashboard.png'), fullPage: true });
  await dash.setViewportSize({ width: 375, height: 800 });
  await dash.screenshot({ path: path.join(SHOT_DIR, 'cloud-dashboard-mobile.png'), fullPage: true });

  // 7) 팝업 요약
  const pop = await context.newPage();
  await pop.setViewportSize({ width: 360, height: 460 });
  await pop.goto(`chrome-extension://${extId}/src/popup.html`);
  await pop.waitForFunction(() => /51,758원/.test(document.querySelector('#cloud-line').textContent));
  // 팝업 큰 숫자는 홈의 "이번 달 예상"과 같아야 한다
  await dash.setViewportSize({ width: 1280, height: 900 });
  await dash.click('#tabs a[data-page=home]');
  assert.equal(await pop.textContent('#total'), await dash.textContent('#monthly-total'));
  await pop.screenshot({ path: path.join(SHOT_DIR, 'popup.png') });

  // 8) 매일 아침 알람이 걸려 있는지
  const alarm = await worker.evaluate(() => chrome.alarms.get('cloud-refresh'));
  assert.ok(alarm && alarm.periodInMinutes === 1440, '매일 갱신 알람이 있어야 한다');
  assert.equal(new Date(alarm.scheduledTime).getHours(), 8);

  // 9)는 Azure를 켠 버전(manifest에 declarativeNetRequestWithHostAccess 권한)에서만 확인한다.
  if (await worker.evaluate(() => Boolean(chrome.declarativeNetRequest))) {
    // 9) Microsoft 토큰 요청의 Origin 제거 규칙: 실제 규칙 조건을 로컬 에코 서버 도메인으로 바꿔 확인.
    //    background 요청에서는 Origin이 빠지고, 웹페이지(탭)에서 보낸 같은 요청은 그대로여야 한다.
    const echo = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('access-control-allow-origin', '*');
      res.end(JSON.stringify({ origin: req.headers.origin || null }));
    });
    await new Promise((r) => echo.listen(0, '127.0.0.1', r));
    const echoUrl = `http://127.0.0.1:${echo.address().port}/organizations/oauth2/v2.0/token`;
    const fromWorker = await worker.evaluate(async (u) => {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1], addRules: [{
        id: 1, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
        condition: PaymentCloudService.originRuleCondition('127.0.0.1'),
      }] });
      const res = await fetch(u, { method: 'POST', body: 'x=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      return (await res.json()).origin;
    }, echoUrl);
    const tab = await context.newPage();
    await tab.goto(`http://127.0.0.1:${echo.address().port}/`);
    const fromTab = await tab.evaluate(async (u) => {
      const res = await fetch(u, { method: 'POST', body: 'x=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      return (await res.json()).origin;
    }, echoUrl);
    echo.close();
    assert.equal(fromWorker, null, 'background의 토큰 요청에서는 Origin이 빠져야 한다');
    assert.ok(fromTab && fromTab.startsWith('http://127.0.0.1'), '웹페이지 요청의 Origin은 건드리면 안 된다');
  }

  assert.deepEqual(pageErrors, []);
  console.log('클라우드 E2E 통과');
} finally {
  await context.close();
}
