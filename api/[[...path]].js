const { handleApi } = require("../server.js");

module.exports = async function (req, res) {
  try {
    const raw = String(req.url || "/");
    const q = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
    let pathname = raw.split("?")[0];
    if (!pathname.startsWith("/api")) {
      const slug = req.query && req.query.path;
      const tail = Array.isArray(slug) ? slug.join("/") : (slug ? String(slug) : "");
      pathname = "/api" + (tail ? "/" + tail : "");
    }
    req.url = pathname + q;
    await handleApi(req, res);
  } catch (err) {
    const status = err.status || 500;
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: err.message || "Erreur serveur" }));
  }
};
