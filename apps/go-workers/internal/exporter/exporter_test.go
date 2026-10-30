package exporter

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"io"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/render"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

// para is a record whose body is one paragraph, for tests about the writers rather than the tree.
func para(id, title, body string) stream.Record {
	return stream.Record{ID: id, Title: title, Blocks: []render.Block{render.Paragraph(body)}}
}

func link(label, href string) render.Run { return render.Run{Text: label, Href: href} }
func styled(label string, styles ...string) render.Run {
	return render.Run{Text: label, Styles: styles}
}

func TestMarkdownExportIsDeterministic(t *testing.T) {
	var output bytes.Buffer
	err := Write("markdown", []stream.Record{para("one", "One", "Body")}, &output, stream.Limits{MaxBytes: 1000, MaxLine: 1000, MaxRecords: 10})
	if err != nil || output.String() != "# One\n\nBody\n\n" {
		t.Fatalf("Write() = %q, %v", output.String(), err)
	}
}

func TestNixExportWritesManifestBeforePayloads(t *testing.T) {
	var output bytes.Buffer
	err := Write("nix", []stream.Record{{ID: "one", Title: "One"}}, &output, stream.Limits{MaxBytes: 1000, MaxLine: 1000, MaxRecords: 10})
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
	if err != nil || len(archive.File) != 2 || archive.File[0].Name != "manifest.json" {
		t.Fatalf("archive = %+v, %v", archive, err)
	}
}

func TestExportRefusesOversizedMarkdown(t *testing.T) {
	err := Write("md", []stream.Record{para("one", "One", strings.Repeat("x", 100))}, &bytes.Buffer{}, stream.Limits{MaxBytes: 10, MaxLine: 1000, MaxRecords: 10})
	if err != stream.ErrLimitExceeded {
		t.Fatalf("Write() error = %v, want ErrLimitExceeded", err)
	}
}

func TestWriteProducesDOCXAndPDF(t *testing.T) {
	records := []stream.Record{para("one", "Title", "Body")}
	limits := stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10}
	for _, format := range []string{"docx", "pdf"} {
		var output bytes.Buffer
		if err := Write(format, records, &output, limits); err != nil {
			t.Fatalf("Write(%s) error = %v", format, err)
		}
		if output.Len() == 0 {
			t.Fatalf("Write(%s) produced no output", format)
		}
	}
}

func TestRenderTreeBodyIsWrittenAsMarkdownWithItsLosses(t *testing.T) {
	bundle := nixarchive.Bundle{ID: "one", Title: "Plan", Render: json.RawMessage(`{"format":"nix-render","version":1,"blocks":[{"kind":"heading","level":2,"runs":[{"text":"Plan"}]},{"kind":"paragraph","runs":[{"text":"Ship it","styles":["bold"]}]}],"losses":["Comments were dropped."]}`)}
	projected, err := ProjectBundle(bundle, 4096, nil)
	if err != nil {
		t.Fatal(err)
	}
	if markdown := render.Markdown(projected.Blocks); markdown != "## Plan\n\n**Ship it**" || len(projected.Losses) != 1 {
		t.Fatalf("ProjectBundle() = %q, %#v", markdown, projected.Losses)
	}
	if _, err := ProjectBundle(nixarchive.Bundle{Render: json.RawMessage(`{"format":"nix-render","version":2,"blocks":[]}`)}, 4096, nil); err == nil {
		t.Fatal("a tree from another version must fail the job, not flatten")
	}
}

func TestStreamingMarkdownConsumesEachRecordOnce(t *testing.T) {
	records := []stream.Record{para("one", "One", "First"), para("two", "Two", "Second")}
	index := 0
	var output bytes.Buffer
	err := WriteStream("markdown", func() (stream.Record, bool, error) {
		if index == len(records) {
			return stream.Record{}, false, nil
		}
		value := records[index]
		index++
		return value, true, nil
	}, &output, stream.Limits{MaxBytes: 4096, MaxLine: 1024, MaxRecords: 2})
	if err != nil || index != 2 || output.String() != "# One\n\nFirst\n\n# Two\n\nSecond\n\n" {
		t.Fatalf("WriteStream() = %q, calls %d, %v", output.String(), index, err)
	}
}

func TestConvertedFilesDoNotEmbedInternalLossReports(t *testing.T) {
	records := []stream.Record{para("one", "One", "Body")}
	limits := stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10}
	index := 0
	var output bytes.Buffer
	err := WriteStreamWithReport("markdown", func() (stream.Record, bool, error) {
		if index == len(records) {
			return stream.Record{}, false, nil
		}
		record := records[index]
		index++
		return record, true, nil
	}, &output, limits, func() []string { return []string{"A view was omitted."} })
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "What did not come across") || strings.Contains(output.String(), "A view was omitted.") {
		t.Fatalf("Markdown embedded its internal fidelity report: %q", output.String())
	}
}

func TestDOCXPreservesProjectedHeadingsListsLinksAndTablesWithoutInternalReport(t *testing.T) {
	body := []render.Block{
		render.Heading(2, "Plan"),
		{Kind: "paragraph", Runs: []render.Run{styled("Bold", "bold"), {Text: " and "}, styled("italic", "italic"), {Text: " with "}, link("site", "https://example.test/a_(b)"), {Text: "."}}},
		render.Bullets([]string{"First"}),
		{Kind: "list", Ordered: true, Items: []render.ListItem{{Blocks: []render.Block{render.Paragraph("Step")}}}},
		{Kind: "table", Rows: []render.Row{{Header: true, Cells: [][]render.Run{{{Text: "Name"}}, {{Text: "State"}}}}, {Cells: [][]render.Run{{{Text: "Nix"}}, {{Text: "Ready"}}}}}},
	}
	var output bytes.Buffer
	index := 0
	err := WriteStreamWithReport("docx", func() (stream.Record, bool, error) {
		if index > 0 {
			return stream.Record{}, false, nil
		}
		index++
		return stream.Record{ID: "one", Title: "Title", Blocks: body}, true, nil
	}, &output, stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10}, func() []string {
		return []string{"A property was omitted."}
	})
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
	if err != nil {
		t.Fatal(err)
	}
	document := readZipText(t, archive, "word/document.xml")
	for _, expected := range []string{
		`w:pStyle w:val="Heading2"`,
		`w:numId w:val="1"`,
		`w:numId w:val="2"`,
		`<w:b/>`,
		`<w:i/>`,
		`<w:fldSimple`,
		`https://example.test/a_(b)`,
		`<w:tbl>`,
	} {
		if !strings.Contains(document, expected) {
			t.Fatalf("document.xml omitted %q:\n%s", expected, document)
		}
	}
	if strings.Contains(document, "What did not come across") || strings.Contains(document, "A property was omitted.") {
		t.Fatalf("DOCX embedded its internal fidelity report: %s", document)
	}
	numbering := readZipText(t, archive, "word/numbering.xml")
	if !strings.Contains(numbering, `w:ilvl="8"`) {
		t.Fatalf("numbering.xml omitted bounded nested levels: %s", numbering)
	}
}

func TestDOCXFlattensAFieldInstructionTargetToVisibleText(t *testing.T) {
	var output bytes.Buffer
	err := Write("docx", []stream.Record{{
		ID: "one", Title: "Title", Blocks: []render.Block{{Kind: "paragraph", Runs: []render.Run{link("unsafe", `https://example.test/a"\l`), {Text: " after"}}}},
	}}, &output, stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10})
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
	if err != nil {
		t.Fatal(err)
	}
	document := readZipText(t, archive, "word/document.xml")
	if strings.Contains(document, `<w:fldSimple`) || strings.Contains(document, `\\l`) {
		t.Fatalf("DOCX retained an unsafe field instruction: %s", document)
	}
	if !strings.Contains(document, "unsafe") || !strings.Contains(document, "after") {
		t.Fatalf("DOCX did not retain the visible link text: %s", document)
	}
}

func TestPDFFlattensMarkdownSyntaxWithoutInternalReport(t *testing.T) {
	var output bytes.Buffer
	index := 0
	err := WriteStreamWithReport("pdf", func() (stream.Record, bool, error) {
		if index > 0 {
			return stream.Record{}, false, nil
		}
		index++
		return stream.Record{ID: "one", Title: "Title", Blocks: []render.Block{render.Heading(2, "Plan"), {Kind: "paragraph", Runs: []render.Run{styled("Bold", "bold"), {Text: " "}, link("site", "https://example.test")}}}}, true, nil
	}, &output, stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10}, func() []string {
		return []string{"A view was omitted."}
	})
	if err != nil {
		t.Fatal(err)
	}
	text := extractPDFText(t, output.Bytes())
	for _, expected := range []string{"Plan", "Bold site"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("PDF omitted %q: %s", expected, text)
		}
	}
	if strings.Contains(text, "A view was omitted.") || strings.Contains(text, "**") {
		t.Fatalf("Unexpected PDF content: %s", text)
	}

}

func TestDOCXAndPDFAreDeterministicForTheSameRecords(t *testing.T) {
	records := []stream.Record{para("one", "Title", "Body")}
	limits := stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10}
	for _, format := range []string{"docx", "pdf"} {
		var first, second bytes.Buffer
		if err := Write(format, records, &first, limits); err != nil {
			t.Fatal(err)
		}
		if err := Write(format, records, &second, limits); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(first.Bytes(), second.Bytes()) {
			t.Fatalf("%s output changed for identical input", format)
		}
	}
}

func TestDOCXContainsOnlyWellFormedXMLAfterHostileText(t *testing.T) {
	var output bytes.Buffer
	err := Write("docx", []stream.Record{para("one", "Line\nwith\u0001control", "Body\ufffe text")}, &output, stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10})
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range archive.File {
		if !strings.HasSuffix(entry.Name, ".xml") && !strings.HasSuffix(entry.Name, ".rels") {
			continue
		}
		reader, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		decoder := xml.NewDecoder(reader)
		for {
			if _, err := decoder.Token(); err == io.EOF {
				break
			} else if err != nil {
				_ = reader.Close()
				t.Fatalf("%s is not well-formed XML: %v", entry.Name, err)
			}
		}
		if err := reader.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPDFStartXrefPointsAtTheCrossReferenceTable(t *testing.T) {
	var output bytes.Buffer
	if err := Write("pdf", []stream.Record{para("one", "Title", strings.Repeat("line\n", 80))}, &output, stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10}); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	marker := strings.LastIndex(text, "startxref\n")
	if marker < 0 {
		t.Fatal("PDF omitted startxref")
	}
	line := strings.SplitN(text[marker+len("startxref\n"):], "\n", 2)[0]
	offset, err := strconv.Atoi(line)
	if err != nil || offset < 0 || !strings.HasPrefix(text[offset:], "xref\n") {
		t.Fatalf("startxref = %q, %v", line, err)
	}
}

func TestPDFPassesPopplerValidationWhenAvailable(t *testing.T) {
	pdfinfo, err := exec.LookPath("pdfinfo")
	if err != nil {
		t.Skip("pdfinfo is not installed")
	}
	path := filepath.Join(t.TempDir(), "export.pdf")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writeErr := Write("pdf", []stream.Record{para("one", "Title", strings.Repeat("line\n", 80))}, file, stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10})
	closeErr := file.Close()
	if writeErr != nil {
		t.Fatal(writeErr)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	if output, err := exec.CommandContext(t.Context(), pdfinfo, path).CombinedOutput(); err != nil {
		t.Fatalf("pdfinfo refused export: %v\n%s", err, output)
	}
}

func TestProjectedTitleIsOneSafeLine(t *testing.T) {
	title, lost := ProjectTitle("  A\nB\u0001\ufffe  ")
	if title != "A B" || !lost {
		t.Fatalf("ProjectTitle() = %q, %v", title, lost)
	}
}

func readZipText(t *testing.T, archive *zip.Reader, name string) string {
	t.Helper()
	for _, entry := range archive.File {
		if entry.Name != name {
			continue
		}
		reader, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, readErr := io.ReadAll(reader)
		closeErr := reader.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		if closeErr != nil {
			t.Fatal(closeErr)
		}
		return string(body)
	}
	t.Fatalf("archive omitted %s", name)
	return ""
}

func extractPDFText(t *testing.T, data []byte) string {
	t.Helper()
	binary, err := exec.LookPath("pdftotext")
	if err != nil {
		t.Skip("pdftotext is not installed")
	}
	path := filepath.Join(t.TempDir(), "export.pdf")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	output, err := exec.CommandContext(t.Context(), binary, path, "-").CombinedOutput()
	if err != nil {
		t.Fatalf("PDF text extraction: %v: %s", err, output)
	}
	return string(output)
}
