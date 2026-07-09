const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const target = process.argv.includes('--remote') ? '--remote' : '--local';
const dateArgIdx = process.argv.indexOf('--date');
let todayDate = '';

if (dateArgIdx !== -1 && process.argv[dateArgIdx + 1]) {
  todayDate = process.argv[dateArgIdx + 1];
} else {
  const now = new Date();
  const taipei = new Date(now.getTime() + 8 * 3600 * 1000);
  const y = taipei.getUTCFullYear();
  const m = String(taipei.getUTCMonth() + 1).padStart(2, '0');
  const d = String(taipei.getUTCDate()).padStart(2, '0');
  todayDate = `${y}-${m}-${d}`;
}

console.log(`Starting live Active ETF holdings crawler & sync for date ${todayDate} (${target === '--remote' ? 'REMOTE' : 'LOCAL'})...`);

const etfs = [
  { code: '00981A', name: '統一台股增長主動式ETF', source: 'ezmoney', fundCode: '49YTW' },
  { code: '00980A', name: '野村臺灣智慧優選主動式ETF', source: 'nomura', fundCode: '00980A' },
  { code: '00988A', name: '統一全球創新主動式ETF', source: 'ezmoney', fundCode: '61YTW' },
  { code: '00403A', name: '統一台股升級50主動式ETF', source: 'ezmoney', fundCode: '63YTW' },
  { code: '00985A', name: '野村台灣50主動式ETF', source: 'nomura', fundCode: '00985A' },
  { code: '00999A', name: '野村臺灣高息主動式ETF', source: 'nomura', fundCode: '00999A' },
  { code: '00407A', name: '凱基台灣主動式ETF', source: 'kgifund', fundCode: 'J024' },
  { code: '00405A', name: '富邦台灣龍耀主動式ETF', source: 'fubon', fundCode: '00405A' },
  { code: '00984A', name: '安聯台灣高息主動式ETF', source: 'allianz', fundCode: 'E0001' },
  { code: '00993A', name: '安聯台灣主動式ETF', source: 'allianz', fundCode: 'E0002' },
  { code: '00402A', name: '安聯美國科技主動式ETF', source: 'allianz', fundCode: 'E0003' },
  { code: '00986A', name: '台新龍頭成長主動式ETF', source: 'taishin', fundCode: '00986A' },
  { code: '00987A', name: '台新優勢成長主動式ETF', source: 'taishin', fundCode: '00987A' },
  { code: '00404A', name: '聯博動能50主動式ETF', source: 'ab', fundCode: 'TW00000404A5' },
  { code: '00406A', name: '中信台灣收益主動式ETF', source: 'ctbc', fundCode: 'E0038' },
  { code: '00983A', name: '中信ARK創新主動式ETF', source: 'ctbc', fundCode: 'E0034' },
  { code: '00995A', name: '中信台灣卓越主動式ETF', source: 'ctbc', fundCode: 'E0036' },
  { code: '00994A', name: '第一金台股優主動式ETF', source: 'first', fundCode: '182' },
];

// ezmoney.com.tw（統一投信官網）對第一次沒帶反爬蟲 cookie 的請求，永遠回傳 302 重新導向回同一個
// 網址、並在 Set-Cookie 帶一組 __nxquid——用這組 cookie 重打一次就能拿到完整內容。頁面裡完整
// 持股是用 HTML-escape 包住的一段 JSON 陣列（Nuxt SSR 資料），每檔股票是 AssetCode==="ST" 的
// 紀錄，直接帶官方算好的 Share／Amount(市值)／NavRate(權重%)——比 MoneyDJ 的前十大持股頁完整。
async function fetchEzmoneyHoldings(fundCode) {
  const url = `https://www.ezmoney.com.tw/ETF/Fund/Info?fundCode=${fundCode}`;
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  const primeRes = await fetch(url, { headers, redirect: 'manual' });
  const setCookie = primeRes.headers.get('set-cookie');
  if (!setCookie) throw new Error('ezmoney 首次請求未回傳 cookie，網站防爬機制可能已變更');
  const cookie = setCookie.split(';')[0];

  const res = await fetch(url, { headers: { ...headers, Cookie: cookie } });
  if (!res.ok) throw new Error(`ezmoney HTTP ${res.status}`);
  const html = await res.text();

  const marker = '&quot;DetailCode&quot;';
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) throw new Error('ezmoney 頁面內找不到持股明細區塊（版面可能已變更）');
  const start = html.lastIndexOf('[', markerIdx);
  let depth = 0, end = -1;
  for (let i = start; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (start === -1 || end === -1) throw new Error('ezmoney 持股 JSON 陣列括號不成對，解析失敗');

  const unescaped = html.slice(start, end)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  const data = JSON.parse(unescaped);
  return data
    .filter(r => r.AssetCode === 'ST' && r.DetailCode)
    .map(r => ({ stockCode: r.DetailCode, shares: r.Share, weight: r.NavRate }));
}

// 野村投信官網（Angular SPA）背後直接打的 JSON API，不用解析 HTML。
async function fetchNomuraHoldings(fundId) {
  const res = await fetch('https://www.nomurafunds.com.tw/API/ETFAPI/api/Fund/GetFundAssets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: `https://www.nomurafunds.com.tw/ETFWEB/product-description?fundNo=${fundId}`,
    },
    body: JSON.stringify({ FundID: fundId, SearchDate: null }),
  });
  if (!res.ok) throw new Error(`野村投信 API HTTP ${res.status}`);
  const apiRes = await res.json();
  const table = (apiRes?.Entries?.Data?.Table || []).find(t => t.TableTitle === '股票');
  if (!table || !Array.isArray(table.Rows)) throw new Error('野村投信 API 回應格式跟預期不符（找不到股票表格）');
  return table.Rows.map(row => ({
    stockCode: row[0],
    shares: parseFloat(String(row[2]).replace(/,/g, '')),
    weight: parseFloat(row[3]),
  }));
}

// 解碼 HTML entity（十六進位/十進位數字實體 + 常見具名實體），不依賴瀏覽器 DOM。
function decodeHtmlEntities(s) {
  return s
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// 凱基投信官網：伺服器端直接渲染，完整持股表格（含隱藏的「顯示更多」列）已經在原始 HTML
// 裡，不用額外打 API。頁面裡這個表格出現兩次（桌面版+隱藏的行動版），只取第一次出現的區塊，
// 否則會算兩倍。
async function fetchKgifundHoldings(fundId) {
  const res = await fetch(`https://www.kgifund.com.tw/Fund/Detail?fundID=${fundId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error(`凱基投信 HTTP ${res.status}`);
  const html = await res.text();
  const marker = 'js-table-a-0';
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) throw new Error('凱基投信頁面內找不到持股表格（版面可能已變更）');
  const tableStart = html.lastIndexOf('<table', markerIdx);
  const tableEnd = html.indexOf('</table>', markerIdx) + '</table>'.length;
  const tableHtml = html.slice(tableStart, tableEnd);
  const rows = [...tableHtml.matchAll(/<tr name="content"[^>]*>([\s\S]*?)<\/tr>/g)];
  return rows.map(m => {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => decodeHtmlEntities(c[1].replace(/<[^>]+>/g, '')).trim());
    return { stockCode: cells[0], shares: parseFloat(cells[2].replace(/,/g, '')), weight: parseFloat(cells[3]) };
  }).filter(h => /^\d{4,6}$/.test(h.stockCode));
}

// 富邦投信旗下 ETF 微站（fsit.com.tw），純伺服器渲染 HTML，不用 cookie、不用登入。
async function fetchFubonHoldings(ticker) {
  const res = await fetch(`https://websys.fsit.com.tw/FubonETF/Fund/Assets.aspx?stkId=${ticker}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error(`富邦投信 HTTP ${res.status}`);
  const html = await res.text();
  const rows = [...html.matchAll(/<tr>\s*<td class="tac">(\d{4,6})<\/td>\s*<td>([^<]+)<\/td>\s*<td class="tac">([\d,]+)<\/td>\s*<td class="tac">[\d,]+<\/td>\s*<td class="tac">([\d.]+)<\/td>\s*<\/tr>/g)];
  if (rows.length === 0) throw new Error('富邦投信頁面內找不到持股表格（版面可能已變更）');
  return rows.map(m => ({ stockCode: m[1], shares: parseFloat(m[3].replace(/,/g, '')), weight: parseFloat(m[4]) }));
}

// 安聯投信（etf.allianzgi.com.tw）背後是共用的白牌 ETF 平台，需要三步：
// 1) 拿 XSRF token/cookie 2) （已知 fundNo 對照表，不用每次查）3) 帶 token 打 GetFundAssets。
async function fetchAllianzHoldings(fundNo) {
  const tokenRes = await fetch('https://etf.allianzgi.com.tw/webapi/api/AntiForgery/GetAntiForgeryToken', {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  if (!tokenRes.ok) throw new Error(`安聯投信 token HTTP ${tokenRes.status}`);
  const setCookie = tokenRes.headers.get('set-cookie');
  const tokenJson = await tokenRes.json();
  const xsrfToken = tokenJson.token;
  if (!xsrfToken || !setCookie) throw new Error('安聯投信未回傳 XSRF token 或 cookie');
  const cookie = setCookie.split(',').map(c => c.split(';')[0].trim()).join('; ');

  const res = await fetch('https://etf.allianzgi.com.tw/webapi/api/Fund/GetFundAssets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json',
      'X-XSRF-TOKEN': xsrfToken, Cookie: cookie, 'User-Agent': 'Mozilla/5.0',
      Referer: `https://etf.allianzgi.com.tw/etf-info/${fundNo}?tab=4`,
    },
    body: JSON.stringify({ FundID: fundNo, SearchDate: null }),
  });
  if (!res.ok) throw new Error(`安聯投信 API HTTP ${res.status}`);
  const apiRes = await res.json();
  const table = (apiRes?.Entries?.Data?.Table || []).find(t => (t.TableTitle || '').includes('股票'));
  if (!table || !Array.isArray(table.Rows)) throw new Error('安聯投信 API 回應格式跟預期不符（找不到股票表格）');
  return table.Rows.map(row => ({
    stockCode: row[1],
    shares: parseFloat(String(row[3]).replace(/,/g, '')), weight: parseFloat(row[4]),
  })).filter(h => h.stockCode);
}

// 台新投信：純伺服器渲染 HTML，不用 cookie/登入。股票代號可能帶交易所後綴（如「2330 TT」
// 台股、「GOOGL US」美股），只有純台股代號能對到我們自己 stock_daily_price 的收盤價。
async function fetchTaishinHoldings(ticker) {
  const res = await fetch(`https://www.tsit.com.tw/ETF/Home/ETFSeriesDetail/${ticker}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error(`台新投信 HTTP ${res.status}`);
  const html = await res.text();
  const marker = '股票合計';
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) throw new Error('台新投信頁面內找不到持股表格（版面可能已變更）');
  const tableStart = html.lastIndexOf('<table', markerIdx);
  const tableEnd = html.indexOf('</table>', markerIdx) + '</table>'.length;
  const tableHtml = html.slice(tableStart, tableEnd);
  const rows = [...tableHtml.matchAll(/<tr>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<\/tr>/g)];
  return rows
    .map(m => ({ rawCode: m[1].trim(), shares: parseFloat(m[3].replace(/,/g, '')), weight: parseFloat(m[4]) }))
    .filter(h => !h.rawCode.includes('合計'))
    .map(h => {
      const twMatch = h.rawCode.match(/^(\d{4,6})\s*TT$/i);
      return { stockCode: twMatch ? twMatch[1] : h.rawCode, shares: h.shares, weight: h.weight };
    });
}

// 聯博投信（全球共用平台 webapi.alliancebernstein.com），乾淨的公開 JSON API，不用任何
// header/cookie。domesticHoldings 底下分好幾個區塊（股票／期貨／選擇權等），只保留有
// holdingCode 的列（期貨/選擇權沒有代號會被濾掉）。
async function fetchAllianceBernsteinHoldings(shareClassId) {
  const res = await fetch(`https://webapi.alliancebernstein.com/v2/funds/tw/zh-tw/investor/${shareClassId}/holdings`);
  if (!res.ok) throw new Error(`聯博投信 API HTTP ${res.status}`);
  const j = await res.json();
  const sections = j?.domesticHoldings || [];
  const out = [];
  for (const section of sections) {
    for (const h of (section.holdings || [])) {
      if (!h.holdingCode) continue;
      out.push({ stockCode: h.holdingCode, shares: h.holdingShares, weight: parseFloat(h.holdingPerc) });
    }
  }
  return out;
}

// 中國信託投信（ctbcinvestments.com.tw）擋在 Imperva Incapsula 反爬蟲後面，但只要 cookie
// 帶對就不用登入。三步：1) 隨便一個 ETF 頁面拿 Incapsula cookie 2) 用該 cookie 換一次性
// token 3) 帶 cookie+token 打完整持股 API。FID（如 E0038）是內部代碼，跟公開股票代號不同。
async function fetchCtbcHoldings(fid) {
  const cno = '00682450';
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  const referer = `https://www.ctbcinvestments.com.tw/Etf/${cno}/Info`;

  const primeRes = await fetch(referer, { headers });
  const cookies = [];
  const primeCookie = primeRes.headers.get('set-cookie');
  if (primeCookie) cookies.push(...primeCookie.split(',').map(c => c.split(';')[0].trim()));
  if (cookies.length === 0) throw new Error('中信投信首次請求未回傳 Incapsula cookie，防爬機制可能已變更');

  const tokenRes = await fetch('https://www.ctbcinvestments.com.tw/API/home/AuthToken?token=www.ctbcinvestments.com', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', Referer: referer, Origin: 'https://www.ctbcinvestments.com.tw', Cookie: cookies.join('; ') },
    body: '{}',
  });
  if (!tokenRes.ok) throw new Error(`中信投信 token HTTP ${tokenRes.status}`);
  const tokenCookie = tokenRes.headers.get('set-cookie');
  if (tokenCookie) cookies.push(...tokenCookie.split(',').map(c => c.split(';')[0].trim()));
  const tokenJson = await tokenRes.json();
  const token = tokenJson?.Data?.token;
  if (!token) throw new Error('中信投信未回傳 auth token');

  const todayIso = new Date().toISOString().slice(0, 10);
  const res = await fetch(`https://www.ctbcinvestments.com.tw/API/etf/ETFHoldingWeight?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', Referer: referer, Origin: 'https://www.ctbcinvestments.com.tw', Cookie: cookies.join('; ') },
    body: JSON.stringify({ FID: fid, StartDate: todayIso }),
  });
  if (!res.ok) throw new Error(`中信投信 API HTTP ${res.status}`);
  const apiRes = await res.json();
  if (apiRes.ResultCode !== 0) throw new Error(`中信投信 API 回應錯誤：${apiRes.ResultMsg || apiRes.ResultCode}`);
  const detail = apiRes?.Data?.FundAssetsDetail || [];
  const stockSection = detail.find(s => s.Code === 'STOCK');
  if (!stockSection) throw new Error('中信投信 API 回應格式跟預期不符（找不到股票區塊）');
  return stockSection.Data.map(r => ({
    stockCode: r.code_,
    shares: parseFloat(String(r.qty_).replace(/,/g, '')), weight: parseFloat(r.weights_),
  }));
}

// 第一金投信（fsitc.com.tw）：ASP.NET WebMethod，POST body 不帶 pStrDate（空字串）就是回傳
// 最新一天的資料。回應是「JSON 字串包一層」（.d 欄位本身還要再 JSON.parse 一次）。group 欄位
// 混雜了股票(1)／現金(4)／類別佔比摘要(5)，只取 group==="1" 的才是真的持股。
async function fetchFirstHoldings(fundId) {
  const res = await fetch('https://www.fsitc.com.tw/WebAPI.aspx/Get_hd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ pStrFundID: fundId, pStrDate: '' }),
  });
  if (!res.ok) throw new Error(`第一金投信 HTTP ${res.status}`);
  const outer = await res.json();
  const data = JSON.parse(outer.d);
  return data
    .filter(r => r.group === '1')
    .map(r => ({ stockCode: r.A, weight: parseFloat(r.C), shares: parseFloat(String(r.D).replace(/,/g, '')) }));
}

const FETCHERS = {
  ezmoney: fetchEzmoneyHoldings,
  nomura: fetchNomuraHoldings,
  kgifund: fetchKgifundHoldings,
  fubon: fetchFubonHoldings,
  allianz: fetchAllianzHoldings,
  taishin: fetchTaishinHoldings,
  ab: fetchAllianceBernsteinHoldings,
  ctbc: fetchCtbcHoldings,
  first: fetchFirstHoldings,
};

async function main() {
  const sqlCommands = [];

  for (const etf of etfs) {
    try {
      console.log(`Fetching constituents for ${etf.code} from ${etf.source}...`);
      const fetcher = FETCHERS[etf.source];
      if (!fetcher) throw new Error(`未知的資料來源：${etf.source}`);
      const holdings = await fetcher(etf.fundCode);

      for (const h of holdings) {
        sqlCommands.push(
          `INSERT OR REPLACE INTO active_etf_holdings (etf_code, etf_name, stock_code, date, shares, weight) VALUES ('${etf.code}', '${etf.name}', '${h.stockCode}', '${todayDate}', ${h.shares}, ${h.weight});`
        );
      }
      console.log(`Parsed ${holdings.length} constituents for ${etf.code}`);
    } catch (e) {
      console.error(`Error crawling ${etf.code}:`, e.message);
    }
  }

  if (sqlCommands.length === 0) {
    console.log('No holdings crawled. Exiting.');
    return;
  }

  const tempSqlFile = path.join(__dirname, 'temp_sync.sql');
  fs.writeFileSync(tempSqlFile, sqlCommands.join('\n'), 'utf8');

  try {
    console.log('Executing SQL statements in D1...');
    const cmd = `npx wrangler d1 execute elan-quant-db ${target} --file="${tempSqlFile}"`;
    const output = execSync(cmd, { encoding: 'utf8' });
    console.log('D1 execution complete.');
    console.log(output);
  } catch (e) {
    console.error('Error executing seed data:', e.message);
    if (e.stdout) console.log('Stdout:', e.stdout);
    if (e.stderr) console.error('Stderr:', e.stderr);
  } finally {
    if (fs.existsSync(tempSqlFile)) {
      fs.unlinkSync(tempSqlFile);
    }
  }
  console.log('Sync complete.');
}

main();
