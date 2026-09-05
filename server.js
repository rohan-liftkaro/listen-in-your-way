const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// ---- In-memory room store -------------------------------------------------
// rooms: Map<roomId, Room>
// Room = {
//   hostId, freeForAll, participants: Map<clientId, {name, isController, disconnectTimer}>,
//   queue: [{videoId, title, addedBy}], currentIndex,
//   isPlaying, playbackTime (seconds at lastUpdate), lastUpdate (ms epoch)
// }
// Participants are keyed by a persistent per-browser clientId (not socket.id) so
// that refreshing the page reconnects with a new socket but keeps the same identity.
const rooms = new Map();
const DISCONNECT_GRACE_MS = 20000;

function makeRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let id;
  do {
    id = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(id));
  return id;
}

function currentTime(room) {
  if (!room.isPlaying) return room.playbackTime;
  return room.playbackTime + (Date.now() - room.lastUpdate) / 1000;
}

function canControl(room, clientId) {
  if (!room) return false;
  if (room.hostId === clientId) return true;
  if (room.freeForAll) return true;
  const p = room.participants.get(clientId);
  return !!(p && p.isController);
}

function upsertParticipant(room, clientId, name) {
  const existing = room.participants.get(clientId);
  if (existing) {
    if (name) existing.name = name;
    clearTimeout(existing.disconnectTimer);
    existing.disconnectTimer = null;
    return existing;
  }
  const p = { name: name || "Guest", isController: false, disconnectTimer: null };
  room.participants.set(clientId, p);
  return p;
}

function publicState(room) {
  return {
    hostId: room.hostId,
    freeForAll: room.freeForAll,
    participants: [...room.participants.entries()].map(([id, p]) => ({
      id,
      name: p.name,
      isHost: id === room.hostId,
      isController: p.isController,
    })),
    queue: room.queue,
    currentIndex: room.currentIndex,
    isPlaying: room.isPlaying,
    time: currentTime(room),
  };
}

function broadcastState(roomId) {
  const room = rooms.get(roomId);
  if (room) io.to(roomId).emit("room-update", publicState(room));
}

io.on("connection", (socket) => {
  socket.on("create-room", ({ name, clientId }, ack) => {
    if (!clientId) return ack({ ok: false, error: "Missing client id." });
    const roomId = makeRoomId();
    const room = {
      hostId: clientId,
      freeForAll: false,
      participants: new Map(),
      queue: [],
      currentIndex: -1,
      isPlaying: false,
      playbackTime: 0,
      lastUpdate: Date.now(),
    };
    upsertParticipant(room, clientId, name || "Host");
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.clientId = clientId;
    ack({ ok: true, roomId, state: publicState(room) });
  });

  socket.on("join-room", ({ roomId, name, clientId }, ack) => {
    if (!clientId) return ack({ ok: false, error: "Missing client id." });
    const room = rooms.get(roomId);
    if (!room) return ack({ ok: false, error: "That room code doesn't exist." });
    const isReturning = room.participants.has(clientId);
    upsertParticipant(room, clientId, name);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.clientId = clientId;
    ack({ ok: true, roomId, state: publicState(room) });
    if (room.currentIndex !== -1) {
      const song = room.queue[room.currentIndex];
      socket.emit("video-action", {
        action: "sync",
        videoId: song.videoId,
        time: currentTime(room),
        isPlaying: room.isPlaying,
      });
    }
    if (!isReturning) socket.to(roomId).emit("toast", `${name || "Guest"} joined the room`);
    broadcastState(roomId);
  });

  socket.on("add-song", ({ videoId, title }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const name = room.participants.get(socket.data.clientId)?.name || "Someone";
    room.queue.push({ videoId, title, addedBy: name });
    if (room.currentIndex === -1) {
      room.currentIndex = 0;
      room.isPlaying = true;
      room.playbackTime = 0;
      room.lastUpdate = Date.now();
      io.to(socket.data.roomId).emit("video-action", { action: "load", videoId, time: 0, isPlaying: true });
    }
    broadcastState(socket.data.roomId);
  });

  socket.on("remove-song", ({ index }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !canControl(room, socket.data.clientId)) return;
    if (index === room.currentIndex) return; // don't remove what's playing; use skip
    room.queue.splice(index, 1);
    if (index < room.currentIndex) room.currentIndex -= 1;
    broadcastState(socket.data.roomId);
  });

  function requirePermission(room) {
    return room && canControl(room, socket.data.clientId);
  }

  socket.on("play", () => {
    const room = rooms.get(socket.data.roomId);
    if (!requirePermission(room) || room.currentIndex === -1) return;
    room.isPlaying = true;
    room.lastUpdate = Date.now();
    io.to(socket.data.roomId).emit("video-action", { action: "play", time: currentTime(room) });
    broadcastState(socket.data.roomId);
  });

  socket.on("pause", () => {
    const room = rooms.get(socket.data.roomId);
    if (!requirePermission(room)) return;
    room.playbackTime = currentTime(room);
    room.isPlaying = false;
    room.lastUpdate = Date.now();
    io.to(socket.data.roomId).emit("video-action", { action: "pause", time: room.playbackTime });
    broadcastState(socket.data.roomId);
  });

  socket.on("seek", ({ time }) => {
    const room = rooms.get(socket.data.roomId);
    if (!requirePermission(room)) return;
    room.playbackTime = Math.max(0, time);
    room.lastUpdate = Date.now();
    io.to(socket.data.roomId).emit("video-action", { action: "seek", time: room.playbackTime, isPlaying: room.isPlaying });
    broadcastState(socket.data.roomId);
  });

  socket.on("skip", () => {
    const room = rooms.get(socket.data.roomId);
    if (!requirePermission(room)) return;
    if (room.currentIndex < room.queue.length - 1) {
      room.currentIndex += 1;
    } else {
      room.currentIndex = -1;
    }
    room.playbackTime = 0;
    room.isPlaying = room.currentIndex !== -1;
    room.lastUpdate = Date.now();
    const next = room.currentIndex !== -1 ? room.queue[room.currentIndex] : null;
    io.to(socket.data.roomId).emit("video-action", {
      action: next ? "load" : "empty",
      videoId: next?.videoId,
      time: 0,
      isPlaying: !!next,
    });
    broadcastState(socket.data.roomId);
  });

  socket.on("toggle-free-for-all", ({ enabled }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostId !== socket.data.clientId) return;
    room.freeForAll = !!enabled;
    broadcastState(socket.data.roomId);
  });

  socket.on("set-controller", ({ targetId, allowed }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostId !== socket.data.clientId) return;
    const p = room.participants.get(targetId);
    if (p) p.isController = !!allowed;
    broadcastState(socket.data.roomId);
  });

  socket.on("chat-message", ({ text }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !text?.trim()) return;
    const name = room.participants.get(socket.data.clientId)?.name || "Someone";
    io.to(socket.data.roomId).emit("chat-message", { name, text: text.trim().slice(0, 300), t: Date.now() });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const clientId = socket.data.clientId;
    const room = rooms.get(roomId);
    if (!room || !clientId) return;
    const p = room.participants.get(clientId);
    if (!p) return;
    // Give the client a grace period to reconnect (e.g. a page refresh) before
    // dropping them and, if needed, handing host duty to someone else.
    p.disconnectTimer = setTimeout(() => {
      room.participants.delete(clientId);
      if (room.participants.size === 0) {
        rooms.delete(roomId);
        return;
      }
      if (room.hostId === clientId) {
        room.hostId = room.participants.keys().next().value;
      }
      io.to(roomId).emit("toast", `${p.name} left the room`);
      broadcastState(roomId);
    }, DISCONNECT_GRACE_MS);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`VibeWatch running on http://localhost:${PORT}`));
