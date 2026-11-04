package runtime

import (
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/config"
)

func TestCompanionHostRequiresAnAuthenticatedAPI(t *testing.T) {
	if err := validateSettings(config.Settings{}); err == nil {
		t.Fatal("an empty internal credential was accepted")
	}
	if err := validateSettings(config.Settings{InternalAPIURL: "http://api"}); err == nil {
		t.Fatal("an empty internal secret was accepted")
	}
	if err := validateSettings(config.Settings{InternalSecret: "secret"}); err == nil {
		t.Fatal("a missing worker API URL was accepted")
	}
	if err := validateSettings(config.Settings{InternalAPIURL: "http://api", InternalSecret: "secret"}); err != nil {
		t.Fatalf("valid API configuration was rejected: %v", err)
	}
}

func TestWorkerAPIRequiresAServiceOriginThatCannotCarrySecretsInItsURL(t *testing.T) {
	for _, target := range []string{
		"http://api.example.test",
		"https://user:password@api.example.test",
		"https://api.example.test/internal",
		"https://api.example.test?secret=value",
	} {
		if err := validateSettings(config.Settings{InternalAPIURL: target, InternalSecret: "secret"}); err == nil {
			t.Fatalf("worker accepted unsafe API target %q", target)
		}
	}
}

func TestReadinessURLAcceptsWildcardAndExplicitAddresses(t *testing.T) {
	for address, expected := range map[string]string{
		":8301":          "http://127.0.0.1:8301/readyz",
		"127.0.0.1:8302": "http://127.0.0.1:8302/readyz",
	} {
		if actual := readinessURL(address); actual != expected {
			t.Fatalf("readiness URL for %q = %q, want %q", address, actual, expected)
		}
	}
}
