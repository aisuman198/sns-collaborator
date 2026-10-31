// 転送判定・投稿ロジック（外部依存を注入できるようにしてテスト可能にする）
import { createStats } from './stats.js';

/**
 * メッセージを Misskey に転送すべきか判定する。
 * bot の発言と、対象外チャンネルの発言は転送しない。
 */
export function shouldForward(message, channelId) {
    if (message.author?.bot) return false;
    return message.channel?.id === channelId;
}

/**
 * messageCreate 用ハンドラを生成する。
 * 投稿失敗時は例外を外に出さず、logger.error に記録する。
 */
export function createMessageHandler(
    misskeyClient,
    channelId,
    logger = console,
    stats = createStats(),
    now = Date.now,
) {
    return async (message) => {
        stats.received += 1;
        stats.lastReceivedAt = now();
        if (message.channel?.id === channelId) {
            stats.targetChannel += 1;
            if (message.author?.bot) stats.botSkipped += 1;
        }
        if (!shouldForward(message, channelId)) return;
        try {
            await misskeyClient.request('notes/create', {
                text: message.content,
            });
            stats.forwardSucceeded += 1;
            logger.log('Misskeyへの投稿が成功しました。');
        } catch (error) {
            stats.forwardFailed += 1;
            logger.error('Misskeyへの投稿に失敗しました:', error);
        }
    };
}

export const REQUIRED_ENV = [
    'DISCORD_TOKEN',
    'DISCORD_CHANNEL_ID',
    'MISSKEY_INSTANCE_URL',
    'MISSKEY_API_TOKEN',
];

/** 想定内の設定エラー（環境変数不足など）。 */
export class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
    }
}

/**
 * 必須環境変数を検証して返す。欠けていれば ConfigError を投げる。
 */
export function loadConfig(env = process.env) {
    const missing = REQUIRED_ENV.filter((key) => !env[key]);
    if (missing.length > 0) {
        throw new ConfigError(
            `必須の環境変数が設定されていません: ${missing.join(', ')}\n` +
                '.env ファイルまたは環境変数で設定してください（README 参照）。',
        );
    }
    return {
        discordToken: env.DISCORD_TOKEN,
        channelId: env.DISCORD_CHANNEL_ID,
        misskeyInstanceUrl: env.MISSKEY_INSTANCE_URL,
        misskeyApiToken: env.MISSKEY_API_TOKEN,
    };
}
