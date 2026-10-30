/* global RealtimeRoom, MeetingRecorder */
const $ = (id) => document.getElementById(id);
const ROOM = (() => {
  const code = new URLSearchParams(location.search).get('m') || '';
  if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code)) return code;
  const pick = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  const fresh = `${pick(3)}-${pick(4)}-${pick(3)}`;
  history.replaceState(null, '', `?m=${fresh}`);
  return fresh;
})();
const COLORS = ['#1a73e8', '#188038', '#d93025', '#e37400', '#9334e6', '#c5221f', '#007b83', '#b06000', '#5f6368', '#185abc'];
const colorFor = (s) => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const initial = (s) => (s.trim()[0] || '?').toUpperCase();
const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
};

// ---------------------------------------------------------------- state
const state = {
  name: '',
  myId: null,
  host: false,
  audioOn: true,
  videoOn: true,
  screen: false,
  hand: false,
  cc: false,
  layout: 'auto', // auto | tiled | spotlight
  pinned: null,
  panel: null, // chat | people | info
  unread: 0,
};
let socket;
let micTrack = null;    // local microphone track
let camTrack = null;    // local camera track
let screenTrack = null; // local screen share track
const iceServers = window.HUDDLE_CONFIG.iceServers;
const peers = new Map(); // id -> { id, info, pc, stream, tile, queue }
let selfTile;
let recorder = null;
let audioCtx;
const analysers = new Map(); // id -> { analyser, data }
let activeSpeaker = null;

// ---------------------------------------------------------------- lobby
const preview = $('preview');
$('lobby-code').textContent = `Meeting code: ${ROOM}`;
$('code-label').textContent = ROOM;
$('name').value = localStorage.getItem('huddle-name') || '';

async function getMic(deviceId) {
  const s = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : { echoCancellation: true, noiseSuppression: true } });
  return s.getAudioTracks()[0];
}
async function getCam(deviceId) {
  const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } });
  return s.getVideoTracks()[0];
}

async function initLobby() {
  try { micTrack = await getMic(); } catch { state.audioOn = false; }
  try { camTrack = await getCam(); } catch { state.videoOn = false; }
  if (!micTrack && !camTrack) $('lobby-err').textContent = 'Camera and microphone are blocked or unavailable. You can still join to chat and watch.';
  refreshPreview();
  await fillDeviceLists();
  lobbyMeter();
}

function refreshPreview() {
  preview.srcObject = camTrack ? new MediaStream([camTrack]) : null;
  $('preview-off').classList.toggle('hidden', !!camTrack && state.videoOn);
  setRound($('lobby-mic'), state.audioOn, 'mic', 'mic_off');
  setRound($('lobby-cam'), state.videoOn, 'videocam', 'videocam_off');
}
function setRound(btn, on, onIcon, offIcon) {
  btn.classList.toggle('off', !on);
  btn.firstElementChild.textContent = on ? onIcon : offIcon;
}

async function fillDeviceLists() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const [sel, kind, track] of [[$('sel-mic'), 'audioinput', micTrack], [$('sel-cam'), 'videoinput', camTrack]]) {
    sel.innerHTML = '';
    devices.filter((d) => d.kind === kind).forEach((d, i) => {
      const o = new Option(d.label || `${kind === 'audioinput' ? 'Microphone' : 'Camera'} ${i + 1}`, d.deviceId);
      if (track?.getSettings().deviceId === d.deviceId) o.selected = true;
      sel.add(o);
    });
    if (!sel.options.length) sel.add(new Option('No device found', ''));
  }
}

$('sel-mic').onchange = async (e) => {
  const old = micTrack;
  try { micTrack = await getMic(e.target.value); micTrack.enabled = state.audioOn; old?.stop(); replaceTrack('audio', micTrack); watchSpeaking('self', new MediaStream([micTrack])); } catch {}
};
$('sel-cam').onchange = async (e) => {
  if (!state.videoOn) return;
  const old = camTrack;
  try { camTrack = await getCam(e.target.value); old?.stop(); refreshPreview(); if (!state.screen) { replaceTrack('video', camTrack); updateSelfVideo(); } } catch {}
};

$('lobby-mic').onclick = async () => {
  await toggleMic();
  refreshPreview();
};
$('lobby-cam').onclick = async () => {
  await toggleCam();
  refreshPreview();
};

let lobbyMeterTimer;
function lobbyMeter() {
  const bar = $('lobby-meter').firstElementChild;
  let an;
  lobbyMeterTimer = setInterval(() => {
    if (!micTrack || !state.audioOn) { bar.style.height = '0%'; return; }
    try {
      audioCtx = audioCtx || new AudioContext();
      if (!an || an.track !== micTrack) {
        const a = audioCtx.createAnalyser(); a.fftSize = 512;
        audioCtx.createMediaStreamSource(new MediaStream([micTrack])).connect(a);
        an = { a, track: micTrack, data: new Uint8Array(a.fftSize) };
      }
      bar.style.height = Math.min(100, level(an.a, an.data) * 400) + '%';
    } catch {}
  }, 100);
}

$('join-now').onclick = joinMeeting;
$('name').onkeydown = (e) => e.key === 'Enter' && joinMeeting();

// ---------------------------------------------------------------- joining
async function joinMeeting() {
  const name = $('name').value.trim();
  if (!name) { $('lobby-err').textContent = 'Please enter your name.'; $('name').focus(); return; }
  state.name = name;
  localStorage.setItem('huddle-name', name);
  clearInterval(lobbyMeterTimer);
  audioCtx = audioCtx || new AudioContext();
  audioCtx.resume();

  $('lobby').classList.add('hidden');
  $('meeting').classList.remove('hidden');

  selfTile = createTile('self', `${name} (You)`, true);
  updateSelfVideo();
  updateSelfTile();
  if (micTrack) watchSpeaking('self', new MediaStream([micTrack]));
  updateButtons();

  socket = new RealtimeRoom(ROOM, window.HUDDLE_CONFIG);
  socket.on('connect', () => {
    for (const id of [...peers.keys()]) removePeer(id); // fresh start after a reconnect
    socket.emit('join', { room: ROOM, name, audio: state.audioOn, video: state.videoOn });
  });
  socket.on('room-state', ({ you, peers: list }) => {
    state.myId = you.id;
    state.host = you.host;
    // Newcomer initiates a connection to everyone already in the room
    for (const info of list) createPeer(info, true);
    socket.emit('state', { screen: state.screen, hand: state.hand, cc: state.cc, recording: !!recorder });
    systemMessage(list.length ? `You joined. ${list.length} other${list.length > 1 ? 's' : ''} in the call.` : 'You’re the only one here. Share the link to invite others.');
    if (!list.length) openPanel('info');
    refreshUI();
  });
  socket.on('peer-joined', (info) => {
    createPeer(info, false);
    toast(`${info.name} joined`);
    systemMessage(`${info.name} joined`);
    refreshUI();
  });
  socket.on('peer-left', (id) => {
    const p = peers.get(id);
    if (!p) return;
    toast(`${p.info.name} left`);
    systemMessage(`${p.info.name} left`);
    removePeer(id);
  });
  socket.on('signal', ({ from, data }) => handleSignal(from, data));
  socket.on('peer-state', ({ id, ...patch }) => {
    const p = peers.get(id);
    if (!p) return;
    if (patch.hand && !p.info.hand) toast(`✋ ${p.info.name} raised a hand`);
    if ('recording' in patch && patch.recording !== p.info.recording) {
      toast(patch.recording ? `${p.info.name} started recording this meeting` : `${p.info.name} stopped recording`);
      systemMessage(patch.recording ? `${p.info.name} started recording` : `${p.info.name} stopped recording`);
    }
    if (patch.screen && !p.info.screen) toast(`${p.info.name} is presenting`);
    Object.assign(p.info, patch);
    updatePeerTile(p);
    refreshUI();
  });
  socket.on('chat', addChatMessage);
  socket.on('reaction', ({ name: n, emoji, id }) => floatReaction(emoji, id === state.myId ? 'You' : n));
  socket.on('caption', ({ id, name: n, text, final }) => showCaption(id, n, text, final));
  socket.on('force-mute', () => { if (state.audioOn) { toggleMic(); toast('The host muted you'); } });
  socket.on('removed', () => leave('You’ve been removed from the meeting'));
  socket.on('host-changed', (id) => {
    if (id === state.myId) { state.host = true; toast('You are now the host'); }
    else if (peers.get(id)) peers.get(id).info.host = true;
    renderPeople();
  });
  socket.on('disconnect', () => toast('Connection lost. Reconnecting…'));

  startClock();
  startSpeakingLoop();
  window.addEventListener('resize', layout);
}

// ---------------------------------------------------------------- WebRTC
function currentTrack(kind) {
  if (kind === 'audio') return micTrack;
  return screenTrack || (state.videoOn ? camTrack : null);
}

function createPeer(info, initiator) {
  const pc = new RTCPeerConnection({ iceServers });
  const peer = { id: info.id, info, pc, stream: new MediaStream(), queue: Promise.resolve() };
  peers.set(info.id, peer);
  peer.tile = createTile(info.id, info.name, false);
  updatePeerTile(peer);

  pc.onicecandidate = (e) => e.candidate && sendSignal(info.id, { candidate: e.candidate });
  pc.ontrack = (e) => {
    peer.stream.addTrack(e.track);
    const v = peer.tile.querySelector('video');
    v.srcObject = peer.stream;
    v.play().catch(() => {});
    if (e.track.kind === 'audio') watchSpeaking(info.id, new MediaStream([e.track]));
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && initiator) {
      pc.restartIce();
      makeOffer(peer, { iceRestart: true });
    }
  };

  if (initiator) {
    pc.addTransceiver(currentTrack('audio') || 'audio', { direction: 'sendrecv' });
    pc.addTransceiver(currentTrack('video') || 'video', { direction: 'sendrecv' });
    makeOffer(peer);
  }
  return peer;
}

async function makeOffer(peer, opts) {
  const offer = await peer.pc.createOffer(opts);
  await peer.pc.setLocalDescription(offer);
  sendSignal(peer.id, { sdp: peer.pc.localDescription });
}

function sendSignal(to, data) { socket.emit('signal', { to, data }); }

function handleSignal(from, data) {
  const peer = peers.get(from);
  if (!peer) return;
  // Serialize per peer so candidates never race the remote description
  peer.queue = peer.queue.then(async () => {
    const { pc } = peer;
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        for (const t of pc.getTransceivers()) {
          const kind = t.receiver.track.kind;
          t.direction = 'sendrecv';
          await t.sender.replaceTrack(currentTrack(kind));
        }
        await pc.setLocalDescription(await pc.createAnswer());
        sendSignal(from, { sdp: pc.localDescription });
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }).catch((err) => console.error('signal error', err));
}

function replaceTrack(kind, track) {
  for (const { pc } of peers.values()) {
    const t = pc.getTransceivers().find((x) => x.receiver.track.kind === kind);
    t?.sender.replaceTrack(track).catch(() => {});
  }
}

function removePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  p.pc.close();
  p.tile.remove();
  analysers.delete(id);
  peers.delete(id);
  if (state.pinned === id) state.pinned = null;
  refreshUI();
}

// ---------------------------------------------------------------- tiles
function createTile(id, name, self) {
  const tile = document.createElement('div');
  tile.className = 'tile' + (self ? ' self' : '');
  tile.dataset.id = id;
  tile.innerHTML = `
    <video autoplay playsinline ${self ? 'muted' : ''}></video>
    <div class="avatar"><span></span></div>
    <div class="hand"><span class="ms">back_hand</span></div>
    <div class="mic-off"><span class="ms">mic_off</span></div>
    <div class="label"></div>
    <button class="pin" title="Pin"><span class="ms">keep</span></button>`;
  tile.querySelector('.avatar span').textContent = initial(name);
  tile.querySelector('.avatar span').style.background = colorFor(name);
  tile.querySelector('.label').textContent = name;
  tile.querySelector('.pin').onclick = () => {
    state.pinned = state.pinned === id ? null : id;
    layout();
  };
  $('stage').appendChild(tile);
  return tile;
}

function updatePeerTile(p) {
  const showVideo = p.info.video || p.info.screen;
  p.tile.classList.toggle('no-video', !showVideo);
  p.tile.classList.toggle('muted', !p.info.audio);
  p.tile.classList.toggle('hand-up', !!p.info.hand);
  p.tile.classList.toggle('screen', !!p.info.screen);
  p.tile.querySelector('.label').textContent = p.info.name + (p.info.screen ? ' (presenting)' : '');
}

function updateSelfTile() {
  if (!selfTile) return;
  const showVideo = !!currentTrack('video');
  selfTile.classList.toggle('no-video', !showVideo);
  selfTile.classList.toggle('muted', !state.audioOn);
  selfTile.classList.toggle('hand-up', state.hand);
  selfTile.classList.toggle('screen', state.screen);
  selfTile.querySelector('.label').textContent = `${state.name} (You)${state.screen ? ' — presenting' : ''}`;
}

function updateSelfVideo() {
  const t = currentTrack('video');
  const v = selfTile?.querySelector('video');
  if (v) v.srcObject = t ? new MediaStream([t]) : null;
}

function featuredId() {
  if (state.pinned && (state.pinned === 'self' || peers.has(state.pinned))) return state.pinned;
  const presenter = [...peers.values()].find((p) => p.info.screen);
  if (presenter) return presenter.id;
  if (state.screen) return 'self';
  if (state.layout === 'spotlight') return activeSpeaker && activeSpeaker !== 'self' ? activeSpeaker : (peers.keys().next().value || 'self');
  return null;
}

function layout() {
  const stage = $('stage');
  const tiles = [...stage.children];
  const featured = state.layout === 'tiled' && !state.pinned ? null : featuredId();
  tiles.forEach((t) => t.classList.toggle('featured', t.dataset.id === featured));
  stage.classList.toggle('spotlight', state.layout === 'spotlight');
  stage.classList.toggle('featured-layout', !!featured && state.layout !== 'spotlight' && tiles.length > 1);

  const W = stage.clientWidth, H = stage.clientHeight, gap = 10;
  if (state.layout === 'spotlight' || (featured && tiles.length > 1)) {
    stage.style.gridTemplateColumns = '';
    stage.style.gridAutoRows = '';
    stage.style.alignContent = 'stretch';
    stage.style.justifyContent = 'stretch';
    return;
  }
  // Pick the column count that gives the biggest 16:9 tiles
  const n = tiles.length;
  let best = { w: 0, cols: 1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * 16 / 9);
    if (w > best.w) best = { w, cols };
  }
  stage.style.gridTemplateColumns = `repeat(${best.cols}, ${Math.floor(best.w)}px)`;
  stage.style.gridAutoRows = `${Math.floor(best.w * 9 / 16)}px`;
  stage.style.alignContent = 'center';
  stage.style.justifyContent = 'center';
}

// ---------------------------------------------------------------- speaking detection
function level(analyser, data) {
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const v of data) sum += ((v - 128) / 128) ** 2;
  return Math.sqrt(sum / data.length);
}
function watchSpeaking(id, stream) {
  try {
    audioCtx = audioCtx || new AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    analysers.set(id, { analyser, data: new Uint8Array(analyser.fftSize) });
  } catch {}
}
function startSpeakingLoop() {
  setInterval(() => {
    let loudest = null, max = 0.04;
    for (const [id, { analyser, data }] of analysers) {
      const muted = id === 'self' ? !state.audioOn : !peers.get(id)?.info.audio;
      const l = muted ? 0 : level(analyser, data);
      const tile = id === 'self' ? selfTile : peers.get(id)?.tile;
      tile?.classList.toggle('speaking', l > 0.04);
      if (l > max) { max = l; loudest = id; }
    }
    if (loudest && loudest !== activeSpeaker) {
      activeSpeaker = loudest;
      if (state.layout === 'spotlight') layout();
    }
  }, 150);
}

// ---------------------------------------------------------------- controls
async function toggleMic() {
  if (!micTrack) {
    try { micTrack = await getMic($('sel-mic').value || undefined); } catch { toast('Microphone is blocked. Allow it in your browser’s site settings.'); return; }
    state.audioOn = true;
    replaceTrack('audio', micTrack);
    watchSpeaking('self', new MediaStream([micTrack]));
  } else {
    state.audioOn = !state.audioOn;
  }
  micTrack.enabled = state.audioOn;
  socket?.emit('state', { audio: state.audioOn });
  updateCaptions();
  refreshUI();
}

async function toggleCam() {
  if (state.videoOn) {
    state.videoOn = false;
    camTrack?.stop(); // release the camera so its light turns off
    camTrack = null;
  } else {
    try { camTrack = await getCam($('sel-cam').value || undefined); } catch { toast('Camera is blocked. Allow it in your browser’s site settings.'); return; }
    state.videoOn = true;
  }
  if (!state.screen) replaceTrack('video', currentTrack('video'));
  socket?.emit('state', { video: state.videoOn });
  updateSelfVideo();
  refreshUI();
}

async function toggleScreen() {
  if (state.screen) return stopScreen();
  if (peers.size && [...peers.values()].some((p) => p.info.screen)) {
    if (!confirm('Someone else is presenting. Take over?')) return;
  }
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    screenTrack = s.getVideoTracks()[0];
    screenTrack.contentHint = 'detail';
    screenTrack.onended = stopScreen;
    state.screen = true;
    replaceTrack('video', screenTrack);
    socket.emit('state', { screen: true });
    updateSelfVideo();
    refreshUI();
  } catch {}
}
function stopScreen() {
  if (!state.screen) return;
  screenTrack?.stop();
  screenTrack = null;
  state.screen = false;
  replaceTrack('video', currentTrack('video'));
  socket.emit('state', { screen: false });
  updateSelfVideo();
  refreshUI();
}

function toggleHand() {
  state.hand = !state.hand;
  socket.emit('state', { hand: state.hand });
  refreshUI();
}

function toggleRecording() {
  if (recorder) return stopRecording();
  if (!window.MediaRecorder) return toast('Recording isn’t supported in this browser.');
  if (!confirm('Start recording? Everyone in the call will be notified. The recording is saved to your device.')) return;
  recorder = new MeetingRecorder({
    getTiles: () => [...$('stage').children].map((tile) => {
      const id = tile.dataset.id;
      const self = id === 'self';
      const p = peers.get(id);
      const name = self ? `${state.name} (You)` : p?.info.name || '';
      return {
        video: tile.querySelector('video'),
        name,
        color: colorFor(self ? state.name : name),
        showVideo: !tile.classList.contains('no-video'),
        mirror: self && !state.screen,
        contain: tile.classList.contains('screen'),
        featured: tile.classList.contains('featured'),
      };
    }),
    getAudioTracks: () => [micTrack, ...[...peers.values()].flatMap((p) => p.stream.getAudioTracks())].filter(Boolean),
    onStop: (blob, ext) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `Huddle ${ROOM} ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      toast('Recording saved to your downloads');
    },
  });
  recorder.start();
  socket.emit('state', { recording: true });
  systemMessage('You started recording');
  refreshUI();
}
function stopRecording() {
  if (!recorder) return;
  recorder.stop();
  recorder = null;
  socket?.emit('state', { recording: false });
  systemMessage('You stopped recording');
  refreshUI();
}

// ---------------------------------------------------------------- live captions (Web Speech API)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
const captionLines = new Map();

function captionsWanted() {
  return state.cc || [...peers.values()].some((p) => p.info.cc);
}
// Each person transcribes their own speech while anyone in the call has captions on
function updateCaptions() {
  const run = !!SR && captionsWanted() && state.audioOn && !!micTrack;
  if (run && !recognition) {
    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    recognition.onresult = (e) => {
      const r = e.results[e.results.length - 1];
      const text = r[0].transcript.trim();
      if (!text) return;
      socket.emit('caption', { text, final: r.isFinal });
      showCaption('self', 'You', text, r.isFinal);
    };
    recognition.onend = () => { if (recognition) try { recognition.start(); } catch {} };
    recognition.onerror = (e) => { if (e.error === 'not-allowed') { recognition = null; } };
    try { recognition.start(); } catch {}
  } else if (!run && recognition) {
    const r = recognition;
    recognition = null;
    r.stop();
  }
}

function showCaption(id, name, text, final) {
  if (!state.cc) return;
  const box = $('captions');
  let entry = captionLines.get(id);
  if (!entry) {
    const el = document.createElement('div');
    el.className = 'line';
    el.innerHTML = '<b></b><span></span>';
    el.querySelector('b').textContent = name;
    box.appendChild(el);
    entry = { el };
    captionLines.set(id, entry);
    while (box.children.length > 3) {
      const first = box.firstElementChild;
      for (const [k, v] of captionLines) if (v.el === first) captionLines.delete(k);
      first.remove();
    }
  }
  entry.el.querySelector('span').textContent = text;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { entry.el.remove(); captionLines.delete(id); }, final ? 4000 : 6000);
}

function toggleCC() {
  if (!state.cc && !SR) toast('Live captions need a browser with speech recognition (Chrome or Edge). You’ll still see captions from people whose browser supports it.');
  state.cc = !state.cc;
  $('captions').classList.toggle('hidden', !state.cc);
  if (!state.cc) { $('captions').innerHTML = ''; captionLines.clear(); }
  socket.emit('state', { cc: state.cc });
  updateCaptions();
  refreshUI();
}

// ---------------------------------------------------------------- chat
function addChatMessage({ id, name, text, ts }) {
  const mine = id === state.myId;
  const el = document.createElement('div');
  el.className = 'msg';
  el.innerHTML = '<div class="meta"><span></span><time></time></div><div class="text"></div>';
  el.querySelector('.meta span').textContent = mine ? 'You' : name;
  el.querySelector('time').textContent = new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  el.querySelector('.text').append(...linkify(text));
  appendMessage(el);
  if (!mine && state.panel !== 'chat') {
    state.unread++;
    $('chat-badge').classList.remove('hidden');
    toast(`${name}: ${text.length > 80 ? text.slice(0, 80) + '…' : text}`, () => openPanel('chat'));
  }
}
function systemMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg system';
  el.innerHTML = '<div class="text"></div>';
  el.querySelector('.text').textContent = text;
  appendMessage(el);
}
function appendMessage(el) {
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.appendChild(el);
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function linkify(text) {
  return text.split(/(https?:\/\/[^\s]+)/g).map((part, i) => {
    if (i % 2 === 0) return document.createTextNode(part);
    const a = document.createElement('a');
    a.href = part; a.textContent = part; a.target = '_blank'; a.rel = 'noopener noreferrer';
    return a;
  });
}
$('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const v = $('chat-input').value.trim();
  if (!v) return;
  socket.emit('chat', v);
  $('chat-input').value = '';
};

// ---------------------------------------------------------------- reactions
function floatReaction(emoji, name) {
  const el = document.createElement('div');
  el.className = 'floater';
  el.style.left = 5 + Math.random() * 20 + '%';
  el.innerHTML = '<span class="e"></span><span class="n"></span>';
  el.querySelector('.e').textContent = emoji;
  el.querySelector('.n').textContent = name;
  $('reactions-layer').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ---------------------------------------------------------------- side panel & people
function openPanel(which) {
  if (state.panel === which) return closePanel();
  state.panel = which;
  $('panel').classList.remove('hidden');
  for (const k of ['chat', 'people', 'info']) $('panel-' + k).classList.toggle('hidden', k !== which);
  $('panel-title').textContent = { chat: 'In-call messages', people: 'People', info: 'Meeting details' }[which];
  if (which === 'chat') {
    state.unread = 0;
    $('chat-badge').classList.add('hidden');
    $('messages').scrollTop = $('messages').scrollHeight;
    setTimeout(() => $('chat-input').focus(), 0);
  }
  if (which === 'people') renderPeople();
  if (which === 'info') $('info-link').textContent = location.href;
  refreshUI();
}
function closePanel() {
  state.panel = null;
  $('panel').classList.add('hidden');
  refreshUI();
}

function renderPeople() {
  const list = $('people');
  list.innerHTML = '';
  const all = [
    { id: 'self', name: state.name, me: true, audio: state.audioOn, hand: state.hand, host: state.host, screen: state.screen },
    ...[...peers.values()].map((p) => ({ id: p.id, ...p.info })),
  ].sort((a, b) => (b.hand - a.hand) || (b.me ? 1 : 0) - (a.me ? 1 : 0));
  $('people-count').textContent = all.length;
  for (const p of all) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="av"></div><div class="nm"><span></span><small></small></div>`;
    li.querySelector('.av').textContent = initial(p.name);
    li.querySelector('.av').style.background = colorFor(p.name);
    li.querySelector('.nm span').textContent = p.name + (p.me ? ' (You)' : '');
    li.querySelector('small').textContent = [p.host && 'Meeting host', p.screen && 'Presenting'].filter(Boolean).join(' · ');
    if (p.hand) li.insertAdjacentHTML('beforeend', '<span class="ms" title="Hand raised">back_hand</span>');
    li.insertAdjacentHTML('beforeend', `<span class="ms">${p.audio ? 'mic' : 'mic_off'}</span>`);
    if (state.host && !p.me) {
      const mute = document.createElement('button');
      mute.className = 'icon'; mute.title = 'Mute'; mute.innerHTML = '<span class="ms">volume_off</span>';
      mute.disabled = !p.audio;
      mute.onclick = () => socket.emit('host-action', { action: 'mute', target: p.id });
      const rm = document.createElement('button');
      rm.className = 'icon'; rm.title = 'Remove from call'; rm.innerHTML = '<span class="ms">person_remove</span>';
      rm.onclick = () => confirm(`Remove ${p.name} from the call?`) && socket.emit('host-action', { action: 'remove', target: p.id });
      li.append(mute, rm);
    }
    list.appendChild(li);
  }
}

// ---------------------------------------------------------------- UI refresh
function setCtl(btn, { off, active, icon, title }) {
  btn.classList.toggle('off', !!off);
  btn.classList.toggle('active', !!active);
  if (icon) btn.firstElementChild.textContent = icon;
  if (title) btn.title = title;
}
function updateButtons() {
  setCtl($('btn-mic'), { off: !state.audioOn, icon: state.audioOn ? 'mic' : 'mic_off', title: state.audioOn ? 'Turn off microphone (ctrl + d)' : 'Turn on microphone (ctrl + d)' });
  setCtl($('btn-cam'), { off: !state.videoOn, icon: state.videoOn ? 'videocam' : 'videocam_off', title: state.videoOn ? 'Turn off camera (ctrl + e)' : 'Turn on camera (ctrl + e)' });
  setCtl($('btn-cc'), { active: state.cc, title: state.cc ? 'Turn off captions' : 'Turn on captions' });
  setCtl($('btn-share'), { active: state.screen, icon: state.screen ? 'cancel_presentation' : 'present_to_all', title: state.screen ? 'Stop presenting' : 'Present now' });
  setCtl($('btn-hand'), { active: state.hand, title: state.hand ? 'Lower hand' : 'Raise hand' });
  $('btn-rec').classList.toggle('recording', !!recorder);
  $('btn-rec').title = recorder ? 'Stop recording' : 'Record meeting';
  $('btn-chat').classList.toggle('active', state.panel === 'chat');
}
function refreshUI() {
  updateButtons();
  updateSelfTile();
  for (const p of peers.values()) updatePeerTile(p);
  $('people-badge').textContent = peers.size + 1;
  const someoneRecording = !!recorder || [...peers.values()].some((p) => p.info.recording);
  $('rec-badge').classList.toggle('hidden', !someoneRecording);
  if (state.panel === 'people') renderPeople();
  updateCaptions();
  layout();
}

let toastTimer;
function toast(text, onClick) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  t.style.cursor = onClick ? 'pointer' : '';
  t.onclick = onClick ? () => { onClick(); t.classList.add('hidden'); } : null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

function startClock() {
  const tick = () => {
    $('time').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('rec-time').textContent = recorder ? fmtTime(recorder.elapsed) : '';
  };
  tick();
  setInterval(tick, 1000);
}

function copyLink() {
  navigator.clipboard.writeText(location.href).then(() => toast('Meeting link copied'), () => toast(location.href));
}

function leave(title) {
  stopRecording();
  for (const id of [...peers.keys()]) removePeer(id);
  socket?.disconnect();
  if (recognition) { const r = recognition; recognition = null; r.stop(); }
  [micTrack, camTrack, screenTrack].forEach((t) => t?.stop());
  $('meeting').classList.add('hidden');
  $('left').classList.remove('hidden');
  if (title) $('left-title').textContent = title;
}

// ---------------------------------------------------------------- wiring
$('btn-mic').onclick = toggleMic;
$('btn-cam').onclick = toggleCam;
$('btn-cc').onclick = toggleCC;
$('btn-share').onclick = toggleScreen;
$('btn-hand').onclick = toggleHand;
$('btn-rec').onclick = toggleRecording;
$('btn-leave').onclick = () => leave();
$('btn-chat').onclick = () => openPanel('chat');
$('btn-people').onclick = () => openPanel('people');
$('btn-info').onclick = () => openPanel('info');
$('panel-close').onclick = closePanel;
$('info-copy').onclick = copyLink;

function togglePop(id) {
  for (const p of ['react-pop', 'more-pop']) if (p !== id) $(p).classList.add('hidden');
  $(id).classList.toggle('hidden');
}
$('btn-react').onclick = (e) => { e.stopPropagation(); togglePop('react-pop'); };
$('btn-more').onclick = (e) => { e.stopPropagation(); togglePop('more-pop'); };
$('react-pop').onclick = (e) => {
  e.stopPropagation();
  if (e.target.tagName === 'BUTTON') socket.emit('reaction', e.target.textContent);
};
$('more-pop').onclick = (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (act === 'layout') {
    state.layout = { auto: 'tiled', tiled: 'spotlight', spotlight: 'auto' }[state.layout];
    toast(`Layout: ${state.layout}`);
    layout();
  }
  if (act === 'fullscreen') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  if (act === 'copy') copyLink();
};
document.addEventListener('click', () => { $('react-pop').classList.add('hidden'); $('more-pop').classList.add('hidden'); });

document.addEventListener('keydown', (e) => {
  if (!socket || !(e.ctrlKey || e.metaKey)) return;
  if (e.key === 'd') { e.preventDefault(); toggleMic(); }
  if (e.key === 'e') { e.preventDefault(); toggleCam(); }
});
window.addEventListener('beforeunload', (e) => {
  if (recorder) { e.preventDefault(); e.returnValue = ''; }
});

initLobby();
