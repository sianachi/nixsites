package companion

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"
	"unicode"
)

const maxToolCallsPerTurn = 20

type Model struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Default bool   `json:"default"`
	// SupportsTools is false only for a provider model that cannot call tools (some OpenRouter
	// models). Codex and Anthropic models all can; an absent value in a catalog reads as true.
	SupportsTools bool `json:"supportsTools"`
	// supportedEfforts and defaultEffort come from model/list's own
	// supportedReasoningEfforts[].reasoningEffort and defaultReasoningEffort (Codex 0.153.4);
	// json:"-" keeps the wire Model shape (what the web client already reads) unchanged.
	// effortFor uses these to decide whether a configured NIX_COMPANION_*_EFFORT value is one
	// this model actually advertises before sending it on turn/start.
	supportedEfforts []string `json:"-"`
	defaultEffort    string   `json:"-"`
	// textOnly marks a provider model that takes no image input (OpenRouter lists each model's
	// input modalities); a tool result's picture is left out for it.
	textOnly bool
}

func defaultModel(models []Model) Model {
	for _, model := range models {
		if model.Default {
			return model
		}
	}
	if len(models) > 0 {
		return models[0]
	}
	return Model{}
}

// ToolCall is a private, per-conversation approval receipt, not authorization.
// Only the user's ordinary Nix client executes tools; Core still authorizes every API call.
type ToolCall struct {
	ID        string `json:"id"`
	Arguments string `json:"arguments"`
	Status    string `json:"status"`
	Result    string `json:"result"`
	ClaimID   string `json:"claimId"`
	rpcID     json.RawMessage
	// pendingSince and claimedAt feed the per-turn timing log and tool events only.
	pendingSince time.Time
	claimedAt    time.Time
	waiters      []json.RawMessage
	// image is the picture the result carried, kept in memory for replies only.
	image string
}

type toolTransport interface {
	SetRequestHandler(func(json.RawMessage, string, json.RawMessage) bool)
	Reply(json.RawMessage, any) error
}

// flatToolArgs is the flat shape `@nix/companion`'s workspaceToolSchema and run.ts have always
// parsed, and the shape `ToolCall.Arguments` stores. flattenToolCall builds one from a typed
// nix_<operation> call's native-JSON arguments.
type flatToolArgs struct {
	Operation      string `json:"operation"`
	WorkspaceID    string `json:"workspaceId,omitempty"`
	ItemID         string `json:"itemId"`
	ParentID       string `json:"parentId"`
	Title          string `json:"title"`
	Markdown       string `json:"markdown"`
	Query          string `json:"query"`
	PropertiesJSON string `json:"propertiesJson"`
	SpecJSON       string `json:"specJson"`
}

// argKind says how one typed argument maps onto the flat shape.
type argKind int

const (
	argString     argKind = iota // copied verbatim into a flat string field
	argObjectJSON                // must be a JSON object; marshaled to a canonical JSON string
	// argSpecField is one string, boolean or object parameter that becomes a key of a specJson
	// object under its own name: nix_read_calendar's from/to, nix_complete_task's completed and
	// nix_run_action's path/params/body.
	// The flat shape gains no field; packages/structure-spec's SPEC_FIELD_PARAMETERS is the same
	// list on the TS side.
	argSpecField
)

// argMapping names one typed argument's flat field and kind.
type argMapping struct {
	flat string
	kind argKind
}

// toolArgSpecs mirrors packages/structure-spec/src/catalog/tools.ts's TOOL_BUILDS mapping table
// exactly (L1.1): which native-JSON arguments each nix_<operation> tool accepts, and which flat
// field each maps onto. Every "spec"/"blueprint"/"properties" argument marshals to specJson or
// propertiesJson; templateId maps to itemId, not a separate flat field, matching how run.ts
// already reads a template id (apply_template's itemId, read_template's itemId). The body edits
// reuse query for what they locate (a section's heading, a passage's find text) and markdown for
// what replaces it.
var toolArgSpecs = map[string]map[string]argMapping{
	"list_items":        {"parentId": {"parentId", argString}},
	"search":            {"query": {"query", argString}},
	"read_item":         {"itemId": {"itemId", argString}},
	"read_note":         {"itemId": {"itemId", argString}},
	"search_note":       {"itemId": {"itemId", argString}, "query": {"query", argString}},
	"remember":          {"fact": {"markdown", argString}},
	"read_structure":    {"itemId": {"itemId", argString}},
	"read_view":         {"itemId": {"itemId", argString}, "query": {"query", argObjectJSON}},
	"create_note":       {"title": {"title", argString}, "markdown": {"markdown", argString}, "parentId": {"parentId", argString}},
	"append_note":       {"itemId": {"itemId", argString}, "markdown": {"markdown", argString}},
	"replace_section":   {"itemId": {"itemId", argString}, "heading": {"query", argString}, "markdown": {"markdown", argString}},
	"replace_passage":   {"itemId": {"itemId", argString}, "find": {"query", argString}, "replace": {"markdown", argString}},
	"rename_item":       {"itemId": {"itemId", argString}, "title": {"title", argString}},
	"move_item":         {"itemId": {"itemId", argString}, "parentId": {"parentId", argString}, "destinationWorkspaceId": {"specJson", argSpecField}},
	"set_properties":    {"itemId": {"itemId", argString}, "properties": {"propertiesJson", argObjectJSON}},
	"trash_item":        {"itemId": {"itemId", argString}},
	"restore_item":      {"itemId": {"itemId", argString}},
	"create_structured": {"title": {"title", argString}, "spec": {"specJson", argObjectJSON}, "parentId": {"parentId", argString}},
	"add_view":          {"itemId": {"itemId", argString}, "spec": {"specJson", argObjectJSON}},
	"update_view":       {"itemId": {"itemId", argString}, "spec": {"specJson", argObjectJSON}},
	"create_entries":    {"parentId": {"parentId", argString}, "spec": {"specJson", argObjectJSON}},
	"edit_fields":       {"itemId": {"itemId", argString}, "spec": {"specJson", argObjectJSON}},
	"add_fields":        {"itemId": {"itemId", argString}, "spec": {"specJson", argObjectJSON}},
	"edit_form":         {"itemId": {"itemId", argString}, "spec": {"specJson", argObjectJSON}},
	"set_recurrence":    {"itemId": {"itemId", argString}, "spec": {"specJson", argObjectJSON}},
	"list_templates":    {"query": {"query", argString}},
	"read_template":     {"templateId": {"itemId", argString}},
	"apply_template":    {"templateId": {"itemId", argString}, "title": {"title", argString}, "parentId": {"parentId", argString}, "spec": {"specJson", argObjectJSON}},
	"build_blueprint":   {"blueprint": {"specJson", argObjectJSON}, "parentId": {"parentId", argString}},
	"save_as_template":  {"itemId": {"itemId", argString}, "title": {"title", argString}, "spec": {"specJson", argObjectJSON}},
	"read_calendar":     {"from": {"specJson", argSpecField}, "to": {"specJson", argSpecField}},
	"complete_task":     {"itemId": {"itemId", argString}, "completed": {"specJson", argSpecField}},
	"find_action":       {"query": {"query", argString}},
	"run_action":        {"actionId": {"query", argString}, "path": {"specJson", argSpecField}, "params": {"specJson", argSpecField}, "body": {"specJson", argSpecField}},
}

// flattenToolCall translates one typed nix_<operation> call's native-JSON arguments into the
// flat {operation, itemId, parentId, title, markdown, query, propertiesJson, specJson} shape
// @nix/companion/run.ts has always parsed, so Core, the OpenAPI contract, @nix/companion, nixctl
// and the web executor stay unchanged (L1 goal). tool must already be one of the conversation
// typed tool names (toolRequest checks that before calling this). On success it returns the flat
// arguments, marshaled, and an empty reason; on a malformed call it returns nil and a
// model-readable reason naming the offending key and tool, to be sent back exactly like a
// validateToolArguments failure ("No action ran and no approval was requested.").
func flattenToolCall(tool string, raw json.RawMessage) (json.RawMessage, string) {
	operation := operationFromToolName(tool)
	spec, ok := toolArgSpecs[operation]
	if !ok {
		return nil, fmt.Sprintf("%s is not a supported tool.", tool)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		return nil, fmt.Sprintf("%s requires a JSON object of arguments.", tool)
	}
	flat := flatToolArgs{Operation: operation}
	specFields := map[string]any{}
	for key, value := range fields {
		mapping, known := spec[key]
		if !known {
			return nil, fmt.Sprintf("%q is not a parameter of %s; it accepts %s.", key, tool, strings.Join(acceptedParams(spec), ", "))
		}
		switch mapping.kind {
		case argString:
			var text string
			if json.Unmarshal(value, &text) != nil {
				return nil, fmt.Sprintf("%s.%s must be a string.", tool, key)
			}
			if err := setFlatString(&flat, mapping.flat, text); err != nil {
				return nil, fmt.Sprintf("%s.%s could not be processed.", tool, key)
			}
		case argObjectJSON:
			// Some providers encode an object parameter as JSON text. Normalize that encoding
			// before the same shape, size, depth and operation validation used for native objects.
			var encoded string
			if json.Unmarshal(value, &encoded) == nil {
				if !json.Valid([]byte(encoded)) {
					return nil, fmt.Sprintf("%s.%s must be a JSON object.", tool, key)
				}
				value = json.RawMessage(encoded)
			}
			objectDecoder := json.NewDecoder(bytes.NewReader(value))
			objectDecoder.UseNumber()
			var object map[string]any
			if objectDecoder.Decode(&object) != nil || object == nil {
				return nil, fmt.Sprintf("%s.%s must be a JSON object.", tool, key)
			}
			canonical, err := json.Marshal(object)
			if err != nil {
				return nil, fmt.Sprintf("%s.%s must be a JSON object.", tool, key)
			}
			if err := setFlatString(&flat, mapping.flat, string(canonical)); err != nil {
				return nil, fmt.Sprintf("%s.%s could not be processed.", tool, key)
			}
		case argSpecField:
			var scalar any
			if json.Unmarshal(value, &scalar) != nil {
				return nil, fmt.Sprintf("%s.%s must be a string, a boolean or an object.", tool, key)
			}
			switch scalar.(type) {
			case string, bool, map[string]any:
				specFields[key] = scalar
			default:
				return nil, fmt.Sprintf("%s.%s must be a string, a boolean or an object.", tool, key)
			}
		}
	}
	if len(specFields) > 0 {
		canonical, err := json.Marshal(specFields)
		if err != nil {
			return nil, fmt.Sprintf("%s arguments could not be processed.", tool)
		}
		flat.SpecJSON = string(canonical)
	}
	encoded, err := json.Marshal(flat)
	if err != nil {
		return nil, fmt.Sprintf("%s arguments could not be processed.", tool)
	}
	return encoded, ""
}

// acceptedParams lists spec's typed parameter names, sorted, for an unknown-key refusal
// message: the model needs to see what it should have typed instead of what it typed.
func acceptedParams(spec map[string]argMapping) []string {
	names := make([]string, 0, len(spec))
	for name := range spec {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// setFlatString assigns one of flatToolArgs' string fields by its JSON field name (itemId,
// parentId, title, markdown, query, propertiesJson or specJson). Two typed arguments
// (templateId and itemId) can map onto the same flat field (itemId) across different
// operations, so this is a small named-field assignment rather than a struct literal. field
// always comes from toolArgSpecs, but an unrecognised value is refused rather than silently
// dropped: a mapping mistake here must surface as a refusal, never as an argument quietly
// vanishing from the flattened call.
func setFlatString(flat *flatToolArgs, field, value string) error {
	switch field {
	case "itemId":
		flat.ItemID = value
	case "parentId":
		flat.ParentID = value
	case "title":
		flat.Title = value
	case "markdown":
		flat.Markdown = value
	case "query":
		flat.Query = value
	case "propertiesJson":
		flat.PropertiesJSON = value
	case "specJson":
		flat.SpecJSON = value
	default:
		return fmt.Errorf("unmapped flat target %q", field)
	}
	return nil
}

func (a *account) listModels(ctx context.Context) error {
	raw, err := a.transport.Call(ctx, "model/list", map[string]any{"limit": 100, "includeHidden": false})
	if err != nil {
		return err
	}
	var page struct {
		Data []struct {
			Model                     string `json:"model"`
			DisplayName               string `json:"displayName"`
			IsDefault                 bool   `json:"isDefault"`
			SupportedReasoningEfforts []struct {
				ReasoningEffort string `json:"reasoningEffort"`
			} `json:"supportedReasoningEfforts"`
			DefaultReasoningEffort string `json:"defaultReasoningEffort"`
			SupportsTools          *bool  `json:"supportsTools"`
		} `json:"data"`
	}
	if len(raw) > 256<<10 || json.Unmarshal(raw, &page) != nil || len(page.Data) > 100 {
		return errors.New("invalid model catalog")
	}
	models := []Model{}
	for _, entry := range page.Data {
		if entry.Model != "" && len(entry.Model) <= 160 && len(entry.DisplayName) <= 200 {
			efforts := make([]string, 0, len(entry.SupportedReasoningEfforts))
			for _, supported := range entry.SupportedReasoningEfforts {
				if supported.ReasoningEffort != "" && len(supported.ReasoningEffort) <= 40 {
					efforts = append(efforts, supported.ReasoningEffort)
				}
			}
			models = append(models, Model{
				ID:               entry.Model,
				Name:             entry.DisplayName,
				Default:          entry.IsDefault,
				SupportsTools:    entry.SupportsTools == nil || *entry.SupportsTools,
				supportedEfforts: efforts,
				defaultEffort:    entry.DefaultReasoningEffort,
			})
		}
	}
	a.mu.Lock()
	a.models = models
	a.mu.Unlock()
	return nil
}

// effortFor decides the "effort" value, if any, to send on turn/start: the owner's configured
// chatEffort, only when the effective model - explicitModel, or
// else whichever model model/list marked default - actually advertises it. Loads the model list
// once if it has not been loaded yet. Never fails the turn: any problem (the list call failing,
// no default model, the value not being advertised) means an empty result, which send() must
// treat as "omit effort", not as a reason to fail.
func (a *account) effortFor(ctx context.Context, explicitModel string) string {
	configured := a.chatEffort
	if configured == "" {
		return ""
	}
	a.mu.Lock()
	loaded := len(a.models) > 0
	a.mu.Unlock()
	if !loaded {
		if err := a.listModels(ctx); err != nil {
			return ""
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	var effective *Model
	for i := range a.models {
		if explicitModel != "" {
			if a.models[i].ID == explicitModel {
				effective = &a.models[i]
				break
			}
			continue
		}
		if a.models[i].Default {
			effective = &a.models[i]
			break
		}
	}
	if effective == nil {
		return ""
	}
	for _, supported := range effective.supportedEfforts {
		if supported == configured {
			return configured
		}
	}
	return ""
}

func (a *account) toolRequest(id json.RawMessage, method string, raw json.RawMessage) bool {
	// A tool call or approval on an inline thread (inline.go) is never honoured: the stream is
	// ended with inline.refused and the provider gets the same refusal as any unknown request.
	if a.refuseInlineServerRequest(raw) {
		return false
	}
	if method != "item/tool/call" || len(raw) > 40000 {
		return false
	}
	var p struct {
		ThreadID  string          `json:"threadId"`
		Tool      string          `json:"tool"`
		CallID    string          `json:"callId"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if json.Unmarshal(raw, &p) != nil || p.Tool == "" || p.CallID == "" || len(p.CallID) > 200 {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for key, c := range a.conversations {
		if c.ThreadID != p.ThreadID || c.State != "thinking" {
			continue
		}
		// Accept p.Tool only when it is one of the typed tool names (catalog.go's
		// toolNamesChat); nix_workspace and anything else the provider might send is rejected
		// here, before any of the checks below run.
		if _, allowed := toolNamesChat[p.Tool]; !allowed {
			a.record(key, slog.LevelWarn, "tool.rejected", []any{"tool", truncateUTF8(p.Tool, 80), "reason", "not offered"}, map[string]any{"arguments": traceRaw(p.Arguments)})
			return false
		}
		flatArguments, reason := flattenConversationToolCall(c, p.Tool, p.Arguments)
		if reason != "" {
			// The reason can quote a key the model invented, so the shared log gets a fixed code;
			// the model and the trace get the full sentence.
			a.record(key, slog.LevelWarn, "tool.refused", []any{"tool", p.Tool, "stage", "arguments", "reason_code", argumentRefusalCode(reason)}, map[string]any{"arguments": traceRaw(p.Arguments), "reason": reason})
			if peer, ok := a.transport.(toolTransport); ok {
				_ = peer.Reply(id, toolOutput(false, reason+" No action ran and no approval was requested.", ""))
				return true
			}
			return false
		}
		// No operation runs without workspace access. Reject before returning a tool error,
		// preserving the no-consent boundary for workspace operations.
		if !c.WorkspaceAccess {
			a.record(key, slog.LevelWarn, "tool.rejected", []any{"tool", p.Tool, "reason", "workspace access is off for this message"}, map[string]any{"arguments": traceRaw(p.Arguments)})
			return false
		}
		if reason := validateToolArguments(flatArguments); reason != "" {
			a.record(key, slog.LevelWarn, "tool.refused", []any{"tool", p.Tool, "stage", "validation", "reason", reason}, map[string]any{"arguments": traceRaw(p.Arguments), "flat": traceRaw(flatArguments)})
			if peer, ok := a.transport.(toolTransport); ok {
				_ = peer.Reply(id, toolOutput(false, reason+" No action ran and no approval was requested.", ""))
				return true
			}
			return false
		}
		if reason := conversationToolRefusal(c, flatArguments); reason != "" {
			if peer, ok := a.transport.(toolTransport); ok {
				_ = peer.Reply(id, toolOutput(false, reason, ""))
				return true
			}
			return false
		}
		reason = noteScopeToolRefusal(c, string(flatArguments))
		if reason == "" && c.LockedRead && toolOperation(string(flatArguments)) == "remember" {
			// Protected text in the thread could otherwise leave its lock as a "fact" the owner
			// never approved; memory runs without a card, so it stops here instead.
			reason = "This conversation has read protected content, so nothing from it is remembered. The owner can add the fact in Settings > Pets > Memory."
		}
		if reason != "" {
			if peer, ok := a.transport.(toolTransport); ok {
				_ = peer.Reply(id, toolOutput(false, reason, ""))
				return true
			}
			return false
		}
		fingerprint, readOnly := toolIdentity(string(flatArguments))
		readMayBeStale := false
		for i := len(c.Tools) - 1; i >= 0; i-- {
			t := &c.Tools[i]
			previous, previousReadOnly := toolIdentity(t.Arguments)
			if t.ID == p.CallID || fingerprint != "" && previous == fingerprint {
				// The same provider ID must never be repurposed for a different action.
				if fingerprint == "" || previous != fingerprint {
					return false
				}
				if t.ID != p.CallID && readOnly && readMayBeStale && t.Status == "completed" {
					continue
				}
				a.record(key, slog.LevelInfo, "tool.deduplicated", []any{"tool", p.Tool, "status", t.Status, "same_call", t.ID == p.CallID}, nil)
				if t.Status == "pending" || t.Status == "claimed" {
					if string(t.rpcID) == string(id) {
						return true
					}
					for _, waiter := range t.waiters {
						if string(waiter) == string(id) {
							return true
						}
					}
					if len(t.waiters) >= 20 {
						return false
					}
					t.waiters = append(t.waiters, append(json.RawMessage{}, id...))
					return true
				}
				if peer, ok := a.transport.(toolTransport); ok {
					_ = peer.Reply(id, toolOutput(t.Status == "completed", t.Result, t.image))
					return true
				}
				return false
			}
			// A read after a write needs fresh data, not a cached pre-write result.
			if !previousReadOnly {
				readMayBeStale = true
			}
		}
		if len(c.Tools) >= maxToolCallsPerTurn {
			a.record(key, slog.LevelWarn, "tool.rejected", []any{"tool", p.Tool, "reason", "20 tool calls per turn reached"}, nil)
			if peer, ok := a.transport.(toolTransport); ok {
				_ = peer.Reply(id, toolOutput(false, "This turn reached its limit of 20 tool calls. No action ran for this request. Stop calling tools in this turn, report what completed and what remains unverified, and continue the remaining work in a later user turn. Do not repeat completed or uncertain writes.", ""))
				return true
			}
			return false
		}
		c.Tools = append(c.Tools, ToolCall{ID: p.CallID, Arguments: string(flatArguments), Status: "pending", rpcID: append(json.RawMessage{}, id...), pendingSince: time.Now()})
		c.timing.toolRecorded()
		if c.ConversationItemID != "" {
			t := &c.Tools[len(c.Tools)-1]
			t.Status = "claimed"
			t.ClaimID = c.RequestID
			t.claimedAt = time.Now()
			go a.executeDurableTool(key, c.actor, t.ID, append(json.RawMessage{}, flatArguments...))
		}
		if a.saveLocked(key) != nil {
			c.Tools = c.Tools[:len(c.Tools)-1]
			a.record(key, slog.LevelError, "tool.rejected", []any{"tool", p.Tool, "reason", "conversation could not be saved"}, nil)
			return false
		}
		a.record(key, slog.LevelInfo, "tool.requested", []any{"tool", p.Tool, "arguments_bytes", len(p.Arguments)}, map[string]any{"arguments": traceRaw(p.Arguments), "flat": traceRaw(flatArguments)})
		return true
	}
	return false
}

// Identity is scoped to one user turn and includes every argument. Canonical JSON
// handles reordered keys without treating a changed target or payload as approved.
func toolIdentity(raw string) (string, bool) {
	var args map[string]any
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	if !json.Valid([]byte(raw)) || decoder.Decode(&args) != nil || args == nil {
		return "", false
	}
	operation, _ := args["operation"].(string)
	readOnly := operation == "list_items" || operation == "search" || operation == "read_item" || operation == "read_note" || operation == "search_note" || operation == "read_structure" || operation == "read_view" || operation == "list_templates" || operation == "read_template" || operation == "read_calendar" || operation == "remember" || operation == "find_action"
	if properties, ok := args["propertiesJson"].(string); ok && properties != "" {
		var object map[string]any
		decoder := json.NewDecoder(strings.NewReader(properties))
		decoder.UseNumber()
		if json.Valid([]byte(properties)) && decoder.Decode(&object) == nil && object != nil {
			canonical, _ := json.Marshal(object)
			args["propertiesJson"] = string(canonical)
		}
	}
	if spec, ok := args["specJson"].(string); ok && spec != "" {
		var object map[string]any
		decoder := json.NewDecoder(strings.NewReader(spec))
		decoder.UseNumber()
		if json.Valid([]byte(spec)) && decoder.Decode(&object) == nil && object != nil {
			canonical, _ := json.Marshal(object)
			args["specJson"] = string(canonical)
		}
	}
	if query, ok := args["query"].(string); operation == "read_view" && ok && query != "" {
		var object map[string]any
		decoder := json.NewDecoder(strings.NewReader(query))
		decoder.UseNumber()
		if json.Valid([]byte(query)) && decoder.Decode(&object) == nil && object != nil {
			canonical, _ := json.Marshal(object)
			args["query"] = string(canonical)
		}
	}
	canonical, err := json.Marshal(args)
	if err != nil {
		return "", false
	}
	return string(canonical), readOnly
}

func toolOutput(success bool, result, image string) any {
	items := []any{map[string]string{"type": "inputText", "text": result}}
	if image != "" {
		items = append(items, map[string]string{"type": "inputImage", "imageUrl": image})
	}
	return map[string]any{"success": success, "contentItems": items}
}

// modelParamForItemID names the typed parameter that carries itemId for operation. Every
// operation calls it itemId except nix_read_template and nix_apply_template, which call it
// templateId (toolArgSpecs, above); model-facing messages must name whichever one the model
// actually typed.
func modelParamForItemID(operation string) string {
	if operation == "read_template" || operation == "apply_template" {
		return "templateId"
	}
	return "itemId"
}

func validateToolArguments(raw json.RawMessage) string {
	var p struct {
		Operation   string `json:"operation"`
		WorkspaceID string `json:"workspaceId,omitempty"`
		ItemID      string `json:"itemId"`
		ParentID    string `json:"parentId"`
		Title       string `json:"title"`
		Markdown    string `json:"markdown"`
		Query       string `json:"query"`
		Properties  string `json:"propertiesJson"`
		Spec        string `json:"specJson"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&p) != nil {
		return "Tool arguments must be a JSON object with string fields."
	}
	if p.Operation == "replace_passage" && len(p.Query) > 240 {
		return "nix_replace_passage find is limited to 240 characters. Use a shorter passage that occurs once, or nix_replace_section."
	}
	if len(p.Title) > 240 || len(p.Markdown) > 16000 || len(p.Query) > 240 || len(p.Properties) > 8000 {
		return "Tool arguments exceed the supported size limit."
	}
	if len(p.Spec) > 24000 {
		return "The design is too large. Use fewer items and fields."
	}
	if p.Spec != "" && p.Markdown != "" {
		return "Put markdown inside spec entries, not alongside it."
	}
	if p.Spec != "" && jsonDepth(p.Spec) > 24 {
		return "The design is too large. Use fewer items and fields."
	}
	if p.ParentID != "" && !uuid.MatchString(p.ParentID) {
		return "parentId must be a Nix item UUID or empty for the workspace root."
	}
	if p.ItemID != "" && !uuid.MatchString(p.ItemID) {
		return fmt.Sprintf("%s must be a Nix item UUID.", modelParamForItemID(p.Operation))
	}
	switch p.Operation {
	case "remember":
		if fact := strings.TrimSpace(p.Markdown); fact == "" || utf16Len(fact) > 280 {
			return "nix_remember needs one fact of at most 280 characters."
		}
		// The owner reviews memories in Settings; text they cannot see there must not reach the model.
		if strings.ContainsFunc(p.Markdown, func(r rune) bool {
			return r != ' ' && unicode.In(r, unicode.Cc, unicode.Cf, unicode.Co, unicode.Cs, unicode.Zl, unicode.Zp) || !unicode.IsGraphic(r) && !unicode.IsSpace(r)
		}) {
			return "nix_remember takes visible text only."
		}
	case "list_items":
	case "search":
		if strings.TrimSpace(p.Query) == "" {
			return "nix_search requires a nonempty query."
		}
	case "list_templates":
	case "create_note":
		if strings.TrimSpace(p.Title) == "" {
			return "nix_create_note requires a title."
		}
	case "search_note":
		if !uuid.MatchString(p.ItemID) {
			return "nix_search_note requires the exact itemId UUID. Discover it with nix_list_items or nix_search if it is not already known."
		}
		if strings.TrimSpace(p.Query) == "" {
			return "nix_search_note requires a nonempty query."
		}
	case "read_item", "read_note", "read_structure", "append_note", "rename_item", "move_item", "set_properties", "trash_item", "restore_item", "read_template":
		if !uuid.MatchString(p.ItemID) {
			return fmt.Sprintf("nix_%s requires the exact %s UUID. Discover it with nix_list_items or nix_search if it is not already known.", p.Operation, modelParamForItemID(p.Operation))
		}
		if p.Operation == "rename_item" && strings.TrimSpace(p.Title) == "" {
			return "nix_rename_item requires a title."
		}
		if p.Operation == "append_note" && strings.TrimSpace(p.Markdown) == "" {
			return "nix_append_note requires nonempty markdown."
		}
		if p.Operation == "set_properties" {
			var object map[string]json.RawMessage
			if json.Unmarshal([]byte(p.Properties), &object) != nil || object == nil {
				return "nix_set_properties requires properties (a JSON object)."
			}
		}
	case "read_view":
		if !uuid.MatchString(p.ItemID) {
			return "nix_read_view requires the exact itemId UUID."
		}
		if !isJSONObject(p.Query) {
			return "nix_read_view requires query with an exact viewId and optional pageSize (1 to 25)."
		}
	case "replace_section", "replace_passage":
		if !uuid.MatchString(p.ItemID) {
			return fmt.Sprintf("nix_%s requires the exact %s UUID. Discover it with nix_list_items or nix_search if it is not already known.", p.Operation, modelParamForItemID(p.Operation))
		}
		if p.Operation == "replace_section" {
			if strings.TrimSpace(p.Query) == "" {
				return "nix_replace_section requires the heading of the section to replace."
			}
			if strings.TrimSpace(p.Markdown) == "" {
				return "nix_replace_section requires nonempty markdown; it never empties a section."
			}
		} else if p.Query == "" {
			return "nix_replace_passage requires the exact text to find."
		}
	case "create_structured":
		if strings.TrimSpace(p.Title) == "" {
			return "nix_create_structured requires a title."
		}
		if !isJSONObject(p.Spec) {
			return "nix_create_structured requires spec (a JSON object)."
		}
	case "add_view", "update_view":
		if !uuid.MatchString(p.ItemID) {
			return fmt.Sprintf("nix_%s requires the exact %s UUID. Discover it with nix_list_items or nix_search if it is not already known.", p.Operation, modelParamForItemID(p.Operation))
		}
		if !isJSONObject(p.Spec) {
			return fmt.Sprintf("nix_%s requires spec (a JSON object).", p.Operation)
		}
	case "create_entries":
		if !uuid.MatchString(p.ParentID) {
			return "nix_create_entries requires the exact parentId UUID. Discover it with nix_list_items or nix_search if it is not already known."
		}
		if !isJSONObject(p.Spec) {
			return "nix_create_entries requires spec (a JSON object)."
		}
	case "add_fields", "edit_fields":
		if !uuid.MatchString(p.ItemID) {
			return fmt.Sprintf("nix_%s requires the exact %s UUID. Discover it with nix_list_items or nix_search if it is not already known.", p.Operation, modelParamForItemID(p.Operation))
		}
		if !isJSONObject(p.Spec) {
			return fmt.Sprintf("nix_%s requires spec (a JSON object).", p.Operation)
		}
	case "edit_form":
		if !uuid.MatchString(p.ItemID) {
			return fmt.Sprintf("nix_edit_form requires the exact %s UUID. Discover it with nix_list_items or nix_search if it is not already known.", modelParamForItemID(p.Operation))
		}
		if !isJSONObject(p.Spec) {
			return "nix_edit_form requires spec (a JSON object)."
		}
	case "set_recurrence":
		if !uuid.MatchString(p.ItemID) {
			return fmt.Sprintf("nix_set_recurrence requires the exact %s UUID. Discover it with nix_list_items or nix_search if it is not already known.", modelParamForItemID(p.Operation))
		}
		if !isJSONObject(p.Spec) {
			return "nix_set_recurrence requires spec (a JSON object)."
		}
	case "apply_template":
		if !uuid.MatchString(p.ItemID) {
			return fmt.Sprintf("nix_apply_template requires the exact %s UUID. Discover it with nix_list_items or nix_search if it is not already known.", modelParamForItemID(p.Operation))
		}
		if strings.TrimSpace(p.Title) == "" {
			return "nix_apply_template requires a title."
		}
		if p.Spec != "" && !isJSONObject(p.Spec) {
			return "nix_apply_template requires spec (a JSON object) when supplied."
		}
	case "build_blueprint":
		if !isJSONObject(p.Spec) {
			return "nix_build_blueprint requires blueprint (a JSON object)."
		}
	case "save_as_template":
		if !uuid.MatchString(p.ItemID) {
			return fmt.Sprintf("nix_save_as_template requires the exact %s UUID. Discover it with nix_list_items or nix_search if it is not already known.", modelParamForItemID(p.Operation))
		}
		if strings.TrimSpace(p.Title) == "" {
			return "nix_save_as_template requires a title."
		}
	case "read_calendar":
		var window struct {
			From string `json:"from"`
			To   string `json:"to"`
		}
		if json.Unmarshal([]byte(p.Spec), &window) != nil {
			return "nix_read_calendar requires from and to as yyyy-MM-dd days."
		}
		from, fromErr := time.Parse(time.DateOnly, window.From)
		to, toErr := time.Parse(time.DateOnly, window.To)
		if fromErr != nil || toErr != nil {
			return "nix_read_calendar requires from and to as yyyy-MM-dd days."
		}
		if to.Before(from) {
			return "nix_read_calendar requires from on or before to."
		}
		if to.Sub(from) > (calendarMaxDays-1)*24*time.Hour {
			return fmt.Sprintf("nix_read_calendar reads at most %d days at a time. Split the range.", calendarMaxDays)
		}
	case "find_action":
		if strings.TrimSpace(p.Query) == "" {
			return "nix_find_action requires a nonempty query."
		}
	case "run_action":
		if strings.TrimSpace(p.Query) == "" {
			return "nix_run_action requires actionId, an id from nix_find_action."
		}
		if p.Spec != "" && !isJSONObject(p.Spec) {
			return "nix_run_action path, params and body must be JSON objects."
		}
	case "complete_task":
		if !uuid.MatchString(p.ItemID) {
			return "nix_complete_task requires the exact itemId UUID. Discover it with nix_list_items or nix_search if it is not already known."
		}
		var task struct {
			Completed *bool `json:"completed"`
		}
		if json.Unmarshal([]byte(p.Spec), &task) != nil || task.Completed == nil {
			return "nix_complete_task requires completed (true or false)."
		}
	default:
		return "Unsupported workspace operation."
	}
	return ""
}

// calendarMaxDays is nix_read_calendar's widest window, both ends included; @nix/companion's
// CALENDAR_MAX_DAYS (packages/companion/src/read/calendar.ts) is the executor's own copy.
const calendarMaxDays = 31

// isJSONObject reports whether raw decodes as a JSON object (not an array, scalar or
// empty string).
func isJSONObject(raw string) bool {
	var object map[string]json.RawMessage
	return raw != "" && json.Unmarshal([]byte(raw), &object) == nil && object != nil
}

// jsonDepth counts the maximum nesting of '{' and '[' in raw, ignoring anything inside a
// JSON string, without decoding the document. Used to bound specJson before it is parsed.
func jsonDepth(raw string) int {
	depth, maxDepth := 0, 0
	inString, escaped := false, false
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if inString {
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
			}
			continue
		}
		switch c {
		case '"':
			inString = true
		case '{', '[':
			depth++
			if depth > maxDepth {
				maxDepth = depth
			}
		case '}', ']':
			depth--
		}
	}
	return maxDepth
}

func (a *account) resolveTool(key string, r Request) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	c := a.conversations[key]
	for i := range c.Tools {
		t := &c.Tools[i]
		if t.ID != r.ToolID {
			continue
		}
		if r.Operation == "tool_claim" {
			if c.State != "thinking" || t.Status != "pending" {
				a.record(key, slog.LevelWarn, "tool.claim_refused", []any{"tool", toolOperation(t.Arguments), "status", t.Status, "turn_state", c.State}, nil)
				return errors.New("tool already claimed; do not execute again")
			}
			t.Status = "claimed"
			c.timing.toolClaimed(t.pendingSince)
			pendingMS := int64(0)
			if !t.pendingSince.IsZero() {
				pendingMS = time.Since(t.pendingSince).Milliseconds()
			}
			a.record(key, slog.LevelInfo, "tool.claimed", []any{"tool", toolOperation(t.Arguments), "pending_ms", pendingMS}, nil)
			t.claimedAt = time.Now()
			t.ClaimID = r.RequestID
			return a.saveLocked(key)
		}
		if t.ClaimID != r.RequestID {
			return errors.New("tool claim does not match")
		}
		if t.Status == "completed" || t.Status == "failed" {
			return nil
		}
		if t.Status != "claimed" || len(t.rpcID) == 0 {
			return errors.New("tool is no longer active")
		}
		peer, ok := a.transport.(toolTransport)
		if !ok {
			return errors.New("tool transport unavailable")
		}
		t.Result = strings.TrimSpace(r.ToolResult)
		t.image = r.ToolImage
		if t.Result == "" {
			t.Result = "No result supplied. Do not assume the operation succeeded."
		}
		t.Status = "failed"
		if r.ToolSuccess {
			t.Status = "completed"
		}
		if r.ToolLockedContent {
			// Sticky for the thread's life: the result is now in the model's context.
			c.LockedRead = true
		}
		level := slog.LevelInfo
		kind := resultKind(r.ToolSuccess, t.Result)
		if kind == "failed" || kind == "no_result" {
			level = slog.LevelWarn
		}
		runMS := int64(0)
		if !t.claimedAt.IsZero() {
			runMS = time.Since(t.claimedAt).Milliseconds()
		}
		a.record(key, level, "tool.result", []any{"tool", toolOperation(t.Arguments), "outcome", kind, "run_ms", runMS, "result_chars", len(t.Result)}, map[string]any{"result": t.Result})
		if err := a.saveLocked(key); err != nil {
			return err
		}
		var replyErr error
		for _, id := range append([]json.RawMessage{t.rpcID}, t.waiters...) {
			if err := peer.Reply(id, toolOutput(r.ToolSuccess, t.Result, t.image)); err != nil {
				replyErr = err
			}
		}
		t.waiters = nil
		return replyErr
	}
	return errors.New("unknown tool call")
}

func (a *account) cancelTools(key string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cancelToolsLocked(key)
	_ = a.saveLocked(key)
}

func (a *account) cancelToolsLocked(key string) {
	peer, ok := a.transport.(toolTransport)
	for i := range a.conversations[key].Tools {
		t := &a.conversations[key].Tools[i]
		if t.Status == "pending" || t.Status == "claimed" {
			a.record(key, slog.LevelWarn, "tool.interrupted", []any{"tool", toolOperation(t.Arguments), "status", t.Status}, nil)
			t.Result = "The turn ended before this request was confirmed. A claimed write may have completed; inspect Nix before retrying."
			for _, id := range append([]json.RawMessage{t.rpcID}, t.waiters...) {
				if ok && len(id) > 0 {
					_ = peer.Reply(id, toolOutput(false, t.Result, ""))
				}
			}
			t.waiters = nil
			t.Status = "interrupted"
		}
	}
}
