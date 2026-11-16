/* 사용자 설정: 월 예산과 결제 알림. 저장된 값은 믿지 않고 늘 범위를 다시 확인한다. */
(function (root) {
  'use strict';

  const KEY = 'settings';
  const MAX_BUDGET = 10_000_000_000;
  const MAX_DAYS_BEFORE = 7;
  const WARN_RATIO = 0.8;
  const DEFAULT_SETTINGS = Object.freeze({
    budgetKRW: null,
    remind: Object.freeze({ enabled: false, daysBefore: 1 }),
    onboarding: Object.freeze({ started: false, dismissed: false }),
  });

  function normalizeSettings(input) {
    const s = input && typeof input === 'object' ? input : {};
    const budget = Math.round(Number(s.budgetKRW));
    const remind = s.remind && typeof s.remind === 'object' ? s.remind : {};
    const days = Number(remind.daysBefore);
    const onboarding = s.onboarding && typeof s.onboarding === 'object' ? s.onboarding : {};
    return {
      budgetKRW: s.budgetKRW != null && s.budgetKRW !== '' && budget > 0 && budget <= MAX_BUDGET ? budget : null,
      remind: {
        enabled: remind.enabled === true,
        daysBefore: Number.isInteger(days) && days >= 0 && days <= MAX_DAYS_BEFORE ? days : DEFAULT_SETTINGS.remind.daysBefore,
      },
      onboarding: { started: onboarding.started === true, dismissed: onboarding.dismissed === true },
    };
  }

  /** 이번 달 쓴 돈과 예산 → { ratio, level: ok|warn|over, left }. 예산이 없으면 null. */
  function budgetState(spentKRW, budgetKRW) {
    if (!budgetKRW) return null;
    const ratio = Math.round((spentKRW / budgetKRW) * 100) / 100;
    const level = ratio > 1 ? 'over' : ratio >= WARN_RATIO ? 'warn' : 'ok';
    return { ratio, level, left: budgetKRW - spentKRW };
  }

  async function loadSettings() {
    const stored = await chrome.storage.local.get(KEY);
    return normalizeSettings(stored[KEY]);
  }

  const saveSettings = (settings) => chrome.storage.local.set({ [KEY]: normalizeSettings(settings) });

  const api = { KEY, DEFAULT_SETTINGS, MAX_DAYS_BEFORE, normalizeSettings, budgetState, loadSettings, saveSettings };
  root.PaymentSettings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
