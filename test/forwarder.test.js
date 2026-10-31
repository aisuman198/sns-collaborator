import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    ConfigError,
    buildNoteText,
    createBoundedSet,
    createForwardTracker,
    createMessageHandler,
    createMessageUpdateHandler,
    loadConfig,
    shouldForward,
} from '../src/forwarder.js';

const CHANNEL_ID = 'chan-1';
const msg = (overrides = {}) => ({
    author: { bot: false },
    channel: { id: CHANNEL_ID },
    content: 'hello',
    ...overrides,
});

describe('shouldForward', () => {
    it('bot の発言は転送しない', () => {
        assert.equal(shouldForward(msg({ author: { bot: true } }), CHANNEL_ID), false);
    });
    it('対象外チャンネルは転送しない', () => {
        assert.equal(shouldForward(msg({ channel: { id: 'other' } }), CHANNEL_ID), false);
    });
    it('対象チャンネルの人間の発言は転送する', () => {
        assert.equal(shouldForward(msg(), CHANNEL_ID), true);
    });
});

describe('createMessageHandler', () => {
    let calls;
    let logger;
    beforeEach(() => {
        calls = [];
        logger = { log: () => {}, error: () => {} };
    });

    it('bot の発言では request を呼ばない', async () => {
        const client = { request: async (...a) => calls.push(a) };
        await createMessageHandler(client, CHANNEL_ID, logger)(msg({ author: { bot: true } }));
        assert.equal(calls.length, 0);
    });

    it('対象外チャンネルでは request を呼ばない', async () => {
        const client = { request: async (...a) => calls.push(a) };
        await createMessageHandler(client, CHANNEL_ID, logger)(msg({ channel: { id: 'x' } }));
        assert.equal(calls.length, 0);
    });

    it('正常時に notes/create を正しい payload で呼ぶ', async () => {
        const client = { request: async (...a) => calls.push(a) };
        await createMessageHandler(client, CHANNEL_ID, logger)(msg({ content: 'こんにちは' }));
        assert.deepEqual(calls, [['notes/create', { text: 'こんにちは' }]]);
    });

    it('投稿失敗時に例外を外へ出さず error をログする', async () => {
        const errors = [];
        logger.error = (...a) => errors.push(a);
        const client = {
            request: async () => {
                throw new Error('boom');
            },
        };
        await assert.doesNotReject(createMessageHandler(client, CHANNEL_ID, logger)(msg()));
        assert.equal(errors.length, 1);
    });
});

describe('loadConfig', () => {
    const full = {
        DISCORD_TOKEN: 't',
        DISCORD_CHANNEL_ID: 'c',
        MISSKEY_INSTANCE_URL: 'https://misskey.example',
        MISSKEY_API_TOKEN: 'm',
    };
    it('全て揃っていれば設定を返す', () => {
        assert.equal(loadConfig(full).channelId, 'c');
    });
    it('欠けている変数名を含むエラーを投げる', () => {
        assert.throws(
            () => loadConfig({ ...full, DISCORD_TOKEN: '', MISSKEY_API_TOKEN: undefined }),
            /DISCORD_TOKEN, MISSKEY_API_TOKEN/,
        );
    });
    it('設定不足は ConfigError を投げる', () => {
        assert.throws(() => loadConfig({}), ConfigError);
    });
});

describe('shouldForward (許可 bot)', () => {
    const bot = (id) => msg({ author: { bot: true, id } });
    it('許可 bot は通る', () => {
        assert.equal(shouldForward(bot('b1'), CHANNEL_ID, ['b1']), true);
    });
    it('非許可 bot は除外', () => {
        assert.equal(shouldForward(bot('b2'), CHANNEL_ID, ['b1']), false);
    });
    it('自分自身は許可リストにあっても除外', () => {
        assert.equal(shouldForward(bot('me'), CHANNEL_ID, ['me'], 'me'), false);
    });
    it('許可 bot でも対象外チャンネルは除外', () => {
        assert.equal(shouldForward({ ...bot('b1'), channel: { id: 'x' } }, CHANNEL_ID, ['b1']), false);
    });
    it('人間は通る', () => {
        assert.equal(shouldForward(msg({ author: { bot: false, id: 'u' } }), CHANNEL_ID, ['b1'], 'me'), true);
    });
});

describe('buildNoteText', () => {
    it('Discord 記法を除去・整形する', () => {
        const text = buildNoteText(
            msg({ content: '@everyone @here <@1> <@!2> <@&3> <#4> hi <:foo:5> <a:bar:6>  \n\n\n\nend  ' }),
        );
        assert.equal(text, 'hi :foo: :bar:\nend');
    });
    it('embed の title/url を連結し重複行を除く（author/description は含めない）', () => {
        const text = buildNoteText(
            msg({
                content: 'Live!',
                embeds: [
                    { author: { name: 'Streamer' }, title: 'Live!', url: 'https://x.example/l', description: 'desc' },
                ],
            }),
        );
        assert.equal(text, 'Live!\nhttps://x.example/l');
    });
    it('Streamcord の実データが旧サーバの書式と完全一致する', () => {
        const text = buildNoteText(
            msg({
                content: '@everyone\n\n配信の時間だよ〜',
                embeds: [
                    {
                        type: 'rich',
                        url: 'https://twitch.tv/aisu_is_198',
                        title: '【#MechaBREAK】#112 週末ブレイク【参加◎】',
                        color: 6570404,
                        timestamp: '2026-01-01T00:00:00.000Z',
                        fields: [{ name: 'Game', value: 'MechaBREAK', inline: true }],
                        author: { name: 'aisu_is_198 is now live!' },
                        image: { url: 'https://img.example/x.jpg' },
                        footer: { text: 'Twitch' },
                    },
                ],
            }),
        );
        assert.equal(
            text,
            '配信の時間だよ〜\n【#MechaBREAK】#112 週末ブレイク【参加◎】\nhttps://twitch.tv/aisu_is_198',
        );
    });
    it('メンションのみで embed なしなら null', () => {
        assert.equal(buildNoteText(msg({ content: '@everyone <@1>', embeds: [] })), null);
        assert.equal(buildNoteText(msg({ content: '' })), null);
    });
    it('embed だけでも組み立てられる', () => {
        assert.equal(buildNoteText(msg({ content: '', embeds: [{ title: 'T' }] })), 'T');
    });
    it('3000 文字を超えたら切り詰める', () => {
        const text = buildNoteText(msg({ content: 'あ'.repeat(5000) }));
        assert.equal(text.length, 3000);
        assert.ok(text.endsWith('…'));
        assert.equal(buildNoteText(msg({ content: 'a'.repeat(3000) })).length, 3000);
    });
});

describe('許可 bot と空スキップ→更新', () => {
    const BOT = 'bot-1';
    const streamcord = (overrides = {}) => ({
        id: 'm1',
        author: { bot: true, id: BOT, tag: 'Streamcord#0' },
        channel: { id: CHANNEL_ID },
        content: '@everyone',
        embeds: [],
        ...overrides,
    });
    let calls;
    let infos;
    let logger;
    let stats;
    let tracker;
    let client;
    let opts;
    beforeEach(() => {
        calls = [];
        infos = [];
        logger = { log: () => {}, info: (...a) => infos.push(a.join(' ')), error: () => {} };
        stats = { received: 0, targetChannel: 0, botSkipped: 0, emptySkipped: 0, forwardSucceeded: 0, forwardFailed: 0 };
        tracker = createForwardTracker();
        client = { request: async (...a) => calls.push(a) };
        opts = { allowedBotIds: [BOT], selfId: 'me', tracker };
    });

    it('非許可 bot 除外時に author と ID を INFO ログする', async () => {
        const h = createMessageHandler(client, CHANNEL_ID, logger, stats, Date.now, { tracker });
        await h(streamcord());
        assert.equal(calls.length, 0);
        assert.equal(stats.botSkipped, 1);
        assert.ok(infos.some((l) => l.includes('Streamcord#0') && l.includes(BOT)));
    });

    it('許可 bot の embed 付き告知を転送する', async () => {
        const h = createMessageHandler(client, CHANNEL_ID, logger, stats, Date.now, opts);
        await h(
            streamcord({
                content: '@everyone ○○ is now live!',
                embeds: [{ title: 'Title', url: 'https://t.example/x', description: 'Desc' }],
            }),
        );
        assert.deepEqual(calls, [
            ['notes/create', { text: '○○ is now live!\nTitle\nhttps://t.example/x' }],
        ]);
    });

    it('空なら投稿せず emptySkipped を増やして INFO ログする', async () => {
        const h = createMessageHandler(client, CHANNEL_ID, logger, stats, Date.now, opts);
        await h(streamcord());
        assert.equal(calls.length, 0);
        assert.equal(stats.emptySkipped, 1);
        assert.ok(infos.some((l) => l.includes('転送する本文が空のためスキップ')));
    });

    it('空スキップ後の update で embed が付くと 1 回だけ転送する', async () => {
        const create = createMessageHandler(client, CHANNEL_ID, logger, stats, Date.now, opts);
        const update = createMessageUpdateHandler(client, CHANNEL_ID, logger, stats, opts);
        const first = streamcord();
        await create(first);
        const updated = streamcord({ embeds: [{ title: 'T' }] });
        await update(first, updated);
        await update(first, updated);
        assert.deepEqual(calls, [['notes/create', { text: 'T' }]]);
    });

    it('転送済みメッセージは update で再投稿しない', async () => {
        const create = createMessageHandler(client, CHANNEL_ID, logger, stats, Date.now, opts);
        const update = createMessageUpdateHandler(client, CHANNEL_ID, logger, stats, opts);
        await create(streamcord({ embeds: [{ title: 'T' }] }));
        await update(null, streamcord({ embeds: [{ title: 'T2' }] }));
        assert.equal(calls.length, 1);
    });

    it('空スキップしていないメッセージの update は無視する', async () => {
        const update = createMessageUpdateHandler(client, CHANNEL_ID, logger, stats, opts);
        await update(null, streamcord({ embeds: [{ title: 'T' }] }));
        assert.equal(calls.length, 0);
    });

    it('partial は fetch し、失敗したらログのみで投稿しない', async () => {
        const create = createMessageHandler(client, CHANNEL_ID, logger, stats, Date.now, opts);
        const update = createMessageUpdateHandler(client, CHANNEL_ID, logger, stats, opts);
        await create(streamcord());
        const errors = [];
        logger.error = (...a) => errors.push(a);
        await update(null, {
            id: 'm1',
            partial: true,
            fetch: async () => {
                throw new Error('nope');
            },
        });
        assert.equal(calls.length, 0);
        assert.equal(errors.length, 1);
        await update(null, { id: 'm1', partial: true, fetch: async () => streamcord({ embeds: [{ title: 'F' }] }) });
        assert.deepEqual(calls, [['notes/create', { text: 'F' }]]);
    });
});

describe('createBoundedSet', () => {
    it('上限を超えたら古いものから破棄する', () => {
        const set = createBoundedSet(2);
        set.add('a');
        set.add('b');
        set.add('c');
        assert.equal(set.has('a'), false);
        assert.equal(set.has('b'), true);
        assert.equal(set.has('c'), true);
    });
});

describe('loadConfig allowedBotIds', () => {
    const base = {
        DISCORD_TOKEN: 't',
        DISCORD_CHANNEL_ID: 'c',
        MISSKEY_INSTANCE_URL: 'https://misskey.example',
        MISSKEY_API_TOKEN: 'm',
    };
    it('カンマ区切りを空白トリムして配列にする', () => {
        assert.deepEqual(loadConfig({ ...base, DISCORD_ALLOWED_BOT_IDS: ' 1, 2 ,,3 ' }).allowedBotIds, ['1', '2', '3']);
    });
    it('未設定・空は空配列', () => {
        assert.deepEqual(loadConfig(base).allowedBotIds, []);
        assert.deepEqual(loadConfig({ ...base, DISCORD_ALLOWED_BOT_IDS: '' }).allowedBotIds, []);
    });
});
