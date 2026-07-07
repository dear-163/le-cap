const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const target = process.argv.includes('--remote') ? '--remote' : '--local';

console.log(`Starting Active ETF holdings sync in ${target === '--remote' ? 'REMOTE' : 'LOCAL'} mode...`);

// Expanded seed data reflecting daily snapshots (5 net buys, 5 net sells)
const seedData = [
  // 2026-07-06 (Monday)
  // Buys group (initial holdings)
  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2330', date: '2026-07-06', shares: 1050000, weight: 5.7 },
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '2330', date: '2026-07-06', shares: 1180000, weight: 6.0 },

  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2454', date: '2026-07-06', shares: 290000, weight: 3.6 },
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '2454', date: '2026-07-06', shares: 360000, weight: 4.6 },

  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2317', date: '2026-07-06', shares: 2000000, weight: 4.5 },
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '2317', date: '2026-07-06', shares: 1800000, weight: 4.0 },

  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2308', date: '2026-07-06', shares: 400000, weight: 2.8 },
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '2308', date: '2026-07-06', shares: 350000, weight: 2.5 },

  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2382', date: '2026-07-06', shares: 900000, weight: 3.2 },
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '2382', date: '2026-07-06', shares: 850000, weight: 3.0 },

  // Sells group (initial holdings)
  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '5347', date: '2026-07-06', shares: 800000, weight: 4.2 },
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '5347', date: '2026-07-06', shares: 700000, weight: 3.6 },

  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2303', date: '2026-07-06', shares: 3000000, weight: 3.5 },
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '2303', date: '2026-07-06', shares: 2500000, weight: 3.0 },

  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2603', date: '2026-07-06', shares: 600000, weight: 2.1 },
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '2603', date: '2026-07-06', shares: 500000, weight: 1.8 },

  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '3231', date: '2026-07-06', shares: 1500000, weight: 2.4 },
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '3231', date: '2026-07-06', shares: 1200000, weight: 2.0 },

  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2376', date: '2026-07-06', shares: 500000, weight: 1.9 },
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '2376', date: '2026-07-06', shares: 450000, weight: 1.7 },


  // 2026-07-07 (Tuesday, Today)
  // Buys group (increased holdings)
  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2330', date: '2026-07-07', shares: 1100000, weight: 6.0 }, // +50k
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '2330', date: '2026-07-07', shares: 1250000, weight: 6.5 }, // +70k (Net +120k)

  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2454', date: '2026-07-07', shares: 310000, weight: 3.9 },  // +20k
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '2454', date: '2026-07-07', shares: 380000, weight: 4.8 },  // +20k (Net +40k)

  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2317', date: '2026-07-07', shares: 2050000, weight: 4.7 }, // +50k
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '2317', date: '2026-07-07', shares: 1840000, weight: 4.2 }, // +40k (Net +90k)

  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2308', date: '2026-07-07', shares: 420000, weight: 3.0 },  // +20k
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '2308', date: '2026-07-07', shares: 360000, weight: 2.6 },  // +10k (Net +30k)

  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2382', date: '2026-07-07', shares: 930000, weight: 3.3 },  // +30k
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '2382', date: '2026-07-07', shares: 870000, weight: 3.1 },  // +20k (Net +50k)

  // Sells group (decreased holdings - Trimming/減碼)
  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '5347', date: '2026-07-07', shares: 750000, weight: 3.8 },  // -50k
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '5347', date: '2026-07-07', shares: 670000, weight: 3.4 },  // -30k (Net -80k)

  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2303', date: '2026-07-07', shares: 2920000, weight: 3.3 }, // -80k
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '2303', date: '2026-07-07', shares: 2430000, weight: 2.9 }, // -70k (Net -150k)

  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2603', date: '2026-07-07', shares: 570000, weight: 2.0 },  // -30k
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '2603', date: '2026-07-07', shares: 470000, weight: 1.7 },  // -30k (Net -60k)

  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '3231', date: '2026-07-07', shares: 1440000, weight: 2.3 }, // -60k
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '3231', date: '2026-07-07', shares: 1160000, weight: 1.9 }, // -40k (Net -100k)

  { etf_code: '00980A', etf_name: '野村臺灣智慧優選主動式ETF', stock_code: '2376', date: '2026-07-07', shares: 480000, weight: 1.8 },  // -20k
  { etf_code: '00981A', etf_name: '統一臺灣主動成長動能ETF', stock_code: '2376', date: '2026-07-07', shares: 430000, weight: 1.6 }   // -20k (Net -40k)
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
