package templateimport

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/importplan"
	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
	"github.com/sianachi/Nix/apps/go-workers/internal/worktemp"
)

var (
	Kinds         = []string{"template.preview", "template.commit"}
	uuidPattern   = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	digestPattern = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)
)

type Payload struct {
	ImportID string `json:"importId"`
}

type PreviewResult struct {
	ImportID     string `json:"importId"`
	StableKey    string `json:"stableKey"`
	RootItemType string `json:"rootItemType"`
	ItemCount    int    `json:"itemCount"`
	BodyCount    int    `json:"bodyCount"`
	ViewCount    int    `json:"viewCount"`
	SourceSHA256 string `json:"sourceSha256"`
	PlanSHA256   string `json:"planSha256"`
}

type CommitResult struct {
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
	if api == nil || transfer == nil || limits.MaxSourceBytes <= 0 || limits.MaxPlanBytes <= 0 || limits.MaxBodyBytes <= 0 || limits.MaxEntryBytes <= 0 || limits.MaxItems <= 0 || limits.MaxDepth <= 0 {
		return nil, errors.New("template import handler configuration is invalid")
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
		return nil, jobrunner.Fail("template_payload_invalid", err)
	}
	switch job.Kind {
	case "template.preview":
		return handler.preview(ctx, payload.ImportID)
	case "template.commit":
		return handler.commit(ctx, payload.ImportID)
	default:
		return nil, jobrunner.Fail("template_kind_mismatch", errors.New("job kind is not a template import operation"))
	}
}

func (handler *Handler) preview(ctx context.Context, importID string) (any, error) {
	preview, err := handler.api.GetTemplateImportPreview(ctx, importID)
	if err != nil {
		return nil, handler.apiError(ctx, importID, "template_preview_unavailable", err)
	}
	if err := validatePreview(importID, preview); err != nil {
		return nil, handler.reject(ctx, importID, "template_preview_invalid", err)
	}
	source, err := handler.download(ctx, preview.SourceURL, handler.limits.MaxSourceBytes)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(err, objecttransfer.ErrTooLarge) {
			return nil, handler.reject(ctx, importID, "template_source_too_large", err)
		}
		return nil, jobrunner.Retry("template_source_unavailable", err)
	}
	defer source.remove()
	if source.size != preview.DeclaredByteLength {
		return nil, handler.reject(ctx, importID, "template_size_mismatch", errors.New("uploaded template size does not match its declaration"))
	}
	plan, err := importplan.ParseTemplate(ctx, templateSource(source, preview.FileName, preview.DeclaredMediaType), handler.limits)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, handler.reject(ctx, importID, "template_archive_invalid", err)
	}
	planBody, planDigest, err := importplan.EncodeTemplate(plan, handler.limits.MaxPlanBytes)
	if err != nil {
		return nil, handler.reject(ctx, importID, "template_plan_invalid", err)
	}
	if err := handler.transfer.Upload(ctx, preview.PlanUploadURL, "application/json", bytes.NewReader(planBody), int64(len(planBody)), planDigest); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, jobrunner.Retry("template_plan_upload_failed", err)
	}
	profile, err := templateProfile(plan.Profile)
	if err != nil {
		return nil, handler.reject(ctx, importID, "template_profile_invalid", err)
	}
	completion := workerapi.CompleteTemplateImportPreview{
		Profile: profile, RootItemType: plan.RootItemType,
		ItemCount: plan.ItemCount, BodyCount: plan.BodyCount, ViewCount: plan.ViewCount,
		SourceSHA256: source.sha256, PlanSHA256: planDigest, PlanByteLength: int64(len(planBody)),
	}
	if err := handler.api.CompleteTemplateImportPreview(ctx, importID, completion); err != nil {
		return nil, handler.apiError(ctx, importID, "template_preview_completion_failed", err)
	}
	return PreviewResult{
		ImportID: importID, StableKey: plan.Profile.Key, RootItemType: plan.RootItemType,
		ItemCount: plan.ItemCount, BodyCount: plan.BodyCount, ViewCount: plan.ViewCount,
		SourceSHA256: source.sha256, PlanSHA256: planDigest,
	}, nil
}

func (handler *Handler) commit(ctx context.Context, importID string) (any, error) {
	commit, err := handler.api.GetTemplateImportCommit(ctx, importID)
	if err != nil {
		return nil, handler.apiError(ctx, importID, "template_commit_unavailable", err)
	}
	if commit != nil && commit.CompletedResult != nil {
		if err := validateTerminalResult(importID, commit.CompletedResult); err != nil {
			return nil, jobrunner.Fail("template_completion_invalid", err)
		}
		return commitResult(commit.CompletedResult), nil
	}
	if err := validateCommit(importID, commit, handler.limits); err != nil {
		return nil, handler.reject(ctx, importID, "template_commit_invalid", err)
	}
	source, err := handler.download(ctx, commit.SourceURL, handler.limits.MaxSourceBytes)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(err, objecttransfer.ErrTooLarge) {
			return nil, handler.reject(ctx, importID, "template_source_too_large", err)
		}
		return nil, jobrunner.Retry("template_source_unavailable", err)
	}
	defer source.remove()
	if source.size != commit.DeclaredByteLength || !strings.EqualFold(source.sha256, commit.SourceSHA256) {
		return nil, handler.reject(ctx, importID, "template.file_changed", errors.New("the template source changed after preview"))
	}
	planned, err := handler.download(ctx, commit.PlanURL, handler.limits.MaxPlanBytes)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(err, objecttransfer.ErrTooLarge) {
			return nil, handler.reject(ctx, importID, "template_plan_invalid", err)
		}
		return nil, jobrunner.Retry("template_plan_unavailable", err)
	}
	defer planned.remove()
	if planned.size != commit.PlanByteLength || !strings.EqualFold(planned.sha256, commit.PlanSHA256) {
		return nil, handler.reject(ctx, importID, "template_plan_changed", errors.New("the template plan changed after preview"))
	}
	planBody, err := os.ReadFile(planned.path)
	if err != nil {
		return nil, jobrunner.Retry("template_plan_unavailable", err)
	}
	plan, err := importplan.DecodeTemplate(planBody, commit.PlanSHA256, handler.limits)
	if err != nil {
		return nil, handler.reject(ctx, importID, "template_plan_invalid", err)
	}
	if !strings.EqualFold(plan.SourceSHA256, commit.SourceSHA256) {
		return nil, handler.reject(ctx, importID, "template_plan_mismatch", errors.New("the template plan does not describe this source"))
	}
	request, err := stageRequest(plan)
	if err != nil {
		return nil, handler.reject(ctx, importID, "template_plan_invalid", err)
	}
	stage, err := handler.api.StageTemplateImport(ctx, importID, request)
	if err != nil {
		return nil, handler.apiError(ctx, importID, "template_stage_failed", err)
	}
	if err := validateStage(importID, stage, plan); err != nil {
		return nil, handler.reject(ctx, importID, "template_stage_invalid", err)
	}
	writes := []collaborationBodyWrite{}
	expectedIDs := []string{}
	if !stage.Unchanged {
		writes, expectedIDs, err = bodyWrites(plan, stage.BodyWrites)
		if err != nil {
			return nil, handler.reject(ctx, importID, "template_stage_invalid", err)
		}
	}
	writtenIDs := []string{}
	if len(writes) != 0 {
		writtenIDs, err = handler.collab.Write(ctx, importID, writes, handler.limits.MaxPlanBytes+int64(len(writes))*256)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			var response *workerapi.ResponseError
			if errors.As(err, &response) && response.Status == http.StatusConflict && response.Code == "worker.execution_refused" {
				return nil, err
			}
			if !errors.As(err, &response) || response.Status >= 500 {
				return nil, jobrunner.Retry("template_body_write_failed", err)
			}
			return nil, handler.reject(ctx, importID, "template_body_invalid", err)
		}
		if !sameStringSet(writtenIDs, expectedIDs) {
			return nil, handler.reject(ctx, importID, "template_body_write_invalid", errors.New("Collaboration did not confirm every staged template body"))
		}
	}
	if !stage.Unchanged && len(plan.Files) > 0 {
		if err := handler.transferTemplateFiles(ctx, importID, source.path, plan, stage); err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, err
		}
	}
	result, err := handler.api.CompleteTemplateImport(ctx, importID, workerapi.CompleteTemplateImportRequest{WrittenTargetItemIDs: writtenIDs})
	if err != nil {
		return nil, handler.apiError(ctx, importID, "template_completion_failed", err)
	}
	if err := validateResult(importID, result, stage, plan, writtenIDs); err != nil {
		return nil, jobrunner.Fail("template_completion_invalid", err)
	}
	return commitResult(result), nil
}

func (handler *Handler) transferTemplateFiles(ctx context.Context, importID, archivePath string, plan importplan.TemplatePlan, stage *workerapi.TemplateImportStage) error {
	archives, err := importplan.OpenNixArchiveFiles(archivePath, handler.limits)
	if err != nil {
		return jobrunner.Fail("template_file_archive_invalid", err)
	}
	defer archives.Close()
	expected := make(map[string]workerapi.TemplateImportStageFile, len(plan.Files))
	for _, file := range plan.Files {
		expected[fileVersionKey(file.ItemID, file.Version)] = workerapi.TemplateImportStageFile{
			SourceItemID: file.ItemID, Version: file.Version, FileName: file.FileName, MediaType: file.MediaType,
			ByteLength: file.ByteLength, SHA256: file.SHA256, Previewable: file.Previewable,
			PixelWidth: cloneInt(file.PixelWidth), PixelHeight: cloneInt(file.PixelHeight),
		}
	}
	transfers := make(map[string]workerapi.TemplateImportFileTransferMapping, len(stage.FileTransfers))
	for _, mapping := range stage.FileTransfers {
		transfers[fileVersionKey(mapping.SourceItemID, mapping.TargetVersion)] = mapping
	}
	seen := make(map[string]struct{}, len(expected))
	var after string
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		page, err := handler.api.GetTemplateImportFilePlan(ctx, importID, after, 100)
		if err != nil {
			return handler.apiError(ctx, importID, "template_file_capability_unavailable", err)
		}
		for _, file := range page.Files {
			key := fileVersionKey(file.SourceItemID, file.TargetVersion)
			descriptor, hasDescriptor := expected[key]
			mapping, hasMapping := transfers[key]
			if !hasDescriptor || !hasMapping || mapping.TransferID != file.TransferID || mapping.TargetItemID != file.TargetItemID ||
				file.FileName != descriptor.FileName || file.MediaType != descriptor.MediaType || file.ByteLength != descriptor.ByteLength || !strings.EqualFold(file.SHA256, descriptor.SHA256) {
				return jobrunner.Fail("template_file_capability_invalid", errors.New("Core returned a file capability that does not match the validated archive"))
			}
			if _, duplicate := seen[key]; duplicate {
				return jobrunner.Fail("template_file_capability_invalid", errors.New("Core returned a duplicate template file transfer"))
			}
			seen[key] = struct{}{}
			if file.Ready {
				continue
			}
			if err := handler.copyTemplateFile(ctx, archives, file); err != nil {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				return jobrunner.Retry("template_file_transfer_failed", err)
			}
			if err := handler.api.CompleteTemplateImportFileBatch(ctx, importID, []string{file.TransferID}); err != nil {
				return handler.apiError(ctx, importID, "template_file_transfer_completion_failed", err)
			}
		}
		if page.Complete {
			if len(seen) != len(expected) {
				return jobrunner.Fail("template_file_capability_invalid", errors.New("Core omitted one or more staged archive file versions"))
			}
			return nil
		}
		after = *page.NextAfterTransferID
	}
}

func (handler *Handler) copyTemplateFile(ctx context.Context, archive *importplan.NixArchiveFiles, file workerapi.TemplateImportFileCapability) error {
	if file.UploadURL == nil || file.VerifyURL == nil {
		return errors.New("Core omitted a staged template file capability")
	}
	if err := handler.verifyTemplateFile(ctx, *file.VerifyURL, file.ByteLength, file.SHA256); err == nil {
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
			return handler.verifyTemplateFile(ctx, *file.VerifyURL, file.ByteLength, file.SHA256)
		}
		return err
	}
	if err := objecttransfer.VerifyDigest(digest, file.SHA256); err != nil {
		return fmt.Errorf("archive file digest does not match its declaration: %w", err)
	}
	return handler.verifyTemplateFile(ctx, *file.VerifyURL, file.ByteLength, file.SHA256)
}

func (handler *Handler) verifyTemplateFile(ctx context.Context, rawURL string, expectedLength int64, expectedDigest string) error {
	maximum := expectedLength
	if maximum == 0 {
		maximum = 1
	}
	verified, err := handler.transfer.Download(ctx, rawURL, maximum)
	if err != nil {
		return fmt.Errorf("read staged template file for verification: %w", err)
	}
	defer verified.Body.Close()
	count, err := io.Copy(io.Discard, verified.Body)
	if err != nil {
		return fmt.Errorf("stream staged template file verification: %w", err)
	}
	if count != expectedLength {
		return errors.New("staged template file length differs from the archive")
	}
	return objecttransfer.VerifyDigest(verified.Digest, expectedDigest)
}

func validatePreview(importID string, preview *workerapi.TemplateImportPreview) error {
	if preview == nil || preview.ImportID != importID {
		return errors.New("Core returned template metadata for the wrong import")
	}
	return validateMetadata(
		preview.WorkspaceID, preview.Origin, preview.ManagedSource, preview.IdempotencyKey,
		preview.FileName, preview.DeclaredMediaType, preview.DeclaredByteLength,
		preview.SourceURL, preview.SourceDeleteURL, preview.PlanUploadURL, preview.PlanDeleteURL,
		preview.CapabilityExpires,
	)
}

func validateCommit(importID string, commit *workerapi.TemplateImportCommit, limits importplan.Limits) error {
	if commit == nil || commit.ImportID != importID {
		return errors.New("Core returned template metadata for the wrong import")
	}
	if err := validateMetadata(
		commit.WorkspaceID, commit.Origin, commit.ManagedSource, commit.IdempotencyKey,
		commit.FileName, commit.DeclaredMediaType, commit.DeclaredByteLength,
		commit.SourceURL, commit.SourceDeleteURL, commit.PlanUploadURL, commit.PlanDeleteURL,
		commit.CapabilityExpires,
	); err != nil {
		return err
	}
	if commit.PlanByteLength <= 0 || commit.PlanByteLength > limits.MaxPlanBytes || !digestPattern.MatchString(commit.PlanSHA256) || !digestPattern.MatchString(commit.SourceSHA256) || strings.TrimSpace(commit.PlanURL) == "" {
		return errors.New("Core returned invalid template plan metadata")
	}
	return nil
}

func validateMetadata(
	workspaceID, origin string,
	managedSource *string,
	idempotencyKey, fileName, mediaType string,
	byteLength int64,
	sourceURL, sourceDeleteURL, planUploadURL, planDeleteURL string,
	capabilityExpires time.Time,
) error {
	if !uuidPattern.MatchString(workspaceID) || byteLength < 0 || strings.TrimSpace(fileName) == "" || len(fileName) > 500 || strings.TrimSpace(mediaType) == "" || len(mediaType) > 200 || strings.TrimSpace(idempotencyKey) == "" || len(idempotencyKey) > 500 || sourceURL == "" || sourceDeleteURL == "" || planUploadURL == "" || planDeleteURL == "" || capabilityExpires.IsZero() {
		return errors.New("Core returned incomplete or invalid template import metadata")
	}
	switch origin {
	case "user":
		if managedSource != nil {
			return errors.New("a user template import cannot declare a managed source")
		}
	case "managed":
		if managedSource == nil || strings.TrimSpace(*managedSource) == "" || len(*managedSource) > 500 {
			return errors.New("a managed template import requires a bounded managed source")
		}
	default:
		return errors.New("template import origin is invalid")
	}
	return nil
}

func stageRequest(plan importplan.TemplatePlan) (workerapi.TemplateImportStageRequest, error) {
	profile, err := templateProfile(plan.Profile)
	if err != nil {
		return workerapi.TemplateImportStageRequest{}, err
	}
	request := workerapi.TemplateImportStageRequest{
		Profile: profile,
		Items:   make([]workerapi.TemplateImportStageItem, 0, len(plan.Items)),
		Files:   make([]workerapi.TemplateImportStageFile, 0, len(plan.Files)),
	}
	for _, item := range plan.Items {
		request.Items = append(request.Items, workerapi.TemplateImportStageItem{
			SourceID: item.SourceID, ParentSourceID: cloneString(item.ParentSourceID), Sequence: item.Sequence,
			Title: item.Title, ItemType: item.ItemType, Properties: cloneJSON(item.Properties),
			Schema: cloneJSON(item.Schema), Views: cloneJSON(item.Views), HasBody: !jsonNull(item.Body),
			Recurrence: cloneJSON(item.Recurrence),
		})
	}
	for _, file := range plan.Files {
		request.Files = append(request.Files, workerapi.TemplateImportStageFile{
			SourceItemID: file.ItemID, Version: file.Version, FileName: file.FileName, MediaType: file.MediaType,
			ByteLength: file.ByteLength, SHA256: file.SHA256, Previewable: file.Previewable,
			PixelWidth: cloneInt(file.PixelWidth), PixelHeight: cloneInt(file.PixelHeight),
		})
	}
	return request, nil
}

func validateStage(importID string, stage *workerapi.TemplateImportStage, plan importplan.TemplatePlan) error {
	if stage == nil || stage.ImportID != importID || !uuidPattern.MatchString(stage.TemplateID) || stage.StableKey != plan.Profile.Key || !strings.EqualFold(stage.Digest, plan.SourceSHA256) {
		return errors.New("Core returned an incomplete template stage")
	}
	itemTypes := make(map[string]string, len(plan.Items))
	for _, item := range plan.Items {
		itemTypes[item.SourceID] = item.ItemType
	}
	if len(stage.ItemMappings) != len(itemTypes) || !validMappings(stage.ItemMappings, itemTypes) {
		return errors.New("Core returned an invalid template item map")
	}
	itemTargets := make(map[string]string, len(stage.ItemMappings))
	for _, mapping := range stage.ItemMappings {
		itemTargets[mapping.SourceID] = mapping.TargetItemID
	}
	if stage.Unchanged {
		if stage.OperationID != nil || len(stage.BodyWrites) != 0 || len(stage.FileTransfers) != 0 {
			return errors.New("an unchanged template stage cannot request body writes")
		}
		return nil
	}
	if stage.OperationID == nil || !uuidPattern.MatchString(*stage.OperationID) {
		return errors.New("a changed template stage requires an operation identifier")
	}
	expected := make(map[string]string, plan.BodyCount)
	for _, item := range plan.Items {
		if !jsonNull(item.Body) {
			expected[item.SourceID] = item.ItemType
		}
	}
	if len(stage.BodyWrites) != len(expected) {
		return errors.New("Core returned an incomplete template body-write map")
	}
	if !validMappings(stage.BodyWrites, expected) {
		return errors.New("Core returned an invalid template body-write mapping")
	}
	for _, mapping := range stage.BodyWrites {
		if itemTargets[mapping.SourceID] != mapping.TargetItemID {
			return errors.New("Core template item and body-write maps disagree")
		}
	}
	expectedFiles := make(map[string]workerapi.TemplateImportStageFile, len(plan.Files))
	for _, file := range plan.Files {
		expectedFiles[fileVersionKey(file.ItemID, file.Version)] = workerapi.TemplateImportStageFile{SourceItemID: file.ItemID, Version: file.Version}
	}
	if len(stage.FileTransfers) != len(expectedFiles) {
		return errors.New("Core returned an incomplete template file-transfer map")
	}
	seenTransfers := make(map[string]struct{}, len(stage.FileTransfers))
	for _, mapping := range stage.FileTransfers {
		key := fileVersionKey(mapping.SourceItemID, mapping.TargetVersion)
		if _, ok := expectedFiles[key]; !ok || !uuidPattern.MatchString(mapping.TransferID) || itemTargets[mapping.SourceItemID] != mapping.TargetItemID {
			return errors.New("Core returned an invalid template file-transfer map")
		}
		if _, duplicate := seenTransfers[mapping.TransferID]; duplicate {
			return errors.New("Core returned duplicate template file-transfer identities")
		}
		seenTransfers[mapping.TransferID] = struct{}{}
	}
	return nil
}

func fileVersionKey(itemID string, version int) string { return fmt.Sprintf("%s/%d", itemID, version) }

func validMappings(mappings []workerapi.TemplateImportBodyWrite, expected map[string]string) bool {
	seenSources := make(map[string]struct{}, len(mappings))
	seenTargets := make(map[string]struct{}, len(mappings))
	for _, mapping := range mappings {
		itemType, ok := expected[mapping.SourceID]
		if !ok || itemType != mapping.ItemType || !uuidPattern.MatchString(mapping.TargetItemID) {
			return false
		}
		if _, duplicate := seenSources[mapping.SourceID]; duplicate {
			return false
		}
		if _, duplicate := seenTargets[mapping.TargetItemID]; duplicate {
			return false
		}
		seenSources[mapping.SourceID] = struct{}{}
		seenTargets[mapping.TargetItemID] = struct{}{}
	}
	return len(seenSources) == len(expected)
}

type collaborationBodyWrite struct {
	SourceID string          `json:"sourceId"`
	Body     json.RawMessage `json:"body"`
}

func bodyWrites(plan importplan.TemplatePlan, mappings []workerapi.TemplateImportBodyWrite) ([]collaborationBodyWrite, []string, error) {
	bySource := make(map[string]workerapi.TemplateImportBodyWrite, len(mappings))
	for _, mapping := range mappings {
		bySource[mapping.SourceID] = mapping
	}
	writes := make([]collaborationBodyWrite, 0, plan.BodyCount)
	targetIDs := make([]string, 0, plan.BodyCount)
	for _, item := range plan.Items {
		if jsonNull(item.Body) {
			continue
		}
		mapping, ok := bySource[item.SourceID]
		if !ok || mapping.ItemType != item.ItemType {
			return nil, nil, errors.New("template body mapping does not match the deterministic plan")
		}
		writes = append(writes, collaborationBodyWrite{
			SourceID: item.SourceID, Body: cloneJSON(item.Body),
		})
		targetIDs = append(targetIDs, mapping.TargetItemID)
	}
	return writes, targetIDs, nil
}

func validateResult(importID string, result *workerapi.TemplateImportResult, stage *workerapi.TemplateImportStage, plan importplan.TemplatePlan, writtenIDs []string) error {
	if result == nil || result.ImportID != importID || result.TemplateID != stage.TemplateID || result.StableKey != plan.Profile.Key || !strings.EqualFold(result.Digest, plan.SourceSHA256) || result.Unchanged != stage.Unchanged || result.ItemCount != plan.ItemCount || result.BodyCount != plan.BodyCount || !sameOptionalString(result.OperationID, stage.OperationID) || !sameStringSet(result.WrittenTargetItemIDs, writtenIDs) {
		return errors.New("Core did not confirm the completed template import")
	}
	return nil
}

func validateTerminalResult(importID string, result *workerapi.TemplateImportResult) error {
	if result == nil || result.ImportID != importID || !uuidPattern.MatchString(result.TemplateID) || strings.TrimSpace(result.StableKey) == "" || len(result.StableKey) > 160 || !digestPattern.MatchString(result.Digest) || result.ItemCount < 1 || result.ItemCount > 10_000 || result.BodyCount < 0 || result.BodyCount > result.ItemCount {
		return errors.New("Core returned an invalid durable template result")
	}
	if result.OperationID != nil && !uuidPattern.MatchString(*result.OperationID) {
		return errors.New("Core returned an invalid durable template operation")
	}
	if result.Unchanged && (result.OperationID != nil || len(result.WrittenTargetItemIDs) != 0) {
		return errors.New("an unchanged durable template result cannot contain writes")
	}
	if result.Unchanged {
		return nil
	}
	seen := make(map[string]struct{}, len(result.WrittenTargetItemIDs))
	for _, targetID := range result.WrittenTargetItemIDs {
		if !uuidPattern.MatchString(targetID) {
			return errors.New("Core returned an invalid durable template body target")
		}
		if _, duplicate := seen[targetID]; duplicate {
			return errors.New("Core returned duplicate durable template body targets")
		}
		seen[targetID] = struct{}{}
	}
	if len(seen) != result.BodyCount {
		return errors.New("Core returned an incomplete durable template body result")
	}
	return nil
}

func commitResult(result *workerapi.TemplateImportResult) CommitResult {
	return CommitResult{
		ImportID: result.ImportID, OperationID: cloneString(result.OperationID), TemplateID: result.TemplateID,
		StableKey: result.StableKey, Digest: result.Digest, Unchanged: result.Unchanged,
		ItemCount: result.ItemCount, BodyCount: result.BodyCount,
		WrittenTargetItemIDs: append([]string(nil), result.WrittenTargetItemIDs...),
	}
}

func templateProfile(profile importplan.TemplateProfile) (workerapi.TemplateImportProfile, error) {
	var initialization json.RawMessage
	if profile.Initialization != nil {
		var err error
		initialization, err = json.Marshal(profile.Initialization)
		if err != nil {
			return workerapi.TemplateImportProfile{}, fmt.Errorf("encode template initialization: %w", err)
		}
	}
	return workerapi.TemplateImportProfile{
		Kind: profile.Kind, Version: profile.Version, Key: profile.Key, Name: profile.Name,
		Description: profile.Description, IncludeBody: profile.IncludeBody, IncludeChildren: profile.IncludeChildren,
		Initialization: initialization,
	}, nil
}

func templateSource(object localObject, fileName, mediaType string) importplan.Source {
	return importplan.Source{
		Path: object.path, Format: "nix", Title: fileName, FileName: fileName,
		MediaType: mediaType, Bytes: object.size, SHA256: object.sha256,
	}
}

func decodePayload(raw json.RawMessage) (Payload, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var payload Payload
	if err := decoder.Decode(&payload); err != nil {
		return Payload{}, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return Payload{}, errors.New("payload contains multiple JSON values")
		}
		return Payload{}, err
	}
	if !uuidPattern.MatchString(payload.ImportID) {
		return Payload{}, errors.New("importId must be a UUID")
	}
	return payload, nil
}

func (handler *Handler) apiError(ctx context.Context, importID, code string, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var response *workerapi.ResponseError
	if errors.As(err, &response) {
		if response.Status == http.StatusConflict && response.Code == "worker.execution_refused" {
			return err
		}
		if response.Status < 500 {
			return handler.reject(ctx, importID, code, err)
		}
	}
	return jobrunner.Retry(code, err)
}

func (handler *Handler) reject(ctx context.Context, importID, code string, cause error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	cleanupContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
	defer cancel()
	if err := handler.api.RejectTemplateImport(cleanupContext, importID, code); err != nil {
		var response *workerapi.ResponseError
		if errors.As(err, &response) && response.Status == http.StatusConflict {
			return err
		}
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
	file, err := worktemp.Create("nix-template-import-*")
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

type collaborationClient struct {
	baseURL, secret string
	httpClient      *http.Client
}

func newCollaborationClient(baseURL, secret string, timeout time.Duration) (*collaborationClient, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") || strings.TrimSpace(secret) == "" || strings.ContainsAny(secret, "\r\n") || timeout <= 0 {
		return nil, errors.New("collaboration template import client configuration is invalid")
	}
	return &collaborationClient{
		baseURL: strings.TrimRight(baseURL, "/"), secret: secret,
		httpClient: &http.Client{Timeout: timeout, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }},
	}, nil
}

func (client *collaborationClient) Write(ctx context.Context, importID string, writes []collaborationBodyWrite, maximum int64) ([]string, error) {
	body, err := json.Marshal(struct {
		Writes []collaborationBodyWrite `json:"writes"`
	}{writes})
	if err != nil {
		return nil, err
	}
	if maximum <= 0 || int64(len(body)) > maximum {
		return nil, errors.New("template body-write request exceeds its configured byte limit")
	}
	jobID, executionID, ok := workerapi.Execution(ctx)
	if !ok {
		return nil, errors.New("worker execution context is missing")
	}
	path := "/internal/worker-executions/template-imports/" + url.PathEscape(importID) + "/bodies"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("X-Nix-Internal-Secret", client.secret)
	request.Header.Set("X-Nix-Worker-Job-Id", jobID)
	request.Header.Set("X-Nix-Worker-Execution-Id", executionID)
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, workerapi.ResponseErrorFrom(response, path)
	}
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(responseBody) > 1<<20 {
		return nil, errors.New("Collaboration template response exceeds its byte limit")
	}
	var result struct {
		WrittenTargetItemIDs []string `json:"writtenTargetItemIds"`
	}
	decoder := json.NewDecoder(bytes.NewReader(responseBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return nil, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("Collaboration returned multiple JSON values")
		}
		return nil, err
	}
	return result.WrittenTargetItemIDs, nil
}

func jsonNull(value json.RawMessage) bool {
	return len(value) == 0 || bytes.Equal(bytes.TrimSpace(value), []byte("null"))
}

func cloneJSON(value json.RawMessage) json.RawMessage {
	return append(json.RawMessage(nil), value...)
}

func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneInt(value *int) *int {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func sameOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func sameStringSet(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	values := make(map[string]int, len(left))
	for _, value := range left {
		if value == "" {
			return false
		}
		values[value]++
	}
	for _, value := range right {
		if values[value] == 0 {
			return false
		}
		values[value]--
	}
	return true
}

var _ jobrunner.Handler = (*Handler)(nil)
