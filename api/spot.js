import axios from "axios";

export default async function handler(req, res) {
  try {
    const marketResp = await axios.get("https://api.backpack.exchange/api/v1/markets");
    const allMarkets = marketResp.data || [];
    const spot = allMarkets.filter(m => !m.symbol.endsWith("_PERP"));

    const combined = await Promise.all(
      spot.slice(0, 30).map(async (m) => {
        try {
          const tResp = await axios.get("https://api.backpack.exchange/api/v1/ticker", { params: { symbol: m.symbol } });
          const ticker = Array.isArray(tResp.data) ? tResp.data[0] : tResp.data;
          const lastPrice = +ticker.lastPrice || 0;
          const volumeUSD = (+ticker.volume || 0) * lastPrice;
          return { symbol: m.symbol, lastPrice, volumeUSD, decision: "neutral", score: 0 };
        } catch (e) {
          console.log("Erro ticker:", m.symbol, e.message);
          return { symbol: m.symbol, lastPrice: 0, volumeUSD: 0, decision: "neutral", score: 0 };
        }
      })
    );

    res.status(200).json(combined);
  } catch (e) {
    console.error("Erro API /spot:", e.message);
    res.status(500).json({ error: e.message });
  }
}
