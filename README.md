# React Native P2P WebRTC Starter

This project is a React Native (Expo) app that lets two devices on the same network:

1. Talk over a WebRTC audio track.
2. Chat over a WebRTC data channel.
3. Share files over the same data channel (chunked base64 transfer).

Signaling is manual in this prototype (copy/paste JSON offer/answer).

> Explanatory note: this repo intentionally uses manual signaling so the WebRTC handshake is visible while learning.

## Planned v1 design docs

The current app remains a prototype with manual signaling, but the target product direction is documented here:

1. `docs/P2P_CLIENT_DESIGN.md`
2. `docs/P2P_CLIENT_SPEC.md`

These docs define a direct-only P2P client where chat, calls, and file transfers stay peer-to-peer, all durable data stays on-device, and public STUN is used only for address discovery and ICE candidate gathering.

## What this demo is for

1. Hobby/testing on same Wi-Fi.
2. Learning WebRTC basics without running backend signaling code.

## Current architecture

1. `RTCPeerConnection` with STUN (`stun:stun.l.google.com:19302`).
2. Audio-only `getUserMedia` track for voice.
3. Data channel protocol messages:
   1. `chat`
   2. `file-meta`
   3. `file-chunk`
   4. `file-end`
4. Received files are written to app storage using `expo-file-system`.

> Explanatory note: all transfer messages are JSON for simplicity and cross-platform consistency.

## Dependencies

1. `react-native-webrtc`
2. `react-native-safe-area-context`
3. `expo-document-picker`
4. `expo-file-system`

## Run

`react-native-webrtc` is native, so use a dev build (not plain Expo Go):

```bash
pnpm install
pnpm prebuild
npx expo run:android
# or
npx expo run:ios
```

## Two-device test flow

On Device A:

1. Tap `1) Create Offer`.
2. Copy `Local Payload` and send to Device B.

On Device B:

1. Paste into `Remote Payload`.
2. Tap `2) Create Answer`.
3. Copy `Local Payload` and send back to Device A.

Back on Device A:

1. Paste answer into `Remote Payload`.
2. Tap `3) Apply Answer`.
3. Wait for status `Connected`.

After connection:

1. Talk immediately (mic permission prompt appears when peer is created).
2. Send chat messages with `Send`.
3. Send files with `Pick and Send File`.

## Notes and limits

1. This is intentionally simple and not production-hardened.
2. File transfer uses base64 and in-memory chunking, so keep files small while testing.
3. Manual signaling is fine for a demo; replace with WebSocket/Firebase for convenience.

## How the P2P connection works (layman explanation)

Think of this app like two people trying to start a direct phone call while texting each other setup details first.

### 1) First, both phones create a "call object"

Each device creates a `RTCPeerConnection`.  
You can think of it as a virtual call socket that knows how to:

1. Carry live audio.
2. Carry text/file messages on a side channel.
3. Try different network routes until one works.

### 2) STUN helps each phone learn "how I look on the internet"

Most devices are behind Wi-Fi routers/NAT, so they do not know their public-facing address.  
The app asks a public STUN server (`stun.l.google.com:19302`) to discover reachable addresses.

In simple terms: STUN is like asking "what return address should I give the other phone?"

### 3) One side creates an Offer (Device A)

When you tap **Create Offer**:

1. Device A turns on microphone capture (`getUserMedia` audio only).
2. Device A adds that audio track to the peer connection.
3. Device A creates a data channel (`p2p-chat-files`) for chat and file transfer.
4. Device A generates an SDP offer (a big settings sheet describing codecs, network candidates, etc.).
5. The app waits for ICE gathering to finish so candidates are included in the payload.
6. The offer JSON appears in **Local Payload**.

That JSON is not the media itself. It is just negotiation info.

### 4) Offer is manually shared to Device B

In this demo, signaling is copy/paste (no server).  
You send Device A's JSON to Device B in any way (chat app, notes, etc.).

### 5) Device B creates an Answer

When Device B pastes the offer and taps **Create Answer**:

1. Device B also creates its peer connection and mic track.
2. Device B applies Device A's offer (`setRemoteDescription`).
3. Device B generates an SDP answer (`createAnswer`).
4. Device B waits for ICE gathering complete.
5. Device B shows answer JSON in **Local Payload**.

### 6) Answer is sent back to Device A

Device A pastes that answer and taps **Apply Answer** (`setRemoteDescription`).

Now both sides have matching negotiation details.  
At this point, WebRTC starts final connectivity checks (ICE checks) and tries candidate pairs until one route succeeds.

### 7) Connection becomes active

When a route works:

1. Connection state moves toward `connected`.
2. Data channel opens.
3. Audio can flow directly between peers.

If a remote audio track arrives, the app updates status to show audio track connected.

### 8) Chat messages over data channel

After the channel is open, each chat message is JSON:

1. Sender sends `{ "type": "chat", "text": "..." }`.
2. Receiver parses and appends it to the chat log.

No backend stores these messages in this prototype; they go peer-to-peer after setup.

### 9) File transfer over the same data channel

For files, the app uses a small protocol:

1. `file-meta` (file name, type, size, total chunks)
2. many `file-chunk` messages (base64 pieces, 16 KB each)
3. `file-end` (transfer complete signal)

Receiver side:

1. Creates an in-memory chunk array after `file-meta`.
2. Places each chunk by index as it arrives.
3. On `file-end`, joins all chunks.
4. Saves the reconstructed base64 file to app storage (`expo-file-system`).

### 10) Why chunking and flow control are used

Large messages can overflow the data channel buffer.  
So sender waits when `bufferedAmount` is high (`MAX_BUFFERED_AMOUNT`) before sending more chunks.

This is basic backpressure so transfer is more stable.

### 11) What is "P2P" here, exactly?

After offer/answer exchange is done, media/data travel directly between devices whenever network allows it.  
The STUN server helps discovery only; it does not carry your chat/file/audio stream in this demo.

### 12) Why manual signaling exists in this project

WebRTC always needs a signaling path to exchange offer/answer/candidates.  
Production apps use WebSocket/Firebase/HTTP signaling. This starter uses copy/paste so you can learn the core WebRTC flow without building backend signaling first.
