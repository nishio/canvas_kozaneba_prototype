// 簡易サマライザのスタブ。LLM 接続があれば差し替え可能。
// 使い方: summarizeTextsLLM(texts) を呼ぶだけ。

export async function summarizeTextsLLM(texts: string[]): Promise<string> {
  // 1) 任意のバックエンドAPIがあればここで呼ぶ（例: /api/summarize）
  // ネットワークが使えない/未設定の場合は 2) にフォールバック
  try {
    if (typeof fetch !== 'undefined' && (globalThis as any).__USE_SUMMARY_API__) {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
      });
      if (res.ok) {
        const data = await res.json();
        if (typeof data?.summary === 'string') return data.summary;
      }
    }
  } catch { /* noop */ }

  // 2) フォールバック: シンプル要約（上位K文抽出 + キーワード）
  const joined = texts.join('\n');
  const sentences = joined.split(/[。.!?\n]+/).map(s => s.trim()).filter(Boolean);
  const top = sentences.slice(0, Math.min(3, sentences.length)).join('。') + (sentences.length > 3 ? '。…' : '');
  const keywords = topWords(texts, 8).join(', ');
  return `要旨: ${top}\nキーワード: ${keywords}`;
}

function topWords(texts: string[], k: number): string[] {
  const stop = new Set(['の','に','は','を','が','と','で','も','へ','や','から','まで','より','そして','しかし','また','です','ます','する','いる','ある','こと','ため','よう','これ','それ','あれ']);
  const freq = new Map<string, number>();
  const body = texts.join(' ').toLowerCase();
  const tokens = body.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  for (const t of tokens) {
    if (t.length <= 1) continue;
    if (stop.has(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  return [...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,k).map(([w])=>w);
}

