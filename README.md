# React Native P2P WebRTC Starter

This project is a React Native (Expo) app that lets two devices on the same network:

1. Talk over a WebRTC audio track.
2. Chat over a WebRTC data channel.
3. Share files over the same data channel (chunked base64 transfer).

Signaling is manual in this prototype (copy/paste JSON offer/answer).

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
