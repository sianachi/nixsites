package exporter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

// ProjectBundle gives every body and stored view a readable static representation. It consumes
// only the permission-filtered snapshot; it cannot fetch additional items or execute saved rules.
func ProjectBundle(bundle nixarchive.Bundle, maximumBytes int, load ImageLoader) (string, []stream.Image, []string, error) {
	// Keep decimal text exact instead of going through the archive reader's generic float values.
	if len(bundle.Raw) > 0 {
		var metadata struct {
			Properties map[string]any `json:"properties"`
		}
		if err := decodePortableJSON(bundle.Raw, &metadata); err != nil {
			return "", nil, nil, err
		}
		bundle.Properties = metadata.Properties
	}
	body, images, losses, err := ProjectBodyWithImages(bundle.Body, maximumBytes, load)
	if err != nil {
		return "", nil, nil, err
	}
	if len(bundle.Body) == 0 || bytes.Equal(bytes.TrimSpace(bundle.Body), []byte("null")) {
		body, losses = "", nil
	}
	if bundle.Type == "file" {
		body = "## Attachment\n\n[" + portableLiteral(bundle.Title) + "](nix://item/" + bundle.ID + ")\n\nOpen the original attachment in Nix."
		losses = append(losses, "Attachments are linked to their original Nix items; binary contents are not embedded as editable text.")
	}
	writer := newProseWriter(maximumBytes)
	if err := writer.write(body); err != nil {
		return "", nil, nil, err
	}
	var writeErr error
	write := func(value string) {
		if writeErr == nil {
			writeErr = writer.write(value)
		}
	}
	if len(publicKeys(bundle.Properties)) > 0 {
		write("\n\n## Properties\n\n")
		writeProperties(write, bundle.Properties)
	}
	if len(bundle.Schema) > 0 && !bytes.Equal(bytes.TrimSpace(bundle.Schema), []byte("null")) {
		var schema struct {
			Properties []map[string]any `json:"properties"`
		}
		if err := json.Unmarshal(bundle.Schema, &schema); err != nil {
			return "", nil, nil, err
		}
		if len(schema.Properties) > 0 {
			write("\n\n## Fields\n\n")
		}
		for _, property := range schema.Properties {
			write("### " + portableLiteral(displayValue(property["label"], 0)) + "\n\n")
			writeProperties(write, property)
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
	if len(bundle.Views) > 0 && !bytes.Equal(bytes.TrimSpace(bundle.Views), []byte("null")) {
		if err := json.Unmarshal(bundle.Views, &configuration); err != nil {
			return "", nil, nil, fmt.Errorf("decode export views: %w", err)
		}
	}
	if len(configuration.Views) > 0 {
		write("\n\n## Views\n\n")
		for _, view := range configuration.Views {
			write("### " + portableLiteral(view.Name) + " (" + portableLiteral(strings.ReplaceAll(view.Kind, "_", " ")) + ")\n\n")
			if len(view.Columns) > 0 {
				write("Fields: " + portableLiteral(strings.Join(view.Columns, ", ")) + "\n\n")
			}
			if view.GroupBy != "" {
				write("Group by: " + portableLiteral(view.GroupBy) + "\n\n")
			}
			if view.DateProperty != "" {
				write("Date field: " + portableLiteral(view.DateProperty) + "\n\n")
			}
			if len(view.Filters) > 0 {
				write("Saved filters: " + portableLiteral(displayValue(view.Filters, 0)) + "\n\n")
			}
			if view.Kind == "interactive_form" && view.InteractiveForm != nil {
				write("Static form. All pages and conditional fields are shown.\n\n")
				writePortableFields(write, view.InteractiveForm, 0)
			} else {
				write("Readable source records are included below.\n\n")
			}
		}
		write("### Source records\n\n")
		write("Static snapshot of accessible children. Saved queries, filters, chart calculations, habit check-in history and live controls are not evaluated here.\n\n")
		losses = append(losses, "Views are represented by their accessible source records and form content; live queries, calculations and interactions are not reproduced.")
		if len(bundle.ViewRows) == 0 {
			write("No accessible source records were included.\n\n")
		}
		for _, raw := range bundle.ViewRows {
			var row struct {
				ID         string         `json:"id"`
				Title      string         `json:"title"`
				Properties map[string]any `json:"properties"`
			}
			if err := decodePortableJSON(raw, &row); err != nil {
				return "", nil, nil, fmt.Errorf("decode export source row: %w", err)
			}
			write("#### " + portableLiteral(row.Title) + "\n\n")
			if row.ID != "" {
				write("[Open source](nix://item/" + row.ID + ")\n\n")
			}
			writeProperties(write, row.Properties)
		}
		if bundle.ViewRowsTruncated {
			write("Source records are incomplete: the export limit was reached or some records were unavailable.\n\n")
			losses = append(losses, "The exported view source records are incomplete.")
		}
	}
	if len(bundle.Comments) > 0 && !bytes.Equal(bytes.TrimSpace(bundle.Comments), []byte("null")) {
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
			return "", nil, nil, fmt.Errorf("decode export comments: %w", err)
		}
		if len(threads) > 0 {
			write("\n\n## Comments\n\n")
		}
		for _, thread := range threads {
			if thread.Quote != "" {
				write("> " + strings.ReplaceAll(portableLiteral(thread.Quote), "\n", "\n> ") + "\n\n")
			}
			if thread.Resolved {
				write("(Resolved)\n\n")
			}
			for _, comment := range thread.Comments {
				date := comment.CreatedAt
				if len(date) >= 10 {
					date = date[:10]
				}
				write("**" + portableLiteral(comment.Author) + "** · " + portableLiteral(date) + "\n\n")
				write(escapeMarkdownLiteral(sanitizeText(comment.Body), true) + "\n\n")
			}
		}
	}
	if writeErr != nil {
		return "", nil, nil, writeErr
	}
	if strings.TrimSpace(writer.String()) == "" {
		return "Empty item.", images, losses, nil
	}
	return strings.TrimSpace(writer.String()), images, losses, nil
}

// Non-prose bodies use text inventories rather than disappearing from document exports.
func projectNonProseBody(body json.RawMessage, markdown bool, maximumBytes int) (string, []string, bool, error) {
	if len(body) == 0 || len(body) > maximumProseInputBytes {
		return "", nil, false, nil
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(body, &envelope); err != nil {
		return "", nil, false, nil // The bounded prose decoder reports malformed JSON.
	}
	if _, prose := envelope["prosemirror"]; prose {
		return "", nil, false, nil
	}
	writer := newProseWriter(maximumBytes)
	var writeErr error
	write := func(value string) {
		if writeErr == nil {
			writeErr = writer.write(value)
		}
	}
	var losses []string
	switch {
	case envelope["sheet"] != nil:
		var sheet struct {
			Cells map[string]string `json:"cells"`
		}
		if err := json.Unmarshal(envelope["sheet"], &sheet); err != nil {
			return "", nil, true, fmt.Errorf("decode spreadsheet: %w", err)
		}
		write("## Spreadsheet\n\nCell contents, including formulas as written.\n\n")
		for _, key := range sortedKeys(sheet.Cells) {
			write("- " + portableLiteral(key) + ": " + portableLiteral(sheet.Cells[key]) + "\n")
		}
		if len(sheet.Cells) == 0 {
			write("Empty spreadsheet.\n")
		}
		losses = append(losses, "Spreadsheet cells and formulas are shown as text; formulas are not recalculated and grid styling is not preserved.")
	case envelope["canvas"] != nil:
		var canvas struct {
			Elements map[string]map[string]any `json:"elements"`
		}
		if err := json.Unmarshal(envelope["canvas"], &canvas); err != nil {
			return "", nil, true, fmt.Errorf("decode canvas: %w", err)
		}
		write("## Canvas\n\nStatic element inventory with text, geometry and connections.\n\n")
		count := 0
		for _, id := range sortedKeys(canvas.Elements) {
			element := canvas.Elements[id]
			if element["isDeleted"] == true {
				continue
			}
			count++
			write("### " + portableLiteral(displayValue(element["type"], 0)) + " " + portableLiteral(id) + "\n\n")
			for _, key := range []string{"text", "originalText", "x", "y", "width", "height", "angle", "link", "strokeColor", "backgroundColor", "fillStyle", "fontSize", "startBinding", "endBinding", "points", "customData"} {
				if value, exists := element[key]; exists {
					write("- " + portableLiteral(key) + ": " + portableLiteral(displayValue(value, 0)) + "\n")
				}
			}
			write("\n")
		}
		if count == 0 {
			write("Empty canvas.\n")
		}
		losses = append(losses, "Canvas elements are represented as a text inventory; their visual arrangement is described rather than drawn.")
	default:
		if len(envelope) == 0 {
			return "", nil, false, nil
		}
		write("## Content\n\nReadable representation of this body's stored fields.\n\n")
		for _, key := range sortedKeys(envelope) {
			if key == "schemaVersion" || strings.HasPrefix(key, "$") {
				continue
			}
			var value any
			if err := json.Unmarshal(envelope[key], &value); err != nil {
				return "", nil, true, err
			}
			write("- " + portableLiteral(key) + ": " + portableLiteral(displayValue(value, 0)) + "\n")
		}
		losses = append(losses, "An unfamiliar body kind was represented by its readable stored fields.")
	}
	if writeErr != nil {
		return "", nil, true, writeErr
	}
	result := strings.TrimSpace(writer.String())
	if !markdown {
		result = strings.ReplaceAll(result, "\\", "")
	}
	return result, losses, true, nil
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

func writeProperties(write func(string), values map[string]any) {
	for _, key := range publicKeys(values) {
		write("- " + portableLiteral(key) + ": " + portableLiteral(displayValue(values[key], 0)) + "\n")
	}
	write("\n")
}

func displayValue(value any, depth int) string {
	if depth > maximumProseDepth {
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

func portableLiteral(value string) string {
	return escapeMarkdownLiteral(sanitizeText(value), false)
}

// Form objects are displayed as labelled text so every page, help text and condition survives.
func writePortableFields(write func(string), values map[string]any, depth int) {
	for _, key := range publicKeys(values) {
		write("- " + portableLiteral(key) + ": " + portableLiteral(displayValue(values[key], depth+1)) + "\n")
	}
	write("\n")
}
