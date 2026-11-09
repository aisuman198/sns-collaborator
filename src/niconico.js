// ニコニコ動画の投稿一覧取得（非公式 nvapi）。fetch・タイムアウトを注入してテスト可能にする
export const NVAPI_ORIGIN = 'https://nvapi.nicovideo.jp';
export const DEFAULT_TIMEOUT_MS = 15 * 1000;
export const SEED_PAGE_SIZE = 100;
export const MAX_SEED_PAGES = 50; // 全ページ取得の上限（100 件 × 50 ページ = 5000 件）

/** 取得・応答の異常を表すエラー。 */
export class NiconicoError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'NiconicoError';
    }
}

/**
 * 1 件の動画を正規化する。不正なら NiconicoError。
 * 戻り値: { id, title, registeredAt (ISO 文字列そのまま), registeredAtMs }
 */
export function normalizeItem(item) {
    const e = item?.essential;
    if (!e || typeof e !== 'object') throw new NiconicoError('items[].essential がありません');
    if (typeof e.id !== 'string' || e.id === '') throw new NiconicoError('essential.id が不正です');
    if (typeof e.title !== 'string' || e.title === '') {
        throw new NiconicoError(`essential.title が不正です: id=${e.id}`);
    }
    const ms = typeof e.registeredAt === 'string' ? Date.parse(e.registeredAt) : NaN;
    if (!Number.isFinite(ms)) throw new NiconicoError(`essential.registeredAt が不正です: id=${e.id}`);
    return { id: e.id, title: e.title, registeredAt: e.registeredAt, registeredAtMs: ms };
}

/**
 * 投稿動画一覧の 1 ページを取得する（新しい順）。
 * 異常（非 200・meta.status 不正・items 不正・要素不正・例外・タイムアウト）は NiconicoError を投げる。
 * 戻り値: { totalCount, items }
 */
export async function fetchUserVideosPage({
    userId,
    page = 1,
    pageSize = 20,
    fetchFn = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
    const url =
        `${NVAPI_ORIGIN}/v2/users/${encodeURIComponent(userId)}/videos` +
        `?sortKey=registeredAt&sortOrder=desc&pageSize=${pageSize}&page=${page}`;
    let body;
    try {
        const res = await fetchFn(url, {
            headers: { 'X-Frontend-Id': '6', 'User-Agent': 'sns-collaborator' },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status !== 200) throw new NiconicoError(`HTTP ${res.status}`);
        body = await res.json();
    } catch (error) {
        if (error instanceof NiconicoError) throw error;
        throw new NiconicoError(`nvapi の取得に失敗しました (page=${page}): ${error?.message ?? error}`, {
            cause: error,
        });
    }
    if (body?.meta?.status !== 200) {
        throw new NiconicoError(`meta.status が 200 ではありません: ${body?.meta?.status}`);
    }
    const data = body.data;
    if (!data || !Array.isArray(data.items)) throw new NiconicoError('data.items が配列ではありません');
    const totalCount = data.totalCount;
    if (!Number.isInteger(totalCount) || totalCount < 0) throw new NiconicoError('data.totalCount が不正です');
    return { totalCount, items: data.items.map(normalizeItem) };
}

/**
 * 全ページを取得する（初回シード用）。totalCount 到達・空ページで停止し、上限超過は失敗扱い。
 * 途中ページが 1 つでも失敗したら例外（部分結果は返さない）。
 */
export async function fetchAllUserVideos({
    userId,
    pageSize = SEED_PAGE_SIZE,
    maxPages = MAX_SEED_PAGES,
    ...rest
}) {
    const all = [];
    for (let page = 1; page <= maxPages; page += 1) {
        const { totalCount, items } = await fetchUserVideosPage({ userId, page, pageSize, ...rest });
        if (items.length === 0) return all;
        all.push(...items);
        if (all.length >= totalCount) return all;
    }
    throw new NiconicoError(`全ページ取得が上限 (${maxPages} ページ) を超えました`);
}
