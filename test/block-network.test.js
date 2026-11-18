import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('実ネットワーク遮断 (test/setup/block-network.mjs)', () => {
    it('未差し替えの fetch は URL 入りのエラーで reject する', async () => {
        await assert.rejects(
            () => fetch('https://ext.nicovideo.jp/api/getthumbinfo/sm1'),
            /実ネットワークへの fetch は禁止です: https:\/\/ext\.nicovideo\.jp\/api\/getthumbinfo\/sm1/,
        );
    });

    it('URL オブジェクトでも遮断される', async () => {
        await assert.rejects(() => fetch(new URL('https://example.com/x')), /禁止です: https:\/\/example\.com\/x/);
    });
});
