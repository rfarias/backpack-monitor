import axios from "axios";

export default async function handler(req, res) {
  try {
    const resp = await axios.get("https://api.backpack.exchange/api/v1/assets");
    const assets = resp.data || [];
    const formatted = assets.map(a => ({
      symbol: a.symbol || a.asset,
      networks: (a.networks || []).map(n => ({
        chain: n.network || n.chain,
        deposit: n.depositEnabled,
        withdraw: n.withdrawEnabled,
      })),
    }));
    res.status(200).json(formatted);
  } catch (e) {
    console.error("Erro API /transfer:", e.message);
    res.status(500).json({ error: e.message });
  }
}
