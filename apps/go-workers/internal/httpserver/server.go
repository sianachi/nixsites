package httpserver

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/importer"
	"github.com/sianachi/Nix/apps/go-workers/internal/role"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

type Dependencies struct {
	Logger         *slog.Logger
	InternalSecret string
	MaxInputSize   int64
	MaxRecords     int
	MaxLineBytes   int
	RequestTimeout time.Duration
	Ready          func() bool
	Companion      http.Handler
}

type Server struct {
	deps Dependencies
}

func NewForRole(service role.Service, deps Dependencies) http.Handler {
	server := &Server{deps: deps}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", server.health)
	mux.HandleFunc("GET /readyz", server.ready)
	if deps.Companion != nil {
		mux.Handle("POST /v1/companion", server.requireInternal(deps.Companion))
	}
	if service == role.All || service == role.Import {
		mux.Handle("POST /v1/import/ndjson", server.requireInternal(http.HandlerFunc(server.importNDJSON)))
		mux.Handle("POST /v1/import/document", server.requireInternal(http.HandlerFunc(server.importDocument)))
	}
	timeout := deps.RequestTimeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return requestTimeout(mux, timeout)
}

func (s *Server) requireInternal(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		presented := request.Header.Get("X-Nix-Internal-Secret")
		if s.deps.InternalSecret == "" || presented == "" || !sameSecret(presented, s.deps.InternalSecret) {
			writeJSON(response, http.StatusUnauthorized, map[string]string{
				"code":   "internal_auth_required",
				"detail": "A trusted service credential is required.",
			})
			return
		}
		next.ServeHTTP(response, request)
	})
}

func sameSecret(presented, expected string) bool {
	if len(presented) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(expected)) == 1
}

func (s *Server) health(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]string{"status": "healthy"})
}

func (s *Server) ready(response http.ResponseWriter, _ *http.Request) {
	if s.deps.Ready != nil && !s.deps.Ready() {
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) importNDJSON(response http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(response, request.Body, s.deps.MaxInputSize)
	summary, err := stream.ReadRecords(request.Body, s.limits(), func(stream.Record) error {
		// This first slice validates and counts the stream. Durable item creation will be added only
		// after the Nix.Api job contract exists; this worker never receives database credentials.
		return nil
	})
	if err != nil {
		writeStreamError(response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]any{"status": "validated", "summary": summary})
}

func (s *Server) importDocument(response http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	format, id, title := query.Get("format"), query.Get("id"), query.Get("title")
	if format == "" || id == "" || title == "" {
		writeJSON(response, http.StatusBadRequest, map[string]string{"code": "import_invalid", "detail": "format, id, and title are required."})
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, s.deps.MaxInputSize)
	result, err := importer.Parse(format, id, title, request.Body, importer.Limits{MaxBytes: s.deps.MaxInputSize, MaxItems: s.deps.MaxRecords, MaxEntry: int64(s.deps.MaxLineBytes)})
	if err != nil {
		writeStreamError(response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, result)
}

func (s *Server) limits() stream.Limits {
	return stream.Limits{MaxBytes: s.deps.MaxInputSize, MaxLine: s.deps.MaxLineBytes, MaxRecords: s.deps.MaxRecords}
}

func writeStreamError(response http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	if errors.Is(err, stream.ErrLimitExceeded) {
		status = http.StatusRequestEntityTooLarge
	}
	writeJSON(response, status, map[string]string{"code": "stream_refused", "detail": err.Error()})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func requestTimeout(next http.Handler, timeout time.Duration) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestContext, cancel := context.WithTimeout(request.Context(), timeout)
		defer cancel()
		next.ServeHTTP(response, request.WithContext(requestContext))
	})
}
