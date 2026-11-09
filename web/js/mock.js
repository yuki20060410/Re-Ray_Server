// 偽のサーバー（段階1用）
// mock/*.json を最初に1回だけ読み、あとはブラウザの localStorage に入れて書き換える。
// 本物のサーバーにつなぐときは api.js の API_MODE を 'server' にする（このファイルは使われなくなる）。

const MockServer = (() => {
  const KEY = 'reray-mock-v1';
  const TABLES = ['devices', 'positions', 'signal_codes', 'instruction_codes', 'signals', 'messages'];
  let state = null;

  // ---- 読み込みと保存 ----
  async function load() {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      state = JSON.parse(saved);
    } else {
      const data = await Promise.all(TABLES.map(async (t) => {
        const res = await fetch(`mock/${t}.json`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`mock/${t}.json が読めません`);
        return res.json();
      }));
      state = Object.fromEntries(TABLES.map((t, i) => [t, data[i]]));
      shiftTimesToNow(state);
    }
    progressDeliveries();
    save();
    return state;
  }
  function save() { localStorage.setItem(KEY, JSON.stringify(state)); }

  // 偽データの時刻を「いま」に寄せる（いちばん新しい記録を 5 秒前にする）
  function shiftTimesToNow(s) {
    const times = [
      ...s.devices.map(d => d.last_seen_at),
      ...s.signals.map(x => x.received_at),
      ...s.messages.map(m => m.sent_at),
    ].filter(Boolean).map(t => Date.parse(t));
    const offset = Date.now() - 5000 - Math.max(...times);
    const mv = (t) => (t ? new Date(Date.parse(t) + offset).toISOString() : t);
    s.devices.forEach(d => { d.last_seen_at = mv(d.last_seen_at); });
    s.signals.forEach(x => { x.received_at = mv(x.received_at); x.handled_at = mv(x.handled_at); });
    s.messages.forEach(m => {
      m.sent_at = mv(m.sent_at);
      m.deliveries.forEach(d => { d.received_at = mv(d.received_at); d.responded_at = mv(d.responded_at); });
    });
  }

  // 送ったものが時間とともに届いたことにする（Wi-Fi は約1秒、LoRa は約5秒）
  function progressDeliveries() {
    const now = Date.now();
    for (const m of state.messages) {
      for (const d of m.deliveries) {
        if (d._recv_plan && !d.received_at && now >= d._recv_plan) {
          d.received_at = new Date(d._recv_plan).toISOString();
        }
        if (d._resp_plan && !d.response && now >= d._resp_plan) {
          d.response = d._resp_kind;
          d.responded_at = new Date(d._resp_plan).toISOString();
        }
      }
    }
  }

  // ---- 表の引き方 ----
  const nowIso = () => new Date().toISOString();
  const posOf = (id) => {
    const p = state.positions.find(p => p.id === id);
    return p ? { id: p.id, name: p.name } : null;
  };
  const sigCode = (code) => state.signal_codes.find(c => c.code === code);
  const insCode = (code) => state.instruction_codes.find(c => c.code === code);
  const devOf = (id) => state.devices.find(d => d.id === id);
  const fail = (msg) => { throw new Error(msg); };
  const deviceLabel = (id) => `dev-${String(id).padStart(3, '0')}`;

  function signalView(s) {
    const c = sigCode(s.code) || { name: `不明(${s.code})`, short_name: '不明', is_sos: false, quantity_unit: null };
    const d = devOf(s.device_id);
    return {
      id: s.id, device_id: s.device_id, owner_name: d ? d.owner_name : null,
      code: s.code, name: c.name, short_name: c.short_name, is_sos: c.is_sos,
      priority: c.priority, quantity: s.quantity, quantity_unit: c.quantity_unit,
      position: posOf(s.position_id), via: s.via,
      received_at: s.received_at, handled_at: s.handled_at,
    };
  }

  function deviceView(d) {
    const sigs = state.signals.filter(s => s.device_id === d.id)
      .sort((a, b) => b.received_at.localeCompare(a.received_at));
    return {
      id: d.id, owner_name: d.owner_name, position: posOf(d.position_id),
      is_online: d.is_online, via: d.via, battery: d.battery, has_glass: d.has_glass,
      last_seen_at: d.last_seen_at,
      last_signal: sigs[0] ? signalView(sigs[0]) : null,
      open_sos: sigs.filter(s => sigCode(s.code)?.is_sos && !s.handled_at).map(signalView),
    };
  }

  function messageText(m) {
    if (m.kind !== 'instruction') return m.body;
    const c = insCode(m.instruction_code);
    if (!c) return `指示コード ${m.instruction_code}`;
    const p = posOf(m.position_id);
    return c.uses_position
      ? c.text_with_pos.replace('{ポジション名}', p ? p.name : `ポジション${m.position_id}`)
      : c.text_without_pos;
  }

  function deliverySummary(m) {
    const ds = m.deliveries;
    return {
      total: ds.length,
      received: ds.filter(d => d.received_at).length,
      accepted: ds.filter(d => d.response === 'accepted').length,
      declined: ds.filter(d => d.response === 'declined').length,
      waiting: ds.filter(d => !d.received_at && !d.skipped && d.via_at_send !== 'offline').length,
      lora: ds.filter(d => d.via_at_send === 'lora' && !d.skipped).length,
      offline: ds.filter(d => d.via_at_send === 'offline').length,
      skipped: ds.filter(d => d.skipped).length,
    };
  }

  function messageView(m, withDetail = false) {
    const dst = m.dst_device_id == null ? null : devOf(m.dst_device_id);
    const v = {
      id: m.id, kind: m.kind, dst_device_id: m.dst_device_id,
      dst_name: m.dst_device_id == null ? '全員' : (dst?.owner_name || deviceLabel(m.dst_device_id)),
      text: messageText(m), instruction_code: m.instruction_code, position: posOf(m.position_id),
      sent_at: m.sent_at, delivery: deliverySummary(m),
      requires_response: m.kind === 'instruction' && (insCode(m.instruction_code)?.requires_response ?? true),
    };
    if (withDetail) {
      v.deliveries = m.deliveries.map(d => ({
        device_id: d.device_id, owner_name: devOf(d.device_id)?.owner_name ?? null,
        via_at_send: d.via_at_send, skipped: !!d.skipped,
        received_at: d.received_at, response: d.response, responded_at: d.responded_at,
      }));
    }
    return v;
  }

  // ---- API と同じ名前の関数 ----
  return {
    async getDevices() {
      await load();
      return state.devices.map(deviceView);
    },
    async getDevice(id) {
      await load();
      const d = devOf(Number(id)) || fail(`端末 ${id} は登録されていません`);
      return deviceView(d);
    },
    async createDevice({ id, owner_name }) {
      await load();
      id = Number(id);
      if (!Number.isInteger(id) || id < 1 || id > 65534) fail('端末の番号は 1〜65534 で入れてください');
      if (devOf(id)) fail(`${deviceLabel(id)} はもう登録されています`);
      state.devices.push({ id, owner_name: owner_name || null, position_id: null, is_online: false,
        via: null, battery: null, has_glass: false, last_seen_at: null });
      save();
      return { id };
    },
    async updateDevice(id, { owner_name }) {
      await load();
      const d = devOf(Number(id)) || fail('その端末はありません');
      d.owner_name = owner_name || null;
      save();
      return { id: d.id };
    },

    async getPositions() { await load(); return [...state.positions].sort((a, b) => a.id - b.id); },
    async savePosition(p) {
      await load();
      const id = Number(p.id);
      if (!Number.isInteger(id) || id < 1 || id > 255) fail('ポジションの番号は 1〜255 で入れてください');
      if (!p.name || !p.name.trim()) fail('名前を入れてください');
      if (p.name.length > 30) fail('名前は30文字までです');
      const num = (v) => (v === '' || v == null ? null : Number(v));
      const row = { id, name: p.name.trim(), note: p.note || null, lat: num(p.lat), lon: num(p.lon) };
      const i = state.positions.findIndex(x => x.id === id);
      if (i >= 0) state.positions[i] = row; else state.positions.push(row);
      save();
      return row;
    },
    async deletePosition(id) {
      await load();
      id = Number(id);
      if (state.devices.some(d => d.position_id === id)) fail('この場所にいる端末があるので消せません');
      state.positions = state.positions.filter(p => p.id !== id);
      save();
      return { id };
    },

    async getSignalCodes() { await load(); return state.signal_codes; },
    async getInstructionCodes() { await load(); return state.instruction_codes; },

    async sendMessage({ kind, dst_device_id, body, instruction_code, position_id }) {
      await load();
      if (!['text', 'instruction'].includes(kind)) fail('種類が正しくありません');
      if (kind === 'text') {
        if (!body || !body.trim()) fail('本文を入れてください');
        if ([...body].length > CONFIG.BODY_MAX) fail(`本文は${CONFIG.BODY_MAX}文字までです`);
      } else {
        const c = insCode(Number(instruction_code)) || fail('指示を選んでください');
        if (c.uses_position && !posOf(Number(position_id))) fail('ポジションを選んでください');
      }
      const targets = dst_device_id == null
        ? state.devices
        : [devOf(Number(dst_device_id)) || fail('送り先の端末がありません')];
      const now = Date.now();
      const id = Math.max(0, ...state.messages.map(m => m.id)) + 1;
      const needResp = kind === 'instruction';
      const deliveries = targets.map(d => {
        const via = d.is_online ? d.via : 'offline';
        const row = { device_id: d.id, via_at_send: via, received_at: null, response: null, responded_at: null };
        if (via === 'offline') return row;
        if (kind === 'text' && via === 'lora') { row.skipped = true; return row; } // LoRa では文字を送れない
        const lag = via === 'lora' ? 5000 : 1000;
        row._recv_plan = now + lag + d.id * 150;
        if (needResp && d.has_glass) {
          row._resp_plan = row._recv_plan + 3000 + d.id * 700;
          row._resp_kind = d.id % 5 === 0 ? 'declined' : 'accepted';
        }
        return row;
      });
      state.messages.push({
        id, kind, dst_device_id: dst_device_id == null ? null : Number(dst_device_id),
        body: kind === 'text' ? body.trim() : null,
        instruction_code: kind === 'instruction' ? Number(instruction_code) : null,
        position_id: kind === 'instruction' && position_id ? Number(position_id) : null,
        sent_at: new Date(now).toISOString(), deliveries,
      });
      save();
      return { id };
    },
    async getMessage(id) {
      await load();
      const m = state.messages.find(m => m.id === Number(id)) || fail('その送信の記録はありません');
      return messageView(m, true);
    },
    async getMessages({ limit = 10 } = {}) {
      await load();
      return [...state.messages].sort((a, b) => b.sent_at.localeCompare(a.sent_at))
        .slice(0, limit).map(m => messageView(m));
    },

    async getLogs({ device_id, type, date } = {}) {
      await load();
      const dev = device_id ? Number(device_id) : null;
      let items = [];
      if (type !== 'message') {
        items.push(...state.signals
          .filter(s => !dev || s.device_id === dev)
          .map(s => ({ type: 'signal', at: s.received_at, ...signalView(s) }))
          .filter(x => type !== 'sos' || x.is_sos));
      }
      if (!type || type === 'message') {
        items.push(...state.messages
          .filter(m => !dev || m.deliveries.some(d => d.device_id === dev))
          .map(m => ({ type: 'message', at: m.sent_at, ...messageView(m) })));
      }
      if (date) items = items.filter(x => localDate(x.at) === date);
      return items.sort((a, b) => b.at.localeCompare(a.at));
    },

    async getOpenSos() {
      await load();
      return state.signals.filter(s => sigCode(s.code)?.is_sos && !s.handled_at)
        .sort((a, b) => b.received_at.localeCompare(a.received_at)).map(signalView);
    },
    async handleSignal(id) {
      await load();
      const s = state.signals.find(s => s.id === Number(id)) || fail('その信号はありません');
      s.handled_at = s.handled_at || nowIso();
      save();
      return signalView(s);
    },

    // ---- テスト用（偽のサーバーだけにある） ----
    async simulateSignal({ device_id, code, quantity }) {
      await load();
      const d = devOf(Number(device_id)) || fail('その端末はありません');
      const id = Math.max(100, ...state.signals.map(s => s.id)) + 1;
      state.signals.push({ id, device_id: d.id, code: Number(code), position_id: d.position_id,
        quantity: quantity ? Number(quantity) : null, via: d.via || 'wifi',
        received_at: nowIso(), handled_at: null });
      d.is_online = true; d.last_seen_at = nowIso(); d.via = d.via || 'wifi';
      save();
      return { id };
    },
    async simulateToggleOnline(device_id) {
      await load();
      const d = devOf(Number(device_id)) || fail('その端末はありません');
      d.is_online = !d.is_online;
      if (d.is_online) { d.last_seen_at = nowIso(); d.via = d.via || 'wifi'; }
      save();
      return deviceView(d);
    },
    async simulateToggleVia(device_id) {
      await load();
      const d = devOf(Number(device_id)) || fail('その端末はありません');
      d.via = d.via === 'lora' ? 'wifi' : 'lora';
      save();
      return deviceView(d);
    },
    reset() { localStorage.removeItem(KEY); state = null; },
  };
})();

function localDate(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
