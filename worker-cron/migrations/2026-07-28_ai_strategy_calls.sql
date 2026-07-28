-- 「AI 深度技術判讀」的進場/停損/停利建議記錄下來，之後回頭比對每日高低價驗證勝率，
-- 跟既有的etf_signal_outcomes是同樣的「不能自己說準就是準」精神，但判定邏輯不同（看誰先
-- 觸及停利/停損，不是固定N天後看方向）。
CREATE TABLE IF NOT EXISTS ai_strategy_calls (
  stock_code TEXT NOT NULL,
  call_date TEXT NOT NULL,
  entry_level TEXT NOT NULL,
  entry_price REAL NOT NULL,
  stop_level TEXT NOT NULL,
  stop_price REAL NOT NULL,
  target_level TEXT NOT NULL,
  target_price REAL NOT NULL,
  outcome TEXT,
  outcome_date TEXT,
  PRIMARY KEY (stock_code, call_date)
);
CREATE INDEX IF NOT EXISTS idx_ai_strategy_calls_outcome ON ai_strategy_calls(outcome);
