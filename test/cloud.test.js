const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/lib/cloud/costs.js');
const { signRequest } = require('../src/lib/cloud/sigv4.js');
const aws = require('../src/lib/cloud/aws.js');
const azure = require('../src/lib/cloud/azure.js');
const openai = require('../src/lib/cloud/openai.js');

const NOW = Date.UTC(2026, 10, 11, 3, 0); // 2026-11-11 03:00 UTC

test('billingWindow covers last month through tomorrow in UTC', () => {
  const w = C.billingWindow(NOW);
  assert.equal(C.isoDate(w.lastMonth), '2026-10-01');
  assert.equal(C.isoDate(w.thisMonth), '2026-11-01');
  assert.equal(C.isoDate(w.tomorrow), '2026-11-12');
  assert.deepEqual([w.thisKey, w.lastKey], ['2026-11', '2026-10']);
});

test('billingWindow rolls over the year in January', () => {
  const w = C.billingWindow(Date.UTC(2027, 0, 5));
  assert.equal(w.lastKey, '2026-12');
});

test('projectMonthEnd extrapolates from elapsed days and refuses too-early guesses', () => {
  // 11일 0시 → 10일 흐름, 11월은 30일
  assert.equal(C.projectMonthEnd(100, Date.UTC(2026, 10, 11)), 300);
  assert.equal(C.projectMonthEnd(5, Date.UTC(2026, 10, 2)), null);
});

test('buildSnapshot splits months, sums services and sorts them', () => {
  const snap = C.buildSnapshot([
    { month: '2026-11', service: 'EC2', amount: 10, currency: 'USD' },
    { month: '2026-11', service: 'S3', amount: 2.5, currency: 'USD' },
    { month: '2026-11', service: 'EC2', amount: 5, currency: 'USD' },
    { month: '2026-11', service: 'Tiny', amount: 0.001, currency: 'USD' },
    { month: '2026-10', service: 'EC2', amount: 40, currency: 'USD' },
  ], NOW);
  assert.equal(snap.month, '2026-11');
  assert.equal(snap.currency, 'USD');
  assert.equal(snap.monthToDate, 17.5);
  assert.equal(snap.lastMonth, 40);
  assert.deepEqual(snap.services, [{ name: 'EC2', amount: 15 }, { name: 'S3', amount: 2.5 }]);
  assert.equal(snap.projected, C.projectMonthEnd(17.5, NOW));
});

test('buildSnapshot with no data is a zero snapshot', () => {
  const snap = C.buildSnapshot([], NOW);
  assert.deepEqual([snap.monthToDate, snap.lastMonth, snap.services.length, snap.currency], [0, 0, 0, 'USD']);
});

test('toKRW converts USD with a rate and passes KRW through', () => {
  assert.equal(C.toKRW(10, 'USD', 1400), 14000);
  assert.equal(C.toKRW(5000, 'KRW', 1400), 5000);
  assert.equal(C.toKRW(10, 'USD', null), null);
});

test('totalKRW adds snapshots that can be converted', () => {
  const total = C.totalKRW([
    { monthToDate: 10, projected: 30, lastMonth: 20, currency: 'USD' },
    { monthToDate: 7000, projected: null, lastMonth: 1000, currency: 'KRW' },
  ], 1400);
  assert.deepEqual(total, { monthToDate: 21000, projected: 49000, lastMonth: 29000 });
});

// AWS 공식 SigV4 테스트 스위트의 get-vanilla 케이스
test('signRequest matches the AWS get-vanilla test vector', async () => {
  const headers = await signRequest({
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    headers: {},
    body: '',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 'service',
    now: Date.UTC(2015, 7, 30, 12, 36, 0),
  });
  assert.equal(headers['x-amz-date'], '20150830T123600Z');
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
    + 'SignedHeaders=host;x-amz-date, '
    + 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  );
});

test('aws.buildBody asks for monthly cost grouped by service', () => {
  const body = aws.buildBody(NOW);
  assert.deepEqual(body.TimePeriod, { Start: '2026-10-01', End: '2026-11-12' });
  assert.equal(body.Granularity, 'MONTHLY');
  assert.deepEqual(body.GroupBy, [{ Type: 'DIMENSION', Key: 'SERVICE' }]);
});

test('aws.parseEntries reads grouped monthly results', () => {
  const entries = aws.parseEntries({
    ResultsByTime: [
      { TimePeriod: { Start: '2026-10-01' }, Groups: [{ Keys: ['Amazon EC2'], Metrics: { UnblendedCost: { Amount: '40.5', Unit: 'USD' } } }] },
      { TimePeriod: { Start: '2026-11-01' }, Groups: [{ Keys: ['Amazon S3'], Metrics: { UnblendedCost: { Amount: '1.25', Unit: 'USD' } } }] },
    ],
  });
  assert.deepEqual(entries, [
    { month: '2026-10', service: 'Amazon EC2', amount: 40.5, currency: 'USD' },
    { month: '2026-11', service: 'Amazon S3', amount: 1.25, currency: 'USD' },
  ]);
});

test('aws.validateCredentials rejects malformed keys', () => {
  assert.throws(() => aws.validateCredentials({ accessKeyId: 'nope', secretAccessKey: 'x' }));
  assert.throws(() => aws.validateCredentials({ accessKeyId: 'ASIAABCDEFGHIJKLMNOP', secretAccessKey: 'a'.repeat(40) }));
  assert.doesNotThrow(() => aws.validateCredentials({ accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 'a'.repeat(40) }));
});

test('azure.parseEntries maps columns by name, not position', () => {
  const entries = azure.parseEntries({
    properties: {
      columns: [{ name: 'UsageDate' }, { name: 'ServiceName' }, { name: 'Cost' }, { name: 'Currency' }],
      rows: [[20261103, 'Storage', 1.5, 'USD'], [20261021, 'Virtual Machines', 12, 'USD']],
    },
  });
  assert.deepEqual(entries, [
    { month: '2026-11', service: 'Storage', amount: 1.5, currency: 'USD' },
    { month: '2026-10', service: 'Virtual Machines', amount: 12, currency: 'USD' },
  ]);
});

test('azure.parseEntries refuses rows it cannot read instead of reporting $0', () => {
  assert.throws(() => azure.parseEntries({ properties: { columns: [{ name: 'Foo' }], rows: [[1]] } }), /형식/);
  assert.deepEqual(azure.parseEntries({ properties: { columns: [], rows: [] } }), []);
});

test('azure.buildQuery uses a custom window grouped by service', () => {
  const q = azure.buildQuery(NOW);
  assert.equal(q.type, 'ActualCost');
  assert.equal(q.timeframe, 'Custom');
  assert.deepEqual(q.timePeriod, { from: '2026-10-01T00:00:00Z', to: '2026-11-11T23:59:59Z' });
  assert.deepEqual(q.dataset.grouping, [{ type: 'Dimension', name: 'ServiceName' }]);
});

test('azure.pkceChallenge derives the RFC 7636 example challenge', async () => {
  const challenge = await azure.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('redactSecrets hides keys and tokens in error text', () => {
  const out = C.redactSecrets('bad key sk-admin-abcdef123456 / AKIAABCDEFGHIJKLMNOP / eyJhbGciOi.eyJzdWIi.sig');
  assert.ok(!/sk-admin|AKIA|eyJ/.test(out), out);
});

test('azure.safeNextLink only follows the same cost query path', () => {
  const first = 'https://management.azure.com/subscriptions/00000000-0000-0000-0000-000000000001/providers/Microsoft.CostManagement/query?api-version=2023-11-01';
  assert.equal(azure.safeNextLink(`${first}&$skiptoken=abc`, first), `${first}&$skiptoken=abc`);
  assert.equal(azure.safeNextLink('https://management.azure.com/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/x?api-version=1', first), null);
  assert.equal(azure.safeNextLink('https://evil.example/x?api-version=1', first), null);
  assert.equal(azure.safeNextLink(null, first), null);
});

test('azure.validateCredentials needs a valid tenant and a refresh token', () => {
  assert.throws(() => azure.validateCredentials({ tenant: '../evil', refreshToken: 'x' }));
  assert.throws(() => azure.validateCredentials({ tenant: 'organizations' }));
  assert.doesNotThrow(() => azure.validateCredentials({ tenant: 'organizations', refreshToken: 'x' }));
});

test('openai.parseEntries reads daily buckets into months', () => {
  const entries = openai.parseEntries({
    data: [
      { start_time: Date.UTC(2026, 9, 31) / 1000, results: [{ amount: { value: 0.5, currency: 'usd' }, line_item: 'gpt-5, input' }] },
      { start_time: Date.UTC(2026, 10, 1) / 1000, results: [{ amount: { value: '1.25', currency: 'usd' }, line_item: null }] },
    ],
  });
  assert.deepEqual(entries, [
    { month: '2026-10', service: 'gpt-5, input', amount: 0.5, currency: 'USD' },
    { month: '2026-11', service: '기타', amount: 1.25, currency: 'USD' },
  ]);
});

test('openai.costsUrl starts at the first day of last month', () => {
  const url = new URL(openai.costsUrl(NOW));
  assert.equal(url.searchParams.get('start_time'), String(Date.UTC(2026, 9, 1) / 1000));
  assert.equal(url.searchParams.get('bucket_width'), '1d');
  assert.equal(url.searchParams.get('group_by'), 'line_item');
});

test('openai.validateCredentials requires an admin key', () => {
  assert.throws(() => openai.validateCredentials({ adminKey: 'sk-proj-abc' }), /관리자/);
  assert.doesNotThrow(() => openai.validateCredentials({ adminKey: 'sk-admin-abc123' }));
});
