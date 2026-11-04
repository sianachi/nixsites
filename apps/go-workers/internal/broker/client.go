package broker

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

type DeliveryAction int

const (
	Acknowledge DeliveryAction = iota
	Requeue
	Reject
)

type Handler func(context.Context, Envelope) DeliveryAction

type publisherChannel interface {
	PublishWithContext(context.Context, string, string, bool, bool, amqp.Publishing) error
	IsClosed() bool
	Close() error
}

type Client struct {
	url             string
	maxMessageBytes int
	logger          *slog.Logger
	consumerMu      sync.RWMutex
	activeConsumers map[string]int
	connectionMu    sync.Mutex
	connection      *amqp.Connection
	publishMu       sync.Mutex
	publisher       publisherChannel
	confirmations   <-chan amqp.Confirmation
	returns         <-chan amqp.Return
}

const requeueBackoff = time.Second

func New(url string, maxMessageBytes int, logger *slog.Logger) (*Client, error) {
	if url == "" || maxMessageBytes <= 0 || maxMessageBytes > 64*1024 || logger == nil {
		return nil, errors.New("broker configuration is invalid")
	}
	return &Client{
		url:             url,
		maxMessageBytes: maxMessageBytes,
		logger:          logger,
		activeConsumers: make(map[string]int),
	}, nil
}

func (client *Client) Close() error {
	client.publishMu.Lock()
	defer client.publishMu.Unlock()
	client.connectionMu.Lock()
	defer client.connectionMu.Unlock()
	if client.publisher != nil {
		_ = client.publisher.Close()
		client.publisher = nil
	}
	if client.connection != nil {
		err := client.connection.Close()
		client.connection = nil
		return err
	}
	return nil
}

func (client *Client) Ping(ctx context.Context) error {
	channel, err := client.channel(ctx)
	if err != nil {
		return err
	}
	return channel.Close()
}

func (client *Client) Consume(ctx context.Context, queue, consumerName string, prefetch int, handler Handler) error {
	if queue == "" || consumerName == "" || prefetch <= 0 || handler == nil {
		return errors.New("consumer configuration is invalid")
	}
	channel, err := client.channel(ctx)
	if err != nil {
		return err
	}
	defer channel.Close()
	if err := channel.Qos(prefetch, 0, false); err != nil {
		return fmt.Errorf("set broker prefetch: %w", err)
	}
	deliveries, err := channel.ConsumeWithContext(ctx, queue, consumerName, false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume %s: %w", queue, err)
	}
	client.consumerStarted(queue)
	defer client.consumerStopped(queue)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case delivery, ok := <-deliveries:
			if !ok {
				return errors.New("broker delivery channel closed")
			}
			envelope, parseErr := ParseEnvelope(delivery.Body, client.maxMessageBytes)
			if parseErr != nil {
				client.logger.Warn("broker message rejected", "queue", queue, "message_id", delivery.MessageId, "error", parseErr)
				if err := delivery.Reject(false); err != nil {
					return fmt.Errorf("reject invalid broker message: %w", err)
				}
				continue
			}
			action := handler(ctx, envelope)
			if action != Acknowledge && action != Reject {
				action = Requeue
			}
			if action == Requeue && !waitBeforeRequeue(ctx, requeueBackoff) {
				return ctx.Err()
			}
			switch action {
			case Acknowledge:
				err = delivery.Ack(false)
			case Requeue:
				err = delivery.Nack(false, true)
			case Reject:
				err = delivery.Reject(false)
			}
			if err != nil {
				return fmt.Errorf("settle broker delivery: %w", err)
			}
		}
	}
}

// ConsumerReady reports whether at least one server-accepted consumer is currently attached to
// the queue. A successful connection or channel probe alone is not enough to make a worker ready:
// permissions, queue topology, or basic.consume can still fail after those probes succeed.
func (client *Client) ConsumerReady(queue string) bool {
	client.consumerMu.RLock()
	defer client.consumerMu.RUnlock()
	return client.activeConsumers[queue] > 0
}

func (client *Client) consumerStarted(queue string) {
	client.consumerMu.Lock()
	defer client.consumerMu.Unlock()
	client.activeConsumers[queue]++
}

func (client *Client) consumerStopped(queue string) {
	client.consumerMu.Lock()
	defer client.consumerMu.Unlock()
	if client.activeConsumers[queue] <= 1 {
		delete(client.activeConsumers, queue)
		return
	}
	client.activeConsumers[queue]--
}

func waitBeforeRequeue(ctx context.Context, delay time.Duration) bool {
	if delay <= 0 {
		return true
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (client *Client) PublishResult(ctx context.Context, result WorkerResult) error {
	return client.publish(ctx, ResultsExchange, ResultRoutingKey, result.MessageID, result.JobID, result.MessageType, result.OccurredAt, "", true, result)
}

func (client *Client) NewMessageID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}

func (client *Client) publish(ctx context.Context, exchange, routingKey, messageID, correlationID, messageType string, occurredAt time.Time, expiration string, persistent bool, value any) error {
	client.publishMu.Lock()
	defer client.publishMu.Unlock()
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(body) > client.maxMessageBytes {
		return errors.New("worker result exceeds the broker message limit")
	}
	channel, err := client.publisherChannel(ctx)
	if err != nil {
		return err
	}
	deliveryMode := uint8(amqp.Transient)
	if persistent {
		deliveryMode = amqp.Persistent
	}
	if err := channel.PublishWithContext(ctx, exchange, routingKey, true, false, amqp.Publishing{
		ContentType:     "application/json",
		ContentEncoding: "utf-8",
		DeliveryMode:    deliveryMode,
		Expiration:      expiration,
		MessageId:       messageID,
		CorrelationId:   correlationID,
		Type:            messageType,
		Timestamp:       occurredAt,
		AppId:           "nix-worker",
		Body:            body,
	}); err != nil {
		client.resetPublisher()
		return fmt.Errorf("publish broker message: %w", err)
	}
	select {
	case returned := <-client.returns:
		client.resetPublisher()
		return fmt.Errorf("broker message was unroutable: %s", returned.ReplyText)
	case confirmation := <-client.confirmations:
		if !confirmation.Ack {
			client.resetPublisher()
			return errors.New("broker message was not confirmed")
		}
		// A mandatory unroutable publish is returned before its positive publisher confirmation.
		// Check the buffered return after the ack so select cannot report a false success.
		select {
		case returned := <-client.returns:
			client.resetPublisher()
			return fmt.Errorf("broker message was unroutable: %s", returned.ReplyText)
		default:
		}
		return nil
	case <-ctx.Done():
		client.resetPublisher()
		return ctx.Err()
	}
}

func (client *Client) channel(ctx context.Context) (*amqp.Channel, error) {
	connection, err := client.open(ctx)
	if err != nil {
		return nil, err
	}
	channel, err := connection.Channel()
	if err != nil {
		client.dropConnection(connection)
		return nil, fmt.Errorf("open broker channel: %w", err)
	}
	return channel, nil
}

func (client *Client) publisherChannel(ctx context.Context) (publisherChannel, error) {
	if client.publisher != nil && !client.publisher.IsClosed() {
		return client.publisher, nil
	}
	channel, err := client.channel(ctx)
	if err != nil {
		return nil, err
	}
	if err := channel.Confirm(false); err != nil {
		_ = channel.Close()
		return nil, fmt.Errorf("enable publisher confirms: %w", err)
	}
	client.publisher = channel
	client.confirmations = channel.NotifyPublish(make(chan amqp.Confirmation, 1))
	client.returns = channel.NotifyReturn(make(chan amqp.Return, 1))
	return channel, nil
}

func (client *Client) resetPublisher() {
	if client.publisher != nil {
		_ = client.publisher.Close()
	}
	client.publisher = nil
	client.confirmations = nil
	client.returns = nil
}

func (client *Client) open(ctx context.Context) (*amqp.Connection, error) {
	client.connectionMu.Lock()
	defer client.connectionMu.Unlock()
	if client.connection != nil && !client.connection.IsClosed() {
		return client.connection, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	connection, err := amqp.DialConfig(client.url, amqp.Config{
		Heartbeat: 30 * time.Second,
		Locale:    "en_US",
		Dial:      amqp.DefaultDial(10 * time.Second),
		Properties: amqp.Table{
			"connection_name": "nix-worker",
		},
	})
	if err != nil {
		return nil, fmt.Errorf("connect to RabbitMQ: %w", err)
	}
	client.connection = connection
	return connection, nil
}

func (client *Client) dropConnection(connection *amqp.Connection) {
	client.connectionMu.Lock()
	defer client.connectionMu.Unlock()
	if client.connection == connection {
		_ = client.connection.Close()
		client.connection = nil
	}
}
