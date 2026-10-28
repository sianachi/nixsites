package objectcleanup

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

var Kinds = []string{"object.cleanup"}

type Payload struct {
	OwnerKind  string    `json:"ownerKind"`
	OwnerID    string    `json:"ownerId"`
	NotBefore  time.Time `json:"notBefore"`
	ObjectKeys []string  `json:"objectKeys"`
}

type Result struct {
	OwnerKind string `json:"ownerKind"`
	OwnerID   string `json:"ownerId"`
	Deleted   int    `json:"deleted"`
}

type Handler struct {
	api      *workerapi.Client
	transfer *objecttransfer.Client
	clock    func() time.Time
}

func New(api *workerapi.Client, transfer *objecttransfer.Client) *Handler {
	return &Handler{api: api, transfer: transfer, clock: time.Now}
}

func (handler *Handler) Handle(ctx context.Context, job workerapi.Job) (any, error) {
	if job.Kind != "object.cleanup" {
		return nil, jobrunner.Fail("cleanup_kind_mismatch", errors.New("job kind is not object.cleanup"))
	}
	payload, err := decodePayload(job.Payload)
	if err != nil {
		return nil, jobrunner.Fail("cleanup_payload_invalid", err)
	}
	if handler.clock().Before(payload.NotBefore) {
		return nil, jobrunner.Retry("cleanup_not_ready", errors.New("the cleanup safety delay has not elapsed"))
	}

	offset, deleted := 0, 0
	for {
		capability, err := handler.api.GetObjectCleanupCapability(ctx, offset)
		if err != nil {
			return nil, apiFailure("cleanup_capability_unavailable", err)
		}
		if capability.OwnerKind != payload.OwnerKind || capability.OwnerID != payload.OwnerID || !capability.NotBefore.Equal(payload.NotBefore) {
			return nil, jobrunner.Fail("cleanup_capability_invalid", errors.New("Core returned cleanup capabilities for a different owner"))
		}
		for _, target := range capability.DeleteURLs {
			if err := handler.transfer.Delete(ctx, target); err != nil {
				return nil, jobrunner.Retry("cleanup_object_unavailable", err)
			}
			deleted++
		}
		if capability.NextOffset == nil {
			break
		}
		if *capability.NextOffset <= offset || *capability.NextOffset > len(payload.ObjectKeys) {
			return nil, jobrunner.Fail("cleanup_capability_invalid", errors.New("Core returned an invalid cleanup cursor"))
		}
		offset = *capability.NextOffset
	}
	if deleted != len(payload.ObjectKeys) {
		return nil, jobrunner.Fail("cleanup_capability_invalid", errors.New("Core returned an incomplete cleanup target set"))
	}
	if payload.OwnerKind == "workspace-purge" {
		if err := handler.api.FinalizeWorkspacePurge(ctx); err != nil {
			return nil, apiFailure("workspace_purge_finalize_unavailable", err)
		}
	}
	return Result{OwnerKind: payload.OwnerKind, OwnerID: payload.OwnerID, Deleted: deleted}, nil
}

func decodePayload(raw json.RawMessage) (Payload, error) {
	payload, err := jobrunner.DecodeStrict[Payload](raw)
	if err != nil {
		return Payload{}, err
	}
	if payload.OwnerKind == "" || len(payload.OwnerKind) > 80 || payload.OwnerID == "" || payload.NotBefore.IsZero() || len(payload.ObjectKeys) > 10_002 {
		return Payload{}, errors.New("cleanup payload is incomplete")
	}
	return payload, nil
}

func apiFailure(code string, err error) error {
	var response *workerapi.ResponseError
	if errors.As(err, &response) && response.Status == 409 {
		return err
	}
	if errors.As(err, &response) && response.Status < 500 {
		return jobrunner.Fail(code, err)
	}
	return jobrunner.Retry(code, err)
}

var _ jobrunner.Handler = (*Handler)(nil)
