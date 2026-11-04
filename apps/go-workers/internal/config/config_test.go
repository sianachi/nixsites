package config

import (
	"testing"
)

func TestLoadUsesSafeDefaults(t *testing.T) {
	settings, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if settings.MaxInputBytes <= 0 || settings.MaxLineBytes <= 0 || settings.MaxRecords <= 0 {
		t.Fatalf("invalid defaults: %+v", settings)
	}
	if settings.PluginMaxModuleBytes != 8<<20 || settings.PluginMemoryPages != 1024 || settings.PluginTimeout <= 0 || settings.PluginMaxHostCalls != 32 {
		t.Fatalf("invalid plugin defaults: %+v", settings)
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

func TestLoadRejectsUnboundedPluginLimits(t *testing.T) {
	for key, value := range map[string]string{
		"NIX_PLUGIN_MAX_MODULE_BYTES":     "33554433",
		"NIX_PLUGIN_MEMORY_PAGES":         "4097",
		"NIX_PLUGIN_TIMEOUT_MILLISECONDS": "5001",
		"NIX_PLUGIN_MAX_HOST_CALLS":       "257",
	} {
		t.Run(key, func(t *testing.T) {
			if _, err := Load(func(candidate string) string {
				if candidate == key {
					return value
				}
				return ""
			}); err == nil {
				t.Fatalf("Load accepted %s=%s", key, value)
			}
		})
	}
}

func TestLoadRejectsNonPositiveLimits(t *testing.T) {
	settings, err := Load(func(key string) string {
		if key == "NIX_WORKER_MAX_RECORDS" {
			return "0"
		}
		return ""
	})
	if err == nil || settings.MaxRecords != 0 {
		t.Fatalf("Load() = %+v, %v; want invalid zero limit", settings, err)
	}
}

func TestLoadRejectsMalformedNumericConfiguration(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "NIX_WORKER_MAX_RECORDS" {
			return "many"
		}
		return ""
	})
	if err == nil {
		t.Fatal("Load() accepted malformed numeric configuration")
	}
}

func TestLoadParsesAndValidatesObjectOrigins(t *testing.T) {
	settings, err := Load(func(key string) string {
		if key == "NIX_WORKER_OBJECT_ORIGINS" {
			return "https://objects.example.test, http://localhost:7070"
		}
		return ""
	})
	if err != nil || len(settings.ObjectOrigins) != 2 {
		t.Fatalf("Load() = %+v, %v", settings, err)
	}
	if _, err := Load(func(key string) string {
		if key == "NIX_WORKER_OBJECT_ORIGINS" {
			return "https://objects.example.test/private"
		}
		return ""
	}); err == nil {
		t.Fatal("Load() accepted an origin with a path")
	}
}
