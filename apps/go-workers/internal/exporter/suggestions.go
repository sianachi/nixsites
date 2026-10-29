package exporter

import (
	"encoding/json"
	"slices"
	"strings"
)

// Suggestions are proposals, not content: every export draws the document as if all were
// rejected. Inserted text and blocks go, deleted text and blocks stay, a format change goes back
// to its original marks. A restructure (list wrap, indent) keeps its new structure: the original
// is stored as a ProseMirror slice; the run of blocks it produced is replaced by that snapshot,
// unless the snapshot is open (it cannot be placed without its surroundings).

var suggestionMarks = map[string]bool{"suggestionInsert": true, "suggestionDelete": true, "suggestionFormat": true}

var proseTextblocks = map[string]bool{"paragraph": true, "heading": true, "codeBlock": true, "detailsSummary": true}

func (parser *proseDecoder) rejectSuggestions(children []proseNode) []proseNode {
	var out []proseNode
	for index := 0; index < len(children); index++ {
		child := children[index]
		if child.Type == "text" {
			if text, keep := parser.rejectText(child); keep {
				out = appendProseText(out, text)
			}
			continue
		}
		if child.Attrs.suggestionOp == "restructure" && child.Attrs.suggestionBefore != "" {
			if original, closed := parser.restructureSnapshot(child.Attrs.suggestionBefore); closed {
				for index+1 < len(children) && children[index+1].Attrs.suggestionOp != "" &&
					children[index+1].Attrs.suggestionID == child.Attrs.suggestionID {
					index++
				}
				out = append(out, parser.rejectSuggestions(original)...)
				continue
			}
		}
		insert := child.Attrs.suggestionOp == "insert"
		child.Attrs.suggestionOp = ""
		child.Content = parser.rejectSuggestions(child.Content)
		switch {
		case !insert:
			out = append(out, child)
		case !hasProseText(child):
		case len(out) > 0 && mergeProseInto(&out[len(out)-1], child):
		default:
			out = append(out, child)
		}
	}
	return out
}

// restructureSnapshot reads the JSON of the slice a restructure replaced. The boolean is false for
// a snapshot that is open, malformed or has no content.
func (parser *proseDecoder) restructureSnapshot(snapshot string) ([]proseNode, bool) {
	sub := proseDecoder{decoder: json.NewDecoder(strings.NewReader(snapshot)), budget: parser.budget}
	sub.decoder.UseNumber()
	if token, err := sub.token(); err != nil || token != json.Delim('{') {
		return nil, false
	}
	var content []proseNode
	found, open := false, false
	for sub.decoder.More() {
		name, err := sub.objectKey()
		if err != nil {
			return nil, false
		}
		switch name {
		case "content":
			var malformed bool
			if content, malformed, err = sub.content(1); err != nil || malformed {
				return nil, false
			}
			found = true
		case "openStart", "openEnd":
			token, err := sub.token()
			if number, ok := token.(json.Number); err != nil || !ok || number.String() != "0" {
				open = true
			}
		default:
			if err := sub.skipValue(1); err != nil {
				return nil, false
			}
		}
	}
	if !found || open || sub.close('}') != nil {
		return nil, false
	}
	parser.budget = sub.budget
	return content, true
}

func (parser *proseDecoder) rejectText(node proseNode) (proseNode, bool) {
	var format *proseMark
	suggested := false
	for index := range node.Marks {
		switch node.Marks[index].Type {
		case "suggestionInsert":
			return node, false
		case "suggestionFormat":
			format = &node.Marks[index]
			suggested = true
		case "suggestionDelete":
			suggested = true
		}
	}
	if !suggested {
		return node, true
	}
	var kept []proseMark
	for _, mark := range node.Marks {
		if mark.Type != "suggestionFormat" && mark.Type != "suggestionDelete" {
			kept = append(kept, mark)
		}
	}
	if format != nil && format.Attrs.before != "" {
		sub := proseDecoder{decoder: json.NewDecoder(strings.NewReader(format.Attrs.before)), budget: parser.budget}
		sub.decoder.UseNumber()
		if before, malformed, err := sub.marks(1); err == nil && !malformed {
			kept = before
			parser.budget = sub.budget
		}
	}
	node.Marks = kept
	return node, true
}

func appendProseText(nodes []proseNode, node proseNode) []proseNode {
	if last := len(nodes) - 1; last >= 0 && nodes[last].Type == "text" && slices.Equal(nodes[last].Marks, node.Marks) {
		nodes[last].Text += node.Text
		return nodes
	}
	return append(nodes, node)
}

func hasProseText(node proseNode) bool {
	if node.Type == "text" {
		return true
	}
	for _, child := range node.Content {
		if hasProseText(child) {
			return true
		}
	}
	return false
}

// mergeProseInto moves the text a split block still holds onto the block before it.
func mergeProseInto(previous *proseNode, node proseNode) bool {
	if proseTextblocks[previous.Type] && proseTextblocks[node.Type] {
		var content []proseNode
		for _, child := range append(append([]proseNode{}, previous.Content...), node.Content...) {
			content = appendProseText(content, child)
		}
		previous.Content = content
		return true
	}
	if len(previous.Content) == 0 || len(node.Content) == 0 {
		return false
	}
	content := append([]proseNode{}, previous.Content...)
	if !mergeProseInto(&content[len(content)-1], node.Content[0]) {
		return false
	}
	previous.Content = append(content, node.Content[1:]...)
	return true
}
