package fileinspect

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"path"
	"strings"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/thumbnail"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

// Thumbnailing is best effort and never fails an inspection. The object is already on local disk
// from the inspection pass (its size was checked while copying), so the extractor reads that file
// through io.ReaderAt and nothing is fetched twice.
const (
	// thumbnailTimeout bounds one thumbnail from extraction to upload.
	thumbnailTimeout = 20 * time.Second
	// maxConcurrentThumbnails is how many thumbnails one worker process decodes at once. An image
	// of up to 40 million pixels needs a few hundred megabytes to decode, and the role's job
	// concurrency (NIX_WORKER_MAX_CONCURRENCY) can be far higher than that is safe for.
	maxConcurrentThumbnails = 2
	// maxThumbnailBytes is the ceiling Core accepts for a thumbnail object; a larger result is
	// treated as no thumbnail. Core's FileEndpoints.MaximumThumbnailBytes must agree.
	maxThumbnailBytes = 2 << 20
)

// attachThumbnail fills the thumbnail fields of inspected when a thumbnail was made and stored. Any
// failure leaves them nil, so the file simply has no thumbnail.
func (handler *Handler) attachThumbnail(ctx context.Context, uploadID, fileName, path string, inspected *workerapi.InspectedFile) {
	if !thumbnailCandidate(fileName, inspected.DetectedMediaType) {
		return
	}
	select {
	case handler.thumbnails <- struct{}{}:
		defer func() { <-handler.thumbnails }()
	case <-ctx.Done():
		return
	}
	ctx, cancel := context.WithTimeout(ctx, thumbnailTimeout)
	defer cancel()

	result, err := extractThumbnail(ctx, path, fileName, inspected)
	if err != nil {
		if !errors.Is(err, thumbnail.ErrNoThumbnail) {
			// The error names a parser failure, never file content.
			slog.Info("thumbnail skipped", "uploadId", uploadID, "reason", err.Error())
		}
		return
	}
	if len(result.JPEG) == 0 || len(result.JPEG) > maxThumbnailBytes {
		return
	}
	size := int64(len(result.JPEG))
	target, err := handler.api.ThumbnailUploadURL(ctx, uploadID, size)
	if err != nil {
		slog.Info("thumbnail upload not authorized", "uploadId", uploadID, "reason", err.Error())
		return
	}
	// The capability signs content-type octet-stream (PutSized); reads set image/jpeg via GetForBrowser.
	if err := handler.transfer.Upload(ctx, target, "application/octet-stream", bytes.NewReader(result.JPEG), size, ""); err != nil {
		if !errors.Is(err, objecttransfer.ErrAlreadyExists) {
			slog.Info("thumbnail upload failed", "uploadId", uploadID, "reason", err.Error())
		}
		return
	}
	width, height := result.Width, result.Height
	inspected.ThumbnailWidth, inspected.ThumbnailHeight, inspected.ThumbnailBytes = &width, &height, &size
}

func extractThumbnail(ctx context.Context, path, fileName string, inspected *workerapi.InspectedFile) (thumbnail.Result, error) {
	file, err := os.Open(path)
	if err != nil {
		return thumbnail.Result{}, err
	}
	defer file.Close()
	return thumbnail.Extract(ctx, file, inspected.ByteLength, fileName, inspected.DetectedMediaType)
}

// thumbnailCandidate decides from the inspected media type and the extension whether the extractor
// can produce anything, so PDFs, text and unknown binaries cost no decode work.
func thumbnailCandidate(fileName, mediaType string) bool {
	switch mediaType {
	case "image/png", "image/jpeg", "image/webp", "image/gif",
		"audio/mpeg", "audio/flac", "audio/mp4":
		return true
	}
	extension := strings.ToLower(path.Ext(fileName))
	switch mediaType {
	case "application/zip":
		return extension == ".epub"
	case "application/octet-stream":
		// The header inspector does not recognise BMP or MP3 without an ID3 tag.
		return extension == ".bmp" || extension == ".mp3"
	}
	return false
}
