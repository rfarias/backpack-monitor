// /api/transfer.js
import fetch from "node-fetch";

const BASE_URL = "https://api.backpack.exchange/api/v1";
const UPDATE_INTERVAL = 180000;
let cache = { ts: 0, data: [] };

export default async function handler(req, res) {
  try {
    const now = Date.now();
    if (now - cache.ts < UPDATE_INTERVAL && cache.data.length > 0)
      return res.status(200).json(cache.data);

    const resp = await fetch(`${BASE_URL}/assets`);
    if (!resp.ok) throw new Error("Erro ao buscar assets");
    const assets = await resp.json();

    const results = [];

    for (const a of assets) {
      const symbol = (a.symbol || "").toUpperCase();
      const tokens = a.tokens || [];

      if (!Array.isArray(tokens) || tokens.length === 0) continue;

      tokens.forEach(t => {
        results.push({
          symbol,
          blockchain: t.blockchain || "N/A",
          depositEnabled: !!t.depositEnabled,
          withdrawEnabled: !!t.withdrawEnabled,
          withdrawalFee: t.withdrawalFee || "-",
          minWithdraw: t.minimumWithdrawal || "-",
          maxWithdraw: t.maximumWithdrawal || "-",
          minDeposit: t.minimumDeposit || "-",
        });
      });
    }

    cache = { ts: now, data: results };
    res.status(200).json(results);
  } catch (e) {
    console.error("Erro /api/transfer:", e.message);
    res.status(500).json({ error: e.message });
  }
}
