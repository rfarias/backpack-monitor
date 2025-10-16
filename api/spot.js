// === backpackMonitor - SPOT ANALYZER ===
// Atualizado para incluir métricas de liquidez e eficiência de pontuação

const API_BASE = "https://api.backpack.exchange/api/v1";
const SPOT_UPDATE_INTERVAL = 60000; // Atualiza a cada 60s

async function fetchJSON(url, params = {}) {
  const q = new URLSearchParams(params).toString();
  const fullUrl = q ? `${url}?${q}` : url;
  const res = await fetch(fullUrl);
  if (!res.ok) throw new Error(`Erro ao buscar ${url}`);
  return await res.json();
}

async function getSpotMarkets() {
  const markets = await fetchJSON(`${API_BASE}/markets`);
  return markets.filter(m => m.type === "spot");
}

async function getTickers() {
  return await fetchJSON(`${API_BASE}/tickers`);
}

async function getDepth(symbol, limit = 20) {
  try {
    return await fetchJSON(`${API_BASE}/depth`, { symbol, limit });
  } catch {
    return { bids: [], asks: [] };
  }
}

// --- Cálculo de métricas de liquidez e eficiência ---
function calcMetrics(ticker, depthData) {
  const bids = depthData.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
  const asks = depthData.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));

  if (!bids.length || !asks.length) return null;

  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  const mid = (bestBid + bestAsk) / 2;

  // Soma liquidez em ±0.2% do midprice
  const lower = mid * 0.998;
  const upper = mid * 1.002;
  let depthNear = 0;
  let bidsSum = 0, asksSum = 0;

  for (const { price, qty } of bids) {
    if (price >= lower) depthNear += price * qty;
    bidsSum += price * qty;
  }
  for (const { price, qty } of asks) {
    if (price <= upper) depthNear += price * qty;
    asksSum += price * qty;
  }

  const imbalance = (bidsSum - asksSum) / (bidsSum + asksSum + 1e-9);
  const volume24h = parseFloat(ticker.volume) || 1;
  const spotOIproxy = depthNear / volume24h;
  const score = (1 / (1 + spotOIproxy)) * (1 + Math.abs(imbalance));

  return { depthNear, imbalance, spotOIproxy, score, mid };
}

// --- Atualiza tabela Spot ---
async function updateSpotTable() {
  const table = document.getElementById("spotTable");
  if (!table) return;

  const tickers = await getTickers();
  const spotMarkets = await getSpotMarkets();

  const spotTickers = tickers.filter(t => spotMarkets.find(m => m.symbol === t.symbol));
  const data = [];

  for (const t of spotTickers) {
    const depthData = await getDepth(t.symbol);
    const metrics = calcMetrics(t, depthData);
    if (!metrics) continue;

    data.push({
      symbol: t.symbol,
      price: parseFloat(t.lastPrice).toFixed(4),
      volume: parseFloat(t.volume).toFixed(2),
      depthNear: metrics.depthNear.toFixed(2),
      imbalance: metrics.imbalance.toFixed(3),
      spotOIproxy: metrics.spotOIproxy.toFixed(6),
      score: metrics.score.toFixed(3)
    });
  }

  // Ordenar por score (melhores no topo)
  data.sort((a, b) => b.score - a.score);

  // Renderizar tabela
  table.innerHTML = `
    <tr>
      <th>Mercado</th>
      <th>Preço</th>
      <th>Volume 24h</th>
      <th>Depth ±0.2%</th>
      <th>Imbalance</th>
      <th>Spot OI Proxy</th>
      <th>Score</th>
    </tr>
  `;

  for (const d of data.slice(0, 20)) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${d.symbol}</td>
      <td>${d.price}</td>
      <td>${d.volume}</td>
      <td>${d.depthNear}</td>
      <td>${d.imbalance}</td>
      <td>${d.spotOIproxy}</td>
      <td><b>${d.score}</b></td>
    `;
    table.appendChild(row);
  }

  console.log("[SPOT] Atualizado", new Date().toLocaleTimeString(), "Top mercado:", data[0]?.symbol);
}

// --- Inicialização automática ---
document.addEventListener("DOMContentLoaded", () => {
  updateSpotTable();
  setInterval(updateSpotTable, SPOT_UPDATE_INTERVAL);
});
