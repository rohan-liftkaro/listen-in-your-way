// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const socket = io();
const SESSION_KEY = "vibewatch-session";
const clientId = getClientId();
const myId = clientId;
let myName = "";
let latestState = null;
let ytPlayer = null;
let ytReady = false;
let applyingRemoteAction = false; // guards against feedback loops while we drive the player
let seekDragging = false;

const $ = (id) => document.getElementById(id);

function getClientId() {
  let id = localStorage.getItem("vibewatch-client-id");
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `c-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("vibewatch-client-id", id);
  }
  return id;
}

function saveSession(roomId, name) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ roomId, name }));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

// ---------------------------------------------------------------------------
// YouTube link parsing + oEmbed title lookup
// ---------------------------------------------------------------------------
function extractVideoId(url) {
  try {
    const u = new URL(url.trim());
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2];
    if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2];
    if (u.searchParams.get("v")) return u.searchParams.get("v");
  } catch (e) {
    return null;
  }
  return null;
}

async function fetchTitle(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );
    if (!res.ok) throw new Error("oembed failed");
    const data = await res.json();
    return data.title;
  } catch {
    return "YouTube video";
  }
}

// ---------------------------------------------------------------------------
// YouTube player
// ---------------------------------------------------------------------------
window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player("yt-player", {
    height: "100%",
    width: "100%",
    playerVars: { rel: 0, modestbranding: 1, playsinline: 1, controls: 0, disablekb: 1 },
    events: {
      onReady: () => {
        ytReady = true;
      },
    },
  });
};

function playerHasVideo() {
  return latestState && latestState.currentIndex !== -1 && latestState.queue[latestState.currentIndex];
}

function applyVideoAction(msg) {
  if (!ytReady) {
    // Retry shortly if the iframe API hasn't finished booting yet.
    setTimeout(() => applyVideoAction(msg), 250);
    return;
  }
  applyingRemoteAction = true;
  if (msg.action === "load") {
    ytPlayer.loadVideoById(msg.videoId, msg.time || 0);
    if (msg.isPlaying === false) ytPlayer.pauseVideo();
  } else if (msg.action === "play") {
    ytPlayer.seekTo(msg.time, true);
    ytPlayer.playVideo();
  } else if (msg.action === "pause") {
    ytPlayer.pauseVideo();
    ytPlayer.seekTo(msg.time, true);
  } else if (msg.action === "seek") {
    ytPlayer.seekTo(msg.time, true);
    if (msg.isPlaying) ytPlayer.playVideo();
    else ytPlayer.pauseVideo();
  } else if (msg.action === "sync") {
    ytPlayer.loadVideoById(msg.videoId, msg.time || 0);
    if (!msg.isPlaying) setTimeout(() => ytPlayer.pauseVideo(), 300);
  } else if (msg.action === "empty") {
    ytPlayer.stopVideo();
  }
  setTimeout(() => (applyingRemoteAction = false), 400);
}

// Local seek-bar + time readout, ticking off the actual player clock.
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

setInterval(() => {
  if (!ytReady || !ytPlayer || !ytPlayer.getCurrentTime || seekDragging) return;
  if (!playerHasVideo()) return;
  const cur = ytPlayer.getCurrentTime() || 0;
  const dur = ytPlayer.getDuration() || 0;
  $("time-current").textContent = fmtTime(cur);
  $("time-total").textContent = fmtTime(dur);
  $("seek-bar").max = dur || 100;
  $("seek-bar").value = cur;
}, 500);

// ---------------------------------------------------------------------------
// Landing screen
// ---------------------------------------------------------------------------
$("create-btn").addEventListener("click", () => {
  const name = $("name-input").value.trim();
  if (!name) return showLandingError("Enter a name first.");
  myName = name;
  socket.emit("create-room", { name, clientId }, (res) => {
    if (!res.ok) return showLandingError(res.error || "Could not create room.");
    enterRoom(res.roomId, res.state);
  });
});

$("join-btn").addEventListener("click", () => {
  const name = $("name-input").value.trim();
  const code = $("code-input").value.trim().toUpperCase();
  if (!name) return showLandingError("Enter a name first.");
  if (!code) return showLandingError("Enter the room code your friend sent you.");
  myName = name;
  socket.emit("join-room", { roomId: code, name, clientId }, (res) => {
    if (!res.ok) return showLandingError(res.error || "Could not join room.");
    enterRoom(res.roomId, res.state);
  });
});

function showLandingError(msg) {
  $("landing-error").textContent = msg;
}

// Pre-fill room code from an invite link like /?room=ABCDE, or silently
// rejoin the room we were in before a refresh using the saved session.
const params = new URLSearchParams(location.search);
const savedSession = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
if (savedSession && savedSession.roomId) {
  myName = savedSession.name || "";
  socket.emit("join-room", { roomId: savedSession.roomId, name: myName, clientId }, (res) => {
    if (res.ok) enterRoom(res.roomId, res.state);
    else clearSession();
  });
} else if (params.get("room")) {
  $("code-input").value = params.get("room").toUpperCase();
}

// ---------------------------------------------------------------------------
// Entering / rendering the room
// ---------------------------------------------------------------------------
function enterRoom(roomId, state) {
  $("landing").classList.add("hidden");
  $("room").classList.remove("hidden");
  $("room-code-btn").textContent = roomId;
  history.replaceState(null, "", `?room=${roomId}`);
  saveSession(roomId, myName);
  renderState(state);
}

$("room-code-btn").addEventListener("click", () => {
  navigator.clipboard.writeText(location.href).then(() => showToast("Invite link copied"));
});

$("leave-btn").addEventListener("click", () => {
  clearSession();
  location.reload();
});

function amController() {
  if (!latestState) return false;
  if (latestState.hostId === myId) return true;
  if (latestState.freeForAll) return true;
  const me = latestState.participants.find((p) => p.id === myId);
  return !!(me && me.isController);
}

function renderState(state) {
  latestState = state;
  const iAmHost = state.hostId === myId;
  const canControl = amController();

  // Header pill
  $("controller-pill").textContent = iAmHost
    ? "You're hosting"
    : canControl
    ? "You have control"
    : "Watching";

  // Player enable/disable
  ["play-btn", "skip-btn", "seek-bar"].forEach((id) => ($(id).disabled = !canControl));

  // Block interaction with the embedded YouTube player for anyone without control
  $("player-block").classList.toggle("hidden", canControl);

  // Empty state
  const hasVideo = state.currentIndex !== -1 && state.queue[state.currentIndex];
  $("empty-player").classList.toggle("hidden", !!hasVideo);

  // Play/pause icon
  $("play-icon").classList.toggle("hidden", state.isPlaying);
  $("pause-icon").classList.toggle("hidden", !state.isPlaying);

  // Queue
  const list = $("queue-list");
  list.innerHTML = "";
  state.queue.forEach((song, i) => {
    const li = document.createElement("li");
    if (i === state.currentIndex) li.classList.add("playing");
    li.innerHTML = `
      <span class="queue-index">${i + 1}</span>
      <span class="queue-title">${escapeHtml(song.title)}</span>
      <span class="queue-by">${escapeHtml(song.addedBy)}</span>
      ${i !== state.currentIndex && canControl ? `<button class="queue-remove" data-i="${i}" title="Remove">&times;</button>` : ""}
    `;
    list.appendChild(li);
  });
  list.querySelectorAll(".queue-remove").forEach((btn) => {
    btn.addEventListener("click", () => socket.emit("remove-song", { index: Number(btn.dataset.i) }));
  });
  if (state.queue.length === 0) {
    list.innerHTML = `<li class="muted" style="padding:0.4rem 0.8rem;">Nothing here yet — add the first track below.</li>`;
  }

  // People
  $("people-count").textContent = `(${state.participants.length})`;
  const peopleList = $("people-list");
  peopleList.innerHTML = "";
  state.participants.forEach((p) => {
    const li = document.createElement("li");
    const tag = p.isHost ? `<span class="tag">host</span>` : "";
    const grant =
      iAmHost && !p.isHost
        ? `<button class="grant-btn ${p.isController ? "active" : ""}" data-id="${p.id}">
             ${p.isController ? "Controlling" : "Give control"}
           </button>`
        : "";
    li.innerHTML = `<span class="avatar-dot"></span><span class="person-name">${escapeHtml(p.name)}${p.id === myId ? " (you)" : ""}</span>${tag}${grant}`;
    peopleList.appendChild(li);
  });
  peopleList.querySelectorAll(".grant-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const isActive = btn.classList.contains("active");
      socket.emit("set-controller", { targetId: btn.dataset.id, allowed: !isActive });
    });
  });

  // Free-for-all toggle (host only)
  $("ffa-row").classList.toggle("hidden", !iAmHost);
  $("ffa-checkbox").checked = state.freeForAll;
}

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("ffa-checkbox").addEventListener("change", (e) => {
  socket.emit("toggle-free-for-all", { enabled: e.target.checked });
});

// ---------------------------------------------------------------------------
// Player controls
// ---------------------------------------------------------------------------
$("play-btn").addEventListener("click", () => {
  if (!latestState) return;
  socket.emit(latestState.isPlaying ? "pause" : "play");
});
$("skip-btn").addEventListener("click", () => socket.emit("skip"));

$("seek-bar").addEventListener("mousedown", () => (seekDragging = true));
$("seek-bar").addEventListener("touchstart", () => (seekDragging = true));
$("seek-bar").addEventListener("change", (e) => {
  socket.emit("seek", { time: Number(e.target.value) });
  seekDragging = false;
});

// ---------------------------------------------------------------------------
// Add song
// ---------------------------------------------------------------------------
$("add-song-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("song-url-input");
  const videoId = extractVideoId(input.value);
  if (!videoId) {
    $("add-song-error").textContent = "That doesn't look like a valid YouTube link.";
    return;
  }
  $("add-song-error").textContent = "";
  const title = await fetchTitle(videoId);
  socket.emit("add-song", { videoId, title });
  input.value = "";
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chat-input");
  if (!input.value.trim()) return;
  socket.emit("chat-message", { text: input.value });
  input.value = "";
});

socket.on("chat-message", ({ name, text }) => {
  const log = $("chat-log");
  const div = document.createElement("div");
  div.className = "chat-msg";
  div.innerHTML = `<span class="chat-name">${escapeHtml(name)}</span>${escapeHtml(text)}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
});

// ---------------------------------------------------------------------------
// Toasts + socket-driven updates
// ---------------------------------------------------------------------------
let toastTimer = null;
function showToast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}
socket.on("toast", showToast);

socket.on("room-update", (state) => renderState(state));
socket.on("video-action", (msg) => applyVideoAction(msg));
