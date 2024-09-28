// 必要なモジュールのインポート
import dotenv from 'dotenv';
import express from 'express';
import { Client, GatewayIntentBits } from 'discord.js';
import * as Misskey from 'misskey-js';

// 環境変数のロード
dotenv.config();

// 環境変数の取得
const {
    DISCORD_TOKEN,
    DISCORD_CHANNEL_ID,
    MISSKEY_INSTANCE_URL,
    MISSKEY_API_TOKEN,
    PORT,
} = process.env;

const app = express();
app.get('/', (req, res) => {
    res.send('Discord to Misskey Bot is running.');
});

// Discordクライアントの作成
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// Misskeyクライアントの作成
const misskeyClient = new Misskey.api.APIClient({
    origin: MISSKEY_INSTANCE_URL,
    credential: MISSKEY_API_TOKEN,
});

// Discordのイベントキャッチ
discordClient.on('messageCreate', async (message) => {
    // ボット自身のメッセージや指定されたチャンネル以外のメッセージは無視
    if (message.author.bot || message.channel.id !== DISCORD_CHANNEL_ID) return;
    try {
        await misskeyClient.request('notes/create', {
            text: message.content,
        });
        console.log('Misskeyへの投稿が成功しました。');
    } catch (error) {
        console.error('Misskeyへの投稿に失敗しました:', error);
    }
});

// Discordクライアントのログイン
discordClient.login(DISCORD_TOKEN);

// サーバーの起動
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
