# chrome-whisper-transcriber

Just a small personal experiment for playing with Chrome Extensions and native messaging.  
This extension captures audio from a browser tab and sends it to a local Python script that runs OpenAI Whisper for transcription.

You can now trigger recordings directly with a keyboard shortcut (default `Alt+E`) in addition to the popup buttons.

Originally made to help me quickly see raw Japanese lines while watching anime, without needing to record and upload files manually.

---

## How it works

1. The background service worker ensures an offscreen document (`offscreen.html`) is running to handle MediaRecorder APIs.
2. Recording can be started from the popup or via the `toggle-recording` command (default shortcut `Alt+E`).
3. The offscreen page captures tab audio with `chrome.tabCapture`, packages it as base64 WebM, and relays it to the background script.
4. The background script forwards the audio chunk to the native Python host through Chrome Native Messaging.
5. The Python script decodes the WebM with **PyAV**, converts it to a 16 kHz mono numpy array, and runs Whisper for transcription.
6. The transcribed text (and any save-to-disk status) is returned and displayed in the popup log.

---

## Setup Instructions

### 1. Use Python 3.10 (Required)

Whisper and PyTorch are **not compatible with Python 3.13** at the time of writing.

```bash
python3.10 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2. Register the Native Messaging Host

Chrome requires a JSON file to register native messaging hosts. You must copy and modify the included config file:

#### On macOS, place the file at:
```
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.example.chrome_whisper_transcriber.json
```

#### Steps:

```bash
cp com.example.chrome_whisper_transcriber.json ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.example.chrome_whisper_transcriber.json
```

Then **edit the following fields in the JSON file**:

```json
{
  "name": "com.example.whisper_test",
  "description": "Whisper Native Host",
  "path": "/absolute/path/to/your/project/whisper_host.command",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://<your-extension-id>/"
  ]
}
```

#### What to change:

- `"path"`: Set this to the **absolute path** of your `whisper_host.command` file. Do **not** use `~` or `$HOME`.
- `"allowed_origins"`: Replace `<your-extension-id>` with your actual extension ID, which you can find in `chrome://extensions/`.

---

### 3. Load the Extension

1. Go to `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the folder containing `manifest.json`

---

## Usage

- Click the extension icon to open the popup (if the suggested shortcut `Ctrl+Shift+Y` / `Command+Shift+Y` is still set, that works too).
- Press **Start Recording** to capture tab audio; playback continues through your speakers or headphones.
- Press **Stop Recording** to send the audio for transcription and see the transcript in the log.

### Keyboard Shortcuts

- By default, press Alt+E (or Option⌥+E on macOS) to start or stop recording — no need to open the popup.
- You can reassign the shortcut for “Start or stop Whisper recording” at `chrome://extensions/shortcuts`, and also choose whether it works globally across the system.

---

## Requirements

- Python 3.10
- Google Chrome (or any Chromium-based browser)
- Whisper model (`openai-whisper`), installed via pip

---

## File Structure

```
.
├── manifest.json                                 # Chrome extension manifest
├── background.js                                 # Service worker orchestrating capture flow
├── offscreen.html                                # Offscreen document bootstrapping MediaRecorder
├── offscreen.js                                  # Offscreen recording + audio forwarding logic
├── popup.html                                    # Popup UI
├── popup.js                                      # Popup controller and log rendering
├── icons/
│   └── microphone-black-shape.png                # Toolbar icon
├── whisper_host.py                               # Native Python host
├── whisper_host_utils.py                         # Audio conversion + transcription helpers
├── tests/
│   └── test_whisper_host_utils.py                # Unit tests for host utilities
├── recordings/                                   # Runtime output (audio + transcript bundles)
├── whisper_host.command                          # Shell launcher for the host
├── com.example.chrome_whisper_transcriber.json   # Sample native messaging config
├── requirements.txt
└── README.md
```

---

## License

MIT License.  
Feel free to use, adapt, or extend this project for your own experiments or applications.
