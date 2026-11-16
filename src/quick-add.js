/* "추가" 고르기 화면. 여러 곳을 눌러 담고, 요금제·카드·결제일을 칩으로 고른 뒤 한 번에 기록한다.
   사용료 자동 연결이 되는 곳(AWS 등)은 담지 않고 바로 연결 대화상자로 보낸다. */
(() => {
  'use strict';

  const L = globalThis.PaymentLedger;
  const S = globalThis.PaymentStore;
  const K = globalThis.PaymentCatalog;
  const Q = globalThis.PaymentQuickAdd;
  const { el, toast, radioChip, checkedValue, checkRadio } = globalThis.PaymentUI;
  const $ = (id) => document.getElementById(id);
  const ALL = 'all';
  const CUSTOM_DATE = 'custom';

  let category = ALL;
  let picked = []; // [{ item, planIndex, amount }]
  let cards = [];

  const form = () => $('picker-form');
  const dash = () => globalThis.PaymentDashboard;
  const isPicked = (item) => picked.some((p) => p.item.id === item.id);
  const hasRecord = (item) => dash().getRecords().some((r) => r.status === 'active' && K.findBySite(r.site) === item);
  const initial = (name) => (String(name).match(/[\p{L}\p{N}]/u) || ['?'])[0];

  function itemHint(item) {
    if (item.connect) return '사용료 자동 연결';
    if (item.plans && item.plans.length) {
      const p = item.plans[0];
      return `${L.formatMoney(p.amount, p.currency)}~/${L.CYCLE_LABEL[p.cycle]}`;
    }
    return '금액 직접 입력';
  }

  // ── 목록 ────────────────────────────────────────────────
  function itemButton(item) {
    const on = isPicked(item);
    return el('li', {},
      el('button', {
        type: 'button', class: `picker-item${item.connect ? ' is-connect' : ''}`,
        'aria-pressed': item.connect ? null : String(on), onclick: () => toggle(item),
      },
      el('span', { class: 'avatar', 'aria-hidden': 'true' }, initial(item.name)),
      el('span', { class: 'picker-text' },
        el('span', { class: 'picker-name' }, item.name),
        el('span', { class: 'picker-hint' }, itemHint(item))),
      hasRecord(item) && el('span', { class: 'badge' }, '기록 있음'),
      !item.connect && el('span', { class: 'picker-check', 'aria-hidden': 'true' }, on ? '✓' : '+')));
  }

  function renderList() {
    const chips = [{ id: ALL, label: '전체' }, ...K.CATEGORIES].map((c) =>
      el('button', { type: 'button', 'aria-pressed': String(c.id === category), onclick: () => { category = c.id; renderList(); } }, c.label));
    $('picker-cats').replaceChildren(...chips);
    const items = K.search(form().elements.q.value, category === ALL ? null : category);
    $('picker-list').replaceChildren(...items.map(itemButton));
    $('picker-empty').hidden = items.length > 0;
  }

  function toggle(item) {
    if (item.connect) {
      $('picker').close();
      globalThis.PaymentCloudUI.openDialog(item.connect);
      return;
    }
    picked = isPicked(item)
      ? picked.filter((p) => p.item.id !== item.id)
      : [...picked, { item, planIndex: item.plans && item.plans.length ? 0 : null, amount: '' }];
    renderList();
    renderTray();
  }

  // ── 담은 곳 ─────────────────────────────────────────────
  const update = (id, patch) => { picked = picked.map((p) => (p.item.id === id ? { ...p, ...patch } : p)); };

  function trayPlan(p) {
    const plans = p.item.plans || [];
    if (!plans.length) {
      const unit = p.item.currency === 'KRW' ? '원' : '달러';
      return el('label', { class: 'tray-amount' },
        el('span', { class: 'sr-only' }, `${p.item.name} 금액`),
        el('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: '금액(선택)', value: p.amount,
          oninput: (e) => update(p.item.id, { amount: e.target.value }) }),
        el('span', { class: 'unit' }, unit));
    }
    const name = `plan-${p.item.id}`;
    const group = el('div', { class: 'chips choice small', role: 'radiogroup', 'aria-label': `${p.item.name} 요금제` },
      ...plans.map((plan, i) => radioChip(name, String(i), `${plan.name} ${L.formatMoney(plan.amount, plan.currency)}`)));
    group.addEventListener('change', (e) => update(p.item.id, { planIndex: Number(e.target.value) }));
    return group;
  }

  function trayRow(p) {
    return el('li', {},
      el('span', { class: 'avatar', 'aria-hidden': 'true' }, initial(p.item.name)),
      el('div', { class: 'tray-main' }, el('span', { class: 'tray-name' }, p.item.name), trayPlan(p)),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': `${p.item.name} 빼기`, onclick: () => toggle(p.item) }, '✕'));
  }

  function renderTray() {
    $('picker-tray').hidden = picked.length === 0;
    $('tray-count').textContent = String(picked.length);
    $('tray-list').replaceChildren(...picked.map(trayRow));
    picked.filter((p) => p.planIndex != null).forEach((p) => checkRadio(form(), `plan-${p.item.id}`, String(p.planIndex)));
    $('picker-manual').textContent = picked.length === 1 ? '자세히 입력' : '직접 입력';
    const submit = $('picker-submit');
    submit.disabled = picked.length === 0;
    submit.textContent = picked.length ? `${picked.length}개 추가` : '추가';
  }

  function renderCardChips() {
    const list = L.cardSummary(dash().getRecords(), cards);
    $('tray-cards').replaceChildren(
      ...list.map((c) => radioChip('trayCard', c.last4, c.label.includes(c.last4) ? c.label : `${c.label} ····${c.last4}`)),
      radioChip('trayCard', '', list.length ? '선택 안 함' : '카드 없이'));
    checkRadio(form(), 'trayCard', Q.preferredCard(dash().getRecords(), cards) || '');
  }

  function renderDateChips() {
    const toInput = (ts) => new Date(ts - new Date(ts).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    $('tray-dates').replaceChildren(
      ...Q.dateChoices(Date.now()).map((c) => radioChip('trayDateChip', String(c.ts), c.label)),
      radioChip('trayDateChip', CUSTOM_DATE, '날짜 고르기'));
    const [today] = Q.dateChoices(Date.now());
    checkRadio(form(), 'trayDateChip', String(today.ts));
    form().elements.trayDate.value = toInput(today.ts);
    form().elements.trayDate.hidden = true;
  }

  function chosenDate() {
    const chip = checkedValue(form(), 'trayDateChip');
    if (chip && chip !== CUSTOM_DATE) return Number(chip);
    const value = form().elements.trayDate.value;
    if (!value) throw new Error('첫 결제일을 골라 주세요.');
    return new Date(`${value}T00:00:00`).getTime();
  }

  function chosenCard() {
    const last4 = checkedValue(form(), 'trayCard');
    if (!last4) return null;
    const known = L.cardSummary(dash().getRecords(), cards).find((c) => c.last4 === last4);
    return { brand: (known && known.brand) || '카드', last4 };
  }

  // ── 열기·저장 ───────────────────────────────────────────
  async function openPicker() {
    category = ALL;
    picked = [];
    form().reset();
    cards = await S.loadCards();
    $('picker-asof').textContent = `요금제 가격은 ${K.PRICES_AS_OF} 기준 참고가예요. 추가한 뒤 실제 금액으로 고칠 수 있어요.`;
    renderList();
    renderTray();
    renderCardChips();
    renderDateChips();
    $('picker').showModal();
    form().elements.q.focus();
  }

  async function submit(event) {
    event.preventDefault();
    if (!picked.length) return;
    const records = Q.buildRecords(picked, { card: chosenCard(), startedAt: chosenDate() });
    await S.upsertRecords(records);
    $('picker').close();
    const names = records.length === 1 ? records[0].site : `${records.length}개`;
    toast(`${names} 기록을 추가했어요.`, {
      actionLabel: '되돌리기',
      onAction: () => S.deleteRecords(records.map((r) => r.id)).catch(fail),
    });
  }

  function fail(err) {
    console.error('[결제 기록장] 추가', err);
    toast(err && err.message ? err.message : '추가하지 못했어요. 다시 시도해 주세요.', { isError: true });
  }

  $('add-btn').addEventListener('click', () => openPicker().catch(fail));
  form().elements.q.addEventListener('input', renderList);
  // 검색칸에서 Enter: 맨 위 결과를 담고 검색칸을 비운다. 빈 칸에서 Enter는 아무것도 하지 않는다(실수로 저장되지 않게).
  form().elements.q.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const [first] = K.search(e.target.value, category === ALL ? null : category);
    if (e.target.value.trim() && first) { toggle(first); e.target.value = ''; renderList(); }
  });
  $('tray-dates').addEventListener('change', (e) => {
    form().elements.trayDate.hidden = e.target.value !== CUSTOM_DATE;
    if (e.target.value === CUSTOM_DATE) form().elements.trayDate.focus();
  });
  form().addEventListener('submit', (e) => submit(e).catch(fail));
  $('picker-manual').addEventListener('click', () => {
    const [only] = picked;
    $('picker').close();
    // 하나만 담았으면 고른 요금제·카드·결제일을 채운 자세한 양식으로, 아니면 빈 양식으로
    if (picked.length === 1) {
      const plan = only.planIndex != null ? only.item.plans[only.planIndex] : null;
      const startedAt = (() => { try { return chosenDate(); } catch { return Date.now(); } })();
      dash().openEditor(null, { title: only.item.name, fields: { ...K.recordFields(only.item, plan), card: chosenCard(), startedAt }, planIndex: only.planIndex });
    } else {
      dash().openEditor(null);
    }
  });
  $('picker-cancel').addEventListener('click', () => $('picker').close());
})();
