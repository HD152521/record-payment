/* "내 카드" 화면과 카드 등록 대화상자. 카드번호는 끝 4자리만 받는다. */
(() => {
  'use strict';

  const L = globalThis.PaymentLedger;
  const S = globalThis.PaymentStore;
  const { el, toast, checkRadio, checkedValue } = globalThis.PaymentUI;
  const $ = (id) => document.getElementById(id);
  const DEFAULT_BRAND = 'Visa';

  let cards = [];

  function cardRow(card) {
    const monthly = Object.entries(card.monthly);
    return el('li', { class: card.registered ? null : 'is-unregistered' },
      el('span', { class: 'card-chip', 'aria-hidden': 'true' }, card.last4),
      el('div', { class: 'card-main' },
        el('span', { class: 'card-label' }, card.label),
        el('span', { class: 'muted card-meta' },
          card.label.includes(card.last4) ? `구독 ${card.count}개` : `${card.brand} ····${card.last4} · 구독 ${card.count}개`)),
      el('span', { class: 'amount' }, monthly.length ? monthly.map(([cur, v]) => `${L.formatMoney(v, cur)}/월`).join(' + ') : '—'),
      card.registered
        ? el('button', { type: 'button', class: 'link', 'aria-label': `${card.label} 삭제`, onclick: () => deleteCard(card).catch(fail) }, '삭제')
        : el('button', { type: 'button', class: 'link', onclick: () => openCardDialog(card) }, '등록'));
  }

  function renderCards() {
    const summary = L.cardSummary(globalThis.PaymentDashboard.getRecords(), cards);
    $('card-list').replaceChildren(...summary.map(cardRow));
    $('card-empty').hidden = summary.length > 0;
  }

  // 대화상자 위 작은 카드 그림: 고른 종류와 끝 4자리를 바로 보여 준다.
  function syncPreview() {
    const f = $('card-form');
    $('card-preview-brand').textContent = checkedValue(f, 'brand') || DEFAULT_BRAND;
    $('card-preview-last4').textContent = f.elements.last4.value.padEnd(4, '0').slice(0, 4);
  }

  function openCardDialog(seed = null) {
    const f = $('card-form');
    f.reset();
    const brands = [...f.querySelectorAll('input[name="brand"]')].map((i) => i.value);
    checkRadio(f, 'brand', seed && brands.includes(seed.brand) ? seed.brand : DEFAULT_BRAND);
    if (seed) f.elements.last4.value = seed.last4;
    syncPreview();
    $('card-dialog').showModal();
    f.elements.last4.focus();
  }

  async function submitCard(event) {
    event.preventDefault();
    const f = $('card-form');
    if (!f.reportValidity()) return;
    const card = { label: f.elements.label.value, brand: checkedValue(f, 'brand') || DEFAULT_BRAND, last4: f.elements.last4.value.trim() };
    await S.saveCard(card);
    $('card-dialog').close();
    toast(`····${card.last4} 카드를 등록했어요. 이제 추가할 때 고르기만 하면 돼요.`);
  }

  // 지우고 나서 되돌릴 수 있게 한다. 기록에 남은 끝 4자리는 그대로다.
  async function deleteCard(card) {
    await S.removeCard(card.id);
    toast(`${card.label} 카드를 목록에서 지웠어요.`, {
      actionLabel: '되돌리기',
      onAction: () => S.saveCard({ label: card.label, brand: card.brand, last4: card.last4 }).catch(fail),
    });
  }

  function fail(err) {
    console.error('[결제 기록장] 카드', err);
    toast(err && err.message ? err.message : '처리하지 못했어요. 다시 시도해 주세요.', { isError: true });
  }

  $('card-add').addEventListener('click', () => openCardDialog());
  $('card-cancel').addEventListener('click', () => $('card-dialog').close());
  $('card-form').addEventListener('input', syncPreview);
  $('card-form').addEventListener('submit', (e) => submitCard(e).catch(fail));

  S.onCardsChanged((next) => { cards = next; renderCards(); });
  document.addEventListener('records-rendered', renderCards);
  S.loadCards().then((loaded) => { cards = loaded; renderCards(); }).catch(fail);
})();
