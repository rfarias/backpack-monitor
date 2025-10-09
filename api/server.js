const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static(__dirname));

const PORT = 3000;

// parâmetros ajustados
const ATR_PERIOD = 14;
const RSI_PERIOD = 9;              // mais sensível
const BB_PERIOD = 20;
const BB_STD = 2;
const EMA_PERIOD = 20;             // EMA para direção
const SAFE_ATR_THRESHOLD = 0.01;   // ATR% máximo para lateral seguro
const BB_WIDTH_THRESHOLD = 0.01;   // BB Width máximo para consolidação
const MIN_CANDLE_VOL_USD = 100000; // volume mínimo por candle

// helpers
function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function std(arr) { if (arr.length < 2) return 0; const m=mean(arr); return Math.sqrt(arr.reduce((s,x)=>s+(x-m)**2,0)/(arr.length-1)); }

// indicadores
function computeATR(highs, lows, closes, period=ATR_PERIOD) {
  if (highs.length < 2) return 0;
  const trs=[];
  for (let i=1;i<highs.length;i++){
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  }
  return trs.length<period ? mean(trs) : mean(trs.slice(-period));
}
function computeRSI(closes, period=RSI_PERIOD){
  if (closes.length<=period) return 50;
  const deltas=closes.slice(1).map((c,i)=>c-closes[i]);
  const gains=deltas.map(d=>d>0?d:0);
  const losses=deltas.map(d=>d<0?Math.abs(d):0);
  const avgGain=mean(gains.slice(-period));
  const avgLoss=mean(losses.slice(-period))||1e-9;
  const rs=avgGain/avgLoss;
  return 100-(100/(1+rs));
}
function computeBollinger(closes, period=BB_PERIOD, mult=BB_STD){
  if (closes.length<period){
    const sma=mean(closes); const s=std(closes);
    return {middle:sma,upper:sma+mult*s,lower:sma-mult*s,width:(2*mult*s)/(sma||1)};
  }
  const slice=closes.slice(-period); const sma=mean(slice); const s=std(slice);
  return {middle:sma,upper:sma+mult*s,lower:sma-mult*s,width:(2*mult*s)/(sma||1)};
}
function computeEMA(closes, period=EMA_PERIOD){
  if (closes.length<period) return mean(closes);
  const k=2/(period+1);
  return closes.slice(-period).reduce((ema,price)=>ema+k*(price-ema));
}

// candles com fallback
async function fetchKlines(symbol, interval='3m', limit=200){
  const intervalSec=interval==='3m'?180:interval==='5m'?300:60;
  try{
    const nowSec=Math.floor(Date.now()/1000);
    const startSec=nowSec-limit*intervalSec;
    const resp=await axios.get("https://api.backpack.exchange/api/v1/klines",{params:{symbol,interval,startTime:startSec,endTime:nowSec}});
    if (resp.status===200 && Array.isArray(resp.data) && resp.data.length>0){
      const arr=resp.data.map(c=>({open:+c.open,high:+c.high,low:+c.low,close:+c.close,volume:+c.volume,ts:+c.openTime}));
      if (arr.length>=2){ console.log(`✅ klines ${symbol} ${arr.length}`); return arr; }
    }
  }catch(e){ console.log(`⚠️ klines falhou ${symbol}: ${e.message}`); }
  // fallback: trades
  try{
    const tResp=await axios.get("https://api.backpack.exchange/api/v1/trades",{params:{symbol,limit:limit*5}});
    const trades=tResp.data;
    const buckets={};
    trades.forEach(tr=>{
      const ts=Math.floor(tr.timestamp/1000);
      const bucket=Math.floor(ts/intervalSec)*intervalSec;
      const p=+tr.price,q=+tr.quantity;
      if (!buckets[bucket]) buckets[bucket]={open:null,high:-Infinity,low:Infinity,close:null,volume:0,ts:bucket};
      const b=buckets[bucket];
      if (b.open===null) b.open=p;
      b.high=Math.max(b.high,p); b.low=Math.min(b.low,p); b.close=p; b.volume+=q*p;
    });
    const candles=Object.values(buckets).filter(b=>b.open!==null).sort((a,b)=>a.ts-b.ts);
    console.log(`🟡 fallback trades ${symbol} ${candles.length}`);
    return candles;
  }catch(e){console.log(`❌ trades falhou ${symbol}: ${e.message}`); return [];}
}

// decisão refinada
function decide({price,atrRel,rsi,bb,ema20,volLastCandle}){
  if (atrRel < SAFE_ATR_THRESHOLD && bb.width <= BB_WIDTH_THRESHOLD && volLastCandle >= MIN_CANDLE_VOL_USD) {
    if (rsi < 30 && price > ema20) return {decision:"long",score:2};
    if (rsi > 70 && price < ema20) return {decision:"short",score:-2};
    return {decision:"lateral",score:1};
  }
  return {decision:"neutral",score:0};
}

// histórico
const historyMap={};
let isFetching=false;

async function takeSnapshot(){
  if (isFetching) return; isFetching=true;
  try{
    const oiResp=await axios.get("https://api.backpack.exchange/api/v1/openInterest");
    const perp=oiResp.data.filter(m=>m.symbol.endsWith("_PERP"));
    const combined=[];
    for (const m of perp){
      try{
        const tResp=await axios.get("https://api.backpack.exchange/api/v1/ticker",{params:{symbol:m.symbol}});
        const ticker=Array.isArray(tResp.data)?tResp.data[0]:tResp.data;
        const lastPrice=+ticker.lastPrice||0;
        let kl=await fetchKlines(m.symbol,"3m",200);
        if (kl.length<10) kl=await fetchKlines(m.symbol,"5m",200);
        const closes=kl.map(k=>k.close), highs=kl.map(k=>k.high), lows=kl.map(k=>k.low);
        const atr=computeATR(highs,lows,closes);
        const atrRel=lastPrice?atr/lastPrice:0;
        const rsi=computeRSI(closes);
        const bb=computeBollinger(closes);
        const ema20=computeEMA(closes);
        const volLastCandle=kl.length?kl[kl.length-1].volume*lastPrice:0;
        const oiUSD=(+m.openInterest||0)*lastPrice;
        const volumeUSD=(+ticker.volume||0)*lastPrice;
        const liqOI=oiUSD?volumeUSD/oiUSD:0;
        const {decision,score}=decide({price:lastPrice,atrRel,rsi,bb,ema20,volLastCandle});
        console.log(m.symbol,"ATR%",(atrRel*100).toFixed(2),"RSI",rsi.toFixed(1),"BBw",bb.width.toFixed(4),"EMA20",ema20.toFixed(2),"volLast",volLastCandle.toFixed(0),"→",decision,"score",score);
        combined.push({symbol:m.symbol,lastPrice,atrRel,rsi,bbWidth:bb.width,ema20,volumeUSD,oiUSD,liqOI,decision,score});
      }catch(e){console.log("erro",m.symbol,e.message);}
    }
    combined.forEach(item=>{
      if (!historyMap[item.symbol]) historyMap[item.symbol]=[];
      historyMap[item.symbol].push({...item,ts:Date.now()});
      if (historyMap[item.symbol].length>100) historyMap[item.symbol].shift();
    });
  }catch(e){console.log("snapshot error",e.message);}
  isFetching=false;
}

takeSnapshot();
setInterval(takeSnapshot,30*1000);

app.get("/api/data",(req,res)=>{
  const results=[];
  for (const sym of Object.keys(historyMap)){
    const arr=historyMap[sym]; if (!arr.length) continue;
    results.push(arr[arr.length-1]);
  }
  results.sort((a,b)=>b.liqOI-a.liqOI);
  res.json(results);
});

module.exports = app;

