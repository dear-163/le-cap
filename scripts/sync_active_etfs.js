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

async function main() {
  const sqlCommands = [];

  for (const etf of etfs) {
    try {
      console.log(`Fetching constituents for ${etf.code} from ${etf.source}...`);
      const holdings = etf.source === 'ezmoney'
        ? await fetchEzmoneyHoldings(etf.fundCode)
        : await fetchNomuraHoldings(etf.fundCode);

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
