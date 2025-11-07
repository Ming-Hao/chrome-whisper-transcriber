package main

import (
	"encoding/json"
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
	rel = strings.TrimPrefix(rel, "recordings/")
	rel = filepath.Clean(rel)
	if rel == "." || strings.HasPrefix(rel, "..") {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	fullPath := filepath.Join(baseDir, rel)
	baseClean := filepath.Clean(baseDir)
	if !strings.HasPrefix(fullPath, baseClean+string(os.PathSeparator)) && fullPath != baseClean {
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

	path = strings.TrimPrefix(path, "recordings/")
	path = filepath.Clean(path)
	if filepath.IsAbs(path) {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	if path == "." || strings.HasPrefix(path, "..") {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}

	target := filepath.Join(baseDir, path)
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
