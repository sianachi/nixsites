package config

import (
	"fmt"
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
	CompanionTrace bool
	Address        string
	InternalSecret string
	RequestTimeout time.Duration
	InternalAPIURL string
	PollInterval   time.Duration
	WorkerID       string
}

func Load(getenv func(string) string) (Settings, error) {
	requestTimeoutSeconds, err := parseInt(getenv("NIX_WORKER_REQUEST_TIMEOUT_SECONDS"), 60)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_WORKER_REQUEST_TIMEOUT_SECONDS: %w", err)
	}
	pollSeconds, err := parseInt(getenv("NIX_WORKER_POLL_INTERVAL_SECONDS"), 5)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_WORKER_POLL_INTERVAL_SECONDS: %w", err)
	}
	settings := Settings{
		CompanionDataDir:    getenv("NIX_COMPANION_DATA_DIR"),
		CompanionBinary:     valueOr(getenv("NIX_COMPANION_BINARY"), "codex"),
		CompanionChatEffort: valueOr(getenv("NIX_COMPANION_CHAT_EFFORT"), "low"),
		CompanionTrace:      getenv("NIX_COMPANION_TRACE") == "true" || getenv("NIX_COMPANION_TRACE") == "1",
		Address:             valueOr(getenv("NIX_WORKER_ADDRESS"), ":8301"),
		InternalSecret:      getenv("NIX_WORKER_INTERNAL_SECRET"),
		RequestTimeout:      time.Duration(requestTimeoutSeconds) * time.Second,
		InternalAPIURL:      strings.TrimRight(getenv("NIX_WORKER_API_URL"), "/"),
		PollInterval:        time.Duration(pollSeconds) * time.Second,
		WorkerID:            valueOr(getenv("NIX_WORKER_ID"), "go-worker"),
	}
	if settings.RequestTimeout <= 0 || settings.PollInterval <= 0 {
		return Settings{}, fmt.Errorf("worker timeout and poll interval must be positive")
	}
	return settings, nil
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
