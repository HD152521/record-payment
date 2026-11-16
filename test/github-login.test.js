const { test } = require('node:test');
const assert = require('node:assert/strict');
const github = require('../src/lib/cloud/github.js');

const NOW = Date.UTC(2026, 10, 11, 3, 0); // 2026-11-11 03:00 UTC
const CLIENT_ID = 'Iv23liFAKECLIENT01';
const UAT = `ghu_${'u'.repeat(36)}`;
const UAT2 = `ghu_${'v'.repeat(36)}`;
const RT = `ghr_${'r'.repeat(76)}`;
const RT2 = `ghr_${'s'.repeat(76)}`;

const jsonRes = (body, status = 200) => ({
  ok: status < 400,
  status,
  text: async () => JSON.stringify(body),
});

const DEVICE = {
  device_code: 'dc-123', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5,
};

function usageFetch(calls, extra = () => null) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    const special = extra(url, init);
    if (special) return special;
    if (url.endsWith('/user')) return jsonRes({ login: 'octo' });
    const month = new URL(url).searchParams.get('month');
    return jsonRes({ usageItems: [{ date: `2026-${month.padStart(2, '0')}-02T00:00:00Z`, product: 'actions', netAmount: Number(month) }] });
  };
}

test('requestDeviceCode posts only the client id and returns the code to show', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return jsonRes(DEVICE); };
  const out = await github.requestDeviceCode({ clientId: CLIENT_ID, fetchImpl });
  assert.equal(calls[0].url, 'https://github.com/login/device/code');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.accept, 'application/json');
  const body = new URLSearchParams(calls[0].init.body);
  assert.deepEqual([...body.keys()], ['client_id']);
  assert.equal(body.get('client_id'), CLIENT_ID);
  assert.deepEqual(out, { deviceCode: 'dc-123', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 });
});

test('requestDeviceCode refuses without a client id and explains a disabled device flow', async () => {
  await assert.rejects(github.requestDeviceCode({ clientId: '', fetchImpl: async () => jsonRes(DEVICE) }), /앱 ID/);
  const disabled = async () => jsonRes({ error: 'device_flow_disabled' });
  await assert.rejects(github.requestDeviceCode({ clientId: CLIENT_ID, fetchImpl: disabled }), /기기 연결/);
});

test('requestDeviceCode rejects a verification address that is not github.com', async () => {
  const evil = async () => jsonRes({ ...DEVICE, verification_uri: 'https://evil.example/login/device' });
  await assert.rejects(github.requestDeviceCode({ clientId: CLIENT_ID, fetchImpl: evil }), /주소/);
});

test('pollForToken waits through pending and slow_down, then returns login credentials', async () => {
  const replies = [
    { error: 'authorization_pending' },
    { error: 'slow_down', interval: 10 },
    { access_token: UAT, token_type: 'bearer', expires_in: 28800, refresh_token: RT, refresh_token_expires_in: 15897600 },
  ];
  const calls = [];
  const sleeps = [];
  let clock = NOW;
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return jsonRes(replies.shift()); };
  const sleep = async (ms) => { sleeps.push(ms); clock += ms; };
  const creds = await github.pollForToken({ clientId: CLIENT_ID, device: { deviceCode: 'dc-123', interval: 5, expiresIn: 900 }, fetchImpl, sleep, now: () => clock });
  assert.deepEqual(sleeps, [5000, 5000, 10000]);
  assert.equal(calls.length, 3);
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(calls[0].url, 'https://github.com/login/oauth/access_token');
  assert.deepEqual(Object.fromEntries(body), { client_id: CLIENT_ID, device_code: 'dc-123', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
  assert.ok(!calls.some((c) => String(c.init.body).includes('client_secret')));
  assert.deepEqual(creds, { accessToken: UAT, refreshToken: RT, expiresAt: clock + 28800 * 1000 });
});

test('pollForToken explains a denied request, an expired code and a time-out', async () => {
  const once = (reply) => async () => jsonRes(reply);
  const opts = { clientId: CLIENT_ID, device: { deviceCode: 'dc', interval: 5, expiresIn: 900 }, sleep: async () => {}, now: () => NOW };
  await assert.rejects(github.pollForToken({ ...opts, fetchImpl: once({ error: 'access_denied' }) }), /취소/);
  await assert.rejects(github.pollForToken({ ...opts, fetchImpl: once({ error: 'expired_token' }) }), /만료/);
  let clock = NOW;
  const late = { ...opts, sleep: async (ms) => { clock += ms; }, now: () => clock, device: { deviceCode: 'dc', interval: 5, expiresIn: 9 } };
  await assert.rejects(github.pollForToken({ ...late, fetchImpl: once({ error: 'authorization_pending' }) }), /만료/);
});

test('pollForToken stops when the signal is aborted', async () => {
  const controller = new AbortController();
  let fetched = 0;
  const fetchImpl = async () => { fetched += 1; return jsonRes({ error: 'authorization_pending' }); };
  const sleep = async () => { controller.abort(); };
  await assert.rejects(
    github.pollForToken({ clientId: CLIENT_ID, device: { deviceCode: 'dc', interval: 5, expiresIn: 900 }, fetchImpl, sleep, now: () => NOW, signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
  assert.equal(fetched, 0);
});

test('validateCredentials accepts login credentials and still rejects junk', () => {
  assert.doesNotThrow(() => github.validateCredentials({ accessToken: UAT, refreshToken: RT, expiresAt: NOW }));
  assert.doesNotThrow(() => github.validateCredentials({ accessToken: UAT }));
  assert.throws(() => github.validateCredentials({ accessToken: 'nope' }), /토큰/);
  assert.throws(() => github.validateCredentials({ accessToken: UAT, refreshToken: 'nope' }), /토큰/);
});

test('device code → polling → token → usage: a fresh login token reads usage without refreshing', async () => {
  const flow = [jsonRes(DEVICE), jsonRes({ error: 'authorization_pending' }), jsonRes({ access_token: UAT, expires_in: 28800, refresh_token: RT })];
  const authFetch = async () => flow.shift();
  const device = await github.requestDeviceCode({ clientId: CLIENT_ID, fetchImpl: authFetch });
  const creds = await github.pollForToken({ clientId: CLIENT_ID, device, fetchImpl: authFetch, sleep: async () => {}, now: () => NOW });

  const calls = [];
  const result = await github.fetchEntries({ credentials: creds }, { fetchImpl: usageFetch(calls), now: NOW, githubClientId: CLIENT_ID });
  assert.ok(calls.every((c) => c.init.headers.authorization === `Bearer ${UAT}`));
  assert.ok(!calls.some((c) => c.url.includes('/login/oauth')));
  assert.deepEqual(result.entries.map((e) => [e.month, e.amount]), [['2026-11', 11], ['2026-10', 10]]);
  assert.equal(result.accountPatch, null);
});

test('fetchEntries refreshes an expired login token without a secret and saves the new pair', async () => {
  const calls = [];
  const refresh = (url) => (url.includes('/login/oauth/access_token')
    ? jsonRes({ access_token: UAT2, expires_in: 28800, refresh_token: RT2 }) : null);
  const account = { credentials: { accessToken: UAT, refreshToken: RT, expiresAt: NOW - 1, org: 'acme' } };
  const result = await github.fetchEntries(account, { fetchImpl: usageFetch(calls, refresh), now: NOW, githubClientId: CLIENT_ID });
  const body = new URLSearchParams(calls[0].init.body);
  assert.deepEqual(Object.fromEntries(body), { client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: RT });
  assert.ok(calls.slice(1).every((c) => c.init.headers.authorization === `Bearer ${UAT2}` && c.url.includes('/organizations/acme/')));
  assert.deepEqual(result.accountPatch, { credentials: { accessToken: UAT2, refreshToken: RT2, expiresAt: NOW + 28800 * 1000, org: 'acme' } });
});

test('fetchEntries asks to log in again when the refresh token is rejected', async () => {
  const fetchImpl = async () => jsonRes({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' });
  const account = { credentials: { accessToken: UAT, refreshToken: RT, expiresAt: NOW - 1 } };
  await assert.rejects(
    github.fetchEntries(account, { fetchImpl, now: NOW, githubClientId: CLIENT_ID }),
    (err) => err.needsReauth === true && /다시 로그인/.test(err.message) && !err.message.includes(RT),
  );
});

test('fetchEntries keeps the refreshed pair even when the usage call then fails', async () => {
  const fetchImpl = async (url) => (url.includes('/login/oauth')
    ? jsonRes({ access_token: UAT2, expires_in: 28800, refresh_token: RT2 })
    : jsonRes({ message: 'Server Error' }, 500));
  const account = { credentials: { accessToken: UAT, refreshToken: RT, expiresAt: NOW - 1 } };
  await assert.rejects(
    github.fetchEntries(account, { fetchImpl, now: NOW, githubClientId: CLIENT_ID }),
    (err) => err.accountPatch && err.accountPatch.credentials.refreshToken === RT2,
  );
});
