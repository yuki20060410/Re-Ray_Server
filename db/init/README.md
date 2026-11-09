# db/init

MySQL のコンテナを**はじめて**起動したときに、ここにある `.sql` が名前の順に流れる。

| ファイル | 中身 | 持ち主 |
|---|---|---|
| `01_schema.sql` | 表(B 案。すみださんのテーブル定義案を、やまさんが SQL にしたもの) | DB の担当 |
| `02_seed.sql` | 一覧表の最初の中身(ポジション・定型信号・指示コード。仮) | DB の担当(`src/storage/seed.ts` と同じ中身にそろえる) |
| `03_server.sql` | サーバーが B 案に足してほしいもの(外部キーを外す、`events`、`registered` など)。DB修正依頼の案 | サーバー(DB の担当が取り込んだら消す) |

- 2回目以降の起動では流れない。表を作り直すときは `docker compose down -v` で DB のデータごと消してから起動する(**データが全部消える**ので注意)。
- データを消さずに手で流すときは、名前の順に 01 → 02 → 03(01 は表を全部消して作り直す):
  `Get-Content db/init/01_schema.sql | docker compose exec -T mysql mysql -uroot -p reray`(PowerShell。02・03 も同じ)
- 画面を見るための見本(端末 5 台など)は `../demo/demo_data.sql`。自動では流れない。
- 2026-11-06: `reray-app/server/sql/` から 01・02 を移し、03 を足した。
