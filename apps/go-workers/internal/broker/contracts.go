package broker

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

const (
	CommandsExchange     = "nix.commands.v1"
	ResultsExchange      = "nix.results.v1"
	WorkspaceExchange    = "nix.workspace.v1"
	CapabilitiesExchange = "nix.capabilities.v1"
	ImportQueue          = "nix.worker.import.v1"
	ExportQueue          = "nix.worker.export.v1"
	PluginEventsQueue    = "nix.worker.plugin-events.v1"
	CalendarQueue        = "nix.worker.calendar.v1"
	NotifyQueue          = "nix.worker.notify.v1"
	ResultRoutingKey     = "job.result"
	CommandMessageType   = "worker.command.v1"
	ResultMessageType    = "worker.result.v1"
	WorkspaceMessageType = "workspace.event.v1"
	SchemaVersion        = 1
	maxEnvelopeDepth     = 12
	maxEnvelopeTokens    = 8192
	maxEnvelopeTextBytes = 64 << 10
)

var ErrInvalidMessage = errors.New("invalid broker message")

type Envelope struct {
	SchemaVersion    int             `json:"schemaVersion"`
	MessageID        string          `json:"messageId"`
	MessageType      string          `json:"messageType"`
	OccurredAt       time.Time       `json:"occurredAt"`
	TenantID         string          `json:"tenantId"`
	WorkspaceID      *string         `json:"workspaceId"`
	ItemID           *string         `json:"itemId"`
	Kind             string          `json:"kind"`
	Payload          json.RawMessage `json:"payload"`
	CorrelationID    string          `json:"correlationId"`
	CausationID      *string         `json:"causationId,omitempty"`
	CausationDepth   int             `json:"causationDepth,omitempty"`
	TraceParent      *string         `json:"traceParent,omitempty"`
	AggregateVersion *int64          `json:"aggregateVersion,omitempty"`
}

// WorkspaceEvent is the validated durable event contract consumed by plugins.
// AggregateVersion is optional until every Nix.Api publisher includes the source
// aggregate's monotonic version in workspace.event.v1.
type WorkspaceEvent struct {
	MessageID        string
	OccurredAt       time.Time
	TenantID         string
	WorkspaceID      string
	ItemID           string
	Kind             string
	Payload          json.RawMessage
	CorrelationID    string
	AggregateVersion *int64
	CausationID      *string
	CausationDepth   int
}

type CommandReference struct {
	JobID string `json:"jobId"`
	Kind  string `json:"kind"`
}

type WorkerResult struct {
	SchemaVersion int             `json:"schemaVersion"`
	MessageID     string          `json:"messageId"`
	MessageType   string          `json:"messageType"`
	OccurredAt    time.Time       `json:"occurredAt"`
	JobID         string          `json:"jobId"`
	ExecutionID   string          `json:"executionId"`
	Succeeded     bool            `json:"succeeded"`
	Retryable     bool            `json:"retryable"`
	Result        json.RawMessage `json:"result,omitempty"`
	ErrorCode     *string         `json:"errorCode,omitempty"`
	ErrorDetail   *string         `json:"errorDetail,omitempty"`
	TraceParent   *string         `json:"traceParent,omitempty"`
}

type ExportFormatCapability struct {
	Format       string   `json:"format"`
	Label        string   `json:"label"`
	Extension    string   `json:"extension"`
	MediaType    string   `json:"mediaType"`
	Lossless     bool     `json:"lossless"`
	DeclaredLoss []string `json:"declaredLoss"`
}

type WorkerCapabilities struct {
	SchemaVersion int                      `json:"schemaVersion"`
	MessageID     string                   `json:"messageId"`
	MessageType   string                   `json:"messageType"`
	InstanceID    string                   `json:"instanceId"`
	Role          string                   `json:"role"`
	OccurredAt    time.Time                `json:"occurredAt"`
	ExpiresAt     time.Time                `json:"expiresAt"`
	ExportFormats []ExportFormatCapability `json:"exportFormats"`
}

func ParseEnvelope(body []byte, maxBytes int) (Envelope, error) {
	if maxBytes <= 0 || len(body) == 0 || len(body) > maxBytes {
		return Envelope{}, ErrInvalidMessage
	}
	if err := validateJSONShape(body, maxEnvelopeDepth, maxEnvelopeTokens, maxEnvelopeTextBytes); err != nil {
		return Envelope{}, errors.Join(ErrInvalidMessage, err)
	}
	var envelope Envelope
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return Envelope{}, errors.Join(ErrInvalidMessage, err)
	}
	if err := requireJSONEOF(decoder); err != nil {
		return Envelope{}, errors.Join(ErrInvalidMessage, err)
	}
	if envelope.SchemaVersion != SchemaVersion || !boundedText(envelope.MessageID, 128) || !boundedText(envelope.MessageType, 128) || !boundedText(envelope.TenantID, 128) || !boundedText(envelope.Kind, 128) || !boundedText(envelope.CorrelationID, 128) || len(envelope.Payload) == 0 || envelope.OccurredAt.IsZero() {
		return Envelope{}, ErrInvalidMessage
	}
	if envelope.WorkspaceID != nil && !boundedText(*envelope.WorkspaceID, 128) || envelope.ItemID != nil && !boundedText(*envelope.ItemID, 128) || envelope.CausationID != nil && !boundedText(*envelope.CausationID, 128) || envelope.TraceParent != nil && !boundedText(*envelope.TraceParent, 256) {
		return Envelope{}, ErrInvalidMessage
	}
	if envelope.AggregateVersion != nil && *envelope.AggregateVersion <= 0 {
		return Envelope{}, ErrInvalidMessage
	}
	if envelope.CausationDepth < 0 || envelope.CausationDepth > 4 ||
		envelope.CausationDepth == 0 && envelope.CausationID != nil ||
		envelope.CausationDepth > 0 && (envelope.CausationID == nil || !IsCanonicalUUID(*envelope.CausationID)) {
		return Envelope{}, ErrInvalidMessage
	}
	return envelope, nil
}

func (envelope Envelope) Command() (CommandReference, error) {
	if envelope.MessageType != CommandMessageType {
		return CommandReference{}, ErrInvalidMessage
	}
	var command CommandReference
	if err := json.Unmarshal(envelope.Payload, &command); err != nil {
		return CommandReference{}, errors.Join(ErrInvalidMessage, err)
	}
	if command.JobID == "" || command.Kind == "" || command.Kind != envelope.Kind || envelope.CorrelationID != command.JobID {
		return CommandReference{}, ErrInvalidMessage
	}
	return command, nil
}

// WorkspaceEvent validates the scope and routing invariants for plugin workspace events.
func (envelope Envelope) WorkspaceEvent() (WorkspaceEvent, error) {
	if envelope.MessageType != WorkspaceMessageType || !IsCanonicalUUID(envelope.MessageID) || !IsCanonicalUUID(envelope.TenantID) || envelope.WorkspaceID == nil || !IsCanonicalUUID(*envelope.WorkspaceID) || envelope.ItemID == nil || !IsCanonicalUUID(*envelope.ItemID) || envelope.CorrelationID != envelope.MessageID {
		return WorkspaceEvent{}, ErrInvalidMessage
	}
	switch envelope.Kind {
	case "item.changed", "item.deleted", "permission.changed":
	default:
		return WorkspaceEvent{}, ErrInvalidMessage
	}
	trimmed := bytes.TrimSpace(envelope.Payload)
	if len(trimmed) < 2 || trimmed[0] != '{' || trimmed[len(trimmed)-1] != '}' {
		return WorkspaceEvent{}, ErrInvalidMessage
	}
	return WorkspaceEvent{
		MessageID:        envelope.MessageID,
		OccurredAt:       envelope.OccurredAt.UTC(),
		TenantID:         envelope.TenantID,
		WorkspaceID:      *envelope.WorkspaceID,
		ItemID:           *envelope.ItemID,
		Kind:             envelope.Kind,
		Payload:          append(json.RawMessage(nil), envelope.Payload...),
		CorrelationID:    envelope.CorrelationID,
		AggregateVersion: envelope.AggregateVersion,
		CausationID:      envelope.CausationID,
		CausationDepth:   envelope.CausationDepth,
	}, nil
}

func boundedText(value string, limit int) bool {
	return value != "" && value == strings.TrimSpace(value) && len(value) <= limit
}

// IsCanonicalUUID reports whether value is a lowercase, non-nil UUID in canonical form.
func IsCanonicalUUID(value string) bool {
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

type jsonFrame struct {
	object       bool
	expectingKey bool
	keys         map[string]struct{}
}

func validateJSONShape(body []byte, maxDepth, maxTokens, maxTextBytes int) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	frames := make([]jsonFrame, 0, maxDepth)
	tokens := 0
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			if len(frames) != 0 {
				return errors.New("JSON containers are incomplete")
			}
			return nil
		}
		if err != nil {
			return err
		}
		tokens++
		if tokens > maxTokens {
			return errors.New("JSON token limit exceeded")
		}
		switch value := token.(type) {
		case json.Delim:
			switch value {
			case '{':
				if len(frames) >= maxDepth {
					return errors.New("JSON depth limit exceeded")
				}
				frames = append(frames, jsonFrame{object: true, expectingKey: true, keys: make(map[string]struct{})})
			case '[':
				if len(frames) >= maxDepth {
					return errors.New("JSON depth limit exceeded")
				}
				frames = append(frames, jsonFrame{})
			case '}', ']':
				if len(frames) == 0 {
					return errors.New("JSON container is unbalanced")
				}
				frames = frames[:len(frames)-1]
				completeJSONValue(frames)
			}
		case string:
			if len(value) > maxTextBytes {
				return errors.New("JSON string limit exceeded")
			}
			if len(frames) > 0 && frames[len(frames)-1].object && frames[len(frames)-1].expectingKey {
				frame := &frames[len(frames)-1]
				if _, duplicate := frame.keys[value]; duplicate {
					return fmt.Errorf("duplicate JSON member %q", value)
				}
				frame.keys[value] = struct{}{}
				frame.expectingKey = false
			} else {
				completeJSONValue(frames)
			}
		default:
			completeJSONValue(frames)
		}
	}
}

func completeJSONValue(frames []jsonFrame) {
	if len(frames) > 0 && frames[len(frames)-1].object && !frames[len(frames)-1].expectingKey {
		frames[len(frames)-1].expectingKey = true
	}
}

func requireJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values are not allowed")
		}
		return err
	}
	return nil
}
