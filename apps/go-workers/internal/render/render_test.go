package render

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The fixture is written by packages/export/src/render.test.ts; both sides read the same file.
func sharedFixture(t *testing.T) Document {
	t.Helper()
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
	document, err := Decode(fixture.Render)
	if err != nil {
		t.Fatal(err)
	}
	return document
}

func TestGoReadsEveryBlockKindTypeScriptWrites(t *testing.T) {
	document := sharedFixture(t)
	seen := map[string]bool{}
	Walk(document.Blocks, func(block *Block) {
		if !Known(block.Kind) {
			t.Fatalf("fixture carries a kind this build does not draw: %q", block.Kind)
		}
		seen[block.Kind] = true
	})
	for _, kind := range Kinds {
		if !seen[kind] {
			t.Errorf("fixture never exercises %q", kind)
		}
	}
}

func TestDecodeRefusesAnotherVersionInsteadOfFlattening(t *testing.T) {
	for _, raw := range []string{
		`{"format":"nix-render","version":2,"blocks":[]}`,
		`{"format":"markdown","version":1,"blocks":[]}`,
		`{"blocks":[]}`,
	} {
		if _, err := Decode(json.RawMessage(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	if _, err := Decode(json.RawMessage(`{"format":"nix-render","version":1,"blocks":[{"kind":"hologram","runs":[{"text":"x"}]}]}`)); err != nil {
		t.Fatalf("an unknown kind is a loss, not a refusal: %v", err)
	}
}

func TestMarkdownOfTheFixtureIsGFM(t *testing.T) {
	markdown := Markdown(sharedFixture(t).Blocks)
	for _, want := range []string{"\n## ", "\n- ", "\n1. ", "| --- |", "```", "<!-- nix-page-break -->", "<details", "- [x] "} {
		if !strings.Contains(markdown, want) {
			t.Errorf("missing %q in:\n%s", want, markdown)
		}
	}
	nested := Markdown([]Block{{Kind: "quote", Blocks: []Block{Paragraph("a"), Bullets([]string{"b|c", "# d"})}}})
	if nested != "> a\n>\n> - b\\|c\n> - \\# d" {
		t.Fatalf("nested = %q", nested)
	}
	yes := true
	if got := Markdown([]Block{{Kind: "list", Items: []ListItem{{Checked: &yes, Blocks: []Block{Paragraph("done")}}}}}); got != "- [x] done" {
		t.Fatalf("task = %q", got)
	}
}
