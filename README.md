# Élan Quant

即時技術分析（Yahoo Finance／FMP／TWSE／TPEx）+ Gemini AI 基本面分析網路 App。前端為純靜態頁面，`/api/*` 由 Cloudflare Pages Functions 代管。

- **技術分析**（價格、K線、RSI/MACD/KD/布林通道等）：訪客不需要任何 Key，開箱即用。
- **AI 分析**（基本面／估值／風險／結論）：訪客必須自己填一組免費的 Gemini API Key（見下方「BYOK」），金鑰只存在訪客自己的瀏覽器裡，直接從瀏覽器呼叫 Google，完全不經過本站伺服器，也不會用到站方的任何額度。這個設計是刻意的——Gemini 免費方案的每日額度非常低（例如 `gemini-3.5-flash` 一個 Google 專案一天只有 20 次請求，一次完整分析就要打 4 次），如果由站方代管單一 Key 給所有訪客共用，額度一下就會被打爆，所以不提供「不填 Key 也能用 AI 分析」的預設路徑。

## 專案結構

```
public/            靜態前端（index.html / styles.css / app.js）
functions/api/
  quote.js         GET /api/quote?symbol=&period=          伺服器端抓 Yahoo/FMP/TWSE/TPEx 股價與基本面數據，含 45 秒邊緣快取
  ground.js        GET /api/ground?symbol=&section=         查 FMP 真實財報/同業數據，餵給 Gemini prompt 避免 AI 憑空編數字（不呼叫 Gemini，不需要 Gemini Key）
  chip.js          GET /api/chip?symbol=                    籌碼面：融資融券、大戶持股、三大法人買賣超（即時查 TWSE/TDCC，週變化需要 D1）
  sentiment.js     GET /api/sentiment                        市場情緒指數（貪婪指數），完全依賴 D1 的歷史資料
wrangler.toml      Cloudflare Pages 專案設定
worker-cron/       獨立的 Cloudflare Worker（Pages Functions 不支援排程），每個交易日把當天市場資料寫進 D1
  wrangler.toml    D1 binding + cron trigger
  schema.sql       D1 資料表定義
  src/index.js     每日排程主邏輯
```

## 本機開發

```bash
npm install -g wrangler   # 若尚未安裝
cp .dev.vars.example .dev.vars   # 選填：站方自己的 FMP_KEY，補充美股財報數據
wrangler pages dev public
```

開啟終端機顯示的網址（預設 http://localhost:8788）。技術分析可直接測試；AI 分析要在頁面上「🔑 設定你的 Gemini API Key」面板填入你自己的 Key 才能使用。

## 部署到 Cloudflare Pages

1. 推到 GitHub。
2. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git，選這個 repo。
   - Build command：留空（純靜態，無需 build）
   - Build output directory：`public`
3. 選填：在 Pages 專案 Settings → Environment variables 新增加密 Secret `FMP_KEY`（站方自己的 FMP Key，補充美股財報數據／`/api/ground` 的真實數據來源；訪客也可以自己填 FMP Key 覆蓋，見下方 BYOK）。
4. 觸發部署（push 到 main 分支即會自動 build & 部署）。

不需要設定 `GEMINI_API_KEY`、不需要建立 KV namespace——AI 分析走訪客自己的 Key 直連 Google，站方不需要代管任何 Gemini 額度。

籌碼面（`/api/chip` 的週變化）與市場情緒指數（`/api/sentiment`）需要額外的 D1 資料庫與獨立的排程 Worker，見下方「籌碼面與市場情緒指數」章節。

## Yahoo quoteSummary/v7 的 cookie + crumb

Yahoo 從某個時間點起把 `quoteSummary`／`v7 quote` 這兩支非官方 API 鎖起來，沒帶正確的 session cookie + crumb 一律回 401（跟 yfinance 這類套件近期得處理的問題一樣）。`quote.js` 的 `getYahooCrumb()`：

1. GET `https://fc.yahoo.com` 拿一組 session cookie（回應本身可能是 404，但 `Set-Cookie` header 有效）。
2. 帶著這組 cookie GET `https://query2.finance.yahoo.com/v1/test/getcrumb` 換一個 crumb 字串。
3. 之後所有 quoteSummary/v7 請求都帶上 `Cookie` header 與 `&crumb=`。

crumb+cookie 若有綁定 KV 會快取起來（20 分鐘 TTL，binding 名稱 `RATE_LIMIT_KV`，選填——沒綁定的話每次都會重新換一次 cookie/crumb，只是稍慢，不影響功能）。**這是非官方繞過手法，Yahoo 隨時可能改版讓它失效**——所以 `.TW`／`.TWO` 保留 TWSE／TPEx 官方開放資料當第二層備援（見下方），兩者都失敗才會落到 stooq、最後才是「只有K線」。

如果想啟用 crumb 快取：Pages 專案 Settings → Functions → KV namespace bindings → 建立/綁定一個叫 `RATE_LIMIT_KV` 的 namespace 即可，純屬效能優化，非必要。

## 台股基本面數據來源（Yahoo 失效時的備援）

`.TW`（上市）／`.TWO`（上櫃）在 Yahoo cookie+crumb 失敗時，改用官方免費、免金鑰的政府開放資料 API：

- **.TW**：`openapi.twse.com.tw` 的 `STOCK_DAY_AVG_ALL`（股價）＋ `BWIBBU_ALL`（本益比／殖利率／股價淨值比）。
- **.TWO**：`www.tpex.org.tw/openapi` 的 `tpex_mainboard_daily_close_quotes`（股價）＋ `tpex_mainboard_peratio_analysis`（本益比／殖利率／股價淨值比）。

這兩個備援只給股價＋PE／殖利率／PBR，沒有市值、EPS、Beta、分析師評級、產業別（沒有現成免金鑰端點），正常情況下用不到，因為 Yahoo 那條路線會先給到完整資料。

## FMP API 版本注意事項

FMP 已於 2025-08-31 全面關閉 `/api/v3/`、`/api/v4/` 端點（非舊制帳號一律回傳 403 "Legacy Endpoint"），本專案一律改用 `/stable/` 端點（`?symbol=` query param，而非路徑參數）。若之後要新增其他 FMP 端點，記得確認是走 `/stable/` 而非文件裡到處還看得到的舊版 `/api/v3/` 範例。

## BYOK（訪客自帶 API Key）

前端頁面的「🔑 設定你的 Gemini API Key」面板讓訪客填自己的 Key，存在瀏覽器 localStorage：

- **Gemini Key（必填）**：AI 分析一律直接從瀏覽器呼叫 `generativelanguage.googleapis.com`，金鑰不會經過本站伺服器，費用/額度算在訪客自己的 Google 帳號。相關 prompt 文字只存在 `public/app.js` 的 `PROMPT_SECTIONS`（沒有後端副本，因為 Gemini 呼叫已經沒有後端路徑了）。
- **FMP Key（選填）**：填了之後會以 `&fmpKey=` 帶到 `/api/quote` 與 `/api/ground`，優先於站方的 `FMP_KEY`（僅該次請求使用，不會被記錄或儲存在伺服器）。沒填就用站方的 `FMP_KEY`（如果有設定的話）。

## 基本面數據補強（避免 AI 憑空推論財報數字）

Gemini 本身不會即時查財報，`基本面分析／估值` 這兩段如果只丟技術面摘要進去，AI 可能會用自己的訓練知識「腦補」近3年財務趨勢與同業比較的具體數字，不保證正確。`functions/api/ground.js` 在有 FMP Key（站方或訪客提供）且為美股代號時，會額外查真實數據，前端再把這段文字附加到送給 Gemini 的 prompt 後面：

- **fundamentals** 段：查 FMP `income-statement`（近3年，年度），把真實營收/淨利/毛利率/營業利益率/淨利率整理成文字，要求 Gemini 優先採用、不得自行編造不同數字。
- **valuation** 段：查 FMP `stock-peers` 找出2-3家同業，再查其本益比/市值，同樣要求 Gemini 直接使用真實數字建表。
- 若無 FMP Key、代號非美股，或 FMP 請求失敗，會改為附加一句指示，要求 Gemini 在報告中明確註明該段落是「一般產業知識推論」，而非查證數字——避免使用者誤把推論當成即時查證的財報。

這支端點不呼叫 Gemini、不需要 Gemini Key，純粹回傳一段文字，所以跟訪客要不要 BYOK Gemini 無關，一律都會套用。

## AI 綜合摘要（🧭 分頁）

把技術面、基本面、籌碼面、市場情緒四個面向的數據整理成 JSON（`public/app.js` 的 `buildSummaryData()`），一次呼叫 Gemini（沿用既有 BYOK 直連機制，不新增後端 Gemini 路徑）產出 4 段摘要。Prompt 規則（`buildSummaryPrompt()`）明確要求：只描述現況、不給操作建議、不給目標價、任一面向資料不足就直接說「暫無法判讀」不得用其他面向推測、四面向矛盾時要點出矛盾不能選擇性忽略、結尾固定免責聲明。摘要下方會並排附上完整原始 JSON 數據，方便使用者自己核對 AI 有沒有講錯。

「投資結論」分頁的 prompt 也拿掉了原本「綜合評級（強烈關注/值得追蹤/中性觀望/暫時迴避）」這個分類要求，改成只整理現況、不分類、不給操作建議，跟綜合摘要模組的原則保持一致。

## 籌碼面與市場情緒指數

### 籌碼面（`functions/api/chip.js`，GET /api/chip?symbol=）

即時查詢，不強制依賴 D1（大戶持股「週變化」除外）：

- **融資融券**：`openapi.twse.com.tw/v1/exchangeReport/MI_MARGN`（全市場，篩選股票代號）。
- **大戶持股**：`opendata.tdcc.com.tw/getOD.ashx?id=1-5`（集保股權分散表 CSV）。注意實際欄位共 **17 個持股分級**（不是文件常見的15個），level 15 = 千張大戶（1,000,001股以上），level 12+13+14 加總 = 中實戶；level 16/17 是加總列要排除。這份資料**每週五才更新一次**，CSV 本身只含最新一週快照沒有歷史，所以「週變化」要靠 D1 `holder_weekly_snapshot`（由 `worker-cron` 每週寫入）比對，沒有至少兩週的快照就會顯示「暫無資料」。
- **三大法人買賣超**：官方文件常見的 `openapi.twse.com.tw/v1/fund/T86` 實測是 404（新版 OpenAPI 沒有這支）。實際可用、欄位正確的是舊版端點 `www.twse.com.tw/rwd/zh/fund/T86?response=json&date=YYYYMMDD&selectType=ALL`（支援指定日期查詢），對近5個交易日各自查一次來算近5日累計買賣超與連續買超天數。

任何一段查詢失敗都會回傳完整錯誤訊息（不是空白或 0），前端顯示「暫無資料」＋錯誤原因。

### 市場情緒指數（`functions/api/sentiment.js`，GET /api/sentiment）

自製「貪婪指數」，方法論是**等權重 + 歷史百分位標準化**（不是自訂加權公式），完全依賴 D1 的 `daily_market_data` 表：

- 5 個子指標：大盤動能（加權指數乖離125日均線）、漲跌家數比、創新高低家數比、融資餘額變化率（近5日）、三大法人買超家數比。
- 每個子指標的「今日原始值」跟它自己過去最多 252 個交易日的歷史分布比較：percentile = (歷史序列中 ≤ 今日值 的天數) / 總天數 × 100。
- 少於 60 筆歷史：該子指標標記「資料累積中」，不納入平均。少於 3 項子指標有分數：不顯示總分。
- **冷啟動是必然的，不是 bug**：大盤動能子指標本身需要 125 天的指數資料才能算出第一個值，再疊加 60 天門檻，等於這個子指標要 185 天以上才會顯示分數；其餘子指標理論上 60 個交易日（約3個月）就有第一個分數，252 個交易日（約1年）才算「成熟」。上線初期 UI 會誠實顯示累積進度，不會提早生出以假亂真的分數。
- 個股「創新高/創新低」判定也有類似的個股層級冷啟動保護：`worker-cron` 只有在某檔股票已累積 ≥200 個交易日資料時，才會把它計入當日創新高/創新低統計，避免剛開始追蹤的股票被誤判成「新高」。

### 需要新建的 Cloudflare 資源（D1 + 獨立 Worker）

Cloudflare Pages Functions **不支援排程**，情緒指數與籌碼面週變化需要的每日資料累積，靠一個獨立的 Cloudflare Worker（`worker-cron/`）用 Cron Trigger 執行：

1. Dashboard → Workers & Pages → D1 → **Create database**（名稱例如 `elan-quant-db`）。進 D1 的 Console，把 [worker-cron/schema.sql](worker-cron/schema.sql) 的內容貼上執行，建立三張表。
2. Pages 專案（`elan-quant`）Settings → Functions → **D1 database bindings** → Add binding，Variable name 填 `ELAN_QUANT_DB`，選剛剛建立的資料庫（這樣 `chip.js`／`sentiment.js` 才能讀取）。
3. 新建一個 **Workers** 專案（跟 Pages 是不同種類的專案），Connect to Git 選同一個 repo，root directory 設成 `worker-cron/`（若 Cloudflare 當時的 Git 整合不支援指定子目錄部署 Workers，改成自己在終端機 `cd worker-cron && wrangler deploy`）。
4. 這個 Workers 專案的 Settings 也綁定同一個 D1（Variable name 一樣要叫 `ELAN_QUANT_DB`，跟 `worker-cron/wrangler.toml` 裡的 binding 名稱一致），確認 Cron Trigger（`0 11 * * 1-5`，平日台灣時間19:00）已啟用。
5. 部署後不會立即有資料——要等 Worker 實際執行過幾次交易日才會有歷史資料。可以在 Cloudflare Dashboard 的 Worker 頁面手動觸發一次來提早驗證，或等下一個交易日晚上自動執行。

### 本機測試 worker-cron

```bash
cd worker-cron
npx wrangler dev --test-scheduled
# 另開一個終端機觸發：
curl "http://localhost:8787/__scheduled?cron=0+11+*+*+1-5"
```

本機會用 wrangler 自己模擬的本地 D1，跟 Pages 專案本機開發用的 D1 是分開的（本機測試 `/api/sentiment` 需要另外綁定同一個本地 D1 才看得到資料，或直接在雲端環境測試）。

## Gemini 3.x 的 thinking tokens

`gemini-3.5-flash`／`gemini-3.5-pro` 是會「思考」的模型，`maxOutputTokens` 的額度會被隱藏的推理過程（`thoughtsTokenCount`）吃掉一部分，才輪到真正要顯示的文字。目前設定 `maxOutputTokens: 4096` 搭配 `generationConfig.thinkingConfig.thinkingLevel: 'low'`（壓低思考程度，把額度留給輸出內容）。如果之後又出現回應被截斷（`finishReason: "MAX_TOKENS"`），先檢查是不是這兩個值需要再往上調。

## 免責聲明

本工具僅供技術與資訊整理參考，不構成投資建議。
