# WebRTC Internals (Detailed)

This document explains the lower-level pieces: WebRTC, ICE, STUN, and TURN.

## WebRTC Building Blocks

WebRTC is a real-time communication standard. It uses:
- **SDP (Session Description Protocol)**: a text description of media and connection settings.
- **ICE (Interactive Connectivity Establishment)**: a process that finds a working network path between peers.
- **DTLS/SRTP**: encryption for calls and data channels.

## ICE in Simple Steps

ICE tries multiple possible network routes and picks the first that works.

```text
Peer A                      Peer B
------                      ------
Gather candidates  <----->  Gather candidates
Try candidate pairs
Pick the first working route
```

## STUN (What We Use)

STUN servers help each phone discover its public IP/port when behind a router.
They do not relay traffic. They just answer the question:
"What does the internet see me as?"

```text
Phone ---- STUN ----> Public IP/Port learned
```

## TURN (What We Are Not Using Now)

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

## Why TURN Matters (Even If Not Used Now)

Some networks block direct P2P:
- Corporate networks
- Hotel Wi-Fi
- Carrier-grade NAT

Without TURN, those users simply will not connect.

## Signaling (How Peers Exchange SDP)

WebRTC does not define signaling. Apps must provide it.
We use QR codes:

```text
User A creates offer (SDP + ICE candidates)
QR encodes UUID + connection hints
User B scans and replies with answer
```

## End-to-End Flow With ICE

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
