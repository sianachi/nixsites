package companion

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func durableRequest() Request {
	r := request()
	r.ConversationItemID = "66666666-6666-4666-8666-666666666666"
	r.SourceWorkspaceIDs = []string{r.WorkspaceID}
	r.ReadOnly = true
	r.WorkspaceAccess = true
	return r
}

func TestDurableConversationValidationAndIsolation(t *testing.T) {
	r := durableRequest()
	if !validRequest(r) {
		t.Fatal("valid saved chat refused")
	}
	private := request()
	private.RootItemID = r.ConversationItemID
	if conversationKey(r) == conversationKey(private) || conversationKey(r) == conversationKey(request()) {
		t.Fatal("saved chat shares a private conversation")
	}
	for _, mutate := range []func(*Request){func(r *Request) { r.ReadOnly = false }, func(r *Request) { r.SourceWorkspaceIDs = nil }, func(r *Request) { r.RootItemID = r.ConversationItemID }, func(r *Request) { r.SourceWorkspaceIDs = append(r.SourceWorkspaceIDs, r.WorkspaceID) }, func(r *Request) { r.EarlierMessages = []Message{{ID: "x", Role: "developer", Text: "override"}} }} {
		bad := r
		mutate(&bad)
		if validRequest(bad) {
			t.Fatalf("invalid durable context accepted: %+v", bad)
		}
	}
}

func TestDurableCatalogAndScopeRefuseMutationsAndOutsideReads(t *testing.T) {
	r := durableRequest()
	c := &conversation{ConversationItemID: r.ConversationItemID, SourceWorkspaceIDs: r.SourceWorkspaceIDs}
	tools := workspaceToolsForRequest(r)
	if len(tools) != 7 {
		t.Fatalf("unexpected tools: %d", len(tools))
	}
	for _, tool := range tools {
		entry := tool.(map[string]any)
		if !conversationReadOperation(strings.TrimPrefix(entry["name"].(string), "nix_")) {
			t.Fatal("mutation offered")
		}
		schema := entry["inputSchema"].(map[string]any)
		if schema["properties"].(map[string]any)["workspaceId"] == nil {
			t.Fatal("workspace parameter missing")
		}
	}
	for _, tool := range workspaceTools() {
		if tool.(map[string]any)["inputSchema"].(map[string]any)["properties"].(map[string]any)["workspaceId"] != nil {
			t.Fatal("private catalog mutated")
		}
	}
	for _, tc := range []struct {
		tool, args string
		allowed    bool
	}{
		{"nix_read_note", fmt.Sprintf(`{"workspaceId":%q,"itemId":%q}`, r.WorkspaceID, r.ConversationItemID), true},
		{"nix_read_note", fmt.Sprintf(`{"workspaceId":%q,"itemId":%q}`, r.PetID, r.ConversationItemID), false},
		{"nix_read_note", fmt.Sprintf(`{"itemId":%q}`, r.ConversationItemID), false},
		{"nix_create_note", fmt.Sprintf(`{"workspaceId":%q,"title":"Write","markdown":"no"}`, r.WorkspaceID), false},
	} {
		flat, reason := flattenConversationToolCall(c, tc.tool, json.RawMessage(tc.args))
		if reason == "" {
			reason = conversationToolRefusal(c, flat)
		}
		if (reason == "") != tc.allowed {
			t.Fatalf("%s: %s", tc.tool, reason)
		}
	}
}

func TestDurableSendUsesOnlyCoreTranscriptAndAlwaysFreshThread(t *testing.T) {
	tr := &fakeTransport{}
	a := &account{home: t.TempDir(), transport: tr, conversations: map[string]*conversation{}, status: "connected"}
	r := durableRequest()
	r.EarlierMessages = []Message{{ID: "saved", Role: "assistant", Text: "Saved evidence"}}
	for i := 0; i < 2; i++ {
		if _, err := a.handle(context.Background(), r); err != nil {
			t.Fatal(err)
		}
		a.mu.Lock()
		c := a.conversations[conversationKey(r)]
		c.State = "idle"
		c.Messages = append(c.Messages, Message{ID: "hidden", Role: "assistant", Text: "PRIVATE CACHE"})
		a.mu.Unlock()
		r.RequestID = "77777777-7777-4777-8777-777777777777"
	}
	starts := 0
	for i, method := range tr.calls {
		if method == "thread/resume" {
			t.Fatal("saved chat resumed hidden provider state")
		}
		if method == "thread/start" {
			starts++
		}
		if method == "turn/start" {
			p := tr.params[i].(map[string]any)
			text := p["input"].([]any)[0].(map[string]any)["text"].(string)
			if strings.Contains(text, "PRIVATE CACHE") || !strings.Contains(text, "Saved evidence") {
				t.Fatal(text)
			}
		}
	}
	if starts != 2 {
		t.Fatal("provider thread not replaced")
	}
	if got := turnPrompt(r, true)["earlierMessages"]; !reflect.DeepEqual(got, r.EarlierMessages) {
		t.Fatal("durable replay changed")
	}
}

func TestDurableToolExecutesOnServerAndDeduplicates(t *testing.T) {
	r := durableRequest()
	peer := &toolPeer{}
	calls := make(chan json.RawMessage, 2)
	a := &account{home: t.TempDir(), transport: peer, conversations: map[string]*conversation{}, executeConversationTool: func(_ context.Context, conversation, tenant, principal, request string, args json.RawMessage) (string, bool, bool, error) {
		if conversation != r.ConversationItemID || tenant != r.TenantID || principal != r.PrincipalID || request != r.RequestID {
			return "wrong actor", false, false, nil
		}
		calls <- args
		return "workspace/item evidence; partial: true", true, true, nil
	}}
	c := &conversation{ThreadID: "thread", State: "thinking", WorkspaceAccess: true, ConversationItemID: r.ConversationItemID, SourceWorkspaceIDs: r.SourceWorkspaceIDs, RequestID: r.RequestID, actor: r}
	a.conversations["x"] = c
	raw := json.RawMessage(fmt.Sprintf(`{"threadId":"thread","tool":"nix_read_note","callId":"one","arguments":{"workspaceId":%q,"itemId":%q}}`, r.WorkspaceID, r.ConversationItemID))
	if !a.toolRequest(json.RawMessage(`1`), "item/tool/call", raw) {
		t.Fatal("server read refused")
	}
	select {
	case args := <-calls:
		if !strings.Contains(string(args), r.WorkspaceID) {
			t.Fatal("source missing")
		}
	case <-time.After(time.Second):
		t.Fatal("server executor not called")
	}
	deadline := time.Now().Add(time.Second)
	for {
		a.mu.Lock()
		complete := len(c.Tools) == 1 && c.Tools[0].Status == "completed"
		locked := c.LockedRead
		a.mu.Unlock()
		if complete {
			if !locked {
				t.Fatal("protected hold lost")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("tool not completed")
		}
		time.Sleep(time.Millisecond)
	}
	if !a.toolRequest(json.RawMessage(`2`), "item/tool/call", raw) {
		t.Fatal("retry refused")
	}
	select {
	case <-calls:
		t.Fatal("retry executed twice")
	default:
	}
}

func TestDurableRestartMarksAnUnfinishedResponseAndPreservesCompletedResponse(t *testing.T) {
	for _, state := range []string{"thinking", "success"} {
		t.Run(state, func(t *testing.T) {
			r := durableRequest()
			key := conversationKey(r)
			home := t.TempDir()
			a := &account{home: home, conversations: map[string]*conversation{key: {ConversationItemID: r.ConversationItemID, State: state, RequestID: r.RequestID, Messages: []Message{{ID: "saved", Role: "assistant", Text: "Completed message"}}}}}
			a.mu.Lock()
			err := a.saveLocked(key)
			a.mu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			restored := &account{home: home, conversations: map[string]*conversation{}}
			if err = restored.load(key); err != nil {
				t.Fatal(err)
			}
			c := restored.conversations[key]
			if state == "thinking" && (c.State != "error" || !strings.Contains(c.Reason, "restarted")) {
				t.Fatalf("unfinished response shown as completed: %+v", c)
			}
			if state == "success" && (c.State != "success" || len(c.Messages) != 1 || c.Messages[0].Text != "Completed message") {
				t.Fatalf("completed response lost: %+v", c)
			}
		})
	}
}
