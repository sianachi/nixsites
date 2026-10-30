package exporter

import (
	"archive/zip"
	"bytes"
	"io"
	"strings"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/render"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

func TestExplicitPageBreakSurvivesBothPrintFormats(t *testing.T) {
	records := []stream.Record{{ID: "one", Title: "Pages", Blocks: []render.Block{render.Paragraph("First page"), {Kind: "pageBreak"}, render.Paragraph("Second page")}}}
	limits := stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10}
	var pdf bytes.Buffer
	if err := Write("pdf", records, &pdf, limits); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(pdf.String(), "/Count 2") {
		t.Fatalf("Expected two pages: %s", pdf.String())
	}
	var docx bytes.Buffer
	if err := Write("docx", records, &docx, limits); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(docx.Bytes()), int64(docx.Len()))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range archive.File {
		if file.Name == "word/document.xml" {
			reader, err := file.Open()
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(reader)
			reader.Close()
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Contains(data, []byte(`<w:br w:type="page"/>`)) || !bytes.Contains(data, []byte("Second page")) {
				t.Fatalf("Page break lost: %s", data)
			}
			return
		}
	}
	t.Fatal("No Word document")
}
