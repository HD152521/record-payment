/* "추가" 고르기 화면. 여러 곳을 눌러 담고, 요금제·카드·결제일을 칩으로 고른 뒤 한 번에 기록한다.
   사용료 자동 연결이 되는 곳(AWS 등)은 담지 않고 바로 연결 대화상자로 보낸다. */
(() => {
  'use strict';

  const L = globalThis.PaymentLedger;
  const S = globalThis.PaymentStore;
  const K = globalThis.PaymentCatalog;
  const Q = globalThis.PaymentQuickAdd;
  const CONFIG = globalThis.PaymentCloudConfig;
  const { el, brandAvatar, toast, radioChip, checkedValue, checkRadio } = globalThis.PaymentUI;
  const $ = (id) => document.getElementById(id);
  const ALL = 'all';
  const CUSTOM_DATE = 'custom';
  const POPULAR = 'popular';

  let category = POPULAR;
  let picked = []; // [{ item, planIndex, amount }]
  let cards = [];

  const form = () => $('picker-form');
  const dash = () => globalThis.PaymentDashboard;
  const isPicked = (item) => picked.some((p) => p.item.id === item.id);
  const hasRecord = (item) => dash().getRecords().some((r) => r.status === 'active' && K.findBySite(r.site) === item);

  function itemHint(item) {
    if (item.connect) return '사용료 자동 연결';
    if (item.plans && item.plans.length) {
      const p = item.plans[0];
      return `${L.formatMoney(p.amount, p.currency)}/${L.CYCLE_LABEL[p.cycle]}`;
    }
    return '금액 직접 입력';
  }

  const query = () => form().elements.q.value.trim();

  // 검색 중에는 전체에서 찾고, 아니면 고른 분류(처음엔 "많이 쓰는 것")만 보여 준다
  function visibleItems() {
    if (query()) return K.search(query(), null, CONFIG);
    if (category === POPULAR) return Q.popularItems();
    return K.search('', category === ALL ? null : category, CONFIG);
  }

  // ── 목록 ────────────────────────────────────────────────
  function itemRow(item) {
    const on = isPicked(item);
    const entry = picked.find((p) => p.item.id === item.id);
    return el('li', { class: 'picker-row' },
      el('button', {
        type: 'button', class: `picker-item${item.connect ? ' is-connect' : ''}`,
        'aria-pressed': item.connect ? null : String(on), onclick: () => toggle(item),
      },
      brandAvatar(item),
      el('span', { class: 'picker-name' }, item.name),
      hasRecord(item) && el('span', { class: 'badge' }, '기록 있음'),
      el('span', { class: 'picker-hint' }, itemHint(item)),
      !item.connect && el('span', { class: 'picker-check', 'aria-hidden': 'true' }, on ? '✓' : '+')),
      entry && el('div', { class: 'picker-detail' }, planControl(entry), rowOwnControl(entry)));
  }

  // ── 줄마다 카드·결제일: 정하지 않으면(undefined) 아래 공통 값을 쓴다 ─────────
  const SHARED = '';
  const NO_CARD = 'none';
  const toInput = (ts) => new Date(ts - new Date(ts).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const cardList = () => L.cardSummary(dash().getRecords(), cards);

  function rowCardValue(p) {
    if (p.card === undefined) return SHARED;
    return p.card ? p.card.last4 : NO_CARD;
  }

  function onRowCard(p, value) {
    const known = cardList().find((c) => c.last4 === value);
    const card = value === SHARED ? undefined : (known ? { brand: known.brand || '카드', last4: known.last4 } : null);
    update(p.item.id, { card });
  }

  function onRowDate(p, value) {
    update(p.item.id, { startedAt: value ? new Date(`${value}T00:00:00`).getTime() : undefined });
  }

  function rowOwnControl(p) {
    const current = rowCardValue(p);
    const option = (value, label) => el('option', { value, selected: value === current }, label);
    return el('div', { class: 'row-own' },
      el('label', {}, '카드',
        el('select', { 'aria-label': `${p.item.name} 결제 카드`, onchange: (e) => onRowCard(p, e.target.value) },
          option(SHARED, '공통 카드'),
          ...cardList().map((c) => option(c.last4, c.label.includes(c.last4) ? c.label : `${c.label} ····${c.last4}`)),
          option(NO_CARD, '카드 없음'))),
      el('label', {}, '첫 결제일',
        el('input', { type: 'date', 'aria-label': `${p.item.name} 첫 결제일`, value: Number.isFinite(p.startedAt) ? toInput(p.startedAt) : null,
          onchange: (e) => onRowDate(p, e.target.value) })));
  }

  function renderList() {
    const searching = query() !== '';
    const chips = [{ id: POPULAR, label: '많이 쓰는 것' }, { id: ALL, label: '전체' }, ...K.CATEGORIES].map((c) =>
      el('button', { type: 'button', 'aria-pressed': String(c.id === category), onclick: () => { category = c.id; renderList(); } }, c.label));
    $('picker-cats').replaceChildren(...chips);
    $('picker-cats').hidden = searching;
    const items = visibleItems();
    $('picker-heading').textContent = searching ? '검색 결과' : (category === POPULAR ? 'IT인이 많이 쓰는 것' : '');
    $('picker-heading').hidden = !$('picker-heading').textContent;
    $('picker-list').replaceChildren(...items.map(itemRow));
    picked.filter((p) => p.planIndex != null).forEach((p) => checkRadio(form(), `plan-${p.item.id}`, String(p.planIndex)));
    $('picker-empty').hidden = items.length > 0;
    $('picker-custom').textContent = `'${query()}' 직접 추가`;
    $('picker-custom').hidden = !searching;
  }

  function toggle(item) {
    if (item.connect) {
      $('picker').close();
      globalThis.PaymentCloudUI.openDialog(item.connect);
      return;
    }
    picked = isPicked(item) ? picked.filter((p) => p.item.id !== item.id) : [...picked, Q.defaultSelection(item)];
    renderList();
    renderTray();
  }

  // ── 담은 줄: 그 자리에서 펼쳐 요금제(또는 금액)를 바꾼다 ──────────────
  const update = (id, patch) => { picked = picked.map((p) => (p.item.id === id ? { ...p, ...patch } : p)); };

  function planControl(p) {
    const plans = p.item.plans || [];
    if (!plans.length) {
      const unit = p.item.currency === 'KRW' ? '원' : '달러';
      return el('label', { class: 'tray-amount' },
        el('span', { class: 'sr-only' }, `${p.item.name} 금액`),
        el('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: '월 금액(선택)', value: p.amount,
          oninput: (e) => { update(p.item.id, { amount: e.target.value }); renderSubmit(); } }),
        el('span', { class: 'unit' }, unit));
    }
    const name = `plan-${p.item.id}`;
    const group = el('div', { class: 'chips choice small', role: 'radiogroup', 'aria-label': `${p.item.name} 요금제` },
      ...plans.map((plan, i) => radioChip(name, String(i), `${plan.name} ${L.formatMoney(plan.amount, plan.currency)}`)));
    group.addEventListener('change', (e) => { update(p.item.id, { planIndex: Number(e.target.value) }); renderSubmit(); });
    return group;
  }

  function renderSubmit() {
    const submit = $('picker-submit');
    submit.disabled = picked.length === 0;
    submit.textContent = Q.submitLabel(picked, dash().getCloud().meta.usdKrw);
  }

  function renderTray() {
    $('picker-tray').hidden = picked.length === 0;
    $('tray-count').textContent = `${picked.length}개`;
    $('tray-names').textContent = picked.map((p) => p.item.name).join(', ');
    $('picker-manual').textContent = picked.length === 1 ? '자세히 입력' : '직접 입력';
    renderSubmit();
  }

  function renderCardChips() {
    const list = cardList();
    $('tray-cards').replaceChildren(
      ...list.map((c) => radioChip('trayCard', c.last4, c.label.includes(c.last4) ? c.label : `${c.label} ····${c.last4}`)),
      radioChip('trayCard', '', list.length ? '선택 안 함' : '카드 없이'));
    checkRadio(form(), 'trayCard', Q.preferredCard(dash().getRecords(), cards) || '');
  }

  function renderDateChips() {
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
    const known = cardList().find((c) => c.last4 === last4);
    return { brand: (known && known.brand) || '카드', last4 };
  }

  // ── 열기·저장 ───────────────────────────────────────────
  async function openPicker() {
    category = POPULAR;
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
  // 검색칸에서 Enter: 맨 위 결과를 담고 검색칸을 비운다. 이미 담긴 것은 빼지 않는다(Enter로 고른 걸 잃지 않게).
  // 빈 칸에서 Enter는 아무것도 하지 않는다(실수로 저장되지 않게).
  form().elements.q.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const [first] = visibleItems();
    if (!e.target.value.trim() || !first) return;
    if (!isPicked(first)) toggle(first);
    e.target.value = '';
    renderList();
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
      const shared = (() => { try { return chosenDate(); } catch { return Date.now(); } })();
      const startedAt = Number.isFinite(only.startedAt) ? only.startedAt : shared;
      const card = only.card !== undefined ? only.card : chosenCard();
      dash().openEditor(null, { title: only.item.name, fields: { ...K.recordFields(only.item, plan), card, startedAt }, planIndex: only.planIndex });
    } else {
      dash().openEditor(null);
    }
  });
  $('picker-custom').addEventListener('click', () => {
    const name = query();
    $('picker').close();
    dash().openEditor(null, { title: name, fields: { site: name, kind: 'subscription' } });
  });
  $('picker-cancel').addEventListener('click', () => $('picker').close());

  // 팝업의 "빠른 추가": 세션 저장소에 막 찍힌 시각이 있으면 고르기 화면을 연다(한 번 쓰고 지운다).
  const QUICK_ADD_FRESH_MS = 15000;
  async function openIfAsked(at) {
    if (!at || Date.now() - at > QUICK_ADD_FRESH_MS || $('picker').open) return;
    await chrome.storage.session.remove('quickAddAt');
    await openPicker();
  }
  chrome.storage.session.get('quickAddAt').then(({ quickAddAt }) => openIfAsked(quickAddAt)).catch(fail);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.quickAddAt && changes.quickAddAt.newValue) openIfAsked(changes.quickAddAt.newValue).catch(fail);
  });
})();
