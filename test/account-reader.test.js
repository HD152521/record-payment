const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AR = require('../src/lib/account-reader.js');
const AO = require('../src/lib/account-offer.js');
const L = require('../src/lib/ledger.js');
const P = require('../scripts/pack-lib.js');

const NOW = new Date(2026, 10, 19, 10, 0).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;
const day = (y, m, d) => new Date(y, m - 1, d).getTime();
const root = path.join(__dirname, '..');

// test/fixtures/accounts/*.html 은 실제 화면을 단순화한 가짜 HTML이다.
const read = (name, siteId) => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'accounts', `${name}.html`), 'utf8');
  return AR.parseAccountPage(siteId, AR.htmlToText(html), NOW);
};

test('htmlToText는 script·style·주석을 버리고 블록마다 줄을 나눈다', () => {
  const text = AR.htmlToText('<style>a{}</style><script>x=1</script><!-- c --><div>가&amp;나</div><p>둘&nbsp;째</p>');
  assert.equal(text, '가&나\n둘 째');
});

test('siteFor는 대상 사이트의 계정 페이지만 알아본다', () => {
  assert.equal(AR.siteFor('www.netflix.com', '/account').id, 'netflix');
  assert.equal(AR.siteFor('www.netflix.com', '/kr/account').id, 'netflix');
  assert.equal(AR.siteFor('www.netflix.com', '/browse'), null);
  assert.equal(AR.siteFor('www.youtube.com', '/paid_memberships').id, 'youtube');
  assert.equal(AR.siteFor('www.youtube.com', '/watch'), null);
  assert.equal(AR.siteFor('www.spotify.com', '/kr-ko/account/overview/').id, 'spotify');
  assert.equal(AR.siteFor('claude.ai', '/settings/billing').id, 'claude');
  assert.equal(AR.siteFor('github.com', '/settings/billing/summary').id, 'github');
  assert.equal(AR.siteFor('github.com', '/settings/profile'), null);
  assert.equal(AR.siteFor('netflix.com.evil.example', '/account'), null);
  assert.equal(AR.siteFor('', ''), null);
  assert.equal(AR.siteFor(undefined, undefined), null);
});

test('Netflix: 요금제·가격·다음 결제일을 읽고 할인·스크립트 값은 무시한다', () => {
  assert.deepEqual(read('netflix', 'netflix'), {
    siteId: 'netflix', plan: '프리미엄', amount: 17000, currency: 'KRW', cycle: 'monthly', nextChargeAt: day(2026, 12, 5),
  });
});

test('YouTube Premium: 점·공백으로 쓴 날짜와 ₩/월 표기', () => {
  assert.deepEqual(read('youtube', 'youtube'), {
    siteId: 'youtube', plan: '개인', amount: 14900, currency: 'KRW', cycle: 'monthly', nextChargeAt: day(2026, 12, 3),
  });
});

test('Spotify: 영어 날짜는 라벨 다음 줄에 있어도 읽는다', () => {
  assert.deepEqual(read('spotify', 'spotify'), {
    siteId: 'spotify', plan: 'Premium Individual', amount: 11990, currency: 'KRW', cycle: 'monthly', nextChargeAt: day(2026, 12, 9),
  });
});

test('Claude: 달러 금액과 짧은 영어 월 이름, 세금 줄은 고르지 않는다', () => {
  assert.deepEqual(read('claude', 'claude'), {
    siteId: 'claude', plan: 'Max 5x', amount: 100, currency: 'USD', cycle: 'monthly', nextChargeAt: day(2026, 12, 14),
  });
});

test('GitHub: ISO 날짜', () => {
  assert.deepEqual(read('github', 'github'), {
    siteId: 'github', plan: 'Pro', amount: 4, currency: 'USD', cycle: 'monthly', nextChargeAt: day(2026, 12, 20),
  });
});

test('못 읽으면 조용히 null: 금액이 없거나 엉뚱한 페이지', () => {
  assert.equal(read('unrelated', 'netflix'), null);
  assert.equal(AR.parseAccountPage('netflix', '', NOW), null);
  assert.equal(AR.parseAccountPage('netflix', null, NOW), null);
  assert.equal(AR.parseAccountPage('nope', '월 9,900원', NOW), null);
});

test('연간 요금과 연도 없는 날짜(다가오는 날로 추정)', () => {
  const text = '프리미엄\n연 119,000원\n다음 결제일 3월 2일';
  const r = AR.parseAccountPage('netflix', text, NOW);
  assert.equal(r.cycle, 'yearly');
  assert.equal(r.amount, 119000);
  assert.equal(r.nextChargeAt, day(2027, 3, 2));
});

test('날짜를 못 읽어도 금액이 있으면 날짜만 비운다', () => {
  const r = AR.parseAccountPage('netflix', '스탠다드 월 13,500원', NOW);
  assert.equal(r.amount, 13500);
  assert.equal(r.nextChargeAt, null);
  assert.equal(r.plan, '스탠다드');
});

test('말도 안 되는 날짜(13월 40일)는 버린다', () => {
  const r = AR.parseAccountPage('netflix', '월 13,500원\n다음 결제일 2026년 13월 40일', NOW);
  assert.equal(r.nextChargeAt, null);
});

test('아주 긴 페이지도 상한까지만 읽고 끝난다', () => {
  const text = `${'가'.repeat(500000)}\n월 9,900원`;
  assert.equal(AR.parseAccountPage('netflix', text, NOW), null);
});

const offer = { siteId: 'netflix', plan: '프리미엄', amount: 17000, currency: 'KRW', cycle: 'monthly', nextChargeAt: day(2026, 12, 5) };
const have = (over) => ({ ...L.createRecord({ site: 'netflix.com', kind: 'subscription' }, NOW), ...over });

test('decideOffer: 이미 기록된(해지 안 한) 구독이면 안내하지 않는다', () => {
  assert.deepEqual(AO.decideOffer(offer, [have()], {}, NOW), { show: false, reason: 'exists' });
  assert.equal(AO.decideOffer(offer, [have({ site: 'www.netflix.com' })], {}, NOW).show, false);
});

test('decideOffer: 해지한 기록이나 다른 서비스 기록은 막지 않는다', () => {
  assert.equal(AO.decideOffer(offer, [have({ status: 'canceled' })], {}, NOW).show, true);
  assert.equal(AO.decideOffer(offer, [have({ site: 'spotify.com' })], {}, NOW).show, true);
  assert.equal(AO.decideOffer(offer, [], {}, NOW).show, true);
});

test('decideOffer: 거절하면 30일 동안 묻지 않고 31일째엔 다시 묻는다', () => {
  const at = (days) => ({ netflix: NOW - days * DAY_MS });
  assert.deepEqual(AO.decideOffer(offer, [], at(1), NOW), { show: false, reason: 'dismissed' });
  assert.equal(AO.decideOffer(offer, [], at(29), NOW).show, false);
  assert.equal(AO.decideOffer(offer, [], at(31), NOW).show, true);
  assert.equal(AO.decideOffer(offer, [], { spotify: NOW }, NOW).show, true);
  assert.equal(AO.decideOffer(offer, [], null, NOW).show, true);
});

test('sanitizeOffer: 이상한 값은 버리고 URL의 사이트와 맞아야 한다', () => {
  const url = 'https://www.netflix.com/account';
  assert.deepEqual(AO.sanitizeOffer(offer, url), offer);
  assert.equal(AO.sanitizeOffer(offer, 'https://www.spotify.com/kr/account/overview'), null);
  assert.equal(AO.sanitizeOffer({ ...offer, amount: -1 }, url), null);
  assert.equal(AO.sanitizeOffer({ ...offer, amount: 1e12 }, url), null);
  assert.equal(AO.sanitizeOffer({ ...offer, currency: 'EUR' }, url), null);
  assert.equal(AO.sanitizeOffer(null, url), null);
  const clean = AO.sanitizeOffer({ ...offer, cycle: 'daily', plan: 'x'.repeat(500), nextChargeAt: 'soon' }, url);
  assert.equal(clean.cycle, 'monthly');
  assert.equal(clean.plan.length, 60);
  assert.equal(clean.nextChargeAt, null);
});

test('buildRecord: 확인할 기록(pending) 구독으로, 다음 결제일을 startedAt에 넣는다', () => {
  const r = AO.buildRecord(offer, NOW, 'https://www.netflix.com/account');
  assert.equal(r.site, 'netflix.com');
  assert.equal(r.siteUrl, 'https://www.netflix.com');
  assert.equal(r.kind, 'subscription');
  assert.equal(r.review, 'pending');
  assert.equal(r.amount, 17000);
  assert.equal(r.cycle, 'monthly');
  assert.equal(r.startedAt, day(2026, 12, 5));
  assert.equal(r.note, '프리미엄');
  assert.deepEqual(r.evidence, ['구독 계정 페이지에서 읽음']);
  assert.equal(L.nextChargeDate(r, NOW).getTime(), day(2026, 12, 5));
  assert.doesNotThrow(() => L.sanitizeRecord(r));
});

test('buildRecord: 날짜가 없으면 오늘을 시작일로 쓴다', () => {
  const r = AO.buildRecord({ ...offer, nextChargeAt: null }, NOW, 'https://www.netflix.com/account');
  assert.equal(r.startedAt, NOW);
});

test('보안: 계정 페이지 읽기 스크립트는 content script 규칙을 지킨다', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  for (const f of ['src/lib/account-reader.js', 'src/account-prompt.js']) {
    assert.ok(manifest.content_scripts[0].js.includes(f), f);
    assert.deepEqual(P.findContentScriptViolations(root, { [f]: fs.readFileSync(path.join(root, f), 'utf8') }), []);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(fs.readFileSync(path.join(root, f), 'utf8')), `${f}: 페이지 글을 HTML로 넣지 않아요`);
  }
});

test('decideOffer: 같은 사이트라도 구독이 아닌 기록(한 번 결제·카드 등록)은 막지 않는다', () => {
  const yt = { ...offer, siteId: 'youtube' };
  const rental = have({ site: 'youtube.com', kind: 'one_time' });
  const cardReg = have({ site: 'www.youtube.com', kind: 'card_registered' });
  assert.equal(AO.decideOffer(yt, [rental, cardReg], {}, NOW).show, true);
  assert.equal(AO.decideOffer(yt, [have({ site: 'youtube.com' })], {}, NOW).show, false);
});
