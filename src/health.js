// 生存確認モニタ（now・タイマー・状態取得・ステータス書き込みを注入してテスト可能にする）
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MIN = 60 * 1000;

/** 環境変数から分指定の値を読む。不正値は既定値。 */
export function parseMinutes(value, defaultMinutes) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : defaultMinutes;
}

export function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${d}d${h}h${m}m${s % 60}s`;
}

/** ステータスファイルの既定パス（HEALTH_STATUS_FILE があれば優先）。 */
export function defaultStatusFile(env = process.env, home = homedir()) {
    return env.HEALTH_STATUS_FILE || join(home, 'Library', 'Logs', 'sns-collaborator', 'heartbeat.log');
}

/** 同ディレクトリの一時ファイルに書いて rename するアトミック上書き。 */
export function createFileStatusWriter(file) {
    return (line) => {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        try {
            writeFileSync(tmp, `${line}\n`);
            renameSync(tmp, file);
        } catch (e) {
            try { unlinkSync(tmp); } catch { /* 一時ファイルが無ければ何もしない */ }
            throw e;
        }
    };
}

/**
 * @param {object} o
 * @param {() => number} o.now 現在時刻(ms)
 * @param {object} o.logger info/error を持つロガー
 * @param {() => {ready: boolean, ping: number, uptimeMs: number}} o.getStatus
 * checkIntervalMs: 状態確認間隔（既定 1 分）。tick ごとに writeStatus で最新ステータスを上書きする
 * @param {(line: string) => void} o.writeStatus ステータス 1 行を上書き保存する（失敗時は throw）
 * @param {object} o.stats createStats() の結果
 * @param {(reason: string) => void} o.onFatal not-ready 継続時に呼ぶ
 */
export function createHealthMonitor({
    now = Date.now,
    logger,
    getStatus,
    stats,
    onFatal,
    checkIntervalMs = MIN,
    writeStatus = createFileStatusWriter(defaultStatusFile()),
    maxNotReadyMs = 5 * MIN,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
}) {
    let lastTickAt = now();
    let writeFailing = false;
    let notReadySince = null;
    let timer = null;
    let fatal = false;

    function tick() {
        if (fatal) return;
        const t = now();
        const elapsed = t - lastTickAt;
        lastTickAt = t;
        const status = getStatus();

        let resumed = false;
        if (elapsed > checkIntervalMs * 2) {
            resumed = true;
            logger.info(
                `スリープ復帰を検知しました（前回チェックから ${formatDuration(elapsed)} 経過）。再接続の猶予のため未接続判定をリセットします`,
            );
        }

        heartbeat(status, t);
        evaluate(status, t, resumed);
    }

    function heartbeat(status, t) {
        const last = stats.lastReceivedAt === null ? 'なし' : new Date(stats.lastReceivedAt).toISOString();
        const line =
            `[${new Date(t).toISOString()}] heartbeat ws=${status.ready ? 'READY' : 'NOT_READY'} ping=${status.ping}ms ` +
                `uptime=${formatDuration(status.uptimeMs)} ` +
                `received=${stats.received} targetChannel=${stats.targetChannel} botSkipped=${stats.botSkipped} emptySkipped=${stats.emptySkipped} ` +
                `forwardOk=${stats.forwardSucceeded} forwardFail=${stats.forwardFailed} lastReceived=${last}`;
        try {
            writeStatus(line);
            if (writeFailing) {
                writeFailing = false;
                logger.info('ステータスファイルの書き込みが回復しました');
            }
        } catch (e) {
            if (!writeFailing) {
                writeFailing = true;
                logger.error(`ステータスファイルの書き込みに失敗しました: ${e.message}`);
            }
        }
    }

    function evaluate(status, t, resumed) {
        if (status.ready) {
            notReadySince = null;
            return;
        }
        if (notReadySince === null || resumed) {
            notReadySince = t;
            return;
        }
        const notReadyMs = t - notReadySince;
        if (notReadyMs >= maxNotReadyMs) {
            fatal = true;
            const reason = `Discord が READY でない状態が ${formatDuration(notReadyMs)} 続いたため終了します（自動再起動を期待）`;
            logger.error(reason);
            onFatal(reason);
        }
    }

    return {
        tick,
        start() {
            lastTickAt = now();
            timer = setIntervalFn(tick, checkIntervalMs);
            timer?.unref?.();
        },
        stop() {
            if (timer !== null) clearIntervalFn(timer);
            timer = null;
        },
    };
}
