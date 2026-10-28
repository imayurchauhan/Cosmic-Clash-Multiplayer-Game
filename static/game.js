(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const landing = $("#landing");
  const game = $("#game");
  const entryError = $("#entryError");
  const nameInput = $("#displayName");
  const roomInput = $("#roomCode");
  const canvas = $("#arena");
  const ctx = canvas.getContext("2d");
  const W = 1000;
  const H = 640;
  const keys = { up: false, down: false, left: false, right: false };
  let state = null;
  let socket = null;
  let code = "";
  let token = "";
  let ownId = null;
  let aim = { x: 650, y: 320 };
  let lastSentKeys = "";
  let reconnectTimer = null;
  let reconnecting = false;
  let leaving = false;
  let lastPhase = "";
  let fireHeld = false;
  let name = "";
  const stars = [];
  let seed = 1942;
  for (let i = 0; i < 74; i += 1) {
    seed = (seed * 9301 + 49297) % 233280;
    const x = seed / 233280 * W;
    seed = (seed * 9301 + 49297) % 233280;
    const y = seed / 233280 * H;
    seed = (seed * 9301 + 49297) % 233280;
    stars.push({ x, y, r: .4 + seed / 233280 * 1, a: .18 + seed / 233280 * .46, phase: seed / 233280 * 7 });
  }

  function setEntryError(message) { entryError.textContent = message || ""; }
  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[character]));
  }
  function setConnection(text, kind) {
    const el = $("#connectionStatus");
    el.className = "connection-status " + (kind || "");
    el.innerHTML = "<span></span><b>" + escapeHtml(text) + "</b>";
  }
  function request(url, data) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "Couldn't connect to that room.");
      return payload;
    });
  }
  function enterGame(roomCode, playerToken, pilotName) {
    code = roomCode;
    token = playerToken;
    name = pilotName || "Pilot";
    ownId = null;
    leaving = false;
    reconnecting = false;
    sessionStorage.setItem("cosmic:" + code + ":token", token);
    sessionStorage.setItem("cosmic:" + code + ":name", name);
    history.replaceState({}, "", "/?room=" + encodeURIComponent(code));
    $("#roomLabel").textContent = code;
    $("#inviteCode").textContent = code;
    $("#selfName").textContent = name;
    landing.hidden = true;
    game.hidden = false;
    setConnection("Connecting", "");
    connectSocket();
  }
  function connectSocket() {
    clearTimeout(reconnectTimer);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(protocol + "//" + location.host + "/ws/" + encodeURIComponent(code));
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ token: token }));
      setConnection("Joining arena", "");
    });
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch (error) { return; }
      if (message.type === "state") {
        state = message;
        ownId = message.you || ownId;
        renderState();
      } else if (message.type === "error") {
        $("#lobbyHint").textContent = message.message;
      } else if (message.type === "ping" && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "pong" }));
      }
    });
    socket.addEventListener("close", (event) => {
      if (leaving) return;
      if (event.code === 4401 || event.code === 4404) {
        setConnection("Room unavailable", "disconnected");
        $("#lobbyHint").textContent = event.code === 4404 ? "That room has closed." : "This pilot pass has expired.";
        return;
      }
      setConnection("Reconnecting", "disconnected");
      if (!reconnecting) {
        reconnecting = true;
        reconnectTimer = setTimeout(() => {
          reconnecting = false;
          if (!leaving && code && token) connectSocket();
        }, 1600);
      }
    });
    socket.addEventListener("error", () => setConnection("Connection issue", "disconnected"));
  }
  function send(type, extra) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(Object.assign({ type: type }, extra || {})));
      return true;
    }
    return false;
  }
  function selfPlayer() {
    return state && state.players ? state.players.find((player) => player.id === ownId) : null;
  }
  function joinPayloadName() {
    const value = nameInput.value.trim();
    return value.slice(0, 18) || "Pilot";
  }
  $("#createRoom").addEventListener("click", async () => {
    setEntryError("");
    nameInput.value = joinPayloadName();
    try {
      const result = await request("/api/rooms", { displayName: joinPayloadName() });
      enterGame(result.code, result.token, joinPayloadName());
    } catch (error) {
      setEntryError(error.message);
    }
  });
  async function joinByCode(value) {
    setEntryError("");
    const cleanCode = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (cleanCode.length !== 5) {
      setEntryError("Enter the five-character room code.");
      return;
    }
    roomInput.value = cleanCode;
    try {
      const result = await request("/api/rooms/" + encodeURIComponent(cleanCode) + "/join", { displayName: joinPayloadName() });
      enterGame(result.code, result.token, joinPayloadName());
    } catch (error) {
      setEntryError(error.message);
    }
  }
  $("#joinRoom").addEventListener("click", () => joinByCode(roomInput.value));
  roomInput.addEventListener("keydown", (event) => { if (event.key === "Enter") joinByCode(roomInput.value); });
  roomInput.addEventListener("input", () => { roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5); });
  nameInput.addEventListener("keydown", (event) => { if (event.key === "Enter") $("#createRoom").click(); });

  $("#copyCode").addEventListener("click", async () => {
    const invite = location.origin + "/?room=" + encodeURIComponent(code);
    const button = $("#copyCode");
    try {
      await navigator.clipboard.writeText(invite);
      button.innerHTML = "Invite copied <span>✓</span>";
      setTimeout(() => { button.innerHTML = "Copy invite <span>↗</span>"; }, 1800);
    } catch (error) {
      try { await navigator.clipboard.writeText(code); } catch (ignored) { }
      button.innerHTML = "Code " + escapeHtml(code) + " <span>✓</span>";
      setTimeout(() => { button.innerHTML = "Copy invite <span>↗</span>"; }, 1800);
    }
  });
  $("#readyButton").addEventListener("click", () => {
    const me = selfPlayer();
    if (!me) return;
    send("ready", { ready: !me.ready });
  });
  $("#startButton").addEventListener("click", () => send("start"));
  $("#rematchButton").addEventListener("click", () => send("rematch"));
  $("#returnLobbyButton").addEventListener("click", () => send("return_lobby"));
  $("#exitGame").addEventListener("click", () => {
    leaving = true;
    if (socket && socket.readyState === WebSocket.OPEN) send("leave");
    if (socket) socket.close();
    clearTimeout(reconnectTimer);
    if (code) {
      sessionStorage.removeItem("cosmic:" + code + ":token");
      sessionStorage.removeItem("cosmic:" + code + ":name");
    }
    state = null;
    code = "";
    token = "";
    ownId = null;
    game.hidden = true;
    landing.hidden = false;
    history.replaceState({}, "", "/");
    setConnection("Connecting", "");
  });

  const helpDialog = $("#helpDialog");
  function openHelp() { if (!helpDialog.open) helpDialog.showModal(); }
  $("#helpTop").addEventListener("click", openHelp);
  $("#openHelp").addEventListener("click", openHelp);
  $("#closeHelp").addEventListener("click", () => helpDialog.close());
  helpDialog.addEventListener("click", (event) => {
    if (event.target === helpDialog) helpDialog.close();
  });
  $("#homeLink").addEventListener("click", (event) => {
    if (!game.hidden) {
      event.preventDefault();
      $("#exitGame").click();
    }
  });

  function renderCrew() {
    if (!state) return;
    const players = state.players || [];
    $("#crewCount").textContent = players.length + "/8";
    $("#crewList").innerHTML = "";
    players.forEach((player) => {
      const entry = document.createElement("div");
      entry.className = "crew-slot";
      const label = player.id === ownId ? "YOU" : (player.host ? "HOST" : (player.ready ? "READY" : "PILOT"));
      const labelClass = player.host ? "host-tag" : (player.ready ? "ready-tag" : "");
      entry.innerHTML = '<span class="crew-avatar" style="--pilot-color:' + escapeHtml(player.color) + '">' + escapeHtml(player.name.slice(0, 1).toUpperCase()) + '</span>' +
        '<span class="crew-name-group"><span class="crew-player-name">' + escapeHtml(player.name) + (player.id === ownId ? ' <small>(you)</small>' : "") + '</span>' +
        '<span class="crew-player-tag ' + labelClass + '">' + label + '</span></span>' +
        '<span class="crew-state ' + (player.connected ? "online" : "offline") + '" title="' + (player.connected ? "Connected" : "Reconnecting") + '"></span>';
      $("#crewList").appendChild(entry);
    });
    for (let i = players.length; i < 8; i += 1) {
      const empty = document.createElement("div");
      empty.className = "crew-empty";
      empty.textContent = i === players.length ? "Invite a pilot to fill this seat…" : "Open pilot slot";
      $("#crewList").appendChild(empty);
    }
    const me = selfPlayer();
    const ready = $("#readyButton");
    ready.classList.toggle("is-ready", !!(me && me.ready));
    ready.innerHTML = me && me.ready ? "You're ready <span>✓</span>" : "Ready up <span>✓</span>";
    const isHost = !!(me && me.host);
    const start = $("#startButton");
    start.disabled = !isHost || players.filter((player) => player.connected).length < 2;
    start.innerHTML = !isHost ? "Waiting for host <b>→</b>" :
      (players.filter((player) => player.connected).length < 2 ? "Waiting for pilots <b>→</b>" : "Launch match <b>→</b>");
    $("#lobbyHint").textContent = !isHost ? "The host will launch when at least 2 pilots are connected." :
      (players.filter((player) => player.connected).length < 2 ? "Invite at least one more pilot to unlock launch." : "Crew assembled. Launch when everyone is ready.");
    setConnection("Connected", "connected");
  }
  function renderScoreboard() {
    const players = (state.players || []).slice().sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (a.kills !== b.kills) return b.kills - a.kills;
      return b.hp - a.hp;
    });
    $("#scoreList").innerHTML = "";
    players.forEach((player, index) => {
      const row = document.createElement("div");
      row.className = "score-row" + (player.alive ? "" : " out");
      row.innerHTML = '<span class="score-rank">' + String(index + 1).padStart(2, "0") + '</span>' +
        '<span class="score-dot" style="background:' + escapeHtml(player.color) + ';box-shadow:0 0 6px ' + escapeHtml(player.color) + '"></span>' +
        '<span class="score-name">' + escapeHtml(player.name) + (player.id === ownId ? '<small class="score-you">YOU</small>' : "") + '</span>' +
        '<span class="score-kills">' + (player.kills || 0) + ' <small>✦</small></span>';
      $("#scoreList").appendChild(row);
    });
  }
  function renderFeed() {
    const feed = state.feed || [];
    if (!feed.length) {
      $("#eventFeed").innerHTML = '<p class="feed-empty">The arena is quiet… for now.</p>';
      return;
    }
    $("#eventFeed").innerHTML = feed.slice(0, 5).map((item) => {
      const kind = ["hit", "elimination", "pickup"].includes(item.kind) ? item.kind : "";
      const seconds = Math.max(0, Math.floor(Date.now() / 1000 - item.at));
      return '<p class="' + kind + '"><span class="feed-time">' + (seconds < 60 ? seconds + "s" : "1m") + '</span>' + escapeHtml(item.message) + '</p>';
    }).join("");
  }
  function renderResults() {
    if (!state || state.phase !== "results") return;
    const winner = (state.players || []).find((player) => player.id === state.winnerId);
    $("#resultTitle").textContent = state.draw ? "It's a draw" : (winner ? winner.name + " wins!" : "Match complete");
    $("#resultSub").textContent = state.draw ? "Every pilot fell in the final orbit." : (winner ? "Last pilot standing." : "The arena has gone quiet.");
    $("#resultKicker").textContent = state.draw ? "NO SURVIVORS" : "LAST PILOT STANDING";
    const me = selfPlayer();
    const duration = Math.floor(state.elapsed || 0);
    const minutes = String(Math.floor(duration / 60)).padStart(2, "0");
    const seconds = String(duration % 60).padStart(2, "0");
    $("#resultStats").innerHTML =
      '<div class="result-stat"><strong>' + (me ? me.kills : 0) + '</strong><span>ELIMINATIONS</span></div>' +
      '<div class="result-stat"><strong>' + minutes + ":" + seconds + '</strong><span>SURVIVAL TIME</span></div>' +
      '<div class="result-stat"><strong>' + (me ? Math.round(me.damage) : 0) + '</strong><span>DAMAGE DEALT</span></div>';
    $("#finalRankings").innerHTML = (state.rankings || []).map((player, index) =>
      '<span class="result-rank-chip"><b>' + (index + 1) + '</b><i style="background:' + escapeHtml(player.color) + '"></i>' +
      escapeHtml(player.name) + '<small>' + (player.kills || 0) + ' KO</small></span>'
    ).join("");
    const isHost = !!(me && me.host);
    $("#rematchButton").hidden = !isHost;
    $("#returnLobbyButton").hidden = !isHost;
    if (isHost) $("#returnLobbyButton").textContent = "Return to lobby  ↗";
  }
  function renderState() {
    if (!state) return;
    $("#roomLabel").textContent = state.code;
    $("#inviteCode").textContent = state.code;
    const isLobby = state.phase === "lobby";
    $("#lobbyPanel").hidden = !isLobby;
    $("#arenaPanel").hidden = isLobby;
    if (state.phase !== lastPhase) {
      lastPhase = state.phase;
      $("#resultOverlay").hidden = state.phase !== "results";
      $("#countdownOverlay").hidden = state.phase !== "countdown";
    }
    if (state.phase === "lobby") renderCrew();
    if (state.phase === "countdown") {
      $("#countdownValue").textContent = Math.max(1, Math.ceil(state.countdown));
      $("#phaseLabel").textContent = "SYSTEMS CHECK";
      $("#arenaTitle").textContent = "Prepare for drop.";
    } else if (state.phase === "active") {
      $("#phaseLabel").textContent = state.elapsed < 18 ? "ARENA LIVE" : "ZONE CONTRACTING";
      $("#arenaTitle").textContent = state.elapsed < 18 ? "Stay in the orbit." : "The ring is closing.";
      $("#countdownOverlay").hidden = true;
      $("#resultOverlay").hidden = true;
    } else if (state.phase === "results") {
      $("#phaseLabel").textContent = "MATCH COMPLETE";
      $("#arenaTitle").textContent = "The orbit is quiet.";
      $("#countdownOverlay").hidden = true;
      $("#resultOverlay").hidden = false;
    }
    const seconds = Math.floor(state.elapsed || 0);
    $("#matchTimer").textContent = String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
    $("#aliveCount").textContent = state.remaining || 0;
    $("#safeStatus").textContent = state.zoneMessage || "Safe zone active";
    $("#zoneToast").hidden = state.phase !== "active" || state.elapsed < 18;
    const me = selfPlayer();
    if (me) {
      $("#selfName").textContent = me.name;
      $("#selfSwatch").style.background = me.color;
      $("#selfSwatch").style.boxShadow = "0 0 8px " + me.color;
      $("#healthText").textContent = Math.round(me.hp);
      $("#healthBar").style.width = Math.max(0, me.hp) + "%";
      $("#healthBar").style.background = me.hp < 30 ? "linear-gradient(90deg,#ff617e,#ff9b84)" : "linear-gradient(90deg,#62e9c1,#83ecb3)";
      $("#selfEliminated").hidden = me.alive;
      $("#selfStatusDot").style.background = me.alive ? "#74edb0" : "#ff748b";
      $("#attackCooldown").textContent = me.attackReadyIn > 0 ? me.attackReadyIn.toFixed(1) + "s" : "READY";
      $("#attackCooldown").classList.toggle("cooling", me.attackReadyIn > 0);
      $("#dashCooldown").textContent = me.dashReadyIn > 0 ? me.dashReadyIn.toFixed(1) + "s" : "READY";
      $("#dashCooldown").classList.toggle("cooling", me.dashReadyIn > 0);
      if (!ownId) ownId = me.id;
    }
    renderScoreboard();
    renderFeed();
    renderResults();
    setConnection("Connected", "connected");
  }

  function playerAtPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * W, y: (event.clientY - rect.top) / rect.height * H };
  }
  function fireAt(point) {
    if (!state || state.phase !== "active") return;
    const me = selfPlayer();
    if (!me || !me.alive) return;
    if (point) aim = point;
    else {
      const nearest = state.players.filter((player) => player.alive && player.id !== ownId)
        .sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0];
      aim = nearest ? { x: nearest.x, y: nearest.y } : { x: me.x + 100, y: me.y };
    }
    send("attack", { target: aim });
  }
  canvas.addEventListener("pointermove", (event) => { aim = playerAtPoint(event); });
  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button === 0) fireAt(playerAtPoint(event));
  });
  function setKey(key, pressed) {
    if (Object.prototype.hasOwnProperty.call(keys, key)) {
      keys[key] = pressed;
      const button = document.querySelector('[data-key="' + key + '"]');
      if (button) button.classList.toggle("pressed", pressed);
    }
  }
  function focusedInput() {
    const element = document.activeElement;
    return element && ["INPUT", "TEXTAREA"].includes(element.tagName);
  }
  window.addEventListener("keydown", (event) => {
    if (focusedInput()) return;
    const key = event.key.toLowerCase();
    const mapping = { w: "up", arrowup: "up", s: "down", arrowdown: "down", a: "left", arrowleft: "left", d: "right", arrowright: "right" };
    if (mapping[key]) { setKey(mapping[key], true); event.preventDefault(); }
    if (event.code === "Space") {
      event.preventDefault();
      if (!event.repeat) fireAt(null);
    }
    if (key === "shift" && !event.repeat) send("dash");
  });
  window.addEventListener("keyup", (event) => {
    const key = event.key.toLowerCase();
    const mapping = { w: "up", arrowup: "up", s: "down", arrowdown: "down", a: "left", arrowleft: "left", d: "right", arrowright: "right" };
    if (mapping[key]) setKey(mapping[key], false);
  });
  window.addEventListener("blur", () => {
    Object.keys(keys).forEach((key) => setKey(key, false));
    fireHeld = false;
  });
  document.querySelectorAll("[data-key]").forEach((button) => {
    const key = button.dataset.key;
    button.addEventListener("pointerdown", (event) => { event.preventDefault(); button.setPointerCapture(event.pointerId); setKey(key, true); });
    ["pointerup", "pointercancel", "lostpointercapture"].forEach((eventName) => button.addEventListener(eventName, () => setKey(key, false)));
  });
  $("#touchDash").addEventListener("pointerdown", (event) => { event.preventDefault(); send("dash"); });
  $("#touchAttack").addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (!fireHeld) fireAt(null);
    fireHeld = true;
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((eventName) => $("#touchAttack").addEventListener(eventName, () => { fireHeld = false; }));
  setInterval(() => {
    if (!state || state.phase !== "active") return;
    const keyState = JSON.stringify(keys);
    if (socket && socket.readyState === WebSocket.OPEN && (keyState !== lastSentKeys || Object.values(keys).some(Boolean))) {
      send("input", { keys: Object.assign({}, keys) });
      lastSentKeys = keyState;
    }
  }, 50);

  function draw() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(W * ratio);
    const height = Math.round(H * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const now = performance.now() / 1000;
    ctx.clearRect(0, 0, W, H);
    const background = ctx.createLinearGradient(0, 0, W, H);
    background.addColorStop(0, "#09111f");
    background.addColorStop(.58, "#0a1020");
    background.addColorStop(1, "#111025");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, W, H);
    const haze = ctx.createRadialGradient(360, 300, 40, 500, 320, 490);
    haze.addColorStop(0, "rgba(46,100,129,.11)");
    haze.addColorStop(.56, "rgba(72,62,126,.08)");
    haze.addColorStop(1, "rgba(4,7,16,0)");
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, W, H);
    stars.forEach((star) => {
      const pulse = .75 + Math.sin(now * .7 + star.phase) * .25;
      ctx.globalAlpha = star.a * pulse;
      ctx.fillStyle = "#cfdefe";
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    const cx = W / 2;
    const cy = H / 2;
    const edge = ctx.createRadialGradient(cx, cy, 120, cx, cy, 380);
    edge.addColorStop(0, "rgba(82,228,255,.035)");
    edge.addColorStop(.82, "rgba(82,228,255,.025)");
    edge.addColorStop(1, "rgba(82,228,255,0)");
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, 291, 0, Math.PI * 2);
    ctx.clip();
    ctx.strokeStyle = "rgba(121,164,207,.055)";
    ctx.lineWidth = 1;
    for (let x = 80; x < W; x += 42) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 15; y < H; y += 42) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.setLineDash([3, 8]);
    ctx.strokeStyle = "rgba(112,190,221,.34)";
    ctx.lineWidth = 1;
    ctx.shadowColor = "rgba(82,228,255,.5)";
    ctx.shadowBlur = 11;
    ctx.beginPath(); ctx.arc(cx, cy, 285, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    ctx.setLineDash([]);

    if (state && state.zone) {
      const zone = state.zone;
      const contracted = state.elapsed >= 18 && state.phase === "active";
      ctx.save();
      ctx.beginPath();
      ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
      ctx.fillStyle = contracted ? "rgba(99,229,204,.045)" : "rgba(82,228,255,.026)";
      ctx.fill();
      ctx.strokeStyle = contracted ? "rgba(102,235,213,.72)" : "rgba(82,228,255,.38)";
      ctx.lineWidth = contracted ? 2 : 1.5;
      ctx.shadowColor = contracted ? "#60e7ce" : "#52e4ff";
      ctx.shadowBlur = contracted ? 15 : 9;
      ctx.setLineDash(contracted ? [9, 6] : []);
      ctx.beginPath(); ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    if (state && state.obstacles) {
      state.obstacles.forEach((obstacle, index) => {
        const rock = ctx.createRadialGradient(obstacle.x - 8, obstacle.y - 9, 2, obstacle.x, obstacle.y, obstacle.r + 4);
        rock.addColorStop(0, index % 2 ? "#4d5b7d" : "#4b5876");
        rock.addColorStop(.75, "#28344e");
        rock.addColorStop(1, "#172238");
        ctx.fillStyle = rock;
        ctx.strokeStyle = "rgba(139,163,202,.35)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(obstacle.x, obstacle.y, obstacle.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = "rgba(159,179,211,.12)";
        ctx.beginPath();
        ctx.moveTo(obstacle.x - obstacle.r * .48, obstacle.y - 2);
        ctx.lineTo(obstacle.x + 1, obstacle.y - obstacle.r * .44);
        ctx.lineTo(obstacle.x + obstacle.r * .43, obstacle.y + obstacle.r * .28);
        ctx.stroke();
        ctx.fillStyle = "rgba(7,12,24,.24)";
        ctx.beginPath(); ctx.ellipse(obstacle.x + 4, obstacle.y + obstacle.r * .72, obstacle.r * .8, 4, 0, 0, Math.PI * 2); ctx.fill();
      });
    }
    if (state && state.pickups) {
      state.pickups.forEach((pickup, index) => {
        const pulse = 1 + Math.sin(now * 4 + index) * .12;
        ctx.save();
        ctx.shadowColor = "#68f4dc";
        ctx.shadowBlur = 17;
        ctx.fillStyle = "rgba(104,244,220,.15)";
        ctx.beginPath(); ctx.arc(pickup.x, pickup.y, 14 * pulse, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "rgba(126,255,229,.78)";
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(pickup.x, pickup.y, 8 * pulse, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = "#c8fff2";
        ctx.font = "bold 9px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("+", pickup.x, pickup.y);
        ctx.restore();
      });
    }
    if (state && state.projectiles) {
      state.projectiles.forEach((projectile) => {
        ctx.save();
        ctx.fillStyle = projectile.color;
        ctx.shadowColor = projectile.color;
        ctx.shadowBlur = 14;
        ctx.beginPath(); ctx.arc(projectile.x, projectile.y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = .45;
        ctx.beginPath(); ctx.arc(projectile.x, projectile.y, 9, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      });
    }
    if (state && state.players) {
      const ordered = state.players.slice().sort((a, b) => Number(a.id === ownId) - Number(b.id === ownId));
      ordered.forEach((player) => {
        if (!player.alive) {
          ctx.save();
          ctx.globalAlpha = .22;
          ctx.strokeStyle = player.color;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 4]);
          ctx.beginPath(); ctx.arc(player.x, player.y, 15, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
          return;
        }
        const own = player.id === ownId;
        ctx.save();
        ctx.globalAlpha = player.connected ? 1 : .55;
        ctx.shadowColor = player.color;
        ctx.shadowBlur = own ? 20 : 14;
        ctx.fillStyle = player.color;
        ctx.beginPath(); ctx.arc(player.x, player.y, own ? 12 : 10, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = own ? "#eaffff" : "#101629";
        ctx.beginPath(); ctx.arc(player.x, player.y, own ? 5 : 4, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = own ? "#ffffff" : "rgba(255,255,255,.72)";
        ctx.lineWidth = own ? 1.7 : 1;
        ctx.beginPath(); ctx.arc(player.x, player.y, own ? 15 : 12, 0, Math.PI * 2); ctx.stroke();
        if (own && state.phase === "active") {
          const angle = Math.atan2(aim.y - player.y, aim.x - player.x);
          ctx.globalAlpha = .6;
          ctx.strokeStyle = player.color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(player.x + Math.cos(angle) * 15, player.y + Math.sin(angle) * 15);
          ctx.lineTo(player.x + Math.cos(angle) * 30, player.y + Math.sin(angle) * 30);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.shadowBlur = 0;
        const barWidth = 30;
        ctx.fillStyle = "rgba(3,6,15,.86)";
        ctx.fillRect(player.x - barWidth / 2, player.y - 27, barWidth, 4);
        ctx.fillStyle = player.hp < 30 ? "#ff7389" : "#7be8c0";
        ctx.fillRect(player.x - barWidth / 2, player.y - 27, barWidth * Math.max(0, player.hp) / 100, 4);
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        ctx.font = own ? "600 9px sans-serif" : "500 8px sans-serif";
        ctx.fillStyle = own ? "#f1f7ff" : "#bac6dd";
        ctx.fillText(player.name + (own ? " · YOU" : ""), player.x, player.y + 29);
        ctx.restore();
      });
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  const params = new URLSearchParams(location.search);
  const inviteCode = (params.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
  if (inviteCode) {
    roomInput.value = inviteCode;
    const savedToken = sessionStorage.getItem("cosmic:" + inviteCode + ":token");
    const savedName = sessionStorage.getItem("cosmic:" + inviteCode + ":name");
    if (savedToken) enterGame(inviteCode, savedToken, savedName || "Pilot");
  }
})();
