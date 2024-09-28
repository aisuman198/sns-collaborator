# sns-collaborator
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
PORT=5000 # 好きなポート

DISCORD_CHANNEL_ID=<チャンネルID>
DISCORD_TOKEN=<DISCORD_TOKEN>

MISSKEY_INSTANCE_URL=https://misskey.io
MISSKEY_API_TOKEN=<MISSKEY_API_TOKEN>
```

### 3. アプリケーション起動
```sh
# node入れてる前提で
$ npm install
$ node src/app.js
```

### 4. Discord該当チャンネルにメッセージ投稿
