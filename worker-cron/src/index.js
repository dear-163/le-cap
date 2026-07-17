// 每個交易日執行一次：抓 TWSE 官方資料，寫進 D1 的 daily_market_data / stock_daily_price /
// holder_weekly_snapshot，供 functions/api/sentiment.js 與 functions/api/chip.js 讀取。
// 任何一步失敗都要 console.error 完整錯誤內容並繼續跑下一步——不吞錯誤、不用假數字填當天資料。
const BROWSER_HEADERS = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; ElanQuantCron/1.0)' };
const STOCK_HISTORY_MIN_DAYS = 200; // 個股要先累積這麼多天資料，「創新高/新低」判斷才有意義，避免剛開始追蹤就全部被判定為新高
const ROLLING_WINDOW_CALENDAR_DAYS = 380; // 52週(252個交易日)大約對應的日曆天數，含假日緩衝
// TWSE 的端點被實測證實會「靜默」回傳錯誤資料（stat 顯示 OK、格式正常，但數字是錯的——
// 例如假日期間查詢卻拿到一筆看似正常的假資料）。這不是拋錯，retry 抓不到，只能靠合理性檢查擋。
// 加權指數單日漲跌超過這個比例在真實交易中幾乎不可能發生，用來擋掉這類異常值。
const MAX_TAIEX_DAILY_CHANGE_RATIO = 0.15;

function todayDates() {
  // 用 UTC+8 換算「今天」的日期與現在時刻（台北時區）。
  const now = new Date();
  const taipei = new Date(now.getTime() + 8 * 3600 * 1000);
  const y = taipei.getUTCFullYear();
  const m = String(taipei.getUTCMonth() + 1).padStart(2, '0');
  const d = String(taipei.getUTCDate()).padStart(2, '0');
  const hh = String(taipei.getUTCHours()).padStart(2, '0');
  const mm = String(taipei.getUTCMinutes()).padStart(2, '0');
  return { ad: `${y}${m}${d}`, roc: `${y - 1911}${m}${d}`, dash: `${y}-${m}-${d}`, nowHHMM: `${hh}:${mm}`, dow: taipei.getUTCDay() };
}
function daysAgoAd(days) {
  const d = new Date(Date.now() - days * 86400000);
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
function parseNum(v) {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isFinite(n) ? n : null;
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 把每個排程步驟最近一次的執行結果寫進cron_diagnostics，讓「這個步驟現在是不是壞的」
// 變成一句SQL就能查，不用依賴wrangler tail即時監看log（公債殖利率那個步驟連續252天
// 失敗都沒人發現，就是因為失敗訊息只印在log裡，沒人即時盯著）。error傳null代表這次成功。
async function logStep(db, step, nowHHMM, error) {
  try {
    if (error) {
      await db.prepare(`
        INSERT INTO cron_diagnostics (step, last_run_at, last_error) VALUES (?, ?, ?)
        ON CONFLICT(step) DO UPDATE SET last_run_at = excluded.last_run_at, last_error = excluded.last_error
      `).bind(step, nowHHMM, error).run();
    } else {
      await db.prepare(`
        INSERT INTO cron_diagnostics (step, last_run_at, last_success_at, last_error) VALUES (?, ?, ?, NULL)
        ON CONFLICT(step) DO UPDATE SET last_run_at = excluded.last_run_at, last_success_at = excluded.last_success_at, last_error = NULL
      `).bind(step, nowHHMM, nowHHMM).run();
    }
  } catch (e) {
    // 診斷表本身寫失敗不該影響主要排程邏輯，只印log。
    console.error(`[cron] 寫入cron_diagnostics失敗（step=${step}）：`, e.message);
  }
}

async function fetchTaiexClose(rocDate) {
  const res = await fetch('https://openapi.twse.com.tw/v1/indicesReport/MI_5MINS_HIST', { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`MI_5MINS_HIST HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('MI_5MINS_HIST 回應為空');
  const row = arr.find(r => r.Date === rocDate) || arr[arr.length - 1];
  const close = parseNum(row.ClosingIndex);
  if (close == null) throw new Error(`MI_5MINS_HIST 無法解析 ClosingIndex：${JSON.stringify(row)}`);
  return close;
}

async function fetchAdvanceDecline() {
  const res = await fetch('https://openapi.twse.com.tw/v1/opendata/twtazu_od', { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`twtazu_od HTTP ${res.status}`);
  const arr = await res.json();
  const row = Array.isArray(arr) ? (arr.find(r => (r['類型'] || '').includes('整體')) || arr[0]) : null;
  if (!row) throw new Error('twtazu_od 回應為空或格式異常');
  const advancers = parseInt(row['上漲'], 10), decliners = parseInt(row['下跌'], 10);
  if (!isFinite(advancers) || !isFinite(decliners)) throw new Error(`twtazu_od 無法解析上漲/下跌欄位：${JSON.stringify(row)}`);
  return { advancers, decliners };
}

async function fetchMarginTotal() {
  const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN', { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`MI_MARGN HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr)) throw new Error('MI_MARGN 回應格式不是陣列');
  let total = 0, count = 0;
  for (const row of arr) {
    const v = parseNum(row['融資今日餘額']);
    if (v != null) { total += v; count++; }
  }
  if (count === 0) throw new Error('MI_MARGN 沒有任何可解析的融資今日餘額數值');
  return total;
}

// NOTE: this legacy www.twse.com.tw endpoint wants AD date format (YYYYMMDD), unlike the
// openapi.twse.com.tw endpoints elsewhere in this file which use ROC dates — verified by testing.
//
// This endpoint is also empirically flaky: back-to-back requests with the IDENTICAL date param
// have been observed to fail once with a garbled "stat" message and then succeed immediately
// after, with no other change. Since the cron only gets one shot at "today" per day (there's no
// fallback date to shift to, unlike functions/api/chip.js's multi-day loop), a transient failure
// here retries a few times before giving up and leaving the day's count as NULL.
async function fetchInstitutionalCounts(adDate, retries = 3) {
  const url = `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${adDate}&selectType=ALL`;
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      if (!res.ok) { lastError = new Error(`T86 HTTP ${res.status}`); continue; }
      const body = await res.json();
      if (!body || body.stat !== 'OK' || !Array.isArray(body.data)) {
        lastError = new Error(`T86 stat=${body?.stat}（可能是非交易日/假日，或此端點暫時性異常，已重試 ${attempt} 次）`);
        if (attempt < retries) await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      const idx = body.fields.indexOf('三大法人買賣超股數');
      if (idx === -1) throw new Error(`T86 欄位不含「三大法人買賣超股數」，實際欄位：${body.fields.join('、')}`);
      let buyCount = 0, sellCount = 0;
      for (const row of body.data) {
        const v = parseNum(row[idx]);
        if (v == null) continue;
        if (v > 0) buyCount++; else if (v < 0) sellCount++;
      }
      return { buyCount, sellCount };
    } catch (e) {
      lastError = e;
      break; // schema mismatch / thrown errors are not the flaky-response case — don't retry those
    }
  }
  throw lastError;
}

// 台指選擇權 Put/Call 成交量比（%）——CNN Fear & Greed 7 因子之一，官方 TAIFEX OpenAPI，
// 不用 cookie/登入。回應依日期新到舊排序，取第一筆即為最新一個交易日。
async function fetchPutCallRatio() {
  const res = await fetch('https://openapi.taifex.com.tw/v1/PutCallRatio', { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`TAIFEX PutCallRatio HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('TAIFEX PutCallRatio 回應不是陣列或是空的');
  const ratio = parseNum(arr[0]['PutCallVolumeRatio%']);
  if (ratio == null) throw new Error('TAIFEX PutCallRatio 缺少 PutCallVolumeRatio% 欄位');
  return ratio;
}

// 臺指選擇權波動率指數（VIXTWN，台版VIX）——CNN 7 因子之一。TAIFEX 只提供「當天這個檔案」的
// 逐筆(15秒)資料下載，沒有匯總API，所以要抓當天的檔案、取最後一列「Last 1 min AVG」當收盤值。
// 檔案是 Big5 編碼，但我們只需要抓最後一個數字欄位，不需要真的把中文表頭轉碼。
// 實測發現當天檔案不一定馬上就緒（要求還沒產生的日期會回傳一般HTML頁面，不是純文字資料），
// 所以從今天往前逐日掃描最多5天，抓到第一個能解析出數值的檔案就用那天的資料
// （跟 fetchCathayHoldings 找「已結算日期」用的是同一種寫法）。
async function fetchVixTwn(todayAd) {
  const y = parseInt(todayAd.slice(0, 4), 10), m = parseInt(todayAd.slice(4, 6), 10) - 1, d = parseInt(todayAd.slice(6, 8), 10);
  const base = Date.UTC(y, m, d);
  for (let daysBack = 0; daysBack <= 5; daysBack++) {
    const dt = new Date(base - daysBack * 86400000);
    const dateStr = `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`;
    const res = await fetch(`https://www.taifex.com.tw/cht/7/getVixData?filesname=${dateStr}`, { headers: BROWSER_HEADERS });
    if (!res.ok) continue;
    const text = await res.text();
    const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const lastLine = lines[lines.length - 1];
    const parts = lastLine.split(/\s+/).filter(Boolean);
    const val = parseNum(parts[parts.length - 1]);
    if (val != null) return val;
  }
  throw new Error(`TAIFEX VIXTWN 從 ${todayAd} 往前5天都抓不到有效檔案`);
}

// 10年期公債殖利率 + 公司債BBB-AAA信用利差——CNN「避險需求」跟「垃圾債券需求」因子的台股
// 替代資料，同一個 TPEx 端點一次拿到兩個值，不用cookie/登入。
async function fetchBondCurve() {
  // cache:'no-store' — 這個端點連續252天在正式環境0/252成功、但本機測試每次都成功，
  // 為了排除「Cloudflare邊緣快取到一次失敗回應、之後一直命中同一個壞掉的快取」這個可能性
  // （這個URL沒有像其他fetch一樣帶時間戳記做cache-busting），加上明確不快取。
  const res = await fetch('https://www.tpex.org.tw/data/bond/bondCurve.json', { headers: BROWSER_HEADERS, cache: 'no-store' });
  if (!res.ok) throw new Error(`TPEx bondCurve HTTP ${res.status}`);
  const j = await res.json();
  const govRows = j?.bondCruve?.data;
  if (!Array.isArray(govRows)) throw new Error('TPEx bondCurve 回應格式跟預期不符（找不到 bondCruve.data）');
  const gov10y = govRows.find(r => r.time === 10)?.index;
  if (gov10y == null) throw new Error('TPEx bondCurve 找不到10年期公債殖利率（time=10）');

  const coRows = j?.bondCoCurve?.data;
  if (!Array.isArray(coRows) || coRows.length === 0) throw new Error('TPEx bondCurve 回應格式跟預期不符（找不到 bondCoCurve.data）');
  // 取最長天期（陣列最後一筆，通常是10年期）代表長天期信用利差，跟公債殖利率的天期對齊。
  const longest = coRows[coRows.length - 1];
  if (longest.twBBB == null || longest.twAAA == null) throw new Error('TPEx bondCurve 公司債利差缺少 twBBB/twAAA 欄位');
  const spread = (longest.twBBB - longest.twAAA) * 100; // 原始是小數（如0.0069代表0.69個百分點），換算成百分點

  return { gov10y, spread };
}

async function fetchStockDayAll() {
  const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`STOCK_DAY_ALL HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr)) throw new Error('STOCK_DAY_ALL 回應格式不是陣列');
  return arr;
}

async function fetchTpexStockDayAll() {
  try {
    const res = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', { headers: BROWSER_HEADERS });
    if (!res.ok) {
      console.error(`TPEx OpenAPI HTTP ${res.status}`);
      return [];
    }
    const arr = await res.json();
    if (!Array.isArray(arr)) {
      console.error('TPEx OpenAPI Response is not an array');
      return [];
    }
    return arr.map(r => ({
      Code: (r.SecuritiesCompanyCode || '').trim(),
      Name: (r.CompanyName || '').trim(),
      ClosingPrice: r.Close,
      HighestPrice: r.High,
      LowestPrice: r.Low,
      TradeVolume: r.TradingShares, // TPEx欄位叫TradingShares，正規化成跟TWSE一樣的TradeVolume名稱
    }));
  } catch (e) {
    console.error('Failed to fetch TPEx prices:', e.message);
    return [];
  }
}

async function batchRun(db, statements, chunkSize = 50) {
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize));
  }
}

// 回傳 null 代表沒有前一筆可比對（例如第一天），此時無法做合理性檢查，直接放行。
async function fetchPreviousTaiexClose(db, beforeDate) {
  const row = await db
    .prepare('SELECT taiex_close FROM daily_market_data WHERE date < ? AND taiex_close IS NOT NULL ORDER BY date DESC LIMIT 1')
    .bind(beforeDate)
    .first();
  return row ? row.taiex_close : null;
}

// 更新 stock_daily_price 並統計今日創52週新高/新低家數。
// 個股要先累積 STOCK_HISTORY_MIN_DAYS 天資料才會被納入新高/新低判斷，避免剛開始追蹤的股票都被誤判成「新高」。
async function updateStockPricesAndCountNewHighLow(db, todayAd, stockRows) {
  const cutoff = daysAgoAd(ROLLING_WINDOW_CALENDAR_DAYS);
  const { results: priorRanges } = await db
    .prepare('SELECT code, COUNT(*) as days, MAX(high) as max_high, MIN(low) as min_low FROM stock_daily_price WHERE date >= ? GROUP BY code')
    .bind(cutoff)
    .all();
  const priorMap = new Map((priorRanges || []).map(r => [r.code, r]));

  let newHighs = 0, newLows = 0;
  const upserts = [];
  for (const row of stockRows) {
    const code = (row.Code || '').trim();
    if (!code) continue;
    const close = parseNum(row.ClosingPrice), high = parseNum(row.HighestPrice), low = parseNum(row.LowestPrice);
    if (close == null) continue;
    const name = (row.Name || '').trim() || null;
    const volume = parseNum(row.TradeVolume);
    const prior = priorMap.get(code);
    if (prior && prior.days >= STOCK_HISTORY_MIN_DAYS) {
      if (high != null && prior.max_high != null && high > prior.max_high) newHighs++;
      if (low != null && prior.min_low != null && low < prior.min_low) newLows++;
    }
    upserts.push(
      db.prepare('INSERT OR REPLACE INTO stock_daily_price (code, date, close, high, low, name, volume) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(code, todayAd, close, high, low, name, volume)
    );
  }
  await batchRun(db, upserts);
  return { newHighs, newLows };
}

// 首頁「RSI超賣/超買+成交量暴增」篩選器。跟52週新高低用同一張stock_daily_price，但只需要近35個
// 日曆天（RSI-14要15筆收盤價，加上5日均量門檻，35天日曆天緩衝綽綽有餘，遠小於52週新高低
// 用的380天窗口，這裡故意不共用那個大查詢，避免抓一堆用不到的資料）。RSI公式跟
// public/app.js的calcRSI用同一套Wilder's smoothing，確保這裡篩出的RSI跟使用者自己點進
// 個股技術分析頁看到的數字一致。
// 超賣（潛在反彈訊號）與超買（潛在過熱訊號）共用同一次全市場掃描與同一套成交量暴增門檻，
// 只是RSI的判斷方向相反——同一檔股票同一天不可能兩邊都中，用signal_type區分即可，
// 不需要為超買另外再查一次stock_daily_price（省一次D1查詢）。
const SCREENER_WINDOW_CALENDAR_DAYS = 35;
const SCREENER_RSI_PERIOD = 14;
const SCREENER_VOLUME_BASELINE_DAYS = 5;
const SCREENER_RSI_OVERSOLD_THRESHOLD = 30;
const SCREENER_RSI_OVERBOUGHT_THRESHOLD = 70;
const SCREENER_VOLUME_RATIO_THRESHOLD = 3; // 今日量 ≥ 前5日均量的3倍，即「暴增200%」（多了200%＝變成3倍）

async function computeScreenerSignals(db, todayAd) {
  const cutoff = daysAgoAd(SCREENER_WINDOW_CALENDAR_DAYS);
  const { results } = await db
    .prepare('SELECT code, date, close, volume FROM stock_daily_price WHERE date >= ? ORDER BY code, date ASC')
    .bind(cutoff)
    .all();

  const byCode = new Map();
  for (const r of (results || [])) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }

  const { results: nameRows } = await db
    .prepare('SELECT code, name FROM stock_daily_price WHERE date = ?')
    .bind(todayAd)
    .all();
  const nameMap = new Map((nameRows || []).map(r => [r.code, r.name]));

  const signals = [];
  for (const [code, rows] of byCode) {
    const last = rows[rows.length - 1];
    if (!last || last.date !== todayAd) continue; // 今天沒資料（停牌/爬蟲缺漏）不列入

    const closes = rows.map(r => r.close).filter(c => c != null);
    if (closes.length < SCREENER_RSI_PERIOD + 1) continue;

    const gains = [], losses = [];
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      gains.push(d > 0 ? d : 0);
      losses.push(d < 0 ? -d : 0);
    }
    let avgGain = null, avgLoss = null;
    for (let i = 0; i < gains.length; i++) {
      if (i < SCREENER_RSI_PERIOD - 1) continue;
      if (avgGain == null) {
        avgGain = gains.slice(0, SCREENER_RSI_PERIOD).reduce((s, v) => s + v, 0) / SCREENER_RSI_PERIOD;
        avgLoss = losses.slice(0, SCREENER_RSI_PERIOD).reduce((s, v) => s + v, 0) / SCREENER_RSI_PERIOD;
      } else {
        avgGain = (avgGain * (SCREENER_RSI_PERIOD - 1) + gains[i]) / SCREENER_RSI_PERIOD;
        avgLoss = (avgLoss * (SCREENER_RSI_PERIOD - 1) + losses[i]) / SCREENER_RSI_PERIOD;
      }
    }
    if (avgGain == null) continue;
    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    let signalType;
    if (rsi < SCREENER_RSI_OVERSOLD_THRESHOLD) signalType = 'oversold';
    else if (rsi > SCREENER_RSI_OVERBOUGHT_THRESHOLD) signalType = 'overbought';
    else continue; // RSI在中性區間，兩邊都不算

    if (last.volume == null) continue;
    const priorVolRows = rows.slice(0, -1).filter(r => r.volume != null).slice(-SCREENER_VOLUME_BASELINE_DAYS);
    if (priorVolRows.length < SCREENER_VOLUME_BASELINE_DAYS) continue; // volume欄位剛加，前幾天還沒累積夠不硬湊
    const avgVol = priorVolRows.reduce((s, r) => s + r.volume, 0) / priorVolRows.length;
    if (!(avgVol > 0)) continue;
    const volumeRatio = last.volume / avgVol;
    if (volumeRatio < SCREENER_VOLUME_RATIO_THRESHOLD) continue;

    signals.push({ code, name: nameMap.get(code) || code, rsi, volumeRatio, close: last.close, signalType });
  }

  if (signals.length > 0) {
    const upserts = signals.map(s =>
      db.prepare('INSERT OR REPLACE INTO daily_screener_signals (date, code, name, rsi, volume_ratio, close, signal_type) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(todayAd, s.code, s.name, s.rsi, s.volumeRatio, s.close, s.signalType)
    );
    await batchRun(db, upserts);
  }
  const oversoldCount = signals.filter(s => s.signalType === 'oversold').length;
  const overboughtCount = signals.filter(s => s.signalType === 'overbought').length;
  return { count: signals.length, oversoldCount, overboughtCount };
}

async function updateHolderSnapshotIfNewWeek(db) {
  const res = await fetch('https://opendata.tdcc.com.tw/getOD.ashx?id=1-5', { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`TDCC HTTP ${res.status}`);
  const text = await res.text();

  // 實測這份CSV約6.8萬行、2.2MB，但TDCC一週只更新一次，平日6/7天都是同一週的舊資料——
  // 原本不管是不是同一週，每天都先把整份text.split('\n')成6.8萬個字串的陣列，才去判斷
  // 要不要跳過，等於白白對6.8萬行做一次CPU工作。改成先只切出前兩行（表頭+第一筆資料，
  // 用indexOf找換行位置、不用split全部）判斷日期，同一週就直接return，完全不碰後面
  // 6.8萬行；只有真的遇到新一週的資料才需要split全部、逐行解析。
  const firstNewline = text.indexOf('\n');
  if (firstNewline === -1) throw new Error('TDCC 回應內容為空或格式異常');
  const secondNewline = text.indexOf('\n', firstNewline + 1);
  const headers = text.slice(0, firstNewline).replace(/^﻿/, '').split(',').map(h => h.trim());
  const idx = { date: headers.indexOf('資料日期'), code: headers.indexOf('證券代號'), level: headers.indexOf('持股分級'), pct: headers.indexOf('占集保庫存數比例%') };
  if (Object.values(idx).some(i => i === -1)) throw new Error(`TDCC CSV 欄位與預期不符：${headers.join('、')}`);

  const firstDataLine = text.slice(firstNewline + 1, secondNewline === -1 ? undefined : secondNewline);
  const tdccDate = firstDataLine.split(',')[idx.date]?.trim();
  if (!tdccDate) throw new Error('TDCC 無法解析資料日期');

  const latest = await db.prepare('SELECT date FROM holder_weekly_snapshot ORDER BY date DESC LIMIT 1').first();
  if (latest && latest.date === tdccDate) {
    return { skipped: true, date: tdccDate };
  }

  // 確定是新的一週才切開全部6.8萬行逐行解析。
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('TDCC 回應內容為空');
  const perCode = new Map(); // code -> { big, mid }
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const code = cols[idx.code]?.trim();
    if (!code) continue;
    const level = parseInt(cols[idx.level], 10);
    const pct = parseFloat(cols[idx.pct]);
    if (!isFinite(pct)) continue;
    const entry = perCode.get(code) || { big: null, mid: 0 };
    if (level === 15) entry.big = pct;
    else if (level === 12 || level === 13 || level === 14) entry.mid += pct;
    perCode.set(code, entry);
  }
  const upserts = [];
  for (const [code, v] of perCode) {
    upserts.push(
      db.prepare('INSERT OR REPLACE INTO holder_weekly_snapshot (code, date, big_holder_pct, mid_holder_pct) VALUES (?, ?, ?, ?)')
        .bind(code, tdccDate, v.big, v.mid)
    );
  }
  await batchRun(db, upserts);
  return { skipped: false, date: tdccDate, stockCount: perCode.size };
}

// ezmoney.com.tw（統一投信官網）對第一次沒帶到反爬蟲 cookie 的請求，永遠回傳 302 重新導向
// 回同一個網址、並在 Set-Cookie 帶一組 __nxquid——實測用這組 cookie 重打一次就能拿到完整內容，
// 不需要更複雜的挑戰。頁面裡完整持股是用 HTML-escape 包住的一段 JSON 陣列（Nuxt SSR 資料），
// 每檔股票是 AssetCode==="ST" 的紀錄，直接帶官方算好的 Share／Amount(市值)／NavRate(權重%)。
async function fetchEzmoneyHoldings(fundCode) {
  const url = `https://www.ezmoney.com.tw/ETF/Fund/Info?fundCode=${fundCode}`;
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  const primeRes = await fetch(url, { headers, redirect: 'manual' });
  const setCookie = primeRes.headers.get('set-cookie');
  if (!setCookie) throw new Error('ezmoney 首次請求未回傳 cookie，網站防爬機制可能已變更');
  const cookie = setCookie.split(';')[0];

  const res = await fetch(url, { headers: { ...headers, 'Cookie': cookie } });
  if (!res.ok) throw new Error(`ezmoney HTTP ${res.status}`);
  const html = await res.text();

  const marker = '&quot;DetailCode&quot;';
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) throw new Error('ezmoney 頁面內找不到持股明細區塊（版面可能已變更）');
  const start = html.lastIndexOf('[', markerIdx);
  let depth = 0, end = -1;
  for (let i = start; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (start === -1 || end === -1) throw new Error('ezmoney 持股 JSON 陣列括號不成對，解析失敗');

  const unescaped = html.slice(start, end)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  const data = JSON.parse(unescaped);
  return data
    .filter(r => r.AssetCode === 'ST' && r.DetailCode)
    .map(r => ({ stockCode: r.DetailCode, stockName: r.DetailName, shares: r.Share, weight: r.NavRate }));
}

// 野村投信官網（Angular SPA）背後直接打的 JSON API，不用解析 HTML。
async function fetchNomuraHoldings(fundId) {
  const res = await fetch('https://www.nomurafunds.com.tw/API/ETFAPI/api/Fund/GetFundAssets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': `https://www.nomurafunds.com.tw/ETFWEB/product-description?fundNo=${fundId}`,
    },
    body: JSON.stringify({ FundID: fundId, SearchDate: null }),
  });
  if (!res.ok) throw new Error(`野村投信 API HTTP ${res.status}`);
  const apiRes = await res.json();
  const table = (apiRes?.Entries?.Data?.Table || []).find(t => t.TableTitle === '股票');
  if (!table || !Array.isArray(table.Rows)) throw new Error('野村投信 API 回應格式跟預期不符（找不到股票表格）');
  return table.Rows.map(row => ({
    stockCode: row[0],
    stockName: row[1],
    shares: parseFloat(String(row[2]).replace(/,/g, '')),
    weight: parseFloat(row[3]),
  }));
}

// 解碼 HTML entity（十六進位/十進位數字實體 + 常見具名實體），Workers 環境沒有 DOM 可用。
function decodeHtmlEntities(s) {
  return s
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// 凱基投信官網：伺服器端直接渲染，完整持股表格（含隱藏的「顯示更多」列）已經在原始 HTML
// 裡，不用額外打 API。頁面裡這個表格出現兩次（桌面版+隱藏的行動版），只取第一次出現的區塊，
// 否則會算兩倍。
async function fetchKgifundHoldings(fundId) {
  const res = await fetch(`https://www.kgifund.com.tw/Fund/Detail?fundID=${fundId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error(`凱基投信 HTTP ${res.status}`);
  const html = await res.text();
  const marker = 'js-table-a-0';
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) throw new Error('凱基投信頁面內找不到持股表格（版面可能已變更）');
  const tableStart = html.lastIndexOf('<table', markerIdx);
  const tableEnd = html.indexOf('</table>', markerIdx) + '</table>'.length;
  const tableHtml = html.slice(tableStart, tableEnd);
  const rows = [...tableHtml.matchAll(/<tr name="content"[^>]*>([\s\S]*?)<\/tr>/g)];
  return rows.map(m => {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => decodeHtmlEntities(c[1].replace(/<[^>]+>/g, '')).trim());
    return { stockCode: cells[0], stockName: cells[1], shares: parseFloat(cells[2].replace(/,/g, '')), weight: parseFloat(cells[3]) };
  }).filter(h => /^\d{4,6}$/.test(h.stockCode));
}

// 富邦投信旗下 ETF 微站（fsit.com.tw），純伺服器渲染 HTML，不用 cookie、不用登入。
async function fetchFubonHoldings(ticker) {
  const res = await fetch(`https://websys.fsit.com.tw/FubonETF/Fund/Assets.aspx?stkId=${ticker}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error(`富邦投信 HTTP ${res.status}`);
  const html = await res.text();
  const rows = [...html.matchAll(/<tr>\s*<td class="tac">(\d{4,6})<\/td>\s*<td>([^<]+)<\/td>\s*<td class="tac">([\d,]+)<\/td>\s*<td class="tac">[\d,]+<\/td>\s*<td class="tac">([\d.]+)<\/td>\s*<\/tr>/g)];
  if (rows.length === 0) throw new Error('富邦投信頁面內找不到持股表格（版面可能已變更）');
  return rows.map(m => ({ stockCode: m[1], stockName: m[2].trim(), shares: parseFloat(m[3].replace(/,/g, '')), weight: parseFloat(m[4]) }));
}

// 安聯投信（etf.allianzgi.com.tw）背後是共用的白牌 ETF 平台，需要三步：
// 1) 拿 XSRF token/cookie 2) （已知 fundNo 對照表，不用每次查）3) 帶 token 打 GetFundAssets。
async function fetchAllianzHoldings(fundNo) {
  const tokenRes = await fetch('https://etf.allianzgi.com.tw/webapi/api/AntiForgery/GetAntiForgeryToken', {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  if (!tokenRes.ok) throw new Error(`安聯投信 token HTTP ${tokenRes.status}`);
  const setCookie = tokenRes.headers.get('set-cookie');
  const tokenJson = await tokenRes.json();
  const xsrfToken = tokenJson.token;
  if (!xsrfToken || !setCookie) throw new Error('安聯投信未回傳 XSRF token 或 cookie');
  // Workers 的 fetch 對多個 Set-Cookie 只會合併成一行，直接整段轉發即可（不用逐一解析各自的 cookie 名稱）。
  const cookie = setCookie.split(',').map(c => c.split(';')[0].trim()).join('; ');

  const res = await fetch('https://etf.allianzgi.com.tw/webapi/api/Fund/GetFundAssets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'Accept': 'application/json',
      'X-XSRF-TOKEN': xsrfToken, 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0',
      'Referer': `https://etf.allianzgi.com.tw/etf-info/${fundNo}?tab=4`,
    },
    body: JSON.stringify({ FundID: fundNo, SearchDate: null }),
  });
  if (!res.ok) throw new Error(`安聯投信 API HTTP ${res.status}`);
  const apiRes = await res.json();
  const table = (apiRes?.Entries?.Data?.Table || []).find(t => (t.TableTitle || '').includes('股票'));
  if (!table || !Array.isArray(table.Rows)) throw new Error('安聯投信 API 回應格式跟預期不符（找不到股票表格）');
  // Rows 是 [序號, 代號, 名稱, 股數, 權重%]，比野村/凱基多一欄序號。
  return table.Rows.map(row => ({
    stockCode: row[1], stockName: row[2],
    shares: parseFloat(String(row[3]).replace(/,/g, '')), weight: parseFloat(row[4]),
  })).filter(h => h.stockCode);
}

// 台新投信：純伺服器渲染 HTML，不用 cookie/登入。股票代號可能帶交易所後綴（如「2330 TT」
// 台股、「GOOGL US」美股——這是跨市場配置的基金），只有純台股代號能對到我們自己
// stock_daily_price 的收盤價，外國代號會誠實顯示「金額暫無資料」，不用特別處理。
async function fetchTaishinHoldings(ticker) {
  const res = await fetch(`https://www.tsit.com.tw/ETF/Home/ETFSeriesDetail/${ticker}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error(`台新投信 HTTP ${res.status}`);
  const html = await res.text();
  const marker = '股票合計';
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) throw new Error('台新投信頁面內找不到持股表格（版面可能已變更）');
  const tableStart = html.lastIndexOf('<table', markerIdx);
  const tableEnd = html.indexOf('</table>', markerIdx) + '</table>'.length;
  const tableHtml = html.slice(tableStart, tableEnd);
  const rows = [...tableHtml.matchAll(/<tr>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<\/tr>/g)];
  return rows
    .map(m => ({ rawCode: m[1].trim(), stockName: m[2].trim(), shares: parseFloat(m[3].replace(/,/g, '')), weight: parseFloat(m[4]) }))
    .filter(h => !h.rawCode.includes('合計'))
    .map(h => {
      const twMatch = h.rawCode.match(/^(\d{4,6})\s*TT$/i);
      return { stockCode: twMatch ? twMatch[1] : h.rawCode, stockName: h.stockName, shares: h.shares, weight: h.weight };
    });
}

// 聯博投信（全球共用平台 webapi.alliancebernstein.com），乾淨的公開 JSON API，不用任何
// header/cookie。domesticHoldings 底下分好幾個區塊（股票／期貨／選擇權等），只保留代號是
// 純數字（真台股代號）或含交易所後綴的股票列，期貨/選擇權沒有 holdingCode 會被濾掉。
async function fetchAllianceBernsteinHoldings(shareClassId) {
  const res = await fetch(`https://webapi.alliancebernstein.com/v2/funds/tw/zh-tw/investor/${shareClassId}/holdings`);
  if (!res.ok) throw new Error(`聯博投信 API HTTP ${res.status}`);
  const j = await res.json();
  const sections = j?.domesticHoldings || [];
  const out = [];
  for (const section of sections) {
    for (const h of (section.holdings || [])) {
      if (!h.holdingCode) continue;
      out.push({ stockCode: h.holdingCode, stockName: h.holding, shares: h.holdingShares, weight: parseFloat(h.holdingPerc) });
    }
  }
  return out;
}

// 中國信託投信（ctbcinvestments.com.tw）擋在 Imperva Incapsula 反爬蟲後面，但只要 cookie
// 帶對就不用登入。三步：1) 隨便一個 ETF 頁面拿 Incapsula cookie 2) 用該 cookie 換一次性
// token 3) 帶 cookie+token 打完整持股 API。FID（如 E0038）是內部代碼，跟公開股票代號不同。
async function fetchCtbcHoldings(fid) {
  const cno = '00682450'; // 任何一檔上市 ETF 的頁面都能拿到 Incapsula cookie，不用對應到這檔基金本身
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  const referer = `https://www.ctbcinvestments.com.tw/Etf/${cno}/Info`;

  const primeRes = await fetch(referer, { headers });
  const cookies = [];
  const primeCookie = primeRes.headers.get('set-cookie');
  if (primeCookie) cookies.push(...primeCookie.split(',').map(c => c.split(';')[0].trim()));
  if (cookies.length === 0) throw new Error('中信投信首次請求未回傳 Incapsula cookie，防爬機制可能已變更');

  const tokenRes = await fetch('https://www.ctbcinvestments.com.tw/API/home/AuthToken?token=www.ctbcinvestments.com', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Referer': referer, 'Origin': 'https://www.ctbcinvestments.com.tw', 'Cookie': cookies.join('; ') },
    body: '{}',
  });
  if (!tokenRes.ok) throw new Error(`中信投信 token HTTP ${tokenRes.status}`);
  const tokenCookie = tokenRes.headers.get('set-cookie');
  if (tokenCookie) cookies.push(...tokenCookie.split(',').map(c => c.split(';')[0].trim()));
  const tokenJson = await tokenRes.json();
  const token = tokenJson?.Data?.token;
  if (!token) throw new Error('中信投信未回傳 auth token');

  const todayIso = new Date().toISOString().slice(0, 10);
  const res = await fetch(`https://www.ctbcinvestments.com.tw/API/etf/ETFHoldingWeight?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Referer': referer, 'Origin': 'https://www.ctbcinvestments.com.tw', 'Cookie': cookies.join('; ') },
    body: JSON.stringify({ FID: fid, StartDate: todayIso }),
  });
  if (!res.ok) throw new Error(`中信投信 API HTTP ${res.status}`);
  const apiRes = await res.json();
  if (apiRes.ResultCode !== 0) throw new Error(`中信投信 API 回應錯誤：${apiRes.ResultMsg || apiRes.ResultCode}`);
  const detail = apiRes?.Data?.FundAssetsDetail || [];
  const stockSection = detail.find(s => s.Code === 'STOCK');
  if (!stockSection) throw new Error('中信投信 API 回應格式跟預期不符（找不到股票區塊）');
  return stockSection.Data.map(r => ({
    stockCode: r.code_, stockName: r.name_,
    shares: parseFloat(String(r.qty_).replace(/,/g, '')), weight: parseFloat(r.weights_),
  }));
}

// 第一金投信（fsitc.com.tw）：ASP.NET WebMethod，POST body 不帶 pStrDate（空字串）就是回傳
// 最新一天的資料，不用另外查日期格式。回應是「JSON 字串包一層」（.d 欄位本身還要再 JSON.parse
// 一次）。group 欄位混雜了股票(1)／現金(4)／類別佔比摘要(5)，只取 group==="1" 的才是真的持股。
async function fetchFirstHoldings(fundId) {
  const res = await fetch('https://www.fsitc.com.tw/WebAPI.aspx/Get_hd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ pStrFundID: fundId, pStrDate: '' }),
  });
  if (!res.ok) throw new Error(`第一金投信 HTTP ${res.status}`);
  const outer = await res.json();
  const data = JSON.parse(outer.d);
  return data
    .filter(r => r.group === '1')
    .map(r => ({ stockCode: r.A, stockName: r.B, weight: parseFloat(r.C), shares: parseFloat(String(r.D).replace(/,/g, '')) }));
}

// 國泰投信（cwapi.cathaysite.com.tw）擋在 Akamai 後面，但只要有像瀏覽器的 User-Agent 就會放行，
// 不需要 cookie/token。這個 API 只揭露「持股權重%」，不像其他發行公司會一併給股數——
// 回傳的 holdings 陣列因此 shares 一律是 null，讀取端（active-etf-flow.js）要用 weight 變化
// 判斷加碼/減碼方向。另外多打一次 GetETFDetailBalList 拿基金股票總市值，掛在回傳陣列的
// .stockValue 屬性上（不影響陣列本身的持股資料），供讀取端把 weight 變化換算成估計金額。
// SearchDate 必須是有效交易日，非交易日會回傳空陣列，所以從今天往前最多找 5 天。
async function fetchCathayHoldings(fundCode) {
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

  // GetIndexStockWeights（持股權重）實測不管傳什麼 SearchDate（含未來日期）都會回傳同一份「目前
  // 最新」快照，不能拿它來判斷日期是否已結算。GetETFDetailBalList（資產成分/總市值）則會誠實地對
  // 還沒結算的日期回傳「查無資料」，所以用它從今天往前找「最新已結算日」，兩個端點都改用這個日期查。
  let stockValue = null;
  let settledDate = null;
  let lastError = null;
  for (let back = 0; back < 5 && !settledDate; back++) {
    const d = new Date(Date.now() + 8 * 3600 * 1000 - back * 86400000);
    const searchDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    try {
      const balRes = await fetch(`https://cwapi.cathaysite.com.tw/api/ETF/GetETFDetailBalList?FundCode=${fundCode}&SearchDate=${searchDate}&status=1`, { headers });
      if (!balRes.ok) { lastError = new Error(`國泰投信資產成分 API HTTP ${balRes.status}`); continue; }
      const balJson = await balRes.json();
      if (!balJson.success) { lastError = new Error(`國泰投信資產成分 API 無資料（${searchDate}）：${balJson.returnMessage || balJson.returnCode}`); continue; }
      const stockItem = (balJson?.result || []).find(x => x.item === '股票');
      const parsed = stockItem ? parseFloat(String(stockItem.amount).replace(/[^\d.-]/g, '')) : null;
      settledDate = searchDate;
      if (parsed != null && isFinite(parsed)) stockValue = parsed;
    } catch (e) { lastError = e; }
  }
  if (!settledDate) throw (lastError || new Error('國泰投信 API 連續 5 天皆無已結算資料'));

  const res = await fetch(`https://cwapi.cathaysite.com.tw/api/ETF/GetIndexStockWeights?FundCode=${fundCode}&SearchDate=${settledDate}`, { headers });
  if (!res.ok) throw new Error(`國泰投信持股權重 API HTTP ${res.status}`);
  const apiRes = await res.json();
  const rows = apiRes?.result?.stockWeights;
  if (!apiRes.success || !Array.isArray(rows) || rows.length === 0) throw new Error(`國泰投信持股權重 API 無資料（${settledDate}）：${apiRes.returnMessage || apiRes.returnCode}`);

  const holdings = rows.map(r => ({
    stockCode: r.stockCode, stockName: (r.stockName || '').trim(),
    shares: null, weight: parseFloat(r.weights),
  })).filter(h => h.stockCode && isFinite(h.weight));

  if (stockValue != null) holdings.stockValue = stockValue;
  return holdings;
}

// 群益投信（capitalfund.com.tw）：乾淨的公開 JSON API，不用 cookie/登入，也不受頁面上看到的
// Incapsula 資源保護（那是網站其他部分用的，這支 API 本身可直接打）。POST body 欄位必須是
// {fundId, date:null}（fundId 用的是內部代碼如 "399"，不是公開股票代號 "00982A"——這點卡了
// 很久，是從頁面編譯後的 JS bundle 反查 this.condition={fundId,date} 的真實欄位名稱才找到的）。
// 回應除了股票明細，也包含美股持股（stocNo 帶" US"字尾，如"AMD US"）——00997A整檔都是美股，
// 照舊，非純數字代號的部分金額會在讀取端顯示「暫無資料」，不特別處理。
async function fetchCapitalHoldings(fundId) {
  const res = await fetch('https://www.capitalfund.com.tw/CFWeb/api/etf/buyback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    body: JSON.stringify({ fundId, date: null }),
  });
  if (!res.ok) throw new Error(`群益投信 API HTTP ${res.status}`);
  const apiRes = await res.json();
  const stocks = apiRes?.data?.stocks;
  if (apiRes.code !== 200 || !Array.isArray(stocks)) throw new Error(`群益投信 API 回應格式跟預期不符：${JSON.stringify(apiRes).slice(0, 200)}`);
  return stocks.map(s => ({
    stockCode: s.stocNo, stockName: (s.stocName || '').trim(),
    shares: s.share != null ? Math.round(s.share) : null, weight: s.weight,
  })).filter(h => h.stockCode && isFinite(h.weight));
}

// 兆豐投信（megafunds.com.tw）：純伺服器渲染 HTML，不用 cookie/登入，完整持股表格（52檔）
// 已經在單一 GET 回應裡（總權重加總剛好等於頁面上顯示的「股票(94.32%)」，確認沒有分頁/
// 展開的隱藏資料）。之前用 ASP.NET postback（帶 __VIEWSTATE 等欄位模擬表單送出）走了很多
// 冤枉路才發現：其實根本不需要 postback，直接帶 id query string GET 這個頁面就有完整資料。
async function fetchMegaHoldings(id) {
  const res = await fetch(`https://www.megafunds.com.tw/MEGA/etf/etf_product.aspx?id=${id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error(`兆豐投信 HTTP ${res.status}`);
  const html = await res.text();
  const rows = [...html.matchAll(/<div class="fund-info content-list-1">\s*<div class="fund-content">(\d{4,6})<\/div>\s*<div class="fund-content">([^<]+)<\/div>\s*<div class="fund-content txt-right">([\d,]+)<\/div>\s*<div class="fund-content txt-right">([\d.]+)\s*%<\/div>\s*<\/div>/g)];
  if (rows.length === 0) throw new Error('兆豐投信頁面內找不到持股表格（版面可能已變更）');
  return rows.map(m => ({ stockCode: m[1], stockName: m[2].trim(), shares: parseFloat(m[3].replace(/,/g, '')), weight: parseFloat(m[4]) }));
}

// 元大投信（etfapi.yuantaetfs.com）：乾淨的公開 JSON API，不用 cookie/登入/任何 header。
// 網址結構是「閘道 + FuncId 參數」（bridge?...&FuncId=PCF/Daily&...&ticker=00990A），跟一般
// REST API 路徑完全不同，之前用猜路徑的方式一直 404 就是因為這樣——要從頁面實際打的網路
// 請求才找得到。持股在 FundWeights.StockWeights，00990A 是全球型基金，code 可能帶交易所
// 字尾（如"AMD US"、"285A JP"），純數字的才是台股，跟台新/群益美股持股的處理方式一致。
async function fetchYuantaHoldings(ticker) {
  const res = await fetch(`https://etfapi.yuantaetfs.com/ectranslation/api/bridge?APIType=ETFAPI&CompanyName=YUANTAFUNDS&PageName=/&DeviceId=elan-quant-cron&FuncId=PCF/Daily&AppName=ETF&Device=3&Platform=ETF&ticker=${ticker}`);
  if (!res.ok) throw new Error(`元大投信 API HTTP ${res.status}`);
  const apiRes = await res.json();
  const rows = apiRes?.FundWeights?.StockWeights;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('元大投信 API 回應格式跟預期不符（找不到 FundWeights.StockWeights）');
  return rows.map(r => ({
    stockCode: r.code, stockName: (r.name || '').trim(),
    shares: r.qty != null ? Math.round(r.qty) : null, weight: r.weights,
  })).filter(h => h.stockCode && isFinite(h.weight));
}

// 摩根投信（am.jpmorgan.com）：乾淨的公開 JSON API，不用 cookie/登入。之前以為要解析 XLSX
// 檔案才卡住很久，實際上頁面上的「投資組合」表格是這支 API 直接回傳的，完整持股就在
// fundData.holdings.pcfEquityHoldings.data 裡（不是分頁載入，一次回傳全部，頁面上的分頁
// 只是前端每頁顯示10筆的視覺呈現）。cusip 用的是 TW ISIN 格式（如 TW00000401A1），不是
// 台股代號。00989A整檔是美股持股，跟台新、群益的美股持股處理方式一致。
async function fetchJpmorganHoldings(cusip) {
  const res = await fetch(`https://am.jpmorgan.com/FundsMarketingHandler/product-data?cusip=${cusip}&country=tw&role=twetf&language=zh&userLoggedIn=false`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error(`摩根投信 API HTTP ${res.status}`);
  const apiRes = await res.json();
  const rows = apiRes?.fundData?.holdings?.pcfEquityHoldings?.data;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('摩根投信 API 回應格式跟預期不符（找不到 pcfEquityHoldings.data）');
  return rows.map(r => ({
    stockCode: r.securityTicker, stockName: (r.securityDescription || '').trim(),
    shares: r.shares != null ? Math.round(r.shares) : null, weight: r.marketValuePercent,
  })).filter(h => h.stockCode && isFinite(h.weight));
}

async function fetchAndStoreActiveEtfHoldings(db, todayDash) {
  const etfs = [
    { code: '00981A', name: '統一台股增長主動式ETF', source: 'ezmoney', fundCode: '49YTW' },
    { code: '00980A', name: '野村臺灣智慧優選主動式ETF', source: 'nomura', fundCode: '00980A' },
    // 同一個發行公司的其他主動式ETF，用同一套抓取邏輯、只換基金代碼——61YTW/63YTW是在
    // 00981A 那頁「旗下所有ETF」清單裡找到的，跟 49YTW 一樣是 ezmoney 內部代碼。
    { code: '00988A', name: '統一全球創新主動式ETF', source: 'ezmoney', fundCode: '61YTW' },
    { code: '00403A', name: '統一台股升級50主動式ETF', source: 'ezmoney', fundCode: '63YTW' },
    { code: '00985A', name: '野村台灣50主動式ETF', source: 'nomura', fundCode: '00985A' },
    { code: '00999A', name: '野村臺灣高息主動式ETF', source: 'nomura', fundCode: '00999A' },
    { code: '00407A', name: '凱基台灣主動式ETF', source: 'kgifund', fundCode: 'J024' },
    { code: '00405A', name: '富邦台灣龍耀主動式ETF', source: 'fubon', fundCode: '00405A' },
    { code: '00984A', name: '安聯台灣高息主動式ETF', source: 'allianz', fundCode: 'E0001' },
    { code: '00993A', name: '安聯台灣主動式ETF', source: 'allianz', fundCode: 'E0002' },
    { code: '00402A', name: '安聯美國科技主動式ETF', source: 'allianz', fundCode: 'E0003' },
    { code: '00986A', name: '台新龍頭成長主動式ETF', source: 'taishin', fundCode: '00986A' },
    { code: '00987A', name: '台新優勢成長主動式ETF', source: 'taishin', fundCode: '00987A' },
    { code: '00404A', name: '聯博動能50主動式ETF', source: 'ab', fundCode: 'TW00000404A5' },
    { code: '00406A', name: '中信台灣收益主動式ETF', source: 'ctbc', fundCode: 'E0038' },
    { code: '00983A', name: '中信ARK創新主動式ETF', source: 'ctbc', fundCode: 'E0034' },
    { code: '00995A', name: '中信台灣卓越主動式ETF', source: 'ctbc', fundCode: 'E0036' },
    { code: '00994A', name: '第一金台股優主動式ETF', source: 'first', fundCode: '182' },
    { code: '00400A', name: '國泰台股動能高息主動式ETF', source: 'cathay', fundCode: 'EA' },
    { code: '00982A', name: '群益台灣精選強棒主動式ETF', source: 'capital', fundCode: '399' },
    { code: '00992A', name: '群益台灣科技創新主動式ETF', source: 'capital', fundCode: '500' },
    { code: '00997A', name: '群益美國增長主動式ETF', source: 'capital', fundCode: '502' },
    { code: '00996A', name: '兆豐台灣豐收主動式ETF', source: 'mega', fundCode: '23' },
    { code: '00990A', name: '元大全球AI新經濟主動式ETF', source: 'yuanta', fundCode: '00990A' },
    { code: '00401A', name: '摩根台灣鑫收益主動式ETF', source: 'jpmorgan', fundCode: 'TW00000401A1' },
    { code: '00989A', name: '摩根大美國領先科技主動式ETF', source: 'jpmorgan', fundCode: 'TW00000989A5' },
  ];

  const fetchers = {
    ezmoney: fetchEzmoneyHoldings, nomura: fetchNomuraHoldings, kgifund: fetchKgifundHoldings,
    fubon: fetchFubonHoldings, allianz: fetchAllianzHoldings, taishin: fetchTaishinHoldings,
    ab: fetchAllianceBernsteinHoldings, ctbc: fetchCtbcHoldings, first: fetchFirstHoldings,
    cathay: fetchCathayHoldings, capital: fetchCapitalHoldings, mega: fetchMegaHoldings,
    yuanta: fetchYuantaHoldings, jpmorgan: fetchJpmorganHoldings,
  };

  // 26檔ETF原本是for...of一個接一個序列await，實測2026-07-13：daily_market_data準時在
  // 18:00寫入，但排在最後這一步26檔全部掛零——最可能是整支worker因為前面已經做了台指收盤/
  // 漲跌家數/融資/三大法人/全市場個股收盤/Put-Call比/VIXTWN/公債殖利率等一長串序列步驟，
  // 疊加這裡再序列等26次（有些發行公司如CTBC/Allianz還要多步驟token驗證），總執行時間
  // 很可能超過Cloudflare的執行時限被系統整個砍斷。
  //
  // 改成平行，但不是對26檔全部無腦Promise.all——ctbc/ezmoney/allianz/capital這幾家各自
  // 旗下有2-3檔ETF，共用同一個站台。全部無腦平行等於同一秒對同一個網域（有些還會先打
  // 同一個auth token端點）發起2-3組完整handshake，這是典型的反爬蟲異常流量訊號，比序列
  // 執行更容易被target網站判定成攻擊而擋掉，反而讓資料更難抓到。改成：同一個發行公司內部
  // 序列（同時加一點隨機延遲，不要在同一毫秒發出），不同發行公司之間才平行——這樣總數還是
  // 14個並發請求（不是1個也不是26個），跟原本「26檔全部同時打」比起來對單一目標網站更客氣。
  const groups = new Map();
  for (const etf of etfs) {
    if (!groups.has(etf.source)) groups.set(etf.source, []);
    groups.get(etf.source).push(etf);
  }

  const failedCodes = [];
  await Promise.all([...groups.values()].map(async group => {
    for (const etf of group) {
      // 同一發行公司內第2檔起錯開一點時間，不要緊接著上一檔完成就立刻發下一個請求。
      if (group.indexOf(etf) > 0) await sleep(300 + Math.floor(Math.random() * 400));
      try {
        const fetcher = fetchers[etf.source];
        if (!fetcher) throw new Error(`未知的資料來源：${etf.source}`);
        const rawHoldings = await fetcher(etf.fundCode);

        // 過濾掉明顯不合理的持股列——weight應該落在0~100%之間，shares如果有值應該是非負數。
        // 任一檔fetcher的解析邏輯萬一欄位對錯位（例如目標網站改版），與其把離譜數字悄悄寫進
        // D1污染後續加減碼計算（跟twtazu_od選錯欄位那個bug是同一類問題），不如直接濾掉
        // 這幾筆並在log留下數量，之後查起來才有線索。
        const holdings = rawHoldings.filter(h => {
          const weightOk = typeof h.weight === 'number' && isFinite(h.weight) && h.weight >= 0 && h.weight <= 100;
          const sharesOk = h.shares == null || (isFinite(h.shares) && h.shares >= 0);
          return weightOk && sharesOk;
        });
        if (rawHoldings.stockValue != null) holdings.stockValue = rawHoldings.stockValue;
        if (holdings.length < rawHoldings.length) {
          console.error(`[cron-etf] ${etf.code} (${etf.source})：${rawHoldings.length - holdings.length}/${rawHoldings.length} 筆持股資料weight/shares不合理，已濾掉不寫入`);
        }

        if (holdings.length === 0) throw new Error('parsed 0 holdings');

        if (holdings.stockValue != null) {
          await db.prepare(
            'INSERT OR REPLACE INTO etf_portfolio_value (etf_code, date, stock_value) VALUES (?, ?, ?)'
          ).bind(etf.code, todayDash, holdings.stockValue).run();
        }

        const statements = holdings.map(h =>
          db.prepare(
            'INSERT OR REPLACE INTO active_etf_holdings (etf_code, etf_name, stock_code, date, shares, weight) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(etf.code, etf.name, h.stockCode, todayDash, h.shares, h.weight)
        );

        await db.batch(statements);
        console.log(`[cron-etf] successfully stored ${holdings.length} holdings for ${etf.code} (${etf.source}) on ${todayDash}`);
      } catch (e) {
        console.error(`[cron-etf] Error crawling ${etf.code} (${etf.source}):`, e.message);
        failedCodes.push(etf.code);
      }
    }
  }));
  // 單獨一行彙總結果——26檔逐一的log訊息很難一眼看出「今天整體狀況正不正常」，這行讓人
  // (或之後的我) 打開 Cloudflare 的 log 只看最後一行就知道要不要往上翻查特定ETF的錯誤細節。
  // 這不會阻止資料缺漏（缺漏本身是預期內、且已在active-etf-flow.js正確處理的情境），
  // 純粹是讓「缺漏正在發生」這件事更容易被人發現，不用等使用者回報才知道。
  console.log(`[cron-etf] 本次執行完畢：${etfs.length - failedCodes.length}/${etfs.length} 檔成功，失敗：${failedCodes.length ? failedCodes.join('、') : '無'}`);
}

export default {
  async scheduled(event, env, ctx) {
    const db = env.ELAN_QUANT_DB;
    if (!db) {
      console.error('ELAN_QUANT_DB 未綁定，無法執行每日資料累積任務');
      return;
    }
    const { ad: todayAd, roc: todayRoc, dash: todayDash, nowHHMM, dow } = todayDates();
    // 2026-07-12 事故：手動觸發（Cloudflare Dashboard的「Trigger」測試按鈕，或wrangler dev
    // --test-scheduled沒加--local）會繞過cron排程本身的「只有平日」限制，用當下的真實日期
    // （可能是週六/週日）把資料寫進正式環境D1。cron trigger本身排程是"0 10 * * 1-5"只會在
    // 平日觸發，這裡加一層保險：只要算出來的「今天」是週末，就整個直接跳過，什麼都不寫。
    if (dow === 0 || dow === 6) {
      console.error(`[cron] 今天（${todayAd}，台北時區）是週末，台股沒有開盤，整個排程本次直接跳過，不寫入任何資料。`);
      return;
    }

    // 主動式ETF持股爬蟲獨立成第二個cron trigger（10:05 UTC，見wrangler.toml），跟下面
    // 一長串步驟分開跑、各自有自己完整的執行時間預算，不用跟前面的步驟搶。event.cron
    // 用來分辨這次是哪一個排程觸發的；本機wrangler dev --test-scheduled不帶--cron參數時
    // event.cron會是空字串，這裡當成主排程處理，方便本機測試不用額外指定。
    if (event.cron === '5 10 * * 1-5') {
      try {
        // active_etf_holdings.date 統一用 YYYY-MM-DD（跟 scripts/sync_active_etfs.js 手動同步
        // 腳本一致）——這裡故意不用 todayAd（YYYYMMDD，其他表用的格式），避免同一張表混入
        // 兩種日期格式，導致 functions/api/active-etf-flow.js 「取最新兩個日期」的字串排序
        // 邏輯失準。
        await fetchAndStoreActiveEtfHoldings(db, todayDash);
        console.log('[cron] 主動式 ETF 持股爬蟲執行完成');
        await logStep(db, 'activeEtfHoldings', nowHHMM, null);
      } catch (e) {
        console.error('[cron] 主動式 ETF 持股爬蟲失敗：', e.message);
        await logStep(db, 'activeEtfHoldings', nowHHMM, e.message);
      }
      return;
    }

    const dayData = {
      date: todayAd, taiex_close: null, advancers: null, decliners: null, new_highs: null, new_lows: null,
      margin_balance_total: null, inst_net_buy_count: null, inst_net_sell_count: null,
      put_call_ratio: null, vixtwn: null, govbond_10y_yield: null, corp_bond_spread: null,
    };

    // 這8個步驟原本是循序await，互相之間除了「screener依賴stockDayAllNewHighLow先把今天的
    // 收盤價/成交量寫進stock_daily_price」這一組之外，彼此完全獨立（各自打不同的外部端點、
    // 寫dayData的不同欄位）。序列執行代表總耗時是每一步耗時的總和，尖峰時段任何一步變慢
    // 都會排擠到後面所有步驟的時間預算——這正是ETF持股爬蟲之前整批掛零的根因，拆成獨立
    // cron trigger只解決了ETF那一步，同樣的風險換一批新步驟還是會重演。改成Promise.allSettled
    // 併發執行，總耗時趨近「最慢的那一步」而不是「全部加總」，大幅降低任何單一步驟拖垮
    // 後面步驟的機率。用allSettled而不是all，是因為就算某個任務內部try/catch漏接了什麼
    // 意外錯誤，也不該讓其他7個任務的await被打斷。
    await Promise.allSettled([
      (async () => {
        try {
          const raw = await fetchTaiexClose(todayRoc);
          const prev = await fetchPreviousTaiexClose(db, todayAd);
          if (prev != null && Math.abs(raw - prev) / prev > MAX_TAIEX_DAILY_CHANGE_RATIO) {
            const msg = `加權指數收盤價 ${raw} 與前一筆有效值 ${prev} 差異達 ${((Math.abs(raw - prev) / prev) * 100).toFixed(1)}%，超過合理範圍，懷疑來源資料異常（TWSE 端點已知會偶發回傳看似正常但錯誤的資料），本次不採用，當日欄位保留 NULL`;
            console.error(`[cron] ${msg}`);
            await logStep(db, 'taiexClose', nowHHMM, msg);
          } else {
            dayData.taiex_close = raw;
            await logStep(db, 'taiexClose', nowHHMM, null);
          }
        } catch (e) {
          console.error('[cron] 取得加權指數失敗：', e.message);
          await logStep(db, 'taiexClose', nowHHMM, e.message);
        }
      })(),

      (async () => {
        try {
          const ad = await fetchAdvanceDecline();
          dayData.advancers = ad.advancers;
          dayData.decliners = ad.decliners;
          await logStep(db, 'advanceDecline', nowHHMM, null);
        } catch (e) {
          console.error('[cron] 取得漲跌家數失敗：', e.message);
          await logStep(db, 'advanceDecline', nowHHMM, e.message);
        }
      })(),

      (async () => {
        try {
          dayData.margin_balance_total = await fetchMarginTotal();
          await logStep(db, 'marginTotal', nowHHMM, null);
        } catch (e) {
          console.error('[cron] 取得全市場融資餘額失敗：', e.message);
          await logStep(db, 'marginTotal', nowHHMM, e.message);
        }
      })(),

      (async () => {
        try {
          const inst = await fetchInstitutionalCounts(todayAd);
          dayData.inst_net_buy_count = inst.buyCount;
          dayData.inst_net_sell_count = inst.sellCount;
          await logStep(db, 'institutionalCounts', nowHHMM, null);
        } catch (e) {
          console.error('[cron] 取得三大法人買賣超家數失敗：', e.message);
          await logStep(db, 'institutionalCounts', nowHHMM, e.message);
        }
      })(),

      (async () => {
        try {
          const stockRows = await fetchStockDayAll();
          const tpexRows = await fetchTpexStockDayAll();
          const mergedRows = stockRows.concat(tpexRows);
          const { newHighs, newLows } = await updateStockPricesAndCountNewHighLow(db, todayAd, mergedRows);
          dayData.new_highs = newHighs;
          dayData.new_lows = newLows;
          await logStep(db, 'stockDayAllNewHighLow', nowHHMM, null);
        } catch (e) {
          console.error('[cron] 更新個股價格/計算創新高低失敗：', e.message);
          await logStep(db, 'stockDayAllNewHighLow', nowHHMM, e.message);
          return; // screener需要今天的股價資料，這步都失敗了就不用往下試
        }
        // screener依賴上面剛寫進stock_daily_price的今日收盤/成交量，必須在同一個任務裡
        // 排在後面執行（保留依賴順序），但仍然跟其他7個獨立任務併發跑。
        try {
          const screener = await computeScreenerSignals(db, todayAd);
          console.log(`[cron] RSI超賣/超買+量暴增篩選器：共 ${screener.count} 檔符合（超賣 ${screener.oversoldCount}、超買 ${screener.overboughtCount}）`);
          await logStep(db, 'screener', nowHHMM, null);
        } catch (e) {
          console.error('[cron] 計算RSI超賣/超買+量暴增篩選器失敗：', e.message);
          await logStep(db, 'screener', nowHHMM, e.message);
        }
      })(),

      (async () => {
        try {
          dayData.put_call_ratio = await fetchPutCallRatio();
          await logStep(db, 'putCallRatio', nowHHMM, null);
        } catch (e) {
          console.error('[cron] 取得臺指選擇權Put/Call比失敗：', e.message);
          await logStep(db, 'putCallRatio', nowHHMM, e.message);
        }
      })(),

      (async () => {
        try {
          dayData.vixtwn = await fetchVixTwn(todayAd);
          await logStep(db, 'vixtwn', nowHHMM, null);
        } catch (e) {
          console.error('[cron] 取得VIXTWN失敗：', e.message);
          await logStep(db, 'vixtwn', nowHHMM, e.message);
        }
      })(),

      (async () => {
        try {
          const bond = await fetchBondCurve();
          dayData.govbond_10y_yield = bond.gov10y;
          dayData.corp_bond_spread = bond.spread;
          await logStep(db, 'bondCurve', nowHHMM, null);
        } catch (e) {
          console.error('[cron] 取得公債殖利率/公司債信用利差失敗：', e.message);
          await logStep(db, 'bondCurve', nowHHMM, e.message);
        }
      })(),
    ]);

    try {
      await db.prepare(`
        INSERT OR REPLACE INTO daily_market_data
          (date, taiex_close, advancers, decliners, new_highs, new_lows, margin_balance_total, inst_net_buy_count, inst_net_sell_count, put_call_ratio, vixtwn, govbond_10y_yield, corp_bond_spread, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        dayData.date, dayData.taiex_close, dayData.advancers, dayData.decliners,
        dayData.new_highs, dayData.new_lows, dayData.margin_balance_total,
        dayData.inst_net_buy_count, dayData.inst_net_sell_count,
        dayData.put_call_ratio, dayData.vixtwn, dayData.govbond_10y_yield, dayData.corp_bond_spread,
        nowHHMM
      ).run();
      console.log(`[cron] daily_market_data 寫入完成（台北時間 ${nowHHMM}）：`, JSON.stringify(dayData));
    } catch (e) {
      console.error('[cron] 寫入 daily_market_data 失敗：', e.message);
    }

    try {
      const holderResult = await updateHolderSnapshotIfNewWeek(db);
      console.log('[cron] holder_weekly_snapshot：', JSON.stringify(holderResult));
    } catch (e) { console.error('[cron] 更新大戶持股週快照失敗：', e.message); }
  },
};
