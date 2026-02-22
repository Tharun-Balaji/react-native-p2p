import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { RTCPeerConnection, mediaDevices } from "react-native-webrtc";

const rtcConfig = {
  // Public STUN helps peers discover reachable network addresses.
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const FILE_CHUNK_SIZE = 16 * 1024;
const MAX_BUFFERED_AMOUNT = 1_000_000;

type IncomingFileState = {
  name: string;
  mimeType: string;
  size: number;
  totalChunks: number;
  chunks: string[];
  receivedChunks: number;
};

function waitForIceGatheringComplete(pc: any): Promise<void> {
  // Manual signaling is simplest when we wait until all candidates are bundled
  // into localDescription before sharing the payload.
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
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
  // Backpressure loop: pause sends until buffered data drops under threshold.
  while (channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

export default function App() {
  // Refs hold active WebRTC and media objects across renders.
  const pcRef = useRef<any>(null);
  const channelRef = useRef<any>(null);
  const localStreamRef = useRef<any>(null);
  const incomingFilesRef = useRef<Record<string, IncomingFileState>>({});

  // Signaling payloads and chat UI state.
  const [remotePayload, setRemotePayload] = useState("");
  const [localPayload, setLocalPayload] = useState("");
  const [outgoingMessage, setOutgoingMessage] = useState("");
  const [chatLog, setChatLog] = useState<string[]>([]);
  const [status, setStatus] = useState("Idle");
  const [audioStatus, setAudioStatus] = useState("Mic not started");

  const appendLog = useCallback((line: string) => {
    setChatLog((current) => [...current, line]);
  }, []);

  const saveIncomingFile = useCallback(
    async (fileId: string) => {
      const fileState = incomingFilesRef.current[fileId];
      if (!fileState) return;

      if (fileState.receivedChunks !== fileState.totalChunks) {
        setStatus(
          `File incomplete (${fileState.receivedChunks}/${fileState.totalChunks} chunks).`,
        );
        return;
      }

      const basePath = FileSystem.documentDirectory ?? FileSystem.cacheDirectory;
      if (!basePath) {
        setStatus("No writable app directory available.");
        return;
      }

      const safeName = fileState.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const outputUri = `${basePath}${Date.now()}-${safeName}`;
      // Reassemble base64 payload in original chunk order before saving.
      const combinedBase64 = fileState.chunks.join("");

      await FileSystem.writeAsStringAsync(outputUri, combinedBase64, {
        encoding: FileSystem.EncodingType.Base64,
      });

      appendLog(`Peer file saved: ${safeName}`);
      appendLog(`Saved at: ${outputUri}`);
      setStatus(`Received file: ${safeName}`);
      delete incomingFilesRef.current[fileId];
    },
    [appendLog],
  );

  const handleChannelMessage = useCallback(
    async (rawPayload: string) => {
      let parsed: any;
      try {
        parsed = JSON.parse(rawPayload);
      } catch {
        // Backward compatibility: plain text is treated as chat.
        appendLog(`Peer: ${rawPayload}`);
        return;
      }

      if (parsed?.type === "chat" && typeof parsed.text === "string") {
        appendLog(`Peer: ${parsed.text}`);
        return;
      }

      if (parsed?.type === "file-meta") {
        const {
          fileId,
          name,
          mimeType,
          size,
          totalChunks,
        }: {
          fileId?: string;
          name?: string;
          mimeType?: string;
          size?: number;
          totalChunks?: number;
        } = parsed;

        if (!fileId || !name || !totalChunks) {
          setStatus("Invalid file metadata received.");
          return;
        }

        incomingFilesRef.current[fileId] = {
          name,
          mimeType: mimeType ?? "application/octet-stream",
          size: size ?? 0,
          // Pre-size array so chunks can be inserted by index out of order.
          totalChunks,
          chunks: new Array(totalChunks),
          receivedChunks: 0,
        };

        appendLog(`Receiving file: ${name} (${Math.round((size ?? 0) / 1024)} KB)`);
        return;
      }

      if (parsed?.type === "file-chunk") {
        const {
          fileId,
          index,
          data,
        }: {
          fileId?: string;
          index?: number;
          data?: string;
        } = parsed;

        if (!fileId || typeof index !== "number" || typeof data !== "string") {
          return;
        }

        const fileState = incomingFilesRef.current[fileId];
        if (!fileState || index < 0 || index >= fileState.totalChunks) {
          return;
        }

        if (!fileState.chunks[index]) {
          fileState.receivedChunks += 1;
        }
        fileState.chunks[index] = data;

        if (fileState.receivedChunks % 25 === 0) {
          setStatus(
            `Receiving ${fileState.name}: ${fileState.receivedChunks}/${fileState.totalChunks}`,
          );
        }
        return;
      }

      if (parsed?.type === "file-end") {
        const fileId = parsed.fileId as string | undefined;
        if (!fileId) return;

        try {
          // Finalize write only after sender explicitly marks transfer complete.
          await saveIncomingFile(fileId);
        } catch (error) {
          setStatus(`Failed to save incoming file: ${String(error)}`);
        }
      }
    },
    [appendLog, saveIncomingFile],
  );

  const stopLocalAudio = useCallback(() => {
    try {
      localStreamRef.current?.getTracks()?.forEach((track: any) => track.stop());
    } catch {
      // no-op
    }
    localStreamRef.current = null;
    setAudioStatus("Mic stopped");
  }, []);

  const destroyConnection = useCallback(() => {
    // Always close previous objects before creating new ones to avoid leaks.
    try {
      channelRef.current?.close();
      pcRef.current?.close();
      stopLocalAudio();
    } catch {
      // no-op
    }
    incomingFilesRef.current = {};
    channelRef.current = null;
    pcRef.current = null;
    setStatus("Idle");
  }, [stopLocalAudio]);

  useEffect(() => destroyConnection, [destroyConnection]);

  const ensureLocalAudioStream = useCallback(async () => {
    if (localStreamRef.current) {
      return localStreamRef.current;
    }

    if (Platform.OS === "android") {
      const permission = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      );
      if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
        throw new Error("Microphone permission denied.");
      }
    }

    // Audio-only capture keeps this demo focused on talking + file transfer.
    const localStream = await mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });

    localStreamRef.current = localStream;
    setAudioStatus("Mic active");
    return localStream;
  }, []);

  const attachDataChannelHandlers = useCallback(
    (channel: any) => {
      // Either side can own a data channel; handlers are shared.
      channelRef.current = channel;
      channel.onopen = () => setStatus("Connected");
      channel.onclose = () => setStatus("Channel Closed");
      channel.onmessage = (event: any) => {
        void handleChannelMessage(String(event.data));
      };
    },
    [handleChannelMessage],
  );

  const createPeerConnection = useCallback(async () => {
    destroyConnection();

    // Use `any` because react-native-webrtc typings miss some event handlers
    // that exist and work at runtime.
    const pc: any = new RTCPeerConnection(rtcConfig);
    pc.onconnectionstatechange = () =>
      setStatus(`Connection: ${pc.connectionState}`);
    pc.oniceconnectionstatechange = () =>
      setStatus(`ICE: ${pc.iceConnectionState}`);
    pc.ondatachannel = (event: any) => {
      attachDataChannelHandlers(event.channel);
      appendLog("Data channel received");
    };
    pc.ontrack = (event: any) => {
      if (event.track?.kind === "audio") {
        setAudioStatus("Remote audio track connected");
      }
    };

    const localStream = await ensureLocalAudioStream();
    localStream.getTracks().forEach((track: any) => {
      pc.addTrack(track, localStream);
    });

    pcRef.current = pc;
    return pc;
  }, [appendLog, attachDataChannelHandlers, destroyConnection, ensureLocalAudioStream]);

  const createOffer = useCallback(async () => {
    try {
      setStatus("Creating offer...");
      const pc = await createPeerConnection();
      // Offer side proactively creates the data channel.
      const channel = pc.createDataChannel("p2p-chat-files");
      attachDataChannelHandlers(channel);

      // Generate and set local SDP, then wait for ICE candidate gathering.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);

      setLocalPayload(
        JSON.stringify({ type: "offer", sdp: pc.localDescription }, null, 2),
      );
      setStatus("Offer ready. Share it with peer.");
    } catch (error) {
      setStatus(`Offer failed: ${String(error)}`);
    }
  }, [attachDataChannelHandlers, createPeerConnection]);

  const createAnswer = useCallback(async () => {
    try {
      if (!remotePayload.trim()) {
        setStatus("Paste remote offer first.");
        return;
      }

      setStatus("Creating answer...");
      // Expect a JSON payload previously copied from the offer peer.
      const parsed = JSON.parse(remotePayload);
      if (parsed.type !== "offer" || !parsed.sdp) {
        setStatus("Remote payload must be an offer.");
        return;
      }

      const pc = await createPeerConnection();
      // Apply remote offer, then produce the answer.
      await pc.setRemoteDescription(parsed.sdp);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGatheringComplete(pc);

      setLocalPayload(
        JSON.stringify({ type: "answer", sdp: pc.localDescription }, null, 2),
      );
      setStatus("Answer ready. Share it with peer.");
    } catch (error) {
      setStatus(`Answer failed: ${String(error)}`);
    }
  }, [createPeerConnection, remotePayload]);

  const applyRemoteAnswer = useCallback(async () => {
    try {
      if (!pcRef.current) {
        setStatus("Create offer first.");
        return;
      }
      // Offer side applies answer to complete SDP negotiation.
      const parsed = JSON.parse(remotePayload);
      if (parsed.type !== "answer" || !parsed.sdp) {
        setStatus("Remote payload must be an answer.");
        return;
      }
      await pcRef.current.setRemoteDescription(parsed.sdp);
      setStatus("Answer applied. Waiting for connection...");
    } catch (error) {
      setStatus(`Apply failed: ${String(error)}`);
    }
  }, [remotePayload]);

  const sendMessage = useCallback(() => {
    // Data channel messages are sent directly peer-to-peer after connect.
    if (!channelRef.current || channelRef.current.readyState !== "open") {
      setStatus("Data channel not open yet.");
      return;
    }
    if (!outgoingMessage.trim()) return;

    channelRef.current.send(
      JSON.stringify({ type: "chat", text: outgoingMessage.trim() }),
    );
    appendLog(`Me: ${outgoingMessage.trim()}`);
    setOutgoingMessage("");
  }, [appendLog, outgoingMessage]);

  const pickAndSendFile = useCallback(async () => {
    try {
      if (!channelRef.current || channelRef.current.readyState !== "open") {
        setStatus("Connect first before sending a file.");
        return;
      }

      const picked = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (picked.canceled || !picked.assets.length) {
        setStatus("File selection canceled.");
        return;
      }

      const asset = picked.assets[0];
      setStatus(`Reading ${asset.name}...`);

      // Base64 is easy to move over JSON in a cross-platform demo.
      const fileBase64 = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const totalChunks = Math.ceil(fileBase64.length / FILE_CHUNK_SIZE);
      // Time + random suffix is enough for demo-level unique transfer IDs.
      const fileId = `file-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      channelRef.current.send(
        JSON.stringify({
          type: "file-meta",
          fileId,
          name: asset.name,
          mimeType: asset.mimeType ?? "application/octet-stream",
          size: asset.size ?? 0,
          totalChunks,
        }),
      );

      for (let index = 0; index < totalChunks; index += 1) {
        const start = index * FILE_CHUNK_SIZE;
        const end = start + FILE_CHUNK_SIZE;
        const data = fileBase64.slice(start, end);

        // Guard against RTCDataChannel buffer growth on slower links/devices.
        await waitForDataChannelDrain(channelRef.current);
        channelRef.current.send(
          JSON.stringify({
            type: "file-chunk",
            fileId,
            index,
            data,
          }),
        );

        if ((index + 1) % 25 === 0 || index + 1 === totalChunks) {
          setStatus(`Sending ${asset.name}: ${index + 1}/${totalChunks}`);
        }
      }

      channelRef.current.send(JSON.stringify({ type: "file-end", fileId }));
      appendLog(`Me sent file: ${asset.name}`);
      setStatus(`File sent: ${asset.name}`);
    } catch (error) {
      setStatus(`File send failed: ${String(error)}`);
    }
  }, [appendLog]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title} accessibilityRole="header">
          React Native P2P WebRTC
        </Text>
        <Text style={styles.status} accessibilityLiveRegion="polite">
          {status}
        </Text>
        <Text style={styles.audioStatus} accessibilityLiveRegion="polite">
          {audioStatus}
        </Text>

        <View style={styles.buttons}>
          <Button
            title="1) Create Offer"
            onPress={createOffer}
            accessibilityLabel="Create offer"
          />
          <Button
            title="2) Create Answer"
            onPress={createAnswer}
            accessibilityLabel="Create answer"
          />
          <Button
            title="3) Apply Answer"
            onPress={applyRemoteAnswer}
            accessibilityLabel="Apply answer"
          />
          <Button
            title="Reset"
            onPress={destroyConnection}
            color="#B00020"
            accessibilityLabel="Reset connection"
          />
        </View>

        <Text style={styles.label}>Local Payload (share this)</Text>
        <TextInput
          style={styles.payloadInput}
          multiline
          value={localPayload}
          editable={false}
          placeholder="Your offer/answer JSON will appear here..."
          placeholderTextColor="#667085"
          accessibilityLabel="Local payload"
          accessibilityHint="Read-only JSON payload to share with your peer"
          accessibilityState={{ disabled: true }}
        />

        <Text style={styles.label}>Remote Payload (paste peer JSON)</Text>
        <TextInput
          style={styles.payloadInput}
          multiline
          value={remotePayload}
          onChangeText={setRemotePayload}
          placeholder="Paste peer offer/answer JSON here..."
          placeholderTextColor="#667085"
          accessibilityLabel="Remote payload"
          accessibilityHint="Paste your peer offer or answer JSON"
        />

        <Text style={styles.label}>P2P Chat + File Transfer</Text>
        <View style={styles.row}>
          <TextInput
            style={styles.messageInput}
            value={outgoingMessage}
            onChangeText={setOutgoingMessage}
            placeholder="Type a message..."
            placeholderTextColor="#667085"
            accessibilityLabel="Chat message"
            accessibilityHint="Type a chat message to send to your peer"
            returnKeyType="send"
            onSubmitEditing={sendMessage}
          />
          <Button
            title="Send"
            onPress={sendMessage}
            accessibilityLabel="Send message"
          />
        </View>

        <Button
          title="Pick and Send File"
          onPress={pickAndSendFile}
          accessibilityLabel="Pick and send file"
        />

        <View
          style={styles.logBox}
          accessibilityRole="summary"
          accessibilityLabel="Chat and transfer activity log"
        >
          {chatLog.length === 0 ? (
            <Text style={styles.logLine}>No messages yet.</Text>
          ) : (
            chatLog.map((line, index) => (
              <Text key={`${line}-${index}`} style={styles.logLine}>
                {line}
              </Text>
            ))
          )}
        </View>

        <Text style={styles.note}>
          {/* Signaling is done manually in this prototype. */}
          This demo uses manual signaling and local file save paths. Keep test files
          small while prototyping because base64 chunk transfer is memory heavy.
        </Text>
      </ScrollView>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#f5f7fb" },
  content: { padding: 16, gap: 12 },
  title: { fontSize: 22, fontWeight: "700", color: "#101828" },
  status: { fontSize: 14, color: "#344054" },
  audioStatus: { fontSize: 13, color: "#475467", marginBottom: 8 },
  buttons: { gap: 8 },
  label: { fontSize: 14, fontWeight: "600", color: "#101828" },
  payloadInput: {
    minHeight: 110,
    borderWidth: 1,
    borderColor: "#d0d5dd",
    borderRadius: 10,
    padding: 12,
    backgroundColor: "white",
    textAlignVertical: "top",
    fontSize: 12,
  },
  row: { flexDirection: "row", gap: 10, alignItems: "center" },
  messageInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#d0d5dd",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "white",
  },
  logBox: {
    borderWidth: 1,
    borderColor: "#d0d5dd",
    borderRadius: 10,
    backgroundColor: "white",
    minHeight: 140,
    padding: 10,
    gap: 4,
  },
  logLine: { color: "#101828" },
  note: { fontSize: 12, color: "#475467" },
});
