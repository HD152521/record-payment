const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../src/lib/statement.js');
const L = require('../src/lib/ledger.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const analyze = (name) => S.analyze(fixture(name));
const day = (y, m, d) => new Date(y, m - 1, d).getTime();

test('CSV: 따옴표 안의 쉼표·줄바꿈·큰따옴표와 BOM을 읽는다', () => {
  const rows = S.parseCsv('﻿a,b\r\n"1,000","줄\n바꿈"\r\n"say ""hi""",x\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['1,000', '줄\n바꿈'], ['say "hi"', 'x']]);
});

test('CSV: 탭으로 나뉜 파일도 읽는다', () => {
  assert.deepEqual(S.parseCsv('a\tb\n1\t2\n'), [['a', 'b'], ['1', '2']]);
});

test('CSV: 빈 입력·null은 빈 배열', () => {
  assert.deepEqual(S.parseCsv(''), []);
  assert.deepEqual(S.parseCsv(null), []);
});

test('인코딩: UTF-8은 그대로, CP949(EUC-KR) 바이트는 한글로 읽는다', () => {
  const utf8 = new TextEncoder().encode('가맹점');
  assert.equal(S.decodeBuffer(utf8.buffer), '가맹점');
  // "가맹점"의 EUC-KR 바이트
  const euc = new Uint8Array([0xb0, 0xa1, 0xb8, 0xcd, 0xc1, 0xa1]);
  assert.equal(S.decodeBuffer(euc.buffer), '가맹점');
});

test('날짜: 여러 표기를 읽고 이상한 값은 거절한다', () => {
  assert.equal(S.parseDate('2026-06-05'), day(2026, 6, 5));
  assert.equal(S.parseDate('2026.06.05 10:00'), day(2026, 6, 5));
  assert.equal(S.parseDate('20260605'), day(2026, 6, 5));
  assert.equal(S.parseDate('26/06/05'), day(2026, 6, 5));
  assert.equal(S.parseDate('2026-13-40'), null);
  assert.equal(S.parseDate('가나다'), null);
  assert.equal(S.parseDate(null), null);
});

test('금액: 쉼표·원 표시를 걷고 숫자가 아니면 null', () => {
  assert.equal(S.parseAmount('13,500'), 13500);
  assert.equal(S.parseAmount('13,500원'), 13500);
  assert.equal(S.parseAmount('-35,000'), -35000);
  assert.equal(S.parseAmount('abc'), null);
  assert.equal(S.parseAmount(''), null);
});

for (const [file, issuer, last4] of [
  ['shinhan.csv', '신한카드', '4242'], ['samsung.csv', '삼성카드', '7777'],
  ['hyundai.csv', '현대카드', '5555'], ['kb.csv', 'KB국민카드', '3333'],
]) {
  test(`양식 인식: ${file}은 ${issuer}로 읽고 끝 4자리를 뽑는다`, () => {
    const res = analyze(file);
    assert.equal(res.format.name, issuer);
    assert.ok(res.transactions.length > 0);
    assert.ok(res.transactions.every((t) => t.last4 === last4));
  });
}

test('신한: 넷플릭스는 가격이 오른 뒤 금액으로 매달 반복 후보가 된다 (±10% 안)', () => {
  const [netflix, ...rest] = analyze('shinhan.csv').candidates;
  assert.equal(rest.length, 0);
  assert.equal(netflix.itemId, 'netflix');
  assert.equal(netflix.site, 'netflix.com');
  assert.equal(netflix.cycle, 'monthly');
  assert.equal(netflix.amount, 15000);
  assert.equal(netflix.last4, '4242');
  assert.equal(netflix.startedAt, day(2026, 11, 5));
  assert.equal(netflix.count, 6);
});

test('삼성: 해외 결제 표기(OPENAI *CHATGPT)를 ChatGPT로 맞추고 취소 줄은 뺀다', () => {
  const res = analyze('samsung.csv');
  assert.equal(res.candidates.length, 1);
  assert.equal(res.candidates[0].itemId, 'chatgpt');
  assert.equal(res.candidates[0].amount, 28100);
  assert.equal(res.skippedRows, 1);
});

test('현대: 매년 반복(365일 간격)은 yearly, 금액이 달라진 반복은 후보가 아니다', () => {
  const res = analyze('hyundai.csv');
  assert.equal(res.candidates.length, 1);
  assert.equal(res.candidates[0].itemId, 'spotify');
  assert.equal(res.candidates[0].cycle, 'yearly');
});

test('KB: yy/mm/dd 날짜와 영문 가맹점(Notion Labs)을 읽는다', () => {
  const res = analyze('kb.csv');
  assert.equal(res.candidates.length, 1);
  assert.equal(res.candidates[0].itemId, 'notion');
  assert.equal(res.candidates[0].count, 3);
});

test('모르는 양식: 열 고르기가 필요하다고 알려 주고 열 이름을 돌려준다', () => {
  const res = analyze('unknown.csv');
  assert.equal(res.format, null);
  assert.deepEqual(res.headers, ['번호', '결제날짜', '상호', '원금', '비고']);
  assert.equal(res.candidates.length, 0);
});

test('모르는 양식: 열을 골라 다시 분석하면 카탈로그에 없는 가맹점도 후보가 된다', () => {
  const res = S.analyze(fixture('unknown.csv'), { date: 1, merchant: 2, amount: 3, card: null });
  assert.equal(res.candidates.length, 1);
  assert.equal(res.candidates[0].itemId, null);
  assert.equal(res.candidates[0].site, '가짜클라우드');
  assert.equal(res.candidates[0].cycle, 'monthly');
  assert.equal(res.candidates[0].last4, null);
});

test('열 고르기가 잘못되면(없는 열·같은 열 두 번) 거절한다', () => {
  assert.throws(() => S.analyze(fixture('unknown.csv'), { date: 1, merchant: 1, amount: 3 }), /열/);
  assert.throws(() => S.analyze(fixture('unknown.csv'), { date: 1, merchant: 2, amount: 99 }), /열/);
});

test('같은 가맹점이 한 번뿐이거나 간격이 불규칙하면 후보가 아니다', () => {
  const csv = '이용일,이용가맹점,이용금액\n2026-01-01,가짜집,1000\n2026-01-09,가짜집,1000\n2026-03-20,가짜집,1000\n2026-05-01,혼자,5000\n';
  assert.deepEqual(S.analyze(csv).candidates, []);
});

test('쿠팡 같은 일반 쇼핑몰 표기는 와우로 보지 않고 가맹점 이름 그대로 둔다', () => {
  assert.equal(S.matchService('쿠팡(주)'), null);
  assert.equal(S.matchService('쿠팡 와우 월회비').id, 'coupang');
  assert.equal(S.matchService('LAWS BAR'), null);
  assert.equal(S.matchService('AWS EMEA').id, 'aws');
});

test('빈 파일·열이 없는 파일은 에러 대신 빈 결과', () => {
  assert.deepEqual(S.analyze('').candidates, []);
  assert.deepEqual(S.analyze('그냥 글자').candidates, []);
});

test('큰 파일: 줄 수 제한을 넘으면 거절한다', () => {
  const big = `이용일,이용가맹점,이용금액\n${'2026-01-01,가,100\n'.repeat(S.MAX_ROWS + 1)}`;
  assert.throws(() => S.analyze(big), /너무/);
});

test('기록 만들기: 확인할 기록(pending)·구독·원화·카드 연결·카탈로그 사이트', () => {
  const { candidates } = analyze('shinhan.csv');
  const cards = [{ id: 'c1', label: '내 신한', brand: 'Visa', last4: '4242', createdAt: 1 }];
  const { records, skippedExisting } = S.buildRecords(candidates, { existing: [], cards, now: 1000 });
  assert.equal(skippedExisting, 0);
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.review, 'pending');
  assert.equal(r.userEdited, false);
  assert.equal(r.kind, 'subscription');
  assert.equal(r.currency, 'KRW');
  assert.equal(r.site, 'netflix.com');
  assert.deepEqual(r.card, { brand: 'Visa', last4: '4242' });
  assert.equal(r.startedAt, day(2026, 11, 5));
  assert.equal(L.sanitizeRecord(r).site, 'netflix.com'); // 저장 경로 검사를 통과
  assert.ok(!JSON.stringify(r).includes('9999-')); // 카드번호 원문은 담지 않는다
});

test('기록 만들기: 등록하지 않은 카드 끝 4자리도 연결하고, 없으면 카드 없음', () => {
  const [withCard] = S.buildRecords(analyze('kb.csv').candidates, { existing: [], cards: [], now: 1 }).records;
  assert.deepEqual(withCard.card, { brand: '카드', last4: '3333' });
  const noCard = S.analyze(fixture('unknown.csv'), { date: 1, merchant: 2, amount: 3, card: null }).candidates;
  assert.equal(S.buildRecords(noCard, { existing: [], cards: [], now: 1 }).records[0].card, null);
});

test('겹치는 기록은 다시 넣지 않는다 (같은 서비스, 해지한 기록은 겹침이 아님)', () => {
  const { candidates } = analyze('shinhan.csv');
  const mine = L.createRecord({ site: 'www.netflix.com', kind: 'subscription', review: 'confirmed' }, 1);
  const first = S.buildRecords(candidates, { existing: [mine], cards: [], now: 2 });
  assert.equal(first.records.length, 0);
  assert.equal(first.skippedExisting, 1);
  const canceled = { ...mine, status: 'canceled' };
  assert.equal(S.buildRecords(candidates, { existing: [canceled], cards: [], now: 2 }).records.length, 1);
});

test('같은 파일을 두 번 가져와도 두 번째는 겹침으로 걸러진다', () => {
  const { candidates } = analyze('kb.csv');
  const once = S.buildRecords(candidates, { existing: [], cards: [], now: 5 }).records;
  const twice = S.buildRecords(candidates, { existing: once, cards: [], now: 6 });
  assert.equal(twice.records.length, 0);
  assert.equal(twice.skippedExisting, 1);
});

test('카탈로그에 없는 가맹점은 이름으로 겹침을 본다', () => {
  const cands = S.analyze(fixture('unknown.csv'), { date: 1, merchant: 2, amount: 3 }).candidates;
  const mine = L.createRecord({ site: ' 가짜 클라우드 ', kind: 'subscription' }, 1);
  assert.equal(S.buildRecords(cands, { existing: [mine], cards: [], now: 2 }).records.length, 0);
});

test('기록 만들기: 한 번에 넣을 수 있는 개수(50)를 넘기지 않고 id는 겹치지 않는다', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    key: `m:가게${i}`, itemId: null, site: `가게${i}`, merchant: `가게${i}`, cycle: 'monthly', amount: 1000 + i, last4: null, startedAt: day(2026, 1, 1), count: 2,
  }));
  const { records } = S.buildRecords(many, { existing: [], cards: [], now: 10 });
  assert.equal(records.length, 50);
  assert.equal(new Set(records.map((r) => r.id)).size, 50);
});
