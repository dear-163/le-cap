// 籌碼面：融資融券、大戶持股結構、三大法人買賣超。
// 全部即時查詢官方來源（不強制依賴 D1），每個欄位都帶 {value, source, date}，
const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,15}$/;
const BROWSER_HEADERS = { 
  'Accept': 'application/json', 
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Referer': 'https://www.tpex.org.tw/'
};

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } });
}

function stockCodeFromSymbol(symbol) {
  return symbol.replace(/\.TWO?$/i, '');
}

// T86 (www.twse.com.tw legacy endpoint) wants AD format (YYYYMMDD) — verified by testing;
// this differs from openapi.twse.com.tw endpoints, which mostly use ROC dates in responses.
function toAdDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
function isoFromRocOrAd(dateStr) {
  // TWSE dates are either ROC (7 digits, e.g. 1150703) or AD (8 digits, e.g. 20260703).
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (s.length === 7) {
    const y = parseInt(s.slice(0, 3), 10) + 1911;
    return `${y}-${s.slice(3, 5)}-${s.slice(5, 7)}`;
  }
  if (s.length === 8) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return s;
}

// 舊版直接打 openapi.twse.com.tw/v1/exchangeReport/MI_MARGN，這個端點回應本身完全沒有帶日期
// 欄位，所以之前用 new Date()（當下日曆日期）硬猜資料的日期——週末/假日，或平日資料還沒
// 公布時，回應其實是前一個交易日的舊資料，卻被標成「今天」。改用跟 margin-ratio.js 一樣
// 的舊版 www.twse.com.tw 端點：支援帶日期查詢、且回應會明確帶回真正的資料日期，往前逐日
// 掃描（跳過週末）找到第一個有效交易日就用那天真正的日期，不用猜的。
async function fetchMargin(stockCode) {
  try {
    const cursor = new Date();
    for (let attempts = 0; attempts < 10; attempts++) {
      const dow = cursor.getUTCDay();
      if (dow === 0 || dow === 6) { cursor.setUTCDate(cursor.getUTCDate() - 1); continue; }
      const adDate = toAdDate(cursor);
      const url = `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date=${adDate}&selectType=ALL`;
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body && body.stat === 'OK' && Array.isArray(body.tables) && body.tables.length >= 2) {
          const detailTable = body.tables[1];
          const row = (detailTable.data || []).find(r => (r[0] || '').trim() === stockCode);
          const isoDate = isoFromRocOrAd(body.date || adDate);
          if (!row) return { error: `TWSE 信用交易統計（${isoDate}）中找不到股票代號 ${stockCode}（可能非上市股票）` };
          const parseNum = v => { const n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : null; };
          const marginBalance = parseNum(row[6]);  // 融資今日餘額
          const marginLimit = parseNum(row[7]);    // 融資限額（次一營業日限額）
          const shortBalance = parseNum(row[12]);  // 融券今日餘額
          const source = 'TWSE 信用交易統計';
          return {
            marginBalance: { value: marginBalance, source, date: isoDate },
            marginUsageRate: { value: (marginBalance != null && marginLimit) ? marginBalance / marginLimit : null, source, date: isoDate },
            shortBalance: { value: shortBalance, source, date: isoDate },
            shortToMarginRatio: { value: (shortBalance != null && marginBalance) ? shortBalance / marginBalance : null, source, date: isoDate },
          };
        }
      }
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return { error: '近期交易日的 TWSE 信用交易統計（融資融券餘額）皆無法取得有效資料，請稍後再試' };
  } catch (e) {
    return { error: `TWSE 信用交易統計請求發生例外：${e.message}` };
  }
}

// TWSE 官方公司基本資料裡的「產業別」代碼，免費不需金鑰。快取久一點(產業分類幾乎不會變動)。
// 只找出「跟目前股票同產業代碼的其他股票代號」，不需要翻譯代碼成中文產業名稱——直接秀出實際同業
// 公司名稱當比較對象，比硬翻代碼表更誠實，也不會有翻錯名稱的風險。上櫃股票目前沒找到對應的官方
// 產業分類公開資料，所以只有上市(TWSE)股票會有這個比較，上櫃股票會誠實顯示暫無資料。
async function fetchIndustryPeerCodes(stockCode, context) {
  try {
    const cache = caches.default;
    const cacheKey = new Request('https://elan-quant-cache.internal/twse-industry-list', { method: 'GET' });
    let list;
    const cached = await cache.match(cacheKey);
    if (cached) {
      list = await cached.json();
    } else {
      const res = await fetch('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', { headers: BROWSER_HEADERS });
      if (!res.ok) return null;
      list = await res.json();
      if (!Array.isArray(list)) return null;
      const cacheResponse = json(list, 200, { 'Cache-Control': 'public, max-age=86400' });
      context.waitUntil(cache.put(cacheKey, cacheResponse.clone()));
    }
    const me = list.find(r => (r['公司代號'] || '').trim() === stockCode);
    const industryCode = me?.['產業別']?.trim();
    if (!industryCode) return null;
    const peers = list.filter(r => (r['產業別'] || '').trim() === industryCode && (r['公司代號'] || '').trim() !== stockCode);
    return {
      peerCodes: new Set(peers.map(p => (p['公司代號'] || '').trim())),
      sampleNames: peers.slice(0, 3).map(p => p['公司簡稱'] || p['公司名稱']).filter(Boolean),
      totalPeers: peers.length,
    };
  } catch (e) {
    return null; // industry comparison is a nice-to-have — a failure here shouldn't break the whole holders card
  }
}

async function fetchHolderDistribution(stockCode, env, context) {
  try {
    const [tdccRes, industryInfo] = await Promise.all([
      fetch('https://opendata.tdcc.com.tw/getOD.ashx?id=1-5', { headers: BROWSER_HEADERS }),
      fetchIndustryPeerCodes(stockCode, context),
    ]);
    if (!tdccRes.ok) return { error: `TDCC 集保股權分散表請求失敗：HTTP ${tdccRes.status}` };
    const text = await tdccRes.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return { error: 'TDCC 回應內容為空或格式異常' };
    const headers = lines[0].replace(/^﻿/, '').split(',').map(h => h.trim());
    const idx = {
      date: headers.indexOf('資料日期'),
      code: headers.indexOf('證券代號'),
      level: headers.indexOf('持股分級'),
      pct: headers.indexOf('占集保庫存數比例%'),
    };
    if (Object.values(idx).some(i => i === -1)) {
      return { error: `TDCC CSV 欄位與預期不符，實際欄位：${headers.join('、')}` };
    }
    let dataDate = null, bigHolderPct = null, midHolderPct = 0, foundMid = 0;
    // Same single pass over the ~68k-line CSV also tallies big-holder % for same-industry peers —
    // marginal cost is near zero since we're already reading every line for the target stock anyway.
    const peerPcts = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const code = cols[idx.code]?.trim();
      const level = parseInt(cols[idx.level], 10);
      const pct = parseFloat(cols[idx.pct]);
      if (code === stockCode) {
        dataDate = cols[idx.date]?.trim();
        if (level === 15) bigHolderPct = isFinite(pct) ? pct : null;
        if (level === 12 || level === 13 || level === 14) { midHolderPct += isFinite(pct) ? pct : 0; foundMid++; }
      } else if (level === 15 && industryInfo?.peerCodes.has(code) && isFinite(pct)) {
        peerPcts.push(pct);
      }
    }
    if (dataDate == null) return { error: `TDCC 資料中找不到證券代號 ${stockCode}` };
    const isoDate = isoFromRocOrAd(dataDate);
    const source = 'TDCC 集保股權分散表';

    let weeklyChange = { value: null, source, note: '暫無資料（歷史快照尚未累積滿2週）' };
    if (env?.ELAN_QUANT_DB) {
      try {
        if (bigHolderPct != null) {
          await env.ELAN_QUANT_DB
            .prepare('INSERT OR IGNORE INTO holder_weekly_snapshot (code, date, big_holder_pct, mid_holder_pct) VALUES (?, ?, ?, ?)')
            .bind(stockCode, dataDate, bigHolderPct, foundMid > 0 ? midHolderPct : null)
            .run();
        }
        const prev = await env.ELAN_QUANT_DB
          .prepare('SELECT date, big_holder_pct FROM holder_weekly_snapshot WHERE code = ? AND date < ? ORDER BY date DESC LIMIT 1')
          .bind(stockCode, dataDate)
          .first();
        if (prev && prev.big_holder_pct != null && bigHolderPct != null) {
          weeklyChange = { value: bigHolderPct - prev.big_holder_pct, source, date: isoDate, comparedTo: isoFromRocOrAd(prev.date) };
        }
      } catch (e) {
        weeklyChange = { value: null, source, note: `查詢/寫入歷史快照失敗：${e.message}` };
      }
    } else {
      weeklyChange = { value: null, source, note: '暫無資料（D1 尚未綁定，無法比對歷史週快照）' };
    }

    let industryAvgPct;
    if (!industryInfo) {
      industryAvgPct = { value: null, source, note: '暫無資料（找不到官方產業分類資料，或此股票非上市股票）' };
    } else if (peerPcts.length === 0) {
      industryAvgPct = { value: null, source, note: `暫無資料（同產業 ${industryInfo.totalPeers} 家中，今日集保資料都查無千張大戶佔比）` };
    } else {
      const avg = peerPcts.reduce((s, v) => s + v, 0) / peerPcts.length;
      const sampleNote = industryInfo.sampleNames.length ? `比較對象例如：${industryInfo.sampleNames.join('、')} 等共 ${peerPcts.length} 家同產業股票` : `同產業共 ${peerPcts.length} 家股票`;
      industryAvgPct = { value: avg, source, date: isoDate, note: sampleNote };
    }

    return {
      bigHolderPct: { value: bigHolderPct, source, date: isoDate },
      midHolderPct: { value: foundMid > 0 ? midHolderPct : null, source, date: isoDate },
      industryAvgPct,
      weeklyChange,
    };
  } catch (e) {
    return { error: `TDCC 請求發生例外：${e.message}` };
  }
}

async function fetchInstitutionalFlow(stockCode) {
  try {
    const days = [];
    const cursor = new Date();
    let attempts = 0;
    let foundAny = false;
    while (days.length < 5 && attempts < 12) {
      attempts++;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      const dow = cursor.getUTCDay();
      if (dow === 0 || dow === 6) continue; // skip weekends; holidays are handled by "stat != OK" below
      const adDate = toAdDate(cursor);
      const url = `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${adDate}&selectType=ALL`;
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      if (!res.ok) continue;
      const body = await res.json().catch(() => null);
      if (!body || body.stat !== 'OK' || !Array.isArray(body.data)) continue;
      const fIdx = body.fields.indexOf('外陸資買賣超股數(不含外資自營商)');
      const tIdx = body.fields.indexOf('投信買賣超股數');
      const dIdx = body.fields.indexOf('自營商買賣超股數');
      const cIdx = body.fields.indexOf('證券代號');
      if ([fIdx, tIdx, dIdx, cIdx].some(i => i === -1)) {
        return { error: `TWSE T86 欄位與預期不符，實際欄位：${body.fields.join('、')}` };
      }
      const row = body.data.find(r => r[cIdx]?.trim() === stockCode);
      if (row) foundAny = true;
      const parseNum = v => { const n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
      days.push({
        date: isoFromRocOrAd(body.date || adDate),
        foreignNet: row ? parseNum(row[fIdx]) : 0,
        trustNet: row ? parseNum(row[tIdx]) : 0,
        dealerNet: row ? parseNum(row[dIdx]) : 0,
      });
    }
    if (days.length === 0) {
      return { error: '近期交易日的 TWSE T86（三大法人買賣超）皆無法取得有效資料，請稍後再試' };
    }
    // If the stock code never showed up in any of the collected days' full market data, it isn't a
    // TWSE-listed stock at all (e.g. a US symbol) — a series of real-looking zeros would misrepresent
    // "not tracked here" as "confirmed zero institutional flow for 5 straight days."
    if (!foundAny) {
      return { error: `TWSE T86 近 ${days.length} 個交易日資料中都找不到股票代號 ${stockCode}（可能非上市股票，或非台股代號）` };
    }
    const source = 'TWSE T86';
    const sum = (key) => days.reduce((s, d) => s + d[key], 0);
    let foreignStreak = 0;
    for (const d of days) { // days[0] is most recent
      const sign = Math.sign(d.foreignNet);
      if (foreignStreak === 0) foreignStreak = sign;
      else if (Math.sign(d.foreignNet) !== Math.sign(foreignStreak)) break;
      else foreignStreak += sign;
    }
    return {
      period: '近5日',
      days: { value: days, source },
      foreignNet5d: { value: sum('foreignNet'), source, date: days[0]?.date },
      trustNet5d: { value: sum('trustNet'), source, date: days[0]?.date },
      dealerNet5d: { value: sum('dealerNet'), source, date: days[0]?.date },
      foreignConsecutiveDays: { value: foreignStreak, source, date: days[0]?.date },
    };
  } catch (e) {
    return { error: `TWSE T86 請求發生例外：${e.message}` };
  }
}

function getFinMindUrl(dataset, stockId, env) {
  const tenDaysAgo = new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10);
  let url = `https://api.finmindtrade.com/api/v4/data?dataset=${dataset}&data_id=${stockId}&start_date=${tenDaysAgo}`;
  if (env?.FINMIND_TOKEN) {
    url += `&token=${encodeURIComponent(env.FINMIND_TOKEN)}`;
  }
  return url;
}

async function fetchMarginTpex(stockCode, env) {
  try {
    const url = getFinMindUrl('TaiwanStockMarginPurchaseShortSale', stockCode, env);
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (!res.ok) return { error: `FinMind margin API 請求失敗：HTTP ${res.status}` };
    const json = await res.json();
    if (json.status !== 200) return { error: `FinMind margin API 返回錯誤：${json.msg || '未知錯誤'}` };
    const data = json.data;
    if (!data || data.length === 0) return { error: `FinMind margin API 今日無資料` };
    
    const latest = data[data.length - 1];
    const marginBalance = latest.MarginPurchaseTodayBalance;
    const marginLimit = latest.MarginPurchaseLimit;
    const shortBalance = latest.ShortSaleTodayBalance;
    const isoDate = latest.date;
    
    const source = 'FinMind (TPEx)';
    return {
      marginBalance: { value: marginBalance, source, date: isoDate },
      marginUsageRate: { value: (marginBalance && marginLimit) ? marginBalance / marginLimit : null, source, date: isoDate },
      shortBalance: { value: shortBalance, source, date: isoDate },
      shortToMarginRatio: { value: (shortBalance != null && marginBalance) ? shortBalance / marginBalance : null, source, date: isoDate },
    };
  } catch (e) {
    return { error: `TPEx 融資融券查詢發生例外：${e.message}` };
  }
}

async function fetchInstitutionalFlowTpex(stockCode, env) {
  try {
    const url = getFinMindUrl('TaiwanStockInstitutionalInvestorsBuySell', stockCode, env);
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (!res.ok) return { error: `FinMind institutional API 請求失敗：HTTP ${res.status}` };
    const json = await res.json();
    if (json.status !== 200) return { error: `FinMind institutional API 返回錯誤：${json.msg || '未知錯誤'}` };
    const data = json.data;
    if (!data || data.length === 0) return { error: `FinMind institutional API 今日無資料` };
    
    const byDate = {};
    for (const row of data) {
      if (!byDate[row.date]) {
        byDate[row.date] = { foreignNet: 0, trustNet: 0, dealerNet: 0 };
      }
      const net = row.buy - row.sell;
      if (row.name === 'Foreign_Investor' || row.name === 'Foreign_Dealer_Self') {
        byDate[row.date].foreignNet += net;
      } else if (row.name === 'Investment_Trust') {
        byDate[row.date].trustNet += net;
      } else if (row.name === 'Dealer_self' || row.name === 'Dealer_Hedging') {
        byDate[row.date].dealerNet += net;
      }
    }
    
    const sortedDates = Object.keys(byDate).sort().reverse();
    const latestDates = sortedDates.slice(0, 5);
    if (latestDates.length === 0) return { error: `FinMind institutional API 解析後無有效交易日` };
    
    const days = latestDates.map(date => ({
      date,
      foreignNet: byDate[date].foreignNet,
      trustNet: byDate[date].trustNet,
      dealerNet: byDate[date].dealerNet,
    }));
    
    const source = 'FinMind (TPEx)';
    const sum = (key) => days.reduce((s, d) => s + d[key], 0);
    
    let foreignStreak = 0;
    for (const d of days) {
      const sign = Math.sign(d.foreignNet);
      if (foreignStreak === 0) foreignStreak = sign;
      else if (Math.sign(d.foreignNet) !== Math.sign(foreignStreak)) break;
      else foreignStreak += sign;
    }
    
    return {
      period: '近5日',
      days: { value: days, source },
      foreignNet5d: { value: sum('foreignNet'), source, date: days[0]?.date },
      trustNet5d: { value: sum('trustNet'), source, date: days[0]?.date },
      dealerNet5d: { value: sum('dealerNet'), source, date: days[0]?.date },
      foreignConsecutiveDays: { value: foreignStreak, source, date: days[0]?.date },
    };
  } catch (e) {
    return { error: `TPEx 三大法人查詢發生例外：${e.message}` };
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) {
    return json({ error: '股票代號格式不正確' }, 400);
  }
  const stockCode = stockCodeFromSymbol(symbol);
  let isTpex = /\.TWO$/i.test(symbol);

  // MI_MARGN/TDCC/T86 all update at most once per trading day, but this handler re-fetches and
  // re-parses a ~68k-line TDCC CSV plus up to 12 sequential T86 requests on every call — cache the
  // response for a few minutes so repeat lookups (or abuse) don't multiply that cost per visitor.
  const cache = caches.default;
  const cacheKey = new Request(`https://elan-quant-cache.internal/chip/${isTpex ? 'tpex' : 'twse'}/${stockCode}`, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let margin, holders, institutional;
  if (isTpex) {
    [margin, holders, institutional] = await Promise.all([
      fetchMarginTpex(stockCode, env),
      fetchHolderDistribution(stockCode, env, context),
      fetchInstitutionalFlowTpex(stockCode, env),
    ]);
  } else {
    [margin, holders, institutional] = await Promise.all([
      fetchMargin(stockCode),
      fetchHolderDistribution(stockCode, env, context),
      fetchInstitutionalFlow(stockCode),
    ]);
    const isNotFoundOnTwse = (margin.error && margin.error.includes('找不到股票代號')) || 
                             (institutional.error && institutional.error.includes('找不到股票代號'));
    if (isNotFoundOnTwse) {
      const [marginTpex, institutionalTpex] = await Promise.all([
        fetchMarginTpex(stockCode, env),
        fetchInstitutionalFlowTpex(stockCode, env),
      ]);
      if (!marginTpex.error || !institutionalTpex.error) {
        margin = marginTpex;
        institutional = institutionalTpex;
        isTpex = true;
      }
    }
  }

  const response = json({ margin, holders, institutional }, 200, { 'Cache-Control': 'public, max-age=300' });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
