package pluginruntime

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/sianachi/Nix/apps/go-workers/internal/plugintest"
	"strings"
	"testing"
	"time"
)

func TestSignedComponentExecutesAgainstOnlyTheNixHostABI(t *testing.T) {
	runtime, err := New(DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	invocation := signedInvocation(t, eventSizeModule())
	host := &recordingHost{}

	if err := runtime.Execute(t.Context(), invocation, host); err != nil {
		t.Fatalf("execute signed component: %v", err)
	}
	if host.calls != 0 {
		t.Fatalf("host calls = %d, want 0", host.calls)
	}
}

func TestComponentDigestAndSignatureAreBoundToIdentityAndVersion(t *testing.T) {
	runtime, err := New(DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	invocation := signedInvocation(t, plugintest.SuccessModule())
	invocation.Component.Version = "2.0.0"

	err = runtime.Execute(t.Context(), invocation, &recordingHost{})
	if !errors.Is(err, ErrInvalidPlugin) {
		t.Fatalf("Execute error = %v, want ErrInvalidPlugin", err)
	}
}

func TestUnknownHostImportsAreRejected(t *testing.T) {
	runtime, err := New(DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	wasm := eventSizeModule()
	copy(wasm[13:21], []byte("bad_host"))
	invocation := signedInvocation(t, wasm)

	err = runtime.Execute(t.Context(), invocation, &recordingHost{})
	if !errors.Is(err, ErrInvalidPlugin) {
		t.Fatalf("Execute error = %v, want ErrInvalidPlugin", err)
	}
}

func TestRunawayGuestIsStoppedByTheExecutionDeadline(t *testing.T) {
	limits := DefaultLimits()
	limits.ExecutionTimeout = 20 * time.Millisecond
	runtime, err := New(limits)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	err = runtime.Execute(t.Context(), signedInvocation(t, infiniteLoopModule()), &recordingHost{})
	if !errors.Is(err, ErrPluginFailed) {
		t.Fatalf("Execute error = %v, want ErrPluginFailed", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("runaway guest stopped after %v, want under one second", elapsed)
	}
}

func TestInvocationRejectsDuplicateOrMalformedCapabilities(t *testing.T) {
	runtime, err := New(DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	for name, capabilities := range map[string][]string{
		"duplicate": {"items.read", "items.read"},
		"malformed": {"Items Read"},
	} {
		t.Run(name, func(t *testing.T) {
			invocation := signedInvocation(t, plugintest.SuccessModule())
			invocation.Capabilities = capabilities
			if err := runtime.Execute(t.Context(), invocation, &recordingHost{}); !errors.Is(err, ErrInvalidPlugin) {
				t.Fatalf("Execute error = %v, want ErrInvalidPlugin", err)
			}
		})
	}
}

func TestInvocationRequiresCanonicalNonzeroIdentifiers(t *testing.T) {
	runtime, err := New(DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	for _, identifier := range []string{
		"not-a-uuid",
		"00000000-0000-0000-0000-000000000000",
		"11111111-1111-4111-8111-11111111111A",
	} {
		invocation := signedInvocation(t, plugintest.SuccessModule())
		invocation.InstallationID = identifier
		if err := runtime.Execute(t.Context(), invocation, &recordingHost{}); !errors.Is(err, ErrInvalidPlugin) {
			t.Fatalf("Execute(%q) error = %v, want ErrInvalidPlugin", identifier, err)
		}
	}
}

func TestHostCallsRequireAnExactDurableGrant(t *testing.T) {
	runtime, err := New(DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	host := &recordingHost{response: json.RawMessage(`{"title":"Current"}`)}
	invocation := signedInvocation(t, plugintest.HostCallModule())

	if err := runtime.Execute(t.Context(), invocation, host); err != nil {
		t.Fatalf("execute granted host call: %v", err)
	}
	if host.calls != 1 || host.capability != "items.read" || string(host.request) != `{}` {
		t.Fatalf("host call = (%d, %q, %s)", host.calls, host.capability, host.request)
	}

	host = &recordingHost{response: json.RawMessage(`{}`)}
	invocation = signedInvocation(t, plugintest.HostCallModule())
	invocation.Capabilities = nil
	if err := runtime.Execute(t.Context(), invocation, host); !errors.Is(err, ErrPluginFailed) {
		t.Fatalf("denied Execute error = %v, want ErrPluginFailed", err)
	}
	if host.calls != 0 {
		t.Fatalf("denied capability reached host %d times", host.calls)
	}
}

func TestRuntimeLimitsRefuseUnboundedConfigurations(t *testing.T) {
	limits := DefaultLimits()
	limits.MemoryLimitPages = 0
	if _, err := New(limits); err == nil {
		t.Fatal("New accepted an unbounded memory limit")
	}
	limits = DefaultLimits()
	limits.ExecutionTimeout = 6 * time.Second
	if _, err := New(limits); err == nil {
		t.Fatal("New accepted an excessive execution timeout")
	}
}

func FuzzSignedComponentsStayBounded(f *testing.F) {
	f.Add(plugintest.SuccessModule())
	f.Add(infiniteLoopModule())
	f.Add([]byte("not-wasm"))
	limits := DefaultLimits()
	limits.MaxModuleBytes = 64 << 10
	limits.ExecutionTimeout = 20 * time.Millisecond
	runtime, err := New(limits)
	if err != nil {
		f.Fatal(err)
	}
	f.Fuzz(func(t *testing.T, wasm []byte) {
		if len(wasm) == 0 || len(wasm) > limits.MaxModuleBytes {
			t.Skip()
		}
		started := time.Now()
		_ = runtime.Execute(t.Context(), signedInvocation(t, wasm), &recordingHost{})
		if elapsed := time.Since(started); elapsed > time.Second {
			t.Fatalf("component execution exceeded bound: %v", elapsed)
		}
	})
}

func signedInvocation(t *testing.T, wasm []byte) Invocation {
	t.Helper()
	seed := bytes.Repeat([]byte{0x5a}, ed25519.SeedSize)
	privateKey := ed25519.NewKeyFromSeed(seed)
	digest := sha256.Sum256(wasm)
	component := Component{
		ID:        "nix.test/example",
		Version:   "1.0.0",
		SHA256:    strings.ToUpper(hex.EncodeToString(digest[:])),
		PublicKey: append([]byte(nil), privateKey.Public().(ed25519.PublicKey)...),
		Wasm:      append([]byte(nil), wasm...),
	}
	component.Signature = ed25519.Sign(privateKey, signaturePayload(component))
	return Invocation{
		InstallationID: "11111111-1111-4111-8111-111111111111",
		EventID:        "22222222-2222-4222-8222-222222222222",
		Component:      component,
		Event:          json.RawMessage(`{"kind":"item.changed"}`),
		Capabilities:   []string{"items.read"},
	}
}

type recordingHost struct {
	calls      int
	capability string
	request    json.RawMessage
	response   json.RawMessage
}

func (host *recordingHost) Call(_ context.Context, _, _, capability string, request json.RawMessage) (json.RawMessage, error) {
	host.calls++
	host.capability = capability
	host.request = append(host.request[:0], request...)
	if host.response == nil {
		return json.RawMessage(`{}`), nil
	}
	return host.response, nil
}

func infiniteLoopModule() []byte {
	wasm := plugintest.SuccessModule()
	return append(append([]byte(nil), wasm[:len(wasm)-8]...),
		0x0a, 0x0b, 0x01, 0x09, 0x00, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x41, 0x00, 0x0b)
}

func eventSizeModule() []byte {
	return []byte{
		0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
		0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
		0x02, 0x17, 0x01, 0x08, 'n', 'i', 'x', '_', 'h', 'o', 's', 't', 0x0a, 'e', 'v', 'e', 'n', 't', '_', 's', 'i', 'z', 'e', 0x00, 0x00,
		0x03, 0x02, 0x01, 0x00,
		0x07, 0x10, 0x01, 0x0c, 'n', 'i', 'x', '_', 'o', 'n', '_', 'e', 'v', 'e', 'n', 't', 0x00, 0x01,
		0x0a, 0x09, 0x01, 0x07, 0x00, 0x10, 0x00, 0x1a, 0x41, 0x00, 0x0b,
	}
}
