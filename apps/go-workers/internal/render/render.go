// Package render is the Go side of `nix-render`: the presentation tree Collab produces from a
// document body (packages/export/src/render.ts) and the only shape of a body this worker ever
// reads or writes. Nothing here names a ProseMirror node; a schema change is a TypeScript change.
//
// A reader rejects an unknown format or major version outright - a job fails rather than
// flattening a document it cannot read - and skips an unknown block kind with a loss, so a minor
// addition to the vocabulary never silently drops content.
package render

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const (
	Format  = "nix-render"
	Version = 1

	maximumDepth = 64
)

// Run is a span of text in one style, optionally a link.
type Run struct {
	Text   string   `json:"text"`
	Styles []string `json:"styles,omitempty"`
	Href   string   `json:"href,omitempty"`
}

type ListItem struct {
	// Checked is present on task-list items only.
	Checked *bool   `json:"checked,omitempty"`
	Blocks  []Block `json:"blocks"`
}

type Row struct {
	Header bool    `json:"header"`
	Cells  [][]Run `json:"cells"`
}

// Block is every block kind in one struct: the fields a kind does not use stay zero. A tagged
// union would cost a custom decoder for no safety the kind switch does not already give.
type Block struct {
	Kind string `json:"kind"`

	// paragraph, heading
	Runs  []Run  `json:"runs,omitempty"`
	Level int    `json:"level,omitempty"`
	Align string `json:"align,omitempty"`

	// callout
	Tone string `json:"tone,omitempty"`

	// code
	Language   *string `json:"language,omitempty"`
	Text       string  `json:"text,omitempty"`
	RenderFile string  `json:"renderFile,omitempty"`

	// image
	Src   string `json:"src,omitempty"`
	Alt   string `json:"alt,omitempty"`
	File  string `json:"file,omitempty"`
	Width int    `json:"width,omitempty"`

	// list
	Ordered bool       `json:"ordered,omitempty"`
	Start   int        `json:"start,omitempty"`
	Items   []ListItem `json:"items,omitempty"`

	// table
	Rows []Row `json:"rows,omitempty"`

	// details
	Summary []Run `json:"summary,omitempty"`

	// quote, callout, details
	Blocks []Block `json:"blocks,omitempty"`
}

type Document struct {
	Format  string   `json:"format"`
	Version int      `json:"version"`
	Blocks  []Block  `json:"blocks"`
	Losses  []string `json:"losses"`
}

// Kinds this build draws. Anything else is reported and skipped.
var Kinds = []string{"paragraph", "heading", "quote", "callout", "code", "rule", "pageBreak", "image", "list", "table", "details"}

func Known(kind string) bool {
	for _, known := range Kinds {
		if kind == known {
			return true
		}
	}
	return false
}

// Decode reads a tree a newer or older Collab may have written. The version check is the whole
// contract: a worker that cannot read a tree says so instead of drawing a guess.
func Decode(raw json.RawMessage) (Document, error) {
	var document Document
	if err := json.Unmarshal(raw, &document); err != nil {
		return Document{}, fmt.Errorf("decode render tree: %w", err)
	}
	if document.Format != Format || document.Version != Version {
		return Document{}, fmt.Errorf("unsupported render tree %q version %d; this worker reads %s version %d", document.Format, document.Version, Format, Version)
	}
	if depth(document.Blocks, 0) > maximumDepth {
		return Document{}, errors.New("render tree exceeds the nesting limit")
	}
	if document.Losses == nil {
		document.Losses = []string{}
	}
	return document, nil
}

func depth(blocks []Block, current int) int {
	deepest := current
	for _, block := range blocks {
		if current+1 > maximumDepth {
			return current + 1
		}
		deepest = max(deepest, depth(block.Blocks, current+1))
		for _, item := range block.Items {
			deepest = max(deepest, depth(item.Blocks, current+1))
		}
	}
	return deepest
}

// Walk visits every block, depth first, including those nested in quotes, lists and details.
func Walk(blocks []Block, visit func(*Block)) {
	for index := range blocks {
		visit(&blocks[index])
		Walk(blocks[index].Blocks, visit)
		for item := range blocks[index].Items {
			Walk(blocks[index].Items[item].Blocks, visit)
		}
	}
}

// Encode writes a document the TypeScript side will accept: the format and version filled in and
// the lists present even when empty.
func (document Document) Encode() ([]byte, error) {
	if document.Format == "" {
		document.Format, document.Version = Format, Version
	}
	if document.Losses == nil {
		document.Losses = []string{}
	}
	if document.Blocks == nil {
		document.Blocks = []Block{}
	}
	return json.Marshal(document)
}

// Has reports whether a run carries a style.
func (run Run) Has(style string) bool {
	for _, candidate := range run.Styles {
		if candidate == style {
			return true
		}
	}
	return false
}

// Plain is the text of runs without any styling, for places that draw text only.
func Plain(runs []Run) string {
	var output strings.Builder
	for _, run := range runs {
		output.WriteString(run.Text)
	}
	return output.String()
}

// Builders for the sections the worker adds itself (properties, views, comments): schema-free
// text that still has to come out as blocks so one renderer draws everything.

func Paragraph(text string) Block { return Block{Kind: "paragraph", Runs: []Run{{Text: text}}} }
func Heading(level int, text string) Block {
	return Block{Kind: "heading", Level: level, Runs: []Run{{Text: text}}}
}
func Bullets(lines []string) Block {
	items := make([]ListItem, 0, len(lines))
	for _, line := range lines {
		items = append(items, ListItem{Blocks: []Block{Paragraph(line)}})
	}
	return Block{Kind: "list", Items: items}
}
func Quote(text string) Block { return Block{Kind: "quote", Blocks: []Block{Paragraph(text)}} }

// Markdown writes blocks as CommonMark/GFM. It exists for the Markdown export format and for the
// worker's own sections; the document body itself was shaped by Collab, so this never has to know
// what a schema node is, only what a block is.
func Markdown(blocks []Block) string {
	var output strings.Builder
	writeMarkdown(&output, blocks, "")
	return strings.TrimSpace(output.String())
}

func writeMarkdown(output *strings.Builder, blocks []Block, prefix string) {
	for index, block := range blocks {
		if index > 0 {
			output.WriteString("\n" + strings.TrimRight(prefix, " ") + "\n")
		}
		switch block.Kind {
		case "heading":
			output.WriteString(prefix + strings.Repeat("#", min(max(block.Level, 1), 6)) + " " + inlineMarkdown(block.Runs))
		case "quote":
			var inner strings.Builder
			writeMarkdown(&inner, block.Blocks, "")
			output.WriteString(prefixLines(inner.String(), prefix+"> "))
		case "callout":
			var inner strings.Builder
			inner.WriteString("[!" + strings.ToUpper(block.Tone) + "]\n\n")
			writeMarkdown(&inner, block.Blocks, "")
			output.WriteString(prefixLines(inner.String(), prefix+"> "))
		case "code":
			language := ""
			if block.Language != nil {
				language = strings.Map(func(r rune) rune {
					if r == '`' || r == '\n' || r == '\r' {
						return -1
					}
					return r
				}, *block.Language)
			}
			output.WriteString(prefixLines("```"+language+"\n"+block.Text+"\n```", prefix))
		case "rule":
			output.WriteString(prefix + "---")
		case "pageBreak":
			output.WriteString(prefix + "<!-- nix-page-break -->")
		case "image":
			output.WriteString(prefix + "![" + escapeMarkdown(block.Alt) + "](" + markdownDestination(block.Src) + ")")
		case "list":
			for item, entry := range block.Items {
				if item > 0 {
					output.WriteString("\n")
				}
				marker := "- "
				if block.Ordered {
					start := block.Start
					if start < 1 {
						start = 1
					}
					marker = strconv.Itoa(start+item) + ". "
				}
				if entry.Checked != nil {
					if *entry.Checked {
						marker += "[x] "
					} else {
						marker += "[ ] "
					}
				}
				var inner strings.Builder
				writeMarkdown(&inner, entry.Blocks, "")
				body := prefixLines(inner.String(), strings.Repeat(" ", len(marker)))
				output.WriteString(prefix + marker + strings.TrimPrefix(body, strings.Repeat(" ", len(marker))))
			}
		case "table":
			if len(block.Rows) == 0 {
				continue
			}
			width := 0
			for _, row := range block.Rows {
				width = max(width, len(row.Cells))
			}
			line := func(cells [][]Run) string {
				parts := make([]string, width)
				for column := range parts {
					if column < len(cells) {
						parts[column] = strings.ReplaceAll(strings.ReplaceAll(inlineMarkdown(cells[column]), "|", "\\|"), "\n", " ")
					}
				}
				return prefix + "| " + strings.Join(parts, " | ") + " |"
			}
			output.WriteString(line(block.Rows[0].Cells) + "\n")
			output.WriteString(prefix + "|" + strings.Repeat(" --- |", width))
			for _, row := range block.Rows[1:] {
				output.WriteString("\n" + line(row.Cells))
			}
		case "details":
			open := "<details>"
			if block.Level > 0 {
				open = `<details data-toggle-level="` + strconv.Itoa(block.Level) + `">`
			}
			var inner strings.Builder
			writeMarkdown(&inner, block.Blocks, "")
			output.WriteString(prefixLines(open+"\n<summary>"+inlineMarkdown(block.Summary)+"</summary>\n\n"+inner.String()+"\n\n</details>", prefix))
		default: // paragraph, and any kind this build does not know but whose runs it can keep.
			output.WriteString(prefixLines(inlineMarkdown(block.Runs), prefix))
		}
	}
}

func prefixLines(text, prefix string) string {
	lines := strings.Split(text, "\n")
	for index, line := range lines {
		if line == "" {
			lines[index] = strings.TrimRight(prefix, " ")
		} else {
			lines[index] = prefix + line
		}
	}
	return strings.Join(lines, "\n")
}

func inlineMarkdown(runs []Run) string {
	var output strings.Builder
	for _, run := range runs {
		if run.Text == "\n" {
			output.WriteString("\\\n")
			continue
		}
		text := escapeMarkdown(run.Text)
		if run.Has("code") {
			text = "`" + strings.ReplaceAll(run.Text, "`", "\\`") + "`"
		}
		if run.Has("strike") {
			text = "~~" + text + "~~"
		}
		if run.Has("italic") {
			text = "*" + text + "*"
		}
		if run.Has("bold") {
			text = "**" + text + "**"
		}
		if run.Href != "" {
			text = "[" + text + "](" + markdownDestination(run.Href) + ")"
		}
		output.WriteString(text)
	}
	return output.String()
}

func escapeMarkdown(value string) string {
	var output strings.Builder
	output.Grow(len(value))
	atLineStart := true
	for _, character := range value {
		if strings.ContainsRune("\\`*_[]<|~", character) || atLineStart && strings.ContainsRune("#>-+", character) {
			output.WriteByte('\\')
		}
		output.WriteRune(character)
		atLineStart = character == '\n'
	}
	return output.String()
}

func markdownDestination(value string) string {
	if strings.ContainsAny(value, " \t") {
		return "<" + strings.NewReplacer("\\", "\\\\", "<", "%3C", ">", "%3E", `"`, "%22").Replace(value) + ">"
	}
	return strings.NewReplacer("\\", "\\\\", "(", "\\(", ")", "\\)", "<", "%3C", ">", "%3E", `"`, "%22").Replace(value)
}
