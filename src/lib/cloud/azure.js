/* Azure Cost Management 연동. Microsoft 로그인(인가 코드 + PKCE)으로 받은 refresh token만 저장하고,
   사용자 본인 권한으로 구독 목록과 비용을 읽는다(Cost Management Reader 이상이면 된다). */
(function (root) {
  'use strict';

  const C = root.PaymentCloudCosts || require('./costs.js');

  const LOGIN = 'https://login.microsoftonline.com';
  const ARM = 'https://management.azure.com';
  const SCOPE = `${ARM}/user_impersonation offline_access`;
  const COST_API_VERSION = '2023-11-01';
  const SUB_API_VERSION = '2022-12-01';
  const MAX_PAGES = 10;
  const RATE_LIMIT_WAIT_MS = 20 * 1000;
  const BILLABLE_STATES = new Set(['Enabled', 'PastDue', 'Warned']);
  const COST_COLUMNS = ['Cost', 'PreTaxCost', 'CostUSD', 'totalCost'];
  const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const TENANT_RE = /^(organizations|common|[0-9a-f-]{36}|[a-z0-9-]+(\.[a-z0-9-]+)+)$/i;

  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  function randomString(byteLength = 32) {
    return b64url(root.crypto.getRandomValues(new Uint8Array(byteLength)));
  }

  async function pkceChallenge(verifier) {
    return b64url(await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  }

  function validateCredentials(credentials) {
    normalizeTenant(credentials && credentials.tenant);
    if (typeof (credentials && credentials.refreshToken) !== 'string' || !credentials.refreshToken) {
      throw new Error('Microsoft 로그인 정보가 없어요. 다시 로그인해 주세요.');
    }
  }

  function normalizeTenant(tenant) {
    const t = String(tenant || '').trim() || 'organizations';
    if (!TENANT_RE.test(t)) throw new Error('디렉터리(테넌트) ID 형식이 아니에요. 모르면 비워 두세요.');
    return t;
  }

  // id_token은 화면에 계정 이름을 보여줄 때만 쓴다. 권한 판단에 쓰지 않으므로 서명 검증은 하지 않는다.
  function accountNameFromIdToken(idToken) {
    try {
      const payload = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload.preferred_username || payload.email || payload.name || null;
    } catch {
      return null;
    }
  }

  function tokenRequest(fetchImpl, tenant, params) {
    return C.requestJson(fetchImpl, `${LOGIN}/${tenant}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    }, 'Microsoft 로그인');
  }

  /**
   * 1단계(확장 페이지): 로그인 창을 띄워 인가 코드를 받는다.
   * launch: chrome.identity.launchWebAuthFlow, redirectUri: chrome.identity.getRedirectURL('azure')
   * 토큰 교환은 background(exchangeCode)에서 한다. 탭이 아닌 곳의 요청에만 Origin 제거 규칙을 걸기 위해서다.
   */
  async function authorize({ clientId, tenant, redirectUri, launch }) {
    if (!clientId) throw new Error('Azure 앱이 아직 등록되지 않았어요. README의 "Azure 앱 등록"을 먼저 해 주세요.');
    const authority = normalizeTenant(tenant);
    const verifier = randomString(48);
    const state = randomString(16);
    const authUrl = `${LOGIN}/${authority}/oauth2/v2.0/authorize?${new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: `${SCOPE} openid profile`,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      prompt: 'select_account',
    })}`;
    const result = new URL(await launch({ url: authUrl, interactive: true }));
    if (result.searchParams.get('state') !== state) throw new Error('로그인 응답이 이 요청과 맞지 않아요. 다시 시도해 주세요.');
    const code = result.searchParams.get('code');
    if (!code) throw new Error(result.searchParams.get('error_description') || '로그인이 취소됐어요.');
    return { authority, code, verifier, redirectUri };
  }

  /** 2단계(background): 인가 코드를 refresh token으로 바꾼다. */
  async function exchangeCode({ clientId, authority, code, verifier, redirectUri, fetchImpl = fetch }) {
    const token = await tokenRequest(fetchImpl, normalizeTenant(authority), {
      client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      code_verifier: verifier, scope: `${SCOPE} openid profile`,
    });
    if (!token.refresh_token) throw new Error('Microsoft가 장기 로그인 토큰을 주지 않았어요. 다시 시도해 주세요.');
    return {
      label: accountNameFromIdToken(token.id_token || '') || 'Azure',
      credentials: { tenant: normalizeTenant(authority), refreshToken: token.refresh_token },
    };
  }

  async function accessToken(account, clientId, fetchImpl) {
    try {
      return await tokenRequest(fetchImpl, account.credentials.tenant, {
        client_id: clientId, grant_type: 'refresh_token', refresh_token: account.credentials.refreshToken, scope: SCOPE,
      });
    } catch (err) {
      if (err.body && err.body.error === 'invalid_grant') {
        const reauth = new Error('Microsoft 로그인이 만료됐어요. "다시 로그인"을 눌러 주세요.');
        reauth.needsReauth = true;
        throw reauth;
      }
      throw err;
    }
  }

  function buildQuery(now) {
    const w = C.billingWindow(now);
    return {
      type: 'ActualCost',
      timeframe: 'Custom',
      timePeriod: { from: `${C.isoDate(w.lastMonth)}T00:00:00Z`, to: `${C.isoDate(w.today)}T23:59:59Z` },
      dataset: {
        granularity: 'Daily',
        aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
        grouping: [{ type: 'Dimension', name: 'ServiceName' }],
      },
    };
  }

  function monthFromUsageDate(value) {
    const digits = String(value).replace(/\D/g, '').slice(0, 6);
    return digits.length === 6 ? `${digits.slice(0, 4)}-${digits.slice(4)}` : '';
  }

  function parseEntries(response) {
    const props = (response && response.properties) || {};
    const names = (props.columns || []).map((c) => c.name);
    const costIdx = names.findIndex((n) => COST_COLUMNS.includes(n));
    const dateIdx = names.indexOf('UsageDate');
    const serviceIdx = names.indexOf('ServiceName');
    const currencyIdx = names.indexOf('Currency');
    if (costIdx < 0 || dateIdx < 0) {
      if ((props.rows || []).length) throw new Error(`Azure 응답 형식이 예상과 달라요 (열: ${names.join(', ')})`);
      return [];
    }
    return (props.rows || []).map((row) => ({
      month: monthFromUsageDate(row[dateIdx]),
      service: (serviceIdx >= 0 && row[serviceIdx]) || '기타',
      amount: Number(row[costIdx]),
      currency: String((currencyIdx >= 0 && row[currencyIdx]) || 'USD').toUpperCase(),
    }));
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function postQuery(fetchImpl, url, init) {
    try {
      return await C.requestJson(fetchImpl, url, init, 'Azure');
    } catch (err) {
      if (err.status !== 429) throw err;
      await wait(RATE_LIMIT_WAIT_MS); // Cost Management는 호출 제한이 빡빡하다. 한 번만 쉬었다 다시.
      return C.requestJson(fetchImpl, url, init, 'Azure');
    }
  }

  // 다음 페이지 주소는 같은 비용 조회 경로일 때만 따른다. 토큰이 실린 POST라 다른 작업으로 새면 안 된다.
  function safeNextLink(next, firstUrl) {
    if (typeof next !== 'string') return null;
    try {
      const n = new URL(next);
      const f = new URL(firstUrl);
      return n.origin === f.origin && n.pathname.toLowerCase() === f.pathname.toLowerCase() && n.searchParams.has('api-version') ? next : null;
    } catch {
      return null;
    }
  }

  async function subscriptionEntries(fetchImpl, headers, subscriptionId, now) {
    if (!GUID_RE.test(subscriptionId)) throw new Error('구독 ID 형식이 이상해서 건너뛰었어요.');
    const init = { method: 'POST', headers, body: JSON.stringify(buildQuery(now)) };
    const firstUrl = `${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=${COST_API_VERSION}`;
    let url = firstUrl;
    const entries = [];
    for (let page = 0; page < MAX_PAGES && url; page += 1) {
      const json = await postQuery(fetchImpl, url, init);
      entries.push(...parseEntries(json));
      url = safeNextLink(json && json.properties && json.properties.nextLink, firstUrl);
    }
    return entries;
  }

  async function fetchEntries(account, { fetchImpl = fetch, now = Date.now(), clientId } = {}) {
    const token = await accessToken(account, clientId, fetchImpl);
    // refresh token은 쓸 때마다 새로 나온다. 새 값으로 바꿔 저장해야 90일 만료가 계속 밀린다.
    // 뒤에서 실패해도 새 토큰은 저장되도록 오류에도 붙여 보낸다.
    const patch = token.refresh_token ? { credentials: { ...account.credentials, refreshToken: token.refresh_token } } : null;
    try {
      return { ...await costsWithToken(fetchImpl, token, now), accountPatch: patch };
    } catch (err) {
      err.accountPatch = patch;
      throw err;
    }
  }

  async function costsWithToken(fetchImpl, token, now) {
    const headers = { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' };
    const subs = await C.requestJson(fetchImpl, `${ARM}/subscriptions?api-version=${SUB_API_VERSION}`, { headers }, 'Azure');
    const billable = (subs.value || []).filter((s) => BILLABLE_STATES.has(s.state));
    if (!billable.length) throw new Error('이 계정으로 볼 수 있는 사용 중인 Azure 구독이 없어요.');

    const entries = [];
    const warnings = [];
    for (const sub of billable) {
      try {
        entries.push(...await subscriptionEntries(fetchImpl, headers, sub.subscriptionId, now));
      } catch (err) {
        warnings.push(`${sub.displayName}: ${err.message}`);
      }
    }
    if (warnings.length === billable.length) throw new Error(warnings[0]);
    return { entries, warnings };
  }

  const api = {
    id: 'azure', label: 'Azure', LOGIN, pkceChallenge, normalizeTenant, validateCredentials, safeNextLink, authorize, exchangeCode, buildQuery, parseEntries, fetchEntries,
  };
  root.PaymentCloudAzure = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
