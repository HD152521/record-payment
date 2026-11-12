/* OpenAI Platform 연동. 조직 Costs API는 관리자 키(sk-admin-)로만 열린다. */
(function (root) {
  'use strict';

  const C = root.PaymentCloudCosts || require('./costs.js');

  const BASE = 'https://api.openai.com/v1/organization/costs';
  const PAGE_LIMIT = 62; // 일 단위 버킷 최대 두 달치
  const MAX_PAGES = 4;

  function validateCredentials({ adminKey }) {
    if (!/^sk-admin-[A-Za-z0-9_-]+$/.test(String(adminKey || '').trim())) {
      throw new Error('관리자 키(sk-admin-으로 시작)가 필요해요. 일반 프로젝트 키로는 비용을 볼 수 없어요.');
    }
  }

  function costsUrl(now, page) {
    const w = C.billingWindow(now);
    const params = new URLSearchParams({
      start_time: String(w.lastMonth.getTime() / 1000),
      bucket_width: '1d',
      group_by: 'line_item',
      limit: String(PAGE_LIMIT),
    });
    if (page) params.set('page', page);
    return `${BASE}?${params}`;
  }

  function parseEntries(response) {
    return (response.data || []).flatMap((bucket) => {
      const month = C.isoDate(new Date(bucket.start_time * 1000)).slice(0, 7);
      return (bucket.results || []).map((r) => ({
        month,
        service: r.line_item || '기타',
        amount: Number(r.amount && r.amount.value),
        currency: String((r.amount && r.amount.currency) || 'usd').toUpperCase(),
      }));
    });
  }

  function explainError(err) {
    if (err.status === 401) return new Error('키가 맞지 않거나 삭제됐어요. 관리자 키를 다시 만들어 붙여 넣어 주세요.');
    if (err.status === 403) return new Error('이 키로는 비용을 볼 수 없어요. 조직 Owner가 만든 관리자 키인지 확인해 주세요.');
    return err;
  }

  async function fetchEntries(account, { fetchImpl = fetch, now = Date.now() } = {}) {
    const headers = { authorization: `Bearer ${account.credentials.adminKey.trim()}` };
    const entries = [];
    let page = null;
    for (let i = 0; i < MAX_PAGES; i += 1) {
      let json;
      try {
        json = await C.requestJson(fetchImpl, costsUrl(now, page), { headers }, 'OpenAI');
      } catch (err) {
        throw explainError(err);
      }
      entries.push(...parseEntries(json));
      page = json.has_more ? json.next_page : null;
      if (!page) break;
    }
    return { entries };
  }

  const api = { id: 'openai', label: 'OpenAI', validateCredentials, costsUrl, parseEntries, fetchEntries };
  root.PaymentCloudOpenAI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
