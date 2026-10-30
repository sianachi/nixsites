package exporter

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
	"github.com/sianachi/Nix/apps/go-workers/internal/render"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

func TestNoteImageExportsEmbedBytesAndPreserveSize(t *testing.T) {
	var raster bytes.Buffer
	picture := image.NewRGBA(image.Rect(0, 0, 320, 160))
	for y := 0; y < 160; y++ {
		for x := 0; x < 320; x++ {
			picture.Set(x, y, color.RGBA{uint8(x % 255), 100, uint8(y), 255})
		}
	}
	if err := png.Encode(&raster, picture); err != nil {
		t.Fatal(err)
	}
	bundle := nixarchive.Bundle{ID: "note", Title: "Resized image", Render: json.RawMessage(`{"format":"nix-render","version":1,"blocks":[{"kind":"heading","level":2,"runs":[{"text":"Image notes"}]},{"kind":"image","src":"","alt":"Sample image","file":"11111111-1111-4111-8111-111111111111","width":240}],"losses":[]}`)}
	projected, err := ProjectBundle(bundle, 1<<20, func(id string) ([]byte, error) { return raster.Bytes(), nil })
	if err != nil {
		t.Fatal(err)
	}
	images := projected.Images
	if len(images) != 1 || images[0].Width != 240 || len(projected.Losses) != 0 {
		t.Fatalf("image count=%d losses=%v", len(images), projected.Losses)
	}
	records := []stream.Record{{ID: "note", Title: "Resized image", Blocks: projected.Blocks, Images: images}}
	limits := stream.Limits{MaxBytes: 2 << 20, MaxLine: 1 << 20, MaxRecords: 10}
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
				if text := extractPDFText(t, output.Bytes()); !strings.Contains(text, "Image notes") {
					t.Fatal(text)
				}
				saveQA(t, "image.pdf", output.Bytes())
			case "docx":
				archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
				if err != nil {
					t.Fatal(err)
				}
				foundImage, foundDrawing := false, false
				for _, file := range archive.File {
					reader, err := file.Open()
					if err != nil {
						t.Fatal(err)
					}
					data, err := io.ReadAll(reader)
					reader.Close()
					if err != nil {
						t.Fatal(err)
					}
					if file.Name == "word/media/image1.png" {
						foundImage = bytes.Equal(data, raster.Bytes())
					}
					if file.Name == "word/document.xml" {
						foundDrawing = bytes.Contains(data, []byte(`cx="2286000" cy="1143000"`))
					}
				}
				if !foundImage || !foundDrawing {
					t.Fatal("missing embedded image or saved dimensions")
				}
			case "markdown":
				if !strings.Contains(output.String(), "data:image/png;base64,") || strings.Contains(output.String(), "nix.invalid") {
					t.Fatal("missing portable image")
				}
			}
		})
	}
}

func TestInvalidImageFallsBackWithAnExplicitLoss(t *testing.T) {
	bundle := nixarchive.Bundle{Render: json.RawMessage(`{"format":"nix-render","version":1,"blocks":[{"kind":"image","src":"","alt":"Unavailable figure","file":"file"}],"losses":[]}`)}
	projected, err := ProjectBundle(bundle, 1<<20, func(string) ([]byte, error) { return []byte("not an image"), nil })
	if markdown := render.Markdown(projected.Blocks); err != nil || len(projected.Images) != 0 || len(projected.Losses) == 0 || !strings.Contains(markdown, "Unavailable figure") {
		t.Fatalf("%s %v %v", markdown, projected.Losses, err)
	}
}

func TestPDFFormatsUnicodeListsTablesAndLongContent(t *testing.T) {
	language := "go"
	body := []render.Block{
		render.Heading(2, "Résumé – café"),
		{Kind: "paragraph", Runs: []render.Run{{Text: "Bold", Styles: []string{"bold"}}, {Text: " and "}, {Text: "italic", Styles: []string{"italic"}}, {Text: " with "}, {Text: "code", Styles: []string{"code"}}, {Text: "."}}},
		{Kind: "list", Ordered: true, Items: []render.ListItem{{Blocks: []render.Block{render.Paragraph("First")}}, {Blocks: []render.Block{render.Paragraph("Second")}}}},
		{Kind: "table", Rows: []render.Row{{Header: true, Cells: [][]render.Run{{{Text: "Column"}}, {{Text: "Value"}}}}, {Cells: [][]render.Run{{{Text: "Alpha"}}, {{Text: strings.Repeat("long cell ", 120)}}}}}},
		{Kind: "code", Language: &language, Text: "fmt.Println(\"hello\")"},
		{Kind: "pageBreak"},
		render.Heading(2, "Next page"),
	}
	var output bytes.Buffer
	if err := Write("pdf", []stream.Record{{ID: "one", Title: "Formatting sample", Blocks: body}}, &output, stream.Limits{MaxBytes: 2 << 20, MaxLine: 1 << 20, MaxRecords: 10}); err != nil {
		t.Fatal(err)
	}
	text := extractPDFText(t, output.Bytes())
	for _, want := range []string{"Résumé – café", "Bold", "italic", "1. First", "2. Second", "Next page"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in %s", want, text)
		}
	}
	saveQA(t, "formatting.pdf", output.Bytes())
}
func saveQA(t *testing.T, name string, data []byte) {
	t.Helper()
	if dir := os.Getenv("NIX_EXPORT_QA_DIR"); dir != "" {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPDFPageBudgetStopsPathologicalDocuments(t *testing.T) {
	var output bytes.Buffer
	breaks := make([]render.Block, maximumPDFPages)
	for index := range breaks {
		breaks[index] = render.Block{Kind: "pageBreak"}
	}
	err := Write("pdf", []stream.Record{{ID: "one", Title: "Page limit", Blocks: breaks}}, &output, stream.Limits{MaxBytes: 2 << 20, MaxLine: 1 << 20, MaxRecords: 1})
	if !errors.Is(err, stream.ErrLimitExceeded) {
		t.Fatalf("expected page limit, got %v", err)
	}
}
