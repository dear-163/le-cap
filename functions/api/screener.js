// 首頁「RSI超賣/超買＋成交量暴增」篩選器。結果由worker-cron每天算好存進daily_screener_signals，
// 這裡只是單純讀最新一天的資料，不在請求當下對全市場重算RSI（那樣每次首頁載入都要算
// 1700+檔股票的RSI，太慢也太浪費）。超賣（潛在反彈）與超買（潛在過熱）用同一個date、
// 同一次查詢拆成兩組回傳，前端各自渲染成一張卡片裡的左右兩欄。
import { saveSnapshot, loadSnapshotFallback } from '../_lib/kvSnapshot.js';

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } });
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.ELAN_QUANT_DB) {
    return json({ error: 'D1 database binding (ELAN_QUANT_DB) not found.' }, 500);
  }

  const cache = caches.default;
  const cacheKey = new Request('https://elan-quant-cache.internal/screener', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const dateRow = await env.ELAN_QUANT_DB
      .prepare('SELECT MAX(date) as date FROM daily_screener_signals')
      .first();
    const latestDate = dateRow?.date || null;

    if (!latestDate) {
      const response = json({
        date: null,
        oversold: [],
        overbought: [],
        maturityMessage: '資料累積中，目前沒有符合條件的個股，或成交量歷史還沒累積滿5個交易日。',
      }, 200, { 'Cache-Control': 'public, max-age=600' });
      context.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }

    const { results } = await env.ELAN_QUANT_DB
      .prepare('SELECT code, name, rsi, volume_ratio, close, signal_type FROM daily_screener_signals WHERE date = ? ORDER BY volume_ratio DESC')
      .bind(latestDate)
      .all();

    const toSignal = r => ({ code: r.code, name: r.name, rsi: r.rsi, volumeRatio: r.volume_ratio, close: r.close });
    const rows = results || [];

    const payload = {
      date: latestDate,
      criteria: {
        oversold: 'RSI(14) < 30，且成交量 ≥ 前5個交易日均量的3倍（暴增200%以上）',
        overbought: 'RSI(14) > 70，且成交量 ≥ 前5個交易日均量的3倍（暴增200%以上）',
      },
      source: 'TWSE/TPEx 官方每日收盤資料（本站自行計算RSI與成交量倍數）',
      oversold: rows.filter(r => r.signal_type === 'oversold').map(toSignal),
      overbought: rows.filter(r => r.signal_type === 'overbought').map(toSignal),
    };
    context.waitUntil(saveSnapshot(env, 'screener', payload));
    const response = json(payload, 200, { 'Cache-Control': 'public, max-age=600' });
    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    const fallback = await loadSnapshotFallback(env, 'screener');
    if (fallback) return json(fallback);
    return json({ error: `查詢RSI超賣/超買＋成交量暴增篩選器失敗：${error.message}` }, 500);
  }
}
