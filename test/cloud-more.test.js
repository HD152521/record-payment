const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/lib/cloud/costs.js');
const cloudflare = require('../src/lib/cloud/cloudflare.js');
const github = require('../src/lib/cloud/github.js');
const vercel = require('../src/lib/cloud/vercel.js');

const NOW = Date.UTC(2026, 10, 11, 3, 0); // 2026-11-11 03:00 UTC
const GH_TOKEN = `ghp_${'a'.repeat(36)}`;

const jsonRes = (body, status = 200) => ({
  ok: status < 400,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

test('buildSnapshot with billed projection uses the larger of this month and last month', () => {
  const entries = [
    { month: '2026-11', service: 'Workers', amount: 0, currency: 'USD' },
    { month: '2026-10', service: 'Workers', amount: 5, currency: 'USD' },
  ];
  assert.equal(C.buildSnapshot(entries, NOW, { projection: 'billed' }).projected, 5);
  assert.equal(C.buildSnapshot(entries, NOW).projected, 0);
});

test('requestText returns the raw body and throws with status on errors', async () => {
  assert.equal(await C.requestText(async () => jsonRes('a\nb'), 'u', {}, 'X'), 'a\nb');
  await assert.rejects(
    C.requestText(async () => jsonRes({ error: { message: 'nope' } }, 403), 'u', {}, 'X'),
    (e) => e.status === 403 && /nope/.test(e.message),
  );
});

// ── Cloudflare
test('cloudflare.parseEntries keeps the billing window and drops a repeated row', () => {
  const entries = cloudflare.parseEntries([
    { id: '1', invoice_id: 'inv-1', amount: 5, currency: 'usd', description: 'Workers Paid', occurred_at: '2026-11-02T00:00:00Z' },
    { id: '1', invoice_id: 'inv-1', amount: 5, currency: 'usd', description: 'Workers Paid', occurred_at: '2026-11-02T00:00:00Z' },
    { id: '3', amount: 25, currency: 'USD', type: 'charge', occurred_at: '2026-10-05T00:00:00Z' },
    { id: '4', amount: 99, currency: 'USD', description: 'old', occurred_at: '2026-08-01T00:00:00Z' },
  ], NOW);
  assert.deepEqual(entries, [
    { month: '2026-11', service: 'Workers Paid', amount: 5, currency: 'USD' },
    { month: '2026-10', service: 'charge', amount: 25, currency: 'USD' },
  ]);
});

test('cloudflare.validateCredentials needs a token and an optional 32-hex account id', () => {
  assert.throws(() => cloudflare.validateCredentials({ apiToken: 'short' }), /토큰/);
  assert.throws(() => cloudflare.validateCredentials({ apiToken: 'a'.repeat(40), accountId: '../x' }), /계정 ID/);
  assert.doesNotThrow(() => cloudflare.validateCredentials({ apiToken: 'a'.repeat(40), accountId: 'f'.repeat(32) }));
  assert.doesNotThrow(() => cloudflare.validateCredentials({ apiToken: 'a'.repeat(40) }));
});

test('cloudflare.fetchEntries finds accounts when no id is given and pages billing history', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/accounts?')) return jsonRes({ success: true, result: [{ id: 'a'.repeat(32), name: 'Main' }] });
    const page = Number(new URL(url).searchParams.get('page'));
    return jsonRes({
      success: true,
      result: [{ id: `p${page}`, amount: page, currency: 'USD', description: `p${page}`, occurred_at: '2026-11-03T00:00:00Z' }],
      result_info: { page, per_page: 1, total_count: 2 },
    });
  };
  const { entries, projection } = await cloudflare.fetchEntries({ credentials: { apiToken: 't'.repeat(40) } }, { fetchImpl, now: NOW });
  assert.equal(projection, 'billed');
  assert.deepEqual(entries.map((e) => e.amount), [1, 2]);
  assert.equal(calls.length, 3);
  assert.match(calls[1], /\/accounts\/a{32}\/billing\/history\?/);
});

test('cloudflare.fetchEntries explains a missing billing permission', async () => {
  const fetchImpl = async () => jsonRes({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, 403);
  await assert.rejects(
    cloudflare.fetchEntries({ credentials: { apiToken: 't'.repeat(40), accountId: 'a'.repeat(32) } }, { fetchImpl, now: NOW }),
    /Billing Read/,
  );
});

// ── GitHub
test('github.parseEntries reads netAmount by product and month', () => {
  const entries = github.parseEntries({ usageItems: [
    { date: '2026-11-03T00:00:00Z', product: 'actions', sku: 'linux', netAmount: 1.5, grossAmount: 3 },
    { date: '2026-11-04T00:00:00Z', product: 'copilot', sku: 'premium', netAmount: 0.4 },
  ] });
  assert.deepEqual(entries, [
    { month: '2026-11', service: 'actions', amount: 1.5, currency: 'USD' },
    { month: '2026-11', service: 'copilot', amount: 0.4, currency: 'USD' },
  ]);
});

test('github.validateCredentials accepts personal access tokens and a safe org name', () => {
  assert.throws(() => github.validateCredentials({ token: 'nope' }), /토큰/);
  assert.throws(() => github.validateCredentials({ token: `github_pat_${'a'.repeat(40)}`, org: 'a/b' }), /조직/);
  assert.doesNotThrow(() => github.validateCredentials({ token: `github_pat_${'a'.repeat(40)}` }));
  assert.doesNotThrow(() => github.validateCredentials({ token: GH_TOKEN, org: 'my-org' }));
});

test('github.fetchEntries asks this month and last month for the token owner', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    assert.equal(init.headers.authorization, `Bearer ${GH_TOKEN}`);
    if (url.endsWith('/user')) return jsonRes({ login: 'octo' });
    const month = new URL(url).searchParams.get('month');
    return jsonRes({ usageItems: [{ date: `2026-${month.padStart(2, '0')}-02T00:00:00Z`, product: 'actions', netAmount: Number(month) }] });
  };
  const { entries } = await github.fetchEntries({ credentials: { token: GH_TOKEN } }, { fetchImpl, now: NOW });
  assert.deepEqual(calls.slice(1).map((u) => new URL(u).pathname + new URL(u).search), [
    '/users/octo/settings/billing/usage?year=2026&month=11',
    '/users/octo/settings/billing/usage?year=2026&month=10',
  ]);
  assert.deepEqual(entries.map((e) => [e.month, e.amount]), [['2026-11', 11], ['2026-10', 10]]);
});

test('github.fetchEntries reads the organization report when an org is given', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return jsonRes({ usageItems: [] }); };
  await github.fetchEntries({ credentials: { token: GH_TOKEN, org: 'acme' } }, { fetchImpl, now: NOW });
  assert.ok(calls.length === 2 && calls.every((u) => u.includes('/organizations/acme/settings/billing/usage')));
});

test('github.fetchEntries explains accounts without the enhanced billing platform', async () => {
  const fetchImpl = async (url) => (url.endsWith('/user') ? jsonRes({ login: 'octo' }) : jsonRes({ message: 'Not Found' }, 404));
  await assert.rejects(github.fetchEntries({ credentials: { token: GH_TOKEN } }, { fetchImpl, now: NOW }), /새 청구/);
});

// ── Vercel
test('buildSnapshot does not stretch fixed charges like a monthly plan fee', () => {
  const entries = [
    { month: '2026-11', service: 'Pro Plan', amount: 20, currency: 'USD', fixed: true },
    { month: '2026-11', service: 'Functions', amount: 10, currency: 'USD' },
  ];
  const snap = C.buildSnapshot(entries, NOW);
  assert.equal(snap.monthToDate, 30);
  assert.equal(snap.projected, C.round2(20 + C.projectMonthEnd(10, NOW)));
});

test('vercel.parseJsonl reads FOCUS rows and skips blank or broken lines', () => {
  const body = [
    JSON.stringify({ ChargePeriodStart: '2026-11-03T00:00:00Z', ServiceName: 'Functions', BilledCost: '1.25', BillingCurrency: 'USD' }),
    '',
    '{broken',
    JSON.stringify({ ChargePeriodStart: '2026-10-01T00:00:00Z', ServiceName: 'Pro Plan', BilledCost: 20, BillingCurrency: 'USD', ChargeCategory: 'Purchase' }),
  ].join('\n');
  assert.deepEqual(vercel.parseJsonl(body), [
    { month: '2026-11', service: 'Functions', amount: 1.25, currency: 'USD', fixed: false },
    { month: '2026-10', service: 'Pro Plan', amount: 20, currency: 'USD', fixed: true },
  ]);
});

test('vercel.chargesUrl uses ISO UTC timestamps for the billing window', () => {
  const url = new URL(vercel.chargesUrl('team_1', NOW));
  assert.equal(url.pathname, '/v1/billing/charges');
  assert.equal(url.searchParams.get('teamId'), 'team_1');
  assert.equal(url.searchParams.get('from'), '2026-10-01T00:00:00.000Z');
  assert.equal(url.searchParams.get('to'), '2026-11-12T00:00:00.000Z');
});

test('vercel.fetchEntries uses every team, falling back to the default team', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/v2/teams')) return jsonRes({ teams: [] });
    if (url.includes('/v2/user')) return jsonRes({ user: { defaultTeamId: 'team_default' } });
    return jsonRes(JSON.stringify({ ChargePeriodStart: '2026-11-03T00:00:00Z', ServiceName: 'Edge', BilledCost: 2, BillingCurrency: 'USD' }));
  };
  const { entries } = await vercel.fetchEntries({ credentials: { token: 'v'.repeat(24) } }, { fetchImpl, now: NOW });
  assert.ok(calls.some((u) => u.includes('teamId=team_default')));
  assert.deepEqual(entries.map((e) => e.amount), [2]);
});

test('vercel.validateCredentials rejects tokens with spaces and odd team names', () => {
  assert.throws(() => vercel.validateCredentials({ token: 'has space here 1234567890' }), /토큰/);
  assert.throws(() => vercel.validateCredentials({ token: 'v'.repeat(24), team: '../x' }), /팀/);
  assert.doesNotThrow(() => vercel.validateCredentials({ token: 'v'.repeat(24), team: 'my-team' }));
});

// ── 리뷰 반영
test('cloudflare.parseEntries keeps every line of one invoice and drops only repeated rows', () => {
  const entries = cloudflare.parseEntries([
    { id: 'a', invoice_id: 'inv', amount: 5, currency: 'USD', description: 'Workers Paid', occurred_at: '2026-11-02T00:00:00Z' },
    { id: 'b', invoice_id: 'inv', amount: 10, currency: 'USD', description: 'Domain', occurred_at: '2026-11-02T00:00:00Z' },
    { id: 'b', invoice_id: 'inv', amount: 10, currency: 'USD', description: 'Domain', occurred_at: '2026-11-02T00:00:00Z' },
  ], NOW);
  assert.deepEqual(entries.map((e) => e.amount), [5, 10]);
});

test('cloudflare.fetchEntries skips accounts without billing access and warns', async () => {
  const ok = 'a'.repeat(32);
  const denied = 'b'.repeat(32);
  const fetchImpl = async (url) => {
    if (url.includes('/accounts?')) return jsonRes({ result: [{ id: ok }, { id: denied }] });
    if (url.includes(denied)) return jsonRes({ success: false, errors: [{ message: 'no' }] }, 403);
    return jsonRes({ result: [{ id: 'x', amount: 5, currency: 'USD', occurred_at: '2026-11-02T00:00:00Z' }], result_info: { total_count: 1 } });
  };
  const { entries, warnings } = await cloudflare.fetchEntries({ credentials: { apiToken: 't'.repeat(40) } }, { fetchImpl, now: NOW });
  assert.deepEqual(entries.map((e) => e.amount), [5]);
  assert.equal(warnings.length, 1);
});

test('cloudflare.fetchEntries warns when billing history is longer than it reads', async () => {
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return jsonRes({ result: [{ id: `p${page}`, amount: 1, currency: 'USD', occurred_at: '2026-11-02T00:00:00Z' }], result_info: { per_page: 1, total_count: 999 } });
  };
  const { warnings } = await cloudflare.fetchEntries({ credentials: { apiToken: 't'.repeat(40), accountId: 'a'.repeat(32) } }, { fetchImpl, now: NOW });
  assert.equal(warnings.length, 1);
});

test('vercel.parseJsonl treats credits and adjustments as fixed, usage and tax as growing', () => {
  const rows = ['Usage', 'Tax', 'Purchase', 'Credit', 'Adjustment'].map((ChargeCategory) =>
    JSON.stringify({ ChargePeriodStart: '2026-11-01T00:00:00Z', ServiceName: ChargeCategory, BilledCost: 1, BillingCurrency: 'USD', ChargeCategory }));
  assert.deepEqual(vercel.parseJsonl(rows.join('\n')).map((e) => e.fixed), [false, false, true, true, true]);
});

test('github.fetchEntries mentions the org name when an org report is not found', async () => {
  const fetchImpl = async () => jsonRes({ message: 'Not Found' }, 404);
  await assert.rejects(github.fetchEntries({ credentials: { token: GH_TOKEN, org: 'acme' } }, { fetchImpl, now: NOW }), /조직 이름/);
});

test('redactSecrets hides GitHub tokens and long opaque tokens', () => {
  const out = C.redactSecrets(`bad ${GH_TOKEN} and github_pat_${'b'.repeat(40)} and ${'Z9'.repeat(20)}`);
  assert.ok(!/ghp_|github_pat_|Z9Z9Z9/.test(out), out);
});

test('redactValues removes exact credential strings from a message', () => {
  const out = C.redactValues('echo: my-secret-token-123 was rejected', { token: ' my-secret-token-123 ', org: 'acme' });
  assert.equal(out, 'echo: [가림] was rejected');
});

test('requestText refuses redirects when it carries an authorization header', async () => {
  let seenInit;
  await C.requestText(async (u, init) => { seenInit = init; return jsonRes('ok'); }, 'u', { headers: { authorization: 'Bearer x' } }, 'X');
  assert.equal(seenInit.redirect, 'error');
  await C.requestText(async (u, init) => { seenInit = init; return jsonRes('ok'); }, 'u', {}, 'X');
  assert.equal(seenInit.redirect, undefined);
});

test('buildSnapshot trims very long service names', () => {
  const snap = C.buildSnapshot([{ month: '2026-11', service: 'x'.repeat(500), amount: 1, currency: 'USD' }], NOW);
  assert.ok(snap.services[0].name.length <= 80);
});
