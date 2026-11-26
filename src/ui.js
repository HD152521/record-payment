/* 대시보드·팝업 공용 DOM 헬퍼. 사이트명 등 외부 값은 textContent로만 넣는다(innerHTML 금지). */
(function (root) {
  'use strict';

  const L = root.PaymentLedger;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child != null && child !== false) node.append(child);
    }
    return node;
  }

  /** 카탈로그 서비스의 로고 아바타. 아이콘은 확장 안의 SVG를 마스크로 칠하고, 없으면 이름 색 글자. 외부 요청 없음. */
  function brandAvatar(item, extraClass = '') {
    const a = root.PaymentCatalog.avatarFor(item);
    const cls = `avatar brand ${a.icon ? 'has-icon' : 'is-letter'} ${extraClass}`.trim();
    if (!a.icon) return el('span', { class: cls, style: `--brand:${a.color}`, 'aria-hidden': 'true' }, a.letter);
    const color = a.isDark ? 'var(--ink)' : a.color;
    return el('span', { class: cls, style: `--brand:${color};--logo:url(../${a.icon})`, 'aria-hidden': 'true' });
  }

  // www. 를 뺀 사이트 이름 첫 글자. 목록에서 줄을 눈으로 빨리 찾게 하는 표시일 뿐이다.
  const siteInitial = (site) => (String(site || '?').replace(/^www\./, '').match(/[\p{L}\p{N}]/u) || ['?'])[0];

  /** 기록의 아바타: 목록에 있는 서비스면 로고, 아니면 유형 색 첫 글자 */
  function recordAvatar(r) {
    const item = root.PaymentCatalog && root.PaymentCatalog.findBySite(r.site);
    return item ? brandAvatar(item, `kind-${r.kind}`) : el('span', { class: `avatar kind-${r.kind}`, 'aria-hidden': 'true' }, siteInitial(r.site));
  }

  /** 화면에 보일 이름: 목록에 있으면 서비스 이름(Netflix), 없으면 사이트 주소 */
  function serviceName(site) {
    const item = root.PaymentCatalog && root.PaymentCatalog.findBySite(site);
    return item ? item.name : site;
  }

  /** 며칠 뒤인지 짧게: 오늘 · 내일 · 4일 뒤 */
  const ddayText = (days) => (days <= 0 ? '오늘' : days === 1 ? '내일' : `${days}일 뒤`);

  function formatTotals(byCurrency) {
    // 0인 통화는 빼고 보여 준다("0원 + $100.00" 대신 "$100.00")
    const entries = Object.entries(byCurrency).filter(([, v]) => v);
    if (!entries.length) return '0원';
    return entries.map(([cur, v]) => L.formatMoney(v, cur)).join(' + ');
  }

  function amountText(r) {
    const money = L.formatMoney(r.amount, r.currency);
    return r.kind === 'subscription' && r.cycle && r.amount != null ? `${money} / ${L.CYCLE_LABEL[r.cycle]}` : money;
  }

  function kindBadge(r) {
    return el('span', { class: `badge kind-${r.kind}` }, L.KIND_LABEL[r.kind] || r.kind);
  }

  const formatDate = (ts) => new Date(ts).toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });

  // 클라우드 연결 결과를 화면용으로 정리한다. 이번 달 값이 아닌(지난달에 받아 둔) 숫자는 합계에서 뺀다.
  function cloudOverview(costs, meta, now = Date.now()) {
    const C = root.PaymentCloudCosts;
    const thisKey = C.billingWindow(now).thisKey;
    const accounts = Object.entries(costs || {})
      .map(([id, entry]) => ({ id, ...entry }))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const current = accounts.filter((a) => a.month === thisKey);
    const usdKrw = meta && meta.usdKrw;
    return {
      accounts,
      usdKrw,
      total: C.totalKRW(current, usdKrw),
      hasUnconverted: current.some((a) => C.toKRW(a.monthToDate, a.currency, usdKrw) == null),
      // 이번 달 값이 들어온 연결만. 실패한 연결은 합계에 없으니 직접 기록을 덮으면 안 된다.
      connected: new Set(current.map((a) => a.provider)),
      lastRefreshAt: meta && meta.lastRefreshAt,
    };
  }

  const formatTime = (ts) => new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // 화면 아래 짧은 알림. alert·confirm 대신 쓴다. 되돌리기 같은 버튼을 하나 붙일 수 있다.
  const TOAST_MS = 5000;
  let toastTimer = null;
  const isOpen = (host) => host.matches(':popover-open');

  // 열린 대화상자(showModal)는 맨 위 층이라 z-index로 못 이긴다. popover로 띄워야 오류 알림이 배경 뒤에 숨지 않는다.
  function toasterHost() {
    let host = document.getElementById('toaster');
    if (!host) {
      host = el('div', { id: 'toaster', class: 'toaster', popover: 'manual', role: 'status', 'aria-live': 'polite' });
      document.body.append(host);
    }
    return host;
  }

  function dismissToast() {
    if (typeof document === 'undefined') return;
    const host = document.getElementById('toaster');
    clearTimeout(toastTimer);
    if (!host) return;
    host.replaceChildren();
    if (isOpen(host)) host.hidePopover();
  }

  function toast(message, { actionLabel = null, onAction = null, isError = false } = {}) {
    if (typeof document === 'undefined') return;
    const host = toasterHost();
    clearTimeout(toastTimer);
    const action = actionLabel && onAction
      ? el('button', { type: 'button', class: 'toast-action', onclick: () => { dismissToast(); onAction(); } }, actionLabel)
      : null;
    host.replaceChildren(el('div', { class: `toast${isError ? ' is-error' : ''}` }, el('span', {}, message), action));
    if (isOpen(host)) host.hidePopover(); // 새로 연 대화상자보다 위로 다시 올린다
    host.showPopover();
    toastTimer = setTimeout(dismissToast, action ? TOAST_MS * 2 : TOAST_MS);
  }

  // "모든 데이터 지우기"를 다른 탭에서 해도, 이 탭의 "되돌리기"가 지운 기록을 되살리지 않게 닫는다.
  if (root.chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && changes.wipedAt) dismissToast();
    });
  }

  // 칩 모양 라디오. form.elements[name]은 하나뿐이면 RadioNodeList가 아니라서 값은 아래 두 함수로만 읽고 쓴다.
  const radioChip = (name, value, label) => el('label', {}, el('input', { type: 'radio', name, value }), el('span', {}, label));
  const radios = (form, name) => [...form.querySelectorAll('input[type="radio"]')].filter((input) => input.name === name);
  const checkedValue = (form, name) => {
    const input = radios(form, name).find((r) => r.checked);
    return input ? input.value : null;
  };
  function checkRadio(form, name, value) {
    radios(form, name).forEach((input) => { input.checked = input.value === String(value); });
  }

  // 실시간 환율을 못 받았을 때 쓰는 참고 환율. 달러 구독이 "0원 + $100.00"처럼 따로 놀지 않게 원화로 합친다.
  const FALLBACK_USD_KRW = 1400;
  const FALLBACK_FX_AS_OF = '2026-11';
  const withFallbackFx = (meta) => (meta && meta.usdKrw ? meta : { ...(meta || {}), usdKrw: FALLBACK_USD_KRW, fxFallback: true });

  root.PaymentUI = { el, brandAvatar, recordAvatar, serviceName, siteInitial, ddayText, formatTotals, amountText, kindBadge, formatDate, formatTime, cloudOverview, toast, dismissToast, radioChip, checkedValue, checkRadio,
    FALLBACK_USD_KRW, FALLBACK_FX_AS_OF, withFallbackFx,
  };
})(globalThis);
