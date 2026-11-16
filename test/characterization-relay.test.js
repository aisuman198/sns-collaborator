// 特性テスト（転送・共有）: 現行挙動を固定する。不具合と思われる挙動は // F0x で示す。
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Embed, EmbedBuilder } from 'discord.js';
import {
    MAX_NOTE_LENGTH,
    buildNoteText,
    cleanDiscordText,
    createForwardTracker,
    createMessageHandler,
    createMessageUpdateHandler,
} from '../src/forwarder.js';
import { buildShareUrl } from '../src/share.js';
import { createStats } from '../src/stats.js';

const CHANNEL_ID = 'chan-1';
const BOT = 'bot-1';
const TW = 'https://twitter.com/intent/tweet?text=';
const decode = (url) => decodeURIComponent(url.slice(TW.length));

const streamcord = (overrides = {}) => ({
    id: 'm1',
    author: { bot: true, id: BOT, tag: 'Streamcord#0' },
    channel: { id: CHANNEL_ID },
    content: '@everyone\n\n配信の時間だよ〜',
    embeds: [{ title: '【ゲーム】今日の配信', url: 'https://www.twitch.tv/example' }],
    ...overrides,
});
const emptyBase = (overrides = {}) => streamcord({ content: '@everyone', embeds: [], ...overrides });
const withEmbed = (overrides = {}) => streamcord({ content: '@everyone', embeds: [{ title: 'T' }], ...overrides });

describe('特性: 転送・共有ハンドラ', () => {
    let notes;
    let shares;
    let errors;
    let infos;
    let order;
    let logger;
    let stats;
    let client;
    let opts;
    beforeEach(() => {
        notes = [];
        shares = [];
        errors = [];
        infos = [];
        order = [];
        logger = {
            log: () => {},
            info: (...a) => infos.push(a.join(' ')),
            error: (...a) => errors.push(a),
        };
        stats = createStats();
        client = {
            request: async (...a) => {
                order.push('misskey');
                notes.push(a);
            },
        };
        opts = {
            allowedBotIds: [BOT],
            selfId: 'me',
            tracker: createForwardTracker(),
            share: async (text, message) => {
                order.push('share');
                shares.push(text);
            },
        };
    });
    const create = (m) => createMessageHandler(client, CHANNEL_ID, logger, stats, () => 1234, opts)(m);
    const update = (o, n) => createMessageUpdateHandler(client, CHANNEL_ID, logger, stats, opts)(o, n);

    describe('C04/C05: 失敗時の再試行と順序', () => {
        it('C04: 本文ありで Misskey が失敗しても、その後の update では再試行されない', async () => {
            // F03: 再試行されず欠落する
            client.request = async () => {
                throw new Error('misskey down');
            };
            await create(streamcord());
            assert.equal(stats.forwardFailed, 1);
            assert.equal(opts.tracker.forwarded.has('m1'), false);
            assert.equal(opts.tracker.skippedEmpty.has('m1'), false);
            let calls = 0;
            client.request = async () => {
                calls += 1;
            };
            await update(streamcord(), streamcord({ embeds: [{ title: '追加' }] }));
            assert.equal(calls, 0);
            assert.equal(stats.forwardSucceeded, 0);
        });

        it('C05: 共有が Misskey より先に送られる', async () => {
            await create(streamcord());
            assert.deepEqual(order, ['share', 'misskey']);
        });

        it('C05: 共有が失敗しても Misskey が成功すれば、update で共有は再試行されない (F03)', async () => {
            opts.share = async () => {
                order.push('share');
                throw new Error('discord down');
            };
            await create(emptyBase());
            await update(emptyBase(), withEmbed());
            // F03: 共有失敗・Misskey 成功 → forwarded 済みなので再試行なし
            assert.deepEqual(order, ['share', 'misskey']);
            await update(emptyBase(), withEmbed());
            assert.deepEqual(order, ['share', 'misskey']);
            assert.equal(opts.tracker.shared.has('m1'), false);
            assert.equal(stats.shareFailed, 1);
        });

        it('C05: 共有失敗かつ Misskey 失敗なら、update で両方とも再試行される', async () => {
            let fail = true;
            opts.share = async () => {
                order.push('share');
                if (fail) throw new Error('discord down');
            };
            client.request = async () => {
                order.push('misskey');
                if (fail) throw new Error('misskey down');
            };
            await create(emptyBase());
            await update(emptyBase(), withEmbed());
            fail = false;
            await update(emptyBase(), withEmbed());
            assert.deepEqual(order, ['share', 'misskey', 'share', 'misskey']);
            assert.equal(stats.shareSucceeded, 1);
            assert.equal(stats.forwardSucceeded, 1);
        });

        it('C05: 共有の失敗は ERROR ログのみで Misskey の統計を変えない', async () => {
            opts.share = async () => {
                throw new Error('x');
            };
            await create(streamcord());
            assert.equal(stats.forwardSucceeded, 1);
            assert.equal(stats.forwardFailed, 0);
            assert.equal(errors.length, 1);
        });
    });

    describe('C06: update ハンドラの分岐', () => {
        it('空スキップ記録のないメッセージは何もしない', async () => {
            await update(null, withEmbed());
            assert.equal(notes.length, 0);
            assert.equal(shares.length, 0);
        });

        it('転送済みなら skippedEmpty が残っていても何もしない', async () => {
            opts.tracker.skippedEmpty.add('m1');
            opts.tracker.forwarded.add('m1');
            await update(null, withEmbed());
            assert.equal(notes.length, 0);
        });

        it('partial は fetch した結果で転送する', async () => {
            await create(emptyBase());
            let fetched = 0;
            const partial = {
                id: 'm1',
                partial: true,
                fetch: async () => {
                    fetched += 1;
                    return withEmbed();
                },
            };
            await update(null, partial);
            assert.equal(fetched, 1);
            assert.deepEqual(notes, [['notes/create', { text: 'T' }]]);
        });

        it('partial の fetch 失敗は ERROR ログのみで、skippedEmpty は残る', async () => {
            await create(emptyBase());
            const partial = {
                id: 'm1',
                partial: true,
                fetch: async () => {
                    throw new Error('404');
                },
            };
            await update(null, partial);
            assert.equal(notes.length, 0);
            assert.equal(errors.length, 1);
            assert.equal(opts.tracker.skippedEmpty.has('m1'), true);
        });

        it('更新後のメッセージが対象外チャンネル・許可外 bot・自分自身だったら転送しない', async () => {
            await create(emptyBase());
            await update(null, withEmbed({ channel: { id: 'other' } }));
            await update(null, withEmbed({ author: { bot: true, id: 'stranger' } }));
            await update(null, withEmbed({ author: { bot: true, id: 'me' } }));
            assert.equal(notes.length, 0);
            assert.equal(opts.tracker.skippedEmpty.has('m1'), true);
        });

        it('更新後も本文が空なら何もせず、記録も残る（emptySkipped は増えない）', async () => {
            await create(emptyBase());
            await update(null, emptyBase());
            assert.equal(notes.length, 0);
            assert.equal(stats.emptySkipped, 1);
            assert.equal(opts.tracker.skippedEmpty.has('m1'), true);
        });

        it('転送成功で skippedEmpty から削除し forwarded に入れ、INFO ログを出す', async () => {
            await create(emptyBase());
            await update(null, withEmbed());
            assert.equal(opts.tracker.skippedEmpty.has('m1'), false);
            assert.equal(opts.tracker.forwarded.has('m1'), true);
            assert.ok(infos.some((l) => l.includes('更新で本文が付与されたため転送します')));
        });

        it('update 内の予期せぬ例外は外へ出さず ERROR ログにする（selfId が例外）', async () => {
            const boom = () => {
                throw new Error('boom');
            };
            await create(emptyBase());
            const handler = createMessageUpdateHandler(client, CHANNEL_ID, logger, stats, { ...opts, selfId: boom });
            await handler(null, withEmbed());
            assert.equal(errors.length, 1);
            assert.ok(String(errors[0][0]).includes('messageUpdate の処理に失敗しました'));
        });

        it('update 経由の Misskey 失敗では skippedEmpty が残り、次の update で再試行される', async () => {
            let fail = true;
            client.request = async (...a) => {
                if (fail) throw new Error('down');
                notes.push(a);
            };
            await create(emptyBase());
            await update(null, withEmbed());
            assert.equal(opts.tracker.skippedEmpty.has('m1'), true);
            fail = false;
            await update(null, withEmbed());
            assert.equal(notes.length, 1);
        });

        it('F01: 送信中に再度 messageUpdate が来ると二重に送られる（記録が await の後のため）', async () => {
            // F01: 二重送信
            await create(emptyBase());
            let release;
            const gate = new Promise((resolve) => {
                release = resolve;
            });
            client.request = async (...a) => {
                await gate;
                notes.push(a);
            };
            const first = update(null, withEmbed());
            const second = update(null, withEmbed());
            release();
            await Promise.all([first, second]);
            assert.equal(notes.length, 2);
            assert.equal(shares.length, 2);
            assert.equal(opts.tracker.forwarded.has('m1'), true);
        });
    });

    describe('C10: 自分自身の発言の統計とログ', () => {
        it('自分自身: botSkipped に数えるが INFO ログは出さず、転送しない', async () => {
            await create(streamcord({ author: { bot: true, id: 'me' } }));
            assert.equal(stats.botSkipped, 1);
            assert.equal(stats.targetChannel, 1);
            assert.deepEqual(infos, []);
            assert.equal(notes.length, 0);
        });

        it('自分自身が許可リストにあっても同じ（botSkipped のみ）', async () => {
            opts.allowedBotIds = [BOT, 'me'];
            await create(streamcord({ author: { bot: true, id: 'me' } }));
            assert.equal(stats.botSkipped, 1);
            assert.deepEqual(infos, []);
            assert.equal(notes.length, 0);
        });

        it('許可外 bot: botSkipped に数え INFO ログを出す', async () => {
            await create(streamcord({ author: { bot: true, id: 'stranger', tag: 'S#1' } }));
            assert.equal(stats.botSkipped, 1);
            assert.equal(infos.length, 1);
            assert.ok(infos[0].includes('author=S#1 id=stranger'));
        });

        it('許可 bot は botSkipped に数えない', async () => {
            await create(streamcord());
            assert.equal(stats.botSkipped, 0);
        });

        it('対象外チャンネルの bot は botSkipped にもログにも出ない', async () => {
            await create(streamcord({ author: { bot: true, id: 'me' }, channel: { id: 'x' } }));
            assert.equal(stats.botSkipped, 0);
            assert.equal(stats.targetChannel, 0);
            assert.equal(stats.received, 1);
            assert.deepEqual(infos, []);
        });

        it('selfId が関数なら呼び出し時に評価される（後から確定しても反映）', async () => {
            let self = null;
            opts.selfId = () => self;
            await create(streamcord({ author: { bot: true, id: 'me' }, id: 'a' }));
            // selfId 未確定のうちは許可外 bot として INFO ログが出る
            assert.equal(infos.length, 1);
            infos.length = 0;
            self = 'me';
            await create(streamcord({ author: { bot: true, id: 'me' }, id: 'b' }));
            assert.deepEqual(infos, []);
            assert.equal(stats.botSkipped, 2);
        });

        it('lastReceivedAt は注入した now の値になる', async () => {
            await create(streamcord());
            assert.equal(stats.lastReceivedAt, 1234);
        });
    });

    describe('C11: tracker の上限', () => {
        it('空スキップ記録は 100 件で古いものから破棄され、最古の update は無視される', async () => {
            for (let i = 0; i < 101; i += 1) await create(emptyBase({ id: `e${i}` }));
            assert.equal(opts.tracker.skippedEmpty.size, 100);
            assert.equal(opts.tracker.skippedEmpty.has('e0'), false);
            assert.equal(opts.tracker.skippedEmpty.has('e1'), true);
            await update(null, withEmbed({ id: 'e0' }));
            assert.equal(notes.length, 0);
            await update(null, withEmbed({ id: 'e1' }));
            assert.equal(notes.length, 1);
        });

        it('forwarded / shared も 100 件で上限になる', async () => {
            for (let i = 0; i < 101; i += 1) await create(streamcord({ id: `f${i}` }));
            assert.equal(opts.tracker.forwarded.size, 100);
            assert.equal(opts.tracker.shared.size, 100);
            assert.equal(opts.tracker.forwarded.has('f0'), false);
            assert.equal(opts.tracker.shared.has('f0'), false);
        });

        it('id が undefined のメッセージは skippedEmpty に記録されない', async () => {
            await create(emptyBase({ id: undefined }));
            assert.equal(opts.tracker.skippedEmpty.size, 0);
            assert.equal(stats.emptySkipped, 1);
        });
    });
});

describe('C07: buildNoteText の embed 順序・重複排除・3000 文字境界', () => {
    it('content → embed ごとに title → url の順で並ぶ', () => {
        const text = buildNoteText({
            content: 'C',
            embeds: [
                { title: 'T1', url: 'U1' },
                { title: 'T2', url: 'U2' },
            ],
        });
        assert.equal(text, 'C\nT1\nU1\nT2\nU2');
    });

    it('重複行は最初の出現だけ残す（content と embed、embed 間をまたぐ）', () => {
        const text = buildNoteText({
            content: 'A\nB\nA',
            embeds: [
                { title: 'B', url: 'U' },
                { title: 'A', url: 'U' },
                { title: 'C', url: 'U' },
            ],
        });
        assert.equal(text, 'A\nB\nU\nC');
    });

    it('各行は trim され、空白だけの行は捨てられる', () => {
        assert.equal(buildNoteText({ content: '  a  \n   \n\tb\t', embeds: [] }), 'a\nb');
    });

    it('embeds が無い／undefined でも content だけで組み立てる', () => {
        assert.equal(buildNoteText({ content: 'x' }), 'x');
    });

    it('ちょうど 3000 文字は切り詰めない', () => {
        const s = 'a'.repeat(MAX_NOTE_LENGTH);
        assert.equal(buildNoteText({ content: s }), s);
    });

    it('3001 文字は 2999 文字 + … (計 3000 文字) になる', () => {
        const out = buildNoteText({ content: 'a'.repeat(MAX_NOTE_LENGTH + 1) });
        assert.equal(out.length, 3000);
        assert.equal(out, `${'a'.repeat(2999)}…`);
    });

    it('境界がサロゲートペアの途中なら上位サロゲートも落とす（2998 文字 + …）', () => {
        const out = buildNoteText({ content: `${'a'.repeat(2998)}🎮b` });
        assert.equal(out, `${'a'.repeat(2998)}…`);
        assert.equal(out.length, 2999);
    });

    it('境界の直前でペアが完結していれば残す', () => {
        const out = buildNoteText({ content: `${'a'.repeat(2997)}🎮bb` });
        assert.equal(out, `${'a'.repeat(2997)}🎮…`);
        assert.equal(out.length, 3000);
    });
});

describe('C08: @here / @everyone 周りの現状 (F04)', () => {
    it('F04: 単語の一部でも @here / @everyone は単純置換で消える', () => {
        // F04: 単語の一部も置換される
        assert.equal(cleanDiscordText('@hereafter'), 'after');
        assert.equal(cleanDiscordText('foo@here.com'), 'foo.com');
        assert.equal(cleanDiscordText('a@everyoneb'), 'ab');
    });

    it('通常の @here / @everyone は消える', () => {
        assert.equal(cleanDiscordText('@here こんにちは @everyone'), 'こんにちは');
    });

    it('F04: メールアドレスが壊れたまま転送される', () => {
        // F04: メールアドレス破壊
        assert.equal(buildNoteText({ content: 'contact: me@here.com' }), 'contact: me.com');
    });

    it('大文字は置換されない', () => {
        assert.equal(cleanDiscordText('@Here @EVERYONE'), '@Here @EVERYONE');
    });
});

describe('C09: discord.js の実 Embed インスタンス', () => {
    const data = { title: '【ゲーム】今日の配信', url: 'https://www.twitch.tv/example', description: '説明は含めない' };

    it('Embed (メッセージ受信時の実クラス) で Streamcord の 3 行書式になる', () => {
        const embed = new Embed(data);
        assert.equal(embed.title, data.title);
        const text = buildNoteText({ content: '@everyone\n\n配信の時間だよ〜', embeds: [embed] });
        assert.equal(text, '配信の時間だよ〜\n【ゲーム】今日の配信\nhttps://www.twitch.tv/example');
    });

    it('Embed の author / fields / footer / description は本文に入らない', () => {
        const embed = new Embed({
            ...data,
            author: { name: 'AUTHOR' },
            footer: { text: 'FOOTER' },
            fields: [{ name: 'FN', value: 'FV' }],
        });
        const text = buildNoteText({ content: '', embeds: [embed] });
        assert.equal(text, '【ゲーム】今日の配信\nhttps://www.twitch.tv/example');
    });

    it('EmbedBuilder#toJSON() の結果なら title → url の順で拾える', () => {
        const text = buildNoteText({ content: '', embeds: [new EmbedBuilder(data).toJSON()] });
        assert.equal(text, '【ゲーム】今日の配信\nhttps://www.twitch.tv/example');
    });

    it('title だけ・url だけの Embed も拾う', () => {
        assert.equal(buildNoteText({ embeds: [new Embed({ title: 'T' })] }), 'T');
        assert.equal(buildNoteText({ embeds: [new Embed({ url: 'https://u.example' })] }), 'https://u.example');
    });

    it('実 Embed を持つメッセージが共有まで通る', async () => {
        const shares = [];
        const notes = [];
        const handler = createMessageHandler(
            { request: async (...a) => notes.push(a) },
            CHANNEL_ID,
            { log: () => {}, info: () => {}, error: () => {} },
            createStats(),
            Date.now,
            {
                allowedBotIds: [BOT],
                selfId: 'me',
                tracker: createForwardTracker(),
                share: async (text) => shares.push(text),
            },
        );
        await handler(streamcord({ embeds: [new Embed(data)] }));
        const expected = '配信の時間だよ〜\n【ゲーム】今日の配信\nhttps://www.twitch.tv/example';
        assert.deepEqual(shares, [expected]);
        assert.deepEqual(notes, [['notes/create', { text: expected }]]);
    });
});

describe('C11: 共有 URL のフォールバック', () => {
    it('先頭行と末尾行だけで 512 を超える 3 行は、全体の末尾側を切り詰める', () => {
        const text = `先頭\n中間\nhttps://example.com/${'x'.repeat(600)}`;
        const url = buildShareUrl(text);
        assert.ok(url.length <= 512);
        const out = decode(url);
        assert.ok(out.endsWith('…'));
        assert.ok(text.startsWith(out.slice(0, -1)));
        assert.ok(out.startsWith('先頭\n中間\n'));
    });

    it('先頭行が極端に長い 3 行も 512 以下に収まり、末尾行は残らない', () => {
        const text = `${'あ'.repeat(300)}\n中間\nhttps://example.com/end`;
        const url = buildShareUrl(text);
        assert.ok(url.length <= 512);
        assert.ok(!decode(url).includes('https://example.com/end'));
    });

    it('ちょうど 512 文字の URL はそのまま、1 文字超えると切り詰められる', () => {
        const overhead = TW.length;
        const fit = 'a'.repeat(512 - overhead);
        assert.equal(buildShareUrl(fit).length, 512);
        assert.equal(decode(buildShareUrl(fit)), fit);
        const over = buildShareUrl(fit + 'a');
        assert.ok(over.length <= 512);
        assert.ok(decode(over).endsWith('…'));
    });

    it('空文字でも URL を返す', () => {
        assert.equal(buildShareUrl(''), TW);
    });
});
