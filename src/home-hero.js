/* 이번 달 짙은 칸(총액·지난달 대비·종류별·6달 막대)과 예산 칸. 숫자는 전부 기존 계산(forecast·history·home)에서 온다. */
(() => {
  'use strict';

  const L = globalThis.PaymentLedger;
  const H = globalThis.PaymentHistory;
  const HM = globalThis.PaymentHome;
  const { el } = globalThis.PaymentUI;
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const won = (n) => L.formatMoney(n, 'KRW');
  const CHART_MONTHS = 6;

  // 아래부터 쌓는 순서. 색은 달마다 화면과 같은 계열색(구독 1, 일회성 2, 서버·API 3)
  const KINDS = [
    { key: 'subscription', label: '구독', color: 'var(--series-1)', unit: '개' },
    { key: 'cloud', label: '서버·API', color: 'var(--series-3)', unit: '곳' },
    { key: 'one_time', label: '일회성', color: 'var(--series-2)', unit: '건' },
  ];
  const STACK = KINDS.map((k) => k.key);
  const colorOf = (key) => KINDS.find((k) => k.key === key).color;
  const shortWon = (n) => (n >= 1e4 ? `${+(n / 1e4).toFixed(n >= 1e5 ? 0 : 1)}만` : n.toLocaleString('ko-KR'));

  function svg(tag, attrs = {}, ...children) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
    for (const c of children.flat()) if (c) node.append(c);
    return node;
  }

  /** 최근 6달(이번 달은 월말 예상) 종류별 원화 */
  function sixMonths(ctx) {
    return H.groupedMonthly(ctx.records, ctx.now, {
      months: CHART_MONTHS, by: 'all', isCovered: ctx.isCovered, usdKrw: ctx.usdKrw,
      cloudKRW: (key, isCurrent) => (isCurrent ? ctx.cloudNow.projected : H.cloudMonthKRW(ctx.cloud.history, key, ctx.usdKrw).krw),
    }).months;
  }

  function renderTotal(ctx) {
    const { totalKRW, unconverted } = ctx.forecast;
    $('hero-month').textContent = `${new Date(ctx.now).getMonth() + 1}월`;
    globalThis.PaymentMotion.countUp($('monthly-total'), totalKRW, (n) => ctx.joinMoney(n, unconverted));
    const last = HM.lastMonthKRW(ctx.records, ctx.now, { usdKrw: ctx.usdKrw, isCovered: ctx.isCovered, cloudHistory: ctx.cloud.history });
    const delta = HM.deltaInfo(totalKRW, last);
    $('month-delta').textContent = delta.text;
    $('month-delta').dataset.trend = delta.trend;
  }

  function renderMix(ctx, current) {
    const counts = { ...HM.kindCounts(ctx.records, ctx.now, { isCovered: ctx.isCovered }), cloud: ctx.cloudView.connected.size };
    const rows = KINDS.filter((k) => current.parts[k.key] > 0 || counts[k.key] > 0);
    $('kind-mix').replaceChildren(...rows.map((k) => el('li', {},
      el('i', { style: `background:${k.color}`, 'aria-hidden': 'true' }),
      el('span', {}, `${k.label} ${counts[k.key]}${k.unit}`),
      el('b', { class: 'num' }, won(current.parts[k.key] || 0)))));
    $('hero-empty').hidden = rows.length > 0;
  }

  function renderNotes(ctx) {
    const { s, usdKrw } = ctx;
    const saved = L.krwTotal(s.savedThisYear, usdKrw).krw;
    const yearly = Object.keys(s.monthly).length ? `정액 구독 월 평균 ${ctx.moneyLine(s.monthly, usdKrw)} · 1년이면 ${ctx.moneyLine(s.yearly, usdKrw)}` : '';
    $('yearly-total').textContent = [yearly, saved ? `해지로 올해 아낀 돈 ${won(saved)}` : ''].filter(Boolean).join(' · ');
    const rateText = `1달러 ${Math.round(usdKrw).toLocaleString('ko-KR')}원`;
    const usdNote = s.thisMonth.USD
      ? `달러 결제 ${L.formatMoney(s.thisMonth.USD, 'USD')} 포함, ${ctx.cloud.meta.fxFallback ? `${rateText}(${globalThis.PaymentUI.FALLBACK_FX_AS_OF} 참고 환율 · 실시간 환율을 아직 못 받았어요)` : rateText}` : '';
    const missing = Object.keys(ctx.forecast.unconverted).length || ctx.cloudNow.hasUnconverted ? '원화로 못 바꾼 금액 제외' : '';
    $('all-total').textContent = [usdNote, missing].filter(Boolean).join(' · ');
  }

  function columnLabel(bar) {
    const parts = KINDS.filter((k) => bar.segs.some((s) => s.key === k.key))
      .map((k) => `${k.label} ${won(bar.segs.find((s) => s.key === k.key).value)}`);
    return `${bar.label}${bar.isCurrent ? ' 예상' : ''} ${won(bar.total)}${parts.length ? ` — ${parts.join(', ')}` : ''}`;
  }

  function column(bar) {
    // 위 칸부터 그린다(맨 위 칸만 둥근 끝)
    const segs = [...bar.segs].reverse().map((s) => el('i', { style: `height:${s.pct.toFixed(2)}%;background:${colorOf(s.key)}` }));
    return el('li', {
      class: `col${bar.isCurrent ? ' cur forecast' : ''}`, 'aria-label': columnLabel(bar), style: `--h:${bar.heightPct.toFixed(2)}%`,
      'data-v': bar.isCurrent && bar.total ? shortWon(bar.total) : null,
    }, segs);
  }

  function renderChart(months) {
    const model = HM.chartModel(months, STACK);
    $('hero-legend').replaceChildren(
      ...KINDS.map((k) => el('li', {}, el('i', { style: `background:${k.color}`, 'aria-hidden': 'true' }), k.label)),
      el('li', { class: 'avg-key' }, '┄ 6달 평균'));
    const avg = !model.isEmpty && model.avg > 0
      ? el('div', { class: 'avg', style: `bottom:${model.avgPct.toFixed(2)}%`, 'aria-hidden': 'true' }, el('span', {}, `평균 ${shortWon(model.avg)}`)) : null;
    const empty = model.isEmpty ? el('p', { class: 'plot-empty' }, '기록이 쌓이면 달마다 막대가 생겨요') : null;
    $('hero-plot').replaceChildren(...[avg, el('ol', { class: 'cols' }, model.bars.map(column)), empty].filter(Boolean));
    $('hero-xaxis').replaceChildren(...model.bars.map((b) => el('span', { class: b.isCurrent ? 'on' : null }, b.isCurrent ? `${b.label} · 예상` : b.label)));
  }

  // ── 예산 ──────────────────────────────────────────────
  const RING_R = 40;
  const RING_C = 2 * Math.PI * RING_R;
  const LEVEL_TEXT = { ok: '● 여유 있어요', warn: '⚠ 거의 다 썼어요', over: '⛔ 예산을 넘었어요' };

  function ring(pace) {
    const used = pace ? Math.min(1, pace.ratio) : 0;
    const label = pace ? `예산 ${pace.usedPct}% 사용, 오늘까지 쓸 만한 선 ${Math.round(pace.dayShare * 100)}%` : '예산을 아직 정하지 않았어요';
    return svg('svg', { width: 96, height: 96, viewBox: '0 0 96 96', role: 'img', 'aria-label': label },
      svg('circle', { cx: 48, cy: 48, r: RING_R, class: pace ? 'track' : 'track is-empty' }),
      used > 0 && svg('circle', { cx: 48, cy: 48, r: RING_R, class: 'arc', 'stroke-dasharray': `${(used * RING_C).toFixed(1)} ${RING_C.toFixed(1)}`, transform: 'rotate(-90 48 48)' }),
      pace && svg('line', { x1: 48, y1: 2, x2: 48, y2: 15, class: 'tick', transform: `rotate(${(pace.dayShare * 360).toFixed(1)} 48 48)` }),
      svg('text', { x: 48, y: 50, 'text-anchor': 'middle', class: 'ring-pct' }, pace ? `${pace.usedPct}%` : '—'),
      svg('text', { x: 48, y: 64, 'text-anchor': 'middle', class: 'ring-sub' }, pace ? '사용' : '예산 없음'));
  }

  function paceRows(ctx, pace) {
    const rows = [
      [`오늘까지 쓸 만한 돈 (${Math.round(pace.dayShare * 100)}%)`, won(pace.allowedKRW)],
      ['지금까지 나간 돈', won(ctx.forecast.paidKRW)],
      pace.daysLeft > 0 && pace.left > 0 && [`남은 ${pace.daysLeft}일, 하루에`, won(pace.perDayKRW)],
    ].filter(Boolean);
    return rows.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', { class: 'num' }, v)));
  }

  function renderBudget(ctx) {
    const budgetKRW = ctx.settings.budgetKRW;
    const pace = HM.budgetPace(ctx.forecast.totalKRW, budgetKRW, ctx.now);
    $('budget').dataset.level = pace ? pace.level : 'none';
    $('budget-edit').textContent = pace ? '바꾸기' : '예산 정하기';
    $('budget-amount').textContent = pace ? `월 ${won(budgetKRW)}` : '';
    $('budget-ring').replaceChildren(ring(pace));
    $('budget-left').hidden = !pace;
    $('budget-left-label').hidden = !pace;
    $('budget-pace').hidden = !pace;
    if (!pace) {
      $('budget-text').textContent = '예산을 정해 두면 얼마나 남았는지, 넘었는지 알려 드려요.';
      return;
    }
    $('budget-left').textContent = won(Math.abs(pace.left));
    $('budget-left-label').textContent = pace.left >= 0 ? '남았어요' : '더 나가요';
    $('budget-text').textContent = pace.left >= 0 ? LEVEL_TEXT[pace.level] : `${LEVEL_TEXT.over} · 예산 ${won(budgetKRW)}보다 ${won(-pace.left)} 더 나가요`;
    $('budget-pace').replaceChildren(...paceRows(ctx, pace));
  }

  function render(ctx) {
    const months = sixMonths(ctx);
    renderTotal(ctx);
    renderMix(ctx, months[months.length - 1]);
    renderNotes(ctx);
    renderChart(months);
    renderBudget(ctx);
  }

  // 예산 정하기: 설정 화면으로 가서 바로 입력칸에
  $('budget-edit').addEventListener('click', () => {
    requestAnimationFrame(() => document.querySelector('#budget-form [name=budget]').focus());
  });

  globalThis.PaymentHomeHero = { render };
})();
