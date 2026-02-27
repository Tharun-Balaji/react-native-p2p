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

This section explains the lower-level pieces: WebRTC, ICE, STUN, and TURN.

### WebRTC Building Blocks

WebRTC is a real-time communication standard. It uses:
- **SDP (Session Description Protocol)**: a text description of media and connection settings.
- **ICE (Interactive Connectivity Establishment)**: a process that finds a working network path between peers.
- **DTLS/SRTP**: encryption for calls and data channels.

### ICE in Simple Steps

ICE tries multiple possible network routes and picks the first that works.

```text
Peer A                      Peer B
------                      ------
Gather candidates  <----->  Gather candidates
Try candidate pairs
Pick the first working route
```

### STUN (What We Use)

STUN servers help each phone discover its public IP/port when behind a router.
They do not relay traffic. They just answer the question:
"What does the internet see me as?"

```text
Phone ---- STUN ----> Public IP/Port learned
```

### TURN (What We Are Not Using Now)

TURN is a relay server. If direct P2P fails, both peers send traffic to TURN,
and TURN forwards it.

This improves reliability but adds:
- A server to run
- Cost (bandwidth)
- More latency

```text
Phone A -----> TURN <----- Phone B
           (relay)
```

### Why TURN Matters (Even If Not Used Now)

Some networks block direct P2P:
- Corporate networks
- Hotel Wi-Fi
- Carrier-grade NAT

Without TURN, those users simply will not connect.

### Signaling (How Peers Exchange SDP)

WebRTC does not define signaling. Apps must provide it.
We use QR codes:

```text
User A creates offer (SDP + ICE candidates)
QR encodes UUID + connection hints
User B scans and replies with answer
```

### End-to-End Flow With ICE

```text
User A Phone                User B Phone
------------                ------------
Create Offer (SDP)
Gather ICE candidates
Encode UUID + hints in QR  ----scan----> Decode hints
Apply remote offer
Create Answer (SDP)
Gather ICE candidates
Apply remote answer
ICE finds a working route
Secure P2P connection established
```
