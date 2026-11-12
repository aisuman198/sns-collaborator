// 運用系の特性テスト（現行挙動の固定）。既存の health.test.js / launchd.test.js と重複しない項目のみ。
// launchctl を呼ぶ install / uninstall は実行しない。print と不明コマンドのみ子プロセスで検証する。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHealthMonitor } from '../src/health.js';
import { createStats } from '../src/stats.js';
import { buildPlist } from '../scripts/launchd.js';

const MIN = 60000;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launchdScript = join(repoRoot, 'scripts', 'launchd.js');

function makeMonitor(over = {}) {
    const writes = [];
    const monitor = createHealthMonitor({
        now: () => Date.UTC(2025, 0, 2, 3, 4, 5),
        logger: { info() {}, error() {} },
        getStatus: () => ({ ready: true, ping: 42, uptimeMs: 90061000 }),
        stats: createStats(),
        onFatal() {},
        writeStatus: (l) => writes.push(l),
        ...over,
    });
    return { monitor, writes };
}

describe('C21: heartbeat 全行ゴールデン', () => {
    it('全カウンタ設定時のキーと順序を文字列で固定する', () => {
        const stats = {
            received: 1, targetChannel: 2, botSkipped: 3, emptySkipped: 4,
            forwardSucceeded: 5, forwardFailed: 6, shareSucceeded: 7, shareFailed: 8,
            niconicoFetchOk: 9, niconicoFetchFailed: 10, niconicoAnnounced: 11,
            lastReceivedAt: Date.UTC(2025, 0, 2, 3, 0, 0),
        };
        const { monitor, writes } = makeMonitor({ stats });
        monitor.tick();
        assert.deepEqual(writes, [
            '[2025-01-02T03:04:05.000Z] heartbeat ws=READY ping=42ms uptime=1d1h1m1s ' +
            'received=1 targetChannel=2 botSkipped=3 emptySkipped=4 forwardOk=5 forwardFail=6 ' +
            'shareOk=7 shareFail=8 niconicoOk=9 niconicoFail=10 niconicoAnnounced=11 ' +
            'lastReceived=2025-01-02T03:00:00.000Z',
        ]);
    });

    it('初期 stats + NOT_READY の全行（lastReceived=なし）', () => {
        const { monitor, writes } = makeMonitor({
            getStatus: () => ({ ready: false, ping: -1, uptimeMs: 0 }),
        });
        monitor.tick();
        assert.deepEqual(writes, [
            '[2025-01-02T03:04:05.000Z] heartbeat ws=NOT_READY ping=-1ms uptime=0d0h0m0s ' +
            'received=0 targetChannel=0 botSkipped=0 emptySkipped=0 forwardOk=0 forwardFail=0 ' +
            'shareOk=0 shareFail=0 niconicoOk=0 niconicoFail=0 niconicoAnnounced=0 lastReceived=なし',
        ]);
    });
});

describe('C22: start / stop と処理順', () => {
    function fakeTimers() {
        const calls = { set: [], clear: [], unref: 0 };
        const handle = { unref() { calls.unref++; } };
        return {
            calls, handle,
            setIntervalFn: (fn, ms) => { calls.set.push({ fn, ms }); return handle; },
            clearIntervalFn: (h) => { calls.clear.push(h); },
        };
    }

    it('start は checkIntervalMs（既定 1 分）で tick を登録し unref する。即時 tick はしない', () => {
        const f = fakeTimers();
        const { monitor, writes } = makeMonitor({ setIntervalFn: f.setIntervalFn, clearIntervalFn: f.clearIntervalFn });
        monitor.start();
        assert.equal(f.calls.set.length, 1);
        assert.equal(f.calls.set[0].ms, MIN);
        assert.equal(f.calls.unref, 1);
        assert.equal(writes.length, 0);
        f.calls.set[0].fn();
        assert.equal(writes.length, 1);
    });

    it('checkIntervalMs を指定するとその間隔で登録される', () => {
        const f = fakeTimers();
        const { monitor } = makeMonitor({ checkIntervalMs: 1234, setIntervalFn: f.setIntervalFn, clearIntervalFn: f.clearIntervalFn });
        monitor.start();
        assert.equal(f.calls.set[0].ms, 1234);
    });

    it('unref を持たないタイマー値でも start は落ちない', () => {
        const { monitor } = makeMonitor({ setIntervalFn: () => 7, clearIntervalFn() {} });
        assert.doesNotThrow(() => monitor.start());
    });

    it('stop は登録済みハンドルを clear し、2 回目や start 前は clear しない', () => {
        const f = fakeTimers();
        const { monitor } = makeMonitor({ setIntervalFn: f.setIntervalFn, clearIntervalFn: f.clearIntervalFn });
        monitor.stop();
        assert.equal(f.calls.clear.length, 0);
        monitor.start();
        monitor.stop();
        monitor.stop();
        assert.deepEqual(f.calls.clear, [f.handle]);
    });

    it('stop 後に tick を直接呼べば動く（stop は tick を無効化しない）', () => {
        const f = fakeTimers();
        const { monitor, writes } = makeMonitor({ setIntervalFn: f.setIntervalFn, clearIntervalFn: f.clearIntervalFn });
        monitor.start();
        monitor.stop();
        monitor.tick();
        assert.equal(writes.length, 1);
    });

    it('start は lastTickAt を now で取り直すため、生成から start までの空白でスリープ扱いにならない', () => {
        let t = 0;
        const infos = [];
        const f = fakeTimers();
        const { monitor } = makeMonitor({
            now: () => t,
            logger: { info: (m) => infos.push(m), error() {} },
            setIntervalFn: f.setIntervalFn, clearIntervalFn: f.clearIntervalFn,
        });
        t = 60 * MIN;
        monitor.start();
        t += MIN;
        monitor.tick();
        assert.equal(infos.length, 0);
    });

    it('処理順: スリープ検知ログ -> heartbeat 書き込み -> 判定（onFatal）', () => {
        let t = 0;
        const order = [];
        const { monitor } = makeMonitor({
            now: () => t,
            getStatus: () => ({ ready: false, ping: 1, uptimeMs: 0 }),
            logger: { info: (m) => order.push(`info:${m.slice(0, 8)}`), error: () => order.push('error') },
            writeStatus: () => order.push('write'),
            onFatal: () => order.push('fatal'),
            maxNotReadyMs: 5 * MIN,
        });
        t += MIN; monitor.tick(); order.length = 0;
        t += 3 * MIN; monitor.tick(); // 3 分 > 2 分: スリープ扱い
        assert.deepEqual(order, ['info:スリープ復帰を検', 'write']);
        order.length = 0;
        for (let i = 0; i < 5; i++) { t += MIN; monitor.tick(); }
        assert.deepEqual(order, ['write', 'write', 'write', 'write', 'write', 'error', 'fatal']);
    });

    it('fatal 後の tick は getStatus も writeStatus も呼ばない', () => {
        let t = 0, statusCalls = 0;
        const writes = [];
        const { monitor } = makeMonitor({
            now: () => t,
            getStatus: () => { statusCalls++; return { ready: false, ping: 1, uptimeMs: 0 }; },
            writeStatus: (l) => writes.push(l),
            maxNotReadyMs: 2 * MIN,
        });
        for (let i = 0; i < 3; i++) { t += MIN; monitor.tick(); }
        const s = statusCalls, w = writes.length;
        t += MIN; monitor.tick();
        assert.equal(statusCalls, s);
        assert.equal(writes.length, w);
    });

    it('スリープ判定は elapsed > 2 * interval の境界（ちょうど 2 倍は対象外）', () => {
        let t = 0;
        const infos = [];
        const { monitor } = makeMonitor({ now: () => t, logger: { info: (m) => infos.push(m), error() {} } });
        t += 2 * MIN; monitor.tick();
        assert.equal(infos.length, 0);
        t += 2 * MIN + 1; monitor.tick();
        assert.equal(infos.length, 1);
        assert.match(infos[0], /前回チェックから 0d0h2m0s 経過/);
    });
});

describe('C23: plist の PATH と workingDir', () => {
    const base = { label: 'l', npmPath: '/n/npm', workingDir: '/w', logDir: '/log' };
    const pathOf = (xml) => xml.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/)[1];

    it('PATH は nodeDir を先頭に固定順で連結される', () => {
        assert.equal(
            pathOf(buildPlist({ ...base, nodeDir: '/opt/node/bin' })),
            '/opt/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        );
    });

    it('nodeDir が既定候補と重複する場合は重複を除く（先頭位置を保つ）', () => {
        assert.equal(
            pathOf(buildPlist({ ...base, nodeDir: '/usr/local/bin' })),
            '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        );
        assert.equal(
            pathOf(buildPlist({ ...base, nodeDir: '/bin' })),
            '/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/usr/sbin:/sbin',
        );
    });

    it('nodeDir の末尾スラッシュは正規化されず別要素として残る', () => {
        assert.equal(
            pathOf(buildPlist({ ...base, nodeDir: '/usr/bin/' })),
            '/usr/bin/:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        );
    });

    it('PATH 内の XML 特殊文字もエスケープされる', () => {
        assert.ok(pathOf(buildPlist({ ...base, nodeDir: '/a&b' })).startsWith('/a&amp;b:'));
    });

    it('ログパスは logDir 配下の out.log / err.log、ProgramArguments は npm start', () => {
        const xml = buildPlist({ ...base, nodeDir: '/x', logDir: '/log/dir' });
        assert.ok(xml.includes('<string>/log/dir/out.log</string>'));
        assert.ok(xml.includes('<string>/log/dir/err.log</string>'));
        assert.ok(xml.includes('<string>/n/npm</string>\n        <string>start</string>'));
    });

    it('plist 全体は XML 宣言で始まり末尾に改行が 1 つある', () => {
        const xml = buildPlist({ ...base, nodeDir: '/x' });
        assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist'));
        assert.ok(xml.endsWith('</plist>\n'));
    });

    it('print: workingDir はリポジトリルート、PATH 先頭は実行中 node のディレクトリ', () => {
        const out = execFileSync(process.execPath, [launchdScript, 'print'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        assert.match(out, new RegExp(`<key>WorkingDirectory</key>\\s*<string>${repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
        assert.ok(pathOf(out).startsWith(`${dirname(process.execPath)}:`));
        assert.match(out, /<key>Label<\/key>\s*<string>local\.sns-collaborator<\/string>/);
        assert.match(out, /Library\/Logs\/sns-collaborator\/out\.log/);
    });
});

describe('C24: npm 探索とサブコマンドのエラー', () => {
    it('サブコマンド無しは使い方を stderr に出して終了コード 1', () => {
        const r = spawnSync(process.execPath, [launchdScript], { encoding: 'utf8' });
        assert.equal(r.status, 1);
        assert.equal(r.stderr, '使い方: node scripts/launchd.js <install|uninstall|print>\n');
        assert.equal(r.stdout, '');
    });

    it('不明なサブコマンドも同じ使い方エラーで終了コード 1', () => {
        const r = spawnSync(process.execPath, [launchdScript, 'bogus'], { encoding: 'utf8' });
        assert.equal(r.status, 1);
        assert.equal(r.stderr, '使い方: node scripts/launchd.js <install|uninstall|print>\n');
    });

    it('サブコマンドは大文字小文字を区別する', () => {
        const r = spawnSync(process.execPath, [launchdScript, 'PRINT'], { encoding: 'utf8' });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /使い方/);
    });

    it('nodeDir に npm が無く which npm も失敗する場合は「npm が見つかりません。」で終了コード 1', (t) => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'launchd-nonpm-')));
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        const nodeCopy = join(dir, 'node');
        copyFileSync(process.execPath, nodeCopy);
        chmodSync(nodeCopy, 0o755);
        // node のコピーが単体で起動できない環境ではスキップ
        const probe = spawnSync(nodeCopy, ['-p', 'process.execPath'], { encoding: 'utf8', env: { PATH: '' } });
        if (probe.status !== 0 || dirname(probe.stdout.trim()) !== dir) {
            t.skip('node バイナリのコピーが単体で起動できない');
            return;
        }
        // PATH を空にして which 自体を見つからなくさせる（ENOENT も同じ catch に入る）
        const r = spawnSync(nodeCopy, [launchdScript, 'print'], { encoding: 'utf8', env: { PATH: '' } });
        assert.equal(r.status, 1);
        assert.equal(r.stderr, 'npm が見つかりません。\n');
        assert.equal(r.stdout, '');
    });

    it('nodeDir の npm が存在すればそれが ProgramArguments に使われる（which は使わない）', () => {
        const out = execFileSync(process.execPath, [launchdScript, 'print'], { encoding: 'utf8', env: { PATH: '' } });
        assert.ok(out.includes(`<string>${join(dirname(process.execPath), 'npm')}</string>`));
    });
});
