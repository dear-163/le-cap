function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

// Workers跑在UTC，「今天」要換算成台北時區（跟worker-cron/src/index.js的todayDates()
// 同一套換算方式），才能當call_date跟stock_daily_price的日期比對得上。
function taipeiTodayDash() {
  const taipei = new Date(Date.now() + 8 * 3600 * 1000);
  const y = taipei.getUTCFullYear();
  const m = String(taipei.getUTCMonth() + 1).padStart(2, '0');
  const d = String(taipei.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isFiniteNum(v) {
  return typeof v === 'number' && isFinite(v);
}

// AI「深度技術判讀」在瀏覽器端（BYOK直連Gemini）算完進場/停損/停利後，順手記錄一筆到D1，
// 供worker-cron之後回頭比對每日高低價驗證勝率（見public/app.js的runTechAIStrategy跟
// worker-cron/src/index.js的resolveAiStrategyOutcomes）。只記真正的進場建議，entry_level
// 是CurrentPrice（僅供參考、非建議）的情況前端不會呼叫這支API。
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.ELAN_QUANT_DB) {
    return json({ error: 'D1 database binding (ELAN_QUANT_DB) not found.' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '請求格式不是合法的JSON' }, 400);
  }

  const { stockCode, entryLevel, entryPrice, stopLevel, stopPrice, targetLevel, targetPrice } = body || {};

  if (typeof stockCode !== 'string' || !/^[A-Za-z0-9.\-]{1,12}$/.test(stockCode)) {
    return json({ error: 'stockCode 格式不正確' }, 400);
  }
  if (typeof entryLevel !== 'string' || !entryLevel || entryLevel.length > 40) {
    return json({ error: 'entryLevel 格式不正確' }, 400);
  }
  if (typeof stopLevel !== 'string' || !stopLevel || stopLevel.length > 40) {
    return json({ error: 'stopLevel 格式不正確' }, 400);
  }
  if (typeof targetLevel !== 'string' || !targetLevel || targetLevel.length > 40) {
    return json({ error: 'targetLevel 格式不正確' }, 400);
  }
  if (!isFiniteNum(entryPrice) || !isFiniteNum(stopPrice) || !isFiniteNum(targetPrice)) {
    return json({ error: 'entryPrice/stopPrice/targetPrice 必須是有限數字' }, 400);
  }
  // 多方進場的基本邏輯順序：停損 < 進場 < 停利，跟public/app.js的long-only約束一致，
  // 順序不對代表前端算錯或被竄改，不寫入避免污染回測樣本。
  if (!(stopPrice < entryPrice && entryPrice < targetPrice)) {
    return json({ error: '價格順序不符合停損 < 進場 < 停利' }, 400);
  }

  const callDate = taipeiTodayDash();

  try {
    await env.ELAN_QUANT_DB
      .prepare(
        `INSERT OR IGNORE INTO ai_strategy_calls
         (stock_code, call_date, entry_level, entry_price, stop_level, stop_price, target_level, target_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(stockCode, callDate, entryLevel, entryPrice, stopLevel, stopPrice, targetLevel, targetPrice)
      .run();
    return json({ ok: true });
  } catch (error) {
    return json({ error: `記錄失敗：${error.message}` }, 500);
  }
}
