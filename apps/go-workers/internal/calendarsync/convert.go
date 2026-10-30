// Package calendarsync implements the Go `calendar` role: pulling and pushing events between
// Google Calendar, Microsoft Graph calendars and Nix items, behind the worker-executions
// contracts C1-C6 (see docs/adr/0052-two-way-calendar-sync.md).
package calendarsync

import (
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

const dateLayout = "2006-01-02"

// Bound is one endpoint (start or end) of a calendar event, in the same "date or date-time"
// shape items use for the `datetime` property type: either an all-day date or a timed instant
// carried with its IANA zone. Wire() renders it exactly as contract C2/C3 expect: `yyyy-MM-dd`
// for an all-day boundary, RFC 9557 (an RFC 3339 timestamp followed by a bracketed IANA zone
// name) for a timed one.
type Bound struct {
	AllDay  bool
	Date    string    // set when AllDay; yyyy-MM-dd
	Instant time.Time // set when !AllDay; the absolute instant
	Zone    string    // set when !AllDay; IANA zone name the instant is rendered in
}

// Wire renders the bound the way contracts C2 and C3 encode a DateOrTimestamp value.
func (bound Bound) Wire() string {
	if bound.AllDay {
		return bound.Date
	}
	return bound.Instant.In(mustLocation(bound.Zone)).Format(time.RFC3339) + "[" + bound.Zone + "]"
}

// ParseBound decodes a contract C2/C3 DateOrTimestamp string back into a Bound. It accepts
// exactly the two shapes the contract allows: a bare `yyyy-MM-dd` date, or an RFC 9557
// timestamp (RFC 3339 followed by `[IANA/Zone]`).
func ParseBound(value string) (Bound, error) {
	if len(value) == len(dateLayout) {
		if parsed, err := time.Parse(dateLayout, value); err == nil {
			return Bound{AllDay: true, Date: parsed.Format(dateLayout)}, nil
		}
	}
	open := strings.IndexByte(value, '[')
	if open <= 0 || !strings.HasSuffix(value, "]") {
		return Bound{}, fmt.Errorf("calendar bound %q is neither a date nor an RFC 9557 timestamp", value)
	}
	zone := value[open+1 : len(value)-1]
	loc, err := time.LoadLocation(zone)
	if err != nil {
		return Bound{}, fmt.Errorf("calendar bound zone %q is invalid: %w", zone, err)
	}
	instant, err := time.Parse(time.RFC3339, value[:open])
	if err != nil {
		return Bound{}, fmt.Errorf("calendar bound timestamp %q is invalid: %w", value, err)
	}
	return Bound{AllDay: false, Instant: instant.In(loc), Zone: zone}, nil
}

func mustLocation(zone string) *time.Location {
	loc, err := time.LoadLocation(zone)
	if err != nil {
		return time.UTC
	}
	return loc
}

// InclusiveEndDate converts a provider's end-exclusive all-day end date (Google `end.date`,
// Graph's `end` when `isAllDay`) to the inclusive end date Nix items use: the day before the
// exclusive boundary. A one-day event has an exclusive end equal to its start plus one day,
// which becomes an inclusive end equal to its start.
func InclusiveEndDate(exclusiveEnd string) (string, error) {
	parsed, err := time.Parse(dateLayout, exclusiveEnd)
	if err != nil {
		return "", fmt.Errorf("provider end date %q is invalid: %w", exclusiveEnd, err)
	}
	return parsed.AddDate(0, 0, -1).Format(dateLayout), nil
}

// ExclusiveEndDate is the inverse of InclusiveEndDate: it converts a Nix inclusive end date back
// to the end-exclusive date the provider APIs require on push.
func ExclusiveEndDate(inclusiveEnd string) (string, error) {
	parsed, err := time.Parse(dateLayout, inclusiveEnd)
	if err != nil {
		return "", fmt.Errorf("item end date %q is invalid: %w", inclusiveEnd, err)
	}
	return parsed.AddDate(0, 0, 1).Format(dateLayout), nil
}

// ErrUnknownWindowsZone is returned by neither exported function below; WindowsToIANA never
// fails; it falls back to UTC and logs instead, matching the plan's "fall back to UTC with a log
// event" instruction. It is retained here so tests can assert the fallback was UTC.
var ErrUnknownWindowsZone = errors.New("unrecognized Windows time zone name")

// windowsToIANA maps the CLDR Windows zone names Graph reports in `originalStartTimeZone` (and
// `originalEndTimeZone`) to the IANA zone Bound.Zone expects. This is not the full CLDR table:
// it covers the zones the ADR asks for ("common zones") and falls back to UTC, via
// WindowsToIANA, for anything else.
var windowsToIANA = map[string]string{
	"UTC":                            "UTC",
	"GMT Standard Time":              "Europe/London",
	"W. Europe Standard Time":        "Europe/Berlin",
	"Central Europe Standard Time":   "Europe/Budapest",
	"Central European Standard Time": "Europe/Warsaw",
	"Romance Standard Time":          "Europe/Paris",
	"E. Europe Standard Time":        "Europe/Chisinau",
	"Russian Standard Time":          "Europe/Moscow",
	"Turkey Standard Time":           "Europe/Istanbul",
	"Israel Standard Time":           "Asia/Jerusalem",
	"Arabian Standard Time":          "Asia/Dubai",
	"India Standard Time":            "Asia/Kolkata",
	"China Standard Time":            "Asia/Shanghai",
	"Tokyo Standard Time":            "Asia/Tokyo",
	"Korea Standard Time":            "Asia/Seoul",
	"SE Asia Standard Time":          "Asia/Bangkok",
	"Singapore Standard Time":        "Asia/Singapore",
	"AUS Eastern Standard Time":      "Australia/Sydney",
	"AUS Central Standard Time":      "Australia/Darwin",
	"New Zealand Standard Time":      "Pacific/Auckland",
	"South Africa Standard Time":     "Africa/Johannesburg",
	"Eastern Standard Time":          "America/New_York",
	"Central Standard Time":          "America/Chicago",
	"Mountain Standard Time":         "America/Denver",
	"Pacific Standard Time":          "America/Los_Angeles",
	"Alaskan Standard Time":          "America/Anchorage",
	"Hawaiian Standard Time":         "Pacific/Honolulu",
	"Argentina Standard Time":        "America/Argentina/Buenos_Aires",
	"E. South America Standard Time": "America/Sao_Paulo",
	"Pacific SA Standard Time":       "America/Santiago",
	"Atlantic Standard Time":         "America/Halifax",
	"Newfoundland Standard Time":     "America/St_Johns",
}

// WindowsToIANA resolves a Graph `originalStartTimeZone`/`originalEndTimeZone` Windows zone name
// to the IANA zone name Bound and Wire() need. Unknown or empty names fall back to UTC and are
// reported through logger so an operator can see which zone is missing from the table, per the
// plan: "fall back to UTC with a log event".
func WindowsToIANA(windowsName string, logger *slog.Logger) string {
	trimmed := strings.TrimSpace(windowsName)
	if trimmed == "" {
		return "UTC"
	}
	if iana, ok := windowsToIANA[trimmed]; ok {
		return iana
	}
	if logger != nil {
		logger.Warn("unrecognized Windows time zone; falling back to UTC", "windowsZone", trimmed)
	}
	return "UTC"
}
