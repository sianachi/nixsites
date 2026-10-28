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
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
)

// MicrosoftClient talks to Microsoft Graph calendars (calendarView/delta and events
// create/patch/delete) behind the NIX_CALENDAR_MICROSOFT_ORIGIN allowlist. Facts this client
// relies on (verified against the provider docs 2026-09-29): GET
// /me/calendars/{id}/calendarView/delta?startDateTime&endDateTime for the first round, then
// following @odata.nextLink pages and storing @odata.deltaLink; deletions and events leaving the
// window arrive in `value` with an "@removed" annotation (reason "deleted" or "changed");
// Prefer: odata.maxpagesize=50, outlook.timezone="UTC" and outlook.body-content-type="text"
// (so details arrive as plain text, not HTML); all-day events have isAllDay=true with midnight start/end, and
// the Graph end for an all-day event is exclusive, like Google's.
// graphItemPropertyID names the single-value extended property a created event carries the Nix
// item id in, beside transactionId. Graph's calendarView delta returns transactionId but cannot
// expand extended properties ($expand is unsupported there), so pull reads transactionId and
// falls back to the property only when a response happens to include it.
const graphItemPropertyID = "String {6f1c2d8e-4b7a-4e39-9c55-2a7d3e1b9f40} Name NixItemId"

type MicrosoftClient struct {
	transport *transport
	logger    *slog.Logger
}

func NewMicrosoftClient(origin string, timeout time.Duration, logger *slog.Logger) (*MicrosoftClient, error) {
	t, err := newTransport(origin, timeout)
	if err != nil {
		return nil, fmt.Errorf("microsoft calendar client: %w", err)
	}
	return &MicrosoftClient{transport: t, logger: logger}, nil
}

func (client *MicrosoftClient) Name() string { return "microsoft" }

type graphDateTime struct {
	DateTime string `json:"dateTime"`
	TimeZone string `json:"timeZone"`
}

type graphEvent struct {
	ID                    string          `json:"id"`
	ChangeKey             string          `json:"changeKey"`
	Subject               string          `json:"subject"`
	Body                  *graphBody      `json:"body"`
	Location              *graphLocation  `json:"location"`
	Start                 graphDateTime   `json:"start"`
	End                   graphDateTime   `json:"end"`
	IsAllDay              bool            `json:"isAllDay"`
	LastModifiedDateTime  time.Time       `json:"lastModifiedDateTime"`
	OriginalStartTimeZone string          `json:"originalStartTimeZone"`
	OriginalEndTimeZone   string          `json:"originalEndTimeZone"`
	IsOrganizer           *bool           `json:"isOrganizer"`
	TransactionID         string          `json:"transactionId"`
	ExtendedProperties    []graphProperty `json:"singleValueExtendedProperties"`
	Removed               *graphRemoved   `json:"@removed"`
}

type graphProperty struct {
	ID    string `json:"id"`
	Value string `json:"value"`
}

type graphBody struct {
	Content string `json:"content"`
}

type graphLocation struct {
	DisplayName string `json:"displayName"`
}

type graphRemoved struct {
	Reason string `json:"reason"`
}

type graphDeltaResponse struct {
	NextLink  string       `json:"@odata.nextLink"`
	DeltaLink string       `json:"@odata.deltaLink"`
	Value     []graphEvent `json:"value"`
}

type graphErrorResponse struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (client *MicrosoftClient) Pull(ctx context.Context, accessToken, calendarID, cursor string, windowStart, windowEnd time.Time, pageToken string) (Page, error) {
	target := pageToken
	if target == "" {
		if cursor != "" {
			target = cursor
		} else {
			query := url.Values{}
			query.Set("startDateTime", windowStart.UTC().Format(time.RFC3339))
			query.Set("endDateTime", windowEnd.UTC().Format(time.RFC3339))
			target = "/v1.0/me/calendars/" + url.PathEscape(calendarID) + "/calendarView/delta?" + query.Encode()
		}
	}
	headers := bearerHeaders(accessToken)
	headers["Prefer"] = `odata.maxpagesize=50, outlook.timezone="UTC", outlook.body-content-type="text"`
	response, err := client.transport.do(ctx, http.MethodGet, target, headers, nil)
	if err != nil {
		return Page{}, err
	}
	body, err := readBoundedBody(response.Body)
	if err != nil {
		return Page{}, err
	}
	if response.StatusCode == http.StatusGone || response.StatusCode == http.StatusBadRequest && cursor != "" && pageToken == "" {
		return Page{FullResyncRequired: true}, nil
	}
	if response.StatusCode != http.StatusOK {
		return Page{}, graphAPIError(response.StatusCode, body)
	}
	var decoded graphDeltaResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		return Page{}, fmt.Errorf("decode graph calendar delta page: %w", err)
	}
	events := make([]ProviderEvent, 0, len(decoded.Value))
	for _, item := range decoded.Value {
		// Reason "changed" means the event only left the delta window; it still exists upstream,
		// so reporting it cancelled would trash a live item.
		if item.Removed != nil && item.Removed.Reason == "changed" {
			continue
		}
		events = append(events, client.convert(item))
	}
	return Page{
		Events:    events,
		Next:      decoded.NextLink != "",
		PageToken: decoded.NextLink,
		Cursor:    decoded.DeltaLink,
	}, nil
}

func (client *MicrosoftClient) convert(item graphEvent) ProviderEvent {
	if item.Removed != nil {
		// A removed event carries only its id: no bounds and no lastModifiedDateTime.
		updated := item.LastModifiedDateTime
		if updated.IsZero() {
			updated = time.Now().UTC()
		}
		return ProviderEvent{ExternalID: item.ID, Status: "cancelled", UpdatedAt: updated}
	}
	startZone := WindowsToIANA(item.OriginalStartTimeZone, client.logger)
	endZone := WindowsToIANA(item.OriginalEndTimeZone, client.logger)
	if endZone == "UTC" && item.OriginalEndTimeZone == "" {
		endZone = startZone
	}
	start := graphBound(item.Start, startZone, item.IsAllDay, false)
	end := graphBound(item.End, endZone, item.IsAllDay, true)
	details := ""
	if item.Body != nil {
		details = item.Body.Content
	}
	location := ""
	if item.Location != nil {
		location = item.Location.DisplayName
	}
	readOnly := item.IsOrganizer != nil && !*item.IsOrganizer
	return ProviderEvent{
		ExternalID: item.ID,
		Version:    item.ChangeKey,
		Status:     "confirmed",
		Title:      item.Subject,
		Location:   location,
		Details:    details,
		Start:      start,
		End:        &end,
		ReadOnly:   readOnly,
		UpdatedAt:  item.LastModifiedDateTime,
		NixItemID:  graphItemStamp(item),
	}
}

// graphItemStamp reads the Nix item id a created event was stamped with: its transactionId, or the
// extended property when present. Another app's transactionId is not a canonical UUID and yields "".
func graphItemStamp(item graphEvent) string {
	if broker.IsCanonicalUUID(item.TransactionID) {
		return item.TransactionID
	}
	for _, property := range item.ExtendedProperties {
		if property.ID == graphItemPropertyID && broker.IsCanonicalUUID(property.Value) {
			return property.Value
		}
	}
	return ""
}

// graphBound converts one Graph dateTimeTimeZone into a Bound. Graph's dateTime string carries
// no offset; we requested Prefer: outlook.timezone="UTC", so it is always a naive UTC instant,
// which we then re-express in the event's authored zone (from originalStartTimeZone/
// originalEndTimeZone, mapped through WindowsToIANA). All-day events carry midnight UTC
// instants; Graph's end is exclusive there too, so it is converted to Nix's inclusive semantics
// exactly like Google's end.date.
func graphBound(value graphDateTime, zone string, allDay, isEnd bool) Bound {
	instant, err := time.ParseInLocation("2006-01-02T15:04:05.999999999", value.DateTime, time.UTC)
	if err != nil {
		instant = time.Time{}
	}
	if allDay {
		date := instant.Format(dateLayout)
		if isEnd {
			if inclusive, err := InclusiveEndDate(date); err == nil {
				date = inclusive
			}
		}
		return Bound{AllDay: true, Date: date}
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		loc, zone = time.UTC, "UTC"
	}
	return Bound{Instant: instant.In(loc), Zone: zone}
}

// CreateEvent posts the event stamped with the Nix item id twice over: transactionId (which Graph
// documents as its guard against a client retrying the same create) and a single-value extended
// property.
func (client *MicrosoftClient) CreateEvent(ctx context.Context, accessToken, calendarID string, event PushEvent) (string, string, error) {
	payload := graphEventBody(event)
	if broker.IsCanonicalUUID(event.NixItemID) {
		payload["transactionId"] = event.NixItemID
		payload["singleValueExtendedProperties"] = []graphProperty{{ID: graphItemPropertyID, Value: event.NixItemID}}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", "", err
	}
	path := "/v1.0/me/calendars/" + url.PathEscape(calendarID) + "/events"
	response, err := client.transport.do(ctx, http.MethodPost, path, bearerJSONHeaders(accessToken), bytes.NewReader(body))
	if err != nil {
		return "", "", err
	}
	responseBody, err := readBoundedBody(response.Body)
	if err != nil {
		return "", "", err
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusCreated {
		return "", "", graphAPIError(response.StatusCode, responseBody)
	}
	var created graphEvent
	if err := json.Unmarshal(responseBody, &created); err != nil {
		return "", "", fmt.Errorf("decode graph calendar create response: %w", err)
	}
	return created.ID, created.ChangeKey, nil
}

func (client *MicrosoftClient) UpdateEvent(ctx context.Context, accessToken, calendarID, externalID, version string, event PushEvent) (string, error) {
	body, err := json.Marshal(graphEventBody(event))
	if err != nil {
		return "", err
	}
	headers := bearerJSONHeaders(accessToken)
	if version != "" {
		headers["If-Match"] = version
	}
	path := "/v1.0/me/calendars/" + url.PathEscape(calendarID) + "/events/" + url.PathEscape(externalID)
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
		var updated graphEvent
		if err := json.Unmarshal(responseBody, &updated); err != nil {
			return "", fmt.Errorf("decode graph calendar update response: %w", err)
		}
		return updated.ChangeKey, nil
	case http.StatusPreconditionFailed:
		return "", ErrConflict
	case http.StatusNotFound, http.StatusGone:
		return "", ErrGone
	default:
		return "", graphAPIError(response.StatusCode, responseBody)
	}
}

func (client *MicrosoftClient) DeleteEvent(ctx context.Context, accessToken, calendarID, externalID, version string) error {
	headers := bearerHeaders(accessToken)
	if version != "" {
		headers["If-Match"] = version
	}
	path := "/v1.0/me/calendars/" + url.PathEscape(calendarID) + "/events/" + url.PathEscape(externalID)
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
		return graphAPIError(response.StatusCode, responseBody)
	}
}

func graphEventBody(event PushEvent) map[string]any {
	body := map[string]any{
		"subject":  event.Title,
		"body":     map[string]any{"contentType": "text", "content": event.Details},
		"location": map[string]any{"displayName": event.Location},
		"start":    graphDateTimeBody(event.Start, false),
		"isAllDay": event.Start.AllDay,
	}
	if event.End != nil {
		body["end"] = graphDateTimeBody(*event.End, true)
	}
	return body
}

func graphDateTimeBody(bound Bound, isEnd bool) graphDateTime {
	if bound.AllDay {
		date := bound.Date
		if isEnd {
			if exclusive, err := ExclusiveEndDate(date); err == nil {
				date = exclusive
			}
		}
		return graphDateTime{DateTime: date + "T00:00:00.0000000", TimeZone: "UTC"}
	}
	return graphDateTime{
		DateTime: bound.Instant.In(mustLocation(bound.Zone)).Format("2006-01-02T15:04:05.0000000"),
		TimeZone: bound.Zone,
	}
}

func graphAPIError(status int, body []byte) error {
	var decoded graphErrorResponse
	if err := json.Unmarshal(body, &decoded); err == nil && decoded.Error.Message != "" {
		return fmt.Errorf("microsoft graph calendar API returned %d: %s", status, decoded.Error.Message)
	}
	return errors.New("microsoft graph calendar API returned " + strconv.Itoa(status))
}
