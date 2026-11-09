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
