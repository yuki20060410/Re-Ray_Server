SET NAMES utf8mb4;  -- 日本語を正しく読ませる（Docker の初期化では指定しないと文字化けする）
-- Re-Ray の一覧表の最初の中身（ポジション・定型信号・指示コード）
-- 定型信号と指示コードの一覧は仮（チーム未合意。SIGNAL_FORMAT §4 の叩き台、共通仕様 01 の段階0の宿題）
--
-- 2026-11-06: reray-app/server/sql/02_seed.sql の一覧表の部分だけを移した。
--   端末・信号・送信の見本は db/demo/demo_data.sql に分けた（本番の DB に入らないように）。
-- **中身を変えるときは src/storage/seed.ts（メモリ版の最初の中身）も同じに直す。**

SET time_zone = '+09:00';

INSERT INTO positions (id, name, note, lat, lon) VALUES
  (1, '本部テント', '市役所前広場',       35.681200, 139.767100),
  (2, '北口',       '駅の北口ロータリー', 35.682300, 139.766800),
  (3, '体育館前',   '避難所',             35.679900, 139.768500),
  (4, '南橋',       '川の見回り地点',     35.678700, 139.766200);

INSERT INTO signal_codes
  (code, name, short_name, glass_text, position_rule, quantity_rule, quantity_unit, has_direction, priority, is_sos) VALUES
  (1, 'SOS',          'SOS',    '送信:SOS',                 'optional', 'none',     NULL, FALSE, 'highest', TRUE),
  (2, '無事',         '無事',   '送信:無事',                'optional', 'none',     NULL, FALSE, 'normal',  FALSE),
  (3, '了解',         '了解',   '送信:了解',                'none',     'none',     NULL, FALSE, 'normal',  FALSE),
  (4, '到着',         '到着',   '送信:到着',                'optional', 'none',     NULL, FALSE, 'normal',  FALSE),
  (5, '応援を頼む',   '応援',   '送信:応援 {数}人',         'optional', 'required', '人', FALSE, 'high',    FALSE),
  (6, '要救助者あり', '要救助', '送信:要救助者あり {数}人', 'optional', 'required', '人', FALSE, 'high',    FALSE),
  (7, '負傷者あり',   '負傷',   '送信:負傷者あり {数}人',   'optional', 'required', '人', FALSE, 'high',    FALSE),
  (8, '食料がほしい', '食料',   '送信:食料 {数}食',         'optional', 'required', '食', FALSE, 'normal',  FALSE),
  (9, '移動します',   '移動',   '送信:移動します {方角}',   'optional', 'none',     NULL, TRUE,  'normal',  FALSE);

INSERT INTO instruction_codes
  (code, name, uses_position, text_with_pos, text_without_pos, requires_response, strength) VALUES
  (1,  '移動',     TRUE,  '{ポジション名}へ移動してください',       NULL,                         TRUE, NULL),
  (2,  '集合',     TRUE,  '{ポジション名}に集合してください',       NULL,                         TRUE, NULL),
  (3,  '待機',     FALSE, NULL,                                     'その場で待機してください',   TRUE, NULL),
  (6,  '退避',     TRUE,  '{ポジション名}へ退避してください',       NULL,                         TRUE, NULL),
  (20, '応援',     TRUE,  '{ポジション名}の応援に向かってください', NULL,                         TRUE, NULL),
  (40, '状況報告', FALSE, NULL,                                     'いまの状況を報告してください', TRUE, NULL);
