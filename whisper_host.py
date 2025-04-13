import sys
import struct
import json
import base64
import whisper
import subprocess
import os
import io
import soundfile as sf
import numpy as np

# Load Whisper model (use "base" for a good balance of speed and accuracy)
model = whisper.load_model("base")

# Ensure ffmpeg is in PATH
os.environ["PATH"] += os.pathsep + "/opt/homebrew/bin"

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

def convert_webm_to_wav_array(audio_bytes):
    """
    Converts audio from WebM (Opus codec, recorded by MediaRecorder) to WAV format using ffmpeg,
    then loads it as a float32 numpy array compatible with Whisper.
    """
    command = [
        "/opt/homebrew/bin/ffmpeg",
        "-y",               # Overwrite output
        "-f", "webm",       # Input format: WebM
        "-i", "-",          # Read input from stdin
        # "-c:a", "libopus",  # Optional: explicitly decode Opus
        "-ar", "16000",     # Resample to 16 kHz
        "-ac", "1",         # Convert to mono
        "-f", "wav",        # Output format: WAV
        "-"                 # Write output to stdout
    ]
    
    result = subprocess.run(
        command,
        input=audio_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    
    if result.returncode != 0:
        error_str = result.stderr.decode("utf-8")
        print("ffmpeg conversion error:", error_str, file=sys.stderr)
        raise Exception("ffmpeg failed: " + error_str)
    
    wav_bytes = result.stdout
    wav_file = io.BytesIO(wav_bytes)
    
    try:
        data, samplerate = sf.read(wav_file)
    except Exception as e:
        raise Exception("Failed to read WAV: " + str(e))
    
    return data.astype(np.float32)

print("Whisper host started", file=sys.stderr)
while True:
    msg = read_message()
    if msg is None:
        break

    if "audioChunk" in msg:
        try:
            print("Received audio chunk", file=sys.stderr)

            # Decode base64-encoded WebM audio bytes
            audio_bytes = base64.b64decode(msg["audioChunk"])

            # Convert to WAV and load as numpy array
            wav_array = convert_webm_to_wav_array(audio_bytes)

            # Run Whisper transcription
            result = model.transcribe(wav_array)
            text = result.get("text", "").strip()
            print("Transcription result:", text, file=sys.stderr)

            # Send result back to extension
            send_message({ "text": text or "[Empty]" })

        except Exception as e:
            print("Error:", str(e), file=sys.stderr)
            send_message({ "text": f"[Error] {str(e)}" })