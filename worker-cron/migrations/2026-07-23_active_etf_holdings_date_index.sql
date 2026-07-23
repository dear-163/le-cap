-- active-etf-flow.js／worker-cron/src/index.js都有多處單純用WHERE date = ?或
-- SELECT DISTINCT date查active_etf_holdings，既有的(stock_code, date)跟(etf_code, date)
-- 複合索引都用不上（要先指定stock_code/etf_code才吃得到索引），這幾個查詢實際上都是全表
-- 掃描。加一個單純date欄位的索引。
CREATE INDEX IF NOT EXISTS idx_active_etf_holdings_date ON active_etf_holdings(date);
