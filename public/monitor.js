// === monitor.js ===
// Mantém abas perp/spot/transfer com indicadores e cache por timeframe

import { renderTransfer } from "./monitorTransfer.js";

let currentTab = "perp",
  currentFilter = "all",
  hideNoLiquidity = false,
  hideNeutros = false,
  sortKey = "score",
  sortDir = "desc",
  loadId = 0,
  cachedData = [],
  currentTimeframe = "3m"; // 🕒 padrão inicial

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

// ======== FORMATOS ========
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(+ts);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// ======== CLASSIFICAÇÃO ========
function classifyMarket(m) {
  if (!m) return "normal";
  const vis =
    m.visible === true || m.visible === "true" || m.visible === 1 || m.visible === "1";
  const state = (m.orderBookState || "").toLowerCase();

  if (!vis && state === "closed") return "normal";
  if (!vis && state === "postonly") return "upcoming";
  if (vis && state === "postonly") return "new";
  if (vis && state === "open") return "normal";
  return "normal";
}

// ======== FILTROS ========
export function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll(".filters button").forEach(btn =>
    btn.classList.remove("active")
  );
  const btn = document.getElementById("btn-" + f);
  if (btn) btn.classList.add("active");
  if (currentTab !== "transfer") renderTable(cachedData);
}

export function toggleLiquidity() {
  hideNoLiquidity = !hideNoLiquidity;
  const btn = document.getElementById("btn-liq");
  btn.classList.toggle("active", hideNoLiquidity);
  btn.textContent = hideNoLiquidity
    ? "Mostrar sem liquidez"
    : "Ocultar sem liquidez";
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
function bbClass(bb) {
  if (bb < 0.01) return "bb-low";
  if (bb < 0.03) return "bb-mid";
  return "bb-high";
}

// ======== ATUALIZAÇÃO ========
export async function load(force = false, auto = false) {
  const id = ++loadId;
  const endpoint =
    currentTab === "perp"
      ? `/api/data?tf=${currentTimeframe}`
      : currentTab === "spot"
      ? `/api/spot?tf=${currentTimeframe}`
      : "/api/transfer";

  const tb = document.querySelector("#tbl tbody");
  const last = document.getElementById("lastUpdate");

  // 🔸 Chave de cache inclui timeframe
  const cacheKey = `cache_${currentTab}_${currentTimeframe}`;
  const cacheTimeKey = cacheKey + "_time";

  // Usa cache local enquanto carrega
  if (!force && localStorage.getItem(cacheKey)) {
    try {
      cachedData = JSON.parse(localStorage.getItem(cacheKey));
      renderActiveTab();
      last.textContent =
        "Atualizado às " + fmtTime(localStorage.getItem(cacheTimeKey));
    } catch {}
  }

  if (auto) last.innerHTML = '<span class="updating">🕒 Atualizando...</span>';

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
    if (!cachedData || cachedData.length === 0)
      tb.innerHTML =
        "<tr><td colspan='10' class='loading'>Erro ao carregar</td></tr>";
    last.innerHTML =
      '<span style="color:#f66">⚠️ Falha na atualização</span>';
  }
}

// ======== TABS ========
export function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tabs button").forEach(b => b.classList.remove("active"));
  const btn = document.getElementById("tab-" + tab);
  if (btn) btn.classList.add("active");

  const infoBox = document.getElementById("info-box");
  const filters = document.getElementById("filters");
  const table = document.getElementById("tbl");

  // Oculta tudo antes
  if (infoBox) infoBox.style.display = "none";
  if (filters) filters.style.display = "none";
  if (table) table.style.display = "none";

  if (tab === "perp" || tab === "spot") {
    infoBox.style.display = "block";
    filters.style.display = "block";
    table.style.display = "table";
    load(false);
  } else if (tab === "transfer") {
    filters.style.display = "block";
    table.style.display = "table";
    load(false);
  }
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

  const label =
    currentTab === "perp" ? "Open Interest 💥" : "Liquidity 💧";
  th.innerHTML = `<tr>
      <th>#</th>
      <th data-key="symbol">Symbol</th>
      <th data-key="lastPrice">Preço</th>
      <th data-key="atrRel">ATR%</th>
      <th data-key="bbWidth">BB Width</th>
      <th data-key="rsi">RSI</th>
      <th data-key="volumeUSD">Volume</th>
      <th data-key="${currentTab === "perp" ? "oiUSD" : "liquidityScore"}">${label}</th>
      <th data-key="decision">Decisão</th>
      <th data-key="score">Score</th>
    </tr>`;

  let filtered = [...data];
  if (currentFilter === "new")
    filtered = filtered.filter(m => classifyMarket(m) === "new");
  else if (currentFilter !== "all")
    filtered = filtered.filter(m => m.decision === currentFilter);

  if (hideNoLiquidity) filtered = filtered.filter(m => m.volumeUSD > 0);
  if (hideNeutros) filtered = filtered.filter(m => m.decision !== "neutral");

  if (sortKey) {
    filtered.sort((a, b) => {
      const va = a[sortKey],
        vb = b[sortKey];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number")
        return sortDir === "asc" ? va - vb : vb - va;
      if (typeof va === "string" && typeof vb === "string")
        return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      return 0;
    });
  }

  filtered.forEach((m, i) => {
    const status = classifyMarket(m);
    const tr = document.createElement("tr");

    tr.className =
      status === "upcoming"
        ? "upcoming"
        : status === "new"
        ? "new"
        : m.decision === "long"
        ? "green"
        : m.decision === "short"
        ? "red"
        : m.decision === "lateral"
        ? "blue"
        : "gray";

    const statusBadge =
      status === "upcoming" ? "🕒 Em breve" :
      status === "new" ? "🆕" : "";

    const oiOrLiq =
      currentTab === "perp"
        ? usdFmt.format(m.oiUSD || 0)
        : `${usdFmt.format(m.volumeUSD || 0)}<br><small>${(
            m.spreadPct || 0
          ).toFixed(3)}% • score ${(m.liquidityScore || 0).toFixed(3)}</small>`;

    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${m.symbol} <span class="status-badge">${statusBadge}</span></td>
      <td>${m.lastPrice ? "$" + m.lastPrice.toFixed(4) : "-"}</td>
      <td class="${atrClass(m.atrRel || 0)}">${m.atrRel ? (m.atrRel * 100).toFixed(3) + "%" : "-"}</td>
      <td class="${bbClass(m.bbWidth || 0)}">${m.bbWidth ? m.bbWidth.toFixed(4) : "-"}</td>
      <td class="${rsiClass(m.rsi || 0)}">${m.rsi ? m.rsi.toFixed(1) : "-"}</td>
      <td>${usdFmt.format(m.volumeUSD || 0)}</td>
      <td>${oiOrLiq}</td>
      <td>${(m.decision || "aguardando").toUpperCase()}</td>
      <td>${m.score || 0}</td>`;
    tb.appendChild(tr);
  });
}

// ======== TIMEFRAME HANDLER ========
window.changeTimeframe = function(tf) {
  currentTimeframe = tf;
  localStorage.setItem("selected_tf", tf);
  const last = document.getElementById("lastUpdate");
  if (last) last.innerHTML = '<span class="updating">🕒 Atualizando...</span>';
  load(true, true);
};

// ======== RESTAURA TIMEFRAME ========
document.addEventListener("DOMContentLoaded", () => {
  const saved = localStorage.getItem("selected_tf");
  if (saved) {
    currentTimeframe = saved;
    const sel = document.getElementById("timeframeSelect");
    if (sel) sel.value = saved;
  }
});

// ======== EVENTOS ========
document.addEventListener("click", e => {
  const th = e.target.closest("th[data-key]");
  if (!th || currentTab === "transfer") return;
  const key = th.getAttribute("data-key");
  if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
  else { sortKey = key; sortDir = "desc"; }
  renderTable(cachedData);
});

window.switchTab = switchTab;
window.manualRefresh = () => load(true, true);
window.setFilter = setFilter;
window.toggleLiquidity = toggleLiquidity;
window.toggleNeutros = toggleNeutros;

load(false);
setInterval(() => load(true, true), 180000);
