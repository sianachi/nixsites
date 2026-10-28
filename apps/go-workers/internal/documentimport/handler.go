package documentimport

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/importplan"
	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
	"github.com/sianachi/Nix/apps/go-workers/internal/worktemp"
)

var Kinds = []string{
	"import.preview.nix",
	"import.preview.markdown",
	"import.preview.txt",
	"import.preview.docx",
	"import.preview.pdf",
	"import.commit",
}

type Payload struct {
	ImportID string `json:"importId"`
}

type PreviewResult struct {
	ImportID  string   `json:"importId"`
	Items     int      `json:"items"`
	Assets    int      `json:"assets"`
	Loss      []string `json:"loss"`
	Omissions []string `json:"omissions"`
}

type CommitResult struct {
	ImportID   string `json:"importId"`
	RootItemID string `json:"rootItemId"`
	Items      int    `json:"items"`
	Assets     int    `json:"assets"`
}

type Handler struct {
	api      *workerapi.Client
	transfer *objecttransfer.Client
	collab   *collaborationClient
	limits   importplan.Limits
}

func New(
	api *workerapi.Client,
	transfer *objecttransfer.Client,
	collaborationURL, internalSecret string,
	limits importplan.Limits,
	timeout time.Duration,
) (*Handler, error) {
	if api == nil || transfer == nil || limits.MaxSourceBytes <= 0 || limits.MaxPlanBytes <= 0 || limits.MaxItems <= 0 {
		return nil, errors.New("document import handler configuration is invalid")
	}
	collab, err := newCollaborationClient(collaborationURL, internalSecret, timeout)
	if err != nil {
		return nil, err
	}
	return &Handler{api: api, transfer: transfer, collab: collab, limits: limits}, nil
}

func (handler *Handler) Handle(ctx context.Context, job workerapi.Job) (any, error) {
	payload, err := decodePayload(job.Payload)
	if err != nil {
		return nil, jobrunner.Fail("import_payload_invalid", err)
	}
	if job.Kind == "import.commit" {
		return handler.commit(ctx, payload.ImportID)
	}
	if strings.HasPrefix(job.Kind, "import.preview.") {
		return handler.preview(ctx, payload.ImportID, strings.TrimPrefix(job.Kind, "import.preview."))
	}
	return nil, jobrunner.Fail("import_kind_mismatch", errors.New("job kind is not a document import operation"))
}

func (handler *Handler) preview(ctx context.Context, importID, kindFormat string) (any, error) {
	preview, err := handler.api.GetDocumentImportPreview(ctx, importID)
	if err != nil {
		return nil, apiFailure("import_preview_unavailable", err)
	}
	if preview.ImportID != importID || preview.Format != kindFormat || preview.DeclaredByteLength < 0 || preview.DeclaredByteLength > handler.limits.MaxSourceBytes {
		return nil, handler.reject(ctx, importID, "import_preview_invalid", errors.New("Core returned inconsistent import metadata"))
	}
	source, err := handler.download(ctx, preview.SourceURL, handler.limits.MaxSourceBytes)
	if err != nil {
		return nil, jobrunner.Retry("import_source_unavailable", err)
	}
	defer source.remove()
	if source.size != preview.DeclaredByteLength {
		return nil, handler.reject(ctx, importID, "import_size_mismatch", errors.New("uploaded source size does not match its declaration"))
	}
	plan, err := importplan.Parse(ctx, importplan.Source{
		Path: source.path, Format: preview.Format, Title: preview.Title, FileName: preview.FileName,
		MediaType: preview.DeclaredMediaType, Bytes: source.size, SHA256: source.sha256,
	}, handler.limits)
	if err != nil {
		return nil, handler.reject(ctx, importID, importFailureCode(err), err)
	}
	planBytes, planDigest, err := importplan.Encode(plan, handler.limits.MaxPlanBytes)
	if err != nil {
		return nil, handler.reject(ctx, importID, "import_plan_invalid", err)
	}
	if err := handler.transfer.Upload(ctx, preview.PlanUploadURL, "application/json", bytes.NewReader(planBytes), int64(len(planBytes)), planDigest); err != nil {
		return nil, jobrunner.Retry("import_plan_upload_failed", err)
	}
	assets := assetCount(plan)
	completion := workerapi.CompleteDocumentImportPreview{
		PlanSHA256: planDigest, PlanByteLength: int64(len(planBytes)), SourceSHA256: source.sha256,
		ItemCount: len(plan.Items), AssetCount: assets, Loss: nonNil(plan.Loss), Omissions: nonNil(plan.Omissions),
	}
	if err := handler.api.CompleteDocumentImportPreview(ctx, importID, completion); err != nil {
		return nil, apiFailure("import_preview_completion_failed", err)
	}
	return PreviewResult{ImportID: importID, Items: len(plan.Items), Assets: assets, Loss: nonNil(plan.Loss), Omissions: nonNil(plan.Omissions)}, nil
}

func (handler *Handler) commit(ctx context.Context, importID string) (any, error) {
	commit, err := handler.api.GetDocumentImportCommit(ctx, importID)
	if err != nil {
		return nil, apiFailure("import_commit_unavailable", err)
	}
	if commit.ImportID != importID || commit.DeclaredByteLength < 0 || commit.DeclaredByteLength > handler.limits.MaxSourceBytes || commit.PlanByteLength <= 0 || commit.PlanByteLength > handler.limits.MaxPlanBytes {
		return nil, handler.reject(ctx, importID, "import_commit_invalid", errors.New("Core returned inconsistent commit metadata"))
	}
	source, err := handler.download(ctx, commit.SourceURL, handler.limits.MaxSourceBytes)
	if err != nil {
		return nil, jobrunner.Retry("import_source_unavailable", err)
	}
	defer source.remove()
	if source.size != commit.DeclaredByteLength || !strings.EqualFold(source.sha256, commit.SourceSHA256) {
		return nil, handler.reject(ctx, importID, "import_source_changed", errors.New("the source changed after preview"))
	}
	planned, err := handler.download(ctx, commit.PlanURL, handler.limits.MaxPlanBytes)
	if err != nil {
		return nil, jobrunner.Retry("import_plan_unavailable", err)
	}
	defer planned.remove()
	if planned.size != commit.PlanByteLength || !strings.EqualFold(planned.sha256, commit.PlanSHA256) {
		return nil, handler.reject(ctx, importID, "import_plan_changed", errors.New("the import plan changed after preview"))
	}
	planBody, err := os.ReadFile(planned.path)
	if err != nil {
		return nil, jobrunner.Retry("import_plan_unavailable", err)
	}
	plan, err := importplan.Decode(planBody, commit.PlanSHA256, handler.limits)
	if err != nil {
		return nil, handler.reject(ctx, importID, "import_plan_invalid", err)
	}
	if plan.Format != commit.Format || plan.Title != commit.Title || !strings.EqualFold(plan.SourceSHA256, commit.SourceSHA256) {
		return nil, handler.reject(ctx, importID, "import_plan_mismatch", errors.New("the plan does not describe this import"))
	}
	reparsed, err := importplan.Parse(ctx, importplan.Source{
		Path: source.path, Format: commit.Format, Title: commit.Title, FileName: commit.FileName,
		MediaType: commit.DeclaredMediaType, Bytes: source.size, SHA256: source.sha256,
	}, handler.limits)
	if err != nil {
		return nil, handler.reject(ctx, importID, importFailureCode(err), err)
	}
	_, reparsedDigest, err := importplan.Encode(reparsed, handler.limits.MaxPlanBytes)
	if err != nil || !strings.EqualFold(reparsedDigest, commit.PlanSHA256) {
		if err == nil {
			err = errors.New("the deterministic preview no longer matches the source")
		}
		return nil, handler.reject(ctx, importID, "import_plan_mismatch", err)
	}

	stageRequest := workerapi.DocumentImportStageRequest{
		PlanSHA256:   commit.PlanSHA256,
		SourceSHA256: commit.SourceSHA256,
		Items:        make([]workerapi.DocumentImportStageItem, 0, len(plan.Items)),
	}
	for _, file := range plan.FileVersions {
		stageRequest.FileVersions = append(stageRequest.FileVersions, workerapi.TemplateImportStageFile{
			SourceItemID: file.ItemID, Version: file.Version, FileName: file.FileName, MediaType: file.MediaType,
			ByteLength: file.ByteLength, SHA256: file.SHA256, Previewable: file.Previewable,
			PixelWidth: file.PixelWidth, PixelHeight: file.PixelHeight,
		})
	}
	for _, item := range plan.Items {
		stageRequest.Items = append(stageRequest.Items, stageItem(item))
	}
	stage, err := handler.api.StageDocumentImport(ctx, importID, stageRequest)
	if err != nil {
		classified := apiFailure("import_stage_failed", err)
		if retryableOrLeaseLost(classified) {
			return nil, classified
		}
		return nil, handler.reject(ctx, importID, "import_stage_failed", err)
	}
	if stage.ImportID != importID || len(stage.Items) != len(plan.Items) {
		return nil, handler.reject(ctx, importID, "import_stage_invalid", errors.New("Core returned an incomplete staging map"))
	}
	if len(plan.FileVersions) > 0 {
		if err := handler.transferArchiveFileVersions(ctx, importID, source.path, plan.FileVersions, stage); err != nil {
			var typed *jobrunner.JobError
			if errors.As(err, &typed) && typed.Retryable {
				return nil, err
			}
			return nil, handler.reject(ctx, importID, "import_file_invalid", err)
		}
	}

	mapped := make(map[string]workerapi.DocumentImportStageMapping, len(stage.Items))
	for _, item := range stage.Items {
		if _, exists := mapped[item.SourceID]; exists {
			return nil, handler.reject(ctx, importID, "import_stage_invalid", errors.New("Core returned duplicate staging mappings"))
		}
		mapped[item.SourceID] = item
	}
	for _, item := range plan.Items {
		mapping, ok := mapped[item.SourceID]
		if !ok || mapping.ItemType != item.ItemType || mapping.BodyRequired != (item.Body != nil) {
			return nil, handler.reject(ctx, importID, "import_stage_invalid", errors.New("Core staging mappings disagree with the plan"))
		}
		if item.File == nil || mapping.ObjectReady {
			continue
		}
		if err := handler.uploadFile(ctx, importID, importplan.Source{
			Path: source.path, Format: commit.Format, Title: commit.Title, FileName: commit.FileName,
			MediaType: commit.DeclaredMediaType, Bytes: source.size, SHA256: source.sha256,
		}, item); err != nil {
			var typed *jobrunner.JobError
			if errors.As(err, &typed) && typed.Retryable {
				return nil, err
			}
			return nil, handler.reject(ctx, importID, "import_file_invalid", err)
		}
	}
	if err := handler.collab.Write(ctx, importID, bodyWrites(plan)); err != nil {
		var response *workerapi.ResponseError
		if errors.As(err, &response) && response.Status == http.StatusConflict {
			return nil, err
		}
		if errors.As(err, &response) && response.Status >= 500 {
			return nil, jobrunner.Retry("import_body_write_failed", err)
		}
		if !errors.As(err, &response) {
			return nil, jobrunner.Retry("import_body_write_failed", err)
		}
		return nil, handler.reject(ctx, importID, "import_body_invalid", err)
	}
	result, err := handler.api.FinalizeDocumentImport(ctx, importID)
	if err != nil {
		classified := apiFailure("import_finalize_failed", err)
		if retryableOrLeaseLost(classified) {
			return nil, classified
		}
		return nil, handler.reject(ctx, importID, "import_finalize_failed", err)
	}
	if result.Status != "completed" || result.RootItemID == nil || *result.RootItemID != stage.RootItemID {
		return nil, jobrunner.Fail("import_finalize_invalid", errors.New("Core did not confirm the published root"))
	}
	return CommitResult{ImportID: importID, RootItemID: stage.RootItemID, Items: len(plan.Items), Assets: assetCount(plan)}, nil
}

func (handler *Handler) uploadFile(ctx context.Context, importID string, source importplan.Source, item importplan.Item) error {
	if item.File == nil {
		return errors.New("file plan is missing")
	}
	var body io.Reader
	var closeBody func() error
	switch item.File.SourceKind {
	case "source":
		file, err := os.Open(source.Path)
		if err != nil {
			return err
		}
		body = file
		closeBody = file.Close
	case "asset":
		if item.File.AssetPath == nil {
			return errors.New("asset path is missing")
		}
		asset, err := importplan.OpenAsset(source, *item.File.AssetPath, handler.limits)
		if err != nil {
			return err
		}
		if asset.Size != item.File.ByteLength {
			_ = asset.Close()
			return errors.New("asset size changed after preview")
		}
		body = asset.Body
		closeBody = asset.Close
	default:
		return errors.New("file source kind is unsupported")
	}
	defer closeBody()

	capability, err := handler.api.GetDocumentImportObjectCapability(ctx, importID, item.SourceID)
	if err != nil {
		return apiFailure("import_file_capability_failed", err)
	}
	if capability.SourceID != item.SourceID {
		return errors.New("Core returned a capability for the wrong file")
	}
	digest := sha256.New()
	uploadErr := handler.transfer.UploadCreateOnlyVerified(
		ctx,
		capability.UploadURL,
		item.File.MediaType,
		io.TeeReader(io.LimitReader(body, item.File.ByteLength), digest),
		item.File.ByteLength,
		item.File.SHA256,
	)
	if errors.Is(uploadErr, objecttransfer.ErrAlreadyExists) {
		if err := handler.verifyPublishedFile(ctx, capability.URL, item.File.ByteLength, item.File.SHA256); err != nil {
			return err
		}
	} else if uploadErr != nil {
		return jobrunner.Retry("import_file_upload_failed", uploadErr)
	} else {
		actual := hex.EncodeToString(digest.Sum(nil))
		if !strings.EqualFold(actual, item.File.SHA256) {
			_ = handler.transfer.Delete(context.WithoutCancel(ctx), capability.DeleteURL)
			return errors.New("file checksum changed after preview")
		}
	}
	if err := handler.api.CompleteDocumentImportObject(ctx, importID, item.SourceID, item.File.ByteLength, item.File.SHA256); err != nil {
		return apiFailure("import_file_completion_failed", err)
	}
	return nil
}

func (handler *Handler) transferArchiveFileVersions(ctx context.Context, importID, archivePath string, descriptors []nixarchive.FileVersionEntry, stage *workerapi.DocumentImportStage) error {
	archives, err := importplan.OpenNixArchiveFiles(archivePath, handler.limits)
	if err != nil {
		return jobrunner.Fail("import_file_archive_invalid", err)
	}
	defer archives.Close()
	expected := make(map[string]nixarchive.FileVersionEntry, len(descriptors))
	for _, descriptor := range descriptors {
		expected[fileVersionKey(descriptor.ItemID, descriptor.Version)] = descriptor
	}
	mappings := make(map[string]workerapi.TemplateImportFileTransferMapping, len(stage.FileTransfers))
	for _, mapping := range stage.FileTransfers {
		mappings[fileVersionKey(mapping.SourceItemID, mapping.TargetVersion)] = mapping
	}
	if len(mappings) != len(expected) {
		return errors.New("Core returned incomplete archive file-version mappings")
	}
	seen := make(map[string]struct{}, len(expected))
	var after string
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		page, err := handler.api.GetDocumentImportFilePlan(ctx, importID, after, 100)
		if err != nil {
			return apiFailure("import_file_capability_failed", err)
		}
		for _, file := range page.Files {
			key := fileVersionKey(file.SourceItemID, file.TargetVersion)
			descriptor, hasDescriptor := expected[key]
			mapping, hasMapping := mappings[key]
			if !hasDescriptor || !hasMapping || mapping.TransferID != file.TransferID || mapping.TargetItemID != file.TargetItemID ||
				file.FileName != descriptor.FileName || file.MediaType != descriptor.MediaType || file.ByteLength != descriptor.ByteLength || !strings.EqualFold(file.SHA256, descriptor.SHA256) {
				return errors.New("Core returned file capabilities that differ from the validated archive")
			}
			if _, duplicate := seen[key]; duplicate {
				return errors.New("Core returned a duplicate archive file-version transfer")
			}
			seen[key] = struct{}{}
			if file.Ready {
				continue
			}
			if file.UploadURL == nil || file.VerifyURL == nil {
				return errors.New("Core omitted archive file-version capabilities")
			}
			if err := handler.copyArchiveFileVersion(ctx, archives, file); err != nil {
				return jobrunner.Retry("import_file_transfer_failed", err)
			}
			if err := handler.api.CompleteDocumentImportFileBatch(ctx, importID, []string{file.TransferID}); err != nil {
				return apiFailure("import_file_completion_failed", err)
			}
		}
		if page.Complete {
			if len(seen) != len(expected) {
				return errors.New("Core omitted one or more archive file versions")
			}
			return nil
		}
		after = *page.NextAfterTransferID
	}
}

func (handler *Handler) copyArchiveFileVersion(ctx context.Context, archive *importplan.NixArchiveFiles, file workerapi.TemplateImportFileCapability) error {
	if file.UploadURL == nil || file.VerifyURL == nil {
		return errors.New("file-version upload capabilities are missing")
	}
	if err := handler.verifyPublishedFile(ctx, *file.VerifyURL, file.ByteLength, file.SHA256); err == nil {
		return nil
	} else if !errors.Is(err, objecttransfer.ErrNotFound) {
		return err
	}
	content, err := archive.OpenVersion(file.SourceItemID, file.TargetVersion, file.ByteLength)
	if err != nil {
		return err
	}
	defer content.Close()
	digest := sha256.New()
	if err := handler.transfer.UploadCreateOnlyVerified(ctx, *file.UploadURL, file.MediaType, io.TeeReader(content, digest), file.ByteLength, file.SHA256); err != nil {
		if errors.Is(err, objecttransfer.ErrAlreadyExists) {
			return handler.verifyPublishedFile(ctx, *file.VerifyURL, file.ByteLength, file.SHA256)
		}
		return err
	}
	if err := objecttransfer.VerifyDigest(digest, file.SHA256); err != nil {
		return err
	}
	return handler.verifyPublishedFile(ctx, *file.VerifyURL, file.ByteLength, file.SHA256)
}

func fileVersionKey(itemID string, version int) string { return itemID + "/" + strconv.Itoa(version) }

func (handler *Handler) verifyPublishedFile(ctx context.Context, sourceURL string, size int64, expectedDigest string) error {
	download, err := handler.transfer.Download(ctx, sourceURL, handler.limits.MaxSourceBytes)
	if err != nil {
		return jobrunner.Retry("import_file_verification_failed", err)
	}
	written, copyErr := io.Copy(io.Discard, download.Body)
	closeErr := download.Body.Close()
	if copyErr != nil {
		return jobrunner.Retry("import_file_verification_failed", copyErr)
	}
	if closeErr != nil {
		return jobrunner.Retry("import_file_verification_failed", closeErr)
	}
	if written != size || objecttransfer.VerifyDigest(download.Digest, expectedDigest) != nil {
		return jobrunner.Fail("import_file_publication_conflict", errors.New("the immutable destination contains different bytes"))
	}
	return nil
}

func (handler *Handler) reject(ctx context.Context, importID, code string, cause error) error {
	cleanupContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
	defer cancel()
	if err := handler.api.RejectDocumentImport(cleanupContext, importID, code); err != nil {
		return apiFailure("import_rejection_failed", err)
	}
	return jobrunner.Fail(code, cause)
}

type localObject struct {
	path   string
	size   int64
	sha256 string
}

func (object localObject) remove() { _ = os.Remove(object.path) }

func (handler *Handler) download(ctx context.Context, sourceURL string, maximum int64) (localObject, error) {
	download, err := handler.transfer.Download(ctx, sourceURL, maximum)
	if err != nil {
		return localObject{}, err
	}
	file, err := worktemp.Create("nix-document-import-*")
	if err != nil {
		_ = download.Body.Close()
		return localObject{}, err
	}
	path := file.Name()
	keep := false
	defer func() {
		if !keep {
			_ = os.Remove(path)
		}
	}()
	written, copyErr := io.Copy(file, download.Body)
	closeBodyErr := download.Body.Close()
	closeFileErr := file.Close()
	if copyErr != nil {
		return localObject{}, copyErr
	}
	if closeBodyErr != nil {
		return localObject{}, closeBodyErr
	}
	if closeFileErr != nil {
		return localObject{}, closeFileErr
	}
	keep = true
	return localObject{path: path, size: written, sha256: hex.EncodeToString(download.Digest.Sum(nil))}, nil
}

func stageItem(item importplan.Item) workerapi.DocumentImportStageItem {
	result := workerapi.DocumentImportStageItem{
		SourceID: item.SourceID, ParentSourceID: item.ParentSourceID, Order: item.Order,
		Title: item.Title, ItemType: item.ItemType, Properties: item.Properties,
		Schema: item.Schema, Views: item.Views, FinalLifecycleState: item.FinalLifecycleState,
		BodyRequired: item.Body != nil,
	}
	if item.File != nil {
		result.File = &workerapi.DocumentImportFile{
			SourceKind: item.File.SourceKind, AssetPath: item.File.AssetPath, FileName: item.File.FileName,
			MediaType: item.File.MediaType, ByteLength: item.File.ByteLength, SHA256: item.File.SHA256,
			Previewable: item.File.Previewable, PixelWidth: item.File.PixelWidth, PixelHeight: item.File.PixelHeight,
		}
	}
	return result
}

type bodyWrite struct {
	SourceID string          `json:"sourceId"`
	Body     importplan.Body `json:"body"`
}

func bodyWrites(plan importplan.Plan) []bodyWrite {
	writes := make([]bodyWrite, 0, len(plan.Items))
	for _, item := range plan.Items {
		if item.Body != nil {
			writes = append(writes, bodyWrite{SourceID: item.SourceID, Body: *item.Body})
		}
	}
	return writes
}

func assetCount(plan importplan.Plan) int {
	count := 0
	for _, item := range plan.Items {
		if item.File != nil && item.File.SourceKind == "asset" {
			count++
		}
	}
	return count
}

func decodePayload(raw json.RawMessage) (Payload, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var payload Payload
	if err := decoder.Decode(&payload); err != nil {
		return Payload{}, err
	}
	if payload.ImportID == "" || len(payload.ImportID) > 64 {
		return Payload{}, errors.New("importId is required")
	}
	return payload, nil
}

func importFailureCode(err error) string {
	switch {
	case errors.Is(err, importplan.ErrOCRUnavailable):
		return "import_ocr_unavailable"
	case errors.Is(err, importplan.ErrEncryptedPDF):
		return "import_pdf_encrypted"
	case errors.Is(err, importplan.ErrUnsupportedFormat):
		return "import_format_unsupported"
	default:
		return "import_source_invalid"
	}
}

func apiFailure(code string, err error) error {
	var response *workerapi.ResponseError
	if errors.As(err, &response) && response.Status == http.StatusConflict {
		return err
	}
	if errors.As(err, &response) && response.Status < 500 {
		return jobrunner.Fail(code, err)
	}
	return jobrunner.Retry(code, err)
}

func retryableOrLeaseLost(err error) bool {
	var response *workerapi.ResponseError
	if errors.As(err, &response) && response.Status == http.StatusConflict {
		return true
	}
	var typed *jobrunner.JobError
	return errors.As(err, &typed) && typed.Retryable
}

func nonNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

type collaborationClient struct {
	baseURL, secret string
	httpClient      *http.Client
}

func newCollaborationClient(baseURL, secret string, timeout time.Duration) (*collaborationClient, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || secret == "" || timeout <= 0 {
		return nil, errors.New("collaboration import client configuration is invalid")
	}
	return &collaborationClient{
		baseURL: strings.TrimRight(baseURL, "/"), secret: secret,
		httpClient: &http.Client{Timeout: timeout, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }},
	}, nil
}

func (client *collaborationClient) Write(ctx context.Context, importID string, writes []bodyWrite) error {
	body, err := json.Marshal(struct {
		Writes []bodyWrite `json:"writes"`
	}{writes})
	if err != nil {
		return err
	}
	jobID, executionID, ok := workerapi.Execution(ctx)
	if !ok {
		return errors.New("worker execution context is missing")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.baseURL+"/internal/imports/"+url.PathEscape(importID)+"/bodies", bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Nix-Internal-Secret", client.secret)
	request.Header.Set("X-Nix-Worker-Job-Id", jobID)
	request.Header.Set("X-Nix-Worker-Execution-Id", executionID)
	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &workerapi.ResponseError{Status: response.StatusCode, Path: request.URL.Path}
	}
	return nil
}

var _ jobrunner.Handler = (*Handler)(nil)
