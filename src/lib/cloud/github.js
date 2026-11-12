/* GitHub 연동. 청구 사용량 보고서(billing usage)에서 이번 달·지난달 netAmount를 읽는다.
   GitHub의 새 청구 플랫폼(enhanced billing)을 쓰는 계정·조직에서만 열린다. */
(function (root) {
  'use strict';

  const C = root.PaymentCloudCosts || require('./costs.js');

  const API = 'https://api.github.com';
  const API_VERSION = '2026-03-10';
  const TOKEN_RE = /^(ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})$/;
  const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

  function validateCredentials({ token, org } = {}) {
    if (!TOKEN_RE.test(String(token || '').trim())) {
      throw new Error('GitHub 개인 액세스 토큰(github_pat_ 또는 ghp_로 시작)을 붙여 넣어 주세요.');
    }
    if (org && !NAME_RE.test(String(org).trim())) throw new Error('조직 이름은 영문·숫자·하이픈만 돼요.');
  }

  function explainError(err, org) {
    if (err.status === 401) return new Error('토큰이 맞지 않거나 만료됐어요. 새로 만들어 붙여 넣어 주세요.');
    if (err.status === 403) return new Error('이 토큰으로는 청구 정보를 볼 수 없어요. 개인 계정은 Plan(읽기) 권한, 조직은 관리자 권한이 필요해요.');
    if (err.status === 404 && org) return new Error(`조직 이름(${org})이 맞는지, 그 조직의 관리자인지, 조직이 GitHub 새 청구 플랫폼을 쓰는지 확인해 주세요.`);
    if (err.status === 404) return new Error('이 계정은 GitHub 새 청구 플랫폼(enhanced billing)이 아니라서 사용료를 API로 읽을 수 없어요. 요금제로 직접 기록해 주세요.');
    return err;
  }

  function parseEntries(response, fallbackMonth = '') {
    return ((response && response.usageItems) || []).flatMap((item) => {
      const amount = Number(item.netAmount);
      if (!Number.isFinite(amount)) return [];
      const month = String(item.date || '').slice(0, 7) || fallbackMonth;
      return [{ month, service: item.product || '기타', amount, currency: 'USD' }];
    });
  }

  const monthsToRead = (now) => {
    const w = C.billingWindow(now);
    return [w.thisMonth, w.lastMonth].map((d) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, key: C.isoDate(d).slice(0, 7) }));
  };

  async function usageBase(fetchImpl, headers, org) {
    if (org) return `${API}/organizations/${org.trim()}/settings/billing/usage`;
    const me = await C.requestJson(fetchImpl, `${API}/user`, { headers }, 'GitHub');
    const login = me && me.login;
    if (!NAME_RE.test(String(login || ''))) throw new Error('토큰 주인의 GitHub 아이디를 읽지 못했어요.');
    return `${API}/users/${login}/settings/billing/usage`;
  }

  async function fetchEntries(account, { fetchImpl = fetch, now = Date.now() } = {}) {
    const { token, org } = account.credentials;
    const headers = {
      authorization: `Bearer ${token.trim()}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
    };
    try {
      const base = await usageBase(fetchImpl, headers, org);
      const entries = [];
      for (const m of monthsToRead(now)) {
        const json = await C.requestJson(fetchImpl, `${base}?year=${m.year}&month=${m.month}`, { headers }, 'GitHub');
        entries.push(...parseEntries(json, m.key));
      }
      return { entries };
    } catch (err) {
      throw explainError(err, org && org.trim());
    }
  }

  const api = { id: 'github', label: 'GitHub', validateCredentials, parseEntries, fetchEntries };
  root.PaymentCloudGitHub = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
