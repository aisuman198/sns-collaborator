// 実行専用の入口（dotenv・実依存の組み立て・起動・エラーの受け口）
import os from 'node:os';
import dotenv from 'dotenv';
import { Client } from 'discord.js';
import * as Misskey from 'misskey-js';
import { ConfigError } from './config.js';
import { createApp } from './create-app.js';
import { createLogger } from './logger.js';

const logger = createLogger();

// 環境変数のロード
dotenv.config();

async function main() {
    const app = createApp({
        env: process.env,
        homeDir: os.homedir(),
        logger,
        now: Date.now,
        fetchFn: fetch,
        setTimeoutFn: setTimeout,
        setIntervalFn: setInterval,
        createDiscordClient: (options) => new Client(options),
        createMisskeyClient: (options) => new Misskey.api.APIClient(options),
        uptimeMs: () => Math.round(process.uptime() * 1000),
        exit: (code) => process.exit(code),
    });
    await app.start();
}

main().catch((error) => {
    if (error instanceof ConfigError) {
        logger.error(error.message);
    } else {
        logger.error('起動に失敗しました:', error);
    }
    process.exitCode = 1;
});
