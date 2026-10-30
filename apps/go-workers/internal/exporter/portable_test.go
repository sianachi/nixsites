package exporter

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
	"github.com/sianachi/Nix/apps/go-workers/internal/render"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

func TestEveryViewHasReadableContentInEveryDocumentFormat(t *testing.T) {
	kinds := []string{"list", "chat", "board", "calendar", "gallery", "timeline", "sheet", "form", "query", "interactive_form", "chart", "habit_tracker", "drive", "finance", "checklist", "outline", "matrix", "future_view"}
	for _, kind := range kinds {
		t.Run(kind, func(t *testing.T) {
			bundle := nixarchive.Bundle{
				ID: "root", Title: "Portfolio", Type: "note",
				Views:    json.RawMessage(fmt.Sprintf(`{"views":[{"name":"Review","kind":%q,"columns":["status"],"interactiveForm":{"pages":[{"title":"First page"},{"title":"Last page","blocks":[{"text":"Final question","help":"Keep this help"}]}]}}]}`, kind)),
				Schema:   json.RawMessage(`{"properties":[{"key":"status","label":"Progress","type":"select","options":["Open","Done"]}]}`),
				ViewRows: []json.RawMessage{json.RawMessage(`{"id":"child","title":"Finish report","properties":{"status":"Open","due_date":"2026-10-30","chat_text":"Saved reply","$chat_config":{"secret":"must not appear"}}}`)},
			}
			projected, err := ProjectBundle(bundle, 1<<20, nil)
			if err != nil {
				t.Fatal(err)
			}
			for _, format := range []string{"markdown", "docx", "pdf"} {
				var output bytes.Buffer
				if err := Write(format, []stream.Record{{ID: bundle.ID, Title: bundle.Title, Blocks: projected.Blocks}}, &output, stream.Limits{MaxBytes: 4 << 20, MaxLine: 1 << 20, MaxRecords: 1}); err != nil {
					t.Fatal(err)
				}
				text := output.String()
				if format == "docx" {
					archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
					if err != nil {
						t.Fatal(err)
					}
					text = readZipText(t, archive, "word/document.xml")
				}
				if format == "pdf" {
					text = extractPDFText(t, output.Bytes())
				}
				for _, want := range []string{"Review", strings.ReplaceAll(kind, "_", " "), "Finish report", "Open", "2026-10-30", "Saved reply", "Progress"} {
					if !strings.Contains(text, want) {
						t.Errorf("%s omitted %q", format, want)
					}
				}
				if kind == "interactive_form" {
					for _, want := range []string{"Last page", "Final question", "Keep this help"} {
						if !strings.Contains(text, want) {
							t.Errorf("%s omitted %q", format, want)
						}
					}
				}
				if strings.Contains(text, "must not appear") {
					t.Errorf("%s leaked reserved conversation configuration", format)
				}
			}
		})
	}
}

func TestPortableBodiesKeepSheetCanvasAndFutureContent(t *testing.T) {
	for _, test := range []struct{ body, want string }{
		{`{"schemaVersion":1,"sheet":{"cells":{"A1":"Budget","B2":"=SUM(B3:B8)"}}}`, "SUM(B3:B8)"},
		{`{"schemaVersion":1,"canvas":{"elements":{"text":{"type":"text","text":"Launch plan","x":10},"gone":{"type":"text","text":"Deleted text","isDeleted":true}}}}`, "Launch plan"},
		{`{"schemaVersion":99,"future":{"text":"Future content"}}`, "Future content"},
	} {
		projected, err := ProjectBundle(nixarchive.Bundle{Body: json.RawMessage(test.body)}, 1<<20, nil)
		output := render.Markdown(projected.Blocks)
		if err != nil || !strings.Contains(output, test.want) || len(projected.Losses) == 0 {
			t.Fatalf("projection = %q, %v, %v", output, projected.Losses, err)
		}
		if strings.Contains(output, "Deleted text") || strings.Contains(output, "not rendered") {
			t.Fatal(output)
		}
	}
}

func TestPortableViewsKeepAllProvidedRowsAndStateUpstreamLimits(t *testing.T) {
	bundle := nixarchive.Bundle{Views: json.RawMessage(`{"views":[{"name":"All tasks","kind":"list"}]}`), ViewRowsTruncated: true}
	for index := 0; index < 100; index++ {
		bundle.ViewRows = append(bundle.ViewRows, json.RawMessage(fmt.Sprintf(`{"title":"Task %03d"}`, index)))
	}
	projected, err := ProjectBundle(bundle, 1<<20, nil)
	output := render.Markdown(projected.Blocks)
	if err != nil || !strings.Contains(output, "Task 099") || !strings.Contains(output, "incomplete") || len(projected.Losses) == 0 {
		t.Fatalf("projection = %q, %v, %v", output, projected.Losses, err)
	}
	if _, err := ProjectBundle(bundle, 50, nil); err == nil {
		t.Fatal("accepted an oversized projection")
	}
}

func TestPortableAttachmentsLinkToTheirOriginal(t *testing.T) {
	projected, err := ProjectBundle(nixarchive.Bundle{ID: "file-id", Type: "file", Title: "report.docx"}, 4096, nil)
	output := render.Markdown(projected.Blocks)
	if err != nil || !strings.Contains(output, "[report.docx](nix://item/file-id)") {
		t.Fatalf("projection = %q, %v", output, err)
	}
}

func TestPortablePropertiesKeepExactDecimalText(t *testing.T) {
	bundle := nixarchive.Bundle{
		Raw:      json.RawMessage(`{"properties":{"amount":9007199254740993.123456789}}`),
		Views:    json.RawMessage(`{"views":[{"name":"Amounts","kind":"finance"}]}`),
		ViewRows: []json.RawMessage{json.RawMessage(`{"title":"Transaction","properties":{"amount":9007199254740993.123456789}}`)},
	}
	projected, err := ProjectBundle(bundle, 4096, nil)
	output := render.Markdown(projected.Blocks)
	if err != nil || strings.Count(output, "9007199254740993.123456789") != 2 {
		t.Fatalf("projection = %q, %v", output, err)
	}
}

func TestPortableCommentsFollowTheBodyWithQuoteAuthorAndDate(t *testing.T) {
	bundle := nixarchive.Bundle{
		Comments: json.RawMessage(`[{"id":"t","quote":"the plan","resolved":true,"comments":[{"author":"Ada","body":"# Why?","createdAt":"2026-10-29T10:00:00Z"}]}]`),
	}
	projected, err := ProjectBundle(bundle, 1<<20, nil)
	output := render.Markdown(projected.Blocks)
	for _, want := range []string{"## Comments", "> the plan", "(Resolved)", "**Ada** · 2026-10-29", `\# Why?`} {
		if err != nil || !strings.Contains(output, want) {
			t.Fatalf("missing %q in %q (%v)", want, output, err)
		}
	}
}
