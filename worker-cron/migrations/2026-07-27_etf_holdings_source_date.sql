-- 使用者質疑「更新日期」只是我們機器人抓取的時間，不是每家投信實際揭露持股的基準日
-- （實測驗證：安聯的NavDate跟PCFDate就是兩個不同日期）。研究了15家發行公司的原始回應，
-- 13家（除了凱基kgifund、聯博ab）都能挖到真正的基準日欄位。這個欄位存那個真正的基準日，
-- 可為NULL（凱基/聯博目前沒有可用的日期來源，誠實留白，不用capture date頂替）。
ALTER TABLE active_etf_holdings ADD COLUMN source_as_of_date TEXT;
