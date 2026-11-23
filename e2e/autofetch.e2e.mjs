// 토큰 자동 받기(easy-connect Step 3)를 실제 Chromium에서 확인한다.
// 콘솔 화면은 가짜 페이지(context.route)이고, 실제 GitHub·Cloudflare·AWS·Vercel·OpenAI에는 요청이 나가지 않는다.
// 확장이 연 탭의 첫 요청은 route보다 먼저 나가서, 탭은 about:blank로 열고 Playwright가 주소로 옮긴다.
// "읽지 않는다"는 고정 시간 대기 대신, background가 그 탭의 이동을 처리한 뒤(probe.settled) 주입 횟수로 확인한다.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.join(ROOT, 'e2e', 'screenshots');
const GH_TOKEN = `github_pat_${'A1b2C3'.repeat(14)}`;
const GH_OTHER = `github_pat_${'Z9y8X7'.repeat(14)}`;
const CF_TOKEN = 'Cf7_kq2Z'.repeat(5);
const CF_DECOY = 'Dx3_mm8Q'.repeat(5);
const CF_PASSWORD = 'Pw4kR9zQ'.repeat(5); // 40자 영문·숫자: Cloudflare 토큰 모양과 같다
const AWS_ID = 'AKIAFAKE1234567890AB';
const AWS_SECRET = 'fAkE/sEcReT+kEy0123456789abcdefGHIJKLmno';
const VC_TOKEN = `vcp_${'Vq3x'.repeat(8)}`;
const OA_KEY = `sk-admin-${'Oa9k'.repeat(10)}`;
const SECRETS = [GH_TOKEN, GH_OTHER, CF_TOKEN, CF_DECOY, CF_PASSWORD, AWS_SECRET, VC_TOKEN, OA_KEY];
const UNTIL_MS = 15000;
const POLL_MS = 50;

const context = await chromium.launchPersistentContext('', {
  reducedMotion: 'reduce', // 금액 카운트업이 끝나기 전 글자를 읽지 않게
  channel: 'chromium',
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const html = (route, body) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body>${body}</body>` });
const logs = [];
const errors = [];

// 가짜 완료 화면: "만들기" 버튼을 누르면 같은 페이지에서 완료 화면으로 바뀐다(SPA처럼).
const revealPage = (title, button, done) => `<h1>${title}</h1><button id="gen">${button}</button>
<script>document.getElementById('gen').onclick = () => { document.body.innerHTML = ${JSON.stringify(done)}; };</script>`;
const GH_NEW_PAGE = revealPage('New fine-grained personal access token', 'Generate token',
  `<p>Make sure to copy your personal access token now.</p><clipboard-copy value="${GH_TOKEN}"></clipboard-copy><code id="new-token">${GH_TOKEN}</code>`);
// 완료 화면에 토큰 모양의 비밀번호 칸이 같이 있어도 비밀번호 칸은 읽지 않는다(둘 다 읽으면 후보가 둘이라 못 받는다).
const CF_DONE_PAGE = `<h1>결제 기록장 사용료 읽기 API token was successfully created</h1><input readonly value="${CF_TOKEN}">
<label>Confirm password <input type="password" value="${CF_PASSWORD}"></label>
<pre>curl "https://api.cloudflare.com/client/v4/user/tokens/verify" -H "Authorization: Bearer ${CF_TOKEN}"</pre>`;
const CF_LOGIN_PAGE = `<h1>Log in to Cloudflare</h1><input type="email" value="me@example.com">
<input type="password" value="${CF_PASSWORD}"><button>Log in</button>`;
const AWS_KEYS_PAGE = `<h1>Retrieve access keys</h1><table><tr><td><code>${AWS_ID}</code></td><td><code>${AWS_SECRET}</code></td></tr></table>`;
const VC_PAGE = revealPage('Account Tokens', 'Create', `<p>Copy your token now.</p><input readonly value="${VC_TOKEN}">`);
const OA_PAGE = revealPage('Admin keys', 'Create new admin key', `<p>Save your key</p><code>${OA_KEY}</code>`);

await context.route('https://open.er-api.com/**', (route) => json(route, { rates: { KRW: 1400 } }));
await context.route('https://github.com/**', (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === '/settings/personal-access-tokens/new') return html(route, GH_NEW_PAGE);
  return html(route, `<p>Your new token</p><code>${GH_OTHER}</code>`); // 연결 버튼으로 열지 않은 탭에서 보이는 토큰
});
await context.route('https://dash.cloudflare.com/**', (route) => (
  new URL(route.request().url()).pathname.startsWith('/login') ? html(route, CF_LOGIN_PAGE) : html(route, CF_DONE_PAGE)));
// 가짜 AWS 콘솔: CloudFormation 화면에는 키가 없고, 같은 탭으로 옮긴 IAM 액세스 키 완료 화면에 두 값이 보인다.
const awsPage = (route) => (new URL(route.request().url()).pathname.startsWith('/iam')
  ? html(route, AWS_KEYS_PAGE) : html(route, '<h1>Create stack</h1><p>Upload a template file</p>'));
await context.route('https://console.aws.amazon.com/**', awsPage);
await context.route('https://*.console.aws.amazon.com/**', awsPage);
await context.route('https://vercel.com/**', (route) => html(route, VC_PAGE));
await context.route('https://platform.openai.com/**', (route) => html(route, OA_PAGE));
await context.route('https://not-cloudflare.example/**', (route) => html(route, `<code>${CF_DECOY}</code>`));
await context.route('https://api.github.com/**', (route) => {
  const url = route.request().url();
  if (route.request().headers().authorization !== `Bearer ${GH_TOKEN}`) return json(route, { message: 'Bad credentials' }, 401);
  if (url.endsWith('/user')) return json(route, { login: 'octo' });
  const q = new URL(url).searchParams;
  const date = new Date(Date.UTC(Number(q.get('year')), Number(q.get('month')) - 1, 2)).toISOString();
  return json(route, { usageItems: [{ date, product: 'actions', sku: 'linux', netAmount: 3, grossAmount: 3 }] });
});
await context.route('https://api.vercel.com/**', (route) => {
  if (route.request().headers().authorization !== `Bearer ${VC_TOKEN}`) return json(route, { error: { code: 'forbidden' } }, 403);
  if (route.request().url().includes('/v2/teams')) return json(route, { teams: [{ id: 'team_abc', slug: 'acme', name: 'Acme' }] });
  const line = { ChargePeriodStart: new Date().toISOString(), ServiceName: 'Pro Plan', BilledCost: '20', BillingCurrency: 'USD', ChargeCategory: 'Purchase' };
  return route.fulfill({ contentType: 'application/jsonl', body: JSON.stringify(line) });
});
await context.route('https://api.cloudflare.com/**', (route) => json(route, { success: false, errors: [{ code: 10000, message: 'unexpected' }] }, 500));
context.on('console', (m) => logs.push(m.text()));

const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
worker.on('console', (m) => logs.push(m.text()));
const extId = worker.url().split('/')[2];
const local = (key) => worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
const session = (key) => worker.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, key);
const foundCredentials = async () => ((await session('autofetchFound')) || {}).credentials || null;

// 시험용 관찰 장치. 읽기 스크립트 주입(calls=파일 주입, started=시작 완료)과,
// background가 탭 이동을 처리한 뒤의 시점(settled)을 남긴다. 확장 코드는 바꾸지 않는다.
await worker.evaluate(() => {
  const probe = { calls: [], started: [], settled: [] };
  globalThis.probe = probe;
  const real = chrome.scripting.executeScript.bind(chrome.scripting);
  chrome.scripting.executeScript = (opts) => {
    if (!opts.func) probe.calls.push(opts.target.tabId);
    return real(opts).then((out) => { if (opts.func) probe.started.push(opts.target.tabId); return out; });
  };
  const count = (list, tabId) => list.filter((id) => id === tabId).length;
  // 확장의 onCompleted 리스너가 먼저 등록돼 있다. 저장소 왕복 한 번 + 다음 턴이면 그 리스너의 주입 판단이 끝난다.
  chrome.webNavigation.onCompleted.addListener(async ({ tabId, frameId, url }) => {
    if (frameId !== 0) return;
    await chrome.storage.session.get(null);
    await new Promise((r) => { setTimeout(r, 0); });
    probe.settled.push({ tabId, url, calls: count(probe.calls, tabId) });
  });
});

async function until(probeFn, what) {
  const deadline = Date.now() + UNTIL_MS;
  for (;;) {
    const value = await probeFn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`기다리다 멈춤: ${what}`);
    await new Promise((r) => { setTimeout(r, POLL_MS); });
  }
}

// 탭을 옮기고, background가 그 이동을 처리할 때까지 기다린다. {tabId, calls(그 탭에 넣은 횟수)}
async function visit(tab, url) {
  const since = await worker.evaluate(() => globalThis.probe.settled.length);
  await tab.goto(url);
  const href = tab.url();
  return until(() => worker.evaluate(({ from, target }) => globalThis.probe.settled.slice(from)
    .find((s) => s.url === target) || null, { from: since, target: href }), `${href} 처리`);
}

// 읽기 스크립트가 들어가 첫 검사를 마칠 때까지 기다린다.
const scanned = (tabId) => until(() => worker.evaluate((id) => globalThis.probe.started.includes(id), tabId), '읽기 스크립트 시작');

// 버튼이 연 탭을 받는다. 탭 주소는 확장이 의도한 주소 대신 about:blank다.
async function openViaButton(dash, provider) {
  await dash.click('#cloud-add');
  await dash.click(`.provider-grid label:has(input[value=${provider}])`);
  const pagePromise = context.waitForEvent('page');
  await dash.click('#cloud-open-create');
  const tab = await pagePromise;
  tab.on('pageerror', (e) => errors.push(e.message));
  await dash.waitForSelector('#cloud-autofill:not([hidden])');
  return tab;
}

async function declineAndClose(dash, tab) {
  await dash.click('#cloud-autofill-no');
  assert.equal(await dash.isVisible('#cloud-autofill'), false);
  await dash.waitForFunction(() => /붙여 넣어 주세요/.test(document.querySelector('#cloud-status').textContent));
  assert.equal(await session('autofetchFound'), null, '거절하면 읽은 값을 지운다');
  await dash.click('#cloud-cancel');
  await tab.close();
}

async function githubFlow(dash, intendedUrl) {
  const ghTab = await openViaButton(dash, 'github');
  assert.match(await dash.textContent('#cloud-autofill'), /자동으로 가져와요/);
  assert.equal((await session('autofetchWatch')).provider, 'github');

  // 버튼으로 열지 않은 탭: 같은 GitHub 화면에 토큰이 보여도 읽기 스크립트를 넣지 않는다
  const stranger = await context.newPage();
  const strangerVisit = await visit(stranger, 'https://github.com/settings/personal-access-tokens');
  assert.equal(strangerVisit.calls, 0, '연결 버튼으로 열지 않은 탭은 읽지 않는다');
  await stranger.close();

  // 버튼으로 연 탭: 만들기 전에는 아무것도 없고, 완료 화면이 뜨면 확인을 묻는다
  const ghVisit = await visit(ghTab, await intendedUrl());
  assert.equal(ghVisit.calls, 1, '버튼으로 연 탭의 GitHub 화면에는 넣는다');
  await scanned(ghVisit.tabId);
  assert.equal(await session('autofetchFound'), null);
  await ghTab.click('#gen');
  await dash.waitForSelector('#cloud-autofill-yes');
  const question = await dash.textContent('#cloud-autofill');
  assert.match(question, /이 토큰으로 연결할까요\?/);
  assert.ok(question.includes(GH_TOKEN.slice(-4)) && !question.includes(GH_TOKEN), '대시보드엔 가린 값만');
  assert.deepEqual(await foundCredentials(), { token: GH_TOKEN }, '다른 탭의 토큰이 아니라 이 탭의 토큰');
  assert.equal(await local('cloudAccounts'), undefined, '확인 전에는 저장하지 않는다');
  assert.equal(await session('autofetchWatch'), null, '찾은 뒤에는 더 지켜보지 않는다');
  await dash.screenshot({ path: path.join(SHOT_DIR, 'autofetch-confirm.png') });

  await dash.click('#cloud-autofill-yes');
  await dash.waitForSelector('.cloud-card.provider-github');
  const accounts = await local('cloudAccounts');
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].credentials.token, GH_TOKEN);
  assert.equal(await session('autofetchFound'), null, '저장 후 읽은 값은 지운다');
  assert.equal(await dash.isVisible('#cloud-dialog'), false);
  await ghTab.close();
}

// 지켜보는 탭이라도 Cloudflare가 아닌 사이트·로그인 화면은 읽지 않고, "아니요"를 누르면 저장 없이 붙여넣기로
async function cloudflareFlow(dash, intendedUrl) {
  const cfTab = await openViaButton(dash, 'cloudflare');
  assert.equal((await visit(cfTab, 'https://not-cloudflare.example/token')).calls, 0, '다른 사이트로 옮긴 탭은 읽지 않는다');
  assert.equal((await visit(cfTab, 'https://dash.cloudflare.com/login')).calls, 0, '로그인 화면은 읽지 않는다');
  assert.equal(await dash.isVisible('#cloud-autofill-yes'), false, '로그인 화면에선 확인을 묻지 않는다');
  await visit(cfTab, await intendedUrl());
  await dash.waitForSelector('#cloud-autofill-yes');
  assert.ok((await dash.textContent('#cloud-autofill')).includes(CF_TOKEN.slice(-4)));
  assert.deepEqual(await foundCredentials(), { apiToken: CF_TOKEN }, '비밀번호 칸 값은 후보에 들지 않는다');
  assert.equal(await dash.isVisible('#cloud-form [name=cfToken]'), true, '붙여넣기 칸은 그대로');
  await declineAndClose(dash, cfTab);
  assert.equal((await local('cloudAccounts')).length, 1, '거절하면 저장하지 않는다');
}

// 스택 만들기 화면을 연 탭을 그대로 IAM 액세스 키 화면으로 옮기면 두 값을 함께 받는다. 비밀키는 화면에 안 나온다.
async function awsFlow(dash, intendedUrl) {
  const awsTab = await openViaButton(dash, 'aws');
  const stackVisit = await visit(awsTab, await intendedUrl());
  assert.equal(new URL(awsTab.url()).pathname, '/cloudformation/home');
  await scanned(stackVisit.tabId);
  assert.equal(await session('autofetchFound'), null, '스택 화면에는 키가 없다');
  await visit(awsTab, 'https://us-east-1.console.aws.amazon.com/iam/home#/users/details/payment-tracker-cost-reader/create-access-key');
  await dash.waitForSelector('#cloud-autofill-yes');
  const awsQuestion = await dash.textContent('#cloud-autofill');
  assert.ok(awsQuestion.includes(AWS_ID.slice(-4)) && !awsQuestion.includes(AWS_SECRET.slice(4, -4)), '비밀키는 가린 값에도 없다');
  assert.deepEqual(await foundCredentials(), { accessKeyId: AWS_ID, secretAccessKey: AWS_SECRET });
  await dash.screenshot({ path: path.join(SHOT_DIR, 'autofetch-aws.png') });
  await declineAndClose(dash, awsTab);
}

// Vercel: 미리 채우기 없이 화면만 연다. 완료 화면의 vcp_ 토큰을 받아 연결까지 한다.
async function vercelFlow(dash, intendedUrl) {
  const vcTab = await openViaButton(dash, 'vercel');
  assert.equal(new URL(await intendedUrl()).href, 'https://vercel.com/account/tokens');
  await scanned((await visit(vcTab, await intendedUrl())).tabId);
  assert.equal(await session('autofetchFound'), null);
  await vcTab.click('#gen');
  await dash.waitForSelector('#cloud-autofill-yes');
  assert.deepEqual(await foundCredentials(), { token: VC_TOKEN });
  await dash.click('#cloud-autofill-yes');
  await dash.waitForSelector('.cloud-card.provider-vercel');
  const saved = (await local('cloudAccounts')).find((a) => a.provider === 'vercel');
  assert.equal(saved.credentials.token, VC_TOKEN);
  await vcTab.close();
}

// OpenAI: Admin keys 화면에서 sk-admin- 키를 받고, 거절하면 저장하지 않는다.
async function openaiFlow(dash, intendedUrl) {
  const oaTab = await openViaButton(dash, 'openai');
  await scanned((await visit(oaTab, await intendedUrl())).tabId);
  await oaTab.click('#gen');
  await dash.waitForSelector('#cloud-autofill-yes');
  assert.ok((await dash.textContent('#cloud-autofill')).includes('sk-admin-…'));
  assert.deepEqual(await foundCredentials(), { adminKey: OA_KEY });
  await declineAndClose(dash, oaTab);
  assert.ok(!(await local('cloudAccounts')).some((a) => a.provider === 'openai'), '거절하면 저장하지 않는다');
}

try {
  const dash = await context.newPage();
  dash.on('pageerror', (e) => errors.push(e.message));
  await dash.setViewportSize({ width: 1280, height: 900 });
  await dash.goto(`chrome-extension://${extId}/src/dashboard.html#cloud`);
  await dash.evaluate(() => {
    const realCreate = chrome.tabs.create.bind(chrome.tabs);
    globalThis.intended = [];
    chrome.tabs.create = ({ url }) => { globalThis.intended.push(url); return realCreate({ url: 'about:blank' }); };
  });
  const intendedUrl = () => dash.evaluate(() => globalThis.intended.at(-1));

  await githubFlow(dash, intendedUrl);
  await cloudflareFlow(dash, intendedUrl);
  await awsFlow(dash, intendedUrl);
  await vercelFlow(dash, intendedUrl);
  await openaiFlow(dash, intendedUrl);

  const leaked = logs.filter((line) => SECRETS.some((s) => line.includes(s)));
  assert.deepEqual(leaked, [], '토큰이 로그에 남으면 안 된다');
  const publicText = JSON.stringify(await local('cloudCosts'));
  assert.ok(![GH_TOKEN, VC_TOKEN].some((s) => publicText.includes(s)), '화면용 저장소에 토큰이 섞이면 안 된다');
  assert.deepEqual(errors, []);
  process.stdout.write('autofetch e2e ok\n');
} finally {
  await context.close();
}
