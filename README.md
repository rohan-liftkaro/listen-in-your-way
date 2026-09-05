# VibeWatch

Listen to YouTube together, in sync, with your friends — one person creates a room,
shares the code, and everyone hears the same track at the same second. Control can be
handed to anyone in the room.

## How it works

- **Node.js + Express** serves the frontend and holds room state in memory.
- **Socket.io** keeps everyone's player in sync (play/pause/seek/skip/queue) and
  powers the room chat.
- **Plain HTML/CSS/JS** on the frontend — no build step, no framework, so it's easy
  to read and tweak.
- The **YouTube IFrame Player API** actually plays the video in-browser (nothing is
  downloaded or re-hosted — this only orchestrates playback of the public video).

Rooms are ephemeral: they live in server memory and disappear once everyone leaves
(or the server restarts). That's intentional — no database, no accounts, nothing to
configure. If you later want rooms to survive a server restart, swap the in-memory
`Map` in `server.js` for Redis.

## Run it locally

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

1. Enter your name and click **Start a room** — you get a 5-letter room code.
2. Send the code (or just the URL — it's baked into the address bar) to a friend.
3. They enter their name and the code on the same page, and click **Join**.
4. Paste any YouTube link into the box under the player to start the queue.

## Sharing control

By default only the host can play/pause/seek/skip/manage the queue. Everyone else
just watches and listens. The host has two ways to open that up, both in the
**Listening now** panel:

- Click **Give control** next to a specific friend's name to hand them the aux.
- Check **Let anyone control playback** to make it a free-for-all.

If the host disconnects, the room automatically passes hosting to the next person
still in the room, so it never gets stuck.

## Deploying so friends who aren't on your network can join

Any host that runs a persistent Node process works — no serverless — because the
server keeps room state and a live Socket.io connection. Easiest options:

- **Render** or **Railway**: connect the repo, they auto-detect `npm start`, done.
- **Fly.io**: `fly launch` in this folder.
- A small VPS (DigitalOcean, EC2, etc.): `npm install && npm start`, put it behind
  Nginx or just open the port.

No environment variables are required. If your platform assigns a port, the server
already reads it from `process.env.PORT`.

## Project structure

```
vibewatch/
├── server.js           # room state, sync logic, Socket.io events
├── package.json
└── public/
    ├── index.html       # landing screen + room screen markup
    ├── style.css        # visual design
    └── app.js           # YouTube player wiring, socket events, UI rendering
```

## Notes / things you might want to extend

- No login system — names aren't unique or verified, which is fine for a casual
  room among friends but worth knowing.
- The queue only stores video ID + title (fetched via YouTube's public oEmbed
  endpoint) — no other metadata.
- Playback sync is timestamp-based (the server tracks an authoritative clock), so
  a new joiner's player jumps straight to the right second rather than starting
  from zero.
