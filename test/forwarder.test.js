import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, createMessageHandler, loadConfig, shouldForward } from '../src/forwarder.js';

const CHANNEL_ID = 'chan-1';
const msg = (overrides = {}) => ({
    author: { bot: false },
    channel: { id: CHANNEL_ID },
    content: 'hello',
    ...overrides,
});

describe('shouldForward', () => {
    it('bot の発言は転送しない', () => {
        assert.equal(shouldForward(msg({ author: { bot: true } }), CHANNEL_ID), false);
    });
    it('対象外チャンネルは転送しない', () => {
        assert.equal(shouldForward(msg({ channel: { id: 'other' } }), CHANNEL_ID), false);
    });
    it('対象チャンネルの人間の発言は転送する', () => {
        assert.equal(shouldForward(msg(), CHANNEL_ID), true);
    });
});

describe('createMessageHandler', () => {
    let calls;
    let logger;
    beforeEach(() => {
        calls = [];
        logger = { log: () => {}, error: () => {} };
    });

    it('bot の発言では request を呼ばない', async () => {
        const client = { request: async (...a) => calls.push(a) };
        await createMessageHandler(client, CHANNEL_ID, logger)(msg({ author: { bot: true } }));
        assert.equal(calls.length, 0);
    });

    it('対象外チャンネルでは request を呼ばない', async () => {
        const client = { request: async (...a) => calls.push(a) };
        await createMessageHandler(client, CHANNEL_ID, logger)(msg({ channel: { id: 'x' } }));
        assert.equal(calls.length, 0);
    });

    it('正常時に notes/create を正しい payload で呼ぶ', async () => {
        const client = { request: async (...a) => calls.push(a) };
        await createMessageHandler(client, CHANNEL_ID, logger)(msg({ content: 'こんにちは' }));
        assert.deepEqual(calls, [['notes/create', { text: 'こんにちは' }]]);
    });

    it('投稿失敗時に例外を外へ出さず error をログする', async () => {
        const errors = [];
        logger.error = (...a) => errors.push(a);
        const client = {
            request: async () => {
                throw new Error('boom');
            },
        };
        await assert.doesNotReject(createMessageHandler(client, CHANNEL_ID, logger)(msg()));
        assert.equal(errors.length, 1);
    });
});

describe('loadConfig', () => {
    const full = {
        DISCORD_TOKEN: 't',
        DISCORD_CHANNEL_ID: 'c',
        MISSKEY_INSTANCE_URL: 'https://misskey.example',
        MISSKEY_API_TOKEN: 'm',
    };
    it('全て揃っていれば設定を返す', () => {
        assert.equal(loadConfig(full).channelId, 'c');
    });
    it('欠けている変数名を含むエラーを投げる', () => {
        assert.throws(
            () => loadConfig({ ...full, DISCORD_TOKEN: '', MISSKEY_API_TOKEN: undefined }),
            /DISCORD_TOKEN, MISSKEY_API_TOKEN/,
        );
    });
    it('設定不足は ConfigError を投げる', () => {
        assert.throws(() => loadConfig({}), ConfigError);
    });
});
