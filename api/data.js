// /api/data.js
export default async function handler(req, res) {
  const baseUrl = "https://api.backpack.exchange/api/v1";

  // cache simples (30s)
  if (!global.__perpCache) global.__perpCache = { at: 0, data: [] };
  const now = Date.now();
  if (now - global.__perpCache.at < 30_000 && global.__perpCache.data.length) {
    return res.status(200).json(global.__perpCache.data);
  }

  try {
    // markets + open interest de uma vez
    const [marketsRes, oiRes] = await Promise.all([
      fetch(`${baseUrl}/markets`),
      fetch(`${baseUrl}/openInterest`)
    ]);
    if (!marketsRes.ok) throw new Error("Falha /markets");
    if (!oiRes.ok) throw new Error("Falha /openInterest");

    const markets = await marketsRes.json();
    const oiArr = await oiRes.json();
    const oiMap = {};
    (oiArr || []).forEach(o => { oiMap[o.symbol] = o; });

    const perp = (markets || []).filter(m => m.symbol.endsWith("_PERP"));

    const batchSize = 5;
    const out = [];

    const fetchK = async (symbol, interval = "3m", limit = 200) => {
      try {
        const resp = await fetch(`${baseUrl}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
        if (!resp.ok) {
          console.log(`⚠️ Falha ao buscar klines ${symbol}:`, resp.status);
          return [];
        }
        const data = await resp.json();
        // A Backpack retorna array plano
        if (Array.isArray(data)) {
          return data.map(c => ({
            open: +c.open,
            high: +c.high,
            low: +c.low,
            close: +c.close,
            volume: +c.volume,
            openTime: +c.openTime
          }));
        }
        return [];
      } catch (e) {
        console.log(`❌ Erro klines ${symbol}:`, e.message);
        return [];
      }
    };


    for (let i = 0; i < perp.length; i += batchSize) {
      const batch = perp.slice(i, i + batchSize);
      const partial = await Promise.all(batch.map(async m => {
        try {
          // ticker individual p/ preço/volume
          const tRes = await fetch(`${baseUrl}/ticker?symbol=${m.symbol}`);
          if (!tRes.ok) throw new Error(`Falha /ticker ${m.symbol}`);
          const t = await tRes.json();
          const lastPrice = parseFloat(t?.lastPrice) || 0;
          const volumeUSD = (parseFloat(t?.volume) || 0) * lastPrice;

          // klines 3m -> fallback 5m
          let kl = await fetchK(m.symbol, "3m", 200);
          if (kl.length < 15) kl = await fetchK(m.symbol, "5m", 200);
          if (kl.length < 15) return { symbol: m.symbol, error: "sem dados suficientes" };

          const closes = kl.map(k => +k.close);
          const highs  = kl.map(k => +k.high);
          const lows   = kl.map(k => +k.low);

          // RSI(14)
          let gains = 0, losses = 0;
          for (let i = 1; i < 15; i++) {
            const d = closes[i] - closes[i-1];
            if (d > 0) gains += d; else losses += -d;
          }
          const avgGain = gains / 14;
          const avgLoss = (losses / 14) || 1e-9;
          const rs = avgGain / avgLoss;
          const rsi = 100 - 100 / (1 + rs);

          // ATR(14)
          const trs = highs.map((h, i) =>
            Math.max(h - lows[i], Math.abs(h - (closes[i-1] ?? h)), Math.abs(lows[i] - (closes[i-1] ?? lows[i])))
          );
          const atr = trs.slice(-14).reduce((a,b)=>a+b,0) / 14;
          const atrRel = lastPrice ? atr / lastPrice : 0;

          // BB(20)
          const s = closes.slice(-20);
          const mean = s.reduce((a,b)=>a+b,0) / s.length;
          const std = Math.sqrt(s.reduce((a,b)=>a + (b-mean)**2, 0) / s.length);
          const bbWidth = (2 * std) / (mean || 1);

          // decisão/score
          let decision = "neutral";
          if (rsi <= 30 && atrRel < 0.006) decision = "long";
          else if (rsi >= 70 && atrRel < 0.006) decision = "short";
          else if (atrRel <= 0.004) decision = "lateral";
          const score = Math.round((100 - Math.abs(50 - rsi)) * (1 - Math.min(atrRel * 100, 1)));

          const oiUSD = ((oiMap[m.symbol]?.openInterest) || 0) * lastPrice;

          return {
            symbol: m.symbol,
            lastPrice,
            volumeUSD,
            oiUSD,
            rsi,
            atrRel,
            bbWidth,
            decision,
            score
          };
        } catch (e) {
          return { symbol: m.symbol, error: e.message };
        }
      }));
      out.push(...partial);
    }

    // cache
    global.__perpCache = { at: Date.now(), data: out };
    return res.status(200).json(out);
  } catch (err) {
    console.error("Erro /api/data:", err.message);
    return res.status(500).json({ error: "Falha ao carregar dados de perpétuos" });
  }
}
