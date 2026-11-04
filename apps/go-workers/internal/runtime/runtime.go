package runtime

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/companion"
	"github.com/sianachi/Nix/apps/go-workers/internal/config"
	"github.com/sianachi/Nix/apps/go-workers/internal/httpserver"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

// Run hosts the pet companion behind the internal HTTP server. Every job role moved into Core
// (backend/src/Nix.Workers); this process keeps no broker connection and no job loop.
func Run() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	settings, err := config.Load(os.Getenv)
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	if err := validateSettings(settings); err != nil {
		logger.Error("invalid service configuration", "error", err)
		os.Exit(1)
	}
	if len(os.Args) == 2 && os.Args[1] == "--healthcheck" {
		if readinessErr := checkReadiness(settings.Address, 3*time.Second); readinessErr != nil {
			os.Exit(1)
		}
		return
	}

	apiClient := workerapi.New(settings.InternalAPIURL, settings.InternalSecret, settings.WorkerID, settings.RequestTimeout)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	var companionHandler http.Handler
	if settings.CompanionDataDir != "" {
		manager, companionErr := companion.New(ctx, companion.Options{
			Root:                    settings.CompanionDataDir,
			ExecuteConversationTool: apiClient.ExecuteConversationTool,
			Binary:                  settings.CompanionBinary,
			ChatEffort:              settings.CompanionChatEffort,
			Trace:                   settings.CompanionTrace,
			Logger:                  logger,
		})
		if companionErr != nil {
			logger.Error("companion storage configuration failed")
			os.Exit(1)
		}
		defer manager.Close()
		companionHandler = manager
	}
	var apiReady atomic.Bool
	go probeDependency(ctx, "Nix.Api", apiClient, &apiReady, settings.PollInterval, logger)
	server := httpserver.New(httpserver.Dependencies{
		Logger:         logger,
		InternalSecret: settings.InternalSecret,
		RequestTimeout: settings.RequestTimeout,
		Ready:          apiReady.Load,
		Companion:      companionHandler,
	})
	httpServer := &http.Server{
		Addr:              settings.Address,
		Handler:           server,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       settings.RequestTimeout,
		WriteTimeout:      settings.RequestTimeout,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	serverFailures := make(chan error, 1)
	go func() {
		logger.Info("companion host listening", "address", settings.Address)
		if serveErr := httpServer.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			logger.Error("server stopped unexpectedly", "error", serveErr)
			serverFailures <- serveErr
			stop()
		}
	}()

	<-ctx.Done()
	shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownContext); err != nil {
		logger.Error("server shutdown failed", "error", err)
		os.Exit(1)
	}
	select {
	case <-serverFailures:
		// A listener failure is fatal even though the coordinated shutdown itself succeeded.
		// Returning zero here made IDEs report an early clean exit and hid port collisions.
		os.Exit(1)
	default:
	}
	logger.Info("companion host stopped")
}

func validateSettings(settings config.Settings) error {
	if settings.InternalSecret == "" {
		return errors.New("NIX_WORKER_INTERNAL_SECRET is required")
	}
	if !validServiceOrigin(settings.InternalAPIURL) {
		return errors.New("NIX_WORKER_API_URL must be a valid Nix.Api service origin")
	}
	return nil
}

func validServiceOrigin(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	return err == nil &&
		parsed.Host != "" &&
		parsed.User == nil &&
		parsed.RawQuery == "" &&
		parsed.Fragment == "" &&
		(parsed.Path == "" || parsed.Path == "/") &&
		(parsed.Scheme == "https" ||
			parsed.Scheme == "http" && (parsed.IsAbs() && (!strings.Contains(parsed.Hostname(), ".") || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1")))
}

func readinessURL(address string) string {
	if len(address) > 0 && address[0] == ':' {
		return "http://127.0.0.1" + address + "/readyz"
	}
	return "http://" + address + "/readyz"
}

func checkReadiness(address string, timeout time.Duration) error {
	client := &http.Client{
		Timeout: timeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	request, err := http.NewRequest(http.MethodGet, readinessURL(address), nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
	closeErr := response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("worker readiness returned %s", response.Status)
	}
	return closeErr
}

type dependencyProbe interface {
	Ping(context.Context) error
}

func probeDependency(ctx context.Context, name string, probe dependencyProbe, ready *atomic.Bool, interval time.Duration, logger *slog.Logger) {
	check := func(first bool) {
		probeContext, cancel := context.WithTimeout(ctx, min(interval, 5*time.Second))
		err := probe.Ping(probeContext)
		cancel()
		wasReady := ready.Swap(err == nil)
		if err != nil && (first || wasReady) && ctx.Err() == nil {
			logger.Warn("dependency readiness failed", "dependency", name, "error", err)
		}
	}
	check(true)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			ready.Store(false)
			return
		case <-ticker.C:
			check(false)
		}
	}
}
