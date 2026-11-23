/* 탭별로 결제 흐름을 추적해 하나의 기록으로 합친다.
   결제창 팝업(새 탭)은 원래 탭에 묶어서 "어느 사이트에서 등록했는지"를 유지한다. */
importScripts(
  'lib/detect.js', 'lib/account-reader.js', 'lib/ledger.js', 'lib/account-offer.js', 'lib/store.js', 'lib/history.js', 'lib/settings.js', 'lib/reminders.js', 'lib/backup.js', 'lib/onboarding.js',
  'lib/cloud/config.js', 'lib/cloud/costs.js', 'lib/cloud/sigv4.js',
  'lib/cloud/aws.js', 'lib/cloud/azure.js', 'lib/cloud/openai.js',
  'lib/cloud/cloudflare.js', 'lib/cloud/github.js', 'lib/cloud/vercel.js', 'lib/cloud/service.js',
  'lib/cloud/autofetch.js', 'lib/cloud/autofetch-watch.js', 'reminder-service.js',
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
  const merged = mergeRecord(existing || createRecord({ site, siteUrl: PaymentLedger.originOnly(tab.url) }, now), patch, now);
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

const DISMISS_KEY = 'accountDismissed';

// 계정 페이지 안내: 읽은 값은 다시 검사하고, 저장은 여기서만 한다(content script는 저장소에 접근하지 않는다).
async function handleAccountMessage(msg, tab, senderUrl) {
  const offer = PaymentAccountOffer.sanitizeOffer(msg.offer, senderUrl || tab.url);
  if (!offer) return { ok: false };
  const records = await loadRecords();
  const dismissed = (await chrome.storage.local.get(DISMISS_KEY))[DISMISS_KEY] || {};
  const now = Date.now();
  const decision = PaymentAccountOffer.decideOffer(offer, records, dismissed, now);
  if (msg.type === 'account:check') return { ok: true, show: decision.show };
  if (msg.type === 'account:dismiss') {
    await chrome.storage.local.set({ [DISMISS_KEY]: { ...dismissed, [offer.siteId]: now } });
    return { ok: true };
  }
  if (msg.type !== 'account:add') return { ok: false };
  if (decision.reason === 'exists') return { ok: true, duplicate: true };
  await saveRecords([PaymentAccountOffer.buildRecord(offer, now, senderUrl || tab.url), ...records]);
  flashBadge(tab.id);
  return { ok: true };
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

// 백업 가져오기: 파일 내용은 여기서 다시 검사한다. 같은 id 기록·같은 끝 4자리 카드는 가져온 값으로 바꾼다.
async function importBackup(text) {
  const parsed = PaymentBackup.parseBackup(text);
  await saveRecords(PaymentBackup.mergeById(await loadRecords(), parsed.records));
  await saveCards(parsed.cards.reduce(upsertCard, await loadCards()));
  await PaymentSettings.saveSettings(parsed.settings);
  return { ok: true, records: parsed.records.length, cards: parsed.cards.length, skipped: parsed.skipped };
}

const MAX_BATCH_WRITE = 50;

// 대시보드의 수정·삭제도 같은 큐를 거쳐야 감지 기록과 서로 덮어쓰지 않는다.
async function handleDashboardMessage(msg) {
  if (msg.type.startsWith('cards:')) return handleCardMessage(msg);
  // 모든 데이터 지우기: 기록·카드·연결 키·받아 둔 사용료(local)와 자동 받기 임시값·탭 상태(session)
  if (msg.type === 'wipe') {
    await PaymentCloudService.handleMessage({ type: 'cloud:wipe' });
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    // 열려 있는 다른 대시보드 탭이 "되돌리기" 알림을 닫게 알린다(ui.js).
    await chrome.storage.session.set({ wipedAt: Date.now() });
    return { ok: true };
  }
  if (msg.type === 'import') return importBackup(msg.text);
  // 알림을 켜면 바로 한 번 확인한다(아침 9시까지 기다리지 않게).
  if (msg.type === 'reminders:check') {
    await PaymentReminderService.ensureAlarm();
    return PaymentReminderService.checkReminders();
  }
  if (msg.type === 'reminders:test') return PaymentReminderService.sendTest();
  const records = await loadRecords();
  if (msg.type === 'upsert' && msg.record && typeof msg.record.id === 'string') {
    const record = sanitizeRecord(msg.record);
    const exists = records.some((r) => r.id === record.id);
    await saveRecords(exists ? records.map((r) => (r.id === record.id ? record : r)) : [record, ...records]);
  } else if (msg.type === 'upsertMany' && Array.isArray(msg.records)) {
    // 빠른 추가: 여러 기록을 한 번에 넣는다(되돌리기는 deleteMany). 하나라도 잘못되면 통째로 거절한다.
    if (msg.records.length > MAX_BATCH_WRITE) throw new Error(`한 번에 ${MAX_BATCH_WRITE}개까지 저장할 수 있어요.`);
    if (!msg.records.every((r) => r && typeof r.id === 'string')) throw new Error('기록 형식이 맞지 않아요.');
    const incoming = msg.records.map(sanitizeRecord);
    const ids = new Set(incoming.map((r) => r.id));
    await saveRecords([...incoming, ...records.filter((r) => !ids.has(r.id))]);
  } else if (msg.type === 'deleteMany' && Array.isArray(msg.ids)) {
    if (msg.ids.length > MAX_BATCH_WRITE) throw new Error(`한 번에 ${MAX_BATCH_WRITE}개까지 지울 수 있어요.`);
    const ids = new Set(msg.ids.filter((id) => typeof id === 'string'));
    await saveRecords(records.filter((r) => !ids.has(r.id)));
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
  if (fromExtensionPage && msg.type.startsWith('cloud:autofetch-')) {
    const addAccount = (payload) => PaymentCloudService.handleMessage({ type: 'cloud:add', payload });
    PaymentAutofetchWatch.handleMessage(msg, addAccount)
      .then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
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
  if (sender.tab && msg.type === 'autofetch:token') {
    PaymentAutofetchWatch.receiveToken(msg, sender).catch(() => console.error('[결제 기록장] 자동으로 받은 토큰을 처리하지 못했어요.'));
    return undefined;
  }
  if (sender.tab && msg.type.startsWith('account:')) {
    serialize(() => handleAccountMessage(msg, sender.tab, sender.url))
      .then(sendResponse, () => sendResponse({ ok: false }));
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
PaymentReminderService.install();
PaymentAutofetchWatch.install();

// 설치 직후에만 대시보드를 열어 첫 실행 안내를 보여 준다(업데이트 때는 열지 않는다).
chrome.runtime.onInstalled.addListener((details) => {
  PaymentOnboarding.handleInstalled(details, {
    loadSettings: PaymentSettings.loadSettings,
    saveSettings: PaymentSettings.saveSettings,
    openDashboard: () => chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard.html#home') }),
  }).catch((err) => console.error('[결제 기록장]', err));
});
