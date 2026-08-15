const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const OUT = path.join(ROOT, "geocodes.json");
const RAW = JSON.parse(fs.readFileSync(path.join(ROOT, "restaurants.json"), "utf8"));

const CITIES = [
  "Casablanca", "Rabat", "Tanger", "Marrakech", "Agadir", "Fès", "Fes",
  "Oujda", "Tétouan", "Tetouan", "Mohammedia", "Témara", "Temara",
  "El Jadida", "Oualidia", "Kénitra", "Kenitra", "Salé", "Sala Al Jadida",
  "Meknès", "Meknes", "Essaouira", "Dar Bouazza", "Bouskoura", "Nador",
  "Chefchaouen", "Asilah", "El Mansouria", "Harhoura", "Aïn Atiq", "Ain Atiq",
  "Boulaouane", "Skhirat", "Ifrane", "Ouarzazate", "Dakhla", "Laâyoune",
  "Beni Mellal", "Safi", "Larache", "Fnideq", "Martil", "M’diq", "Mdiq"
];
const CITY_ALIAS = {
  Fes: "Fès", Tetouan: "Tétouan", Temara: "Témara", Kenitra: "Kénitra",
  Meknes: "Meknès", "Ain Atiq": "Aïn Atiq", Mdiq: "M’diq", "M'diq": "M’diq"
};
const ARABIC_CITIES = [
  ["الدار البيضاء", "Casablanca"], ["الدارالبيضاء", "Casablanca"],
  ["مراكش", "Marrakech"], ["الرباط", "Rabat"], ["طنجة", "Tanger"],
  ["فاس", "Fès"], ["وجدة", "Oujda"], ["أكادير", "Agadir"]
];
const DISTRICT_TO_CITY = [
  ["maârif", "Casablanca"], ["maarif", "Casablanca"],
  ["aïn sebaâ", "Casablanca"], ["ain sebaâ", "Casablanca"],
  ["aïn sebaa", "Casablanca"], ["ain sebaa", "Casablanca"], ["ain seba", "Casablanca"],
  ["sidi maârouf", "Casablanca"], ["sidi maarouf", "Casablanca"],
  ["aïn chock", "Casablanca"], ["ain chock", "Casablanca"],
  ["2 mars", "Casablanca"], ["palmiers", "Casablanca"], ["palmier", "Casablanca"],
  ["bourgogne", "Casablanca"], ["bernoussi", "Casablanca"],
  ["belvédère", "Casablanca"], ["belvedere", "Casablanca"],
  ["sidi moumen", "Casablanca"], ["el hank", "Casablanca"],
  ["morocco mall", "Casablanca"], ["marina mall", "Casablanca"],
  ["marina shopping", "Casablanca"], ["ziraoui", "Casablanca"],
  ["hay hassani", "Casablanca"], ["aïn diab", "Casablanca"], ["ain diab", "Casablanca"],
  ["derb sultan", "Casablanca"], ["درب السلطان", "Casablanca"],
  ["californie", "Casablanca"], ["gauthier", "Casablanca"],
  ["beauséjour", "Casablanca"], ["beausejour", "Casablanca"],
  ["oulfa", "Casablanca"], ["anassi", "Casablanca"], ["tit mellil", "Casablanca"],
  ["mers sultan", "Casablanca"], ["hay mohammadi", "Casablanca"],
  ["roches noires", "Casablanca"], ["twin center", "Casablanca"],
  ["anoual", "Casablanca"], ["racine", "Casablanca"], ["ghandi", "Casablanca"]
];

function clean(text) {
  return (text || "").replace(/[\u2066-\u2069\u202A-\u202E\u200E\u200F]/g, "").replace(/\s+/g, " ").trim();
}

function detectCity(text) {
  for (const [ar, fr] of ARABIC_CITIES) if (text.includes(ar)) return fr;
  const lower = text.toLowerCase();
  for (const [district, city] of DISTRICT_TO_CITY) if (lower.includes(district)) return city;
  if (/\boasis\b/i.test(text) && !/benslimane/i.test(text) && !/serenity/i.test(text)) return "Casablanca";
  for (const city of CITIES) {
    if (lower.includes(city.toLowerCase())) return CITY_ALIAS[city] || city;
  }
  if (/\bcasa\b/i.test(text) || text.includes("كازا")) return "Casablanca";
  return "";
}

function normName(name) {
  return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/['’`]/g, "").replace(/[^a-z0-9\u0600-\u06ff]+/gi, " ")
    .replace(/^(le|la|les|l|the|el|al)\s+/, "").trim();
}

function parse(raw) {
  const text = clean(raw.description);
  const pin = text.match(/📍\s*([^💰🎁📅🕘🎮🚨📞]+)/);
  let name = "";
  let address = "";
  if (pin) {
    const loc = clean(pin[1]).replace(/[.\s]+$/, "");
    const parts = loc.split(",").map((p) => p.trim()).filter(Boolean);
    name = parts[0] || loc;
    address = parts.slice(1).join(", ");
  }
  const lastBit = (address || "").split(",").map((p) => p.trim()).filter(Boolean).pop() || "";
  const city = detectCity(lastBit) || detectCity(address) || detectCity(name) || detectCity(text) || "Ailleurs";
  if (!name) return null;
  return {
    key: `${normName(name)}|${city}`,
    name,
    address,
    city,
    query: [name, address, city !== "Ailleurs" ? city : "", "Maroc"].filter(Boolean).join(", ")
  };
}

const unique = new Map();
for (const raw of RAW) {
  const item = parse(raw);
  if (!item) continue;
  const prev = unique.get(item.key);
  if (!prev || item.address.length > prev.address.length) unique.set(item.key, item);
}

let geo = {};
if (fs.existsSync(OUT)) {
  try { geo = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { geo = {}; }
}

const jobs = [...unique.values()].sort((a, b) => {
  const ac = a.city === "Casablanca" ? 0 : 1;
  const bc = b.city === "Casablanca" ? 0 : 1;
  return ac - bc || a.name.localeCompare(b.name, "fr");
});

function save() {
  fs.writeFileSync(OUT, JSON.stringify(geo, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function lookup(query) {
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ma&q=" + encodeURIComponent(query);
  const res = await fetch(url, { headers: { "User-Agent": "9ossos-guide/1.0 (local restaurant map)" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const rows = await res.json();
  if (!rows[0]) return null;
  return { lat: Number(rows[0].lat), lng: Number(rows[0].lon), label: rows[0].display_name };
}

async function run() {
  const pending = jobs.filter((j) => !geo[j.key]);
  console.log(`Geocode ${pending.length} / ${jobs.length} restos (1/s, Casablanca d’abord)`);
  let i = 0;
  for (const job of pending) {
    i += 1;
    try {
      let hit = await lookup(job.query);
      if (!hit && job.address) hit = await lookup(`${job.name}, ${job.city}, Maroc`);
      geo[job.key] = hit ? { lat: hit.lat, lng: hit.lng, label: hit.label } : { lat: null, lng: null };
      console.log(`${i}/${pending.length} ${hit ? "✓" : "·"} ${job.name} (${job.city})`);
    } catch (err) {
      console.log(`${i}/${pending.length} ! ${job.name}: ${err.message}`);
      await sleep(3000);
    }
    if (i % 5 === 0) save();
    await sleep(1100);
  }
  save();
  const ok = Object.values(geo).filter((g) => g.lat).length;
  console.log(`Done. ${ok} positions trouvées.`);
}

run().catch((err) => {
  console.error(err);
  save();
  process.exit(1);
});
