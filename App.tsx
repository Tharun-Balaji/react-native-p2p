import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Button,
  PermissionsAndroid,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { RTCPeerConnection, RTCView, mediaDevices } from "react-native-webrtc";
import { describePacket, extractConnectionHints, isExpired, makeId, nowIso, sanitizeDisplayName } from "./src/p2pCore";

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const STATE_FILE = "p2p-client-state.json";
const FILE_CHUNK_SIZE = 16 * 1024;
const MAX_BUFFERED_AMOUNT = 1_000_000;
const PACKET_TTL_MS = 10 * 60 * 1000;

type MediaMode = "audio" | "video";
type ConnectionLabel =
  | "idle"
  | "nearby discovered"
  | "connecting"
  | "connected direct"
  | "failed direct"
  | "reconnect needed";
type CallState =
  | "idle"
  | "incoming-voice"
  | "incoming-video"
  | "in-call-voice"
  | "in-call-video";
type DeliveryStatus = "pending" | "sent" | "received" | "failed";
type TransferStatus = "pending" | "in-progress" | "completed" | "failed" | "canceled";

type UserProfile = {
  id: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
};

type ConnectionHints = {
  lanIps: string[];
  publicEndpoint?: string;
  lastSuccessfulRoute?: "lan" | "direct-wan";
  iceCandidates?: string[];
  updatedAt: string;
};

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

type ChatMessage = {
  id: string;
  peerId: string;
  direction: "incoming" | "outgoing";
  body: string;
  deliveryStatus: DeliveryStatus;
  createdAt: string;
};

type TransferRecord = {
  id: string;
  peerId: string;
  fileName: string;
  sizeBytes: number;
  direction: "incoming" | "outgoing";
  status: TransferStatus;
  savedPath?: string;
  createdAt: string;
  updatedAt: string;
};

type CapabilityFlags = {
  chat: true;
  voice: boolean;
  video: boolean;
  fileTransfer: boolean;
};

type NearbyCodePayload = {
  kind: "nearby-code";
  version: 1;
  peerId: string;
  displayName: string;
  capabilities: CapabilityFlags;
  connectionHints: ConnectionHints;
  timestamp: string;
};

type RemoteSharePacket = {
  kind: "remote-share-packet";
  version: 1;
  peerId: string;
  displayName: string;
  capabilities: CapabilityFlags;
  connectionHints: ConnectionHints;
  timestamp: string;
  bootstrapSession: {
    sessionId: string;
    descriptionType: "offer" | "answer" | "connect-request";
    mediaMode: MediaMode;
    sdp?: any;
    expiresAt: string;
  };
};

type AppData = {
  profile: UserProfile | null;
  selfConnectionHints: ConnectionHints;
  peers: PeerRecord[];
  messages: ChatMessage[];
  transfers: TransferRecord[];
};

type PendingIncomingFile = {
  transferId: string;
  peerId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  totalChunks: number;
};

type IncomingFileState = {
  transferId: string;
  peerId: string;
  name: string;
  mimeType: string;
  size: number;
  totalChunks: number;
  chunks: string[];
  receivedChunks: number;
};

type OutgoingTransferState = {
  transferId: string;
  peerId: string;
  name: string;
  mimeType: string;
  size: number;
  base64Data: string;
};

const EMPTY_HINTS: ConnectionHints = {
  lanIps: [],
  iceCandidates: [],
  updatedAt: new Date(0).toISOString(),
};

const EMPTY_DATA: AppData = {
  profile: null,
  selfConnectionHints: EMPTY_HINTS,
  peers: [],
  messages: [],
  transfers: [],
};

async function loadAppData(): Promise<AppData> {
  const basePath = FileSystem.documentDirectory ?? FileSystem.cacheDirectory;
  if (!basePath) return EMPTY_DATA;
  const uri = `${basePath}${STATE_FILE}`;

  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return EMPTY_DATA;
    const raw = await FileSystem.readAsStringAsync(uri);
    const parsed = JSON.parse(raw);
    return {
      profile: parsed.profile ?? null,
      selfConnectionHints: parsed.selfConnectionHints ?? EMPTY_HINTS,
      peers: Array.isArray(parsed.peers) ? parsed.peers : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      transfers: Array.isArray(parsed.transfers) ? parsed.transfers : [],
    };
  } catch {
    return EMPTY_DATA;
  }
}

async function saveAppData(data: AppData): Promise<void> {
  const basePath = FileSystem.documentDirectory ?? FileSystem.cacheDirectory;
  if (!basePath) return;
  await FileSystem.writeAsStringAsync(`${basePath}${STATE_FILE}`, JSON.stringify(data, null, 2));
}

async function waitForIceGatheringComplete(pc: any): Promise<void> {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const onState = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", onState);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onState);
  });
}

async function waitForDataChannelDrain(channel: any): Promise<void> {
  while (channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

export default function App() {
  const pcRef = useRef<any>(null);
  const channelRef = useRef<any>(null);
  const localStreamRef = useRef<any>(null);
  const remoteStreamRef = useRef<any>(null);
  const incomingFilesRef = useRef<Record<string, IncomingFileState>>({});
  const outgoingTransfersRef = useRef<Record<string, OutgoingTransferState>>({});
  const loadedRef = useRef(false);

  const [isHydrating, setIsHydrating] = useState(true);
  const [appData, setAppData] = useState<AppData>(EMPTY_DATA);
  const [profileDraft, setProfileDraft] = useState("");
  const [selectedPeerId, setSelectedPeerId] = useState("");
  const [sharePayload, setSharePayload] = useState("");
  const [importPayload, setImportPayload] = useState("");
  const [outgoingMessage, setOutgoingMessage] = useState("");
  const [statusDetail, setStatusDetail] = useState("Create a local profile to begin pairing.");
  const [connectionLabel, setConnectionLabel] = useState<ConnectionLabel>("idle");
  const [sessionMediaMode, setSessionMediaMode] = useState<MediaMode>("audio");
  const [audioStatus, setAudioStatus] = useState("Mic not started");
  const [callState, setCallState] = useState<CallState>("idle");
  const [incomingOfferPacket, setIncomingOfferPacket] = useState<RemoteSharePacket | null>(null);
  const [pendingIncomingFile, setPendingIncomingFile] = useState<PendingIncomingFile | null>(null);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const [remotePreviewUrl, setRemotePreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    void (async () => {
      const data = await loadAppData();
      if (!mounted) return;
      setAppData(data);
      setProfileDraft(data.profile?.displayName ?? "");
      setSelectedPeerId(data.peers[0]?.peerId ?? "");
      loadedRef.current = true;
      setIsHydrating(false);
    })();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!loadedRef.current) return;
    void saveAppData(appData);
  }, [appData]);

  const selectedPeer = useMemo(
    () => appData.peers.find((peer) => peer.peerId === selectedPeerId) ?? null,
    [appData.peers, selectedPeerId],
  );

  const selectedMessages = useMemo(
    () => appData.messages.filter((message) => message.peerId === selectedPeerId),
    [appData.messages, selectedPeerId],
  );

  const selectedTransfers = useMemo(
    () => appData.transfers.filter((transfer) => transfer.peerId === selectedPeerId),
    [appData.transfers, selectedPeerId],
  );

  const persistPeer = useCallback((peer: PeerRecord) => {
    setAppData((current) => {
      const existingIndex = current.peers.findIndex((item) => item.peerId === peer.peerId);
      const nextPeers = [...current.peers];
      if (existingIndex >= 0) {
        nextPeers[existingIndex] = {
          ...nextPeers[existingIndex],
          ...peer,
          updatedAt: nowIso(),
        };
      } else {
        nextPeers.unshift(peer);
      }
      return { ...current, peers: nextPeers };
    });
    setSelectedPeerId(peer.peerId);
  }, []);

  const upsertPeerFromPacket = useCallback(
    (peerId: string, displayName: string, connectionHints: ConnectionHints) => {
      const existing = appData.peers.find((peer) => peer.peerId === peerId);
      const timestamp = nowIso();
      const peer: PeerRecord = existing
        ? {
            ...existing,
            displayName,
            connectionHints,
            trustState: "paired",
            lastSeenAt: timestamp,
            updatedAt: timestamp,
          }
        : {
            peerId,
            displayName,
            trustState: "paired",
            connectionHints,
            lastSeenAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
      persistPeer(peer);
      return peer;
    },
    [appData.peers, persistPeer],
  );

  const appendMessage = useCallback((message: ChatMessage) => {
    setAppData((current) => ({
      ...current,
      messages: [...current.messages, message],
    }));
  }, []);

  const upsertTransfer = useCallback((transfer: TransferRecord) => {
    setAppData((current) => {
      const existingIndex = current.transfers.findIndex((item) => item.id === transfer.id);
      const nextTransfers = [...current.transfers];
      if (existingIndex >= 0) {
        nextTransfers[existingIndex] = transfer;
      } else {
        nextTransfers.unshift(transfer);
      }
      return { ...current, transfers: nextTransfers };
    });
  }, []);

  const updateSelfHints = useCallback((hints: ConnectionHints) => {
    setAppData((current) => ({
      ...current,
      selfConnectionHints: hints,
    }));
  }, []);

  const resetTransientSessionState = useCallback(() => {
    setSharePayload("");
    setImportPayload("");
    setIncomingOfferPacket(null);
    setPendingIncomingFile(null);
    setCallState("idle");
    setRemotePreviewUrl(null);
  }, []);

  const stopLocalMedia = useCallback(() => {
    try {
      localStreamRef.current?.getTracks()?.forEach((track: any) => track.stop());
      remoteStreamRef.current?.getTracks?.()?.forEach((track: any) => track.stop());
    } catch {
      // no-op
    }
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    setLocalPreviewUrl(null);
    setRemotePreviewUrl(null);
    setAudioStatus("Mic not started");
  }, []);

  const destroyConnection = useCallback(
    (nextLabel: ConnectionLabel = "idle", detail = "Ready for a new direct session.") => {
      try {
        channelRef.current?.close?.();
        pcRef.current?.close?.();
      } catch {
        // no-op
      }
      incomingFilesRef.current = {};
      outgoingTransfersRef.current = {};
      channelRef.current = null;
      pcRef.current = null;
      stopLocalMedia();
      setConnectionLabel(nextLabel);
      setStatusDetail(detail);
      setCallState("idle");
      setPendingIncomingFile(null);
    },
    [stopLocalMedia],
  );

  useEffect(() => destroyConnection, [destroyConnection]);

  const ensurePermissions = useCallback(async (includeVideo: boolean) => {
    if (Platform.OS !== "android") return;

    const permissions = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
    if (includeVideo) {
      permissions.push(PermissionsAndroid.PERMISSIONS.CAMERA);
    }

    const result = await PermissionsAndroid.requestMultiple(permissions);
    const denied = permissions.find(
      (permission) => result[permission] !== PermissionsAndroid.RESULTS.GRANTED,
    );

    if (denied) {
      throw new Error(
        includeVideo ? "Camera or microphone permission denied." : "Microphone permission denied.",
      );
    }
  }, []);

  const ensureLocalStream = useCallback(
    async (mediaMode: MediaMode) => {
      const needsVideo = mediaMode === "video";
      const currentHasVideo = Boolean(
        localStreamRef.current?.getVideoTracks?.()?.some((track: any) => track.enabled !== false),
      );

      if (localStreamRef.current && (!needsVideo || currentHasVideo)) {
        return localStreamRef.current;
      }

      try {
        localStreamRef.current?.getTracks?.()?.forEach((track: any) => track.stop());
      } catch {
        // no-op
      }

      await ensurePermissions(needsVideo);
      const stream = await mediaDevices.getUserMedia({
        audio: true,
        video: needsVideo,
      });

      localStreamRef.current = stream;
      setLocalPreviewUrl(needsVideo ? stream.toURL() : null);
      setAudioStatus(needsVideo ? "Mic and camera active" : "Mic active");
      return stream;
    },
    [ensurePermissions],
  );

  const updatePeerConnectionHints = useCallback((peerId: string, hints: ConnectionHints, connected = false) => {
    setAppData((current) => ({
      ...current,
      peers: current.peers.map((peer) =>
        peer.peerId === peerId
          ? {
              ...peer,
              connectionHints: hints,
              lastSeenAt: nowIso(),
              lastConnectedAt: connected ? nowIso() : peer.lastConnectedAt,
              updatedAt: nowIso(),
            }
          : peer,
      ),
    }));
  }, []);

  const sendEnvelope = useCallback(
    (type: string, payload: Record<string, unknown>, peerId: string) => {
      if (!channelRef.current || channelRef.current.readyState !== "open") {
        setStatusDetail("The direct data channel is not open yet.");
        return false;
      }

      channelRef.current.send(
        JSON.stringify({
          version: 1,
          type,
          peerId,
          timestamp: nowIso(),
          payload,
        }),
      );
      return true;
    },
    [],
  );

  const saveIncomingFile = useCallback(
    async (fileId: string) => {
      const fileState = incomingFilesRef.current[fileId];
      if (!fileState) return;
      if (fileState.receivedChunks !== fileState.totalChunks) {
        setStatusDetail(`File incomplete (${fileState.receivedChunks}/${fileState.totalChunks} chunks).`);
        upsertTransfer({
          id: fileState.transferId,
          peerId: fileState.peerId,
          fileName: fileState.name,
          sizeBytes: fileState.size,
          direction: "incoming",
          status: "failed",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
        return;
      }

      const basePath = FileSystem.documentDirectory ?? FileSystem.cacheDirectory;
      if (!basePath) {
        setStatusDetail("No writable app directory available.");
        return;
      }

      const safeName = fileState.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const outputUri = `${basePath}${Date.now()}-${safeName}`;
      const combinedBase64 = fileState.chunks.join("");

      await FileSystem.writeAsStringAsync(outputUri, combinedBase64, {
        encoding: FileSystem.EncodingType.Base64,
      });

      upsertTransfer({
        id: fileState.transferId,
        peerId: fileState.peerId,
        fileName: fileState.name,
        sizeBytes: fileState.size,
        direction: "incoming",
        status: "completed",
        savedPath: outputUri,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      setStatusDetail(`Received file: ${safeName}`);
      delete incomingFilesRef.current[fileId];
    },
    [upsertTransfer],
  );

  const startOutgoingTransfer = useCallback(
    async (transferId: string) => {
      const transfer = outgoingTransfersRef.current[transferId];
      if (!transfer) return;
      if (
        !sendEnvelope(
          "file-meta",
          {
            transferId,
            fileName: transfer.name,
            mimeType: transfer.mimeType,
            sizeBytes: transfer.size,
            totalChunks: Math.ceil(transfer.base64Data.length / FILE_CHUNK_SIZE),
          },
          transfer.peerId,
        )
      ) {
        return;
      }

      upsertTransfer({
        id: transferId,
        peerId: transfer.peerId,
        fileName: transfer.name,
        sizeBytes: transfer.size,
        direction: "outgoing",
        status: "in-progress",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });

      const totalChunks = Math.ceil(transfer.base64Data.length / FILE_CHUNK_SIZE);
      for (let index = 0; index < totalChunks; index += 1) {
        const start = index * FILE_CHUNK_SIZE;
        const end = start + FILE_CHUNK_SIZE;
        const data = transfer.base64Data.slice(start, end);
        await waitForDataChannelDrain(channelRef.current);
        sendEnvelope(
          "file-chunk",
          {
            transferId,
            chunkIndex: index,
            base64Data: data,
          },
          transfer.peerId,
        );
        if ((index + 1) % 20 === 0 || index + 1 === totalChunks) {
          setStatusDetail(`Sending ${transfer.name}: ${index + 1}/${totalChunks}`);
        }
      }

      sendEnvelope("file-complete", { transferId }, transfer.peerId);
      upsertTransfer({
        id: transferId,
        peerId: transfer.peerId,
        fileName: transfer.name,
        sizeBytes: transfer.size,
        direction: "outgoing",
        status: "completed",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      setStatusDetail(`File sent: ${transfer.name}`);
      delete outgoingTransfersRef.current[transferId];
    },
    [sendEnvelope, upsertTransfer],
  );

  const handleChannelMessage = useCallback(
    async (rawPayload: string, peerId: string) => {
      let parsed: any;
      try {
        parsed = JSON.parse(rawPayload);
      } catch {
        appendMessage({
          id: makeId("msg"),
          peerId,
          direction: "incoming",
          body: rawPayload,
          deliveryStatus: "received",
          createdAt: nowIso(),
        });
        return;
      }

      const type = parsed?.type;
      const payload = parsed?.payload ?? parsed;

      if (type === "chat" && typeof payload?.text === "string") {
        appendMessage({
          id: payload.messageId ?? makeId("msg"),
          peerId,
          direction: "incoming",
          body: payload.text,
          deliveryStatus: "received",
          createdAt: nowIso(),
        });
        return;
      }

      if (type === "call-control") {
        const action = payload?.action as string | undefined;
        if (action === "offer-voice") {
          setCallState("incoming-voice");
          setStatusDetail("Incoming voice call request.");
        } else if (action === "offer-video") {
          setCallState("incoming-video");
          setStatusDetail("Incoming video call request.");
        } else if (action === "accept") {
          setCallState(sessionMediaMode === "video" ? "in-call-video" : "in-call-voice");
          setStatusDetail("Peer accepted the call.");
        } else if (action === "reject") {
          setCallState("idle");
          setStatusDetail("Peer rejected the call.");
        } else if (action === "end") {
          setCallState("idle");
          setStatusDetail("Peer ended the call.");
        }
        return;
      }

      if (type === "file-offer") {
        setPendingIncomingFile({
          transferId: payload.transferId,
          peerId,
          name: payload.fileName,
          mimeType: payload.mimeType,
          sizeBytes: payload.sizeBytes,
          totalChunks: payload.totalChunks,
        });
        upsertTransfer({
          id: payload.transferId,
          peerId,
          fileName: payload.fileName,
          sizeBytes: payload.sizeBytes,
          direction: "incoming",
          status: "pending",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
        setStatusDetail(`Incoming file offer: ${payload.fileName}`);
        return;
      }

      if (type === "file-accept") {
        await startOutgoingTransfer(payload.transferId);
        return;
      }

      if (type === "file-meta") {
        incomingFilesRef.current[payload.transferId] = {
          transferId: payload.transferId,
          peerId,
          name: payload.fileName,
          mimeType: payload.mimeType ?? "application/octet-stream",
          size: payload.sizeBytes ?? 0,
          totalChunks: payload.totalChunks,
          chunks: new Array(payload.totalChunks),
          receivedChunks: 0,
        };
        upsertTransfer({
          id: payload.transferId,
          peerId,
          fileName: payload.fileName,
          sizeBytes: payload.sizeBytes ?? 0,
          direction: "incoming",
          status: "in-progress",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
        return;
      }

      if (type === "file-chunk") {
        const fileState = incomingFilesRef.current[payload.transferId];
        if (!fileState) return;
        if (!fileState.chunks[payload.chunkIndex]) {
          fileState.receivedChunks += 1;
        }
        fileState.chunks[payload.chunkIndex] = payload.base64Data;
        if (fileState.receivedChunks % 20 === 0) {
          setStatusDetail(`Receiving ${fileState.name}: ${fileState.receivedChunks}/${fileState.totalChunks}`);
        }
        return;
      }

      if (type === "file-complete") {
        try {
          await saveIncomingFile(payload.transferId);
        } catch (error) {
          setStatusDetail(`Failed to save incoming file: ${String(error)}`);
        }
        return;
      }

      if (type === "file-cancel") {
        setPendingIncomingFile(null);
        delete incomingFilesRef.current[payload.transferId];
        setStatusDetail(`Transfer canceled: ${payload.reason}`);
      }
    },
    [appendMessage, saveIncomingFile, sessionMediaMode, startOutgoingTransfer, upsertTransfer],
  );

  const attachDataChannelHandlers = useCallback(
    (channel: any, peerId: string) => {
      channelRef.current = channel;
      channel.onopen = () => {
        setConnectionLabel("connected direct");
        setStatusDetail(`Direct channel open with ${selectedPeer?.displayName ?? peerId}.`);
      };
      channel.onclose = () => {
        setConnectionLabel("reconnect needed");
        setStatusDetail("Direct channel closed. Share a fresh packet to reconnect.");
      };
      channel.onmessage = (event: any) => {
        void handleChannelMessage(String(event.data), peerId);
      };
    },
    [handleChannelMessage, selectedPeer?.displayName],
  );

  const createPeerConnection = useCallback(
    async (peerId: string, mediaMode: MediaMode) => {
      destroyConnection("connecting", "Preparing direct session...");
      setSessionMediaMode(mediaMode);

      const pc: any = new RTCPeerConnection(rtcConfig);
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === "connected") {
          setConnectionLabel("connected direct");
          setStatusDetail("Direct connection established.");
          updatePeerConnectionHints(
            peerId,
            { ...appData.selfConnectionHints, lastSuccessfulRoute: "direct-wan", updatedAt: nowIso() },
            true,
          );
        } else if (state === "connecting" || state === "new") {
          setConnectionLabel("connecting");
          setStatusDetail("Trying direct routes...");
        } else if (state === "disconnected") {
          setConnectionLabel("reconnect needed");
          setStatusDetail("Direct link dropped. Share a fresh packet to reconnect.");
        } else if (state === "failed") {
          setConnectionLabel("failed direct");
          setStatusDetail("Direct connection failed. This network may block peer-to-peer traffic.");
        } else if (state === "closed") {
          setConnectionLabel("idle");
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed") {
          setConnectionLabel("failed direct");
          setStatusDetail("ICE timed out. Ask for a fresh nearby code or remote share packet.");
        }
      };
      pc.ondatachannel = (event: any) => attachDataChannelHandlers(event.channel, peerId);
      pc.ontrack = (event: any) => {
        const stream = event.streams?.[0];
        if (stream) {
          remoteStreamRef.current = stream;
          setRemotePreviewUrl(stream.toURL());
          setAudioStatus(event.track?.kind === "video" ? "Remote video connected" : "Remote audio connected");
        }
      };

      const stream = await ensureLocalStream(mediaMode);
      stream.getTracks().forEach((track: any) => {
        pc.addTrack(track, stream);
      });

      pcRef.current = pc;
      return pc;
    },
    [appData.selfConnectionHints, attachDataChannelHandlers, destroyConnection, ensureLocalStream, updatePeerConnectionHints],
  );

  const buildNearbyCode = useCallback((): NearbyCodePayload | null => {
    if (!appData.profile) {
      setStatusDetail("Create a local profile first.");
      return null;
    }

    return {
      kind: "nearby-code",
      version: 1,
      peerId: appData.profile.id,
      displayName: appData.profile.displayName,
      capabilities: {
        chat: true,
        voice: true,
        video: true,
        fileTransfer: true,
      },
      connectionHints: appData.selfConnectionHints,
      timestamp: nowIso(),
    };
  }, [appData.profile, appData.selfConnectionHints]);

  const shareTextPayload = useCallback(async () => {
    if (!sharePayload.trim()) {
      setStatusDetail("Create a nearby code or remote share packet first.");
      return;
    }

    await Share.share({ message: sharePayload });
  }, [sharePayload]);

  const handleSaveProfile = useCallback(() => {
    const timestamp = nowIso();
    const nextProfile: UserProfile = appData.profile
      ? {
          ...appData.profile,
          displayName: sanitizeDisplayName(profileDraft),
          updatedAt: timestamp,
        }
      : {
          id: makeId("peer"),
          displayName: sanitizeDisplayName(profileDraft),
          createdAt: timestamp,
          updatedAt: timestamp,
        };

    setAppData((current) => ({
      ...current,
      profile: nextProfile,
    }));
    setProfileDraft(nextProfile.displayName);
    setStatusDetail("Local identity saved on this device.");
  }, [appData.profile, profileDraft]);

  const handlePrepareNearbyCode = useCallback(() => {
    const nearbyCode = buildNearbyCode();
    if (!nearbyCode) return;
    setSharePayload(JSON.stringify(nearbyCode, null, 2));
    setConnectionLabel("nearby discovered");
    setStatusDetail(
      "Nearby pairing payload prepared. Render this as a QR with a QR view later or share it directly now.",
    );
  }, [buildNearbyCode]);

  const createOfferPacket = useCallback(
    async (mediaMode: MediaMode) => {
      if (!selectedPeer || !appData.profile) {
        setStatusDetail("Select a peer before creating a remote share packet.");
        return;
      }

      try {
        const pc = await createPeerConnection(selectedPeer.peerId, mediaMode);
        const channel = pc.createDataChannel("p2p-chat-files");
        attachDataChannelHandlers(channel, selectedPeer.peerId);

        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: mediaMode === "video",
        });
        await pc.setLocalDescription(offer);
        await waitForIceGatheringComplete(pc);

        const hints = extractConnectionHints(pc.localDescription?.sdp, "direct-wan");
        updateSelfHints(hints);
        const packet: RemoteSharePacket = {
          kind: "remote-share-packet",
          version: 1,
          peerId: appData.profile.id,
          displayName: appData.profile.displayName,
          capabilities: {
            chat: true,
            voice: true,
            video: true,
            fileTransfer: true,
          },
          connectionHints: hints,
          timestamp: nowIso(),
          bootstrapSession: {
            sessionId: makeId("session"),
            descriptionType: "offer",
            mediaMode,
            sdp: pc.localDescription,
            expiresAt: new Date(Date.now() + PACKET_TTL_MS).toISOString(),
          },
        };
        setSharePayload(JSON.stringify(packet, null, 2));
        setConnectionLabel("connecting");
        setStatusDetail(`Offer packet ready for ${selectedPeer.displayName}. Share it over any external channel.`);
      } catch (error) {
        setConnectionLabel("failed direct");
        setStatusDetail(`Failed to create offer packet: ${String(error)}`);
      }
    },
    [appData.profile, attachDataChannelHandlers, createPeerConnection, selectedPeer, updateSelfHints],
  );

  const answerIncomingOffer = useCallback(async () => {
    if (!incomingOfferPacket || !appData.profile) {
      setStatusDetail("Import an offer packet first.");
      return;
    }

    if (isExpired(incomingOfferPacket.bootstrapSession.expiresAt)) {
      setIncomingOfferPacket(null);
      setConnectionLabel("failed direct");
      setStatusDetail("That packet expired. Ask your peer for a fresh packet.");
      return;
    }

    try {
      const peer = upsertPeerFromPacket(
        incomingOfferPacket.peerId,
        incomingOfferPacket.displayName,
        incomingOfferPacket.connectionHints,
      );
      const pc = await createPeerConnection(peer.peerId, incomingOfferPacket.bootstrapSession.mediaMode);
      await pc.setRemoteDescription(incomingOfferPacket.bootstrapSession.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGatheringComplete(pc);

      const hints = extractConnectionHints(pc.localDescription?.sdp, "direct-wan");
      updateSelfHints(hints);
      updatePeerConnectionHints(peer.peerId, incomingOfferPacket.connectionHints, false);

      const packet: RemoteSharePacket = {
        kind: "remote-share-packet",
        version: 1,
        peerId: appData.profile.id,
        displayName: appData.profile.displayName,
        capabilities: {
          chat: true,
          voice: true,
          video: true,
          fileTransfer: true,
        },
        connectionHints: hints,
        timestamp: nowIso(),
        bootstrapSession: {
          sessionId: incomingOfferPacket.bootstrapSession.sessionId,
          descriptionType: "answer",
          mediaMode: incomingOfferPacket.bootstrapSession.mediaMode,
          sdp: pc.localDescription,
          expiresAt: new Date(Date.now() + PACKET_TTL_MS).toISOString(),
        },
      };

      setSharePayload(JSON.stringify(packet, null, 2));
      setConnectionLabel("connecting");
      setStatusDetail(`Answer packet ready for ${peer.displayName}. Share it back to finish the direct handshake.`);
      setIncomingOfferPacket(null);
    } catch (error) {
      setConnectionLabel("failed direct");
      setStatusDetail(`Failed to answer packet: ${String(error)}`);
    }
  }, [appData.profile, createPeerConnection, incomingOfferPacket, updatePeerConnectionHints, updateSelfHints, upsertPeerFromPacket]);

  const applyAnswerPacket = useCallback(async (packet: RemoteSharePacket) => {
    try {
      if (!pcRef.current) {
        setStatusDetail("Create an offer packet first.");
        return;
      }
      if (packet.bootstrapSession.descriptionType !== "answer") {
        setStatusDetail("Imported packet is not an answer.");
        return;
      }
      if (isExpired(packet.bootstrapSession.expiresAt)) {
        setConnectionLabel("failed direct");
        setStatusDetail("The imported answer packet expired.");
        return;
      }

      await pcRef.current.setRemoteDescription(packet.bootstrapSession.sdp);
      updatePeerConnectionHints(packet.peerId, packet.connectionHints, true);
      setConnectionLabel("connecting");
      setStatusDetail(`Answer applied for ${packet.displayName}. Waiting for the direct route to finish connecting.`);
    } catch (error) {
      setConnectionLabel("failed direct");
      setStatusDetail(`Failed to apply answer packet: ${String(error)}`);
    }
  }, [updatePeerConnectionHints]);

  const handleImportPayload = useCallback(async () => {
    try {
      const parsed = JSON.parse(importPayload);

      if (parsed?.kind === "nearby-code") {
        const payload = parsed as NearbyCodePayload;
        upsertPeerFromPacket(payload.peerId, payload.displayName, payload.connectionHints);
        setConnectionLabel("nearby discovered");
        setStatusDetail(`Nearby peer added: ${payload.displayName}`);
        return;
      }

      if (parsed?.kind === "remote-share-packet") {
        const packet = parsed as RemoteSharePacket;
        const peer = upsertPeerFromPacket(packet.peerId, packet.displayName, packet.connectionHints);
        setStatusDetail(describePacket(packet));

        if (packet.bootstrapSession.descriptionType === "offer") {
          setIncomingOfferPacket(packet);
          setConnectionLabel("connecting");
          setSessionMediaMode(packet.bootstrapSession.mediaMode);
        } else if (packet.bootstrapSession.descriptionType === "answer") {
          await applyAnswerPacket(packet);
        } else {
          setConnectionLabel("connecting");
          setStatusDetail(`Connect request imported for ${peer.displayName}. Ask them for an offer packet.`);
        }
        return;
      }

      setStatusDetail("Payload format not recognized.");
    } catch (error) {
      setConnectionLabel("failed direct");
      setStatusDetail(`Could not import payload: ${String(error)}`);
    }
  }, [applyAnswerPacket, importPayload, upsertPeerFromPacket]);

  const sendMessage = useCallback(() => {
    if (!selectedPeer) {
      setStatusDetail("Select a peer first.");
      return;
    }
    const text = outgoingMessage.trim();
    if (!text) return;
    const messageId = makeId("msg");
    const success = sendEnvelope("chat", { messageId, text }, selectedPeer.peerId);
    appendMessage({
      id: messageId,
      peerId: selectedPeer.peerId,
      direction: "outgoing",
      body: text,
      deliveryStatus: success ? "sent" : "failed",
      createdAt: nowIso(),
    });
    setOutgoingMessage("");
  }, [appendMessage, outgoingMessage, selectedPeer, sendEnvelope]);

  const pickAndOfferFile = useCallback(async () => {
    if (!selectedPeer) {
      setStatusDetail("Select a peer before sending a file.");
      return;
    }
    if (!channelRef.current || channelRef.current.readyState !== "open") {
      setStatusDetail("Connect directly before sending a file.");
      return;
    }

    try {
      const picked = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled || !picked.assets.length) {
        setStatusDetail("File selection canceled.");
        return;
      }

      const asset = picked.assets[0];
      const base64Data = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const transferId = makeId("transfer");
      const totalChunks = Math.ceil(base64Data.length / FILE_CHUNK_SIZE);
      outgoingTransfersRef.current[transferId] = {
        transferId,
        peerId: selectedPeer.peerId,
        name: asset.name,
        mimeType: asset.mimeType ?? "application/octet-stream",
        size: asset.size ?? 0,
        base64Data,
      };

      upsertTransfer({
        id: transferId,
        peerId: selectedPeer.peerId,
        fileName: asset.name,
        sizeBytes: asset.size ?? 0,
        direction: "outgoing",
        status: "pending",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });

      sendEnvelope(
        "file-offer",
        {
          transferId,
          fileName: asset.name,
          mimeType: asset.mimeType ?? "application/octet-stream",
          sizeBytes: asset.size ?? 0,
          totalChunks,
        },
        selectedPeer.peerId,
      );
      setStatusDetail(`File offer sent for ${asset.name}. Waiting for peer acceptance.`);
    } catch (error) {
      setStatusDetail(`File send failed: ${String(error)}`);
    }
  }, [selectedPeer, sendEnvelope, upsertTransfer]);

  const acceptIncomingFile = useCallback(() => {
    if (!pendingIncomingFile) return;
    sendEnvelope("file-accept", { transferId: pendingIncomingFile.transferId }, pendingIncomingFile.peerId);
    setStatusDetail(`Accepted ${pendingIncomingFile.name}. Waiting for chunks...`);
    setPendingIncomingFile(null);
  }, [pendingIncomingFile, sendEnvelope]);

  const declineIncomingFile = useCallback(() => {
    if (!pendingIncomingFile) return;
    sendEnvelope(
      "file-cancel",
      {
        transferId: pendingIncomingFile.transferId,
        reason: "receiver-declined",
      },
      pendingIncomingFile.peerId,
    );
    upsertTransfer({
      id: pendingIncomingFile.transferId,
      peerId: pendingIncomingFile.peerId,
      fileName: pendingIncomingFile.name,
      sizeBytes: pendingIncomingFile.sizeBytes,
      direction: "incoming",
      status: "canceled",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    setStatusDetail(`Declined ${pendingIncomingFile.name}.`);
    setPendingIncomingFile(null);
  }, [pendingIncomingFile, sendEnvelope, upsertTransfer]);

  const sendCallAction = useCallback(
    (action: string) => {
      if (!selectedPeer) return;
      if (!sendEnvelope("call-control", { callId: makeId("call"), action }, selectedPeer.peerId)) {
        return;
      }
      if (action === "offer-voice") {
        setStatusDetail("Voice call request sent.");
      } else if (action === "offer-video") {
        setStatusDetail("Video call request sent. If video is not active yet, reconnect using a video offer packet.");
      } else if (action === "accept") {
        setCallState(sessionMediaMode === "video" ? "in-call-video" : "in-call-voice");
        setStatusDetail("Call accepted.");
      } else if (action === "reject" || action === "end") {
        setCallState("idle");
        setStatusDetail(action === "reject" ? "Call rejected." : "Call ended.");
      }
    },
    [selectedPeer, sendEnvelope, sessionMediaMode],
  );

  const clearSelectedHistory = useCallback(() => {
    if (!selectedPeerId) return;
    setAppData((current) => ({
      ...current,
      messages: current.messages.filter((message) => message.peerId !== selectedPeerId),
      transfers: current.transfers.filter((transfer) => transfer.peerId !== selectedPeerId),
    }));
    setStatusDetail("Cleared local history for the selected peer.");
  }, [selectedPeerId]);

  if (isHydrating) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color="#0f766e" />
          <Text style={styles.loadingText}>Loading local P2P workspace...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title} accessibilityRole="header">
          Local-First P2P Client
        </Text>
        <Text style={styles.subtitle}>
          Direct-only chat, calls, and file sharing. All durable data stays on-device.
        </Text>

        <View style={styles.statusCard}>
          <Text style={styles.statusLabel}>Connection state</Text>
          <Text style={styles.statusValue}>{connectionLabel}</Text>
          <Text style={styles.statusDetail}>{statusDetail}</Text>
          <Text style={styles.audioStatus}>{audioStatus}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>My identity</Text>
          <TextInput
            style={styles.input}
            value={profileDraft}
            onChangeText={setProfileDraft}
            placeholder="Choose a display name"
            placeholderTextColor="#6b7280"
          />
          <Button
            title={appData.profile ? "Save display name" : "Create local profile"}
            onPress={handleSaveProfile}
          />
          {appData.profile ? (
            <Text style={styles.helper}>Peer ID: {appData.profile.id}</Text>
          ) : (
            <Text style={styles.helper}>Create a local identity before pairing with anyone.</Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Nearby pairing</Text>
          <Text style={styles.helper}>
            This build prepares a QR-ready nearby payload as text. With a QR renderer and scanner dependency,
            this same payload can be shown as a QR code and scanned by a nearby peer.
          </Text>
          <View style={styles.buttonRow}>
            <Button title="Prepare nearby code" onPress={handlePrepareNearbyCode} />
            <Button title="Share payload" onPress={() => void shareTextPayload()} />
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Known peers</Text>
          {appData.peers.length === 0 ? (
            <Text style={styles.helper}>Import a nearby code or remote share packet to create your first peer thread.</Text>
          ) : (
            appData.peers.map((peer) => (
              <View key={peer.peerId} style={[styles.peerRow, selectedPeerId === peer.peerId && styles.peerRowActive]}>
                <View style={styles.peerTextWrap}>
                  <Text style={styles.peerName}>{peer.displayName}</Text>
                  <Text style={styles.peerMeta}>
                    {peer.lastConnectedAt ? `Last connected ${peer.lastConnectedAt}` : "Not connected yet"}
                  </Text>
                </View>
                <Button title="Open" onPress={() => setSelectedPeerId(peer.peerId)} />
              </View>
            ))
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Import nearby code or remote share packet</Text>
          <TextInput
            style={styles.payloadInput}
            multiline
            value={importPayload}
            onChangeText={setImportPayload}
            placeholder="Paste a nearby code or remote share packet here..."
            placeholderTextColor="#6b7280"
          />
          <Button title="Import payload" onPress={() => void handleImportPayload()} />
          {incomingOfferPacket ? (
            <View style={styles.pendingBox}>
              <Text style={styles.pendingTitle}>Incoming offer ready to answer</Text>
              <Text style={styles.helper}>{describePacket(incomingOfferPacket)}</Text>
              <Button
                title={`Answer ${incomingOfferPacket.bootstrapSession.mediaMode} offer`}
                onPress={() => void answerIncomingOffer()}
              />
            </View>
          ) : null}
        </View>

        {selectedPeer ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Peer thread: {selectedPeer.displayName}</Text>
            <Text style={styles.helper}>
              Use nearby pairing when you are physically together. Use remote share packets when you are apart.
            </Text>
            <View style={styles.buttonGrid}>
              <Button title="Create voice offer" onPress={() => void createOfferPacket("audio")} />
              <Button title="Create video offer" onPress={() => void createOfferPacket("video")} />
              <Button title="Clear local history" onPress={clearSelectedHistory} color="#b45309" />
              <Button
                title="Reset session"
                onPress={() => {
                  destroyConnection();
                  resetTransientSessionState();
                }}
                color="#b91c1c"
              />
            </View>

            <Text style={styles.label}>Current share payload</Text>
            <TextInput
              style={styles.payloadInput}
              multiline
              value={sharePayload}
              editable={false}
              placeholder="Nearby code or remote share packet will appear here..."
              placeholderTextColor="#6b7280"
            />

            <View style={styles.buttonRow}>
              <Button title="Share current payload" onPress={() => void shareTextPayload()} />
              <Button title="Copy-ready nearby code" onPress={handlePrepareNearbyCode} />
            </View>

            <Text style={styles.label}>Session tools</Text>
            <View style={styles.buttonGrid}>
              <Button title="Ring voice call" onPress={() => sendCallAction("offer-voice")} />
              <Button title="Ring video call" onPress={() => sendCallAction("offer-video")} />
              <Button title="Accept call" onPress={() => sendCallAction("accept")} />
              <Button title="End call" onPress={() => sendCallAction("end")} color="#b91c1c" />
            </View>
            <Text style={styles.helper}>Call state: {callState}</Text>

            <Text style={styles.label}>Chat</Text>
            <View style={styles.row}>
              <TextInput
                style={styles.messageInput}
                value={outgoingMessage}
                onChangeText={setOutgoingMessage}
                placeholder="Type a direct message..."
                placeholderTextColor="#6b7280"
                returnKeyType="send"
                onSubmitEditing={sendMessage}
              />
              <Button title="Send" onPress={sendMessage} />
            </View>

            <Text style={styles.label}>Media preview</Text>
            <View style={styles.previewGrid}>
              <View style={styles.previewCard}>
                <Text style={styles.previewLabel}>Local</Text>
                {localPreviewUrl ? (
                  <RTCView streamURL={localPreviewUrl} style={styles.preview} objectFit="cover" />
                ) : (
                  <Text style={styles.helper}>No local video</Text>
                )}
              </View>
              <View style={styles.previewCard}>
                <Text style={styles.previewLabel}>Remote</Text>
                {remotePreviewUrl ? (
                  <RTCView streamURL={remotePreviewUrl} style={styles.preview} objectFit="cover" />
                ) : (
                  <Text style={styles.helper}>No remote video</Text>
                )}
              </View>
            </View>

            <Text style={styles.label}>File sharing</Text>
            <Button title="Pick and offer file" onPress={() => void pickAndOfferFile()} />
            {pendingIncomingFile ? (
              <View style={styles.pendingBox}>
                <Text style={styles.pendingTitle}>Incoming file</Text>
                <Text style={styles.helper}>
                  {pendingIncomingFile.name} ({Math.round(pendingIncomingFile.sizeBytes / 1024)} KB)
                </Text>
                <View style={styles.buttonRow}>
                  <Button title="Accept and save" onPress={acceptIncomingFile} />
                  <Button title="Decline" onPress={declineIncomingFile} color="#b91c1c" />
                </View>
              </View>
            ) : null}

            <Text style={styles.label}>Chat history</Text>
            <View style={styles.logBox}>
              {selectedMessages.length === 0 ? (
                <Text style={styles.logLine}>No messages yet.</Text>
              ) : (
                selectedMessages.map((message) => (
                  <Text key={message.id} style={styles.logLine}>
                    {message.direction === "outgoing" ? "Me" : selectedPeer.displayName}: {message.body} [{message.deliveryStatus}]
                  </Text>
                ))
              )}
            </View>

            <Text style={styles.label}>Transfer history</Text>
            <View style={styles.logBox}>
              {selectedTransfers.length === 0 ? (
                <Text style={styles.logLine}>No transfers yet.</Text>
              ) : (
                selectedTransfers.map((transfer) => (
                  <Text key={transfer.id} style={styles.logLine}>
                    {transfer.direction === "outgoing" ? "Sent" : "Received"} {transfer.fileName} [{transfer.status}]
                  </Text>
                ))
              )}
            </View>
          </View>
        ) : null}
      </ScrollView>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#ecfeff" },
  content: { padding: 16, gap: 14, paddingBottom: 36 },
  loadingWrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { color: "#134e4a", fontSize: 16 },
  title: { fontSize: 28, fontWeight: "800", color: "#0f172a" },
  subtitle: { color: "#155e75", fontSize: 14, lineHeight: 20 },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: "#a5f3fc",
    gap: 12,
  },
  statusCard: {
    backgroundColor: "#0f766e",
    borderRadius: 18,
    padding: 16,
    gap: 6,
  },
  statusLabel: { color: "#99f6e4", fontSize: 12, textTransform: "uppercase", letterSpacing: 1 },
  statusValue: { color: "#f0fdfa", fontSize: 22, fontWeight: "800" },
  statusDetail: { color: "#ccfbf1", fontSize: 14, lineHeight: 20 },
  audioStatus: { color: "#99f6e4", fontSize: 13 },
  sectionTitle: { fontSize: 18, fontWeight: "700", color: "#0f172a" },
  label: { fontSize: 14, fontWeight: "700", color: "#164e63" },
  helper: { color: "#475569", fontSize: 13, lineHeight: 18 },
  input: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: "#f8fafc",
    color: "#0f172a",
  },
  payloadInput: {
    minHeight: 140,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 14,
    padding: 12,
    backgroundColor: "#f8fafc",
    color: "#0f172a",
    textAlignVertical: "top",
    fontSize: 12,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  buttonRow: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  buttonGrid: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  messageInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: "#f8fafc",
    color: "#0f172a",
  },
  peerRow: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 14,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  peerRowActive: { borderColor: "#0f766e", backgroundColor: "#f0fdfa" },
  peerTextWrap: { flex: 1, gap: 4 },
  peerName: { fontSize: 15, fontWeight: "700", color: "#0f172a" },
  peerMeta: { fontSize: 12, color: "#64748b" },
  pendingBox: {
    borderWidth: 1,
    borderColor: "#67e8f9",
    backgroundColor: "#ecfeff",
    borderRadius: 14,
    padding: 12,
    gap: 10,
  },
  pendingTitle: { fontSize: 15, fontWeight: "700", color: "#155e75" },
  logBox: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 14,
    backgroundColor: "#f8fafc",
    minHeight: 100,
    padding: 12,
    gap: 6,
  },
  logLine: { color: "#0f172a", fontSize: 13, lineHeight: 18 },
  previewGrid: { flexDirection: "row", gap: 10 },
  previewCard: {
    flex: 1,
    minHeight: 180,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 14,
    backgroundColor: "#e2e8f0",
    padding: 10,
    gap: 10,
  },
  previewLabel: { fontWeight: "700", color: "#0f172a" },
  preview: { flex: 1, borderRadius: 10, backgroundColor: "#0f172a" },
});
