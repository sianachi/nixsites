package workerapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestClientDoesNotForwardTheInternalSecretAcrossRedirects(t *testing.T) {
	var targetReached atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		targetReached.Store(true)
		if request.Header.Get("X-Nix-Internal-Secret") != "" {
			t.Fatal("the internal secret crossed an origin redirect")
		}
	}))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		http.Redirect(response, request, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()

	err := New(redirect.URL, "secret", "worker", time.Second).Ping(context.Background())
	if err == nil {
		t.Fatal("the worker API redirect was accepted")
	}
	if targetReached.Load() {
		t.Fatal("the redirect target was contacted")
	}
}

func TestClientLeasesAndAcknowledgesWithInternalCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Nix-Internal-Secret") != "secret" || request.Header.Get("Authorization") != "" {
			t.Fatal("internal credentials were not forwarded")
		}
		if request.URL.Path == "/internal/worker-dispatch/outbox/lease" {
			_, _ = response.Write([]byte(`[{"id":"event","tenantId":"tenant","kind":"item.changed","payload":{},"attempts":1,"availableAt":"2026-01-01T00:00:00Z"}]`))
			return
		}
		if request.URL.Path == "/internal/worker-dispatch/outbox/event/finish" {
			response.WriteHeader(http.StatusNoContent)
			return
		}
		response.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	client := New(server.URL, "secret", "worker", time.Second)
	events, err := client.LeaseOutbox(context.Background(), "item.changed", 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("lease = %#v, %v", events, err)
	}
	if err := client.AcknowledgeOutbox(context.Background(), events[0].ID); err != nil {
		t.Fatal(err)
	}
}

func TestClientNormalizesStringEncodedJobPayload(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/worker-dispatch/jobs/lease" {
			response.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = response.Write([]byte(`[{"id":"job","kind":"import.preview.pdf","payload":"{\"importId\":\"123e4567-e89b-12d3-a456-426614174000\"}","attempts":1,"cancellationRequested":false}]`))
	}))
	defer server.Close()

	jobs, err := New(server.URL, "secret", "importer", time.Second).LeaseJobs(context.Background(), "import.preview.pdf", 1)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("lease = %#v, %v", jobs, err)
	}
	if got := string(jobs[0].Payload); got != `{"importId":"123e4567-e89b-12d3-a456-426614174000"}` {
		t.Fatalf("normalized payload = %s", got)
	}
}

func TestClientRejectsMalformedStringEncodedPayload(t *testing.T) {
	var job Job
	err := json.Unmarshal([]byte(`{"id":"job","kind":"export.pdf","payload":"not-json"}`), &job)
	if err == nil || !strings.Contains(err.Error(), "payload text is not valid JSON") {
		t.Fatalf("unmarshal error = %v", err)
	}
}

func TestPingVerifiesAuthenticatedDispatchInsteadOfPublicHealth(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/worker-dispatch/jobs/lease" {
			t.Fatalf("readiness used %s", request.URL.Path)
		}
		if request.Header.Get("X-Nix-Internal-Secret") != "secret" {
			response.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = response.Write([]byte(`[]`))
	}))
	defer server.Close()

	if err := New(server.URL, "secret", "worker", time.Second).Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := New(server.URL, "wrong", "worker", time.Second).Ping(context.Background()); err == nil {
		t.Fatal("readiness accepted an invalid internal secret")
	}
}

func TestClientClaimsRenewsAndReadsExactJobExecution(t *testing.T) {
	const jobID = "10000000-0000-4000-8000-000000000001"
	const executionID = "worker one:execution/1"
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.Header.Get("X-Nix-Internal-Secret") != "secret" {
			t.Fatal("internal secret was not sent")
		}
		switch requests {
		case 1:
			if request.Method != http.MethodPost || request.URL.Path != "/internal/worker-dispatch/jobs/"+jobID+"/claim" {
				t.Fatalf("unexpected claim request: %s %s", request.Method, request.URL.Path)
			}
			assertExecutionRequest(t, request, executionID, 60)
			_, _ = response.Write([]byte(`{"id":"` + jobID + `","tenantId":"tenant","kind":"import.pdf","payload":{},"attempts":1,"cancellationRequested":false}`))
		case 2:
			if request.Method != http.MethodPost || request.URL.Path != "/internal/worker-dispatch/jobs/"+jobID+"/renew" {
				t.Fatalf("unexpected renewal request: %s %s", request.Method, request.URL.Path)
			}
			assertExecutionRequest(t, request, executionID, 60)
			response.WriteHeader(http.StatusNoContent)
		case 3:
			if request.Method != http.MethodGet || request.URL.Path != "/internal/worker-dispatch/jobs/"+jobID+"/state" || request.URL.Query().Get("owner") != executionID {
				t.Fatalf("unexpected state request: %s %s", request.Method, request.URL.String())
			}
			_, _ = response.Write([]byte(`{"status":"running","cancellationRequested":false,"leaseOwned":true,"leaseUntil":"2026-09-01T00:00:00Z"}`))
		default:
			t.Fatalf("unexpected request %d", requests)
		}
	}))
	defer server.Close()

	client := New(server.URL, "secret", "worker", time.Second)
	job, err := client.ClaimJob(context.Background(), jobID, executionID, 60)
	if err != nil || job == nil || job.ID != jobID {
		t.Fatalf("claim = %#v, %v", job, err)
	}
	renewed, err := client.RenewJob(context.Background(), jobID, executionID, 60)
	if err != nil || !renewed {
		t.Fatalf("renewed = %v, %v", renewed, err)
	}
	state, err := client.JobState(context.Background(), jobID, executionID)
	if err != nil || state == nil || !state.LeaseOwned || state.Status != "running" {
		t.Fatalf("state = %#v, %v", state, err)
	}
}

func TestClientTreatsClaimAndRenewConflictsAsLostWork(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusConflict)
	}))
	defer server.Close()
	client := New(server.URL, "secret", "worker", time.Second)

	job, err := client.ClaimJob(context.Background(), "job", "execution", 60)
	if err != nil || job != nil {
		t.Fatalf("claim = %#v, %v", job, err)
	}
	renewed, err := client.RenewJob(context.Background(), "job", "execution", 60)
	if err != nil || renewed {
		t.Fatalf("renewed = %v, %v", renewed, err)
	}
}

func TestExecutionContextAddsLeaseProofOnlyToDomainRequests(t *testing.T) {
	const jobID = "019946d1-fbc0-7a87-b27e-d2f16408c71a"
	const executionID = "worker:019946d1-fbc1-7d99-9ce7-1c721b406ff0"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Nix-Worker-Job-Id") != jobID || request.Header.Get("X-Nix-Worker-Execution-Id") != executionID {
			t.Fatalf("execution headers = %q, %q", request.Header.Get("X-Nix-Worker-Job-Id"), request.Header.Get("X-Nix-Worker-Execution-Id"))
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	client := New(server.URL, "secret", "worker", time.Second)

	err := client.post(WithExecution(context.Background(), jobID, executionID), "/internal/worker-executions/probe", nil)
	if err != nil {
		t.Fatal(err)
	}
}

func TestImportFileVersionRoutesMatchWorkerExecutionMounts(t *testing.T) {
	const jobID = "019946d1-fbc0-7a87-b27e-d2f16408c71c"
	const executionID = "worker:019946d1-fbc1-7d99-9ce7-1c721b406ff2"
	const importID = "10000000-0000-4000-8000-000000000001"
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		if request.Header.Get("X-Nix-Worker-Job-Id") != jobID || request.Header.Get("X-Nix-Worker-Execution-Id") != executionID {
			t.Fatalf("execution proof missing from %s %s", request.Method, request.URL.Path)
		}
		requests = append(requests, request.Method+" "+request.URL.Path)
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/internal/worker-executions/template-imports/"+importID+"/files/authorization":
			if request.URL.Query().Get("limit") != "25" {
				t.Fatalf("template file plan query = %s", request.URL.RawQuery)
			}
			_, _ = response.Write([]byte(`{"importId":"` + importID + `","files":[],"complete":true}`))
		case request.Method == http.MethodPost && request.URL.Path == "/internal/worker-executions/template-imports/"+importID+"/files/complete":
			_, _ = response.Write([]byte(`{"importId":"` + importID + `","completedTransferIds":["20000000-0000-4000-8000-000000000002"]}`))
		case request.Method == http.MethodGet && request.URL.Path == "/internal/worker-executions/imports/"+importID+"/file-versions/authorization":
			if request.URL.Query().Get("limit") != "25" {
				t.Fatalf("document file plan query = %s", request.URL.RawQuery)
			}
			_, _ = response.Write([]byte(`{"importId":"` + importID + `","files":[],"complete":true}`))
		case request.Method == http.MethodPost && request.URL.Path == "/internal/worker-executions/imports/"+importID+"/file-versions/complete":
			_, _ = response.Write([]byte(`{"importId":"` + importID + `","completedTransferIds":["20000000-0000-4000-8000-000000000002"]}`))
		default:
			t.Errorf("unexpected import file request: %s %s", request.Method, request.URL.Path)
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := New(server.URL, "secret", "worker", time.Second)
	ctx := WithExecution(context.Background(), jobID, executionID)
	if _, err := client.GetTemplateImportFilePlan(ctx, importID, "", 25); err != nil {
		t.Fatalf("template file plan: %v", err)
	}
	if err := client.CompleteTemplateImportFileBatch(ctx, importID, []string{"20000000-0000-4000-8000-000000000002"}); err != nil {
		t.Fatalf("template file completion: %v", err)
	}
	if _, err := client.GetDocumentImportFilePlan(ctx, importID, "", 25); err != nil {
		t.Fatalf("document file plan: %v", err)
	}
	if err := client.CompleteDocumentImportFileBatch(ctx, importID, []string{"20000000-0000-4000-8000-000000000002"}); err != nil {
		t.Fatalf("document file completion: %v", err)
	}
	want := []string{
		"GET /internal/worker-executions/template-imports/" + importID + "/files/authorization",
		"POST /internal/worker-executions/template-imports/" + importID + "/files/complete",
		"GET /internal/worker-executions/imports/" + importID + "/file-versions/authorization",
		"POST /internal/worker-executions/imports/" + importID + "/file-versions/complete",
	}
	if fmt.Sprint(requests) != fmt.Sprint(want) {
		t.Fatalf("requests = %v, want %v", requests, want)
	}
}

func TestClientObtainsExportSourceAndSizedDestinationUnderTheExecution(t *testing.T) {
	const jobID = "019946d1-fbc0-7a87-b27e-d2f16408c71b"
	const executionID = "worker:019946d1-fbc1-7d99-9ce7-1c721b406ff1"
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.Header.Get("X-Nix-Worker-Job-Id") != jobID || request.Header.Get("X-Nix-Worker-Execution-Id") != executionID {
			t.Fatal("execution proof was omitted")
		}
		if requests == 1 {
			_, _ = response.Write([]byte(`{"exportId":"` + jobID + `","format":"pdf","sourceUrl":"http://collab/bundle","bearerToken":"token","delegationExpiresAt":"2026-09-01T01:00:00Z"}`))
			return
		}
		if request.URL.Query().Get("byteLength") != "123" || request.URL.Query().Get("sha256") != strings.Repeat("a", 64) {
			t.Fatalf("destination query = %s", request.URL.RawQuery)
		}
		_, _ = response.Write([]byte(`{"exportId":"` + jobID + `","attemptId":"33333333-3333-4333-8333-333333333333","format":"pdf","objectKey":"exports/result.pdf","uploadUrl":"http://objects/put","readUrl":"http://objects/get","deleteUrl":"http://objects/delete","capabilityExpiresAt":"2026-09-01T01:00:00Z"}`))
	}))
	defer server.Close()
	client := New(server.URL, "secret", "worker", time.Second)
	ctx := WithExecution(context.Background(), jobID, executionID)
	if source, err := client.GetExportSource(ctx, jobID); err != nil || source.Format != "pdf" {
		t.Fatalf("source = %#v, %v", source, err)
	}
	if destination, err := client.GetExportDestination(ctx, jobID, 123, strings.Repeat("a", 64)); err != nil || destination.ObjectKey == "" {
		t.Fatalf("destination = %#v, %v", destination, err)
	}
}

func TestSameOriginPathRefusesProtocolRelativeAndAbsoluteURLs(t *testing.T) {
	for value, want := range map[string]bool{
		"/": true,
		"/w/1a1a1a1a-1111-4111-8111-1a1a1a1a1a1a": true,
		"/w/x?item=y":               true,
		"":                          false,
		"w/x":                       false,
		"//evil.example/x":          false,
		"/\\evil.example/x":         false,
		"https://evil.example/":     false,
		"/redirect?to=https://evil": false,
		"/tab\tname":                false,
		"/line\nbreak":              false,
	} {
		if got := sameOriginPath(value); got != want {
			t.Fatalf("sameOriginPath(%q) = %v, want %v", value, got, want)
		}
	}
}
func assertExecutionRequest(t *testing.T, request *http.Request, owner string, leaseSeconds int) {
	t.Helper()
	var body struct {
		Owner        string `json:"owner"`
		LeaseSeconds int    `json:"leaseSeconds"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Owner != owner || body.LeaseSeconds != leaseSeconds {
		t.Fatalf("execution request = %#v", body)
	}
}
