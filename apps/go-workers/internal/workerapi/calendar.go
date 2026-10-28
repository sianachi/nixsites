package workerapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
)

// Calendar* types and methods implement contracts C1-C6 from
// docs/plans/life-os-scheduling-and-sync-plan.md: the `calendar` role's worker-execution surface
// for job kind calendar.sync, payload {"linkId":uuid,"full":bool}. Every route lives under
// /internal/worker-executions/calendar/ and is bound to the leased job execution the same way as
// every other worker-executions call (see Client.newRequest).

const (
	maxCalendarEventsPerBatch = 100
	maxCalendarChangesLimit   = 100
	maxCalendarLogEntries     = 100
	maxCalendarTextLength     = 500
	maxCalendarDetailsLength  = 8000
	maxCalendarCursorLength   = 4096
)

// MaxCalendarPullBodyBytes is Core's request body limit for C2. A batch whose encoding exceeds it
// is split, since 100 events with long, escape-heavy details can pass every per-field bound and
// still exceed it.
const MaxCalendarPullBodyBytes = 2 << 20

// maxCalendarChangesResponseBytes bounds a C3 page. 100 changes with 8000-character details
// escaped as \uXXXX by Core's JSON encoder reach about 5 MiB.
const maxCalendarChangesResponseBytes = 8 << 20

// CalendarSyncPayload is the calendar.sync job payload.
type CalendarSyncPayload struct {
	LinkID string `json:"linkId"`
	Full   bool   `json:"full"`
}

// CalendarSession is the C1 response: the link's provider, calendar, sync state, pull window and
// a short-lived provider access token Core obtained by refreshing.
type CalendarSession struct {
	Provider             string    `json:"provider"`
	ExternalCalendarID   string    `json:"externalCalendarId"`
	Direction            string    `json:"direction"`
	Cursor               *string   `json:"cursor"`
	WindowStart          time.Time `json:"windowStart"`
	WindowEnd            time.Time `json:"windowEnd"`
	AccessToken          string    `json:"accessToken"`
	AccessTokenExpiresAt time.Time `json:"accessTokenExpiresAt"`
}

// CalendarEvent is one pulled event in the C2 pull request, a DateOrTimestamp per field being
// either a bare yyyy-MM-dd date or an RFC 9557 timestamp with an IANA zone. NixItemID is present
// only for an event Nix created: the item id it was stamped with, so Core can recognise a create
// whose C4 report was lost.
type CalendarEvent struct {
	ExternalID string    `json:"externalId"`
	Version    string    `json:"version"`
	Status     string    `json:"status"`
	Title      string    `json:"title"`
	Start      string    `json:"start"`
	End        *string   `json:"end,omitempty"`
	Location   string    `json:"location"`
	Details    string    `json:"details"`
	ReadOnly   bool      `json:"readOnly"`
	UpdatedAt  time.Time `json:"updatedAt"`
	NixItemID  *string   `json:"nixItemId,omitempty"`
}

// CalendarPullRequest is the C2 request body.
type CalendarPullRequest struct {
	Full   bool            `json:"full"`
	Events []CalendarEvent `json:"events"`
}

// CalendarPullResult is the C2 response body.
type CalendarPullResult struct {
	Applied   int `json:"applied"`
	Conflicts int `json:"conflicts"`
}

// CalendarChange is one entry of the C3 response: a Nix-side item change the worker must push
// upstream (create when ExternalID is nil, update when it is set, delete when Op is "delete").
type CalendarChange struct {
	ItemID     string    `json:"itemId"`
	ExternalID *string   `json:"externalId"`
	Version    *string   `json:"version"`
	Op         string    `json:"op"`
	Title      string    `json:"title"`
	Start      string    `json:"start"`
	End        *string   `json:"end"`
	Location   string    `json:"location"`
	Details    string    `json:"details"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// CalendarChangesResult is the C3 response body.
type CalendarChangesResult struct {
	Changes []CalendarChange `json:"changes"`
}

// CalendarPushResult is one entry of the C4 request: the outcome of pushing one Nix change
// upstream.
type CalendarPushResult struct {
	ItemID     string `json:"itemId"`
	ExternalID string `json:"externalId"`
	Version    string `json:"version"`
	Status     string `json:"status"`
	Detail     string `json:"detail,omitempty"`
}

// CalendarLogEntry is one entry of the C6 request: a worker-side sync event (typically a
// provider error) recorded for the visible sync log.
type CalendarLogEntry struct {
	Direction  string  `json:"direction"`
	Action     string  `json:"action"`
	ItemID     *string `json:"itemId,omitempty"`
	ExternalID *string `json:"externalId,omitempty"`
	Detail     string  `json:"detail"`
}

// StartCalendarSession implements C1. A 409 with code "calendar.needs_reauth" surfaces through
// the returned *ResponseError (see ResponseErrorFrom): Core already marked the connection and
// notified the owner, so the caller only needs to stop this round.
func (client *Client) StartCalendarSession(ctx context.Context, linkID string) (*CalendarSession, error) {
	if !broker.IsCanonicalUUID(linkID) {
		return nil, errors.New("calendar session request is invalid")
	}
	path := "/internal/worker-executions/calendar/links/" + linkID + "/session"
	var session CalendarSession
	if err := client.requestStrictJSON(ctx, http.MethodPost, path, nil, &session, 16<<10); err != nil {
		return nil, err
	}
	if session.Provider != "google" && session.Provider != "microsoft" ||
		session.ExternalCalendarID == "" ||
		session.Direction != "two_way" && session.Direction != "import_only" ||
		session.WindowStart.IsZero() || session.WindowEnd.IsZero() || !session.WindowEnd.After(session.WindowStart) ||
		session.AccessToken == "" || !session.AccessTokenExpiresAt.After(time.Now()) {
		return nil, errors.New("worker API calendar session is invalid")
	}
	return &session, nil
}

// PullCalendarEvents implements C2. A batch whose encoded body would exceed
// MaxCalendarPullBodyBytes is split in halves and the per-request results are summed; every
// request carries the same Full flag, which Core applies per event.
func (client *Client) PullCalendarEvents(ctx context.Context, linkID string, request CalendarPullRequest) (*CalendarPullResult, error) {
	if !broker.IsCanonicalUUID(linkID) || len(request.Events) > maxCalendarEventsPerBatch {
		return nil, errors.New("calendar pull request is invalid")
	}
	for _, event := range request.Events {
		if err := validateCalendarEvent(event); err != nil {
			return nil, err
		}
	}
	if request.Events == nil {
		request.Events = []CalendarEvent{}
	}
	return client.pullCalendarBatch(ctx, linkID, request)
}

func (client *Client) pullCalendarBatch(ctx context.Context, linkID string, request CalendarPullRequest) (*CalendarPullResult, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	if len(body) > MaxCalendarPullBodyBytes {
		if len(request.Events) < 2 {
			return nil, errors.New("calendar pull event exceeds the request body limit")
		}
		middle := len(request.Events) / 2
		first, err := client.pullCalendarBatch(ctx, linkID, CalendarPullRequest{Full: request.Full, Events: request.Events[:middle]})
		if err != nil {
			return nil, err
		}
		second, err := client.pullCalendarBatch(ctx, linkID, CalendarPullRequest{Full: request.Full, Events: request.Events[middle:]})
		if err != nil {
			return nil, err
		}
		return &CalendarPullResult{Applied: first.Applied + second.Applied, Conflicts: first.Conflicts + second.Conflicts}, nil
	}
	path := "/internal/worker-executions/calendar/links/" + linkID + "/pull"
	var result CalendarPullResult
	if err := client.requestStrictJSON(ctx, http.MethodPost, path, bytes.NewReader(body), &result, 16<<10); err != nil {
		return nil, err
	}
	if result.Applied < 0 || result.Conflicts < 0 {
		return nil, errors.New("worker API calendar pull response is invalid")
	}
	return &result, nil
}

// GetCalendarChanges implements C3.
func (client *Client) GetCalendarChanges(ctx context.Context, linkID string, limit int) (*CalendarChangesResult, error) {
	if !broker.IsCanonicalUUID(linkID) || limit < 1 || limit > maxCalendarChangesLimit {
		return nil, errors.New("calendar changes request is invalid")
	}
	path := fmt.Sprintf("/internal/worker-executions/calendar/links/%s/changes?limit=%d", linkID, limit)
	var result CalendarChangesResult
	if err := client.requestStrictJSON(ctx, http.MethodGet, path, nil, &result, maxCalendarChangesResponseBytes); err != nil {
		return nil, err
	}
	if len(result.Changes) > limit {
		return nil, errors.New("worker API calendar changes response is invalid")
	}
	for _, change := range result.Changes {
		switch change.Op {
		case "create", "update", "delete":
		default:
			return nil, errors.New("worker API calendar change op is invalid")
		}
		if !broker.IsCanonicalUUID(change.ItemID) {
			return nil, errors.New("worker API calendar change item id is invalid")
		}
	}
	return &result, nil
}

// ReportCalendarPushed implements C4.
func (client *Client) ReportCalendarPushed(ctx context.Context, linkID string, results []CalendarPushResult) error {
	if !broker.IsCanonicalUUID(linkID) || len(results) == 0 || len(results) > maxCalendarEventsPerBatch {
		return errors.New("calendar pushed report is invalid")
	}
	for _, result := range results {
		if !broker.IsCanonicalUUID(result.ItemID) || len(result.ExternalID) > maxCalendarTextLength || len(result.Version) > maxCalendarCursorLength {
			return errors.New("calendar pushed result is invalid")
		}
		switch result.Status {
		case "ok", "conflict", "gone", "failed":
		default:
			return errors.New("calendar pushed result status is invalid")
		}
		if len(result.Detail) > maxCalendarTextLength {
			return errors.New("calendar pushed result detail is invalid")
		}
	}
	body, err := json.Marshal(struct {
		Results []CalendarPushResult `json:"results"`
	}{results})
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/calendar/links/" + linkID + "/pushed"
	return client.requestJSON(ctx, http.MethodPost, path, bytes.NewReader(body), nil)
}

// SetCalendarCursor implements C5. Core stores the cursor only after every page in the round has
// been applied, so the caller must not call this until the pull loop is complete.
func (client *Client) SetCalendarCursor(ctx context.Context, linkID, cursor string, full bool, windowStart, windowEnd time.Time) error {
	if !broker.IsCanonicalUUID(linkID) || len(cursor) > maxCalendarCursorLength || windowStart.IsZero() || windowEnd.IsZero() || !windowEnd.After(windowStart) {
		return errors.New("calendar cursor request is invalid")
	}
	body, err := json.Marshal(struct {
		Cursor      string    `json:"cursor"`
		Full        bool      `json:"full"`
		WindowStart time.Time `json:"windowStart"`
		WindowEnd   time.Time `json:"windowEnd"`
	}{cursor, full, windowStart, windowEnd})
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/calendar/links/" + linkID + "/cursor"
	return client.requestJSON(ctx, http.MethodPost, path, bytes.NewReader(body), nil)
}

// LogCalendarEntries implements C6.
func (client *Client) LogCalendarEntries(ctx context.Context, linkID string, entries []CalendarLogEntry) error {
	if !broker.IsCanonicalUUID(linkID) || len(entries) == 0 || len(entries) > maxCalendarLogEntries {
		return errors.New("calendar log request is invalid")
	}
	for _, entry := range entries {
		switch entry.Direction {
		case "pull", "push":
		default:
			return errors.New("calendar log entry direction is invalid")
		}
		switch entry.Action {
		case "error", "skipped", "conflict":
		default:
			return errors.New("calendar log entry action is invalid")
		}
		if len(entry.Detail) > maxCalendarTextLength {
			return errors.New("calendar log entry is invalid")
		}
		if entry.ItemID != nil && !broker.IsCanonicalUUID(*entry.ItemID) {
			return errors.New("calendar log entry item id is invalid")
		}
	}
	body, err := json.Marshal(struct {
		Entries []CalendarLogEntry `json:"entries"`
	}{entries})
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/calendar/links/" + linkID + "/log"
	return client.requestJSON(ctx, http.MethodPost, path, bytes.NewReader(body), nil)
}

func validateCalendarEvent(event CalendarEvent) error {
	if strings.TrimSpace(event.ExternalID) == "" || len(event.ExternalID) > maxCalendarTextLength {
		return errors.New("calendar event external id is invalid")
	}
	if len(event.Version) > maxCalendarCursorLength {
		return errors.New("calendar event version is invalid")
	}
	if event.Status != "confirmed" && event.Status != "cancelled" {
		return errors.New("calendar event status is invalid")
	}
	if len(event.Title) > maxCalendarTextLength || len(event.Location) > maxCalendarTextLength || len(event.Details) > maxCalendarDetailsLength {
		return errors.New("calendar event text field is too long")
	}
	// A cancelled event only identifies what to remove: Google omits start/end on incremental
	// deletions and Graph sends only the id with @removed, so start is required only when the
	// event is confirmed.
	if event.Status == "confirmed" && strings.TrimSpace(event.Start) == "" {
		return errors.New("calendar event start is required")
	}
	if event.UpdatedAt.IsZero() {
		return errors.New("calendar event updatedAt is required")
	}
	if event.NixItemID != nil && !broker.IsCanonicalUUID(*event.NixItemID) {
		return errors.New("calendar event nixItemId is invalid")
	}
	return nil
}
