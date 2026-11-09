import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildNoteText,
    createForwardTracker,
    createMessageHandler,
    createMessageUpdateHandler,
    loadConfig,
} from '../src/forwarder.js';
import { sendShare } from '../src/share.js';
import { createStats } from '../src/stats.js';

const CHANNEL_ID = 'chan-1';
const BOT = 'bot-1';
const TW = 'https://twitter.com/intent/tweet?text=';
const decode = (url) => decodeURIComponent(url.slice(TW.length));
const TEXT = '配信の時間だよ〜\n【ゲーム】今日の配信\nhttps://www.twitch.tv/example';

describe('twitter共有用チャンネルへの投稿（share）', () => {
    const streamcord = (overrides = {}) => ({
        id: 'm1',
        author: { bot: true, id: BOT, tag: 'Streamcord#0' },
        channel: { id: CHANNEL_ID },
        content: '@everyone\n\n配信の時間だよ〜',
        embeds: [{ title: '【ゲーム】今日の配信', url: 'https://www.twitch.tv/example' }],
        ...overrides,
    });
    let notes;
    let shares;
    let errors;
    let logs;
    let logger;
    let stats;
    let client;
    let opts;
    beforeEach(() => {
        notes = [];
        shares = [];
        errors = [];
        logs = [];
        logger = { log: (...a) => logs.push(a.join(' ')), info: () => {}, error: (...a) => errors.push(a) };
        stats = createStats();
        client = { request: async (...a) => notes.push(a) };
        opts = {
            allowedBotIds: [BOT],
            selfId: 'me',
            tracker: createForwardTracker(),
            share: async (text, message) => {
                shares.push([text, message.id]);
            },
        };
    });
    const create = (m) => createMessageHandler(client, CHANNEL_ID, logger, stats, Date.now, opts)(m);
    const update = (o, n) => createMessageUpdateHandler(client, CHANNEL_ID, logger, stats, opts)(o, n);

    it('Streamcord の告知を Misskey と共有に 1 回ずつ送る', async () => {
        await create(streamcord());
        assert.deepEqual(notes, [['notes/create', { text: TEXT }]]);
        assert.deepEqual(shares, [[TEXT, 'm1']]);
        assert.equal(stats.shareSucceeded, 1);
        assert.equal(stats.shareFailed, 0);
        assert.ok(logs.some((l) => l.includes('twitter共有用チャンネルへの投稿が成功')));
    });

    it('sendShare 経由で embed description とリンクボタンを送り、URL を decode すると本文と一致する', async () => {
        const sends = [];
        const discordClient = { channels: { fetch: async () => ({ send: async (p) => sends.push(p) }) } };
        opts.share = (text) => sendShare(discordClient, 'post-chan', text);
        await create(streamcord());
        const [payload] = sends;
        assert.equal(payload.content, '');
        assert.deepEqual(payload.embeds, [{ description: TEXT }]);
        assert.deepEqual(payload.allowedMentions, { parse: [] });
        const button = payload.components[0].components[0];
        assert.equal(button.type, 2);
        assert.equal(button.style, 5);
        assert.equal(button.label, 'ツイートする');
        assert.ok(button.url.startsWith(TW));
        assert.equal(decode(button.url), TEXT);
        assert.equal(decode(button.url), buildNoteText(streamcord()));
    });

    it('人の投稿は Misskey のみで共有しない', async () => {
        await create({ id: 'h1', author: { bot: false, id: 'u1' }, channel: { id: CHANNEL_ID }, content: 'hi' });
        assert.equal(notes.length, 1);
        assert.equal(shares.length, 0);
    });

    it('許可外 bot と bot 自身は共有しない', async () => {
        await create(streamcord({ author: { bot: true, id: 'other' } }));
        await create(streamcord({ id: 'm2', author: { bot: true, id: 'me' } }));
        assert.equal(notes.length, 0);
        assert.equal(shares.length, 0);
    });

    it('対象外チャンネルは共有しない', async () => {
        await create(streamcord({ channel: { id: 'x' } }));
        assert.equal(shares.length, 0);
    });

    it('共有関数なしなら従来どおり Misskey のみ', async () => {
        delete opts.share;
        await create(streamcord());
        assert.equal(notes.length, 1);
        assert.equal(stats.shareSucceeded, 0);
        assert.equal(stats.shareFailed, 0);
    });

    it('空スキップ → update で本文が付くと Misskey と共有が 1 回ずつ', async () => {
        const first = streamcord({ content: '@everyone', embeds: [] });
        await create(first);
        assert.equal(shares.length, 0);
        const updated = streamcord({ content: '@everyone', embeds: [{ title: 'T', url: 'https://t.example/x' }] });
        await update(first, updated);
        await update(first, updated);
        assert.equal(notes.length, 1);
        assert.deepEqual(shares, [['T\nhttps://t.example/x', 'm1']]);
    });

    it('Misskey が失敗しても共有され、例外は出ない', async () => {
        client.request = async () => {
            throw new Error('misskey down');
        };
        await create(streamcord());
        assert.equal(shares.length, 1);
        assert.equal(stats.forwardFailed, 1);
        assert.equal(stats.shareSucceeded, 1);
    });

    it('共有が失敗しても Misskey は成功し、例外は出ず ERROR ログと統計が残る', async () => {
        opts.share = async () => {
            throw new Error('discord down');
        };
        await create(streamcord());
        assert.equal(notes.length, 1);
        assert.equal(stats.forwardSucceeded, 1);
        assert.equal(stats.shareFailed, 1);
        assert.equal(stats.shareSucceeded, 0);
        assert.ok(errors.some((e) => String(e[0]).includes('twitter共有用チャンネルへの投稿に失敗')));
    });

    it('Misskey 失敗後の update で共有は再投稿されず、Misskey だけ再試行される', async () => {
        let fail = true;
        client.request = async (...a) => {
            if (fail) throw new Error('misskey down');
            notes.push(a);
        };
        const first = streamcord({ content: '@everyone', embeds: [] });
        await create(first);
        const updated = streamcord({ embeds: [{ title: 'T' }] });
        await update(first, updated); // Misskey 失敗・共有成功
        assert.equal(shares.length, 1);
        assert.equal(notes.length, 0);
        fail = false;
        await update(first, updated); // Misskey の再試行のみ
        assert.equal(shares.length, 1);
        assert.equal(notes.length, 1);
    });

    it('共有失敗かつ Misskey 成功後の update で Misskey は再投稿されない', async () => {
        opts.share = async () => {
            throw new Error('discord down');
        };
        const first = streamcord({ content: '@everyone', embeds: [] });
        await create(first);
        const updated = streamcord({ embeds: [{ title: 'T' }] });
        await update(first, updated);
        await update(first, updated);
        assert.equal(notes.length, 1);
    });

    it('update ハンドラが共有関数の例外を外に出さない', async () => {
        opts.share = async () => {
            throw new Error('boom');
        };
        await create(streamcord({ content: '@everyone', embeds: [] }));
        await update(null, streamcord({ embeds: [{ title: 'T' }] }));
        assert.equal(stats.shareFailed, 1);
    });
});

describe('loadConfig postChannelId', () => {
    const base = {
        DISCORD_TOKEN: 't',
        DISCORD_CHANNEL_ID: 'c',
        MISSKEY_INSTANCE_URL: 'https://m.example',
        MISSKEY_API_TOKEN: 'k',
    };
    it('未設定なら null、設定すれば値を返す', () => {
        assert.equal(loadConfig(base).postChannelId, null);
        assert.equal(loadConfig({ ...base, DISCORD_POST_CHANNEL_ID: 'p' }).postChannelId, 'p');
    });
});
