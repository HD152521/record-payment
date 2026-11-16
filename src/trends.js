/* 달마다 화면: 달별로 쌓은 막대 그래프 하나가 주인공. 구독·일회성·서버·API 세 가지를 같은 색 순서로 쌓는다.
   라이브러리 없이 SVG로 그린다(확장은 밖의 스크립트를 못 불러온다). 표로 보기·키보드 포커스로도 같은 숫자를 읽을 수 있다. */
(() => {
  'use strict';

  const L = globalThis.PaymentLedger;
  const H = globalThis.PaymentHistory;
  const { el } = globalThis.PaymentUI;
  const D = () => globalThis.PaymentDashboard;
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';

  const SERIES = [
    { key: 'subscription', label: '구독', color: 'var(--series-1)' },
    { key: 'one_time', label: '일회성', color: 'var(--series-2)' },
    { key: 'cloud', label: '서버·API', color: 'var(--series-3)' },
  ];
  const HEIGHT = 300;
  const PAD = { top: 28, right: 8, bottom: 30, left: 56 };
  const GAP = 2; // 쌓인 칸 사이 바탕색 틈
  const won = (n) => L.formatMoney(n, 'KRW');

  let months = 12;
  let showTable = false;

  function svg(tag, attrs = {}, ...children) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
    for (const c of children.flat()) if (c) node.append(c);
    return node;
  }

  /** 달별 원화 금액 [{ key, label, isCurrent, subscription, one_time, cloud, total }] */
  function buildData() {
    const { getRecords, getCloud, isCovered } = D();
    const cloud = getCloud();
    const usdKrw = cloud.meta.usdKrw;
    const view = D().cloudView(); // 로컬 달과 UTC 달이 다를 때 이번 달 값을 빼는 처리까지 같은 것
    return H.monthlyHistory(getRecords(), Date.now(), { months, isCovered }).map((m) => {
      // 이번 달 서버·API는 이번 달 화면과 같은 월말 예상값을 쓴다
      const cloudKRW = m.isCurrent && view.accounts.length ? view.total.projected : H.cloudMonthKRW(cloud.history, m.key, usdKrw).krw;
      const row = {
        key: m.key, label: m.label, isCurrent: m.isCurrent,
        subscription: L.krwTotal(m.subscription, usdKrw).krw,
        one_time: L.krwTotal(m.one_time, usdKrw).krw,
        cloud: cloudKRW,
      };
      return { ...row, total: row.subscription + row.one_time + row.cloud };
    });
  }

  // 0부터 시작하는 보기 좋은 눈금(1·2·5 단위)
  function niceMax(max) {
    if (max <= 0) return { top: 10000, step: 5000 };
    const rough = max / 4;
    const mag = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= rough);
    return { top: Math.ceil(max / step) * step, step };
  }

  const shortWon = (n) => (n >= 1e8 ? `${+(n / 1e8).toFixed(1)}억` : n >= 1e4 ? `${+(n / 1e4).toFixed(n >= 1e5 ? 0 : 1)}만` : n.toLocaleString('ko-KR'));

  function barPath(x, y, w, h, roundTop) {
    if (h <= 0) return '';
    const r = Math.min(4, w / 2, h);
    if (!roundTop) return `M${x},${y}h${w}v${h}h${-w}Z`;
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function axis(width, scaleY, top, step) {
    const ticks = [];
    for (let v = 0; v <= top; v += step) ticks.push(v);
    return ticks.map((v) => svg('g', { class: 'tick' },
      svg('line', { x1: PAD.left, x2: width - PAD.right, y1: scaleY(v), y2: scaleY(v), class: v === 0 ? 'baseline' : 'grid' }),
      svg('text', { x: PAD.left - 8, y: scaleY(v), 'text-anchor': 'end', 'dominant-baseline': 'middle' }, shortWon(v))));
  }

  function stackOf(d, x, w, scaleY) {
    const parts = SERIES.filter((s) => d[s.key] > 0);
    let base = 0;
    return parts.map((s, i) => {
      const y0 = scaleY(base);
      const y1 = scaleY(base + d[s.key]);
      base += d[s.key];
      const isTop = i === parts.length - 1;
      const h = Math.max(0, y0 - y1 - (i > 0 ? GAP : 0));
      return svg('path', { d: barPath(x, y1, w, h, isTop), fill: s.color, class: d.isCurrent ? 'is-forecast' : null });
    });
  }

  function tipText(d) {
    const lines = SERIES.filter((s) => d[s.key] > 0).map((s) => `${s.label} ${won(d[s.key])}`);
    return `${d.label}${d.isCurrent ? ' (예정 포함)' : ''} · 합계 ${won(d.total)}${lines.length ? ` — ${lines.join(', ')}` : ''}`;
  }

  function showTip(d, x) {
    const tip = $('trend-tip');
    tip.replaceChildren(
      el('b', {}, `${d.label}${d.isCurrent ? ' · 예정 포함' : ''}`),
      el('span', { class: 'tip-total' }, won(d.total)),
      ...SERIES.filter((s) => d[s.key] > 0).map((s) => el('span', { class: 'tip-row', style: `--dot: ${s.color}` }, s.label, el('b', {}, won(d[s.key])))));
    tip.hidden = false;
    const box = $('trend-chart').getBoundingClientRect();
    const left = Math.min(Math.max(x - tip.offsetWidth / 2, 0), box.width - tip.offsetWidth);
    tip.style.transform = `translate(${left}px, 0)`;
  }

  function drawChart(data) {
    const host = $('trend-chart');
    const width = Math.max(320, host.clientWidth || 720);
    const { top, step } = niceMax(Math.max(...data.map((d) => d.total)));
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const scaleY = (v) => PAD.top + plotH - (v / top) * plotH;
    const band = (width - PAD.left - PAD.right) / data.length;
    const barW = Math.min(44, band * 0.58);
    const maxI = data.reduce((best, d, i) => (d.total > data[best].total ? i : best), 0);

    const bars = data.map((d, i) => {
      const x = PAD.left + band * i + (band - barW) / 2;
      const labelled = d.total > 0 && (i === maxI || d.isCurrent);
      return svg('g', { class: 'bar', tabindex: '0', role: 'listitem', 'aria-label': tipText(d), 'data-key': d.key },
        svg('rect', { x: PAD.left + band * i, y: PAD.top, width: band, height: plotH, class: 'hit' }),
        stackOf(d, x, barW, scaleY),
        labelled && svg('text', { x: x + barW / 2, y: scaleY(d.total) - 8, 'text-anchor': 'middle', class: 'value' }, shortWon(d.total)),
        svg('text', { x: x + barW / 2, y: HEIGHT - 8, 'text-anchor': 'middle', class: d.isCurrent ? 'month current' : 'month' }, d.label));
    });

    const chart = svg('svg', { viewBox: `0 0 ${width} ${HEIGHT}`, width, height: HEIGHT, role: 'group', 'aria-label': `달마다 나간 돈 막대 그래프, ${data.length}개월. 막대마다 금액을 읽을 수 있고, 표로 보기도 있어요.` },
      axis(width, scaleY, top, step),
      svg('g', { role: 'list' }, bars));
    host.replaceChildren(chart);
    for (const g of host.querySelectorAll('.bar')) {
      const d = data.find((x) => x.key === g.dataset.key);
      const center = () => g.getBoundingClientRect().left - host.getBoundingClientRect().left + g.getBoundingClientRect().width / 2;
      g.addEventListener('pointerenter', () => showTip(d, center()));
      g.addEventListener('focus', () => showTip(d, center()));
      g.addEventListener('pointerleave', () => { $('trend-tip').hidden = true; });
      g.addEventListener('blur', () => { $('trend-tip').hidden = true; });
    }
  }

  function drawTable(data) {
    const head = el('tr', {}, el('th', {}, '달'), ...SERIES.map((s) => el('th', { class: 'num' }, s.label)), el('th', { class: 'num' }, '합계'));
    const rows = data.map((d) => el('tr', {},
      el('td', {}, d.isCurrent ? `${d.label} (예정 포함)` : d.label),
      ...SERIES.map((s) => el('td', { class: 'num' }, won(d[s.key]))),
      el('td', { class: 'num' }, el('b', {}, won(d.total)))));
    $('trend-table').replaceChildren(el('table', {}, el('thead', {}, head), el('tbody', {}, ...rows)));
  }

  function renderStats(data) {
    const done = data.filter((d) => !d.isCurrent);
    const sum = data.reduce((acc, d) => acc + d.total, 0);
    const avg = done.length ? Math.round(done.reduce((acc, d) => acc + d.total, 0) / done.length) : 0;
    const peak = data.reduce((best, d) => (d.total > best.total ? d : best), data[0]);
    const current = data[data.length - 1];
    const vsAvg = avg ? current.total - avg : 0;
    const stats = [
      [`${months}개월 합계`, won(sum)],
      ['지난달까지 월 평균', won(avg)],
      ['가장 많이 쓴 달', peak.total ? `${peak.label} · ${won(peak.total)}` : '—'],
      ['이번 달은 평균보다', avg ? `${won(Math.abs(vsAvg))} ${vsAvg >= 0 ? '많아요' : '적어요'}` : '—'],
    ];
    $('trend-stats').replaceChildren(...stats.map(([k, v]) => el('div', { class: 'stat' }, el('dt', {}, k), el('dd', {}, v))));
    $('trend-sub').textContent = `${data[0].label} ~ ${current.label} · 원화 환산, 이번 달은 남은 결제일까지 포함`;
  }

  function renderTop() {
    const { getRecords, getCloud, isCovered } = D();
    const top = H.topSites(getRecords(), Date.now(), getCloud().meta.usdKrw, { months, limit: 5, isCovered });
    const max = top.length ? top[0].krw : 0;
    $('top-range').textContent = `· 최근 ${months}개월`;
    $('top-list').replaceChildren(...top.map((t) => el('li', {},
      el('span', { class: 'rank-site' }, t.site),
      el('span', { class: 'rank-bar', 'aria-hidden': 'true' }, el('span', { style: `width: ${max ? Math.max(2, Math.round((t.krw / max) * 100)) : 0}%` })),
      el('span', { class: 'rank-amount' }, won(t.krw)))));
    $('top-empty').hidden = top.length > 0;
  }

  function render() {
    if (!D() || $('page-trends').hidden) return;
    const data = buildData();
    $('trend-tip').hidden = true;
    $('trend-legend').replaceChildren(...SERIES.map((s) => el('li', { style: `--dot: ${s.color}` }, s.label)));
    drawChart(data);
    drawTable(data);
    $('trend-table').hidden = !showTable;
    $('trend-note').textContent = '기록에서 결제일을 다시 계산했어요. 서버·API는 연결한 뒤부터 달마다 쌓여요. 확인 대기 중인 기록은 빠져 있어요.';
    renderStats(data);
    renderTop();
  }

  $('trend-range').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-months]');
    if (!btn) return;
    months = Number(btn.dataset.months);
    for (const b of $('trend-range').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
    render();
  });
  $('trend-table-btn').addEventListener('click', () => {
    showTable = !showTable;
    $('trend-table-btn').setAttribute('aria-pressed', String(showTable));
    $('trend-table-btn').textContent = showTable ? '표 닫기' : '표로 보기';
    $('trend-table').hidden = !showTable;
  });
  document.addEventListener('records-rendered', render);
  document.addEventListener('page-shown', render);
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 120);
  });
  render();
})();
