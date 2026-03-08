export type ConnectionHints = {
  lanIps: string[];
  publicEndpoint?: string;
  lastSuccessfulRoute?: "lan" | "direct-wan";
  iceCandidates?: string[];
  updatedAt: string;
};

export type MediaMode = "audio" | "video";

export type RemoteSharePacketLike = {
  displayName: string;
  bootstrapSession: {
    descriptionType: "offer" | "answer" | "connect-request";
    mediaMode: MediaMode;
  };
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function sanitizeDisplayName(name: string): string {
  const trimmed = name.trim();
  return trimmed || "Local User";
}

export function isExpired(isoTimestamp: string): boolean {
  return Date.parse(isoTimestamp) < Date.now();
}

export function extractConnectionHints(
  sdpText?: string,
  route?: "lan" | "direct-wan",
): ConnectionHints {
  if (!sdpText) {
    return {
      lanIps: [],
      iceCandidates: [],
      lastSuccessfulRoute: route,
      updatedAt: nowIso(),
    };
  }

  const candidates = sdpText
    .split(/\r?\n/)
    .filter((line) => line.startsWith("a=candidate:"))
    .slice(0, 12);
  let publicEndpoint: string | undefined;

  for (const line of candidates) {
    if (line.includes(" typ srflx ")) {
      const parts = line.split(" ");
      if (parts.length >= 6) {
        publicEndpoint = `${parts[4]}:${parts[5]}`;
        break;
      }
    }
  }

  return {
    lanIps: [],
    publicEndpoint,
    lastSuccessfulRoute: route,
    iceCandidates: candidates,
    updatedAt: nowIso(),
  };
}

export function describePacket(packet: RemoteSharePacketLike): string {
  return packet.bootstrapSession.descriptionType === "offer"
    ? `${packet.displayName} is requesting a ${packet.bootstrapSession.mediaMode} session.`
    : `${packet.displayName} sent a ${packet.bootstrapSession.descriptionType} packet.`;
}
