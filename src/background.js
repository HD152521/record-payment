/* 탭별로 결제 흐름을 추적해 하나의 기록으로 합친다.
   결제창 팝업(새 탭)은 원래 탭에 묶어서 "어느 사이트에서 등록했는지"를 유지한다. */
importScripts(
  'lib/detect.js', 'lib/ledger.js', 'lib/store.js',
  'lib/cloud/config.js', 'lib/cloud/costs.js', 'lib/cloud/sigv4.js',
  'lib/cloud/aws.js', 'lib/cloud/azure.js', 'lib/cloud/openai.js',
  'lib/cloud/cloudflare.js', 'lib/cloud/github.js', 'lib/cloud/vercel.js', 'lib/cloud/service.js',
);

const { pgFromHost, isPaymentIntermediary, hostOf } = PaymentTracker;
const { createRecord, mergeRecord, normalizeCard, upsertCard, sanitizeRecord } = PaymentLedger;
const { loadRecords, saveRecords, loadCards, saveCards } = PaymentStore;

const MERGE_WINDOW_MS = 30 * 60 * 1000;
const BADGE_MS = 4000;
const MAX_ACTION_TEXT = 40;
const KINDS = new Set(['subscription', 'one_time', 'card_registered', 'unknown']);
const CYCLES = new Set(['monthly', 'yearly', 'weekly']);
const CURRENCIES = new Set(['KRW', 'USD']);
const MAX_AMOUNT = 1e10;

// 이벤트 핸들러가 동시에 storage를 읽고 쓰지 않도록 한 줄로 세운다.
let queue = Promise.resolve();
function serialize(task) {
  const run = queue.then(task);
  queue = run.catch((err) => console.error('[결제 기록장]', err));
  return run;
}

const tabKey = (id) => `tab:${id}`;

async function getTab(id) {
  const stored = await chrome.storage.session.get(tabKey(id));
  return stored[tabKey(id)] || {};
}

async function setTab(id, patch) {
  const next = { ...(await getTab(id)), ...patch };
  await chrome.storage.session.set({ [tabKey(id)]: next });
  return next;
}

async function tabContext(tabId) {
  const state = await getTab(tabId);
  const rootId = state.rootTabId ?? tabId;
  const rootState = rootId === tabId ? state : await getTab(rootId);
  return { rootId, rootState };
}

function sanitizeCard(card) {
  if (!card || typeof card !== 'object' || !/^\d{4}$/.test(card.last4)) return null;
  return { brand: typeof card.brand === 'string' ? card.brand.slice(0, 20) : '카드', last4: card.last4 };
}

function sanitizeAnalysis(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const validAmount = Number.isFinite(a.amount) && a.amount > 0 && a.amount < MAX_AMOUNT && CURRENCIES.has(a.currency);
  return {
    kind: KINDS.has(a.kind) ? a.kind : 'unknown',
    cycle: CYCLES.has(a.cycle) ? a.cycle : null,
    amount: validAmount ? a.amount : null,
    currency: validAmount ? a.currency : null,
    trial: a.trial === true,
    isPaymentContext: a.isPaymentContext === true,
    isStrongAction: a.isStrongAction === true,
  };
}

function findActiveRecord(records, rootState, site, now) {
  const fresh = (r) => now - r.updatedAt < MERGE_WINDOW_MS;
  return records.find((r) => r.id === rootState.recordId && fresh(r))
    || records.find((r) => r.site === site && fresh(r) && !r.userEdited);
}

function resolveSite(tab, rootId, rootState) {
  const topHost = hostOf(tab.url);
  const isPopupOrPg = rootId !== tab.id || isPaymentIntermediary(topHost);
  return (isPopupOrPg && rootState.lastSite) || topHost;
}

// 배지는 부가 표시일 뿐이라, 그 사이 탭이 닫혀 실패해도 기록에는 영향이 없다.
function flashBadge(tabId) {
  const ignoreClosedTab = () => {};
  chrome.action.setBadgeBackgroundColor({ color: '#2f3e9e', tabId }).catch(ignoreClosedTab);
  chrome.action.setBadgeText({ text: '✓', tabId }).catch(ignoreClosedTab);
  setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }).catch(ignoreClosedTab), BADGE_MS);
}

// 카드 입력·PG 진입 같은 단서는 기록이 있으면 붙이고, 없으면 탭에 보류해 뒀다가 결제 클릭 때 합친다.
async function attachEvidence(rootId, rootState, site, patch) {
  const records = await loadRecords();
  const now = Date.now();
  const existing = site && findActiveRecord(records, rootState, site, now);
  if (existing) {
    const merged = mergeRecord(existing, patch, now);
    await saveRecords(records.map((r) => (r.id === merged.id ? merged : r)));
    return;
  }
  const pending = rootState.pending || {};
  await setTab(rootId, {
    pending: {
      pg: pending.pg || patch.pg || null,
      card: patch.card || pending.card || null,
      hasCardField: Boolean(pending.hasCardField || patch.hasCardField),
    },
  });
}

async function recordIntent(tab, rootId, rootState, site, msg) {
  const analysis = sanitizeAnalysis(msg.analysis);
  const card = sanitizeCard(msg.card);
  const pending = rootState.pending || {};
  const action = typeof msg.action === 'string' ? msg.action.slice(0, MAX_ACTION_TEXT) : '';
  // "구독" 버튼 글자만으로는 부족하다(유튜브 구독 등). 카드 입력이 있거나, 금액/결제수단 등록 문구가 함께 있어야 한다.
  // PG iframe은 Stripe처럼 모든 페이지에 숨어 있을 수 있어서 단독으로는 인정하지 않는다.
  const hasCardSignal = Boolean(card || msg.hasCardField === true || pending.card || pending.hasCardField);
  const hasStrongSignal = analysis.amount != null || analysis.kind === 'card_registered';
  const qualifies = hasCardSignal
    || ((analysis.isStrongAction || pending.pg) && analysis.isPaymentContext && hasStrongSignal);

  const records = await loadRecords();
  const now = Date.now();
  const existing = findActiveRecord(records, rootState, site, now);
  if (!existing && !qualifies) return;

  const patch = {
    kind: analysis.kind === 'unknown' && (card || msg.hasCardField) ? 'card_registered' : analysis.kind,
    cycle: analysis.cycle,
    amount: analysis.amount,
    currency: analysis.currency,
    trial: analysis.trial,
    card: card || pending.card || null,
    pg: pending.pg || null,
    evidence: action ? `"${action}" 클릭` : null,
  };
  const merged = mergeRecord(existing || createRecord({ site, siteUrl: tab.url }, now), patch, now);
  const next = existing ? records.map((r) => (r.id === merged.id ? merged : r)) : [merged, ...records];
  await saveRecords(next);
  await setTab(rootId, { recordId: merged.id, pending: null });
  flashBadge(tab.id);
}

async function handleContentMessage(msg, tab) {
  const { rootId, rootState } = await tabContext(tab.id);
  const site = resolveSite(tab, rootId, rootState);
  if (!site) return;
  if (msg.type === 'card') {
    await attachEvidence(rootId, rootState, site, {
      card: sanitizeCard(msg.card),
      hasCardField: msg.hasCardField === true,
      evidence: '카드 입력 감지',
    });
  } else if (msg.type === 'intent') {
    await recordIntent(tab, rootId, rootState, site, msg);
  }
}

async function handleCardMessage(msg) {
  const cards = await loadCards();
  if (msg.type === 'cards:save') {
    await saveCards(upsertCard(cards, normalizeCard(msg.card)));
  } else if (msg.type === 'cards:delete' && typeof msg.id === 'string') {
    await saveCards(cards.filter((c) => c.id !== msg.id));
  } else {
    throw new Error(`알 수 없는 요청: ${msg.type}`);
  }
  return { ok: true };
}

// 대시보드의 수정·삭제도 같은 큐를 거쳐야 감지 기록과 서로 덮어쓰지 않는다.
async function handleDashboardMessage(msg) {
  if (msg.type.startsWith('cards:')) return handleCardMessage(msg);
  const records = await loadRecords();
  if (msg.type === 'upsert' && msg.record && typeof msg.record.id === 'string') {
    const record = sanitizeRecord(msg.record);
    const exists = records.some((r) => r.id === record.id);
    await saveRecords(exists ? records.map((r) => (r.id === record.id ? record : r)) : [record, ...records]);
  } else if (msg.type === 'delete' && typeof msg.id === 'string') {
    await saveRecords(records.filter((r) => r.id !== msg.id));
  } else {
    throw new Error(`알 수 없는 요청: ${msg.type}`);
  }
  return { ok: true };
}

const EXTENSION_ORIGIN = chrome.runtime.getURL('');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return undefined;
  const fromExtensionPage = sender.origin === EXTENSION_ORIGIN.replace(/\/$/, '');
  if (fromExtensionPage && msg.type.startsWith('cloud:')) {
    PaymentCloudService.handleMessage(msg)
      .then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (fromExtensionPage) {
    serialize(() => handleDashboardMessage(msg))
      .then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (sender.tab) serialize(() => handleContentMessage(msg, sender.tab));
  return undefined;
});

// 새 탭은 일단 여는 쪽 탭을 기억만 해 둔다. 결제창(PG·카드사)으로 열렸을 때만 원래 탭에 묶는다.
chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId }) => {
  serialize(async () => {
    const source = await getTab(sourceTabId);
    await setTab(tabId, { openerTabId: source.rootTabId ?? sourceTabId });
  });
});

async function linkTopFrame(tabId, host) {
  const state = await getTab(tabId);
  const linkedRoot = isPaymentIntermediary(host) ? (state.rootTabId ?? state.openerTabId ?? null) : null;
  if (linkedRoot !== (state.rootTabId ?? null)) await setTab(tabId, { rootTabId: linkedRoot });
}

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  const host = hostOf(url);
  if (!host || tabId < 0) return;
  serialize(async () => {
    if (frameId === 0) await linkTopFrame(tabId, host);
    const { rootId, rootState } = await tabContext(tabId);
    const pg = pgFromHost(host);
    if (pg) {
      await attachEvidence(rootId, rootState, rootState.lastSite, { pg, evidence: `${pg} 결제창 진입` });
      return;
    }
    if (frameId !== 0 || rootId !== tabId || isPaymentIntermediary(host)) return;
    const changedSite = host !== rootState.lastSite;
    await setTab(tabId, changedSite ? { lastSite: host, pending: null, recordId: null } : { lastSite: host });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(tabKey(tabId)).catch((err) => console.error('[결제 기록장]', err));
});

PaymentCloudService.install();
