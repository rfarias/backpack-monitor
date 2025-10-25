// /api/spot.js
import fetch from "node-fetch";

const BASE_URL = "https://api.backpack.exchange/api/v1";
const UPDATE_INTERVAL = 180000;
const MAX_CONCURRENT = 5;

let cache = { ts: 0, data: [] };
const klinesCache = new Map();

const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const std = arr => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
};
const computeATR = (highs, lows, closes, period = 14) => {
  if (closes.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    trs.push(tr);
  }
  return mean(trs.slice(-period));
};
const computeRSI = (closes, period = 9) => {
  if (closes.length <= period) return 50;
  const deltas = closes.slice(1).map((c, i) => c - closes[i]);
  const gains = deltas.map(d => (d > 0 ? d : 0));
  const losses = deltas.map(d => (d < 0 ? Math.abs(d) : 0));
  const avgGain = mean(gains.slice(-period));
  const avgLoss = mean(losses.slice(-period)) || 1e-9;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
};
const computeBollinger = (closes, period = 20, mult = 2) => {
  if (!closes.length) return { middle: 0, width: 0 };
  const slice = closes.slice(-period);
  const m = mean(slice);
  const s = std(slice);
  return { middle: m, width: (2 * mult * s) / (m || 1) };
};
const computeEMA = (closes, period = 20) => {
  if (closes.length < period) return mean(closes);
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
};

async function fetchKlines(symbol, interval = "15m", limit = 200) {
  const key = `${symbol}_${interval}`;
  const now = Date.now();
  if (klinesCache.has(key)) {
    const cached = klinesCache.get(key);
    if (now - cached.ts < 180000) return cached.data;
  }

  try {
    const url = `${BASE_URL}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const resp = await fetch(url);
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data) && data.length > 0) {
        const parsed = data.map(c => ({
          open: +c.open,
          high: +c.high,
          low: +c.low,
          close: +c.close,
          volume: +c.volume,
          ts: +c.openTime
        }));
        klinesCache.set(key, { ts: now, data: parsed });
        return parsed;
      }
    }
  } catch (e) {
    console.log(`⚠️ klines falhou ${symbol}: ${e.message}`);
  }
  return [];
}

export default async function handler(req, res) {
  try {
    const { tf = "15m" } = req.query;
    const validTfs = ["1m","3m","5m","10m","15m","30m","1h","4h","12h","1d"];
    const interval = validTfs.includes(tf) ? tf : "15m";

    const now = Date.now();
    if (now - cache.ts < UPDATE_INTERVAL && cache.data.length > 0)
      return res.status(200).json(cache.data);

    const marketsResp = await fetch(`${BASE_URL}/markets`);
    const markets = (await marketsResp.json()) || [];
    const spotMarkets = markets.filter(m => !m.symbol.endsWith("_PERP"));

    const results = [];
    const active = [];

    for (const m of spotMarkets) {
      const run = async () => {
        let lastPrice = 0, volumeUSD = 0;
        let atrRel = 0, rsi = 0, bbWidth = 0, ema20 = 0;
        let spreadPct = 0, liquidityScore = 0;
        let decision = "aguardando", score = 0;

        try {
          const tickerResp = await fetch(`${BASE_URL}/ticker?symbol=${m.symbol}`);
          let ticker = {};
          if (tickerResp.ok) ticker = await tickerResp.json();

          lastPrice = +ticker.lastPrice || 0;
          const vol = +ticker.volume || 0;
          volumeUSD = vol * lastPrice;

          const bid = +ticker.bid || 0;
          const ask = +ticker.ask || 0;
          spreadPct = (bid > 0 && ask > 0) ? ((ask - bid) / ((ask + bid) / 2)) * 100 : 0;
          liquidityScore = spreadPct > 0 ? (volumeUSD / (spreadPct * 100)) : volumeUSD;

          const kl = await fetchKlines(m.symbol, interval, 200);
          if (kl.length > 0) {
            const closes = kl.map(k => k.close);
            const highs = kl.map(k => k.high);
            const lows = kl.map(k => k.low);
            const atr = computeATR(highs, lows, closes);
            atrRel = lastPrice ? atr / lastPrice : 0;
            rsi = computeRSI(closes);
            bbWidth = computeBollinger(closes).width;
            ema20 = computeEMA(closes);

            if (rsi < 30 && lastPrice > ema20) { decision = "long"; score = 2; }
            else if (rsi > 70 && lastPrice < ema20) { decision = "short"; score = -2; }
            else if (atrRel < 0.005) { decision = "lateral"; score = 1; }
            else { decision = "neutral"; score = 0; }
          }
        } catch (err) {
          console.log(`⚠️ Erro ${m.symbol}: ${err.message}`);
        }

        results.push({
          symbol: m.symbol,
          visible: m.visible,
          orderBookState: m.orderBookState,
          lastPrice,
          atrRel,
          rsi,
          bbWidth,
          ema20,
          volumeUSD,
          spreadPct,
          liquidityScore,
          decision,
          score
        });
      };

      active.push(run());
      if (active.length >= MAX_CONCURRENT)
        await Promise.all(active.splice(0, MAX_CONCURRENT));
    }

    await Promise.all(active);
    cache = { ts: now, data: results };
    res.status(200).json(results);
  } catch (e) {
    console.error("Erro geral /api/spot:", e.message);
    res.status(500).json({ error: e.message });
  }
}
