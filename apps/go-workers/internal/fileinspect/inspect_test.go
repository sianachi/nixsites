package fileinspect

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"testing"
)

func TestOnlyBoundedNonAnimatedRasterImagesArePreviewable(t *testing.T) {
	png := pngHeader(2000, 1000, false)

	metadata := InspectHeader(png, 4*1024*1024)
	if metadata.MediaType != "image/png" || !metadata.Preview || metadata.Width == nil || *metadata.Width != 2000 || metadata.Height == nil || *metadata.Height != 1000 {
		t.Fatalf("metadata = %#v", metadata)
	}

	if animated := InspectHeader(pngHeader(2000, 1000, true), 4*1024*1024); animated.Preview || !animated.Animated {
		t.Fatalf("animated metadata = %#v", animated)
	}
	if oversized := InspectHeader(png, previewBytes+1); oversized.Preview {
		t.Fatalf("oversized metadata = %#v", oversized)
	}
}

func TestBoundedPDFsArePreviewable(t *testing.T) {
	metadata := InspectHeader([]byte("%PDF-1.7\n"), previewBytes)
	if metadata.MediaType != "application/pdf" || !metadata.Preview {
		t.Fatalf("metadata = %#v", metadata)
	}

	oversized := InspectHeader([]byte("%PDF-1.7\n"), previewBytes+1)
	if oversized.MediaType != "application/pdf" || oversized.Preview {
		t.Fatalf("oversized metadata = %#v", oversized)
	}
}

func TestActiveAndVectorFormatsStayDownloadOnly(t *testing.T) {
	cases := []struct {
		name      string
		body      []byte
		mediaType string
	}{
		{"svg", []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script/></svg>`), "image/svg+xml"},
		{"gif", append([]byte("GIF89a"), 1, 0, 1, 0), "image/gif"},
		{"html", []byte("<html><script>alert(1)</script></html>"), "text/plain"},
		{"executable", []byte{'M', 'Z', 0, 0, 1}, "application/octet-stream"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			metadata := InspectHeader(test.body, int64(len(test.body)))
			if metadata.MediaType != test.mediaType || metadata.Preview {
				t.Fatalf("metadata = %#v", metadata)
			}
		})
	}
}

func TestMalformedImageDimensionsNeverEnablePreview(t *testing.T) {
	png := append([]byte{137, 80, 78, 71, 13, 10, 26, 10}, make([]byte, 16)...)

	metadata := InspectHeader(png, int64(len(png)))

	if metadata.MediaType != "image/png" || metadata.Preview || !metadata.Malformed {
		t.Fatalf("metadata = %#v", metadata)
	}
}

func TestImageSignaturesWithoutValidStructureNeverEnablePreview(t *testing.T) {
	fakePNG := make([]byte, 45)
	copy(fakePNG, []byte{137, 80, 78, 71, 13, 10, 26, 10})
	binary.BigEndian.PutUint32(fakePNG[16:20], 640)
	binary.BigEndian.PutUint32(fakePNG[20:24], 480)
	fakeJPEG := []byte{0xff, 0xd8, 0xff, 0xc0, 0, 7, 8, 1, 0, 1, 0}

	for _, body := range [][]byte{fakePNG, fakeJPEG} {
		metadata := InspectHeader(body, int64(len(body)))
		if metadata.Preview || !metadata.Malformed {
			t.Fatalf("metadata = %#v", metadata)
		}
	}
}

func pngHeader(width, height uint32, animated bool) []byte {
	body := append([]byte{}, []byte{137, 80, 78, 71, 13, 10, 26, 10}...)
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], width)
	binary.BigEndian.PutUint32(ihdr[4:8], height)
	ihdr[8] = 8
	ihdr[9] = 6
	body = appendPNGChunk(body, "IHDR", ihdr)
	if animated {
		control := make([]byte, 8)
		binary.BigEndian.PutUint32(control[0:4], 2)
		binary.BigEndian.PutUint32(control[4:8], 1)
		body = appendPNGChunk(body, "acTL", control)
	}
	return appendPNGChunk(body, "IDAT", nil)
}

func appendPNGChunk(target []byte, kind string, data []byte) []byte {
	chunk := make([]byte, 12+len(data))
	binary.BigEndian.PutUint32(chunk[0:4], uint32(len(data)))
	copy(chunk[4:8], kind)
	copy(chunk[8:], data)
	binary.BigEndian.PutUint32(chunk[8+len(data):], crc32.ChecksumIEEE(chunk[4:8+len(data)]))
	return append(target, chunk...)
}

func FuzzInspectHeaderNeverPanicsOrExceedsImageBounds(fuzz *testing.F) {
	fuzz.Add([]byte{137, 80, 78, 71, 13, 10, 26, 10}, int64(8))
	fuzz.Add([]byte("RIFF\x00\x00\x00\x00WEBPVP8X"), int64(16))
	fuzz.Add([]byte("<svg>"), int64(5))
	fuzz.Fuzz(func(t *testing.T, header []byte, total int64) {
		if len(header) > HeaderLimit() {
			header = header[:HeaderLimit()]
		}
		metadata := InspectHeader(header, total)
		if metadata.Width != nil && (*metadata.Width <= 0 || *metadata.Width > 100_000) {
			t.Fatalf("width = %d", *metadata.Width)
		}
		if metadata.Height != nil && (*metadata.Height <= 0 || *metadata.Height > 100_000) {
			t.Fatalf("height = %d", *metadata.Height)
		}
	})
}

func TestWebMIsAudioOnlyWhenItsTracksAreAudioOnly(t *testing.T) {
	ebml := []byte{0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84}
	recording := append(append([]byte{}, ebml...), []byte("webm\x18\x53\x80\x67\x86A_OPUS")...)
	if metadata := InspectHeader(recording, 1024); metadata.MediaType != "audio/webm" || metadata.Preview {
		t.Fatalf("recording metadata = %#v", metadata)
	}

	video := append(append([]byte{}, recording...), []byte("\x86V_VP9")...)
	if metadata := InspectHeader(video, 1024); metadata.MediaType != "video/webm" || metadata.Preview {
		t.Fatalf("video metadata = %#v", metadata)
	}

	matroska := append(append([]byte{}, ebml...), []byte("matroska\x86A_OPUS")...)
	if metadata := InspectHeader(matroska, 1024); metadata.MediaType != "application/octet-stream" {
		t.Fatalf("matroska metadata = %#v", metadata)
	}
}

func TestMP4IsAVideoUnlessItIsAudioOrAnotherContainer(t *testing.T) {
	box := func(brand string) []byte {
		return append([]byte{0, 0, 0, 24, 'f', 't', 'y', 'p'}, []byte(brand+"\x00\x00\x02\x00isomiso2")...)
	}
	for brand, want := range map[string]string{
		"isom": "video/mp4", "mp42": "video/mp4", "M4A ": "audio/mp4", "qt  ": "application/octet-stream",
	} {
		if got := InspectHeader(box(brand), 1024).MediaType; got != want {
			t.Fatalf("brand %q = %q, want %q", brand, got, want)
		}
	}
}

func TestZipContainersAreNamedByTheirOOXMLParts(t *testing.T) {
	build := func(names ...string) []byte {
		var buffer bytes.Buffer
		writer := zip.NewWriter(&buffer)
		for _, name := range names {
			entry, _ := writer.Create(name)
			entry.Write([]byte("x"))
		}
		writer.Close()
		return buffer.Bytes()
	}
	const ooxml = "application/vnd.openxmlformats-officedocument."
	for name, test := range map[string]struct {
		names []string
		want  string
	}{
		"docx":      {[]string{"[Content_Types].xml", "_rels/.rels", "word/document.xml"}, ooxml + "wordprocessingml.document"},
		"xlsx":      {[]string{"[Content_Types].xml", "xl/workbook.xml"}, ooxml + "spreadsheetml.sheet"},
		"pptx":      {[]string{"[Content_Types].xml", "ppt/presentation.xml"}, ooxml + "presentationml.presentation"},
		"plain zip": {[]string{"a.txt", "b/c.txt"}, "application/zip"},
		"no parts":  {[]string{"[Content_Types].xml"}, "application/zip"},
	} {
		data := build(test.names...)
		if got := InspectHeader(data, int64(len(data))).MediaType; got != test.want {
			t.Errorf("%s = %q, want %q", name, got, test.want)
		}
	}
}
