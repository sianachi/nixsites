package calendarsync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

// Kinds is the job kind the calendar role's runner registers for the calendar.sync queue.
var Kinds = []string{"calendar.sync"}

const (
	changesPageLimit = 100
	// maxTitleBytes and maxDetailsBytes mirror the C2 bounds in workerapi.validateCalendarEvent.
	maxTitleBytes   = 500
	maxDetailsBytes = 8000
)

// API is the subset of workerapi.Client the sync algorithm calls, so tests can fake Core with an
// httptest server behind the same *workerapi.Client rather than mocking an interface by hand.
type API interface {
	StartCalendarSession(ctx context.Context, linkID string) (*workerapi.CalendarSession, error)
	PullCalendarEvents(ctx context.Context, linkID string, request workerapi.CalendarPullRequest) (*workerapi.CalendarPullResult, error)
	GetCalendarChanges(ctx context.Context, linkID string, limit int) (*workerapi.CalendarChangesResult, error)
	ReportCalendarPushed(ctx context.Context, linkID string, results []workerapi.CalendarPushResult) error
	SetCalendarCursor(ctx context.Context, linkID, cursor string, full bool, windowStart, windowEnd time.Time) error
	LogCalendarEntries(ctx context.Context, linkID string, entries []workerapi.CalendarLogEntry) error
}

// Handler runs one calendar.sync job per call: session -> pull pages -> push changes -> cursor,
// per ADR-0052 steps 1-5.
type Handler struct {
	api       API
	providers map[string]Provider
	logger    *slog.Logger
}

func NewHandler(api API, google, microsoft Provider, logger *slog.Logger) *Handler {
	providers := map[string]Provider{}
	if google != nil {
		providers[google.Name()] = google
	}
	if microsoft != nil {
		providers[microsoft.Name()] = microsoft
	}
	return &Handler{api: api, providers: providers, logger: logger}
}

// Result is the durable job result recorded for a calendar.sync execution.
type Result struct {
	Provider  string `json:"provider"`
	Applied   int    `json:"applied"`
	Conflicts int    `json:"conflicts"`
	Pushed    int    `json:"pushed"`
	FullSync  bool   `json:"fullSync"`
}

func (handler *Handler) Handle(ctx context.Context, job workerapi.Job) (any, error) {
	var payload workerapi.CalendarSyncPayload
	decoder := json.NewDecoder(strings.NewReader(string(job.Payload)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil || !canonicalUUID(payload.LinkID) {
		return nil, jobrunner.Fail("calendar_payload_invalid", errors.New("the durable calendar sync request is invalid"))
	}
	session, err := handler.api.StartCalendarSession(ctx, payload.LinkID)
	if err != nil {
		return nil, apiFailure("calendar_session_unavailable", err)
	}
	provider, ok := handler.providers[session.Provider]
	if !ok {
		return nil, jobrunner.Fail("calendar_provider_unsupported", fmt.Errorf("no calendar provider client is configured for %q", session.Provider))
	}

	applied, conflicts, full, pullErr := handler.pull(ctx, provider, payload.LinkID, session)
	if pullErr != nil {
		return nil, pullErr
	}

	pushed := 0
	if session.Direction == "two_way" {
		var pushErr error
		pushed, pushErr = handler.push(ctx, provider, payload.LinkID, session)
		if pushErr != nil {
			return nil, pushErr
		}
	}

	return Result{Provider: session.Provider, Applied: applied, Conflicts: conflicts, Pushed: pushed, FullSync: full}, nil
}

// pull runs ADR-0052 step 2: fetch pages from the provider and apply them to Core in batches,
// restarting as a full resync when the provider rejects the stored cursor (Google 410, an
// invalid Graph delta token), then stores the new cursor only after every page has been applied.
func (handler *Handler) pull(ctx context.Context, provider Provider, linkID string, session *workerapi.CalendarSession) (applied, conflicts int, full bool, err error) {
	cursor := ""
	if session.Cursor != nil {
		cursor = *session.Cursor
	}
	full = cursor == ""
	pageToken := ""
	restarted := false
	for {
		page, pullErr := provider.Pull(ctx, session.AccessToken, session.ExternalCalendarID, cursor, session.WindowStart, session.WindowEnd, pageToken)
		if pullErr != nil {
			handler.logProviderError(ctx, linkID, "pull", pullErr)
			return applied, conflicts, full, jobrunner.Retry("calendar_pull_failed", pullErr)
		}
		if page.FullResyncRequired {
			if restarted {
				return applied, conflicts, full, jobrunner.Fail("calendar_pull_failed", errors.New("the calendar provider repeatedly rejected a full resync"))
			}
			restarted = true
			cursor, pageToken, full = "", "", true
			applied, conflicts = 0, 0
			continue
		}
		wireEvents := make([]workerapi.CalendarEvent, 0, len(page.Events))
		for _, event := range page.Events {
			wireEvents = append(wireEvents, toWireEvent(event))
		}
		if len(wireEvents) > 0 || full {
			result, applyErr := handler.api.PullCalendarEvents(ctx, linkID, workerapi.CalendarPullRequest{Full: full, Events: wireEvents})
			if applyErr != nil {
				return applied, conflicts, full, apiFailure("calendar_pull_apply_failed", applyErr)
			}
			applied += result.Applied
			conflicts += result.Conflicts
		}
		if !page.Next {
			if setErr := handler.api.SetCalendarCursor(ctx, linkID, page.Cursor, full, session.WindowStart, session.WindowEnd); setErr != nil {
				return applied, conflicts, full, apiFailure("calendar_cursor_failed", setErr)
			}
			return applied, conflicts, full, nil
		}
		pageToken = page.PageToken
	}
}

// push runs ADR-0052 step 3: fetch Core's outstanding item changes and create, patch or delete
// the matching upstream event for each, reporting the outcome back to Core (contract C4).
// import_only links never reach this method (the caller only calls it when direction is
// two_way); $cal_readonly items are excluded from Core's C3 response, not filtered here.
func (handler *Handler) push(ctx context.Context, provider Provider, linkID string, session *workerapi.CalendarSession) (int, error) {
	changes, err := handler.api.GetCalendarChanges(ctx, linkID, changesPageLimit)
	if err != nil {
		return 0, apiFailure("calendar_changes_unavailable", err)
	}
	if len(changes.Changes) == 0 {
		return 0, nil
	}
	results := make([]workerapi.CalendarPushResult, 0, len(changes.Changes))
	for _, change := range changes.Changes {
		result := handler.pushOne(ctx, provider, session, change)
		results = append(results, result)
	}
	if err := handler.api.ReportCalendarPushed(ctx, linkID, results); err != nil {
		return 0, apiFailure("calendar_pushed_report_failed", err)
	}
	return len(results), nil
}

func (handler *Handler) pushOne(ctx context.Context, provider Provider, session *workerapi.CalendarSession, change workerapi.CalendarChange) workerapi.CalendarPushResult {
	externalID := ""
	if change.ExternalID != nil {
		externalID = *change.ExternalID
	}
	version := ""
	if change.Version != nil {
		version = *change.Version
	}
	if change.Op == "delete" {
		if externalID == "" {
			return workerapi.CalendarPushResult{ItemID: change.ItemID, Status: "ok"}
		}
		err := provider.DeleteEvent(ctx, session.AccessToken, session.ExternalCalendarID, externalID, version)
		return handler.pushResult(change.ItemID, externalID, version, err)
	}
	event, eventErr := fromWireChange(change)
	if eventErr != nil {
		return workerapi.CalendarPushResult{ItemID: change.ItemID, ExternalID: externalID, Version: version, Status: "failed", Detail: truncate(eventErr.Error(), 500)}
	}
	event.NixItemID = change.ItemID
	if externalID == "" {
		newID, newVersion, err := provider.CreateEvent(ctx, session.AccessToken, session.ExternalCalendarID, event)
		if err != nil {
			return handler.pushResult(change.ItemID, "", "", err)
		}
		return workerapi.CalendarPushResult{ItemID: change.ItemID, ExternalID: newID, Version: newVersion, Status: "ok"}
	}
	newVersion, err := provider.UpdateEvent(ctx, session.AccessToken, session.ExternalCalendarID, externalID, version, event)
	if err != nil {
		return handler.pushResult(change.ItemID, externalID, version, err)
	}
	return workerapi.CalendarPushResult{ItemID: change.ItemID, ExternalID: externalID, Version: newVersion, Status: "ok"}
}

func (handler *Handler) pushResult(itemID, externalID, version string, err error) workerapi.CalendarPushResult {
	if err == nil {
		return workerapi.CalendarPushResult{ItemID: itemID, ExternalID: externalID, Version: version, Status: "ok"}
	}
	status := "failed"
	switch {
	case errors.Is(err, ErrConflict):
		status = "conflict"
	case errors.Is(err, ErrGone):
		status = "gone"
	}
	return workerapi.CalendarPushResult{ItemID: itemID, ExternalID: externalID, Version: version, Status: status, Detail: truncate(err.Error(), 500)}
}

func (handler *Handler) logProviderError(ctx context.Context, linkID, direction string, err error) {
	logErr := handler.api.LogCalendarEntries(ctx, linkID, []workerapi.CalendarLogEntry{
		{Direction: direction, Action: "error", Detail: truncate(err.Error(), 500)},
	})
	if logErr != nil && handler.logger != nil {
		handler.logger.Warn("calendar sync log entry failed", "link_id", linkID, "error", logErr)
	}
}

// toWireEvent renders a provider event as a C2 event. A cancelled event carries no bounds (start
// is "" and end is omitted): providers do not report them for deletions. Provider text is cut to
// the contract bounds on a rune boundary so one oversized event cannot fail the whole page.
func toWireEvent(event ProviderEvent) workerapi.CalendarEvent {
	wire := workerapi.CalendarEvent{
		ExternalID: event.ExternalID,
		Version:    event.Version,
		Status:     event.Status,
		Title:      truncateText(event.Title, maxTitleBytes),
		Location:   truncateText(event.Location, maxTitleBytes),
		Details:    truncateText(event.Details, maxDetailsBytes),
		ReadOnly:   event.ReadOnly,
		UpdatedAt:  event.UpdatedAt,
	}
	if canonicalUUID(event.NixItemID) {
		stamp := event.NixItemID
		wire.NixItemID = &stamp
	}
	if event.Status == "cancelled" {
		return wire
	}
	wire.Start = event.Start.Wire()
	if event.End != nil {
		end := event.End.Wire()
		wire.End = &end
	}
	return wire
}

// truncateText cuts value to at most maximum bytes without splitting a UTF-8 sequence.
func truncateText(value string, maximum int) string {
	if len(value) <= maximum {
		return value
	}
	cut := maximum
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut]
}

func fromWireChange(change workerapi.CalendarChange) (PushEvent, error) {
	start, err := ParseBound(change.Start)
	if err != nil {
		return PushEvent{}, err
	}
	var end *Bound
	if change.End != nil {
		bound, err := ParseBound(*change.End)
		if err != nil {
			return PushEvent{}, err
		}
		end = &bound
	}
	return PushEvent{Title: change.Title, Location: change.Location, Details: change.Details, Start: start, End: end}, nil
}

func truncate(value string, maximum int) string {
	return truncateText(value, maximum)
}

func canonicalUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for position, character := range value {
		if position == 8 || position == 13 || position == 18 || position == 23 {
			continue
		}
		if character < '0' || character > '9' && character < 'a' || character > 'f' {
			return false
		}
	}
	return value != "00000000-0000-0000-0000-000000000000"
}

// apiFailure classifies a Core worker-executions error. A refused execution (the lease moved on)
// is returned unwrapped, as in every other worker role. Core's calendar refusals
// (calendar.link_unavailable: the link was deleted, stopped or no longer matches the job;
// calendar.needs_reauth: Core already marked the connection and notified the owner) and any other
// 4xx rejection are terminal: retrying the same request cannot succeed. Everything else (5xx,
// 408, 429, transport errors) is retried.
func apiFailure(code string, err error) error {
	var response *workerapi.ResponseError
	if !errors.As(err, &response) {
		return jobrunner.Retry(code, err)
	}
	switch {
	case response.Status == http.StatusConflict && response.Code == "worker.execution_refused":
		return err
	case response.Status == http.StatusConflict && response.Code == "calendar.link_unavailable":
		return jobrunner.Fail("calendar_link_unavailable", err)
	case response.Status == http.StatusConflict && response.Code == "calendar.needs_reauth":
		return jobrunner.Fail("calendar_needs_reauth", err)
	case response.Status == http.StatusRequestTimeout || response.Status == http.StatusTooManyRequests || response.Status >= 500:
		return jobrunner.Retry(code, err)
	case response.Status >= 400:
		return jobrunner.Fail(code, err)
	default:
		return jobrunner.Retry(code, err)
	}
}
