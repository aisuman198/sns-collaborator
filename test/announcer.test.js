import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    DESTINATIONS,
    buildAnnouncementText,
    buildShareText,
    buildTweetUrl,
    createAnnouncer,
    createDestinations,
    createPoller,
    createStateStore,
} from '../src/announcer.js';
import { ConfigError, createMessageHandler, loadConfig } from '../src/forwarder.js';
import { createHealthMonitor } from '../src/health.js';
import { parseCheckTimes } from '../src/schedule.js';
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

function setup({ fetchPage, fetchAll, destinations, fetchDescription, now = () => NOW } = {}) {
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
        fetchDescription: fetchDescription ?? (async () => ''),
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

describe('createPoller (定刻 12:30 / 21:30 JST)', () => {
    const MIN = 60 * 1000;
    const T = (iso) => Date.parse(iso);
    const TIMES = parseCheckTimes('12:30,21:30');
    const fakeTimers = () => {
        const q = [];
        return {
            q,
            setTimeoutFn: (fn, ms) => { const h = { fn, ms, cleared: false }; q.push(h); return h; },
            clearTimeoutFn: (h) => { h.cleared = true; },
        };
    };

    // 実 announcer + 実 store + 偽の時計・タイマーでポーラーを組み立てる
    function pollerSetup({ start, ...opts }) {
        const clock = { t: T(start) };
        const calls = { page: 0, all: 0 };
        const failPage = { on: false };
        const failAll = { on: false };
        const t = setup({
            now: () => clock.t,
            fetchPage: async () => {
                calls.page += 1;
                if (failPage.on) throw new Error('page failed');
                return { items: opts.items ?? [] };
            },
            fetchAll: async () => {
                calls.all += 1;
                if (failAll.on) throw new Error('all failed');
                return [];
            },
            destinations: opts.destinations,
        });
        const ft = fakeTimers();
        const poller = createPoller({
            inspect: t.announcer.inspect,
            tick: t.announcer.tick,
            checkTimes: TIMES,
            logger: t.logger,
            now: () => clock.t,
            ...ft,
        });
        poller.start();
        // 保留中のタイマーを 1 回発火する（minutes 分進めてから）
        const step = async (minutes = 1) => {
            clock.t += minutes * MIN;
            await ft.q.at(-1).fn();
        };
        return { ...t, clock, calls, failPage, failAll, ft, poller, step };
    }

    it('定刻前は実行されず、定刻を過ぎると 1 回だけ実行され、同じ定刻で再実行されない', async () => {
        seedState({ lastRunAt: T('2026-11-10T03:31:00Z') }); // 12:31 JST に実行済み
        const p = pollerSetup({ start: '2026-11-10T12:27:00Z' }); // 21:27 JST
        await p.ft.q[0].fn(); // 開始直後の判定
        await p.step(); // 21:28
        await p.step(); // 21:29
        assert.equal(p.calls.page, 0);
        await p.step(); // 21:30
        assert.equal(p.calls.page, 1);
        assert.equal(readState().lastRunAt, T('2026-11-10T12:30:00Z'));
        await p.step();
        await p.step(60);
        assert.equal(p.calls.page, 1);
    });
    it('スリープで 2 回分以上の定刻を飛ばしても復帰後に 1 回だけ実行する', async () => {
        seedState({ lastRunAt: T('2026-11-08T12:31:00Z') });
        const p = pollerSetup({ start: '2026-11-10T12:40:00Z' });
        await p.ft.q[0].fn();
        await p.step();
        await p.step();
        assert.equal(p.calls.page, 1);
    });
    it('定刻の間の再起動では実行されない', async () => {
        seedState({ lastRunAt: T('2026-11-10T03:31:00Z') }); // 12:31 JST に実行済み
        const p = pollerSetup({ start: '2026-11-10T06:00:00Z' }); // 15:00 JST に再起動
        await p.ft.q[0].fn();
        await p.step();
        assert.equal(p.calls.page, 0);
    });
    it('定刻を飛ばした再起動では実行される', async () => {
        seedState({ lastRunAt: T('2026-11-10T03:31:00Z') }); // 12:31 JST に実行済み
        const p = pollerSetup({ start: '2026-11-10T12:45:00Z' }); // 21:45 JST（21:30 を飛ばした）
        await p.ft.q[0].fn();
        assert.equal(p.calls.page, 1);
    });
    it('日付またぎでも前日 21:30 が直近として扱われる（JST 0:10 の起動で前日 21:31 実行済みなら実行しない）', async () => {
        seedState({ lastRunAt: T('2026-11-09T12:31:00Z') }); // 11/9 21:31 JST
        const p = pollerSetup({ start: '2026-11-09T15:10:00Z' }); // 11/10 00:10 JST
        await p.ft.q[0].fn();
        assert.equal(p.calls.page, 0);
    });
    it('状態ファイルなしは即シードし、lastRunAt を保存する', async () => {
        const p = pollerSetup({ start: '2026-11-10T06:00:00Z' });
        await p.ft.q[0].fn();
        assert.equal(p.calls.all, 1);
        assert.equal(readState().lastRunAt, T('2026-11-10T06:00:00Z'));
        await p.step();
        assert.equal(p.calls.all, 1);
        assert.equal(p.calls.page, 0);
    });
    it('取得失敗後は 5 分間隔で再試行し、lastRunAt は進まず、成功後は止まる', async () => {
        const lastRunAt = T('2026-11-10T03:31:00Z');
        seedState({ lastRunAt });
        const p = pollerSetup({ start: '2026-11-10T12:30:00Z' });
        p.failPage.on = true;
        await p.ft.q[0].fn();
        assert.equal(p.calls.page, 1);
        assert.equal(readState().lastRunAt, lastRunAt);
        for (let i = 0; i < 4; i += 1) await p.step(); // +1..+4 分: まだ再試行しない
        assert.equal(p.calls.page, 1);
        await p.step(); // +5 分: 再試行（失敗）
        assert.equal(p.calls.page, 2);
        assert.equal(readState().lastRunAt, lastRunAt);
        p.failPage.on = false;
        for (let i = 0; i < 4; i += 1) await p.step();
        assert.equal(p.calls.page, 2);
        await p.step(); // 再試行（成功）
        assert.equal(p.calls.page, 3);
        assert.equal(readState().lastRunAt, p.clock.t);
        await p.step(5);
        await p.step(5);
        assert.equal(p.calls.page, 3);
    });
    it('初回シードの失敗も 5 分間隔で再試行する', async () => {
        const p = pollerSetup({ start: '2026-11-10T06:00:00Z' });
        p.failAll.on = true;
        await p.ft.q[0].fn();
        assert.equal(createStateStore(file).load().status, 'missing');
        await p.step();
        assert.equal(p.calls.all, 1);
        p.failAll.on = false;
        await p.step(4);
        assert.equal(p.calls.all, 2);
        assert.equal(readState().userId, '140498');
        await p.step(5);
        assert.equal(p.calls.all, 2);
    });
    it('宛先失敗で pending が残ると 5 分後に再試行し、成功済みの宛先には再投稿しない', async () => {
        seedState({ lastRunAt: T('2026-11-10T03:31:00Z') });
        const sent = { announce: 0, twitter: 0, misskey: 0 };
        let twitterFails = true;
        const p = pollerSetup({
            start: '2026-11-10T12:30:00Z',
            items: [vid('sm2', HOUR)],
            destinations: {
                announce: async () => { sent.announce += 1; },
                twitter: async () => { if (twitterFails) throw new Error('403'); sent.twitter += 1; },
                misskey: async () => { sent.misskey += 1; },
            },
        });
        await p.ft.q[0].fn();
        assert.deepEqual(sent, { announce: 1, twitter: 0, misskey: 1 });
        assert.ok(readState().pending.sm2);
        for (let i = 0; i < 4; i += 1) await p.step();
        assert.equal(p.calls.page, 1);
        twitterFails = false;
        await p.step();
        assert.deepEqual(sent, { announce: 1, twitter: 1, misskey: 1 });
        assert.deepEqual(readState().pending, {});
        const pages = p.calls.page;
        await p.step(5);
        await p.step(5);
        assert.equal(p.calls.page, pages);
    });
    it('再起動後に pending が残っていれば、定刻でなくてもすぐ再試行する', async () => {
        seedState({
            lastRunAt: T('2026-11-10T12:31:00Z'),
            pending: { sm2: { title: 'T', url: 'u', registeredAt: iso(T('2026-11-10T12:00:00Z')), delivered: { announce: true, twitter: true, misskey: false } } },
        });
        const p = pollerSetup({ start: '2026-11-10T13:00:00Z' });
        await p.ft.q[0].fn();
        assert.equal(p.sent.misskey.length, 1);
        assert.equal(p.sent.announce.length, 0);
    });
    it('状態ファイルが破損していれば何もせず、ERROR は 1 回だけ（1 分ごとに連発しない）', async () => {
        createStateStore(file).save({ version: 1, userId: '140498', known: [], pending: {} });
        writeFileSync(file, '{broken');
        const p = pollerSetup({ start: '2026-11-10T12:30:00Z' });
        await p.ft.q[0].fn();
        for (let i = 0; i < 10; i += 1) await p.step();
        assert.equal(readFileSync(file, 'utf8'), '{broken');
        assert.equal(p.calls.page + p.calls.all, 0);
        assert.equal(p.logger.logs.error.length, 1);
    });
    it('実行中は次の判定をスキップする（重複実行しない）', async () => {
        const ft = fakeTimers();
        let calls = 0;
        let release;
        const gate = new Promise((r) => { release = r; });
        const poller = createPoller({
            inspect: () => ({ status: 'seed' }),
            tick: async () => { calls += 1; await gate; return { status: 'ok', pending: 0 }; },
            checkTimes: TIMES,
            logger: makeLogger(),
            ...ft,
        });
        poller.start();
        const first = ft.q[0].fn();
        const second = ft.q[0].fn();
        release();
        await Promise.all([first, second]);
        assert.equal(calls, 1);
        assert.equal(ft.q.length, 2);
    });
    it('tick が例外を投げても捕捉し、5 分後に再試行する', async () => {
        const ft = fakeTimers();
        const logger = makeLogger();
        const clock = { t: 0 };
        let calls = 0;
        const poller = createPoller({
            inspect: () => ({ status: 'seed' }),
            tick: async () => { calls += 1; throw new Error('boom'); },
            checkTimes: TIMES,
            logger,
            now: () => clock.t,
            ...ft,
        });
        poller.start();
        await ft.q[0].fn();
        assert.equal(logger.logs.error.length, 1);
        assert.equal(ft.q[1].ms, 60 * 1000);
        clock.t += 60 * 1000;
        await ft.q[1].fn();
        assert.equal(calls, 1);
        clock.t += 4 * 60 * 1000;
        await ft.q[2].fn();
        assert.equal(calls, 2);
    });
    it('stop() で予約を取り消し、以後は予約しない', async () => {
        const ft = fakeTimers();
        let calls = 0;
        const poller = createPoller({
            inspect: () => ({ status: 'seed' }),
            tick: async () => { calls += 1; return { status: 'ok', pending: 0 }; },
            checkTimes: TIMES,
            logger: makeLogger(),
            ...ft,
        });
        poller.start();
        poller.stop();
        assert.equal(ft.q[0].cleared, true);
        await ft.q[0].fn();
        assert.equal(calls, 0);
        assert.equal(ft.q.length, 1);
    });
});

describe('状態ファイルの lastRunAt', () => {
    it('数値は読み込め、省略も可、不正な型は corrupt', () => {
        const store = createStateStore(file);
        store.save({ version: 1, userId: '1', known: [], pending: {}, lastRunAt: 123 });
        assert.equal(store.load().status, 'ok');
        store.save({ version: 1, userId: '1', known: [], pending: {} });
        assert.equal(store.load().status, 'ok');
        for (const bad of ['"x"', 'null', '{}']) {
            writeFileSync(file, `{"version":1,"userId":"1","known":[],"pending":{},"lastRunAt":${bad}}`);
            assert.equal(store.load().status, 'corrupt', bad);
        }
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
            checkTimes: [750, 1290],
            stateFile: '/h/Library/Application Support/sns-collaborator/niconico-state.json',
        });
    });
    it('定刻・状態ファイルを上書きできる', () => {
        const env = { ...base, NICONICO_USER_ID: '1', DISCORD_POST_CHANNEL_ID: 'p', NICONICO_STATE_FILE: '/x.json' };
        assert.deepEqual(loadConfig({ ...env, NICONICO_CHECK_TIMES: '21:30, 9:05' }, '/h').niconico.checkTimes, [545, 1290]);
        assert.equal(loadConfig(env, '/h').niconico.stateFile, '/x.json');
    });
    it('不正な NICONICO_CHECK_TIMES は ConfigError', () => {
        const env = { ...base, NICONICO_USER_ID: '1', DISCORD_POST_CHANNEL_ID: 'p' };
        for (const bad of ['25:00', '12:60', 'abc', '12:30,', '12:30,12:30', '1230']) {
            assert.throws(() => loadConfig({ ...env, NICONICO_CHECK_TIMES: bad }, '/h'), ConfigError, bad);
        }
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

describe('buildShareText', () => {
    it('要約行をタイトルと URL の間に入れる', () => {
        assert.equal(
            buildShareText({ id: 'sm9', title: 'テスト', summary: '要約です。' }),
            '動画を投稿しました！\nテスト\n要約です。\nhttps://www.nicovideo.jp/watch/sm9',
        );
    });
    it('要約が空・未指定なら 3 行の告知文と同じ', () => {
        const base = { id: 'sm9', title: 'テスト' };
        assert.equal(buildShareText({ ...base, summary: '' }), buildAnnouncementText(base));
        assert.equal(buildShareText(base), buildAnnouncementText(base));
    });
    it('buildTweetUrl は要約入り文面ベースで、長いときも 512 文字以下で先頭行と URL を残す', () => {
        const video = { id: 'sm9', title: 'T', summary: '要約です。' };
        assert.equal(decodeURIComponent(buildTweetUrl(video).split('text=')[1]), buildShareText(video));
        const long = { id: 'sm9', title: 'あ'.repeat(100), summary: 'い'.repeat(100) };
        const url = buildTweetUrl(long);
        assert.ok(url.length <= 512);
        const lines = decodeURIComponent(url.split('text=')[1]).split('\n');
        assert.equal(lines[0], '動画を投稿しました！');
        assert.equal(lines.at(-1), 'https://www.nicovideo.jp/watch/sm9');
    });
});

describe('要約行つき告知', () => {
    it('announce は従来文面、twitter / misskey は要約入り。summary を保存し video にも渡す', async () => {
        seedState();
        const videos = [];
        const sent = { announce: [], twitter: [], misskey: [] };
        const dests = Object.fromEntries(
            DESTINATIONS.map((d) => [d, async (t, v) => { sent[d].push(t); videos.push(v); }]),
        );
        const t = setup({
            fetchPage: async () => ({ items: [vid('sm2', HOUR)] }),
            destinations: dests,
            fetchDescription: async (id) => { assert.equal(id, 'sm2'); return '一文目。\n二文目。'; },
        });
        await t.announcer.tick();
        const base = '動画を投稿しました！\ntitle-sm2\n';
        const url = 'https://www.nicovideo.jp/watch/sm2';
        assert.deepEqual(sent.announce, [`${base}${url}`]);
        assert.deepEqual(sent.twitter, [`${base}一文目。\n${url}`]);
        assert.deepEqual(sent.misskey, [`${base}一文目。\n${url}`]);
        assert.ok(videos.every((v) => v.summary === '一文目。' && v.id === 'sm2'));
    });
    it('配信前の状態ファイルに summary が保存される', async () => {
        seedState();
        const t = setup({
            fetchPage: async () => ({ items: [vid('sm2', HOUR)] }),
            destinations: { announce: async () => { throw new Error('x'); }, twitter: async () => { throw new Error('x'); }, misskey: async () => { throw new Error('x'); } },
            fetchDescription: async () => '保存される。',
        });
        await t.announcer.tick();
        assert.equal(readState().pending.sm2.summary, '保存される。');
    });
    it('要約が空なら twitter / misskey も 3 行', async () => {
        seedState();
        const t = setup({ fetchPage: async () => ({ items: [vid('sm2', HOUR)] }) });
        await t.announcer.tick();
        const text = '動画を投稿しました！\ntitle-sm2\nhttps://www.nicovideo.jp/watch/sm2';
        assert.deepEqual(t.sent, { announce: [text], twitter: [text], misskey: [text] });
    });
    it('取得失敗は WARN を出し、一覧の概要に『。』があればそれで代替する', async () => {
        seedState();
        const t = setup({
            fetchPage: async () => ({ items: [{ ...vid('sm2', HOUR), shortDescription: '代替です。続きが途中で切' }] }),
            fetchDescription: async () => { throw new Error('boom'); },
        });
        const r = await t.announcer.tick();
        assert.equal(r.status, 'ok');
        assert.equal(t.logger.logs.warn.length, 1);
        assert.match(t.logger.logs.warn[0], /sm2.*boom/);
        assert.match(t.sent.twitter[0], /\n代替です。\n/);
        assert.doesNotMatch(t.sent.announce[0], /代替です/);
    });
    it('取得失敗で概要に『。』が無ければ要約なし（配信は止めない）', async () => {
        seedState();
        const t = setup({
            fetchPage: async () => ({ items: [{ ...vid('sm2', HOUR), shortDescription: '句点なしで途中' }] }),
            fetchDescription: async () => { throw new Error('boom'); },
        });
        await t.announcer.tick();
        const text = '動画を投稿しました！\ntitle-sm2\nhttps://www.nicovideo.jp/watch/sm2';
        assert.deepEqual(t.sent.misskey, [text]);
        assert.equal(readState().pending.sm2, undefined);
    });
    it('summary の無い旧状態ファイルの pending も取得して配信される', async () => {
        seedState({
            pending: { sm2: { title: 'T', url: 'u', registeredAt: iso(NOW - HOUR), delivered: undelivered() } },
        });
        assert.equal(createStateStore(file).load().status, 'ok');
        const t = setup({ fetchDescription: async () => '旧状態。' });
        await t.announcer.tick();
        assert.deepEqual(t.sent.twitter, ['動画を投稿しました！\nT\n旧状態。\nhttps://www.nicovideo.jp/watch/sm2']);
        assert.deepEqual(t.sent.announce, ['動画を投稿しました！\nT\nhttps://www.nicovideo.jp/watch/sm2']);
    });
    it('旧状態ファイルで取得に失敗しても空の要約で配信する', async () => {
        seedState({
            pending: { sm2: { title: 'T', url: 'u', registeredAt: iso(NOW - HOUR), delivered: undelivered() } },
        });
        const t = setup({ fetchDescription: async () => { throw new Error('down'); } });
        await t.announcer.tick();
        assert.deepEqual(t.sent.misskey, ['動画を投稿しました！\nT\nhttps://www.nicovideo.jp/watch/sm2']);
        assert.equal(t.logger.logs.warn.length, 1);
    });
    it('summary が文字列以外の状態ファイルは corrupt', () => {
        const store = seedState();
        writeFileSync(
            file,
            JSON.stringify({ version: 1, userId: '1', known: [], pending: { a: { title: 't', url: 'u', registeredAt: iso(NOW), delivered: {}, summary: 1 } } }),
        );
        assert.equal(store.load().status, 'corrupt');
    });
});
