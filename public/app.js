let currentPeriod='3mo', currentInterval='1d', currentSymbol='', selectedModel='gemini-3.1-flash-lite';
let apiKey='', fmpKey='';
let priceChart=null, rsiChart=null, macdChart=null;
// Bumped on every analyze() call. Quick-load tags and the Enter-key handler both call analyze()
// directly (bypassing analyzeBtn's disabled state), so overlapping calls are easy to trigger by
// rapid-clicking between symbols. Each call captures its own generation and checks it before every
// DOM write, so a superseded call's late-arriving response gets silently dropped instead of
// overwriting the current symbol's UI with stale data.
let analyzeGeneration=0;
// model id -> user-facing message, once its daily free-tier quota is confirmed exhausted this
// session. A single analyze() call fires ~5 separate Gemini requests (4 analysis sections + the
// summary); without this, every one of them independently retries twice (15s+30s) before showing
// the same "quota exhausted" message, so a single exhausted-quota analysis takes minutes to fully
// fail. Once one section confirms exhaustion, later sections for the same model skip straight to
// the message.
let quotaExhaustedModels=new Map();

function saveApiKey(){
  const val=document.getElementById('apiKeyInput').value.trim();
  if(!val){ apiKey=''; persistSet('elan_gemini_key',''); }
  else if(!val.startsWith('AIza')){ alert('請輸入有效的 Gemini API Key（以 AIza 開頭）'); return; }
  else{ apiKey=val; persistSet('elan_gemini_key',apiKey); }
  document.getElementById('keyStatus').textContent=apiKey?'✓ 已設定':'未設定';
  document.getElementById('keyStatus').className='key-status '+(apiKey?'key-set':'key-unset');
  document.getElementById('apiKeyInput').value='';
}
function saveFmpKey(){
  const val=document.getElementById('fmpKeyInput').value.trim();
  fmpKey=val;
  persistSet('elan_fmp_key',fmpKey);
  document.getElementById('fmpStatus').textContent=fmpKey?'✓ 已設定':'未設定';
  document.getElementById('fmpStatus').className='key-status '+(fmpKey?'key-set':'key-unset');
  document.getElementById('fmpKeyInput').value='';
}

function switchTab(id,el){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('pane-'+id).classList.add('active');
}
function setPeriod(p,btn){
  currentPeriod=p;
  persistSet('elan_last_period', p);
  document.querySelectorAll('.period-row .btn-ghost').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  if(currentSymbol) analyze();
}
function setCandleInterval(iv,btn){
  currentInterval=iv;
  persistSet('elan_last_interval', iv);
  document.querySelectorAll('.interval-row .btn-ghost').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  if(currentSymbol) analyze();
}
function quickLoad(sym){document.getElementById('symbolInput').value=sym;analyze();}

async function analyze(){
  const sym=document.getElementById('symbolInput').value.trim().toUpperCase();
  if(!sym)return;
  const myGen=++analyzeGeneration;
  currentSymbol=sym;
  persistSet('elan_last_symbol', sym);
  selectedModel=document.getElementById('modelSelect').value;
  document.getElementById('welcomeBox').classList.add('hidden');
  document.getElementById('tabBar').classList.add('hidden');
  document.getElementById('loadingBox').classList.remove('hidden');
  document.getElementById('errorBox').classList.add('hidden');
  document.querySelectorAll('.tab-pane').forEach(p=>{p.classList.remove('active');p.classList.add('hidden');});
  document.getElementById('analyzeBtn').disabled=true;

  const needsKey='<div class="info-box">⚠️ 尚未設定 Gemini API Key，無法產生 AI 分析。請點上方「🔑 使用自己的 API Key」設定你自己的 Gemini Key（<a href="https://aistudio.google.com/app/apikey" target="_blank">免費申請</a>）。</div>';
  const waiting='<div class="fund-loading"><div class="spinner"></div><span>Gemini AI 正在生成分析報告⋯</span></div>';
  ['fundContent','riskContent','conclusionContent','techAIBox'].forEach(id=>{
    document.getElementById(id).innerHTML=apiKey?waiting:needsKey;
  });
  document.getElementById('summaryContent').innerHTML=apiKey?waiting:needsKey;
  const chipWaiting='<div class="fund-loading"><div class="spinner"></div><span>正在抓取籌碼面資料⋯</span></div>';
  document.getElementById('chipContent').innerHTML=chipWaiting;
  document.getElementById('sentimentContent').innerHTML=chipWaiting;

  try{
    document.getElementById('loadingText').textContent='正在抓取股價數據⋯';
    const {data,info}=await fetchQuote(sym,currentPeriod,currentInterval);
    if(myGen!==analyzeGeneration) return; // superseded by a newer analyze() call while this was in flight
    const minBars=currentInterval==='1wk'?10:20;
    if(!data||data.length<minBars) throw new Error('數據不足（台股請加 .TW，例如 2330.TW；若已選週線，可嘗試拉長時間區間或改回日線）');

    document.getElementById('loadingText').textContent='正在計算技術指標⋯';
    // 使用者可以直接輸入不帶.TW/.TWO的台股代號（例如"2330"），/api/quote會在伺服器端自動
    // 補上正確後綴並透過info.symbol回傳——這裡要儘早算出resolvedSym並在後面統一使用，
    // 不然像/api/ground這種靠副檔名判斷是不是台股的呼叫會收到沒有後綴的原始輸入而誤判。
    const resolvedSym=info.symbol||sym;
    const techAIInput=renderTech(resolvedSym,data,info);

    document.getElementById('loadingBox').classList.add('hidden');
    document.getElementById('tabBar').classList.remove('hidden');
    ['tech','fund','chip','sentiment','risk','conclusion','summary'].forEach(id=>{
      const el=document.getElementById('pane-'+id);
      el.classList.remove('hidden');
      if(id==='tech') el.classList.add('active');
    });
    document.querySelectorAll('.tab').forEach((t,i)=>i===0?t.classList.add('active'):t.classList.remove('active'));

    const techSummary=buildTechSummary(resolvedSym,data,info);
    const companyName=info.longName||info.shortName||resolvedSym;
    if(apiKey) runGeminiAnalysis(resolvedSym,companyName,techSummary,myGen);
    if(apiKey) runTechAIStrategy(resolvedSym,companyName,techAIInput,myGen);

    let chipData=null,sentimentData=null;
    // Chip and sentiment are independent data sources — fetch them concurrently instead of
    // sequentially so the wait before rendering (and before the AI summary can start) is roughly
    // halved, especially since chip.js does non-trivial work server-side (TDCC CSV parse + T86 calls).
    const isTW=isTaiwanSymbol(resolvedSym);
    const lc=typeof info.regularMarketPrice==='number'?info.regularMarketPrice:data[data.length-1].close;
    await Promise.all([
      (isTW 
        ? Promise.all([fetchChip(resolvedSym), fetchActiveEtfFlow(resolvedSym).catch(() => null)])
            .then(([d, etf]) => {
              if(myGen!==analyzeGeneration) return;
              chipData=d;
              renderChip(d, etf, lc);
            })
        : fetchChipUS(resolvedSym).then(d => {
              if(myGen!==analyzeGeneration) return;
              chipData=d;
              renderChipUS(d);
            })
      ).catch(e=>{
        if(myGen!==analyzeGeneration) return;
        document.getElementById('chipContent').innerHTML=`<div class="error-box">⚠ 籌碼面資料取得失敗：${escapeHtml(e.message)}</div>`;
      }),
      fetchSentiment().then(d=>{ if(myGen!==analyzeGeneration) return; sentimentData=d; renderSentiment(d); }).catch(e=>{
        if(myGen!==analyzeGeneration) return;
        document.getElementById('sentimentContent').innerHTML=`<div class="error-box">⚠ 市場情緒指數取得失敗：${escapeHtml(e.message)}</div>`;
      }),
    ]);
    if(myGen!==analyzeGeneration) return;

    runSummaryAnalysis(resolvedSym,companyName,techSummary,chipData,sentimentData,info,myGen,data);
  }catch(e){
    if(myGen!==analyzeGeneration) return; // a newer call is already in charge of the UI
    document.getElementById('errorBox').innerHTML='⚠ <strong>'+escapeHtml(e.message).replace(/\n/g,'<br>')+'</strong>';
    document.getElementById('errorBox').classList.remove('hidden');
    document.getElementById('loadingBox').classList.add('hidden');
  }finally{
    document.getElementById('analyzeBtn').disabled=false;
  }
}

async function fetchQuote(symbol,period,interval){
  let url=`/api/quote?symbol=${encodeURIComponent(symbol)}&period=${encodeURIComponent(period)}&interval=${encodeURIComponent(interval||'1d')}`;
  if(fmpKey) url+=`&fmpKey=${encodeURIComponent(fmpKey)}`;
  const res=await fetch(url);
  const body=await res.json().catch(()=>({}));
  if(!res.ok){
    throw new Error(body?.error||`無法取得 ${symbol} 的股價數據，請稍後再試。`);
  }
  const data=(body.candles||[]).map(c=>({...c,date:new Date(c.date)}));
  return {data, info:body.meta||{}};
}

function sma(a,n){return a.map((_,i)=>i<n-1?null:a.slice(i-n+1,i+1).reduce((s,v)=>s+v,0)/n);}
function ema(a,n){
  const k=2/(n+1);let r=[],p=null;
  a.forEach((v,i)=>{
    if(v==null){r.push(null);return;}
    if(p==null){if(i>=n-1){p=a.slice(Math.max(0,i-n+1),i+1).filter(x=>x!=null).reduce((s,v)=>s+v,0)/n;r.push(p);}else r.push(null);}
    else{p=v*k+p*(1-k);r.push(p);}
  });
  return r;
}
function calcRSI(c,n=14){
  let g=[],l=[];
  for(let i=1;i<c.length;i++){const d=c[i]-c[i-1];g.push(d>0?d:0);l.push(d<0?-d:0);}
  const rsi=[];let ag=null,al=null;
  for(let i=0;i<g.length;i++){
    if(i<n-1){rsi.push(null);continue;}
    if(ag==null){ag=g.slice(0,n).reduce((s,v)=>s+v)/n;al=l.slice(0,n).reduce((s,v)=>s+v)/n;}
    else{ag=(ag*(n-1)+g[i])/n;al=(al*(n-1)+l[i])/n;}
    rsi.push(al===0?100:100-100/(1+ag/al));
  }
  return [null,...rsi];
}
function calcMACD(c){
  const e12=ema(c,12),e26=ema(c,26);
  const ml=c.map((_,i)=>(e12[i]!=null&&e26[i]!=null)?e12[i]-e26[i]:null);
  const sa=ml.filter(v=>v!=null),sf=ema(sa,9);
  let si=0;const s=ml.map(v=>v===null?null:(sf[si++]??null));
  return{macdLine:ml,signal:s,hist:ml.map((v,i)=>(v!=null&&s[i]!=null)?v-s[i]:null)};
}
function calcBB(c,n=20,k=2){
  const m=sma(c,n);
  return c.map((_,i)=>{
    if(m[i]==null)return{upper:null,mid:null,lower:null};
    const sl=c.slice(i-n+1,i+1),std=Math.sqrt(sl.reduce((s,v)=>s+(v-m[i])**2,0)/n);
    return{upper:m[i]+k*std,mid:m[i],lower:m[i]-k*std};
  });
}
function calcKD(data,n=9){
  const K=[],D=[];let pk=50,pd=50;
  data.forEach((_,i)=>{
    if(i<n-1){K.push(null);D.push(null);return;}
    const sl=data.slice(i-n+1,i+1);
    const hi=Math.max(...sl.map(d=>d.high||0)),lo=Math.min(...sl.map(d=>d.low||1e9));
    const rsv=hi===lo?50:(data[i].close-lo)/(hi-lo)*100;
    const k=(2/3)*pk+(1/3)*rsv,d=(2/3)*pd+(1/3)*k;
    K.push(k);D.push(d);pk=k;pd=d;
  });
  return{K,D};
}
function last(a){return a.filter(v=>v!=null).slice(-1)[0];}
function fmt(v,d=2){return v!=null?Number(v).toFixed(d):'N/A';}
function sigBadge(s){
  // 台股慣例：買入(好事)=紅，賣出(壞事)=綠；超買是偏空/風險訊號=綠，超賣是偏多/買點訊號=紅——
  // 跟 signal-val 用的 .OVERBOUGHT/.OVERSOLD CSS、以及 KD/BB 訊號的 up/down class 對齊一致。
  const m={BUY:['badge-red','買入'],SELL:['badge-green','賣出'],OVERBOUGHT:['badge-green','超買'],OVERSOLD:['badge-red','超賣'],NEUTRAL:['badge-amber','中性']};
  const[cls,txt]=m[s]||['badge-amber','中性'];
  return`<span class="badge ${cls}">${txt}</span>`;
}

function calcTechSignals(data, info) {
  const c = data.map(d => d.close);
  const rsi = calcRSI(c);
  const { macdLine, signal, hist } = calcMACD(c);
  const bb = calcBB(c);
  const { K, D } = calcKD(data);
  const ma5 = sma(c, 5), ma20 = sma(c, 20);
  
  const lc = c[c.length - 1];
  const lRSI = last(rsi), lK = last(K), lD = last(D), lBB = bb.filter(v => v.upper != null).slice(-1)[0];
  const lMA5 = last(ma5), lMA20 = last(ma20);
  const lMACD = last(macdLine), lSig = last(signal);
  
  const sig = {};
  sig.ma = lMA5 > lMA20 ? 'BUY' : 'SELL';
  sig.rsi = lRSI > 70 ? 'OVERBOUGHT' : lRSI < 30 ? 'OVERSOLD' : 'NEUTRAL';
  sig.macd = lMACD > lSig ? 'BUY' : 'SELL';
  sig.kd = lK > 80 ? 'OVERBOUGHT' : lK < 20 ? 'OVERSOLD' : (lK > lD ? 'BUY' : 'SELL');
  sig.bb = lc > lBB?.upper ? 'OVERBOUGHT' : lc < lBB?.lower ? 'OVERSOLD' : 'NEUTRAL';
  
  const buys = [sig.ma, sig.macd, sig.kd].filter(s => s === 'BUY').length;
  const sells = [sig.ma, sig.macd, sig.kd].filter(s => s === 'SELL').length;
  const ob = [sig.rsi, sig.kd, sig.bb].filter(s => s === 'OVERBOUGHT').length;
  const os = [sig.rsi, sig.kd, sig.bb].filter(s => s === 'OVERSOLD').length;
  
  let oSig = '中性觀望', oClass = 'NEUTRAL', oSub = '技術指標分歧，建議持續觀察';
  if (ob >= 2) { oSig = '偏高警示'; oClass = 'SELL'; oSub = '多項指標超買，留意回檔風險'; }
  else if (os >= 2) { oSig = '超賣機會'; oClass = 'BUY'; oSub = '多項指標超賣，注意反彈訊號'; }
  else if (buys >= 2) { oSig = '偏多訊號'; oClass = 'BUY'; oSub = '趨勢與動能指標偏向買方'; }
  else if (sells >= 2) { oSig = '偏空訊號'; oClass = 'SELL'; oSub = '趨勢與動能指標偏向賣方'; }
  
  return { 
    sig, oSig, oClass, oSub, 
    lRSI, lK, lD, lMACD, lSig, lHist: last(hist), lMA5, lMA20, lBB, 
    buys, sells, ob, os,
    rsi, macdLine, sig2: signal, hist, bb, ma5, ma20
  };
}

// 判斷「最新一根K棒」是不是今天，藉此決定昨收要用哪一根——不能單靠比較 regularMarketPrice
// 是否等於K棒收盤價來猜（這只在兩者剛好來自同一份 Yahoo 快照時才準，換成 TWSE 即時報價後兩者
// 幾乎不會剛好相等，比較日期才是穩定的做法）。台股有 quoteDate（TWSE 即時 API 回的官方日期）
// 時直接比對；沒有的話（美股，或 TWSE 即時抓不到時）退回舊的數值比對法。
function deriveLastAndPrevClose(data,info){
  const c=data.map(d=>d.close);
  const lc=typeof info.regularMarketPrice==='number'?info.regularMarketPrice:c[c.length-1];
  let pc;
  const lastDate=data[data.length-1]?.date;
  if(info.quoteDate&&lastDate){
    const taipei=new Date(lastDate.getTime()+8*3600*1000);
    const lastDateStr=`${taipei.getUTCFullYear()}${String(taipei.getUTCMonth()+1).padStart(2,'0')}${String(taipei.getUTCDate()).padStart(2,'0')}`;
    pc=(lastDateStr===info.quoteDate)?(c[c.length-2]??c[c.length-1]):c[c.length-1];
  }else if(typeof info.regularMarketPrice==='number'&&c.length>0){
    pc=(Math.abs(c[c.length-1]-info.regularMarketPrice)<0.001)?(c[c.length-2]??c[c.length-1]):c[c.length-1];
  }else{
    pc=c[c.length-2]??c[c.length-1];
  }
  return {lc,pc};
}

function buildTechSummary(sym,data,info){
  const c=data.map(d=>d.close);
  const {lc,pc}=deriveLastAndPrevClose(data,info);
  const allHighs=data.map(d=>d.high).filter(Boolean);
  const allLows=data.map(d=>d.low).filter(Boolean);
  const h52=typeof info.fiftyTwoWeekHigh==='number'?info.fiftyTwoWeekHigh.toFixed(2):(allHighs.length?Math.max(...allHighs).toFixed(2):'N/A');
  const l52=typeof info.fiftyTwoWeekLow==='number'?info.fiftyTwoWeekLow.toFixed(2):(allLows.length?Math.min(...allLows).toFixed(2):'N/A');
  const fmtPct=v=>typeof v==='number'?(v*100).toFixed(1)+'%':'N/A';
  
  const signals=calcTechSignals(data,info);
  
  const mCapVal=typeof info.marketCap==='number'?Number(info.marketCap).toLocaleString():'N/A';
  const peVal=typeof info.trailingPE==='number'?info.trailingPE.toFixed(1):'N/A';
  const fpeVal=typeof info.forwardPE==='number'?info.forwardPE.toFixed(1):'N/A';
  const epsVal=(info.trailingEps!=null&&typeof info.trailingEps!=='object')?info.trailingEps:'N/A';
  const yieldVal=typeof info.dividendYield==='number'?(info.dividendYield*100).toFixed(2)+'%':'N/A';

  return `股票：${sym}（${info.longName||sym}）
收盤價：${lc.toFixed(2)} ${info.currency||''}，日漲跌：${((lc-pc)/pc*100).toFixed(2)}%
整體技術訊號：${signals.oSig}（${signals.oSub}）
52週高/低：${h52} / ${l52}
市值：${mCapVal}
本益比(TTM)：${peVal}，預估本益比：${fpeVal}
EPS：${epsVal}，殖利率：${yieldVal}
毛利率：${fmtPct(info.grossMargins)}，營業利益率：${fmtPct(info.operatingMargins)}
RSI(14)=${fmt(signals.lRSI,1)}，K=${fmt(signals.lK,1)} D=${fmt(signals.lD,1)}
MACD=${fmt(signals.lMACD,4)}，Signal=${fmt(signals.lSig,4)}，Hist=${fmt(signals.lHist,4)}
MA5=${fmt(signals.lMA5)} MA20=${fmt(signals.lMA20)}
布林上軌=${fmt(signals.lBB?.upper)} 下軌=${fmt(signals.lBB?.lower)}
產業：${info.sector||'N/A'} / ${info.industry||'N/A'}
分析師評級：${info.analystRating||'N/A'}
${info.description?'公司簡介：'+info.description.slice(0,300)+'...':''}`;
}

function srTag(lc,val,isResist){
  if(val==null) return '';
  const pct=((lc-val)/val*100);
  const near=Math.abs(pct)<2;
  const crossed=isResist?(lc>=val):(lc<=val);
  if(crossed) return isResist?' <span style="color:var(--green);font-size:10px">▲突破</span>':' <span style="color:var(--red);font-size:10px">▼跌破</span>';
  if(near) return ' <span style="color:var(--amber);font-size:10px">⚡接近</span>';
  return ' <span style="color:var(--text3);font-size:10px">('+Math.abs(pct).toFixed(1)+'%'+(isResist?' 上方':' 下方')+')</span>';
}
function srRow(label,val,lc,isResist){
  if(val==null) return '';
  return `<div class="sr-item"><span class="sr-label">${label}</span><span class="sr-val ${isResist?(lc>=val?'up':''):(lc<=val?'down':'')}">${fmt(val)}${srTag(lc,val,isResist)}</span></div>`;
}
function buildSRBox(lc,lBB,r1,r2,s1,s2,pivot,pivR1,pivR2,pivS1,pivS2,h52,l52,chg){
  const resistLevels=[
    {l:'布林上軌',v:lBB?.upper},
    {l:'20日高點 R1',v:r1},
    {l:'樞紐 R1',v:pivR1},
    {l:'樞紐 R2',v:pivR2},
    {l:'60日高點 R2',v:r2},
    {l:'52週高',v:typeof h52==='number'?h52:null},
  ].filter(x=>x.v!=null).sort((a,b)=>a.v-b.v);
  const supportLevels=[
    {l:'布林下軌',v:lBB?.lower},
    {l:'20日低點 S1',v:s1},
    {l:'樞紐 S1',v:pivS1},
    {l:'樞紐 S2',v:pivS2},
    {l:'60日低點 S2',v:s2},
    {l:'52週低',v:typeof l52==='number'?l52:null},
  ].filter(x=>x.v!=null).sort((a,b)=>b.v-a.v);
  return `<div class="sr-box">
  <div class="sr-title">🎯 壓力 / 支撐位分析</div>
  <div class="sr-grid">
    <div class="sr-zone resist">
      <div class="sr-zone-title">↑ 壓力區（由近至遠）</div>
      ${resistLevels.map(x=>srRow(x.l,x.v,lc,true)).join('')}
    </div>
    <div class="sr-current">
      <div class="sr-current-label">現價</div>
      <div class="sr-current-val ${chg>=0?'up':'down'}">${fmt(lc)}</div>
      <div class="sr-current-sub">樞紐 ${fmt(pivot)}</div>
    </div>
    <div class="sr-zone support">
      <div class="sr-zone-title">↓ 支撐區（由近至遠）</div>
      ${supportLevels.map(x=>srRow(x.l,x.v,lc,false)).join('')}
    </div>
  </div>
</div>`;
}

// 均線扣抵方向：跟3個交易日前比較，判斷是「上彎」還是「下彎」——現價站上均線不代表均線本身向上，
// 這是 AI 深度技術判讀 prompt 的「均線與扣抵陷阱」規則需要的輸入。
function maSlopeLabel(arr,lookback=3){
  if(!arr||arr.length<lookback+1) return '資料不足';
  const cur=arr[arr.length-1],prev=arr[arr.length-1-lookback];
  if(cur==null||prev==null) return '資料不足';
  const pct=prev!==0?(cur-prev)/prev*100:0;
  if(Math.abs(pct)<0.05) return '走平';
  return cur>prev?'上彎':'下彎';
}
// 布林通道開口方向：跟5個交易日前的通道寬度比較，判斷「發散」還是「收斂」——
// AI prompt 判斷「飆股貼上軌」vs「多頭力竭」需要知道通道是張開還是收窄。
function bbTrendLabel(bbArr,lookback=5){
  if(!bbArr||bbArr.length<lookback+1) return '資料不足';
  const cur=bbArr[bbArr.length-1],prev=bbArr[bbArr.length-1-lookback];
  if(!cur||!prev||!cur.mid||!prev.mid) return '資料不足';
  const curWidth=(cur.upper-cur.lower)/cur.mid,prevWidth=(prev.upper-prev.lower)/prev.mid;
  if(!prevWidth) return '資料不足';
  const diffPct=(curWidth-prevWidth)/prevWidth*100;
  if(Math.abs(diffPct)<3) return '持平';
  return curWidth>prevWidth?'向上開口發散':'收斂盤整';
}

function renderTech(symbol,data,info){
  const c=data.map(d=>d.close);
  const ma10=sma(c,10),ma60=sma(c,60);
  const lMA10=last(ma10),lMA60=last(ma60);
  const {lc,pc}=deriveLastAndPrevClose(data,info);
  const chg=lc-pc;
  const chgPct=pc?chg/pc*100:0;
  
  const labels=data.map(d=>d.date.toLocaleDateString('zh-TW',{month:'short',day:'numeric'}));
  const signals=calcTechSignals(data,info);
  const {
    sig,oSig,oClass,oSub,lRSI,lK,lD,lMACD,lSig,lHist,lMA5,lMA20,lBB,
    buys,sells,ob,os,
    rsi,macdLine,sig2,hist,bb,ma5,ma20
  }=signals;
  const cn=info.longName||info.shortName||symbol,cur=info.currency||'';
  const fmtVol=v=>v&&v>0?(v>=1e9?(v/1e9).toFixed(1)+'B':v>=1e6?(v/1e6).toFixed(1)+'M':Number(v).toLocaleString()):'N/A';
  const fmtCap=v=>v&&v>0?(v>=1e12?(v/1e12).toFixed(2)+'T':v>=1e9?(v/1e9).toFixed(1)+'B':(v/1e6).toFixed(0)+'M'):'N/A';
  const todayBar=data[data.length-1]||{};
  const prevBar=data[data.length-2]||{};
  const dayHigh=info.regularMarketDayHigh||todayBar.high||null;
  const dayLow=info.regularMarketDayLow||todayBar.low||null;
  const dayOpen=info.regularMarketOpen||todayBar.open||null;
  const dayVol=info.regularMarketVolume||todayBar.volume||null;
  const prevClose=pc;
  const avgVol=info.averageVolume||info.averageDailyVolume10Day||null;
  const allHighs=data.map(d=>d.high).filter(Boolean);
  const allLows=data.map(d=>d.low).filter(Boolean);
  const h52=info.fiftyTwoWeekHigh||(allHighs.length?Math.max(...allHighs):null);
  const l52=info.fiftyTwoWeekLow||(allLows.length?Math.min(...allLows):null);
  const pe=typeof info.trailingPE==='number'?info.trailingPE.toFixed(1):'N/A';
  const mktCap=fmtCap(info.marketCap);
  const vol=fmtVol(dayVol);
  const ratingVal=info.analystRating||info.recommendationKey||'N/A';
  const ratingNote=info.analystRating?'來源：FMP 綜合評分（非真人分析師意見）'
    :info.recommendationKey?`來源：Yahoo 分析師共識${info.numberOfAnalystOpinions?'（'+info.numberOfAnalystOpinions+'位分析師)':''}`
    :'';
  const n20highs=data.slice(-20).map(d=>d.high).filter(Boolean);
  const n20lows=data.slice(-20).map(d=>d.low).filter(Boolean);
  const n60highs=data.slice(-60).map(d=>d.high).filter(Boolean);
  const n60lows=data.slice(-60).map(d=>d.low).filter(Boolean);
  const r1=n20highs.length?Math.max(...n20highs):null;
  const r2=n60highs.length?Math.max(...n60highs):null;
  const s1=n20lows.length?Math.min(...n20lows):null;
  const s2=n60lows.length?Math.min(...n60lows):null;
  const pH=prevBar.high||dayHigh||lc, pL=prevBar.low||dayLow||lc, pC=prevBar.close||lc;
  const pivot=(pH+pL+pC)/3;
  const pivR1=2*pivot-pL, pivR2=pivot+(pH-pL);
  const pivS1=2*pivot-pH, pivS2=pivot-(pH-pL);

  document.getElementById('priceHeroBox').innerHTML=`
<div class="price-hero">
  <div class="price-main">
    <div class="stock-name">${cn} (${symbol}) ${cur}${info.sector?' · '+info.sector:''}</div>
    <div class="price-num ${chg>=0?'up':'down'}">${fmt(lc)}</div>
    <div class="price-change ${chg>=0?'up':'down'}">${chg>=0?'+':''}${fmt(chg)} (${chg>=0?'+':''}${fmt(chgPct)}%)</div>
    <div style="font-size:11px;color:var(--text3);margin-top:6px;display:flex;gap:10px;flex-wrap:wrap">
      <span>昨收 <b style="color:var(--text2)">${fmt(info.regularMarketPreviousClose||prevClose||pc)}</b></span>
      <span>今開 <b style="color:var(--text2)">${dayOpen?fmt(dayOpen):'—'}</b></span>
      <span>日高 <b class="up">${dayHigh?fmt(dayHigh):'—'}</b></span>
      <span>日低 <b class="down">${dayLow?fmt(dayLow):'—'}</b></span>
      ${info.quoteTime?`<span>報價時間 <b style="color:var(--text2)">${info.quoteTime}</b>（${escapeHtml(info.quoteSource||'')}，非延遲報價）</span>`:''}
      <span style="margin-left:auto;opacity:.5">數據來源：${info._source==='FMP'?'FMP ✓':info._source==='Yahoo'?'Yahoo ✓':info._source==='Stooq'?'Stooq ✓':info._source==='TWSE'?'TWSE ✓':info._source==='TPEx'?'TPEx ✓':'即時K線（基本面待補）'}</span>
    </div>
  </div>
  <div class="kpi-grid" id="kpiGrid">
    <div class="kpi"><div class="kpi-label">成交量</div><div class="kpi-val">${vol}</div></div>
    <div class="kpi"><div class="kpi-label">均量 (10日)</div><div class="kpi-val">${fmtVol(avgVol)}</div></div>
    <div class="kpi"><div class="kpi-label">市值</div><div class="kpi-val">${mktCap}</div></div>
    <div class="kpi"><div class="kpi-label">本益比 (TTM)</div><div class="kpi-val">${pe}</div></div>
    <div class="kpi"><div class="kpi-label">預估本益比</div><div class="kpi-val">${typeof info.forwardPE==='number'?info.forwardPE.toFixed(1):'N/A'}</div></div>
    <div class="kpi"><div class="kpi-label">EPS (TTM)</div><div class="kpi-val">${(info.trailingEps!=null&&typeof info.trailingEps!=='object')?fmt(info.trailingEps):'N/A'}</div></div>
    <div class="kpi"><div class="kpi-label">股價淨值比</div><div class="kpi-val">${typeof info.priceToBook==='number'?info.priceToBook.toFixed(2):'N/A'}</div></div>
    <div class="kpi"><div class="kpi-label">殖利率</div><div class="kpi-val ${typeof info.dividendYield==='number'?'up':''}">${typeof info.dividendYield==='number'?(info.dividendYield*100).toFixed(2)+'%':'N/A'}</div></div>
    <div class="kpi"><div class="kpi-label">Beta</div><div class="kpi-val">${typeof info.beta==='number'?info.beta.toFixed(2):'N/A'}</div></div>
    <div class="kpi"><div class="kpi-label">分析師評級</div><div class="kpi-val ${info.analystRating?'up':''}">${ratingVal}</div>${ratingNote?`<div class="kpi-sub">${ratingNote}</div>`:''}</div>
    <div class="kpi"><div class="kpi-label">52週高</div><div class="kpi-val down">${typeof h52==='number'?fmt(h52):h52}</div></div>
    <div class="kpi"><div class="kpi-label">52週低</div><div class="kpi-val up">${typeof l52==='number'?fmt(l52):l52}</div></div>
  </div>
</div>`;

  document.getElementById('signalBarBox').innerHTML=`
<div class="signal-bar">
  <div class="signal-card"><div class="signal-label">均線排列</div><div class="signal-val ${sig.ma}">${sig.ma==='BUY'?'多頭':'空頭'}</div><div class="signal-sub">MA5 ${sig.ma==='BUY'?'>':'<'} MA20</div></div>
  <div class="signal-card"><div class="signal-label">RSI (14)</div><div class="signal-val ${sig.rsi}">${fmt(lRSI,1)}</div><div class="signal-sub">${sig.rsi==='OVERBOUGHT'?'超買警示':sig.rsi==='OVERSOLD'?'超賣訊號':'正常區間'}</div></div>
  <div class="signal-card"><div class="signal-label">MACD</div><div class="signal-val ${sig.macd}">${sig.macd==='BUY'?'金叉':'死叉'}</div><div class="signal-sub">能量柱 ${fmt(lHist,3)}</div></div>
  <div class="signal-card"><div class="signal-label">KD (9,3,3)</div><div class="signal-val ${sig.kd==='BUY'||sig.kd==='OVERSOLD'?'up':'down'}">${fmt(lK,1)} / ${fmt(lD,1)}</div><div class="signal-sub">${sig.kd==='OVERBOUGHT'?'超買':sig.kd==='OVERSOLD'?'超賣':sig.kd==='BUY'?'K>D 偏多':'K<D 偏空'}</div></div>
  <div class="signal-card"><div class="signal-label">布林通道</div><div class="signal-val ${sig.bb==='OVERBOUGHT'?'down':sig.bb==='OVERSOLD'?'up':'neutral'}">${sig.bb==='OVERBOUGHT'?'突破上軌':sig.bb==='OVERSOLD'?'跌破下軌':'通道中段'}</div><div class="signal-sub">上軌 ${fmt(lBB?.upper)}</div></div>
</div>
`+buildSRBox(lc,lBB,r1,r2,s1,s2,pivot,pivR1,pivR2,pivS1,pivS2,h52,l52,chg)+``;

  document.getElementById('indGridBox').innerHTML=`
<div class="ind-card"><div class="ind-title">📐 趨勢指標</div>
  <div class="ind-row"><span class="ind-name">MA5</span><span class="ind-val">${fmt(lMA5)}</span></div>
  <div class="ind-row"><span class="ind-name">MA10</span><span class="ind-val">${fmt(lMA10)}</span></div>
  <div class="ind-row"><span class="ind-name">MA20</span><span class="ind-val">${fmt(lMA20)}</span></div>
  <div class="ind-row"><span class="ind-name">MA60</span><span class="ind-val">${fmt(lMA60)}</span></div>
  <div class="ind-row"><span class="ind-name">訊號</span>${sigBadge(sig.ma)}</div>
</div>
<div class="ind-card"><div class="ind-title">⚡ 動能指標</div>
  <div class="ind-row"><span class="ind-name">RSI (14)</span><span class="ind-val ${lRSI>70?'down':lRSI<30?'up':''}">${fmt(lRSI,2)}</span></div>
  <div class="ind-row"><span class="ind-name">RSI 訊號</span>${sigBadge(sig.rsi)}</div>
  <div class="ind-row"><span class="ind-name">K 值</span><span class="ind-val">${fmt(lK,2)}</span></div>
  <div class="ind-row"><span class="ind-name">D 值</span><span class="ind-val">${fmt(lD,2)}</span></div>
  <div class="ind-row"><span class="ind-name">KD 訊號</span>${sigBadge(sig.kd)}</div>
</div>
<div class="ind-card"><div class="ind-title">🔀 MACD 指標</div>
  <div class="ind-row"><span class="ind-name">MACD 線</span><span class="ind-val">${fmt(lMACD,4)}</span></div>
  <div class="ind-row"><span class="ind-name">訊號線</span><span class="ind-val">${fmt(lSig,4)}</span></div>
  <div class="ind-row"><span class="ind-name">能量柱</span><span class="ind-val ${lHist>0?'up':'down'}">${fmt(lHist,4)}</span></div>
  <div class="ind-row"><span class="ind-name">MACD 訊號</span>${sigBadge(sig.macd)}</div>
</div>
<div class="ind-card"><div class="ind-title">🎯 布林通道 (20,2)</div>
  <div class="ind-row"><span class="ind-name">上軌</span><span class="ind-val down">${fmt(lBB?.upper)}</span></div>
  <div class="ind-row"><span class="ind-name">中軌 (MA20)</span><span class="ind-val">${fmt(lBB?.mid)}</span></div>
  <div class="ind-row"><span class="ind-name">下軌</span><span class="ind-val up">${fmt(lBB?.lower)}</span></div>
  <div class="ind-row"><span class="ind-name">通道寬度</span><span class="ind-val">${lBB?.upper&&lBB?.lower?((lBB.upper-lBB.lower)/lBB.mid*100).toFixed(1)+'%':'N/A'}</span></div>
  <div class="ind-row"><span class="ind-name">布林訊號</span>${sigBadge(sig.bb)}</div>
</div>`;

  document.getElementById('techConclusionBox').innerHTML=`
<div class="conclusion-card">
  <div class="conclusion-title">📈 技術面綜合結論</div>
  <div class="conclusion-row">
    <div class="conclusion-section">
      <div class="c-section-title">✅ 多方依據</div>
      ${sig.ma==='BUY'?'<div class="c-item"><div class="c-dot" style="background:var(--green)"></div>MA5 站上 MA20，短線趨勢偏多</div>':''}
      ${sig.macd==='BUY'?'<div class="c-item"><div class="c-dot" style="background:var(--green)"></div>MACD 金叉，動能轉強</div>':''}
      ${sig.rsi==='OVERSOLD'?'<div class="c-item"><div class="c-dot" style="background:var(--green)"></div>RSI 低於 30，超賣反彈機會</div>':''}
      ${(sig.kd==='BUY'||sig.kd==='OVERSOLD')?'<div class="c-item"><div class="c-dot" style="background:var(--green)"></div>KD 指標偏多或超賣訊號</div>':''}
      ${sig.bb==='OVERSOLD'?'<div class="c-item"><div class="c-dot" style="background:var(--green)"></div>股價觸及布林下軌，支撐訊號</div>':''}
      ${buys===0&&os===0?'<div class="c-item" style="color:var(--text3)">目前無明顯多方訊號</div>':''}
    </div>
    <div class="conclusion-section">
      <div class="c-section-title">⚠️ 空方與風險</div>
      ${sig.ma==='SELL'?'<div class="c-item"><div class="c-dot" style="background:var(--red)"></div>MA5 跌破 MA20，趨勢偏空</div>':''}
      ${sig.macd==='SELL'?'<div class="c-item"><div class="c-dot" style="background:var(--red)"></div>MACD 死叉，動能轉弱</div>':''}
      ${sig.rsi==='OVERBOUGHT'?'<div class="c-item"><div class="c-dot" style="background:var(--red)"></div>RSI 超過 70，超買留意拉回</div>':''}
      ${sig.kd==='OVERBOUGHT'?'<div class="c-item"><div class="c-dot" style="background:var(--red)"></div>KD 高檔鈍化，注意回落風險</div>':''}
      ${sig.bb==='OVERBOUGHT'?'<div class="c-item"><div class="c-dot" style="background:var(--red)"></div>突破布林上軌，注意壓力</div>':''}
      ${sells===0&&ob===0?'<div class="c-item" style="color:var(--text3)">目前無明顯空方訊號</div>':''}
    </div>
  </div>
  <div class="overall-signal">
    <div class="os-label">技術面綜合評估</div>
    <div class="os-val ${oClass}">${oSig}</div>
    <div class="os-sub">${oSub}</div>
  </div>
</div>`;

  setTimeout(()=>{
    drawPriceChart(labels,c,ma5,ma20,ma60,bb);
    drawRSIChart(labels,rsi);
    drawMACDChart(labels,macdLine,sig2,hist);
  },60);

  // 給「AI 深度技術判讀」用的結構化輸入——除了現有的指標數值，還額外算了均線扣抵方向、
  // 布林開口方向、量能狀態這幾個 prompt 的過濾規則需要、但畫面上沒有直接顯示的判斷依據。
  const maAlignment=(lMA5!=null&&lMA20!=null&&lMA60!=null)
    ?(lMA5>lMA20&&lMA20>lMA60?'多頭排列（MA5>MA20>MA60）':lMA5<lMA20&&lMA20<lMA60?'空頭排列（MA5<MA20<MA60）':'糾結盤整')
    :'資料不足';
  const bbPosition=(lc==null||!lBB)?'資料不足'
    :lc>=lBB.upper?'貼著上軌走（強勢，非必為超買）'
    :lc<=lBB.lower?'貼著下軌走'
    :lc>lBB.mid?'中軌與上軌之間':'中軌與下軌之間';
  const volRatio=(dayVol&&avgVol)?dayVol/avgVol:null;
  const volState=volRatio==null?'資料不足':volRatio<0.8?'量縮':volRatio>1.3?'量增':'量能正常';
  const kdSignal=sig.kd==='OVERBOUGHT'?'高檔鈍化/超買':sig.kd==='OVERSOLD'?'低檔鈍化/超賣':sig.kd==='BUY'?'K>D 黃金交叉偏多':'K<D 死亡交叉偏空';

  return {
    lc:fmt(lc),
    ma5:fmt(lMA5),ma20:fmt(lMA20),ma60:fmt(lMA60),maAlignment,
    ma5Slope:maSlopeLabel(ma5),ma20Slope:maSlopeLabel(ma20),
    rsi:fmt(lRSI,1),
    k:fmt(lK,1),d:fmt(lD,1),kdSignal,
    macd:fmt(lMACD,4),macdSignal:fmt(lSig,4),macdHist:fmt(lHist,4),
    bbUpper:fmt(lBB?.upper),bbMid:fmt(lBB?.mid),bbLower:fmt(lBB?.lower),
    bbTrend:bbTrendLabel(bb),bbPosition,
    vol:fmtVol(dayVol),avgVol:fmtVol(avgVol),volState,
    pivot:fmt(pivot),pivR1:fmt(pivR1),pivR2:fmt(pivR2),pivS1:fmt(pivS1),pivS2:fmt(pivS2),
    r1:fmt(r1),r2:fmt(r2),s1:fmt(s1),s2:fmt(s2),
    h52:typeof h52==='number'?fmt(h52):(h52||'N/A'),l52:typeof l52==='number'?fmt(l52):(l52||'N/A'),
  };
}

function drawPriceChart(labels,c,ma5,ma20,ma60,bb){
  if(priceChart)priceChart.destroy();
  const stride=Math.max(1,Math.floor(labels.length/12));
  priceChart=new Chart(document.getElementById('priceChart').getContext('2d'),{type:'line',data:{labels,datasets:[
    {label:'收盤價',data:c,borderColor:'#e8e8f0',borderWidth:2,pointRadius:0,tension:0.2,order:1},
    {label:'MA5',data:ma5,borderColor:'#ffab00',borderWidth:1.5,pointRadius:0,tension:0.3,order:2},
    {label:'MA20',data:ma20,borderColor:'#448aff',borderWidth:1.5,pointRadius:0,tension:0.3,order:3},
    {label:'MA60',data:ma60,borderColor:'#b39dff',borderWidth:1.5,pointRadius:0,tension:0.3,order:4},
    {label:'布林上軌',data:bb.map(b=>b.upper),borderColor:'#ff5252',borderWidth:1,pointRadius:0,borderDash:[4,3],tension:0.3,order:5},
    {label:'布林下軌',data:bb.map(b=>b.lower),borderColor:'#00e676',borderWidth:1,pointRadius:0,borderDash:[4,3],tension:0.3,order:6},
  ]},options:{responsive:true,maintainAspectRatio:false,
    plugins:{legend:{display:true,labels:{color:'#9090a8',font:{size:11},boxWidth:14,padding:8}}},
    scales:{x:{ticks:{color:'#5a5a72',font:{size:10},maxRotation:0,callback:(_,i)=>i%stride===0?labels[i]:''},grid:{color:'rgba(255,255,255,0.04)'}},
    y:{ticks:{color:'#9090a8',font:{size:11}},grid:{color:'rgba(255,255,255,0.06)'}}}}});
}
function drawRSIChart(labels,rsi){
  if(rsiChart)rsiChart.destroy();
  rsiChart=new Chart(document.getElementById('rsiChart').getContext('2d'),{type:'line',data:{labels,datasets:[
    {data:rsi,borderColor:'#ff5252',borderWidth:2,pointRadius:0,tension:0.2,fill:false},
    {data:labels.map(()=>70),borderColor:'rgba(255,82,82,0.3)',borderWidth:1,pointRadius:0,borderDash:[4,3],fill:false},
    {data:labels.map(()=>30),borderColor:'rgba(0,230,118,0.3)',borderWidth:1,pointRadius:0,borderDash:[4,3],fill:false},
  ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
    scales:{x:{display:false},y:{min:0,max:100,ticks:{color:'#9090a8',font:{size:11}},grid:{color:'rgba(255,255,255,0.05)'}}}}});
}
function drawMACDChart(labels,ml,sig,hist){
  if(macdChart)macdChart.destroy();
  macdChart=new Chart(document.getElementById('macdChart').getContext('2d'),{data:{labels,datasets:[
    {type:'bar',data:hist,backgroundColor:hist.map(v=>v>0?'rgba(0,230,118,0.5)':'rgba(255,82,82,0.5)'),order:3},
    {type:'line',data:ml,borderColor:'#448aff',borderWidth:2,pointRadius:0,tension:0.2,order:1},
    {type:'line',data:sig,borderColor:'#ffab00',borderWidth:1.5,pointRadius:0,tension:0.2,borderDash:[4,3],order:2},
  ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
    scales:{x:{display:false},y:{ticks:{color:'#9090a8',font:{size:11}},grid:{color:'rgba(255,255,255,0.05)'}}}}});
}

async function fetchGroundingText(symbol,section){
  try{
    let url=`/api/ground?symbol=${encodeURIComponent(symbol)}&section=${encodeURIComponent(section)}`;
    if(fmpKey) url+=`&fmpKey=${encodeURIComponent(fmpKey)}`;
    const res=await fetch(url);
    if(!res.ok) return {text:'',source:null};
    const body=await res.json().catch(()=>({}));
    return {text:body.groundingText||'',source:body.source||null};
  }catch{
    return {text:'',source:null};
  }
}

async function runGeminiAnalysis(symbol,companyName,techSummary,gen){
  const model=selectedModel;
  const fundGrounding=await fetchGroundingText(symbol,'fundamentals');
  if(gen!==analyzeGeneration) return;
  const p1=buildPromptClientSide(symbol,companyName,techSummary,'fundamentals',fundGrounding.text);
  // 這個標示是程式碼固定渲染的，不是叫AI自己講——商業模式/護城河/客戶結構沒有即時資料
  // grounding，一律要標；成長動力則看有沒有真實財報數字可以引用（PROMPT_SECTIONS.fundamentals
  // 已經要求AI在討論成長動力時要引用真實數字）；財務健康數字看/api/ground回傳的source欄位：
  // fmp_3y=美股近3年、tw_latest_quarter=台股TWSE/TPEx官方最新一季、null=無資料。
  const fundHasRealData=fundGrounding.source==='fmp_3y'||fundGrounding.source==='tw_latest_quarter';
  const fundNote=`📌 資料來源標示：<b>商業模式／護城河／客戶結構</b>基於 AI 一般知識，非即時資料，可能有時效落差，請自行查證公司最新公告與新聞。<b>成長動力</b>${fundHasRealData?'已要求AI引用下方真實財報數字作為討論依據':'同樣基於 AI 一般知識，沒有真實數字可引用'}。<b>財務健康數字</b>${
    fundGrounding.source==='fmp_3y'?'已用 FMP 近3年真實財報數據佐證'
    :fundGrounding.source==='tw_latest_quarter'?'已用 TWSE/TPEx 官方最新一季財報數據佐證（僅單季，非3年趨勢）'
    :'目前沒有真實財報佐證，同樣基於 AI 一般知識'
  }。`;
  await streamGemini({system:p1.system,prompt:p1.user,model,note:fundNote},'fundContent','🏢 公司基本面 + 財務健康（重點一、二）',false,0,gen);
  const valGrounding=await fetchGroundingText(symbol,'valuation');
  if(gen!==analyzeGeneration) return;
  const p2=buildPromptClientSide(symbol,companyName,techSummary,'valuation',valGrounding.text);
  const valNote=`📌 資料來源標示：估值倍數與歷史區間判斷基於 AI 一般知識；同業比較表${valGrounding.source==='fmp_peers'?'已用 FMP 真實同業股價/本益比數據佐證':'目前沒有真實同業數據佐證（美股需要 FMP Key，台股目前尚未支援即時同業比較），同樣基於 AI 一般知識，請自行查證'}。`;
  await streamGemini({system:p2.system,prompt:p2.user,model,note:valNote},'fundContent','💰 估值合理性分析（重點三）',true,0,gen);
  if(gen!==analyzeGeneration) return;
  const p3=buildPromptClientSide(symbol,companyName,techSummary,'risk');
  await streamGemini({system:p3.system,prompt:p3.user,model},'riskContent','⚠️ 風險因素評估（重點四）',false,0,gen);
  if(gen!==analyzeGeneration) return;
  const p4=buildPromptClientSide(symbol,companyName,techSummary,'conclusion');
  await streamGemini({system:p4.system,prompt:p4.user,model},'conclusionContent','📋 投資結論整理（重點五）',false,0,gen);
}

async function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

// The only copy of these section prompts now — Gemini is always called directly with the
// visitor's own key (see streamGemini), so there's no backend copy to keep in sync with anymore.
const PROMPT_SECTIONS={
  fundamentals:`【分析重點一：公司基本面】每項附評語與評分（1-5星）：
- 商業模式與價值創造邏輯
- 主要收入來源與業務佔比趨勢
- 客戶結構與集中度風險
- 短中長期成長動力（若下方有提供真實財報數據，必須引用其中反映的營收規模、獲利能力等具體數字作為討論依據，不要完全脫離已提供的真實數字空談）
- 長期競爭優勢護城河（品牌/技術/規模/轉換成本/網路效應）

【分析重點二：財務健康（若下方只提供最新一季真實數據而非近3年，請以該單季數字為準，並在評語中明確標註這是單季而非3年趨勢，不要暗示成3年比較）】
- 3-5項財務亮點（綠燈）
- 3-5項財務紅旗（警示）
- 整體財務健康評級：優/良/中/待觀察並說明理由`,

  valuation:`【分析重點三：估值合理性】
- 當前估值倍數（P/E、Forward P/E、P/S、EV/EBITDA）
- 歷史估值區間比較（3-5年）
- 同業2-3家可比公司估值比較（HTML表格）
- 合理價值區間估算
- 估值結論：高估/合理/低估並說明理由`,

  risk:`【分析重點四：風險因素（由高至低排序）】
請輸出HTML表格，欄位：風險類別｜具體描述｜嚴重程度（高/中/低）｜發生可能性（高/中/低）
涵蓋六類：1.宏觀經濟 2.產業競爭 3.監管政策 4.公司治理 5.財務結構 6.估值過高
表格後加一段摘要說明最重要的2-3個風險。`,

  conclusion:`【分析重點五：投資結論整理】
1. 值得留意的優點（3-5項，每項一句）
2. 主要風險（3項，每項一句）
3. 需要進一步查證的資料（2-4項）
4. 適合哪類投資者（成長型/價值型/收息型/不建議散戶，說明理由）
只整理以上現況重點，不要給「強烈關注/值得追蹤/中性觀望/暫時迴避」這類分類評級，也不要給任何買進/賣出/加碼/減碼的操作建議。
最後加免責聲明段落。`,
};
// 拆成 system（角色、格式規則、反幻覺規則、這個區塊要分析什麼）跟 user（實際數據）兩段，
// 用 Gemini API 的 systemInstruction 欄位單獨傳，不要把規則跟資料混在同一個user turn裡——
// 模型對 systemInstruction 的服從度通常比埋在一大段資料中間的指令更高。
function buildPromptClientSide(symbol,companyName,techSummary,section,groundingText){
  const system=`你是一位資深股票研究分析師，擁有15年以上台灣與全球股票市場研究經驗。

請用繁體中文回答，格式使用 HTML（<h3><ul><li><p><strong><table>標籤），不要包含任何 markdown 或程式碼區塊標記。
所有分析只能根據使用者提供的數據與你確實掌握的公開事實，絕對不要編造未提供的具體數字、財報數據或新聞事件；
不確定或缺乏依據處請直接說明「資料不足」，不要用臆測填補，多空平衡，不偏樂觀或悲觀。

${PROMPT_SECTIONS[section]}`;
  const user=`技術面數據摘要（供參考）：
${techSummary}

分析對象：${companyName}（${symbol}）${groundingText||''}`;
  return {system,user};
}

async function streamGemini(payload,targetId,cardTitle,append,retryCount=0,gen=null){
  if(gen!=null&&gen!==analyzeGeneration) return; // superseded before we even started this section
  const modelUsed=payload.model||selectedModel;
  const el=document.getElementById(targetId);
  const cardId='gc-'+Math.random().toString(36).slice(2);
  const card=document.createElement('div');
  card.className='fund-card';
  // payload.note是程式碼固定渲染的資料來源標示（不是叫AI自己講），避免使用者誤以為整張卡片
  // 都有真實數據佐證——不管這次AI輸出品質如何，這個標示都會準確顯示，不依賴AI是否服從指令。
  const noteHtml=payload.note?`<div class="info-box" style="margin-bottom:12px;border-left:3px solid var(--amber);font-size:12px;padding:10px 14px">${payload.note}</div>`:'';
  card.innerHTML='<div class="fund-card-title">'+cardTitle+'</div>'+noteHtml+'<div class="fund-content streaming" id="'+cardId+'"></div>';
  if(append) el.appendChild(card);
  else{ el.innerHTML=''; el.appendChild(card); }
  const contentEl=document.getElementById(cardId);

  if(retryCount===0&&quotaExhaustedModels.has(modelUsed)){
    contentEl.classList.remove('streaming');
    contentEl.innerHTML=`<div class="error-box">⚠ AI 分析失敗：${quotaExhaustedModels.get(modelUsed)}</div>`;
    return;
  }

  try{
    const res=await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${payload.model||selectedModel}:streamGenerateContent?alt=sse&key=${apiKey}`,
      {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          ...(payload.system?{systemInstruction:{parts:[{text:payload.system}]}}:{}),
          contents:[{role:'user',parts:[{text:payload.prompt}]}],
          // 這是財經分析不是創意寫作，溫度壓低讓輸出更貼著指令走、少一點「自由發揮」——
          // 這也是降低幻覺機率的直接手段之一，跟systemInstruction、反幻覺規則是互補的。
          generationConfig:{temperature:0.2,maxOutputTokens:4096,thinkingConfig:{thinkingLevel:'low'}},
          safetySettings:[
            {category:'HARM_CATEGORY_HARASSMENT',threshold:'BLOCK_NONE'},
            {category:'HARM_CATEGORY_HATE_SPEECH',threshold:'BLOCK_NONE'},
            {category:'HARM_CATEGORY_SEXUALLY_EXPLICIT',threshold:'BLOCK_NONE'},
            {category:'HARM_CATEGORY_DANGEROUS_CONTENT',threshold:'BLOCK_NONE'},
          ],
        }),
      }
    );

    if(!res.ok){
      const errBody=await res.json().catch(()=>({}));
      const errMsg=errBody?.error?.message||'';

      if(res.status===429||res.status===503){
        // "limit: 0" means the key/project truly has no quota at all (misconfigured project).
        // A message that merely mentions "free_tier_requests" does NOT imply limit 0 — that's
        // just the quota metric's name, and matches even a normal "used up today's 20" case.
        const limitMatch=errMsg.match(/limit:\s*(\d+)/i);
        const limitNum=limitMatch?parseInt(limitMatch[1],10):null;
        if(limitNum===0){
          throw new Error('此 Gemini API Key 的免費額度為 0（limit: 0）。可能原因：① 此 Key 所屬 Google Cloud 專案尚未啟用 Generative Language API 的免費方案 ② 已超過免費帳號上限。請至 https://aistudio.google.com/app/apikey 確認 Key 狀態，或改用付費 API Key。');
        }
        if(retryCount<2){
          const waitSec=15*(retryCount+1);
          contentEl.innerHTML=`<div style="color:var(--amber);font-size:13px;padding:8px 0">⏳ AI 服務短暫忙碌，等待 ${waitSec} 秒後重試（第 ${retryCount+1}/2 次）⋯</div>`;
          await sleep(waitSec*1000);
          if(gen!=null&&gen!==analyzeGeneration) return;
          card.remove();
          return streamGemini(payload,targetId,cardTitle,append,retryCount+1,gen);
        }
        if(limitNum&&/free_tier_requests/i.test(errMsg)){
          // Suggest an actually different model — if the visitor is already on Flash-Lite (the model
          // that just ran out), telling them to "switch to Flash-Lite" would be nonsensical.
          const altSuggestion=modelUsed==='gemini-3.1-flash-lite'?'3.5 Flash 或 3.5 Pro':'3.1 Flash-Lite';
          const msg=`此模型今日免費額度（每日 ${limitNum} 次）可能已用完，請明天再試，或在上方切換其他 AI 模型（例如 ${altSuggestion}）。`;
          quotaExhaustedModels.set(modelUsed,msg);
          throw new Error(msg);
        }
        throw new Error('AI 服務持續忙碌，請等待1-2分鐘後重新分析。');
      }
      throw new Error(errMsg||`AI 分析失敗 (${res.status})`);
    }

    const reader=res.body.getReader();
    const decoder=new TextDecoder();
    let buffer='',fullText='';
    while(true){
      if(gen!=null&&gen!==analyzeGeneration){ reader.cancel().catch(()=>{}); return; }
      const{done,value}=await reader.read();
      if(done) break;
      buffer+=decoder.decode(value,{stream:true});
      const lines=buffer.split('\n');
      buffer=lines.pop()||'';
      for(const line of lines){
        if(!line.startsWith('data:')) continue;
        const jsonStr=line.slice(5).trim();
        if(!jsonStr||jsonStr==='[DONE]') continue;
        try{
          const chunk=JSON.parse(jsonStr);
          const text=chunk?.candidates?.[0]?.content?.parts?.[0]?.text||'';
          if(text){
            fullText+=text;
            const clean=fullText.replace(/```html?\n?/gi,'').replace(/```\n?/g,'');
            contentEl.innerHTML=clean;
          }
        }catch{}
      }
    }
    contentEl.classList.remove('streaming');
  }catch(e){
    if(gen!=null&&gen!==analyzeGeneration) return;
    contentEl.classList.remove('streaming');
    contentEl.innerHTML=`<div class="error-box">⚠ AI 分析失敗：${e.message}</div>`;
  }
}

// ---- AI 深度技術判讀（合理買入價與風控策略）----
// 使用者提供的完整交易員角色prompt。跟其他AI區塊（PROMPT_SECTIONS）不同，這裡要的是嚴格結構化
// JSON輸出（合理買入價/停損/停利），不是HTML文字，所以用responseSchema強制Gemini回傳合法JSON，
// 而不是像streamGemini那樣邊收邊顯示原始文字。
function buildTechAIPrompt(symbol,companyName,t){
  const system=`## 角色與定位
你是一位資深的台股（TWSE/TPEx）短線造市商與量化交易員。你的任務是讀取以下技術指標、關鍵價位與現價，進行多空動能的深度審查。

你必須看穿數值背後的「市場陷阱」，計算出符合風險報酬比的合理買入價，並輸出兼具實戰價值的結構化交易策略。

---

## 交易眉角與過濾邏輯 (Trading Nuances & Filters)

在評估數據時，你必須嚴格執行以下「實戰眉角」的過濾，不得僅依據單一指標盲目輸出訊號：

### 1. 均線與扣抵陷阱 (MA & Tracking Snare)
*   眉角：股價站上均線不等於均線會上揚。如果扣抵值在高檔，均線依然會下彎形成下壓壓力。
*   過濾邏輯：若 MA5/MA20 雖然被現價站上，但若處於「下彎」狀態，一律視為「反彈遇阻」，而非「多頭確立」。

### 2. KD 鈍化與 RSI 盲區 (Indicator Passivation)
*   眉角：強勢股在極端行情下，KD 常會在 80 以上出現「高檔鈍化」，此時盲目放空會被軋空；同理，主跌段 KD 在 20 以下低檔鈍化也不該盲目猜底。
*   過濾邏輯：若 KD 訊號呈現「賣出（高檔死叉）」，但此時均線排列為強勢「多頭」、且布林通道「向上開口發散」，此死叉高機率為短線洗盤，策略應修正為「順勢拉回找買點」。

### 3. 布林通道的邊界效應 (Bollinger Band Extremes)
*   眉角：股價貼著布林上軌走叫「飆股」，不是超買！只有在「量縮」且現價「跌回上軌之內」時，才是多頭力竭。

---

## 合理買入價與風控計算邏輯 (Fair Price & Risk/Reward Calculation)

當策略評估為「可佈局（偏多/跌深反彈）」時，你必須依據下方數據，依循以下邏輯推算合理買入價：

1.  多頭趨勢（趨勢指標=多頭 / 布林=通道中軌或上軌）：
    *   合理買入價定位：不盲目追高，合理買入價應落在「現價拉回至關鍵支撐」的交集區。
    *   計算參考：優先考慮 MA5 與 樞紐 S1 之間的重疊區間。若現價離 MA5 過遠（乖離過大），必須警示「溢價過高，應等待拉回至 MA5 數值附近再行介入」。
2.  逆勢橫盤（布林=通道下軌 / KD/RSI=超賣）：
    *   合理買入價定位：尋找左側築底支撐。
    *   計算參考：合理買入價應設定在 樞紐 S1 至 樞紐 S2 之間，或接近 布林下軌 處，此時買入的防守成本最低。
3.  風控期望值過濾（硬性限制）：
    *   合理買入價必須滿足：(預期獲利目標 − 合理買入價) / (合理買入價 − 建議停損價) ≥ 2（風險報酬比至少 1:2）。若現價進場不符合此比例，必須在合理買入價中進行「壓低修正」。
4.  停損價不可設在「正常波動雜訊範圍內」（硬性限制）：
    *   停損價不能只是合理買入價往下隨便扣一個小數字——必須設在一個真正的技術破壞點（例如跌破樞紐 S2、跌破布林下軌、或跌破近期真正的低點support），且距離合理買入價至少要達到布林通道寬度（上軌−下軌）的 15% 以上。
    *   若停損設得太緊（例如只是合理買入價的 1-2%），代表這支股票正常的日內波動就足以洗出這個停損，不是有效的風控，必須往下修正到更保守、真正反映技術破壞的價位。

---

---

## 操作風格分類 (Style Archetype)

除了買賣策略本身，你還要根據下方技術數據的「特徵」（不是猜測基本面或消息面，純粹看技術指標呈現出的樣貌），判斷目前這個技術設定比較貼近哪一種操作風格：

*   **當沖／短線動能型**：布林通道開口寬（高波動）、成交量急速放大、現價緊貼布林上軌或下軌邊界、KD/RSI 出現鈍化——這種設定波動大、進出節奏快，比較適合短線操作，不適合長抱。
*   **波段／趨勢持有型**：均線多頭排列且緩步上揚（非暴衝）、量能溫和放大、現價落在布林中軌附近、無極端超買超賣——這種設定走勢穩健，比較適合抱波段。
*   **題材輪動／噴出型**：現價剛突破近期盤整區間或站上樞紐 R1/R2、成交量較 10 日均量放大 2 倍以上、MACD 剛翻多或能量柱由負轉正——這種設定是噴出段的樣貌，機會與過熱風險並存。

這只是描述「現在這個技術圖形長得像哪一種」，不是要你去模仿任何特定交易者的個人操作習慣，也不是操作指示——分類理由必須引用上面實際的數值特徵，不可憑空判斷。

所有價位數字（合理買入價、停損、停利）必須是從使用者提供的均線、樞紐點、布林通道等數值合理推算出來的，不可虛構不存在於輸入數據中的價位。
請嚴格按照指定的 JSON Schema 輸出，不要包含任何 markdown 或程式碼區塊標記、也不要加任何 JSON 以外的說明文字。所有價位數字使用現價相同的小數位數。`;

  const user=`## 本次分析標的與即時數據

股票：${companyName}（${symbol}）
現價：${t.lc}

【均線】
MA5=${t.ma5} MA20=${t.ma20} MA60=${t.ma60}
均線排列：${t.maAlignment}
MA5 近3日扣抵方向：${t.ma5Slope}｜MA20 近3日扣抵方向：${t.ma20Slope}

【動能指標】
RSI(14)=${t.rsi}
K=${t.k} D=${t.d}，KD訊號：${t.kdSignal}
MACD=${t.macd}，Signal=${t.macdSignal}，能量柱=${t.macdHist}

【布林通道(20,2)】
上軌=${t.bbUpper} 中軌=${t.bbMid} 下軌=${t.bbLower}
通道開口：${t.bbTrend}
現價位置：${t.bbPosition}

【成交量】
今日量=${t.vol}，10日均量=${t.avgVol}，量能狀態：${t.volState}

【關鍵價位】
樞紐點=${t.pivot}
樞紐 R1=${t.pivR1} R2=${t.pivR2}
樞紐 S1=${t.pivS1} S2=${t.pivS2}
20日高低=${t.r1}/${t.s1}，60日高低=${t.r2}/${t.s2}
52週高低=${t.h52}/${t.l52}`;

  return {system,user};
}

const TECH_AI_SCHEMA={
  type:'OBJECT',
  properties:{
    overall_signal:{type:'STRING',enum:['強勢多頭','偏多反彈','盤整中性','弱勢空頭','跌深反彈']},
    matched_strategy:{type:'STRING'},
    technical_nuance_warning:{type:'STRING'},
    style_archetype:{
      type:'OBJECT',
      properties:{
        label:{type:'STRING',enum:['當沖／短線動能型','波段／趨勢持有型','題材輪動／噴出型']},
        rationale:{type:'STRING'},
      },
      required:['label','rationale'],
    },
    fair_entry_price:{
      type:'OBJECT',
      properties:{
        recommended_price:{type:'NUMBER'},
        price_range:{type:'STRING'},
        rationale:{type:'STRING'},
      },
      required:['recommended_price','price_range','rationale'],
    },
    action_plan:{
      type:'OBJECT',
      properties:{
        stop_loss:{type:'STRING'},
        take_profit:{type:'STRING'},
      },
      required:['stop_loss','take_profit'],
    },
  },
  required:['overall_signal','matched_strategy','technical_nuance_warning','style_archetype','fair_entry_price','action_plan'],
};

// 跟streamGemini走同一套429/503重試與額度偵測邏輯，但streamGemini是綁定SSE串流+特定DOM結構寫死的，
// 硬要共用會讓兩邊都變難讀，這裡另外寫一份非串流版本（等JSON全部回來才parse，不能一邊收一邊顯示半個JSON）。
async function callGeminiJSON(system,prompt,model,schema,gen,retryCount=0){
  if(gen!=null&&gen!==analyzeGeneration) return null;
  const el=document.getElementById('techAIBox');
  if(retryCount===0){
    el.innerHTML='<div class="fund-loading"><div class="spinner"></div><span>Gemini AI 正在計算合理買入價與風控策略⋯</span></div>';
  }

  if(retryCount===0&&quotaExhaustedModels.has(model)){
    throw new Error(quotaExhaustedModels.get(model));
  }

  const res=await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        ...(system?{systemInstruction:{parts:[{text:system}]}}:{}),
        contents:[{role:'user',parts:[{text:prompt}]}],
        generationConfig:{
          // 這裡直接輸出具體交易價位，比其他文字分析更需要壓低隨機性——溫度比streamGemini
          // 的0.2更低，讓模型盡量貼著systemInstruction裡的計算規則走，少一點自由發揮空間。
          temperature:0.1,
          // Gemini 3.x的隱藏推理token(thoughtsTokenCount)跟可見輸出共用同一個maxOutputTokens
          // 額度——這個app先前在streamGemini那邊就踩過同樣的坑(maxOutputTokens:1500太小，
          // 推理token吃光額度，finishReason變成MAX_TOKENS，只輸出半句就被截斷)，這裡用同一個
          // 已經驗證過足夠的4096，不要重蹈覆轍。
          maxOutputTokens:4096,
          responseMimeType:'application/json',
          responseSchema:schema,
          thinkingConfig:{thinkingLevel:'low'},
        },
        safetySettings:[
          {category:'HARM_CATEGORY_HARASSMENT',threshold:'BLOCK_NONE'},
          {category:'HARM_CATEGORY_HATE_SPEECH',threshold:'BLOCK_NONE'},
          {category:'HARM_CATEGORY_SEXUALLY_EXPLICIT',threshold:'BLOCK_NONE'},
          {category:'HARM_CATEGORY_DANGEROUS_CONTENT',threshold:'BLOCK_NONE'},
        ],
      }),
    }
  );

  if(!res.ok){
    const errBody=await res.json().catch(()=>({}));
    const errMsg=errBody?.error?.message||'';
    if(res.status===429||res.status===503){
      const limitMatch=errMsg.match(/limit:\s*(\d+)/i);
      const limitNum=limitMatch?parseInt(limitMatch[1],10):null;
      if(limitNum===0){
        throw new Error('此 Gemini API Key 的免費額度為 0（limit: 0）。可能原因：① 此 Key 所屬 Google Cloud 專案尚未啟用 Generative Language API 的免費方案 ② 已超過免費帳號上限。請至 https://aistudio.google.com/app/apikey 確認 Key 狀態，或改用付費 API Key。');
      }
      if(retryCount<2){
        const waitSec=15*(retryCount+1);
        el.innerHTML=`<div style="color:var(--amber);font-size:13px;padding:8px 0">⏳ AI 服務短暫忙碌，等待 ${waitSec} 秒後重試（第 ${retryCount+1}/2 次）⋯</div>`;
        await sleep(waitSec*1000);
        if(gen!=null&&gen!==analyzeGeneration) return null;
        return callGeminiJSON(system,prompt,model,schema,gen,retryCount+1);
      }
      if(limitNum&&/free_tier_requests/i.test(errMsg)){
        const altSuggestion=model==='gemini-3.1-flash-lite'?'3.5 Flash 或 3.5 Pro':'3.1 Flash-Lite';
        const msg=`此模型今日免費額度（每日 ${limitNum} 次）可能已用完，請明天再試，或在上方切換其他 AI 模型（例如 ${altSuggestion}）。`;
        quotaExhaustedModels.set(model,msg);
        throw new Error(msg);
      }
      throw new Error('AI 服務持續忙碌，請等待1-2分鐘後重新分析。');
    }
    throw new Error(errMsg||`AI 分析失敗 (${res.status})`);
  }

  const body=await res.json();
  const finishReason=body?.candidates?.[0]?.finishReason;
  const text=body?.candidates?.[0]?.content?.parts?.[0]?.text;
  // finishReason清楚標示原因時直接講明白，不要讓使用者每次都看到同一句「格式無法解析」
  // 卻猜不到到底是被截斷還是被安全過濾攔截——MAX_TOKENS代表輸出被腰斬（通常是隱藏推理
  // token吃了太多額度），這種情況比對一般解析失敗更值得知道具體原因。
  if(!text){
    if(finishReason==='MAX_TOKENS') throw new Error('AI 回應在完成前就被截斷（finishReason: MAX_TOKENS），請重新分析一次。');
    throw new Error(`AI 回應為空或格式不符（finishReason: ${finishReason||'未知'}，可能被安全過濾攔截）。`);
  }
  try{
    return JSON.parse(text);
  }catch{
    const reasonNote=finishReason==='MAX_TOKENS'?'（finishReason: MAX_TOKENS，輸出被截斷導致JSON不完整）':'';
    throw new Error(`AI 回應的 JSON 格式無法解析${reasonNote}，請重新分析一次。`);
  }
}

function parseNumLoose(v){
  if(v==null) return null;
  const n=parseFloat(String(v).replace(/[^0-9.\-]/g,''));
  return isFinite(n)?n:null;
}

// 事後驗算：prompt指令降低不了AI編數字的機率到0，所以這裡用程式碼把AI回傳的價位跟
// 真實技術數值（techAIInput，跟AI拿到的是同一份資料）對一遍——停損/停利的基本順序、
// AI自己被要求遵守的風報比≥1:2規則、跟52週價格區間比對是否離譜。抓不到的問題還是抓不到
// （AI可能用巧妙但仍然錯的方式維持"看起來合理"的數字），但能擋掉最明顯的離譜幻覺。
function validateTechAIStrategy(result,techAIInput){
  const warnings=[];
  const fp=result.fair_entry_price||{};
  const ap=result.action_plan||{};
  const entry=typeof fp.recommended_price==='number'?fp.recommended_price:null;
  const stopLoss=parseNumLoose(ap.stop_loss);
  const takeProfit=parseNumLoose(ap.take_profit);

  if(entry==null) warnings.push('AI 未提供可用的合理買入價數值');
  if(stopLoss==null) warnings.push('AI 提供的停損價無法解析為數字');
  if(takeProfit==null) warnings.push('AI 提供的停利價無法解析為數字');

  if(entry!=null&&stopLoss!=null&&stopLoss>=entry){
    warnings.push(`停損價（${stopLoss}）沒有低於合理買入價（${entry}），不符合基本邏輯`);
  }
  if(entry!=null&&takeProfit!=null&&takeProfit<=entry){
    warnings.push(`停利價（${takeProfit}）沒有高於合理買入價（${entry}），不符合基本邏輯`);
  }
  if(entry!=null&&stopLoss!=null&&takeProfit!=null&&stopLoss<entry&&takeProfit>entry){
    const rr=(takeProfit-entry)/(entry-stopLoss);
    if(rr<1.9) warnings.push(`風險報酬比僅約 1:${rr.toFixed(2)}，未達 prompt 要求 AI 遵守的 1:2 門檻`);
  }

  const h52=parseNumLoose(techAIInput.h52),l52=parseNumLoose(techAIInput.l52);
  if(entry!=null&&h52!=null&&l52!=null&&h52>l52){
    const buffer=(h52-l52)*0.15;
    if(entry>h52+buffer||entry<l52-buffer){
      warnings.push(`合理買入價（${entry}）明顯超出52週價格區間（${l52}~${h52}），疑似幻覺數字`);
    }
  }

  // 停損太緊的問題不是「數字順序錯」，是「正常價格雜訊就會把停損打掉」，prompt指令沒辦法
  // 保證AI真的照做，這裡用布林通道寬度（20日的實際波動幅度）當波動性的客觀量尺，量化檢查
  // 停損距離是不是明顯小於這支股票正常的日內/短期波動——是的話代表這個停損不是有效風控。
  const bbUpper=parseNumLoose(techAIInput.bbUpper),bbLower=parseNumLoose(techAIInput.bbLower);
  if(entry!=null&&stopLoss!=null&&stopLoss<entry&&bbUpper!=null&&bbLower!=null&&bbUpper>bbLower){
    const bbWidth=bbUpper-bbLower;
    const stopDistance=entry-stopLoss;
    if(stopDistance<bbWidth*0.2){
      warnings.push(`停損距離（${stopDistance.toFixed(2)}）只有布林通道寬度（${bbWidth.toFixed(2)}）的 ${((stopDistance/bbWidth)*100).toFixed(0)}%，可能過緊——這支股票正常的價格波動就足以觸發停損，不是有效的風控設定`);
    }
  }

  return warnings;
}

async function runTechAIStrategy(symbol,companyName,techAIInput,gen){
  if(gen!==analyzeGeneration) return;
  const el=document.getElementById('techAIBox');
  try{
    const {system,user}=buildTechAIPrompt(symbol,companyName,techAIInput);
    const result=await callGeminiJSON(system,user,selectedModel,TECH_AI_SCHEMA,gen);
    if(gen!==analyzeGeneration||!result) return;
    renderTechAIStrategy(result,validateTechAIStrategy(result,techAIInput));
  }catch(e){
    if(gen!==analyzeGeneration) return;
    el.innerHTML=`<div class="error-box">⚠ AI 深度技術判讀失敗：${escapeHtml(e.message)}</div>`;
  }
}

function renderTechAIStrategy(result,warnings){
  const el=document.getElementById('techAIBox');
  const sig=result.overall_signal||'';
  const bullish=/多頭|反彈/.test(sig)&&!/弱勢|空頭/.test(sig);
  const bearish=/弱勢|空頭/.test(sig);
  const sigClass=bullish?'up':bearish?'down':'neutral';
  const fp=result.fair_entry_price||{};
  const ap=result.action_plan||{};
  const style=result.style_archetype||{};
  el.innerHTML=`
<div class="conclusion-card">
  <div class="conclusion-title">🤖 AI 深度技術判讀（合理買入價與風控策略）</div>
  ${(warnings&&warnings.length)?`<div class="error-box" style="margin-bottom:12px">🛑 系統自動驗算：以下數字疑似不合理，請勿直接採用<ul style="margin:6px 0 0 18px;padding:0">${warnings.map(w=>`<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`:''}
  <div class="overall-signal">
    <div class="os-label">綜合訊號</div>
    <div class="os-val ${sigClass}">${escapeHtml(sig)}</div>
    <div class="os-sub">${escapeHtml(result.matched_strategy||'')}</div>
  </div>
  ${style.label?`<div class="info-box" style="margin-top:12px;border-left:3px solid var(--blue)"><b>操作風格分類：${escapeHtml(style.label)}</b><br>${escapeHtml(style.rationale||'')}</div>`:''}
  ${result.technical_nuance_warning?`<div class="info-box" style="margin-top:12px;border-left:3px solid var(--amber)">⚠️ ${escapeHtml(result.technical_nuance_warning)}</div>`:''}
  <div class="ind-card" style="margin-top:12px;background:var(--bg3)">
    <div class="ind-title">🎯 合理買入價</div>
    <div style="display:flex;align-items:baseline;gap:12px;margin:6px 0">
      <span style="font-size:26px;font-weight:700;color:var(--text)">${typeof fp.recommended_price==='number'?fmt(fp.recommended_price):'N/A'}</span>
      <span style="font-size:13px;color:var(--text3)">${escapeHtml(fp.price_range||'')}</span>
    </div>
    <div style="font-size:12px;color:var(--text2);line-height:1.6">${escapeHtml(fp.rationale||'')}</div>
  </div>
  <div class="kpi-grid" style="margin-top:12px">
    <div class="kpi"><div class="kpi-label">建議停損價</div><div class="kpi-val down">${escapeHtml(String(ap.stop_loss??'N/A'))}</div></div>
    <div class="kpi"><div class="kpi-label">預期目標價</div><div class="kpi-val up">${escapeHtml(String(ap.take_profit??'N/A'))}</div></div>
  </div>
  <div class="disclaimer" style="margin-top:12px">⚠ 本 AI 判讀基於技術指標數值推論，非投資建議，實際交易請自行評估風險並設定停損。</div>
</div>`;
}

// ---- 籌碼面 ----
// Error/field-name strings can echo back external API content (e.g. TDCC/TWSE's own field
// names when their schema doesn't match what we expect) — escape before innerHTML in case
// an upstream response ever contains HTML-special characters.
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtField(field,formatter){
  if(!field) return '<span style="color:var(--text3)">暫無資料</span>';
  if(field.error) return `<span style="color:var(--text3)">暫無資料</span><div class="src-note">${escapeHtml(field.error)}</div>`;
  if(field.value==null) return `<span style="color:var(--text3)">暫無資料</span>${field.note?`<div class="src-note">${escapeHtml(field.note)}</div>`:''}`;
  const val=formatter?formatter(field.value):field.value;
  const src=field.source?`${field.source}${field.date?'／'+field.date:''}`:'';
  const noteLine=field.note?`<div class="src-note">${escapeHtml(field.note)}</div>`:'';
  return `${val}${src?`<div class="src-note">來源：${escapeHtml(src)}</div>`:''}${noteLine}`;
}

async function fetchChip(symbol){
  const res=await fetch(`/api/chip?symbol=${encodeURIComponent(symbol)}`);
  const body=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(body?.error||'籌碼面資料取得失敗');
  return body;
}

function renderChip(data, etfData, lc){
  const el=document.getElementById('chipContent');
  const m=data.margin||{},h=data.holders||{},inst=data.institutional||{};
  const pct=v=>(v*100).toFixed(2)+'%';
  const num=v=>Number(v).toLocaleString();

  const fmtAmt = v => {
    if (v==null) return '金額暫無資料';
    const abs = Math.abs(v);
    if (abs >= 1e8) return (v / 1e8).toFixed(2) + ' 億元';
    if (abs >= 1e4) return (v / 1e4).toFixed(0) + ' 萬元';
    return v.toLocaleString() + ' 元';
  };

  let etfHtml = '';
  if (etfData) {
    if (!etfData.flow || etfData.flow.length === 0) {
      etfHtml = `
      <div class="ind-card" style="grid-column: 1 / -1; margin-top: 16px;">
        <div class="ind-title">🤖 主動式 ETF 經理人當日加減碼動態</div>
        <div style="font-size:12px; color:var(--text3); padding:20px 0; text-align:center;">
          今日此標的尚未被納入主動式 ETF 經理人的當日加減碼申報明細（或今日無持股變動）。
        </div>
      </div>`;
    } else if (etfData.isEtf) {
      etfHtml = `
      <div class="ind-card" style="grid-column: 1 / -1; margin-top: 16px;">
        <div class="ind-title">🤖 ${escapeHtml(etfData.etfName)} (${escapeHtml(etfData.etfCode)}) 當日持股與加減碼明細</div>
        <table style="width:100%; border-collapse:collapse; margin-top:10px; font-size:13px;">
          <thead>
            <tr style="border-bottom:1px solid var(--border2); text-align:left; color:var(--text3); font-size:11px; text-transform:uppercase;">
              <th style="padding:8px 10px;">持股個股</th>
              <th style="padding:8px 10px;">操作</th>
              <th style="padding:8px 10px; text-align:right;">加減碼股數 / 金額</th>
              <th style="padding:8px 10px; text-align:right;">比重變化</th>
              <th style="padding:8px 10px; text-align:right;">當日持股 / 金額</th>
              <th style="padding:8px 10px; text-align:right;">當日權重</th>
            </tr>
          </thead>
          <tbody>
            ${etfData.flow.map(f => {
              let badgeClass = 'badge-amber';
              let colorStyle = 'var(--text3)';
              let sign = '';
              if (f.changeShares > 0) {
                badgeClass = 'badge-red';
                colorStyle = 'var(--red)';
                sign = '+';
              } else if (f.changeShares < 0) {
                badgeClass = 'badge-green';
                colorStyle = 'var(--green)';
                sign = '';
              }
              const amtColor = f.changeAmount > 0 ? 'var(--red)' : (f.changeAmount < 0 ? 'var(--green)' : 'var(--text3)');
              const wtColor = f.changeWeight > 0 ? 'var(--red)' : (f.changeWeight < 0 ? 'var(--green)' : 'var(--text3)');
              const amtSign = f.changeAmount > 0 ? '+' : '';
              const wtSign = f.changeWeight > 0 ? '+' : '';
              const changeSharesTxt = f.changeShares != null ? `${sign}${f.changeShares.toLocaleString()} 股` : (f.changeWeight != null ? '無股數資料' : '無比較資料');
              const changeWeightTxt = f.changeWeight != null ? `${wtSign}${f.changeWeight.toFixed(2)}%` : '—';
              const changeAmtTxt = f.changeAmount != null ? `${amtSign}${fmtAmt(f.changeAmount)}${f.amountEstimated ? '（以權重推算）' : ''}` : '';
              const totalAmtTxt = f.totalAmount != null ? `${fmtAmt(f.totalAmount)}${f.totalAmountEstimated ? '（以權重推算）' : ''}` : '';
              const sharesTxt = f.shares != null ? `${f.shares.toLocaleString()} 股` : '（無股數資料）';
              return `
              <tr style="border-bottom:1px solid var(--border);">
                <td style="padding:8px 10px; font-weight:600; color:var(--blue); cursor:pointer;" onclick="quickLoad('${escapeHtml(f.stockCode)}.TW')">${escapeHtml(f.stockName)} (${escapeHtml(f.stockCode)})</td>
                <td style="padding:8px 10px;"><span class="badge ${badgeClass}">${escapeHtml(f.action)}</span></td>
                <td style="padding:8px 10px; text-align:right; font-weight:700; color:${colorStyle};">
                  <div>${changeSharesTxt}</div>
                  <div style="font-size:10px; font-weight:normal; opacity:.7; color:${amtColor};">${changeAmtTxt}</div>
                </td>
                <td style="padding:8px 10px; text-align:right; color:${wtColor};">${changeWeightTxt}</td>
                <td style="padding:8px 10px; text-align:right; color:var(--text2);">
                  <div>${sharesTxt}</div>
                  <div style="font-size:10px; opacity:.7;">${totalAmtTxt}</div>
                </td>
                <td style="padding:8px 10px; text-align:right; color:var(--text2);">${f.weight.toFixed(2)}%</td>
              </tr>
              `;
            }).join('')}
          </tbody>
        </table>
        <div class="src-note" style="margin-top:8px;">申報基準日：${escapeHtml(etfData.date)}，前一日：${escapeHtml(etfData.comparedTo || '無歷史資料')}</div>
      </div>`;
    } else {
      etfHtml = `
      <div class="ind-card" style="grid-column: 1 / -1; margin-top: 16px;">
        <div class="ind-title">🤖 主動式 ETF 經理人當日加減碼動態</div>
        <table style="width:100%; border-collapse:collapse; margin-top:10px; font-size:13px;">
          <thead>
            <tr style="border-bottom:1px solid var(--border2); text-align:left; color:var(--text3); font-size:11px; text-transform:uppercase;">
              <th style="padding:8px 10px;">主動式 ETF</th>
              <th style="padding:8px 10px;">操作</th>
              <th style="padding:8px 10px; text-align:right;">異動股數 / 金額</th>
              <th style="padding:8px 10px; text-align:right;">比重變化</th>
              <th style="padding:8px 10px; text-align:right;">當日持股 / 金額</th>
              <th style="padding:8px 10px; text-align:right;">當日權重</th>
            </tr>
          </thead>
          <tbody>
            ${etfData.flow.map(f => {
              let badgeClass = 'badge-amber';
              let colorStyle = 'var(--text3)';
              let sign = '';
              if (f.changeShares > 0) {
                badgeClass = 'badge-red';
                colorStyle = 'var(--red)';
                sign = '+';
              } else if (f.changeShares < 0) {
                badgeClass = 'badge-green';
                colorStyle = 'var(--green)';
                sign = '';
              }
              const amtColor = f.changeAmount > 0 ? 'var(--red)' : (f.changeAmount < 0 ? 'var(--green)' : 'var(--text3)');
              const wtColor = f.changeWeight > 0 ? 'var(--red)' : (f.changeWeight < 0 ? 'var(--green)' : 'var(--text3)');
              const amtSign = f.changeAmount > 0 ? '+' : '';
              const wtSign = f.changeWeight > 0 ? '+' : '';
              const changeSharesTxt = f.changeShares != null ? `${sign}${f.changeShares.toLocaleString()} 股` : (f.changeWeight != null ? '無股數資料' : '無比較資料');
              const changeWeightTxt = f.changeWeight != null ? `${wtSign}${f.changeWeight.toFixed(2)}%` : '—';
              const changeAmtTxt = f.changeAmount != null ? `${amtSign}${fmtAmt(f.changeAmount)}${f.amountEstimated ? '（以權重推算）' : ''}` : '';
              const totalAmtTxt = f.totalAmount != null ? `${fmtAmt(f.totalAmount)}${f.totalAmountEstimated ? '（以權重推算）' : ''}` : '';
              const sharesTxt = f.shares != null ? `${f.shares.toLocaleString()} 股` : '（無股數資料）';
              return `
              <tr style="border-bottom:1px solid var(--border);">
                <td style="padding:8px 10px; font-weight:600; color:var(--text);">${escapeHtml(f.etfName)} (${escapeHtml(f.etfCode)})</td>
                <td style="padding:8px 10px;"><span class="badge ${badgeClass}">${escapeHtml(f.action)}</span></td>
                <td style="padding:8px 10px; text-align:right; font-weight:700; color:${colorStyle};">
                  <div>${changeSharesTxt}</div>
                  <div style="font-size:10px; font-weight:normal; opacity:.7; color:${amtColor};">${changeAmtTxt}</div>
                </td>
                <td style="padding:8px 10px; text-align:right; color:${wtColor};">${changeWeightTxt}</td>
                <td style="padding:8px 10px; text-align:right; color:var(--text2);">
                  <div>${sharesTxt}</div>
                  <div style="font-size:10px; opacity:.7;">${totalAmtTxt}</div>
                </td>
                <td style="padding:8px 10px; text-align:right; color:var(--text2);">${f.weight.toFixed(2)}%</td>
              </tr>
              `;
            }).join('')}
          </tbody>
        </table>
        <div class="src-note" style="margin-top:8px;">比對基準日：${escapeHtml(etfData.date)}，前一日：${escapeHtml(etfData.comparedTo || '無歷史資料')}</div>
      </div>`;
    }
  }

  el.innerHTML=`
  <div class="indicator-grid">
    <div class="ind-card"><div class="ind-title">📑 融資融券</div>
      ${m.error?`<div class="error-box">⚠ 暫無資料：${escapeHtml(m.error)}</div>`:`
      <div class="ind-row"><span class="ind-name">融資今日餘額</span><span class="ind-val">${fmtField(m.marginBalance,num)}</span></div>
      <div class="ind-row"><span class="ind-name">融資使用率</span><span class="ind-val">${fmtField(m.marginUsageRate,pct)}</span></div>
      <div class="ind-row"><span class="ind-name">融券今日餘額</span><span class="ind-val">${fmtField(m.shortBalance,num)}</span></div>
      <div class="ind-row"><span class="ind-name">券資比</span><span class="ind-val">${fmtField(m.shortToMarginRatio,pct)}</span></div>`}
    </div>
    <div class="ind-card"><div class="ind-title">👥 大戶持股結構</div>
      ${h.error?`<div class="error-box">⚠ 暫無資料：${escapeHtml(h.error)}</div>`:`
      <div class="ind-row"><span class="ind-name">千張大戶佔比</span><span class="ind-val">${fmtField(h.bigHolderPct,v=>v.toFixed(2)+'%')}</span></div>
      <div class="ind-row"><span class="ind-name">中實戶佔比</span><span class="ind-val">${fmtField(h.midHolderPct,v=>v.toFixed(2)+'%')}</span></div>
      <div class="ind-row"><span class="ind-name">同產業大戶佔比平均</span><span class="ind-val ${(h.industryAvgPct?.value!=null&&h.bigHolderPct?.value!=null)?(h.bigHolderPct.value>h.industryAvgPct.value?'up':h.bigHolderPct.value<h.industryAvgPct.value?'down':''):''}">${fmtField(h.industryAvgPct,v=>v.toFixed(2)+'%')}</span></div>
      <div class="ind-row"><span class="ind-name">週變化（千張大戶）</span><span class="ind-val">${fmtField(h.weeklyChange,v=>(v>=0?'+':'')+v.toFixed(2)+'%')}</span></div>
      <div class="src-note" style="margin-top:6px">集保股權分散表每週五更新一次，其餘平日資料不變。</div>`}
    </div>
    <div class="ind-card"><div class="ind-title">🏦 三大法人買賣超（${inst.period||'近5日'}）</div>
      ${inst.error?`<div class="error-box">⚠ 暫無資料：${escapeHtml(inst.error)}</div>`:`
      <div class="ind-row"><span class="ind-name">外資買賣超</span><span class="ind-val ${inst.foreignNet5d?.value>0?'up':inst.foreignNet5d?.value<0?'down':''}">${fmtField(inst.foreignNet5d,num)}</span></div>
      <div class="ind-row"><span class="ind-name">投信買賣超</span><span class="ind-val ${inst.trustNet5d?.value>0?'up':inst.trustNet5d?.value<0?'down':''}">${fmtField(inst.trustNet5d,num)}</span></div>
      <div class="ind-row"><span class="ind-name">自營商買賣超</span><span class="ind-val">${fmtField(inst.dealerNet5d,num)}</span></div>
      <div class="ind-row"><span class="ind-name">外資連續買/賣超天數</span><span class="ind-val">${fmtField(inst.foreignConsecutiveDays,v=>Math.abs(v)+'天'+(v>0?'買超':v<0?'賣超':''))}</span></div>`}
    </div>
    ${etfHtml}
  </div>
  <div class="disclaimer">⚠ 籌碼面資料僅供參考，不構成投資建議。資料來源：TWSE 台灣證券交易所、TDCC 台灣集中保管結算所。</div>`;
}

// 台灣的融資融券／集保股權分散／三大法人是 TWSE/TDCC 特有的規範，美股沒有每日對應的東西——最接近的
//官方揭露是 SEC 13F（機構持股，季報）與 Form 4（內部人買賣，近即時），兩者都透過 FMP 取得。
function isTaiwanSymbol(symbol){
  return /^\d{4,6}[A-Z]?(\.(TW|TWO))?$/i.test(symbol) || /\.(TW|TWO)$/i.test(symbol);
}

async function fetchChipUS(symbol){
  let url=`/api/chip-us?symbol=${encodeURIComponent(symbol)}`;
  if(fmpKey) url+=`&fmpKey=${encodeURIComponent(fmpKey)}`;
  const res=await fetch(url);
  const body=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(body?.error||'籌碼面資料取得失敗');
  return body;
}

async function fetchActiveEtfFlow(symbol){
  const res=await fetch(`/api/active-etf-flow?symbol=${encodeURIComponent(symbol)}`);
  if(!res.ok) return null;
  return await res.json().catch(()=>null);
}

function renderChipUS(data){
  const el=document.getElementById('chipContent');
  const ins=data.insider||{};
  const num=v=>Number(v).toLocaleString();
  el.innerHTML=`
  <div class="indicator-grid">
    <div class="ind-card"><div class="ind-title">👤 內部人買賣（SEC Form 4）</div>
      ${ins.error?`<div class="error-box">⚠ 暫無資料：${escapeHtml(ins.error)}</div>`:`
      <div class="ind-row"><span class="ind-name">累計買進股數</span><span class="ind-val">${fmtField(ins.totalBought,num)}</span></div>
      <div class="ind-row"><span class="ind-name">累計賣出股數</span><span class="ind-val">${fmtField(ins.totalSold,num)}</span></div>
      <div class="ind-row"><span class="ind-name">淨買賣股數</span><span class="ind-val ${ins.netShares?.value>0?'up':ins.netShares?.value<0?'down':''}">${fmtField(ins.netShares,v=>(v>=0?'+':'')+num(v))}</span></div>
      ${ins.note?`<div class="src-note" style="margin-top:6px">${escapeHtml(ins.note)}</div>`:''}
      <div class="src-note" style="margin-top:6px">僅計入公開市場買賣（交易代碼P/S），不含選擇權履約、稅務代扣、股票獎勵歸屬等非交易性質的申報。內部人須於交易後2個營業日內申報，非每日加總。</div>`}
    </div>
  </div>
  <div class="disclaimer">⚠ 美股無台股融資融券／集保股權分散／三大法人的每日對應資料，此處以 SEC Form 4（內部人買賣申報）替代——機構持股（13F）需要付費資料服務才能彙整，故不提供。僅供參考，不構成投資建議。資料來源：SEC EDGAR 官方申報。</div>`;
}

// ---- 市場情緒（貪婪指數）----
function sentimentGaugeSVG(score,level){
  const clamped=Math.max(0,Math.min(100,score));
  const angle=Math.PI*(clamped/100);
  const cx=150,cy=140,r=100;
  const needleAngle=Math.PI-angle;
  const nx=(cx+r*0.85*Math.cos(needleAngle)).toFixed(1);
  const ny=(cy-r*0.85*Math.sin(needleAngle)).toFixed(1);
  return `<svg viewBox="0 0 300 170" width="100%" style="max-width:320px;display:block;margin:0 auto">
    <defs><linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#00e676"/><stop offset="25%" stop-color="#8bc34a"/>
      <stop offset="50%" stop-color="#9090a8"/><stop offset="75%" stop-color="#ffab00"/>
      <stop offset="100%" stop-color="#ff5252"/>
    </linearGradient></defs>
    <path d="M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}" stroke="url(#gaugeGrad)" stroke-width="18" fill="none" stroke-linecap="round"/>
    <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="var(--text)" stroke-width="3"/>
    <circle cx="${cx}" cy="${cy}" r="6" fill="var(--text)"/>
    <text x="${cx}" y="${cy+25}" text-anchor="middle" font-size="30" font-weight="700" fill="var(--text)">${score.toFixed(0)}</text>
    <text x="${cx}" y="${cy+45}" text-anchor="middle" font-size="13" fill="var(--text2)">${level||''}</text>
    <text x="${cx-r-10}" y="${cy+5}" text-anchor="end" font-size="9" fill="var(--text3)">極度恐懼</text>
    <text x="${cx+r+10}" y="${cy+5}" text-anchor="start" font-size="9" fill="var(--text3)">極度貪婪</text>
  </svg>`;
}

async function fetchSentiment(){
  const res=await fetch('/api/sentiment');
  const body=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(body?.error||'市場情緒指數取得失敗');
  return body;
}

// 依 sentiment.js 回傳的 format 決定原始值怎麼顯示（不同因子的原始值單位不一樣，
// 不能全部都當成 0~1 比例 ×100 處理，例如 VIXTWN 是指數值、信用利差是百分點差值）。
function formatSentimentRawValue(v,format){
  if(v==null) return 'N/A';
  switch(format){
    case 'ratio': return (v*100).toFixed(2)+'%';
    case 'percent': return v.toFixed(2)+'%';
    case 'index': return v.toFixed(2);
    case 'percent_points': return (v>=0?'+':'')+v.toFixed(3)+' 個百分點';
    default: return String(v);
  }
}

function renderSentiment(data){
  const el=document.getElementById('sentimentContent');
  const gaugeHtml=data.greedIndex!=null
    ?sentimentGaugeSVG(data.greedIndex,data.level)
    :`<div class="info-box">${data.maturityMessage||'資料累積中'}</div>`;
  const statusNote=s=>s==='accumulating'?'（資料累積中）':s==='no_data'?'（暫無資料）':'';
  const rows=(data.indicators||[]).map(ind=>{
    const scoreText=ind.status==='ready'?ind.percentileScore.toFixed(1):'--';
    const rawText=formatSentimentRawValue(ind.rawValue,ind.format);
    return `<div class="ind-card">
      <div class="ind-title">${ind.label}${statusNote(ind.status)}</div>
      <div class="ind-row"><span class="ind-name">百分位分數</span><span class="ind-val">${scoreText}</span></div>
      <div class="ind-row"><span class="ind-name">原始值</span><span class="ind-val">${rawText}</span></div>
      <div class="ind-row"><span class="ind-name">資料成熟度</span><span class="ind-val">${ind.maturity}</span></div>
      <div class="src-note">來源：${ind.source}｜${ind.direction||''}${ind.date?'｜'+ind.date:''}</div>
    </div>`;
  }).join('');
  const updatedNote=data.latestDate?`資料日期：${data.latestDate}${data.latestUpdatedAt?`（台北時間 ${data.latestUpdatedAt} 更新）`:''}`:'';
  el.innerHTML=`
  <div class="chart-card" style="text-align:center">
    <div class="chart-title-bar">台股情緒指數（0-100）</div>
    ${gaugeHtml}
    ${data.readyCount!=null?`<div style="font-size:12px;color:var(--text2);margin-top:8px">共 ${data.readyCount}/${data.totalIndicators} 項指標計入本次計算</div>`:''}
    ${updatedNote?`<div style="font-size:11px;color:var(--text3);margin-top:4px">${updatedNote}</div>`:''}
  </div>
  <div class="indicator-grid" style="margin-top:16px">${rows}</div>
  <div class="disclaimer">⚠ 本指數為自製近似指標，方法論參考 CNN Fear & Greed Index，非官方標準，僅供參考。${data.methodology||''}</div>`;
}

// ---- AI 綜合摘要（技術面＋基本面＋籌碼面＋市場情緒）----
function buildSummaryData(info,techSummary,chipData,sentimentData,data){
  const fundamental={
    本益比:typeof info.trailingPE==='number'?info.trailingPE.toFixed(1):null,
    預估本益比:typeof info.forwardPE==='number'?info.forwardPE.toFixed(1):null,
    股價淨值比:typeof info.priceToBook==='number'?info.priceToBook.toFixed(2):null,
    殖利率:typeof info.dividendYield==='number'?(info.dividendYield*100).toFixed(2)+'%':null,
    毛利率:typeof info.grossMargins==='number'?(info.grossMargins*100).toFixed(1)+'%':null,
    營業利益率:typeof info.operatingMargins==='number'?(info.operatingMargins*100).toFixed(1)+'%':null,
    產業:info.sector||null,
  };
  const fundamentalInsufficient=Object.values(fundamental).every(v=>v==null);

  let chip=null,chipInsufficient=true;
  if(chipData){
    if('insider' in chipData){
      // US shape (chip-us.js): SEC Form 4 insider trading only — 13F institutional ownership was
      // dropped, it needs a paid data service (FMP gates it behind a ~$149/mo tier) to aggregate.
      const ins=chipData.insider||{};
      chip={
        內部人累計買進股數:!ins.error&&ins.totalBought?.value!=null?ins.totalBought.value.toLocaleString():null,
        內部人累計賣出股數:!ins.error&&ins.totalSold?.value!=null?ins.totalSold.value.toLocaleString():null,
        內部人淨買賣股數:!ins.error&&ins.netShares?.value!=null?ins.netShares.value.toLocaleString():null,
      };
    } else {
      // TW shape (chip.js): 融資融券／集保股權分散／三大法人
      const m=chipData.margin||{},h=chipData.holders||{},inst=chipData.institutional||{};
      chip={
        融資使用率:!m.error&&m.marginUsageRate?.value!=null?(m.marginUsageRate.value*100).toFixed(2)+'%':null,
        券資比:!m.error&&m.shortToMarginRatio?.value!=null?(m.shortToMarginRatio.value*100).toFixed(2)+'%':null,
        千張大戶佔比:!h.error&&h.bigHolderPct?.value!=null?h.bigHolderPct.value.toFixed(2)+'%':null,
        大戶持股週變化:!h.error&&h.weeklyChange?.value!=null?h.weeklyChange.value.toFixed(2)+'%':null,
        外資近5日買賣超:!inst.error&&inst.foreignNet5d?.value!=null?inst.foreignNet5d.value.toLocaleString():null,
        投信近5日買賣超:!inst.error&&inst.trustNet5d?.value!=null?inst.trustNet5d.value.toLocaleString():null,
      };
    }
    chipInsufficient=Object.values(chip).every(v=>v==null);
  }

  let sentiment=null,sentimentInsufficient=true;
  if(sentimentData){
    sentiment={
      貪婪指數:sentimentData.greedIndex!=null?sentimentData.greedIndex.toFixed(1):null,
      分級:sentimentData.level||null,
      資料成熟度:sentimentData.readyCount!=null?`${sentimentData.readyCount}/${sentimentData.totalIndicators} 項指標可用`:null,
    };
    sentimentInsufficient=sentimentData.greedIndex==null;
  }

  let technical=null,technicalInsufficient=true;
  if(data&&data.length>0){
    try{
      const sigs=calcTechSignals(data,info);
      technical={
        整體技術訊號:sigs.oSig,
        訊號解讀:sigs.oSub,
        均線排列:sigs.sig.ma==='BUY'?'多頭排列':'空頭排列',
        MACD狀態:sigs.sig.macd==='BUY'?'黃金交叉':'死亡交叉',
        'RSI (14)':sigs.lRSI?sigs.lRSI.toFixed(1):'N/A',
        'KD (9,3,3)':sigs.lK&&sigs.lD?`${sigs.lK.toFixed(1)} / ${sigs.lD.toFixed(1)}`:'N/A',
      };
      technicalInsufficient=false;
    }catch{}
  }
  if(technicalInsufficient&&techSummary){
    technical={原始技術面摘要:techSummary};
    technicalInsufficient=false;
  }

  return{
    technical: technicalInsufficient?{insufficient:true}:technical,
    fundamental: fundamentalInsufficient?{insufficient:true}:fundamental,
    chip: chipInsufficient?{insufficient:true}:chip,
    sentiment: sentimentInsufficient?{insufficient:true,說明:sentimentData?.maturityMessage||null}:sentiment,
  };
}

function buildSummaryPrompt(symbol,companyName,summaryData){
  const system=`你是一位協助整理股票多面向數據的助手。根據使用者提供的技術面、基本面、籌碼面、市場情緒面的數據，
用繁體中文寫一份 4 段的摘要，每段對應一個面向，只描述「數據呈現什麼現況」，例如：
「技術面：RSI 為 72，處於超買區間；MACD 呈現黃金交叉，短期動能偏強」

嚴格規則：
1. 絕對不要說「建議買進」「建議賣出」「現在是好的進場點」這類操作建議
2. 絕對不要給目標價、停損價等具體交易指令
3. 如果任一面向的物件包含 "insufficient": true，直接說明「此面向資料不足，暫無法判讀」，不要用其他面向的資料去補推測
4. 最後加一段：「以上僅為數據現況整理，不構成投資建議，請自行判斷或諮詢專業意見」
5. 四個面向之間如果出現矛盾訊號（例如技術面偏多但籌碼面顯示融資異常增加），要明確點出這個矛盾，不要為了寫出「一致的結論」而選擇性忽略某一面向的數據
6. 不要引用或推測使用者提供的 JSON 中沒有出現的具體數字（例如未提供的財報數字、新聞事件），只根據實際提供的資料描述
7. 請用繁體中文回答，格式使用 HTML（<h3><ul><li><p><strong>標籤），不要包含 any markdown or code blocks`;

  const user=`分析對象：${companyName}（${symbol}）

資料（JSON，"insufficient": true 代表該面向資料不足）：
${JSON.stringify(summaryData,null,2)}`;

  return {system,user};
}

// Renders a {label: value|null} object as label/value rows (same visual language as the chip
// panel), instead of a raw JSON dump — this data exists so a user can double-check the AI summary
// against the real numbers, which only works if a non-technical reader can actually read it.
function renderKeyValueRows(obj){
  return Object.entries(obj).map(([k,v])=> {
    let extraStyle = '';
    if (k === '整體技術訊號' || k === '分級') {
      if (v === '偏多訊號' || v === '超賣機會' || v === '極度恐慌' || v === '恐慌') {
        extraStyle = 'style="color:var(--green);font-weight:bold"';
      } else if (v === '偏高警示' || v === '偏空訊號' || v === '極度貪婪' || v === '貪婪') {
        extraStyle = 'style="color:var(--red);font-weight:bold"';
      } else if (v === '中性觀望' || v === '中性') {
        extraStyle = 'style="color:var(--amber);font-weight:bold"';
      }
    }
    return `<div class="ind-row"><span class="ind-name">${escapeHtml(k)}</span><span ${extraStyle} class="ind-val">${v==null?'<span style="color:var(--text3)">暫無資料</span>':escapeHtml(String(v))}</span></div>`;
  }).join('');
}
function renderSummaryRawData(summaryData){
  const section=(title,data)=>{
    if(data.insufficient){
      return `<div class="ind-card"><div class="ind-title">${title}</div><div style="color:var(--text3);font-size:13px;padding:6px 0">資料不足${data.說明?'：'+escapeHtml(data.說明):''}</div></div>`;
    }
    if('原始技術面摘要' in data){
      return `<div class="ind-card"><div class="ind-title">${title}</div><div style="font-size:13px;line-height:1.8;white-space:pre-wrap;color:var(--text2)">${escapeHtml(data.原始技術面摘要)}</div></div>`;
    }
    return `<div class="ind-card"><div class="ind-title">${title}</div>${renderKeyValueRows(data)}</div>`;
  };
  return `<div class="indicator-grid">
    ${section('📈 技術面',summaryData.technical)}
    ${section('🏢 基本面',summaryData.fundamental)}
    ${section('💰 籌碼面',summaryData.chip)}
    ${section('📊 市場情緒',summaryData.sentiment)}
  </div>`;
}
async function runSummaryAnalysis(symbol,companyName,techSummary,chipData,sentimentData,info,gen,data){
  const summaryData=buildSummaryData(info,techSummary,chipData,sentimentData,data);
  const {system,user}=buildSummaryPrompt(symbol,companyName,summaryData);
  if(apiKey){
    await streamGemini({system,prompt:user,model:selectedModel},'summaryContent','🧭 四面向綜合摘要',false,0,gen);
  }else{
    const needsKey='<div class="info-box">⚠️ 尚未設定 Gemini API Key，無法產生 AI 綜合摘要。請點上方「🔑 使用自己的 API Key」進行設定。</div>';
    document.getElementById('summaryContent').innerHTML=needsKey;
  }
  if(gen!=null&&gen!==analyzeGeneration) return;
  const rawEl=document.createElement('div');
  rawEl.className='fund-card';
  rawEl.innerHTML=`<div class="fund-card-title">📎 原始數據（供核對與參考）</div><div class="fund-content">${renderSummaryRawData(summaryData)}</div>`;
  document.getElementById('summaryContent').appendChild(rawEl);
}

function persistSet(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} }
function persistGet(k,def){ try{ const raw=localStorage.getItem(k); return raw?JSON.parse(raw):def; }catch{return def;} }
function loadPersistedSettings(){
  const savedSymbol=persistGet('elan_last_symbol','');
  const savedPeriod=persistGet('elan_last_period','3mo');
  const savedInterval=persistGet('elan_last_interval','1d');
  const savedApiKey=persistGet('elan_gemini_key','');
  const savedFmpKey=persistGet('elan_fmp_key','');
  if(savedApiKey){ apiKey=savedApiKey; document.getElementById('keyStatus').textContent='✓ 已設定'; document.getElementById('keyStatus').className='key-status key-set'; }
  if(savedFmpKey){ fmpKey=savedFmpKey; document.getElementById('fmpStatus').textContent='✓ 已設定'; document.getElementById('fmpStatus').className='key-status key-set'; }
  if(savedSymbol){ document.getElementById('symbolInput').value=savedSymbol; currentSymbol=savedSymbol; }
  if(savedPeriod){ currentPeriod=savedPeriod;
    document.querySelectorAll('.period-row .btn-ghost').forEach(b=>{
      if(b.textContent.includes('3個月')&&savedPeriod==='3mo')b.classList.add('active');
      else if(b.textContent.includes('6個月')&&savedPeriod==='6mo')b.classList.add('active');
      else if(b.textContent.includes('1年')&&savedPeriod==='1y')b.classList.add('active');
      else if(b.textContent.includes('2年')&&savedPeriod==='2y')b.classList.add('active');
      else b.classList.remove('active');
    });
  }
  if(savedInterval){ currentInterval=savedInterval;
    document.querySelectorAll('.interval-row .btn-ghost').forEach(b=>{
      if(b.textContent.includes('日線')&&savedInterval==='1d')b.classList.add('active');
      else if(b.textContent.includes('週線')&&savedInterval==='1wk')b.classList.add('active');
      else b.classList.remove('active');
    });
  }
}
loadPersistedSettings();
function copyTechConclusion(){
  const el=document.getElementById('techConclusionBox');
  if(!el){ alert('尚無技術面結論可複製'); return; }
  const txt=el.innerText||el.textContent||'';
  navigator.clipboard?.writeText(txt).then(()=>alert('技術面結論已複製到剪貼簿'),()=>alert('複製失敗'));
}
function downloadReport(){
  const main=document.getElementById('mainReport');
  if(!main||!currentSymbol){ alert('請先完成分析後再下載'); return; }
  const html='<!doctype html><html><head><meta charset="utf-8"><title>le cap 報告 - '+currentSymbol+'</title></head><body style="background:#0f0f14;color:#e8e8f0;font-family:Arial,Helvetica,sans-serif;padding:20px">'+main.innerHTML+'</body></html>';
  const blob=new Blob([html],{type:'text/html'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=(currentSymbol||'le-cap-report')+'.html';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
document.getElementById('symbolInput').addEventListener('keydown',e=>{if(e.key==='Enter')analyze();});

async function loadActiveEtfRankings() {
  try {
    const res = await fetch('/api/active-etf-flow?t=' + Date.now());
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (!data || !data.rankings) return;
    const { date, rankings } = data;
    const buys = rankings.buys || [];
    const sells = rankings.sells || [];

    if (buys.length === 0 && sells.length === 0) return;

    const fmtAmt = v => {
      const abs = Math.abs(v);
      if (abs >= 1e8) return (v / 1e8).toFixed(2) + ' 億元';
      if (abs >= 1e4) return (v / 1e4).toFixed(0) + ' 萬元';
      return v.toLocaleString() + ' 元';
    };

    document.getElementById('activeEtfRankingsDate').textContent = date ? `更新日期：${date}` : '';
    
    const buysHtml = buys.map(b => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding: 4px 0; border-bottom: 1px dashed var(--border);">
        <span style="font-weight:600; cursor:pointer; color:var(--text);" onclick="quickLoad('${escapeHtml(b.stock_code)}')">${escapeHtml(b.stock_code)} <span style="font-size:11px;font-weight:normal;color:var(--text3);margin-left:4px;">${escapeHtml(b.stock_name || '')}</span></span>
        <span class="up" style="font-weight:700;">${b.estimated ? '≈' : ''}+${fmtAmt(b.changeAmount)}</span>
      </div>
    `).join('') || '<div style="color:var(--text3); text-align:center;">今日尚無買超記錄</div>';

    const sellsHtml = sells.map(s => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding: 4px 0; border-bottom: 1px dashed var(--border);">
        <span style="font-weight:600; cursor:pointer; color:var(--text);" onclick="quickLoad('${escapeHtml(s.stock_code)}')">${escapeHtml(s.stock_code)} <span style="font-size:11px;font-weight:normal;color:var(--text3);margin-left:4px;">${escapeHtml(s.stock_name || '')}</span></span>
        <span class="down" style="font-weight:700;">${s.estimated ? '≈' : ''}${fmtAmt(s.changeAmount)}</span>
      </div>
    `).join('') || '<div style="color:var(--text3); text-align:center;">今日尚無賣超記錄</div>';

    document.getElementById('activeEtfTopBuys').innerHTML = buysHtml;
    document.getElementById('activeEtfTopSells').innerHTML = sellsHtml;
    document.getElementById('activeEtfRankings').style.display = 'block';
  } catch (e) {
    console.error('Failed to load active ETF rankings:', e);
  }
}
loadActiveEtfRankings();

// 台股大盤三大法人買賣超排行——跟上面 loadActiveEtfRankings() 是完全不同的資料（TWSE T86
// 全市場申報，不是主動式 ETF 持股爬蟲），不要合併成同一個函式，避免以後又搞混這兩個「賣超前五名」。
async function loadMarketFlowRankings() {
  try {
    const res = await fetch('/api/market-flow?t=' + Date.now());
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (!data || data.error || (!data.buys?.length && !data.sells?.length)) return;
    const { date, buys, sells } = data;

    const fmtAmt = v => {
      const abs = Math.abs(v);
      if (abs >= 1e8) return (v / 1e8).toFixed(2) + ' 億元';
      if (abs >= 1e4) return (v / 1e4).toFixed(0) + ' 萬元';
      return v.toLocaleString() + ' 元';
    };

    document.getElementById('marketFlowRankingsDate').textContent = date ? `更新日期：${date}` : '';

    const buysHtml = (buys || []).map(b => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding: 4px 0; border-bottom: 1px dashed var(--border);">
        <span style="font-weight:600; cursor:pointer; color:var(--text);" onclick="quickLoad('${escapeHtml(b.code)}')">${escapeHtml(b.code)} <span style="font-size:11px;font-weight:normal;color:var(--text3);margin-left:4px;">${escapeHtml(b.name || '')}</span></span>
        <span class="up" style="font-weight:700;">+${fmtAmt(b.netAmount)}</span>
      </div>
    `).join('') || '<div style="color:var(--text3); text-align:center;">今日尚無買超記錄</div>';

    const sellsHtml = (sells || []).map(s => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding: 4px 0; border-bottom: 1px dashed var(--border);">
        <span style="font-weight:600; cursor:pointer; color:var(--text);" onclick="quickLoad('${escapeHtml(s.code)}')">${escapeHtml(s.code)} <span style="font-size:11px;font-weight:normal;color:var(--text3);margin-left:4px;">${escapeHtml(s.name || '')}</span></span>
        <span class="down" style="font-weight:700;">${fmtAmt(s.netAmount)}</span>
      </div>
    `).join('') || '<div style="color:var(--text3); text-align:center;">今日尚無賣超記錄</div>';

    document.getElementById('marketFlowTopBuys').innerHTML = buysHtml;
    document.getElementById('marketFlowTopSells').innerHTML = sellsHtml;
    document.getElementById('marketFlowRankings').style.display = 'block';
  } catch (e) {
    console.error('Failed to load market flow rankings:', e);
  }
}
loadMarketFlowRankings();

// 台股大盤融資維持率。低於 105% 是歷史上少見的極端低檔（一般行情約 150-200%），才會標示強烈買進提示。
async function loadMarginRatio() {
  try {
    const res = await fetch('/api/margin-ratio?t=' + Date.now());
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (!data || data.error || data.ratio == null) return;

    document.getElementById('marginRatioValue').textContent = data.ratio.toFixed(2) + '%';
    document.getElementById('marginRatioDate').textContent = data.date ? `更新日期：${data.date}` : '';
    const badgeEl = document.getElementById('marginRatioBadge');
    badgeEl.innerHTML = data.ratio < 105
      ? `<span class="badge badge-red" style="font-size:12px;">🔥 強烈買進</span>`
      : '';
    document.getElementById('marginRatioCard').style.display = 'block';
  } catch (e) {
    console.error('Failed to load margin ratio:', e);
  }
}
loadMarginRatio();

// 首頁市場情緒量表。跟「市場情緒」分頁共用 sentimentGaugeSVG()／fetchSentiment()，只是精簡呈現：
// 量表 + 計入指標數 + 資料來源清單（去重）+ 資料日期。跟其他首頁小工具一致，資料還沒成熟
// （greedIndex 算不出來，通常是全新部署剛開始累積歷史）時就先不顯示，不占首頁版面顯示「資料累積中」。
async function loadHomepageSentiment() {
  try {
    const data = await fetchSentiment();
    if (!data || data.error || data.greedIndex == null) return;

    document.getElementById('homepageSentimentGauge').innerHTML = sentimentGaugeSVG(data.greedIndex, data.level);
    document.getElementById('homepageSentimentReady').textContent =
      data.readyCount != null ? `共 ${data.readyCount}/${data.totalIndicators} 項指標計入本次計算` : '';

    const sources = [...new Set((data.indicators || []).filter(i => i.status === 'ready').map(i => i.source))];
    document.getElementById('homepageSentimentSources').textContent = sources.length ? `資料來源：${sources.join('、')}` : '';
    document.getElementById('homepageSentimentDate').textContent = data.latestDate
      ? `資料日期：${data.latestDate}${data.latestUpdatedAt ? `（台北時間 ${data.latestUpdatedAt} 更新）` : ''}`
      : '';

    document.getElementById('homepageSentimentCard').style.display = 'block';
  } catch (e) {
    console.error('Failed to load homepage sentiment:', e);
  }
}
loadHomepageSentiment();

// RSI超賣/超買＋成交量暴增篩選器。結果由worker-cron每天算好存D1，這裡單純讀最新一天，
// 不在前端重算。剛部署時volume欄位歷史還沒累積滿5個交易日，兩邊都會是空清單，此時直接
// 不顯示這格（跟其他首頁小工具一致，不占版面顯示「資料累積中」）；若只有一邊有資料，
// 另一邊顯示「今日尚無OO訊號」小提示，做法跟loadActiveEtfRankings/loadMarketFlowRankings
// 的買超/賣超兩欄一致，不是新發明的模式。
function screenerRowHtml(s) {
  return `
    <div style="display:flex; justify-content:space-between; align-items:center; padding: 4px 0; border-bottom: 1px dashed var(--border);">
      <span style="font-weight:600; cursor:pointer; color:var(--text);" onclick="quickLoad('${escapeHtml(s.code)}')">${escapeHtml(s.code)} <span style="font-size:11px;font-weight:normal;color:var(--text3);margin-left:4px;">${escapeHtml(s.name || '')}</span></span>
      <span style="display:flex; gap:10px; font-size:11px; color:var(--text2);">
        <span>RSI ${s.rsi != null ? s.rsi.toFixed(1) : '-'}</span>
        <span class="down" style="font-weight:700;">量 ${s.volumeRatio != null ? s.volumeRatio.toFixed(1) : '-'}x</span>
      </span>
    </div>
  `;
}

async function loadOversoldVolumeScreener() {
  try {
    const res = await fetch('/api/screener?t=' + Date.now());
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (!data || data.error) return;
    const oversold = data.oversold || [];
    const overbought = data.overbought || [];
    if (oversold.length === 0 && overbought.length === 0) return;

    document.getElementById('oversoldVolumeScreenerDate').textContent = data.date ? `更新日期：${data.date}` : '';

    document.getElementById('oversoldVolumeScreenerList').innerHTML =
      oversold.map(screenerRowHtml).join('') || '<div style="color:var(--text3); text-align:center;">今日尚無超賣訊號</div>';
    document.getElementById('overboughtVolumeScreenerList').innerHTML =
      overbought.map(screenerRowHtml).join('') || '<div style="color:var(--text3); text-align:center;">今日尚無超買訊號</div>';

    document.getElementById('oversoldVolumeScreenerCard').style.display = 'block';
  } catch (e) {
    console.error('Failed to load oversold/overbought volume screener:', e);
  }
}
loadOversoldVolumeScreener();

// ─────────────────────────────────────────────
// 首頁大盤即時報價看板
// ─────────────────────────────────────────────
let marketLiveTimer = null;

function fmtIndex(v, decimals = 2) {
  if (v == null || !isFinite(v)) return '—';
  return v.toLocaleString('zh-TW', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function renderMarketCard(d, shortLabel) {
  if (!d) return `<div class="ind-card" style="padding:12px 14px;background:var(--bg3);opacity:.4;font-size:12px;color:var(--text3);text-align:center;">無資料</div>`;
  const isUp = d.change >= 0;
  const color = isUp ? 'var(--red)' : 'var(--green)';
  const arrow = isUp ? '▲' : '▼';
  const changePctStr = d.changePct != null ? `${Math.abs(d.changePct).toFixed(2)}%` : '';
  const changeStr = `${arrow} ${fmtIndex(Math.abs(d.change))} (${changePctStr})`;
  const timeStr = d.time ? `<div style="font-size:9px;color:var(--text3);margin-top:2px;">${d.date ? d.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1/$2/$3') + ' ' : ''}${d.time}</div>` : '';
  const highLow = (d.high && d.low) ? `<div style="font-size:9px;color:var(--text3);margin-top:3px;">H:${fmtIndex(d.high)} L:${fmtIndex(d.low)}</div>` : '';
  return `
    <div class="ind-card" style="padding:12px 14px;background:var(--bg3);">
      <div style="font-size:10px;color:var(--text3);font-weight:700;text-transform:uppercase;margin-bottom:4px;">${escapeHtml(shortLabel)}</div>
      <div style="font-size:20px;font-weight:700;color:var(--text);letter-spacing:-0.5px;">${fmtIndex(d.current)}</div>
      <div style="font-size:12px;font-weight:600;color:${color};margin-top:2px;">${changeStr}</div>
      ${timeStr}${highLow}
    </div>`;
}

// TWSE MIS（台指/櫃買）單次請求本來就有機率性失敗（見 functions/api/market-chart.js 的
// fetchTwseIndexOnce 註解），每 20 秒輪詢難免偶爾槓龜。如果每次槓龜都把卡片整個清成「無資料」，
// 使用者盯著畫面時常常會看到指數閃爍消失——比真的抓不到資料更擾民。改成：這次抓不到就沿用
// 上一次成功抓到的值繼續顯示，不要因為單次失敗就把已經有的資料洗掉。
let lastGoodMarketData = {};

async function loadMarketLive() {
  const board = document.getElementById('marketLiveBoard');
  const timeEl = document.getElementById('marketLiveTime');
  try {
    const res = await fetch('/api/market-chart?t=' + Date.now());
    if (!res.ok) throw new Error('API error');
    const data = await res.json();

    const taiex = data.tw?.taiex || lastGoodMarketData.taiex;
    const otc = data.tw?.otc || lastGoodMarketData.otc;
    const spx = data.us?.spx || lastGoodMarketData.spx;
    const ndx = data.us?.ndx || lastGoodMarketData.ndx;
    const sox = data.us?.sox || lastGoodMarketData.sox;
    lastGoodMarketData = { taiex, otc, spx, ndx, sox };

    const cards = [
      renderMarketCard(taiex, '台指 TAIEX'),
      renderMarketCard(otc, '櫃買 OTC'),
      renderMarketCard(spx, 'S&P 500'),
      renderMarketCard(ndx, 'Nasdaq'),
      renderMarketCard(sox, '費半 SOX'),
    ].join('');

    if (board) board.innerHTML = cards;
    if (timeEl) {
      const now = new Date();
      timeEl.textContent = `更新：${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
    }
  } catch (e) {
    if (board) board.innerHTML = '<div style="color:var(--text3);font-size:12px;text-align:center;padding:20px;grid-column:1/-1;">資料載入失敗</div>';
    console.error('Market live error:', e);
  }
}

loadMarketLive();
// 每 20 秒自動更新（僅首頁顯示時）
marketLiveTimer = setInterval(() => {
  if (document.getElementById('marketLiveSection')) loadMarketLive();
}, 20000);


