// createApp の配線テスト（実 Discord / Misskey / ネットワーク / タイマーには触れず、すべて注入した fake で検証する）
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Events, GatewayIntentBits } from 'discord.js';
import { ConfigError } from '../src/config.js';
import { createApp } from '../src/create-app.js';

const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-10T12:00:00Z');
const BASE_ENV = {
    DISCORD_TOKEN: 'tok',
    DISCORD_CHANNEL_ID: 'c1',
    MISSKEY_INSTANCE_URL: 'https://misskey.example',
    MISSKEY_API_TOKEN: 'mk-token',
    DISCORD_ALLOWED_BOT_IDS: 'bot1,bot2',
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
// 条件が満たされるまで最大 max 回イベントループを回す。満たされなければ失敗させる
const settle = async (cond, max = 100) => {
    for (let i = 0; i < max; i += 1) {
        if (cond()) return;
        await turn();
    }
    assert.fail('settle: 条件が満たされませんでした');
};
// 「何も起きないこと」の確認用に、非同期処理が走り切る程度にイベントループを回す（条件が無いので固定回数）
const flushIdle = async () => {
    for (let i = 0; i < 10; i += 1) await turn();
};
const HEARTBEAT = ['Library', 'Logs', 'sns-collaborator', 'heartbeat.log'];

class FakeDiscordClient extends EventEmitter {
    constructor(options, calls) {
        super();
        this.options = options;
        this.calls = calls;
        this.user = null; // login 後に設定される想定
        this.ready = false;
        this.ws = { ping: 33 };
        this.fetchedIds = [];
        this.channels = {
            fetch: async (id) => {
                this.fetchedIds.push(id);
                return { id, name: `name-${id}`, send: async (payload) => { this.sent.push({ id, payload }); } };
            },
        };
        this.sent = [];
        this.logins = [];
    }
    isReady() { return this.ready; }
    async login(token) { this.calls.push('login'); this.logins.push(token); return token; }
    destroy() { this.calls.push('destroy'); }
}

describe('createApp 配線', () => {
    let dir, calls, discord, misskeyRequests, misskeyOptions, timeouts, intervals, exits, fetchCalls, now, logs, originalFetch, globalFetchCalls, apps;

    const logger = {
        info: (m, ...rest) => logs.push(['info', m, ...rest]),
        log: (m, ...rest) => logs.push(['log', m, ...rest]),
        warn: (m, ...rest) => logs.push(['warn', m, ...rest]),
        error: (m, ...rest) => logs.push(['error', m, ...rest]),
    };
    const fakeHandle = () => ({ unref() {} });

    const defaultFetch = async (url) => {
        if (String(url).includes('nvapi')) {
            return {
                status: 200,
                json: async () => ({
                    meta: { status: 200 },
                    data: {
                        totalCount: 2,
                        items: [
                            { essential: { id: 'sm2', title: '新しい動画', registeredAt: '2026-11-10T11:00:00Z' } },
                            { essential: { id: 'sm1', title: '古い動画', registeredAt: '2026-01-01T00:00:00Z' } },
                        ],
                    },
                }),
            };
        }
        return {
            status: 200,
            text: async () =>
                '<nicovideo_thumb_response status="ok"><thumb><description>説明です。続き</description></thumb></nicovideo_thumb_response>',
        };
    };
    let fetchImpl;

    function build(envExtra = {}, { uptime = 1000 } = {}) {
        const app = createApp({
            env: { ...BASE_ENV, ...envExtra },
            homeDir: dir,
            logger,
            now: () => now,
            fetchFn: async (url, init) => { fetchCalls.push(String(url)); return fetchImpl(url, init); },
            setTimeoutFn: (fn, ms) => { const h = fakeHandle(); timeouts.push({ fn, ms, h }); return h; },
            setIntervalFn: (fn, ms) => { const h = fakeHandle(); intervals.push({ fn, ms, h }); calls.push('setInterval'); return h; },
            createDiscordClient: (options) => { discord = new FakeDiscordClient(options, calls); return discord; },
            createMisskeyClient: (options) => {
                misskeyOptions = options;
                return { request: async (endpoint, params) => { misskeyRequests.push({ endpoint, params }); } };
            },
            uptimeMs: () => uptime,
            exit: (code) => { calls.push(`exit:${code}`); exits.push(code); },
        });
        apps.push(app);
        return app;
    }
    const botMessage = (overrides = {}) => ({
        id: 'm1',
        author: { id: 'bot1', bot: true, tag: 'bot#1' },
        channel: { id: 'c1' },
        content: '告知です',
        embeds: [],
        ...overrides,
    });
    const send = (event, ...args) => { discord.emit(event, ...args); };
    const ready = () => Object.assign(discord, { user: { id: 'me', tag: 't' } });
    const logged = (level, message) => logs.some(([l, m]) => l === level && m === message);
    const heartbeat = async () => {
        app0().monitor.tick();
        return readFile(join(dir, ...HEARTBEAT), 'utf8');
    };

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'create-app-test-'));
        calls = []; misskeyRequests = []; timeouts = []; intervals = []; exits = []; fetchCalls = []; logs = []; apps = [];
        now = T0;
        fetchImpl = defaultFetch;
        globalFetchCalls = [];
        originalFetch = globalThis.fetch;
        globalThis.fetch = async (url) => { globalFetchCalls.push(String(url)); throw new Error('グローバル fetch は使わない'); };
    });
    afterEach(async () => {
        for (const app of apps) app.stop();
        globalThis.fetch = originalFetch;
        await rm(dir, { recursive: true, force: true });
    });

    describe('C01 共有チャンネルへの告知', () => {
        it('DISCORD_POST_CHANNEL_ID があると許可 bot の告知が共有チャンネルへ送られ、Misskey にも転送される', async () => {
            build({ DISCORD_POST_CHANNEL_ID: 'p1' });
            send(Events.MessageCreate, botMessage());
            await settle(() => discord.sent.length === 1 && misskeyRequests.length === 1);
            assert.equal(discord.sent[0].id, 'p1');
            assert.equal(discord.sent[0].payload.embeds[0].description, '告知です');
            assert.deepEqual(misskeyRequests, [{ endpoint: 'notes/create', params: { text: '告知です' } }]);
        });
        it('DISCORD_POST_CHANNEL_ID が無いと共有チャンネルへは送られない（Misskey 転送だけ行う）', async () => {
            build();
            send(Events.MessageCreate, botMessage());
            await settle(() => misskeyRequests.length === 1);
            assert.deepEqual(discord.fetchedIds, []);
            assert.deepEqual(discord.sent, []);
            assert.equal(misskeyRequests.length, 1);
        });
        it('人間の投稿は共有チャンネルへ送らない', async () => {
            build({ DISCORD_POST_CHANNEL_ID: 'p1' });
            send(Events.MessageCreate, botMessage({ author: { id: 'u1', bot: false } }));
            await settle(() => misskeyRequests.length === 1);
            assert.deepEqual(discord.sent, []);
            assert.equal(misskeyRequests.length, 1);
        });
    });

    describe('C02 メッセージ中継', () => {
        it('インテントは Guilds / GuildMessages / MessageContent の 3 つを渡す', () => {
            build();
            assert.deepEqual(discord.options, {
                intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
            });
        });
        it('Misskey クライアントに origin と credential を渡す', () => {
            build();
            assert.deepEqual(misskeyOptions, { origin: 'https://misskey.example', credential: 'mk-token' });
        });
        it('messageCreate と messageUpdate は同じ tracker を共有する（空スキップ → 更新で転送）', async () => {
            build();
            send(Events.MessageCreate, botMessage({ content: '' }));
            await flushIdle();
            assert.deepEqual(misskeyRequests, []);
            const updated = botMessage({ content: '', embeds: [{ title: 'タイトル', url: 'https://example.com/x' }] });
            send(Events.MessageUpdate, botMessage({ content: '' }), updated);
            await settle(() => misskeyRequests.length === 1);
            assert.deepEqual(misskeyRequests, [
                { endpoint: 'notes/create', params: { text: 'タイトル\nhttps://example.com/x' } },
            ]);
        });
        it('selfId は遅延評価される（createApp 後に設定された user.id の自己投稿を無視する）', async () => {
            build({ DISCORD_ALLOWED_BOT_IDS: 'bot1,self1' });
            await app0().start();
            discord.user = { id: 'self1', tag: 'self#1' };
            send(Events.MessageCreate, botMessage({ id: 'm1', author: { id: 'self1', bot: true } }));
            await flushIdle();
            assert.deepEqual(misskeyRequests, []);
            send(Events.MessageCreate, botMessage({ id: 'm2', author: { id: 'bot1', bot: true } }));
            await settle(() => misskeyRequests.length === 1);
        });
        it('監視チャンネル ID（DISCORD_CHANNEL_ID）のメッセージだけ転送し、ClientReady でもそのチャンネルを取得する', async () => {
            build({ DISCORD_CHANNEL_ID: 'watch-9' });
            send(Events.MessageCreate, botMessage({ channel: { id: 'c1' } }));
            await flushIdle();
            assert.deepEqual(misskeyRequests, []);
            send(Events.MessageCreate, botMessage({ id: 'm2', channel: { id: 'watch-9' } }));
            await settle(() => misskeyRequests.length === 1);
            discord.user = { id: 'me', tag: 'me#1' };
            send(Events.ClientReady, discord);
            await settle(() => discord.fetchedIds.length === 1);
            assert.deepEqual(discord.fetchedIds, ['watch-9']);
            assert.ok(logs.some(([, m]) => m === 'ログイン完了: me#1 / 監視チャンネルID=watch-9'));
        });
        it('stats は中継ハンドラ（create / update）で共有され、heartbeat 行に出る', async () => {
            build({ DISCORD_POST_CHANNEL_ID: 'p1' });
            send(Events.MessageCreate, botMessage({ content: '' }));
            await settle(() => logged('info', '転送する本文が空のためスキップ'));
            send(Events.MessageUpdate, botMessage({ content: '' }), botMessage({ content: '', embeds: [{ title: 'T' }] }));
            await settle(() => misskeyRequests.length === 1 && discord.sent.length === 1);
            const line = await heartbeat();
            assert.match(
                line,
                /received=1 targetChannel=1 botSkipped=0 emptySkipped=1 forwardOk=1 forwardFail=0 shareOk=1 shareFail=0 niconicoOk=0 niconicoFail=0 niconicoAnnounced=0 /,
            );
        });
        it('許可されていない bot の投稿は転送しない', async () => {
            build();
            send(Events.MessageCreate, botMessage({ author: { id: 'stranger', bot: true } }));
            await flushIdle();
            assert.deepEqual(misskeyRequests, []);
        });
    });

    function app0() { return apps[apps.length - 1]; }

    describe('Discord 接続ログ', () => {
        it('Error / Warn / ShardDisconnect / ShardReconnecting / ShardResume / ShardError / Invalidated を文言どおりに出す', () => {
            build();
            const err = new Error('boom');
            discord.emit(Events.Error, err);
            discord.emit(Events.Warn, 'warn-msg');
            discord.emit(Events.ShardDisconnect, { code: 4000, reason: 'bye' }, 2);
            discord.emit(Events.ShardDisconnect, { code: 1006 }, 3);
            discord.emit(Events.ShardReconnecting, 2);
            discord.emit(Events.ShardResume, 2, 7);
            discord.emit(Events.ShardError, err, 2);
            discord.emit(Events.Invalidated);
            assert.deepEqual(logs, [
                ['error', 'Discord client error:', err],
                ['warn', 'Discord warn:', 'warn-msg'],
                ['warn', 'shard 2 切断 code=4000 reason=bye'],
                ['warn', 'shard 3 切断 code=1006 reason='],
                ['warn', 'shard 2 再接続中'],
                ['info', 'shard 2 再開 (replayed events=7)'],
                ['error', 'shard 2 エラー:', err],
                ['error', 'Discord セッションが無効化されました (invalidated)'],
            ]);
        });
    });

    describe('監視チャンネルの確認', () => {
        it('取得成功: name と id をログに出す', async () => {
            build();
            send(Events.ClientReady, ready());
            await settle(() => logged('info', '監視チャンネル取得成功: name=name-c1 id=c1'));
        });
        it('成功でも name が無ければ (名前なし)', async () => {
            build();
            discord.channels.fetch = async (id) => ({ id });
            send(Events.ClientReady, ready());
            await settle(() => logged('info', '監視チャンネル取得成功: name=(名前なし) id=c1'));
        });
        it('null が返ったら見つかりませんの ERROR', async () => {
            build();
            discord.channels.fetch = async () => null;
            send(Events.ClientReady, ready());
            await settle(() => logged('error', '監視チャンネルが見つかりません: id=c1'));
            assert.ok(!logs.some(([, m]) => m.startsWith('監視チャンネル取得成功')));
        });
        it('throw したら取得失敗の ERROR（エラーを引数に付ける）', async () => {
            build();
            const err = new Error('Missing Access');
            discord.channels.fetch = async () => { throw err; };
            send(Events.ClientReady, ready());
            await settle(() => logs.some(([l, m]) => l === 'error' && m.startsWith('監視チャンネルの取得に失敗しました')));
            const entry = logs.find(([, m]) => m.startsWith('監視チャンネルの取得に失敗しました'));
            assert.deepEqual(entry, ['error', '監視チャンネルの取得に失敗しました (ID違い・権限不足・未参加の可能性): id=c1', err]);
        });
    });

    describe('C03 ニコニコ告知と生存確認', () => {
        const NICO = { NICONICO_USER_ID: '140498', DISCORD_POST_CHANNEL_ID: 'p1' };
        const writeState = (userId = '140498') =>
            writeFile(
                join(dir, 'state.json'),
                JSON.stringify({ version: 1, userId, known: ['sm1'], pending: {} }),
            );

        it('NICONICO_USER_ID が無ければ ClientReady でもポーラーを作らず、取得もしない', async () => {
            build();
            send(Events.ClientReady, ready());
            await settle(() => logged('info', 'ログイン完了: t / 監視チャンネルID=c1'));
            await flushIdle();
            assert.deepEqual(timeouts, []);
            assert.deepEqual(fetchCalls, []);
        });
        it('NICONICO_USER_ID があると ClientReady でポーラーが setTimeoutFn で起動し、開始ログが出る', async () => {
            build({ ...NICO, NICONICO_STATE_FILE: join(dir, 'state.json'), NICONICO_CHECK_TIMES: '9:05,21:30' });
            assert.deepEqual(timeouts, []); // ClientReady 前は起動しない
            send(Events.ClientReady, ready());
            await settle(() => timeouts.length === 1);
            assert.equal(timeouts.length, 1);
            assert.equal(timeouts[0].ms, 0);
            assert.ok(logs.some(([, m]) => m === 'ニコニコ動画の新着告知を開始: userId=140498 定刻(JST)=09:05,21:30'));
        });
        it('告知は announce=監視チャンネル / twitter=共有チャンネル / Misskey へ届き、取得は fetchFn だけを使う', async () => {
            await writeState();
            build({ ...NICO, NICONICO_STATE_FILE: join(dir, 'state.json') });
            send(Events.ClientReady, ready());
            await settle(() => timeouts.length === 1);
            await timeouts[0].fn();
            await settle(() => misskeyRequests.length === 1 && discord.sent.length === 2);
            assert.ok(fetchCalls[0].startsWith('https://nvapi.nicovideo.jp/v2/users/140498/videos'));
            assert.equal(fetchCalls[1], 'https://ext.nicovideo.jp/api/getthumbinfo/sm2');
            assert.deepEqual(globalFetchCalls, []);
            const announce = discord.sent.find((s) => s.id === 'c1');
            const twitter = discord.sent.find((s) => s.id === 'p1');
            assert.equal(announce.payload.content, '動画を投稿しました！\n新しい動画\nhttps://www.nicovideo.jp/watch/sm2');
            assert.equal(
                twitter.payload.embeds[0].description,
                '動画を投稿しました！\n新しい動画\n説明です。\nhttps://www.nicovideo.jp/watch/sm2',
            );
            assert.deepEqual(misskeyRequests, [
                {
                    endpoint: 'notes/create',
                    params: { text: '動画を投稿しました！\n新しい動画\n説明です。\nhttps://www.nicovideo.jp/watch/sm2' },
                },
            ]);
        });
        it('初回（状態ファイルなし）のシードも fetchFn を使い、グローバル fetch には触れない', async () => {
            build({ ...NICO, NICONICO_STATE_FILE: join(dir, 'state.json') });
            send(Events.ClientReady, ready());
            await settle(() => timeouts.length === 1);
            await timeouts[0].fn();
            assert.ok(fetchCalls.length >= 1 && fetchCalls.every((u) => u.startsWith('https://nvapi.nicovideo.jp/')));
            assert.deepEqual(globalFetchCalls, []);
            const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
            assert.deepEqual(state.known.sort(), ['sm1', 'sm2']);
        });
        it('stop() でポーラーが止まり、保留中の確認が走っても取得しない', async () => {
            await writeState();
            const app = build({ ...NICO, NICONICO_STATE_FILE: join(dir, 'state.json') });
            send(Events.ClientReady, ready());
            await settle(() => timeouts.length === 1);
            app.stop();
            await timeouts[0].fn();
            await flushIdle();
            assert.deepEqual(fetchCalls, []);
        });

        const startNotReady = () => {
            discord.ready = false;
            return app0().monitor;
        };
        const ticksUntilFatal = (monitor, max) => {
            for (let i = 1; i <= max; i += 1) {
                now += MIN;
                monitor.tick();
                if (exits.length > 0) return i;
            }
            return null;
        };
        it('stats はニコニコの告知とも共有され、heartbeat 行に出る', async () => {
            await writeState();
            build({ ...NICO, NICONICO_STATE_FILE: join(dir, 'state.json') });
            send(Events.ClientReady, ready());
            await settle(() => timeouts.length === 1);
            await timeouts[0].fn();
            await settle(() => misskeyRequests.length === 1 && discord.sent.length === 2);
            const line = await heartbeat();
            assert.match(line, /niconicoOk=1 niconicoFail=0 niconicoAnnounced=1 /);
        });
        it('ClientReady は once: 2 回 emit してもポーラー開始と開始ログは 1 回だけ', async () => {
            build({ ...NICO, NICONICO_STATE_FILE: join(dir, 'state.json') });
            send(Events.ClientReady, ready());
            send(Events.ClientReady, ready());
            await settle(() => timeouts.length === 1);
            await flushIdle();
            assert.equal(timeouts.length, 1);
            assert.equal(logs.filter(([, m]) => m.startsWith('ニコニコ動画の新着告知を開始')).length, 1);
            assert.equal(logs.filter(([, m]) => m.startsWith('ログイン完了')).length, 1);
        });
        it('ポーラーには now と checkTimes が渡る（NICONICO_CHECK_TIMES=22:00 の定刻前は取得せず、定刻後に取得する）', async () => {
            // lastRunAt = 21:00 JST。既定の定刻(12:30,21:30)なら 21:40 JST でも取得対象になる
            await writeFile(
                join(dir, 'state.json'),
                JSON.stringify({ version: 1, userId: '140498', known: ['sm1'], pending: {}, lastRunAt: Date.parse('2026-11-10T12:00:00Z') }),
            );
            build({ ...NICO, NICONICO_STATE_FILE: join(dir, 'state.json'), NICONICO_CHECK_TIMES: '22:00' });
            send(Events.ClientReady, ready());
            await settle(() => timeouts.length === 1);
            now = Date.parse('2026-11-10T12:40:00Z'); // 21:40 JST（定刻 22:00 の前）
            await timeouts[0].fn();
            assert.deepEqual(fetchCalls, []);
            assert.equal(timeouts.length, 2);
            assert.equal(timeouts[1].ms, MIN);
            now = Date.parse('2026-11-10T13:01:00Z'); // 22:01 JST（定刻の後）
            await timeouts[1].fn();
            assert.ok(fetchCalls.length >= 1);
            assert.ok(fetchCalls[0].startsWith('https://nvapi.nicovideo.jp/v2/users/140498/videos'));
        });
        it('HEALTH_MAX_NOT_READY_MINUTES は分を ms に換算して使う（2 分 → 3 回目の確認で終了）', () => {
            build({ HEALTH_MAX_NOT_READY_MINUTES: '2' });
            assert.equal(ticksUntilFatal(startNotReady(), 20), 3);
        });
        it('HEALTH_MAX_NOT_READY_MINUTES 未設定なら 5 分（6 回目の確認で終了）', () => {
            build();
            assert.equal(ticksUntilFatal(startNotReady(), 20), 6);
        });
        it('READY のあいだは終了しない', () => {
            build({ HEALTH_MAX_NOT_READY_MINUTES: '1' });
            discord.ready = true;
            assert.equal(ticksUntilFatal(app0().monitor, 10), null);
        });
        it('onFatal は monitor.stop → destroy → exit(1) の順に呼ぶ', () => {
            const app = build({ HEALTH_MAX_NOT_READY_MINUTES: '1' });
            const originalStop = app.monitor.stop;
            app.monitor.stop = () => { calls.push('monitor.stop'); originalStop(); };
            discord.ready = false;
            assert.ok(ticksUntilFatal(app.monitor, 5) !== null);
            assert.deepEqual(calls, ['monitor.stop', 'destroy', 'exit:1']);
        });
        it('heartbeat は homeDir 配下の既定パスへ書かれ、uptime は uptimeMs の値を使う', async () => {
            const app = build({}, { uptime: 3723000 });
            discord.ready = true;
            app.monitor.tick();
            const line = await readFile(join(dir, 'Library', 'Logs', 'sns-collaborator', 'heartbeat.log'), 'utf8');
            assert.match(line, /heartbeat ws=READY ping=33ms uptime=0d1h2m3s /);
        });
        it('HEALTH_STATUS_FILE があればそのパスへ書く', async () => {
            const file = join(dir, 'custom', 'hb.log');
            const app = build({ HEALTH_STATUS_FILE: file });
            app.monitor.tick();
            assert.match(await readFile(file, 'utf8'), /heartbeat ws=NOT_READY/);
        });
        it('start() は monitor.start（setIntervalFn, 1 分）の後にトークンで login する', async () => {
            const app = build();
            await app.start();
            assert.deepEqual(calls, ['setInterval', 'login']);
            assert.equal(intervals[0].ms, MIN);
            assert.deepEqual(discord.logins, ['tok']);
        });
        it('ログイン失敗時も destroy は呼ばず、start() の Promise が reject される', async () => {
            const app = build();
            discord.login = async () => { throw new Error('login failed'); };
            await assert.rejects(app.start(), /login failed/);
            assert.ok(!calls.includes('destroy'));
        });
        it('ConfigError はクライアント生成・ログインの前に同期的に throw される', () => {
            let created = 0;
            assert.throws(
                () =>
                    createApp({
                        env: { ...BASE_ENV, DISCORD_TOKEN: '' },
                        homeDir: dir,
                        logger,
                        now: () => now,
                        fetchFn: async () => { throw new Error('呼ばれない'); },
                        setTimeoutFn: () => { throw new Error('呼ばれない'); },
                        setIntervalFn: () => { throw new Error('呼ばれない'); },
                        createDiscordClient: () => { created += 1; return new FakeDiscordClient({}, calls); },
                        createMisskeyClient: () => { created += 1; return {}; },
                        uptimeMs: () => 0,
                        exit: () => {},
                    }),
                (e) => e instanceof ConfigError && /DISCORD_TOKEN/.test(e.message),
            );
            assert.equal(created, 0);
            assert.deepEqual(calls, []);
        });
    });
});
