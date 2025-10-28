let currentStream = null;
let mediaRecorder = null;
let logElement = null;
let chunks = [];
let currentTabTitle = null;

let startButton = null;
let stopButton = null;

const TOGGLE_HOTKEY_KEY = "r"; // Use Ctrl + R to switch

let bgPort = null;
let hostReadyReceived = false;


function lockUI() {
  startButton.disabled = true;
  stopButton.disabled = true;
}
function enableStart() {
  startButton.disabled = false;
  stopButton.disabled = true;
}

function connectBackground() {
  bgPort = chrome.runtime.connect({ name: "popup-bridge" });
  
  setTimeout(() => {
    if (hostReadyReceived == false) {
      bgPort.postMessage({ type: "ensure-native" });
    }
  }, 100);

  bgPort.onMessage.addListener((msg) => {
    if (!msg) return;

    switch (msg.type) {
      case "host-ready":
        enableStart();
        hostReadyReceived = true;
        log(msg.text || "host ready");
        break;

      case "result":
        enableStart();
        logResult(msg.text || "");
        break;

      case "error":
        enableStart();
        logError(msg.text || "");

        if (currentStream) {
          currentStream.getTracks().forEach(t => t.stop());
          currentStream = null;
        }
        break;

      case "status":
      default:
        log(msg.text || "");
    }
  });


  bgPort.onDisconnect.addListener(() => {
    logWarning("Background port disconnected");
    bgPort = null;
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

function sendAudioToBackground(base64Audio, tabTitle) {
  if (!ensureBgPort()) {
    logError("No background port available");
    return;
  }
  try {
    bgPort.postMessage({ type: "audio", base64: base64Audio, tabTitle: tabTitle || null });
  } catch (e) {
    logError("Send to background failed: " + (e?.message || e));
  }
}

document.addEventListener("DOMContentLoaded", () => {
  connectBackground();

  document.getElementById('closePopup').addEventListener('click', () => {
    window.close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
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

  lockUI();

  startButton.addEventListener("click", startRecordingFlow);
  stopButton.addEventListener("click", stopRecordingFlow);
});

function resolveActiveTabTitle(callback) {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        logWarning("Cannot read tab title: " + chrome.runtime.lastError.message);
        callback(null);
        return;
      }
      const title = tabs && tabs.length ? tabs[0].title || null : null;
      callback(title);
    });
  } catch (e) {
    logWarning("Cannot query tab title: " + (e?.message || e));
    callback(null);
  }
}

function startRecordingFlow() {
  if (startButton.disabled) return;

  // Stop existing stream if any
  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop());
    currentStream = null;
  }

  resolveActiveTabTitle((title) => {
    currentTabTitle = title;

    chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
      if (chrome.runtime.lastError || !stream) {
        logError("Failed to capture: " + (chrome.runtime.lastError?.message || "No audio stream"));
        return;
      }

      currentStream = stream;

      // Keep tab audio audible
      const audio = new Audio();
      audio.srcObject = stream;
      audio.play().catch(err => {
        logWarning("Audio playback failed: " + err.message);
      });

      const options = { mimeType: "audio/webm;codecs=opus" };
      mediaRecorder = new MediaRecorder(stream, options);
      chunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        log("Processing and sending audio...");
        const completeBlob = new Blob(chunks, { type: options.mimeType });
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64Audio = reader.result.split(',')[1];
          sendAudioToBackground(base64Audio, currentTabTitle); // << send to background
        };
        reader.readAsDataURL(completeBlob);
      };

      mediaRecorder.start();
      log("Recording started. Click 'Stop Recording' to send audio.");

      startButton.disabled = true;
      stopButton.disabled = true;

      setTimeout(() => { stopButton.disabled = false; }, 150);
    });
  });
}

function stopRecordingFlow() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  log("Stopping recording. Please wait...");
  stopButton.disabled = true;
  mediaRecorder.stop();
}

function isToggleHotkey(event) {
  const modifierPressed = event.ctrlKey || event.metaKey;
  return modifierPressed && !event.altKey && event.key.toLowerCase() === TOGGLE_HOTKEY_KEY;
}

function handleToggleHotkey() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    stopRecordingFlow();
  } else if (!startButton.disabled) {
    startRecordingFlow();
  } else {
    logWarning("Hotkey ignored: recorder busy.");
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
