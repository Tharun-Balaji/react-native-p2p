# Architecture Notes

This document captures architectural decisions, rationale, and changes as we iterate.

## 2026-02-27

### Context
- You are planning to change the architecture of the entire app.
- You asked to start documenting from now on.
- Format requested: a single Markdown file updated over time.
- No separate chat log files.

### High-Level Requirements (New)
- P2P must work when users are not on the same network.
- App should function entirely on the client with no server.
- Features needed: messaging, video calls, audio calls, file transfer.

### Feasibility Notes
- Pure client-only WebRTC across different networks is not reliable without STUN/TURN.
- Without any signaling channel, peers cannot discover each other’s offers/answers.
- To satisfy “no server,” the only workable options are:
  - Manual signaling (copy/paste) which does not scale and is poor UX.
  - A user-provided signaling transport (e.g., QR/NFC/nearby share) that still requires an out-of-band exchange.
- For real-world, internet-wide reliability:
  - STUN is needed for NAT traversal.
  - TURN is required for restrictive NATs or firewalls.

### Open Decisions
- Confirm whether “no server” prohibits third-party STUN/TURN services.
- Decide acceptable signaling approach (manual vs. user-provided vs. minimal hosted).
- Define target reliability constraints (LAN-only vs. internet-wide).

### Next Actions
- Add architectural decisions and rationale here as they are made.
- Keep updates concise and tied to concrete changes in the repo.
