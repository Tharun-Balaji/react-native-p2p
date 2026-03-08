# P2P Client v1 Design

## Overview

This document defines the target design for a mobile P2P client that connects users directly without a relay backend, signaling backend, or cloud storage.

The v1 product is `direct-only`:

- Chat, voice, video, and file payloads must flow directly between peers.
- All user data must remain on the user's device.
- Public STUN is allowed only for address discovery and ICE candidate gathering.
- TURN, relay transport, and hosted sync are out of scope.

The app must support peers who are:

- Physically near each other through nearby pairing with QR code.
- On the same network.
- On different networks through a remote share packet plus best-effort direct WebRTC connectivity.

## Goals

- Provide a one-to-one direct connection experience for chat, voice calls, video calls, and file sharing.
- Keep all durable user data local to each device.
- Replace manual JSON copy and paste with guided pairing flows.
- Support both same-LAN and different-network direct connection attempts.
- Be honest about connection limits when direct P2P is blocked by NAT or firewalls.

## Non-Goals

- No TURN relay.
- No backend signaling service.
- No account system or login.
- No cloud backup or cross-device sync.
- No guaranteed remote connectivity on all networks.
- No group chat or multi-party calling.

## Design Principles

- Direct transport first: the app only succeeds when peers establish a direct connection.
- Local-first data: identity, peers, messages, and transfer history are stored on-device.
- Explicit pairing: users choose when to add peers, connect, answer calls, and save files.
- Honest UX: when direct connectivity fails, the app explains why and does not pretend to fall back to a server.
- Versioned payloads: QR and remote share packet formats must include a version for forward compatibility.

## Supported Connection Modes

### Nearby pairing

Nearby pairing is the primary flow for people in the same physical place.

- User A opens their personal QR code.
- User B scans it.
- The scan creates or reopens a `PeerRecord` for User A.
- The app can immediately attempt a direct connection using the included hints.

This flow avoids manual payload copy and paste while still staying server-free.

### Same-network direct connection

Same-LAN connectivity is the lowest-friction path.

- Peers exchange a QR payload or remote share packet.
- Both sides prefer private LAN candidates first.
- WebRTC usually connects quickly when both devices are on the same Wi-Fi and peer-to-peer traffic is allowed.

### Remote share packet

When users are apart, one peer shares a remote share packet through any external channel the app does not control, such as messaging, email, or nearby share.

- The packet contains peer identity, recent connection hints, IP candidates if available, capability flags, timestamp, and bootstrap session data.
- The receiving user opens the packet in the app and starts a connection attempt.
- Public STUN may contribute ICE candidates, but it must not relay user payloads.

This is still direct-only because the out-of-band sharing path is only used to exchange bootstrap data.

### Different-network direct connection

Different-network connectivity is best-effort.

- The app exchanges recent public endpoints and ICE candidates via the remote share packet.
- WebRTC tries candidate pairs until one direct route succeeds.
- Some network pairs will fail without TURN, especially under symmetric NAT, enterprise firewalls, hotel Wi-Fi, and carrier-grade NAT.

The product must present this as best-effort, not guaranteed.

## System Architecture

### Core layers

1. UI layer
   - Identity setup
   - Peer list
   - Nearby pairing with QR render and scan
   - Peer thread
   - Chat composer and history
   - Voice call and video call controls
   - File send and receive prompts

2. Local data layer
   - Stores `UserProfile`
   - Stores `PeerRecord`
   - Stores `ChatMessage`
   - Stores `TransferRecord`
   - Stores reusable `ConnectionHints`

3. Connection orchestration layer
   - Builds QR payloads and remote share packets
   - Creates and restores peer sessions
   - Tracks connection state
   - Coordinates reconnect behavior

4. Realtime transport layer
   - `RTCPeerConnection`
   - Audio track
   - Video track
   - Data channel for chat, control, and file transport
   - ICE candidate gathering with STUN support

### Transport design

- WebRTC handles all direct transport.
- Separate media tracks support voice-only and video call states.
- A reliable ordered data channel carries:
  - chat messages
  - call control events
  - file metadata
  - file chunks
  - file completion and cancel messages
  - peer capability updates

### Local persistence design

All durable information is stored only on-device.

- Peer identity and settings survive app restarts.
- Chat history remains available offline until cleared.
- Transfer history remains visible even if the transfer failed.
- Received files are stored locally only after explicit user acceptance.

## End-to-End Flows

### 1. First-run identity creation

1. User launches the app for the first time.
2. App generates a stable local peer ID.
3. App asks for an editable display name.
4. App stores the resulting `UserProfile` locally.
5. App generates a QR payload from the identity plus recent connection hints.

### 2. Nearby QR onboarding

```text
User A                       User B
------                       ------
Open my QR
Render QR  ----------------> Scan QR
                             Decode version + peer identity + hints
                             Create or reopen peer thread
                             Start direct connection attempt
Exchange ICE/bootstrap data through local pairing flow
Direct connection established
```

Expected result:

- User B lands in a dedicated peer thread for User A.
- The app attempts to connect without manual JSON copy and paste.

### 3. Remote share-packet connection

```text
User A                                  User B
------                                  ------
Open peer thread
Create remote share packet
Share packet by external app  ------->  Open packet in app
                                        Validate version and timestamp
                                        Create or reopen peer thread
                                        Start direct connection attempt
Exchange current ICE/bootstrap data through follow-up share if needed
Direct connection succeeds or fails with explanation
```

Expected result:

- Users can attempt remote direct connection while apart.
- Failure remains possible on restrictive networks.

### 4. Reconnect to a known peer

1. User opens an existing peer thread.
2. App loads stored `PeerRecord` and recent `ConnectionHints`.
3. App tries the last successful route type first.
4. If the direct connection fails, the app requests a fresh nearby pairing or remote share packet.

### 5. Session lifecycle after connection

```text
Thread open -> connecting -> connected direct
connected direct -> chat active
connected direct -> voice call active
connected direct -> video call active
connected direct -> file transfer in progress
Any active state -> reconnect needed or failed direct
```

Once transport is ready, the peer thread must support:

- chat send and receive
- voice call start, answer, end
- video upgrade and downgrade
- file send, receive, cancel, and completion states

## Failure Handling and Fallback Behavior

### Invalid or expired remote share packet

- Reject unknown schema versions.
- Reject malformed payloads.
- Reject packets older than the allowed freshness window.
- Show a clear action: request a new share packet.

### Peer unreachable

- If the remote peer does not answer, show `Peer unreachable`.
- Preserve the peer thread and retry controls.
- Do not delete local history.

### ICE timeout

- Stop the attempt after a bounded timeout.
- Show `Direct connection failed`.
- Explain that the network may block direct peer-to-peer traffic.
- Offer retry, nearby pairing, or new remote share packet actions.

### Same-network success but different-network failure

- Preserve the peer relationship because the identity is still valid.
- Mark remote connectivity as `best-effort`.
- Prefer same-LAN routes when both peers are nearby again.

### Storage and transfer failures

- If there is insufficient local storage, reject the receive action before writing.
- If a file transfer is interrupted, keep a failed `TransferRecord`.
- v1 does not require resumable transfer; retry starts a new transfer.

## Security and Privacy Model

- WebRTC encryption protects media and data in transit.
- No app-controlled backend stores chat, call, or file payloads.
- Metadata still exists on the local devices, including peer names, timestamps, and transfer history.
- The app requests camera, microphone, and file permissions only at the moment they are needed.
- Incoming calls and incoming file saves always require explicit user action.

## Public Interfaces

These payloads and records form the v1 contract and should remain stable once implemented.

### QR payload

Required fields:

- `version`
- `peerId`
- `displayName`
- `capabilities`
- `connectionHints`
- `timestamp`

### Remote share packet

Required fields:

- `version`
- `peerId`
- `displayName`
- `capabilities`
- `connectionHints`
- `timestamp`
- `bootstrapSession`

### Data-channel envelope

Every data-channel message must include:

- `version`
- `type`
- `peerId`
- `timestamp`
- `payload`

Supported `type` values in v1:

- `chat`
- `call-control`
- `file-meta`
- `file-chunk`
- `file-complete`
- `file-cancel`
- `capability-update`

## Implementation Notes Relative to the Current Prototype

- The current app already proves direct chat, audio, and file transfer over WebRTC.
- Manual offer and answer paste is prototype-only and should be replaced by nearby pairing and remote share packet flows.
- Audio-only transport must expand to include video tracks and call control messages.
- File transfer can stay chunked over the data channel, but the product contract must add explicit receive consent and error states.
- Existing documentation that describes copy-paste signaling should remain historical context, not the v1 UX target.
