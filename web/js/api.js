// サーバーとのやり取りの窓口。画面のプログラムは、ここの Api.xxx() だけを使う。
// serve.js で開くと偽のサーバー（mock.js）、本物のサーバー（npm run dev）で開くと /api/... を呼ぶ。
// 切り替えは自動（本物のサーバーが js/mode.js で API_MODE を 'server' にする）。
//
// 2026-11-06: Re-Ray_Server（src/）に取り込んだ。本物のサーバーの API は INTERFACES §4 の形
//   （端末ID は 'dev-001'、owner、position.no、時刻は +09:00 など）なので、
//   **画面が使ってきた形（偽のサーバー mock.js と同じ形）に、ここで直す**。画面の HTML・common.js は変えていない。

const CONFIG = {
  API_MODE: 'mock',        // 'mock' か 'server'
  API_BASE: '/api',        // 本物のサーバーの場所
  POLL_MS: 2000,           // 新着を取りに行く間隔（ミリ秒）
  BODY_MAX: 40,            // 本文の上限（暫定。本物のサーバーでは mode.js がサーバーの値で上書きする）
  DEV_TOOLS: false,        // テスト用の操作欄を出すか（偽のサーバーでは常に出す。本物はサーバーが決める）
};

async function http(method, path, body) {
  const res = await fetch(CONFIG.API_BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `サーバーのエラー（${res.status}）`;
    // サーバーは {"error": "コード", "message": "画面に出す文"} を返す（INTERFACES §4.4）
    try { const j = await res.json(); if (j.message || j.error) msg = j.message || j.error; } catch (_) { /* 本文なし */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

function query(obj) {
  const q = new URLSearchParams(Object.entries(obj).filter(([, v]) => v != null && v !== ''));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const isMock = () => CONFIG.API_MODE === 'mock';
const devToolsOn = () => isMock() || CONFIG.DEV_TOOLS;

// ---- 本物のサーバーの形 → 画面の形 ----
const Wire = (() => {
  // 端末ID: 画面は数（1）、サーバーは 'dev-001'
  const toId = (n) => `dev-${String(n).padStart(3, '0')}`;
  const fromId = (s) => (s == null || s === 'all' ? null : Number(String(s).replace(/^dev-/, '')));
  const pos = (p) => (p ? { id: p.no, name: p.name ?? `ポジション${p.no}` } : null);

  // 定型信号・指示コードの名前（変わることはまれなので、ページを開いている間は覚えておく）
  let signalCodes = null;
  let instructionCodes = null;
  const sigCodes = async () => (signalCodes ??= await http('GET', '/signal-codes'));
  const insCodes = async () => (instructionCodes ??= await http('GET', '/instruction-codes'));

  function signal(s, codes) {
    const c = codes.find((x) => x.code === s.code)
      || { name: `不明(${s.code})`, short_name: '不明', priority: 'normal', quantity_unit: null };
    return {
      id: s.id, device_id: fromId(s.device), owner_name: s.owner,
      code: s.code, name: c.name, short_name: c.short_name, is_sos: s.is_sos, priority: c.priority,
      quantity: s.n, quantity_unit: c.quantity_unit, position: pos(s.position),
      via: s.via, received_at: s.at, handled_at: s.handled_at,
      // 2026-11-13 追加: 方角、範囲外の印、端末で押した時刻（null = 端末の時計が合っていない）
      direction: s.dir, out_of_range: s.out_of_range, device_ts: s.device_ts,
    };
  }

  function device(d, codes) {
    return {
      id: fromId(d.id), owner_name: d.owner, position: pos(d.position),
      is_online: d.online, via: d.via, battery: d.battery, has_glass: !!d.glass,
      last_seen_at: d.last_seen_at,
      last_signal: d.last_signal ? signal(d.last_signal, codes) : null,
      open_sos: d.open_sos.map((s) => signal(s, codes)),
    };
  }

  function message(m) {
    const kind = m.kind === 'order' ? 'instruction' : m.source === 'transcript' ? 'transcript' : 'text';
    const s = m.summary;
    const v = {
      id: m.id, kind, dst_device_id: fromId(m.dst),
      dst_name: m.dst === 'all' ? '全員' : (m.dst_owner || m.dst),
      text: m.body, instruction_code: m.icode, position: pos(m.position),
      sent_at: m.sent_at,
      delivery: {
        total: s.total, received: s.acked, accepted: s.accepted, declined: s.declined,
        waiting: s.waiting, lora: s.lora, skipped: s.skipped,
        // サーバーの summary.offline は「送った時に切れていた数」。つながってから届いた分（offline.acked）を分けて、
        // 「5台中5台に届いた（…切れている 1台）」と食い違って見えないようにする（2026-11-13）
        offline: s.offline - (m.offline?.acked ?? 0),
        late: m.offline?.acked ?? 0,
      },
      requires_response: m.requires_response,
    };
    if (m.devices) {
      v.deliveries = m.devices.map((d) => ({
        device_id: fromId(d.id), owner_name: d.owner, via_at_send: d.via_at_send, skipped: d.skipped,
        received_at: d.acked_at, response: d.response, responded_at: d.responded_at,
      }));
    }
    return v;
  }

  // 画面の日付（その日の 0 時〜翌日 0 時、ブラウザの時刻で）→ from・to
  function dayRange(date) {
    if (!date) return {};
    const from = new Date(`${date}T00:00:00`);
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }

  return {
    async getDevices() {
      const [list, codes] = await Promise.all([http('GET', '/devices'), sigCodes()]);
      return list.map((d) => device(d, codes));
    },
    async getDevice(id) {
      const [d, codes] = await Promise.all([http('GET', `/devices/${toId(id)}`), sigCodes()]);
      return device(d, codes);
    },
    async createDevice({ id, owner_name }) {
      await http('POST', '/devices', { id: toId(id), owner: owner_name || null });
      return { id: Number(id) };
    },
    async updateDevice(id, { owner_name }) {
      await http('PUT', `/devices/${toId(id)}`, { owner: owner_name || null });
      return { id: Number(id) };
    },

    async getPositions() {
      return (await http('GET', '/positions')).map((p) => ({ id: p.no, name: p.name, note: p.place, lat: p.lat, lon: p.lon }));
    },
    // 画面は「保存」1 つ。サーバーは 変える（PUT）と 作る（POST）が別なので、無ければ作る
    async savePosition(p) {
      const body = { name: p.name, place: p.note || null, lat: p.lat, lon: p.lon };
      try {
        await http('PUT', `/positions/${p.id}`, body);
      } catch (e) {
        if (e.status !== 404) throw e;
        await http('POST', '/positions', { no: Number(p.id), ...body });
      }
      return { id: Number(p.id), name: p.name, note: p.note, lat: p.lat, lon: p.lon };
    },
    async deletePosition(id) {
      await http('DELETE', `/positions/${id}`);
      return { id: Number(id) };
    },

    getSignalCodes: () => sigCodes(),
    getInstructionCodes: () => insCodes(),

    async sendMessage({ kind, dst_device_id, body, instruction_code, position_id }) {
      const dst = dst_device_id == null ? 'all' : toId(dst_device_id);
      return kind === 'instruction'
        ? http('POST', '/messages', { dst, icode: Number(instruction_code), pos: Number(position_id || 0) })
        : http('POST', '/messages', { dst, body });
    },
    async getMessage(id) {
      return message(await http('GET', `/messages/${id}`));
    },
    async getMessages(o = {}) {
      return (await http('GET', `/messages${query(o)}`)).map(message);
    },

    async getLogs({ device_id, type, date } = {}) {
      const q = { device: device_id ? toId(device_id) : null, type, ...dayRange(date), limit: 500 };
      const [items, codes] = await Promise.all([http('GET', `/logs${query(q)}`), sigCodes()]);
      return items.map((x) => (x.type === 'signal'
        ? { type: 'signal', at: x.at, ...signal(x.signal, codes) }
        : { type: 'message', at: x.at, ...message(x.message) }));
    },
    async getOpenSos() {
      const [list, codes] = await Promise.all([http('GET', '/sos'), sigCodes()]);
      return list.map((s) => signal(s, codes));
    },
    async handleSignal(id) {
      const [s, codes] = await Promise.all([http('POST', `/signals/${id}/handle`), sigCodes()]);
      return signal(s, codes);
    },

    dev: {
      signal: ({ device_id, code, quantity }) =>
        http('POST', '/dev/signal', { device: toId(device_id), code: Number(code), n: quantity ? Number(quantity) : null }),
      toggleOnline: (id) => http('POST', `/dev/devices/${toId(id)}/toggle-online`),
      toggleVia: (id) => http('POST', `/dev/devices/${toId(id)}/toggle-via`),
    },
  };
})();

const Api = {
  getDevices:          ()       => isMock() ? MockServer.getDevices()          : Wire.getDevices(),
  getDevice:           (id)     => isMock() ? MockServer.getDevice(id)         : Wire.getDevice(id),
  createDevice:        (d)      => isMock() ? MockServer.createDevice(d)       : Wire.createDevice(d),
  updateDevice:        (id, d)  => isMock() ? MockServer.updateDevice(id, d)   : Wire.updateDevice(id, d),

  getPositions:        ()       => isMock() ? MockServer.getPositions()        : Wire.getPositions(),
  savePosition:        (p)      => isMock() ? MockServer.savePosition(p)       : Wire.savePosition(p),
  deletePosition:      (id)     => isMock() ? MockServer.deletePosition(id)    : Wire.deletePosition(id),

  getSignalCodes:      ()       => isMock() ? MockServer.getSignalCodes()      : Wire.getSignalCodes(),
  getInstructionCodes: ()       => isMock() ? MockServer.getInstructionCodes() : Wire.getInstructionCodes(),

  sendMessage:         (m)      => isMock() ? MockServer.sendMessage(m)        : Wire.sendMessage(m),
  getMessage:          (id)     => isMock() ? MockServer.getMessage(id)        : Wire.getMessage(id),
  getMessages:         (o = {}) => isMock() ? MockServer.getMessages(o)        : Wire.getMessages(o),

  getLogs:             (f = {}) => isMock() ? MockServer.getLogs(f)            : Wire.getLogs(f),
  getOpenSos:          ()       => isMock() ? MockServer.getOpenSos()          : Wire.getOpenSos(),
  handleSignal:        (id)     => isMock() ? MockServer.handleSignal(id)      : Wire.handleSignal(id),

  // テスト用（偽の端末の操作）。本物のサーバーでは DEV_TOOLS=1 のときだけ使える
  dev: {
    signal:       (o)  => isMock() ? MockServer.simulateSignal(o)        : Wire.dev.signal(o),
    toggleOnline: (id) => isMock() ? MockServer.simulateToggleOnline(id) : Wire.dev.toggleOnline(id),
    toggleVia:    (id) => isMock() ? MockServer.simulateToggleVia(id)    : Wire.dev.toggleVia(id),
    reset: async () => {
      if (isMock()) return MockServer.reset();
      // 本物のサーバーでは DB を消す API は作らない（誰でも記録を消せてしまうため）
      throw new Error('本物のサーバーでは使えません。DB を空にするときは README の手順（docker compose down -v）で');
    },
  },
};
