// 転送判定・投稿ロジック（外部依存を注入できるようにしてテスト可能にする）
import { createStats } from './stats.js';

export const MAX_NOTE_LENGTH = 3000;
const TRACK_LIMIT = 100;

/**
 * メッセージを Misskey に転送すべきか判定する。
 * 対象外チャンネルは除外。bot の発言は allowedBotIds に含まれる場合のみ通す。
 * 自分自身（selfId）の発言は常に除外する。
 */
export function shouldForward(message, channelId, allowedBotIds = [], selfId = null) {
    if (message.channel?.id !== channelId) return false;
    const authorId = message.author?.id;
    if (selfId && authorId === selfId) return false;
    if (message.author?.bot) return allowedBotIds.includes(authorId);
    return true;
}

/** Discord 固有記法を除去・整形する。 */
export function cleanDiscordText(text) {
    if (!text) return '';
    return String(text)
        .replace(/@(?:everyone|here)/g, '')
        .replace(/<@[!&]?\d+>/g, '')
        .replace(/<#\d+>/g, '')
        .replace(/<a?:(\w+):\d+>/g, ':$1:')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function truncate(text, max) {
    if (text.length <= max) return text;
    let cut = text.slice(0, max - 1);
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // サロゲートペア分断を避ける
    return `${cut}…`;
}

/**
 * 投稿本文を組み立てる。content → 各 embed の title → url の順に改行区切りで連結する（旧サーバと同じ書式）。
 * author.name / fields / footer / description は含めない。空行は詰め、重複行は除く。
 * 結果が空なら null。
 */
export function buildNoteText(message) {
    const parts = [];
    const seen = new Set();
    const add = (value) => {
        for (const line of cleanDiscordText(value).split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || seen.has(trimmed)) continue;
            seen.add(trimmed);
            parts.push(trimmed);
        }
    };
    add(message.content);
    for (const embed of message.embeds ?? []) {
        add(embed.title);
        add(embed.url);
    }
    if (parts.length === 0) return null;
    return truncate(parts.join('\n'), MAX_NOTE_LENGTH);
}

/** 挿入順で古いものから破棄する上限付き Set。 */
export function createBoundedSet(limit = TRACK_LIMIT) {
    const set = new Set();
    return {
        add(id) {
            set.delete(id);
            set.add(id);
            if (set.size > limit) set.delete(set.values().next().value);
        },
        has: (id) => set.has(id),
        delete: (id) => set.delete(id),
        get size() {
            return set.size;
        },
    };
}

/** 空スキップ済み・転送済みメッセージ ID の記録（messageCreate / messageUpdate で共有）。 */
export function createForwardTracker(limit = TRACK_LIMIT) {
    return { skippedEmpty: createBoundedSet(limit), forwarded: createBoundedSet(limit) };
}

const resolveSelfId = (selfId) => (typeof selfId === 'function' ? selfId() : selfId ?? null);
const describeAuthor = (author) =>
    `author=${author?.tag ?? author?.username ?? '(不明)'} id=${author?.id ?? '(不明)'}`;

async function postNote(misskeyClient, message, text, logger, stats, tracker) {
    try {
        await misskeyClient.request('notes/create', { text });
        stats.forwardSucceeded += 1;
        tracker.forwarded.add(message.id);
        tracker.skippedEmpty.delete(message.id);
        const suffix = message.author?.bot ? ` (許可 bot ${describeAuthor(message.author)})` : '';
        logger.log(`Misskeyへの投稿が成功しました。${suffix}`);
        return true;
    } catch (error) {
        stats.forwardFailed += 1;
        logger.error('Misskeyへの投稿に失敗しました:', error);
        return false;
    }
}

/**
 * messageCreate 用ハンドラを生成する。
 * 投稿失敗時は例外を外に出さず、logger.error に記録する。
 * options: { allowedBotIds, selfId (文字列 or 関数), tracker }
 */
export function createMessageHandler(
    misskeyClient,
    channelId,
    logger = console,
    stats = createStats(),
    now = Date.now,
    options = {},
) {
    const { allowedBotIds = [], selfId = null, tracker = createForwardTracker() } = options;
    return async (message) => {
        stats.received += 1;
        stats.lastReceivedAt = now();
        const self = resolveSelfId(selfId);
        if (message.channel?.id === channelId) {
            stats.targetChannel += 1;
            if (message.author?.bot) {
                const isSelf = self && message.author.id === self;
                if (!allowedBotIds.includes(message.author.id) || isSelf) {
                    stats.botSkipped += 1;
                    if (!isSelf) {
                        logger.info?.(
                            `bot 発言を除外しました: ${describeAuthor(message.author)}（転送するには DISCORD_ALLOWED_BOT_IDS に ID を追加）`,
                        );
                    }
                }
            }
        }
        if (!shouldForward(message, channelId, allowedBotIds, self)) return;
        const text = buildNoteText(message);
        if (text === null) {
            stats.emptySkipped += 1;
            if (message.id !== undefined) tracker.skippedEmpty.add(message.id);
            logger.info?.('転送する本文が空のためスキップ');
            return;
        }
        await postNote(misskeyClient, message, text, logger, stats, tracker);
    };
}

/**
 * messageUpdate 用ハンドラを生成する。
 * 「空でスキップ」済みで未転送のメッセージに embed 等が付いた場合のみ転送する。
 */
export function createMessageUpdateHandler(
    misskeyClient,
    channelId,
    logger = console,
    stats = createStats(),
    options = {},
) {
    const { allowedBotIds = [], selfId = null, tracker } = options;
    return async (_oldMessage, newMessage) => {
        try {
            if (!tracker.skippedEmpty.has(newMessage.id) || tracker.forwarded.has(newMessage.id)) return;
            let message = newMessage;
            if (message.partial) {
                try {
                    message = await message.fetch();
                } catch (error) {
                    logger.error('更新メッセージの取得に失敗しました:', error);
                    return;
                }
            }
            if (!shouldForward(message, channelId, allowedBotIds, resolveSelfId(selfId))) return;
            const text = buildNoteText(message);
            if (text === null) return;
            logger.info?.('更新で本文が付与されたため転送します');
            await postNote(misskeyClient, message, text, logger, stats, tracker);
        } catch (error) {
            logger.error('messageUpdate の処理に失敗しました:', error);
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
        allowedBotIds: parseIdList(env.DISCORD_ALLOWED_BOT_IDS),
    };
}
