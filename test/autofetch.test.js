const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/lib/cloud/autofetch.js');

const GH = `github_pat_${'A1b2'.repeat(20)}`;
const CF = 'Ab3_'.repeat(10);
const VC = `vcp_${'k9Z'.repeat(8)}`;
const OA = `sk-admin-${'q7W'.repeat(10)}`;
const AWS_ID = 'AKIA' + 'Q'.repeat(15) + '7';
const AWS_SECRET = 'wJal/rXUtn+FEMI7K7MDENGbPxRfiCY'.padEnd(40, '9');

test('only https pages on the provider console host count', () => {
  assert.equal(A.isProviderPage('github', 'https://github.com/settings/personal-access-tokens'), true);
  assert.equal(A.isProviderPage('github', 'http://github.com/settings'), false);
  assert.equal(A.isProviderPage('github', 'https://evil.com/?github.com'), false);
  assert.equal(A.isProviderPage('github', 'https://github.com.evil.com/'), false);
  assert.equal(A.isProviderPage('cloudflare', 'https://dash.cloudflare.com/profile/api-tokens'), true);
  assert.equal(A.isProviderPage('vercel', 'https://vercel.com/account/tokens'), true);
  assert.equal(A.isProviderPage('openai', 'https://platform.openai.com/settings/organization/admin-keys'), true);
  assert.equal(A.isProviderPage('aws', 'https://us-east-1.console.aws.amazon.com/iam/home'), true);
  assert.equal(A.isProviderPage('aws', 'https://console.aws.amazon.com/iam/home'), true);
  assert.equal(A.isProviderPage('aws', 'https://console.aws.amazon.com.evil.io/'), false);
  assert.equal(A.isProviderPage('azure', 'https://portal.azure.com/'), false, '로그인 방식은 읽지 않는다');
  assert.equal(A.isProviderPage('toString', 'https://github.com/'), false);
  assert.equal(A.isProviderPage('github', 'not a url'), false);
});

test('login and sign-in pages on the console host are never read', () => {
  assert.equal(A.isProviderPage('cloudflare', 'https://dash.cloudflare.com/login'), false);
  assert.equal(A.isProviderPage('github', 'https://github.com/login'), false);
  assert.equal(A.isProviderPage('github', 'https://github.com/login/oauth/authorize'), false);
  assert.equal(A.isProviderPage('github', 'https://github.com/session'), false);
  assert.equal(A.isProviderPage('vercel', 'https://vercel.com/signin'), false);
  assert.equal(A.isProviderPage('vercel', 'https://vercel.com/sign-up'), false);
  assert.equal(A.isProviderPage('openai', 'https://platform.openai.com/sign-in'), false);
  assert.equal(A.isProviderPage('aws', 'https://console.aws.amazon.com/oauth?x=1'), false);
  assert.equal(A.isProviderPage('github', 'https://github.com/settings/personal-access-tokens/new'), true);
  assert.equal(A.isProviderPage('cloudflare', 'https://dash.cloudflare.com/profile/api-tokens'), true);
});

test('reads exactly one prefixed token from the page', () => {
  assert.deepEqual(A.extractCredentials('github', { fields: [], texts: [`Make sure to copy it now ${GH}`] }), { token: GH });
  assert.deepEqual(A.extractCredentials('vercel', { fields: [VC], texts: [] }), { token: VC });
  assert.deepEqual(A.extractCredentials('openai', { fields: [], texts: [`key ${OA} copy`] }), { adminKey: OA });
});

test('the same token shown twice is still one token', () => {
  assert.deepEqual(A.extractCredentials('github', { fields: [GH], texts: [`${GH} copy`] }), { token: GH });
});

test('two different tokens or a masked one are not picked', () => {
  const other = `github_pat_${'Z9y8'.repeat(20)}`;
  assert.equal(A.extractCredentials('github', { fields: [GH, other], texts: [] }), null);
  assert.equal(A.extractCredentials('openai', { fields: [], texts: ['sk-admin-ab...cdef'] }), null);
  assert.equal(A.extractCredentials('github', { fields: [], texts: ['nothing here'] }), null);
});

test('cloudflare 40 char token is read only from inputs and code, not page text', () => {
  assert.deepEqual(A.extractCredentials('cloudflare', { fields: [`curl -H "Authorization: Bearer ${CF}"`], texts: [] }), { apiToken: CF });
  assert.equal(A.extractCredentials('cloudflare', { fields: [], texts: [CF] }), null);
  assert.equal(A.extractCredentials('cloudflare', { fields: ['a'.repeat(40)], texts: [] }), null, '글자만 40자는 토큰이 아니다');
});

test('aws needs both the access key id and the shown secret', () => {
  assert.deepEqual(A.extractCredentials('aws', { fields: [AWS_ID, AWS_SECRET], texts: [] }), { accessKeyId: AWS_ID, secretAccessKey: AWS_SECRET });
  assert.equal(A.extractCredentials('aws', { fields: [AWS_ID, '****************'], texts: [] }), null, '숨겨진 비밀키는 못 읽음');
});

test('unknown or login providers read nothing', () => {
  assert.equal(A.extractCredentials('azure', { fields: [GH], texts: [GH] }), null);
  assert.equal(A.extractCredentials('__proto__', { fields: [GH], texts: [] }), null);
});

test('preview hides the middle of the token', () => {
  const p = A.preview('github', { token: GH });
  assert.ok(p.startsWith('github_pat_'));
  assert.ok(p.endsWith(GH.slice(-4)));
  assert.ok(!p.includes(GH.slice(11, -4)));
  assert.equal(A.preview('aws', { accessKeyId: AWS_ID, secretAccessKey: AWS_SECRET }).includes(AWS_SECRET.slice(4, -4)), false);
});

test('mergeCredentials keeps the read secret and only the allowed extra fields', () => {
  assert.deepEqual(A.mergeCredentials('github', { token: GH }, { org: ' acme ', token: 'x', evil: 1 }), { token: GH, org: 'acme' });
  assert.deepEqual(A.mergeCredentials('cloudflare', { apiToken: CF }, { accountId: '' }), { apiToken: CF, accountId: undefined });
  assert.deepEqual(A.mergeCredentials('vercel', { token: VC }, { team: 'acme' }), { token: VC, team: 'acme' });
  assert.deepEqual(A.mergeCredentials('openai', { adminKey: OA }, { adminKey: 'x' }), { adminKey: OA });
});
