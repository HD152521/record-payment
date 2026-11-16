/* 기록 병합·요약·CSV. 순수 함수만 두어 background·대시보드·테스트가 함께 쓴다. */
(function (root) {
  'use strict';

  const KIND_RANK = { unknown: 0, card_registered: 1, one_time: 2, subscription: 3 };
  const MONTH_FACTOR = { monthly: 1, yearly: 1 / 12, weekly: 52 / 12 };
  const MAX_EVIDENCE = 8;
  const MAX_CYCLE_STEPS = 2000;
  const UPCOMING_DAYS = 30;
  const SOON_DAYS = 7;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const KIND_LABEL = { subscription: '구독', one_time: '일회성', card_registered: '결제수단 등록', unknown: '미확인' };
  const CYCLE_LABEL = { monthly: '월', yearly: '년', weekly: '주' };

  function createRecord(fields, now = Date.now()) {
    return {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      site: '', kind: 'unknown', cycle: null, amount: null, currency: null,
      card: null, pg: null, trial: false, status: 'active', canceledAt: null, note: '',
      // 자동 감지는 결제 "시도"라 사용자가 확인하기 전까지 합계에 넣지 않는다.
      review: 'pending', userEdited: false, evidence: [], startedAt: now, createdAt: now, updatedAt: now,
      ...fields,
    };
  }

  function mergeEvidence(list, item) {
    if (!item || list.includes(item)) return list;
    return [...list, item].slice(-MAX_EVIDENCE);
  }

  // 사용자가 직접 고친 기록은 감지 결과로 덮어쓰지 않는다.
  function mergeRecord(record, patch, now = Date.now()) {
    if (record.userEdited) return record;
    const next = {
      ...record,
      updatedAt: now,
      evidence: mergeEvidence(record.evidence || [], patch.evidence),
      card: patch.card && patch.card.last4 ? patch.card : record.card,
      pg: record.pg || patch.pg || null,
    };
    if (patch.kind && (KIND_RANK[patch.kind] ?? 0) > (KIND_RANK[record.kind] ?? 0)) next.kind = patch.kind;
    if (patch.amount != null) {
      next.amount = patch.amount;
      next.currency = patch.currency || record.currency || 'KRW';
    }
    if (patch.cycle) next.cycle = patch.cycle;
    if (patch.trial) next.trial = true;
    return next;
  }

  const isActiveSubscription = (r) => r.kind === 'subscription' && r.status === 'active';

  // review가 없던 예전 기록은 사용자가 고친 것만 확인된 것으로 본다.
  function isConfirmed(r) {
    if (r.review === 'confirmed') return true;
    if (r.review === 'pending') return false;
    return r.userEdited === true;
  }

  function markConfirmed(r, now = Date.now()) {
    return { ...r, review: 'confirmed', userEdited: true, updatedAt: now };
  }

  function monthlyEquivalent(r) {
    if (!isActiveSubscription(r) || r.amount == null) return 0;
    return r.amount * (MONTH_FACTOR[r.cycle] ?? 1);
  }

  function addCycles(start, cycle, steps) {
    const d = new Date(start);
    if (cycle === 'weekly') {
      d.setDate(d.getDate() + 7 * steps);
      return d;
    }
    const months = cycle === 'yearly' ? 12 * steps : steps;
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + months);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
    return d;
  }

  /** 결제일(startedAt = 첫 결제일, 체험이면 체험 끝나는 날)부터 주기마다 [from, to) 안에 드는 날짜들. */
  function scheduleDates(r, from, to) {
    const cycle = r.cycle || 'monthly';
    const dates = [];
    for (let k = 0; k < MAX_CYCLE_STEPS; k += 1) {
      const d = addCycles(r.startedAt, cycle, k);
      if (d.getTime() >= to) break;
      if (d.getTime() >= from) dates.push(d);
    }
    return dates;
  }

  const canceledAtOf = (r) => (r.status === 'canceled' ? (r.canceledAt ?? r.updatedAt ?? 0) : Infinity);

  /** 실제로 빠져나가는(나갈) 결제일. 해지했으면 해지한 때까지만. */
  function chargeDates(r, from, to) {
    if (r.kind !== 'subscription') return [];
    return scheduleDates(r, from, Math.min(to, canceledAtOf(r) + 1));
  }

  function nextChargeDate(r, now = Date.now()) {
    if (!isActiveSubscription(r)) return null;
    const cycle = r.cycle || 'monthly';
    for (let k = 0; k < MAX_CYCLE_STEPS; k += 1) {
      const d = addCycles(r.startedAt, cycle, k);
      if (d.getTime() > now) return d;
    }
    return null;
  }

  function sumByCurrency(records, valueOf) {
    return records.reduce((acc, r) => {
      const v = valueOf(r);
      if (!v) return acc;
      const cur = r.currency || 'KRW';
      return { ...acc, [cur]: Math.round(((acc[cur] || 0) + v) * 100) / 100 };
    }, {});
  }

  function monthRange(now) {
    const d = new Date(now);
    return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()];
  }

  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

  function upcomingOf(subs, now) {
    return subs
      .map((record) => ({ record, date: nextChargeDate(record, now) }))
      .filter(({ date }) => date && date.getTime() - now <= UPCOMING_DAYS * DAY_MS)
      .map((u) => ({ ...u, isTrialEnd: Boolean(u.record.trial) && sameDay(u.date, u.record.startedAt) }))
      .sort((a, b) => a.date - b.date);
  }

  const startOfDay = (ts) => {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  /** 오늘부터 며칠 뒤인지(달력 날짜 기준, 오늘 = 0) */
  const daysUntil = (date, now) => Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS);

  /**
   * 이번 달 돈을 나간 돈(오늘까지의 결제일·일회성)과 나갈 돈(남은 결제일·미리 적은 일회성)으로 나눈다.
   * 오늘이 결제일이면 나간 돈으로 본다.
   */
  function splitThisMonth(counted, now) {
    const [from, to] = monthRange(now);
    const cut = Math.min(to, startOfDay(now) + DAY_MS);
    const subs = counted.filter((r) => r.kind === 'subscription');
    const oneTime = counted.filter((r) => r.kind === 'one_time' && r.startedAt >= from && r.startedAt < to);
    const charged = (a, b) => (r) => (r.amount || 0) * chargeDates(r, a, b).length;
    const merge = (x, y) => Object.entries(y).reduce((acc, [cur, v]) => ({ ...acc, [cur]: Math.round(((acc[cur] || 0) + v) * 100) / 100 }), x);
    const paid = merge(sumByCurrency(subs, charged(from, cut)), sumByCurrency(oneTime.filter((r) => r.startedAt < cut), (r) => r.amount));
    const due = merge(sumByCurrency(subs, charged(cut, to)), sumByCurrency(oneTime.filter((r) => r.startedAt >= cut), (r) => r.amount));
    return { paid, due, total: merge(paid, due), oneTime };
  }

  // 해지한 뒤 올해 지나간 결제일만큼 아낀 돈
  function savedThisYear(records, now) {
    const yearStart = new Date(new Date(now).getFullYear(), 0, 1).getTime();
    const canceled = records.filter((r) => r.kind === 'subscription' && r.status === 'canceled');
    return sumByCurrency(canceled, (r) => {
      const from = Math.max(yearStart, canceledAtOf(r) + 1);
      return (r.amount || 0) * scheduleDates(r, from, now + 1).length;
    });
  }

  /**
   * 합계 규칙: 확인된 기록만, 사용료 연결 값에 포함된 기록(isCovered)은 빼고 센다.
   * thisMonth = 이번 달 결제일이 든 구독 + 이번 달 일회성. monthly = 월 평균(연간은 1/12).
   */
  function summarize(records, now = Date.now(), { isCovered = () => false } = {}) {
    const confirmed = records.filter(isConfirmed);
    const counted = confirmed.filter((r) => !isCovered(r));
    const subs = counted.filter(isActiveSubscription);
    const monthly = sumByCurrency(subs, monthlyEquivalent);
    const split = splitThisMonth(counted, now);
    const upcoming = upcomingOf(subs, now);
    const soon = upcoming.filter((u) => daysUntil(u.date, now) <= SOON_DAYS);
    return {
      thisMonth: split.total,
      paidThisMonth: split.paid,
      dueThisMonth: split.due,
      soon: sumByCurrency(soon.map((u) => u.record), (r) => r.amount),
      monthly,
      yearly: Object.fromEntries(Object.entries(monthly).map(([c, v]) => [c, Math.round(v * 12 * 100) / 100])),
      oneTimeThisMonth: sumByCurrency(split.oneTime, (r) => r.amount),
      savedThisYear: savedThisYear(counted, now),
      activeSubscriptions: subs.length,
      cardRegistrations: records.filter((r) => r.kind === 'card_registered').length,
      pending: records.filter((r) => !isConfirmed(r) && (r.kind === 'subscription' || r.kind === 'one_time')),
      covered: confirmed.filter(isCovered),
      upcoming,
    };
  }

  function formatMoney(amount, currency) {
    if (amount == null) return '—';
    if (currency === 'USD') return `$${Number(amount).toFixed(2)}`;
    if (currency && currency !== 'KRW') return `${Number(amount).toLocaleString('ko-KR', { maximumFractionDigits: 2 })} ${currency}`;
    return `${Math.round(amount).toLocaleString('ko-KR')}원`;
  }

  /** 통화별 합계를 원화 하나로. 환율이 없거나 모르는 통화는 unconverted로 남긴다. */
  function krwTotal(byCurrency, usdKrw) {
    return Object.entries(byCurrency || {}).reduce((acc, [cur, v]) => {
      if (cur === 'KRW') return { ...acc, krw: acc.krw + Math.round(v) };
      if (cur === 'USD' && usdKrw) return { ...acc, krw: acc.krw + Math.round(v * usdKrw) };
      return { ...acc, unconverted: { ...acc.unconverted, [cur]: v } };
    }, { krw: 0, unconverted: {} });
  }

  const RECORD_KINDS = ['subscription', 'one_time', 'card_registered', 'unknown'];
  const RECORD_CYCLES = ['monthly', 'yearly', 'weekly'];
  const RECORD_CURRENCIES = ['KRW', 'USD'];
  const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const finiteOr = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  // 결제 페이지 주소의 쿼리·조각에는 세션 토큰·결제 콜백 값이 섞일 수 있어 origin만 남긴다.
  function originOnly(url) {
    try {
      const u = new URL(String(url));
      return /^https?:$/.test(u.protocol) ? u.origin : undefined;
    } catch {
      return undefined;
    }
  }

  /** 대시보드에서 들어온 기록을 저장 전에 모양대로 맞춘다. 화면이 깨지지 않게 타입·길이를 고정한다. */
  function sanitizeRecord(input) {
    const r = input && typeof input === 'object' ? input : {};
    const site = text(r.site, 120);
    if (typeof r.id !== 'string' || !r.id || r.id.length > 60) throw new Error('기록 id가 이상해요.');
    if (!site) throw new Error('사이트를 넣어 주세요.');
    const now = Date.now();
    const amount = Number.isFinite(r.amount) && r.amount >= 0 && r.amount < 1e10 ? r.amount : null;
    const card = r.card && typeof r.card === 'object' && /^\d{4}$/.test(r.card.last4)
      ? { brand: text(r.card.brand, MAX_CARD_BRAND) || '카드', last4: r.card.last4 } : null;
    return {
      ...createRecord({}, now),
      id: r.id,
      site,
      siteUrl: originOnly(text(r.siteUrl, 500)),
      kind: RECORD_KINDS.includes(r.kind) ? r.kind : 'unknown',
      cycle: RECORD_CYCLES.includes(r.cycle) ? r.cycle : null,
      amount,
      currency: RECORD_CURRENCIES.includes(r.currency) ? r.currency : 'KRW',
      card,
      pg: text(r.pg, 40) || null,
      trial: r.trial === true,
      status: r.status === 'canceled' ? 'canceled' : 'active',
      canceledAt: r.status === 'canceled' ? finiteOr(r.canceledAt, finiteOr(r.updatedAt, now)) : null,
      note: text(r.note, 200),
      review: isConfirmed(r) ? 'confirmed' : 'pending',
      userEdited: r.userEdited === true,
      evidence: Array.isArray(r.evidence) ? r.evidence.filter((e) => typeof e === 'string').map((e) => e.slice(0, 120)).slice(-MAX_EVIDENCE) : [],
      startedAt: finiteOr(r.startedAt, now),
      createdAt: finiteOr(r.createdAt, now),
      updatedAt: finiteOr(r.updatedAt, now),
    };
  }

  const MAX_CARD_LABEL = 30;
  const MAX_CARD_BRAND = 20;

  /** 사용자가 등록하는 "내 카드". 카드번호 전체는 받지 않고 끝 4자리만 둔다. */
  function normalizeCard(input, now = Date.now()) {
    const last4 = String((input && input.last4) || '').trim();
    if (!/^\d{4}$/.test(last4)) throw new Error('카드 끝 4자리 숫자를 넣어 주세요.');
    const brand = String((input && input.brand) || '').trim().slice(0, MAX_CARD_BRAND) || '카드';
    const label = String((input && input.label) || '').trim().slice(0, MAX_CARD_LABEL) || `${brand} ····${last4}`;
    // id·등록일은 받지 않고 여기서 만든다. 같은 끝 4자리면 upsertCard가 기존 id를 이어 쓴다.
    return { id: `card-${now.toString(36)}-${last4}`, label, brand, last4, createdAt: now, isDefaultLabel: !String((input && input.label) || '').trim() };
  }

  // 같은 끝 4자리는 한 장으로 본다. 기존 카드의 id·등록일은 유지한다.
  function upsertCard(cards, card) {
    const existing = cards.find((c) => c.last4 === card.last4);
    const { isDefaultLabel, ...fresh } = card;
    if (!existing) return [...cards, fresh];
    // 끝 4자리만 넣은 저장(편집기의 "새 카드")이 사용자가 지은 별명·종류를 지우지 않게 한다.
    const keepNames = isDefaultLabel ? { label: existing.label, brand: existing.brand } : {};
    return cards.map((c) => (c === existing ? { ...fresh, ...keepNames, id: existing.id, createdAt: existing.createdAt } : c));
  }

  /** 카드별로 사용 중인 구독 수와 월 환산 금액. 등록 안 했지만 기록에 나온 카드도 보여 준다. */
  function cardSummary(records, cards) {
    const used = records.filter((r) => isActiveSubscription(r) && isConfirmed(r) && r.card && r.card.last4);
    const seen = used
      .map((r) => r.card)
      .filter((card, i, list) => list.findIndex((c) => c.last4 === card.last4) === i)
      .filter((card) => !cards.some((c) => c.last4 === card.last4))
      .map((card) => ({ label: `${card.brand || '카드'} ····${card.last4}`, brand: card.brand || '카드', last4: card.last4, registered: false }));
    return [...cards.map((c) => ({ ...c, registered: true })), ...seen].map((card) => {
      const mine = used.filter((r) => r.card.last4 === card.last4);
      return { ...card, count: mine.length, monthly: sumByCurrency(mine, monthlyEquivalent) };
    });
  }

  function csvCell(value) {
    const s = value == null ? '' : String(value);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  }

  function toCsv(records) {
    const header = ['사이트', '유형', '주기', '금액', '통화', '카드', '결제대행', '상태', '시작일', '메모'];
    const rows = records.map((r) => [
      r.site, KIND_LABEL[r.kind] || r.kind, CYCLE_LABEL[r.cycle] || '', r.amount, r.currency,
      r.card ? `${r.card.brand} ${r.card.last4}` : '', r.pg, r.status === 'active' ? '사용중' : '해지',
      new Date(r.startedAt).toISOString().slice(0, 10), r.note,
    ]);
    return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  }

  const api = {
    KIND_LABEL, CYCLE_LABEL, createRecord, mergeRecord, monthlyEquivalent,
    nextChargeDate, summarize, formatMoney, isConfirmed, markConfirmed, toCsv, krwTotal, sanitizeRecord, normalizeCard, upsertCard, cardSummary,
    chargeDates, monthRange, isActiveSubscription, originOnly, daysUntil, SOON_DAYS,
  };
  root.PaymentLedger = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
