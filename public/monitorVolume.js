// /public/monitorVolume.js
// 🔹 Compatível com monitor.js e /api/volume.js (CoinGecko + cache)
// 🔹 Mostra total no tooltip e usa escalas dinâmicas (M / B)

let chart;
let currentMode = "total"; // "spot" | "perp" | "total"
let currentDays = 7;

const periods = {
  "7d": 7,
  "1m": 30,
  "12w": 90,
  "all": 365
};

async function fetchVolume(days) {
  const resp = await fetch(`/api/volume?days=${days}`);
  if (!resp.ok) throw new Error("Erro ao buscar volume");
  const json = await resp.json();
  return json.data || [];
}

function setActive(containerId, labelText) {
  const el = document.getElementById(containerId);
  if (!el) return;
  Array.from(el.querySelectorAll("button")).forEach(btn => {
    btn.classList.toggle("active", btn.textContent.trim() === labelText);
  });
}

function fmtUnit(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + " B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + " M";
  return v.toFixed(2);
}

async function renderVolumeChart() {
  const canvas = document.getElementById("volumeChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  const rows = await fetchVolume(currentDays);
  if (!rows.length) return;

  const labels = rows.map(d => new Date(d.date));
  const toB = v => (v || 0) / 1e9;

  const datasets = [];

  if (currentMode === "spot" || currentMode === "total") {
    datasets.push({
      label: "Spot",
      data: rows.map(d => toB(d.spot)),
      backgroundColor: "rgba(0,150,255,0.8)",
      borderWidth: 1,
      stack: "stack1"
    });
  }

  if (currentMode === "perp" || currentMode === "total") {
    datasets.push({
      label: "Perp",
      data: rows.map(d => toB(d.perp)),
      backgroundColor: "rgba(155,80,255,0.8)",
      borderWidth: 1,
      stack: "stack1"
    });
  }

  // destruir gráfico anterior com segurança
  if (chart && chart.destroy) chart.destroy();

  chart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: "#fff" } },
        title: {
          display: true,
          text: `Backpack — Volume ${currentMode.toUpperCase()} (${currentDays} dias)`,
          color: "#fff",
          font: { size: 15, weight: "bold" }
        },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            label: ctx => {
              const label = ctx.dataset.label;
              const val = ctx.parsed.y * 1e9;
              return `${label}: ${fmtUnit(val)} USD`;
            },
            afterBody: items => {
              if (!items || !items.length) return "";
              // soma total do dia
              const totalVal = items.reduce(
                (sum, i) => sum + i.parsed.y * 1e9,
                0
              );
              return `Total: ${fmtUnit(totalVal)} USD`;
            }
          }
        }
      },
      scales: {
        x: {
          stacked: true,
          type: "time",
          time: { unit: "day" },
          ticks: { color: "#ccc" },
          grid: { color: "rgba(255,255,255,0.1)" }
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: {
            color: "#ccc",
            callback: v => v + " B"
          },
          grid: { color: "rgba(255,255,255,0.1)" }
        }
      }
    }
  });

  const src = document.getElementById("volumeSource");
  if (src) {
    src.innerHTML = `
      Fonte: 
      <a href="https://www.coingecko.com/en/exchanges/backpack-exchange" target="_blank">CoinGecko (Spot)</a> & 
      <a href="https://www.coingecko.com/en/exchanges/backpack-futures" target="_blank">CoinGecko (Futures)</a>.
      Valores em bilhões USD — atualização diária.
    `;
  }
}

export function renderVolumeTab() {
  const container = document.getElementById("volumeContainer");
  container.innerHTML = `
    <div class="volume-controls">
      <div id="modeBtns" class="mode-buttons"></div>
      <div id="periodBtns" class="period-buttons"></div>
    </div>
    <canvas id="volumeChart" height="120"></canvas>
    <p id="volumeSource" class="volume-source"></p>
  `;

  // === Botões modo ===
  const modeDiv = document.getElementById("modeBtns");
  ["Spot", "Futuros", "Total"].forEach(label => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.onclick = () => {
      currentMode = label === "Spot" ? "spot" : label === "Futuros" ? "perp" : "total";
      setActive("modeBtns", label);
      renderVolumeChart();
    };
    modeDiv.appendChild(btn);
  });
  setActive("modeBtns", "Total");

  // === Botões período ===
  const periodDiv = document.getElementById("periodBtns");
  Object.entries(periods).forEach(([label, days]) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.onclick = () => {
      currentDays = days;
      setActive("periodBtns", label);
      renderVolumeChart();
    };
    periodDiv.appendChild(btn);
  });
  setActive("periodBtns", "7d");

  renderVolumeChart();
}
