package companion

import (
	"crypto/sha256"
	"fmt"
	"log/slog"
	"time"
)

// turnTiming is one turn's in-memory timing bookkeeping for the turn/completed log line, and
// for the 15-minute "thinking" expiry check (expireStaleThinking, watch.go): never persisted,
// never sent to the client, reset by start() at the beginning of every send(). tools.go and
// manager.go mutate a turn's timing only through these methods, never by touching the fields
// directly.
type turnTiming struct {
	started     time.Time      // when the current turn began; zero if no turn has ever run
	model       string         // the model actually used, or "" for the provider default
	effort      string         // the effort actually sent on turn/start, or "" if none
	firstToolAt time.Time      // zero until the turn's first tool call is recorded
	toolCount   int            // tool calls recorded so far this turn
	pendingMS   int64          // summed pending-to-claim duration across this turn's tool calls
	usage       *providerUsage // token counts, when the provider reports them (the HTTP wires do)
}

// start resets t for a new turn using the model and effort sent (or about to be sent) on
// turn/start. send() may still fill in effort again afterward once effortFor resolves it.
func (t *turnTiming) start(model, effort string) {
	*t = turnTiming{started: time.Now(), model: model, effort: effort}
}

// toolRecorded records one tool call being offered for approval: only the first one in a turn
// sets firstToolAt.
func (t *turnTiming) toolRecorded() {
	if t.firstToolAt.IsZero() {
		t.firstToolAt = time.Now()
	}
	t.toolCount++
}

// toolClaimed adds the pending-to-claim duration for a tool call that has been pending since
// since; a zero since (never recorded as pending) contributes nothing.
func (t *turnTiming) toolClaimed(since time.Time) {
	if !since.IsZero() {
		t.pendingMS += time.Since(since).Milliseconds()
	}
}

// log writes one timing line for a finished turn identified by key: no message text, no id
// beyond a short hash of key, matching what the previous account.logTurnLocked always logged.
func (t *turnTiming) log(logger *slog.Logger, key, status string) {
	if logger == nil || t.started.IsZero() {
		return
	}
	digest := sha256.Sum256([]byte(key))
	model := t.model
	if model == "" {
		model = "default"
	}
	firstTool := int64(-1)
	if !t.firstToolAt.IsZero() {
		firstTool = t.firstToolAt.Sub(t.started).Milliseconds()
	}
	attrs := []any{
		"conversation", fmt.Sprintf("%x", digest[:4]),
		"model", model,
		"effort", t.effort,
		"status", status,
		"total_ms", time.Since(t.started).Milliseconds(),
		"first_tool_ms", firstTool,
		"tool_calls", t.toolCount,
		"pending_ms", t.pendingMS,
	}
	if t.usage != nil {
		attrs = append(attrs, "input_tokens", t.usage.InputTokens, "cache_read_tokens", t.usage.CacheReadInputTokens, "cache_write_tokens", t.usage.CacheCreationInputTokens, "output_tokens", t.usage.OutputTokens)
	}
	logger.Info("companion turn completed", attrs...)
}
