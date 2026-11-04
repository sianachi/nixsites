package runtime

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
	"github.com/sianachi/Nix/apps/go-workers/internal/config"
	"github.com/sianachi/Nix/apps/go-workers/internal/role"
)

func TestBrokerWorkersRequireAuthenticatedDependencies(t *testing.T) {
	for _, service := range []role.Service{role.Plugin} {
		roles := role.Set{service: true}
		if err := validateSettings(roles, config.Settings{}); err == nil {
			t.Fatalf("%s accepted an empty internal credential", service)
		}
		if err := validateSettings(roles, config.Settings{InternalAPIURL: "http://api", RabbitMQURL: "amqp://rabbit"}); err == nil {
			t.Fatalf("%s accepted an empty internal secret", service)
		}
		if err := validateSettings(roles, config.Settings{InternalAPIURL: "http://api", InternalSecret: "secret"}); err == nil {
			t.Fatalf("%s accepted an empty broker URL", service)
		}
		valid := config.Settings{InternalAPIURL: "http://api", InternalSecret: "secret", RabbitMQURL: "amqp://rabbit"}
		if service == role.Plugin {
			valid.ObjectOrigins = []string{"https://objects.example.test"}
		}
		if err := validateSettings(roles, valid); err != nil {
			t.Fatalf("%s rejected valid API configuration: %v", service, err)
		}
		withoutAPI := valid
		withoutAPI.InternalAPIURL = ""
		if err := validateSettings(roles, withoutAPI); err == nil {
			t.Fatalf("%s accepted a missing worker API URL", service)
		}
	}
}

func TestWorkerAPIRequiresAServiceOriginThatCannotCarrySecretsInItsURL(t *testing.T) {
	for _, target := range []string{
		"http://api.example.test",
		"https://user:password@api.example.test",
		"https://api.example.test/internal",
		"https://api.example.test?secret=value",
	} {
		settings := config.Settings{
			InternalAPIURL: target,
			InternalSecret: "secret",
			RabbitMQURL:    "amqp://rabbit",
		}
		if err := validateSettings(role.Set{role.Plugin: true}, settings); err == nil {
			t.Fatalf("worker accepted unsafe API target %q", target)
		}
	}
}

func TestServiceProbeRequiresAHealthyNonRedirectingDependency(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/healthz":
			response.WriteHeader(http.StatusNoContent)
		case "/redirect/healthz":
			http.Redirect(response, request, "/healthz", http.StatusTemporaryRedirect)
		default:
			response.WriteHeader(http.StatusServiceUnavailable)
		}
	}))
	defer server.Close()

	if err := newServiceProbe(server.URL, time.Second).Ping(context.Background()); err != nil {
		t.Fatalf("healthy dependency was refused: %v", err)
	}
	if err := newServiceProbe(server.URL+"/redirect", time.Second).Ping(context.Background()); err == nil {
		t.Fatal("redirecting dependency was accepted")
	}
	if err := newServiceProbe(server.URL+"/missing", time.Second).Ping(context.Background()); err == nil {
		t.Fatal("unhealthy dependency was accepted")
	}
}

func TestObjectStoreProbeAcceptsPrivateRefusalButRejectsRedirectAndOutage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/private/":
			response.WriteHeader(http.StatusForbidden)
		case "/redirect/":
			http.Redirect(response, request, "/private/", http.StatusTemporaryRedirect)
		default:
			response.WriteHeader(http.StatusServiceUnavailable)
		}
	}))
	defer server.Close()

	if err := newObjectStoreProbe([]string{server.URL + "/private"}, time.Second).Ping(context.Background()); err != nil {
		t.Fatalf("reachable private object storage was refused: %v", err)
	}
	if err := newObjectStoreProbe([]string{server.URL + "/redirect"}, time.Second).Ping(context.Background()); err == nil {
		t.Fatal("redirecting object storage was accepted")
	}
	if err := newObjectStoreProbe([]string{server.URL + "/outage"}, time.Second).Ping(context.Background()); err == nil {
		t.Fatal("unavailable object storage was accepted")
	}
	if err := newObjectStoreProbe(nil, time.Second).Ping(context.Background()); err == nil {
		t.Fatal("an empty object-storage origin set was accepted")
	}
}

func TestCombinedWorkerParsesConfiguredRoles(t *testing.T) {
	roles, err := selectedRoles(role.All, "plugin-events")
	if err != nil {
		t.Fatal(err)
	}
	if !roles.Has(role.Plugin) {
		t.Fatalf("configured roles were not preserved: %#v", roles)
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

func TestReadinessRequiresAnActiveConsumerForEveryEnabledRole(t *testing.T) {
	consumers := map[string]bool{
		broker.PluginEventsQueue: false,
	}
	state := newReadinessState(
		role.Set{role.Plugin: true},
		func(queue string) bool { return consumers[queue] },
	)
	state.api.Store(true)
	state.rabbit.Store(true)
	state.objects.Store(true)

	if state.RoleReady(role.Plugin) {
		t.Fatal("plugin role was ready without an active consumer")
	}
	if state.AllReady() {
		t.Fatal("worker was ready while its role had no consumer")
	}
	consumers[broker.PluginEventsQueue] = true
	if !state.RoleReady(role.Plugin) || !state.AllReady() {
		t.Fatal("plugin role was not ready with healthy dependencies and an active consumer")
	}
}

func TestHealthcheckUsesReadyzAndRefusesRedirects(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/readyz":
			response.WriteHeader(http.StatusOK)
		case "/redirect/readyz":
			http.Redirect(response, request, "/readyz", http.StatusTemporaryRedirect)
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	if err := checkReadiness(server.URL[len("http://"):], time.Second); err != nil {
		t.Fatalf("ready worker was refused: %v", err)
	}
	if err := checkReadiness(server.URL[len("http://"):]+"/redirect", time.Second); err == nil {
		t.Fatal("redirecting readiness endpoint was accepted")
	}
}
