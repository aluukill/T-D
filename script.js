const SUPABASE_URL = "https://muihugecdnxvakmuznpb.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im11aWh1Z2VjZG54dmFrbXV6bnBiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjM2NDUzMCwiZXhwIjoyMDk3OTQwNTMwfQ.MyXyerOXorzYc3MTEArQoW5SqdipZjlGyRJHB_zkWOA";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: { params: { eventsPerSecond: 5 } },
});

const AVATAR_COLORS = [
  "#ffd23f",
  "#ff3d8b",
  "#3df5ff",
  "#7cff6b",
  "#c58aff",
  "#ff9f43",
];

const state = {
  playerId: null,
  playerName: null,
  roomId: null,
  roomCode: null,
  isHost: false,
  players: [],
  channel: null,
  game: null,
  myVote: null,
  timerInterval: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function showScreen(name) {
  $$(".screen").forEach((s) => s.classList.remove("active"));
  $(`.screen-${name}`).classList.add("active");
}

function toast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  $("#toast-container").appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function showModal(title, body, actions = []) {
  $("#modal-title").textContent = title;
  $("#modal-body").textContent = body;
  const actionsEl = $("#modal-actions");
  actionsEl.innerHTML = "";
  actions.forEach((a) => {
    const btn = document.createElement("button");
    btn.className = `btn ${a.primary ? "btn-primary" : "btn-ghost"}`;
    btn.innerHTML = `<span>${a.label}</span>`;
    btn.onclick = () => {
      $("#modal").classList.add("hidden");
      if (a.onClick) a.onClick();
    };
    actionsEl.appendChild(btn);
  });
  $("#modal").classList.remove("hidden");
}

function genCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function genId() {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

function persistIdentity() {
  if (!state.playerId) {
    state.playerId = localStorage.getItem("sd_pid") || genId();
    localStorage.setItem("sd_pid", state.playerId);
  }
}

function loadIdentity() {
  state.playerName = localStorage.getItem("sd_name") || "";
  persistIdentity();
}

function saveIdentity() {
  if (state.playerName) localStorage.setItem("sd_name", state.playerName);
}

async function createRoom() {
  const name = $("#player-name").value.trim();
  if (!name) {
    toast("Enter a nickname first", "error");
    return;
  }
  state.playerName = name.slice(0, 14);
  saveIdentity();
  persistIdentity();

  const code = genCode();
  const { data: room, error } = await sb
    .from("rooms")
    .insert({
      code,
      host_id: state.playerId,
      state: "lobby",
      players: [{ id: state.playerId, name: state.playerName, isHost: true }],
    })
    .select()
    .single();

  if (error || !room) {
    toast("Could not create room", "error");
    return;
  }

  state.roomId = room.id;
  state.roomCode = room.code;
  state.isHost = true;
  state.players = room.players;

  subscribeRoom();
  enterLobby();
}

async function joinRoom() {
  const name = $("#player-name").value.trim();
  const code = $("#room-code-input").value.trim().toUpperCase();
  if (!name) {
    toast("Enter a nickname first", "error");
    return;
  }
  if (!code || code.length < 4) {
    toast("Enter a valid room code", "error");
    return;
  }

  state.playerName = name.slice(0, 14);
  saveIdentity();
  persistIdentity();

  const { data: room, error } = await sb
    .from("rooms")
    .select("*")
    .eq("code", code)
    .eq("state", "lobby")
    .maybeSingle();

  if (error || !room) {
    toast("Room not found or already started", "error");
    return;
  }

  const players = room.players || [];
  if (players.some((p) => p.id === state.playerId)) {
    toast("You are already in this room", "error");
    return;
  }
  if (players.length >= 8) {
    toast("Room is full", "error");
    return;
  }

  players.push({ id: state.playerId, name: state.playerName, isHost: false });
  const { error: updErr } = await sb
    .from("rooms")
    .update({ players })
    .eq("id", room.id);
  if (updErr) {
    toast("Could not join room", "error");
    return;
  }

  state.roomId = room.id;
  state.roomCode = room.code;
  state.isHost = false;
  state.players = players;

  subscribeRoom();
  enterLobby();
  broadcast("player:join", { id: state.playerId, name: state.playerName });
}

function subscribeRoom() {
  if (state.channel) sb.removeChannel(state.channel);
  state.channel = sb
    .channel(`room:${state.roomId}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "rooms",
        filter: `id=eq.${state.roomId}`,
      },
      handleRoomUpdate,
    )
    .on("broadcast", { event: "player:join" }, handlePlayerJoin)
    .on("broadcast", { event: "player:leave" }, handlePlayerLeave)
    .on("broadcast", { event: "game:start" }, handleGameStart)
    .on("broadcast", { event: "game:phase" }, handleGamePhase)
    .on("broadcast", { event: "game:choice" }, handleGameChoice)
    .on("broadcast", { event: "challenge:submit" }, handleChallengeSubmit)
    .on("broadcast", { event: "vote:cast" }, handleVoteCast)
    .subscribe();
}

function broadcast(event, payload = {}) {
  if (!state.channel) return;
  state.channel.send({ type: "broadcast", event, payload });
}

async function handleRoomUpdate(payload) {
  const room = payload.new;
  if (!room) return;
  state.players = room.players || state.players;
  if (room.state === "playing" && !state.game) {
    await loadGameState();
  }
  renderLobby();
}

function handlePlayerJoin({ payload }) {
  if (payload.id === state.playerId) return;
  if (state.players.some((p) => p.id === payload.id)) return;
  state.players.push({ id: payload.id, name: payload.name, isHost: false });
  toast(`${payload.name} joined`, "success");
  renderLobby();
}

function handlePlayerLeave({ payload }) {
  state.players = state.players.filter((p) => p.id !== payload.id);
  toast(`${payload.name || "Player"} left`);
  renderLobby();
  if (state.players.length < 2 && state.game) {
    endGameEarly("Not enough players to continue");
  }
}

function renderLobby() {
  $("#room-code-display").textContent = state.roomCode;
  const grid = $("#player-grid");
  grid.innerHTML = "";
  state.players.forEach((p) => {
    const tile = document.createElement("div");
    tile.className =
      "player-tile" +
      (p.isHost ? " host" : "") +
      (p.id === state.playerId ? " me" : "");
    const initial = (p.name || "?").charAt(0).toUpperCase();
    tile.innerHTML = `
      <div class="player-avatar">${initial}</div>
      <div class="player-name">${escapeHtml(p.name)}</div>
    `;
    grid.appendChild(tile);
  });
  const canStart = state.isHost && state.players.length >= 2;
  $("#btn-start-game").disabled = !canStart;
}

function enterLobby() {
  showScreen("lobby");
  renderLobby();
}

async function loadGameState() {
  const { data } = await sb
    .from("rooms")
    .select("game_state")
    .eq("id", state.roomId)
    .maybeSingle();
  if (data && data.game_state) {
    state.game = data.game_state;
    applyPhase(state.game.phase);
  }
}

async function startGame() {
  if (!state.isHost) return;
  state.game = {
    round: 1,
    phase: "intro",
    chosenId: null,
    choiceType: null,
    challenges: [],
    votes: {},
    history: [],
  };
  await saveGameState();
  broadcast("game:start", { game: state.game });
  applyPhase("intro");
}

async function saveGameState() {
  await sb
    .from("rooms")
    .update({ game_state: state.game, state: "playing" })
    .eq("id", state.roomId);
}

function handleGameStart({ payload }) {
  state.game = payload.game;
  applyPhase(state.game.phase);
}

function applyPhase(phase) {
  if (!state.game) return;
  state.game.phase = phase;
  $$(".game-stage > div").forEach((el) => el.classList.remove("active"));
  const target = $(`.phase-${phase}`);
  if (target) {
    target.classList.add("active");
    target.style.display = "block";
  }
  $$(".game-stage > div").forEach((el) => {
    if (el !== target) el.style.display = "none";
  });
  showScreen("game");

  if (phase === "intro") runIntro();
  else if (phase === "spin") runSpin();
  else if (phase === "choice") renderChoice();
  else if (phase === "submit") renderSubmit();
  else if (phase === "vote") renderVote();
  else if (phase === "reveal") renderReveal();
}

function runIntro() {
  setTimeout(() => {
    if (state.isHost) {
      const available = state.players.filter(
        (p) => !state.game.history.includes(p.id),
      );
      const pool = available.length ? available : state.players;
      const chosen = pool[Math.floor(Math.random() * pool.length)];
      state.game.chosenId = chosen.id;
      state.game.challenges = [];
      state.game.votes = {};
      saveGameState();
      broadcast("game:phase", { phase: "spin", chosenId: chosen.id });
    }
  }, 1800);
}

function handleGamePhase({ payload }) {
  if (payload.chosenId) state.game.chosenId = payload.chosenId;
  applyPhase(payload.phase);
}

function buildWheel() {
  const wheel = $("#wheel");
  wheel.innerHTML = "";
  const n = state.players.length;
  const seg = 360 / n;
  state.players.forEach((p, i) => {
    const color = AVATAR_COLORS[i % AVATAR_COLORS.length];
    const startAngle = i * seg;
    const segment = document.createElement("div");
    segment.className = "wheel-segment";
    segment.style.background = color;
    segment.style.transform = `rotate(${startAngle}deg)`;
    segment.style.clipPath = `polygon(50% 50%, 50% 0%, ${50 + 50 * Math.tan((seg * Math.PI) / 360)}% 0%, 100% 0%, 100% 100%, 50% 100%)`;
    const labelAngle = startAngle + seg / 2;
    const label = document.createElement("div");
    label.className = "wheel-label";
    label.textContent = p.name;
    label.style.transform = `rotate(${labelAngle}deg) translateY(-20px)`;
    label.style.transformOrigin = "50% 250%";
    segment.appendChild(label);
    wheel.appendChild(segment);
  });
  const center = document.createElement("div");
  center.className = "wheel-center";
  center.textContent = "SPIN";
  wheel.appendChild(center);
  wheel.style.transform = "rotate(0deg)";
}

function runSpin() {
  buildWheel();
  const n = state.players.length;
  const seg = 360 / n;
  const chosenIdx = state.players.findIndex(
    (p) => p.id === state.game.chosenId,
  );
  const targetAngle = 360 - (chosenIdx * seg + seg / 2);
  const spins = 5 + Math.floor(Math.random() * 3);
  const finalRotation = spins * 360 + targetAngle + (Math.random() * 10 - 5);
  requestAnimationFrame(() => {
    $("#wheel").style.transform = `rotate(${finalRotation}deg)`;
  });
  setTimeout(() => {
    if (state.isHost) {
      broadcast("game:phase", { phase: "choice" });
      applyPhase("choice");
    }
  }, 4700);
}

function renderChoice() {
  const chosen = state.players.find((p) => p.id === state.game.chosenId);
  if (!chosen) return;
  $("#chosen-name").textContent = chosen.name;
  const isChosen = state.playerId === state.game.chosenId;
  $$(".choice-buttons .btn").forEach((b) => (b.disabled = !isChosen));
  if (!isChosen) {
    $(".chosen-prompt").textContent = `Waiting for ${chosen.name} to choose...`;
  } else {
    $(".chosen-prompt").textContent = "Truth or Dare?";
  }
}

function handleGameChoice({ payload }) {
  state.game.choiceType = payload.type;
  if (state.players.length <= 2) {
    const other = state.players.find((p) => p.id !== state.game.chosenId);
    if (other && other.id === state.playerId) {
      state.game.challenges = [
        {
          id: genId(),
          authorId: other.id,
          authorName: other.name,
          text: payload.directChallenge,
          type: payload.type,
        },
      ];
      state.game.votes = { [other.id]: state.game.challenges[0].id };
      saveGameState();
      broadcast("game:phase", { phase: "reveal" });
      applyPhase("reveal");
    } else {
      applyPhase("reveal");
    }
  } else {
    applyPhase("submit");
  }
}

function handleChallengeSubmit({ payload }) {
  if (!payload || !payload.challenge || !state.game) return;
  const challenge = payload.challenge;
  if (state.game.challenges.some((c) => c.id === challenge.id)) return;
  state.game.challenges.push(challenge);
  if (challenge.authorId !== state.playerId) {
    toast(`${challenge.authorName} submitted`, "success");
  }
  renderSubmittedList();
}

function renderSubmit() {
  const chosen = state.players.find((p) => p.id === state.game.chosenId);
  const isChosen = state.playerId === state.game.chosenId;
  $("#submit-type").textContent = state.game.choiceType;
  $("#submit-target").textContent = chosen ? chosen.name : "???";
  $("#challenge-input").value = "";
  $("#char-count").textContent = "0";
  $("#challenge-input").disabled = isChosen;
  $("#btn-submit-challenge").disabled = isChosen;
  if (isChosen) {
    $("#challenge-input").placeholder = "You are the chosen one. Sit back.";
  } else {
    $("#challenge-input").placeholder = `Type your ${state.game.choiceType}...`;
  }
  renderSubmittedList();
}

function renderSubmittedList() {
  const list = $("#submitted-list");
  list.innerHTML = "";
  state.game.challenges.forEach((c) => {
    if (c.authorId === state.playerId) return;
    const chip = document.createElement("div");
    chip.className = "submitted-chip";
    chip.textContent = `${c.authorName} locked in`;
    list.appendChild(chip);
  });
  const othersCount = state.players.length - 1;
  const submitted = state.game.challenges.length;
  if (submitted >= othersCount && state.isHost) {
    setTimeout(() => {
      saveGameState();
      broadcast("game:phase", { phase: "vote" });
      applyPhase("vote");
    }, 600);
  }
}

function renderVote() {
  const chosen = state.players.find((p) => p.id === state.game.chosenId);
  $("#vote-target").textContent = chosen ? chosen.name : "???";
  const list = $("#vote-list");
  list.innerHTML = "";
  const voteCounts = {};
  Object.values(state.game.votes).forEach((cid) => {
    voteCounts[cid] = (voteCounts[cid] || 0) + 1;
  });
  const totalVoters = state.players.filter(
    (p) => p.id !== state.game.chosenId,
  ).length;
  state.game.challenges.forEach((c) => {
    const item = document.createElement("div");
    item.className = "vote-item";
    if (state.myVote === c.id) item.classList.add("voted");
    if (state.myVote) item.classList.add("disabled");
    const count = voteCounts[c.id] || 0;
    const pct = totalVoters > 0 ? (count / totalVoters) * 100 : 0;
    item.innerHTML = `
      <div class="vote-fill" style="width:${pct}%"></div>
      <div class="vote-check">✓</div>
      <div class="vote-text">${escapeHtml(c.text)}</div>
      <div class="vote-author">${escapeHtml(c.authorName)}</div>
      <div class="vote-count">${count}</div>
    `;
    item.onclick = () => {
      if (state.myVote || state.playerId === state.game.chosenId) return;
      state.myVote = c.id;
      state.game.votes[state.playerId] = c.id;
      broadcast("vote:cast", { voterId: state.playerId, challengeId: c.id });
      renderVote();
    };
    list.appendChild(item);
  });
  startTimer(20, () => {
    if (state.isHost) finalizeRound();
  });
}

function handleVoteCast({ payload }) {
  state.game.votes[payload.voterId] = payload.challengeId;
  renderVote();
  const totalVoters = state.players.filter(
    (p) => p.id !== state.game.chosenId,
  ).length;
  if (Object.keys(state.game.votes).length >= totalVoters && state.isHost) {
    setTimeout(() => finalizeRound(), 800);
  }
}

function startTimer(seconds, onEnd) {
  clearInterval(state.timerInterval);
  let remaining = seconds;
  const bar = $("#timer-bar");
  const text = $("#timer-text");
  const update = () => {
    const pct = (remaining / seconds) * 100;
    bar.style.setProperty("--pct", pct + "%");
    text.textContent = remaining;
  };
  update();
  state.timerInterval = setInterval(() => {
    remaining--;
    update();
    if (remaining <= 0) {
      clearInterval(state.timerInterval);
      onEnd();
    }
  }, 1000);
}

function finalizeRound() {
  const voteCounts = {};
  Object.values(state.game.votes).forEach((cid) => {
    voteCounts[cid] = (voteCounts[cid] || 0) + 1;
  });
  let winnerId = null;
  let maxVotes = -1;
  state.game.challenges.forEach((c) => {
    const count = voteCounts[c.id] || 0;
    if (count > maxVotes) {
      maxVotes = count;
      winnerId = c.id;
    }
  });
  if (!winnerId && state.game.challenges.length)
    winnerId = state.game.challenges[0].id;
  state.game.winnerChallengeId = winnerId;
  saveGameState();
  broadcast("game:phase", { phase: "reveal" });
  applyPhase("reveal");
}

function renderReveal() {
  const chosen = state.players.find((p) => p.id === state.game.chosenId);
  const challenge =
    state.game.challenges.find((c) => c.id === state.game.winnerChallengeId) ||
    state.game.challenges[0];
  if (!challenge) return;
  $("#reveal-content").textContent = challenge.text;
  $("#reveal-author").textContent = challenge.authorName;
  $("#reveal-target").textContent = chosen ? chosen.name : "???";
}

function endRound() {
  if (!state.isHost) return;
  state.game.history.push(state.game.chosenId);
  state.game.round += 1;
  state.game.chosenId = null;
  state.game.choiceType = null;
  state.game.challenges = [];
  state.game.votes = {};
  state.game.winnerChallengeId = null;
  state.myVote = null;
  saveGameState();
  broadcast("game:phase", { phase: "intro" });
  applyPhase("intro");
}

function endGameEarly(reason) {
  clearInterval(state.timerInterval);
  showModal("Game Over", reason, [
    { label: "Back to Home", primary: true, onClick: leaveRoom },
  ]);
}

function escapeHtml(str) {
  return String(str || "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

async function leaveRoom() {
  if (state.channel) {
    broadcast("player:leave", { id: state.playerId, name: state.playerName });
    sb.removeChannel(state.channel);
    state.channel = null;
  }
  if (state.roomId) {
    const { data: room } = await sb
      .from("rooms")
      .select("players, host_id")
      .eq("id", state.roomId)
      .maybeSingle();
    if (room) {
      const players = (room.players || []).filter(
        (p) => p.id !== state.playerId,
      );
      let updates = { players };
      if (room.host_id === state.playerId && players.length > 0) {
        players[0].isHost = true;
        updates.host_id = players[0].id;
      }
      if (players.length === 0) {
        updates.state = "closed";
      }
      await sb.from("rooms").update(updates).eq("id", state.roomId);
    }
  }
  clearInterval(state.timerInterval);
  state.roomId = null;
  state.roomCode = null;
  state.players = [];
  state.game = null;
  state.myVote = null;
  state.isHost = false;
  showScreen("home");
}

$("#btn-create").onclick = createRoom;
$("#btn-show-join").onclick = () => {
  $("#join-panel").classList.toggle("hidden");
};
$("#btn-join").onclick = joinRoom;
$("#btn-start-game").onclick = startGame;
$("#btn-leave-lobby").onclick = () => {
  showModal("Leave room?", "You will exit this room and return home.", [
    { label: "Cancel" },
    { label: "Leave", primary: true, onClick: leaveRoom },
  ]);
};
$("#btn-leave-game").onclick = () => {
  showModal("Quit game?", "The game will end for everyone.", [
    { label: "Cancel" },
    { label: "Quit", primary: true, onClick: leaveRoom },
  ]);
};
$("#btn-copy-code").onclick = () => {
  const link = `${location.origin}${location.pathname}?room=${state.roomCode}`;
  navigator.clipboard
    .writeText(link)
    .then(() => toast("Link copied", "success"));
};

$$(".choice-buttons .btn").forEach((btn) => {
  btn.onclick = () => {
    const type = btn.dataset.choice;
    state.game.choiceType = type;
    if (state.players.length <= 2) {
      const other = state.players.find((p) => p.id !== state.game.chosenId);
      showModal(`Enter a ${type}`, `Write a ${type} for your opponent.`, []);
      const modalBody = $("#modal-body");
      modalBody.innerHTML = `<textarea id="direct-challenge" maxlength="140" placeholder="Type your ${type}..." style="width:100%;min-height:90px;background:var(--bg-2);border:2px solid var(--border);border-radius:var(--radius-sm);padding:12px;color:var(--ink);font-family:inherit;font-size:15px;"></textarea>`;
      const actions = $("#modal-actions");
      actions.innerHTML = "";
      const submit = document.createElement("button");
      submit.className = "btn btn-primary";
      submit.innerHTML = "<span>Send</span>";
      submit.onclick = () => {
        const text = $("#direct-challenge").value.trim();
        if (!text) return;
        $("#modal").classList.add("hidden");
        broadcast("game:choice", { type, directChallenge: text });
        if (state.isHost) {
          state.game.challenges = [
            {
              id: genId(),
              authorId: other.id,
              authorName: other.name,
              text,
              type,
            },
          ];
          state.game.votes = { [other.id]: state.game.challenges[0].id };
          saveGameState();
          broadcast("game:phase", { phase: "reveal" });
          applyPhase("reveal");
        }
      };
      actions.appendChild(submit);
    } else {
      broadcast("game:choice", { type });
      if (state.isHost) {
        saveGameState();
        broadcast("game:phase", { phase: "submit" });
        applyPhase("submit");
      }
    }
  };
});

$("#challenge-input").oninput = (e) => {
  $("#char-count").textContent = e.target.value.length;
};

$("#btn-submit-challenge").onclick = () => {
  const text = $("#challenge-input").value.trim();
  if (!text) {
    toast("Write something first", "error");
    return;
  }
  if (state.game.challenges.some((c) => c.authorId === state.playerId)) {
    toast("You already submitted", "error");
    return;
  }
  const challenge = {
    id: genId(),
    authorId: state.playerId,
    authorName: state.playerName,
    text,
    type: state.game.choiceType,
  };
  state.game.challenges.push(challenge);
  broadcast("challenge:submit", { challenge });
  $("#challenge-input").disabled = true;
  $("#btn-submit-challenge").disabled = true;
  $("#challenge-input").value = "";
  renderSubmittedList();
};

$("#btn-done-challenge").onclick = () => {
  if (state.isHost) endRound();
  else toast("Waiting for host...");
};

window.addEventListener("beforeunload", () => {
  if (state.channel) {
    navigator.sendBeacon && leaveRoom();
  }
});

const params = new URLSearchParams(location.search);
const roomParam = params.get("room");

loadIdentity();
if (state.playerName) $("#player-name").value = state.playerName;
if (roomParam) {
  $("#room-code-input").value = roomParam.toUpperCase();
  $("#join-panel").classList.remove("hidden");
}

window.addEventListener("beforeunload", () => {
  if (state.channel) {
    broadcast("player:leave", { id: state.playerId, name: state.playerName });
  }
});
