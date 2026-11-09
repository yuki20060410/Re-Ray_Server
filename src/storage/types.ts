// 保存の窓口(サーバーのコードと DB のあいだ)
//
// サーバーのコードは、この型だけを使って保存・読み出しをする。DB(MySQL)の表や列は知らない。
// DB の土台(端末IDの型・時刻の時間帯・ENUM・表の名前)は DB の担当と相談中なので
// (docs/DB案の比較_2026-11-06.md)、どれに決まっても、変わるのはこの窓口の実装だけにする。
//
// 決まり
// - 端末ID は JSON と同じ `dev-001` の文字列。数値で持つかどうかは実装の中で変換する(DB-013)。
// - 時刻は Date(中身は UTC)。受信時刻はサーバーが決めて渡す。DB の既定値に任せない(DB-018)。
// - 方針の判断(ack をどの 1 通に対応づけるか、何台に届いたかの数え方、いつ「切れた」にするか など)は
//   サーバーのコードが行う。窓口は、保存と、判断に要る材料を返すことだけをする。
// - ポジション番号 0 は「場所なし」。窓口の外では 0、表の中で NULL にするかは実装が決める。
//
// 2026-11-06: reray-app(B 案の表で作られた試作)から取り込むため、次を足した
//   一覧表(ポジション・定型信号・指示コード)、SOS の対応済み、了解/できない、LoRa 中で送らなかった印、
//   記録の検索、「切れた」の理由

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
  /** 今のポジション(最新の signal の pos)。0(場所なし)・まだ無いときは null */
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

/** 「切れた」の理由(B 案の device_events.kind) */
export type OfflineCause = "lastwill" | "timeout";

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
  /** 【案】n・dir が区分外・範囲外(サーバーが判定して渡す。B 案の is_out_of_range)。省略は false */
  outOfRange?: boolean;
}

export interface Signal extends NewSignal {
  id: number;
  outOfRange: boolean;
  /** 【案】SOS を本部で「対応済み」にした時刻(B 案の handled_at)。まだなら null */
  handledAt: Date | null;
}

export type RecordSignalResult =
  | { kind: "saved"; signal: Signal }
  | { kind: "duplicate" };

/** 記録の検索。どれも省略できる。新しい順に返す */
export interface SignalFilter {
  deviceId?: DeviceId;
  /** この番号の signal だけ(SOS だけ、など。どの番号が SOS かはサーバーが決める) */
  codes?: number[];
  /** true なら、まだ対応済みにしていないものだけ */
  unhandledOnly?: boolean;
  /** 受信時刻が from 以上 */
  from?: Date;
  /** 受信時刻が to より前 */
  to?: Date;
  limit: number;
}

// ---- 一覧表(positions・signal_codes・instruction_codes)【案】 ----

export interface Position {
  /** ポジション番号(1〜255) */
  no: number;
  name: string;
  /** 場所の説明(B 案の note) */
  place: string | null;
  lat: number | null;
  lon: number | null;
  updatedAt: Date;
}

export type PositionInput = Omit<Position, "updatedAt">;

export type Rule = "required" | "optional" | "none";

/** 定型信号の名前など(B 案の signal_codes。今は読むだけ) */
export interface SignalCode {
  code: number;
  name: string;
  shortName: string;
  glassText: string;
  positionRule: Rule;
  quantityRule: Rule;
  quantityUnit: string | null;
  hasDirection: boolean;
  priority: "highest" | "high" | "normal";
  isSos: boolean;
}

/** 指示コード(B 案の instruction_codes) */
export interface InstructionCode {
  code: number;
  name: string;
  usesPosition: boolean;
  /** 「{ポジション名}へ移動してください」 */
  textWithPos: string | null;
  /** 「その場で待機してください」 */
  textWithoutPos: string | null;
  /** 了解・できない を求めるか */
  requiresResponse: boolean;
  strength: "required" | "request" | "report" | null;
}

// ---- 本部から送ったもの(messages)と宛先(message_targets) ----

export type MessageKind = "free" | "order";
export type MessageSource = "web" | "transcript";
export type PublishState = "sent" | "failed";

export interface NewMessage {
  /** pc の連番(0〜65535) */
  seq: number;
  /** 端末ID か "all" */
  dst: DeviceId | "all";
  /** 端末に出す文。指示コードの形では、指示コード表とポジション表から作った文 */
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

/** 送った時の経路。offline = 送った時に切れていた(B 案) */
export type ViaAtSend = Via | "offline";

export interface MessageTarget {
  deviceId: DeviceId;
  /** 送った時の経路。分母の数え方に使う(INTERFACES §4.1) */
  viaAtSend: ViaAtSend;
  /** 【案】自由な文を、送った時に LoRa だった端末に宛てた(LoRa では運ばない。B 案の is_skipped)。省略は false */
  skipped?: boolean;
}

/** 【案】指示への返事(B 案。ack_kind 4 = 了解、5 = できない) */
export type AckResponse = "accepted" | "declined";

export interface Delivery extends MessageTarget {
  skipped: boolean;
  /** ack が届いた時刻。まだなら null */
  ackedAt: Date | null;
  response: AckResponse | null;
  respondedAt: Date | null;
}

/**
 * saved = 何か変わった(初めての ack、初めての返事)。duplicate = 前に記録済みで、何も変えていない。
 * not_target = その端末はその 1 通の宛先ではない(記録しない)
 */
export type RecordAckResult = { kind: "saved" } | { kind: "duplicate" } | { kind: "not_target" };

export interface MessageFilter {
  /** この端末を宛先に含むもの */
  deviceId?: DeviceId;
  from?: Date;
  to?: Date;
  limit: number;
}

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
  /** 何台ぶんかの最新の signal をまとめて(端末一覧用)。signal の無い端末は入らない */
  getLastSignals(deviceIds: DeviceId[]): Promise<Map<DeviceId, Signal>>;
  getSignal(id: number): Promise<Signal | null>;
  listSignals(filter: SignalFilter): Promise<Signal[]>;
  /** 【案】SOS を対応済みにする。もう対応済みなら最初の時刻のまま。無ければ null */
  handleSignal(id: number, at: Date): Promise<Signal | null>;

  // 端末
  /** status を反映する(無ければ registered = false で作る)。online は true になる */
  recordStatus(update: StatusUpdate): Promise<void>;
  /** 何か届いたとき(ack など)。last_seen_at と online を更新する。無ければ作る */
  touchDevice(deviceId: DeviceId, at: Date): Promise<void>;
  /**
   * online = false にする(遺言・時間切れ)。last_seen_at は変えない。
   * seenBefore があれば、last_seen_at がそれより前のときだけ変える(判定のあいだに届いた分を「切れた」にしない)。
   * 変えたら true。端末が無い・もう切れているなら false
   */
  markOffline(deviceId: DeviceId, cause: OfflineCause, at: Date, seenBefore?: Date): Promise<boolean>;
  /** 管理画面での登録。既にあれば持ち主の名前を入れて registered = true にする */
  registerDevice(deviceId: DeviceId, owner: string | null, at: Date): Promise<Device>;
  /** 持ち主の名前を変える。端末が無ければ null */
  updateOwner(deviceId: DeviceId, owner: string | null): Promise<Device | null>;
  getDevice(deviceId: DeviceId): Promise<Device | null>;
  /** 端末ID の番号の順 */
  listDevices(): Promise<Device[]>;

  // 一覧表【案】
  /** 番号の順 */
  listPositions(): Promise<Position[]>;
  /** 作る。同じ番号が既にあれば null */
  createPosition(position: PositionInput, at: Date): Promise<Position | null>;
  /** 変える。無ければ null */
  updatePosition(position: PositionInput, at: Date): Promise<Position | null>;
  /** 消す。過去の記録の pos は番号のまま残る。無ければ false */
  deletePosition(no: number): Promise<boolean>;
  /** 番号の順 */
  listSignalCodes(): Promise<SignalCode[]>;
  /** 番号の順 */
  listInstructionCodes(): Promise<InstructionCode[]>;
  /** 作る。同じ番号が既にあれば null */
  createInstructionCode(code: InstructionCode): Promise<InstructionCode | null>;
  /** 変える。無ければ null */
  updateInstructionCode(code: InstructionCode): Promise<InstructionCode | null>;

  // 本部から送ったもの
  /** 送る前に呼ぶ。messages と宛先を一続きに書き、id(= mid)を返す。宛先の端末が無ければ作る */
  createMessage(message: NewMessage, targets: MessageTarget[]): Promise<Message>;
  setPublishState(messageId: number, state: PublishState): Promise<void>;
  getMessage(messageId: number): Promise<Message | null>;
  /** 新しい順 */
  listMessages(filter: MessageFilter): Promise<Message[]>;
  /** 再起動したとき、pc の連番をこの次から始める。1 通も無ければ null */
  getLastMessageSeq(): Promise<number | null>;
  /**
   * seq が一致し、since より後に送った messages を、新しい順に返す。
   * ack_seq だけの ack や、LoRa の ACK(ref_seq)の対応づけに使う。どれを選ぶかはサーバーが決める
   */
  findMessagesBySeq(seq: number, since: Date): Promise<Message[]>;

  // 届いた確認
  /**
   * 届いた確認を残す。同じ 1 通・同じ端末の 2 回目は時刻を変えない(最初の時刻を残す)。
   * response があれば返事も残す(最初の返事だけ)。返事が先に来ても「届いた」も入れる。
   */
  recordAck(messageId: number, deviceId: DeviceId, ackedAt: Date, response?: AckResponse): Promise<RecordAckResult>;
  /** 1 通の宛先と、それぞれの ack の時刻(端末ID の番号の順) */
  getDeliveries(messageId: number): Promise<Delivery[]>;
  /** 何通かぶんをまとめて(一覧用) */
  listDeliveries(messageIds: number[]): Promise<Map<number, Delivery[]>>;

  /** つながりを閉じる(止めるとき) */
  close(): Promise<void>;
}
