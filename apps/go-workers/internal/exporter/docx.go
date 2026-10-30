package exporter

import (
	"archive/zip"
	"errors"
	"fmt"
	"html"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/sianachi/Nix/apps/go-workers/internal/render"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	"github.com/sianachi/Nix/apps/go-workers/internal/worktemp"
)

const docxContentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`
const docxRootRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
const docxDocumentRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`
const docxStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="44"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr></w:style></w:styles>`

func writeDOCX(output io.Writer, next RecordSource, limits stream.Limits, report ReportSource) error {
	limited := &limitedWriter{writer: output, remaining: limits.MaxBytes}
	archive := zip.NewWriter(limited)
	entries := []struct{ name, body string }{
		{"[Content_Types].xml", docxContentTypes},
		{"_rels/.rels", docxRootRelationships},

		{"word/styles.xml", docxStyles},
		{"word/numbering.xml", docxNumberingXML()},
	}
	for _, entry := range entries {
		if err := writeZipEntry(archive, entry.name, []byte(entry.body), limits); err != nil {
			return err
		}
	}
	document, err := worktemp.Create("nix-export-docx-*")
	if err != nil {
		return err
	}
	defer func() { document.Close(); os.Remove(document.Name()) }()
	var media []struct {
		name string
		data []byte
	}
	imageID := 0
	relationships := strings.TrimSuffix(docxDocumentRelationships, "</Relationships>")
	if _, err := io.WriteString(document, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>`); err != nil {
		return err
	}
	records := 0
	err = eachRecord(next, limits.MaxRecords, func(record stream.Record) error {
		if record.Title == "" {
			return errors.New("export record title is required")
		}
		records++
		title, _ := ProjectTitle(record.Title)
		if err := writeDOCXParagraph(document, []render.Run{{Text: title}}, docxParagraph{style: "Title", pageBreakBefore: records > 1}); err != nil {
			return err
		}
		// Flush each note's blocks and images without retaining image bytes across records.
		if err := writeDOCXBlocks(document, record, blocksOf(record), docxParagraph{}, func(raster stream.Image, alt string) error {
			imageID++
			name := fmt.Sprintf("media/image%d.%s", imageID, raster.Format)
			rel := fmt.Sprintf("rImage%d", imageID)
			relationships += `<Relationship Id="` + rel + `" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="` + name + `"/>`
			media = append(media, struct {
				name string
				data []byte
			}{name, raster.Data})
			return writeDOCXImage(document, raster, alt, rel, imageID)
		}); err != nil {
			return err
		}
		for _, image := range media {
			entry, err := createZipEntry(archive, "word/"+image.name)
			if err != nil {
				return err
			}
			if _, err := entry.Write(image.data); err != nil {
				return err
			}
		}
		media = nil
		if stat, err := document.Stat(); err != nil {
			return err
		} else if stat.Size() > limits.MaxBytes {
			return stream.ErrLimitExceeded
		}
		return nil
	}, limited)
	if err != nil {
		return err
	}
	if records == 0 {
		return errors.New("cannot export an empty DOCX")
	}
	if _, err := io.WriteString(document, `<w:sectPr/></w:body></w:document>`); err != nil {
		return err
	}
	if _, err := document.Seek(0, io.SeekStart); err != nil {
		return err
	}
	entry, err := createZipEntry(archive, "word/document.xml")
	if err != nil {
		return err
	}
	if _, err := io.Copy(entry, document); err != nil {
		return err
	}
	if err := writeZipEntry(archive, "word/_rels/document.xml.rels", []byte(relationships+"</Relationships>"), limits); err != nil {
		return err
	}
	if err := archive.Close(); err != nil {
		return err
	}
	return limited.err
}

func docxNumberingXML() string {
	var output strings.Builder
	output.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`)
	for abstractID := 1; abstractID <= 2; abstractID++ {
		output.WriteString(`<w:abstractNum w:abstractNumId="` + strconv.Itoa(abstractID) + `"><w:multiLevelType w:val="multilevel"/>`)
		for level := 0; level <= 8; level++ {
			format, marker := "bullet", "-"
			if abstractID == 2 {
				format = "decimal"
				marker = "%" + strconv.Itoa(level+1) + "."
			}
			output.WriteString(`<w:lvl w:ilvl="` + strconv.Itoa(level) + `"><w:start w:val="1"/><w:numFmt w:val="` + format + `"/><w:lvlText w:val="` + marker + `"/><w:pPr><w:ind w:left="` + strconv.Itoa((level+1)*360) + `" w:hanging="260"/></w:pPr></w:lvl>`)
		}
		output.WriteString(`</w:abstractNum>`)
	}
	output.WriteString(`<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num></w:numbering>`)
	return output.String()
}

type docxParagraph struct {
	style           string
	numbering       int
	level           int
	pageBreakBefore bool
}

func writeDOCXParagraph(output io.Writer, runs []render.Run, options docxParagraph) error {
	if _, err := io.WriteString(output, `<w:p>`); err != nil {
		return err
	}
	if options.style != "" || options.numbering != 0 || options.pageBreakBefore {
		if _, err := io.WriteString(output, `<w:pPr>`); err != nil {
			return err
		}
		if options.style != "" {
			if _, err := io.WriteString(output, `<w:pStyle w:val="`+html.EscapeString(options.style)+`"/>`); err != nil {
				return err
			}
		}
		if options.numbering != 0 {
			level := min(max(options.level, 0), 8)
			if _, err := io.WriteString(output, `<w:numPr><w:ilvl w:val="`+strconv.Itoa(level)+`"/><w:numId w:val="`+strconv.Itoa(options.numbering)+`"/></w:numPr>`); err != nil {
				return err
			}
		}
		if options.pageBreakBefore {
			if _, err := io.WriteString(output, `<w:pageBreakBefore/>`); err != nil {
				return err
			}
		}
		if _, err := io.WriteString(output, `</w:pPr>`); err != nil {
			return err
		}
	}
	if err := writeDOCXRuns(output, runs); err != nil {
		return err
	}
	_, err := io.WriteString(output, `</w:p>`)
	return err
}

func writeDOCXRun(output io.Writer, value string, style inlineStyle) error {
	value = sanitizeText(value)
	if value == "" {
		return nil
	}
	if _, err := io.WriteString(output, `<w:r>`); err != nil {
		return err
	}
	if style.bold || style.italic || style.strike || style.code || style.underline || style.highlight {
		if _, err := io.WriteString(output, `<w:rPr>`); err != nil {
			return err
		}
		if style.bold {
			if _, err := io.WriteString(output, `<w:b/>`); err != nil {
				return err
			}
		}
		if style.italic {
			if _, err := io.WriteString(output, `<w:i/>`); err != nil {
				return err
			}
		}
		if style.strike {
			if _, err := io.WriteString(output, `<w:strike/>`); err != nil {
				return err
			}
		}
		if style.underline {
			if _, err := io.WriteString(output, `<w:u w:val="single"/>`); err != nil {
				return err
			}
		}
		if style.highlight {
			if _, err := io.WriteString(output, `<w:highlight w:val="yellow"/>`); err != nil {
				return err
			}
		}
		if style.code {
			if _, err := io.WriteString(output, `<w:shd w:val="clear" w:fill="EDEDED"/>`); err != nil {
				return err
			}
		}
		if _, err := io.WriteString(output, `</w:rPr>`); err != nil {
			return err
		}
	}
	_, err := io.WriteString(output, `<w:t xml:space="preserve">`+html.EscapeString(value)+`</w:t></w:r>`)
	return err
}

func writeDOCXLink(output io.Writer, label, target string, style inlineStyle) error {
	if !safeDocumentLink(target) {
		return writeDOCXRun(output, label, style)
	}
	instruction := html.EscapeString(` HYPERLINK "` + target + `" `)
	if _, err := io.WriteString(output, `<w:fldSimple w:instr="`+instruction+`">`); err != nil {
		return err
	}
	if err := writeDOCXRun(output, label, style); err != nil {
		return err
	}
	_, err := io.WriteString(output, `</w:fldSimple>`)
	return err
}

func safeDocumentLink(raw string) bool {
	if len(raw) == 0 || len(raw) > 2048 || strings.ContainsAny(raw, "\r\n\x00\"\\") {
		return false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.User != nil {
		return false
	}
	return oneOf(strings.ToLower(parsed.Scheme), "http", "https", "mailto", "nix")
}

func writeDOCXImage(output io.Writer, raster stream.Image, alt, rel string, id int) error {
	width, height := imageSize(raster, 468, 648)
	cx, cy := int64(width*12700), int64(height*12700)
	_, err := fmt.Fprintf(output, `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="%d" cy="%d"/><wp:docPr id="%d" name="Image %d" descr="%s"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="%d" name="Image %d"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="%s"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="%d" cy="%d"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`, cx, cy, id, id, html.EscapeString(alt), id, id, rel, cx, cy)
	return err
}

type inlineStyle struct {
	bold, italic, strike, code, underline, highlight bool
}

func styleOf(run render.Run) inlineStyle {
	return inlineStyle{
		bold: run.Has("bold"), italic: run.Has("italic"), strike: run.Has("strike"),
		code: run.Has("code"), underline: run.Has("underline"), highlight: run.Has("highlight"),
	}
}

func writeDOCXRuns(output io.Writer, runs []render.Run) error {
	for _, run := range runs {
		if run.Text == "\n" {
			if _, err := io.WriteString(output, `<w:r><w:br/></w:r>`); err != nil {
				return err
			}
			continue
		}
		if run.Href != "" {
			if err := writeDOCXLink(output, run.Text, run.Href, styleOf(run)); err != nil {
				return err
			}
			continue
		}
		if err := writeDOCXRun(output, run.Text, styleOf(run)); err != nil {
			return err
		}
	}
	return nil
}

// writeDOCXBlocks walks a render tree. `inherited` carries list numbering and depth into nested
// blocks: OOXML lists are flat paragraphs with a level, so the nesting is a number here rather than
// a structure.
func writeDOCXBlocks(output io.Writer, record stream.Record, blocks []render.Block, inherited docxParagraph, embed func(stream.Image, string) error) error {
	for _, block := range blocks {
		paragraph := inherited
		switch block.Kind {
		case "heading":
			paragraph.style = "Heading" + strconv.Itoa(min(max(block.Level, 1), 3))
			if err := writeDOCXParagraph(output, block.Runs, paragraph); err != nil {
				return err
			}
		case "quote", "callout":
			paragraph.style = "Quote"
			if block.Kind == "callout" && block.Tone != "" {
				if err := writeDOCXParagraph(output, []render.Run{{Text: block.Tone, Styles: []string{"bold"}}}, paragraph); err != nil {
					return err
				}
			}
			if err := writeDOCXBlocks(output, record, block.Blocks, paragraph, embed); err != nil {
				return err
			}
		case "code":
			paragraph.style = "Code"
			for _, line := range strings.Split(block.Text, "\n") {
				if err := writeDOCXParagraph(output, []render.Run{{Text: line}}, paragraph); err != nil {
					return err
				}
			}
		case "rule":
			if err := writeDOCXParagraph(output, nil, docxParagraph{}); err != nil {
				return err
			}
		case "pageBreak":
			if _, err := io.WriteString(output, `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`); err != nil {
				return err
			}
		case "image":
			if raster := recordImage(record, block.Src); raster != nil {
				if err := embed(*raster, block.Alt); err != nil {
					return err
				}
				continue
			}
			label := "Image: " + block.Alt
			if err := writeDOCXParagraph(output, []render.Run{{Text: label, Href: block.Src}}, paragraph); err != nil {
				return err
			}
		case "list":
			numbering, level := 1, 0
			if block.Ordered {
				numbering = 2
			}
			if inherited.numbering != 0 {
				level = inherited.level + 1
			}
			for _, item := range block.Items {
				itemParagraph := docxParagraph{numbering: numbering, level: level}
				itemBlocks := item.Blocks
				if item.Checked != nil && len(itemBlocks) > 0 && itemBlocks[0].Kind == "paragraph" {
					box := "☐ "
					if *item.Checked {
						box = "☑ "
					}
					first := itemBlocks[0]
					first.Runs = append([]render.Run{{Text: box}}, first.Runs...)
					itemBlocks = append([]render.Block{first}, itemBlocks[1:]...)
				}
				if err := writeDOCXBlocks(output, record, itemBlocks, itemParagraph, embed); err != nil {
					return err
				}
			}
		case "table":
			if err := writeDOCXTable(output, block.Rows); err != nil {
				return err
			}
		case "details":
			if err := writeDOCXParagraph(output, block.Summary, docxParagraph{style: "Heading3"}); err != nil {
				return err
			}
			if err := writeDOCXBlocks(output, record, block.Blocks, inherited, embed); err != nil {
				return err
			}
		default: // paragraph, and any kind this build does not know but whose runs it can keep.
			if err := writeDOCXParagraph(output, block.Runs, paragraph); err != nil {
				return err
			}
		}
	}
	return nil
}

func writeDOCXTable(output io.Writer, rows []render.Row) error {
	if _, err := io.WriteString(output, `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>`); err != nil {
		return err
	}
	for _, row := range rows {
		if _, err := io.WriteString(output, `<w:tr>`); err != nil {
			return err
		}
		for _, cell := range row.Cells {
			if _, err := io.WriteString(output, `<w:tc>`); err != nil {
				return err
			}
			runs := cell
			if row.Header {
				runs = make([]render.Run, 0, len(cell))
				for _, run := range cell {
					run.Styles = append(append([]string(nil), run.Styles...), "bold")
					runs = append(runs, run)
				}
			}
			if err := writeDOCXParagraph(output, runs, docxParagraph{}); err != nil {
				return err
			}
			if _, err := io.WriteString(output, `</w:tc>`); err != nil {
				return err
			}
		}
		if _, err := io.WriteString(output, `</w:tr>`); err != nil {
			return err
		}
	}
	_, err := io.WriteString(output, `</w:tbl>`)
	return err
}
