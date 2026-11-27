/* 설정 화면: 월 예산, 결제 알림, 백업·복원, 모든 데이터 지우기. */
(() => {
  'use strict';

  const { el, toast } = globalThis.PaymentUI;
  const ST = globalThis.PaymentSettings;
  const B = globalThis.PaymentBackup;
  const $ = (id) => document.getElementById(id);
  const CONFIRM_WORD = '지우기';
  const MAX_FILE_BYTES = 5_000_000;

  const say = (text, isError = false) => toast(text, { isError });
  const fail = (err) => {
    console.error('[결제 기록장] 설정', err);
    say(err && err.message ? err.message : '저장하지 못했어요. 다시 시도해 주세요.', true);
  };

  async function send(message) {
    const res = await chrome.runtime.sendMessage(message);
    if (!res || !res.ok) throw new Error((res && res.error) || '요청을 처리하지 못했어요.');
    return res;
  }

  // ── 설정 값 ↔ 양식 ───────────────────────────────────────
  function fillForms(settings) {
    const budget = $('budget-form').elements.budget;
    if (document.activeElement !== budget) budget.value = settings.budgetKRW ?? '';
    $('remind-form').elements.enabled.checked = settings.remind.enabled;
    $('remind-form').elements.daysBefore.value = String(settings.remind.daysBefore);
  }

  async function saveBudget(event) {
    event.preventDefault();
    const raw = $('budget-form').elements.budget.value.trim();
    const current = await ST.loadSettings();
    await ST.saveSettings({ ...current, budgetKRW: raw === '' ? null : Number(raw) });
    say(raw === '' ? '예산을 껐어요.' : `월 예산을 ${Number(raw).toLocaleString('ko-KR')}원으로 정했어요.`);
  }

  async function saveRemind() {
    const f = $('remind-form').elements;
    const current = await ST.loadSettings();
    await ST.saveSettings({ ...current, remind: { enabled: f.enabled.checked, daysBefore: Number(f.daysBefore.value) } });
    if (f.enabled.checked) await send({ type: 'reminders:check' });
    say(f.enabled.checked ? '결제 알림을 켰어요. 매일 아침 9시에 확인해요.' : '결제 알림을 껐어요.');
  }

  // ── 백업·복원 ────────────────────────────────────────────
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    el('a', { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function backup() {
    const stored = await chrome.storage.local.get(['records', 'cards', ST.KEY]);
    const today = new Date().toISOString().slice(0, 10);
    download(`결제기록장_백업_${today}.json`, B.buildBackup({ records: stored.records || [], cards: stored.cards || [], settings: stored[ST.KEY] }), 'application/json');
    say('백업 파일을 받았어요. 연결 키는 들어 있지 않아요.');
  }

  async function restore(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) throw new Error('백업 파일이 너무 커요.');
    const text = await file.text();
    const preview = B.parseBackup(text); // 먼저 여기서 읽어 보고 몇 개인지 묻는다. 저장은 background가 다시 검사한다.
    if (!confirm(`기록 ${preview.records.length}개, 카드 ${preview.cards.length}장을 가져올까요? 같은 기록은 파일의 값으로 바뀌고, 설정도 파일의 값으로 바뀌어요.`)) return;
    const res = await send({ type: 'import', text });
    say(`기록 ${res.records}개, 카드 ${res.cards}장을 가져왔어요.${res.skipped ? ` 읽을 수 없는 ${res.skipped}개는 건너뛰었어요.` : ''}`);
  }

  // ── 모든 데이터 지우기 ───────────────────────────────────
  async function openWipe() {
    const stored = await chrome.storage.local.get(['records', 'cards', 'cloudAccounts']);
    const size = (v) => (Array.isArray(v) ? v.length : 0);
    $('wipe-summary').replaceChildren(
      el('li', {}, '결제 기록 ', el('b', {}, `${size(stored.records)}개`)),
      el('li', {}, '내 카드 ', el('b', {}, `${size(stored.cards)}장`)),
      el('li', {}, '사용료 연결과 저장된 키 ', el('b', {}, `${size(stored.cloudAccounts)}개`)),
      el('li', {}, '달마다 사용료 기록, 예산·알림 설정'));
    $('wipe-form').reset();
    $('wipe-status').textContent = '';
    $('wipe-submit').disabled = true;
    $('wipe-dialog').showModal();
    $('wipe-form').elements.confirm.focus();
  }

  async function wipe(event) {
    event.preventDefault();
    if ($('wipe-form').elements.confirm.value.trim() !== CONFIRM_WORD) return;
    $('wipe-submit').disabled = true;
    try {
      await send({ type: 'wipe' });
      location.hash = 'home';
      location.reload();
    } catch (err) {
      console.error('[결제 기록장] 데이터 지우기', err);
      $('wipe-status').textContent = '지우지 못했어요. 다시 시도해 주세요.';
      $('wipe-submit').disabled = false;
    }
  }

  $('budget-form').addEventListener('submit', (e) => saveBudget(e).catch(fail));
  $('remind-form').addEventListener('change', () => saveRemind().catch(fail));
  $('remind-form').addEventListener('submit', (e) => e.preventDefault());
  $('remind-test').addEventListener('click', () => send({ type: 'reminders:test' })
    .then(() => say('예시 알림을 보냈어요. 안 보이면 컴퓨터의 알림 센터(Windows는 Win+N)를 열어 보고, 방해 금지와 Chrome 알림 설정을 확인해 주세요.'))
    .catch(fail));
  $('backup-btn').addEventListener('click', () => backup().catch(fail));
  $('restore-file').addEventListener('change', (e) => restore(e).catch(fail));
  $('wipe-btn').addEventListener('click', () => openWipe().catch(fail));
  $('wipe-cancel').addEventListener('click', () => $('wipe-dialog').close());
  $('wipe-csv').addEventListener('click', () => globalThis.PaymentDashboard.exportCsv());
  $('wipe-form').elements.confirm.addEventListener('input', (e) => {
    $('wipe-submit').disabled = e.target.value.trim() !== CONFIRM_WORD;
  });
  $('wipe-form').addEventListener('submit', wipe);

  ST.loadSettings().then(fillForms).catch(fail);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[ST.KEY]) fillForms(ST.normalizeSettings(changes[ST.KEY].newValue));
  });
})();
