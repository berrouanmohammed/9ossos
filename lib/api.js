const crypto = require("crypto");
const { loadStore, saveStore } = require("./store");

const IN_LAMBDA = Boolean(
  process.env.VERCEL ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.LAMBDA_TASK_ROOT
);
const PROD = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER) || IN_LAMBDA;
const SESSION_DAYS = 30;

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

function pruneSessions(store) {
  const now = Date.now();
  store.sessions = store.sessions || {};
  for (const [token, sess] of Object.entries(store.sessions)) {
    if (!sess || sess.exp < now) delete store.sessions[token];
  }
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

function currentUser(req, store) {
  const token = parseCookies(req)["9ossos"];
  if (!token) return null;
  pruneSessions(store);
  const sess = store.sessions[token];
  if (!sess || sess.exp < Date.now()) return null;
  const rec = store.users[sess.user];
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

function readChecklist(store, id) {
  const data = store.checklists[id];
  if (!data || typeof data !== "object" || !data.spots || typeof data.spots !== "object") {
    return { spots: {} };
  }
  return { spots: data.spots };
}

function writeChecklist(store, id, progress) {
  const spots = progress && progress.spots && typeof progress.spots === "object" ? progress.spots : {};
  store.checklists[id] = { spots };
  return { spots };
}

function mergeChecklist(store, id, progress) {
  const incoming = progress && progress.spots && typeof progress.spots === "object" ? progress.spots : {};
  if (!Object.keys(incoming).length) return readChecklist(store, id);
  const cur = readChecklist(store, id);
  const spots = { ...cur.spots };
  for (const [key, val] of Object.entries(incoming)) {
    if (!val || typeof val !== "object") continue;
    const prev = spots[key] || { visited: false, dishes: {} };
    spots[key] = {
      visited: Boolean(prev.visited || val.visited),
      dishes: { ...(prev.dishes || {}), ...(val.dishes && typeof val.dishes === "object" ? val.dishes : {}) }
    };
  }
  store.checklists[id] = { spots };
  return { spots };
}

function readBody(req, limit = 800000) {
  return new Promise((resolve, reject) => {
    if (typeof req.on !== "function") {
      resolve(typeof req.body === "string" ? req.body : "");
      return;
    }
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
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string" && req.body) {
    try { return JSON.parse(req.body); }
    catch {
      const err = new Error("invalid json");
      err.status = 400;
      throw err;
    }
  }
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch {
    const err = new Error("invalid json");
    err.status = 400;
    throw err;
  }
}

function newSession(store, id) {
  pruneSessions(store);
  const token = crypto.randomBytes(24).toString("hex");
  store.sessions[token] = { user: id, exp: Date.now() + SESSION_DAYS * 864e5 };
  return token;
}

function authPayload(store, id) {
  const rec = store.users[id];
  return {
    user: rec && rec.name ? rec.name : id,
    progress: readChecklist(store, id)
  };
}

async function handleApi(req, res) {
  const url = String(req.url || "").split("?")[0];
  const method = req.method;
  const store = await loadStore();

  if (method === "GET" && url === "/api/me") {
    const me = currentUser(req, store);
    if (!me) return sendJson(res, 200, { user: null, progress: { spots: {} } });
    return sendJson(res, 200, authPayload(store, me.id));
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
    store.users = store.users || {};
    store.checklists = store.checklists || {};
    store.sessions = store.sessions || {};

    if (url === "/api/register") {
      if (store.users[id]) return sendJson(res, 409, { error: "Cet identifiant est déjà pris" });
      const { salt, hash } = hashPassword(password);
      store.users[id] = { name, salt, hash, createdAt: Date.now() };
      if (body.progress && body.progress.spots) writeChecklist(store, id, body.progress);
    } else {
      const rec = store.users[id];
      if (!rec || !verifyPassword(password, rec.salt, rec.hash)) {
        return sendJson(res, 401, { error: "Identifiant ou mot de passe incorrect" });
      }
      if (body.progress && body.progress.spots) mergeChecklist(store, id, body.progress);
    }

    const token = newSession(store, id);
    await saveStore(store);
    return sendJson(res, 200, authPayload(store, id), {
      "Set-Cookie": cookieHeader(token, SESSION_DAYS * 86400, req)
    });
  }

  if (method === "POST" && url === "/api/logout") {
    const me = currentUser(req, store);
    if (me) delete store.sessions[me.token];
    await saveStore(store);
    return sendJson(res, 200, { ok: true }, {
      "Set-Cookie": cookieHeader("", 0, req)
    });
  }

  if (url === "/api/checklist") {
    const me = currentUser(req, store);
    if (!me) return sendJson(res, 401, { error: "Connecte-toi" });
    if (method === "GET") return sendJson(res, 200, readChecklist(store, me.id));
    if (method === "PUT") {
      const body = await readJsonBody(req);
      const next = writeChecklist(store, me.id, body);
      await saveStore(store);
      return sendJson(res, 200, next);
    }
  }

  return sendJson(res, 404, { error: "Not found" });
}

function vercelRoute(route) {
  return async function (req, res) {
    try {
      const raw = String(req.url || "");
      const q = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
      req.url = route + q;
      await handleApi(req, res);
    } catch (err) {
      const status = err.status || 500;
      sendJson(res, status, { error: err.message || "Erreur serveur" });
    }
  };
}

module.exports = { handleApi, send, sendJson, vercelRoute };
