/* chrome.storage.local 에 기록 배열을 저장한다. 모든 데이터는 이 브라우저 안에만 남는다. */
(function (root) {
  'use strict';

  const KEY = 'records';
  const CARDS_KEY = 'cards';

  async function loadRecords() {
    const stored = await chrome.storage.local.get(KEY);
    return Array.isArray(stored[KEY]) ? stored[KEY] : [];
  }

  async function saveRecords(records) {
    await chrome.storage.local.set({ [KEY]: records });
  }

  // 확장 페이지(대시보드)에서 쓰는 쓰기 요청. background 큐를 거쳐야 자동 감지 기록과 충돌하지 않는다.
  async function requestWrite(message) {
    const res = await chrome.runtime.sendMessage(message);
    if (!res || !res.ok) throw new Error((res && res.error) || '저장 요청 실패');
  }

  const upsertRecord = (record) => requestWrite({ type: 'upsert', record });
  const deleteRecord = (id) => requestWrite({ type: 'delete', id });
  const upsertRecords = (records) => requestWrite({ type: 'upsertMany', records });
  const deleteRecords = (ids) => requestWrite({ type: 'deleteMany', ids });

  async function loadCards() {
    const stored = await chrome.storage.local.get(CARDS_KEY);
    return Array.isArray(stored[CARDS_KEY]) ? stored[CARDS_KEY] : [];
  }

  async function saveCards(cards) {
    await chrome.storage.local.set({ [CARDS_KEY]: cards });
  }

  const saveCard = (card) => requestWrite({ type: 'cards:save', card });
  const removeCard = (id) => requestWrite({ type: 'cards:delete', id });

  function onCardsChanged(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[CARDS_KEY]) callback(changes[CARDS_KEY].newValue || []);
    });
  }

  function onRecordsChanged(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) callback(changes[KEY].newValue || []);
    });
  }

  root.PaymentStore = {
    KEY, CARDS_KEY, loadRecords, saveRecords, upsertRecord, deleteRecord, upsertRecords, deleteRecords, onRecordsChanged,
    loadCards, saveCards, saveCard, removeCard, onCardsChanged,
  };
})(globalThis);
