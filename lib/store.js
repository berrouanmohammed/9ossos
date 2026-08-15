const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const IN_LAMBDA = Boolean(
  process.env.VERCEL ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.LAMBDA_TASK_ROOT
);
const DATA = IN_LAMBDA ? path.join("/tmp", "9ossos-data") : path.join(ROOT, "data");
const STORE_FILE = path.join(DATA, "store.json");
const LEGACY_USERS = path.join(DATA, "users.json");
const LEGACY_SESSIONS = path.join(DATA, "sessions.json");
const LEGACY_LISTS = path.join(DATA, "checklists");

function emptyStore() {
  return { users: {}, sessions: {}, checklists: {} };
}

function ensureDir() {
  fs.mkdirSync(DATA, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function writeJson(file, data) {
  ensureDir();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function migrateLegacy() {
  const store = emptyStore();
  const users = readJson(LEGACY_USERS, null);
  const sessions = readJson(LEGACY_SESSIONS, null);
  if (users && typeof users === "object") store.users = users;
  if (sessions && typeof sessions === "object") store.sessions = sessions;
  try {
    for (const name of fs.readdirSync(LEGACY_LISTS)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      const list = readJson(path.join(LEGACY_LISTS, name), null);
      if (list && list.spots) store.checklists[id] = { spots: list.spots };
    }
  } catch {}
  return store;
}

function loadStoreSync() {
  ensureDir();
  if (fs.existsSync(STORE_FILE)) {
    const data = readJson(STORE_FILE, emptyStore());
    return {
      users: data.users && typeof data.users === "object" ? data.users : {},
      sessions: data.sessions && typeof data.sessions === "object" ? data.sessions : {},
      checklists: data.checklists && typeof data.checklists === "object" ? data.checklists : {}
    };
  }
  const migrated = migrateLegacy();
  if (Object.keys(migrated.users).length || Object.keys(migrated.checklists).length) {
    writeJson(STORE_FILE, migrated);
  }
  return migrated;
}

function saveStoreSync(store) {
  writeJson(STORE_FILE, {
    users: store.users || {},
    sessions: store.sessions || {},
    checklists: store.checklists || {}
  });
}

function gistEnabled() {
  return Boolean(process.env.GIST_ID && process.env.GITHUB_TOKEN);
}

async function gistLoad() {
  const res = await fetch(`https://api.github.com/gists/${process.env.GIST_ID}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "User-Agent": "9ossos",
      Accept: "application/vnd.github+json"
    }
  });
  if (!res.ok) throw new Error("gist load failed");
  const gist = await res.json();
  const raw = gist.files && gist.files["store.json"] && gist.files["store.json"].content;
  if (!raw) return emptyStore();
  const data = JSON.parse(raw);
  return {
    users: data.users && typeof data.users === "object" ? data.users : {},
    sessions: data.sessions && typeof data.sessions === "object" ? data.sessions : {},
    checklists: data.checklists && typeof data.checklists === "object" ? data.checklists : {}
  };
}

async function gistSave(store) {
  const res = await fetch(`https://api.github.com/gists/${process.env.GIST_ID}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "User-Agent": "9ossos",
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      files: {
        "store.json": {
          content: JSON.stringify({
            users: store.users || {},
            sessions: store.sessions || {},
            checklists: store.checklists || {}
          })
        }
      }
    })
  });
  if (!res.ok) throw new Error("gist save failed");
}

let mem = null;
let memAt = 0;

async function loadStore() {
  if (mem && Date.now() - memAt < 3000) return mem;
  if (gistEnabled()) {
    try {
      mem = await gistLoad();
      memAt = Date.now();
      try { saveStoreSync(mem); } catch {}
      return mem;
    } catch {
      if (mem) return mem;
      mem = loadStoreSync();
      memAt = Date.now();
      return mem;
    }
  }
  return loadStoreSync();
}

async function saveStore(store) {
  mem = store;
  memAt = Date.now();
  saveStoreSync(store);
  if (gistEnabled()) {
    try { await gistSave(store); }
    catch {}
  }
}

module.exports = { loadStore, saveStore, emptyStore };
