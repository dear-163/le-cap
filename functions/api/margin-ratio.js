// 台股大盤融資使用率 = 全市場融資今日餘額 ÷ 全市場融資限額 × 100%
// 這是「整個市場有多少融資額度被用掉」的槓桿/投機熱度量尺，不是融資維持率（現有部位
// 離斷頭多近）——兩者是不同的問題，維持率低不代表槓桿多，使用率高才是。
// 資料來源：TWSE 信用交易統計表的個股明細（tables[1]），每一列本來就同時有「融資今日
// 餘額」跟「次一營業日限額」兩欄，市場加總兩欄相除即可，不需要另外查股價或用到D1。
import { saveSnapshot, loadSnapshotFallback } from '../_lib/kvSnapshot.js';

const BROWSER_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Referer': 'https://www.twse.com.tw/',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function toAdDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
function isoFromAd(s) {
  return s && s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}
function parseNum(v) {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

async function fetchMarginTradingForDate(adDate) {
  const url = `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date=${adDate}&selectType=ALL`;
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  if (body && body.stat === 'OK' && Array.isArray(body.tables) && body.tables.length >= 2) {
    return body;
  }
  return null;
}

function computeUsageRatio(body) {
  const detailTable = body.tables[1];
  const rows = detailTable.data || [];
  let totalBalance = 0, totalLimit = 0, matchedStocks = 0;
  for (const row of rows) {
    const code = (row[0] || '').trim();
    const balanceLots = parseNum(row[6]); // 融資今日餘額，單位「張」
    const limitLots = parseNum(row[7]); // 次一營業日限額，單位「張」
    if (!code || balanceLots == null || limitLots == null || limitLots <= 0) continue;
    totalBalance += balanceLots;
    totalLimit += limitLots;
    matchedStocks++;
  }
  if (matchedStocks === 0 || totalLimit === 0) return null;
  return {
    ratio: Math.round((totalBalance / totalLimit) * 100 * 100) / 100,
    totalBalance,
    totalLimit,
    matchedStocks,
  };
}

// TWSE這個端點本身就支援指定歷史日期查詢（date=YYYYMMDD），不需要另外存D1累積歷史——
// 跟原本「只抓最新一天，往回找到有效資料為止」是同一種寫法，差別只在於找滿N天才停，不是
// 找到1天就停。掃描上限抓寬一點（連假很少連續超過一週）。
const HISTORY_DAYS = 3;
const MAX_SCAN_ATTEMPTS = 20;

async function fetchRecentMarginTradingDays(n) {
  const cursor = new Date();
  const results = [];
  for (let attempts = 0; attempts < MAX_SCAN_ATTEMPTS && results.length < n; attempts++) {
    const dow = cursor.getUTCDay();
    if (dow === 0 || dow === 6) { cursor.setUTCDate(cursor.getUTCDate() - 1); continue; }
    const adDate = toAdDate(cursor);
    const body = await fetchMarginTradingForDate(adDate);
    if (body) {
      const usage = computeUsageRatio(body);
      if (usage) results.push({ date: isoFromAd(body.date || adDate), ...usage });
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return results; // 新到舊排序
}

export async function onRequestGet(context) {
  const { env } = context;

  try {
    const days = await fetchRecentMarginTradingDays(HISTORY_DAYS);
    if (days.length === 0) {
      return json({ error: '近期交易日的 TWSE 信用交易統計（融資融券餘額）皆無法取得有效資料，請稍後再試' }, 502);
    }

    const latest = days[0];
    const result = {
      date: latest.date,
      source: 'TWSE 信用交易統計（融資融券餘額，個股明細加總）',
      ratio: latest.ratio,
      totalBalance: latest.totalBalance,
      totalLimit: latest.totalLimit,
      matchedStocks: latest.matchedStocks,
      // 舊到新排序，方便前端直接畫成由左到右的比較列
      history: days.slice().reverse().map(d => ({ date: d.date, ratio: d.ratio })),
    };
    context.waitUntil(saveSnapshot(env, 'margin-ratio', result));
    return json(result);
  } catch (error) {
    const fallback = await loadSnapshotFallback(env, 'margin-ratio');
    if (fallback) return json(fallback);
    return json({ error: `查詢台股融資使用率失敗：${error.message}` }, 500);
  }
}
