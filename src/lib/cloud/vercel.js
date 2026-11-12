/* Vercel 연동. 청구 요금(billing charges, FOCUS 형식 JSONL)을 팀별로 읽어 BilledCost를 더한다. */
(function (root) {
  'use strict';

  const C = root.PaymentCloudCosts || require('./costs.js');

  const API = 'https://api.vercel.com';
  const TOKEN_RE = /^[A-Za-z0-9_-]{20,}$/;
  const TEAM_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const MAX_TEAMS = 5;
  const GROWING = new Set(['Usage', 'Tax', undefined]);

  function validateCredentials({ token, team } = {}) {
    if (!TOKEN_RE.test(String(token || '').trim())) {
      throw new Error('Vercel 토큰을 확인해 주세요. 공백 없이 전체를 붙여 넣어야 해요.');
    }
    if (team && !TEAM_RE.test(String(team).trim())) throw new Error('팀 ID나 팀 주소(slug)는 영문·숫자·-·_만 돼요.');
  }

  function explainError(err) {
    if (err.status === 401) return new Error('토큰이 맞지 않거나 만료됐어요. 새로 만들어 붙여 넣어 주세요.');
    if (err.status === 403) return new Error('이 토큰으로는 팀 청구 정보를 볼 수 없어요. 팀에서 Owner·Billing 등 청구를 볼 수 있는 역할이어야 해요.');
    return err;
  }

  function chargesUrl(team, now) {
    const w = C.billingWindow(now);
    const params = new URLSearchParams({
      [String(team).startsWith('team_') ? 'teamId' : 'slug']: team,
      from: w.lastMonth.toISOString(),
      to: w.tomorrow.toISOString(),
    });
    return `${API}/v1/billing/charges?${params}`;
  }

  /** 한 줄에 JSON 하나. 깨진 줄은 건너뛴다(스트림 끝이 잘릴 수 있다). */
  function parseJsonl(text) {
    return String(text || '').split('\n').flatMap((line) => {
      if (!line.trim()) return [];
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        return [];
      }
      const amount = Number(row.BilledCost);
      if (!Number.isFinite(amount)) return [];
      return [{
        month: String(row.ChargePeriodStart || '').slice(0, 7),
        service: row.ServiceName || '기타',
        amount,
        currency: String(row.BillingCurrency || 'USD').toUpperCase(),
        // 요금제 결제·크레딧·조정은 한 번 찍히는 금액이라 월말 예상에서 늘리지 않는다
        fixed: !GROWING.has(row.ChargeCategory),
      }];
    });
  }

  async function teamsToRead(fetchImpl, headers, team) {
    if (team) return [team.trim()];
    const listed = await C.requestJson(fetchImpl, `${API}/v2/teams?limit=20`, { headers }, 'Vercel');
    const ids = ((listed && listed.teams) || []).map((t) => t.id).filter((id) => TEAM_RE.test(String(id)));
    if (ids.length) return ids.slice(0, MAX_TEAMS);
    // 개인(Hobby) 계정도 기본 팀이 하나 있다.
    const me = await C.requestJson(fetchImpl, `${API}/v2/user`, { headers }, 'Vercel');
    const fallback = me && me.user && me.user.defaultTeamId;
    if (!TEAM_RE.test(String(fallback || ''))) throw new Error('이 토큰으로 볼 수 있는 Vercel 팀이 없어요. 팀 ID를 직접 넣어 주세요.');
    return [fallback];
  }

  async function fetchEntries(account, { fetchImpl = fetch, now = Date.now() } = {}) {
    const { token, team } = account.credentials;
    const headers = { authorization: `Bearer ${token.trim()}` };
    try {
      const entries = [];
      for (const t of await teamsToRead(fetchImpl, headers, team)) {
        entries.push(...parseJsonl(await C.requestText(fetchImpl, chargesUrl(t, now), { headers }, 'Vercel')));
      }
      return { entries };
    } catch (err) {
      throw explainError(err);
    }
  }

  const api = { id: 'vercel', label: 'Vercel', validateCredentials, chargesUrl, parseJsonl, fetchEntries };
  root.PaymentCloudVercel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
