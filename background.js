let nativePort = null;
let hostReady = false;          // become true on first host message
const popupPorts = new Set();

function broadcast(msg) {
  for (const p of popupPorts) {
    try { p.postMessage(msg); } catch {}
  }
}

function ensureNativePort() {
  if (nativePort) return nativePort;

  nativePort = chrome.runtime.connectNative("com.example.chrome_whisper_transcriber");

  nativePort.onMessage.addListener((msg) => {
    if (!hostReady) {
      hostReady = true;
      broadcast({ type: "host-ready", text: "native host is ready (first message seen)" });
    }
    if (msg?.type || msg?.text) {
      broadcast({ type: msg.type || "status", text: msg.text ?? JSON.stringify(msg) });
    }
  });

  nativePort.onDisconnect.addListener(() => {
    broadcast({ type: "error", text: "Native host disconnected" });
    nativePort = null;
    hostReady = false;
  });

  return nativePort;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup-bridge") return;
  popupPorts.add(port);


  port.postMessage({
    type: hostReady ? "host-ready" : "status",
    text: hostReady ? "native host is ready" : "background-alive (native not connected)"
  });

  port.onMessage.addListener((msg) => {
    if (!msg) return;

    if (msg.type === "ensure-native") {
      ensureNativePort();

      if (hostReady) {
        port.postMessage({ type: "host-ready", text: "native host is ready" });
      } else {
        port.postMessage({ type: "status", text: "connecting native host..." });
      }
      return;
    }

    if (msg.type === "audio" && typeof msg.base64 === "string") {
      const np = ensureNativePort();
      try {
        np.postMessage({ audioChunk: msg.base64, tabTitle: msg.tabTitle });
        port.postMessage({ type: "status", text: "Audio forwarded to native host" });
      } catch (e) {
        port.postMessage({ type: "error", text: "Forwarding failed: " + (e?.message || e) });
      }
      return;
    }
  });

  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
  });
});
