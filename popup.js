let currentStream = null;
let mediaRecorder = null;
let logElement = null;
let chunks = [];

let startButton = null;
let stopButton = null;
let port = null;

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById('closePopup').addEventListener('click', () => {
    window.close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      window.close();
    }
  });
  logElement = document.getElementById("log");
  startButton = document.getElementById("startCapture");
  stopButton = document.getElementById("stopCapture");

  // Initial state: only Start is enabled
  startButton.disabled = true;
  stopButton.disabled = true;

  startButton.addEventListener("click", () => {
    // Stop existing stream if any
    if (currentStream) {
      currentStream.getTracks().forEach(track => track.stop());
      currentStream = null;
    }

    chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
      if (chrome.runtime.lastError || !stream) {
        logError("Failed to capture: " + (chrome.runtime.lastError?.message || "No audio stream"));
        return;
      }

      currentStream = stream;

      // Play the audio so the tab still outputs sound
      const audio = new Audio();
      audio.srcObject = stream;
      audio.play().catch(err => {
        logWarning("Audio playback failed: " + err.message);
      });

      const options = { mimeType: "audio/webm;codecs=opus" };
      mediaRecorder = new MediaRecorder(stream, options);
      chunks = [];

      // Collect audio chunks
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data);
        }
      };

      // When recording stops, process and send audio to native host
      mediaRecorder.onstop = () => {
        log("Processing and sending audio...");
        const completeBlob = new Blob(chunks, { type: options.mimeType });
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64Audio = reader.result.split(',')[1];
          if (port) {
            port.postMessage({
              audioChunk: base64Audio
            });
          }
        };
        reader.readAsDataURL(completeBlob);
      };

      // Start recording
      mediaRecorder.start();
      log("Recording started. Click 'Stop Recording' to send audio.");

      // Update button states
      startButton.disabled = true;
      stopButton.disabled = false;
    });
  });

  stopButton.addEventListener("click", () => {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      log("Stopping recording. Please wait...");
      stopButton.disabled = true; // Prevent repeated clicks
      mediaRecorder.stop();
    }
  });

  port = chrome.runtime.connectNative("com.example.chrome_whisper_transcriber");
  port.onMessage.addListener((response) => {
    if (response?.text) {
      if (response.text === "ModelReady") {
        startButton.disabled = false;
      }
      logResult(response.text);
    } else {
      logError("No text in response");
    }

    if (currentStream) {
      currentStream.getTracks().forEach(track => track.stop());
      currentStream = null;
    }

    startButton.disabled = false;
    stopButton.disabled = true;
  });

  port.onDisconnect.addListener(() => {
    logError("Native host disconnected");
    port = null;
  });
});

// Logging helpers

function log(text) {
  appendLogLine(text, "log");
}

function logWarning(text) {
  appendLogLine(text, "warn");
}

function logError(text) {
  appendLogLine(text, "error");
}

function logResult(text) {
  appendLogLine(text, "result");
}

function appendLogLine(text, type) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  const timestamp = `${hh}:${mm}:${ss}.${ms}`;

  const line = document.createElement("div");
  line.className = "log-line " + type;
  line.textContent = `[${timestamp}] ${text}`;
  logElement.prepend(line);
}