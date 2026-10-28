package templatefilecopy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

const (
	Kind      = "template.files.copy"
	pageLimit = 100
)

type Payload struct {
	OwnerKind string `json:"ownerKind"`
	OwnerID   string `json:"ownerId"`
}

type Result struct {
	JobID             string `json:"jobId"`
	OwnerKind         string `json:"ownerKind"`
	OwnerID           string `json:"ownerId"`
	TransfersVerified int    `json:"transfersVerified"`
}

type Handler struct {
	api      *workerapi.Client
	transfer *objecttransfer.Client
}

func New(api *workerapi.Client, transfer *objecttransfer.Client) *Handler {
	return &Handler{api: api, transfer: transfer}
}

func (handler *Handler) Handle(ctx context.Context, job workerapi.Job) (any, error) {
	payload, err := decodePayload(job.Payload)
	if err != nil {
		return nil, jobrunner.Fail("template_file_copy_payload_invalid", err)
	}
	if job.Kind != Kind {
		return nil, jobrunner.Fail("template_file_copy_kind_mismatch", errors.New("job kind is not template.files.copy"))
	}
	if handler.api == nil || handler.transfer == nil {
		return nil, jobrunner.Fail("template_file_copy_configuration_invalid", errors.New("the template file copier is not configured"))
	}
	jobID, _, bound := workerapi.Execution(ctx)
	if !bound || jobID != job.ID {
		return nil, jobrunner.Fail("template_file_copy_execution_invalid", errors.New("the copier is not bound to the claimed execution"))
	}

	var after string
	verified := 0
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		plan, err := handler.api.GetTemplateFileTransferPlan(ctx, job.ID, after, pageLimit)
		if err != nil {
			return nil, apiFailure("template_file_copy_plan_unavailable", err)
		}
		if plan.OwnerKind != payload.OwnerKind || plan.OwnerID != payload.OwnerID {
			return nil, jobrunner.Fail("template_file_copy_plan_invalid", errors.New("Core returned a transfer plan for a different stage"))
		}
		for _, transfer := range plan.Transfers {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if !transfer.Ready {
				if err := handler.copy(ctx, transfer); err != nil {
					if ctx.Err() != nil {
						return nil, ctx.Err()
					}
					return nil, transferFailure("template_file_copy_failed", err)
				}
				// Persist progress as each object is verified. A later large object may fail or
				// exhaust its capability; it must not force already-copied earlier files to repeat.
				if err := handler.api.CompleteTemplateFileTransferBatch(ctx, job.ID, []string{transfer.TransferID}); err != nil {
					return nil, apiFailure("template_file_copy_acknowledgement_failed", err)
				}
			}
			verified++
		}
		if plan.Complete {
			return Result{JobID: job.ID, OwnerKind: payload.OwnerKind, OwnerID: payload.OwnerID, TransfersVerified: verified}, nil
		}
		after = *plan.NextAfterTransferID
	}
}

func (handler *Handler) copy(ctx context.Context, transfer workerapi.TemplateFileTransfer) error {
	if transfer.DownloadURL == nil || transfer.UploadURL == nil || transfer.VerifyURL == nil {
		return errors.New("transfer capabilities are missing")
	}
	if err := handler.verify(ctx, *transfer.VerifyURL, transfer.ByteLength, transfer.SHA256); err == nil {
		// A prior execution may have completed the immutable PUT and lost its Core acknowledgement.
		// Verify the target first so a deleted source cannot strand a valid independent copy.
		return nil
	} else if !errors.Is(err, objecttransfer.ErrNotFound) {
		return err
	}
	limit := transfer.ByteLength
	if limit == 0 {
		limit = 1
	}
	source, err := handler.transfer.Download(ctx, *transfer.DownloadURL, limit)
	if err != nil {
		return fmt.Errorf("download source object: %w", err)
	}
	defer source.Body.Close()
	if err := handler.transfer.UploadCreateOnlyVerified(
		ctx,
		*transfer.UploadURL,
		transfer.MediaType,
		source.Body,
		transfer.ByteLength,
		transfer.SHA256,
	); err != nil {
		if !errors.Is(err, objecttransfer.ErrAlreadyExists) {
			return fmt.Errorf("write immutable destination object: %w", err)
		}
	} else if err := objecttransfer.VerifyDigest(source.Digest, transfer.SHA256); err != nil {
		return fmt.Errorf("source digest does not match the declared file: %w", err)
	}
	// Whether this was the first attempt or a retry after a completed PUT, the exact object
	// named by the capability must prove both its declared length and digest before Core records it.
	return handler.verify(ctx, *transfer.VerifyURL, transfer.ByteLength, transfer.SHA256)
}

func (handler *Handler) verify(ctx context.Context, rawURL string, expectedLength int64, expectedDigest string) error {
	maximum := expectedLength
	if maximum == 0 {
		maximum = 1
	}
	verified, err := handler.transfer.Download(ctx, rawURL, maximum)
	if err != nil {
		return fmt.Errorf("read destination for verification: %w", err)
	}
	defer verified.Body.Close()
	count, err := io.Copy(io.Discard, verified.Body)
	if err != nil {
		return fmt.Errorf("stream destination verification: %w", err)
	}
	if count != expectedLength {
		return errors.New("destination length does not match the declared file")
	}
	if err := objecttransfer.VerifyDigest(verified.Digest, expectedDigest); err != nil {
		return fmt.Errorf("destination digest does not match the declared file: %w", err)
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
	if err := requirePayloadEOF(decoder); err != nil {
		return Payload{}, err
	}
	if payload.OwnerKind != "operation" && payload.OwnerKind != "application" || !validUUID(payload.OwnerID) {
		return Payload{}, errors.New("template file copy owner is invalid")
	}
	return payload, nil
}

func requirePayloadEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("template file copy payload contains multiple JSON values")
		}
		return err
	}
	return nil
}

func validUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for index, character := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			continue
		}
		if character < '0' || character > '9' && character < 'a' || character > 'f' {
			return false
		}
	}
	return value != "00000000-0000-0000-0000-000000000000"
}

func apiFailure(code string, err error) error {
	var response *workerapi.ResponseError
	if errors.As(err, &response) && response.Status == 409 {
		return err
	}
	if errors.As(err, &response) && response.Status < 500 && response.Status != 429 {
		return jobrunner.Fail(code, err)
	}
	return jobrunner.Retry(code, err)
}

func transferFailure(code string, err error) error {
	// A mismatching immutable object is a durable conflict. Other capability and transport
	// failures can recover after Core issues a fresh bounded capability on the next execution.
	if strings.Contains(err.Error(), "does not match") {
		return jobrunner.Fail(code, err)
	}
	return jobrunner.Retry(code, err)
}

var _ jobrunner.Handler = (*Handler)(nil)
