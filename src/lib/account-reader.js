/* 구독 계정 페이지(요금제·가격·다음 결제일) 읽기. DOM·저장소에 의존하지 않는 순수 함수만 둔다.
   content script(모든 페이지에서 돈다)와 테스트가 함께 쓰므로 storage·ledger를 불러오지 않는다.
   사이트별 화면 구조는 실계정으로 확인할 수 없어서, 공개된 화면에 흔한 라벨(다음 결제일·월 요금)을 기준으로
   읽는다. 못 읽으면 null을 돌려주고 조용히 넘어간다. */
(function (root) {
  'use strict';

  const MAX_TEXT = 30000;
  const MAX_LINES = 400;
  const MAX_PLAN_LENGTH = 60;
  const MAX_AMOUNT = 1e10;
  const SHORT_LINE = 20;

  const LOCALE = '(?:[a-z]{2}(?:-[A-Za-z]{2})?\\/)?';
  // plans: 긴 이름을 앞에 둔다. 영어 단어는 다른 단어 속(Profile의 Pro)에서 걸리지 않게 앞뒤를 막는다.
  const SITES = [
    { id: 'netflix', name: 'Netflix', domain: 'netflix.com', hosts: ['netflix.com', 'www.netflix.com'],
      path: new RegExp(`^\\/${LOCALE}(?:account|youraccount)(?:\\/|$)`, 'i'),
      plans: ['광고형 스탠다드', '스탠다드', '프리미엄', '베이식', 'Premium', 'Standard', 'Basic'] },
    { id: 'youtube', name: 'YouTube Premium', domain: 'youtube.com', hosts: ['youtube.com', 'www.youtube.com'],
      path: /^\/paid_memberships(?:\/|$)/i,
      plans: ['개인', '가족', '학생', 'Individual', 'Family', 'Student'] },
    { id: 'spotify', name: 'Spotify', domain: 'spotify.com', hosts: ['spotify.com', 'www.spotify.com'],
      path: new RegExp(`^\\/${LOCALE}account\\/(?:overview|subscription)(?:\\/|$)`, 'i'),
      plans: ['Premium Individual', 'Premium Duo', 'Premium Family', 'Premium Student', 'Individual', 'Duo', 'Family', 'Student', '개인', '듀오', '가족', '학생'] },
    { id: 'claude', name: 'Claude', domain: 'claude.ai', hosts: ['claude.ai'],
      path: /^\/settings\/billing(?:\/|$)/i,
      plans: ['Max 20x', 'Max 5x', 'Max', 'Pro', 'Team', 'Free'] },
    { id: 'github', name: 'GitHub', domain: 'github.com', hosts: ['github.com'],
      path: /^\/settings\/billing(?:\/|$)/i,
      plans: ['Copilot Pro\\+', 'Copilot Pro', 'Copilot Business', 'Enterprise', 'Team', 'Pro', 'Free'] },
  ].map((s) => Object.freeze({
    ...s,
    planRe: new RegExp(`(?<![A-Za-z])(?:${s.plans.map((p) => p.replace(/\s/g, '\\s')).join('|')})(?![A-Za-z])`, 'i'),
  }));
  const SITE_BY_ID = new Map(SITES.map((s) => [s.id, s]));

  const AMOUNT_RULES = [
    { currency: 'KRW', re: /₩\s?(\d{1,3}(?:,\d{3})+|\d+)/g },
    { currency: 'KRW', re: /(\d{1,3}(?:,\d{3})+|\d+)\s?원/g },
    { currency: 'USD', re: /(?:US)?\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g },
  ];
  const MONTHLY_RE = /(매월|월간|\/\s?월|(?<!\d)월\s?[₩$\d]|\bmonth(?:ly)?\b|\/\s?mo\b|per\s+month)/i;
  const YEARLY_RE = /(매년|연간|\/\s?년|(?<!\d)연\s?[₩$\d]|\byear(?:ly)?\b|\bannual(?:ly)?\b|\/\s?yr\b|per\s+year)/i;
  const NOISE_RE = /(할인|적립|쿠폰|세금|부가세|환불|\btax\b|discount|coupon|credit|refund)/i;
  const DATE_LABEL_RE = /(다음\s?(?:결제|청구|갱신)|결제\s?예정일|갱신\s?(?:일|예정)|next\s+(?:billing|payment|charge)|payment\s+due|renews?\b)/i;

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MONTH_ALT = MONTHS.join('|');
  const DATE_YMD_RE = /(\d{4})\s*[년.\-/]\s*(\d{1,2})\s*[월.\-/]\s*(\d{1,2})/;
  const DATE_MDY_RE = new RegExp(`\\b(${MONTH_ALT})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, 'i');
  const DATE_DMY_RE = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_ALT})[a-z]*\\.?,?\\s+(\\d{4})`, 'i');
  const DATE_MD_RE = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/;

  const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
  const BLOCK_TAG_RE = /<\/?(?:div|p|br|h[1-6]|li|ul|ol|section|tr|td|th|table|header|footer|main|article|form|button)\b[^>]*>/gi;

  /** 테스트용: HTML 조각을 화면에 보이는 글(줄 단위)로 바꾼다. 실제 페이지에서는 innerText를 쓴다. */
  function htmlToText(html) {
    return String(html || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
      .replace(BLOCK_TAG_RE, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e])
      .split('\n').map((l) => l.trim()).filter(Boolean)
      .join('\n');
  }

  function siteFor(host, pathname) {
    const h = String(host || '').toLowerCase();
    const p = String(pathname || '');
    if (!h) return null;
    return SITES.find((s) => s.hosts.includes(h) && s.path.test(p)) || null;
  }

  const startOfDay = (ts) => {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };

  function validDate(y, m, d) {
    const date = new Date(y, m - 1, d);
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date.getTime() : null;
  }

  function parseDate(str, now) {
    const ymd = DATE_YMD_RE.exec(str);
    if (ymd) return validDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
    const mdy = DATE_MDY_RE.exec(str);
    if (mdy) return validDate(Number(mdy[3]), MONTHS.indexOf(mdy[1].toLowerCase()) + 1, Number(mdy[2]));
    const dmy = DATE_DMY_RE.exec(str);
    if (dmy) return validDate(Number(dmy[3]), MONTHS.indexOf(dmy[2].toLowerCase()) + 1, Number(dmy[1]));
    const md = DATE_MD_RE.exec(str);
    if (!md) return null;
    const year = new Date(now).getFullYear();
    const thisYear = validDate(year, Number(md[1]), Number(md[2]));
    if (thisYear == null) return null;
    return thisYear >= startOfDay(now) ? thisYear : validDate(year + 1, Number(md[1]), Number(md[2]));
  }

  function findNextChargeAt(lines, now) {
    const i = lines.findIndex((l) => DATE_LABEL_RE.test(l));
    if (i < 0) return null;
    return parseDate(lines[i], now) ?? (lines[i + 1] ? parseDate(lines[i + 1], now) : null);
  }

  const cycleOf = (s) => (MONTHLY_RE.test(s) ? 'monthly' : YEARLY_RE.test(s) ? 'yearly' : null);

  function amountsIn(line) {
    return AMOUNT_RULES.flatMap(({ currency, re }) => [...line.matchAll(re)]
      .map((m) => ({ amount: Number(m[1].replace(/,/g, '')), currency }))
      .filter((a) => Number.isFinite(a.amount) && a.amount > 0 && a.amount < MAX_AMOUNT));
  }

  /** 주기가 같은 줄(금액만 짧게 있으면 윗줄까지)에 적힌 금액만 요금으로 본다. 할인·세금 줄은 뺀다. */
  function findPrice(lines) {
    for (let i = 0; i < lines.length; i += 1) {
      const found = amountsIn(lines[i]);
      if (!found.length) continue;
      const context = i > 0 && lines[i].length < SHORT_LINE ? `${lines[i - 1]} ${lines[i]}` : lines[i];
      const cycle = cycleOf(context);
      if (cycle && !NOISE_RE.test(context)) return { ...found[0], cycle };
    }
    return null;
  }

  /** 페이지 글에서 { siteId, plan, amount, currency, cycle, nextChargeAt } 를 읽는다. 못 읽으면 null. */
  function parseAccountPage(siteId, rawText, now = Date.now()) {
    const site = SITE_BY_ID.get(siteId);
    if (!site || typeof rawText !== 'string') return null;
    const text = rawText.slice(0, MAX_TEXT);
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, MAX_LINES);
    const price = findPrice(lines);
    if (!price) return null;
    const planMatch = site.planRe.exec(text);
    return {
      siteId: site.id,
      plan: planMatch ? planMatch[0].replace(/\s+/g, ' ') : '',
      amount: price.amount,
      currency: price.currency,
      cycle: price.cycle,
      nextChargeAt: findNextChargeAt(lines, now),
    };
  }

  const api = { SITES, MAX_PLAN_LENGTH, MAX_AMOUNT, htmlToText, siteFor, parseDate, parseAccountPage };
  root.PaymentAccountReader = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
