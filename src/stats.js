// 受信状況の統計カウンタ

export function createStats() {
    return {
        received: 0, // messageCreate 総数
        targetChannel: 0, // 対象チャンネルのメッセージ数
        botSkipped: 0, // 対象チャンネルのうち bot 発言で除外した数
        emptySkipped: 0, // 転送する本文が空でスキップした数
        forwardSucceeded: 0,
        forwardFailed: 0,
        niconicoFetchOk: 0, // ニコニコ動画の取得成功数
        niconicoFetchFailed: 0, // ニコニコ動画の取得失敗数
        niconicoAnnounced: 0, // 全宛先へ告知完了した動画数
        lastReceivedAt: null, // 最後に messageCreate を受けた時刻 (ms)
    };
}
