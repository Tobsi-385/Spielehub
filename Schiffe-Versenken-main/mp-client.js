// mp-client.js
// WebSocket-Client 

(function (global) {
  const handlers = {};

  // Normalisiert Eingaben zu einer WebSocket-URL auf /ws 
  function normalizeWsUrl(input) {
    const loc = window.location;
    const defaultProto = loc.protocol === "https:" ? "wss:" : "ws:";
    const defaultBase = `${defaultProto}//${loc.host}`;

    let u;
    if (!input) {
      u = new URL("/ws", defaultBase);
    } else if (/^wss?:\/\//i.test(input)) {
      u = new URL(input);
    } else if (/^https?:\/\//i.test(input)) {
      u = new URL(input);
      u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    } else {
      u = new URL(input, defaultBase);
      u.protocol = defaultProto;
    }

    // Endpoint auf /ws 
    u.pathname = "/ws";
    return u.toString();
  }

  const MP = {
    state: {
      ws: null,
      url: null, 
      room: null,
      name: null,
      myId: null,
      turn: null,
      joinMode: "join", 
      _joined: false,
    },

    on(evt, fn) {
      (handlers[evt] ||= []).push(fn);
    },

    emit(evt, data) {
      (handlers[evt] || []).forEach((f) => f(data));
    },
    // Verbindung augbauen + initiale senden
    connect(url, { room, name, joinMode }) {
      const finalUrl = normalizeWsUrl(url);

      this.state.url = finalUrl;
      this.state.room = (room || "").toUpperCase();
      this.state.name = name || "Spieler";
      this.state.joinMode = joinMode || "join";
      this.state._joined = false;

      console.log("🌐 Verbinde zu:", this.state.url);

      const ws = new WebSocket(this.state.url);
      this.state.ws = ws;

      ws.onopen = () => {
        const msg = {
          type: this.state.joinMode === "create" ? "create" : this.state.joinMode === "spectate" ? "spectate" : "join",
          room: this.state.room,
          name: this.state.name,
        };
        ws.send(JSON.stringify(msg));
      };
      // Error 
      ws.onerror = () => {
        this.state.ws = null;
        this.emit("connectError", {
          reason: "NETWORK",
          message: "Server nicht erreichbar.",
        });
      };

      ws.onclose = () => {
        const wasJoined = this.state._joined;

        // Cleanup
        this.state.ws = null;
        this.state._joined = false;

        // Vor Join geschlossen 
        if (!wasJoined) {
          this.emit("connectError", {
            reason: "CLOSED",
            message: "Verbindung geschlossen.",
          });
        } else {
          this.emit("closed", {});
        }
      };

      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        // Server Nachrichten 
        if (msg.type === "joined") {
          // Server aktzeptiert Join
          this.state._joined = true;
          this.state.myId = msg.playerId;
          this.emit("joined", msg);

        } else if (msg.type === "roomUpdate") {
          // Lobbyzustand
          this.emit("roomUpdate", msg);
          
        } else if (msg.type === "start") {
          // Games start
          if (this.state.myId === 0) {
            // Zuschauer
            this.state.turn = msg.first || 1;
            this.emit("start", { spectator: true, first: this.state.turn });
          } else {
            // Wer beginnt
            this.state.turn = msg.youStart
              ? this.state.myId
              : this.state.myId === 1
                ? 2
                : 1;
            this.emit("start", { youStart: msg.youStart, first: msg.first || this.state.turn });
          }
        } else if (msg.type === "moveResult") {
          // Ergebnis eines Schusses
          if (this.state.myId === 0) {
            // Zuschauer Ergebnis weiterreichen
            this.emit("shotResult", {
              spectator: true,
              shooter: msg.shooter,
              target: msg.target,
              cell: msg.cell,
              hit: msg.hit,
              sunk: msg.sunk || null,
            });
          } else {
            const byMe = msg.shooter === this.state.myId;
            const nextIsMe = msg.target === this.state.myId;
            // Welcher Spieler ist als nächstes
            this.state.turn = nextIsMe ? this.state.myId : msg.target;
            this.emit("shotResult", {
              byMe,
              cell: msg.cell,
              hit: msg.hit,
              nextIsMe,
              sunk: msg.sunk || null,
            });
          }
        } else if (msg.type === "turnUpdate") {
          // Turn aktualisierung
          this.state.turn = msg.current;
          this.emit("turnUpdate", { current: msg.current });
        } else if (msg.type === "gameOver") {
          // Spielende
          if (this.state.myId === 0) {
            this.emit("gameOver", { spectator: true, winner: msg.winner });
          } else {
            const youWin = msg.winner === this.state.myId;
            this.emit("gameOver", { youWin, winner: msg.winner, reveal: msg.reveal });
          }
        } else if (msg.type === "opponentLeft") {
          // Gegner verlässt Raum
          this.emit("opponentLeft", {});
        } else if (msg.type === "error") {
          this.emit("serverError", msg);
        }
      };
    },

    // Ready Status
    ready(boardCells, ready = true) {
      this.state.ws?.send(
        JSON.stringify({ type: "ready", ready: !!ready, board: boardCells }),
      );
    },
    // Host startet das Spiel
    startGame() {
      this.state.ws?.send(JSON.stringify({ type: "startGame" }));
    },
    // Schuss abgebe: wenn WS offen ist
    fire(x, y) {
      if (!this.state.ws || this.state.ws.readyState !== WebSocket.OPEN) return;
      this.state.ws.send(JSON.stringify({ type: "move", cell: `${x},${y}` }));
    },
  };

  global.MP = MP;
})(window);
