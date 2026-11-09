# Re-Ray 管理画面（本部の画面）

担当: やま ／ 作成: 2026-11-06 ／ 状態: 全画面が、偽のサーバー（mock.js）と本物のサーバー（src/）の両方で動く

> 2026-11-06: やまさんの `reray-app/admin` を、Re-Ray_Server の `web/` に取り込んだ。
> 本物のサーバーは `reray-app/server`（JavaScript）から `src/`（TypeScript）に替わり、API の形は `docs/INTERFACES_2026-10-23.md` §4 になった。
> 画面の HTML・`common.js` はそのまま。形の違いは `js/api.js` の中で直している（下の「本物のサーバーにつなぐとき」）。

素の HTML + CSS + JavaScript。ビルドや追加のインストールはいらない。

## 開き方

| どれで開くか | コマンド（リポジトリの直下で） | 開く場所 |
|---|---|---|
| 本物のサーバー | `npm run dev`（手順はリポジトリの README §6） | http://localhost:3000 |
| 偽のサーバー（画面だけを試す） | `npm run web:mock` | http://localhost:8080 |

（HTML をダブルクリックで開くと、偽データの JSON が読めずに動かない）

## 画面

| 番号 | ファイル | できること |
|---|---|---|
| W2 | `index.html` | 端末一覧。SOS → 切れた → それ以外の順。2秒ごとに更新。「テスト用」の操作欄（偽のサーバー、または本物のサーバーを `DEV_TOOLS=1` で起動したとき） |
| W3 | `device.html?id=1` | 1台の状態、その人に送る、その端末とのやり取り、SOS を対応済みにする |
| W4 | `broadcast.html` | 全員に送る（確認つき）、届いた数、最近送ったもの |
| W5 | `logs.html` | 記録。端末・種類・日付でしぼる |
| W6 | `devices.html` | 端末の番号と持つ人の名前のひも付け |
| W8 | `positions.html` | ポジション（1〜255）に名前・メモ・緯度経度を付ける |
| 全画面 | `js/common.js` | SOS が届くと、画面の上に赤い帯・音・タブの題名の点滅。帯から「対応済みにする」 |

作っていないもの: W1 ログイン、W7 地図（どちらも「できれば」）。

送るものは2種類:
- **文字**: 上限 40 文字（暫定。本物のサーバーでは `src/server/sender.ts` の `BODY_MAX` が `js/mode.js` で届く）。LoRa でつながっている端末には送れない
- **指示**: 指示コード＋ポジション番号。LoRa の端末にも届く

## ファイルの役割

```
js/api.js     サーバーとの窓口。画面は Api.xxx() だけを使う。本物の API の形 → 画面の形 もここで直す
js/mock.js    偽のサーバー。mock/*.json を読み、ブラウザの localStorage に保存して書き換える
js/mode.js    偽のサーバーでは空。本物のサーバーが同じ名前で「server に切り替える」中身を返す
js/common.js  メニュー、SOS の帯、送信欄、記録の行、時刻の書き方など
css/style.css 見た目
mock/*.json   偽データ（表ごと。B 案のテーブル定義に近い形）
serve.js      偽のサーバーで開くための小さなサーバー（npm run web:mock）
```

偽データを最初に戻すには、端末一覧の「テスト用」→「偽データを最初に戻す」（偽のサーバーのときだけ。本物のサーバーには DB を消す API を作らない）。

## 本物のサーバーにつなぐとき

本物のサーバーで開くと、サーバーが `js/mode.js` で `CONFIG.API_MODE = 'server'` にし、`js/api.js` が `/api/...` を呼ぶ。
API の一覧と形は `docs/INTERFACES_2026-10-23.md` §4。画面とのおもな違いと、`api.js` での直し方:

| 画面の形（mock.js と同じ） | 本物の API の形 | api.js での直し方 |
|---|---|---|
| 端末 `id: 1` | `id: "dev-001"` | 数 ⇔ `dev-001` を付け替える |
| `owner_name`、`is_online`、`has_glass` | `owner`、`online`、`glass` | 名前を付け替える |
| `position: {id, name}` | `position: {no, name}` | `no` → `id` |
| 信号の `name`・`short_name`・`quantity_unit` | 信号は `code` だけ | `/api/signal-codes` を 1 回読んで名前を付ける |
| 送信 `{kind, dst_device_id, body, instruction_code, position_id}` | `{dst, body}` か `{dst, icode, pos}` | 付け替える。`dst_device_id: null` → `"all"` |
| 届いた数 `delivery` | `summary`（`acked` = 届いた） | 付け替える |
| ポジションの保存は PUT 1 つ | 作る POST・変える PUT | PUT して 404 なら POST |
| 記録 `?device_id=&type=&date=` | `?device=&type=&from=&to=` | 日付をその日の 0 時〜翌 0 時にする |
| エラー `{error: 文}` | `{error: コード, message: 文}` | `message` を出す |

時刻は、本物のサーバーは日本時間（`+09:00`）の ISO 8601 で返す。画面はそのまま `new Date()` で読める。

## まだ決まっていないこと

- 本文の上限（グラスに何文字出せるか。リーダーに質問中）
- 定型信号と指示コードの一覧（`mock/` と `db/init/02_seed.sql` のものは仮）
- 新着の取り方（今は 2 秒ごとに全部取りに行く。差分や SSE にするかはサーバーと相談。INTERFACES §5）
- 「切れた」と見なす秒数（サーバーが `online` を決める。今は Wi-Fi 90 秒・LoRa 15 分）
