// === BACKPACK MONITOR SERVER ===
// Atualiza indicadores, mantém histórico e exibe todos os mercados (inclusive os ainda não listados)

const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static(__dirname));

const PORT = 3000;

// === PARÂMETROS ===
const ATR_PERIOD = 14;
const RSI_PERIOD = 9;
const BB_PERIOD = 20;
const BB_STD = 2;
const EMA_PERIOD = 20;
const SAFE_ATR_THRESHOLD = 0.01;
const BB_WIDTH_THRESHOLD = 0.01;
const MIN_CANDLE_VOL_USD = 100000;
const MAX_HISTORY = 100;
const UPDATE_INTERVAL = 30 * 1000; // 30 segundos

// === HELPERS ===
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function std(arr) { if (arr.length < 2) return 0; const m = mean(arr); return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1)); }

// === INDICADORES ===
function computeATR(highs, lows, closes, period = ATR_PERIOD) {
  if (highs.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return trs.length < period ? mean(trs) : mean(trs.slice(-period));
}

function computeRSI(closes, period = RSI_PERIOD) {
  if (closes.length <= period) return 50;
  const deltas = closes.slice(1).map((c, i) => c - closes[i]);
  const gains = deltas.map(d => d > 0 ? d : 0);
  const losses = deltas.map(d => d < 0 ? Math.abs(d) : 0);
  const avgGain = mean(gains.slice(-period));
  const avgLoss = mean(losses.slice(-period)) || 1e-9;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function computeBollinger(closes, period = BB_PERIOD, mult = BB_STD) {
  if (closes.length < period) {
    const sma = mean(closes);
    const s = std(closes);
    return { middle: sma, upper: sma + mult * s, lower: sma - mult * s, width: (2 * mult * s) / (sma || 1) };
  }
  const slice = closes.slice(-period);
  const sma = mean(slice);
  const s = std(slice);
  return { middle: sma, upper: sma + mult * s, lower: sma - mult * s, width: (2 * mult * s) / (sma || 1) };
}

function computeEMA(closes, period = EMA_PERIOD) {
  if (closes.length < period) return mean(closes);
  const k = 2 / (period + 1);
  return closes.slice(-period).reduce((ema, price) => ema + k * (price - ema));
}

// === CANDLE FETCH COM FALLBACK ===
async function fetchKlines(symbol, interval = "3m", limit = 100) {
  const intervalSec = interval === "3m" ? 180 : interval === "5m" ? 300 : 60;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - limit * intervalSec;
    const resp = await axios.get("https://api.backpack.exchange/api/v1/klines", { params: { symbol, interval, startTime: startSec, endTime: nowSec } });
    if (resp.status === 200 && Array.isArray(resp.data) && resp.data.length > 0) {
      const arr = resp.data.map(c => ({ open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +c.volume, ts: +c.openTime }));
      if (arr.length >= 2) return arr;
    }
  } catch (e) { console.log(`⚠️ klines falhou ${symbol}: ${e.message}`); }

  try { // fallback trades
    const tResp = await axios.get("https://api.backpack.exchange/api/v1/trades", { params: { symbol, limit: limit * 3 } });
    const trades = tResp.data;
    const buckets = {};
    trades.forEach(tr => {
      const ts = Math.floor(tr.timestamp / 1000);
      const bucket = Math.floor(ts / intervalSec) * intervalSec;
      const p = +tr.price, q = +tr.quantity;
      if (!buckets[bucket]) buckets[bucket] = { open: null, high: -Infinity, low: Infinity, close: null, volume: 0, ts: bucket };
      const b = buckets[bucket];
      if (b.open === null) b.open = p;
      b.high = Math.max(b.high, p);
      b.low = Math.min(b.low, p);
      b.close = p;
      b.volume += q * p;
    });
    return Object.values(buckets).filter(b => b.open !== null).sort((a,b)=>a.ts-b.ts);
  } catch (e) { console.log(`❌ trades falhou ${symbol}: ${e.message}`); return []; }
}

// === DECISÃO ===
function decide({ price, atrRel, rsi, bb, ema20, volLastCandle }) {
  if (atrRel < SAFE_ATR_THRESHOLD && bb.width <= BB_WIDTH_THRESHOLD && volLastCandle >= MIN_CANDLE_VOL_USD) {
    if (rsi < 30 && price > ema20) return { decision: "long", score: 2 };
    if (rsi > 70 && price < ema20) return { decision: "short", score: -2 };
    return { decision: "lateral", score: 1 };
  }
  return { decision: "neutral", score: 0 };
}

// === HISTÓRICO ===
const historyMap = {};

// === FUNÇÃO GENÉRICA PARA SNAPSHOT ===
async function takeSnapshotForMarkets(filterFn = m => true) {
  try {
    const marketResp = await axios.get("https://api.backpack.exchange/api/v1/markets");
    const allMarkets = marketResp.data || [];
    const markets = allMarkets.filter(filterFn);

    const combined = [];

    for (const m of markets) {
      try {
        const tResp = await axios.get("https://api.backpack.exchange/api/v1/ticker", { params: { symbol: m.symbol } });
        const ticker = Array.isArray(tResp.data) ? tResp.data[0] : tResp.data;
        const lastPrice = +ticker.lastPrice || 0;

        let atrRel = 0, rsi = 0, bbWidth = 0, ema20 = 0;
        let volLastCandle = 0;

        let kl = [];
        if (lastPrice > 0) {
          kl = await fetchKlines(m.symbol, "3m", 100);
          if (kl.length < 10) kl = await fetchKlines(m.symbol, "5m", 100);
          const closes = kl.map(k=>k.close);
          const highs = kl.map(k=>k.high);
          const lows = kl.map(k=>k.low);
          const atr = computeATR(highs,lows,closes);
          atrRel = lastPrice ? atr/lastPrice : 0;
          rsi = computeRSI(closes);
          const bb = computeBollinger(closes);
          bbWidth = bb.width;
          ema20 = computeEMA(closes);
          volLastCandle = kl.length ? kl[kl.length-1].volume*lastPrice : 0;
        }

        const volumeUSD = (+ticker.volume || 0) * lastPrice;
        const { decision, score } = lastPrice ? decide({ price:lastPrice, atrRel, rsi, bb:{width:bbWidth}, ema20, volLastCandle }) : { decision: "aguardando", score: 0 };

        combined.push({
          symbol: m.symbol,
          lastPrice,
          atrRel,
          rsi,
          bbWidth,
          ema20,
          volumeUSD,
          decision,
          score,
          ts: Date.now()
        });
      } catch(e) { console.log("Erro em", m.symbol, e.message); }
    }

    return combined.sort((a,b)=>b.volumeUSD - a.volumeUSD);
  } catch(e){ console.log("snapshot error:", e.message); return []; }
}

// === CACHE AUTOMÁTICO ===
let cachedPerp = [], cachedSpot = [], cachedTransfer = [];
let lastUpdate = 0;

async function updateAllData() {
  cachedPerp = await takeSnapshotForMarkets(m => m.symbol.endsWith("_PERP"));
  cachedSpot = await takeSnapshotForMarkets(m => !m.symbol.endsWith("_PERP") && !m.symbol.includes("TRANSFER"));
  cachedTransfer = await takeSnapshotForMarkets(m => m.symbol.includes("TRANSFER"));
  lastUpdate = Date.now();
}

setInterval(updateAllData, UPDATE_INTERVAL);
updateAllData();

// === ROTAS API ===
app.get("/api/data", async (req,res)=>{ res.json(cachedPerp); });
app.get("/api/spot", async (req,res)=>{ res.json(cachedSpot); });
app.get("/api/transfer", async (req,res)=>{ res.json(cachedTransfer); });

// === EXPORT ===
module.exports = app;
