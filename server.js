const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Meeting codes look like "abc-defg-hij"
const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

// Optional TURN server for users behind strict NATs/firewalls
app.get('/api/ice', (_req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    iceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER, credential: process.env.TURN_PASS });
  }
  res.json({ iceServers });
});

app.get('/new', (_req, res) => res.redirect(`/${generateCode()}`));
app.get('/:code', (req, res, next) => {
  if (!CODE_RE.test(req.params.code)) return next();
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

function generateCode() {
  const pick = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}

// roomId -> Map(socketId -> participant state)
const rooms = new Map();

io.on('connection', (socket) => {
  let roomId = null;

  socket.on('join', ({ room, name, audio, video }) => {
    if (!CODE_RE.test(room)) return;
    roomId = room;
    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const members = rooms.get(roomId);

    const me = {
      id: socket.id,
      name: String(name || 'Guest').slice(0, 40),
      audio: !!audio,
      video: !!video,
      screen: false,
      hand: false,
      recording: false,
      cc: false,
      host: members.size === 0,
    };

    // Tell the newcomer who is already here; the newcomer initiates offers.
    socket.emit('room-state', { you: me, peers: [...members.values()] });
    members.set(socket.id, me);
    socket.join(roomId);
    socket.to(roomId).emit('peer-joined', me);
  });

  // WebRTC signaling relay
  socket.on('signal', ({ to, data }) => {
    if (!roomId || !rooms.get(roomId)?.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // Media / hand / recording state updates
  socket.on('state', (patch) => {
    const me = rooms.get(roomId)?.get(socket.id);
    if (!me) return;
    const clean = {};
    for (const key of ['audio', 'video', 'screen', 'hand', 'recording', 'cc']) {
      if (patch && key in patch) me[key] = clean[key] = !!patch[key];
    }
    socket.to(roomId).emit('peer-state', { id: socket.id, ...clean });
  });

  socket.on('chat', (text) => {
    const me = rooms.get(roomId)?.get(socket.id);
    if (!me || typeof text !== 'string' || !text.trim()) return;
    io.to(roomId).emit('chat', { id: socket.id, name: me.name, text: text.slice(0, 2000), ts: Date.now() });
  });

  socket.on('reaction', (emoji) => {
    const me = rooms.get(roomId)?.get(socket.id);
    if (!me || typeof emoji !== 'string' || emoji.length > 8) return;
    io.to(roomId).emit('reaction', { id: socket.id, name: me.name, emoji });
  });

  socket.on('caption', ({ text, final }) => {
    const me = rooms.get(roomId)?.get(socket.id);
    if (!me || typeof text !== 'string') return;
    socket.to(roomId).emit('caption', { id: socket.id, name: me.name, text: text.slice(0, 500), final: !!final });
  });

  // Host controls
  socket.on('host-action', ({ action, target }) => {
    const members = rooms.get(roomId);
    const me = members?.get(socket.id);
    if (!me?.host || !members.has(target)) return;
    if (action === 'mute') io.to(target).emit('force-mute');
    if (action === 'remove') io.to(target).emit('removed');
  });

  socket.on('disconnect', () => {
    const members = rooms.get(roomId);
    if (!members) return;
    const wasHost = members.get(socket.id)?.host;
    members.delete(socket.id);
    socket.to(roomId).emit('peer-left', socket.id);
    if (members.size === 0) {
      rooms.delete(roomId);
    } else if (wasHost) {
      const next = members.values().next().value;
      next.host = true;
      io.to(roomId).emit('host-changed', next.id);
    }
  });
});

server.listen(PORT, () => console.log(`Meet app running at http://localhost:${PORT}`));
