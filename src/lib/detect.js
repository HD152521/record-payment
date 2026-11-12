/* 결제 페이지 판별 로직. DOM에 의존하지 않아 content script·background·테스트가 함께 쓴다. */
(function (root) {
  'use strict';

  const MAX_TEXT_LENGTH = 30000;
  const SHORT_LINE_LENGTH = 20;

  const PG_DOMAINS = [
    ['tosspayments.com', '토스페이먼츠'], ['toss.im', '토스페이'], ['inicis.com', 'KG이니시스'],
    ['kcp.co.kr', 'NHN KCP'], ['nicepay.co.kr', '나이스페이'], ['kakaopay.com', '카카오페이'],
    ['pay.naver.com', '네이버페이'], ['payco.com', '페이코'], ['danal.co.kr', '다날'],
    ['kicc.co.kr', 'KICC'], ['ksnet.co.kr', 'KSNET'], ['iamport.kr', '포트원'], ['portone.io', '포트원'],
    ['stripe.com', 'Stripe'], ['paypal.com', 'PayPal'], ['paddle.com', 'Paddle'],
    ['lemonsqueezy.com', 'Lemon Squeezy'], ['braintreegateway.com', 'Braintree'], ['adyen.com', 'Adyen'],
    ['chargebee.com', 'Chargebee'], ['recurly.com', 'Recurly'], ['pay.google.com', 'Google Pay'],
  ];

  // 카드사 본인인증(ISP·안심클릭) 화면. 결제 흐름 중간 단계라서 "등록한 사이트"로 치지 않는다.
  const ISSUER_DOMAINS = [
    'hyundaicard.com', 'shinhancard.com', 'samsungcard.com', 'kbcard.com', 'lottecard.co.kr',
    'bccard.com', 'hanacard.co.kr', 'wooricard.com', 'card.nonghyup.com', 'citibank.co.kr', 'vpay.co.kr',
  ].map((d) => [d, d]);

  const SUBSCRIPTION_RE = /(구독|정기\s?결제|자동\s?결제|자동\s?갱신|정기\s?배송|멤버십|subscription|subscribe|recurring|auto-?renew|renews|billed\s+(monthly|annually|yearly))/i;
  const TRIAL_RE = /(무료\s?체험|체험\s?기간|free\s+trial|\btrial\b)/i;
  const CARD_REGISTER_RE = /(카드\s?등록|결제\s?수단\s?(등록|추가|변경)|결제\s?카드\s?(등록|추가|변경)|add\s+(a\s+)?(payment\s+method|card)|update\s+(your\s+)?(payment\s+method|card)|save\s+card)/i;
  const PAYMENT_CONTEXT_RE = /(결제|구독|카드\s?번호|payment|checkout|billing|subscribe|card\s+number)/i;
  const STRONG_ACTION_RE = /(결제|구독|구매|주문|등록|pay|subscribe|purchase|buy|order|checkout|add\s+card|save\s+card|start\s+trial|upgrade|업그레이드)/i;
  const TOTAL_LINE_RE = /(총\s?결제|결제\s?금액|최종|합계|청구|total|due\s+today|amount\s+due|결제\s?예정)/i;
  const NOISE_LINE_RE = /(할인|적립|쿠폰|배송비|포인트|할부|discount|shipping|\btax\b|세금|부가세)/i;
  const INSTALLMENT_RE = /(할부|무이자|installment)/i;

  const CYCLE_RULES = [
    ['monthly', /(매월|월간|월\s?정기|(?<!\d)월\s?[₩$\d]|\/\s?월|\bmonth(ly)?\b|\/\s?mo\b|per\s+month)/i],
    ['yearly', /(연간|매년|(?<!\d)연\s?[₩$\d]|\/\s?년|\byear(ly)?\b|annual(ly)?|\/\s?yr\b|per\s+year)/i],
    ['weekly', /(매주|주간\s?결제|\bweek(ly)?\b|\/\s?wk\b|per\s+week)/i],
  ];

  const AMOUNT_RULES = [
    { currency: 'KRW', re: /₩\s?(\d{1,3}(?:,\d{3})+|\d+)/g },
    { currency: 'KRW', re: /(\d{1,3}(?:,\d{3})+|\d+)\s?원/g },
    { currency: 'USD', re: /(?:US)?\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g },
    { currency: 'USD', re: /(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s?USD\b/g },
  ];

  function matchDomain(host, list) {
    if (!host) return null;
    const h = host.toLowerCase();
    const hit = list.find(([domain]) => h === domain || h.endsWith(`.${domain}`));
    return hit ? hit[1] : null;
  }

  const pgFromHost = (host) => matchDomain(host, PG_DOMAINS);
  const isPaymentIntermediary = (host) => Boolean(pgFromHost(host) || matchDomain(host, ISSUER_DOMAINS));

  function hostOf(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null;
    } catch {
      return null;
    }
  }

  function passesLuhn(digits) {
    let sum = 0;
    for (let i = 0; i < digits.length; i += 1) {
      let n = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
      sum += n;
    }
    return sum % 10 === 0;
  }

  function cardBrand(digits) {
    if (/^4/.test(digits)) return 'VISA';
    if (/^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/.test(digits)) return 'Mastercard';
    if (/^3[47]/.test(digits)) return 'AMEX';
    if (/^35/.test(digits)) return 'JCB';
    if (/^62/.test(digits)) return 'UnionPay';
    if (/^9/.test(digits)) return '국내전용';
    return '카드';
  }

  // 전체 번호는 여기서 버리고 브랜드와 끝 4자리만 돌려준다.
  function cardInfo(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || !passesLuhn(digits)) return null;
    return { brand: cardBrand(digits), last4: digits.slice(-4) };
  }

  function parseAmounts(line) {
    const found = [];
    for (const { currency, re } of AMOUNT_RULES) {
      for (const m of line.matchAll(re)) {
        const amount = Number(m[1].replace(/,/g, ''));
        if (Number.isFinite(amount) && amount > 0) found.push({ amount, currency });
      }
    }
    return found;
  }

  function detectCycleIn(line) {
    if (INSTALLMENT_RE.test(line)) return null;
    const hit = CYCLE_RULES.find(([, re]) => re.test(line));
    return hit ? hit[0] : null;
  }

  function dominantCycle(text) {
    const lines = text.split(/\n+/).filter((l) => !INSTALLMENT_RE.test(l)).join('\n');
    let best = null;
    let bestCount = 0;
    for (const [cycle, re] of CYCLE_RULES) {
      const count = (lines.match(new RegExp(re.source, 'gi')) || []).length;
      if (count > bestCount) {
        best = cycle;
        bestCount = count;
      }
    }
    return best;
  }

  function scoreLine(context) {
    return (TOTAL_LINE_RE.test(context) ? 3 : 0)
      + (detectCycleIn(context) ? 2 : 0)
      - (NOISE_LINE_RE.test(context) ? 3 : 0);
  }

  function pickAmount(text) {
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    let best = null;
    lines.forEach((line, i) => {
      const found = parseAmounts(line);
      if (!found.length) return;
      // 금액만 있는 짧은 줄은 바로 윗줄 라벨("총 결제금액")과 묶어서 본다
      const context = i > 0 && line.length < SHORT_LINE_LENGTH ? `${lines[i - 1]} ${line}` : line;
      const score = scoreLine(context);
      for (const f of found) {
        if (!best || score > best.score || (score === best.score && f.amount > best.amount)) {
          best = { ...f, score, context };
        }
      }
    });
    return best;
  }

  function classify({ hasSubscriptionWord, lineCycle, isCardRegistration, hasAmount }) {
    if (hasSubscriptionWord || lineCycle) return 'subscription';
    if (hasAmount) return 'one_time';
    if (isCardRegistration) return 'card_registered';
    return 'unknown';
  }

  function analyzeText(rawText, actionText = '') {
    const text = String(rawText || '').slice(0, MAX_TEXT_LENGTH);
    const action = String(actionText || '');
    const picked = pickAmount(text);
    const lineCycle = picked ? detectCycleIn(picked.context) : null;
    const hasSubscriptionWord = SUBSCRIPTION_RE.test(action)
      || (SUBSCRIPTION_RE.test(text) && Boolean(dominantCycle(text)));
    const isCardRegistration = CARD_REGISTER_RE.test(text) || CARD_REGISTER_RE.test(action);
    return {
      amount: picked ? picked.amount : null,
      currency: picked ? picked.currency : null,
      cycle: lineCycle || (hasSubscriptionWord ? dominantCycle(text) : null),
      kind: classify({ hasSubscriptionWord, lineCycle, isCardRegistration, hasAmount: Boolean(picked) }),
      trial: TRIAL_RE.test(text) || TRIAL_RE.test(action),
      isPaymentContext: PAYMENT_CONTEXT_RE.test(text) || PAYMENT_CONTEXT_RE.test(action),
      isStrongAction: STRONG_ACTION_RE.test(action),
    };
  }

  const api = { analyzeText, cardInfo, pgFromHost, isPaymentIntermediary, hostOf };
  root.PaymentTracker = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
