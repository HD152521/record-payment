const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/lib/cloud/guides.js');

const PROVIDERS = ['aws', 'azure', 'openai', 'cloudflare', 'github', 'vercel'];
const CF_PERMS = '%5B%7B%22key%22%3A%22billing%22%2C%22type%22%3A%22read%22%7D%5D';

const partText = (part) => (typeof part === 'string' ? part : part.b || part.code || part.a || '');
const stepText = (step) => step.map(partText).join('');

test('every provider has a 3 to 5 step guide in polite Korean', () => {
  assert.deepEqual(Object.keys(G.GUIDES).sort(), [...PROVIDERS].sort());
  for (const id of PROVIDERS) {
    const { steps } = G.GUIDES[id];
    assert.ok(steps.length >= 3 && steps.length <= 5, `${id}: ${steps.length}단계`);
    for (const step of steps) assert.match(stepText(step), /요[.)]?$|요\.\s*$/, `${id}: "${stepText(step)}"`);
  }
});

test('every guide link and shortcut is https', () => {
  for (const id of PROVIDERS) {
    const g = G.GUIDES[id];
    assert.ok(g.links.length >= 1, `${id}: 바로가기 링크가 있어야 해요`);
    const hrefs = [...g.links.map((l) => l.url), ...g.steps.flat().filter((p) => p.href).map((p) => p.href)];
    for (const href of hrefs) assert.match(href, /^https:\/\/[a-z0-9.-]+\//, `${id}: ${href}`);
  }
});

test('cloudflare create url pre-fills billing read for a user token', () => {
  const url = new URL(G.createUrl('cloudflare'));
  assert.equal(url.origin + url.pathname, 'https://dash.cloudflare.com/profile/api-tokens');
  assert.ok(G.createUrl('cloudflare').includes(`permissionGroupKeys=${CF_PERMS}`));
  assert.deepEqual(JSON.parse(url.searchParams.get('permissionGroupKeys')), [{ key: 'billing', type: 'read' }]);
  assert.equal(url.searchParams.get('accountId'), '*');
  assert.equal(url.searchParams.get('zoneId'), 'all');
  assert.ok(url.searchParams.get('name'));
});

test('github create url asks only for Plan read on a personal token', () => {
  const url = new URL(G.createUrl('github'));
  assert.equal(url.origin + url.pathname, 'https://github.com/settings/personal-access-tokens/new');
  assert.equal(url.searchParams.get('plan'), 'read');
  assert.equal(url.searchParams.get('target_name'), null);
  assert.ok(url.searchParams.get('name'));
  assert.match(url.searchParams.get('expires_in'), /^\d+$/);
});

test('github create url targets the organization with Administration read', () => {
  const url = new URL(G.createUrl('github', { org: ' my-org ' }));
  assert.equal(url.searchParams.get('target_name'), 'my-org');
  assert.equal(url.searchParams.get('organization_administration'), 'read');
  assert.equal(url.searchParams.get('plan'), null, '조직 토큰에는 계정 권한을 넣지 않아요');
});

test('github ignores an org name that is not a valid GitHub name', () => {
  const url = new URL(G.createUrl('github', { org: 'a&plan=admin' }));
  assert.equal(url.searchParams.get('target_name'), null);
  assert.equal(url.searchParams.get('plan'), 'read');
});

test('pages without pre-fill open the token page as is, azure has none', () => {
  assert.equal(G.createUrl('vercel'), 'https://vercel.com/account/tokens');
  assert.equal(G.createUrl('openai'), 'https://platform.openai.com/settings/organization/admin-keys');
  assert.equal(G.createUrl('azure'), null);
  assert.equal(G.createUrl('nope'), null);
  assert.equal(G.GUIDES.cloudflare.prefilled, true);
  assert.equal(G.GUIDES.github.prefilled, true);
  assert.equal(G.GUIDES.vercel.prefilled, false);
});

const S3_TEMPLATE = 'https://s3.us-east-1.amazonaws.com/some-bucket/readonly-cost-user.json';
const hashParams = (url) => new URLSearchParams(new URL(url).hash.split('?')[1] || '');

test('aws without a template address opens the CloudFormation upload page', () => {
  const url = new URL(G.createUrl('aws'));
  assert.equal(url.origin + url.pathname, 'https://console.aws.amazon.com/cloudformation/home');
  assert.equal(url.hash, '#/stacks/create');
  const guide = G.guideFor('aws');
  assert.equal(guide, G.GUIDES.aws);
  assert.equal(guide.prefilled, false);
  assert.ok(guide.steps.flat().some((p) => p.file === 'aws/readonly-cost-user.json'), '템플릿 파일 받기');
  assert.ok(guide.links.some((l) => l.url.startsWith('https://console.aws.amazon.com/iam/')), 'IAM 액세스 키 화면 링크');
});

test('aws with an S3 template address builds the quick-create link', () => {
  const url = G.createUrl('aws', { templateUrl: S3_TEMPLATE });
  assert.ok(url.startsWith('https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?'));
  const params = hashParams(url);
  assert.equal(params.get('templateURL'), S3_TEMPLATE);
  assert.match(params.get('stackName'), /^[A-Za-z][A-Za-z0-9-]*$/);
  const guide = G.guideFor('aws', { templateUrl: S3_TEMPLATE });
  assert.notEqual(guide, G.GUIDES.aws);
  assert.equal(guide.prefilled, true);
  assert.ok(Object.isFrozen(guide.steps));
  assert.ok(guide.steps.length >= 3 && guide.steps.length <= 5);
  for (const step of guide.steps) assert.match(stepText(step), /요[.)]?$|요\.\s*$/);
});

test('aws ignores a template address that is not an https S3 address', () => {
  for (const templateUrl of ['http://s3.us-east-1.amazonaws.com/b/t.json', 'https://example.com/t.json',
    'https://s3.amazonaws.com.evil.io/b/t.json', 'not a url', '']) {
    assert.equal(new URL(G.createUrl('aws', { templateUrl })).hash, '#/stacks/create', templateUrl);
    assert.equal(G.guideFor('aws', { templateUrl }), G.GUIDES.aws, templateUrl);
  }
  for (const templateUrl of ['https://my-bucket.s3.amazonaws.com/t.json', 'https://my-bucket.s3.ap-northeast-2.amazonaws.com/t.json']) {
    assert.equal(hashParams(G.createUrl('aws', { templateUrl })).get('templateURL'), templateUrl);
  }
});

test('guideFor returns the plain guide for other providers', () => {
  assert.equal(G.guideFor('github', { templateUrl: S3_TEMPLATE }), G.GUIDES.github);
  assert.equal(G.guideFor('nope'), null);
});

test('guides are frozen so the UI cannot change them', () => {
  assert.ok(Object.isFrozen(G.GUIDES));
  assert.ok(Object.isFrozen(G.GUIDES.github.steps));
});
