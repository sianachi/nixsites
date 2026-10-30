package exporter

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"image"
	"os"
	"strings"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
	"github.com/sianachi/Nix/apps/go-workers/internal/render"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

// The capture the site-render fixtures hold: a Mermaid flowchart with text labels.
const diagramFixture = "../../../../packages/site-render/src/__fixtures__/docs/files/0199c0de-0100-7000-8000-000000000800.svg"

func TestCapturedDiagramIsDrawnInPDFAndDOCXAndKeptAsCodeInMarkdown(t *testing.T) {
	svg, err := os.ReadFile(diagramFixture)
	if err != nil {
		t.Skip(err)
	}
	language := "mermaid"
	bundle := nixarchive.Bundle{ID: "note", Title: "Diagram", Render: json.RawMessage(`{"format":"nix-render","version":1,"blocks":[{"kind":"code","language":"mermaid","text":"flowchart LR\n  A --> B","renderFile":"11111111-1111-4111-8111-111111111111"}],"losses":[]}`)}
	projected, err := ProjectBundle(bundle, 1<<20, func(string) ([]byte, error) { return svg, nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(projected.Images) != 1 || len(projected.Losses) != 0 || projected.Blocks[0].Kind != "code" || *projected.Blocks[0].Language != language {
		t.Fatalf("images=%d losses=%v blocks=%+v", len(projected.Images), projected.Losses, projected.Blocks)
	}
	raster := projected.Images[0]
	// Drawn at twice the stamped 809x265 and laid out at the stamped width.
	if raster.Width != 809 || raster.PixelWidth != 1618 || raster.PixelHeight != 530 {
		t.Fatalf("width=%d pixels=%dx%d", raster.Width, raster.PixelWidth, raster.PixelHeight)
	}
	// Text was drawn: a blank diagram is nearly all one colour.
	picture, _, err := image.Decode(bytes.NewReader(raster.Data))
	if err != nil {
		t.Fatal(err)
	}
	dark := 0
	for y := 0; y < picture.Bounds().Dy(); y += 2 {
		for x := 0; x < picture.Bounds().Dx(); x += 2 {
			if r, g, b, _ := picture.At(x, y).RGBA(); r+g+b < 3*0x4000 {
				dark++
			}
		}
	}
	if dark < 2000 {
		t.Fatalf("only %d dark samples; labels were not drawn", dark)
	}

	records := []stream.Record{{ID: "note", Title: "Diagram", Blocks: projected.Blocks, Images: projected.Images}}
	limits := stream.Limits{MaxBytes: 4 << 20, MaxLine: 1 << 20, MaxRecords: 10}
	for _, format := range []string{"pdf", "docx", "markdown"} {
		t.Run(format, func(t *testing.T) {
			var output bytes.Buffer
			if err := Write(format, records, &output, limits); err != nil {
				t.Fatal(err)
			}
			switch format {
			case "pdf":
				if !bytes.Contains(output.Bytes(), []byte("/Subtype /Image")) {
					t.Fatal("missing PDF image")
				}
				if text := extractPDFText(t, output.Bytes()); strings.Contains(text, "flowchart LR") {
					t.Fatal("the code was printed beside the picture")
				}
				saveQA(t, "diagram.pdf", output.Bytes())
			case "docx":
				archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
				if err != nil {
					t.Fatal(err)
				}
				found := false
				for _, file := range archive.File {
					found = found || file.Name == "word/media/image1.png"
				}
				if !found {
					t.Fatal("missing embedded diagram")
				}
			case "markdown":
				if !strings.Contains(output.String(), "```mermaid\nflowchart LR") || strings.Contains(output.String(), "data:image") {
					t.Fatal(output.String())
				}
			}
		})
	}
}

func TestUndrawableDiagramStaysAsCode(t *testing.T) {
	bundle := nixarchive.Bundle{Render: json.RawMessage(`{"format":"nix-render","version":1,"blocks":[{"kind":"code","language":"mermaid","text":"graph TD","renderFile":"file"}],"losses":[]}`)}
	projected, err := ProjectBundle(bundle, 1<<20, func(string) ([]byte, error) { return []byte("<svg"), nil })
	if markdown := render.Markdown(projected.Blocks); err != nil || len(projected.Images) != 0 || len(projected.Losses) != 1 || !strings.Contains(markdown, "graph TD") {
		t.Fatalf("%s %v %v", markdown, projected.Losses, err)
	}
}
