/* 설정 화면의 "크롬 동기화" 칸. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STATE_KEY = globalThis.PaymentSync.STATE_KEY;

  function render(status) {
    $('sync-enabled').checked = status.enabled;
    $('sync-now').hidden = !status.enabled;
    const when = status.lastSyncAt ? `마지막 동기화 ${new Date(status.lastSyncAt).toLocaleString('ko-KR')}` : '';
    $('sync-status').textContent = status.error || (status.enabled ? when : '');
    $('sync-status').classList.toggle('error', Boolean(status.error));
  }

  async function send(type) {
    const res = await chrome.runtime.sendMessage({ type });
    if (!res || !res.ok) throw new Error((res && res.error) || '요청을 처리하지 못했어요.');
    render(res.status);
  }

  async function request(type) {
    $('sync-enabled').disabled = true;
    $('sync-now').disabled = true;
    try {
      await send(type);
    } catch (err) {
      console.error('[결제 기록장] 동기화', err);
      await send('sync:status').catch(() => {});
      $('sync-status').textContent = '동기화하지 못했어요. 잠시 뒤 다시 시도해 주세요.';
      $('sync-status').classList.add('error');
    } finally {
      $('sync-enabled').disabled = false;
      $('sync-now').disabled = false;
    }
  }

  $('sync-enabled').addEventListener('change', (e) => request(e.target.checked ? 'sync:enable' : 'sync:disable'));
  $('sync-now').addEventListener('click', () => request('sync:run'));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STATE_KEY]) return;
    send('sync:status').catch((err) => console.error('[결제 기록장] 동기화', err));
  });
  send('sync:status').catch((err) => console.error('[결제 기록장] 동기화', err));
})();
