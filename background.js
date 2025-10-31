import { MESSAGE_TYPES } from "./message-types.js";

const OFFSCREEN_URL = "offscreen.html";

let nativePort = null;
let hostReady = false; // becomes true on first host message
const popupPorts = new Set();
const audioRequestMap = new Map();

const BADGE = {
  idle: {
    text: "",
    color: "#777777",
    title: "Whisper Transcriber: Idle (Press Alt+E to start recording)",
  },
  connecting: {
    text: "...",
    color: "#777777",
    title: "Connecting to native host...",
  },
  ready: {
    text: "ON",
    color: "#2ECC71",
    title: "Native host ready (Press Alt+E to start recording)",
  },
  recording: {
    text: "REC",
    color: "#D9534F",
    title: "Recording (Press Alt+E to stop and send audio)",
  },
  error: {
    text: "!",
    color: "#D9534F",
    title: "Native host not connected. Please start it before retrying.",
  },
};

const recordingState = {
  status: "idle", // idle | starting | recording
  tabId: null,
  streamId: null,
  tabTitle: null,
};

let offscreenReady = false;
let offscreenReadyResolver = null;

function setBadge(state) {
  const config = BADGE[state] || BADGE.idle;
  chrome.action.setBadgeText({ text: config.text });
  chrome.action.setBadgeBackgroundColor({ color: config.color });
  chrome.action.setTitle({ title: config.title });
}

setBadge("idle");

function broadcast(msg) {
  for (const port of popupPorts) {
    try {
      port.postMessage(msg);
    } catch (_) {
      // ignore disconnected ports
    }
  }
}

function buildRecordingStatusMessage() {
  return {
    type: MESSAGE_TYPES.RECORDING_STATUS,
    status: recordingState.status,
    tabId: recordingState.tabId,
    tabTitle: recordingState.tabTitle,
  };
}

function broadcastRecordingStatus() {
  broadcast(buildRecordingStatusMessage());
}

function sendRecordingStatus(port) {
  if (!port) return;
  try {
    port.postMessage(buildRecordingStatusMessage());
  } catch (_) {
    // ignore send failures
  }
}

function ensureNativePort() {
  if (nativePort) return nativePort;

  try {
    nativePort = chrome.runtime.connectNative("com.example.chrome_whisper_transcriber");
    if (recordingState.status !== "recording") {
      setBadge("connecting");
    }
  } catch (err) {
    nativePort = null;
    broadcast({ type: MESSAGE_TYPES.ERROR, text: "Failed to connect native host: " + (err?.message || err) });
    setBadge("error");
    return null;
  }

  nativePort.onMessage.addListener((msg) => {
    if (msg?.type === MESSAGE_TYPES.AUDIO_FILE || msg?.type === MESSAGE_TYPES.AUDIO_FILE_ERROR) {
      const requestId = msg?.requestId || null;
      const pending = requestId ? audioRequestMap.get(requestId) : null;
      if (pending?.port) {
        try {
          pending.port.postMessage(msg);
        } catch (_) {
          // ignore send failure
        }
      } else {
        // fallback to broadcast if no pending listener found
        broadcast(msg);
      }
      if (requestId) {
        audioRequestMap.delete(requestId);
      }
      return;
    }

    if (!hostReady) {
      hostReady = true;
      broadcast({ type: MESSAGE_TYPES.HOST_READY, text: "native host is ready (first message seen)" });
      if (recordingState.status === "recording") {
        setBadge("recording");
      } else {
        setBadge("ready");
      }
    }
    if (msg?.type || msg?.text) {
      const payload = { type: msg.type || MESSAGE_TYPES.STATUS, text: msg.text ?? JSON.stringify(msg) };
      if (msg.type === MESSAGE_TYPES.RESULT) {
        if (msg.savedPaths) {
          payload.savedPaths = msg.savedPaths;
        }
      }
      broadcast(payload);
    }
  });

  nativePort.onDisconnect.addListener(() => {
    broadcast({ type: MESSAGE_TYPES.ERROR, text: "Native host disconnected" });
    nativePort = null;
    hostReady = false;
    if (recordingState.status === "recording" || recordingState.status === "starting") {
      broadcast({ type: MESSAGE_TYPES.WARN, text: "Recording continued without native host connection." });
    }
    setBadge("idle");
  });

  return nativePort;
}

function resetRecordingState() {
  recordingState.status = "idle";
  recordingState.tabId = null;
  recordingState.streamId = null;
  recordingState.tabTitle = null;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error("Offscreen API is unavailable in this environment.");
  }
  const hasDocument = await chrome.offscreen.hasDocument();
  if (!hasDocument) {
    offscreenReady = false;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Record tab audio for transcription without UI.",
    });
  } else if (!offscreenReady) {
    // Document already exists from a previous session; assume it is ready to receive messages.
    offscreenReady = true;
    chrome.runtime
      .sendMessage({ source: "background", target: "offscreen", type: MESSAGE_TYPES.PING })
      .catch(() => {
        // If the offscreen page is not actually ready, wait for it to notify again.
        offscreenReady = false;
      });
  }
}

function waitForOffscreenReady() {
  if (offscreenReady) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    offscreenReadyResolver = resolve;
  });
}

async function forwardAudioToNative(base64Audio, tabTitle) {
  const np = ensureNativePort();
  if (!np) {
    broadcast({ type: MESSAGE_TYPES.ERROR, text: "Cannot forward audio: native host unavailable" });
    setBadge("error");
    return;
  }
  try {
    np.postMessage({ audioChunk: base64Audio, tabTitle: tabTitle || null });
    broadcast({ type: MESSAGE_TYPES.STATUS, text: "Audio forwarded to native host" });
  } catch (err) {
    broadcast({ type: MESSAGE_TYPES.ERROR, text: "Forwarding failed: " + (err?.message || err) });
  }
}

function openRecordingsFolder() {
  const np = ensureNativePort();
  if (!np) {
    broadcast({ type: MESSAGE_TYPES.ERROR, text: "Cannot open recordings folder: native host is not running." });
    setBadge("error");
    return;
  }
  try {
    np.postMessage({ command: "open-recordings-folder" });
    broadcast({ type: MESSAGE_TYPES.STATUS, text: "Attempting to open recordings folder..." });
  } catch (err) {
    broadcast({ type: MESSAGE_TYPES.ERROR, text: "Failed to open recordings folder: " + (err?.message || err) });
  }
}

function openSavedRecordingFolder(folderPath, port) {
  const path = typeof folderPath === "string" ? folderPath.trim() : "";
  const send = (message) => {
    if (!message) return;
    if (port) {
      try {
        port.postMessage(message);
      } catch (_) {
        // ignore send failures
      }
    } else {
      broadcast(message);
    }
  };

  if (!path) {
    send({ type: MESSAGE_TYPES.WARN, text: "Missing folder path for saved recording." });
    return;
  }

  const np = ensureNativePort();
  if (!np) {
    send({ type: MESSAGE_TYPES.ERROR, text: "Native host unavailable for opening saved folder." });
    setBadge("error");
    return;
  }

  try {
    np.postMessage({ command: "open-folder", path });
  } catch (err) {
    send({ type: MESSAGE_TYPES.ERROR, text: "Failed to open saved folder: " + (err?.message || err) });
  }
}

async function startRecordingFlow() {
  if (recordingState.status !== "idle") {
    broadcast({ type: MESSAGE_TYPES.WARN, text: "Recording already in progress." });
    return;
  }

  const native = ensureNativePort();
  if (!native) {
    throw new Error("Native host unavailable.");
  }

  if (!hostReady) {
    setBadge("connecting");
  }

  broadcast({ type: MESSAGE_TYPES.STATUS, text: "Preparing to record current tab audio..." });

  let activeTab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs?.[0] ?? null;
  } catch (err) {
    throw new Error("Cannot read active tab: " + (err?.message || err));
  }

  recordingState.tabId = activeTab?.id ?? null;
  recordingState.tabTitle = activeTab?.title || null;

  try {
    await ensureOffscreenDocument();
    await waitForOffscreenReady();
  } catch (err) {
    throw new Error("Cannot initialise offscreen recorder: " + (err?.message || err));
  }

  recordingState.status = "starting";
  broadcastRecordingStatus();

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: typeof recordingState.tabId === "number" ? recordingState.tabId : undefined,
    });
    recordingState.streamId = streamId;
  } catch (err) {
    resetRecordingState();
    broadcastRecordingStatus();
    throw new Error("Failed to obtain tab capture stream id: " + (err?.message || err));
  }

  try {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: MESSAGE_TYPES.START_RECORDING,
      tabId: recordingState.tabId,
      tabTitle: recordingState.tabTitle,
      streamId: recordingState.streamId,
    });
  } catch (err) {
    resetRecordingState();
    broadcastRecordingStatus();
    throw new Error("Failed to start offscreen recording: " + (err?.message || err));
  }
}

async function stopRecordingFlow() {
  if (recordingState.status === "idle") {
    broadcast({ type: MESSAGE_TYPES.WARN, text: "No active recording to stop." });
    return;
  }

  broadcast({ type: MESSAGE_TYPES.STATUS, text: "Stopping recording. Please wait..." });

  try {
    await ensureOffscreenDocument();
    await waitForOffscreenReady();
    await chrome.runtime.sendMessage({ target: "offscreen", type: MESSAGE_TYPES.STOP_RECORDING });
  } catch (err) {
    throw new Error("Failed to stop offscreen recording: " + (err?.message || err));
  }
}

function handleAsyncFailure(context, err) {
  const text = `${context}: ${err?.message || err}`;
  console.error(text);
  broadcast({ type: MESSAGE_TYPES.ERROR, text });
  if (recordingState.status !== "recording") {
    setBadge(hostReady ? "ready" : "error");
  } else {
    setBadge("error");
  }
  resetRecordingState();
  broadcastRecordingStatus();
}

function startRecording() {
  startRecordingFlow().catch((err) => handleAsyncFailure("Start recording failed", err));
}

function stopRecording() {
  stopRecordingFlow()
    .catch((err) => handleAsyncFailure("Stop recording failed", err));
}

function toggleRecording() {
  if (recordingState.status === "idle") {
    startRecording();
  } else {
    stopRecording();
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup-bridge") return;
  popupPorts.add(port);

  port.postMessage({
    type: hostReady ? MESSAGE_TYPES.HOST_READY : MESSAGE_TYPES.STATUS,
    text: hostReady ? "native host is ready" : "background-alive (native not connected)",
  });
  sendRecordingStatus(port);

  port.onMessage.addListener((msg) => {
    if (!msg) return;

    if (msg.type === MESSAGE_TYPES.ENSURE_NATIVE) {
      ensureNativePort();

      if (hostReady) {
        port.postMessage({ type: MESSAGE_TYPES.HOST_READY, text: "native host is ready" });
      } else {
        port.postMessage({ type: MESSAGE_TYPES.STATUS, text: "connecting native host..." });
      }
      return;
    }

    if (msg.type === MESSAGE_TYPES.START_RECORDING) {
      startRecording();
      return;
    }

    if (msg.type === MESSAGE_TYPES.STOP_RECORDING) {
      stopRecording();
      return;
    }

    if (msg.type === MESSAGE_TYPES.OPEN_RECORDINGS_FOLDER) {
      openRecordingsFolder();
      return;
    }

    if (msg.type === MESSAGE_TYPES.OPEN_SAVED_FOLDER) {
      openSavedRecordingFolder(msg.folderPath, port);
      return;
    }

    if (msg.type === MESSAGE_TYPES.REQUEST_AUDIO_PLAYBACK) {
      const { requestId, audioPath } = msg;
      if (typeof audioPath !== "string" || !audioPath) {
        port.postMessage({ type: MESSAGE_TYPES.ERROR, text: "Invalid audio path for playback request." });
        return;
      }

      const np = ensureNativePort();
      if (!np) {
        port.postMessage({ type: MESSAGE_TYPES.ERROR, text: "Native host unavailable for audio playback request." });
        return;
      }

      const id = requestId || `audio-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      audioRequestMap.set(id, { port, audioPath });

      try {
        np.postMessage({
          command: "load-audio-file",
          requestId: id,
          path: audioPath,
          tabTitle: typeof msg.tabTitle === "string" ? msg.tabTitle : null,
        });
      } catch (err) {
        audioRequestMap.delete(id);
        port.postMessage({ type: MESSAGE_TYPES.ERROR, text: "Failed to request audio file: " + (err?.message || err) });
      }
      return;
    }
  });

  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
    for (const [requestId, info] of audioRequestMap.entries()) {
      if (info.port === port) {
        audioRequestMap.delete(requestId);
      }
    }
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-recording") {
    toggleRecording();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.source !== "offscreen") return;

  switch (msg.type) {
    case MESSAGE_TYPES.OFFSCREEN_READY:
      offscreenReady = true;
      if (offscreenReadyResolver) {
        offscreenReadyResolver();
        offscreenReadyResolver = null;
      }
      break;

    case MESSAGE_TYPES.STATUS:
    case MESSAGE_TYPES.WARN:
    case MESSAGE_TYPES.LOG:
      broadcast({ type: msg.type, text: msg.text || "" });
      break;

    case MESSAGE_TYPES.ERROR:
      broadcast({ type: MESSAGE_TYPES.ERROR, text: msg.text || "" });
      setBadge("error");
      resetRecordingState();
      broadcastRecordingStatus();
      break;

    case MESSAGE_TYPES.RECORDING_STARTED:
      recordingState.status = "recording";
      broadcastRecordingStatus();
      if (hostReady) {
        setBadge("recording");
      } else {
        setBadge("connecting");
      }
      broadcast({ type: MESSAGE_TYPES.RECORDING_STARTED, text: msg.text || "Recording started." });
      break;

    case MESSAGE_TYPES.RECORDING_STOPPED:
      resetRecordingState();
      broadcastRecordingStatus();
      setBadge(hostReady ? "ready" : "idle");
      broadcast({ type: MESSAGE_TYPES.RECORDING_STOPPED, text: msg.text || "Recording finished." });
      break;

    case MESSAGE_TYPES.AUDIO:
      if (typeof msg.base64 === "string") {
        forwardAudioToNative(msg.base64, msg.tabTitle ?? null);
      }
      break;

    case MESSAGE_TYPES.OFFSCREEN_CLOSED:
      offscreenReady = false;
      break;

    default:
      break;
  }
});
