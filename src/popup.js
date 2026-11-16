(() => {
  'use strict';

  const L = globalThis.PaymentLedger;
  const F = globalThis.PaymentForecast;
  const { el, formatTotals, cloudOverview, withFallbackFx } = globalThis.PaymentUI;
  const $ = (id) => document.getElementById(id);
  const UPCOMING_COUNT = 3;

  const money = (krw) => L.formatMoney(krw, 'KRW');
  const joinMoney = (krw, unconverted) => {
    const rest = Object.keys(unconverted).length ? formatTotals(unconverted) : '';
    if (!rest) return money(krw);
    return krw ? `${money(krw)} + ${rest}` : rest;
  };

  // 홈과 같은 규칙: 확인된 기록만, 사용료 연결에 이미 든 서비스는 빼고, 서버·API는 월말 예상까지 더한다.
  function renderHeadline(s, cloud, usdKrw) {
    const { paidKRW, dueKRW, totalKRW, unconverted } = F.monthForecast(s, cloud, usdKrw);
    $('total').textContent = joinMoney(totalKRW, unconverted);
    $('paid-bar').hidden = totalKRW <= 0;
    $('paid-fill').style.width = totalKRW > 0 ? `${Math.round((paidKRW / totalKRW) * 100)}%` : '0%';
    $('paid-bar').setAttribute('aria-label', `나간 돈 ${money(paidKRW)}, 나갈 돈 ${money(dueKRW)}`);
    $('split-legend').replaceChildren(...(totalKRW > 0 ? [
      el('li', { class: 'is-paid' }, '나간 돈 ', el('b', {}, money(paidKRW))),
      el('li', { class: 'is-due' }, '나갈 돈 ', el('b', {}, money(dueKRW))),
    ] : []));
    $('cloud-line').textContent = cloud.projected ? `서버·API 지금 ${money(cloud.now)} → 월말 예상 ${money(cloud.projected)}` : '';
    $('pending').hidden = s.pending.length === 0;
    $('pending').textContent = `확인할 기록 ${s.pending.length}개 · 대시보드에서 맞는지 골라 주세요`;
  }

  function renderUpcoming(s, usdKrw) {
    const now = Date.now();
    const { krw, unconverted } = L.krwTotal(s.soon, usdKrw);
    $('soon-total').textContent = Object.keys(s.soon).length ? `7일 안 ${joinMoney(krw, unconverted)}` : '7일 안 없어요';
    const items = s.upcoming.slice(0, UPCOMING_COUNT);
    $('upcoming').replaceChildren(...(items.length
      ? items.map(({ record, date }) => el('li', { class: L.daysUntil(date, now) <= L.SOON_DAYS ? 'is-soon' : null },
        el('span', { class: 'when' }, `D-${L.daysUntil(date, now)}`),
        el('span', { class: 'what' }, record.site),
        el('span', { class: 'amount' }, L.formatMoney(record.amount, record.currency))))
      : [el('li', { class: 'empty' }, '30일 안에 나갈 결제가 없어요')]));
  }

  function render(records, { cloudCosts, cloudMeta }) {
    const now = Date.now();
    const view = cloudOverview(cloudCosts, cloudMeta);
    const usdKrw = withFallbackFx(cloudMeta).usdKrw;
    const s = L.summarize(records, now, { isCovered: (r) => globalThis.PaymentCatalog.coveredBy(r, view.connected) != null });
    const cloud = F.cloudParts(view, now, globalThis.PaymentCloudCosts.billingWindow(now).thisKey);
    renderHeadline(s, cloud, usdKrw);
    renderUpcoming(s, usdKrw);
  }

  // 읽기가 겹치면 마지막으로 시작한 읽기만 그린다(늦게 끝난 옛 값이 덮어쓰지 않게).
  let latest = 0;
  const load = () => {
    latest += 1;
    const ticket = latest;
    return Promise.all([globalThis.PaymentStore.loadRecords(), chrome.storage.local.get(['cloudCosts', 'cloudMeta'])])
      .then(([records, stored]) => { if (ticket === latest) render(records, stored); })
    .catch((err) => {
      console.error('[결제 기록장]', err);
      $('cloud-line').textContent = '기록을 불러오지 못했어요';
    });
  };

  // 갱신이 끝나면 저장소가 바뀌니 다시 그린다.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.cloudCosts || changes.records || changes.cloudMeta)) load();
  });
  chrome.runtime.sendMessage({ type: 'cloud:refresh', payload: {} }).catch((err) => console.error('[결제 기록장]', err));
  $('open').addEventListener('click', () => chrome.runtime.openOptionsPage());
  load();
})();
