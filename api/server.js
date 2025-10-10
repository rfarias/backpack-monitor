const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static(__dirname));

// ==== Parâmetros ====
const ATR_PERIOD = 14;
const RSI_PERIOD = 9;
const BB_PERIOD = 20;
const BB_STD = 2;
const EMA_PERIOD = 20;
const SAFE_ATR_THRESHOLD = 0.01;
const BB_WIDTH_THRESHOLD = 0.01;
const MIN_CANDLE_VOL_USD = 100000;
const CANDLE_LIMIT = 100; // 🔹 número de candles por símbolo

// ==== Helpers ====
const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const std = arr => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
};

// ==== Indicadores ====
function computeATR(highs, lows, closes, period = ATR_PERIOD) {
  if (highs.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
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
  return 100 - (100 / (1 + rs));
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

// ==== Fetch de candles com fallback ====
async function fetchKlines(symbol, interval = '3m', limit = CANDLE_LIMIT) {
  const intervalSec = interval === '3m' ? 180 : interval === '5m' ? 300 : 60;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - limit * intervalSec;
    const resp = await axios.get("https://api.backpack.exchange/api/v1/klines", {
      params: { symbol, interval, startTime: startSec, endTime: nowSec }
    });
    if (resp.status === 200 && Array.isArray(resp.data) && resp.data.length > 0) {
      const arr = resp.data.map(c => ({
        open: +c.open,
        high: +c.high,
        low: +c.low,
        close: +c.close,
        volume: +c.volume,
        ts: +c.openTime
      }));
      return arr;
    }
  } catch (e) {
    console.log(`⚠️ Klines falhou ${symbol}: ${e.message}`);
  }

  // fallback: trades
  try {
    const tResp = await axios.get("https://api.backpack.exchange/api/v1/trades", {
      params: { symbol, limit: limit * 5 }
    });
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
    const candles = Object.values(buckets).filter(b => b.open !== null).sort((a, b) => a.ts - b.ts);
    return candles;
  } catch (e) {
    console.log(`❌ Trades falhou ${symbol}: ${e.message}`);
    return [];
  }
}

// ==== Decisão ====
function decide({ price, atrRel, rsi, bb, ema20, volLastCandle }) {
  if (atrRel < SAFE_ATR_THRESHOLD && bb.width <= BB_WIDTH_THRESHOLD && volLastCandle >= MIN_CANDLE_VOL_USD) {
    if (rsi < 30 && price > ema20) return { decision: "long", score: 2 };
    if (rsi > 70 && price < ema20) return { decision: "short", score: -2 };
    return { decision: "lateral", score: 1 };
  }
  return { decision: "neutral", score: 0 };
}

// ==== Snapshot ====
// ==== Snapshot (inclui mercados futuros sem preço) ====
async function takeSnapshot() {
  try {
    // pega todos os mercados (inclusive ainda não listados)
    const marketsResp = await axios.get("https://api.backpack.exchange/api/v1/markets");
    const allPerp = marketsResp.data.filter(m => m.symbol.endsWith("_PERP"));

    // pega open interest (pode estar vazio para mercados futuros)
    const oiResp = await axios.get("https://api.backpack.exchange/api/v1/openInterest");
    const oiMap = {};
    oiResp.data.forEach(o => {
      oiMap[o.symbol] = o;
    });

    const results = await Promise.all(
      allPerp.map(async (m) => {
        const oiData = oiMap[m.symbol] || {};
        try {
          const tResp = await axios.get("https://api.backpack.exchange/api/v1/ticker", {
            params: { symbol: m.symbol },
          });
          const ticker = Array.isArray(tResp.data) ? tResp.data[0] : tResp.data;
          const lastPrice = +ticker.lastPrice || 0;

          let atrRel = null, rsi = null, bbWidth = null, ema20 = null, decision = "aguardando", score = 0;
          let volumeUSD = 0, oiUSD = 0, liqOI = 0;

          if (lastPrice > 0) {
            let kl = await fetchKlines(m.symbol, "3m", CANDLE_LIMIT);
            if (kl.length < 20) kl = await fetchKlines(m.symbol, "5m", CANDLE_LIMIT);

            if (kl.length >= 10) {
              const closes = kl.map(k => k.close);
              const highs = kl.map(k => k.high);
              const lows = kl.map(k => k.low);

              const atr = computeATR(highs, lows, closes);
              atrRel = lastPrice ? atr / lastPrice : 0;
              rsi = computeRSI(closes);
              const bb = computeBollinger(closes);
              bbWidth = bb.width;
              ema20 = computeEMA(closes);
              const volLastCandle = kl[kl.length - 1].volume * lastPrice;

              oiUSD = (+oiData.openInterest || 0) * lastPrice;
              volumeUSD = (+ticker.volume || 0) * lastPrice;
              liqOI = oiUSD ? volumeUSD / oiUSD : 0;

              const decisionObj = decide({ price: lastPrice, atrRel, rsi, bb, ema20, volLastCandle });
              decision = decisionObj.decision;
              score = decisionObj.score;
            }
          }

          return {
            symbol: m.symbol,
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
            status: lastPrice > 0 ? "ativo" : "aguardando",
          };
        } catch (err) {
          console.log("Erro em", m.symbol, err.message);
          return {
            symbol: m.symbol,
            lastPrice: 0,
            atrRel: null,
            rsi: null,
            bbWidth: null,
            ema20: null,
            volumeUSD: 0,
            oiUSD: 0,
            liqOI: 0,
            decision: "aguardando",
            score: 0,
            status: "aguardando",
          };
        }
      })
    );

    // mostra todos os mercados (ativos e futuros)
    return results.sort((a, b) => (b.oiUSD || 0) - (a.oiUSD || 0));
  } catch (e) {
    console.log("Snapshot error:", e.message);
    return [];
  }
}

// ==== Rota API ====
app.get("/api/data", async (req, res) => {
  console.log("📡 Atualizando dados...");
  const data = await takeSnapshot();
  res.json(data);
});

// ==== Exportar ====
module.exports = app;
