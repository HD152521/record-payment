/* 홈의 첫 실행 안내 카드: 구독 담기 → 카드 등록 → 서버·API 연결. 끝낸 단계는 체크된다. */
(() => {
  'use strict';

  const { el } = globalThis.PaymentUI;
  const O = globalThis.PaymentOnboarding;
  const ST = globalThis.PaymentSettings;
  const S = globalThis.PaymentStore;
  const $ = (id) => document.getElementById(id);

  let cards = [];

  const ACTIONS = {
    subs: () => $('add-btn').click(),
    card: () => $('card-add').click(),
    cloud: () => globalThis.PaymentRouter.go('cloud'),
  };

  function stepItem(step, index) {
    return el('li', { class: step.done ? 'is-done' : null, 'data-step': step.id },
      el('span', { class: 'step-mark', 'aria-hidden': 'true' }, step.done ? '✓' : String(index + 1)),
      el('div', { class: 'step-text' },
        el('b', {}, step.title),
        el('span', { class: 'muted' }, step.hint)),
      step.done
        ? el('span', { class: 'step-state' }, '끝냈어요')
        : el('button', { type: 'button', class: 'btn small', onclick: ACTIONS[step.id] }, step.action));
  }

  function render() {
    const dash = globalThis.PaymentDashboard;
    const records = dash.getRecords();
    const visible = O.isVisible({ settings: dash.getSettings(), records });
    $('onboarding').hidden = !visible;
    if (!visible) return;
    const list = O.steps({ records, cards, cloudCount: dash.cloudView().accounts.length });
    $('onboarding-steps').replaceChildren(...list.map(stepItem));
    $('onboarding-dismiss').textContent = list.every((s) => s.done) ? '끝내기' : '다음에 하기';
  }

  async function dismiss() {
    await ST.saveSettings(O.dismissed(await ST.loadSettings()));
  }

  $('onboarding-dismiss').addEventListener('click', () => {
    dismiss().catch((err) => console.error('[결제 기록장] 안내 닫기', err));
  });
  S.onCardsChanged((next) => { cards = next; render(); });
  S.loadCards().then((loaded) => { cards = loaded; render(); })
    .catch((err) => console.error('[결제 기록장] 안내', err));
  document.addEventListener('records-rendered', render);
})();
