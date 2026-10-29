package companion

import (
	"encoding/json"
	"strings"
	"testing"
)

// structureOperations names the nix_<operation> tools that build or extend structure from a
// spec, as opposed to the plain item operations (create_note, set_properties, ...) and the
// template operations (list_templates, read_template, apply_template). It mirrors
// packages/structure-spec/src/catalog/tables.ts's STRUCTURE_OPERATIONS.
// TestCatalogNamesEveryStructureOperation checks each of these names against workspaceTools()'s
// own tool names and against the embedded catalog text; it does not discover structure
// operations the catalog knows about but this list has fallen out of step with - a structure
// operation added to workspaceTools() and forgotten here would not fail this test. Nothing in the
// schema marks an operation as "structure-shaped", so there is no enum to derive the other
// direction from without inventing one.
var structureOperationsFixture = []string{"create_structured", "add_view", "create_entries", "add_fields", "edit_fields", "edit_form", "update_view", "set_recurrence", "build_blueprint"}

func TestCatalogIsEmbeddedAndBounded(t *testing.T) {
	if chatCatalog == "" {
		t.Fatal("chatCatalog is empty")
	}
	if len(chatCatalog) > 13000 {
		t.Fatalf("chatCatalog is %d chars, want <= 13000", len(chatCatalog))
	}
}

func TestCatalogNamesEveryStructureOperation(t *testing.T) {
	for _, operation := range structureOperationsFixture {
		if _, ok := toolNamesChat["nix_"+operation]; !ok {
			t.Fatalf("%q is not in workspaceTools()'s tool names; the fixture list is stale", operation)
		}
		if !strings.Contains(chatCatalog, operation) {
			t.Errorf("catalog does not name structure operation %q", operation)
		}
	}
}

// TestWorkspaceToolsOffersOneToolPerOperation pins the tool-name shape every other test in this
// package assumes: every WORKSPACE_OPERATIONS tool (packages/structure-spec/src/catalog/tables.ts)
// is offered once, the design tools among them, and neither the old single nix_workspace tool nor
// the retired nix_validate_blueprint is.
func TestWorkspaceToolsOffersOneToolPerOperation(t *testing.T) {
	if len(toolNamesChat) != 30 || len(workspaceTools()) != 30 {
		t.Fatalf("offers %d tools, want 30", len(toolNamesChat))
	}
	for _, name := range []string{"nix_workspace", "workspace", "nix_validate_blueprint"} {
		if _, ok := toolNamesChat[name]; ok {
			t.Fatalf("still offers the retired %q tool", name)
		}
	}
	for _, name := range []string{"nix_build_blueprint", "nix_save_as_template"} {
		if _, ok := toolNamesChat[name]; !ok {
			t.Fatalf("is missing the design tool %s", name)
		}
	}
	for _, tool := range toolsChat {
		for _, retired := range []string{"Design mode", "nix_validate_blueprint"} {
			if strings.Contains(tool.Description, retired) {
				t.Errorf("%s description still mentions %q", tool.Name, retired)
			}
		}
	}
}

// TestEmbeddedToolSchemasFitTheCodexBudget re-measures every embedded tool's inputSchema against
// Codex 0.153.4's own normalized-key set (docs/plans/pet-speed-accuracy-plan.md, "Codex 0.153.4
// facts"), independently of packages/structure-spec/src/catalog/tools.ts's own budget test, so a
// schema that grew past 4800 bytes on the way through JSON, embed and re-parse fails here too.
func TestEmbeddedToolSchemasFitTheCodexBudget(t *testing.T) {
	for _, tool := range workspaceTools() {
		entry, ok := tool.(map[string]any)
		if !ok {
			t.Fatalf("tool is %T, want map[string]any", tool)
		}
		name, _ := entry["name"].(string)
		normalized := normalizeForCodexTest(entry["inputSchema"])
		encoded, err := json.Marshal(normalized)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(encoded) > 4800 {
			t.Errorf("%s inputSchema is %d normalized bytes, want <= 4800", name, len(encoded))
		}
	}
}

// codexSchemaKeys are the JSON Schema keys Codex 0.153.4's dynamic-tool sanitizer keeps (see
// packages/structure-spec/src/catalog/tools.ts's normalizeForCodex, which this mirrors in Go so
// the budget is checked independently on both sides of the embed).
var codexSchemaKeys = map[string]bool{
	"$ref": true, "type": true, "description": true, "enum": true, "items": true,
	"minItems": true, "properties": true, "required": true, "additionalProperties": true,
	"anyOf": true, "oneOf": true, "allOf": true,
}

func normalizeForCodexTest(schema any) any {
	switch value := schema.(type) {
	case bool:
		if value {
			return map[string]any{"type": "string"}
		}
		return map[string]any{}
	case map[string]any:
		result := map[string]any{}
		if constValue, ok := value["const"]; ok {
			if _, hasEnum := value["enum"]; !hasEnum {
				result["enum"] = []any{constValue}
			}
		}
		for key, raw := range value {
			if key == "const" || !codexSchemaKeys[key] {
				continue
			}
			switch key {
			case "items", "additionalProperties":
				if b, ok := raw.(bool); ok {
					result[key] = b
				} else {
					result[key] = normalizeForCodexTest(raw)
				}
			case "properties":
				properties, _ := raw.(map[string]any)
				normalizedProperties := map[string]any{}
				for propertyName, propertySchema := range properties {
					normalizedProperties[propertyName] = normalizeForCodexTest(propertySchema)
				}
				result[key] = normalizedProperties
			case "anyOf", "oneOf", "allOf":
				branches, _ := raw.([]any)
				normalizedBranches := make([]any, len(branches))
				for i, branch := range branches {
					normalizedBranches[i] = normalizeForCodexTest(branch)
				}
				result[key] = normalizedBranches
			default:
				result[key] = raw
			}
		}
		if defs, ok := value["$defs"].(map[string]any); ok {
			normalizedDefs := map[string]any{}
			for name, def := range defs {
				normalizedDefs[name] = normalizeForCodexTest(def)
			}
			result["$defs"] = normalizedDefs
		}
		return result
	default:
		return map[string]any{}
	}
}

func TestPropertyFormulaGuidanceIsPresentWithoutWorkspaceTools(t *testing.T) {
	for _, phrase := range []string{
		"case-sensitive property keys as [key]",
		"without a leading =",
		"never labels, prop() or PROPERTY()",
		"TODAY and NOW are unsupported",
		`IF([completion], "Done", "Open")`,
	} {
		if !strings.Contains(instructions(), phrase) {
			t.Errorf("instructions omit formula guidance %q", phrase)
		}
	}
}
