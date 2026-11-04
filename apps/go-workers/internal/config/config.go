package config

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Settings struct {
	CompanionDataDir    string
	CompanionBinary     string
	CompanionChatEffort string
	// CompanionTrace turns on the full-content companion trace (NIX_COMPANION_TRACE); see
	// companion/diagnostics.go. Off by default: it writes prompts and workspace content to disk.
	CompanionTrace          bool
	Address                 string
	InternalSecret          string
	MaxInputBytes           int64
	MaxLineBytes            int
	MaxRecords              int
	RequestTimeout          time.Duration
	InternalAPIURL          string
	CollaborationURL        string
	PollInterval            time.Duration
	WorkerID                string
	MaxConcurrency          int
	RabbitMQURL             string
	WorkerRoles             string
	LeaseDuration           time.Duration
	RenewInterval           time.Duration
	MaxMessageBytes         int
	ObjectOrigins           []string
	PluginMaxModuleBytes    int64
	PluginMemoryPages       int
	PluginTimeout           time.Duration
	PluginMaxHostCalls      int
	CalendarGoogleOrigin    string
	CalendarMicrosoftOrigin string
}

func Load(getenv func(string) string) (Settings, error) {
	maxInputBytes, err := parseInt64(getenv("NIX_WORKER_MAX_INPUT_BYTES"), 100*1024*1024)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_WORKER_MAX_INPUT_BYTES: %w", err)
	}
	maxLineBytes, err := parseInt(getenv("NIX_WORKER_MAX_LINE_BYTES"), 4*1024*1024)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_WORKER_MAX_LINE_BYTES: %w", err)
	}
	maxRecords, err := parseInt(getenv("NIX_WORKER_MAX_RECORDS"), 100_000)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_WORKER_MAX_RECORDS: %w", err)
	}
	requestTimeoutSeconds, err := parseInt(getenv("NIX_WORKER_REQUEST_TIMEOUT_SECONDS"), 60)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_WORKER_REQUEST_TIMEOUT_SECONDS: %w", err)
	}
	pollSeconds, err := parseInt(getenv("NIX_WORKER_POLL_INTERVAL_SECONDS"), 5)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_WORKER_POLL_INTERVAL_SECONDS: %w", err)
	}
	maxConcurrency, err := parseInt(getenv("NIX_WORKER_MAX_CONCURRENCY"), 4)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_WORKER_MAX_CONCURRENCY: %w", err)
	}
	leaseSeconds, err := parseInt(getenv("NIX_WORKER_LEASE_SECONDS"), 60)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_WORKER_LEASE_SECONDS: %w", err)
	}
	renewSeconds, err := parseInt(getenv("NIX_WORKER_RENEW_SECONDS"), 15)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_WORKER_RENEW_SECONDS: %w", err)
	}
	maxMessageBytes, err := parseInt(getenv("NIX_WORKER_MAX_MESSAGE_BYTES"), 64*1024)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_WORKER_MAX_MESSAGE_BYTES: %w", err)
	}
	objectOrigins, err := parseOrigins(getenv("NIX_WORKER_OBJECT_ORIGINS"))
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_WORKER_OBJECT_ORIGINS: %w", err)
	}
	pluginMaxModuleBytes, err := parseInt64(getenv("NIX_PLUGIN_MAX_MODULE_BYTES"), 8<<20)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_PLUGIN_MAX_MODULE_BYTES: %w", err)
	}
	pluginMemoryPages, err := parseInt(getenv("NIX_PLUGIN_MEMORY_PAGES"), 1024)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_PLUGIN_MEMORY_PAGES: %w", err)
	}
	pluginTimeoutMilliseconds, err := parseInt(getenv("NIX_PLUGIN_TIMEOUT_MILLISECONDS"), 250)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_PLUGIN_TIMEOUT_MILLISECONDS: %w", err)
	}
	pluginMaxHostCalls, err := parseInt(getenv("NIX_PLUGIN_MAX_HOST_CALLS"), 32)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_PLUGIN_MAX_HOST_CALLS: %w", err)
	}
	settings := Settings{
		CompanionDataDir:        getenv("NIX_COMPANION_DATA_DIR"),
		CompanionBinary:         valueOr(getenv("NIX_COMPANION_BINARY"), "codex"),
		CompanionChatEffort:     valueOr(getenv("NIX_COMPANION_CHAT_EFFORT"), "low"),
		CompanionTrace:          getenv("NIX_COMPANION_TRACE") == "true" || getenv("NIX_COMPANION_TRACE") == "1",
		Address:                 valueOr(getenv("NIX_WORKER_ADDRESS"), ":8301"),
		InternalSecret:          getenv("NIX_WORKER_INTERNAL_SECRET"),
		MaxInputBytes:           maxInputBytes,
		MaxLineBytes:            maxLineBytes,
		MaxRecords:              maxRecords,
		RequestTimeout:          time.Duration(requestTimeoutSeconds) * time.Second,
		InternalAPIURL:          strings.TrimRight(getenv("NIX_WORKER_API_URL"), "/"),
		CollaborationURL:        strings.TrimRight(getenv("NIX_WORKER_COLLAB_URL"), "/"),
		PollInterval:            time.Duration(pollSeconds) * time.Second,
		WorkerID:                valueOr(getenv("NIX_WORKER_ID"), "go-worker"),
		MaxConcurrency:          maxConcurrency,
		RabbitMQURL:             getenv("NIX_RABBITMQ_URL"),
		WorkerRoles:             valueOr(getenv("NIX_WORKER_ROLES"), "import,export,plugin-events"),
		LeaseDuration:           time.Duration(leaseSeconds) * time.Second,
		RenewInterval:           time.Duration(renewSeconds) * time.Second,
		MaxMessageBytes:         maxMessageBytes,
		ObjectOrigins:           objectOrigins,
		PluginMaxModuleBytes:    pluginMaxModuleBytes,
		PluginMemoryPages:       pluginMemoryPages,
		PluginTimeout:           time.Duration(pluginTimeoutMilliseconds) * time.Millisecond,
		PluginMaxHostCalls:      pluginMaxHostCalls,
		CalendarGoogleOrigin:    valueOr(getenv("NIX_CALENDAR_GOOGLE_ORIGIN"), "https://www.googleapis.com"),
		CalendarMicrosoftOrigin: valueOr(getenv("NIX_CALENDAR_MICROSOFT_ORIGIN"), "https://graph.microsoft.com"),
	}
	if settings.MaxInputBytes <= 0 || settings.MaxLineBytes <= 0 || settings.MaxRecords <= 0 || settings.RequestTimeout <= 0 || settings.PollInterval <= 0 || settings.MaxConcurrency <= 0 || settings.MaxConcurrency > 100 || settings.LeaseDuration < 5*time.Second || settings.LeaseDuration > 300*time.Second || settings.RenewInterval <= 0 || settings.RenewInterval >= settings.LeaseDuration || settings.MaxMessageBytes <= 0 || settings.MaxMessageBytes > 64*1024 || settings.PluginMaxModuleBytes <= 0 || settings.PluginMaxModuleBytes > 32<<20 || settings.PluginMemoryPages <= 0 || settings.PluginMemoryPages > 4096 || settings.PluginTimeout <= 0 || settings.PluginTimeout > 5*time.Second || settings.PluginMaxHostCalls <= 0 || settings.PluginMaxHostCalls > 256 {
		return Settings{}, fmt.Errorf("worker limits and timeout must be positive")
	}
	return settings, nil
}

func parseOrigins(value string) ([]string, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		parsed, err := url.Parse(trimmed)
		if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" && parsed.Path != "/" || parsed.Scheme != "https" && parsed.Scheme != "http" {
			return nil, fmt.Errorf("%q is not an HTTP(S) origin", trimmed)
		}
		result = append(result, trimmed)
	}
	return result, nil
}

func valueOr(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func parseInt(value string, fallback int) (int, error) {
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, err
	}
	return parsed, nil
}

func parseInt64(value string, fallback int64) (int64, error) {
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, err
	}
	return parsed, nil
}
