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
    // (A) 第一次收到 host 訊息 → 標記 ready 並廣播一次
    if (!hostReady) {
      hostReady = true;
      broadcast({ type: "host-ready", text: "native host is ready (first message seen)" });
    }
    // (B) 照舊透傳 host 的訊息給所有 popup（可選）
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

  // 一連上先回一個狀態（沒有就 alive，有就 ready）
  port.postMessage({
    type: hostReady ? "host-ready" : "status",
    text: hostReady ? "native host is ready" : "background-alive (native not connected)"
  });

  port.onMessage.addListener((msg) => {
    if (!msg) return;

    if (msg.type === "ensure-native") {
      ensureNativePort();
      // 如果此時已經 ready，就立即告訴 popup
      if (hostReady) {
        port.postMessage({ type: "host-ready", text: "native host is ready" });
      } else {
        port.postMessage({ type: "status", text: "connecting native host..." });
      }
      return;
    }

    if (msg.type === "audio" && typeof msg.base64 === "string") {
      // 不論 hostReady 與否都嘗試送；成功後 host 可能回訊息 → 將觸發 hostReady
      const np = ensureNativePort();
      try {
        np.postMessage({ audioChunk: msg.base64 });
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