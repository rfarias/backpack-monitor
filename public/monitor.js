// === monitor.js ===
// Atualizado: status direto da API Backpack + cache local leve + DEBUG de classificação
// "Em breve" = visible=false & orderBookState=PostOnly
// "Novo" = visible=true & orderBookState=PostOnly
// "Normal" = visible=true & orderBookState=Open
// Adicionado: seleção de timeframe e atualização suave

import { renderTransfer } from "./monitorTransfer.js";

let currentTab = "perp",
  currentFilter = "all",
  hideNoLiquidity = false,
  hideNeutros = false,
  sortKey = "score",
  sortDir = "desc",
  loadId = 0,
  cachedData = [],
  currentTimeframe = "3m"; // 🕒 timeframe padrão

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

  // Garante que não tenha problema de tipo string vs boolean
  const vis =
    m.visible === true || m.visible === "true" || m.visible === 1 || m.visible === "1";
  const state = (m.orderBookState || "").toLowerCase();

  if (!vis && state === "closed") return "normal"; // deslistado
  if (!vis && state === "postonly") return "upcoming"; // em breve
  if (vis && state === "postonly") return "new"; // novo
  if (vis && state === "open") return "normal"; // ativo
  return "normal";
}

// ======== DEBUG ========
function debugMarketStatus(data) {
  console.groupCollapsed("🔍 Verificação de status de mercados");
  data.forEach(m => {
    const status = classifyMarket(m);
    console.log(
      `${m.symbol}: visible=${m.visible}, orderBookState=${m.orderBookState} → ${status}`
    );
  });
  console.groupEnd();
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

  const cacheKey = "cache_" + currentTab;
  const cacheTimeKey = cacheKey + "_time";

  // 🔸 Usa cache enquanto carrega (sem piscar)
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

      // 🧩 Logar no console a classificação
      debugMarketStatus(data);

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
  document
    .querySelectorAll(".tabs button")
    .forEach(b => b.classList.remove("active"));
  document.getElementById("tab-" + tab).classList.add("active");

  const show = tab !== "transfer";
  document.getElementById("filters").style.display = "block";
  document.getElementById("info-box").style.display = show ? "block" : "none";

  const showBtn = show ? "inline-block" : "none";
  ["neutro", "liq", "long", "short", "lateral", "neutral"].forEach(
    id => (document.getElementById("btn-" + id).style.display = showBtn)
  );
  document.getElementById("btn-new").style.display =
    tab === "transfer" ? "inline-block" : "none";

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

  const label =
    currentTab === "perp" ? "Open Interest 💥" : "MarketCap / Spread 💧";
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
        return sortDir === "asc"
          ? va.localeCompare(vb)
          : vb.localeCompare(va);
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
      status === "upcoming"
        ? "🕒 Em breve"
        : status === "new"
        ? "🆕"
        : "";

    const oiOrLiq =
      currentTab === "perp"
        ? usdFmt.format(m.oiUSD || 0)
        : `${usdFmt.format(m.marketCapUSD || 0)}<br><small>${(
            m.spreadPct || 0
          ).toFixed(3)}% • score ${(m.liquidityScore || 0).toFixed(3)}</small>`;

    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${m.symbol} <span class="status-badge">${statusBadge}</span></td>
      <td>${m.lastPrice ? "$" + m.lastPrice.toFixed(4) : "-"}</td>
      <td class="${atrClass(m.atrRel || 0)}">${
      m.atrRel ? (m.atrRel * 100).toFixed(3) + "%" : "-"
    }</td>
      <td class="${bbClass(m.bbWidth || 0)}">${
      m.bbWidth ? m.bbWidth.toFixed(4) : "-"
    }</td>
      <td class="${rsiClass(m.rsi || 0)}">${
      m.rsi ? m.rsi.toFixed(1) : "-"
    }</td>
      <td>${usdFmt.format(m.volumeUSD || 0)}</td>
      <td>${oiOrLiq}</td>
      <td>${(m.decision || "aguardando").toUpperCase()}</td>
      <td>${m.score || 0}</td>`;
    tb.appendChild(tr);
  });
}

// ======== TIMEFRAME HANDLER ========
// Agora troca o timeframe e força atualização completa com indicador "Atualizando..."
window.changeTimeframe = function(tf) {
  currentTimeframe = tf;
  localStorage.setItem("selected_tf", tf);

  const last = document.getElementById("lastUpdate");
  if (last) last.innerHTML = '<span class="updating">🕒 Atualizando...</span>';

  // mesmo comportamento do botão "Atualizar agora"
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
