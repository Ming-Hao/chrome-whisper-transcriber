let currentStream = null;
let mediaRecorder = null;
let logElement = null;
let chunks = [];

let startButton = null;
let stopButton = null;

document.addEventListener("DOMContentLoaded", () => {
  logElement = document.getElementById("log");
  startButton = document.getElementById("startCapture");
  stopButton = document.getElementById("stopCapture");

  // Initial state: only Start is enabled
  startButton.disabled = false;
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
        const completeBlob = new Blob(chunks, { type: options.mimeType });
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64Audio = reader.result.split(',')[1];
          chrome.runtime.sendNativeMessage("com.example.chrome_whisper_transcriber", {
            audioChunk: base64Audio
          }, (response) => {
            if (chrome.runtime.lastError) {
              logError("Native host error: " + chrome.runtime.lastError.message);
            } else {
              logResult(response?.text || "[No response]");
            }

            // Stop the audio stream after sending
            if (currentStream) {
              currentStream.getTracks().forEach(track => track.stop());
              currentStream = null;
            }

            // Reset button states
            startButton.disabled = false;
            stopButton.disabled = true;
          });
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
      mediaRecorder.stop();
      log("Recording stopped. Sending audio...");
      // Do not stop stream here; wait for onstop
    }
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
  const line = document.createElement("div");
  line.className = "log-line " + type;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  logElement.prepend(line);
}