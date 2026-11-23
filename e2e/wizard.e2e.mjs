// 연결 마법사에서 배포자 설정(config.js)이 채워졌을 때의 흐름을 실제 Chromium에서 확인한다.
// - GitHub 로그인(device flow): 코드 표시 → 승인 대기(폴링) → 토큰 저장 → 사용료 읽기. 창을 닫으면 멈춘다.
// - AWS 빠른 생성: 템플릿 S3 주소가 있으면 CloudFormation 빠른 생성 링크로 연다.
// 설치본의 config.js 값은 비어 있어서, 대시보드 페이지의 설정 객체만 바꿔서 시험한다(파일은 그대로).
// github.com/login·api.github.com은 가짜 응답이고, 확장이 여는 탭은 가로채 주소만 확인한다(외부 요청 없음).
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.join(ROOT, 'e2e', 'screenshots');
const CLIENT_ID = 'Iv23liFAKEclientid00';
const UAT = `ghu_${'U1a2T3'.repeat(6)}`;
const RT = `ghr_${'R4t5K6'.repeat(10)}`;
const USER_CODE = 'WDJB-MJHT';
const TEMPLATE_URL = 'https://s3.us-east-1.amazonaws.com/example-bucket/readonly-cost-user.json';

const context = await chromium.launchPersistentContext('', {
  reducedMotion: 'reduce', // 금액 카운트업이 끝나기 전 글자를 읽지 않게
  channel: 'chromium',
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const loginCalls = [];
const errors = [];
let approve = false; // false면 "승인 대기 중"을 돌려준다
let deviceCount = 0; // 로그인마다 다른 device_code를 줘서 어느 로그인의 폴링인지 가린다

await context.route('https://open.er-api.com/**', (route) => json(route, { rates: { KRW: 1400 } }));
await context.route('https://github.com/login/**', (route) => {
  const req = route.request();
  const body = Object.fromEntries(new URLSearchParams(req.postData() || ''));
  loginCalls.push({ path: new URL(req.url()).pathname, method: req.method(), body });
  if (req.url().endsWith('/login/device/code')) {
    deviceCount += 1;
    return json(route, { device_code: `dc-${deviceCount}`, user_code: USER_CODE, verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
  }
  if (!approve) return json(route, { error: 'authorization_pending' });
  return json(route, { access_token: UAT, refresh_token: RT, expires_in: 28800, refresh_token_expires_in: 15897600, token_type: 'bearer' });
});
await context.route('https://api.github.com/**', (route) => {
  const url = route.request().url();
  if (route.request().headers().authorization !== `Bearer ${UAT}`) return json(route, { message: 'Bad credentials' }, 401);
  if (url.endsWith('/user')) return json(route, { login: 'octo' });
  const q = new URL(url).searchParams;
  const date = new Date(Date.UTC(Number(q.get('year')), Number(q.get('month')) - 1, 2)).toISOString();
  return json(route, { usageItems: [{ date, product: 'actions', sku: 'linux', netAmount: 1.5, grossAmount: 1.5 }] });
});

const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extId = worker.url().split('/')[2];
const local = (key) => worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
const pollsFor = (deviceCode, from = 0) => loginCalls.slice(from)
  .filter((c) => c.path === '/login/oauth/access_token' && c.body.device_code === deviceCode).length;

async function openGithub(dash) {
  await dash.click('#cloud-add');
  await dash.click('.provider-grid label:has(input[value=github])');
  assert.equal(await dash.isVisible('#gh-login'), true, '앱 ID가 있으면 로그인 버튼이 보인다');
  assert.equal(await dash.isVisible('#gh-login-missing'), false);
}

// 승인 전에 창을 닫으면 폴링을 멈추고 아무것도 저장하지 않는다.
async function cancelledLogin(dash) {
  await openGithub(dash);
  await dash.click('#gh-login');
  await dash.waitForFunction((code) => document.querySelector('#gh-user-code')?.textContent === code, USER_CODE);
  await dash.waitForFunction(() => /승인을 기다리는 중/.test(document.querySelector('#cloud-status').textContent));
  await dash.click('#cloud-cancel');
  assert.equal(await dash.isVisible('#gh-device'), false, '닫으면 코드가 사라진다');
  return loginCalls.length; // 이 뒤로 dc-1 폴링이 늘지 않는지는 다음 로그인이 승인을 기다린 뒤 본다
}

async function approvedLogin(dash, cancelledAt) {
  await openGithub(dash);
  await dash.fill('#cloud-form [name=label]', '내 GitHub');
  const callsBefore = loginCalls.length;
  await dash.click('#gh-login');
  await dash.waitForFunction((code) => document.querySelector('#gh-user-code')?.textContent === code, USER_CODE);
  const link = await dash.getAttribute('#gh-device a', 'href');
  assert.equal(link, 'https://github.com/login/device', '코드 넣는 화면은 github.com');
  // 한 번은 "대기 중"을 받은 뒤 승인한다
  await dash.waitForFunction(() => /승인을 기다리는 중/.test(document.querySelector('#cloud-status').textContent));
  await waitForPoll('dc-2', callsBefore); // 승인 전 "대기 중"을 한 번 받는다(간격 1초)
  // 닫은 로그인(dc-1)은 닫을 때 이미 나간 요청 하나까지만 허용하고 더 묻지 않는다
  assert.ok(pollsFor('dc-1', cancelledAt) <= 1, '닫은 로그인은 더 묻지 않는다');
  await dash.screenshot({ path: path.join(SHOT_DIR, 'wizard-github-code.png') });
  approve = true;
  await dash.waitForSelector('.cloud-card.provider-github');
  assert.equal(await dash.isVisible('#cloud-dialog'), false);
}

async function waitForPoll(deviceCode, from) {
  const deadline = Date.now() + 15000;
  while (pollsFor(deviceCode, from) === 0) {
    if (Date.now() > deadline) throw new Error(`기다리다 멈춤: ${deviceCode} 폴링`);
    await new Promise((r) => { setTimeout(r, 50); });
  }
}

async function checkSavedLogin() {
  const accounts = await local('cloudAccounts');
  assert.equal(accounts.length, 1, '닫은 로그인은 저장되지 않고 승인된 하나만 남는다');
  const { credentials, label } = accounts[0];
  assert.equal(label, '내 GitHub');
  assert.equal(credentials.accessToken, UAT);
  assert.equal(credentials.refreshToken, RT);
  assert.ok(credentials.expiresAt > Date.now(), '만료 시각을 저장한다');
  assert.equal(credentials.token, undefined);
  for (const call of loginCalls) {
    assert.equal(call.method, 'POST');
    assert.equal(call.body.client_id, CLIENT_ID);
    assert.equal(call.body.client_secret, undefined, '비밀키는 보내지 않는다');
  }
  const polls = loginCalls.filter((c) => c.path === '/login/oauth/access_token');
  assert.ok(polls.every((c) => c.body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code' && /^dc-[12]$/.test(c.body.device_code)));
  const costs = Object.values(await local('cloudCosts'));
  assert.equal(costs[0].monthToDate, 1.5);
  assert.ok(!JSON.stringify(costs).includes(UAT) && !JSON.stringify(costs).includes(RT), '화면용 저장소에 토큰이 섞이면 안 된다');
}

// 템플릿 S3 주소가 있으면 빠른 생성 링크(템플릿·스택 이름이 채워진 화면)로 연다.
async function awsQuickCreate(dash) {
  await dash.evaluate(() => {
    globalThis.openedTabs = [];
    chrome.tabs.create = async ({ url }) => { globalThis.openedTabs.push(url); return { id: 1 }; };
  });
  await dash.click('#cloud-add');
  await dash.click('.provider-grid label:has(input[value=aws])');
  assert.equal(await dash.isVisible('#cloud-prefill-note'), true, '빠른 생성은 미리 채운 안내');
  assert.equal(await dash.locator('#cloud-guide a[download]').count(), 0, '파일 받기 안내는 없다');
  assert.match(await dash.textContent('#cloud-guide'), /IAM 리소스를 생성할 수 있음을 확인/);
  await dash.click('#cloud-open-create');
  await dash.waitForFunction(() => globalThis.openedTabs.length === 1);
  const opened = new URL(await dash.evaluate(() => globalThis.openedTabs[0]));
  assert.equal(opened.host, 'us-east-1.console.aws.amazon.com');
  assert.equal(opened.pathname, '/cloudformation/home');
  const [route, query] = opened.hash.slice(1).split('?');
  assert.equal(route, '/stacks/create/review');
  const params = new URLSearchParams(query);
  assert.equal(params.get('templateURL'), TEMPLATE_URL);
  assert.equal(params.get('stackName'), 'payment-tracker-cost-reader');
  await dash.screenshot({ path: path.join(SHOT_DIR, 'wizard-aws-quick-create.png') });
  await dash.click('#cloud-cancel');
}

try {
  const dash = await context.newPage();
  dash.on('pageerror', (e) => errors.push(e.message));
  await dash.setViewportSize({ width: 1280, height: 900 });
  await dash.goto(`chrome-extension://${extId}/src/dashboard.html#cloud`);
  await dash.evaluate(({ id, url }) => {
    globalThis.PaymentCloudConfig.GITHUB_CLIENT_ID = id;
    globalThis.PaymentCloudConfig.AWS_TEMPLATE_URL = url;
  }, { id: CLIENT_ID, url: TEMPLATE_URL });

  const cancelledAt = await cancelledLogin(dash);
  await approvedLogin(dash, cancelledAt);
  await checkSavedLogin();
  await awsQuickCreate(dash);

  assert.deepEqual(errors, []);
  process.stdout.write('wizard e2e ok\n');
} finally {
  await context.close();
}
