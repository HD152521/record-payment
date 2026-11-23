const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));
const listing = read('docs/store-listing.md');
const privacy = read('docs/privacy.html');

const lockfile = JSON.parse(read('package-lock.json'));
const { SITES: ACCOUNT_SITES } = require('../src/lib/account-reader.js');

const PRIVACY_URL = 'https://hd152521.github.io/record-payment/privacy.html';
const MAX_SHORT = 132;
const VERSION = '0.5.0';
const PINNED_PERMISSIONS = ['storage', 'webNavigation', 'alarms', 'scripting', 'notifications'];

function section(title) {
  const start = listing.indexOf('## ' + title);
  assert.ok(start >= 0, `섹션 없음: ${title}`);
  const rest = listing.slice(start + 3);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

test(`manifest·package.json·package-lock.json 버전이 ${VERSION}으로 같다`, () => {
  assert.equal(manifest.version, VERSION);
  assert.equal(pkg.version, VERSION);
  assert.equal(lockfile.version, VERSION);
  assert.equal(lockfile.packages[''].version, VERSION);
});

test('권한 목록은 v0.4.0과 같다(v0.5.0에서 권한을 더하지 않았다)', () => {
  assert.deepEqual(manifest.permissions, PINNED_PERMISSIONS);
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
});

test('manifest 설명은 132자 이하다', () => {
  assert.ok([...manifest.description].length <= MAX_SHORT);
});

test('짧은 소개는 132자 이하이고 비어 있지 않다', () => {
  const line = section('짧은 소개').split('\n').find((l) => l.startsWith('> '));
  assert.ok(line, '인용문(> ) 한 줄이 필요해요');
  const text = line.slice(2).trim();
  assert.ok(text.length > 0);
  assert.ok([...text].length <= MAX_SHORT, `길이 ${[...text].length}`);
});

test('필수 섹션이 모두 있다', () => {
  for (const t of ['자세한 설명', '단일 목적', '권한별 사유', '데이터 사용 공개', '개인정보 처리방침']) {
    assert.ok(listing.includes('## ' + t), t);
  }
});

test('권한 사유가 manifest의 모든 권한과 호스트 권한을 다룬다', () => {
  const body = section('권한별 사유');
  const all = [...manifest.permissions, ...manifest.host_permissions];
  for (const perm of all) {
    assert.ok(body.includes('`' + perm + '`'), `사유 없음: ${perm}`);
  }
});

test('권한 사유 표의 각 행에 사유가 적혀 있다', () => {
  const rows = section('권한별 사유').split('\n').filter((l) => /^\| `/.test(l));
  assert.ok(rows.length >= manifest.permissions.length + manifest.host_permissions.length);
  for (const r of rows) {
    const cells = r.split('|').map((c) => c.trim()).filter(Boolean);
    assert.ok(cells[1] && cells[1].length >= 10, r);
  }
});

test('manifest의 모든 권한이 개인정보 처리방침 페이지에도 언급된다', () => {
  for (const perm of manifest.permissions) {
    assert.ok(privacy.includes(perm), `privacy.html에 없음: ${perm}`);
  }
});

test('개인정보 처리방침 주소가 문서에 있고 privacy.html이 존재한다', () => {
  assert.ok(section('개인정보 처리방침').includes(PRIVACY_URL));
  assert.ok(fs.existsSync(path.join(root, 'docs/privacy.html')));
});

test('데이터 사용 공개: 판매·무관 목적 사용·신용 평가 금지를 인증한다', () => {
  const body = section('데이터 사용 공개');
  assert.ok(body.includes('판매'));
  assert.ok(body.includes('무관'));
  assert.ok(body.includes('신용'));
});

test('데이터 사용 공개가 privacy.html의 저장 항목과 어긋나지 않는다', () => {
  const body = section('데이터 사용 공개');
  // 처리방침이 "저장하지 않음"이라 밝힌 항목을 수집한다고 쓰면 안 된다
  assert.ok(privacy.includes('전체 카드번호'));
  assert.ok(/전체 카드번호[^\n]*저장하지 않/.test(body) || body.includes('끝 4자리'));
  assert.ok(!/개발자 서버로 (전송|보내)해요/.test(body));
});

test('자세한 설명이 카드 이용내역 가져오기와 계정 페이지 읽기를 설명한다', () => {
  const body = section('자세한 설명');
  assert.ok(body.includes('이용내역'), '이용내역 가져오기');
  assert.ok(body.includes('구독 계정 페이지'), '계정 페이지 읽기');
});

test('권한 사유(<all_urls>)가 계정 페이지 읽기를 설명한다', () => {
  const row = section('권한별 사유').split('\n').find((l) => l.includes('`<all_urls>`'));
  assert.ok(row && row.includes('요금제'), row);
});

test('데이터 사용 공개가 이용내역 원문을 저장·전송하지 않는다고 밝힌다', () => {
  const body = section('데이터 사용 공개');
  assert.ok(body.includes('이용내역') && body.includes('원문'));
});

test('개인정보 처리방침이 이용내역 가져오기를 브라우저 안에서만 처리한다고 밝힌다', () => {
  assert.ok(privacy.includes('이용내역'));
  assert.ok(privacy.includes('원문'));
  assert.ok(privacy.includes('구독 계정 페이지'));
});

test('개인정보 처리방침이 계정 페이지 읽기 대상 사이트를 모두 적는다', () => {
  for (const site of ACCOUNT_SITES) {
    assert.ok(privacy.includes(site.name), `처리방침에 없음: ${site.name}`);
  }
});

test('Azure 앱 ID가 비어 있으면 Azure 문구와 Azure 전용 권한이 없다', () => {
  const config = require('../src/lib/cloud/config.js');
  if (config.AZURE_CLIENT_ID) return;
  assert.ok(!manifest.description.includes('Azure'), 'manifest 설명');
  assert.ok(!listing.includes('Azure'), 'store-listing.md');
  for (const perm of ['identity', 'declarativeNetRequestWithHostAccess']) {
    assert.ok(!manifest.permissions.includes(perm), `쓰지 않는 권한: ${perm}`);
  }
});
