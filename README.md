# Huddle — video meetings in the browser

A video meeting app in the style of Google Meet. It's a **fully static site**: calls are peer-to-peer WebRTC, and
[Supabase Realtime](https://supabase.com/docs/guides/realtime) handles room signalling (presence + broadcast), so there's no server to run.

**Live:** https://starktvm-hrms.github.io/meet-app/

## Run locally

```bash
npm start          # serves the folder on http://localhost:3000
```

Any static file server works. Browsers only give camera, microphone and screen access on `localhost` or over **HTTPS**.

## Configuration

`js/config.js` holds the Supabase project URL, its publishable key (safe to expose in the browser) and the ICE servers.
Add a TURN server there for users behind strict NATs/firewalls.

## Features

| | |
|---|---|
| Pre-join lobby | Camera preview, mic level meter, device pickers, mic/camera toggles, remembered name |
| Video & voice | Multi-party WebRTC (mesh), speaking highlight, mute indicators, camera fully released when off |
| Screen sharing | "Present now" puts the presenter in a large tile with the others in a strip |
| Recording | Records every tile and mixes everyone's audio into one `.webm`/`.mp4`, saved to your computer. Everyone sees a REC badge |
| In-meeting chat | Timestamps, clickable links, unread dot, message toasts |
| Live captions | Speech-to-text via the Web Speech API (Chrome/Edge). Each person's browser transcribes their own speech while anyone has CC on |
| Reactions & hand raise | Floating emoji reactions and a raised-hand icon on the tile, in the people list, and as a toast |
| People panel | The earliest person in the room is host and can mute or remove people. Host moves on when they leave |
| Layouts | Auto / tiled / spotlight, pin any tile, full screen |
| Shortcuts | `Ctrl+D` mic, `Ctrl+E` camera |

## How it works

- `js/signaling.js` joins a Realtime channel per meeting code. **Presence** lists who's in the room and their mic/camera/hand state.
  **Broadcast** carries WebRTC offers/answers/ICE candidates, chat, reactions, captions and host actions.
- Of any two people, the one who joined later sends the WebRTC offer, so both sides never offer at once.
- Meeting links are `room.html?m=abc-defg-hij`. `404.html` also redirects short links like `/meet-app/abc-defg-hij`.

## Notes

- **Scale:** the mesh design works well up to about 6–8 people. Larger meetings need an SFU (LiveKit, mediasoup).
- **Trust:** host controls are enforced in each participant's browser, not on a server. Anyone with the link can join.
- Chat isn't stored anywhere. It disappears when the call ends.
