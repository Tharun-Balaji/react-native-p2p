# Technology Overview (Layperson Friendly)

This document explains the tech stack and how the app works in simple terms.

## Big Picture

The app connects two phones directly using WebRTC. That means:
- Your phone talks straight to the other phone.
- There is no central server relaying your messages or calls.
- A small “handshake” still has to happen so both phones know how to connect.

We use QR codes for that handshake.

## Core Pieces

### 1) React Native (App UI)
React Native lets us build one app that runs on both Android and iOS.

### 2) WebRTC (Direct Connection)
WebRTC is a standard that lets two devices connect directly for:
- Text messages (data channel)
- Voice calls (audio stream)
- Video calls (video stream)
- File transfer (data channel)

### 3) STUN (Public Address Discovery)
Phones often sit behind routers and private networks.
STUN servers help each phone discover the public-facing address that other devices can reach.

We are using free public STUN servers for now.

### 4) QR-Based Signaling (No Server)
Normally, apps use a server to exchange connection details.
We are not using a server, so we do this by:
- Showing a QR code on one phone
- Scanning it with the other phone

The QR will include:
- The user’s unique ID (UUID)
- Connection hints (so the other phone can try to connect immediately)

## How a Connection Works (Simple Flow)

1. User A opens the app.
2. App creates a unique ID and shows a QR code.
3. User B scans the QR.
4. Both phones try to connect directly using WebRTC.
5. Once connected, they can chat, call, and share files.

## Diagrams

### High-Level Flow

```text
User A Phone              User B Phone
------------              ------------
Generate UUID
Create QR  --------scan---->  Read UUID + hints
Create Offer  <----answer----  Create Answer
Direct P2P connection established
```

### QR-Based Signaling (No Server)

```text
          QR Code
   +-----------------+
   | UUID            |
   | ConnectionHints |
   +-----------------+

User A shows QR  -->  User B scans QR
```

### Direct P2P Data Path

```text
User A <======== WebRTC =========> User B
  |                                    |
  |-- Text Messages (Data Channel) ----|
  |-- Audio Stream --------------------|
  |-- Video Stream --------------------|
  |-- File Transfer (Data Channel) ----|
```

## What This Does Not Do

- No TURN relay (TURN is a server that forwards traffic when direct P2P fails).
- No cloud storage for messages.

That means:
- Most connections will work, but some networks may block direct P2P.

## Future-Friendly Notes

If we later want better reliability or scale:
- Add TURN relay for tough networks.
- Add a minimal signaling service instead of QR codes.
- Add optional cloud sync for chat history.

---

## Under the Hood (Detailed)

Deep technical explanations live here:

- `docs/tech/WEBRTC_DETAILS.md`
