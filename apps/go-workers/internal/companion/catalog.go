package companion

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

//go:embed catalog/chat.txt
var chatCatalog string

// openUICatalog teaches interactive replies: when to answer with an openui-lang component rather
// than text or new items, and the component library the web renders them with. Generated from
// that library by apps/web's openui-prompt.test.ts (`vitest -u`), never hand-edited.
//
//go:embed catalog/openui.txt
var openUICatalog string

// toolsChatJSON is @nix/structure-spec's buildPetTools(), written by `pnpm --filter
// @nix/structure-spec catalog` (scripts/build-catalog.ts) from the same Zod schemas
// @nix/companion/run.ts parses with. One typed function tool per operation, each already reduced
// to the JSON Schema keys Codex 0.153.4 keeps and, and
// at or under its 4800-byte normalized budget - see catalog_test.go's
// TestEmbeddedToolSchemasFitTheCodexBudget, which re-measures with the same key filter in Go
// rather than trusting the TS side alone.
//
//go:embed catalog/tools-chat.json
var toolsChatJSON []byte

// petTool is one entry of the embedded tools-chat.json: a typed nix_<operation> function tool,
// exactly as `dynamicTools` in `thread/start` needs it (see manager.go's send).
type petTool struct {
	Type        string         `json:"type"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

var (
	toolsChat     []petTool
	toolNamesChat map[string]struct{}
)

func init() {
	if err := json.Unmarshal(toolsChatJSON, &toolsChat); err != nil {
		panic(fmt.Sprintf("catalog/tools-chat.json is invalid: %v", err))
	}
	toolNamesChat = make(map[string]struct{}, len(toolsChat))
	for _, tool := range toolsChat {
		toolNamesChat[tool.Name] = struct{}{}
	}
}

// workspaceTools returns the typed per-operation tools as the `[]any` of
// `{"type":"function","name",...}` maps `dynamicTools` expects. Parsed once at init from the
// generated catalog rather than built in Go, so this and @nix/structure-spec's buildPetTools can
// never drift: a schema change on one side without regenerating the other fails
// changed-path-checks.sh's catalog diff, not this function. tools.go's hand-written toolArgSpecs
// is a separate table that is not generated from this catalog and can drift from it on its own;
// TestToolArgSpecsMatchGeneratedSchemas (tools_test.go) checks the two against each other.
func workspaceTools() []any {
	result := make([]any, len(toolsChat))
	for i, tool := range toolsChat {
		result[i] = map[string]any{
			"type":        "function",
			"name":        tool.Name,
			"description": tool.Description,
			"inputSchema": tool.InputSchema,
		}
	}
	return result
}

// operationFromToolName strips the "nix_" prefix a typed tool name always carries. Callers
// already know the name is in toolNamesChat, so the prefix is always present.
func operationFromToolName(tool string) string {
	return strings.TrimPrefix(tool, "nix_")
}

// structureOperations reads the "Section: Structure operations" line straight out of the
// embedded catalog, instead of a second hand-typed list, so the capability sentence
// (capabilityRules) can never fall out of step with the catalog and workspaceTools() the way it
// did when B.4 added add_fields, edit_form and set_recurrence without updating the base
// instructions sentence.
func structureOperations() []string {
	const marker = "Section: Structure operations\n"
	start := strings.Index(chatCatalog, marker)
	if start == -1 {
		return nil
	}
	rest := chatCatalog[start+len(marker):]
	line := rest
	if end := strings.IndexByte(rest, '\n'); end != -1 {
		line = rest[:end]
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return nil
	}
	parts := strings.Split(line, ", ")
	operations := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			operations = append(operations, trimmed)
		}
	}
	return operations
}
