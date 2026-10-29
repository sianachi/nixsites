package companion

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

type toolPeer struct {
	fakeTransport
	replies []any
}

func TestIdenticalToolCallsShareOneDecision(t *testing.T) {
	for _, success := range []bool{true, false} {
		t.Run(fmt.Sprint(success), func(t *testing.T) {
			peer := &toolPeer{}
			a := &account{transport: peer, home: t.TempDir(), conversations: map[string]*conversation{"x": {ThreadID: "thread", State: "thinking", WorkspaceAccess: true}}}
			call := func(id, args string) bool {
				raw := json.RawMessage(fmt.Sprintf(`{"threadId":"thread","tool":"nix_create_note","callId":%q,"arguments":%s}`, id, args))
				return a.toolRequest(json.RawMessage(fmt.Sprintf(`%q`, id)), "item/tool/call", raw)
			}
			if !call("one", `{"title":"Plan","markdown":"body"}`) || !call("two", `{"markdown":"body","title":"Plan"}`) {
				t.Fatal("duplicate request not coalesced")
			}
			if len(a.snapshot("x").Tools) != 1 || len(peer.replies) != 0 {
				t.Fatal("duplicate approval or premature result")
			}
			r := Request{Operation: "tool_claim", ToolID: "one", RequestID: "decision"}
			if err := a.resolveTool("x", r); err != nil {
				t.Fatal(err)
			}
			if !call("three", `{"title":"Plan","markdown":"body"}`) {
				t.Fatal("claimed duplicate refused")
			}
			r.Operation, r.ToolSuccess, r.ToolResult = "tool_result", success, "Existing decision and result"
			if err := a.resolveTool("x", r); err != nil {
				t.Fatal(err)
			}
			if len(peer.replies) != 3 {
				t.Fatal("not all waiting requests received the decision")
			}
			if !call("four", `{"title":"Plan","markdown":"body"}`) || len(peer.replies) != 4 || len(a.snapshot("x").Tools) != 1 {
				t.Fatal("completed or declined action asked again")
			}
			if !call("five", `{"title":"Different plan","markdown":"body"}`) || len(a.snapshot("x").Tools) != 2 {
				t.Fatal("changed action reused permission")
			}
		})
	}
}

func TestReadAfterWriteRequiresFreshResult(t *testing.T) {
	peer := &toolPeer{}
	a := &account{transport: peer, home: t.TempDir(), conversations: map[string]*conversation{"x": {
		ThreadID: "thread", State: "thinking", WorkspaceAccess: true,
		Tools: []ToolCall{
			{ID: "read", Arguments: `{"operation":"read_note","itemId":"11111111-1111-4111-8111-111111111111"}`, Status: "completed", Result: "Old content"},
			{ID: "write", Arguments: `{"operation":"append_note","itemId":"11111111-1111-4111-8111-111111111111"}`, Status: "completed", Result: "Appended"},
		},
	}}}
	if !a.toolRequest(json.RawMessage(`1`), "item/tool/call", json.RawMessage(`{"threadId":"thread","tool":"nix_read_note","callId":"fresh","arguments":{"itemId":"11111111-1111-4111-8111-111111111111"}}`)) {
		t.Fatal("fresh read refused")
	}
	if len(peer.replies) != 0 || len(a.snapshot("x").Tools) != 3 {
		t.Fatal("stale read reused after write")
	}
}

func TestToolBudgetReturnsAnExplicitResultWithoutAnotherApproval(t *testing.T) {
	for _, tc := range []struct {
		tool string
		args string
	}{
		{"nix_read_note", `{"itemId":"11111111-1111-4111-8111-111111111111"}`},
		{"nix_create_note", `{"title":"Beyond the budget","markdown":"Do not create"}`},
	} {
		t.Run(tc.tool, func(t *testing.T) {
			peer := &toolPeer{}
			c := &conversation{ThreadID: "thread", State: "thinking", WorkspaceAccess: true}
			for i := 0; i < maxToolCallsPerTurn; i++ {
				c.Tools = append(c.Tools, ToolCall{
					ID: fmt.Sprintf("seed-%d", i), Arguments: fmt.Sprintf(`{"operation":"create_note","title":"Seed %d"}`, i),
					Status: "completed", Result: "Already created",
				})
			}
			a := &account{transport: peer, home: t.TempDir(), conversations: map[string]*conversation{"x": c}}
			raw := json.RawMessage(fmt.Sprintf(`{"threadId":"thread","tool":%q,"callId":"exhausted","arguments":%s}`, tc.tool, tc.args))
			if !a.toolRequest(json.RawMessage(`21`), "item/tool/call", raw) {
				t.Fatal("budget refusal fell through to a generic transport error")
			}
			if len(c.Tools) != maxToolCallsPerTurn || len(peer.replies) != 1 {
				t.Fatal("exhausted request created another approval or lost its response")
			}
			encoded, err := json.Marshal(peer.replies[0])
			if err != nil || !strings.Contains(string(encoded), `"success":false`) || !strings.Contains(string(encoded), "limit of 20 tool calls") || !strings.Contains(string(encoded), "No action ran") {
				t.Fatalf("budget result omitted the failure and recovery: %s", encoded)
			}
			if err := a.resolveTool("x", Request{Operation: "tool_claim", ToolID: "exhausted", RequestID: "claim"}); err == nil {
				t.Fatal("budget-refused action remained claimable")
			}
			// An already completed write still receives its original result at the limit.
			duplicate := json.RawMessage(`{"threadId":"thread","tool":"nix_create_note","callId":"duplicate","arguments":{"title":"Seed 0"}}`)
			if !a.toolRequest(json.RawMessage(`22`), "item/tool/call", duplicate) || len(peer.replies) != 2 || len(c.Tools) != maxToolCallsPerTurn {
				t.Fatal("budget prevented replay of an existing receipt")
			}
		})
	}
}

func TestToolIdentityPreservesPayloadAndNormalizesObjectKeys(t *testing.T) {
	one, _ := toolIdentity(`{"operation":"set_properties","propertiesJson":"{\"a\":1,\"b\":2}"}`)
	two, _ := toolIdentity(`{"propertiesJson":"{\"b\":2, \"a\":1}","operation":"set_properties"}`)
	if one != two {
		t.Fatal("property key order changes identity")
	}
	one, _ = toolIdentity(`{"propertiesJson":"{\"value\":9007199254740992}"}`)
	two, _ = toolIdentity(`{"propertiesJson":"{\"value\":9007199254740993}"}`)
	if one == two {
		t.Fatal("different numeric payloads share permission")
	}
}

// TestInvalidTypedToolArgumentsNeverReachApproval covers malformed typed-tool calls that a
// valid nix_<operation> tool name still reaches: an unknown parameter, a spec/blueprint that is
// not a JSON object (both refused by flattenToolCall), and a flattened call
// validateToolArguments itself refuses (an empty title, a non-UUID itemId, and so on) - the same
// two layers TestUnsupportedToolNamesAreRejectedBeforeFlattening and this test between them
// cover every rejection path toolRequest has.
func TestInvalidTypedToolArgumentsNeverReachApproval(t *testing.T) {
	itemID := "11111111-1111-4111-8111-111111111111"
	for _, tc := range []struct {
		tool string
		args string
	}{
		{"nix_create_note", `{"title":""}`},
		{"nix_create_note", `{"title":"Safe","url":"https://example.com"}`},
		{"nix_read_note", `{"itemId":"https://example.com"}`},
		{"nix_search", `{"query":""}`},
		{"nix_create_structured", `{"title":""}`},
		{"nix_create_structured", `{"title":"Plan","spec":[]}`},
		{"nix_create_structured", `{"title":"Plan","spec":1}`},
		{"nix_add_view", `{"itemId":"not-a-uuid","spec":{}}`},
		{"nix_create_entries", fmt.Sprintf(`{"parentId":"","spec":{"entries":[{"title":%q}]}}`, "x")},
		{"nix_add_fields", `{"itemId":"not-a-uuid","spec":{}}`},
		{"nix_add_fields", fmt.Sprintf(`{"itemId":%q,"spec":[]}`, itemID)},
		{"nix_edit_form", `{"itemId":"","spec":{}}`},
		{"nix_edit_form", fmt.Sprintf(`{"itemId":%q,"spec":1}`, itemID)},
		{"nix_set_recurrence", `{"itemId":"not-a-uuid"}`},
		{"nix_set_recurrence", fmt.Sprintf(`{"itemId":%q}`, itemID)},
		{"nix_apply_template", fmt.Sprintf(`{"templateId":%q,"title":""}`, itemID)},
	} {
		peer := &toolPeer{}
		a := &account{transport: peer, home: t.TempDir(), conversations: map[string]*conversation{"x": {ThreadID: "thread", State: "thinking", WorkspaceAccess: true}}}
		request := json.RawMessage(fmt.Sprintf(`{"threadId":"thread","tool":%q,"callId":"bad","arguments":%s}`, tc.tool, tc.args))
		if !a.toolRequest(json.RawMessage(`1`), "item/tool/call", request) {
			t.Fatalf("invalid call did not receive a useful failure result: %s %s", tc.tool, tc.args)
		}
		if len(a.snapshot("x").Tools) != 0 || len(peer.replies) != 1 {
			t.Fatalf("invalid request reached approval: %s %s", tc.tool, tc.args)
		}
	}
}

// TestUnsupportedToolNamesAreRejectedBeforeFlattening covers the routing gate toolRequest runs
// before flattenToolCall: nix_workspace (retired) and any name that is not one of the
// conversation mode's own typed tools are refused silently - no reply, no approval, matching how
// a tool name outside the enum was always refused before dynamicTools carried per-operation
// tools.
func TestUnsupportedToolNamesAreRejectedBeforeFlattening(t *testing.T) {
	for _, tool := range []string{"nix_workspace", "nix_read_schema", "nix_shell", "shell"} {
		peer := &toolPeer{}
		a := &account{transport: peer, home: t.TempDir(), conversations: map[string]*conversation{"x": {ThreadID: "thread", State: "thinking", WorkspaceAccess: true}}}
		request := json.RawMessage(fmt.Sprintf(`{"threadId":"thread","tool":%q,"callId":"bad","arguments":{}}`, tool))
		if a.toolRequest(json.RawMessage(`1`), "item/tool/call", request) {
			t.Fatalf("unsupported tool name accepted: %s", tool)
		}
		if len(peer.replies) != 0 {
			t.Fatalf("unsupported tool name received a reply: %s", tool)
		}
	}
}

func TestNoToolRunsWithoutWorkspaceAccess(t *testing.T) {
	a := &account{transport: &toolPeer{}, home: t.TempDir(), conversations: map[string]*conversation{"x": {
		ThreadID: "thread", State: "thinking", WorkspaceAccess: false,
	}}}
	raw := json.RawMessage(`{"threadId":"thread","tool":"nix_build_blueprint","callId":"design","arguments":{"blueprint":{}}}`)
	if a.toolRequest(json.RawMessage(`1`), "item/tool/call", raw) || len(a.snapshot("x").Tools) != 0 {
		t.Fatal("a design build reached the approval flow without workspace access")
	}
}

func TestSpecJsonLimitsAndDepth(t *testing.T) {
	oversized := `{"operation":"create_structured","parentId":"","title":"Plan","specJson":"` + strings.Repeat("a", 24001) + `"}`
	if got := validateToolArguments(json.RawMessage(oversized)); got != "The design is too large. Use fewer items and fields." {
		t.Fatalf("oversized specJson not refused with the exact message: %q", got)
	}
	deep := strings.Repeat(`{"a":`, 25) + "1" + strings.Repeat("}", 25)
	deepArgs, err := json.Marshal(map[string]string{"operation": "create_structured", "parentId": "", "title": "Plan", "specJson": deep})
	if err != nil {
		t.Fatal(err)
	}
	if got := validateToolArguments(json.RawMessage(deepArgs)); got != "The design is too large. Use fewer items and fields." {
		t.Fatalf("depth-25 specJson not refused with the exact message: %q", got)
	}
	atLimit := strings.Repeat(`{"a":`, 24) + "1" + strings.Repeat("}", 24)
	atLimitArgs, err := json.Marshal(map[string]string{"operation": "create_structured", "parentId": "", "title": "Plan", "specJson": atLimit})
	if err != nil {
		t.Fatal(err)
	}
	if got := validateToolArguments(json.RawMessage(atLimitArgs)); got != "" {
		t.Fatalf("depth-24 specJson wrongly refused: %q", got)
	}
	shallow := `{"a":1}`
	if jsonDepth(shallow) != 1 {
		t.Fatalf("shallow object misjudged: %d", jsonDepth(shallow))
	}
	bracketsInString := `{"a":"{{{{[[[["}`
	if jsonDepth(bracketsInString) != 1 {
		t.Fatalf("brackets inside a string counted as nesting: %d", jsonDepth(bracketsInString))
	}
	alongsideMarkdown := `{"operation":"create_note","title":"Plan","markdown":"body","specJson":"{}"}`
	if got := validateToolArguments(json.RawMessage(alongsideMarkdown)); got != "Put markdown inside spec entries, not alongside it." {
		t.Fatalf("markdown alongside specJson not refused: %q", got)
	}
}

func TestNewOperationsAcceptValidArguments(t *testing.T) {
	itemID := "11111111-1111-4111-8111-111111111111"
	for _, raw := range []string{
		fmt.Sprintf(`{"operation":"read_structure","itemId":%q}`, itemID),
		`{"operation":"create_structured","title":"Plan","specJson":"{\"recipe\":\"list\",\"fields\":[]}"}`,
		fmt.Sprintf(`{"operation":"add_view","itemId":%q,"specJson":"{\"views\":[]}"}`, itemID),
		fmt.Sprintf(`{"operation":"create_entries","parentId":%q,"specJson":"{\"entries\":[]}"}`, itemID),
		`{"operation":"list_templates"}`,
		fmt.Sprintf(`{"operation":"read_template","itemId":%q}`, itemID),
		fmt.Sprintf(`{"operation":"apply_template","itemId":%q,"title":"Plan"}`, itemID),
	} {
		if got := validateToolArguments(json.RawMessage(raw)); got != "" {
			t.Fatalf("valid arguments refused: %s -> %q", raw, got)
		}
	}
}

// TestDesignOperationsAreAcceptedInTheOneConversation proves the design tools that once
// belonged to Design mode are accepted with minimal valid arguments, and that the retired
// validate_blueprint is refused as unsupported.
func TestDesignOperationsAreAcceptedInTheOneConversation(t *testing.T) {
	itemID := "11111111-1111-4111-8111-111111111111"
	for _, raw := range []string{
		`{"operation":"build_blueprint","specJson":"{}"}`,
		fmt.Sprintf(`{"operation":"save_as_template","itemId":%q,"title":"Job hunt"}`, itemID),
	} {
		if got := validateToolArguments(json.RawMessage(raw)); got != "" {
			t.Fatalf("design operation refused with valid arguments: %s -> %q", raw, got)
		}
	}
	if got := validateToolArguments(json.RawMessage(`{"operation":"validate_blueprint","specJson":"{}"}`)); got != "Unsupported workspace operation." {
		t.Fatalf("retired validate_blueprint not refused as unsupported: %q", got)
	}
}

func TestSaveDescriptionMatchesCaptureContract(t *testing.T) {
	tools := workspaceTools()
	var saveDescription string
	for _, entry := range tools {
		tool := entry.(map[string]any)
		if tool["name"] == "nix_save_as_template" {
			saveDescription = tool["description"].(string)
		}
	}
	if saveDescription == "" {
		t.Fatal("nix_save_as_template is missing from workspaceTools()")
	}
	if !strings.Contains(saveDescription, "Sample:") {
		t.Fatalf("nix_save_as_template's description does not explain the Sample: exclusion: %q", saveDescription)
	}
	if !strings.Contains(designRules, "Title every fictional sample node and sample container with the prefix Sample:") {
		t.Fatal("design instructions omit the capture exclusion naming rule")
	}
	if !strings.Contains(designRules, "omit spec for default sample exclusion") {
		t.Fatal("design instructions omit how to accept nix_save_as_template's default sample exclusion")
	}
}

// TestFlattenToolCallMatchesTSReferenceFixture is the Go half of the round trip
// packages/structure-spec/src/catalog/tools.test.ts checks from the TS side: for every
// operation, catalog/tool-examples.json (generated by scripts/build-catalog.ts from
// @nix/structure-spec's TOOL_EXAMPLES and its TS reference flattenToolExample) carries a valid
// typed-tool argument object and the flat object flattening it must produce. flattenToolCall
// must produce exactly that flat object from exactly that argument object - the two languages
// checked against one fixture, so a mapping added on one side and not the other fails here. This
// fixture round trip alone does not prove toolArgSpecs has no stale or missing parameter for any
// operation; TestToolArgSpecsMatchGeneratedSchemas below checks that directly against the
// generated schemas.
func TestFlattenToolCallMatchesTSReferenceFixture(t *testing.T) {
	if len(toolExamples) == 0 {
		t.Fatal("catalog/tool-examples.json is empty; run pnpm --filter @nix/structure-spec catalog")
	}
	for _, fixture := range toolExamples {
		t.Run(fixture.Operation, func(t *testing.T) {
			tool := "nix_" + fixture.Operation
			flat, reason := flattenToolCall(tool, fixture.Arguments)
			if reason != "" {
				t.Fatalf("flattenToolCall refused a fixture example: %s", reason)
			}
			var got flatToolArgs
			if err := json.Unmarshal(flat, &got); err != nil {
				t.Fatalf("flattenToolCall produced invalid JSON: %v", err)
			}
			if !flatArgsEqual(got, fixture.Flat) {
				t.Fatalf("flattenToolCall(%s, %s) = %+v, want %+v", tool, fixture.Arguments, got, fixture.Flat)
			}
		})
	}
}

// flatArgsEqual compares two flatToolArgs for equal content rather than byte-identical JSON
// strings in specJson/propertiesJson: Go's json.Marshal of a map always sorts keys
// alphabetically, while the TS reference implementation's JSON.stringify preserves each
// object's own key order, so the two languages' canonical strings can differ in key order while
// still decoding to the same value. The plain string fields (operation, itemId, ...) compare
// exactly, since flattenToolCall never reorders or reformats them.
func flatArgsEqual(a, b flatToolArgs) bool {
	if a.Operation != b.Operation || a.ItemID != b.ItemID || a.ParentID != b.ParentID ||
		a.Title != b.Title || a.Markdown != b.Markdown {
		return false
	}
	if a.Operation == "read_view" {
		if !jsonEqual(a.Query, b.Query) {
			return false
		}
	} else if a.Query != b.Query {
		return false
	}
	return jsonEqual(a.PropertiesJSON, b.PropertiesJSON) && jsonEqual(a.SpecJSON, b.SpecJSON)
}

// jsonEqual reports whether two JSON strings (or two empty strings) decode to the same value,
// ignoring object key order and formatting.
func jsonEqual(a, b string) bool {
	if a == "" || b == "" {
		return a == b
	}
	var aValue, bValue any
	if json.Unmarshal([]byte(a), &aValue) != nil || json.Unmarshal([]byte(b), &bValue) != nil {
		return false
	}
	return reflect.DeepEqual(aValue, bValue)
}

// TestFlattenedFixturesAreAcceptedByValidateToolArguments proves every fixture's flattened
// result also clears the flat-shape checks validateToolArguments has always run (a nonempty
// title, a real itemId UUID, a JSON object in specJson, and so on): flattening producing the
// right shape and the flat shape being accepted are two different guarantees, and this is the
// second one.
func TestFlattenedFixturesAreAcceptedByValidateToolArguments(t *testing.T) {
	for _, fixture := range toolExamples {
		t.Run(fixture.Operation, func(t *testing.T) {
			encoded, err := json.Marshal(fixture.Flat)
			if err != nil {
				t.Fatal(err)
			}
			if got := validateToolArguments(json.RawMessage(encoded)); got != "" {
				t.Fatalf("fixture flattened result refused: %s -> %q", encoded, got)
			}
		})
	}
}

// TestUnknownOperationIsRefusedAsUnsupported proves validateToolArguments's default switch case
// still refuses an operation string outside the enum (a retired operation such as read_schema,
// or a flat shape that somehow named one flattenToolCall never produces) as unsupported, the way
// it always has.
func TestUnknownOperationIsRefusedAsUnsupported(t *testing.T) {
	for _, raw := range []string{
		`{"operation":"read_schema"}`,
		`{"operation":"shell"}`,
		`{"operation":"delete_item_permanently"}`,
		`{"operation":""}`,
	} {
		if got := validateToolArguments(json.RawMessage(raw)); got != "Unsupported workspace operation." {
			t.Fatalf("non-enum operation not refused as unsupported: %s -> %q", raw, got)
		}
	}
}

// TestFlattenToolCallRejectsUnknownParametersAndWrongShapes covers flattenToolCall's own
// refusals, independent of the fixture: a parameter no operation declares, a spec/blueprint
// argument that is not a JSON object, and an unsupported tool name.
func TestFlattenToolCallRejectsUnknownParametersAndWrongShapes(t *testing.T) {
	if _, reason := flattenToolCall("nix_create_note", json.RawMessage(`{"title":"Safe","url":"https://example.com"}`)); reason == "" {
		t.Fatal("unknown parameter accepted")
	} else if !strings.Contains(reason, "url") || !strings.Contains(reason, "nix_create_note") {
		t.Fatalf("unknown parameter reason does not name the key and the tool: %q", reason)
	}
	if _, reason := flattenToolCall("nix_create_structured", json.RawMessage(`{"title":"Plan","spec":[]}`)); reason == "" {
		t.Fatal("array spec accepted")
	}
	if _, reason := flattenToolCall("nix_create_structured", json.RawMessage(`{"title":"Plan","spec":1}`)); reason == "" {
		t.Fatal("scalar spec accepted")
	}
	if _, reason := flattenToolCall("nix_read_schema", json.RawMessage(`{}`)); reason == "" {
		t.Fatal("unsupported tool name accepted")
	}
	if _, reason := flattenToolCall("nix_read_item", json.RawMessage(`not json`)); reason == "" {
		t.Fatal("non-JSON arguments accepted")
	}
}

// TestFlattenToolCallMapsTemplateIdToItemId covers L1.1's one deliberate naming difference
// between a typed tool and the flat shape: nix_read_template and nix_apply_template take
// templateId, which flattens to the flat shape's itemId field (the id run.ts's apply_template
// and read_template branches have always read).
func TestFlattenToolCallMapsTemplateIdToItemId(t *testing.T) {
	itemID := "11111111-1111-4111-8111-111111111111"
	for _, tc := range []struct {
		tool string
		args string
	}{
		{"nix_read_template", fmt.Sprintf(`{"templateId":%q}`, itemID)},
		{"nix_apply_template", fmt.Sprintf(`{"templateId":%q,"title":"Plan"}`, itemID)},
	} {
		flat, reason := flattenToolCall(tc.tool, json.RawMessage(tc.args))
		if reason != "" {
			t.Fatalf("%s: %s", tc.tool, reason)
		}
		var got flatToolArgs
		if err := json.Unmarshal(flat, &got); err != nil {
			t.Fatal(err)
		}
		if got.ItemID != itemID {
			t.Fatalf("%s: templateId did not map to itemId: %+v", tc.tool, got)
		}
	}
}

func TestReadSchemaIsNoLongerAnOperation(t *testing.T) {
	itemID := "11111111-1111-4111-8111-111111111111"
	got := validateToolArguments(json.RawMessage(fmt.Sprintf(`{"operation":"read_schema","itemId":%q}`, itemID)))
	if got != "Unsupported workspace operation." {
		t.Fatalf("read_schema still accepted: %q", got)
	}
}

func TestSpecJsonIdentityIsCanonical(t *testing.T) {
	one, _ := toolIdentity(`{"operation":"create_structured","specJson":"{\"a\":1,\"b\":2}"}`)
	two, _ := toolIdentity(`{"specJson":"{\"b\":2, \"a\":1}","operation":"create_structured"}`)
	if one != two {
		t.Fatal("specJson key order changes identity")
	}
}

func TestNewReadOperationsAreReadOnly(t *testing.T) {
	for _, raw := range []string{
		`{"operation":"read_structure","itemId":"11111111-1111-4111-8111-111111111111"}`,
		`{"operation":"list_templates"}`,
		`{"operation":"read_template","itemId":"11111111-1111-4111-8111-111111111111"}`,
	} {
		_, readOnly := toolIdentity(raw)
		if !readOnly {
			t.Fatalf("operation not marked read-only: %s", raw)
		}
	}
	for _, raw := range []string{
		`{"operation":"create_structured"}`,
		`{"operation":"add_view"}`,
		`{"operation":"create_entries"}`,
		`{"operation":"add_fields"}`,
		`{"operation":"edit_form"}`,
		`{"operation":"set_recurrence"}`,
		`{"operation":"apply_template"}`,
		`{"operation":"build_blueprint"}`,
		`{"operation":"save_as_template"}`,
	} {
		_, readOnly := toolIdentity(raw)
		if readOnly {
			t.Fatalf("write operation marked read-only: %s", raw)
		}
	}
}

func TestCatalogCarriesEverySection(t *testing.T) {
	for _, word := range []string{"Property types", "View kinds", "Recipes", "Never", "Blueprint schema", "Patterns"} {
		if !strings.Contains(chatCatalog, word) {
			t.Fatalf("chat catalog missing section %q", word)
		}
	}
}

// validFlatTargets are flatToolArgs' own JSON field names: the only values toolArgSpecs'
// argMapping.flat and setFlatString's field switch are allowed to name.
var validFlatTargets = map[string]bool{
	"itemId": true, "parentId": true, "title": true, "markdown": true,
	"query": true, "propertiesJson": true, "specJson": true,
}

// TestToolArgSpecsMatchGeneratedSchemas walks workspaceTools() and checks tools.go's hand-written toolArgSpecs against the
// generated schema directly, rather than trusting the tool-examples.json fixture alone to catch
// every drift: for every tool, the key set of inputSchema.properties must equal the key set of
// toolArgSpecs[operation], a property typed "object" must map to argObjectJSON and any other
// property must map to argString, toolArgSpecs must have exactly one entry per tool, and
// every argMapping's flat target must be one of flatToolArgs' own field names.
func TestToolArgSpecsMatchGeneratedSchemas(t *testing.T) {
	tools := workspaceTools()
	if len(toolArgSpecs) != len(tools) {
		t.Fatalf("toolArgSpecs has %d entries, want %d (one per tool)", len(toolArgSpecs), len(tools))
	}
	for _, entry := range tools {
		tool, ok := entry.(map[string]any)
		if !ok {
			t.Fatalf("tool entry is %T, want map[string]any", entry)
		}
		name, _ := tool["name"].(string)
		operation := operationFromToolName(name)
		spec, ok := toolArgSpecs[operation]
		if !ok {
			t.Fatalf("toolArgSpecs is missing an entry for %s", name)
		}
		schema, _ := tool["inputSchema"].(map[string]any)
		properties, _ := schema["properties"].(map[string]any)
		if len(properties) != len(spec) {
			t.Fatalf("%s: inputSchema.properties has %d keys, toolArgSpecs[%q] has %d", name, len(properties), operation, len(spec))
		}
		for property, rawSchema := range properties {
			mapping, ok := spec[property]
			if !ok {
				t.Fatalf("%s: inputSchema declares %q, toolArgSpecs[%q] does not", name, property, operation)
			}
			propertySchema, _ := rawSchema.(map[string]any)
			wantKind := argString
			if propertySchema["type"] == "object" {
				wantKind = argObjectJSON
			}
			// A scalar folded into specJson (argSpecField) is the one other legal mapping for a
			// non-object parameter, and it must land in specJson; a boolean can be nothing else.
			if mapping.kind == argSpecField && propertySchema["type"] != "object" {
				if mapping.flat != "specJson" {
					t.Fatalf("%s.%s: argSpecField must target specJson, targets %q", name, property, mapping.flat)
				}
				wantKind = argSpecField
			}
			if propertySchema["type"] == "boolean" && mapping.kind != argSpecField {
				t.Fatalf("%s.%s: a boolean parameter must map to argSpecField", name, property)
			}
			if mapping.kind != wantKind {
				t.Fatalf("%s.%s: toolArgSpecs maps kind %v, schema type %v implies %v", name, property, mapping.kind, propertySchema["type"], wantKind)
			}
			if !validFlatTargets[mapping.flat] {
				t.Fatalf("%s.%s: argMapping targets unknown flat field %q", name, property, mapping.flat)
			}
		}
	}
}

// TestSetFlatStringRefusesAnUnknownField proves setFlatString never silently drops an argument:
// a field name outside flatToolArgs' own JSON names is refused with an error, not ignored.
func TestSetFlatStringRefusesAnUnknownField(t *testing.T) {
	var flat flatToolArgs
	if err := setFlatString(&flat, "bogus", "value"); err == nil {
		t.Fatal("unknown flat field silently accepted")
	}
	if flat != (flatToolArgs{}) {
		t.Fatalf("unknown flat field mutated flatToolArgs: %+v", flat)
	}
	for field := range validFlatTargets {
		if err := setFlatString(&flatToolArgs{}, field, "value"); err != nil {
			t.Fatalf("known flat field %q refused: %v", field, err)
		}
	}
}

// TestRefusalMessagesUseTypedVocabulary proves validateToolArguments and flattenToolCall speak
// the vocabulary the model actually sees (nix_<operation> tool names, and spec/properties/
// blueprint/templateId parameter names) rather than the internal flat shape's field names.
func TestRefusalMessagesUseTypedVocabulary(t *testing.T) {
	itemID := "11111111-1111-4111-8111-111111111111"
	for _, tc := range []struct {
		raw  string
		want string
	}{
		{`{"operation":"create_structured","title":"Plan","specJson":"[]"}`, "nix_create_structured requires spec"},
		{`{"operation":"build_blueprint","specJson":""}`, "nix_build_blueprint requires blueprint"},
		{fmt.Sprintf(`{"operation":"set_properties","itemId":%q,"propertiesJson":""}`, itemID), "nix_set_properties requires properties"},
		{`{"operation":"read_template","itemId":""}`, "nix_read_template requires the exact templateId UUID"},
		{`{"operation":"apply_template","itemId":""}`, "nix_apply_template requires the exact templateId UUID"},
		{`{"operation":"read_item","itemId":""}`, "nix_read_item requires the exact itemId UUID"},
	} {
		got := validateToolArguments(json.RawMessage(tc.raw))
		if !strings.Contains(got, tc.want) {
			t.Fatalf("%s: got %q, want it to contain %q", tc.raw, got, tc.want)
		}
		if !strings.Contains(got, "nix_list_items") && strings.Contains(got, "Discover") {
			t.Fatalf("%s: discovery hint does not name a typed tool: %q", tc.raw, got)
		}
	}
	_, reason := flattenToolCall("nix_create_note", json.RawMessage(`{"title":"Safe","url":"https://example.com"}`))
	if !strings.Contains(reason, "it accepts") || !strings.Contains(reason, "title") {
		t.Fatalf("unknown-parameter reason does not list accepted parameters: %q", reason)
	}
}

// TestToolIdentityReadOnlyOperationsArePinned pins the exact operation list toolIdentity treats
// as read-only (and therefore eligible for the read-after-write staleness rule): a change here
// is a deliberate widening or narrowing of that rule, not an accident.
func TestToolIdentityReadOnlyOperationsArePinned(t *testing.T) {
	want := map[string]bool{
		"list_items": true, "search": true, "read_item": true, "read_note": true, "search_note": true,
		"read_structure": true, "read_view": true, "list_templates": true, "read_template": true,
		"read_calendar": true,
	}
	for operation := range want {
		_, readOnly := toolIdentity(fmt.Sprintf(`{"operation":%q}`, operation))
		if !readOnly {
			t.Fatalf("%q should be read-only", operation)
		}
	}
	for _, entry := range workspaceTools() {
		tool := entry.(map[string]any)
		operation := operationFromToolName(tool["name"].(string))
		if want[operation] {
			continue
		}
		_, readOnly := toolIdentity(fmt.Sprintf(`{"operation":%q}`, operation))
		if readOnly {
			t.Fatalf("%q is unexpectedly read-only; the pinned list is stale", operation)
		}
	}
}

func (p *toolPeer) SetRequestHandler(func(json.RawMessage, string, json.RawMessage) bool) {}
func (p *toolPeer) Reply(_ json.RawMessage, result any) error {
	p.replies = append(p.replies, result)
	return nil
}

func TestToolApprovalClaimAndResult(t *testing.T) {
	peer := &toolPeer{}
	a := &account{transport: peer, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	r.WorkspaceAccess = true
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	raw := json.RawMessage(`{"threadId":"provider-thread","tool":"nix_create_note","callId":"tool-1","arguments":{"title":"Plan"}}`)
	if !a.toolRequest(json.RawMessage(`71`), "item/tool/call", raw) {
		t.Fatal("valid tool request refused")
	}
	key := r.WorkspaceID + "-" + r.PetID
	if len(peer.replies) != 0 || a.snapshot(key).Tools[0].Status != "pending" {
		t.Fatal("executed without approval")
	}
	r.Operation = "tool_result"
	r.ToolID = "tool-1"
	r.ToolResult = "created"
	r.ToolSuccess = true
	if a.resolveTool(key, r) == nil {
		t.Fatal("unclaimed result accepted")
	}
	r.Operation = "tool_claim"
	if err := a.resolveTool(key, r); err != nil {
		t.Fatal(err)
	}
	if a.resolveTool(key, r) == nil {
		t.Fatal("duplicate claim accepted")
	}
	r.Operation = "tool_result"
	if err := a.resolveTool(key, r); err != nil {
		t.Fatal(err)
	}
	if err := a.resolveTool(key, r); err != nil {
		t.Fatal(err)
	}
	if len(peer.replies) != 1 || a.snapshot(key).Tools[0].Status != "completed" {
		t.Fatal("result was not delivered exactly once")
	}
	restored := &account{home: a.home, conversations: map[string]*conversation{}}
	if err := restored.load(key); err != nil {
		t.Fatal(err)
	}
	if restored.snapshot(key).Tools[0].Status != "completed" {
		t.Fatal("receipt lost after restart")
	}
}

func TestToolsRequireWorkspaceConsentAndCorrectConversation(t *testing.T) {
	a := &account{transport: &toolPeer{}, home: t.TempDir(), conversations: map[string]*conversation{"x": {ThreadID: "thread", State: "thinking"}}}
	raw := json.RawMessage(`{"threadId":"thread","tool":"nix_list_items","callId":"one","arguments":{}}`)
	if a.toolRequest(json.RawMessage(`1`), "item/tool/call", raw) {
		t.Fatal("workspace tool accepted without consent")
	}
	a.conversations["x"].WorkspaceAccess = true
	if a.toolRequest(json.RawMessage(`1`), "item/commandExecution/requestApproval", raw) {
		t.Fatal("host tool accepted")
	}
	if a.toolRequest(json.RawMessage(`1`), "item/tool/call", json.RawMessage(`{"threadId":"other","tool":"nix_list_items","callId":"one","arguments":{}}`)) {
		t.Fatal("foreign thread tool accepted")
	}
}

func TestCompletedOrInterruptedTurnCannotLeaveExecutableApproval(t *testing.T) {
	for _, status := range []string{"completed", "interrupted", "failed"} {
		t.Run(status, func(t *testing.T) {
			peer := &toolPeer{}
			a := &account{transport: peer, home: t.TempDir(), conversations: map[string]*conversation{"x": {ThreadID: "thread", State: "thinking", Tools: []ToolCall{{ID: "pending", Status: "pending", rpcID: json.RawMessage(`1`)}}}}}
			a.notify("turn/completed", json.RawMessage(fmt.Sprintf(`{"threadId":"thread","turn":{"status":%q}}`, status)))
			if err := a.resolveTool("x", Request{Operation: "tool_claim", ToolID: "pending", RequestID: "late"}); err == nil {
				t.Fatal("stale approval can still execute")
			}
			if a.snapshot("x").Tools[0].Status != "interrupted" {
				t.Fatal("ended turn still offers an approval")
			}
		})
	}
}

func TestUnfinishedToolCannotBeReexecutedAfterRestart(t *testing.T) {
	a := &account{home: t.TempDir(), conversations: map[string]*conversation{"x": {Tools: []ToolCall{{ID: "one", Status: "claimed", ClaimID: "old"}}}}}
	if err := a.saveLocked("x"); err != nil {
		t.Fatal(err)
	}
	restored := &account{home: a.home, conversations: map[string]*conversation{}}
	if err := restored.load("x"); err != nil {
		t.Fatal(err)
	}
	if restored.snapshot("x").Tools[0].Status != "interrupted" {
		t.Fatal("unfinished write can be repeated")
	}
}

// TestBodyEditArgumentsAreValidated covers lane C's two note-body edits: what they locate travels
// in query and what replaces it in markdown, a section never takes empty markdown, a passage may
// (deleting a phrase), and a passage's find text keeps the 240-character query limit.
func TestBodyEditArgumentsAreValidated(t *testing.T) {
	itemID := "11111111-1111-4111-8111-111111111111"
	for _, raw := range []string{
		fmt.Sprintf(`{"operation":"replace_section","itemId":%q,"query":"Next steps","markdown":"- Book it"}`, itemID),
		fmt.Sprintf(`{"operation":"replace_passage","itemId":%q,"query":"teh plan","markdown":"the plan"}`, itemID),
		fmt.Sprintf(`{"operation":"replace_passage","itemId":%q,"query":" (draft)","markdown":""}`, itemID),
	} {
		if got := validateToolArguments(json.RawMessage(raw)); got != "" {
			t.Fatalf("valid arguments refused: %s -> %q", raw, got)
		}
	}
	for _, tc := range []struct {
		raw  string
		want string
	}{
		{`{"operation":"replace_section","itemId":"","query":"Plan","markdown":"x"}`, "nix_replace_section requires the exact itemId UUID"},
		{`{"operation":"replace_passage","itemId":"","query":"Plan","markdown":"x"}`, "nix_replace_passage requires the exact itemId UUID"},
		{fmt.Sprintf(`{"operation":"replace_section","itemId":%q,"query":" ","markdown":"x"}`, itemID), "requires the heading"},
		{fmt.Sprintf(`{"operation":"replace_section","itemId":%q,"query":"Plan","markdown":"  "}`, itemID), "requires nonempty markdown"},
		{fmt.Sprintf(`{"operation":"replace_passage","itemId":%q,"query":"","markdown":"x"}`, itemID), "requires the exact text to find"},
		{fmt.Sprintf(`{"operation":"replace_passage","itemId":%q,"query":%q,"markdown":"x"}`, itemID, strings.Repeat("a", 241)), "limited to 240 characters"},
	} {
		if got := validateToolArguments(json.RawMessage(tc.raw)); !strings.Contains(got, tc.want) {
			t.Fatalf("%s: got %q, want it to contain %q", tc.raw, got, tc.want)
		}
	}
}

func TestBodyEditToolsFlattenOntoQueryAndMarkdown(t *testing.T) {
	itemID := "11111111-1111-4111-8111-111111111111"
	for _, tc := range []struct {
		tool string
		raw  string
		want flatToolArgs
	}{
		{"nix_replace_section", fmt.Sprintf(`{"itemId":%q,"heading":"Plan","markdown":"New"}`, itemID), flatToolArgs{Operation: "replace_section", ItemID: itemID, Query: "Plan", Markdown: "New"}},
		{"nix_replace_passage", fmt.Sprintf(`{"itemId":%q,"find":"teh","replace":"the"}`, itemID), flatToolArgs{Operation: "replace_passage", ItemID: itemID, Query: "teh", Markdown: "the"}},
	} {
		flat, reason := flattenToolCall(tc.tool, json.RawMessage(tc.raw))
		if reason != "" {
			t.Fatalf("%s refused: %q", tc.tool, reason)
		}
		var got flatToolArgs
		if err := json.Unmarshal(flat, &got); err != nil || got != tc.want {
			t.Fatalf("%s flattened to %+v, want %+v", tc.tool, got, tc.want)
		}
	}
	if _, reason := flattenToolCall("nix_replace_passage", json.RawMessage(`{"query":"teh"}`)); !strings.Contains(reason, "find") {
		t.Fatalf("a flat-shaped parameter was not refused with the typed names: %q", reason)
	}
}

// TestScalarParametersFoldIntoSpecJSON covers argSpecField: nix_read_calendar's from/to and
// nix_complete_task's completed become keys of one specJson object, a wrong scalar type is
// refused before approval, and the flat shape gains no field.
func TestScalarParametersFoldIntoSpecJSON(t *testing.T) {
	itemID := "11111111-1111-4111-8111-111111111111"
	flat, reason := flattenToolCall("nix_read_calendar", json.RawMessage(`{"from":"2026-10-05","to":"2026-10-11"}`))
	if reason != "" {
		t.Fatal(reason)
	}
	var calendar flatToolArgs
	if err := json.Unmarshal(flat, &calendar); err != nil {
		t.Fatal(err)
	}
	if calendar.Operation != "read_calendar" || !jsonEqual(calendar.SpecJSON, `{"from":"2026-10-05","to":"2026-10-11"}`) || calendar.ItemID != "" {
		t.Fatalf("calendar flattened wrongly: %+v", calendar)
	}
	flat, reason = flattenToolCall("nix_complete_task", json.RawMessage(fmt.Sprintf(`{"itemId":%q,"completed":false}`, itemID)))
	if reason != "" {
		t.Fatal(reason)
	}
	var task flatToolArgs
	if err := json.Unmarshal(flat, &task); err != nil {
		t.Fatal(err)
	}
	if task.ItemID != itemID || !jsonEqual(task.SpecJSON, `{"completed":false}`) {
		t.Fatalf("task flattened wrongly: %+v", task)
	}
	for _, bad := range []string{`{"from":1,"to":"2026-10-11"}`, `{"from":["2026-10-05"],"to":"2026-10-11"}`, `{"from":null,"to":"2026-10-11"}`} {
		if _, reason := flattenToolCall("nix_read_calendar", json.RawMessage(bad)); reason == "" {
			t.Fatalf("non-scalar or numeric argument accepted: %s", bad)
		}
	}
}

func TestReadCalendarAndCompleteTaskValidation(t *testing.T) {
	itemID := "11111111-1111-4111-8111-111111111111"
	for _, tc := range []struct {
		raw  string
		want string
	}{
		{`{"operation":"read_calendar","specJson":"{\"from\":\"2026-10-01\",\"to\":\"2026-10-31\"}"}`, ""},
		{`{"operation":"read_calendar","specJson":"{\"from\":\"2026-10-01\",\"to\":\"2026-11-01\"}"}`, "at most 31 days"},
		{`{"operation":"read_calendar","specJson":"{\"from\":\"2026-10-09\",\"to\":\"2026-10-08\"}"}`, "on or before"},
		{`{"operation":"read_calendar","specJson":"{\"from\":\"2026-02-30\",\"to\":\"2026-03-01\"}"}`, "yyyy-MM-dd"},
		{`{"operation":"read_calendar","specJson":""}`, "yyyy-MM-dd"},
		{fmt.Sprintf(`{"operation":"complete_task","itemId":%q,"specJson":"{\"completed\":true}"}`, itemID), ""},
		{fmt.Sprintf(`{"operation":"complete_task","itemId":%q,"specJson":"{}"}`, itemID), "requires completed"},
		{fmt.Sprintf(`{"operation":"complete_task","itemId":%q,"specJson":"{\"completed\":\"yes\"}"}`, itemID), "requires completed"},
		{`{"operation":"complete_task","itemId":"","specJson":"{\"completed\":true}"}`, "requires the exact itemId UUID"},
	} {
		got := validateToolArguments(json.RawMessage(tc.raw))
		if tc.want == "" && got != "" {
			t.Fatalf("%s refused: %q", tc.raw, got)
		}
		if tc.want != "" && !strings.Contains(got, tc.want) {
			t.Fatalf("%s: got %q, want it to contain %q", tc.raw, got, tc.want)
		}
	}
	if _, readOnly := toolIdentity(`{"operation":"complete_task"}`); readOnly {
		t.Fatal("complete_task is a write and must not be read-only")
	}
}

// TestLockedReadIsHeldForTheWholeThread pins finding 1(a): a tool result read from under a lock
// marks the conversation, the mark survives the next message (the thread still holds the result)
// and a restart, and only a reset - a new thread - clears it.
func TestLockedReadIsHeldForTheWholeThread(t *testing.T) {
	peer := &toolPeer{}
	a := &account{transport: peer, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	r.WorkspaceAccess = true
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	key := r.WorkspaceID + "-" + r.PetID
	if a.snapshot(key).LockedRead {
		t.Fatal("a new conversation starts marked")
	}
	raw := json.RawMessage(`{"threadId":"provider-thread","tool":"nix_read_note","callId":"read-1","arguments":{"itemId":"11111111-1111-4111-8111-111111111111"}}`)
	if !a.toolRequest(json.RawMessage(`72`), "item/tool/call", raw) {
		t.Fatal("valid read refused")
	}
	claim := r
	claim.Operation = "tool_claim"
	claim.ToolID = "read-1"
	if err := a.resolveTool(key, claim); err != nil {
		t.Fatal(err)
	}
	result := claim
	result.Operation = "tool_result"
	result.ToolResult = "the diary"
	result.ToolSuccess = true
	result.ToolLockedContent = true
	if err := a.resolveTool(key, result); err != nil {
		t.Fatal(err)
	}
	if !a.snapshot(key).LockedRead {
		t.Fatal("a locked read did not mark the conversation")
	}
	a.notify("turn/completed", json.RawMessage(`{"threadId":"provider-thread","turn":{"status":"completed"}}`))

	// The next message resumes the same thread, so the mark stays.
	next := request()
	next.RequestID = "66666666-6666-4666-8666-666666666666"
	next.Text = "Copy it into the shared note"
	if _, err := a.handle(context.Background(), next); err != nil {
		t.Fatal(err)
	}
	if !a.snapshot(key).LockedRead {
		t.Fatal("the mark was lost on the next message")
	}
	restored := &account{home: a.home, conversations: map[string]*conversation{}}
	if err := restored.load(key); err != nil {
		t.Fatal(err)
	}
	if !restored.snapshot(key).LockedRead {
		t.Fatal("the mark was lost across a restart")
	}

	a.notify("turn/completed", json.RawMessage(`{"threadId":"provider-thread","turn":{"status":"completed"}}`))
	reset := request()
	reset.Operation = "reset"
	if _, err := a.handle(context.Background(), reset); err != nil {
		t.Fatal(err)
	}
	if a.snapshot(key).LockedRead {
		t.Fatal("a reset did not clear the mark")
	}
}

// TestProviderThreadReplacementKeepsTheReadHold ensures internal tool updates cannot clear
// the approval hold of a visible conversation that read protected or aggregate evidence.
func TestProviderThreadReplacementKeepsTheReadHold(t *testing.T) {
	a := &account{transport: &fakeTransport{}, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	key := r.WorkspaceID + "-" + r.PetID
	a.conversations[key] = &conversation{ToolVersion: toolVersion - 1, ThreadID: "old-thread", LockedRead: true, Messages: []Message{}}
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if !a.snapshot(key).LockedRead {
		t.Fatal("a replaced provider thread cleared the visible conversation read hold")
	}
}

func TestToolResultLimitCountsUTF16Units(t *testing.T) {
	r := request()
	r.Operation = "tool_result"
	r.ToolID = "tool-1"
	r.ToolResult = strings.Repeat("é", 32000)
	if !validRequest(r) {
		t.Fatal("a 32000-unit result of accented letters was refused")
	}
	r.ToolResult = strings.Repeat("é", 32001)
	if validRequest(r) {
		t.Fatal("a result over 32000 units was accepted")
	}
}

func TestReadViewIdentityNormalizesOnlyViewQueryObjects(t *testing.T) {
	one, readOnly := toolIdentity(`{"operation":"read_view","itemId":"11111111-1111-4111-8111-111111111111","query":"{\"viewId\":\"list\",\"pageSize\":2}"}`)
	two, _ := toolIdentity(`{"operation":"read_view","itemId":"11111111-1111-4111-8111-111111111111","query":"{\"pageSize\":2,\"viewId\":\"list\"}"}`)
	if !readOnly || one != two {
		t.Fatal("equivalent view query has a different read identity")
	}
	changed, _ := toolIdentity(`{"operation":"read_view","itemId":"11111111-1111-4111-8111-111111111111","query":"{\"viewId\":\"list\",\"pageSize\":1}"}`)
	if one == changed {
		t.Fatal("changed view sample reused the same identity")
	}
	searchOne, _ := toolIdentity(`{"operation":"search","query":"{\"a\":1,\"b\":2}"}`)
	searchTwo, _ := toolIdentity(`{"operation":"search","query":"{\"b\":2,\"a\":1}"}`)
	if searchOne == searchTwo {
		t.Fatal("search text was incorrectly normalized as a view query")
	}
}

func TestReadViewAcceptsEquivalentProviderObjectEncoding(t *testing.T) {
	native := json.RawMessage(`{"itemId":"11111111-1111-4111-8111-111111111111","query":{"viewId":"list","pageSize":25}}`)
	encoded := json.RawMessage(`{"itemId":"11111111-1111-4111-8111-111111111111","query":"{\"viewId\":\"list\",\"pageSize\":25}"}`)
	want, reason := flattenToolCall("nix_read_view", native)
	if reason != "" {
		t.Fatal(reason)
	}
	got, reason := flattenToolCall("nix_read_view", encoded)
	if reason != "" || !jsonEqual(string(want), string(got)) {
		t.Fatalf("encoded query = %s, %s; want %s", got, reason, want)
	}
	if reason := validateToolArguments(got); reason != "" {
		t.Fatal(reason)
	}
	for _, query := range []string{"[]", "null", "42", `{"viewId":"list"} trailing`, `{"viewId":"list"} {}`} {
		arguments, _ := json.Marshal(map[string]any{"itemId": "11111111-1111-4111-8111-111111111111", "query": query})
		if _, reason := flattenToolCall("nix_read_view", arguments); reason == "" {
			t.Fatalf("accepted invalid query %q", query)
		}
	}
}

func TestEncodedProviderObjectsStillRespectDepthAndSizeLimits(t *testing.T) {
	for _, spec := range []string{
		strings.Repeat(`{"nested":`, 30) + `{}` + strings.Repeat(`}`, 30),
		`{"text":"` + strings.Repeat("x", 25000) + `"}`,
	} {
		arguments, _ := json.Marshal(map[string]any{"itemId": "11111111-1111-4111-8111-111111111111", "spec": spec})
		flat, reason := flattenToolCall("nix_add_view", arguments)
		if reason == "" && validateToolArguments(flat) == "" {
			t.Fatal("accepted encoded spec beyond the same native limits")
		}
	}
}

func TestRememberIsRefusedOnceTheConversationHasReadProtectedContent(t *testing.T) {
	for _, locked := range []bool{false, true} {
		peer := &toolPeer{}
		c := &conversation{ThreadID: "thread", State: "thinking", WorkspaceAccess: true, LockedRead: locked}
		a := &account{transport: peer, home: t.TempDir(), conversations: map[string]*conversation{"x": c}}
		raw := json.RawMessage(`{"threadId":"thread","tool":"nix_remember","callId":"one","arguments":{"fact":"Prefers metric units."}}`)
		if !a.toolRequest(json.RawMessage(`1`), "item/tool/call", raw) {
			t.Fatal("tool call not handled")
		}
		refused := len(peer.replies) == 1 && strings.Contains(fmt.Sprint(peer.replies[0]), "read protected content")
		if refused != locked {
			t.Fatalf("locked=%v: refused=%v, replies %v, tools %d", locked, refused, peer.replies, len(c.Tools))
		}
		if !locked && len(c.Tools) != 1 {
			t.Fatalf("an unlocked remember should wait for the browser to run it: %d tools", len(c.Tools))
		}
	}
}
