package nixarchive

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

const (
	Format                          = "nix-archive"
	FormatVersion                   = 1
	FileFormatVersion               = 2
	MaxFileVersionsPerItem          = 100
	MaxArchiveEntries               = 100_001
	MaxArchiveItems                 = 10_000
	MaxTemplateArchiveEntries       = 20_201
	MaxTemplateArchiveItems         = 200
	MaxFileVersionBytes       int64 = 100 << 20
)

type Manifest struct {
	Raw                 json.RawMessage    `json:"-"`
	Format              string             `json:"format"`
	FormatVersion       int                `json:"formatVersion"`
	SchemaVersion       int                `json:"schemaVersion"`
	ExportedAt          string             `json:"exportedAt"`
	Root                string             `json:"root"`
	RootEffectiveSchema json.RawMessage    `json:"rootEffectiveSchema"`
	IncludesDeleted     bool               `json:"includesDeleted"`
	Items               []ManifestItem     `json:"items"`
	Files               []FileVersionEntry `json:"-"`
	Omitted             []Omission         `json:"omitted"`
	Loss                []LossEntry        `json:"loss"`
}

func (manifest Manifest) MarshalJSON() ([]byte, error) {
	type manifestWire struct {
		Format              string              `json:"format"`
		FormatVersion       int                 `json:"formatVersion"`
		SchemaVersion       int                 `json:"schemaVersion"`
		ExportedAt          string              `json:"exportedAt"`
		Root                string              `json:"root"`
		RootEffectiveSchema json.RawMessage     `json:"rootEffectiveSchema"`
		IncludesDeleted     bool                `json:"includesDeleted"`
		Items               []ManifestItem      `json:"items"`
		Files               *[]FileVersionEntry `json:"files,omitempty"`
		Omitted             []Omission          `json:"omitted"`
		Loss                []LossEntry         `json:"loss"`
	}
	wire := manifestWire{
		Format: manifest.Format, FormatVersion: manifest.FormatVersion,
		SchemaVersion: manifest.SchemaVersion, ExportedAt: manifest.ExportedAt,
		Root: manifest.Root, RootEffectiveSchema: manifest.RootEffectiveSchema,
		IncludesDeleted: manifest.IncludesDeleted, Items: manifest.Items,
		Omitted: manifest.Omitted, Loss: manifest.Loss,
	}
	if manifest.FormatVersion == FileFormatVersion {
		files := manifest.Files
		if files == nil {
			files = []FileVersionEntry{}
		}
		wire.Files = &files
	}
	return json.Marshal(wire)
}

func (manifest *Manifest) UnmarshalJSON(data []byte) error {
	type manifestWire struct {
		Format              string              `json:"format"`
		FormatVersion       int                 `json:"formatVersion"`
		SchemaVersion       int                 `json:"schemaVersion"`
		ExportedAt          string              `json:"exportedAt"`
		Root                string              `json:"root"`
		RootEffectiveSchema json.RawMessage     `json:"rootEffectiveSchema"`
		IncludesDeleted     bool                `json:"includesDeleted"`
		Items               []ManifestItem      `json:"items"`
		Files               *[]FileVersionEntry `json:"files"`
		Omitted             []Omission          `json:"omitted"`
		Loss                []LossEntry         `json:"loss"`
	}
	var wire manifestWire
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*manifest = Manifest{
		Raw:    append(json.RawMessage(nil), data...),
		Format: wire.Format, FormatVersion: wire.FormatVersion,
		SchemaVersion: wire.SchemaVersion, ExportedAt: wire.ExportedAt,
		Root: wire.Root, RootEffectiveSchema: wire.RootEffectiveSchema,
		IncludesDeleted: wire.IncludesDeleted, Items: wire.Items,
		Omitted: wire.Omitted, Loss: wire.Loss,
	}
	if wire.Files != nil {
		manifest.Files = *wire.Files
	}
	return nil
}

type FileVersionEntry struct {
	ItemID      string `json:"itemId"`
	Version     int    `json:"version"`
	Current     bool   `json:"current"`
	FileName    string `json:"fileName"`
	MediaType   string `json:"mediaType"`
	ByteLength  int64  `json:"byteLength"`
	SHA256      string `json:"sha256"`
	Previewable bool   `json:"previewable"`
	PixelWidth  *int   `json:"pixelWidth"`
	PixelHeight *int   `json:"pixelHeight"`
}

func (entry *FileVersionEntry) UnmarshalJSON(data []byte) error {
	type wireEntry FileVersionEntry
	var wire wireEntry
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, name := range []string{"itemId", "version", "current", "fileName", "mediaType", "byteLength", "sha256", "previewable", "pixelWidth", "pixelHeight"} {
		if _, ok := fields[name]; !ok {
			return fmt.Errorf("file-version metadata is missing %s", name)
		}
	}
	*entry = FileVersionEntry(wire)
	return nil
}

type ManifestItem struct {
	ID       string  `json:"id"`
	ParentID *string `json:"parentId"`
	Seq      string  `json:"seq"`
	Title    string  `json:"title"`
	Type     string  `json:"type"`
}
type Omission struct {
	ID       *string `json:"id"`
	ParentID string  `json:"parentId"`
	Reason   string  `json:"reason"`
	Detail   string  `json:"detail"`
}
type LossEntry struct {
	ItemID string `json:"itemId"`
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

type Bundle struct {
	Raw               json.RawMessage   `json:"-"`
	ID                string            `json:"id"`
	ParentID          *string           `json:"parentId"`
	WorkspaceID       string            `json:"workspaceId"`
	Type              string            `json:"type"`
	Title             string            `json:"title"`
	Seq               string            `json:"seq"`
	LifecycleState    string            `json:"lifecycleState"`
	CreatedAt         string            `json:"createdAt"`
	UpdatedAt         string            `json:"updatedAt"`
	Properties        map[string]any    `json:"properties"`
	Recurrence        json.RawMessage   `json:"recurrence,omitempty"`
	Schema            json.RawMessage   `json:"schema"`
	Views             json.RawMessage   `json:"views"`
	ViewRows          []json.RawMessage `json:"viewRows"`
	ViewRowsTruncated bool              `json:"viewRowsTruncated"`
	Body              json.RawMessage   `json:"body"`
	// Render is the body as a nix-render tree when the stream was asked for `shape=render`; Body is
	// then null for a document. BodyLosses is what the reshaping could not carry.
	Render     json.RawMessage `json:"render,omitempty"`
	BodyLosses []string        `json:"bodyLosses,omitempty"`
	// Comments is present only when the export asked for comment threads.
	Comments json.RawMessage `json:"comments,omitempty"`
}

var safeID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var safeSHA256 = regexp.MustCompile(`^[0-9a-f]{64}$`)

func ValidateManifest(manifest Manifest, maxItems int) error {
	if manifest.Format != Format || manifest.FormatVersion != FormatVersion && manifest.FormatVersion != FileFormatVersion {
		return fmt.Errorf("unsupported Nix archive format")
	}
	if manifest.Root == "" || !safeID.MatchString(manifest.Root) {
		return fmt.Errorf("manifest root is not a safe item identifier")
	}
	if len(manifest.Items) == 0 || len(manifest.Items) > maxItems {
		return fmt.Errorf("manifest item count is outside limits")
	}
	seen := make(map[string]struct{}, len(manifest.Items))
	for _, item := range manifest.Items {
		if !safeID.MatchString(item.ID) || item.Title == "" || item.Seq == "" {
			return fmt.Errorf("manifest contains an invalid item")
		}
		if _, ok := seen[item.ID]; ok {
			return fmt.Errorf("manifest contains duplicate item %s", item.ID)
		}
		seen[item.ID] = struct{}{}
	}
	if _, ok := seen[manifest.Root]; !ok {
		return fmt.Errorf("manifest root is not listed")
	}
	if len(manifest.Omitted) > maxItems || len(manifest.Loss) > 128 {
		return fmt.Errorf("manifest report count is outside limits")
	}
	if manifest.FormatVersion == FormatVersion {
		if manifest.Files != nil {
			return fmt.Errorf("Nix archive v1 cannot declare file versions")
		}
	} else {
		if manifest.Files == nil {
			return fmt.Errorf("Nix archive v2 must declare file versions")
		}
		if err := ValidateFileVersions(manifest.Files, manifest.Items); err != nil {
			return err
		}
	}
	for _, omission := range manifest.Omitted {
		if omission.ID != nil && !safeID.MatchString(*omission.ID) ||
			omission.ParentID != "" && !safeID.MatchString(omission.ParentID) ||
			!safeReportText(omission.Reason, 64) || !safeReportText(omission.Detail, 500) {
			return fmt.Errorf("manifest contains an invalid omission")
		}
	}
	for _, loss := range manifest.Loss {
		if loss.ItemID != "" && !safeID.MatchString(loss.ItemID) ||
			!safeReportText(loss.Kind, 64) || !safeReportText(loss.Detail, 500) {
			return fmt.Errorf("manifest contains an invalid loss entry")
		}
	}
	return nil
}

func ValidateFileVersions(entries []FileVersionEntry, items []ManifestItem) error {
	fileItems := make(map[string]struct{})
	for _, item := range items {
		if strings.EqualFold(item.Type, "file") {
			fileItems[item.ID] = struct{}{}
		}
	}
	byItem := make(map[string][]FileVersionEntry)
	for _, entry := range entries {
		if !safeID.MatchString(entry.ItemID) || !safeFileName(entry.FileName) || !safeMediaType(entry.MediaType) ||
			entry.Version < 1 || entry.Version > MaxFileVersionsPerItem || entry.ByteLength < 0 || entry.ByteLength > MaxFileVersionBytes ||
			!safeSHA256.MatchString(entry.SHA256) || !validFileDimensions(entry) {
			return fmt.Errorf("Nix archive v2 contains invalid file-version metadata")
		}
		if _, ok := fileItems[entry.ItemID]; !ok {
			return fmt.Errorf("Nix archive v2 describes a non-file item %s", entry.ItemID)
		}
		versions := byItem[entry.ItemID]
		for _, existing := range versions {
			if existing.Version == entry.Version {
				return fmt.Errorf("Nix archive v2 contains a duplicate file version")
			}
		}
		byItem[entry.ItemID] = append(versions, entry)
	}
	if len(byItem) != len(fileItems) {
		return fmt.Errorf("Nix archive v2 must describe every file item")
	}
	for itemID := range fileItems {
		versions := byItem[itemID]
		if len(versions) == 0 || len(versions) > MaxFileVersionsPerItem {
			return fmt.Errorf("Nix archive v2 file history is outside limits")
		}
		currentCount := 0
		for version := 1; version <= len(versions); version++ {
			found := false
			for _, entry := range versions {
				if entry.Version == version {
					found = true
					if entry.Current {
						currentCount++
						if version != len(versions) {
							return fmt.Errorf("Nix archive v2 current file version must be newest")
						}
					}
				}
			}
			if !found {
				return fmt.Errorf("Nix archive v2 file versions must be contiguous")
			}
		}
		if currentCount != 1 {
			return fmt.Errorf("Nix archive v2 must declare exactly one current file version")
		}
	}
	return nil
}

func safeFileName(value string) bool {
	if strings.TrimSpace(value) == "" || len(value) > 255 || strings.ContainsAny(value, "/\\\x00") {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}

func safeMediaType(value string) bool {
	separator := strings.IndexByte(value, '/')
	if separator <= 0 || separator == len(value)-1 || len(value) > 160 || strings.ContainsAny(value, ";\\") {
		return false
	}
	for _, character := range value {
		if character < 0x21 || character > 0x7e {
			return false
		}
	}
	return true
}

func validFileDimensions(entry FileVersionEntry) bool {
	if entry.PixelWidth == nil && entry.PixelHeight == nil {
		return !entry.Previewable || entry.MediaType == "application/pdf" && entry.ByteLength <= 10<<20
	}
	if entry.PixelWidth == nil || entry.PixelHeight == nil || *entry.PixelWidth <= 0 || *entry.PixelHeight <= 0 || int64(*entry.PixelWidth)*int64(*entry.PixelHeight) > 1_000_000_000 {
		return false
	}
	return !entry.Previewable || entry.ByteLength < 10<<20 && int64(*entry.PixelWidth)*int64(*entry.PixelHeight) <= 40_000_000
}

func safeReportText(value string, maximum int) bool {
	return strings.TrimSpace(value) != "" && len(value) <= maximum && !strings.ContainsAny(value, "\r\n")
}
