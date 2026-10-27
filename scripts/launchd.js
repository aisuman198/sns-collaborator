#!/usr/bin/env node
// macOS launchd (LaunchAgent) でログイン時に bot を自動起動するための管理スクリプト。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABEL = 'local.sns-collaborator';

export const escapeXml = (value) =>
    String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

export function buildPlist({ label, nodeDir, npmPath, workingDir, logDir }) {
    const e = escapeXml;
    const path = [nodeDir, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    const uniquePath = [...new Set(path)].join(':');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${e(label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${e(npmPath)}</string>
        <string>start</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${e(uniquePath)}</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>${e(workingDir)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>60</integer>
    <key>StandardOutPath</key>
    <string>${e(join(logDir, 'out.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${e(join(logDir, 'err.log'))}</string>
</dict>
</plist>
`;
}

function resolveNpmPath(nodeDir) {
    const local = join(nodeDir, 'npm');
    if (existsSync(local)) return local;
    try {
        const found = execFileSync('which', ['npm'], { encoding: 'utf8' }).trim();
        if (found) return found;
    } catch {
        // フォールスルーして下でエラーにする
    }
    throw new Error('npm が見つかりません。');
}

function context() {
    const nodeDir = dirname(process.execPath);
    const logDir = join(homedir(), 'Library', 'Logs', 'sns-collaborator');
    const workingDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const target = `gui/${process.getuid()}`;
    return { nodeDir, logDir, workingDir, plistPath, target };
}

function plistFor(ctx) {
    return buildPlist({
        label: LABEL,
        nodeDir: ctx.nodeDir,
        npmPath: resolveNpmPath(ctx.nodeDir),
        workingDir: ctx.workingDir,
        logDir: ctx.logDir,
    });
}

function bootout(target) {
    try {
        execFileSync('launchctl', ['bootout', `${target}/${LABEL}`], { stdio: 'pipe' });
        return true;
    } catch {
        return false; // 未登録は想定内
    }
}

async function install() {
    const ctx = context();
    const xml = plistFor(ctx);
    await mkdir(ctx.logDir, { recursive: true });
    await mkdir(dirname(ctx.plistPath), { recursive: true });
    await writeFile(ctx.plistPath, xml);
    bootout(ctx.target);
    execFileSync('launchctl', ['bootstrap', ctx.target, ctx.plistPath], { stdio: 'inherit' });
    console.error(`登録しました: ${ctx.plistPath}`);
    console.error(`ログ: ${ctx.logDir}/out.log, err.log`);
}

async function uninstall() {
    const ctx = context();
    const was = bootout(ctx.target);
    await rm(ctx.plistPath, { force: true });
    console.error(was ? '登録を解除しました。' : '登録されていませんでした。');
    console.error(`削除: ${ctx.plistPath}`);
}

async function main(cmd) {
    switch (cmd) {
        case 'install':
            return install();
        case 'uninstall':
            return uninstall();
        case 'print':
            process.stdout.write(plistFor(context()));
            return;
        default:
            throw new Error('使い方: node scripts/launchd.js <install|uninstall|print>');
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv[2]).catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
    });
}
