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
```

#### 通知 bot（Streamcord など）の投稿を転送する
既定では bot の発言は転送されません。Streamcord などの通知 bot の投稿を転送したい場合は `DISCORD_ALLOWED_BOT_IDS` にその bot のユーザー ID をカンマ区切りで指定します（空白は無視、自分自身の発言は常に除外）。
ID は、対象チャンネルで bot 発言が除外されたときの INFO ログ（`bot 発言を除外しました: author=... id=...`）か、Discord の開発者モードを有効にして bot のユーザーを右クリック →「ユーザー ID をコピー」で取得できます。

#### 投稿本文の組み立てルール
- `message.content` から `@everyone` / `@here`、メンション（`<@123>` `<@!123>` `<@&123>`）、チャンネル参照（`<#123>`）を除去し、カスタム絵文字は `:name:` に変換、前後の空白と連続空行を整理
- 続けて各 embed の author 名・title・url・description をこの順に追加（同じ内容の行は 1 回だけ）
- 結果が空なら投稿せず `転送する本文が空のためスキップ` を INFO ログに出力（heartbeat の `emptySkipped`）。Streamcord のように embed が後から付く場合に備え、空スキップしたメッセージ（直近 100 件）が更新されて本文が付いたときは 1 回だけ転送します（転送済みは再投稿しません）
- Misskey の上限に合わせ 3000 文字を超えたら切り詰め（末尾 `…`）

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
- `heartbeat`: 既定 10 分ごと。例
  `heartbeat ws=READY ping=45ms uptime=4d0h12m3s received=120 targetChannel=8 botSkipped=1 emptySkipped=0 forwardOk=7 forwardFail=0 lastReceived=2026-11-01T01:23:45.000Z`

heartbeat の読み方:
- `ws=NOT_READY` が続く: Discord に接続できていない（下記の自動再起動の対象）
- `ws=READY` なのに `received` が 0 のまま増えない: イベントがそもそも届いていない（Intent・Bot の参加サーバー・権限を確認）
- `received` は増えるが `targetChannel=0`: `DISCORD_CHANNEL_ID` の誤りの可能性
- `targetChannel` は増えるが `forwardOk` が増えない: `botSkipped`（bot 発言）か `forwardFail`（Misskey 側の失敗）を確認
- `lastReceived` で最後にメッセージを受けた時刻が分かる

環境変数（任意）:
- `HEALTH_INTERVAL_MINUTES`: heartbeat の間隔（分、既定 10）
- `HEALTH_MAX_NOT_READY_MINUTES`: READY でない状態がこの分数続いたら終了（分、既定 5）

自動再起動の条件: Discord が READY でない状態が `HEALTH_MAX_NOT_READY_MINUTES` 続くと ERROR ログを出して終了コード 1 で終了し、launchd（KeepAlive）が再起動します。状態確認は最大 1 分間隔で行います。Mac のスリープ復帰（前回確認から確認間隔の 2 倍超）を検知した場合は `スリープ復帰を検知` を出力し、再接続の猶予として未接続時間の計測をリセットします。

## テスト
```sh
$ npm test
```

## 利用してるモジュール
[misskey.js](https://github.com/misskey-dev/misskey.js)
