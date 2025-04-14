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
import av

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

def convert_webm_to_wav_array(audio_bytes):
    """
    Convert WebM (Opus codec) audio bytes to a WAV numpy array using PyAV.
    The audio is resampled to 16 kHz mono and returned as a float32 numpy array.
    """
    # Open the audio container from bytes
    container = av.open(io.BytesIO(audio_bytes), format='webm')
    # Get the first audio stream
    stream = container.streams.get(audio=0)[0]

    # Set up the resampler to convert audio to 16kHz mono with planar float (fltp)
    resampler = av.audio.resampler.AudioResampler(
        format='fltp',  # planar float, corresponds to np.float32 data
        layout='mono',  # mono channel
        rate=16000    # 16 kHz sample rate
    )

    frames = []
    # Demux and decode audio packets from the container
    for packet in container.demux(stream):
        for frame in packet.decode():
            # Resample the frame; resample() may return a list of frames
            resampled_frames = resampler.resample(frame)
            # Extend frames list with the resampled frames
            frames.extend(resampled_frames)

    if not frames:
        raise Exception("Decoding audio frames failed.")

    # Convert each audio frame to a numpy array (shape: channels x samples)
    np_frames = [f.to_ndarray() for f in frames]
    # Concatenate all frames along the sample axis
    audio_data = np.concatenate(np_frames, axis=1)
    # Since the output is mono, take the first channel and ensure the data type is float32
    return audio_data[0].astype(np.float32)

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