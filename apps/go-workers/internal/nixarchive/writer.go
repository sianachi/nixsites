package nixarchive

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"strings"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

// FileSource is one immutable file version selected by the manifest. Bytes are supplied as a
// reader so callers can stream from object storage without buffering the full file in memory.
type FileSource struct {
	Entry  FileVersionEntry
	Reader io.ReadCloser
}

// WriteStreamWithFiles writes one bundle and one file version at a time. File content is streamed
// into a stored ZIP member and SHA-256 is checked incrementally against the manifest metadata.
func WriteStreamWithFiles(output io.Writer, manifest Manifest, next func() (Bundle, bool, error), nextFile func() (FileVersionEntry, io.ReadCloser, bool, error), maxBytes int64) error {
	if len(manifest.Items) == 0 || len(manifest.Items) > MaxArchiveItems || 1+len(manifest.Items)+len(manifest.Files) > MaxArchiveEntries {
		return fmt.Errorf("archive exceeds the shared Nix archive entry or item ceiling")
	}
	if err := ValidateManifest(manifest, len(manifest.Items)); err != nil {
		return err
	}
	if err := validateRawManifest(manifest); err != nil {
		return err
	}
	if output == nil || next == nil || maxBytes <= 0 {
		return fmt.Errorf("archive writer configuration is invalid")
	}
	if err := validateManifestFilePortability(manifest); err != nil {
		return err
	}
	if manifest.FormatVersion == FileFormatVersion && nextFile == nil {
		return fmt.Errorf("archive v2 file reader is required")
	}
	limited := &limitedWriter{writer: output, remaining: maxBytes}
	archive := zip.NewWriter(limited)
	manifestBytes, err := encoded(manifest.Raw, manifest)
	if err != nil {
		return err
	}
	if err := writeEntry(archive, "manifest.json", manifestBytes); err != nil {
		return err
	}
	for index, item := range manifest.Items {
		bundle, ok, err := next()
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("archive bundle count does not match manifest")
		}
		if !safeID.MatchString(bundle.ID) {
			return fmt.Errorf("unsafe bundle identifier")
		}
		if bundle.ID != item.ID || bundle.ID != manifest.Items[index].ID {
			return fmt.Errorf("archive bundle order does not match manifest")
		}
		if bundle.Type != item.Type {
			return fmt.Errorf("archive bundle type does not match manifest")
		}
		if err := validateBundleFilePortability(bundle, manifest); err != nil {
			return err
		}
		payload, err := encoded(bundle.Raw, bundle)
		if err != nil {
			return err
		}
		if err := writeEntry(archive, "items/"+bundle.ID+".json", payload); err != nil {
			return err
		}
	}
	if _, ok, err := next(); err != nil {
		return err
	} else if ok {
		return fmt.Errorf("archive bundle count does not match manifest")
	}
	if manifest.FormatVersion == FileFormatVersion {
		for _, expected := range manifest.Files {
			entry, reader, ok, err := nextFile()
			if err != nil {
				return err
			}
			if !ok || reader == nil {
				return fmt.Errorf("archive file-version count does not match manifest")
			}
			if !reflect.DeepEqual(entry, expected) {
				_ = reader.Close()
				return fmt.Errorf("archive file-version order does not match manifest")
			}
			if err := writeFileEntry(archive, entry, reader); err != nil {
				return err
			}
		}
		if _, _, ok, err := nextFile(); err != nil {
			return err
		} else if ok {
			return fmt.Errorf("archive file-version count does not match manifest")
		}
	} else if nextFile != nil {
		if _, reader, ok, err := nextFile(); err != nil {
			return err
		} else if ok {
			if reader != nil {
				_ = reader.Close()
			}
			return fmt.Errorf("archive v1 cannot write file-version entries")
		}
	}
	if err := archive.Close(); err != nil {
		return err
	}
	return limited.err
}

func validateRawManifest(manifest Manifest) error {
	if len(manifest.Raw) == 0 {
		return nil
	}
	var source Manifest
	if err := json.Unmarshal(manifest.Raw, &source); err != nil {
		return fmt.Errorf("archive source JSON is invalid: %w", err)
	}
	if err := ValidateManifest(source, len(manifest.Items)); err != nil {
		return err
	}
	if source.Format != manifest.Format || source.FormatVersion != manifest.FormatVersion || source.Root != manifest.Root ||
		!reflect.DeepEqual(source.Items, manifest.Items) || !reflect.DeepEqual(source.Files, manifest.Files) {
		return fmt.Errorf("archive manifest source does not match its validated descriptor")
	}
	return nil
}

func writeFileEntry(archive *zip.Writer, metadata FileVersionEntry, source io.ReadCloser) error {
	defer source.Close()
	name := fileEntryName(metadata.ItemID, metadata.Version)
	header := &zip.FileHeader{Name: name, Method: zip.Store}
	header.SetModTime(time.Date(1980, time.January, 1, 0, 0, 0, 0, time.UTC))
	entry, err := archive.CreateHeader(header)
	if err != nil {
		return err
	}
	digest := sha256.New()
	count, err := io.Copy(io.MultiWriter(entry, digest), io.LimitReader(source, metadata.ByteLength+1))
	if err != nil {
		return err
	}
	if count != metadata.ByteLength {
		return fmt.Errorf("file version %s/%d length does not match manifest", metadata.ItemID, metadata.Version)
	}
	if count > metadata.ByteLength {
		return fmt.Errorf("file version %s/%d exceeds manifest length", metadata.ItemID, metadata.Version)
	}
	if fmt.Sprintf("%x", digest.Sum(nil)) != metadata.SHA256 {
		return fmt.Errorf("file version %s/%d digest does not match manifest", metadata.ItemID, metadata.Version)
	}
	return nil
}

func fileEntryName(itemID string, version int) string {
	return fmt.Sprintf("files/%s/%d.bin", itemID, version)
}

type limitedWriter struct {
	writer    io.Writer
	remaining int64
	err       error
}

func (writer *limitedWriter) Write(value []byte) (int, error) {
	if writer.err != nil {
		return 0, writer.err
	}
	if int64(len(value)) > writer.remaining {
		writer.err = stream.ErrLimitExceeded
		return 0, writer.err
	}
	count, err := writer.writer.Write(value)
	writer.remaining -= int64(count)
	writer.err = err
	return count, err
}
func writeEntry(archive *zip.Writer, name string, payload []byte) error {
	if strings.Contains(name, "..") || strings.Contains(name, "\\") {
		return fmt.Errorf("unsafe archive path")
	}
	header := &zip.FileHeader{Name: name, Method: zip.Deflate}
	header.SetModTime(time.Date(1980, time.January, 1, 0, 0, 0, 0, time.UTC))
	entry, err := archive.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = entry.Write(payload)
	return err
}

func encoded(raw json.RawMessage, value any) ([]byte, error) {
	if len(raw) > 0 {
		if !json.Valid(raw) {
			return nil, fmt.Errorf("archive source JSON is invalid")
		}
		return raw, nil
	}
	return json.Marshal(value)
}
