/* 설정 화면의 "카드 이용내역 가져오기". 파일은 이 페이지 안에서만 읽고(네트워크·저장소로 보내지 않음),
   찾은 반복 결제 후보만 기존 저장 경로(upsertMany)로 "확인할 기록"에 넣는다. 파일 원문은 화면을 닫거나 끝나면 버린다. */
(() => {
  'use strict';

  const { el, amountText, toast } = globalThis.PaymentUI;
  const S = globalThis.PaymentStatement;
  const ST = globalThis.PaymentStore;
  const $ = (id) => document.getElementById(id);
  const MAX_FILE_BYTES = 5_000_000;
  const COLUMN_FIELDS = [['date', '날짜'], ['merchant', '가맹점'], ['amount', '금액'], ['card', '카드번호(선택)']];

  let fileText = null; // 열 고르기에 다시 쓰려고 이 화면이 열려 있는 동안만 들고 있는다

  const say = (text, isError = false) => {
    if (text) toast(text, { isError });
  };

  function closePanel() {
    fileText = null;
    $('stmt-panel').hidden = true;
    $('stmt-panel').replaceChildren();
  }

  function cancelButton() {
    return el('button', { type: 'button', class: 'btn ghost small', onclick: () => { closePanel(); } }, '닫기');
  }

  // ── 열 고르기(모르는 양식) ────────────────────────────────
  function columnSelect(name, label, headers) {
    const optional = name === 'card';
    const options = [
      el('option', { value: '' }, optional ? '없음' : '고르세요'),
      ...headers.map((h, i) => el('option', { value: String(i) }, h || `(${i + 1}번째 열)`)),
    ];
    return el('label', {}, label, el('select', { name, required: optional ? null : true }, options));
  }

  function renderColumnPicker(headers) {
    const form = el('form', { class: 'stmt-pick' },
      COLUMN_FIELDS.map(([name, label]) => columnSelect(name, label, headers)),
      el('button', { type: 'submit', class: 'btn small' }, '이 열로 읽기'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = (name) => (form.elements[name].value === '' ? null : Number(form.elements[name].value));
      run({ date: value('date'), merchant: value('merchant'), amount: value('amount'), card: value('card') }).catch(fail);
    });
    $('stmt-panel').replaceChildren(
      el('h3', {}, '처음 보는 양식이에요'),
      el('p', { class: 'muted' }, '어느 열이 날짜·가맹점·금액인지 골라 주세요.'),
      form, el('div', { class: 'setting-ctl' }, cancelButton()));
    $('stmt-panel').hidden = false;
  }

  // ── 후보 목록 ────────────────────────────────────────────
  function candidateRow(record) {
    const card = record.card ? ` · ····${record.card.last4}` : '';
    return el('li', {}, el('label', {},
      el('input', { type: 'checkbox', checked: true, 'data-id': record.id }),
      el('b', {}, record.site), el('span', {}, amountText(record)),
      el('span', { class: 'muted' }, `${record.evidence[0] || ''}${card}`)));
  }

  function summaryText(res, built) {
    const parts = [`${res.format ? `${res.format.name} 양식으로 읽었어요. ` : ''}반복 결제 후보 ${built.records.length}개를 찾았어요.`];
    if (built.skippedExisting) parts.push(`이미 있는 ${built.skippedExisting}개는 뺐어요.`);
    if (built.overLimit) parts.push(`한 번에 ${S.MAX_IMPORT}개까지만 넣을 수 있어서 ${built.overLimit}개는 다음에 넣어 주세요.`);
    // 목록을 보는 동안에도 빠진 줄이 있다는 걸 알 수 있게, 사라지는 토스트가 아니라 여기에 남긴다
    if (res.skippedRows) parts.push(`읽지 못했거나 취소된 ${res.skippedRows}줄은 건너뛰었어요.`);
    return parts.join(' ');
  }

  async function importChecked(records) {
    const ids = new Set([...$('stmt-panel').querySelectorAll('input[data-id]:checked')].map((i) => i.dataset.id));
    const chosen = records.filter((r) => ids.has(r.id));
    if (!chosen.length) return say('넣을 기록을 하나 이상 골라 주세요.', true);
    await ST.upsertRecords(chosen);
    closePanel();
    say(`${chosen.length}개를 "확인할 기록"에 넣었어요. 이번 달 화면에서 맞는지 확인해 주세요.`);
  }

  function renderCandidates(res, built) {
    const panel = $('stmt-panel');
    if (!built.records.length) {
      panel.replaceChildren(el('p', {}, summaryText(res, built) || '반복되는 결제를 찾지 못했어요.'), el('div', { class: 'setting-ctl' }, cancelButton()));
    } else {
      const submit = el('button', { type: 'button', class: 'btn small', onclick: () => importChecked(built.records).catch(fail) }, '확인할 기록으로 넣기');
      panel.replaceChildren(el('p', {}, summaryText(res, built)), el('ul', { class: 'stmt-list' }, built.records.map(candidateRow)),
        el('div', { class: 'setting-ctl' }, submit, cancelButton()));
    }
    panel.hidden = false;
  }

  async function run(columns) {
    const res = S.analyze(fileText, columns);
    if (!res.format && !columns) {
      if (!res.headers.length) return fail(new Error('이용내역 표를 찾지 못했어요. 카드사에서 받은 CSV 파일이 맞는지 확인해 주세요.'));
      return renderColumnPicker(res.headers);
    }
    const [existing, cards] = await Promise.all([ST.loadRecords(), ST.loadCards()]);
    const built = S.buildRecords(res.candidates, { existing, cards });
    return renderCandidates(res, built);
  }

  function fail(err) {
    console.error('[결제 기록장] 이용내역 가져오기', err);
    fileText = null;
    say(err && err.message ? err.message : '파일을 읽지 못했어요. 다시 시도해 주세요.', true);
  }

  async function onFile(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    closePanel();
    if (file.size > MAX_FILE_BYTES) throw new Error('파일이 너무 커요. 기간을 줄여서 다시 받아 주세요.');
    fileText = S.decodeBuffer(await file.arrayBuffer());
    await run(null);
  }

  $('stmt-file').addEventListener('change', (e) => onFile(e).catch(fail));
})();
