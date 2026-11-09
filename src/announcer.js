// ニコニコ動画の新着告知（新着判定・文面・配信・状態保存・ポーラー）
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fetchAllUserVideos, fetchUserVideosPage } from './niconico.js';

const HOUR = 60 * 60 * 1000;
export const STALE_MS = 24 * HOUR; // これ以上古い動画は告知しない
export const POLL_PAGE_SIZE = 20;
export const ANOMALY_THRESHOLD = 4; // 1 回の告知対象がこの件数以上なら異常
export const FAILURE_ALERT_THRESHOLD = 3; // 連続取得失敗で ERROR を出す回数
export const DESTINATIONS = ['announce', 'twitter', 'misskey'];

/** 告知文（3 宛先共通）。 */
export function buildAnnouncementText(video) {
    return `動画を投稿しました！\n${video.title}\nhttps://www.nicovideo.jp/watch/${video.id}`;
}

export const TWEET_INTENT_URL = 'https://twitter.com/intent/tweet?text=';
export const MAX_BUTTON_URL_LENGTH = 512; // Discord のリンクボタン URL の上限

/**
 * ツイート投稿用の intent URL を作る。URL 全体が 512 文字以下になるよう、
 * ツイート文の「タイトルだけ」を末尾 … 付きで切り詰める（1 行目と動画 URL の行は残す）。
 * 切り詰めはコードポイント単位（サロゲートペアを分断しない）で、encode 後の長さで判定する。
 */
export function buildTweetUrl(video) {
    const make = (title) => TWEET_INTENT_URL + encodeURIComponent(buildAnnouncementText({ ...video, title }));
    let url = make(video.title);
    if (url.length <= MAX_BUTTON_URL_LENGTH) return url;
    const chars = Array.from(video.title);
    while (chars.length > 0) {
        chars.pop();
        url = make(`${chars.join('')}…`);
        if (url.length <= MAX_BUTTON_URL_LENGTH) return url;
    }
    return make('…');
}

// ---- 状態ファイル ----

/**
 * 状態ファイルの読み書き。
 * load(): { status: 'missing' } | { status: 'ok', state } | { status: 'corrupt', reason }
 * JSON 破損・書式不正は corrupt（初回扱いにしない）。
 */
export function createStateStore(file) {
    return {
        file,
        load() {
            let text;
            try {
                text = readFileSync(file, 'utf8');
            } catch (error) {
                if (error?.code === 'ENOENT') return { status: 'missing' };
                return { status: 'corrupt', reason: `読み込み失敗: ${error.message}` };
            }
            let state;
            try {
                state = JSON.parse(text);
            } catch (error) {
                return { status: 'corrupt', reason: `JSON 破損: ${error.message}` };
            }
            const reason = validateState(state);
            return reason ? { status: 'corrupt', reason } : { status: 'ok', state };
        },
        save(state) {
            mkdirSync(dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            try {
                writeFileSync(tmp, JSON.stringify(state, null, 2));
                renameSync(tmp, file);
            } catch (error) {
                try { unlinkSync(tmp); } catch { /* 一時ファイルが無ければ何もしない */ }
                throw error;
            }
        },
    };
}

function validateState(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return '状態がオブジェクトではありません';
    if (s.version !== 1) return `未対応の version: ${s.version}`;
    if (typeof s.userId !== 'string' || s.userId === '') return 'userId が不正です';
    if (!Array.isArray(s.known) || s.known.some((id) => typeof id !== 'string')) return 'known が不正です';
    if (!s.pending || typeof s.pending !== 'object' || Array.isArray(s.pending)) return 'pending が不正です';
    for (const [id, p] of Object.entries(s.pending)) {
        if (!p || typeof p !== 'object') return `pending[${id}] が不正です`;
        if (typeof p.title !== 'string' || typeof p.url !== 'string') return `pending[${id}] の title/url が不正です`;
        if (!Number.isFinite(Date.parse(p.registeredAt))) return `pending[${id}].registeredAt が不正です`;
        if (!p.delivered || typeof p.delivered !== 'object') return `pending[${id}].delivered が不正です`;
    }
    return null;
}

// ---- 配信先 ----

/**
 * 実配信先を組み立てる。各値は (text, video) => Promise<void>（video は { id, title }）。
 * Discord は allowedMentions: { parse: [] } で @everyone 等の通知を無効化する。
 * twitter 宛ては既存のライブ配信投稿と同じ形式（content 空・embed の description・「ツイートする」リンクボタン）。
 */
export function createDestinations({ discordClient, misskeyClient, announceChannelId, twitterChannelId }) {
    const toChannel = (channelId) => async (text) => {
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel || typeof channel.send !== 'function') {
            throw new Error(`Discord チャンネルに送信できません: id=${channelId}`);
        }
        await channel.send({ content: text, allowedMentions: { parse: [] } });
    };
    const toTweetChannel = (channelId) => async (text, video) => {
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel || typeof channel.send !== 'function') {
            throw new Error(`Discord チャンネルに送信できません: id=${channelId}`);
        }
        await channel.send({
            content: '',
            embeds: [{ description: text }],
            components: [
                {
                    type: 1,
                    components: [{ type: 2, style: 5, label: 'ツイートする', url: buildTweetUrl(video) }],
                },
            ],
            allowedMentions: { parse: [] },
        });
    };
    return {
        announce: toChannel(announceChannelId),
        twitter: toTweetChannel(twitterChannelId),
        misskey: async (text) => {
            await misskeyClient.request('notes/create', { text });
        },
    };
}

// ---- 新着判定・配信 ----

/**
 * @param {object} o
 * @param {string} o.userId
 * @param {{load: Function, save: Function}} o.store
 * @param {Record<string, (text: string) => Promise<void>>} o.destinations announce/twitter/misskey
 * @param {(page: number, pageSize: number) => Promise<{items: object[]}>} [o.fetchPage]
 * @param {() => Promise<object[]>} [o.fetchAll]
 */
export function createAnnouncer({
    userId,
    store,
    destinations,
    logger,
    stats,
    now = Date.now,
    fetchPage = (page, pageSize) => fetchUserVideosPage({ userId, page, pageSize }),
    fetchAll = () => fetchAllUserVideos({ userId }),
}) {
    let consecutiveFailures = 0;
    let alerted = false;
    let corruptReported = false;

    function recordFetchFailure(error) {
        stats.niconicoFetchFailed += 1;
        consecutiveFailures += 1;
        logger.warn(`ニコニコ動画の取得に失敗しました (連続${consecutiveFailures}回): ${error?.message ?? error}`);
        if (consecutiveFailures >= FAILURE_ALERT_THRESHOLD && !alerted) {
            alerted = true;
            logger.error(`ニコニコ動画の取得が ${consecutiveFailures} 回連続で失敗しています`);
        }
    }

    function recordFetchSuccess() {
        stats.niconicoFetchOk += 1;
        if (alerted) logger.info(`ニコニコ動画の取得が回復しました (失敗${consecutiveFailures}回後)`);
        consecutiveFailures = 0;
        alerted = false;
    }

    /** 新規 ID を判定して state を更新する（保存は呼び出し側）。変更があれば true。 */
    function collectNew(state, items) {
        const known = new Set(state.known);
        const t = now();
        const fresh = [];
        let changed = false;
        for (const v of items) {
            if (known.has(v.id)) continue;
            if (v.registeredAtMs > t) continue; // 未来の動画は既知にもしない
            if (t - v.registeredAtMs >= STALE_MS) {
                logger.warn(`古い新規動画のため告知せず既知に登録します: id=${v.id} registeredAt=${v.registeredAt}`);
                state.known.push(v.id);
                known.add(v.id);
                changed = true;
                continue;
            }
            fresh.push(v);
        }
        if (fresh.length >= ANOMALY_THRESHOLD) {
            logger.error(
                `告知対象が ${fresh.length} 件あり異常のため投稿せず既知に登録します: ${fresh.map((v) => v.id).join(', ')}`,
            );
            for (const v of fresh) state.known.push(v.id);
            return true;
        }
        fresh.sort((a, b) => a.registeredAtMs - b.registeredAtMs);
        for (const v of fresh) {
            state.known.push(v.id);
            state.pending[v.id] = {
                title: v.title,
                url: `https://www.nicovideo.jp/watch/${v.id}`,
                registeredAt: v.registeredAt,
                delivered: Object.fromEntries(DESTINATIONS.map((d) => [d, false])),
            };
            changed = true;
        }
        return changed;
    }

    /** pending を古い順に配信する。成功の都度保存。 */
    async function deliverPending(state) {
        const ids = Object.keys(state.pending).sort(
            (a, b) => Date.parse(state.pending[a].registeredAt) - Date.parse(state.pending[b].registeredAt),
        );
        for (const id of ids) {
            const p = state.pending[id];
            if (now() - Date.parse(p.registeredAt) >= STALE_MS) {
                logger.error(
                    `24時間を過ぎた未配信を諦めます: id=${id} 未配信=${DESTINATIONS.filter((d) => !p.delivered[d]).join(',')}`,
                );
                delete state.pending[id];
                store.save(state);
                continue;
            }
            const text = buildAnnouncementText({ id, title: p.title });
            for (const dest of DESTINATIONS) {
                if (p.delivered[dest]) continue;
                try {
                    await destinations[dest](text, { id, title: p.title });
                } catch (error) {
                    logger.error(`告知の配信に失敗しました (次回再試行): id=${id} 宛先=${dest}`, error);
                    continue;
                }
                p.delivered[dest] = true;
                store.save(state);
                logger.info(`告知を配信しました: id=${id} 宛先=${dest}`);
            }
            if (DESTINATIONS.every((d) => p.delivered[d])) {
                delete state.pending[id];
                store.save(state);
                stats.niconicoAnnounced += 1;
            }
        }
    }

    async function seed() {
        const t = now();
        const all = await fetchAll();
        // 未来日時（公開予約中）の動画は既知にしない（通常ポーリングと同じ扱い。公開後に告知される）
        const items = all.filter((v) => v.registeredAtMs <= t);
        store.save({ version: 1, userId, known: items.map((v) => v.id), pending: {} });
        logger.info(
            `ニコニコ動画の初回シード完了: ${items.length} 件を既知に登録しました（投稿なし）` +
                (all.length > items.length ? ` / 公開前の ${all.length - items.length} 件は除外` : ''),
        );
    }

    async function tick() {
        const loaded = store.load();
        if (loaded.status === 'corrupt') {
            if (!corruptReported) {
                corruptReported = true;
                logger.error(`ニコニコ動画の状態ファイルが不正なため何もしません (${store.file}): ${loaded.reason}`);
            }
            return;
        }
        corruptReported = false;

        if (loaded.status === 'missing' || loaded.state.userId !== userId) {
            try {
                await seed();
                recordFetchSuccess();
            } catch (error) {
                recordFetchFailure(error);
            }
            return;
        }

        const state = loaded.state;
        try {
            const { items } = await fetchPage(1, POLL_PAGE_SIZE);
            recordFetchSuccess();
            if (collectNew(state, items)) store.save(state);
        } catch (error) {
            recordFetchFailure(error);
        }
        await deliverPending(state); // 取得失敗でも pending の再試行は行う
    }

    return { tick };
}

// ---- ポーラー ----

/**
 * 完了後に次を予約する setTimeout 方式（重複実行しない）。例外は全て捕捉する。
 */
export function createPoller({
    tick,
    intervalMs,
    logger,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
}) {
    let timer = null;
    let running = false;
    let stopped = true;

    function schedule(delay) {
        if (stopped) return;
        timer = setTimeoutFn(run, delay);
        timer?.unref?.();
    }

    async function run() {
        timer = null;
        if (stopped || running) return;
        running = true;
        try {
            await tick();
        } catch (error) {
            logger.error('ニコニコ動画のポーリングで予期しないエラー:', error);
        } finally {
            running = false;
            schedule(intervalMs);
        }
    }

    return {
        start() {
            if (!stopped) return;
            stopped = false;
            schedule(0);
        },
        stop() {
            stopped = true;
            if (timer !== null) clearTimeoutFn(timer);
            timer = null;
        },
    };
}
