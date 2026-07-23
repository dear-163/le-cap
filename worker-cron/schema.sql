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
  govbond_10y_yield REAL,          -- 美國10年期公債殖利率(%)，5日變化率在讀取時計算（對應CNN「避險需求」），來源Yahoo Finance ^TNX
                                    -- （原本查TPEx台灣公債殖利率，2026-07-21發現該端點從正式環境持續被擋，改用CNN原始方法論
                                    -- 本來就採用的美國資料，比硬套台灣資料更貼近CNN原始定義，見worker-cron/src/index.js註解）
  corp_bond_spread REAL,           -- 美國高收益債OAS利差(百分點)（對應CNN「垃圾債券需求」），來源FRED BAMLH0A0HYM2
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

-- 首頁「RSI超賣/超買+成交量暴增」篩選器：每天由worker-cron算好整個市場的結果存這裡，
-- /api/screener.js只需要單純SELECT最新日期，不用每次請求都對全市場1700+檔股票重算RSI。
-- 一檔股票同一天RSI不可能同時<30又>70，所以signal_type不影響(date,code)的唯一性。
CREATE TABLE IF NOT EXISTS daily_screener_signals (
  date TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT,
  rsi REAL,
  volume_ratio REAL,      -- 今日成交量 / 前5日均量，例如3.5代表今日量是均量的3.5倍（暴增250%）
  close REAL,
  signal_type TEXT NOT NULL DEFAULT 'oversold',  -- 'oversold'（RSI<30）或 'overbought'（RSI>70）
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
-- 好幾處查詢單純用WHERE date = ?（不先指定stock_code/etf_code），上面兩個複合索引都用不上，
-- 額外加一個純date索引。
CREATE INDEX IF NOT EXISTS idx_active_etf_holdings_date ON active_etf_holdings(date);

-- 只給「只揭露權重、不揭露股數」的發行公司使用（目前僅國泰投信）：存每日基金的股票資產總市值
-- （來自其 GetETFDetailBalList 端點的「股票」分類金額），供讀取端把 weight 變化換算成估計金額。
CREATE TABLE IF NOT EXISTS etf_portfolio_value (
  etf_code TEXT NOT NULL,
  date TEXT NOT NULL,
  stock_value REAL NOT NULL,      -- 基金持有股票部位的總市值（新台幣）
  PRIMARY KEY (etf_code, date)
);

-- 每個排程步驟最近一次執行結果，只存單一列（每個step一列，用INSERT OR REPLACE覆蓋），
-- 不是歷史紀錄表。動機：公債殖利率那個步驟連續252天失敗都沒人發現，因為失敗只會印在
-- Cloudflare log裡，log沒人即時盯著看就等於不存在。這張表讓人可以隨時用一句SQL查「現在
-- 哪些步驟是壞的、上次失敗的錯誤訊息是什麼」，不用依賴wrangler tail即時監看。
CREATE TABLE IF NOT EXISTS cron_diagnostics (
  step TEXT PRIMARY KEY,          -- 步驟名稱，例如 'bondCurve'、'taiexClose'
  last_run_at TEXT,               -- 最近一次執行的台北時間日期+HH:MM
  last_success_at TEXT,           -- 最近一次成功的台北時間日期+HH:MM，成功時才更新
  last_error TEXT                 -- 最近一次失敗的錯誤訊息，成功時清成NULL
);

-- 每天把ETF加碼/減碼排行前5買超+前5賣超記錄下來，之後回頭檢查這些訊號後續5個交易日
-- 股價表現，算出「勝率」（買超後漲/賣超後跌算贏）。只用有真實股數的持股算訊號（不含只
-- 揭露權重的發行公司，例如國泰），避免權重估算誤差污染回測結果——這是跟即時排行榜
-- （functions/api/active-etf-flow.js）故意不同的簡化版，即時榜為了呈現完整才納入權重
-- 估算，這裡為了回測準確度寧可少一點訊號來源。
CREATE TABLE IF NOT EXISTS etf_signal_outcomes (
  signal_date TEXT NOT NULL,      -- 訊號產生的揭露日（YYYY-MM-DD）
  stock_code TEXT NOT NULL,
  stock_name TEXT,
  action TEXT NOT NULL,           -- '買超' 或 '賣超'
  signal_price REAL,              -- 訊號當天收盤價
  outcome_price REAL,             -- 訊號後第5個交易日收盤價，還沒到就是NULL
  outcome_date TEXT,              -- 對應的日期
  win INTEGER,                    -- 1=方向正確（買超後漲/賣超後跌）、0=方向錯誤、NULL=還沒評估
  PRIMARY KEY (signal_date, stock_code)
);
