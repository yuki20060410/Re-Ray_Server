SET NAMES utf8mb4;
-- サーバーが B 案（01_schema.sql）に足してほしいもの【DB修正依頼の案。DB の担当の返事待ち】
--
-- 2026-11-06 作成。理由は docs/DB案の比較_2026-11-06.md の §3・§5・§6。
-- 01_schema.sql を流したあとに流す（01 を流し直したら、これも流し直す）。
-- DB の担当が 01_schema.sql に取り込んだら、その分をここから消す。

-- ---- DB-016: 信号・端末・送信の、ポジションと定型信号のコードに外部キーを付けない ----
-- 付けると、一覧に無い番号の信号が書けずに落ちる（INTERFACES §2.5「未定義のコードも保存する」）。
-- ポジションを消しても、過去の記録の番号は残す（INTERFACES §4.3）。名前は引くときに付け、無ければ番号のまま出す
ALTER TABLE signals
  DROP FOREIGN KEY fk_signals_signal_codes,
  DROP FOREIGN KEY fk_signals_positions;
ALTER TABLE devices  DROP FOREIGN KEY fk_devices_positions;
ALTER TABLE messages DROP FOREIGN KEY fk_messages_positions;

-- ---- DB-019（新）: 分からない値は NULL で持つ ----
-- 経路の分からない signal（JSON に via が無い）と、グラスの有無がまだ届いていない端末を、
-- wifi・false と区別するため
ALTER TABLE signals MODIFY via ENUM('wifi','lora') NULL;
ALTER TABLE devices MODIFY has_glass BOOLEAN NULL DEFAULT NULL;

-- ---- 比較 §5: 登録したか（registered）と、流せたか（publish_state）----
-- registered: FALSE = 受信して初めて見つけた端末（INTERFACES §3。管理画面で登録すると TRUE）
-- publish_state: MQTT に流せたか。流せなければ failed で残す（INTERFACES §4.1）
ALTER TABLE devices  ADD COLUMN registered    BOOLEAN NOT NULL DEFAULT FALSE AFTER owner_name;
ALTER TABLE messages ADD COLUMN publish_state ENUM('sent','failed') NULL AFTER seq;

-- ---- 比較 §5: 受信・送信の原本（events。DATA_MODEL §4.2）----
-- 解釈の前に、受け取ったそのままを残す（壊れた JSON・遺言・下りの記録も）。lora_frames は LoRa の生データ用で別
DROP TABLE IF EXISTS events;
CREATE TABLE events (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  at          DATETIME(3)  NOT NULL,                  -- 受信・送信した時刻（サーバーの時計）
  direction   VARCHAR(8)   NOT NULL,                  -- up / down
  topic       VARCHAR(255) NOT NULL,
  payload     MEDIUMTEXT   NOT NULL,                  -- 本文そのまま。生渡しのバイナリは 16 進
  result      VARCHAR(16)  NOT NULL,                  -- pending / accepted / duplicate / invalid / unmatched / ignored / sent / failed
  note        VARCHAR(255),                           -- 理由（v!=1、src mismatch など）
  INDEX idx_events_at (at)
);

-- ---- チャンネル【案】（端末からの依頼 2026-11-17 の #1〜3。2026-11-24 追加）----
-- direct = 本部とその端末の 1 対 1（端末ごとに 1 つ。サーバーが作る）、group = 管理画面で作るグループ。
-- 番号（id）は端末とやり取りする ch。端末の都合で、1 台が入れるのは 8 個まで（サーバーのコードで確かめる）
DROP TABLE IF EXISTS channel_members, channels, server_settings;
CREATE TABLE channels (
  id                SMALLINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kind              ENUM('direct','group') NOT NULL,
  name              VARCHAR(30) NOT NULL,
  direct_device_id  SMALLINT UNSIGNED UNIQUE,            -- direct のときの端末（1 台に 1 つ）。group は NULL
  created_at        DATETIME(3) NOT NULL,
  CONSTRAINT fk_channels_devices FOREIGN KEY (direct_device_id) REFERENCES devices(id)
);
CREATE TABLE channel_members (
  channel_id  SMALLINT UNSIGNED NOT NULL,
  device_id   SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (channel_id, device_id),
  INDEX idx_channel_members_device (device_id),
  CONSTRAINT fk_channel_members_channels FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  CONSTRAINT fk_channel_members_devices  FOREIGN KEY (device_id)  REFERENCES devices(id)
);
-- 端末に配る設定の版（config_rev）など、1 つだけの値
CREATE TABLE server_settings (
  name   VARCHAR(32) PRIMARY KEY,
  value  BIGINT NOT NULL
);
-- 文がどのチャンネルのものか、だれが言ったか（NULL = 本部）。チャンネルを消しても番号は残すので外部キーは付けない
ALTER TABLE messages
  ADD COLUMN channel_id      SMALLINT UNSIGNED NULL AFTER dst_device_id,
  ADD COLUMN from_device_id  SMALLINT UNSIGNED NULL AFTER channel_id;

-- ---- 音声【案】（端末からの依頼 2026-11-17 の #4。2026-11-24 追加）----
-- 端末が POST /api/voice で送った音の記録。音のファイルそのものは DB に入れず、サーバーのフォルダー（VOICE_DIR）に置く。
-- 文字起こしが終わったら、チャンネルの文（messages、kind = transcript）として配り、message_id に結ぶ
DROP TABLE IF EXISTS voice_clips;
CREATE TABLE voice_clips (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id    SMALLINT UNSIGNED NOT NULL,             -- 話した端末
  channel_id   SMALLINT UNSIGNED NOT NULL,             -- 宛先のチャンネル（消しても番号は残すので外部キーなし）
  seq          SMALLINT UNSIGNED NOT NULL,             -- 端末の番号（同じ番号がもう一度来たら送り直し）
  duration_ms  INT UNSIGNED NOT NULL,
  bytes        INT UNSIGNED NOT NULL,
  status       ENUM('queued','done','empty','failed') NOT NULL,  -- 文字起こし待ち／配った／声が無かった／あきらめた
  text         TEXT,                                   -- 文字にした文（切り詰める前）
  error        VARCHAR(255),
  message_id   BIGINT UNSIGNED,                        -- 配った messages.id
  attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  received_at  DATETIME(3) NOT NULL,
  done_at      DATETIME(3),
  INDEX idx_voice_clips_dup (device_id, seq, received_at),
  INDEX idx_voice_clips_received_at (received_at),
  CONSTRAINT fk_voice_clips_devices FOREIGN KEY (device_id) REFERENCES devices(id)
);

-- ---- DB-004 に関係: 本文の上限 ----
-- 声を文字にした文は 40 文字に収まらない（端末からの依頼 §4.3）。サーバーは文字起こしの文だけ 200 文字まで送る
-- （src/server/sender.ts の TRANSCRIPT_MAX）。本部が打つ文の上限（40 文字）はグラスの文字数が決まるまで変えない
ALTER TABLE messages MODIFY body VARCHAR(255);

-- ---- モード【案】（端末からの依頼 2026-11-17 の #5。2026-11-24 追加）----
-- 端末が status で知らせる 平常時（normal）／緊急時（emergency）。まだ届いていなければ NULL
ALTER TABLE devices ADD COLUMN mode ENUM('normal','emergency') NULL AFTER has_glass;
