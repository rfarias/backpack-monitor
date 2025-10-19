const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(+ts);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function rsiClass(rsi) {
  if (rsi <= 30) return "rsi-low";
  if (rsi >= 70) return "rsi-high";
  return "rsi-mid";
}

function atrClass(atr) {
  const p = atr * 100;
  if (p <= 0.3) return "atr-low";
  if (p >= 0.7) return "atr-high";
  return "atr-mid";
}
