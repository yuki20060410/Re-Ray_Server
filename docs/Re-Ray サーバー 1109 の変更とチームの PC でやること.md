# Re-Ray サーバー 11/09 の変更とチームの PC でやること

Nov 10, 2026 · @時々

11/09 に、やまさんの reray-app を Re-Ray\_Server に取り込み、サーバー(`src/`)と管理画面(`web/`)が 1 つのリポジトリで動くようになった。各自の PC では、コードを取ってきて `npm ci`、`.env` に 4 行足し、DB を作り直せば、http://localhost:3000 で同じものが動く。

## 何が変わったか

サーバーは `src/`(TypeScript)の 1 本になった。reray-app の `server/`(JavaScript)にあった機能は全部ここに移し、`reray-app/` フォルダーは消した。

| 変わったこと | 前 | 今 |
| --- | --- | --- |
| 管理画面 | 別のフォルダー(`reray-app/admin`) | `web/`。サーバーが http://localhost:3000 で配る |
| HTTP API | なし | 端末・送信・届き具合・記録・SOS・ポジション・一覧表(INTERFACES §4、§4.5) |
| 文字・指示の送信 | なし | 保存してから mid を付けて流す。返事(ack)で「何台に届いたか」を数える |
| 「切れた」の判定 | なし | 遺言、または Wi-Fi 90 秒・LoRa 15 分なにも来ないと「切れた」 |
| 保存先 | メモリ(再起動で消える)だけ | MySQL も使える(`.env` の `STORAGE=mysql`)。表は B 案(すみださんの案) |
| 了解・できない、SOS の対応済み | なし | 【案】として足した(ack\_kind 4・5、handled\_at) |
| 偽の端末 | `npm run fake`(1 台を手で) | それに加えて、サーバーの中で動く偽の端末(`DEV_TOOLS=1`) |
| 負荷の試験 | なし | `npm run load-test`(偽の端末 100 台) |
| MySQL の時間帯 | UTC | 日本時間(B 案に合わせた) |
| 足したパッケージ | — | fastify、@fastify/static、mysql2 |

コードは `yuki` ブランチにある。表の定義は `db/init/`、画面は `web/README.md`、使い方の全部はリポジトリの README §6。

## はじめての人:手元に環境を作る

先に Git、Node.js 24、Docker Desktop を入れ、Docker Desktop を起動しておく(左下が緑の「Engine running」)。入れ方は README §6.1 の「前提」。コマンドは VS Code のターミナル(PowerShell)で打つ。

1. コードを取ってきて、`yuki` ブランチに切り替える
   - `git clone https://github.com/yuki20060410/Re-Ray_Server.git`
   - `cd Re-Ray_Server`
   - `git switch yuki`
2. パッケージを入れる:`npm ci`
3. 接続情報のファイルを作る:`Copy-Item .env.example .env`
   - `.env` を開き、`DB_PASS` と `DB_ROOT_PASS` に自分で決めたパスワードを入れる(`.env` は git に入らない)
4. Mosquitto と MySQL を起動する:`npm run docker:up`
   - `docker compose ps` で mysql が `(healthy)` になれば OK。はじめての起動で表が自動で作られる
5. 動くか確かめる
   - `npm test`(89 件が pass なら OK)
   - `npm run dev` で起動し、「保存: MySQL」と出れば OK
   - ブラウザで http://localhost:3000 を開くと管理画面が出る(端末はまだ 0 台)

## もう環境がある人:今回やること

パッケージ・`.env`・DB の 3 つを新しくする。**11/06 より前に MySQL を起動したことがある人は、DB に表が無い**ので、手順 4 が必ず要る。

1. コードを取ってくる:`git switch yuki` → `git pull`
2. パッケージを入れ直す:`npm ci`(fastify・mysql2 などが増えた)
3. `.env` の末尾に 4 行足す(`.env.example` にも同じものがある)
   - `STORAGE=mysql`(無いとメモリ版で動き、再起動で記録が消える)
   - `HTTP_PORT=3000`
   - `DEV_TOOLS=0`
   - `DEV_FAKES=dev-001,dev-002,dev-003`
4. DB を作り直す(**DB の中身は全部消える**)
   - `docker compose down -v` → `npm run docker:up`
   - `db/init/` の 01(表)・02(一覧表)・03(サーバーの追加)が、はじめての起動で自動で流れる
   - compose.yaml の時間帯も変わったので、作り直すとそれも入る
5. 「はじめての人」の手順 5 と同じように確かめる

## 画面で試す(実機なし)

`.env` を `DEV_TOOLS=1` にして `npm run dev` すると、サーバーの中で偽の端末(`DEV_FAKES` に書いた分)が本物と同じ MQTT でつながる。30 秒ごとに状態を送り、届いた文字・指示に返事をする。

| やること | 起きること |
| --- | --- |
| 「全員に送る」で指示を送る | Wi-Fi は約 1 秒、LoRa は約 5 秒で「届いた」。グラスのある端末は数秒後に「了解」(番号が 5 の倍数の端末は「できない」) |
| 「全員に送る」で文字を送る | LoRa 中の端末には運ばず、別に数える |
| 端末一覧の「テスト用」で SOS(1 番)を送る | 全画面の上に赤い帯と音。帯から「対応済みにする」 |
| 「つながりを切り替える」 | 偽の端末が黙って切れ、遺言ですぐ「切れた」 |
| 「経路を切り替える」 | Wi-Fi と LoRa が入れ替わる |

- 画面を見るための見本(端末 5 台・信号・送信の記録)を入れるなら:`Get-Content db/demo/demo_data.sql | docker compose exec -T mysql mysql -ureray -p reray`
- サーバーも Docker もなしで画面だけ見るなら:`npm run web:mock` → http://localhost:8080(偽データ)
- 偽の端末 100 台の負荷の試験:サーバーを動かしたまま `npm run load-test`(dev-1001〜 が DB に残る)

## 実機とつなぐ

端末は PC の Mosquitto(1883 番)につなぐ。PC と端末を同じ Wi-Fi につなぎ、偽の端末を止めてから始める。

**PC 側の準備**

1. `.env` を `DEV_TOOLS=0` にする(偽の端末と実機の ID が同じだと、ブローカーが先の接続を切る)
2. 見本のデータを入れていたら DB を空にする(「つまずきやすい所」の「DB を空にする」)
3. `npm run dev` で起動し、http://localhost:3000 を開いておく
4. PC の IP を調べる:`ipconfig` の「Wi-Fi」の IPv4 アドレス(例 192.168.x.x)
5. まずスマホで確かめる:MQTT のアプリ(MQTT Explorer など)で `<PC の IP>:1883` につながれば、ネットワークは OK
6. つないだ端末を「端末の登録」画面で登録する(登録しないと、その端末だけに個別に送れない。信号と状態は登録しなくても記録される)

**端末に書き込む設定**(`dev-001` の例。形は INTERFACES §1・§2)

| 項目 | 値 |
| --- | --- |
| ブローカー | `<PC の IP>` の 1883 番。MQTT 3.1.1、ユーザー名・パスワード・TLS なし |
| クライアント ID | 端末 ID。`dev-001` の形(3 桁に満たなければ 0 で埋める。`dev-1` は捨てられる) |
| 接続 | clean session = false、keepalive 30 秒 |
| 遺言 | `reray/v1/up/dev-001/status` に `{"v":1,"type":"status","src":"dev-001","online":false}`、QoS 1 |
| 購読 | `reray/v1/down/dev-001/#` と `reray/v1/down/all/#`、QoS 1 |
| 定型信号 | `reray/v1/up/dev-001/signal`、QoS 1:`{"v":1,"type":"signal","src":"dev-001","seq":42,"ts":0,"code":1,"pos":0,"via":"wifi"}` |
| 状態(30 秒ごと) | `reray/v1/up/dev-001/status`:`{"v":1,"type":"status","src":"dev-001","seq":43,"ts":0,"battery":80,"glass":true}` |
| 届いた返事 | `reray/v1/up/dev-001/ack`、QoS 1:`{"v":1,"type":"ack","src":"dev-001","seq":44,"ts":0,"ack_mid":12}`(12 = 届いた text の `mid`。了解なら `"ack_kind":4`、できないなら 5) |

- `seq` は起動時の乱数から 1 ずつ進める(0〜65535)。`ts` は UNIX 秒で、時刻が合っていなければ 0
- 定型信号を送ると、サーバーが `reray/v1/down/dev-001/ack` に「本部に届いた」(`ack_seq` = 送った seq)を返す
- 形が違うものは捨て、サーバーの画面(ターミナル)に理由が出る(`src mismatch`、`v!=1` など)

## つまずきやすい所

| 起きたこと | 原因 | 直し方 |
| --- | --- | --- |
| `failed to connect to the docker API` | Docker Desktop が起動していない(PC を再起動したあとなど) | Docker Desktop を開き、左下が緑の「Engine running」になるまで待つ。確認画面(利用規約・アップデート)が出ていたら進める |
| 起動したら「保存: メモリ版」と出る | `.env` に `STORAGE=mysql` が無い | `.env` に足す |
| MySQL のエラーで起動しない(表が無い、列が無い) | DB が 11/06 より前のまま | `docker compose down -v` → `npm run docker:up`(中身は消える) |
| DB を空にしたのに、端末が戻ってくる | ブローカーが、サーバーが止まっていた間の受信を溜めていて、起動したときに渡す(取りこぼさないための作り) | 偽の端末・実機を止めてから DB を空にする |
| 端末から PC につながらない | 学校・会社の Wi-Fi は、つないだ機器どうしの通信を止めていることがある | スマホのテザリングか自前のルーターに、PC と端末の両方をつなぐ(PC の IP が変わるので調べ直す) |
| 同じ Wi-Fi なのにつながらない | Windows のファイアウォール | 「Docker Desktop Backend」の受信が許可されているか見る。確認が出たら許可する |
| 実機がつながったり切れたりをくり返す | 偽の端末(`DEV_TOOLS=1`)が同じ ID でつながっている | `DEV_TOOLS=0` にしてサーバーを起動し直す |
| 3000 番が使われていて起動しない | 前に起動したサーバーが残っている | そのターミナルで Ctrl+C。別のソフトなら `.env` の `HTTP_PORT` を変える |

**DB を空にする**(データを消して表だけに戻す):`docker compose down -v` → `npm run docker:up`。ボリュームを消したくないときは、`db/init/` の 01 → 02 → 03 を順に流す(`db/init/README.md`)。

## まだ決まっていないこと・お願い

| 件 | だれに | 中身 |
| --- | --- | --- |
| `db/init/03_server.sql` を見てほしい | すみださん(DB) | B 案に足してほしいもの:信号のコードとポジションの外部キーを外す、原本の `events` 表、`registered`、`publish_state`、分からない値を NULL にする |
| DB の時刻を日本時間にした | すみださん(DB) | B 案に合わせた。UTC に決まればサーバー側も戻す(DB-012) |
| 「了解・できない」(ack\_kind 4・5)を端末が送るか | ハード担当 | サーバーは受ける。仕様では v1 は「届いた」までなので、使うか決めたい |
| 管理画面は api.js で形を直している | やまさん(画面) | 画面の HTML はそのまま。API の形は INTERFACES §4・§4.5 |
| 文字の上限 40 文字 | リーダー | グラスに何文字出せるか待ち |

- 検証版なので、**ログインも MQTT の認証も無い**。自分の LAN の中だけで使い、ルーターでポートを開けてインターネットに出さない
- LoRa の出口から届くフレームの分解はまだ。今は原本に 16 進で残すだけ
