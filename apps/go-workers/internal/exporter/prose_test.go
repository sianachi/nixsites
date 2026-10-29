package exporter

import (
	"encoding/json"
	"strings"
	"testing"
)

func proseEnvelope(document string) json.RawMessage {
	return json.RawMessage(`{"schemaVersion":2,"prosemirror":` + document + `}`)
}

func projectMarkdown(t *testing.T, document string) (string, []string) {
	t.Helper()
	markdown, losses, err := ProjectBody(proseEnvelope(document), true, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	return markdown, losses
}

func requireLoss(t *testing.T, losses []string, expected string) {
	t.Helper()
	for _, loss := range losses {
		if loss == expected {
			return
		}
	}
	t.Fatalf("losses %#v do not contain %q", losses, expected)
}

func TestProjectBodyEscapesLiteralMarkdownInItsActualContext(t *testing.T) {
	document := `{"type":"doc","content":[` +
		`{"type":"paragraph","content":[{"type":"text","text":"literal *stars* _under_ ` + "`tick`" + ` [bracket] ~~strike~~ | pipe <tag>"}]},` +
		`{"type":"paragraph","content":[{"type":"text","text":"# heading\n1. item\n---\n==="}]}` +
		`]}`
	markdown, losses := projectMarkdown(t, document)
	want := "literal \\*stars\\* \\_under\\_ \\`tick\\` \\[bracket\\] \\~\\~strike\\~\\~ \\| pipe \\<tag>\n\n" +
		"\\# heading\n1\\. item\n\\---\n\\==="
	if markdown != want || len(losses) != 0 {
		t.Fatalf("ProjectBody() = %q, %#v; want %q", markdown, losses, want)
	}
}

func TestProjectBodyUsesStableMarkOrderAndBoundedCodeSpans(t *testing.T) {
	document := `{"type":"doc","content":[{"type":"paragraph","content":[` +
		`{"type":"text","text":"linked","marks":[{"type":"link","attrs":{"href":"https://example.test/a_(b)"}},{"type":"italic"},{"type":"bold"},{"type":"strike"}]},` +
		`{"type":"text","text":" "},` +
		`{"type":"text","text":"a` + "`" + `b","marks":[{"type":"code"}]},` +
		`{"type":"text","text":" "},` +
		`{"type":"text","text":"` + "`edge`" + `","marks":[{"type":"code"}]},` +
		`{"type":"text","text":" padded ","marks":[{"type":"bold"}]}` +
		`]}]}`
	markdown, losses := projectMarkdown(t, document)
	want := "[***~~linked~~***](https://example.test/a_\\(b\\)) ``a`b`` `` `edge` `` **padded** "
	if markdown != strings.TrimSpace(want) || len(losses) != 0 {
		t.Fatalf("ProjectBody() = %q, %#v; want %q", markdown, losses, strings.TrimSpace(want))
	}
}

func TestProjectBodyRendersNestedListsAndTaskMarkers(t *testing.T) {
	document := `{"type":"doc","content":[` +
		`{"type":"bulletList","content":[` +
		`{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"First"}]}]},` +
		`{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Second"}]},` +
		`{"type":"orderedList","attrs":{"start":3,"type":null},"content":[` +
		`{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Nested one"}]}]},` +
		`{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Nested two"}]}]}` +
		`]}]}` +
		`]},` +
		`{"type":"taskList","content":[` +
		`{"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"Done"}]}]},` +
		`{"type":"taskItem","attrs":{"checked":false},"content":[{"type":"paragraph","content":[{"type":"text","text":"Open"}]}]}` +
		`]}` +
		`]}`
	markdown, losses := projectMarkdown(t, document)
	want := "- First\n- Second\n\n  3. Nested one\n  4. Nested two\n\n- [x] Done\n- [ ] Open"
	if markdown != want {
		t.Fatalf("ProjectBody() = %q; want %q", markdown, want)
	}
	requireLoss(t, losses, lossTaskList)
}

func TestProjectBodyQuotesEveryBlockquoteAndCalloutLine(t *testing.T) {
	document := `{"type":"doc","content":[` +
		`{"type":"blockquote","content":[` +
		`{"type":"paragraph","content":[{"type":"text","text":"One"}]},` +
		`{"type":"paragraph","content":[{"type":"text","text":"Two"}]}` +
		`]},` +
		`{"type":"callout","attrs":{"tone":"warning"},"content":[` +
		`{"type":"paragraph","content":[{"type":"text","text":"Careful."}]},` +
		`{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Check this"}]}]}]}` +
		`]}` +
		`]}`
	markdown, losses := projectMarkdown(t, document)
	want := "> One\n>\n> Two\n\n> [!warning]\n>\n> Careful.\n>\n> - Check this"
	if markdown != want || len(losses) != 0 {
		t.Fatalf("ProjectBody() = %q, %#v; want %q", markdown, losses, want)
	}
}

func TestProjectBodyKeepsNestedQuoteBlankLinesInsideTheirListItem(t *testing.T) {
	document := `{"type":"doc","content":[{"type":"bulletList","content":[` +
		`{"type":"listItem","content":[` +
		`{"type":"paragraph","content":[{"type":"text","text":"Intro"}]},` +
		`{"type":"blockquote","content":[` +
		`{"type":"paragraph","content":[{"type":"text","text":"Quote one"}]},` +
		`{"type":"paragraph","content":[{"type":"text","text":"Quote two"}]}` +
		`]}` +
		`]}` +
		`]}]}`
	markdown, losses := projectMarkdown(t, document)
	want := "- Intro\n\n  > Quote one\n  >\n  > Quote two"
	if markdown != want || len(losses) != 0 {
		t.Fatalf("ProjectBody() = %q, %#v; want %q", markdown, losses, want)
	}
}

func TestProjectBodyChoosesACodeFenceThatCannotCloseEarly(t *testing.T) {
	document := `{"type":"doc","content":[` +
		`{"type":"heading","attrs":{"level":5},"content":[{"type":"text","text":"Code"}]},` +
		`{"type":"codeBlock","attrs":{"language":"go"},"content":[{"type":"text","text":"before\n` + "```" + `\nafter"}]},` +
		`{"type":"horizontalRule"},` +
		`{"type":"paragraph","content":[{"type":"text","text":"line"},{"type":"hardBreak"},{"type":"text","text":"break"}]}` +
		`]}`
	markdown, losses := projectMarkdown(t, document)
	want := "### Code\n\n````go\nbefore\n```\nafter\n````\n\n---\n\nline\\\nbreak"
	if markdown != want {
		t.Fatalf("ProjectBody() = %q; want %q", markdown, want)
	}
	requireLoss(t, losses, lossInvalidAttribute)
}

func TestProjectBodyPreservesSafeLinksReferencesAndImages(t *testing.T) {
	document := `{"type":"doc","content":[{"type":"paragraph","content":[` +
		`{"type":"text","text":"Link [label]","marks":[{"type":"link","attrs":{"href":"https://example.test/a_(b)","title":"A title"}}]},` +
		`{"type":"text","text":" and "},` +
		`{"type":"reference","attrs":{"kind":"item","targetId":"abc/def","label":"Note [one]"}},` +
		`{"type":"text","text":" then "},` +
		`{"type":"image","attrs":{"src":"https://example.test/a_(b).png","alt":"A [diagram]","title":"Figure one","width":640,"height":480}}` +
		`]}]}`
	markdown, losses := projectMarkdown(t, document)
	want := "[Link \\[label\\]](https://example.test/a_\\(b\\) \"A title\") and [Note \\[one\\]](nix://item/abc%2Fdef) then ![A \\[diagram\\]](https://example.test/a_\\(b\\).png \"Figure one\")"
	if markdown != want {
		t.Fatalf("ProjectBody() = %q; want %q", markdown, want)
	}
	requireLoss(t, losses, lossImageDimensions)
}

func TestProjectBodyFlattensUnsafeLinksWithoutEmittingTargets(t *testing.T) {
	document := `{"type":"doc","content":[{"type":"paragraph","content":[` +
		`{"type":"text","text":"click","marks":[{"type":"link","attrs":{"href":"javascript:alert(1)"}}]},` +
		`{"type":"text","text":" "},` +
		`{"type":"image","attrs":{"src":"data:text/html,bad","alt":"preview"}},` +
		`{"type":"text","text":" "},` +
		`{"type":"reference","attrs":{"kind":"future","targetId":"secret","label":"New kind"}}` +
		`]}]}`
	markdown, losses := projectMarkdown(t, document)
	if markdown != "click [Image: preview] New kind" || strings.Contains(markdown, "javascript:") || strings.Contains(markdown, "data:") {
		t.Fatalf("ProjectBody() = %q, %#v", markdown, losses)
	}
	requireLoss(t, losses, lossUnsafeLink)
	requireLoss(t, losses, lossImageDescription)
}

func TestProjectBodyRendersGFMTableWithAlignmentAndLiteralCells(t *testing.T) {
	document := `{"type":"doc","content":[{"type":"table","content":[` +
		`{"type":"tableRow","content":[` +
		`{"type":"tableHeader","attrs":{"align":"left","colspan":1,"rowspan":1,"colwidth":null},"content":[{"type":"paragraph","content":[{"type":"text","text":"Name | literal"}]}]},` +
		`{"type":"tableHeader","attrs":{"align":"right","colspan":1,"rowspan":1,"colwidth":null},"content":[{"type":"paragraph","content":[{"type":"text","text":"Count"}]}]}` +
		`]},` +
		`{"type":"tableRow","content":[` +
		`{"type":"tableCell","attrs":{"align":"left"},"content":[{"type":"paragraph","content":[{"type":"text","text":"*Nix*","marks":[{"type":"bold"}]}]},{"type":"paragraph","content":[{"type":"text","text":"next"}]}]},` +
		`{"type":"tableCell","attrs":{"align":"right"},"content":[{"type":"paragraph","content":[{"type":"reference","attrs":{"kind":"item","targetId":"42","label":"Forty two"}}]}]}` +
		`]}` +
		`]}]}`
	markdown, losses := projectMarkdown(t, document)
	want := "| Name \\| literal | Count |\n| :--- | ---: |\n| \\*Nix\\*next | Forty two |"
	if markdown != want {
		t.Fatalf("ProjectBody() = %q; want %q", markdown, want)
	}
	requireLoss(t, losses, lossTable)
}

func TestProjectBodyRendersDetailsAsSafeHTML(t *testing.T) {
	document := `{"type":"doc","content":[{"type":"details","attrs":{"toggleLevel":"2"},"content":[` +
		`{"type":"detailsSummary","content":[{"type":"text","text":"Show <details>","marks":[{"type":"bold"}]}]},` +
		`{"type":"detailsContent","content":[{"type":"paragraph","content":[{"type":"text","text":"Here they are."}]}]}` +
		`]}]}`
	markdown, losses := projectMarkdown(t, document)
	want := "<details data-toggle-level=\"2\">\n<summary><strong>Show &lt;details&gt;</strong></summary>\n\nHere they are.\n\n</details>"
	if markdown != want || len(losses) != 0 {
		t.Fatalf("ProjectBody() = %q, %#v; want %q", markdown, losses, want)
	}
}

func TestProjectBodyReportsEveryUnsupportedMarkOnce(t *testing.T) {
	document := `{"type":"doc","content":[{"type":"paragraph","content":[` +
		`{"type":"text","text":"under","marks":[{"type":"underline"}]},` +
		`{"type":"text","text":" high","marks":[{"type":"highlight"}]},` +
		`{"type":"text","text":" colour","marks":[{"type":"textColor","attrs":{"text":"danger"}}]},` +
		`{"type":"text","text":" comment","marks":[{"type":"comment","attrs":{"threadId":"one"}},{"type":"comment","attrs":{"threadId":"two"}}]},` +
		`{"type":"text","text":" future","marks":[{"type":"futureMark"}]}` +
		`]}]}`
	markdown, losses := projectMarkdown(t, document)
	if markdown != "under high colour comment future" {
		t.Fatalf("ProjectBody() = %q", markdown)
	}
	for _, expected := range []string{lossUnderline, lossHighlight, lossTextColor, lossComment, lossUnknownMark} {
		requireLoss(t, losses, expected)
	}
	if len(losses) != 5 {
		t.Fatalf("losses were not deduplicated: %#v", losses)
	}
}

func TestProjectBodyFlattensColumnsAndUnknownNodesWithoutLosingText(t *testing.T) {
	document := `{"type":"doc","content":[{"type":"columnBlock","content":[` +
		`{"type":"column","content":[{"type":"paragraph","content":[{"type":"text","text":"Left"}]}]},` +
		`{"type":"column","content":[{"type":"futureBlock","content":[{"type":"paragraph","content":[{"type":"text","text":"Right"}]}]}]}` +
		`]}]}`
	markdown, losses := projectMarkdown(t, document)
	if markdown != "Left\n\nRight" {
		t.Fatalf("ProjectBody() = %q", markdown)
	}
	requireLoss(t, losses, lossColumns)
	requireLoss(t, losses, lossUnknownNode)
}

func TestProjectBodyPlainTextDoesNotLeakMarkdownSyntax(t *testing.T) {
	document := proseEnvelope(`{"type":"doc","content":[` +
		`{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Title","marks":[{"type":"bold"}]}]},` +
		`{"type":"paragraph","content":[{"type":"text","text":"Site","marks":[{"type":"link","attrs":{"href":"https://example.test"}}]}]},` +
		`{"type":"image","attrs":{"src":"https://example.test/a.png","alt":"Preview"}}` +
		`]}`)
	plain, losses, err := ProjectBody(document, false, 4096)
	if err != nil {
		t.Fatal(err)
	}
	want := "Title\n\nSite (https://example.test)\n\n[Image: Preview] (https://example.test/a.png)"
	if plain != want || strings.Contains(plain, "**") || strings.Contains(plain, "![") {
		t.Fatalf("ProjectBody() = %q, %#v; want %q", plain, losses, want)
	}
	requireLoss(t, losses, lossPlainFormatting)
	requireLoss(t, losses, lossPlainImage)
}

func TestProjectBodyEnforcesCumulativeDecodeAllocationBudget(t *testing.T) {
	body := proseEnvelope(`{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"bounded"}]}]}`)
	_, err := decodeProseBody(body, 256)
	if err == nil || !strings.Contains(err.Error(), "cumulative decoding allocation limit") {
		t.Fatalf("decodeProseBody() error = %v", err)
	}
}

func TestProjectBodyRejectsDeepAndOversizedOutput(t *testing.T) {
	node := `{"type":"paragraph","content":[{"type":"text","text":"end"}]}`
	for range maximumProseDepth + 2 {
		node = `{"type":"blockquote","content":[` + node + `]}`
	}
	if _, _, err := ProjectBody(proseEnvelope(node), true, 1<<20); err == nil || !strings.Contains(err.Error(), "nesting limit") {
		t.Fatalf("deep ProjectBody() error = %v", err)
	}

	_, _, err := ProjectBody(proseEnvelope(`{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"too long"}]}]}`), true, 4)
	if err == nil || !strings.Contains(err.Error(), "byte limit") {
		t.Fatalf("bounded ProjectBody() error = %v", err)
	}
}

func TestProjectBodyRejectsTrailingOrInvalidJSON(t *testing.T) {
	for _, body := range []json.RawMessage{
		json.RawMessage(`{"schemaVersion":2,"prosemirror":{"type":"doc"}} true`),
		json.RawMessage("{\"schemaVersion\":2,\"prosemirror\":\xff}"),
	} {
		if _, _, err := ProjectBody(body, true, 4096); err == nil {
			t.Fatalf("ProjectBody(%q) unexpectedly succeeded", body)
		}
	}
}

func TestProjectTitleEscapesInlineMarkdownWithoutReportingLoss(t *testing.T) {
	title, lost := ProjectTitle("A *literal* [title] | `code`", true)
	if title != "A \\*literal\\* \\[title\\] \\| \\`code\\`" || lost {
		t.Fatalf("ProjectTitle() = %q, %v", title, lost)
	}
}

func TestProjectBodyReportsMalformedNodeShapeWithoutLeakingJSON(t *testing.T) {
	markdown, losses, err := ProjectBody(json.RawMessage(`{"schemaVersion":2,"prosemirror":{"type":"doc","content":{}}}`), true, 4096)
	if err != nil {
		t.Fatal(err)
	}
	if markdown != "" {
		t.Fatalf("ProjectBody() = %q", markdown)
	}
	requireLoss(t, losses, lossMalformedContent)
}

func TestProjectBodyReportsTextAlignmentLossAndAcceptsDefaultAlignment(t *testing.T) {
	for _, alignment := range []string{`null`, `"left"`, `"center"`, `"right"`} {
		document := `{"type":"doc","content":[{"type":"paragraph","attrs":{"textAlign":` + alignment + `},"content":[{"type":"text","text":"One line"},{"type":"hardBreak"},{"type":"text","text":"Next line"}]}]}`
		markdown, losses := projectMarkdown(t, document)
		if markdown != "One line\\\nNext line" {
			t.Fatalf("manual line break was changed: %q", markdown)
		}
		if alignment == `"center"` || alignment == `"right"` {
			requireLoss(t, losses, lossTextAlignment)
		} else if len(losses) != 0 {
			t.Fatalf("default alignment reported losses: %#v", losses)
		}
	}
}

func TestProjectBodyRendersDocumentsAsIfSuggestionsWereRejected(t *testing.T) {
	mark := `{"type":"%s","attrs":{"id":"s1","authorId":"a","createdAt":"now"}}`
	insert := strings.Replace(mark, "%s", "suggestionInsert", 1)
	del := strings.Replace(mark, "%s", "suggestionDelete", 1)
	format := `{"type":"suggestionFormat","attrs":{"id":"s3","authorId":"a","createdAt":"now","before":"[{\"type\":\"italic\"}]"}}`
	suggestion := `"attrs":{"suggestion":{"id":"s2","authorId":"a","createdAt":"now","op":"insert"}}`
	document := `{"type":"doc","content":[` +
		`{"type":"paragraph","content":[` +
		`{"type":"text","text":"kept "},` +
		`{"type":"text","text":"proposed","marks":[` + insert + `]},` +
		`{"type":"text","text":"struck","marks":[` + del + `]},` +
		`{"type":"text","text":" formatted","marks":[{"type":"bold"},` + format + `]}]},` +
		`{"type":"paragraph",` + suggestion + `,"content":[{"type":"text","text":"new block","marks":[` + insert + `]}]},` +
		`{"type":"paragraph",` + suggestion + `,"content":[{"type":"text","text":" tail"}]}` +
		`]}`
	markdown, losses := projectMarkdown(t, document)
	if want := "kept struck *formatted* tail"; markdown != want || len(losses) != 0 {
		t.Fatalf("markdown = %q, losses = %#v, want %q", markdown, losses, want)
	}
}
