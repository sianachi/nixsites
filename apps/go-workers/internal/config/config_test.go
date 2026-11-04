package config

import (
	"testing"
)

func TestLoadUsesSafeDefaults(t *testing.T) {
	settings, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if settings.RequestTimeout <= 0 || settings.PollInterval <= 0 || settings.Address != ":8301" {
		t.Fatalf("invalid defaults: %+v", settings)
	}
	if settings.CompanionChatEffort != "low" {
		t.Fatalf("chat effort default = %q, want \"low\"", settings.CompanionChatEffort)
	}
	if settings.CompanionTrace {
		t.Fatal("the full-content companion trace must be off by default")
	}
}

func TestLoadEnablesTheCompanionTraceOnlyWhenAsked(t *testing.T) {
	for value, want := range map[string]bool{"true": true, "1": true, "false": false, "yes": false, "": false} {
		settings, err := Load(func(key string) string {
			if key == "NIX_COMPANION_TRACE" {
				return value
			}
			return ""
		})
		if err != nil {
			t.Fatal(err)
		}
		if settings.CompanionTrace != want {
			t.Fatalf("NIX_COMPANION_TRACE=%q: trace = %v, want %v", value, settings.CompanionTrace, want)
		}
	}
}

func TestLoadReadsConfiguredReasoningEffort(t *testing.T) {
	settings, err := Load(func(key string) string {
		if key == "NIX_COMPANION_CHAT_EFFORT" {
			return "minimal"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if settings.CompanionChatEffort != "minimal" {
		t.Fatalf("chat effort = %q, want \"minimal\"", settings.CompanionChatEffort)
	}
}

func TestLoadRejectsNonPositiveAndMalformedTimeouts(t *testing.T) {
	for _, value := range []string{"0", "-5", "many"} {
		if _, err := Load(func(key string) string {
			if key == "NIX_WORKER_REQUEST_TIMEOUT_SECONDS" {
				return value
			}
			return ""
		}); err == nil {
			t.Fatalf("Load accepted NIX_WORKER_REQUEST_TIMEOUT_SECONDS=%q", value)
		}
	}
}
