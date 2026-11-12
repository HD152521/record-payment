(() => {
  'use strict';

  const L = globalThis.PaymentLedger;
  const S = globalThis.PaymentStore;
  const K = globalThis.PaymentCatalog;
  const { el, formatTotals, amountText, kindBadge, formatDate, cloudOverview } = globalThis.PaymentUI;
  const $ = (id) => document.getElementById(id);
  const FILTERS = new Set(['all', 'subscription', 'one_time', 'card_registered', 'unknown']);

  const NEW_CARD = '__new';

  let records = [];
  let cards = [];
  let cloud = { costs: {}, meta: {} };
  let editingId = null;

  const currentFilter = () => {
    const f = location.hash.slice(1);
    return FILTERS.has(f) ? f : 'all';
  };

  // 달러 구독은 원화로 합친다. 환율이 없을 때만 통화별로 나눠 보여 준다.
  function moneyLine(byCurrency, usdKrw) {
    const { krw, unconverted } = L.krwTotal(byCurrency, usdKrw);
    const rest = Object.keys(unconverted).length ? ` + ${formatTotals(unconverted)}` : '';
    return `${L.formatMoney(krw, 'KRW')}${rest}`;
  }

  function renderAllTotal(monthly, usdKrw) {
    const view = cloudOverview(cloud.costs, cloud.meta);
    const { krw: subs, unconverted } = L.krwTotal(monthly, usdKrw);
    const cloudProjected = view.accounts.length ? view.total.projected : 0;
    const usdNote = monthly.USD && usdKrw ? `달러 구독 ${L.formatMoney(monthly.USD, 'USD')} 포함, 1달러 ${Math.round(usdKrw).toLocaleString('ko-KR')}원` : '';
    const missing = Object.keys(unconverted).length || view.hasUnconverted ? ' (원화로 못 바꾼 금액 제외)' : '';
    const cloudNote = cloudProjected ? `클라우드 월말 예상까지 합치면 매달 약 ${L.formatMoney(subs + cloudProjected, 'KRW')}${missing}` : '';
    $('all-total').textContent = [usdNote, cloudNote].filter(Boolean).join(' · ');
  }

  function renderSummary() {
    const s = L.summarize(records);
    const usdKrw = cloud.meta.usdKrw;
    $('monthly-total').textContent = moneyLine(s.monthly, usdKrw);
    $('yearly-total').textContent = Object.keys(s.yearly).length ? `1년이면 ${moneyLine(s.yearly, usdKrw)}` : '';
    renderAllTotal(s.monthly, usdKrw);
    const stats = [
      ['사용 중인 구독', `${s.activeSubscriptions}개`],
      ['이번 달 일회성 결제', formatTotals(s.oneTimeThisMonth)],
      ['결제수단 등록만 한 곳', `${s.cardRegistrations}곳`],
    ];
    $('stats').replaceChildren(...stats.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));

    $('upcoming-list').replaceChildren(...s.upcoming.map(({ record, date }) =>
      el('li', {},
        el('span', { class: 'when' }, formatDate(date)),
        el('span', { class: 'what' }, record.site),
        el('span', { class: 'leader', 'aria-hidden': 'true' }),
        el('span', { class: 'amount' }, L.formatMoney(record.amount, record.currency)))));
    $('upcoming-empty').hidden = s.upcoming.length > 0;
  }

  function cardText(r) {
    const card = r.card ? `${r.card.brand} ····${r.card.last4}` : null;
    return [card, r.pg].filter(Boolean).join(' · ') || '—';
  }

  function renderRow(r) {
    const flags = [
      r.trial && el('span', { class: 'badge trial' }, '무료 체험'),
      r.status === 'canceled' && el('span', { class: 'badge canceled' }, '해지함'),
    ];
    return el('tr', { class: r.status === 'canceled' ? 'is-canceled' : null },
      el('td', { class: 'site' }, r.site, r.note && el('small', {}, r.note)),
      el('td', {}, kindBadge(r), ...flags),
      el('td', { class: 'num' }, amountText(r)),
      el('td', { class: 'muted' }, cardText(r)),
      el('td', { class: 'muted' }, formatDate(r.startedAt)),
      el('td', {}, el('button', { type: 'button', class: 'link', onclick: () => openEditor(r) }, '수정')));
  }

  function renderRows() {
    const filter = currentFilter();
    for (const btn of $('filters').querySelectorAll('button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.filter === filter));
    }
    const visible = records
      .filter((r) => filter === 'all' || r.kind === filter)
      .sort((a, b) => b.createdAt - a.createdAt);
    $('rows').replaceChildren(...visible.map(renderRow));
    $('empty').hidden = visible.length > 0;
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

  // 결제 카드 드롭다운: 등록한 카드 + 기록에서 본 카드 + "새 카드 입력"
  // 카드가 한 장뿐이면 새 기록에서만 미리 고른다. 카드 없는 기존 기록에 저절로 붙으면 안 된다.
  function fillCardSelect(current, isNew) {
    const list = knownCards();
    const options = [
      el('option', { value: '' }, '선택 안 함'),
      ...list.map((c) => el('option', { value: c.last4 }, c.label === `${c.brand} ····${c.last4}` ? c.label : `${c.label} · ····${c.last4}`)),
    ];
    if (current && !list.some((c) => c.last4 === current.last4)) {
      options.push(el('option', { value: current.last4 }, `${current.brand || '카드'} ····${current.last4}`));
    }
    options.push(el('option', { value: NEW_CARD }, '새 카드 입력…'));
    const select = $('editor-form').elements.cardKey;
    select.replaceChildren(...options);
    select.value = current ? current.last4 : (isNew && list.length === 1 ? list[0].last4 : '');
    syncLast4Row();
  }

  function syncLast4Row() {
    const f = $('editor-form').elements;
    const isNew = f.cardKey.value === NEW_CARD;
    $('last4-row').hidden = !isNew;
    f.last4.required = isNew;
    if (!isNew) f.last4.value = '';
  }

  const planLabel = (p) => `${p.name} · ${L.formatMoney(p.amount, p.currency)}/${L.CYCLE_LABEL[p.cycle]}`;

  // 사이트가 목록에 있는 곳이면 요금제를 골라 금액·주기를 채울 수 있게 한다.
  function fillPlanSelect(planIndex = null) {
    const f = $('editor-form').elements;
    const item = K.findBySite(f.site.value.trim());
    const plans = (item && item.plans) || [];
    $('plan-row').hidden = plans.length === 0;
    f.plan.replaceChildren(el('option', { value: '' }, '직접 입력'), ...plans.map((p, i) => el('option', { value: String(i) }, planLabel(p))));
    f.plan.value = planIndex != null && plans[planIndex] ? String(planIndex) : '';
    $('plan-hint').textContent = plans.length ? `${K.PRICES_AS_OF} 기준 참고 가격이에요. 실제 결제액과 다르면 금액을 고쳐 주세요.` : '';
  }

  function applyPlan() {
    const f = $('editor-form').elements;
    const item = K.findBySite(f.site.value.trim());
    const plan = item && item.plans && item.plans[Number(f.plan.value)];
    if (!plan) return;
    const planNames = item.plans.map((p) => p.name);
    f.kind.value = 'subscription';
    f.cycle.value = plan.cycle;
    f.amount.value = plan.amount;
    f.currency.value = plan.currency;
    if (!f.note.value.trim() || planNames.includes(f.note.value.trim())) f.note.value = plan.name;
  }

  function openEditor(record, prefill = null) {
    const r = record || L.createRecord({ kind: 'subscription', cycle: 'monthly', currency: 'KRW', ...(prefill && prefill.fields) });
    editingId = record ? record.id : null;
    const f = $('editor-form').elements;
    f.site.value = r.site;
    f.kind.value = r.kind;
    f.cycle.value = r.cycle || '';
    f.amount.value = r.amount ?? '';
    f.currency.value = r.currency || 'KRW';
    f.pg.value = r.pg || '';
    f.startedAt.value = toDateInput(r.startedAt);
    f.status.value = r.status;
    f.trial.checked = Boolean(r.trial);
    f.note.value = r.note || '';
    fillCardSelect(r.card, !record);
    fillPlanSelect(prefill ? prefill.planIndex : null);
    $('editor-title').textContent = record ? '기록 수정' : `${(prefill && prefill.title) || '직접'} 추가`;
    $('delete-btn').hidden = !record;
    $('editor-evidence').textContent = r.evidence && r.evidence.length ? `감지 근거: ${r.evidence.join(' → ')}` : '';
    $('editor').showModal();
  }

  function cardFromForm() {
    const f = $('editor-form').elements;
    if (f.cardKey.value === NEW_CARD) {
      const last4 = f.last4.value.trim();
      return /^\d{4}$/.test(last4) ? { brand: '카드', last4 } : null;
    }
    if (!f.cardKey.value) return null;
    const known = knownCards().find((c) => c.last4 === f.cardKey.value);
    const base = records.find((r) => r.id === editingId);
    const brand = (known && known.brand) || (base && base.card && base.card.brand) || '카드';
    return { brand, last4: f.cardKey.value };
  }

  function recordFromForm(base) {
    const f = $('editor-form').elements;
    const amount = f.amount.value === '' ? null : Number(f.amount.value);
    return {
      ...base,
      site: f.site.value.trim(),
      kind: f.kind.value,
      cycle: f.cycle.value || null,
      amount: Number.isFinite(amount) ? amount : null,
      currency: f.currency.value,
      card: cardFromForm(),
      pg: f.pg.value.trim() || null,
      startedAt: new Date(`${f.startedAt.value}T00:00:00`).getTime(),
      status: f.status.value,
      trial: f.trial.checked,
      note: f.note.value.trim(),
      userEdited: true,
      updatedAt: Date.now(),
    };
  }

  async function saveEditor(event) {
    event.preventDefault();
    const form = $('editor-form');
    if (!form.reportValidity()) return;
    const base = records.find((r) => r.id === editingId) || L.createRecord({});
    const record = recordFromForm(base);
    const isNewCard = $('editor-form').elements.cardKey.value === NEW_CARD && record.card
      && !knownCards().some((c) => c.last4 === record.card.last4);
    await S.upsertRecord(record);
    editingId = record.id; // 아래 카드 저장이 실패해 다시 눌러도 기록이 두 번 생기지 않게
    $('editor').close();
    // 새로 입력한 카드는 다음부터 고르기만 하면 되게 "내 카드"에도 넣는다. 실패해도 기록은 이미 저장됐다.
    if (isNewCard) await S.saveCard({ last4: record.card.last4 }).catch((err) => console.error('[결제 기록장] 카드 저장', err));
  }

  async function deleteEditing() {
    if (!editingId || !confirm('이 기록을 삭제할까요?')) return;
    await S.deleteRecord(editingId);
    $('editor').close();
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
    if (btn) location.hash = btn.dataset.filter;
  });
  window.addEventListener('hashchange', renderRows);
  $('editor-form').elements.cardKey.addEventListener('change', syncLast4Row);
  $('editor-form').elements.plan.addEventListener('change', applyPlan);
  $('editor-form').elements.site.addEventListener('change', () => fillPlanSelect());
  $('csv-btn').addEventListener('click', exportCsv);
  $('editor-form').addEventListener('submit', (e) => saveEditor(e).catch(showError));
  $('delete-btn').addEventListener('click', () => deleteEditing().catch(showError));
  $('cancel-btn').addEventListener('click', () => $('editor').close());

  function showError(err) {
    console.error('[결제 기록장]', err);
    alert('저장하지 못했어요. 다시 시도해 주세요.');
  }

  S.onRecordsChanged((next) => {
    records = next;
    render();
  });
  S.onCardsChanged((next) => { cards = next; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(changes.cloudCosts || changes.cloudMeta)) return;
    cloud = {
      costs: changes.cloudCosts ? changes.cloudCosts.newValue || {} : cloud.costs,
      meta: changes.cloudMeta ? changes.cloudMeta.newValue || {} : cloud.meta,
    };
    renderSummary();
  });
  chrome.storage.local.get(['cloudCosts', 'cloudMeta']).then((stored) => {
    cloud = { costs: stored.cloudCosts || {}, meta: stored.cloudMeta || {} };
    renderSummary();
  }).catch(showError);
  // 환율은 12시간마다 한 번만 새로 받는다(이미 있으면 background가 건너뜀).
  chrome.runtime.sendMessage({ type: 'cloud:fx', payload: {} }).catch((err) => console.error('[결제 기록장]', err));
  Promise.all([S.loadRecords(), S.loadCards()]).then(([loadedRecords, loadedCards]) => {
    records = loadedRecords;
    cards = loadedCards;
    render();
  }).catch(showError);

  globalThis.PaymentDashboard = { openEditor, getRecords: () => records };
})();
