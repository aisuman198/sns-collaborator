import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlist, escapeXml } from '../scripts/launchd.js';

const params = {
    label: 'local.sns-collaborator',
    nodeDir: '/opt/node/bin',
    npmPath: '/opt/node/bin/npm',
    workingDir: '/work/repo',
    logDir: '/logs/sns',
};

describe('buildPlist', () => {
    const xml = buildPlist(params);

    it('必要なキーと値を含む', () => {
        assert.match(xml, /<key>Label<\/key>\s*<string>local\.sns-collaborator<\/string>/);
        assert.match(xml, /<string>\/opt\/node\/bin\/npm<\/string>\s*<string>start<\/string>/);
        assert.match(xml, /<key>PATH<\/key>\s*<string>\/opt\/node\/bin:/);
        assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/work\/repo<\/string>/);
        assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
        assert.match(xml, /<key>SuccessfulExit<\/key>\s*<false\/>/);
        assert.match(xml, /<key>ThrottleInterval<\/key>\s*<integer>60<\/integer>/);
        assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/logs\/sns\/out\.log<\/string>/);
        assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/logs\/sns\/err\.log<\/string>/);
    });

    it('XML 特殊文字をエスケープする', () => {
        assert.equal(escapeXml(`<a&b>"'`), '&lt;a&amp;b&gt;&quot;&apos;');
        const out = buildPlist({ ...params, workingDir: '/w/a&b<c>' });
        assert.ok(out.includes('/w/a&amp;b&lt;c&gt;'));
        assert.ok(!out.includes('a&b<c>'));
    });

    it('plutil -lint を通る', { skip: process.platform !== 'darwin' }, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'launchd-test-'));
        try {
            const file = join(dir, 'test.plist');
            await writeFile(file, buildPlist({ ...params, workingDir: '/w/a&b' }));
            execFileSync('plutil', ['-lint', file], { stdio: 'pipe' });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
