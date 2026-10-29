package exporter

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/url"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
	"unsafe"
)

const (
	maximumProseDepth           = 64
	maximumProseNodes           = 100_000
	maximumProseMarksPerNode    = 64
	maximumProseJSONTokens      = 1_000_000
	maximumProseInputBytes      = 32 << 20
	maximumProseAllocationBytes = 32 << 20
	minimumProseAllocationBytes = 64 << 10
	maximumProseNameBytes       = 128
	maximumProseAttributeBytes  = 2 << 10
)

const (
	attrLevel uint64 = 1 << iota
	attrStart
	attrToggleLevel
	attrChecked
	attrLanguage
	attrSource
	attrAlt
	attrTitle
	attrTone
	attrKind
	attrTargetID
	attrLabel
	attrHref
	attrAlign
	attrFileID
	attrWidth
	attrHeight
	attrTextAlign
	attrBefore
)

const (
	lossMalformedContent = "Malformed prose content was flattened or omitted."
	lossUnknownNode      = "Content written by an unsupported editor node was flattened or omitted."
	lossUnknownAttribute = "Attributes written by a newer editor were omitted."
	lossInvalidAttribute = "Malformed prose attributes were normalized or omitted."
	lossColumns          = "Column layout was flattened to a single column."
	lossTextAlignment    = "Text alignment was omitted from the exported document; words and line breaks were kept."
	lossTable            = "GFM uses the first row as a header and cannot preserve merged cells, column widths, per-cell alignment, multi-block cells or inline formatting."
	lossTaskList         = "A task list was written as GFM task markers; its Nix task-list structure was not preserved."
	lossUnderline        = "An underline mark was dropped; Markdown has no underline, and the text was kept."
	lossHighlight        = "A highlight mark was dropped; the text it covered was kept."
	lossTextColor        = "A text-colour mark was dropped; the text it covered was kept."
	lossComment          = "A comment mark was dropped; the text it covered was kept."
	lossUnknownMark      = "Formatting written by a newer editor was omitted while retaining its text."
	lossUnsafeLink       = "An unsafe or unsupported link target was flattened to text."
	lossLinkMetadata     = "Link target-window or relationship metadata was not preserved."
	lossImageDimensions  = "Image dimensions were not preserved by the text projection."
	lossImageDescription = "An image with no safe source was represented by its description."
	lossPlainImage       = "An image was represented by its description instead of embedded bytes."
	lossPlainFormatting  = "Inline formatting was omitted from the plain-text projection."
	lossPlainReference   = "A reference target was flattened to its label in the plain-text projection."
	lossPlainDetails     = "A collapsible section was flattened to always-visible text."
	lossControlText      = "Invalid control characters in prose text were removed."
	lossCodeLanguage     = "An invalid code-block language was omitted."
	lossCodeSpanLine     = "A line break inside inline code was normalized to a space."
)

type proseAttrs struct {
	fileID      string
	width       int
	height      int
	level       int
	start       int
	toggleLevel int
	checked     bool
	language    string
	source      string
	alt         string
	title       string
	tone        string
	kind        string
	targetID    string
	label       string
	href        string
	align       string
	textAlign   string
	// suggestionOp is a block suggestion's kind, suggestionID groups the blocks of one restructure and
	// suggestionBefore is its snapshot as JSON; before is a format suggestion's original marks as JSON.
	suggestionOp     string
	suggestionID     string
	suggestionBefore string
	before           string
	// identity records an id, authorId or createdAt attribute, which only a suggestion mark may carry.
	identity   bool
	present    uint64
	valid      uint64
	unknown    bool
	invalid    bool
	dimensions bool
	linkMeta   bool
	listStyle  bool
}

type proseNode struct {
	Type          string
	Text          string
	Attrs         proseAttrs
	Marks         []proseMark
	Content       []proseNode
	TextPresent   bool
	Malformed     bool
	UnknownFields bool
}

type proseMark struct {
	Type          string
	Attrs         proseAttrs
	Malformed     bool
	UnknownFields bool
}

type decodedProse struct {
	schemaVersion int
	root          *proseNode
}

// ProjectTitle produces a single safe display line for converted formats. The boolean reports
// actual character loss; Markdown escaping is presentation-preserving and is not a fidelity loss.
func ProjectTitle(value string, markdown bool) (string, bool) {
	var output strings.Builder
	lost := false
	space := false
	for _, character := range value {
		if character == '\n' || character == '\r' || character == '\t' {
			space = output.Len() > 0
			lost = true
			continue
		}
		if !validXMLTextRune(character) || unicode.IsControl(character) {
			lost = true
			continue
		}
		if space && character != ' ' {
			output.WriteByte(' ')
		}
		space = false
		output.WriteRune(character)
	}
	title := strings.TrimSpace(output.String())
	if title == "" {
		title = "Untitled"
		lost = true
	}
	if markdown {
		title = escapeMarkdownLiteral(title, false)
	}
	return title, lost
}

// ProjectBody maps one bounded Nix prose body to Markdown or readable plain text. Unknown
// structures retain their text children and report the fidelity loss instead of leaking JSON.
func ProjectBody(body json.RawMessage, markdown bool, maximumBytes int) (string, []string, error) {
	if maximumBytes <= 0 {
		return "", nil, errors.New("prose projection limit must be positive")
	}
	if text, losses, handled, err := projectNonProseBody(body, markdown, maximumBytes); handled {
		return text, losses, err
	}
	if len(body) == 0 || bytes.Equal(bytes.TrimSpace(body), []byte("null")) {
		return emptyBodyProjection(markdown, "A non-text or empty body was not rendered.")
	}

	decoded, err := decodeProseBody(body, proseAllocationLimit(len(body), maximumBytes))
	if err != nil {
		return "", nil, fmt.Errorf("decode body envelope: %w", err)
	}
	if decoded.schemaVersion < 1 || decoded.root == nil {
		return emptyBodyProjection(markdown, "A non-text body was not rendered.")
	}

	projection := proseProjection{
		markdown: markdown,
		writer:   newProseWriter(maximumBytes),
		losses:   make(map[string]struct{}),
	}
	if err := projection.render(decoded.root, 0); err != nil {
		return "", nil, err
	}
	return strings.TrimSpace(projection.writer.String()), projection.lossList, nil
}

func emptyBodyProjection(markdown bool, loss string) (string, []string, error) {
	message := "(This item has no text body this format can carry.)"
	if markdown {
		message = "*" + message + "*"
	}
	return message, []string{loss}, nil
}

func proseAllocationLimit(inputBytes, outputBytes int) int64 {
	// The decoder retains at most a small multiple of the input plus the requested output. The hard
	// ceiling protects callers that supply unusually large output limits, while the relative ceiling
	// prevents a compact tree of empty nodes from expanding into an unbounded object graph.
	limit := int64(min(inputBytes, maximumProseInputBytes))*4 + int64(min(outputBytes, maximumProseAllocationBytes))
	limit += minimumProseAllocationBytes
	if limit < minimumProseAllocationBytes {
		return minimumProseAllocationBytes
	}
	if limit > maximumProseAllocationBytes {
		return maximumProseAllocationBytes
	}
	return limit
}

type allocationBudget struct {
	remaining int64
}

func (budget *allocationBudget) reserve(size int64) error {
	if size < 0 || size > budget.remaining {
		return errors.New("prose document exceeds the cumulative decoding allocation limit")
	}
	budget.remaining -= size
	return nil
}

type proseDecoder struct {
	decoder *json.Decoder
	budget  allocationBudget
	nodes   int
	tokens  int
}

func decodeProseBody(body json.RawMessage, allocationLimit int64) (decodedProse, error) {
	if len(body) > maximumProseInputBytes {
		return decodedProse{}, errors.New("prose body exceeds the input byte limit")
	}
	if !utf8.Valid(body) {
		return decodedProse{}, errors.New("prose body is not valid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	parser := proseDecoder{decoder: decoder, budget: allocationBudget{remaining: allocationLimit}}

	first, err := parser.token()
	if err != nil {
		return decodedProse{}, err
	}
	if delimiter, ok := first.(json.Delim); !ok || delimiter != '{' {
		return decodedProse{}, errors.New("body envelope must be an object")
	}

	var result decodedProse
	seenSchema := false
	seenProse := false
	for decoder.More() {
		name, err := parser.objectKey()
		if err != nil {
			return decodedProse{}, err
		}
		switch name {
		case "schemaVersion":
			if seenSchema {
				return decodedProse{}, errors.New("body envelope contains duplicate schemaVersion")
			}
			seenSchema = true
			value, valid, err := parser.integer(false)
			if err != nil {
				return decodedProse{}, err
			}
			if valid {
				result.schemaVersion = value
			}
		case "prosemirror":
			if seenProse {
				return decodedProse{}, errors.New("body envelope contains duplicate prosemirror")
			}
			seenProse = true
			result.root, err = parser.node(0)
			if err != nil {
				return decodedProse{}, err
			}
			if result.root != nil {
				result.root.Content = parser.rejectSuggestions(result.root.Content)
			}
		default:
			if err := parser.skipValue(1); err != nil {
				return decodedProse{}, err
			}
		}
	}
	if err := parser.close('}'); err != nil {
		return decodedProse{}, err
	}
	if _, err := parser.token(); err != io.EOF {
		if err == nil {
			return decodedProse{}, errors.New("body envelope contains trailing JSON")
		}
		return decodedProse{}, err
	}
	return result, nil
}

func (parser *proseDecoder) token() (json.Token, error) {
	token, err := parser.decoder.Token()
	if err != nil {
		return nil, err
	}
	parser.tokens++
	if parser.tokens > maximumProseJSONTokens {
		return nil, errors.New("prose document exceeds the JSON token limit")
	}
	switch value := token.(type) {
	case string:
		if err := parser.budget.reserve(int64(len(value))); err != nil {
			return nil, err
		}
	case json.Number:
		if err := parser.budget.reserve(int64(len(value))); err != nil {
			return nil, err
		}
	}
	return token, nil
}

func (parser *proseDecoder) objectKey() (string, error) {
	token, err := parser.token()
	if err != nil {
		return "", err
	}
	value, ok := token.(string)
	if !ok {
		return "", errors.New("JSON object key must be a string")
	}
	return value, nil
}

func (parser *proseDecoder) close(expected json.Delim) error {
	token, err := parser.token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok || delimiter != expected {
		return fmt.Errorf("expected closing %q", expected)
	}
	return nil
}

func (parser *proseDecoder) node(depth int) (*proseNode, error) {
	if depth > maximumProseDepth {
		return nil, errors.New("prose document exceeds the nesting limit")
	}
	first, err := parser.token()
	if err != nil {
		return nil, err
	}
	if first == nil {
		return nil, nil
	}
	if delimiter, ok := first.(json.Delim); !ok || delimiter != '{' {
		if err := parser.skipStarted(first, depth+1); err != nil {
			return nil, err
		}
		return &proseNode{Malformed: true}, nil
	}

	parser.nodes++
	if parser.nodes > maximumProseNodes {
		return nil, errors.New("prose document exceeds the node limit")
	}
	if err := parser.budget.reserve(int64(unsafe.Sizeof(proseNode{}))); err != nil {
		return nil, err
	}

	node := &proseNode{}
	seenType := false
	seenText := false
	seenAttrs := false
	seenMarks := false
	seenContent := false
	for parser.decoder.More() {
		name, err := parser.objectKey()
		if err != nil {
			return nil, err
		}
		switch name {
		case "type":
			if seenType {
				return nil, errors.New("prose node contains duplicate type")
			}
			seenType = true
			value, present, valid, err := parser.stringValue(maximumProseNameBytes)
			if err != nil {
				return nil, err
			}
			if !present || !valid || value == "" {
				node.Malformed = true
			} else {
				node.Type = value
			}
		case "text":
			if seenText {
				return nil, errors.New("prose node contains duplicate text")
			}
			seenText = true
			value, present, valid, err := parser.stringValue(maximumProseAllocationBytes)
			if err != nil {
				return nil, err
			}
			node.TextPresent = present && valid
			if !valid {
				node.Malformed = true
			} else {
				node.Text = value
			}
		case "attrs":
			if seenAttrs {
				return nil, errors.New("prose node contains duplicate attrs")
			}
			seenAttrs = true
			if err := parser.attributes(&node.Attrs, depth+1); err != nil {
				return nil, err
			}
		case "marks":
			if seenMarks {
				return nil, errors.New("prose node contains duplicate marks")
			}
			seenMarks = true
			marks, malformed, err := parser.marks(depth + 1)
			if err != nil {
				return nil, err
			}
			node.Marks = marks
			node.Malformed = node.Malformed || malformed
		case "content":
			if seenContent {
				return nil, errors.New("prose node contains duplicate content")
			}
			seenContent = true
			content, malformed, err := parser.content(depth + 1)
			if err != nil {
				return nil, err
			}
			node.Content = content
			node.Malformed = node.Malformed || malformed
		default:
			node.UnknownFields = true
			if err := parser.skipValue(depth + 1); err != nil {
				return nil, err
			}
		}
	}
	if err := parser.close('}'); err != nil {
		return nil, err
	}
	if node.Type == "" {
		node.Malformed = true
	}
	return node, nil
}

func (parser *proseDecoder) content(depth int) ([]proseNode, bool, error) {
	first, err := parser.token()
	if err != nil {
		return nil, false, err
	}
	if first == nil {
		return nil, false, nil
	}
	delimiter, ok := first.(json.Delim)
	if !ok || delimiter != '[' {
		if err := parser.skipStarted(first, depth); err != nil {
			return nil, false, err
		}
		return nil, true, nil
	}

	var nodes []proseNode
	malformed := false
	for parser.decoder.More() {
		node, err := parser.node(depth)
		if err != nil {
			return nil, false, err
		}
		if node == nil {
			node = &proseNode{Malformed: true}
		}
		if node.Malformed {
			malformed = true
		}
		nodes, err = parser.appendNode(nodes, *node)
		if err != nil {
			return nil, false, err
		}
	}
	if err := parser.close(']'); err != nil {
		return nil, false, err
	}
	return nodes, malformed, nil
}

func (parser *proseDecoder) appendNode(nodes []proseNode, node proseNode) ([]proseNode, error) {
	if len(nodes) == cap(nodes) {
		capacity := 4
		if cap(nodes) > 0 {
			capacity = cap(nodes) * 2
		}
		if capacity > maximumProseNodes {
			capacity = maximumProseNodes
		}
		if err := parser.budget.reserve(int64(capacity) * int64(unsafe.Sizeof(proseNode{}))); err != nil {
			return nil, err
		}
		grown := make([]proseNode, len(nodes), capacity)
		copy(grown, nodes)
		nodes = grown
	}
	return append(nodes, node), nil
}

func (parser *proseDecoder) marks(depth int) ([]proseMark, bool, error) {
	first, err := parser.token()
	if err != nil {
		return nil, false, err
	}
	if first == nil {
		return nil, false, nil
	}
	delimiter, ok := first.(json.Delim)
	if !ok || delimiter != '[' {
		if err := parser.skipStarted(first, depth); err != nil {
			return nil, false, err
		}
		return nil, true, nil
	}

	var marks []proseMark
	malformed := false
	for parser.decoder.More() {
		if len(marks) >= maximumProseMarksPerNode {
			return nil, false, errors.New("prose node exceeds the mark limit")
		}
		mark, err := parser.mark(depth)
		if err != nil {
			return nil, false, err
		}
		if mark.Malformed {
			malformed = true
		}
		marks, err = parser.appendMark(marks, mark)
		if err != nil {
			return nil, false, err
		}
	}
	if err := parser.close(']'); err != nil {
		return nil, false, err
	}
	return marks, malformed, nil
}

func (parser *proseDecoder) mark(depth int) (proseMark, error) {
	first, err := parser.token()
	if err != nil {
		return proseMark{}, err
	}
	if delimiter, ok := first.(json.Delim); !ok || delimiter != '{' {
		if err := parser.skipStarted(first, depth); err != nil {
			return proseMark{}, err
		}
		return proseMark{Malformed: true}, nil
	}
	if err := parser.budget.reserve(int64(unsafe.Sizeof(proseMark{}))); err != nil {
		return proseMark{}, err
	}

	mark := proseMark{}
	seenType := false
	seenAttrs := false
	for parser.decoder.More() {
		name, err := parser.objectKey()
		if err != nil {
			return proseMark{}, err
		}
		switch name {
		case "type":
			if seenType {
				return proseMark{}, errors.New("prose mark contains duplicate type")
			}
			seenType = true
			value, present, valid, err := parser.stringValue(maximumProseNameBytes)
			if err != nil {
				return proseMark{}, err
			}
			if !present || !valid || value == "" {
				mark.Malformed = true
			} else {
				mark.Type = value
			}
		case "attrs":
			if seenAttrs {
				return proseMark{}, errors.New("prose mark contains duplicate attrs")
			}
			seenAttrs = true
			if err := parser.attributes(&mark.Attrs, depth+1); err != nil {
				return proseMark{}, err
			}
		default:
			mark.UnknownFields = true
			if err := parser.skipValue(depth + 1); err != nil {
				return proseMark{}, err
			}
		}
	}
	if err := parser.close('}'); err != nil {
		return proseMark{}, err
	}
	if mark.Type == "" {
		mark.Malformed = true
	}
	return mark, nil
}

func (parser *proseDecoder) appendMark(marks []proseMark, mark proseMark) ([]proseMark, error) {
	if len(marks) == cap(marks) {
		capacity := 4
		if cap(marks) > 0 {
			capacity = cap(marks) * 2
		}
		if capacity > maximumProseMarksPerNode {
			capacity = maximumProseMarksPerNode
		}
		if err := parser.budget.reserve(int64(capacity) * int64(unsafe.Sizeof(proseMark{}))); err != nil {
			return nil, err
		}
		grown := make([]proseMark, len(marks), capacity)
		copy(grown, marks)
		marks = grown
	}
	return append(marks, mark), nil
}

func (parser *proseDecoder) attributes(attributes *proseAttrs, depth int) error {
	first, err := parser.token()
	if err != nil {
		return err
	}
	if first == nil {
		return nil
	}
	delimiter, ok := first.(json.Delim)
	if !ok || delimiter != '{' {
		attributes.invalid = true
		return parser.skipStarted(first, depth)
	}

	for parser.decoder.More() {
		name, err := parser.objectKey()
		if err != nil {
			return err
		}
		switch name {
		case "level":
			err = parser.integerAttribute(attributes, attrLevel, &attributes.level, false)
		case "start":
			err = parser.integerAttribute(attributes, attrStart, &attributes.start, false)
		case "toggleLevel":
			err = parser.integerAttribute(attributes, attrToggleLevel, &attributes.toggleLevel, true)
		case "checked":
			err = parser.booleanAttribute(attributes, attrChecked, &attributes.checked)
		case "language":
			err = parser.stringAttribute(attributes, attrLanguage, &attributes.language)
		case "src":
			err = parser.stringAttribute(attributes, attrSource, &attributes.source)
		case "alt":
			err = parser.stringAttribute(attributes, attrAlt, &attributes.alt)
		case "title":
			err = parser.stringAttribute(attributes, attrTitle, &attributes.title)
		case "tone":
			err = parser.stringAttribute(attributes, attrTone, &attributes.tone)
		case "kind":
			err = parser.stringAttribute(attributes, attrKind, &attributes.kind)
		case "targetId":
			err = parser.stringAttribute(attributes, attrTargetID, &attributes.targetID)
		case "label":
			err = parser.stringAttribute(attributes, attrLabel, &attributes.label)
		case "href":
			err = parser.stringAttribute(attributes, attrHref, &attributes.href)
		case "textAlign":
			err = parser.stringAttribute(attributes, attrTextAlign, &attributes.textAlign)
		case "align":
			err = parser.stringAttribute(attributes, attrAlign, &attributes.align)
		case "fileItemId":
			err = parser.stringAttribute(attributes, attrFileID, &attributes.fileID)
		case "width":
			err = parser.integerAttribute(attributes, attrWidth, &attributes.width, true)
			attributes.dimensions = attributes.dimensions || attributes.width != 0
		case "height":
			err = parser.integerAttribute(attributes, attrHeight, &attributes.height, true)
			attributes.dimensions = attributes.dimensions || attributes.height != 0
		case "target", "rel", "class":
			var nonNull bool
			nonNull, err = parser.nonNullValue(depth + 1)
			attributes.linkMeta = attributes.linkMeta || nonNull
		case "type":
			var nonNull bool
			nonNull, err = parser.nonNullValue(depth + 1)
			attributes.listStyle = attributes.listStyle || nonNull
		case "suggestion":
			err = parser.suggestionAttribute(attributes, depth+1)
		case "before":
			err = parser.stringAttribute(attributes, attrBefore, &attributes.before)
		case "id", "authorId", "createdAt":
			attributes.identity = true
			err = parser.skipValue(depth + 1)
		case "colspan", "rowspan", "colwidth", "text", "background", "threadId", "presentation":
			err = parser.skipValue(depth + 1)
		default:
			attributes.unknown = true
			err = parser.skipValue(depth + 1)
		}
		if err != nil {
			return err
		}
	}
	return parser.close('}')
}

// suggestionAttribute reads a block suggestion's `op`, `id` and restructure snapshot and skips the
// rest of the object.
func (parser *proseDecoder) suggestionAttribute(attributes *proseAttrs, depth int) error {
	first, err := parser.token()
	if err != nil {
		return err
	}
	if first == nil {
		return nil
	}
	if delimiter, ok := first.(json.Delim); !ok || delimiter != '{' {
		attributes.invalid = true
		return parser.skipStarted(first, depth)
	}
	for parser.decoder.More() {
		name, err := parser.objectKey()
		if err != nil {
			return err
		}
		var destination *string
		limit := maximumProseNameBytes
		switch name {
		case "op":
			destination = &attributes.suggestionOp
		case "id":
			destination = &attributes.suggestionID
		case "before":
			destination, limit = &attributes.suggestionBefore, maximumProseAllocationBytes
		default:
			if err := parser.skipValue(depth + 1); err != nil {
				return err
			}
			continue
		}
		value, present, valid, err := parser.stringValue(limit)
		if err != nil {
			return err
		}
		if present && valid {
			*destination = value
		}
	}
	return parser.close('}')
}

func (parser *proseDecoder) stringAttribute(attributes *proseAttrs, bit uint64, destination *string) error {
	if attributes.present&bit != 0 {
		attributes.invalid = true
	}
	attributes.present |= bit
	value, present, valid, err := parser.stringValue(maximumProseAttributeBytes)
	if err != nil {
		return err
	}
	if present && valid {
		attributes.valid |= bit
		*destination = value
	} else if present {
		attributes.invalid = true
	}
	return nil
}

func (parser *proseDecoder) integerAttribute(attributes *proseAttrs, bit uint64, destination *int, allowString bool) error {
	if attributes.present&bit != 0 {
		attributes.invalid = true
	}
	attributes.present |= bit
	value, present, valid, err := parser.optionalInteger(allowString)
	if err != nil {
		return err
	}
	if present && valid {
		attributes.valid |= bit
		*destination = value
	} else if present {
		attributes.invalid = true
	}
	return nil
}

func (parser *proseDecoder) booleanAttribute(attributes *proseAttrs, bit uint64, destination *bool) error {
	if attributes.present&bit != 0 {
		attributes.invalid = true
	}
	attributes.present |= bit
	token, err := parser.token()
	if err != nil {
		return err
	}
	if token == nil {
		return nil
	}
	value, ok := token.(bool)
	if !ok {
		attributes.invalid = true
		return parser.skipStarted(token, 1)
	}
	attributes.valid |= bit
	*destination = value
	return nil
}

func (parser *proseDecoder) stringValue(maximum int) (string, bool, bool, error) {
	token, err := parser.token()
	if err != nil {
		return "", false, false, err
	}
	if token == nil {
		return "", false, true, nil
	}
	value, ok := token.(string)
	if !ok {
		if err := parser.skipStarted(token, 1); err != nil {
			return "", true, false, err
		}
		return "", true, false, nil
	}
	if len(value) > maximum {
		return "", true, false, nil
	}
	return value, true, true, nil
}

func (parser *proseDecoder) integer(allowString bool) (int, bool, error) {
	value, present, valid, err := parser.optionalInteger(allowString)
	if err != nil || !present || !valid {
		return 0, false, err
	}
	return value, true, nil
}

func (parser *proseDecoder) optionalInteger(allowString bool) (int, bool, bool, error) {
	token, err := parser.token()
	if err != nil {
		return 0, false, false, err
	}
	if token == nil {
		return 0, false, true, nil
	}
	var raw string
	switch value := token.(type) {
	case json.Number:
		raw = string(value)
	case string:
		if !allowString {
			return 0, true, false, nil
		}
		raw = value
	default:
		if err := parser.skipStarted(token, 1); err != nil {
			return 0, true, false, err
		}
		return 0, true, false, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, true, false, nil
	}
	return value, true, true, nil
}

func (parser *proseDecoder) nonNullValue(depth int) (bool, error) {
	first, err := parser.token()
	if err != nil {
		return false, err
	}
	if first == nil {
		return false, nil
	}
	return true, parser.skipStarted(first, depth)
}

func (parser *proseDecoder) skipValue(depth int) error {
	first, err := parser.token()
	if err != nil {
		return err
	}
	return parser.skipStarted(first, depth)
}

func (parser *proseDecoder) skipStarted(first json.Token, depth int) error {
	delimiter, ok := first.(json.Delim)
	if !ok {
		return nil
	}
	if depth > maximumProseDepth+8 {
		return errors.New("prose JSON exceeds the nesting limit")
	}
	switch delimiter {
	case '[':
		for parser.decoder.More() {
			if err := parser.skipValue(depth + 1); err != nil {
				return err
			}
		}
		return parser.close(']')
	case '{':
		for parser.decoder.More() {
			if _, err := parser.objectKey(); err != nil {
				return err
			}
			if err := parser.skipValue(depth + 1); err != nil {
				return err
			}
		}
		return parser.close('}')
	default:
		return errors.New("unexpected closing JSON delimiter")
	}
}

type linePrefix struct {
	content string
	blank   string
}

type proseWriter struct {
	output      strings.Builder
	maximum     int
	atLineStart bool
	prefixes    []linePrefix
}

func newProseWriter(maximum int) proseWriter {
	return proseWriter{maximum: maximum, atLineStart: true}
}

func (writer *proseWriter) String() string         { return writer.output.String() }
func (writer *proseWriter) push(prefix linePrefix) { writer.prefixes = append(writer.prefixes, prefix) }
func (writer *proseWriter) pop()                   { writer.prefixes = writer.prefixes[:len(writer.prefixes)-1] }

func (writer *proseWriter) write(value string) error {
	for len(value) > 0 {
		newline := strings.IndexByte(value, '\n')
		segment := value
		if newline >= 0 {
			segment = value[:newline]
		}
		if segment != "" {
			if writer.atLineStart {
				if err := writer.writePrefix(false); err != nil {
					return err
				}
			}
			if err := writer.append(segment); err != nil {
				return err
			}
			writer.atLineStart = false
		}
		if newline < 0 {
			return nil
		}
		if writer.atLineStart {
			if err := writer.writePrefix(true); err != nil {
				return err
			}
		}
		if err := writer.append("\n"); err != nil {
			return err
		}
		writer.atLineStart = true
		value = value[newline+1:]
	}
	return nil
}

func (writer *proseWriter) writePrefix(blank bool) error {
	for index, prefix := range writer.prefixes {
		value := prefix.content
		if blank {
			value = prefix.blank
			for later := index + 1; later < len(writer.prefixes); later++ {
				if writer.prefixes[later].blank != "" {
					// A deeper quote marker makes this a non-empty continuation line. Preserve
					// any outer quote spacing or list indentation needed to reach that marker.
					value = prefix.content
					break
				}
			}
		}
		if value != "" {
			if err := writer.append(value); err != nil {
				return err
			}
		}
	}
	return nil
}

func (writer *proseWriter) append(value string) error {
	if len(value) > writer.maximum-writer.output.Len() {
		return errors.New("prose projection exceeds the byte limit")
	}
	_, err := writer.output.WriteString(value)
	return err
}

type proseProjection struct {
	writer      proseWriter
	markdown    bool
	losses      map[string]struct{}
	lossList    []string
	scratchUsed int
}

func (projection *proseProjection) render(node *proseNode, depth int) error {
	if depth > maximumProseDepth {
		return errors.New("prose document exceeds the nesting limit")
	}
	projection.noteNodeShape(node)

	switch node.Type {
	case "doc":
		return projection.renderBlocks(node.Content, depth)
	case "paragraph":
		return projection.renderInline(node.Content, depth)
	case "heading":
		if projection.markdown {
			level := 1
			if node.Attrs.valid&attrLevel != 0 {
				level = node.Attrs.level
			}
			if level < 1 || level > 3 {
				level = min(3, max(1, level))
				projection.noteLoss(lossInvalidAttribute)
			}
			if err := projection.writer.write(strings.Repeat("#", level) + " "); err != nil {
				return err
			}
		}
		return projection.renderInline(node.Content, depth)
	case "text":
		return projection.renderText(node)
	case "hardBreak":
		if projection.markdown {
			return projection.writer.write("\\\n")
		}
		return projection.writer.write("\n")
	case "pageBreak":
		return projection.writer.write("<!-- nix-page-break -->")
	case "itemBlock":
		projection.noteLoss("A linked section is represented by its source link; nested or unavailable live content is not included.")
		node.Attrs.kind = "item"
		node.Attrs.label = "Linked item"
		return projection.renderReference(node)
	case "horizontalRule":
		if projection.markdown {
			return projection.writer.write("---")
		}
		return projection.writer.write("----------------")
	case "bulletList":
		return projection.renderList(node, depth, false, false)
	case "orderedList":
		return projection.renderList(node, depth, true, false)
	case "taskList":
		projection.noteLoss(lossTaskList)
		return projection.renderList(node, depth, false, true)
	case "listItem", "taskItem":
		return projection.renderListItem(node, depth)
	case "blockquote":
		projection.writer.push(linePrefix{content: "> ", blank: ">"})
		err := projection.renderBlocks(node.Content, depth)
		projection.writer.pop()
		return err
	case "codeBlock":
		return projection.renderCodeBlock(node)
	case "callout":
		return projection.renderCallout(node, depth)
	case "image", "fileImage":
		return projection.renderImage(node)
	case "reference", "itemReference":
		return projection.renderReference(node)
	case "table":
		return projection.renderTable(node)
	case "tableRow", "tableCell", "tableHeader":
		return projection.renderBlocks(node.Content, depth)
	case "columnBlock", "columns":
		projection.noteLoss(lossColumns)
		return projection.renderBlocks(node.Content, depth)
	case "column":
		return projection.renderBlocks(node.Content, depth)
	case "details":
		return projection.renderDetails(node, depth)
	case "detailsSummary":
		return projection.renderInline(node.Content, depth)
	case "detailsContent":
		return projection.renderBlocks(node.Content, depth)
	case "toggle":
		projection.noteLoss(lossPlainDetails)
		return projection.renderBlocks(node.Content, depth)
	default:
		projection.noteLoss(lossUnknownNode)
		if node.TextPresent {
			copy := *node
			copy.Type = "text"
			if err := projection.renderText(&copy); err != nil {
				return err
			}
		}
		if allInline(node.Content) {
			return projection.renderInline(node.Content, depth)
		}
		return projection.renderBlocks(node.Content, depth)
	}
}

func (projection *proseProjection) noteNodeShape(node *proseNode) {
	if node.Attrs.valid&attrTextAlign != 0 {
		switch node.Attrs.textAlign {
		case "left":
		case "center", "right":
			projection.noteLoss(lossTextAlignment)
		default:
			projection.noteLoss(lossInvalidAttribute)
		}
	}
	if node.Malformed || node.Type == "text" && !node.TextPresent {
		projection.noteLoss(lossMalformedContent)
	}
	if node.UnknownFields || node.Attrs.unknown || node.Attrs.identity {
		projection.noteLoss(lossUnknownAttribute)
	}
	if node.Attrs.invalid {
		projection.noteLoss(lossInvalidAttribute)
	}
}

func (projection *proseProjection) renderBlocks(children []proseNode, depth int) error {
	for index := range children {
		if index > 0 {
			if err := projection.writer.write("\n\n"); err != nil {
				return err
			}
		}
		if err := projection.render(&children[index], depth+1); err != nil {
			return err
		}
	}
	return nil
}

func (projection *proseProjection) renderInline(children []proseNode, depth int) error {
	for index := range children {
		if err := projection.render(&children[index], depth+1); err != nil {
			return err
		}
	}
	return nil
}

func (projection *proseProjection) renderList(node *proseNode, depth int, ordered, task bool) error {
	start := 1
	if ordered && node.Attrs.valid&attrStart != 0 {
		start = node.Attrs.start
	}
	if ordered && (start < 1 || start > 999_999_999-len(node.Content)) {
		start = 1
		projection.noteLoss(lossInvalidAttribute)
	}
	if node.Attrs.listStyle {
		projection.noteLoss("A custom ordered-list marker style was not preserved.")
	}

	for index := range node.Content {
		if index > 0 {
			if err := projection.writer.write("\n"); err != nil {
				return err
			}
		}
		marker := "- "
		if ordered {
			marker = strconv.Itoa(start+index) + ". "
		}
		if err := projection.writer.write(marker); err != nil {
			return err
		}
		projection.writer.push(linePrefix{content: strings.Repeat(" ", len(marker))})
		child := &node.Content[index]
		if task {
			checked := child.Attrs.valid&attrChecked != 0 && child.Attrs.checked
			box := "[ ] "
			if checked {
				box = "[x] "
			}
			if err := projection.writer.write(box); err != nil {
				projection.writer.pop()
				return err
			}
			if child.Type != "taskItem" {
				projection.noteLoss(lossMalformedContent)
			}
		} else if child.Type != "listItem" {
			projection.noteLoss(lossMalformedContent)
		}
		err := projection.renderListItem(child, depth+1)
		projection.writer.pop()
		if err != nil {
			return err
		}
	}
	return nil
}

func (projection *proseProjection) renderListItem(node *proseNode, depth int) error {
	projection.noteNodeShape(node)
	return projection.renderBlocks(node.Content, depth)
}

func (projection *proseProjection) renderCodeBlock(node *proseNode) error {
	raw, err := projection.directText(node)
	if err != nil {
		return err
	}
	if !projection.markdown {
		return projection.writer.write(raw)
	}
	language := node.Attrs.language
	if language != "" && !validCodeLanguage(language) {
		language = ""
		projection.noteLoss(lossCodeLanguage)
	}
	fence := strings.Repeat("`", max(3, longestRun(raw, '`')+1))
	if err := projection.writer.write(fence + language + "\n"); err != nil {
		return err
	}
	if err := projection.writer.write(raw); err != nil {
		return err
	}
	if raw != "" && !strings.HasSuffix(raw, "\n") {
		if err := projection.writer.write("\n"); err != nil {
			return err
		}
	}
	return projection.writer.write(fence)
}

func (projection *proseProjection) directText(node *proseNode) (string, error) {
	var result strings.Builder
	for index := range node.Content {
		child := &node.Content[index]
		if child.Type != "text" || !child.TextPresent {
			projection.noteLoss(lossMalformedContent)
			continue
		}
		value, changed := sanitizeTextDetailed(child.Text)
		if changed {
			projection.noteLoss(lossControlText)
		}
		if result.Len()+len(value) > projection.writer.maximum {
			return "", errors.New("prose code block exceeds the byte limit")
		}
		result.WriteString(value)
	}
	return result.String(), nil
}

func (projection *proseProjection) renderCallout(node *proseNode, depth int) error {
	tone := node.Attrs.tone
	if !oneOf(tone, "note", "tip", "warning", "danger") {
		if tone != "" {
			projection.noteLoss(lossInvalidAttribute)
		}
		tone = "note"
	}
	if !projection.markdown {
		if err := projection.writer.write("[" + strings.ToUpper(tone) + "]\n\n"); err != nil {
			return err
		}
		return projection.renderBlocks(node.Content, depth)
	}
	projection.writer.push(linePrefix{content: "> ", blank: ">"})
	err := projection.writer.write("[!" + tone + "]")
	if err == nil && len(node.Content) > 0 {
		err = projection.writer.write("\n\n")
	}
	if err == nil {
		err = projection.renderBlocks(node.Content, depth)
	}
	projection.writer.pop()
	return err
}

func (projection *proseProjection) renderImage(node *proseNode) error {
	alt, changed := sanitizeTextDetailed(node.Attrs.alt)
	if changed {
		projection.noteLoss(lossControlText)
	}
	alt = collapseLines(alt)
	if node.Attrs.dimensions {
		projection.noteLoss(lossImageDimensions)
	}
	if !projection.markdown {
		projection.noteLoss(lossPlainImage)
		description := alt
		if description == "" {
			description = "Image"
		}
		value := "[Image: " + description + "]"
		if safeImageSource(node.Attrs.source) {
			value += " (" + node.Attrs.source + ")"
		}
		return projection.writer.write(value)
	}
	if !safeImageSource(node.Attrs.source) {
		projection.noteLoss(lossImageDescription)
		description := alt
		if description == "" {
			description = "Image"
		}
		return projection.writer.write("[Image: " + escapeMarkdownLiteral(description, projection.writer.atLineStart) + "]")
	}
	value := "![" + escapeMarkdownLabel(alt) + "](" + markdownDestination(node.Attrs.source)
	if node.Attrs.title != "" {
		title, titleChanged := sanitizeTextDetailed(node.Attrs.title)
		if titleChanged {
			projection.noteLoss(lossControlText)
		}
		value += ` "` + escapeMarkdownTitle(collapseLines(title)) + `"`
	}
	value += ")"
	return projection.writer.write(value)
}

func (projection *proseProjection) renderReference(node *proseNode) error {
	label := node.Attrs.label
	if label == "" {
		label = node.Attrs.targetID
	}
	if label == "" {
		label = "reference"
	}
	label, changed := sanitizeTextDetailed(label)
	if changed {
		projection.noteLoss(lossControlText)
	}
	label = collapseLines(label)
	if !projection.markdown {
		projection.noteLoss(lossPlainReference)
		return projection.writer.write(label)
	}

	if node.Type == "itemReference" && safeLink(node.Attrs.href) {
		return projection.writer.write("[" + escapeMarkdownLabel(label) + "](" + markdownDestination(node.Attrs.href) + ")")
	}
	if !oneOf(node.Attrs.kind, "item", "principal") || !safeReferenceTarget(node.Attrs.targetID) {
		projection.noteLoss(lossUnsafeLink)
		return projection.writer.write(escapeMarkdownLiteral(label, projection.writer.atLineStart))
	}
	target := "nix://" + node.Attrs.kind + "/" + url.PathEscape(node.Attrs.targetID)
	return projection.writer.write("[" + escapeMarkdownLabel(label) + "](" + markdownDestination(target) + ")")
}

func (projection *proseProjection) renderTable(node *proseNode) error {
	projection.noteLoss(lossTable)
	rows := make([]*proseNode, 0, len(node.Content))
	for index := range node.Content {
		if node.Content[index].Type == "tableRow" {
			rows = append(rows, &node.Content[index])
		} else {
			projection.noteLoss(lossMalformedContent)
		}
	}
	if len(rows) == 0 {
		return nil
	}
	width := 0
	for _, row := range rows {
		if len(row.Content) > width {
			width = len(row.Content)
		}
	}
	if width == 0 {
		return nil
	}
	if err := projection.renderTableRow(rows[0], width); err != nil {
		return err
	}
	if err := projection.writer.write("\n"); err != nil {
		return err
	}
	if err := projection.renderTableSeparator(rows[0], width); err != nil {
		return err
	}
	for _, row := range rows[1:] {
		if err := projection.writer.write("\n"); err != nil {
			return err
		}
		if err := projection.renderTableRow(row, width); err != nil {
			return err
		}
	}
	return nil
}

func (projection *proseProjection) renderTableRow(row *proseNode, width int) error {
	if err := projection.writer.write("| "); err != nil {
		return err
	}
	for index := 0; index < width; index++ {
		if index > 0 {
			if err := projection.writer.write(" | "); err != nil {
				return err
			}
		}
		if index >= len(row.Content) {
			continue
		}
		cell := &row.Content[index]
		if cell.Type != "tableCell" && cell.Type != "tableHeader" {
			projection.noteLoss(lossMalformedContent)
		}
		value, err := projection.tableCellText(cell)
		if err != nil {
			return err
		}
		if err := projection.writer.write(escapeMarkdownTableCell(value)); err != nil {
			return err
		}
	}
	return projection.writer.write(" |")
}

func (projection *proseProjection) renderTableSeparator(header *proseNode, width int) error {
	if err := projection.writer.write("| "); err != nil {
		return err
	}
	for index := 0; index < width; index++ {
		if index > 0 {
			if err := projection.writer.write(" | "); err != nil {
				return err
			}
		}
		marker := "---"
		if index < len(header.Content) {
			switch header.Content[index].Attrs.align {
			case "left":
				marker = ":---"
			case "right":
				marker = "---:"
			case "center":
				marker = ":--:"
			}
		}
		if err := projection.writer.write(marker); err != nil {
			return err
		}
	}
	return projection.writer.write(" |")
}

func (projection *proseProjection) tableCellText(cell *proseNode) (string, error) {
	var output strings.Builder
	if err := projection.appendPlainText(&output, cell, 0); err != nil {
		return "", err
	}
	value := strings.TrimSpace(collapseLines(output.String()))
	projection.scratchUsed += len(value)
	if projection.scratchUsed > projection.writer.maximum {
		return "", errors.New("prose table scratch space exceeds the byte limit")
	}
	return value, nil
}

func (projection *proseProjection) appendPlainText(output *strings.Builder, node *proseNode, depth int) error {
	if depth > maximumProseDepth {
		return errors.New("prose document exceeds the nesting limit")
	}
	var value string
	switch node.Type {
	case "text":
		var changed bool
		value, changed = sanitizeTextDetailed(node.Text)
		if changed {
			projection.noteLoss(lossControlText)
		}
	case "reference", "itemReference":
		value = node.Attrs.label
		if value == "" {
			value = node.Attrs.targetID
		}
	case "image", "fileImage":
		value = node.Attrs.alt
	case "hardBreak":
		value = "\n"
	}
	var changed bool
	value, changed = sanitizeTextDetailed(value)
	if changed {
		projection.noteLoss(lossControlText)
	}
	if len(value) > projection.writer.maximum-output.Len() {
		return errors.New("prose table cell exceeds the byte limit")
	}
	output.WriteString(value)
	for index := range node.Content {
		if err := projection.appendPlainText(output, &node.Content[index], depth+1); err != nil {
			return err
		}
	}
	return nil
}

func (projection *proseProjection) renderDetails(node *proseNode, depth int) error {
	var summary *proseNode
	var content *proseNode
	var extras []proseNode
	for index := range node.Content {
		child := &node.Content[index]
		switch child.Type {
		case "detailsSummary":
			if summary == nil {
				summary = child
			} else {
				extras = append(extras, *child)
			}
		case "detailsContent":
			if content == nil {
				content = child
			} else {
				extras = append(extras, *child)
			}
		default:
			extras = append(extras, *child)
		}
	}
	if summary != nil {
		projection.noteNodeShape(summary)
	}
	if summary == nil || content == nil || len(extras) > 0 {
		projection.noteLoss(lossMalformedContent)
	}
	if !projection.markdown {
		projection.noteLoss(lossPlainDetails)
		if summary != nil {
			if err := projection.renderInline(summary.Content, depth+1); err != nil {
				return err
			}
		}
		if content != nil && len(content.Content) > 0 {
			if err := projection.writer.write("\n\n"); err != nil {
				return err
			}
			if err := projection.renderBlocks(content.Content, depth+1); err != nil {
				return err
			}
		}
		return projection.renderBlocks(extras, depth+1)
	}

	open := "<details>"
	if node.Attrs.valid&attrToggleLevel != 0 {
		if node.Attrs.toggleLevel >= 1 && node.Attrs.toggleLevel <= 3 {
			open = `<details data-toggle-level="` + strconv.Itoa(node.Attrs.toggleLevel) + `">`
		} else {
			projection.noteLoss(lossInvalidAttribute)
		}
	}
	if err := projection.writer.write(open + "\n<summary>"); err != nil {
		return err
	}
	if summary != nil {
		if err := projection.renderHTMLInline(summary.Content, depth+1); err != nil {
			return err
		}
	}
	if err := projection.writer.write("</summary>"); err != nil {
		return err
	}
	if content != nil && len(content.Content) > 0 {
		if err := projection.writer.write("\n\n"); err != nil {
			return err
		}
		if err := projection.renderBlocks(content.Content, depth+1); err != nil {
			return err
		}
	}
	if len(extras) > 0 {
		if err := projection.writer.write("\n\n"); err != nil {
			return err
		}
		if err := projection.renderBlocks(extras, depth+1); err != nil {
			return err
		}
	}
	return projection.writer.write("\n\n</details>")
}

func (projection *proseProjection) renderHTMLInline(children []proseNode, depth int) error {
	for index := range children {
		child := &children[index]
		projection.noteNodeShape(child)
		switch child.Type {
		case "text":
			if err := projection.renderHTMLText(child); err != nil {
				return err
			}
		case "hardBreak":
			if err := projection.writer.write("<br>"); err != nil {
				return err
			}
		case "reference", "itemReference":
			label := child.Attrs.label
			if label == "" {
				label = child.Attrs.targetID
			}
			if label == "" {
				label = "reference"
			}
			var changed bool
			label, changed = sanitizeTextDetailed(label)
			if changed {
				projection.noteLoss(lossControlText)
			}
			label = collapseLines(label)
			target := ""
			if oneOf(child.Attrs.kind, "item", "principal") && safeReferenceTarget(child.Attrs.targetID) {
				target = "nix://" + child.Attrs.kind + "/" + url.PathEscape(child.Attrs.targetID)
			} else if safeLink(child.Attrs.href) {
				target = child.Attrs.href
			}
			if target == "" {
				projection.noteLoss(lossUnsafeLink)
				if err := projection.writer.write(html.EscapeString(label)); err != nil {
					return err
				}
			} else if err := projection.writer.write(`<a href="` + html.EscapeString(target) + `">` + html.EscapeString(label) + "</a>"); err != nil {
				return err
			}
		default:
			projection.noteLoss(lossMalformedContent)
			if err := projection.renderHTMLInline(child.Content, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}

func (projection *proseProjection) renderHTMLText(node *proseNode) error {
	value, changed := sanitizeTextDetailed(node.Text)
	if changed {
		projection.noteLoss(lossControlText)
	}
	value = html.EscapeString(value)
	marks := projection.readMarks(node)
	if marks.code {
		value = "<code>" + value + "</code>"
	}
	if marks.strike {
		value = "<del>" + value + "</del>"
	}
	if marks.italic {
		value = "<em>" + value + "</em>"
	}
	if marks.bold {
		value = "<strong>" + value + "</strong>"
	}
	if marks.link != nil {
		if safeLink(marks.link.Attrs.href) {
			value = `<a href="` + html.EscapeString(marks.link.Attrs.href) + `">` + value + "</a>"
		} else {
			projection.noteLoss(lossUnsafeLink)
		}
	}
	return projection.writer.write(value)
}

type renderedMarks struct {
	bold   bool
	italic bool
	strike bool
	code   bool
	link   *proseMark
}

func (projection *proseProjection) readMarks(node *proseNode) renderedMarks {
	marks := renderedMarks{}
	for index := range node.Marks {
		mark := &node.Marks[index]
		if mark.Malformed {
			projection.noteLoss(lossMalformedContent)
		}
		if mark.UnknownFields || mark.Attrs.unknown || mark.Attrs.identity && !suggestionMarks[mark.Type] {
			projection.noteLoss(lossUnknownAttribute)
		}
		if mark.Attrs.invalid {
			projection.noteLoss(lossInvalidAttribute)
		}
		switch mark.Type {
		case "bold", "strong":
			marks.bold = true
		case "italic", "em":
			marks.italic = true
		case "strike":
			marks.strike = true
		case "code":
			marks.code = true
		case "link":
			if marks.link == nil {
				marks.link = mark
			} else {
				projection.noteLoss(lossMalformedContent)
			}
			if mark.Attrs.linkMeta {
				projection.noteLoss(lossLinkMetadata)
			}
		case "underline":
			projection.noteLoss(lossUnderline)
		case "highlight":
			projection.noteLoss(lossHighlight)
		case "textColor", "textStyle":
			projection.noteLoss(lossTextColor)
		case "comment":
			projection.noteLoss(lossComment)
		default:
			projection.noteLoss(lossUnknownMark)
		}
	}
	return marks
}

func (projection *proseProjection) renderText(node *proseNode) error {
	value, changed := sanitizeTextDetailed(node.Text)
	if changed {
		projection.noteLoss(lossControlText)
	}
	marks := projection.readMarks(node)
	if !projection.markdown {
		if len(node.Marks) > 0 {
			projection.noteLoss(lossPlainFormatting)
		}
		if marks.link != nil && safeLink(marks.link.Attrs.href) {
			value += " (" + marks.link.Attrs.href + ")"
		}
		return projection.writer.write(value)
	}

	if marks.code {
		if strings.ContainsAny(value, "\r\n") {
			value = strings.NewReplacer("\r\n", " ", "\r", " ", "\n", " ").Replace(value)
			projection.noteLoss(lossCodeSpanLine)
		}
		value = markdownCodeSpan(value)
	} else {
		value = escapeMarkdownLiteral(value, projection.writer.atLineStart)
	}
	if marks.strike {
		value = wrapMarkdown(value, "~~")
	}
	if marks.italic {
		value = wrapMarkdown(value, "*")
	}
	if marks.bold {
		value = wrapMarkdown(value, "**")
	}
	if marks.link != nil {
		href := marks.link.Attrs.href
		if safeLink(href) {
			value = "[" + value + "](" + markdownDestination(href)
			if marks.link.Attrs.title != "" {
				title, titleChanged := sanitizeTextDetailed(marks.link.Attrs.title)
				if titleChanged {
					projection.noteLoss(lossControlText)
				}
				value += ` "` + escapeMarkdownTitle(collapseLines(title)) + `"`
			}
			value += ")"
		} else {
			projection.noteLoss(lossUnsafeLink)
		}
	}
	return projection.writer.write(value)
}

func (projection *proseProjection) noteLoss(value string) {
	if _, exists := projection.losses[value]; exists {
		return
	}
	projection.losses[value] = struct{}{}
	projection.lossList = append(projection.lossList, value)
}

func allInline(nodes []proseNode) bool {
	for index := range nodes {
		switch nodes[index].Type {
		case "text", "hardBreak", "image", "fileImage", "reference", "itemReference":
		default:
			return false
		}
	}
	return true
}

func validCodeLanguage(value string) bool {
	if len(value) > maximumProseNameBytes {
		return false
	}
	for _, character := range value {
		if !(unicode.IsLetter(character) || unicode.IsDigit(character) || character == '-' || character == '_' || character == '+' || character == '.') {
			return false
		}
	}
	return true
}

func longestRun(value string, target byte) int {
	longest := 0
	current := 0
	for index := 0; index < len(value); index++ {
		if value[index] == target {
			current++
			longest = max(longest, current)
		} else {
			current = 0
		}
	}
	return longest
}

func markdownCodeSpan(value string) string {
	if value == "" {
		return ""
	}
	fence := strings.Repeat("`", longestRun(value, '`')+1)
	if fence == "" {
		fence = "`"
	}
	needsPadding := strings.HasPrefix(value, "`") || strings.HasSuffix(value, "`")
	if value != "" && strings.Trim(value, " ") != "" && (strings.HasPrefix(value, " ") || strings.HasSuffix(value, " ")) {
		needsPadding = true
	}
	if needsPadding {
		return fence + " " + value + " " + fence
	}
	return fence + value + fence
}

func wrapMarkdown(value, delimiter string) string {
	if value == "" {
		return value
	}
	leftTrimmed := strings.TrimLeftFunc(value, unicode.IsSpace)
	left := value[:len(value)-len(leftTrimmed)]
	core := leftTrimmed
	rightTrimmed := strings.TrimRightFunc(core, unicode.IsSpace)
	right := core[len(rightTrimmed):]
	if rightTrimmed == "" {
		return value
	}
	return left + delimiter + rightTrimmed + delimiter + right
}

func escapeMarkdownLiteral(value string, atLineStart bool) string {
	var output strings.Builder
	output.Grow(len(value))
	start := 0
	for start <= len(value) {
		end := strings.IndexByte(value[start:], '\n')
		hasNewline := end >= 0
		if !hasNewline {
			end = len(value)
		} else {
			end += start
		}
		line := value[start:end]
		escapeAt := -1
		if atLineStart {
			escapeAt = markdownBlockMarkerOffset(line)
		}
		for index := 0; index < len(line); {
			if index == escapeAt {
				output.WriteByte('\\')
			}
			character, size := utf8.DecodeRuneInString(line[index:])
			if strings.ContainsRune("\\`*_[]<|~", character) {
				output.WriteByte('\\')
			}
			output.WriteRune(character)
			index += size
		}
		if !hasNewline {
			break
		}
		output.WriteByte('\n')
		start = end + 1
		atLineStart = true
	}
	return output.String()
}

func markdownBlockMarkerOffset(value string) int {
	if value == "" {
		return -1
	}
	if (value[0] == '#' || value[0] == '>' || value[0] == '-' || value[0] == '+') && (len(value) == 1 || value[1] == ' ' || value[1] == '\t') {
		return 0
	}
	digits := 0
	for digits < len(value) && digits < 9 && value[digits] >= '0' && value[digits] <= '9' {
		digits++
	}
	if digits > 0 && digits+1 < len(value) && (value[digits] == '.' || value[digits] == ')') && (value[digits+1] == ' ' || value[digits+1] == '\t') {
		return digits
	}
	trimmed := strings.TrimSpace(value)
	if len(trimmed) >= 3 && strings.Trim(trimmed, "-") == "" {
		return strings.IndexByte(value, '-')
	}
	if len(trimmed) >= 1 && strings.Trim(trimmed, "=") == "" {
		return strings.IndexByte(value, '=')
	}
	return -1
}

func escapeMarkdownLabel(value string) string {
	var output strings.Builder
	output.Grow(len(value))
	for _, character := range value {
		if strings.ContainsRune("\\`*_[]<|~", character) {
			output.WriteByte('\\')
		}
		output.WriteRune(character)
	}
	return output.String()
}

func escapeMarkdownTableCell(value string) string {
	var output strings.Builder
	output.Grow(len(value))
	for _, character := range value {
		if strings.ContainsRune("\\|`*_[]<~", character) {
			output.WriteByte('\\')
		}
		output.WriteRune(character)
	}
	return output.String()
}

func escapeMarkdownTitle(value string) string {
	return strings.NewReplacer("\\", "\\\\", `"`, `\"`).Replace(value)
}

func markdownDestination(value string) string {
	if strings.ContainsAny(value, " \t") {
		return "<" + strings.NewReplacer("\\", "\\\\", "<", "%3C", ">", "%3E", `"`, "%22").Replace(value) + ">"
	}
	return strings.NewReplacer("\\", "\\\\", "(", "\\(", ")", "\\)", "<", "%3C", ">", "%3E", `"`, "%22").Replace(value)
}

func sanitizeText(value string) string {
	result, _ := sanitizeTextDetailed(value)
	return result
}

func sanitizeTextDetailed(value string) (string, bool) {
	var output strings.Builder
	output.Grow(len(value))
	changed := false
	for index := 0; index < len(value); {
		character, size := utf8.DecodeRuneInString(value[index:])
		index += size
		if character == '\r' {
			if index < len(value) && value[index] == '\n' {
				index++
			}
			output.WriteByte('\n')
			changed = true
			continue
		}
		if character == '\n' || character == '\t' {
			output.WriteRune(character)
			continue
		}
		if character >= 32 && validXMLTextRune(character) && !unicode.IsControl(character) {
			output.WriteRune(character)
			continue
		}
		changed = true
	}
	return output.String(), changed
}

func collapseLines(value string) string {
	var output strings.Builder
	output.Grow(len(value))
	lineSpace := false
	for _, character := range value {
		if character == '\n' || character == '\r' {
			lineSpace = output.Len() > 0
			continue
		}
		if lineSpace {
			if unicode.IsSpace(character) {
				continue
			}
			if output.Len() > 0 {
				output.WriteByte(' ')
			}
			lineSpace = false
		}
		output.WriteRune(character)
	}
	return strings.TrimSpace(output.String())
}

func validXMLTextRune(character rune) bool {
	return character == '\t' || character == '\n' || character == '\r' ||
		character >= 0x20 && character <= 0xd7ff ||
		character >= 0xe000 && character <= 0xfffd ||
		character >= 0x10000 && character <= 0x10ffff
}

func safeLink(value string) bool {
	if value == "" || len(value) > maximumProseAttributeBytes || strings.ContainsAny(value, "\r\n") || strings.ContainsRune(value, 0) {
		return false
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	if parsed.Scheme == "" {
		return parsed.Host == "" && !strings.HasPrefix(value, "//")
	}
	return oneOf(strings.ToLower(parsed.Scheme), "http", "https", "mailto", "nix")
}

func safeImageSource(value string) bool {
	if !safeLink(value) {
		return false
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	return parsed.Scheme == "" || oneOf(strings.ToLower(parsed.Scheme), "http", "https", "nix")
}

func safeReferenceTarget(value string) bool {
	if value == "" || len(value) > maximumProseAttributeBytes {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) || !validXMLTextRune(character) {
			return false
		}
	}
	return true
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}
