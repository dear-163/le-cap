// /api/market-chart — 即時大盤報價（台指/櫃買/美指）
// 台股：TWSE MIS 即時系統（userDelay 5 秒，比 Yahoo 快很多）
// 美股指數：Yahoo Finance chart（非盤中時段返回最近收盤）

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// TWSE MIS 即時指數。這個端點是設計給瀏覽器保持同一個 session 每5秒連續輪詢用的，Cloudflare
// Pages Functions 每次呼叫都是全新、無狀態的請求（沒有沿用同一個連線/cookie），實測對它單次
// 呼叫有明顯的機率性失敗（msgArray 回空陣列，不是HTTP錯誤）——重試一次能顯著降低使用者端看到
// 「無資料」的機率，不是端點真的掛掉。
async function fetchTwseIndexOnce(exCh) {
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0&_=${Date.now()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://mis.twse.com.tw/' },
  });
  if (!res.ok) return null;
  const j = await res.json();
  const row = j?.msgArray?.[0];
  if (!row) return null;
  const current = parseFloat(row.z);
  const prev = parseFloat(row.y);
  const open = parseFloat(row.o);
  const high = parseFloat(row.h);
  const low = parseFloat(row.l);
  if (!isFinite(current) || current <= 0) return null;
  const change = current - prev;
  const changePct = prev > 0 ? (change / prev * 100) : null;
  return {
    name: row.n,
    current,
    prev,
    open,
    high,
    low,
    change,
    changePct,
    time: row.t || null,
    date: row.d || null,
    volume: row.m ? parseInt(row.m) : null,
  };
}

async function fetchTwseIndex(exCh) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await fetchTwseIndexOnce(exCh);
      if (result) return result;
    } catch (e) {
      lastError = e.message;
    }
  }
  // 這個端點沒有D1/KV快照機制（設計上就是要真即時），失敗時前端會自己沿用上次的值
  // （見app.js的lastGoodMarketData），但伺服器這端完全沒有log的話，事後根本查不出
  // 「剛剛那段時間到底是TWSE掛了還是我們自己的問題」——至少留一行log當診斷起點。
  console.error(`[market-chart] TWSE MIS 三次嘗試皆失敗（${exCh}）：${lastError || 'msgArray為空'}`);
  return null;
}

// Yahoo Finance chart API for indices (^GSPC, ^IXIC, ^SOX, etc.)
async function fetchYahooIndexLive(yahooSymbol) {
  let lastError = null;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=2d&interval=1d&events=div&includePrePost=false`;
      const res = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      });
      if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }
      const j = await res.json();
      const r = j?.chart?.result?.[0];
      if (!r) { lastError = 'chart.result為空'; continue; }
      const meta = r.meta || {};
      const closes = r.indicators?.quote?.[0]?.close || [];
      const prev = closes.length >= 2 ? closes[closes.length - 2] : (meta.chartPreviousClose || meta.previousClose);
      const current = meta.regularMarketPrice || closes[closes.length - 1];
      if (!current) { lastError = '無regularMarketPrice/close'; continue; }
      const change = current - prev;
      const changePct = prev > 0 ? (change / prev * 100) : null;
      return {
        name: meta.longName || meta.shortName || yahooSymbol,
        current,
        prev,
        change,
        changePct,
        high: meta.regularMarketDayHigh || null,
        low: meta.regularMarketDayLow || null,
        open: null,
        time: null,
        date: null,
      };
    } catch (e) {
      lastError = e.message;
    }
  }
  console.error(`[market-chart] Yahoo指數即時報價兩個host皆失敗（${yahooSymbol}）：${lastError || '未知原因'}`);
  return null;
}

export async function onRequestGet(context) {
  const [taiex, otc, spx, ndx, sox] = await Promise.all([
    fetchTwseIndex('tse_t00.tw'),
    fetchTwseIndex('otc_o00.tw'),
    fetchYahooIndexLive('^GSPC'),
    fetchYahooIndexLive('^IXIC'),
    fetchYahooIndexLive('^SOX'),
  ]);

  return json({
    tw: {
      taiex: taiex ? { ...taiex, label: '台灣加權指數' } : null,
      otc: otc ? { ...otc, label: '櫃買指數' } : null,
    },
    us: {
      spx: spx ? { ...spx, label: 'S&P 500' } : null,
      ndx: ndx ? { ...ndx, label: 'Nasdaq' } : null,
      sox: sox ? { ...sox, label: '費半 SOX' } : null,
    },
  });
}

