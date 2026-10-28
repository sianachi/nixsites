package jobrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"

	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

var ErrCancelled = errors.New("job cancellation was requested")

type Handler interface {
	Handle(context.Context, workerapi.Job) (any, error)
}

type JobError struct {
	Code      string
	Detail    string
	Cause     error
	Retryable bool
}

func (err *JobError) Error() string {
	if err.Detail != "" {
		return err.Detail
	}
	if err.Cause != nil {
		return err.Cause.Error()
	}
	return err.Code
}

func (err *JobError) Unwrap() error { return err.Cause }

// Fail wraps err as a permanent job failure with a stable code.
func Fail(code string, err error) error {
	return &JobError{Code: code, Detail: err.Error(), Cause: err}
}

// Retry wraps err as a failure the queue should redeliver.
func Retry(code string, err error) error {
	return &JobError{Code: code, Detail: err.Error(), Cause: err, Retryable: true}
}

// DecodeStrict decodes a job payload, rejecting fields the payload type does not declare.
func DecodeStrict[T any](raw json.RawMessage) (T, error) {
	var payload T
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	err := decoder.Decode(&payload)
	return payload, err
}
