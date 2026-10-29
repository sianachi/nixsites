package companion

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNoteScopeRequestRejectsUnknownFields(t *testing.T) {
	r := request()
	r.RootItemID = "66666666-6666-4666-8666-666666666666"
	r.ReadOnly = true
	body, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	payload["scopeBypass"] = true
	body, err = json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	new(Manager).ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/companion", bytes.NewReader(body)))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown scope field accepted: %d", w.Code)
	}
}

func TestNoteScopeSeparatesConversationAndHistory(t *testing.T) {
	a := &account{home: t.TempDir(), transport: &fakeTransport{}, conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	r.Operation = "read"
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	a.conversations[conversationKey(r)].Messages = []Message{{ID: "workspace", Role: "user", Text: "Workspace material"}}
	r.RootItemID = "66666666-6666-4666-8666-666666666666"
	got, err := a.handle(context.Background(), r)
	if err != nil || len(got.Messages) != 0 {
		t.Fatalf("workspace conversation leaked into note: %+v %v", got, err)
	}
	a.conversations[conversationKey(r)].Messages = []Message{{ID: "note", Role: "user", Text: "Note material"}}
	r.Operation = "reset"
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	r.Operation = "history"
	got, err = a.handle(context.Background(), r)
	if err != nil || len(got.History) != 1 {
		t.Fatalf("note history missing: %+v %v", got, err)
	}
	r.HistoryID = got.History[0].ID
	r.Operation = "read_history"
	r.RootItemID = "77777777-7777-4777-8777-777777777777"
	if _, err := a.handle(context.Background(), r); err == nil {
		t.Fatal("another note read the first note's history")
	}
	r.RootItemID = ""
	if _, err := a.handle(context.Background(), r); err == nil {
		t.Fatal("workspace chat read note history")
	}
}

func TestNoteScopeToolsAndPrompt(t *testing.T) {
	r := request()
	r.RootItemID = "66666666-6666-4666-8666-666666666666"
	r.ReadOnly = true
	r.WorkspaceMap = []WorkspaceMapEntry{{ID: r.WorkspaceID, Title: "Outside", Type: "note"}}
	prompt := turnPrompt(r, true)
	if prompt["rootItemId"] != r.RootItemID || prompt["readOnly"] != true {
		t.Fatalf("missing note scope: %+v", prompt)
	}
	if _, ok := prompt["workspaceMap"]; ok {
		t.Fatal("workspace map escaped into note prompt")
	}
	for _, tool := range workspaceToolsForRequest(r) {
		entry := tool.(map[string]any)
		name := entry["name"]
		if name != "nix_list_items" && name != "nix_search" && name != "nix_read_item" && name != "nix_read_note" && name != "nix_search_note" && name != "nix_read_structure" {
			t.Fatalf("unsafe read-only tool: %v", name)
		}
	}
	c := &conversation{RootItemID: r.RootItemID, ReadOnly: true}
	if noteScopeToolRefusal(c, `{"operation":"append_note"}`) == "" {
		t.Fatal("read-only conversation accepted a mutation")
	}
	c.ReadOnly = false
	if noteScopeToolRefusal(c, `{"operation":"append_note"}`) != "" {
		t.Fatal("approved edit was not offered")
	}
	if noteScopeToolRefusal(c, `{"operation":"read_calendar"}`) == "" {
		t.Fatal("note scope accepted workspace calendar")
	}
}

func TestNoteAccessChangeReplacesProviderThread(t *testing.T) {
	f := &fakeTransport{}
	a := &account{home: t.TempDir(), transport: f, conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	r.RootItemID = "66666666-6666-4666-8666-666666666666"
	r.ReadOnly = true
	key := conversationKey(r)
	a.conversations[key] = &conversation{ToolVersion: toolVersion, ThreadID: "old", ReadOnly: false, Messages: []Message{}}
	if err := a.send(context.Background(), key, r); err != nil {
		t.Fatal(err)
	}
	if f.calls[0] != "thread/start" || !a.conversations[key].ReadOnly {
		t.Fatalf("access change resumed mutable thread: %+v", f.calls)
	}
}
