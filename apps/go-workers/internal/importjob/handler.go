package importjob

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/sianachi/Nix/apps/go-workers/internal/importer"
	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
	"github.com/sianachi/Nix/apps/go-workers/internal/worktemp"
)

var Kinds = []string{"import.nix", "import.markdown", "import.txt", "import.docx", "import.pdf"}

type Payload struct {
	SourceURL      string `json:"sourceUrl"`
	DestinationURL string `json:"destinationUrl,omitempty"`
	ExpectedSHA256 string `json:"expectedSha256,omitempty"`
	Format         string `json:"format"`
	RootID         string `json:"rootId"`
	Title          string `json:"title"`
	Preview        bool   `json:"preview,omitempty"`
}

type Result struct {
	Items        int      `json:"items"`
	Loss         []string `json:"loss"`
	OutputBytes  int64    `json:"outputBytes,omitempty"`
	OutputSHA256 string   `json:"outputSha256,omitempty"`
	Preview      bool     `json:"preview"`
}

type Handler struct {
	transfer *objecttransfer.Client
	limits   importer.Limits
	stream   stream.Limits
}

func New(transfer *objecttransfer.Client, importLimits importer.Limits, streamLimits stream.Limits) *Handler {
	return &Handler{transfer: transfer, limits: importLimits, stream: streamLimits}
}

func (handler *Handler) Handle(ctx context.Context, job workerapi.Job) (any, error) {
	payload, err := decodePayload(job.Payload)
	if err != nil {
		return nil, jobrunner.Fail("import_payload_invalid", err)
	}
	if job.Kind != "import."+normalizedFormat(payload.Format) {
		return nil, jobrunner.Fail("import_kind_mismatch", errors.New("job kind does not match import format"))
	}
	download, err := handler.transfer.Download(ctx, payload.SourceURL, handler.limits.MaxBytes)
	if err != nil {
		return nil, jobrunner.Retry("import_source_unavailable", err)
	}
	parsed, parseErr := importer.Parse(payload.Format, payload.RootID, payload.Title, download.Body, handler.limits)
	closeErr := download.Body.Close()
	if parseErr != nil {
		return nil, jobrunner.Fail("import_invalid", parseErr)
	}
	if closeErr != nil {
		return nil, jobrunner.Retry("import_source_unavailable", closeErr)
	}
	if err := objecttransfer.VerifyDigest(download.Digest, payload.ExpectedSHA256); err != nil {
		return nil, jobrunner.Fail("import_checksum_mismatch", err)
	}
	result := Result{Items: len(parsed.Records), Loss: nonNil(parsed.Loss), Preview: payload.Preview}
	if payload.Preview {
		return result, nil
	}
	for index, asset := range parsed.Assets {
		parsed.Records = append(parsed.Records, stream.Record{
			ID: fmt.Sprintf("%s-asset-%d", payload.RootID, index+1), ParentID: payload.RootID,
			Title: asset.Name, Body: base64.StdEncoding.EncodeToString(asset.Body),
			Properties: map[string]any{"$file": map[string]any{"mediaType": asset.MediaType, "encoding": "base64"}},
		})
	}
	if payload.DestinationURL == "" {
		return nil, jobrunner.Fail("import_payload_invalid", errors.New("destinationUrl is required outside preview mode"))
	}
	file, err := worktemp.Create("nix-import-stage-*")
	if err != nil {
		return nil, jobrunner.Fail("import_stage_failed", err)
	}
	path := file.Name()
	defer func() { _ = os.Remove(path) }()
	digest := sha256.New()
	summary, writeErr := stream.WriteRecords(io.MultiWriter(file, digest), parsed.Records, handler.stream)
	closeErr = file.Close()
	if writeErr != nil {
		return nil, jobrunner.Fail("import_stage_failed", writeErr)
	}
	if closeErr != nil {
		return nil, jobrunner.Fail("import_stage_failed", closeErr)
	}
	checksum := hex.EncodeToString(digest.Sum(nil))
	staged, err := os.Open(path)
	if err != nil {
		return nil, jobrunner.Fail("import_stage_failed", err)
	}
	defer staged.Close()
	if err := handler.transfer.Upload(ctx, payload.DestinationURL, "application/x-ndjson", staged, summary.Bytes, checksum); err != nil {
		return nil, jobrunner.Retry("import_publish_failed", err)
	}
	result.OutputBytes = summary.Bytes
	result.OutputSHA256 = checksum
	return result, nil
}

func decodePayload(raw json.RawMessage) (Payload, error) {
	payload, err := jobrunner.DecodeStrict[Payload](raw)
	if err != nil {
		return Payload{}, err
	}
	if payload.SourceURL == "" || payload.Format == "" || payload.RootID == "" || payload.Title == "" {
		return Payload{}, errors.New("sourceUrl, format, rootId, and title are required")
	}
	return payload, nil
}

func normalizedFormat(format string) string {
	switch strings.ToLower(format) {
	case "md":
		return "markdown"
	default:
		return strings.ToLower(format)
	}
}

func nonNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
