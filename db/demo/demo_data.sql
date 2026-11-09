SET NAMES utf8mb4;
-- 管理画面を見るための見本（端末 5 台、信号、送信の記録）。**自動では流れない。本番の DB には入れない**
-- 時刻は「流した時刻」からの何秒前、で入れる。
-- 2026-11-06: reray-app/server/sql/02_seed.sql の端末・信号・送信の部分を移した（registered を足した）
--
-- 流し方（db/init の 3 つが流れたあと。パスワードは .env の DB_PASS）:
--   PowerShell:  Get-Content db/demo/demo_data.sql | docker compose exec -T mysql mysql -ureray -p reray
--   Git Bash:    docker compose exec -T mysql mysql -ureray -p reray < db/demo/demo_data.sql

SET time_zone = '+09:00';

INSERT INTO devices (id, owner_name, registered, position_id, is_online, via, battery, has_glass, last_seen_at) VALUES
  (1, '山田', TRUE, 3,    TRUE,  'wifi', 72,  TRUE,  NOW(3) - INTERVAL 112 SECOND),
  (2, '佐藤', TRUE, 2,    TRUE,  'wifi', 91,  TRUE,  NOW(3) - INTERVAL 22 SECOND),
  (3, '鈴木', TRUE, 4,    TRUE,  'lora', 55,  FALSE, NOW(3) - INTERVAL 177 SECOND),
  (4, '高橋', TRUE, 1,    FALSE, 'wifi', 8,   TRUE,  NOW(3) - INTERVAL 2374 SECOND),
  (5, NULL,   TRUE, NULL, TRUE,  'wifi', 100, FALSE, NOW(3) - INTERVAL 7 SECOND);

INSERT INTO signals (id, device_id, seq, code, position_id, quantity, via, received_at, handled_at) VALUES
  (101, 4, 11, 2, 1, NULL, 'wifi', NOW(3) - INTERVAL 3005 SECOND, NULL),
  (102, 1, 21, 1, 3, NULL, 'wifi', NOW(3) - INTERVAL 2665 SECOND, NOW(3) - INTERVAL 2285 SECOND),
  (103, 3, 31, 6, 4, 5,    'lora', NOW(3) - INTERVAL 893 SECOND,  NULL),
  (104, 2, 41, 4, 2, NULL, 'wifi', NOW(3) - INTERVAL 515 SECOND,  NULL),
  (105, 1, 22, 1, 3, NULL, 'wifi', NOW(3) - INTERVAL 123 SECOND,  NULL);

UPDATE devices d
   SET d.last_signal_id = (SELECT MAX(s.id) FROM signals s WHERE s.device_id = d.id);

INSERT INTO messages (id, kind, dst_device_id, body, instruction_code, position_id, seq, publish_state, sent_at) VALUES
  (10, 'transcript',  NULL, '14時半です。各班、持ち場の状況を確認してください', NULL, NULL, 1, 'sent', NOW(3) - INTERVAL 1805 SECOND),
  (11, 'text',        2,    '北口の人の流れを見てください',                     NULL, NULL, 2, 'sent', NOW(3) - INTERVAL 705 SECOND),
  (12, 'instruction', NULL, '本部テントに集合してください',                     2,    1,    3, 'sent', NOW(3) - INTERVAL 305 SECOND);

INSERT INTO message_deliveries (message_id, device_id, via_at_send, is_skipped, received_at, response, responded_at) VALUES
  (10, 1, 'wifi',    FALSE, NOW(3) - INTERVAL 1804 SECOND, NULL, NULL),
  (10, 2, 'wifi',    FALSE, NOW(3) - INTERVAL 1804 SECOND, NULL, NULL),
  (10, 3, 'lora',    TRUE,  NULL,                          NULL, NULL),
  (10, 4, 'wifi',    FALSE, NOW(3) - INTERVAL 1803 SECOND, NULL, NULL),
  (10, 5, 'wifi',    FALSE, NOW(3) - INTERVAL 1804 SECOND, NULL, NULL),
  (11, 2, 'wifi',    FALSE, NOW(3) - INTERVAL 704 SECOND,  NULL, NULL),
  (12, 1, 'wifi',    FALSE, NOW(3) - INTERVAL 304 SECOND,  'accepted', NOW(3) - INTERVAL 296 SECOND),
  (12, 2, 'wifi',    FALSE, NOW(3) - INTERVAL 304 SECOND,  'accepted', NOW(3) - INTERVAL 290 SECOND),
  (12, 3, 'lora',    FALSE, NOW(3) - INTERVAL 299 SECOND,  NULL, NULL),
  (12, 4, 'offline', FALSE, NULL,                          NULL, NULL),
  (12, 5, 'wifi',    FALSE, NOW(3) - INTERVAL 304 SECOND,  NULL, NULL);
