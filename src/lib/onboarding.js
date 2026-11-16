/* 첫 실행 안내: 설치 직후 대시보드를 열고, 홈에 "처음 할 일" 카드를 보여 준다.
   진행 상태(started·dismissed)는 settings.onboarding에 저장한다. */
(function (root) {
  'use strict';

  const STEPS = Object.freeze([
    { id: 'subs', title: '자주 쓰는 구독 골라 담기', hint: '넷플릭스·유튜브 프리미엄처럼 누르기만 하면 돼요.', action: '빠른 추가 열기' },
    { id: 'card', title: '내 카드 등록', hint: '끝 4자리만 저장해요. 카드별로 매달 얼마 나가는지 보여요.', action: '카드 등록하기' },
    { id: 'cloud', title: '서버·API 연결 (선택)', hint: 'AWS·OpenAI 같은 사용료를 매일 가져와요.', action: '연결하러 가기' },
  ]);

  const count = (list) => (Array.isArray(list) ? list.length : 0);

  function steps({ records, cards, cloudCount }) {
    const done = { subs: count(records) > 0, card: count(cards) > 0, cloud: Number(cloudCount) > 0 };
    return STEPS.map((step) => ({ ...step, done: done[step.id] }));
  }

  /** 닫지 않았고, 기록이 없거나 설치로 시작한 안내이면 보인다. */
  function isVisible({ settings, records }) {
    const state = settings.onboarding;
    return !state.dismissed && (state.started || count(records) === 0);
  }

  const dismissed = (settings) => ({ ...settings, onboarding: { ...settings.onboarding, dismissed: true } });

  async function handleInstalled(details, deps, onError = (err) => console.error('[결제 기록장]', err)) {
    if (!details || details.reason !== 'install') return;
    try {
      const current = await deps.loadSettings();
      await deps.saveSettings({ ...current, onboarding: { ...current.onboarding, started: true } });
    } catch (err) {
      onError(err);
    }
    await deps.openDashboard();
  }

  const api = { STEPS, steps, isVisible, dismissed, handleInstalled };
  root.PaymentOnboarding = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
