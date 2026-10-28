package importer

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

var ErrUnsupportedFormat = errors.New("unsupported import format")

type Limits struct {
	MaxBytes int64
	MaxItems int
	MaxEntry int64
}

type Result struct {
	Records []stream.Record `json:"records"`
	Loss    []string        `json:"loss,omitempty"`
	Assets  []Asset         `json:"assets,omitempty"`
}

type Asset struct {
	Name      string
	MediaType string
	Body      []byte
}

func Parse(format, id, title string, source io.Reader, limits Limits) (Result, error) {
	if id == "" || title == "" {
		return Result{}, errors.New("id and title are required")
	}
	if limits.MaxBytes <= 0 || limits.MaxItems <= 0 || limits.MaxEntry <= 0 {
		return Result{}, errors.New("import limits must be positive")
	}
	switch strings.ToLower(format) {
	case "markdown", "md":
		return markdown(id, title, source, limits.MaxBytes)
	case "text", "txt":
		return text(id, title, source, limits.MaxBytes)
	case "docx":
		return docx(id, title, source, limits)
	case "pdf":
		return pdf(id, title, source, limits.MaxBytes)
	case "nix":
		return nix(id, title, source, limits)
	default:
		return Result{}, fmt.Errorf("%w: %s", ErrUnsupportedFormat, format)
	}
}

func text(id, title string, source io.Reader, maxBytes int64) (Result, error) {
	body, err := readBounded(source, maxBytes)
	if err != nil {
		return Result{}, err
	}
	body = bytes.TrimPrefix(body, []byte{0xef, 0xbb, 0xbf})
	if bytes.IndexByte(body, 0) >= 0 || !utf8.Valid(body) {
		return Result{}, errors.New("text input is not valid UTF-8 or appears to be binary")
	}
	normalized := strings.ReplaceAll(strings.ReplaceAll(string(body), "\r\n", "\n"), "\r", "\n")
	return Result{Records: []stream.Record{{ID: id, Title: title, Body: normalized}}}, nil
}

func markdown(id, title string, source io.Reader, maxBytes int64) (Result, error) {
	body, err := readBounded(source, maxBytes)
	if err != nil {
		return Result{}, err
	}
	return Result{Records: []stream.Record{{ID: id, Title: title, Body: string(body)}}}, nil
}

func docx(id, title string, source io.Reader, limits Limits) (Result, error) {
	archive, err := readZip(source, limits.MaxBytes, limits.MaxItems+10)
	if err != nil {
		return Result{}, err
	}
	document, err := archiveEntry(archive, "word/document.xml", limits.MaxEntry)
	if err != nil {
		return Result{}, err
	}
	text, err := docxText(document)
	if err != nil {
		return Result{}, fmt.Errorf("DOCX document.xml: %w", err)
	}
	assets := make([]Asset, 0)
	loss := make([]string, 0)
	for _, entry := range archive.File {
		if !strings.HasPrefix(entry.Name, "word/media/") || strings.HasSuffix(entry.Name, "/") {
			continue
		}
		assetLimit := limits.MaxEntry*3/4 - 1024
		body, readErr := archiveEntry(archive, entry.Name, assetLimit)
		if readErr != nil {
			loss = append(loss, fmt.Sprintf("Embedded image %s exceeded the extraction limit and remains in the original document.", path.Base(entry.Name)))
			continue
		}
		mediaType := imageMediaType(body)
		if mediaType == "" {
			loss = append(loss, fmt.Sprintf("Embedded media %s is unsupported and remains in the original document.", path.Base(entry.Name)))
			continue
		}
		assets = append(assets, Asset{Name: path.Base(entry.Name), MediaType: mediaType, Body: body})
	}
	if len(assets) > 0 {
		text += "\n\n"
		for _, asset := range assets {
			text += fmt.Sprintf("[Imported image: %s]\n", asset.Name)
		}
	}
	return Result{Records: []stream.Record{{ID: id, Title: title, Body: text}}, Assets: assets, Loss: loss}, nil
}

func imageMediaType(body []byte) string {
	switch {
	case len(body) >= 8 && bytes.Equal(body[:8], []byte{137, 80, 78, 71, 13, 10, 26, 10}):
		return "image/png"
	case len(body) >= 3 && body[0] == 0xff && body[1] == 0xd8 && body[2] == 0xff:
		return "image/jpeg"
	case len(body) >= 12 && string(body[:4]) == "RIFF" && string(body[8:12]) == "WEBP":
		return "image/webp"
	case len(body) >= 6 && (string(body[:6]) == "GIF87a" || string(body[:6]) == "GIF89a"):
		return "image/gif"
	default:
		return ""
	}
}

func pdf(id, title string, source io.Reader, maxBytes int64) (Result, error) {
	body, err := readBounded(source, maxBytes)
	if err != nil {
		return Result{}, err
	}
	if !bytes.HasPrefix(body, []byte("%PDF-")) {
		return Result{}, errors.New("PDF input does not start with a PDF signature")
	}
	text, err := popplerText(body, maxBytes)
	if err != nil {
		return Result{}, err
	}
	if strings.TrimSpace(text) == "" {
		return Result{}, errors.New("PDF contains no extractable text; OCR is not available")
	}
	return Result{Records: []stream.Record{{ID: id, Title: title, Body: text}}, Loss: []string{"PDF fonts, vector graphics, images, and exact layout are not preserved."}}, nil
}

func nix(id, title string, source io.Reader, limits Limits) (Result, error) {
	archive, err := readZip(source, limits.MaxBytes, limits.MaxItems+1)
	if err != nil {
		return Result{}, err
	}
	manifestBytes, err := archiveEntry(archive, "manifest.json", limits.MaxEntry)
	if err != nil {
		return Result{}, err
	}
	var manifest nixarchive.Manifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return Result{}, fmt.Errorf("archive manifest: %w", err)
	}
	if err := nixarchive.ValidateManifest(manifest, limits.MaxItems); err != nil {
		return Result{}, err
	}
	expected := make(map[string]nixarchive.ManifestItem, len(manifest.Items))
	for _, item := range manifest.Items {
		expected[item.ID] = item
	}
	var records []stream.Record
	for _, entry := range archive.File {
		if !strings.HasPrefix(entry.Name, "items/") || !strings.HasSuffix(entry.Name, ".json") {
			continue
		}
		if len(records) >= limits.MaxItems {
			return Result{}, stream.ErrLimitExceeded
		}
		payload, readErr := archiveEntry(archive, entry.Name, limits.MaxEntry)
		if readErr != nil {
			return Result{}, readErr
		}
		var bundle nixarchive.Bundle
		if parseErr := json.Unmarshal(payload, &bundle); parseErr != nil {
			return Result{}, fmt.Errorf("%s: %w", entry.Name, parseErr)
		}
		manifestItem, ok := expected[bundle.ID]
		if !ok || !strings.HasSuffix(entry.Name, "/"+bundle.ID+".json") {
			return Result{}, fmt.Errorf("%s is not listed by the manifest", entry.Name)
		}
		if bundle.Title == "" {
			bundle.Title = manifestItem.Title
		}
		body := string(bundle.Body)
		records = append(records, stream.Record{ID: bundle.ID, ParentID: valueOrEmpty(bundle.ParentID), Title: bundle.Title, Body: body, Properties: bundle.Properties})
	}
	if len(records) == 0 {
		return Result{}, errors.New("archive contains no item payloads")
	}
	if records[0].ID == id {
		records[0].Title = title
	}
	return Result{Records: records}, nil
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func readBounded(source io.Reader, maxBytes int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(source, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBytes {
		return nil, stream.ErrLimitExceeded
	}
	return body, nil
}

func readZip(source io.Reader, maxBytes int64, maxEntries int) (*zip.Reader, error) {
	body, err := readBounded(source, maxBytes)
	if err != nil {
		return nil, err
	}
	archive, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		return nil, err
	}
	if len(archive.File) > maxEntries {
		return nil, stream.ErrLimitExceeded
	}
	var expandedBytes uint64
	for _, entry := range archive.File {
		clean := path.Clean(entry.Name)
		if clean == "." || strings.HasPrefix(clean, "../") || strings.HasPrefix(entry.Name, "/") || strings.Contains(entry.Name, "\\") {
			return nil, errors.New("archive contains an unsafe path")
		}
		expandedBytes += entry.UncompressedSize64
		if expandedBytes > uint64(maxBytes) {
			return nil, stream.ErrLimitExceeded
		}
	}
	return archive, nil
}

func archiveEntry(archive *zip.Reader, name string, maxBytes int64) ([]byte, error) {
	for _, entry := range archive.File {
		if entry.Name != name {
			continue
		}
		if entry.UncompressedSize64 > uint64(maxBytes) {
			return nil, stream.ErrLimitExceeded
		}
		file, err := entry.Open()
		if err != nil {
			return nil, err
		}
		body, readErr := readBounded(file, maxBytes)
		_ = file.Close()
		return body, readErr
	}
	return nil, fmt.Errorf("archive entry %q is missing", name)
}

func docxText(document []byte) (string, error) {
	upper := bytes.ToUpper(document)
	if bytes.Contains(upper, []byte("<!DOCTYPE")) || bytes.Contains(upper, []byte("<!ENTITY")) {
		return "", errors.New("XML document types and entities are not supported")
	}
	decoder := xml.NewDecoder(bytes.NewReader(document))
	var builder strings.Builder
	paragraphOpen := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return strings.TrimSpace(builder.String()), nil
		}
		if err != nil {
			return "", err
		}
		switch value := token.(type) {
		case xml.StartElement:
			if value.Name.Local == "p" {
				if builder.Len() > 0 {
					builder.WriteString("\n\n")
				}
				paragraphOpen = true
			} else if value.Name.Local == "tab" {
				builder.WriteByte('\t')
			} else if value.Name.Local == "br" {
				builder.WriteByte('\n')
			}
		case xml.EndElement:
			if value.Name.Local == "p" {
				paragraphOpen = false
			}
		case xml.CharData:
			if paragraphOpen {
				builder.Write([]byte(value))
			}
		}
	}
}

func popplerText(body []byte, maxBytes int64) (string, error) {
	command := exec.Command("pdftotext", "-layout", "-", "-")
	command.Stdin = bytes.NewReader(body)
	stdout, err := command.StdoutPipe()
	if err != nil {
		return "", fmt.Errorf("start pdftotext: %w", err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		return "", fmt.Errorf("pdftotext is unavailable: %w", err)
	}
	output, readErr := readBounded(stdout, maxBytes)
	if readErr != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		return "", readErr
	}
	waitErr := command.Wait()
	if waitErr != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = waitErr.Error()
		}
		return "", fmt.Errorf("PDF extraction failed: %s", detail)
	}
	return strings.TrimSpace(strings.ReplaceAll(string(output), "\f", "\n\n")), nil
}
