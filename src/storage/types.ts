// 保存の窓口(サーバーのコードと DB のあいだ)
//
// サーバーのコードは、この型だけを使って保存・読み出しをする。DB(MySQL)の表や列は知らない。
// DB の土台(端末IDの型・時刻の時間帯・ENUM・表の名前)は DB の担当と相談中なので
// (docs/DB案の比較_2026-11-06.md)、どれに決まっても、変わるのはこの窓口の実装だけにする。
//
// 決まり
// - 端末ID は JSON と同じ `dev-001` の文字列。数値で持つかどうかは実装の中で変換する(DB-013)。
// - 時刻は Date(中身は UTC)。受信時刻はサーバーが決めて渡す。DB の既定値に任せない(DB-018)。
// - 方針の判断(ack をどの 1 通に対応づけるか、何台に届いたかの数え方など)はサーバーのコードが行う。
//   窓口は、保存と、判断に要る材料を返すことだけをする。

export type DeviceId = string;
export type Via = "wifi" | "lora";

// ---- 原本(events) ----

export type EventDirection = "up" | "down";

/** 原本の結果(DATA_MODEL §4.2) */
export type EventResult =
  | "pending" // 書いた直後。解釈が終わったら下のどれかに変える
  | "accepted"
  | "duplicate"
  | "invalid"
  | "unmatched"
  | "ignored"
  | "sent"
  | "failed";

export interface NewEvent {
  /** 受信・送信した時刻(サーバーの時計) */
  at: Date;
  direction: EventDirection;
  topic: string;
  /** 本文そのまま。バイナリ(up/gw/{出口ID}/lora)は 16 進の文字列にして渡す */
  payload: string;
  result: EventResult;
  note?: string;
}

export type EventId = number;

// ---- 端末(devices) ----

export interface Device {
  id: DeviceId;
  owner: string | null;
  online: boolean;
  via: Via | null;
  battery: number | null;
  glass: boolean | null;
  pos: number | null;
  lat: number | null;
  lon: number | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  /** true = 管理画面で登録した。false = 受信して初めて見つけた(owner は空) */
  registered: boolean;
}

/** status で届いた値。項目が無いもの(undefined)は前の値のまま */
export interface StatusUpdate {
  deviceId: DeviceId;
  receivedAt: Date;
  battery?: number;
  glass?: boolean;
  via?: Via;
  lat?: number;
  lon?: number;
}

// ---- 定型信号(signals) ----

export interface NewSignal {
  deviceId: DeviceId;
  seq: number;
  code: number;
  /** ポジション番号。0 は「場所なし」 */
  pos: number;
  /** 数量(区分の上限)。数を使わない信号では undefined */
  n?: number;
  /** 方角(1〜8)。方角を使わない信号では undefined */
  dir?: number;
  via: Via | null;
  /** 端末が付けた時刻(参考)。無い・未同期なら null */
  deviceTs: Date | null;
  /** サーバーの受信時刻。LoRa 由来は「受信時刻 − age_ms」 */
  receivedAt: Date;
}

export interface Signal extends NewSignal {
  id: number;
}

export type RecordSignalResult =
  | { kind: "saved"; signal: Signal }
  | { kind: "duplicate" };

// ---- 本部から送ったもの(messages)と宛先(message_targets) ----

export type MessageKind = "free" | "order";
export type MessageSource = "web" | "transcript";
export type PublishState = "sent" | "failed";

export interface NewMessage {
  /** pc の連番(0〜65535) */
  seq: number;
  /** 端末ID か "all" */
  dst: DeviceId | "all";
  body: string;
  kind: MessageKind;
  icode?: number;
  pos?: number;
  source: MessageSource;
  sentAt: Date;
}

export interface Message extends NewMessage {
  /** = mid */
  id: number;
  publishState: PublishState | null;
}

export interface MessageTarget {
  deviceId: DeviceId;
  /** 送った時の経路。分母の数え方に使う(INTERFACES §4.1) */
  viaAtSend: Via;
}

export interface Delivery extends MessageTarget {
  /** ack が届いた時刻。まだなら null */
  ackedAt: Date | null;
}

export type RecordAckResult = { kind: "saved" } | { kind: "duplicate" };

// ---- 窓口 ----

export interface Storage {
  // 原本
  /** 原本を書く。解釈の前に呼ぶ(他の表が壊れても作り直せるように) */
  saveEvent(event: NewEvent): Promise<EventId>;
  /** 解釈が終わったら結果を書く */
  setEventResult(id: EventId, result: EventResult, note?: string): Promise<void>;

  // 定型信号
  /**
   * 重複でなければ signal を保存し、端末の行も更新する(無ければ registered = false で作る)。
   * 重複 = 同じ端末・同じ seq の signal が、受信時刻の前後 windowMs 以内にある。
   * **判定と保存は一続きにする**(Wi-Fi と LoRa から同時に届いても 1 件にする。DB-007・DB-017)。
   * 先に届いた方を残し、後から届いた方は何も変えない。
   */
  recordSignal(signal: NewSignal, windowMs: number): Promise<RecordSignalResult>;
  /** 端末の最新の signal(受信時刻がいちばん新しいもの) */
  getLastSignal(deviceId: DeviceId): Promise<Signal | null>;

  // 端末
  /** status を反映する(無ければ registered = false で作る)。online は true になる */
  recordStatus(update: StatusUpdate): Promise<void>;
  /** 何か届いたとき(ack など)。last_seen_at と online を更新する。無ければ作る */
  touchDevice(deviceId: DeviceId, at: Date): Promise<void>;
  /** online を変える(遺言・時間切れ)。last_seen_at は変えない。端末が無ければ何もしない */
  setOnline(deviceId: DeviceId, online: boolean): Promise<void>;
  /** 管理画面での登録。既にあれば持ち主の名前を入れて registered = true にする */
  registerDevice(deviceId: DeviceId, owner: string | null, at: Date): Promise<Device>;
  /** 持ち主の名前を変える。端末が無ければ null */
  updateOwner(deviceId: DeviceId, owner: string | null): Promise<Device | null>;
  getDevice(deviceId: DeviceId): Promise<Device | null>;
  listDevices(): Promise<Device[]>;

  // 本部から送ったもの
  /** 送る前に呼ぶ。messages と宛先を一続きに書き、id(= mid)を返す */
  createMessage(message: NewMessage, targets: MessageTarget[]): Promise<Message>;
  setPublishState(messageId: number, state: PublishState): Promise<void>;
  getMessage(messageId: number): Promise<Message | null>;
  /** 再起動したとき、pc の連番をこの次から始める。1 通も無ければ null */
  getLastMessageSeq(): Promise<number | null>;
  /**
   * seq が一致し、since より後に送った messages を、新しい順に返す。
   * ack_seq だけの ack や、LoRa の ACK(ref_seq)の対応づけに使う。どれを選ぶかはサーバーが決める
   */
  findMessagesBySeq(seq: number, since: Date): Promise<Message[]>;

  // 届いた確認
  /** 同じ 1 通・同じ端末の 2 回目は保存しない(最初の時刻を残す) */
  recordAck(messageId: number, deviceId: DeviceId, ackedAt: Date): Promise<RecordAckResult>;
  /** 1 通の宛先と、それぞれの ack の時刻 */
  getDeliveries(messageId: number): Promise<Delivery[]>;
}
