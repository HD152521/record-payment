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

  // 얇은 띠에 들어가는 짧은 이름. 자세한 설명은 마우스를 올리면 보인다.
  const SHORT = { subs: '구독 담기', card: '카드 등록', cloud: '서버·API 연결 (선택)' };

  function stepItem(step, index, isNext) {
    const mark = el('i', { 'aria-hidden': 'true' }, step.done ? '✓' : String(index + 1));
    const cls = [step.done && 'is-done', isNext && 'is-next'].filter(Boolean).join(' ') || null;
    return el('li', { class: cls, 'data-step': step.id, title: step.hint },
      step.done
        ? el('span', { class: 'step' }, mark, SHORT[step.id], el('span', { class: 'sr-only' }, ' 끝냈어요'))
        : el('button', { type: 'button', class: 'step', onclick: ACTIONS[step.id], 'aria-label': `${step.title} — ${step.action}` }, mark, SHORT[step.id]));
  }

  function render() {
    const dash = globalThis.PaymentDashboard;
    const records = dash.getRecords();
    const visible = O.isVisible({ settings: dash.getSettings(), records });
    $('onboarding').hidden = !visible;
    if (!visible) return;
    const list = O.steps({ records, cards, cloudCount: dash.cloudView().accounts.length });
    const done = list.filter((s) => s.done).length;
    const next = list.findIndex((s) => !s.done);
    $('onboarding-steps').replaceChildren(...list.map((step, i) => stepItem(step, i, i === next)));
    $('onboarding-prog').style.width = `${Math.round((done / list.length) * 100)}%`;
    $('onboarding-count').textContent = `${done}/${list.length}`;
    $('onboarding-dismiss').textContent = done === list.length ? '끝내기' : '다음에';
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
