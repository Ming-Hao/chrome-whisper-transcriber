import base64
import json
import logging
import os
import struct
import sys
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, Optional

import whisper

from whisper_host_utils import (
    open_recordings_folder,
    open_specific_folder,
    load_history_entries,
    transcribe_audio_chunk,
)

logger = logging.getLogger("whisper_host")


def setup_logging() -> None:
    """
    Configure logging outputs for the host process.

    Environment variables:
      WHISPER_HOST_LOG_PATH: explicit log file path.
      WHISPER_HOST_LOG_DIR: directory for the default log filename.
      WHISPER_HOST_LOG_LEVEL: logging level name (default: INFO).
      WHISPER_HOST_LOG_MAX_BYTES: rotate size threshold (default: 5,000,000).
      WHISPER_HOST_LOG_BACKUP_COUNT: rotated file count (default: 3).
    """
    log_path_env = os.getenv("WHISPER_HOST_LOG_PATH")
    if log_path_env:
        log_file = Path(log_path_env).expanduser()
        log_file.parent.mkdir(parents=True, exist_ok=True)
    else:
        log_dir_env = os.getenv("WHISPER_HOST_LOG_DIR")
        if log_dir_env:
            log_dir = Path(log_dir_env).expanduser()
        else:
            log_dir = Path(__file__).resolve().parent / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        log_file = log_dir / f"whisper_host-{timestamp}.log"

    max_bytes = int(os.getenv("WHISPER_HOST_LOG_MAX_BYTES", "5000000"))
    backup_count = int(os.getenv("WHISPER_HOST_LOG_BACKUP_COUNT", "3"))
    level_name = os.getenv("WHISPER_HOST_LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)

    logger.setLevel(level)

    if logger.handlers:
        return

    formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")

    file_handler = RotatingFileHandler(
        log_file,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)

    stream_handler = logging.StreamHandler(sys.stderr)
    stream_handler.setFormatter(formatter)

    logger.addHandler(file_handler)
    logger.addHandler(stream_handler)
    logger.propagate = False

    logger.debug("Logging configured level=%s file=%s", level_name, log_file)


setup_logging()
logger.info("Starting Whisper host process")

logger.info("Loading Whisper model 'base'")
model = whisper.load_model("base")
logger.info("Whisper model ready")


def send_message(message: Dict[str, Any]) -> None:
    try:
        encoded = json.dumps(message).encode("utf-8")
    except (TypeError, ValueError):
        logger.exception("Failed to serialize message for sending")
        return

    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

    msg_type = message.get("type") if isinstance(message, dict) else None
    logger.debug("Sent message type=%s", msg_type)


def read_message() -> Optional[Dict[str, Any]]:
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        logger.info("Input stream closed by browser")
        return None

    message_length = struct.unpack("<I", raw_length)[0]
    message_bytes = sys.stdin.buffer.read(message_length)

    try:
        payload = json.loads(message_bytes.decode("utf-8"))
    except json.JSONDecodeError:
        logger.exception("Unable to decode incoming message payload")
        send_message(
            {
                "type": "error",
                "text": "Invalid message payload received by native host.",
            }
        )
        return {}

    if isinstance(payload, dict):
        msg_type = payload.get("type") or payload.get("command")
        logger.debug("Received message type=%s keys=%s", msg_type, list(payload.keys()))
    else:
        logger.warning("Ignoring non-dictionary message: %s", type(payload).__name__)
        return {}
    return payload


send_message({"type": "status", "text": "Whisper host started"})
send_message({"type": "status", "text": "ModelReady"})

while True:
    msg = read_message()
    if msg is None:
        break
    if not msg:
        logger.debug("Skipping empty message payload")
        continue

    command = msg.get("command")

    if command == "open-recordings-folder":
        output_dir = msg.get("outputDir", "recordings")
        try:
            folder_path = open_recordings_folder(output_dir=output_dir)
            send_message(
                {"type": "status", "text": f"Recordings folder opened: {folder_path}"}
            )
            logger.info("Opened recordings folder: %s", folder_path)
        except Exception as exc:
            error_text = f"Failed to open recordings folder: {exc}"
            logger.exception("Unable to open recordings folder for %s", output_dir)
            send_message({"type": "error", "text": error_text})
        continue

    if command == "open-folder":
        folder_path = msg.get("path")
        try:
            opened = open_specific_folder(folder_path)
            send_message({"type": "status", "text": f"Opened saved folder: {opened}"})
            logger.info("Opened folder requested by extension: %s", opened)
        except Exception as exc:
            error_text = f"Failed to open saved folder: {exc}"
            logger.exception("Unable to open requested folder: %s", folder_path)
            send_message({"type": "error", "text": error_text})
        continue

    if command == "load-tab-history":
        request_id = msg.get("requestId")
        tab_uuid = msg.get("tabUUID")
        output_dir = msg.get("outputDir", "recordings")
        limit = msg.get("limit")
        include_transcripts = msg.get("includeTranscripts", True)
        try:
            entries = load_history_entries(
                tab_uuid=tab_uuid,
                output_dir=output_dir,
                limit=limit,
                include_transcripts=include_transcripts,
            )
            send_message(
                {
                    "type": "tab-history-result",
                    "requestId": request_id,
                    "tabUUID": tab_uuid,
                    "entries": entries,
                }
            )
        except Exception as exc:
            logger.exception("Unable to load tab history for %s", tab_uuid)
            send_message(
                {
                    "type": "tab-history-error",
                    "requestId": request_id,
                    "tabUUID": tab_uuid,
                    "text": f"Unable to load tab history: {exc}",
                }
            )
        continue

    if command == "load-audio-file":
        request_id = msg.get("requestId")
        audio_path = msg.get("path")
        try:
            if not audio_path:
                raise ValueError("Missing audio file path.")
            with open(audio_path, "rb") as audio_file:
                audio_bytes = audio_file.read()
            encoded_audio = base64.b64encode(audio_bytes).decode("ascii")
            send_message(
                {
                    "type": "audio-file",
                    "requestId": request_id,
                    "path": audio_path,
                    "mimeType": msg.get("mimeType", "audio/webm"),
                    "base64": encoded_audio,
                }
            )
            logger.info(
                "Loaded audio file for request %s from %s", request_id, audio_path
            )
        except Exception as exc:
            error_text = f"Unable to load audio file: {exc}"
            logger.exception("Unable to load audio file: %s", audio_path)
            send_message(
                {
                    "type": "audio-file-error",
                    "requestId": request_id,
                    "path": audio_path,
                    "text": error_text,
                }
            )
        continue

    if "audioChunk" in msg:
        try:
            audio_chunk = msg["audioChunk"]
            chunk_len = len(audio_chunk) if isinstance(audio_chunk, str) else 0
            logger.info(
                "Processing audio chunk (length=%s, save_to_disk=%s)",
                chunk_len,
                msg.get("saveToDisk", True),
            )

            # logger info log the msg data
            logger.info("Transcription message data: %s", {k: v for k, v in msg.items() if k != "audioChunk"})
            text, saved_paths = transcribe_audio_chunk(
                audio_chunk,
                model,
                save_to_disk=msg.get("saveToDisk", True),
                tab_title=msg.get("tabTitle"),
                tab_uuid=msg.get("tabUUID"),
                tab_id=msg.get("tabId"),
                tab_url=msg.get("tabURL"),
            )
            display_text = text if len(text) <= 120 else f"{text[:117]}..."
            logger.info("Transcription complete: %s", display_text)
            if saved_paths:
                logger.info("Saved recording bundle: %s", saved_paths)

            result_payload = {"type": "result", "text": text}
            if saved_paths:
                folder = saved_paths.get("folder") or saved_paths.get("audio")
                result_payload["savedPaths"] = saved_paths
                send_message(
                    {"type": "status", "text": f"Saved audio & transcript to {folder}"}
                )

            send_message(result_payload)

        except Exception as exc:
            logger.exception("Transcription failed")
            send_message({"type": "error", "text": f"[Error] {exc}"})
        continue

    logger.debug("Unhandled message keys=%s", list(msg.keys()))

logger.info("Whisper host shutting down")
