-- 每日全市場快照。情緒指數 7 個子指標（比照 CNN Fear & Greed Index 的 7 因子架構，換成台股對應
-- 資料源）的原始輸入都從這張表算（在讀取端 functions/api/sentiment.js 計算衍生值）。
-- 任何欄位當天抓不到就留 NULL，不要用 0 或估計值頂替。
CREATE TABLE IF NOT EXISTS daily_market_data (
  date TEXT PRIMARY KEY,          -- YYYYMMDD
  taiex_close REAL,                -- 加權指數收盤，125日均線乖離率在讀取時計算（對應CNN「股價動能」）
  advancers INTEGER,               -- 上漲家數（對應CNN「股價廣度」）
  decliners INTEGER,               -- 下跌家數
  new_highs INTEGER,               -- 今日創52週新高家數（對應CNN「股價強度」）
  new_lows INTEGER,                -- 今日創52週新低家數
  margin_balance_total REAL,       -- 全市場融資今日餘額加總（保留欄位，目前情緒指數未使用）
  inst_net_buy_count INTEGER,      -- 三大法人合計淨買超家數（保留欄位，目前情緒指數未使用）
  inst_net_sell_count INTEGER,     -- 三大法人合計淨賣超家數
  put_call_ratio REAL,             -- 臺指選擇權Put/Call成交量比(%)（對應CNN「Put/Call Ratio」），來源TAIFEX
  vixtwn REAL,                     -- 臺指選擇權波動率指數收盤（對應CNN「VIX」），來源TAIFEX
  govbond_10y_yield REAL,          -- 10年期公債殖利率(%)，5日變化率在讀取時計算（對應CNN「避險需求」），來源TPEx
  corp_bond_spread REAL,           -- 公司債BBB-AAA信用利差(百分點)（對應CNN「垃圾債券需求」，台灣無真正垃圾債市場的替代指標），來源TPEx
  updated_at TEXT                  -- 排程實際寫入這筆資料當下的台北時間（HH:MM），用來驗證/公開實際資料到位時間
);

-- 個股每日收盤/高/低。只保留近一年（由 worker 清理更舊的資料），
-- 用來滾動計算52週新高低，不需要一次查完整歷史。
CREATE TABLE IF NOT EXISTS stock_daily_price (
  code TEXT NOT NULL,
  date TEXT NOT NULL,
  close REAL,
  high REAL,
  low REAL,
  name TEXT,               -- 股票中文名稱，來自 TWSE/TPEx 官方每日資料，不用維護靜態對照表
  volume REAL,             -- 當日成交量（股），給「RSI超賣+成交量暴增」篩選器用
  PRIMARY KEY (code, date)
);
CREATE INDEX IF NOT EXISTS idx_stock_daily_price_code_date ON stock_daily_price(code, date);

-- 首頁「RSI超賣+成交量暴增」篩選器：每天由worker-cron算好整個市場的結果存這裡，
-- /api/screener.js只需要單純SELECT最新日期，不用每次請求都對全市場1700+檔股票重算RSI。
CREATE TABLE IF NOT EXISTS daily_screener_signals (
  date TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT,
  rsi REAL,
  volume_ratio REAL,      -- 今日成交量 / 前5日均量，例如3.5代表今日量是均量的3.5倍（暴增250%）
  close REAL,
  PRIMARY KEY (date, code)
);

-- 大戶持股週快照（只存聚合後的兩個百分比，不存全部17級原始資料），用來算「週變化」。
-- TDCC 只在每週五更新一次，同一週內重複執行 cron 不會產生新的一列（見 worker-cron/src/index.js 的去重判斷）。
CREATE TABLE IF NOT EXISTS holder_weekly_snapshot (
  code TEXT NOT NULL,
  date TEXT NOT NULL,             -- TDCC 資料日期（YYYYMMDD）
  big_holder_pct REAL,            -- level 15（1,000,001股以上）佔集保庫存比例
  mid_holder_pct REAL,            -- level 12+13+14（400,001-1,000,000股）加總佔比
  PRIMARY KEY (code, date)
);
CREATE INDEX IF NOT EXISTS idx_holder_weekly_snapshot_code_date ON holder_weekly_snapshot(code, date);

-- 主動式 ETF 每日持股明細表（Option A & B 籌碼追蹤）
-- shares 可為 NULL：部分發行公司（如國泰投信）官網 API 只揭露持股權重百分比，不揭露實際股數，
-- 這種來源就誠實存 NULL，不要用權重反推一個假的股數。讀取端（active-etf-flow.js）在 shares
-- 缺漏時改用 weight 的變化來判斷加碼/減碼方向，金額欄位則明確標示為「以權重推算」。
CREATE TABLE IF NOT EXISTS active_etf_holdings (
  etf_code TEXT NOT NULL,
  etf_name TEXT NOT NULL,
  stock_code TEXT NOT NULL,       -- 例如 2330
  date TEXT NOT NULL,             -- 資料日期（YYYY-MM-DD 或 YYYYMMDD，統一使用 YYYY-MM-DD 格式）
  shares INTEGER,                 -- 持股股數（來源不揭露股數時為 NULL）
  weight REAL NOT NULL,           -- 持股比重（百分比，如 5.34 表示 5.34%）
  PRIMARY KEY (etf_code, stock_code, date)
);
CREATE INDEX IF NOT EXISTS idx_active_etf_holdings_stock_date ON active_etf_holdings(stock_code, date);
CREATE INDEX IF NOT EXISTS idx_active_etf_holdings_etf_date ON active_etf_holdings(etf_code, date);

-- 只給「只揭露權重、不揭露股數」的發行公司使用（目前僅國泰投信）：存每日基金的股票資產總市值
-- （來自其 GetETFDetailBalList 端點的「股票」分類金額），供讀取端把 weight 變化換算成估計金額。
CREATE TABLE IF NOT EXISTS etf_portfolio_value (
  etf_code TEXT NOT NULL,
  date TEXT NOT NULL,
  stock_value REAL NOT NULL,      -- 基金持有股票部位的總市值（新台幣）
  PRIMARY KEY (etf_code, date)
);
