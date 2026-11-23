// 環境変数の検証と設定オブジェクトの組み立て（env と home は呼び出し側が渡す）
import { join } from 'node:path';
import { parseCheckTimes } from './schedule.js';

/** 環境変数から分指定の値を読む。不正値は既定値。 */
export function parseMinutes(value, defaultMinutes) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : defaultMinutes;
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

/** NICONICO_CHECK_TIMES を分配列にする。不正なら ConfigError。 */
function parseNicoCheckTimes(value) {
    try {
        return parseCheckTimes(value);
    } catch (error) {
        throw new ConfigError(`NICONICO_CHECK_TIMES が不正です: ${error.message}`);
    }
}

/** カンマ区切りの ID 文字列を配列にする（空白トリム・空要素除去）。 */
export function parseIdList(value) {
    if (!value) return [];
    return value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v !== '');
}

/**
 * 必須環境変数を検証して返す。欠けていれば ConfigError を投げる。
 */
export function loadConfig(env, home) {
    const missing = REQUIRED_ENV.filter((key) => !env[key]);
    if (missing.length > 0) {
        throw new ConfigError(
            `必須の環境変数が設定されていません: ${missing.join(', ')}\n` +
                '.env ファイルまたは環境変数で設定してください（README 参照）。',
        );
    }
    // ニコニコ動画の新着告知（NICONICO_USER_ID 未設定なら null = 機能オフ）
    let niconico = null;
    if (env.NICONICO_USER_ID) {
        const userId = env.NICONICO_USER_ID.trim();
        if (!/^\d+$/.test(userId)) {
            throw new ConfigError('NICONICO_USER_ID は数字のユーザー ID を指定してください。');
        }
        if (!env.DISCORD_POST_CHANNEL_ID) {
            throw new ConfigError(
                '必須の環境変数が設定されていません: DISCORD_POST_CHANNEL_ID（NICONICO_USER_ID 設定時は必須）',
            );
        }
        niconico = {
            userId,
            checkTimes: parseNicoCheckTimes(env.NICONICO_CHECK_TIMES),
            stateFile:
                env.NICONICO_STATE_FILE ||
                join(home, 'Library', 'Application Support', 'sns-collaborator', 'niconico-state.json'),
        };
    }
    return {
        niconico,
        discordToken: env.DISCORD_TOKEN,
        announceChannelId: env.DISCORD_CHANNEL_ID,
        misskeyInstanceUrl: env.MISSKEY_INSTANCE_URL,
        misskeyApiToken: env.MISSKEY_API_TOKEN,
        allowedBotIds: parseIdList(env.DISCORD_ALLOWED_BOT_IDS),
        // twitter共有用チャンネル（未設定なら null = ライブ配信告知の共有投稿は行わない）
        shareChannelId: env.DISCORD_POST_CHANNEL_ID || null,
        health: {
            statusFile: defaultStatusFile(env, home),
            maxNotReadyMs: parseMinutes(env.HEALTH_MAX_NOT_READY_MINUTES, 5) * 60 * 1000,
        },
    };
}

/** ステータスファイルの既定パス（HEALTH_STATUS_FILE があれば優先）。 */
export function defaultStatusFile(env, home) {
    return env.HEALTH_STATUS_FILE || join(home, 'Library', 'Logs', 'sns-collaborator', 'heartbeat.log');
}
