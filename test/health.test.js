import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthMonitor, parseMinutes } from '../src/health.js';
import { createStats } from '../src/stats.js';

const MIN = 60000;

describe('createHealthMonitor', () => {
    let t, ready, infos, errors, fatals, mon;
    beforeEach(() => {
        t = 0; ready = true; infos = []; errors = []; fatals = [];
        mon = createHealthMonitor({
            now: () => t,
            logger: { info: (m) => infos.push(m), error: (m) => errors.push(m) },
            getStatus: () => ({ ready, ping: 42, uptimeMs: t }),
            stats: createStats(),
            onFatal: (r) => fatals.push(r),
            intervalMs: 10 * MIN,
            maxNotReadyMs: 5 * MIN,
        });
    });
    const advance = (ms) => { t += ms; mon.tick(); };

    it('heartbeat を間隔ごとに出す', () => {
        advance(MIN);
        assert.equal(infos.filter((m) => m.startsWith('heartbeat')).length, 1);
        assert.match(infos[0], /ws=READY ping=42ms .*received=0 .*lastReceived=なし/);
        for (let i = 0; i < 5; i++) advance(MIN);
        assert.equal(infos.filter((m) => m.startsWith('heartbeat')).length, 1);
        for (let i = 0; i < 5; i++) advance(MIN);
        assert.equal(infos.filter((m) => m.startsWith('heartbeat')).length, 2);
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
