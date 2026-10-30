package importplan

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
)

const Version = 1

type Plan struct {
	Version      int                           `json:"version"`
	Format       string                        `json:"format"`
	Title        string                        `json:"title"`
	SourceSHA256 string                        `json:"sourceSha256"`
	Items        []Item                        `json:"items"`
	FileVersions []nixarchive.FileVersionEntry `json:"fileVersions,omitempty"`
	Loss         []string                      `json:"loss"`
	Omissions    []string                      `json:"omissions"`
}

type Item struct {
	SourceID            string          `json:"sourceId"`
	ParentSourceID      *string         `json:"parentSourceId"`
	Order               int             `json:"order"`
	Title               string          `json:"title"`
	ItemType            string          `json:"itemType"`
	Properties          json.RawMessage `json:"properties,omitempty"`
	Recurrence          json.RawMessage `json:"recurrence,omitempty"`
	Schema              json.RawMessage `json:"schema,omitempty"`
	Views               json.RawMessage `json:"views,omitempty"`
	FinalLifecycleState string          `json:"finalLifecycleState"`
	Body                *Body           `json:"body,omitempty"`
	File                *File           `json:"file,omitempty"`
	// Comments holds the exported threads ([{id, quote, resolved, comments: [{author, body, createdAt}]}]); Core bounds and stores them.
	Comments json.RawMessage `json:"comments,omitempty"`
}

type Body struct {
	Encoding string `json:"encoding"`
	Text     string `json:"text,omitempty"`
	// Render is a nix-render tree (internal/render), the only document shape this worker emits.
	Render  json.RawMessage `json:"render,omitempty"`
	Archive json.RawMessage `json:"archive,omitempty"`
}

type File struct {
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

type Source struct {
	Path      string
	Format    string
	Title     string
	FileName  string
	MediaType string
	Bytes     int64
	SHA256    string
}

type Limits struct {
	MaxSourceBytes int64
	MaxPlanBytes   int64
	MaxBodyBytes   int64
	MaxEntryBytes  int64
	MaxItems       int
	MaxDepth       int
	PDFTimeoutSecs int
}

func Encode(plan Plan, maxBytes int64) ([]byte, string, error) {
	if plan.Version != Version || plan.Format == "" || plan.SourceSHA256 == "" || len(plan.Items) == 0 {
		return nil, "", errors.New("import plan is incomplete")
	}
	if err := validatePlanFileVersions(plan.FileVersions, plan.Items); err != nil {
		return nil, "", err
	}
	body, err := json.Marshal(plan)
	if err != nil {
		return nil, "", err
	}
	if int64(len(body)) > maxBytes {
		return nil, "", errors.New("import plan exceeds the configured byte limit")
	}
	digest := sha256.Sum256(body)
	return body, hex.EncodeToString(digest[:]), nil
}

func Decode(body []byte, expectedDigest string, limits Limits) (Plan, error) {
	if int64(len(body)) > limits.MaxPlanBytes {
		return Plan{}, errors.New("import plan exceeds the configured byte limit")
	}
	digest := sha256.Sum256(body)
	if hex.EncodeToString(digest[:]) != expectedDigest {
		return Plan{}, errors.New("import plan checksum does not match the preview")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var plan Plan
	if err := decoder.Decode(&plan); err != nil {
		return Plan{}, err
	}
	if plan.Version != Version || len(plan.Items) == 0 || len(plan.Items) > limits.MaxItems {
		return Plan{}, errors.New("import plan version or item count is unsupported")
	}
	if err := validatePlanFileVersions(plan.FileVersions, plan.Items); err != nil {
		return Plan{}, err
	}
	return plan, nil
}

func validatePlanFileVersions(files []nixarchive.FileVersionEntry, items []Item) error {
	if files == nil {
		return nil
	}
	manifestItems := make([]nixarchive.ManifestItem, 0, len(items))
	for _, item := range items {
		manifestItems = append(manifestItems, nixarchive.ManifestItem{ID: item.SourceID, Type: item.ItemType})
	}
	return nixarchive.ValidateFileVersions(files, manifestItems)
}
