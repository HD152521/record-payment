/* 구독 계정 페이지(Netflix·YouTube Premium·Spotify·Claude·GitHub의 결제 화면)에서만 돈다.
   그 밖의 사이트에서는 첫 줄 검사에서 바로 끝나서 페이지 글을 읽지 않는다.
   요금제·가격·다음 결제일을 읽으면 background에 물어보고(이미 기록했는지·거절한 지 30일이 안 됐는지),
   작은 안내를 Shadow DOM 안에 띄운다. 저장은 background 메시지로만 한다. */
(() => {
  'use strict';

  const AR = globalThis.PaymentAccountReader;
  if (!AR || window.top !== window || globalThis.__paymentTrackerAccountLoaded) return;
  const site = AR.siteFor(location.hostname, location.pathname);
  if (!site) return;
  globalThis.__paymentTrackerAccountLoaded = true;

  const RETRY_MS = 1500;
  const MAX_TRIES = 6;
  const DONE_VISIBLE_MS = 3000;
  const CYCLE_LABEL = { monthly: '월', yearly: '연' };

  // 페이지 CSP가 인라인 <style>을 막아도 되게 CSSStyleSheet로 넣는다. 값은 src/theme.css 토큰과 같다.
  const CSS = `
    :host { all: initial; }
    .card { box-sizing: border-box; width: 280px; padding: 14px; border-radius: 12px; background: #fff; color: #191f28;
      border: 1px solid #e5e8eb; box-shadow: 0 2px 6px rgb(17 24 39 / 0.06), 0 24px 48px -20px rgb(17 24 39 / 0.3);
      font: 13px/1.5 "Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif; }
    .title { margin: 0 0 4px; font-size: 13px; font-weight: 700; }
    .detail { margin: 0; color: #4e5968; font-size: 12px; overflow-wrap: anywhere; }
    .row { display: flex; gap: 6px; margin-top: 10px; }
    button { font: inherit; font-size: 12px; padding: 6px 10px; border-radius: 6px; cursor: pointer; border: 1px solid #d1d6db; background: #fff; color: #191f28; }
    button.primary { background: #3a6df0; border-color: #3a6df0; color: #fff; }
    button:focus-visible { outline: 2px solid #3a6df0; outline-offset: 2px; }
    @media (prefers-color-scheme: dark) {
      .card { background: #1c1e22; color: #f2f4f6; border-color: #33363c; }
      .detail { color: #b0b8c1; }
      button { background: #26292e; border-color: #3a3d44; color: #f2f4f6; }
      button.primary { background: #3a6df0; border-color: #3a6df0; color: #fff; }
    }`;

  function ask(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message).then(resolve, () => resolve(null));
      } catch {
        resolve(null); // 확장프로그램을 다시 불러온 직후의 옛 스크립트
      }
    });
  }

  const money = (offer) => (offer.currency === 'USD' ? `$${offer.amount}` : `${offer.amount.toLocaleString('ko-KR')}원`);

  function detailLines(offer) {
    const head = [site.name, offer.plan].filter(Boolean).join(' · ');
    const next = offer.nextChargeAt ? new Date(offer.nextChargeAt) : null;
    const when = next ? ` · 다음 결제 ${next.getMonth() + 1}월 ${next.getDate()}일` : '';
    return [head, `${CYCLE_LABEL[offer.cycle] || '월'} ${money(offer)}${when}`];
  }

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text; // 페이지에서 읽은 글은 textContent로만 넣는다
    if (className) node.className = className;
    return node;
  }

  function mountPrompt() {
    const host = document.createElement('div');
    const style = { position: 'fixed', right: '16px', bottom: '16px', 'z-index': '2147483647' };
    Object.entries(style).forEach(([k, v]) => host.style.setProperty(k, v, 'important'));
    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
    const card = el('div', '', 'card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', '결제 기록장');
    shadow.appendChild(card);
    document.documentElement.appendChild(host);
    return { host, card };
  }

  function render(card, children) {
    card.replaceChildren(...children);
  }

  function showResult(ui, text) {
    render(ui.card, [el('p', text, 'title')]);
    setTimeout(() => ui.host.remove(), DONE_VISIBLE_MS);
  }

  async function onAdd(ui, offer) {
    const res = await ask({ type: 'account:add', offer });
    showResult(ui, res && res.ok ? '확인할 기록에 넣었어요.' : '저장하지 못했어요. 나중에 다시 시도해 주세요.');
  }

  async function onDismiss(ui, offer) {
    ui.host.remove();
    await ask({ type: 'account:dismiss', offer });
  }

  function showPrompt(offer) {
    const ui = mountPrompt();
    const [head, price] = detailLines(offer);
    const add = el('button', '추가하기', 'primary');
    const no = el('button', '괜찮아요');
    add.type = 'button';
    no.type = 'button';
    add.addEventListener('click', () => onAdd(ui, offer));
    no.addEventListener('click', () => onDismiss(ui, offer));
    no.title = '이 사이트는 30일 동안 다시 묻지 않아요';
    const row = el('div', '', 'row');
    row.append(add, no);
    render(ui.card, [el('p', '결제 기록장에 추가할까요?', 'title'), el('p', head, 'detail'), el('p', price, 'detail'), row]);
  }

  async function offerIfNew(offer) {
    const res = await ask({ type: 'account:check', offer });
    if (res && res.show === true) showPrompt(offer);
  }

  // 화면이 늦게 그려지는 사이트가 있어서 몇 번 다시 읽어 본다. 끝까지 못 읽으면 조용히 넘어간다.
  function tryRead(attempt) {
    const text = document.body ? document.body.innerText : '';
    const offer = AR.parseAccountPage(site.id, text, Date.now());
    if (offer) {
      offerIfNew(offer);
    } else if (attempt < MAX_TRIES) {
      setTimeout(() => tryRead(attempt + 1), RETRY_MS);
    }
  }

  tryRead(1);
})();
