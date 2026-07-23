import { saveSnapshot, loadSnapshotFallback } from '../_lib/kvSnapshot.js';

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders } });
}

// 樣本數太小時勝率沒有統計意義（例如剛上線只有1、2筆），前端要能區分「還沒有足夠樣本」
// 跟「勝率就是這個數字」，不要讓使用者誤以為3戰3勝=100%勝率是穩定結論。
const MIN_SAMPLE_FOR_DISPLAY = 10;

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.ELAN_QUANT_DB) {
    return json({ error: 'D1 database binding (ELAN_QUANT_DB) not found.' }, 500);
  }

  // 這份資料一天最多變一次（跟著worker-cron的排程），先前用no-store代表首頁每次載入
  // 都重新查D1，前端還會用?t=時間戳記加重快取破壞——改成跟sentiment.js/screener.js
  // 同樣的做法：用固定的cacheKey（不理會前端?t=帶的隨機字串），10分鐘內重複請求直接
  // 吃邊緣快取，不用每次都查D1。
  const cache = caches.default;
  const cacheKey = new Request('https://elan-quant-cache.internal/etf-signal-winrate', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const evaluatedRow = await env.ELAN_QUANT_DB
      .prepare('SELECT COUNT(*) as total, SUM(win) as wins FROM etf_signal_outcomes WHERE win IS NOT NULL')
      .first();
    const pendingRow = await env.ELAN_QUANT_DB
      .prepare('SELECT COUNT(*) as total FROM etf_signal_outcomes WHERE win IS NULL')
      .first();

    const evaluatedCount = evaluatedRow?.total || 0;
    const winCount = evaluatedRow?.wins || 0;
    const pendingCount = pendingRow?.total || 0;

    const result = {
      evaluatedCount,
      winCount,
      winRate: evaluatedCount > 0 ? Math.round((winCount / evaluatedCount) * 1000) / 10 : null,
      pendingCount,
      sufficientSample: evaluatedCount >= MIN_SAMPLE_FOR_DISPLAY,
      forwardTradingDays: 5,
    };

    context.waitUntil(saveSnapshot(env, 'etf-signal-winrate', result));
    const response = json(result, 200, { 'Cache-Control': 'public, max-age=600' });
    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    const fallback = await loadSnapshotFallback(env, 'etf-signal-winrate');
    if (fallback) return json(fallback);
    return json({ error: `查詢ETF訊號勝率失敗：${error.message}` }, 500);
  }
}
