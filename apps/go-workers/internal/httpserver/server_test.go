package httpserver

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/role"
)

func TestHealthzDoesNotRequireAWorkerPayload(t *testing.T) {
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", MaxInputSize: 1024, MaxRecords: 10, MaxLineBytes: 256})
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"healthy"`) {
		t.Fatalf("health response = %d %q", response.Code, response.Body.String())
	}
}

func TestReadinessReflectsDependencies(t *testing.T) {
	server := New(Dependencies{Ready: func() bool { return false }})
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("readiness status = %d", response.Code)
	}
}

func TestImportRoleDoesNotExposeOtherWorkerRoutes(t *testing.T) {
	server := NewForRole(role.Import, Dependencies{Logger: slog.Default(), InternalSecret: "secret"})
	for _, path := range []string{"/v1/search"} {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}"))
		request.Header.Set("X-Nix-Internal-Secret", "secret")
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("import role exposed %s with status %d", path, response.Code)
		}
	}
}

func TestImportValidatesNdjsonWithoutWritingToAStore(t *testing.T) {
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", MaxInputSize: 1024, MaxRecords: 10, MaxLineBytes: 256})
	request := httptest.NewRequest(http.MethodPost, "/v1/import/ndjson", strings.NewReader(`{"id":"one","title":"One"}
`))
	request.Header.Set("Content-Type", "application/x-ndjson")
	request.Header.Set("X-Nix-Internal-Secret", "secret")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"records":1`) {
		t.Fatalf("import response = %d %q", response.Code, response.Body.String())
	}
}

func TestWorkerPayloadRoutesRequireTheInternalSecret(t *testing.T) {
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", MaxInputSize: 1024, MaxRecords: 10, MaxLineBytes: 256})
	request := httptest.NewRequest(http.MethodPost, "/v1/import/ndjson", strings.NewReader(`{"id":"one","title":"One"}
`))
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated response = %d", response.Code)
	}
}

func TestImportRefusesAnOversizedRecord(t *testing.T) {
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", MaxInputSize: 1024, MaxRecords: 10, MaxLineBytes: 16})
	request := httptest.NewRequest(http.MethodPost, "/v1/import/ndjson", strings.NewReader(`{"id":"one","title":"This title is too long"}
`))
	request.Header.Set("X-Nix-Internal-Secret", "secret")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("import response = %d %q", response.Code, response.Body.String())
	}
}

func TestDocumentImportParsesMarkdownWithHonestResponse(t *testing.T) {
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", MaxInputSize: 1024, MaxRecords: 10, MaxLineBytes: 256})
	request := httptest.NewRequest(http.MethodPost, "/v1/import/document?format=markdown&id=one&title=Note", strings.NewReader("# Heading"))
	request.Header.Set("X-Nix-Internal-Secret", "secret")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"# Heading"`) {
		t.Fatalf("document import response = %d %q", response.Code, response.Body.String())
	}
}

// New serves every role, as a test wants one handler for all of the routes.
func New(deps Dependencies) http.Handler { return NewForRole(role.All, deps) }
