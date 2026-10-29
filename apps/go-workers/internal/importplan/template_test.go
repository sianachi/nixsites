package importplan

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

const (
	templateRoot      = "11111111-1111-4111-8111-111111111111"
	templateChild     = "22222222-2222-4222-8222-222222222222"
	templateWorkspace = "33333333-3333-4333-8333-333333333333"
)

func TestTemplatePlanPreservesProfileTreeSequencesAndArchiveBodies(t *testing.T) {
	source := templateArchiveSource(t, templateProfileFixture(true, true), true, true, nil, nil)

	plan, err := ParseTemplate(context.Background(), source, testLimits())

	if err != nil {
		t.Fatal(err)
	}
	if plan.Version != 1 || plan.SourceSHA256 != source.SHA256 || plan.RootItemType != "note" || plan.ItemCount != 2 || plan.BodyCount != 2 || plan.ViewCount != 1 {
		t.Fatalf("plan metadata = %#v", plan)
	}
	if plan.Profile.Key != "team.project" || !plan.Profile.IncludeBody || !plan.Profile.IncludeChildren {
		t.Fatalf("profile = %#v", plan.Profile)
	}
	if len(plan.Items) != 2 || plan.Items[0].Sequence != "-9223372036854775808" || plan.Items[1].Sequence != "9223372036854775807" {
		t.Fatalf("sequences = %#v", plan.Items)
	}
	if plan.Items[1].ParentSourceID == nil || *plan.Items[1].ParentSourceID != templateRoot {
		t.Fatalf("child parent = %#v", plan.Items[1].ParentSourceID)
	}
	if !strings.Contains(string(plan.Items[0].Schema), `"inherit":false`) || !strings.Contains(string(plan.Items[0].Body), `"prosemirror"`) || !strings.Contains(string(plan.Items[1].Body), `"canvas"`) {
		t.Fatalf("normalized items = %#v", plan.Items)
	}

	first, digest, err := EncodeTemplate(plan, testLimits().MaxPlanBytes)
	if err != nil {
		t.Fatal(err)
	}
	second, secondDigest, err := EncodeTemplate(plan, testLimits().MaxPlanBytes)
	if err != nil || string(first) != string(second) || digest != secondDigest {
		t.Fatalf("deterministic encoding failed: %v", err)
	}
	decoded, err := DecodeTemplate(first, digest, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Items[1].Sequence != plan.Items[1].Sequence || string(decoded.Items[1].Body) != string(plan.Items[1].Body) {
		t.Fatalf("decoded plan = %#v", decoded)
	}
}

func TestTemplateArchiveIgnoresExportedComments(t *testing.T) {
	comments := []any{map[string]any{"id": "t1", "quote": nil, "resolved": false, "comments": []any{
		map[string]any{"author": "Ada", "body": "hi", "createdAt": "2026-09-01T12:00:00Z"},
	}}}
	source := templateArchiveSource(t, templateProfileFixture(true, true), true, true, nil, nil, map[string]any{"comments": comments})

	plan, err := ParseTemplate(context.Background(), source, testLimits())

	if err != nil {
		t.Fatal(err)
	}
	encoded, _, err := EncodeTemplate(plan, testLimits().MaxPlanBytes)
	if err != nil || strings.Contains(string(encoded), "Ada") {
		t.Fatalf("template plan carried comments: %v", err)
	}
}

func TestTemplateProfileRequiresSupportedBoundedMetadata(t *testing.T) {
	tests := []struct {
		name    string
		profile any
	}{
		{name: "missing", profile: nil},
		{name: "wrong kind", profile: map[string]any{"kind": "workspace", "version": 1, "key": "team.project", "name": "Project", "description": "", "includeBody": true, "includeChildren": false}},
		{name: "wrong version", profile: map[string]any{"kind": "template", "version": 2, "key": "team.project", "name": "Project", "description": "", "includeBody": true, "includeChildren": false}},
		{name: "uppercase key", profile: map[string]any{"kind": "template", "version": 1, "key": "Team.Project", "name": "Project", "description": "", "includeBody": true, "includeChildren": false}},
		{name: "long key", profile: map[string]any{"kind": "template", "version": 1, "key": "a" + strings.Repeat("b", 160), "name": "Project", "description": "", "includeBody": true, "includeChildren": false}},
		{name: "blank name", profile: map[string]any{"kind": "template", "version": 1, "key": "team.project", "name": "   ", "description": "", "includeBody": true, "includeChildren": false}},
		{name: "long name", profile: map[string]any{"kind": "template", "version": 1, "key": "team.project", "name": strings.Repeat("n", 201), "description": "", "includeBody": true, "includeChildren": false}},
		{name: "long description", profile: map[string]any{"kind": "template", "version": 1, "key": "team.project", "name": "Project", "description": strings.Repeat("d", 1001), "includeBody": true, "includeChildren": false}},
		{name: "missing description", profile: map[string]any{"kind": "template", "version": 1, "key": "team.project", "name": "Project", "includeBody": true, "includeChildren": false}},
		{name: "missing body selection", profile: map[string]any{"kind": "template", "version": 1, "key": "team.project", "name": "Project", "description": "", "includeChildren": false}},
		{name: "missing child selection", profile: map[string]any{"kind": "template", "version": 1, "key": "team.project", "name": "Project", "description": "", "includeBody": true}},
		{name: "unknown member", profile: map[string]any{"kind": "template", "version": 1, "key": "team.project", "name": "Project", "description": "", "includeBody": true, "includeChildren": false, "unexpected": true}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			source := templateArchiveSource(t, test.profile, false, true, nil, nil)
			if _, err := ParseTemplate(context.Background(), source, testLimits()); err == nil {
				t.Fatal("expected invalid template profile to be rejected")
			}
		})
	}
}

func TestTemplateArchiveRequiresCompleteProfileSelections(t *testing.T) {
	tests := []struct {
		name            string
		profile         map[string]any
		includeChild    bool
		includeRootBody bool
		omitted         []any
		loss            []any
	}{
		{name: "children excluded but present", profile: templateProfileFixture(true, false), includeChild: true, includeRootBody: true},
		{name: "root body excluded but present", profile: templateProfileFixture(false, false), includeRootBody: true},
		{name: "omission present", profile: templateProfileFixture(true, false), includeRootBody: true, omitted: []any{map[string]any{"id": nil, "parentId": templateRoot, "reason": "limit-reached", "detail": "truncated"}}},
		{name: "loss present", profile: templateProfileFixture(true, false), includeRootBody: true, loss: []any{map[string]any{"itemId": templateRoot, "kind": "body", "detail": "changed"}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			source := templateArchiveSource(t, test.profile, test.includeChild, test.includeRootBody, test.omitted, test.loss)
			if _, err := ParseTemplate(context.Background(), source, testLimits()); err == nil {
				t.Fatal("expected inconsistent template archive to be rejected")
			}
		})
	}
}

func TestTemplateProfileMaySelectAnUninitializedRootBody(t *testing.T) {
	source := templateArchiveSource(t, templateProfileFixture(true, false), false, false, nil, nil)

	plan, err := ParseTemplate(context.Background(), source, testLimits())

	if err != nil {
		t.Fatal(err)
	}
	if plan.BodyCount != 0 || !plan.Profile.IncludeBody {
		t.Fatalf("plan = %#v", plan)
	}
}

func TestTemplateParsingHonorsCancellationAndPlanChecksum(t *testing.T) {
	source := templateArchiveSource(t, templateProfileFixture(true, false), false, true, nil, nil)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ParseTemplate(cancelled, source, testLimits()); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled parse error = %v", err)
	}
	plan, err := ParseTemplate(context.Background(), source, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	body, digest, err := EncodeTemplate(plan, testLimits().MaxPlanBytes)
	if err != nil {
		t.Fatal(err)
	}
	body[len(body)-2] ^= 1
	if _, err := DecodeTemplate(body, digest, testLimits()); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("tampered plan error = %v", err)
	}
}

func TestTemplatePlanRejectsDeeplyNestedJSON(t *testing.T) {
	source := templateArchiveSource(t, templateProfileFixture(true, false), false, true, nil, nil)
	plan, err := ParseTemplate(context.Background(), source, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	plan.Items[0].Body = json.RawMessage(strings.Repeat(`{"nested":`, testLimits().MaxDepth+1) + `null` + strings.Repeat(`}`, testLimits().MaxDepth+1))
	body, digest, err := EncodeTemplate(plan, testLimits().MaxPlanBytes)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := DecodeTemplate(body, digest, testLimits()); err == nil || !strings.Contains(err.Error(), "depth") {
		t.Fatalf("deep plan error = %v", err)
	}
}

func templateProfileFixture(includeBody, includeChildren bool) map[string]any {
	return map[string]any{
		"kind": "template", "version": 1, "key": "team.project", "name": "Project",
		"description": "Reusable project", "includeBody": includeBody, "includeChildren": includeChildren,
	}
}

func templateArchiveSource(t *testing.T, profile any, includeChild, includeRootBody bool, omitted, loss []any, rootExtra ...map[string]any) Source {
	t.Helper()
	if omitted == nil {
		omitted = []any{}
	}
	if loss == nil {
		loss = []any{}
	}
	items := []any{map[string]any{
		"id": templateRoot, "parentId": nil, "seq": "-9223372036854775808", "title": "Project", "type": "note",
	}}
	if includeChild {
		items = append(items, map[string]any{
			"id": templateChild, "parentId": templateRoot, "seq": "9223372036854775807", "title": "Sketch", "type": "canvas",
		})
	}
	manifest := map[string]any{
		"format": "nix-archive", "formatVersion": 1, "schemaVersion": 3, "profile": profile,
		"exportedAt": "2026-09-01T12:00:00Z", "root": templateRoot,
		"rootEffectiveSchema": map[string]any{"properties": []any{}, "declared": []any{}, "inherit": true},
		"includesDeleted":     false, "items": items, "omitted": omitted, "loss": loss,
	}
	rootBody := any(nil)
	if includeRootBody {
		rootBody = map[string]any{"schemaVersion": 3, "prosemirror": map[string]any{"type": "doc", "content": []any{}}}
	}
	rootViews := map[string]any{
		"default": "view", "views": []any{map[string]any{
			"id": "view", "name": "List", "kind": "list", "columns": []any{}, "groupBy": nil,
			"groupOrder": []any{}, "dateProperty": nil, "sortBy": nil, "sortDescending": false,
			"mode": nil, "coverProperty": nil, "endDateProperty": nil, "cardSize": nil,
		}},
	}
	bundle := func(id string, parent *string, sequence, title, itemType string, body any, views any) map[string]any {
		return map[string]any{
			"id": id, "parentId": parent, "workspaceId": templateWorkspace, "type": itemType,
			"title": title, "seq": sequence, "lifecycleState": "active",
			"createdAt": "2026-09-01T12:00:00Z", "updatedAt": "2026-09-01T12:00:00Z",
			"properties": map[string]any{"status": "open"}, "schema": nil, "views": views,
			"viewRows": []any{}, "viewRowsTruncated": false, "body": body,
		}
	}
	manifestBody, _ := json.Marshal(manifest)
	rootFields := bundle(templateRoot, nil, "-9223372036854775808", "Project", "note", rootBody, rootViews)
	for _, extra := range rootExtra {
		for key, value := range extra {
			rootFields[key] = value
		}
	}
	rootBundle, _ := json.Marshal(rootFields)
	entries := []zipFixture{{"manifest.json", manifestBody}, {"items/" + templateRoot + ".json", rootBundle}}
	if includeChild {
		parent := templateRoot
		childBody := map[string]any{"schemaVersion": 1, "canvas": map[string]any{"version": 1, "elements": []any{}}}
		childBundle, _ := json.Marshal(bundle(templateChild, &parent, "9223372036854775807", "Sketch", "canvas", childBody, nil))
		entries = append(entries, zipFixture{"items/" + templateChild + ".json", childBundle})
	}
	return zipSource(t, "project.nix", "nix", entries)
}
