package companion

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// toolVersion 11 adds explicit field edits and dynamic field sources.
// Older provider threads restart on their next send to receive the current catalog and rules;
// visible conversation history and its protected-read hold are retained.
const toolVersion = 11

type Request struct {
	TenantID    string `json:"tenantId"`
	PrincipalID string `json:"principalId"`
	WorkspaceID string `json:"workspaceId"`
	PetID       string `json:"petId"`
	Operation   string `json:"operation"`
	// Provider names the model provider for this pet: "chatgpt" (the Codex app-server, the
	// default when empty), "anthropic" or "openrouter". ApiKey carries the owner's own key for
	// the HTTP providers on every request; it lives in memory for the account's life only.
	Provider           string    `json:"provider,omitempty"`
	ApiKey             string    `json:"apiKey,omitempty"`
	RequestID          string    `json:"requestId"`
	Text               string    `json:"text"`
	Instructions       string    `json:"instructions"`
	ItemID             string    `json:"itemId"`
	ItemTitle          string    `json:"itemTitle"`
	SharedText         string    `json:"sharedText"`
	Model              string    `json:"model"`
	Mode               string    `json:"mode"`
	WorkspaceAccess    bool      `json:"workspaceAccess"`
	RootItemID         string    `json:"rootItemId"`
	ConversationItemID string    `json:"conversationItemId,omitempty"`
	SourceWorkspaceIDs []string  `json:"sourceWorkspaceIds,omitempty"`
	EarlierMessages    []Message `json:"earlierMessages,omitempty"`
	ReadOnly           bool      `json:"readOnly"`
	ToolID             string    `json:"toolId"`
	ToolResult         string    `json:"toolResult"`
	ToolSuccess        bool      `json:"toolSuccess"`
	// ToolLockedContent says the tool result being reported came from an item under a lock (the
	// executor's lockedContent). It sets the conversation's LockedRead.
	ToolLockedContent bool `json:"toolLockedContent"`
	// ToolImage is a picture a tool_result carries (a file the browser read), as a JPEG data
	// URL. It goes to the model beside ToolResult and is never logged or stored with the
	// conversation; an API-key provider's thread history keeps it like the rest of the result.
	ToolImage string `json:"toolImage"`
	HistoryID string `json:"historyId"`
	// InlineKind, ContextText and Language belong to the "inline" operation only (inline.go):
	// the kind of writing task, the surrounding note text for context, and the translate target.
	InlineKind  string `json:"inlineKind"`
	ContextText string `json:"contextText"`
	Language    string `json:"language"`
	// After is the client's last known conversation revision. Only "watch" uses it: the
	// operation waits for a change past this revision instead of returning immediately.
	After int64 `json:"after"`
	// Today (yyyy-MM-dd in the owner's zone) and TimeZone (IANA) come with every send so the
	// model can resolve "tomorrow" or "this Friday" without guessing. Either may be empty.
	Today    string `json:"today"`
	TimeZone string `json:"timeZone"`
	// WorkspaceMap is the web client's view of the workspace's main containers, sent with a
	// conversation's first message. It reaches the prompt only on a turn that starts a new
	// thread; later turns rely on the thread's own history.
	WorkspaceMap []WorkspaceMapEntry `json:"workspaceMap"`
	// Items are the notes attached to a send, first one being ItemID. Core has already checked
	// each for the caller. ReplaceFromMessageID names the user message a send replaces: it and
	// everything after it is dropped first.
	Items                []SharedItem `json:"items"`
	ReplaceFromMessageID string       `json:"replaceFromMessageId"`
	// earlier is the retained transcript a replacing send gives its fresh thread; set by send.
	earlier string
}

// SharedItem is one attached note: its identity and the title Core read for it.
type SharedItem struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// maxToolImageLength bounds ToolImage; Core enforces the same bound on the way in.
const maxToolImageLength = 1_000_000

var toolImagePattern = regexp.MustCompile(`^data:image/jpeg;base64,[A-Za-z0-9+/]+={0,2}$`)

// validToolImage: no picture, or a JPEG data URL with a tool result.
func validToolImage(r Request) bool {
	return r.ToolImage == "" || r.Operation == "tool_result" && len(r.ToolImage) <= maxToolImageLength && toolImagePattern.MatchString(r.ToolImage)
}

// maxSharedItems bounds Items; Core enforces the same bound on the way in.
const maxSharedItems = 5

// maxEarlierRunes bounds the transcript a replacing send hands its fresh thread.
const maxEarlierRunes = 8000

var (
	// errReplaceTarget: ReplaceFromMessageID is not a user message in this conversation.
	errReplaceTarget = errors.New("replace target is not a user message")
	// errReplaceBusy: a replacing send arrived while a turn is running.
	errReplaceBusy = errors.New("turn already running")
)

// WorkspaceMapEntry is one container the owner can see: its identity, title, body type and the
// kinds of view it offers. ViewKinds is empty when the client did not know them.
type WorkspaceMapEntry struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Type      string   `json:"type"`
	ViewKinds []string `json:"viewKinds,omitempty"`
}

// maxWorkspaceMapEntries bounds WorkspaceMap; Core enforces the same bound on the way in.
const maxWorkspaceMapEntries = 40

// Message is one conversation message. Proposed changes no longer ride on a message: every
// change the pet makes is a typed tool call (tools.go) with its own approval card.
type Message struct {
	ID   string `json:"id"`
	Role string `json:"role"`
	Text string `json:"text"`
}

type Response struct {
	Provider        string         `json:"provider"`
	Status          string         `json:"status"`
	Reason          string         `json:"reason"`
	CanConnect      bool           `json:"canConnect"`
	VerificationURL string         `json:"verificationUrl"`
	UserCode        string         `json:"userCode"`
	State           string         `json:"state"`
	Messages        []Message      `json:"messages"`
	Models          []Model        `json:"models"`
	Tools           []ToolCall     `json:"tools"`
	History         []HistoryEntry `json:"history"`
	// Revision lets a watcher tell whether anything changed since it last looked.
	Revision int64 `json:"revision"`
	// LockedRead says this conversation has received a protected tool result. The web client
	// holds every later write for the owner until an explicit conversation reset.
	LockedRead bool `json:"lockedRead"`
	// Title names the live conversation: the owner's rename, else the default (defaultTitle).
	Title string `json:"title"`
}

type conversation struct {
	DurableState       string     `json:"durableState,omitempty"`
	ToolVersion        int        `json:"toolVersion"`
	ThreadID           string     `json:"threadId"`
	TurnID             string     `json:"-"`
	RequestID          string     `json:"requestId"`
	State              string     `json:"-"`
	Reason             string     `json:"reason,omitempty"`
	Messages           []Message  `json:"messages"`
	WorkspaceAccess    bool       `json:"-"`
	RootItemID         string     `json:"rootItemId,omitempty"`
	ConversationItemID string     `json:"conversationItemId,omitempty"`
	SourceWorkspaceIDs []string   `json:"sourceWorkspaceIds,omitempty"`
	actor              Request    `json:"-"`
	ReadOnly           bool       `json:"readOnly,omitempty"`
	Tools              []ToolCall `json:"tools"`
	// Title is the owner's name for this conversation, or the one set at its first send.
	Title string `json:"title,omitempty"`
	// LockedRead is set once a protected tool result reaches this conversation. Later turns
	// may quote that result, including visible history after an internal provider-thread restart.
	// Only an explicit conversation reset clears it; tool-version changes preserve it.
	LockedRead bool `json:"lockedRead,omitempty"`
	// Revision is never persisted: every load (fresh or restored) gets a new one, monotonic
	// across worker restarts because it is seeded from the clock rather than a counter.
	Revision int64 `json:"-"`
	// timing is in-memory-only bookkeeping (turnlog.go) for the turn/completed log line and
	// the 15-minute "thinking" expiry check (expireStaleThinking, watch.go): never persisted,
	// never sent to the client, reset by timing.start() at the beginning of every send().
	timing turnTiming
}

type ConversationToolExecutor func(context.Context, string, string, string, string, json.RawMessage) (string, bool, bool, error)

type account struct {
	executeConversationTool ConversationToolExecutor
	mu                      sync.Mutex
	// provider is the model provider this account speaks to (see Request.Provider).
	provider string
	// op serializes state transitions while notifications continue to use mu.
	op            sync.Mutex
	transport     Transport
	home          string
	loginID       string
	url           string
	code          string
	status        string
	reason        string
	last          time.Time
	conversations map[string]*conversation
	models        []Model
	// changed is closed and replaced every time bumpLocked runs, waking every watcher
	// blocked on it. Read under mu, then selected on after mu is released.
	changed chan struct{}
	// watchers counts concurrent "watch" operations for this account, capping them so a
	// pile of open long-polls cannot exhaust the worker.
	watchers int32
	// inlineStreams counts open "inline" streams for this account (inline.go), capping them
	// the way watchers caps watches. inline routes each inline provider thread to its stream;
	// guarded by mu.
	inlineStreams int32
	inline        map[string]*inlineRun
	// chatEffort is the owner's configured reasoning effort (NIX_COMPANION_CHAT_EFFORT,
	// default "low"). effortFor only sends it on turn/start when the effective model
	// actually advertises it.
	chatEffort string
	// logger receives one line per completed turn (timings only, never content).
	logger *slog.Logger
	// trace enables the opt-in full-content trace (diagnostics.go); traceFull remembers which
	// conversations already hit the trace size cap.
	trace     bool
	traceFull map[string]bool
}

type Manager struct {
	executeConversationTool ConversationToolExecutor
	mu                      sync.Mutex
	root                    string
	binary                  string
	ctx                     context.Context
	accounts                map[string]*account
	launch                  func(context.Context, string, string, string, string, func(string, json.RawMessage)) (Transport, error)
	// chatEffort is handed to each account this manager creates; see the matching account
	// field.
	chatEffort string
	logger     *slog.Logger
	trace      bool
}

// Options configures New. Root and Binary are required; ChatEffort is handed to every account
// this manager creates (see the matching account field). A nil Logger means slog.Default().
type Options struct {
	ExecuteConversationTool ConversationToolExecutor
	Root                    string
	Binary                  string
	ChatEffort              string
	Logger                  *slog.Logger
	// Trace turns on the full-content trace and Codex stderr capture (diagnostics.go).
	Trace bool
}

func New(ctx context.Context, opts Options) (*Manager, error) {
	if !filepath.IsAbs(opts.Root) {
		return nil, errors.New("companion data directory must be absolute")
	}
	if err := os.MkdirAll(opts.Root, 0700); err != nil {
		return nil, err
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	m := &Manager{executeConversationTool: opts.ExecuteConversationTool, root: opts.Root, binary: opts.Binary, ctx: ctx, accounts: map[string]*account{}, launch: launchProvider, chatEffort: opts.ChatEffort, logger: logger, trace: opts.Trace}
	if opts.Trace {
		m.launch = func(ctx context.Context, provider, binary, home, apiKey string, notify func(string, json.RawMessage)) (Transport, error) {
			if provider != "" && provider != "chatgpt" {
				return newHTTPTransport(provider, apiKey, home, notify)
			}
			return launchWith(ctx, binary, home, notify, true)
		}
	}
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				m.Close()
				return
			case <-ticker.C:
				m.reap()
			}
		}
	}()
	return m, nil
}

func (m *Manager) reap() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, a := range m.accounts {
		a.mu.Lock()
		idle := time.Since(a.last) > 20*time.Minute
		a.mu.Unlock()
		if idle && a.op.TryLock() {
			_ = a.transport.Close()
			delete(m.accounts, key)
			a.op.Unlock()
		}
	}
}

func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, a := range m.accounts {
		_ = a.transport.Close()
		delete(m.accounts, key)
	}
}

// launchProvider picks the process behind the seam: the Codex app-server for ChatGPT accounts, an
// in-process HTTPS transport for the key providers. Same vocabulary either side.
func launchProvider(ctx context.Context, provider, binary, home, apiKey string, notify func(string, json.RawMessage)) (Transport, error) {
	if provider != "" && provider != "chatgpt" {
		return newHTTPTransport(provider, apiKey, home, notify)
	}
	return launch(ctx, binary, home, notify)
}

func providerOf(r Request) string {
	if r.Provider == "" {
		return "chatgpt"
	}
	return r.Provider
}

func (m *Manager) account(ctx context.Context, r Request) (*account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	// One account per provider: conversation files share the principal's home (they are
	// provider-neutral), but the process behind the seam is the provider's own.
	key := r.TenantID + "-" + r.PrincipalID
	if provider := providerOf(r); provider != "chatgpt" {
		key += "-" + provider
	}
	if a := m.accounts[key]; a != nil {
		if a.provider != "chatgpt" && a.transport != nil {
			if keyed, ok := a.transport.(*httpTransport); ok {
				keyed.mu.Lock()
				keyed.apiKey = r.ApiKey
				keyed.mu.Unlock()
			}
		}
		if live, ok := a.transport.(interface{ Alive() bool }); ok && !live.Alive() {
			delete(m.accounts, key)
		} else {
			a.mu.Lock()
			a.last = time.Now()
			a.mu.Unlock()
			return a, nil
		}
	}
	if len(m.accounts) >= 4 {
		return nil, errors.New("companion capacity reached")
	}
	a := &account{executeConversationTool: m.executeConversationTool, provider: providerOf(r), home: filepath.Join(m.root, r.TenantID+"-"+r.PrincipalID), status: "disconnected", conversations: map[string]*conversation{}, last: time.Now(), chatEffort: m.chatEffort, logger: m.logger, trace: m.trace}
	transport, err := m.launch(m.ctx, a.provider, m.binary, a.home, r.ApiKey, a.notify)
	if err != nil {
		return nil, err
	}
	a.transport = transport
	if peer, ok := transport.(toolTransport); ok {
		peer.SetRequestHandler(a.toolRequest)
	}
	if _, err = a.handle(ctx, Request{Operation: "status"}); err != nil {
		_ = transport.Close()
		return nil, err
	}
	m.accounts[key] = a
	return a, nil
}

// ServeHTTP is mounted behind the worker's existing constant-time service authentication.
func (m *Manager) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	// Room for a tool result's picture (maxToolImageLength); every other field is bounded below.
	r.Body = http.MaxBytesReader(w, r.Body, 1200<<10)
	var request Request
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var extra any
	if decoder.Decode(&request) != nil || decoder.Decode(&extra) != io.EOF || (request.Operation != "inline" && !validRequest(request)) {
		http.Error(w, "Invalid companion request", http.StatusBadRequest)
		return
	}
	if request.Operation == "inline" {
		m.serveInline(w, r, request)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	a, err := m.account(ctx, request)
	if err != nil {
		// The provider process could not start or answer its first status call (a missing
		// binary, a crashed runtime, the account cap): without this line the only symptom is a
		// 503 in the browser.
		m.logger.Error("companion runtime unavailable", "operation", request.Operation, "error", logSafeError(err))
		http.Error(w, "Companion runtime unavailable", http.StatusServiceUnavailable)
		return
	}
	// A watch or a plain read never claims a.op: they must never see "Companion is busy"
	// while a send or tool operation holds it. Everything else keeps the exclusive lock.
	if request.Operation == "watch" {
		// Checked before the conversation is loaded: Core's NixUnitOfWorkMiddleware pins a
		// database connection behind every watch for its whole wait, so this cap is what
		// bounds pinned connections per principal.
		if !a.tryAcquireWatcher() {
			a.mu.Lock()
			a.record(conversationKey(request), slog.LevelWarn, "watch.refused", []any{"reason", "too many open watches"}, nil)
			a.mu.Unlock()
			http.Error(w, "Too many open watches", http.StatusTooManyRequests)
			return
		}
		defer a.releaseWatcher()
	}
	if request.Operation != "read" && request.Operation != "watch" {
		if !a.op.TryLock() {
			a.mu.Lock()
			a.record(conversationKey(request), slog.LevelWarn, "request.busy", []any{"operation", request.Operation}, nil)
			a.mu.Unlock()
			http.Error(w, "Companion is busy", http.StatusConflict)
			return
		}
		defer a.op.Unlock()
	}
	a.mu.Lock()
	a.last = time.Now()
	a.mu.Unlock()
	response, err := a.handle(ctx, request)
	if err != nil {
		a.mu.Lock()
		a.record(conversationKey(request), slog.LevelWarn, "request.failed", []any{"operation", request.Operation, "error", logSafeError(err)}, nil)
		a.mu.Unlock()
		switch {
		case errors.Is(err, errReplaceTarget):
			http.Error(w, "Invalid companion request", http.StatusBadRequest)
		case errors.Is(err, errReplaceBusy):
			http.Error(w, "Companion is busy", http.StatusConflict)
		default:
			writeProviderFailure(w, err)
		}
		return
	}
	_ = json.NewEncoder(w).Encode(response)
}

func validRequest(r Request) bool {
	if !uuid.MatchString(r.TenantID) || !uuid.MatchString(r.PrincipalID) {
		return false
	}
	switch r.Operation {
	case "status", "connect", "disconnect", "models":
		return true
	case "read", "watch", "send", "interrupt", "reset", "tool_claim", "tool_result", "history", "read_history", "delete_history", "rename", "resume_history":
		return validHistoryOp(r) && uuid.MatchString(r.WorkspaceID) && uuid.MatchString(r.PetID) && (r.RootItemID == "" || uuid.MatchString(r.RootItemID)) && validTurnContext(r) && utf16Len(r.Text) <= 8000 && utf16Len(r.SharedText) <= 16000 && utf16Len(r.Instructions) <= 4000 && len(r.Model) <= 160 && utf16Len(r.ToolResult) <= 32000 && validToolImage(r) && len(r.ToolID) <= 200 && (r.Mode == "" || r.Mode == "chat" || r.Mode == "consult") && (r.Operation != "send" || (uuid.MatchString(r.RequestID) && strings.TrimSpace(r.Text) != "")) && (!strings.HasPrefix(r.Operation, "tool_") || (uuid.MatchString(r.RequestID) && r.ToolID != ""))
	default:
		return false
	}
}

// utf16Len counts s the way Core and the browser count a string's length - in UTF-16 code units -
// so a limit both sides state as the same number means the same thing. len(s) counts UTF-8 bytes:
// a 121-character title of "é" is 242 bytes and would fail a 240 limit Core already accepted.
func utf16Len(s string) int {
	units := 0
	for _, r := range s {
		if r >= 0x10000 {
			units += 2
		} else {
			units++
		}
	}
	return units
}

var timeZoneName = regexp.MustCompile(`^[A-Za-z0-9_+\-/]{1,64}$`)

// validTurnContext bounds the date, zone and workspace map a request may carry. Core validates
// the same limits first; this is the worker refusing to trust its one caller blindly.
func validTurnContext(r Request) bool {
	if !validConversationContext(r) {
		return false
	}
	if r.Today != "" {
		if _, err := time.Parse(time.DateOnly, r.Today); err != nil {
			return false
		}
	}
	if r.TimeZone != "" && !timeZoneName.MatchString(r.TimeZone) {
		return false
	}
	if len(r.WorkspaceMap) > maxWorkspaceMapEntries || len(r.Items) > maxSharedItems {
		return false
	}
	for _, item := range r.Items {
		if !uuid.MatchString(item.ID) || utf16Len(item.Title) > 240 {
			return false
		}
	}
	if r.ReplaceFromMessageID != "" && (r.Operation != "send" || !uuid.MatchString(r.ReplaceFromMessageID)) {
		return false
	}
	for _, entry := range r.WorkspaceMap {
		if !uuid.MatchString(entry.ID) || utf16Len(entry.Title) > 240 || utf16Len(entry.Type) > 64 || len(entry.ViewKinds) > 12 {
			return false
		}
		for _, kind := range entry.ViewKinds {
			if utf16Len(kind) > 40 {
				return false
			}
		}
	}
	return true
}

func (a *account) handle(ctx context.Context, r Request) (Response, error) {
	if r.Operation == "models" {
		if err := a.listModels(ctx); err != nil {
			return Response{}, err
		}
	} else if r.Operation == "connect" && a.provider != "chatgpt" {
		// A key provider "connects" by proving the key: one model listing, nothing stored here.
		if err := a.listModels(ctx); err != nil {
			a.mu.Lock()
			a.status = "error"
			a.reason = err.Error()
			a.mu.Unlock()
			return a.snapshot(""), nil
		}
		a.mu.Lock()
		a.status = "connected"
		a.reason = "API key accepted."
		a.mu.Unlock()
	} else if r.Operation == "connect" {
		a.mu.Lock()
		pending := a.loginID != ""
		a.mu.Unlock()
		if !pending {
			raw, err := a.transport.Call(ctx, "account/login/start", map[string]string{"type": "chatgptDeviceCode"})
			if err != nil {
				return Response{}, err
			}
			var login struct {
				LoginID         string `json:"loginId"`
				VerificationURL string `json:"verificationUrl"`
				UserCode        string `json:"userCode"`
			}
			if json.Unmarshal(raw, &login) != nil || login.VerificationURL != "https://auth.openai.com/codex/device" || len(login.UserCode) > 32 {
				return Response{}, errors.New("invalid device login")
			}
			a.mu.Lock()
			a.loginID = login.LoginID
			a.url = login.VerificationURL
			a.code = login.UserCode
			a.status = "connecting"
			a.reason = "Open the sign-in page and enter the code. Device-code login must be enabled in ChatGPT security settings."
			a.mu.Unlock()
		}
	} else if r.Operation == "disconnect" {
		a.mu.Lock()
		active := make([][2]string, 0)
		for _, c := range a.conversations {
			if c.TurnID != "" {
				active = append(active, [2]string{c.ThreadID, c.TurnID})
			}
		}
		a.mu.Unlock()
		for _, turn := range active {
			if _, err := a.transport.Call(ctx, "turn/interrupt", map[string]string{"threadId": turn[0], "turnId": turn[1]}); err != nil {
				return Response{}, err
			}
		}
		a.mu.Lock()
		login := a.loginID
		a.mu.Unlock()
		if login != "" {
			if _, err := a.transport.Call(ctx, "account/login/cancel", map[string]string{"loginId": login}); err != nil {
				return Response{}, err
			}
		}
		if _, err := a.transport.Call(ctx, "account/logout", map[string]any{}); err != nil {
			return Response{}, err
		}
		a.mu.Lock()
		a.status = "disconnected"
		a.loginID = ""
		a.url = ""
		a.code = ""
		a.reason = "ChatGPT disconnected."
		a.mu.Unlock()
	} else if r.Operation == "status" {
		raw, err := a.transport.Call(ctx, "account/read", map[string]bool{"refreshToken": false})
		if err != nil {
			return Response{}, err
		}
		var status struct {
			Account *struct {
				Type string `json:"type"`
			} `json:"account"`
		}
		if json.Unmarshal(raw, &status) != nil {
			return Response{}, errors.New("invalid account status")
		}
		a.mu.Lock()
		if status.Account != nil && status.Account.Type == "chatgpt" {
			a.status = "connected"
			a.reason = "ChatGPT connected. Messages use your account's Codex allowance."
			a.loginID = ""
			a.url = ""
			a.code = ""
		} else if status.Account != nil && status.Account.Type == "apiKey" {
			a.status = "connected"
			a.reason = "API key saved. Messages are billed to that key."
		} else if a.provider != "chatgpt" {
			a.status = "disconnected"
			a.reason = "Add an API key for this provider in Settings > Pets."
		} else if a.loginID == "" {
			a.status = "disconnected"
			a.reason = "Connect your ChatGPT account to talk with your companion."
		}
		a.mu.Unlock()
	} else {
		key := conversationKey(r)
		if err := a.foldDesign(key); err != nil {
			return Response{}, err
		}
		if r.Operation == "history" || r.Operation == "read_history" || r.Operation == "delete_history" || r.Operation == "rename" && r.HistoryID != "" {
			return a.history(key, r)
		}
		if err := a.load(key); err != nil {
			return Response{}, err
		}
		a.mu.Lock()
		c := a.conversations[key]
		state := c.State
		a.mu.Unlock()
		if strings.HasPrefix(r.Operation, "tool_") {
			if err := a.resolveTool(key, r); err != nil {
				return Response{}, err
			}
		} else if r.Operation == "send" {
			a.mu.Lock()
			duplicate := c.RequestID == r.RequestID
			a.mu.Unlock()
			if state == "thinking" && !duplicate {
				if r.ReplaceFromMessageID != "" {
					return Response{}, errReplaceBusy
				}
				return Response{}, errors.New("turn already running")
			}
			if !duplicate && r.ReplaceFromMessageID != "" {
				a.mu.Lock()
				cut := replaceIndex(c.Messages, r.ReplaceFromMessageID)
				a.mu.Unlock()
				if cut < 0 {
					return Response{}, errReplaceTarget
				}
			}
			if !duplicate {
				if err := a.send(ctx, key, r); err != nil {
					return Response{}, err
				}
			}
		} else if r.Operation == "interrupt" {
			a.cancelTools(key)
			a.mu.Lock()
			thread, turn := c.ThreadID, c.TurnID
			a.mu.Unlock()
			if turn != "" {
				if _, err := a.transport.Call(ctx, "turn/interrupt", map[string]string{"threadId": thread, "turnId": turn}); err != nil {
					return Response{}, err
				}
			}
		} else if r.Operation == "reset" {
			if state == "thinking" {
				return Response{}, errors.New("stop the running turn first")
			}
			a.mu.Lock()
			if err := a.archiveLocked(key); err != nil {
				a.mu.Unlock()
				return Response{}, err
			}
			a.conversations[key] = &conversation{Messages: []Message{}, State: "idle"}
			err := a.saveLocked(key)
			a.mu.Unlock()
			if err != nil {
				return Response{}, err
			}
		} else if r.Operation == "resume_history" {
			if err := a.resume(key, r); err != nil {
				return Response{}, err
			}
		} else if r.Operation == "rename" {
			if err := a.renameLive(key, r); err != nil {
				return Response{}, err
			}
		} else if r.Operation == "watch" {
			// Never touches the transport before this; only waits for bumpLocked to close
			// a.changed, the request context to end, or its own timeout, whichever comes
			// first. Once it returns, run the same 15-minute "thinking" expiry check the
			// plain-read path below runs, so a watcher notices a stuck turn too.
			a.awaitChange(ctx, key, r.After, 20*time.Second)
			a.expireStaleThinking(ctx, key, c)
		} else if state == "thinking" {
			// ServeHTTP no longer holds a.op for "read", so this 15-minute expiry cleanup
			// (the only place a plain read can reach) manages its own non-blocking claim:
			// when a send or tool operation is using the transport, skip it this time
			// rather than block a read that must never wait.
			a.expireStaleThinking(ctx, key, c)
		}
		return a.snapshot(key), nil
	}
	return a.snapshot(""), nil
}

func (a *account) snapshot(key string) Response {
	a.mu.Lock()
	defer a.mu.Unlock()
	r := Response{Provider: a.provider, Status: a.status, CanConnect: a.status != "connected", Reason: a.reason, VerificationURL: a.url, UserCode: a.code, State: "idle", Messages: []Message{}}
	r.Models = append([]Model{}, a.models...)
	r.Tools = []ToolCall{}
	r.History = []HistoryEntry{}
	if c := a.conversations[key]; c != nil {
		r.State = c.State
		if c.State == "error" && c.Reason != "" {
			r.Reason = c.Reason
		}
		r.Messages = append([]Message{}, c.Messages...)
		r.Tools = append([]ToolCall{}, c.Tools...)
		r.Revision = c.Revision
		r.LockedRead = c.LockedRead
		r.Title = c.Title
		if r.Title == "" {
			r.Title = defaultTitle(c.Messages)
		}
	}
	return r
}

func (a *account) load(key string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.conversations[key] != nil {
		return nil
	}
	if len(a.conversations) >= 128 {
		return errors.New("conversation capacity reached")
	}
	c := &conversation{State: "idle", Messages: []Message{}}
	f, err := os.Open(filepath.Join(a.home, key+".json"))
	if err == nil {
		defer f.Close()
		if json.NewDecoder(io.LimitReader(f, 4<<20)).Decode(c) != nil {
			return errors.New("conversation could not be restored")
		}
		c.State = "idle"
		if c.ConversationItemID != "" {
			c.State = c.DurableState
			if c.State == "" || c.State == "thinking" {
				c.State = "error"
				c.Reason = "The worker restarted before this response completed. Retry to continue from saved messages."
			}
		}
		for i := range c.Tools {
			if c.Tools[i].Status == "pending" || c.Tools[i].Status == "claimed" {
				c.Tools[i].Status = "interrupted"
				c.Tools[i].Result = "Worker restarted. Check Nix before requesting this change again."
			}
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	// Never persisted (json:"-"): every load, fresh or restored, gets a revision seeded
	// from the clock so it stays monotonic across a worker restart.
	c.Revision = time.Now().UnixMilli()
	a.conversations[key] = c
	return nil
}

func (a *account) saveLocked(key string) error {
	// Bounded provider conversation cache; workspace state is still owned by Core.
	c := a.conversations[key]
	a.bumpLocked(c)
	// A streaming draft (id contains ":draft:") is never durable: encode a copy with
	// drafts removed rather than the live conversation.
	persisted := *c
	if c.ConversationItemID != "" {
		persisted.DurableState = c.State
	}
	persisted.Messages = withoutDrafts(c.Messages)
	path := filepath.Join(a.home, key+".json")
	f, err := os.OpenFile(path+".tmp", os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	err = json.NewEncoder(f).Encode(&persisted)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}

func (a *account) send(ctx context.Context, key string, r Request) error {
	a.mu.Lock()
	c := a.conversations[key]
	thread := c.ThreadID
	if r.ConversationItemID != "" {
		thread = ""
		r.earlier = ""
		c.Messages = append([]Message{}, r.EarlierMessages...)
	}
	if c.ToolVersion != toolVersion || c.ReadOnly != r.ReadOnly {
		thread = ""
	}
	if r.ReplaceFromMessageID != "" {
		// The provider thread still holds the replaced turn, so the model starts a fresh one and
		// is given the visible messages that stay.
		thread = ""
		r.earlier = earlierTranscript(c.Messages[:max(replaceIndex(c.Messages, r.ReplaceFromMessageID), 0)])
	} else if r.ConversationItemID == "" && c.ThreadID == "" && len(c.Messages) > 0 {
		// A resumed archive has its messages but no provider thread (resume, history.go).
		r.earlier = earlierTranscript(c.Messages)
	}
	a.mu.Unlock()
	params := map[string]any{"cwd": filepath.Join(a.home, "empty"), "sandbox": "read-only", "approvalPolicy": "on-request", "baseInstructions": instructions() + noteScopeRules(r) + conversationScopeRules(r), "developerInstructions": r.Instructions}
	supportsTools := true
	if r.Model != "" || a.provider != "" && a.provider != "chatgpt" {
		if err := a.listModels(ctx); err != nil {
			return err
		}
		a.mu.Lock()
		selectedModel := r.Model
		if selectedModel == "" {
			selectedModel = defaultModel(a.models).ID
		}
		found := false
		for _, model := range a.models {
			if model.ID == selectedModel {
				found = true
				supportsTools = model.SupportsTools
			}
		}
		a.mu.Unlock()
		if !found {
			return errors.New("model is unavailable")
		}
		if !supportsTools && r.WorkspaceAccess {
			// Said rather than silently dropping the tools: a model that cannot call tools
			// cannot act on the workspace, and pretending otherwise would be a reply that never
			// reads or writes anything while claiming it did.
			a.mu.Lock()
			c.State = "error"
			c.Reason = "This model cannot use tools. Pick another model, or turn Workspace access off for this message."
			a.bumpLocked(c)
			a.mu.Unlock()
			return errors.New("model does not support tools")
		}
		params["model"] = selectedModel
	}
	method := "thread/start"
	if thread == "" && supportsTools {
		params["dynamicTools"] = workspaceToolsForRequest(r)
	}
	if thread != "" {
		method = "thread/resume"
		params["threadId"] = thread
	}
	raw, err := a.transport.Call(ctx, method, params)
	if err != nil {
		a.mu.Lock()
		a.record(key, slog.LevelWarn, "turn.start_failed", []any{"step", method, "error", logSafeError(err)}, nil)
		a.mu.Unlock()
		return err
	}
	var started struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if json.Unmarshal(raw, &started) != nil || started.Thread.ID == "" {
		return errors.New("invalid thread response")
	}
	thread = started.Thread.ID
	prompt, _ := json.Marshal(turnPrompt(r, method == "thread/start"))
	a.mu.Lock()
	// A stale, previously used conversation (not a first-ever one, which has no thread
	// and ToolVersion 0) that is only now catching up to the current tool version had
	// its thread dropped above; tell the user before replacing their state below.
	if r.ConversationItemID == "" && c.ThreadID != "" && c.ToolVersion != 0 && c.ToolVersion != toolVersion {
		c.Messages = append(c.Messages, Message{ID: r.RequestID + ":tools", Role: "system", Text: "Your pet was updated and starts a fresh conversation."})
	}
	if c.ThreadID != "" && c.ReadOnly != r.ReadOnly {
		c.Messages = append(c.Messages, Message{ID: r.RequestID + ":access", Role: "system", Text: "Chat access changed. The pet will read this note again as needed."})
	}
	// Internal provider-thread replacement keeps the visible conversation and its read hold.
	// Only an explicit conversation reset clears LockedRead.
	c.ThreadID = thread
	c.ToolVersion = toolVersion
	c.RequestID = r.RequestID
	c.State = "thinking"
	c.Reason = ""
	c.WorkspaceAccess = r.WorkspaceAccess
	c.RootItemID = r.RootItemID
	c.ConversationItemID = r.ConversationItemID
	c.SourceWorkspaceIDs = append([]string{}, r.SourceWorkspaceIDs...)
	c.actor = r
	c.actor.ApiKey = ""
	c.actor.EarlierMessages = nil
	c.ReadOnly = r.ReadOnly
	c.Tools = []ToolCall{}
	c.timing.start(r.Model, "")
	if r.ReplaceFromMessageID != "" {
		if cut := replaceIndex(c.Messages, r.ReplaceFromMessageID); cut >= 0 {
			c.Messages = c.Messages[:cut]
		}
	}
	c.Messages = append(c.Messages, Message{ID: r.RequestID, Role: "user", Text: r.Text})
	c.Messages = trimMessages(c.Messages, 16)
	if c.Title == "" {
		c.Title = defaultTitle(c.Messages)
	}
	err = a.saveLocked(key)
	a.mu.Unlock()
	if err != nil {
		return err
	}
	turnParams := map[string]any{"threadId": thread, "input": []any{map[string]any{"type": "text", "text": string(prompt)}}}
	if effort := a.effortFor(ctx, r.Model); effort != "" {
		turnParams["effort"] = effort
		a.mu.Lock()
		c.timing.effort = effort
		a.mu.Unlock()
	}
	a.mu.Lock()
	threadKind := "resumed"
	if method == "thread/start" {
		threadKind = "new"
	}
	a.record(key, slog.LevelInfo, "turn.started",
		[]any{"model", valueOrDefault(r.Model), "effort", c.timing.effort, "thread", threadKind, "tool_version", toolVersion, "workspace_access", r.WorkspaceAccess, "message_chars", len(r.Text), "shared_chars", len(r.SharedText)},
		map[string]any{"prompt": json.RawMessage(prompt), "instructions": r.Instructions})
	a.mu.Unlock()
	raw, err = a.transport.Call(ctx, "turn/start", turnParams)
	if err != nil {
		a.mu.Lock()
		a.record(key, slog.LevelWarn, "turn.start_failed", []any{"step", "turn/start", "error", logSafeError(err)}, nil)
		c.State = "error"
		c.Reason = "The response could not start. Check the selected model and ChatGPT connection, then retry."
		a.bumpLocked(c)
		a.mu.Unlock()
		return err
	}
	var turn struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if json.Unmarshal(raw, &turn) != nil {
		return errors.New("invalid turn response")
	}
	a.mu.Lock()
	c.TurnID = turn.Turn.ID
	a.mu.Unlock()
	return nil
}

// turnPrompt is the JSON object one user turn sends the model. today and timeZone ride on every
// turn; workspaceMap only on a turn that starts a new thread, since a resumed thread already holds
// it in its history and resending it every turn would only spend context.
func turnPrompt(r Request, newThread bool) map[string]any {
	prompt := map[string]any{"message": r.Text, "workspaceId": r.WorkspaceID, "currentItemId": r.ItemID, "currentItemTitle": r.ItemTitle, "sharedText": r.SharedText, "workspaceAccess": r.WorkspaceAccess, "today": r.Today, "timeZone": r.TimeZone}
	if r.ConversationItemID != "" {
		prompt["conversationItemId"] = r.ConversationItemID
		prompt["sourceWorkspaceIds"] = r.SourceWorkspaceIDs
		prompt["readOnly"] = true
	}
	if len(r.Items) > 1 {
		prompt["sharedItems"] = r.Items
	}
	if r.ConversationItemID != "" && newThread {
		prompt["earlierMessages"] = r.EarlierMessages
	}
	if r.earlier != "" && newThread {
		prompt["earlierMessages"] = r.earlier
	}
	if r.RootItemID != "" {
		prompt["rootItemId"] = r.RootItemID
		prompt["readOnly"] = r.ReadOnly
	}
	if newThread && r.ConversationItemID == "" && r.RootItemID == "" && len(r.WorkspaceMap) > 0 {
		prompt["workspaceMap"] = r.WorkspaceMap
	}
	return prompt
}

func (a *account) notify(method string, raw json.RawMessage) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if method == "account/login/completed" {
		var p struct {
			Success bool `json:"success"`
		}
		if json.Unmarshal(raw, &p) != nil {
			return
		}
		a.loginID = ""
		a.url = ""
		a.code = ""
		if p.Success {
			a.status = "connected"
			a.reason = "ChatGPT connected."
		} else {
			a.status = "error"
			a.reason = "Sign-in did not complete. Try connecting again."
		}
		return
	}
	var p struct {
		ThreadID string `json:"threadId"`
		ItemID   string `json:"itemId"`
		Delta    string `json:"delta"`
		Item     struct {
			ID    string `json:"id"`
			Type  string `json:"type"`
			Text  string `json:"text"`
			Phase string `json:"phase"`
		} `json:"item"`
		Turn struct {
			Status     string         `json:"status"`
			DurationMs *int64         `json:"durationMs"`
			Error      *turnError     `json:"error"`
			Usage      *providerUsage `json:"usage"`
		} `json:"turn"`
		Error     *turnError `json:"error"`
		WillRetry bool       `json:"willRetry"`
	}
	if json.Unmarshal(raw, &p) != nil {
		return
	}
	if p.ThreadID == "" {
		// Account-level notifications (rate limits, account updates, and the like) belong to no
		// conversation: traced for debugging, never logged.
		if a.trace && method != "account/rateLimits/updated" {
			a.record("", slog.LevelDebug, "provider.notification", []any{"method", method}, map[string]any{"params": traceRaw(raw)})
		}
		return
	}
	// An inline thread (inline.go) belongs to no conversation: it goes to its stream and must
	// never reach the conversation code below.
	failure := ""
	if p.Turn.Error != nil {
		failure = providerFailureMessage(a.provider, p.Turn.Error.NixProviderError)
	}
	if failure != "" && a.inlineRunFor(p.ThreadID) != nil && method == "turn/completed" {
		token := p.Turn.Error.NixProviderError
		a.record("", slog.LevelWarn, "inline.provider_failed", []any{"operation", "inline", "provider_error", token, "http_status", token[strings.LastIndex(token, ".")+1:]}, nil)
	}
	if a.routeInlineLocked(p.ThreadID, method, p.Item.Type, p.Item.Phase, p.Delta, p.Turn.Status, failure) {
		return
	}
	for key, c := range a.conversations {
		if c.ThreadID != p.ThreadID || p.ThreadID == "" {
			continue
		}
		if method == "item/agentMessage/delta" {
			a.applyDeltaLocked(c, p.ItemID, p.Delta)
		}
		a.recordNotificationLocked(key, method, raw, p.Item.Type, p.Item.Phase, p.Item.Text, p.Error, p.WillRetry)
		if method == "item/completed" && p.Item.Type == "agentMessage" && len(p.Item.ID) <= 200 {
			// The draft is only ever provisional; the commentary or final message below
			// replaces it once the item is done.
			id := draftID(c.RequestID, p.Item.ID)
			for i := range c.Messages {
				if c.Messages[i].ID == id {
					c.Messages = append(c.Messages[:i], c.Messages[i+1:]...)
					break
				}
			}
		}
		if method == "item/completed" && p.Item.Type == "agentMessage" && p.Item.Phase == "commentary" {
			text := strings.TrimSpace(p.Item.Text)
			if c.State != "thinking" || text == "" || len(text) > 8000 || len(p.Item.ID) > 200 {
				continue
			}
			digest := sha256.Sum256([]byte(p.Item.ID))
			id := fmt.Sprintf("%s:commentary:%x", c.RequestID, digest[:16])
			seen := false
			if len(c.Messages) > 0 {
				last := c.Messages[len(c.Messages)-1]
				seen = last.Role == "assistant" && last.Text == text
			}
			for _, message := range c.Messages {
				if message.ID == id {
					seen = true
					break
				}
			}
			if !seen {
				c.Messages = append(c.Messages, Message{ID: id, Role: "assistant", Text: text})
				c.Messages = trimMessages(c.Messages, 40)
				_ = a.saveLocked(key)
			}
		}
		if method == "item/completed" && p.Item.Type == "agentMessage" && p.Item.Phase != "commentary" {
			// The final answer is plain text (L2.2). toolVersion 5 and later force a
			// fresh thread on every conversation that predates this, so a provider reply can
			// never carry the retired {"answer": string} envelope here; a genuine JSON reply
			// (the model answering a JSON-shaped question, say) is used exactly as written,
			// never unwrapped.
			text := p.Item.Text
			c.Messages = append(c.Messages, Message{ID: c.RequestID + ":assistant", Role: "assistant", Text: truncateUTF8(text, 32000)})
			a.bumpLocked(c)
		}
		if method == "turn/completed" {
			c.timing.usage = p.Turn.Usage
			c.timing.log(a.logger, key, p.Turn.Status)
			if p.Turn.Status != "completed" && p.Turn.Status != "interrupted" {
				meta := []any{"status", p.Turn.Status}
				if failure != "" {
					token := p.Turn.Error.NixProviderError
					meta = append(meta, "operation", "send", "provider_error", token, "http_status", token[strings.LastIndex(token, ".")+1:])
				}
				if p.Turn.DurationMs != nil {
					meta = append(meta, "provider_duration_ms", *p.Turn.DurationMs)
				}
				meta = append(meta, p.Turn.Error.logAttrs()...)
				a.record(key, slog.LevelWarn, "turn.failed", meta, map[string]any{"turn": traceRaw(raw)})
			}
			a.cancelToolsLocked(key)
			c.Messages = withoutDrafts(c.Messages)
			c.TurnID = ""
			if p.Turn.Status == "completed" && c.State != "error" {
				c.State = "success"
			} else if p.Turn.Status == "interrupted" {
				c.State = "idle"
			} else {
				c.State = "error"
				if failure != "" {
					c.Reason = failure
				}
				if c.Reason == "" {
					c.Reason = "The model could not finish the response. Check account access and usage, then retry."
				}
			}
			if err := a.saveLocked(key); err != nil {
				c.State = "error"
				c.Reason = "Conversation could not be saved."
				a.bumpLocked(c)
			}
		}
	}
}

// replaceIndex is where the message with this id sits when it is the conversation's last user
// message - only the last turn can be replaced - else -1.
func replaceIndex(messages []Message, id string) int {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" {
			if messages[i].ID == id {
				return i
			}
			return -1
		}
	}
	return -1
}

// earlierTranscript renders the final user and assistant messages as plain text. When it is over
// maxEarlierRunes the oldest whole messages go first, so it never starts mid-message. Commentary,
// drafts and system notices are left out.
func earlierTranscript(messages []Message) string {
	var lines []string
	for _, m := range messages {
		if m.Role == "system" || strings.Contains(m.ID, ":commentary:") || strings.Contains(m.ID, ":draft:") {
			continue
		}
		speaker := "User"
		if m.Role == "assistant" {
			speaker = "Assistant"
		}
		lines = append(lines, speaker+": "+m.Text)
	}
	kept, used := 0, 0
	for i := len(lines) - 1; i >= 0; i-- {
		used += len([]rune(lines[i])) + 2
		if used-2 > maxEarlierRunes {
			break
		}
		kept++
	}
	return strings.Join(lines[len(lines)-kept:], "\n\n")
}
