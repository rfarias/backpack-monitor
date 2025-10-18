// === /api/data.js ===
// Calcula indicadores completos para todos os mercados perp (como o server original)

import axios from "axios";

let cache = [];
let lastUpdate = 0;
const UPDATE_INTERVAL = 30 * 1000;
const MAX_HISTORY = 100;

const ATR_PERIOD = 14;
const RSI_PERIOD = 9;
const BB_PERIOD = 20;
const BB_STD = 2;
const EMA_PERIOD = 20;
const SAFE_ATR_THRESHOLD = 0.01;
const BB_WIDTH_THRESHOLD = 0.01;
const MIN_CANDLE_VOL_USD = 100000;

const historyMap = {};

// === Helpers ===
function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function std(arr) { const m=mean(arr); return Math.sqrt(arr.reduce((s,x)=>s+(x-m)**2,0)/(arr.length||1)); }

function computeATR(highs,lows,closes,period=ATR_PERIOD){
  const trs=[];
  for(let i=1;i<highs.length;i++){
    trs.push(Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])));
  }
  return trs.length?mean(trs.slice(-period)):0;
}
function computeRSI(closes,period=RSI_PERIOD){
  if(closes.length<=period)return 50;
  const deltas=closes.slice(1).map((c,i)=>c-closes[i]);
  const gains=deltas.map(d=>d>0?d:0);
  const losses=deltas.map(d=>d<0?-d:0);
  const avgGain=mean(gains.slice(-period));
  const avgLoss=mean(losses.slice(-period))||1e-9;
  const rs=avgGain/avgLoss;
  return 100-100/(1+rs);
}
function computeBollinger(closes,period=BB_PERIOD,mult=BB_STD){
  if(closes.length<period){
    const sma=mean(closes),s=std(closes);
    return {width:(2*mult*s)/(sma||1)};
  }
  const slice=closes.slice(-period);
  const sma=mean(slice),s=std(slice);
  return {width:(2*mult*s)/(sma||1)};
}
function computeEMA(closes,period=EMA_PERIOD){
  if(closes.length<period)return mean(closes);
  const k=2/(period+1);
  return closes.slice(-period).reduce((ema,price)=>ema+k*(price-ema));
}
function decide({price,atrRel,rsi,bbWidth,ema20,volLastCandle}){
  if(atrRel<SAFE_ATR_THRESHOLD && bbWidth<=BB_WIDTH_THRESHOLD && volLastCandle>=MIN_CANDLE_VOL_USD){
    if(rsi<30 && price>ema20)return {decision:"long",score:2};
    if(rsi>70 && price<ema20)return {decision:"short",score:-2};
    return {decision:"lateral",score:1};
  }
  return {decision:"neutral",score:0};
}

// === Função principal ===
async function takeSnapshot(){
  try{
    const [oiResp,marketResp]=await Promise.all([
      axios.get("https://api.backpack.exchange/api/v1/openInterest"),
      axios.get("https://api.backpack.exchange/api/v1/markets")
    ]);
    const allMarkets=marketResp.data||[];
    const perp=allMarkets.filter(m=>m.symbol.endsWith("_PERP"));
    const oiMap={};
    oiResp.data.forEach(m=>oiMap[m.symbol]=m);
    const combined=[];

    for(const m of perp){
      try{
        const oiEntry=oiMap[m.symbol]||{};
        const tResp=await axios.get("https://api.backpack.exchange/api/v1/ticker",{params:{symbol:m.symbol}});
        const ticker=Array.isArray(tResp.data)?tResp.data[0]:tResp.data;
        const lastPrice=+ticker.lastPrice||0;
        let atrRel=0,rsi=0,bbWidth=0,ema20=0;
        let volLastCandle=0;

        // === klines corrigido ===
        let kl=[];
        if(lastPrice>0){
          const r1=await axios.get("https://api.backpack.exchange/api/v1/klines",{params:{symbol:m.symbol,interval:"3m",limit:100}});
          kl=r1.data;
          if(!Array.isArray(kl) || kl.length<10){
            const r2=await axios.get("https://api.backpack.exchange/api/v1/klines",{params:{symbol:m.symbol,interval:"5m",limit:100}});
            kl=r2.data;
          }
          if(Array.isArray(kl)&&kl.length>=2){
            const closes=kl.map(k=>+k.close);
            const highs=kl.map(k=>+k.high);
            const lows=kl.map(k=>+k.low);
            const atr=computeATR(highs,lows,closes);
            atrRel=lastPrice?atr/lastPrice:0;
            rsi=computeRSI(closes);
            const bb=computeBollinger(closes);
            bbWidth=bb.width;
            ema20=computeEMA(closes);
            volLastCandle=kl.length?+kl[kl.length-1].volume*lastPrice:0;
          }
        }

        const oiUSD=(+oiEntry.openInterest||0)*lastPrice;
        const volumeUSD=(+ticker.volume||0)*lastPrice;
        const liqOI=oiUSD?volumeUSD/oiUSD:0;
        const {decision,score}=lastPrice
          ? decide({price:lastPrice,atrRel,rsi,bbWidth,ema20,volLastCandle})
          : {decision:"aguardando",score:0};

        combined.push({
          symbol:m.symbol,
          lastPrice,
          atrRel,
          rsi,
          bbWidth,
          ema20,
          volumeUSD,
          oiUSD,
          liqOI,
          decision,
          score,
          ts:Date.now()
        });
      }catch(e){
        console.log("Erro em",m.symbol,e.message);
      }
    }

    // histórico (mesma lógica antiga)
    combined.forEach(item=>{
      if(!historyMap[item.symbol])historyMap[item.symbol]=[];
      historyMap[item.symbol].push(item);
      if(historyMap[item.symbol].length>MAX_HISTORY)historyMap[item.symbol].shift();
    });

    const sanitized=combined.map(item=>({
      ...item,
      lastPrice:+item.lastPrice||0,
      atrRel:+item.atrRel||0,
      rsi:+item.rsi||0,
      bbWidth:+item.bbWidth||0,
      ema20:+item.ema20||0,
      volumeUSD:+item.volumeUSD||0,
      oiUSD:+item.oiUSD||0,
      liqOI:+item.liqOI||0,
      score:+item.score||0,
      decision:item.decision||"aguardando"
    }));

    return sanitized.sort((a,b)=>b.oiUSD-a.oiUSD);
  }catch(e){
    console.log("snapshot error:",e.message);
    return [];
  }
}

// === Atualização e cache ===
async function updateData(){
  cache=await takeSnapshot();
  lastUpdate=Date.now();
}
setInterval(updateData,UPDATE_INTERVAL);
updateData();

// === Endpoint Vercel ===
export default async function handler(req,res){
  try{
    if(Date.now()-lastUpdate>UPDATE_INTERVAL*2)await updateData();
    res.status(200).json(cache||[]);
  }catch(e){
    console.log("Erro /api/data:",e.message);
    res.status(500).json([]);
  }
}
