SET NAMES utf8mb4;  -- 日本語を正しく読ませる（Docker の初期化では指定しないと文字化けする）
-- Re-Ray の表（Drive「サーバーサイド/2026-10-23_テーブル定義_案.md」の §4 から作った）
-- 2026-11-06 の変更: message_deliveries に is_skipped を追加
--
-- 【このファイルは DB の担当の B 案（すみださんのテーブル定義案）を、やまさんが SQL にしたもの】
-- 2026-11-06 に reray-app/server/sql/01_schema.sql から中身を変えずに移した。
-- サーバーが足してほしいもの（外部キーを外す、events など）は 03_server.sql に分けてある。
-- ここを直すときは DB の担当と相談する。
-- 何度流しても同じ状態になるよう、最初に全部消す
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS admins, device_events, message_deliveries, messages, signals, lora_frames, devices, instruction_codes, signal_codes, positions;
SET FOREIGN_KEY_CHECKS = 1;

SET time_zone = '+09:00';

-- ポジション
CREATE TABLE positions (
  id          TINYINT UNSIGNED PRIMARY KEY,          -- 1〜255（0 は「場所なし」で、表には入れない）
  name        VARCHAR(30) NOT NULL,
  note        VARCHAR(100),
  lat         DECIMAL(9,6),
  lon         DECIMAL(9,6),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_positions_id CHECK (id >= 1)
);

-- 定型信号（統合案 §2.2 の一覧の形）
CREATE TABLE signal_codes (
  code            TINYINT UNSIGNED PRIMARY KEY,      -- 1〜31。1 = SOS
  name            VARCHAR(20) NOT NULL,              -- 「要救助者あり」
  short_name      VARCHAR(10) NOT NULL,              -- 本部の画面の短い名前「要救助」
  glass_text      VARCHAR(40) NOT NULL,              -- 「送信:要救助者あり {数}人」
  position_rule   ENUM('required','optional','none') NOT NULL,  -- ポジションを添えるか
  quantity_rule   ENUM('required','optional','none') NOT NULL,  -- 数量 n を使うか
  quantity_unit   VARCHAR(10),                       -- 「人」「食」
  has_direction   BOOLEAN NOT NULL DEFAULT FALSE,    -- 方角 dir を使うか
  priority        ENUM('highest','high','normal') NOT NULL DEFAULT 'normal',
  is_sos          BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT chk_signal_codes_code CHECK (code BETWEEN 1 AND 31)
);

-- 指示コード（統合案 §2.3 の一覧の形）
CREATE TABLE instruction_codes (
  code               TINYINT UNSIGNED PRIMARY KEY,   -- 1〜255
  name               VARCHAR(20) NOT NULL,
  uses_position      BOOLEAN NOT NULL,
  text_with_pos      VARCHAR(40),                    -- 「{ポジション名}へ移動してください」
  text_without_pos   VARCHAR(40),                    -- 「その場で待機してください」
  requires_response  BOOLEAN NOT NULL DEFAULT TRUE,  -- 了解・できない を求めるか
  strength           ENUM('required','request','report'),  -- 必須／依頼／報告依頼（未決なので空でもよい）
  CONSTRAINT chk_instruction_codes_code CHECK (code >= 1),
  CONSTRAINT chk_instruction_codes_text CHECK (
    (uses_position AND text_with_pos IS NOT NULL) OR (NOT uses_position AND text_without_pos IS NOT NULL))
);

-- 端末（いまの状態）
CREATE TABLE devices (
  id            SMALLINT UNSIGNED PRIMARY KEY,       -- 1 = dev-001
  owner_name    VARCHAR(30),
  position_id   TINYINT UNSIGNED,
  is_online     BOOLEAN NOT NULL DEFAULT FALSE,      -- 書き換えるのはサーバーだけ
  via           ENUM('wifi','lora'),
  battery       TINYINT UNSIGNED,
  has_glass     BOOLEAN NOT NULL DEFAULT FALSE,
  lat           DECIMAL(9,6),
  lon           DECIMAL(9,6),
  last_seen_at  DATETIME(3),
  last_signal_id BIGINT UNSIGNED,                   -- 最新の信号（端末一覧で使う。外部キーは最後に ALTER で付ける）
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_devices_id      CHECK (id BETWEEN 1 AND 65534),
  CONSTRAINT chk_devices_battery CHECK (battery <= 100),
  CONSTRAINT fk_devices_positions FOREIGN KEY (position_id) REFERENCES positions(id)
);

-- 出口から届いた LoRa のフレーム（生のまま）
CREATE TABLE lora_frames (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  gateway_device_id  SMALLINT UNSIGNED NOT NULL,     -- 出口の端末
  raw                VARBINARY(64) NOT NULL,         -- フレームのバイト列そのまま
  rssi               SMALLINT,                       -- dBm
  snr                TINYINT,                        -- dB × 4（符号つき）
  age_ms             INT UNSIGNED,                   -- 出口が溜めていた時間
  is_valid_mic       BOOLEAN,                        -- 署名が合ったか
  received_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_lora_frames_received_at (received_at),
  CONSTRAINT fk_lora_frames_devices FOREIGN KEY (gateway_device_id) REFERENCES devices(id)
);

-- 届いた定型信号（現場→本部）
CREATE TABLE signals (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id        SMALLINT UNSIGNED NOT NULL,
  seq              SMALLINT UNSIGNED NOT NULL,       -- 8 / 16 ビットどちらでも入る
  code             TINYINT UNSIGNED NOT NULL,
  position_id      TINYINT UNSIGNED,                 -- 0 は NULL にして入れる
  quantity         TINYINT UNSIGNED,                 -- n（5〜100）
  direction        TINYINT UNSIGNED,                 -- dir（1〜8、1 = 北）
  is_out_of_range  BOOLEAN NOT NULL DEFAULT FALSE,   -- 区分外・範囲外でも捨てずに印を付ける
  via              ENUM('wifi','lora') NOT NULL,
  lora_frame_id    BIGINT UNSIGNED,                  -- LoRa で届いたときの元データ
  device_ts        DATETIME,
  received_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  handled_at       DATETIME(3),                      -- SOS を「対応済み」にした時刻
  INDEX idx_signals_dup         (device_id, seq, received_at),
  INDEX idx_signals_received_at (received_at),
  INDEX idx_signals_device_id   (device_id, received_at),  -- W3 端末ごとの記録
  INDEX idx_signals_code        (code, received_at),       -- W2 SOS、W5 種類でしぼる
  CONSTRAINT fk_signals_devices      FOREIGN KEY (device_id)     REFERENCES devices(id),
  CONSTRAINT fk_signals_signal_codes FOREIGN KEY (code)          REFERENCES signal_codes(code),
  CONSTRAINT fk_signals_positions    FOREIGN KEY (position_id)   REFERENCES positions(id),
  CONSTRAINT fk_signals_lora_frames  FOREIGN KEY (lora_frame_id) REFERENCES lora_frames(id)
);

-- 本部から送ったもの（id = mid）
CREATE TABLE messages (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kind              ENUM('text','instruction','transcript') NOT NULL,
  dst_device_id     SMALLINT UNSIGNED,               -- NULL = 全員
  body              VARCHAR(40),                     -- 上限はグラスの文字数しだい（リーダーに質問中）
  instruction_code  TINYINT UNSIGNED,
  position_id       TINYINT UNSIGNED,
  seq               SMALLINT UNSIGNED NOT NULL,      -- 本部の連番
  sent_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_messages_seq     (seq, sent_at),         -- LoRa の返事（ref_seq）から mid を引く
  INDEX idx_messages_sent_at (sent_at),
  INDEX idx_messages_dst     (dst_device_id, sent_at), -- W3 この端末宛ての指示
  CONSTRAINT chk_messages_instruction CHECK (kind <> 'instruction' OR instruction_code IS NOT NULL),
  CONSTRAINT chk_messages_body        CHECK (kind =  'instruction' OR body IS NOT NULL),
  CONSTRAINT fk_messages_devices           FOREIGN KEY (dst_device_id)    REFERENCES devices(id),
  CONSTRAINT fk_messages_instruction_codes FOREIGN KEY (instruction_code) REFERENCES instruction_codes(code),
  CONSTRAINT fk_messages_positions         FOREIGN KEY (position_id)      REFERENCES positions(id)
);

-- 誰に送って、どう返ってきたか
CREATE TABLE message_deliveries (
  message_id    BIGINT UNSIGNED NOT NULL,
  device_id     SMALLINT UNSIGNED NOT NULL,
  via_at_send   ENUM('wifi','lora','offline') NOT NULL,
  is_skipped    BOOLEAN NOT NULL DEFAULT FALSE,          -- 2026-11-06 追加: LoRa 中の端末に文字を送れなかった
  received_at   DATETIME(3),                         -- 受け取った（ack 種類 3）
  response      ENUM('accepted','declined'),         -- 了解（4）／できない（5）
  responded_at  DATETIME(3),
  PRIMARY KEY (message_id, device_id),
  CONSTRAINT fk_message_deliveries_messages FOREIGN KEY (message_id) REFERENCES messages(id),
  CONSTRAINT fk_message_deliveries_devices  FOREIGN KEY (device_id)  REFERENCES devices(id)
);

-- つながった・切れたの記録
CREATE TABLE device_events (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id   SMALLINT UNSIGNED NOT NULL,
  kind        ENUM('online','lastwill','timeout') NOT NULL,
  battery     TINYINT UNSIGNED,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_device_events_device_id (device_id, created_at),
  CONSTRAINT fk_device_events_devices FOREIGN KEY (device_id) REFERENCES devices(id)
);

-- 管理者のログイン
CREATE TABLE admins (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  login_id       VARCHAR(30)  NOT NULL UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,
  name           VARCHAR(30)  NOT NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

-- devices と signals がお互いを指すので、devices → signals の外部キーは最後に付ける
ALTER TABLE devices
  ADD CONSTRAINT fk_devices_signals FOREIGN KEY (last_signal_id) REFERENCES signals(id);
