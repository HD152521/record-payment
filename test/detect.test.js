const { test } = require('node:test');
const assert = require('node:assert/strict');
const PT = require('../src/lib/detect.js');

test('cardInfo returns brand and last4 for a valid VISA number', () => {
  assert.deepEqual(PT.cardInfo('4242 4242 4242 4242'), { brand: 'VISA', last4: '4242' });
});

test('cardInfo recognizes Mastercard and AMEX', () => {
  assert.equal(PT.cardInfo('5555555555554444').brand, 'Mastercard');
  assert.equal(PT.cardInfo('378282246310005').brand, 'AMEX');
});

test('cardInfo rejects partial input and numbers failing Luhn', () => {
  assert.equal(PT.cardInfo('1234'), null);
  assert.equal(PT.cardInfo('4242424242424241'), null);
});

test('pgFromHost matches payment gateways including subdomains only', () => {
  assert.equal(PT.pgFromHost('js.stripe.com'), 'Stripe');
  assert.equal(PT.pgFromHost('pay.toss.im'), '토스페이');
  assert.equal(PT.pgFromHost('notstripe.com'), null);
});

test('isPaymentIntermediary covers card issuer auth pages', () => {
  assert.equal(PT.isPaymentIntermediary('ansimclick.hyundaicard.com'), true);
  assert.equal(PT.isPaymentIntermediary('www.coupang.com'), false);
});

test('Korean checkout picks the total and classifies as one-time', () => {
  const text = '주문/결제\n상품금액\n25,000원\n배송비\n3,000원\n할인\n-2,000원\n총 결제금액\n26,000원';
  const result = PT.analyzeText(text, '결제하기');
  assert.equal(result.amount, 26000);
  assert.equal(result.currency, 'KRW');
  assert.equal(result.kind, 'one_time');
  assert.equal(result.cycle, null);
});

test('monthly subscription page is classified with its cycle', () => {
  const text = 'Pro 플랜\n월 9,900원\n매월 자동 결제됩니다';
  const result = PT.analyzeText(text, '구독 시작하기');
  assert.equal(result.kind, 'subscription');
  assert.equal(result.cycle, 'monthly');
  assert.equal(result.amount, 9900);
});

test('USD yearly plan is detected', () => {
  const result = PT.analyzeText('Annual plan\n$96/year\nBilled annually', 'Subscribe');
  assert.equal(result.kind, 'subscription');
  assert.equal(result.cycle, 'yearly');
  assert.equal(result.amount, 96);
  assert.equal(result.currency, 'USD');
});

test('installment lines are not mistaken for a subscription', () => {
  const text = '총 결제금액 1,200,000원\n12개월 무이자 할부 월 100,000원';
  const result = PT.analyzeText(text, '결제하기');
  assert.equal(result.kind, 'one_time');
  assert.equal(result.amount, 1200000);
});

test('dates like 9월 29일 do not count as monthly', () => {
  const result = PT.analyzeText('9월 29일 주문\n결제금액 15,000원', '주문하기');
  assert.equal(result.cycle, null);
  assert.equal(result.kind, 'one_time');
});

test('card registration page without amount is card_registered', () => {
  const result = PT.analyzeText('결제수단 등록\n카드번호\n유효기간', '등록');
  assert.equal(result.kind, 'card_registered');
  assert.equal(result.amount, null);
  assert.equal(result.isPaymentContext, true);
});

test('free trial is flagged', () => {
  const result = PT.analyzeText('7일 무료 체험 후 매월 $20', 'Start trial');
  assert.equal(result.trial, true);
  assert.equal(result.kind, 'subscription');
});
