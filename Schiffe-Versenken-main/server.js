// server.js – Self-hosting Version (Ubuntu/Nginx/Systemd)
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || "127.0.0.1";

// HTTP Server
const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0] || "/";
  if (urlPath === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("ok");
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

// WEBSOCKET Server
const wss = new WebSocket.Server({ server, path: "/ws" });
const rooms = new Map();

// WebSocket Keepalive 
function heartbeat() { this.isAlive = true; }
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive == false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);



function broadcastRoomUpdate(code) {
  const room = rooms.get(code);
  if (!room) return;
  const players = room.names.map((n, idx) => ({
    id: idx + 1,
    name: n,
    ready: !!room.readyById?.[idx + 1],
  }));
  const payload = JSON.stringify({ type: "roomUpdate", room: code, players });
  const sockets = [...(room.players || []), ...(room.spectators || [])];
  sockets.forEach((p) => {
    if (p.readyState === WebSocket.OPEN) p.send(payload);
  });
}

// Hilfsfunktionen Boardlogik
function createBoard(cells) {
  const board = {
    cells: new Set(cells),
    hits: new Set(),
    misses: new Set(),
    shots: new Set(),
    ships: [],
  };

  const visited = new Set();
  function neigh(x, y) {
    return [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];
  }

  for (const c of cells) {
    if (visited.has(c)) continue;
    const [x, y] = c.split(",").map(Number);
    const stack = [[x, y]];
    const group = [];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      const key = `${cx},${cy}`;
      if (visited.has(key)) continue;
      visited.add(key);
      group.push(key);
      for (const [nx, ny] of neigh(cx, cy)) {
        const nk = `${nx},${ny}`;
        if (cells.includes(nk) && !visited.has(nk)) stack.push([nx, ny]);
      }
    }
    board.ships.push({ coords: group, hits: new Set() });
  }
  return board;
}


function serializeBoardForReveal(board) {
  if (!board) return null;
  return {
    cells: Array.from(board.cells || []),
    hits: Array.from(board.hits || []),
    misses: Array.from(board.misses || []),
  };
}


// Wasser für versenktes Schiff berechnen
function getSurroundingWater(coords, hits, misses) {
  const water = new Set();
  for (const c of coords) {
    const [x, y] = c.split(",").map(Number);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx,
          ny = y + dy;
        const key = `${nx},${ny}`;
        if (nx < 0 || nx >= 10 || ny < 0 || ny >= 10) continue;
        if (coords.includes(key)) continue;
        if (!hits.has(key) && !misses.has(key)) water.add(key);
      }
    }
  }
  return Array.from(water);
}

// Verbindungshandling
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  ws.on("message", (msg) => {
    console.log("📩 Eingehende Nachricht:", msg.toString());

    try {
      const data = JSON.parse(msg);

      // Raum erstellen
      if (data.type === "create") {
        const code = (data.room || "").toUpperCase();
        if (rooms.has(code)) {
          ws.send(JSON.stringify({ type: "error", msg: "Raum existiert bereits." }));
          return;
        }

        rooms.set(code, {
          players: [ws],
          spectators: [],
          names: [data.name || "Spieler 1"],
          boards: { 1: null, 2: null },
          readyById: { 1: false, 2: false },
          turn: null,
        });

        ws.room = code;
        ws.playerId = 1;

        console.log(`🆕 Neuer Raum erstellt: ${code}`);
        ws.send(JSON.stringify({ type: "joined", playerId: 1, room: code }));
        broadcastRoomUpdate(code);
        return;
      }

      // Raum beitreten 
      if (data.type === "join") {
        const code = (data.room || "").toUpperCase();
        const room = rooms.get(code);
        if (!room || room.players.length >= 2) {
          ws.send(
            JSON.stringify({
              type: "error",
              msg: "Raum voll oder nicht gefunden.",
            }),
          );
          return;
        }

        room.players.push(ws);
        room.names.push(data.name || "Spieler 2");
        room.readyById[2] = false;
        ws.room = code;
        ws.playerId = 2;

        console.log(`👥 Spieler beigetreten: ${code}`);
        ws.send(JSON.stringify({ type: "joined", playerId: 2, room: code }));

        broadcastRoomUpdate(code);
        return;
      }

      
      // Zuschauer beitreten 
      if (data.type === "spectate") {
        const code = (data.room || "").toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          ws.send(JSON.stringify({ type: "error", msg: "Raum nicht gefunden." }));
          return;
        }

        room.spectators ||= [];
        room.spectators.push(ws);

        ws.room = code;
        ws.playerId = 0;
        ws.role = "spectator";
        ws.name = data.name || "Zuschauer";

        console.log(`👀 Zuschauer beigetreten: ${code}`);
        ws.send(JSON.stringify({ type: "joined", playerId: 0, room: code, spectator: true }));
        broadcastRoomUpdate(code);

      
        if (room.turn) {
          ws.send(JSON.stringify({ type: "turnUpdate", current: room.turn }));
        }
        return;
      }

// Spieler Ready Toggle
      if (data.type === "ready") {
        const room = rooms.get(ws.room);
        if (!room) return;

        const wantReady = !!data.ready;
        if (wantReady) {
          const cells = data.board || [];
          room.boards[ws.playerId] = createBoard(cells);
          room.readyById[ws.playerId] = true;
          console.log(`🧭 Spieler ${ws.playerId} ist bereit (${cells.length} Schiffszellen).`);
        } else {
          room.boards[ws.playerId] = null;
          room.readyById[ws.playerId] = false;
          console.log(`🧭 Spieler ${ws.playerId} ist nicht bereit.`);
        }

        broadcastRoomUpdate(ws.room);
        return;
      }

      // Host startet das Spiel
      if (data.type === "startGame") {
        const room = rooms.get(ws.room);
        if (!room) return;

        // Spieler 1 ist Host
        if (ws.playerId !== 1) {
          ws.send(JSON.stringify({ type: "error", msg: "Nur der Host kann starten." }));
          return;
        }

        const bothReady = !!room.readyById?.[1] && !!room.readyById?.[2];
        if (!bothReady) {
          ws.send(
            JSON.stringify({
              type: "error",
              msg: "Spiel kann erst starten, wenn beide bereit sind.",
            }),
          );
          return;
        }

        const first = Math.random() < 0.5 ? 1 : 2;
        room.turn = first;
        room.players.forEach((p, idx) => {
          if (p.readyState === WebSocket.OPEN) {
            p.send(JSON.stringify({ type: "start", youStart: idx + 1 === first, first }));
          }
        });
        (room.spectators || []).forEach((p) => {
          if (p.readyState === WebSocket.OPEN) {
            p.send(JSON.stringify({ type: "start", spectator: true, first }));
          }
        });
        return;
      }

      // Schusslogik
      if (data.type === "move") {
        const room = rooms.get(ws.room);
        if (!room) return;

        const shooterId = ws.playerId;
        const targetId = shooterId === 1 ? 2 : 1;
        const shooter = room.boards[shooterId];
        const target = room.boards[targetId];
        const cell = data.cell;

        if (!target || !shooter) return;
        if (room.turn !== shooterId) {
          ws.send(JSON.stringify({ type: "error", msg: "Nicht dein Zug!" }));
          return;
        }

        // Doppelschüsse blockieren
        if (shooter.shots.has(cell)) {
          ws.send(JSON.stringify({ type: "error", msg: "Feld wurde bereits beschossen!" }));
          return;
        }
        shooter.shots.add(cell);

        let hit = false;
        let sunk = null;

        for (const ship of target.ships) {
          if (ship.coords.includes(cell)) {
            hit = true;
            ship.hits.add(cell);
            target.hits.add(cell);
            target.cells.delete(cell);

            if (ship.hits.size === ship.coords.length) {
              sunk = {
                coords: ship.coords,
                around: getSurroundingWater(ship.coords, target.hits, target.misses),
              };
              for (const k of sunk.around) target.misses.add(k);
            }
            break;
          }
        }

        if (!hit) target.misses.add(cell);

        // Ergebnis an Spieler
        room.players.forEach((p, idx) => {
          const isShooter = idx + 1 === shooterId;
          if (p.readyState === WebSocket.OPEN) {
            p.send(
              JSON.stringify({
                type: "moveResult",
                cell,
                hit,
                sunk,
                byMe: isShooter,
                shooter: shooterId,
                target: targetId,
              }),
            );
          }
        });

        // Ergebnis an Zuschauer
        (room.spectators || []).forEach((p) => {
          if (p.readyState === WebSocket.OPEN) {
            p.send(
              JSON.stringify({
                type: "moveResult",
                cell,
                hit,
                sunk,
                byMe: false,
                shooter: shooterId,
                target: targetId,
              }),
            );
          }
        });

        // Spielende prüfen
        const allSunk = target.ships.every((s) => s.hits.size === s.coords.length);
        if (allSunk) {
          room.players.forEach((p, idx) => {
            if (p.readyState === WebSocket.OPEN) {
              p.send(
                JSON.stringify({
                  type: "gameOver",
                  winner: shooterId,
                  youWin: idx + 1 === shooterId,
                  reveal: {
                    1: serializeBoardForReveal(room.boards[1]),
                    2: serializeBoardForReveal(room.boards[2]),
                  },
                }),
              );
            }
          });
          (room.spectators || []).forEach((p) => {
            if (p.readyState === WebSocket.OPEN) {
              p.send(JSON.stringify({ type: "gameOver", winner: shooterId, spectator: true }));
            }
          });
          rooms.delete(ws.room);
          return;
        }

        // Nächster Zug
        const nextTurn = hit ? shooterId : targetId;
        room.turn = nextTurn;
        room.players.forEach((p) => {
          if (p.readyState === WebSocket.OPEN) {
            p.send(JSON.stringify({ type: "turnUpdate", current: nextTurn }));
          }
        });
        (room.spectators || []).forEach((p) => {
          if (p.readyState === WebSocket.OPEN) {
            p.send(JSON.stringify({ type: "turnUpdate", current: nextTurn }));
          }
        });
      }
    } catch (e) {
      console.error("Fehler bei Nachricht:", e);
      ws.send(JSON.stringify({ type: "error", msg: "Ungültige Nachricht." }));
    }
  });

  ws.on("close", () => {
    if (ws.room && rooms.has(ws.room)) {
      const room = rooms.get(ws.room);
      const code = ws.room;
      room.players = (room.players || []).filter((p) => p !== ws);
      room.spectators = (room.spectators || []).filter((p) => p !== ws);
      if (ws.playerId) {
        room.readyById[ws.playerId] = false;
        room.boards[ws.playerId] = null;
      }

      console.log(`❌ Spieler getrennt von Raum ${code}`);

      // Spieler oder zuschauer informieren
      [...room.players, ...(room.spectators || [])].forEach((p) => {
        if (p.readyState === WebSocket.OPEN) p.send(JSON.stringify({ type: "opponentLeft" }));
      });

      if ((room.players.length === 0) && ((room.spectators || []).length === 0)) {
        rooms.delete(code);
      } else {
        broadcastRoomUpdate(code);
      }
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`🚀 Server läuft auf ${HOST}:${PORT}`);
});
