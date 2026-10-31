// タイムスタンプ付きロガー: `[ISO8601] LEVEL message`
import { format } from 'node:util';

/**
 * ロガーを生成する。出力先と時刻取得は注入可能。
 * info/log/warn は out（console.log）、error は err（console.error）へ出す。
 */
export function createLogger({
    out = (line) => console.log(line),
    err = (line) => console.error(line),
    now = () => new Date(),
} = {}) {
    const emit = (level, sink) => (...args) => {
        sink(`[${now().toISOString()}] ${level} ${format(...args)}`);
    };
    const info = emit('INFO', out);
    return {
        info,
        log: info,
        warn: emit('WARN', out),
        error: emit('ERROR', err),
    };
}
