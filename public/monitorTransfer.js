// === monitorTransfer.js ===
// Exibe ativos e redes (depósitos/saques) sempre visíveis, sem precisar expandir

export function renderTransfer(data) {
  const tb = document.querySelector("#tbl tbody");
  const th = document.querySelector("#tbl-head");

  if (!Array.isArray(data) || data.length === 0) {
    tb.innerHTML =
      "<tr><td colspan='8' class='loading'>Nenhum dado disponível</td></tr>";
    return;
  }

  th.innerHTML = `
    <tr>
      <th>#</th>
      <th>Ativo</th>
      <th>Rede</th>
      <th>Depósito</th>
      <th>Saque</th>
      <th>Taxa Saque</th>
      <th>Min. Saque</th>
      <th>Máx. Saque</th>
      <th>Min. Depósito</th>
    </tr>
  `;

  const grouped = {};
  data.forEach((row) => {
    if (!grouped[row.symbol]) grouped[row.symbol] = [];
    grouped[row.symbol].push(row);
  });

  tb.innerHTML = "";
  let i = 1;

  for (const [symbol, rows] of Object.entries(grouped)) {
    const active = rows.some((r) => r.depositEnabled || r.withdrawEnabled);
    const trMain = document.createElement("tr");
    trMain.className = active ? "transfer-main" : "transfer-main gray";

    const total = rows.length;
    const badge =
      total > 1 ? `<span class="net-badge">🧩 ${total} redes</span>` : "";

    trMain.innerHTML = `
      <td>${i++}</td>
      <td colspan="8" class="symbol"><b>${symbol}</b> ${badge}</td>
    `;
    tb.appendChild(trMain);

    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.className = "transfer-chain";

      const depIcon = r.depositEnabled ? "🟢 Ativo" : "🔴 Inativo";
      const wdrIcon = r.withdrawEnabled ? "🟢 Ativo" : "🔴 Inativo";

      tr.innerHTML = `
        <td></td>
        <td></td>
        <td>${r.blockchain || "-"}</td>
        <td>${depIcon}</td>
        <td>${wdrIcon}</td>
        <td>${r.withdrawalFee || "-"}</td>
        <td>${r.minWithdraw || "-"}</td>
        <td>${r.maxWithdraw || "-"}</td>
        <td>${r.minDeposit || "-"}</td>
      `;
      tb.appendChild(tr);
    });
  }
}
