// === /api/status.js ===
// Corrige problema do Vercel (filesystem efêmero) — mantém cache em memória
// e salva fallback local no /public/marketStatus.json para rodar em vercel dev.

import fs from "fs";
import path from "path";

const FILE_PATH = path.join(process.cwd(), "public", "marketStatus.json");
const NEW_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// Cache em memória (persiste entre chamadas enquanto a função está ativa)
let memoryCache = { perp: {}, spot: {} };

function ensureFile() {
  if (!fs.existsSync(FILE_PATH)) {
    fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
    fs.writeFileSync(FILE_PATH, JSON.stringify(memoryCache, null, 2));
  }
}

function loadFromFile() {
  try {
    ensureFile();
    const json = JSON.parse(fs.readFileSync(FILE_PATH, "utf8"));
    memoryCache = { ...memoryCache, ...json };
  } catch (e) {
    console.warn("⚠️ Falha ao ler marketStatus.json:", e.message);
  }
}

function saveToFile() {
  try {
    fs.writeFileSync(FILE_PATH, JSON.stringify(memoryCache, null, 2));
  } catch (e) {
    console.warn("⚠️ Falha ao salvar marketStatus.json:", e.message);
  }
}

function hasActivity(m) {
  return (
    (m.volumeUSD && m.volumeUSD > 0) ||
    (m.oiUSD && m.oiUSD > 0) ||
    (m.liquidityScore && m.liquidityScore > 0) ||
    (m.atrRel && m.atrRel > 0) ||
    (m.bbWidth && m.bbWidth > 0) ||
    (m.rsi && m.rsi > 0)
  );
}

export default async function handler(req, res) {
  const now = Date.now();
  const tab = req.query.tab || "perp";
  const method = req.method;

  // sempre tenta carregar do arquivo local (somente em vercel dev)
  if (Object.keys(memoryCache[tab] || {}).length === 0) loadFromFile();

  const prev = memoryCache[tab] || {};
  const updated = { ...prev };

  if (method === "GET") {
    return res.status(200).json(prev);
  }

  if (method === "POST") {
    try {
      const body = req.body || [];
      if (!Array.isArray(body))
        return res.status(400).json({ error: "Corpo deve ser array" });

      for (const m of body) {
        const symbol = m.symbol;
        const info = prev[symbol] || {
          hadActivity: false,
          becameActiveAt: null,
          status: "upcoming",
        };

        const activeNow = hasActivity(m);

        // FRAG (isAbandoned)
        if (m.isAbandoned) {
          updated[symbol] = {
            hadActivity: true,
            becameActiveAt: info.becameActiveAt ?? now,
            status: "normal",
          };
          continue;
        }

        // Ordem lógica
        if (!info.hadActivity && !activeNow) {
          updated[symbol] = { ...info, status: "upcoming" };
          continue;
        }

        if (activeNow && !info.hadActivity) {
          updated[symbol] = {
            hadActivity: true,
            becameActiveAt: now,
            status: "new",
          };
          continue;
        }

        if (info.hadActivity && info.becameActiveAt) {
          const age = now - info.becameActiveAt;
          const stillNew = age <= NEW_DURATION_MS;
          updated[symbol] = {
            ...info,
            hadActivity: true,
            status: stillNew ? "new" : "normal",
          };
          continue;
        }

        updated[symbol] = { ...info };
      }

      memoryCache[tab] = updated;
      saveToFile();

      return res.status(200).json(updated);
    } catch (e) {
      console.error("❌ Erro /api/status:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Método não permitido" });
}
