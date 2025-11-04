package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type transcript struct {
	ID      string `json:"id"`
	Content string `json:"content"`
}

var (
	baseDir = filepath.Clean("../recordings") // Adjust to match actual recordings directory
	mu      sync.Mutex
)

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
