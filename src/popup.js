(() => {
  'use strict';

  const L = globalThis.PaymentLedger;
  const { el, formatTotals, amountText, kindBadge, cloudOverview, withFallbackFx } = globalThis.PaymentUI;
  const RECENT_COUNT = 4;

  // 대시보드와 같은 규칙: 확인된 기록만, 사용료 연결에 이미 든 서비스는 빼고. 서버·API는 아래 칸에 따로.
  function render(records, { cloudCosts, cloudMeta }) {
    const { connected } = cloudOverview(cloudCosts, cloudMeta);
    const s = L.summarize(records, Date.now(), { isCovered: (r) => globalThis.PaymentCatalog.coveredBy(r, connected) != null });
    // 달러도 원화로 합친다(환율이 없으면 참고 환율). 원화로 못 바꾼 통화만 따로 붙인다.
    const { krw, unconverted } = L.krwTotal(s.thisMonth, withFallbackFx(cloudMeta).usdKrw);
    const rest = Object.keys(unconverted).length ? formatTotals(unconverted) : '';
    document.getElementById('total').textContent = rest ? (krw ? `${L.formatMoney(krw, 'KRW')} + ${rest}` : rest) : L.formatMoney(krw, 'KRW');
    const nextUp = s.upcoming[0];
    document.getElementById('sub').textContent = [
      s.pending.length && `확인할 기록 ${s.pending.length}개`,
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

  chrome.runtime.sendMessage({ type: 'cloud:refresh', payload: {} }).catch((err) => console.error('[결제 기록장]', err));

  document.getElementById('open').addEventListener('click', () => chrome.runtime.openOptionsPage());
  Promise.all([globalThis.PaymentStore.loadRecords(), chrome.storage.local.get(['cloudCosts', 'cloudMeta'])]).then(([records, stored]) => {
    render(records, stored);
    renderCloud(stored);
  }).catch((err) => {
    console.error('[결제 기록장]', err);
    document.getElementById('sub').textContent = '기록을 불러오지 못했어요';
  });
})();
