-- 首頁「RSI超賣+成交量暴增」篩選器新增鏡像方向：RSI超買+成交量暴增（潛在過熱訊號）。
-- 沿用同一張表，加一欄signal_type區分方向；一檔股票同一天RSI不可能同時<30又>70，
-- 所以(date,code)仍然是唯一鍵，不需要改PRIMARY KEY。
ALTER TABLE daily_screener_signals ADD COLUMN signal_type TEXT NOT NULL DEFAULT 'oversold';
