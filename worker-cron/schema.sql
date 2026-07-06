-- 每日全市場快照。情緒指數 5 個子指標的原始輸入都從這張表算（在讀取端 functions/api/sentiment.js 計算衍生值）。
-- 任何欄位當天抓不到就留 NULL，不要用 0 或估計值頂替。
CREATE TABLE IF NOT EXISTS daily_market_data (
  date TEXT PRIMARY KEY,          -- YYYYMMDD
  taiex_close REAL,                -- 加權指數收盤，125日均線乖離率在讀取時計算
  advancers INTEGER,               -- 上漲家數
  decliners INTEGER,               -- 下跌家數
  new_highs INTEGER,               -- 今日創52週新高家數
  new_lows INTEGER,                -- 今日創52週新低家數
  margin_balance_total REAL,       -- 全市場融資今日餘額加總，5日變化率在讀取時計算
  inst_net_buy_count INTEGER,      -- 三大法人合計淨買超家數
  inst_net_sell_count INTEGER      -- 三大法人合計淨賣超家數
);

-- 個股每日收盤/高/低。只保留近一年（由 worker 清理更舊的資料），
-- 用來滾動計算52週新高低，不需要一次查完整歷史。
CREATE TABLE IF NOT EXISTS stock_daily_price (
  code TEXT NOT NULL,
  date TEXT NOT NULL,
  close REAL,
  high REAL,
  low REAL,
  PRIMARY KEY (code, date)
);
CREATE INDEX IF NOT EXISTS idx_stock_daily_price_code_date ON stock_daily_price(code, date);

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
