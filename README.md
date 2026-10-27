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
```

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

## テスト
```sh
$ npm test
```

## 利用してるモジュール
[misskey.js](https://github.com/misskey-dev/misskey.js)
