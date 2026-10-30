package exporter

import (
	"bytes"
	"context"
	"errors"
	"regexp"
	"sync"

	resvg "github.com/kanrichan/resvg-go"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/gobolditalic"
	"golang.org/x/image/font/gofont/goitalic"
	"golang.org/x/image/font/gofont/gomono"
	"golang.org/x/image/font/gofont/goregular"
)

// A diagram is the SVG the author's browser captured from a Mermaid code block (ADR-0063). PDF
// and DOCX take rasters only, so it is drawn here with resvg, running in the wazero runtime the
// workers already carry: no browser, no system fonts, nothing in the SVG runs.

// The worker has no system fonts, and resvg leaves text whose family it cannot find undrawn. Every
// family the diagram names is replaced by the Go fonts compiled into the PDF renderer.
var fontFamily = regexp.MustCompile(`font-family\s*[:=]\s*("[^"]*"|'[^']*'|[^;}"'>]*)`)

const diagramFamily = "Go"

var diagram struct {
	once sync.Once
	ctx  *resvg.Context
	err  error
}

// The capture stamps the root with its pixel size; a diagram without one is drawn at resvg's own.
var svgSize = regexp.MustCompile(`<svg[^>]*\swidth="(\d+)"[^>]*\sheight="(\d+)"`)

// rasterizeDiagram draws an SVG as a PNG at twice its pixel size, so it stays sharp on a printed
// page, and returns the size it was drawn for, zero when unknown.
func rasterizeDiagram(svg []byte) (png []byte, width int, err error) {
	diagram.once.Do(func() {
		diagram.ctx, diagram.err = resvg.NewContext(context.Background())
	})
	if diagram.err != nil {
		return nil, 0, diagram.err
	}
	renderer, err := diagram.ctx.NewRenderer()
	if err != nil {
		return nil, 0, err
	}
	defer renderer.Close()
	for _, font := range [][]byte{goregular.TTF, gobold.TTF, goitalic.TTF, gobolditalic.TTF, gomono.TTF} {
		if err := renderer.LoadFontData(font); err != nil {
			return nil, 0, err
		}
	}
	if err := renderer.SetFontFamily(diagramFamily); err != nil {
		return nil, 0, err
	}
	svg = fontFamily.ReplaceAllFunc(svg, func(match []byte) []byte {
		separator := bytes.IndexAny(match, ":=")
		quote := ""
		if rest := bytes.TrimSpace(match[separator+1:]); len(rest) > 0 && (rest[0] == '"' || rest[0] == '\'') {
			quote = string(rest[0])
		}
		return append(append(match[:separator+1:separator+1], quote...), diagramFamily+quote...)
	})
	if size := svgSize.FindSubmatch(svg); size != nil {
		w, h := atoi(size[1]), atoi(size[2])
		if w > 0 && h > 0 && w*h <= 10_000_000 {
			png, err = renderer.RenderWithSize(svg, uint32(w*2), uint32(h*2))
			width = w
		}
	}
	if png == nil && err == nil {
		png, err = renderer.Render(svg)
	}
	if err != nil {
		return nil, 0, err
	}
	if len(png) == 0 {
		return nil, 0, errors.New("empty diagram")
	}
	return png, width, nil
}

func atoi(digits []byte) int {
	value := 0
	for _, digit := range digits {
		if value > 1_000_000 {
			return 0
		}
		value = value*10 + int(digit-'0')
	}
	return value
}
