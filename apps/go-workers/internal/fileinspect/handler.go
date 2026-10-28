package fileinspect

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
	"github.com/sianachi/Nix/apps/go-workers/internal/worktemp"
)

// Kinds uses file.publish while keeping bounded header inspection inside the publication job.
// The job never decodes, executes, or unpacks uploaded bytes.
var Kinds = []string{"file.publish"}

type Payload struct {
	UploadID string `json:"uploadId"`
}

type Result struct {
	UploadID                    string `json:"uploadId"`
	ItemID                      string `json:"itemId"`
	WorkspaceID                 string `json:"workspaceId"`
	DetectedMediaType           string `json:"detectedMediaType"`
	ByteLength                  int64  `json:"byteLength"`
	SHA256                      string `json:"sha256"`
	Previewable                 bool   `json:"previewable"`
	DeclaredMediaTypeConsistent bool   `json:"declaredMediaTypeConsistent"`
}

type Handler struct {
	api      *workerapi.Client
	transfer *objecttransfer.Client
	maxBytes int64
	// thumbnails bounds how many thumbnails this process decodes at once; see thumbnails.go.
	thumbnails chan struct{}
}

func New(api *workerapi.Client, transfer *objecttransfer.Client, maxBytes int64) *Handler {
	return &Handler{api: api, transfer: transfer, maxBytes: maxBytes, thumbnails: make(chan struct{}, maxConcurrentThumbnails)}
}

func (handler *Handler) Handle(ctx context.Context, job workerapi.Job) (any, error) {
	if job.Kind != "file.publish" {
		return nil, jobrunner.Fail("files.kind_mismatch", errors.New("job kind is not file.publish"))
	}
	payload, err := decodePayload(job.Payload)
	if err != nil {
		return nil, jobrunner.Fail("files.payload_invalid", err)
	}
	inspection, err := handler.api.GetFileInspection(ctx, payload.UploadID)
	if err != nil {
		return nil, apiFailure("files.inspection_unavailable", err)
	}
	if inspection.ItemID != nil && inspection.Status == "completed" {
		return Result{UploadID: payload.UploadID, ItemID: *inspection.ItemID, WorkspaceID: inspection.WorkspaceID}, nil
	}
	if inspection.Status == "cancelled" {
		return nil, jobrunner.ErrCancelled
	}
	if inspection.Status == "failed" {
		return nil, jobrunner.Fail("files.upload_rejected", errors.New("the upload was already rejected"))
	}
	if time.Now().After(inspection.ExpiresAt) {
		return nil, handler.reject(ctx, inspection, "files.upload_expired", errors.New("the upload capability expired"))
	}

	download, err := handler.transfer.Download(ctx, inspection.SourceURL, handler.maxBytes)
	if err != nil {
		if errors.Is(err, objecttransfer.ErrTooLarge) {
			return nil, handler.reject(ctx, inspection, "files.too_large", err)
		}
		return nil, jobrunner.Retry("files.object_unavailable", err)
	}
	temporary, err := worktemp.Create("nix-file-inspection-*")
	if err != nil {
		_ = download.Body.Close()
		return nil, jobrunner.Retry("files.staging_unavailable", err)
	}
	temporaryPath := temporary.Name()
	temporaryOpen := true
	defer func() {
		if temporaryOpen {
			_ = temporary.Close()
		}
		_ = os.Remove(temporaryPath)
	}()
	header := make([]byte, 0, HeaderLimit())
	buffer := make([]byte, 32*1024)
	var total int64
	for {
		count, readErr := download.Body.Read(buffer)
		if count > 0 {
			total += int64(count)
			if _, writeErr := temporary.Write(buffer[:count]); writeErr != nil {
				_ = download.Body.Close()
				_ = temporary.Close()
				return nil, jobrunner.Retry("files.staging_unavailable", writeErr)
			}
			if len(header) < cap(header) {
				copyBytes := min(count, cap(header)-len(header))
				header = append(header, buffer[:copyBytes]...)
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			_ = download.Body.Close()
			if errors.Is(readErr, objecttransfer.ErrTooLarge) {
				return nil, handler.reject(ctx, inspection, "files.too_large", readErr)
			}
			return nil, jobrunner.Retry("files.object_unavailable", readErr)
		}
	}
	if err := download.Body.Close(); err != nil {
		_ = temporary.Close()
		return nil, jobrunner.Retry("files.object_unavailable", err)
	}
	if err := temporary.Close(); err != nil {
		return nil, jobrunner.Retry("files.staging_unavailable", err)
	}
	temporaryOpen = false
	if total != inspection.DeclaredByteLength {
		return nil, handler.reject(ctx, inspection, "files.size_mismatch", fmt.Errorf("declared %d bytes but received %d", inspection.DeclaredByteLength, total))
	}
	metadata := InspectHeader(header, total)
	inspected := workerapi.InspectedFile{
		DetectedMediaType: metadata.MediaType,
		ByteLength:        total,
		SHA256:            hex.EncodeToString(download.Digest.Sum(nil)),
		Previewable:       metadata.Preview,
		PixelWidth:        metadata.Width,
		PixelHeight:       metadata.Height,
	}
	if err := handler.publishObject(ctx, inspection, temporaryPath, inspected); err != nil {
		return nil, err
	}
	handler.attachThumbnail(ctx, payload.UploadID, inspection.FileName, temporaryPath, &inspected)
	published, err := handler.api.PublishFileInspection(ctx, payload.UploadID, inspected)
	if err != nil {
		classified := apiFailure("files.publish_refused", err)
		var typed *jobrunner.JobError
		if errors.As(classified, &typed) && typed.Retryable {
			return nil, classified
		}
		return nil, handler.reject(ctx, inspection, "files.publish_refused", err)
	}
	return Result{
		UploadID: payload.UploadID, ItemID: published.ItemID, WorkspaceID: published.WorkspaceID,
		DetectedMediaType: metadata.MediaType, ByteLength: total, SHA256: inspected.SHA256,
		Previewable:                 metadata.Preview,
		DeclaredMediaTypeConsistent: consistentMediaType(inspection.DeclaredMediaType, metadata.MediaType),
	}, nil
}

func (handler *Handler) reject(ctx context.Context, inspection *workerapi.FileInspection, code string, cause error) error {
	if err := handler.api.RejectFileInspection(ctx, inspection.UploadID, code); err != nil {
		return apiFailure("files.rejection_unavailable", err)
	}
	return jobrunner.Fail(code, cause)
}

func (handler *Handler) publishObject(ctx context.Context, inspection *workerapi.FileInspection, path string, inspected workerapi.InspectedFile) error {
	file, err := os.Open(path)
	if err != nil {
		return jobrunner.Retry("files.staging_unavailable", err)
	}
	uploadErr := handler.transfer.UploadCreateOnly(
		ctx,
		inspection.DestinationUploadURL,
		inspected.DetectedMediaType,
		io.LimitReader(file, inspected.ByteLength),
		inspected.ByteLength,
		inspected.SHA256,
	)
	closeErr := file.Close()
	if closeErr != nil {
		return jobrunner.Retry("files.staging_unavailable", closeErr)
	}
	if uploadErr == nil {
		return nil
	}
	if !errors.Is(uploadErr, objecttransfer.ErrAlreadyExists) {
		return jobrunner.Retry("files.publication_unavailable", uploadErr)
	}
	download, err := handler.transfer.Download(ctx, inspection.DestinationURL, handler.maxBytes)
	if err != nil {
		return jobrunner.Retry("files.publication_unavailable", err)
	}
	written, copyErr := io.Copy(io.Discard, download.Body)
	closeErr = download.Body.Close()
	if copyErr != nil {
		return jobrunner.Retry("files.publication_unavailable", copyErr)
	}
	if closeErr != nil {
		return jobrunner.Retry("files.publication_unavailable", closeErr)
	}
	if written != inspected.ByteLength || objecttransfer.VerifyDigest(download.Digest, inspected.SHA256) != nil {
		return jobrunner.Fail("files.publication_conflict", errors.New("the immutable destination contains different bytes"))
	}
	return nil
}

func decodePayload(raw json.RawMessage) (Payload, error) {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	var payload Payload
	if err := decoder.Decode(&payload); err != nil {
		return Payload{}, err
	}
	if payload.UploadID == "" {
		return Payload{}, errors.New("uploadId is required")
	}
	return payload, nil
}

func consistentMediaType(declared, detected string) bool {
	declared = strings.ToLower(strings.TrimSpace(declared))
	return declared == detected || declared == "application/octet-stream" ||
		detected == "application/zip" && declared == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
}

func apiFailure(code string, err error) error {
	var response *workerapi.ResponseError
	if errors.As(err, &response) && response.Status < 500 && response.Status != 409 {
		return jobrunner.Fail(code, err)
	}
	return jobrunner.Retry(code, err)
}
