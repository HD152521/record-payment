/* "내 카드" 화면과 카드 등록 대화상자. 카드번호는 끝 4자리만 받는다. */
(() => {
  'use strict';

  const L = globalThis.PaymentLedger;
  const S = globalThis.PaymentStore;
  const { el, toast, checkRadio, checkedValue } = globalThis.PaymentUI;
  const $ = (id) => document.getElementById(id);
  const DEFAULT_BRAND = 'Visa';

  let cards = [];

  const dash = () => globalThis.PaymentDashboard;
  const NONE = '__none'; // 카드 안 정한 기록을 보는 상세
  let detailKey = null;

  // 이번 달 합계(원화). 환율이 없어 못 바꾼 금액은 따로 붙인다.
  function money(byCurrency) {
    const { krw, unconverted } = L.krwTotal(byCurrency, dash().getCloud().meta.usdKrw);
    const rest = Object.keys(unconverted).length ? globalThis.PaymentUI.formatTotals(unconverted) : '';
    if (!rest) return L.formatMoney(krw, 'KRW');
    return krw ? `${L.formatMoney(krw, 'KRW')} + ${rest}` : rest;
  }
  const mdText = (ts) => `${new Date(ts).getMonth() + 1}월 ${new Date(ts).getDate()}일`;
  const summaries = () => {
    const opts = { isCovered: (r) => dash().isCovered(r) };
    const records = dash().getRecords();
    return { list: L.cardSummary(records, cards, Date.now(), opts), none: L.unassignedSummary(records, Date.now(), opts) };
  };

  function cardRow(card) {
    return el('li', { class: card.registered ? null : 'is-unregistered' },
      el('span', { class: 'card-chip', 'aria-hidden': 'true' }, card.last4),
      el('button', { type: 'button', class: 'card-main card-open', 'aria-label': `${card.label} 자세히`, onclick: () => openDetail(card.last4) },
        el('span', { class: 'card-label' }, card.label),
        el('span', { class: 'muted card-meta' },
          `${card.label.includes(card.last4) ? '' : `${card.brand} ····${card.last4} · `}구독 ${card.count}개${card.nextCharge ? ` · 다음 ${mdText(card.nextCharge)}` : ''}`)),
      el('span', { class: 'amount' }, Object.keys(card.thisMonth).length ? `이번 달 ${money(card.thisMonth)}` : '—'),
      card.registered
        ? el('button', { type: 'button', class: 'link', 'aria-label': `${card.label} 삭제`, onclick: () => deleteCard(card).catch(fail) }, '삭제')
        : el('button', { type: 'button', class: 'link', onclick: () => openCardDialog(card) }, '등록'));
  }

  function renderUnassigned(none) {
    $('card-unassigned').hidden = none.count === 0;
    $('card-unassigned-text').textContent = `카드 안 정한 기록 ${none.count}개 · 이번 달 ${money(none.thisMonth)}`;
  }

  function recordRow(r, withCheck) {
    const when = r.kind === 'one_time' ? `${mdText(r.startedAt)} 결제` : (L.nextChargeDate(r) ? `다음 ${mdText(L.nextChargeDate(r))}` : '');
    return el('li', { 'data-id': r.id },
      withCheck ? el('input', { type: 'checkbox', checked: true, 'aria-label': `${r.site} 선택` }) : null,
      el('span', { class: 'card-label' }, r.site),
      el('span', { class: 'muted card-meta' }, `${L.KIND_LABEL[r.kind] || ''} ${when}`.trim()),
      el('span', { class: 'amount' }, L.formatMoney(r.amount, r.currency)));
  }

  function fillAssign(list) {
    const pick = $('card-assign-pick');
    pick.replaceChildren(...list.map((c) => el('option', { value: c.last4 }, c.label.includes(c.last4) ? c.label : `${c.label} ····${c.last4}`)));
    $('card-assign-btn').disabled = list.length === 0;
    if (!list.length) pick.replaceChildren(el('option', { value: '' }, '먼저 카드를 등록해 주세요'));
  }

  function renderDetail() {
    if (!detailKey) return;
    const { list, none } = summaries();
    const isNone = detailKey === NONE;
    const card = isNone ? null : list.find((c) => c.last4 === detailKey);
    const part = isNone ? none : card;
    if (!part) { $('card-detail').close(); return; }
    $('card-detail-title').textContent = isNone ? '카드 안 정한 기록' : card.label;
    $('card-detail-total').textContent = `이번 달 ${money(part.thisMonth)}`;
    $('card-detail-sub').textContent = `나간 돈 ${money(part.paid)} · 나갈 돈 ${money(part.due)}${part.nextCharge ? ` · 다음 결제일 ${mdText(part.nextCharge)}` : ''}`;
    $('card-assign').hidden = !isNone;
    if (isNone) fillAssign(list);
    $('card-detail-list').replaceChildren(...part.records.map((r) => recordRow(r, isNone)));
    $('card-detail-empty').hidden = part.records.length > 0;
  }

  function openDetail(key) {
    detailKey = key;
    renderDetail();
    if (detailKey && !$('card-detail').open) $('card-detail').showModal();
  }

  // 체크된 기록 전부에 고른 카드를 한 번에 붙인다. 손으로 고친 기록으로 쳐서 자동 감지가 덮지 않게 한다.
  async function assignChecked() {
    const last4 = $('card-assign-pick').value;
    const { list } = summaries();
    const card = list.find((c) => c.last4 === last4);
    const ids = new Set([...$('card-detail-list').querySelectorAll('li')]
      .filter((li) => li.querySelector('input').checked).map((li) => li.dataset.id));
    if (!card || !ids.size) { toast('카드와 기록을 골라 주세요.', { isError: true }); return; }
    const now = Date.now();
    const next = dash().getRecords().filter((r) => ids.has(r.id))
      .map((r) => ({ ...r, card: { brand: card.brand, last4: card.last4 }, userEdited: true, updatedAt: now }));
    await S.upsertRecords(next);
    toast(`${next.length}개 기록에 ${card.label} 카드를 정했어요.`);
  }

  function renderCards() {
    const { list, none } = summaries();
    $('card-list').replaceChildren(...list.map(cardRow));
    $('card-empty').hidden = list.length > 0;
    renderUnassigned(none);
    renderDetail();
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

  $('card-unassigned-btn').addEventListener('click', () => openDetail(NONE));
  $('card-detail-close').addEventListener('click', () => $('card-detail').close());
  $('card-detail').addEventListener('close', () => { detailKey = null; });
  $('card-assign-btn').addEventListener('click', () => assignChecked().catch(fail));
  $('card-add').addEventListener('click', () => openCardDialog());
  $('card-cancel').addEventListener('click', () => $('card-dialog').close());
  $('card-form').addEventListener('input', syncPreview);
  $('card-form').addEventListener('submit', (e) => submitCard(e).catch(fail));

  S.onCardsChanged((next) => { cards = next; renderCards(); });
  document.addEventListener('records-rendered', renderCards);
  S.loadCards().then((loaded) => { cards = loaded; renderCards(); }).catch(fail);
})();
