// /api/volume.js
// 🔹 Cache persistente compatível com Windows e Vercel
// 🔹 Atualização automática 1x/hora (365d total)
// 🔹 Todos os usuários compartilham o mesmo cache

import fs from "fs";
import fetch from "node-fetch";
import path from "path";

const FUTURES_ID = "backpack-futures";
const SPOT_ID = "backpack-exchange";
const URL_BASE = "https://api.coingecko.com/api/v3/exchanges";
const BTC_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";

const CACHE_DIR =
  process.platform === "win32" ? path.join("C:", "temp") : "/tmp";
const CACHE_FILE = path.join(CACHE_DIR, "volume_cache.json");

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora
let cache = loadCacheFromFile();

// Atualiza automaticamente a cada 1h
setInterval(async () => {
  try {
    await refreshCache();
  } catch (e) {
    console.warn("[AUTO REFRESH] erro:", e.message);
  }
}, CACHE_TTL_MS);

export default async function handler(req, res) {
  const rawDays = req.query.days || "7";
  const days = mapDays(rawDays);
  const now = Date.now();

  try {
    if (!cache["365"] || now - cache["365"].time > CACHE_TTL_MS) {
      console.log("[UPDATE] Cache expirado — atualizando dados 365d...");
      await refreshCache();
    } else {
      console.log(
        `[CACHE] usando cache persistente (última atualização: ${new Date(
          cache["365"].time
        ).toLocaleTimeString()})`
      );
    }

    const allData = cache["365"].data.data;
    const subset = generateSubset(allData, days);

    res.status(200).json({
      source: "cache",
      days,
      data: subset,
    });
  } catch (e) {
    console.error("Erro API /volume:", e.message);
    if (cache["365"]) {
      const subset = generateSubset(cache["365"].data.data, days);
      return res.status(200).json({
        source: "fallback-cache",
        days,
        data: subset,
      });
    }
    return res.status(200).json(makeEmpty(days));
  }
}

async function refreshCache() {
  ensureCacheDir();

  const dataset = await fetchCoinGecko365d();
  cache["365"] = { time: Date.now(), data: dataset };
  saveCacheToFile(cache);

  console.log(
    `[REFRESH OK] ${dataset.data.length} dias atualizados — ${new Date().toLocaleTimeString()}`
  );
}

async function fetchCoinGecko365d() {
  console.log("[API] Buscando CoinGecko (365d)");
  const [perpRes, spotRes, btcRes] = await Promise.all([
    fetch(`${URL_BASE}/${FUTURES_ID}/volume_chart?days=365`),
    fetch(`${URL_BASE}/${SPOT_ID}/volume_chart?days=365`),
    fetch(BTC_URL),
  ]);

  if (!perpRes.ok || !spotRes.ok || !btcRes.ok) {
    const codes = [perpRes.status, spotRes.status, btcRes.status].join(", ");
    throw new Error(`Erro CoinGecko ${codes}`);
  }

  const [perpData, spotData, btcJson] = await Promise.all([
    perpRes.json(),
    spotRes.json(),
    btcRes.json(),
  ]);

  const btcUsd = btcJson.bitcoin?.usd || 0;
  const fmtDate = (ts) => new Date(ts).toISOString().slice(0, 10);
  const toUsd = (arr) =>
    (arr || []).map(([ts, volBtc]) => ({
      date: fmtDate(ts),
      usd: (volBtc || 0) * btcUsd,
    }));

  const perp = toUsd(perpData);
  const spot = toUsd(spotData);
  const allDates = [
    ...new Set([...perp.map((d) => d.date), ...spot.map((d) => d.date)]),
  ].sort();

  const data = allDates.map((date) => {
    const p = perp.find((d) => d.date === date)?.usd || 0;
    const s = spot.find((d) => d.date === date)?.usd || 0;
    return { date, spot: s, perp: p, total: s + p };
  });

  const last = data[data.length - 1];
  console.log(
    `[DEBUG] ${last.date} | spot=${fmt(last.spot)} | perp=${fmt(
      last.perp
    )} | total=${fmt(last.total)}`
  );

  return { source: "coingecko", days: 365, data };
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    console.log("[CACHE DIR] criado:", CACHE_DIR);
  }
}

function generateSubset(allData, days) {
  if (!Array.isArray(allData)) return [];
  if (days >= allData.length) return allData;
  return allData.slice(-days);
}

function mapDays(raw) {
  const map = {
    "7": 7,
    "7d": 7,
    "1m": 30,
    "30": 30,
    "12w": 90,
    "90": 90,
    "all": 365,
    "365": 365,
  };
  return map[raw] || 7;
}

function fmt(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + " B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + " M";
  return v.toFixed(2);
}

function makeEmpty(days) {
  return {
    source: "error-fallback",
    days,
    data: [
      {
        date: new Date().toISOString().slice(0, 10),
        spot: 0,
        perp: 0,
        total: 0,
      },
    ],
  };
}

function loadCacheFromFile() {
  try {
    ensureCacheDir();
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn("[CACHE FILE] erro ao carregar:", e.message);
  }
  return {};
}

function saveCacheToFile(obj) {
  try {
    ensureCacheDir();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2));
    console.log("[CACHE FILE] atualizado");
  } catch (e) {
    console.warn("[CACHE FILE] erro ao salvar:", e.message);
  }
}
