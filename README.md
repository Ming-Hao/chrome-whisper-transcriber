# chrome-whisper-transcriber

Just a small personal experiment for playing with Chrome Extensions and native messaging.  
This extension captures audio from a browser tab and sends it to a local Python script that runs OpenAI Whisper for transcription.

Originally made to help me quickly see raw Japanese lines while watching anime, without needing to record and upload files manually.

---

## How it works

1. The extension uses `chrome.tabCapture` to record tab audio.
2. When the user clicks **"Stop Recording"**, the recorded audio is sent to a local Python script via Native Messaging.
3. The Python script uses `ffmpeg` to convert the audio to WAV format.
4. The audio is passed into the Whisper model for transcription.
5. The transcribed text is returned and shown in the popup UI.

---

## Setup Instructions

### 1. Use Python 3.10 (Required)

Whisper and PyTorch are **not compatible with Python 3.13** at the time of writing.

```bash
python3.10 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2. Install `ffmpeg`

`ffmpeg` is required to decode audio from WebM to WAV format.

```bash
brew install ffmpeg    # macOS
```

### 3. Register the Native Messaging Host

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

### 4. Load the Extension

1. Go to `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the folder containing `manifest.json`

---

## Usage

1. Click the extension icon to open the popup.
2. Click **Start Recording** to capture tab audio.
3. The tab will continue to play sound normally.
4. Click **Stop Recording** to send the audio for transcription.
5. The result will be shown in the popup log panel.

---

## Requirements

- Python 3.10
- `ffmpeg` (system-installed)
- Google Chrome (or any Chromium-based browser)
- Whisper model (`openai-whisper`), installed via pip

---

## File Structure

```
.
├── popup.html                  # Extension popup UI
├── popup.js                    # JavaScript logic
├── manifest.json               # Chrome extension manifest
├── whisper_host.py             # Native Python host
├── whisper_host.command        # Shell launcher for the host
├── com.example.whisper_test.example.json   # Sample native messaging config
├── requirements.txt
└── README.md
```

---

## License

MIT License.  
Feel free to use, adapt, or extend this project for your own experiments or applications.
