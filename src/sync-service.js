/* 동기화를 언제 돌릴지 정한다. 실행은 background의 쓰기 큐를 거쳐 감지 기록과 서로 덮어쓰지 않는다. */
(function (root) {
  'use strict';

  const WATCHED = ['records', 'cards', 'settings'];
  // 결제 감지는 한 기록을 연달아 고친다. 잠깐 모아서 올려 sync 쓰기 횟수 제한을 피한다.
  const DEBOUNCE_MS = 3000;
  const RETRY_ALARM = 'sync-retry';
  const RETRY_MINUTES = 5;

  function createSyncService({ serialize }) {
    const sync = PaymentSync.createSync({ local: chrome.storage.local, remote: chrome.storage.sync });
    const report = (err) => console.error('[결제 기록장] 동기화', err);
    let timer = null;

    // 올리지 못했으면 저장소가 다시 바뀌지 않아도 잠시 뒤 한 번 더 해 본다.
    async function runAndRetry() {
      const status = await sync.run();
      if (status.enabled && status.error) await chrome.alarms.create(RETRY_ALARM, { delayInMinutes: RETRY_MINUTES });
    }

    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => serialize(runAndRetry).catch(report), DEBOUNCE_MS);
    }

    async function handleMessage(msg) {
      const actions = { 'sync:enable': sync.enable, 'sync:disable': sync.disable, 'sync:run': sync.run, 'sync:status': sync.status };
      if (!Object.hasOwn(actions, msg.type)) throw new Error(`알 수 없는 요청: ${msg.type}`);
      return { ok: true, status: await actions[msg.type]() };
    }

    function install() {
      // content script는 동기화 저장소를 읽지 못하게 막는다.
      chrome.storage.sync.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(report);
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' || (area === 'local' && WATCHED.some((key) => changes[key]))) schedule();
      });
      chrome.runtime.onStartup.addListener(schedule);
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === RETRY_ALARM) serialize(runAndRetry).catch(report);
      });
    }

    return { install, handleMessage, wipeRemote: sync.wipeRemote };
  }

  root.PaymentSyncService = { createSyncService };
})(globalThis);
