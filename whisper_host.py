import sys
import struct
import json
import base64
import whisper

from whisper_host_utils import transcribe_audio_chunk, open_recordings_folder, open_specific_folder

# Load Whisper model (use "base" for a good balance of speed and accuracy)
model = whisper.load_model("base")

def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    message_length = struct.unpack("<I", raw_length)[0]
    message = sys.stdin.buffer.read(message_length).decode("utf-8")
    return json.loads(message)

def send_message(message):
    encoded = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

print("Whisper host started", file=sys.stderr)
send_message({ "type": "status", "text": "Whisper host started" })
send_message({ "type": "status", "text": "ModelReady" })

while True:
    msg = read_message()
    if msg is None:
        break

    if msg.get("command") == "open-recordings-folder":
        try:
            folder_path = open_recordings_folder(output_dir=msg.get("outputDir", "recordings"))
            send_message({ "type": "status", "text": f"Recordings folder opened: {folder_path}" })
            print(f"Opened recordings folder at {folder_path}", file=sys.stderr)
        except Exception as e:
            error_text = f"Failed to open recordings folder: {str(e)}"
            print(error_text, file=sys.stderr)
            send_message({ "type": "error", "text": error_text })
        continue

    if msg.get("command") == "open-folder":
        folder_path = msg.get("path")
        try:
            opened = open_specific_folder(folder_path)
            send_message({ "type": "status", "text": f"Opened saved folder: {opened}" })
            print(f"Opened saved folder at {opened}", file=sys.stderr)
        except Exception as e:
            error_text = f"Failed to open saved folder: {str(e)}"
            print(error_text, file=sys.stderr)
            send_message({ "type": "error", "text": error_text })
        continue

    if msg.get("command") == "load-audio-file":
        request_id = msg.get("requestId")
        audio_path = msg.get("path")
        try:
            if not audio_path:
                raise ValueError("Missing audio file path.")
            with open(audio_path, "rb") as audio_file:
                audio_bytes = audio_file.read()
            encoded_audio = base64.b64encode(audio_bytes).decode("ascii")
            send_message({
                "type": "audio-file",
                "requestId": request_id,
                "path": audio_path,
                "mimeType": msg.get("mimeType", "audio/webm"),
                "base64": encoded_audio,
            })
        except Exception as e:
            error_text = f"Unable to load audio file: {str(e)}"
            print(error_text, file=sys.stderr)
            send_message({
                "type": "audio-file-error",
                "requestId": request_id,
                "path": audio_path,
                "text": error_text,
            })
        continue

    if "audioChunk" in msg:
        try:
            print("Received audio chunk", file=sys.stderr)

            text, saved_paths = transcribe_audio_chunk(
                msg["audioChunk"],
                model,
                save_to_disk=msg.get("saveToDisk", True),
                tab_title=msg.get("tabTitle"),
            )
            print("Transcription result:", text, file=sys.stderr)
            if saved_paths:
                folder = saved_paths.get("folder")
                audio_path = saved_paths.get("audio")
                text_path = saved_paths.get("text")
                if folder:
                    print("Files saved under", folder, file=sys.stderr)
                if audio_path:
                    print("Audio file:", audio_path, file=sys.stderr)
                if text_path:
                    print("Transcript file:", text_path, file=sys.stderr)

            # Send result back to extension
            result_payload = { "type": "result", "text": text }
            if saved_paths:
                folder = saved_paths.get("folder") or saved_paths.get("audio")
                result_payload["savedPaths"] = saved_paths
                send_message({ "type": "status", "text": f"Saved audio & transcript to {folder}" })

            send_message(result_payload)

        except Exception as e:
            print("Error:", str(e), file=sys.stderr)
            send_message({ "type": "error", "text": f"[Error] {str(e)}" })
