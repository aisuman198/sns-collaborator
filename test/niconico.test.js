import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    NiconicoError,
    fetchAllUserVideos,
    buildSummaryLine,
    fetchUserVideosPage,
    fetchVideoDescription,
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

describe('normalizeItem shortDescription', () => {
    it('文字列ならそのまま、でなければ空文字', () => {
        const withDesc = (shortDescription) => ({ essential: { ...item('sm1').essential, shortDescription } });
        assert.equal(normalizeItem(withDesc('概要。')).shortDescription, '概要。');
        assert.equal(normalizeItem(withDesc(123)).shortDescription, '');
        assert.equal(normalizeItem(withDesc(null)).shortDescription, '');
        assert.equal(normalizeItem(item('sm1')).shortDescription, '');
    });
});

describe('buildSummaryLine', () => {
    it('最初の句点まで（含む）', () => {
        assert.equal(buildSummaryLine('一文目。二文目。'), '一文目。');
    });
    it('句点が無ければ全文', () => {
        assert.equal(buildSummaryLine('句点なし！'), '句点なし！');
    });
    it('空白・改行を正規化して trim する', () => {
        assert.equal(buildSummaryLine('  あ\n\n い\t う。え  '), 'あ い う。');
        assert.equal(buildSummaryLine('a\r\nb'), 'a b');
    });
    it('空・空白のみ・非文字列は空文字', () => {
        assert.equal(buildSummaryLine(''), '');
        assert.equal(buildSummaryLine(' \n '), '');
        assert.equal(buildSummaryLine(undefined), '');
    });
    it('100 字超は 100 字に切って … を付ける（ちょうど 100 字は切らない）', () => {
        assert.equal(buildSummaryLine('あ'.repeat(100) + '。'), 'あ'.repeat(100) + '…');
        assert.equal(buildSummaryLine('あ'.repeat(150)), 'あ'.repeat(100) + '…');
        assert.equal(buildSummaryLine('あ'.repeat(99) + '。'), 'あ'.repeat(99) + '。');
    });
    it('サロゲートペアを分断しない', () => {
        const out = buildSummaryLine('😀'.repeat(120));
        assert.equal(out, '😀'.repeat(100) + '…');
        assert.equal(Array.from(out).length, 101);
    });
});

describe('fetchVideoDescription', () => {
    const xml = (inner, status = 'ok') =>
        `<?xml version="1.0" encoding="UTF-8"?><nicovideo_thumb_response status="${status}"><thumb><video_id>sm1</video_id>${inner}</thumb></nicovideo_thumb_response>`;
    const textRes = (body, status = 200) => ({ status, text: async () => body });

    it('URL・ヘッダ・signal を付けて説明文を返す', async () => {
        const calls = [];
        const fetchFn = async (url, opts) => {
            calls.push({ url, opts });
            return textRes(xml('<description>こんにちは。</description>'));
        };
        assert.equal(await fetchVideoDescription({ videoId: 'sm1', fetchFn }), 'こんにちは。');
        assert.equal(calls[0].url, 'https://ext.nicovideo.jp/api/getthumbinfo/sm1');
        assert.equal(calls[0].opts.headers['User-Agent'], 'sns-collaborator');
        assert.ok(calls[0].opts.signal instanceof AbortSignal);
    });
    it('XML 実体参照をデコードする', async () => {
        const fetchFn = async () =>
            textRes(xml('<description>A&amp;B &lt;x&gt; &quot;q&quot; &apos;s&apos; &#12354;&#x3044; &amp;amp;</description>'));
        assert.equal(await fetchVideoDescription({ videoId: 'sm1', fetchFn }), `A&B <x> "q" 's' あい &amp;`);
    });
    it('空要素は空文字', async () => {
        assert.equal(await fetchVideoDescription({ videoId: 'sm1', fetchFn: async () => textRes(xml('<description/>')) }), '');
        assert.equal(await fetchVideoDescription({ videoId: 'sm1', fetchFn: async () => textRes(xml('<description></description>')) }), '');
    });
    it('非 200・status fail・description なし・例外は NiconicoError', async () => {
        const bad = [
            async () => textRes('', 503),
            async () => textRes('<nicovideo_thumb_response status="fail"><error><code>DELETED</code></error></nicovideo_thumb_response>'),
            async () => textRes(xml('<title>t</title>')),
            async () => { throw new Error('network down'); },
        ];
        for (const fetchFn of bad) {
            await assert.rejects(fetchVideoDescription({ videoId: 'sm1', fetchFn }), NiconicoError);
        }
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
