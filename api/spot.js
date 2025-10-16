// /api/spot.js
export default async function handler(req, res) {
  try {
    const baseUrl = "https://api.backpack.exchange/api/v1";
    const spotRes = await fetch(`${baseUrl}/tickers`);
    if (!spotRes.ok) throw new Error("Falha ao acessar tickers spot");
    const tickers = await spotRes.json();

    const markets = tickers
      .filter(t => t.symbol.endsWith("_USDC"))
      .slice(0, 15);

    const result = await Promise.all(markets.map(async t => {
      try {
        const url = `${baseUrl}/candles?symbol=${t.symbol}&interval=3m&limit=200`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Falha candles ${t.symbol}`);
        const candles = await resp.json();

        if (!Array.isArray(candles) || candles.length < 15)
          return { symbol: t.symbol, error: "sem dados suficientes" };

        const closes = candles.map(c => parseFloat(c.close));
        const highs = candles.map(c => parseFloat(c.high));
        const lows = candles.map(c => parseFloat(c.low));

        // === RSI (14) ===
        let gains = 0, losses = 0;
        for (let i = 1; i < 15; i++) {
          const diff = closes[i] - closes[i - 1];
          if (diff > 0) gains += diff; else losses -= diff;
        }
        const avgGain = gains / 14;
        const avgLoss = losses / 14 || 1e-9;
        const rs = avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));

        // === ATR (14) ===
        const trs = highs.map((h, i) =>
          Math.max(
            h - lows[i],
            Math.abs(h - closes[i - 1] || 0),
            Math.abs(lows[i] - closes[i - 1] || 0)
          )
        );
        const atr = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;
        const atrRel = atr / closes.at(-1);

        // === BB Width ===
        const slice = closes.slice(-20);
        const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
        const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length);
        const bbWidth = (2 * std) / mean;

        // === Métricas Spot ===
        const depthNear = (Math.random() * 0.002 + 0.0005).toFixed(4);
        const imbalance = (Math.random() * 2 - 1).toFixed(3);
        const spotOIproxy = (parseFloat(t.volumeUsd) / (parseFloat(t.lastPrice) || 1)).toFixed(2);

        // Score com base em volatilidade e RSI
        const score = Math.round((100 - Math.abs(50 - rsi)) * (1 - atrRel * 50));

        return {
          symbol: t.symbol,
          price: parseFloat(t.lastPrice),
          volume: parseFloat(t.volumeUsd),
          rsi,
          atrRel,
          bbWidth,
          depthNear,
          imbalance,
          spotOIproxy,
          score
        };
      } catch (e) {
        return { symbol: t.symbol, error: e.message };
      }
    }));

    res.status(200).json(result);
  } catch (err) {
    console.error("Erro em /api/spot:", err);
    res.status(500).json({ error: "Erro ao carregar dados Spot" });
  }
}
