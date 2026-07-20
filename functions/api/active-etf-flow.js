import { saveSnapshot, loadSnapshotFallback } from '../_lib/kvSnapshot.js';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

// shares 可能是 NULL（該發行公司只揭露 weight%，見 etf_portfolio_value 的註解）。這種情況下
// 用 weight 的變化方向判斷加碼/減碼，並回傳 weightBasedAmount：用「weight變化% × 股票總
// 市值」換算的估計金額（呼叫端沒有真實股數/價格可用時，拿它當 changeAmount 並標示 estimated）。
function computeChangeAndAction(t, y, labels, portfolioValueMap, todayDate, yesterdayDate, etfCodeForValue) {
  const sharesKnown = (t ? t.shares != null : true) && (y ? y.shares != null : true) && (t || y);
  let changeShares = null, changeWeight = null, action = labels.none, weightBasedAmount = null;

  if (sharesKnown) {
    changeShares = (t ? t.shares : 0) - (y ? y.shares : 0);
    changeWeight = (t ? t.weight : 0) - (y ? y.weight : 0);
    action = changeShares > 0 ? labels.up : (changeShares < 0 ? labels.down : labels.flat);
  } else if (t || y) {
    changeWeight = (t ? t.weight : 0) - (y ? y.weight : 0);
    action = changeWeight > 0 ? labels.up : (changeWeight < 0 ? labels.down : labels.flat);

    const svToday = portfolioValueMap[etfCodeForValue]?.[todayDate];
    const svYesterday = portfolioValueMap[etfCodeForValue]?.[yesterdayDate];
    const valToday = t ? (svToday != null ? (t.weight / 100) * svToday : null) : 0;
    const valYesterday = y ? (svYesterday != null ? (y.weight / 100) * svYesterday : null) : 0;
    if (valToday != null && valYesterday != null) weightBasedAmount = valToday - valYesterday;
  }

  return { changeShares, changeWeight, action, weightBasedAmount };
}

function hasFlowSignal(f) {
  if (f.changeShares != null) return f.changeShares !== 0 || f.shares > 0;
  if (f.changeWeight != null) return f.changeWeight !== 0 || f.weight > 0;
  return (f.shares > 0) || (f.weight > 0);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();

  if (!env.ELAN_QUANT_DB) {
    return json({ error: 'D1 database binding (ELAN_QUANT_DB) not found.' }, 500);
  }

  try {
    // 1. Get the latest two dates available in active_etf_holdings
    const dateRows = await env.ELAN_QUANT_DB
      .prepare('SELECT DISTINCT date FROM active_etf_holdings ORDER BY date DESC LIMIT 2')
      .all();

    if (!dateRows.results || dateRows.results.length === 0) {
      return json({ date: null, flow: [], rankings: { buys: [], sells: [] } });
    }

    const todayDate = dateRows.results[0].date;
    const yesterdayDate = dateRows.results[1] ? dateRows.results[1].date : null;

    // "最新兩個日期" 是全表共用的，但個別 ETF 不一定兩個日期都有資料（例如剛換資料來源、
    // 或某天爬蟲失敗）。如果某檔 ETF 昨天完全沒有任何持股紀錄，不能把它今天的每一檔持股都當成
    // 「昨天是 0 股，今天全部都是新買進」——那只是我們昨天沒抓到資料，不是真的建倉。這種情況下
    // 該 ETF 今天的比較要整批視為「無比較資料」，而不是逐檔算出一個看起來像加碼的假訊號。
    //
    // 同理，反過來也要擋：如果某檔 ETF 今天完全沒有任何持股紀錄（該次爬蟲失敗，比昨天單純
    // 少一天資料），computeChangeAndAction 收到 t=null 會把它當成「今天股數是0」，昨天的
    // 真實股數就會被算成「全部賣光」的假訊號——這正是2026-07-12那次多家ETF爬蟲失敗時
    // 實際發生的案例（00982A等8檔ETF當天完全沒有任何列，被誤判成清空持股）。
    let etfsWithYesterdayData = new Set();
    let etfsWithTodayData = new Set();
    if (yesterdayDate) {
      const etfYRows = await env.ELAN_QUANT_DB
        .prepare('SELECT DISTINCT etf_code FROM active_etf_holdings WHERE date = ?')
        .bind(yesterdayDate)
        .all();
      etfsWithYesterdayData = new Set((etfYRows.results || []).map(r => r.etf_code));
    }
    {
      const etfTRows = await env.ELAN_QUANT_DB
        .prepare('SELECT DISTINCT etf_code FROM active_etf_holdings WHERE date = ?')
        .bind(todayDate)
        .all();
      etfsWithTodayData = new Set((etfTRows.results || []).map(r => r.etf_code));
    }

    // Fetch each code's most recent close only (not the full 245-day history) — a plain
    // unordered SELECT here previously let whichever row D1 happened to return last for a
    // given code win, which in practice was often a stale price over a year old (e.g. TSMC's
    // 2025-06-11 close of 1065 instead of its actual latest close of ~2460).
    const priceRows = await env.ELAN_QUANT_DB
      .prepare(`
        SELECT p.code, p.close, p.name
        FROM stock_daily_price p
        INNER JOIN (
          SELECT code, MAX(date) as max_date
          FROM stock_daily_price
          GROUP BY code
        ) m ON p.code = m.code AND p.date = m.max_date
      `)
      .all();
    const priceMap = {};
    const nameMap = {};
    if (priceRows.results) {
      for (const p of priceRows.results) {
        priceMap[p.code] = p.close;
        if (p.name) nameMap[p.code] = p.name;
      }
    }

    // 少數發行公司（目前僅國泰投信）只揭露持股權重%、不揭露股數，這種來源的 holdings 列
    // shares 是 NULL。這張表存的是那些 ETF 每日「股票資產總市值」，用來把 weight 的變化
    // 換算成估計金額（weight變化% × 當天股票總市值），下面所有分支算金額時都會用到。
    const portfolioValueRows = await env.ELAN_QUANT_DB
      .prepare('SELECT etf_code, date, stock_value FROM etf_portfolio_value WHERE date IN (?, ?)')
      .bind(todayDate, yesterdayDate || todayDate)
      .all();
    const portfolioValueMap = {}; // etf_code -> { [date]: stock_value }
    for (const r of (portfolioValueRows.results || [])) {
      if (!portfolioValueMap[r.etf_code]) portfolioValueMap[r.etf_code] = {};
      portfolioValueMap[r.etf_code][r.date] = r.stock_value;
    }

    // IF symbol is specified: return specific stock flow or active ETF flow (Option A/C)
    if (symbol) {
      const cleanSymbol = symbol.replace(/\.(TW|TWO)$/i, '');
      const isEtf = /^\d{5}[A-Z]$/i.test(cleanSymbol);

      if (isEtf) {
        const etfCode = cleanSymbol;
        const querySql = yesterdayDate
          ? 'SELECT stock_code, shares, weight, date, etf_name FROM active_etf_holdings WHERE etf_code = ? AND date IN (?, ?)'
          : 'SELECT stock_code, shares, weight, date, etf_name FROM active_etf_holdings WHERE etf_code = ? AND date = ?';
        
        const bindings = yesterdayDate ? [etfCode, todayDate, yesterdayDate] : [etfCode, todayDate];
        const records = await env.ELAN_QUANT_DB.prepare(querySql).bind(...bindings).all();
        const list = records.results || [];
        
        const etfHasYesterday = etfsWithYesterdayData.has(etfCode);
        const etfName = list[0]?.etf_name || '主動式 ETF';
        const stockMap = {};
        for (const r of list) {
          if (!stockMap[r.stock_code]) {
            stockMap[r.stock_code] = { stock_code: r.stock_code, today: null, yesterday: null };
          }
          if (r.date === todayDate) stockMap[r.stock_code].today = r;
          else stockMap[r.stock_code].yesterday = r;
        }

        const missingPriceCodes = [];
        for (const code in stockMap) {
          if (priceMap[code] == null) {
            missingPriceCodes.push(code);
          }
        }
        if (missingPriceCodes.length > 0) {
          const yahooPrices = await fetchMissingPricesFromYahoo(missingPriceCodes, env);
          for (const code in yahooPrices) {
            priceMap[code] = yahooPrices[code];
          }
        }

        const flow = [];
        for (const code in stockMap) {
          const item = stockMap[code];
          const t = item.today;
          const y = item.yesterday;

          if (!t) continue;

          let changeShares = null, changeWeight = null, action = '無比較資料', changeAmount = null, amountEstimated = false;

          const price = priceMap[code] || null;
          if (etfHasYesterday) {
            const r = computeChangeAndAction(t, y, { up: '加碼', down: '減碼', flat: '無變動', none: '無比較資料' }, portfolioValueMap, todayDate, yesterdayDate, etfCode);
            changeShares = r.changeShares;
            changeWeight = r.changeWeight;
            action = r.action;
            if (price != null && changeShares != null) {
              changeAmount = changeShares * price;
            } else if (r.weightBasedAmount != null) {
              changeAmount = r.weightBasedAmount;
              amountEstimated = true;
            }
          }

          const svToday = portfolioValueMap[etfCode]?.[todayDate];
          const totalAmount = (price != null && t.shares != null)
            ? t.shares * price
            : (svToday != null ? (t.weight / 100) * svToday : null);
          const totalAmountEstimated = !(price != null && t.shares != null) && totalAmount != null;

          flow.push({
            stockCode: code,
            stockName: nameMap[code] || code,
            action,
            shares: t.shares,
            weight: t.weight,
            changeShares,
            changeWeight,
            changeAmount,
            amountEstimated: amountEstimated || undefined,
            totalAmount,
            totalAmountEstimated: totalAmountEstimated || undefined,
            date: todayDate,
            comparedTo: etfHasYesterday ? yesterdayDate : null
          });
        }

        return json({
          date: todayDate,
          comparedTo: etfHasYesterday ? yesterdayDate : null,
          isEtf: true,
          etfCode,
          etfName,
          flow: etfHasYesterday ? flow.filter(hasFlowSignal) : flow
        });
      }

      // Default stock query
      const match = symbol.match(/^(\d{4,6})/);
      if (!match) {
        return json({ date: todayDate, symbol, flow: [], note: '非台股純數字代號，暫不支援主動式 ETF 追蹤。' });
      }
      const stockCode = match[1];
      let price = priceMap[stockCode] || null;
      if (price == null) {
        const yahooPrices = await fetchMissingPricesFromYahoo([stockCode], env);
        price = yahooPrices[stockCode] || null;
      }

      // Query database for this stock on these dates
      const querySql = yesterdayDate
        ? 'SELECT etf_code, etf_name, shares, weight, date FROM active_etf_holdings WHERE stock_code = ? AND date IN (?, ?)'
        : 'SELECT etf_code, etf_name, shares, weight, date FROM active_etf_holdings WHERE stock_code = ? AND date = ?';
      
      const bindings = yesterdayDate ? [stockCode, todayDate, yesterdayDate] : [stockCode, todayDate];
      const records = await env.ELAN_QUANT_DB.prepare(querySql).bind(...bindings).all();

      const list = records.results || [];
      const etfMap = {};

      for (const r of list) {
        if (!etfMap[r.etf_code]) {
          etfMap[r.etf_code] = { etf_code: r.etf_code, etf_name: r.etf_name, today: null, yesterday: null };
        }
        if (r.date === todayDate) etfMap[r.etf_code].today = r;
        else etfMap[r.etf_code].yesterday = r;
      }

      const flow = [];
      for (const code in etfMap) {
        const item = etfMap[code];
        // 這檔ETF今天完全沒有任何持股紀錄（例如那次爬蟲失敗），不能顯示成「今天持股0股」
        // 再對比昨天的真實股數算出一個「全部賣光」的假訊號——直接跳過這檔ETF，不納入這次比較。
        if (!etfsWithTodayData.has(item.etf_code)) continue;
        const t = item.today;
        const y = item.yesterday;
        const etfHasYesterday = etfsWithYesterdayData.has(item.etf_code);

        let changeShares = null, changeWeight = null, action = '無比較資料', changeAmount = null, amountEstimated = false;

        if (etfHasYesterday) {
          const r = computeChangeAndAction(t, y, { up: '買進', down: '賣出', flat: '無變動', none: '無比較資料' }, portfolioValueMap, todayDate, yesterdayDate, item.etf_code);
          changeShares = r.changeShares;
          changeWeight = r.changeWeight;
          action = r.action;
          if (price != null && changeShares != null) {
            changeAmount = changeShares * price;
          } else if (r.weightBasedAmount != null) {
            changeAmount = r.weightBasedAmount;
            amountEstimated = true;
          }
        }

        const svToday = portfolioValueMap[item.etf_code]?.[todayDate];
        const totalAmount = t
          ? ((price != null && t.shares != null) ? t.shares * price : (svToday != null ? (t.weight / 100) * svToday : null))
          : null;
        const totalAmountEstimated = t != null && !(price != null && t.shares != null) && totalAmount != null;

        flow.push({
          etfCode: item.etf_code,
          etfName: item.etf_name,
          action,
          shares: t ? t.shares : 0,
          weight: t ? t.weight : 0,
          changeShares,
          changeWeight,
          changeAmount,
          amountEstimated: amountEstimated || undefined,
          totalAmount,
          totalAmountEstimated: totalAmountEstimated || undefined,
          date: todayDate,
          comparedTo: etfHasYesterday ? yesterdayDate : null
        });
      }

      return json({
        date: todayDate,
        comparedTo: yesterdayDate,
        symbol: stockCode,
        flow: flow.filter(hasFlowSignal)
      });
    }

    // IF symbol is NOT specified: return market-wide rankings (Option B)
    const allQuery = yesterdayDate
      ? 'SELECT etf_code, etf_name, stock_code, shares, weight, date FROM active_etf_holdings WHERE date IN (?, ?)'
      : 'SELECT etf_code, etf_name, stock_code, shares, weight, date FROM active_etf_holdings WHERE date = ?';
    
    const allBindings = yesterdayDate ? [todayDate, yesterdayDate] : [todayDate];
    const allRecords = await env.ELAN_QUANT_DB.prepare(allQuery).bind(...allBindings).all();
    const recordsList = allRecords.results || [];

    // Group by (etf_code, stock_code) — skip any ETF that has no yesterday-dated rows at all
    // (e.g. just switched data source, or a one-off cron failure) so it doesn't get diffed
    // against an effectively-empty baseline and show up as a fake full-position "buy". Same
    // guard in the other direction: skip any ETF missing from *today* entirely, otherwise its
    // real yesterday holdings get diffed against an implicit "0 today" and show up as a fake
    // full-position "sell" in the market-wide rankings (this is exactly what happened on
    // 2026-07-12 when several issuers' crawls failed for that date).
    const pairMap = {};
    for (const r of recordsList) {
      if (!etfsWithYesterdayData.has(r.etf_code) || !etfsWithTodayData.has(r.etf_code)) continue;
      const key = r.etf_code + '|' + r.stock_code;
      if (!pairMap[key]) pairMap[key] = { etf_code: r.etf_code, stock_code: r.stock_code, today: null, yesterday: null };
      if (r.date === todayDate) pairMap[key].today = r; else pairMap[key].yesterday = r;
    }

    // 只有「有真實股數」的持股才需要股價換算金額；只揭露 weight 的來源（如國泰）改用
    // portfolioValueMap 換算，不需要股價。
    const missingRankingsCodes = [];
    const seenForPrice = new Set();
    for (const key in pairMap) {
      const { stock_code, today: t, yesterday: y } = pairMap[key];
      const sharesKnown = t?.shares != null || y?.shares != null;
      if (sharesKnown && priceMap[stock_code] == null && !seenForPrice.has(stock_code)) {
        missingRankingsCodes.push(stock_code);
        seenForPrice.add(stock_code);
      }
    }
    if (missingRankingsCodes.length > 0) {
      const yahooPrices = await fetchMissingPricesFromYahoo(missingRankingsCodes, env);
      for (const code in yahooPrices) {
        priceMap[code] = yahooPrices[code];
      }
    }

    // 同一檔股票可能同時被「有股數」跟「只有權重」的 ETF 持有，兩種金額用不同方式算完後
    // 加總到同一個 stock_code——只要其中任何一筆是用權重推算的，整列就標示 estimated。
    // buyers/sellers 記錄「哪些ETF對這檔股票的貢獻方向是加碼/減碼」，用來算etfCount——
    // 幾檔不同基金經理人「獨立」同時買同一支股票，是跟總金額不同的訊號（一堆小基金各自
    // 小買，總金額不一定大，但代表操盤共識度高）。
    const stockAgg = {};
    for (const key in pairMap) {
      const { etf_code, stock_code, today: t, yesterday: y } = pairMap[key];
      if (!t && !y) continue;
      const sharesKnown = (t ? t.shares != null : true) && (y ? y.shares != null : true);
      if (!stockAgg[stock_code]) stockAgg[stock_code] = { stock_code, changeAmount: 0, estimated: false, hasAny: false, buyers: new Set(), sellers: new Set() };
      const agg = stockAgg[stock_code];

      if (sharesKnown) {
        const changeShares = (t ? t.shares : 0) - (y ? y.shares : 0);
        const price = priceMap[stock_code] || null;
        // No real price on record for this code (e.g. brand-new listing, or a TPEx holding —
        // stock_daily_price is TWSE-only) — skip rather than rank it using a guessed price.
        if (price != null && changeShares !== 0) {
          agg.changeAmount += changeShares * price;
          agg.hasAny = true;
          (changeShares > 0 ? agg.buyers : agg.sellers).add(etf_code);
        }
      } else {
        const svToday = portfolioValueMap[etf_code]?.[todayDate];
        const svYesterday = portfolioValueMap[etf_code]?.[yesterdayDate];
        const valToday = t ? (svToday != null ? (t.weight / 100) * svToday : null) : 0;
        const valYesterday = y ? (svYesterday != null ? (y.weight / 100) * svYesterday : null) : 0;
        if (valToday != null && valYesterday != null && (valToday - valYesterday) !== 0) {
          const d = valToday - valYesterday;
          agg.changeAmount += d;
          agg.estimated = true;
          agg.hasAny = true;
          (d > 0 ? agg.buyers : agg.sellers).add(etf_code);
        }
      }
    }

    const changes = [];
    for (const code in stockAgg) {
      const agg = stockAgg[code];
      if (!agg.hasAny || agg.changeAmount === 0) continue;
      changes.push({
        stock_code: code,
        stock_name: nameMap[code] || code,
        changeAmount: agg.changeAmount,
        action: agg.changeAmount > 0 ? '買超' : '賣超',
        estimated: agg.estimated || undefined,
        etfCount: (agg.changeAmount > 0 ? agg.buyers : agg.sellers).size,
      });
    }

    // Sort to find top buys and sells by changeAmount
    const buys = changes.filter(c => c.changeAmount > 0).sort((a, b) => b.changeAmount - a.changeAmount).slice(0, 5);
    const sells = changes.filter(c => c.changeAmount < 0).sort((a, b) => a.changeAmount - b.changeAmount).slice(0, 5);

    const marketWidePayload = {
      date: todayDate,
      comparedTo: yesterdayDate,
      rankings: { buys, sells }
    };
    // 首頁ETF排行卡片只用這個「無symbol」的市場全體分支，個股查詢（有symbol）先不加快照——
    // 那邊的回應結構跟這裡不同，範圍留給之後有需要再做。
    if (!symbol) context.waitUntil(saveSnapshot(env, 'active-etf-flow', marketWidePayload));
    return json(marketWidePayload);

  } catch (error) {
    if (!symbol) {
      const fallback = await loadSnapshotFallback(env, 'active-etf-flow');
      if (fallback) return json(fallback);
    }
    return json({ error: `查詢主動式 ETF 籌碼數據失敗：${error.message}` }, 500);
  }
}

const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BROWSER_HEADERS = { 
  'Accept': 'application/json', 
  'User-Agent': YAHOO_UA,
  'Referer': 'https://www.tpex.org.tw/'
};

async function getYahooCrumb(env) {
  const cacheKey = 'yahoo:crumb';
  if (env?.RATE_LIMIT_KV) {
    try {
      const cached = await env.RATE_LIMIT_KV.get(cacheKey, 'json');
      if (cached?.cookie && cached?.crumb) return cached;
    } catch {}
  }
  try {
    const cookieRes = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': YAHOO_UA } });
    const setCookie = cookieRes.headers.get('set-cookie');
    if (!setCookie) return null;
    const cookie = setCookie.split(';')[0];
    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': YAHOO_UA, 'Cookie': cookie },
    });
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.includes('<')) return null;
    const result = { cookie, crumb };
    if (env?.RATE_LIMIT_KV) {
      try { await env.RATE_LIMIT_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 1200 }); } catch {}
    }
    return result;
  } catch {
    return null;
  }
}

async function fetchMissingPricesFromYahoo(codes, env) {
  if (!codes || codes.length === 0) return {};
  const auth = await getYahooCrumb(env);
  if (!auth) return {};
  
  const ySymbols = [];
  for (const c of codes) {
    ySymbols.push(`${c}.TW`);
    ySymbols.push(`${c}.TWO`);
  }
  
  try {
    const target = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${ySymbols.join(',')}&crumb=${encodeURIComponent(auth.crumb)}`;
    const res = await fetch(target, {
      headers: {
        ...BROWSER_HEADERS,
        'Cookie': auth.cookie
      }
    });
    if (!res.ok) return {};
    const j = await res.json();
    const results = j?.quoteResponse?.result || [];
    const map = {};
    for (const r of results) {
      const code = r.symbol.replace(/\.TWO?$/i, '');
      if (r.regularMarketPrice != null) {
        map[code] = r.regularMarketPrice;
      }
    }
    return map;
  } catch {
    return {};
  }
}
