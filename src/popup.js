/* 툴바 팝업: 이번 달 예상(홈과 같은 계산), 지난달 대비, 예산 막대, 가장 급한 챙길 일, 곧 나갈 돈 3건. */
(() => {
  'use strict';

  const L = globalThis.PaymentLedger;
  const F = globalThis.PaymentForecast;
  const HM = globalThis.PaymentHome;
  const ST = globalThis.PaymentSettings;
  const { el, formatTotals, cloudOverview, withFallbackFx, recordAvatar, serviceName, ddayText } = globalThis.PaymentUI;
  const $ = (id) => document.getElementById(id);
  const UPCOMING_COUNT = 3;
  const HOT_DAYS = 1;
  const STORED_KEYS = ['cloudCosts', 'cloudMeta', 'cloudHistory', ST.KEY];

  const money = (krw) => L.formatMoney(krw, 'KRW');
  const joinMoney = (krw, unconverted) => {
    const rest = Object.keys(unconverted).length ? formatTotals(unconverted) : '';
    if (!rest) return money(krw);
    return krw ? `${money(krw)} + ${rest}` : rest;
  };

  // 예산이 있으면 예산 막대, 없으면 나간 돈 / 나갈 돈 막대
  function renderBar(f, pace) {
    const total = f.totalKRW;
    const show = Boolean(pace) || total > 0;
    $('pbar').hidden = !show;
    $('pmeta').hidden = !show;
    if (!show) return;
    $('pbar').dataset.level = pace ? pace.level : 'none';
    const width = pace ? Math.min(100, pace.usedPct) : Math.round((f.paidKRW / total) * 100);
    $('pbar-fill').style.width = `${width}%`;
    $('pmeta-left').textContent = pace ? `예산 ${pace.usedPct}%` : `나간 돈 ${money(f.paidKRW)}`;
    $('pmeta-right').textContent = pace ? (pace.left >= 0 ? `${money(pace.left)} 남음` : `${money(-pace.left)} 넘음`) : `나갈 돈 ${money(f.dueKRW)}`;
    $('pbar').setAttribute('aria-label', pace ? `예산 ${pace.usedPct}% 사용` : `나간 돈 ${money(f.paidKRW)}, 나갈 돈 ${money(f.dueKRW)}`);
  }

  // 홈과 같은 규칙: 확인된 기록만, 사용료 연결에 이미 든 서비스는 빼고, 서버·API는 월말 예상까지 더한다.
  function renderHero(ctx) {
    const { f, cloud } = ctx;
    $('p-month').textContent = `${new Date(ctx.now).getMonth() + 1}월`;
    globalThis.PaymentMotion.countUp($('total'), f.totalKRW, (n) => joinMoney(n, f.unconverted));
    const last = HM.lastMonthKRW(ctx.records, ctx.now, { usdKrw: ctx.usdKrw, isCovered: ctx.isCovered, cloudHistory: ctx.cloudHistory });
    const delta = HM.deltaInfo(f.totalKRW, last);
    $('delta').textContent = delta.text;
    $('delta').dataset.trend = delta.trend;
    renderBar(f, HM.budgetPace(f.totalKRW, ctx.settings.budgetKRW, ctx.now));
    $('cloud-line').textContent = cloud.projected ? `서버·API 지금 ${money(cloud.now)} → 월말 예상 ${money(cloud.projected)}` : '';
  }

  const ALERT_TEXT = {
    trial: (t) => [`${serviceName(t.record.site)} 무료 체험 ${t.days <= 0 ? '오늘' : `${t.days}일 뒤`} 끝나요`, '안 쓸 거면 그 전에 해지하세요'],
    pending: (p) => [`자동으로 찾은 결제 ${p.records.length}건`, '대시보드에서 맞는지 골라 주세요'],
    nocard: (n) => [`카드 안 정한 기록 ${n.count}개`, '카드를 정하면 카드별 합계에 들어가요'],
  };

  function renderAlert(ctx) {
    const [top] = HM.todoList(ctx.records, ctx.now, { isCovered: ctx.isCovered });
    $('alert').hidden = !top;
    if (!top) return;
    const [title, sub] = ALERT_TEXT[top.kind](top);
    $('alert').classList.toggle('is-acc', top.kind !== 'trial');
    $('alert-ico').textContent = top.kind === 'trial' ? '!' : top.kind === 'pending' ? '?' : '▭';
    $('alert-title').textContent = title;
    $('alert-sub').textContent = sub;
  }

  function upcomingRow({ record, date }, now) {
    const days = L.daysUntil(date, now);
    const card = record.card && record.card.last4 ? `${record.card.brand || '카드'} ${record.card.last4}` : '카드 안 정함';
    return el('li', { class: days <= L.SOON_DAYS ? 'is-soon' : null },
      recordAvatar(record),
      el('div', { class: 't' }, el('b', {}, serviceName(record.site)), el('span', {}, card)),
      el('span', { class: `chip${days <= HOT_DAYS ? ' hot' : ''}` }, ddayText(days)),
      el('span', { class: 'amount' }, L.formatMoney(record.amount, record.currency)));
  }

  function renderUpcoming(ctx) {
    const strip = HM.dayStrip(ctx.records, ctx.now, { usdKrw: ctx.usdKrw, isCovered: ctx.isCovered });
    const total = HM.stripTotals(strip);
    $('soon-total').textContent = total.count ? `2주 · ${total.count}건 · ${money(total.krw)}` : '2주 안엔 없어요';
    const items = ctx.s.upcoming.slice(0, UPCOMING_COUNT);
    $('upcoming').replaceChildren(...(items.length
      ? items.map((u) => upcomingRow(u, ctx.now))
      : [el('li', { class: 'empty' }, '30일 안에 나갈 결제가 없어요')]));
    globalThis.PaymentMotion.staggerIn($('upcoming'));
  }

  function render(records, stored) {
    const now = Date.now();
    const view = cloudOverview(stored.cloudCosts, stored.cloudMeta);
    const usdKrw = withFallbackFx(stored.cloudMeta).usdKrw;
    const cloudHistory = stored.cloudHistory || {};
    const isCovered = HM.coverage(view.connected, cloudHistory);
    const s = L.summarize(records, now, { isCovered });
    const cloud = F.cloudParts(view, now, globalThis.PaymentCloudCosts.billingWindow(now).thisKey);
    const ctx = { now, records, usdKrw, cloudHistory, isCovered, s, cloud, f: F.monthForecast(s, cloud, usdKrw), settings: ST.normalizeSettings(stored[ST.KEY]) };
    renderHero(ctx);
    renderAlert(ctx);
    renderUpcoming(ctx);
  }

  // 읽기가 겹치면 마지막으로 시작한 읽기만 그린다(늦게 끝난 옛 값이 덮어쓰지 않게).
  let latest = 0;
  const load = () => {
    latest += 1;
    const ticket = latest;
    return Promise.all([globalThis.PaymentStore.loadRecords(), chrome.storage.local.get(STORED_KEYS)])
      .then(([records, stored]) => { if (ticket === latest) render(records, stored); })
      .catch((err) => {
        console.error('[결제 기록장]', err);
        $('cloud-line').textContent = '기록을 불러오지 못했어요';
      });
  };

  const fail = (err) => console.error('[결제 기록장]', err);
  // 빠른 추가: 대시보드(열려 있으면 그 탭)를 열고 고르기 화면을 띄우라고 세션 저장소로 알린다.
  async function openQuickAdd() {
    await chrome.storage.session.set({ quickAddAt: Date.now() });
    await chrome.runtime.openOptionsPage();
  }
  const openPage = (hash) => chrome.tabs.create({ url: chrome.runtime.getURL(`src/dashboard.html#${hash}`) });

  // 갱신이 끝나면 저장소가 바뀌니 다시 그린다.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.records || STORED_KEYS.some((k) => changes[k]))) load();
  });
  chrome.runtime.sendMessage({ type: 'cloud:refresh', payload: {} }).catch(fail);
  $('open').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('alert').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('quick-add').addEventListener('click', () => openQuickAdd().catch(fail));
  $('open-records').addEventListener('click', () => openPage('records').catch(fail));
  load();
})();
