import { saveSnapshot, loadSnapshotFallback } from '../_lib/kvSnapshot.js';

// 市場情緒指數（自製「貪婪指數」）。完全依賴 D1（daily_market_data，由 worker-cron 每日排程寫入）。
// 方法論：等權重 + 歷史百分位標準化（不是自訂加權公式），比照 CNN Fear & Greed Index 的 7
// 因子架構，每個因子換成對應的台股資料源——
// 每個子指標的「今日原始值」拿去跟自己過去最多 252 個交易日的歷史分布比較，
// percentile = (歷史序列中 <= 今日值 的天數) / 總天數 * 100，7 個子指標的百分位分數做簡單平均。
// 部分因子是「數值越高＝越恐懼」（VIX、Put/Call比、信用利差），這幾個在算完百分位後要
// 用 100-分數 反轉，確保最終總分維持「越高越貪婪」的統一方向。
const MIN_HISTORY = 60;
const MATURE_HISTORY = 252;

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } });
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

// invert=true 代表這個因子「原始值越高＝越恐懼」，percentile 算完後用 100-分數 反轉方向，
// 讓所有因子的最終分數統一維持「越高越貪婪」。
function percentileScore(series, invert) {
  if (series.length === 0) return null;
  const todayValue = series[series.length - 1].value;
  const count = series.filter(s => s.value <= todayValue).length;
  const pct = (count / series.length) * 100;
  return invert ? (100 - pct) : pct;
}

// 股價動能：(今日指數 - 125日均線) / 125日均線。需要至少125天的 taiex_close 才能算出第一個值，
// 這是這個子指標本身的結構性限制，不是資料抓不到——冷啟動天數會比其他因子更長。
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
// 股價廣度：漲跌家數比。
function advanceDeclineSeries(rows) {
  return computeSeries(rows, (rows, i) => {
    const r = rows[i];
    if (r.advancers == null || r.decliners == null) return null;
    const total = r.advancers + r.decliners;
    return total > 0 ? r.advancers / total : null;
  });
}
// 股價強度：52週創新高低家數比。
function newHighLowSeries(rows) {
  return computeSeries(rows, (rows, i) => {
    const r = rows[i];
    if (r.new_highs == null || r.new_lows == null) return null;
    const total = r.new_highs + r.new_lows;
    return total > 0 ? r.new_highs / total : null;
  });
}
// Put/Call比：臺指選擇權成交量比(%)，數值越高代表避險/看跌需求越重，越恐懼。
function putCallSeries(rows) {
  return computeSeries(rows, (rows, i) => rows[i].put_call_ratio);
}
// 波動率：VIXTWN收盤，數值越高代表市場預期波動越劇烈，越恐懼。
function vixTwnSeries(rows) {
  return computeSeries(rows, (rows, i) => rows[i].vixtwn);
}
// 避險需求：10年期公債殖利率的近5日變化——殖利率上升代表資金從公債流出（追逐風險資產）＝越貪婪，
// 殖利率下降代表資金湧入公債避險＝越恐懼。用變化量而非絕對水準，比較貼近CNN原始定義的「股債報酬差」精神。
function govBondYieldChangeSeries(rows) {
  return computeSeries(rows, (rows, i) => {
    if (i < 5) return null;
    const today = rows[i].govbond_10y_yield;
    const prev = rows[i - 5].govbond_10y_yield;
    if (today == null || prev == null) return null;
    return today - prev;
  });
}
// 垃圾債券需求的台股替代：公司債BBB-AAA信用利差（百分點）。利差越窄代表投資人越願意承擔信用風險
// 換取較低評等公司債的較高收益＝越貪婪；利差越寬代表資金往安全等級靠攏＝越恐懼。
function corpSpreadSeries(rows) {
  return computeSeries(rows, (rows, i) => rows[i].corp_bond_spread);
}

// format 決定前端怎麼顯示 rawValue：
//   ratio          — 0~1 的比例，前端要 ×100 顯示成 %（舊3個因子都是這個格式）
//   percent        — 原始值本身已經是百分比數字（如 100.89 代表 100.89%），前端直接顯示、不再 ×100
//   index          — 純數值指數（如VIXTWN的37.11），沒有%意義
//   percent_points — 百分點差值（如殖利率變化、信用利差），顯示成「±X.XX 個百分點」
const INDICATORS = [
  { key: 'indexMomentum', label: '股價動能（加權指數乖離率）', seriesFn: indexMomentumSeries, direction: '乖離越正 → 越貪婪', source: 'TWSE 加權指數收盤', invert: false, format: 'ratio' },
  { key: 'advanceDecline', label: '股價廣度（漲跌家數比）', seriesFn: advanceDeclineSeries, direction: '比例越高 → 越貪婪', source: 'TWSE 每日漲跌家數統計', invert: false, format: 'ratio' },
  { key: 'newHighLow', label: '股價強度（創新高低家數比）', seriesFn: newHighLowSeries, direction: '比例越高 → 越貪婪', source: 'TWSE 全市場個股日成交（自行累積52週高低）', invert: false, format: 'ratio' },
  { key: 'putCallRatio', label: 'Put/Call比（臺指選擇權）', seriesFn: putCallSeries, direction: '比例越高 → 越恐懼', source: 'TAIFEX 臺指選擇權Put/Call比', invert: true, format: 'percent' },
  { key: 'vixTwn', label: '波動率（VIXTWN）', seriesFn: vixTwnSeries, direction: '數值越高 → 越恐懼', source: 'TAIFEX 臺指選擇權波動率指數', invert: true, format: 'index' },
  // 這兩個指標的資料源（TPEx bondCurve.json）從正式環境的Cloudflare Worker呼叫持續失敗
  // （「Too many redirects」導到tpex.org.tw/errors），但用完全相同的程式碼跟headers從本機
  // 直接curl或跑本機workerd都100%成功——研判是TPEx對Cloudflare共用邊緣IP的存取限制，
  // 跟本session稍早確認過的TWSE MIS/SEC EDGAR同一類問題，程式碼層面無法修復。knownIssueNote
  // 會在historyLength===0時顯示給使用者，說明這不是「還沒開始累積」，是持續被擋。
  { key: 'govBondYieldChange', label: '避險需求（10年公債殖利率變化）', seriesFn: govBondYieldChangeSeries, direction: '殖利率上升 → 越貪婪（資金流出債市）', source: 'TPEx 公債殖利率曲線', invert: false, format: 'percent_points', knownIssueNote: '資料來源目前持續無法取得（TPEx對雲端平台共用IP的存取限制，並非本站故障，之後可能自行恢復）' },
  { key: 'corpBondSpread', label: '信用利差（公司債BBB-AAA，垃圾債替代指標）', seriesFn: corpSpreadSeries, direction: '利差越窄 → 越貪婪', source: 'TPEx 公司債殖利率曲線', invert: true, format: 'percent_points', knownIssueNote: '資料來源目前持續無法取得（TPEx對雲端平台共用IP的存取限制，並非本站故障，之後可能自行恢復）' },
];

function levelOf(score) {
  if (score < 25) return '極度恐懼';
  if (score < 45) return '恐懼';
  if (score < 55) return '中性';
  if (score < 75) return '貪婪';
  return '極度貪婪';
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.ELAN_QUANT_DB) {
    // Don't cache this branch — it's a mid-setup state that can change the moment the user
    // finishes binding D1, and we don't want to serve a stale "not bound" message afterward.
    return json({
      indicators: [],
      readyCount: 0,
      totalIndicators: INDICATORS.length,
      greedIndex: null,
      maturityMessage: 'D1 資料庫尚未綁定，無法計算市場情緒指數。',
    });
  }

  // This is one global (non-symbol-specific) resource that only changes once a day when
  // worker-cron runs, so a short cache meaningfully cuts down on repeat D1 reads.
  const cache = caches.default;
  const cacheKey = new Request('https://elan-quant-cache.internal/sentiment', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // 原本只有D1查詢那一步包在try/catch裡，下面的指標計算/百分位/回應組裝完全沒有保護——
  // 任何一個環節丟例外就是未處理的worker錯誤（連json({error...})這層包裝都沒有，更別說
  // KV快照回退），比同類型bug（market-flow.js/margin-ratio.js的「return繞過catch」）還嚴重。
  // 整段都包進同一個try，任何失敗都能退回快照。
  try {
    const result = await env.ELAN_QUANT_DB
      .prepare('SELECT date, taiex_close, advancers, decliners, new_highs, new_lows, put_call_ratio, vixtwn, govbond_10y_yield, corp_bond_spread, updated_at FROM daily_market_data ORDER BY date ASC')
      .all();
    const rows = result.results || [];

    if (rows.length === 0) {
      // rows為空有兩種可能：真的還沒開始累積（沒有快照，fallback為null，走下面「累積中」
      // 訊息），或這次D1查詢剛好暫時性失敗但實際上已經有歷史資料——有快照可退時不該顯示
      // 誤導的「累積中」訊息蓋掉本來已經成熟的情緒指數。
      const fallback = await loadSnapshotFallback(env, 'sentiment');
      if (fallback) return json(fallback);
      const response = json({
        indicators: [],
        readyCount: 0,
        totalIndicators: INDICATORS.length,
        greedIndex: null,
        maturityMessage: `資料累積中，0/${INDICATORS.length} 項可用（尚無任何歷史資料，請確認每日排程 Worker 已部署並執行過）。`,
      }, 200, { 'Cache-Control': 'public, max-age=600' });
      context.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }

    const indicators = INDICATORS.map(ind => {
      // Cap to the most recent MATURE_HISTORY days — a rolling window, not all-time-since-launch —
      // so scores stay relative to roughly "the past year" instead of drifting as more history piles up.
      const series = ind.seriesFn(rows).slice(-MATURE_HISTORY);
      const historyLength = series.length;
      const base = { key: ind.key, label: ind.label, source: ind.source, direction: ind.direction, format: ind.format, maturity: `${historyLength}/${MATURE_HISTORY}` };
      if (historyLength === 0) {
        return { ...base, status: 'no_data', note: ind.knownIssueNote };
      }
      const latest = series[series.length - 1];
      if (historyLength < MIN_HISTORY) {
        return { ...base, status: 'accumulating', rawValue: latest.value, date: latest.date, historyLength };
      }
      return {
        ...base,
        status: 'ready',
        rawValue: latest.value,
        percentileScore: percentileScore(series, ind.invert),
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

    const payload = {
      indicators,
      readyCount: ready.length,
      totalIndicators: INDICATORS.length,
      greedIndex,
      level,
      maturityMessage,
      methodology: '等權重 + 歷史百分位標準化（近252個交易日），方法論參考 CNN Fear & Greed Index，非官方標準，僅供參考。',
      latestDate: rows[rows.length - 1].date,
      latestUpdatedAt: rows[rows.length - 1].updated_at || null,
    };
    context.waitUntil(saveSnapshot(env, 'sentiment', payload));
    const response = json(payload, 200, { 'Cache-Control': 'public, max-age=600' });
    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (e) {
    const fallback = await loadSnapshotFallback(env, 'sentiment');
    if (fallback) return json(fallback);
    return json({ error: `查詢/計算市場情緒指數失敗：${e.message}` }, 500);
  }
}
