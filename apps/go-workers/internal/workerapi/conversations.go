package workerapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
)

func (client *Client) ExecuteConversationTool(ctx context.Context, conversationID, tenantID, principalID, requestID string, arguments json.RawMessage) (string, bool, bool, error) {
	if !broker.IsCanonicalUUID(conversationID) || !broker.IsCanonicalUUID(tenantID) || !broker.IsCanonicalUUID(principalID) || !broker.IsCanonicalUUID(requestID) || !json.Valid(arguments) || len(arguments) > 40000 {
		return "", false, false, errors.New("invalid conversation tool request")
	}
	body, err := json.Marshal(struct {
		TenantID    string          `json:"tenantId"`
		PrincipalID string          `json:"principalId"`
		RequestID   string          `json:"requestId"`
		Arguments   json.RawMessage `json:"arguments"`
	}{tenantID, principalID, requestID, arguments})
	if err != nil {
		return "", false, false, err
	}
	var result struct {
		Success       bool   `json:"success"`
		Result        string `json:"result"`
		LockedContent bool   `json:"lockedContent"`
	}
	err = client.requestStrictJSON(ctx, http.MethodPost, "/internal/conversations/"+url.PathEscape(conversationID)+"/tools", bytes.NewReader(body), &result, 256<<10)
	if len(result.Result) > 128000 {
		return "", false, false, ErrResponseTooLarge
	}
	return result.Result, result.Success, result.LockedContent, err
}
