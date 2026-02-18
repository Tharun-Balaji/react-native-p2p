import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  RTCPeerConnection,
} from "react-native-webrtc";

const rtcConfig = {
  // Public STUN helps peers discover reachable network addresses.
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
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

export default function App() {
  // Refs hold the active WebRTC objects across renders.
  const pcRef = useRef<any>(null);
  const channelRef = useRef<any>(null);

  // Signaling payloads and chat UI state.
  const [remotePayload, setRemotePayload] = useState("");
  const [localPayload, setLocalPayload] = useState("");
  const [outgoingMessage, setOutgoingMessage] = useState("");
  const [chatLog, setChatLog] = useState<string[]>([]);
  const [status, setStatus] = useState("Idle");

  const appendLog = useCallback((line: string) => {
    setChatLog((current) => [...current, line]);
  }, []);

  const destroyConnection = useCallback(() => {
    // Always close previous objects before creating new ones to avoid leaks.
    try {
      channelRef.current?.close();
      pcRef.current?.close();
    } catch {
      // no-op
    }
    channelRef.current = null;
    pcRef.current = null;
    setStatus("Idle");
  }, []);

  useEffect(() => destroyConnection, [destroyConnection]);

  const attachDataChannelHandlers = useCallback(
    (channel: any) => {
      // Either side can own a data channel; handlers are shared.
      channelRef.current = channel;
      channel.onopen = () => setStatus("Connected");
      channel.onclose = () => setStatus("Channel Closed");
      channel.onmessage = (event: any) => appendLog(`Peer: ${String(event.data)}`);
    },
    [appendLog],
  );

  const createPeerConnection = useCallback(() => {
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

    pcRef.current = pc;
    return pc;
  }, [appendLog, attachDataChannelHandlers, destroyConnection]);

  const createOffer = useCallback(async () => {
    try {
      setStatus("Creating offer...");
      const pc = createPeerConnection();
      // Offer side proactively creates the data channel.
      const channel = pc.createDataChannel("p2p-chat");
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

      const pc = createPeerConnection();
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
    channelRef.current.send(outgoingMessage);
    appendLog(`Me: ${outgoingMessage}`);
    setOutgoingMessage("");
  }, [appendLog, outgoingMessage]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>React Native P2P WebRTC</Text>
        <Text style={styles.status}>{status}</Text>

        <View style={styles.buttons}>
          <Button title="1) Create Offer" onPress={createOffer} />
          <Button title="2) Create Answer" onPress={createAnswer} />
          <Button title="3) Apply Answer" onPress={applyRemoteAnswer} />
          <Button title="Reset" onPress={destroyConnection} color="#B00020" />
        </View>

        <Text style={styles.label}>Local Payload (share this)</Text>
        <TextInput
          style={styles.payloadInput}
          multiline
          value={localPayload}
          editable={false}
          placeholder="Your offer/answer JSON will appear here..."
        />

        <Text style={styles.label}>Remote Payload (paste peer JSON)</Text>
        <TextInput
          style={styles.payloadInput}
          multiline
          value={remotePayload}
          onChangeText={setRemotePayload}
          placeholder="Paste peer offer/answer JSON here..."
        />

        <Text style={styles.label}>P2P Chat</Text>
        <View style={styles.row}>
          <TextInput
            style={styles.messageInput}
            value={outgoingMessage}
            onChangeText={setOutgoingMessage}
            placeholder="Type a message..."
          />
          <Button title="Send" onPress={sendMessage} />
        </View>

        <View style={styles.logBox}>
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
          This demo uses manual signaling. For production, replace copy/paste
          with a signaling channel (WebSocket/Firebase/etc.).
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
  status: { fontSize: 14, color: "#344054", marginBottom: 8 },
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
    minHeight: 120,
    padding: 10,
    gap: 4,
  },
  logLine: { color: "#101828" },
  note: { fontSize: 12, color: "#475467" },
});
