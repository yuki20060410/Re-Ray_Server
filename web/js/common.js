// 全画面で使う部品: メニュー、SOS の帯、エラー表示、時刻の書き方、送信欄

// ---- 小さな道具 ----
const $ = (sel, root = document) => root.querySelector(sel);

// 画面に文字を入れるときは必ず通す（名前や本文に < などが入っていても壊れないように）
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const deviceLabel = (id) => `dev-${String(id).padStart(3, '0')}`;
const ownerOf = (d) => d.owner_name || '（未登録）';
const param = (name) => new URLSearchParams(location.search).get(name);

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('ja-JP', { hour12: false });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(iso)}`;
}
function fmtAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}
const viaLabel = (v) => ({ wifi: 'Wi-Fi', lora: 'LoRa', offline: '切れている' }[v] || '—');

function signalLabel(s) {
  if (!s) return '—';
  const q = s.quantity ? ` ${s.quantity}${s.quantity_unit || ''}` : '';
  return `${s.short_name}${q}`;
}

function batteryHtml(b) {
  if (b == null) return '—';
  const cls = b <= 15 ? 'low' : b <= 40 ? 'mid' : 'ok';
  return `<span class="battery ${cls}"><span style="width:${b}%"></span></span> ${b}%`;
}

// 「5台中4台に届いた（了解3・できない0、LoRa中 1台、切れている 1台）」
function deliveryText(d, withResponse = true) {
  const parts = [];
  if (withResponse && (d.accepted || d.declined)) parts.push(`了解${d.accepted}・できない${d.declined}`);
  if (d.waiting) parts.push(`届く待ち ${d.waiting}台`);
  if (d.lora) parts.push(`LoRa中 ${d.lora}台`);
  if (d.offline) parts.push(`切れている ${d.offline}台`);
  if (d.skipped) parts.push(`文字は送れない（LoRa中）${d.skipped}台`);
  return `${d.total}台中${d.received}台に届いた` + (parts.length ? `（${parts.join('、')}）` : '');
}

const kindLabel = (k) => ({ text: '文字', instruction: '指示', transcript: '文字起こし' }[k] || k);

// 記録の1行（W3 と W5 で使う）。届いた信号と送ったものの両方を同じ形の行にする
function logRowHtml(x) {
  if (x.type === 'signal') {
    const sos = x.is_sos;
    const handled = sos && x.handled_at
      ? `<span class="tag done">対応済み ${fmtTime(x.handled_at)}</span>`
      : sos ? `<button class="btn small danger" data-handle="${x.id}">対応済みにする</button>` : '';
    return `<tr class="${sos && !x.handled_at ? 'row-sos' : ''}">
      <td>${fmtDateTime(x.at)}</td>
      <td>${sos ? '<span class="tag sos">SOS</span>' : '<span class="tag kind">定型信号</span>'}</td>
      <td><a href="device.html?id=${x.device_id}">${esc(x.owner_name || deviceLabel(x.device_id))}</a></td>
      <td>本部</td>
      <td><strong>${esc(x.code)}: ${esc(x.name)}</strong>${x.quantity ? ` ${x.quantity}${esc(x.quantity_unit || '')}` : ''}
          ${x.position ? `<span class="muted">（${esc(x.position.name)}）</span>` : ''} ${handled}</td>
      <td><span class="tag ${x.via}">${viaLabel(x.via)}</span></td>
    </tr>`;
  }
  const dst = x.dst_device_id == null ? '全員'
    : `<a href="device.html?id=${x.dst_device_id}">${esc(x.dst_name)}</a>`;
  return `<tr>
    <td>${fmtDateTime(x.at)}</td>
    <td><span class="tag kind">${kindLabel(x.kind)}</span></td>
    <td>本部</td>
    <td>${dst}</td>
    <td>${esc(x.text)}<div class="muted" style="font-size:12px">${deliveryText(x.delivery, x.requires_response)}</div></td>
    <td>—</td>
  </tr>`;
}
const LOG_HEAD = '<tr><th>時刻</th><th>種類</th><th>だれから</th><th>だれへ</th><th>中身</th><th>経路</th></tr>';

// ---- エラー表示 ----
function showError(msg) {
  const el = $('#error-bar');
  if (!el) return alert(msg);
  el.textContent = msg;
  el.hidden = false;
}
function clearError() { const el = $('#error-bar'); if (el) el.hidden = true; }

// 一定間隔で fn を呼ぶ。失敗したら上に赤い帯を出し、次の回にまた試す
function poll(fn, ms = CONFIG.POLL_MS) {
  let stopped = false;
  const run = async () => {
    try { await fn(); clearError(); } catch (e) { showError(`更新できません: ${e.message}`); }
    if (!stopped) setTimeout(run, ms);
  };
  run();
  return () => { stopped = true; };
}

// ボタンを押したときの処理。失敗したら帯に出す
async function guard(fn) {
  try { clearError(); return await fn(); } catch (e) { showError(e.message); return undefined; }
}

// ---- メニュー ----
const PAGES = [
  ['index.html', '端末一覧'],
  ['broadcast.html', '一斉送信'],
  ['logs.html', '記録'],
  ['positions.html', 'ポジション'],
  ['devices.html', '端末の登録'],
];

function renderHeader(activeFile) {
  const nav = PAGES.map(([file, label]) =>
    `<a href="${file}" class="${file === activeFile ? 'active' : ''}">${label}</a>`).join('');
  const mode = isMock() ? '<span class="mode-badge">偽のサーバー</span>'
    : CONFIG.DEV_TOOLS ? '<span class="mode-badge">サーバー（偽の端末あり）</span>' : '';
  document.body.insertAdjacentHTML('afterbegin', `
    <header class="app-header">
      <a class="brand" href="index.html">Re-Ray <small>本部</small></a>
      <nav>${nav}</nav>
      ${mode}
    </header>
    <div id="sos-bar" class="sos-bar" hidden></div>
    <div id="error-bar" class="error-bar" hidden></div>`);
  startSosWatch();
}

// ---- SOS の帯（どの画面でも出す） ----
const SOS_SEEN_KEY = 'reray-sos-seen';
let audioCtx = null;
document.addEventListener('click', () => {
  // ブラウザは、一度画面を触るまで音を出させないので、最初のクリックで準備する
  if (!audioCtx) { try { audioCtx = new AudioContext(); } catch (_) { /* 音なし */ } }
}, { once: true });

function beep() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [0, 0.25, 0.5].forEach(dt => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.2, t + dt);
    g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.2);
    o.connect(g).connect(audioCtx.destination);
    o.start(t + dt); o.stop(t + dt + 0.2);
  });
}

const baseTitle = document.title;
let titleTimer = null;
function flashTitle(on) {
  clearInterval(titleTimer);
  document.title = baseTitle;
  if (!on) return;
  let f = false;
  titleTimer = setInterval(() => { f = !f; document.title = f ? '【SOS】' + baseTitle : baseTitle; }, 1000);
}

function startSosWatch() {
  const bar = $('#sos-bar');
  bar.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-handle]');
    if (!btn) return;
    if (!confirm('この SOS を「対応済み」にしますか？')) return;
    await guard(() => Api.handleSignal(btn.dataset.handle));
    refreshSos();
  });
  poll(refreshSos);
}

async function refreshSos() {
  const list = await Api.getOpenSos();
  const bar = $('#sos-bar');
  const seen = new Set(JSON.parse(sessionStorage.getItem(SOS_SEEN_KEY) || '[]'));
  const fresh = list.filter(s => !seen.has(s.id));
  if (fresh.length) {
    beep();
    fresh.forEach(s => seen.add(s.id));
    sessionStorage.setItem(SOS_SEEN_KEY, JSON.stringify([...seen]));
  }
  flashTitle(list.length > 0);
  document.body.classList.toggle('has-sos', list.length > 0);
  if (!list.length) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = list.map(s => `
    <div class="sos-item">
      <strong>SOS</strong>
      <span>${esc(s.owner_name || deviceLabel(s.device_id))}</span>
      <span>${esc(s.position ? s.position.name : '場所なし')}</span>
      <span>${fmtTime(s.received_at)}（${fmtAgo(s.received_at)}・${viaLabel(s.via)}）</span>
      <a class="btn small light" href="device.html?id=${s.device_id}">詳細</a>
      <button class="btn small light" data-handle="${s.id}">対応済みにする</button>
    </div>`).join('');
}

// ---- 送信欄（W3 と W4 で使う） ----
// mountSendForm(要素, { deviceId: 数字 | null（全員）, onSent: (id) => {} })
async function mountSendForm(el, { deviceId = null, onSent } = {}) {
  const [codes, positions] = await Promise.all([Api.getInstructionCodes(), Api.getPositions()]);
  const toAll = deviceId == null;
  el.innerHTML = `
    <form class="send-form" novalidate>
      <div class="kind-tabs">
        <label><input type="radio" name="kind" value="text" checked> 文字</label>
        <label><input type="radio" name="kind" value="instruction"> 指示（指示コード＋ポジション）</label>
      </div>
      <div class="kind-text">
        <textarea name="body" rows="2" placeholder="例: 北口に集合してください"></textarea>
        <div class="counter"></div>
      </div>
      <div class="kind-instruction" hidden>
        <select name="code">
          <option value="">指示を選ぶ</option>
          ${codes.map(c => `<option value="${c.code}">${c.code}: ${esc(c.name)}</option>`).join('')}
        </select>
        <select name="position" disabled>
          <option value="">ポジションを選ぶ</option>
          ${positions.map(p => `<option value="${p.id}">${p.id}: ${esc(p.name)}</option>`).join('')}
        </select>
        <div class="preview"></div>
      </div>
      <p class="note"></p>
      <div class="actions"><button class="btn primary" type="submit">${toAll ? '全員に送る' : 'この人に送る'}</button></div>
      <div class="result"></div>
    </form>`;

  const form = $('form', el);
  const kind = () => form.kind.value;
  let targets = [];

  async function refreshTargets() {
    targets = toAll ? await Api.getDevices() : [await Api.getDevice(deviceId)];
    update();
  }

  function update() {
    const isText = kind() === 'text';
    $('.kind-text', form).hidden = !isText;
    $('.kind-instruction', form).hidden = isText;

    // 残りの文字数
    const len = [...form.body.value].length;
    const left = CONFIG.BODY_MAX - len;
    const counter = $('.counter', form);
    counter.textContent = left >= 0 ? `あと ${left} 文字（上限 ${CONFIG.BODY_MAX}）` : `${-left} 文字オーバー（上限 ${CONFIG.BODY_MAX}）`;
    counter.classList.toggle('over', left < 0);

    // 指示の見本
    const c = codes.find(c => c.code === Number(form.code.value));
    form.position.disabled = !c || !c.uses_position;
    const p = positions.find(p => p.id === Number(form.position.value));
    $('.preview', form).textContent = !c ? ''
      : `グラスに出る文: ${c.uses_position ? c.text_with_pos.replace('{ポジション名}', p ? p.name : '（ポジション）') : c.text_without_pos}`;

    // LoRa・切れている端末の注意
    const lora = targets.filter(d => d.is_online && d.via === 'lora');
    const off = targets.filter(d => !d.is_online);
    const notes = [];
    if (isText && lora.length) {
      notes.push(toAll
        ? `LoRa でつながっている ${lora.length} 台（${lora.map(d => esc(ownerOf(d))).join('、')}）には文字は届きません。指示なら届きます。`
        : 'この端末は LoRa でつながっているので、文字は送れません。指示を選んでください。');
    }
    if (off.length) notes.push(`切れている ${off.length} 台には、つながるまで届きません。`);
    $('.note', form).innerHTML = notes.join('<br>');

    const blocked = isText && !toAll && lora.length > 0;
    form.querySelector('button[type=submit]').disabled = blocked;
  }

  form.addEventListener('input', update);
  form.addEventListener('change', update);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await refreshTargets();
    const msg = kind() === 'text'
      ? { kind: 'text', dst_device_id: deviceId, body: form.body.value }
      : { kind: 'instruction', dst_device_id: deviceId, instruction_code: Number(form.code.value) || null,
          position_id: Number(form.position.value) || null };

    // 入力のチェック（サーバーでも同じことを確かめる）
    if (msg.kind === 'text') {
      if (!msg.body.trim()) return showError('本文を入れてください');
      if ([...msg.body].length > CONFIG.BODY_MAX) return showError(`本文は ${CONFIG.BODY_MAX} 文字までです`);
    } else {
      const c = codes.find(c => c.code === msg.instruction_code);
      if (!c) return showError('指示を選んでください');
      if (c.uses_position && !msg.position_id) return showError('ポジションを選んでください');
    }
    if (toAll) {
      const text = msg.kind === 'text' ? msg.body : $('.preview', form).textContent.replace('グラスに出る文: ', '');
      if (!confirm(`全員（${targets.length}台）に送ります。よろしいですか？\n\n「${text}」`)) return;
    }

    const res = await guard(() => Api.sendMessage(msg));
    if (!res) return;
    form.body.value = '';
    update();
    watchDelivery($('.result', form), res.id);
    if (onSent) onSent(res.id);
  });

  await refreshTargets();
}

// 送ったあと、届いた数を 2 秒ごとに更新する（全部決まるか 2 分たったら止める）
function watchDelivery(el, messageId) {
  const started = Date.now();
  const stop = poll(async () => {
    const m = await Api.getMessage(messageId);
    const d = m.delivery;
    const waitingResp = m.requires_response
      ? m.deliveries.filter(x => x.received_at && !x.response).length : 0;
    el.innerHTML = `<div class="delivery ${d.waiting ? 'pending' : 'done'}">
      <strong>送信 #${m.id}</strong> ${esc(m.text)}<br>${deliveryText(d)}</div>`;
    if ((!d.waiting && !waitingResp) || Date.now() - started > 120000) stop();
  });
}
