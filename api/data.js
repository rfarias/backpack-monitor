// /api/data.js
import axios from "axios";

let cache = [];
let lastUpdate = 0;
const UPDATE_INTERVAL = 30 * 1000;

// === Indicadores ===
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a) { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length || 1)); }
function computeATR(highs, lows, closes) {
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  return mean(trs.slice(-14));
}
function computeRSI(closes) {
  if (closes.length < 15) return 50;
  const deltas = closes.slice(1).map((c, i) => c - closes[i]);
  const gains = deltas.map(d => d > 0 ? d : 0);
  const losses = deltas.map(d => d < 0 ? -d : 0);
  const avgGain = mean(gains.slice(-14));
  const avgLoss = mean(losses.slice(-14)) || 1e-9;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
function computeBB(closes) {
  const slice = closes.slice(-20);
  const m = mean(slice);
  const s = std(slice);
  return (2 * s) / (m || 1);
}
function decide({ rsi, atrRel }) {
  if (rsi <= 30 && atrRel < 0.006) return "long";
  if (rsi >= 70 && atrRel < 0.006) return "short";
  if (atrRel <= 0.004) return "lateral";
  return "neutral";
}

async function fetchKlines(symbol) {
  try {
    const res = await axios.get("https://api.backpack.exchange/api/v1/klines", {
      params: { symbol, interval: "3m", limit: 100 }
    });
    return Array.isArray(res.data) ? res.data : [];
  } catch {
    return [];
  }
}

async function takeSnapshot() {
  try {
    const [oiRes, marketsRes] = await Promise.all([
      axios.get("https://api.backpack.exchange/api/v1/openInterest"),
      axios.get("https://api.backpack.exchange/api/v1/markets")
    ]);

    const oiMap = {};
    (oiRes.data || []).forEach(o => { oiMap[o.symbol] = o; });
    const markets = (marketsRes.data || []).filter(m => m.symbol.endsWith("_PERP"));

    const out = [];

    for (const m of markets) {
      try {
        const tRes = await axios.get("https://api.backpack.exchange/api/v1/ticker", { params: { symbol: m.symbol } });
        const ticker = Array.isArray(tRes.data) ? tRes.data[0] : tRes.data;
        const lastPrice = parseFloat(ticker?.lastPrice) || 0;
        const volumeUSD = (parseFloat(ticker?.volume) || 0) * lastPrice;
        const kl = await fetchKlines(m.symbol);

        let atrRel = 0, rsi = 0, bbWidth = 0;
        if (kl.length > 10) {
          const closes = kl.map(k => +k.close);
          const highs = kl.map(k => +k.high);
          const lows = kl.map(k => +k.low);
          const atr = computeATR(highs, lows, closes);
          atrRel = lastPrice ? atr / lastPrice : 0;
          rsi = computeRSI(closes);
          bbWidth = computeBB(closes);
        }

        const oiUSD = ((oiMap[m.symbol]?.openInterest) || 0) * lastPrice;
        const decision = lastPrice > 0 ? decide({ rsi, atrRel }) : "aguardando";
        const score = Math.round((100 - Math.abs(50 - rsi)) * (1 - Math.min(atrRel * 100, 1)));

        out.push({
          symbol: m.symbol,
          lastPrice,
          volumeUSD,
          oiUSD,
          rsi,
          atrRel,
          bbWidth,
          decision,
          score
        });
      } catch (e) {
        console.log("erro em", m.symbol, e.message);
      }
    }
    return out;
  } catch (e) {
    console.log("snapshot error:", e.message);
    return [];
  }
}

async function updateCache() {
  cache = await takeSnapshot();
  lastUpdate = Date.now();
}

setInterval(updateCache, UPDATE_INTERVAL);
updateCache();

export default async function handler(req, res) {
  try {
    if (Date.now() - lastUpdate > UPDATE_INTERVAL * 2) await updateCache();
    res.status(200).json(cache || []);
  } catch (e) {
    console.log("Erro /api/data:", e.message);
    res.status(500).json([]);
  }
}
