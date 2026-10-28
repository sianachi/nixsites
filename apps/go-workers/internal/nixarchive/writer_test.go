package nixarchive

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

func TestArchiveProfileLimitsMatchSharedFixture(t *testing.T) {
	data, err := os.ReadFile("../../../../fixtures/nix-archive-v2-limits.json")
	if err != nil {
		t.Fatal(err)
	}
	var limits struct {
		Ordinary struct {
			MaxArchiveEntries int `json:"maxArchiveEntries"`
			MaxItems          int `json:"maxItems"`
		} `json:"ordinary"`
		Template struct {
			MaxArchiveEntries int `json:"maxArchiveEntries"`
			MaxItems          int `json:"maxItems"`
		} `json:"template"`
		MaxFileVersionsPerItem int `json:"maxFileVersionsPerItem"`
	}
	if err := json.Unmarshal(data, &limits); err != nil {
		t.Fatal(err)
	}
	if limits.Ordinary.MaxArchiveEntries != MaxArchiveEntries || limits.Ordinary.MaxItems != MaxArchiveItems ||
		limits.Template.MaxArchiveEntries != MaxTemplateArchiveEntries || limits.Template.MaxItems != MaxTemplateArchiveItems ||
		limits.MaxFileVersionsPerItem != MaxFileVersionsPerItem {
		t.Fatalf("Go archive bounds differ from shared fixture: %+v", limits)
	}
}

func TestWriteProducesManifestFirstLosslessArchive(t *testing.T) {
	root := "123e4567-e89b-12d3-a456-426614174000"
	manifest := Manifest{Format: Format, FormatVersion: FormatVersion, Root: root, Items: []ManifestItem{{ID: root, Title: "Root", Seq: "0"}}}
	var output bytes.Buffer
	if err := Write(&output, manifest, []Bundle{{ID: root, Title: "Root", Properties: map[string]any{}, Body: []byte(`{"body":"prose"}`)}}, 1024*1024); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(output.Bytes(), []byte("manifest.json")) {
		t.Fatal("archive did not contain its manifest")
	}
}

func TestWriteStreamPreservesUnknownSourceFieldsForLosslessArchives(t *testing.T) {
	root := "123e4567-e89b-12d3-a456-426614174000"
	streamBody := `{"format":"nix-archive","formatVersion":1,"schemaVersion":99,"exportedAt":"2026-08-31T00:00:00Z","root":"` + root + `","rootEffectiveSchema":null,"includesDeleted":false,"items":[{"id":"` + root + `","parentId":null,"seq":"1","title":"Root","type":"future"}],"omitted":[],"loss":[],"futureManifest":{"kept":true}}` + "\n" +
		`{"id":"` + root + `","parentId":null,"workspaceId":"workspace","type":"future","title":"Root","seq":"1","lifecycleState":"active","createdAt":"2026-08-31T00:00:00Z","updatedAt":"2026-08-31T00:00:00Z","properties":{},"schema":null,"views":null,"viewRows":[],"viewRowsTruncated":false,"body":{"schemaVersion":99,"futureBody":{"kept":true}},"futureBundle":{"kept":true}}` + "\n" +
		`{"end":true,"items":1}` + "\n"
	input, err := OpenBundleStream(bytes.NewBufferString(streamBody), stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := WriteStream(&output, input.Manifest, input.Next, 1<<20); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range archive.File {
		body, openErr := entry.Open()
		if openErr != nil {
			t.Fatal(openErr)
		}
		content, readErr := io.ReadAll(body)
		_ = body.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		if entry.Name == "manifest.json" && !bytes.Contains(content, []byte(`"futureManifest":{"kept":true}`)) {
			t.Fatal("unknown manifest field was discarded")
		}
		if entry.Name == "items/"+root+".json" && !bytes.Contains(content, []byte(`"futureBundle":{"kept":true}`)) {
			t.Fatal("unknown bundle field was discarded")
		}
	}
}

func TestWriteRefusesFileItemBeforeWritingArchiveBytes(t *testing.T) {
	root := "123e4567-e89b-12d3-a456-426614174000"
	manifest := Manifest{
		Format: Format, FormatVersion: FormatVersion, Root: root,
		Items: []ManifestItem{{ID: root, Title: "Diagram", Seq: "1", Type: "file"}},
	}
	var output bytes.Buffer
	err := Write(&output, manifest, []Bundle{{ID: root, Type: "file", Title: "Diagram"}}, 1<<20)
	if !errors.Is(err, ErrFileBytesUnsupported) {
		t.Fatalf("Write() error = %v, want ErrFileBytesUnsupported", err)
	}
	if output.Len() != 0 {
		t.Fatalf("file-item refusal wrote %d archive bytes", output.Len())
	}
}

func TestWriteRefusesBodiesWithDurableFileReferencesBeforeClosingArchive(t *testing.T) {
	root := "123e4567-e89b-12d3-a456-426614174000"
	fileID := "223e4567-e89b-12d3-a456-426614174000"
	tests := []struct {
		name string
		body string
	}{
		{
			name: "note fileItemId",
			body: `{"schemaVersion":3,"prosemirror":{"type":"doc","content":[{"type":"image","attrs":{"src":"","fileItemId":"` + fileID + `"}}]}}`,
		},
		{
			name: "legacy note nix-file source",
			body: `{"schemaVersion":2,"prosemirror":{"type":"doc","content":[{"type":"image","attrs":{"src":"nix-file:` + fileID + `"}}]}}`,
		},
		{
			name: "canonical canvas marker",
			body: `{"schemaVersion":3,"canvas":{"elements":{"image":{"type":"image","customData":{"nix":{"kind":"file","itemId":"` + fileID + `"}}}}}}`,
		},
		{
			name: "transitional canvas image item",
			body: `{"schemaVersion":2,"canvas":{"elements":{"image":{"type":"image","imageItemId":"` + fileID + `"}}}}`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manifest := Manifest{
				Format: Format, FormatVersion: FormatVersion, Root: root,
				Items: []ManifestItem{{ID: root, Title: "Root", Seq: "1", Type: "note"}},
			}
			var output bytes.Buffer
			err := Write(
				&output,
				manifest,
				[]Bundle{{ID: root, Type: "note", Title: "Root", Body: []byte(test.body)}},
				1<<20,
			)
			if !errors.Is(err, ErrFileBytesUnsupported) {
				t.Fatalf("Write() error = %v, want ErrFileBytesUnsupported", err)
			}
			if _, openErr := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len())); openErr == nil {
				t.Fatal("refusal completed a readable archive")
			}
		})
	}
}

func TestWriteAllowsRemoteNoteImageWithoutNixOwnedBytes(t *testing.T) {
	root := "123e4567-e89b-12d3-a456-426614174000"
	manifest := Manifest{
		Format: Format, FormatVersion: FormatVersion, Root: root,
		Items: []ManifestItem{{ID: root, Title: "Root", Seq: "1", Type: "note"}},
	}
	bundle := Bundle{
		ID: root, Type: "note", Title: "Root",
		Body: []byte(`{"schemaVersion":3,"prosemirror":{"type":"doc","content":[{"type":"image","attrs":{"src":"https://example.test/image.png"}}]}}`),
	}
	var output bytes.Buffer
	if err := Write(&output, manifest, []Bundle{bundle}, 1<<20); err != nil {
		t.Fatal(err)
	}
	if _, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len())); err != nil {
		t.Fatalf("remote image archive did not close: %v", err)
	}
}

func TestWriteStreamWithFilesStreamsAndVerifiesV2FileVersions(t *testing.T) {
	root := "123e4567-e89b-12d3-a456-426614174000"
	body := []byte("bounded PDF archive bytes")
	digest := sha256.Sum256(body)
	file := FileVersionEntry{
		ItemID: root, Version: 1, Current: true, FileName: "diagram.pdf", MediaType: "application/pdf",
		ByteLength: int64(len(body)), SHA256: fmt.Sprintf("%x", digest), Previewable: true,
	}
	manifest := Manifest{
		Format: Format, FormatVersion: FileFormatVersion, Root: root,
		Items: []ManifestItem{{ID: root, Title: "Diagram", Seq: "1", Type: "file"}},
		Files: []FileVersionEntry{file},
	}
	var output bytes.Buffer
	bundleSent := false
	fileSent := false
	err := WriteStreamWithFiles(&output, manifest,
		func() (Bundle, bool, error) {
			if bundleSent {
				return Bundle{}, false, nil
			}
			bundleSent = true
			return Bundle{ID: root, Type: "file", Title: "Diagram", Body: []byte("null")}, true, nil
		},
		func() (FileVersionEntry, io.ReadCloser, bool, error) {
			if fileSent {
				return FileVersionEntry{}, nil, false, nil
			}
			fileSent = true
			return file, io.NopCloser(bytes.NewReader(body)), true, nil
		}, 1<<20,
	)
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if len(archive.File) != 3 || archive.File[2].Name != "files/"+root+"/1.bin" {
		t.Fatalf("archive entries = %#v", archive.File)
	}
	fileBytes, err := readZipEntry(t, archive.File[2])
	if err != nil || !bytes.Equal(fileBytes, body) {
		t.Fatalf("file entry bytes = %q, error = %v", fileBytes, err)
	}
	if !bytes.Contains(readZipEntryMust(t, archive.File[0]), []byte(`"files":[`)) {
		t.Fatal("v2 manifest did not preserve the file descriptor array")
	}
}

func TestWriteStreamWithFilesRefusesInvalidLengthOrDigest(t *testing.T) {
	root := "123e4567-e89b-12d3-a456-426614174000"
	body := []byte("content")
	digest := sha256.Sum256(body)
	base := FileVersionEntry{
		ItemID: root, Version: 1, Current: true, FileName: "asset.bin", MediaType: "application/octet-stream",
		ByteLength: int64(len(body)), SHA256: fmt.Sprintf("%x", digest),
	}
	for _, test := range []struct {
		name  string
		entry FileVersionEntry
		bytes []byte
	}{
		{name: "short", entry: base, bytes: body[:len(body)-1]},
		{name: "long", entry: base, bytes: append(append([]byte(nil), body...), 'x')},
		{name: "digest", entry: FileVersionEntry{ItemID: base.ItemID, Version: base.Version, Current: base.Current, FileName: base.FileName, MediaType: base.MediaType, ByteLength: base.ByteLength, SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, bytes: body},
	} {
		t.Run(test.name, func(t *testing.T) {
			manifest := Manifest{
				Format: Format, FormatVersion: FileFormatVersion, Root: root,
				Items: []ManifestItem{{ID: root, Title: "Asset", Seq: "1", Type: "file"}},
				Files: []FileVersionEntry{test.entry},
			}
			var output bytes.Buffer
			bundleSent := false
			fileSent := false
			err := WriteStreamWithFiles(&output, manifest,
				func() (Bundle, bool, error) {
					if bundleSent {
						return Bundle{}, false, nil
					}
					bundleSent = true
					return Bundle{ID: root, Type: "file", Title: "Asset"}, true, nil
				},
				func() (FileVersionEntry, io.ReadCloser, bool, error) {
					if fileSent {
						return FileVersionEntry{}, nil, false, nil
					}
					fileSent = true
					return test.entry, io.NopCloser(bytes.NewReader(test.bytes)), true, nil
				}, 1<<20,
			)
			if err == nil {
				t.Fatal("invalid file payload was accepted")
			}
			if _, openErr := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len())); openErr == nil {
				t.Fatal("failed file payload completed a readable archive")
			}
		})
	}
}

func TestV2ManifestEmitsEmptyFileArrayAndV1OmitsField(t *testing.T) {
	root := "123e4567-e89b-12d3-a456-426614174000"
	for _, test := range []struct {
		version int
		want    []byte
		avoid   []byte
	}{
		{version: FileFormatVersion, want: []byte(`"files":[]`)},
		{version: FormatVersion, avoid: []byte(`"files"`)},
	} {
		manifest := Manifest{
			Format: Format, FormatVersion: test.version, Root: root,
			Items: []ManifestItem{{ID: root, Title: "Root", Seq: "1", Type: "note"}},
			Files: []FileVersionEntry{},
		}
		encoded, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		if len(test.want) > 0 && !bytes.Contains(encoded, test.want) {
			t.Fatalf("manifest %d = %s", test.version, encoded)
		}
		if len(test.avoid) > 0 && bytes.Contains(encoded, test.avoid) {
			t.Fatalf("v1 manifest unexpectedly contains files: %s", encoded)
		}
	}
}

func readZipEntry(t *testing.T, entry *zip.File) ([]byte, error) {
	t.Helper()
	reader, err := entry.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	return io.ReadAll(reader)
}

func readZipEntryMust(t *testing.T, entry *zip.File) []byte {
	t.Helper()
	body, err := readZipEntry(t, entry)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// Write writes the bundles in order through the streaming writer.
func Write(output io.Writer, manifest Manifest, bundles []Bundle, maxBytes int64) error {
	index := 0
	return WriteStream(output, manifest, func() (Bundle, bool, error) {
		if index == len(bundles) {
			return Bundle{}, false, nil
		}
		index++
		return bundles[index-1], true, nil
	}, maxBytes)
}

// WriteStream writes a v1 archive, which has no file versions.
func WriteStream(output io.Writer, manifest Manifest, next func() (Bundle, bool, error), maxBytes int64) error {
	return WriteStreamWithFiles(output, manifest, next, nil, maxBytes)
}
