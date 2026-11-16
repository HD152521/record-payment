/* background 전용. 연결 계정 관리, 매일 아침 갱신, 환율.
   - cloudAccounts: 비밀값이 들어 있는 원본. background만 읽는다.
   - cloudCosts:    화면에 보여줄 결과(비밀값 없음). 대시보드·팝업은 이것만 읽는다.
   - cloudMeta:     마지막 갱신 시각, 환율. */
(function (root) {
  'use strict';

  const C = root.PaymentCloudCosts;
  const CONFIG = root.PaymentCloudConfig;
  const Azure = root.PaymentCloudAzure;
  const PROVIDERS = {
    aws: root.PaymentCloudAWS,
    azure: Azure,
    openai: root.PaymentCloudOpenAI,
    cloudflare: root.PaymentCloudCloudflare,
    github: root.PaymentCloudGitHub,
    vercel: root.PaymentCloudVercel,
  };

  const KEYS = { accounts: 'cloudAccounts', costs: 'cloudCosts', meta: 'cloudMeta', history: 'cloudHistory' };
  const H = root.PaymentHistory;
  const ALARM = 'cloud-refresh';
  const DAY_MINUTES = 24 * 60;
  const FX_URL = 'https://open.er-api.com/v6/latest/USD';
  const FX_STALE_MS = 12 * 60 * 60 * 1000;
  const FX_RETRY_MS = 10 * 60 * 1000;
  const FX_MIN = 100; // 원/달러가 이 범위를 벗어나면 응답이 잘못된 것으로 보고 이전 값을 쓴다
  const FX_MAX = 10000;
  const MAX_LABEL = 60;
  const ORIGIN_RULE_ID = 1;
  // 아침 알람과 브라우저 시작이 겹쳐도 같은 서비스를 두 번 부르지 않도록. AWS는 costs.js에서 하루 한 번으로 따로 묶는다.
  const ALARM_MIN_AGE_MS = 60 * 60 * 1000;
  const MS_LOGIN_DOMAIN = 'login.microsoftonline.com';

  // 클라우드 작업끼리만 한 줄로 세운다. 결제 기록 큐와는 따로라 느린 조회가 기록 저장을 막지 않는다.
  let queue = Promise.resolve();
  function serialize(task) {
    const run = queue.then(task);
    queue = run.catch((err) => console.error('[결제 기록장] 클라우드', err));
    return run;
  }

  async function read(key, fallback) {
    const stored = await chrome.storage.local.get(key);
    return stored[key] ?? fallback;
  }
  const write = (key, value) => chrome.storage.local.set({ [key]: value });

  // 화면용 사용료를 저장하면서 달별 기록(cloudHistory)에도 쌓는다. 연결을 끊어도 지난 달 값은 남긴다.
  async function writeCosts(costs, now) {
    const history = H.mergeCloudHistory(await read(KEYS.history, {}), costs, C.billingWindow(now));
    await chrome.storage.local.set({ [KEYS.costs]: costs, [KEYS.history]: history });
  }

  // Microsoft 토큰 엔드포인트는 "모바일·데스크톱" 앱 요청에 Origin 헤더가 붙어 있으면 거절한다.
  // 탭이 아닌 요청(tabIds: -1 = 이 확장의 background)에서만 Origin을 지운다. 사용자가 브라우저로 여는
  // Azure 포털 등의 로그인 요청은 건드리지 않는다.
  function originRuleCondition(domain) {
    return {
      requestDomains: [domain],
      urlFilter: '/oauth2/v2.0/token',
      requestMethods: ['post'],
      resourceTypes: ['xmlhttprequest'],
      tabIds: [chrome.tabs.TAB_ID_NONE],
      initiatorDomains: [chrome.runtime.id],
    };
  }

  async function ensureOriginRule() {
    // Azure를 다시 켤 때 manifest에 declarativeNetRequestWithHostAccess·identity 권한도 되돌려 넣는다.
    if (!chrome.declarativeNetRequest) throw new Error('이 버전에서는 Azure 연결을 쉬고 있어요');
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ORIGIN_RULE_ID],
      addRules: [{
        id: ORIGIN_RULE_ID,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
        // regexFilter는 확장 자신의 요청에서 매칭되지 않아(E2E로 확인) 도메인 + 경로 조건으로 건다.
        condition: originRuleCondition(MS_LOGIN_DOMAIN),
      }],
    });
  }

  function publicEntry(account, result) {
    return { provider: account.provider, label: account.label, createdAt: account.createdAt, ...result };
  }

  async function fetchSnapshot(account, now) {
    const provider = PROVIDERS[account.provider];
    if (account.provider === 'azure') await ensureOriginRule();
    const { entries, warnings = [], accountPatch = null, projection } = await provider.fetchEntries(account, { now, clientId: CONFIG.AZURE_CLIENT_ID, githubClientId: CONFIG.GITHUB_CLIENT_ID });
    return { snapshot: { ...C.buildSnapshot(entries, now, { projection }), warnings, fetchedAt: now, error: null }, accountPatch };
  }

  async function refreshOne(account, previous, now) {
    try {
      const { snapshot, accountPatch } = await fetchSnapshot(account, now);
      return { entry: publicEntry(account, snapshot), accountPatch };
    } catch (err) {
      // 실패해도 지난번 숫자는 남겨 두고, 오류만 덧붙인다.
      const kept = previous && previous.fetchedAt ? previous : {};
      return {
        entry: publicEntry(account, { ...kept, error: C.redactValues(err.message, account.credentials), needsReauth: Boolean(err.needsReauth), failedAt: now }),
        accountPatch: err.accountPatch || null,
      };
    }
  }

  async function updateFx(meta, now) {
    if (meta.usdKrw && now - (meta.fxAt || 0) < FX_STALE_MS) return meta;
    if (now - (meta.fxTriedAt || 0) < FX_RETRY_MS) return meta; // 실패한 직후엔 대시보드를 열 때마다 다시 묻지 않는다
    try {
      const json = await C.requestJson(fetch, FX_URL, {}, '환율');
      const rate = json && json.rates && Number(json.rates.KRW);
      const isSane = Number.isFinite(rate) && rate >= FX_MIN && rate <= FX_MAX;
      return isSane ? { ...meta, usdKrw: rate, fxAt: now, fxTriedAt: now } : { ...meta, fxTriedAt: now };
    } catch (err) {
      console.error('[결제 기록장] 환율', err);
      return { ...meta, fxTriedAt: now }; // 환율이 없으면 원화 합계만 못 낼 뿐, 달러 금액은 그대로 보여준다.
    }
  }

  async function refreshAll({ force = false, onlyId = null, maxAgeMs = CONFIG.STALE_AFTER_MS } = {}) {
    const now = Date.now();
    const meta = await read(KEYS.meta, {});
    const accounts = await read(KEYS.accounts, []);
    if (!accounts.length) return { ok: true, skipped: true };
    const costs = await read(KEYS.costs, {});
    // 자동 갱신은 오래된 계정만. 화면을 자주 열어도 유료 조회(AWS)가 늘지 않는다.
    const targets = force || onlyId ? accounts.filter((a) => !onlyId || a.id === onlyId) : C.dueAccounts(accounts, costs, now, maxAgeMs);
    if (!targets.length) return { ok: true, skipped: true };
    const results = await Promise.all(targets.map((a) => refreshOne(a, costs[a.id], now)));

    const patches = new Map(targets.map((a, i) => [a.id, results[i].accountPatch]).filter(([, p]) => p));
    if (patches.size) await write(KEYS.accounts, accounts.map((a) => (patches.has(a.id) ? { ...a, ...patches.get(a.id) } : a)));
    const nextCosts = { ...costs, ...Object.fromEntries(targets.map((a, i) => [a.id, results[i].entry])) };
    await writeCosts(nextCosts, now);
    await write(KEYS.meta, { ...(await updateFx(meta, now)), lastRefreshAt: onlyId ? meta.lastRefreshAt : now });
    return { ok: true };
  }

  // 클라우드 계정이 없어도 달러 구독을 원화로 합치려면 환율은 필요하다.
  async function ensureFx() {
    const meta = await read(KEYS.meta, {});
    const next = await updateFx(meta, Date.now());
    if (next !== meta) await write(KEYS.meta, next);
    return { ok: true };
  }

  function newId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function cleanLabel(label, fallback) {
    const s = typeof label === 'string' ? label.trim().slice(0, MAX_LABEL) : '';
    return s || fallback;
  }

  // 저장하기 전에 실제로 한 번 불러 본다. 틀린 키는 저장하지 않고 바로 이유를 알려준다.
  async function addAccount({ provider, label, credentials, replaceId = null }) {
    const impl = PROVIDERS[provider];
    if (!impl) throw new Error('지원하지 않는 서비스예요.');
    if (impl.validateCredentials) impl.validateCredentials(credentials);
    const accounts = await read(KEYS.accounts, []);
    const existing = replaceId && accounts.find((a) => a.id === replaceId);
    const account = {
      id: existing ? existing.id : newId(),
      provider,
      label: cleanLabel(label, existing ? existing.label : impl.label),
      credentials,
      createdAt: existing ? existing.createdAt : Date.now(),
    };
    const now = Date.now();
    let fetched;
    try {
      fetched = await fetchSnapshot(account, now);
    } catch (err) {
      throw new Error(C.redactValues(err.message, credentials));
    }
    const { snapshot, accountPatch } = fetched;
    const saved = { ...account, ...(accountPatch || {}) };
    await write(KEYS.accounts, existing ? accounts.map((a) => (a.id === saved.id ? saved : a)) : [...accounts, saved]);
    await writeCosts({ ...await read(KEYS.costs, {}), [saved.id]: publicEntry(saved, snapshot) }, now);
    const meta = await read(KEYS.meta, {});
    await write(KEYS.meta, await updateFx(meta, now));
    return { ok: true, id: saved.id };
  }

  async function connectAzure({ authority, code, verifier, redirectUri, replaceId, label }) {
    await ensureOriginRule();
    const result = await Azure.exchangeCode({ clientId: CONFIG.AZURE_CLIENT_ID, authority, code, verifier, redirectUri });
    // 사용자가 적은 이름 > (다시 로그인이면) 기존 이름 > 로그인한 계정 이름
    const chosen = cleanLabel(label, '') || (replaceId ? '' : result.label);
    return addAccount({ provider: 'azure', label: chosen, credentials: result.credentials, replaceId });
  }

  async function removeAccount(id) {
    await write(KEYS.accounts, (await read(KEYS.accounts, [])).filter((a) => a.id !== id));
    const { [id]: removed, ...rest } = await read(KEYS.costs, {});
    await write(KEYS.costs, rest);
    return { ok: true };
  }

  function handleMessage(msg) {
    const p = msg.payload || {};
    switch (msg.type) {
      case 'cloud:add': return serialize(() => addAccount(p));
      case 'cloud:azure-code': return serialize(() => connectAzure(p));
      case 'cloud:remove': return serialize(() => removeAccount(String(p.id)));
      case 'cloud:fx': return serialize(() => ensureFx());
      // 모든 데이터 지우기: 진행 중인 조회가 끝난 뒤 지워야 조회 결과가 되살아나지 않는다
      case 'cloud:wipe': return serialize(() => chrome.storage.local.clear().then(() => ({ ok: true })));
      case 'cloud:refresh': return serialize(() => refreshAll({ force: p.force === true, onlyId: p.id || null }));
      default: return Promise.reject(new Error(`알 수 없는 요청: ${msg.type}`));
    }
  }

  function nextMorning(now = new Date()) {
    const next = new Date(now);
    next.setHours(CONFIG.REFRESH_HOUR, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  async function ensureAlarm() {
    if (!(await chrome.alarms.get(ALARM))) chrome.alarms.create(ALARM, { when: nextMorning(), periodInMinutes: DAY_MINUTES });
  }

  function install() {
    // 기본값이면 모든 사이트에 들어가는 content script도 storage를 읽을 수 있다. 키가 든 저장소라 막아 둔다.
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
      .catch((err) => console.error('[결제 기록장] storage 접근 제한', err));
    chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); });
    // 아침에 컴퓨터가 꺼져 있었으면 브라우저를 켤 때 오래된 값만 다시 가져온다.
    chrome.runtime.onStartup.addListener(() => {
      ensureAlarm();
      serialize(() => refreshAll());
    });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === ALARM) serialize(() => refreshAll({ maxAgeMs: ALARM_MIN_AGE_MS }));
    });
  }

  root.PaymentCloudService = { KEYS, install, handleMessage, nextMorning, originRuleCondition };
})(globalThis);
