import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStatusWriter, createHealthMonitor, defaultStatusFile, parseMinutes } from '../src/health.js';
import { createStats } from '../src/stats.js';

const MIN = 60000;

describe('createHealthMonitor', () => {
    let t, ready, infos, errors, fatals, mon, writes, writeImpl;
    beforeEach(() => {
        t = 0; ready = true; infos = []; errors = []; fatals = []; writes = []; writeImpl = (l) => writes.push(l);
        mon = createHealthMonitor({
            now: () => t,
            logger: { info: (m) => infos.push(m), error: (m) => errors.push(m) },
            getStatus: () => ({ ready, ping: 42, uptimeMs: t }),
            stats: createStats(),
            onFatal: (r) => fatals.push(r),
            writeStatus: (l) => writeImpl(l),
            maxNotReadyMs: 5 * MIN,
        });
    });
    const advance = (ms) => { t += ms; mon.tick(); };

    it('tick ごとに writeStatus が呼ばれ、logger には heartbeat が出ない', () => {
        for (let i = 0; i < 3; i++) advance(MIN);
        assert.equal(writes.length, 3);
        assert.match(writes[2], /^\[1970-01-01T00:03:00\.000Z\] heartbeat ws=READY ping=42ms .*received=0 .*lastReceived=なし/);
        assert.equal(infos.filter((m) => m.includes('heartbeat')).length, 0);
    });

    it('書き込み失敗でも落ちず、ログは状態遷移時のみ', () => {
        writeImpl = () => { throw new Error('disk full'); };
        advance(MIN); advance(MIN); advance(MIN);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /disk full/);
        writeImpl = (l) => writes.push(l);
        advance(MIN); advance(MIN);
        assert.equal(writes.length, 2);
        assert.equal(infos.filter((m) => m.includes('回復')).length, 1);
        assert.equal(errors.length, 1);
    });

    it('not-ready が 5 分続いたら onFatal', () => {
        ready = false;
        advance(MIN); // 起点
        for (let i = 0; i < 4; i++) advance(MIN);
        assert.equal(fatals.length, 0);
        advance(MIN);
        assert.equal(fatals.length, 1);
        assert.equal(errors.length, 1);
        advance(MIN);
        assert.equal(fatals.length, 1);
    });

    it('READY 復帰で起点がリセットされる', () => {
        ready = false;
        advance(MIN);
        for (let i = 0; i < 4; i++) advance(MIN);
        ready = true;
        advance(MIN);
        ready = false;
        advance(MIN);
        for (let i = 0; i < 4; i++) advance(MIN);
        assert.equal(fatals.length, 0);
    });

    it('スリープ跳躍では猶予を与える', () => {
        ready = false;
        advance(MIN);
        advance(30 * MIN); // スリープ復帰
        assert.ok(infos.some((m) => m.includes('スリープ復帰を検知')));
        assert.equal(fatals.length, 0);
        for (let i = 0; i < 4; i++) advance(MIN);
        assert.equal(fatals.length, 0);
        advance(MIN);
        assert.equal(fatals.length, 1);
    });
});

describe('parseMinutes', () => {
    it('不正値は既定値', () => {
        assert.equal(parseMinutes(undefined, 10), 10);
        assert.equal(parseMinutes('abc', 10), 10);
        assert.equal(parseMinutes('0', 10), 10);
        assert.equal(parseMinutes('3', 10), 3);
    });
});

describe('createFileStatusWriter', () => {
    it('2 回書いて最新内容のみ残り、一時ファイルが残らない', () => {
        const dir = mkdtempSync(join(tmpdir(), 'health-'));
        try {
            const file = join(dir, 'sub', 'heartbeat.log');
            const write = createFileStatusWriter(file);
            write('first');
            write('second');
            assert.equal(readFileSync(file, 'utf8'), 'second\n');
            assert.deepEqual(readdirSync(join(dir, 'sub')), ['heartbeat.log']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('defaultStatusFile', () => {
    it('環境変数優先、無ければ home 配下', () => {
        assert.equal(defaultStatusFile({ HEALTH_STATUS_FILE: '/x/y' }, '/h'), '/x/y');
        assert.equal(defaultStatusFile({}, '/h'), '/h/Library/Logs/sns-collaborator/heartbeat.log');
    });
});
