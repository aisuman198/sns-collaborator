import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    DESTINATIONS,
    buildAnnouncementText,
    buildTweetUrl,
    createAnnouncer,
    createDestinations,
    createPoller,
    createStateStore,
} from '../src/announcer.js';
import { ConfigError, createMessageHandler, loadConfig } from '../src/forwarder.js';
import { createHealthMonitor } from '../src/health.js';
import { createStats } from '../src/stats.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const HOUR = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const vid = (id, ageMs, title = `title-${id}`) => ({
    id,
    title,
    registeredAt: iso(NOW - ageMs),
    registeredAtMs: NOW - ageMs,
});

function makeLogger() {
    const logs = { info: [], warn: [], error: [] };
    const mk = (level) => (...args) => logs[level].push(args.map(String).join(' '));
    return { logs, info: mk('info'), log: mk('info'), warn: mk('warn'), error: mk('error') };
}

let dir;
let file;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'niconico-test-'));
    file = join(dir, 'sub', 'state.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup({ fetchPage, fetchAll, destinations, now = () => NOW } = {}) {
    const logger = makeLogger();
    const stats = createStats();
    const sent = { announce: [], twitter: [], misskey: [] };
    const dests = destinations ?? Object.fromEntries(DESTINATIONS.map((d) => [d, async (t) => { sent[d].push(t); }]));
    const store = createStateStore(file);
    const announcer = createAnnouncer({
        userId: '140498',
        store,
        destinations: dests,
        logger,
        stats,
        now,
        fetchPage: fetchPage ?? (async () => ({ items: [] })),
        fetchAll: fetchAll ?? (async () => []),
    });
    return { announcer, logger, stats, sent, store };
}

const seedState = (over = {}) => {
    const store = createStateStore(file);
    store.save({ version: 1, userId: '140498', known: ['sm1'], pending: {}, ...over });
    return store;
};
const readState = () => JSON.parse(readFileSync(file, 'utf8'));
const undelivered = () => ({ announce: false, twitter: false, misskey: false });

describe('buildAnnouncementText', () => {
    it('本文・タイトル・URL の書式', () => {
        assert.equal(
            buildAnnouncementText({ id: 'sm9', title: 'テスト' }),
            '動画を投稿しました！\nテスト\nhttps://www.nicovideo.jp/watch/sm9',
        );
    });
});

describe('状態ファイル', () => {
    it('ファイルなしは missing', () => {
        assert.equal(createStateStore(file).load().status, 'missing');
    });
    it('親ディレクトリを作って保存し、一時ファイルを残さない', () => {
        const store = createStateStore(file);
        const state = { version: 1, userId: '1', known: ['a'], pending: {} };
        store.save(state);
        assert.deepEqual(store.load(), { status: 'ok', state });
        assert.deepEqual(readdirSync(join(dir, 'sub')), ['state.json']);
    });
    it('JSON 破損・書式不正は corrupt', () => {
        const store = createStateStore(file);
        store.save({ version: 1, userId: '1', known: [], pending: {} });
        for (const text of ['{broken', '[]', '{"version":2}', '{"version":1,"userId":"1","known":"x","pending":{}}',
            '{"version":1,"userId":"1","known":[],"pending":{"a":{"title":"t"}}}']) {
            writeFileSync(file, text);
            assert.equal(store.load().status, 'corrupt', text);
        }
    });
});

describe('初回シード', () => {
    it('状態ファイルなしは全 ID を既知にするだけで投稿しない', async () => {
        const t = setup({ fetchAll: async () => [vid('sm3', HOUR), vid('sm2', 30 * HOUR), vid('sm1', 90 * HOUR)] });
        await t.announcer.tick();
        assert.deepEqual(readState().known, ['sm3', 'sm2', 'sm1']);
        assert.deepEqual(readState().pending, {});
        assert.deepEqual(t.sent, { announce: [], twitter: [], misskey: [] });
        assert.equal(t.stats.niconicoFetchOk, 1);
    });
    it('未来日時の動画は既知に入れず、公開後の通常ポーリングで告知される', async () => {
        let now = NOW;
        const future = { id: 'smF', title: '予約', registeredAt: iso(NOW + HOUR), registeredAtMs: NOW + HOUR };
        const t = setup({
            now: () => now,
            fetchAll: async () => [future, vid('sm1', HOUR)],
            fetchPage: async () => ({ items: [future, vid('sm1', HOUR)] }),
        });
        await t.announcer.tick();
        assert.deepEqual(t.sent, { announce: [], twitter: [], misskey: [] });
        assert.deepEqual(readState().known, ['sm1']);
        assert.match(t.logger.logs.info[0], /1 件/);
        now = NOW + HOUR + 1000;
        await t.announcer.tick();
        const text = '動画を投稿しました！\n予約\nhttps://www.nicovideo.jp/watch/smF';
        assert.deepEqual(t.sent, { announce: [text], twitter: [text], misskey: [text] });
    });
    it('保存された userId が設定と違えば再シード（投稿なし）', async () => {
        seedState({ userId: '999', known: ['old'] });
        const t = setup({ fetchAll: async () => [vid('sm5', HOUR)] });
        await t.announcer.tick();
        assert.equal(readState().userId, '140498');
        assert.deepEqual(readState().known, ['sm5']);
        assert.deepEqual(t.sent.announce, []);
    });
    it('途中ページ失敗なら何も保存せず失敗扱い', async () => {
        const t = setup({ fetchAll: async () => { throw new Error('page2 failed'); } });
        await t.announcer.tick();
        assert.equal(createStateStore(file).load().status, 'missing');
        assert.equal(t.stats.niconicoFetchFailed, 1);
        assert.equal(t.logger.logs.warn.length, 1);
    });
});

describe('新着判定', () => {
    it('既知との差分のみ告知し、3 宛先へ同じ文面を送る', async () => {
        seedState();
        const t = setup({ fetchPage: async () => ({ items: [vid('sm2', HOUR, '新作'), vid('sm1', 2 * HOUR)] }) });
        await t.announcer.tick();
        const text = '動画を投稿しました！\n新作\nhttps://www.nicovideo.jp/watch/sm2';
        assert.deepEqual(t.sent, { announce: [text], twitter: [text], misskey: [text] });
        assert.deepEqual(readState().known, ['sm1', 'sm2']);
        assert.deepEqual(readState().pending, {});
        assert.equal(t.stats.niconicoAnnounced, 1);
    });
    it('投稿日時や ID の大小ではなく ID の差分で判定する（古い ID でも未知なら告知）', async () => {
        seedState({ known: ['sm100'] });
        const t = setup({ fetchPage: async () => ({ items: [vid('sm5', HOUR)] }) });
        await t.announcer.tick();
        assert.equal(t.sent.announce.length, 1);
    });
    it('通常ポーリングは先頭ページのみ pageSize=20', async () => {
        seedState();
        const calls = [];
        const t = setup({ fetchPage: async (page, size) => { calls.push([page, size]); return { items: [] }; } });
        await t.announcer.tick();
        assert.deepEqual(calls, [[1, 20]]);
    });
    it('未来の動画は無視し既知にも追加しない。時刻が来たら告知される', async () => {
        seedState();
        let now = NOW;
        const future = { id: 'sm9', title: 'f', registeredAt: iso(NOW + HOUR), registeredAtMs: NOW + HOUR };
        const t = setup({ now: () => now, fetchPage: async () => ({ items: [future] }) });
        await t.announcer.tick();
        assert.deepEqual(t.sent.announce, []);
        assert.deepEqual(readState().known, ['sm1']);
        now = NOW + HOUR + 1000;
        await t.announcer.tick();
        assert.equal(t.sent.announce.length, 1);
    });
    it('24 時間以上前の新規 ID は投稿せず既知に登録して WARN', async () => {
        seedState();
        const t = setup({ fetchPage: async () => ({ items: [vid('sm2', 24 * HOUR), vid('sm3', 24 * HOUR - 1000)] }) });
        await t.announcer.tick();
        assert.deepEqual(t.sent.announce.map((x) => x.includes('sm3')), [true]);
        assert.deepEqual(readState().known, ['sm1', 'sm2', 'sm3']);
        assert.ok(t.logger.logs.warn.some((m) => m.includes('sm2')));
    });
    it('告知対象が 3 件なら古い順に配信する', async () => {
        seedState();
        const order = [];
        const t = setup({
            fetchPage: async () => ({ items: [vid('c', HOUR), vid('b', 2 * HOUR), vid('a', 3 * HOUR)] }),
            destinations: {
                announce: async (text) => { order.push(text.split('\n')[1]); },
                twitter: async () => {},
                misskey: async () => {},
            },
        });
        await t.announcer.tick();
        assert.deepEqual(order, ['title-a', 'title-b', 'title-c']);
    });
    it('告知対象が 4 件以上は異常: 投稿せず全部既知にし ID を含む ERROR', async () => {
        seedState();
        const items = ['a', 'b', 'c', 'd'].map((id, i) => vid(id, (i + 1) * HOUR));
        const t = setup({ fetchPage: async () => ({ items }) });
        await t.announcer.tick();
        assert.deepEqual(t.sent.announce, []);
        assert.deepEqual(readState().known, ['sm1', 'a', 'b', 'c', 'd']);
        assert.deepEqual(readState().pending, {});
        assert.equal(t.logger.logs.error.length, 1);
        for (const id of ['a', 'b', 'c', 'd']) assert.match(t.logger.logs.error[0], new RegExp(id));
    });
    it('古い ID は 4 件の判定に数えない', async () => {
        seedState();
        const items = [vid('a', HOUR), vid('b', 2 * HOUR), vid('o1', 30 * HOUR), vid('o2', 31 * HOUR), vid('o3', 32 * HOUR)];
        const t = setup({ fetchPage: async () => ({ items }) });
        await t.announcer.tick();
        assert.equal(t.sent.announce.length, 2);
        assert.equal(t.logger.logs.error.length, 0);
    });
    it('一度既知になった ID は再告知しない（非公開→再公開）', async () => {
        seedState();
        const t = setup({ fetchPage: async () => ({ items: [vid('sm2', HOUR)] }) });
        await t.announcer.tick();
        await t.announcer.tick();
        assert.equal(t.sent.announce.length, 1);
        const t2 = setup({ fetchPage: async () => ({ items: [] }) });
        await t2.announcer.tick();
        const t3 = setup({ fetchPage: async () => ({ items: [vid('sm2', HOUR)] }) });
        await t3.announcer.tick();
        assert.equal(t3.sent.announce.length, 0);
        assert.ok(readState().known.includes('sm2'));
    });
});

describe('取得失敗', () => {
    it('失敗は新着なしと扱わず状態を変更しない', async () => {
        seedState();
        const before = readFileSync(file, 'utf8');
        const t = setup({ fetchPage: async () => { throw new Error('boom'); } });
        await t.announcer.tick();
        assert.equal(readFileSync(file, 'utf8'), before);
        assert.equal(t.stats.niconicoFetchFailed, 1);
        assert.equal(t.logger.logs.warn.length, 1);
    });
    it('連続 3 回で ERROR を 1 回だけ、回復時に INFO を 1 回', async () => {
        seedState();
        let fail = true;
        const t = setup({ fetchPage: async () => { if (fail) throw new Error('x'); return { items: [] }; } });
        for (let i = 0; i < 5; i += 1) await t.announcer.tick();
        assert.equal(t.logger.logs.error.length, 1);
        assert.equal(t.logger.logs.warn.length, 5);
        fail = false;
        await t.announcer.tick();
        await t.announcer.tick();
        assert.equal(t.logger.logs.info.filter((m) => m.includes('回復')).length, 1);
        assert.equal(t.stats.niconicoFetchOk, 2);
        assert.equal(t.stats.niconicoFetchFailed, 5);
    });
    it('取得が失敗したティックでも pending の再試行は行う', async () => {
        seedState({
            pending: { sm2: { title: 'T', url: 'u', registeredAt: iso(NOW - HOUR), delivered: undelivered() } },
        });
        const t = setup({ fetchPage: async () => { throw new Error('x'); } });
        await t.announcer.tick();
        assert.equal(t.sent.misskey.length, 1);
        assert.deepEqual(readState().pending, {});
    });
});

describe('状態ファイル破損', () => {
    it('初回扱いにせず上書きもせず ERROR を出して何もしない', async () => {
        createStateStore(file).save({ version: 1, userId: '140498', known: [], pending: {} });
        writeFileSync(file, '{broken');
        let fetched = 0;
        const t = setup({
            fetchAll: async () => { fetched += 1; return []; },
            fetchPage: async () => { fetched += 1; return { items: [] }; },
        });
        await t.announcer.tick();
        await t.announcer.tick();
        assert.equal(readFileSync(file, 'utf8'), '{broken');
        assert.equal(fetched, 0);
        assert.equal(t.logger.logs.error.length, 1);
        assert.deepEqual(t.sent.announce, []);
    });
});

describe('宛先ごとの配信と再試行', () => {
    it('ある宛先の失敗は他を止めず、失敗分のみ次のティックで再試行する', async () => {
        seedState();
        const sent = { announce: 0, twitter: 0, misskey: 0 };
        let twitterFails = true;
        const t = setup({
            fetchPage: async () => ({ items: [vid('sm2', HOUR)] }),
            destinations: {
                announce: async () => { sent.announce += 1; },
                twitter: async () => { if (twitterFails) throw new Error('403'); sent.twitter += 1; },
                misskey: async () => { sent.misskey += 1; },
            },
        });
        await t.announcer.tick();
        assert.deepEqual(sent, { announce: 1, twitter: 0, misskey: 1 });
        assert.deepEqual(readState().pending.sm2.delivered, { announce: true, twitter: false, misskey: true });
        assert.equal(t.logger.logs.error.length, 1);
        assert.equal(t.stats.niconicoAnnounced, 0);

        twitterFails = false;
        await t.announcer.tick();
        assert.deepEqual(sent, { announce: 1, twitter: 1, misskey: 1 });
        assert.deepEqual(readState().pending, {});
        assert.equal(t.stats.niconicoAnnounced, 1);
    });
    it('投稿前に未配信として保存され、成功の都度保存される', async () => {
        seedState();
        const snapshots = [];
        const mk = (name) => async () => { snapshots.push([name, structuredClone(readState().pending.sm2?.delivered ?? null)]); };
        const t = setup({
            fetchPage: async () => ({ items: [vid('sm2', HOUR)] }),
            destinations: { announce: mk('announce'), twitter: mk('twitter'), misskey: mk('misskey') },
        });
        await t.announcer.tick();
        assert.deepEqual(snapshots, [
            ['announce', { announce: false, twitter: false, misskey: false }],
            ['twitter', { announce: true, twitter: false, misskey: false }],
            ['misskey', { announce: true, twitter: true, misskey: false }],
        ]);
    });
    it('再起動相当（新しい announcer）でも配信済み宛先を再送しない', async () => {
        seedState({
            pending: { sm2: { title: 'T', url: 'u', registeredAt: iso(NOW - HOUR), delivered: { announce: true, twitter: true, misskey: false } } },
        });
        const t = setup();
        await t.announcer.tick();
        assert.deepEqual(t.sent, { announce: [], twitter: [], misskey: ['動画を投稿しました！\nT\nhttps://www.nicovideo.jp/watch/sm2'] });
    });
    it('24 時間過ぎた未配信は諦めて ERROR を出し pending から除く', async () => {
        seedState({
            pending: { sm2: { title: 'T', url: 'u', registeredAt: iso(NOW - 25 * HOUR), delivered: undelivered() } },
        });
        const t = setup();
        await t.announcer.tick();
        assert.deepEqual(t.sent, { announce: [], twitter: [], misskey: [] });
        assert.deepEqual(readState().pending, {});
        assert.ok(readState().known.includes('sm1'));
        assert.match(t.logger.logs.error[0], /sm2/);
    });
});

describe('buildTweetUrl', () => {
    const decode = (url) => decodeURIComponent(url.replace('https://twitter.com/intent/tweet?text=', ''));
    const hasLoneSurrogate = (s) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

    it('decode すると 3 行の本文に戻り、改行は %0A、# は %23', () => {
        const video = { id: 'sm9', title: '#時のオカリナ #2 テスト' };
        const url = buildTweetUrl(video);
        assert.equal(decode(url), buildAnnouncementText(video));
        assert.ok(url.startsWith('https://twitter.com/intent/tweet?text='));
        assert.ok(url.includes('%0A'));
        assert.ok(url.includes('%23%E6%99%82'));
        assert.ok(!url.includes('#'));
    });
    it('短いタイトルは切り詰めない', () => {
        assert.equal(decode(buildTweetUrl({ id: 'sm9', title: 'abc' })), buildAnnouncementText({ id: 'sm9', title: 'abc' }));
    });
    for (const [name, title] of [
        ['100 文字の日本語', 'あ'.repeat(100)],
        ['絵文字混じり', '🎮'.repeat(40) + '動画'.repeat(40)],
        ['極端に長い', 'ア#'.repeat(300)],
    ]) {
        it(`512 文字以下に収め、1 行目と動画 URL を残す: ${name}`, () => {
            const url = buildTweetUrl({ id: 'sm9', title });
            assert.ok(url.length <= 512, `length=${url.length}`);
            const lines = decode(url).split('\n');
            assert.equal(lines.length, 3);
            assert.equal(lines[0], '動画を投稿しました！');
            assert.equal(lines[2], 'https://www.nicovideo.jp/watch/sm9');
            assert.ok(lines[1].endsWith('…'));
            assert.ok(title.startsWith(lines[1].slice(0, -1)));
            assert.ok(!hasLoneSurrogate(lines[1]));
        });
    }
});

describe('createDestinations', () => {
    it('twitter は embed + ツイートボタン、announce はプレーンな content', async () => {
        const sends = [];
        const discordClient = {
            channels: { fetch: async (id) => ({ send: async (arg) => { sends.push([id, arg]); } }) },
        };
        const d = createDestinations({ discordClient, misskeyClient: {}, announceChannelId: 'A', twitterChannelId: 'T' });
        const video = { id: 'sm2', title: '新作 #1' };
        const text = buildAnnouncementText(video);
        await d.announce(text, video);
        await d.twitter(text, video);
        assert.deepEqual(sends[0], ['A', { content: text, allowedMentions: { parse: [] } }]);
        assert.equal(sends[0][1].components, undefined);
        assert.equal(sends[0][1].embeds, undefined);
        assert.deepEqual(sends[1], [
            'T',
            {
                content: '',
                embeds: [{ description: text }],
                components: [
                    { type: 1, components: [{ type: 2, style: 5, label: 'ツイートする', url: buildTweetUrl(video) }] },
                ],
                allowedMentions: { parse: [] },
            },
        ]);
    });
    it('embed の本文は切り詰めない完全なタイトル', async () => {
        const sends = [];
        const discordClient = { channels: { fetch: async () => ({ send: async (a) => { sends.push(a); } }) } };
        const d = createDestinations({ discordClient, misskeyClient: {}, announceChannelId: 'A', twitterChannelId: 'T' });
        const video = { id: 'sm2', title: 'あ'.repeat(300) };
        await d.twitter(buildAnnouncementText(video), video);
        assert.ok(sends[0].embeds[0].description.includes(video.title));
        assert.ok(sends[0].components[0].components[0].url.length <= 512);
    });
    it('Discord は常に allowedMentions: { parse: [] } 付きで送信し、Misskey は notes/create', async () => {
        const sends = [];
        const fetched = [];
        const discordClient = {
            channels: {
                fetch: async (id) => {
                    fetched.push(id);
                    return { send: async (arg) => { sends.push([id, arg]); } };
                },
            },
        };
        const requests = [];
        const misskeyClient = { request: async (...a) => { requests.push(a); } };
        const d = createDestinations({ discordClient, misskeyClient, announceChannelId: 'A', twitterChannelId: 'T' });
        const text = '@everyone\nhello';
        const video = { id: 'sm1', title: '@everyone hello' };
        await d.announce(text, video);
        await d.twitter(text, video);
        await d.misskey(text);
        assert.deepEqual(fetched, ['A', 'T']);
        assert.deepEqual(sends[0], ['A', { content: text, allowedMentions: { parse: [] } }]);
        assert.equal(sends[1][0], 'T');
        assert.deepEqual(sends[1][1].allowedMentions, { parse: [] });
        assert.deepEqual(requests, [['notes/create', { text }]]);
    });
    it('チャンネルが取得できなければ例外', async () => {
        const d = createDestinations({
            discordClient: { channels: { fetch: async () => null } },
            misskeyClient: {},
            announceChannelId: 'A',
            twitterChannelId: 'T',
        });
        await assert.rejects(d.announce('x'), /送信できません/);
    });
});

describe('bot 自身の配信告知投稿は Misskey に二重転送されない', () => {
    it('selfId の発言は転送されない（許可 bot リストに自分が入っていても）', async () => {
        const requests = [];
        const misskey = { request: async (...a) => { requests.push(a); } };
        const handler = createMessageHandler(misskey, 'announce-ch', makeLogger(), createStats(), Date.now, {
            allowedBotIds: ['self-bot'],
            selfId: () => 'self-bot',
        });
        await handler({
            id: 'm1',
            author: { id: 'self-bot', bot: true },
            channel: { id: 'announce-ch' },
            content: '動画を投稿しました！\nT\nhttps://www.nicovideo.jp/watch/sm2',
            embeds: [],
        });
        assert.deepEqual(requests, []);
    });
});

describe('createPoller', () => {
    const fakeTimers = () => {
        const q = [];
        return {
            q,
            setTimeoutFn: (fn, ms) => { const h = { fn, ms, cleared: false }; q.push(h); return h; },
            clearTimeoutFn: (h) => { h.cleared = true; },
        };
    };
    it('完了後に次を予約する（重複実行しない）', async () => {
        const ft = fakeTimers();
        let running = 0;
        let maxRunning = 0;
        let calls = 0;
        const poller = createPoller({
            tick: async () => { calls += 1; running += 1; maxRunning = Math.max(maxRunning, running); await Promise.resolve(); running -= 1; },
            intervalMs: 300000,
            logger: makeLogger(),
            ...ft,
        });
        poller.start();
        poller.start(); // 二重 start は無視
        assert.equal(ft.q.length, 1);
        await ft.q[0].fn();
        assert.equal(ft.q.length, 2);
        assert.equal(ft.q[1].ms, 300000);
        await ft.q[1].fn();
        assert.equal(calls, 2);
        assert.equal(maxRunning, 1);
    });
    it('tick が例外を投げても捕捉して次を予約する', async () => {
        const ft = fakeTimers();
        const logger = makeLogger();
        const poller = createPoller({ tick: async () => { throw new Error('boom'); }, intervalMs: 1, logger, ...ft });
        poller.start();
        await ft.q[0].fn();
        assert.equal(logger.logs.error.length, 1);
        assert.equal(ft.q.length, 2);
    });
    it('stop() で予約を取り消し、以後は予約しない', async () => {
        const ft = fakeTimers();
        let calls = 0;
        const poller = createPoller({ tick: async () => { calls += 1; }, intervalMs: 1, logger: makeLogger(), ...ft });
        poller.start();
        poller.stop();
        assert.equal(ft.q[0].cleared, true);
        await ft.q[0].fn();
        assert.equal(calls, 0);
        assert.equal(ft.q.length, 1);
    });
});

describe('loadConfig (ニコニコ設定)', () => {
    const base = {
        DISCORD_TOKEN: 't',
        DISCORD_CHANNEL_ID: 'c',
        MISSKEY_INSTANCE_URL: 'https://misskey.example',
        MISSKEY_API_TOKEN: 'm',
    };
    it('NICONICO_USER_ID 未設定なら機能オフ', () => {
        assert.equal(loadConfig(base, '/h').niconico, null);
    });
    it('設定時は既定値が入る', () => {
        const c = loadConfig({ ...base, NICONICO_USER_ID: '140498', DISCORD_POST_CHANNEL_ID: 'p' }, '/h');
        assert.deepEqual(c.niconico, {
            userId: '140498',
            postChannelId: 'p',
            pollMinutes: 5,
            stateFile: '/h/Library/Application Support/sns-collaborator/niconico-state.json',
        });
    });
    it('間隔・状態ファイルを上書きでき、不正な間隔は既定値', () => {
        const env = { ...base, NICONICO_USER_ID: '1', DISCORD_POST_CHANNEL_ID: 'p', NICONICO_STATE_FILE: '/x.json' };
        assert.equal(loadConfig({ ...env, NICONICO_POLL_MINUTES: '10' }, '/h').niconico.pollMinutes, 10);
        assert.equal(loadConfig({ ...env, NICONICO_POLL_MINUTES: 'abc' }, '/h').niconico.pollMinutes, 5);
        assert.equal(loadConfig(env, '/h').niconico.stateFile, '/x.json');
    });
    it('DISCORD_POST_CHANNEL_ID が無ければ ConfigError', () => {
        assert.throws(() => loadConfig({ ...base, NICONICO_USER_ID: '1' }, '/h'), ConfigError);
        assert.throws(() => loadConfig({ ...base, NICONICO_USER_ID: '1' }, '/h'), /DISCORD_POST_CHANNEL_ID/);
    });
    it('数字以外のユーザー ID は ConfigError', () => {
        assert.throws(
            () => loadConfig({ ...base, NICONICO_USER_ID: '../x', DISCORD_POST_CHANNEL_ID: 'p' }, '/h'),
            ConfigError,
        );
    });
});

describe('heartbeat への統計出力', () => {
    it('niconico のカウンタが heartbeat 行に含まれる', () => {
        const stats = createStats();
        stats.niconicoFetchOk = 3;
        stats.niconicoFetchFailed = 1;
        stats.niconicoAnnounced = 2;
        const lines = [];
        const monitor = createHealthMonitor({
            now: () => 0,
            logger: makeLogger(),
            stats,
            getStatus: () => ({ ready: true, ping: 1, uptimeMs: 0 }),
            writeStatus: (l) => lines.push(l),
            onFatal: () => {},
        });
        monitor.tick();
        assert.match(lines[0], /niconicoOk=3 niconicoFail=1 niconicoAnnounced=2 lastReceived=/);
    });
});
