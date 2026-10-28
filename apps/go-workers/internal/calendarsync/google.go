package calendarsync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
)

// GoogleClient talks to the Google Calendar API (events.list/insert/patch/delete) behind the
// NIX_CALENDAR_GOOGLE_ORIGIN allowlist. Facts this client relies on (verified against the
// provider docs 2026-09-29): events.list with singleEvents=true, showDeleted=true and a
// syncToken returns every change since the previous round; syncToken cannot be combined with
// timeMin/timeMax; a 410 means the token is gone and the caller must restart as a full resync;
// paging uses pageToken/nextPageToken, and the final page carries nextSyncToken. All-day events
// use start.date/end.date (end exclusive); timed events use start.dateTime + start.timeZone.
type GoogleClient struct {
	transport *transport
	logger    *slog.Logger
}

func NewGoogleClient(origin string, timeout time.Duration, logger *slog.Logger) (*GoogleClient, error) {
	t, err := newTransport(origin, timeout)
	if err != nil {
		return nil, fmt.Errorf("google calendar client: %w", err)
	}
	return &GoogleClient{transport: t, logger: logger}, nil
}

func (client *GoogleClient) Name() string { return "google" }

type googleEventDateTime struct {
	Date     string `json:"date,omitempty"`
	DateTime string `json:"dateTime,omitempty"`
	TimeZone string `json:"timeZone,omitempty"`
}

type googleOrganizer struct {
	Self bool `json:"self"`
}

type googleEvent struct {
	ID              string              `json:"id"`
	ETag            string              `json:"etag"`
	Status          string              `json:"status"`
	Summary         string              `json:"summary"`
	Description     string              `json:"description"`
	Location        string              `json:"location"`
	Start           googleEventDateTime `json:"start"`
	End             googleEventDateTime `json:"end"`
	Updated         time.Time           `json:"updated"`
	Organizer       *googleOrganizer    `json:"organizer"`
	GuestsCanModify bool                `json:"guestsCanModify"`
}

type googleEventsResponse struct {
	NextPageToken string        `json:"nextPageToken"`
	NextSyncToken string        `json:"nextSyncToken"`
	Items         []googleEvent `json:"items"`
}

type googleErrorResponse struct {
	Error struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (client *GoogleClient) Pull(ctx context.Context, accessToken, calendarID, cursor string, windowStart, windowEnd time.Time, pageToken string) (Page, error) {
	query := url.Values{}
	query.Set("singleEvents", "true")
	query.Set("showDeleted", "true")
	query.Set("maxResults", "100")
	if cursor != "" {
		query.Set("syncToken", cursor)
	} else {
		query.Set("timeMin", windowStart.UTC().Format(time.RFC3339))
		query.Set("timeMax", windowEnd.UTC().Format(time.RFC3339))
	}
	if pageToken != "" {
		query.Set("pageToken", pageToken)
	}
	path := "/calendar/v3/calendars/" + url.PathEscape(calendarID) + "/events?" + query.Encode()
	response, err := client.transport.do(ctx, http.MethodGet, path, bearerHeaders(accessToken), nil)
	if err != nil {
		return Page{}, err
	}
	if response.StatusCode == http.StatusGone {
		_, _ = readBoundedBody(response.Body)
		return Page{FullResyncRequired: true}, nil
	}
	body, err := readBoundedBody(response.Body)
	if err != nil {
		return Page{}, err
	}
	if response.StatusCode != http.StatusOK {
		return Page{}, googleAPIError(response.StatusCode, body)
	}
	var decoded googleEventsResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		return Page{}, fmt.Errorf("decode google calendar events page: %w", err)
	}
	events := make([]ProviderEvent, 0, len(decoded.Items))
	for _, item := range decoded.Items {
		converted, err := client.convert(item)
		if err != nil {
			return Page{}, err
		}
		events = append(events, converted)
	}
	return Page{
		Events:    events,
		Next:      decoded.NextPageToken != "",
		PageToken: decoded.NextPageToken,
		Cursor:    decoded.NextSyncToken,
	}, nil
}

func (client *GoogleClient) convert(item googleEvent) (ProviderEvent, error) {
	if item.Status == "cancelled" {
		// An incremental round reports a deleted event with only its id and status: no start or
		// end to parse. Core needs only the id to remove it.
		updated := item.Updated
		if updated.IsZero() {
			updated = time.Now().UTC()
		}
		return ProviderEvent{ExternalID: item.ID, Version: item.ETag, Status: "cancelled", UpdatedAt: updated}, nil
	}
	status := "confirmed"
	start, err := googleBound(item.Start, false)
	if err != nil {
		return ProviderEvent{}, err
	}
	var end *Bound
	if item.End.Date != "" || item.End.DateTime != "" {
		bound, err := googleBound(item.End, true)
		if err != nil {
			return ProviderEvent{}, err
		}
		end = &bound
	}
	readOnly := item.Organizer != nil && !item.Organizer.Self && !item.GuestsCanModify
	return ProviderEvent{
		ExternalID: item.ID,
		Version:    item.ETag,
		Status:     status,
		Title:      item.Summary,
		Location:   item.Location,
		Details:    item.Description,
		Start:      start,
		End:        end,
		ReadOnly:   readOnly,
		UpdatedAt:  item.Updated,
		NixItemID:  googleItemStamp(item.ID),
	}, nil
}

func googleBound(value googleEventDateTime, isEnd bool) (Bound, error) {
	if value.Date != "" {
		date := value.Date
		if isEnd {
			inclusive, err := InclusiveEndDate(date)
			if err != nil {
				return Bound{}, err
			}
			date = inclusive
		}
		return Bound{AllDay: true, Date: date}, nil
	}
	instant, err := time.Parse(time.RFC3339, value.DateTime)
	if err != nil {
		return Bound{}, fmt.Errorf("google event dateTime %q is invalid: %w", value.DateTime, err)
	}
	zone := value.TimeZone
	if zone == "" {
		zone = "UTC"
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		loc = time.UTC
		zone = "UTC"
	}
	return Bound{Instant: instant.In(loc), Zone: zone}, nil
}

// CreateEvent inserts the event under a client-supplied id derived from the Nix item id (Google
// allows base32hex ids of 5 to 1024 characters; a UUID's 32 lowercase hex digits are such an id).
// A 409 means an event with that id already exists - this item's own create landed before and its
// report was lost, or the event was deleted upstream and Google keeps the id - so the event is
// patched back to the pushed fields with status confirmed (which also restores a deleted one) and
// returned as the created event.
func (client *GoogleClient) CreateEvent(ctx context.Context, accessToken, calendarID string, event PushEvent) (string, string, error) {
	payload := googleEventBody(event)
	id := googleEventID(event.NixItemID)
	if id != "" {
		payload["id"] = id
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", "", err
	}
	path := "/calendar/v3/calendars/" + url.PathEscape(calendarID) + "/events"
	response, err := client.transport.do(ctx, http.MethodPost, path, bearerJSONHeaders(accessToken), bytes.NewReader(body))
	if err != nil {
		return "", "", err
	}
	responseBody, err := readBoundedBody(response.Body)
	if err != nil {
		return "", "", err
	}
	if response.StatusCode == http.StatusConflict && id != "" {
		return client.reviveEvent(ctx, accessToken, calendarID, id, event)
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusCreated {
		return "", "", googleAPIError(response.StatusCode, responseBody)
	}
	var created googleEvent
	if err := json.Unmarshal(responseBody, &created); err != nil {
		return "", "", fmt.Errorf("decode google calendar create response: %w", err)
	}
	return created.ID, created.ETag, nil
}

// reviveEvent patches the event this item already created back to the pushed fields, confirmed.
func (client *GoogleClient) reviveEvent(ctx context.Context, accessToken, calendarID, id string, event PushEvent) (string, string, error) {
	payload := googleEventBody(event)
	payload["status"] = "confirmed"
	body, err := json.Marshal(payload)
	if err != nil {
		return "", "", err
	}
	path := "/calendar/v3/calendars/" + url.PathEscape(calendarID) + "/events/" + url.PathEscape(id)
	response, err := client.transport.do(ctx, http.MethodPatch, path, bearerJSONHeaders(accessToken), bytes.NewReader(body))
	if err != nil {
		return "", "", err
	}
	responseBody, err := readBoundedBody(response.Body)
	if err != nil {
		return "", "", err
	}
	if response.StatusCode != http.StatusOK {
		return "", "", googleAPIError(response.StatusCode, responseBody)
	}
	var revived googleEvent
	if err := json.Unmarshal(responseBody, &revived); err != nil {
		return "", "", fmt.Errorf("decode google calendar revive response: %w", err)
	}
	return id, revived.ETag, nil
}

// googleEventID is the client-supplied event id for a Nix item: its UUID without dashes, or ""
// when there is no item id to stamp.
func googleEventID(itemID string) string {
	if !broker.IsCanonicalUUID(itemID) {
		return ""
	}
	return strings.ReplaceAll(itemID, "-", "")
}

// googleItemStamp reads the Nix item id back out of an event id googleEventID made; any other id
// (Google's own, or a recurring instance's "{id}_{time}") yields "".
func googleItemStamp(eventID string) string {
	if len(eventID) != 32 {
		return ""
	}
	itemID := eventID[0:8] + "-" + eventID[8:12] + "-" + eventID[12:16] + "-" + eventID[16:20] + "-" + eventID[20:32]
	if !broker.IsCanonicalUUID(itemID) {
		return ""
	}
	return itemID
}

func (client *GoogleClient) UpdateEvent(ctx context.Context, accessToken, calendarID, externalID, version string, event PushEvent) (string, error) {
	body, err := json.Marshal(googleEventBody(event))
	if err != nil {
		return "", err
	}
	headers := bearerJSONHeaders(accessToken)
	if version != "" {
		headers["If-Match"] = version
	}
	path := "/calendar/v3/calendars/" + url.PathEscape(calendarID) + "/events/" + url.PathEscape(externalID)
	response, err := client.transport.do(ctx, http.MethodPatch, path, headers, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	responseBody, err := readBoundedBody(response.Body)
	if err != nil {
		return "", err
	}
	switch response.StatusCode {
	case http.StatusOK:
		var updated googleEvent
		if err := json.Unmarshal(responseBody, &updated); err != nil {
			return "", fmt.Errorf("decode google calendar update response: %w", err)
		}
		return updated.ETag, nil
	case http.StatusPreconditionFailed:
		return "", ErrConflict
	case http.StatusNotFound, http.StatusGone:
		return "", ErrGone
	default:
		return "", googleAPIError(response.StatusCode, responseBody)
	}
}

func (client *GoogleClient) DeleteEvent(ctx context.Context, accessToken, calendarID, externalID, version string) error {
	headers := bearerHeaders(accessToken)
	if version != "" {
		headers["If-Match"] = version
	}
	path := "/calendar/v3/calendars/" + url.PathEscape(calendarID) + "/events/" + url.PathEscape(externalID)
	response, err := client.transport.do(ctx, http.MethodDelete, path, headers, nil)
	if err != nil {
		return err
	}
	responseBody, err := readBoundedBody(response.Body)
	if err != nil {
		return err
	}
	switch response.StatusCode {
	case http.StatusOK, http.StatusNoContent, http.StatusNotFound, http.StatusGone:
		return nil
	case http.StatusPreconditionFailed:
		return ErrConflict
	default:
		return googleAPIError(response.StatusCode, responseBody)
	}
}

func googleEventBody(event PushEvent) map[string]any {
	body := map[string]any{
		"summary":     event.Title,
		"location":    event.Location,
		"description": event.Details,
		"start":       googleEventDateTimeBody(event.Start, false),
	}
	if event.End != nil {
		body["end"] = googleEventDateTimeBody(*event.End, true)
	}
	return body
}

// googleEventDateTimeBody names the unused fields as null: PATCH merges nested objects, so an
// event moving between all-day and timed would otherwise keep the old field and Google refuses
// a start with both a date and a dateTime.
func googleEventDateTimeBody(bound Bound, isEnd bool) map[string]any {
	if bound.AllDay {
		date := bound.Date
		if isEnd {
			if exclusive, err := ExclusiveEndDate(date); err == nil {
				date = exclusive
			}
		}
		return map[string]any{"date": date, "dateTime": nil, "timeZone": nil}
	}
	return map[string]any{"date": nil, "dateTime": bound.Instant.In(mustLocation(bound.Zone)).Format(time.RFC3339), "timeZone": bound.Zone}
}

func bearerHeaders(accessToken string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + accessToken, "Accept": "application/json"}
}

func bearerJSONHeaders(accessToken string) map[string]string {
	headers := bearerHeaders(accessToken)
	headers["Content-Type"] = "application/json"
	return headers
}

func googleAPIError(status int, body []byte) error {
	var decoded googleErrorResponse
	if err := json.Unmarshal(body, &decoded); err == nil && decoded.Error.Message != "" {
		return fmt.Errorf("google calendar API returned %d: %s", status, decoded.Error.Message)
	}
	return errors.New("google calendar API returned " + strconv.Itoa(status))
}
