# Huddle — video meetings in the browser

A video meeting app in the style of Google Meet. It uses WebRTC for peer-to-peer media and Socket.IO for signalling.

## Run

```bash
npm install
npm start          # http://localhost:3000
```

Open `http://localhost:3000` and click **New meeting**, then share the link (`/abc-defg-hij`).
Browsers only give camera, microphone and screen access on `localhost` or over **HTTPS**, so put it behind TLS when you deploy it.

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
| People panel | Host (first to join) can mute or remove people. Host moves to someone else when they leave |
| Layouts | Auto / tiled / spotlight, pin any tile, full screen |
| Shortcuts | `Ctrl+D` mic, `Ctrl+E` camera |

## Notes

- **Firewalls / NAT:** STUN alone fails on some networks. Set `TURN_URL`, `TURN_USER` and `TURN_PASS` (for example coturn) and clients pick them up from `/api/ice`.
- **Scale:** the mesh design works well up to about 6–8 people. Larger meetings need an SFU (mediasoup, LiveKit, Janus).
- Chat and room state live only in memory and disappear when the call ends.
