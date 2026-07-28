import { saveSnapshot, loadSnapshotFallback } from '../_lib/kvSnapshot.js';

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders } });
}

// 跟etf-signal-winrate.js同樣的道理：樣本數太小時勝率沒有統計意義。
const MIN_SAMPLE_FOR_DISPLAY = 10;
const MAX_HOLDING_TRADING_DAYS = 20; // 跟worker-cron/src/index.js的AI_STRATEGY_MAX_HOLDING_DAYS一致

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.ELAN_QUANT_DB) {
    return json({ error: 'D1 database binding (ELAN_QUANT_DB) not found.' }, 500);
  }

  // 這份資料一天最多變一次（跟著worker-cron排程），做法比照etf-signal-winrate.js：固定
  // cacheKey，10分鐘內重複請求吃邊緣快取，不用每次都查D1。
  const cache = caches.default;
  const cacheKey = new Request('https://elan-quant-cache.internal/ai-strategy-winrate', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const decidedRow = await env.ELAN_QUANT_DB
      .prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) as wins
                 FROM ai_strategy_calls WHERE outcome IN ('win', 'loss')`)
      .first();
    const pendingRow = await env.ELAN_QUANT_DB
      .prepare(`SELECT COUNT(*) as total FROM ai_strategy_calls WHERE outcome IS NULL`)
      .first();
    const expiredRow = await env.ELAN_QUANT_DB
      .prepare(`SELECT COUNT(*) as total FROM ai_strategy_calls WHERE outcome = 'expired'`)
      .first();

    const decidedCount = decidedRow?.total || 0;
    const winCount = decidedRow?.wins || 0;

    const result = {
      decidedCount,
      winCount,
      lossCount: decidedCount - winCount,
      winRate: decidedCount > 0 ? Math.round((winCount / decidedCount) * 1000) / 10 : null,
      pendingCount: pendingRow?.total || 0,
      expiredCount: expiredRow?.total || 0,
      sufficientSample: decidedCount >= MIN_SAMPLE_FOR_DISPLAY,
      maxHoldingTradingDays: MAX_HOLDING_TRADING_DAYS,
    };

    context.waitUntil(saveSnapshot(env, 'ai-strategy-winrate', result));
    const response = json(result, 200, { 'Cache-Control': 'public, max-age=600' });
    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    const fallback = await loadSnapshotFallback(env, 'ai-strategy-winrate');
    if (fallback) return json(fallback);
    return json({ error: `查詢AI策略勝率失敗：${error.message}` }, 500);
  }
}
