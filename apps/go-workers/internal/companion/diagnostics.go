package companion

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Diagnostics come in two layers, so a misbehaving pet can be debugged without routinely
// logging what people write:
//
//   - Events always go to the worker's structured log. They carry names, outcomes, counts,
//     durations, fixed refusal reasons and provider error codes - never message text, tool
//     arguments, tool results or workspace ids. A conversation is identified only by a short
//     hash of its key.
//   - A trace is opt-in (NIX_COMPANION_TRACE=true). It appends every event plus its content
//     (the prompt, the model's commentary and answers, the exact tool arguments before and after
//     flattening, the result sent back, raw provider notifications) as JSON lines to
//     <account home>/traces/<conversation>.jsonl, mode 0600, next to the provider login the
//     same directory already holds. Codex's own stderr goes to traces/codex-stderr.log.
//
// The trace is for local debugging only and must not be enabled in production: traces/ holds
// private workspace content and, through Codex's info-level stderr, may hold provider
// credentials, so it is never something to attach to an issue or share. Deleting a
// conversation's history removes that conversation's trace; nothing else expires it.
//
// Everything here is called with a.mu held.

// maxTraceBytes stops one conversation's trace file from growing without bound; a note is
// appended once when the cap is reached.
const maxTraceBytes = 32 << 20

// maxStderrBytes is the size at which codex-stderr.log is rotated to codex-stderr.log.1.
const maxStderrBytes = 8 << 20

// maxTraceContentBytes bounds any single raw payload copied into a trace line.
const maxTraceContentBytes = 64 << 10

// conversationTag is the only identifier events carry: the first 4 bytes of sha256(key), the
// same tag the per-turn timing line uses.
func conversationTag(key string) string {
	if key == "" {
		return "account"
	}
	digest := sha256.Sum256([]byte(key))
	return fmt.Sprintf("%x", digest[:4])
}

// record writes one event. meta is alternating key/value pairs safe for the shared log;
// content is written only to the opt-in trace.
func (a *account) record(key string, level slog.Level, event string, meta []any, content map[string]any) {
	tag := conversationTag(key)
	if a.logger != nil {
		a.logger.Log(context.Background(), level, "companion "+event, append([]any{"conversation", tag}, meta...)...)
	}
	if !a.trace {
		return
	}
	line := map[string]any{"time": time.Now().UTC().Format(time.RFC3339Nano), "conversation": tag, "event": event, "level": level.String()}
	for i := 0; i+1 < len(meta); i += 2 {
		if name, ok := meta[i].(string); ok {
			line[name] = meta[i+1]
		}
	}
	if len(content) > 0 {
		line["content"] = content
	}
	a.appendTrace(tag, line)
}

func (a *account) appendTrace(tag string, line map[string]any) {
	dir := filepath.Join(a.home, "traces")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return
	}
	path := filepath.Join(dir, tag+".jsonl")
	if info, err := os.Stat(path); err == nil && info.Size() >= maxTraceBytes {
		if a.traceFull == nil {
			a.traceFull = map[string]bool{}
		}
		if a.traceFull[tag] {
			return
		}
		a.traceFull[tag] = true
		line = map[string]any{"time": time.Now().UTC().Format(time.RFC3339Nano), "conversation": tag, "event": "trace.full", "note": "trace size cap reached; later events for this conversation are not traced"}
	}
	encoded, err := json.Marshal(line)
	if err != nil {
		return
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return
	}
	_, _ = f.Write(append(encoded, '\n'))
	_ = f.Close()
}

// traceRaw bounds a raw payload for a trace line, keeping valid JSON as JSON.
func traceRaw(raw json.RawMessage) any {
	if len(raw) > maxTraceContentBytes {
		return fmt.Sprintf("(%d bytes, truncated) %s", len(raw), truncateUTF8(string(raw), maxTraceContentBytes))
	}
	if json.Valid(raw) {
		return raw
	}
	return string(raw)
}

// toolOperation names the operation in a flat argument object, or "" when it cannot be read.
func toolOperation(flat string) string {
	var args struct {
		Operation string `json:"operation"`
	}
	if json.Unmarshal([]byte(flat), &args) != nil {
		return ""
	}
	return args.Operation
}

// resultKind classifies a tool result for the shared log without logging its text.
func resultKind(success bool, result string) string {
	switch {
	case success:
		return "ok"
	case result == "Declined by the user. Do not retry this change unless asked.":
		return "declined"
	case len(result) >= len(declinedForProblems) && result[:len(declinedForProblems)] == declinedForProblems:
		return "auto_declined_problems"
	case result == "No result supplied. Do not assume the operation succeeded.":
		return "no_result"
	default:
		return "failed"
	}
}

// declinedForProblems is the prefix the web client uses when it sends a write's validation
// problems back instead of asking the owner (packages/web-pets/src/pets/work-tools/pet-work-tools.tsx).
const declinedForProblems = "Declined: the design has problems."

// conversationKey is the conversation a request addresses: one per pet per workspace. A stale
// client may still send mode "consult"; it addresses the same conversation.
func conversationKey(r Request) string {
	if r.WorkspaceID == "" || r.PetID == "" {
		return ""
	}
	key := r.WorkspaceID + "-" + r.PetID
	if r.ConversationItemID != "" {
		return key + "-chat-" + r.ConversationItemID
	}
	if r.RootItemID != "" {
		key += "-note-" + r.RootItemID
	}
	return key
}

func valueOrDefault(model string) string {
	if model == "" {
		return "default"
	}
	return model
}

// turnError is the provider's TurnError: a message plus a structured code (a string such as
// "usageLimitExceeded", or an object carrying an HTTP status).
type turnError struct {
	Message           string          `json:"message"`
	NixProviderError  string          `json:"nixProviderError"`
	CodexErrorInfo    json.RawMessage `json:"codexErrorInfo"`
	AdditionalDetails *string         `json:"additionalDetails"`
}

// logAttrs keeps only what is safe for the shared log. The structured code (a fixed name such
// as "usageLimitExceeded", or an object naming an HTTP status) is always logged. The provider's
// free-text message is logged only when the code is a plain name or absent: for an upstream HTTP
// failure the message and additionalDetails can carry the upstream response body, which is not
// guaranteed to be free of conversation text, so those stay in the trace.
func (e *turnError) logAttrs() []any {
	if e == nil {
		return nil
	}
	var attrs []any
	info := strings.TrimSpace(string(e.CodexErrorInfo))
	hasInfo := info != "" && info != "null"
	if hasInfo {
		attrs = append(attrs, "code", truncateUTF8(info, 200))
	}
	if !hasInfo || strings.HasPrefix(info, "\"") {
		attrs = append(attrs, "error", truncateUTF8(e.Message, 500))
	}
	return attrs
}

// recordNotificationLocked turns one provider notification for conversation key into events.
// Streaming deltas are never recorded (the completed item carries the same text).
func (a *account) recordNotificationLocked(key, method string, raw json.RawMessage, itemType, phase, text string, providerError *turnError, willRetry bool) {
	switch {
	case method == "item/agentMessage/delta", method == "item/reasoning/textDelta", method == "item/reasoning/summaryTextDelta":
		return
	case method == "error":
		meta := append([]any{"will_retry", willRetry}, providerError.logAttrs()...)
		a.record(key, slog.LevelWarn, "provider.error", meta, map[string]any{"params": traceRaw(raw)})
	case method == "model/rerouted":
		a.record(key, slog.LevelWarn, "provider.model_rerouted", nil, map[string]any{"params": traceRaw(raw)})
	case method == "thread/compacted":
		a.record(key, slog.LevelInfo, "provider.thread_compacted", nil, nil)
	case method == "item/completed" && itemType == "agentMessage":
		if phase == "" {
			phase = "final"
		}
		a.record(key, slog.LevelDebug, "message", []any{"phase", phase, "chars", len(text)}, map[string]any{"text": text})
	case a.trace:
		// Everything else (item/started, other item types, turn/started, token usage, plan
		// updates) is kept only in the trace, raw, for reconstructing what the provider did.
		a.record(key, slog.LevelDebug, "provider.notification", []any{"method", method, "item_type", itemType}, map[string]any{"params": traceRaw(raw)})
	}
}

// logSafeError reduces an error to text fit for the shared log. A filesystem error's path names
// the tenant, principal, workspace, pet and history ids (the account and conversation files live
// under them), so only its operation and cause are kept.
func logSafeError(err error) string {
	if err == nil {
		return ""
	}
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) {
		return pathErr.Op + ": " + pathErr.Err.Error()
	}
	var linkErr *os.LinkError
	if errors.As(err, &linkErr) {
		return linkErr.Op + ": " + linkErr.Err.Error()
	}
	return truncateUTF8(err.Error(), 300)
}

// argumentRefusalCode names which of flattenToolCall's fixed refusal templates reason came from,
// so the shared log never quotes a key the model made up.
func argumentRefusalCode(reason string) string {
	switch {
	case strings.Contains(reason, " is not a parameter of "):
		return "unknown_parameter"
	case strings.HasSuffix(reason, " must be a string."):
		return "not_string"
	case strings.HasSuffix(reason, " must be a JSON object."):
		return "not_object"
	case strings.HasSuffix(reason, " requires a JSON object of arguments."):
		return "arguments_not_object"
	case strings.HasSuffix(reason, " is not a supported tool."):
		return "unsupported_tool"
	case strings.HasSuffix(reason, " could not be processed."):
		return "unprocessable"
	default:
		return "other"
	}
}

// removeTraceLocked deletes conversation key's trace file, if any.
func (a *account) removeTraceLocked(key string) {
	tag := conversationTag(key)
	_ = os.Remove(filepath.Join(a.home, "traces", tag+".jsonl"))
	delete(a.traceFull, tag)
}
