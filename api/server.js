// === BACKPACK MONITOR SERVER (versão otimizada) ===

const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static(__dirname));

const PORT = 3000;

// === CONFIG ===
const ATR_PERIOD = 14;
const RSI_PERIOD = 9;
const BB_PERIOD = 20;
const BB_STD = 2;
const EMA_PERIOD = 20;
const SAFE_ATR_THRESHOLD = 0.01;
const BB_WIDTH_THRESHOLD = 0.01;
const MIN_CANDLE_VOL_USD = 100000;
const MAX_HISTORY = 100;
const UPDATE_INTERVAL = 60 * 1000; // 1 min
const ASSET_CHECK_INTERVAL = 5 * 60 * 1000; // 5 min

// === HELPERS ===
function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function std(arr) { if (arr.length<2) return 0; const m=mean(arr); return Math.sqrt(arr.reduce((s,x)=>s+(x-m)**2,0)/(arr.length-1)); }

// === INDICADORES ===
function computeATR(highs,lows,closes,period=ATR_PERIOD){
  if(highs.length<2)return 0;
  const trs=[];
  for(let i=1;i<highs.length;i++){
    trs.push(Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])));
  }
  return trs.length<period?mean(trs):mean(trs.slice(-period));
}
function computeRSI(closes,period=RSI_PERIOD){
  if(closes.length<=period)return 50;
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
  const sma=mean(slice), s=std(slice);
  return {middle:sma,upper:sma+mult*s,lower:sma-mult*s,width:(2*mult*s)/(sma||1)};
}
function computeEMA(closes,period=EMA_PERIOD){
  if(closes.length<period)return mean(closes);
  const k=2/(period+1);
  return closes.slice(-period).reduce((ema,price)=>ema+k*(price-ema));
}

// === FETCH CANDLES ===
async function fetchKlines(symbol, interval="3m", limit=100){
  const intervalSec=interval==="3m"?180:interval==="5m"?300:60;
  try{
    const nowSec=Math.floor(Date.now()/1000);
    const startSec=nowSec-limit*intervalSec;
    const resp=await axios.get("https://api.backpack.exchange/api/v1/klines",{params:{symbol,interval,startTime:startSec,endTime:nowSec}});
    if(Array.isArray(resp.data)&&resp.data.length){
      return resp.data.map(c=>({open:+c.open,high:+c.high,low:+c.low,close:+c.close,volume:+c.volume,ts:+c.openTime}));
    }
  }catch(e){}
  return [];
}

// === DECISÃO ===
function decide({price,atrRel,rsi,bb,ema20,volLastCandle}){
  if(atrRel<SAFE_ATR_THRESHOLD && bb.width<=BB_WIDTH_THRESHOLD && volLastCandle>=MIN_CANDLE_VOL_USD){
    if(rsi<30 && price>ema20)return{decision:"long",score:2};
    if(rsi>70 && price<ema20)return{decision:"short",score:-2};
    return{decision:"lateral",score:1};
  }
  return{decision:"neutral",score:0};
}

// === HISTÓRICO / CACHE ===
let cachePerp=[], cacheSpot=[], cacheTransfer=[];
let lastAssets = {};
const historyMap={};

async function buildPerpSnapshot(){
  const [oiResp, marketResp] = await Promise.all([
    axios.get("https://api.backpack.exchange/api/v1/openInterest"),
    axios.get("https://api.backpack.exchange/api/v1/markets")
  ]);
  const allMarkets=marketResp.data||[];
  const oiMap=Object.fromEntries((oiResp.data||[]).map(m=>[m.symbol,m]));
  const perp=allMarkets.filter(m=>m.symbol.endsWith("_PERP"));
  const result=[];
  for(const m of perp){
    try{
      const oiEntry=oiMap[m.symbol]||{};
      const tResp=await axios.get("https://api.backpack.exchange/api/v1/ticker",{params:{symbol:m.symbol}});
      const ticker=Array.isArray(tResp.data)?tResp.data[0]:tResp.data;
      const lastPrice=+ticker.lastPrice||0;
      let atrRel=0,rsi=0,bbWidth=0,ema20=0,volLastCandle=0;
      if(lastPrice>0){
        let kl=await fetchKlines(m.symbol,"3m",100);
        const closes=kl.map(k=>k.close), highs=kl.map(k=>k.high), lows=kl.map(k=>k.low);
        const atr=computeATR(highs,lows,closes);
        atrRel=atr/lastPrice; rsi=computeRSI(closes);
        const bb=computeBollinger(closes); bbWidth=bb.width;
        ema20=computeEMA(closes);
        volLastCandle=kl.length?kl.at(-1).volume*lastPrice:0;
      }
      const oiUSD=(+oiEntry.openInterest||0)*lastPrice;
      const volumeUSD=(+ticker.volume||0)*lastPrice;
      const liqOI=oiUSD?volumeUSD/oiUSD:0;
      const {decision,score}=decide({price:lastPrice,atrRel,rsi,bb:{width:bbWidth},ema20,volLastCandle});
      const item={symbol:m.symbol,lastPrice,atrRel,rsi,bbWidth,volumeUSD,oiUSD,liqOI,decision,score};
      if(!historyMap[m.symbol])historyMap[m.symbol]=[];
      historyMap[m.symbol].push(item);
      if(historyMap[m.symbol].length>MAX_HISTORY)historyMap[m.symbol].shift();
      result.push(item);
    }catch(e){console.log("Erro perp",m.symbol,e.message);}
  }
  return result;
}

async function buildSpotSnapshot(){
  const resp=await axios.get("https://api.backpack.exchange/api/v1/markets");
  const allMarkets=resp.data||[];
  const spot=allMarkets.filter(m=>!m.symbol.endsWith("_PERP"));
  const result=[];
  for(const m of spot){
    try{
      const tResp=await axios.get("https://api.backpack.exchange/api/v1/ticker",{params:{symbol:m.symbol}});
      const ticker=Array.isArray(tResp.data)?tResp.data[0]:tResp.data;
      const lastPrice=+ticker.lastPrice||0;
      result.push({symbol:m.symbol,lastPrice,volumeUSD:(+ticker.volume||0)*lastPrice});
    }catch(e){}
  }
  return result;
}

async function buildTransferSnapshot(){
  const resp=await axios.get("https://api.backpack.exchange/api/v1/assets");
  const assets=resp.data||[];
  const result=assets.map(a=>({
    symbol:a.symbol,
    networks:(a.networks||[]).map(n=>({
      network:n.network,
      deposit:n.depositEnabled,
      withdraw:n.withdrawEnabled
    }))
  }));
  return result;
}

// === MONITOR DE NOVAS LISTAGENS ===
async function checkNewAssets(){
  try{
    const resp=await axios.get("https://api.backpack.exchange/api/v1/assets");
    const data=resp.data||[];
    const notifications=[];
    data.forEach(a=>{
      const old=lastAssets[a.symbol];
      if(!old)notifications.push({type:"new_asset",symbol:a.symbol});
      else{
        (a.networks||[]).forEach(n=>{
          const prev=(old.networks||[]).find(x=>x.network===n.network);
          if(!prev)notifications.push({type:"new_chain",symbol:a.symbol,chain:n.network});
          if(prev && !prev.deposit && n.depositEnabled)
            notifications.push({type:"deposit_enabled",symbol:a.symbol,chain:n.network});
        });
      }
    });
    lastAssets=Object.fromEntries(data.map(a=>[a.symbol,a]));
    if(notifications.length)console.log("🔔 Novas listagens:",notifications);
  }catch(e){console.log("checkNewAssets error",e.message);}
}

// === ATUALIZAÇÃO PERIÓDICA ===
async function updateAll(){
  try{
    [cachePerp,cacheSpot,cacheTransfer] = await Promise.all([
      buildPerpSnapshot(),
      buildSpotSnapshot(),
      buildTransferSnapshot()
    ]);
  }catch(e){console.log("updateAll error",e.message);}
}
updateAll();
setInterval(updateAll,UPDATE_INTERVAL);
setInterval(checkNewAssets,ASSET_CHECK_INTERVAL);

// === ROTAS ===
app.get("/api/data",(req,res)=>res.json(cachePerp||[]));
app.get("/api/spot",(req,res)=>res.json(cacheSpot||[]));
app.get("/api/transfer",(req,res)=>res.json(cacheTransfer||[]));

// === START ===
app.listen(PORT,()=>console.log(`🚀 Server rodando em http://localhost:${PORT}`));
