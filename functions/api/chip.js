// 籌碼面：融資融券、大戶持股結構、三大法人買賣超。
// 全部即時查詢官方來源（不強制依賴 D1），每個欄位都帶 {value, source, date}，
// 任何一段抓取失敗就回傳 {error: 完整錯誤訊息}，前端顯示「暫無資料」，不吞錯誤、不補假數字。
const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,15}$/;
const BROWSER_HEADERS = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; ElanQuant/1.0)' };

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

async function fetchMargin(stockCode) {
  try {
    const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN', { headers: BROWSER_HEADERS });
    if (!res.ok) return { error: `TWSE MI_MARGN 請求失敗：HTTP ${res.status}` };
    const arr = await res.json();
    if (!Array.isArray(arr)) return { error: 'TWSE MI_MARGN 回應格式不是陣列，可能是端點已變更' };
    const row = arr.find(r => (r['股票代號'] || '').trim() === stockCode);
    if (!row) return { error: `TWSE MI_MARGN 今日資料中找不到股票代號 ${stockCode}（可能非上市股票，或今日無交易）` };
    const parseNum = v => { const n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : null; };
    const marginBalance = parseNum(row['融資今日餘額']);
    const marginLimit = parseNum(row['融資限額']);
    const shortBalance = parseNum(row['融券今日餘額']);
    const today = new Date().toISOString().slice(0, 10);
    const source = 'TWSE MI_MARGN';
    return {
      marginBalance: { value: marginBalance, source, date: today },
      marginUsageRate: { value: (marginBalance != null && marginLimit) ? marginBalance / marginLimit : null, source, date: today },
      shortBalance: { value: shortBalance, source, date: today },
      shortToMarginRatio: { value: (shortBalance != null && marginBalance) ? shortBalance / marginBalance : null, source, date: today },
    };
  } catch (e) {
    return { error: `TWSE MI_MARGN 請求發生例外：${e.message}` };
  }
}

async function fetchHolderDistribution(stockCode, env) {
  try {
    const res = await fetch('https://opendata.tdcc.com.tw/getOD.ashx?id=1-5', { headers: BROWSER_HEADERS });
    if (!res.ok) return { error: `TDCC 集保股權分散表請求失敗：HTTP ${res.status}` };
    const text = await res.text();
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
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (cols[idx.code]?.trim() !== stockCode) continue;
      const level = parseInt(cols[idx.level], 10);
      const pct = parseFloat(cols[idx.pct]);
      dataDate = cols[idx.date]?.trim();
      if (level === 15) bigHolderPct = isFinite(pct) ? pct : null;
      if (level === 12 || level === 13 || level === 14) { midHolderPct += isFinite(pct) ? pct : 0; foundMid++; }
    }
    if (dataDate == null) return { error: `TDCC 資料中找不到證券代號 ${stockCode}` };
    const isoDate = isoFromRocOrAd(dataDate);
    const source = 'TDCC 集保股權分散表';

    let weeklyChange = { value: null, source, note: '暫無資料（歷史快照尚未累積滿2週）' };
    if (env?.ELAN_QUANT_DB) {
      try {
        const prev = await env.ELAN_QUANT_DB
          .prepare('SELECT date, big_holder_pct FROM holder_weekly_snapshot WHERE code = ? AND date < ? ORDER BY date DESC LIMIT 1')
          .bind(stockCode, dataDate)
          .first();
        if (prev && prev.big_holder_pct != null && bigHolderPct != null) {
          weeklyChange = { value: bigHolderPct - prev.big_holder_pct, source, date: isoDate, comparedTo: isoFromRocOrAd(prev.date) };
        }
      } catch (e) {
        weeklyChange = { value: null, source, note: `查詢歷史快照失敗：${e.message}` };
      }
    } else {
      weeklyChange = { value: null, source, note: '暫無資料（D1 尚未綁定，無法比對歷史週快照）' };
    }

    return {
      bigHolderPct: { value: bigHolderPct, source, date: isoDate },
      midHolderPct: { value: foundMid > 0 ? midHolderPct : null, source, date: isoDate },
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

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) {
    return json({ error: '股票代號格式不正確' }, 400);
  }
  const stockCode = stockCodeFromSymbol(symbol);

  // MI_MARGN/TDCC/T86 all update at most once per trading day, but this handler re-fetches and
  // re-parses a ~68k-line TDCC CSV plus up to 12 sequential T86 requests on every call — cache the
  // response for a few minutes so repeat lookups (or abuse) don't multiply that cost per visitor.
  const cache = caches.default;
  const cacheKey = new Request(`https://elan-quant-cache.internal/chip/${stockCode}`, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const [margin, holders, institutional] = await Promise.all([
    fetchMargin(stockCode),
    fetchHolderDistribution(stockCode, env),
    fetchInstitutionalFlow(stockCode),
  ]);

  const response = json({ margin, holders, institutional }, 200, { 'Cache-Control': 'public, max-age=300' });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
