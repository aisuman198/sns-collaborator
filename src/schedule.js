// 定刻スケジュールの計算（常に JST = UTC+9 固定。実行マシンのタイムゾーンに依存しない）
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const JST_OFFSET_MS = 9 * HOUR;

export const DEFAULT_CHECK_TIMES = '12:30,21:30';

/**
 * "HH:MM,HH:MM" を JST の 0 時からの経過分の昇順配列にする。空・未設定は既定値。
 * 不正な書式・重複は Error を投げる（呼び出し側で ConfigError に変換する）。
 */
export function parseCheckTimes(value) {
    const text = value === undefined || value === null || String(value).trim() === ''
        ? DEFAULT_CHECK_TIMES
        : String(value);
    const minutes = text.split(',').map((raw) => {
        const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw.trim());
        if (!m) throw new Error(`不正な時刻です: "${raw.trim()}"（HH:MM 形式、カンマ区切り）`);
        return Number(m[1]) * 60 + Number(m[2]);
    });
    if (new Set(minutes).size !== minutes.length) throw new Error(`時刻が重複しています: ${text}`);
    return minutes.sort((a, b) => a - b);
}

/** 分配列を "12:30,21:30" 形式（JST）にする。 */
export function formatCheckTimes(minutes) {
    return minutes
        .map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
        .join(',');
}

/**
 * nowMs 以前で直近の定刻（UTC epoch ms）を返す。
 * 当日（JST）と前日の定刻を候補にするため、日付またぎでも前日の最終定刻が選ばれる。
 */
export function latestScheduledAt(nowMs, minutes) {
    const jstDayStart = Math.floor((nowMs + JST_OFFSET_MS) / DAY) * DAY - JST_OFFSET_MS;
    let best = -Infinity;
    for (const dayOffset of [-1, 0]) {
        for (const m of minutes) {
            const t = jstDayStart + dayOffset * DAY + m * MIN;
            if (t <= nowMs && t > best) best = t;
        }
    }
    return best;
}
