package exporter

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

// The TypeScript-authored fixture (packages/export/src/render.test.ts) rendered by every writer:
// the contract test that a tree Collab produces is one this worker draws.
func TestSharedRenderFixtureIsDrawnByEveryWriter(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "fixtures", "nix-render-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Render json.RawMessage `json:"render"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	projected, err := ProjectBundle(nixarchive.Bundle{ID: "one", Title: "Fixture", Type: "note", Render: fixture.Render}, 1<<20, nil)
	if err != nil {
		t.Fatal(err)
	}
	records := []stream.Record{{ID: "one", Title: "Fixture", Blocks: projected.Blocks, Images: projected.Images}}
	limits := stream.Limits{MaxBytes: 4 << 20, MaxLine: 1 << 20, MaxRecords: 1}
	for _, format := range []string{"markdown", "docx", "pdf"} {
		var output bytes.Buffer
		if err := Write(format, records, &output, limits); err != nil {
			t.Fatalf("Write(%s): %v", format, err)
		}
		text := output.String()
		switch format {
		case "docx":
			archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
			if err != nil {
				t.Fatal(err)
			}
			text = readZipText(t, archive, "word/document.xml")
		case "pdf":
			text = extractPDFText(t, output.Bytes())
		}
		for _, want := range []string{"A heading", "Mind the gap.", "const answer = 42;", "Nested", "Not done"} {
			if !strings.Contains(text, want) {
				t.Errorf("%s omitted %q", format, want)
			}
		}
		if strings.Contains(text, "\"kind\"") {
			t.Errorf("%s leaked the tree as JSON", format)
		}
	}
}
