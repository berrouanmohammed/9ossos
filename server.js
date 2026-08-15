const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");

const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const USERS_FILE = path.join(DATA, "users.json");
const SESSIONS_FILE = path.join(DATA, "sessions.json");
const LISTS_DIR = path.join(DATA, "checklists");
const PORT = Number(process.env.PORT) || 3000;
const SESSION_DAYS = 30;
const PROD = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);
const clients = new Set();

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon"
};

fs.mkdirSync(LISTS_DIR, { recursive: true });

function send(res, status, body, type, extra) {
  res.writeHead(status, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...extra
  });
  res.end(body);
}

function sendJson(res, status, obj, extra) {
  send(res, status, JSON.stringify(obj), "application/json; charset=utf-8", extra);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function writeJson(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function users() { return readJson(USERS_FILE, {}); }
function sessions() { return readJson(SESSIONS_FILE, {}); }

function pruneSessions(all) {
  const now = Date.now();
  let changed = false;
  for (const [token, sess] of Object.entries(all)) {
    if (!sess || sess.exp < now) {
      delete all[token];
      changed = true;
    }
  }
  if (changed) writeJson(SESSIONS_FILE, all);
  return all;
}

function cookieHeader(token, maxAge, req) {
  const parts = [
    `9ossos=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  const proto = String(req && req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (PROD || proto === "https") parts.push("Secure");
  return parts.join("; ");
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); }
    catch { out[k] = v; }
  }
  return out;
}

function currentUser(req) {
  const token = parseCookies(req)["9ossos"];
  if (!token) return null;
  const all = pruneSessions(sessions());
  const sess = all[token];
  if (!sess || sess.exp < Date.now()) return null;
  const rec = users()[sess.user];
  if (!rec) return null;
  return { id: sess.user, name: rec.name || sess.user, token };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 32).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  try {
    const check = crypto.scryptSync(password, salt, 32);
    const expected = Buffer.from(hash, "hex");
    if (check.length !== expected.length) return false;
    return crypto.timingSafeEqual(check, expected);
  } catch {
    return false;
  }
}

function normalizeUser(name) {
  return String(name || "").trim();
}

function userId(name) {
  return normalizeUser(name).toLowerCase();
}

function validUsername(name) {
  return /^[a-zA-Z0-9._-]{2,24}$/.test(name);
}

function listPath(id) {
  return path.join(LISTS_DIR, `${id}.json`);
}

function readChecklist(id) {
  const data = readJson(listPath(id), { spots: {} });
  if (!data || typeof data !== "object" || !data.spots || typeof data.spots !== "object") {
    return { spots: {} };
  }
  return { spots: data.spots };
}

function writeChecklist(id, progress) {
  const spots = progress && progress.spots && typeof progress.spots === "object" ? progress.spots : {};
  writeJson(listPath(id), { spots });
  return { spots };
}

function readBody(req, limit = 800000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch {
    const err = new Error("invalid json");
    err.status = 400;
    throw err;
  }
}

function newSession(id) {
  const token = crypto.randomBytes(24).toString("hex");
  const all = pruneSessions(sessions());
  all[token] = { user: id, exp: Date.now() + SESSION_DAYS * 864e5 };
  writeJson(SESSIONS_FILE, all);
  return token;
}

function authPayload(id) {
  const rec = users()[id];
  return {
    user: rec && rec.name ? rec.name : id,
    progress: readChecklist(id)
  };
}

async function handleApi(req, res) {
  const url = req.url.split("?")[0];
  const method = req.method;

  if (method === "GET" && url === "/api/me") {
    const me = currentUser(req);
    if (!me) return sendJson(res, 200, { user: null, progress: { spots: {} } });
    return sendJson(res, 200, authPayload(me.id));
  }

  if (method === "POST" && (url === "/api/login" || url === "/api/register")) {
    const body = await readJsonBody(req);
    const name = normalizeUser(body.username);
    const password = String(body.password || "");
    if (!validUsername(name)) {
      return sendJson(res, 400, { error: "Identifiant : 2 à 24 caractères (lettres, chiffres, . _ -)" });
    }
    if (password.length < 4) {
      return sendJson(res, 400, { error: "Mot de passe trop court (4 caractères min.)" });
    }
    const id = userId(name);
    const all = users();

    if (url === "/api/register") {
      if (all[id]) return sendJson(res, 409, { error: "Cet identifiant est déjà pris" });
      const { salt, hash } = hashPassword(password);
      all[id] = { name, salt, hash, createdAt: Date.now() };
      writeJson(USERS_FILE, all);
      if (body.progress && body.progress.spots) writeChecklist(id, body.progress);
    } else {
      const rec = all[id];
      if (!rec || !verifyPassword(password, rec.salt, rec.hash)) {
        return sendJson(res, 401, { error: "Identifiant ou mot de passe incorrect" });
      }
    }

    const token = newSession(id);
    return sendJson(res, 200, authPayload(id), {
      "Set-Cookie": cookieHeader(token, SESSION_DAYS * 86400, req)
    });
  }

  if (method === "POST" && url === "/api/logout") {
    const me = currentUser(req);
    if (me) {
      const all = sessions();
      delete all[me.token];
      writeJson(SESSIONS_FILE, all);
    }
    return sendJson(res, 200, { ok: true }, {
      "Set-Cookie": cookieHeader("", 0, req)
    });
  }

  if (url === "/api/checklist") {
    const me = currentUser(req);
    if (!me) return sendJson(res, 401, { error: "Connecte-toi" });
    if (method === "GET") return sendJson(res, 200, readChecklist(me.id));
    if (method === "PUT") {
      const body = await readJsonBody(req);
      return sendJson(res, 200, writeChecklist(me.id, body));
    }
  }

  return sendJson(res, 404, { error: "Not found" });
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const resolved = path.resolve(ROOT, "." + decoded);
  if (!resolved.startsWith(ROOT)) return null;
  if (resolved === DATA || resolved.startsWith(DATA + path.sep)) return null;
  return resolved;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/__live")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive"
      });
      res.write("event: ping\ndata: ok\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }

    let filePath = safePath(req.url === "/" ? "/index.html" : req.url);
    if (!filePath) return send(res, 403, "Forbidden");

    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) return send(res, 404, "Not found");
      const type = TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
      fs.readFile(filePath, (readErr, data) => {
        if (readErr) return send(res, 500, "Read error");
        send(res, 200, data, type);
      });
    });
  } catch (err) {
    const status = err.status || 500;
    sendJson(res, status, { error: status === 413 ? "Fichier trop volumineux" : err.message || "Erreur serveur" });
  }
});

function broadcast(kind, file) {
  const payload = `event: ${kind}\ndata: ${file}\n\n`;
  for (const client of clients) client.write(payload);
}

let timer = null;
function onChange(filename) {
  if (!filename) return;
  const parts = filename.replace(/\\/g, "/").split("/");
  if (parts[0] === "data") return;
  const base = path.basename(filename);
  if (base === "geocode.js") return;
  const ext = path.extname(filename).toLowerCase();
  if (![".html", ".json", ".css", ".js"].includes(ext)) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (base === "geocodes.json") {
      broadcast("geo", filename.replace(/\\/g, "/"));
      return;
    }
    const kind = ext === ".json" ? "data" : "reload";
    broadcast(kind, filename.replace(/\\/g, "/"));
    console.log(`↻ ${kind} ← ${filename}`);
  }, 120);
}

if (!PROD) fs.watch(ROOT, { recursive: true }, (_event, filename) => onChange(filename));

server.listen(PORT, "0.0.0.0", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Listening on ${PORT}${PROD ? " (production)" : ""}`);
  if (PROD) return;
  const open =
    process.platform === "win32" ? `start "" "${url}"` :
    process.platform === "darwin" ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(open);
});
