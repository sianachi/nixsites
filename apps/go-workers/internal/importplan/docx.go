package importplan

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path"
	"strconv"
	"strings"

	"github.com/sianachi/Nix/apps/go-workers/internal/render"
)

const docxMediaType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

const maxDOCXXMLTokens = 500_000

type relationship struct {
	ID         string `xml:"Id,attr"`
	Type       string `xml:"Type,attr"`
	Target     string `xml:"Target,attr"`
	TargetMode string `xml:"TargetMode,attr"`
}

type relationships struct {
	Values []relationship `xml:"Relationship"`
}

type numberingDocument struct {
	Abstract []abstractNumbering `xml:"abstractNum"`
	Numbers  []numberingInstance `xml:"num"`
}

type abstractNumbering struct {
	ID     string           `xml:"abstractNumId,attr"`
	Levels []numberingLevel `xml:"lvl"`
}

type numberingLevel struct {
	Level  int `xml:"ilvl,attr"`
	Format struct {
		Value string `xml:"val,attr"`
	} `xml:"numFmt"`
}

type numberingInstance struct {
	ID       string `xml:"numId,attr"`
	Abstract struct {
		Value string `xml:"val,attr"`
	} `xml:"abstractNumId"`
}

type docxAsset struct {
	SourceID string
	File     File
}

type docxParser struct {
	links       map[string]string
	assets      map[string]docxAsset
	numbering   map[string]string
	usedAssets  []docxAsset
	used        map[string]bool
	loss        []string
	omissions   []string
	blocks      []render.Block
	table       *docxTable
	tableDepth  int
	paragraph   *docxParagraph
	runMarks    map[string]bool
	hyperlink   string
	inRunProps  bool
	inParaProps bool
	inText      bool
}

type docxParagraph struct {
	style  string
	numID  string
	level  int
	runs   []render.Run
	images []string
}

type docxTable struct {
	rows        [][][]render.Block
	currentRow  [][]render.Block
	currentCell []render.Block
	inCell      bool
}

func parseDOCX(source Source, limits Limits) (Plan, error) {
	archive, err := openArchive(source, limits)
	if err != nil {
		return Plan{}, err
	}
	defer archive.Close()
	document, err := readEntry(archive, "word/document.xml", limits.MaxBodyBytes)
	if err != nil {
		return Plan{}, err
	}
	if err := validateXML(document, max(limits.MaxDepth, 32), maxDOCXXMLTokens); err != nil {
		return Plan{}, fmt.Errorf("DOCX document.xml: %w", err)
	}
	links, imageTargets, err := readRelationships(archive, limits)
	if err != nil {
		return Plan{}, err
	}
	numbering, err := readNumbering(archive, limits)
	if err != nil {
		return Plan{}, err
	}
	assets := make(map[string]docxAsset)
	assetOrder := make([]string, 0, len(imageTargets))
	for relationID, target := range imageTargets {
		entry := findEntry(archive, target)
		if entry == nil {
			continue
		}
		inspected, inspectErr := inspectAsset(entry, path.Base(target))
		if inspectErr != nil {
			continue
		}
		assetOrder = append(assetOrder, relationID)
		assets[relationID] = docxAsset{File: inspected.File}
	}
	// Relationship order in a map is not stable. Source identifiers come from sorted archive
	// paths instead, making a retry produce the same plan and checksum.
	sortStrings(assetOrder, func(left, right string) bool {
		leftPath, rightPath := *assets[left].File.AssetPath, *assets[right].File.AssetPath
		return leftPath < rightPath || leftPath == rightPath && left < right
	})
	for index, relationID := range assetOrder {
		asset := assets[relationID]
		asset.SourceID = fmt.Sprintf("asset-%04d", index+1)
		assets[relationID] = asset
	}

	parser := &docxParser{
		links: links, assets: assets, numbering: numbering, used: make(map[string]bool),
		runMarks: make(map[string]bool), loss: []string{}, omissions: []string{},
	}
	parser.loss, parser.omissions = docxArchiveReports(archive, parser.loss, parser.omissions)
	if err := parser.parse(document); err != nil {
		return Plan{}, err
	}
	if len(parser.blocks) == 0 {
		parser.blocks = append(parser.blocks, render.Block{Kind: "paragraph"})
	}
	tree, err := render.Document{Blocks: parser.blocks}.Encode()
	if err != nil {
		return Plan{}, err
	}
	items := []Item{
		noteItem("root", nil, 0, source.Title, &Body{Encoding: "nix-render", Render: tree}),
		originalItem(source, docxMediaType, 0),
	}
	parent := "root"
	for index, asset := range parser.usedAssets {
		file := asset.File
		items = append(items, Item{
			SourceID: asset.SourceID, ParentSourceID: &parent, Order: index + 1,
			Title: file.FileName, ItemType: "file", FinalLifecycleState: "active", File: &file,
		})
	}
	if len(parser.usedAssets) > 0 {
		parser.loss = appendUnique(parser.loss, "DOCX inline image anchoring is approximated as a document block while the original image bytes are retained as child files.")
	}
	return Plan{
		Version: Version, Format: "docx", Title: source.Title, SourceSHA256: source.SHA256,
		Items: items, Loss: parser.loss, Omissions: parser.omissions,
	}, nil
}

func readRelationships(archive *zip.ReadCloser, limits Limits) (map[string]string, map[string]string, error) {
	if findEntry(archive, "word/_rels/document.xml.rels") == nil {
		return map[string]string{}, map[string]string{}, nil
	}
	body, err := readEntry(archive, "word/_rels/document.xml.rels", min(limits.MaxEntryBytes, 2<<20))
	if err != nil {
		return nil, nil, err
	}
	if err := validateXML(body, max(limits.MaxDepth, 32), maxDOCXXMLTokens); err != nil {
		return nil, nil, fmt.Errorf("DOCX relationships: %w", err)
	}
	var parsed relationships
	if err := xml.Unmarshal(body, &parsed); err != nil {
		return nil, nil, fmt.Errorf("DOCX relationships: %w", err)
	}
	links := make(map[string]string)
	images := make(map[string]string)
	for _, relation := range parsed.Values {
		if strings.HasSuffix(relation.Type, "/hyperlink") && strings.EqualFold(relation.TargetMode, "External") {
			if target, err := url.Parse(relation.Target); err == nil && target.User == nil && target.Fragment == "" && (target.Scheme == "https" || target.Scheme == "http") {
				links[relation.ID] = target.String()
			}
			continue
		}
		if !strings.HasSuffix(relation.Type, "/image") || relation.TargetMode != "" {
			continue
		}
		targetURL, err := url.Parse(relation.Target)
		if err != nil || targetURL.IsAbs() || targetURL.Host != "" || targetURL.RawQuery != "" || targetURL.Fragment != "" || strings.Contains(relation.Target, "\\") {
			continue
		}
		decodedTarget, err := url.PathUnescape(targetURL.EscapedPath())
		if err != nil || strings.HasPrefix(decodedTarget, "/") || strings.HasPrefix(path.Clean(decodedTarget), "../") {
			continue
		}
		target := path.Clean(path.Join("word", decodedTarget))
		if strings.HasPrefix(target, "word/media/") && !strings.Contains(target, "\\") {
			images[relation.ID] = target
		}
	}
	return links, images, nil
}

func readNumbering(archive *zip.ReadCloser, limits Limits) (map[string]string, error) {
	if findEntry(archive, "word/numbering.xml") == nil {
		return map[string]string{}, nil
	}
	body, err := readEntry(archive, "word/numbering.xml", min(limits.MaxEntryBytes, 2<<20))
	if err != nil {
		return nil, err
	}
	if err := validateXML(body, max(limits.MaxDepth, 32), maxDOCXXMLTokens); err != nil {
		return nil, fmt.Errorf("DOCX numbering: %w", err)
	}
	var document numberingDocument
	if err := xml.Unmarshal(body, &document); err != nil {
		return nil, fmt.Errorf("DOCX numbering: %w", err)
	}
	abstract := make(map[string]string)
	for _, value := range document.Abstract {
		format := "bullet"
		for _, level := range value.Levels {
			if level.Level == 0 && level.Format.Value != "" {
				format = level.Format.Value
				break
			}
		}
		abstract[value.ID] = format
	}
	result := make(map[string]string)
	for _, value := range document.Numbers {
		result[value.ID] = abstract[value.Abstract.Value]
	}
	return result, nil
}

func (parser *docxParser) parse(document []byte) error {
	decoder := xml.NewDecoder(bytes.NewReader(document))
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("DOCX document.xml: %w", err)
		}
		switch value := token.(type) {
		case xml.StartElement:
			parser.start(value)
		case xml.EndElement:
			parser.end(value)
		case xml.CharData:
			if parser.inText && parser.paragraph != nil {
				parser.appendText(string(value))
			}
		}
	}
}

func (parser *docxParser) start(value xml.StartElement) {
	switch value.Name.Local {
	case "tbl":
		parser.tableDepth++
		if parser.tableDepth == 1 {
			parser.table = &docxTable{}
		} else {
			parser.loss = appendUnique(parser.loss, "Nested DOCX tables are flattened into their containing cell.")
		}
	case "tr":
		if parser.table != nil && parser.tableDepth == 1 {
			parser.table.currentRow = nil
		}
	case "tc":
		if parser.table != nil && parser.tableDepth == 1 {
			parser.table.currentCell = nil
			parser.table.inCell = true
		}
	case "p":
		parser.paragraph = &docxParagraph{}
	case "pPr":
		parser.inParaProps = true
	case "r":
		parser.runMarks = make(map[string]bool)
	case "rPr":
		parser.inRunProps = true
	case "b":
		if parser.inRunProps {
			parser.runMarks["bold"] = true
		}
	case "i":
		if parser.inRunProps {
			parser.runMarks["italic"] = true
		}
	case "u":
		if parser.inRunProps {
			parser.runMarks["underline"] = true
		}
	case "strike", "dstrike":
		if parser.inRunProps {
			parser.runMarks["strike"] = true
		}
	case "pStyle":
		if parser.inParaProps && parser.paragraph != nil {
			parser.paragraph.style = attribute(value, "val")
		}
	case "numId":
		if parser.inParaProps && parser.paragraph != nil {
			parser.paragraph.numID = attribute(value, "val")
		}
	case "ilvl":
		if parser.inParaProps && parser.paragraph != nil {
			parser.paragraph.level, _ = strconv.Atoi(attribute(value, "val"))
		}
	case "hyperlink":
		parser.hyperlink = parser.links[attribute(value, "id")]
	case "t":
		parser.inText = true
	case "tab":
		parser.appendText("\t")
	case "br":
		if parser.paragraph != nil {
			parser.paragraph.runs = append(parser.paragraph.runs, render.Run{Text: "\n"})
		}
	case "blip":
		if parser.paragraph != nil {
			parser.paragraph.images = append(parser.paragraph.images, attribute(value, "embed"))
		}
	case "gridSpan", "vMerge":
		parser.loss = appendUnique(parser.loss, "Merged DOCX table cells are flattened into ordinary cells.")
	case "sectPr":
		parser.loss = appendUnique(parser.loss, "DOCX page size, margins, columns, and section layout are not preserved in the editable note.")
	case "fldSimple", "instrText":
		parser.loss = appendUnique(parser.loss, "DOCX dynamic fields are imported as their visible text where available.")
	case "altChunk", "object", "oleObject":
		parser.omissions = appendUnique(parser.omissions, "Embedded DOCX objects and alternate content are retained only in the original file.")
	}
}

func (parser *docxParser) end(value xml.EndElement) {
	switch value.Name.Local {
	case "t":
		parser.inText = false
	case "rPr":
		parser.inRunProps = false
	case "pPr":
		parser.inParaProps = false
	case "hyperlink":
		parser.hyperlink = ""
	case "p":
		parser.finishParagraph()
	case "tc":
		if parser.table != nil && parser.tableDepth == 1 {
			if len(parser.table.currentCell) == 0 {
				parser.table.currentCell = append(parser.table.currentCell, render.Block{Kind: "paragraph"})
			}
			parser.table.currentRow = append(parser.table.currentRow, parser.table.currentCell)
			parser.table.currentCell = nil
			parser.table.inCell = false
		}
	case "tr":
		if parser.table != nil && parser.tableDepth == 1 && len(parser.table.currentRow) > 0 {
			parser.table.rows = append(parser.table.rows, parser.table.currentRow)
			parser.table.currentRow = nil
		}
	case "tbl":
		if parser.tableDepth == 1 {
			parser.finishTable()
		}
		if parser.tableDepth > 0 {
			parser.tableDepth--
		}
	}
}

func (parser *docxParser) appendText(text string) {
	if parser.paragraph == nil || text == "" {
		return
	}
	run := render.Run{Text: text, Href: parser.hyperlink}
	for _, mark := range []string{"bold", "italic", "underline", "strike"} {
		if parser.runMarks[mark] {
			run.Styles = append(run.Styles, mark)
		}
	}
	parser.paragraph.runs = append(parser.paragraph.runs, run)
}

func (parser *docxParser) finishParagraph() {
	if parser.paragraph == nil {
		return
	}
	paragraph := parser.paragraph
	parser.paragraph = nil
	node := render.Block{Kind: "paragraph", Runs: paragraph.runs}
	lowerStyle := strings.ToLower(paragraph.style)
	if strings.HasPrefix(lowerStyle, "heading") {
		if level, err := strconv.Atoi(strings.TrimPrefix(lowerStyle, "heading")); err == nil && level >= 1 && level <= 6 {
			node.Kind, node.Level = "heading", level
		}
	}
	if paragraph.numID != "" {
		format := parser.numbering[paragraph.numID]
		list := render.Block{Kind: "list", Ordered: format != "" && format != "bullet", Items: []render.ListItem{{Blocks: []render.Block{node}}}}
		if paragraph.level > 0 {
			parser.loss = appendUnique(parser.loss, "Nested DOCX list indentation is flattened while list semantics are retained.")
		}
		parser.appendBlock(list)
	} else {
		parser.appendBlock(node)
	}
	for _, relationID := range paragraph.images {
		asset, ok := parser.assets[relationID]
		if !ok {
			parser.loss = appendUnique(parser.loss, "An embedded DOCX image was unsupported or malformed and remains only in the retained original file.")
			continue
		}
		if !parser.used[relationID] {
			parser.used[relationID] = true
			parser.usedAssets = append(parser.usedAssets, asset)
		}
		image := render.Block{Kind: "image", Src: "nix-file:" + asset.SourceID, Alt: asset.File.FileName}
		if asset.File.PixelWidth != nil {
			image.Width = *asset.File.PixelWidth
		}
		parser.appendBlock(image)
	}
}

func (parser *docxParser) appendBlock(node render.Block) {
	if parser.table != nil && parser.table.inCell {
		parser.table.currentCell = append(parser.table.currentCell, node)
		return
	}
	parser.blocks = append(parser.blocks, node)
}

func (parser *docxParser) finishTable() {
	if parser.table == nil {
		return
	}
	table := parser.table
	parser.table = nil
	if len(table.rows) == 0 {
		return
	}
	rows := make([]render.Row, 0, len(table.rows))
	for _, row := range table.rows {
		cells := make([][]render.Run, 0, len(row))
		for _, content := range row {
			// A cell holds runs only; its paragraphs are joined by line breaks.
			var runs []render.Run
			for index, block := range content {
				if index > 0 {
					runs = append(runs, render.Run{Text: "\n"})
				}
				runs = append(runs, block.Runs...)
			}
			cells = append(cells, runs)
		}
		rows = append(rows, render.Row{Cells: cells})
	}
	parser.blocks = append(parser.blocks, render.Block{Kind: "table", Rows: rows})
}

func attribute(element xml.StartElement, local string) string {
	for _, attribute := range element.Attr {
		if attribute.Name.Local == local {
			return attribute.Value
		}
	}
	return ""
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func sortStrings(values []string, less func(left, right string) bool) {
	for index := 1; index < len(values); index++ {
		for current := index; current > 0 && less(values[current], values[current-1]); current-- {
			values[current], values[current-1] = values[current-1], values[current]
		}
	}
}

func docxArchiveReports(archive *zip.ReadCloser, loss, omissions []string) ([]string, []string) {
	for _, entry := range archive.File {
		switch {
		case strings.HasPrefix(entry.Name, "word/header") && strings.HasSuffix(entry.Name, ".xml"):
			omissions = appendUnique(omissions, "DOCX headers are retained only in the original file.")
		case strings.HasPrefix(entry.Name, "word/footer") && strings.HasSuffix(entry.Name, ".xml"):
			omissions = appendUnique(omissions, "DOCX footers are retained only in the original file.")
		case entry.Name == "word/footnotes.xml" || entry.Name == "word/endnotes.xml":
			omissions = appendUnique(omissions, "DOCX footnotes and endnotes are retained only in the original file.")
		case entry.Name == "word/comments.xml":
			omissions = appendUnique(omissions, "DOCX comments are retained only in the original file.")
		case entry.Name == "word/styles.xml":
			loss = appendUnique(loss, "DOCX named styles beyond supported headings are approximated using editable note formatting.")
		}
	}
	return loss, omissions
}
