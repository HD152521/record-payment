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

  root.PaymentUI = { el, formatTotals, amountText, kindBadge, formatDate, formatTime, cloudOverview, toast, dismissToast, radioChip, checkedValue, checkRadio,
    FALLBACK_USD_KRW, FALLBACK_FX_AS_OF, withFallbackFx,
  };
})(globalThis);
