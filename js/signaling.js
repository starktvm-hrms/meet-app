/* global supabase */
// Serverless room signalling on Supabase Realtime.
// Exposes the same small event API the app used with Socket.IO:
//   on(event, fn) / emit(event, payload) / disconnect()
// Presence tracks who is in the room and their media state; broadcast carries
// WebRTC signals, chat, reactions, captions and host actions.
const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const STATE_KEYS = ['audio', 'video', 'screen', 'hand', 'recording', 'cc'];

class RealtimeRoom {
  constructor(room, { supabaseUrl, supabaseKey }) {
    this.room = room;
    this.client = supabase.createClient(supabaseUrl, supabaseKey);
    this.handlers = {};
    this.members = new Map(); // id -> info as last delivered to the app
    this.pendingSignals = new Map(); // signals from members we haven't announced yet
    this.me = null;
    this.joined = false;
    this.host = null;
    this.open();
  }

  on(event, fn) { (this.handlers[event] ||= []).push(fn); }
  fire(event, data) { for (const fn of this.handlers[event] || []) fn(data); }

  open() {
    this.channel = this.client.channel(`huddle:${this.room}`, {
      config: { broadcast: { self: true }, presence: { key: '' } },
    });
    this.channel
      .on('presence', { event: 'sync' }, () => this.onSync())
      .on('broadcast', { event: 'msg' }, ({ payload }) => this.onMessage(payload))
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') this.fire('connect');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') this.fire('disconnect');
      });
  }

  // ---- outgoing (same event names the Socket.IO server handled)
  emit(event, payload) {
    if (event === 'join') return this.join(payload);
    if (!this.me) return;
    if (event === 'state') {
      for (const k of STATE_KEYS) if (payload && k in payload) this.me[k] = !!payload[k];
      return this.track();
    }
    if (event === 'signal') return this.send({ type: 'signal', to: payload.to, data: payload.data });
    if (event === 'chat') {
      if (typeof payload !== 'string' || !payload.trim()) return;
      return this.send({ type: 'chat', name: this.me.name, text: payload.slice(0, 2000), ts: Date.now() });
    }
    if (event === 'reaction') return this.send({ type: 'reaction', name: this.me.name, emoji: String(payload).slice(0, 8) });
    if (event === 'caption') return this.send({ type: 'caption', name: this.me.name, text: String(payload.text).slice(0, 500), final: !!payload.final });
    if (event === 'host-action') return this.send({ type: 'host-action', ...payload });
  }

  join({ name, audio, video }) {
    // A fresh id per join, so a reconnect never collides with our stale presence entry
    this.me = {
      id: crypto.randomUUID(),
      name: String(name || 'Guest').slice(0, 40),
      joinedAt: Date.now(),
      audio: !!audio, video: !!video, screen: false, hand: false, recording: false, cc: false,
    };
    this.joined = false;
    this.members.clear();
    this.pendingSignals.clear();
    this.host = null;
    this.track();
  }

  track() { return this.channel.track({ ...this.me }); }
  send(msg) {
    return this.channel.send({ type: 'broadcast', event: 'msg', payload: { ...msg, from: this.me.id } });
  }

  disconnect() {
    this.me = null;
    this.client.removeChannel(this.channel);
  }

  // ---- incoming
  static older(a, b) { return a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1); }

  // Presence is the source of truth for who is here and their media state
  onSync() {
    if (!this.me) return;
    const present = new Map();
    for (const metas of Object.values(this.channel.presenceState())) {
      for (const m of metas) if (m.id && CODE_RE.test(this.room)) present.set(m.id, m);
    }
    if (!present.has(this.me.id)) return; // our own track() hasn't landed yet

    const byAge = [...present.values()].sort(RealtimeRoom.older);
    const hostId = byAge[0].id;
    const others = byAge.filter((m) => m.id !== this.me.id);
    const info = (m) => ({ id: m.id, name: m.name, host: m.id === hostId, ...Object.fromEntries(STATE_KEYS.map((k) => [k, !!m[k]])) });

    if (!this.joined) {
      // Older members are "already here": we (the newcomer) send them offers.
      // Anyone newer will be announced via peer-joined and will offer to us.
      this.joined = true;
      this.host = hostId;
      const existing = others.filter((m) => RealtimeRoom.older(m, this.me) < 0);
      for (const m of existing) this.members.set(m.id, info(m));
      this.fire('room-state', { you: { ...info(this.me) }, peers: existing.map(info) });
    }

    for (const m of others) {
      const next = info(m);
      const prev = this.members.get(m.id);
      if (!prev) {
        this.members.set(m.id, next);
        this.fire('peer-joined', next);
        for (const data of this.pendingSignals.get(m.id) || []) this.fire('signal', { from: m.id, data });
        this.pendingSignals.delete(m.id);
        continue;
      }
      const patch = {};
      for (const k of STATE_KEYS) if (prev[k] !== next[k]) patch[k] = next[k];
      if (Object.keys(patch).length) {
        this.members.set(m.id, next);
        this.fire('peer-state', { id: m.id, ...patch });
      }
    }
    for (const id of [...this.members.keys()]) {
      if (!present.has(id)) { this.members.delete(id); this.fire('peer-left', id); }
    }
    if (hostId !== this.host) { this.host = hostId; this.fire('host-changed', hostId); }
  }

  onMessage(msg) {
    if (!this.me || !msg?.from) return;
    const mine = msg.from === this.me.id;
    switch (msg.type) {
      case 'signal':
        if (msg.to !== this.me.id) return;
        if (this.members.has(msg.from)) this.fire('signal', { from: msg.from, data: msg.data });
        else (this.pendingSignals.get(msg.from) || this.pendingSignals.set(msg.from, []).get(msg.from)).push(msg.data);
        break;
      case 'chat':
        this.fire('chat', { id: msg.from, name: msg.name, text: String(msg.text), ts: msg.ts });
        break;
      case 'reaction':
        this.fire('reaction', { id: msg.from, name: msg.name, emoji: msg.emoji });
        break;
      case 'caption':
        if (!mine) this.fire('caption', { id: msg.from, name: msg.name, text: msg.text, final: msg.final });
        break;
      case 'host-action':
        // Only honour actions from whoever presence says is the host
        if (msg.target !== this.me.id || msg.from !== this.host) return;
        if (msg.action === 'mute') this.fire('force-mute');
        if (msg.action === 'remove') this.fire('removed');
        break;
    }
  }
}
