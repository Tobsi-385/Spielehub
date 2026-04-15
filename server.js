const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJson(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0] || '/');

  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('ok');
  }

  let filePath = urlPath === '/'
    ? path.join(__dirname, 'hub.html')
    : path.join(__dirname, urlPath.replace(/^\//, ''));

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 - Not Found');
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
});

const battleshipWss = new WebSocket.Server({ noServer: true });
const kniffelWss = new WebSocket.Server({ noServer: true });

const kniffelRooms = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function getKniffelRoom(code) {
  return kniffelRooms.get((code || '').toUpperCase());
}

function lobbyState(room) {
  return {
    code: room.code,
    players: room.players.map((p, i) => ({
      id: i + 1,
      name: p.name,
      connected: p.ws.readyState === WebSocket.OPEN,
      host: i === 0,
    })),
    started: room.started,
  };
}

function broadcastKniffel(room, payload) {
  room.players.forEach((p) => sendJson(p.ws, payload));
  room.spectators.forEach((p) => sendJson(p.ws, payload));
}

function attachKniffelPlayer(ws, room, name, role = 'player') {
  ws.roomCode = room.code;
  ws.role = role;
  ws.playerName = name;
}

kniffelWss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    if (data.type === 'create') {
      let code = (data.room || '').trim().toUpperCase();
      if (!code) {
        do { code = makeCode(); } while (kniffelRooms.has(code));
      }
      if (kniffelRooms.has(code)) {
        return sendJson(ws, { type: 'error', msg: 'Raum existiert bereits.' });
      }
      const room = {
        code,
        players: [{ ws, name: data.name || 'Spieler 1' }],
        spectators: [],
        started: false,
      };
      kniffelRooms.set(code, room);
      attachKniffelPlayer(ws, room, room.players[0].name, 'player');
      sendJson(ws, { type: 'joined', room: code, playerId: 1, isHost: true });
      broadcastKniffel(room, { type: 'roomUpdate', room: lobbyState(room) });
      return;
    }

    if (data.type === 'join') {
      const room = getKniffelRoom(data.room);
      if (!room) return sendJson(ws, { type: 'error', msg: 'Raum nicht gefunden.' });
      if (room.players.length >= 2) return sendJson(ws, { type: 'error', msg: 'Raum ist voll.' });
      const player = { ws, name: data.name || `Spieler ${room.players.length + 1}` };
      room.players.push(player);
      attachKniffelPlayer(ws, room, player.name, 'player');
      sendJson(ws, { type: 'joined', room: room.code, playerId: room.players.length, isHost: false });
      broadcastKniffel(room, { type: 'roomUpdate', room: lobbyState(room) });
      return;
    }

    if (data.type === 'spectate') {
      const room = getKniffelRoom(data.room);
      if (!room) return sendJson(ws, { type: 'error', msg: 'Raum nicht gefunden.' });
      room.spectators.push({ ws, name: data.name || 'Zuschauer' });
      attachKniffelPlayer(ws, room, data.name || 'Zuschauer', 'spectator');
      sendJson(ws, { type: 'joined', room: room.code, playerId: 0, spectator: true });
      sendJson(ws, { type: 'roomUpdate', room: lobbyState(room) });
      return;
    }

    if (data.type === 'startGame') {
      const room = getKniffelRoom(ws.roomCode);
      if (!room) return;
      const isHost = room.players[0] && room.players[0].ws === ws;
      if (!isHost) return sendJson(ws, { type: 'error', msg: 'Nur Host darf starten.' });
      if (room.players.length < 2) return sendJson(ws, { type: 'error', msg: 'Warte auf Spieler 2.' });
      room.started = true;
      broadcastKniffel(room, { type: 'start', room: room.code });
      return;
    }

    if (data.type === 'message') {
      const room = getKniffelRoom(ws.roomCode);
      if (!room) return;
      broadcastKniffel(room, {
        type: 'message',
        from: ws.playerName || 'Spieler',
        text: String(data.text || ''),
      });
      return;
    }

    if (data.type === 'state') {
      const room = getKniffelRoom(ws.roomCode);
      if (!room) return;
      room.players.forEach((p) => {
        if (p.ws !== ws) sendJson(p.ws, data);
      });
      room.spectators.forEach((s) => sendJson(s.ws, data));
    }
  });

  ws.on('close', () => {
    const room = getKniffelRoom(ws.roomCode);
    if (!room) return;
    room.players = room.players.filter((p) => p.ws !== ws);
    room.spectators = room.spectators.filter((s) => s.ws !== ws);
    if (!room.players.length && !room.spectators.length) {
      kniffelRooms.delete(room.code);
      return;
    }
    broadcastKniffel(room, { type: 'roomUpdate', room: lobbyState(room) });
  });
});

battleshipWss.on('connection', (ws) => {
  sendJson(ws, { type: 'info', msg: 'Battleship-WebSocket verbunden.' });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/kniffel/ws') {
    kniffelWss.handleUpgrade(req, socket, head, (ws) => kniffelWss.emit('connection', ws, req));
    return;
  }
  if (url.pathname === '/battleship/ws') {
    battleshipWss.handleUpgrade(req, socket, head, (ws) => battleshipWss.emit('connection', ws, req));
    return;
  }
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`Server läuft auf ${HOST}:${PORT}`);
});
