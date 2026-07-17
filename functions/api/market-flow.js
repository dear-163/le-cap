// 台股大盤三大法人（外資+投信+自營商合計）當日買賣超金額排行——跟 active-etf-flow.js
// 的「主動式 ETF 經理人加減碼」是完全不同的兩件事：這裡是全市場、以官方 TWSE T86
// 申報資料為準，不依賴任何主動式 ETF 的持股爬蟲來源。
import { saveSnapshot, loadSnapshotFallback } from '../_lib/kvSnapshot.js';

const BROWSER_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Referer': 'https://www.tpex.org.tw/',
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
function isoFromRocOrAd(dateStr) {
  const s = String(dateStr || '').trim();
  if (s.length === 7) {
    const y = parseInt(s.slice(0, 3), 10) + 1911;
    return `${y}-${s.slice(3, 5)}-${s.slice(5, 7)}`;
  }
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}
function parseNum(v) {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isFinite(n) ? n : 0;
}

// 從今天往前找最近一個有效交易日的 T86 全市場資料（跳過週末；遇到假日/尚未結算會拿到
// stat!=='OK'，直接跳過往前一天試，最多試 10 天）。
async function fetchLatestT86All() {
  const cursor = new Date();
  for (let attempts = 0; attempts < 10; attempts++) {
    const dow = cursor.getUTCDay();
    if (dow === 0 || dow === 6) { cursor.setUTCDate(cursor.getUTCDate() - 1); continue; }
    const adDate = toAdDate(cursor);
    const url = `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${adDate}&selectType=ALL`;
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (body && body.stat === 'OK' && Array.isArray(body.data) && body.data.length > 0) {
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
    const found = await fetchLatestT86All();
    if (!found) {
      return json({ error: '近期交易日的 TWSE T86（三大法人買賣超）皆無法取得有效資料，請稍後再試' }, 502);
    }
    const { body, adDate } = found;

    const codeIdx = body.fields.indexOf('證券代號');
    const nameIdx = body.fields.indexOf('證券名稱');
    const netIdx = body.fields.indexOf('三大法人買賣超股數');
    if ([codeIdx, nameIdx, netIdx].some(i => i === -1)) {
      return json({ error: `TWSE T86 欄位與預期不符，實際欄位：${body.fields.join('、')}` }, 502);
    }

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

    const changes = [];
    for (const row of body.data) {
      const code = (row[codeIdx] || '').trim();
      const netShares = parseNum(row[netIdx]);
      if (!code || netShares === 0) continue;
      const price = priceMap[code];
      // 沒有收盤價（例如興櫃、當日剛掛牌、或非台股主板證券）就跳過，不用猜的價格排名。
      if (price == null) continue;
      changes.push({
        code,
        name: (row[nameIdx] || '').trim(),
        netShares,
        netAmount: netShares * price,
      });
    }

    const buys = changes.filter(c => c.netAmount > 0).sort((a, b) => b.netAmount - a.netAmount).slice(0, 5);
    const sells = changes.filter(c => c.netAmount < 0).sort((a, b) => a.netAmount - b.netAmount).slice(0, 5);

    const result = {
      date: isoFromRocOrAd(body.date || adDate),
      source: 'TWSE T86（三大法人買賣超日報）',
      buys,
      sells,
    };
    context.waitUntil(saveSnapshot(env, 'market-flow', result));
    return json(result);
  } catch (error) {
    const fallback = await loadSnapshotFallback(env, 'market-flow');
    if (fallback) return json(fallback);
    return json({ error: `查詢台股三大法人買賣超排行失敗：${error.message}` }, 500);
  }
}
