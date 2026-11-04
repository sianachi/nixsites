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
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
	"github.com/sianachi/Nix/apps/go-workers/internal/companion"
	"github.com/sianachi/Nix/apps/go-workers/internal/config"
	"github.com/sianachi/Nix/apps/go-workers/internal/httpserver"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/pluginruntime"
	"github.com/sianachi/Nix/apps/go-workers/internal/pluginworker"
	"github.com/sianachi/Nix/apps/go-workers/internal/role"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

func Run(service role.Service) {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	settings, err := config.Load(os.Getenv)
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	roles, err := selectedRoles(service, settings.WorkerRoles)
	if err != nil {
		logger.Error("invalid worker roles", "error", err)
		os.Exit(1)
	}
	if os.Getenv("NIX_WORKER_ADDRESS") == "" {
		settings.Address = ":8301"
	}
	if err := validateSettings(roles, settings); err != nil {
		logger.Error("invalid service configuration", "roles", settings.WorkerRoles, "error", err)
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
	brokerClient, err := broker.New(settings.RabbitMQURL, settings.MaxMessageBytes, logger)
	if err != nil {
		logger.Error("broker configuration failed", "error", err)
		os.Exit(1)
	}
	defer func() {
		if closeErr := brokerClient.Close(); closeErr != nil {
			logger.Warn("broker close failed", "error", closeErr)
		}
	}()
	readiness := newReadinessState(roles, brokerClient.ConsumerReady)
	serverRole := role.All
	if len(roles) == 1 {
		for enabled := range roles {
			serverRole = enabled
		}
	}
	server := httpserver.NewForRole(serverRole, httpserver.Dependencies{
		Logger:         logger,
		InternalSecret: settings.InternalSecret,
		MaxInputSize:   settings.MaxInputBytes,
		MaxRecords:     settings.MaxRecords,
		MaxLineBytes:   settings.MaxLineBytes,
		RequestTimeout: settings.RequestTimeout,
		Ready:          readiness.AllReady,
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

	var objectProbe *objectStoreProbe
	if roles.Has(role.Plugin) {
		objectProbe = newObjectStoreProbe(settings.ObjectOrigins, settings.RequestTimeout)
	}
	var apiProbe *workerapi.Client
	if settings.InternalAPIURL != "" {
		apiProbe = apiClient
	}
	startReadinessProbes(ctx, apiProbe, brokerClient, objectProbe, readiness, settings.PollInterval, logger)
	if roles.Has(role.Plugin) {
		pluginRuntime, runtimeErr := pluginruntime.New(pluginruntime.Limits{
			MaxModuleBytes:       int(settings.PluginMaxModuleBytes),
			MaxEventBytes:        settings.MaxMessageBytes,
			MaxHostRequestBytes:  64 << 10,
			MaxHostResponseBytes: 256 << 10,
			MaxHostCalls:         settings.PluginMaxHostCalls,
			MemoryLimitPages:     uint32(settings.PluginMemoryPages),
			ExecutionTimeout:     settings.PluginTimeout,
		})
		if runtimeErr != nil {
			logger.Error("plugin sandbox configuration failed", "error", runtimeErr)
			os.Exit(1)
		}
		worker, workerErr := pluginworker.New(
			apiClient,
			objecttransfer.New(settings.RequestTimeout, settings.ObjectOrigins...),
			pluginRuntime,
			settings.PluginMaxModuleBytes,
			settings.LeaseDuration,
			settings.PollInterval,
			logger,
		)
		if workerErr != nil {
			logger.Error("plugin event worker configuration failed", "error", workerErr)
			os.Exit(1)
		}
		runner, runnerErr := pluginworker.NewRunner(brokerClient, worker, settings.WorkerID, settings.MaxConcurrency, settings.PollInterval, logger)
		if runnerErr != nil {
			logger.Error("plugin event runner configuration failed", "error", runnerErr)
			os.Exit(1)
		}
		go runner.Run(ctx)
	}
	serverFailures := make(chan error, 1)
	go func() {
		logger.Info("go worker listening", "address", settings.Address, "roles", settings.WorkerRoles)
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
	logger.Info("go worker stopped", "roles", settings.WorkerRoles)
}

func selectedRoles(service role.Service, configured string) (role.Set, error) {
	if service == role.All {
		return role.Parse(configured)
	}
	return role.Set{service: true}, nil
}

func validateSettings(roles role.Set, settings config.Settings) error {
	if len(roles) == 0 {
		return errors.New("at least one worker role is required")
	}
	if settings.InternalSecret == "" {
		return errors.New("NIX_WORKER_INTERNAL_SECRET is required")
	}
	if !validServiceOrigin(settings.InternalAPIURL) {
		return errors.New("NIX_WORKER_API_URL must be a valid Nix.Api service origin for every enabled role")
	}
	if settings.RabbitMQURL == "" {
		return errors.New("NIX_RABBITMQ_URL is required")
	}
	if roles.Has(role.Plugin) {
		if len(settings.ObjectOrigins) == 0 {
			return errors.New("NIX_WORKER_OBJECT_ORIGINS is required for plugins")
		}
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

func workerInstanceID(workerID string) string {
	host, err := os.Hostname()
	if err != nil || strings.TrimSpace(host) == "" {
		host = "unknown-host"
	}
	instance := strings.TrimSpace(workerID) + ":" + host + ":" + strconv.Itoa(os.Getpid())
	if len(instance) > 128 {
		return instance[:128]
	}
	return instance
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

type serviceProbe struct {
	url    string
	client *http.Client
}

type objectStoreProbe struct {
	urls   []string
	client *http.Client
}

func newObjectStoreProbe(origins []string, timeout time.Duration) *objectStoreProbe {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	urls := make([]string, 0, len(origins))
	for _, origin := range origins {
		urls = append(urls, strings.TrimRight(origin, "/")+"/")
	}
	return &objectStoreProbe{
		urls: urls,
		client: &http.Client{
			Timeout:       timeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
			Transport:     transport,
		},
	}
}

func newServiceProbe(origin string, timeout time.Duration) *serviceProbe {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	return &serviceProbe{
		url: strings.TrimRight(origin, "/") + "/healthz",
		client: &http.Client{
			Timeout:       timeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
			Transport:     transport,
		},
	}
}

func (probe *serviceProbe) Ping(ctx context.Context) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, probe.url, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	response, err := probe.client.Do(request)
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
	closeErr := response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("dependency health check returned %s", response.Status)
	}
	return closeErr
}

func (probe *objectStoreProbe) Ping(ctx context.Context) error {
	if probe == nil || len(probe.urls) == 0 {
		return errors.New("object storage readiness has no configured origin")
	}
	for _, endpoint := range probe.urls {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return err
		}
		request.Header.Set("Accept", "application/xml, application/json")
		request.Header.Set("Range", "bytes=0-0")
		response, err := probe.client.Do(request)
		if err != nil {
			return err
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
		closeErr := response.Body.Close()
		// Private S3-compatible stores normally answer an anonymous root request with 401 or 403.
		// That is a useful readiness result: workers deliberately hold no long-lived storage
		// credential, and use a signed capability only after they lease a job.
		if response.StatusCode < 200 || response.StatusCode >= 500 || response.StatusCode/100 == 3 {
			return fmt.Errorf("object storage readiness returned %s", response.Status)
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

type dependencyProbe interface {
	Ping(context.Context) error
}

type readinessState struct {
	roles         role.Set
	consumerReady func(string) bool
	api           atomic.Bool
	rabbit        atomic.Bool
	objects       atomic.Bool
}

func newReadinessState(roles role.Set, consumerReady func(string) bool) *readinessState {
	return &readinessState{roles: roles, consumerReady: consumerReady}
}

func (state *readinessState) RoleReady(service role.Service) bool {
	if state == nil || !state.roles.Has(service) || !state.api.Load() || !state.rabbit.Load() || state.consumerReady == nil || !state.consumerReady(queueForRole(service)) {
		return false
	}
	switch service {
	case role.Plugin:
		return state.objects.Load()
	default:
		return false
	}
}

func (state *readinessState) AllReady() bool {
	if state == nil || len(state.roles) == 0 {
		return false
	}
	for service := range state.roles {
		if !state.RoleReady(service) {
			return false
		}
	}
	return true
}

func queueForRole(service role.Service) string {
	switch service {
	case role.Plugin:
		return broker.PluginEventsQueue
	default:
		return ""
	}
}

func startReadinessProbes(
	ctx context.Context,
	api *workerapi.Client,
	rabbit *broker.Client,
	objects *objectStoreProbe,
	state *readinessState,
	interval time.Duration,
	logger *slog.Logger,
) {
	go probeDependency(ctx, "Nix.Api", api, &state.api, interval, logger)
	go probeDependency(ctx, "RabbitMQ", rabbit, &state.rabbit, interval, logger)
	if state.roles.Has(role.Plugin) {
		go probeDependency(ctx, "object storage", objects, &state.objects, interval, logger)
	}
}

func probeDependency(ctx context.Context, name string, probe dependencyProbe, ready *atomic.Bool, interval time.Duration, logger *slog.Logger) {
	check := func(first bool) {
		if probe == nil {
			ready.Store(false)
			if first {
				logger.Warn("worker dependency readiness failed", "dependency", name, "error", "dependency probe is not configured")
			}
			return
		}
		probeContext, cancel := context.WithTimeout(ctx, min(interval, 5*time.Second))
		err := probe.Ping(probeContext)
		cancel()
		wasReady := ready.Swap(err == nil)
		if err != nil && (first || wasReady) && ctx.Err() == nil {
			logger.Warn("worker dependency readiness failed", "dependency", name, "error", err)
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
