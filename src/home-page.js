/* 이번 달 화면 묶음: 계산 재료(ctx)를 한 번 모아 짙은 칸·예산(home-hero)·분류·카드(home-spend)와
   여기서 그리는 곧 나갈 돈(2주 띠 + 목록)·챙길 일에 나눠 준다. 기록·카드·설정·사용료가 바뀔 때마다 다시 그린다. */
(() => {
  'use strict';

  const L = globalThis.PaymentLedger;
  const S = globalThis.PaymentStore;
  const HM = globalThis.PaymentHome;
  const F = globalThis.PaymentForecast;
  const { el, recordAvatar, serviceName, ddayText, toast } = globalThis.PaymentUI;
  const $ = (id) => document.getElementById(id);
  const D = () => globalThis.PaymentDashboard;
  const UPCOMING_ROWS = 5;
  const HOT_DAYS = 1;

  function context() {
    const d = D();
    const now = Date.now();
    const cloud = d.getCloud();
    const usdKrw = cloud.meta.usdKrw;
    const s = d.summarize();
    const cloudNow = d.cloudParts();
    return {
      now, cloud, usdKrw, s, cloudNow, records: d.getRecords(), cards: d.getCards(), settings: d.getSettings(),
      isCovered: d.isCovered, cloudView: d.cloudView(), joinMoney: d.joinMoney, moneyLine: d.moneyLine,
      forecast: F.monthForecast(s, cloudNow, usdKrw),
    };
  }

  // ── 곧 나갈 돈 ─────────────────────────────────────────
  function dayCell(c) {
    const [first] = c.items;
    const cls = ['day', c.isToday && 'today', c.isWeekend && 'we', c.items.length && 'has', c.isBiggest && 'big'].filter(Boolean).join(' ');
    const names = c.items.map((it) => `${serviceName(it.record.site)} ${L.formatMoney(it.amount, it.currency)}`).join(', ');
    const label = `${new Date(c.ts).getMonth() + 1}월 ${c.day}일 ${c.weekday}요일${c.isToday ? ' 오늘' : ''}${names ? ` — ${names}` : ''}`;
    return el('li', { class: cls, 'aria-label': label },
      el('span', { 'aria-hidden': 'true' }, c.weekday),
      el('b', { 'aria-hidden': 'true' }, String(c.day)),
      first && recordAvatar(first.record),
      first && el('span', { class: 'amt', 'aria-hidden': 'true' },
        c.items.length > 1 ? `${HM.shortMoney(c.krw, 'KRW')}` : HM.shortMoney(first.amount, first.currency)));
  }

  function cardChip(r) {
    return r.card && r.card.last4
      ? el('span', { class: 'cardchip' }, `${r.card.brand || '카드'} ${r.card.last4}`)
      : el('span', { class: 'cardchip none' }, '카드 안 정함');
  }

  function upcomingRow({ record, date, isTrialEnd }, ctx) {
    const days = L.daysUntil(date, ctx.now);
    const meta = [record.note, L.CYCLE_LABEL[record.cycle] && `${L.CYCLE_LABEL[record.cycle]}간`, isTrialEnd && '무료 체험 끝나고 첫 결제'].filter(Boolean).join(' · ');
    const isForeign = record.currency && record.currency !== 'KRW';
    const approx = isForeign ? L.krwTotal({ [record.currency]: record.amount }, ctx.usdKrw).krw : 0;
    return el('li', { class: `row${days <= L.SOON_DAYS ? ' is-soon' : ''}` },
      recordAvatar(record),
      el('div', { class: 't' }, el('b', {}, serviceName(record.site)), el('span', {}, meta || record.site)),
      cardChip(record),
      el('span', { class: `chip${days <= HOT_DAYS ? ' hot' : ''}` }, ddayText(days)),
      el('span', { class: 'amt num' }, L.formatMoney(record.amount, record.currency),
        approx ? el('small', {}, `≈ ${L.formatMoney(approx, 'KRW')}`) : null));
  }

  function renderUpcoming(ctx) {
    const strip = HM.dayStrip(ctx.records, ctx.now, { usdKrw: ctx.usdKrw, isCovered: ctx.isCovered });
    const total = HM.stripTotals(strip);
    $('soon-total').textContent = total.count ? `2주 · ${total.count}건 · ${L.formatMoney(total.krw, 'KRW')}` : '2주 안엔 없어요';
    $('day-strip').replaceChildren(...strip.map(dayCell));
    const rows = ctx.s.upcoming.slice(0, UPCOMING_ROWS);
    $('upcoming-list').replaceChildren(...rows.map((u) => upcomingRow(u, ctx)));
    $('upcoming-empty').hidden = rows.length > 0;
    globalThis.PaymentMotion.staggerIn($('upcoming-list'));
  }

  // ── 챙길 일 ───────────────────────────────────────────
  async function markCanceled(r) {
    const next = { ...r, status: 'canceled', canceledAt: Date.now(), userEdited: true, updatedAt: Date.now() };
    await S.upsertRecord(next);
    toast(`${serviceName(r.site)} 해지한 것으로 적었어요.`, { actionLabel: '되돌리기', onAction: () => S.upsertRecord(r).catch(D().showError) });
  }

  function todoRow(icon, tone, title, sub, action) {
    return el('li', { class: 'todo-row' },
      el('span', { class: `ico ${tone}`, 'aria-hidden': 'true' }, icon),
      el('div', { class: 't' }, el('b', {}, title), el('span', {}, sub)),
      action);
  }

  function trialRow(t) {
    const name = serviceName(t.record.site);
    const when = t.days <= 0 ? '오늘' : `${t.days}일 뒤`;
    return todoRow('!', 'warn', `${name} 무료 체험이 ${when} 끝나요`,
      `안 쓸 거면 그 전에 해지하세요 · ${L.formatMoney(t.record.amount, t.record.currency)}`,
      el('button', { type: 'button', class: 'btn soft', onclick: () => markCanceled(t.record).catch(D().showError) }, '해지함'));
  }

  function goAssignCards() {
    globalThis.PaymentRouter.go('cards');
    requestAnimationFrame(() => $('card-unassigned-btn').click());
  }

  function pendingRow(r) {
    return el('li', {},
      recordAvatar(r),
      el('span', { class: 'what' }, r.site, el('small', {}, globalThis.PaymentUI.amountText(r))),
      el('span', { class: 'acts' },
        el('button', { type: 'button', class: 'btn soft', onclick: () => D().confirmPending(r) }, r.trial ? '맞아요 · 체험 끝나는 날 넣기' : '맞아요'),
        el('button', { type: 'button', class: 'btn link', onclick: () => D().openEditor(r) }, '고치기'),
        el('button', { type: 'button', class: 'btn link', onclick: () => D().removeRecord(r) }, '아니에요')));
  }

  function renderTodo(ctx) {
    const items = HM.todoList(ctx.records, ctx.now, { isCovered: (r) => ctx.isCovered(r) });
    const pending = items.find((i) => i.kind === 'pending');
    const noCard = items.find((i) => i.kind === 'nocard');
    $('todo-list').replaceChildren(...items.filter((i) => i.kind === 'trial').map(trialRow));
    $('pending').hidden = !pending;
    $('pending-count').textContent = pending ? String(pending.records.length) : '0';
    $('pending-list').replaceChildren(...(pending ? pending.records.map(pendingRow) : []));
    $('todo-more').replaceChildren(...(noCard ? [todoRow('▭', 'mut', `카드 안 정한 기록 ${noCard.count}개`, '카드를 정하면 카드별 합계에 들어가요',
      el('button', { type: 'button', class: 'btn soft', onclick: goAssignCards }, '정하기'))] : []));
    $('todo-count').hidden = items.length === 0;
    $('todo-count').textContent = String(items.length);
    $('todo-empty').hidden = items.length > 0;
    $('records-dot').hidden = !pending;
  }

  function render() {
    if (!D()) return;
    const ctx = context();
    // 한 칸이 못 그려져도 나머지 칸(특히 확인할 기록)은 그린다.
    const sections = [['hero', globalThis.PaymentHomeHero.render], ['upcoming', renderUpcoming], ['todo', renderTodo], ['spend', globalThis.PaymentHomeSpend.render]];
    for (const [name, draw] of sections) {
      try {
        draw(ctx);
      } catch (err) {
        console.error('[결제 기록장] 이번 달 화면', name, err);
      }
    }
  }

  document.addEventListener('records-rendered', render);
})();
