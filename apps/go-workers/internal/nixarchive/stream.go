package nixarchive

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

type StreamEnd struct {
	End   bool `json:"end"`
	Items int  `json:"items"`
}

// BundleStream validates and yields one Collaboration bundle at a time. The manifest is retained
// because it is the bounded index of the stream; item bodies are not.
type BundleStream struct {
	scanner   *bufio.Scanner
	limits    stream.Limits
	Manifest  Manifest
	seenBytes int64
	index     int
	ended     bool
}

func OpenBundleStream(reader io.Reader, limits stream.Limits) (*BundleStream, error) {
	if reader == nil || limits.MaxBytes <= 0 || limits.MaxLine <= 0 || limits.MaxRecords <= 0 {
		return nil, errors.New("bundle stream limits must be positive")
	}
	scanner := bufio.NewScanner(io.LimitReader(reader, limits.MaxBytes+1))
	scanner.Buffer(make([]byte, min(limits.MaxLine, 64*1024)), limits.MaxLine)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return nil, err
		}
		return nil, errors.New("bundle stream is empty")
	}
	var manifest Manifest
	if err := json.Unmarshal(scanner.Bytes(), &manifest); err != nil {
		return nil, fmt.Errorf("bundle stream manifest: %w", err)
	}
	if err := ValidateManifest(manifest, limits.MaxRecords); err != nil {
		return nil, err
	}
	manifest.Raw = append(manifest.Raw[:0], scanner.Bytes()...)
	return &BundleStream{
		scanner: scanner, limits: limits, Manifest: manifest,
		seenBytes: int64(len(scanner.Bytes()) + 1),
	}, nil
}

func (input *BundleStream) Next() (Bundle, bool, error) {
	if input.ended {
		return Bundle{}, false, nil
	}
	if !input.scanner.Scan() {
		if err := input.scanner.Err(); err != nil {
			return Bundle{}, false, err
		}
		return Bundle{}, false, errors.New("bundle stream is truncated")
	}
	input.seenBytes += int64(len(input.scanner.Bytes()) + 1)
	if input.seenBytes > input.limits.MaxBytes {
		return Bundle{}, false, stream.ErrLimitExceeded
	}
	var end StreamEnd
	if err := json.Unmarshal(input.scanner.Bytes(), &end); err == nil && end.End {
		if end.Items != input.index || input.index != len(input.Manifest.Items) {
			return Bundle{}, false, errors.New("bundle stream sentinel count does not match manifest")
		}
		if input.scanner.Scan() {
			return Bundle{}, false, errors.New("bundle stream has data after its sentinel")
		}
		if err := input.scanner.Err(); err != nil {
			return Bundle{}, false, err
		}
		input.ended = true
		return Bundle{}, false, nil
	}
	if input.index >= input.limits.MaxRecords || input.index >= len(input.Manifest.Items) {
		return Bundle{}, false, stream.ErrLimitExceeded
	}
	var bundle Bundle
	if err := json.Unmarshal(input.scanner.Bytes(), &bundle); err != nil || bundle.ID == "" || bundle.Title == "" {
		return Bundle{}, false, errors.New("bundle stream contains an invalid item")
	}
	if bundle.ID != input.Manifest.Items[input.index].ID {
		return Bundle{}, false, errors.New("bundle stream order does not match manifest")
	}
	bundle.Raw = append(bundle.Raw[:0], input.scanner.Bytes()...)
	input.index++
	return bundle, true, nil
}
