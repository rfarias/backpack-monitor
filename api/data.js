// /api/data.js
import fetch from "node-fetch";

const BASE_URL = "https://api.backpack.exchange/api/v1";
const UPDATE_INTERVAL = 180000; // 3 minutos
const MAX_CONCURRENT = 5;

// === CACHE GLOBAL ===
let cache = { ts: 0, data: [] };

// === FUNÇÕES AUXILIARES ===
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
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  return mean(trs.slice(-period));
};

const computeRSI = (closes, period = 9) => {
  if (closes.length <= period) return 0;
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
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
};

// === FETCH KLINES COM FALLBACK ===
const fetchKlines = async (symbol, interval = "3m", limit = 100) => {
  const intervalSec = interval.endsWith("m")
    ? +interval.replace("m", "") * 60
    : interval.endsWith("h")
    ? +interval.replace("h", "") * 3600
    : 180;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - limit * intervalSec;
    const url = `${BASE_URL}/klines?symbol=${symbol}&interval=${interval}&startTime=${startSec}&endTime=${nowSec}&limit=${limit}`;
    const resp = await fetch(url);
    if (resp.ok) {
      let data = [];
      try {
        data = await resp.json();
      } catch {
        console.log(`⚠️ klines JSON inválido ${symbol}`);
        data = [];
      }
      if (Array.isArray(data) && data.length > 0) {
        return data.map(c => ({
          open: +c.open,
          high: +c.high,
          low: +c.low,
          close: +c.close,
          volume: +c.volume,
          ts: +c.openTime
        }));
      }
    }
  } catch (e) {
    console.log(`⚠️ klines falhou ${symbol}: ${e.message}`);
  }
  return [];
};

// === HANDLER PRINCIPAL ===
export default async function handler(req, res) {
  try {
    const now = Date.now();
    const tf = req.query.tf || "3m";
    console.log(`[INFO] /api/data chamado com timeframe = ${tf}`);

    // cache ainda válido
    if (now - cache.ts < UPDATE_INTERVAL && cache.data.length > 0) {
      return res.status(200).json(cache.data);
    }

    const [marketsResp, oiResp] = await Promise.all([
      fetch(`${BASE_URL}/markets`),
      fetch(`${BASE_URL}/openInterest`)
    ]);

    const markets = (await marketsResp.json()) || [];
    const oiData = (await oiResp.json()) || [];
    const perpMarkets = markets.filter(m => m.symbol.endsWith("_PERP"));

    const oiMap = {};
    oiData.forEach(o => (oiMap[o.symbol] = o));

    const results = [];
    const active = [];

    for (const m of perpMarkets) {
      const run = async () => {
        let lastPrice = 0, volumeUSD = 0, oiUSD = 0;
        let atrRel = 0, rsi = 0, bbWidth = 0, ema20 = 0;
        let decision = "aguardando", score = 0;
        let isNew = false, isAbandoned = false;

        try {
          // --- ticker ---
          let ticker = {};
          try {
            const tickerResp = await fetch(`${BASE_URL}/ticker?symbol=${m.symbol}`);
            if (tickerResp.ok) ticker = await tickerResp.json();
          } catch {}

          lastPrice = +ticker.lastPrice || 0;
          volumeUSD = (+ticker.volume || 0) * lastPrice;
          oiUSD = ((oiMap[m.symbol]?.openInterest) || 0) * lastPrice;

          // --- klines ---
          const kl = await fetchKlines(m.symbol, tf, 100);
          const hadCandles = kl && kl.length > 0;

          const hadActivity = hadCandles && lastPrice > 0 && (volumeUSD > 0 || oiUSD > 0);

          if (hadActivity) {
            const closes = kl.map(k => k.close);
            const highs = kl.map(k => k.high);
            const lows = kl.map(k => k.low);
            const atr = computeATR(highs, lows, closes);
            atrRel = lastPrice ? atr / lastPrice : 0;
            rsi = computeRSI(closes);
            bbWidth = computeBollinger(closes).width;
            ema20 = computeEMA(closes);

            if (!isNaN(rsi) && rsi > 0) {
              if (rsi < 30 && lastPrice > ema20) {
                decision = "long";
                score = 2;
              } else if (rsi > 70 && lastPrice < ema20) {
                decision = "short";
                score = -2;
              } else if (atrRel < 0.005 && bbWidth < 0.01) {
                decision = "lateral";
                score = 1;
              } else {
                decision = "neutral";
                score = 0;
              }
            }
          } else {
            // sem atividade recente
            const nowSec = Math.floor(Date.now() / 1000);
            const createdAt = Math.floor(+new Date(m.createdAt || 0) / 1000);
            const ageDays = (nowSec - createdAt) / 86400;
            const noData = (!volumeUSD || volumeUSD === 0) && (!oiUSD || oiUSD === 0);
            if (noData && ageDays <= 60) isNew = true;
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
          oiUSD,
          decision,
          score,
          isNew,
          isAbandoned
        });
      };

      active.push(run());
      if (active.length >= MAX_CONCURRENT) {
        await Promise.all(active.splice(0, MAX_CONCURRENT));
      }
    }

    await Promise.all(active);
    cache = { ts: now, data: results };
    res.status(200).json(results);
  } catch (e) {
    console.error("Erro geral /api/data:", e.message);
    res.status(500).json({ error: e.message });
  }
}
