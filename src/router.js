/* 화면 나누기: 주소의 #이름으로 한 화면만 보여 준다. 화면마다 큰 기능 하나(이번 달 합계, 달마다 그래프, 기록 표 …). */
(() => {
  'use strict';

  const PAGES = ['home', 'trends', 'records', 'cloud', 'cards', 'settings'];
  const TITLES = { home: '이번 달', trends: '달마다', records: '기록', cloud: '서버·API', cards: '카드', settings: '설정' };
  // 예전 주소(#subscription 같은 필터)로 들어와도 기록 화면을 보여 준다.
  const LEGACY = { subscription: 'records', one_time: 'records', card_registered: 'records', unknown: 'records', all: 'records' };

  const current = () => {
    const name = location.hash.slice(1);
    return PAGES.includes(name) ? name : LEGACY[name] || 'home';
  };

  function show() {
    const page = current();
    for (const section of document.querySelectorAll('.page')) section.hidden = section.dataset.page !== page;
    for (const link of document.querySelectorAll('#tabs a')) {
      if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    document.title = `${TITLES[page]} · 결제 기록장`;
    document.dispatchEvent(new CustomEvent('page-shown', { detail: { page } }));
  }

  window.addEventListener('hashchange', () => {
    show();
    window.scrollTo({ top: 0 });
  });
  show();

  globalThis.PaymentRouter = { current, go: (page) => { location.hash = page; } };
})();
