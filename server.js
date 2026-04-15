// server.js – Zentraler Spielehub-Server
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || "0.0.0.0";

// ── MIME-Types ──────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};

// ── HTTP Server (statische Dateien) ─────────────────────────
const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (urlPath === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  // Pfad auflösen: / → hub.html
  let filePath;
  if (urlPath === "/") {
    filePath = path.join(__dirname, "hub.html");
  } else {
    filePath = path.join(__dirname, urlPath);
  }

  // Sicherheitscheck: Kein Zugriff außerhalb des Projektordners
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("404 – Not Found");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
    res.end(data);
  });
});

// ── BATTLESHIP WebSocket (/battleship/ws) ───────────────────
const battleshipWss = new WebSocket.Server({ noServer: true });
// ... hier die komplette Battleship-Logik aus battleship/server.js einfügen ...

// ── KNIFFEL WebSocket (/kniffel/ws) ─────────────────────────
const kniffelWss = new WebSocket.Server({ noServer: true });
// ... hier die komplette Kniffel-Logik aus kniffel/server.js einfügen ...

// ── WebSocket Upgrade Routing ────────────────────────────────
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === "/battleship/ws") {
    battleshipWss.handleUpgrade(req, socket, head, (ws) => {
      battleshipWss.emit("connection", ws, req);
    });
  } else if (pathname === "/kniffel/ws") {
    kniffelWss.handleUpgrade(req, socket, head, (ws) => {
      kniffelWss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`✅ Spielehub läuft auf http://${HOST}:${PORT}`);
});
