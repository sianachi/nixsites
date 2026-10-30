package exporter

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"codeberg.org/go-pdf/fpdf"
	"github.com/sianachi/Nix/apps/go-workers/internal/render"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/gobolditalic"
	"golang.org/x/image/font/gofont/goitalic"
	"golang.org/x/image/font/gofont/gomono"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/sfnt"
)

const pdfMargin = 50.0
const pdfBottom = 792.0
const pdfWidth = 495.28
const maximumPDFPages = 1000

var pdfFont, _ = sfnt.Parse(goregular.TTF)

func pdfText(value string) string {
	var buffer sfnt.Buffer
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		glyph, err := pdfFont.GlyphIndex(&buffer, r)
		if err != nil || glyph == 0 {
			return '?'
		}
		return r
	}, sanitizeText(value))
}

func PDFTextRequiresSubstitution(value string) bool { return pdfText(value) != sanitizeText(value) }

func writePDF(output io.Writer, next RecordSource, limits stream.Limits, report ReportSource) error {
	pdf := fpdf.New("P", "pt", "A4", "")
	pdf.SetCreationDate(time.Unix(0, 0).UTC())
	pdf.SetModificationDate(time.Unix(0, 0).UTC())
	pdf.SetCatalogSort(true)
	pdf.SetMargins(pdfMargin, pdfMargin, pdfMargin)
	pdf.SetAutoPageBreak(true, pdfMargin)
	pdf.SetAcceptPageBreakFunc(func() bool {
		if pdf.PageNo() >= maximumPDFPages {
			pdf.SetError(stream.ErrLimitExceeded)
			return false
		}
		return true
	})
	pdf.AddUTF8FontFromBytes("Nix", "", goregular.TTF)
	pdf.AddUTF8FontFromBytes("Nix", "B", gobold.TTF)
	pdf.AddUTF8FontFromBytes("Nix", "I", goitalic.TTF)
	pdf.AddUTF8FontFromBytes("Nix", "BI", gobolditalic.TTF)
	pdf.AddUTF8FontFromBytes("NixMono", "", gomono.TTF)
	pdf.SetFooterFunc(func() {
		pdf.SetY(-32)
		pdf.SetFont("Nix", "", 9)
		pdf.SetTextColor(100, 100, 100)
		pdf.CellFormat(pdfWidth, 12, fmt.Sprint(pdf.PageNo()), "", 0, "C", false, 0, "")
	})
	// The PDF library retains pages and raster resources until Output. Bound cumulative input
	// in addition to the output writer limit, rather than implying a streaming memory budget.
	records, remaining := 0, min(limits.MaxBytes, int64(32<<20))
	for {
		record, ok, err := next()
		if err != nil {
			return err
		}
		if !ok {
			break
		}
		records++
		if records > limits.MaxRecords {
			return stream.ErrLimitExceeded
		}
		if record.Title == "" {
			return errors.New("export record title is required")
		}
		remaining -= int64(len(record.Title))
		render.Walk(record.Blocks, func(block *render.Block) {
			remaining -= int64(len(render.Plain(block.Runs)) + len(block.Text))
		})
		for _, raster := range record.Images {
			remaining -= int64(len(raster.Data))
		}
		if remaining < 0 {
			return stream.ErrLimitExceeded
		}
		addPDFPage(pdf)
		title, _ := ProjectTitle(record.Title)
		pdf.SetFont("Nix", "B", 24)
		pdf.SetTextColor(25, 25, 25)
		pdf.MultiCell(pdfWidth, 30, pdfText(title), "", "L", false)
		pdf.Ln(12)
		renderPDFBlocks(pdf, record, blocksOf(record), 0, records)
		if pdf.Error() != nil {
			return pdf.Error()
		}
	}
	if records == 0 {
		return errors.New("cannot export an empty PDF")
	}
	return pdf.Output(&limitedWriter{writer: output, remaining: limits.MaxBytes})
}

func addPDFPage(pdf *fpdf.Fpdf) {
	if pdf.PageNo() >= maximumPDFPages {
		pdf.SetError(stream.ErrLimitExceeded)
		return
	}
	pdf.AddPage()
}

func pdfSpace(pdf *fpdf.Fpdf, height float64) {
	if pdf.GetY()+height > pdfBottom {
		addPDFPage(pdf)
	}
}

// renderPDFBlocks draws a render tree. `indent` is the left inset inherited from quotes and lists.
func renderPDFBlocks(pdf *fpdf.Fpdf, record stream.Record, blocks []render.Block, indent float64, recordIndex int) {
	for index, block := range blocks {
		if pdf.Error() != nil {
			return
		}
		pdf.SetFont("Nix", "", 11)
		pdf.SetTextColor(35, 35, 35)
		switch block.Kind {
		case "heading":
			size := []float64{20, 17, 14, 13, 12, 11}[min(max(block.Level, 1)-1, 5)]
			pdfSpace(pdf, size*2+22)
			pdfParagraph(pdf, block.Runs, indent, "B", size)
		case "quote", "callout":
			if block.Kind == "callout" && block.Tone != "" {
				pdfParagraph(pdf, []render.Run{{Text: block.Tone, Styles: []string{"bold"}}}, indent+16, "I", 11)
			}
			renderPDFBlocks(pdf, record, block.Blocks, indent+16, recordIndex)
		case "code":
			pdf.Ln(6)
			pdf.SetFont("NixMono", "", 10)
			pdf.SetFillColor(243, 244, 246)
			pdf.SetLeftMargin(pdfMargin + indent)
			pdf.SetX(pdfMargin + indent)
			for _, line := range strings.Split(block.Text, "\n") {
				pdf.MultiCell(pdfWidth-indent, 15, pdfText(line), "", "L", true)
			}
			pdf.SetLeftMargin(pdfMargin)
			pdf.Ln(6)
		case "rule":
			pdfSpace(pdf, 12)
			pdf.SetDrawColor(190, 190, 190)
			pdf.Line(pdfMargin, pdf.GetY(), pdfMargin+pdfWidth, pdf.GetY())
			pdf.Ln(8)
		case "pageBreak":
			addPDFPage(pdf)
		case "image":
			if raster := recordImage(record, block.Src); raster != nil {
				width, height := imageSize(*raster, pdfWidth-indent, pdfBottom-pdfMargin)
				pdfSpace(pdf, height+8)
				name := fmt.Sprintf("image-%d-%d-%d", recordIndex, int(indent), index)
				options := fpdf.ImageOptions{ImageType: raster.Format, ReadDpi: false}
				pdf.RegisterImageOptionsReader(name, options, bytes.NewReader(raster.Data))
				y := pdf.GetY()
				pdf.ImageOptions(name, pdfMargin+indent, y, width, height, false, options, 0, "")
				pdf.SetY(y + height + 8)
				continue
			}
			pdfParagraph(pdf, []render.Run{{Text: "Image: " + block.Alt, Href: block.Src}}, indent, "", 11)
		case "list":
			for item, entry := range block.Items {
				marker := "• "
				if block.Ordered {
					start := block.Start
					if start < 1 {
						start = 1
					}
					marker = strconv.Itoa(start+item) + ". "
				}
				if entry.Checked != nil {
					marker = "☐ "
					if *entry.Checked {
						marker = "☑ "
					}
				}
				itemBlocks := entry.Blocks
				if len(itemBlocks) > 0 && itemBlocks[0].Kind == "paragraph" {
					first := itemBlocks[0]
					first.Runs = append([]render.Run{{Text: marker}}, first.Runs...)
					itemBlocks = append([]render.Block{first}, itemBlocks[1:]...)
				} else {
					itemBlocks = append([]render.Block{render.Paragraph(marker)}, itemBlocks...)
				}
				renderPDFBlocks(pdf, record, itemBlocks, indent+14, recordIndex)
			}
		case "table":
			renderPDFTable(pdf, block.Rows)
		case "details":
			pdfParagraph(pdf, block.Summary, indent, "B", 11)
			renderPDFBlocks(pdf, record, block.Blocks, indent, recordIndex)
		default: // paragraph, and any kind this build does not know but whose runs it can keep.
			pdfParagraph(pdf, block.Runs, indent, "", 11)
		}
	}
}

func pdfParagraph(pdf *fpdf.Fpdf, runs []render.Run, indent float64, style string, size float64) {
	pdf.SetLeftMargin(pdfMargin + indent)
	pdf.SetX(pdfMargin + indent)
	pdf.SetFont("Nix", style, size)
	pdfRuns(pdf, runs, style, size)
	pdf.Ln(size * 1.45)
	pdf.SetLeftMargin(pdfMargin)
}

func pdfRuns(pdf *fpdf.Fpdf, runs []render.Run, base string, size float64) {
	for _, run := range runs {
		if run.Text == "\n" {
			pdf.Ln(size * 1.45)
			continue
		}
		style := base
		for _, mark := range []struct{ name, style string }{{"bold", "B"}, {"italic", "I"}, {"strike", "S"}, {"underline", "U"}} {
			if run.Has(mark.name) && !strings.Contains(style, mark.style) {
				style += mark.style
			}
		}
		if run.Has("code") {
			pdf.SetFont("NixMono", "", size)
		} else {
			pdf.SetFont("Nix", style, size)
		}
		if run.Href != "" && safeDocumentLink(run.Href) {
			pdf.WriteLinkString(size*1.45, pdfText(run.Text), run.Href)
			continue
		}
		pdf.Write(size*1.45, pdfText(run.Text))
	}
}

func renderPDFTable(pdf *fpdf.Fpdf, rows []render.Row) {
	columns := 0
	for _, row := range rows {
		columns = max(columns, len(row.Cells))
	}
	if columns == 0 {
		return
	}
	width := pdfWidth / float64(columns)
	for rowIndex, row := range rows {
		style := ""
		if row.Header {
			style = "B"
		}
		pdf.SetFont("Nix", style, 10)
		cells := make([][]string, columns)
		count := 1
		for i := 0; i < columns; i++ {
			if i < len(row.Cells) {
				cells[i] = pdf.SplitText(pdfText(strings.ReplaceAll(render.Plain(row.Cells[i]), "\n", " ")), max(width-12, 1))
				count = max(count, len(cells[i]))
			}
		}
		// Split tall rows across pages at line boundaries so no cell can run below the footer.
		for start := 0; start < count; {
			if pdf.Error() != nil {
				return
			}
			pdfSpace(pdf, 22)
			take := min(count-start, max(1, int((pdfBottom-pdf.GetY()-8)/14)))
			height := float64(take)*14 + 8
			y := pdf.GetY()
			for i := 0; i < columns; i++ {
				x := pdfMargin + float64(i)*width
				pdf.SetDrawColor(205, 210, 215)
				pdf.SetFillColor(244, 246, 248)
				mode := "D"
				if row.Header || rowIndex == 0 && style == "B" {
					mode = "FD"
				}
				pdf.Rect(x, y, width, height, mode)
				for n := 0; n < take && start+n < len(cells[i]); n++ {
					pdf.SetXY(x+6, y+4+float64(n)*14)
					pdf.CellFormat(width-12, 14, cells[i][start+n], "", 0, "L", false, 0, "")
				}
			}
			pdf.SetXY(pdfMargin, y+height)
			start += take
		}
	}
	pdf.Ln(8)
}
