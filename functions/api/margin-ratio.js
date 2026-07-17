// 台股大盤融資維持率 = 全市場融資擔保品市值 ÷ 全市場融資金額 × 100%
// 公式與官方資料來源都經過查證（不是自己拍腦袋湊的近似值）：
//   - 分母「融資金額」：TWSE 官方信用交易統計表本身就有現成的市場總額（仟元），不用自己加總推算。
//   - 分子「擔保品市值」：同一個 TWSE 端點的個股明細表給每檔股票的融資今日餘額（張），
//     乘上該股最新收盤價（來自 stock_daily_price）加總得出，沒有收盤價的股票就跳過不計入。
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

async function fetchLatestMarginTrading() {
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
        return { body, adDate };
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return null;
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.ELAN_QUANT_DB) {
    return json({ error: 'D1 database binding (ELAN_QUANT_DB) not found.' }, 500);
  }

  try {
    const found = await fetchLatestMarginTrading();
    if (!found) {
      return json({ error: '近期交易日的 TWSE 信用交易統計（融資融券餘額）皆無法取得有效資料，請稍後再試' }, 502);
    }
    const { body, adDate } = found;

    const summaryTable = body.tables[0];
    const marginAmountRow = (summaryTable.data || []).find(r => (r[0] || '').includes('融資金額'));
    if (!marginAmountRow) {
      return json({ error: 'TWSE 信用交易統計表格式跟預期不符（找不到融資金額列）' }, 502);
    }
    const marginAmountThousandNTD = parseNum(marginAmountRow[5]); // 今日餘額欄位，單位仟元
    if (marginAmountThousandNTD == null) {
      return json({ error: 'TWSE 融資金額今日餘額欄位無法解析' }, 502);
    }
    const marginAmountNTD = marginAmountThousandNTD * 1000;

    const detailTable = body.tables[1];
    const rows = detailTable.data || [];

    const priceRows = await env.ELAN_QUANT_DB
      .prepare(`
        SELECT p.code, p.close
        FROM stock_daily_price p
        INNER JOIN (SELECT code, MAX(date) as max_date FROM stock_daily_price GROUP BY code) m
          ON p.code = m.code AND p.date = m.max_date
      `)
      .all();
    const priceMap = {};
    for (const p of (priceRows.results || [])) priceMap[p.code] = p.close;

    let collateralValue = 0;
    let matchedStocks = 0, skippedNoPrice = 0;
    for (const row of rows) {
      const code = (row[0] || '').trim();
      const marginLots = parseNum(row[6]); // 融資今日餘額，單位「張」（1張=1000股）
      if (!code || !marginLots || marginLots === 0) continue;
      const price = priceMap[code];
      if (price == null) { skippedNoPrice++; continue; }
      collateralValue += marginLots * 1000 * price;
      matchedStocks++;
    }

    if (matchedStocks === 0) {
      return json({ error: '沒有任何融資個股能找到對應收盤價，無法計算擔保品市值' }, 502);
    }

    const ratio = (collateralValue / marginAmountNTD) * 100;

    const result = {
      date: isoFromAd(body.date || adDate),
      source: 'TWSE 信用交易統計（融資融券餘額）',
      ratio: Math.round(ratio * 100) / 100,
      collateralValue,
      marginAmount: marginAmountNTD,
      matchedStocks,
      skippedNoPrice,
    };
    context.waitUntil(saveSnapshot(env, 'margin-ratio', result));
    return json(result);
  } catch (error) {
    const fallback = await loadSnapshotFallback(env, 'margin-ratio');
    if (fallback) return json(fallback);
    return json({ error: `查詢台股融資維持率失敗：${error.message}` }, 500);
  }
}
