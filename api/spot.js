import fetch from "node-fetch";

const BASE_URL = "https://api.backpack.exchange/api/v1";
const UPDATE_INTERVAL = 180000;
const MAX_CONCURRENT = 5;
let cache = { ts: 0, data: [] };

// === Funções auxiliares ===
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const std = a => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

const computeATR = (h, l, c, p = 14) => {
  if (c.length < 2) return 0;
  const t = [];
  for (let i = 1; i < h.length; i++) {
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    t.push(tr);
  }
  return mean(t.slice(-p));
};

const computeRSI = (c, p = 9) => {
  if (c.length <= p) return 50;
  const d = c.slice(1).map((x, i) => x - c[i]);
  const g = d.map(v => v > 0 ? v : 0);
  const L = d.map(v => v < 0 ? Math.abs(v) : 0);
  const aG = mean(g.slice(-p));
  const aL = mean(L.slice(-p)) || 1e-9;
  const rs = aG / aL;
  return 100 - 100 / (1 + rs);
};

const computeBollinger = (c, p = 20, mult = 2) => {
  if (!c.length) return { middle: 0, width: 0 };
  const s = c.slice(-p);
  const m = mean(s);
  const sd = std(s);
  return { middle: m, width: (2 * mult * sd) / (m || 1) };
};

const computeEMA = (c, p = 20) => {
  if (c.length < p) return mean(c);
  const k = 2 / (p + 1);
  let ema = c[0];
  for (let i = 1; i < c.length; i++) ema = c[i] * k + ema * (1 - k);
  return ema;
};

function getThresholdsByTimeframe(tf) {
  const map = { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "12h": 720, "1d": 1440 };
  const mins = map[tf] || 15;
  const scale = Math.log10(mins) / 2 + 1;
  return { atrNeutral: 0.005 * scale, bbNeutral: 0.01 * scale };
}

const fetchKlines = async (symbol, interval = "15m", limit = 200) => {
  const sec = interval.endsWith("m") ? +interval.replace("m", "") * 60
    : interval.endsWith("h") ? +interval.replace("h", "") * 3600 : 1800;
  try {
    const now = Math.floor(Date.now() / 1000);
    const start = now - limit * sec;
    const url = `${BASE_URL}/klines?symbol=${symbol}&interval=${interval}&startTime=${start}&endTime=${now}&limit=${limit}`;
    const r = await fetch(url);
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d) && d.length > 0)
        return d.map(c => ({
          open: +c.open, high: +c.high, low: +c.low,
          close: +c.close, volume: +c.volume, ts: +c.openTime
        }));
    }
  } catch (e) {
    console.log(`⚠️ klines falhou ${symbol}: ${e.message}`);
  }
  return [];
};

// === Handler principal ===
export default async function handler(req, res) {
  try {
    const now = Date.now();
    const tf = req.query.tf || "15m";
    const th = getThresholdsByTimeframe(tf);
    console.log(`[INFO] /api/spot chamado com timeframe=${tf}`);

    if (now - cache.ts < UPDATE_INTERVAL && cache.data.length > 0)
      return res.status(200).json(cache.data);

    const marketsResp = await fetch(`${BASE_URL}/markets`);
    const markets = (await marketsResp.json()) || [];
    const spot = markets.filter(m => !m.symbol.endsWith("_PERP"));

    const results = [], active = [];

    for (const m of spot) {
      const run = async () => {
        let lastPrice = 0, volumeUSD = 0, atrRel = 0, rsi = 0, bbWidth = 0, ema20 = 0,
          decision = "aguardando", score = 0, spreadPct = 0, marketCapUSD = 0, liquidityScore = 0;

        try {
          const tick = await fetch(`${BASE_URL}/ticker?symbol=${m.symbol}`);
          const t = tick.ok ? await tick.json() : {};
          lastPrice = +t.lastPrice || 0;
          const v = +t.volume || 0;
          volumeUSD = v * lastPrice;

          const kl = await fetchKlines(m.symbol, tf, 200);

          if (kl.length > 0 && lastPrice > 0) {
            // Filtra candles com valores válidos
            const c = kl.map(k => k.close).filter(v => v > 0);
            const h = kl.map(k => k.high).filter(v => v > 0);
            const l = kl.map(k => k.low).filter(v => v > 0);

            if (c.length >= 10) {
              const atr = computeATR(h, l, c);
              atrRel = lastPrice ? atr / lastPrice : 0;
              rsi = computeRSI(c);
              bbWidth = computeBollinger(c).width;
              ema20 = computeEMA(c);

              const valid = [atrRel, bbWidth, rsi].every(v => typeof v === "number" && !isNaN(v));

              if (valid) {
                if (rsi < 30 && lastPrice > ema20) {
                  decision = "long"; score = 2;
                } else if (rsi > 70 && lastPrice < ema20) {
                  decision = "short"; score = -2;
                } else if (atrRel < th.atrNeutral && bbWidth < th.bbNeutral) {
                  decision = "lateral"; score = 1;
                } else {
                  decision = "neutral"; score = 0;
                }
              } else {
                decision = "aguardando"; score = 0;
              }
            } else {
              decision = "aguardando"; score = 0;
            }
          }

          const ask = +t.bestAsk || 0, bid = +t.bestBid || 0;
          spreadPct = (ask && bid) ? ((ask - bid) / ((ask + bid) / 2)) * 100 : 0;
          marketCapUSD = volumeUSD * 24;
          liquidityScore = spreadPct > 0 ? (volumeUSD / (spreadPct * 100)) : volumeUSD;
        } catch (e) {
          console.log(`⚠️ Erro ${m.symbol}: ${e.message}`);
        }

        results.push({
          symbol: m.symbol,
          lastPrice, atrRel, rsi, bbWidth, ema20,
          volumeUSD, marketCapUSD, liquidityScore, spreadPct,
          decision, score,
          visible: m.visible, orderBookState: m.orderBookState
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
