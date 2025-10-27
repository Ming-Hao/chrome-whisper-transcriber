import base64
import io
from datetime import datetime
from pathlib import Path
import uuid

import numpy as np
import av


def convert_webm_to_wav_array(audio_bytes):
    """
    Convert WebM (Opus) audio bytes to a 16 kHz mono float32 numpy array.
    This function is pure and easy to unit test by supplying synthetic audio.
    """
    container = av.open(io.BytesIO(audio_bytes), format="webm")
    stream = container.streams.get(audio=0)[0]

    resampler = av.audio.resampler.AudioResampler(
        format="fltp",
        layout="mono",
        rate=16000,
    )

    frames = []
    for packet in container.demux(stream):
        for frame in packet.decode():
            frames.extend(resampler.resample(frame))

    if not frames:
        raise ValueError("Decoding audio frames failed.")

    np_frames = [frame.to_ndarray() for frame in frames]
    audio_data = np.concatenate(np_frames, axis=1)
    return audio_data[0].astype(np.float32)


def save_audio_bytes(audio_bytes, output_dir="recordings"):
    """Persist raw WebM bytes to disk and return the file path."""
    output_dir_path = Path(output_dir)
    output_dir_path.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    token = uuid.uuid4().hex[:6]
    filename = f"recording-{timestamp}-{token}.webm"
    file_path = output_dir_path / filename

    with file_path.open("wb") as f:
        f.write(audio_bytes)

    return str(file_path)


def transcribe_audio_chunk(audio_chunk_b64, model, save_to_disk=False, output_dir="recordings"):
    """
    Decode a base64-encoded WebM chunk, optionally save it, convert to wav array,
    and run Whisper. Returns a tuple of (transcript, saved_path).
    """
    audio_bytes = base64.b64decode(audio_chunk_b64)

    saved_path = None
    if save_to_disk:
        saved_path = save_audio_bytes(audio_bytes, output_dir)

    wav_array = convert_webm_to_wav_array(audio_bytes)
    result = model.transcribe(wav_array)
    text = result.get("text", "").strip()
    return (text or "[Empty]", saved_path)
