# P2P Client v1 Product Spec

## Overview

This document defines the v1 product requirements for a direct peer-to-peer mobile client.

The app must let two users connect without a relay backend, signaling backend, or cloud storage. All durable app data stays on each user's device. Public STUN is permitted only for address discovery and ICE candidate gathering.

The v1 product target is one-to-one communication with:

- text chat
- voice calls
- video calls
- file sharing

## Product Requirements

### Identity and local profile

- The app must create a stable local identity on first launch.
- The user must be able to set and later edit a display name.
- The app must store the identity locally and reuse it across restarts.
- The app must expose a personal QR code for nearby pairing.

### Peer management

- Scanning a peer QR must create or reopen that peer's thread.
- Opening a remote share packet must create or reopen that peer's thread.
- The app must keep a local peer list with last-seen and last-connection details.
- The user must be able to remove a peer and clear that peer's local history.

### Connection behavior

- Same-LAN direct connection is a supported path and should be the easiest successful case.
- Different-network direct connection is supported as best-effort only.
- The app must never route chat, call, or file payloads through an app-controlled server.
- The UI must surface these connection states:
  - `nearby discovered`
  - `connecting`
  - `connected direct`
  - `failed direct`
  - `reconnect needed`

### Messaging

- Users must be able to send and receive one-to-one text messages after a direct connection is established.
- Messages must remain visible offline on the sending and receiving devices until cleared locally.
- Delivery state may be best-effort, but the UI must distinguish pending, sent, received, and failed where supported.

### Voice and video

- Users must be able to place and receive a voice call from a peer thread.
- Users must be able to place and receive a video call from a peer thread.
- A voice call may be upgraded to video if both peers support it.
- The user must explicitly accept an incoming call before media begins.

### File sharing

- Users must be able to pick a local file and send it to a connected peer.
- The receiver must explicitly accept the incoming file before the app writes it locally.
- The app must show transfer progress and final state.
- Interrupted transfers must be recorded as failed, not silently discarded.
- Resume support is not required in v1; retry starts a new transfer.

### Local data control

- The user must be able to clear chat history.
- The user must be able to clear transfer history.
- The user must be able to delete saved files from device storage outside or inside the app if implemented later.
- No local data may be synced to any cloud service by the app.

## Data Contracts

### `UserProfile`

```ts
type UserProfile = {
  id: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
};
```

Rules:

- `id` is a stable local peer identifier.
- `displayName` is editable.
- Timestamps use ISO 8601 strings.

### `ConnectionHints`

```ts
type ConnectionHints = {
  lanIps: string[];
  publicEndpoint?: string;
  lastSuccessfulRoute?: "lan" | "direct-wan";
  iceCandidates?: string[];
  updatedAt: string;
};
```

Rules:

- `lanIps` may be empty.
- `publicEndpoint` is optional because discovery may fail.
- `iceCandidates` is optional and may only include bootstrap-safe data needed for direct connection attempts.

### `PeerRecord`

```ts
type PeerRecord = {
  peerId: string;
  displayName: string;
  trustState: "paired" | "blocked" | "deleted";
  connectionHints: ConnectionHints;
  lastSeenAt?: string;
  lastConnectedAt?: string;
  createdAt: string;
  updatedAt: string;
};
```

Rules:

- `paired` means the user accepted the peer into the local device.
- `blocked` prevents connection attempts and inbound requests from that peer.
- `deleted` may be used internally during local cleanup if soft delete is preferred.

### `ChatMessage`

```ts
type ChatMessage = {
  id: string;
  peerId: string;
  direction: "incoming" | "outgoing";
  body: string;
  deliveryStatus: "pending" | "sent" | "received" | "failed";
  createdAt: string;
};
```

Rules:

- Message bodies are stored locally on-device only.
- `deliveryStatus` is local state and does not imply any server acknowledgement.

### `TransferRecord`

```ts
type TransferRecord = {
  id: string;
  peerId: string;
  fileName: string;
  sizeBytes: number;
  direction: "incoming" | "outgoing";
  status: "pending" | "in-progress" | "completed" | "failed" | "canceled";
  savedPath?: string;
  createdAt: string;
  updatedAt: string;
};
```

Rules:

- `savedPath` is present only for received files that were accepted and written locally.
- Failed and canceled transfers remain in history until cleared.

## Exchanged Payload Shapes

### QR payload

```ts
type QrPayloadV1 = {
  version: 1;
  peerId: string;
  displayName: string;
  capabilities: {
    chat: true;
    voice: boolean;
    video: boolean;
    fileTransfer: boolean;
  };
  connectionHints: ConnectionHints;
  timestamp: string;
};
```

Requirements:

- Must be compact enough for QR rendering and scanning.
- Must include a version field.
- Must not contain message history or file content.

### Remote share packet

```ts
type RemoteSharePacketV1 = {
  version: 1;
  peerId: string;
  displayName: string;
  capabilities: {
    chat: true;
    voice: boolean;
    video: boolean;
    fileTransfer: boolean;
  };
  connectionHints: ConnectionHints;
  timestamp: string;
  bootstrapSession: {
    sessionId: string;
    descriptionType: "offer" | "answer" | "connect-request";
    sdp?: string;
    expiresAt: string;
  };
};
```

Requirements:

- Must be shareable through any external app.
- Must be rejected if expired or malformed.
- Must be versioned from v1 onward.

### Data-channel envelope

```ts
type DataEnvelopeV1<TPayload> = {
  version: 1;
  type:
    | "chat"
    | "call-control"
    | "file-meta"
    | "file-chunk"
    | "file-complete"
    | "file-cancel"
    | "capability-update";
  peerId: string;
  timestamp: string;
  payload: TPayload;
};
```

#### `chat`

```ts
type ChatPayload = {
  messageId: string;
  text: string;
};
```

#### `call-control`

```ts
type CallControlPayload = {
  callId: string;
  action:
    | "offer-voice"
    | "offer-video"
    | "accept"
    | "reject"
    | "end"
    | "mute"
    | "unmute"
    | "enable-video"
    | "disable-video";
};
```

#### `file-meta`

```ts
type FileMetaPayload = {
  transferId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  totalChunks: number;
};
```

#### `file-chunk`

```ts
type FileChunkPayload = {
  transferId: string;
  chunkIndex: number;
  base64Data: string;
};
```

#### `file-complete`

```ts
type FileCompletePayload = {
  transferId: string;
};
```

#### `file-cancel`

```ts
type FileCancelPayload = {
  transferId: string;
  reason: "sender-canceled" | "receiver-declined" | "connection-lost";
};
```

#### `capability-update`

```ts
type CapabilityUpdatePayload = {
  voice: boolean;
  video: boolean;
  fileTransfer: boolean;
};
```

## User Flows

### Nearby pairing

1. User opens the app and sees their personal QR option.
2. Second user scans the QR.
3. The app validates the payload and creates or reopens the peer thread.
4. The app starts direct connection.
5. On success, the thread becomes active for chat, call, and file actions.

Acceptance criteria:

- No manual JSON copy and paste.
- Peer thread is created or reopened automatically.
- Same-LAN users can continue into chat, voice, video, and file flows.

### Remote direct connection

1. User opens a peer thread and creates a remote share packet.
2. User sends the packet through any external channel.
3. Receiver opens the packet in the app.
4. The app validates schema version and freshness.
5. The app attempts direct WebRTC connection using the provided bootstrap session and STUN-assisted ICE candidates.
6. The app either reaches `connected direct` or shows a clear failure reason.

Acceptance criteria:

- The app attempts remote direct connection without an app backend.
- Success is possible on compatible networks.
- Failure messaging explains that the network may block direct peer-to-peer traffic.

### Chat flow

1. A direct connection is established.
2. User sends a text message.
3. Message appears in local history immediately.
4. Receiver sees the message in the same peer thread.

Acceptance criteria:

- Chat works on same-LAN and supported cross-network direct sessions.
- Messages remain on-device and visible offline until cleared.

### Voice and video flow

1. User taps call or video call in the peer thread.
2. Receiver sees an incoming call prompt.
3. Receiver accepts or rejects.
4. On accept, media tracks are attached and the session enters active call state.
5. Either side can end the call.

Acceptance criteria:

- Voice-only call works with microphone permission gating.
- Video call works with camera and microphone permission gating.
- Voice call may upgrade to video when both peers support it.

### File transfer flow

1. Sender picks a file.
2. Receiver is prompted to accept or decline before local write begins.
3. If accepted, sender transmits metadata and chunks over the data channel.
4. Receiver sees progress and final result.
5. On interruption, both devices record the failure.

Acceptance criteria:

- Same-LAN peers can complete file transfers.
- Cross-network peers can transfer files when direct transport succeeds.
- Failed transfers are visible in local history.
- Resume is not required; retry starts a new transfer.

## UX and Security Rules

- Permission prompts must be just-in-time, not all at first launch.
- Incoming calls require explicit acceptance.
- Incoming files require explicit acceptance before write.
- The app must clearly label direct-only connection outcomes.
- Encryption relies on WebRTC transport defaults.
- The app must explain that local metadata still exists on the device even though no cloud storage is used.

## Failure Scenarios

### Invalid payload

- Show an error for unsupported version, missing required fields, or bad format.
- Keep the user on a recoverable screen with retry actions.

### Expired packet

- Reject stale bootstrap sessions.
- Ask the user to request a fresh remote share packet.

### Network failure

- Show `failed direct` when ICE cannot find a route in time.
- Explain that some networks do not allow direct peer-to-peer traffic without a relay.

### App restart

- Preserve local profile, peer list, chat history, and transfer history.
- Require a fresh connection attempt after restart unless an active session can be safely re-established.

## Prototype Mapping

The current prototype already includes:

- direct WebRTC connection
- chat over data channel
- audio support
- chunked file transfer

The current prototype does not yet meet the v1 spec for:

- nearby pairing with QR code
- remote share packet UX
- local peer and history persistence
- video calling
- explicit incoming call acceptance
- explicit incoming file acceptance
- typed connection-state UX for the full product flow
