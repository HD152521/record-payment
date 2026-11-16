(() => {
  'use strict';

  const L = globalThis.PaymentLedger;
  const S = globalThis.PaymentStore;
  const K = globalThis.PaymentCatalog;
  const { el, formatTotals, amountText, kindBadge, formatDate, cloudOverview, toast, radioChip, checkedValue, checkRadio, withFallbackFx, FALLBACK_FX_AS_OF } = globalThis.PaymentUI;
  const Q = globalThis.PaymentQuickAdd;
  const $ = (id) => document.getElementById(id);
  const H = globalThis.PaymentHistory;
  const ST = globalThis.PaymentSettings;

  const NEW_CARD = '__new';

  let records = [];
  let cards = [];
  let cloud = { costs: {}, meta: withFallbackFx({}), history: {} };
  let settings = ST.DEFAULT_SETTINGS;
  let editingId = null;
  let filter = 'all';

  // 원화 합계 + 원화로 못 바꾼 금액. 환율이 없어 달러만 남으면 "0원 + $100.00"이 아니라 "$100.00"만.
  function joinMoney(krw, unconverted) {
    const rest = Object.keys(unconverted).length ? formatTotals(unconverted) : '';
    if (!rest) return L.formatMoney(krw, 'KRW');
    return krw ? `${L.formatMoney(krw, 'KRW')} + ${rest}` : rest;
  }

  // 달러 구독은 원화로 합친다. 환율이 없을 때만 통화별로 나눠 보여 준다.
  function moneyLine(byCurrency, usdKrw) {
    const { krw, unconverted } = L.krwTotal(byCurrency, usdKrw);
    return joinMoney(krw, unconverted);
  }

  // 사용료는 UTC 달로 묶인다. 매달 1일 0~9시(한국)처럼 로컬 달과 UTC 달이 다르면 이번 달 값이 아니니 합계에 넣지 않는다.
  const cloudView = () => {
    const view = cloudOverview(cloud.costs, cloud.meta);
    const now = Date.now();
    const aligned = H.monthKey(now) === globalThis.PaymentCloudCosts.billingWindow(now).thisKey;
    return aligned ? view : { ...view, total: { ...view.total, projected: 0, monthToDate: 0 } };
  };
  // 사용료 연결이 이미 포함한 서비스의 직접 기록은 합계에서 뺀다(같은 돈 두 번 방지).
  // 이번 달은 지금 연결 상태로, 지난 달들은 그 달 사용료 기록이 있었는지로 본다(연결을 끊어도 과거 달이 두 번 세지지 않게).
  const isCovered = (r, month) => (month && !month.isCurrent
    ? K.coveredBy(r, H.providersIn(cloud.history, month.key)) != null
    : K.coveredBy(r, cloudView().connected) != null);
  const summarize = () => L.summarize(records, Date.now(), { isCovered });

  const cloudParts = () => globalThis.PaymentForecast.cloudParts(
    cloudOverview(cloud.costs, cloud.meta), Date.now(), globalThis.PaymentCloudCosts.billingWindow(Date.now()).thisKey);

  function renderHeadline(s, usdKrw) {
    const cloudNow = cloudParts();
    const { paidKRW, dueKRW, unconverted } = globalThis.PaymentForecast.monthForecast(s, cloudNow, usdKrw);
    $('monthly-total').textContent = joinMoney(paidKRW + dueKRW, unconverted);
    renderDelta(paidKRW + dueKRW, usdKrw);
    renderBudget(paidKRW + dueKRW);
    renderSplit(paidKRW, dueKRW);
    $('cloud-line').textContent = cloudNow.projected
      ? `서버·API 지금 ${L.formatMoney(cloudNow.now, 'KRW')} → 월말 예상 ${L.formatMoney(cloudNow.projected, 'KRW')}` : '';
    $('yearly-total').textContent = Object.keys(s.monthly).length ? `정액 구독 월 평균 ${moneyLine(s.monthly, usdKrw)} · 1년이면 ${moneyLine(s.yearly, usdKrw)}` : '';
    const rateText = `1달러 ${Math.round(usdKrw).toLocaleString('ko-KR')}원`;
    const usdNote = s.thisMonth.USD
      ? `달러 결제 ${L.formatMoney(s.thisMonth.USD, 'USD')} 포함, ${cloud.meta.fxFallback ? `${rateText}(${FALLBACK_FX_AS_OF} 참고 환율 · 실시간 환율을 아직 못 받았어요)` : rateText}` : '';
    const missing = Object.keys(unconverted).length || cloudNow.hasUnconverted ? '원화로 못 바꾼 금액 제외' : '';
    $('all-total').textContent = [usdNote, missing].filter(Boolean).join(' · ');
  }

  // 나간 돈 / 나갈 돈 막대
  function renderSplit(paidKRW, dueKRW) {
    const total = paidKRW + dueKRW;
    $('paid-bar').hidden = total <= 0;
    $('paid-fill').style.width = total > 0 ? `${Math.round((paidKRW / total) * 100)}%` : '0%';
    $('paid-bar').setAttribute('aria-label', `나간 돈 ${L.formatMoney(paidKRW, 'KRW')}, 나갈 돈 ${L.formatMoney(dueKRW, 'KRW')}`);
    $('split-legend').replaceChildren(...(total > 0 ? [
      el('li', { class: 'is-paid' }, '나간 돈', el('b', {}, L.formatMoney(paidKRW, 'KRW'))),
      el('li', { class: 'is-due' }, '나갈 돈', el('b', {}, L.formatMoney(dueKRW, 'KRW'))),
    ] : []));
  }

  // 지난달 대비. 지난달 = 기록에서 다시 계산한 결제 + 그달 사용료 확정값.
  function lastMonthKRW(usdKrw) {
    const [last] = H.monthlyHistory(records, Date.now(), { months: 2, isCovered });
    const fromRecords = L.krwTotal(last.subscription, usdKrw).krw + L.krwTotal(last.one_time, usdKrw).krw;
    return fromRecords + H.cloudMonthKRW(cloud.history, last.key, usdKrw).krw;
  }

  function renderDelta(thisKRW, usdKrw) {
    const last = lastMonthKRW(usdKrw);
    const diff = thisKRW - last;
    const text = !last ? '' : diff === 0 ? '지난달과 같아요'
      : `지난달(${L.formatMoney(last, 'KRW')})보다 ${L.formatMoney(Math.abs(diff), 'KRW')} ${diff > 0 ? '많아요' : '적어요'}`;
    $('month-delta').textContent = text;
    $('month-delta').dataset.trend = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  }

  function renderBudget(spent) {
    const state = ST.budgetState(spent, settings.budgetKRW);
    $('budget-meter').hidden = !state;
    $('budget-edit').textContent = state ? '예산 바꾸기' : '예산 정하기';
    $('budget').dataset.level = state ? state.level : 'none';
    if (!state) {
      $('budget-text').textContent = '예산을 정해 두면 얼마나 남았는지, 넘었는지 알려 드려요.';
      return;
    }
    $('budget-fill').style.width = `${Math.min(100, Math.round(state.ratio * 100))}%`;
    const budget = L.formatMoney(settings.budgetKRW, 'KRW');
    const label = { ok: '여유 있어요', warn: '⚠ 거의 다 썼어요', over: '⛔ 예산을 넘었어요' }[state.level];
    $('budget-text').textContent = state.left >= 0
      ? `${label} · 예산 ${budget} 중 ${Math.round(state.ratio * 100)}% 사용, ${L.formatMoney(state.left, 'KRW')} 남음`
      : `${label} · 예산 ${budget}보다 ${L.formatMoney(-state.left, 'KRW')} 더 나가요`;
  }

  // 30일 안 목록이라 연도는 빼고 "12월 14일 (일)"처럼
  const shortDate = (ts) => new Date(ts).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', weekday: 'short' });

  const dday = (date) => `D-${L.daysUntil(date, Date.now())}`;

  function renderUpcoming(upcoming, soon) {
    $('soon-total').textContent = Object.keys(soon).length ? moneyLine(soon, cloud.meta.usdKrw) : '없어요';
    $('upcoming-list').replaceChildren(...upcoming.map(({ record, date, isTrialEnd }) =>
      el('li', { class: L.daysUntil(date, Date.now()) <= L.SOON_DAYS ? 'is-soon' : null },
        el('span', { class: 'when', title: shortDate(date) }, dday(date)),
        el('span', { class: 'what' }, record.site, el('small', {}, shortDate(date))),
        isTrialEnd && el('span', { class: 'badge trial' }, '체험 끝'),
        el('span', { class: 'leader', 'aria-hidden': 'true' }),
        el('span', { class: 'amount' }, L.formatMoney(record.amount, record.currency)))));
    $('upcoming-empty').hidden = upcoming.length > 0;
  }

  // 무료 체험은 감지한 날이 아니라 체험 끝나는 날이 첫 결제일이라, "맞아요"를 눌러도 날짜를 받으러 편집기를 연다.
  function confirmPending(r) {
    if (r.trial) {
      openEditor(r);
      $('editor-form').elements.startedAt.focus();
      return;
    }
    S.upsertRecord(L.markConfirmed(r)).catch(showError);
  }

  function renderPending(pending) {
    $('pending').hidden = pending.length === 0;
    $('pending-count').textContent = String(pending.length);
    $('pending-list').replaceChildren(...pending.map((r) => el('li', {},
      el('span', { class: 'what' }, r.site),
      el('span', { class: 'amount' }, amountText(r)),
      el('span', { class: 'acts' },
        el('button', { type: 'button', class: 'link', onclick: () => confirmPending(r) }, r.trial ? '맞아요 · 체험 끝나는 날 넣기' : '맞아요'),
        el('button', { type: 'button', class: 'link', onclick: () => openEditor(r) }, '고치기'),
        el('button', { type: 'button', class: 'link', onclick: () => removeRecord(r).catch(showError) }, '아니에요')))));
  }

  function renderSummary() {
    const s = summarize();
    renderHeadline(s, cloud.meta.usdKrw);
    const stats = [
      ['사용 중인 구독', `${s.activeSubscriptions}개`],
      ['이번 달 일회성 결제', formatTotals(s.oneTimeThisMonth)],
      ['해지로 올해 아낀 돈', formatTotals(s.savedThisYear)],
      ['결제수단 등록만 한 곳', `${s.cardRegistrations}곳`],
    ];
    $('stats').replaceChildren(...stats.map(([k, v]) => el('div', { class: 'stat' }, el('dt', {}, k), el('dd', {}, v))));
    renderUpcoming(s.upcoming, s.soon);
    renderPending(s.pending);
  }

  function cardText(r) {
    const card = r.card ? `${r.card.brand} ····${r.card.last4}` : null;
    return [card, r.pg].filter(Boolean).join(' · ') || '—';
  }

  // www. 를 뺀 사이트 이름 첫 글자. 표에서 줄을 눈으로 빨리 찾게 하는 표시일 뿐이다.
  const siteInitial = (site) => (String(site || '?').replace(/^www\./, '').match(/[\p{L}\p{N}]/u) || ['?'])[0];

  function renderRow(r) {
    const isPending = !L.isConfirmed(r);
    const covered = !isPending && isCovered(r);
    const flags = [
      isPending && el('span', { class: 'badge pending' }, '확인 대기'),
      covered && el('span', { class: 'badge covered', title: '사용료 연결 값에 이미 들어 있어 합계에서 뺐어요' }, '연결 값에 포함'),
      r.trial && el('span', { class: 'badge trial' }, '무료 체험'),
      r.status === 'canceled' && el('span', { class: 'badge canceled' }, '해지함'),
    ];
    const classes = [r.status === 'canceled' && 'is-canceled', (isPending || covered) && 'is-excluded'].filter(Boolean).join(' ');
    return el('tr', { class: classes || null },
      el('td', { class: 'site' },
        el('div', { class: 'site-cell' },
          el('span', { class: `avatar kind-${r.kind}`, 'aria-hidden': 'true' }, siteInitial(r.site)),
          el('span', { class: 'site-name' }, r.site, r.note && el('small', {}, r.note)))),
      el('td', { class: 'kind' }, kindBadge(r), ...flags),
      el('td', { class: 'num' }, amountText(r)),
      el('td', { class: 'muted card' }, cardText(r)),
      el('td', { class: 'muted date' }, formatDate(r.startedAt)),
      el('td', { class: 'edit' }, el('button', { type: 'button', class: 'link', 'aria-label': `${r.site} 수정`, onclick: () => openEditor(r) }, '수정')));
  }

  function matchesSearch(r, q) {
    return !q || [r.site, r.note, r.pg, r.card && r.card.last4].some((v) => v && String(v).toLowerCase().includes(q));
  }

  function renderRows() {
    for (const btn of $('filters').querySelectorAll('button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.filter === filter));
    }
    const q = $('record-search').value.trim().toLowerCase();
    const visible = records
      .filter((r) => (filter === 'all' || r.kind === filter) && matchesSearch(r, q))
      .sort((a, b) => b.createdAt - a.createdAt);
    $('rows').replaceChildren(...visible.map(renderRow));
    $('empty').hidden = visible.length > 0;
    $('ledger-count').textContent = String(visible.length);
  }

  function render() {
    renderSummary();
    renderRows();
    document.dispatchEvent(new Event('records-rendered'));
  }

  const toDateInput = (ts) => {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  const knownCards = () => L.cardSummary(records, cards);
  const form = () => $('editor-form');

  // 결제 카드 칩: 등록한 카드 + 기록에서 본 카드 + "새 카드". 새 기록이면 자주 쓰는 카드를 먼저 골라 둔다.
  // 카드 없는 기존 기록에는 저절로 붙이지 않는다.
  function fillCardChips(current, isNew) {
    const list = knownCards();
    const extra = current && !list.some((c) => c.last4 === current.last4)
      ? [{ last4: current.last4, label: `${current.brand || '카드'} ····${current.last4}` }] : [];
    const chips = [
      radioChip('cardKey', '', '선택 안 함'),
      ...[...list, ...extra].map((c) => radioChip('cardKey', c.last4, c.label.includes(c.last4) ? c.label : `${c.label} ····${c.last4}`)),
      radioChip('cardKey', NEW_CARD, '＋ 새 카드'),
    ];
    $('card-chips').replaceChildren(...chips);
    const preferred = isNew ? Q.preferredCard(records, cards) : null;
    checkRadio(form(), 'cardKey', current ? current.last4 : (preferred || ''));
    syncLast4Row();
  }

  function syncLast4Row() {
    const f = form().elements;
    const isNew = checkedValue(form(), 'cardKey') === NEW_CARD;
    $('last4-row').hidden = !isNew;
    f.last4.required = isNew;
    if (!isNew) f.last4.value = '';
  }

  const planLabel = (p) => `${p.name} · ${L.formatMoney(p.amount, p.currency)}/${L.CYCLE_LABEL[p.cycle]}`;
  const currentItem = () => K.findBySite(form().elements.site.value.trim());

  // 사이트가 목록에 있는 곳이면 요금제를 칩으로 골라 금액·주기를 채운다.
  function fillPlanChips(planIndex = null) {
    const item = currentItem();
    const plans = (item && item.plans) || [];
    $('plan-row').hidden = plans.length === 0;
    $('plan-chips').replaceChildren(...plans.map((p, i) => radioChip('plan', String(i), planLabel(p))), radioChip('plan', '', '직접 입력'));
    checkRadio(form(), 'plan', planIndex != null && plans[planIndex] ? String(planIndex) : '');
    $('plan-hint').textContent = plans.length ? `${K.PRICES_AS_OF} 기준 참고 가격이에요. 실제 결제액과 다르면 금액을 고쳐 주세요.` : '';
    $('editor-avatar').textContent = siteInitial(form().elements.site.value);
  }

  function applyPlan() {
    const f = form().elements;
    const item = currentItem();
    const chosen = checkedValue(form(), 'plan');
    const plan = item && item.plans && chosen ? item.plans[Number(chosen)] : null;
    if (!plan) return;
    const planNames = item.plans.map((p) => p.name);
    checkRadio(form(), 'kind', 'subscription');
    checkRadio(form(), 'cycle', plan.cycle);
    checkRadio(form(), 'currency', plan.currency);
    f.amount.value = plan.amount;
    if (!f.note.value.trim() || planNames.includes(f.note.value.trim())) f.note.value = plan.name;
    syncCycleRow();
  }

  // 결제일 칩: 누르면 날짜 칸이 채워진다. 날짜 칸을 직접 바꾸면 맞는 칩만 켜진다.
  function fillDateChips() {
    $('date-chips').replaceChildren(...Q.dateChoices(Date.now()).map((c) => radioChip('dateChip', toDateInput(c.ts), c.label)));
    syncDateChips();
  }
  const syncDateChips = () => checkRadio(form(), 'dateChip', form().elements.startedAt.value);
  // 구독이 아니면 주기를 고를 일이 없다.
  const syncCycleRow = () => { $('cycle-row').hidden = checkedValue(form(), 'kind') !== 'subscription'; };

  function openEditor(record, prefill = null) {
    const r = record || L.createRecord({ kind: 'subscription', cycle: 'monthly', currency: 'KRW', ...(prefill && prefill.fields) });
    editingId = record ? record.id : null;
    const f = form().elements;
    form().reset();
    f.site.value = r.site;
    checkRadio(form(), 'kind', r.kind);
    checkRadio(form(), 'cycle', r.cycle || '');
    checkRadio(form(), 'currency', r.currency || 'KRW');
    checkRadio(form(), 'status', r.status);
    f.amount.value = r.amount ?? '';
    f.pg.value = r.pg || '';
    f.startedAt.value = toDateInput(r.startedAt);
    f.trial.checked = Boolean(r.trial);
    f.note.value = r.note || '';
    fillCardChips(r.card, !record);
    fillPlanChips(prefill ? prefill.planIndex : null);
    fillDateChips();
    syncCycleRow();
    $('editor-title').textContent = record ? '기록 수정' : `${(prefill && prefill.title) || '직접'} 추가`;
    $('delete-btn').hidden = !record;
    $('editor-evidence').textContent = r.evidence && r.evidence.length ? `감지 근거: ${r.evidence.join(' → ')}` : '';
    $('editor-more').open = Boolean(r.pg || r.status === 'canceled' || (r.evidence && r.evidence.length));
    $('editor').showModal();
  }

  function cardFromForm() {
    const f = form().elements;
    const key = checkedValue(form(), 'cardKey');
    if (key === NEW_CARD) {
      const last4 = f.last4.value.trim();
      return /^\d{4}$/.test(last4) ? { brand: '카드', last4 } : null;
    }
    if (!key) return null;
    const known = knownCards().find((c) => c.last4 === key);
    const base = records.find((r) => r.id === editingId);
    const brand = (known && known.brand) || (base && base.card && base.card.brand) || '카드';
    return { brand, last4: key };
  }

  function recordFromForm(base) {
    const f = form().elements;
    const amount = f.amount.value === '' ? null : Number(f.amount.value);
    const kind = checkedValue(form(), 'kind') || 'unknown';
    const status = checkedValue(form(), 'status') || 'active';
    return {
      ...base,
      site: f.site.value.trim(),
      kind,
      cycle: kind === 'subscription' ? checkedValue(form(), 'cycle') || null : null,
      amount: Number.isFinite(amount) ? amount : null,
      currency: checkedValue(form(), 'currency') || 'KRW',
      card: cardFromForm(),
      pg: f.pg.value.trim() || null,
      startedAt: new Date(`${f.startedAt.value}T00:00:00`).getTime(),
      status,
      canceledAt: status === 'canceled' ? (base.status === 'canceled' && base.canceledAt) || Date.now() : null,
      trial: f.trial.checked,
      note: f.note.value.trim(),
      review: 'confirmed',
      userEdited: true,
      updatedAt: Date.now(),
    };
  }

  async function saveEditor(event) {
    event.preventDefault();
    if (!form().reportValidity()) return;
    const existing = records.find((r) => r.id === editingId);
    const record = recordFromForm(existing || L.createRecord({}));
    const isNewCard = checkedValue(form(), 'cardKey') === NEW_CARD && record.card
      && !knownCards().some((c) => c.last4 === record.card.last4);
    await S.upsertRecord(record);
    editingId = record.id; // 아래 카드 저장이 실패해 다시 눌러도 기록이 두 번 생기지 않게
    $('editor').close();
    toast(existing ? '저장했어요.' : `${record.site} 기록을 추가했어요.`);
    // 새로 입력한 카드는 다음부터 고르기만 하면 되게 "내 카드"에도 넣는다. 실패해도 기록은 이미 저장됐다.
    if (isNewCard) await S.saveCard({ last4: record.card.last4 }).catch((err) => console.error('[결제 기록장] 카드 저장', err));
  }

  // 삭제는 묻지 않고 바로 하고, 토스트의 "되돌리기"로 살린다.
  async function removeRecord(record) {
    await S.deleteRecord(record.id);
    toast(`${record.site} 기록을 지웠어요.`, {
      actionLabel: '되돌리기',
      onAction: () => S.upsertRecord(record).catch(showError),
    });
  }

  async function deleteEditing() {
    const record = records.find((r) => r.id === editingId);
    if (!record) return;
    $('editor').close();
    await removeRecord(record);
  }

  function exportCsv() {
    const blob = new Blob(['﻿', L.toCsv(records)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `결제기록_${toDateInput(Date.now())}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  $('filters').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-filter]');
    if (!btn) return;
    filter = btn.dataset.filter;
    renderRows();
  });
  $('record-search').addEventListener('input', renderRows);
  $('editor-form').addEventListener('change', (e) => {
    const { name, value } = e.target;
    if (name === 'cardKey') syncLast4Row();
    else if (name === 'plan') applyPlan();
    else if (name === 'site') fillPlanChips();
    else if (name === 'kind') syncCycleRow();
    else if (name === 'dateChip') form().elements.startedAt.value = value;
    else if (name === 'startedAt') syncDateChips();
  });
  $('csv-btn').addEventListener('click', exportCsv);
  $('editor-form').addEventListener('submit', (e) => saveEditor(e).catch(showError));
  $('delete-btn').addEventListener('click', () => deleteEditing().catch(showError));
  $('cancel-btn').addEventListener('click', () => $('editor').close());

  function showError(err) {
    console.error('[결제 기록장]', err);
    toast('저장하지 못했어요. 다시 시도해 주세요.', { isError: true });
  }

  S.onRecordsChanged((next) => {
    records = next;
    render();
  });
  S.onCardsChanged((next) => { cards = next; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[ST.KEY]) settings = ST.normalizeSettings(changes[ST.KEY].newValue);
    if (!(changes.cloudCosts || changes.cloudMeta || changes.cloudHistory || changes[ST.KEY])) return;
    cloud = {
      costs: changes.cloudCosts ? changes.cloudCosts.newValue || {} : cloud.costs,
      meta: changes.cloudMeta ? withFallbackFx(changes.cloudMeta.newValue) : cloud.meta,
      history: changes.cloudHistory ? changes.cloudHistory.newValue || {} : cloud.history,
    };
    render();
  });
  chrome.storage.local.get(['cloudCosts', 'cloudMeta', 'cloudHistory', ST.KEY]).then((stored) => {
    cloud = { costs: stored.cloudCosts || {}, meta: withFallbackFx(stored.cloudMeta), history: stored.cloudHistory || {} };
    settings = ST.normalizeSettings(stored[ST.KEY]);
    render();
  }).catch(showError);
  // 환율은 12시간마다 한 번만 새로 받는다(이미 있으면 background가 건너뜀).
  chrome.runtime.sendMessage({ type: 'cloud:fx', payload: {} }).catch((err) => console.error('[결제 기록장]', err));
  Promise.all([S.loadRecords(), S.loadCards()]).then(([loadedRecords, loadedCards]) => {
    records = loadedRecords;
    cards = loadedCards;
    render();
  }).catch(showError);

  globalThis.PaymentDashboard = {
    openEditor,
    getRecords: () => records,
    getCloud: () => cloud,
    getSettings: () => settings,
    isCovered,
    cloudView,
    exportCsv,
  };
})();
