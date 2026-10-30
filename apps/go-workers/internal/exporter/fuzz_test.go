package exporter

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"
	"unicode/utf8"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

func FuzzRenderTreeFailsClosedWithinItsOutputLimit(fuzz *testing.F) {
	fuzz.Add([]byte(`{"format":"nix-render","version":1,"blocks":[{"kind":"paragraph","runs":[{"text":"hello"}]}],"losses":[]}`))
	fuzz.Add([]byte(`{"format":"nix-render","version":1,"blocks":[{"kind":"quote","blocks":[{"kind":"list","items":[{"blocks":[{"kind":"table","rows":[{"cells":[[{"text":"a|b"}]]}]}]}]}]}]}`))
	fuzz.Add([]byte(`{"format":"nix-render","version":1,"blocks":[]} trailing`))
	fuzz.Add([]byte{0xff, 0xfe, 0x00})
	fuzz.Fuzz(func(t *testing.T, input []byte) {
		if len(input) > 32<<10 {
			return
		}
		projected, err := ProjectBundle(nixarchive.Bundle{ID: "one", Title: "Title", Render: json.RawMessage(input)}, 4096, nil)
		if err != nil {
			return
		}
		limits := stream.Limits{MaxBytes: 1 << 20, MaxLine: 64 << 10, MaxRecords: 1}
		for _, format := range []string{"markdown", "docx", "pdf"} {
			var output bytes.Buffer
			err := Write(format, []stream.Record{{ID: "one", Title: "Title", Blocks: projected.Blocks}}, &output, limits)
			if err != nil && !errors.Is(err, stream.ErrLimitExceeded) {
				t.Fatalf("Write(%s) failed unexpectedly: %v", format, err)
			}
			if int64(output.Len()) > limits.MaxBytes || !utf8.Valid(output.Bytes()) && format == "markdown" {
				t.Fatalf("Write(%s) escaped its bounds: %d bytes", format, output.Len())
			}
		}
	})
}
