const { test } = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src/lib/catalog.js');

test('every catalog item has a unique id, a host-like site and a known category', () => {
  const ids = new Set();
  for (const item of K.ITEMS) {
    assert.ok(!ids.has(item.id), `duplicate id ${item.id}`);
    ids.add(item.id);
    assert.match(item.site, /^[a-z0-9.-]+\.[a-z]{2,}$/, item.id);
    assert.ok(K.CATEGORIES.some((c) => c.id === item.category), item.id);
  }
});

test('every plan has a positive amount, a supported currency and cycle', () => {
  for (const item of K.ITEMS) {
    for (const plan of item.plans || []) {
      assert.ok(plan.amount > 0, `${item.id}/${plan.name}`);
      assert.ok(['KRW', 'USD'].includes(plan.currency), `${item.id}/${plan.name}`);
      assert.ok(['monthly', 'yearly'].includes(plan.cycle), `${item.id}/${plan.name}`);
    }
  }
});

test('search matches names, Korean aliases and sites, ignoring case and spaces', () => {
  assert.ok(K.search('netflix').some((i) => i.id === 'netflix'));
  assert.ok(K.search('넷플').some((i) => i.id === 'netflix'));
  assert.ok(K.search('Chat GPT').some((i) => i.id === 'chatgpt'));
  assert.ok(K.search('aws.amazon').some((i) => i.id === 'aws'));
  assert.deepEqual(K.search('zzzz-nothing'), []);
});

test('search filters by category and returns everything for an empty query', () => {
  const ai = K.search('', 'ai');
  assert.ok(ai.length > 0 && ai.every((i) => i.category === 'ai'));
  assert.equal(K.search('').length, K.ITEMS.length);
});

test('findBySite matches subdomains of a catalog site', () => {
  assert.equal(K.findBySite('www.netflix.com').id, 'netflix');
  assert.equal(K.findBySite('netflix.com').id, 'netflix');
  assert.equal(K.findBySite('notnetflix.com'), null);
  assert.equal(K.findBySite(''), null);
});

test('recordFields turns a plan into subscription fields', () => {
  const item = K.ITEMS.find((i) => i.id === 'chatgpt');
  const fields = K.recordFields(item, item.plans[0]);
  assert.deepEqual(fields, {
    site: 'chatgpt.com', kind: 'subscription', cycle: item.plans[0].cycle,
    amount: item.plans[0].amount, currency: item.plans[0].currency, note: item.plans[0].name,
  });
});

test('recordFields without a plan leaves the amount for the user', () => {
  const item = K.ITEMS.find((i) => i.id === 'gcp');
  const fields = K.recordFields(item, null);
  assert.equal(fields.amount, null);
  assert.equal(fields.site, 'cloud.google.com');
  assert.equal(fields.cycle, 'monthly');
});

test('connectable items point at a provider the extension can connect', () => {
  const providers = new Set(K.ITEMS.filter((i) => i.connect).map((i) => i.connect));
  for (const p of providers) assert.ok(K.CONNECTORS.includes(p), p);
  assert.ok(K.ITEMS.find((i) => i.id === 'aws').connect === 'aws');
});

test('Azure 앱 ID가 비면 연결 가능 목록과 검색에서 Azure가 빠진다', () => {
  const empty = { AZURE_CLIENT_ID: '' };
  assert.ok(!K.connectableProviders(empty).includes('azure'));
  assert.ok(!K.search('', null, empty).some((i) => i.connect === 'azure'));
  assert.ok(!K.search('azure', null, empty).some((i) => i.id === 'azure'));
  assert.deepEqual(K.connectableProviders(empty), K.CONNECTORS.filter((p) => p !== 'azure'));
});

test('Azure 앱 ID를 채우면 다시 보인다', () => {
  const filled = { AZURE_CLIENT_ID: '00000000-0000-0000-0000-000000000000' };
  assert.ok(K.connectableProviders(filled).includes('azure'));
  assert.ok(K.search('azure', null, filled).some((i) => i.id === 'azure'));
});

test('설정을 안 넘기면 기존처럼 전부 보이고, 사이트로 찾는 것은 숨김과 무관하다', () => {
  assert.equal(K.search('').length, K.ITEMS.length);
  assert.equal(K.findBySite('azure.microsoft.com').id, 'azure');
});

test('실계정으로 확인된 서비스는 AWS뿐이고 나머지 연결 서비스는 베타다', () => {
  assert.deepEqual([...K.VERIFIED_PROVIDERS], ['aws']);
  assert.equal(K.isBeta('aws'), false);
  for (const p of ['openai', 'cloudflare', 'github', 'vercel']) assert.equal(K.isBeta(p), true, p);
  assert.equal(K.isBeta('azure'), true);
});

test('확인된 서비스 목록 하나만 고치면 베타 표시가 사라진다', () => {
  const verified = ['aws', 'github'];
  assert.equal(K.isBeta('github', verified), false);
  assert.equal(K.isBeta('vercel', verified), true);
});

test('베타 문의 링크는 GitHub 이슈 주소다', () => {
  assert.match(K.FEEDBACK_URL, /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues/);
});
