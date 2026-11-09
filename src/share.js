// twitter共有用チャンネルへの投稿（埋め込み + 「ツイートする」リンクボタン）の共通部品
export const TWEET_INTENT_URL = 'https://twitter.com/intent/tweet?text=';
export const MAX_BUTTON_URL_LENGTH = 512; // Discord のリンクボタン URL の上限

/**
 * ツイート投稿用の intent URL を作る。URL 全体（encode 後）が 512 文字以下になるよう切り詰める。
 * - 3 行以上: 最初の行と最後の行（URL）を残し、中間の行だけを末尾 … 付きで切り詰める
 * - 2 行以下: 本文の末尾側を切り詰める
 * 切り詰めはコードポイント単位（サロゲートペアを分断しない）。
 */
export function buildShareUrl(text) {
    const make = (body) => TWEET_INTENT_URL + encodeURIComponent(body);
    let url = make(text);
    if (url.length <= MAX_BUTTON_URL_LENGTH) return url;

    const lines = text.split('\n');
    if (lines.length >= 3) {
        const head = lines[0];
        const tail = lines[lines.length - 1];
        const chars = Array.from(lines.slice(1, -1).join('\n'));
        while (chars.length > 0) {
            chars.pop();
            url = make(`${head}\n${chars.join('')}…\n${tail}`);
            if (url.length <= MAX_BUTTON_URL_LENGTH) return url;
        }
        url = make(`${head}\n…\n${tail}`);
        if (url.length <= MAX_BUTTON_URL_LENGTH) return url;
    }
    // 2 行以下（または最初と最後の行だけで収まらない場合）は全体の末尾側を切り詰める
    const chars = Array.from(text);
    while (chars.length > 0) {
        chars.pop();
        url = make(`${chars.join('')}…`);
        if (url.length <= MAX_BUTTON_URL_LENGTH) return url;
    }
    return make('…');
}

/** twitter共有用チャンネルへ送る payload。content は空、本文は embed の description（切り詰めない）。 */
export function buildSharePayload(text) {
    return {
        content: '',
        embeds: [{ description: text }],
        components: [
            {
                type: 1,
                components: [{ type: 2, style: 5, label: 'ツイートする', url: buildShareUrl(text) }],
            },
        ],
        allowedMentions: { parse: [] },
    };
}

/** チャンネルを取得して共有 payload を送る。取得・送信できなければ例外を投げる。 */
export async function sendShare(discordClient, channelId, text) {
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel || typeof channel.send !== 'function') {
        throw new Error(`Discord チャンネルに送信できません: id=${channelId}`);
    }
    await channel.send(buildSharePayload(text));
}
