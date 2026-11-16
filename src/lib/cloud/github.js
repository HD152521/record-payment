/* GitHub 연동. 청구 사용량 보고서(billing usage)에서 이번 달·지난달 netAmount를 읽는다.
   GitHub의 새 청구 플랫폼(enhanced billing)을 쓰는 계정·조직에서만 열린다. */
(function (root) {
  'use strict';

  const C = root.PaymentCloudCosts || require('./costs.js');

  const API = 'https://api.github.com';
  const API_VERSION = '2026-03-10';
  const TOKEN_RE = /^(ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})$/;
  const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

  function validateCredentials(credentials = {}) {
    const { token, org } = credentials;
    if (isLogin(credentials)) validateLogin(credentials);
    else if (!TOKEN_RE.test(String(token || '').trim())) {
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

  async function readUsage(fetchImpl, token, org, now) {
    const headers = {
      authorization: `Bearer ${token.trim()}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
    };
    const base = await usageBase(fetchImpl, headers, org);
    const entries = [];
    for (const m of monthsToRead(now)) {
      const json = await C.requestJson(fetchImpl, `${base}?year=${m.year}&month=${m.month}`, { headers }, 'GitHub');
      entries.push(...parseEntries(json, m.key));
    }
    return entries;
  }

  async function fetchEntries(account, { fetchImpl = fetch, now = Date.now(), githubClientId = '' } = {}) {
    if (isLogin(account.credentials)) return fetchWithLogin(account, { fetchImpl, now, clientId: githubClientId });
    const { token, org } = account.credentials;
    try {
      return { entries: await readUsage(fetchImpl, token, org, now) };
    } catch (err) {
      throw explainError(err, org && org.trim());
    }
  }

  // ── GitHub 로그인(GitHub App device flow). 클라이언트 비밀키 없이 client_id만 쓴다 ──
  const LOGIN = 'https://github.com/login';
  const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
  const UAT_RE = /^ghu_[A-Za-z0-9]{20,}$/;
  const REFRESH_RE = /^ghr_[A-Za-z0-9]{20,}$/;
  const SLOW_DOWN_SECONDS = 5;
  const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 만료 5분 전이면 미리 갱신
  const DEVICE_ERRORS = {
    device_flow_disabled: '이 GitHub 앱은 기기 연결(device flow)이 꺼져 있어요. 앱 설정에서 켜 주세요.',
    access_denied: 'GitHub에서 연결을 취소했어요. 다시 하려면 로그인 버튼을 눌러 주세요.',
    expired_token: '코드가 만료됐어요. 로그인 버튼을 다시 눌러 새 코드를 받아 주세요.',
    incorrect_client_credentials: 'GitHub 앱 ID가 맞지 않아요. 배포자에게 알려 주세요.',
  };

  const isLogin = (credentials) => Boolean(credentials && credentials.accessToken);

  function validateLogin({ accessToken, refreshToken }) {
    const bad = !UAT_RE.test(String(accessToken)) || (refreshToken != null && !REFRESH_RE.test(String(refreshToken)));
    if (bad) throw new Error('GitHub 로그인 토큰이 올바르지 않아요. 다시 로그인해 주세요.');
  }

  function postForm(fetchImpl, path, params) {
    const init = { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() };
    return C.requestJson(fetchImpl, `${LOGIN}/${path}`, init, 'GitHub 로그인');
  }

  const deviceError = (code, fallback) => new Error(DEVICE_ERRORS[code] || `GitHub 로그인에 실패했어요 (${String(fallback || code).slice(0, 100)}).`);

  /** 1단계: 사용자에게 보여줄 코드를 받는다. */
  async function requestDeviceCode({ clientId, fetchImpl = fetch } = {}) {
    if (!clientId) throw new Error('이 설치본에는 GitHub 앱 ID가 없어요.');
    const json = (await postForm(fetchImpl, 'device/code', { client_id: clientId })) || {};
    if (json.error) throw deviceError(json.error, json.error_description);
    const uri = String(json.verification_uri || '');
    if (!uri.startsWith('https://github.com/')) throw new Error('GitHub가 알려 준 코드 입력 주소가 이상해요. 다시 시도해 주세요.');
    return { deviceCode: json.device_code, userCode: json.user_code, verificationUri: uri, expiresIn: Number(json.expires_in), interval: Number(json.interval) };
  }

  function credentialsFromToken(json, now, previousRefresh) {
    const refreshToken = json.refresh_token || previousRefresh;
    const expiresIn = Number(json.expires_in);
    return {
      accessToken: json.access_token,
      ...(refreshToken ? { refreshToken } : {}),
      ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now + expiresIn * 1000 } : {}),
    };
  }

  function abortError() {
    const err = new Error('GitHub 로그인을 멈췄어요.');
    err.name = 'AbortError';
    return err;
  }

  const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 2단계: 사용자가 코드를 넣고 승인할 때까지 interval 간격으로 묻는다. */
  async function pollForToken({ clientId, device, fetchImpl = fetch, sleep = defaultSleep, now = Date.now, signal = null }) {
    const deadline = now() + device.expiresIn * 1000;
    let interval = device.interval || SLOW_DOWN_SECONDS;
    for (;;) {
      await sleep(interval * 1000);
      if (signal && signal.aborted) throw abortError();
      if (now() >= deadline) throw new Error(DEVICE_ERRORS.expired_token);
      const json = (await postForm(fetchImpl, 'oauth/access_token', { client_id: clientId, device_code: device.deviceCode, grant_type: DEVICE_GRANT })) || {};
      if (json.access_token) return credentialsFromToken(json, now());
      if (json.error === 'slow_down') interval = Number(json.interval) || interval + SLOW_DOWN_SECONDS;
      else if (json.error !== 'authorization_pending') throw deviceError(json.error, json.error_description);
    }
  }

  function needsReauthError() {
    const err = new Error('GitHub 로그인이 만료됐어요. 다시 로그인해 주세요.');
    err.needsReauth = true;
    return err;
  }

  // 토큰이 만료(8시간)됐으면 갱신 토큰으로 새 쌍을 받는다. device flow 토큰은 갱신에도 비밀키가 필요 없다.
  async function freshCredentials(credentials, { fetchImpl, now, clientId }) {
    const { refreshToken, expiresAt } = credentials;
    if (!refreshToken || (expiresAt && now < expiresAt - REFRESH_MARGIN_MS)) return null;
    if (!clientId) throw new Error('이 설치본에는 GitHub 앱 ID가 없어서 로그인을 이어 갈 수 없어요.');
    const json = (await postForm(fetchImpl, 'oauth/access_token', { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken })) || {};
    if (!json.access_token) throw needsReauthError();
    return { ...credentials, ...credentialsFromToken(json, now, refreshToken) };
  }

  async function fetchWithLogin(account, { fetchImpl, now, clientId }) {
    const refreshed = await freshCredentials(account.credentials, { fetchImpl, now, clientId });
    const accountPatch = refreshed ? { credentials: refreshed } : null;
    const { accessToken, org } = refreshed || account.credentials;
    try {
      return { entries: await readUsage(fetchImpl, accessToken, org, now), accountPatch };
    } catch (err) {
      const out = err.status === 401 ? needsReauthError() : explainError(err, org && org.trim());
      out.accountPatch = accountPatch; // 갱신된 토큰은 실패해도 저장해야 다음에 쓸 수 있다
      throw out;
    }
  }

  const api = { id: 'github', label: 'GitHub', validateCredentials, parseEntries, fetchEntries, requestDeviceCode, pollForToken };
  root.PaymentCloudGitHub = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
