// 配線（副作用なしで import できる。実物の依存は app.js が注入する）
import { Events, GatewayIntentBits } from 'discord.js';
import { defaultStatusFile, loadConfig, parseMinutes } from './config.js';
import {
    createForwardTracker,
    createMessageHandler,
    createMessageUpdateHandler,
} from './forwarder.js';
import { createAnnouncer, createDestinations, createPoller, createStateStore } from './announcer.js';
import { createFileStatusWriter, createHealthMonitor } from './health.js';
import { fetchAllUserVideos, fetchUserVideosPage, fetchVideoDescription } from './niconico.js';
import { formatCheckTimes } from './schedule.js';
import { createStats } from './stats.js';
import { sendShare } from './share.js';

export function createApp({
    env,
    homeDir,
    logger,
    now,
    fetchFn,
    setTimeoutFn,
    setIntervalFn,
    createDiscordClient,
    createMisskeyClient,
    uptimeMs,
    exit,
}) {
    const config = loadConfig(env, homeDir);

    // Discordクライアントの作成
    const discordClient = createDiscordClient({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
    });

    // Misskeyクライアントの作成
    const misskeyClient = createMisskeyClient({
        origin: config.misskeyInstanceUrl,
        credential: config.misskeyApiToken,
    });

    const stats = createStats();
    let poller = null;

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

        // ニコニコ動画の新着告知（NICONICO_USER_ID 設定時のみ。ClientReady は once なので二重起動しない）
        if (config.niconico) {
            const announcer = createAnnouncer({
                userId: config.niconico.userId,
                store: createStateStore(config.niconico.stateFile),
                destinations: createDestinations({
                    discordClient: readyClient,
                    misskeyClient,
                    announceChannelId: config.channelId,
                    twitterChannelId: config.niconico.postChannelId,
                }),
                logger,
                stats,
                now,
                fetchPage: (page, pageSize) =>
                    fetchUserVideosPage({ userId: config.niconico.userId, page, pageSize, fetchFn }),
                fetchAll: () => fetchAllUserVideos({ userId: config.niconico.userId, fetchFn }),
                fetchDescription: (videoId) => fetchVideoDescription({ videoId, fetchFn }),
            });
            poller = createPoller({
                inspect: announcer.inspect,
                tick: announcer.tick,
                checkTimes: config.niconico.checkTimes,
                logger,
                now,
                setTimeoutFn,
            });
            poller.start();
            logger.info(
                `ニコニコ動画の新着告知を開始: userId=${config.niconico.userId} 定刻(JST)=${formatCheckTimes(config.niconico.checkTimes)}`,
            );
        }
    });

    // Discordのイベントキャッチ
    const tracker = createForwardTracker();
    const handlerOptions = {
        allowedBotIds: config.allowedBotIds,
        selfId: () => discordClient.user?.id,
        tracker,
        // DISCORD_POST_CHANNEL_ID 設定時のみ、許可 bot の告知を twitter共有用チャンネルへ投稿する
        share: config.postChannelId
            ? (text) => sendShare(discordClient, config.postChannelId, text)
            : null,
    };
    discordClient.on(
        Events.MessageCreate,
        createMessageHandler(misskeyClient, config.channelId, logger, stats, now, handlerOptions),
    );
    // 通知 bot は embed が後から付くことがあるため、空スキップ済みメッセージの更新を拾う
    discordClient.on(
        Events.MessageUpdate,
        createMessageUpdateHandler(misskeyClient, config.channelId, logger, stats, handlerOptions),
    );

    // 生存確認モニタ（READY でない状態が続いたら終了 → launchd が再起動）
    const monitor = createHealthMonitor({
        now,
        logger,
        stats,
        setIntervalFn,
        writeStatus: createFileStatusWriter(defaultStatusFile(env, homeDir)),
        maxNotReadyMs: parseMinutes(env.HEALTH_MAX_NOT_READY_MINUTES, 5) * 60 * 1000,
        getStatus: () => ({
            ready: discordClient.isReady(),
            ping: discordClient.ws.ping,
            uptimeMs: uptimeMs(),
        }),
        onFatal: () => {
            monitor.stop();
            discordClient.destroy();
            exit(1);
        },
    });

    return {
        // Discordクライアントのログイン（monitor を先に開始する）
        start() {
            monitor.start();
            return discordClient.login(config.discordToken);
        },
        stop() {
            monitor.stop();
            poller?.stop();
        },
        monitor,
    };
}
