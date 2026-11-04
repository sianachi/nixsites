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

func TestWorkerPayloadRoutesRequireTheInternalSecret(t *testing.T) {
	companion := http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) { response.WriteHeader(http.StatusOK) })
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", Companion: companion})
	request := httptest.NewRequest(http.MethodPost, "/v1/companion", strings.NewReader(`{}`))
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated response = %d", response.Code)
	}
}

// New serves every role, as a test wants one handler for all of the routes.
func New(deps Dependencies) http.Handler { return NewForRole(role.All, deps) }
