const MODELS = new Set(['gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3.5-pro']);
const DEFAULT_MODEL = 'gemini-3.5-flash';
const PER_IP_DAILY_LIMIT = 60;
const GLOBAL_DAILY_LIMIT = 2000;
const NON_US_SUFFIX = /\.(TW|TWO|HK|L|T|SS|SZ|KS|AX|TO|PA|DE|MI|MC|AS|SI|BO|NS)$/i;

const SECTIONS = {
  fundamentals: `【分析重點一：公司基本面】每項附評語與評分（1-5星）：
- 商業模式與價值創造邏輯
- 主要收入來源與業務佔比趨勢
- 客戶結構與集中度風險
- 短中長期成長動力
- 長期競爭優勢護城河（品牌/技術/規模/轉換成本/網路效應）

【分析重點二：財務健康（近3年趨勢）】
- 3-5項財務亮點（綠燈）
- 3-5項財務紅旗（警示）
- 整體財務健康評級：優/良/中/待觀察並說明理由`,

  valuation: `【分析重點三：估值合理性】
- 當前估值倍數（P/E、Forward P/E、P/S、EV/EBITDA）
- 歷史估值區間比較（3-5年）
- 同業2-3家可比公司估值比較（HTML表格）
- 合理價值區間估算
- 估值結論：高估/合理/低估並說明理由`,

  risk: `【分析重點四：風險因素（由高至低排序）】
請輸出HTML表格，欄位：風險類別｜具體描述｜嚴重程度（高/中/低）｜發生可能性（高/中/低）
涵蓋六類：1.宏觀經濟 2.產業競爭 3.監管政策 4.公司治理 5.財務結構 6.估值過高
表格後加一段摘要說明最重要的2-3個風險。`,

  conclusion: `【分析重點五：投資結論整理】
1. 值得留意的優點（3-5項，每項一句）
2. 主要風險（3項，每項一句）
3. 需要進一步查證的資料（2-4項）
4. 適合哪類投資者（成長型/價值型/收息型/不建議散戶，說明理由）
5. 綜合評級（從四選一並說明）：強烈關注 / 值得追蹤 / 中性觀望 / 暫時迴避
最後加免責聲明段落。`,
};

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { 'Content-Type': 'application/json' } });
}

function buildPrompt(symbol, companyName, techSummary, section) {
  const base = `你是一位資深股票研究分析師，擁有15年以上台灣與全球股票市場研究經驗。

技術面數據摘要（供參考）：
${techSummary}

分析對象：${companyName}（${symbol}）
請用繁體中文回答，格式使用 HTML（<h3><ul><li><p><strong><table>標籤），不要包含任何 markdown 或程式碼區塊標記。
所有分析基於公開事實，不確定處請說明，多空平衡，不偏樂觀或悲觀。`;
  return `${base}\n\n${SECTIONS[section]}`;
}

function fmtLargeNum(v) {
  if (v == null) return 'N/A';
  const n = Number(v);
  if (!isFinite(n)) return 'N/A';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  return String(n);
}

// FMP retired /api/v3 and /api/v4 on 2025-08-31 (403 "Legacy Endpoint" for any non-grandfathered key) —
// all fundamentals calls must go through the /stable/ surface, which uses ?symbol= instead of a path param.

// Grounds the "近3年財務趨勢" section in real filed financials instead of the model's own recall.
async function fetchFinancialsSummary(symbol, fmpKey) {
  try {
    const res = await fetch(`https://financialmodelingprep.com/stable/income-statement?symbol=${symbol}&period=annual&limit=3&apikey=${fmpKey}`);
    if (!res.ok) return null;
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr.map(r => {
      const rev = r.revenue, ni = r.netIncome;
      const gm = rev ? (r.grossProfit / rev * 100).toFixed(1) + '%' : 'N/A';
      const om = rev ? (r.operatingIncome / rev * 100).toFixed(1) + '%' : 'N/A';
      const nm = rev ? (ni / rev * 100).toFixed(1) + '%' : 'N/A';
      const year = (r.fiscalYear || r.date || '').toString().slice(0, 4);
      return `${year}：營收 ${fmtLargeNum(rev)}，淨利 ${fmtLargeNum(ni)}，毛利率 ${gm}，營業利益率 ${om}，淨利率 ${nm}`;
    }).join('\n');
  } catch {
    return null;
  }
}

// Grounds the "同業比較" table in real peer quotes instead of the model inventing comparables.
async function fetchPeersSummary(symbol, fmpKey) {
  try {
    const peersRes = await fetch(`https://financialmodelingprep.com/stable/stock-peers?symbol=${symbol}&apikey=${fmpKey}`);
    if (!peersRes.ok) return null;
    const peers = await peersRes.json();
    if (!Array.isArray(peers) || peers.length === 0) return null;
    const topPeers = peers.slice(0, 3);
    const withPe = await Promise.all(topPeers.map(async peer => {
      try {
        const r = await fetch(`https://financialmodelingprep.com/stable/ratios-ttm?symbol=${peer.symbol}&apikey=${fmpKey}`);
        const j = r.ok ? await r.json() : [];
        return { ...peer, pe: (Array.isArray(j) && j[0]) ? j[0].priceToEarningsRatioTTM : null };
      } catch {
        return { ...peer, pe: null };
      }
    }));
    return withPe.map(p => `${p.symbol}（${p.companyName || ''}）：股價 ${p.price ?? 'N/A'}，本益比 ${p.pe != null ? p.pe.toFixed(1) : 'N/A'}，市值 ${fmtLargeNum(p.mktCap)}`).join('\n');
  } catch {
    return null;
  }
}

async function buildGroundingText(symbol, section, fmpKey) {
  const isNonUS = NON_US_SUFFIX.test(symbol);
  if (section === 'fundamentals') {
    const fin = (fmpKey && !isNonUS) ? await fetchFinancialsSummary(symbol, fmpKey) : null;
    return fin
      ? `\n\n【近3年財報數據（來源：FMP，真實數據，請優先採用，不要自行編造不同數字）】\n${fin}`
      : `\n\n（註：目前無法取得近3年真實財報數據，請在財務健康段落明確註明此處為一般產業知識推論，並提醒使用者自行查證財報。）`;
  }
  if (section === 'valuation') {
    const peers = (fmpKey && !isNonUS) ? await fetchPeersSummary(symbol, fmpKey) : null;
    return peers
      ? `\n\n【同業比較數據（來源：FMP，真實數據，請優先採用，不要自行編造不同公司或數字）】\n${peers}`
      : `\n\n（註：目前無法取得真實同業比較數據，請在估值比較表格明確註明這是一般產業知識推論的參考數字，並提醒使用者自行查證。）`;
  }
  return '';
}

function secondsUntilNextUtcMidnight() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.max(60, Math.floor((next.getTime() - now.getTime()) / 1000));
}

// KV increments are best-effort (not atomic) — acceptable for cost-control rate limiting,
// not intended as a hard security boundary.
async function checkRateLimit(kv, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  const ipKey = `ip:${ip}:${day}`;
  const globalKey = `global:${day}`;

  const [ipCountRaw, globalCountRaw] = await Promise.all([kv.get(ipKey), kv.get(globalKey)]);
  const ipCount = parseInt(ipCountRaw || '0', 10);
  const globalCount = parseInt(globalCountRaw || '0', 10);

  if (globalCount >= GLOBAL_DAILY_LIMIT) return '今日全站 AI 分析額度已滿，請明天再試。';
  if (ipCount >= PER_IP_DAILY_LIMIT) return '今日你的 AI 分析次數已達上限，請明天再試。';

  const ttl = secondsUntilNextUtcMidnight();
  await Promise.all([
    kv.put(ipKey, String(ipCount + 1), { expirationTtl: ttl }),
    kv.put(globalKey, String(globalCount + 1), { expirationTtl: ttl }),
  ]);
  return null;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch { return jsonError('請求格式錯誤', 400); }

  const { symbol, companyName, techSummary, section } = body || {};
  const model = MODELS.has(body?.model) ? body.model : DEFAULT_MODEL;
  const fmpKey = (body?.fmpKey || '').trim() || env.FMP_KEY;

  if (!symbol || !techSummary || !SECTIONS[section]) {
    return jsonError('請求缺少必要欄位', 400);
  }
  if (!env.GEMINI_API_KEY) {
    return jsonError('伺服器尚未設定 AI 服務金鑰', 500);
  }

  if (env.RATE_LIMIT_KV) {
    const limitMsg = await checkRateLimit(env.RATE_LIMIT_KV, request);
    if (limitMsg) return jsonError(`RATE_LIMIT: ${limitMsg}`, 429);
  }

  const groundingText = await buildGroundingText(symbol, section, fmpKey);
  const prompt = buildPrompt(symbol, companyName || symbol, techSummary, section) + groundingText;

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 1500 },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
      }),
    }
  );

  if (!upstream.ok) {
    const errText = await upstream.text();
    return new Response(errText, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}
