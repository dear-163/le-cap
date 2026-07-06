# Élan Quant

即時技術分析（Yahoo Finance／FMP）+ Gemini AI 基本面分析網路 App。前端為純靜態頁面，`/api/*` 由 Cloudflare Pages Functions 代管，訪客預設不需要自己申請任何 Key。訪客也可以在「使用自己的 API Key」面板貼上自己的 Gemini／FMP Key（見下方「BYOK」章節）。

## 專案結構

```
public/            靜態前端（index.html / styles.css / app.js）
functions/api/
  quote.js         GET  /api/quote?symbol=&period=   伺服器端抓 Yahoo Finance / FMP，含 45 秒邊緣快取
  analyze.js       POST /api/analyze                  組 Gemini prompt、串流回應、KV 每日速率限制
wrangler.toml      Cloudflare Pages 專案設定 + KV binding
```

## 本機開發

```bash
npm install -g wrangler   # 若尚未安裝
cp .dev.vars.example .dev.vars   # 填入你自己的 GEMINI_API_KEY（必填）與 FMP_KEY（選填）
wrangler pages dev public
```

開啟終端機顯示的網址（預設 http://localhost:8788），輸入股票代號測試。

## 部署到 Cloudflare Pages

1. `git init && git add -A && git commit -m "init"`，推到 GitHub。
2. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git，選這個 repo。
   - Build command：留空（純靜態，無需 build）
   - Build output directory：`public`
3. 建立 KV namespace：`wrangler kv namespace create RATE_LIMIT_KV`，把回傳的 id 貼進 `wrangler.toml`，或直接在 Pages 專案的 Settings → Functions → KV namespace bindings 手動綁定 `RATE_LIMIT_KV`。
4. 在 Pages 專案 Settings → Environment variables 新增加密的 Secret：
   - `GEMINI_API_KEY`（必填，https://aistudio.google.com/app/apikey 免費申請）
   - `FMP_KEY`（選填，補充美股財報數據，https://financialmodelingprep.com）
5. 觸發部署（push 到 main 分支即會自動 build & 部署）。

## 速率限制

`functions/api/analyze.js` 用 KV 依 IP 與日期計數：每個 IP 每日上限 60 次呼叫（`PER_IP_DAILY_LIMIT`），全站每日上限 2000 次（`GLOBAL_DAILY_LIMIT`），超過會回傳 429 並顯示友善訊息。這兩個數字可依實際流量與預算直接在 `analyze.js` 調整。

## Yahoo quoteSummary/v7 的 cookie + crumb

Yahoo 從某個時間點起把 `quoteSummary`／`v7 quote` 這兩支非官方 API 鎖起來，沒帶正確的 session cookie + crumb 一律回 401（跟 yfinance 這類套件近期得處理的問題一樣）。`quote.js` 的 `getYahooCrumb()`：

1. GET `https://fc.yahoo.com` 拿一組 session cookie（回應本身可能是 404，但 `Set-Cookie` header 有效）。
2. 帶著這組 cookie GET `https://query2.finance.yahoo.com/v1/test/getcrumb` 換一個 crumb 字串。
3. 之後所有 quoteSummary/v7 請求都帶上 `Cookie` header 與 `&crumb=`。

crumb+cookie 會存進 `RATE_LIMIT_KV`（20 分鐘 TTL），避免每次查詢都要多兩趟往返。**這是非官方繞過手法，Yahoo 隨時可能改版讓它失效**——所以 `.TW`／`.TWO` 保留 TWSE／TPEx 官方開放資料當第二層備援（見下方），兩者都失敗才會落到 stooq、最後才是「只有K線」。

## 台股基本面數據來源（Yahoo 失效時的備援）

`.TW`（上市）／`.TWO`（上櫃）在 Yahoo cookie+crumb 失敗時，改用官方免費、免金鑰的政府開放資料 API：

- **.TW**：`openapi.twse.com.tw` 的 `STOCK_DAY_AVG_ALL`（股價）＋ `BWIBBU_ALL`（本益比／殖利率／股價淨值比）。
- **.TWO**：`www.tpex.org.tw/openapi` 的 `tpex_mainboard_daily_close_quotes`（股價）＋ `tpex_mainboard_peratio_analysis`（本益比／殖利率／股價淨值比）。

這兩個備援只給股價＋PE／殖利率／PBR，沒有市值、EPS、Beta、分析師評級、產業別（沒有現成免金鑰端點），正常情況下用不到，因為 Yahoo 那條路線會先給到完整資料。

## BYOK（訪客自帶 API Key）

前端頁面的「🔑 使用自己的 API Key」面板讓訪客可選填自己的 Key，存在瀏覽器 localStorage：

- **Gemini Key**：填了之後，AI 分析會直接從瀏覽器呼叫 `generativelanguage.googleapis.com`，完全略過 `/api/analyze`，金鑰不會經過本站伺服器，也不受 KV 速率限制（費用算在訪客自己的 Google 帳號）。相關 prompt 文字同時存在 `functions/api/analyze.js`（後端預設路徑用）與 `public/app.js` 的 `PROMPT_SECTIONS`（BYOK 直連路徑用），修改分析內容時兩邊都要同步更新。
- **FMP Key**：填了之後會以 `&fmpKey=`／`fmpKey` 欄位帶到 `/api/quote` 與 `/api/analyze`，後端會優先用訪客的 Key 而非站方的 `FMP_KEY`（僅該次請求使用，不會被記錄或儲存在伺服器）。
- 注意：若同時設定了自己的 Gemini Key，AI 分析會走「直連 Google」路徑，此時不會經過 `/api/analyze`，因此下方「基本面數據補強」不會套用；只有走後端路徑（未設定 Gemini Key）時才會補強。

## FMP API 版本注意事項

FMP 已於 2025-08-31 全面關閉 `/api/v3/`、`/api/v4/` 端點（非舊制帳號一律回傳 403 "Legacy Endpoint"），本專案的 `quote.js` 與 `analyze.js` 一律改用 `/stable/` 端點（`?symbol=` query param，而非路徑參數）。若之後要新增其他 FMP 端點，記得確認是走 `/stable/` 而非文件裡到處還看得到的舊版 `/api/v3/` 範例。

## 基本面數據補強（避免 AI 憑空推論財報數字）

Gemini 本身不會即時查財報，`功能面分析／估值` 這兩段如果只丟技術面摘要進去，AI 可能會用自己的訓練知識「腦補」近3年財務趨勢與同業比較的具體數字，不保證正確。`functions/api/analyze.js` 的 `buildGroundingText()` 在有 FMP Key（站方或訪客提供）且為美股代號時，會額外查真實數據餵給 prompt：

- **fundamentals** 段：查 FMP `income-statement`（近3年，年度），把真實營收/淨利/毛利率/營業利益率/淨利率整理成文字，要求 Gemini 優先採用、不得自行編造不同數字。
- **valuation** 段：查 FMP `stock_peers` 找出2-3家同業，再查其本益比/市值，同樣要求 Gemini 直接使用真實數字建表。
- 若無 FMP Key、代號非美股，或 FMP 請求失敗，會改為在 prompt 中加一句指示，要求 Gemini 在報告中明確註明該段落是「一般產業知識推論」，而非查證數字——避免使用者誤把推論當成即時查證的財報。

## 免責聲明

本工具僅供技術與資訊整理參考，不構成投資建議。
