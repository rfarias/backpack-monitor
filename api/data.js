import axios from "axios";

export default async function handler(req, res) {
  try {
    const [oiResp, marketResp] = await Promise.all([
      axios.get("https://api.backpack.exchange/api/v1/openInterest"),
      axios.get("https://api.backpack.exchange/api/v1/markets")
    ]);

    const allMarkets = marketResp.data || [];
    const perp = allMarkets.filter(m => m.symbol.endsWith("_PERP"));
    const oiMap = {};
    (oiResp.data || []).forEach(m => (oiMap[m.symbol] = m));

    const combined = await Promise.all(
      perp.slice(0, 20).map(async (m) => {
        try {
          const tResp = await axios.get("https://api.backpack.exchange/api/v1/ticker", { params: { symbol: m.symbol } });
          const ticker = Array.isArray(tResp.data) ? tResp.data[0] : tResp.data;
          const lastPrice = +ticker.lastPrice || 0;
          const volumeUSD = (+ticker.volume || 0) * lastPrice;
          const oiUSD = (+oiMap[m.symbol]?.openInterest || 0) * lastPrice;
          return { symbol: m.symbol, lastPrice, volumeUSD, oiUSD, decision: "neutral", score: 0 };
        } catch (e) {
          console.log("Erro ticker:", m.symbol, e.message);
          return { symbol: m.symbol, lastPrice: 0, volumeUSD: 0, oiUSD: 0, decision: "neutral", score: 0 };
        }
      })
    );

    res.status(200).json(combined);
  } catch (e) {
    console.error("Erro API /data:", e.message);
    res.status(500).json({ error: e.message });
  }
}
