/* 대시보드의 "클라우드 · 이번 달 사용료" 칸과 연결 대화상자.
   화면은 비밀값이 없는 cloudCosts·cloudMeta만 읽고, 쓰기는 전부 background에 메시지로 맡긴다. */
(() => {
  'use strict';

  const L = globalThis.PaymentLedger;
  const C = globalThis.PaymentCloudCosts;
  const CONFIG = globalThis.PaymentCloudConfig;
  const { el, formatTime, cloudOverview } = globalThis.PaymentUI;
  const $ = (id) => document.getElementById(id);
  const PROVIDER_LABEL = { aws: 'AWS', azure: 'Azure', openai: 'OpenAI', cloudflare: 'Cloudflare', github: 'GitHub', vercel: 'Vercel' };
  const TOP_SERVICES = 3;
  const SUBMIT_LABEL = { azure: 'Microsoft로 로그인' };
  const K = globalThis.PaymentCatalog;
  const catalogItem = (provider) => K.ITEMS.find((i) => i.connect === provider);

  let state = { costs: {}, meta: {} };
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

  function renderTotals(view) {
    const { total } = view;
    $('cloud-total').textContent = L.formatMoney(total.monthToDate, 'KRW');
    $('cloud-sub').textContent = view.accounts.length
      ? [`월말 예상 ${L.formatMoney(total.projected, 'KRW')}`, `지난달 ${L.formatMoney(total.lastMonth, 'KRW')}`,
        view.usdKrw && `환율 1달러 ${Math.round(view.usdKrw).toLocaleString('ko-KR')}원`,
        view.hasUnconverted && '일부는 환율이 없어 빠짐'].filter(Boolean).join(' · ')
      : '';
    $('cloud-updated').textContent = view.lastRefreshAt ? `마지막 갱신 ${formatTime(view.lastRefreshAt)} · 매일 아침 ${CONFIG.REFRESH_HOUR}시` : '';
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

  function showPanel(provider) {
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

  async function copyPolicy() {
    await navigator.clipboard.writeText($('aws-policy').textContent);
    $('aws-policy-copy').textContent = '복사됨';
    setTimeout(() => { $('aws-policy-copy').textContent = '복사'; }, 1500);
  }

  function showError(err) {
    console.error('[결제 기록장]', err);
    alert(err.message || '처리하지 못했어요. 다시 시도해 주세요.');
  }

  globalThis.PaymentCloudUI = { openDialog };

  $('aws-policy').textContent = JSON.stringify(globalThis.PaymentCloudAWS.POLICY, null, 2);
  $('aws-policy-copy').addEventListener('click', () => copyPolicy().catch(showError));
  $('cloud-add').addEventListener('click', () => openDialog());
  $('cloud-refresh').addEventListener('click', refreshNow);
  $('cloud-cancel').addEventListener('click', () => $('cloud-dialog').close());
  $('cloud-manual').addEventListener('click', recordManually);
  $('cloud-dialog').addEventListener('close', () => form().reset());
  $('cloud-form').addEventListener('change', (e) => { if (e.target.name === 'provider') showPanel(e.target.value); });
  $('cloud-form').addEventListener('submit', submitDialog);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.cloudCosts) state = { ...state, costs: changes.cloudCosts.newValue || {} };
    if (changes.cloudMeta) state = { ...state, meta: changes.cloudMeta.newValue || {} };
    if (changes.cloudCosts || changes.cloudMeta) render();
  });

  chrome.storage.local.get(['cloudCosts', 'cloudMeta']).then((stored) => {
    state = { costs: stored.cloudCosts || {}, meta: stored.cloudMeta || {} };
    render();
    // 오래된 값이면 background가 알아서 다시 가져온다(6시간 이내면 건너뜀).
    if (Object.keys(state.costs).length) send('cloud:refresh', {}).catch((err) => console.error('[결제 기록장]', err));
  }).catch(showError);
})();
