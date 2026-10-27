// 必要なモジュールのインポート
import dotenv from 'dotenv';
import { Client, GatewayIntentBits } from 'discord.js';
import * as Misskey from 'misskey-js';
import { ConfigError, createMessageHandler, loadConfig } from './forwarder.js';

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

    // Discordクライアントのエラーはログ出力のみ（プロセスは落とさない）
    discordClient.on('error', (error) => {
        console.error('Discord client error:', error);
    });

    // Discordのイベントキャッチ
    discordClient.on('messageCreate', createMessageHandler(misskeyClient, config.channelId));

    // Discordクライアントのログイン
    await discordClient.login(config.discordToken);
}

main().catch((error) => {
    if (error instanceof ConfigError) {
        console.error(error.message);
    } else {
        console.error(error);
    }
    process.exitCode = 1;
});
