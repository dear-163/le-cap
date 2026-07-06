// 市場情緒指數（自製「貪婪指數」）。完全依賴 D1（daily_market_data，由 worker-cron 每日排程寫入）。
// 方法論：等權重 + 歷史百分位標準化（不是自訂加權公式）——
// 每個子指標的「今日原始值」拿去跟自己過去最多 252 個交易日的歷史分布比較，
// percentile = (歷史序列中 <= 今日值 的天數) / 總天數 * 100，5 個子指標的百分位分數做簡單平均。
const MIN_HISTORY = 60;
const MATURE_HISTORY = 252;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// 從 rows（依日期升冪排序）算出某個子指標「每一天」的原始值序列，跳過算不出來的日子（不是用0頂替）。
function computeSeries(rows, mapFn) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const v = mapFn(rows, i);
    if (v != null && isFinite(v)) out.push({ date: rows[i].date, value: v });
  }
  return out;
}

function percentileScore(series) {
  if (series.length === 0) return null;
  const todayValue = series[series.length - 1].value;
  const count = series.filter(s => s.value <= todayValue).length;
  return (count / series.length) * 100;
}

// 大盤動能：(今日指數 - 125日均線) / 125日均線。需要至少125天的 taiex_close 才能算出第一個值，
// 這是這個子指標本身的結構性限制，不是資料抓不到——冷啟動天數會比其他4個子指標更長。
function indexMomentumSeries(rows) {
  return computeSeries(rows, (rows, i) => {
    if (i < 124) return null;
    const window = rows.slice(i - 124, i + 1).map(r => r.taiex_close).filter(v => v != null);
    if (window.length < 125) return null;
    const ma = window.reduce((s, v) => s + v, 0) / window.length;
    const close = rows[i].taiex_close;
    if (close == null || ma === 0) return null;
    return (close - ma) / ma;
  });
}
function advanceDeclineSeries(rows) {
  return computeSeries(rows, (rows, i) => {
    const r = rows[i];
    if (r.advancers == null || r.decliners == null) return null;
    const total = r.advancers + r.decliners;
    return total > 0 ? r.advancers / total : null;
  });
}
function newHighLowSeries(rows) {
  return computeSeries(rows, (rows, i) => {
    const r = rows[i];
    if (r.new_highs == null || r.new_lows == null) return null;
    const total = r.new_highs + r.new_lows;
    return total > 0 ? r.new_highs / total : null;
  });
}
// 融資餘額變化率：跟5筆之前（近5個交易日）的全市場融資餘額比較，用陣列索引位移而非日曆天數。
function marginChangeSeries(rows) {
  return computeSeries(rows, (rows, i) => {
    if (i < 5) return null;
    const today = rows[i].margin_balance_total;
    const prev = rows[i - 5].margin_balance_total;
    if (today == null || prev == null || prev === 0) return null;
    return (today - prev) / prev;
  });
}
function instFlowSeries(rows) {
  return computeSeries(rows, (rows, i) => {
    const r = rows[i];
    if (r.inst_net_buy_count == null || r.inst_net_sell_count == null) return null;
    const total = r.inst_net_buy_count + r.inst_net_sell_count;
    return total > 0 ? r.inst_net_buy_count / total : null;
  });
}

const INDICATORS = [
  { key: 'indexMomentum', label: '大盤動能（指數乖離率）', seriesFn: indexMomentumSeries, direction: '乖離越正 → 越貪婪', source: 'TWSE 加權指數收盤' },
  { key: 'advanceDecline', label: '漲跌家數比', seriesFn: advanceDeclineSeries, direction: '比例越高 → 越貪婪', source: 'TWSE 每日漲跌家數統計' },
  { key: 'newHighLow', label: '創新高低家數比', seriesFn: newHighLowSeries, direction: '比例越高 → 越貪婪', source: 'TWSE 全市場個股日成交（自行累積52週高低）' },
  { key: 'marginChange', label: '融資餘額變化率（近5日）', seriesFn: marginChangeSeries, direction: '增幅越大 → 越貪婪', source: 'TWSE 融資融券餘額' },
  { key: 'instFlow', label: '三大法人買超家數比', seriesFn: instFlowSeries, direction: '比例越高 → 越貪婪', source: 'TWSE 三大法人買賣超日報' },
];

function levelOf(score) {
  if (score < 25) return '極度恐懼';
  if (score < 45) return '恐懼';
  if (score < 55) return '中性';
  if (score < 75) return '貪婪';
  return '極度貪婪';
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.ELAN_QUANT_DB) {
    return json({
      indicators: [],
      readyCount: 0,
      totalIndicators: INDICATORS.length,
      greedIndex: null,
      maturityMessage: 'D1 資料庫尚未綁定，無法計算市場情緒指數。',
    });
  }

  let rows;
  try {
    const result = await env.ELAN_QUANT_DB
      .prepare('SELECT date, taiex_close, advancers, decliners, new_highs, new_lows, margin_balance_total, inst_net_buy_count, inst_net_sell_count FROM daily_market_data ORDER BY date ASC')
      .all();
    rows = result.results || [];
  } catch (e) {
    return json({ error: `查詢 D1 daily_market_data 失敗：${e.message}` }, 500);
  }

  if (rows.length === 0) {
    return json({
      indicators: [],
      readyCount: 0,
      totalIndicators: INDICATORS.length,
      greedIndex: null,
      maturityMessage: '資料累積中，0/5 項可用（尚無任何歷史資料，請確認每日排程 Worker 已部署並執行過）。',
    });
  }

  const indicators = INDICATORS.map(ind => {
    // Cap to the most recent MATURE_HISTORY days — a rolling window, not all-time-since-launch —
    // so scores stay relative to roughly "the past year" instead of drifting as more history piles up.
    const series = ind.seriesFn(rows).slice(-MATURE_HISTORY);
    const historyLength = series.length;
    const base = { key: ind.key, label: ind.label, source: ind.source, direction: ind.direction, maturity: `${historyLength}/${MATURE_HISTORY}` };
    if (historyLength === 0) {
      return { ...base, status: 'no_data' };
    }
    const latest = series[series.length - 1];
    if (historyLength < MIN_HISTORY) {
      return { ...base, status: 'accumulating', rawValue: latest.value, date: latest.date, historyLength };
    }
    return {
      ...base,
      status: 'ready',
      rawValue: latest.value,
      percentileScore: percentileScore(series),
      date: latest.date,
      historyLength,
    };
  });

  const ready = indicators.filter(r => r.status === 'ready');
  let greedIndex = null, level = null, maturityMessage = null;
  if (ready.length >= 3) {
    greedIndex = ready.reduce((s, r) => s + r.percentileScore, 0) / ready.length;
    level = levelOf(greedIndex);
  } else {
    maturityMessage = `資料累積中，${ready.length}/${INDICATORS.length} 項指標可用（需要至少 3 項才能顯示總分）。`;
  }

  return json({
    indicators,
    readyCount: ready.length,
    totalIndicators: INDICATORS.length,
    greedIndex,
    level,
    maturityMessage,
    methodology: '等權重 + 歷史百分位標準化（近252個交易日），方法論參考 CNN Fear & Greed Index，非官方標準，僅供參考。',
    latestDate: rows[rows.length - 1].date,
  });
}
