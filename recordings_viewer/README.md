## Recordings Viewer Server

Local helper that serves the static viewer UI and exposes a minimal API for reading and updating transcripts under `../recordings`.

### Prerequisites

- Go 1.20+ (or compatible)

### Run

```bash
go run viewer_server.go
```

The server listens on `http://localhost:8080/`. Static assets are served from this directory, while `/recordings/` is proxied to `../recordings`.

### API Overview

- `GET /api/transcripts` — list transcript files in `../recordings`.
- `GET /api/transcripts/{path}` — stream the raw transcript content.
- `PUT /api/transcripts/{path}` — replace a transcript with the request body.

All write operations are guarded with a simple mutex and use a temp-file + rename strategy to avoid partial writes. Logs are printed to stdout whenever a `PUT` request is processed.
