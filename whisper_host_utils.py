import base64
import io
import json
import logging
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
    """
    Cleans and truncates a tab title to create a safe folder prefix.

    This function removes characters that are unsafe for file paths,
    handles excessive whitespace, and ensures the resulting prefix
    is within a maximum length, preventing path traversal vulnerabilities.

    Examples:
        >>> _build_folder_prefix("My awesome Video Title!")
        'My awesome Video Title'
        >>> _build_folder_prefix("../../etc/passwd")
        'etcpasswd'
        >>> _build_folder_prefix("  Some   Title with special chars /\\:*?\"<>| and dots.. ")
        'Some Title with special chars and dots'
        >>> _build_folder_prefix("")
        'recording'
        >>> _build_folder_prefix("   ")
        'recording'
    """
    if not tab_title or not tab_title.strip():
        return "recording"

    # Remove leading/trailing whitespace
    cleaned_title = tab_title.strip()

    # Replace any character that is NOT alphanumeric, space, hyphen, or underscore with an empty string.
    # This is much stricter than the original regex and prevents common path traversal techniques.
    cleaned_title = re.sub(r'[^\w\s-]', '', cleaned_title)

    # Replace multiple spaces with a single space and trim whitespace again
    cleaned_title = re.sub(r'\s+', ' ', cleaned_title).strip()

    # Ensure no leading/trailing dots or hyphens that might be problematic in some systems
    # For example, "..." or "---" might be interpreted strangely or just look bad.
    cleaned_title = cleaned_title.strip('.-_')

    # Trim to MAX_PREFIX_CHARS
    trimmed = cleaned_title[:MAX_PREFIX_CHARS].strip()

    # If the trimmed name is empty after all sanitization, use "recording"
    return trimmed or "recording"


def save_recording_bundle(
    audio_bytes,
    transcript_text,
    output_dir="recordings",
    tab_title=None,
    tab_uuid=None,
    tab_id=None,
    tab_url=None,
):
    """Persist audio and transcript into a timestamped folder and return the paths."""
    output_dir_path = Path(output_dir)
    output_dir_path.mkdir(parents=True, exist_ok=True)

    if tab_uuid:
        tab_root = output_dir_path / tab_uuid
    else:
        tab_root = output_dir_path
    tab_root.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    token = uuid.uuid4().hex[:6]
    prefix = _build_folder_prefix(tab_title)
    folder_path = tab_root / f"{prefix}-{timestamp}-{token}"
    folder_path.mkdir(parents=True, exist_ok=True)

    audio_path = folder_path / "audio.webm"
    text_path = folder_path / "transcript.txt"
    history_path = (tab_root if tab_uuid else output_dir_path) / "history.jsonl"

    with audio_path.open("wb") as f:
        f.write(audio_bytes)

    with text_path.open("w", encoding="utf-8") as f:
        f.write(transcript_text)

    metadata_path = None
    if tab_uuid:
        metadata = {
            "tabUUID": tab_uuid,
            "lastTabId": tab_id,
            "lastTitle": tab_title,
            "lastURL": tab_url,
            "updatedAt": datetime.now().isoformat(timespec="seconds") + "Z",
            "lastRecordingFolder": str(folder_path),
        }
        metadata_path = tab_root / "tab.json"
        with metadata_path.open("w", encoding="utf-8") as f:
            json.dump(metadata, f, ensure_ascii=False, indent=2)

    history_entry = {
        "createdAt": datetime.now().isoformat(timespec="seconds") + "Z",
        "folder": str(folder_path),
        "audio": str(audio_path),
        "text": str(text_path),
        "tabUUID": tab_uuid,
        "tabId": tab_id,
        "tabTitle": tab_title,
        "tabURL": tab_url,
    }
    try:
        with history_path.open("a", encoding="utf-8") as f:
            json.dump(history_entry, f, ensure_ascii=False)
            f.write("\n")
    except OSError as exc:
        logging.warning("Failed to append history entry to %s: %s", history_path, exc)

    result = {
        "folder": str(folder_path),
        "audio": str(audio_path),
        "text": str(text_path),
    }
    if tab_uuid:
        result["tabFolder"] = str(tab_root)
        if metadata_path:
            result["metadata"] = str(metadata_path)
    return result


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
    try:
        return open_specific_folder(folder_path)
    except Exception as exc:
        raise RuntimeError(f"Unable to open recordings folder: {exc}") from exc


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


def _resolve_history_path(tab_uuid=None, output_dir="recordings"):
    base = Path(output_dir)
    if tab_uuid:
        return base / tab_uuid / "history.jsonl"
    return base / "history.jsonl"


def _parse_history_timestamp(value):
    if not value:
        return datetime.min
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.min


def load_history_entries(tab_uuid=None, output_dir="recordings", limit=None, include_transcripts=True):
    """
    Load history records for the given tab UUID from history.jsonl.

    Returns a list sorted by createdAt desc. Each entry includes transcript text if requested.
    """
    history_path = _resolve_history_path(tab_uuid, output_dir=output_dir)
    if not history_path.exists():
        return []

    entries = []
    try:
        with history_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    record = json.loads(stripped)
                except json.JSONDecodeError:
                    logging.warning("Skipping malformed history line in %s", history_path)
                    continue
                entries.append(record)
    except OSError as exc:
        logging.error("Failed to read history file %s: %s", history_path, exc)
        return []

    entries.sort(
        key=lambda entry: _parse_history_timestamp(entry.get("createdAt")),
        reverse=True,
    )

    if isinstance(limit, int) and limit > 0:
        entries = entries[:limit]

    if not include_transcripts:
        return entries

    enriched = []
    for entry in entries:
        enriched_entry = dict(entry)
        text_path_str = entry.get("text")
        transcript_text = None
        if text_path_str:
            text_path = Path(text_path_str)
            if not text_path.is_absolute():
                text_path = (Path.cwd() / text_path).resolve()
            try:
                with text_path.open("r", encoding="utf-8") as transcript_handle:
                    transcript_text = transcript_handle.read().strip()
            except OSError as exc:
                logging.warning("Unable to read transcript for history entry %s: %s", text_path, exc)
        if transcript_text is not None:
            enriched_entry["transcript"] = transcript_text
        enriched.append(enriched_entry)
    return enriched


def transcribe_audio_chunk(
    audio_chunk_b64,
    model,
    save_to_disk=False,
    output_dir="recordings",
    tab_title=None,
    tab_uuid=None,
    tab_id=None,
    tab_url=None,
):
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
        saved_paths = save_recording_bundle(
            audio_bytes,
            final_text,
            output_dir,
            tab_title=tab_title,
            tab_uuid=tab_uuid,
            tab_id=tab_id,
            tab_url=tab_url,
        )

    return (final_text, saved_paths)
