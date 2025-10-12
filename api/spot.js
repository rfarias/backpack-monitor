import axios from "axios";

export default async function handler(req, res) {
  try {
    const marketResp = await axios.get("https://api.backpack.exchange/api/v1/markets");
    const allMarkets = marketResp.data || [];
    const spot = allMarkets.filter(m => !m.symbol.endsWith("_PERP"));

    const combined = [];
    for (const m of spot.slice(0, 30)) {
      try {
        const tResp = await axios.get("https://api.backpack.exchange/api/v1/ticker", { params: { symbol: m.symbol } });
        const ticker = Array.isArray(tResp.data) ? tResp.data[0] : tResp.data;
        const lastPrice = +ticker.lastPrice || 0;
        const volumeUSD = (+ticker.volume || 0) * lastPrice;
        combined.push({ symbol: m.symbol, lastPrice, volumeUSD, decision: "neutral", score: 0 });
      } catch {}
    }

    res.status(200).json(combined);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
