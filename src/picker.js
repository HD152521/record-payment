/* "추가" 고르기 화면과 "내 카드" 칸.
   목록에서 고르면 연결 가능한 곳은 연결 대화상자로, 나머지는 요금제가 채워진 기록 양식으로 보낸다. */
(() => {
  'use strict';

  const L = globalThis.PaymentLedger;
  const S = globalThis.PaymentStore;
  const K = globalThis.PaymentCatalog;
  const { el } = globalThis.PaymentUI;
  const $ = (id) => document.getElementById(id);
  const ALL = 'all';

  let category = ALL;
  let cards = [];

  // ── 고르기 화면 ───────────────────────────────────────────
  const hasRecord = (item) => globalThis.PaymentDashboard.getRecords()
    .some((r) => r.status === 'active' && K.findBySite(r.site) === item);

  function itemHint(item) {
    if (item.connect) return '사용료 자동 연결';
    if (item.plans && item.plans.length) return `요금제 ${item.plans.length}개`;
    return '금액 직접 입력';
  }

  function itemButton(item) {
    return el('li', {},
      el('button', { type: 'button', class: `picker-item${item.connect ? ' is-connect' : ''}`, onclick: () => choose(item) },
        el('span', { class: 'picker-name' }, item.name),
        el('span', { class: 'picker-hint' }, itemHint(item)),
        hasRecord(item) && el('span', { class: 'badge' }, '기록 있음')));
  }

  function renderCategories() {
    const chips = [{ id: ALL, label: '전체' }, ...K.CATEGORIES].map((c) =>
      el('button', { type: 'button', 'aria-pressed': String(c.id === category), onclick: () => { category = c.id; renderPicker(); } }, c.label));
    $('picker-cats').replaceChildren(...chips);
  }

  function renderPicker() {
    renderCategories();
    const items = K.search($('picker-form').elements.q.value, category === ALL ? null : category);
    $('picker-list').replaceChildren(...items.map(itemButton));
    $('picker-empty').hidden = items.length > 0;
  }

  function openPicker() {
    category = ALL;
    $('picker-form').reset();
    $('picker-asof').textContent = `요금제 가격은 ${K.PRICES_AS_OF} 기준 참고가예요. 고른 뒤 실제 금액으로 고칠 수 있어요.`;
    renderPicker();
    $('picker').showModal();
    $('picker-form').elements.q.focus();
  }

  function choose(item) {
    $('picker').close();
    if (item.connect) {
      globalThis.PaymentCloudUI.openDialog(item.connect);
      return;
    }
    const firstPlan = item.plans && item.plans.length ? item.plans[0] : null;
    globalThis.PaymentDashboard.openEditor(null, {
      title: item.name,
      fields: K.recordFields(item, firstPlan),
      planIndex: firstPlan ? 0 : null,
    });
  }

  // ── 내 카드 ──────────────────────────────────────────────
  function cardRow(card) {
    const monthly = Object.entries(card.monthly);
    return el('li', { class: card.registered ? null : 'is-unregistered' },
      el('div', { class: 'card-main' },
        el('span', { class: 'card-label' }, card.label),
        el('span', { class: 'muted card-meta' },
          card.label.includes(card.last4) ? `구독 ${card.count}개` : `${card.brand} ····${card.last4} · 구독 ${card.count}개`)),
      el('span', { class: 'amount' }, monthly.length ? monthly.map(([cur, v]) => `${L.formatMoney(v, cur)}/월`).join(' + ') : '—'),
      card.registered
        ? el('button', { type: 'button', class: 'link', 'aria-label': `${card.label} 삭제`, onclick: () => deleteCard(card) }, '삭제')
        : el('button', { type: 'button', class: 'link', onclick: () => openCardDialog(card) }, '등록'));
  }

  function renderCards() {
    const summary = L.cardSummary(globalThis.PaymentDashboard.getRecords(), cards);
    $('card-list').replaceChildren(...summary.map(cardRow));
    $('card-empty').hidden = summary.length > 0;
  }

  function openCardDialog(seed = null) {
    const f = $('card-form');
    f.reset();
    if (seed) {
      f.elements.last4.value = seed.last4;
      if ([...f.elements.brand.options].some((o) => o.value === seed.brand)) f.elements.brand.value = seed.brand;
    }
    $('card-dialog').showModal();
  }

  async function submitCard(event) {
    event.preventDefault();
    const f = $('card-form');
    if (!f.reportValidity()) return;
    const { label, brand, last4 } = f.elements;
    await S.saveCard({ label: label.value, brand: brand.value, last4: last4.value.trim() });
    $('card-dialog').close();
  }

  async function deleteCard(card) {
    if (!confirm(`${card.label} 카드를 목록에서 지울까요? 기록에 남은 끝 4자리는 그대로예요.`)) return;
    await S.removeCard(card.id);
  }

  function showError(err) {
    console.error('[결제 기록장]', err);
    alert(err.message || '처리하지 못했어요. 다시 시도해 주세요.');
  }

  $('add-btn').addEventListener('click', openPicker);
  $('picker-form').elements.q.addEventListener('input', renderPicker);
  $('picker-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const [first] = K.search(e.target.elements.q.value, category === ALL ? null : category);
    if (first) choose(first);
  });
  $('picker-manual').addEventListener('click', () => {
    $('picker').close();
    globalThis.PaymentDashboard.openEditor(null);
  });
  $('picker-cancel').addEventListener('click', () => $('picker').close());
  $('card-add').addEventListener('click', () => openCardDialog());
  $('card-cancel').addEventListener('click', () => $('card-dialog').close());
  $('card-form').addEventListener('submit', (e) => submitCard(e).catch(showError));

  S.onCardsChanged((next) => { cards = next; renderCards(); });
  document.addEventListener('records-rendered', renderCards);
  S.loadCards().then((loaded) => { cards = loaded; renderCards(); }).catch(showError);
})();
