let logElement = null;
let startButton = null;
let stopButton = null;
let openFolderButton = null;

const TOGGLE_HOTKEY_KEY = "e"; // Use Alt/Option + E to switch
const pendingAudioRequests = new Map();
const cachedAudioByPath = new Map();

let bgPort = null;
let hostReadyReceived = false;
let recordingActive = false;
let lastRecordingStatus = "idle";

const replayMuteInfo = {
  tabId: null,
  shouldRestore: false,
};

let closingPopup = false;

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.warn("queryActiveTab failed:", err);
        resolve(null);
        return;
      }
      resolve(Array.isArray(tabs) && tabs.length ? tabs[0] : null);
    });
  });
}

function updateTabMuted(tabId, muted) {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, { muted }, (tab) => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.warn("updateTabMuted failed:", err);
        resolve(null);
        return;
      }
      resolve(tab || null);
    });
  });
}

async function restoreReplayMute() {
  const { tabId, shouldRestore } = replayMuteInfo;
  replayMuteInfo.tabId = null;
  replayMuteInfo.shouldRestore = false;
  if (!shouldRestore || typeof tabId !== "number") {
    return;
  }
  await updateTabMuted(tabId, false);
}

async function muteCurrentTabForReplay() {
  const tab = await queryActiveTab();
  if (!tab || typeof tab.id !== "number") {
    return false;
  }

  if (replayMuteInfo.shouldRestore && replayMuteInfo.tabId !== tab.id) {
    await restoreReplayMute();
  }

  const alreadyMuted = tab.mutedInfo?.muted === true;
  replayMuteInfo.tabId = tab.id;
  replayMuteInfo.shouldRestore = !alreadyMuted;

  if (!alreadyMuted) {
    const tabResult = await updateTabMuted(tab.id, true);
    if (!tabResult) {
      replayMuteInfo.shouldRestore = false;
    }
  } else {
    replayMuteInfo.shouldRestore = false;
  }

  return replayMuteInfo.shouldRestore;
}

window.addEventListener("unload", () => {
  void restoreReplayMute();
});

async function handlePopupClose() {
  if (closingPopup) {
    return;
  }
  closingPopup = true;
  try {
    await restoreReplayMute();
  } finally {
    window.close();
  }
}

function lockUI() {
  startButton.disabled = true;
  stopButton.disabled = true;
}

function enableStart() {
  startButton.disabled = false;
  stopButton.disabled = true;
  recordingActive = false;
}

function enableStop() {
  startButton.disabled = true;
  stopButton.disabled = false;
  recordingActive = true;
}

function connectBackground() {
  bgPort = chrome.runtime.connect({ name: "popup-bridge" });

  setTimeout(() => {
    if (!hostReadyReceived) {
      bgPort?.postMessage({ type: "ensure-native" });
    }
  }, 100);

  bgPort.onMessage.addListener((msg) => {
    if (!msg) return;

    switch (msg.type) {
      case "host-ready":
        hostReadyReceived = true;
        applyRecordingStatus(lastRecordingStatus);
        log(msg.text || "host ready");
        break;

      case "result":
        enableStart();
        logResult(msg.text || "", {
          audioDataUrl: msg.audioDataUrl || null,
          savedPaths: msg.savedPaths || null,
          tabTitle: msg.tabTitle || null,
        });
        break;
      
      case "audio-file":
        handleIncomingAudioFile(msg);
        break;

      case "audio-file-error":
        handleIncomingAudioFileError(msg);
        break;

      case "recording-status":
        applyRecordingStatus(msg.status);
        break;

      case "recording-stopped":
        enableStart();
        log("Recording finished.");
        break;

      case "error":
        enableStart();
        logError(msg.text || "");
        break;

      case "warn":
        logWarning(msg.text || "");
        if ((msg.text || "").includes("Recording already in progress")) {
          enableStop();
        }
        break;

      case "recording-started":
        enableStop();
        log(msg.text || "Recording started.");
        break;

      case "status":
        if ((msg.text || "") === "Recording started. Use stop to finish.") {
          enableStop();
          break;
        }
        log(msg.text || "");
        break;

      default:
        log(msg.text || "");
    }
  });

  bgPort.onDisconnect.addListener(() => {
    logWarning("Background port disconnected");
    bgPort = null;
    recordingActive = false;
    lockUI();
  });
}

function ensureBgPort() {
  if (bgPort) return true;
  try {
    connectBackground();
    return !!bgPort;
  } catch (e) {
    logError("Cannot connect to background: " + (e?.message || e));
    return false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  connectBackground();

  const closeBtn = document.getElementById("closePopup");
  if (closeBtn) {
    closeBtn.addEventListener("click", (event) => {
      event.preventDefault();
      handlePopupClose().catch((err) => console.error("Failed to close popup:", err));
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      handlePopupClose().catch((err) => console.error("Failed to close popup:", err));
      return;
    }
    if (isToggleHotkey(event)) {
      event.preventDefault();
      handleToggleHotkey();
    }
  });

  logElement = document.getElementById("log");
  startButton = document.getElementById("startCapture");
  stopButton = document.getElementById("stopCapture");
  openFolderButton = document.getElementById("openRecordings");

  lockUI();

  startButton.addEventListener("click", startRecordingFlow);
  stopButton.addEventListener("click", stopRecordingFlow);
  if (openFolderButton) {
    openFolderButton.addEventListener("click", openRecordingsFolder);
  }
});

function startRecordingFlow() {
  if (startButton.disabled) return;
  if (!ensureBgPort()) return;

  lockUI();

  try {
    bgPort.postMessage({ type: "start-recording" });
  } catch (e) {
    enableStart();
    logError("Send to background failed: " + (e?.message || e));
  }
}

function stopRecordingFlow() {
  if (!recordingActive && stopButton.disabled) return;
  if (!ensureBgPort()) return;

  stopButton.disabled = true;

  try {
    bgPort.postMessage({ type: "stop-recording" });
  } catch (e) {
    logError("Stop command failed: " + (e?.message || e));
  }
}

function openRecordingsFolder() {
  if (!ensureBgPort()) return;

  try {
    bgPort.postMessage({ type: "open-recordings-folder" });
    log("Requesting to open the recordings folder...");
  } catch (e) {
    logError("Failed to send the open folder command: " + (e?.message || e));
  }
}

function openSavedFolder(folderPath) {
  if (!folderPath) {
    logWarning("No valid folder path found to open.");
    return;
  }
  if (!ensureBgPort()) return;

  try {
    bgPort.postMessage({ type: "open-saved-folder", folderPath });
    log(`Attempting to open folder: ${folderPath}`);
  } catch (e) {
    logError("Failed to send command to open the specified folder: " + (e?.message || e));
  }
}

function isToggleHotkey(event) {
  return event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === TOGGLE_HOTKEY_KEY;
}

function handleToggleHotkey() {
  if (recordingActive) {
    stopRecordingFlow();
  } else if (!startButton.disabled) {
    startRecordingFlow();
  } else {
    logWarning("Hotkey ignored: recorder busy.");
  }
}

function applyRecordingStatus(status) {
  const normalized = status || "idle";
  lastRecordingStatus = normalized;

  if (normalized === "recording") {
    enableStop();
  } else if (normalized === "starting") {
    lockUI();
    recordingActive = false;
  } else if (hostReadyReceived) {
    enableStart();
  } else {
    lockUI();
    recordingActive = false;
  }
}

// Logging helpers
function log(text) { appendLogLine(text, "log"); }
function logWarning(text) { appendLogLine(text, "warn"); }
function logError(text) { appendLogLine(text, "error"); }
function logResult(text, extraInfo) { appendLogLine(text, "result", extraInfo || {}); }

function appendLogLine(text, type, extraInfo = {}) {
  const displayType = (type === "result" || type === "error" || type === "warn" || type === "log") ? type : "log";
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  const timestamp = `${hh}:${mm}:${ss}.${ms}`;

  const line = document.createElement("div");
  line.className = "log-line " + displayType;

  const span = document.createElement("span");
  span.textContent = `[${timestamp}] ${text}`;
  line.appendChild(span);

  if (displayType === "result") {
    const audioDataUrl = extraInfo?.audioDataUrl || null;
    const savedPaths = extraInfo?.savedPaths || null;
    const audioPath = savedPaths?.audio || null;

    if (audioDataUrl || audioPath) {
      const replayBtn = document.createElement("button");
      replayBtn.className = "play-icon-btn";
      replayBtn.innerHTML = "▶️";
      replayBtn.title = "Replay";

      if (audioPath) {
        replayBtn.dataset.audioPath = audioPath;
      }
      if (savedPaths?.folder) {
        replayBtn.dataset.folderPath = savedPaths.folder;
      }
      if (savedPaths?.text) {
        replayBtn.dataset.transcriptPath = savedPaths.text;
      }
      if (extraInfo?.tabTitle) {
        replayBtn.dataset.tabTitle = extraInfo.tabTitle;
      }

      let resolvedDataUrl = audioDataUrl || (audioPath ? cachedAudioByPath.get(audioPath) || null : null);
      let audioInstance = null;
      let isFetching = false;

      const ensureAudioInstance = () => {
        if (!resolvedDataUrl) {
          return null;
        }
        if (!audioInstance) {
          audioInstance = new Audio(resolvedDataUrl);
          audioInstance.addEventListener("ended", () => {
            replayBtn.innerHTML = "▶️";
            void restoreReplayMute(); // intentionally fire-and-forget: we only need to trigger mute restoration
          });
          audioInstance.addEventListener("pause", () => {
            if (!audioInstance) return;
            if (audioInstance.currentTime === 0 || audioInstance.currentTime < audioInstance.duration) {
              replayBtn.innerHTML = "▶️";
              void restoreReplayMute(); // intentionally fire-and-forget: we only need to trigger mute restoration
            }
          });
        }
        return audioInstance;
      };

      const playOrToggle = async () => {
        const instance = ensureAudioInstance();
        if (!instance) {
          return;
        }
        try {
          if (!instance.paused && !instance.ended) {
            instance.pause();
            instance.currentTime = 0;
            replayBtn.innerHTML = "▶️";
            await restoreReplayMute();
            return;
          }

          await muteCurrentTabForReplay();
          instance.currentTime = 0;
          replayBtn.innerHTML = "🔊";
          await instance.play();
        } catch (err) {
          console.error("Audio playback failed:", err);
          replayBtn.innerHTML = "⚠️";
          await restoreReplayMute();
          setTimeout(() => { replayBtn.innerHTML = "▶️"; }, 1200);
        }
      };

      replayBtn.addEventListener("click", () => {
        if (resolvedDataUrl) {
          playOrToggle().catch((err) => console.error("Replay toggle failed:", err));
          return;
        }

        if (!audioPath) {
          console.warn("No playable audio path found.");
          return;
        }

        const cached = cachedAudioByPath.get(audioPath);
        if (cached) {
          resolvedDataUrl = cached;
          audioInstance = null;
          playOrToggle().catch((err) => console.error("Replay toggle failed:", err));
          return;
        }

        if (isFetching) {
          return;
        }

        isFetching = true;
        replayBtn.disabled = true;
        replayBtn.innerHTML = "⏳";

        requestAudioFromHost(audioPath, extraInfo?.tabTitle || null,
          (dataUrl) => {
            isFetching = false;
            replayBtn.disabled = false;
            replayBtn.innerHTML = "▶️";

            if (audioPath) {
              cachedAudioByPath.set(audioPath, dataUrl);
            }
            resolvedDataUrl = dataUrl;
            audioInstance = null;
            playOrToggle().catch((err) => console.error("Replay toggle failed:", err));
          },
          (errorText) => {
            isFetching = false;
            replayBtn.disabled = false;
            replayBtn.innerHTML = "⚠️";
            if (errorText) {
              logError(errorText);
            }
            setTimeout(() => { replayBtn.innerHTML = "▶️"; }, 1500);
          });
      });

      line.appendChild(replayBtn);
    }
    if (savedPaths?.folder) {
      const openFolderBtn = document.createElement("button");
      openFolderBtn.className = "folder-icon-btn";
      openFolderBtn.innerHTML = "📂";
      openFolderBtn.title = "Open Folder";
      openFolderBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        openSavedFolder(savedPaths.folder);
      });
      line.appendChild(openFolderBtn);
    }
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-icon-btn";
    copyBtn.innerHTML = "📋";
    copyBtn.title = "Copy";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text); // copy without timestamp
        copyBtn.innerHTML = "✅";
        setTimeout(() => { copyBtn.innerHTML = "📋"; }, 1000);
      } catch (err) {
        console.error("Clipboard copy failed:", err);
      }
    });
    line.appendChild(copyBtn);
  }

  logElement.prepend(line);
}

function requestAudioFromHost(audioPath, tabTitle, onSuccess, onFailure) {
  if (!audioPath) {
    onFailure?.("Missing audio file path, unable to play.");
    return;
  }
  if (!ensureBgPort()) {
    onFailure?.("Failed to connect to background page to retrieve audio.");
    return;
  }

  const requestId = `audio-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  pendingAudioRequests.set(requestId, {
    audioPath,
    onSuccess,
    onFailure,
  });

  try {
    bgPort.postMessage({
      type: "request-audio-playback",
      requestId,
      audioPath,
      tabTitle: tabTitle || null,
    });
  } catch (err) {
    pendingAudioRequests.delete(requestId);
    onFailure?.("Failed to request background audio loading: " + (err?.message || err));
  }
}

function handleIncomingAudioFile(msg) {
  const requestId = msg?.requestId || null;
  if (!requestId) {
    console.warn("Received an audio-file message without a requestId.");
    return;
  }
  const pending = pendingAudioRequests.get(requestId);
  if (!pending) {
    console.warn("Cannot find the corresponding audio request, requestId=", requestId);
    return;
  }
  pendingAudioRequests.delete(requestId);

  const base64 = msg?.base64;
  if (!base64) {
    pending.onFailure?.("The returned audio data is missing content.");
    return;
  }
  const mimeType = msg?.mimeType || "audio/webm";
  const dataUrl = `data:${mimeType};base64,${base64}`;
  if (pending.audioPath) {
    cachedAudioByPath.set(pending.audioPath, dataUrl);
  }
  pending.onSuccess?.(dataUrl);
}

function handleIncomingAudioFileError(msg) {
  const requestId = msg?.requestId || null;
  if (!requestId) {
    logError(msg?.text || "An unknown error occurred while reading the audio file.");
    return;
  }
  const pending = pendingAudioRequests.get(requestId);
  if (!pending) {
    logError(msg?.text || "An unknown error occurred while reading the audio file.");
    return;
  }
  pendingAudioRequests.delete(requestId);
  pending.onFailure?.(msg?.text || "Failed to read the audio file.");
}
