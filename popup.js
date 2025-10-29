let logElement = null;
let startButton = null;
let stopButton = null;
let openFolderButton = null;

const TOGGLE_HOTKEY_KEY = "e"; // Use Alt/Option + E to switch

let bgPort = null;
let hostReadyReceived = false;
let recordingActive = false;
let lastRecordingStatus = "idle";

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
        logResult(msg.text || "");
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

  document.getElementById("closePopup").addEventListener("click", () => {
    window.close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      window.close();
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
function logResult(text) { appendLogLine(text, "result"); }

function appendLogLine(text, type) {
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
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-icon-btn";
    copyBtn.innerHTML = "📋";
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
