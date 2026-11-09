import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { formatCheckTimes, latestScheduledAt, parseCheckTimes } from '../src/schedule.js';

const T = (iso) => Date.parse(iso);

describe('parseCheckTimes', () => {
    it('未設定・空は既定の 12:30,21:30', () => {
        assert.deepEqual(parseCheckTimes(undefined), [750, 1290]);
        assert.deepEqual(parseCheckTimes(''), [750, 1290]);
    });
    it('空白を許容し、昇順に並べる', () => {
        assert.deepEqual(parseCheckTimes('21:30, 0:00 ,9:05'), [0, 545, 1290]);
        assert.equal(formatCheckTimes([0, 545, 1290]), '00:00,09:05,21:30');
    });
    it('不正な値は Error', () => {
        for (const bad of ['24:00', '12:60', 'abc', '12:30,', ',12:30', '12:30,12:30', '1230', '12:3']) {
            assert.throws(() => parseCheckTimes(bad), Error, bad);
        }
    });
});

describe('latestScheduledAt (JST 固定)', () => {
    const times = parseCheckTimes('12:30,21:30');
    it('定刻前は直前の定刻、定刻ちょうどはその定刻、後はその定刻', () => {
        assert.equal(latestScheduledAt(T('2026-11-10T12:29:59Z'), times), T('2026-11-10T03:30:00Z')); // 21:29:59 JST
        assert.equal(latestScheduledAt(T('2026-11-10T12:30:00Z'), times), T('2026-11-10T12:30:00Z'));
        assert.equal(latestScheduledAt(T('2026-11-10T14:59:00Z'), times), T('2026-11-10T12:30:00Z'));
        assert.equal(latestScheduledAt(T('2026-11-10T03:30:00Z'), times), T('2026-11-10T03:30:00Z'));
    });
    it('日付またぎでは前日 21:30 JST が直近になる', () => {
        // 2026-11-10 00:10 JST = 2026-11-09T15:10Z → 直近は 11/9 21:30 JST = 11/9T12:30Z
        assert.equal(latestScheduledAt(T('2026-11-09T15:10:00Z'), times), T('2026-11-09T12:30:00Z'));
        // 12:00 JST（12:30 の前）も前日 21:30
        assert.equal(latestScheduledAt(T('2026-11-10T03:00:00Z'), times), T('2026-11-09T12:30:00Z'));
    });
    it('UTC 日付が JST と異なる時間帯でも JST で解釈する', () => {
        // 2026-11-10T16:00Z = 11/11 01:00 JST → 直近は 11/10 21:30 JST
        assert.equal(latestScheduledAt(T('2026-11-10T16:00:00Z'), times), T('2026-11-10T12:30:00Z'));
    });
    it('マシンのタイムゾーンに依存しない（TZ=UTC / America/New_York / Asia/Tokyo で同じ結果）', () => {
        const code = `
            import('./src/schedule.js').then((m) => {
                const t = m.parseCheckTimes('12:30,21:30');
                console.log(m.latestScheduledAt(Date.parse('2026-11-09T15:10:00Z'), t));
            });`;
        const results = ['UTC', 'America/New_York', 'Asia/Tokyo'].map((tz) =>
            execFileSync(process.execPath, ['-e', code], {
                env: { ...process.env, TZ: tz },
                cwd: new URL('..', import.meta.url),
            }).toString().trim(),
        );
        assert.deepEqual(results, Array(3).fill(String(T('2026-11-09T12:30:00Z'))));
    });
});
