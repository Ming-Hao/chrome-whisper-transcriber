package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

type transcript struct {
	ID      string `json:"id"`
	Content string `json:"content"`
}

var (
	baseDir           string
	mu                sync.Mutex
	commandFactory    = func(name string, args ...string) command { return exec.Command(name, args...) }
	openerCommandFunc = openerCommand
)

type command interface {
	Start() error
}

func init() {
	// Resolve recordings directory relative to the viewer_server source file.
	_, srcFile, _, ok := runtime.Caller(0)
	if !ok {
		log.Fatal("could not resolve viewer_server.go path")
	}
	viewerDir := filepath.Dir(srcFile)
	baseDir = filepath.Clean(filepath.Join(viewerDir, "..", "recordings"))
	log.Printf("recordings directory: %s", baseDir)
}

func main() {
	mux := http.NewServeMux()

	// Serve viewer static assets
	mux.Handle("/", http.FileServer(http.Dir(".")))

	// Expose recordings directory so the UI can read audio/transcripts
	mux.Handle("/recordings/", http.StripPrefix(
		"/recordings/",
		http.FileServer(http.Dir(baseDir)),
	))

	mux.HandleFunc("/api/transcripts", listTranscripts)
	mux.HandleFunc("/api/transcripts/", transcriptHandler)
	mux.HandleFunc("/api/open-folder", openFolderHandler)

	log.Println("server listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}

func listTranscripts(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	files, err := os.ReadDir(baseDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	items := make([]transcript, 0, len(files))
	for _, f := range files {
		if f.IsDir() {
			continue
		}
		items = append(items, transcript{ID: f.Name()})
	}
	json.NewEncoder(w).Encode(items)
}

func transcriptHandler(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.URL.Path, "/api/transcripts/")
	if rel == "" || strings.HasSuffix(rel, "/") {
		http.Error(w, "missing transcript path", http.StatusBadRequest)
		return
	}

	cleanRel, err := normalizeRecordingsRelative(rel)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	baseClean := filepath.Clean(baseDir)
	fullPath := filepath.Clean(filepath.Join(baseClean, cleanRel))
	if !isInsideBase(fullPath, baseClean) {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodGet:
		http.ServeFile(w, r, fullPath)
	case http.MethodPut:
		mu.Lock()
		defer mu.Unlock()
		log.Printf("PUT %s", rel)

		// Ensure parent directory exists for nested paths
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		tmp := fullPath + ".tmp"
		file, err := os.Create(tmp)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer os.Remove(tmp)
		if n, err := io.Copy(file, r.Body); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		} else {
			log.Printf("wrote %d bytes to %s", n, fullPath)
		}
		file.Close()
		if err := os.Rename(tmp, fullPath); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		log.Printf("updated transcript %s", rel)
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func openFolderHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var payload struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	path := strings.TrimSpace(payload.Path)
	if path == "" {
		http.Error(w, "path is required", http.StatusBadRequest)
		return
	}
	log.Printf("open-folder request path: %s", path)

	cleanRel, err := normalizeRecordingsRelative(path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	baseClean := filepath.Clean(baseDir)
	target := filepath.Clean(filepath.Join(baseClean, cleanRel))
	if !isInsideBase(target, baseClean) {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	info, err := os.Stat(target)
	if err != nil {
		http.Error(w, "folder not found", http.StatusNotFound)
		return
	}
	if !info.IsDir() {
		http.Error(w, "path is not a directory", http.StatusBadRequest)
		return
	}

	log.Printf("open-folder resolved target: %s", target)
	cmdName, args := openerCommandFunc(target)
	if cmdName == "" {
		http.Error(w, "open-folder not supported on this platform", http.StatusNotImplemented)
		return
	}

	cmd := commandFactory(cmdName, args...)
	if err := cmd.Start(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func openerCommand(path string) (string, []string) {
	switch runtime.GOOS {
	case "darwin":
		return "open", []string{path}
	case "windows":
		return "explorer", []string{path}
	case "linux":
		return "xdg-open", []string{path}
	default:
		return "", nil
	}
}

// normalizeRecordingsRelative converts a possibly absolute or mixed-slash path into a
// relative path under the recordings base. It strips any leading occurrences of
// "recordings/" and anything before the last "/recordings/" segment. It rejects
// absolute or parent-directory traversals.
func normalizeRecordingsRelative(p string) (string, error) {
	s := strings.TrimSpace(p)
    if s == "" {
        return "", fmt.Errorf("invalid path")
    }
	// unify slashes
	s = strings.ReplaceAll(s, "\\", "/")
	l := strings.ToLower(s)
	if i := strings.LastIndex(l, "/recordings/"); i >= 0 {
        s = s[i+len("/recordings/"):]
    }
    // strip repeated leading recordings/
    for {
        ll := strings.ToLower(s)
        if strings.HasPrefix(ll, "recordings/") {
            s = s[len("recordings/"):]
        } else {
            break
        }
    }
    s = strings.TrimPrefix(s, "/")
    s = filepath.Clean(s)
    if s == "." || strings.HasPrefix(s, "..") || filepath.IsAbs(s) {
        return "", fmt.Errorf("invalid path")
    }
    return s, nil
}

// isInsideBase checks that p is at or within base.
func isInsideBase(p, base string) bool {
    base = filepath.Clean(base)
    p = filepath.Clean(p)
    rel, err := filepath.Rel(base, p)
    if err != nil {
        return false
    }
    return rel == "." || (!strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel))
}
