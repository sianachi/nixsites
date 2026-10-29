package importplan

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
)

const (
	nixArchiveFormat      = "nix-archive"
	nixArchiveVersion     = 1
	nixArchiveFileVersion = 2
	nixSchemaMinimum      = 1
	// Keep this in lockstep with @nix/editor-schema's SCHEMA_VERSION. The importer
	// preserves newer ProseMirror content opaquely after checking the body envelope.
	nixSchemaMaximum = 7
)

var archiveIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type nixManifest struct {
	Format              string                        `json:"format"`
	FormatVersion       int                           `json:"formatVersion"`
	SchemaVersion       int                           `json:"schemaVersion"`
	Profile             json.RawMessage               `json:"profile,omitempty"`
	ExportedAt          string                        `json:"exportedAt"`
	Root                string                        `json:"root"`
	RootEffectiveSchema *nixSchemaSnapshot            `json:"rootEffectiveSchema"`
	IncludesDeleted     bool                          `json:"includesDeleted"`
	Items               []nixManifestItem             `json:"items"`
	Files               []nixarchive.FileVersionEntry `json:"files,omitempty"`
	Omitted             []nixOmission                 `json:"omitted"`
	Loss                []nixLoss                     `json:"loss"`
}

type nixManifestItem struct {
	ID       string  `json:"id"`
	ParentID *string `json:"parentId"`
	Sequence string  `json:"seq"`
	Title    string  `json:"title"`
	Type     string  `json:"type"`
}

type nixOmission struct {
	ID       *string `json:"id"`
	ParentID string  `json:"parentId"`
	Reason   string  `json:"reason"`
	Detail   string  `json:"detail"`
}

type nixLoss struct {
	ItemID string `json:"itemId"`
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

type nixSchemaSnapshot struct {
	Properties json.RawMessage `json:"properties"`
	Declared   json.RawMessage `json:"declared"`
	Inherit    bool            `json:"inherit"`
}

type nixSchemaProperty struct {
	Key        string   `json:"key"`
	Type       string   `json:"type"`
	Options    []string `json:"options"`
	Required   bool     `json:"required"`
	Expression *string  `json:"expression"`
	Aggregate  *string  `json:"aggregate"`
	Source     *string  `json:"source"`
}

var nixPropertyTypes = map[string]struct{}{
	"text": {}, "number": {}, "select": {}, "multi_select": {}, "date": {}, "checkbox": {},
	"url": {}, "timestamp": {}, "image": {}, "due_date": {}, "start_date": {},
	"completion": {}, "priority": {}, "estimate": {}, "assignee": {}, "long_text": {},
	"formula": {}, "rollup": {}, "datetime": {}, "reminder": {},
}

type nixBundle struct {
	ID                string             `json:"id"`
	ParentID          *string            `json:"parentId"`
	WorkspaceID       string             `json:"workspaceId"`
	Type              string             `json:"type"`
	Title             string             `json:"title"`
	Sequence          string             `json:"seq"`
	LifecycleState    string             `json:"lifecycleState"`
	CreatedAt         string             `json:"createdAt"`
	UpdatedAt         string             `json:"updatedAt"`
	Properties        json.RawMessage    `json:"properties"`
	Recurrence        json.RawMessage    `json:"recurrence,omitempty"`
	Schema            *nixSchemaSnapshot `json:"schema"`
	Views             json.RawMessage    `json:"views"`
	ViewRows          json.RawMessage    `json:"viewRows"`
	ViewRowsTruncated bool               `json:"viewRowsTruncated"`
	Body              json.RawMessage    `json:"body"`
	Comments          json.RawMessage    `json:"comments,omitempty"`
}

type validatedNixItem struct {
	manifest nixManifestItem
	bundle   nixBundle
}

type validatedNixArchive struct {
	manifest nixManifest
	items    []validatedNixItem
	files    []nixarchive.FileVersionEntry
}

func parseNix(ctx context.Context, source Source, limits Limits) (Plan, error) {
	parsed, err := validateNixArchive(ctx, source, limits)
	if err != nil {
		return Plan{}, err
	}

	items := make([]Item, 0, len(parsed.items))
	orders := make(map[string]int)
	for _, parsedItem := range parsed.items {
		entry := parsedItem.manifest
		bundle := parsedItem.bundle
		parentKey := "$root"
		if entry.ParentID != nil {
			parentKey = *entry.ParentID
		}
		order := orders[parentKey]
		orders[parentKey] = order + 1
		planItem := Item{
			SourceID: entry.ID, ParentSourceID: entry.ParentID, Order: order,
			Title: bundle.Title, ItemType: bundle.Type, Properties: cloneJSON(bundle.Properties),
			Recurrence: cloneNullableJSON(bundle.Recurrence),
			Schema:     importNixSchema(entry.ID == parsed.manifest.Root, parsed.manifest.RootEffectiveSchema, bundle.Schema),
			Views:      cloneNullableJSON(bundle.Views), FinalLifecycleState: bundle.LifecycleState,
			Comments: cloneNullableJSON(bundle.Comments),
		}
		if !isJSONNull(bundle.Body) {
			planItem.Body = &Body{Encoding: "archive", Archive: cloneJSON(bundle.Body)}
		}
		items = append(items, planItem)
	}

	loss := make([]string, 0, len(parsed.manifest.Loss))
	for _, value := range parsed.manifest.Loss {
		loss = append(loss, value.Kind+": "+value.Detail)
	}
	omissions := make([]string, 0, len(parsed.manifest.Omitted))
	for _, value := range parsed.manifest.Omitted {
		omissions = append(omissions, value.Reason+": "+value.Detail)
	}
	return Plan{
		Version: Version, Format: "nix", Title: source.Title, SourceSHA256: source.SHA256,
		Items: items, FileVersions: parsed.files, Loss: loss, Omissions: omissions,
	}, nil
}

func validateNixArchive(ctx context.Context, source Source, limits Limits) (validatedNixArchive, error) {
	if err := ctx.Err(); err != nil {
		return validatedNixArchive{}, err
	}
	archive, err := openNixArchive(source, limits)
	if err != nil {
		return validatedNixArchive{}, fmt.Errorf("open Nix archive: %w", err)
	}
	defer archive.Close()
	if len(archive.File) == 0 || archive.File[0].Name != "manifest.json" {
		return validatedNixArchive{}, errors.New("the first Nix archive entry must be manifest.json")
	}

	manifestBody, err := readEntry(archive, "manifest.json", limits.MaxEntryBytes)
	if err != nil {
		return validatedNixArchive{}, err
	}
	var manifest nixManifest
	if err := decodeStrictJSON(manifestBody, &manifest); err != nil {
		return validatedNixArchive{}, fmt.Errorf("decode Nix manifest: %w", err)
	}
	if manifest.FormatVersion == nixArchiveVersion && hasJSONProperty(manifestBody, "files") {
		return validatedNixArchive{}, errors.New("Nix archive v1 must not declare file-version entries")
	}
	if err := validateNixManifest(manifest, limits); err != nil {
		return validatedNixArchive{}, err
	}
	if len(archive.File) != len(manifest.Items)+len(manifest.Files)+1 {
		return validatedNixArchive{}, errors.New("the Nix archive contains unlisted or missing entries")
	}

	bundles := make(map[string]nixBundle, len(manifest.Items))
	expectedFiles := make(map[string]nixarchive.FileVersionEntry, len(manifest.Files))
	for _, file := range manifest.Files {
		expectedFiles[nixFileVersionEntryName(file.ItemID, file.Version)] = file
	}
	seenEntries := map[string]bool{"manifest.json": true}
	for _, entry := range archive.File[1:] {
		if err := ctx.Err(); err != nil {
			return validatedNixArchive{}, err
		}
		if seenEntries[entry.Name] {
			return validatedNixArchive{}, fmt.Errorf("the Nix archive contains duplicate entry %q", entry.Name)
		}
		seenEntries[entry.Name] = true
		if isNixFileVersionPath(entry.Name) {
			file, ok := expectedFiles[entry.Name]
			if !ok {
				return validatedNixArchive{}, fmt.Errorf("the Nix archive contains an undeclared file-version entry %q", entry.Name)
			}
			if err := verifyNixFileVersion(ctx, entry, file); err != nil {
				return validatedNixArchive{}, fmt.Errorf("Nix file %s/%d: %w", file.ItemID, file.Version, err)
			}
			delete(expectedFiles, entry.Name)
			continue
		}
		id, ok := nixItemIDFromEntry(entry.Name)
		if !ok {
			return validatedNixArchive{}, fmt.Errorf("the Nix archive entry %q is not supported", entry.Name)
		}
		body, readErr := readEntry(archive, entry.Name, limits.MaxEntryBytes)
		if readErr != nil {
			return validatedNixArchive{}, readErr
		}
		var bundle nixBundle
		if decodeErr := decodeStrictJSON(body, &bundle); decodeErr != nil {
			return validatedNixArchive{}, fmt.Errorf("decode Nix item %s: %w", id, decodeErr)
		}
		if bundle.ID != id || bundles[id].ID != "" {
			return validatedNixArchive{}, fmt.Errorf("the Nix archive contains a duplicate or mismatched item %s", id)
		}
		bundles[id] = bundle
	}
	if len(expectedFiles) != 0 {
		return validatedNixArchive{}, errors.New("the Nix archive is missing a declared file-version entry")
	}

	items := make([]validatedNixItem, 0, len(manifest.Items))
	depths := make(map[string]int, len(manifest.Items))
	seen := make(map[string]bool, len(manifest.Items))
	for _, entry := range manifest.Items {
		if err := ctx.Err(); err != nil {
			return validatedNixArchive{}, err
		}
		bundle, ok := bundles[entry.ID]
		if !ok {
			return validatedNixArchive{}, fmt.Errorf("the Nix archive has no payload for item %s", entry.ID)
		}
		if seen[entry.ID] || bundle.ParentID == nil != (entry.ParentID == nil) || !sameOptionalString(bundle.ParentID, entry.ParentID) ||
			bundle.Sequence != entry.Sequence || bundle.Type != entry.Type || bundle.Title != entry.Title {
			return validatedNixArchive{}, fmt.Errorf("the Nix payload for item %s disagrees with its manifest", entry.ID)
		}
		if entry.ID == manifest.Root {
			if entry.ParentID != nil {
				return validatedNixArchive{}, errors.New("the Nix archive root has a parent")
			}
		} else if entry.ParentID == nil || !seen[*entry.ParentID] {
			return validatedNixArchive{}, fmt.Errorf("Nix item %s does not follow its parent", entry.ID)
		}
		depth := 0
		if entry.ParentID != nil {
			depth = depths[*entry.ParentID] + 1
		}
		if depth > limits.MaxDepth {
			return validatedNixArchive{}, errors.New("the Nix archive tree is too deep")
		}
		depths[entry.ID] = depth
		seen[entry.ID] = true

		lifecycle := bundle.LifecycleState
		if lifecycle != "active" && lifecycle != "deleted" {
			return validatedNixArchive{}, fmt.Errorf("Nix item %s has an unsupported lifecycle state", entry.ID)
		}
		if err := validateNixBundle(bundle, manifest.SchemaVersion, limits); err != nil {
			return validatedNixArchive{}, fmt.Errorf("Nix item %s: %w", entry.ID, err)
		}
		items = append(items, validatedNixItem{manifest: entry, bundle: bundle})
	}
	if !seen[manifest.Root] {
		return validatedNixArchive{}, errors.New("the Nix archive root is not listed")
	}
	return validatedNixArchive{manifest: manifest, items: items, files: manifest.Files}, nil
}

func validateNixManifest(manifest nixManifest, limits Limits) error {
	if manifest.Format != nixArchiveFormat || manifest.FormatVersion != nixArchiveVersion && manifest.FormatVersion != nixArchiveFileVersion {
		return errors.New("the Nix archive format or version is unsupported")
	}
	if manifest.SchemaVersion < nixSchemaMinimum || manifest.SchemaVersion > nixSchemaMaximum {
		return errors.New("the Nix archive editor schema is unsupported")
	}
	if !validArchiveID(manifest.Root) || manifest.ExportedAt == "" || len(manifest.Items) == 0 || len(manifest.Items) > limits.MaxItems {
		return errors.New("the Nix archive manifest is incomplete or exceeds the item limit")
	}
	if len(manifest.Omitted) > limits.MaxItems || len(manifest.Loss) > limits.MaxItems {
		return errors.New("the Nix archive report exceeds the item limit")
	}
	if manifest.RootEffectiveSchema != nil {
		if err := validateNixSchema(manifest.RootEffectiveSchema); err != nil {
			return fmt.Errorf("root effective schema: %w", err)
		}
	}
	if manifest.FormatVersion == nixArchiveVersion {
		if manifest.Files != nil {
			return errors.New("Nix archive v1 must not declare file-version entries")
		}
	} else {
		if manifest.Files == nil {
			return errors.New("Nix archive v2 must declare file-version entries")
		}
		if len(manifest.Files) > limits.MaxItems*nixarchive.MaxFileVersionsPerItem {
			return errors.New("the Nix archive declares too many file versions")
		}
		items := make([]nixarchive.ManifestItem, 0, len(manifest.Items))
		for _, item := range manifest.Items {
			items = append(items, nixarchive.ManifestItem{ID: item.ID, Type: item.Type})
		}
		if err := nixarchive.ValidateFileVersions(manifest.Files, items); err != nil {
			return err
		}
	}
	for _, entry := range manifest.Items {
		if !validArchiveID(entry.ID) || (entry.ParentID != nil && !validArchiveID(*entry.ParentID)) ||
			!validIntegerString(entry.Sequence) || len(entry.Title) > 500 || strings.TrimSpace(entry.Type) == "" || len(entry.Type) > 64 {
			return errors.New("the Nix archive manifest contains an invalid item")
		}
	}
	for _, value := range manifest.Omitted {
		if !validArchiveID(value.ParentID) || (value.ID != nil && !validArchiveID(*value.ID)) ||
			(value.Reason != "not-readable" && value.Reason != "soft-deleted" && value.Reason != "limit-reached") || len(value.Detail) > 1000 {
			return errors.New("the Nix archive manifest contains an invalid omission")
		}
	}
	for _, value := range manifest.Loss {
		if !validArchiveID(value.ItemID) || strings.TrimSpace(value.Kind) == "" || len(value.Kind) > 100 || len(value.Detail) > 1000 {
			return errors.New("the Nix archive manifest contains an invalid loss entry")
		}
	}
	return nil
}

func validateNixBundle(bundle nixBundle, manifestSchema int, limits Limits) error {
	if !validArchiveID(bundle.ID) || !validArchiveID(bundle.WorkspaceID) ||
		(bundle.ParentID != nil && !validArchiveID(*bundle.ParentID)) || !validIntegerString(bundle.Sequence) ||
		strings.TrimSpace(bundle.Type) == "" || len(bundle.Type) > 64 || len(bundle.Title) > 500 ||
		!isJSONObject(bundle.Properties) || !isJSONArray(bundle.ViewRows) || len(bundle.Body) > int(limits.MaxBodyBytes) {
		return errors.New("the item envelope is invalid")
	}
	if bundle.Schema != nil {
		if err := validateNixSchema(bundle.Schema); err != nil {
			return err
		}
	}
	if !isJSONNull(bundle.Views) && !isJSONObject(bundle.Views) {
		return errors.New("the item views are invalid")
	}
	if !isJSONNull(bundle.Body) {
		var body struct {
			SchemaVersion int             `json:"schemaVersion"`
			ProseMirror   json.RawMessage `json:"prosemirror"`
			Sheet         json.RawMessage `json:"sheet"`
			Canvas        json.RawMessage `json:"canvas"`
		}
		if err := decodeStrictJSON(bundle.Body, &body); err != nil || body.SchemaVersion < 1 {
			return errors.New("the item body is invalid")
		}
		expected := body.ProseMirror
		if bundle.Type == "canvas" {
			expected = body.Canvas
		} else if bundle.Type == "sheet" || bundle.Type == "spreadsheet" {
			expected = body.Sheet
		}
		if !isJSONObject(expected) || (bundle.Type != "sheet" && bundle.Type != "spreadsheet" && body.SchemaVersion > manifestSchema) {
			return errors.New("the item body does not match its type or schema")
		}
	}
	return nil
}

func validateNixSchema(schema *nixSchemaSnapshot) error {
	for _, encoded := range []json.RawMessage{schema.Properties, schema.Declared} {
		if !isJSONArray(encoded) {
			return errors.New("the property schema is invalid")
		}
		var properties []nixSchemaProperty
		if err := json.Unmarshal(encoded, &properties); err != nil {
			return errors.New("the property schema is invalid")
		}
		for _, property := range properties {
			if strings.TrimSpace(property.Key) == "" {
				return errors.New("the property schema contains an invalid property")
			}
			if _, ok := nixPropertyTypes[property.Type]; !ok {
				return fmt.Errorf("the property schema contains unsupported type %q", property.Type)
			}
			if property.Type == "formula" {
				if property.Expression == nil || strings.TrimSpace(*property.Expression) == "" ||
					len(utf16.Encode([]rune(*property.Expression))) > 1024 {
					return fmt.Errorf("the formula property %q needs an expression of at most 1024 characters", property.Key)
				}
			} else if property.Expression != nil {
				return fmt.Errorf("the non-formula property %q contains an expression", property.Key)
			}
			if property.Type == "rollup" {
				if property.Aggregate == nil {
					return fmt.Errorf("the rollup property %q needs an aggregate", property.Key)
				}
				switch *property.Aggregate {
				case "count", "sum", "min", "max", "average", "any", "all":
				default:
					return fmt.Errorf("the rollup property %q contains an unsupported aggregate", property.Key)
				}
				if property.Source == nil && *property.Aggregate != "count" || property.Source != nil &&
					(strings.TrimSpace(*property.Source) == "" || *property.Source == property.Key) {
					return fmt.Errorf("the rollup property %q needs a valid source property", property.Key)
				}
			} else if property.Aggregate != nil || property.Source != nil {
				return fmt.Errorf("the non-rollup property %q contains aggregate or source metadata", property.Key)
			}
			if (property.Type == "formula" || property.Type == "rollup") && (property.Required || len(property.Options) != 0) {
				return fmt.Errorf("the computed property %q cannot be required or contain options", property.Key)
			}
		}
	}
	return nil
}

func importNixSchema(root bool, effective, declared *nixSchemaSnapshot) json.RawMessage {
	selected := declared
	if root && effective != nil {
		selected = effective
	}
	if selected == nil {
		return nil
	}
	properties := selected.Declared
	inherit := selected.Inherit
	if root {
		properties = selected.Properties
		inherit = false
	}
	body, _ := json.Marshal(struct {
		Properties json.RawMessage `json:"properties"`
		Inherit    bool            `json:"inherit"`
	}{Properties: cloneJSON(properties), Inherit: inherit})
	return body
}

func decodeStrictJSON(body []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON contains multiple values")
		}
		return err
	}
	return nil
}

func nixItemIDFromEntry(name string) (string, bool) {
	if !strings.HasPrefix(name, "items/") || !strings.HasSuffix(name, ".json") {
		return "", false
	}
	id := strings.TrimSuffix(strings.TrimPrefix(name, "items/"), ".json")
	return id, validArchiveID(id)
}

func validArchiveID(value string) bool { return archiveIDPattern.MatchString(value) }

func validIntegerString(value string) bool {
	if value == "" {
		return false
	}
	_, err := strconv.ParseInt(value, 10, 64)
	return err == nil
}

func sameOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func isJSONNull(value json.RawMessage) bool {
	return len(value) == 0 || bytes.Equal(bytes.TrimSpace(value), []byte("null"))
}

func isJSONObject(value json.RawMessage) bool {
	trimmed := bytes.TrimSpace(value)
	return len(trimmed) >= 2 && trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}' && json.Valid(trimmed)
}

func isJSONArray(value json.RawMessage) bool {
	trimmed := bytes.TrimSpace(value)
	return len(trimmed) >= 2 && trimmed[0] == '[' && trimmed[len(trimmed)-1] == ']' && json.Valid(trimmed)
}

func cloneJSON(value json.RawMessage) json.RawMessage { return append(json.RawMessage(nil), value...) }

func cloneNullableJSON(value json.RawMessage) json.RawMessage {
	if isJSONNull(value) {
		return nil
	}
	return cloneJSON(value)
}
