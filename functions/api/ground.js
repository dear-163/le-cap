// Real-data grounding for the AI analysis prompt (FMP financial statements / peer comps),
// kept separate from Gemini entirely: this endpoint never touches an LLM or a Gemini key.
// Visitors now always call Gemini directly from their own browser with their own key (BYOK) —
// this endpoint just supplies the real-number context so that prompt isn't Gemini's own guess.
const SECTIONS = new Set(['fundamentals', 'valuation', 'risk', 'conclusion']);
const NON_US_SUFFIX = /\.(TW|TWO|HK|L|T|SS|SZ|KS|AX|TO|PA|DE|MI|MC|AS|SI|BO|NS)$/i;
const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,15}$/;

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } });
}

function fmtLargeNum(v) {
  if (v == null) return 'N/A';
  const n = Number(v);
  if (!isFinite(n)) return 'N/A';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  return String(n);
}

// Grounds the "近3年財務趨勢" section in real filed financials instead of the model's own recall.
async function fetchFinancialsSummary(symbol, fmpKey) {
  try {
    const res = await fetch(`https://financialmodelingprep.com/stable/income-statement?symbol=${symbol}&period=annual&limit=3&apikey=${fmpKey}`);
    if (!res.ok) return null;
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr.map(r => {
      const rev = r.revenue, ni = r.netIncome;
      const gm = rev ? (r.grossProfit / rev * 100).toFixed(1) + '%' : 'N/A';
      const om = rev ? (r.operatingIncome / rev * 100).toFixed(1) + '%' : 'N/A';
      const nm = rev ? (ni / rev * 100).toFixed(1) + '%' : 'N/A';
      const year = (r.fiscalYear || r.date || '').toString().slice(0, 4);
      return `${year}：營收 ${fmtLargeNum(rev)}，淨利 ${fmtLargeNum(ni)}，毛利率 ${gm}，營業利益率 ${om}，淨利率 ${nm}`;
    }).join('\n');
  } catch {
    return null;
  }
}

// 台幣金額用台股慣用的「億元/萬元」格式，跟app.js其他TW數字顯示一致，不用美股習慣的B/M。
function fmtTwAmt(v) {
  if (v == null || !isFinite(v)) return 'N/A';
  const abs = Math.abs(v);
  if (abs >= 1e8) return (v / 1e8).toFixed(2) + ' 億元';
  if (abs >= 1e4) return (v / 1e4).toFixed(0) + ' 萬元';
  return Math.round(v).toLocaleString() + ' 元';
}

const TWSE_INCOME_URL = 'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci';
const TPEX_INCOME_URL = 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_ci';

// 台股版的「近3年財報數據」grounding，抓TWSE(上市)/TPEx(上櫃)官方公開資訊，不用任何Key。
// 只涵蓋「一般業」（科技/製造/消費類股），金融/證券/保險/金控類股這個端點沒有涵蓋，抓不到
// 就回傳null，讀取端會顯示誠實的「無資料」。這個官方API也不支援查歷史季度，只能拿到「最新
// 一季」，跟美股FMP版本抓近3年不一樣，回傳文字裡要明確講清楚這個差異，避免AI誤把單季數字
// 講成3年趨勢。
async function fetchTwFinancialsSummary(symbol) {
  const isOtc = /\.TWO$/i.test(symbol);
  const isTwse = /\.TW$/i.test(symbol) && !isOtc;
  if (!isOtc && !isTwse) return null;
  const code = symbol.replace(/\.TWO?$/i, '');
  try {
    const res = await fetch(isOtc ? TPEX_INCOME_URL : TWSE_INCOME_URL);
    if (!res.ok) return null;
    const arr = await res.json();
    if (!Array.isArray(arr)) return null;
    const codeField = isOtc ? 'SecuritiesCompanyCode' : '公司代號';
    const row = arr.find(r => r[codeField] === code);
    if (!row) return null;

    const rev = Number(row['營業收入']) * 1000;
    const ni = Number(row['本期淨利（淨損）']) * 1000;
    const gross = Number(row['營業毛利（毛損）淨額']) * 1000;
    const opInc = Number(row['營業利益（損失）']) * 1000;
    if (!isFinite(rev) || rev === 0) return null;
    const gm = isFinite(gross) ? (gross / rev * 100).toFixed(1) + '%' : 'N/A';
    const om = isFinite(opInc) ? (opInc / rev * 100).toFixed(1) + '%' : 'N/A';
    const nm = isFinite(ni) ? (ni / rev * 100).toFixed(1) + '%' : 'N/A';
    const year = row['Year'] || row['年度'];
    const season = row['Season'] || row['季別'];
    return `民國${year}年第${season}季（單季，非3年趨勢）：營業收入 ${fmtTwAmt(rev)}，本期淨利 ${fmtTwAmt(ni)}，毛利率 ${gm}，營業利益率 ${om}，淨利率 ${nm}`;
  } catch {
    return null;
  }
}

// Grounds the "同業比較" table in real peer quotes instead of the model inventing comparables.
async function fetchPeersSummary(symbol, fmpKey) {
  try {
    const peersRes = await fetch(`https://financialmodelingprep.com/stable/stock-peers?symbol=${symbol}&apikey=${fmpKey}`);
    if (!peersRes.ok) return null;
    const peers = await peersRes.json();
    if (!Array.isArray(peers) || peers.length === 0) return null;
    const topPeers = peers.slice(0, 3);
    const withPe = await Promise.all(topPeers.map(async peer => {
      try {
        const r = await fetch(`https://financialmodelingprep.com/stable/ratios-ttm?symbol=${peer.symbol}&apikey=${fmpKey}`);
        const j = r.ok ? await r.json() : [];
        return { ...peer, pe: (Array.isArray(j) && j[0]) ? j[0].priceToEarningsRatioTTM : null };
      } catch {
        return { ...peer, pe: null };
      }
    }));
    return withPe.map(p => `${p.symbol}（${p.companyName || ''}）：股價 ${p.price ?? 'N/A'}，本益比 ${p.pe != null ? p.pe.toFixed(1) : 'N/A'}，市值 ${fmtLargeNum(p.mktCap)}`).join('\n');
  } catch {
    return null;
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  const section = url.searchParams.get('section') || '';
  const fmpKey = (url.searchParams.get('fmpKey') || '').trim() || env.FMP_KEY;

  if (!SYMBOL_RE.test(symbol) || !SECTIONS.has(section)) {
    return json({ error: '請求參數不正確' }, 400);
  }

  // Income statements and peer comps only change quarterly at most — cache generously (1h) to
  // conserve FMP's 250/day free-tier quota across repeat lookups of the same symbol+section.
  const cache = caches.default;
  const cacheKey = new Request(`https://elan-quant-cache.internal/ground/${symbol}/${section}`, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const isNonUS = NON_US_SUFFIX.test(symbol);
  const isTwListed = /\.TWO?$/i.test(symbol);
  let body;
  let gotRealData = false;

  if (section === 'fundamentals') {
    let fin = null, source = null;
    if (isTwListed) {
      fin = await fetchTwFinancialsSummary(symbol);
      source = fin ? 'tw_latest_quarter' : null;
    } else if (fmpKey && !isNonUS) {
      fin = await fetchFinancialsSummary(symbol, fmpKey);
      source = fin ? 'fmp_3y' : null;
    }
    gotRealData = !!fin;
    body = {
      source,
      groundingText: fin
        ? (source === 'tw_latest_quarter'
          ? `\n\n【最新一季財報數據（來源：TWSE/TPEx官方公開資訊，真實數據，僅單季、不是3年趨勢，請優先採用、不要自行編造不同數字，也不要把單季數字誤講成3年趨勢）】\n${fin}`
          : `\n\n【近3年財報數據（來源：FMP，真實數據，請優先採用，不要自行編造不同數字）】\n${fin}`)
        : `\n\n（註：目前無法取得近3年真實財報數據，請在財務健康段落明確註明此處為一般產業知識推論，並提醒使用者自行查證財報。）`,
    };
  } else if (section === 'valuation') {
    const peers = (fmpKey && !isNonUS) ? await fetchPeersSummary(symbol, fmpKey) : null;
    gotRealData = !!peers;
    body = {
      source: peers ? 'fmp_peers' : null,
      groundingText: peers
        ? `\n\n【同業比較數據（來源：FMP，真實數據，請優先採用，不要自行編造不同公司或數字）】\n${peers}`
        : `\n\n（註：目前無法取得真實同業比較數據，請在估值比較表格明確註明這是一般產業知識推論的參考數字，並提醒使用者自行查證。）`,
    };
  } else {
    body = { groundingText: '' };
  }

  // Only cache genuine FMP-sourced hits. If no key was available this time (e.g. a visitor without
  // their own FMP BYOK key), skip caching entirely — otherwise the "no real data" fallback text would
  // get stuck for an hour and block a *different* visitor who does have a valid key from that point on.
  const response = json(body, 200, gotRealData ? { 'Cache-Control': 'public, max-age=3600' } : {});
  if (gotRealData) {
    context.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}
