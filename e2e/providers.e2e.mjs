// Cloudflare·GitHub·Vercel 연결을 실제 Chromium에서 확인한다. 세 API는 문서 형식대로 만든 가짜 응답.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.join(ROOT, 'e2e', 'screenshots');
const now = new Date();
const monthStart = (offset) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString();
const ACCOUNT = 'c'.repeat(32);
const CF_TOKEN = 'cf_'.padEnd(40, 'x');
const GH_TOKEN = `github_pat_${'g'.repeat(40)}`;
const VC_TOKEN = 'vc'.padEnd(24, 'y');

const context = await chromium.launchPersistentContext('', {
  reducedMotion: 'reduce', // 금액 카운트업이 끝나기 전 글자를 읽지 않게
  channel: 'chromium',
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
const seen = [];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

await context.route('https://open.er-api.com/**', (route) => json(route, { rates: { KRW: 1400 } }));
await context.route('https://api.cloudflare.com/**', (route) => {
  const url = route.request().url();
  seen.push(['cloudflare', url, route.request().headers().authorization]);
  if (route.request().headers().authorization !== `Bearer ${CF_TOKEN}`) return json(route, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, 403);
  if (url.includes('/accounts?')) return json(route, { success: true, result: [{ id: ACCOUNT, name: 'Main' }] });
  return json(route, {
    success: true,
    result: [
      { id: 'h1', invoice_id: 'i1', amount: 5, currency: 'USD', description: 'Workers Paid', occurred_at: monthStart(0) },
      { id: 'h2', invoice_id: 'i0', amount: 5, currency: 'USD', description: 'Workers Paid', occurred_at: monthStart(-1) },
    ],
    result_info: { page: 1, per_page: 50, total_count: 2 },
  });
});
await context.route('https://api.github.com/**', (route) => {
  const url = route.request().url();
  seen.push(['github', url, route.request().headers().authorization]);
  if (url.endsWith('/user')) return json(route, { login: 'octo' });
  const q = new URL(url).searchParams;
  const date = new Date(Date.UTC(Number(q.get('year')), Number(q.get('month')) - 1, 2)).toISOString();
  const isThisMonth = date.slice(0, 7) === monthStart(0).slice(0, 7);
  return json(route, { usageItems: [{ date, product: 'actions', sku: 'linux', netAmount: isThisMonth ? 2.5 : 9, grossAmount: 4 }] });
});
await context.route('https://api.vercel.com/**', (route) => {
  const url = route.request().url();
  seen.push(['vercel', url, route.request().headers().authorization]);
  if (url.includes('/v2/teams')) return json(route, { teams: [{ id: 'team_abc', slug: 'acme', name: 'Acme' }] });
  const lines = [
    { ChargePeriodStart: monthStart(0), ServiceName: 'Pro Plan', BilledCost: '20', BillingCurrency: 'USD', ChargeCategory: 'Purchase' },
    { ChargePeriodStart: monthStart(0), ServiceName: 'Function Duration', BilledCost: 1.4, BillingCurrency: 'USD', ChargeCategory: 'Usage' },
  ].map((l) => JSON.stringify(l)).join('\n');
  return route.fulfill({ contentType: 'application/jsonl', body: lines });
});

const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extId = worker.url().split('/')[2];
const storage = (key) => worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
const errors = [];

async function connect(dash, provider, fill) {
  await dash.click('#cloud-add');
  await dash.click(`.provider-grid label:has(input[value=${provider}])`);
  for (const [name, value] of fill) await dash.fill(`#cloud-form [name=${name}]`, value);
  await dash.click('#cloud-submit');
}

try {
  const dash = await context.newPage();
  dash.on('pageerror', (e) => errors.push(e.message));
  await dash.setViewportSize({ width: 1280, height: 900 });
  await dash.goto(`chrome-extension://${extId}/src/dashboard.html#cloud`);

  // Cloudflare: 틀린 토큰은 이유와 함께 거절, 맞는 토큰은 계정을 찾아 청구 내역을 읽는다
  await connect(dash, 'cloudflare', [['cfToken', 'w'.repeat(40)]]);
  await dash.waitForFunction(() => /Billing Read/.test(document.querySelector('#cloud-status').textContent));
  await dash.fill('#cloud-form [name=cfToken]', CF_TOKEN);
  await dash.click('#cloud-submit');
  await dash.waitForSelector('.cloud-card.provider-cloudflare');
  assert.ok(seen.some(([p, u]) => p === 'cloudflare' && u.includes(`/accounts/${ACCOUNT}/billing/history`)));

  // GitHub: 토큰 주인의 이번 달·지난달 사용량
  await connect(dash, 'github', [['ghToken', GH_TOKEN]]);
  await dash.waitForSelector('.cloud-card.provider-github');
  assert.ok(seen.some(([p, u]) => p === 'github' && u.includes('/users/octo/settings/billing/usage')));

  // Vercel: 팀 목록 → 팀별 청구 요금(JSONL)
  await connect(dash, 'vercel', [['vcToken', VC_TOKEN]]);
  await dash.waitForSelector('.cloud-card.provider-vercel');
  assert.ok(seen.some(([p, u]) => p === 'vercel' && u.includes('/v1/billing/charges?teamId=team_abc')));

  const costs = await storage('cloudCosts');
  const byProvider = Object.fromEntries(Object.values(costs).map((c) => [c.provider, c]));
  assert.equal(byProvider.cloudflare.monthToDate, 5);
  assert.equal(byProvider.cloudflare.projected, 5, '월 1회 청구는 지난달·이번 달 중 큰 값');
  assert.equal(byProvider.github.monthToDate, 2.5);
  assert.equal(byProvider.vercel.monthToDate, 21.4);
  assert.ok(byProvider.vercel.projected == null || byProvider.vercel.projected < 30, 'Pro 요금 $20는 늘려 잡지 않는다');
  const publicText = JSON.stringify(costs);
  for (const secret of [CF_TOKEN, GH_TOKEN, VC_TOKEN]) assert.ok(!publicText.includes(secret), '화면용 저장소에 토큰이 섞이면 안 된다');

  // 고르기 화면에서 GitHub → 연결 화면, API가 안 되면 요금제로 직접 기록
  await dash.click('#add-btn');
  await dash.fill('#picker-form [name=q]', '깃허브');
  await dash.click('.picker-item:has-text("GitHub")');
  assert.equal(await dash.isChecked('#cloud-form input[value=github]'), true);
  await dash.screenshot({ path: path.join(SHOT_DIR, 'providers-dialog-github.png') });
  await dash.click('#cloud-manual');
  assert.equal(await dash.inputValue('#editor-form [name=site]'), 'github.com');
  assert.equal(await dash.inputValue('#editor-form [name=amount]'), '4');
  await dash.click('#cancel-btn');

  // 연결 마법사: 6개 서비스 모두 안내서·바로가기가 보이고, 버튼 하나로 토큰 만들기 화면이 열린다.
  // 확장이 연 탭은 route가 붙기 전에 나가 버려서, 실제 콘솔에 가지 않게 탭 열기만 가로채 주소를 확인한다.
  await dash.evaluate(() => {
    globalThis.openedTabs = [];
    chrome.tabs.create = async ({ url }) => { globalThis.openedTabs.push(url); return { id: 1 }; };
  });
  const openedBy = async (selector) => {
    const before = await dash.evaluate(() => globalThis.openedTabs.length);
    await dash.click(selector);
    await dash.waitForFunction((n) => globalThis.openedTabs.length > n, before);
    return new URL(await dash.evaluate(() => globalThis.openedTabs.at(-1)));
  };
  const OPEN_HOST = { aws: 'console.aws.amazon.com', openai: 'platform.openai.com', cloudflare: 'dash.cloudflare.com', github: 'github.com', vercel: 'vercel.com' };
  await dash.click('#cloud-add');
  for (const provider of ['aws', 'openai', 'cloudflare', 'github', 'vercel']) {
    await dash.click(`.provider-grid label:has(input[value=${provider}])`);
    const steps = await dash.locator('#cloud-guide > li').count();
    assert.ok(steps >= 3 && steps <= 5, `${provider} 안내서 ${steps}단계`);
    assert.ok(await dash.locator('#cloud-links a[href^="https://"]').count() >= 1, `${provider} 바로가기`);
    assert.doesNotMatch(await dash.textContent('#cloud-dialog'), /null|undefined/, `${provider} 안내에 빈 값이 찍히면 안 된다`);
    assert.equal(await dash.isVisible('#cloud-open-create'), true);
    assert.equal((await openedBy('#cloud-open-create')).host, OPEN_HOST[provider]);
  }
  await dash.click('.provider-grid label:has(input[value=cloudflare])');
  const cfUrl = await openedBy('#cloud-open-create');
  assert.deepEqual(JSON.parse(cfUrl.searchParams.get('permissionGroupKeys')), [{ key: 'billing', type: 'read' }]);
  assert.equal(await dash.isVisible('#cloud-prefill-note'), true);
  await dash.click('.provider-grid label:has(input[value=github])');
  assert.equal((await openedBy('#cloud-open-create')).searchParams.get('plan'), 'read');
  // GitHub 앱 ID가 비어 있는 설치본: 로그인 버튼 대신 안내만 보인다
  assert.equal(await dash.isVisible('#gh-login'), false);
  assert.equal(await dash.isVisible('#gh-login-missing'), true);
  await dash.fill('#cloud-form [name=ghOrg]', 'acme');
  const ghOrgUrl = await openedBy('#cloud-open-create');
  assert.equal(ghOrgUrl.searchParams.get('target_name'), 'acme');
  assert.equal(ghOrgUrl.searchParams.get('organization_administration'), 'read');
  await dash.click('.provider-grid label:has(input[value=aws])');
  // 템플릿 S3 주소가 비어 있는 설치본: 템플릿 파일 받기 + CloudFormation 업로드 화면 + IAM 링크
  const awsOpen = await openedBy('#cloud-open-create');
  assert.equal(awsOpen.pathname + awsOpen.hash, '/cloudformation/home#/stacks/create');
  assert.equal(await dash.isVisible('#cloud-prefill-note'), false);
  const templateHref = await dash.getAttribute('#cloud-guide a[download]', 'href');
  assert.match(templateHref, /^chrome-extension:\/\/[a-z]+\/aws\/readonly-cost-user\.json$/);
  const templateText = await dash.evaluate((href) => fetch(href).then((r) => r.text()), templateHref);
  assert.deepEqual(JSON.parse(templateText).Resources.CostReaderUser.Properties.Policies[0].PolicyDocument.Statement[0].Action, ['ce:GetCostAndUsage'], 'AWS 템플릿 파일');
  assert.ok(await dash.locator('#cloud-links a[href^="https://console.aws.amazon.com/iam/"]').count() >= 1, 'IAM 액세스 키 화면 링크');
  await dash.screenshot({ path: path.join(SHOT_DIR, 'providers-wizard-aws.png') });
  await dash.click('#cloud-cancel');

  await dash.screenshot({ path: path.join(SHOT_DIR, 'providers-dashboard.png'), fullPage: true });
  await dash.setViewportSize({ width: 375, height: 800 });
  await dash.click('#cloud-add');
  await dash.click('.provider-grid label:has(input[value=cloudflare])');
  await dash.screenshot({ path: path.join(SHOT_DIR, 'providers-dialog-mobile.png') });

  assert.deepEqual(errors, []);
  process.stdout.write('providers e2e ok\n');
} finally {
  await context.close();
}
