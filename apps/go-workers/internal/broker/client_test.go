package broker

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

type testPublisherChannel struct {
	publish func(context.Context, string, string, bool, bool, amqp.Publishing) error
	closed  bool
}

func (channel *testPublisherChannel) PublishWithContext(ctx context.Context, exchange, key string, mandatory, immediate bool, publishing amqp.Publishing) error {
	return channel.publish(ctx, exchange, key, mandatory, immediate, publishing)
}

func (channel *testPublisherChannel) IsClosed() bool {
	return channel.closed
}

func (channel *testPublisherChannel) Close() error {
	channel.closed = true
	return nil
}

func newPublishTestClient(publisher *testPublisherChannel, confirmations chan amqp.Confirmation, returns chan amqp.Return) *Client {
	return &Client{
		maxMessageBytes: 1024,
		publisher:       publisher,
		confirmations:   confirmations,
		returns:         returns,
	}
}

func publishTestValue() map[string]string {
	return map[string]string{"status": "complete"}
}

func TestPublishConfirmationPaths(t *testing.T) {
	tests := []struct {
		name              string
		confirmations     chan amqp.Confirmation
		returns           chan amqp.Return
		context           func() (context.Context, context.CancelFunc)
		wantError         error
		wantErrorContains string
		wantPublisherOpen bool
	}{
		{
			name: "ack",
			confirmations: func() chan amqp.Confirmation {
				confirmations := make(chan amqp.Confirmation, 1)
				confirmations <- amqp.Confirmation{Ack: true}
				return confirmations
			}(),
			returns:           make(chan amqp.Return, 1),
			context:           func() (context.Context, context.CancelFunc) { return context.WithCancel(t.Context()) },
			wantPublisherOpen: true,
		},
		{
			name: "nack",
			confirmations: func() chan amqp.Confirmation {
				confirmations := make(chan amqp.Confirmation, 1)
				confirmations <- amqp.Confirmation{Ack: false}
				return confirmations
			}(),
			returns:           make(chan amqp.Return, 1),
			context:           func() (context.Context, context.CancelFunc) { return context.WithCancel(t.Context()) },
			wantErrorContains: "not confirmed",
		},
		{
			name:          "unroutable return",
			confirmations: make(chan amqp.Confirmation, 1),
			returns: func() chan amqp.Return {
				returns := make(chan amqp.Return, 1)
				returns <- amqp.Return{ReplyText: "no route"}
				return returns
			}(),
			context:           func() (context.Context, context.CancelFunc) { return context.WithCancel(t.Context()) },
			wantErrorContains: "unroutable: no route",
		},
		{
			name:          "cancelled",
			confirmations: make(chan amqp.Confirmation, 1),
			returns:       make(chan amqp.Return, 1),
			context: func() (context.Context, context.CancelFunc) {
				ctx, cancel := context.WithCancel(t.Context())
				cancel()
				return ctx, cancel
			},
			wantError: context.Canceled,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			publisher := &testPublisherChannel{
				publish: func(context.Context, string, string, bool, bool, amqp.Publishing) error {
					return nil
				},
			}
			client := newPublishTestClient(publisher, test.confirmations, test.returns)
			ctx, cancel := test.context()
			defer cancel()

			err := client.publish(ctx, "exchange", "route", "message", "correlation", "type", time.Now(), "", false, publishTestValue())
			if test.wantError != nil {
				if !errors.Is(err, test.wantError) {
					t.Fatalf("publish error = %v, want %v", err, test.wantError)
				}
			} else if test.wantErrorContains != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErrorContains) {
					t.Fatalf("publish error = %v, want containing %q", err, test.wantErrorContains)
				}
			} else if err != nil {
				t.Fatalf("publish error = %v, want nil", err)
			}

			if test.wantPublisherOpen {
				if client.publisher != publisher || publisher.closed {
					t.Fatal("ack reset the publisher")
				}
				return
			}
			if client.publisher != nil || client.confirmations != nil || client.returns != nil || !publisher.closed {
				t.Fatal("failed publish did not reset the publisher")
			}
		})
	}
}

func TestConsumerReadinessTracksEveryActiveSlot(t *testing.T) {
	client := &Client{activeConsumers: make(map[string]int)}

	if client.ConsumerReady(PluginEventsQueue) {
		t.Fatal("queue was ready before a consumer was accepted")
	}
	client.consumerStarted(PluginEventsQueue)
	client.consumerStarted(PluginEventsQueue)
	if !client.ConsumerReady(PluginEventsQueue) {
		t.Fatal("queue was not ready with active consumers")
	}
	client.consumerStopped(PluginEventsQueue)
	if !client.ConsumerReady(PluginEventsQueue) {
		t.Fatal("one stopped slot hid another active consumer")
	}
	client.consumerStopped(PluginEventsQueue)
	if client.ConsumerReady(PluginEventsQueue) {
		t.Fatal("queue remained ready after its last consumer stopped")
	}
}

func TestRequeueBackoffIsShortBoundedAndCancellable(t *testing.T) {
	if requeueBackoff < 100*time.Millisecond || requeueBackoff > 2*time.Second {
		t.Fatalf("requeue backoff is outside the short bounded range: %s", requeueBackoff)
	}

	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	started := time.Now()
	if waitBeforeRequeue(ctx, requeueBackoff) {
		t.Fatal("cancelled requeue wait completed as ready")
	}
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("cancelled requeue wait took too long: %s", elapsed)
	}

	if !waitBeforeRequeue(t.Context(), time.Millisecond) {
		t.Fatal("live requeue wait was cancelled")
	}
}
