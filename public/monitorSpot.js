export function renderSpot(data) {
  const tb = document.querySelector("#tbl tbody");
  tb.innerHTML = "";
  data.forEach((m, i) => {
    const tr = document.createElement("tr");
    tr.className = m.decision === "long"
      ? "green"
      : m.decision === "short"
      ? "red"
      : m.decision === "lateral"
      ? "blue"
      : "gray";
    const leverage = m.isMarginable ? `⚡${m.maxLeverage}x` : "";
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${m.symbol}${leverage}</td>
      <td>${m.lastPrice ? "$" + m.lastPrice.toFixed(4) : "-"}</td>
      <td>${(m.atrRel * 100).toFixed(3)}%</td>
      <td>${m.bbWidth?.toFixed(4) || "-"}</td>
      <td>${m.rsi?.toFixed(1) || "-"}</td>
      <td>${Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(m.volumeUSD || 0)}</td>
      <td>${Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(m.marketCapUSD || 0)}</td>
      <td>${m.decision.toUpperCase()}</td>
      <td>${m.score}</td>
    `;
    tb.appendChild(tr);
  });
}
