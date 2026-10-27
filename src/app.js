// 必要なモジュールのインポート
import dotenv from 'dotenv';
import { Client, GatewayIntentBits } from 'discord.js';
import * as Misskey from 'misskey-js';
import { createMessageHandler, loadConfig } from './forwarder.js';

// 環境変数のロード
dotenv.config();

async function main() {
    const config = loadConfig();

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
        origin: config.misskeyInstanceUrl,
        credential: config.misskeyApiToken,
    });

    // Discordのイベントキャッチ
    discordClient.on('messageCreate', createMessageHandler(misskeyClient, config.channelId));

    // Discordクライアントのログイン
    await discordClient.login(config.discordToken);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
