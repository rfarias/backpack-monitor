// === monitorTransfer.js ===
// Exibe ativos e redes (depósitos/saques) com expansão

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
    const tr = document.createElement("tr");
    tr.className = active ? "green" : "gray";

    const total = rows.length;
    const badge =
      total > 1 ? `<span class="net-badge">🧩 ${total} redes</span>` : "";

    tr.innerHTML = `
      <td>${i++}</td>
      <td class="expandable" data-symbol="${symbol}">
        <b>${symbol}</b> ${badge}
      </td>
      <td colspan="6" class="expandable-hint">Clique para ver detalhes</td>
    `;
    tb.appendChild(tr);

    rows.forEach((r) => {
      const sub = document.createElement("tr");
      sub.className = "network-row hidden";
      sub.dataset.parent = symbol;

      sub.innerHTML = `
        <td></td>
        <td>${r.blockchain}</td>
        <td>${r.depositEnabled ? "🟢 Ativo" : "🔴 Inativo"}</td>
        <td>${r.withdrawEnabled ? "🟢 Ativo" : "🔴 Inativo"}</td>
        <td>${r.withdrawalFee}</td>
        <td>${r.minWithdraw}</td>
        <td>${r.maxWithdraw}</td>
        <td>${r.minDeposit}</td>
      `;
      tb.appendChild(sub);
    });
  }

  // clique para expandir / recolher
  tb.addEventListener("click", (e) => {
    const row = e.target.closest(".expandable");
    if (!row) return;

    const symbol = row.dataset.symbol;
    const subs = tb.querySelectorAll(`tr.network-row[data-parent="${symbol}"]`);
    subs.forEach((sub) => sub.classList.toggle("hidden"));
  });
}
