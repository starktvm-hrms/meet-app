// Records the whole meeting: composites every visible tile onto a canvas and
// mixes every participant's audio, then hands back a downloadable file.
class MeetingRecorder {
  constructor({ getTiles, getAudioTracks, onStop }) {
    this.getTiles = getTiles;
    this.getAudioTracks = getAudioTracks;
    this.onStop = onStop;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1280;
    this.canvas.height = 720;
    this.ctx = this.canvas.getContext('2d');
    this.sources = new Map(); // track.id -> MediaStreamAudioSourceNode
  }

  static pickMimeType() {
    const types = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ];
    return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  start() {
    this.audioCtx = new AudioContext();
    this.dest = this.audioCtx.createMediaStreamDestination();
    // A silent source keeps the audio track alive even when nobody talks.
    const silence = this.audioCtx.createConstantSource();
    silence.offset.value = 0;
    silence.connect(this.dest);
    silence.start();
    this.syncAudio();

    const stream = new MediaStream([
      ...this.canvas.captureStream(30).getVideoTracks(),
      ...this.dest.stream.getAudioTracks(),
    ]);
    this.mimeType = MeetingRecorder.pickMimeType();
    this.chunks = [];
    this.recorder = new MediaRecorder(stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.onstop = () => this.finish();
    this.recorder.start(1000);
    this.startedAt = Date.now();

    // setInterval (not rAF) so recording keeps going if the tab is in the background
    this.drawTimer = setInterval(() => this.draw(), 1000 / 30);
    this.audioTimer = setInterval(() => this.syncAudio(), 1000);
  }

  // Connect audio tracks from participants who joined after recording began
  syncAudio() {
    const live = new Set();
    for (const track of this.getAudioTracks()) {
      if (track.readyState !== 'live') continue;
      live.add(track.id);
      if (this.sources.has(track.id)) continue;
      const src = this.audioCtx.createMediaStreamSource(new MediaStream([track]));
      src.connect(this.dest);
      this.sources.set(track.id, src);
    }
    for (const [id, src] of this.sources) {
      if (!live.has(id)) { src.disconnect(); this.sources.delete(id); }
    }
  }

  draw() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height, gap = 8;
    ctx.fillStyle = '#202124';
    ctx.fillRect(0, 0, W, H);

    const tiles = this.getTiles();
    const featured = tiles.find((t) => t.featured);
    let rects;
    if (featured && tiles.length > 1) {
      // Big presenter tile + filmstrip on the right
      const side = tiles.filter((t) => t !== featured).slice(0, 4);
      const sw = 260, sh = sw * 9 / 16;
      rects = [[featured, gap, gap, W - sw - gap * 3, H - gap * 2]];
      side.forEach((t, i) => rects.push([t, W - sw - gap, gap + i * (sh + gap), sw, sh]));
    } else {
      const n = Math.max(tiles.length, 1);
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const tw = (W - gap * (cols + 1)) / cols;
      const th = (H - gap * (rows + 1)) / rows;
      rects = tiles.map((t, i) => [t, gap + (i % cols) * (tw + gap), gap + Math.floor(i / cols) * (th + gap), tw, th]);
    }
    for (const [t, x, y, w, h] of rects) this.drawTile(t, x, y, w, h);
  }

  drawTile(t, x, y, w, h) {
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, w, h, 8) : ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = '#3c4043';
    ctx.fillRect(x, y, w, h);

    const v = t.video;
    if (t.showVideo && v.videoWidth) {
      const vr = v.videoWidth / v.videoHeight, r = w / h;
      let dw, dh;
      // contain for screen shares, cover for cameras
      if (t.contain ? vr > r : vr < r) { dw = w; dh = w / vr; } else { dh = h; dw = h * vr; }
      const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
      if (t.mirror) {
        ctx.translate(x * 2 + w, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(v, dx, dy, dw, dh);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      const r = Math.min(w, h) * 0.18;
      ctx.fillStyle = t.color;
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.round(r)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((t.name[0] || '?').toUpperCase(), x + w / 2, y + h / 2);
    }
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.shadowColor = 'rgba(0,0,0,.8)';
    ctx.shadowBlur = 4;
    ctx.fillStyle = '#fff';
    ctx.fillText(t.name, x + 10, y + h - 8);
    ctx.restore();
  }

  get elapsed() { return Date.now() - this.startedAt; }

  stop() {
    clearInterval(this.drawTimer);
    clearInterval(this.audioTimer);
    if (this.recorder?.state !== 'inactive') this.recorder.stop();
  }

  finish() {
    const type = this.mimeType.split(';')[0] || 'video/webm';
    const blob = new Blob(this.chunks, { type });
    this.audioCtx.close();
    this.onStop?.(blob, type.includes('mp4') ? 'mp4' : 'webm');
  }
}
