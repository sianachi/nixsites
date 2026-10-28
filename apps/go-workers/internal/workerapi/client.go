package workerapi

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
	"github.com/sianachi/Nix/apps/go-workers/internal/pluginworker"
)

var ErrResponseTooLarge = errors.New("worker API response exceeds its size limit")

type Client struct {
	baseURL, secret, owner string
	httpClient             *http.Client
}

type executionContextKey struct{}

type executionContext struct {
	jobID       string
	executionID string
}

// WithExecution binds domain API requests to the exact live lease handling the job.
func WithExecution(ctx context.Context, jobID, executionID string) context.Context {
	return context.WithValue(ctx, executionContextKey{}, executionContext{jobID: jobID, executionID: executionID})
}

func Execution(ctx context.Context) (jobID, executionID string, ok bool) {
	execution, ok := ctx.Value(executionContextKey{}).(executionContext)
	if !ok {
		return "", "", false
	}
	return execution.jobID, execution.executionID, true
}

type Job struct {
	ID                    string          `json:"id"`
	TenantID              string          `json:"tenantId"`
	WorkspaceID           *string         `json:"workspaceId"`
	ActorID               *string         `json:"actorId"`
	Kind                  string          `json:"kind"`
	Payload               json.RawMessage `json:"payload"`
	Attempts              int             `json:"attempts"`
	CancellationRequested bool            `json:"cancellationRequested"`
}

// UnmarshalJSON accepts the dispatch contract's legacy string-encoded payload
// as well as a native JSON value. Core stores payloads as JSON text, and the
// current internal response contract exposes that text as a JSON string.
// Normalizing it here keeps every worker handler on the same payload shape.
func (job *Job) UnmarshalJSON(data []byte) error {
	type wireJob Job
	var value struct {
		ID                    string          `json:"id"`
		TenantID              string          `json:"tenantId"`
		WorkspaceID           *string         `json:"workspaceId"`
		ActorID               *string         `json:"actorId"`
		Kind                  string          `json:"kind"`
		Payload               json.RawMessage `json:"payload"`
		Attempts              int             `json:"attempts"`
		CancellationRequested bool            `json:"cancellationRequested"`
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	payload, err := unwrapJSONText(value.Payload)
	if err != nil {
		return fmt.Errorf("decode job payload: %w", err)
	}
	*job = Job(wireJob{
		ID: value.ID, TenantID: value.TenantID, WorkspaceID: value.WorkspaceID,
		ActorID: value.ActorID, Kind: value.Kind, Payload: payload,
		Attempts: value.Attempts, CancellationRequested: value.CancellationRequested,
	})
	return nil
}

type OutboxEvent struct {
	ID          string          `json:"id"`
	TenantID    string          `json:"tenantId"`
	WorkspaceID *string         `json:"workspaceId"`
	ItemID      *string         `json:"itemId"`
	Kind        string          `json:"kind"`
	Payload     json.RawMessage `json:"payload"`
	Attempts    int             `json:"attempts"`
	AvailableAt time.Time       `json:"availableAt"`
}

// UnmarshalJSON mirrors Job so outbox consumers receive the same canonical
// payload representation regardless of which Core response serializer they
// are talking to.
func (event *OutboxEvent) UnmarshalJSON(data []byte) error {
	type wireEvent OutboxEvent
	var value struct {
		ID          string          `json:"id"`
		TenantID    string          `json:"tenantId"`
		WorkspaceID *string         `json:"workspaceId"`
		ItemID      *string         `json:"itemId"`
		Kind        string          `json:"kind"`
		Payload     json.RawMessage `json:"payload"`
		Attempts    int             `json:"attempts"`
		AvailableAt time.Time       `json:"availableAt"`
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	payload, err := unwrapJSONText(value.Payload)
	if err != nil {
		return fmt.Errorf("decode outbox payload: %w", err)
	}
	*event = OutboxEvent(wireEvent{
		ID: value.ID, TenantID: value.TenantID, WorkspaceID: value.WorkspaceID,
		ItemID: value.ItemID, Kind: value.Kind, Payload: payload,
		Attempts: value.Attempts, AvailableAt: value.AvailableAt,
	})
	return nil
}

func unwrapJSONText(raw json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, errors.New("payload is missing")
	}
	if trimmed[0] != '"' {
		if !json.Valid(trimmed) {
			return nil, errors.New("payload is not valid JSON")
		}
		return append(json.RawMessage(nil), trimmed...), nil
	}
	var encoded string
	if err := json.Unmarshal(trimmed, &encoded); err != nil {
		return nil, fmt.Errorf("payload text is invalid: %w", err)
	}
	decoded := []byte(encoded)
	if !json.Valid(decoded) {
		return nil, errors.New("payload text is not valid JSON")
	}
	return decoded, nil
}

type JobState struct {
	Status                string     `json:"status"`
	CancellationRequested bool       `json:"cancellationRequested"`
	LeaseOwned            bool       `json:"leaseOwned"`
	LeaseUntil            *time.Time `json:"leaseUntil"`
}

type FileInspection struct {
	UploadID             string    `json:"uploadId"`
	WorkspaceID          string    `json:"workspaceId"`
	Status               string    `json:"status"`
	FileName             string    `json:"fileName"`
	DeclaredMediaType    string    `json:"declaredMediaType"`
	DeclaredByteLength   int64     `json:"declaredByteLength"`
	ExpiresAt            time.Time `json:"expiresAt"`
	SourceURL            string    `json:"sourceUrl"`
	SourceDeleteURL      string    `json:"sourceDeleteUrl"`
	DestinationURL       string    `json:"destinationUrl"`
	DestinationUploadURL string    `json:"destinationUploadUrl"`
	DestinationDeleteURL string    `json:"destinationDeleteUrl"`
	CapabilityExpires    time.Time `json:"capabilityExpiresAt"`
	ItemID               *string   `json:"itemId"`
}

type InspectedFile struct {
	DetectedMediaType string `json:"detectedMediaType"`
	ByteLength        int64  `json:"byteLength"`
	SHA256            string `json:"sha256"`
	Previewable       bool   `json:"previewable"`
	PixelWidth        *int   `json:"pixelWidth"`
	PixelHeight       *int   `json:"pixelHeight"`
	// The thumbnail facts are null together when the file has none. Core derives the thumbnail's
	// object key itself; the worker only reports what it uploaded to the capability Core signed.
	ThumbnailWidth  *int   `json:"thumbnailWidth"`
	ThumbnailHeight *int   `json:"thumbnailHeight"`
	ThumbnailBytes  *int64 `json:"thumbnailBytes"`
}

type PublishedFile struct {
	ItemID      string `json:"itemId"`
	WorkspaceID string `json:"workspaceId"`
}

type ObjectCleanupCapability struct {
	OwnerKind  string    `json:"ownerKind"`
	OwnerID    string    `json:"ownerId"`
	NotBefore  time.Time `json:"notBefore"`
	DeleteURLs []string  `json:"deleteUrls"`
	NextOffset *int      `json:"nextOffset"`
}

// TemplateFileTransferPlan is one fenced page of immutable source-to-stage copies.
type TemplateFileTransferPlan struct {
	JobID               string                 `json:"jobId"`
	OwnerKind           string                 `json:"ownerKind"`
	OwnerID             string                 `json:"ownerId"`
	Transfers           []TemplateFileTransfer `json:"transfers"`
	ObservedAt          time.Time              `json:"observedAt"`
	NextAfterTransferID *string                `json:"nextAfterTransferId"`
	Complete            bool                   `json:"complete"`
}

type TemplateFileTransfer struct {
	TransferID    string  `json:"transferId"`
	SourceItemID  string  `json:"sourceItemId"`
	TargetItemID  string  `json:"targetItemId"`
	TargetVersion int     `json:"targetVersion"`
	DownloadURL   *string `json:"downloadUrl"`
	UploadURL     *string `json:"uploadUrl"`
	VerifyURL     *string `json:"verifyUrl"`
	FileName      string  `json:"fileName"`
	MediaType     string  `json:"mediaType"`
	ByteLength    int64   `json:"byteLength"`
	SHA256        string  `json:"sha256"`
	Ready         bool    `json:"ready"`
}

type CompleteTemplateFileTransferBatch struct {
	TransferIDs []string `json:"transferIds"`
}

type DocumentImportPreview struct {
	ImportID           string    `json:"importId"`
	Format             string    `json:"format"`
	Title              string    `json:"title"`
	FileName           string    `json:"fileName"`
	DeclaredMediaType  string    `json:"declaredMediaType"`
	DeclaredByteLength int64     `json:"declaredByteLength"`
	SourceURL          string    `json:"sourceUrl"`
	SourceDeleteURL    string    `json:"sourceDeleteUrl"`
	PlanUploadURL      string    `json:"planUploadUrl"`
	PlanDeleteURL      string    `json:"planDeleteUrl"`
	CapabilityExpires  time.Time `json:"capabilityExpiresAt"`
}

type DocumentImportCommit struct {
	ImportID           string    `json:"importId"`
	Format             string    `json:"format"`
	Title              string    `json:"title"`
	FileName           string    `json:"fileName"`
	DeclaredMediaType  string    `json:"declaredMediaType"`
	DeclaredByteLength int64     `json:"declaredByteLength"`
	PlanSHA256         string    `json:"planSha256"`
	PlanByteLength     int64     `json:"planByteLength"`
	SourceSHA256       string    `json:"sourceSha256"`
	SourceURL          string    `json:"sourceUrl"`
	SourceDeleteURL    string    `json:"sourceDeleteUrl"`
	PlanURL            string    `json:"planUrl"`
	PlanDeleteURL      string    `json:"planDeleteUrl"`
	CapabilityExpires  time.Time `json:"capabilityExpiresAt"`
}

type CompleteDocumentImportPreview struct {
	PlanSHA256     string   `json:"planSha256"`
	PlanByteLength int64    `json:"planByteLength"`
	SourceSHA256   string   `json:"sourceSha256"`
	ItemCount      int      `json:"itemCount"`
	AssetCount     int      `json:"assetCount"`
	Loss           []string `json:"loss"`
	Omissions      []string `json:"omissions"`
}

type DocumentImportFile struct {
	SourceKind  string  `json:"sourceKind"`
	AssetPath   *string `json:"assetPath,omitempty"`
	FileName    string  `json:"fileName"`
	MediaType   string  `json:"mediaType"`
	ByteLength  int64   `json:"byteLength"`
	SHA256      string  `json:"sha256"`
	Previewable bool    `json:"previewable"`
	PixelWidth  *int    `json:"pixelWidth,omitempty"`
	PixelHeight *int    `json:"pixelHeight,omitempty"`
}

type DocumentImportStageItem struct {
	SourceID            string              `json:"sourceId"`
	ParentSourceID      *string             `json:"parentSourceId"`
	Order               int                 `json:"order"`
	Title               string              `json:"title"`
	ItemType            string              `json:"itemType"`
	Properties          json.RawMessage     `json:"properties,omitempty"`
	Schema              json.RawMessage     `json:"schema,omitempty"`
	Views               json.RawMessage     `json:"views,omitempty"`
	FinalLifecycleState string              `json:"finalLifecycleState"`
	BodyRequired        bool                `json:"bodyRequired"`
	File                *DocumentImportFile `json:"file,omitempty"`
}

type DocumentImportStageRequest struct {
	PlanSHA256   string                    `json:"planSha256"`
	SourceSHA256 string                    `json:"sourceSha256"`
	Items        []DocumentImportStageItem `json:"items"`
	FileVersions []TemplateImportStageFile `json:"fileVersions,omitempty"`
}

type DocumentImportStage struct {
	ImportID      string                              `json:"importId"`
	RootItemID    string                              `json:"rootItemId"`
	Items         []DocumentImportStageMapping        `json:"items"`
	FileTransfers []TemplateImportFileTransferMapping `json:"fileTransfers"`
}

type DocumentImportStageMapping struct {
	SourceID     string `json:"sourceId"`
	TargetItemID string `json:"targetItemId"`
	ItemType     string `json:"itemType"`
	BodyRequired bool   `json:"bodyRequired"`
	ObjectReady  bool   `json:"objectReady"`
}

type DocumentImportObjectCapability struct {
	SourceID          string    `json:"sourceId"`
	URL               string    `json:"url"`
	UploadURL         string    `json:"uploadUrl"`
	DeleteURL         string    `json:"deleteUrl"`
	CapabilityExpires time.Time `json:"capabilityExpiresAt"`
}

type DocumentImportResult struct {
	ID         string  `json:"id"`
	Status     string  `json:"status"`
	RootItemID *string `json:"rootItemId"`
}

type TemplateImportProfile struct {
	Kind            string          `json:"kind"`
	Version         int             `json:"version"`
	Key             string          `json:"key"`
	Name            string          `json:"name"`
	Description     string          `json:"description"`
	IncludeBody     bool            `json:"includeBody"`
	IncludeChildren bool            `json:"includeChildren"`
	Initialization  json.RawMessage `json:"initialization,omitempty"`
}

type TemplateImportPreview struct {
	ImportID           string    `json:"importId"`
	WorkspaceID        string    `json:"workspaceId"`
	Origin             string    `json:"origin"`
	ManagedSource      *string   `json:"managedSource"`
	IdempotencyKey     string    `json:"idempotencyKey"`
	FileName           string    `json:"fileName"`
	DeclaredMediaType  string    `json:"declaredMediaType"`
	DeclaredByteLength int64     `json:"declaredByteLength"`
	SourceURL          string    `json:"sourceUrl"`
	SourceDeleteURL    string    `json:"sourceDeleteUrl"`
	PlanUploadURL      string    `json:"planUploadUrl"`
	PlanDeleteURL      string    `json:"planDeleteUrl"`
	CapabilityExpires  time.Time `json:"capabilityExpiresAt"`
}

type TemplateImportCommit struct {
	ImportID           string                `json:"importId"`
	WorkspaceID        string                `json:"workspaceId"`
	Origin             string                `json:"origin"`
	ManagedSource      *string               `json:"managedSource"`
	IdempotencyKey     string                `json:"idempotencyKey"`
	FileName           string                `json:"fileName"`
	DeclaredMediaType  string                `json:"declaredMediaType"`
	DeclaredByteLength int64                 `json:"declaredByteLength"`
	SourceURL          string                `json:"sourceUrl"`
	SourceDeleteURL    string                `json:"sourceDeleteUrl"`
	PlanUploadURL      string                `json:"planUploadUrl"`
	PlanDeleteURL      string                `json:"planDeleteUrl"`
	CapabilityExpires  time.Time             `json:"capabilityExpiresAt"`
	PlanSHA256         string                `json:"planSha256"`
	PlanByteLength     int64                 `json:"planByteLength"`
	SourceSHA256       string                `json:"sourceSha256"`
	PlanURL            string                `json:"planUrl"`
	CompletedResult    *TemplateImportResult `json:"completedResult"`
}

type CompleteTemplateImportPreview struct {
	Profile        TemplateImportProfile `json:"profile"`
	RootItemType   string                `json:"rootItemType"`
	ItemCount      int                   `json:"itemCount"`
	BodyCount      int                   `json:"bodyCount"`
	ViewCount      int                   `json:"viewCount"`
	SourceSHA256   string                `json:"sourceSha256"`
	PlanSHA256     string                `json:"planSha256"`
	PlanByteLength int64                 `json:"planByteLength"`
}

type TemplateImportStageItem struct {
	SourceID       string          `json:"sourceId"`
	ParentSourceID *string         `json:"parentSourceId"`
	Sequence       string          `json:"seq"`
	Title          string          `json:"title"`
	ItemType       string          `json:"itemType"`
	Properties     json.RawMessage `json:"properties"`
	Schema         json.RawMessage `json:"schema"`
	Views          json.RawMessage `json:"views"`
	HasBody        bool            `json:"hasBody"`
	Recurrence     json.RawMessage `json:"recurrence,omitempty"`
}

type TemplateImportStageRequest struct {
	Profile TemplateImportProfile     `json:"profile"`
	Items   []TemplateImportStageItem `json:"items"`
	Files   []TemplateImportStageFile `json:"files"`
}

type TemplateImportStageFile struct {
	SourceItemID string `json:"sourceItemId"`
	Version      int    `json:"version"`
	FileName     string `json:"fileName"`
	MediaType    string `json:"mediaType"`
	ByteLength   int64  `json:"byteLength"`
	SHA256       string `json:"sha256"`
	Previewable  bool   `json:"previewable"`
	PixelWidth   *int   `json:"pixelWidth"`
	PixelHeight  *int   `json:"pixelHeight"`
}

type TemplateImportBodyWrite struct {
	SourceID     string `json:"sourceId"`
	TargetItemID string `json:"targetItemId"`
	ItemType     string `json:"itemType"`
}

type TemplateImportStage struct {
	ImportID      string                              `json:"importId"`
	OperationID   *string                             `json:"operationId"`
	TemplateID    string                              `json:"templateId"`
	StableKey     string                              `json:"stableKey"`
	Digest        string                              `json:"digest"`
	Unchanged     bool                                `json:"unchanged"`
	ItemMappings  []TemplateImportBodyWrite           `json:"itemMappings"`
	BodyWrites    []TemplateImportBodyWrite           `json:"bodyWrites"`
	FileTransfers []TemplateImportFileTransferMapping `json:"fileTransfers"`
}

type TemplateImportFileTransferMapping struct {
	TransferID    string `json:"transferId"`
	SourceItemID  string `json:"sourceItemId"`
	TargetItemID  string `json:"targetItemId"`
	TargetVersion int    `json:"targetVersion"`
}

type TemplateImportFilePlan struct {
	ImportID            string                         `json:"importId"`
	Files               []TemplateImportFileCapability `json:"files"`
	NextAfterTransferID *string                        `json:"nextAfterTransferId"`
	Complete            bool                           `json:"complete"`
}

type TemplateImportFileCapability struct {
	TransferID    string  `json:"transferId"`
	SourceItemID  string  `json:"sourceItemId"`
	TargetItemID  string  `json:"targetItemId"`
	TargetVersion int     `json:"targetVersion"`
	FileName      string  `json:"fileName"`
	MediaType     string  `json:"mediaType"`
	ByteLength    int64   `json:"byteLength"`
	SHA256        string  `json:"sha256"`
	UploadURL     *string `json:"uploadUrl"`
	VerifyURL     *string `json:"verifyUrl"`
	Ready         bool    `json:"ready"`
}

type CompleteTemplateImportRequest struct {
	WrittenTargetItemIDs []string `json:"writtenTargetItemIds"`
}

type TemplateImportResult struct {
	ImportID             string   `json:"importId"`
	OperationID          *string  `json:"operationId"`
	TemplateID           string   `json:"templateId"`
	StableKey            string   `json:"stableKey"`
	Digest               string   `json:"digest"`
	Unchanged            bool     `json:"unchanged"`
	ItemCount            int      `json:"itemCount"`
	BodyCount            int      `json:"bodyCount"`
	WrittenTargetItemIDs []string `json:"writtenTargetItemIds"`
}

type ExportSource struct {
	ExportID          string    `json:"exportId"`
	Format            string    `json:"format"`
	SourceURL         string    `json:"sourceUrl"`
	BearerToken       string    `json:"bearerToken"`
	DelegationExpires time.Time `json:"delegationExpiresAt"`
}

type ExportDestination struct {
	ExportID          string    `json:"exportId"`
	AttemptID         string    `json:"attemptId"`
	Format            string    `json:"format"`
	ObjectKey         string    `json:"objectKey"`
	UploadURL         string    `json:"uploadUrl"`
	ReadURL           string    `json:"readUrl"`
	DeleteURL         string    `json:"deleteUrl"`
	CapabilityExpires time.Time `json:"capabilityExpiresAt"`
}

type ResponseError struct {
	Status int
	Path   string
	Code   string
}

func (err *ResponseError) Error() string {
	return fmt.Sprintf("worker API request to %s returned %d", err.Path, err.Status)
}

func (err *ResponseError) StatusCode() int { return err.Status }

func New(baseURL, secret, owner string, timeout time.Duration) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		secret:  secret,
		owner:   owner,
		httpClient: &http.Client{
			Timeout:       timeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

func (client *Client) Ping(ctx context.Context) error {
	// A public liveness probe proves only that Nix.Api is listening. Readiness must also prove that
	// this worker's service credential is accepted and that the dispatch store is available. This
	// kind cannot be created by the job API, so the probe can never consume application work.
	jobs, err := client.LeaseJobs(ctx, "readiness.probe", 1)
	if err != nil {
		return fmt.Errorf("worker API dispatch probe failed: %w", err)
	}
	if len(jobs) != 0 {
		return errors.New("worker API dispatch probe returned an impossible job kind")
	}
	return nil
}

func (client *Client) PreparePluginEvent(ctx context.Context, event broker.WorkspaceEvent, leaseSeconds int) (pluginworker.Preparation, error) {
	if !broker.IsCanonicalUUID(event.MessageID) || !broker.IsCanonicalUUID(event.TenantID) || !broker.IsCanonicalUUID(event.WorkspaceID) || !broker.IsCanonicalUUID(event.ItemID) || leaseSeconds < 5 || leaseSeconds > 300 {
		return pluginworker.Preparation{}, errors.New("plugin event preparation request is invalid")
	}
	causationID := event.MessageID
	if event.CausationID != nil {
		causationID = *event.CausationID
	}
	body, err := json.Marshal(struct {
		TenantID         string `json:"tenantId"`
		WorkspaceID      string `json:"workspaceId"`
		ItemID           string `json:"itemId"`
		Kind             string `json:"kind"`
		AggregateVersion *int64 `json:"aggregateVersion,omitempty"`
		CausationID      string `json:"causationId"`
		CausationDepth   int    `json:"causationDepth"`
		LeaseSeconds     int    `json:"leaseSeconds"`
	}{event.TenantID, event.WorkspaceID, event.ItemID, event.Kind, event.AggregateVersion, causationID, event.CausationDepth, leaseSeconds})
	if err != nil {
		return pluginworker.Preparation{}, err
	}
	path := "/internal/worker-dispatch/plugins/events/" + url.PathEscape(event.MessageID) + "/prepare"
	var preparation pluginworker.Preparation
	if err := client.requestStrictJSON(ctx, http.MethodPost, path, bytes.NewReader(body), &preparation, 512<<10); err != nil {
		return pluginworker.Preparation{}, err
	}
	switch preparation.Outcome {
	case "prepared":
		if len(preparation.Plans) == 0 || len(preparation.Plans) > 128 {
			return pluginworker.Preparation{}, errors.New("worker API plugin plans are invalid")
		}
	case "busy", "settled":
		if len(preparation.Plans) != 0 {
			return pluginworker.Preparation{}, errors.New("worker API plugin outcome contains unexpected plans")
		}
	default:
		return pluginworker.Preparation{}, errors.New("worker API plugin preparation outcome is invalid")
	}
	for _, plan := range preparation.Plans {
		if !broker.IsCanonicalUUID(plan.InvocationID) || !broker.IsCanonicalUUID(plan.InstallationID) || plan.Attempt < 1 || plan.Attempt > 5 || plan.LeaseUntil.IsZero() || plan.Component.ID == "" || plan.Component.Version == "" || len(plan.Component.PublicKey) != 32 || len(plan.Component.Signature) != 64 || plan.Component.ByteLength <= 0 || plan.Component.ByteLength > 8<<20 || plan.Component.DownloadURL == "" || plan.Component.DownloadExpiresAt.IsZero() {
			return pluginworker.Preparation{}, errors.New("worker API plugin invocation plan is invalid")
		}
	}
	return preparation, nil
}

func (client *Client) CallPluginHost(ctx context.Context, invocationID, capability string, payload json.RawMessage) (json.RawMessage, error) {
	if !broker.IsCanonicalUUID(invocationID) || capability == "" || len(capability) > 64 || len(payload) == 0 || len(payload) > 64<<10 || !json.Valid(payload) {
		return nil, errors.New("plugin host call request is invalid")
	}
	body, err := json.Marshal(struct {
		Capability string          `json:"capability"`
		Request    json.RawMessage `json:"request"`
	}{capability, payload})
	if err != nil {
		return nil, err
	}
	path := "/internal/worker-dispatch/plugins/invocations/" + url.PathEscape(invocationID) + "/host-calls"
	var response struct {
		Result json.RawMessage `json:"result"`
	}
	if err := client.requestStrictJSON(ctx, http.MethodPost, path, bytes.NewReader(body), &response, 256<<10); err != nil {
		return nil, err
	}
	if len(response.Result) == 0 || !json.Valid(response.Result) {
		return nil, errors.New("worker API plugin host response is invalid")
	}
	return append(json.RawMessage(nil), response.Result...), nil
}

func (client *Client) CompletePluginInvocation(ctx context.Context, invocationID string, completion pluginworker.Completion) (pluginworker.CompletionResult, error) {
	if !broker.IsCanonicalUUID(invocationID) {
		return pluginworker.CompletionResult{}, errors.New("plugin completion identity is invalid")
	}
	body, err := json.Marshal(completion)
	if err != nil {
		return pluginworker.CompletionResult{}, err
	}
	path := "/internal/worker-dispatch/plugins/invocations/" + url.PathEscape(invocationID) + "/complete"
	var result pluginworker.CompletionResult
	if err := client.requestStrictJSON(ctx, http.MethodPost, path, bytes.NewReader(body), &result, 64<<10); err != nil {
		return pluginworker.CompletionResult{}, err
	}
	if result.Outcome != "applied" && result.Outcome != "replayed" {
		return pluginworker.CompletionResult{}, errors.New("worker API plugin completion outcome is invalid")
	}
	return result, nil
}

func (client *Client) LeaseJobs(ctx context.Context, kind string, limit int) ([]Job, error) {
	var jobs []Job
	if err := client.lease(ctx, "/internal/worker-dispatch/jobs/lease", kind, limit, &jobs); err != nil {
		return nil, err
	}
	return jobs, nil
}

func (client *Client) ClaimJob(ctx context.Context, id, executionID string, leaseSeconds int) (*Job, error) {
	body, err := json.Marshal(struct {
		Owner        string `json:"owner"`
		LeaseSeconds int    `json:"leaseSeconds"`
	}{executionID, leaseSeconds})
	if err != nil {
		return nil, err
	}
	request, err := client.newRequest(ctx, http.MethodPost, "/internal/worker-dispatch/jobs/"+id+"/claim", strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusConflict {
		return nil, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("worker API claim returned %s", response.Status)
	}
	var job Job
	if err := json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(&job); err != nil {
		return nil, err
	}
	return &job, nil
}

func (client *Client) RenewJob(ctx context.Context, id, executionID string, leaseSeconds int) (bool, error) {
	body, err := json.Marshal(struct {
		Owner        string `json:"owner"`
		LeaseSeconds int    `json:"leaseSeconds"`
	}{executionID, leaseSeconds})
	if err != nil {
		return false, err
	}
	request, err := client.newRequest(ctx, http.MethodPost, "/internal/worker-dispatch/jobs/"+id+"/renew", strings.NewReader(string(body)))
	if err != nil {
		return false, err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return false, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusConflict {
		return false, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return false, fmt.Errorf("worker API renewal returned %s", response.Status)
	}
	return true, nil
}

func (client *Client) JobState(ctx context.Context, id, executionID string) (*JobState, error) {
	path := "/internal/worker-dispatch/jobs/" + id + "/state?owner=" + url.QueryEscape(executionID)
	request, err := client.newRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("worker API state returned %s", response.Status)
	}
	var state JobState
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&state); err != nil {
		return nil, err
	}
	return &state, nil
}

func (client *Client) GetFileInspection(ctx context.Context, uploadID string) (*FileInspection, error) {
	path := "/internal/worker-executions/files/uploads/" + url.PathEscape(uploadID)
	var inspection FileInspection
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &inspection); err != nil {
		return nil, err
	}
	return &inspection, nil
}

func (client *Client) PublishFileInspection(ctx context.Context, uploadID string, inspected InspectedFile) (*PublishedFile, error) {
	body, err := json.Marshal(inspected)
	if err != nil {
		return nil, err
	}
	path := "/internal/worker-executions/files/uploads/" + url.PathEscape(uploadID) + "/publish"
	var published PublishedFile
	if err := client.requestJSON(ctx, http.MethodPost, path, strings.NewReader(string(body)), &published); err != nil {
		return nil, err
	}
	return &published, nil
}

// ThumbnailUploadURL asks Core to sign the upload of the upload's thumbnail, sized to byteLength.
func (client *Client) ThumbnailUploadURL(ctx context.Context, uploadID string, byteLength int64) (string, error) {
	body, err := json.Marshal(struct {
		ByteLength int64 `json:"byteLength"`
	}{byteLength})
	if err != nil {
		return "", err
	}
	path := "/internal/worker-executions/files/uploads/" + url.PathEscape(uploadID) + "/thumbnail-upload"
	var capability struct {
		UploadURL string `json:"uploadUrl"`
	}
	if err := client.requestJSON(ctx, http.MethodPost, path, strings.NewReader(string(body)), &capability); err != nil {
		return "", err
	}
	return capability.UploadURL, nil
}

func (client *Client) RejectFileInspection(ctx context.Context, uploadID, code string) error {
	body, err := json.Marshal(struct {
		Code string `json:"code"`
	}{code})
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/files/uploads/" + url.PathEscape(uploadID) + "/reject"
	return client.requestJSON(ctx, http.MethodPost, path, strings.NewReader(string(body)), nil)
}

func (client *Client) GetObjectCleanupCapability(ctx context.Context, offset int) (*ObjectCleanupCapability, error) {
	path := "/internal/worker-executions/object-cleanup?offset=" + url.QueryEscape(fmt.Sprint(offset))
	var capability ObjectCleanupCapability
	if err := client.requestJSONLimit(ctx, http.MethodGet, path, nil, &capability, 1<<20); err != nil {
		return nil, err
	}
	return &capability, nil
}

func (client *Client) GetTemplateFileTransferPlan(ctx context.Context, jobID, afterTransferID string, limit int) (*TemplateFileTransferPlan, error) {
	if !broker.IsCanonicalUUID(jobID) || afterTransferID != "" && !broker.IsCanonicalUUID(afterTransferID) || limit < 1 || limit > 100 {
		return nil, errors.New("template file transfer plan request is invalid")
	}
	query := url.Values{}
	query.Set("limit", fmt.Sprint(limit))
	if afterTransferID != "" {
		query.Set("afterTransferId", afterTransferID)
	}
	path := "/internal/worker-executions/template-file-transfers/" + url.PathEscape(jobID) + "/plan?" + query.Encode()
	var plan TemplateFileTransferPlan
	if err := client.requestStrictJSON(ctx, http.MethodGet, path, nil, &plan, 1<<20); err != nil {
		return nil, err
	}
	if plan.JobID != jobID || plan.OwnerKind != "operation" && plan.OwnerKind != "application" ||
		!broker.IsCanonicalUUID(plan.OwnerID) || plan.ObservedAt.IsZero() || len(plan.Transfers) > limit ||
		plan.Complete != (plan.NextAfterTransferID == nil) || !plan.Complete && !broker.IsCanonicalUUID(*plan.NextAfterTransferID) {
		return nil, errors.New("worker API template file transfer plan is invalid")
	}
	previous := afterTransferID
	for _, transfer := range plan.Transfers {
		if !broker.IsCanonicalUUID(transfer.TransferID) || !broker.IsCanonicalUUID(transfer.SourceItemID) || !broker.IsCanonicalUUID(transfer.TargetItemID) ||
			transfer.TargetVersion < 1 || transfer.TargetVersion > 100 || transfer.ByteLength < 0 || transfer.ByteLength > 100<<20 ||
			!validSHA256(transfer.SHA256) || strings.TrimSpace(transfer.FileName) == "" || len(transfer.FileName) > 255 ||
			strings.TrimSpace(transfer.MediaType) == "" || len(transfer.MediaType) > 160 || transfer.TransferID <= previous {
			return nil, errors.New("worker API template file transfer entry is invalid")
		}
		if transfer.Ready {
			if transfer.DownloadURL != nil || transfer.UploadURL != nil || transfer.VerifyURL != nil {
				return nil, errors.New("ready template file transfer unexpectedly includes capabilities")
			}
		} else if transfer.DownloadURL == nil || transfer.UploadURL == nil || transfer.VerifyURL == nil ||
			strings.TrimSpace(*transfer.DownloadURL) == "" || strings.TrimSpace(*transfer.UploadURL) == "" || strings.TrimSpace(*transfer.VerifyURL) == "" {
			return nil, errors.New("pending template file transfer is missing capabilities")
		}
		previous = transfer.TransferID
	}
	if !plan.Complete && (len(plan.Transfers) == 0 || *plan.NextAfterTransferID != plan.Transfers[len(plan.Transfers)-1].TransferID) {
		return nil, errors.New("worker API template file transfer cursor is invalid")
	}
	return &plan, nil
}

func (client *Client) CompleteTemplateFileTransferBatch(ctx context.Context, jobID string, transferIDs []string) error {
	if !broker.IsCanonicalUUID(jobID) || len(transferIDs) == 0 || len(transferIDs) > 100 {
		return errors.New("template file transfer completion request is invalid")
	}
	for index, transferID := range transferIDs {
		if !broker.IsCanonicalUUID(transferID) || index > 0 && transferID <= transferIDs[index-1] {
			return errors.New("template file transfer completion IDs are invalid")
		}
	}
	body, err := json.Marshal(CompleteTemplateFileTransferBatch{TransferIDs: transferIDs})
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/template-file-transfers/" + url.PathEscape(jobID) + "/complete"
	var result struct {
		JobID     string `json:"jobId"`
		Completed bool   `json:"completed"`
	}
	if err := client.requestStrictJSON(ctx, http.MethodPost, path, bytes.NewReader(body), &result, 64<<10); err != nil {
		return err
	}
	if result.JobID != jobID || !result.Completed {
		return errors.New("worker API rejected template file transfer completion")
	}
	return nil
}

func (client *Client) GetTemplateImportFilePlan(ctx context.Context, importID, afterTransferID string, limit int) (*TemplateImportFilePlan, error) {
	if !broker.IsCanonicalUUID(importID) || afterTransferID != "" && !broker.IsCanonicalUUID(afterTransferID) || limit < 1 || limit > 100 {
		return nil, errors.New("template import file plan request is invalid")
	}
	query := url.Values{}
	query.Set("limit", fmt.Sprint(limit))
	if afterTransferID != "" {
		query.Set("afterTransferId", afterTransferID)
	}
	path := "/internal/worker-executions/template-imports/" + url.PathEscape(importID) + "/files/authorization?" + query.Encode()
	var plan TemplateImportFilePlan
	if err := client.requestStrictJSON(ctx, http.MethodGet, path, nil, &plan, 1<<20); err != nil {
		return nil, err
	}
	if plan.ImportID != importID || len(plan.Files) > limit || plan.Complete != (plan.NextAfterTransferID == nil) ||
		!plan.Complete && !broker.IsCanonicalUUID(*plan.NextAfterTransferID) {
		return nil, errors.New("worker API template import file plan is invalid")
	}
	previous := afterTransferID
	for _, file := range plan.Files {
		if !broker.IsCanonicalUUID(file.TransferID) || !broker.IsCanonicalUUID(file.SourceItemID) || !broker.IsCanonicalUUID(file.TargetItemID) ||
			file.TargetVersion < 1 || file.TargetVersion > 100 || file.ByteLength < 0 || file.ByteLength > 100<<20 ||
			!validSHA256(file.SHA256) || strings.TrimSpace(file.FileName) == "" || len(file.FileName) > 255 ||
			strings.TrimSpace(file.MediaType) == "" || len(file.MediaType) > 160 || file.TransferID <= previous {
			return nil, errors.New("worker API template import file entry is invalid")
		}
		if file.Ready {
			if file.UploadURL != nil || file.VerifyURL != nil {
				return nil, errors.New("ready template import file unexpectedly includes capabilities")
			}
		} else if file.UploadURL == nil || file.VerifyURL == nil || strings.TrimSpace(*file.UploadURL) == "" || strings.TrimSpace(*file.VerifyURL) == "" {
			return nil, errors.New("pending template import file is missing capabilities")
		}
		previous = file.TransferID
	}
	if !plan.Complete && (len(plan.Files) == 0 || *plan.NextAfterTransferID != plan.Files[len(plan.Files)-1].TransferID) {
		return nil, errors.New("worker API template import file cursor is invalid")
	}
	return &plan, nil
}

func (client *Client) CompleteTemplateImportFileBatch(ctx context.Context, importID string, transferIDs []string) error {
	if !broker.IsCanonicalUUID(importID) || len(transferIDs) == 0 || len(transferIDs) > 100 {
		return errors.New("template import file completion request is invalid")
	}
	for index, transferID := range transferIDs {
		if !broker.IsCanonicalUUID(transferID) || index > 0 && transferID <= transferIDs[index-1] {
			return errors.New("template import file completion IDs are invalid")
		}
	}
	body, err := json.Marshal(CompleteTemplateFileTransferBatch{TransferIDs: transferIDs})
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/template-imports/" + url.PathEscape(importID) + "/files/complete"
	var result struct {
		ImportID             string   `json:"importId"`
		CompletedTransferIDs []string `json:"completedTransferIds"`
	}
	if err := client.requestStrictJSON(ctx, http.MethodPost, path, bytes.NewReader(body), &result, 64<<10); err != nil {
		return err
	}
	if result.ImportID != importID || !slices.Equal(result.CompletedTransferIDs, transferIDs) {
		return errors.New("worker API rejected template import file completion")
	}
	return nil
}

func (client *Client) GetDocumentImportFilePlan(ctx context.Context, importID, afterTransferID string, limit int) (*TemplateImportFilePlan, error) {
	if !broker.IsCanonicalUUID(importID) || afterTransferID != "" && !broker.IsCanonicalUUID(afterTransferID) || limit < 1 || limit > 100 {
		return nil, errors.New("document import file-version plan request is invalid")
	}
	query := url.Values{}
	query.Set("limit", fmt.Sprint(limit))
	if afterTransferID != "" {
		query.Set("afterTransferId", afterTransferID)
	}
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/file-versions/authorization?" + query.Encode()
	var plan TemplateImportFilePlan
	if err := client.requestStrictJSON(ctx, http.MethodGet, path, nil, &plan, 1<<20); err != nil {
		return nil, err
	}
	if plan.ImportID != importID || len(plan.Files) > limit || plan.Complete != (plan.NextAfterTransferID == nil) || !plan.Complete && !broker.IsCanonicalUUID(*plan.NextAfterTransferID) {
		return nil, errors.New("worker API document import file-version plan is invalid")
	}
	previous := afterTransferID
	for _, file := range plan.Files {
		if !broker.IsCanonicalUUID(file.TransferID) || !broker.IsCanonicalUUID(file.SourceItemID) || !broker.IsCanonicalUUID(file.TargetItemID) || file.TargetVersion < 1 || file.TargetVersion > 100 || file.ByteLength < 0 || file.ByteLength > 100<<20 || !validSHA256(file.SHA256) || strings.TrimSpace(file.FileName) == "" || len(file.FileName) > 255 || strings.TrimSpace(file.MediaType) == "" || len(file.MediaType) > 160 || file.TransferID <= previous {
			return nil, errors.New("worker API document import file-version entry is invalid")
		}
		if file.Ready {
			if file.UploadURL != nil || file.VerifyURL != nil {
				return nil, errors.New("ready document import file unexpectedly includes capabilities")
			}
		} else if file.UploadURL == nil || file.VerifyURL == nil || strings.TrimSpace(*file.UploadURL) == "" || strings.TrimSpace(*file.VerifyURL) == "" {
			return nil, errors.New("pending document import file is missing capabilities")
		}
		previous = file.TransferID
	}
	if !plan.Complete && (len(plan.Files) == 0 || *plan.NextAfterTransferID != plan.Files[len(plan.Files)-1].TransferID) {
		return nil, errors.New("worker API document import file cursor is invalid")
	}
	return &plan, nil
}

func (client *Client) CompleteDocumentImportFileBatch(ctx context.Context, importID string, transferIDs []string) error {
	if !broker.IsCanonicalUUID(importID) || len(transferIDs) == 0 || len(transferIDs) > 100 {
		return errors.New("document import file completion request is invalid")
	}
	for index, transferID := range transferIDs {
		if !broker.IsCanonicalUUID(transferID) || index > 0 && transferID <= transferIDs[index-1] {
			return errors.New("document import file completion IDs are invalid")
		}
	}
	body, err := json.Marshal(CompleteTemplateFileTransferBatch{TransferIDs: transferIDs})
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/file-versions/complete"
	var result struct {
		ImportID             string   `json:"importId"`
		CompletedTransferIDs []string `json:"completedTransferIds"`
	}
	if err := client.requestStrictJSON(ctx, http.MethodPost, path, bytes.NewReader(body), &result, 64<<10); err != nil {
		return err
	}
	if result.ImportID != importID || !slices.Equal(result.CompletedTransferIDs, transferIDs) {
		return errors.New("worker API rejected document import file completion")
	}
	return nil
}

func validSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func (client *Client) FinalizeWorkspacePurge(ctx context.Context) error {
	return client.requestJSON(ctx, http.MethodPost, "/internal/worker-executions/workspace-purge/finalize", nil, nil)
}

func (client *Client) GetDocumentImportPreview(ctx context.Context, importID string) (*DocumentImportPreview, error) {
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/preview"
	var preview DocumentImportPreview
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &preview); err != nil {
		return nil, err
	}
	return &preview, nil
}

func (client *Client) CompleteDocumentImportPreview(ctx context.Context, importID string, result CompleteDocumentImportPreview) error {
	body, err := json.Marshal(result)
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/preview/complete"
	return client.requestJSON(ctx, http.MethodPost, path, strings.NewReader(string(body)), nil)
}

func (client *Client) GetDocumentImportCommit(ctx context.Context, importID string) (*DocumentImportCommit, error) {
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/commit"
	var commit DocumentImportCommit
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &commit); err != nil {
		return nil, err
	}
	return &commit, nil
}

func (client *Client) StageDocumentImport(ctx context.Context, importID string, stage DocumentImportStageRequest) (*DocumentImportStage, error) {
	body, err := json.Marshal(stage)
	if err != nil {
		return nil, err
	}
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/stage"
	var result DocumentImportStage
	if err := client.requestJSONLimit(ctx, http.MethodPost, path, strings.NewReader(string(body)), &result, 16<<20); err != nil {
		return nil, err
	}
	return &result, nil
}

func (client *Client) GetDocumentImportObjectCapability(ctx context.Context, importID, sourceID string) (*DocumentImportObjectCapability, error) {
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/objects/capability?sourceId=" + url.QueryEscape(sourceID)
	var capability DocumentImportObjectCapability
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &capability); err != nil {
		return nil, err
	}
	return &capability, nil
}

func (client *Client) CompleteDocumentImportObject(ctx context.Context, importID, sourceID string, byteLength int64, sha256 string) error {
	body, err := json.Marshal(struct {
		SourceID   string `json:"sourceId"`
		ByteLength int64  `json:"byteLength"`
		SHA256     string `json:"sha256"`
	}{sourceID, byteLength, sha256})
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/objects/complete"
	return client.requestJSON(ctx, http.MethodPost, path, strings.NewReader(string(body)), nil)
}

func (client *Client) FinalizeDocumentImport(ctx context.Context, importID string) (*DocumentImportResult, error) {
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/finalize"
	var result DocumentImportResult
	if err := client.requestJSON(ctx, http.MethodPost, path, http.NoBody, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (client *Client) RejectDocumentImport(ctx context.Context, importID, code string) error {
	body, err := json.Marshal(struct {
		Code string `json:"code"`
	}{code})
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/reject"
	return client.requestJSON(ctx, http.MethodPost, path, strings.NewReader(string(body)), nil)
}

func (client *Client) GetTemplateImportPreview(ctx context.Context, importID string) (*TemplateImportPreview, error) {
	path := "/internal/worker-executions/template-imports/" + url.PathEscape(importID) + "/preview"
	var preview TemplateImportPreview
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &preview); err != nil {
		return nil, err
	}
	return &preview, nil
}

func (client *Client) CompleteTemplateImportPreview(ctx context.Context, importID string, result CompleteTemplateImportPreview) error {
	body, err := json.Marshal(result)
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/template-imports/" + url.PathEscape(importID) + "/preview/complete"
	return client.requestJSON(ctx, http.MethodPost, path, bytes.NewReader(body), nil)
}

func (client *Client) GetTemplateImportCommit(ctx context.Context, importID string) (*TemplateImportCommit, error) {
	path := "/internal/worker-executions/template-imports/" + url.PathEscape(importID) + "/commit"
	var commit TemplateImportCommit
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &commit); err != nil {
		return nil, err
	}
	return &commit, nil
}

func (client *Client) StageTemplateImport(ctx context.Context, importID string, stage TemplateImportStageRequest) (*TemplateImportStage, error) {
	body, err := json.Marshal(stage)
	if err != nil {
		return nil, err
	}
	path := "/internal/worker-executions/template-imports/" + url.PathEscape(importID) + "/stage"
	var result TemplateImportStage
	if err := client.requestJSONLimit(ctx, http.MethodPost, path, bytes.NewReader(body), &result, 16<<20); err != nil {
		return nil, err
	}
	return &result, nil
}

func (client *Client) CompleteTemplateImport(ctx context.Context, importID string, completion CompleteTemplateImportRequest) (*TemplateImportResult, error) {
	body, err := json.Marshal(completion)
	if err != nil {
		return nil, err
	}
	path := "/internal/worker-executions/template-imports/" + url.PathEscape(importID) + "/complete"
	var result TemplateImportResult
	if err := client.requestJSONLimit(ctx, http.MethodPost, path, bytes.NewReader(body), &result, 1<<20); err != nil {
		return nil, err
	}
	return &result, nil
}

func (client *Client) RejectTemplateImport(ctx context.Context, importID, code string) error {
	body, err := json.Marshal(struct {
		Code string `json:"code"`
	}{code})
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/template-imports/" + url.PathEscape(importID) + "/reject"
	return client.requestJSON(ctx, http.MethodPost, path, bytes.NewReader(body), nil)
}

func (client *Client) GetExportSource(ctx context.Context, exportID string) (*ExportSource, error) {
	path := "/internal/worker-executions/exports/" + url.PathEscape(exportID)
	var source ExportSource
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &source); err != nil {
		return nil, err
	}
	return &source, nil
}

type ExportImage struct {
	URL        string    `json:"url"`
	ExpiresAt  time.Time `json:"expiresAt"`
	MediaType  string    `json:"mediaType"`
	ByteLength int64     `json:"byteLength"`
	SHA256     string    `json:"sha256"`
}

type ExportFileHistory struct {
	ItemID   string              `json:"itemId"`
	Versions []ExportFileVersion `json:"versions"`
}

type ExportFileVersion struct {
	Version     int       `json:"version"`
	Current     bool      `json:"current"`
	FileName    string    `json:"fileName"`
	MediaType   string    `json:"mediaType"`
	ByteLength  int64     `json:"byteLength"`
	SHA256      string    `json:"sha256"`
	Previewable bool      `json:"previewable"`
	PixelWidth  *int      `json:"pixelWidth"`
	PixelHeight *int      `json:"pixelHeight"`
	DownloadURL string    `json:"downloadUrl"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

func (client *Client) GetExportFileHistory(ctx context.Context, exportID, itemID string) (*ExportFileHistory, error) {
	path := "/internal/worker-executions/exports/" + url.PathEscape(exportID) + "/files/" + url.PathEscape(itemID) + "/versions"
	var result ExportFileHistory
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (client *Client) GetExportImage(ctx context.Context, exportID, itemID string) (*ExportImage, error) {
	path := "/internal/worker-executions/exports/" + url.PathEscape(exportID) + "/images/" + url.PathEscape(itemID)
	var result ExportImage
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (client *Client) GetExportDestination(ctx context.Context, exportID string, byteLength int64, sha256 string) (*ExportDestination, error) {
	query := url.Values{}
	query.Set("byteLength", fmt.Sprint(byteLength))
	query.Set("sha256", sha256)
	path := "/internal/worker-executions/exports/" + url.PathEscape(exportID) + "/destination?" + query.Encode()
	var destination ExportDestination
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &destination); err != nil {
		return nil, err
	}
	return &destination, nil
}

// NotificationDeliveryPayload is the rendered push payload for a notification:
// same-origin path only, never a full URL (N1, ADR-0051 section 5).
type NotificationDeliveryPayload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Tag   string `json:"tag"`
}

type NotificationDeliverySubscription struct {
	ID       string `json:"id"`
	Endpoint string `json:"endpoint"`
	P256dh   string `json:"p256dh"`
	Auth     string `json:"auth"`
}

type NotificationDelivery struct {
	Payload       NotificationDeliveryPayload        `json:"payload"`
	Subscriptions []NotificationDeliverySubscription `json:"subscriptions"`
}

const maxNotificationSubscriptions = 20

// GetNotificationDelivery fetches N1's rendered payload and subscription set for
// a notify.push job.
func (client *Client) GetNotificationDelivery(ctx context.Context, notificationID string) (*NotificationDelivery, error) {
	if !broker.IsCanonicalUUID(notificationID) {
		return nil, errors.New("notification delivery request is invalid")
	}
	path := "/internal/worker-executions/notifications/" + url.PathEscape(notificationID) + "/delivery"
	var delivery NotificationDelivery
	if err := client.requestStrictJSON(ctx, http.MethodPost, path, nil, &delivery, 64<<10); err != nil {
		return nil, err
	}
	if len(delivery.Payload.Title) > 200 || len(delivery.Payload.Body) > 1000 || len(delivery.Payload.Tag) > 64 ||
		!sameOriginPath(delivery.Payload.URL) ||
		len(delivery.Subscriptions) > maxNotificationSubscriptions {
		return nil, errors.New("worker API notification delivery payload is invalid")
	}
	for _, subscription := range delivery.Subscriptions {
		if !broker.IsCanonicalUUID(subscription.ID) || strings.TrimSpace(subscription.Endpoint) == "" ||
			strings.TrimSpace(subscription.P256dh) == "" || strings.TrimSpace(subscription.Auth) == "" {
			return nil, errors.New("worker API notification delivery subscription is invalid")
		}
	}
	return &delivery, nil
}

// NotificationDeliveryResult is one subscription's outcome for the N1 results call.
type NotificationDeliveryResult struct {
	SubscriptionID string `json:"subscriptionId"`
	Status         string `json:"status"` // "delivered", "gone", or "failed"
	HTTPStatus     int    `json:"httpStatus"`
}

// ReportNotificationDeliveryResults reports N1's per-subscription push outcomes.
// Core deletes "gone" subscriptions and counts "failed" toward removal after 5
// consecutive failures.
func (client *Client) ReportNotificationDeliveryResults(ctx context.Context, notificationID string, results []NotificationDeliveryResult) error {
	if !broker.IsCanonicalUUID(notificationID) || len(results) == 0 || len(results) > maxNotificationSubscriptions {
		return errors.New("notification delivery result report is invalid")
	}
	for _, result := range results {
		if !broker.IsCanonicalUUID(result.SubscriptionID) {
			return errors.New("notification delivery result report is invalid")
		}
		switch result.Status {
		case "delivered", "gone", "failed":
		default:
			return errors.New("notification delivery result report is invalid")
		}
	}
	body, err := json.Marshal(struct {
		Results []NotificationDeliveryResult `json:"results"`
	}{results})
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/notifications/" + url.PathEscape(notificationID) + "/delivery/results"
	return client.requestJSON(ctx, http.MethodPost, path, bytes.NewReader(body), nil)
}

func (client *Client) LeaseOutbox(ctx context.Context, kind string, limit int) ([]OutboxEvent, error) {
	var events []OutboxEvent
	if err := client.lease(ctx, "/internal/worker-dispatch/outbox/lease", kind, limit, &events); err != nil {
		return nil, err
	}
	return events, nil
}

func (client *Client) lease(ctx context.Context, path, kind string, limit int, target any) error {
	body, err := json.Marshal(struct {
		Owner string `json:"owner"`
		Kind  string `json:"kind,omitempty"`
		Limit int    `json:"limit"`
	}{client.owner, kind, limit})
	if err != nil {
		return err
	}
	request, err := client.newRequest(ctx, http.MethodPost, path, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("worker API lease returned %s", response.Status)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(target); err != nil {
		return err
	}
	return nil
}

func (client *Client) AcknowledgeOutbox(ctx context.Context, id string) error {
	return client.finishOutbox(ctx, id, true, "")
}
func (client *Client) FailOutbox(ctx context.Context, id, failure string) error {
	return client.finishOutbox(ctx, id, false, failure)
}

func (client *Client) finishOutbox(ctx context.Context, id string, succeeded bool, failure string) error {
	body, err := json.Marshal(struct {
		Owner     string `json:"owner"`
		Succeeded bool   `json:"succeeded"`
		Error     string `json:"error,omitempty"`
	}{client.owner, succeeded, failure})
	if err != nil {
		return err
	}
	return client.post(ctx, "/internal/worker-dispatch/outbox/"+id+"/finish", strings.NewReader(string(body)))
}

func (client *Client) post(ctx context.Context, path string, body io.Reader) error {
	return client.requestJSON(ctx, http.MethodPost, path, body, nil)
}

func (client *Client) requestJSON(ctx context.Context, method, path string, body io.Reader, target any) error {
	return client.requestJSONLimit(ctx, method, path, body, target, 256<<10)
}

func (client *Client) requestJSONLimit(ctx context.Context, method, path string, body io.Reader, target any, responseLimit int64) error {
	request, err := client.newRequest(ctx, method, path, body)
	if err != nil {
		return err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ResponseErrorFrom(response, path)
	}
	if target != nil {
		if responseLimit <= 0 {
			return errors.New("worker API response limit must be positive")
		}
		if err := json.NewDecoder(io.LimitReader(response.Body, responseLimit)).Decode(target); err != nil {
			return err
		}
	}
	return nil
}

func (client *Client) requestStrictJSON(ctx context.Context, method, path string, body io.Reader, target any, responseLimit int64) error {
	request, err := client.newRequest(ctx, method, path, body)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ResponseErrorFrom(response, path)
	}
	if !hasMediaType(response.Header.Get("Content-Type"), "application/json") {
		return errors.New("worker API response is not JSON")
	}
	responseBody, err := readBounded(response.Body, response.ContentLength, responseLimit)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(responseBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return requireResponseEOF(decoder)
}

// ResponseErrorFrom returns a bounded status error and extracts the stable problem code from 409s.
// Callers use the code to distinguish a worker lease refusal from a terminal domain conflict.
func ResponseErrorFrom(response *http.Response, path string) *ResponseError {
	result := &ResponseError{Status: response.StatusCode, Path: path}
	if response.StatusCode != http.StatusConflict {
		return result
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 16<<10))
	if err != nil {
		return result
	}
	var problem struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(body, &problem); err == nil {
		result.Code = problem.Code
	}
	return result
}

func (client *Client) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	if client.baseURL == "" {
		return nil, fmt.Errorf("worker API URL is not configured")
	}
	request, err := http.NewRequestWithContext(ctx, method, client.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Nix-Internal-Secret", client.secret)
	if execution, ok := ctx.Value(executionContextKey{}).(executionContext); ok {
		request.Header.Set("X-Nix-Worker-Job-Id", execution.jobID)
		request.Header.Set("X-Nix-Worker-Execution-Id", execution.executionID)
	}
	return request, nil
}

func readBounded(reader io.Reader, contentLength, limit int64) ([]byte, error) {
	if limit <= 0 || contentLength > limit {
		return nil, ErrResponseTooLarge
	}
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, ErrResponseTooLarge
	}
	return body, nil
}

func hasMediaType(value, expected string) bool {
	mediaType, parameters, err := mime.ParseMediaType(value)
	if err != nil || !strings.EqualFold(mediaType, expected) {
		return false
	}
	charset := parameters["charset"]
	return charset == "" || strings.EqualFold(charset, "utf-8")
}

func requireResponseEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values are not allowed")
		}
		return err
	}
	return nil
}

// sameOriginPath reports whether value is a path on the current origin: it starts with a single
// slash and cannot be read as a protocol-relative ("//host", "/\\host") or absolute URL, and it
// carries no control characters a browser might strip before resolving it.
func sameOriginPath(value string) bool {
	if !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") || strings.HasPrefix(value, "/\\") ||
		strings.Contains(value, "://") {
		return false
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}
