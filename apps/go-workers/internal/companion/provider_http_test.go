package companion

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// sseServer answers one streaming request with the given SSE frames and records the request body.
func sseServer(t *testing.T, status int, frames []string, onRequest func(*http.Request, []byte)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if onRequest != nil {
			onRequest(r, body)
		}
		if status != http.StatusOK {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":{"message":"nope"}}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		for _, frame := range frames {
			_, _ = fmt.Fprint(w, frame)
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
	}))
}

type notifications struct {
	mu     sync.Mutex
	events []string
	done   chan struct{}
}

func newNotifications() *notifications {
	return &notifications{done: make(chan struct{}, 4)}
}

func (n *notifications) notify(method string, raw json.RawMessage) {
	n.mu.Lock()
	n.events = append(n.events, method+" "+string(raw))
	n.mu.Unlock()
	if method == "turn/completed" {
		n.done <- struct{}{}
	}
}

func (n *notifications) wait(t *testing.T) []string {
	t.Helper()
	select {
	case <-n.done:
	case <-time.After(5 * time.Second):
		t.Fatal("turn never completed")
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]string{}, n.events...)
}

func startThreadAndTurn(t *testing.T, transport Transport, tools []any, text string) (thread string, turn string) {
	t.Helper()
	params := map[string]any{"model": "test-model", "baseInstructions": "base", "developerInstructions": "dev"}
	if tools != nil {
		params["dynamicTools"] = tools
	}
	raw, err := transport.Call(context.Background(), "thread/start", params)
	if err != nil {
		t.Fatal(err)
	}
	var started struct {
		Thread struct{ ID string } `json:"thread"`
	}
	_ = json.Unmarshal(raw, &started)
	raw, err = transport.Call(context.Background(), "turn/start", map[string]any{"threadId": started.Thread.ID, "input": []any{map[string]any{"type": "text", "text": text}}})
	if err != nil {
		t.Fatal(err)
	}
	var turned struct {
		Turn struct{ ID string } `json:"turn"`
	}
	_ = json.Unmarshal(raw, &turned)
	return started.Thread.ID, turned.Turn.ID
}

func TestAnthropicStreamsTextIntoCodexShapedNotifications(t *testing.T) {
	var seen []byte
	server := sseServer(t, http.StatusOK, []string{
		"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12,\"cache_read_input_tokens\":9000,\"cache_creation_input_tokens\":40,\"output_tokens\":1}}}\n\n",
		"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}\n\n",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" there\"}}\n\n",
		"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
		"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":7}}\n\n",
		"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
	}, func(r *http.Request, body []byte) {
		seen = body
		if r.Header.Get("x-api-key") != "sk-ant-test" {
			t.Errorf("missing api key header")
		}
	})
	defer server.Close()
	n := newNotifications()
	transport := testTransport(t, "anthropic", server.URL, n.notify)
	thread, _ := startThreadAndTurn(t, transport, nil, "Hi")
	events := n.wait(t)
	joined := strings.Join(events, "\n")
	if !strings.Contains(joined, `item/agentMessage/delta {"delta":"Hello"`) || !strings.Contains(joined, `"text":"Hello there"`) || !strings.Contains(joined, `"status":"completed"`) {
		t.Fatalf("unexpected notifications:\n%s", joined)
	}
	if !strings.Contains(joined, thread) {
		t.Fatalf("notifications must name the thread: %s", joined)
	}
	if !strings.Contains(joined, `"usage":{"input_tokens":12,"cache_read_input_tokens":9000,"cache_creation_input_tokens":40,"output_tokens":7}`) {
		t.Fatalf("turn/completed must carry the turn's token counts:\n%s", joined)
	}
	// The system prompt and the newest message each carry a cache breakpoint.
	if !strings.Contains(string(seen), `"system":[{"cache_control":{"type":"ephemeral"},"text":"base\n\ndev","type":"text"}]`) || !strings.Contains(string(seen), `"content":[{"cache_control":{"type":"ephemeral"},"text":"Hi","type":"text"}]`) {
		t.Fatalf("request body missing a cached system prompt or user message: %s", seen)
	}
}

func TestProviderDefaultUsesAnAdvertisedModelForChatAndInline(t *testing.T) {
	for _, provider := range []string{"anthropic", "openrouter"} {
		for _, mode := range []string{"chat", "inline"} {
			t.Run(provider+"/"+mode, func(t *testing.T) {
				seen := make(chan string, 1)
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method == http.MethodGet {
						_, _ = fmt.Fprint(w, `{"data":[{"id":"offered-model","display_name":"Offered model","name":"Offered model","supported_parameters":["tools"]}]}`)
						return
					}
					var body struct {
						Model string `json:"model"`
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					seen <- body.Model
					w.Header().Set("Content-Type", "text/event-stream")
					if provider == "anthropic" {
						_, _ = fmt.Fprint(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Done\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
					} else {
						_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Done\"}}]}\n\ndata: [DONE]\n\n")
					}
				}))
				defer server.Close()
				n := newNotifications()
				transport := testTransport(t, provider, server.URL, n.notify)
				defer transport.Close()
				a := &account{transport: transport, home: t.TempDir(), provider: provider, status: "connected", conversations: map[string]*conversation{}}
				if mode == "inline" {
					thread, _, err := a.inlineStart(context.Background(), inlineRequest(), "Private inline material", newInlineRun())
					if err != nil {
						t.Fatal(err)
					}
					defer a.unregisterInline(thread)
				} else if _, err := a.handle(context.Background(), request()); err != nil {
					t.Fatal(err)
				}
				events := n.wait(t)
				if model := <-seen; model != "offered-model" {
					t.Fatalf("request model %q, want the advertised model", model)
				}
				if !strings.Contains(strings.Join(events, "\n"), `"status":"completed"`) {
					t.Fatalf("turn failed: %v", events)
				}
			})
		}
	}
}

func TestAnOpenRouterDefaultWithoutToolsRefusesWorkspaceAccessAndStillChatsWithoutIt(t *testing.T) {
	for _, workspaceAccess := range []bool{false, true} {
		t.Run(fmt.Sprintf("workspaceAccess=%t", workspaceAccess), func(t *testing.T) {
			seen := make(chan struct{}, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet {
					_, _ = fmt.Fprint(w, `{"data":[{"id":"plain-model","name":"Plain model","supported_parameters":["temperature"]}]}`)
					return
				}
				var body map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if string(body["model"]) != `"plain-model"` || body["tools"] != nil {
					t.Errorf("plain chat must use its advertised model without tools: %s", body)
				}
				seen <- struct{}{}
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Done\"}}]}\n\ndata: [DONE]\n\n")
			}))
			defer server.Close()
			n := newNotifications()
			transport := testTransport(t, "openrouter", server.URL, n.notify)
			defer transport.Close()
			a := &account{transport: transport, home: t.TempDir(), provider: "openrouter", status: "connected", conversations: map[string]*conversation{}}
			r := request()
			r.WorkspaceAccess = workspaceAccess
			_, err := a.handle(context.Background(), r)
			if workspaceAccess {
				if err == nil || err.Error() != "model does not support tools" {
					t.Fatalf("expected tool support refusal, got %v", err)
				}
				if snapshot := a.snapshot(conversationKey(r)); snapshot.State != "error" || snapshot.Reason != "This model cannot use tools. Pick another model, or turn Workspace access off for this message." {
					t.Fatalf("refusal was not actionable: %+v", snapshot)
				}
				select {
				case <-seen:
					t.Fatal("refused request reached the provider")
				default:
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if events := n.wait(t); !strings.Contains(strings.Join(events, "\n"), `"status":"completed"`) {
				t.Fatalf("plain chat failed: %v", events)
			}
			<-seen
		})
	}
}

func TestEphemeralThreadsAreNeverSavedAndUnsubscribeDiscardsThem(t *testing.T) {
	for _, outcome := range []string{"unused", "completed", "interrupted"} {
		t.Run(outcome, func(t *testing.T) {
			startedRequest := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				if outcome == "interrupted" {
					w.WriteHeader(http.StatusOK)
					w.(http.Flusher).Flush()
					close(startedRequest)
					<-r.Context().Done()
					return
				}
				_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Private inline result\"}}]}\n\ndata: [DONE]\n\n")
			}))
			defer server.Close()
			n := newNotifications()
			transport := testTransport(t, "openrouter", server.URL, n.notify)
			defer transport.Close()
			raw, err := transport.Call(context.Background(), "thread/start", map[string]any{"model": "test-model", "ephemeral": true, "baseInstructions": "Private inline context"})
			if err != nil {
				t.Fatal(err)
			}
			var started struct {
				Thread struct{ ID string } `json:"thread"`
			}
			if err := json.Unmarshal(raw, &started); err != nil {
				t.Fatal(err)
			}
			if outcome != "unused" {
				raw, err := transport.Call(context.Background(), "turn/start", map[string]any{"threadId": started.Thread.ID, "input": []any{map[string]any{"type": "text", "text": "Private inline selection"}}})
				if err != nil {
					t.Fatal(err)
				}
				if outcome == "interrupted" {
					var turned struct {
						Turn struct{ ID string } `json:"turn"`
					}
					if err := json.Unmarshal(raw, &turned); err != nil {
						t.Fatal(err)
					}
					select {
					case <-startedRequest:
					case <-time.After(5 * time.Second):
						t.Fatal("provider request never started")
					}
					if _, err := transport.Call(context.Background(), "turn/interrupt", map[string]string{"turnId": turned.Turn.ID}); err != nil {
						t.Fatal(err)
					}
				}
				if events := n.wait(t); !strings.Contains(strings.Join(events, "\n"), `"status":"`+outcome+`"`) {
					t.Fatalf("unexpected outcome: %v", events)
				}
			}
			if _, err := transport.Call(context.Background(), "thread/unsubscribe", map[string]string{"threadId": started.Thread.ID}); err != nil {
				t.Fatal(err)
			}
			http := transport.(*httpTransport)
			if _, err := os.Stat(http.threadPath(started.Thread.ID)); !os.IsNotExist(err) {
				t.Fatalf("ephemeral thread persisted: %v", err)
			}
			http.mu.Lock()
			_, retained := http.threads[started.Thread.ID]
			http.mu.Unlock()
			if retained {
				t.Fatal("ephemeral thread retained in memory")
			}
		})
	}
}

func TestAnthropicToolCallRoundTripsThroughTheHandlerAndReply(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		calls++
		w.Header().Set("Content-Type", "text/event-stream")
		if calls == 1 {
			_, _ = fmt.Fprint(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call-1\",\"name\":\"nix_read_note\"}}\n\n")
			_, _ = fmt.Fprint(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"itemId\\\":\\\"abc\\\"}\"}}\n\n")
			_, _ = fmt.Fprint(w, "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
			return
		}
		// The second request must carry the tool result the handler replied with.
		if !strings.Contains(string(body), `"tool_result"`) || !strings.Contains(string(body), `Note says hello`) {
			t.Errorf("second request lacks the tool result: %s", body)
		}
		_, _ = fmt.Fprint(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Done\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer server.Close()
	n := newNotifications()
	transport := testTransport(t, "anthropic", server.URL, n.notify)
	peer := transport.(toolTransport)
	var handled []string
	peer.SetRequestHandler(func(id json.RawMessage, method string, params json.RawMessage) bool {
		handled = append(handled, method+" "+string(params))
		go func() { _ = peer.Reply(id, toolOutput(true, "Note says hello", "")) }()
		return true
	})
	tools := []any{map[string]any{"name": "nix_read_note", "description": "read", "inputSchema": map[string]any{"type": "object"}}}
	startThreadAndTurn(t, transport, tools, "Read it")
	events := n.wait(t)
	if len(handled) != 1 || !strings.Contains(handled[0], `"tool":"nix_read_note"`) || !strings.Contains(handled[0], `"callId":"call-1"`) {
		t.Fatalf("handler saw %v", handled)
	}
	joined := strings.Join(events, "\n")
	if !strings.Contains(joined, `"text":"Done"`) || !strings.Contains(joined, `"status":"completed"`) {
		t.Fatalf("unexpected notifications:\n%s", joined)
	}
	if calls != 2 {
		t.Fatalf("expected two provider requests, got %d", calls)
	}
}

func TestARefusedToolBecomesAnErrorResultNotAHang(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		calls++
		w.Header().Set("Content-Type", "text/event-stream")
		if calls == 1 {
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"nix_trash\",\"arguments\":\"{}\"}}]}}]}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
			return
		}
		if !strings.Contains(string(body), `"role":"tool"`) || !strings.Contains(string(body), "not available") {
			t.Errorf("refusal not fed back: %s", body)
		}
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	n := newNotifications()
	transport := testTransport(t, "openrouter", server.URL, n.notify)
	transport.(toolTransport).SetRequestHandler(func(json.RawMessage, string, json.RawMessage) bool { return false })
	tools := []any{map[string]any{"name": "nix_trash", "description": "t", "inputSchema": map[string]any{"type": "object"}}}
	thread, _ := startThreadAndTurn(t, transport, tools, "Trash it")
	_ = thread
	events := n.wait(t)
	if !strings.Contains(strings.Join(events, "\n"), `"status":"completed"`) {
		t.Fatalf("turn did not complete: %v", events)
	}
}

func TestInterruptEndsTheTurnAsInterrupted(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(release)
	n := newNotifications()
	transport := testTransport(t, "anthropic", server.URL, n.notify)
	_, turn := startThreadAndTurn(t, transport, nil, "Wait")
	time.Sleep(50 * time.Millisecond)
	if _, err := transport.Call(context.Background(), "turn/interrupt", map[string]string{"turnId": turn}); err != nil {
		t.Fatal(err)
	}
	events := n.wait(t)
	if !strings.Contains(strings.Join(events, "\n"), `"status":"interrupted"`) {
		t.Fatalf("expected interrupted: %v", events)
	}
}

func TestAnIncompleteResponseFailsTheTurnAndNeverRunsItsToolCall(t *testing.T) {
	toolStart := "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call-1\",\"name\":\"nix_draft\"}}\n\n" +
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"title\\\":\\\"Show\"}}\n\n"
	cases := []struct {
		name, kind, reason string
		frames             []string
	}{
		{"anthropic max_tokens", "anthropic", "length limit", []string{toolStart,
			"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
			"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}\n\n",
			"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"}},
		{"anthropic stream cut", "anthropic", "ended the response early", []string{toolStart}},
		{"anthropic empty answer", "anthropic", "without an answer", []string{
			"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
			"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"}},
		{"openrouter length", "openrouter", "length limit", []string{
			"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"nix_draft\",\"arguments\":\"{\\\"title\\\"\"}}]},\"finish_reason\":\"length\"}]}\n\n",
			"data: [DONE]\n\n"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			server := sseServer(t, http.StatusOK, c.frames, nil)
			defer server.Close()
			n := newNotifications()
			transport := testTransport(t, c.kind, server.URL, n.notify)
			handled := false
			transport.(toolTransport).SetRequestHandler(func(json.RawMessage, string, json.RawMessage) bool { handled = true; return false })
			tools := []any{map[string]any{"name": "nix_draft", "description": "d", "inputSchema": map[string]any{"type": "object"}}}
			startThreadAndTurn(t, transport, tools, "Build it")
			joined := strings.Join(n.wait(t), "\n")
			if !strings.Contains(joined, `"status":"failed"`) || !strings.Contains(joined, c.reason) {
				t.Fatalf("expected a failed turn naming %q:\n%s", c.reason, joined)
			}
			if handled {
				t.Fatal("a truncated tool call reached the handler")
			}
		})
	}
}

func TestARejectedKeyFailsTheTurnWithAnActionableReason(t *testing.T) {
	server := sseServer(t, http.StatusUnauthorized, nil, nil)
	defer server.Close()
	n := newNotifications()
	transport := testTransport(t, "openrouter", server.URL, n.notify)
	startThreadAndTurn(t, transport, nil, "Hi")
	events := n.wait(t)
	joined := strings.Join(events, "\n")
	if !strings.Contains(joined, `"status":"failed"`) || !strings.Contains(joined, "rejected the API key") {
		t.Fatalf("expected a key rejection: %s", joined)
	}
	if strings.Contains(joined, "sk-or-test") {
		t.Fatal("the key leaked into a notification")
	}
}

func TestProviderRedirectsCannotReceiveCredentialsOrPrompts(t *testing.T) {
	for _, provider := range []string{"anthropic", "openrouter"} {
		t.Run(provider, func(t *testing.T) {
			received := make(chan string, 1)
			sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				received <- r.Header.Get("x-api-key") + r.Header.Get("Authorization") + " " + string(body)
				w.WriteHeader(http.StatusUnauthorized)
			}))
			defer sink.Close()
			origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, sink.URL, http.StatusTemporaryRedirect)
			}))
			defer origin.Close()
			n := newNotifications()
			transport := testTransport(t, provider, origin.URL, n.notify).(*httpTransport)
			transport.client.Transport = origin.Client().Transport
			startThreadAndTurn(t, transport, nil, "private test prompt")
			events := strings.Join(n.wait(t), "\n")
			select {
			case leaked := <-received:
				t.Fatalf("provider redirect received credentials or prompt: %s", leaked)
			default:
			}
			if !strings.Contains(events, `"status":"failed"`) || !strings.Contains(events, "HTTP 307") {
				t.Fatalf("redirect did not fail the provider turn: %s", events)
			}
		})
	}
}

func TestOpenRouterModelListMarksToolSupport(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-or-test" {
			t.Errorf("missing bearer")
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"a/tools","name":"Tools","supported_parameters":["tools","temperature"]},{"id":"b/plain","name":"Plain","supported_parameters":["temperature"]}]}`))
	}))
	defer server.Close()
	transport := testTransport(t, "openrouter", server.URL, func(string, json.RawMessage) {})
	raw, err := transport.Call(context.Background(), "model/list", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"model":"a/tools"`) || !strings.Contains(string(raw), `"supportsTools":false`) {
		t.Fatalf("unexpected list: %s", raw)
	}
	a := &account{transport: transport, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected", provider: "openrouter"}
	if err := a.listModels(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(a.models) != 2 || !a.models[0].SupportsTools || a.models[1].SupportsTools {
		t.Fatalf("supportsTools not carried: %+v", a.models)
	}
}

func TestAThreadSurvivesATransportRestart(t *testing.T) {
	server := sseServer(t, http.StatusOK, []string{"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n", "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"}, nil)
	defer server.Close()
	home := t.TempDir()
	n := newNotifications()
	first := testTransportIn(t, "anthropic", server.URL, home, n.notify)
	thread, _ := startThreadAndTurn(t, first, nil, "Hello")
	n.wait(t)
	_ = first.Close()
	second := testTransportIn(t, "anthropic", server.URL, home, n.notify)
	if _, err := second.Call(context.Background(), "thread/resume", map[string]string{"threadId": thread}); err != nil {
		t.Fatalf("resume failed: %v", err)
	}
	if _, err := second.Call(context.Background(), "thread/resume", map[string]string{"threadId": "missing"}); err == nil {
		t.Fatal("an unknown thread must not resume")
	}
}

func testTransport(t *testing.T, kind, base string, notify func(string, json.RawMessage)) Transport {
	t.Helper()
	return testTransportIn(t, kind, base, t.TempDir(), notify)
}

func testTransportIn(t *testing.T, kind, base, home string, notify func(string, json.RawMessage)) Transport {
	t.Helper()
	key := "sk-ant-test"
	if kind == "openrouter" {
		key = "sk-or-test"
	}
	transport, err := newHTTPTransport(kind, key, home, notify)
	if err != nil {
		t.Fatal(err)
	}
	transport.(*httpTransport).baseURL = base
	return transport
}

func TestThreadTrimNeverStartsOnAToolResult(t *testing.T) {
	transport := testTransport(t, "anthropic", "http://unused", func(string, json.RawMessage) {}).(*httpTransport)
	thread := &httpThread{ID: "trim-thread", Messages: []providerMessage{{Role: "user", Text: "Go"}}}
	// One turn of 17 tool rounds: a plain cut at 32 would start on round 2's results.
	for i := range 17 {
		id := fmt.Sprintf("call-%d", i)
		thread.Messages = append(thread.Messages,
			providerMessage{Role: "assistant", ToolCalls: []providerToolCall{{ID: id, Name: "nix_read_note"}}},
			providerMessage{Role: "user", ToolResults: []providerToolResult{{CallID: id, Text: "ok"}}})
	}
	thread.Messages = append(thread.Messages, providerMessage{Role: "assistant", Text: "Done"})
	transport.save(thread)
	first := thread.Messages[0]
	if first.Role != "user" || len(first.ToolResults) > 0 {
		t.Fatalf("trimmed thread starts on %+v", first)
	}
}

func TestInterruptWhileAToolWaitsAnswersEveryCall(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for i, id := range []string{"call-1", "call-2"} {
			_, _ = fmt.Fprintf(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":%d,\"content_block\":{\"type\":\"tool_use\",\"id\":\"%s\",\"name\":\"nix_trash\"}}\n\n", i, id)
			_, _ = fmt.Fprintf(w, "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":%d}\n\n", i)
		}
		_, _ = fmt.Fprint(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer server.Close()
	n := newNotifications()
	transport := testTransport(t, "anthropic", server.URL, n.notify)
	asked := make(chan struct{}, 2)
	// The handler takes the call and never replies, as an approval card the owner leaves open.
	transport.(toolTransport).SetRequestHandler(func(json.RawMessage, string, json.RawMessage) bool {
		asked <- struct{}{}
		return true
	})
	tools := []any{map[string]any{"name": "nix_trash", "description": "t", "inputSchema": map[string]any{"type": "object"}}}
	threadID, turn := startThreadAndTurn(t, transport, tools, "Trash both")
	<-asked
	if _, err := transport.Call(context.Background(), "turn/interrupt", map[string]string{"turnId": turn}); err != nil {
		t.Fatal(err)
	}
	if events := n.wait(t); !strings.Contains(strings.Join(events, "\n"), `"status":"interrupted"`) {
		t.Fatalf("expected interrupted: %v", events)
	}
	ht := transport.(*httpTransport)
	ht.mu.Lock()
	messages := ht.threads[threadID].Messages
	ht.mu.Unlock()
	last := messages[len(messages)-1]
	if len(last.ToolResults) != 2 || !last.ToolResults[0].IsError || last.ToolResults[1].CallID != "call-2" {
		t.Fatalf("the stopped tool calls were left unanswered: %+v", last)
	}
}

func TestAToolResultPictureReachesEachProviderInItsOwnShape(t *testing.T) {
	const picture = "data:image/jpeg;base64,/9j/AAAA"
	const anthropicCall = "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call-1\",\"name\":\"nix_read_note\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	const anthropicDone = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Done\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	const openrouterCall = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"nix_read_note\",\"arguments\":\"{}\"}}]}}]}\n\ndata: [DONE]\n\n"
	const openrouterDone = "data: {\"choices\":[{\"delta\":{\"content\":\"Done\"}}]}\n\ndata: [DONE]\n\n"
	for _, tc := range []struct {
		name, kind, modalities, firstReply, done string
		want, absent                             []string
	}{
		{
			name: "anthropic", kind: "anthropic", firstReply: anthropicCall, done: anthropicDone,
			want: []string{`"type":"tool_result"`, `"type":"image"`, `"media_type":"image/jpeg"`, `"data":"/9j/AAAA"`},
		},
		{
			name: "openrouter vision model", kind: "openrouter", modalities: `["text","image"]`, firstReply: openrouterCall, done: openrouterDone,
			want: []string{`"role":"tool"`, `"type":"image_url"`, `"url":"` + picture + `"`},
		},
		{
			name: "openrouter text-only model", kind: "openrouter", modalities: `["text"]`, firstReply: openrouterCall, done: openrouterDone,
			want:   []string{`"role":"tool"`, "cannot see images"},
			absent: []string{"image_url", "/9j/AAAA"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/models") {
					w.Header().Set("Content-Type", "application/json")
					_, _ = fmt.Fprintf(w, `{"data":[{"id":"test-model","name":"Test","supported_parameters":["tools"],"architecture":{"input_modalities":%s}}]}`, tc.modalities)
					return
				}
				body, _ := io.ReadAll(r.Body)
				calls++
				w.Header().Set("Content-Type", "text/event-stream")
				if calls == 1 {
					_, _ = fmt.Fprint(w, tc.firstReply)
					return
				}
				for _, want := range tc.want {
					if !strings.Contains(string(body), want) {
						t.Errorf("second request lacks %s: %s", want, body)
					}
				}
				for _, absent := range tc.absent {
					if strings.Contains(string(body), absent) {
						t.Errorf("second request carries %s: %s", absent, body)
					}
				}
				_, _ = fmt.Fprint(w, tc.done)
			}))
			defer server.Close()
			n := newNotifications()
			transport := testTransport(t, tc.kind, server.URL, n.notify)
			peer := transport.(toolTransport)
			peer.SetRequestHandler(func(id json.RawMessage, _ string, _ json.RawMessage) bool {
				go func() { _ = peer.Reply(id, toolOutput(true, `{"fileName":"shot.png"}`, picture)) }()
				return true
			})
			tools := []any{map[string]any{"name": "nix_read_note", "description": "read", "inputSchema": map[string]any{"type": "object"}}}
			startThreadAndTurn(t, transport, tools, "What is in the screenshot?")
			n.wait(t)
			if calls != 2 {
				t.Fatalf("expected two provider requests, got %d", calls)
			}
		})
	}
}

func TestToolImageIsAcceptedOnlyAsAJpegDataURLWithAToolResult(t *testing.T) {
	for _, tc := range []struct {
		operation, image string
		ok               bool
	}{
		{"tool_result", "", true},
		{"tool_result", "data:image/jpeg;base64,/9j/AA==", true},
		{"send", "data:image/jpeg;base64,/9j/AA==", false},
		{"tool_result", "data:image/png;base64,iVBO", false},
		{"tool_result", "data:image/jpeg;base64,/9j/\nAA", false},
		{"tool_result", "data:image/jpeg;base64," + strings.Repeat("A", maxToolImageLength), false},
	} {
		if got := validToolImage(Request{Operation: tc.operation, ToolImage: tc.image}); got != tc.ok {
			t.Errorf("validToolImage(%s, %.40q) = %v, want %v", tc.operation, tc.image, got, tc.ok)
		}
	}
}

func TestOpenRouterMarksTheSystemPromptCachedOnlyForClaudeModels(t *testing.T) {
	for model, cached := range map[string]bool{"anthropic/claude-opus-5-5": true, "openai/gpt-5": false} {
		var seen []byte
		server := sseServer(t, http.StatusOK, []string{
			"data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"},\"finish_reason\":\"stop\"}]}\n\n",
			"data: [DONE]\n\n",
		}, func(_ *http.Request, body []byte) { seen = body })
		thread := &httpThread{Model: model, System: "sys", Messages: []providerMessage{{Role: "user", Text: "Hello"}}}
		if _, _, err := (openrouterWire{}).stream(context.Background(), server.Client(), server.URL, "sk-or-test", thread, func(string) {}); err != nil {
			t.Fatal(err)
		}
		server.Close()
		marked := strings.Contains(string(seen), `{"content":[{"cache_control":{"type":"ephemeral"},"text":"sys","type":"text"}],"role":"system"}`)
		if marked != cached {
			t.Fatalf("%s: cache marker %v, want %v: %s", model, marked, cached, seen)
		}
	}
}
