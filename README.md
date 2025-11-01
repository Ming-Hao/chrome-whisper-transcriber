# chrome-whisper-transcriber

Just a small personal experiment for playing with Chrome Extensions and native messaging.  
This extension captures audio from a browser tab and sends it to a local Python script that runs OpenAI Whisper for transcription, then lets you instantly replay the captured audio or jump to the saved files from the popup log.

You can now trigger recordings directly with a keyboard shortcut (default `Alt+E`) in addition to the popup buttons.

Originally made to help me quickly see raw Japanese lines while watching anime, without needing to record and upload files manually.

---

## How it works

1. The background service worker ensures an offscreen document (`offscreen.html`) is running to handle MediaRecorder APIs.
2. Recording can be started from the popup or via the `toggle-recording` command (default shortcut `Alt+E`).
3. The offscreen page captures tab audio with `chrome.tabCapture`, packages it as base64 WebM, and relays it to the background script.
4. The background script forwards the audio chunk to the native Python host through Chrome Native Messaging.
5. The Python script decodes the WebM with **PyAV**, converts it to a 16 kHz mono numpy array, and runs Whisper for transcription.
6. The transcribed text (and any save-to-disk status) is returned to the popup log, where you can replay the audio, open the saved folder, or copy the transcript snippet.

---

## Setup Instructions

### 1. Use Python 3.10 (Required)

#### macOS / Linux
```bash
python3.10 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

#### Windows
```cmd
python -m venv venv
.\venv\Scripts\Activate.ps1 
pip install -r requirements.txt
```

### 2. Register the Native Messaging Host

Chrome requires a JSON file to register native messaging hosts. You must copy and modify the included config file:

#### On macOS, place the file at:
```
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.example.chrome_whisper_transcriber.json
```
#### On Windows (Edge / Chrome)
For Windows, you need to register the native messaging host in the system registry.

1. Open **Registry Editor** (`regedit.exe`).
2. Navigate to the key:
   ```
   HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Edge\NativeMessagingHosts
   ```
   *(For Chrome, use `HKEY_LOCAL_MACHINE\SOFTWARE\Google\Chrome\NativeMessagingHosts` instead.)*
3. Create a new key named:
   ```
   com.example.chrome_whisper_transcriber
   ```
4. Set the **default value** of this key to the full path of your JSON file, for example:
   ```
   C:\path\to\your\project\com.example.chrome_whisper_transcriber_win.json
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

#### Notes for Windows
On Windows, set the `path` to point to the `.cmd` file instead, for example:
```
C:\path\to\your\project\whisper_host.cmd
```

If you use a `.ps1` PowerShell script, it may not execute properly — Windows often opens `.ps1` files with Notepad by default instead of running them with PowerShell.  
To ensure correct behavior, use a `.cmd` file (which can internally call PowerShell if needed).

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
- Each result row provides quick actions:
  - ▶️ Replay the recently recorded audio (plays directly in the browser)
  - 📂 Open the output folder for this recording (contains audio.webm and transcript.txt)
  - 📋 Copy the plain text transcription (without timestamps)

### Keyboard Shortcuts

- By default, press Alt+E (or Option⌥+E on macOS) to start or stop recording — no need to open the popup.
- You can reassign the shortcut for “Start or stop Whisper recording” at `chrome://extensions/shortcuts`, and also choose whether it works globally across the system.

---

## Requirements

- Python 3.10 or higher
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
├── whisper_host.command (mac)                    # Shell launcher for the host
├── whisper_host.cmd (win)                        # Shell launcher for the host
├── com.example.chrome_whisper_transcriber.json   # Sample native messaging config
├── requirements.txt
└── README.md
```

---

## License

MIT License.  
Feel free to use, adapt, or extend this project for your own experiments or applications.
