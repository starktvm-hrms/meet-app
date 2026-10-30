// Public client config. The publishable key is safe to ship in the browser.
window.HUDDLE_CONFIG = {
  supabaseUrl: 'https://vqicxogodvxskbmchnqq.supabase.co',
  supabaseKey: 'sb_publishable_BIfVf3kCtfdhgZ2UO3q2xw_rVfk-Cfx',
  // Add a TURN server here for users behind strict NATs/firewalls, e.g.
  // { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};
