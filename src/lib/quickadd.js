/* 빠른 추가: 목록에서 여러 곳을 골라 요금제·카드·결제일만 칩으로 정하고 한 번에 기록한다. 타자 입력을 줄이는 게 목적. */
(function (root) {
  'use strict';

  const L = root.PaymentLedger || (typeof require === 'function' ? require('./ledger.js') : null);
  const K = root.PaymentCatalog || (typeof require === 'function' ? require('./catalog.js') : null);
  const MAX_BATCH = 30;
  const DAY = 24 * 60 * 60 * 1000;

  const midnight = (ts) => {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };

  /** 결제일 칩: 오늘 · 어제 · 이번 달 1일 (같은 날은 한 번만) */
  function dateChoices(now) {
    const today = midnight(now);
    const yesterday = midnight(today - DAY / 2);
    const d = new Date(today);
    const first = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const all = [
      { id: 'today', label: '오늘', ts: today },
      { id: 'yesterday', label: '어제', ts: yesterday },
      { id: 'first', label: '이번 달 1일', ts: first },
    ];
    return all.filter((c, i) => all.findIndex((x) => x.ts === c.ts) === i);
  }

  /** 먼저 골라 둘 카드(끝 4자리): 확인된 사용 중 구독에 가장 많이 쓴 카드, 없으면 등록 카드가 한 장일 때 그 카드.
      카드 칩(cardSummary)도 확인된 기록만 보니 여기서도 같은 기준이어야 칩 없는 값이 나오지 않는다. */
  function preferredCard(records, cards) {
    const counts = records
      .filter((r) => L.isActiveSubscription(r) && L.isConfirmed(r) && r.card && r.card.last4)
      .reduce((acc, r) => ({ ...acc, [r.card.last4]: (acc[r.card.last4] || 0) + 1 }), {});
    const [best] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (best) return best[0];
    return cards.length === 1 ? cards[0].last4 : null;
  }

  function parseAmount(raw) {
    if (raw == null || String(raw).trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  /**
   * @param {{ item: object, planIndex?: number|null, amount?: string|number }[]} selections
   * @param {{ card: {brand:string,last4:string}|null, startedAt: number, now?: number }} opts
   */
  function buildRecords(selections, { card, startedAt, now = Date.now() }) {
    if (selections.length > MAX_BATCH) throw new Error(`한 번에 ${MAX_BATCH}개까지 추가할 수 있어요.`);
    return selections.map(({ item, planIndex = null, amount }, i) => {
      const plan = item.plans && planIndex != null ? item.plans[planIndex] || null : null;
      const fields = K.recordFields(item, plan);
      return L.createRecord({
        ...fields,
        amount: plan ? fields.amount : parseAmount(amount),
        card: card ? { brand: card.brand || '카드', last4: card.last4 } : null,
        startedAt,
        review: 'confirmed',
        userEdited: true,
      }, now + i); // 같은 밀리초에 만들어도 id가 겹치지 않게
    });
  }

  const api = { MAX_BATCH, dateChoices, preferredCard, buildRecords };
  root.PaymentQuickAdd = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
