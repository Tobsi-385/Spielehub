const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const games = new Map();
const gameHistory = new Map(); // Spielhistorie speichern
const playerStats = new Map(); // Statistiken pro Spieler

// ===== UTILITY FUNCTIONS =====

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function rollDice(count = 5) {
  // Verwende crypto.randomInt für kryptographisch sichere Zufallszahlen
  return Array(count).fill(0).map(() => crypto.randomInt(1, 7));
}

function calculateScore(dice, category) {
  const sum = dice.reduce((a, b) => a + b, 0);
  const counts = {};
  dice.forEach(d => counts[d] = (counts[d] || 0) + 1);
  const values = Object.values(counts);

  const scores = {
    'ones': dice.filter(d => d === 1).length,
    'twos': dice.filter(d => d === 2).length * 2,
    'threes': dice.filter(d => d === 3).length * 3,
    'fours': dice.filter(d => d === 4).length * 4,
    'fives': dice.filter(d => d === 5).length * 5,
    'sixes': dice.filter(d => d === 6).length * 6,
    'three': values.some(v => v >= 3) ? sum : 0,
    'four': values.some(v => v >= 4) ? sum : 0,
    'full': values.includes(3) && values.includes(2) ? 25 : 0,
    'small': (
                [1,2,3,4].every(n => counts[n]) ||
                [2,3,4,5].every(n => counts[n]) ||
                [3,4,5,6].every(n => counts[n])
              ) ? 30 : 0,
    'large': (
                [1,2,3,4,5].every(n => counts[n]) ||
                [2,3,4,5,6].every(n => counts[n])
              ) ? 40 : 0,
    'kniffel': values.includes(5) ? 50 : 0,
    'chance': sum
  };

  return scores[category] || 0;
}

// Berechne Gesamtscore
// Berechne Gesamtscore inkl. Bonus (obere Sektion)
function getTotalScore(playerScores) {
  const base = Object.values(playerScores).reduce((a, b) => a + (b || 0), 0);
  const upperSum = ['ones','twos','threes','fours','fives','sixes']
    .reduce((s, cat) => s + (playerScores[cat] || 0), 0);
  const bonus = upperSum >= 63 ? 35 : 0;
  return base + bonus;
}

// Überprüfe ob Kategorie bereits genutzt wurde
function isCategoryUsed(playerScores, category) {
  return playerScores[category] !== undefined;
}

// Speichere Spiel in Datei
function saveGameToHistory(code, game, winner) {
  const history = {
    code,
    timestamp: new Date().toISOString(),
    winner,
    players: game.players.map(p => ({
      name: p.name,
      score: getTotalScore(p.scores)
    })),
    duration: game.startTime ? Date.now() - game.startTime : 0
  };
  
  gameHistory.set(code, history);
  
  // Optional: In Datei speichern
  try {
    if (!fs.existsSync('game_logs')) fs.mkdirSync('game_logs');
    fs.writeFileSync(
      `game_logs/${code}.json`,
      JSON.stringify(history, null, 2)
    );
  } catch (e) {
    console.log('⚠️ Konnte Spiel-Log nicht speichern:', e.message);
  }
}

// Update Spieler-Statistiken
function updatePlayerStats(playerName, score) {
  if (!playerStats.has(playerName)) {
    playerStats.set(playerName, {
      games: 0,
      totalScore: 0,
      avgScore: 0,
      wins: 0
    });
  }
  
  const stats = playerStats.get(playerName);
  stats.games++;
  stats.totalScore += score;
  stats.avgScore = Math.round(stats.totalScore / stats.games);
  if (score > 0) stats.wins++;
  
  return stats;
}

// --- Score-Queue: serialisiere score-Requests pro Raum, um Race-Conditions zu vermeiden
const scoreQueues = new Map();

function enqueueScore(socketId, code, cat) {
  const key = code;
  if (!scoreQueues.has(key)) scoreQueues.set(key, []);
  scoreQueues.get(key).push({ socketId, cat });
  if (scoreQueues.get(key).length === 1) {
    // Starte Verarbeitung asynchron
    setImmediate(() => processScoreQueue(key));
  }
}

async function processScoreQueue(code) {
  const q = scoreQueues.get(code);
  if (!q || q.length === 0) return;
  const item = q[0];
  try {
    await handleScore(item.socketId, code, item.cat);
  } catch (e) {
    console.error('❌ Fehler beim Verarbeiten eines Score-Queue-Items:', e);
  }
  q.shift();
  if (q.length === 0) scoreQueues.delete(code);
  else setImmediate(() => processScoreQueue(code));
}

async function handleScore(socketId, code, cat) {
  const s = io.sockets.sockets.get(socketId);
  if (!s) return;
  const g = games.get(code);
  if (!g) return;

  try {
    // Verifiziere/erlaube Turn-Mismatch tolerant (wie vorher)
    let p = g.players[g.turn];
    if (!p) {
      s.emit('error', 'Spieler nicht gefunden');
      return;
    }
    if (p.id !== socketId) {
      const idx = g.players.findIndex(pl => pl.id === socketId);
      if (idx !== -1 && (!g.players[idx].scores || g.players[idx].scores[cat] === undefined) && g.rolls < 3) {
        console.warn(`⚠️ turn mismatch in room ${code}: serverTurn=${g.turn} but scoring from index=${idx}. Accepting and switching turn.`);
        g.turn = idx;
        p = g.players[g.turn];
      } else {
        s.emit('error', 'Du bist nicht am Zug!');
        return;
      }
    }

    console.log(`🔢 score request: room=${code} player=${p.name} cat=${cat} dice=[${g.dice}]`);

    if (isCategoryUsed(p.scores, cat)) {
      s.emit('error', 'Kategorie bereits genutzt!');
      return;
    }

    const score = calculateScore(g.dice, cat);
    p.scores[cat] = score;

    g.gameLog.push({
      player: p.name,
      action: 'score',
      category: cat,
      points: score
    });

    console.log(`✅ scored: ${p.name} -> ${cat} = ${score}`);

    // Nach dem erfolgreichen Setzen ggf. Spielende prüfen und emitten
    const allCats = ['ones','twos','threes','fours','fives','sixes','three','four','full','small','large','kniffel','chance'];
    const isGameOver = g.players.every(player => allCats.every(c => c in player.scores));

    if (isGameOver) {
      const totals = g.players.map(pl => ({ name: pl.name, score: getTotalScore(pl.scores) }));
      totals.sort((a, b) => b.score - a.score);
      g.phase = 'finished';
      g.winner = totals[0];
      saveGameToHistory(code, g, totals[0]);
      totals.forEach(t => updatePlayerStats(t.name, t.score));
      io.to(code).emit('gameOver', { winner: totals[0], standings: totals, players: g.players });
      console.log(`🏆 Spiel ${code} vorbei! Gewinner: ${totals[0].name} (${totals[0].score} Punkte)`);
    } else {
      // Nächster Spieler
      g.turn = (g.turn + 1) % g.players.length;
      g.dice = rollDice();
      g.rolls = 3;
      io.to(code).emit('room', g);
    }

  } catch (err) {
    console.error('❌ Fehler im handleScore:', err);
    s.emit('error', 'Interner Serverfehler beim Setzen der Punkte');
  }
}

// ===== SOCKET.IO EVENTS =====

io.on('connection', (socket) => {
  console.log('👤 Spieler verbunden:', socket.id);

  // Raum erstellen
  socket.on('create', ({ name }) => {
    const code = generateRoomCode();
    const game = {
      roomCode: code,
      players: [{ id: socket.id, name, isHost: true, scores: {} }],
      turn: 0,
      dice: [1,1,1,1,1],
      rolls: 3,
      phase: 'waiting',
      chat: [],
      startTime: null,
      maxPlayers: 4,
      gameLog: []
    };
    
    games.set(code, game);
    socket.join(code);
    socket.emit('room', game);
    console.log(`✅ Raum ${code} erstellt von ${name}`);
  });

  // Raum beitreten
  socket.on('join', ({ code, name }) => {
    if (!code || !name) {
      socket.emit('error', 'Code und Name erforderlich');
      return;
    }

    const game = games.get(code.toUpperCase());
    if (!game) {
      socket.emit('error', 'Raum nicht gefunden');
      return;
    }

    if (game.players.length >= game.maxPlayers) {
      socket.emit('error', `Raum voll (max. ${game.maxPlayers} Spieler)`);
      return;
    }

    const p = { id: socket.id, name, isHost: false, scores: {} };
    game.players.push(p);
    socket.join(code.toUpperCase());
    
    io.to(code.toUpperCase()).emit('room', game);
    io.to(code.toUpperCase()).emit('chat', {
      system: true,
      message: `${name} ist beigetreten`,
      timestamp: new Date().toLocaleTimeString('de-DE')
    });
    console.log(`✅ ${name} beigetreten zu ${code}`);
  });

  // Spiel starten
  socket.on('start', ({ code }) => {
    const g = games.get(code);
    if (g) {
      g.phase = 'playing';
      g.turn = 0;
      g.dice = rollDice();
      g.rolls = 3;
      g.startTime = Date.now();
      g.gameLog = [];
      
      console.log(`🎮 Spiel ${code} gestartet. ${g.players[0].name} am Zug`);
      io.to(code).emit('room', g);
    }
  });

  // Würfel werfen
  socket.on('roll', ({ code, kept }) => {
    const g = games.get(code);
    if (!g || g.rolls <= 0) return;

    // Validierung
    if (kept.length !== g.dice.length) return;

    g.dice = g.dice.map((d, i) => kept[i] ? d : crypto.randomInt(1,7));
    g.rolls--;

    g.gameLog.push({
      player: g.players[g.turn].name,
      action: 'roll',
      dice: g.dice,
      rollsLeft: g.rolls
    });

    io.to(code).emit('room', g);
  });

  // Score setzen
  // Wire up score requests to the queue to avoid races (clients still emit 'score')
  socket.on('score', ({ code, cat }) => {
    // push into per-room queue; the handler will validate socket id
    enqueueScore(socket.id, code, cat);
  });

  // Chat-Nachricht
  socket.on('chat', ({ code, message }) => {
    const g = games.get(code);
    if (!g) return;

    const sender = g.players.find(p => p.id === socket.id);
    if (!sender) return;

    const chatMsg = {
      player: sender.name,
      message: message.substring(0, 200),
      timestamp: new Date().toLocaleTimeString('de-DE')
    };

    g.chat.push(chatMsg);
    io.to(code).emit('chat', chatMsg);
  });

  // Leaderboard abrufen
  socket.on('getLeaderboard', () => {
    const lb = Array.from(playerStats.entries())
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.totalScore - a.totalScore)
      .slice(0, 10);

    socket.emit('leaderboard', lb);
  });

  // Spiel-Historie abrufen
  socket.on('getHistory', ({ code }) => {
    const history = gameHistory.get(code);
    socket.emit('gameHistory', history || null);
  });

  // Statistiken abrufen
  socket.on('getStats', ({ playerName }) => {
    const stats = playerStats.get(playerName);
    socket.emit('playerStats', stats || null);
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log('👤 Spieler getrennt:', socket.id);

    // Cleanup: Entferne Spieler aus Spielen
    games.forEach((game, code) => {
      game.players = game.players.filter(p => p.id !== socket.id);
      
      // Wenn Spiel leer, lösche es
      if (game.players.length === 0) {
        games.delete(code);
        console.log(`🗑️ Raum ${code} gelöscht (leer)`);
      } else {
        // Benachrichtige andere Spieler
        io.to(code).emit('playerLeft', {
          message: 'Ein Spieler hat das Spiel verlassen'
        });
        io.to(code).emit('room', game);
      }
    });
  });

  // Raum neu starten: Erzeuge neuen Raumcode und verschiebe alle verbundenen Spieler
  socket.on('restartRoom', ({ code }) => {
    const old = games.get(code);
    if (!old) {
      socket.emit('error', 'Alter Raum nicht gefunden');
      return;
    }

    // Erzeuge neuen Raum
    const newCode = generateRoomCode();
    const newGame = {
      roomCode: newCode,
      players: old.players.map(p => ({ id: p.id, name: p.name, isHost: p.id === socket.id, scores: {} })),
      turn: 0,
      dice: [1,1,1,1,1],
      rolls: 3,
      phase: 'waiting',
      chat: [],
      startTime: null,
      maxPlayers: old.maxPlayers,
      gameLog: []
    };

    // Speichere neuen Raum
    games.set(newCode, newGame);

    // Für jeden Spieler: verlasse alten Raum und trete neuem bei (falls verbunden)
    old.players.forEach(p => {
      const s = io.sockets.sockets.get(p.id);
      if (s) {
        try { s.leave(code); } catch (e) {}
        s.join(newCode);
        s.emit('room', newGame);
      }
    });

    console.log(`🔁 Raum ${code} neu gestartet -> neuer Raum ${newCode}`);
  });
});

// ===== SERVER STARTEN =====

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
  console.log(`📝 Logs werden in ./game_logs/ gespeichert`);
});
