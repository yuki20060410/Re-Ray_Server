# db/init

MySQL のコンテナを**はじめて**起動したときに、ここにある `.sql` が名前の順に流れる。

| ファイル | 中身 | 持ち主 |
|---|---|---|
| `01_schema.sql` | 表(B 案。すみださんのテーブル定義案を、やまさんが SQL にしたもの) | DB の担当 |
| `02_seed.sql` | 一覧表の最初の中身(ポジション・定型信号・指示コード。仮) | DB の担当(`src/storage/seed.ts` と同じ中身にそろえる) |
| `03_server.sql` | サーバーが B 案に足してほしいもの(外部キーを外す、`events`、`registered` など。2026-11-24 にチャンネル・設定の版・音声・`devices.mode`・本文 255 文字を追加)。DB修正依頼の案(`docs/DB案の比較_2026-11-06.md` §6・§7) | サーバー(DB の担当が取り込んだら消す) |

- 2回目以降の起動では流れない。表を作り直すときは `docker compose down -v` で DB のデータごと消してから起動する(**データが全部消える**ので注意)。
- データを消さずに手で流すときは、名前の順に 01 → 02 → 03(01 は表を全部消して作り直す):
  `Get-Content db/init/01_schema.sql | docker compose exec -T mysql mysql -uroot -p reray`(PowerShell。02・03 も同じ)
- 画面を見るための見本(端末 5 台など)は `../demo/demo_data.sql`。自動では流れない。
- 2026-11-06: `reray-app/server/sql/` から 01・02 を移し、03 を足した。
- 2026-11-24: 03 にチャンネル(`channels`・`channel_members`)、設定の版(`server_settings`)、音声(`voice_clips`)、`devices.mode`、`messages.channel_id`・`from_device_id`、`messages.body` 255 文字を足した。**今ある DB に入れるには作り直しが要る**(上の手順)。
