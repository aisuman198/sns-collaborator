// 特性テスト: ニコニコ告知・状態ファイル・設定の「現行挙動」を固定する（src は変更しない）。
// 期待値は仕様ではなく実際の挙動。意図しない挙動には // F番号 を付けている。
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    ANOMALY_THRESHOLD,
    DESTINATIONS,
    STALE_MS,
    createAnnouncer,
    createPoller,
    createStateStore,
} from '../src/announcer.js';
import { ConfigError, loadConfig } from '../src/forwarder.js';
import { NiconicoError, fetchAllUserVideos, fetchUserVideosPage } from '../src/niconico.js';
import { createStats } from '../src/stats.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const HOUR = 3600 * 1000;
const USER = '140498';
/** 告知文中の動画 URL から動画 ID を取り出す（宛先関数の第 2 引数に依存しない）。 */
const idOf = (text) => /nicovideo\.jp\/watch\/([^\s]+)/.exec(text)[1];
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
    dir = mkdtempSync(join(tmpdir(), 'niconico-char-'));
    file = join(dir, 'sub', 'state.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup({ fetchPage, fetchAll, destinations, store, now = () => NOW, userId = USER } = {}) {
    const logger = makeLogger();
    const stats = createStats();
    const sent = { announce: [], twitter: [], misskey: [] };
    const dests = destinations ?? Object.fromEntries(DESTINATIONS.map((d) => [d, async (t) => { sent[d].push(t); }]));
    const st = store ?? createStateStore(file);
    const announcer = createAnnouncer({
        userId,
        store: st,
        destinations: dests,
        logger,
        stats,
        now,
        fetchPage: fetchPage ?? (async () => ({ items: [] })),
        fetchAll: fetchAll ?? (async () => []),
    });
    return { announcer, logger, stats, sent, store: st };
}

const seedState = (over = {}) => {
    const store = createStateStore(file);
    store.save({ version: 1, userId: USER, known: ['sm1'], pending: {}, ...over });
    return store;
};
const readState = () => JSON.parse(readFileSync(file, 'utf8'));
const pend = (registeredAt, delivered = { announce: false, twitter: false, misskey: false }) => ({
    title: 't',
    url: 'https://www.nicovideo.jp/watch/x',
    registeredAt,
    delivered,
});

/** n 回目の save だけ失敗させる store ラッパー（実ファイルに書く）。 */
function flakyStore(failOn) {
    const real = createStateStore(file);
    let n = 0;
    return {
        file,
        load: () => real.load(),
        save(state) {
            n += 1;
            if (failOn(n)) throw new Error('disk full');
            real.save(state);
        },
        get calls() { return n; },
    };
}

// ---------------------------------------------------------------- C12
describe('C12 既定の取得経路 (globalThis.fetch 差し替え)', () => {
    let original;
    let calls;
    beforeEach(() => {
        original = globalThis.fetch;
        calls = [];
    });
    afterEach(() => {
        globalThis.fetch = original;
    });
    const body = (items, totalCount = items.length) => ({
        meta: { status: 200 },
        data: { totalCount, items: items.map((i) => ({ essential: i })) },
    });
    const install = (b) => {
        globalThis.fetch = async (url, init) => {
            calls.push({ url, init });
            return { status: 200, json: async () => b };
        };
    };

    it('fetchPage/fetchAll を注入しない初回 tick は globalThis.fetch で pageSize=100 の全件取得をしてシードする', async () => {
        install(body([{ id: 'sm1', title: 'a', registeredAt: iso(NOW - HOUR) }]));
        const logger = makeLogger();
        const a = createAnnouncer({
            userId: USER, store: createStateStore(file), destinations: {}, logger, stats: createStats(), now: () => NOW,
        });
        assert.deepEqual(await a.tick(), { status: 'ok', pending: 0 });
        assert.equal(calls.length, 1);
        assert.equal(
            calls[0].url,
            `https://nvapi.nicovideo.jp/v2/users/${USER}/videos?sortKey=registeredAt&sortOrder=desc&pageSize=100&page=1`,
        );
        assert.deepEqual(calls[0].init.headers, { 'X-Frontend-Id': '6', 'User-Agent': 'sns-collaborator' });
        assert.ok(calls[0].init.signal instanceof AbortSignal);
        assert.deepEqual(readState().known, ['sm1']);
    });

    it('通常 tick は pageSize=20 の 1 ページだけ取得し、新着を 3 宛先へ配信する', async () => {
        seedState();
        install(body([{ id: 'sm2', title: 'new', registeredAt: iso(NOW - HOUR) }]));
        const sent = [];
        const dests = Object.fromEntries(DESTINATIONS.map((d) => [d, async () => { sent.push(d); }]));
        const a = createAnnouncer({
            userId: USER, store: createStateStore(file), destinations: dests, logger: makeLogger(),
            stats: createStats(), now: () => NOW,
        });
        await a.tick();
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, /pageSize=20&page=1$/);
        assert.deepEqual(sent, ['announce', 'twitter', 'misskey']);
    });

    it('fetchUserVideosPage も fetchFn 省略時は呼び出し時点の globalThis.fetch を使う', async () => {
        install(body([]));
        await fetchUserVideosPage({ userId: 'a b/c' });
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, /\/v2\/users\/a%20b%2Fc\/videos\?/);
    });

    it('fetch が reject すると tick は failed を返し、状態ファイルは作られない', async () => {
        globalThis.fetch = async () => { throw new Error('network down'); };
        const logger = makeLogger();
        const stats = createStats();
        const a = createAnnouncer({
            userId: USER, store: createStateStore(file), destinations: {}, logger, stats, now: () => NOW,
        });
        assert.deepEqual(await a.tick(), { status: 'failed', pending: 0 });
        assert.equal(stats.niconicoFetchFailed, 1);
        assert.match(logger.logs.warn[0], /nvapi の取得に失敗しました \(page=1\): network down/);
        assert.throws(() => readFileSync(file), { code: 'ENOENT' });
    });
});

// ---------------------------------------------------------------- C13
describe('C13 状態ファイルのゴールデン (README の形状)', () => {
    it('シード直後のファイル全文（2 スペース整形・キー順・末尾改行なし）', async () => {
        const t = setup({ fetchAll: async () => [vid('sm1', HOUR), vid('sm2', 2 * HOUR)] });
        await t.announcer.tick();
        assert.equal(
            readFileSync(file, 'utf8'),
            JSON.stringify(
                { version: 1, userId: USER, known: ['sm1', 'sm2'], pending: {}, lastRunAt: NOW },
                null,
                2,
            ),
        );
        assert.equal(readFileSync(file, 'utf8').endsWith('\n'), false);
    });

    it('twitter だけ未配信で残った状態: キーと値の形が README と同じ', async () => {
        seedState({ lastRunAt: NOW - HOUR });
        const registeredAt = '2026-11-10T20:00:00+09:00'; // = 11:00Z, NOW の 1 時間前
        const t = setup({
            fetchPage: async () => ({
                items: [{ id: 'sm3', title: 'タイトル', registeredAt, registeredAtMs: Date.parse(registeredAt) }],
            }),
            destinations: {
                announce: async () => {},
                twitter: async () => { throw new Error('boom'); },
                misskey: async () => {},
            },
        });
        const r = await t.announcer.tick();
        assert.deepEqual(r, { status: 'ok', pending: 1 });
        assert.deepEqual(readState(), {
            version: 1,
            userId: USER,
            known: ['sm1', 'sm3'],
            pending: {
                sm3: {
                    title: 'タイトル',
                    url: 'https://www.nicovideo.jp/watch/sm3',
                    registeredAt, // 取得文字列そのまま（正規化しない）
                    delivered: { announce: true, twitter: false, misskey: true },
                },
            },
            lastRunAt: NOW,
        });
        // pending 内のキー順
        assert.deepEqual(Object.keys(readState().pending.sm3), ['title', 'url', 'registeredAt', 'delivered']);
        assert.deepEqual(Object.keys(readState().pending.sm3.delivered), ['announce', 'twitter', 'misskey']);
    });

    it('README の例そのままのファイルは ok として読める', () => {
        mkdirSync(join(dir, 'sub'));
        writeFileSync(
            file,
            '{"version":1,"userId":"140498","lastRunAt":1794225600000,"known":["sm1","sm2"],"pending":{"sm3":{"title":"...","url":"https://www.nicovideo.jp/watch/sm3","registeredAt":"2026-11-09T21:00:00+09:00","delivered":{"announce":true,"twitter":false,"misskey":false}}}}',
        );
        const r = createStateStore(file).load();
        assert.equal(r.status, 'ok');
        assert.deepEqual(Object.keys(r.state.pending.sm3.delivered), ['announce', 'twitter', 'misskey']);
    });
});

// ---------------------------------------------------------------- C14
describe('C14 validateState の分岐 (reason 文字列)', () => {
    const base = { version: 1, userId: '1', known: [], pending: {} };
    const okPending = { title: 't', url: 'u', registeredAt: '2026-11-10T00:00:00Z', delivered: {} };
    const reasonOf = (obj) => {
        mkdirSync(join(dir, 'sub'), { recursive: true });
        writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
        const r = createStateStore(file).load();
        return r.status === 'ok' ? 'OK' : r.reason;
    };

    it('各不正の reason', () => {
        assert.equal(reasonOf('null'), '状態がオブジェクトではありません');
        assert.equal(reasonOf('"s"'), '状態がオブジェクトではありません');
        assert.equal(reasonOf('[]'), '状態がオブジェクトではありません');
        assert.equal(reasonOf({ ...base, version: undefined }), '未対応の version: undefined');
        assert.equal(reasonOf({ ...base, version: '1' }), '未対応の version: 1'); // 文字列 "1" は不可
        assert.equal(reasonOf({ ...base, version: 2 }), '未対応の version: 2');
        assert.equal(reasonOf({ ...base, userId: '' }), 'userId が不正です');
        assert.equal(reasonOf({ ...base, userId: 140498 }), 'userId が不正です'); // 数値は不可
        assert.equal(reasonOf({ ...base, userId: undefined }), 'userId が不正です');
        assert.equal(reasonOf({ ...base, known: undefined }), 'known が不正です');
        assert.equal(reasonOf({ ...base, known: ['a', 1] }), 'known が不正です');
        assert.equal(reasonOf({ ...base, pending: undefined }), 'pending が不正です');
        assert.equal(reasonOf({ ...base, pending: null }), 'pending が不正です');
        assert.equal(reasonOf({ ...base, pending: [] }), 'pending が不正です');
        assert.equal(reasonOf({ ...base, pending: { a: null } }), 'pending[a] が不正です');
        assert.equal(reasonOf({ ...base, pending: { a: 'x' } }), 'pending[a] が不正です');
        assert.equal(reasonOf({ ...base, pending: { a: { ...okPending, title: 1 } } }), 'pending[a] の title/url が不正です');
        assert.equal(reasonOf({ ...base, pending: { a: { ...okPending, url: undefined } } }), 'pending[a] の title/url が不正です');
        assert.equal(reasonOf({ ...base, pending: { a: { ...okPending, registeredAt: 'bad' } } }), 'pending[a].registeredAt が不正です');
        assert.equal(reasonOf({ ...base, pending: { a: { ...okPending, registeredAt: undefined } } }), 'pending[a].registeredAt が不正です');
        assert.equal(reasonOf({ ...base, pending: { a: { ...okPending, delivered: undefined } } }), 'pending[a].delivered が不正です');
        assert.equal(reasonOf({ ...base, pending: { a: { ...okPending, delivered: null } } }), 'pending[a].delivered が不正です');
        assert.equal(reasonOf({ ...base, pending: { a: { ...okPending, delivered: 'x' } } }), 'pending[a].delivered が不正です');
        assert.equal(reasonOf({ ...base, lastRunAt: null }), 'lastRunAt が不正です');
        assert.equal(reasonOf({ ...base, lastRunAt: '1' }), 'lastRunAt が不正です');
    });

    it('検査されない項目は通る（delivered の中身・余分なキー・known の重複・空 title）', () => {
        assert.equal(reasonOf({ ...base, extra: 1 }), 'OK');
        assert.equal(reasonOf({ ...base, known: ['a', 'a'] }), 'OK');
        assert.equal(reasonOf({ ...base, pending: { a: { ...okPending, delivered: [] } } }), 'OK'); // 配列も object
        assert.equal(reasonOf({ ...base, pending: { a: { ...okPending, delivered: { announce: 'yes' } } } }), 'OK');
        assert.equal(reasonOf({ ...base, pending: { a: { ...okPending, title: '', url: '' } } }), 'OK');
        assert.equal(reasonOf({ ...base, pending: { a: { ...okPending, extra: 1 } } }), 'OK');
        assert.equal(reasonOf({ ...base, lastRunAt: -5 }), 'OK');
    });

    it('非 ENOENT の読み込み失敗は corrupt (読み込み失敗: ...)。JSON 破損は JSON 破損: ...', () => {
        mkdirSync(file, { recursive: true }); // ファイルのパスがディレクトリ
        const r = createStateStore(file).load();
        assert.equal(r.status, 'corrupt');
        assert.match(r.reason, /^読み込み失敗: EISDIR/);
        rmSync(file, { recursive: true });
        writeFileSync(file, '{broken');
        assert.match(createStateStore(file).load().reason, /^JSON 破損: /);
    });

    it('空ファイルは corrupt (JSON 破損)', () => {
        mkdirSync(join(dir, 'sub'));
        writeFileSync(file, '');
        assert.match(createStateStore(file).load().reason, /^JSON 破損: /);
    });
});

// ---------------------------------------------------------------- C15
describe('C15 save 失敗時の一時ファイル削除', () => {
    it('rename に失敗 (宛先がディレクトリ) すると例外を投げ、一時ファイルは削除される', () => {
        mkdirSync(file, { recursive: true }); // 宛先がディレクトリ
        const store = createStateStore(file);
        assert.throws(() => store.save({ version: 1, userId: '1', known: [], pending: {} }));
        assert.deepEqual(readdirSync(join(dir, 'sub')), ['state.json']); // *.tmp は残らない
    });

    it('write に失敗 (一時ファイル名がディレクトリ) すると元のエラーが投げられ、unlink 失敗は握りつぶされる', () => {
        const tmp = `${file}.${process.pid}.tmp`;
        mkdirSync(tmp, { recursive: true });
        const store = createStateStore(file);
        assert.throws(() => store.save({ version: 1, userId: '1', known: [], pending: {} }), { code: 'EISDIR' });
        assert.deepEqual(readdirSync(join(dir, 'sub')), [`state.json.${process.pid}.tmp`]);
    });

    it('親ディレクトリ作成に失敗 (親がファイル) するとそのまま例外', () => {
        writeFileSync(join(dir, 'sub'), 'x');
        assert.throws(() => createStateStore(file).save({ version: 1, userId: '1', known: [], pending: {} }));
    });

    it('失敗しても既存の状態ファイルは壊れない', () => {
        const store = seedState();
        const before = readFileSync(file, 'utf8');
        const tmp = `${file}.${process.pid}.tmp`;
        mkdirSync(tmp);
        assert.throws(() => store.save({ version: 1, userId: USER, known: ['zz'], pending: {} }));
        assert.equal(readFileSync(file, 'utf8'), before);
    });
});

// ---------------------------------------------------------------- C16
describe('C16 新しい順の pending でも古い順に配信', () => {
    const orderTest = async (items) => {
        seedState({ lastRunAt: NOW - HOUR });
        const order = [];
        const dests = {
            announce: async (t) => { order.push(idOf(t)); },
            twitter: async () => {},
            misskey: async () => {},
        };
        const t = setup({ fetchPage: async () => ({ items }), destinations: dests });
        await t.announcer.tick();
        return order;
    };

    it('API が返す新しい順 (desc) の 3 件は registeredAt の古い順に配信', async () => {
        assert.deepEqual(
            await orderTest([vid('sm13', 1 * HOUR), vid('sm12', 2 * HOUR), vid('sm11', 3 * HOUR)]),
            ['sm11', 'sm12', 'sm13'],
        );
    });

    it('状態ファイル内の pending が新しい順に並んでいても registeredAt で古い順に配信 (タイムゾーン混在でも Date.parse 比較)', async () => {
        seedState({
            lastRunAt: NOW - HOUR,
            pending: {
                new: pend('2026-11-10T20:30:00+09:00'), // 11:30Z
                mid: pend('2026-11-10T10:45:00Z'),
                old: pend('2026-11-10T19:00:00+09:00'), // 10:00Z
            },
        });
        const order = [];
        const dests = {
            announce: async (t) => { order.push(idOf(t)); },
            twitter: async () => {},
            misskey: async () => {},
        };
        const t = setup({ destinations: dests });
        await t.announcer.tick();
        assert.deepEqual(order, ['old', 'mid', 'new']);
        assert.deepEqual(readState().pending, {});
        assert.equal(t.stats.niconicoAnnounced, 3);
    });

    it('同時刻の pending は (安定ソートにより) ファイル内の並び順を保つ', async () => {
        seedState({
            lastRunAt: NOW - HOUR,
            pending: { b: pend('2026-11-10T11:00:00Z'), a: pend('2026-11-10T11:00:00Z') },
        });
        const order = [];
        const t = setup({
            destinations: { announce: async (t) => { order.push(idOf(t)); }, twitter: async () => {}, misskey: async () => {} },
        });
        await t.announcer.tick();
        assert.deepEqual(order, ['b', 'a']);
    });

    it('宛先の順は announce -> twitter -> misskey 固定で、動画ごとに 3 宛先を終えてから次の動画へ進む', async () => {
        seedState({ lastRunAt: NOW - HOUR, pending: { y: pend('2026-11-10T11:30:00Z'), x: pend('2026-11-10T11:00:00Z') } });
        const order = [];
        const dests = Object.fromEntries(DESTINATIONS.map((d) => [d, async (t) => { order.push(`${idOf(t)}:${d}`); }]));
        await setup({ destinations: dests }).announcer.tick();
        assert.deepEqual(order, ['x:announce', 'x:twitter', 'x:misskey', 'y:announce', 'y:twitter', 'y:misskey']);
    });
});

// ---------------------------------------------------------------- C17
describe('C17 save 失敗の挙動と 24 時間境界', () => {
    it('取得後の最初の save (新着登録) が失敗すると tick は reject し、配信も状態更新もされない', async () => {
        seedState({ lastRunAt: NOW - HOUR });
        const before = readFileSync(file, 'utf8');
        const store = flakyStore((n) => n === 1);
        const t = setup({ store, fetchPage: async () => ({ items: [vid('sm2', HOUR)] }) });
        await assert.rejects(t.announcer.tick(), /disk full/);
        assert.deepEqual(t.sent, { announce: [], twitter: [], misskey: [] });
        assert.equal(readFileSync(file, 'utf8'), before);
    });

    it('F02 配信成功後の save 失敗: delivered が残らず、次の tick で同じ宛先へ再投稿される', async () => {
        // F02
        seedState({ lastRunAt: NOW - HOUR });
        const store = flakyStore((n) => n === 2); // 1: 新着登録, 2: announce 成功直後
        const items = [vid('sm2', HOUR)];
        const t = setup({ store, fetchPage: async () => ({ items }) });
        await assert.rejects(t.announcer.tick(), /disk full/);
        assert.equal(t.sent.announce.length, 1); // 投稿は済んでいる
        assert.deepEqual(t.sent.twitter, []); // 例外で後続宛先は試行されない
        assert.deepEqual(t.sent.misskey, []);
        assert.deepEqual(readState().pending.sm2.delivered, { announce: false, twitter: false, misskey: false });
        assert.equal(t.stats.niconicoAnnounced, 0);

        // 次の tick (save が直った): announce へ二重投稿される
        await t.announcer.tick();
        assert.equal(t.sent.announce.length, 2);
        assert.equal(t.sent.twitter.length, 1);
        assert.equal(t.sent.misskey.length, 1);
        assert.deepEqual(readState().pending, {});
    });

    it('F02 最後の宛先 (misskey) の成功後に delivered 保存が失敗すると、次回 misskey だけが二重投稿される', async () => {
        // F02
        seedState({ lastRunAt: NOW - HOUR });
        // 1: 新着登録, 2/3/4: 各宛先の delivered 保存, 5: pending 削除
        const store = flakyStore((n) => n === 4);
        const t = setup({ store, fetchPage: async () => ({ items: [vid('sm2', HOUR)] }) });
        await assert.rejects(t.announcer.tick(), /disk full/);
        assert.deepEqual(readState().pending.sm2.delivered, { announce: true, twitter: true, misskey: false });
        await t.announcer.tick();
        assert.equal(t.sent.announce.length, 1);
        assert.equal(t.sent.misskey.length, 2); // misskey は二重投稿
    });

    it('F02 pending 削除の save が失敗しても再投稿はなく、niconicoAnnounced は次回の tick で加算される', async () => {
        // F02
        seedState({ lastRunAt: NOW - HOUR });
        // 1: 新着登録, 2/3/4: 各宛先の delivered 保存, 5: pending 削除
        const store = flakyStore((n) => n === 5);
        const t = setup({ store, fetchPage: async () => ({ items: [vid('sm2', HOUR)] }) });
        await assert.rejects(t.announcer.tick(), /disk full/);
        assert.deepEqual(readState().pending.sm2.delivered, { announce: true, twitter: true, misskey: true });
        assert.equal(t.stats.niconicoAnnounced, 0);
        await t.announcer.tick();
        assert.equal(t.sent.announce.length, 1);
        assert.equal(t.sent.twitter.length, 1);
        assert.equal(t.sent.misskey.length, 1);
        assert.deepEqual(readState().pending, {});
        assert.equal(t.stats.niconicoAnnounced, 1);
    });

    it('24 時間超過の諦めで delete 後の save が失敗すると reject。ディスク上の pending は残る', async () => {
        seedState({ lastRunAt: NOW - HOUR, pending: { old: pend(iso(NOW - STALE_MS)) } });
        const store = flakyStore((n) => n === 2); // 1: lastRunAt, 2: 諦め
        const t = setup({ store });
        await assert.rejects(t.announcer.tick(), /disk full/);
        assert.deepEqual(Object.keys(readState().pending), ['old']);
        assert.equal(t.logger.logs.error.length, 1);
    });

    it('通常 tick の store.save 失敗は poller が捕捉し、ERROR を出して 5 分後に再試行する', async () => {
        seedState({ lastRunAt: NOW - HOUR });
        const store = flakyStore((n) => n === 1);
        const t = setup({ store, fetchPage: async () => ({ items: [] }) });
        let nowMs = NOW;
        const timers = [];
        const logger = makeLogger();
        const poller = createPoller({
            inspect: () => ({ status: 'ready', lastRunAt: null, hasPending: false }),
            tick: () => t.announcer.tick(),
            checkTimes: [750, 1290],
            logger,
            now: () => nowMs,
            setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return {}; },
            clearTimeoutFn: () => {},
        });
        poller.start();
        await timers.shift().fn();
        assert.match(logger.logs.error[0], /予期しないエラー.*disk full/);
        assert.equal(timers[0].ms, 60 * 1000);
        nowMs += 4 * 60 * 1000;
        await timers.shift().fn();
        assert.equal(store.calls, 1); // まだ再試行しない
        nowMs += 60 * 1000;
        await timers.shift().fn();
        assert.equal(store.calls, 2); // 5 分経過で再試行
        poller.stop();
    });

    it('新規動画の 24 時間境界: 24h 丸ごとは告知せず既知に登録、1ms 手前は告知', async () => {
        seedState({ lastRunAt: NOW - HOUR });
        const t = setup({
            fetchPage: async () => ({
                items: [vid('smA', STALE_MS), vid('smB', STALE_MS - 1)],
            }),
        });
        await t.announcer.tick();
        assert.deepEqual(t.sent.announce.map((x) => x.split('\n')[2]), ['https://www.nicovideo.jp/watch/smB']);
        assert.deepEqual(readState().known, ['sm1', 'smA', 'smB']);
        assert.equal(t.logger.logs.warn.length, 1);
        assert.match(t.logger.logs.warn[0], /id=smA/);
    });

    it('新規動画の未来境界: registeredAt が now と同時刻なら告知対象、1ms 先なら無視 (known にも入らない)', async () => {
        seedState({ lastRunAt: NOW - HOUR });
        const t = setup({ fetchPage: async () => ({ items: [vid('smNow', 0), vid('smFuture', -1)] }) });
        await t.announcer.tick();
        assert.equal(t.sent.announce.length, 1);
        assert.ok(t.sent.announce[0].endsWith('/smNow'));
        assert.deepEqual(readState().known, ['sm1', 'smNow']);
    });

    it('pending の 24 時間境界: ちょうど 24h は諦め、1ms 手前は配信する', async () => {
        seedState({
            lastRunAt: NOW - HOUR,
            pending: { gone: pend(iso(NOW - STALE_MS)), kept: pend(iso(NOW - STALE_MS + 1)) },
        });
        const order = [];
        const t = setup({
            destinations: { announce: async (t) => { order.push(idOf(t)); }, twitter: async () => {}, misskey: async () => {} },
        });
        await t.announcer.tick();
        assert.deepEqual(order, ['kept']);
        assert.match(t.logger.logs.error[0], /id=gone 未配信=announce,twitter,misskey/);
        assert.deepEqual(readState().pending, {});
        assert.equal(t.stats.niconicoAnnounced, 1); // 諦めた分は数えない
    });

    it('諦めログの未配信は配信済みの宛先を除く', async () => {
        seedState({
            lastRunAt: NOW - HOUR,
            pending: { gone: pend(iso(NOW - 25 * HOUR), { announce: true, twitter: false, misskey: true }) },
        });
        const t = setup();
        await t.announcer.tick();
        assert.match(t.logger.logs.error[0], /未配信=twitter$/);
    });

    it('配信試行中に 24h を跨いでも判定は動画ごとの開始時点の now() (宛先ごとには再判定しない)', async () => {
        seedState({ lastRunAt: NOW - HOUR, pending: { p: pend(iso(NOW - STALE_MS + 1000)) } });
        let nowMs = NOW;
        const sent = [];
        const dests = Object.fromEntries(DESTINATIONS.map((d) => [d, async () => { sent.push(d); nowMs += 5000; }]));
        const t = setup({ destinations: dests, now: () => nowMs });
        await t.announcer.tick();
        assert.deepEqual(sent, ['announce', 'twitter', 'misskey']);
    });
});

// ---------------------------------------------------------------- C18
describe('C18 userId 変更', () => {
    it('inspect は別 userId を seed と判定、missing も seed、ok は ready', () => {
        seedState({ lastRunAt: 5 });
        assert.deepEqual(setup({ userId: '999' }).announcer.inspect(), { status: 'seed' });
        assert.deepEqual(setup().announcer.inspect(), { status: 'ready', lastRunAt: 5, hasPending: false });
        rmSync(file);
        assert.deepEqual(setup().announcer.inspect(), { status: 'seed' });
    });

    it('再シードは旧 userId の known/pending/lastRunAt を捨てて上書きする (未配信は配信されない)', async () => {
        seedState({ lastRunAt: 5, known: ['old1'], pending: { oldp: pend(iso(NOW - HOUR)) } });
        const t = setup({ userId: '999', fetchAll: async () => [vid('smN', HOUR)] });
        assert.deepEqual(await t.announcer.tick(), { status: 'ok', pending: 0 });
        assert.deepEqual(readState(), { version: 1, userId: '999', known: ['smN'], pending: {}, lastRunAt: NOW });
        assert.deepEqual(t.sent, { announce: [], twitter: [], misskey: [] });
    });

    it('再シードの取得に失敗すると旧状態はそのまま残り、次回も再シードを試みる', async () => {
        seedState({ pending: { oldp: pend(iso(NOW - HOUR)) } });
        const before = readFileSync(file, 'utf8');
        let fail = true;
        const t = setup({
            userId: '999',
            fetchAll: async () => { if (fail) throw new Error('x'); return []; },
        });
        assert.deepEqual(await t.announcer.tick(), { status: 'failed', pending: 0 });
        assert.equal(readFileSync(file, 'utf8'), before);
        assert.deepEqual(t.sent.announce, []); // 別ユーザーの pending は配信しない
        fail = false;
        assert.deepEqual(await t.announcer.tick(), { status: 'ok', pending: 0 });
        assert.equal(readState().userId, '999');
    });

    it('userId の比較は厳密一致 (前後空白・先頭ゼロ違いも別ユーザー扱い)', () => {
        seedState();
        assert.equal(setup({ userId: ' 140498' }).announcer.inspect().status, 'seed');
        assert.equal(setup({ userId: '0140498' }).announcer.inspect().status, 'seed');
    });

    it('別 userId でも書式が不正なら再シードせず corrupt', async () => {
        mkdirSync(join(dir, 'sub'));
        writeFileSync(file, JSON.stringify({ version: 1, userId: 'other', known: 'x', pending: {} }));
        const t = setup({ userId: '999', fetchAll: async () => { throw new Error('呼ばれない'); } });
        assert.equal(t.announcer.inspect().status, 'corrupt');
        assert.deepEqual(await t.announcer.tick(), { status: 'corrupt', pending: 0 });
    });
});

// ---------------------------------------------------------------- C19
describe('C19 異常判定と corrupt の再報告', () => {
    it('異常 (4 件): 状態に known だけ追加して保存し、pending は空、lastRunAt は更新、ERROR は 1 件', async () => {
        assert.equal(ANOMALY_THRESHOLD, 4);
        seedState({ lastRunAt: NOW - HOUR });
        const t = setup({
            fetchPage: async () => ({ items: [vid('a', 1 * HOUR), vid('b', 2 * HOUR), vid('c', 3 * HOUR), vid('d', 4 * HOUR)] }),
        });
        assert.deepEqual(await t.announcer.tick(), { status: 'ok', pending: 0 });
        const s = readState();
        assert.deepEqual(s.known, ['sm1', 'a', 'b', 'c', 'd']); // 取得順 (新しい順) のまま
        assert.deepEqual(s.pending, {});
        assert.equal(s.lastRunAt, NOW);
        assert.equal(t.logger.logs.error.length, 1);
        assert.match(t.logger.logs.error[0], /告知対象が 4 件あり異常のため投稿せず既知に登録します: a, b, c, d/);
        assert.equal(t.stats.niconicoAnnounced, 0);
    });

    it('異常判定は新規 fresh のみが対象: 既存 pending・既知・未来・24h 超は数えない', async () => {
        seedState({ lastRunAt: NOW - HOUR, known: ['sm1', 'k1'], pending: { p1: pend(iso(NOW - HOUR)), p2: pend(iso(NOW - HOUR)) } });
        const t = setup({
            fetchPage: async () => ({
                items: [vid('n1', HOUR), vid('n2', HOUR), vid('n3', HOUR), vid('k1', HOUR), vid('fut', -HOUR), vid('stale', 30 * HOUR)],
            }),
        });
        await t.announcer.tick();
        assert.equal(t.logger.logs.error.length, 0);
        assert.deepEqual(readState().known, ['sm1', 'k1', 'stale', 'n1', 'n2', 'n3']); // 24h 超 (stale) は既知登録、未来 (fut) は入らない
        assert.equal(t.sent.announce.length, 5); // 既存 pending 2 件 + 新規 3 件
    });

    it('異常でも同じティックの既存 pending は配信される', async () => {
        seedState({ lastRunAt: NOW - HOUR, pending: { p1: pend(iso(NOW - HOUR)) } });
        const t = setup({ fetchPage: async () => ({ items: [vid('a', HOUR), vid('b', HOUR), vid('c', HOUR), vid('d', HOUR)] }) });
        await t.announcer.tick();
        assert.equal(t.sent.announce.length, 1);
        assert.deepEqual(readState().known, ['sm1', 'a', 'b', 'c', 'd']);
    });

    it('異常登録された ID は次回以降も再告知されない', async () => {
        seedState({ lastRunAt: NOW - HOUR });
        const items = [vid('a', HOUR), vid('b', HOUR), vid('c', HOUR), vid('d', HOUR)];
        const t = setup({ fetchPage: async () => ({ items }) });
        await t.announcer.tick();
        await t.announcer.tick();
        assert.deepEqual(t.sent.announce, []);
        assert.equal(t.logger.logs.error.length, 1);
    });

    it('corrupt の ERROR はファイルパスと reason を含み、回復後に再び corrupt になると再度報告される', async () => {
        seedState();
        const t = setup();
        writeFileSync(file, '{broken');
        await t.announcer.tick();
        await t.announcer.tick();
        assert.equal(t.logger.logs.error.length, 1);
        assert.ok(t.logger.logs.error[0].includes(file));
        assert.match(t.logger.logs.error[0], /状態ファイルが不正なため何もしません .*: JSON 破損: /);

        seedState(); // 回復
        assert.equal((await t.announcer.tick()).status, 'ok');
        writeFileSync(file, '[]'); // 再び破損 (理由が違う)
        await t.announcer.tick();
        await t.announcer.tick();
        assert.equal(t.logger.logs.error.length, 2);
        assert.match(t.logger.logs.error[1], /状態がオブジェクトではありません/);
    });

    it('corrupt の間は stats を動かさず fetch も呼ばない。inspect も corrupt', async () => {
        seedState();
        writeFileSync(file, '{broken');
        let fetched = 0;
        const t = setup({ fetchPage: async () => { fetched += 1; return { items: [] }; } });
        assert.deepEqual(t.announcer.inspect(), { status: 'corrupt' });
        await t.announcer.tick();
        assert.equal(fetched, 0);
        assert.equal(t.stats.niconicoFetchOk, 0);
        assert.equal(t.stats.niconicoFetchFailed, 0);
    });

    it('別の announcer インスタンス (再起動相当) では corrupt を再び報告する', async () => {
        seedState();
        writeFileSync(file, '{broken');
        const a = setup();
        const b = setup();
        await a.announcer.tick();
        await b.announcer.tick();
        assert.equal(a.logger.logs.error.length, 1);
        assert.equal(b.logger.logs.error.length, 1);
    });
});

// ---------------------------------------------------------------- C20
describe('C20 poller と nvapi の応答検証', () => {
    const okBody = (items, totalCount = items.length) => ({ meta: { status: 200 }, data: { totalCount, items } });
    const goodItem = { essential: { id: 'sm1', title: 't', registeredAt: '2026-11-09T21:00:00+09:00' } };
    const run = (over) => fetchUserVideosPage({
        userId: USER,
        fetchFn: async () => ({ status: 200, json: async () => over }),
    });

    it('応答の異常はすべて NiconicoError (メッセージ固定)', async () => {
        const cases = [
            [null, /meta\.status が 200 ではありません: undefined/],
            [{}, /meta\.status が 200 ではありません: undefined/],
            [{ meta: { status: 500 } }, /meta\.status が 200 ではありません: 500/],
            [{ meta: { status: '200' }, data: {} }, /meta\.status が 200 ではありません: 200/], // 文字列は不可
            [{ meta: { status: 200 } }, /data\.items が配列ではありません/],
            [{ meta: { status: 200 }, data: { items: {}, totalCount: 0 } }, /data\.items が配列ではありません/],
            [{ meta: { status: 200 }, data: { items: [] } }, /data\.totalCount が不正です/],
            [okBody([], -1), /data\.totalCount が不正です/],
            [okBody([], 1.5), /data\.totalCount が不正です/],
            [okBody([], '3'), /data\.totalCount が不正です/],
            [okBody([null]), /items\[\]\.essential がありません/],
            [okBody([{ essential: 'x' }]), /items\[\]\.essential がありません/],
            [okBody([{ essential: { id: '', title: 't', registeredAt: 'x' } }]), /essential\.id が不正です/],
            [okBody([{ essential: { id: 1, title: 't', registeredAt: 'x' } }]), /essential\.id が不正です/],
            [okBody([{ essential: { id: 'sm1', title: '', registeredAt: 'x' } }]), /essential\.title が不正です: id=sm1/],
            [okBody([{ essential: { id: 'sm1', title: 't', registeredAt: 'nope' } }]), /essential\.registeredAt が不正です: id=sm1/],
            [okBody([{ essential: { id: 'sm1', title: 't', registeredAt: 1700000000000 } }]), /essential\.registeredAt が不正です: id=sm1/],
        ];
        for (const [body, re] of cases) {
            await assert.rejects(run(body), (e) => e instanceof NiconicoError && re.test(e.message), JSON.stringify(body));
        }
    });

    it('totalCount 0 で items 空は正常、items 内の 1 件でも不正なら全体が失敗 (部分採用しない)', async () => {
        assert.deepEqual(await run(okBody([], 0)), { totalCount: 0, items: [] });
        await assert.rejects(run(okBody([goodItem, { essential: null }])), NiconicoError);
    });

    it('totalCount と items 件数が食い違っても検証しない', async () => {
        const r = await run(okBody([goodItem], 99));
        assert.equal(r.totalCount, 99);
        assert.equal(r.items.length, 1);
    });

    it('HTTP 非 200 / json() 失敗 / fetch reject は NiconicoError。後 2 者は page 付きで cause を保持', async () => {
        await assert.rejects(
            fetchUserVideosPage({ userId: USER, fetchFn: async () => ({ status: 503, json: async () => ({}) }) }),
            { name: 'NiconicoError', message: 'HTTP 503' },
        );
        const jsonErr = new SyntaxError('bad json');
        await assert.rejects(
            fetchUserVideosPage({ userId: USER, page: 2, fetchFn: async () => ({ status: 200, json: async () => { throw jsonErr; } }) }),
            (e) => e instanceof NiconicoError && e.cause === jsonErr && /\(page=2\): bad json/.test(e.message),
        );
        const netErr = new Error('ECONNRESET');
        await assert.rejects(
            fetchUserVideosPage({ userId: USER, fetchFn: async () => { throw netErr; } }),
            (e) => e instanceof NiconicoError && e.cause === netErr && /\(page=1\): ECONNRESET/.test(e.message),
        );
    });

    it('HTTP 201 や 204 も非 200 として失敗 (厳密に 200 のみ)', async () => {
        for (const status of [201, 204, 301]) {
            await assert.rejects(
                fetchUserVideosPage({ userId: USER, fetchFn: async () => ({ status, json: async () => okBody([]) }) }),
                { message: `HTTP ${status}` },
            );
        }
    });

    it('fetchAllUserVideos は fetchFn などの残り引数をそのまま各ページへ渡し、items 空 + totalCount>0 は途中でも停止', async () => {
        const urls = [];
        const fetchFn = async (url) => {
            urls.push(url);
            return { status: 200, json: async () => okBody(urls.length === 1 ? [goodItem] : [], 10) };
        };
        const all = await fetchAllUserVideos({ userId: USER, pageSize: 1, fetchFn });
        assert.equal(all.length, 1);
        assert.equal(urls.length, 2);
        assert.match(urls[1], /pageSize=1&page=2$/);
    });

    // ---- poller ----
    function pollerSetup({ info = { status: 'ready', lastRunAt: null, hasPending: false }, result = { status: 'ok', pending: 0 }, nowRef = { v: NOW } } = {}) {
        const timers = [];
        const cleared = [];
        const calls = { inspect: 0, tick: 0 };
        const logger = makeLogger();
        const poller = createPoller({
            inspect: () => { calls.inspect += 1; return typeof info === 'function' ? info() : info; },
            tick: async () => { calls.tick += 1; return typeof result === 'function' ? result() : result; },
            checkTimes: [750, 1290],
            logger,
            now: () => nowRef.v,
            setTimeoutFn: (fn, ms) => { const t = { fn, ms, unrefed: false, unref() { this.unrefed = true; } }; timers.push(t); return t; },
            clearTimeoutFn: (t) => cleared.push(t),
        });
        return { poller, timers, cleared, calls, logger, nowRef };
    }

    it('start() は 0ms でタイマーを張り unref する。二重 start は無視。stop() 前の start() はタイマーを 1 つだけ予約する', () => {
        const p = pollerSetup();
        p.poller.start();
        p.poller.start();
        assert.equal(p.timers.length, 1);
        assert.equal(p.timers[0].ms, 0);
        assert.equal(p.timers[0].unrefed, true);
    });

    it('start 前 / stop 後の check() は何もしない (tick も inspect も呼ばず、再予約もしない)', async () => {
        const p = pollerSetup();
        await p.poller.check();
        assert.equal(p.calls.inspect, 0);
        assert.equal(p.timers.length, 0);
        p.poller.start();
        p.poller.stop();
        assert.equal(p.cleared.length, 1);
        await p.poller.check();
        assert.equal(p.calls.tick, 0);
        assert.equal(p.timers.length, 1);
    });

    it('stop() 後に再 start() できる', () => {
        const p = pollerSetup();
        p.poller.start();
        p.poller.stop();
        p.poller.start();
        assert.equal(p.timers.length, 2);
    });

    it('lastRunAt が無い ready は直近の定刻が必ず上回るので実行 / lastRunAt が直近定刻と同時刻なら実行しない', async () => {
        // NOW = 2026-11-10 21:00 JST。直近の定刻は 12:30 JST = 03:30Z
        const latest = Date.parse('2026-11-10T03:30:00Z');
        const a = pollerSetup();
        a.poller.start();
        await a.timers.shift().fn();
        assert.equal(a.calls.tick, 1);
        const b = pollerSetup({ info: { status: 'ready', lastRunAt: latest, hasPending: false } });
        b.poller.start();
        await b.timers.shift().fn();
        assert.equal(b.calls.tick, 0);
        const c = pollerSetup({ info: { status: 'ready', lastRunAt: latest - 1, hasPending: false } });
        c.poller.start();
        await c.timers.shift().fn();
        assert.equal(c.calls.tick, 1);
    });

    it('seed / corrupt / hasPending は定刻に関係なく実行される', async () => {
        for (const info of [{ status: 'seed' }, { status: 'corrupt' }, { status: 'ready', lastRunAt: NOW, hasPending: true }]) {
            const p = pollerSetup({ info });
            p.poller.start();
            await p.timers.shift().fn();
            assert.equal(p.calls.tick, 1, JSON.stringify(info));
        }
    });

    it('tick の結果で再試行が決まる: failed / ok+pending>0 は 5 分、ok+pending=0 / corrupt は止める', async () => {
        const cases = [
            [{ status: 'failed', pending: 0 }, 5 * 60 * 1000],
            [{ status: 'ok', pending: 2 }, 5 * 60 * 1000],
            [{ status: 'ok', pending: 0 }, null],
            [{ status: 'corrupt', pending: 0 }, null],
            [{ status: 'corrupt', pending: 3 }, null], // corrupt は pending があっても再試行待ちにしない
        ];
        for (const [result, retry] of cases) {
            const p = pollerSetup({ result, info: { status: 'seed' } });
            p.poller.start();
            await p.timers.shift().fn();
            assert.equal(p.timers.at(-1).ms, 60 * 1000, JSON.stringify(result)); // 判定間隔は常に 1 分
            p.nowRef.v += 4 * 60 * 1000;
            const before = p.calls.tick;
            await p.timers.shift().fn();
            // 再試行待ちでなければ inspect (seed) でまた実行される。待ちなら 4 分では実行されない
            assert.equal(p.calls.tick - before, retry === null ? 1 : 0, JSON.stringify(result));
            p.poller.stop();
        }
    });

    it('再試行待ちの間は inspect を呼ばない (retryAt のみで判定)', async () => {
        const p = pollerSetup({ result: { status: 'failed', pending: 0 }, info: { status: 'seed' } });
        p.poller.start();
        await p.timers.shift().fn();
        const inspectCalls = p.calls.inspect;
        await p.timers.shift().fn();
        assert.equal(p.calls.inspect, inspectCalls);
        p.poller.stop();
    });

    it('inspect が例外を投げても check() は reject せず、ERROR を出して 5 分後に再試行', async () => {
        const p = pollerSetup({ info: () => { throw new Error('inspect broke'); } });
        p.poller.start();
        await p.timers.shift().fn();
        assert.match(p.logger.logs.error[0], /予期しないエラー.*inspect broke/);
        assert.equal(p.timers.length, 1);
        assert.equal(p.calls.tick, 0);
    });
});

// ---------------------------------------------------------------- C25
describe('C25 loadConfig の境界', () => {
    const base = {
        DISCORD_TOKEN: 't',
        DISCORD_CHANNEL_ID: 'c',
        MISSKEY_INSTANCE_URL: 'https://misskey.example',
        MISSKEY_API_TOKEN: 'm',
    };
    const nico = { ...base, NICONICO_USER_ID: '140498', DISCORD_POST_CHANNEL_ID: 'p' };

    it('必須 4 項目: 欠けたものを定義順にすべて列挙し、空文字も欠落扱い', () => {
        assert.throws(() => loadConfig({}, '/h'), (e) => {
            assert.ok(e instanceof ConfigError);
            assert.equal(e.name, 'ConfigError');
            assert.match(e.message, /^必須の環境変数が設定されていません: DISCORD_TOKEN, DISCORD_CHANNEL_ID, MISSKEY_INSTANCE_URL, MISSKEY_API_TOKEN\n/);
            assert.match(e.message, /README 参照/);
            return true;
        });
        assert.throws(
            () => loadConfig({ ...base, MISSKEY_INSTANCE_URL: '', DISCORD_TOKEN: undefined }, '/h'),
            /: DISCORD_TOKEN, MISSKEY_INSTANCE_URL\n/,
        );
        for (const key of Object.keys(base)) {
            assert.throws(() => loadConfig({ ...base, [key]: '' }, '/h'), new RegExp(`: ${key}\\n`), key);
        }
    });

    it('必須の値は検証されない: 空白のみ・URL でない値・末尾スラッシュもそのまま通る', () => {
        const c = loadConfig({ ...base, DISCORD_TOKEN: '  ', MISSKEY_INSTANCE_URL: 'not a url/' }, '/h');
        assert.equal(c.discordToken, '  ');
        assert.equal(c.misskeyInstanceUrl, 'not a url/');
    });

    it('通常設定の戻り値の形 (niconico 無効・postChannelId なし)', () => {
        const c = loadConfig(base, '/h');
        assert.equal(c.niconico, null);
        assert.equal(c.discordToken, 't');
        assert.equal(c.channelId, 'c');
        assert.equal(c.misskeyInstanceUrl, 'https://misskey.example');
        assert.equal(c.misskeyApiToken, 'm');
        assert.deepEqual(c.allowedBotIds, []);
        assert.equal(c.postChannelId, null);
    });

    it('DISCORD_POST_CHANNEL_ID だけでも postChannelId が入り niconico は null。空文字は null', () => {
        const c = loadConfig({ ...base, DISCORD_POST_CHANNEL_ID: 'p' }, '/h');
        assert.equal(c.postChannelId, 'p');
        assert.equal(c.niconico, null);
        assert.equal(loadConfig({ ...base, DISCORD_POST_CHANNEL_ID: '' }, '/h').postChannelId, null);
    });

    it('NICONICO_USER_ID が空文字なら機能オフ (他の niconico 設定が不正でも検証しない)', () => {
        const c = loadConfig({ ...base, NICONICO_USER_ID: '', NICONICO_CHECK_TIMES: 'zzz' }, '/h');
        assert.equal(c.niconico, null);
    });

    it('NICONICO_USER_ID: 前後空白は trim、数字のみ許可 (先頭ゼロ・0 も可)。他は ConfigError', () => {
        assert.equal(loadConfig({ ...nico, NICONICO_USER_ID: ' 140498\n' }, '/h').niconico.userId, '140498');
        assert.equal(loadConfig({ ...nico, NICONICO_USER_ID: '007' }, '/h').niconico.userId, '007');
        assert.equal(loadConfig({ ...nico, NICONICO_USER_ID: '0' }, '/h').niconico.userId, '0');
        for (const bad of ['   ', '12a', '-1', '1.5', '1 2', '１２３', 'user/1', '1e3']) {
            assert.throws(
                () => loadConfig({ ...nico, NICONICO_USER_ID: bad }, '/h'),
                (e) => e instanceof ConfigError && /NICONICO_USER_ID は数字のユーザー ID/.test(e.message),
                JSON.stringify(bad),
            );
        }
    });

    it('検証順: 必須 -> userId 形式 -> POST_CHANNEL -> CHECK_TIMES', () => {
        // 必須が欠けていれば niconico の不備より先
        assert.throws(() => loadConfig({ NICONICO_USER_ID: 'x' }, '/h'), /DISCORD_TOKEN/);
        // userId 形式エラーが POST_CHANNEL 欠落より先
        assert.throws(() => loadConfig({ ...base, NICONICO_USER_ID: 'x' }, '/h'), /数字のユーザー ID/);
        // POST_CHANNEL 欠落が CHECK_TIMES 不正より先
        assert.throws(
            () => loadConfig({ ...base, NICONICO_USER_ID: '1', NICONICO_CHECK_TIMES: 'zzz' }, '/h'),
            /DISCORD_POST_CHANNEL_ID（NICONICO_USER_ID 設定時は必須）/,
        );
    });

    it('NICONICO_CHECK_TIMES: 未設定・空・空白のみは既定 (12:30,21:30)、書式の境界', () => {
        for (const v of [undefined, '', '   ']) {
            assert.deepEqual(loadConfig({ ...nico, NICONICO_CHECK_TIMES: v }, '/h').niconico.checkTimes, [750, 1290]);
        }
        const times = (v) => loadConfig({ ...nico, NICONICO_CHECK_TIMES: v }, '/h').niconico.checkTimes;
        assert.deepEqual(times(' 21:30 , 9:05 ,00:00,23:59'), [0, 545, 1290, 1439]);
        assert.deepEqual(times('09:05'), [545]); // 単一も可
        for (const bad of ['24:00', '9:5', '09:5', '12:30:00', '12.30', '12:30;21:30', '12:30,12:30', '09:05,9:05']) {
            assert.throws(
                () => loadConfig({ ...nico, NICONICO_CHECK_TIMES: bad }, '/h'),
                (e) => e instanceof ConfigError && /^NICONICO_CHECK_TIMES が不正です: /.test(e.message),
                bad,
            );
        }
    });

    it('NICONICO_STATE_FILE: 既定は home 配下、空文字は既定、指定値は検証も正規化もしない', () => {
        const dflt = '/h/Library/Application Support/sns-collaborator/niconico-state.json';
        assert.equal(loadConfig(nico, '/h').niconico.stateFile, dflt);
        assert.equal(loadConfig({ ...nico, NICONICO_STATE_FILE: '' }, '/h').niconico.stateFile, dflt);
        assert.equal(loadConfig({ ...nico, NICONICO_STATE_FILE: 'rel/state.json' }, '/h').niconico.stateFile, 'rel/state.json');
        assert.equal(loadConfig({ ...nico, NICONICO_STATE_FILE: ' /x.json ' }, '/h').niconico.stateFile, ' /x.json ');
    });

    it('F05 NICONICO_STATE_FILE の ~ は展開されずそのまま返る (相対パス扱いになる)', () => {
        // F05
        assert.equal(loadConfig({ ...nico, NICONICO_STATE_FILE: '~/state.json' }, '/home/u').niconico.stateFile, '~/state.json');
        assert.equal(loadConfig({ ...nico, NICONICO_STATE_FILE: '~' }, '/home/u').niconico.stateFile, '~');
    });

    it('home 引数は stateFile の既定パスに反映される / ユーザー ID は文字列のまま保持される', () => {
        const c = loadConfig(nico, '/another');
        assert.equal(typeof c.niconico.userId, 'string');
        assert.equal(c.niconico.postChannelId, 'p');
        assert.match(c.niconico.stateFile, /^\/another\/Library\//);
    });
});
