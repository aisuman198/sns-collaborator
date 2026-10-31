// 必要なモジュールのインポート
import dotenv from 'dotenv';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import * as Misskey from 'misskey-js';
import {
    ConfigError,
    createForwardTracker,
    createMessageHandler,
    createMessageUpdateHandler,
    loadConfig,
} from './forwarder.js';
import { createHealthMonitor, parseMinutes } from './health.js';
import { createLogger } from './logger.js';
import { createStats } from './stats.js';

const logger = createLogger();

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

    const stats = createStats();

    // Discordクライアントのエラーはログ出力のみ（プロセスは落とさない）
    discordClient.on(Events.Error, (error) => {
        logger.error('Discord client error:', error);
    });
    discordClient.on(Events.Warn, (message) => logger.warn('Discord warn:', message));
    discordClient.on(Events.ShardDisconnect, (event, shardId) => {
        logger.warn(`shard ${shardId} 切断 code=${event?.code} reason=${event?.reason ?? ''}`);
    });
    discordClient.on(Events.ShardReconnecting, (shardId) => {
        logger.warn(`shard ${shardId} 再接続中`);
    });
    discordClient.on(Events.ShardResume, (shardId, replayed) => {
        logger.info(`shard ${shardId} 再開 (replayed events=${replayed})`);
    });
    discordClient.on(Events.ShardError, (error, shardId) => {
        logger.error(`shard ${shardId} エラー:`, error);
    });
    discordClient.on(Events.Invalidated, () => {
        logger.error('Discord セッションが無効化されました (invalidated)');
    });

    // ログイン完了（discord.js 14.27 では ready が非推奨のため clientReady）
    discordClient.once(Events.ClientReady, async (readyClient) => {
        logger.info(`ログイン完了: ${readyClient.user.tag} / 監視チャンネルID=${config.channelId}`);
        try {
            const channel = await readyClient.channels.fetch(config.channelId);
            if (channel) {
                logger.info(`監視チャンネル取得成功: name=${channel.name ?? '(名前なし)'} id=${channel.id}`);
            } else {
                logger.error(`監視チャンネルが見つかりません: id=${config.channelId}`);
            }
        } catch (error) {
            logger.error(
                `監視チャンネルの取得に失敗しました (ID違い・権限不足・未参加の可能性): id=${config.channelId}`,
                error,
            );
        }
    });

    // Discordのイベントキャッチ
    const tracker = createForwardTracker();
    const handlerOptions = {
        allowedBotIds: config.allowedBotIds,
        selfId: () => discordClient.user?.id,
        tracker,
    };
    discordClient.on(
        Events.MessageCreate,
        createMessageHandler(misskeyClient, config.channelId, logger, stats, Date.now, handlerOptions),
    );
    // 通知 bot は embed が後から付くことがあるため、空スキップ済みメッセージの更新を拾う
    discordClient.on(
        Events.MessageUpdate,
        createMessageUpdateHandler(misskeyClient, config.channelId, logger, stats, handlerOptions),
    );

    // 生存確認モニタ（READY でない状態が続いたら終了 → launchd が再起動）
    const monitor = createHealthMonitor({
        logger,
        stats,
        intervalMs: parseMinutes(process.env.HEALTH_INTERVAL_MINUTES, 10) * 60 * 1000,
        maxNotReadyMs: parseMinutes(process.env.HEALTH_MAX_NOT_READY_MINUTES, 5) * 60 * 1000,
        getStatus: () => ({
            ready: discordClient.isReady(),
            ping: discordClient.ws.ping,
            uptimeMs: Math.round(process.uptime() * 1000),
        }),
        onFatal: () => {
            monitor.stop();
            discordClient.destroy();
            process.exit(1);
        },
    });
    monitor.start();

    // Discordクライアントのログイン
    await discordClient.login(config.discordToken);
}

main().catch((error) => {
    if (error instanceof ConfigError) {
        logger.error(error.message);
    } else {
        logger.error('起動に失敗しました:', error);
    }
    process.exitCode = 1;
});
