import { MESSAGE_TYPES } from "./message-types.js";

let logElement = null;
let startButton = null;
let stopButton = null;
let openFolderButton = null;
let historyContainer = null;

const TOGGLE_HOTKEY_KEY = "e"; // Use Alt/Option + E to switch
const pendingAudioRequests = new Map();
const pendingHistoryRequests = new Map();
const cachedAudioByPath = new Map();

let bgPort = null;
let hostReadyReceived = false;
let recordingActive = false;
let lastRecordingStatus = "idle";
let latestHistoryRequestId = null;
let historyLoaded = false;
let historyRequestedOnce = false;

const replayMuteInfo = {
  tabId: null,
  shouldRestore: false,
};

let closingPopup = false;

function applyPaneState(pane, toggle, collapsed) {
  if (collapsed) {
    pane.classList.add("collapsed");
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "+";
  } else {
    pane.classList.remove("collapsed");
    toggle.setAttribute("aria-expanded", "true");
    toggle.textContent = "−";
  }
}

function attachPaneToggle(pane) {
  const toggle = pane.querySelector(".pane-toggle");
  const header = pane.querySelector(".pane-header");
  if (!toggle || !header) {
    return;
  }

  const handleToggle = () => {
    const collapsed = pane.classList.contains("collapsed");
    applyPaneState(pane, toggle, !collapsed);
  };

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    handleToggle();
  });

  header.addEventListener("click", (event) => {
    if (event.target instanceof HTMLElement && event.target.closest(".pane-toggle")) {
      return;
    }
    handleToggle();
  });

  applyPaneState(pane, toggle, pane.classList.contains("collapsed"));
}

function isRecordingInProgress() {
  return (
    recordingActive ||
    lastRecordingStatus === "recording" ||
    lastRecordingStatus === "starting"
  );
}

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

window.addEventListener("beforeunload", (event) => {
  if (closingPopup || !isRecordingInProgress()) {
    return;
  }
  event.preventDefault();
  event.returnValue = "";
});

async function handlePopupClose() {
  if (closingPopup) {
    return;
  }

  if (isRecordingInProgress()) {
    const confirmed = window.confirm("Recording is still in progress. Stop recording and close the window?");
    if (!confirmed) {
      return;
    }
    try {
      stopRecordingFlow();
    } catch (err) {
      console.error("Failed to stop recording before closing:", err);
    }
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
      bgPort?.postMessage({ type: MESSAGE_TYPES.ENSURE_NATIVE });
    }
  }, 100);

  bgPort.onMessage.addListener((msg) => {
    if (!msg) return;

    switch (msg.type) {
      case MESSAGE_TYPES.HOST_READY:
        hostReadyReceived = true;
        applyRecordingStatus(lastRecordingStatus);
        log(msg.text || "host ready");
        if (!historyLoaded && !latestHistoryRequestId) {
          void loadHistoryForActiveTab();
        }
        break;

      case MESSAGE_TYPES.RESULT:
        enableStart();
        logResult(msg.text || "", {
          audioDataUrl: msg.audioDataUrl || null,
          savedPaths: msg.savedPaths || null,
          tabTitle: msg.tabTitle || null,
        });
        break;
      
      case MESSAGE_TYPES.AUDIO_FILE:
        handleIncomingAudioFile(msg);
        break;

      case MESSAGE_TYPES.AUDIO_FILE_ERROR:
        handleIncomingAudioFileError(msg);
        break;

      case MESSAGE_TYPES.RECORDING_STATUS:
        applyRecordingStatus(msg.status);
        break;

      case MESSAGE_TYPES.RECORDING_STOPPED:
        enableStart();
        log("Recording finished.");
        break;

      case MESSAGE_TYPES.ERROR:
        enableStart();
        logError(msg.text || "");
        break;

      case MESSAGE_TYPES.WARN:
        logWarning(msg.text || "");
        if ((msg.text || "").includes("Recording already in progress")) {
          enableStop();
        }
        break;

      case MESSAGE_TYPES.RECORDING_STARTED:
        enableStop();
        log(msg.text || "Recording started.");
        break;

      case MESSAGE_TYPES.STATUS:
        if ((msg.text || "") === "Recording started. Use stop to finish.") {
          enableStop();
          break;
        }
        log(msg.text || "");
        break;

      case MESSAGE_TYPES.TAB_HISTORY_RESULT:
        handleHistoryResult(msg);
        break;

      case MESSAGE_TYPES.TAB_HISTORY_ERROR:
        handleHistoryError(msg);
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

  document.querySelectorAll(".pane").forEach((pane) => attachPaneToggle(pane));

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
  historyContainer = document.getElementById("history");
  renderHistoryPlaceholder("Loading history...");
  void loadHistoryForActiveTab();

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
    bgPort.postMessage({ type: MESSAGE_TYPES.START_RECORDING });
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
    bgPort.postMessage({ type: MESSAGE_TYPES.STOP_RECORDING });
  } catch (e) {
    logError("Stop command failed: " + (e?.message || e));
  }
}

function openRecordingsFolder() {
  if (!ensureBgPort()) return;

  try {
    bgPort.postMessage({ type: MESSAGE_TYPES.OPEN_RECORDINGS_FOLDER });
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
    bgPort.postMessage({ type: MESSAGE_TYPES.OPEN_SAVED_FOLDER, folderPath });
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
function log(text) { appendLogLine(text, MESSAGE_TYPES.LOG); }
function logWarning(text) { appendLogLine(text, MESSAGE_TYPES.WARN); }
function logError(text) { appendLogLine(text, MESSAGE_TYPES.ERROR); }
function logResult(text, extraInfo) { appendLogLine(text, MESSAGE_TYPES.RESULT, extraInfo || {}); }

function createResultControls({ text, audioDataUrl, savedPaths, tabTitle }) {
  const controls = [];
  const audioPath = savedPaths?.audio || null;
  const folderPath = savedPaths?.folder || null;
  const transcriptPath = savedPaths?.text || null;

  let resolvedDataUrl = audioDataUrl || (audioPath ? cachedAudioByPath.get(audioPath) || null : null);
  let audioInstance = null;
  let isFetching = false;

  if (resolvedDataUrl || audioPath) {
    const replayBtn = document.createElement("button");
    replayBtn.className = "play-icon-btn";
    replayBtn.innerHTML = "▶️";
    replayBtn.title = "Replay";

    if (audioPath) {
      replayBtn.dataset.audioPath = audioPath;
    }
    if (folderPath) {
      replayBtn.dataset.folderPath = folderPath;
    }
    if (transcriptPath) {
      replayBtn.dataset.transcriptPath = transcriptPath;
    }
    if (tabTitle) {
      replayBtn.dataset.tabTitle = tabTitle;
    }

    const ensureAudioInstance = () => {
      if (!resolvedDataUrl) {
        return null;
      }
      if (!audioInstance) {
        audioInstance = new Audio(resolvedDataUrl);
        audioInstance.addEventListener("ended", () => {
          replayBtn.innerHTML = "▶️";
          void restoreReplayMute();
        });
        audioInstance.addEventListener("pause", () => {
          if (!audioInstance) return;
          if (audioInstance.currentTime === 0 || audioInstance.currentTime < audioInstance.duration) {
            replayBtn.innerHTML = "▶️";
            void restoreReplayMute();
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

      requestAudioFromHost(audioPath, tabTitle || null,
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

    controls.push(replayBtn);
  }

  if (folderPath) {
    const openFolderBtn = document.createElement("button");
    openFolderBtn.className = "folder-icon-btn";
    openFolderBtn.innerHTML = "📂";
    openFolderBtn.title = "Open Folder";
    openFolderBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openSavedFolder(folderPath);
    });
    controls.push(openFolderBtn);
  }

  const copyBtn = document.createElement("button");
  copyBtn.className = "copy-icon-btn";
  copyBtn.innerHTML = "📋";
  copyBtn.title = "Copy";
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text || "");
      copyBtn.innerHTML = "✅";
      setTimeout(() => { copyBtn.innerHTML = "📋"; }, 1000);
    } catch (err) {
      console.error("Clipboard copy failed:", err);
    }
  });
  controls.push(copyBtn);

  return controls;
}

function appendLogLine(text, type, extraInfo = {}) {
  const displayType =
    (type === MESSAGE_TYPES.RESULT ||
      type === MESSAGE_TYPES.ERROR ||
      type === MESSAGE_TYPES.WARN ||
      type === MESSAGE_TYPES.LOG)
      ? type
      : MESSAGE_TYPES.LOG;
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

  if (displayType === MESSAGE_TYPES.RESULT) {
    const savedPaths = extraInfo?.savedPaths || null;
    const controls = createResultControls({
      text,
      audioDataUrl: extraInfo?.audioDataUrl || null,
      savedPaths,
      tabTitle: extraInfo?.tabTitle || null,
    });
    let copyControl = null;
    controls.forEach((control) => {
      if (!copyControl && control instanceof HTMLElement && control.classList.contains("copy-icon-btn")) {
        copyControl = control;
      }
      line.appendChild(control);
    });

    if (copyControl) {
      line.addEventListener("dblclick", (event) => {
        if (event.target instanceof HTMLElement && event.target.closest("button")) {
          return;
        }
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
          const range = document.createRange();
          const textNode = span.firstChild;
          const rawText = typeof textNode?.textContent === "string" ? textNode.textContent : "";
          const markerIndex = rawText.indexOf("] ");
          const startOffset = markerIndex >= 0 ? markerIndex + 2 : 0;
          const endOffset = rawText.length;
          if (textNode && startOffset < endOffset) {
            range.setStart(textNode, startOffset);
            range.setEnd(textNode, endOffset);
            selection.addRange(range);
          }
        }
        copyControl.click();
      });
    }
  }

  logElement.prepend(line);
}

function renderHistoryPlaceholder(message) {
  if (!historyContainer) {
    return;
  }
  historyContainer.innerHTML = "";
  const placeholder = document.createElement("div");
  placeholder.className = "history-placeholder";
  placeholder.textContent = message;
  historyContainer.appendChild(placeholder);
}

function renderHistoryEntries(entries) {
  if (!historyContainer) {
    return;
  }

  historyContainer.innerHTML = "";
  if (!Array.isArray(entries) || entries.length === 0) {
    renderHistoryPlaceholder("No saved history yet.");
    return;
  }

  entries.forEach((entry) => {
    const transcriptText = entry?.transcript || "";
    const savedPaths = {
      folder: entry?.folder || null,
      audio: entry?.audio || null,
      text: entry?.text || null,
    };

    const item = document.createElement("div");
    item.className = "history-entry";

    const meta = document.createElement("div");
    meta.className = "history-entry-meta";
    let createdAt = "";
    if (entry?.createdAt) {
      const parsed = new Date(entry.createdAt);
      if (!Number.isNaN(parsed.getTime())) {
        createdAt = parsed.toLocaleString();
      }
    }
    const title = entry?.tabTitle || entry?.tabURL || "Untitled tab";
    meta.textContent = createdAt ? `${createdAt} - ${title}` : title;
    item.appendChild(meta);

    const content = document.createElement("div");
    content.className = "history-entry-text";
    content.textContent = transcriptText || "[No transcript]";
    item.appendChild(content);

    const actions = document.createElement("div");
    actions.className = "history-entry-actions";
    const controls = createResultControls({
      text: transcriptText,
      audioDataUrl: null,
      savedPaths,
      tabTitle: entry?.tabTitle || null,
    });
    let copyControl = null;
    controls.forEach((control) => {
      if (!copyControl && control instanceof HTMLElement && control.classList.contains("copy-icon-btn")) {
        copyControl = control;
      }
      actions.appendChild(control);
    });
    item.appendChild(actions);

    if (copyControl) {
      item.addEventListener("dblclick", (event) => {
        if (event.target instanceof HTMLElement && event.target.closest("button")) {
          return;
        }
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
          const range = document.createRange();
          const textNode = content.firstChild;
          if (textNode && textNode.textContent?.length) {
            range.setStart(textNode, 0);
            range.setEnd(textNode, textNode.textContent.length);
            selection.addRange(range);
          } else {
            range.selectNodeContents(content);
            selection.addRange(range);
          }
        }
        copyControl.click();
      });
    }

    historyContainer.appendChild(item);
  });
}

function handleHistoryResult(msg) {
  const requestId = msg?.requestId || null;
  if (requestId) {
    pendingHistoryRequests.delete(requestId);
    if (latestHistoryRequestId && requestId !== latestHistoryRequestId) {
      return;
    }
  }
  latestHistoryRequestId = null;
  historyLoaded = true;
  historyRequestedOnce = true;
  renderHistoryEntries(msg?.entries || []);
}

function handleHistoryError(msg) {
  const requestId = msg?.requestId || null;
  if (requestId) {
    pendingHistoryRequests.delete(requestId);
    if (latestHistoryRequestId && requestId !== latestHistoryRequestId) {
      return;
    }
  }
  latestHistoryRequestId = null;
  const text = msg?.text || "Unable to load history.";
  historyLoaded = false;
  historyRequestedOnce = false;
  renderHistoryPlaceholder(text);
}

async function loadHistoryForActiveTab() {
  if (!historyContainer) {
    return;
  }
  if (historyLoaded || latestHistoryRequestId) {
    return;
  }
  if (!ensureBgPort()) {
    renderHistoryPlaceholder("Background page not connected; cannot load history.");
    return;
  }

  renderHistoryPlaceholder("Loading history...");

  let tab = null;
  try {
    tab = await queryActiveTab();
  } catch (err) {
    console.error("Failed to query active tab for history:", err);
  }

  if (!tab || typeof tab.id !== "number") {
    renderHistoryPlaceholder("No history found for the current tab.");
    return;
  }

  const requestId = `history-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  latestHistoryRequestId = requestId;
  pendingHistoryRequests.set(requestId, { tabId: tab.id });
  historyRequestedOnce = true;

  try {
    bgPort.postMessage({
      type: MESSAGE_TYPES.REQUEST_TAB_HISTORY,
      requestId,
      tabId: tab.id,
      tabTitle: typeof tab.title === "string" ? tab.title : null,
      includeTranscripts: true,
      limit: 50,
    });
  } catch (err) {
    pendingHistoryRequests.delete(requestId);
    latestHistoryRequestId = null;
    console.error("Failed to request history:", err);
    renderHistoryPlaceholder("Unable to request history from background.");
    historyLoaded = false;
    historyRequestedOnce = false;
  }
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
      type: MESSAGE_TYPES.REQUEST_AUDIO_PLAYBACK,
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
