-- 首頁「RSI超賣+成交量暴增」篩選器：stock_daily_price補上volume欄位（之前只存收盤/高/低，
-- 沒存量），加一張存每日篩選結果的小表，讓/api/screener.js只需要單純SELECT最新日期，不用
-- 每次請求都對全市場1700+檔股票重算RSI。
ALTER TABLE stock_daily_price ADD COLUMN volume REAL;

CREATE TABLE IF NOT EXISTS daily_screener_signals (
  date TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT,
  rsi REAL,
  volume_ratio REAL,      -- 今日成交量 / 前5日均量，例如3.5代表今日量是均量的3.5倍（暴增250%）
  close REAL,
  PRIMARY KEY (date, code)
);
