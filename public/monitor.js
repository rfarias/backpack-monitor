// === monitor.js ===
// Corrigido: Volume 24h ativo, botões toggle, ocultação correta em Transfers e cache suave.
// Ajuste: temporizador sincronizado — seletor desbloqueia exatamente quando a barra termina (CSS separado).

import { renderTransfer } from "./monitorTransfer.js";
import { renderVolumeTab } from "./monitorVolume.js";

let currentTab = "perp",
  currentFilter = "all",
  hideNoLiquidity = false,
  hideNeutros = false,
  sortKey = "score",
  sortDir = "desc",
  loadId = 0,
  cachedData = [],
  currentTimeframe = "3m", // 🕒 padrão
  isLoading = false,
  lastTfChange = 0,
  tfCooldownTimer = null;

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

// ======== FORMATOS ========
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(+ts);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// ======== CLASSIFICAÇÃO ========
function classifyMarket(m) {
  if (!m) return "normal";
  const vis = m.visible === true || m.visible === "true" || m.visible === 1 || m.visible === "1";
  const state = (m.orderBookState || "").toLowerCase();
  if (!vis && state === "postonly") return "upcoming";
  if (vis && state === "postonly") return "new";
  if (vis && state === "open") return "normal";
  return "normal";
}

// ======== ESCALONAMENTO POR TIMEFRAME ========
function getScale(tf) {
  const map = { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "12h": 720, "1d": 1440 };
  const mins = map[tf] || 3;
  return Math.log10(mins) / 2 + 1;
}

// ======== ESTILOS ========
function atrClass(v) {
  const s = getScale(currentTimeframe), val = (v || 0) * 100;
  if (val <= 0.3 * s) return "atr-low";
  if (val < 0.7 * s) return "atr-mid";
  return "atr-high";
}
function rsiClass(v) {
  if (v <= 30) return "rsi-low";
  if (v >= 70) return "rsi-high";
  return "rsi-mid";
}
function bbClass(v) {
  const s = getScale(currentTimeframe);
  if (v < 0.01 * s) return "bb-low";
  if (v < 0.03 * s) return "bb-mid";
  return "bb-high";
}

// ======== CACHE ========
function getCache(tab) {
  try {
    const raw = localStorage.getItem("cache_" + tab);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ======== ATUALIZA VOLUME TOPO ========
async function updateVolumeHeader() {
  const volTxt = document.getElementById("volumeTopText");
  if (volTxt) volTxt.textContent = "Volume 24h — carregando...";

  try {
    const res = await fetch("/api/volume?days=1&_t=" + Date.now(), { cache: "no-store" }); // ✅ correção Vercel
    if (!res.ok) throw new Error("Falha ao buscar volume");
    const json = await res.json();
    const data = json.data || [];
    if (!data.length) throw new Error("Sem dados de volume");

    const last = data[data.length - 1];
    const spot = last.spot || 0;
    const perp = last.perp || 0;
    const total = last.total || 0;

    const fmt = v => (v >= 1e9 ? (v / 1e9).toFixed(2) + " B" : v >= 1e6 ? (v / 1e6).toFixed(2) + " M" : v.toFixed(2));

    if (volTxt)
      volTxt.innerHTML = `
        Volume 24h — 
        <span style="color:#3cf;">Spot: ${fmt(spot)} USD</span> • 
        <span style="color:#9f6cff;">Perp: ${fmt(perp)} USD</span> • 
        <span style="color:#0f8;">Total: ${fmt(total)} USD</span>`;
  } catch (e) {
    if (document.getElementById("volumeTopText"))
      document.getElementById("volumeTopText").textContent = "Volume 24h — erro ao carregar.";
    console.warn("Erro ao buscar volume:", e.message);
  }
}

// ======== LOAD PRINCIPAL ========
export async function load(force = false, auto = false) {
  const id = ++loadId;
  const endpoint =
    currentTab === "perp"
      ? `/api/data?tf=${currentTimeframe}&_t=${Date.now()}`
      : currentTab === "spot"
      ? `/api/spot?tf=${currentTimeframe}&_t=${Date.now()}`
      : "/api/transfer";

  const tb = document.querySelector("#tbl tbody");
  const last = document.getElementById("lastUpdate");
  const cacheKey = "cache_" + currentTab;
  const cacheTimeKey = cacheKey + "_time";

  if (!force) {
    const cached = getCache(currentTab);
    if (cached && cached.length > 0) {
      cachedData = cached;
      renderActiveTab();
      const ts = localStorage.getItem(cacheTimeKey);
      if (ts && last) last.textContent = "Atualizado às " + fmtTime(ts);
    }
  }

  if (auto && last) last.innerHTML = '<span class="updating">🕒 Atualizando...</span>';

  try {
    const resp = await fetch(endpoint, { cache: "no-store" }); // ✅ correção Vercel
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (id !== loadId) return;

    if (Array.isArray(data) && data.length > 0) {
      cachedData = data;
      localStorage.setItem(cacheKey, JSON.stringify(data));
      const ts = Date.now();
      localStorage.setItem(cacheTimeKey, ts);
      renderActiveTab();
      if (last) last.textContent = "Atualizado às " + fmtTime(ts);
    }
  } catch (e) {
    console.warn("Erro ao atualizar:", e.message);
    if (last) last.innerHTML = `<span style="color:#f66">⚠️ ${e.message}</span>`;
  }
}

// ======== TROCA DE ABA ========
export function switchTab(tab) {
  currentTab = tab;

  document.querySelectorAll("#header-menu button").forEach(b => {
    b.classList.toggle("active", b.id === "tab-" + tab);
  });

  const info = document.getElementById("info-box");
  const filters = document.getElementById("filters");
  const tbl = document.getElementById("tbl");
  const vol = document.getElementById("volumeContainer");

  if (tab === "volume") {
    if (tbl) tbl.style.display = "none";
    if (filters) filters.style.display = "none";
    if (info) info.style.display = "none";
    if (vol) {
      vol.style.display = "block";
      renderVolumeTab();
    }
    updateVolumeHeader();
    return;
  }

  if (vol) vol.style.display = "none";
  if (tbl) tbl.style.display = "table";
  if (info) info.style.display = tab === "transfer" ? "none" : "block";

  const filterButtons = document.querySelectorAll("#filters button");
  filterButtons.forEach(btn => {
    if (!btn) return;
    const texto = (btn.textContent || "").trim();
    if (tab === "transfer") {
      if (texto.includes("🔄 Atualizar agora")) {
        btn.style.display = "inline-block";
      } else {
        btn.style.display = "none";
      }
    } else {
      btn.style.display = "inline-block";
    }
  });

  if (filters) filters.style.display = "block";

  const cached = getCache(tab);
  if (cached && cached.length > 0) {
    cachedData = cached;
    renderActiveTab();
  }

  load(false);
}

// ======== REFRESH MANUAL ========
function manualRefresh() {
  load(true, true);
}

// ======== RENDER ========
function renderActiveTab() {
  if (currentTab === "transfer") renderTransfer(cachedData);
  else renderTable(cachedData);
}

function renderTable(data) {
  if (!data || !Array.isArray(data)) return;
  const tb = document.querySelector("#tbl tbody"),
    th = document.querySelector("#tbl-head");
  if (!tb || !th) return;

  tb.innerHTML = "";
  const label = currentTab === "perp" ? "Open Interest 💥" : "MarketCap / Spread 💧";

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

  filtered.sort((a, b) => {
    const va = a[sortKey], vb = b[sortKey];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number")
      return sortDir === "asc" ? va - vb : vb - va;
    return sortDir === "asc"
      ? String(va).localeCompare(String(vb))
      : String(vb).localeCompare(String(va));
  });

  filtered.forEach((m, i) => {
    const status = classifyMarket(m);
    const tr = document.createElement("tr");
    tr.className =
      status === "upcoming" ? "upcoming" :
      status === "new" ? "new" :
      m.decision === "long" ? "green" :
      m.decision === "short" ? "red" :
      m.decision === "lateral" ? "blue" : "gray";

    const badge = status === "upcoming" ? "🕒 Em breve" : status === "new" ? "🆕" : "";
    const oiOrLiq =
      currentTab === "perp"
        ? usdFmt.format(m.oiUSD || 0)
        : `${usdFmt.format(m.marketCapUSD || 0)}<br><small>${(m.spreadPct || 0).toFixed(3)}% • score ${(m.liquidityScore || 0).toFixed(3)}</small>`;

    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${m.symbol} <span class="status-badge">${badge}</span></td>
      <td>${m.lastPrice ? "$" + m.lastPrice.toFixed(4) : "-"}</td>
      <td class="${atrClass(m.atrRel || 0)}">${m.atrRel ? (m.atrRel * 100).toFixed(3) + "%" : "-"}</td>
      <td class="${bbClass(m.bbWidth || 0)}">${m.bbWidth ? m.bbWidth.toFixed(4) : "-"}</td>
      <td class="${rsiClass(m.rsi || 0)}">${m.rsi ? m.rsi.toFixed(1) : "-"}</td>
      <td>${usdFmt.format(m.volumeUSD || 0)}</td>
      <td>${oiOrLiq}</td>
      <td>${
      (m.atrRel && m.bbWidth && m.rsi)
        ? (m.decision || "aguardando").toUpperCase()
        : "AGUARDANDO"
      }</td>
      <td>${m.score || 0}</td>`;
    tb.appendChild(tr);
  });
}

// ======== FILTROS ========
window.setFilter = f => {
  if (currentFilter === f) {
    currentFilter = "all";
    document.querySelectorAll(".filters button").forEach(btn => btn.classList.remove("active"));
    document.getElementById("btn-all").classList.add("active");
  } else {
    currentFilter = f;
    document.querySelectorAll(".filters button").forEach(btn => btn.classList.remove("active"));
    const btn = document.getElementById("btn-" + f);
    if (btn) btn.classList.add("active");
  }
  renderTable(cachedData);
};

window.toggleLiquidity = () => {
  hideNoLiquidity = !hideNoLiquidity;
  const btn = document.getElementById("btn-liq");
  if (btn) btn.textContent = hideNoLiquidity ? "Mostrar sem liquidez" : "Ocultar sem liquidez";
  renderTable(cachedData);
};

window.toggleNeutros = () => {
  hideNeutros = !hideNeutros;
  const btn = document.getElementById("btn-neutro");
  if (btn) btn.textContent = hideNeutros ? "Mostrar neutros" : "Ocultar neutros";
  renderTable(cachedData);
};

// ======== TEMPORIZADOR ========
function startTfCooldown(seconds, tfSelect) {
  const sel = tfSelect || document.getElementById("timeframeSelect");
  if (!sel) return;
  const old = document.getElementById("tfCooldown");
  if (old && old.parentNode) old.parentNode.removeChild(old);

  const wrap = document.createElement("span");
  wrap.id = "tfCooldown";
  wrap.className = "tf-cooldown-wrap";

  const bar = document.createElement("span");
  bar.className = "tf-cooldown-bar";
  wrap.appendChild(bar);
  sel.parentNode.insertBefore(wrap, sel.nextSibling);

  let remaining = seconds;
  if (tfCooldownTimer) clearInterval(tfCooldownTimer);

  tfCooldownTimer = setInterval(() => {
    remaining -= 1;
    bar.style.width = Math.max(0, (remaining / seconds) * 100) + "%";
    if (remaining <= 0) {
      clearInterval(tfCooldownTimer);
      tfCooldownTimer = null;
      if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
      sel.disabled = false; // 🔓 desbloqueia o seletor exatamente no final
    }
  }, 1000);
}

// ======== TIMEFRAME ========
window.changeTimeframe = async tf => {
  const now = Date.now();
  if (now - lastTfChange < 30000) {
    console.warn("Troca de timeframe bloqueada por 30s.");
    return;
  }
  if (isLoading) {
    console.warn("Atualização já em andamento. Aguardando...");
    return;
  }

  currentTimeframe = tf;
  localStorage.setItem("selected_tf", tf);
  lastTfChange = now;

  const last = document.getElementById("lastUpdate");
  const refreshBtn = document.querySelector("#filters button[onclick*='manualRefresh']");
  const tfSelect = document.getElementById("timeframeSelect");

  if (last) last.textContent = "Atualizando...";
  if (refreshBtn) refreshBtn.disabled = true;
  if (tfSelect) {
    tfSelect.disabled = true;
    startTfCooldown(30, tfSelect);
  }

  try {
    isLoading = true;
    await load(true, true);
    if (last) last.textContent = "Atualizado às " + fmtTime(Date.now());
  } catch (e) {
    if (last) last.textContent = "Erro ao atualizar";
    console.warn("Erro ao atualizar timeframe:", e.message);
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
    isLoading = false;
  }
};

// ======== EVENTOS ========
document.addEventListener("click", e => {
  const th = e.target.closest("th[data-key]");
  if (!th || currentTab === "transfer" || currentTab === "volume") return;
  const key = th.getAttribute("data-key");
  sortDir = sortKey === key && sortDir === "desc" ? "asc" : "desc";
  sortKey = key;
  renderTable(cachedData);
});

window.manualRefresh = manualRefresh;
window.switchTab = switchTab;

document.addEventListener("DOMContentLoaded", () => {
  const saved = localStorage.getItem("selected_tf");
  if (saved) {
    currentTimeframe = saved;
    const sel = document.getElementById("timeframeSelect");
    if (sel) sel.value = saved;
  }
  switchTab("perp");
  updateVolumeHeader();
  setInterval(() => load(true, true), 90000);
});
