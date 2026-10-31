import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../src/forwarder.js';
import { createStats } from '../src/stats.js';

const quiet = { log: () => {}, error: () => {} };
const msg = (o = {}) => ({ author: { bot: false }, channel: { id: 'c' }, content: 'x', ...o });

describe('受信統計', () => {
    it('総数・対象・bot除外・成功・失敗・最終受信時刻を数える', async () => {
        const stats = createStats();
        let fail = false;
        const mk = { request: async () => { if (fail) throw new Error('ng'); } };
        let t = 1000;
        const h = createMessageHandler(mk, 'c', quiet, stats, () => t++);
        await h(msg({ channel: { id: 'other' } }));
        await h(msg({ author: { bot: true } }));
        await h(msg());
        fail = true;
        await h(msg());
        assert.equal(stats.received, 4);
        assert.equal(stats.targetChannel, 3);
        assert.equal(stats.botSkipped, 1);
        assert.equal(stats.forwardSucceeded, 1);
        assert.equal(stats.forwardFailed, 1);
        assert.equal(stats.lastReceivedAt, 1003);
    });
});
