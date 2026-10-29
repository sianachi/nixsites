package exporter

import (
	"encoding/json"
	"slices"
	"strings"
)

// Suggestions are proposals, not content: every export draws the document as if all were
// rejected. Inserted text and blocks go, deleted text and blocks stay, a format change goes back
// to its original marks. A restructure (list wrap, indent) keeps its new structure: the original
// is stored as a ProseMirror slice that the web renderers restore and this one does not.

var proseTextblocks = map[string]bool{"paragraph": true, "heading": true, "codeBlock": true, "detailsSummary": true}

func (parser *proseDecoder) rejectSuggestions(children []proseNode) []proseNode {
	var out []proseNode
	for _, child := range children {
		if child.Type == "text" {
			if text, keep := parser.rejectText(child); keep {
				out = appendProseText(out, text)
			}
			continue
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
