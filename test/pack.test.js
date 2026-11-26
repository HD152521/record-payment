const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const P = require('../scripts/pack-lib.js');
const Costs = require('../src/lib/cloud/costs.js');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

test('isPackable은 테스트·e2e·docs·node_modules·스크린샷을 뺀다', () => {
  for (const p of ['test/a.test.js', 'e2e/x.e2e.mjs', 'e2e/store-shots/1.png', 'docs/privacy.html',
    'node_modules/playwright/index.js', 'scripts/pack.mjs', '.git/config', 'package.json',
    'README.md', 'aws/readonly-cost-user.json', 'bash.exe.stackdump', 'src/shot.png', 'dist/a.zip']) {
    assert.equal(P.isPackable(p), false, p);
  }
  for (const p of ['manifest.json', 'src/background.js', 'src/lib/cloud/aws.js', 'icons/icon-16.png', 'src/popup.html']) {
    assert.equal(P.isPackable(p), true, p);
  }
});

test('listPackFiles에는 manifest가 참조하는 파일이 모두 들어 있다', () => {
  const files = P.listPackFiles(root);
  const refs = [
    manifest.background.service_worker, manifest.action.default_popup, manifest.options_page,
    ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap((c) => c.js),
  ];
  for (const r of refs) assert.ok(files.includes(r), `빠짐: ${r}`);
  assert.deepEqual(files.filter((f) => !P.isPackable(f)), []);
  assert.deepEqual(files, [...files].sort());
});

test('HTML이 불러오는 스크립트·스타일도 모두 패키지에 있다', () => {
  assert.deepEqual(P.missingHtmlAssets(root, P.listPackFiles(root)), []);
});

test('buildZip은 읽을 수 있는 zip을 만들고 항목 내용이 같다', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello 안녕') },
    { name: 'dir/b.bin', data: Buffer.alloc(5000, 7) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const zip = P.buildZip(entries);
  const parsed = P.readZip(zip);
  assert.deepEqual(parsed.map((e) => e.name), entries.map((e) => e.name));
  parsed.forEach((e, i) => assert.ok(e.data.equals(entries[i].data), e.name));
  assert.equal(zlib.crc32(Buffer.from('abc')), P.crc32(Buffer.from('abc')));
});

test('실제 패키지 zip에는 금지된 경로가 없다', () => {
  const zip = P.buildPackage(root);
  const names = P.readZip(zip).map((e) => e.name);
  assert.ok(names.includes('manifest.json'));
  assert.deepEqual(names.filter((n) => /^(test|e2e|docs|node_modules|scripts)\//.test(n) || /\.(png|jpg)$/.test(n) && !n.startsWith('icons/')), []);
});

test('보안: 소스에 하드코딩된 비밀값이 없다', () => {
  assert.deepEqual(P.findHardcodedSecrets(root), []);
  assert.ok(P.findHardcodedSecrets(root, { 'src/x.js': 'const k = "AKIAABCDEFGHIJKLMNOP"' }).length === 1);
  assert.ok(P.findHardcodedSecrets(root, { 'src/x.js': 'k="sk-proj-abcdefghijklmnopqrstu"' }).length === 1);
});

test('보안: content script는 storage·background 전용 모듈을 쓰지 않는다', () => {
  assert.deepEqual(P.findContentScriptViolations(root), []);
  assert.equal(P.findContentScriptViolations(root, { 'src/content.js': 'chrome.storage.local.get("cloudAccounts")' }).length, 1);
});

test('보안: 선언한 권한은 모두 코드에서 쓰이고, 쓰이지 않는 권한은 없다', () => {
  assert.deepEqual(P.findUnusedPermissions(root), []);
  assert.deepEqual(P.findUnusedPermissions(root, { 'src/a.js': '' }).length > 0, true);
});

test('보안: 오류 문장에 되비친 키는 가려진다', () => {
  const key = 'sk-proj-abcdefghijklmnop1234';
  const text = `Invalid key ${key} for AKIAABCDEFGHIJKLMNOP`;
  const out = Costs.redactSecrets(Costs.redactValues(text, { apiKey: key }));
  assert.ok(!out.includes(key));
  assert.ok(!out.includes('AKIAABCDEFGHIJKLMNOP'));
});

test('보안: manifest는 외부 노출·원격 코드 설정이 없다', () => {
  assert.deepEqual(P.findManifestIssues(manifest), []);
  assert.ok(P.findManifestIssues({ ...manifest, web_accessible_resources: [{ resources: ['*'] }] }).length > 0);
  assert.ok(P.findManifestIssues({ ...manifest, permissions: [...manifest.permissions, 'tabs'] }).length > 0);
});

test('패키지 zip의 manifest에는 개발용 key가 없다(스토어는 key를 받지 않는다)', () => {
  assert.ok(manifest.key, '압축해제 설치에서 기기마다 같은 확장 ID를 쓰려면 key가 필요해요');
  const entry = P.readZip(P.buildPackage(root)).find((e) => e.name === 'manifest.json');
  const packed = JSON.parse(entry.data.toString('utf8'));
  assert.equal(packed.key, undefined);
  assert.deepEqual({ ...packed, key: manifest.key }, manifest);
});
