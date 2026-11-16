/* 백업·복원(JSON). 기록·카드·설정만 담는다. 사용료 연결 키는 파일로 새면 안 돼서 넣지 않는다.
   가져올 때는 파일을 믿지 않고 기록·카드를 하나씩 다시 검사한다. */
(function (root) {
  'use strict';

  const L = root.PaymentLedger || (typeof require === 'function' ? require('./ledger.js') : null);
  const ST = root.PaymentSettings || (typeof require === 'function' ? require('./settings.js') : null);
  const APP = 'payment-tracker';
  const VERSION = 1;
  const MAX_RECORDS = 5000;
  const MAX_CARDS = 100;
  const MAX_BYTES = 5_000_000;

  function buildBackup({ records = [], cards = [], settings = {} }, now = Date.now()) {
    return JSON.stringify({
      app: APP, version: VERSION, exportedAt: new Date(now).toISOString(),
      records: tryEach(records, L.sanitizeRecord).ok, cards, settings: ST.normalizeSettings(settings),
    }, null, 2);
  }

  const SKIP = Symbol('skip');
  function tryEach(list, fn) {
    const results = list.map((item) => {
      try {
        return fn(item);
      } catch {
        return SKIP;
      }
    });
    const ok = results.filter((x) => x !== SKIP);
    return { ok, skipped: results.length - ok.length };
  }

  function readJson(text) {
    if (typeof text !== 'string' || text.length > MAX_BYTES) throw new Error('백업 파일이 너무 커요.');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('백업 파일을 읽지 못했어요. 결제 기록장에서 내보낸 .json 파일인지 확인해 주세요.');
    }
  }

  /** → { records, cards, settings, skipped } */
  function parseBackup(text) {
    const data = readJson(text);
    if (!data || data.app !== APP) throw new Error('결제 기록장 백업 파일이 아니에요.');
    const records = Array.isArray(data.records) ? data.records : [];
    const cards = Array.isArray(data.cards) ? data.cards : [];
    if (records.length > MAX_RECORDS || cards.length > MAX_CARDS) throw new Error('기록이 너무 많아서 가져올 수 없어요.');
    const r = tryEach(records, L.sanitizeRecord);
    const c = tryEach(cards, (card) => ({ ...L.normalizeCard(card), ...(typeof card.createdAt === 'number' ? { createdAt: card.createdAt } : {}) }));
    return { records: r.ok, cards: c.ok, settings: ST.normalizeSettings(data.settings), skipped: r.skipped + c.skipped };
  }

  /** 같은 id는 가져온 값으로 바꾸고, 새 id는 앞에 붙인다. 파일 안에 같은 id가 여럿이면 마지막 것만. 합쳐서 너무 많으면 거절. */
  function mergeById(existing, incoming) {
    const byId = new Map(incoming.map((x) => [x.id, x]));
    const known = new Set(existing.map((x) => x.id));
    const merged = [...[...byId.values()].filter((x) => !known.has(x.id)), ...existing.map((x) => byId.get(x.id) || x)];
    if (merged.length > MAX_RECORDS) throw new Error(`합치면 기록이 ${MAX_RECORDS}개를 넘어서 가져올 수 없어요.`);
    return merged;
  }

  const api = { MAX_RECORDS, buildBackup, parseBackup, mergeById };
  root.PaymentBackup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
