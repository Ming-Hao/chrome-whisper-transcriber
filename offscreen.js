const RECORDING_MIME = "audio/webm;codecs=opus";

let mediaRecorder = null;
let currentStream = null;
let playbackAudio = null;
let chunks = [];
let currentTabTitle = null;
let currentStreamId = null;

function sendMessage(message) {
  chrome.runtime.sendMessage({ source: "offscreen", ...message }).catch(() => {});
}

function stopStream() {
  if (currentStream) {
    currentStream.getTracks().forEach((track) => track.stop());
  }
  currentStream = null;
}

function resetState() {
  if (playbackAudio) {
    try {
      playbackAudio.pause();
    } catch (_) {
      // ignore pause failure
    }
    playbackAudio.srcObject = null;
  }
  playbackAudio = null;
  mediaRecorder = null;
  chunks = [];
  currentTabTitle = null;
  currentStreamId = null;
  stopStream();
}

function handleRecorderStop() {
  const capturedTitle = currentTabTitle;
  stopStream();
  currentTabTitle = null;

  const blob = new Blob(chunks, { type: RECORDING_MIME });
  chunks = [];

  if (!blob.size) {
    sendMessage({ type: "error", text: "No audio captured" });
    sendMessage({ type: "recording-stopped" });
    resetState();
    return;
  }

  sendMessage({ type: "status", text: "Processing and sending audio..." });

  const reader = new FileReader();
  reader.onloadend = () => {
    try {
      const result = reader.result || "";
      const base64 = typeof result === "string" ? result.split(",")[1] : null;
      if (!base64) {
        throw new Error("Invalid audio data");
      }
      sendMessage({ type: "audio", base64, tabTitle: capturedTitle || null });
    } catch (err) {
      sendMessage({ type: "error", text: "Audio encoding failed: " + (err?.message || err) });
    } finally {
      sendMessage({ type: "recording-stopped" });
      resetState();
    }
  };

  reader.onerror = () => {
    sendMessage({
      type: "error",
      text: "Audio processing failed: " + (reader.error?.message || reader.error || "unknown"),
    });
    sendMessage({ type: "recording-stopped" });
    resetState();
  };

  reader.readAsDataURL(blob);
}

function startRecordingCommand(data) {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    sendMessage({ type: "warn", text: "Recording already in progress." });
    return;
  }

  chunks = [];
  currentTabTitle = data?.tabTitle || null;
  currentStreamId = data?.streamId || null;

  if (!currentStreamId) {
    sendMessage({ type: "error", text: "Missing stream identifier for tab capture." });
    sendMessage({ type: "recording-stopped" });
    resetState();
    return;
  }

  const constraints = {
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: currentStreamId,
      },
    },
    video: false,
  };

  navigator.mediaDevices
    .getUserMedia(constraints)
    .then((stream) => {
      currentStream = stream;

      playbackAudio = new Audio();
      playbackAudio.srcObject = stream;
      playbackAudio.play().catch(() => {
        // Autoplay may be blocked; ignore to keep capture running.
      });

      try {
        mediaRecorder = new MediaRecorder(stream, { mimeType: RECORDING_MIME });
      } catch (err) {
        sendMessage({ type: "error", text: "Cannot create recorder: " + (err?.message || err) });
        sendMessage({ type: "recording-stopped" });
        resetState();
        return;
      }

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      mediaRecorder.onstop = handleRecorderStop;

      mediaRecorder.onerror = (event) => {
        sendMessage({
          type: "error",
          text: "Recording error: " + (event.error?.message || event.error || "unknown"),
        });
        sendMessage({ type: "recording-stopped" });
        resetState();
      };

      try {
        mediaRecorder.start();
      } catch (err) {
        sendMessage({ type: "error", text: "Recorder start failed: " + (err?.message || err) });
        sendMessage({ type: "recording-stopped" });
        resetState();
        return;
      }

      sendMessage({ type: "status", text: "Recording started. Use stop to finish." });
      sendMessage({ type: "recording-started" });
    })
    .catch((err) => {
      sendMessage({
        type: "error",
        text: "Failed to acquire tab audio: " + (err?.message || err),
      });
      sendMessage({ type: "recording-stopped" });
      resetState();
    });
}

function stopRecordingCommand() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    try {
      mediaRecorder.stop();
    } catch (err) {
      sendMessage({ type: "error", text: "Recorder stop failed: " + (err?.message || err) });
      sendMessage({ type: "recording-stopped" });
      resetState();
    }
    return;
  }

  if (currentStream) {
    stopStream();
    sendMessage({ type: "recording-stopped" });
    resetState();
    return;
  }

  sendMessage({ type: "warn", text: "No active recording to stop." });
  sendMessage({ type: "recording-stopped" });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "offscreen") return;

  if (msg.type === "start-recording") {
    startRecordingCommand(msg);
  } else if (msg.type === "stop-recording") {
    stopRecordingCommand();
  } else if (msg.type === "ping") {
    sendMessage({ type: "offscreen-ready" });
  }
});

window.addEventListener("unload", () => {
  resetState();
  sendMessage({ type: "offscreen-closed" });
});

sendMessage({ type: "offscreen-ready" });
