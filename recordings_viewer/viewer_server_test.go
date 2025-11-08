package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeCommand struct {
	startErr error
	started  bool
}

func (f *fakeCommand) Start() error {
	f.started = true
	return f.startErr
}

func useTempBaseDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	orig := baseDir
	baseDir = dir
	t.Cleanup(func() {
		baseDir = orig
	})
	return dir
}

func TestListTranscripts(t *testing.T) {
	dir := useTempBaseDir(t)
	wantFiles := []string{"a.txt", "b.json"}
	for _, name := range wantFiles {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("ok"), 0o644); err != nil {
			t.Fatalf("write file %s: %v", name, err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "nested"), 0o755); err != nil {
		t.Fatalf("mkdir nested: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/transcripts", nil)
	rec := httptest.NewRecorder()

	listTranscripts(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("status=%d want %d", res.StatusCode, http.StatusOK)
	}

	var items []transcript
	if err := json.NewDecoder(res.Body).Decode(&items); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(items) != len(wantFiles) {
		t.Fatalf("got %d items want %d", len(items), len(wantFiles))
	}
	got := map[string]bool{}
	for _, item := range items {
		got[item.ID] = true
	}
	for _, name := range wantFiles {
		if !got[name] {
			t.Fatalf("missing transcript %s in response", name)
		}
	}
}

func TestTranscriptHandlerGet(t *testing.T) {
	dir := useTempBaseDir(t)
	body := "hello world"
	file := "sample.txt"
	if err := os.WriteFile(filepath.Join(dir, file), []byte(body), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/transcripts/"+file, nil)
	rec := httptest.NewRecorder()

	transcriptHandler(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("status=%d want %d", res.StatusCode, http.StatusOK)
	}
	data, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if string(data) != body {
		t.Fatalf("body=%q want %q", string(data), body)
	}
}

func TestTranscriptHandlerPut(t *testing.T) {
	dir := useTempBaseDir(t)
	file := "updated.txt"
	content := "new content"

	req := httptest.NewRequest(http.MethodPut, "/api/transcripts/"+file, strings.NewReader(content))
	rec := httptest.NewRecorder()

	transcriptHandler(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("status=%d want %d", res.StatusCode, http.StatusNoContent)
	}

	data, err := os.ReadFile(filepath.Join(dir, file))
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	if string(data) != content {
		t.Fatalf("file content=%q want %q", string(data), content)
	}
}

func TestTranscriptHandlerRejectsInvalidPath(t *testing.T) {
	useTempBaseDir(t)
	req := httptest.NewRequest(http.MethodGet, "/api/transcripts/../secret.txt", nil)
	rec := httptest.NewRecorder()

	transcriptHandler(rec, req)

	if rec.Result().StatusCode != http.StatusBadRequest {
		t.Fatalf("status=%d want %d", rec.Result().StatusCode, http.StatusBadRequest)
	}
}

func TestTranscriptHandlerPutWithRecordingsPrefix(t *testing.T) {
    dir := useTempBaseDir(t)
    file := "withprefix.txt"
    content := "abc123"

    req := httptest.NewRequest(http.MethodPut, "/api/transcripts/recordings/"+file, strings.NewReader(content))
    rec := httptest.NewRecorder()

    transcriptHandler(rec, req)

    res := rec.Result()
    defer res.Body.Close()

    if res.StatusCode != http.StatusNoContent {
        t.Fatalf("status=%d want %d", res.StatusCode, http.StatusNoContent)
    }

    data, err := os.ReadFile(filepath.Join(dir, file))
    if err != nil {
        t.Fatalf("read file: %v", err)
    }
    if string(data) != content {
        t.Fatalf("file content=%q want %q", string(data), content)
    }
}

func TestTranscriptHandlerPutWithDoubleRecordingsPrefix(t *testing.T) {
    dir := useTempBaseDir(t)
    file := "doubleprefix.txt"
    content := "xyz"

    req := httptest.NewRequest(http.MethodPut, "/api/transcripts/recordings/recordings/"+file, strings.NewReader(content))
    rec := httptest.NewRecorder()

    transcriptHandler(rec, req)

    res := rec.Result()
    defer res.Body.Close()

    if res.StatusCode != http.StatusNoContent {
        t.Fatalf("status=%d want %d", res.StatusCode, http.StatusNoContent)
    }

    data, err := os.ReadFile(filepath.Join(dir, file))
    if err != nil {
        t.Fatalf("read file: %v", err)
    }
    if string(data) != content {
        t.Fatalf("file content=%q want %q", string(data), content)
    }
}

func TestOpenFolderHandlerSuccess(t *testing.T) {
	dir := useTempBaseDir(t)
	target := "session"
	absTarget := filepath.Join(dir, target)
	if err := os.Mkdir(absTarget, 0o755); err != nil {
		t.Fatalf("mkdir target: %v", err)
	}

	origOpener := openerCommandFunc
	var gotOpenerPath string
	openerCommandFunc = func(path string) (string, []string) {
		gotOpenerPath = path
		return "open", []string{path}
	}
	t.Cleanup(func() {
		openerCommandFunc = origOpener
	})

	origFactory := commandFactory
	var gotName string
	var gotArgs []string
	cmd := &fakeCommand{}
	commandFactory = func(name string, args ...string) command {
		gotName = name
		gotArgs = append([]string(nil), args...)
		return cmd
	}
	t.Cleanup(func() {
		commandFactory = origFactory
	})

	req := httptest.NewRequest(http.MethodPost, "/api/open-folder", strings.NewReader(`{"path":"`+target+`"}`))
	rec := httptest.NewRecorder()

	openFolderHandler(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("status=%d want %d", res.StatusCode, http.StatusNoContent)
	}
	if gotOpenerPath != absTarget {
		t.Fatalf("opener path=%q want %q", gotOpenerPath, absTarget)
	}
	if gotName != "open" {
		t.Fatalf("command name=%q want %q", gotName, "open")
	}
	if len(gotArgs) != 1 || gotArgs[0] != absTarget {
		t.Fatalf("command args=%v want [%q]", gotArgs, absTarget)
	}
	if !cmd.started {
		t.Fatalf("expected command Start to be called")
	}
}
