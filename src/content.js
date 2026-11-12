/* 모든 페이지·iframe에서 돈다. 카드 입력칸과 결제 버튼 클릭만 감지하고,
   페이지 원문은 밖으로 보내지 않는다. 판별 결과와 카드 끝 4자리만 background로 넘긴다. */
(() => {
  'use strict';

  const PT = globalThis.PaymentTracker;
  if (!PT || globalThis.__paymentTrackerLoaded) return;
  globalThis.__paymentTrackerLoaded = true;

  const CARD_HINT_RE = /(card.?(no|num)|cc.?(num|no)|카드\s?번호|cardnumber)/i;
  const ACTION_RE = /(결제|구독|구매|주문|등록|저장|신청|시작|확인|다음|업그레이드|pay|subscribe|purchase|buy|order|checkout|save|add|confirm|continue|start|complete|upgrade)/i;
  const ACTION_SELECTOR = 'button, [role="button"], input[type="submit"], input[type="button"], a';
  const MAX_ACTION_TEXT = 60;
  const CARD_DEBOUNCE_MS = 400;

  function hintOf(el) {
    return [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('autocomplete')]
      .filter(Boolean)
      .join(' ');
  }

  function isCardField(el) {
    if (!(el instanceof HTMLInputElement)) return false;
    return /^cc-number/.test(el.autocomplete || '') || CARD_HINT_RE.test(hintOf(el));
  }

  // 4칸으로 나뉜 카드번호 입력도 이어 붙여서 읽는다. 보안 키패드는 값이 암호화돼 있어 card=null.
  function readCard() {
    const fields = Array.from(document.querySelectorAll('input')).filter(isCardField);
    if (!fields.length) return { hasCardField: false, card: null };
    return { hasCardField: true, card: PT.cardInfo(fields.map((f) => f.value).join('')) };
  }

  function send(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {
        // 확장프로그램을 다시 불러온 직후 남아 있는 옛 스크립트는 연결이 끊겨 있다. 보낼 곳이 없으니 무시.
      });
    } catch {
      // 위와 같은 이유(context invalidated)로 동기 예외가 날 수 있다.
    }
  }

  let cardTimer = null;
  function onCardInput(event) {
    if (!isCardField(event.target)) return;
    clearTimeout(cardTimer);
    cardTimer = setTimeout(() => {
      const { card, hasCardField } = readCard();
      send({ type: 'card', card, hasCardField });
    }, CARD_DEBOUNCE_MS);
  }

  function actionTextOf(target) {
    const el = target instanceof Element ? target.closest(ACTION_SELECTOR) : null;
    if (!el) return null;
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, MAX_ACTION_TEXT);
    return text && ACTION_RE.test(text) ? text : null;
  }

  function reportIntent(actionText) {
    const pageText = document.body ? document.body.innerText : '';
    const analysis = PT.analyzeText(pageText, actionText);
    const { card, hasCardField } = readCard();
    if (!analysis.isPaymentContext && !hasCardField) return;
    send({ type: 'intent', analysis, card, hasCardField, action: actionText });
  }

  document.addEventListener('change', onCardInput, true);
  document.addEventListener('focusout', onCardInput, true);
  document.addEventListener('click', (event) => {
    const text = actionTextOf(event.target);
    if (text) reportIntent(text);
  }, true);
  document.addEventListener('submit', (event) => {
    reportIntent((event.submitter && actionTextOf(event.submitter)) || '제출');
  }, true);
})();
