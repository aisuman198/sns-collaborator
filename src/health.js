// 生存確認モニタ（now・タイマー・状態取得を注入してテスト可能にする）

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

/**
 * @param {object} o
 * @param {() => number} o.now 現在時刻(ms)
 * @param {object} o.logger info/error を持つロガー
 * @param {() => {ready: boolean, ping: number, uptimeMs: number}} o.getStatus
 * intervalMs: heartbeat 間隔 / checkIntervalMs: 状態確認間隔（既定は min(intervalMs, 1分)）
 * @param {object} o.stats createStats() の結果
 * @param {(reason: string) => void} o.onFatal not-ready 継続時に呼ぶ
 */
export function createHealthMonitor({
    now = Date.now,
    logger,
    getStatus,
    stats,
    onFatal,
    intervalMs = 10 * MIN,
    checkIntervalMs = Math.min(intervalMs, MIN),
    maxNotReadyMs = 5 * MIN,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
}) {
    let lastTickAt = now();
    let lastHeartbeatAt = null;
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

        if (lastHeartbeatAt === null || t - lastHeartbeatAt >= intervalMs || resumed) {
            lastHeartbeatAt = t;
            heartbeat(status);
        }
        evaluate(status, t, resumed);
    }

    function heartbeat(status) {
        const last = stats.lastReceivedAt === null ? 'なし' : new Date(stats.lastReceivedAt).toISOString();
        logger.info(
            `heartbeat ws=${status.ready ? 'READY' : 'NOT_READY'} ping=${status.ping}ms ` +
                `uptime=${formatDuration(status.uptimeMs)} ` +
                `received=${stats.received} targetChannel=${stats.targetChannel} botSkipped=${stats.botSkipped} ` +
                `forwardOk=${stats.forwardSucceeded} forwardFail=${stats.forwardFailed} lastReceived=${last}`,
        );
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
