import base64
import io
import os
import platform
import re
import subprocess
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


MAX_PREFIX_CHARS = 60


def _build_folder_prefix(tab_title):
    if not tab_title or not tab_title.strip():
        return "recording"

    collapsed = re.sub(r"\s+", " ", tab_title).strip()
    sanitized = re.sub(r"[\\/:*?\"<>|]+", "_", collapsed)
    trimmed = sanitized.replace("\0", "")[:MAX_PREFIX_CHARS].strip()
    cleaned = trimmed.strip("._-")
    return cleaned or "recording"


def save_recording_bundle(audio_bytes, transcript_text, output_dir="recordings", tab_title=None):
    """Persist audio and transcript into a timestamped folder and return the paths."""
    output_dir_path = Path(output_dir)
    output_dir_path.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    token = uuid.uuid4().hex[:6]
    prefix = _build_folder_prefix(tab_title)
    folder_path = output_dir_path / f"{prefix}-{timestamp}-{token}"
    folder_path.mkdir(parents=True, exist_ok=True)

    audio_path = folder_path / "audio.webm"
    text_path = folder_path / "transcript.txt"

    with audio_path.open("wb") as f:
        f.write(audio_bytes)

    with text_path.open("w", encoding="utf-8") as f:
        f.write(transcript_text)

    return {
        "folder": str(folder_path),
        "audio": str(audio_path),
        "text": str(text_path),
    }


def ensure_recordings_root(output_dir="recordings"):
    """
    Ensure the recordings root directory exists and return it as a Path.
    """
    output_dir_path = Path(output_dir)
    output_dir_path.mkdir(parents=True, exist_ok=True)
    return output_dir_path


def open_recordings_folder(output_dir="recordings"):
    """
    Open the recordings folder in the user's file explorer. Returns the folder path.
    """
    folder_path = ensure_recordings_root(output_dir)
    folder_str = str(folder_path)
    system = platform.system()

    try:
        if system == "Windows":
            os.startfile(folder_str)  # type: ignore[attr-defined]
        elif system == "Darwin":
            subprocess.Popen(["open", folder_str])
        else:
            subprocess.Popen(["xdg-open", folder_str])
    except Exception as exc:
        raise RuntimeError(f"Unable to open recordings folder: {exc}") from exc

    return folder_str


def open_specific_folder(folder_path):
    """
    Open a specific folder path in the user's file explorer. Returns the folder path.
    """
    if not folder_path:
        raise ValueError("Folder path is required.")

    folder = Path(folder_path)
    if folder.is_file():
        folder = folder.parent
    if not folder.exists():
        raise FileNotFoundError(f"Folder does not exist: {folder}")

    folder_str = str(folder)
    system = platform.system()

    try:
        if system == "Windows":
            os.startfile(folder_str)  # type: ignore[attr-defined]
        elif system == "Darwin":
            subprocess.Popen(["open", folder_str])
        else:
            subprocess.Popen(["xdg-open", folder_str])
    except Exception as exc:
        raise RuntimeError(f"Unable to open folder: {exc}") from exc

    return folder_str


def transcribe_audio_chunk(audio_chunk_b64, model, save_to_disk=False, output_dir="recordings", tab_title=None):
    """
    Decode a base64-encoded WebM chunk, optionally save it, convert to wav array,
    and run Whisper. Returns a tuple of (transcript, saved_path).
    """
    audio_bytes = base64.b64decode(audio_chunk_b64)

    wav_array = convert_webm_to_wav_array(audio_bytes)
    result = model.transcribe(wav_array)
    text = result.get("text", "").strip()
    final_text = text or "[Empty]"

    saved_paths = None
    if save_to_disk:
        saved_paths = save_recording_bundle(audio_bytes, final_text, output_dir, tab_title=tab_title)

    return (final_text, saved_paths)
