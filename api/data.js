// /api/data.js
export default async function handler(req, res) {
  try {
    const baseUrl = "https://api.backpack.exchange/api/v1";

    // === Obter todos os mercados ===
    const futRes = await fetch(`${baseUrl}/markets`);
    console.log("Status /markets:", futRes.status);

    if (!futRes.ok) {
      const text = await futRes.text();
      console.error("Erro /markets:", text);
      throw new Error("Falha ao acessar mercados perpétuos");
    }

    const markets = await futRes.json();
    const perpMarkets = markets.filter(m => m.symbol.endsWith("_PERP"));

    // === Processar em lotes para evitar sobrecarga ===
    const batchSize = 5;
    const result = [];

    for (let i = 0; i < perpMarkets.length; i += batchSize) {
      const batch = perpMarkets.slice(i, i + batchSize);
      const partial = await Promise.all(
        batch.map(async m => {
          try {
            const url = `${baseUrl}/kline?symbol=${m.symbol}&interval=3m&limit=200`;
            const resp = await fetch(url);
            console.log(`Status /kline ${m.symbol}:`, resp.status);

            if (!resp.ok) throw new Error(`Falha candles ${m.symbol}`);

            const candles = await resp.json();
            const dataCandles = Array.isArray(candles.data) ? candles.data : candles;
            if (!Array.isArray(dataCandles) || dataCandles.length < 15)
              return { symbol: m.symbol, error: "sem dados suficientes" };

            const closes = dataCandles.map(c => parseFloat(c.close));
            const highs = dataCandles.map(c => parseFloat(c.high));
            const lows = dataCandles.map(c => parseFloat(c.low));

            // === RSI (14) ===
            let gains = 0, losses = 0;
            for (let i = 1; i < 15; i++) {
              const diff = closes[i] - closes[i - 1];
              if (diff > 0) gains += diff;
              else losses += Math.abs(diff);
            }
            const avgGain = gains / 14;
            const avgLoss = losses / 14 || 1e-9;
            const rs = avgGain / avgLoss;
            const rsi = 100 - 100 / (1 + rs);

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

            // === Bollinger Bands (20) ===
            const slice = closes.slice(-20);
            const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
            const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length);
            const bbWidth = (2 * std) / mean;

            // === Decisão ===
            let decision = "neutral";
            if (rsi <= 30 && atrRel < 0.006) decision = "long";
            else if (rsi >= 70 && atrRel < 0.006) decision = "short";
            else if (atrRel <= 0.004) decision = "lateral";

            const score = Math.round(
              (100 - Math.abs(50 - rsi)) * (1 - Math.min(atrRel * 100, 1))
            );

            return {
              symbol: m.symbol,
              lastPrice: parseFloat(m.lastPrice),
              volumeUSD: parseFloat(m.volumeUsd) || 0,
              oiUSD: parseFloat(m.openInterestUsd) || 0,
              rsi,
              atrRel,
              bbWidth,
              decision,
              score
            };
          } catch (e) {
            return { symbol: m.symbol, error: e.message };
          }
        })
      );

      result.push(...partial);
    }

    res.status(200).json(result);
  } catch (err) {
    console.error("Erro em /api/data:", err);
    res.status(500).json({ error: "Falha ao carregar dados de perpétuos" });
  }
}
