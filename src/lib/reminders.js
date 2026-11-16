/* 결제 알림: 다음 결제일이 며칠 안에 들면 한 번만 알린다. 무엇을 알릴지만 정하고, 알림 띄우기는 background가 한다. */
(function (root) {
  'use strict';

  const L = root.PaymentLedger || (typeof require === 'function' ? require('./ledger.js') : null);
  const DAY_MS = 86_400_000;
  const KEEP_SENT_DAYS = 40;

  const startOfDay = (ts) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const whenText = (days) => (days === 0 ? '오늘' : days === 1 ? '내일' : `${days}일 뒤`);

  function reminderOf(record, date, days) {
    const money = L.formatMoney(record.amount, record.currency);
    return {
      key: `${record.id}:${dateKey(date)}`,
      record,
      date,
      title: record.trial ? `${whenText(days)} 무료 체험이 끝나요` : `${whenText(days)} 결제돼요`,
      message: record.trial
        ? `${record.site} 체험이 끝나면 ${money}이 결제돼요. 안 쓸 거면 그 전에 해지하세요.`
        : `${record.site} ${money}`,
    };
  }

  /** daysBefore일 안(오늘 포함)에 결제일이 오는, 아직 안 알린 구독들 */
  function dueReminders(records, now, { daysBefore = 1, sent = {} } = {}) {
    const today = startOfDay(now);
    return records
      .filter((r) => L.isConfirmed(r) && L.isActiveSubscription(r))
      .map((r) => {
        // 오늘 이미 지난 시각이어도 오늘 결제일이면 알린다
        const next = L.nextChargeDate(r, today - 1);
        if (!next) return null;
        const days = Math.round((startOfDay(next.getTime()) - today) / DAY_MS);
        return days >= 0 && days <= daysBefore ? reminderOf(r, next, days) : null;
      })
      .filter((x) => x && !sent[x.key]);
  }

  function pruneSent(sent, now) {
    return Object.fromEntries(Object.entries(sent || {}).filter(([, at]) => now - at <= KEEP_SENT_DAYS * DAY_MS));
  }

  const api = { dueReminders, pruneSent };
  root.PaymentReminders = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
