/* background 전용. 결제 알림: 매일 아침 9시(그리고 브라우저를 켤 때) 곧 결제될 구독을 알림으로 띄운다.
   설정에서 켠 사람에게만. 같은 결제일은 한 번만 알린다(remindersSent). */
(function (root) {
  'use strict';

  const ALARM = 'payment-reminders';
  const SENT_KEY = 'remindersSent';
  const HOUR = 9;
  const DAY_MINUTES = 24 * 60;
  const NOTIFY_PREFIX = 'pay-remind:';
  const MAX_PER_RUN = 5; // 한꺼번에 알림이 쏟아지지 않게. 남은 건 다음 확인 때

  function nextNine(now = new Date()) {
    const next = new Date(now);
    next.setHours(HOUR, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  async function ensureAlarm() {
    if (!(await chrome.alarms.get(ALARM))) chrome.alarms.create(ALARM, { when: nextNine(), periodInMinutes: DAY_MINUTES });
  }

  const notify = (reminder) => chrome.notifications.create(`${NOTIFY_PREFIX}${reminder.key}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: reminder.title,
    message: reminder.message,
    priority: 0,
  });

  // 시작·알람·설정 변경이 겹쳐도 한 번에 하나씩(보낸 기록을 서로 덮지 않게)
  let running = Promise.resolve();
  function checkReminders(now = Date.now()) {
    const run = running.then(() => checkOnce(now));
    running = run.catch(() => {});
    return run;
  }

  async function checkOnce(now) {
    const settings = await root.PaymentSettings.loadSettings();
    if (!settings.remind.enabled) return { ok: true, sent: 0 };
    const stored = await chrome.storage.local.get(SENT_KEY);
    const sent = root.PaymentReminders.pruneSent(stored[SENT_KEY], now);
    const due = root.PaymentReminders.dueReminders(await root.PaymentStore.loadRecords(), now, { daysBefore: settings.remind.daysBefore, sent });
    const batch = due.slice(0, MAX_PER_RUN);
    const results = await Promise.allSettled(batch.map(notify));
    const delivered = batch.filter((_, i) => results[i].status === 'fulfilled');
    await chrome.storage.local.set({ [SENT_KEY]: { ...sent, ...Object.fromEntries(delivered.map((d) => [d.key, now])) } });
    return { ok: true, sent: delivered.length };
  }

  // 설정 화면의 "알림 미리 보기": 알림이 실제로 뜨는지(운영체제가 막지 않는지) 확인용
  async function sendTest() {
    await notify({ key: `test-${Date.now()}`, title: '내일 결제돼요', message: '예시) netflix.com 13,500원 — 알림이 이렇게 떠요.' });
    return { ok: true };
  }

  const run = () => checkReminders().catch((err) => console.error('[결제 기록장] 결제 알림', err));

  function install() {
    chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); });
    chrome.runtime.onStartup.addListener(() => { ensureAlarm(); run(); });
    chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) run(); });
    chrome.notifications.onClicked.addListener((id) => {
      if (!id.startsWith(NOTIFY_PREFIX)) return;
      chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard.html#home') });
      chrome.notifications.clear(id);
    });
  }

  root.PaymentReminderService = { install, checkReminders, ensureAlarm, sendTest };
})(globalThis);
