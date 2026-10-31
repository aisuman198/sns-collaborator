import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logger.js';

describe('createLogger', () => {
    it('[ISO8601] LEVEL message 形式で出力し、error は stderr 側へ', () => {
        const out = [];
        const err = [];
        const logger = createLogger({
            out: (l) => out.push(l),
            err: (l) => err.push(l),
            now: () => new Date('2026-11-01T00:00:00.000Z'),
        });
        logger.info('hello %s', 'world');
        logger.log('x', 1);
        logger.warn('w');
        logger.error('e');
        assert.deepEqual(out, [
            '[2026-11-01T00:00:00.000Z] INFO hello world',
            '[2026-11-01T00:00:00.000Z] INFO x 1',
            '[2026-11-01T00:00:00.000Z] WARN w',
        ]);
        assert.deepEqual(err, ['[2026-11-01T00:00:00.000Z] ERROR e']);
    });
});
