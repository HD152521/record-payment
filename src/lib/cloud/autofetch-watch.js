/* background 전용. 토큰 자동 받기(easy-connect Step 3)의 탭 감시.
   - 연결 창의 "만들기 열기" 버튼으로 연 탭 하나와 서비스만 기억한다(chrome.storage.session, 디스크에 안 남음).
   - 그 탭이 그 서비스 콘솔(https)일 때만 읽기 스크립트를 넣는다. 다른 탭·다른 사이트는 읽지 않는다.
   - 찾은 토큰은 사용자가 "연결하기"를 누르기 전엔 계정으로 저장하지 않는다. 대시보드엔 가린 값만 보낸다.
   - 토큰은 로그·오류 문장에 넣지 않는다. */
(function (root) {
  'use strict';

  const A = root.PaymentAutofetch;
  const KEYS = { watch: 'autofetchWatch', found: 'autofetchFound' };
  const WATCH_MS = 30 * 60 * 1000;
  const FOUND_MS = 30 * 60 * 1000;
  const PAGE_FILES = ['src/lib/cloud/autofetch.js', 'src/autofetch-page.js'];

  async function get(key) {
    const stored = await chrome.storage.session.get(key);
    return stored[key] || null;
  }
  const clear = () => chrome.storage.session.remove([KEYS.watch, KEYS.found]);

  async function activeWatch(tabId) {
    const watch = await get(KEYS.watch);
    if (!watch || watch.tabId !== tabId) return null;
    return Date.now() - watch.at < WATCH_MS ? watch : null;
  }

  async function inject(tabId, provider) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: PAGE_FILES });
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: (p) => globalThis.PaymentAutofetchPage.start(p),
        args: [provider],
      });
    } catch (err) {
      logError(err); // 탭이 닫혔거나 브라우저가 막은 페이지면 붙여넣기로 돌아간다
    }
  }

  async function injectIfProviderPage(tabId, url) {
    const watch = await activeWatch(tabId);
    if (watch && A.isProviderPage(watch.provider, url)) await inject(tabId, watch.provider);
  }

  async function startWatch({ tabId, provider }) {
    if (!Number.isInteger(tabId) || tabId < 0 || !A.PROVIDERS.includes(provider)) {
      throw new Error('자동으로 받을 수 없는 서비스예요. 토큰을 붙여 넣어 주세요.');
    }
    await chrome.storage.session.remove(KEYS.found);
    await chrome.storage.session.set({ [KEYS.watch]: { tabId, provider, at: Date.now() } });
    // 이미 다 열린 탭이면 완료 이벤트가 다시 오지 않으니 지금 넣어 본다.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && tab.status === 'complete' && tab.url) await injectIfProviderPage(tabId, tab.url);
    return { ok: true };
  }

  async function foundFor(provider) {
    const found = await get(KEYS.found);
    if (!found || Date.now() - found.at >= FOUND_MS) return null;
    return provider && found.provider !== provider ? null : found;
  }

  async function status() {
    const found = await foundFor(null);
    return { ok: true, found: found ? { provider: found.provider, preview: A.preview(found.provider, found.credentials) } : null };
  }

  // 사용자가 확인했을 때만 기존 연결 경로(cloud:add)로 저장한다. 저장 후엔 읽은 값을 지운다.
  async function confirm({ provider, label, extra, replaceId = null }, addAccount) {
    const found = await foundFor(provider);
    if (!found) throw new Error('자동으로 받은 토큰이 없어요. 토큰을 붙여 넣어 주세요.');
    const credentials = A.mergeCredentials(provider, found.credentials, extra && typeof extra === 'object' ? extra : {});
    const result = await addAccount({ provider, label, credentials, replaceId });
    await clear();
    return result;
  }

  function handleMessage(msg, addAccount) {
    const p = msg.payload || {};
    switch (msg.type) {
      case 'cloud:autofetch-watch': return startWatch(p);
      case 'cloud:autofetch-status': return status();
      case 'cloud:autofetch-confirm': return confirm(p, addAccount);
      case 'cloud:autofetch-cancel': return clear().then(() => ({ ok: true }));
      default: return Promise.reject(new Error(`알 수 없는 요청: ${msg.type}`));
    }
  }

  function credentialValues(credentials) {
    const c = credentials && typeof credentials === 'object' ? credentials : {};
    return Object.values(c).filter((v) => typeof v === 'string');
  }

  // 주입한 읽기 스크립트가 보낸 값. 감시 중인 탭의 맨 위 문서이고 그 서비스 콘솔일 때만 받는다.
  async function receiveToken(msg, sender) {
    const tabId = sender.tab && sender.tab.id;
    const watch = await activeWatch(tabId);
    if (!watch || sender.frameId !== 0 || !A.isProviderPage(watch.provider, sender.url || sender.tab.url)) return;
    // 페이지 쪽 값을 그대로 믿지 않고 같은 규칙으로 다시 고른다.
    const credentials = A.extractCredentials(watch.provider, { fields: credentialValues(msg.credentials), texts: [] });
    if (!credentials) return;
    await chrome.storage.session.remove(KEYS.watch);
    await chrome.storage.session.set({ [KEYS.found]: { provider: watch.provider, credentials, at: Date.now() } });
    chrome.runtime.sendMessage({ type: 'cloud:autofetch-found', provider: watch.provider, preview: A.preview(watch.provider, credentials) })
      .catch(() => {}); // 대시보드가 닫혀 있으면 받을 곳이 없다. 다음에 열 때 status로 다시 묻는다.
  }

  const logError = (err) => console.error('[결제 기록장] 토큰 자동 받기', err && err.message);

  function install() {
    chrome.webNavigation.onCompleted.addListener(({ tabId, frameId, url }) => {
      if (frameId === 0) injectIfProviderPage(tabId, url).catch(logError);
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      activeWatch(tabId)
        .then((watch) => watch && chrome.storage.session.remove(KEYS.watch))
        .catch(logError);
    });
  }

  root.PaymentAutofetchWatch = { KEYS, install, handleMessage, receiveToken };
})(globalThis);
