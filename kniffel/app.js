(() => {
  "use strict";

  let isHost = false;
  let socket = null;
  let myPlayerId = null;
  let currentRoom = null;
  let connected = false;

  const $ = (id) => document.getElementById(id);
  const els = {
    playerName: $("playerName"),
    roomCode: $("roomCode"),
    btnCreateRoom: $("btnCreateRoom"),
    btnJoinRoom: $("btnJoinRoom"),
    btnStartGame: $("btnStartGame"),
    status: $("status"),
    log: $("log"),
  };

  function setStatus(text) {
    if (els.status) els.status.textContent = text;
  }

  function logLine(text) {
    if (!els.log) return;
    const t = new Date().toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    els.log.textContent += `[${t}] ${text}\n`;
    els.log.scrollTop = els.log.scrollHeight;
  }

  function wsUrl() {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${location.host}/kniffel/ws`;
  }

  function ensureSocket() {
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    socket = new WebSocket(wsUrl());

    socket.addEventListener("open", () => {
      connected = true;
      setStatus("Verbunden mit dem Server");
      logLine("WebSocket verbunden");
    });

    socket.addEventListener("message", (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        logLine(`Unlesbare Nachricht: ${event.data}`);
        return;
      }

      if (data.type === "error") {
        setStatus(data.msg || "Fehler");
        logLine(`Fehler: ${data.msg || "Unbekannt"}`);
        return;
      }

      if (data.type === "joined") {
        currentRoom = data.room || currentRoom;
        myPlayerId = data.playerId ?? myPlayerId;
        isHost = !!data.isHost;
        if (els.roomCode && currentRoom) els.roomCode.value = currentRoom;
        setStatus(`Raum ${currentRoom} betreten`);
        logLine(`Beigetreten als Spieler ${myPlayerId}${isHost ? " (Host)" : ""}`);
        return;
      }

      if (data.type === "roomUpdate") {
        const room = data.room || {};
        const players = room.players || [];
        const label = players.length
          ? players
              .map((p) => `${p.name}${p.host ? " (Host)" : ""}`)
              .join(" • ")
          : "keine Spieler";
        setStatus(`Lobby ${room.code || currentRoom || "—"}: ${label}`);
        logLine(`Lobby aktualisiert: ${label}`);
        return;
      }

      if (data.type === "start") {
        setStatus(`Spiel gestartet in Raum ${currentRoom}`);
        logLine("Spielstart erhalten");
        return;
      }

      if (data.type === "message") {
        logLine(`${data.from || "Server"}: ${data.text || ""}`);
        return;
      }

      logLine(`Nachricht: ${JSON.stringify(data)}`);
    });

    socket.addEventListener("close", () => {
      connected = false;
      setStatus("Verbindung getrennt");
      logLine("WebSocket getrennt");
    });

    socket.addEventListener("error", () => {
      setStatus("WebSocket-Fehler");
      logLine("WebSocket-Fehler");
    });
  }

  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setStatus("Noch nicht verbunden, verbinde...");
      ensureSocket();
      const wait = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          clearInterval(wait);
          socket.send(JSON.stringify(payload));
        }
        if (socket && socket.readyState === WebSocket.CLOSED) {
          clearInterval(wait);
        }
      }, 100);
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  function createRoom() {
    const name = (els.playerName?.value || "").trim() || "Spieler 1";
    const room = (els.roomCode?.value || "").trim().toUpperCase();
    ensureSocket();
    const trySend = () => send({ type: "create", name, room });
    if (socket.readyState === WebSocket.OPEN) trySend();
    else socket.addEventListener("open", trySend, { once: true });
    logLine(`Raum erstellen angefordert${room ? ` (${room})` : ""}`);
  }

  function joinRoom() {
    const name = (els.playerName?.value || "").trim() || "Spieler 2";
    const room = (els.roomCode?.value || "").trim().toUpperCase();
    if (!room) {
      setStatus("Bitte einen Raumcode eingeben");
      return;
    }
    ensureSocket();
    const trySend = () => send({ type: "join", name, room });
    if (socket.readyState === WebSocket.OPEN) trySend();
    else socket.addEventListener("open", trySend, { once: true });
    logLine(`Raum beitreten angefordert (${room})`);
  }

  function startGame() {
    if (!isHost) {
      setStatus("Nur der Host kann das Spiel starten");
      logLine("Start abgelehnt: kein Host");
      return;
    }
    send({ type: "startGame" });
    logLine("Spielstart gesendet");
  }

  if (els.btnCreateRoom) els.btnCreateRoom.addEventListener("click", createRoom);
  if (els.btnJoinRoom) els.btnJoinRoom.addEventListener("click", joinRoom);
  if (els.btnStartGame) els.btnStartGame.addEventListener("click", startGame);

  if (els.status) setStatus("Bereit");
})();
