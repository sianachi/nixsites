package companion

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// httpTransport serves the Codex app-server method vocabulary the manager already speaks
// (thread/start, turn/start, item/tool/call, turn/completed, ...) over a provider's HTTPS API:
// Anthropic's Messages API or OpenRouter's OpenAI-compatible chat completions. The manager,
// tools.go's 20-call cap and dedupe, watch.go's expiry and the browser's approval UI are unchanged;
// only the process behind the seam differs. The API key lives in memory for the account's life and
// is never written to disk or logs. Thread history is kept per thread under the account home so a
// resumed thread survives a worker restart; it is bounded (trimThread) like the visible
// conversation.
type httpTransport struct {
	kind   string
	apiKey string
	home   string
	// baseURL overrides the provider's origin; tests point it at a local server.
	baseURL string
	notify  func(string, json.RawMessage)
	client  *http.Client
	wire    providerWire

	mu      sync.Mutex
	threads map[string]*httpThread
	turns   map[string]context.CancelFunc
	nextID  int
	replies map[string]chan toolReply
	handler func(json.RawMessage, string, json.RawMessage) bool
	closed  bool
	// seesImages holds the listed models that take image input; nil until a list is read.
	seesImages map[string]bool
}

// A thread keeps its last maxThreadTurns turns, and drops more while its text passes
// maxThreadBytes. Counting turns, not messages, matters because one turn with ten tool calls
// adds twenty messages and would otherwise push every earlier turn out at once.
const (
	maxThreadTurns = 12
	maxThreadBytes = 600_000
)
const maxToolRoundsPerTurn = 24

// providerMessage is the provider-neutral record a thread keeps; the wire encodes it per provider.
type providerMessage struct {
	Role      string             `json:"role"`
	Text      string             `json:"text,omitempty"`
	ToolCalls []providerToolCall `json:"toolCalls,omitempty"`
	// ToolResults answer the previous assistant message's ToolCalls, in order.
	ToolResults []providerToolResult `json:"toolResults,omitempty"`
}

type providerToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type providerToolResult struct {
	CallID  string `json:"callId"`
	Text    string `json:"text"`
	IsError bool   `json:"isError"`
	// Image is a picture the result carried, a JPEG data URL; each wire encodes it its own way.
	Image string `json:"image,omitempty"`
}

type httpThread struct {
	ID       string            `json:"id"`
	Model    string            `json:"model"`
	System   string            `json:"system"`
	Tools    []json.RawMessage `json:"tools"`
	Messages []providerMessage `json:"messages"`
	// Opening is the thread's first user message, kept once trimming has dropped it: it alone
	// carries the workspace map (manager.go's turnPrompt sends it only when a thread starts).
	Opening   string `json:"opening,omitempty"`
	Ephemeral bool   `json:"-"`
	// usage sums the current turn's token counts; runTurn resets it and reports it on completion.
	usage providerUsage
}

type toolReply struct {
	text    string
	image   string
	success bool
}

// providerWire is the per-provider half: how models are listed and how one assistant turn is
// streamed. Both implementations call back into the transport for deltas and tool calls.
type providerWire interface {
	listModels(ctx context.Context, client *http.Client, base, apiKey string) ([]Model, error)
	// stream runs one provider request for the thread as it stands and reports the assistant
	// text and tool calls it produced. It returns when the provider finishes the message.
	stream(ctx context.Context, client *http.Client, base, apiKey string, thread *httpThread, onDelta func(string)) (text string, calls []providerToolCall, err error)
}

func newHTTPTransport(kind, apiKey, home string, notify func(string, json.RawMessage)) (Transport, error) {
	var wire providerWire
	switch kind {
	case "anthropic":
		wire = anthropicWire{}
	case "openrouter":
		wire = openrouterWire{}
	default:
		return nil, fmt.Errorf("unknown provider %q", kind)
	}
	if err := os.MkdirAll(filepath.Join(home, "threads"), 0700); err != nil {
		return nil, err
	}
	return &httpTransport{
		kind:    kind,
		apiKey:  apiKey,
		home:    home,
		notify:  notify,
		client:  &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		wire:    wire,
		threads: map[string]*httpThread{},
		turns:   map[string]context.CancelFunc{},
		replies: map[string]chan toolReply{},
	}, nil
}

func (t *httpTransport) Alive() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return !t.closed
}

func (t *httpTransport) SetRequestHandler(handler func(json.RawMessage, string, json.RawMessage) bool) {
	t.mu.Lock()
	t.handler = handler
	t.mu.Unlock()
}

// Reply delivers a tool result (tools.go's toolOutput shape) to the turn waiting for it.
func (t *httpTransport) Reply(id json.RawMessage, result any) error {
	encoded, err := json.Marshal(result)
	if err != nil {
		return err
	}
	var out struct {
		Success      bool `json:"success"`
		ContentItems []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			ImageURL string `json:"imageUrl"`
		} `json:"contentItems"`
	}
	_ = json.Unmarshal(encoded, &out)
	text, image := "", ""
	if len(out.ContentItems) > 0 {
		text = out.ContentItems[0].Text
	}
	for _, item := range out.ContentItems {
		if item.Type == "inputImage" {
			image = item.ImageURL
		}
	}
	t.mu.Lock()
	ch := t.replies[string(id)]
	t.mu.Unlock()
	if ch == nil {
		return errors.New("no pending tool call for that id")
	}
	select {
	case ch <- toolReply{text: text, image: image, success: out.Success}:
	default:
	}
	return nil
}

func (t *httpTransport) Close() error {
	t.mu.Lock()
	t.closed = true
	for id, cancel := range t.turns {
		cancel()
		delete(t.turns, id)
	}
	t.mu.Unlock()
	return nil
}

func (t *httpTransport) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	encoded, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	switch method {
	case "initialize", "initialized", "account/logout", "account/login/cancel":
		return json.RawMessage(`{}`), nil
	case "thread/unsubscribe":
		var p struct {
			ThreadID string `json:"threadId"`
		}
		if err := json.Unmarshal(encoded, &p); err != nil {
			return nil, err
		}
		t.mu.Lock()
		if thread := t.threads[p.ThreadID]; thread != nil && thread.Ephemeral {
			delete(t.threads, p.ThreadID)
		}
		t.mu.Unlock()
		return json.RawMessage(`{}`), nil
	case "account/read":
		if t.apiKey == "" {
			return json.RawMessage(`{"account":null}`), nil
		}
		return json.RawMessage(`{"account":{"type":"apiKey"}}`), nil
	case "account/login/start":
		return nil, errors.New("this provider signs in with an API key saved in Pet settings, not a device code")
	case "model/list":
		models, err := t.listModels(ctx)
		if err != nil {
			return nil, err
		}
		return encodeModelList(models)
	case "thread/start":
		return t.startThread(ctx, encoded)
	case "thread/resume":
		var p struct {
			ThreadID string `json:"threadId"`
		}
		if json.Unmarshal(encoded, &p) != nil || p.ThreadID == "" {
			return nil, errors.New("thread id required")
		}
		if _, err := t.thread(p.ThreadID); err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"thread": map[string]string{"id": p.ThreadID}})
	case "turn/start":
		return t.startTurn(encoded)
	case "turn/interrupt":
		var p struct {
			TurnID string `json:"turnId"`
		}
		_ = json.Unmarshal(encoded, &p)
		t.mu.Lock()
		cancel := t.turns[p.TurnID]
		t.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		return json.RawMessage(`{}`), nil
	default:
		return nil, fmt.Errorf("provider refused %s", method)
	}
}

// encodeModelList emits the page shape tools.go's listModels parses, plus supportsTools, which
// Codex never sends (its models all take tools) and which an OpenRouter model may lack.
func encodeModelList(models []Model) (json.RawMessage, error) {
	data := make([]map[string]any, 0, len(models))
	for _, model := range models {
		data = append(data, map[string]any{
			"model":         model.ID,
			"displayName":   model.Name,
			"isDefault":     model.Default,
			"supportsTools": model.SupportsTools,
		})
	}
	return json.Marshal(map[string]any{"data": data})
}

func (t *httpTransport) startThread(ctx context.Context, params json.RawMessage) (json.RawMessage, error) {
	var p struct {
		Model                 string            `json:"model"`
		BaseInstructions      string            `json:"baseInstructions"`
		DeveloperInstructions string            `json:"developerInstructions"`
		DynamicTools          []json.RawMessage `json:"dynamicTools"`
		Ephemeral             bool              `json:"ephemeral"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, err
	}
	if p.Model == "" {
		models, err := t.listModels(ctx)
		if err != nil {
			return nil, err
		}
		if len(models) == 0 {
			return nil, errors.New("provider listed no models")
		}
		p.Model = defaultModel(models).ID
	}
	id, err := randomID()
	if err != nil {
		return nil, err
	}
	thread := &httpThread{
		ID:        id,
		Model:     p.Model,
		System:    p.BaseInstructions + "\n\n" + p.DeveloperInstructions,
		Tools:     p.DynamicTools,
		Messages:  []providerMessage{},
		Ephemeral: p.Ephemeral,
	}
	t.mu.Lock()
	t.threads[id] = thread
	t.mu.Unlock()
	return json.Marshal(map[string]any{"thread": map[string]string{"id": id}})
}

func (t *httpTransport) thread(id string) (*httpThread, error) {
	t.mu.Lock()
	thread := t.threads[id]
	t.mu.Unlock()
	if thread != nil {
		return thread, nil
	}
	raw, err := os.ReadFile(t.threadPath(id))
	if err != nil {
		return nil, errors.New("that conversation's thread is no longer available; start a new one")
	}
	loaded := &httpThread{}
	if json.Unmarshal(raw, loaded) != nil || loaded.ID != id {
		return nil, errors.New("that conversation's thread could not be read")
	}
	t.mu.Lock()
	t.threads[id] = loaded
	t.mu.Unlock()
	return loaded, nil
}

func (t *httpTransport) threadPath(id string) string {
	return filepath.Join(t.home, "threads", id+".json")
}

func (t *httpTransport) save(thread *httpThread) {
	if thread.Ephemeral {
		return
	}
	t.mu.Lock()
	trimThread(thread)
	raw, err := json.Marshal(thread)
	t.mu.Unlock()
	if err == nil {
		_ = os.WriteFile(t.threadPath(thread.ID), raw, 0600)
	}
}

// trimThread drops a thread's oldest turns past maxThreadTurns, and more while it is over
// maxThreadBytes, always cutting at a turn's opening user message: a cut between a tool call
// and its results leaves an orphan every provider rejects. The latest turn is never dropped, so
// the bound gives way rather than the turn. The first message is kept as Opening and repeated at
// the head of what remains, so a trimmed thread still knows the workspace.
func trimThread(thread *httpThread) {
	var starts []int
	size := 0
	for i, message := range thread.Messages {
		if message.Role == "user" && len(message.ToolResults) == 0 {
			starts = append(starts, i)
		}
		size += messageBytes(message)
	}
	cut := 0
	if len(starts) > maxThreadTurns {
		cut = len(starts) - maxThreadTurns
	}
	for cut < len(starts) {
		dropped := 0
		for _, message := range thread.Messages[:starts[cut]] {
			dropped += messageBytes(message)
		}
		if size-dropped <= maxThreadBytes || cut == len(starts)-1 {
			break
		}
		cut++
	}
	if cut == 0 || cut >= len(starts) {
		return
	}
	if thread.Opening == "" {
		thread.Opening = thread.Messages[0].Text
	}
	kept := append([]providerMessage(nil), thread.Messages[starts[cut]:]...)
	kept[0].Text = "The conversation began with this message; its earlier turns were dropped to save space:\n" + thread.Opening + "\n\nThe message now:\n" + kept[0].Text
	thread.Messages = kept
}

func messageBytes(message providerMessage) int {
	size := len(message.Text)
	for _, call := range message.ToolCalls {
		size += len(call.Arguments)
	}
	for _, result := range message.ToolResults {
		size += len(result.Text) + len(result.Image)
	}
	return size
}

func (t *httpTransport) startTurn(params json.RawMessage) (json.RawMessage, error) {
	var p struct {
		ThreadID string `json:"threadId"`
		Input    []struct {
			Text string `json:"text"`
		} `json:"input"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.ThreadID == "" || len(p.Input) == 0 {
		return nil, errors.New("thread id and input required")
	}
	thread, err := t.thread(p.ThreadID)
	if err != nil {
		return nil, err
	}
	if t.apiKey == "" {
		return nil, errors.New("no API key for this provider; add one in Pet settings")
	}
	turnID, err := randomID()
	if err != nil {
		return nil, err
	}
	t.mu.Lock()
	thread.Messages = append(thread.Messages, providerMessage{Role: "user", Text: p.Input[0].Text})
	ctx, cancel := context.WithCancel(context.Background())
	t.turns[turnID] = cancel
	t.mu.Unlock()
	go t.runTurn(ctx, thread, turnID)
	return json.Marshal(map[string]any{"turn": map[string]string{"id": turnID}})
}

// runTurn is the agent loop for one turn: stream the assistant message, hand each tool call to the
// manager's handler (the same claim/approve/result path the browser drives), feed the results back,
// and repeat until the model answers without tools. Every outcome ends in turn/completed.
func (t *httpTransport) runTurn(ctx context.Context, thread *httpThread, turnID string) {
	defer func() {
		t.mu.Lock()
		if thread.Ephemeral {
			delete(t.threads, thread.ID)
		}
		if cancel := t.turns[turnID]; cancel != nil {
			cancel()
			delete(t.turns, turnID)
		}
		t.mu.Unlock()
	}()
	thread.usage = providerUsage{}
	finish := func(status string, failure error) {
		turn := map[string]any{"status": status, "usage": thread.usage}
		if failure != nil {
			turn["error"] = map[string]any{"message": failure.Error(), "nixProviderError": providerFailureToken(failure)}
		}
		raw, _ := json.Marshal(map[string]any{"threadId": thread.ID, "turn": turn})
		t.notify("turn/completed", raw)
	}
	for round := 0; round < maxToolRoundsPerTurn; round++ {
		itemID := fmt.Sprintf("%s-%d", turnID, round)
		text, calls, err := t.wire.stream(ctx, t.client, t.baseURL, t.apiKey, thread, func(delta string) {
			raw, _ := json.Marshal(map[string]any{"threadId": thread.ID, "itemId": itemID, "delta": delta})
			t.notify("item/agentMessage/delta", raw)
		})
		// An interrupted turn can surface as a cancelled context or as the provider closing the
		// stream early; either way the owner asked for it to stop.
		if ctx.Err() != nil {
			finish("interrupted", nil)
			return
		}
		if err != nil {
			finish("failed", err)
			return
		}
		// A reply with neither words nor tool calls would show as a blank bubble and read as success.
		if len(calls) == 0 && strings.TrimSpace(text) == "" {
			finish("failed", errors.New("The model finished without an answer. Try again"))
			return
		}
		t.mu.Lock()
		thread.Messages = append(thread.Messages, providerMessage{Role: "assistant", Text: text, ToolCalls: calls})
		t.mu.Unlock()
		if len(calls) == 0 {
			t.save(thread)
			raw, _ := json.Marshal(map[string]any{"threadId": thread.ID, "item": map[string]string{"id": itemID, "type": "agentMessage", "text": text, "phase": "final_answer"}})
			t.notify("item/completed", raw)
			finish("completed", nil)
			return
		}
		if text != "" {
			raw, _ := json.Marshal(map[string]any{"threadId": thread.ID, "item": map[string]string{"id": itemID + "-commentary", "type": "agentMessage", "text": text, "phase": "commentary"}})
			t.notify("item/completed", raw)
		}
		results := make([]providerToolResult, 0, len(calls))
		for i, call := range calls {
			reply, ok := t.askTool(ctx, thread.ID, call)
			if !ok {
				// Every call still gets an answer: an assistant tool call with no result after it
				// makes the provider refuse the thread's next message.
				for _, unanswered := range calls[i:] {
					results = append(results, providerToolResult{CallID: unanswered.ID, Text: "The owner stopped the turn before this tool ran.", IsError: true})
				}
				t.mu.Lock()
				thread.Messages = append(thread.Messages, providerMessage{Role: "user", ToolResults: results})
				t.mu.Unlock()
				t.save(thread)
				finish("interrupted", nil)
				return
			}
			if reply.image != "" && !t.acceptsImages(ctx, thread.Model) {
				// A picture a text-only model is sent fails this request and every later one in the
				// thread, since the history keeps it.
				reply.text += "\nThis result is a picture, but the selected model cannot see images. Tell the owner to choose a model that accepts images in Settings > Pets."
				reply.image = ""
			}
			results = append(results, providerToolResult{CallID: call.ID, Text: reply.text, Image: reply.image, IsError: !reply.success})
		}
		t.mu.Lock()
		thread.Messages = append(thread.Messages, providerMessage{Role: "user", ToolResults: results})
		t.mu.Unlock()
		t.save(thread)
	}
	finish("failed", errors.New("The model kept calling tools without answering; the turn was stopped."))
}

// askTool routes one model tool call through the manager's handler and waits for the owner's
// decision. A refusal from the handler (tool not offered, access off) becomes an error result the
// model sees at once, the same words rpc.go gives Codex. A cancelled turn returns ok=false.
func (t *httpTransport) askTool(ctx context.Context, threadID string, call providerToolCall) (toolReply, bool) {
	t.mu.Lock()
	t.nextID++
	id := json.RawMessage(strconv.Itoa(t.nextID))
	ch := make(chan toolReply, 1)
	t.replies[string(id)] = ch
	handler := t.handler
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		delete(t.replies, string(id))
		t.mu.Unlock()
	}()
	params, _ := json.Marshal(map[string]any{"threadId": threadID, "tool": call.Name, "callId": call.ID, "arguments": call.Arguments})
	if handler == nil || !handler(id, "item/tool/call", params) {
		return toolReply{text: "That tool is not available in this conversation (workspace access may be off).", success: false}, true
	}
	select {
	case reply := <-ch:
		return reply, true
	case <-ctx.Done():
		return toolReply{}, false
	}
}

func randomID() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

// readSSE calls onEvent for each `data:` payload of a server-sent event stream until the body ends
// or the context is cancelled. A `[DONE]` sentinel (OpenAI style) ends the stream.
func readSSE(ctx context.Context, body interface{ Read([]byte) (int, error) }, onEvent func(event string, data []byte) error) error {
	reader := newLineReader(body)
	event := ""
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		line, err := reader.line()
		if err != nil {
			if errors.Is(err, errEOF) {
				return nil
			}
			return err
		}
		switch {
		case len(line) == 0:
			event = ""
		case len(line) > 6 && string(line[:6]) == "event:":
			event = trimSpace(string(line[6:]))
		case len(line) > 5 && string(line[:5]) == "data:":
			data := trimSpace(string(line[5:]))
			if data == "[DONE]" {
				return nil
			}
			if err := onEvent(event, []byte(data)); err != nil {
				return err
			}
		}
	}
}

func trimSpace(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\r' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}

var errEOF = errors.New("eof")

// lineReader reads newline-delimited lines with a bound, so a misbehaving provider cannot grow a
// buffer without end.
type lineReader struct {
	source interface{ Read([]byte) (int, error) }
	buffer []byte
	done   bool
}

func newLineReader(source interface{ Read([]byte) (int, error) }) *lineReader {
	return &lineReader{source: source}
}

func (r *lineReader) line() ([]byte, error) {
	for {
		for i, b := range r.buffer {
			if b == '\n' {
				line := append([]byte{}, r.buffer[:i]...)
				r.buffer = r.buffer[i+1:]
				return line, nil
			}
		}
		if r.done {
			if len(r.buffer) == 0 {
				return nil, errEOF
			}
			line := r.buffer
			r.buffer = nil
			return line, nil
		}
		if len(r.buffer) > 1<<20 {
			return nil, errors.New("provider stream line too long")
		}
		chunk := make([]byte, 16<<10)
		n, err := r.source.Read(chunk)
		r.buffer = append(r.buffer, chunk[:n]...)
		if err != nil {
			r.done = true
		}
	}
}

// providerTimeout bounds a single provider request; a turn that streams longer than this is failed
// rather than left thinking (watch.go's 15-minute expiry is the outer guard).
const providerTimeout = 10 * time.Minute

// listModels reads the provider's models and remembers which of them take image input.
func (t *httpTransport) listModels(ctx context.Context) ([]Model, error) {
	models, err := t.wire.listModels(ctx, t.client, t.baseURL, t.apiKey)
	if err != nil {
		return nil, err
	}
	seesImages := make(map[string]bool, len(models))
	for _, model := range models {
		seesImages[model.ID] = !model.textOnly
	}
	t.mu.Lock()
	t.seesImages = seesImages
	t.mu.Unlock()
	return models, nil
}

// acceptsImages reports whether model takes image input. Every Claude model does. For OpenRouter
// the model list says, read once if no list has been read yet; a model the list does not name, or
// a list that cannot be read, counts as no.
func (t *httpTransport) acceptsImages(ctx context.Context, model string) bool {
	if t.kind != "openrouter" {
		return true
	}
	t.mu.Lock()
	known := t.seesImages
	t.mu.Unlock()
	if known == nil {
		if _, err := t.listModels(ctx); err != nil {
			return false
		}
		t.mu.Lock()
		known = t.seesImages
		t.mu.Unlock()
	}
	return known[model]
}
