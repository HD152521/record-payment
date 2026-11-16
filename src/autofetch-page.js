/* 토큰 자동 받기: background가 "연결 버튼으로 연 탭"의 서비스 콘솔 페이지에만 주입한다(평소엔 어디에도 없다).
   완료 화면에 토큰이 딱 하나 보이면 그 값만 background로 한 번 보내고 멈춘다. 버튼은 누르지 않는다.
   토큰은 로그·오류 문장에 넣지 않는다. */
(() => {
  'use strict';

  if (globalThis.PaymentAutofetchPage) return;
  const A = globalThis.PaymentAutofetch;
  const WATCH_MS = 15 * 60 * 1000;
  const DEBOUNCE_MS = 300;
  // 입력칸 값은 바뀌어도 DOM 변경이 안 잡혀서 가끔 다시 본다.
  const POLL_MS = 2000;
  const MAX_TEXT = 200000;
  const COPY_ATTRS = ['data-clipboard-text', 'data-copy-text', 'value'];

  function collect() {
    const values = [...document.querySelectorAll('textarea, input:not([type=password]):not([type=hidden])')].map((el) => el.value);
    const code = [...document.querySelectorAll('code, pre, kbd, samp')].map((el) => el.textContent);
    const copies = [...document.querySelectorAll('[data-clipboard-text], [data-copy-text], clipboard-copy[value]')]
      .map((el) => COPY_ATTRS.map((a) => el.getAttribute(a)).find(Boolean) || '');
    const text = document.body ? document.body.innerText.slice(0, MAX_TEXT) : '';
    return { fields: [...values, ...code, ...copies], texts: [text] };
  }

  let started = false;

  function start(provider) {
    if (started) return; // 같은 문서에 두 번 주입돼도 한 번만 본다
    started = true;
    let timer = null;
    const stop = () => {
      observer.disconnect();
      clearInterval(poll);
      clearTimeout(timer);
      clearTimeout(expire);
    };
    const scan = () => {
      const credentials = A.extractCredentials(provider, collect());
      if (!credentials) return;
      stop();
      chrome.runtime.sendMessage({ type: 'autofetch:token', credentials })
        .catch(() => console.error('[결제 기록장] 자동으로 받은 토큰을 넘기지 못했어요.'));
    };
    const later = () => { clearTimeout(timer); timer = setTimeout(scan, DEBOUNCE_MS); };
    const observer = new MutationObserver(later);
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    const poll = setInterval(scan, POLL_MS);
    const expire = setTimeout(stop, WATCH_MS);
    scan();
  }

  globalThis.PaymentAutofetchPage = { start };
})();
