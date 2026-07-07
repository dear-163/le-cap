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
  // Cron 在 UTC 11:00（台北 19:00）觸發，用 UTC+8 換算「今天」的日期。
  const now = new Date();
  const taipei = new Date(now.getTime() + 8 * 3600 * 1000);
  const y = taipei.getUTCFullYear();
  const m = String(taipei.getUTCMonth() + 1).padStart(2, '0');
  const d = String(taipei.getUTCDate()).padStart(2, '0');
  return { ad: `${y}${m}${d}`, roc: `${y - 1911}${m}${d}`, dash: `${y}-${m}-${d}` };
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

async function fetchStockDayAll() {
  const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`STOCK_DAY_ALL HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr)) throw new Error('STOCK_DAY_ALL 回應格式不是陣列');
  return arr;
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
    const prior = priorMap.get(code);
    if (prior && prior.days >= STOCK_HISTORY_MIN_DAYS) {
      if (high != null && prior.max_high != null && high > prior.max_high) newHighs++;
      if (low != null && prior.min_low != null && low < prior.min_low) newLows++;
    }
    upserts.push(
      db.prepare('INSERT OR REPLACE INTO stock_daily_price (code, date, close, high, low) VALUES (?, ?, ?, ?, ?)')
        .bind(code, todayAd, close, high, low)
    );
  }
  await batchRun(db, upserts);
  return { newHighs, newLows };
}

async function updateHolderSnapshotIfNewWeek(db) {
  const res = await fetch('https://opendata.tdcc.com.tw/getOD.ashx?id=1-5', { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`TDCC HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('TDCC 回應內容為空');
  const headers = lines[0].replace(/^﻿/, '').split(',').map(h => h.trim());
  const idx = { date: headers.indexOf('資料日期'), code: headers.indexOf('證券代號'), level: headers.indexOf('持股分級'), pct: headers.indexOf('占集保庫存數比例%') };
  if (Object.values(idx).some(i => i === -1)) throw new Error(`TDCC CSV 欄位與預期不符：${headers.join('、')}`);

  const tdccDate = lines[1].split(',')[idx.date]?.trim();
  if (!tdccDate) throw new Error('TDCC 無法解析資料日期');

  const latest = await db.prepare('SELECT date FROM holder_weekly_snapshot ORDER BY date DESC LIMIT 1').first();
  if (latest && latest.date === tdccDate) {
    return { skipped: true, date: tdccDate };
  }

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

async function fetchAndStoreActiveEtfHoldings(db, todayDash) {
  const etfs = [
    { code: '00981A', name: '主動統一台股增長主動式ETF', moneydjCode: '00981A.TW' },
    { code: '00980A', name: '野村臺灣智慧優選主動式ETF', moneydjCode: '00980A.TW' }
  ];

  for (const etf of etfs) {
    try {
      const url = `https://www.moneydj.com/etf/x/basic/basic0007.xdjhtm?etfid=${etf.moneydjCode}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) {
        console.error(`[cron-etf] Fetching ${etf.code} from MoneyDJ failed: HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      const regex = /etfid=(\d{4,6})\.(TW|TWO)[^>]*>([^<\(]+)\(\1\.\2\)<\/a><\/td><td[^>]*>([0-9.]+)<\/td><td[^>]*>([0-9,.-]+)<\/td>/gi;

      let match;
      const holdings = [];
      while ((match = regex.exec(html)) !== null) {
        holdings.push({
          stockCode: match[1],
          weight: parseFloat(match[4]),
          shares: parseFloat(match[5].replace(/,/g, ''))
        });
      }

      if (holdings.length === 0) {
        console.error(`[cron-etf] parsed 0 holdings for ${etf.code}`);
        continue;
      }

      const statements = holdings.map(h => {
        return db.prepare(
          'INSERT OR REPLACE INTO active_etf_holdings (etf_code, etf_name, stock_code, date, shares, weight) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(etf.code, etf.name, h.stockCode, todayDash, h.shares, h.weight);
      });

      await db.batch(statements);
      console.log(`[cron-etf] successfully stored ${holdings.length} holdings for ${etf.code} on ${todayDash}`);
    } catch (e) {
      console.error(`[cron-etf] Error crawling ${etf.code}:`, e.message);
    }
  }
}

export default {
  async scheduled(event, env, ctx) {
    const db = env.ELAN_QUANT_DB;
    if (!db) {
      console.error('ELAN_QUANT_DB 未綁定，無法執行每日資料累積任務');
      return;
    }
    const { ad: todayAd, roc: todayRoc, dash: todayDash } = todayDates();
    const dayData = { date: todayAd, taiex_close: null, advancers: null, decliners: null, new_highs: null, new_lows: null, margin_balance_total: null, inst_net_buy_count: null, inst_net_sell_count: null };

    try {
      const raw = await fetchTaiexClose(todayRoc);
      const prev = await fetchPreviousTaiexClose(db, todayAd);
      if (prev != null && Math.abs(raw - prev) / prev > MAX_TAIEX_DAILY_CHANGE_RATIO) {
        console.error(`[cron] 加權指數收盤價 ${raw} 與前一筆有效值 ${prev} 差異達 ${((Math.abs(raw - prev) / prev) * 100).toFixed(1)}%，超過合理範圍，懷疑來源資料異常（TWSE 端點已知會偶發回傳看似正常但錯誤的資料），本次不採用，當日欄位保留 NULL`);
      } else {
        dayData.taiex_close = raw;
      }
    } catch (e) { console.error('[cron] 取得加權指數失敗：', e.message); }

    try {
      const ad = await fetchAdvanceDecline();
      dayData.advancers = ad.advancers;
      dayData.decliners = ad.decliners;
    } catch (e) { console.error('[cron] 取得漲跌家數失敗：', e.message); }

    try {
      dayData.margin_balance_total = await fetchMarginTotal();
    } catch (e) { console.error('[cron] 取得全市場融資餘額失敗：', e.message); }

    try {
      const inst = await fetchInstitutionalCounts(todayAd);
      dayData.inst_net_buy_count = inst.buyCount;
      dayData.inst_net_sell_count = inst.sellCount;
    } catch (e) { console.error('[cron] 取得三大法人買賣超家數失敗：', e.message); }

    try {
      const stockRows = await fetchStockDayAll();
      const { newHighs, newLows } = await updateStockPricesAndCountNewHighLow(db, todayAd, stockRows);
      dayData.new_highs = newHighs;
      dayData.new_lows = newLows;
    } catch (e) { console.error('[cron] 更新個股價格/計算創新高低失敗：', e.message); }

    try {
      await db.prepare(`
        INSERT OR REPLACE INTO daily_market_data
          (date, taiex_close, advancers, decliners, new_highs, new_lows, margin_balance_total, inst_net_buy_count, inst_net_sell_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        dayData.date, dayData.taiex_close, dayData.advancers, dayData.decliners,
        dayData.new_highs, dayData.new_lows, dayData.margin_balance_total,
        dayData.inst_net_buy_count, dayData.inst_net_sell_count
      ).run();
      console.log('[cron] daily_market_data 寫入完成：', JSON.stringify(dayData));
    } catch (e) {
      console.error('[cron] 寫入 daily_market_data 失敗：', e.message);
    }

    try {
      const holderResult = await updateHolderSnapshotIfNewWeek(db);
      console.log('[cron] holder_weekly_snapshot：', JSON.stringify(holderResult));
    } catch (e) { console.error('[cron] 更新大戶持股週快照失敗：', e.message); }

    try {
      // active_etf_holdings.date 統一用 YYYY-MM-DD（跟 scripts/sync_active_etfs.js 手動同步腳本
      // 一致）——這裡故意不用 todayAd（YYYYMMDD，其他表用的格式），避免同一張表混入兩種日期
      // 格式，導致 functions/api/active-etf-flow.js 「取最新兩個日期」的字串排序邏輯失準。
      await fetchAndStoreActiveEtfHoldings(db, todayDash);
      console.log('[cron] 主動式 ETF 持股爬蟲執行完成');
    } catch (e) { console.error('[cron] 主動式 ETF 持股爬蟲失敗：', e.message); }
  },
};
