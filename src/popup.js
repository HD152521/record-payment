(() => {
  'use strict';

  const L = globalThis.PaymentLedger;
  const { el, formatTotals, amountText, kindBadge, cloudOverview } = globalThis.PaymentUI;
  const RECENT_COUNT = 4;

  function render(records) {
    const s = L.summarize(records);
    document.getElementById('total').textContent = formatTotals(s.monthly);
    const nextUp = s.upcoming[0];
    document.getElementById('sub').textContent = [
      `구독 ${s.activeSubscriptions}개`,
      nextUp && `다음 결제 ${nextUp.date.getMonth() + 1}/${nextUp.date.getDate()} ${nextUp.record.site}`,
    ].filter(Boolean).join(' · ');

    const recent = [...records].sort((a, b) => b.createdAt - a.createdAt).slice(0, RECENT_COUNT);
    const list = document.getElementById('recent');
    list.replaceChildren(...(recent.length
      ? recent.map((r) => el('li', {}, el('span', { class: 'site' }, r.site), kindBadge(r), el('span', { class: 'num' }, amountText(r))))
      : [el('li', { class: 'empty' }, '아직 기록이 없어요')]));
  }

  function renderCloud({ cloudCosts, cloudMeta }) {
    const view = cloudOverview(cloudCosts, cloudMeta);
    const box = document.getElementById('cloud');
    box.hidden = view.accounts.length === 0;
    if (box.hidden) return;
    const failed = view.accounts.filter((a) => a.error).length;
    box.replaceChildren(
      '클라우드 이번 달 ', el('b', {}, L.formatMoney(view.total.monthToDate, 'KRW')),
      el('span', { class: 'muted' }, [
        `월말 예상 ${L.formatMoney(view.total.projected, 'KRW')}`,
        failed && `${failed}곳 갱신 실패`,
      ].filter(Boolean).join(' · ')));
  }

  chrome.storage.local.get(['cloudCosts', 'cloudMeta']).then(renderCloud).catch((err) => console.error('[결제 기록장]', err));
  chrome.runtime.sendMessage({ type: 'cloud:refresh', payload: {} }).catch((err) => console.error('[결제 기록장]', err));

  document.getElementById('open').addEventListener('click', () => chrome.runtime.openOptionsPage());
  globalThis.PaymentStore.loadRecords().then(render).catch((err) => {
    console.error('[결제 기록장]', err);
    document.getElementById('sub').textContent = '기록을 불러오지 못했어요';
  });
})();
