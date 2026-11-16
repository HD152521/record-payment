/* 대시보드의 "클라우드 · 이번 달 사용료" 칸과 연결 대화상자.
   화면은 비밀값이 없는 cloudCosts·cloudMeta만 읽고, 쓰기는 전부 background에 메시지로 맡긴다. */
(() => {
  'use strict';

  const L = globalThis.PaymentLedger;
  const C = globalThis.PaymentCloudCosts;
  const CONFIG = globalThis.PaymentCloudConfig;
  const { el, formatTime, cloudOverview, toast, withFallbackFx } = globalThis.PaymentUI;
  const $ = (id) => document.getElementById(id);
  const PROVIDER_LABEL = { aws: 'AWS', azure: 'Azure', openai: 'OpenAI', cloudflare: 'Cloudflare', github: 'GitHub', vercel: 'Vercel' };
  const TOP_SERVICES = 3;
  const SUBMIT_LABEL = { azure: 'Microsoft로 로그인' };
  const G = globalThis.PaymentCloudGuides;
  const STEP_TITLES = { azure: ['로그인 안내', '로그인하기'] };
  const DEFAULT_STEP_TITLES = ['토큰 만들기', '붙여 넣기'];
  const COPY_TEXT = { awsPolicy: () => JSON.stringify(globalThis.PaymentCloudAWS.POLICY, null, 2) };
  const COPIED_MS = 1500;
  const K = globalThis.PaymentCatalog;
  const catalogItem = (provider) => K.ITEMS.find((i) => i.connect === provider);

  let state = { costs: {}, meta: withFallbackFx({}) };
  let replaceId = null;

  async function send(type, payload) {
    const res = await chrome.runtime.sendMessage({ type, payload });
    if (!res || !res.ok) throw new Error((res && res.error) || '요청을 처리하지 못했어요.');
    return res;
  }

  const krwText = (amount, currency) => {
    const krw = C.toKRW(amount, currency, state.meta.usdKrw);
    return currency !== 'KRW' && krw != null ? `≈ ${L.formatMoney(krw, 'KRW')}` : '';
  };

  const AWS_REFRESH_NOTE = 'AWS는 갱신 1번에 $0.01이 내 AWS 계정에 청구돼요. 자동 갱신은 하루 한 번만 해요.';

  function renderTotals(view) {
    const { total } = view;
    $('cloud-total').textContent = L.formatMoney(total.monthToDate, 'KRW');
    $('cloud-sub').textContent = view.accounts.length
      ? [`월말 예상 ${L.formatMoney(total.projected, 'KRW')}`, `지난달 ${L.formatMoney(total.lastMonth, 'KRW')}`,
        view.usdKrw && `환율 1달러 ${Math.round(view.usdKrw).toLocaleString('ko-KR')}원${state.meta.fxFallback ? '(참고)' : ''}`,
        view.hasUnconverted && '일부는 환율이 없어 빠짐'].filter(Boolean).join(' · ')
      : '';
    $('cloud-updated').textContent = view.lastRefreshAt ? `마지막 갱신 ${formatTime(view.lastRefreshAt)} · 매일 아침 ${CONFIG.REFRESH_HOUR}시` : '';
    // AWS는 조회가 유료라(내 AWS 계정에 청구) 직접 갱신할 때마다 든다는 걸 버튼 옆에 적어 둔다.
    const hasAws = view.accounts.some((a) => a.provider === 'aws');
    $('cloud-refresh-note').hidden = !hasAws;
    $('cloud-refresh').title = hasAws ? AWS_REFRESH_NOTE : '';
  }

  function figure(label, amount, currency) {
    return el('div', { class: 'figure' },
      el('dt', {}, label),
      el('dd', {}, L.formatMoney(amount, currency), el('small', {}, krwText(amount, currency))));
  }

  function accountCard(a) {
    const hasData = a.fetchedAt != null;
    const services = (a.services || []).slice(0, TOP_SERVICES).map((s) =>
      el('li', {},
        el('span', { class: 'what' }, s.name),
        el('span', { class: 'leader', 'aria-hidden': 'true' }),
        el('span', { class: 'amount' }, L.formatMoney(s.amount, a.currency))));
    const fixLabel = a.provider === 'azure' ? '다시 로그인' : '키 바꾸기';
    return el('li', { class: `cloud-card provider-${a.provider}${a.error ? ' has-error' : ''}` },
      el('header', {},
        el('span', { class: 'badge provider' }, PROVIDER_LABEL[a.provider] || a.provider),
        el('span', { class: 'cloud-label' }, a.label)),
      hasData && el('p', { class: 'cloud-mtd' }, L.formatMoney(a.monthToDate, a.currency),
        el('small', {}, krwText(a.monthToDate, a.currency))),
      hasData && el('dl', { class: 'figures' },
        figure('월말 예상', a.projected, a.currency),
        figure('지난달', a.lastMonth, a.currency)),
      services.length > 0 && el('ol', { class: 'receipt' }, services),
      (a.warnings || []).length > 0 && el('p', { class: 'warn' }, `확인 필요: ${a.warnings.join(' / ')}`),
      a.error && el('p', { class: 'error' }, a.error),
      el('footer', {},
        el('span', { class: 'muted' }, hasData ? `${formatTime(a.fetchedAt)} 기준` : '아직 못 가져왔어요'),
        el('span', { class: 'spacer' }),
        (a.error || a.needsReauth) && el('button', { type: 'button', class: 'link', onclick: () => openDialog(a.provider, a.id) }, fixLabel),
        el('button', { type: 'button', class: 'link', onclick: () => removeAccount(a) }, '연결 해제')));
  }

  function render() {
    const view = cloudOverview(state.costs, state.meta);
    renderTotals(view);
    $('cloud-accounts').replaceChildren(...view.accounts.map(accountCard));
    $('cloud-empty').hidden = view.accounts.length > 0;
  }

  async function removeAccount(a) {
    if (!confirm(`${a.label} 연결을 해제할까요? 저장된 키도 이 브라우저에서 지워져요.`)) return;
    await send('cloud:remove', { id: a.id }).catch(showError);
  }

  async function refreshNow() {
    const btn = $('cloud-refresh');
    btn.disabled = true;
    $('cloud-updated').textContent = '가져오는 중…';
    try {
      await send('cloud:refresh', { force: true });
    } catch (err) {
      showError(err);
    } finally {
      btn.disabled = false;
      render();
    }
  }

  // ── 연결 대화상자 ─────────────────────────────────────────
  const form = () => $('cloud-form');
  const selectedProvider = () => form().elements.provider.value;

  // ── 2단계: 안내서(데이터는 lib/cloud/guides.js) ──────────────
  async function copyText(text, btn) {
    await navigator.clipboard.writeText(text);
    btn.textContent = '복사됨';
    setTimeout(() => { btn.textContent = '복사'; }, COPIED_MS);
  }

  function codeCopy(text) {
    const btn = el('button', { type: 'button', class: 'btn ghost small', onclick: () => copyText(text, btn).catch(showError) }, '복사');
    return el('div', { class: 'code-copy' }, el('pre', {}, text), btn);
  }

  function guidePart(part) {
    if (typeof part === 'string') return part;
    if (part.b) return el('b', {}, part.b);
    if (part.code) return el('code', {}, part.code);
    if (part.href) return el('a', { href: part.href, target: '_blank', rel: 'noopener' }, part.a);
    if (part.file) return el('a', { href: chrome.runtime.getURL(part.file), download: part.file.split('/').pop() }, part.a);
    if (part.copy && COPY_TEXT[part.copy]) return codeCopy(COPY_TEXT[part.copy]());
    return null;
  }

  const guideOpts = () => ({ templateUrl: CONFIG.AWS_TEMPLATE_URL });

  function renderGuide(provider) {
    const guide = G.guideFor(provider, guideOpts());
    const [step2, step3] = STEP_TITLES[provider] || DEFAULT_STEP_TITLES;
    $('cloud-step2-title').textContent = step2;
    $('cloud-step3-title').textContent = step3;
    $('cloud-open-create').hidden = !guide.openLabel;
    $('cloud-open-create').textContent = `${guide.openLabel} ↗`;
    $('cloud-prefill-note').hidden = !guide.prefilled;
    $('cloud-guide').replaceChildren(...guide.steps.map((step) => el('li', {}, step.map(guidePart))));
    $('cloud-links').replaceChildren('바로가기 ', ...guide.links.flatMap((link, i) => [
      i > 0 ? ' · ' : '',
      el('a', { href: link.url, target: '_blank', rel: 'noopener' }, link.label),
    ]));
  }

  // ── 3단계: 토큰 자동 받기. 토큰은 background에만 있고 화면엔 가린 값만 온다 ──────
  const autofill = () => $('cloud-autofill');

  function hideAutofill() {
    autofill().hidden = true;
    autofill().replaceChildren();
  }

  function showAutofillWaiting() {
    autofill().replaceChildren(el('p', { class: 'hint' }, '새 탭에서 토큰을 만들면 여기로 자동으로 가져와요. 안 되면 아래 칸에 붙여 넣어 주세요.'));
    autofill().hidden = false;
  }

  function autofillExtra(provider, f) {
    if (provider === 'github') return { org: f.ghOrg.value };
    if (provider === 'cloudflare') return { accountId: f.cfAccountId.value };
    if (provider === 'vercel') return { team: f.vcTeam.value };
    return {};
  }

  async function confirmAutofill(provider, buttons) {
    buttons.forEach((b) => { b.disabled = true; });
    setStatus('받은 토큰으로 비용을 불러 보는 중…');
    try {
      const f = form().elements;
      await send('cloud:autofetch-confirm', { provider, label: f.label.value, extra: autofillExtra(provider, f), replaceId });
      $('cloud-dialog').close();
    } catch (err) {
      setStatus(`${err.message} 토큰을 아래에 붙여 넣어 다시 해 볼 수 있어요.`, true);
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  function declineAutofill() {
    hideAutofill();
    send('cloud:autofetch-cancel', {}).catch(showError);
    setStatus('받은 토큰은 지웠어요. 아래에 붙여 넣어 주세요.');
  }

  function showAutofillFound(provider, preview) {
    const yes = el('button', { type: 'button', class: 'btn', id: 'cloud-autofill-yes' }, '연결하기');
    const no = el('button', { type: 'button', class: 'btn ghost', id: 'cloud-autofill-no', onclick: declineAutofill }, '아니요, 붙여 넣을게요');
    yes.addEventListener('click', () => confirmAutofill(provider, [yes, no]));
    autofill().replaceChildren(
      el('p', { class: 'autofill-q' }, '이 토큰으로 연결할까요? ', el('code', {}, preview)),
      el('p', { class: 'hint' }, '연결하기를 누르기 전에는 저장하지 않아요.'),
      el('div', { class: 'autofill-actions' }, yes, no));
    autofill().hidden = false;
  }

  function onAutofetchFound(msg) {
    const isOpen = $('cloud-dialog').open && selectedProvider() === msg.provider;
    if (isOpen && typeof msg.preview === 'string') showAutofillFound(msg.provider, msg.preview);
  }

  // 사용자가 이미 로그인한 콘솔에서 토큰 만들기 화면을 새 탭으로 연다. background가 그 탭만 지켜본다.
  async function openCreatePage() {
    const provider = selectedProvider();
    const org = provider === 'github' ? form().elements.ghOrg.value : '';
    const url = G.createUrl(provider, { ...guideOpts(), org });
    if (!url) return;
    try {
      const tab = await chrome.tabs.create({ url });
      await send('cloud:autofetch-watch', { tabId: tab.id, provider });
      showAutofillWaiting();
    } catch (err) {
      showError(err);
    }
  }

  // ── GitHub 로그인(device flow). 코드를 보여 주고, 승인될 때까지 이 창에서 기다린다 ──
  let ghLogin = null; // 진행 중인 로그인의 AbortController

  function stopGithubLogin() {
    if (ghLogin) ghLogin.abort();
    ghLogin = null;
    $('gh-device').hidden = true;
    $('gh-device').replaceChildren();
  }

  function showDeviceCode(device) {
    $('gh-device').replaceChildren(
      el('p', {}, '이 코드를 GitHub에 넣고 승인해 주세요. ', el('code', { id: 'gh-user-code' }, device.userCode)),
      el('p', { class: 'hint' },
        el('a', { href: device.verificationUri, target: '_blank', rel: 'noopener' }, '코드 넣는 화면 열기 ↗'),
        ' · 승인하면 자동으로 연결돼요.'));
    $('gh-device').hidden = false;
  }

  async function startGithubLogin() {
    stopGithubLogin();
    const controller = new AbortController();
    ghLogin = controller;
    const Gh = globalThis.PaymentCloudGitHub;
    const clientId = CONFIG.GITHUB_CLIENT_ID;
    const targetId = replaceId;
    $('gh-login').disabled = true;
    setStatus('GitHub에서 코드를 받는 중…');
    try {
      const device = await Gh.requestDeviceCode({ clientId });
      showDeviceCode(device);
      setStatus('GitHub 승인을 기다리는 중…');
      const tokens = await Gh.pollForToken({ clientId, device, signal: controller.signal });
      if (controller.signal.aborted) return; // 기다리는 사이 창을 닫았으면 저장하지 않는다
      setStatus('로그인 확인됨. 비용을 불러오는 중…');
      const f = form().elements;
      const org = f.ghOrg.value.trim() || undefined;
      await send('cloud:add', { provider: 'github', label: f.label.value, credentials: { ...tokens, org }, replaceId: targetId });
      $('cloud-dialog').close();
    } catch (err) {
      if (err.name !== 'AbortError') setStatus(err.message, true);
    } finally {
      $('gh-login').disabled = false;
      if (ghLogin === controller) ghLogin = null;
    }
  }

  function showGithubLogin(provider) {
    stopGithubLogin();
    const hasApp = Boolean(CONFIG.GITHUB_CLIENT_ID);
    $('gh-login').hidden = provider !== 'github' || !hasApp;
    $('gh-login-missing').hidden = provider !== 'github' || hasApp;
  }

  function showPanel(provider) {
    renderGuide(provider);
    hideAutofill();
    showGithubLogin(provider);
    for (const panel of form().querySelectorAll('fieldset[data-panel]')) {
      const active = panel.dataset.panel === provider;
      panel.hidden = !active;
      panel.disabled = !active;
    }
    const azureMissing = provider === 'azure' && !CONFIG.AZURE_CLIENT_ID;
    $('azure-missing').hidden = !azureMissing;
    $('cloud-submit').disabled = azureMissing;
    $('cloud-submit').textContent = SUBMIT_LABEL[provider] || '연결 확인';
    const item = catalogItem(provider);
    $('cloud-manual-row').hidden = !(item && item.plans && item.plans.length);
    setStatus('');
  }

  function openDialog(provider = 'aws', id = null) {
    replaceId = id;
    form().reset();
    for (const radio of form().elements.provider) {
      radio.checked = radio.value === provider;
      radio.disabled = Boolean(id) && radio.value !== provider;
    }
    $('cloud-dialog-title').textContent = id ? `${PROVIDER_LABEL[provider]} 다시 연결` : '사용료 연결';
    showPanel(provider);
    $('cloud-dialog').showModal();
  }

  function setStatus(text, isError = false) {
    const status = $('cloud-status');
    status.textContent = text;
    status.classList.toggle('error', isError);
  }

  async function connectAzure(f, targetId) {
    const result = await globalThis.PaymentCloudAzure.authorize({
      clientId: CONFIG.AZURE_CLIENT_ID,
      tenant: f.tenant.value,
      redirectUri: chrome.identity.getRedirectURL('azure'),
      launch: (opts) => chrome.identity.launchWebAuthFlow(opts),
    });
    setStatus('로그인 확인됨. 비용을 불러오는 중…');
    return send('cloud:azure-code', { ...result, replaceId: targetId, label: f.label.value });
  }

  function credentialsFor(provider, f) {
    const v = (name) => f[name].value.trim();
    const optional = (value) => value || undefined;
    switch (provider) {
      case 'aws': return { accessKeyId: v('accessKeyId'), secretAccessKey: v('secretAccessKey') };
      case 'cloudflare': return { apiToken: v('cfToken'), accountId: optional(v('cfAccountId')) };
      case 'github': return { token: v('ghToken'), org: optional(v('ghOrg')) };
      case 'vercel': return { token: v('vcToken'), team: optional(v('vcTeam')) };
      default: return { adminKey: v('adminKey') };
    }
  }

  // API로 안 읽히는 사람(예: GitHub 옛 청구 방식)은 요금제 고르기로 넘어간다.
  function recordManually() {
    const item = catalogItem(selectedProvider());
    $('cloud-dialog').close();
    globalThis.PaymentDashboard.openEditor(null, { title: item.name, fields: K.recordFields(item, item.plans[0]), planIndex: 0 });
  }

  async function submitDialog(event) {
    event.preventDefault();
    if (!form().reportValidity()) return;
    const f = form().elements;
    const provider = selectedProvider();
    const submit = $('cloud-submit');
    const targetId = replaceId; // 로그인 창이 떠 있는 동안 다른 대화상자를 열어도 섞이지 않게 지금 값을 잡아 둔다
    submit.disabled = true;
    setStatus(provider === 'azure' ? '로그인 창을 여는 중…' : '키로 비용을 불러 보는 중…');
    try {
      if (provider === 'azure') {
        await connectAzure(f, targetId);
      } else {
        await send('cloud:add', { provider, label: f.label.value, credentials: credentialsFor(provider, f), replaceId: targetId });
      }
      $('cloud-dialog').close();
      form().reset(); // 붙여 넣은 키가 화면에 남지 않게
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      submit.disabled = selectedProvider() === 'azure' && !CONFIG.AZURE_CLIENT_ID;
    }
  }

  function showError(err) {
    console.error('[결제 기록장]', err);
    toast(err.message || '처리하지 못했어요. 다시 시도해 주세요.', { isError: true });
  }

  globalThis.PaymentCloudUI = { openDialog };

  $('cloud-open-create').addEventListener('click', openCreatePage);
  $('cloud-add').addEventListener('click', () => openDialog());
  $('cloud-refresh').addEventListener('click', refreshNow);
  $('cloud-cancel').addEventListener('click', () => $('cloud-dialog').close());
  $('cloud-manual').addEventListener('click', recordManually);
  $('gh-login').addEventListener('click', startGithubLogin);
  $('cloud-dialog').addEventListener('close', () => {
    form().reset();
    hideAutofill();
    stopGithubLogin();
    send('cloud:autofetch-cancel', {}).catch((err) => console.error('[결제 기록장]', err)); // 읽은 토큰·감시를 남기지 않는다
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'cloud:autofetch-found') onAutofetchFound(msg);
  });
  $('cloud-form').addEventListener('change', (e) => { if (e.target.name === 'provider') showPanel(e.target.value); });
  $('cloud-form').addEventListener('submit', submitDialog);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.cloudCosts) state = { ...state, costs: changes.cloudCosts.newValue || {} };
    if (changes.cloudMeta) state = { ...state, meta: withFallbackFx(changes.cloudMeta.newValue) };
    if (changes.cloudCosts || changes.cloudMeta) render();
  });

  chrome.storage.local.get(['cloudCosts', 'cloudMeta']).then((stored) => {
    state = { costs: stored.cloudCosts || {}, meta: withFallbackFx(stored.cloudMeta) };
    render();
    // 오래된 연결만 background가 다시 가져온다(무료 서비스는 6시간, AWS는 하루 기준).
    if (Object.keys(state.costs).length) send('cloud:refresh', {}).catch((err) => console.error('[결제 기록장]', err));
  }).catch(showError);
})();
