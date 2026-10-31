// 受信状況の統計カウンタ

export function createStats() {
    return {
        received: 0, // messageCreate 総数
        targetChannel: 0, // 対象チャンネルのメッセージ数
        botSkipped: 0, // 対象チャンネルのうち bot 発言で除外した数
        forwardSucceeded: 0,
        forwardFailed: 0,
        lastReceivedAt: null, // 最後に messageCreate を受けた時刻 (ms)
    };
}
