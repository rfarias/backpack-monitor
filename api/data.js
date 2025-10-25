// /api/data.js
import fetch from "node-fetch";

const BASE_URL = "https://api.backpack.exchange/api/v1";
const UPDATE_INTERVAL = 3 * 60 * 1000; // 3 minutos
const MAX_CONCURRENT = 5;

let cacheByTf = {}; // ✅ cache separado por timeframe
let klinesCache = {}; // cache para klines individuais

export default async function handler(req, res) {
  const now = Date.now();
  const interval = req.query.tf || "3m";

  if (!cacheByTf[interval]) cacheByTf[interval] = { ts: 0, data: [] };

  // Usa cache existente se estiver fresco
  if (now - cacheByTf[interval].ts < UPDATE_INTERVAL && cacheByTf[interval].data.length > 0) {
    return res.status(200).json(cacheByTf[interval].data);
  }

  try {
    const [marketsRes, tickersRes, oiRes] = await Promise.all([
      fetch(`${BASE_URL}/markets`),
      fetch(`${BASE_URL}/tickers`),
      fetch(`${BASE_URL}/open-interest`),
    ]);

    const markets = (await marketsRes.json()) || [];
    const tickers = (await tickersRes.json()) || [];
    const oiData = (await oiRes.json()) || [];

    const tickerMap = Object.fromEntries(tickers.map(t => [t.symbol, t]));
    const oiMap = Object.fromEntries(oiData.map(o => [o.symbol, o.openInterest || 0]));

    const perpMarkets = markets.filter(m => m.symbol.endsWith("_PERP"));

    const results = [];
    for (let i = 0; i < perpMarkets.length; i += MAX_CONCURRENT) {
      const chunk = perpMarkets.slice(i, i + MAX_CONCURRENT);
      const promises = chunk.map(m => processMarket(m, tickerMap, oiMap, interval));
      const chunkResults = await Promise.all(promises);
      results.push(...chunkResults.filter(Boolean));
    }

    cacheByTf[interval] = { ts: now, data: results }; // ✅ salva cache específico
    res.status(200).json(results);
  } catch (err) {
    console.error("❌ Erro /api/data:", err.message);
    res.status(500).json({ error: err.message });
  }
}

async function processMarket(market, tickerMap, oiMap, interval) {
  const symbol = market.symbol;
  try {
    const t = tickerMap[symbol];
    const last = parseFloat(t?.lastPrice || 0);
    const volume = parseFloat(t?.volume || 0);
    const oiUSD = parseFloat(oiMap[symbol] || 0) * last;

    const klines = await fetchKlines(symbol, interval);
    if (!klines || klines.length < 30) return null;

    const closes = klines.map(k => parseFloat(k.close));
    const highs = klines.map(k => parseFloat(k.high));
    const lows = klines.map(k => parseFloat(k.low));

    const atr = computeATR(highs, lows, closes, 14);
    const ema20 = computeEMA(closes, 20);
    const rsi = computeRSI(closes, 9);
    const bb = computeBB(closes, 20, 2);
    const bbWidth = (bb.upper - bb.lower) / ema20;
    const atrRel = atr / ema20;

    let decision = "neutral", score = 0;
    if (rsi < 30 && last > ema20) (decision = "long"), (score = 2);
    else if (rsi > 70 && last < ema20) (decision = "short"), (score = -2);
    else if (atrRel < 0.005 && bbWidth < 0.01) (decision = "lateral"), (score = 1);

    return {
      symbol,
      visible: market.visible,
      orderBookState: market.orderBookState,
      lastPrice: last,
      atrRel,
      rsi,
      bbWidth,
      volumeUSD: volume * last,
      oiUSD,
      decision,
      score,
    };
  } catch (e) {
    console.warn(`⚠️ ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchKlines(symbol, interval) {
  const key = `${symbol}_${interval}`;
  const now = Date.now();
  if (klinesCache[key] && now - klinesCache[key].ts < UPDATE_INTERVAL) {
    return klinesCache[key].data;
  }

  const url = `${BASE_URL}/klines?symbol=${symbol}&interval=${interval}&limit=100`;
  const resp = await fetch(url);
  const data = await resp.json();

  klinesCache[key] = { ts: now, data };
  return data;
}

// === Indicadores ===
function computeEMA(values, len) {
  const k = 2 / (len + 1);
  return values.reduce((acc, val, i) => (i === 0 ? val : val * k + acc * (1 - k)), 0);
}
function computeATR(highs, lows, closes, len) {
  const trs = highs.map((h, i) => {
    const l = lows[i], prev = closes[i - 1] || closes[0];
    return Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev));
  });
  return trs.slice(-len).reduce((a, b) => a + b, 0) / len;
}
function computeRSI(closes, len) {
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / len, avgLoss = losses / len || 1e-9;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
function computeBB(closes, len, mult) {
  const slice = closes.slice(-len);
  const mean = slice.reduce((a, b) => a + b, 0) / len;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / len;
  const std = Math.sqrt(variance);
  return { upper: mean + mult * std, lower: mean - mult * std };
}
