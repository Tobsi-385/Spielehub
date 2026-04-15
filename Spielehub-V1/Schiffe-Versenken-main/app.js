// Schiffeversenken Deluxe 
(() => {
  "use strict";

  const T = (key, vars) => (window.I18N ? window.I18N.t(key, vars) : key);

  
  const DOM = {};


  document.addEventListener("contextmenu", (e) => e.preventDefault());

  // Multiplayer Flags & DOM-Referenzen
  const Online = {
    enabled: false,
    role: "player", 
    myTurn: false,
    
    currentTurnId: null,
sentReady: false,
    myId: null,
    _autoStarted: false,

    
    roomCode: null,
    players: [], 
  };

function getPlayerNameById(id) {
  const p = (Online.players || []).find((x) => x.id === id);
  return (p && p.name) ? p.name : `Spieler ${id}`;
}


  const ownBoardEl = document.getElementById("ownBoard");
  const enemyBoardEl = document.getElementById("enemyBoard");
  const statusEl = document.getElementById("status");
  const BOARD_SIZE = 10;

  // Wiederholung
  const REPLAY_CTX_KEY = "svx_replay_ctx";
  const REPLAY_RETURN_KEY = "svx_replay_return";

  function saveReplayCtx(ctx) {
    try {
      sessionStorage.setItem(REPLAY_CTX_KEY, JSON.stringify(ctx || {}));
    } catch {}
  }
  function readReplayCtx() {
    try {
      const raw = sessionStorage.getItem(REPLAY_CTX_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function requestReturnToSetup() {
    try {
      sessionStorage.setItem(REPLAY_RETURN_KEY, "1");
    } catch {}
    location.reload();
  }

 // Lobby-Code nach Neuladen speichern 
  const ONLINE_STORE_KEY = "svx_online_last";

  function idxToRC(idx) {
    return { r: Math.floor(idx / BOARD_SIZE), c: idx % BOARD_SIZE };
  }
  function rcToIdx(r, c) {
    return r * BOARD_SIZE + c;
  }
  // Offline-Rendering 
  function cellAt(boardEl, r, c) {
    return boardEl.querySelectorAll(".cell")[rcToIdx(r, c)];
  }
  // Online Modus & Ready
  function getOwnBoardCells() {
    return [...ownBoardEl.querySelectorAll(".cell.placed")].map(
      (el) => `${el.dataset.x},${el.dataset.y}`,
    );
  }
  function setStatus(txt) {
    if (statusEl) statusEl.textContent = txt;
    if (DOM?.barStatus) DOM.barStatus.textContent = txt;
  }

  // Menü-Fehlerbanner 
  function showMenuError(msg) {
    const panel =
      document.querySelector("#menu .menu-panel") ||
      document.getElementById("menu");
    let box = document.getElementById("onlineError");
    if (!box) {
      box = document.createElement("div");
      box.id = "onlineError";
      box.style.margin = "10px 0";
      box.style.padding = "10px 12px";
      box.style.border = "1px solid #b91c1c";
      box.style.background = "#7f1d1d";
      box.style.color = "#fff";
      box.style.borderRadius = "10px";
      box.style.boxShadow = "0 6px 18px rgba(0,0,0,.25)";
      panel.appendChild(box);
    }
    box.textContent = msg;
  }
  function clearMenuError() {
    const box = document.getElementById("onlineError");
    if (box) box.remove();
  }
  function setOnlineButtonsDisabled(disabled) {
    const b1 = document.getElementById("btnCreateRoom");
    const b2 = document.getElementById("btnJoinRoom");
    if (b1) b1.disabled = disabled;
    if (b2) b2.disabled = disabled;
  }

  // Hilfsfunktionen
  const qs = (s, e = document) => e.querySelector(s);
  const qsa = (s, e = document) => [...e.querySelectorAll(s)];
  const inBounds = (x, y) => x >= 0 && x < 10 && y >= 0 && y < 10;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // Sounds 
  let audioCtx = null;
  const ensureCtx = () =>
    audioCtx ||
    (audioCtx = new (window.AudioContext || window.webkitAudioContext)());
  function tone({ freq = 440, dur = 0.12, type = "sine", gain = 0.08 }) {
    if (!State.soundOn) return;
    const ctx = ensureCtx(),
      osc = ctx.createOscillator(),
      g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.value = gain;
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  }
  const SND = {
    hit: () => {
      tone({ freq: 260, type: "square", dur: 0.09, gain: 0.12 });
      setTimeout(
        () => tone({ freq: 330, type: "square", dur: 0.09, gain: 0.12 }),
        80,
      );
    },
    miss: () => tone({ freq: 160, type: "sine", dur: 0.12, gain: 0.08 }),
    sink: () => {
      tone({ freq: 110, type: "sawtooth", dur: 0.18, gain: 0.12 });
      setTimeout(
        () => tone({ freq: 80, type: "sawtooth", dur: 0.22, gain: 0.1 }),
        120,
      );
    },
    win: () => {
      tone({ freq: 440, type: "triangle", dur: 0.15, gain: 0.12 });
      setTimeout(
        () => tone({ freq: 660, type: "triangle", dur: 0.2, gain: 0.1 }),
        160,
      );
    },
  };

  // Flotte
  const FLEET = [
    { id: "C", name: "Träger", len: 5 },
    { id: "B", name: "Schlachtschiff", len: 4 },
    { id: "D", name: "Zerstörer", len: 3 },
    { id: "S", name: "U-Boot", len: 3 },
    { id: "P", name: "Patrouille", len: 2 },
  ];

  // Board 
  class Board {
    constructor() {
      this.grid = Array.from({ length: 10 }, () => Array(10).fill(""));
      this.ships = [];
      this.hits = new Set();
      this.misses = new Set();
    }
    canPlace(ship, x, y, h) {
      const cells = [];
      for (let i = 0; i < ship.len; i++) {
        const cx = h ? x + i : x,
          cy = h ? y : y + i;
        if (!inBounds(cx, cy) || this.grid[cy][cx] !== "")
          return { ok: false, cells };
        cells.push({ x: cx, y: cy });
      }
      for (const c of cells)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = c.x + dx,
              ny = c.y + dy;
            if (!inBounds(nx, ny)) continue;
            if (
              this.grid[ny][nx] !== "" &&
              !cells.some((k) => k.x === nx && k.y === ny)
            )
              return { ok: false, cells };
          }
      return { ok: true, cells };
    }
    place(ship, x, y, h) {
      const chk = this.canPlace(ship, x, y, h);
      if (!chk.ok) return false;
      chk.cells.forEach((c) => (this.grid[c.y][c.x] = ship.id));
      this.ships.push({
        id: ship.id,
        name: ship.name,
        len: ship.len,
        coords: chk.cells,
        hits: new Set(),
        horiz: h,
      });
      return true;
    }
    removeShipAt(x, y) {
      const id = this.grid[y][x];
      if (!id) return null;
      const s = this.ships.find((sh) =>
        sh.coords.some((c) => c.x === x && c.y === y),
      );
      if (!s) return null;
      s.coords.forEach((c) => (this.grid[c.y][c.x] = ""));
      this.ships = this.ships.filter((k) => k !== s);
      return s;
    }
    randomPlace() {
      this.grid = Array.from({ length: 10 }, () => Array(10).fill(""));
      this.ships = [];
      for (const d of FLEET) {
        let ok = false,
          tries = 0;
        while (!ok && tries < 400) {
          const h = Math.random() < 0.5;
          const x = Math.floor(Math.random() * (h ? 11 - d.len : 10));
          const y = Math.floor(Math.random() * (h ? 10 : 11 - d.len));
          ok = this.place(d, x, y, h);
          tries++;
        }
      }
      return true;
    }
    shoot(x, y) {
      const k = `${x},${y}`;
      if (this.hits.has(k) || this.misses.has(k)) return { repeat: true };
      const v = this.grid[y][x];
      if (v === "") {
        this.misses.add(k);
        return { hit: false, x, y };
      }
      this.hits.add(k);
      const s = this.ships.find((o) => o.id === v);
      s.hits.add(k);
      const sunk = s.hits.size === s.len;
      return { hit: true, sunk, ship: s, x, y };
    }
    revealAround(s) {
      s.coords.forEach((c) => {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = c.x + dx,
              ny = c.y + dy;
            if (!inBounds(nx, ny)) continue;
            const k = `${nx},${ny}`;
            if (
              !this.hits.has(k) &&
              !this.misses.has(k) &&
              this.grid[ny][nx] === ""
            )
              this.misses.add(k);
          }
      });
    }
    allSunk() {
      return this.ships.every((s) => s.hits.size === s.len);
    }
  }

  // Spieler & Computer
  class Player {
    constructor(name) {
      this.name = name;
      this.board = new Board();
    }
  }
  class AI {
    constructor(mode = "easy") {
      this.mode = mode;
      this.tried = new Set();
      this.queue = [];
    }
    ns(x, y) {
      return [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ].filter(([a, b]) => inBounds(a, b));
    }
    choose() {
      if (this.mode === "smart" && this.queue.length) return this.queue.shift();
      let x, y, k;
      do {
        x = ~~(Math.random() * 10);
        y = ~~(Math.random() * 10);
        k = `${x},${y}`;
      } while (this.tried.has(k));
      return [x, y];
    }
    onResult(x, y, r) {
      const k = `${x},${y}`;
      this.tried.add(k);
      if (this.mode !== "smart" || r.repeat) return;
      if (r.hit && !r.sunk)
        this.queue.push(
          ...this.ns(x, y).filter(([a, b]) => !this.tried.has(`${a},${b}`)),
        );
      else if (r.sunk) this.queue = [];
    }
  }

 // DOM-Referenzen initialisieren
  Object.assign(DOM, {
    screens: { menu: qs("#menu"), game: qs("#game"), end: qs("#endOverlay") },
    // Spiel-Balken
    gameBar: qs("#gameBar"),
    barMode: qs("#barMode"),
    barPhase: qs("#barPhase"),
    barTurn: qs("#barTurn"),
    barStatus: qs("#barStatus"),
    barBtnSound: qs("#barBtnSound"),
    barBtnRestart: qs("#barBtnRestart"),
    barBtnMenu: qs("#barBtnMenu"),
    helpRotate: qs("#helpRotate"),
    helpRemove: qs("#helpRemove"),
    helpRandom: qs("#helpRandom"),
    helpAttack: qs("#helpAttack"),
    own: qs("#ownBoard"),
    enemy: qs("#enemyBoard"),
    dock: qs("#shipDock"),
    btnVsAI: qs("#btnVsAI"),
    btnLocal: qs("#btnLocal"),
    btnRandom: qs("#btnRandom"),
    btnStart: qs("#btnStart"),
    btnRestart: qs("#btnRestart"),
    btnMenu: qs("#btnMenu"),
    btnSound: qs("#btnSound"),
    status: qs("#status"),
    nameP1: qs("#nameP1"),
    nameP2: qs("#nameP2"),
    labelOwn: qs("#labelOwn"),
    labelEnemy: qs("#labelEnemy"),
    endText: qs("#endText"),
    playAgain: qs("#btnPlayAgain"),
    handover: qs("#handover"),
    handoverText: qs("#handoverText"),

    // Lobby Panel 
    lobbyPanel: null,
  });

  // Spiel-Balken (oben)
  function showGameBar(on) {
    if (!DOM.gameBar) return;
    DOM.gameBar.hidden = !on;
  }

  function updateGameBar() {
    if (!DOM.gameBar) return;

    // Modus
    if (DOM.barMode) {
      DOM.barMode.textContent = Online.enabled
        ? (Online.role === "spectator" ? "👀 Zuschauer" : "🌐 Online")
        : (State.vsAI ? "🤖 vs KI" : "🎮 Lokal");
    }

    // Phase
    if (DOM.barPhase) {
      DOM.barPhase.textContent =
        State.phase === "play" ? "🎯 Spiel läuft" : "🛠️ Platzieren";
    }

    // Kurzanleitung 
    const placing = State.phase !== "play";
    if (DOM.helpRotate) DOM.helpRotate.hidden = !placing;
    if (DOM.helpRemove) DOM.helpRemove.hidden = !placing;
    if (DOM.helpRandom) DOM.helpRandom.hidden = !placing;
    if (DOM.helpAttack) DOM.helpAttack.hidden = placing;

    // Aktuellen Zug anzeigen
    if (DOM.barTurn) {
      if (Online.enabled) {
        if (Online.role === "spectator") {
          const t = Online.currentTurnId;
          DOM.barTurn.textContent = t != null ? `🎯 ${getPlayerNameById(t)} dran` : "🎯 —";
        } else {
          DOM.barTurn.textContent = Online.myTurn ? "🎯 Du dran" : "🎯 Gegner dran";
        }
      } else {
        DOM.barTurn.textContent = State.phase === "play"
          ? `🎯 ${cur().name} dran`
          : `🧩 ${State.players[State.placingFor]?.name || "—"}`;
      }
    }

    // Sound-Icon
    if (DOM.barBtnSound) DOM.barBtnSound.textContent = State.soundOn ? "🔊" : "🔈";
  }

  // Buttons im Balken
  DOM.barBtnSound && (DOM.barBtnSound.onclick = () => DOM.btnSound?.click());
  DOM.barBtnRestart && (DOM.barBtnRestart.onclick = () => location.reload());
  DOM.barBtnMenu && (DOM.barBtnMenu.onclick = () => location.reload());

  // Spielerwechsel Bildschirm im Lokalen Modus
  const Handover = {
    show(msg, onContinue) {
      if (!DOM.handover) return onContinue?.();
      DOM.handoverText.textContent = msg || T("next_player_press");

      DOM.handover.classList.add("show");

      const finish = () => {
        DOM.handover.classList.remove("show");
        window.removeEventListener("keydown", onKey);
        DOM.handover.removeEventListener("click", onClick);
        DOM.handover.removeEventListener("pointerdown", onClick);
        onContinue?.();
      };

      const onKey = () => finish();
      const onClick = (e) => {
        e.preventDefault();
        finish();
      };

      window.addEventListener("keydown", onKey, { once: true });
      DOM.handover.addEventListener("click", onClick, { once: true });
      DOM.handover.addEventListener("pointerdown", onClick, { once: true });
    },
  };

  // State 
  const State = {
    phase: "menu", 
    vsAI: true,
    aiMode: "easy",
    players: [new Player("Spieler 1"), new Player("Computer")],
    ai: null,
    turn: 0, 
    placingFor: 0, 
    dragging: null,
    selectedDockId: null,
    gameStarted: false,
    soundOn: true,
  };

  // Rendering & Spielfeld-Darstellung 
  function buildBoard(el) {
    el.innerHTML = "";

    const letters = "ABCDEFGHIJ".split("");

    const top = document.createElement("div");
    top.className = "coords coords-top";
    for (const ch of letters) {
      const s = document.createElement("span");
      s.className = "coord";
      s.textContent = ch;
      top.appendChild(s);
    }

    const left = document.createElement("div");
    left.className = "coords coords-left";
    for (let i = 1; i <= 10; i++) {
      const s = document.createElement("span");
      s.className = "coord";
      s.textContent = String(i);
      left.appendChild(s);
    }

    el.appendChild(top);
    el.appendChild(left);

    for (let y = 0; y < 10; y++)
      for (let x = 0; x < 10; x++) {
        const c = document.createElement("button");
        c.className = "cell";
        c.dataset.x = x;
        c.dataset.y = y;
        el.appendChild(c);
      }
  }
  buildBoard(DOM.own);
  buildBoard(DOM.enemy);

  function cell(el, x, y) {
    return qs(`.cell[data-x="${x}"][data-y="${y}"]`, el);
  }
  function clearPlaced(el) {
    qsa(".cell", el).forEach((c) => c.classList.remove("placed"));
  }
  function paintShots(el, b, isOwn = false) {
    qsa(".cell", el).forEach((c) => {
      const x = +c.dataset.x,
        y = +c.dataset.y,
        k = `${x},${y}`;
      if (b.hits.has(k)) c.dataset.state = isOwn ? "ownHit" : "hit";
      else if (b.misses.has(k)) c.dataset.state = "miss";
      else c.removeAttribute("data-state");
    });
  }
  function paintPlaced(el, b) {
    clearPlaced(el);
    b.grid.forEach((r, y) =>
      r.forEach((v, x) => {
        if (v) cell(el, x, y).classList.add("placed");
      }),
    );
  }
  
  // Endscreen
  function applyRevealBoards(reveal) {
    if (!reveal || !Online || !Online.myId) return;
    const myId = Online.myId; 
    const oppId = myId === 1 ? 2 : 1;

    function buildFrom(r) {
      const b = new Board();
      if (!r) return b;
      (r.cells || []).forEach((k) => {
        const [x, y] = k.split(",").map(Number);
        if (Number.isFinite(x) && Number.isFinite(y) && inBounds(x, y)) {
          b.grid[y][x] = "S";
        }
      });
      (r.hits || []).forEach((k) => b.hits.add(k));
      (r.misses || []).forEach((k) => b.misses.add(k));
      return b;
    }

    State.players[0].board = buildFrom(reveal[myId] || reveal[String(myId)]);
    State.players[1].board = buildFrom(reveal[oppId] || reveal[String(oppId)]);
  }

function showEndBoardsEnhanced(){
    const endOwn = document.getElementById("endOwnBoard");
    const endEnemy = document.getElementById("endEnemyBoard");
    if (!endOwn || !endEnemy) return;

    endOwn.innerHTML = ownBoardEl ? ownBoardEl.innerHTML : "";
    endEnemy.innerHTML = enemyBoardEl ? enemyBoardEl.innerHTML : "";

    try{
      paintPlaced(endOwn, State.players[0].board);
      paintShots(endOwn, State.players[0].board, true);      
      paintPlaced(endEnemy, State.players[1].board);          
      paintShots(endEnemy, State.players[1].board, false);   
    }catch(e){
      console.warn("Endboards:", e);
    }
  }


  // Unterschiedliche Farben im lokalen 2-Spieler-Modus 
  function applyLocalBoardColors(activeIndex, mode = "play") {
    const isLocalTwoPlayer = !Online.enabled && !State.vsAI;

    DOM.own.classList.remove("p1", "p2", "active");
    DOM.enemy.classList.remove("p1", "p2", "active");
    document.body.classList.remove("turn-p1", "turn-p2", "placing-p1", "placing-p2");

    if (!isLocalTwoPlayer) return;

    const ownIsP1 = activeIndex === 0;
    const enemyIsP1 = !ownIsP1;

    DOM.own.classList.add(ownIsP1 ? "p1" : "p2", "active");
    DOM.enemy.classList.add(enemyIsP1 ? "p1" : "p2");

    if (mode === "place") {
      document.body.classList.add(ownIsP1 ? "placing-p1" : "placing-p2");
    } else {
      document.body.classList.add(ownIsP1 ? "turn-p1" : "turn-p2");
    }
  }

  // Boards beim Spielerwechsel aktualisieren 
  function refreshBoardsForTurn() {
    applyLocalBoardColors(State.turn, "play");
    paintPlaced(DOM.own, cur().board);
    paintShots(DOM.own, cur().board, true);

    clearPlaced(DOM.enemy);
    paintShots(DOM.enemy, other().board, false);

    DOM.labelOwn.textContent = T("your_board_named", { name: cur().name });
    DOM.labelEnemy.textContent = T("enemy_board_named", { name: other().name });
    updateGameBar();
  }

  // Werft
  function currentPlacingBoard() {
    return State.players[State.placingFor].board;
  }
  function isShipPlacedOn(board, id) {
    return board.ships.some((s) => s.id === id);
  }
  function allPlacedOn(board) {
    return FLEET.every((f) => isShipPlacedOn(board, f.id));
  }

  function buildDock() {
    const board = currentPlacingBoard();
    DOM.dock.innerHTML = "";
    FLEET.forEach((def) => {
      const item = document.createElement("button");
      item.className = "dock-item";
      item.dataset.id = def.id;
      item.dataset.len = def.len;
      item.dataset.horiz = "true";

      const ship = document.createElement("div");
      ship.className = "ship";
      for (let i = 0; i < def.len; i++) {
        const seg = document.createElement("div");
        seg.className = "seg";
        ship.appendChild(seg);
      }
      const label = document.createElement("span");
      label.className = "ship-name";
      label.textContent = `${T("ship_" + def.id)} (${def.len})`;

      item.append(ship, label);

      if (isShipPlacedOn(board, def.id)) item.classList.add("used");

      item.addEventListener("click", () => selectDock(item));
      item.addEventListener("pointerdown", (e) => startDragFromDock(e, item));

      DOM.dock.appendChild(item);
    });

    DOM.btnStart.disabled = !allPlacedOn(board);
  }

  function selectDock(it) {
    if (it.classList.contains("used")) return;
    qsa(".dock-item").forEach((i) => i.classList.remove("selected"));
    it.classList.add("selected");
    State.selectedDockId = it.dataset.id;
  }

  // Drag & Drop
  function startDragFromDock(ev, item) {
    if (State.phase !== "place") return;
    if (ev.button !== 0 || item.classList.contains("used")) return;
    const id = item.dataset.id,
      len = +item.dataset.len,
      h = item.dataset.horiz === "true";
    State.dragging = { id, len, horiz: h, el: item };
    DOM.own.addEventListener("pointermove", onDragHover);
    DOM.own.addEventListener("pointerup", onDrop);
    window.addEventListener("keydown", rotateDuringDrag);
    DOM.own.style.cursor = "none";
  }
  function onDragHover(ev) {
    if (!State.dragging) return;
    const rect = DOM.own.getBoundingClientRect(),
      cs = rect.width / 10;
    const x = clamp(Math.floor((ev.clientX - rect.left) / cs), 0, 9);
    const y = clamp(Math.floor((ev.clientY - rect.top) / cs), 0, 9);
    State.dragging.lastX = x;
    State.dragging.lastY = y;
    const board = currentPlacingBoard();
    const chk = board.canPlace(
      FLEET.find((f) => f.id === State.dragging.id),
      x,
      y,
      State.dragging.horiz,
    );
    qsa(".cell", DOM.own).forEach((c) =>
      c.classList.remove("ghost", "invalid"),
    );
    chk.cells.forEach((c) =>
      cell(DOM.own, c.x, c.y)?.classList.add(chk.ok ? "ghost" : "invalid"),
    );
  }
  function rotateDuringDrag(ev) {
    if (!State.dragging) return;
    if (ev.type === "keydown" && ev.repeat) return;

    if (ev.key?.toLowerCase() === "r" || ev.type === "contextmenu") {
      ev.preventDefault();
      State.dragging.horiz = !State.dragging.horiz;

      if (typeof State.dragging.lastX === "number" && typeof State.dragging.lastY === "number") {
        const board = currentPlacingBoard();
        const chk = board.canPlace(
          FLEET.find((f) => f.id === State.dragging.id),
          State.dragging.lastX,
          State.dragging.lastY,
          State.dragging.horiz,
        );
        qsa(".cell", DOM.own).forEach((c) => c.classList.remove("ghost", "invalid"));
        chk.cells.forEach((c) =>
          cell(DOM.own, c.x, c.y)?.classList.add(chk.ok ? "ghost" : "invalid"),
        );
      }
    }
  }
  function onDrop(ev) {
    if (!State.dragging) return;
    const rect = DOM.own.getBoundingClientRect(),
      cs = rect.width / 10;
    const x = clamp(Math.floor((ev.clientX - rect.left) / cs), 0, 9);
    const y = clamp(Math.floor((ev.clientY - rect.top) / cs), 0, 9);
    placeFromDock(
      State.dragging.id,
      State.dragging.len,
      State.dragging.horiz,
      x,
      y,
    );
    endDrag();
  }
  function endDrag() {
    DOM.own.removeEventListener("pointermove", onDragHover);
    DOM.own.removeEventListener("pointerup", onDrop);
    window.removeEventListener("keydown", rotateDuringDrag);
    State.dragging = null;
    DOM.own.style.cursor = "";
    qsa(".cell", DOM.own).forEach((c) =>
      c.classList.remove("ghost", "invalid"),
    );
  }
  function placeFromDock(id, len, horiz, x, y) {
    const board = currentPlacingBoard();
    const def = FLEET.find((f) => f.id === id);
    const ok = board.place(def, x, y, horiz);
    if (ok) {
      const item = qs(`.dock-item[data-id="${id}"]`);
      if (item) item.classList.add("used");
      paintPlaced(DOM.own, board);
      DOM.btnStart.disabled = !allPlacedOn(board);
      SND.miss();
    } else {
      SND.miss();
    }

    // Lobby-UI updaten 
    if (Online.enabled) renderLobbyPanel();
  }

  // Entfernen mit Doppelklick 
  DOM.own.addEventListener("dblclick", (ev) => {
    if (State.phase !== "place") return;
    const c = ev.target.closest(".cell");
    if (!c) return;
    const board = currentPlacingBoard();
    const s = board.removeShipAt(+c.dataset.x, +c.dataset.y);
    if (s) {
      const it = qs(`.dock-item[data-id="${s.id}"]`);
      if (it) it.classList.remove("used");
      paintPlaced(DOM.own, board);
      DOM.btnStart.disabled = !allPlacedOn(board);
    }
    if (Online.enabled) renderLobbyPanel();
  });

  // Platzierung
  function enterPlacement({ resetBoards = false, forIndex = 0 } = {}) {
    State.phase = "place";
    State.placingFor = forIndex;
    buildBoard(DOM.own);
    buildBoard(DOM.enemy);

    if (resetBoards) {
      State.players[0].board = new Board();
      State.players[1].board = new Board();
    }

    const p = State.players[State.placingFor];
    DOM.labelOwn.textContent = T("placement_own_label", { name: p.name });
    DOM.labelEnemy.textContent = T("enemy_board");
    DOM.status.textContent = T("placement_status_named", { name: p.name });

    updateGameBar();

    applyLocalBoardColors(State.placingFor, "place");

    if (DOM.btnStart) DOM.btnStart.style.display = Online.enabled ? "none" : "";

    buildDock();
    paintPlaced(DOM.own, currentPlacingBoard());
    clearPlaced(DOM.enemy);
    qsa(".cell", DOM.enemy).forEach((c) => c.removeAttribute("data-state"));

    if (Online.enabled) {
      ensureLobbyPanel();
      renderLobbyPanel();
    } else {
      teardownLobbyPanel();
    }
  }

  // Spielphase (offline) 
 function beginPlay() {
  const gameBar = document.getElementById('gameBar');
  if (gameBar) gameBar.style.display = 'none';
    State.phase = "play";
    if (DOM.btnStart) DOM.btnStart.style.display = "none";
    State.gameStarted = true;
    State.turn = 0; 
    DOM.status.textContent = T("game_running_turn", { name: cur().name });
    updateGameBar();
    refreshBoardsForTurn();
    enableEnemyShooting(true);
  }

  function cur() {
    return State.players[State.turn];
  }
  function other()  {
    return State.players[1 - State.turn];
  }

  // Random Platzierung 
  DOM.btnRandom.onclick = () => {
    if (State.phase !== "place") return;
    const b = currentPlacingBoard();
    b.randomPlace();
    buildDock();
    paintPlaced(DOM.own, b);
    DOM.btnStart.disabled = false;
    if (Online.enabled) renderLobbyPanel();
  };

  // Spielstart-Steuerung
  function sendOnlineReadyIfPossible() {
    const boardCells = getOwnBoardCells();
    if (!boardCells.length || !allPlacedOn(State.players[0].board)) {
      setStatus(T("place_all_ships"));
      return false;
    }
    if (Online.sentReady) return true;

    MP.ready(boardCells);
    Online.sentReady = true;

    // markiere lokal als bereit 
    upsertOnlinePlayer(Online.myId, State.players[0].name, true);
    renderLobbyPanel();
    setStatus(T("ready_wait"));
    return true;
  }

  // Start-Button
  DOM.btnStart.onclick = () => {
    if (State.phase !== "place") return;

    // Online: NICHT "Spiel starten", sondern Ready senden
    if (Online.enabled) {
      sendOnlineReadyIfPossible();
      return;
    }

    // Offline: gegen KI oder lokal 
    if (State.vsAI) {
      if (!allPlacedOn(State.players[0].board)) return;
      State.players[1].board.randomPlace();
      beginPlay();
      return;
    }

    // Lokal 2-Spieler
    if (State.placingFor === 0) {
      if (!allPlacedOn(State.players[0].board)) return;
      const nextName = State.players[1].name || "Spieler 2";
      Handover.show(
        `${T("placing_next", { name: nextName })}`,
        () => {
          enterPlacement({ resetBoards: false, forIndex: 1 });
        },
      );
    } else {
      if (!allPlacedOn(State.players[1].board)) return;
      const startName = State.players[0].name || "Spieler 1";
      Handover.show(
        T("press_to_start", { name: startName }),
        () => {
          beginPlay();
        },
      );
    }
  };

  // Schießen
  function enableEnemyShooting(on) {
    if (on) DOM.enemy.addEventListener("click", onShoot);
    else DOM.enemy.removeEventListener("click", onShoot);
  }
  function fx(el, x, y, type) {
    const t = cell(el, x, y);
    if (!t) return;
    const d = document.createElement("div");
    d.className = "fx";
    d.innerHTML = `<div class="${type === "hit" ? "boom" : "splash"}"></div>`;
    t.appendChild(d);
    setTimeout(() => d.remove(), 1000);
  }
  function onShoot(e) {
    if (State.phase !== "play") return;
    const c = e.target.closest(".cell");
    if (!c) return;
    const x = +c.dataset.x,
      y = +c.dataset.y;

    // Online: Schuss an Server senden 
    if (Online.enabled) {
      if (!Online.myTurn) {
        setStatus(T("not_your_turn"));
        return;
      }

      // Blockiere Klicks auf bereits bekannte Felder 
      const enemyBoard = State.players[1].board;
      const key = `${x},${y}`;
      if (enemyBoard.hits.has(key) || enemyBoard.misses.has(key)) {
        setStatus(T("already_shot"));
        return;
      }

      MP.fire(x, y); 
      return;
    }

    // Offline Logik
    const enemy = other().board;
    const r = enemy.shoot(x, y);
    paintShots(DOM.enemy, enemy);
    if (r.repeat) return;

    if (r.hit) {
      fx(DOM.enemy, x, y, "hit");
      SND.hit();
      DOM.status.textContent = r.sunk ? T("sunk") : T("hit");
      if (r.sunk) {
        enemy.revealAround(r.ship);
        paintShots(DOM.enemy, enemy);
        SND.sink();
      }
      if (enemy.allSunk()) {
        end(T("win_player", { name: cur().name }));
        return;
      }
      return; // Treffer: gleicher Spieler bleibt am Zug
    }

    // Fehlschuss: Wechsel
    fx(DOM.enemy, x, y, "splash");
    SND.miss();

    if (State.vsAI) {
      enableEnemyShooting(false);
      aiTurn();
    } else {
      const next = 1 - State.turn;
      const nextName = State.players[next].name || `Spieler ${next + 1}`;
      Handover.show(`${T("turn_next", { name: nextName })}`, () => {
        State.turn = next;
        DOM.status.textContent = T("your_turn", { name: cur().name });
        refreshBoardsForTurn();
      });
    }
  }

  // KI-Zug 
  function aiTurn() {
    const b = State.players[0].board;
    const ai = State.ai || (State.ai = new AI(State.aiMode));
    const step = () => {
      const [x, y] = ai.choose(),
        r = b.shoot(x, y);
      ai.onResult(x, y, r);
      paintShots(DOM.own, b, true);

      if (r.hit) {
        fx(DOM.own, x, y, "hit");
        SND.hit();
        if (r.sunk) {
          b.revealAround(r.ship);
          paintShots(DOM.own, b, true);
          SND.sink();
        }
        if (b.allSunk()) {
          end(T("ai_won"));
          return;
        }
        setTimeout(step, 500);
      } else {
        fx(DOM.own, x, y, "splash");
        SND.miss();
        enableEnemyShooting(true);
        DOM.status.textContent = T("your_turn", { name: cur().name });
      }
    };
    setTimeout(step, 500);
  }

  // Spiel Ende
  function end(txt) {
    DOM.endText.textContent = txt;
    showEndBoardsEnhanced();
    DOM.screens.end.classList.add("show");
    SND.win();
    DOM.playAgain.onclick = () => requestReturnToSetup();
  }

  // Multiplayer Lobby
  function ensureLobbyPanel() {
    if (DOM.lobbyPanel) return DOM.lobbyPanel;
    const status = document.getElementById("status");
    if (!status) return null;

    const panel = document.createElement("div");
    panel.id = "lobbyPanel";
        panel.classList.add("mp-floating-lobby");    panel.style.padding = "10px 12px";
    panel.style.border = "1px solid rgba(255,255,255,.12)";
    panel.style.borderRadius = "12px";
    panel.style.background = "rgba(0,0,0,.25)";
    panel.style.backdropFilter = "blur(6px)";
    panel.style.boxShadow = "0 10px 28px rgba(0,0,0,.25)";

    panel.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px;">
        <div style="font-weight:800;">
          ${T("lobby_code")}: <span id="lobbyCodeTxt" style="letter-spacing:.08em;"></span>
        </div>
        <button id="btnCopyLobby" class="ghost" type="button" style="padding:6px 10px;">${T("copy")}</button>
      </div>

      <div style="font-weight:700; margin:6px 0;">${T("players")}</div>
      <div id="lobbyPlayers" style="display:grid; gap:6px;"></div>

      <div style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap;">
        <button id="btnLobbyReady" class="cta" type="button">${T("ready")}</button>
        <button id="btnLobbyStart" class="cta alt" type="button" disabled>${T("start_game")}</button>
      </div>

      <div id="lobbyHint" style="opacity:.85; font-size:.9rem; margin-top:8px;">
        ${T("auto_start")}
      </div>
    `;

    document.body.appendChild(panel);

    qs("#btnCopyLobby", panel).addEventListener("click", async () => {
      const code = Online.roomCode || "";
      try {
        await navigator.clipboard.writeText(code);
        setStatus(T("lobby_code_copied"));
      } catch {
        setStatus(`${T("lobby_code")}: ${code}`);
      }
    });

    qs("#btnLobbyReady", panel).addEventListener("click", () => {
      sendOnlineReadyIfPossible();
    });

    // Start-Button Host
    qs("#btnLobbyStart", panel).addEventListener("click", () => {
      if (Online.role === "spectator") return;
      if (Online.myId !== 1) {
        setStatus(T("only_host"));
        return;
      }
      Online._autoStarted = true;
      MP.startGame();
      setStatus(T("starting_game"));
    });

    DOM.lobbyPanel = panel;
    return panel;
  }

  function teardownLobbyPanel() {
    if (DOM.lobbyPanel) DOM.lobbyPanel.remove();
    DOM.lobbyPanel = null;
  }

  function upsertOnlinePlayer(id, name, ready) {
    if (!id) return;
    const ix = Online.players.findIndex((p) => p.id === id);
    if (ix >= 0) {
      Online.players[ix] = {
        ...Online.players[ix],
        name: name ?? Online.players[ix].name,
        ready: ready ?? Online.players[ix].ready,
      };
    } else {
      Online.players.push({ id, name: name || `Spieler ${id}`, ready: !!ready });
    }
  }

  function renderLobbyPanel() {
    const panel = ensureLobbyPanel();
    if (!panel) return;

    // Lobby Code
    const codeTxt = qs("#lobbyCodeTxt", panel);
    if (codeTxt) codeTxt.textContent = Online.roomCode || "—";

    // Spielerliste
    const list = qs("#lobbyPlayers", panel);
    if (!list) return;

    // Spielerliste synchronisieren
    if (Online.myId && !Online.players.some((p) => p.id === Online.myId)) {
      upsertOnlinePlayer(Online.myId, State.players[0].name, Online.sentReady);
    }
    if (Online.players.length === 0) {
      if (Online.myId)
        upsertOnlinePlayer(Online.myId, State.players[0].name, Online.sentReady);
    }

    // Spilerliste sortieren
    const players = [...Online.players].sort(
      (a, b) => (a.id || 0) - (b.id || 0),
    );

    list.innerHTML = "";
    players.forEach((p) => {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.gap = "10px";

      const nm = document.createElement("div");
      nm.style.fontWeight = "650";
      nm.textContent = p.name || `Player ${p.id}`;

      const st = document.createElement("div");
      st.style.opacity = "0.95";
      st.textContent = p.ready ? T("ready_yes") : T("ready_no");

      row.append(nm, st);
      list.appendChild(row);
    });

  
    const btnReady = qs("#btnLobbyReady", panel);
    const btnStart = qs("#btnLobbyStart", panel);
    
    // Zuschauermodus
    const isSpectator = Online.role === "spectator";
    if (isSpectator) {
      if (btnReady) btnReady.style.display = "none";
      if (btnStart) btnStart.style.display = "none";
      const hint = qs("#lobbyHint", panel);
      if (hint) hint.textContent = T("spectator_mode");
      return;
    }

    // Ready setzen
    if (btnReady) {
      btnReady.disabled =
        Online.sentReady || !allPlacedOn(State.players[0].board);
      btnReady.textContent = Online.sentReady ? T("ready_done") : T("ready");
    }

    // Beide Spieler Ready?
    const bothReady =
      players.length >= 2 && players.every((p) => p.ready === true);
    if (btnStart) {
      btnStart.disabled = !bothReady;
      btnStart.title = bothReady
        ? T("both_ready_title")
        : T("wait_both_ready");
    }

    const hint = qs("#lobbyHint", panel);
    if (hint) {
      hint.textContent = bothReady
        ? T("both_ready_hint")
        : T("auto_start");
    }
  }

  
  // Spielstart Menü
  
  function startVsAI() {
    Online.enabled = false;
    clearMenuError();
    State.vsAI = true;
    State.aiMode = (
      qsa('input[name="ai"]:checked')[0] || { value: "easy" }
    ).value;
    const p1 = (DOM.nameP1.value || "Spieler 1").trim();
    saveReplayCtx({
      kind: "local",
      localMode: "ai",
      nameP1: p1,
      aiMode: State.aiMode,
    });
    State.players[0] = new Player(p1);
    State.players[1] = new Player("Computer");
    switchToGame();
  }

  function startLocalGame() {
    Online.enabled = false;
    clearMenuError();
    State.vsAI = false;
    const p1 = (DOM.nameP1.value || "Spieler 1").trim();
    const p2 = (DOM.nameP2.value || "Spieler 2").trim();
    saveReplayCtx({
      kind: "local",
      localMode: "local",
      nameP1: p1,
      nameP2: p2,
    });
    State.players[0] = new Player(p1);
    State.players[1] = new Player(p2);
    switchToGame();
  }

  // Menübuttons: KI / Lokal 
  if (DOM.btnVsAI) DOM.btnVsAI.onclick = startVsAI;
  if (DOM.btnLocal) DOM.btnLocal.onclick = startLocalGame;


 // Lobby erstellen 

  function createRoom(name, code) {
    clearMenuError();
    let finalCode = (code || "").trim().toUpperCase();
    if (!finalCode) {
      finalCode = Math.random().toString(36).toUpperCase().slice(2, 8);
      const roomEl = document.getElementById("roomCode");
      if (roomEl) roomEl.value = finalCode;
    }

    Online.enabled = true; 
    Online.players = [];
    State.vsAI = false;
    setOnlineButtonsDisabled(true);
    wireMpHandlers(); 

    // Lobby-Daten speichern für nochmal spielen
    Online.roomCode = finalCode;
    storeLastOnline({ room: finalCode, name, joinMode: "create" });

    saveReplayCtx({
      kind: "mp",
      mpMode: "create",
      nameOnline: name,
      roomCode: finalCode,
    });

    MP.connect("", { room: finalCode, name, joinMode: "create" });
  }

  function joinRoom(name, code) {
    clearMenuError();
    const finalCode = (code || "").trim().toUpperCase();
    if (!finalCode) {
      showMenuError("Bitte Raumcode eingeben.");
      return;
    }

    Online.enabled = true;
    Online.sentReady = false;
    Online.players = [];
    State.vsAI = false;
    setOnlineButtonsDisabled(true);
    wireMpHandlers();

    // Lobby-Daten speichern
    Online.roomCode = finalCode;
    storeLastOnline({ room: finalCode, name, joinMode: "join" });

    saveReplayCtx({
      kind: "mp",
      mpMode: "join",
      nameOnline: name,
      roomCode: finalCode,
    });

    MP.connect("", { room: finalCode, name, joinMode: "join" });
  }

  
  function spectateRoom(name, code) {
    clearMenuError();
    const finalCode = (code || "").trim().toUpperCase();
    if (!finalCode) {
      showMenuError("Bitte Raumcode eingeben.");
      return;
    }

    Online.enabled = true;
    Online.role = "spectator";
    Online.sentReady = false;
    Online._autoStarted = false;
    Online.players = [];
    State.vsAI = false;

    setOnlineButtonsDisabled(true);
    wireMpHandlers();

    Online.roomCode = finalCode;
    storeLastOnline({ room: finalCode, name, joinMode: "spectate" });

    // Zuschauermodus bei "nochmal spielen"
    saveReplayCtx({
      kind: "spectate",
      roomCodeSpectate: finalCode,
    });

    MP.connect("", { room: finalCode, name, joinMode: "spectate" });
  }

function storeLastOnline(data) {
    try {
      sessionStorage.setItem(ONLINE_STORE_KEY, JSON.stringify(data));
    } catch {}
  }
  function readLastOnline() {
    try {
      const raw = sessionStorage.getItem(ONLINE_STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  
  // Zuschauen
  document.getElementById("btnSpectateRoom")?.addEventListener("click", () => {
    const name = "Zuschauer";
    const code = (document.getElementById("roomCodeSpectate")?.value || "").trim().toUpperCase();
    spectateRoom(name, code);
  });

// Menü: Online Raum erstellen / beitreten 
  document.getElementById("btnCreateRoom")?.addEventListener("click", () => {
    const name = (
      document.getElementById("nameOnline").value || "Spieler"
    ).trim();
    const code = (document.getElementById("roomCode").value || "")
      .trim()
      .toUpperCase();
    createRoom(name, code);
  });

  document.getElementById("btnJoinRoom")?.addEventListener("click", () => {
    const name = (
      document.getElementById("nameOnline").value || "Spieler"
    ).trim();
    const code = (document.getElementById("roomCode").value || "")
      .trim()
      .toUpperCase();
    joinRoom(name, code);
  });

  // Multiplayer Events initialisieren
  let handlersWired = false;
  function wireMpHandlers() {
    if (handlersWired) return; 
    handlersWired = true;

    MP.on("connectError", (e) => {
      setOnlineButtonsDisabled(false);
      showMenuError(e.message || "Verbindung fehlgeschlagen.");
    });
    MP.on("serverError", (e) => {
      setOnlineButtonsDisabled(false);
      showMenuError(e.message || "Fehler: Raum kann nicht verwendet werden.");
    });

    MP.on("joined", ({ playerId, room, spectator }) => {
      Online.myId = playerId;
      Online.role = spectator || playerId === 0 ? "spectator" : "player";
      Online._autoStarted = false;

      // Raumcode synchronisieren
      if (room) Online.roomCode = String(room).toUpperCase();
      else if (!Online.roomCode) {
        Online.roomCode =
          (document.getElementById("roomCode")?.value || "")
            .trim()
            .toUpperCase();
      }

   
      Online.sentReady = false;

      clearMenuError();
      setOnlineButtonsDisabled(false);

      // Spieler für Online-Match anlegen
      const myName = (document.getElementById("nameOnline")?.value || "Ich").trim();
      State.players[0] = new Player(myName || "Ich");
      State.players[1] = new Player("Gegner");

      // Spielerliste initialisieren
      Online.players = [];
      upsertOnlinePlayer(Online.myId, State.players[0].name, false);

      // Persist last online
      storeLastOnline({
        room: Online.roomCode,
        name: State.players[0].name,
        joinMode: "join",
      });

      switchToGame(); 

      if (Online.role === "spectator") {
        State.phase = "play";
        State.gameStarted = true;
        Online.myTurn = false;
        enableEnemyShooting(false);

        // Werft ausblenden
        const dock = document.getElementById("shipDock");
        if (dock) dock.style.display = "none";
        if (DOM.btnRandom) DOM.btnRandom.style.display = "none";
        if (DOM.btnStart) DOM.btnStart.style.display = "none";

        DOM.labelOwn.textContent = "Spieler 1";
        DOM.labelEnemy.textContent = "Spieler 2";
        }

      ensureLobbyPanel();
      renderLobbyPanel();

      if (Online.role === "spectator") {
        setStatus(T("spectator_connected"));
      } else {
        setStatus(T("connected_place_ready"));
      }
    });

    MP.on("roomUpdate", ({ players }) => {
      if (Array.isArray(players)) {
        players.forEach((p) => {
          upsertOnlinePlayer(p.id, p.name, !!p.ready);
        });
      }

      // Namen aktualisieren
      const my = (players || []).find((p) => p.id === Online.myId);
      const opp = (players || []).find((p) => p.id !== Online.myId);
      if (my) State.players[0].name = my.name;
      if (opp) State.players[1].name = opp.name || "Gegner";

      if (State.phase === "place") {
        DOM.labelOwn.textContent = `${State.players[0].name}: Board setzen`;
        DOM.labelEnemy.textContent = `Gegnerisches Board`;
      }

      renderLobbyPanel();

      // Auto-Start bei Ready
      if (Online.role === "player" && Online.myId === 1) {
        const listNow = (players || []);
        const bothReady = listNow.length >= 2 && listNow.every((p) => p.ready === true);
        if (bothReady && !Online._autoStarted) {
          Online._autoStarted = true;
          try { MP.startGame(); } catch {}
        }
      }
    });

    // Aktualisiert Lobbydaten und startet Spiel bei Server-Signal
    MP.on("readyState", ({ players, room, code }) => {
      if (room) Online.roomCode = String(room).toUpperCase();
      if (code) Online.roomCode = String(code).toUpperCase();

      if (Array.isArray(players)) {
        players.forEach((p) => {
          upsertOnlinePlayer(p.id, p.name, !!p.ready);
        });
      }
      renderLobbyPanel();
    });

    MP.on("start", ({ youStart, spectator, first }) => {
      State.phase = "play";
      State.gameStarted = true;

      // Wenn Spiel startet: Startbutton verstecken
      const _lp = document.getElementById("lobbyPanel");
      if (_lp) {
        const _bs = _lp.querySelector("#btnLobbyStart");
        if (_bs) _bs.style.display = "none";
      }

      if (Online.role === "spectator" || spectator) {
        Online.myTurn = false;
      } else {
        Online.myTurn = !!youStart;
        teardownLobbyPanel();
      }

      // Zugstatus
      enableEnemyShooting(true);
      refreshBoardsForTurn();
      setStatus(
        Online.myTurn
          ? T("you_start_shoot")
          : "Gegner beginnt. Warte …",
      );
    });

    // Multiplayer: Schussresultat verarbeiten
    MP.on("shotResult", (payload) => {
      const { byMe, cell: coord, hit, nextIsMe, sunk, spectator, shooter, target } = payload;
      const [x, y] = coord.split(",").map(Number);
      const key = `${x},${y}`;

      // Zuschauer: Treffer/Miss anzeigen
      if (Online.role === "spectator" || spectator) {
        const onLeft = target === 1;
        const boardEl = onLeft ? DOM.own : DOM.enemy;
        const boardObj = onLeft ? State.players[0].board : State.players[1].board;
        const el = cell(boardEl, x, y);
        if (el) el.dataset.state = hit ? (onLeft ? "ownHit" : "hit") : "miss";
        if (hit) boardObj.hits.add(key);
        else boardObj.misses.add(key);
        SND[hit ? "hit" : "miss"]?.();
        if (hit && sunk && boardObj) {
          for (const pos of sunk.coords) boardObj.hits.add(`${pos}`);
          if (sunk.around && sunk.around.length > 0) {
            sunk.around.forEach((pos) => {
              if (!boardObj.hits.has(pos) && !boardObj.misses.has(pos)) {
                boardObj.misses.add(pos);
              }
            });
          }
          paintShots(boardEl, boardObj, onLeft);
          SND.sink?.();
        }
        return;
      }

      // Board-Referenzen setzen
      const enemyBoard = State.players[1].board;
      const ownBoard = State.players[0].board;

      if (byMe) {
        const el = cell(DOM.enemy, x, y);
        if (el) el.dataset.state = hit ? "hit" : "miss";

        if (hit) {
          enemyBoard.hits.add(key);
          SND.hit();
        } else {
          enemyBoard.misses.add(key);
          SND.miss();
        }

        // Schiff versenkt: umliegende Wasserfelder aufdecken
        if (hit && sunk && enemyBoard) {
          for (const pos of sunk.coords) enemyBoard.hits.add(`${pos}`);
          if (sunk.around && sunk.around.length > 0) {
            sunk.around.forEach((pos) => {
              if (!enemyBoard.hits.has(pos) && !enemyBoard.misses.has(pos)) {
                enemyBoard.misses.add(pos);
              }
            });
          }
          paintShots(DOM.enemy, enemyBoard);
          SND.sink();
        }
      } else {
        // Gegner hat geschossen
        const el = cell(DOM.own, x, y);
        if (el) el.dataset.state = hit ? "ownHit" : "miss";

        if (hit) {
          ownBoard.hits.add(key);
          SND.hit();
        } else {
          ownBoard.misses.add(key);
          SND.miss();
        }

        // Eignes Schiff versenkt: umliegendes Wasser aufdecken 
        if (hit && sunk && ownBoard) {
          for (const pos of sunk.coords) ownBoard.hits.add(`${pos}`);
          if (sunk.around && sunk.around.length > 0) {
            sunk.around.forEach((pos) => {
              if (!ownBoard.hits.has(pos) && !ownBoard.misses.has(pos)) {
                ownBoard.misses.add(pos);
              }
            });
          }
          paintShots(DOM.own, ownBoard, true);
          SND.sink();
        }
      }

      // Zug-Status aktualisieren
      Online.myTurn = nextIsMe;
      if (Online.role === "spectator") {
      const t = Online.currentTurnId;
      if (t != null) setStatus(`${getPlayerNameById(t)} ist dran …`);
    } else {
      setStatus(Online.myTurn ? "Du bist dran!" : "Gegner ist dran …");
    }
    });

    // Multiplayer: Spielende 
    MP.on("gameOver", ({ youWin, spectator, winner, reveal }) => {
      if (Online.role === "spectator" || spectator) {
        setStatus(T("game_over_winner", { winner }));
        enableEnemyShooting(false);
        return;
      }
      setStatus(youWin ? T("you_won") : T("you_lost"));
      const end = document.getElementById("endOverlay");
      const endText = document.getElementById("endText");
      if (end && endText) {
        endText.textContent = youWin
          ? T("end_win_text")
          : T("end_lose_text");
        applyRevealBoards(reveal);
        showEndBoardsEnhanced();
        end.classList.add("show");
      }
      SND.win();
      enableEnemyShooting(false);

      // Neustart Button 
      const againBtn = document.getElementById("btnPlayAgain");
      if (againBtn) {
        againBtn.onclick = () => {
          try {
            MP.state.ws?.close();
          } catch {}
          requestReturnToSetup();
        };
      }
    });

    MP.on("opponentLeft", () => {
      setStatus(T("opponent_left"));
      enableEnemyShooting(false);
    });

    // Multiplayer:Zug Update
    MP.on("turnUpdate", ({ current }) => {
      Online.currentTurnId = current;
      Online.myTurn = current === Online.myId;

      if (Online.role === "spectator") {
        setStatus(`${getPlayerNameById(current)} ist dran …`);
      } else {
        if (Online.role === "spectator") {
      const t = Online.currentTurnId;
      if (t != null) setStatus(`${getPlayerNameById(t)} ist dran …`);
    } else {
      setStatus(Online.myTurn ? "Du bist dran!" : "Gegner ist dran …");
    }
      }
    });
  }

  function switchToGame() {
    qsa(".screen").forEach((s) => s.classList.remove("active"));
    DOM.screens.game.classList.add("active");
    showGameBar(true);
    updateGameBar();
    enterPlacement({ resetBoards: true, forIndex: 0 });
  }

  DOM.btnMenu && (DOM.btnMenu.onclick = () => location.reload());

  // HUD-Buttons initialisieren
  const __titleHome = document.querySelector('.hud .title');
  if (__titleHome) {
    __titleHome.classList.add('mp-title-home');
    __titleHome.style.cursor = 'pointer';
    __titleHome.addEventListener('click', () => location.reload());
  }

  DOM.btnRestart && (DOM.btnRestart.onclick = () => location.reload());
  DOM.btnSound &&
    (DOM.btnSound.onclick = () => {
      State.soundOn = !State.soundOn;
      DOM.btnSound.textContent = State.soundOn ? "🔊" : "🔈";
      updateGameBar();
    });

 
  // Menü-Flow Steuerung
  const MenuFlow = {
    screen: "mainMenu", 
    localMode: "ai",
    mpMode: "create", 
  };

  function setMenuSection(id) {
    const menu = document.getElementById("menu");
    if (!menu) return;

    // Spiel-Balken weg sobald im Menü
    showGameBar(false);

    const sections = qsa("#menu .menu-section");
    sections.forEach((s) => {
      s.hidden = true;
    });

    const active = document.getElementById(id);
    if (active) active.hidden = false;

    MenuFlow.screen = id;
    clearMenuError();
  }

  function configureLocalSetupFor(mode) {
    MenuFlow.localMode = mode;

    const title = document.getElementById("localSetupTitle");
    const p2Field = document.getElementById("p2Field");
    const aiDiff = document.getElementById("aiDifficulty");

    if (mode === "ai") {
      if (title) title.textContent = T("local_vs_ai");
      if (p2Field) p2Field.style.display = "none";
      if (aiDiff) aiDiff.style.display = "flex";
    } else {
      if (title) title.textContent = T("local_2p");
      if (p2Field) p2Field.style.display = "";
      if (aiDiff) aiDiff.style.display = "none";
    }
  }

  function configureMpSetupFor(mode) {
    MenuFlow.mpMode = mode;

    const title = document.getElementById("mpSetupTitle");
    const hintCreate = document.getElementById("mpHintCreate");
    const btnCreate = document.getElementById("btnCreateRoom");
    const btnJoin = document.getElementById("btnJoinRoom");

    if (mode === "create") {
      if (title) title.textContent = T("mp_create");
      if (hintCreate) hintCreate.style.display = "";
      if (btnCreate) btnCreate.style.display = "";
      if (btnJoin) btnJoin.style.display = "none";
    } else {
      if (title) title.textContent = T("mp_join");
      if (hintCreate) hintCreate.style.display = "none";
      if (btnCreate) btnCreate.style.display = "none";
      if (btnJoin) btnJoin.style.display = "";
    }
  }

  // Start-Menü Buttons
  document.getElementById("btnChooseLocal")?.addEventListener("click", () => {
    setMenuSection("localChoice");
  });
  document.getElementById("btnChooseMP")?.addEventListener("click", () => {
    setMenuSection("mpChoice");
  });
  document.getElementById("btnChooseSpectate")?.addEventListener("click", () => {
    setMenuSection("spectateSetup");
  });

 // Menü Lokales Spiel Buttons
  document
    .getElementById("btnBackFromLocalChoice")
    ?.addEventListener("click", () => {
      setMenuSection("mainMenu");
    });

  document
    .getElementById("btnLocalChooseAI")
    ?.addEventListener("click", () => {
      configureLocalSetupFor("ai");
      setMenuSection("localSetup");
    });

  document
    .getElementById("btnLocalChoose2P")
    ?.addEventListener("click", () => {
      configureLocalSetupFor("local");
      setMenuSection("localSetup");
    });

  // zurück-Button
  document.getElementById("btnBackFromLocal")?.addEventListener("click", () => {
    setMenuSection("localChoice");
  });

  // Lokalesspiel Start Button
  document.getElementById("btnLocalStart")?.addEventListener("click", () => {
    if (MenuFlow.localMode === "local") startLocalGame();
    else startVsAI();
  });

  // MMenü Multiplayer Spiel Buttons
  document.getElementById("btnBackFromSpectate")?.addEventListener("click", () => {
    setMenuSection("mainMenu");
  });

  document
    .getElementById("btnBackFromMpChoice")
    ?.addEventListener("click", () => {
      setMenuSection("mainMenu");
    });

  document
    .getElementById("btnMpChooseCreate")
    ?.addEventListener("click", () => {
      configureMpSetupFor("create");
      setMenuSection("mpSetup");
    });

  document
    .getElementById("btnMpChooseJoin")
    ?.addEventListener("click", () => {
      configureMpSetupFor("join");
      setMenuSection("mpSetup");
    });

  // zurück-Button
  document.getElementById("btnBackFromMP")?.addEventListener("click", () => {
    setMenuSection("mpChoice");
  });

  // Initialisieren
  qsa(".screen").forEach((s) => s.classList.remove("active"));
  DOM.screens.menu.classList.add("active");
  setMenuSection("mainMenu");
  configureLocalSetupFor("ai");
  configureMpSetupFor("create");

  // letzten Raumcode wiederherstellen
  const last = readLastOnline();
  if (last && last.room) {
    Online.roomCode = String(last.room).toUpperCase();
    const roomEl = document.getElementById("roomCode");
    if (roomEl && !roomEl.value) roomEl.value = Online.roomCode;
  }

  // Stellt Menü und Eingaben nach "Nochmal spielen" automatisch wieder her
  try {
    if (sessionStorage.getItem(REPLAY_RETURN_KEY) === "1") {
      sessionStorage.removeItem(REPLAY_RETURN_KEY);
      const ctx = readReplayCtx();
      if (ctx && ctx.kind) {
        if (ctx.kind === "local") {
          if (typeof ctx.nameP1 === "string") DOM.nameP1.value = ctx.nameP1;
          if (typeof ctx.nameP2 === "string") DOM.nameP2.value = ctx.nameP2;
          if (ctx.aiMode) {
            const r = document.querySelector(`input[name="ai"][value="${ctx.aiMode}"]`);
            if (r) r.checked = true;
          }
          configureLocalSetupFor(ctx.localMode === "local" ? "local" : "ai");
          setMenuSection("localSetup");
        } else if (ctx.kind === "mp") {
          const nm = document.getElementById("nameOnline");
          const rc = document.getElementById("roomCode");
          if (nm && typeof ctx.nameOnline === "string") nm.value = ctx.nameOnline;
          if (rc && typeof ctx.roomCode === "string") rc.value = ctx.roomCode;
          configureMpSetupFor(ctx.mpMode === "join" ? "join" : "create");
          setMenuSection("mpSetup");
        } else if (ctx.kind === "spectate") {
          const rc = document.getElementById("roomCodeSpectate");
          if (rc && typeof ctx.roomCodeSpectate === "string") rc.value = ctx.roomCodeSpectate;
          setMenuSection("spectateSetup");
        }
      }
    }
  } catch {}
})();

// Tutorial
function hideHowto(){const h=document.getElementById('howto');if(h)h.style.display='none';}
DOM && DOM.btnStart && DOM.btnStart.addEventListener('click', hideHowto);
