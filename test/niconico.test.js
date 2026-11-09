import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    NiconicoError,
    fetchAllUserVideos,
    fetchUserVideosPage,
    normalizeItem,
} from '../src/niconico.js';

const item = (id, registeredAt = '2026-11-09T21:00:00+09:00', title = `t-${id}`) => ({
    series: null,
    essential: { id, title, registeredAt },
});
const okBody = (items, totalCount = items.length) => ({ meta: { status: 200 }, data: { totalCount, items } });
const res = (body, status = 200) => ({ status, json: async () => body });

describe('normalizeItem', () => {
    it('id/title/registeredAt を正規化する', () => {
        const v = normalizeItem(item('sm1'));
        assert.equal(v.id, 'sm1');
        assert.equal(v.title, 't-sm1');
        assert.equal(v.registeredAtMs, Date.parse('2026-11-09T12:00:00Z'));
    });
    it('欠落・不正は NiconicoError', () => {
        assert.throws(() => normalizeItem({}), NiconicoError);
        assert.throws(() => normalizeItem({ essential: { title: 't', registeredAt: '2026-01-01T00:00:00Z' } }), NiconicoError);
        assert.throws(() => normalizeItem({ essential: { id: 'a', registeredAt: '2026-01-01T00:00:00Z' } }), NiconicoError);
        assert.throws(() => normalizeItem({ essential: { id: 'a', title: 't' } }), NiconicoError);
        assert.throws(() => normalizeItem(item('a', 'not-a-date')), NiconicoError);
    });
});

describe('fetchUserVideosPage', () => {
    it('URL・ヘッダ・signal を付けて取得し正規化する', async () => {
        const calls = [];
        const fetchFn = async (url, opts) => {
            calls.push({ url, opts });
            return res(okBody([item('sm2'), item('sm1')], 330));
        };
        const r = await fetchUserVideosPage({ userId: '140498', page: 2, pageSize: 20, fetchFn });
        assert.equal(r.totalCount, 330);
        assert.deepEqual(r.items.map((v) => v.id), ['sm2', 'sm1']);
        assert.equal(
            calls[0].url,
            'https://nvapi.nicovideo.jp/v2/users/140498/videos?sortKey=registeredAt&sortOrder=desc&pageSize=20&page=2',
        );
        assert.equal(calls[0].opts.headers['X-Frontend-Id'], '6');
        assert.equal(calls[0].opts.headers['User-Agent'], 'sns-collaborator');
        assert.ok(calls[0].opts.signal instanceof AbortSignal);
    });

    const bad = {
        '非 200': () => res(okBody([]), 400),
        'meta.status が 200 以外': () => res({ meta: { status: 500 }, data: { totalCount: 0, items: [] } }),
        'items が配列でない': () => res({ meta: { status: 200 }, data: { totalCount: 0, items: {} } }),
        'data なし': () => res({ meta: { status: 200 } }),
        '要素が不正': () => res(okBody([item('sm1'), { essential: { id: 'sm2' } }])),
        'JSON 不正': () => ({ status: 200, json: async () => { throw new SyntaxError('bad'); } }),
        'ネットワーク例外': () => { throw new TypeError('fetch failed'); },
    };
    for (const [name, make] of Object.entries(bad)) {
        it(`異常応答は失敗扱い: ${name}`, async () => {
            await assert.rejects(
                fetchUserVideosPage({ userId: '1', fetchFn: async () => make() }),
                NiconicoError,
            );
        });
    }

    it('タイムアウトすると失敗扱い', async () => {
        const fetchFn = (url, { signal }) =>
            new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
        await assert.rejects(fetchUserVideosPage({ userId: '1', fetchFn, timeoutMs: 10 }), NiconicoError);
    });
});

describe('fetchAllUserVideos', () => {
    const pagedFetch = (total, log) => async (url) => {
        const page = Number(new URL(url).searchParams.get('page'));
        const size = Number(new URL(url).searchParams.get('pageSize'));
        log.push(page);
        const items = [];
        for (let i = (page - 1) * size; i < Math.min(page * size, total); i += 1) items.push(item(`sm${i}`));
        return res(okBody(items, total));
    };

    it('totalCount に達したら停止する', async () => {
        const log = [];
        const all = await fetchAllUserVideos({ userId: '1', pageSize: 10, fetchFn: pagedFetch(25, log) });
        assert.equal(all.length, 25);
        assert.deepEqual(log, [1, 2, 3]);
    });
    it('ちょうど割り切れる件数でも余計なページを取らない', async () => {
        const log = [];
        await fetchAllUserVideos({ userId: '1', pageSize: 10, fetchFn: pagedFetch(20, log) });
        assert.deepEqual(log, [1, 2]);
    });
    it('totalCount が実件数より大きくても空ページで停止する', async () => {
        const log = [];
        const fetchFn = async (url) => {
            const page = Number(new URL(url).searchParams.get('page'));
            log.push(page);
            return res(okBody(page === 1 ? [item('a'), item('b')] : [], 999));
        };
        const all = await fetchAllUserVideos({ userId: '1', pageSize: 2, fetchFn });
        assert.equal(all.length, 2);
        assert.deepEqual(log, [1, 2]);
    });
    it('上限ページ数を超えたら失敗扱い', async () => {
        const log = [];
        await assert.rejects(
            fetchAllUserVideos({ userId: '1', pageSize: 1, maxPages: 3, fetchFn: pagedFetch(100, log) }),
            /上限/,
        );
        assert.deepEqual(log, [1, 2, 3]);
    });
    it('途中ページの失敗は例外（部分結果を返さない）', async () => {
        const fetchFn = async (url) => {
            const page = Number(new URL(url).searchParams.get('page'));
            return page === 2 ? res({}, 503) : res(okBody([item(`a${page}`), item(`b${page}`)], 6));
        };
        await assert.rejects(fetchAllUserVideos({ userId: '1', pageSize: 2, fetchFn }), NiconicoError);
    });
});
