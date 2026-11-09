import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildShareUrl, buildSharePayload, sendShare } from '../src/share.js';

const TW = 'https://twitter.com/intent/tweet?text=';
const decode = (url) => decodeURIComponent(url.slice(TW.length));
const hasLoneSurrogate = (s) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

describe('buildShareUrl', () => {
    it('短い本文はそのまま encode する', () => {
        const text = '配信の時間だよ〜\nタイトル #1\nhttps://example.com/a';
        assert.equal(decode(buildShareUrl(text)), text);
    });
    for (const [name, title] of [
        ['長い日本語', 'あ'.repeat(200)],
        ['絵文字混じり', '🎮'.repeat(60) + '配信'.repeat(60)],
    ]) {
        it(`512 文字以下に収め、最初と最後の行を残して中間だけ切る: ${name}`, () => {
            const url = buildShareUrl(`配信の時間だよ〜\n${title}\nhttps://www.twitch.tv/example`);
            assert.ok(url.length <= 512, `length=${url.length}`);
            const lines = decode(url).split('\n');
            assert.equal(lines.length, 3);
            assert.equal(lines[0], '配信の時間だよ〜');
            assert.equal(lines[2], 'https://www.twitch.tv/example');
            assert.ok(lines[1].endsWith('…'));
            assert.ok(title.startsWith(lines[1].slice(0, -1)));
            assert.ok(!hasLoneSurrogate(lines[1]));
        });
    }
    it('中間が複数行でも最初と最後の行を残す', () => {
        const text = ['先頭', ...Array.from({ length: 5 }, () => 'い'.repeat(60)), 'https://x.example/end'].join('\n');
        const url = buildShareUrl(text);
        assert.ok(url.length <= 512);
        const lines = decode(url).split('\n');
        assert.equal(lines[0], '先頭');
        assert.equal(lines.at(-1), 'https://x.example/end');
        assert.ok(lines.some((l) => l.endsWith('…')));
    });
    it('2 行以下は末尾側を切り詰め、サロゲートペアを分断しない', () => {
        for (const text of ['🎮'.repeat(300), `先頭\n${'🎮'.repeat(300)}`]) {
            const url = buildShareUrl(text);
            assert.ok(url.length <= 512);
            const out = decode(url);
            assert.ok(out.endsWith('…'));
            assert.ok(!hasLoneSurrogate(out));
            assert.ok(text.startsWith(out.slice(0, -1)));
        }
    });
});

describe('buildSharePayload / sendShare', () => {
    it('content 空・embed description・リンクボタン・allowedMentions を持つ', () => {
        const p = buildSharePayload('本文\nhttps://e.example');
        assert.equal(p.content, '');
        assert.deepEqual(p.embeds, [{ description: '本文\nhttps://e.example' }]);
        assert.deepEqual(p.allowedMentions, { parse: [] });
        assert.equal(p.components[0].type, 1);
        const b = p.components[0].components[0];
        assert.deepEqual([b.type, b.style, b.label], [2, 5, 'ツイートする']);
    });
    it('チャンネルが取れない・send できない・fetch 失敗のときは例外', async () => {
        await assert.rejects(sendShare({ channels: { fetch: async () => null } }, 'c', 't'), /送信できません/);
        await assert.rejects(sendShare({ channels: { fetch: async () => ({}) } }, 'c', 't'), /送信できません/);
        await assert.rejects(
            sendShare(
                {
                    channels: {
                        fetch: async () => {
                            throw new Error('x');
                        },
                    },
                },
                'c',
                't',
            ),
            /x/,
        );
    });
});
