import { MESSAGE_TYPES } from "./message-types.js";

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
    sendMessage({ type: MESSAGE_TYPES.ERROR, text: "No audio captured" });
    sendMessage({ type: MESSAGE_TYPES.RECORDING_STOPPED });
    resetState();
    return;
  }

  sendMessage({ type: MESSAGE_TYPES.STATUS, text: "Processing and sending audio..." });

  const reader = new FileReader();
  reader.onloadend = () => {
    try {
      const result = reader.result || "";
      const base64 = typeof result === "string" ? result.split(",")[1] : null;
      if (!base64) {
        throw new Error("Invalid audio data");
      }
      sendMessage({ type: MESSAGE_TYPES.AUDIO, base64, tabTitle: capturedTitle || null });
    } catch (err) {
      sendMessage({ type: MESSAGE_TYPES.ERROR, text: "Audio encoding failed: " + (err?.message || err) });
    } finally {
      sendMessage({ type: MESSAGE_TYPES.RECORDING_STOPPED });
      resetState();
    }
  };

  reader.onerror = () => {
    sendMessage({
      type: MESSAGE_TYPES.ERROR,
      text: "Audio processing failed: " + (reader.error?.message || reader.error || "unknown"),
    });
    sendMessage({ type: MESSAGE_TYPES.RECORDING_STOPPED });
    resetState();
  };

  reader.readAsDataURL(blob);
}

function startRecordingCommand(data) {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    sendMessage({ type: MESSAGE_TYPES.WARN, text: "Recording already in progress." });
    return;
  }

  chunks = [];
  currentTabTitle = data?.tabTitle || null;
  currentStreamId = data?.streamId || null;

  if (!currentStreamId) {
    sendMessage({ type: MESSAGE_TYPES.ERROR, text: "Missing stream identifier for tab capture." });
    sendMessage({ type: MESSAGE_TYPES.RECORDING_STOPPED });
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
        sendMessage({ type: MESSAGE_TYPES.ERROR, text: "Cannot create recorder: " + (err?.message || err) });
        sendMessage({ type: MESSAGE_TYPES.RECORDING_STOPPED });
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
          type: MESSAGE_TYPES.ERROR,
          text: "Recording error: " + (event.error?.message || event.error || "unknown"),
        });
        sendMessage({ type: MESSAGE_TYPES.RECORDING_STOPPED });
        resetState();
      };

      try {
        mediaRecorder.start();
      } catch (err) {
        sendMessage({ type: MESSAGE_TYPES.ERROR, text: "Recorder start failed: " + (err?.message || err) });
        sendMessage({ type: MESSAGE_TYPES.RECORDING_STOPPED });
        resetState();
        return;
      }

      sendMessage({ type: MESSAGE_TYPES.STATUS, text: "Recording started. Use stop to finish." });
      sendMessage({ type: MESSAGE_TYPES.RECORDING_STARTED });
    })
    .catch((err) => {
      sendMessage({
        type: MESSAGE_TYPES.ERROR,
        text: "Failed to acquire tab audio: " + (err?.message || err),
      });
      sendMessage({ type: MESSAGE_TYPES.RECORDING_STOPPED });
      resetState();
    });
}

function stopRecordingCommand() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    try {
      mediaRecorder.stop();
    } catch (err) {
      sendMessage({ type: MESSAGE_TYPES.ERROR, text: "Recorder stop failed: " + (err?.message || err) });
      sendMessage({ type: MESSAGE_TYPES.RECORDING_STOPPED });
      resetState();
    }
    return;
  }

  if (currentStream) {
    stopStream();
    sendMessage({ type: MESSAGE_TYPES.RECORDING_STOPPED });
    resetState();
    return;
  }

  sendMessage({ type: MESSAGE_TYPES.WARN, text: "No active recording to stop." });
  sendMessage({ type: MESSAGE_TYPES.RECORDING_STOPPED });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "offscreen") return;

  if (msg.type === MESSAGE_TYPES.START_RECORDING) {
    startRecordingCommand(msg);
  } else if (msg.type === MESSAGE_TYPES.STOP_RECORDING) {
    stopRecordingCommand();
  } else if (msg.type === MESSAGE_TYPES.PING) {
    sendMessage({ type: MESSAGE_TYPES.OFFSCREEN_READY });
  }
});

window.addEventListener("unload", () => {
  resetState();
  sendMessage({ type: MESSAGE_TYPES.OFFSCREEN_CLOSED });
});

sendMessage({ type: MESSAGE_TYPES.OFFSCREEN_READY });
