/* 계정 페이지에서 읽은 값(offer)을 background가 검사하고 기록으로 바꾼다. content script에는 싣지 않는다. */
(function (root) {
  'use strict';

  const R = root.PaymentAccountReader || (typeof require === 'function' ? require('./account-reader.js') : null);
  const L = root.PaymentLedger || (typeof require === 'function' ? require('./ledger.js') : null);

  const DISMISS_DAYS = 30;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const CYCLES = new Set(['monthly', 'yearly']);
  const CURRENCIES = new Set(['KRW', 'USD']);
  const EVIDENCE = '구독 계정 페이지에서 읽음';

  const hostMatches = (host, domain) => {
    const h = String(host || '').toLowerCase();
    return h === domain || h.endsWith(`.${domain}`);
  };

  function hostOfUrl(url) {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  }

  /** content script가 보낸 값을 믿지 않고 다시 검사한다. 보낸 탭의 주소와 사이트가 맞아야 한다. */
  function sanitizeOffer(raw, tabUrl) {
    const o = raw && typeof raw === 'object' ? raw : null;
    const u = hostOfUrl(tabUrl);
    const site = u && R.siteFor(u.hostname, u.pathname);
    if (!o || !site || o.siteId !== site.id) return null;
    if (!Number.isFinite(o.amount) || o.amount <= 0 || o.amount >= R.MAX_AMOUNT || !CURRENCIES.has(o.currency)) return null;
    return {
      siteId: site.id,
      plan: typeof o.plan === 'string' ? o.plan.slice(0, R.MAX_PLAN_LENGTH) : '',
      amount: o.amount,
      currency: o.currency,
      cycle: CYCLES.has(o.cycle) ? o.cycle : 'monthly',
      nextChargeAt: Number.isFinite(o.nextChargeAt) ? o.nextChargeAt : null,
    };
  }

  /** 이미 기록된(해지 안 한) 서비스거나, 30일 안에 거절했으면 안내하지 않는다. */
  function decideOffer(offer, records, dismissed, now = Date.now()) {
    const site = R.SITES.find((s) => s.id === offer.siteId);
    if (!site) return { show: false, reason: 'unknown' };
    if ((records || []).some((r) => r.status !== 'canceled' && hostMatches(r.site, site.domain))) {
      return { show: false, reason: 'exists' };
    }
    const at = dismissed && dismissed[site.id];
    if (Number.isFinite(at) && now - at < DISMISS_DAYS * DAY_MS) return { show: false, reason: 'dismissed' };
    return { show: true, reason: null };
  }

  /** "확인할 기록"(pending) 구독. 다음 결제일을 첫 결제일로 두면 이후 결제일이 주기대로 이어진다. */
  function buildRecord(offer, now, tabUrl) {
    const site = R.SITES.find((s) => s.id === offer.siteId);
    const u = hostOfUrl(tabUrl);
    return L.createRecord({
      site: site.domain,
      siteUrl: u ? L.originOnly(u.origin) : '',
      kind: 'subscription',
      cycle: offer.cycle,
      amount: offer.amount,
      currency: offer.currency,
      note: offer.plan,
      evidence: [EVIDENCE],
      startedAt: offer.nextChargeAt ?? now,
    }, now);
  }

  const api = { DISMISS_DAYS, sanitizeOffer, decideOffer, buildRecord };
  root.PaymentAccountOffer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
