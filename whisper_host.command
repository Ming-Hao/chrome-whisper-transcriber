#!/usr/bin/env bash

PROJECT_DIR="$HOME/Github/chrome-whisper-transcriber"

source "$PROJECT_DIR/venv/bin/activate"
exec "$PROJECT_DIR/venv/bin/python" "$PROJECT_DIR/whisper_host.py"