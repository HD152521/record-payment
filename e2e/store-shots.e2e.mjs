// 웹스토어용 스크린샷 5장(1280x800): 이번 달, 빠른 추가, 서버·API, 달마다, 팝업.
// 데이터는 전부 가짜(구독 6개, AWS·OpenAI 가짜 응답, 가짜 키). 실제 계정·키는 쓰지 않는다.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'e2e', 'store-shots');
const WIDTH = 1280;
const HEIGHT = 800;
const SHOTS = ['1-home.png', '2-quick-add.png', '3-cloud.png', '4-trends.png', '5-popup.png'];
const FAKE_AWS_KEY = 'AKIAABCDEFGHIJKLMNOP';
const FAKE_OPENAI_KEY = 'sk-admin-fake-store-shot';

const now = new Date();
const ymd = (offset) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
const AWS_RESPONSE = {
  ResultsByTime: [
    { TimePeriod: { Start: ymd(-1) }, Groups: [{ Keys: ['Amazon Elastic Container Service'], Metrics: { UnblendedCost: { Amount: '58', Unit: 'USD' } } }] },
    { TimePeriod: { Start: ymd(0) }, Groups: [
      { Keys: ['Amazon Elastic Container Service'], Metrics: { UnblendedCost: { Amount: '17.8', Unit: 'USD' } } },
      { Keys: ['Amazon Relational Database Service'], Metrics: { UnblendedCost: { Amount: '7.31', Unit: 'USD' } } },
      { Keys: ['Amazon ElastiCache'], Metrics: { UnblendedCost: { Amount: '4.66', Unit: 'USD' } } },
    ] },
  ],
};
const OPENAI_RESPONSE = {
  data: [{ start_time: Date.parse(`${ymd(0)}T00:00:00Z`) / 1000, results: [{ amount: { value: 6.4, currency: 'usd' }, line_item: 'gpt-5, input' }] }],
  has_more: false,
};
const SUBSCRIPTIONS = [
  { id: 's1', site: 'netflix.com', amount: 13500, currency: 'KRW', note: '스탠다드' },
  { id: 's2', site: 'spotify.com', amount: 10900, currency: 'KRW', note: '' },
  { id: 's3', site: 'notion.so', amount: 10, currency: 'USD', note: '' },
  { id: 's4', site: 'cursor.com', amount: 20, currency: 'USD', note: 'Pro' },
  { id: 's5', site: 'midjourney.com', amount: 10, currency: 'USD', note: 'Basic' },
  { id: 's6', site: 'adobe.com', amount: 24000, currency: 'KRW', note: '' },
];

function readPngSize(buffer) {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG', 'PNG 파일이어야 한다');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

await fs.rm(OUT_DIR, { recursive: true, force: true });
await fs.mkdir(OUT_DIR, { recursive: true });

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
await context.route('https://ce.us-east-1.amazonaws.com/', (route) =>
  route.fulfill({ contentType: 'application/x-amz-json-1.1', body: JSON.stringify(AWS_RESPONSE) }));
await context.route('https://api.openai.com/**', (route) =>
  route.fulfill({ contentType: 'application/json', body: JSON.stringify(OPENAI_RESPONSE) }));
await context.route('https://open.er-api.com/**', (route) =>
  route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: 'success', rates: { KRW: 1400 } }) }));
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extId = worker.url().split('/')[2];
const pageErrors = [];
const shot = (page, name) => page.screenshot({ path: path.join(OUT_DIR, name) });

// 설치 직후 확장이 안내 상태(started)를 저장하므로, 그 저장이 끝난 뒤에 덮어써야 안내 카드가 안 찍힌다.
await worker.evaluate(() => new Promise((resolve) => {
  const check = () => chrome.storage.local.get('settings')
    .then(({ settings }) => (settings && settings.onboarding && settings.onboarding.started ? resolve() : setTimeout(check, 50)));
  check();
}));

// 구독 6개: 5달 전부터 매달(이번 달 결제일이 오늘 이후·이전 섞이도록 날짜를 흩뿌린다)
await worker.evaluate((subs) => {
  const at = (n, d) => new Date(new Date().getFullYear(), new Date().getMonth() - n, d).getTime();
  const base = { kind: 'subscription', cycle: 'monthly', trial: false, status: 'active', canceledAt: null, review: 'confirmed', userEdited: true, evidence: [], pg: null, card: { brand: 'Visa', last4: '4242' } };
  const records = subs.map((s, i) => ({ ...base, ...s, startedAt: at(5 - (i % 3), 3 + i * 4), createdAt: at(5 - (i % 3), 3 + i * 4), updatedAt: at(5 - (i % 3), 3 + i * 4) }));
  // 스토어 사진에는 첫 실행 안내 카드를 빼고 찍는다(이미 다 끝낸 사용자 화면)
  return chrome.storage.local.set({ records, cards: [{ brand: 'Visa', last4: '4242', label: '내 카드' }], settings: { onboarding: { started: true, dismissed: true } } });
}, SUBSCRIPTIONS);

async function connect(dash, provider, fill) {
  await dash.click('#cloud-add');
  if (provider !== 'aws') await dash.click(`.provider-grid label:has(input[value=${provider}])`);
  await fill();
  await dash.click('#cloud-submit');
  await dash.waitForFunction(() => !document.querySelector('#cloud-dialog').open);
  await dash.waitForSelector(`.cloud-card.provider-${provider}`);
}

try {
  const dash = await context.newPage();
  dash.on('pageerror', (e) => pageErrors.push(e.message));
  await dash.setViewportSize({ width: WIDTH, height: HEIGHT });

  // 서버·API 연결(가짜 응답)
  await dash.goto(`chrome-extension://${extId}/src/dashboard.html#cloud`);
  await dash.waitForSelector('#cloud-empty:not([hidden])');
  await connect(dash, 'aws', async () => {
    await dash.fill('input[name=accessKeyId]', FAKE_AWS_KEY);
    await dash.fill('input[name=secretAccessKey]', 'x'.repeat(40));
    await dash.fill('#cloud-form input[name=label]', '회사 AWS');
  });
  await connect(dash, 'openai', async () => {
    await dash.fill('input[name=adminKey]', FAKE_OPENAI_KEY);
    await dash.fill('#cloud-form input[name=label]', '팀 OpenAI');
  });
  // 지난달 최종값을 넣어 달마다 그래프에 서버 사용료가 보이게 한다
  await worker.evaluate(() => chrome.storage.local.get('cloudAccounts').then(({ cloudAccounts }) => {
    const [aws, openai] = cloudAccounts;
    const pad = (n) => String(n).padStart(2, '0');
    const history = {};
    for (let back = 1; back <= 4; back += 1) {
      const d = new Date(new Date().getFullYear(), new Date().getMonth() - back, 1);
      history[`${d.getFullYear()}-${pad(d.getMonth() + 1)}`] = {
        [aws.id]: { amount: 40 + back * 6, currency: 'USD', final: true },
        [openai.id]: { amount: 3 + back, currency: 'USD', final: true },
      };
    }
    return chrome.storage.local.set({ cloudHistory: history });
  }));
  await dash.waitForFunction(() => /원$/.test(document.querySelector('#cloud-total').textContent) && document.querySelector('#cloud-total').textContent !== '0원');
  await shot(dash, SHOTS[2]);

  // 1) 이번 달
  await dash.click('#tabs a[data-page=home]');
  await dash.waitForFunction(() => document.querySelector('#monthly-total').textContent !== '0원');
  await shot(dash, SHOTS[0]);

  // 2) 빠른 추가: 이미 담은 구독과 겹치지 않게 다른 서비스를 고른다
  await dash.click('#add-btn');
  await dash.waitForSelector('#picker-list .picker-item');
  await dash.fill('#picker-form [name=q]', '유튜브');
  await dash.click('.picker-item:has-text("YouTube")');
  await dash.fill('#picker-form [name=q]', '');
  await dash.click('#picker-cats button:has-text("AI")');
  await dash.click('.picker-item:has-text("ChatGPT")');
  await dash.waitForFunction(() => /개 추가/.test(document.querySelector('#picker-submit').textContent));
  await shot(dash, SHOTS[1]);
  await dash.keyboard.press('Escape');
  await dash.waitForFunction(() => !document.querySelector('#picker').open);

  // 4) 달마다 그래프
  await dash.click('#tabs a[data-page=trends]');
  await dash.waitForFunction(() => document.querySelectorAll('#trend-chart .bar').length === 12);
  await shot(dash, SHOTS[3]);

  // 5) 팝업: 1280x800 화면 가운데에 실제 팝업 크기로 놓는다(문구·이미지 합성 없음)
  const pop = await context.newPage();
  pop.on('pageerror', (e) => pageErrors.push(e.message));
  await pop.setViewportSize({ width: WIDTH, height: HEIGHT });
  await pop.goto(`chrome-extension://${extId}/src/popup.html`);
  await pop.waitForFunction(() => document.querySelector('#cloud-line').textContent !== '');
  await dash.bringToFront();
  await dash.click('#tabs a[data-page=home]');
  assert.equal(await pop.textContent('#total'), await dash.textContent('#monthly-total'), '팝업과 홈의 이번 달 예상이 같아야 한다');
  await pop.addStyleTag({ content: 'html { background: var(--paper-sunk); min-height: 100vh; } body { margin: 120px auto 0; background: var(--paper); border-radius: var(--radius); box-shadow: var(--shadow); }' });
  await shot(pop, SHOTS[4]);

  // 검증: 5장 모두 1280x800 PNG
  for (const name of SHOTS) {
    const size = readPngSize(await fs.readFile(path.join(OUT_DIR, name)));
    assert.deepEqual(size, { width: WIDTH, height: HEIGHT }, `${name} 크기`);
  }
  assert.deepEqual((await fs.readdir(OUT_DIR)).sort(), [...SHOTS].sort());
  assert.deepEqual(pageErrors, []);
  process.stdout.write('store-shots e2e ok\n');
} finally {
  await context.close();
}
