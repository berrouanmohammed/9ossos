const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { handleApi, send, sendJson } = require("./lib/api");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER) || Boolean(process.env.VERCEL);
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

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  if (decoded === "/" || decoded === "/index.html") return path.join(ROOT, "index.html");
  if (decoded === "/restaurants.json") return path.join(ROOT, "restaurants.json");
  if (decoded === "/geocodes.json") return path.join(ROOT, "geocodes.json");
  return null;
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

    const urlPath = String(req.url || "/").split("?")[0];
    if (urlPath === "/favicon.ico" || urlPath === "/favicon.png") {
      res.writeHead(204);
      res.end();
      return;
    }

    let filePath = safePath(urlPath);
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

if (require.main === module) {
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
}

module.exports = (req, res) => {
  server.emit("request", req, res);
};
