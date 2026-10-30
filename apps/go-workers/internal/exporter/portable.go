package exporter

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
	"github.com/sianachi/Nix/apps/go-workers/internal/render"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

const maximumPortableDepth = 64

// Projected is one bundle ready to draw: the body as Collab shaped it, followed by the sections
// the worker adds (properties, fields, views, comments), with the rasters the image blocks name.
type Projected struct {
	Blocks []render.Block
	Images []stream.Image
	Losses []string
}

// ProjectBundle turns a bundle into blocks. The document body arrives as a `nix-render` tree
// (Collab's `?shape=render`); a sheet, canvas or unknown body kind still arrives as JSON and is
// inventoried as text, because those have no presentation to reshape. `maximumBytes` bounds the
// text this produces, counted over every run.
func ProjectBundle(bundle nixarchive.Bundle, maximumBytes int, load ImageLoader) (Projected, error) {
	if maximumBytes <= 0 {
		return Projected{}, errors.New("projection limit must be positive")
	}
	// Keep decimal text exact instead of going through the archive reader's generic float values.
	if len(bundle.Raw) > 0 {
		var metadata struct {
			Properties map[string]any `json:"properties"`
		}
		if err := decodePortableJSON(bundle.Raw, &metadata); err != nil {
			return Projected{}, err
		}
		bundle.Properties = metadata.Properties
	}
	var out Projected
	out.Losses = append(out.Losses, bundle.BodyLosses...)
	switch {
	case bundle.Type == "file":
		out.Blocks = append(out.Blocks,
			render.Heading(2, "Attachment"),
			render.Block{Kind: "paragraph", Runs: []render.Run{{Text: bundle.Title, Href: "nix://item/" + bundle.ID}}},
			render.Paragraph("Open the original attachment in Nix."))
		out.Losses = append(out.Losses, "Attachments are linked to their original Nix items; binary contents are not embedded as editable text.")
	case isJSONValue(bundle.Render):
		document, err := render.Decode(bundle.Render)
		if err != nil {
			return Projected{}, err
		}
		out.Losses = append(out.Losses, document.Losses...)
		out.Blocks = document.Blocks
		render.Walk(out.Blocks, func(block *render.Block) {
			if !render.Known(block.Kind) {
				appendLoss(&out.Losses, fmt.Sprintf("A %q block written by a newer version of Nix was drawn as its text only.", block.Kind))
			}
		})
		images, err := loadImages(out.Blocks, load, &out.Losses)
		if err != nil {
			return Projected{}, err
		}
		out.Images = images
	case isJSONValue(bundle.Body):
		blocks, losses, err := projectNonProseBody(bundle.Body)
		if err != nil {
			return Projected{}, err
		}
		out.Blocks, out.Losses = append(out.Blocks, blocks...), append(out.Losses, losses...)
	}
	sections, losses, err := portableSections(bundle)
	if err != nil {
		return Projected{}, err
	}
	out.Blocks = append(out.Blocks, sections...)
	out.Losses = append(out.Losses, losses...)
	if len(out.Blocks) == 0 {
		out.Blocks = []render.Block{render.Paragraph("Empty item.")}
	}
	if err := sanitizeBlocks(out.Blocks, maximumBytes); err != nil {
		return Projected{}, err
	}
	return out, nil
}

func isJSONValue(raw json.RawMessage) bool {
	return len(raw) > 0 && !bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func appendLoss(losses *[]string, loss string) {
	for _, existing := range *losses {
		if existing == loss {
			return
		}
	}
	*losses = append(*losses, loss)
}

// sanitizeBlocks cleans every piece of text once and enforces the byte budget, so no renderer
// has to do either.
func sanitizeBlocks(blocks []render.Block, maximumBytes int) error {
	remaining := maximumBytes
	spend := func(text *string) {
		*text = sanitizeText(*text)
		remaining -= len(*text)
	}
	runs := func(runs []render.Run) {
		for index := range runs {
			spend(&runs[index].Text)
		}
	}
	render.Walk(blocks, func(block *render.Block) {
		runs(block.Runs)
		runs(block.Summary)
		spend(&block.Text)
		spend(&block.Alt)
		for row := range block.Rows {
			for _, cell := range block.Rows[row].Cells {
				runs(cell)
			}
		}
	})
	if remaining < 0 {
		return errors.New("projection exceeds the byte limit")
	}
	return nil
}

// Sections the worker adds after the body. They are text the worker owns, not document content.
func portableSections(bundle nixarchive.Bundle) ([]render.Block, []string, error) {
	var blocks []render.Block
	var losses []string
	if keys := publicKeys(bundle.Properties); len(keys) > 0 {
		blocks = append(blocks, render.Heading(2, "Properties"), propertyList(bundle.Properties))
	}
	if isJSONValue(bundle.Schema) {
		var schema struct {
			Properties []map[string]any `json:"properties"`
		}
		if err := json.Unmarshal(bundle.Schema, &schema); err != nil {
			return nil, nil, err
		}
		if len(schema.Properties) > 0 {
			blocks = append(blocks, render.Heading(2, "Fields"))
		}
		for _, property := range schema.Properties {
			blocks = append(blocks, render.Heading(3, displayValue(property["label"], 0)), propertyList(property))
		}
	}
	var configuration struct {
		Views []struct {
			Name            string         `json:"name"`
			Kind            string         `json:"kind"`
			Columns         []string       `json:"columns"`
			GroupBy         string         `json:"groupBy"`
			DateProperty    string         `json:"dateProperty"`
			Filters         []any          `json:"filters"`
			InteractiveForm map[string]any `json:"interactiveForm"`
		} `json:"views"`
	}
	if isJSONValue(bundle.Views) {
		if err := json.Unmarshal(bundle.Views, &configuration); err != nil {
			return nil, nil, fmt.Errorf("decode export views: %w", err)
		}
	}
	if len(configuration.Views) > 0 {
		blocks = append(blocks, render.Heading(2, "Views"))
		for _, view := range configuration.Views {
			blocks = append(blocks, render.Heading(3, view.Name+" ("+strings.ReplaceAll(view.Kind, "_", " ")+")"))
			if len(view.Columns) > 0 {
				blocks = append(blocks, render.Paragraph("Fields: "+strings.Join(view.Columns, ", ")))
			}
			if view.GroupBy != "" {
				blocks = append(blocks, render.Paragraph("Group by: "+view.GroupBy))
			}
			if view.DateProperty != "" {
				blocks = append(blocks, render.Paragraph("Date field: "+view.DateProperty))
			}
			if len(view.Filters) > 0 {
				blocks = append(blocks, render.Paragraph("Saved filters: "+displayValue(view.Filters, 0)))
			}
			if view.Kind == "interactive_form" && view.InteractiveForm != nil {
				blocks = append(blocks, render.Paragraph("Static form. All pages and conditional fields are shown."), propertyList(view.InteractiveForm))
			} else {
				blocks = append(blocks, render.Paragraph("Readable source records are included below."))
			}
		}
		blocks = append(blocks, render.Heading(3, "Source records"),
			render.Paragraph("Static snapshot of accessible children. Saved queries, filters, chart calculations, habit check-in history and live controls are not evaluated here."))
		losses = append(losses, "Views are represented by their accessible source records and form content; live queries, calculations and interactions are not reproduced.")
		if len(bundle.ViewRows) == 0 {
			blocks = append(blocks, render.Paragraph("No accessible source records were included."))
		}
		for _, raw := range bundle.ViewRows {
			var row struct {
				ID         string         `json:"id"`
				Title      string         `json:"title"`
				Properties map[string]any `json:"properties"`
			}
			if err := decodePortableJSON(raw, &row); err != nil {
				return nil, nil, fmt.Errorf("decode export source row: %w", err)
			}
			blocks = append(blocks, render.Heading(4, row.Title))
			if row.ID != "" {
				blocks = append(blocks, render.Block{Kind: "paragraph", Runs: []render.Run{{Text: "Open source", Href: "nix://item/" + row.ID}}})
			}
			blocks = append(blocks, propertyList(row.Properties))
		}
		if bundle.ViewRowsTruncated {
			blocks = append(blocks, render.Paragraph("Source records are incomplete: the export limit was reached or some records were unavailable."))
			losses = append(losses, "The exported view source records are incomplete.")
		}
	}
	if isJSONValue(bundle.Comments) {
		var threads []struct {
			Quote    string `json:"quote"`
			Resolved bool   `json:"resolved"`
			Comments []struct {
				Author    string `json:"author"`
				Body      string `json:"body"`
				CreatedAt string `json:"createdAt"`
			} `json:"comments"`
		}
		if err := json.Unmarshal(bundle.Comments, &threads); err != nil {
			return nil, nil, fmt.Errorf("decode export comments: %w", err)
		}
		if len(threads) > 0 {
			blocks = append(blocks, render.Heading(2, "Comments"))
		}
		for _, thread := range threads {
			if thread.Quote != "" {
				blocks = append(blocks, render.Quote(thread.Quote))
			}
			if thread.Resolved {
				blocks = append(blocks, render.Paragraph("(Resolved)"))
			}
			for _, comment := range thread.Comments {
				date := comment.CreatedAt
				if len(date) >= 10 {
					date = date[:10]
				}
				blocks = append(blocks,
					render.Block{Kind: "paragraph", Runs: []render.Run{{Text: comment.Author, Styles: []string{"bold"}}, {Text: " · " + date}}},
					render.Paragraph(comment.Body))
			}
		}
	}
	return blocks, losses, nil
}

// Non-prose bodies are inventoried as text rather than disappearing from document exports.
func projectNonProseBody(body json.RawMessage) ([]render.Block, []string, error) {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, nil, fmt.Errorf("decode body: %w", err)
	}
	if _, prose := envelope["prosemirror"]; prose {
		// The worker reads no schema: a document must arrive reshaped by Collab (`?shape=render`).
		return nil, nil, errors.New("document body arrived as ProseMirror; the export source must be fetched with shape=render")
	}
	var blocks []render.Block
	var losses []string
	switch {
	case envelope["sheet"] != nil:
		var sheet struct {
			Cells map[string]string `json:"cells"`
		}
		if err := json.Unmarshal(envelope["sheet"], &sheet); err != nil {
			return nil, nil, fmt.Errorf("decode spreadsheet: %w", err)
		}
		blocks = append(blocks, render.Heading(2, "Spreadsheet"), render.Paragraph("Cell contents, including formulas as written."))
		lines := make([]string, 0, len(sheet.Cells))
		for _, key := range sortedKeys(sheet.Cells) {
			lines = append(lines, key+": "+sheet.Cells[key])
		}
		if len(lines) == 0 {
			blocks = append(blocks, render.Paragraph("Empty spreadsheet."))
		} else {
			blocks = append(blocks, render.Bullets(lines))
		}
		losses = append(losses, "Spreadsheet cells and formulas are shown as text; formulas are not recalculated and grid styling is not preserved.")
	case envelope["canvas"] != nil:
		var canvas struct {
			Elements map[string]map[string]any `json:"elements"`
		}
		if err := json.Unmarshal(envelope["canvas"], &canvas); err != nil {
			return nil, nil, fmt.Errorf("decode canvas: %w", err)
		}
		blocks = append(blocks, render.Heading(2, "Canvas"), render.Paragraph("Static element inventory with text, geometry and connections."))
		count := 0
		for _, id := range sortedKeys(canvas.Elements) {
			element := canvas.Elements[id]
			if element["isDeleted"] == true {
				continue
			}
			count++
			blocks = append(blocks, render.Heading(3, displayValue(element["type"], 0)+" "+id))
			var lines []string
			for _, key := range []string{"text", "originalText", "x", "y", "width", "height", "angle", "link", "strokeColor", "backgroundColor", "fillStyle", "fontSize", "startBinding", "endBinding", "points", "customData"} {
				if value, exists := element[key]; exists {
					lines = append(lines, key+": "+displayValue(value, 0))
				}
			}
			if len(lines) > 0 {
				blocks = append(blocks, render.Bullets(lines))
			}
		}
		if count == 0 {
			blocks = append(blocks, render.Paragraph("Empty canvas."))
		}
		losses = append(losses, "Canvas elements are represented as a text inventory; their visual arrangement is described rather than drawn.")
	default:
		if len(envelope) == 0 {
			return nil, nil, nil
		}
		blocks = append(blocks, render.Heading(2, "Content"), render.Paragraph("Readable representation of this body's stored fields."))
		var lines []string
		for _, key := range sortedKeys(envelope) {
			if key == "schemaVersion" || strings.HasPrefix(key, "$") {
				continue
			}
			var value any
			if err := json.Unmarshal(envelope[key], &value); err != nil {
				return nil, nil, err
			}
			lines = append(lines, key+": "+displayValue(value, 0))
		}
		if len(lines) > 0 {
			blocks = append(blocks, render.Bullets(lines))
		}
		losses = append(losses, "An unfamiliar body kind was represented by its readable stored fields.")
	}
	return blocks, losses, nil
}

func publicKeys(values map[string]any) []string {
	keys := sortedKeys(values)
	result := keys[:0]
	for _, key := range keys {
		if !strings.HasPrefix(key, "$") && !strings.HasPrefix(key, "_nix") {
			result = append(result, key)
		}
	}
	return result
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func decodePortableJSON(raw []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	return decoder.Decode(value)
}

// propertyList is one bullet per public key, in key order.
func propertyList(values map[string]any) render.Block {
	keys := publicKeys(values)
	lines := make([]string, 0, len(keys))
	for _, key := range keys {
		lines = append(lines, key+": "+displayValue(values[key], 0))
	}
	return render.Bullets(lines)
}

func displayValue(value any, depth int) string {
	if depth > maximumPortableDepth {
		return "[Value exceeds nesting limit]"
	}
	switch value := value.(type) {
	case nil:
		return "Unset"
	case string:
		return value
	case []any:
		parts := make([]string, 0, len(value))
		for _, entry := range value {
			parts = append(parts, displayValue(entry, depth+1))
		}
		return strings.Join(parts, "; ")
	case map[string]any:
		parts := make([]string, 0, len(value))
		for _, key := range publicKeys(value) {
			parts = append(parts, key+": "+displayValue(value[key], depth+1))
		}
		return strings.Join(parts, "; ")
	default:
		return fmt.Sprint(value)
	}
}
