package stream

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/sianachi/Nix/apps/go-workers/internal/render"
)

var ErrLimitExceeded = errors.New("stream limit exceeded")

// Image contains validated raster bytes for one converted note, never a capability URL.
type Image struct {
	Source      string
	Data        []byte
	Format      string
	Width       int
	PixelWidth  int
	PixelHeight int
}

type Record struct {
	Images []Image `json:"-"`
	// Blocks is the body as a render tree, for the Markdown, DOCX and PDF writers. The archive and
	// NDJSON formats carry Body as text and never see it.
	Blocks     []render.Block `json:"-"`
	ID         string         `json:"id"`
	ParentID   string         `json:"parentId,omitempty"`
	Title      string         `json:"title"`
	Body       string         `json:"body,omitempty"`
	Properties map[string]any `json:"properties,omitempty"`
}

type Limits struct {
	MaxBytes   int64
	MaxLine    int
	MaxRecords int
}

type Summary struct {
	Records int   `json:"records"`
	Bytes   int64 `json:"bytes"`
}

type Writer struct {
	encoder *json.Encoder
	limits  Limits
	summary Summary
}

func NewWriter(writer io.Writer, limits Limits) *Writer {
	return &Writer{encoder: json.NewEncoder(writer), limits: limits}
}

func (writer *Writer) Write(record Record) error {
	if writer.summary.Records >= writer.limits.MaxRecords {
		return ErrLimitExceeded
	}
	if record.ID == "" || record.Title == "" {
		return fmt.Errorf("record %d must contain id and title", writer.summary.Records+1)
	}
	line, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("record %d cannot be encoded: %w", writer.summary.Records+1, err)
	}
	if len(line)+1 > writer.limits.MaxLine || writer.summary.Bytes+int64(len(line)+1) > writer.limits.MaxBytes {
		return ErrLimitExceeded
	}
	if err := writer.encoder.Encode(record); err != nil {
		return err
	}
	writer.summary.Records++
	writer.summary.Bytes += int64(len(line) + 1)
	return nil
}

func (writer *Writer) Summary() Summary {
	return writer.summary
}

func ReadRecords(reader io.Reader, limits Limits, visit func(Record) error) (Summary, error) {
	if limits.MaxBytes <= 0 || limits.MaxLine <= 0 || limits.MaxRecords <= 0 {
		return Summary{}, fmt.Errorf("stream limits must be positive")
	}
	scanner := bufio.NewScanner(io.LimitReader(reader, limits.MaxBytes+1))
	initialBuffer := limits.MaxLine
	if initialBuffer > 64*1024 {
		initialBuffer = 64 * 1024
	}
	scanner.Buffer(make([]byte, initialBuffer), limits.MaxLine)
	var summary Summary
	for scanner.Scan() {
		line := scanner.Bytes()
		summary.Bytes += int64(len(line)) + 1
		if summary.Bytes > limits.MaxBytes {
			return summary, ErrLimitExceeded
		}
		if summary.Records >= limits.MaxRecords {
			return summary, ErrLimitExceeded
		}
		var record Record
		if err := json.Unmarshal(line, &record); err != nil {
			return summary, fmt.Errorf("record %d is not valid JSON: %w", summary.Records+1, err)
		}
		if record.ID == "" || record.Title == "" {
			return summary, fmt.Errorf("record %d must contain id and title", summary.Records+1)
		}
		if err := visit(record); err != nil {
			return summary, err
		}
		summary.Records++
	}
	if err := scanner.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			return summary, ErrLimitExceeded
		}
		return summary, err
	}
	return summary, nil
}

func WriteRecords(writer io.Writer, records []Record, limits Limits) (Summary, error) {
	streamWriter := NewWriter(writer, limits)
	for _, record := range records {
		if err := streamWriter.Write(record); err != nil {
			return streamWriter.Summary(), err
		}
	}
	return streamWriter.Summary(), nil
}
