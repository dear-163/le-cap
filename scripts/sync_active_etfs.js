const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const target = process.argv.includes('--remote') ? '--remote' : '--local';

console.log(`Starting Active ETF holdings sync in ${target === '--remote' ? 'REMOTE' : 'LOCAL'} mode...`);

// Expanded seed data reflecting daily snapshots (5 net buys, 5 net sells)
const seedData = [
  // 2026-07-06 (Yesterday)
  // 00981A Holdings (Unified)
  { etf_code: '00981A', etf_name: '主動統一台股增長主動式ETF', stock_code: '2383', date: '2026-07-06', shares: 500000, weight: 3.5 }, // 台光電
  { etf_code: '00981A', etf_name: '主動統一台股增長主動式ETF', stock_code: '5274', date: '2026-07-06', shares: 80000, weight: 6.4 },  // 信驊
  { etf_code: '00981A', etf_name: '主動統一台股增長主動式ETF', stock_code: '2454', date: '2026-07-06', shares: 360000, weight: 10.1 }, // 聯發科
  { etf_code: '00981A', etf_name: '主動統一台股增長主動式ETF', stock_code: '2449', date: '2026-07-06', shares: 1200000, weight: 2.9 }, // 京元電
  { etf_code: '00981A', etf_name: '主動統一台股增長主動式ETF', stock_code: '6515', date: '2026-07-06', shares: 180000, weight: 3.2 },  // 穎崴
  { etf_code: '00981A', etf_name: '主動統一台股增長主動式ETF', stock_code: '2330', date: '2026-07-06', shares: 1180000, weight: 23.6 }, // 台積電

  // 00980A Holdings (Nomura)
  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2383', date: '2026-07-06', shares: 400000, weight: 2.8 },
  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '5274', date: '2026-07-06', shares: 60000, weight: 4.8 },
  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2454', date: '2026-07-06', shares: 290000, weight: 8.1 },
  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2449', date: '2026-07-06', shares: 1000000, weight: 2.4 },
  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '6515', date: '2026-07-06', shares: 150000, weight: 2.7 },
  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2330', date: '2026-07-06', shares: 1050000, weight: 21.0 },

  // 2026-07-07 (Today)
  // 00981A Holdings (Unified)
  { etf_code: '00981A', etf_name: '主動統一台股增長主動式ETF', stock_code: '2383', date: '2026-07-07', shares: 580000, weight: 4.1 }, // 加碼 +80k
  { etf_code: '00981A', etf_name: '主動統一台股增長主動式ETF', stock_code: '5274', date: '2026-07-07', shares: 90000, weight: 7.2 },  // 加碼 +10k
  { etf_code: '00981A', etf_name: '主動統一台股增長主動式ETF', stock_code: '2454', date: '2026-07-07', shares: 380000, weight: 10.6 }, // 加碼 +20k
  { etf_code: '00981A', etf_name: '主動統一台股增長主動式ETF', stock_code: '2449', date: '2026-07-07', shares: 1150000, weight: 2.8 }, // 減碼 -50k
  { etf_code: '00981A', etf_name: '主動統一台股增長主動式ETF', stock_code: '6515', date: '2026-07-07', shares: 170000, weight: 3.1 },  // 減碼 -10k
  { etf_code: '00981A', etf_name: '主動統一台股增長主動式ETF', stock_code: '2330', date: '2026-07-07', shares: 1200000, weight: 24.0 }, // 加碼 +20k

  // 00980A Holdings (Nomura)
  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2383', date: '2026-07-07', shares: 420000, weight: 2.9 }, // 加碼 +20k
  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '5274', date: '2026-07-07', shares: 62000, weight: 5.0 },  // 加碼 +2k
  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2454', date: '2026-07-07', shares: 300000, weight: 8.4 },  // 加碼 +10k
  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2449', date: '2026-07-07', shares: 980000, weight: 2.3 },  // 減碼 -20k
  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '6515', date: '2026-07-07', shares: 145000, weight: 2.6 },  // 減碼 -5k
  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2330', date: '2026-07-07', shares: 1060000, weight: 21.2 }  // 加碼 +10k
];

const priceSeeds = [];
const priceMap = {
  '2330': 1000, '2454': 1400, '2317': 200, '2308': 380, '2382': 320,
  '5347': 80, '2303': 50, '2603': 200, '3231': 110, '2376': 270
};
for (const code in priceMap) {
  priceSeeds.push(`INSERT OR REPLACE INTO stock_daily_price (code, date, close) VALUES ('${code}', '2026-07-06', ${priceMap[code]});`);
  priceSeeds.push(`INSERT OR REPLACE INTO stock_daily_price (code, date, close) VALUES ('${code}', '2026-07-07', ${priceMap[code]});`);
}

const sqlStatements = seedData.map(d => {
  return `INSERT OR REPLACE INTO active_etf_holdings (etf_code, etf_name, stock_code, date, shares, weight) VALUES ('${d.etf_code}', '${d.etf_name}', '${d.stock_code}', '${d.date}', ${d.shares}, ${d.weight});`;
}).concat(priceSeeds).join('\n');

const tempSqlFile = path.join(__dirname, 'temp_sync.sql');
fs.writeFileSync(tempSqlFile, sqlStatements, 'utf8');

try {
  console.log('Writing seed data to D1...');
  const cmd = `npx wrangler d1 execute elan-quant-db ${target} --file="${tempSqlFile}"`;
  const output = execSync(cmd, { encoding: 'utf8' });
  console.log('D1 execution complete. Output:');
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
