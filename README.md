# sns-collaborator
## 各種設定
### 1. Discord Botの設定
1. Discord Developer Portalにアクセスして新しいアプリケーションを作成
2. Botの作成：Botセクションに移動して新しいボットを作成
3. Botトークンの取得
4. インテントの設定：MESSAGE CONTENT INTENT を有効にする
5. Botの招待：以下のURLを使用して、ボットをサーバーに招待する
```
https://discord.com/oauth2/authorize?client_id=<クライアントID>&scope=bot&permissions=1024
```
### 2. アプリケーションのルートに `.env` ファイル作る
```sh
DISCORD_CHANNEL_ID=<チャンネルID>
DISCORD_TOKEN=<DISCORD_TOKEN>

MISSKEY_INSTANCE_URL=https://misskey.io
MISSKEY_API_TOKEN=<MISSKEY_API_TOKEN>

# 任意: 転送を許可する bot のユーザー ID（カンマ区切り）
DISCORD_ALLOWED_BOT_IDS=<bot ID>,<bot ID>

# 任意: ニコニコ動画の新着告知（NICONICO_USER_ID を設定すると有効。設定時は DISCORD_POST_CHANNEL_ID も必須）
NICONICO_USER_ID=<ニコニコのユーザーID（数字）>
DISCORD_POST_CHANNEL_ID=<twitter共有用チャンネルID>
# NICONICO_CHECK_TIMES=12:30,21:30
# NICONICO_STATE_FILE=~/Library/Application Support/sns-collaborator/niconico-state.json
```

#### 通知 bot（Streamcord など）の投稿を転送する
既定では bot の発言は転送されません。Streamcord などの通知 bot の投稿を転送したい場合は `DISCORD_ALLOWED_BOT_IDS` にその bot のユーザー ID をカンマ区切りで指定します（空白は無視、自分自身の発言は常に除外）。
ID は、対象チャンネルで bot 発言が除外されたときの INFO ログ（`bot 発言を除外しました: author=... id=...`）か、Discord の開発者モードを有効にして bot のユーザーを右クリック →「ユーザー ID をコピー」で取得できます。

#### 投稿本文の組み立てルール
- `message.content` から `@everyone` / `@here`、メンション（`<@123>` `<@!123>` `<@&123>`）、チャンネル参照（`<#123>`）を除去し、カスタム絵文字は `:name:` に変換、前後の空白を整理し、空行は詰める
- 続けて各 embed の title・url をこの順に追加し、改行区切りで連結（旧サーバと同じ「本文・タイトル・URL」書式。embed の author 名・fields・footer・description は含めない。同じ内容の行は 1 回だけ）
- 結果が空なら投稿せず `転送する本文が空のためスキップ` を INFO ログに出力（heartbeat の `emptySkipped`）。Streamcord のように embed が後から付く場合に備え、空スキップしたメッセージ（直近 100 件）が更新されて本文が付いたときは 1 回だけ転送します（転送済みは再投稿しません）
- Misskey の上限に合わせ 3000 文字を超えたら切り詰め（末尾 `…`）

#### ニコニコ動画の新着告知
`NICONICO_USER_ID` を設定すると、同じプロセス内で、毎日決まった時刻（既定 12:30 と 21:30、日本時間）に投稿動画一覧を取得し（非公式 API `nvapi.nicovideo.jp`）、新着を次の文面で 3 か所へ告知します。未設定なら機能オフで、従来の動作は変わりません。

```
動画を投稿しました！
<動画タイトル>
https://www.nicovideo.jp/watch/<動画ID>
```

宛先ごとの形式:
- 配信告知チャンネルと Misskey: 上記の文面をそのままプレーンテキストで投稿
- twitter共有用チャンネル: 既存のライブ配信投稿と同じ形式で、本文は空、上記の文面を埋め込み（embed の description）に入れ、「ツイートする」リンクボタン（`https://twitter.com/intent/tweet?text=<本文を encodeURIComponent したもの>`）を付けます。ボタン URL は Discord の上限 512 文字に収めるため、長いタイトルはツイート文側だけ末尾 `…` で切り詰めます（1 行目と動画 URL は常に残り、埋め込みの本文は完全なタイトルのままです）

宛先（独立に配信し、成否は宛先ごとに記録。1 か所の失敗で他は止まりません）:
1. Discord `DISCORD_CHANNEL_ID`（配信告知）
2. Discord `DISCORD_POST_CHANNEL_ID`（twitter共有用）
3. Misskey（`notes/create`）

Discord への送信は `allowedMentions: { parse: [] }` 付きで、タイトルに `@everyone` 等が含まれても通知されません。bot 自身の発言は転送対象から除外されるため、配信告知チャンネルへの投稿が Misskey に二重転送されることはありません。

環境変数:
- `NICONICO_USER_ID`: 任意。未設定なら機能オフ
- `DISCORD_POST_CHANNEL_ID`: `NICONICO_USER_ID` 設定時は必須（無ければ起動時に設定エラー）
- `NICONICO_CHECK_TIMES`: 取得する定刻（JST 固定。実行マシンのタイムゾーンには依存しません）。カンマ区切りの `HH:MM`、既定 `12:30,21:30`。不正な値は起動時に設定エラー
- `NICONICO_STATE_FILE`: 状態ファイル（既定 `~/Library/Application Support/sns-collaborator/niconico-state.json`）

取得タイミング:
- 時刻は `NICONICO_CHECK_TIMES` の定刻（JST 固定）。1 分ごとに壁時計で「直近の定刻」が状態ファイルの `lastRunAt`（最後に取得に成功した時刻）より後かを判定して実行します。長時間のタイマーは張らないため、Mac のスリープでずれません
- スリープや停止で定刻を飛ばした場合は、復帰後に 1 回だけ実行します（複数回分飛ばしても 1 回）。定刻の間の再起動では実行しません。状態ファイルがなければ起動直後に初回シードを実行します
- 取得に失敗した場合、または配信後に未配信が残った場合は、次の定刻を待たず 5 分間隔で再試行し、成功して未配信が空になったら止めます。`lastRunAt` は取得に成功したときだけ更新されます。再起動後に未配信が残っていれば、起動後すぐ再試行します
- 動画が公開されてから告知されるまでの最大遅延は、次の定刻までです（既定では 21:00 公開なら 21:30 に告知、12:30 直後の公開なら 21:30 に告知）。定刻の間隔が 24 時間未満である限り、24 時間ルールで取りこぼすことはありません

新着判定のルール:
- 既知 ID 集合との差分で判定（投稿日時・ID の大小は使いません）。一度既知になった ID は削除しないため、非公開→再公開でも再告知しません
- 初回（状態ファイルなし、または保存済み userId が設定と違う）は全ページを取得して既知に登録するだけで、投稿しません。途中ページの取得に失敗したら何も保存せず、次回また初回扱いです
- 通常は先頭ページ（20 件）のみ取得。`registeredAt` が未来の動画は無視（既知にもしない。公開時刻を過ぎてから告知）
- `registeredAt` から 24 時間以上経った新規動画は告知せず既知に登録し WARN を出します（Mac 停止明けなど）
- 1 回の告知対象が 4 件以上なら異常とみなし、投稿せず全て既知に登録して ID 付きの ERROR を出します
- 異常な応答（非 200、`meta.status` 不正、項目欠落、タイムアウト 15 秒など）は「新着なし」とせず失敗扱いで、状態は変更しません。WARN を出し、連続 3 回失敗で ERROR を 1 回、回復時に INFO を 1 回
- 配信は古い順。投稿前に状態ファイルへ未配信として保存し、宛先ごとに成功の都度保存します。失敗した宛先のみ 5 分後に再試行（取得失敗の回も再試行します）。24 時間過ぎた未配信は諦めて ERROR を出し除外します

状態ファイル（JSON。一時ファイルへ書いて rename で保存。`lastRunAt` は取得に成功した最終時刻の epoch ミリ秒で、省略可）:
```json
{"version":1,"userId":"140498","lastRunAt":1794225600000,"known":["sm1","sm2"],"pending":{"sm3":{"title":"...","url":"https://www.nicovideo.jp/watch/sm3","registeredAt":"2026-11-09T21:00:00+09:00","delivered":{"announce":true,"twitter":false,"misskey":false}}}}
```
JSON 破損・書式不正は初回扱いにせず、上書きもせず ERROR を 1 回出してその判定では何もしません（ERROR は 1 回だけで、1 分ごとの判定で連発しません）。内容を確認して修正するか、ファイルを削除すると初回扱い（シードのみ）で再開します。

### 3. アプリケーション起動
```sh
# Node.js 20 以上が必要
$ npm install
$ npm start

# 開発時（ファイル変更で自動再起動）
$ npm run dev
```

### 4. Discord該当チャンネルにメッセージ投稿
Welcome to Underground

## ログイン時に自動起動する（macOS launchd）
LaunchAgent として登録すると、macOS へのログイン時に bot が自動起動します（ログイン時起動であり、ログイン前のブート直後には起動しません）。異常終了時は自動で再起動されます。

```sh
# 登録（plist 生成 → ~/Library/LaunchAgents に配置 → 起動）
$ npm run launchd:install

# 生成される plist の確認のみ（副作用なし）
$ npm run launchd:print

# 解除
$ npm run launchd:uninstall

# ログ確認
$ tail -f ~/Library/Logs/sns-collaborator/out.log

# 状態確認
$ launchctl print gui/$(id -u)/local.sns-collaborator
```

install 時の node のパスとリポジトリの場所が plist に記録されます。node のバージョンを切り替えた場合やリポジトリを移動した場合は、再度 `npm run launchd:install` が必要です。

## ログの見方・生存確認
全ログは `[ISO8601] LEVEL message` 形式で出力されます（INFO/WARN は stdout、ERROR は stderr）。

出力されるログの種類:
- 起動時: `ログイン完了: <ユーザータグ> / 監視チャンネルID=...`、続けて `監視チャンネル取得成功: name=...`（ID違い・権限不足・未参加なら ERROR）
- 接続状態: `shard N 切断` / `再接続中` / `再開` / `エラー`、`セッションが無効化`、`Discord warn`
- 転送: `Misskeyへの投稿が成功しました。` / `失敗しました`
- スリープ復帰検知 / `Discord が READY でない状態が ... 続いたため終了します`
- 空スキップ・bot 除外（INFO）

heartbeat（ws 状態・統計など）は out.log には出さず、**上書きされる最新ステータスファイル**に書き出します（状態確認の tick ごと、最大 1 分間隔。常に最新 1 回分のみ）。

```
$ cat ~/Library/Logs/sns-collaborator/heartbeat.log
[2026-11-01T01:23:45.000Z] heartbeat ws=READY ping=45ms uptime=4d0h12m3s received=120 targetChannel=8 botSkipped=1 emptySkipped=0 forwardOk=7 forwardFail=0 niconicoOk=288 niconicoFail=0 niconicoAnnounced=1 lastReceived=2026-11-01T01:23:45.000Z
```

ファイルの更新時刻（`ls -l`）が 2 分以上古ければ、プロセス停止の疑いがあります。書き込みに失敗してもプロセスは落ちず、ERROR を 1 回だけ出力します（回復時に INFO を 1 回）。

heartbeat の読み方:
- `ws=NOT_READY` が続く: Discord に接続できていない（下記の自動再起動の対象）
- `ws=READY` なのに `received` が 0 のまま増えない: イベントがそもそも届いていない（Intent・Bot の参加サーバー・権限を確認）
- `received` は増えるが `targetChannel=0`: `DISCORD_CHANNEL_ID` の誤りの可能性
- `targetChannel` は増えるが `forwardOk` が増えない: `botSkipped`（bot 発言）か `forwardFail`（Misskey 側の失敗）を確認
- `niconicoOk` / `niconicoFail` / `niconicoAnnounced`: ニコニコ動画の取得成功数・失敗数・告知完了数（機能オフなら 0 のまま）。`niconicoFail` だけ増え続ける場合は nvapi 側の変更・障害を疑う
- `lastReceived` で最後にメッセージを受けた時刻が分かる

環境変数（任意）:
- `HEALTH_STATUS_FILE`: ステータスファイルのパス（既定 `~/Library/Logs/sns-collaborator/heartbeat.log`）
- `HEALTH_MAX_NOT_READY_MINUTES`: READY でない状態がこの分数続いたら終了（分、既定 5）

自動再起動の条件: Discord が READY でない状態が `HEALTH_MAX_NOT_READY_MINUTES` 続くと ERROR ログを出して終了コード 1 で終了し、launchd（KeepAlive）が再起動します。状態確認は最大 1 分間隔で行います。Mac のスリープ復帰（前回確認から確認間隔の 2 倍超）を検知した場合は `スリープ復帰を検知` を出力し、再接続の猶予として未接続時間の計測をリセットします。

## テスト
```sh
$ npm test
```

## 利用してるモジュール
[misskey.js](https://github.com/misskey-dev/misskey.js)
