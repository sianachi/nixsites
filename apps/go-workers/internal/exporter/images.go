package exporter

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	"image/png"

	"github.com/sianachi/Nix/apps/go-workers/internal/render"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	_ "golang.org/x/image/webp"
)

// ImageLoader is supplied by the job host; projection itself has no network authority.
type ImageLoader func(fileID string) ([]byte, error)

// loadImages fetches the raster for every image block that names a file item, within a bounded
// per-record resource set, and points the block's source at the raster it got. A block whose
// raster is unavailable keeps its description and records a loss.
func loadImages(blocks []render.Block, load ImageLoader, losses *[]string) ([]stream.Image, error) {
	if load == nil {
		load = func(string) ([]byte, error) { return nil, errors.New("image loader unavailable") }
	}
	var images []stream.Image
	remaining := 32 << 20
	var failure error
	render.Walk(blocks, func(block *render.Block) {
		if failure != nil || block.Kind != "image" || block.File == "" {
			return
		}
		if len(images) >= 64 || remaining <= 0 {
			failure = stream.ErrLimitExceeded
			return
		}
		data, err := load(block.File)
		if err == nil && len(data) > remaining {
			failure = stream.ErrLimitExceeded
			return
		}
		var raster stream.Image
		if err == nil {
			raster, err = validatedImage(data)
		}
		if err != nil {
			appendLoss(losses, "An unavailable or unsupported image was represented by its description.")
			block.Src = ""
			return
		}
		if len(raster.Data) > remaining {
			failure = stream.ErrLimitExceeded
			return
		}
		remaining -= len(raster.Data)
		raster.Source = fmt.Sprintf("https://nix.invalid/export-image/%d/resource", len(images))
		raster.Width = block.Width
		block.Src = raster.Source
		images = append(images, raster)
	})
	return images, failure
}

func validatedImage(data []byte) (stream.Image, error) {
	if len(data) == 0 || len(data) > 10<<20 {
		return stream.Image{}, errors.New("image byte limit exceeded")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 40_000_000 {
		return stream.Image{}, errors.New("invalid or oversized raster image")
	}
	if format != "png" && format != "jpeg" && format != "webp" {
		return stream.Image{}, errors.New("unsupported image format")
	}
	// Decode before passing bytes to the document libraries. WebP is normalized to PNG.
	decoded, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return stream.Image{}, err
	}
	if format == "webp" {
		var output bytes.Buffer
		limited := &limitedWriter{writer: &output, remaining: 10 << 20}
		if err := png.Encode(limited, decoded); err != nil {
			return stream.Image{}, err
		}
		data, format = output.Bytes(), "png"
	}
	return stream.Image{Data: data, Format: format, PixelWidth: config.Width, PixelHeight: config.Height}, nil
}

func recordImage(record stream.Record, target string) *stream.Image {
	for index := range record.Images {
		if record.Images[index].Source == target {
			return &record.Images[index]
		}
	}
	return nil
}

func imageSize(raster stream.Image, maxWidth, maxHeight float64) (float64, float64) {
	width := float64(raster.PixelWidth) * 0.75
	if raster.Width > 0 {
		width = float64(raster.Width) * 0.75
	}
	width = min(width, maxWidth)
	height := width * float64(raster.PixelHeight) / float64(raster.PixelWidth)
	if height > maxHeight {
		width *= maxHeight / height
		height = maxHeight
	}
	return width, height
}
