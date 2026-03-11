import assert from "node:assert/strict";

import {
  describePacket,
  extractConnectionHints,
  isExpired,
  makeId,
  sanitizeDisplayName,
} from "../src/p2pCore";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("sanitizeDisplayName trims input and falls back for blanks", () => {
  assert.equal(sanitizeDisplayName("  Alice  "), "Alice");
  assert.equal(sanitizeDisplayName("   "), "Local User");
});

run("makeId prefixes generated identifiers", () => {
  const id = makeId("peer");
  assert.match(id, /^peer-/);
});

run("isExpired detects stale and fresh timestamps", () => {
  assert.equal(isExpired(new Date(Date.now() - 1_000).toISOString()), true);
  assert.equal(isExpired(new Date(Date.now() + 60_000).toISOString()), false);
});

run("extractConnectionHints keeps candidate lines and public srflx endpoint", () => {
  const sdp = [
    "v=0",
    "a=candidate:1 1 udp 2122260223 192.168.1.44 54400 typ host",
    "a=candidate:2 1 udp 1686052607 203.0.113.15 62000 typ srflx raddr 192.168.1.44 rport 54400",
    "a=candidate:3 1 udp 2122260223 10.0.0.15 59999 typ host",
  ].join("\r\n");

  const hints = extractConnectionHints(sdp, "direct-wan");

  assert.equal(hints.lastSuccessfulRoute, "direct-wan");
  assert.equal(hints.publicEndpoint, "203.0.113.15:62000");
  assert.equal(hints.iceCandidates?.length, 3);
  assert.ok(hints.updatedAt);
});

run("extractConnectionHints returns empty defaults without SDP", () => {
  const hints = extractConnectionHints(undefined, "lan");

  assert.deepEqual(hints.lanIps, []);
  assert.deepEqual(hints.iceCandidates, []);
  assert.equal(hints.lastSuccessfulRoute, "lan");
});

run("describePacket summarizes offer and answer packets", () => {
  const offerText = describePacket({
    displayName: "Priya",
    bootstrapSession: {
      descriptionType: "offer",
      mediaMode: "video",
    },
  });
  const answerText = describePacket({
    displayName: "Arun",
    bootstrapSession: {
      descriptionType: "answer",
      mediaMode: "audio",
    },
  });

  assert.equal(offerText, "Priya is requesting a video session.");
  assert.equal(answerText, "Arun sent a answer packet.");
});

console.log("All p2pCore tests passed.");
