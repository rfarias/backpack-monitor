// === monitor.js ===
// Controla abas, filtros e atualização de dados
// Versão aprimorada com tooltips explicativas e nomes corrigidos

import { renderTransfer } from "./monitorTransfer.js";

let currentTab = "perp",
  currentFilter = "all",
  hideNoLiquidity = false,
  hideNeutros = false,
  sortKey = "score",
  sortDir = "desc",
  loadId = 0,
  cachedData = [];

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(+ts);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// ======== FILTROS ========
export function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll(".filters button").forEach(btn => btn.classList.remove("active"));
  const btn = document.getElementById("btn-" + f);
  if (btn) btn.classList.add("active");
  if (currentTab !== "transfer") renderTable(cachedData);
}

export function toggleLiquidity() {
  hideNoLiquidity = !hideNoLiquidity;
  const btn = document.getElementById("btn-liq");
  btn.classList.toggle("active", hideNoLiquidity);
  btn.textContent = hideNoLiquidity ? "Mostrar sem liquidez" : "Ocultar sem liquidez";
  if (currentTab !== "transfer") renderTable(cachedData);
}

export function toggleNeutros() {
  hideNeutros = !hideNeutros;
  const btn = document.getElementById("btn-neutro");
  btn.classList.toggle("active", hideNeutros);
  btn.textContent = hideNeutros ? "Mostrar neutros" : "Ocultar neutros";
  if (currentTab !== "transfer") renderTable(cachedData);
}

// ======== ESTILOS ========
function atrClass(atr) {
  const val = parseFloat(atr) * 100;
  if (isNaN(val)) return "";
  if (val <= 0.3) return "atr-low";
  if (val < 0.7) return "atr-mid";
  return "atr-high";
}

function rsiClass(rsi) {
  const val = parseFloat(rsi);
  if (isNaN(val)) return "";
  if (val <= 30) return "rsi-low";
  if (val >= 70) return "rsi-high";
  return "rsi-mid";
}

// ======== ATUALIZAÇÃO ========
export async function load(force = false, auto = false) {
  const id = ++loadId;
  const endpoint =
    currentTab === "perp"
      ? "/api/data"
      : currentTab === "spot"
      ? "/api/spot"
      : "/api/transfer";

  const tb = document.querySelector("#tbl tbody");
  const cacheKey = "cache_" + currentTab,
    cacheTimeKey = cacheKey + "_time";
  const last = document.getElementById("lastUpdate");
  if (auto) last.innerHTML = '<span class="updating">🕒 Atualizando...</span>';

  const cached = localStorage.getItem(cacheKey);
  if (cached && !force) {
    try {
      cachedData = JSON.parse(cached);
      renderActiveTab();
      last.textContent = "Atualizado às " + fmtTime(localStorage.getItem(cacheTimeKey));
    } catch {}
  } else if (!auto) {
    tb.innerHTML = "<tr><td colspan='10' class='loading'>Carregando...</td></tr>";
  }

  try {
    const resp = await fetch(endpoint);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (id !== loadId) return;
    if (Array.isArray(data) && data.length > 0) {
      cachedData = data;
      localStorage.setItem(cacheKey, JSON.stringify(data));
      const ts = Date.now();
      localStorage.setItem(cacheTimeKey, ts);
      renderActiveTab();
      last.textContent = "Atualizado às " + fmtTime(ts);
    }
  } catch (e) {
    console.warn("Erro ao atualizar:", e.message);
    if (!cached)
      tb.innerHTML = "<tr><td colspan='10' class='loading'>Erro ao carregar</td></tr>";
    last.innerHTML = '<span style="color:#f66">⚠️ Falha na atualização</span>';
  }
}

// ======== TABS ========
export function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tabs button").forEach(b => b.classList.remove("active"));
  document.getElementById("tab-" + tab).classList.add("active");

  const show = tab !== "transfer";
  document.getElementById("filters").style.display = "block";
  document.getElementById("info-box").style.display = show ? "block" : "none";

  const showBtn = show ? "inline-block" : "none";
  ["neutro", "liq", "long", "short", "lateral", "neutral"].forEach(id =>
    (document.getElementById("btn-" + id).style.display = showBtn)
  );
  document.getElementById("btn-new").style.display = tab === "transfer" ? "inline-block" : "none";

  cachedData = [];
  load(false);
}

function manualRefresh() {
  load(true, true);
}

// ======== RENDERIZAÇÃO ========
function renderActiveTab() {
  if (currentTab === "transfer") renderTransfer(cachedData);
  else renderTable(cachedData);
}

function renderTable(data) {
  if (!data || !Array.isArray(data)) return;
  const tb = document.querySelector("#tbl tbody"),
    th = document.querySelector("#tbl-head");
  tb.innerHTML = "";

  const label = currentTab === "perp" ? "Open Interest 💥" : "MarketCap / Spread 💧";
  th.innerHTML = `<tr>
      <th>#</th>
      <th data-key="symbol" title="Ativo monitorado na Backpack Exchange">Symbol</th>
      <th data-key="lastPrice" title="Último preço de negociação (USD)">Preço (USD)</th>
      <th data-key="atrRel" title="ATR%: volatilidade relativa do ativo">ATR%</th>
      <th data-key="bbWidth" title="BB Width: largura das Bandas de Bollinger">BB Width</th>
      <th data-key="rsi" title="RSI: Força Relativa (≤30 sobrevendido, ≥70 sobrecomprado)">RSI</th>
      <th data-key="volumeUSD" title="Volume em USD (últimas 24h)">Volume</th>
      <th data-key="${currentTab === "perp" ? "oiUSD" : "liquidityScore"}" 
          title="${currentTab === "perp"
            ? "Open Interest total em contratos perpétuos"
            : "MarketCap + Spread e Score de Liquidez"}">${label}</th>
      <th data-key="decision" title="Sinal do modelo: LONG, SHORT, LATERAL ou NEUTRO">Decisão</th>
      <th data-key="score" title="Score de confiança do sinal">Score</th>
    </tr>`;

  let filtered = [...data];
  if (currentFilter !== "all") filtered = filtered.filter(m => m.decision === currentFilter);
  if (hideNoLiquidity) filtered = filtered.filter(m => m.volumeUSD > 0);
  if (hideNeutros) filtered = filtered.filter(m => m.decision !== "neutral");

  filtered.sort((a, b) => {
    if (a.isNew && !b.isNew) return -1;
    if (!a.isNew && b.isNew) return 1;
    const order = { short: 0, long: 1, lateral: 2, neutral: 3, aguardando: 4 };
    const da = order[a.decision] ?? 5;
    const db = order[b.decision] ?? 5;
    if (da < db) return -1;
    if (da > db) return 1;
    if (sortKey && a[sortKey] !== undefined) {
      const va = a[sortKey], vb = b[sortKey];
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
    }
    return 0;
  });

  filtered.forEach((m, i) => {
    const tr = document.createElement("tr");
    tr.className =
      m.isAbandoned ? "abandoned" :
      m.isNew ? "new" :
      m.decision === "long" ? "green" :
      m.decision === "short" ? "red" :
      m.decision === "lateral" ? "blue" : "gray";

    // Tooltips individuais
    const atrTip = m.atrRel
      ? `ATR ${ (m.atrRel * 100).toFixed(2)}% — ${m.atrRel < 0.003 ? "baixa volatilidade" : m.atrRel < 0.007 ? "média volatilidade" : "alta volatilidade"}`
      : "Sem dados de ATR";
    const rsiTip = m.rsi
      ? `RSI ${m.rsi.toFixed(1)} — ${m.rsi < 30 ? "sobrevendido" : m.rsi > 70 ? "sobrecomprado" : "neutro"}`
      : "Sem dados de RSI";
    const bbTip = m.bbWidth
      ? `Bollinger Width ${(m.bbWidth * 100).toFixed(2)}% — ${m.bbWidth < 0.01 ? "mercado calmo" : m.bbWidth > 0.03 ? "mercado volátil" : "moderado"}`
      : "Sem dados de BB";

    const oiOrLiq =
      currentTab === "perp"
        ? usdFmt.format(m.oiUSD || 0)
        : `${usdFmt.format(m.marketCapUSD || 0)}<br><small>${(m.spreadPct || 0).toFixed(3)}% • score ${(m.liquidityScore || 0).toFixed(3)}</small>`;

    tr.innerHTML = `
      <td>${i + 1}</td>
      <td title="Ativo ${m.symbol}">${m.symbol}${m.isNew ? " 🆕" : ""}</td>
      <td title="Último preço em USD">${m.lastPrice > 0 ? "$" + m.lastPrice.toFixed(4) : "-"}</td>
      <td class="${atrClass(m.atrRel || 0)}" title="${atrTip}">${m.atrRel ? (m.atrRel * 100).toFixed(3) + "%" : "-"}</td>
      <td title="${bbTip}">${m.bbWidth?.toFixed(4) || "-"}</td>
      <td class="${rsiClass(m.rsi || 0)}" title="${rsiTip}">${m.rsi ? m.rsi.toFixed(1) : "-"}</td>
      <td title="Volume em USD">${usdFmt.format(m.volumeUSD || 0)}</td>
      <td title="${currentTab === "perp" ? "Open Interest total" : "MarketCap e spread"}">${oiOrLiq}</td>
      <td title="Sinal do modelo">${(m.decision || "aguardando").toUpperCase()}</td>
      <td title="Pontuação de confiança">${m.score || 0}</td>`;
    tb.appendChild(tr);
  });
}

// ======== EVENTOS ========
document.addEventListener("click", e => {
  const th = e.target.closest("th[data-key]");
  if (!th || currentTab === "transfer") return;
  const key = th.getAttribute("data-key");
  if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
  else {
    sortKey = key;
    sortDir = "desc";
  }
  renderTable(cachedData);
});

window.switchTab = switchTab;
window.manualRefresh = manualRefresh;
window.setFilter = setFilter;
window.toggleLiquidity = toggleLiquidity;
window.toggleNeutros = toggleNeutros;

load(false);
setInterval(() => load(true, true), 180000);
