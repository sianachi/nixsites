package jobrunner

import (
	"context"
	"errors"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

type fakeHandler struct {
	result   string
	received *workerapi.Job
}

func (handler *fakeHandler) Handle(_ context.Context, job workerapi.Job) (any, error) {
	handler.received = &job
	return handler.result, nil
}

func TestNewRouterRejectsInvalidRoutes(t *testing.T) {
	cases := map[string]map[string]Handler{
		"empty map":       {},
		"empty kind":      {"": &fakeHandler{}},
		"nil handler":     {"import": nil},
		"nil map literal": nil,
	}
	for name, handlers := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := NewRouter(handlers); err == nil {
				t.Fatal("NewRouter error = nil, want error")
			}
		})
	}
}

func TestRouterHandleRoutesByKind(t *testing.T) {
	imports := &fakeHandler{result: "imported"}
	exports := &fakeHandler{result: "exported"}
	handlers := map[string]Handler{"import": imports, "export": exports}
	router, err := NewRouter(handlers)
	if err != nil {
		t.Fatal(err)
	}
	// Later edits to the caller's map must not change routing.
	handlers["import"] = exports
	delete(handlers, "export")

	got, err := router.Handle(context.Background(), workerapi.Job{ID: "j1", Kind: "import"})
	if err != nil || got != "imported" {
		t.Fatalf("Handle(import) = %v, %v", got, err)
	}
	if imports.received == nil || imports.received.ID != "j1" {
		t.Fatalf("import handler received %v", imports.received)
	}
	got, err = router.Handle(context.Background(), workerapi.Job{Kind: "export"})
	if err != nil || got != "exported" {
		t.Fatalf("Handle(export) = %v, %v", got, err)
	}
}

func TestRouterHandleUnknownKind(t *testing.T) {
	router, err := NewRouter(map[string]Handler{"import": &fakeHandler{}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = router.Handle(context.Background(), workerapi.Job{Kind: "bogus"})
	var jobErr *JobError
	if !errors.As(err, &jobErr) || jobErr.Code != "worker_kind_unsupported" {
		t.Fatalf("Handle(bogus) error = %v, want JobError worker_kind_unsupported", err)
	}
}

func TestJobErrorErrorAndUnwrap(t *testing.T) {
	cause := errors.New("boom")
	cases := []struct {
		name       string
		err        *JobError
		wantText   string
		wantUnwrap error
	}{
		{"detail wins", &JobError{Code: "c", Detail: "d", Cause: cause}, "d", cause},
		{"cause only", &JobError{Code: "c", Cause: cause}, "boom", cause},
		{"code only", &JobError{Code: "c"}, "c", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.err.Error(); got != tc.wantText {
				t.Fatalf("Error() = %q, want %q", got, tc.wantText)
			}
			if got := errors.Unwrap(tc.err); got != tc.wantUnwrap {
				t.Fatalf("Unwrap() = %v, want %v", got, tc.wantUnwrap)
			}
		})
	}
}
