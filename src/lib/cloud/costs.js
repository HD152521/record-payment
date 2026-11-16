/* 클라우드 비용 공통 계산. 각 서비스 연동은 {month, service, amount, currency} 목록만 돌려주고,
   이번 달·지난달·월말 예상은 여기서 같은 규칙으로 만든다. 청구 기준이 UTC라서 날짜도 UTC로 센다. */
(function (root) {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const MIN_DAYS_FOR_PROJECTION = 2;
  const MIN_SERVICE_AMOUNT = 0.005;
  const MAX_SERVICES = 12;
  const MAX_SERVICE_NAME = 80;

  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const round2 = (v) => Math.round(v * 100) / 100;
  const utc = (y, m, d) => new Date(Date.UTC(y, m, d));

  /** 지난달 1일부터 내일(미포함)까지. 한 번 호출로 이번 달과 지난달을 같이 받는다. */
  function billingWindow(now) {
    const d = new Date(now);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const lastMonth = utc(y, m - 1, 1);
    const thisMonth = utc(y, m, 1);
    return {
      lastMonth,
      thisMonth,
      today: utc(y, m, d.getUTCDate()),
      tomorrow: utc(y, m, d.getUTCDate() + 1),
      lastKey: isoDate(lastMonth).slice(0, 7),
      thisKey: isoDate(thisMonth).slice(0, 7),
    };
  }

  /** 이번 달 누적 ÷ 지금까지 흐른 날(소수 포함) × 이번 달 날 수. 이틀이 안 됐으면 추정하지 않는다. */
  function projectMonthEnd(monthToDate, now) {
    const d = new Date(now);
    const elapsedDays = (now - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)) / DAY_MS;
    if (elapsedDays < MIN_DAYS_FOR_PROJECTION) return null;
    const daysInMonth = utc(d.getUTCFullYear(), d.getUTCMonth() + 1, 0).getUTCDate();
    return round2((monthToDate / elapsedDays) * daysInMonth);
  }

  // 요금제 같은 고정비(fixed)는 이미 낸 그대로, 사용량만 남은 날짜만큼 늘린다.
  function projectWithFixed(thisMonth, now) {
    const sumOf = (list) => list.reduce((acc, e) => acc + e.amount, 0);
    const fixed = sumOf(thisMonth.filter((e) => e.fixed));
    const usage = projectMonthEnd(round2(sumOf(thisMonth.filter((e) => !e.fixed))), now);
    return usage == null ? null : round2(fixed + usage);
  }

  function mostCommonCurrency(entries) {
    const counts = entries.reduce((acc, e) => ({ ...acc, [e.currency]: (acc[e.currency] || 0) + 1 }), {});
    const [top] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return top ? top[0] : 'USD';
  }

  /** projection 'billed': 한 달에 한 번 청구되는 곳(Cloudflare 등)은 날짜로 늘리면 틀려서 지난달·이번 달 중 큰 값을 쓴다. */
  function buildSnapshot(entries, now, { projection = 'linear' } = {}) {
    const w = billingWindow(now);
    const currency = mostCommonCurrency(entries);
    const sameCurrency = entries.filter((e) => e.currency === currency && Number.isFinite(e.amount));
    const thisMonth = sameCurrency.filter((e) => e.month === w.thisKey);
    const sum = (list) => round2(list.reduce((acc, e) => acc + e.amount, 0));
    const byService = thisMonth.reduce((acc, e) => {
      const name = String(e.service).slice(0, MAX_SERVICE_NAME);
      return { ...acc, [name]: (acc[name] || 0) + e.amount };
    }, {});
    const services = Object.entries(byService)
      .map(([name, amount]) => ({ name, amount: round2(amount) }))
      .filter((s) => s.amount >= MIN_SERVICE_AMOUNT)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, MAX_SERVICES);
    const monthToDate = sum(thisMonth);
    const lastMonth = sum(sameCurrency.filter((e) => e.month === w.lastKey));
    return {
      month: w.thisKey,
      currency,
      monthToDate,
      lastMonth,
      projected: projection === 'billed' ? Math.max(monthToDate, lastMonth) : projectWithFixed(thisMonth, now),
      services,
      // 통화가 섞여 있으면 합치지 않고 버린 금액이 있다는 것만 알린다.
      mixedCurrency: sameCurrency.length !== entries.length,
    };
  }

  function toKRW(amount, currency, usdKrw) {
    if (amount == null) return null;
    if (currency === 'KRW') return Math.round(amount);
    if (currency === 'USD' && usdKrw) return Math.round(amount * usdKrw);
    return null;
  }

  function totalKRW(snapshots, usdKrw) {
    const add = (field) => snapshots.reduce((acc, s) => {
      const krw = toKRW(s[field] ?? (field === 'projected' ? s.monthToDate : null), s.currency, usdKrw);
      return krw == null ? acc : acc + krw;
    }, 0);
    return { monthToDate: add('monthToDate'), projected: add('projected'), lastMonth: add('lastMonth') };
  }

  const parseJsonOrNull = (text) => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };

  /** 본문을 글자 그대로 돌려준다(JSONL 등). 실패는 사용자에게 보여줄 문장으로 바꿔 던진다. */
  async function requestText(fetchImpl, url, init, label) {
    // 토큰이 실린 요청은 리디렉션을 따라가지 않는다(다른 주소로 토큰이 새지 않게).
    const hasAuth = Boolean(init && init.headers && init.headers.authorization);
    const safeInit = hasAuth ? { ...init, redirect: 'error' } : init;
    let res;
    try {
      res = await fetchImpl(url, safeInit);
    } catch (err) {
      throw new Error(`${label}에 연결하지 못했어요 (${err.message})`);
    }
    const text = await res.text();
    if (!res.ok) {
      const json = parseJsonOrNull(text);
      const error = new Error(`${label} 응답 ${res.status}: ${describeError(json, text)}`);
      error.status = res.status;
      error.body = json;
      throw error;
    }
    return text;
  }

  async function requestJson(fetchImpl, url, init, label) {
    return parseJsonOrNull(await requestText(fetchImpl, url, init, label));
  }

  const SECRET_PATTERNS = [
    /sk-[A-Za-z0-9_-]{8,}/g,
    /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /github_pat_[A-Za-z0-9_]{20,}/g,
    // 접두사 없는 긴 토큰(Cloudflare·Vercel 등). GUID(36자)는 남도록 40자부터.
    /\b[A-Za-z0-9_-]{40,}\b/g,
  ];
  const MIN_REDACT_LENGTH = 8;

  /** 사용자가 넣은 비밀값 그대로가 오류 문장에 되비쳐 나오면 지운다. */
  function redactValues(text, credentials) {
    const values = Object.values(credentials || {})
      .filter((v) => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => v.length >= MIN_REDACT_LENGTH);
    return values.reduce((acc, v) => acc.split(v).join('[가림]'), String(text));
  }

  function redactSecrets(text) {
    return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, '[가림]'), String(text));
  }

  function describeError(json, text) {
    const e = json && (json.error || (Array.isArray(json.errors) && json.errors[0]) || json);
    const message = (e && (e.message || e.Message || e.error_description)) || (typeof e === 'string' ? e : '') || text;
    return redactSecrets(String(message || '알 수 없는 오류').slice(0, 300));
  }

  // 자동 갱신 대상 고르기. 조회 자체가 유료인 서비스(AWS Cost Explorer, 1번에 $0.01)는 하루 한 번만 부른다.
  // 처음 연결·달 바뀜·실패 뒤 재시도는 서비스와 상관없이 다시 가져온다. "지금 갱신"(force)은 이 규칙을 거치지 않는다.
  // 실패 뒤 재시도도 유료 서비스는 길게: 권한이 틀린 AWS 키가 30분마다 불리지 않게 한다.
  const RETRY_FAILED_AFTER_MS = 30 * 60 * 1000;
  const PAID_MIN_AGE_MS = { aws: 20 * 60 * 60 * 1000 };
  const PAID_RETRY_MS = { aws: 6 * 60 * 60 * 1000 };

  function isAccountDue(account, cost, now, maxAgeMs) {
    if (!cost) return true;
    // 실패 대기를 달 바뀜보다 먼저 본다. 실패한 항목은 지난달 month를 그대로 들고 있어서 순서가 바뀌면 매번 다시 부른다.
    if (cost.error) return now - (cost.failedAt || 0) >= (PAID_RETRY_MS[account.provider] || RETRY_FAILED_AFTER_MS);
    if (!cost.fetchedAt || cost.month !== billingWindow(now).thisKey) return true;
    return now - cost.fetchedAt >= Math.max(maxAgeMs, PAID_MIN_AGE_MS[account.provider] || 0);
  }

  const dueAccounts = (accounts, costs, now, maxAgeMs) => accounts.filter((a) => isAccountDue(a, costs[a.id], now, maxAgeMs));

  const api = { DAY_MS, PAID_MIN_AGE_MS, dueAccounts, isoDate, round2, billingWindow, projectMonthEnd, buildSnapshot, toKRW, totalKRW, requestText, requestJson, redactSecrets, redactValues };
  root.PaymentCloudCosts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
