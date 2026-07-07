// US-market equivalent of chip.js. Taiwan's 融資融券/集保股權分散/三大法人 are TWSE/TDCC-specific —
// the US has no daily equivalent (see README). The closest official/regulatory concepts are:
//   - Institutional ownership: SEC Form 13F, filed quarterly (45-day lag after quarter end)
//   - Insider trading: SEC Form 4, filed within 2 business days of a transaction
// Both are sourced via FMP (already used elsewhere in this app), NOT scraped from SEC EDGAR directly.
// FINRA short-interest data (bi-monthly) has no FMP endpoint as of this writing — would require
// parsing FINRA's raw bulk files, a separate and more fragile undertaking, so it's out of scope here.
const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,15}$/;

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } });
}

// 13F filings are due 45 days after quarter end (SEC deadline). Add a few days' safety buffer for
// FMP to have actually ingested the filing before treating a quarter as "available".
function latestAvailable13F(now) {
  const y = now.getUTCFullYear();
  const candidates = [];
  for (const yr of [y - 1, y]) {
    candidates.push({ year: yr - 1, quarter: 4, deadline: Date.UTC(yr, 1, 18) });  // Q4 prior year, due ~Feb 14
    candidates.push({ year: yr, quarter: 1, deadline: Date.UTC(yr, 4, 19) });      // Q1, due ~May 15
    candidates.push({ year: yr, quarter: 2, deadline: Date.UTC(yr, 7, 18) });      // Q2, due ~Aug 14
    candidates.push({ year: yr, quarter: 3, deadline: Date.UTC(yr, 10, 18) });     // Q3, due ~Nov 14
  }
  const nowMs = now.getTime();
  const valid = candidates.filter(c => c.deadline <= nowMs).sort((a, b) => b.deadline - a.deadline);
  return valid[0] || null;
}

async function fetchInstitutionalOwnership(symbol, fmpKey) {
  const q = latestAvailable13F(new Date());
  if (!q) return { error: '無法判斷最新可用的13F申報季度' };
  try {
    const res = await fetch(`https://financialmodelingprep.com/stable/institutional-ownership/symbol-positions-summary?symbol=${symbol}&year=${q.year}&quarter=${q.quarter}&apikey=${fmpKey}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `FMP institutional-ownership 請求失敗：HTTP ${res.status}${body?.['Error Message'] ? '（' + body['Error Message'] + '）' : ''}` };
    }
    const body = await res.json();
    if (body?.['Error Message']) return { error: `FMP institutional-ownership：${body['Error Message']}` };
    const row = Array.isArray(body) ? body[0] : body;
    if (!row) return { error: `FMP 尚無 ${symbol} ${q.year}Q${q.quarter} 的機構持股資料（可能該季申報尚未涵蓋此股票）` };
    const source = `FMP（SEC 13F，${q.year}年第${q.quarter}季申報）`;
    const dateLabel = `${q.year}Q${q.quarter}`;
    return {
      ownershipPercent: { value: row.ownershipPercent ?? null, source, date: dateLabel },
      investorsHolding: { value: row.investorsHolding ?? null, source, date: dateLabel },
      investorsHoldingChange: { value: row.investorsHoldingChange ?? null, source, date: dateLabel },
      totalInvested: { value: row.totalInvested ?? null, source, date: dateLabel },
    };
  } catch (e) {
    return { error: `FMP institutional-ownership 請求發生例外：${e.message}` };
  }
}

async function fetchInsiderTradingStats(symbol, fmpKey) {
  try {
    const res = await fetch(`https://financialmodelingprep.com/stable/insider-trading/statistics?symbol=${symbol}&apikey=${fmpKey}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `FMP insider-trading/statistics 請求失敗：HTTP ${res.status}${body?.['Error Message'] ? '（' + body['Error Message'] + '）' : ''}` };
    }
    const body = await res.json();
    if (body?.['Error Message']) return { error: `FMP insider-trading/statistics：${body['Error Message']}` };
    const row = Array.isArray(body) ? body[0] : body;
    if (!row) return { error: `FMP 尚無 ${symbol} 的內部人交易統計資料` };
    const source = 'FMP（SEC Form 4 內部人申報彙總）';
    const dateLabel = row.year && row.quarter ? `${row.year}Q${row.quarter}` : null;
    const acquired = row.totalAcquired ?? row.acquired ?? null;
    const disposed = row.totalDisposed ?? row.disposed ?? null;
    return {
      totalAcquired: { value: acquired, source, date: dateLabel },
      totalDisposed: { value: disposed, source, date: dateLabel },
      netShares: { value: (acquired != null && disposed != null) ? acquired - disposed : null, source, date: dateLabel },
    };
  } catch (e) {
    return { error: `FMP insider-trading/statistics 請求發生例外：${e.message}` };
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  const fmpKey = (url.searchParams.get('fmpKey') || '').trim() || env.FMP_KEY;
  if (!SYMBOL_RE.test(symbol)) {
    return json({ error: '股票代號格式不正確' }, 400);
  }
  if (!fmpKey) {
    return json({
      institutional: { error: '需要 FMP API Key 才能查詢機構持股資料（台股籌碼面不需要 Key，但美股的 13F/內部人資料只能透過 FMP 取得）' },
      insider: { error: '需要 FMP API Key 才能查詢內部人交易資料' },
    });
  }

  // 13F is quarterly and insider-trading stats change slowly — cache generously to conserve FMP's
  // 250/day free-tier quota, matching ground.js's rationale for the same tradeoff.
  const cache = caches.default;
  const cacheKey = new Request(`https://elan-quant-cache.internal/chip-us/${symbol}`, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const [institutional, insider] = await Promise.all([
    fetchInstitutionalOwnership(symbol, fmpKey),
    fetchInsiderTradingStats(symbol, fmpKey),
  ]);

  const gotRealData = !institutional.error || !insider.error;
  const response = json({ institutional, insider }, 200, gotRealData ? { 'Cache-Control': 'public, max-age=3600' } : {});
  if (gotRealData) {
    context.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}
