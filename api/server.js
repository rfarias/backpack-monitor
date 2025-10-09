const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static(__dirname));

// parâmetros
const ATR_PERIOD = 14;
const RSI_PERIOD = 9;
const BB_PERIOD = 20;
const BB_STD = 2;
const EMA_PERIOD = 20;
const SAFE_ATR_THRESHOLD = 0.01;
const BB_WIDTH_THRESHOLD = 0.01;
const MIN_CANDLE_VOL_USD = 100000;
const MAX_CANDLES = 100; // histórico máximo necessário

// helpers
function mean(arr){ return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function std(arr){ if(arr.length<2) return 0; const m=mean(arr); return Math.sqrt(arr.reduce((s,x)=>s+(x-m)**2,0)/(arr.length-1)); }

// indicadores
function computeATR(highs,lows,closes,period=ATR_PERIOD){
  if(highs.length<2) return 0;
  const trs=[];
  for(let i=1;i<highs.length;i++){
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  }
  return trs.length<period ? mean(trs) : mean(trs.slice(-period));
}

function computeRSI(closes,period=RSI_PERIOD){
  if(closes.length<=period) return 50;
  const deltas=closes.slice(1).map((c,i)=>c-closes[i]);
  const gains=deltas.map(d=>d>0?d:0);
  const losses=deltas.map(d=>d<0?Math.abs(d):0);
  const avgGain=mean(gains.slice(-period));
  const avgLoss=mean(losses.slice(-period))||1e-9;
  const rs=avgGain/avgLoss;
  return 100-(100/(1+rs));
}

function computeBollinger(closes,period=BB_PERIOD,mult=BB_STD){
  const slice=closes.slice(-period);
  const sma=mean(slice);
  const s=std(slice);
  return {middle:sma,upper:sma+mult*s,lower:sma-mult*s,width:(2*mult*s)/(sma||1)};
}

function computeEMA(closes,period=EMA_PERIOD){
  if(closes.length<period) return mean(closes);
  let ema=closes[closes.length-period];
  const k=2/(period+1);
  for(let i=closes.length-period+1;i<closes.length;i++){
    ema = ema + k*(closes[i]-ema);
  }
  return ema;
}

// decisão
function decide({price,atrRel,rsi,bb,ema20,volLastCandle}){
  if(atrRel<SAFE_ATR_THRESHOLD && bb.width<=BB_WIDTH_THRESHOLD && volLastCandle>=MIN_CANDLE_VOL_USD){
    if(rsi<30 && price>ema20) return {decision:"long",score:2};
    if(rsi>70 && price<ema20) return {decision:"short",score:-2};
    return {decision:"lateral",score:1};
  }
  return {decision:"neutral",score:0};
}

// histórico de candles por símbolo
const candleHistory = {};

// busca apenas candles novos
async function fetchNewKlines(symbol, interval='3m', limit=MAX_CANDLES, lastTs=null){
  const intervalSec = interval==='3m'?180:interval==='5m'?300:60;
  const nowSec = Math.floor(Date.now()/1000);
  const startSec = lastTs ? lastTs+intervalSec : nowSec-limit*intervalSec;

  try{
    const resp = await axios.get("https://api.backpack.exchange/api/v1/klines", {params:{symbol,interval,startTime:startSec,endTime:nowSec}});
    if(resp.status===200 && Array.isArray(resp.data) && resp.data.length>0){
      return resp.data.map(c=>({open:+c.open,high:+c.high,low:+c.low,close:+c.close,volume:+c.volume,ts:+c.openTime}));
    }
  }catch(e){ console.log(`⚠️ klines falharam ${symbol}: ${e.message}`); }

  // fallback trades
  try{
    const tResp = await axios.get("https://api.backpack.exchange/api/v1/trades",{params:{symbol,limit:limit*5}});
    const trades = tResp.data;
    const buckets = {};
    trades.forEach(tr=>{
      const ts = Math.floor(tr.timestamp/1000);
      const bucket = Math.floor(ts/intervalSec)*intervalSec;
      const p = +tr.price, q = +tr.quantity;
      if(!buckets[bucket]) buckets[bucket] = {open:null,high:-Infinity,low:Infinity,close:null,volume:0,ts:bucket};
      const b = buckets[bucket];
      if(b.open===null) b.open=p;
      b.high = Math.max(b.high,p);
      b.low = Math.min(b.low,p);
      b.close = p;
      b.volume += q*p;
    });
    return Object.values(buckets).filter(b=>b.open!==null).sort((a,b)=>a.ts-b.ts);
  }catch(e){ console.log(`❌ trades falharam ${symbol}: ${e.message}`); return [];}
}

// rota da API: atualiza histórico incrementalmente
app.get("/api/data", async (req,res)=>{
  try{
    const oiResp = await axios.get("https://api.backpack.exchange/api/v1/openInterest");
    const perp = oiResp.data.filter(m=>m.symbol.endsWith("_PERP"));

    const promises = perp.map(async m=>{
      try{
        const tResp = await axios.get("https://api.backpack.exchange/api/v1/ticker",{params:{symbol:m.symbol}});
        const ticker = Array.isArray(tResp.data)?tResp.data[0]:tResp.data;
        const lastPrice = +ticker.lastPrice||0;

        if(!candleHistory[m.symbol]) candleHistory[m.symbol] = [];
        const lastTs = candleHistory[m.symbol].length ? candleHistory[m.symbol][candleHistory[m.symbol].length-1].ts/1000 : null;

        const newCandles = await fetchNewKlines(m.symbol,"3m",MAX_CANDLES,lastTs);
        const merged = [...candleHistory[m.symbol], ...newCandles];
        // remove duplicados e mantém apenas MAX_CANDLES
        const unique = Array.from(new Map(merged.map(c=>[c.ts,c])).values());
        candleHistory[m.symbol] = unique.slice(-MAX_CANDLES);

        const closes = candleHistory[m.symbol].map(c=>c.close);
        const highs = candleHistory[m.symbol].map(c=>c.high);
        const lows = candleHistory[m.symbol].map(c=>c.low);

        const atr = computeATR(highs,lows,closes);
        const atrRel = lastPrice ? atr/lastPrice : 0;
        const rsi = computeRSI(closes);
        const bb = computeBollinger(closes);
        const ema20 = computeEMA(closes);
        const volLastCandle = candleHistory[m.symbol].length ? candleHistory[m.symbol][candleHistory[m.symbol].length-1].volume*lastPrice : 0;
        const oiUSD = (+m.openInterest||0)*lastPrice;
        const volumeUSD = (+ticker.volume||0)*lastPrice;
        const liqOI = oiUSD ? volumeUSD/oiUSD : 0;

        const {decision,score} = decide({price:lastPrice,atrRel,rsi,bb,ema20,volLastCandle});
        return {symbol:m.symbol,lastPrice,atrRel,rsi,bbWidth:bb.width,ema20,volumeUSD,oiUSD,liqOI,decision,score};
      }catch(e){ console.log("erro ticker",m.symbol,e.message); return null; }
    });

    const results = (await Promise.all(promises)).filter(Boolean).sort((a,b)=>b.liqOI-a.liqOI);
    res.json(results);
  }catch(e){ console.log("erro openInterest",e.message); res.json([]);}
});

module.exports = app;
