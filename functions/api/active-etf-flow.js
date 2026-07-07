function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
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

    // Fetch each code's most recent close only (not the full 245-day history) — a plain
    // unordered SELECT here previously let whichever row D1 happened to return last for a
    // given code win, which in practice was often a stale price over a year old (e.g. TSMC's
    // 2025-06-11 close of 1065 instead of its actual latest close of ~2460).
    const priceRows = await env.ELAN_QUANT_DB
      .prepare('SELECT code, close FROM stock_daily_price WHERE date = (SELECT MAX(date) FROM stock_daily_price)')
      .all();
    const priceMap = {};
    if (priceRows.results) {
      for (const p of priceRows.results) {
        priceMap[p.code] = p.close;
      }
    }

    const STOCK_NAMES = {
      '2330': '台積電', '2454': '聯發科', '2317': '鴻海', '2308': '台達電', '2382': '廣達',
      '5347': '世界先進', '2303': '聯電', '2603': '長榮', '3231': '緯創', '2376': '技嘉',
      '2383': '台光電', '5274': '信驊', '2449': '京元電', '6515': '穎崴',
      '2327': '國巨', '2345': '智邦', '3008': '大立光', '3711': '日月光投控', '2881': '富邦金',
      '2882': '國泰金', '2301': '光寶科', '2357': '華碩', '3034': '聯詠', '2408': '南亞科',
      '3017': '奇鋐', '3037': '欣興', '6223': '旺矽', '6669': '緯穎'
    };

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
        
        const etfName = list[0]?.etf_name || '主動式 ETF';
        const stockMap = {};
        for (const r of list) {
          if (!stockMap[r.stock_code]) {
            stockMap[r.stock_code] = { stock_code: r.stock_code, today: null, yesterday: null };
          }
          if (r.date === todayDate) stockMap[r.stock_code].today = r;
          else stockMap[r.stock_code].yesterday = r;
        }

        const flow = [];
        for (const code in stockMap) {
          const item = stockMap[code];
          const t = item.today;
          const y = item.yesterday;

          if (!t) continue;

          let changeShares = 0;
          let changeWeight = 0;
          let action = '無變動';

          if (t && y) {
            changeShares = t.shares - y.shares;
            changeWeight = t.weight - y.weight;
          } else if (t) {
            changeShares = t.shares;
            changeWeight = t.weight;
          }

          if (changeShares > 0) action = '加碼';
          else if (changeShares < 0) action = '減碼';

          const price = priceMap[code] || null;

          flow.push({
            stockCode: code,
            stockName: STOCK_NAMES[code] || `個股 ${code}`,
            action,
            shares: t ? t.shares : 0,
            weight: t ? t.weight : 0,
            changeShares,
            changeWeight,
            changeAmount: price != null ? changeShares * price : null,
            totalAmount: price != null ? (t ? t.shares : 0) * price : null,
            date: todayDate,
            comparedTo: yesterdayDate
          });
        }

        return json({
          date: todayDate,
          comparedTo: yesterdayDate,
          isEtf: true,
          etfCode,
          etfName,
          flow: flow.filter(f => f.changeShares !== 0 || f.shares > 0)
        });
      }

      // Default stock query
      const match = symbol.match(/^(\d{4,6})/);
      if (!match) {
        return json({ date: todayDate, symbol, flow: [], note: '非台股純數字代號，暫不支援主動式 ETF 追蹤。' });
      }
      const stockCode = match[1];
      const price = priceMap[stockCode] || null;

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
        const t = item.today;
        const y = item.yesterday;

        let changeShares = 0;
        let changeWeight = 0;
        let action = '無變動';

        if (t && y) {
          changeShares = t.shares - y.shares;
          changeWeight = t.weight - y.weight;
        } else if (t) {
          changeShares = t.shares;
          changeWeight = t.weight;
        } else if (y) {
          changeShares = -y.shares;
          changeWeight = -y.weight;
        }

        if (changeShares > 0) action = '買進';
        else if (changeShares < 0) action = '賣出';

        flow.push({
          etfCode: item.etf_code,
          etfName: item.etf_name,
          action,
          shares: t ? t.shares : 0,
          weight: t ? t.weight : 0,
          changeShares,
          changeWeight,
          changeAmount: price != null ? changeShares * price : null,
          date: todayDate,
          comparedTo: yesterdayDate
        });
      }

      return json({
        date: todayDate,
        comparedTo: yesterdayDate,
        symbol: stockCode,
        flow: flow.filter(f => f.changeShares !== 0 || f.shares > 0)
      });
    }

    // IF symbol is NOT specified: return market-wide rankings (Option B)
    const allQuery = yesterdayDate
      ? 'SELECT etf_code, etf_name, stock_code, shares, weight, date FROM active_etf_holdings WHERE date IN (?, ?)'
      : 'SELECT etf_code, etf_name, stock_code, shares, weight, date FROM active_etf_holdings WHERE date = ?';
    
    const allBindings = yesterdayDate ? [todayDate, yesterdayDate] : [todayDate];
    const allRecords = await env.ELAN_QUANT_DB.prepare(allQuery).bind(...allBindings).all();
    const recordsList = allRecords.results || [];

    // Group by stock_code
    const stockChanges = {};
    for (const r of recordsList) {
      if (!stockChanges[r.stock_code]) {
        stockChanges[r.stock_code] = { stock_code: r.stock_code, todayShares: 0, yesterdayShares: 0 };
      }
      if (r.date === todayDate) stockChanges[r.stock_code].todayShares += r.shares;
      else stockChanges[r.stock_code].yesterdayShares += r.shares;
    }

    const changes = [];
    for (const code in stockChanges) {
      const item = stockChanges[code];
      const changeShares = item.todayShares - item.yesterdayShares;
      const price = priceMap[code] || null;
      // No real price on record for this code (e.g. brand-new listing, or a TPEx holding —
      // stock_daily_price is TWSE-only) — skip rather than rank it using a guessed price.
      if (price == null || changeShares === 0) continue;
      const changeAmount = changeShares * price;
      changes.push({
        stock_code: code,
        stock_name: STOCK_NAMES[code] || ('個股 ' + code),
        changeShares,
        changeAmount,
        action: changeAmount > 0 ? '買超' : '賣超'
      });
    }

    // Sort to find top buys and sells by changeAmount
    const buys = changes.filter(c => c.changeAmount > 0).sort((a, b) => b.changeAmount - a.changeAmount).slice(0, 5);
    const sells = changes.filter(c => c.changeAmount < 0).sort((a, b) => a.changeAmount - b.changeAmount).slice(0, 5);

    return json({
      date: todayDate,
      comparedTo: yesterdayDate,
      rankings: { buys, sells }
    });

  } catch (error) {
    return json({ error: `查詢主動式 ETF 籌碼數據失敗：${error.message}` }, 500);
  }
}
