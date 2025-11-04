import fetch from "node-fetch";

const BASE_URL = "https://api.backpack.exchange/api/v1";
const UPDATE_INTERVAL = 180000; // 3 minutos
const MAX_CONCURRENT = 5;
let cache = { ts: 0, data: [] };

// === Funções Auxiliares ===
const mean = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
const std = arr => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s,x)=>s+(x-m)**2,0)/(arr.length-1));
};

const computeATR = (highs, lows, closes, period=14) => {
  if (closes.length < 2) return 0;
  const trs=[];
  for(let i=1;i<highs.length;i++){
    const tr=Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1]));
    trs.push(tr);
  }
  return mean(trs.slice(-period));
};

const computeRSI = (closes, period=9) => {
  if (closes.length <= period) return 50;
  const deltas=closes.slice(1).map((c,i)=>c-closes[i]);
  const gains=deltas.map(d=>d>0?d:0);
  const losses=deltas.map(d=>d<0?Math.abs(d):0);
  const avgGain=mean(gains.slice(-period));
  const avgLoss=mean(losses.slice(-period))||1e-9;
  const rs=avgGain/avgLoss;
  return 100-100/(1+rs);
};

const computeBollinger = (closes, period=20, mult=2) => {
  if (!closes.length) return {middle:0,width:0};
  const slice=closes.slice(-period);
  const m=mean(slice);
  const s=std(slice);
  return {middle:m,width:(2*mult*s)/(m||1)};
};

const computeEMA = (closes, period=20) => {
  if (closes.length<period) return mean(closes);
  const k=2/(period+1);
  let ema=closes[0];
  for(let i=1;i<closes.length;i++) ema=closes[i]*k+ema*(1-k);
  return ema;
};

// === Ajuste Dinâmico de Thresholds por Timeframe ===
function getThresholdsByTimeframe(tf){
  const map={"1m":1,"3m":3,"5m":5,"15m":15,"30m":30,"1h":60,"4h":240,"12h":720,"1d":1440};
  const mins=map[tf]||3;
  const scale=Math.log10(mins)/2+1;
  return {atrNeutral:0.005*scale,bbNeutral:0.01*scale};
}

const fetchKlines=async(symbol,interval="3m",limit=100)=>{
  const intervalSec=interval.endsWith("m")?+interval.replace("m","")*60:interval.endsWith("h")?+interval.replace("h","")*3600:180;
  try{
    const nowSec=Math.floor(Date.now()/1000);
    const startSec=nowSec-limit*intervalSec;
    const url=`${BASE_URL}/klines?symbol=${symbol}&interval=${interval}&startTime=${startSec}&endTime=${nowSec}&limit=${limit}`;
    const resp=await fetch(url);
    if(resp.ok){
      const data=await resp.json();
      if(Array.isArray(data)&&data.length>0)
        return data.map(c=>({open:+c.open,high:+c.high,low:+c.low,close:+c.close,volume:+c.volume,ts:+c.openTime}));
    }
  }catch(e){console.log(`⚠️ klines falhou ${symbol}: ${e.message}`);}
  return [];
};

// === Handler Principal ===
export default async function handler(req,res){
  try{
    const now=Date.now();
    const tf=req.query.tf||"3m";
    const th=getThresholdsByTimeframe(tf);
    console.log(`[INFO] /api/data chamado com timeframe=${tf}`);

    if(now-cache.ts<UPDATE_INTERVAL&&cache.data.length>0)
      return res.status(200).json(cache.data);

    const [marketsResp,oiResp]=await Promise.all([
      fetch(`${BASE_URL}/markets`),
      fetch(`${BASE_URL}/openInterest`)
    ]);

    const markets=(await marketsResp.json())||[];
    const oiData=(await oiResp.json())||[];
    const perpMarkets=markets.filter(m=>m.symbol.endsWith("_PERP"));
    const oiMap={}; oiData.forEach(o=>oiMap[o.symbol]=o);

    const results=[],active=[];
    for(const m of perpMarkets){
      const run=async()=>{
        let lastPrice=0,volumeUSD=0,oiUSD=0,atrRel=0,rsi=0,bbWidth=0,ema20=0;
        let decision="aguardando",score=0,isNew=false;
        try{
          const tickerResp=await fetch(`${BASE_URL}/ticker?symbol=${m.symbol}`);
          const ticker=tickerResp.ok?await tickerResp.json():{};
          lastPrice=+ticker.lastPrice||0;
          volumeUSD=(+ticker.volume||0)*lastPrice;
          oiUSD=((oiMap[m.symbol]?.openInterest)||0)*lastPrice;

          const kl=await fetchKlines(m.symbol,tf,100);
          if(kl.length>0){
            const closes=kl.map(k=>k.close).filter(v=>v>0);
            const highs=kl.map(k=>k.high).filter(v=>v>0);
            const lows=kl.map(k=>k.low).filter(v=>v>0);

            if(closes.length>=10){
              const atr=computeATR(highs,lows,closes);
              atrRel=lastPrice?atr/lastPrice:0;
              rsi=computeRSI(closes);
              bbWidth=computeBollinger(closes).width;
              ema20=computeEMA(closes);

              const valid=[atrRel,bbWidth,rsi].every(v=>typeof v==="number"&&!isNaN(v));

              if(valid){
                if(rsi<30&&lastPrice>ema20){decision="long";score=2;}
                else if(rsi>70&&lastPrice<ema20){decision="short";score=-2;}
                else if(atrRel<th.atrNeutral&&bbWidth<th.bbNeutral){decision="lateral";score=1;}
                else{decision="neutral";score=0;}
              }else{
                decision="aguardando";score=0;
              }
            }else{
              decision="aguardando";score=0;
            }
          }
        }catch(e){console.log(`⚠️ Erro ${m.symbol}: ${e.message}`);}

        // === Força decisão coerente antes de enviar ===
        if(
          !atrRel || !bbWidth || !rsi ||
          isNaN(atrRel) || isNaN(bbWidth) || isNaN(rsi)
        ){
          decision="aguardando";
          score=0;
        }

        // === Envia resultado final coerente ===
        results.push({
          symbol:m.symbol,
          visible:m.visible,
          orderBookState:m.orderBookState,
          lastPrice,
          atrRel:atrRel||null,
          rsi:rsi||null,
          bbWidth:bbWidth||null,
          ema20:ema20||null,
          volumeUSD,
          oiUSD,
          decision,
          score,
          isNew
        });
      };

      active.push(run());
      if(active.length>=MAX_CONCURRENT) await Promise.all(active.splice(0,MAX_CONCURRENT));
    }
    await Promise.all(active);
    cache={ts:now,data:results};
    res.status(200).json(results);
  }catch(e){
    console.error("Erro geral /api/data:",e.message);
    res.status(500).json({error:e.message});
  }
}
