const CANDLE_INTERVAL = { '3mo':'1d', '6mo':'1d', '1y':'1d', '2y':'1wk' };
const VALID_INTERVALS = ['1d', '1wk', '1mo'];
const NON_US_SUFFIX = /\.(TW|TWO|HK|L|T|SS|SZ|KS|AX|TO|PA|DE|MI|MC|AS|SI|BO|NS)$/i;
const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,15}$/;
const BROWSER_HEADERS = { 
  'Accept': 'application/json', 
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Referer': 'https://www.tpex.org.tw/'
};

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type':'application/json', ...extraHeaders } });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  const periodParam = url.searchParams.get('period') || '3mo';
  const period = CANDLE_INTERVAL[periodParam] ? periodParam : '3mo';
  const intervalParam = url.searchParams.get('interval') || '';
  const interval = VALID_INTERVALS.includes(intervalParam) ? intervalParam : (CANDLE_INTERVAL[period] || '1d');
  const userFmpKey = (url.searchParams.get('fmpKey') || '').trim();

  if (!SYMBOL_RE.test(symbol)) {
    return json({ error: '股票代號格式不正確' }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(`https://elan-quant-cache.internal/quote/${symbol}/${period}/${interval}`, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let resolvedSymbol = symbol;
  let candles = await fetchYahooCandles(symbol, period, interval);
  if (!candles || candles.length < 5) {
    if (/^\d{4,6}[A-Z]?$/i.test(symbol)) {
      const twSymbol = `${symbol}.TW`;
      candles = await fetchYahooCandles(twSymbol, period, interval);
      if (candles && candles.length >= 5) {
        resolvedSymbol = twSymbol;
      } else {
        const twoSymbol = `${symbol}.TWO`;
        candles = await fetchYahooCandles(twoSymbol, period, interval);
        if (candles && candles.length >= 5) {
          resolvedSymbol = twoSymbol;
        }
      }
    } else if (/\.TW$/i.test(symbol)) {
      const alternativeSymbol = symbol.replace(/\.TW$/i, '.TWO');
      candles = await fetchYahooCandles(alternativeSymbol, period, interval);
      if (candles && candles.length >= 5) {
        resolvedSymbol = alternativeSymbol;
      }
    } else if (/\.TWO$/i.test(symbol)) {
      const alternativeSymbol = symbol.replace(/\.TWO$/i, '.TW');
      candles = await fetchYahooCandles(alternativeSymbol, period, interval);
      if (candles && candles.length >= 5) {
        resolvedSymbol = alternativeSymbol;
      }
    }
  }

  if (!candles || candles.length < 5) {
    return json({ error: `無法取得 ${symbol} 的股價數據，請確認代號是否正確（台股請加 .TW，例如 2330.TW）` }, 502);
  }

  // fetchQuoteInfo跟fetchTwseMisRealtimePrice互不依賴對方的結果（後者只是拿自己查到的
  // 即時價覆蓋前者算好的meta裡的幾個欄位）——原本寫成先await完meta才開始查TWSE即時價，
  // 是不必要的序列等待，改成平行送出兩個請求，台股/上櫃代號的查詢延遲可以省下其中一個
  // 請求的時間。
  const isTwseRealtimeEligible = NON_US_SUFFIX.test(resolvedSymbol) && /\.(TW|TWO)$/i.test(resolvedSymbol);
  const [meta, live] = await Promise.all([
    fetchQuoteInfo(resolvedSymbol, candles._meta || {}, env, userFmpKey),
    isTwseRealtimeEligible ? fetchTwseMisRealtimePrice(resolvedSymbol) : Promise.resolve(null),
  ]);
  meta.symbol = resolvedSymbol;

  // Yahoo's chart API for TWSE/TPEx symbols runs ~20 minutes behind (confirmed by comparing
  // regularMarketTime against wall-clock time for multiple tickers) — that's Yahoo's own delayed-quote
  // policy for this market, not something caching on our end causes. TWSE publishes its own near-real-time
  // feed (~5-10s delay, same one most Taiwan finance sites use) for free with no key, so for TW symbols we
  // overwrite the price with that instead, and surface the actual quote timestamp so the freshness is honest
  // rather than implied. Historical candles still come from Yahoo — TWSE's MIS endpoint only gives a live snapshot.
  let cacheSeconds = 45;
  if (live) {
    meta.regularMarketPrice = live.price;
    meta.quoteTime = live.time;
    meta.quoteDate = live.date;
    meta.quoteSource = 'TWSE 即時資訊';
    cacheSeconds = 8;
  }

  const responseBody = {
    candles: candles.map(c => ({ date: c.date.toISOString(), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
    meta,
  };
  const response = json(responseBody, 200, { 'Cache-Control': `public, max-age=${cacheSeconds}` });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// TWSE 官方「個股即時資訊」系統（mis.twse.com.tw），delay=0 是公開網頁本來就在用的準即時報價
// （官方回應本身會標註 userDelay，實測約 5-10 秒，遠比 Yahoo 的 chart API 快）。z（成交價）在兩筆
// 成交之間可能是 "-"（還沒有新成交），這時退回買賣五檔的中間價，再退回昨收，不留空白。
async function fetchTwseMisRealtimePrice(symbol) {
  try {
    const code = symbol.replace(/\.(TW|TWO)$/i, '');
    const isOtc = /\.TWO$/i.test(symbol);
    const exCh = `${isOtc ? 'otc' : 'tse'}_${code}.tw`;
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0&_=${Date.now()}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'], 'Referer': `https://mis.twse.com.tw/stock/fibest.jsp?stock=${code}` },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const row = j?.msgArray?.[0];
    if (!row) return null;

    let price = parseFloat(row.z);
    if (!isFinite(price)) {
      const bestAsk = parseFloat((row.a || '').split('_')[0]);
      const bestBid = parseFloat((row.b || '').split('_')[0]);
      if (isFinite(bestAsk) && isFinite(bestBid)) price = (bestAsk + bestBid) / 2;
      else if (isFinite(bestBid)) price = bestBid;
      else if (isFinite(bestAsk)) price = bestAsk;
      else price = parseFloat(row.y);
    }
    if (!isFinite(price) || price <= 0) return null;

    return { price, time: row.t || null, date: row.d || null };
  } catch {
    return null;
  }
}

async function fetchYahooCandles(symbol, period, interval) {
  interval = interval || CANDLE_INTERVAL[period] || '1d';
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const target = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${period}&interval=${interval}&events=div&includePrePost=false`;
      const res = await fetch(target, { headers: BROWSER_HEADERS });
      if (!res.ok) continue;
      const j = await res.json();
      const r = j?.chart?.result?.[0];
      if (!r) continue;
      const ts = r.timestamp, q = r.indicators?.quote?.[0];
      if (!ts || !q) continue;
      const data = ts.map((t, i) => ({
        date: new Date(t * 1000),
        open: q.open?.[i], high: q.high?.[i], low: q.low?.[i],
        close: q.close?.[i], volume: q.volume?.[i],
      })).filter(d => d.close != null && d.close > 0);
      if (data.length < 5) continue;
      const meta = r.meta || {};
      data._meta = {
        currency: meta.currency,
        longName: meta.longName || meta.shortName || symbol,
        shortName: meta.shortName,
        exchangeName: meta.exchangeName,
        regularMarketPrice: meta.regularMarketPrice,
        previousClose: meta.chartPreviousClose || meta.previousClose,
        regularMarketVolume: meta.regularMarketVolume || data[data.length - 1]?.volume,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
        fiftyDayAverage: meta.fiftyDayAverage,
        twoHundredDayAverage: meta.twoHundredDayAverage,
        regularMarketDayHigh: data[data.length - 1]?.high,
        regularMarketDayLow: data[data.length - 1]?.low,
        regularMarketOpen: data[data.length - 1]?.open,
      };
      return data;
    } catch {}
  }
  return null;
}

async function fetchQuoteInfo(symbol, chartMeta, env, userFmpKey) {
  const base = chartMeta || {};
  const isNonUS = NON_US_SUFFIX.test(symbol);
  const fmpKey = userFmpKey || env.FMP_KEY;

  if (fmpKey && !isNonUS) {
    const fmp = await fetchFmpInfo(symbol, base, fmpKey);
    if (fmp) return fmp;
  }

  // Yahoo's quoteSummary/v7 now require a session cookie + crumb (plain "401" without them) —
  // this covers every symbol Yahoo has data for, including Taiwan tickers, so it runs before
  // the TW-only official fallback below.
  const yahoo = await fetchYahooQuoteSummary(symbol, base, env);
  if (yahoo) return yahoo;

  const yahooV7 = await fetchYahooV7Quote(symbol, base, env);
  if (yahooV7) return yahooV7;

  // TWSE (.TW, 上市) / TPEx (.TWO, 上櫃) official open-data safety net, in case Yahoo's
  // cookie+crumb trick ever gets patched — these are free, unauthenticated, and stable.
  if (/\.TW$/i.test(symbol)) {
    const twse = await fetchTwseInfo(symbol, base);
    if (twse) return twse;
  } else if (/\.TWO$/i.test(symbol)) {
    const tpex = await fetchTpexInfo(symbol, base, env);
    if (tpex) return tpex;
  }

  const stooq = await fetchStooqInfo(symbol, base);
  if (stooq) return stooq;

  return { ...base, _source: 'chart' };
}

const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Yahoo now gates quoteSummary/v7 behind a session cookie + crumb (same mechanism yfinance-style
// scrapers use). Cached in KV for a bit since it costs 2 extra round trips to mint.
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

// FMP retired /api/v3 and /api/v4 on 2025-08-31 (403 "Legacy Endpoint" for any non-grandfathered key) —
// all fundamentals calls must go through the /stable/ surface, which uses ?symbol= instead of a path param.
async function readJsonArray(settled) {
  if (settled.status !== 'fulfilled' || !settled.value.ok) return [];
  try {
    const j = await settled.value.json();
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

async function fetchFmpInfo(symbol, base, fmpKey) {
  try {
    const urls = {
      quote: `https://financialmodelingprep.com/stable/quote?symbol=${symbol}&apikey=${fmpKey}`,
      profile: `https://financialmodelingprep.com/stable/profile?symbol=${symbol}&apikey=${fmpKey}`,
      ratios: `https://financialmodelingprep.com/stable/ratios-ttm?symbol=${symbol}&apikey=${fmpKey}`,
      metrics: `https://financialmodelingprep.com/stable/key-metrics-ttm?symbol=${symbol}&apikey=${fmpKey}`,
      rating: `https://financialmodelingprep.com/stable/ratings-snapshot?symbol=${symbol}&apikey=${fmpKey}`,
    };
    const [qr, pr, rr, mr, gr] = await Promise.allSettled([
      fetch(urls.quote), fetch(urls.profile), fetch(urls.ratios), fetch(urls.metrics), fetch(urls.rating),
    ]);
    const qd = (await readJsonArray(qr))[0] || {};
    const pd = (await readJsonArray(pr))[0] || {};
    const rtd = (await readJsonArray(rr))[0] || {};
    const kmd = (await readJsonArray(mr))[0] || {};
    const rd = (await readJsonArray(gr))[0] || {};
    if (!qd.price && !pd.marketCap) return null;
    return {
      longName: pd.companyName || base.longName || symbol,
      shortName: pd.companyName || base.shortName || symbol,
      currency: pd.currency || base.currency || 'USD',
      sector: pd.sector || base.sector,
      industry: pd.industry || base.industry,
      exchangeName: pd.exchange,
      regularMarketPrice: base.regularMarketPrice || qd.price,
      regularMarketDayHigh: base.regularMarketDayHigh || qd.dayHigh,
      regularMarketDayLow: base.regularMarketDayLow || qd.dayLow,
      regularMarketOpen: base.regularMarketOpen || qd.open,
      regularMarketPreviousClose: qd.previousClose || base.previousClose,
      regularMarketVolume: base.regularMarketVolume || qd.volume,
      regularMarketChange: qd.change,
      regularMarketChangePercent: qd.changePercentage != null ? qd.changePercentage / 100 : null,
      marketCap: qd.marketCap || pd.marketCap,
      averageVolume: pd.averageVolume,
      fiftyTwoWeekHigh: qd.yearHigh || base.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: qd.yearLow || base.fiftyTwoWeekLow,
      beta: pd.beta,
      trailingPE: rtd.priceToEarningsRatioTTM,
      priceToBook: rtd.priceToBookRatioTTM,
      trailingEps: rtd.netIncomePerShareTTM,
      dividendYield: rtd.dividendYieldTTM,
      grossMargins: rtd.grossProfitMarginTTM,
      operatingMargins: rtd.operatingProfitMarginTTM,
      profitMargins: rtd.netProfitMarginTTM,
      returnOnEquity: kmd.returnOnEquityTTM,
      analystRating: rd.rating,
      analystScore: rd.overallScore,
      description: pd.description,
      _source: 'FMP',
    };
  } catch {
    return null;
  }
}

async function fetchYahooQuoteSummary(symbol, base, env) {
  const auth = await getYahooCrumb(env);
  if (!auth) return null;
  const summaryModules = 'price,summaryDetail,defaultKeyStatistics,financialData,assetProfile';
  const unwrap = v => (v && typeof v === 'object' && 'raw' in v) ? v.raw : v;
  for (const ver of ['v10', 'v11']) {
    for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
      try {
        const target = `https://${host}/${ver}/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${summaryModules}&crumb=${encodeURIComponent(auth.crumb)}`;
        const res = await fetch(target, { headers: { ...BROWSER_HEADERS, 'User-Agent': YAHOO_UA, 'Cookie': auth.cookie } });
        if (!res.ok) continue;
        const j = await res.json();
        const r = j?.quoteSummary?.result?.[0];
        if (!r) continue;
        const p = r.price || {}, sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {}, fd = r.financialData || {}, ap = r.assetProfile || {};
        if (!unwrap(p.regularMarketPrice) && !unwrap(sd.marketCap) && !unwrap(p.marketCap)) continue;
        return {
          ...base,
          currency: base.currency || p.currency,
          longName: base.longName || p.longName || p.shortName,
          regularMarketPrice: base.regularMarketPrice || unwrap(p.regularMarketPrice),
          regularMarketDayHigh: base.regularMarketDayHigh || unwrap(p.regularMarketDayHigh),
          regularMarketDayLow: base.regularMarketDayLow || unwrap(p.regularMarketDayLow),
          regularMarketOpen: base.regularMarketOpen || unwrap(p.regularMarketOpen),
          regularMarketPreviousClose: unwrap(p.regularMarketPreviousClose) || unwrap(sd.previousClose) || base.previousClose,
          previousClose: unwrap(sd.previousClose) || unwrap(p.regularMarketPreviousClose) || base.previousClose,
          regularMarketVolume: base.regularMarketVolume || unwrap(p.regularMarketVolume),
          marketCap: unwrap(p.marketCap) || unwrap(sd.marketCap),
          fiftyTwoWeekHigh: base.fiftyTwoWeekHigh || unwrap(sd.fiftyTwoWeekHigh),
          fiftyTwoWeekLow: base.fiftyTwoWeekLow || unwrap(sd.fiftyTwoWeekLow),
          trailingPE: unwrap(sd.trailingPE) || unwrap(ks.trailingPE),
          forwardPE: unwrap(sd.forwardPE) || unwrap(ks.forwardPE),
          priceToBook: unwrap(ks.priceToBook),
          trailingEps: unwrap(ks.trailingEps),
          forwardEps: unwrap(ks.forwardEps),
          dividendYield: unwrap(sd.dividendYield),
          beta: unwrap(sd.beta) || unwrap(ks.beta),
          averageVolume: unwrap(sd.averageVolume) || unwrap(sd.averageDailyVolume10Day),
          sector: ap.sector, industry: ap.industry,
          grossMargins: unwrap(fd.grossMargins),
          operatingMargins: unwrap(fd.operatingMargins),
          profitMargins: unwrap(fd.profitMargins),
          returnOnEquity: unwrap(fd.returnOnEquity),
          revenueGrowth: unwrap(fd.revenueGrowth),
          targetMeanPrice: unwrap(fd.targetMeanPrice),
          recommendationKey: fd.recommendationKey,
          numberOfAnalystOpinions: unwrap(fd.numberOfAnalystOpinions),
          _source: 'Yahoo',
        };
      } catch {}
    }
  }
  return null;
}

async function fetchYahooV7Quote(symbol, base, env) {
  const auth = await getYahooCrumb(env);
  if (!auth) return null;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const target = `https://${host}/v7/finance/quote?symbols=${encodeURIComponent(symbol)}&crumb=${encodeURIComponent(auth.crumb)}`;
      const res = await fetch(target, { headers: { ...BROWSER_HEADERS, 'User-Agent': YAHOO_UA, 'Cookie': auth.cookie } });
      if (!res.ok) continue;
      const j = await res.json();
      const q = j?.quoteResponse?.result?.[0];
      if (q && (q.marketCap || q.trailingPE || q.regularMarketPrice)) {
        return { ...base, ...q, _source: 'Yahoo' };
      }
    } catch {}
  }
  return null;
}

async function fetchStooqInfo(symbol, base) {
  try {
    const stooqSym = symbol.toLowerCase();
    const target = `https://stooq.com/q/l/?s=${stooqSym}&f=sd2t2ohlcvn&h&e=csv`;
    const res = await fetch(target);
    if (!res.ok) return null;
    const txt = await res.text();
    const lines = txt.trim().split('\n');
    if (lines.length < 2) return null;
    const headers = lines[0].split(',');
    const vals = lines[1].split(',');
    const row = {};
    headers.forEach((h, i) => row[h.trim()] = (vals[i] || '').trim());
    if (!row.Close || row.Close === 'N/D' || isNaN(parseFloat(row.Close))) return null;
    return {
      ...base,
      regularMarketPrice: parseFloat(row.Close) || base.regularMarketPrice,
      regularMarketVolume: parseInt(row.Volume) || base.regularMarketVolume,
      longName: row.Name || base.longName,
      _source: 'Stooq',
    };
  } catch {
    return null;
  }
}

function parsePct(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n / 100 : null;
}
function parseNum(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

// TWSE (上市) open data: https://openapi.twse.com.tw/
async function fetchTwseInfo(symbol, base) {
  try {
    const stockNo = symbol.replace(/\.TWO?$/i, '');
    const [dayRes, peRes] = await Promise.all([
      fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL'),
      fetch('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL'),
    ]);
    if (!dayRes.ok) return null;
    const dayArr = await dayRes.json();
    const row = Array.isArray(dayArr) ? dayArr.find(r => r.Code === stockNo) : null;
    if (!row) return null;
    const peArr = peRes.ok ? await peRes.json() : [];
    const peRow = (Array.isArray(peArr) ? peArr.find(r => r.Code === stockNo) : null) || {};
    return {
      ...base,
      longName: row.Name || base.longName,
      regularMarketPrice: parseFloat(row.ClosingPrice) || base.regularMarketPrice,
      trailingPE: parseNum(peRow.PEratio),
      dividendYield: parsePct(peRow.DividendYield),
      priceToBook: parseNum(peRow.PBratio),
      _source: 'TWSE',
    };
  } catch {
    return null;
  }
}

async function fetchTpexOpenApi(url, env) {
  const targetUrl = env?.TPEX_PROXY_URL ? `${env.TPEX_PROXY_URL}?url=${encodeURIComponent(url)}` : url;
  return await fetch(targetUrl, { headers: BROWSER_HEADERS });
}

// TPEx (上櫃) open data: https://www.tpex.org.tw/openapi/
async function fetchTpexInfo(symbol, base, env) {
  try {
    const stockNo = symbol.replace(/\.TWO?$/i, '');
    const [dayRes, peRes] = await Promise.all([
      fetchTpexOpenApi('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', env),
      fetchTpexOpenApi('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis', env),
    ]);
    if (!dayRes.ok) return null;
    const dayArr = await dayRes.json();
    const row = Array.isArray(dayArr) ? dayArr.find(r => r.SecuritiesCompanyCode === stockNo) : null;
    if (!row) return null;
    const peArr = peRes.ok ? await peRes.json() : [];
    const peRow = (Array.isArray(peArr) ? peArr.find(r => r.SecuritiesCompanyCode === stockNo) : null) || {};
    return {
      ...base,
      longName: row.CompanyName || base.longName,
      regularMarketPrice: parseFloat(row.Close) || base.regularMarketPrice,
      trailingPE: parseNum(peRow.PriceEarningRatio),
      dividendYield: parsePct(peRow.YieldRatio),
      priceToBook: parseNum(peRow.PriceBookRatio),
      _source: 'TPEx',
    };
  } catch {
    return null;
  }
}
