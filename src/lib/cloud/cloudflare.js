/* Cloudflare 연동. 계정 청구 내역(billing history)을 읽는다. 토큰에는 "Billing Read" 권한만 주면 된다.
   Cloudflare는 한 달에 한 번 청구되는 구조라 월말 예상은 날짜로 늘리지 않고 청구액 기준으로 낸다. */
(function (root) {
  'use strict';

  const C = root.PaymentCloudCosts || require('./costs.js');

  const API = 'https://api.cloudflare.com/client/v4';
  const TOKEN_RE = /^[A-Za-z0-9_-]{30,}$/;
  const ACCOUNT_RE = /^[0-9a-f]{32}$/i;
  const PER_PAGE = 50;
  const MAX_PAGES = 5;
  const MAX_ACCOUNTS = 5;

  function validateCredentials({ apiToken, accountId } = {}) {
    if (!TOKEN_RE.test(String(apiToken || '').trim())) {
      throw new Error('API 토큰을 확인해 주세요. "Billing Read" 권한으로 만든 토큰 전체를 붙여 넣어야 해요.');
    }
    if (accountId && !ACCOUNT_RE.test(String(accountId).trim())) {
      throw new Error('계정 ID는 32자리 영문·숫자예요. 모르면 비워 두세요.');
    }
  }

  function explainError(err) {
    if (err.status === 401) return new Error('토큰이 맞지 않거나 만료됐어요. 새로 만들어 붙여 넣어 주세요.');
    if (err.status === 403) return new Error('이 토큰으로는 청구 내역을 볼 수 없어요. 토큰 권한에 Account → Billing → Read(Billing Read)를 넣어 주세요.');
    return err;
  }

  /** 청구 내역 중 지난달 1일 이후 것만. 한 청구서의 여러 줄은 모두 더하고, 페이지가 겹쳐 같은 행(id)이 다시 오면 한 번만. */
  function parseEntries(items, now) {
    const since = C.billingWindow(now).lastMonth.getTime();
    const seen = new Set();
    return items.flatMap((item) => {
      const at = Date.parse(item.occurred_at);
      const amount = Number(item.amount);
      if (!Number.isFinite(at) || at < since || !Number.isFinite(amount)) return [];
      if (item.id) {
        if (seen.has(item.id)) return [];
        seen.add(item.id);
      }
      return [{
        month: C.isoDate(new Date(at)).slice(0, 7),
        service: item.description || item.type || '기타',
        amount,
        currency: String(item.currency || 'USD').toUpperCase(),
      }];
    });
  }

  async function listAccountIds(fetchImpl, headers) {
    const json = await C.requestJson(fetchImpl, `${API}/accounts?per_page=50`, { headers }, 'Cloudflare');
    const ids = ((json && json.result) || []).map((a) => a.id).filter((id) => ACCOUNT_RE.test(String(id)));
    if (!ids.length) throw new Error('이 토큰으로 볼 수 있는 Cloudflare 계정이 없어요. 계정 ID를 직접 넣어 주세요.');
    return ids.slice(0, MAX_ACCOUNTS);
  }

  async function accountHistory(fetchImpl, headers, accountId) {
    const items = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = `${API}/accounts/${accountId}/billing/history?page=${page}&per_page=${PER_PAGE}`;
      const json = await C.requestJson(fetchImpl, url, { headers }, 'Cloudflare');
      const result = (json && json.result) || [];
      items.push(...result);
      const info = (json && json.result_info) || {};
      const perPage = info.per_page || PER_PAGE;
      if (!result.length || !info.total_count || page * perPage >= info.total_count) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  // 계정이 여럿이면 권한 없는 계정은 건너뛰고 경고만 남긴다. 하나도 못 읽으면 실패.
  async function readAccounts(fetchImpl, headers, ids) {
    const results = await Promise.all(ids.map((id) => accountHistory(fetchImpl, headers, id)
      .then((r) => ({ id, ...r }), (err) => ({ id, err }))));
    const failed = results.filter((r) => r.err);
    if (failed.length === results.length) throw failed[0].err;
    const warnings = [
      ...failed.map((r) => `계정 ${r.id.slice(0, 6)}… 은 청구 내역을 볼 권한이 없어 뺐어요`),
      ...results.filter((r) => r.truncated).map((r) => `계정 ${r.id.slice(0, 6)}… 은 청구 내역이 길어 ${MAX_PAGES * PER_PAGE}건까지만 읽었어요(합계가 빠질 수 있어요)`),
    ];
    return { items: results.flatMap((r) => r.items || []), warnings };
  }

  async function fetchEntries(account, { fetchImpl = fetch, now = Date.now() } = {}) {
    const { apiToken, accountId } = account.credentials;
    const headers = { authorization: `Bearer ${apiToken.trim()}` };
    try {
      const ids = accountId ? [accountId.trim()] : await listAccountIds(fetchImpl, headers);
      const { items, warnings } = await readAccounts(fetchImpl, headers, ids);
      return { entries: parseEntries(items, now), warnings, projection: 'billed' };
    } catch (err) {
      throw explainError(err);
    }
  }

  const api = { id: 'cloudflare', label: 'Cloudflare', validateCredentials, parseEntries, fetchEntries };
  root.PaymentCloudCloudflare = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
