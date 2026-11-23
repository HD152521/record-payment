/* 카드 이용내역 CSV에서 매달·매년 반복되는 결제(구독 후보)를 찾는다. 순수 함수만 둔다(파일·저장소·네트워크 접근 없음).
   양식(열 이름)은 카드사가 공개한 일반적인 내려받기 형태를 가정한 것이다. 실제 파일과 다르면 열 고르기로 받는다. */
(function (root) {
  'use strict';

  const L = root.PaymentLedger || (typeof require === 'function' ? require('./ledger.js') : null);
  const K = root.PaymentCatalog || (typeof require === 'function' ? require('./catalog.js') : null);

  const MAX_ROWS = 20000;
  const MAX_IMPORT = 50; // background upsertMany 한 번 한도와 같다
  const HEADER_SCAN_ROWS = 20;
  const AMOUNT_TOLERANCE = 0.1;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const CYCLE_GAP_DAYS = { monthly: [25, 35], yearly: [350, 380] };
  const MAX_TEXT = 120;

  // 가정한 카드사 양식. 머리말 줄의 열 이름(공백·괄호 안 글자 뺀 것)이 전부 있으면 그 카드사로 본다.
  const FORMATS = [
    { id: 'shinhan', name: '신한카드', date: '이용일자', merchant: '이용가맹점', amount: '이용금액', card: '카드번호' },
    { id: 'samsung', name: '삼성카드', date: '승인일자', merchant: '가맹점명', amount: '승인금액', card: '카드번호' },
    { id: 'hyundai', name: '현대카드', date: '이용일', merchant: '이용가맹점', amount: '이용금액', card: '이용카드' },
    { id: 'kb', name: 'KB국민카드', date: '이용일', merchant: '이용하신곳', amount: '이용금액', card: '카드번호' },
  ];

  // ── 읽기 ────────────────────────────────────────────────
  /** 바이트를 글자로. UTF-8이 아니면 CP949(EUC-KR)로 읽는다. */
  function decodeBuffer(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('euc-kr').decode(bytes);
    }
  }

  function detectDelimiter(text) {
    const head = text.split('\n').slice(0, 5).join('\n');
    const count = (ch) => head.split(ch).length - 1;
    return count('\t') > count(',') ? '\t' : ',';
  }

  /** 따옴표·줄바꿈을 지키는 CSV(또는 탭) 읽기 → 문자열 배열의 배열 */
  function parseCsv(input) {
    if (typeof input !== 'string' || !input) return [];
    const text = input.replace(/^﻿/, '');
    const delim = detectDelimiter(text);
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const endCell = () => { row.push(cell.trim()); cell = ''; };
    const endRow = () => {
      endCell();
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    };
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quoted) {
        if (ch !== '"') cell += ch;
        else if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === delim) endCell();
      else if (ch === '\n') endRow();
      else if (ch !== '\r') cell += ch;
    }
    endRow();
    return rows;
  }

  function parseDate(raw) {
    const s = String(raw == null ? '' : raw).trim();
    const m = s.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/) || s.match(/^(\d{4})(\d{2})(\d{2})/)
      || s.match(/^(\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
    if (!m) return null;
    const year = m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const d = new Date(year, month - 1, day);
    const valid = year >= 2000 && year <= 2100 && d.getMonth() === month - 1 && d.getDate() === day;
    return valid ? d.getTime() : null;
  }

  function parseAmount(raw) {
    const s = String(raw == null ? '' : raw).replace(/[,\s원₩]/g, '');
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
  }

  const last4Of = (raw) => {
    const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
    return digits.length >= 4 ? digits.slice(-4) : null;
  };

  // ── 양식 인식·열 ─────────────────────────────────────────
  const headerKey = (s) => String(s).replace(/\(.*?\)/g, '').replace(/\s+/g, '');

  function findHeaderIndex(rows, accept) {
    return rows.slice(0, HEADER_SCAN_ROWS).findIndex((row) => accept(row));
  }

  function matchFormat(row) {
    const keys = row.map(headerKey);
    return FORMATS.find((f) => [f.date, f.merchant, f.amount].every((name) => keys.includes(name))) || null;
  }

  function columnsOf(format, headerRow) {
    const keys = headerRow.map(headerKey);
    const at = (name) => keys.indexOf(name);
    return { date: at(format.date), merchant: at(format.merchant), amount: at(format.amount), card: at(format.card) };
  }

  // 모르는 양식의 머리말: 칸이 3개 이상이고 날짜로 읽히는 칸이 없는 첫 줄
  function guessHeaderIndex(rows) {
    return findHeaderIndex(rows, (row) => row.filter(Boolean).length >= 3 && row.every((c) => parseDate(c) == null));
  }

  function checkColumns(columns, width) {
    const picked = [columns.date, columns.merchant, columns.amount];
    const valid = picked.every((i) => Number.isInteger(i) && i >= 0 && i < width);
    const hasCard = Number.isInteger(columns.card) && columns.card >= 0 && columns.card < width;
    if (!valid || new Set(picked).size !== 3) throw new Error('날짜·가맹점·금액 열을 서로 다른 열로 골라 주세요.');
    return { ...columns, card: hasCard ? columns.card : null };
  }

  /** 줄들을 거래로. 날짜·가맹점·금액이 읽히고 금액이 양수인 줄만 남긴다(취소·환불은 뺀다). */
  function readTransactions(rows, columns) {
    const txns = [];
    let skipped = 0;
    for (const row of rows) {
      const ts = parseDate(row[columns.date]);
      const amount = parseAmount(row[columns.amount]);
      const merchant = String(row[columns.merchant] || '').trim().slice(0, MAX_TEXT);
      if (ts == null || amount == null || !merchant) { skipped += 1; continue; }
      if (amount <= 0 || merchant.includes('취소')) { skipped += 1; continue; }
      txns.push({ ts, merchant, amount, last4: columns.card == null ? null : last4Of(row[columns.card]) });
    }
    return { txns, skipped };
  }

  // ── 가맹점 이름 맞추기 ────────────────────────────────────
  const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
  const normMerchant = (s) => String(s || '').toLowerCase().replace(/[^a-z가-힣]/g, '');
  // 일반 쇼핑·포털 이름은 구독으로 보지 않는다(와우·네이버플러스는 전체 이름으로만 맞춘다).
  const STOP_TERMS = new Set(['쿠팡', 'wow', '네이버', 'naver', 'amazon', '아마존', 'google', 'apple', 'microsoft', 'office', '오피스', 'domain', '도메인']);
  const MIN_LATIN = 4;
  const MIN_SHORT_LATIN = 3;

  function siteLabel(site) {
    const parts = String(site || '').split('.');
    return parts.length >= 2 ? parts[parts.length - 2] : '';
  }

  function termsOf(item) {
    const raw = [item.name.replace(/\(.*?\)/g, ''), item.id, siteLabel(item.site), ...(item.aliases || [])];
    return [...new Set(raw.map(squash))].filter((t) => t.length >= 2 && !STOP_TERMS.has(t));
  }

  let termIndex = null;
  const termList = () => {
    if (!termIndex) termIndex = K.ITEMS.flatMap((item) => termsOf(item).map((term) => ({ term, item })));
    return termIndex;
  };

  function termHits(term, flat, tokens) {
    if (/[가-힣]/.test(term)) return flat.includes(term);
    if (term.length >= MIN_LATIN) return flat.includes(term);
    return term.length >= MIN_SHORT_LATIN && tokens.includes(term);
  }

  /** 카드 명세서의 가맹점 이름 → 카탈로그 서비스(가장 긴 이름이 맞는 것). 없으면 null */
  function matchService(merchant) {
    const flat = squash(merchant);
    const tokens = String(merchant || '').toLowerCase().split(/[^a-z0-9가-힣]+/).filter(Boolean);
    const hits = termList().filter(({ term }) => termHits(term, flat, tokens));
    if (!hits.length) return null;
    return hits.reduce((best, h) => (h.term.length > best.term.length ? h : best)).item;
  }

  // ── 반복 결제 찾기 ───────────────────────────────────────
  const median = (nums) => {
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  function cycleOf(sortedTxns) {
    const gaps = sortedTxns.slice(1).map((t, i) => (t.ts - sortedTxns[i].ts) / DAY_MS);
    const mid = median(gaps);
    const found = Object.entries(CYCLE_GAP_DAYS).find(([, [lo, hi]]) => mid >= lo && mid <= hi);
    return found ? found[0] : null;
  }

  function candidateOf(key, group) {
    const sorted = [...group].sort((a, b) => a.ts - b.ts);
    const latest = sorted[sorted.length - 1];
    const similar = sorted.filter((t) => Math.abs(t.amount - latest.amount) <= latest.amount * AMOUNT_TOLERANCE + 1e-9);
    if (similar.length < 2) return null;
    const cycle = cycleOf(similar);
    if (!cycle) return null;
    const item = key.startsWith('cat:') ? K.ITEMS.find((i) => i.id === key.slice(4)) : null;
    const withCard = [...similar].reverse().find((t) => t.last4);
    return {
      key, itemId: item ? item.id : null, site: item ? item.site : latest.merchant, merchant: latest.merchant,
      cycle, amount: Math.round(latest.amount), last4: withCard ? withCard.last4 : null, startedAt: latest.ts, count: similar.length,
    };
  }

  function groupKey(txn) {
    const item = matchService(txn.merchant);
    return item ? `cat:${item.id}` : `m:${normMerchant(txn.merchant)}`;
  }

  /** 거래들에서 같은 곳이 비슷한 금액(±10%)으로 매달·매년 2번 이상 나온 것 → 후보(많이 반복된 순) */
  function findRecurring(txns) {
    const groups = txns.reduce((acc, t) => {
      const key = groupKey(t);
      return key === 'm:' ? acc : { ...acc, [key]: [...(acc[key] || []), t] };
    }, {});
    return Object.entries(groups)
      .map(([key, group]) => candidateOf(key, group))
      .filter(Boolean)
      .sort((a, b) => b.count - a.count || a.site.localeCompare(b.site));
  }

  // ── 전체 분석 ────────────────────────────────────────────
  /** 텍스트 → { format, headers, transactions, candidates, skippedRows }. 열을 못 정하면 format null(열 고르기 필요). */
  function analyze(text, manualColumns = null) {
    const rows = parseCsv(text);
    if (rows.length > MAX_ROWS) throw new Error('파일이 너무 커요. 기간을 줄여서 다시 받아 주세요.');
    const empty = { format: null, headers: [], transactions: [], candidates: [], skippedRows: 0 };
    const formatIndex = findHeaderIndex(rows, matchFormat);
    const headerIndex = formatIndex >= 0 ? formatIndex : guessHeaderIndex(rows);
    if (headerIndex < 0) return empty;
    const headerRow = rows[headerIndex];
    const format = formatIndex >= 0 ? matchFormat(headerRow) : null;
    if (!format && !manualColumns) return { ...empty, headers: headerRow };
    const columns = checkColumns(manualColumns || columnsOf(format, headerRow), headerRow.length);
    const { txns, skipped } = readTransactions(rows.slice(headerIndex + 1), columns);
    return {
      format: format ? { id: format.id, name: format.name } : null,
      headers: headerRow, transactions: txns, candidates: findRecurring(txns), skippedRows: skipped,
    };
  }

  // ── 기록 만들기 ──────────────────────────────────────────
  function recordKey(record) {
    const item = K.findBySite(record.site);
    return item ? `cat:${item.id}` : `m:${normMerchant(record.site)}`;
  }

  function cardFor(last4, cards) {
    if (!last4) return null;
    const mine = cards.find((c) => c.last4 === last4);
    return { brand: (mine && mine.brand) || '카드', last4 };
  }

  /** 후보 → 확인할 기록(pending). 이미 있는(해지 안 한) 같은 서비스는 빼고, 한 번에 MAX_IMPORT개까지만 만든다. */
  function buildRecords(candidates, { existing = [], cards = [], now = Date.now() } = {}) {
    const have = new Set(existing.filter((r) => r.status !== 'canceled').map(recordKey));
    const fresh = candidates.filter((c) => !have.has(c.key));
    const picked = fresh.slice(0, MAX_IMPORT);
    const records = picked.map((c, i) => L.createRecord({
      site: c.site, kind: 'subscription', cycle: c.cycle, amount: c.amount, currency: 'KRW',
      card: cardFor(c.last4, cards), note: String(c.merchant || '').slice(0, 200),
      evidence: [`카드 이용내역에서 ${c.count}번 반복`], startedAt: c.startedAt,
    }, now + i));
    return { records, skippedExisting: candidates.length - fresh.length, overLimit: fresh.length - picked.length };
  }

  const api = { MAX_ROWS, MAX_IMPORT, FORMATS, decodeBuffer, parseCsv, parseDate, parseAmount, matchService, findRecurring, analyze, buildRecords };
  root.PaymentStatement = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
