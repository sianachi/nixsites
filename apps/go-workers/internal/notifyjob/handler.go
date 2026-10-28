// Package notifyjob implements the "notify" role's notify.push job: fetch a
// notification's rendered payload and subscriptions from N1, encrypt and sign
// a Web Push message per subscription, deliver it, and report outcomes back
// through N1's results call (ADR-0051 section 5 and 7).
package notifyjob

import (
	"context"
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/webpush"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

var Kinds = []string{"notify.push"}

// pushTTLSeconds is the "TTL" header sent with every push message: the push
// service may hold an undelivered message this long before discarding it.
const pushTTLSeconds = 86400

// maxConcurrentPushes bounds simultaneous sends per notification.
const maxConcurrentPushes = 8

type Payload struct {
	NotificationID string `json:"notificationId"`
}

type Result struct {
	NotificationID string `json:"notificationId"`
	Delivered      int    `json:"delivered"`
	Gone           int    `json:"gone"`
	Failed         int    `json:"failed"`
}

// Transport is the push-service HTTP transport notifyjob sends encrypted
// messages through. internal/pushtransport implements it; tests use a fake.
type Transport interface {
	Send(ctx context.Context, endpoint string, headers map[string]string, body []byte) (int, error)
}

// API is the subset of workerapi.Client notifyjob depends on.
type API interface {
	GetNotificationDelivery(ctx context.Context, notificationID string) (*workerapi.NotificationDelivery, error)
	ReportNotificationDeliveryResults(ctx context.Context, notificationID string, results []workerapi.NotificationDeliveryResult) error
}

type Handler struct {
	api        API
	transport  Transport
	privateKey *ecdsa.PrivateKey
	subject    string
	now        func() time.Time
}

func New(api API, transport Transport, privateKey *ecdsa.PrivateKey, subject string) *Handler {
	return &Handler{api: api, transport: transport, privateKey: privateKey, subject: subject, now: time.Now}
}

func (handler *Handler) Handle(ctx context.Context, job workerapi.Job) (any, error) {
	var payload Payload
	decoder := json.NewDecoder(strings.NewReader(string(job.Payload)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil || !validUUID(payload.NotificationID) {
		return nil, failure("notify_payload_invalid", errors.New("the durable notify request is invalid"))
	}
	if job.Kind != "notify.push" {
		return nil, failure("notify_kind_mismatch", errors.New("job kind does not match notify.push"))
	}
	if handler.api == nil || handler.transport == nil || handler.privateKey == nil {
		return nil, failure("notify_configuration_invalid", errors.New("the notify worker is not configured"))
	}
	delivery, err := handler.api.GetNotificationDelivery(ctx, payload.NotificationID)
	if err != nil {
		return nil, transient("notify_delivery_unavailable", err)
	}
	if delivery == nil {
		return nil, failure("notify_delivery_invalid", errors.New("the notification delivery payload is invalid"))
	}
	plaintext, err := json.Marshal(delivery.Payload)
	if err != nil {
		return nil, failure("notify_payload_encode_failed", err)
	}
	result := Result{NotificationID: payload.NotificationID}
	results := make([]workerapi.NotificationDeliveryResult, len(delivery.Subscriptions))
	// Subscriptions are independent push services, so a slow one must not delay the rest;
	// results keep the subscription order.
	var group sync.WaitGroup
	slots := make(chan struct{}, maxConcurrentPushes)
	for index, subscription := range delivery.Subscriptions {
		slots <- struct{}{}
		group.Add(1)
		go func() {
			defer func() { <-slots; group.Done() }()
			status, httpStatus := handler.deliver(ctx, subscription, plaintext)
			results[index] = workerapi.NotificationDeliveryResult{SubscriptionID: subscription.ID, Status: status, HTTPStatus: httpStatus}
		}()
	}
	group.Wait()
	for _, delivered := range results {
		switch delivered.Status {
		case "delivered":
			result.Delivered++
		case "gone":
			result.Gone++
		default:
			result.Failed++
		}
	}
	if len(results) > 0 {
		if err := handler.report(ctx, payload.NotificationID, results); err != nil {
			return nil, transient("notify_results_unavailable", err)
		}
	}
	return result, nil
}

// report retries the results itself before failing the job: a failed job is retried from the
// top, and the retry would push to every device again.
func (handler *Handler) report(ctx context.Context, notificationID string, results []workerapi.NotificationDeliveryResult) error {
	var err error
	for attempt := range 3 {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return err
			case <-time.After(time.Duration(attempt) * 500 * time.Millisecond):
			}
		}
		if err = handler.api.ReportNotificationDeliveryResults(ctx, notificationID, results); err == nil {
			return nil
		}
	}
	return err
}

// deliver encrypts and sends one subscription's push message. Failures here
// are per-subscription outcomes, not job failures: a malformed or unreachable
// subscription must not block delivery to the notification's other
// subscriptions, so every error path returns "failed" rather than propagating.
func (handler *Handler) deliver(ctx context.Context, subscription workerapi.NotificationDeliverySubscription, plaintext []byte) (status string, httpStatus int) {
	p256dh, err := decodeBase64URL(subscription.P256dh)
	if err != nil {
		return "failed", 0
	}
	auth, err := decodeBase64URL(subscription.Auth)
	if err != nil {
		return "failed", 0
	}
	body, err := webpush.Encrypt(plaintext, p256dh, auth)
	if err != nil {
		return "failed", 0
	}
	authorization, err := webpush.VAPIDAuthorization(handler.privateKey, subscription.Endpoint, handler.subject, handler.now())
	if err != nil {
		return "failed", 0
	}
	headers := map[string]string{
		"Content-Type":     "application/octet-stream",
		"Content-Encoding": "aes128gcm",
		"TTL":              fmt.Sprint(pushTTLSeconds),
		"Urgency":          "normal",
		"Authorization":    authorization,
	}
	httpStatus, err = handler.transport.Send(ctx, subscription.Endpoint, headers, body)
	if err != nil {
		return "failed", 0
	}
	switch {
	case httpStatus == 404 || httpStatus == 410:
		return "gone", httpStatus
	case httpStatus >= 200 && httpStatus < 300:
		return "delivered", httpStatus
	default:
		return "failed", httpStatus
	}
}

func decodeBase64URL(value string) ([]byte, error) {
	trimmed := strings.TrimRight(value, "=")
	return base64.RawURLEncoding.DecodeString(trimmed)
}

func validUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for position, character := range value {
		if position == 8 || position == 13 || position == 18 || position == 23 {
			continue
		}
		if character < '0' || character > '9' && character < 'a' || character > 'f' {
			return false
		}
	}
	return value != "00000000-0000-0000-0000-000000000000"
}

func failure(code string, err error) error {
	return &jobrunner.JobError{Code: code, Detail: fmt.Sprintf("%s", err), Cause: err}
}

func transient(code string, err error) error {
	return &jobrunner.JobError{Code: code, Detail: fmt.Sprintf("%s", err), Cause: err, Retryable: true}
}
