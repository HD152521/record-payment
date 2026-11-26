/* 크롬 동기화(chrome.storage.sync). 기록·카드·설정만 올리고, 사용료 연결 키 같은 나머지는 기기에만 둔다.
   - 원본은 늘 chrome.storage.local이고, sync에는 항목마다 하나씩 사본을 둔다(r:<id>, c:<끝 4자리>, s).
   - 마지막으로 맞춘 상태의 지문(base)과 비교해서 어느 쪽이 바뀌었는지 판단한다. 둘 다 바뀌었으면 나중에 고친 쪽.
   - 지운 항목은 { x: 지운 시각 } 표시로 남겨 다른 기기에서도 지운다. 지우기와 고치기가 겹치면 고친 값을 살린다.
   - 클라우드 값은 믿지 않고 받을 때마다 다시 검사한다. */
(function (root) {
  'use strict';

  const L = root.PaymentLedger || (typeof require === 'function' ? require('./ledger.js') : null);
  const ST = root.PaymentSettings || (typeof require === 'function' ? require('./settings.js') : null);

  const STATE_KEY = 'syncState';
  const WIPE_KEY = 'wiped';
  const SETTINGS_KEY = 's';
  const RECORD_PREFIX = 'r:';
  const CARD_PREFIX = 'c:';
  const DELETED = 'x'; // base에 남기는 "삭제를 이미 맞췄음" 표시
  const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

  const QUOTA_MESSAGE = '크롬 동기화 용량(약 100KB, 512개)이 꽉 차서 일부를 올리지 못했어요. 기록은 이 기기에 그대로 있어요.';
  const BUSY_MESSAGE = '크롬 동기화에 올리지 못했어요. 잠시 뒤 다시 시도해요.';
  const WIPED_MESSAGE = '다른 기기에서 모두 지우기를 해서 이 기기의 동기화를 껐어요. 이 기기의 기록은 그대로 있어요.';

  // 용량을 아끼려고 빈 값은 빼고 올린다. 받을 때 sanitize가 기본값을 다시 채운다.
  const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => !(
    v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && v.length === 0))));

  const encodeRecord = (record) => compact(L.sanitizeRecord(record));

  function encodeCard(card) {
    const { isDefaultLabel, ...normalized } = L.normalizeCard(card);
    const createdAt = Number.isFinite(card.createdAt) ? card.createdAt : 0;
    const id = typeof card.id === 'string' && card.id.length <= 60 ? card.id : normalized.id;
    return { ...normalized, id, createdAt };
  }

  function encodeSettings(input) {
    const { budgetKRW, remind, trendView } = ST.normalizeSettings(input);
    return { budgetKRW, remind: { ...remind }, trendView };
  }

  function safely(fn) {
    try {
      return fn();
    } catch {
      return null;
    }
  }

  /** 키 순서에 흔들리지 않는 짧은 지문(cyrb53). */
  function fingerprint(value) {
    const stable = (v) => (v && typeof v === 'object'
      ? (Array.isArray(v) ? v.map(stable) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])))
      : v);
    const text = JSON.stringify(stable(value));
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  const defaultSettingsPrint = () => fingerprint(encodeSettings());

  const isTombstone = (v) => Boolean(v && typeof v === 'object' && Number.isFinite(v.x));

  /** 클라우드 값 → { deleted } | { value } | { invalid } | undefined(없음) */
  function readRemote(key, raw) {
    if (raw === undefined) return undefined;
    if (isTombstone(raw)) return { deleted: raw.x };
    if (!raw || typeof raw !== 'object') return { invalid: true };
    let value = null;
    if (key === SETTINGS_KEY) value = encodeSettings(raw);
    else if (key.startsWith(RECORD_PREFIX)) value = safely(() => encodeRecord(raw));
    else value = safely(() => encodeCard(raw));
    const matchesKey = value && (key === SETTINGS_KEY
      || (key.startsWith(RECORD_PREFIX) ? `${RECORD_PREFIX}${value.id}` : `${CARD_PREFIX}${value.last4}`) === key);
    return matchesKey ? { value } : { invalid: true };
  }

  const changedAt = (value) => value.updatedAt ?? value.createdAt ?? 0;

  /**
   * 항목 하나를 어떻게 맞출지 정한다.
   * → { action: 'push' | 'pull' | 'push-delete' | 'pull-delete' | 'same' | 'skip', base }
   */
  function decide(key, local, remote, base) {
    if (remote && remote.invalid) return { action: 'skip', base };
    if (local === undefined) {
      if (!remote) return { action: 'skip', base: base === DELETED ? DELETED : undefined };
      if (remote.deleted !== undefined) return { action: 'skip', base: DELETED };
      const deletedHere = base !== undefined && base !== DELETED && base === fingerprint(remote.value);
      return deletedHere ? { action: 'push-delete', base: DELETED } : { action: 'pull', base: fingerprint(remote.value) };
    }
    const mine = fingerprint(local);
    if (!remote) {
      // 한 번 맞춘 뒤 안 바뀐 항목이 클라우드에서 그냥 없어졌으면 다시 올리지 않는다.
      // 지우기는 삭제 표시를 남기므로, 이건 '모두 지우기'가 일부만 도착했거나 오래된 표시를 치운 경우다.
      if (base === mine) return { action: 'skip', base };
      // 방금 설치한 기기의 기본 설정이, 아직 못 받은 다른 기기의 설정을 덮지 않게 한다.
      if (key === SETTINGS_KEY && base === undefined && mine === defaultSettingsPrint()) return { action: 'skip' };
      return { action: 'push', base: mine };
    }
    if (remote.deleted !== undefined) {
      // base가 DELETED인데 로컬에 있으면 되돌리기·복원으로 다시 만든 것이다.
      const revived = base === DELETED || (base !== undefined && base !== mine) || changedAt(local) > remote.deleted;
      return revived ? { action: 'push', base: mine } : { action: 'pull-delete', base: DELETED };
    }
    const theirs = fingerprint(remote.value);
    if (mine === theirs) return { action: 'same', base: mine };
    if (base === theirs) return { action: 'push', base: mine };
    // 이 기기만 안 바뀌었어도 크롬이 더 오래된 값을 골라 보냈을 수 있어 수정 시각을 비교한다.
    // 둘 다 바뀌었거나 처음 맞추는 경우도 같다. 설정은 시각이 없어서 클라우드 값을 따른다.
    const localWins = key !== SETTINGS_KEY && changedAt(local) > changedAt(remote.value);
    return localWins ? { action: 'push', base: mine } : { action: 'pull', base: theirs };
  }

  function localItems({ records = [], cards = [], settings }) {
    const entries = [
      ...records.map((r) => [`${RECORD_PREFIX}${r.id}`, safely(() => encodeRecord(r))]),
      ...cards.map((c) => [`${CARD_PREFIX}${c.last4}`, safely(() => encodeCard(c))]),
      ...(settings ? [[SETTINGS_KEY, encodeSettings(settings)]] : []),
    ];
    return new Map(entries.filter(([, v]) => v));
  }

  const isItemKey = (k) => k === SETTINGS_KEY || k.startsWith(RECORD_PREFIX) || k.startsWith(CARD_PREFIX);

  function buildPlan(stored, cloud, base, now) {
    const mine = localItems(stored);
    const keys = new Set([...mine.keys(), ...Object.keys(cloud).filter(isItemKey), ...Object.keys(base)]);
    return [...keys].map((key) => {
      const remote = readRemote(key, cloud[key]);
      const decision = decide(key, mine.get(key), remote, base[key]);
      const upload = decision.action === 'push' ? mine.get(key)
        : decision.action === 'push-delete' ? { x: now } : undefined;
      return { key, ...decision, upload, exists: cloud[key] !== undefined, incoming: remote && remote.value, previousBase: base[key] };
    });
  }

  /** 받은 변경을 로컬 목록에 적용한다. 바뀌지 않은 항목은 원래 객체 그대로 둔다. */
  function applyList(list, keyOf, prefix, plan, decode) {
    const steps = new Map(plan.filter((p) => p.key.startsWith(prefix)).map((p) => [p.key, p]));
    const kept = list.flatMap((item) => {
      const step = steps.get(keyOf(item));
      if (step && step.action === 'pull-delete') return [];
      return step && step.action === 'pull' ? [decode(step.incoming, item)] : [item];
    });
    const known = new Set(list.map(keyOf));
    const added = [...steps.values()]
      .filter((p) => p.action === 'pull' && !known.has(p.key))
      .map((p) => decode(p.incoming));
    return [...added, ...kept];
  }

  function localPatch(stored, plan) {
    const touches = (prefix) => plan.some((p) => p.key.startsWith(prefix) && p.action.startsWith('pull'));
    const patch = {};
    if (touches(RECORD_PREFIX)) {
      patch.records = applyList(stored.records || [], (r) => `${RECORD_PREFIX}${r.id}`, RECORD_PREFIX, plan,
        (value) => L.sanitizeRecord(value));
    }
    if (touches(CARD_PREFIX)) {
      patch.cards = applyList(stored.cards || [], (c) => `${CARD_PREFIX}${c.last4}`, CARD_PREFIX, plan, (value) => ({ ...value }));
    }
    const settingsStep = plan.find((p) => p.key === SETTINGS_KEY && p.action === 'pull');
    if (settingsStep) {
      // 첫 실행 안내 상태는 기기마다 따로다.
      const onboarding = ST.normalizeSettings(stored.settings).onboarding;
      patch.settings = ST.normalizeSettings({ ...settingsStep.incoming, onboarding });
    }
    return patch;
  }

  const uploadsOf = (steps) => Object.fromEntries(steps.map((p) => [p.key, p.upload]));

  const isFull = (err) => {
    const message = String(err && err.message);
    return /quota|MAX_ITEMS/i.test(message) && !/PER_(MINUTE|HOUR)|OPERATIONS/i.test(message);
  };

  /** 올리기. 한 번에 안 되면 삭제 표시 → 있던 항목 수정 → 새 항목 순서로 나눠 되는 만큼 올린다. → { sent: Set, error } */
  async function push(remote, plan) {
    const steps = plan.filter((p) => p.upload !== undefined);
    if (!steps.length) return { sent: new Set(), error: null };
    const attempt = (batch) => remote.set(uploadsOf(batch)).then(() => null, (err) => err || new Error('sync'));
    const failure = await attempt(steps);
    if (!failure) return { sent: new Set(steps.map((p) => p.key)), error: null };
    const error = isFull(failure) ? QUOTA_MESSAGE : BUSY_MESSAGE;
    const batches = [
      steps.filter((p) => p.action === 'push-delete'),
      steps.filter((p) => p.action === 'push' && p.exists),
      steps.filter((p) => p.action === 'push' && !p.exists),
    ].filter((batch) => batch.length && batch.length < steps.length);
    const sent = new Set();
    for (const batch of batches) {
      if (!(await attempt(batch))) batch.forEach((p) => sent.add(p.key));
    }
    return { sent, error };
  }

  // 올리지 못한 항목은 예전 지문을 남겨 다음에 다시 시도한다.
  function nextBase(plan, sent) {
    return Object.fromEntries(plan
      .map((p) => [p.key, p.upload !== undefined && !sent.has(p.key) ? p.previousBase : p.base])
      .filter(([, v]) => v !== undefined));
  }

  /**
   * local·remote는 chrome.storage.local / chrome.storage.sync 모양(get·set·remove).
   * 부르는 쪽은 background의 쓰기 큐 안에서 불러야 감지 기록과 서로 덮어쓰지 않는다.
   */
  function createSync({ local, remote, now = Date.now }) {
    const loadState = async () => (await local.get(STATE_KEY))[STATE_KEY] || { enabled: false };
    const saveState = (state) => local.set({ [STATE_KEY]: state });
    const statusOf = (s) => ({ enabled: s.enabled === true, lastSyncAt: s.lastSyncAt || null, error: s.error || null });

    async function pruneTombstones(cloud, sent) {
      const old = Object.keys(cloud).filter((k) => isItemKey(k) && !sent.has(k)
        && isTombstone(cloud[k]) && now() - cloud[k].x > TOMBSTONE_TTL_MS);
      if (old.length) await remote.remove(old).catch((err) => console.error('[결제 기록장] 동기화 정리', err));
      return old;
    }

    async function syncOnce(loaded) {
      const cloud = await remote.get(null);
      const marker = cloud[WIPE_KEY];
      let state = loaded;
      if (marker && marker.id !== state.seenWipe) {
        // 켜기 전에 있었던 지우기가 늦게 도착한 것이 아니면 멈춘다.
        if (!(marker.at < state.enabledAt)) {
          const stopped = { enabled: false, error: WIPED_MESSAGE };
          await saveState(stopped);
          return statusOf(stopped);
        }
        state = { ...state, seenWipe: marker.id };
      }
      const stored = await local.get(['records', 'cards', ST.KEY]);
      const plan = buildPlan(stored, cloud, state.base || {}, now());
      const patch = localPatch(stored, plan);
      if (Object.keys(patch).length) await local.set(patch);
      const { sent, error } = await push(remote, plan);
      const pruned = await pruneTombstones(cloud, sent);
      const base = Object.fromEntries(Object.entries(nextBase(plan, sent)).filter(([k]) => !pruned.includes(k)));
      const next = { ...state, base, error, lastSyncAt: error ? state.lastSyncAt || null : now() };
      await saveState(next);
      return statusOf(next);
    }

    async function run() {
      const state = await loadState();
      if (!state.enabled) return statusOf(state);
      try {
        return await syncOnce(state);
      } catch (err) {
        console.error('[결제 기록장] 동기화', err);
        const failed = { ...(await loadState()), error: BUSY_MESSAGE };
        await saveState(failed);
        return statusOf(failed);
      }
    }

    async function enable() {
      const previous = await loadState();
      const cloud = await remote.get(null);
      const seenWipe = (cloud[WIPE_KEY] && cloud[WIPE_KEY].id) || null;
      // 껐다 켠 경우 예전 지문을 이어 써야 끈 동안 지운 것이 되살아나지 않는다.
      // 그사이 모두 지웠거나 클라우드가 통째로 비었으면 처음부터 맞춘다.
      const resumable = (previous.seenWipe || null) === seenWipe && Object.keys(cloud).some(isItemKey);
      await saveState({ enabled: true, base: resumable ? previous.base || {} : {}, seenWipe, enabledAt: now() });
      return run();
    }

    async function disable() {
      await saveState({ ...(await loadState()), enabled: false, error: null });
      return statusOf({ enabled: false });
    }

    /** 모든 데이터 지우기: 클라우드 사본을 지우고, 다른 기기가 다시 올리지 않게 표시를 남긴다. */
    async function wipeRemote() {
      const cloud = await remote.get(null);
      const keys = Object.keys(cloud).filter(isItemKey);
      if (!keys.length) return;
      // 꽉 찬 상태에서도 표시를 쓸 수 있게 한 칸을 먼저 비운다.
      const [first, ...rest] = keys;
      await remote.remove([first]);
      const at = now();
      await remote.set({ [WIPE_KEY]: { at, id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}` } });
      if (rest.length) await remote.remove(rest);
    }

    const status = async () => statusOf(await loadState());

    return { run, enable, disable, wipeRemote, status };
  }

  const api = { STATE_KEY, createSync };
  root.PaymentSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
