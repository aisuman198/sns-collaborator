// テスト実行時に preload (node --import) して、実ネットワークへの fetch を遮断する。
// テストが globalThis.fetch を差し替えて元に戻した場合も、この遮断版に戻る。
globalThis.fetch = async function blockedFetch(input) {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    throw new Error(`テストから実ネットワークへの fetch は禁止です: ${url}`);
};
