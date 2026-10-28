package pluginworker

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/sianachi/Nix/apps/go-workers/internal/plugintest"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/pluginruntime"
)

func TestWorkerExecutesAndCompletesAPluginInvocation(t *testing.T) {
	wasm := plugintest.SuccessModule()
	server := objectServer(t, wasm)
	defer server.Close()
	api := &fakeAPI{plans: []InvocationPlan{signedPlan(t, wasm, server.URL)}}
	worker := newTestWorker(t, api, server.URL)

	action := worker.Handle(t.Context(), workspaceEnvelope())
	if action != broker.Acknowledge {
		t.Fatalf("action = %v, want acknowledge", action)
	}
	if len(api.completions) != 1 || !api.completions[0].Succeeded {
		t.Fatalf("completions = %#v", api.completions)
	}
}

func TestWorkerRecordsInvalidSignaturesWithoutRetryingTheEvent(t *testing.T) {
	wasm := plugintest.SuccessModule()
	server := objectServer(t, wasm)
	defer server.Close()
	plan := signedPlan(t, wasm, server.URL)
	plan.Component.Signature[0] ^= 0xff
	api := &fakeAPI{plans: []InvocationPlan{plan}}
	worker := newTestWorker(t, api, server.URL)

	if action := worker.Handle(t.Context(), workspaceEnvelope()); action != broker.Acknowledge {
		t.Fatalf("action = %v, want acknowledge", action)
	}
	if len(api.completions) != 1 || api.completions[0].ErrorCode != "plugin.component_invalid" {
		t.Fatalf("completions = %#v", api.completions)
	}
}

func TestWorkerRequeuesTransientArtifactFailures(t *testing.T) {
	wasm := plugintest.SuccessModule()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		http.Error(response, "unavailable", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	api := &fakeAPI{plans: []InvocationPlan{signedPlan(t, wasm, server.URL)}}
	worker := newTestWorker(t, api, server.URL)

	if action := worker.Handle(t.Context(), workspaceEnvelope()); action != broker.Requeue {
		t.Fatalf("action = %v, want requeue", action)
	}
	if len(api.completions) != 1 || !api.completions[0].Retryable || api.completions[0].ErrorCode != "plugin.component_unavailable" {
		t.Fatalf("completions = %#v", api.completions)
	}
}

func TestWorkerRequeuesTransientGrantedHostCallFailures(t *testing.T) {
	wasm := plugintest.HostCallModule()
	server := objectServer(t, wasm)
	defer server.Close()
	api := &fakeAPI{
		plans:   []InvocationPlan{signedPlan(t, wasm, server.URL)},
		hostErr: testStatusError(503),
	}
	worker := newTestWorker(t, api, server.URL)

	if action := worker.Handle(t.Context(), workspaceEnvelope()); action != broker.Requeue {
		t.Fatalf("action = %v, want requeue", action)
	}
	if len(api.completions) != 1 || !api.completions[0].Retryable || api.completions[0].ErrorCode != "plugin.dependency_unavailable" {
		t.Fatalf("completions = %#v", api.completions)
	}
}

func TestWorkerSettlesEveryLeasedInvocationBeforeRequeueing(t *testing.T) {
	wasm := plugintest.SuccessModule()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/unavailable" {
			http.Error(response, "unavailable", http.StatusServiceUnavailable)
			return
		}
		response.Header().Set("Content-Length", strconv.Itoa(len(wasm)))
		_, _ = response.Write(wasm)
	}))
	defer server.Close()
	first := signedPlan(t, wasm, server.URL+"/unavailable")
	second := signedPlan(t, wasm, server.URL+"/component")
	second.InvocationID = "99999999-9999-4999-8999-999999999999"
	api := &fakeAPI{plans: []InvocationPlan{first, second}}
	worker := newTestWorker(t, api, server.URL)

	if action := worker.Handle(t.Context(), workspaceEnvelope()); action != broker.Requeue {
		t.Fatalf("action = %v, want requeue", action)
	}
	if len(api.completions) != 2 || !api.completions[0].Retryable || !api.completions[1].Succeeded {
		t.Fatalf("completions = %#v", api.completions)
	}
}

func TestWorkerRejectsMalformedOrUnboundedBrokerEvents(t *testing.T) {
	api := &fakeAPI{}
	worker := newTestWorker(t, api, "http://127.0.0.1:1")
	envelope := workspaceEnvelope()
	envelope.WorkspaceID = nil
	if action := worker.Handle(t.Context(), envelope); action != broker.Reject {
		t.Fatalf("action = %v, want reject", action)
	}
	if api.prepares != 0 {
		t.Fatalf("prepare calls = %d, want zero", api.prepares)
	}
}

func newTestWorker(t *testing.T, api *fakeAPI, origin string) *Worker {
	t.Helper()
	runtime, err := pluginruntime.New(pluginruntime.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	worker, err := New(
		api,
		objecttransfer.New(time.Second, origin),
		runtime,
		8<<20,
		60*time.Second,
		time.Millisecond,
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return worker
}

func objectServer(t *testing.T, body []byte) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			t.Fatalf("method = %s, want GET", request.Method)
		}
		response.Header().Set("Content-Length", strconv.Itoa(len(body)))
		_, _ = response.Write(body)
	}))
}

func signedPlan(t *testing.T, wasm []byte, downloadURL string) InvocationPlan {
	t.Helper()
	privateKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x31}, ed25519.SeedSize))
	digest := sha256.Sum256(wasm)
	digestText := strings.ToUpper(hex.EncodeToString(digest[:]))
	payload := []byte("nix-plugin-component-v1\nnix.test/example\n1.0.0\n" + digestText)
	return InvocationPlan{
		InvocationID:   "33333333-3333-4333-8333-333333333333",
		InstallationID: "44444444-4444-4444-8444-444444444444",
		Attempt:        1,
		LeaseUntil:     time.Now().Add(time.Minute),
		Component: ComponentPlan{
			PublisherID:       "nix.test",
			ID:                "nix.test/example",
			Version:           "1.0.0",
			SHA256:            digestText,
			PublicKey:         append([]byte(nil), privateKey.Public().(ed25519.PublicKey)...),
			Signature:         ed25519.Sign(privateKey, payload),
			DownloadURL:       downloadURL,
			DownloadExpiresAt: time.Now().Add(time.Minute),
			ByteLength:        int64(len(wasm)),
		},
		Capabilities: []string{"items.read"},
	}
}

func workspaceEnvelope() broker.Envelope {
	workspaceID := "55555555-5555-4555-8555-555555555555"
	itemID := "66666666-6666-4666-8666-666666666666"
	version := int64(7)
	return broker.Envelope{
		SchemaVersion:    broker.SchemaVersion,
		MessageID:        "77777777-7777-4777-8777-777777777777",
		MessageType:      broker.WorkspaceMessageType,
		OccurredAt:       time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC),
		TenantID:         "88888888-8888-4888-8888-888888888888",
		WorkspaceID:      &workspaceID,
		ItemID:           &itemID,
		Kind:             "item.changed",
		Payload:          json.RawMessage(`{}`),
		CorrelationID:    "77777777-7777-4777-8777-777777777777",
		AggregateVersion: &version,
	}
}

type fakeAPI struct {
	plans       []InvocationPlan
	prepareErr  error
	completeErr error
	hostErr     error
	prepares    int
	completions []Completion
}

func (api *fakeAPI) PreparePluginEvent(context.Context, broker.WorkspaceEvent, int) (Preparation, error) {
	api.prepares++
	return Preparation{Outcome: "prepared", Plans: api.plans}, api.prepareErr
}

func (api *fakeAPI) CallPluginHost(context.Context, string, string, json.RawMessage) (json.RawMessage, error) {
	if api.hostErr != nil {
		return nil, api.hostErr
	}
	return nil, errors.New("unexpected host call")
}

type testStatusError int

func (err testStatusError) Error() string   { return "test response error" }
func (err testStatusError) StatusCode() int { return int(err) }

func (api *fakeAPI) CompletePluginInvocation(_ context.Context, _ string, completion Completion) (CompletionResult, error) {
	api.completions = append(api.completions, completion)
	return CompletionResult{Outcome: "applied", ShouldRequeue: completion.Retryable}, api.completeErr
}
