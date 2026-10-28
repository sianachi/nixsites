package exporter

import (
	"archive/zip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

type RecordSource func() (stream.Record, bool, error)

// ReportSource is evaluated only after every record has been projected, so it can include losses
// discovered lazily while the source stream was consumed.
type ReportSource func() []string

func Write(format string, records []stream.Record, output io.Writer, limits stream.Limits) error {
	if len(records) > limits.MaxRecords {
		return stream.ErrLimitExceeded
	}
	if strings.EqualFold(format, "nix") {
		return writeNix(output, records, limits)
	}
	index := 0
	return WriteStream(format, func() (stream.Record, bool, error) {
		if index == len(records) {
			return stream.Record{}, false, nil
		}
		record := records[index]
		index++
		return record, true, nil
	}, output, limits)
}

// WriteStream converts records without retaining the workspace body set in memory.
func WriteStream(format string, next RecordSource, output io.Writer, limits stream.Limits) error {
	return WriteStreamWithReport(format, next, output, limits, nil)
}

// WriteStreamWithReport converts records. The report remains available to internal callers for
// job diagnostics, but is not embedded in user downloads.
func WriteStreamWithReport(format string, next RecordSource, output io.Writer, limits stream.Limits, report ReportSource) error {
	if next == nil || output == nil || limits.MaxBytes <= 0 || limits.MaxLine <= 0 || limits.MaxRecords <= 0 {
		return errors.New("export writer configuration is invalid")
	}
	switch strings.ToLower(format) {
	case "ndjson", "jsonl":
		return writeNDJSON(output, next, limits)
	case "markdown", "md":
		return writeMarkdown(output, next, limits, report)
	case "docx":
		return writeDOCX(output, next, limits, report)
	case "pdf":
		return writePDF(output, next, limits, report)
	default:
		return fmt.Errorf("unsupported streaming export format: %s", format)
	}
}

func writeNDJSON(output io.Writer, next RecordSource, limits stream.Limits) error {
	limited := &limitedWriter{writer: output, remaining: limits.MaxBytes}
	encoder := json.NewEncoder(limited)
	return eachRecord(next, limits.MaxRecords, func(record stream.Record) error {
		return encoder.Encode(record)
	}, limited)
}

func writeMarkdown(output io.Writer, next RecordSource, limits stream.Limits, report ReportSource) error {
	limited := &limitedWriter{writer: output, remaining: limits.MaxBytes}
	err := eachRecord(next, limits.MaxRecords, func(record stream.Record) error {
		if record.Title == "" {
			return errors.New("export record title is required")
		}
		title, _ := ProjectTitle(record.Title, true)
		if _, err := io.WriteString(limited, "# "+title+"\n\n"); err != nil {
			return err
		}
		if _, err := io.WriteString(limited, strings.TrimSpace(sanitizeText(markdownImages(record)))); err != nil {
			return err
		}
		_, err := io.WriteString(limited, "\n\n")
		return err
	}, limited)
	if err != nil {
		return err
	}
	return limited.err
}

func eachRecord(next RecordSource, maximum int, consume func(stream.Record) error, limited *limitedWriter) error {
	count := 0
	for {
		record, ok, err := next()
		if err != nil {
			return err
		}
		if !ok {
			return limited.err
		}
		count++
		if count > maximum {
			return stream.ErrLimitExceeded
		}
		if err := consume(record); err != nil {
			return err
		}
	}
}

func writeNix(output io.Writer, records []stream.Record, limits stream.Limits) error {
	if len(records) == 0 {
		return errors.New("cannot export an empty Nix archive")
	}
	limitedOutput := &limitedWriter{writer: output, remaining: limits.MaxBytes}
	archive := zip.NewWriter(limitedOutput)
	manifest := map[string]any{
		"format": "nix-archive", "formatVersion": 1, "schemaVersion": 1,
		"exportedAt": "1970-01-01T00:00:00Z", "root": records[0].ID,
		"rootEffectiveSchema": nil, "includesDeleted": false, "items": make([]map[string]any, 0, len(records)),
		"omitted": []any{}, "loss": []any{},
	}
	items := manifest["items"].([]map[string]any)
	for position, record := range records {
		if record.ID == "" || record.Title == "" {
			return errors.New("every exported record must contain id and title")
		}
		if strings.Contains(record.ID, "/") || strings.Contains(record.ID, "\\") || strings.Contains(record.ID, "..") {
			return fmt.Errorf("unsafe item identifier: %s", record.ID)
		}
		items = append(items, map[string]any{"id": record.ID, "parentId": nullable(record.ParentID), "seq": strconv.Itoa(position), "title": record.Title, "type": "note"})
	}
	manifest["items"] = items
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	if err := writeZipEntry(archive, "manifest.json", manifestBytes, limits); err != nil {
		return err
	}
	for _, record := range records {
		payload, marshalErr := json.Marshal(record)
		if marshalErr != nil {
			return marshalErr
		}
		if err := writeZipEntry(archive, "items/"+record.ID+".json", payload, limits); err != nil {
			return err
		}
	}
	if err := archive.Close(); err != nil {
		return err
	}
	return limitedOutput.err
}

type limitedWriter struct {
	writer    io.Writer
	remaining int64
	err       error
}

func (writer *limitedWriter) Write(value []byte) (int, error) {
	if writer.err != nil {
		return 0, writer.err
	}
	if int64(len(value)) > writer.remaining {
		writer.err = stream.ErrLimitExceeded
		return 0, writer.err
	}
	written, err := writer.writer.Write(value)
	writer.remaining -= int64(written)
	if err != nil {
		writer.err = err
	}
	return written, err
}

func createZipEntry(archive *zip.Writer, name string) (io.Writer, error) {
	if strings.Contains(name, "..") || strings.Contains(name, "\\") {
		return nil, errors.New("unsafe archive path")
	}
	header := &zip.FileHeader{Name: name, Method: zip.Deflate}
	header.SetModTime(time.Date(1980, time.January, 1, 0, 0, 0, 0, time.UTC))
	return archive.CreateHeader(header)
}

func writeZipEntry(archive *zip.Writer, name string, body []byte, limits stream.Limits) error {
	if len(body) > limits.MaxLine {
		return stream.ErrLimitExceeded
	}
	entry, err := createZipEntry(archive, name)
	if err != nil {
		return err
	}
	_, err = entry.Write(body)
	return err
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func markdownImages(record stream.Record) string {
	replacements := make([]string, 0, len(record.Images)*2)
	for _, raster := range record.Images {
		replacements = append(replacements, raster.Source, "data:image/"+raster.Format+";base64,"+base64.StdEncoding.EncodeToString(raster.Data))
	}
	return strings.NewReplacer(replacements...).Replace(record.Body)
}
